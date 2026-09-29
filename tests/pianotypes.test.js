/**
 * TS ↔ C++ 事件契约测试。
 *
 * 这是全工程最值得测的一处：PianoEvent 是定长二进制结构，两侧布局一旦错位，
 * 症状是「音符乱响」而不是崩溃，靠日志几乎查不出来。
 *
 * C++ 侧由 PianoEvent.h 的 static_assert 在**编译期**卡住偏移量；
 * 这里在**测试期**卡住 TS 侧的同一组偏移量。两边合起来才算闭环。
 */
const {
    EventType, EventSource, ParamId,
    EVENT_STRIDE, MAX_VOICES, EVENT_QUEUE_CAPACITY, EventWriter,
} = require('./PianoTypes.js');

let pass = 0, fail = 0;
function ok(cond, msg) {
    if (cond) { pass++; } else { fail++; console.log('  FAIL: ' + msg); }
}
function eq(a, b, msg) { ok(a === b, `${msg} (期望 ${b}, 实际 ${a})`); }

console.log('--- 常量 ---');
eq(EVENT_STRIDE, 16, 'EVENT_STRIDE');
eq(MAX_VOICES, 64, 'MAX_VOICES');
eq(EVENT_QUEUE_CAPACITY, 2048, 'EVENT_QUEUE_CAPACITY');

console.log('--- 枚举值（须与 C++ 逐项一致）---');
eq(EventType.NoteOn, 1, 'EventType.NoteOn');
eq(EventType.NoteOff, 2, 'EventType.NoteOff');
eq(EventType.PedalDown, 3, 'EventType.PedalDown');
eq(EventType.PedalUp, 4, 'EventType.PedalUp');
eq(EventType.PedalValue, 5, 'EventType.PedalValue');
eq(EventType.AllNotesOff, 6, 'EventType.AllNotesOff');
eq(EventType.PitchBend, 7, 'EventType.PitchBend');
eq(EventSource.Touch, 0, 'EventSource.Touch');
eq(EventSource.Midi, 1, 'EventSource.Midi');
eq(EventSource.AutoPlay, 2, 'EventSource.AutoPlay');
eq(ParamId.MasterVolume, 0, 'ParamId.MasterVolume');
eq(ParamId.VelocityDepth, 11, 'ParamId.VelocityDepth');

console.log('--- 缓冲区尺寸 ---');
const w = new EventWriter(4);
eq(w.capacity, 4, '容量');
eq(w.buffer.byteLength, 4 * EVENT_STRIDE, '缓冲区字节数');
eq(w.count, 0, '初始计数');
ok(w.empty, '初始应为空');

console.log('--- 单事件字节布局 ---');
// C++ 侧对应偏移：type@0 note@1 velocity@2 source@3 timeMs@4 reserved0@8 reserved1@12
ok(w.push(EventType.NoteOn, 69, 100, EventSource.Touch, 1234.5), '写入应成功');
eq(w.count, 1, '写入后计数');

const dv = new DataView(w.buffer);
eq(dv.getUint8(0), 1, 'type @0');
eq(dv.getUint8(1), 69, 'note @1');
eq(dv.getUint8(2), 100, 'velocity @2');
eq(dv.getUint8(3), 0, 'source @3');
ok(Math.abs(dv.getFloat32(4, true) - 1234.5) < 1e-3, `timeMs @4 (实际 ${dv.getFloat32(4, true)})`);
eq(dv.getUint32(8, true), 0, 'reserved0 @8');
eq(dv.getUint32(12, true), 0, 'reserved1 @12');

console.log('--- 小端序确认 ---');
// timeMs = 1.0 的 IEEE754 大端为 3F800000；若按小端存放则首字节为 0x00、末字节为 0x3F
const ew = new EventWriter(1);
ew.push(EventType.NoteOn, 60, 64, EventSource.Touch, 1.0);
const dv2 = new DataView(ew.buffer);
eq(dv2.getUint8(4), 0x00, 'float 首字节为 0x00（小端）');
eq(dv2.getUint8(7), 0x3f, 'float 末字节为 0x3f（小端）');

console.log('--- 越界钳位 ---');
const c = new EventWriter(4);
c.push(EventType.NoteOn, 200, 300, EventSource.Touch, 0);
const dvc = new DataView(c.buffer);
eq(dvc.getUint8(1), 127, 'note 200 应钳到 127（而不是掩码成 72）');
eq(dvc.getUint8(2), 127, 'velocity 300 应钳到 127');

const c2 = new EventWriter(1);
c2.push(EventType.NoteOn, -5, -1, EventSource.Touch, 0);
const dvc2 = new DataView(c2.buffer);
eq(dvc2.getUint8(1), 0, 'note -5 应钳到 0');
eq(dvc2.getUint8(2), 0, 'velocity -1 应钳到 0');

console.log('--- 容量与清空 ---');
const f = new EventWriter(2);
ok(f.push(EventType.NoteOn, 60, 64, EventSource.Touch, 0), '第 1 个');
ok(f.push(EventType.NoteOn, 61, 64, EventSource.Touch, 0), '第 2 个');
ok(!f.push(EventType.NoteOn, 62, 64, EventSource.Touch, 0), '超出容量应返回 false');
eq(f.count, 2, '超容量写入不应增加计数');
f.clear();
eq(f.count, 0, '清空后计数');
ok(f.empty, '清空后应为空');
ok(f.push(EventType.NoteOn, 62, 64, EventSource.Touch, 0), '清空后应可继续写入');

console.log('--- 多事件互不覆盖 ---');
const m = new EventWriter(3);
m.push(EventType.NoteOn, 60, 10, EventSource.Touch, 1.5);
m.push(EventType.NoteOff, 60, 0, EventSource.Midi, 2.5);
m.push(EventType.PedalDown, 0, 0, EventSource.AutoPlay, 3.5);
const dvm = new DataView(m.buffer);
eq(dvm.getUint8(0 * 16 + 1), 60, '第 1 事件 note');
eq(dvm.getUint8(1 * 16 + 0), 2, '第 2 事件 type');
eq(dvm.getUint8(1 * 16 + 3), 1, '第 2 事件 source');
eq(dvm.getUint8(2 * 16 + 0), 3, '第 3 事件 type');
eq(dvm.getUint8(2 * 16 + 3), 2, '第 3 事件 source');
ok(Math.abs(dvm.getFloat32(2 * 16 + 4, true) - 3.5) < 1e-3, '第 3 事件 timeMs');

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
