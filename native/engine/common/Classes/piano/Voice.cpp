/****************************************************************************
 * 钢琴音频内核 —— 单音实现
 ****************************************************************************/

#include "Voice.h"

#include "Resampler.h"

namespace piano {

void Voice::start(const SampleLayer& layer, double pitchRatio, float gain,
                  uint8_t midi, uint32_t startFrame) {
    _layer = &layer;
    _position = 0.0;
    _ratio = pitchRatio > 0.0 ? pitchRatio : 1.0;
    _gain = gain;
    _envelope = 1.0f;
    _releaseStep = 0.0f;
    _releasing = false;
    _active = true;
    _midi = midi;
    _startFrame = startFrame;
    _playedFrames = 0;
}

void Voice::release(float seconds, int32_t sampleRate) {
    if (!_active || _releasing) {
        return;
    }
    const float duration = seconds > 0.0f ? seconds : kDefaultReleaseSeconds;
    const float frames = duration * static_cast<float>(sampleRate > 0 ? sampleRate : 48000);
    // 每帧递减量。用当前包络值算步长，保证从任意包络位置都能在
    // 相同时长内归零 —— 否则偷取时（包络已经被衰减过）会淡得特别快。
    _releaseStep = frames > 0.0f ? _envelope / frames : 1.0f;
    _releasing = true;
}

void Voice::killImmediate() {
    _active = false;
    _releasing = false;
    _layer = nullptr;
    _envelope = 0.0f;
}

void Voice::renderAdd(float* out, int32_t frames) {
    if (!_active || _layer == nullptr || _layer->attack == nullptr) {
        return;
    }

    const int16_t* data = _layer->attack;
    const uint32_t totalFrames = _layer->attackFrames;
    if (totalFrames < 4) {
        // 短于插值所需的最小长度，直接结束 —— 不能让它读到越界
        _active = false;
        return;
    }

    // 采样播完就自然结束。留出 2 帧余量给插值的后向取点。
    const double endPosition = static_cast<double>(totalFrames) - 2.0;
    const double fadeFrames = static_cast<double>(kEndFadeFrames);
    const double fadeStart = endPosition - fadeFrames;

    for (int32_t i = 0; i < frames; ++i) {
        if (_position >= endPosition) {
            _active = false;
            return;
        }

        float l = 0.0f;
        float r = 0.0f;
        resampleHermite(data, totalFrames, _position, l, r);

        // 末尾淡出。
        //
        // 直接切在采样末尾会让波形停在半周期上，"啪"一声。真实钢琴采样
        // 末尾已经衰减到 -90dB 所以听不出来，但不该依赖素材的善意 ——
        // 换一套音源、或者某条采样被裁得比较狠，问题就冒出来了。
        // 5ms 的淡出对正常衰减的尾巴完全无感。
        float endFade = 1.0f;
        if (_position > fadeStart) {
            const double remaining = (endPosition - _position) / fadeFrames;
            endFade = remaining > 0.0 ? static_cast<float>(remaining) : 0.0f;
        }

        const float g = _gain * _envelope * _layer->gain * endFade;
        out[i * 2 + 0] += l * g;
        out[i * 2 + 1] += r * g;

        _position += _ratio;
        ++_playedFrames;

        if (_releasing) {
            _envelope -= _releaseStep;
            if (_envelope <= 0.0f) {
                _envelope = 0.0f;
                _active = false;
                return;
            }
        }
    }
}

}  // namespace piano
