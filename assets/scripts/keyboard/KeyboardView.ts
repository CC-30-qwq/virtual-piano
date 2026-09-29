import { _decorator, Component, Node, Graphics, Color, UITransform, Vec3 } from 'cc';
import { KeyLayout, KeyGeometry, clampOffset } from './KeyLayout';

const { ccclass, property } = _decorator;

/** 键面配色 */
const COLOR_WHITE_KEY = new Color(250, 250, 248, 255);
const COLOR_BLACK_KEY = new Color(28, 28, 32, 255);
/** 按下的白键：淡蓝灰，模拟琴键下沉的反光变化 */
const COLOR_WHITE_PRESSED = new Color(168, 200, 232, 255);
const COLOR_BLACK_PRESSED = new Color(72, 108, 152, 255);
/**
 * 白键分隔线的默认颜色。
 *
 * 压在白键（250,250,248）上要有足够对比才看得见 —— 之前的 (140,140,145)
 * 偏浅，实际渲染出来几乎看不出键与键的边界。
 */
const COLOR_SEPARATOR = new Color(120, 122, 130, 255);

/** 键宽下限。低于此值手指按不准，再小就没有意义 */
export const MIN_KEY_WIDTH = 22;
/** 键宽上限。再宽就看不清整体音域了 */
export const MAX_KEY_WIDTH = 48;

/**
 * 88 键横屏键盘 —— 渲染与状态。
 *
 * 对应 M3-2。命中测试与力度计算不在这里（见 TouchRouter），
 * 本组件只负责「把一个 KeyLayout 画出来」和「记录哪些键是按下的」。
 *
 * ## 绘制方式
 *
 * 用 Graphics 批量绘制而不是每键一个 Sprite 节点 —— 后者是 88 个节点
 * 外加 88 个 UITransform，DrawCall 与遍历开销都不可接受（见方案 §7.3）。
 *
 * 整屏在**一个** Graphics 里画（为什么不是两层，见 `_layer` 的说明）。
 */
@ccclass('KeyboardView')
export class KeyboardView extends Component {
    /**
     * 白键宽度（pt）。
     *
     * ⚠️ `fitToScreen` 为真时本值会被**按视口宽度覆盖** —— 那是默认行为，
     * 因为横向滚动/缩放手势尚未实现，固定键宽会让右侧的键够不着。
     * 将来接上缩放手势后，把 `fitToScreen` 关掉即可用这个值。
     */
    @property({ tooltip: '白键宽度（pt）。fitToScreen 开启时会被自动计算覆盖' })
    keyWidth = 40;

    @property({ tooltip: '白键高度（pt）' })
    whiteKeyHeight = 180;

    /**
     * 是否让 88 键恰好铺满屏幕宽度。
     *
     * 设计分辨率 1280 宽时，每个白键约 24.6pt —— 偏窄但能一屏弹完整个音域。
     * 这是当前唯一可用的方案：横向拖动手势会和滑奏冲突，得多指手势才能区分，
     * 而那部分（M3-6）还没做。
     */
    @property({ tooltip: '让 88 键恰好铺满屏幕宽度（滚动手势未实现前应保持开启）' })
    fitToScreen = true;

    /**
     * 白键分隔线宽度（pt）。设成 0 就不画。
     *
     * 做成属性而不是常量，是为了能在编辑器里直接调 —— 「一点点」这种
     * 程度只能看着改，写成常量每次都要改代码再重跑。
     */
    @property({ tooltip: '白键分隔线宽度（pt），0 表示不画' })
    whiteKeyOutlineWidth = 1;

    @property({ tooltip: '白键分隔线颜色' })
    whiteKeyOutlineColor = COLOR_SEPARATOR.clone();

    private _layout!: KeyLayout;

    /**
     * 绘制层。
     *
     * **只有一层。** 曾经拆成「静态键面 + 按下高亮」两层来省重绘开销，
     * 但两层之间的绘制顺序会互相干扰：按下层在基础层之上，白键高亮画全高
     * 就会糊住压在它上面的黑键；而补画黑键又引出了新的状态问题。
     * 合并成一层后，所有元素在同一个序列里画，顺序天然正确，
     * 代价只是每次按键状态变化重绘一次整屏 —— 一百多个矩形，完全可以接受。
     */
    private _layer!: Graphics;
    private _pressed = new Set<number>();
    private _offsetX = 0;
    private _viewportWidth = 0;
    /**
     * 场景里摆放的位置。本节点是 Canvas 的子节点，原点在屏幕中心，
     * 因此滚动只能在此基准上叠加，不能直接覆写 position。
     */
    private _basePos = new Vec3();

    /** 键位几何。TouchRouter 与力度计算都从这里取。 */
    get layout(): KeyLayout {
        return this._layout;
    }

    protected onLoad(): void {
        this._basePos.set(this.node.position);

        // 视口宽度从父节点（KeyboardArea）取。它在 Canvas 的 __preload 里
        // 已由 Widget 完成对齐，而 __preload 一定早于 onLoad，所以这里拿到的
        // 是屏幕的实际宽度，不是场景里写的占位值。
        const parentTransform = this.node.parent?.getComponent(UITransform);
        if (parentTransform) {
            this._viewportWidth = parentTransform.width;
        }

        this.applyFit();
        this.rebuild();
    }

    /**
     * 按视口宽度定键宽，让 52 个白键恰好铺满。
     *
     * 在 `rebuild()` **之前**调用 —— 键位几何是按 keyWidth 一次性算好的。
     */
    private applyFit(): void {
        if (!this.fitToScreen || this._viewportWidth <= 0) {
            return;
        }
        const fitted = this._viewportWidth / KeyLayout.WHITE_KEY_COUNT;
        if (fitted > 0 && Math.abs(fitted - this.keyWidth) > 0.01) {
            this.keyWidth = fitted;
        }
    }

    /**
     * 按当前 keyWidth / whiteKeyHeight 重建键面。
     * 缩放键盘时调用。
     */
    rebuild(): void {
        this._layout = new KeyLayout({
            keyWidth: this.keyWidth,
            whiteKeyHeight: this.whiteKeyHeight,
        });

        if (!this._layer) {
            this._layer = this.makeLayer('Keyboard');
        }

        this.syncTransform();
        this._pressed.clear();
        this.syncViewport();
        this.redraw();
    }

    /**
     * 把本节点的锚点钉在左下角，尺寸设为键盘全宽。
     *
     * 这样 `UITransform.convertToNodeSpaceAR()` 返回的坐标就**直接等于**
     * KeyLayout 的坐标系（原点在左下角），TouchRouter 不需要再做任何换算。
     * 节点自身的 position.x 则充当横向滚动偏移。
     */
    private syncTransform(): void {
        const transform = this.node.getComponent(UITransform) ?? this.node.addComponent(UITransform);
        transform.setAnchorPoint(0, 0);
        transform.setContentSize(this._layout.totalWidth, this.whiteKeyHeight);
    }

    /** 创建一层 Graphics 子节点 */
    private makeLayer(name: string): Graphics {
        const node = new Node(name);

        // ⚠️ 必须显式设置层。
        //
        // `new Node()` 创建的节点默认落在 `Layers.Enum.DEFAULT`（1<<30），
        // 而 UI 相机的可见层是 `UI_2D | UI_3D` —— **不含 DEFAULT**。
        // 漏掉这一步，节点和它的渲染组件都在场景里正常存在，
        // 但相机根本不会画它，表现为「键盘完全不显示」且没有任何报错。
        //
        // 用父节点的层而不是写死 UI_2D：跟随容器，将来搬动键盘时不会失效。
        node.layer = this.node.layer;

        node.addComponent(UITransform);
        const graphics = node.addComponent(Graphics);
        this.node.addChild(node);
        return graphics;
    }

    /**
     * 视口变化时调用。键盘比视口宽则允许横向滚动，否则居中。
     */
    setViewport(width: number): void {
        this._viewportWidth = width;

        // 视口变了，键宽要跟着重算 —— 横竖屏切换、分屏都会走到这里。
        // 只有键宽真的变了才重建，否则每帧调一次会把绘制层重建到没完。
        const before = this.keyWidth;
        this.applyFit();
        if (Math.abs(this.keyWidth - before) > 0.01) {
            this.rebuild();
            return;
        }

        this.syncViewport();
    }

    private syncViewport(): void {
        if (this._viewportWidth <= 0) {
            return;
        }
        this._offsetX = clampOffset(this._offsetX, this._viewportWidth, this._layout.totalWidth);
        this.applyScroll();
    }

    /** 把滚动偏移叠加到场景摆放位置上 */
    private applyScroll(): void {
        this.node.setPosition(this._basePos.x + this._offsetX, this._basePos.y, this._basePos.z);
    }

    /** 横向滚动。传入的是期望偏移，会自动夹到合法范围。 */
    scrollTo(offsetX: number): void {
        this._offsetX = clampOffset(offsetX, this._viewportWidth, this._layout.totalWidth);
        this.applyScroll();
    }

    /** 当前滚动偏移 */
    get offsetX(): number {
        return this._offsetX;
    }

    /** 让某个音高居中 */
    centerOn(midi: number): void {
        this.scrollTo(this._layout.offsetToCenter(midi, this._viewportWidth));
    }

    /**
     * 手动设置键宽（缩放）。
     *
     * 会**关闭 `fitToScreen`** —— 用户主动缩放之后，就不该再被自动铺满覆盖掉。
     *
     * @param width  期望键宽，会夹到 [MIN_KEY_WIDTH, MAX_KEY_WIDTH]
     * @param anchorRatio 缩放锚点：视口内的相对位置（0=左边缘，0.5=中心，1=右边缘）。
     *        缩放时保持该位置对应的琴键不动 —— 否则画面会自己飘走，手感很差。
     */
    setKeyWidth(width: number, anchorRatio = 0.5): void {
        const clamped = Math.min(MAX_KEY_WIDTH, Math.max(MIN_KEY_WIDTH, width));
        if (Math.abs(clamped - this.keyWidth) < 0.01) {
            return;
        }

        this.fitToScreen = false;

        // 记下锚点处当前对应的「键盘内容坐标」，缩放后让它回到同一屏幕位置
        const anchorRatioClamped = Math.min(1, Math.max(0, anchorRatio));
        const anchorScreenX = this._viewportWidth * anchorRatioClamped;
        const anchorContentX = anchorScreenX - this._offsetX;

        const scale = clamped / this.keyWidth;
        this.keyWidth = clamped;

        this.rebuild();

        this.scrollTo(anchorScreenX - anchorContentX * scale);
    }

    /** 当前是否由用户手动缩放过（即已脱离自动铺满） */
    get manuallyZoomed(): boolean {
        return !this.fitToScreen;
    }

    /** 恢复自动铺满 */
    resetZoom(): void {
        this.fitToScreen = true;
        this.applyFit();
        this.rebuild();
        this.scrollTo(0);
    }

    // ---------------------------------------------------------------- 绘制

    /**
     * 重绘整屏。
     *
     * 每次按键状态变化都整体重绘 —— 单层之下没有别的选择，也确实不需要：
     * 一百多个矩形重绘一次的开销，远小于维护两层之间顺序正确性的代价。
     *
     * ## 绘制顺序（不可调换）
     *
     *   1. 白键（未按下 / 按下各刷一遍）
     *   2. 白键分隔线 —— 必须在黑键**之前**
     *   3. 黑键（未按下 / 按下各刷一遍）
     *
     * 第 2 步的位置是硬约束：黑键**跨在白键的分界线上**，分隔线正好穿过它的
     * 正中间。若画在黑键之后，每个黑键上都会多出一道灰线；画在前面，黑键填色
     * 自然就把该挡住的那段盖住了。
     */
    private redraw(): void {
        const g = this._layer;
        g.clear();

        // 视口裁剪：只画看得见的键
        const [x0, x1] = this.visibleRange();
        const visible = this._layout.getVisibleKeys(x0, x1);

        // 按下的键直接换填充色，而不是在上面叠一层高亮。
        // 单层里没有「叠」这回事，换色天然不会波及压在它上面的黑键 ——
        // 正是这一点让两层方案可以被合掉。
        const down = (key: KeyGeometry): boolean => this._pressed.has(key.midi);

        this.fillKeys(g, visible, (key) => !key.isBlack && !down(key), COLOR_WHITE_KEY);
        this.fillKeys(g, visible, (key) => !key.isBlack && down(key), COLOR_WHITE_PRESSED);

        this.strokeSeparators(g, visible);

        this.fillKeys(g, visible, (key) => key.isBlack && !down(key), COLOR_BLACK_KEY);
        this.fillKeys(g, visible, (key) => key.isBlack && down(key), COLOR_BLACK_PRESSED);
    }

    /**
     * 用同一种颜色填充符合 `pick` 的键。
     *
     * 同色的矩形攒在一条路径里一次 `fill()`，绘制开销与按下的键数无关 ——
     * 逐个 `rect` + `fill` 会让十指按下时多出十次绘制。
     *
     * ## ⚠️ 一个键都没选中时必须直接返回，不能继续走到 `fill()`
     *
     * 这不是省一次空绘制，**是正确性问题**。Cocos 的 `Graphics` 里 `fill()`
     * 只是打一个「已消费」标记，真正推进消费位置的是**下一次 `rect()`** ——
     * `rect()` 的第一件事就是 `moveTo()`，而 `moveTo()` 才会执行
     * `pathOffset = pathLength`：
     *
     * ```js
     * moveTo (x, y) {
     *     if (this.updatePathOffset) { this.pathOffset = this.pathLength; this.updatePathOffset = false; }
     *     ...
     * }
     * fill () { this._expandFill(this); this.impl.updatePathOffset = true; }
     * ```
     *
     * 所以一次「前面没有任何 `rect()`」的 `fill()`，会把**上一次 `fill()` 已经
     * 画过的路径**用新颜色**重刷一遍**。曾经这里没有这个提前返回：开机时按下的
     * 键集为空，两批「按下态」都是零矩形，于是白键被重刷成按下浅蓝、黑键被重刷
     * 成按下深蓝 —— 整块键盘一片蓝，而分隔线是 `stroke()` 画的、刚好在两者之间
     * 消费掉了路径，所以键的轮廓还在。症状是「琴键在，但是蓝的」。
     */
    private fillKeys(
        g: Graphics,
        visible: readonly KeyGeometry[],
        pick: (key: KeyGeometry) => boolean,
        color: Color,
    ): void {
        const whiteTop = this._layout.whiteKeyHeight;

        // 先挑出要画的键。空批次绝不能落到下面的 fill()
        const keys = visible.filter(pick);
        if (keys.length === 0) {
            return;
        }

        g.fillColor = color;
        for (const key of keys) {
            // 黑键从白键顶端往下长，白键则铺满整个高度
            g.rect(key.x, key.isBlack ? whiteTop - key.height : 0, key.width, key.height);
        }
        g.fill();
    }

    /**
     * 白键分隔线。
     *
     * 只给白键画 —— 黑键靠明度对比就已经分得开，再描边会显得脏。
     *
     * ## 为什么画竖线而不是描整圈矩形
     *
     * 描整圈会在白键顶部也画一道横线，而那里正是黑键所在的位置 ——
     * 结果黑键顶上被切出一条灰线，像是没画完整。分隔线只需要表达
     * 「相邻两键的边界」，那就是一条竖线，不需要整圈。
     */
    private strokeSeparators(g: Graphics, visible: readonly KeyGeometry[]): void {
        if (this.whiteKeyOutlineWidth <= 0) {
            return;   // 允许关掉
        }

        g.strokeColor = this.whiteKeyOutlineColor;
        g.lineWidth = this.whiteKeyOutlineWidth;

        // 每条边界画两次（左键的右边 + 右键的左边），画在同一位置，视觉上无差别
        for (const key of visible) {
            if (key.isBlack) {
                continue;
            }
            g.moveTo(key.x, 0);
            g.lineTo(key.x, key.height);
            g.moveTo(key.x + key.width, 0);
            g.lineTo(key.x + key.width, key.height);
        }
        g.stroke();
    }

    /**
     * 当前视口对应的键盘内容坐标范围（左右各留一个键宽余量）。
     *
     * 基础层与按下层都要用它做裁剪，抽出来避免两处各算一遍、算得不一致。
     */
    private visibleRange(): [number, number] {
        const x0 = -this._offsetX - this.keyWidth;
        return [x0, x0 + this._viewportWidth + this.keyWidth * 2];
    }

    // ---------------------------------------------------------------- 按下状态

    /** 设置某个键的按下状态。状态未变化时不会重绘。 */
    setPressed(midi: number, pressed: boolean): void {
        const changed = pressed ? !this._pressed.has(midi) : this._pressed.has(midi);
        if (!changed) {
            return;
        }
        if (pressed) {
            this._pressed.add(midi);
        } else {
            this._pressed.delete(midi);
        }
        this.redraw();
    }

    /** 清空全部按下状态（如触摸被系统中断时）。 */
    clearPressed(): void {
        if (this._pressed.size === 0) {
            return;
        }
        this._pressed.clear();
        this.redraw();
    }

    /** 当前按下的键（只读） */
    get pressedKeys(): ReadonlySet<number> {
        return this._pressed;
    }
}
