/**
 * 音频后端接口 —— 原生内核与浏览器预览两条路的共同形状。
 *
 * ## 为什么要有这层
 *
 * 在这之前，后端选择、事件字节解码、状态文案、诊断转发全都挤在 `PianoEngine`
 * 这一个门面里，于是：
 *   - 门面里出现 `DataView` 与 `switch (type)` —— 事件解码有两份实现（另一份在 C++）
 *   - 门面里拼 UI 文案（「预览音源载入中 42%」）
 *   - 后端差异用 `if (!this._native)` 散在每个方法里
 *
 * 现在门面只做一件事：**挑一个后端并转发**。后端自己知道怎么干活、
 * 怎么报告状态；事件字节的解码统一走 `EventCodec`。
 */

/**
 * 结构化的诊断数据。
 *
 * 刻意是数据而不是**文案**：文案属于 UI（`DebugHud`），引擎层只管把数报准。
 * 原先门面直接产出「running · 192 帧/回调」这类字符串，改一个措辞要动引擎。
 */
export interface BackendDiagnostics {
    /** 后端类型。UI 据此决定怎么展示（原生有内核计数，预览没有） */
    kind: 'native' | 'web';
    /** 状态描述，如 "running" / "预览音源载入中 42%" */
    status: string;
    /** 当前发声数 */
    voices: number;
    /** 欠载次数。仅原生有，预览恒 0 */
    xrun: number;
    /** 设备实际生效的回调帧数。仅原生有 */
    framesPerBurst: number;
    /** 累计受理的事件数 */
    acceptedEvents: number;
    /** 累计丢弃的事件数 */
    droppedEvents: number;
    /** 常驻采样占用的字节数。仅原生有 */
    residentBytes: number;
}

export interface AudioBackend {
    readonly kind: 'native' | 'web';

    /**
     * 能否接收事件。
     *
     * ⚠️ 这个语义是给 `EventBatcher` 用的，必须与 `submit` 自洽：
     * **`available` 为 false 时 `submit` 必须返回 0**。批处理层靠它区分两种零受理：
     *   - false + 受理 0 → 后端还没准备好（预览音源解码中 / 原生绑定缺失），不算丢事件
     *   - true  + 受理 < 提交 → 真的丢了（原生队列满），计入 dropped
     */
    readonly available: boolean;

    // ---------------------------------------------------------------- 生命周期

    create(sampleRate: number, framesPerCallback: number): boolean;
    start(): boolean;
    stop(): void;
    dispose(): void;

    /** 用户手势后调用，解开浏览器的自动播放限制。原生为空操作 */
    resume(): void;

    // ---------------------------------------------------------------- 音源与事件

    /**
     * 载入音源包。**同步阻塞**，要读完并解码几百 MB（中端机几秒）——
     * 不要放在场景加载路径里，用 `scheduleOnce` 推迟到首帧之后。
     *
     * @param layerMask 常驻力度层掩码，位 0..15 对应层 1..16；-1 表示全 16 层
     */
    loadBank(layerMask: number): boolean;

    /**
     * 批量提交演奏事件。返回实际受理条数。
     *
     * ⚠️ `buffer` 由调用方**复用**（见 `EventWriter`），实现若需留存必须自己拷贝。
     */
    submit(buffer: ArrayBuffer, count: number): number;

    // ---------------------------------------------------------------- 参数与诊断

    setParam(id: number, value: number): void;
    setForceCurve(points: Float32Array): void;

    /** 音频时钟（毫秒）。不可用时返回 0 —— 调用方据此判断「还不能校准」 */
    streamTimeMs(): number;

    diagnostics(): BackendDiagnostics;
}
