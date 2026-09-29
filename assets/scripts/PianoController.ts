import { _decorator, Component } from 'cc';
import { KeyboardView } from './keyboard/KeyboardView';
import { TouchRouter } from './keyboard/TouchRouter';
import { PianoInputListener } from './keyboard/KeyboardInput';
import { LOAD_DONE, LOAD_FAILED } from './audio/AudioBackend';
import { EventBatcher } from './audio/EventBatcher';
import { EngineAudioClock } from './audio/EngineAudioClock';
import { PianoEngine } from './audio/PianoEngine';
import { EventSource } from './audio/PianoTypes';
import { DebugHud, HudSnapshot } from './ui/DebugHud';

const { ccclass, property } = _decorator;

/** 音名，用于调试读数 */
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** MIDI → 音名（C4 = 60，即中央 C） */
export function midiToName(midi: number): string {
    return `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;
}

/**
 * 主控制器。
 *
 * 把键盘（KeyboardView）与触摸路由（TouchRouter）接到音频内核门面（PianoEngine）上，
 * 并在屏幕上显示一个调试读数。
 *
 * 挂在 **Keyboard 节点**上（与 KeyboardView / TouchRouter 同一节点）。
 *
 * ## 为什么要有这个调试读数
 *
 * 音频还没接通，按下去是没声音的 —— 没有读数就无法判断「是交互链路断了」
 * 还是「只是没声音」。它显示最近触发的音符与力度，能把触摸 → 命中测试 →
 * 力度换算 → 事件提交这条链路暴露出来。
 */
@ccclass('PianoController')
export class PianoController extends Component implements PianoInputListener {
    @property({ tooltip: '是否显示调试读数' })
    showDebugHud = true;

    private _view!: KeyboardView;
    private _router!: TouchRouter;

    // _engine 必须声明在 _batcher 之前：字段初始化按书写顺序执行，
    // _batcher 的构造要用到 _engine。
    private readonly _engine = PianoEngine.instance;
    private readonly _batcher = new EventBatcher(this._engine, new EngineAudioClock(this._engine));

    /** 音源载入是否已经报过结果。避免每帧重复打印同一条日志 */
    private _loadReported = false;
    private _hud: DebugHud | null = null;
    private _lastNoteText = '—';
    private _lastVelocity = 0;
    private readonly _heldNotes = new Set<number>();

    protected onLoad(): void {
        this._view = this.getComponent(KeyboardView)!;
        this._router = this.getComponent(TouchRouter)!;

        if (!this._view || !this._router) {
            throw new Error('PianoController 必须与 KeyboardView、TouchRouter 挂在同一个节点上');
        }

        this._router.listener = this;

        if (this.showDebugHud) {
            // 读数挂在 Canvas 上而不是本节点的父节点 —— 后者是键盘容器（只有 180 高），
            // 读数会被限制在那一条里，而且键盘滚动时还会跟着动。
            this._hud = DebugHud.attach(this.node);
        }

        // 原生不可用时 create/start 返回 false，这里不视为错误 ——
        // 编辑器预览本来就没有音频，UI 仍应可以正常调试。
        this._engine.create();
        this._engine.start();

        // 载入是异步的（解码在后台线程），这里只是发起。推迟到首帧之后发起
        // 是为了让场景先渲染出来 —— 启动瞬间那几毫秒不值得跟首帧抢。
        this.scheduleOnce(() => { this.beginLoadBank(); }, 0.1);
    }

    /**
     * 发起载入音源包。**不再阻塞** —— 解码在原生侧的后台线程上进行，
     * 进度每帧从读数上读（见 `snapshot`）。
     */
    private beginLoadBank(): void {
        if (this._engine.kind === 'web') {
            // 编辑器预览：音源已内嵌在脚本包里（PreviewBankData.ts），
            // 由 WebAudioEngine 自己后台解码，没有「发起载入」这一步。
            return;
        }

        if (!this._engine.beginLoadBank()) {
            this._loadReported = true;
            console.warn('[piano] 音源载入未能发起 —— 按键不会有声音。'
                       + '检查音源包是否打进了 assets（见 build.gradle 的 PIANO_BANK_DIR）');
        }
    }

    /**
     * 载入结束时报一次结果。
     *
     * 之所以要单独报，是因为载入从「同步返回成功/失败」改成了异步：
     * 失败不再有返回值可看，只能靠轮询进度发现问题。
     */
    private reportLoadResult(): void {
        // 预览后端的进度是「内嵌音源解码到哪了」，与音源包无关 ——
        // 用同一套文案报会指错方向（让人去查 build.gradle）
        if (this._loadReported || this._engine.kind !== 'native') {
            return;
        }
        const percent = this._engine.loadPercent;
        if (percent === LOAD_DONE) {
            this._loadReported = true;
            const mb = (this._engine.diagnostics().residentBytes / 1024 / 1024).toFixed(0);
            console.log(`[piano] 音源已载入，常驻 ${mb} MB`);
        } else if (percent === LOAD_FAILED) {
            this._loadReported = true;
            console.warn('[piano] 音源载入失败 —— 按键不会有声音。'
                       + '检查音源包是否打进了 assets（见 build.gradle 的 PIANO_BANK_DIR）');
        }
    }

    protected onDestroy(): void {
        this._engine.stop();
        if (this._router) {
            this._router.listener = null;
        }
    }

    protected update(): void {
        // 顺序有讲究：先校准时钟偏移，再提交 —— 本次提交的事件才用得上新偏移
        this._batcher.calibrate();
        this._batcher.flush();

        this.reportLoadResult();
        this._hud?.update(this.snapshot());
    }

    // ---------------------------------------------------------------- 演奏事件

    onNoteOn(midi: number, velocity: number, source: EventSource): void {
        // 浏览器要求 AudioContext 在**用户手势期间**才能启动。
        // 触摸回调是最自然的时机 —— 放到 update() 之类的非手势上下文里
        // resume() 会被浏览器忽略。原生平台上这是空操作。
        this._engine.resumeWebAudio();

        this._batcher.noteOn(midi, velocity, source);
        this._heldNotes.add(midi);
        this._lastNoteText = midiToName(midi);
        this._lastVelocity = velocity;
    }

    onNoteOff(midi: number, _source?: EventSource): void {
        this._batcher.noteOff(midi);
        this._heldNotes.delete(midi);
    }

    protected onDisable(): void {
        this._router?.releaseAll();
        this._batcher.allNotesOff();
        this._batcher.flush();
        this._heldNotes.clear();
    }

    // ---------------------------------------------------------------- 调试读数

    /**
     * 采集一屏读数所需的全部数据。
     *
     * 只**读**，不碰任何 UI —— 怎么排版、怎么措辞都是 `DebugHud` 的事。
     * 这里保留在控制器里是因为它本来就是装配点：只有控制器同时持有这四样东西。
     */
    private snapshot(): HudSnapshot {
        // 后端诊断是结构化数据，不是文案 —— 怎么排版是 DebugHud 的事
        const backend = this._engine.diagnostics();

        // 读一次就够了：原生后端每读一次都要过一趟 JSB，而这一屏里
        // 有两个字段要用它
        const loadPercent = this._engine.loadPercent;

        return {
            engine: backend.status,
            backendKind: backend.kind,
            backend,
            bankReady: loadPercent === LOAD_DONE,
            loadPercent,
            lastNote: this._lastNoteText,
            lastVelocity: this._lastVelocity,
            eventsSeen: this._router.eventsSeen,
            heldNotes: this._heldNotes.size,
            activeTouches: this._router.activeTouchCount,
            submitted: this._batcher.submittedTotal,
            pending: this._batcher.pending,
            dropped: this._batcher.droppedTotal,
            keyboard: this._view
                ? {
                    keyWidth: this._view.viewport.keyWidth,
                    manuallyZoomed: this._view.viewport.manuallyZoomed,
                }
                : null,
        };
    }
}
