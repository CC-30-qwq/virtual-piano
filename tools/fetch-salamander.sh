#!/usr/bin/env bash
#
# 下载 Salamander Grand Piano V3 音源。
#
# ## 为什么不用 git clone / codeload
#
# 在受限网络下实测：github.com、raw.githubusercontent.com、archive.org 全部不通，
# 唯一可用的 codeload.github.com 只有 44 KB/s，且**不支持断点续传** ——
# 仓库是流式打包，没有 Content-Length，断了就得从头再来（600MB+）。
#
# jsDelivr CDN 有国内节点，实测约 210 KB/s，而且是**按文件**下载，
# 单个文件断了只重试那一个。代价是它不给文件树（仓库超 50MB 限制），
# 所以文件清单从 SFZ 配置里推导，而不是硬编码。
#
# ## 并发
#
# 顺序下载只有 120 KB/s —— 每个文件都要重新建 TLS 连接，开销被放大了。
# 默认开 4 个并发，实测能显著提速。用 SALAMANDER_JOBS 调整；
# 调太高可能被 CDN 限流，反而更慢。
#
# ## 用法
#
#     bash tools/fetch-salamander.sh [输出目录]
#
# 输出目录默认 ./salamander。已存在且校验通过的文件会跳过，可反复运行续传。
#
# 环境变量：
#   SALAMANDER_BASE   覆盖下载源（默认 jsDelivr）
#   SALAMANDER_JOBS   并发数（默认 4）

set -u

OUT_DIR="${1:-$PWD/salamander}"
BASE="${SALAMANDER_BASE:-https://cdn.jsdelivr.net/gh/sfzinstruments/SalamanderGrandPiano@master}"
JOBS="${SALAMANDER_JOBS:-4}"

SAMPLES_DIR="$OUT_DIR/Samples"
DATA_DIR="$OUT_DIR/Data"
META_DIR="$OUT_DIR/_config"

RETRIES=5
FLAC_MAGIC='fLaC'

# ------------------------------------------------------------------ 下载原语

# 带重试的下载。校验通过（非空 + 可选魔数）才落盘，避免留下半截文件。
#
# $1 远端相对路径（需已 URL 编码）
# $2 本地目标路径
# $3 期望的魔数（空则只校验非空）
fetch() {
    local rel="$1" dst="$2" magic="${3:-}"

    if [ -s "$dst" ]; then
        if [ -z "$magic" ] || [ "$(head -c 4 "$dst" 2>/dev/null)" = "$magic" ]; then
            return 0    # 已存在且校验通过
        fi
        rm -f "$dst"    # 损坏的半截文件，重下
    fi

    local i code
    for i in $(seq 1 "$RETRIES"); do
        code=$(curl -sL --max-time 180 -o "$dst.part" -w "%{http_code}" "$BASE/$rel" 2>/dev/null)
        if [ "$code" = "200" ] && [ -s "$dst.part" ]; then
            if [ -z "$magic" ] || [ "$(head -c 4 "$dst.part" 2>/dev/null)" = "$magic" ]; then
                # Windows 上文件刚写完时可能被系统短暂占用（杀软 / 索引），
                # 此时 mv 会报 "Device or resource busy"。重试几次即可。
                local k
                for k in 1 2 3 4 5; do
                    if mv "$dst.part" "$dst" 2>/dev/null; then
                        return 0
                    fi
                    sleep 1
                done
                echo "    重命名失败: $dst" >&2
            fi
        fi
        rm -f "$dst.part"
        sleep $((i * 2))    # 递增退避：jsDelivr 首次连接经常握手失败，重试通常就能过
    done

    echo "    下载失败: $rel (最后一次 http=$code)" >&2
    return 1
}

# 音名里的 '#' 必须编码，否则会被当作 URL 片段
urlencode() { printf '%s' "$1" | sed 's/#/%23/g'; }

# ------------------------------------------------------------------ 工作模式

# 由主模式通过 xargs 并发调用：--one <已编码的相对路径> <目标路径>
# 注意 $1 是 --one 本身，实际参数从 $2 起。
if [ "${1:-}" = "--one" ]; then
    fetch "$2" "$3" "$FLAC_MAGIC"
    exit $?
fi

# ------------------------------------------------------------------ 主模式

mkdir -p "$SAMPLES_DIR" "$DATA_DIR" "$META_DIR"

echo "==> 获取 SFZ 配置"
# 主 SFZ 文件名里有空格，直接落地为下划线版本，避免路径里带空格
fetch "Salamander%20Grand%20Piano%20V3.sfz" "$META_DIR/Salamander_Grand_Piano_V3.sfz" || exit 1

for f in notes.txt region.txt tune_ret.txt tune_nat.txt hammer.txt str_res.txt pedal.txt \
         vel_01.txt vel_16.txt; do
    fetch "Data/$f" "$DATA_DIR/$f" || exit 1
done

# ------------------------------------------------------------------ 推导清单

echo "==> 推导采样清单"

# 主音色：region.txt 里每条 sample=X$VEL.$EXT 给出一个根音，
#         $VEL 由 vel_NN.txt 定义为 v1..v16
NOTES=$(grep -o 'sample=[A-Za-z#0-9]*\$VEL' "$DATA_DIR/region.txt" \
        | sed 's/sample=//; s/\$VEL//' | sort -u)
NOTE_COUNT=$(printf '%s\n' $NOTES | wc -l)

# 释放与踏板类采样：文件名已经是完整的（只带 $EXT 占位）
RELEASES=$(cat "$DATA_DIR"/hammer.txt "$DATA_DIR"/str_res.txt "$DATA_DIR"/pedal.txt \
           | grep -o 'sample=[A-Za-z0-9#$.]*' \
           | sed 's/sample=//; s/\.\$EXT$/.flac/' | sort -u)
RELEASE_COUNT=$(printf '%s\n' $RELEASES | wc -l)

TOTAL=$((NOTE_COUNT * 16 + RELEASE_COUNT))
echo "    根音 $NOTE_COUNT 个 × 16 力度层 = $((NOTE_COUNT * 16)) 个主音色"
echo "    释放/踏板类 $RELEASE_COUNT 个"
echo "    合计 $TOTAL 个文件，并发 $JOBS"

# 展开成「已编码远端路径 / 本地路径」两行一组的任务清单。
# 已下载且校验通过的直接剔除，这样进度统计才有意义。
TASK_FILE="$META_DIR/tasks.txt"
: > "$TASK_FILE"
pending=0

for n in $NOTES; do
    enc=$(urlencode "$n")
    for v in $(seq 1 16); do
        target="$SAMPLES_DIR/${n}v${v}.flac"
        if [ -s "$target" ] && [ "$(head -c 4 "$target")" = "$FLAC_MAGIC" ]; then
            continue
        fi
        printf '%s\n%s\n' "Samples/${enc}v${v}.flac" "$target" >> "$TASK_FILE"
        pending=$((pending + 1))
    done
done

for f in $RELEASES; do
    target="$SAMPLES_DIR/$f"
    if [ -s "$target" ] && [ "$(head -c 4 "$target")" = "$FLAC_MAGIC" ]; then
        continue
    fi
    printf '%s\n%s\n' "Samples/$(urlencode "$f")" "$target" >> "$TASK_FILE"
    pending=$((pending + 1))
done

alreadied=$((TOTAL - pending))
echo "    已完成 $alreadied，待下载 $pending"

if [ "$pending" -eq 0 ]; then
    echo "==> 无需下载"
else
    echo "==> 开始下载（$(date +%H:%M:%S)）"
    # 每 25 个文件报一次进度，避免刷屏
    xargs -d '\n' -P "$JOBS" -n 2 bash "$0" --one < "$TASK_FILE" &
    xargs_pid=$!

    while kill -0 "$xargs_pid" 2>/dev/null; do
        sleep 60
        done_now=$(find "$SAMPLES_DIR" -name '*.flac' 2>/dev/null | wc -l)
        sz=$(du -sh "$SAMPLES_DIR" 2>/dev/null | cut -f1)
        printf '    [%s] 已完成 %d/%d 个文件，%s\n' "$(date +%H:%M:%S)" "$done_now" "$TOTAL" "$sz"
    done
    wait "$xargs_pid"
    rc=$?
fi

# ------------------------------------------------------------------ 汇总

size=$(du -sh "$SAMPLES_DIR" 2>/dev/null | cut -f1)
count=$(find "$SAMPLES_DIR" -name '*.flac' 2>/dev/null | wc -l)
echo
echo "==> 完成（$(date +%H:%M:%S)）"
echo "    Samples 目录：$count 个文件，$size"
if [ "$count" -lt "$TOTAL" ]; then
    echo "    缺 $((TOTAL - count)) 个 —— 直接重跑本脚本即可，已完成的会跳过。"
    exit 1
fi
