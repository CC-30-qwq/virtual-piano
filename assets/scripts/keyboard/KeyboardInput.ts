import { KeyboardViewport } from './KeyboardViewport';
import { KeyboardState } from './KeyboardState';
import { EventSource } from '../audio/PianoTypes';

/** 接收演奏事件的监听者。由控制器实现，接到 PianoEngine */
export interface PianoInputListener {
    onNoteOn(midi: number, velocity: number, source: EventSource): void;
    onNoteOff(midi: number): void;
}

/**
 * 可调参数。由 `TouchRouter` 的序列化属性实现 —— 传对象引用而不是快照，
 * 这样在编辑器里改数值立即生效，不需要同步代码。
 */
export interface KeyboardInputParams {
    /** 最小力度 0..1（按在琴键最靠里处） */
    minVelocity: number;
    /** 最大力度 0..1（按在琴键最外端） */
    maxVelocity: number;
    /** 固定力度模式：忽略触点到使固定值 */
    fixedVelocity: boolean;
    /** 固定力度模式下的力度值 0..1 */
    fixedVelocityValue: number;
    /** 滑奏防抖窗口（毫秒） */
    glissandoDebounceMs: number;
}

/**
 * 触摸 → 演奏事件的状态机。
 *
 * 对应 M3-3 / M3-4 / M3-5：多点跟踪、命中、力度、滑奏去抖。
 *
 * ## 为什么从 TouchRouter 里搬出来
 *
 * 这些逻辑原本长在一个 `Component` 里，与 `EventTouch`、相机坐标换算缠在一起，
 * 于是**一条都测不了** —— 十指同时按下、手指停在键缝上抖动、快速横扫，
 * 这些都只能靠人在真机上试。
 *
 * 现在它不 import 任何 `cc` 模块：坐标与时刻由调用方算好传进来
 * （`x`/`y` 是键盘局部坐标，`nowMs` 是当前时刻），`TouchRouter` 只剩
 * 「`EventTouch` → (x, y, now)」这一步适配。于是状态机可以在宿主机上跑
 * 假事件验证（见 tests/keyboardinput.test.js）。
 *
 * ## 力度
 *
 * 真实钢琴的琴键绕后端支点转动，手指落点离支点越远，杠杆比越大、声音越响。
 * 映射到屏幕就是：**越靠近自己（y 越小）越响**。
 *
 * 用 `key.height` 而不是白键高度做归一化 —— 黑键更短，若用白键高度，
 * 黑键的力度范围会被压缩到很窄的一段。
 */
export class KeyboardInput {
    private readonly _viewport: KeyboardViewport;
    private readonly _state: KeyboardState;
    private readonly _listener: PianoInputListener;
    private readonly _params: KeyboardInputParams;

    /** touchId → 当前所在音高 */
    private readonly _active = new Map<number, number>();
    /** touchId → 最近一次因滑奏离开的音高，用于防抖 */
    private readonly _lastLeft = new Map<number, number>();
    /** touchId → 最近一次切换的时刻 */
    private readonly _lastSwitchAt = new Map<number, number>();

    /**
     * 累计收到的触摸事件数（不论是否命中）。
     *
     * 与「按住的键数」对照可区分两类故障：
     *   - 事件数一直是 0  → 事件根本没送达（层级、坐标、节点可见性）
     *   - 事件数在涨但没命中 → 送达了但命中测试落空（坐标换算、键位尺寸）
     * 这两类的排查方向完全不同，混在一起看是查不出来的。
     */
    private _eventsSeen = 0;

    constructor(
        viewport: KeyboardViewport,
        state: KeyboardState,
        listener: PianoInputListener,
        params: KeyboardInputParams,
    ) {
        this._viewport = viewport;
        this._state = state;
        this._listener = listener;
        this._params = params;
    }

    // ---------------------------------------------------------------- 触摸

    /**
     * @param id     触摸点标识
     * @param x,y    键盘局部坐标（原点在白键左下角）
     * @param nowMs  当前时刻，用于滑奏防抖
     */
    touchStart(id: number, x: number, y: number, nowMs: number): void {
        this._eventsSeen++;

        // 已经在跟踪的 id 直接忽略 —— 拿不到 id 或重复 id 都会让这根手指
        // 在 touchEnd 时无从匹配，留下挂住的音符。
        if (this._active.has(id)) {
            return;
        }

        const midi = this._viewport.layout.hitTest(x, y);
        if (midi === null) {
            return;
        }

        this._active.set(id, midi);
        this._lastSwitchAt.set(id, nowMs);
        this._state.set(midi, true);
        this._listener.onNoteOn(midi, this.velocityFor(y, midi), EventSource.Touch);
    }

    /**
     * 滑奏：手指划过一个键就触发一个音。
     *
     * 防抖只针对一种情况 —— **刚离开某个键又在极短时间内回到它**。
     * 这几乎一定是手指停在键缝上抖动，而不是有意滑奏。
     * 反过来，正常的连续跨越新键一律立即响应，不做时间限流，
     * 否则快速横扫会漏音（手感上表现为「糊」）。
     */
    touchMove(id: number, x: number, y: number, nowMs: number): void {
        const current = this._active.get(id);
        if (current === undefined) {
            return;
        }

        const midi = this._viewport.layout.hitTest(x, y);
        if (midi === null || midi === current) {
            return;
        }

        const lastSwitch = this._lastSwitchAt.get(id) ?? 0;
        if (midi === this._lastLeft.get(id) && nowMs - lastSwitch < this._params.glissandoDebounceMs) {
            return;
        }

        this._listener.onNoteOff(current);
        this._state.set(current, false);

        this._lastLeft.set(id, current);
        this._lastSwitchAt.set(id, nowMs);
        this._active.set(id, midi);
        this._state.set(midi, true);
        this._listener.onNoteOn(midi, this.velocityFor(y, midi), EventSource.Touch);
    }

    touchEnd(id: number): void {
        const midi = this._active.get(id);
        if (midi === undefined) {
            return;
        }

        this._active.delete(id);
        this._lastLeft.delete(id);
        this._lastSwitchAt.delete(id);
        this._state.set(midi, false);
        this._listener.onNoteOff(midi);
    }

    /** 释放全部发声中音符（来电、切后台、组件禁用等场景） */
    releaseAll(): void {
        for (const midi of this._active.values()) {
            this._listener.onNoteOff(midi);
        }
        this._active.clear();
        this._lastLeft.clear();
        this._lastSwitchAt.clear();
        this._state.clear();
    }

    // ---------------------------------------------------------------- 力度

    /**
     * 触点纵向位置 → 力度 0..1。
     *
     * @param y    触点相对键盘底边的纵向位置
     * @param midi 命中的音高
     */
    velocityFor(y: number, midi: number): number {
        if (this._params.fixedVelocity) {
            return this._params.fixedVelocityValue;
        }

        const layout = this._viewport.layout;
        const key = layout.getKey(midi);
        if (!key || key.height <= 0) {
            return this._params.fixedVelocityValue;
        }

        const keyBottom = key.isBlack ? layout.whiteKeyHeight - key.height : 0;
        const t = clamp01(1 - (y - keyBottom) / key.height);
        return this._params.minVelocity + (this._params.maxVelocity - this._params.minVelocity) * t;
    }

    // ---------------------------------------------------------------- 状态

    /** 当前按下的键数（用于诊断） */
    get activeTouchCount(): number {
        return this._active.size;
    }

    /** 累计收到的触摸事件数（不论是否命中），用于诊断 */
    get eventsSeen(): number {
        return this._eventsSeen;
    }
}

function clamp01(v: number): number {
    return v < 0 ? 0 : v > 1 ? 1 : v;
}
