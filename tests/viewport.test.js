/**
 * KeyboardViewport —— 键宽、滚动偏移、缩放锚点与夹紧。
 *
 * ## 为什么这个文件值得存在
 *
 * 这些数学原先长在 `KeyboardView`（一个 `Component`）里，与 `Graphics` 绘制、
 * 节点变换缠在一起，于是最该被验证的一段 —— **捏合缩放要「捏哪放大哪」**，
 * 即缩放前后锚点处的琴键必须停在同一屏幕位置 —— 只能靠人眼在编辑器里看，
 * 而它错了的症状是「画面自己飘走」，很容易被当成手感问题而放过。
 */

const { KeyboardViewport, MIN_KEY_WIDTH, MAX_KEY_WIDTH } = require('./keyboard/KeyboardViewport.js');

let pass = 0, fail = 0;
function ok(cond, msg) {
    if (cond) { pass++; } else { fail++; console.log('  FAIL: ' + msg); }
}
function eq(a, b, msg) { ok(a === b, `${msg} (期望 ${b}, 实际 ${a})`); }
function close(a, b, msg, tol = 1e-6) {
    ok(Math.abs(a - b) <= tol, `${msg} (期望 ${b}, 实际 ${a})`);
}

const VIEW_W = 1280, WHITE_H = 180;

/** 可滚动的键盘：52 × 40 = 2080 宽，比视口宽 */
function scrollable() {
    return new KeyboardViewport({
        viewportWidth: VIEW_W, keyWidth: 40, whiteKeyHeight: WHITE_H, fitToScreen: false,
    });
}

/** 铺满的键盘：键宽由视口宽度算出 */
function fitted() {
    return new KeyboardViewport({
        viewportWidth: VIEW_W, keyWidth: 40, whiteKeyHeight: WHITE_H, fitToScreen: true,
    });
}

// ---------------------------------------------------------------- 自动铺满

console.log('--- 自动铺满 ---');
{
    const vp = fitted();
    close(vp.keyWidth, VIEW_W / 52, '键宽应为视口宽 / 52');
    close(vp.totalWidth, VIEW_W, '铺满时总宽应等于视口宽');
    eq(vp.offsetX, 0, '刚好铺满时偏移应为 0');
    eq(vp.manuallyZoomed, false, '铺满状态下不算手动缩放');
}

console.log('--- 视口比键盘宽时居中 ---');
{
    const vp = new KeyboardViewport({
        viewportWidth: 1280, keyWidth: MIN_KEY_WIDTH, whiteKeyHeight: WHITE_H, fitToScreen: false,
    });
    close(vp.totalWidth, 52 * MIN_KEY_WIDTH, '总宽');
    ok(vp.totalWidth < VIEW_W, '前提：键盘比视口窄');
    close(vp.offsetX, (VIEW_W - vp.totalWidth) * 0.5, '应居中');
}

// ---------------------------------------------------------------- 滚动

console.log('--- 滚动夹紧 ---');
{
    const vp = scrollable();
    const minOffset = VIEW_W - vp.totalWidth;      // -800
    vp.scrollTo(-99999);
    eq(vp.offsetX, minOffset, '向左拖到底应夹在下界');
    vp.scrollTo(99999);
    eq(vp.offsetX, 0, '向右拖到底应夹在上界');
    vp.scrollTo(-300);
    eq(vp.offsetX, -300, '范围内的偏移原样保留');
    vp.scrollBy(-100);
    eq(vp.offsetX, -400, 'scrollBy 应相对移动');
    vp.scrollBy(99999);
    eq(vp.offsetX, 0, 'scrollBy 也要夹紧');
}

// ---------------------------------------------------------------- 缩放锚点

console.log('--- 缩放：捏哪放大哪（锚点不动）---');
{
    const vp = scrollable();

    // 把锚点取在 A4 键的中心上 —— 缩放后它的屏幕位置必须不变
    const midi = 69;
    const before = vp.layout.getKey(midi);
    const contentX = before.x + before.width * 0.5;
    const offsetBefore = vp.offsetX;
    const anchorRatio = (contentX + offsetBefore) / vp.viewportWidth;

    const keyWidthBefore = vp.keyWidth;
    const screenBefore = contentX + offsetBefore;

    vp.setKeyWidth(48, anchorRatio);
    // 倍率取**实际生效**的键宽：目标值可能被上下限夹过（这里 48 恰好是上限）
    const scale = vp.keyWidth / keyWidthBefore;

    const after = vp.layout.getKey(midi);
    const contentXAfter = after.x + after.width * 0.5;
    close(contentXAfter, contentX * scale, '内容坐标应按倍率缩放');
    close(contentXAfter + vp.offsetX, screenBefore, '锚点处的键在屏幕上应原地不动', 1e-6);
}

console.log('--- 缩放：锚点取左/右边缘 ---');
{
    for (const ratio of [0, 1]) {
        const vp = scrollable();
        const offsetBefore = -200;
        vp.scrollTo(offsetBefore);
        const screenBefore = vp.viewportWidth * ratio;
        const contentBefore = screenBefore - offsetBefore;   // screen = content + offset

        const keyWidthBefore = vp.keyWidth;
        vp.setKeyWidth(48, ratio);
        const scale = vp.keyWidth / keyWidthBefore;

        const contentAfter = contentBefore * scale;
        close(contentAfter + vp.offsetX, screenBefore, `锚点 ${ratio} 处应不动`, 1e-6);
    }
}

console.log('--- 缩放：夹紧优先于锚点 ---');
{
    // 键盘宽度与视口接近时，保持锚点要求的偏移可能越界（画面会被拖出屏幕外）。
    // 此时以夹紧为准 —— 宁可锚点漂一点，也不能露白。这是**有意的**行为，
    // 取在缩放前的键宽上：40 → 30 时总宽 1560，视口 1280，可动范围只有 280。
    const vp = scrollable();
    vp.scrollTo(0);
    const anchorRatio = 0.5;
    const keyWidthBefore = vp.keyWidth;

    vp.setKeyWidth(30, anchorRatio);
    const scale = vp.keyWidth / keyWidthBefore;

    // 保持锚点需要偏移 +160（屏幕外），实际被夹到 0
    const wanted = vp.viewportWidth * anchorRatio * (1 - scale);
    ok(wanted > 0, '前提：保持锚点所需的偏移会越界');
    eq(vp.offsetX, 0, '越界时应夹到边界');
}

console.log('--- 缩放：键宽夹到上下限、并解除自动铺满 ---');
{
    const vp = fitted();
    eq(vp.manuallyZoomed, false, '初始为铺满');
    vp.setKeyWidth(5);                       // 远小于下限
    eq(vp.keyWidth, MIN_KEY_WIDTH, '应夹到下限');
    eq(vp.manuallyZoomed, true, '手动缩放后应脱离铺满');

    vp.setKeyWidth(999);                     // 远大于上限
    eq(vp.keyWidth, MAX_KEY_WIDTH, '应夹到上限');
}

console.log('--- 缩放：已到限位时不做任何改动 ---');
{
    const vp = scrollable();
    vp.setKeyWidth(MAX_KEY_WIDTH, 0.5);
    const keyWidth = vp.keyWidth, offset = vp.offsetX;
    vp.setKeyWidth(999, 0.5);                // 再放大也是同一个值
    eq(vp.keyWidth, keyWidth, '键宽不变');
    eq(vp.offsetX, offset, '偏移不变（不应因夹紧而漂移）');
}

console.log('--- 复位 ---');
{
    const vp = scrollable();
    vp.setKeyWidth(48, 0.5);
    vp.scrollTo(-500);
    vp.resetZoom();
    close(vp.keyWidth, VIEW_W / 52, '复位应回到铺满键宽');
    eq(vp.offsetX, 0, '复位应回到最左');
    eq(vp.manuallyZoomed, false, '复位后不再算手动缩放');
}

// ---------------------------------------------------------------- 居中

console.log('--- 让某个音居中 ---');
{
    const vp = scrollable();
    vp.centerOn(69);                          // A4
    const key = vp.layout.getKey(69);
    const center = key.x + key.width * 0.5;
    close(center + vp.offsetX, VIEW_W * 0.5, '目标键中心应落在视口中心');

    // 边界：最左的键无法真正居中，应夹到左边缘
    vp.centerOn(21);
    eq(vp.offsetX, 0, 'A0 居中会被夹到左边缘');
    vp.centerOn(108);
    eq(vp.offsetX, VIEW_W - vp.totalWidth, 'C8 居中会被夹到右边缘');
}

// ---------------------------------------------------------------- 裁剪范围

console.log('--- 可见范围 ---');
{
    const vp = scrollable();
    const [x0, x1] = vp.visibleRange();
    close(x1 - x0, VIEW_W + vp.keyWidth * 2, '左右各留一个键宽的余量');
    close(x0, -vp.keyWidth, '偏移为 0 时从 -keyWidth 开始');

    vp.scrollTo(-400);
    const [y0] = vp.visibleRange();
    close(y0, -(-400) - vp.keyWidth, '随偏移移动');
}

// ---------------------------------------------------------------- 变更通知

console.log('--- 变更通知：区分几何变化与纯偏移 ---');
{
    const seen = [];
    const vp = scrollable();
    vp.listener = { onViewportChanged(geometryChanged) { seen.push(geometryChanged); } };

    vp.scrollTo(-100);
    eq(seen.length, 1, '滚动应通知一次');
    eq(seen[seen.length - 1], false, '滚动不算几何变化');

    vp.scrollTo(-100);
    eq(seen.length, 1, '偏移没变时不通知（避免无效重绘）');

    vp.setKeyWidth(50);
    eq(seen[seen.length - 1], true, '缩放算几何变化');

    const before = seen.length;
    vp.setKeyWidth(50);
    eq(seen.length, before, '键宽没变时不通知');

    vp.centerOn(69);
    eq(seen[seen.length - 1], false, '居中只是偏移变化');
}

console.log('--- 视口尺寸变化 ---');
{
    const vp = fitted();
    const seen = [];
    vp.listener = { onViewportChanged(geometryChanged) { seen.push(geometryChanged); } };

    vp.setViewportWidth(1600);
    close(vp.keyWidth, 1600 / 52, '铺满状态下键宽应跟着视口变');
    eq(seen[seen.length - 1], true, '键宽变了 → 几何变化');

    const keyWidth = vp.keyWidth;
    vp.setViewportWidth(1600);
    eq(seen.length, 1, '尺寸没变时不通知');

    // 手动缩放后视口再变：键宽不该被自动铺满覆盖
    vp.setKeyWidth(30);
    const manualWidth = vp.keyWidth;
    vp.setViewportWidth(1000);
    eq(vp.keyWidth, manualWidth, '手动缩放的键宽不应被视口变化覆盖');
    eq(vp.manuallyZoomed, true, '仍然算手动缩放');
    ok(vp.keyWidth !== keyWidth, '前提：键宽确实与铺满值不同');

    // 此时键盘比视口窄/宽都要重新夹紧
    vp.setViewportWidth(4000);
    close(vp.offsetX, (4000 - vp.totalWidth) * 0.5, '视口变宽后应重新居中');
}

// ---------------------------------------------------------------- 结果

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
