/****************************************************************************
 * 钢琴音频内核 —— 复音管理实现
 ****************************************************************************/

#include "VoicePool.h"

#include <cmath>

#include "Resampler.h"

namespace piano {
namespace {

float clampf(float v, float lo, float hi) {
    return v < lo ? lo : (v > hi ? hi : v);
}

}  // namespace

void VoicePool::noteOn(uint8_t midi, uint8_t velocity, uint32_t startFrame) {
    // acquire 一次、用局部指针 —— 见 `setBank` 的说明。
    // 顺带也省掉了后面每次访问都做一次原子读。
    SampleBank* const bank = _bank.load(std::memory_order_acquire);
    if (bank == nullptr || !bank->loaded()) {
        // 还没载入音源（或正在后台载入）。此时按下去无声是预期行为。
        return;
    }

    const RootNote* root = bank->findRoot(midi);
    if (root == nullptr) {
        return;
    }

    const SampleLayer* layer = bank->findLayer(*root, velocity);
    if (layer == nullptr || !layer->resident()) {
        // 该根音一个层都没载入。宁可不出声也不要读野指针 ——
        // 载入是分档的，低端机上确实可能整片没载入。
        return;
    }

    const int32_t sampleRate = _sampleRate.load(std::memory_order_relaxed);

    // 同一个音重新触发时，把之前那个（未挂起的）先放掉。
    // 真实钢琴重击同一根弦时，旧振动会被新的取代；不处理的话两个音会叠起来，
    // 听感上像是音量突然翻倍。
    for (int i = 0; i < kMaxVoices; ++i) {
        Voice& v = _voices[i];
        if (v.isActive() && !v.isReleasing() && !_sustained[i] && v.midi() == midi) {
            v.release(0.03f, sampleRate);
        }
    }

    Voice* voice = allocate();
    if (voice == nullptr) {
        return;
    }

    // 采样是按小三度铺的，这里把音高差换算成播放速率
    const double ratio = playbackRatio(static_cast<int32_t>(midi), root->midi,
                                       bank->sampleRate(), sampleRate);

    voice->start(*layer, ratio, velocityGain(bank, velocity), midi, startFrame);
}

float VoicePool::velocityGain(const SampleBank* bank, uint8_t velocity) const {
    // 层选择已经把大跨度的动态分掉了（16 层），这里只做**层内的微调**。
    //
    // 层内的力度差映射到 ±3 dB。不做成完整的力度平方律 —— 那会和采样本身
    // 已经录好的动态叠加，同一层内从最轻弹到最响会拉开几十 dB，明显不对。
    const VelocityRange* range = nullptr;
    for (const VelocityRange& r : bank->velocityRanges()) {
        if (velocity >= r.minVelocity && velocity <= r.maxVelocity) {
            range = &r;
            break;
        }
    }
    if (range == nullptr || range->maxVelocity <= range->minVelocity) {
        return 1.0f;
    }

    const float center = 0.5f * (range->minVelocity + range->maxVelocity);
    const float half = 0.5f * static_cast<float>(range->maxVelocity - range->minVelocity);
    const float t = clampf((static_cast<float>(velocity) - center) / (half > 0.0f ? half : 1.0f),
                           -1.0f, 1.0f);

    return std::pow(10.0f, t * 3.0f / 20.0f);
}

void VoicePool::noteOff(uint8_t midi) {
    const int32_t sampleRate = _sampleRate.load(std::memory_order_relaxed);

    for (int i = 0; i < kMaxVoices; ++i) {
        Voice& v = _voices[i];
        if (!v.isActive() || v.isReleasing() || v.midi() != midi) {
            continue;
        }

        if (_pedalDown) {
            // 踏板踩着：制音器没落下去，弦继续振动。只做标记，等踏板抬起再放。
            _sustained[i] = true;
        } else {
            v.release(0.0f, sampleRate);
        }
    }
}

void VoicePool::setPedal(bool down) {
    if (_pedalDown == down) {
        return;
    }
    _pedalDown = down;

    if (!down) {
        applyPedalRelease();
    }
}

void VoicePool::setPedalValue(uint8_t value) {
    _pedalValue = value;
    // 半踏板：值越小，制音器压得越实、释放越快。
    // 这里映射到 0.03s（几乎立刻停）到 0.4s（接近全放）之间。
    setPedal(value >= 64);
}

void VoicePool::applyPedalRelease() {
    // 踏板抬起：所有挂起的音真正进入释放。
    // 释放时长随踏板值变化 —— 半踩时制音器只是轻触琴弦，衰减比全放要慢。
    const float seconds = 0.03f + (static_cast<float>(_pedalValue) / 127.0f) * 0.37f;
    const int32_t sampleRate = _sampleRate.load(std::memory_order_relaxed);

    for (int i = 0; i < kMaxVoices; ++i) {
        if (_sustained[i] && _voices[i].isActive() && !_voices[i].isReleasing()) {
            _voices[i].release(seconds, sampleRate);
        }
        _sustained[i] = false;
    }
}

void VoicePool::allNotesOff(bool immediate) {
    const int32_t sampleRate = _sampleRate.load(std::memory_order_relaxed);

    for (int i = 0; i < kMaxVoices; ++i) {
        if (!_voices[i].isActive()) {
            continue;
        }
        if (immediate) {
            _voices[i].killImmediate();
        } else {
            _voices[i].release(0.0f, sampleRate);
        }
        _sustained[i] = false;
    }
}

Voice* VoicePool::allocate() {
    // 1) 空闲的
    for (int i = 0; i < kMaxVoices; ++i) {
        if (!_voices[i].isActive()) {
            _sustained[i] = false;
            return &_voices[i];
        }
    }

    // 2) 全在用：优先偷「释放态且包络最低」的 —— 它本来就在消失
    int best = -1;
    float lowest = 2.0f;
    for (int i = 0; i < kMaxVoices; ++i) {
        if (_voices[i].isReleasing() && _voices[i].envelope() < lowest) {
            lowest = _voices[i].envelope();
            best = i;
        }
    }
    if (best >= 0) {
        _sustained[best] = false;
        return &_voices[best];
    }

    // 3) 一个都没在释放（64 键全按住，或踏板踩着一大片）：偷启动最早的。
    //
    // 这一路会有可闻的截断 —— 固定槽位没法让旧音淡出的同时让新音进来。
    // 64 复音全满在真实演奏里极少见，先接受；要彻底解决得引入双缓冲槽位。
    uint32_t earliest = 0xFFFFFFFFu;
    for (int i = 0; i < kMaxVoices; ++i) {
        if (_voices[i].startFrame() <= earliest) {
            earliest = _voices[i].startFrame();
            best = i;
        }
    }
    if (best >= 0) {
        _sustained[best] = false;
        return &_voices[best];
    }
    return nullptr;
}

void VoicePool::renderAdd(float* out, int32_t frames) {
    for (int i = 0; i < kMaxVoices; ++i) {
        if (_voices[i].isActive()) {
            _voices[i].renderAdd(out, frames);
        }
    }
}

int VoicePool::activeCount() const {
    int n = 0;
    for (int i = 0; i < kMaxVoices; ++i) {
        if (_voices[i].isActive()) {
            ++n;
        }
    }
    return n;
}

int VoicePool::releasingCount() const {
    int n = 0;
    for (int i = 0; i < kMaxVoices; ++i) {
        if (_voices[i].isActive() && _voices[i].isReleasing()) {
            ++n;
        }
    }
    return n;
}

}  // namespace piano
