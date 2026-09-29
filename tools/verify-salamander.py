#!/usr/bin/env python3
"""
校验下载到的 Salamander 音源是否完整可用。

不做「文件存在就算数」这种弱校验 —— 那样半截文件、被 CDN 限流时写坏的
响应体都能蒙混过关。这里逐个解析 FLAC 的 STREAMINFO 元数据块，
把采样率、声道数、位深、总样本数都读出来：

  - 解析失败  → 文件损坏
  - 参数异常  → 不是我们期望的音源
  - 时长异常  → 大概率是被截断的

顺带把时长分布统计出来 —— M2 的音源裁剪策略要按音区区分，
低音区衰减长、高音区短，这个分布正是那个决策的依据。

用法：
    python tools/verify-salamander.py [音源目录]
"""

import os
import re
import struct
import sys
from collections import Counter, defaultdict

MAGIC = b"fLaC"
STREAMINFO = 0


def read_streaminfo(path):
    """解析 FLAC 的 STREAMINFO 块，返回 (采样率, 声道, 位深, 总样本数)。

    FLAC 结构：4 字节魔数 + 若干 METADATA_BLOCK。
    每块头 4 字节：1 字节（末块标志 << 7 | 块类型）+ 3 字节大端长度。
    STREAMINFO 固定 34 字节，前 10 字节之后是打包的 8 字节字段。
    """
    with open(path, "rb") as f:
        if f.read(4) != MAGIC:
            raise ValueError("不是 FLAC（魔数不匹配）")

        while True:
            header = f.read(4)
            if len(header) < 4:
                raise ValueError("元数据块头被截断")

            block_type = header[0] & 0x7F
            length = int.from_bytes(header[1:4], "big")

            if block_type == STREAMINFO:
                if length < 34:
                    raise ValueError(f"STREAMINFO 长度异常：{length}")
                data = f.read(34)
                if len(data) < 34:
                    raise ValueError("STREAMINFO 被截断")
                # 偏移 10 起的 8 字节打包字段：
                #   20 bits 采样率 | 3 bits 声道-1 | 5 bits 位深-1 | 36 bits 总样本数
                packed = int.from_bytes(data[10:18], "big")
                sample_rate = (packed >> 44) & 0xFFFFF
                channels = ((packed >> 41) & 0x7) + 1
                bits = ((packed >> 36) & 0x1F) + 1
                total_samples = packed & 0xFFFFFFFFF
                return sample_rate, channels, bits, total_samples

            if header[0] & 0x80:      # 末块标志
                raise ValueError("没有 STREAMINFO 块")
            f.seek(length, os.SEEK_CUR)


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else "audio-src"
    samples_dir = os.path.join(root, "Samples")
    config_dir = os.path.join(root, "_config")

    if not os.path.isdir(samples_dir):
        print(f"找不到目录：{samples_dir}", file=sys.stderr)
        return 2

    # 从配置文件推导期望清单，与下载脚本保持同一套逻辑
    region = os.path.join(root, "Data", "region.txt")
    if not os.path.isfile(region):
        print(f"找不到 {region}，无法推导期望清单", file=sys.stderr)
        return 2

    notes = sorted({
        line.split("sample=")[1].split("$VEL")[0]
        for line in open(region, encoding="utf-8")
        if "sample=" in line and "$VEL" in line
    })

    expected = {f"{n}v{v}.flac" for n in notes for v in range(1, 17)}
    for name in ("hammer.txt", "str_res.txt", "pedal.txt"):
        path = os.path.join(root, "Data", name)
        if not os.path.isfile(path):
            continue
        for line in open(path, encoding="utf-8"):
            if "sample=" not in line:
                continue
            sample = line.split("sample=")[1].split()[0]
            expected.add(sample.replace("$EXT", "flac"))

    print(f"期望 {len(expected)} 个采样\n")

    present, missing, corrupt = 0, [], []
    rate_counter, ch_counter, bits_counter = Counter(), Counter(), Counter()
    durations = []                      # (文件名, 秒)
    total_bytes = 0

    for name in sorted(expected):
        path = os.path.join(samples_dir, name)
        if not os.path.isfile(path):
            missing.append(name)
            continue
        try:
            rate, channels, bits, frames = read_streaminfo(path)
        except Exception as exc:
            corrupt.append((name, str(exc)))
            continue

        present += 1
        total_bytes += os.path.getsize(path)
        rate_counter[rate] += 1
        ch_counter[channels] += 1
        bits_counter[bits] += 1
        if rate > 0 and frames > 0:
            durations.append((name, frames / rate))

    # ---------------------------------------------------------------- 报告

    print(f"存在   {present} / {len(expected)}")
    print(f"缺失   {len(missing)}")
    print(f"损坏   {len(corrupt)}")
    print(f"总体积 {total_bytes / 1024 / 1024:.0f} MB")
    print()

    def dist(counter, label, unit=""):
        items = ", ".join(f"{k}{unit}×{v}" for k, v in sorted(counter.items()))
        print(f"{label}：{items}")

    dist(rate_counter, "采样率")
    dist(ch_counter, "声道数")
    dist(bits_counter, "位深")
    print()

    if durations:
        secs = [d for _, d in durations]
        print(f"时长   总计 {sum(secs) / 60:.1f} 分钟，"
              f"平均 {sum(secs) / len(secs):.2f}s，"
              f"最短 {min(secs):.2f}s，最长 {max(secs):.2f}s")

        # 按音区看时长分布 —— M2 的裁剪策略要据此制定
        # （低音衰减长、高音短，所以不能一刀切按固定秒数裁）
        #
        # 只统计主音色。释放/踏板类（rel88、harmSA0、pedalU1…）的文件名里
        # 也带数字，不排除的话会把它们的时长混进音区统计里，得出错误结论。
        by_zone = defaultdict(list)
        for name, secs_ in durations:
            m = re.match(r"^([A-G]#?)(\d+)v\d+\.flac$", name)
            if not m:
                continue
            oct_num = int(m.group(2))
            zone = "低音 A0-A2" if oct_num <= 2 else ("中音 C3-B4" if oct_num <= 4 else "高音 C5-C8")
            by_zone[zone].append(secs_)

        print("\n按音区（主音色）")
        for zone in ("低音 A0-A2", "中音 C3-B4", "高音 C5-C8"):
            vals = by_zone.get(zone)
            if vals:
                print(f"  {zone}：{len(vals)} 个，平均 {sum(vals)/len(vals):.2f}s，"
                      f"最长 {max(vals):.2f}s")

    if missing:
        print("\n缺失文件：")
        for name in missing[:20]:
            print(f"  {name}")
        if len(missing) > 20:
            print(f"  …另有 {len(missing) - 20} 个")

    if corrupt:
        print("\n损坏文件：")
        for name, reason in corrupt[:20]:
            print(f"  {name}: {reason}")

    return 0 if not missing and not corrupt else 1


if __name__ == "__main__":
    sys.exit(main())
