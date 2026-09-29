/**
 * EventCodec —— 事件字节的解码。
 *
 * ## 为什么这个文件值得存在
 *
 * 事件是**定长二进制结构**，布局由 C++ 的 `static_assert` 与 `pianotypes.test.js`
 * 双向钉住 —— 但那两边只验证「写入端」的字节。解码端原先长在音频门面里，
 * 与后端选择混在一起，只有预览真的跑起来才验证得到。
 *
 * 这里用 `EventWriter` 编码、再用 `decodeEvent` 解回来做**往返核对**，
 * 两侧一旦有一边改错就会红 —— 而这类错误的真机症状是「音符乱响」，
 * 光看日志查不出来。
 */

const { decodeEvent, decodeEventAt } = require('./audio/EventCodec.js');
const {
    EventWriter, EventType, EventSource, EVENT_STRIDE,
} = require('./audio/PianoTypes.js');

let pass = 0, fail = 0;
function ok(cond, msg) {
    if (cond) { pass++; } else { fail++; console.log('  FAIL: ' + msg); }
}
function eq(a, b, msg) { ok(a === b, `${msg} (期望 ${b}, 实际 ${a})`); }
function close(a, b, msg, tol = 1e-4) {
    ok(Math.abs(a - b) <= tol, `${msg} (期望 ${b}, 实际 ${a})`);
}

// ---------------------------------------------------------------- 往返

console.log('--- 编码 → 解码 往返 ---');
{
    const w = new EventWriter();
    w.push(EventType.NoteOn, 60, 100, EventSource.Touch, 1234.5);
    w.push(EventType.NoteOff, 62, 0, EventSource.Midi, 0);
    w.push(EventType.PedalValue, 64, 0, EventSource.Touch, -3.25);

    const e0 = decodeEvent(w.buffer, 0);
    eq(e0.type, EventType.NoteOn, '类型');
    eq(e0.note, 60, '音高');
    eq(e0.velocity, 100, '力度');
    eq(e0.source, EventSource.Touch, '来源');
    close(e0.timeMs, 1234.5, '时间戳');

    const e1 = decodeEvent(w.buffer, 1);
    eq(e1.type, EventType.NoteOff, '第 2 条类型');
    eq(e1.note, 62, '第 2 条音高');
    eq(e1.source, EventSource.Midi, '第 2 条来源');
    eq(e1.timeMs, 0, '第 2 条时间戳');

    const e2 = decodeEvent(w.buffer, 2);
    eq(e2.type, EventType.PedalValue, '第 3 条类型');
    eq(e2.note, 64, '踏板值承载在 note 字段');
    close(e2.timeMs, -3.25, '负时间戳（未校准时的哨兵值之外）');
}

console.log('--- 多事件互不串位 ---');
{
    const w = new EventWriter();
    const count = 16;
    for (let i = 0; i < count; ++i) {
        w.push(EventType.NoteOn, 21 + i, i, EventSource.Touch, i * 10);
    }
    let okAll = true;
    for (let i = 0; i < count; ++i) {
        const e = decodeEvent(w.buffer, i);
        if (e.note !== 21 + i || e.velocity !== i || e.timeMs !== i * 10) {
            okAll = false;
            console.log(`    第 ${i} 条解错：note=${e.note} velocity=${e.velocity} timeMs=${e.timeMs}`);
        }
    }
    ok(okAll, '十六个事件应逐条解对');
}

// ---------------------------------------------------------------- 字节序

console.log('--- 小端序与 f32 ---');
{
    // 手工摆字节，不经过 EventWriter —— 这样能独立验证解码端的小端假设
    const buf = new ArrayBuffer(EVENT_STRIDE);
    const view = new DataView(buf);
    view.setUint8(0, EventType.NoteOn);
    view.setUint8(1, 69);
    view.setUint8(2, 127);
    view.setUint8(3, EventSource.AutoPlay);
    // 1.0f 的 IEEE754 小端字节序：00 00 80 3F
    view.setUint8(4, 0x00);
    view.setUint8(5, 0x00);
    view.setUint8(6, 0x80);
    view.setUint8(7, 0x3f);

    const e = decodeEvent(buf, 0);
    eq(e.timeMs, 1.0, '按小端读 f32（1.0 应为 00 00 80 3F）');
    eq(e.source, EventSource.AutoPlay, '来源');
}

// ---------------------------------------------------------------- 越界

console.log('--- 越界返回 null（不抛异常）---');
{
    // ⚠️ 「越界」指的是**超出缓冲字节数**，不是「超出已写入的条数」——
    // `EventWriter` 用的是完整容量的复用缓冲，写了几条只有它自己知道；
    // 条数由调用方传给后端。解码层只保证不读到缓冲之外。
    const w = new EventWriter();
    w.push(EventType.NoteOn, 60, 100, EventSource.Touch, 0);
    const capacity = w.buffer.byteLength / EVENT_STRIDE;

    eq(decodeEvent(w.buffer, capacity - 1) !== null, true, '容量内最后一条可解');
    eq(decodeEvent(w.buffer, capacity), null, '超出容量的下标为 null');
    eq(decodeEvent(w.buffer, -1), null, '负下标为 null');

    // 缓冲尾部不是整条事件：最后一个不完整的事件应当解不出来，而不是读到垃圾
    const short = new ArrayBuffer(EVENT_STRIDE + 4);
    eq(decodeEvent(short, 0) !== null, true, '第 1 条完整，可解');
    eq(decodeEvent(short, 1), null, '第 2 条不完整，应返回 null');

    const empty = new ArrayBuffer(0);
    eq(decodeEvent(empty, 0), null, '空缓冲为 null');
}

console.log('--- 未知类型原样返回（合法性不在这层判断）---');
{
    // 解码层只负责「字节 → 字段」，不判断这个类型认不认识 ——
    // 认不认识是后端的事（WebBackend 的 switch 里 default 分支会忽略它）。
    // 放在这里断言是为了防止有人把校验混进解码。
    const buf = new ArrayBuffer(EVENT_STRIDE);
    new DataView(buf).setUint8(0, 99);
    const e = decodeEvent(buf, 0);
    eq(e.type, 99, '未知类型应原样解出');
}

// ---------------------------------------------------------------- 复用 view

console.log('--- decodeEventAt 与 decodeEvent 等价 ---');
{
    const w = new EventWriter();
    w.push(EventType.PedalDown, 0, 0, EventSource.Touch, 42.5);

    const viaBuffer = decodeEvent(w.buffer, 0);
    const viaView = decodeEventAt(new DataView(w.buffer), 0);
    eq(viaView.type, viaBuffer.type, '类型一致');
    eq(viaView.note, viaBuffer.note, '音高一致');
    eq(viaView.timeMs, viaBuffer.timeMs, '时间戳一致');

    // 复用同一个 view 连续解多条
    const w2 = new EventWriter();
    w2.push(EventType.NoteOn, 1, 2, EventSource.Touch, 3);
    w2.push(EventType.NoteOff, 4, 5, EventSource.Touch, 6);
    const view = new DataView(w2.buffer);
    eq(decodeEventAt(view, 0).note, 1, '复用 view 解第 1 条');
    eq(decodeEventAt(view, 1).note, 4, '复用 view 解第 2 条');
}

// ---------------------------------------------------------------- 结果

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
