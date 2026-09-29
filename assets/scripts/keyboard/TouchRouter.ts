import { _decorator, Camera, Canvas, Component, EventTouch, Node, UITransform, Vec3 } from 'cc';
import { KeyLayout } from './KeyLayout';
import { KeyboardView } from './KeyboardView';
import { EventSource } from '../audio/PianoTypes';

const { ccclass, property } = _decorator;

/** 接收演奏事件的监听者。由控制器实现，后续接到 PianoEngine。 */
export interface PianoInputListener {
    onNoteOn(midi: number, velocity: number, source: EventSource): void;
    onNoteOff(midi: number): void;
}

/** 触摸的本地坐标（键盘坐标系：原点在左下角，y 向上） */
interface LocalPoint {
    x: number;
    y: number;
}

/**
 * 触摸路由 —— 命中测试、多点跟踪、力度、滑奏。
 *
 * 对应 M3-3 / M3-4 / M3-5。
 *
 * 挂在与 KeyboardView **同一个节点**上。该节点的锚点被 KeyboardView 钉在
 * 左下角，因此 `convertToNodeSpaceAR()` 的结果直接就是 KeyLayout 的坐标系，
 * 这里不需要做任何额外换算。
 */
@ccclass('TouchRouter')
export class TouchRouter extends Component {
    @property({ tooltip: '最小力度 0..1（按在琴键最靠里处）' })
    minVelocity = 0.25;

    @property({ tooltip: '最大力度 0..1（按在琴键最外端）' })
    maxVelocity = 1.0;

    @property({ tooltip: '固定力度模式：忽略触点到使固定值，适合不接受力度波动的用户' })
    fixedVelocity = false;

    @property({ tooltip: '固定力度模式下的力度值 0..1' })
    fixedVelocityValue = 0.7;

    @property({ tooltip: '滑奏防抖窗口（毫秒）：刚离开又立刻回到同一个键，视为手指在键缝上抖动' })
    glissandoDebounceMs = 30;

    /** 演奏事件出口 */
    listener: PianoInputListener | null = null;

    private _view!: KeyboardView;
    /**
     * 累计收到的触摸事件数（不论是否命中）。
     *
     * 与「按住的键数」对照可区分两类故障：
     *   - 事件数一直是 0  → 事件根本没送达（层级、坐标、节点可见性）
     *   - 事件数在涨但没命中 → 送达了但命中测试落空（坐标换算、键位尺寸）
     * 这两类的排查方向完全不同，混在一起看是查不出来的。
     */
    private _eventsSeen = 0;
    /** touchId → 当前所在音高 */
    private _active = new Map<number, number>();
    /** UI 相机。屏幕像素 → 世界坐标的换算需要它（见 toLocal） */
    private _uiCamera: Camera | null = null;
    /** touchId → 最近一次因滑奏离开的音高，用于防抖 */
    private _lastLeft = new Map<number, number>();
    /** touchId → 最近一次切换的时刻 */
    private _lastSwitchAt = new Map<number, number>();
    private _tmp = new Vec3();

    protected onLoad(): void {
        this._view = this.getComponent(KeyboardView)!;
        if (!this._view) {
            throw new Error('TouchRouter 必须与 KeyboardView 挂在同一个节点上');
        }

        // 相机找不到的话坐标换算会退化（屏幕像素被当成世界坐标），
        // 表现是「按键位置全错」且没有任何报错。所以这里明确警告一次。
        this._uiCamera = this.findUiCamera();
        if (!this._uiCamera) {
            console.warn('[piano] 找不到 UI 相机，触摸坐标换算会不准确');
        }

        // 触摸事件常量挂在 Node.EventType 上，不是 EventTouch 上
        this.node.on(Node.EventType.TOUCH_START, this.onTouchStart, this);
        this.node.on(Node.EventType.TOUCH_MOVE, this.onTouchMove, this);
        this.node.on(Node.EventType.TOUCH_END, this.onTouchEnd, this);
        this.node.on(Node.EventType.TOUCH_CANCEL, this.onTouchEnd, this);
    }

    protected onDestroy(): void {
        this.node.off(Node.EventType.TOUCH_START, this.onTouchStart, this);
        this.node.off(Node.EventType.TOUCH_MOVE, this.onTouchMove, this);
        this.node.off(Node.EventType.TOUCH_END, this.onTouchEnd, this);
        this.node.off(Node.EventType.TOUCH_CANCEL, this.onTouchEnd, this);
    }

    // ---------------------------------------------------------------- 坐标

    /**
     * 触摸点 → 键盘局部坐标。
     *
     * ⚠️ 必须走 `getLocation()`（屏幕像素）+ `camera.screenToWorld()`，
     * **不能用 `getUILocation()`**。
     *
     * 两者不是同一个空间：`getUILocation()` 返回的是**设计分辨率的 UI 空间**，
     * 它的高度随屏幕宽高比变化；而 `convertToNodeSpaceAR` 要的是**世界坐标**。
     * 设计分辨率是 16:9（1280×720），手机普遍是 19.5:9 或 20:9 —— 比例不一致时
     * 这两个空间差得很多，触摸点会被换算到错误的高度上，
     * 表现为「按在键上却触发了别的键」。
     *
     * 这条路径与引擎自己的 `UITransform.hitTest` 完全一致（见
     * node-event-processor.ts），所以不会出现「引擎认为点中了、我们算成别处」。
     */
    private toLocal(event: EventTouch): LocalPoint | null {
        const transform = this.node.getComponent(UITransform);
        if (!transform) {
            return null;
        }

        const screen = event.getLocation();
        this._tmp.set(screen.x, screen.y, 0);

        if (this._uiCamera) {
            this._uiCamera.screenToWorld(this._tmp, this._tmp);
        }

        const local = transform.convertToNodeSpaceAR(this._tmp);
        return { x: local.x, y: local.y };
    }

    /** 沿父链向上找 Canvas，取它的 UI 相机 */
    private findUiCamera(): Camera | null {
        let node: Node | null = this.node;
        while (node) {
            const canvas = node.getComponent(Canvas);
            if (canvas && canvas.cameraComponent) {
                return canvas.cameraComponent;
            }
            node = node.parent;
        }
        return null;
    }

    private hitTest(event: EventTouch): number | null {
        const p = this.toLocal(event);
        if (!p) {
            return null;
        }
        return this._view.layout.hitTest(p.x, p.y);
    }

    /**
     * 力度：按触点的纵向位置决定。
     *
     * 真实钢琴的琴键绕后端支点转动，手指落点离支点越远，杠杆比越大、声音越响。
     * 映射到屏幕就是：**越靠近自己（y 越小）越响**。
     *
     * 用 `key.height` 而不是白键高度做归一化 —— 黑键更短，若用白键高度，
     * 黑键的力度范围会被压缩到很窄的一段。
     */
    private velocityFor(event: EventTouch, midi: number): number {
        if (this.fixedVelocity) {
            return this.fixedVelocityValue;
        }

        const p = this.toLocal(event);
        const key = this._view.layout.getKey(midi);
        if (!p || !key || key.height <= 0) {
            return this.fixedVelocityValue;
        }

        const keyBottom = key.isBlack ? this._view.layout.whiteKeyHeight - key.height : 0;
        const t = clamp01(1 - (p.y - keyBottom) / key.height);
        return this.minVelocity + (this.maxVelocity - this.minVelocity) * t;
    }

    // ---------------------------------------------------------------- 触摸

    private onTouchStart(event: EventTouch): void {
        this._eventsSeen++;

        // getID() 的声明类型是 number | null。拿不到 id 就无法跟踪这根手指，
        // 直接忽略 —— 否则它在 TOUCH_END 时也无从匹配，会留下挂住的音符。
        const id = event.getID();
        if (id === null || this._active.has(id)) {
            return;
        }

        const midi = this.hitTest(event);
        if (midi === null) {
            return;
        }

        this._active.set(id, midi);
        this._lastSwitchAt.set(id, performance.now());
        this._view.setPressed(midi, true);
        this.listener?.onNoteOn(midi, this.velocityFor(event, midi), EventSource.Touch);
    }

    /**
     * 滑奏：手指划过一个键就触发一个音。
     *
     * 防抖只针对一种情况 —— **刚离开某个键又在极短时间内回到它**。
     * 这几乎一定是手指停在键缝上抖动，而不是有意滑奏。
     * 反过来，正常的连续跨越新键一律立即响应，不做时间限流，
     * 否则快速横扫会漏音（手感上表现为「糊」）。
     */
    private onTouchMove(event: EventTouch): void {
        const id = event.getID();
        if (id === null) {
            return;
        }
        const current = this._active.get(id);
        if (current === undefined) {
            return;
        }

        const midi = this.hitTest(event);
        if (midi === null || midi === current) {
            return;
        }

        const now = performance.now();
        const lastSwitch = this._lastSwitchAt.get(id) ?? 0;
        if (midi === this._lastLeft.get(id) && now - lastSwitch < this.glissandoDebounceMs) {
            return;
        }

        this.listener?.onNoteOff(current);
        this._view.setPressed(current, false);

        this._lastLeft.set(id, current);
        this._lastSwitchAt.set(id, now);
        this._active.set(id, midi);
        this._view.setPressed(midi, true);
        this.listener?.onNoteOn(midi, this.velocityFor(event, midi), EventSource.Touch);
    }

    private onTouchEnd(event: EventTouch): void {
        const id = event.getID();
        if (id === null) {
            return;
        }
        const midi = this._active.get(id);
        if (midi === undefined) {
            return;
        }

        this._active.delete(id);
        this._lastLeft.delete(id);
        this._lastSwitchAt.delete(id);
        this._view.setPressed(midi, false);
        this.listener?.onNoteOff(midi);
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

    /** 释放全部发声中音符（来电、切后台等场景） */
    releaseAll(): void {
        for (const midi of this._active.values()) {
            this.listener?.onNoteOff(midi);
            this._view.setPressed(midi, false);
        }
        this._active.clear();
        this._lastLeft.clear();
        this._lastSwitchAt.clear();
    }

    protected onDisable(): void {
        this.releaseAll();
    }
}

function clamp01(v: number): number {
    return v < 0 ? 0 : v > 1 ? 1 : v;
}
