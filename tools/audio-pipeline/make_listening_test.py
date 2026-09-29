#!/usr/bin/env python3
"""
生成循环试听素材，用于判断循环点是否听得出来。

## 为什么需要它

`build_samples.py` 会报出每个循环段的「首尾幅度比」（tail − head，dB）。
这个数字**只是间接指标** —— 它衡量的是回绕处的幅度跳变有多大，
但能不能听出来还取决于循环周期、交叉淡化长度、以及是否被其他声音掩蔽。

这类问题没有解析解，只能用耳朵。所以这里把「attack + 循环段重复」拼成
一条持续音，与原始完整衰减并排输出，做 A/B 对比。

## 怎么听

先听 `*_orig`，再听 `*_loop`。要留意的是**循环周期性的音量脉动**
（不是咔哒声 —— 交叉淡化已经把咔哒消掉了）。循环周期越短、幅度差越大，
脉动越明显。

用法：
    python tools/audio-pipeline/make_listening_test.py
    python tools/audio-pipeline/make_listening_test.py --notes A4 C6 A1v8
"""

import argparse
import os
import subprocess
import sys

import numpy as np

SR = 48000
CH = 2


def decode(path):
    out = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path,
         "-ac", str(CH), "-ar", str(SR), "-f", "f32le", "-"],
        capture_output=True, check=True).stdout
    return np.frombuffer(out, dtype=np.float32).reshape(-1, CH)


def encode(x, path):
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y",
         "-f", "f32le", "-ar", str(SR), "-ac", str(CH), "-i", "-",
         "-c:a", "libmp3lame", "-q:a", "4", path],   # mp3 便于随手播放
        input=np.clip(x, -1, 1).astype(np.float32).tobytes(), check=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bank", default="build-bank")
    ap.add_argument("--src", default="audio-src")
    ap.add_argument("--out", default="build-bank/_listening")
    ap.add_argument("--notes", nargs="*",
                    default=["A4v8", "C4v8", "C6v8", "A1v8"])
    ap.add_argument("--repeats", type=int, default=6,
                    help="循环段重复次数")
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    made = 0

    for note in args.notes:
        a_path = os.path.join(args.bank, "piano", f"{note}_a.flac")
        l_path = os.path.join(args.bank, "piano", f"{note}_l.flac")
        o_path = os.path.join(args.src, "Samples", f"{note}.flac")

        if not (os.path.exists(a_path) and os.path.exists(l_path)):
            # 低音区没有循环段（绝对无循环），跳过
            print(f"  跳过 {note}：没有循环段")
            continue

        attack = decode(a_path)
        loop = decode(l_path)
        sustained = np.concatenate([attack] + [loop] * args.repeats, axis=0)

        encode(sustained, os.path.join(args.out, f"{note}_loop.mp3"))
        if os.path.exists(o_path):
            encode(decode(o_path), os.path.join(args.out, f"{note}_orig.mp3"))

        ratio = 20 * np.log10(
            (np.sqrt(np.mean(loop[-SR // 4:].astype(np.float64) ** 2)) + 1e-12) /
            (np.sqrt(np.mean(loop[: SR // 4].astype(np.float64) ** 2)) + 1e-12))
        print(f"  {note}: attack {len(attack)/SR:.2f}s + "
              f"loop {len(loop)/SR:.2f}s × {args.repeats}"
              f" → {len(sustained)/SR:.1f}s，首尾差 {ratio:.1f} dB")
        made += 1

    if made == 0:
        print("没有生成任何素材")
        return 1

    print(f"\n已写入 {args.out}")
    print("先听 *_orig（原始完整衰减），再听 *_loop（attack + 循环重复）。")
    print("留意循环周期性的音量脉动 —— 那才是循环是否可闻的判据。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
