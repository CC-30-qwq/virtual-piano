/**
 * 键盘的按下状态。
 *
 * ## 为什么单独存在
 *
 * 「哪些键当前被按下」原本是 `KeyboardView` 的内部字段，而写入它的却是
 * `TouchRouter` —— 输入层直接伸手进渲染组件改状态，于是两边都得知道对方。
 *
 * 抽出来之后各司其职：**输入写、渲染读**，两边都只认这个对象。
 * 它不 import 任何 `cc` 模块，所以可以在宿主机上直接验证。
 */
export interface KeyboardStateListener {
    /** 按下状态变了。视图据此重绘（只给信号，不给细节 —— 视图本来就是整屏重绘） */
    onPressedChanged(): void;
}

export class KeyboardState {
    private _pressed = new Set<number>();
    private _listener: KeyboardStateListener | null = null;

    set listener(value: KeyboardStateListener | null) {
        this._listener = value;
    }

    /**
     * 设置某个键的按下状态。
     *
     * @returns 状态是否真的变了。**状态没变时不会通知** —— 滑奏过程中
     *          同一根手指会在同一个键上连着来十几次 `touchMove`，
     *          每次都重绘整屏会很浪费。
     */
    set(midi: number, pressed: boolean): boolean {
        const changed = pressed ? !this._pressed.has(midi) : this._pressed.has(midi);
        if (!changed) {
            return false;
        }
        if (pressed) {
            this._pressed.add(midi);
        } else {
            this._pressed.delete(midi);
        }
        this._listener?.onPressedChanged();
        return true;
    }

    /** 清空全部按下状态（触摸被系统中断、切后台等）。状态本来为空时不通知 */
    clear(): void {
        if (this._pressed.size === 0) {
            return;
        }
        this._pressed.clear();
        this._listener?.onPressedChanged();
    }

    has(midi: number): boolean {
        return this._pressed.has(midi);
    }

    /** 当前按下的键（只读） */
    get pressed(): ReadonlySet<number> {
        return this._pressed;
    }

    /** 当前按下的键数 */
    get size(): number {
        return this._pressed.size;
    }
}
