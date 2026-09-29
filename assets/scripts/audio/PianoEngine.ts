import { sys } from 'cc';

import { AudioBackend, BackendDiagnostics, LOAD_DONE } from './AudioBackend';
import { getNativeJsBridge, NativeBackend } from './NativeBackend';
import { WebBackend } from './WebBackend';

/**
 * 钢琴音频引擎门面 —— TS 侧唯一入口。
 *
 * 对应《横屏高仿真钢琴落地实施方案》§3.2。
 *
 * ## 这个类只做三件事
 *
 *   1. **挑后端**（原生 / 浏览器预览），见 `pickBackend`
 *   2. **转发**调用
 *   3. 把结构化的**诊断数据**交出去（`diagnostics()`，不含任何 UI 文案）
 *
 * 具体怎么干活在后端实现里（`NativeBackend` / `WebBackend`），
 * 事件字节怎么解在 `EventCodec`。这条边界是这样划过来的：
 *   - 原先门面里出现 `DataView` 与 `switch (type)` → 事件解码有两份实现（另一份在 C++）
 *   - 原先门面直接拼 UI 文案 → 改一句措辞要动引擎
 *   - 原先每个方法里都散着 `if (!this._native)` → 后端差异渗透到整层
 */
export class PianoEngine {
    private static _instance: PianoEngine | null = null;

    static get instance(): PianoEngine {
        if (!PianoEngine._instance) {
            PianoEngine._instance = new PianoEngine();
        }
        return PianoEngine._instance;
    }

    /** 默认采样率。Android 设备普遍原生 48kHz，用它可以避免一次重采样。 */
    static readonly DEFAULT_SAMPLE_RATE = 48000;

    private readonly _backend: AudioBackend;

    private constructor() {
        this._backend = PianoEngine.pickBackend();
    }

    private static pickBackend(): AudioBackend {
        if (!sys.isNative) {
            // 编辑器预览 / 浏览器：没有 jsbPiano，音频走 Web Audio 后备后端。
            // 音源是抽取的极小样本，音色不如原生，但足以评估交互、布局与力度响应。
            return new WebBackend();
        }

        const jsb = getNativeJsBridge();
        if (!jsb) {
            // 原生平台上却找不到绑定 —— 说明 JSB 注册有问题，必须让人看见。
            // 仍返回原生后端：它会静默降级，但诊断里会写明「原生绑定缺失」。
            console.error('[PianoEngine] 运行在原生平台但找不到 jsbPiano 绑定，音频将不可用');
        }
        return new NativeBackend(jsb);
    }

    /** 当前后端类型。UI 据此决定怎么展示诊断数据 */
    get kind(): 'native' | 'web' {
        return this._backend.kind;
    }

    /** 后端当前能否接收事件（原生：绑定存在；预览：音源解码完成） */
    get available(): boolean {
        return this._backend.available;
    }

    // ---------------------------------------------------------------- 生命周期

    create(sampleRate = PianoEngine.DEFAULT_SAMPLE_RATE, framesPerCallback = 0): boolean {
        return this._backend.create(sampleRate, framesPerCallback);
    }

    start(): boolean {
        return this._backend.start();
    }

    stop(): void {
        this._backend.stop();
    }

    destroy(): void {
        this._backend.dispose();
    }

    /**
     * 用户手势后调用，解开浏览器的自动播放限制。
     *
     * 必须在触摸回调里调用 —— AudioContext 在用户交互之前 resume() 是无效的。
     * 原生平台上这是个空操作。
     */
    resumeWebAudio(): void {
        this._backend.resume();
    }

    // ---------------------------------------------------------------- 事件与音源

    /**
     * 提交一批事件。返回实际受理条数。
     *
     * 后端不可用时返回 0 而不报错 —— 编辑器里调试交互时这是预期行为。
     */
    dispatchEvents(buffer: ArrayBuffer, count: number): number {
        if (count <= 0) {
            return 0;
        }
        return this._backend.submit(buffer, count);
    }

    /**
     * 发起载入音源包。**异步** —— 立即返回，解码在后台进行。
     *
     * 早先它是同步阻塞的（读完并解码 252MB，中端机几秒），主线程在那几秒里
     * 完全冻结，Android 上还可能被判 ANR。现在这里只发起，进度看 `loadPercent`。
     *
     * @param layerMask 常驻力度层掩码，位 0..15 对应层 1..16；-1 表示全 16 层。
     *        ⚠️ 传更小的掩码会**降低音质**（未常驻的层由相邻层顶替）—— 当前不接受。
     * @returns 是否已受理。**不代表已经能发声**
     */
    beginLoadBank(layerMask = -1): boolean {
        return this._backend.beginLoadBank(layerMask);
    }

    /**
     * 音源载入进度：-2 失败 / -1 未开始 / 0..99 进行中 / 100 已完成。
     *
     * 语义由常量 `LOAD_FAILED` / `LOAD_IDLE` / `LOAD_DONE` 表达，不要在调用点
     * 写裸数字 —— `-1` 与 `-2` 光看代码分不清哪个是失败。
     */
    get loadPercent(): number {
        return this._backend.loadPercent;
    }

    /** 音源是否已就位（此时按键才会发声） */
    get bankReady(): boolean {
        return this._backend.loadPercent === LOAD_DONE;
    }

    // ---------------------------------------------------------------- 参数

    setParam(id: number, value: number): void {
        this._backend.setParam(id, value);
    }

    setForceCurve(points: Float32Array): void {
        this._backend.setForceCurve(points);
    }

    // ---------------------------------------------------------------- 时钟与诊断

    /**
     * 音频流时钟（毫秒）。**0 表示「没有音频时钟」**（预览后端、或原生流没起来）。
     *
     * 这里刻意**不做回退** —— 门面只报事实。「没有音频时钟时拿什么顶上」
     * 是用它的人的决定：`EventBatcher` 靠 0 判断「还不能做时钟校准」，
     * 而 `EngineAudioClock` 会回退到 UI 时钟好让时间戳在编辑器里仍然有意义。
     */
    getStreamTimeMs(): number {
        return this._backend.streamTimeMs();
    }

    /** 结构化诊断数据。呈现方式由 UI 决定 */
    diagnostics(): BackendDiagnostics {
        return this._backend.diagnostics();
    }
}
