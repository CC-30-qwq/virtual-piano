/****************************************************************************
 * 钢琴音频内核 —— manifest 解析
 *
 * 二进制格式的定义与解析都在这里（生成端见 tools/audio-pipeline/build_samples.py）。
 *
 * 从 SampleBank 里拆出来的原因：格式细节（魔数、版本、头长、字段顺序）与
 * 「载入哪些层、怎么查表」是两件不同的事 —— 前者会随音源流水线变，
 * 后者会随播放策略变。混在一起时，改任何一个都要读同一个 350 行的文件。
 ****************************************************************************/

#pragma once

#include "BankModel.h"

#include <cstddef>
#include <cstdint>
#include <vector>

namespace piano {

/** 一份 manifest 解析出来的全部内容 */
struct ManifestData {
    int32_t sampleRate = 48000;
    int32_t channels = 2;
    int32_t bitsPerSample = 16;
    int32_t lowestMidi = 21;
    int32_t highestMidi = 108;

    std::vector<VelocityRange> velocityRanges;
    std::vector<RootNote> roots;

    std::vector<AuxSample> hammer;
    std::vector<AuxSample> harmonics;
    std::vector<AuxSample> pedalUp;
    std::vector<AuxSample> pedalDown;
};

/**
 * 解析二进制 manifest。
 *
 * manifest 是从资源包里读的，**可能被截断或损坏** —— 每个字段都做边界检查，
 * 失败时干净地返回 false，而不是让用户看到启动闪退。
 *
 * @param data 原始字节
 * @param size 字节数
 * @param out  解析结果。**失败时内容不作保证**，调用方应当丢弃它
 *             （`SampleBank::loadManifest` 就是在失败路径上把银行整体清空的）
 * @return 是否解析成功
 */
bool parseManifest(const uint8_t* data, size_t size, ManifestData& out);

}  // namespace piano
