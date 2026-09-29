/****************************************************************************
 * 钢琴音频内核 —— 参数 ID 与全局常量
 *
 * 对应《横屏高仿真钢琴落地实施方案》§3.3。
 * ParamId 的取值与 TS 侧 `PianoTypes.ts` 的 `ParamId` 必须逐项一致。
 ****************************************************************************/

#pragma once

#include <cstdint>

namespace piano {

/**
 * 可调参数 ID。
 *
 * 新增参数只能追加在末尾并同步更新 TS 侧枚举 —— 插入到中间会让所有已保存的
 * 用户设置静默错位。
 */
enum class ParamId : uint16_t {
    MasterVolume    = 0,   ///< 主音量            0..1
    Brightness      = 1,   ///< 明亮度            -1..1，0 为中性
    LidPosition     = 2,   ///< 琴盖开合          0..1，0 为合上
    ReverbMix       = 3,   ///< 混响湿声比例      0..1
    ReverbSize      = 4,   ///< 混响空间大小      0..1
    ReverbDecay     = 5,   ///< 混响衰减时间      0..1
    ReverbDamping   = 6,   ///< 混响高频阻尼      0..1
    TuningA4        = 7,   ///< A4 基准频率       415..450 (Hz)
    ReleaseLevel    = 8,   ///< 释放采样音量      0..1
    HammerLevel     = 9,   ///< 锤击噪音音量      0..1
    PedalNoiseLevel = 10,  ///< 踏板噪音音量      0..1
    VelocityDepth   = 11,  ///< 力度动态范围      0..1
};

/**
 * 复音上限。
 *
 * VoicePool 按此值**预分配全部 voice**，运行期不再做任何分配 ——
 * 音频回调里出现 malloc 会直接导致爆音甚至崩溃（见《落地方案》§3.4）。
 */
constexpr int kMaxVoices = 64;

/**
 * 事件队列容量（必须是 2 的幂，环形队列用位与代替取模）。
 *
 * 2048 个事件在 60fps 下相当于每帧 34 个音符的余量，远超实际演奏密度。
 */
constexpr uint32_t kEventQueueCapacity = 2048;

}  // namespace piano
