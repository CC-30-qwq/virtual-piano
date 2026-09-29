import { KeyLayout, clampOffset } from './KeyLayout';

/** 键宽下限。低于此值手指按不准，再小就没有意义 */
export const MIN_KEY_WIDTH = 22;
/** 键宽上限。再宽就看不清整体音域了 */
export const MAX_KEY_WIDTH = 48;

/** 尺寸比较容差。小于它的变化视为没变，避免反复重建 */
const EPS = 0.01;

/**
 * 视口状态变化的通知口。
 *
 * 由视图实现。手势与其它调用方只管改视口状态，**不需要知道**视图节点要怎么动 ——
 * 这正是把状态机抽出来的目的：手势不再直接操作渲染。
 */
export interface ViewportListener {
    /**
     * @param geometryChanged 键位几何是否已重建（键宽或键高变了）。
     *        真 → 视图需要重算节点尺寸并重画整屏；
     *        假 → 只有滚动偏移变了，但**也必须重画**：绘制做了视口裁剪，
     *              偏移一变，裁剪窗口里的键就换了（见 `visibleRange`）。
     */
    onViewportChanged(geometryChanged: boolean): void;
}

export interface ViewportOptions {
    /** 视口宽度（pt），即键盘容器的宽度 */
    viewportWidth: number;
    /** 期望白键宽度（pt）。`fitToScreen` 为真时会按视口宽度覆盖它 */
    keyWidth: number;
    /** 白键高度（pt） */
    whiteKeyHeight: number;
    /** 是否让 52 个白键恰好铺满视口宽度 */
    fitToScreen: boolean;
}

/**
 * 键盘的视口状态机 —— 键宽、滚动偏移、缩放与夹紧。
 *
 * ## 为什么从 KeyboardView 里抽出来
 *
 * 之前这些数学与 `Graphics` 绘制、节点变换混在一个组件里，于是最该被验证的
 * 那段（捏合缩放要「捏哪放大哪」，即缩放前后锚点处的琴键必须停在同一屏幕位置）
 * 只能靠人眼在编辑器里看。
 *
 * 本类**不 import 任何 `cc` 模块**，是一段纯计算，可以在宿主机上直接跑
 * （见 tests/viewport.test.js）。视图只剩「按 `layout` 把键画出来」。
 *
 * ## 坐标系
 *
 * 与 `KeyLayout` 一致：原点在键盘白键左下角。`offsetX` 是键盘相对视口左边缘的
 * 偏移（0 表示对齐左边缘；键盘比视口窄时会被夹成居中值）。
 */
export class KeyboardViewport {
    private _viewportWidth: number;
    private _keyWidth: number;
    private readonly _whiteKeyHeight: number;
    private _fitToScreen: boolean;
    private _offsetX = 0;
    private _layout: KeyLayout;
    private _listener: ViewportListener | null = null;

    constructor(options: ViewportOptions) {
        if (!(options.whiteKeyHeight > 0)) {
            throw new Error(`KeyboardViewport: 键高必须为正数，收到 ${options.whiteKeyHeight}`);
        }
        if (!(options.keyWidth > 0)) {
            throw new Error(`KeyboardViewport: 键宽必须为正数，收到 ${options.keyWidth}`);
        }

        this._viewportWidth = Math.max(0, options.viewportWidth);
        this._whiteKeyHeight = options.whiteKeyHeight;
        this._fitToScreen = options.fitToScreen;
        this._keyWidth = options.keyWidth;

        this.applyFit();
        this._layout = new KeyLayout({
            keyWidth: this._keyWidth,
            whiteKeyHeight: this._whiteKeyHeight,
        });
        this.clampOffsetNow();
    }

    set listener(value: ViewportListener | null) {
        this._listener = value;
    }

    // ---------------------------------------------------------------- 读取

    /** 当前键位几何。绘制、命中测试都从这里取 */
    get layout(): KeyLayout {
        return this._layout;
    }

    /** 白键宽度（pt） */
    get keyWidth(): number {
        return this._keyWidth;
    }

    /** 白键高度（pt） */
    get whiteKeyHeight(): number {
        return this._whiteKeyHeight;
    }

    /** 视口宽度（pt） */
    get viewportWidth(): number {
        return this._viewportWidth;
    }

    /** 键盘相对视口左边缘的偏移 */
    get offsetX(): number {
        return this._offsetX;
    }

    /** 键盘总宽 */
    get totalWidth(): number {
        return this._layout.totalWidth;
    }

    /** 是否已由用户手动缩放（即已脱离自动铺满） */
    get manuallyZoomed(): boolean {
        return !this._fitToScreen;
    }

    // ---------------------------------------------------------------- 变更

    /**
     * 视口尺寸变化时调用（横竖屏切换、分屏、窗口缩放）。
     */
    setViewportWidth(width: number): void {
        const next = Math.max(0, width);
        if (next === this._viewportWidth) {
            return;
        }
        this._viewportWidth = next;

        const before = this._keyWidth;
        this.applyFit();
        this.rebuild();

        // 键宽没变时几何是原样重建的，只有夹紧结果可能变了
        this.notify(Math.abs(this._keyWidth - before) > EPS);
    }

    /**
     * 横向滚动。传入的是期望偏移，会自动夹到合法范围。
     */
    scrollTo(offsetX: number): void {
        const next = clampOffset(offsetX, this._viewportWidth, this._layout.totalWidth);
        if (next === this._offsetX) {
            return;
        }
        this._offsetX = next;
        this.notify(false);
    }

    /** 相对滚动。手势用这个，省得调用方自己去读 offsetX 再相加 */
    scrollBy(deltaX: number): void {
        this.scrollTo(this._offsetX + deltaX);
    }

    /** 让某个音高居中 */
    centerOn(midi: number): void {
        this.scrollTo(this._layout.offsetToCenter(midi, this._viewportWidth));
    }

    /**
     * 手动设置键宽（缩放）。
     *
     * 会**关闭自动铺满** —— 用户主动缩放之后，就不该再被自动铺满覆盖掉。
     *
     * @param width  期望键宽，会夹到 [MIN_KEY_WIDTH, MAX_KEY_WIDTH]
     * @param anchorRatio 缩放锚点：视口内的相对位置（0=左边缘，0.5=中心，1=右边缘）。
     *        缩放时保持该位置对应的琴键不动 —— 否则画面会自己飘走，手感很差。
     */
    setKeyWidth(width: number, anchorRatio = 0.5): void {
        const clamped = Math.min(MAX_KEY_WIDTH, Math.max(MIN_KEY_WIDTH, width));
        if (Math.abs(clamped - this._keyWidth) < EPS) {
            // 已经顶到限位：不重建，也不解除自动铺满（否则用户捏一下就把铺满关掉了）
            return;
        }

        // 记下锚点处当前对应的「键盘内容坐标」，缩放后让它回到同一屏幕位置
        const ratio = Math.min(1, Math.max(0, anchorRatio));
        const anchorScreenX = this._viewportWidth * ratio;
        const anchorContentX = anchorScreenX - this._offsetX;

        const scale = clamped / this._keyWidth;
        this._keyWidth = clamped;
        this._fitToScreen = false;
        this.rebuild();

        this._offsetX = clampOffset(
            anchorScreenX - anchorContentX * scale,
            this._viewportWidth,
            this._layout.totalWidth,
        );
        this.notify(true);
    }

    /** 恢复自动铺满 */
    resetZoom(): void {
        this._fitToScreen = true;
        this.applyFit();
        this.rebuild();
        this._offsetX = clampOffset(0, this._viewportWidth, this._layout.totalWidth);
        this.notify(true);
    }

    // ---------------------------------------------------------------- 派生

    /**
     * 当前视口对应的键盘内容坐标范围（左右各留一个键宽余量）。
     *
     * 绘制裁剪用。**偏移一变就必须重画** —— 否则滚动后新进入视口的键不存在，
     * 表现为「拖动后一片空白，按一下才出现」。
     */
    visibleRange(): [number, number] {
        const x0 = -this._offsetX - this._keyWidth;
        return [x0, x0 + this._viewportWidth + this._keyWidth * 2];
    }

    // ---------------------------------------------------------------- 内部

    /** 按视口宽度定键宽，让 52 个白键恰好铺满 */
    private applyFit(): void {
        if (!this._fitToScreen || this._viewportWidth <= 0) {
            return;
        }
        this._keyWidth = this._viewportWidth / KeyLayout.WHITE_KEY_COUNT;
    }

    /** 按当前键宽/键高重建几何，并把偏移重新夹紧 */
    private rebuild(): void {
        this._layout = new KeyLayout({
            keyWidth: this._keyWidth,
            whiteKeyHeight: this._whiteKeyHeight,
        });
        this.clampOffsetNow();
    }

    private clampOffsetNow(): void {
        this._offsetX = clampOffset(this._offsetX, this._viewportWidth, this._layout.totalWidth);
    }

    private notify(geometryChanged: boolean): void {
        this._listener?.onViewportChanged(geometryChanged);
    }
}
