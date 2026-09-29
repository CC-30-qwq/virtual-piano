/****************************************************************************
 * 钢琴音频内核 —— 演奏事件定义
 *
 * 对应《横屏高仿真钢琴落地实施方案》§3.1（接口契约，M0 结束时冻结）。
 *
 * TS 侧以 ArrayBuffer 批量提交，JSB 绑定直接读 TypedArray 的数据指针，
 * 因此本结构必须是 POD、定长、无虚表、无指针成员。
 ****************************************************************************/

#pragma once

#include <cstddef>
#include <cstdint>

namespace piano {

/**
 * 事件类型。取值即线上协议，与 TS 侧 `PianoTypes.ts` 的 `EventType` 逐项一致，
 * 不可随意变更。
 */
enum class EventType : uint8_t {
    NoteOn      = 1,
    NoteOff     = 2,
    PedalDown   = 3,
    PedalUp     = 4,
    PedalValue  = 5,  // 半踏板连续值，note 字段承载 0..127
    AllNotesOff = 6,
    PitchBend   = 7,
};

/** 事件来源。用于区分触屏 / MIDI / 自动演奏，便于诊断与后续分轨处理。 */
enum class EventSource : uint8_t {
    Touch    = 0,
    Midi     = 1,
    AutoPlay = 2,
};

/**
 * 演奏事件。16 字节定长，小端。
 *
 * `timeMs` 的语义是「**应当发声的音频时刻**」，而不是「事件产生的时刻」。
 * 音频线程在推进到该时刻时才触发发声，UI 线程的抖动因而不会传递到音符的
 * 相对时序上 —— 这是演奏手感的关键，详见《技术方案》§3.2。
 *
 * 时钟基准：`AudioDevice::streamTimeMs()`，即自音频流启动起的毫秒数。
 * TS 侧在 `start()` 后记录 `performance.now()` 基准，此后按
 * `timeMs = 当前音频时钟 + 前瞻量` 计算。
 */
struct alignas(16) PianoEvent {
    EventType   type;       ///< 事件类型
    uint8_t     note;       ///< MIDI 音高 0..127；PedalValue 时为踏板值 0..127
    uint8_t     velocity;   ///< 力度 0..127
    EventSource source;     ///< 事件来源
    float       timeMs;     ///< 相对音频流启动的毫秒时间戳
    uint32_t    reserved0;  ///< 保留，置 0
    uint32_t    reserved1;  ///< 保留，置 0
};

// 下面这组断言是 TS 侧定长数组布局的前提。改坏任何一个都会让事件流错位，
// 而且症状是「音符乱响」而非崩溃，极难排查 —— 所以在这里硬性卡住。
//
// TS 侧对应：assets/scripts/audio/PianoTypes.ts 的 EventWriter。
// 两侧的偏移量必须逐项一致，测试见 tests/pianotypes.test.js。
static_assert(sizeof(PianoEvent) == 16, "PianoEvent 必须保持 16 字节定长");
static_assert(alignof(PianoEvent) == 16, "PianoEvent 对齐要求被破坏");

static_assert(offsetof(PianoEvent, type) == 0, "type 偏移必须为 0");
static_assert(offsetof(PianoEvent, note) == 1, "note 偏移必须为 1");
static_assert(offsetof(PianoEvent, velocity) == 2, "velocity 偏移必须为 2");
static_assert(offsetof(PianoEvent, source) == 3, "source 偏移必须为 3");
static_assert(offsetof(PianoEvent, timeMs) == 4, "timeMs 偏移必须为 4");
static_assert(offsetof(PianoEvent, reserved0) == 8, "reserved0 偏移必须为 8");
static_assert(offsetof(PianoEvent, reserved1) == 12, "reserved1 偏移必须为 12");

/** 单个事件的字节跨度，供 TS 侧计算 ArrayBuffer 长度。 */
constexpr uint32_t kPianoEventStride = sizeof(PianoEvent);

}  // namespace piano
