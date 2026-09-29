#!/usr/bin/env python3
"""
M2-2：把原始采样切成引擎要的分段，并烘焙循环点。

## 分段策略（按音区区分，依据见技术方案 §4.3）

| 音区 | attack | 循环 | 尾部 |
|---|---|---|---|
| 低音 A0–A2 | 4.0s | **无**（绝对无循环） | 完整保留，供流式读取 |
| 中音 C3–B4 | 2.5s | 1.5s（交叉淡化 0.5s） | 丢弃 |
| 高音 C5–C8 | 1.2s | 0.8s（交叉淡化 0.3s） | 丢弃 |

低音区不做循环是产品决策：宁可包体大（≈430MB vs ≈190MB），
也不接受任何循环感。中高音区的循环点已烘焙好交叉淡化，运行时纯回绕。

## 循环点为什么要交叉淡化

采样在衰减，循环段的首尾幅度不同。直接回绕会产生一个周期性幅度跳变
（听感上是"噗噗"的脉动）。交叉淡化把循环末尾淡出、同时把头部的对应片段
淡入，让回绕处的幅度连续。

**注意**：交叉淡化只能消除幅度跳变，不能消除"衰减被冻结"这件事 ——
循环启动后音符不再继续衰减。所以循环点要尽量取在衰减已经变缓的区段，
并且引擎侧要用包络继续做衰减。脚本会把每个循环段的**首尾幅度比**报出来，
比例越小说明循环越容易藏住。

## 响度处理

**不做跨层的响度归一化** —— 那会摧毁力度层的动态，正是这套音源的价值所在。

只做**层内**对齐：同一个力度层内，不同根音的感知音量应该一致
（否则弹不同音高时音量会忽大忽小）。基准取该层的中位数。

用法：
    python tools/audio-pipeline/build_samples.py --src audio-src --out build-bank
    python tools/audio-pipeline/build_samples.py --limit 8 --dry-run
"""

import argparse
import json
import os
import re
import struct
import subprocess
import sys
from concurrent.futures import ProcessPoolExecutor

import numpy as np

try:
    sys.stdout.reconfigure(errors="replace")
except Exception:
    pass

SR = 48000
CHANNELS = 2

# 音区配置。
#
# ## 全区段不做循环（「尽量仿真」决策）
#
# 循环本质上是妥协：它把衰减「冻结」在循环点上，之后只能靠引擎的包络
# 去近似本应继续的自然衰减。实测（技术方案 §2.3）表明包体代价可控
# ——全不循环约 216MB，做循环约 136MB——80MB 换掉全部循环痕迹，值。
#
# 因此这里的 `loop` 全为 None：每个音都输出完整的自然衰减。
# `attack` 的含义随之变为「常驻内存段的长度」，其余部分进 `_t` 供流式读取。
# 长度按音区递减：低音衰减慢、预读窗口充裕；高音短促，常驻段太长没意义。
REGIONS = [
    {"name": "low",  "max_octave": 2,  "attack": 4.0, "loop": None, "xfade": 0.0},
    {"name": "mid",  "max_octave": 4,  "attack": 3.0, "loop": None, "xfade": 0.0},
    {"name": "high", "max_octave": 99, "attack": 2.0, "loop": None, "xfade": 0.0},
]

MAIN_RE = re.compile(r"^([A-G]#?)(\d+)v(\d+)$")

NOTE_SEMITONES = {"C": 0, "C#": 1, "D": 2, "D#": 3, "E": 4, "F": 5,
                  "F#": 6, "G": 7, "G#": 8, "A": 9, "A#": 10, "B": 11}


def note_to_midi(name):
    """音名 → MIDI 音高。C4 = 60（中央 C）。"""
    m = re.match(r"^([A-G]#?)(-?\d+)$", name)
    if not m:
        return None
    return (int(m.group(2)) + 1) * 12 + NOTE_SEMITONES[m.group(1)]


def parse_velocity_layers(notes_path):
    """从 Data/notes.txt 解析力度层到 MIDI 力度的映射区间。

    Salamander 的 16 个力度层是**非均匀**划分的（最轻的一层独占 1-26，
    最响的一层独占 121-127），不是等分。引擎必须按这张表来挑层，
    否则弱奏和强奏的层次都会错位。
    """
    if not os.path.isfile(notes_path):
        return []
    layers = []
    for line in open(notes_path, encoding="utf-8"):
        m = re.search(r"vel_(\d+)\.txt\"\s+lovel=(\d+)\s+hivel=(\d+)", line)
        if m:
            layers.append({
                "index": int(m.group(1)),
                "minVelocity": int(m.group(2)),
                "maxVelocity": int(m.group(3)),
            })
    return sorted(layers, key=lambda x: x["index"])


def category_of(name):
    """按方案 §3.5 的包内目录结构归类。"""
    if MAIN_RE.match(name):
        return "piano"
    if name.startswith("rel"):
        return "rel"          # 锤击噪音
    if name.startswith("harm"):
        return "harm"         # 弦共振
    if name.startswith("pedal"):
        return "pedal"        # 踏板噪音
    return "misc"


# ------------------------------------------------------------------ 编解码


def decode(path):
    """解码成 (frames, 2) float32。"""
    out = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path,
         "-ac", str(CHANNELS), "-ar", str(SR), "-f", "f32le", "-"],
        capture_output=True, check=True).stdout
    x = np.frombuffer(out, dtype=np.float32)
    return x.reshape(-1, CHANNELS)


def encode(x, path, bits=16):
    """编码成 FLAC。"""
    sample_fmt = "s16" if bits == 16 else "s32"
    data = np.clip(x, -1.0, 1.0).astype(np.float32).tobytes()
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y",
         "-f", "f32le", "-ar", str(SR), "-ac", str(CHANNELS), "-i", "-",
         "-c:a", "flac", "-sample_fmt", sample_fmt, path],
        input=data, check=True)


# ------------------------------------------------------------------ 处理


def region_for(name):
    m = MAIN_RE.match(name)
    if not m:
        return None
    octave = int(m.group(2))
    for r in REGIONS:
        if octave <= r["max_octave"]:
            return r
    return REGIONS[-1]


def energy_trim(x, rel_db=90.0):
    """去掉末尾的数字静音。

    ⚠️ 实测（技术方案 §2.3）表明这一步几乎削不掉东西 —— -60dB 门限下仅 2%。
    它的定位是**安全步骤**（防止文件末尾有异常长的静音），不是体积优化。
    这里默认用 -90dB 这种极保守的门限，只砍真正的静音。
    """
    mono = x.mean(axis=1)
    win = SR // 20                      # 50ms
    n = len(mono) // win
    if n == 0:
        return x
    rms = np.sqrt(np.mean(mono[: n * win].reshape(n, win).astype(np.float64) ** 2, axis=1))
    peak = rms.max()
    if peak <= 0:
        return x
    above = np.nonzero(rms > peak * 10 ** (-rel_db / 20))[0]
    if len(above) == 0:
        return x
    end = min(len(x), (above[-1] + 1) * win)
    return x[:end]


def rms_db(seg):
    if seg.size == 0:
        return -120.0
    r = float(np.sqrt(np.mean(seg.astype(np.float64) ** 2)))
    return 20 * np.log10(r) if r > 1e-12 else -120.0


def make_loop(x, attack_s, loop_s, xfade_s):
    """切出循环段并烘焙交叉淡化。

    返回 (循环数组, 首尾幅度比 dB)。比值为正表示循环末尾比开头响
    （不该发生，说明取点有问题）；越接近 0 越容易藏住。
    """
    a = int(attack_s * SR)
    n_loop = int(loop_s * SR)
    n_xf = int(xfade_s * SR)

    if a + n_loop > len(x):
        # 素材不够长：整体回退成"没有循环"，把剩下的全给 attack
        return None, 0.0

    loop = x[a : a + n_loop].copy()

    if n_xf > 0 and n_xf * 2 < n_loop:
        # 交叉淡化：末尾 n_xf 帧淡出，同时把紧跟循环段之后的内容淡入。
        # 用「循环段之后的真实信号」而不是「循环段头部」来淡入 ——
        # 前者幅度更接近循环末尾，淡化后衔接更自然。
        tail_start = a + n_loop
        fade_in = x[tail_start : tail_start + n_xf]
        if len(fade_in) < n_xf:
            fade_in = np.resize(fade_in, (n_xf, CHANNELS))
        t = np.linspace(0.0, 1.0, n_xf, dtype=np.float32)[:, None]
        loop[-n_xf:] = loop[-n_xf:] * (1 - t) + fade_in * t

    head = rms_db(loop[: SR // 4])
    tail = rms_db(loop[-SR // 4:])
    return loop, tail - head


def level_match_gain(samples, floor_db=-40.0):
    """层内对齐：返回每个文件的增益（dB）。

    以该层的中位 RMS 为基准。**不做跨层归一化** —— 那会摧毁力度层的动态。
    """
    levels = []
    for lv in samples:
        if lv is None:
            levels.append(floor_db)
        else:
            levels.append(max(floor_db, lv))
    base = float(np.median(levels))
    return [float(np.clip(base - lv, -12.0, 12.0)) for lv in levels]


# ------------------------------------------------------------------ 主流程


def process_one(args):
    src, out_dir, name, cfg, dry = args
    path = os.path.join(src, "Samples", name + ".flac")

    try:
        x = decode(path)
    except subprocess.CalledProcessError as exc:
        return {"name": name, "error": exc.stderr.decode("utf-8", "replace")[:120]}

    x = energy_trim(x)
    total_s = len(x) / SR

    # 层内对齐用的响度：取前 2 秒的 RMS，避免长尾拉低中位数
    head = x[: 2 * SR]

    entry = {
        "name": name,
        "totalSeconds": round(total_s, 3),
        "peakDb": round(rms_db(head), 2),
        "attackSeconds": 0.0,
        "segments": [],
    }

    out_sub = os.path.join(out_dir, category_of(name))

    if cfg is None:
        # 非主音色（释放/踏板类）：整条输出，不分段
        entry["category"] = category_of(name)
        entry["attackSeconds"] = round(total_s, 3)
        entry["segments"] = ["full"]
        if not dry:
            os.makedirs(out_sub, exist_ok=True)
            encode(x, os.path.join(out_sub, name + ".flac"))
        return entry

    attack_n = min(len(x), int(cfg["attack"] * SR))
    attack = x[:attack_n]
    entry["attackSeconds"] = round(len(attack) / SR, 3)

    if not dry:
        os.makedirs(out_sub, exist_ok=True)
        encode(attack, os.path.join(out_sub, name + "_a.flac"))
    entry["segments"].append("attack")

    if cfg["loop"] is None:
        # 低音区：完整尾部保留，供流式读取
        tail = x[attack_n:]
        entry["tailSeconds"] = round(len(tail) / SR, 3)
        entry["segments"].append("tail")
        if not dry and len(tail) > 0:
            encode(tail, os.path.join(out_sub, name + "_t.flac"))
    else:
        loop, ratio = make_loop(x, cfg["attack"], cfg["loop"], cfg["xfade"])
        if loop is None:
            entry["loopFallback"] = True
            entry["segments"].append("no-loop")
        else:
            entry["loopSeconds"] = round(len(loop) / SR, 3)
            entry["loopRatioDb"] = round(ratio, 2)
            entry["segments"].append("loop")
            if not dry:
                encode(loop, os.path.join(out_sub, name + "_l.flac"))

    entry["category"] = category_of(name)
    return entry


def build_manifest(results, src, out):
    """按引擎侧契约组装 manifest。

    格式对应《落地实施方案》§3.5，并按「全无循环」方案调整：
    每个主音色只有 `attack`（常驻内存）与 `tail`（流式读取）两段，没有循环段。

    `attackFrames` / `tailFrames` 是供引擎预分配缓冲用的，必须与实际文件一致 ——
    对不上会导致尾部接续时出现空档。这里由编码时的秒数换算，与文件同源。
    """
    ok = {r["name"]: r for r in results if "error" not in r}

    def frames_of(r, key):
        return int(round(r.get(key, 0.0) * SR))

    # ---- 主音色：按根音分组，每根音下挂 16 个力度层 ----
    roots = {}
    for name, r in ok.items():
        m = MAIN_RE.match(name)
        if not m:
            continue
        root_name = m.group(1) + m.group(2)
        midi = note_to_midi(root_name)
        if midi is None:
            continue

        entry = roots.setdefault(midi, {"midi": midi, "name": root_name, "layers": []})
        layer = {
            "velocityLayer": int(m.group(3)),
            "attack": f"piano/{name}_a.flac",
            "attackFrames": frames_of(r, "attackSeconds"),
            "gainDb": 0.0,
        }
        if r.get("tailSeconds"):
            layer["tail"] = f"piano/{name}_t.flac"
            layer["tailFrames"] = frames_of(r, "tailSeconds")
        entry["layers"].append(layer)

    for root in roots.values():
        root["layers"].sort(key=lambda x: x["velocityLayer"])

    # ---- 释放类与踏板 ----
    # 锤击噪音：rel{N}，N 为 1..88 对应 MIDI 21..108，故 midi = N + 20
    hammer, harmonics, pedal_up, pedal_down = [], [], [], []
    for name, r in ok.items():
        frames = frames_of(r, "attackSeconds")
        if name.startswith("rel"):
            try:
                key_number = int(name[3:])
            except ValueError:
                continue
            hammer.append({"midi": key_number + 20,
                           "file": f"rel/{name}.flac", "frames": frames})
        elif name.startswith("harm"):
            m = re.match(r"^harm(S|L|V3)([A-G]#?\d+)$", name)
            if not m:
                continue
            midi = note_to_midi(m.group(2))
            if midi is None:
                continue
            harmonics.append({"midi": midi, "variant": m.group(1),
                              "file": f"harm/{name}.flac", "frames": frames})
        elif name.startswith("pedal"):
            item = {"file": f"pedal/{name}.flac", "frames": frames}
            (pedal_up if "U" in name else pedal_down).append(item)

    hammer.sort(key=lambda x: x["midi"])
    harmonics.sort(key=lambda x: (x["midi"], x["variant"]))

    return {
        "version": "1.0.0",
        "generator": "tools/audio-pipeline/build_samples.py",
        "sampleRate": SR,
        "bitsPerSample": 16,
        "channels": CHANNELS,
        "tuning": "retuned",
        "loops": False,          # 全无循环（「尽量仿真」决策，见技术方案 §2.3）
        "lowestMidi": 21,
        "highestMidi": 108,
        "velocityLayers": parse_velocity_layers(os.path.join(src, "Data", "notes.txt")),
        "rootNotes": [roots[k] for k in sorted(roots)],
        "release": {"hammer": hammer, "harmonics": harmonics},
        "pedal": {"up": pedal_up, "down": pedal_down},
    }


# ------------------------------------------------------------------ 二进制 manifest
#
# 为什么同时出 JSON 和二进制两份：
#
#   1. **不引入 JSON 解析依赖**。C++ 侧要读 manifest，而一个可靠的 JSON 解析器
#      是几百行必须写对、必须测的代码（nlohmann/json 之类的单头库又在 GitHub 上，
#      当前网络拿不到）。固定布局的二进制读取只要几十行，且能逐字节验证。
#   2. **启动更快**。manifest 有 480 个力度层条目，二进制是直接内存映射式读取。
#   3. JSON 保留为**人类可读的契约与调试入口**，两份由同一份数据生成，不会分叉。
#
# 布局（小端）：
#
#   Header（64 字节，不足补零）
#     0   char[4]  "PNOB"
#     4   u32      version
#     8   u32      sampleRate
#     12  u32      channels
#     16  u32      bitsPerSample
#     20  u32      lowestMidi
#     24  u32      highestMidi
#     28  u32      velocityLayerCount
#     32  u32      rootNoteCount
#     36  u32      hammerCount
#     40  u32      harmonicCount
#     44  u32      pedalUpCount
#     48  u32      pedalDownCount
#
#   速度层      × { u32 index, u32 minVelocity, u32 maxVelocity }
#   根音        × { u32 midi, u32 layerCount,
#                   层 × { u32 velocityLayer, u32 attackFrames, u32 tailFrames,
#                          f32 gainDb, str attackPath, str tailPath } }
#   锤击        × { u32 midi, u32 frames, str path }
#   弦共振      × { u32 midi, u32 frames, str variant, str path }
#   踏板        × { u32 frames, str path }
#
#   其中 str = u16 长度 + UTF-8 字节

MAGIC = b"PNOB"
BIN_VERSION = 1


def _u32(value):
    return struct.pack("<I", int(value))


def _f32(value):
    return struct.pack("<f", float(value))


def _str(text):
    data = (text or "").encode("utf-8")
    return struct.pack("<H", len(data)) + data


def emit_binary_manifest(manifest, path):
    out = bytearray()

    out += MAGIC
    out += _u32(BIN_VERSION)
    out += _u32(manifest["sampleRate"])
    out += _u32(manifest["channels"])
    out += _u32(manifest["bitsPerSample"])
    out += _u32(manifest["lowestMidi"])
    out += _u32(manifest["highestMidi"])
    out += _u32(len(manifest["velocityLayers"]))
    out += _u32(len(manifest["rootNotes"]))
    out += _u32(len(manifest["release"]["hammer"]))
    out += _u32(len(manifest["release"]["harmonics"]))
    out += _u32(len(manifest["pedal"]["up"]))
    out += _u32(len(manifest["pedal"]["down"]))
    out += b"\0" * (64 - len(out))          # 头部补齐到 64 字节

    for v in manifest["velocityLayers"]:
        out += _u32(v["index"]) + _u32(v["minVelocity"]) + _u32(v["maxVelocity"])

    for root in manifest["rootNotes"]:
        out += _u32(root["midi"])
        out += _u32(len(root["layers"]))
        for layer in root["layers"]:
            out += _u32(layer["velocityLayer"])
            out += _u32(layer.get("attackFrames", 0))
            out += _u32(layer.get("tailFrames", 0))
            out += _f32(layer.get("gainDb", 0.0))
            out += _str(layer.get("attack", ""))
            out += _str(layer.get("tail", ""))

    for item in manifest["release"]["hammer"]:
        out += _u32(item["midi"]) + _u32(item["frames"]) + _str(item["file"])

    for item in manifest["release"]["harmonics"]:
        out += _u32(item["midi"]) + _u32(item["frames"])
        out += _str(item["variant"]) + _str(item["file"])

    for item in manifest["pedal"]["up"]:
        out += _u32(item["frames"]) + _str(item["file"])
    for item in manifest["pedal"]["down"]:
        out += _u32(item["frames"]) + _str(item["file"])

    with open(path, "wb") as f:
        f.write(bytes(out))
    return len(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default="audio-src")
    ap.add_argument("--out", default="build-bank")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--dry-run", action="store_true",
                    help="只分析不写文件")
    ap.add_argument("--jobs", type=int, default=max(1, (os.cpu_count() or 4) // 2))
    args = ap.parse_args()

    samples_dir = os.path.join(args.src, "Samples")
    if not os.path.isdir(samples_dir):
        print(f"找不到 {samples_dir}", file=sys.stderr)
        return 2

    os.makedirs(os.path.join(args.out, "piano"), exist_ok=True)

    names = sorted(f[:-5] for f in os.listdir(samples_dir) if f.endswith(".flac"))
    mains = [n for n in names if MAIN_RE.match(n)]
    others = [n for n in names if not MAIN_RE.match(n)]
    if args.limit:
        # 调试用：限制的是**总任务数**，不只是主音色 ——
        # 否则跑 --limit 4 仍会处理全部 161 个释放采样，失去快速验证的意义
        mains = mains[: args.limit]
        others = others[: max(0, args.limit - len(mains))]

    print(f"主音色 {len(mains)} 个，其它（释放/踏板）{len(others)} 个，"
          f"并发 {args.jobs}{'（dry-run）' if args.dry_run else ''}\n")

    tasks = [(args.src, args.out, n, region_for(n), args.dry_run) for n in mains]
    tasks += [(args.src, args.out, n, None, args.dry_run) for n in others]

    results = []
    with ProcessPoolExecutor(max_workers=args.jobs) as pool:
        for i, r in enumerate(pool.map(process_one, tasks, chunksize=4), 1):
            results.append(r)
            if i % 40 == 0:
                print(f"  …{i}/{len(tasks)}")

    # ---------------------------------------------------------------- 汇总

    errors = [r for r in results if "error" in r]
    if errors:
        print(f"\n失败 {len(errors)} 个：")
        for r in errors[:10]:
            print(f"  {r['name']}: {r['error']}")

    by_region = {}
    for r in results:
        if "error" in r:
            continue
        cfg = region_for(r["name"]) if MAIN_RE.match(r["name"]) else None
        key = cfg["name"] if cfg else "other"
        by_region.setdefault(key, []).append(r)

    print()
    header = f"{'音区':<8}{'个数':>6}{'原始秒数':>10}{'产物秒数':>10}{'压缩比':>9}{'循环首尾差':>12}"
    print(header)
    print("-" * len(header))

    manifest = {"sampleRate": SR, "channels": CHANNELS, "regions": {}, "samples": []}

    for key in ("low", "mid", "high", "other"):
        rows = by_region.get(key)
        if not rows:
            continue
        total = sum(r["totalSeconds"] for r in rows)
        produced = sum(
            r["attackSeconds"] + r.get("tailSeconds", 0) + r.get("loopSeconds", 0)
            for r in rows)
        ratios = [r["loopRatioDb"] for r in rows if "loopRatioDb" in r]
        ratio_txt = f"{np.mean(ratios):.1f} dB" if ratios else "-"
        print(f"{key:<8}{len(rows):>6}{total:>9.0f}s{produced:>9.0f}s"
              f"{produced / total * 100:>8.0f}%{ratio_txt:>12}")

    total_all = sum(r["totalSeconds"] for r in results if "error" not in r)
    produced_all = sum(r["attackSeconds"] + r.get("tailSeconds", 0) + r.get("loopSeconds", 0)
                       for r in results if "error" not in r)
    print("-" * len(header))
    print(f"{'合计':<8}{len([r for r in results if 'error' not in r]):>6}"
          f"{total_all:>9.0f}s{produced_all:>9.0f}s"
          f"{produced_all / total_all * 100:>8.0f}%")

    if not args.dry_run:
        manifest = build_manifest(results, args.src, args.out)
        mpath = os.path.join(args.out, "manifest.json")
        with open(mpath, "w", encoding="utf-8") as f:
            json.dump(manifest, f, ensure_ascii=False, indent=1)

        bpath = os.path.join(args.out, "manifest.bin")
        bsize = emit_binary_manifest(manifest, bpath)

        roots = manifest["rootNotes"]
        layers = sum(len(r["layers"]) for r in roots)
        print(f"\nmanifest 已写入 {mpath}")
        print(f"  二进制版 {bpath}（{bsize / 1024:.0f} KB，供引擎加载）")
        print(f"  根音 {len(roots)} 个，力度层 {layers} 个，"
              f"力度区间 {len(manifest['velocityLayers'])} 条")
        print(f"  释放类：锤击 {len(manifest['release']['hammer'])} 个，"
              f"弦共振 {len(manifest['release']['harmonics'])} 个；"
              f"踏板 {len(manifest['pedal']['up']) + len(manifest['pedal']['down'])} 个")

        size = sum(os.path.getsize(os.path.join(dp, fn))
                   for dp, _, fns in os.walk(args.out)
                   for fn in fns if fn.endswith(".flac"))
        print(f"输出体积 {size / 1024 / 1024:.0f} MB")

    return 0 if not errors else 1


if __name__ == "__main__":
    sys.exit(main())
