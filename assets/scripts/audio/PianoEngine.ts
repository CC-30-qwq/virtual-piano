import { sys } from 'cc';

import { EVENT_STRIDE, EventType } from './PianoTypes';
import { WebAudioEngine } from './WebAudioEngine';

/**
 * 钢琴音频内核 —— TS 侧门面
 *
 * 对应《横屏高仿真钢琴落地实施方案》§3.2。
 *
 * ## 与原生层的边界
 *
 * 原生层（C++）在 JSB 环境中注册一个全局对象 `jsbPiano`。**它只在原生平台存在** ——
 * 在编辑器预览、浏览器里都没有。因此本类必须做到：
 *   - 原生不可用时**不抛异常**，降级为静默 no-op，让 UI 与交互仍能正常调试；
 *   - 通过 `available` 暴露当前状态，便于界面提示与诊断。
 *
 * 这条很重要：如果门面在缺原生层时直接崩，整个键盘在编辑器里就没法调了。
 */

/** 与 C++ 侧 PianoEngine 一一对应。改动必须两边同步。 */
export interface IJsbPiano {
    // 生命周期
    create(sampleRate: number, framesPerCallback: number): boolean;
    destroy(): void;
    start(): boolean;
    stop(): void;

    // 音源包
    /**
     * 载入音源包。**同步阻塞**，要读完并解码几百 MB（中端机几秒）。
     *
     * @param layerMask 常驻力度层掩码，位 0..15 对应层 1..16。传 -1 表示全 16 层。
     * @returns 1 成功 / 0 失败
     */
    loadBank(layerMask: number): number;
    getResidentBytes(): number;

    /**
     * 批量提交演奏事件。
     *
     * `buffer` 是 PianoEvent 数组的裸内存（见 PianoTypes.EventWriter）。
     * 这是全工程唯一的每帧跨语言调用 —— **不要为每个音符单独调一次**。
     */
    submitEvents(buffer: ArrayBuffer, count: number): number;

    // 参数
    setParam(id: number, value: number): void;
    setForceCurve(points: Float32Array): void;

    // 诊断
    /** 当前发声中的 voice 数 */
    getActiveVoices(): number;
    getCpuLoad(): number;
    getXrunCount(): number;
    getStreamTimeMs(): number;
    /** 设备实际生效的回调帧数 */
    getFramesPerBurst(): number;
    /** 内核状态描述，如 "running" / "stopped" */
    getStatus(): string;
    /** 累计接受的合法事件数 */
    getAcceptedEvents(): number;
    /** 累计丢弃的非法事件数 */
    getDroppedEvents(): number;

    /**
     * 开关 440Hz 测试音。
     *
     * ⚠️ 临时手段，用于验证音频链路真的出声。采样器接入后删除。
     * 传 1/0 而不是布尔值 —— C++ 侧签名是 int32_t，避免类型转换出岔子。
     */
    setTestTone(enabled: number): void;
}

/** 原生层注入的全局对象；非原生平台为 undefined。 */
function getNative(): IJsbPiano | undefined {
    return (globalThis as unknown as { jsbPiano?: IJsbPiano }).jsbPiano;
}

export class PianoEngine {
    private static _instance: PianoEngine | null = null;

    static get instance(): PianoEngine {
        if (!PianoEngine._instance) {
            PianoEngine._instance = new PianoEngine();
        }
        return PianoEngine._instance;
    }

    private _native: IJsbPiano | undefined;
    private _created = false;
    private _running = false;

    /**
     * 浏览器预览后端。
     *
     * 非原生平台（编辑器预览、浏览器）没有 `jsbPiano`，音频走这里。
     * 音源是抽取的极小样本，音色不如原生，但足以评估交互、布局与力度响应。
     */
    private readonly _web = new WebAudioEngine();

    /** 默认采样率。Android 设备普遍原生 48kHz，用它可以避免一次重采样。 */
    static readonly DEFAULT_SAMPLE_RATE = 48000;

    private constructor() {
        this._native = sys.isNative ? getNative() : undefined;

        if (sys.isNative && !this._native) {
            // 原生平台上却找不到绑定 —— 说明 JSB 注册有问题，必须让人看见
            console.error('[PianoEngine] 运行在原生平台但找不到 jsbPiano 绑定，音频将不可用');
        }
    }

    /** 音频内核当前是否可用（原生平台且绑定存在） */
    get available(): boolean {
        return !!this._native;
    }

    /**
     * 是否已启动。
     *
     * ⚠️ 这是 TS 侧的**缓存**，不是权威状态。C++ 侧在 onPause/onResume
     * 里会自行停启音频流（那才是平台生命周期的正确挂载点），缓存会因此变陈旧。
     * 要判断真实状态请用 `nativeStatus`。
     */
    get running(): boolean {
        return this._running;
    }

    /** 从原生层查真实状态；原生不可用时返回空串 */
    get nativeStatus(): string {
        return this._native?.getStatus() ?? '';
    }

    /** 供 UI 显示的状态描述 */
    get statusText(): string {
        if (sys.isNative) {
            if (!this._native) {
                return '原生绑定缺失';
            }
            const frames = this._native.getFramesPerBurst();
            return `${this._native.getStatus()} · ${frames} 帧/回调`;
        }

        // 非原生平台（编辑器预览、浏览器）：走 Web Audio 后备后端。
        // 音源是抽取出来的极小样本，音色不如原生，但足以评估交互与力度。
        if (!this._web.available) {
            return '浏览器不支持 Web Audio';
        }
        if (!this._web.ready) {
            const percent = (this._web.progress * 100).toFixed(0);
            return this._web.decodeFailed
                ? '预览音源解码失败'
                : `预览音源载入中 ${percent}%`;
        }
        return '预览音源就绪（Web Audio）';
    }

    // ---------------------------------------------------------------- 生命周期

    create(sampleRate = PianoEngine.DEFAULT_SAMPLE_RATE, framesPerCallback = 0): boolean {
        if (!this._native) {
            // 非原生平台：启用浏览器预览后端。
            // 注意 AudioContext 会停在 suspended 状态直到用户交互 ——
            // 这是浏览器的自动播放策略，靠 `resumeWebAudio()` 在首次触摸时解开。
            return this._web.init();
        }
        if (this._created) {
            return true;
        }
        this._created = this._native.create(sampleRate, framesPerCallback);
        return this._created;
    }

    start(): boolean {
        if (!this._native) {
            return this._web.available;
        }
        if (!this._created) {
            return false;
        }
        this._running = this._native.start();
        return this._running;
    }

    stop(): void {
        if (!this._native) {
            return;
        }
        if (!this._running) {
            return;
        }
        this._native.stop();
        this._running = false;
    }

    /**
     * 用户手势后调用，解开浏览器的自动播放限制。
     *
     * 必须在触摸回调里调用 —— AudioContext 在用户交互之前 resume() 是无效的。
     * 原生平台上这是个空操作。
     */
    resumeWebAudio(): void {
        this._web.resume();
    }

    destroy(): void {
        if (!this._native) {
            return;
        }
        this._native.destroy();
        this._created = false;
        this._running = false;
    }

    // ---------------------------------------------------------------- 事件提交

    /**
     * 提交一批事件。返回实际入队数。
     *
     * 原生不可用时返回 0 而不报错 —— 编辑器里调试交互时这是预期行为。
     */
    submitEvents(buffer: ArrayBuffer, count: number): number {
        if (!this._native || !this._running || count <= 0) {
            return 0;
        }
        return this._native.submitEvents(buffer, count);
    }

    /**
     * 把一批事件交给当前可用的后端。
     *
     * **原生优先，不可用时退回浏览器预览后端。** 两条路读的是**同一套 16 字节
     * 事件布局**（见 PianoTypes），所以 TS 侧的事件流不需要分叉 ——
     * 在编辑器里调好的交互，到真机上行为一致。
     */
    dispatchEvents(buffer: ArrayBuffer, count: number): number {
        if (count <= 0) {
            return 0;
        }
        if (this._native) {
            return this.submitEvents(buffer, count);
        }
        return this.dispatchToWeb(buffer, count);
    }

    private dispatchToWeb(buffer: ArrayBuffer, count: number): number {
        if (!this._web.ready) {
            return 0;   // 还没解码完，让这些事件过去
        }

        const view = new DataView(buffer);
        let handled = 0;

        for (let i = 0; i < count; ++i) {
            const offset = i * EVENT_STRIDE;
            const type = view.getUint8(offset) as EventType;
            const note = view.getUint8(offset + 1);
            const velocity = view.getUint8(offset + 2);

            switch (type) {
                case EventType.NoteOn:
                    this._web.noteOn(note, velocity / 127);
                    break;
                case EventType.NoteOff:
                    this._web.noteOff(note);
                    break;
                case EventType.PedalDown:
                    this._web.setPedal(true);
                    break;
                case EventType.PedalUp:
                    this._web.setPedal(false);
                    break;
                case EventType.PedalValue:
                    this._web.setPedal(note >= 64);
                    break;
                case EventType.AllNotesOff:
                    this._web.allNotesOff();
                    break;
                default:
                    continue;   // 其余类型预览后端不处理
            }
            ++handled;
        }
        return handled;
    }

    /** 预览后端的发声数（原生平台上恒为 0） */
    get previewVoices(): number {
        return this._web.activeVoices;
    }

    // ---------------------------------------------------------------- 参数

    /**
     * 载入音源包。
     *
     * ⚠️ **同步阻塞**。要读完并解码几百 MB，中端机需要几秒 ——
     * 不要在场景加载路径里直接调用，否则会卡住首帧（Android 上还可能被判 ANR）。
     * 用 `scheduleOnce` 之类的机制推迟到首帧渲染之后。
     *
     * @param layerMask 常驻力度层掩码，位 0..15 对应层 1..16；-1 表示全 16 层
     * @returns 是否成功
     */
    loadBank(layerMask = -1): boolean {
        if (!this._native) {
            return false;
        }
        return this._native.loadBank(layerMask) !== 0;
    }

    /** 常驻采样占用的字节数 */
    getResidentBytes(): number {
        return this._native?.getResidentBytes() ?? 0;
    }

    setParam(id: number, value: number): void {
        this._native?.setParam(id, value);
    }

    setForceCurve(points: Float32Array): void {
        this._native?.setForceCurve(points);
    }

    // ---------------------------------------------------------------- 诊断

    getActiveVoices(): number {
        return this._native?.getActiveVoices() ?? 0;
    }

    getCpuLoad(): number {
        return this._native?.getCpuLoad() ?? 0;
    }

    getXrunCount(): number {
        return this._native?.getXrunCount() ?? 0;
    }

    /** 设备实际生效的回调帧数。48kHz 下 192 帧 = 4ms */
    getFramesPerBurst(): number {
        return this._native?.getFramesPerBurst() ?? 0;
    }

    getAcceptedEvents(): number {
        return this._native?.getAcceptedEvents() ?? 0;
    }

    getDroppedEvents(): number {
        return this._native?.getDroppedEvents() ?? 0;
    }

    /**
     * 开关 440Hz 测试音。
     *
     * ⚠️ 临时手段 —— 采样器内核（M1）还没接入，按键盘是没声音的。
     * 用它确认「音频设备层 + JSB 链路」是否真的通到了扬声器。
     * 接入采样器后连同 C++ 侧的正弦一起删除。
     */
    setTestTone(enabled: boolean): void {
        this._native?.setTestTone(enabled ? 1 : 0);
    }

    /**
     * 音频时钟（毫秒）。
     *
     * 原生不可用时回退到 `performance.now()` —— 这样依赖它的时间戳逻辑
     * 在编辑器里仍然能跑通，只是没有音频域的含义。
     */
    getStreamTimeMs(): number {
        return this._native?.getStreamTimeMs() ?? performance.now();
    }
}
