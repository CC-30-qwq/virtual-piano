import { _decorator, Component, Graphics, Color, UITransform } from 'cc';

const { ccclass, property } = _decorator;

/**
 * 场景背景。
 *
 * 用 Graphics 画一条竖直渐变铺满整屏，**不依赖任何图片资源** ——
 * 工程目前没有任何美术素材，引入一张背景图反而要多维护一个资源
 * 和它的导入设置。渐变带数够多时肉眼看不出分带。
 *
 * 挂在一个由 Widget 拉伸至全屏的节点上。
 */
@ccclass('SceneBackground')
export class SceneBackground extends Component {
    @property({ tooltip: '顶部颜色（远离键盘的一侧）' })
    topColor = new Color(18, 20, 26, 255);

    @property({ tooltip: '底部颜色（键盘一侧）' })
    bottomColor = new Color(38, 42, 52, 255);

    @property({ tooltip: '渐变分带数。带数越多越平滑，但顶点也越多' })
    bands = 48;

    private _graphics: Graphics | null = null;

    protected onLoad(): void {
        this._graphics = this.node.getComponent(Graphics) ?? this.node.addComponent(Graphics);
        this.redraw();
    }

    /** 重绘。节点尺寸变化时（如屏幕旋转）需要调用 */
    redraw(): void {
        const graphics = this._graphics;
        const transform = this.node.getComponent(UITransform);
        if (!graphics || !transform) {
            return;
        }

        graphics.clear();

        const width = transform.width;
        const height = transform.height;
        if (width <= 0 || height <= 0) {
            return;
        }

        // 节点锚点在中点时，左下角在 (-w/2, -h/2)
        const anchor = transform.anchorPoint;
        const left = -width * anchor.x;
        const bottom = -height * anchor.y;

        const count = Math.max(2, Math.floor(this.bands));
        const bandHeight = height / count;

        for (let i = 0; i < count; i++) {
            // 从上往下插值：i=0 是顶部
            const t = i / (count - 1);
            graphics.fillColor = lerpColor(this.topColor, this.bottomColor, t);
            // 多画一行像素，避免相邻带之间因为浮点取整露出缝隙
            graphics.rect(left, bottom + height - (i + 1) * bandHeight,
                          width, bandHeight + 1);
            graphics.fill();
        }
    }
}

/** 在两端颜色之间线性插值 */
function lerpColor(a: Color, b: Color, t: number): Color {
    const k = t < 0 ? 0 : t > 1 ? 1 : t;
    return new Color(
        Math.round(a.r + (b.r - a.r) * k),
        Math.round(a.g + (b.g - a.g) * k),
        Math.round(a.b + (b.b - a.b) * k),
        Math.round(a.a + (b.a - a.a) * k),
    );
}
