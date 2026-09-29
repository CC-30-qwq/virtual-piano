const { KeyLayout, clampOffset, LOWEST_MIDI, HIGHEST_MIDI } = require('./keyboard/KeyLayout.js');

let pass = 0, fail = 0;
function ok(cond, msg) {
    if (cond) { pass++; } else { fail++; console.log('  FAIL: ' + msg); }
}
function eq(a, b, msg) { ok(a === b, `${msg} (期望 ${b}, 实际 ${a})`); }

const KEY_W = 40, KEY_H = 180;
const L = new KeyLayout({ keyWidth: KEY_W, whiteKeyHeight: KEY_H });

console.log('--- 键数 ---');
eq(L.whites.length, 52, '白键数');
eq(L.blacks.length, 36, '黑键数');
eq(L.whites.length + L.blacks.length, 88, '总键数');
eq(L.whites[0].midi, LOWEST_MIDI, '最低音');
eq(L.whites[L.whites.length - 1].midi, HIGHEST_MIDI, '最高音');

console.log('--- 音高完整性与唯一性 ---');
const seen = new Set();
let dup = 0, missing = 0;
for (let m = LOWEST_MIDI; m <= HIGHEST_MIDI; m++) {
    const k = L.getKey(m);
    if (!k) { missing++; continue; }
    if (seen.has(k.midi)) dup++;
    seen.add(k.midi);
}
eq(missing, 0, '缺失音高数');
eq(dup, 0, '重复音高数');
eq(L.getKey(20), null, '越界（低于 A0）应返回 null');
eq(L.getKey(109), null, '越界（高于 C8）应返回 null');

console.log('--- 白键排布 ---');
let whiteOk = true, xCursor = 0;
for (const w of L.whites) {
    if (w.x !== xCursor || w.width !== KEY_W) whiteOk = false;
    xCursor += KEY_W;
}
ok(whiteOk, '白键应从 0 起紧密排列');
eq(L.totalWidth, 52 * KEY_W, '总宽度');

console.log('--- 黑键定位（须对准相邻白键分界线）---');
let blackOk = true;
for (const b of L.blacks) {
    // 黑键左侧的白键：取所有 x 小于黑键中心的白键中最大的那个
    const center = b.x + b.width / 2;
    const leftWhites = L.whites.filter(w => w.x < center);
    const left = leftWhites[leftWhites.length - 1];
    const boundary = left.x + left.width;
    if (Math.abs(center - boundary) > 1e-9) { blackOk = false; break; }
}
ok(blackOk, '每个黑键中心应落在相邻白键分界线上');

console.log('--- 黑键音级模式（每八度须为 C# D# F# G# A#）---');
const BLACK_PCS = [1, 3, 6, 8, 10];
let pcOk = true;
for (const b of L.blacks) { if (!BLACK_PCS.includes(b.midi % 12)) pcOk = false; }
ok(pcOk, '黑键音级');

console.log('--- 命中测试 ---');
// 白键：在低位（黑键覆盖区之下）取每个白键中点
let hitWhiteOk = true;
for (const w of L.whites) {
    const mid = L.hitTest(w.x + w.width / 2, 10);
    if (mid !== w.midi) { hitWhiteOk = false; console.log(`    白键 MIDI ${w.midi} 命中为 ${mid}`); break; }
}
ok(hitWhiteOk, '白键中部低位应命中自身');

// 黑键：在覆盖区之内取黑键中点
const blackZoneY = KEY_H - L.blackKeyHeight + 5;
let hitBlackOk = true;
for (const b of L.blacks) {
    const mid = L.hitTest(b.x + b.width / 2, blackZoneY);
    if (mid !== b.midi) { hitBlackOk = false; console.log(`    黑键 MIDI ${b.midi} 命中为 ${mid}`); break; }
}
ok(hitBlackOk, '黑键覆盖区内应命中黑键（黑键优先）');

// 边界：黑键正下方的低位处，应命中白键而不是黑键
const firstBlack = L.blacks[0];
const belowBlack = L.hitTest(firstBlack.x + firstBlack.width / 2, 5);
ok(belowBlack !== firstBlack.midi, '黑键正下方低位不应命中黑键');

console.log('--- 黑键命中区放宽 ---');
// 黑键画出来只有白键的 0.583 倍宽，直接拿绘制宽度做命中会窄到按不准。
// 命中区左右各外扩，但中心必须与绘制位置对齐 —— 否则会「看着在这、按到那」。
{
    const drawnHalf = firstBlack.width / 2;

    // 在绘制边界之外一点点，仍应命中黑键（说明确实放宽了）
    const justOutside = firstBlack.x + firstBlack.width + 1;
    eq(L.hitTest(justOutside, blackZoneY), firstBlack.midi,
       '绘制边界之外 1pt 仍应命中黑键（命中区已放宽）');

    const justInsideLeft = firstBlack.x - 1;
    eq(L.hitTest(justInsideLeft, blackZoneY), firstBlack.midi,
       '左边界之外 1pt 也应命中黑键');

    // 中心对称：两侧外扩量相等，否则会有方向性偏差
    const leftReach = (firstBlack.x + drawnHalf) - (firstBlack.x - 1);
    const rightReach = justOutside - (firstBlack.x + drawnHalf);
    ok(Math.abs(leftReach - rightReach) <= 2,
       `左右外扩应对称（左 ${leftReach.toFixed(1)}pt / 右 ${rightReach.toFixed(1)}pt）`);

    // 相邻黑键的中心相隔一个白键宽，放宽后绝不能互相抢占。
    // 取第一对相邻黑键（C# 与 D#），在中点处应落到白键上。
    const pairs = [];
    for (let i = 1; i < L.blacks.length; i++) {
        const a = L.blacks[i - 1], b = L.blacks[i];
        if (Math.abs((b.x + b.width / 2) - (a.x + a.width / 2) - KEY_W) < 1e-6) {
            pairs.push([a, b]);
        }
    }
    ok(pairs.length > 0, '存在相邻的黑键对（用于验证不重叠）');

    let noOverlap = true;
    for (const [a, b] of pairs) {
        const mid = ((a.x + a.width / 2) + (b.x + b.width / 2)) / 2;
        const hit = L.hitTest(mid, blackZoneY);
        if (hit === a.midi || hit === b.midi) { noOverlap = false; break; }
    }
    ok(noOverlap, '相邻黑键的中点上不应命中任一方（放宽后未重叠）');
}

// 越界
eq(L.hitTest(-1, 10), null, 'x 越界');
eq(L.hitTest(10, -1), null, 'y 越界');
eq(L.hitTest(10, KEY_H + 1), null, 'y 过高');

console.log('--- 滚动偏移 ---');
eq(clampOffset(0, 1280, 2080), 0, '左侧边界');
eq(clampOffset(-9999, 1280, 2080), 1280 - 2080, '右侧边界');
eq(clampOffset(500, 1280, 2080), 0, '超出左界应夹回');
eq(clampOffset(0, 3000, 2080), (3000 - 2080) / 2, '键盘比视口窄时应居中');

const off = L.offsetToCenter(69, 1280);  // A4
const a4 = L.getKey(69);
const a4ScreenX = a4.x + a4.width / 2 + off;
ok(Math.abs(a4ScreenX - 640) < 1e-6, `A4 应居中于视口 (实际 ${a4ScreenX})`);

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
