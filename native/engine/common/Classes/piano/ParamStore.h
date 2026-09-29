/****************************************************************************
 * 钢琴音频内核 —— 参数存储
 *
 * 从 PianoEngine::Impl 里拆出来的独立职责：参数的定长存储、边界校验与默认值。
 * 参数语义（谁读、读来干什么）属于 M4，这里是纯粹的容器。
 ****************************************************************************/

#pragma once

#include "PianoParams.h"

namespace piano {

/**
 * 可调参数的存储。
 *
 * ## ⚠️ 线程约定（M4 之前必须解决）
 *
 * 目前是**普通 `float` 数组**，没有无锁化 —— UI 线程写、音频线程将来读。
 * 现在不构成问题（参数还没有任何读取方），但 M4 一旦真的让参数参与音频渲染，
 * 这就是数据竞争：需要换成原子量、双缓冲或 `SEQLOCK`。
 * 这条约束写在这里而不是留在调用处，是因为它属于这个类自己的约定。
 */
class ParamStore {
public:
    /** 按 ID 取参数。ID 越界返回 `fallback` */
    float value(ParamId id, float fallback = 0.0f) const noexcept {
        const size_t idx = static_cast<size_t>(id);
        return idx < kParamCount ? _values[idx] : fallback;
    }

    /**
     * 按 ID 设置参数。
     *
     * @returns 是否被接受。ID 越界返回 false，由调用方决定怎么记日志 ——
     *          容器自己不输出日志，免得在音频路径上被间接调用时产生 IO。
     */
    bool set(ParamId id, float v) noexcept {
        const size_t idx = static_cast<size_t>(id);
        if (idx >= kParamCount) {
            return false;
        }
        _values[idx] = v;
        return true;
    }

    /**
     * 恢复默认值。
     *
     * 逐项写死而不是用统一初值 —— 这些默认值就是「一台正常钢琴」的定义
     * （主音量满、明亮度中性、琴盖全开、A4=440），改它们等于改出厂手感。
     */
    void resetToDefaults() noexcept {
        _values[static_cast<size_t>(ParamId::MasterVolume)]    = 1.0f;
        _values[static_cast<size_t>(ParamId::Brightness)]      = 0.0f;
        _values[static_cast<size_t>(ParamId::LidPosition)]     = 1.0f;
        _values[static_cast<size_t>(ParamId::ReverbMix)]       = 0.25f;
        _values[static_cast<size_t>(ParamId::ReverbSize)]      = 0.5f;
        _values[static_cast<size_t>(ParamId::ReverbDecay)]     = 0.5f;
        _values[static_cast<size_t>(ParamId::ReverbDamping)]   = 0.5f;
        _values[static_cast<size_t>(ParamId::TuningA4)]        = 440.0f;
        _values[static_cast<size_t>(ParamId::ReleaseLevel)]    = 1.0f;
        _values[static_cast<size_t>(ParamId::HammerLevel)]     = 1.0f;
        _values[static_cast<size_t>(ParamId::PedalNoiseLevel)] = 1.0f;
        _values[static_cast<size_t>(ParamId::VelocityDepth)]   = 1.0f;
    }

private:
    float _values[kParamCount] = {};
};

}  // namespace piano
