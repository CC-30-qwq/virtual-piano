/****************************************************************************
 * 钢琴音频内核 —— 音源库数据模型
 *
 * 这里只有「音源包长什么样」：采样层、根音、力度区间、释放类采样的元数据。
 * 解析（ManifestReader）、内存池（SamplePool）与查表（SampleBank）都建立在这组
 * 结构之上，但它们各自独立。
 *
 * 拆出来的原因：这些结构原先和 SampleBank 的解析、内存池混在一个类里，
 * 于是「换一种音源格式」要动同一个类，「换一种内存策略」也要动同一个类。
 ****************************************************************************/

#pragma once

#include <cstdint>
#include <string>

namespace piano {

/** 力度层数量上限（Salamander 是 16 层） */
constexpr int kMaxVelocityLayers = 16;
/** 根音数量上限（Salamander 是 30 个） */
constexpr int kMaxRootNotes = 64;

/** 单个力度层的采样 */
struct SampleLayer {
    /** 常驻 PCM，立体声交错。未载入时为 nullptr */
    const int16_t* attack = nullptr;
    uint32_t attackFrames = 0;

    /** 尾部帧数。M1-6 之前只记元数据，不做流式读取 */
    uint32_t tailFrames = 0;

    /** 线性增益（由 manifest 的 gainDb 换算） */
    float gain = 1.0f;

    /** 对应的原始力度层编号 1..16 */
    uint8_t velocityLayer = 0;

    /**
     * 常驻段的相对路径（相对音源包根目录）。
     *
     * 载入时用；载入完成后不再改动，音频线程只读不受影响。
     * 尾部（`tail`）的路径不在层里 —— M1-6 做流式时再补上，
     * 那之前的版本根本不会去读它。
     */
    std::string attackPath;

    bool resident() const { return attack != nullptr; }
};

/** 一个根音（小三度采样的一个采样点），覆盖它上下各一个半音 */
struct RootNote {
    int32_t midi = 0;
    uint8_t layerCount = 0;
    SampleLayer layers[kMaxVelocityLayers];

    /** 该根音是否有任何一层已载入 */
    bool anyResident() const {
        for (uint8_t i = 0; i < layerCount; ++i) {
            if (layers[i].resident()) return true;
        }
        return false;
    }
};

/** 力度层 → MIDI 力度的映射区间（Salamander 是非均匀划分的） */
struct VelocityRange {
    uint8_t index = 0;
    uint8_t minVelocity = 0;
    uint8_t maxVelocity = 127;
};

/** 释放类/踏板采样的元数据（M1-5 才用得到，这里先解析出来备用） */
struct AuxSample {
    int32_t midi = 0;
    uint32_t frames = 0;
    std::string path;
    std::string variant;
};

}  // namespace piano
