/**
 * KeyboardInput —— 触摸状态机（命中、力度、滑奏、多点跟踪）。
 *
 * ## 为什么这个文件值得存在
 *
 * 这些逻辑原先长在 `TouchRouter`（一个 `Component`）里，与 `EventTouch`、
 * 相机坐标换算缠在一起，**一条都测不了**：十指同时按下、手指停在键缝上抖动、
 * 快速横扫漏音，只能靠人在真机上反复试。
 *
 * 现在状态机不依赖 `cc`：坐标与时刻都是入参，所以这里能用假事件把
 * 这些真人很难复现的手势逐个跑出来。
 */

const { KeyboardInput } = require('./keyboard/KeyboardInput.js');
const { KeyboardState } = require('./keyboard/KeyboardState.js');
const { KeyboardViewport } = require('./keyboard/KeyboardViewport.js');

let pass = 0, fail = 0;
function ok(cond, msg) {
    if (cond) { pass++; } else { fail++; console.log('  FAIL: ' + msg); }
}
function eq(a, b, msg) { ok(a === b, `${msg} (期望 ${b}, 实际 ${a})`); }
function close(a, b, msg, tol = 1e-9) {
    ok(Math.abs(a - b) <= tol, `${msg} (期望 ${b}, 实际 ${a})`);
}

const VIEW_W = 1280, WHITE_H = 180;

/** 造一套「视口 + 状态 + 记录式监听者 + 状态机」 */
function setup(paramOverrides = {}) {
    const viewport = new KeyboardViewport({
        viewportWidth: VIEW_W, keyWidth: 40, whiteKeyHeight: WHITE_H, fitToScreen: false,
    });
    const state = new KeyboardState();
    const events = [];
    const listener = {
        onNoteOn(midi, velocity, source) { events.push({ kind: 'on', midi, velocity, source }); },
        onNoteOff(midi) { events.push({ kind: 'off', midi }); },
    };
    const params = Object.assign({
        minVelocity: 0.25, maxVelocity: 1.0,
        fixedVelocity: false, fixedVelocityValue: 0.7,
        glissandoDebounceMs: 30,
    }, paramOverrides);

    const input = new KeyboardInput(viewport, state, listener, params);
    return { viewport, state, events, params, input };
}

/** 某个键的点击坐标（白键取下半部，避开黑键命中区） */
function pointOf(viewport, midi, opts = {}) {
    const key = viewport.layout.getKey(midi);
    const x = key.x + key.width * 0.5;
    if (key.isBlack) {
        // 黑键：取其中部
        const bottom = WHITE_H - key.height;
        return { x, y: bottom + key.height * 0.5, key };
    }
    // 白键：默认取靠下 1/6 处（y=30 < 黑键命中区起点 68.4）
    const y = opts.y !== undefined ? opts.y : 30;
    return { x, y, key };
}

// ---------------------------------------------------------------- 基本

console.log('--- 单指按下与松开 ---');
{
    const { viewport, state, events, input } = setup();
    const p = pointOf(viewport, 60);            // C4

    input.touchStart(1, p.x, p.y, 0);
    eq(events.length, 1, '应触发一个事件');
    eq(events[0].kind, 'on', '应是 NoteOn');
    eq(events[0].midi, 60, '音高');
    eq(state.has(60), true, '按下状态应被写入');
    eq(input.activeTouchCount, 1, '跟踪中的触点数');

    input.touchEnd(1);
    eq(events.length, 2, '松开应触发 NoteOff');
    eq(events[1].kind, 'off', '应是 NoteOff');
    eq(events[1].midi, 60, '音高');
    eq(state.has(60), false, '按下状态应被清除');
    eq(input.activeTouchCount, 0, '触点数归零');
}

console.log('--- 未命中不发声，但仍计数 ---');
{
    const { viewport, events, input } = setup();

    input.touchStart(1, 10, -50, 0);            // 键盘上方（y 为负）
    input.touchStart(2, 10, WHITE_H + 50, 0);   // 键盘下方
    input.touchStart(3, -100, 30, 0);           // 左边界外
    eq(events.length, 0, '未命中不应发声');
    eq(input.activeTouchCount, 0, '未命中不应被跟踪');
    // eventsSeen 的口径是「收到的触摸事件数」—— 送达了但没命中，
    // 正是它要区分出来的那类故障，所以必须计数
    eq(input.eventsSeen, 3, '收到的触摸事件数应计入');
}

console.log('--- 同一 id 重复 touchStart 只算一次 ---');
{
    const { viewport, events, input } = setup();
    const p = pointOf(viewport, 60);
    input.touchStart(1, p.x, p.y, 0);
    input.touchStart(1, p.x, p.y, 5);           // 同一根手指的重复开始
    eq(events.length, 1, '不应重复发声');
    eq(input.activeTouchCount, 1, '不应重复跟踪');
}

console.log('--- 未知 id 的 touchEnd 无副作用 ---');
{
    const { events, input } = setup();
    input.touchEnd(99);
    eq(events.length, 0, '不应发声');
}

// ---------------------------------------------------------------- 力度

console.log('--- 力度：越靠近自己越响 ---');
{
    const { viewport, input } = setup();
    const key = viewport.layout.getKey(60);

    close(input.velocityFor(0, 60), 1.0, '按在琴键最下端应是最强');
    close(input.velocityFor(key.height, 60), 0.25, '按在最上端应是最弱');
    close(input.velocityFor(key.height * 0.5, 60), 0.625, '中点的力度');

    ok(input.velocityFor(10, 60) > input.velocityFor(100, 60), '越靠下越响');
    // 越界夹紧
    close(input.velocityFor(-100, 60), 1.0, '越过下边界夹到最强');
    close(input.velocityFor(9999, 60), 0.25, '越过上边界夹到最弱');
}

console.log('--- 力度：黑键按自身高度归一 ---');
{
    const { viewport, input } = setup();
    const key = viewport.layout.getKey(61);      // C#4
    ok(key.isBlack, '前提：61 是黑键');
    const bottom = WHITE_H - key.height;

    close(input.velocityFor(bottom, 61), 1.0, '黑键下端应是最强');
    close(input.velocityFor(bottom + key.height, 61), 0.25, '黑键上端应是最弱');
    // 若错用白键高度归一，黑键的力度范围会被压缩 —— 中点值就不会是 0.625
    close(input.velocityFor(bottom + key.height * 0.5, 61), 0.625, '中点的力度');
}

console.log('--- 固定力度模式 ---');
{
    const s = setup({ fixedVelocity: true, fixedVelocityValue: 0.7 });
    close(s.input.velocityFor(0, 60), 0.7, '应恒为设定值');
    close(s.input.velocityFor(200, 60), 0.7, '不随位置变化');

    const p = pointOf(s.viewport, 60);
    s.input.touchStart(1, p.x, p.y, 0);
    close(s.events[0].velocity, 0.7, '按下时也应使用固定力度');
}

// ---------------------------------------------------------------- 多点

console.log('--- 十指同时按下 ---');
{
    const { viewport, state, events, input } = setup();
    const midis = [48, 50, 52, 53, 55, 57, 59, 60, 62, 64];
    midis.forEach((m, i) => {
        const p = pointOf(viewport, m);
        input.touchStart(i + 1, p.x, p.y, i);
    });
    eq(events.length, 10, '十个音都应触发');
    eq(input.activeTouchCount, 10, '十个触点都应被跟踪');
    eq(state.size, 10, '十个键都应在按下状态');

    // 逐指松开
    midis.forEach((m, i) => input.touchEnd(i + 1));
    eq(input.activeTouchCount, 0, '全部松开后触点数归零');
    eq(state.size, 0, '全部松开后按键状态清空');
    eq(events.filter(e => e.kind === 'off').length, 10, '十个音都应收到 NoteOff');
}

console.log('--- 全部释放 ---');
{
    const { viewport, state, events, input } = setup();
    const p1 = pointOf(viewport, 60), p2 = pointOf(viewport, 64);
    input.touchStart(1, p1.x, p1.y, 0);
    input.touchStart(2, p2.x, p2.y, 0);

    input.releaseAll();
    eq(events.filter(e => e.kind === 'off').length, 2, '每个发声中的音都应收到 NoteOff');
    eq(state.size, 0, '按下状态应清空');
    eq(input.activeTouchCount, 0, '触点数归零');

    const before = events.length;
    input.releaseAll();
    eq(events.length, before, '再释放一次不应重复发事件');
}

// ---------------------------------------------------------------- 滑奏

console.log('--- 滑奏：划过一个键就触发一个音 ---');
{
    const { viewport, events, input } = setup();
    const a = pointOf(viewport, 60), b = pointOf(viewport, 62);
    input.touchStart(1, a.x, a.y, 0);
    input.touchMove(1, b.x, b.y, 100);

    eq(events.length, 3, '旧音 off + 新音 on');
    eq(events[1].kind, 'off', '先松旧的');
    eq(events[1].midi, 60, '旧音音高');
    eq(events[2].kind, 'on', '再发新的');
    eq(events[2].midi, 62, '新音音高');
    eq(input.activeTouchCount, 1, '仍只有一根手指');
}

console.log('--- 滑奏：同一个键内移动不发事件 ---');
{
    const { viewport, events, input } = setup();
    const p = pointOf(viewport, 60);
    input.touchStart(1, p.x, p.y, 0);
    input.touchMove(1, p.x + 1, p.y + 1, 10);
    input.touchMove(1, p.x - 1, p.y - 1, 20);
    eq(events.length, 1, '不应重复触发');
}

console.log('--- 滑奏：未跟踪的手指不响应 ---');
{
    const { viewport, events, input } = setup();
    const p = pointOf(viewport, 62);
    input.touchMove(7, p.x, p.y, 0);            // 没有 touchStart 过
    eq(events.length, 0, '不应发声');
}

console.log('--- 滑奏：移出键盘范围时保持原音 ---');
{
    const { viewport, events, input } = setup();
    const p = pointOf(viewport, 60);
    input.touchStart(1, p.x, p.y, 0);
    input.touchMove(1, p.x, -40, 10);           // 划出键盘上边缘
    eq(events.length, 1, '不应松音，也不应触发新音');
    eq(input.activeTouchCount, 1, '手指仍被跟踪');
    input.touchEnd(1);
    eq(events[1].kind, 'off', '抬手时才松音');
}

console.log('--- 防抖：键缝上的抖动不重触发 ---');
{
    const { viewport, events, input } = setup({ glissandoDebounceMs: 30 });
    const a = pointOf(viewport, 60), b = pointOf(viewport, 62);

    input.touchStart(1, a.x, a.y, 0);           // 按 A
    input.touchMove(1, b.x, b.y, 5);            // 划到 B（触发）
    const afterB = events.length;               // on A → off A → on B

    input.touchMove(1, a.x, a.y, 10);           // 10ms 后回到 A（窗口内 → 抖动）
    eq(events.length, afterB, '窗口内回到刚离开的键，应视为抖动而不触发');

    // 正常跨越**新**键不受影响（移动到第三个键，而不是回到 B —— 回到 B 是
    // 「没变化」，因为抑制期间被跟踪的音一直是 B）
    const c = pointOf(viewport, 64);
    input.touchMove(1, c.x, c.y, 15);
    ok(events.length > afterB, '跨越新键应立即响应（否则快速横扫会漏音）');

    // 超过窗口后，回到 A 是正常滑奏
    const before = events.length;
    input.touchMove(1, a.x, a.y, 15 + 31);
    eq(events.length, before + 2, '超过防抖窗口后应正常触发');
}

console.log('--- 已知边界：抑制期间音停在原键上（有意取舍）---');
{
    // 手指在 B 上抖回 A 后就**停住**（窗口内不再产生 touchMove）：
    // 抑制生效，发声与高亮都仍是 B —— 两者彼此一致，只是与手指最终位置不一致。
    // 要彻底修好得引入「延迟确认」（等窗口结束再决定），代价是正常滑奏会慢一拍；
    // 本项目的取舍是：宁可偶尔慢一拍，也不要快速横扫时漏音。
    const { viewport, state, events, input } = setup({ glissandoDebounceMs: 30 });
    const a = pointOf(viewport, 60), b = pointOf(viewport, 62);

    input.touchStart(1, a.x, a.y, 0);
    input.touchMove(1, b.x, b.y, 5);
    input.touchMove(1, a.x, a.y, 10);           // 抖回 A 并停住
    eq(input.activeTouchCount, 1, '手指仍被跟踪');
    eq(state.has(62), true, '被跟踪的音仍是 B');
    eq(state.has(60), false, 'A 不会被点亮（与发声一致）');

    input.touchEnd(1);
    eq(events[events.length - 1].midi, 62, '抬手时松开的是被跟踪的那个音');
    eq(state.size, 0, '抬手后状态清空');
}

// ---------------------------------------------------------------- 状态

console.log('--- KeyboardState：只在真的变了时通知 ---');
{
    let notified = 0;
    const state = new KeyboardState();
    state.listener = { onPressedChanged() { notified++; } };

    eq(state.set(60, true), true, '首次按下算变化');
    eq(notified, 1, '应通知一次');
    eq(state.set(60, true), false, '重复按下不算变化');
    eq(notified, 1, '不应重复通知');
    eq(state.set(60, false), true, '松开算变化');
    eq(notified, 2, '应通知');

    eq(state.clear(), undefined, 'clear 无返回值');
    eq(notified, 2, '本来就是空的时候不应通知');
    state.set(64, true);
    state.clear();
    eq(notified, 4, '清空非空状态应通知');
    eq(state.size, 0, '清空后应为空');
}

// ---------------------------------------------------------------- 结果

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
