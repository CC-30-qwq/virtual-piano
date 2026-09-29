import { Canvas, Color, Label, Node, UITransform, Vec3 } from 'cc';
import { BackendDiagnostics, LOAD_DONE, LOAD_FAILED } from '../audio/AudioBackend';

/**
 * 左上角调试读数。
 *
 * ## 为什么从 PianoController 里搬出来
 *
 * 读数在控制器里原本占约 95 行：建节点、设锚点与字号、逐行拼字符串。
 * 它与「接键盘、接路由、控音频」是两件不相干的事 —— 混在一起的结果是
 * 控制器的编排逻辑没法脱离 Cocos UI 去看，而改一行读数文案也要动编排代码。
 *
 * 现在分工是：控制器**采集**一个结构化快照（`HudSnapshot`），本类只负责**呈现**。
 * 读数不再直接读引擎/路由的成员，于是「显示什么」与「从哪儿取」也分开了。
 *
 * ## 为什么是个普通类而不是 Component
 *
 * 它挂在 Canvas 上（不是键盘容器上 —— 那只有 180 高，读数会被挤在那一条里，
 * 而且键盘滚动时还会跟着动），而 Canvas 是场景里既有的节点。做成 Component
 * 反而要先往 Canvas 上挂组件；普通类 + `attach()` 更直接。
 */
export class DebugHud {
    private _label: Label | null = null;

    /**
     * 从某个节点沿父链向上找到 Canvas 并挂上读数。
     *
     * 找不到 Canvas 时返回 null —— 调用方据此关掉读数，而不是抛错：
     * 场景缺 Canvas 是配置问题，不该让整个控制器起不来。
     */
    static attach(from: Node): DebugHud | null {
        const canvas = findCanvas(from);
        if (!canvas) {
            return null;
        }

        const hud = new DebugHud();
        hud.build(canvas);
        return hud;
    }

    private build(canvas: Node): void {
        const node = new Node('DebugHud');

        // ⚠️ 必须显式设层。运行时 `new Node()` 创建的节点默认落在
        // `Layers.Enum.DEFAULT`，而 UI 相机的可见层是 `UI_2D | UI_3D`，
        // 不含 DEFAULT —— 漏掉这一步读数就是不显示，且没有任何报错。
        // 用画布的层而不是写死 UI_2D：跟随容器，将来搬动 UI 树时不会失效。
        node.layer = canvas.layer;

        const transform = node.addComponent(UITransform);
        transform.setAnchorPoint(0, 1);   // 锚点在左上角，方便贴角定位

        const label = node.addComponent(Label);
        label.useSystemFont = true;
        label.fontSize = 22;
        label.lineHeight = 30;
        label.horizontalAlign = Label.HorizontalAlign.LEFT;
        label.verticalAlign = Label.VerticalAlign.TOP;
        label.color = new Color(220, 230, 240, 220);

        canvas.addChild(node);

        // 贴在画布左上角
        const canvasTransform = canvas.getComponent(UITransform);
        const left = canvasTransform ? -canvasTransform.width * 0.5 : -640;
        const top = canvasTransform ? canvasTransform.height * 0.5 : 360;
        node.setPosition(new Vec3(left + 20, top - 16, 0));

        this._label = label;
    }

    /** 没有读数节点时是空操作（例如 attach 失败过） */
    update(snapshot: HudSnapshot): void {
        if (!this._label) {
            return;
        }
        this._label.string = format(snapshot);
    }
}

/**
 * 一屏读数的全部数据。
 *
 * 刻意是**扁平的、只读的**结构，而不是让 HUD 自己去问引擎和路由：
 * 后者会让 HUD 依赖整个运行时，又变回「改读数要动业务代码」。
 */
export interface HudSnapshot {
    /** 后端状态描述，如「running」「预览音源载入中 42%」 */
    engine: string;
    /** 后端类型。决定下面几行按原生还是预览展示 */
    backendKind: 'native' | 'web';
    /** 后端诊断原始数据 */
    backend: BackendDiagnostics;
    /** 音源是否已载入（原生才有意义） */
    bankReady: boolean;
    /**
     * 载入进度：-2 失败 / -1 未开始 / 0..99 进行中 / 100 已完成。
     *
     * 载入改成异步之后，「还没开始」和「正在载」必须分得开 —— 否则启动那几秒
     * 读数上显示的会是「未载入（按键无声）」，看起来像坏了。
     */
    loadPercent: number;

    /** 最近触发的音名，如「C4」；没弹过是「—」 */
    lastNote: string;
    /** 最近一次的力度 0..1 */
    lastVelocity: number;

    /** 收到的触摸事件总数（不论是否命中） */
    eventsSeen: number;
    /** 当前按住的键数 */
    heldNotes: number;
    /** 当前命中的触点数 */
    activeTouches: number;

    /** 累计提交成功的事件数 */
    submitted: number;
    /** 待提交的事件数 */
    pending: number;
    /** 累计因缓冲满丢弃的事件数 */
    dropped: number;

    /** 键盘状态；场景里没有键盘时为 null */
    keyboard: { keyWidth: number; manuallyZoomed: boolean } | null;
}

function format(s: HudSnapshot): string {
    const lines = [
        `状态  ${s.engine}`,
        `音符  ${s.lastNote}    力度 ${(s.lastVelocity * 127).toFixed(0)}/127`,
        // 「事件」是收到的触摸总数，「按住」是命中的键数。
        // 事件不涨 = 事件没送达；事件涨而按住恒 0 = 命中测试落空。
        // 这两类的排查方向完全不同，所以分成两列并排显示。
        `事件  ${s.eventsSeen}    按住 ${s.heldNotes}    命中 ${s.activeTouches}`,
        `已提交 ${s.submitted}    待提交 ${s.pending}    丢弃 ${s.dropped}`,
    ];

    if (s.backendKind === 'native') {
        const b = s.backend;
        lines.push(
            `内核  收到 ${b.acceptedEvents}    发声 ${b.voices}    欠载 ${b.xrun}` +
            (b.xrun > 0 ? ' ⚠' : ''),
        );
        // 音源没载入时按键必然无声。把状态显示出来，免得把「没载入」
        // 误判成「触摸没响应」。
        //
        // 三种状态要分开：载入是后台进行的，启动后有几秒钟处在「进行中」，
        // 那时候按键无声是预期行为，不该报警告。
        const mb = (b.residentBytes / 1024 / 1024).toFixed(0);
        lines.push(describeLoad(s.loadPercent, s.bankReady, mb));
    } else {
        lines.push(`预览  ${s.backend.voices} 个发声`);
    }

    if (s.keyboard) {
        const mode = s.keyboard.manuallyZoomed
            ? `已缩放 · 键宽 ${s.keyboard.keyWidth.toFixed(0)}pt`
            : '自动铺满';
        lines.push(`键盘  ${mode}`);
        // 手势之所以放在键盘**上方**而不是琴键上：琴键上的手势已经被弹奏占满
        // （一指横划是滑奏、和弦本身就要多指），划不出「几指算手势」的边界。
        // 放在空白区没有歧义 —— 但用户不会自己发现，所以得写出来。
        lines.push('手势  上方空白区：拖动平移 / 捏合缩放 / 双击复位');
    }

    return lines.join('\n');
}

/**
 * 音源那一行怎么写。
 *
 * 单独抽出来是因为它有四个分支，塞进 `format` 里会把别的行挤得看不清 ——
 * 而且这四种状态的区分本身就是「别把预期行为当成故障」的关键。
 */
function describeLoad(percent: number, bankReady: boolean, mb: string): string {
    if (bankReady || percent === LOAD_DONE) {
        return `音源  已载入 ${mb} MB`;
    }
    if (percent === LOAD_FAILED) {
        return '音源  ⚠ 载入失败（按键无声）';
    }
    if (percent < 0) {
        return '音源  ⚠ 未载入（按键无声）';
    }
    return `音源  载入中 ${percent}%`;
}

/** 沿父链向上找挂 Canvas 组件的节点 */
function findCanvas(from: Node): Node | null {
    let node: Node | null = from;
    while (node) {
        if (node.getComponent(Canvas)) {
            return node;
        }
        node = node.parent;
    }
    return null;
}
