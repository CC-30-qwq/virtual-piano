#!/usr/bin/env bash
#
# 用本机 MSVC 编译并运行 C++ 内核测试。
#
# ## 为什么需要它
#
# M1 的内核（无锁队列、重采样、复音偷取、包络）正确性**只能靠运行验证**。
# 但本工程的 C++ 平时只编 Android 目标 —— NDK 的 clang 编出来的东西在本机跑不了。
#
# 所以：**把不依赖 Cocos 的那部分内核单独编成宿主可执行文件**。
# 这些源码（EventQueue / Voice / Resampler …）本来就不该依赖引擎，
# 能这样测反而说明分层是干净的。
#
# 依赖 Cocos 的文件（PianoBridge.cpp）不参与宿主构建，靠 Android 构建验证。
#
# ## 为什么必须用 /O2
#
# Debug 下编译器重排保守，内存序写错也常常能跑对。必须用优化构建跑 ——
# 那才是优化器会真正重排指令的场景。
#
# ## 为什么生成 .bat 而不是直接 cmd //c "cl ..."
#
# Git Bash 到 cmd.exe 的路径/引号转义极其容易出错（`\"` 会原样传给 cmd），
# 而 MSVC 的命令行里到处都是反斜杠。生成一个 .bat 文件再执行，
# 可以完全绕开这层转义。
#
# 用法：
#     bash tests/cpp/run.sh              # 跑全部
#     bash tests/cpp/run.sh eventqueue   # 只跑名字含 eventqueue 的

set -u

VCVARS="${VCVARS:-C:/Program Files/Microsoft Visual Studio/2022/Community/VC/Auxiliary/Build/vcvars64.bat}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PIANO="$ROOT/native/engine/common/Classes/piano"
SRC="$ROOT/tests/cpp"
OUT="$SRC/.build"

FILTER="${1:-}"

if [ ! -f "$VCVARS" ]; then
    echo "找不到 vcvars64.bat：$VCVARS" >&2
    echo "可用 VCVARS 环境变量指定路径" >&2
    exit 2
fi

# Git Bash 的 /d/foo 路径转成 cl.exe 认的 D:\foo
winpath() {
    printf '%s' "$1" | sed -e 's|^/\([a-zA-Z]\)/|\1:/|' -e 's|/|\\|g'
}

# 不依赖 Cocos 的内核源码清单。
#
# ⚠️ **不要在这里手写文件名** —— 清单的唯一来源是与 Android 构建共用的
# pure_sources.cmake。曾经两处各写一遍，结果是新增内核 .cpp 时漏加任何一处
# 都不立刻报错（漏在这边就是莫名其妙的链接失败）。
PURE_LIST="$PIANO/pure_sources.cmake"
if [ ! -f "$PURE_LIST" ]; then
    echo "找不到源码清单：$PURE_LIST" >&2
    exit 2
fi

CORE_SOURCES=()
for name in $(sed -n '/set(PIANO_PURE_SOURCES/,/)/p' "$PURE_LIST" \
                  | grep -v 'set(' | grep -v '^[[:space:]]*)$' | grep -v '^[[:space:]]*#') ; do
    CORE_SOURCES+=("$PIANO/$name")
done

if [ "${#CORE_SOURCES[@]}" -eq 0 ]; then
    echo "从 $PURE_LIST 里没解析出任何源码 —— 清单格式变了？" >&2
    exit 2
fi
echo "内核源码 ${#CORE_SOURCES[@]} 个：$(basename -a "${CORE_SOURCES[@]}" | tr '\n' ' ')"
echo

rm -rf "$OUT" && mkdir -p "$OUT"

failed=0
ran=0

for test_src in "$SRC"/*_test.cpp; do
    name="$(basename "$test_src" .cpp)"
    if [ -n "$FILTER" ] && [[ "$name" != *"$FILTER"* ]]; then
        continue
    fi

    ran=$((ran + 1))
    echo "========== $name =========="

    bat="$OUT/build_$name.bat"
    {
        echo "@echo off"
        echo "call \"$(winpath "$VCVARS")\" >nul 2>&1"
        echo "cd /d \"$(winpath "$OUT")\""
        # /utf-8 是必须的：源码里的中文注释是 UTF-8，而 MSVC 默认按本地代码页
        # （本机是 GBK）解释。按 GBK 解析时，多字节序列会吞掉后面的字符 ——
        # 包括注释结束符，于是整个类定义被吃进注释里，报出一堆
        # 「未声明的标识符」。clang 默认就是 UTF-8，所以 Android 构建不会暴露这个问题。
        printf 'cl /nologo /std:c++17 /utf-8 /EHsc /O2 /W4 /I"%s" "%s"' \
               "$(winpath "$PIANO")" "$(winpath "$test_src")"
        for s in "${CORE_SOURCES[@]}"; do
            printf ' "%s"' "$(winpath "$s")"
        done
        printf ' /Fe:"%s"\n' "$(winpath "$OUT/$name.exe")"
    } > "$bat"

    if ! cmd //c "$(winpath "$bat")"; then
        echo "  编译失败"
        failed=1
        continue
    fi

    if [ ! -f "$OUT/$name.exe" ]; then
        echo "  未产出可执行文件"
        failed=1
        continue
    fi

    echo
    # 在工程根目录下运行：测试里用到的相对路径（如 build-bank/manifest.bin）
    # 都是相对工程根的
    if ! (cd "$ROOT" && "$OUT/$name.exe"); then
        failed=1
    fi
    echo
done

if [ "$ran" -eq 0 ]; then
    echo "没有匹配的测试（过滤词：$FILTER）" >&2
    exit 2
fi

if [ "$failed" -ne 0 ]; then
    echo "存在失败项"
    exit 1
fi
echo "全部通过"
