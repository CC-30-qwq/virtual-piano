/**
 * 88 键横屏键盘 —— 键位几何计算
 *
 * 纯计算，不依赖任何 Cocos API，便于单独验证与复用。
 * 对应《横屏高仿真钢琴落地实施方案》M3-1。
 *
 * ## 坐标系约定
 *
 * 键盘局部坐标系，原点在白键**左下角**，y 轴向上（与 Cocos UI 一致）：
 *
 *     y = whiteHeight ┌───────┬──┬───────┐
 *                     │       │██│       │   ← 黑键只占上部
 *     y = whiteHeight │       │██│       │
 *                     │       └──┘       │
 *                     │                  │
 *     y = 0           └──────────────────┘
 *                     x = 0        x = totalWidth
 *
 * 命中测试传入的 y 必须是**相对键盘底边**的值，由调用方减去容器 y 得到。
 */

/** 最低音 A0 */
export const LOWEST_MIDI = 21;
/** 最高音 C8 */
export const HIGHEST_MIDI = 108;
/** 键盘总键数 */
export const KEY_COUNT = HIGHEST_MIDI - LOWEST_MIDI + 1; // 88

/**
 * 每个八度内白键的序号；黑键为 -1。
 * 索引即音级（pitch class）：C=0, C#=1, D=2 … B=11
 */
const WHITE_INDEX_IN_OCTAVE = [0, -1, 1, -1, 2, 3, -1, 4, -1, 5, -1, 6];

/** 真实三角钢琴的比值：白键 23.5mm、黑键 13.7mm */
const BLACK_WIDTH_RATIO = 0.583;
/** 黑键长度约为白键的 0.62 */
const BLACK_HEIGHT_RATIO = 0.62;

/**
 * 黑键**命中区**的宽度倍率。
 *
 * 黑键画出来只有白键的 0.583 倍宽（真实钢琴的比例），在 24.6pt 的键宽下
 * 只有约 14pt —— 远小于手指的接触面积，按下去经常落到旁边的白键上。
 *
 * 所以命中区要放宽，但**画的时候不动**：把黑键画胖会一眼看出不像真钢琴，
 * 而放宽命中区用户感觉不到，只觉得"好按了"。
 *
 * 1.4 倍是安全的：相邻黑键（如 C# 与 D#）的中心相隔整整一个白键宽，
 * 放宽到 0.816 个白键宽后仍不会互相重叠。
 */
const BLACK_HIT_WIDTH_RATIO = 1.4;

/** 单个琴键的几何信息（不可变） */
export interface KeyGeometry {
    /** MIDI 音高 21..108 */
    readonly midi: number;
    /** 是否黑键 */
    readonly isBlack: boolean;
    /** 左边缘 x */
    readonly x: number;
    /** 宽度 */
    readonly width: number;
    /** 高度（黑键比白键短） */
    readonly height: number;
    /** 白键序号 0..51；黑键为 -1 */
    readonly whiteIndex: number;
}

/** 构造参数 */
export interface KeyLayoutOptions {
    /** 白键宽度，单位 pt。手机横屏建议 22–48，平板一屏 88 键时约 26 */
    keyWidth: number;
    /** 白键高度 */
    whiteKeyHeight: number;
}

export class KeyLayout {
    /** 白键总数：52 */
    static readonly WHITE_KEY_COUNT = 52;
    /** 黑键总数：36 */
    static readonly BLACK_KEY_COUNT = 36;

    private readonly _keyWidth: number;
    private readonly _whiteHeight: number;
    private readonly _blackWidth: number;
    private readonly _blackHeight: number;
    private readonly _byMidi: KeyGeometry[] = [];
    private readonly _whites: KeyGeometry[] = [];
    private readonly _blacks: KeyGeometry[] = [];

    constructor(options: KeyLayoutOptions) {
        const { keyWidth, whiteKeyHeight } = options;
        if (!(keyWidth > 0) || !(whiteKeyHeight > 0)) {
            throw new Error(`KeyLayout: 尺寸必须为正数，收到 ${keyWidth}x${whiteKeyHeight}`);
        }

        this._keyWidth = keyWidth;
        this._whiteHeight = whiteKeyHeight;
        this._blackWidth = keyWidth * BLACK_WIDTH_RATIO;
        this._blackHeight = whiteKeyHeight * BLACK_HEIGHT_RATIO;

        this.buildKeys();
    }

    /**
     * 一次遍历同时生成白键与黑键。
     *
     * 黑键的「左侧白键序号」直接取遍历到当前位置时的 `whiteIndex - 1` ——
     * 因为我们是升序扫描，此刻最近的一个白键必然是它左边那个。
     * 这比按音级硬编码映射表更不容易出错。
     */
    private buildKeys(): void {
        let whiteIndex = 0;

        for (let midi = LOWEST_MIDI; midi <= HIGHEST_MIDI; midi++) {
            const pitchClass = midi % 12;

            if (WHITE_INDEX_IN_OCTAVE[pitchClass] >= 0) {
                const key: KeyGeometry = {
                    midi,
                    isBlack: false,
                    x: whiteIndex * this._keyWidth,
                    width: this._keyWidth,
                    height: this._whiteHeight,
                    whiteIndex,
                };
                this._whites.push(key);
                this._byMidi[midi] = key;
                whiteIndex++;
            } else {
                // 黑键中心对准相邻白键的分界线，左右各压一半
                const leftWhiteIndex = whiteIndex - 1;
                const key: KeyGeometry = {
                    midi,
                    isBlack: true,
                    x: (leftWhiteIndex + 1) * this._keyWidth - this._blackWidth * 0.5,
                    width: this._blackWidth,
                    height: this._blackHeight,
                    whiteIndex: -1,
                };
                this._blacks.push(key);
                this._byMidi[midi] = key;
            }
        }
    }

    /** 白键宽度 */
    get keyWidth(): number {
        return this._keyWidth;
    }

    /** 白键高度 */
    get whiteKeyHeight(): number {
        return this._whiteHeight;
    }

    /** 黑键高度 */
    get blackKeyHeight(): number {
        return this._blackHeight;
    }

    /** 键盘总宽 = 52 × 白键宽 */
    get totalWidth(): number {
        return KeyLayout.WHITE_KEY_COUNT * this._keyWidth;
    }

    /** 全部白键（按 MIDI 升序） */
    get whites(): readonly KeyGeometry[] {
        return this._whites;
    }

    /** 全部黑键（按 MIDI 升序） */
    get blacks(): readonly KeyGeometry[] {
        return this._blacks;
    }

    /** 取某个音的几何信息；越界返回 null */
    getKey(midi: number): KeyGeometry | null {
        return this._byMidi[midi] ?? null;
    }

    /**
     * 命中测试。
     *
     * **黑键优先** —— 黑键绘制在白键之上，且实际弹奏时手指落在黑键区域
     * 就应该触发黑键。这一点如果反过来，会导致靠近黑键的白键极难按准。
     *
     * @param x 相对键盘左边缘
     * @param y 相对键盘底边
     * @returns 命中的 MIDI 音高；未命中返回 null
     */
    hitTest(x: number, y: number): number | null {
        if (y < 0 || y > this._whiteHeight || x < 0 || x > this.totalWidth) {
            return null;
        }

        // 黑键：只在黑键高度范围内有效。
        // 命中区比画出来的宽（见 BLACK_HIT_WIDTH_RATIO），左右各外扩一半，
        // 中心与绘制位置对齐 —— 所以「看起来在哪」和「按到哪个」不会错位。
        if (y > this._whiteHeight - this._blackHeight) {
            const halfHit = this._blackWidth * BLACK_HIT_WIDTH_RATIO * 0.5;
            for (let i = 0; i < this._blacks.length; i++) {
                const key = this._blacks[i];
                const center = key.x + key.width * 0.5;
                if (x >= center - halfHit && x < center + halfHit) {
                    return key.midi;
                }
            }
        }

        // 白键：按宽度均分，直接算下标，不必遍历
        const index = Math.floor(x / this._keyWidth);
        if (index < 0 || index >= this._whites.length) {
            return null;
        }
        return this._whites[index].midi;
    }

    /**
     * 取出与 [x0, x1) 区间有交叠的琴键，用于视口裁剪。
     *
     * 返回顺序为「白键在前、黑键在后」，正好是绘制顺序 ——
     * 黑键后画才能压在白键之上。
     */
    getVisibleKeys(x0: number, x1: number): KeyGeometry[] {
        const result: KeyGeometry[] = [];

        for (let i = 0; i < this._whites.length; i++) {
            const key = this._whites[i];
            if (key.x + key.width > x0 && key.x < x1) {
                result.push(key);
            }
        }
        for (let i = 0; i < this._blacks.length; i++) {
            const key = this._blacks[i];
            if (key.x + key.width > x0 && key.x < x1) {
                result.push(key);
            }
        }

        return result;
    }

    /**
     * 让指定音高居中所需的横向偏移量（传给容器节点的 x）。
     *
     * 返回值为负表示向左推。会自动夹在 [viewportWidth - totalWidth, 0] 之间，
     * 避免把键盘拖出屏幕外。
     */
    offsetToCenter(midi: number, viewportWidth: number): number {
        const key = this.getKey(midi);
        if (!key) {
            return 0;
        }
        const desired = viewportWidth * 0.5 - (key.x + key.width * 0.5);
        return clampOffset(desired, viewportWidth, this.totalWidth);
    }
}

/**
 * 把滚动偏移夹到合法范围。
 *
 * 键盘比视口窄时（平板一屏放得下 88 键）直接固定为居中。
 */
export function clampOffset(offset: number, viewportWidth: number, totalWidth: number): number {
    if (totalWidth <= viewportWidth) {
        return (viewportWidth - totalWidth) * 0.5;
    }
    const min = viewportWidth - totalWidth;
    return Math.min(0, Math.max(min, offset));
}
