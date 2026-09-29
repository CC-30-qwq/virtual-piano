#!/usr/bin/env bash
#
# 运行工程内全部可自动化的测试。
#
# 工程没有 node 环境和测试框架，但 Cocos 编辑器自带的 node 与 TypeScript
# 可以直接用 —— ELECTRON_RUN_AS_NODE=1 会让 CocosCreator.exe 以纯 node 运行。
# 因此不需要额外安装任何东西。
#
# 用法：  bash tests/run.sh
#
# 覆盖范围：不依赖 Cocos 运行时的纯逻辑。
# 带 cc 依赖的代码（渲染、触摸）只能在编辑器或真机里验证。

set -u

CC="${COCOS_CREATOR:-D:/Cocos/editors/Creator/3.8.8/CocosCreator.exe}"
TSC="${COCOS_TSC:-D:/Cocos/editors/Creator/3.8.8/resources/app.asar.unpacked/node_modules/typescript/lib/tsc.js}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${TMPDIR:-/tmp}/piano-tests"

if [ ! -f "$CC" ]; then
    echo "找不到 CocosCreator.exe：$CC" >&2
    echo "可通过环境变量 COCOS_CREATOR 指定路径" >&2
    exit 2
fi

node_run() { ELECTRON_RUN_AS_NODE=1 "$CC" "$@"; }

failed=0

# ---------------------------------------------------------------- 类型检查
echo "========== 类型检查 =========="
if ! node_run "$TSC" --noEmit -p "$ROOT/tsconfig.json"; then
    echo "类型检查未通过"
    failed=1
fi
echo

# ---------------------------------------------------------------- 纯逻辑测试
# 下列文件都不 import cc，可以单独编译到 node 下运行：
#   KeyLayout.ts         —— 键位几何
#   KeyboardViewport.ts  —— 视口状态机（键宽/偏移/缩放锚点）
#   KeyboardState.ts     —— 按下状态（随 KeyboardView 一起被编出来）
#   KeyboardInput.ts     —— 触摸状态机（命中/力度/滑奏/防抖）
#   PianoTypes.ts        —— 事件契约
#   EventBatcher.ts      —— 攒批与时间戳（时钟与出口是注入的，见 AudioClock.ts）
#   EventCodec.ts        —— 事件字节 → 字段
# tsc 会顺着 import 把 AudioClock.ts、KeyboardViewport.ts、KeyboardState.ts 一起编出来。
#
# 产物按源码的相对目录结构摆放（keyboard/、audio/），**不做拍平** ——
# 模块之间是用相对路径互相 require 的（例如 KeyboardInput 要
# '../audio/PianoTypes'），拍平之后跨目录的相对路径就解析不到了。
rm -rf "$OUT" && mkdir -p "$OUT"

node_run "$TSC" \
    "$ROOT/assets/scripts/keyboard/KeyLayout.ts" \
    "$ROOT/assets/scripts/keyboard/KeyboardViewport.ts" \
    "$ROOT/assets/scripts/keyboard/KeyboardInput.ts" \
    "$ROOT/assets/scripts/audio/PianoTypes.ts" \
    "$ROOT/assets/scripts/audio/EventBatcher.ts" \
    "$ROOT/assets/scripts/audio/EventCodec.ts" \
    "$ROOT/assets/scripts/audio/AudioClock.ts" \
    --outDir "$OUT" --module commonjs --target es2020 --skipLibCheck || {
        echo "编译测试目标失败" >&2
        exit 2
    }
cp "$ROOT"/tests/*.test.js "$OUT"/

for t in "$OUT"/*.test.js; do
    name="$(basename "$t")"
    echo "========== $name =========="
    if ! (cd "$OUT" && node_run "$name"); then
        failed=1
    fi
    echo
done

if [ "$failed" -ne 0 ]; then
    echo "存在失败项"
    exit 1
fi
echo "全部通过"
