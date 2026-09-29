import { _decorator, Component, EventTouch, Node, Vec2, Vec3, UITransform } from 'cc';
import { KeyboardView } from './KeyboardView';
import { MIN_KEY_WIDTH, MAX_KEY_WIDTH } from './KeyboardViewport';

const { ccclass, property } = _decorator;

/**
 * 键盘的平移与缩放手势。
 *
 * ## 为什么单独占一块区域，而不是直接做在琴键上
 *
 * 琴键上的手势已经被弹奏占满了：一指横划是**滑奏**，而**和弦本身就要多指**。
 * 所以「几指算手势、几指算和弦」这个边界根本划不出来 ——
 * 三指按和弦会被当成缩放，两指按和弦会被当成平移。
 *
 * 结论：手势必须放在**没有弹奏语义的地方**。这个组件挂在键盘上方的空白区，
 * 在那里拖拽/捏合不会发出任何声音，边界清晰、不会误触。
 *
 * 挂在 KeyboardArea 上方的节点上，由 Widget 拉伸至「键盘顶边以上」的全部区域。
 */
@ccclass('KeyboardGesture')
export class KeyboardGesture extends Component {
    @property({ tooltip: '要控制的键盘。留空则自动在场景里查找' })
    keyboard: KeyboardView | null = null;

    @property({ tooltip: '平移灵敏度倍率' })
    panScale = 1.0;

    @property({ tooltip: '缩放灵敏度倍率' })
    zoomScale = 1.0;

    @property({ tooltip: '是不是把平移方向反过来（拖内容 vs 拖视口）' })
    invertPan = false;

    /** touchId → 触摸点（UI 坐标） */
    private _points = new Map<number, Vec2>();
    private _lastCentroid = new Vec2();
    private _lastDistance = 0;
    private _mode: 'none' | 'pan' | 'pinch' = 'none';

    /** 本轮手势是否移动过。用来区分「双击」和「拖动后的抬手」 */
    private _moved = false;
    private _lastTapAt = 0;

    protected onLoad(): void {
        if (!this.keyboard) {
            this.keyboard = this.findKeyboard();
        }
        if (!this.keyboard) {
            console.warn('[piano] KeyboardGesture 找不到 KeyboardView，手势不可用');
            return;
        }

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

    /** 沿场景树找第一个 KeyboardView */
    private findKeyboard(): KeyboardView | null {
        const canvas = this.node.parent;
        if (!canvas) {
            return null;
        }
        // 键盘与手势区是兄弟节点，直接在同一个父节点下找
        const found = canvas.getComponentInChildren(KeyboardView);
        return found ?? null;
    }

    // ---------------------------------------------------------------- 手势

    private onTouchStart(event: EventTouch): void {
        const id = event.getID();
        if (id === null) {
            return;
        }
        if (this._points.size === 0) {
            this._moved = false;   // 新一轮手势开始，重置「是否移动过」
        }
        this._points.set(id, this.toUiPoint(event));
        this.recomputeGesture();
    }

    private onTouchMove(event: EventTouch): void {
        const id = event.getID();
        if (id === null || !this._points.has(id)) {
            return;
        }
        this._points.set(id, this.toUiPoint(event));

        if (this._mode === 'none' || !this.keyboard) {
            return;
        }
        const vp = this.keyboard.viewport;

        const centroid = this.centroid();
        const distance = this.spread();

        if (this._mode === 'pan') {
            // 一指（或多指等距）拖动：水平平移
            const dx = (centroid.x - this._lastCentroid.x) * this.panScale * (this.invertPan ? -1 : 1);
            vp.scrollBy(dx);
            if (Math.abs(dx) > 0.5) {
                this._moved = true;
            }
        } else {
            // 双指捏合：缩放，同时跟随两指中点平移
            const dx = (centroid.x - this._lastCentroid.x) * this.panScale * (this.invertPan ? -1 : 1);

            if (this._lastDistance > 1 && distance > 1) {
                const ratio = distance / this._lastDistance;
                const targetWidth = vp.keyWidth * Math.pow(ratio, this.zoomScale);

                // 锚点取两指中点在视口里的相对位置 —— 捏哪放大哪。
                //
                // 分母用键盘视口的宽度，而不是手势区自己的宽度：两者横向范围一致
                // （都由 Widget 铺满屏幕），但锚点比例是拿键盘视口解释的，语义上前者才对。
                const width = vp.viewportWidth;
                const anchorRatio = width > 0
                    ? (this._lastCentroid.x - this.nodeWorldLeft()) / width
                    : 0.5;

                vp.setKeyWidth(clamp(targetWidth, MIN_KEY_WIDTH, MAX_KEY_WIDTH), anchorRatio);
            }

            vp.scrollBy(dx);
            this._moved = true;   // 捏合本身就是手势，不该被判成双击
        }

        this._lastCentroid.set(centroid);
        this._lastDistance = distance;
    }

    private onTouchEnd(event: EventTouch): void {
        const id = event.getID();
        if (id === null) {
            return;
        }
        this._points.delete(id);
        this.recomputeGesture();

        // 双击空白区 = 恢复自动铺满。
        //
        // 这个逃生口是必需的：用户可以缩放到 48pt 并拖到任意位置，
        // 那时既看不到完整音域、也没有别的方式回到全局视图。
        // 只在「本轮没有移动过」时才算双击 —— 否则拖动后抬手会被误判。
        if (this._points.size === 0 && !this._moved && this.keyboard) {
            const now = performance.now();
            if (now - this._lastTapAt < 300) {
                this.keyboard.viewport.resetZoom();
                this._lastTapAt = 0;
            } else {
                this._lastTapAt = now;
            }
        }
    }

    /**
     * 根据当前触摸点数决定模式。
     *
     * ⚠️ 从 1 指变 2 指时**必须重建基准**（`_lastCentroid` / `_lastDistance`），
     * 否则手指落下的那一瞬间会算出一个巨大的位移，画面猛地一跳。
     */
    private recomputeGesture(): void {
        const count = this._points.size;
        if (count === 0) {
            this._mode = 'none';
            return;
        }

        this._mode = count >= 2 ? 'pinch' : 'pan';
        const c = this.centroid();
        this._lastCentroid.set(c);
        this._lastDistance = this.spread();
    }

    // ---------------------------------------------------------------- 工具

    private toUiPoint(event: EventTouch): Vec2 {
        const ui = event.getUILocation();
        return new Vec2(ui.x, ui.y);
    }

    private centroid(): Vec2 {
        const out = new Vec2();
        if (this._points.size === 0) {
            return out;
        }
        for (const p of this._points.values()) {
            out.x += p.x;
            out.y += p.y;
        }
        out.x /= this._points.size;
        out.y /= this._points.size;
        return out;
    }

    /** 两指之间的平均距离；单指时为 0 */
    private spread(): number {
        if (this._points.size < 2) {
            return 0;
        }
        if (this._points.size === 2) {
            const [a, b] = [...this._points.values()];
            return Vec2.distance(a, b);
        }
        // 三指及以上：用各点到质心的平均距离，捏合时同样单调变化
        const c = this.centroid();
        let sum = 0;
        for (const p of this._points.values()) {
            sum += Vec2.distance(p, c);
        }
        return sum / this._points.size;
    }

    /** 本节点世界范围的左边缘 x（UI 坐标）。锚点不同，换算也不同 */
    private nodeWorldLeft(): number {
        const t = this.node.getComponent(UITransform);
        if (!t) {
            return 0;
        }
        const world = this.node.worldPosition;
        return world.x - t.width * t.anchorPoint.x;
    }
}

function clamp(v: number, lo: number, hi: number): number {
    return v < lo ? lo : (v > hi ? hi : v);
}
