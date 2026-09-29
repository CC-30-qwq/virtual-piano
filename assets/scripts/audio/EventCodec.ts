import { EVENT_STRIDE, EventSource, EventType } from './PianoTypes';

/**
 * 演奏事件的解码 —— 字节 ↔ 字段。
 *
 * ## 为什么要单独一个文件
 *
 * 事件是**定长二进制结构**，布局由 C++ 侧的 `static_assert` 与 TS 侧的
 * tests/pianotypes.test.js 双向钉住。解码逻辑原先长在门面（`PianoEngine`）里，
 * 与「挑哪个后端」混在一起 —— 于是「布局对不对」这件事只有门面跑起来才验证得到。
 *
 * 抽出来之后它是纯函数：喂一段构造好的字节，断言解出来的字段
 * （见 tests/eventcodec.test.js）。这也是预览后端唯一读事件字节的地方。
 */

/** 从 16 字节事件里解出来的字段 */
export interface DecodedEvent {
    type: EventType;
    note: number;
    velocity: number;
    source: EventSource;
    timeMs: number;
}

/**
 * 解码第 `index` 个事件。
 *
 * 越界返回 null 而不是抛异常 —— 条数是 TS 侧自己算的，越界属于调用方 bug，
 * 但预览后端不该因此把整个渲染循环带崩（那种表现是「画面卡死」，更难查）。
 */
export function decodeEvent(buffer: ArrayBuffer, index: number): DecodedEvent | null {
    return decodeEventAt(new DataView(buffer), index);
}

/**
 * 同上，但复用调用方给的 `DataView`。
 *
 * 批量解码时用它 —— 每个事件都 `new DataView` 会白白分配一堆包装对象。
 */
export function decodeEventAt(view: DataView, index: number): DecodedEvent | null {
    const offset = index * EVENT_STRIDE;
    if (index < 0 || offset + EVENT_STRIDE > view.byteLength) {
        return null;
    }
    return {
        type: view.getUint8(offset + 0) as EventType,
        note: view.getUint8(offset + 1),
        velocity: view.getUint8(offset + 2),
        source: view.getUint8(offset + 3) as EventSource,
        // 小端：TS 侧写入时用的也是小端（见 EventWriter）
        timeMs: view.getFloat32(offset + 4, true),
    };
}
