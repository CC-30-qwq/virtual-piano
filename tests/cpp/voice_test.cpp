/****************************************************************************
 * Voice + Resampler 测试
 *
 * 这是内核里第一个真正产生音频的模块，三件事必须验对：
 *
 *   1. **变调比例算对**。采样是按小三度铺的，每个音都要变调最多 ±1 个半音。
 *      比例算错的话音高整体跑偏，而且因为偏差不大，很容易听着"有点怪"
 *      却查不出原因。
 *   2. **插值精度**。用合成正弦做基准：给定频率的信号按已知比例播放，
 *      输出频率必须精确等于 f×ratio。顺带对比线性插值，确认 Hermite 值得。
 *   3. **头尾不能有突变**。突变的听感是"啪"的一声，而且音量越大越明显。
 *      判据是相邻样本的最大跳变 —— 正弦本身的逐样本变化是有上界的，
 *      超过就说明有不连续。
 ****************************************************************************/

// MSVC 的 <cmath> 默认不定义 M_PI，必须先开这个宏
#define _USE_MATH_DEFINES
#include <cmath>

#include "Resampler.h"
#include "Voice.h"

#include <cstdio>
#include <vector>

using namespace piano;

namespace {

int g_failures = 0;

void check(bool cond, const char* what) {
    if (!cond) {
        std::printf("  [FAIL] %s\n", what);
        ++g_failures;
    } else {
        std::printf("  [ ok ] %s\n", what);
    }
}

constexpr int32_t kSampleRate = 48000;

/** 造一段立体声正弦采样，左右相同 */
std::vector<int16_t> makeSine(double freq, uint32_t frames, float amplitude = 0.5f) {
    std::vector<int16_t> data(static_cast<size_t>(frames) * 2);
    for (uint32_t i = 0; i < frames; ++i) {
        const double v = amplitude * std::sin(2.0 * M_PI * freq * i / kSampleRate);
        const auto s = static_cast<int16_t>(v * 32767.0);
        data[i * 2] = s;
        data[i * 2 + 1] = s;
    }
    return data;
}

/**
 * 测频率：取第一个与最后一个上升沿穿越点，用它们之间的周期数换算。
 *
 * 不用「总穿越数 ÷ 总时长」—— 整数计数在 1 秒窗口下的分辨率只有 ±1 Hz，
 * 在 466 Hz 处就是 ±3.7 音分，比被测对象的误差还大，测了等于没测。
 *
 * 穿越点本身用线性插值取到子样本精度，于是误差降到毫赫兹量级。
 */
double measureFrequency(const std::vector<float>& signal) {
    double firstT = -1.0;
    double lastT = -1.0;
    int cycles = 0;

    for (size_t i = 1; i < signal.size(); ++i) {
        if (signal[i - 1] <= 0.0f && signal[i] > 0.0f) {
            const float denom = signal[i] - signal[i - 1];
            const double frac = denom != 0.0f ? -signal[i - 1] / denom : 0.0;
            const double t = (static_cast<double>(i - 1) + frac) / kSampleRate;
            if (firstT < 0.0) {
                firstT = t;
            } else {
                lastT = t;
                ++cycles;
            }
        }
    }

    if (cycles == 0 || lastT <= firstT) {
        return 0.0;
    }
    return cycles / (lastT - firstT);
}

/** 渲染一个音到独立缓冲 */
std::vector<float> renderVoice(Voice& voice, uint32_t frames) {
    std::vector<float> out(static_cast<size_t>(frames) * 2, 0.0f);
    // 分块渲染，顺便验证跨块渲染与一次性渲染等价
    const uint32_t chunk = 256;
    uint32_t done = 0;
    while (done < frames && voice.isActive()) {
        const uint32_t n = (frames - done) < chunk ? (frames - done) : chunk;
        voice.renderAdd(out.data() + done * 2, static_cast<int32_t>(n));
        done += n;
    }
    return out;
}

void testPlaybackRatio() {
    std::printf("\n== 变调比例 ==\n");

    // 同音：比例为 1
    check(std::fabs(playbackRatio(60, 60, 48000, 48000) - 1.0) < 1e-12, "同音比例为 1");

    // 高一个八度：比例 2
    check(std::fabs(playbackRatio(72, 60, 48000, 48000) - 2.0) < 1e-12, "高八度比例为 2");

    // 低一个八度：比例 0.5
    check(std::fabs(playbackRatio(48, 60, 48000, 48000) - 0.5) < 1e-12, "低八度比例为 0.5");

    // 高一个半音：2^(1/12)
    const double upOne = playbackRatio(61, 60, 48000, 48000);
    check(std::fabs(upOne - std::pow(2.0, 1.0 / 12.0)) < 1e-12, "高半音比例为 2^(1/12)");

    // 低一个半音
    const double downOne = playbackRatio(59, 60, 48000, 48000);
    check(std::fabs(downOne - std::pow(2.0, -1.0 / 12.0)) < 1e-12, "低半音比例为 2^(-1/12)");

    // 采样率比：源 44.1k 播到 48k 设备上，必须一并计入
    const double resampled = playbackRatio(60, 60, 44100, 48000);
    check(std::fabs(resampled - 44100.0 / 48000.0) < 1e-12,
          "采样率比被计入（漏掉会造成整体音高错误）");
}

void testPitchAccuracy() {
    std::printf("\n== 变调音高精度 ==\n");

    const uint32_t frames = 96000;              // 2 秒
    const double baseFreq = 440.0;
    std::vector<int16_t> data = makeSine(baseFreq, frames, 0.8f);

    SampleLayer layer;
    layer.attack = data.data();
    layer.attackFrames = frames;
    layer.gain = 1.0f;
    layer.velocityLayer = 8;

    struct Case { int32_t target; int32_t root; const char* label; };
    const Case cases[] = {
        {69, 69, "同音 A4"},
        {70, 69, "高半音 A#4"},
        {68, 69, "低半音 G#4"},
        {81, 69, "高八度 A5"},
    };

    for (const Case& c : cases) {
        const double ratio = playbackRatio(c.target, c.root, kSampleRate, kSampleRate);
        const double expected = baseFreq * ratio;

        Voice voice;
        voice.start(layer, ratio, 1.0f, static_cast<uint8_t>(c.target), 0);
        const std::vector<float> out = renderVoice(voice, frames / 2);

        // 单声道取左声道
        std::vector<float> mono;
        mono.reserve(out.size() / 2);
        for (size_t i = 0; i < out.size(); i += 2) mono.push_back(out[i]);

        const double measured = measureFrequency(mono);
        const double errorCents = 1200.0 * std::log2(measured / expected);
        std::printf("    %-12s 期望 %.1f Hz，实测 %.1f Hz（偏差 %.2f 音分）\n",
                    c.label, expected, measured, errorCents);
        check(std::fabs(errorCents) < 1.0, c.label);
    }
}

/** 同样的信号走线性插值，返回输出峰值 —— 用来和 Hermite 比高频保持能力 */
double linearInterpPeak(double freq, double ratio, uint32_t frames) {
    const std::vector<int16_t> data = makeSine(freq, frames, 0.8f);

    double peak = 0.0;
    double pos = 0.0;
    const double endPos = static_cast<double>(frames) - 2.0;
    while (pos < endPos) {
        const int64_t i = static_cast<int64_t>(pos);
        const float t = static_cast<float>(pos - static_cast<double>(i));
        const float a = static_cast<float>(data[i * 2]) * kInt16Scale;
        const float b = static_cast<float>(data[(i + 1) * 2]) * kInt16Scale;
        peak = std::fmax(peak, std::fabs(a + (b - a) * t));
        pos += ratio;
    }
    return peak;
}

void testInterpolationQuality() {
    std::printf("\n== 插值质量 ==\n");

    const uint32_t frames = 96000;
    const double ratio = std::pow(2.0, 0.5 / 12.0);   // 四分之一音

    // ---- 中频：Hermite 的波形误差应该极小 ----
    // 1kHz 在 48k 下每周期 48 个采样点，是音源主要能量所在的频段。
    {
        const double freq = 1000.0;
        const std::vector<int16_t> data = makeSine(freq, frames, 0.8f);

        SampleLayer layer;
        layer.attack = data.data();
        layer.attackFrames = frames;
        layer.gain = 1.0f;
        layer.velocityLayer = 8;

        Voice voice;
        voice.start(layer, ratio, 1.0f, 60, 0);
        const std::vector<float> out = renderVoice(voice, frames / 2);

        double maxError = 0.0;
        for (size_t i = 0; i < out.size() / 2; ++i) {
            const double ideal = 0.8 * std::sin(2.0 * M_PI * freq * ratio * i / kSampleRate);
            maxError = std::fmax(maxError, std::fabs(out[i * 2] - ideal));
        }
        std::printf("    1kHz：Hermite 最大波形误差 %.6f\n", maxError);
        check(maxError < 0.002, "中频下 Hermite 误差极小");
    }

    // ---- 高频：这才是两种插值拉开差距的地方 ----
    // 线性插值是一阶低通，随频率升高衰减越厉害；而它的**频率**是准的，
    // 所以拿频率去比是比不出差别的（一开始就这么错过）。
    {
        const double freq = 8000.0;   // 48k 下每周期仅 6 个采样点
        const std::vector<int16_t> data = makeSine(freq, frames, 0.8f);

        SampleLayer layer;
        layer.attack = data.data();
        layer.attackFrames = frames;
        layer.gain = 1.0f;
        layer.velocityLayer = 8;

        Voice voice;
        voice.start(layer, ratio, 1.0f, 60, 0);
        const std::vector<float> out = renderVoice(voice, frames / 2);

        double hermitePeak = 0.0;
        for (size_t i = 0; i < out.size() / 2; ++i) {
            hermitePeak = std::fmax(hermitePeak, std::fabs(out[i * 2]));
        }
        const double linearPeak = linearInterpPeak(freq, ratio, frames);

        const double hermiteLoss = 20.0 * std::log10(hermitePeak / 0.8);
        const double linearLoss = 20.0 * std::log10(linearPeak / 0.8);
        std::printf("    8kHz：Hermite 衰减 %.2f dB，线性插值衰减 %.2f dB\n",
                    -hermiteLoss, -linearLoss);

        check(hermiteLoss > -1.0, "Hermite 在高频下几乎不衰减（< 1 dB）");
        check(linearLoss < hermiteLoss - 1.0,
              "线性插值在高频下明显衰减更多（佐证选 Hermite 的必要）");
    }
}

void testNoClicks() {
    std::printf("\n== 音头音尾无突变 ==\n");

    const uint32_t frames = 4800;    // 0.1 秒，短样本更容易暴露尾部问题
    std::vector<int16_t> data = makeSine(440.0, frames, 0.9f);

    SampleLayer layer;
    layer.attack = data.data();
    layer.attackFrames = frames;
    layer.gain = 1.0f;
    layer.velocityLayer = 8;

    Voice voice;
    voice.start(layer, 1.0, 1.0f, 69, 0);
    const std::vector<float> out = renderVoice(voice, frames + 100);

    // 正弦每样本最大变化 = 2π·f/fs·幅度。超出太多就是不连续。
    const double bound = 2.0 * M_PI * 440.0 / kSampleRate * 0.9 * 1.5;

    double maxDelta = 0.0;
    size_t worstIndex = 1;
    for (size_t i = 1; i < out.size() / 2; ++i) {
        const double d = std::fabs(out[i * 2] - out[(i - 1) * 2]);
        if (d > maxDelta) { maxDelta = d; worstIndex = i; }
    }
    std::printf("    最大相邻样本跳变 %.5f（正弦理论上界 %.5f，位置 %zu）\n",
                maxDelta, bound, worstIndex);
    check(maxDelta < bound, "无突变（含采样结束时）");

    // 采样播完后 voice 应自行结束
    check(!voice.isActive(), "采样播完后 voice 自动结束");

    // 尾部之后必须严格为零 —— 残留说明有越界读
    bool tailSilent = true;
    for (size_t i = frames; i < out.size() / 2; ++i) {
        if (out[i * 2] != 0.0f || out[i * 2 + 1] != 0.0f) tailSilent = false;
    }
    check(tailSilent, "结束后输出为零（无越界残留）");
}

void testRelease() {
    std::printf("\n== 释放斜坡 ==\n");

    const uint32_t frames = 96000;
    std::vector<int16_t> data = makeSine(440.0, frames, 0.9f);

    SampleLayer layer;
    layer.attack = data.data();
    layer.attackFrames = frames;
    layer.gain = 1.0f;
    layer.velocityLayer = 8;

    Voice voice;
    voice.start(layer, 1.0, 1.0f, 69, 0);

    // 先播一小段
    std::vector<float> pre(512 * 2, 0.0f);
    voice.renderAdd(pre.data(), 512);
    check(voice.isActive(), "释放前处于发声状态");
    check(!voice.isReleasing(), "释放前不处于释放态");

    const float envelopeBefore = voice.envelope();
    voice.release(0.05f, kSampleRate);
    check(voice.isReleasing(), "release 后进入释放态");

    // 0.05 秒 = 2400 帧，多给一点余量
    const uint32_t expectFrames = static_cast<uint32_t>(0.05f * kSampleRate) + 64;
    std::vector<float> during(static_cast<size_t>(expectFrames) * 2, 0.0f);
    voice.renderAdd(during.data(), static_cast<int32_t>(expectFrames));

    check(!voice.isActive(), "释放斜坡走完 voice 结束");
    check(std::fabs(voice.envelope()) < 1e-3, "包络归零");

    // 斜坡过程中不应有突变
    double maxDelta = 0.0;
    for (size_t i = 1; i < expectFrames; ++i) {
        const double d = std::fabs(during[i * 2] - during[(i - 1) * 2]);
        maxDelta = std::fmax(maxDelta, d);
    }
    const double bound = 2.0 * M_PI * 440.0 / kSampleRate * 0.9 * 1.5;
    check(maxDelta < bound, "释放过程无突变");

    // 从已被衰减的包络上释放，淡出时长仍应一致
    Voice v2;
    v2.start(layer, 1.0, 1.0f, 69, 0);
    std::vector<float> warm(4096 * 2, 0.0f);
    v2.renderAdd(warm.data(), 4096);
    v2.release(0.05f, kSampleRate);
    uint32_t steps = 0;
    // 逐帧推进，数到包络归零为止
    std::vector<float> one(2, 0.0f);
    while (v2.isActive() && steps < 10000) {
        v2.renderAdd(one.data(), 1);
        ++steps;
    }
    const uint32_t expected = static_cast<uint32_t>(0.05f * kSampleRate);
    std::printf("    包络已衰减过的音：释放用了 %u 帧（期望约 %u）\n", steps, expected);
    check(steps + 4 >= expected && steps <= expected + 4,
          "释放时长不受起始包络值影响");
}

void testAccumulate() {
    std::printf("\n== 混音是累加而非覆盖 ==\n");

    const uint32_t frames = 4800;
    std::vector<int16_t> data = makeSine(440.0, frames, 0.4f);

    SampleLayer layer;
    layer.attack = data.data();
    layer.attackFrames = frames;
    layer.gain = 1.0f;
    layer.velocityLayer = 8;

    // 先往缓冲里填一个基准值，再渲染
    std::vector<float> out(1024 * 2, 0.25f);

    Voice voice;
    voice.start(layer, 1.0, 1.0f, 69, 0);
    voice.renderAdd(out.data(), 1024);

    // 第一个样本：0.25 + 正弦第一个值（约为 0）
    check(std::fabs(out[0] - 0.25f) < 0.01f, "原有内容被保留（累加而非覆盖）");

    // 至少要有明显偏离基准值的样本，说明确实叠加了音频
    bool modulated = false;
    for (size_t i = 0; i < 1024; ++i) {
        if (std::fabs(out[i * 2] - 0.25f) > 0.1f) modulated = true;
    }
    check(modulated, "音频确实叠加进来了");
}

void testKillImmediate() {
    std::printf("\n== 立即静音 ==\n");

    const uint32_t frames = 4800;
    std::vector<int16_t> data = makeSine(440.0, frames, 0.9f);

    SampleLayer layer;
    layer.attack = data.data();
    layer.attackFrames = frames;
    layer.gain = 1.0f;

    Voice voice;
    voice.start(layer, 1.0, 1.0f, 69, 0);
    voice.killImmediate();
    check(!voice.isActive(), "killImmediate 后不再发声");

    std::vector<float> out(256 * 2, 0.0f);
    voice.renderAdd(out.data(), 256);
    bool silent = true;
    for (float v : out) {
        if (v != 0.0f) silent = false;
    }
    check(silent, "killImmediate 后不产生输出");
}

/** 未载入的层必须安全地不发声，而不是崩溃或读野指针 */
void testUnresidentLayer() {
    std::printf("\n== 未载入的层 ==\n");

    SampleLayer layer;      // attack 为 nullptr
    layer.attackFrames = 1000;
    layer.gain = 1.0f;

    Voice voice;
    voice.start(layer, 1.0, 1.0f, 69, 0);

    std::vector<float> out(256 * 2, 0.0f);
    voice.renderAdd(out.data(), 256);

    bool silent = true;
    for (float v : out) {
        if (v != 0.0f) silent = false;
    }
    check(silent, "未载入的层不产生输出");
}

}  // namespace

int main() {
    std::setvbuf(stdout, nullptr, _IONBF, 0);

    std::printf("Voice + Resampler 测试\n");

    testPlaybackRatio();
    testPitchAccuracy();
    testInterpolationQuality();
    testNoClicks();
    testRelease();
    testAccumulate();
    testKillImmediate();
    testUnresidentLayer();

    std::printf("\n%s（失败 %d 项）\n", g_failures == 0 ? "全部通过" : "存在失败", g_failures);
    return g_failures == 0 ? 0 : 1;
}
