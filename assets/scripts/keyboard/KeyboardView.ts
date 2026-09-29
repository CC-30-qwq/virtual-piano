import { _decorator, Component, Node, Graphics, Color, UITransform, Vec3 } from 'cc';
import { KeyGeometry } from './KeyLayout';
import { KeyboardState, KeyboardStateListener } from './KeyboardState';
import { KeyboardViewport, ViewportListener } from './KeyboardViewport';

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

/**
 * 88 键横屏键盘 —— 渲染。
 *
 * 对应 M3-2。**只负责画**：键位几何、滚动偏移、缩放都在 `KeyboardViewport` 里，
 * 命中测试与力度在 `TouchRouter` 里。
 *
 * 视口状态一变，视口类会回调 `onViewportChanged()`，那是「状态 → 画面」的唯一入口。
 * 手势与外部代码改视口时不需要知道本组件要怎么动节点。
 *
 * ## 绘制方式
 *
 * 用 Graphics 批量绘制而不是每键一个 Sprite 节点 —— 后者是 88 个节点
 * 外加 88 个 UITransform，DrawCall 与遍历开销都不可接受（见方案 §7.3）。
 *
 * 整屏在**一个** Graphics 里画（为什么不是两层，见 `_layer` 的说明）。
 */
@ccclass('KeyboardView')
export class KeyboardView extends Component implements ViewportListener, KeyboardStateListener {
    /**
     * 初始白键宽度（pt）。
     *
     * ⚠️ 这只是**构造视口时的输入**：`fitToScreen` 为真时会被按视口宽度覆盖，
     * 用户捏合缩放后也会变。**当前生效的键宽要读 `viewport.keyWidth`** ——
     * 这个属性保留是为了能在编辑器里改初值，它不是权威值。
     */
    @property({ tooltip: '初始白键宽度（pt）。实际生效值见运行时 viewport.keyWidth' })
    keyWidth = 40;

    @property({ tooltip: '白键高度（pt）' })
    whiteKeyHeight = 180;

    /**
     * 是否让 88 键恰好铺满屏幕宽度。
     *
     * 设计分辨率 1280 宽时，每个白键约 24.6pt —— 偏窄但能一屏弹完整个音域。
     * 这是默认方案；用户捏合缩放或双击复位会改变它。
     */
    @property({ tooltip: '初始让 88 键恰好铺满屏幕宽度' })
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

    private _viewport!: KeyboardViewport;

    /**
     * 按下状态。**输入层写，这里只读**。
     *
     * 本组件订阅它来触发重绘，而不是让 TouchRouter 反过来调 `setPressed` ——
     * 那样输入层就得知道「按下要去改哪个渲染组件」。
     */
    private _state = new KeyboardState();

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
    /**
     * 场景里摆放的位置。本节点是 Canvas 的子节点，原点在屏幕中心，
     * 因此滚动只能在此基准上叠加，不能直接覆写 position。
     */
    private _basePos = new Vec3();

    /** 视口状态机。`viewport.layout` 是绘制与命中测试共用的几何来源 */
    get viewport(): KeyboardViewport {
        return this._viewport;
    }

    /** 按下状态。输入层（TouchRouter）需要它来写入 */
    get state(): KeyboardState {
        return this._state;
    }

    protected onLoad(): void {
        this._basePos.set(this.node.position);
        this._state.listener = this;

        // 视口宽度从父节点（KeyboardArea）取。它在 Canvas 的 __preload 里
        // 已由 Widget 完成对齐，而 __preload 一定早于 onLoad，所以这里拿到的
        // 是屏幕的实际宽度，不是场景里写的占位值。
        const parentTransform = this.node.parent?.getComponent(UITransform);
        const viewportWidth = parentTransform ? parentTransform.width : 0;

        this._viewport = new KeyboardViewport({
            viewportWidth,
            keyWidth: this.keyWidth,
            whiteKeyHeight: this.whiteKeyHeight,
            fitToScreen: this.fitToScreen,
        });
        this._viewport.listener = this;

        this._layer = this.makeLayer('Keyboard');
        this.onViewportChanged(true);
    }

    /**
     * 视口状态变化 —— 全组件唯一的「状态 → 画面」入口。
     *
     * 偏移变化也必须重画：绘制按视口裁剪（`visibleRange`），偏移一变，
     * 裁剪窗口里的键就换了。少画这一笔的症状是「拖动后一片空白，按一下才出现」。
     */
    onViewportChanged(geometryChanged: boolean): void {
        if (geometryChanged) {
            this.syncTransform();
            // 几何变了，旧的按下高亮不再对应正确的键位
            this._state.clear();
        }
        this.applyScroll();
        this.redraw();
    }

    /**
     * 按下状态变了 —— 重绘。
     *
     * 状态机只在**真的变了**的时候通知（同一根手指在同一个键上滑来滑去
     * 会连着来十几次 touchMove），所以这里不用再做去重。
     */
    onPressedChanged(): void {
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
        transform.setContentSize(this._viewport.totalWidth, this._viewport.whiteKeyHeight);
    }

    /** 把滚动偏移叠加到场景摆放位置上 */
    private applyScroll(): void {
        this.node.setPosition(this._basePos.x + this._viewport.offsetX, this._basePos.y, this._basePos.z);
    }

    /** 创建绘制层 Graphics 子节点 */
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

    // ---------------------------------------------------------------- 绘制

    /**
     * 重绘整屏。
     *
     * 每次按键状态或视口变化都整体重绘 —— 单层之下没有别的选择，也确实不需要：
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

        const layout = this._viewport.layout;

        // 视口裁剪：只画看得见的键
        const [x0, x1] = this._viewport.visibleRange();
        const visible = layout.getVisibleKeys(x0, x1);

        // 按下的键直接换填充色，而不是在上面叠一层高亮。
        // 单层里没有「叠」这回事，换色天然不会波及压在它上面的黑键 ——
        // 正是这一点让两层方案可以被合掉。
        const down = (key: KeyGeometry): boolean => this._state.has(key.midi);

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
        const whiteTop = this._viewport.whiteKeyHeight;

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

}
