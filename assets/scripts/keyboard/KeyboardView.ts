import { _decorator, Component, Node, Graphics, Color, UITransform, Vec3 } from 'cc';
import { KeyLayout, KeyGeometry, clampOffset } from './KeyLayout';

const { ccclass, property } = _decorator;

/** 键面配色 */
const COLOR_WHITE_KEY = new Color(250, 250, 248, 255);
const COLOR_BLACK_KEY = new Color(28, 28, 32, 255);
/** 按下的白键：淡蓝灰，模拟琴键下沉的反光变化 */
const COLOR_WHITE_PRESSED = new Color(168, 200, 232, 255);
const COLOR_BLACK_PRESSED = new Color(72, 108, 152, 255);
/** 键缝 */
const COLOR_SEPARATOR = new Color(140, 140, 145, 255);

/**
 * 88 键横屏键盘 —— 渲染与状态。
 *
 * 对应 M3-2。命中测试与力度计算不在这里（见 TouchRouter），
 * 本组件只负责「把一个 KeyLayout 画出来」和「记录哪些键是按下的」。
 *
 * ## 为什么要分两层 Graphics
 *
 * 88 个键若每次按下都整体重绘，一次触键就要重建上百个矩形。这里拆成：
 *   - `_baseLayer`    静态键面，只在尺寸变化时重绘
 *   - `_pressLayer`   只画按下的键，每次按键变化重绘（通常 0–10 个矩形）
 *
 * 另外用 Graphics 批量绘制而不是每键一个 Sprite 节点 —— 后者是 88 个节点
 * 外加 88 个 UITransform，DrawCall 与遍历开销都不可接受（见方案 §7.3）。
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

    private _layout!: KeyLayout;
    private _baseLayer!: Graphics;
    private _pressLayer!: Graphics;
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

        if (!this._baseLayer) {
            this._baseLayer = this.makeLayer('BaseLayer');
            this._pressLayer = this.makeLayer('PressLayer');
        }

        this.syncTransform();
        this._pressed.clear();
        this.syncViewport();
        this.drawBase();
        this.drawPress();
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

    // ---------------------------------------------------------------- 绘制

    private drawBase(): void {
        const g = this._baseLayer;
        g.clear();

        // 视口裁剪：只画看得见的键
        const x0 = -this._offsetX - this.keyWidth;
        const x1 = x0 + this._viewportWidth + this.keyWidth * 2;
        const visible = this._layout.getVisibleKeys(x0, x1);

        // 白键先画
        g.fillColor = COLOR_WHITE_KEY;
        for (const key of visible) {
            if (!key.isBlack) {
                g.rect(key.x, 0, key.width, key.height);
            }
        }
        g.fill();

        // 黑键后画，压在白键之上
        g.fillColor = COLOR_BLACK_KEY;
        for (const key of visible) {
            if (key.isBlack) {
                g.rect(key.x, this._layout.whiteKeyHeight - key.height, key.width, key.height);
            }
        }
        g.fill();

        this.strokeSeparators(g, visible);
    }

    /**
     * 键缝。
     *
     * 只给白键描边 —— 黑键本身就靠明度对比区分，再描边会显得脏。
     */
    private strokeSeparators(g: Graphics, visible: readonly KeyGeometry[]): void {
        g.strokeColor = COLOR_SEPARATOR;
        g.lineWidth = 1;
        for (const key of visible) {
            if (key.isBlack) {
                continue;
            }
            g.rect(key.x, 0, key.width, key.height);
        }
        g.stroke();
    }

    private drawPress(): void {
        const g = this._pressLayer;
        g.clear();
        if (this._pressed.size === 0) {
            return;
        }

        const whiteTop = this._layout.whiteKeyHeight;

        // 白键高亮
        g.fillColor = COLOR_WHITE_PRESSED;
        for (const midi of this._pressed) {
            const key = this._layout.getKey(midi);
            if (key && !key.isBlack) {
                g.rect(key.x, 0, key.width, key.height);
            }
        }
        g.fill();

        // 黑键高亮（覆盖在白键高亮之上）
        g.fillColor = COLOR_BLACK_PRESSED;
        for (const midi of this._pressed) {
            const key = this._layout.getKey(midi);
            if (key && key.isBlack) {
                g.rect(key.x, whiteTop - key.height, key.width, key.height);
            }
        }
        g.fill();
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
        this.drawPress();
    }

    /** 清空全部按下状态（如触摸被系统中断时）。 */
    clearPressed(): void {
        if (this._pressed.size === 0) {
            return;
        }
        this._pressed.clear();
        this.drawPress();
    }

    /** 当前按下的键（只读） */
    get pressedKeys(): ReadonlySet<number> {
        return this._pressed;
    }
}
