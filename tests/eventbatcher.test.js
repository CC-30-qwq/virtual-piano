/**
 * EventBatcher —— 演奏事件的攒批、时间戳与丢包统计。
 *
 * ## 为什么这个文件值得存在
 *
 * EventBatcher 的逻辑全是纯的，但原先它直接 `import PianoEngine`（为了拿音频时钟
 * 与提交出口），于是 `cc` 依赖把它拖进了「只能在真机验证」的盲区 ——
 * 而它恰恰是全工程唯一实现时间戳换算的地方，也是最容易悄悄错的地方。
 *
 * 现在时钟与出口都是注入的（见 assets/scripts/audio/AudioClock.ts），
 * 这里用一个假时钟就能把整条换算链钉死。
 *
 * ## 断言的是「跨语言边界上真正传出去的字节」
 *
 * 测试不读 EventBatcher 的内部状态，而是解码假出口收到的 ArrayBuffer ——
 * 那是真正会交给 C++/WebAudio 的东西，布局错了它才会错。
 */

const {
    EventBatcher, velocityToMidi,
} = require('./audio/EventBatcher.js');
const {
    EVENT_STRIDE, EVENT_QUEUE_CAPACITY,
    EventType, EventSource,
} = require('./audio/PianoTypes.js');

let pass = 0, fail = 0;
function ok(cond, msg) {
    if (cond) { pass++; } else { fail++; console.log('  FAIL: ' + msg); }
}
function eq(a, b, msg) { ok(a === b, `${msg} (期望 ${b}, 实际 ${a})`); }
function near(a, b, msg, tol = 1e-6) {
    ok(Math.abs(a - b) <= tol, `${msg} (期望 ${b}, 实际 ${a})`);
}

/**
 * 假事件出口。
 *
 * ⚠️ 必须**按 count 切片拷贝**再留存：真实出口收到的是 `EventWriter` 复用的
 * 那块 ArrayBuffer，下一帧就会覆写。存引用的话，回读第一批事件会读到第二批的
 * 内容（这个坑在本文件的历史上真实踩过一次：帧间时间戳差被读成 0）。
 */
function makeSink(available = true) {
    return {
        available,
        acceptAll: true,
        calls: [],
        dispatchEvents(buffer, count) {
            // available=false 时必须返回 0 —— 这是 EventSink 的契约（见 AudioClock.ts）
            const accepted = !this.available ? 0 : (this.acceptAll ? count : 0);
            this.calls.push({ buffer: buffer.slice(0, count * EVENT_STRIDE), count, accepted });
            return accepted;
        },
        /** 最后一批事件的条数（没提交过则为 0） */
        get lastCount() {
            return this.calls.length ? this.calls[this.calls.length - 1].count : 0;
        },
    };
}

/** 假音频时钟。两个轴的值可分别设定 */
function makeClock(nowValue, streamValue) {
    return {
        nowValue,
        streamValue,
        now() { return this.nowValue; },
        streamTimeMs() { return this.streamValue; },
    };
}

/** 解码一批事件（小端） */
function readEvents(buffer, count) {
    const view = new DataView(buffer);
    const out = [];
    for (let i = 0; i < count; ++i) {
        const o = i * EVENT_STRIDE;
        out.push({
            type: view.getUint8(o + 0),
            note: view.getUint8(o + 1),
            velocity: view.getUint8(o + 2),
            source: view.getUint8(o + 3),
            timeMs: view.getFloat32(o + 4, true),
        });
    }
    return out;
}

// ---------------------------------------------------------------- 字节布局

console.log('--- 从出口解码的字节布局 ---');
{
    const sink = makeSink();
    const b = new EventBatcher(sink, makeClock(0, 0));
    b.noteOn(69, 1.0, EventSource.Midi);
    eq(1, b.flush(), '提交条数');

    const [e] = readEvents(sink.calls[0].buffer, 1);
    eq(e.type, EventType.NoteOn, 'type 必须在偏移 0');
    eq(e.note, 69, 'note 必须在偏移 1');
    eq(e.velocity, 127, 'velocity 必须在偏移 2');
    eq(e.source, EventSource.Midi, 'source 必须在偏移 3');
    eq(sink.calls[0].count, 1, '提交条数应与写入条数一致');
}

console.log('--- 多事件互不覆盖 ---');
{
    const sink = makeSink();
    const b = new EventBatcher(sink, makeClock(0, 0));
    b.noteOn(60, 0.5);
    b.noteOff(61);
    b.pedalDown();
    b.pedalUp();
    eq(4, b.flush(), '四类事件都应写入');

    const es = readEvents(sink.calls[0].buffer, 4);
    eq(es[0].type, EventType.NoteOn, '第 0 条');
    eq(es[0].note, 60, '第 0 条音高');
    eq(es[1].type, EventType.NoteOff, '第 1 条');
    eq(es[1].note, 61, '第 1 条音高');
    eq(es[2].type, EventType.PedalDown, '第 2 条');
    eq(es[3].type, EventType.PedalUp, '第 3 条');
}

// ---------------------------------------------------------------- 钳位

console.log('--- 音高越界钳位（不是掩码）---');
{
    const sink = makeSink();
    const b = new EventBatcher(sink, makeClock(0, 0));
    b.noteOn(200, 0.5);      // 200 & 0x7f = 72 —— 那会弹出一个无关的音
    b.noteOn(-5, 0.5);
    b.flush();

    const es = readEvents(sink.calls[0].buffer, 2);
    eq(es[0].note, 127, '200 应钳到 127，而不是掩码成 72');
    eq(es[1].note, 0, '负数应钳到 0');
}

console.log('--- 力度换算 ---');
{
    eq(velocityToMidi(0), 0, '0');
    eq(velocityToMidi(1), 127, '1');
    eq(velocityToMidi(0.5), 64, '0.5 四舍五入');
    eq(velocityToMidi(1.5), 127, '越大越界');
    eq(velocityToMidi(-0.5), 0, '越小越界');

    const sink = makeSink();
    const b = new EventBatcher(sink, makeClock(0, 0));
    b.noteOn(60, 1.5);       // 走 noteOn 也应当被钳住
    b.flush();
    eq(readEvents(sink.calls[0].buffer, 1)[0].velocity, 127, 'noteOn 的力度也须钳位');
}

console.log('--- 半踏板：值承载在 note 字段 ---');
{
    const sink = makeSink();
    const b = new EventBatcher(sink, makeClock(0, 0));
    b.pedalValue(64);
    b.pedalValue(300);
    b.flush();

    const es = readEvents(sink.calls[0].buffer, 2);
    eq(es[0].type, EventType.PedalValue, '类型');
    eq(es[0].note, 64, '踏板值');
    eq(es[1].note, 127, '踏板值越界钳位');
}

// ---------------------------------------------------------------- 时间戳

console.log('--- 时间戳：未校准 ---');
{
    const sink = makeSink();
    const b = new EventBatcher(sink, makeClock(1234, 0));   // 音频流没起来
    b.noteOn(60, 0.5);
    b.calibrate();
    b.flush();

    const [e] = readEvents(sink.calls[0].buffer, 1);
    eq(e.timeMs, 0, '未校准应写 0（立即发声），而不是拿 UI 时钟当基准');
}

console.log('--- 时间戳：校准后 = UI 时钟 + 偏移 + 前瞻 ---');
{
    const sink = makeSink();
    const clock = makeClock(1000, 5000);                    // 偏移 = 5000 - 1000
    const b = new EventBatcher(sink, clock);
    b.calibrate();
    b.noteOn(60, 0.5);
    b.flush();

    const [e] = readEvents(sink.calls[0].buffer, 1);
    // 默认前瞻 6ms：1000 + 4000 + 6
    eq(e.timeMs, 5006, '校准后的时间戳');
}

console.log('--- 时间戳：随 UI 时钟前进（帧间差 = 真实间隔）---');
{
    const sink = makeSink();
    const clock = makeClock(1000, 5000);
    const b = new EventBatcher(sink, clock);
    b.calibrate();

    b.noteOn(60, 0.5);
    b.flush();
    clock.nowValue += 16;          // 一帧 ≈16ms
    b.noteOn(62, 0.5);
    b.flush();

    const t0 = readEvents(sink.calls[0].buffer, 1)[0].timeMs;
    const t1 = readEvents(sink.calls[1].buffer, 1)[0].timeMs;
    eq(t1 - t0, 16, '两帧之间的时间戳差应等于 UI 时钟差');
}

console.log('--- 前瞻量 ---');
{
    const sink = makeSink();
    const clock = makeClock(1000, 5000);
    const b = new EventBatcher(sink, clock);
    b.calibrate();
    b.leadMs = 40;
    eq(b.leadMs, 40, '前瞻量可设');
    b.noteOn(60, 0.5);
    b.flush();
    eq(readEvents(sink.calls[0].buffer, 1)[0].timeMs, 5040, '前瞻量应计入时间戳');

    b.leadMs = -10;
    eq(b.leadMs, 0, '负前瞻量应钳到 0');
}

// ---------------------------------------------------------------- 提交与丢包

console.log('--- 空批不提交 ---');
{
    const sink = makeSink();
    const b = new EventBatcher(sink, makeClock(1000, 5000));
    eq(b.flush(), 0, '没有事件时 flush 返回 0');
    eq(sink.calls.length, 0, '没有事件时不应调用出口');
}

console.log('--- 正常提交与统计 ---');
{
    const sink = makeSink();
    const b = new EventBatcher(sink, makeClock(1000, 5000));
    b.noteOn(60, 0.5);
    b.noteOn(64, 0.5);
    eq(b.pending, 2, '提交前待提交数');
    eq(b.flush(), 2, '提交条数');
    eq(b.pending, 0, '提交后应清空');
    eq(b.submittedTotal, 2, '累计提交数');
    eq(b.droppedTotal, 0, '不应有丢弃');
}

console.log('--- 缓冲满：丢弃计数、不增 pending ---');
{
    const sink = makeSink();
    const b = new EventBatcher(sink, makeClock(1000, 5000));
    const overflow = 3;
    let acceptedWrites = 0;
    for (let i = 0; i < EVENT_QUEUE_CAPACITY + overflow; ++i) {
        if (b.noteOn(60, 0.5)) acceptedWrites++;
    }
    eq(acceptedWrites, EVENT_QUEUE_CAPACITY, '写满后应返回 false');
    eq(b.pending, EVENT_QUEUE_CAPACITY, 'pending 应停在容量上');
    eq(b.droppedTotal, overflow, '超出的条数应计入丢弃');

    eq(b.flush(), EVENT_QUEUE_CAPACITY, '提交的是容量内的那些');
    eq(b.submittedTotal, EVENT_QUEUE_CAPACITY, '累计提交数');
    eq(b.droppedTotal, overflow, '提交不应改变丢弃计数');
}

console.log('--- 出口只受理一部分 ---');
{
    const sink = makeSink(true);
    const b = new EventBatcher(sink, makeClock(1000, 5000));
    b.noteOn(60, 0.5);
    b.noteOn(62, 0.5);
    sink.acceptAll = false;      // 出口全拒（例如原生队列满）
    eq(b.flush(), 0, '受理 0 条');
    eq(b.submittedTotal, 0, '累计提交为 0');
    eq(b.droppedTotal, 2, '原生可用却被拒 —— 这算丢弃');
}

console.log('--- 后端不可用时不计丢弃 ---');
{
    const sink = makeSink(false);    // 预览后端还没解码完
    const b = new EventBatcher(sink, makeClock(1000, 5000));
    b.noteOn(60, 0.5);
    b.flush();
    eq(b.droppedTotal, 0, '后端不可用属预期，不应计入丢弃');
    eq(b.submittedTotal, 0, '也不应计入已提交');
}

console.log('--- reset 丢弃未提交事件 ---');
{
    const sink = makeSink();
    const b = new EventBatcher(sink, makeClock(1000, 5000));
    b.noteOn(60, 0.5);
    b.reset();
    eq(b.pending, 0, 'reset 后应为空');
    eq(b.flush(), 0, 'reset 后没有可提交的');
    eq(sink.calls.length, 0, 'reset 不应提交');
    eq(b.droppedTotal, 0, '主动丢弃不该计入 dropped（那是缓冲满的口径）');
}

console.log('--- allNotesOff ---');
{
    const sink = makeSink();
    const b = new EventBatcher(sink, makeClock(0, 0));
    b.allNotesOff();
    b.flush();
    eq(readEvents(sink.calls[0].buffer, 1)[0].type, EventType.AllNotesOff, '类型');
}

// ---------------------------------------------------------------- 结果

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
