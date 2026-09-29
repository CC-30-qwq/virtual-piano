import { _decorator, Camera, Canvas, Component, EventTouch, Node, UITransform, Vec3 } from 'cc';
import { EventSource } from '../audio/PianoTypes';
import { KeyboardInput, KeyboardInputParams, PianoInputListener } from './KeyboardInput';
import { KeyboardView } from './KeyboardView';

const { ccclass, property } = _decorator;

/** 触摸的本地坐标（键盘坐标系：原点在左下角，y 向上） */
interface LocalPoint {
    x: number;
    y: number;
}

/**
 * 触摸适配层 —— 把 `EventTouch` 翻译成状态机的入参。
 *
 * 对应 M3-3 / M3-4 / M3-5。**逻辑不在这里**：命中测试、力度、滑奏去抖、
 * 多点跟踪都在 `KeyboardInput`（不依赖 `cc`，可在宿主机测试）。
 * 本组件只做两件事：
 *
 *   1. 把屏幕像素坐标换算成键盘局部坐标（要相机，绕不开 `cc`）
 *   2. 把触摸事件与当前时刻转发给状态机
 *
 * 挂在与 `KeyboardView` **同一个节点**上。该节点的锚点被 KeyboardView 钉在
 * 左下角，因此 `convertToNodeSpaceAR()` 的结果直接就是 KeyLayout 的坐标系，
 * 这里不需要做任何额外换算。
 *
 * ## 与 KeyboardView 的关系
 *
 * 它只从视图取两样东西：`viewport`（几何与滚动状态）和 `state`（按下状态）。
 * 两者都是不依赖 `cc` 的纯对象，**本组件不再调用任何绘制方法** ——
 * 按下高亮由 KeyboardView 自己订阅 `KeyboardState` 得到通知，
 * 输入层不需要知道「按下要去重绘谁」。
 */
@ccclass('TouchRouter')
export class TouchRouter extends Component implements KeyboardInputParams, PianoInputListener {
    // 这些属性既是编辑器可调项，也是 KeyboardInputParams 的实现 ——
    // 实现接口（而不是拷一份快照给状态机）是为了在编辑器里改数值立即生效。
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

    /** 演奏事件出口。由控制器赋值（控制器随后又把它接到 EventBatcher） */
    listener: PianoInputListener | null = null;

    private _input!: KeyboardInput;
    /** UI 相机。屏幕像素 → 世界坐标的换算需要它（见 toLocal） */
    private _uiCamera: Camera | null = null;
    private _tmp = new Vec3();

    protected onLoad(): void {
        const view = this.getComponent(KeyboardView);
        if (!view) {
            throw new Error('TouchRouter 必须与 KeyboardView 挂在同一个节点上');
        }

        // 只取「视口」与「按下状态」两个纯对象。第三个参数是本组件自己 ——
        // 状态机把事件回调给它，再由它转发给 listener（listener 是后赋值的，
        // 所以不能把 listener 直接交给状态机）。
        this._input = new KeyboardInput(view.viewport, view.state, this, this);

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

    // ---------------------------------------------------------------- 触摸转发

    private onTouchStart(event: EventTouch): void {
        // getID() 的声明类型是 number | null。拿不到 id 就无法跟踪这根手指。
        const id = event.getID();
        if (id === null) {
            return;
        }
        const p = this.toLocal(event);
        if (!p) {
            return;
        }
        this._input.touchStart(id, p.x, p.y, performance.now());
    }

    private onTouchMove(event: EventTouch): void {
        const id = event.getID();
        if (id === null) {
            return;
        }
        const p = this.toLocal(event);
        if (!p) {
            return;
        }
        this._input.touchMove(id, p.x, p.y, performance.now());
    }

    private onTouchEnd(event: EventTouch): void {
        const id = event.getID();
        if (id === null) {
            return;
        }
        this._input.touchEnd(id);
    }

    // ---------------------------------------------------------------- 演奏事件转发

    onNoteOn(midi: number, velocity: number, source: EventSource): void {
        this.listener?.onNoteOn(midi, velocity, source);
    }

    onNoteOff(midi: number): void {
        this.listener?.onNoteOff(midi);
    }

    // ---------------------------------------------------------------- 状态

    /** 当前按下的键数（用于诊断） */
    get activeTouchCount(): number {
        return this._input.activeTouchCount;
    }

    /** 累计收到的触摸事件数（不论是否命中），用于诊断 */
    get eventsSeen(): number {
        return this._input.eventsSeen;
    }

    /** 释放全部发声中音符（来电、切后台等场景） */
    releaseAll(): void {
        this._input.releaseAll();
    }

    protected onDisable(): void {
        this.releaseAll();
    }
}
