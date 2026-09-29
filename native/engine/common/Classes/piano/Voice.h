/****************************************************************************
 * 钢琴音频内核 —— 单个发声中的音
 *
 * 对应《横屏高仿真钢琴落地实施方案》M1-3。
 *
 * ## 为什么包络很简单
 *
 * 钢琴的振幅包络**已经在采样里了** —— 每个音都录了完整的自然衰减。
 * 所以引擎不需要合成 ADSR 去塑形，只需要处理采样本身没有的两件事：
 *
 *   1. **松开时的淡出**。note-off 之后不能让声音戛然而止（会有咔哒声），
 *      也不能让它继续按原样衰减（真实钢琴的制音器会立刻压住琴弦）。
 *   2. **复音偷取时的快速淡出**。偷一个正在发声的音时同样不能直接掐断。
 *
 * 因此只有一个释放斜坡，没有 attack/decay/sustain 三段。
 ****************************************************************************/

#pragma once

#include <cstdint>

#include "SampleBank.h"

namespace piano {

/** 释放斜坡的默认时长（秒）。够短听不出拖沓，够长不产生咔哒 */
constexpr float kDefaultReleaseSeconds = 0.08f;

/**
 * 采样末尾的淡出帧数（48kHz 下 240 帧 = 5ms）。
 *
 * 防止采样在非零处结束时切出爆音。对正常衰减到 -90dB 的尾巴完全无感。
 */
constexpr uint32_t kEndFadeFrames = 240;

class Voice {
public:
    Voice() = default;

    Voice(const Voice&)            = delete;
    Voice& operator=(const Voice&) = delete;

    /**
     * 开始发声。
     *
     * @param layer      要播放的采样层（必须已常驻）
     * @param pitchRatio 播放速率，由 Resampler.h 的 playbackRatio 算出
     * @param gain       总增益（力度换算后的结果）
     * @param midi       音高，供复音管理与调试用
     * @param startFrame 起始帧号，供偷取策略按「谁更早」排序
     */
    void start(const SampleLayer& layer, double pitchRatio, float gain,
               uint8_t midi, uint32_t startFrame);

    /**
     * 进入释放。
     *
     * @param seconds 淡出时长。0 表示用默认值
     * @param sampleRate 设备采样率
     */
    void release(float seconds, int32_t sampleRate);

    /** 立即静音（不淡出）。仅用于停止音频流这类可以接受咔哒的场合。 */
    void killImmediate();

    /**
     * 渲染并**累加**到输出缓冲。
     *
     * 累加而不是覆盖 —— 多个 voice 共用同一条混音总线。
     *
     * @param out    立体声交错输出，长度 frames*2
     * @param frames 帧数
     */
    void renderAdd(float* out, int32_t frames);

    // ---------------------------------------------------------------- 状态

    bool isActive() const { return _active; }
    bool isReleasing() const { return _releasing; }
    uint8_t midi() const { return _midi; }
    uint32_t startFrame() const { return _startFrame; }

    /** 当前包络值 0..1。偷取策略据此挑「最弱」的音 */
    float envelope() const { return _envelope; }

    /** 已播放的帧数，诊断用 */
    uint32_t playedFrames() const { return _playedFrames; }

private:
    const SampleLayer* _layer = nullptr;

    /** 采样中的浮点帧位置 */
    double _position = 0.0;
    /** 每输出一帧前进多少（变调比例） */
    double _ratio = 1.0;
    float _gain = 1.0f;

    /** 释放斜坡：每帧递减量 */
    float _releaseStep = 0.0f;
    float _envelope = 1.0f;

    bool _active = false;
    bool _releasing = false;

    uint8_t _midi = 0;
    uint32_t _startFrame = 0;
    uint32_t _playedFrames = 0;
};

}  // namespace piano
