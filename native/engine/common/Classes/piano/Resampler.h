/****************************************************************************
 * 钢琴音频内核 —— 重采样
 *
 * 采样是按小三度铺的（30 个根音覆盖 88 键），所以每个音都要变调 ——
 * 最多 ±1 个半音。这决定了插值器的选择。
 *
 * ## 为什么不用线性插值
 *
 * 线性插值本质是个一阶低通，误差随频率升高而增大。要命的是它造成的
 * **高频滚降会随变调比例改变** —— 同一个根音往上和往下变调时，音色会
 * 往两个方向偏。相邻半音本来就该听着一样，这种偏差虽然小但能听出来。
 *
 * Hermite（Catmull-Rom）是 4 点三次插值，误差低一个数量级以上，
 * 代价是每帧多几次乘加 —— 对 64 复音、48kHz 来说完全可以接受。
 *
 * ## 边界处理
 *
 * 插值需要当前位置前后各两个点。在采样的头尾会越界，这里对索引做钳位
 * （而不是补零）—— 补零会在音尾造成一次突变，听起来是"啪"的一声。
 ****************************************************************************/

#pragma once

#include <cmath>
#include <cstdint>

namespace piano {

/** int16 定点 → float 的归一化系数 */
constexpr float kInt16Scale = 1.0f / 32768.0f;

/**
 * 在给定位置对立体声交错数据做 4 点 Hermite 插值。
 *
 * @param data    立体声交错 PCM
 * @param frames  总帧数
 * @param position 浮点帧位置，[0, frames-1)
 * @param outL/outR 输出
 */
inline void resampleHermite(const int16_t* data, uint32_t frames, double position,
                            float& outL, float& outR) {
    const int64_t index = static_cast<int64_t>(position);
    const float t = static_cast<float>(position - static_cast<double>(index));

    // 钳位而非补零：补零会在头尾制造一次突变
    const int64_t last = static_cast<int64_t>(frames) - 1;
    auto clampIndex = [last](int64_t i) -> int64_t {
        if (i < 0) return 0;
        if (i > last) return last;
        return i;
    };

    const int64_t i0 = clampIndex(index - 1);
    const int64_t i1 = clampIndex(index);
    const int64_t i2 = clampIndex(index + 1);
    const int64_t i3 = clampIndex(index + 2);

    const int16_t* p = data;
    const auto loadL = [p](int64_t i) { return static_cast<float>(p[i * 2]) * kInt16Scale; };
    const auto loadR = [p](int64_t i) { return static_cast<float>(p[i * 2 + 1]) * kInt16Scale; };

    auto hermite = [t](float p0, float p1, float p2, float p3) {
        // Catmull-Rom 基函数展开式
        const float c0 = p1;
        const float c1 = 0.5f * (p2 - p0);
        const float c2 = p0 - 2.5f * p1 + 2.0f * p2 - 0.5f * p3;
        const float c3 = 0.5f * (p3 - p0) + 1.5f * (p1 - p2);
        return ((c3 * t + c2) * t + c1) * t + c0;
    };

    outL = hermite(loadL(i0), loadL(i1), loadL(i2), loadL(i3));
    outR = hermite(loadR(i0), loadR(i1), loadR(i2), loadR(i3));
}

/**
 * 由「目标音高与根音的半音差」和「源/目标采样率之比」算出播放速率。
 *
 * 采样率之比当前恒为 1（音源与设备都是 48kHz），但保留这个因子 ——
 * 一旦要支持 44.1kHz 设备，漏掉它会造成整体音高错误，而且这种错误
 * 在开发机上（同为 48k）根本听不出来。
 */
inline double playbackRatio(int32_t targetMidi, int32_t rootMidi,
                            int32_t sourceSampleRate, int32_t deviceSampleRate) {
    const double semitones = static_cast<double>(targetMidi - rootMidi);
    const double rate = sourceSampleRate > 0 && deviceSampleRate > 0
                            ? static_cast<double>(sourceSampleRate) /
                                  static_cast<double>(deviceSampleRate)
                            : 1.0;
    // 2^(n/12) —— 用 exp2 比 pow 快且对这一用途足够
    return exp2(semitones / 12.0) * rate;
}

}  // namespace piano
