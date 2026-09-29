import { AudioBackend, BackendDiagnostics } from './AudioBackend';

/**
 * 原生后端 —— 包住 JSB 注入的全局对象 `jsbPiano`。
 *
 * 原生层（C++）在 JSB 环境中注册一个全局对象 `jsbPiano`。**它只在原生平台存在** ——
 * 在编辑器预览、浏览器里都没有。所以每个方法都必须能在「绑定不存在」时安全退化：
 * 原生不可用不能让整个键盘在编辑器里没法调。
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
    getXrunCount(): number;
    /** 设备实际生效的回调帧数 */
    getFramesPerBurst(): number;
    /** 内核状态描述，如 "running" / "stopped" */
    getStatus(): string;
    /** 累计接受的合法事件数 */
    getAcceptedEvents(): number;
    /** 累计丢弃的非法事件数 */
    getDroppedEvents(): number;

    /**
     * 音频时钟（毫秒）：自音频流启动起算。未启动时返回 0。
     */
    getStreamTimeMs(): number;
}

/** 取原生层注入的全局对象；非原生平台为 undefined。 */
export function getNativeJsBridge(): IJsbPiano | undefined {
    return (globalThis as unknown as { jsbPiano?: IJsbPiano }).jsbPiano;
}

/**
 * 原生后端。
 *
 * @param jsb 原生绑定。**允许为 undefined** —— 那是「跑在原生平台上却没找到绑定」
 *            的情况，此时一切静默降级，但诊断里会明确写出「原生绑定缺失」，
 *            让人一眼看出是 JSB 注册出了问题。
 */
export class NativeBackend implements AudioBackend {
    readonly kind = 'native' as const;

    private _created = false;
    private _running = false;

    constructor(private readonly _jsb: IJsbPiano | undefined) {}

    get available(): boolean {
        return !!this._jsb;
    }

    create(sampleRate: number, framesPerCallback: number): boolean {
        if (!this._jsb) return false;
        if (this._created) return true;
        this._created = this._jsb.create(sampleRate, framesPerCallback);
        return this._created;
    }

    start(): boolean {
        if (!this._jsb || !this._created) return false;
        this._running = this._jsb.start();
        return this._running;
    }

    stop(): void {
        if (!this._jsb || !this._running) return;
        this._jsb.stop();
        this._running = false;
    }

    dispose(): void {
        if (!this._jsb) return;
        this._jsb.destroy();
        this._created = false;
        this._running = false;
    }

    /** 原生平台没有自动播放限制，空操作 */
    resume(): void {}

    loadBank(layerMask: number): boolean {
        return this._jsb ? this._jsb.loadBank(layerMask) !== 0 : false;
    }

    submit(buffer: ArrayBuffer, count: number): number {
        if (!this._jsb || !this._running || count <= 0) return 0;
        return this._jsb.submitEvents(buffer, count);
    }

    setParam(id: number, value: number): void {
        this._jsb?.setParam(id, value);
    }

    setForceCurve(points: Float32Array): void {
        this._jsb?.setForceCurve(points);
    }

    /**
     * 音频流时钟。
     *
     * ⚠️ 流没跑起来时原生返回 0 —— 调用方据此判断「还不能做时钟校准」，
     * 不要在这里回退到 UI 时钟（那会把偏移算成一个巨大的负数）。
     */
    streamTimeMs(): number {
        return this._jsb?.getStreamTimeMs() ?? 0;
    }

    diagnostics(): BackendDiagnostics {
        const jsb = this._jsb;
        if (!jsb) {
            return {
                kind: 'native', status: '原生绑定缺失',
                voices: 0, xrun: 0, framesPerBurst: 0,
                acceptedEvents: 0, droppedEvents: 0, residentBytes: 0,
            };
        }
        return {
            kind: 'native',
            status: jsb.getStatus(),
            voices: jsb.getActiveVoices(),
            xrun: jsb.getXrunCount(),
            framesPerBurst: jsb.getFramesPerBurst(),
            acceptedEvents: jsb.getAcceptedEvents(),
            droppedEvents: jsb.getDroppedEvents(),
            residentBytes: jsb.getResidentBytes(),
        };
    }
}
