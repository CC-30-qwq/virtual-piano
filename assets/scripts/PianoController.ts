import { _decorator, Component, Node, Label, UITransform, Vec3, Color, Canvas, sys } from 'cc';
import { KeyboardView } from './keyboard/KeyboardView';
import { TouchRouter, PianoInputListener } from './keyboard/TouchRouter';
import { EventBatcher } from './audio/EventBatcher';
import { PianoEngine } from './audio/PianoEngine';
import { EventSource } from './audio/PianoTypes';

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

    /**
     * 播放 440Hz 测试音。
     *
     * ⚠️ 临时开关。采样器内核（M1）接入前，按键是没声音的 ——
     * 打开它用来确认音频设备层与 JSB 链路真的通到了扬声器。
     * 接入采样器后连同 C++ 侧的正弦一起删除。
     */
    @property({ tooltip: '播放 440Hz 测试音（采样器接入前用于验证音频链路）' })
    testTone = false;

    private _view!: KeyboardView;
    private _router!: TouchRouter;
    private readonly _batcher = new EventBatcher();
    private readonly _engine = PianoEngine.instance;

    /** 音源是否已载入。未载入时按键不会有声音 —— 读数据要能看出这一点 */
    private _bankReady = false;
    private _hudLabel: Label | null = null;
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
            this.buildHud();
        }

        // 原生不可用时 create/start 返回 false，这里不视为错误 ——
        // 编辑器预览本来就没有音频，UI 仍应可以正常调试。
        this._engine.create();
        this._engine.start();

        if (this.testTone) {
            this._engine.setTestTone(true);
        }

        // 音源载入是同步阻塞的（中端机几秒）。推迟到首帧渲染之后 ——
        // 直接写在 onLoad 里会卡住场景首帧，Android 上还可能被判定为 ANR。
        this.scheduleOnce(() => { this.loadBank(); }, 0.1);
    }

    /**
     * 载入音源包。完成之前按键不会出声，这是预期行为 ——
     * 调试读数上的「音源」一栏会显示当前状态。
     */
    private loadBank(): void {
        if (!sys.isNative) {
            // 编辑器预览：音源已内嵌在脚本包里（PreviewBankData.ts），
            // 不走原生音源包。这里直接返回，免得在读数上误报「音源未载入」。
            return;
        }

        this._bankReady = this._engine.loadBank();
        if (this._bankReady) {
            const mb = (this._engine.getResidentBytes() / 1024 / 1024).toFixed(0);
            console.log(`[piano] 音源已载入，常驻 ${mb} MB`);
        } else {
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

        if (this._hudLabel) {
            this._refreshHud();
        }
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

    /** 沿父链向上找挂 Canvas 组件的节点 */
    private findCanvasNode(): Node | null {
        let node: Node | null = this.node;
        while (node) {
            if (node.getComponent(Canvas)) {
                return node;
            }
            node = node.parent;
        }
        return null;
    }

    private buildHud(): void {
        // 挂在 Canvas 上而不是 this.node.parent —— 后者是键盘容器（只有 180 高），
        // 读数会被限制在那一条里，而且键盘滚动时还会跟着动。
        const canvas = this.findCanvasNode();
        if (!canvas) {
            return;
        }

        const node = new Node('DebugHud');

        // 同 KeyboardView.makeLayer：运行时创建的节点默认在 DEFAULT 层，
        // UI 相机看不到那一层。不设这一步读数就是不显示。
        node.layer = canvas.layer;

        const transform = node.addComponent(UITransform);
        transform.setAnchorPoint(0, 1);

        const label = node.addComponent(Label);
        label.useSystemFont = true;
        label.fontSize = 22;
        label.lineHeight = 30;
        label.horizontalAlign = Label.HorizontalAlign.LEFT;
        label.verticalAlign = Label.VerticalAlign.TOP;
        label.color = new Color(220, 230, 240, 220);

        canvas.addChild(node);

        // 贴在画布左上角
        const canvasTransform = canvas.getComponent(UITransform);
        const left = canvasTransform ? -canvasTransform.width * 0.5 : -640;
        const top = canvasTransform ? canvasTransform.height * 0.5 : 360;
        node.setPosition(new Vec3(left + 20, top - 16, 0));

        this._hudLabel = label;
    }

    private _refreshHud(): void {
        const engine = this._engine;
        const lines = [
            `状态  ${engine.statusText}`,
            `音符  ${this._lastNoteText}    力度 ${(this._lastVelocity * 127).toFixed(0)}/127`,
            // 「事件」是收到的触摸总数（不论是否命中），「按住」是命中的键数。
            // 事件不涨 = 事件没送达；事件涨而按住恒 0 = 命中测试落空。
            `事件  ${this._router.eventsSeen}    按住 ${this._heldNotes.size}    命中 ${this._router.activeTouchCount}`,
            `已提交 ${this._batcher.submittedTotal}    待提交 ${this._batcher.pending}    丢弃 ${this._batcher.droppedTotal}`,
        ];

        // 原生可用时补一行内核侧的真实数据 —— 与上面的 TS 侧统计对照，
        // 「已提交」对不上就说明事件没走到原生层。
        if (engine.available) {
            const xrun = engine.getXrunCount();
            lines.push(
                `内核  收到 ${engine.getAcceptedEvents()}    发声 ${engine.getActiveVoices()}    欠载 ${xrun}` +
                (xrun > 0 ? ' ⚠' : ''),
            );
            // 音源没载入时按键必然无声。把状态显示出来，免得把「没载入」
            // 误判成「触摸没响应」。
            const mb = engine.getResidentBytes() / 1024 / 1024;
            lines.push(this._bankReady
                ? `音源  已载入 ${mb.toFixed(0)} MB`
                : '音源  ⚠ 未载入（按键无声）');
        } else {
            // 编辑器预览走浏览器后端，没有原生那套诊断量。
            // 音源状态已经在第一行的 statusText 里了。
            lines.push(`预览  ${engine.previewVoices} 个发声`);
        }

        this._hudLabel!.string = lines.join('\n');
    }
}
