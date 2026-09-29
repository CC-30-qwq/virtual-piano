#!/usr/bin/env python3
"""
分析 Salamander 采样的衰减轮廓，为 M2-2 的裁剪策略提供依据。

## 要回答的问题

技术方案 §2.3 修正后估算音频包约 430 MB，其中低音区尾部占了 76%
（低音区实测平均 21.76s，远长于早期假设的 8.5s）。
但 21.76s 里有相当一部分是衰减到不可闻之后的房间尾巴。

这个脚本把「衰减到某个阈值需要多久」实测出来，用数据回答：
按能量阈值裁剪，到底能削掉多少。

## 阈值取相对值而非绝对值

用**相对峰值**的衰减门限，而不是固定的绝对 dBFS。
原因：力度层 v1 整体就是安静的，用绝对门限会把它的尾巴整条切掉，
而那恰恰是弱奏时该听到的余韵。

## 分析用的采样率

降到 8 kHz 单声道。衰减轮廓是包络信息，不需要高频；这样解码快一个数量级，
480 个文件才跑得动。

用法：
    python tools/audio-pipeline/analyze_decay.py [音源目录] [--rel-db 60]
"""

import argparse
import os
import re
import subprocess
import sys
from collections import defaultdict

import numpy as np

# Windows 控制台默认是 GBK（代码页 936），个别符号（如 U+2212 数学减号）
# 编不出来会直接抛 UnicodeEncodeError 中断整个脚本。这里兜底成替换字符，
# 保证「输出不好看」不会升级成「任务失败」。
try:
    sys.stdout.reconfigure(errors="replace")
except Exception:
    pass

ANALYSIS_SR = 8000
WINDOW_MS = 50


def load_mono(path, sr=ANALYSIS_SR):
    """用 ffmpeg 解码成单声道 f32le。"""
    cmd = [
        "ffmpeg", "-v", "error", "-i", path,
        "-ac", "1", "-ar", str(sr),
        "-f", "f32le", "-",
    ]
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32)


def envelope(x, sr=ANALYSIS_SR, window_ms=WINDOW_MS):
    """分窗 RMS 包络。"""
    w = max(1, int(sr * window_ms / 1000))
    n = len(x) // w
    if n == 0:
        return np.zeros(0)
    frames = x[: n * w].reshape(n, w).astype(np.float64)
    return np.sqrt(np.mean(frames * frames, axis=1))


def decay_seconds(env, rel_db, window_ms=WINDOW_MS):
    """最后一个超过门限的窗口的结束时刻（秒）。

    门限 = 峰值 × 10^(-rel_db/20)，相对值。
    """
    if len(env) == 0:
        return 0.0, 0.0
    peak = float(np.max(env))
    if peak <= 0:
        return 0.0, 0.0
    thr = peak * (10.0 ** (-rel_db / 20.0))
    above = np.nonzero(env > thr)[0]
    if len(above) == 0:
        return 0.0, peak
    return (above[-1] + 1) * window_ms / 1000.0, peak


def zone_of(name):
    """按音名归入音区；非主音色返回 None。"""
    m = re.match(r"^([A-G]#?)(\d+)v\d+$", name)
    if not m:
        return None
    octave = int(m.group(2))
    if octave <= 2:
        return "低音 A0-A2"
    if octave <= 4:
        return "中音 C3-B4"
    return "高音 C5-C8"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("root", nargs="?", default="audio-src")
    ap.add_argument("--rel-db", type=float, default=60.0,
                    help="相对峰值的衰减门限（dB），默认 60")
    ap.add_argument("--limit", type=int, default=0,
                    help="只分析前 N 个文件（调试用）")
    args = ap.parse_args()

    samples_dir = os.path.join(args.root, "Samples")
    if not os.path.isdir(samples_dir):
        print(f"找不到 {samples_dir}", file=sys.stderr)
        return 2

    names = sorted(
        f[:-5] for f in os.listdir(samples_dir)
        if f.endswith(".flac") and zone_of(f[:-5]) is not None
    )
    if args.limit:
        names = names[: args.limit]

    print(f"分析 {len(names)} 个主音色，门限 = 峰值 - {args.rel_db:g} dB\n")

    stats = defaultdict(list)      # zone → [(原始时长, 衰减时长)]
    failures = []

    for i, name in enumerate(names):
        path = os.path.join(samples_dir, name + ".flac")
        try:
            x = load_mono(path)
        except subprocess.CalledProcessError as exc:
            failures.append((name, exc.stderr.decode("utf-8", "replace")[:80]))
            continue

        total = len(x) / ANALYSIS_SR
        env = envelope(x)
        decay, _ = decay_seconds(env, args.rel_db)
        stats[zone_of(name)].append((total, decay))

        if (i + 1) % 50 == 0:
            print(f"  …{i + 1}/{len(names)}")

    # ---------------------------------------------------------------- 报告

    print()
    header = f"{'音区':<14}{'个数':>6}{'原始平均':>10}{'衰减平均':>10}{'可削掉':>10}{'削减比':>9}"
    print(header)
    print("-" * len(header))

    grand_total = grand_decay = 0.0
    for zone in ("低音 A0-A2", "中音 C3-B4", "高音 C5-C8"):
        rows = stats.get(zone)
        if not rows:
            continue
        totals = np.array([r[0] for r in rows])
        decays = np.array([r[1] for r in rows])
        grand_total += totals.sum()
        grand_decay += decays.sum()
        print(f"{zone:<14}{len(rows):>6}{totals.mean():>9.2f}s{decays.mean():>9.2f}s"
              f"{totals.mean() - decays.mean():>9.2f}s"
              f"{(1 - decays.sum() / totals.sum()) * 100:>8.0f}%")

    if grand_total > 0:
        print("-" * len(header))
        print(f"{'合计':<14}{sum(len(v) for v in stats.values()):>6}"
              f"{grand_total / len(names):>9.2f}s{grand_decay / len(names):>9.2f}s"
              f"{'':>9}"
              f"{(1 - grand_decay / grand_total) * 100:>8.0f}%")

        # 换算成磁盘：16bit 立体声 48kHz
        BYTES_PER_SEC = 48000 * 2 * 2
        print()
        print(f"按 {args.rel_db:g}dB 门限裁剪后，主音色原始 PCM 时长 "
              f"{grand_total:.0f}s → {grand_decay:.0f}s")
        print(f"  对应 16bit 立体声未压缩体积："
              f"{grand_total * BYTES_PER_SEC / 1024 / 1024:.0f} MB → "
              f"{grand_decay * BYTES_PER_SEC / 1024 / 1024:.0f} MB")

    if failures:
        print(f"\n解码失败 {len(failures)} 个：")
        for name, err in failures[:10]:
            print(f"  {name}: {err}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
