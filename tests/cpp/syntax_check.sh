#!/usr/bin/env bash
#
# 只编译、不链接 —— 给「宿主测试覆盖不到、又只能等 Android 构建」的文件兜底。
#
# ## 为什么需要它
#
# 内核里有三类文件：
#   1. 纯逻辑（EventQueue / SampleBank / Voice / VoicePool …）
#      → 由 tests/cpp/run.sh 编成宿主可执行文件，**能跑测试**
#   2. 依赖引擎或平台（PianoBridge.cpp、Game.cpp、AudioDeviceAAudio.cpp …）
#      → 只能在 Android 构建里编
#   3. 用了平台无关的接口、但自身依赖引擎日志等杂项（PianoEngine.cpp）
#      → 宿主测试链不进去（`AudioDevice::create()` 在本机返回 nullptr），
#        于是成了盲区：一个拼写错误要等几分钟的 Android 构建才发现
#
# 本脚本处理第 3 类：只做 `/c`（编译到 .obj），不链接、不运行。
# 它能抓到语法错误、类型错误、函数签名不匹配；抓不到行为错误 ——
# 那是 run.sh 的活。
#
# ## 为什么用 /W4
#
# 这些文件进的是 Android 构建（clang），本机用 MSVC 编只是为了提前发现错误。
# 打开全部警告，把「本机编得过、NDK 编不过」的差集压到最小。
#
# 用法：
#     bash tests/cpp/syntax_check.sh            # 检查全部
#     bash tests/cpp/syntax_check.sh Piano      # 只检查名字含 Piano 的

set -u

VCVARS="${VCVARS:-C:/Program Files/Microsoft Visual Studio/2022/Community/VC/Auxiliary/Build/vcvars64.bat}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PIANO="$ROOT/native/engine/common/Classes/piano"
OUT="$ROOT/tests/cpp/.syntax"
FILTER="${1:-}"

if [ ! -f "$VCVARS" ]; then
    echo "找不到 vcvars64.bat：$VCVARS" >&2
    echo "可用 VCVARS 环境变量指定路径" >&2
    exit 2
fi

# 需要 Cocos 头文件、本机编不了的文件（靠 Android 构建验证）
#   PianoBridge.cpp       sebind / se::Object
#   SampleSourceAndroid.cpp  AAssetManager + dr_flac（整段被 __ANDROID__ 包住）
#   AudioDeviceAAudio.cpp    aaudio/AAudio.h
SKIP="PianoBridge.cpp SampleSourceAndroid.cpp AudioDeviceAAudio.cpp"

winpath() {
    printf '%s' "$1" | sed -e 's|^/\([a-zA-Z]\)/|\1:/|' -e 's|/|\\|g'
}

rm -rf "$OUT" && mkdir -p "$OUT"

failed=0
checked=0

for src in "$PIANO"/*.cpp; do
    name="$(basename "$src")"
    if [ -n "$FILTER" ] && [[ "$name" != *"$FILTER"* ]]; then
        continue
    fi
    case " $SKIP " in *" $name "*) continue ;; esac

    checked=$((checked + 1))
    echo "========== $name =========="

    bat="$OUT/check_$name.bat"
    {
        echo "@echo off"
        echo "call \"$(winpath "$VCVARS")\" >nul 2>&1"
        echo "cd /d \"$(winpath "$ROOT")\""
        printf 'cl /nologo /std:c++17 /utf-8 /EHsc /O2 /W4 /c /I"%s" /I"%s" "%s" /Fo:"%s"\n' \
               "$(winpath "$PIANO")" \
               "$(winpath "$ROOT/native/engine/common/third_party")" \
               "$(winpath "$src")" \
               "$(winpath "$OUT/$name.obj")"
    } > "$bat"

    if ! cmd //c "$(winpath "$bat")"; then
        echo "  编译失败"
        failed=1
    fi
    echo
done

if [ "$checked" -eq 0 ]; then
    echo "没有匹配的文件（过滤词：$FILTER）" >&2
    exit 2
fi

if [ "$failed" -ne 0 ]; then
    echo "存在失败项"
    exit 1
fi
echo "全部通过（编译 $checked 个文件）"
