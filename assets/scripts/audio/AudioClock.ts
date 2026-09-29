/**
 * 演奏链路的两个注入点：事件出口与音频时钟。
 *
 * ## 为什么要有这两个接口
 *
 * `EventBatcher` 的**全部**逻辑都是纯的 —— 钳位、攒批、缓冲满丢弃、时钟偏移
 * 换算、统计计数。它唯一不做主的原因是要拿到「音频时钟」和「把事件交出去」，
 * 而这两件事原本直接依赖 `PianoEngine`，进而把 `cc` 依赖拖了进来 ——
 * 于是这段最需要时序测试的代码只能靠真机验证。
 *
 * 把这两件事抽成窄接口后，`EventBatcher` 不 import 任何 `cc` 模块，
 * 可以在宿主机上用一个假时钟 + 假出口直接跑（见 tests/eventbatcher.test.js）。
 *
 * 注意这两个接口是**结构类型**：`PianoEngine` 自身已经满足 `EventSink`
 * （它就是 `available` + `dispatchEvents`），无需为它写适配代码。
 */

/**
 * 音频时钟。
 *
 * 两个方法返回的是**两个不同的时间轴**，这是整个时间戳逻辑的前提：
 *   - `now()`            UI/应用时钟（毫秒，单调递增，与音频无关）
 *   - `streamTimeMs()`   音频流时钟（毫秒，自音频流启动起算）
 *
 * 事件时间戳要落在音频轴上，所以必须做一次「音频轴 − UI 轴」的偏移换算。
 */
export interface AudioClock {
    /** UI 侧当前时刻（毫秒）。原生与预览平台都用 `performance.now()` */
    now(): number;

    /** 音频流时钟（毫秒）。未启动时返回 0 —— 调用方据此判断「还不能校准」 */
    streamTimeMs(): number;
}

/**
 * 事件出口。
 *
 * `dispatchEvents` 而不是 `submitEvents`：前者会**挑当前可用的后端**
 * （原生优先，否则浏览器预览后端），后者只走原生。批处理层不该知道有几个后端。
 */
export interface EventSink {
    /**
     * 是否有后端可用。
     *
     * 需要与 `dispatchEvents` 的返回值**自洽**：`available` 为 false 时
     * `dispatchEvents` 必须返回 0。`EventBatcher` 依赖这一点来区分两种零受理：
     *   - available=false 且受理 0 → 后端还没起来（预览音源解码中），**不算丢弃**
     *   - available=true  且受理 < 提交 → 真的丢了（原生队列满），**计入 dropped**
     * 一个 available=false 却返回非 0 的出口会让统计自相矛盾。
     */
    readonly available: boolean;

    /**
     * 提交一批事件，返回实际受理条数。
     *
     * ⚠️ `buffer` 是**复用的**：调用方每帧覆写同一块内存。需要留存内容的实现
     * 必须自己拷贝（测试桩尤其容易在这里踩空 —— 存引用会读到下一帧的数据）。
     */
    dispatchEvents(buffer: ArrayBuffer, count: number): number;
}
