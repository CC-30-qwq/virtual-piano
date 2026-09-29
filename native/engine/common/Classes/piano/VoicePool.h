/****************************************************************************
 * 钢琴音频内核 —— 复音管理
 *
 * 对应《横屏高仿真钢琴落地实施方案》M1-4。
 *
 * ## 为什么固定 64 个 voice
 *
 * voice 全部**预分配**在数组里，运行期不做任何分配 —— 这个类的方法会在
 * 音频线程上被调用（`renderAdd`）或者为它准备数据（`noteOn`），
 * 一旦发生堆分配就是爆音。见《技术方案》§4.4 的实时线程约束。
 *
 * ## 偷取策略
 *
 * 复音用完时必须挑一个 voice 顶掉。顺序：
 *
 *   1. **已经进入释放态的、包络最低的** —— 它本来就在消失，顶掉最不容易被听出来
 *   2. 都不在释放态时，**启动最早的** —— 最老的那个通常已经衰减得差不多了
 *
 * 反过来（一上来就偷最新的）会让刚按下的音被掐掉，听感上像是"漏音"，
 * 而且很难复现。
 ****************************************************************************/

#pragma once

#include <cstdint>

#include "PianoParams.h"   // kMaxVoices
#include "SampleBank.h"
#include "Voice.h"

namespace piano {

class VoicePool {
public:
    VoicePool() = default;

    VoicePool(const VoicePool&)            = delete;
    VoicePool& operator=(const VoicePool&) = delete;

    /** 绑定音源库。必须在任何 noteOn 之前调用。 */
    void setBank(SampleBank* bank) { _bank = bank; }

    /** 通知设备采样率（释放斜坡的时长按它换算） */
    void setSampleRate(int32_t sampleRate) { _sampleRate = sampleRate > 0 ? sampleRate : 48000; }

    /**
     * 触发一个音。
     *
     * @param startFrame 起始帧号，供偷取策略按「谁更早」排序
     */
    void noteOn(uint8_t midi, uint8_t velocity, uint32_t startFrame);

    /** 松开一个音。踏板踩下时不真正释放，只做标记。 */
    void noteOff(uint8_t midi);

    /** 踏板状态。踩下时 noteOff 只挂起，抬起时才真正释放。 */
    void setPedal(bool down);

    /** 立即或渐进地停掉所有音 */
    void allNotesOff(bool immediate);

    /** 把全部发声中的音累加到输出缓冲 */
    void renderAdd(float* out, int32_t frames);

    int activeCount() const;
    int releasingCount() const;

    /** 当前踩下的踏板值 0..127（半踏板用） */
    void setPedalValue(uint8_t value);

private:
    /** 找一个可用的 voice；没有空闲的就按策略偷一个 */
    Voice* allocate();

    /** 由力度算出层内增益 */
    float velocityGain(uint8_t velocity) const;

    void applyPedalRelease();

    SampleBank* _bank = nullptr;
    int32_t _sampleRate = 48000;

    Voice _voices[kMaxVoices];
    uint32_t _frameCounter = 0;

    bool _pedalDown = false;
    uint8_t _pedalValue = 0;

    /** 因踏板踩下而被挂起、尚未真正释放的音 */
    bool _sustained[kMaxVoices] = {};
};

}  // namespace piano
