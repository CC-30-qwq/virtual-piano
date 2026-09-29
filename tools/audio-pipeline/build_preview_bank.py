#!/usr/bin/env python3
"""
从正式音源包里抽一个极小的子集，供**编辑器预览**使用。

## 为什么需要它

正式音源包（193MB FLAC）是给原生端按文件读的。而 Cocos 编辑器的预览跑在
浏览器里，没有原生音频内核 —— 也就是说**在编辑器里根本听不到声音**，
没法评估手感、布局、力度响应。

这个脚本把音源压到约 700KB，编成一个 TS 模块直接进脚本包。
浏览器端用 Web Audio 解码播放，变调/复音/踏板逻辑与原生侧一致。

## 抽取策略

| 项 | 保留 | 理由 |
|---|---|---|
| 根音 | **全部 30 个** | 少了就得大跨度变调，音高会明显跑偏 |
| 力度层 | 2 层（最轻、最响） | 预览要听得出力度差异，但不需要 16 层 |
| 时长 | 2.0 秒 | 覆盖音头与早期衰减 —— 辨识音色靠的就是这一段 |
| 声道 | 单声道 | 立体声在预览里价值有限，体积翻倍不划算 |
| 格式 | mp3 48kbps | 浏览器 decodeAudioData 普遍支持，体积小 |

## 为什么编码成 TS 模块而不是放进 assets/

放进 assets/ 会变成 Cocos 资源，浏览器端要拿原始 ArrayBuffer 反而绕 ——
`AudioClip` 不暴露底层数据。而 Cocos 的预览服务器对 assets 的 URL 映射也不稳定。

编成 base64 字符串常量最直接：不依赖任何资源管线，预览和构建行为一致。

用法：
    python tools/audio-pipeline/build_preview_bank.py
    python tools/audio-pipeline/build_preview_bank.py --layers 2 --seconds 2.0
"""

import argparse
import base64
import json
import os
import re
import subprocess
import sys

SR = 48000

# 与 build_samples.py 保持一致的音区划分
REGIONS = [
    {"name": "low",  "max_octave": 2,  "attack": 4.0},
    {"name": "mid",  "max_octave": 4,  "attack": 3.0},
    {"name": "high", "max_octave": 99, "attack": 2.0},
]

MAIN_RE = re.compile(r"^([A-G]#?)(\d+)v(\d+)$")
NOTE_SEMITONES = {"C": 0, "C#": 1, "D": 2, "D#": 3, "E": 4, "F": 5,
                  "F#": 6, "G": 7, "G#": 8, "A": 9, "A#": 10, "B": 11}


def note_to_midi(letter, octave):
    return (int(octave) + 1) * 12 + NOTE_SEMITONES[letter]


def pick_layers(manifest, count):
    """挑 count 个力度层，让它们的**层中心在力度轴上等距**。

    ⚠️ 不能按「层的序号等距」挑 —— Salamander 的力度区间是非均匀的，
    按序号等距会取到第 1 层和第 16 层这种**两个极端**，中间留下一大段空隙
    （1-26 与 121-127 之间空着 27-120）。那意味着绝大多数正常力度都落不进
    任何一层，只能靠回退逻辑随便挑，实际总是用最轻的那一层 —— 声音又小又闷。

    正确的做法是按**层中心**（min+max)/2 在 0..127 上等距取，这样覆盖才均匀。
    """
    layers = manifest["velocityLayers"]
    if count >= len(layers):
        return sorted(v["index"] for v in layers)

    centers = [(0.5 * (v["minVelocity"] + v["maxVelocity"]), v["index"]) for v in layers]

    if count == 1:
        # 单层时取最接近中位的
        return [min(centers, key=lambda c: abs(c[0] - 63.5))[1]]

    targets = [127.0 * (i + 0.5) / count for i in range(count)]
    picked = set()
    for t in targets:
        picked.add(min(centers, key=lambda c: abs(c[0] - t))[1])

    # 等距目标可能把两个目标映射到同一层，从剩下的层里补足
    remaining = [c for c in centers if c[1] not in picked]
    remaining.sort(key=lambda c: c[0])
    while len(picked) < count and remaining:
        picked.add(remaining.pop(len(remaining) // 2)[1])

    return sorted(picked)


def transcode(src, dst, seconds):
    """截取前 N 秒，转单声道 mp3。"""
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", src,
         "-t", f"{seconds}",
         "-ac", "1", "-ar", "22050",
         "-c:a", "libmp3lame", "-b:a", "48k",
         dst],
        check=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bank", default="build-bank")
    ap.add_argument("--out", default="assets/scripts/audio/PreviewBankData.ts")
    ap.add_argument("--layers", type=int, default=2, help="保留的力度层数")
    ap.add_argument("--seconds", type=float, default=2.0, help="每个采样截取时长")
    args = ap.parse_args()

    manifest_path = os.path.join(args.bank, "manifest.json")
    if not os.path.isfile(manifest_path):
        print(f"找不到 {manifest_path} —— 先跑 build_samples.py", file=sys.stderr)
        return 2

    manifest = json.load(open(manifest_path, encoding="utf-8"))
    wanted = set(pick_layers(manifest, args.layers))
    print(f"力度层：{sorted(wanted)}（共 {len(manifest['velocityLayers'])} 层中挑 {len(wanted)} 层）")

    tmp = os.path.join(os.path.dirname(args.out), ".preview-tmp")
    os.makedirs(tmp, exist_ok=True)

    entries = []
    total_bytes = 0

    for root in manifest["rootNotes"]:
        for layer in root["layers"]:
            if layer["velocityLayer"] not in wanted:
                continue

            rel = layer["attack"]
            src = os.path.join(args.bank, rel)
            if not os.path.isfile(src):
                print(f"  缺文件：{src}", file=sys.stderr)
                continue

            dst = os.path.join(tmp, os.path.basename(rel).replace(".flac", ".mp3"))
            transcode(src, dst, args.seconds)

            data = open(dst, "rb").read()
            total_bytes += len(data)
            entries.append({
                "midi": root["midi"],
                "name": root["name"],
                "velocityLayer": layer["velocityLayer"],
                "minVelocity": next(v["minVelocity"] for v in manifest["velocityLayers"]
                                    if v["index"] == layer["velocityLayer"]),
                "maxVelocity": next(v["maxVelocity"] for v in manifest["velocityLayers"]
                                    if v["index"] == layer["velocityLayer"]),
                "mp3": base64.b64encode(data).decode("ascii"),
            })

    for f in os.listdir(tmp):
        os.remove(os.path.join(tmp, f))
    os.rmdir(tmp)

    # ---- 生成 TS 模块 ----
    lines = [
        "/**",
        " * 预览音源（自动生成，请勿手改）",
        " *",
        f" * 由 tools/audio-pipeline/build_preview_bank.py 从 {args.bank}/ 抽取。",
        f" * {len(entries)} 条采样，mp3 base64 内嵌，共 {total_bytes / 1024:.0f} KB。",
        " *",
        " * 用途：Cocos 编辑器的预览跑在浏览器里，没有原生音频内核，",
        " * 靠这份小音源 + Web Audio 让编辑器里也能出声。",
        " * 正式音频走原生路径，与这份数据无关。",
        " */",
        "",
        "export interface PreviewSample {",
        "    /** 根音 MIDI */",
        "    readonly midi: number;",
        "    /** 该层覆盖的力度下界 */",
        "    readonly minVelocity: number;",
        "    /** 该层覆盖的力度上界 */",
        "    readonly maxVelocity: number;",
        "    /** mp3 数据的 base64 */",
        "    readonly mp3: string;",
        "}",
        "",
        f"export const PREVIEW_LAYER_COUNT = {len(wanted)};",
        "",
        "export const PREVIEW_SAMPLES: readonly PreviewSample[] = [",
    ]

    for e in entries:
        lines.append("    { midi: %d, minVelocity: %d, maxVelocity: %d, mp3: '%s' },"
                     % (e["midi"], e["minVelocity"], e["maxVelocity"], e["mp3"]))

    lines += ["];", ""]

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))

    size_kb = os.path.getsize(args.out) / 1024
    print(f"\n已写入 {args.out}")
    print(f"  {len(entries)} 条采样，音频 {total_bytes / 1024:.0f} KB，"
          f"文件 {size_kb:.0f} KB（base64 膨胀约 33%）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
