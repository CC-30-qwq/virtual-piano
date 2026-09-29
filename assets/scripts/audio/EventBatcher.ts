import { PianoEngine } from './PianoEngine';
import { EventType, EventSource, EventWriter } from './PianoTypes';

/**
 * 演奏事件批处理。
 *
 * 对应《方案》§3.2 的性能红线：`submitEvents` 是全工程唯一的每帧跨语言调用，
 * 所有音符先在 TS 侧攒进一个 ArrayBuffer，帧末一次性提交。
 * **不要为每个音符单独调一次原生方法。**
 *
 * ## 时间戳
 *
 * 事件的 `timeMs` 是「**应当发声的音频时刻**」，不是「事件产生的时刻」。
 * 音频线程推进到该时刻才触发，UI 线程的抖动因此不会传递到音符的相对时序上。
 *
 * 两个时钟的换算：`timeMs = performance.now() + 偏移 + 前瞻`。
 * 偏移在每帧校准（音频时钟 − performance.now()），前瞻用于给音频线程留出
 * 调度余量。
 *
 * ⚠️ Cocos 的 `EventTouch` **不暴露操作系统级的时间戳**，所以这里只能取
 * 「TS 收到事件的那一刻」。真机上的触摸分发延迟因此无法从时间戳里扣除，
 * 只能靠前瞻量与后续的延迟校准向导来补偿。
 */
export class EventBatcher {
    private readonly _writer = new EventWriter();
    private readonly _engine: PianoEngine;

    /** 前瞻量：事件时间戳相对当前时刻前推多少毫秒 */
    private _leadMs = 6;
    /** 音频时钟 − performance.now()；未校准时不使用 */
    private _clockOffsetMs = 0;
    private _clockCalibrated = false;

    private _submittedTotal = 0;
    private _droppedTotal = 0;

    constructor(engine: PianoEngine = PianoEngine.instance) {
        this._engine = engine;
    }

    /** 累计提交成功的事件数 */
    get submittedTotal(): number {
        return this._submittedTotal;
    }

    /** 累计因缓冲满而丢弃的事件数。正常演奏时应恒为 0。 */
    get droppedTotal(): number {
        return this._droppedTotal;
    }

    /** 当前待提交的事件数 */
    get pending(): number {
        return this._writer.count;
    }

    get leadMs(): number {
        return this._leadMs;
    }

    set leadMs(value: number) {
        this._leadMs = Math.max(0, value);
    }

    // ---------------------------------------------------------------- 时钟

    /**
     * 校准两个时钟的偏移。每帧调用一次即可。
     *
     * 只在音频流真正跑起来之后校准 —— 未启动时原生返回 0，
     * 拿它做基准会把偏移算成一个巨大的负数。
     */
    calibrate(): void {
        const audioMs = this._engine.getStreamTimeMs();
        if (audioMs > 0) {
            this._clockOffsetMs = audioMs - performance.now();
            this._clockCalibrated = true;
        }
    }

    /** 取当前应当写入事件的时间戳 */
    private stamp(): number {
        if (!this._clockCalibrated) {
            // 未校准（编辑器预览、音频未启动）：写 0 表示「立即发声」
            return 0;
        }
        return performance.now() + this._clockOffsetMs + this._leadMs;
    }

    // ---------------------------------------------------------------- 写入

    noteOn(midi: number, velocity: number, source: EventSource = EventSource.Touch): boolean {
        return this.push(EventType.NoteOn, midi, velocityToMidi(velocity), source);
    }

    noteOff(midi: number, source: EventSource = EventSource.Touch): boolean {
        return this.push(EventType.NoteOff, midi, 0, source);
    }

    pedalDown(): boolean {
        return this.push(EventType.PedalDown, 0, 0, EventSource.Touch);
    }

    pedalUp(): boolean {
        return this.push(EventType.PedalUp, 0, 0, EventSource.Touch);
    }

    /** 半踏板：value 0..127，承载在 note 字段上 */
    pedalValue(value: number): boolean {
        return this.push(EventType.PedalValue, clampMidi(value), 0, EventSource.Touch);
    }

    allNotesOff(): boolean {
        return this.push(EventType.AllNotesOff, 0, 0, EventSource.Touch);
    }

    private push(type: EventType, note: number, velocity: number, source: EventSource): boolean {
        const ok = this._writer.push(type, note, velocity, source, this.stamp());
        if (!ok) {
            this._droppedTotal++;
        }
        return ok;
    }

    // ---------------------------------------------------------------- 提交

    /**
     * 把攒下的事件一次性提交给原生层。每帧末调用。
     *
     * @returns 本次提交的事件数
     */
    flush(): number {
        const count = this._writer.count;
        if (count === 0) {
            return 0;
        }

        // dispatchEvents 会挑当前可用的后端：原生优先，否则走浏览器预览后端。
        // 两条路读同一套事件布局，所以这里不需要分支。
        const accepted = this._engine.dispatchEvents(this._writer.buffer, count);
        this._submittedTotal += accepted;

        // 后端还没就绪（音源解码中）时返回 0，这些事件确实没去处。
        // 不计入 dropped —— 编辑器预览下的启动瞬间属于预期，不是异常。
        if (this._engine.available && accepted < count) {
            this._droppedTotal += count - accepted;
        }

        this._writer.clear();
        return accepted;
    }

    /** 丢弃未提交的事件（如切换场景时） */
    reset(): void {
        this._writer.clear();
    }
}

/** 力度 0..1 → MIDI 0..127 */
export function velocityToMidi(velocity: number): number {
    const v = velocity < 0 ? 0 : velocity > 1 ? 1 : velocity;
    return Math.round(v * 127);
}

function clampMidi(v: number): number {
    const n = Math.round(v);
    return n < 0 ? 0 : n > 127 ? 127 : n;
}
