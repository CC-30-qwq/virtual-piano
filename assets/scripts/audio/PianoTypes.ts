/**
 * 钢琴音频内核 —— TS 侧接口契约
 *
 * 与 C++ 侧逐项对齐，任何改动必须两边同步：
 *   native/engine/common/Classes/piano/PianoEvent.h
 *   native/engine/common/Classes/piano/PianoParams.h
 *
 * 对应《横屏高仿真钢琴落地实施方案》§3.1。
 */

/** 事件类型。取值即线上协议，不可变更。 */
export enum EventType {
    NoteOn = 1,
    NoteOff = 2,
    PedalDown = 3,
    PedalUp = 4,
    /** 半踏板连续值，note 字段承载 0..127 */
    PedalValue = 5,
    AllNotesOff = 6,
    PitchBend = 7,
}

/** 事件来源，用于诊断与分轨处理。 */
export enum EventSource {
    Touch = 0,
    Midi = 1,
    AutoPlay = 2,
}

/**
 * 单个演奏事件的字节跨度。
 *
 * C++ 侧是 `struct alignas(16) PianoEvent`，有 static_assert 卡死 16 字节。
 * TS 侧按定长写入 ArrayBuffer，两侧布局错位的症状是「音符乱响」而非崩溃，
 * 极难排查 —— 所以这里也用常量写死，不要改成动态计算。
 */
export const EVENT_STRIDE = 16;

/** 复音上限。与 C++ 的 kMaxVoices 一致。 */
export const MAX_VOICES = 64;

/** 事件队列容量（2 的幂）。与 C++ 的 kEventQueueCapacity 一致。 */
export const EVENT_QUEUE_CAPACITY = 2048;

/**
 * 参数 ID。与 C++ 的 `enum class ParamId` 逐项一致。
 *
 * 新增参数只能追加在末尾 —— 插到中间会让所有已保存的用户设置静默错位。
 */
export enum ParamId {
    MasterVolume = 0,
    Brightness = 1,
    LidPosition = 2,
    ReverbMix = 3,
    ReverbSize = 4,
    ReverbDecay = 5,
    ReverbDamping = 6,
    TuningA4 = 7,
    ReleaseLevel = 8,
    HammerLevel = 9,
    PedalNoiseLevel = 10,
    VelocityDepth = 11,
}

/**
 * 事件写入器。
 *
 * 用法：每帧把本帧累积的事件写进同一个 ArrayBuffer，然后一次性提交给原生层。
 * 这是全工程唯一的每帧跨语言调用，**不要为每个音符单独调一次原生方法**。
 *
 * 布局（小端，共 16 字节）：
 *   0  u8   type
 *   1  u8   note      MIDI 0..127；PedalValue 时为踏板值
 *   2  u8   velocity  0..127
 *   3  u8   source
 *   4  f32  timeMs    相对音频流启动的毫秒时间戳
 *   8  u32  reserved0
 *   12 u32  reserved1
 */
export class EventWriter {
    private readonly view: DataView;
    private _count = 0;

    constructor(capacity: number = EVENT_QUEUE_CAPACITY) {
        this.buffer = new ArrayBuffer(capacity * EVENT_STRIDE);
        this.view = new DataView(this.buffer);
    }

    /** 底层缓冲，直接传给原生层（零拷贝）。 */
    readonly buffer: ArrayBuffer;

    get count(): number {
        return this._count;
    }

    get empty(): boolean {
        return this._count === 0;
    }

    /** 容量上限（事件条数）。 */
    get capacity(): number {
        return this.buffer.byteLength / EVENT_STRIDE;
    }

    /** 清空已写入的事件。每帧提交后调用。 */
    clear(): void {
        this._count = 0;
    }

    /**
     * 追加一个事件。
     *
     * @param timeMs 该音符**应当发声的音频时刻**，不是事件产生的时刻。
     *               音频线程推进到该时刻才触发，UI 线程的抖动因此不会
     *               传递到音符的相对时序上 —— 这是演奏手感的关键。
     * @returns 是否写入成功；缓冲满时返回 false 并丢弃该事件。
     */
    push(
        type: EventType,
        note: number,
        velocity: number,
        source: EventSource,
        timeMs: number,
    ): boolean {
        if (this._count >= this.capacity) {
            return false;
        }

        const offset = this._count * EVENT_STRIDE;
        this.view.setUint8(offset + 0, type);
        // 用钳位而不是 & 0x7f：掩码会把 128 变成 0 —— 一个合法但完全错误的
        // 音符，C++ 侧的合法性校验根本拦不住，症状是偶尔弹出一个无关的音。
        this.view.setUint8(offset + 1, clamp127(note));
        this.view.setUint8(offset + 2, clamp127(velocity));
        this.view.setUint8(offset + 3, source);
        this.view.setFloat32(offset + 4, timeMs, true);
        this.view.setUint32(offset + 8, 0, true);
        this.view.setUint32(offset + 12, 0, true);

        this._count++;
        return true;
    }
}

/** 钳到 MIDI 的 0..127 合法范围 */
function clamp127(v: number): number {
    const n = Math.round(v);
    return n < 0 ? 0 : n > 127 ? 127 : n;
}
