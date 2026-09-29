/****************************************************************************
 * 钢琴音频内核 —— Android 音频设备实现（AAudio）
 *
 * ## 为什么用 AAudio 而不是 Oboe
 *
 * Oboe 是 Google 对 AAudio / OpenSL ES 的封装，体验更好，但它是外部依赖，
 * 需要从 GitHub 拉取 submodule。AAudio 本身就是 NDK 平台 API，
 * `aaudio/AAudio.h` 与 `libaaudio.so` 都在 sysroot 里，零外部依赖。
 *
 * ## 代价：minSdk 必须 >= 26
 *
 * `libaaudio.so` 在 sysroot 中只从 API 26 起提供，因此链接它要求
 * `ANDROID_PLATFORM >= android-26`。本工程已把 minSdk 抬到 26：
 * AAudio 的低延迟路径（独占模式、低延迟性能模式）本身就只从 26 起存在，
 * 为更低的版本写 OpenSL ES 回退，等于在那些机器上主动提供更差的音频体验，
 * 而低延迟正是这个应用的核心价值。
 *
 * ## 实时线程约束
 *
 * `dataCallback` 跑在 AAudio 的实时线程上。该回调内**禁止**加锁、堆分配、
 * 文件 IO、日志输出。违反会直接导致爆音。本文件里的回调只做一件事：
 * 把渲染函数指针转发出去。
 ****************************************************************************/

#include "AudioDevice.h"

#if defined(__ANDROID__)

    #include <aaudio/AAudio.h>
    #include <time.h>

namespace piano {
namespace {

/**
 * 传给 AAudio 回调的上下文。
 *
 * 全部字段在 `start()` 里一次性填好，之后**只读** —— 回调里不会有任何
 * 同步操作。
 */
struct StreamContext {
    AudioDevice::RenderFn render = nullptr;
    void* user = nullptr;
};

/** AAudio 数据回调：转发给渲染函数 */
aaudio_data_callback_result_t dataCallback(AAudioStream* /*stream*/,
                                           void* userData,
                                           void* audioData,
                                           int32_t numFrames) {
    auto* ctx = static_cast<StreamContext*>(userData);
    if (ctx != nullptr && ctx->render != nullptr) {
        ctx->render(ctx->user, static_cast<float*>(audioData), numFrames);
    }
    // 即使渲染失败也继续 —— 返回 STOP 会让整条流停掉，
    // 而偶发的渲染问题不应该让应用彻底失声
    return AAUDIO_CALLBACK_RESULT_CONTINUE;
}

/** AAudio 错误回调。这里不能做重活，只记录错误码供诊断。 */
void errorCallback(AAudioStream* /*stream*/, void* userData, aaudio_result_t error) {
    auto* self = static_cast<void**>(userData);
    if (self != nullptr) {
        // 只存错误码，不加锁、不分配
        *reinterpret_cast<aaudio_result_t*>(self) = error;
    }
}

}  // namespace

class AAudioDevice final : public AudioDevice {
public:
    AAudioDevice() = default;

    ~AAudioDevice() override {
        stop();
    }

    bool start(const Config& config, RenderFn render, void* user) override {
        if (_stream != nullptr) {
            return true;  // 已在运行
        }

        _targetSampleRate = config.sampleRate > 0 ? config.sampleRate : 48000;
        _ctx.render = render;
        _ctx.user = user;

        AAudioStreamBuilder* builder = nullptr;
        if (AAudio_createStreamBuilder(&builder) != AAUDIO_OK || builder == nullptr) {
            return false;
        }

        AAudioStreamBuilder_setDirection(builder, AAUDIO_DIRECTION_OUTPUT);
        AAudioStreamBuilder_setFormat(builder, AAUDIO_FORMAT_PCM_FLOAT);
        AAudioStreamBuilder_setChannelCount(builder, 2);
        AAudioStreamBuilder_setSampleRate(builder, _targetSampleRate);
        AAudioStreamBuilder_setPerformanceMode(builder, AAUDIO_PERFORMANCE_MODE_LOW_LATENCY);
        AAudioStreamBuilder_setDataCallback(builder, dataCallback, &_ctx);
        AAudioStreamBuilder_setErrorCallback(builder, errorCallback, &_lastError);

        // 0 是非法值，只有显式指定时才设置
        if (config.framesPerCallback > 0) {
            AAudioStreamBuilder_setFramesPerDataCallback(builder, config.framesPerCallback);
        }

        // 独占模式延迟最低，但并非所有设备都支持。失败就回落到共享模式，
        // 而不是让整个音频起不来 —— 能出声永远优先于最优延迟。
        AAudioStreamBuilder_setSharingMode(builder, AAUDIO_SHARING_MODE_EXCLUSIVE);
        aaudio_result_t result = AAudioStreamBuilder_openStream(builder, &_stream);
        if (result != AAUDIO_OK) {
            AAudioStreamBuilder_setSharingMode(builder, AAUDIO_SHARING_MODE_SHARED);
            result = AAudioStreamBuilder_openStream(builder, &_stream);
        }

        AAudioStreamBuilder_delete(builder);

        if (result != AAUDIO_OK || _stream == nullptr) {
            _stream = nullptr;
            return false;
        }

        // 以设备实际生效的值为准 —— 请求的采样率不一定被满足
        _sampleRate = AAudioStream_getSampleRate(_stream);
        if (_sampleRate <= 0) {
            _sampleRate = _targetSampleRate;
        }
        _framesPerBurst = AAudioStream_getFramesPerBurst(_stream);

        if (AAudioStream_requestStart(_stream) != AAUDIO_OK) {
            AAudioStream_close(_stream);
            _stream = nullptr;
            return false;
        }

        return true;
    }

    void stop() override {
        if (_stream == nullptr) {
            return;
        }
        AAudioStream_requestStop(_stream);
        AAudioStream_close(_stream);
        _stream = nullptr;
    }

    int32_t sampleRate() const override {
        return _sampleRate > 0 ? _sampleRate : _targetSampleRate;
    }

    int32_t framesPerBurst() const override {
        return _framesPerBurst;
    }

    double streamTimeMs() const override {
        if (_stream == nullptr || _sampleRate <= 0) {
            return 0.0;
        }

        // 优先用时间戳：它给出的是「正在发声的那一帧」及其对应的系统时刻，
        // 比 framesWritten 更贴近真实播放位置。
        int64_t framePosition = 0;
        int64_t timeNanoseconds = 0;
        if (AAudioStream_getTimestamp(_stream, CLOCK_MONOTONIC,
                                      &framePosition, &timeNanoseconds) == AAUDIO_OK) {
            return static_cast<double>(framePosition) * 1000.0 / _sampleRate;
        }

        // 回退：已写入帧数。它会略微领先实际发声位置（领先量约等于缓冲深度），
        // 用于事件调度是可以接受的。
        const int64_t written = AAudioStream_getFramesWritten(_stream);
        return written > 0 ? static_cast<double>(written) * 1000.0 / _sampleRate : 0.0;
    }

    int32_t xrunCount() const override {
        if (_stream == nullptr) {
            return 0;
        }
        const int32_t count = AAudioStream_getXRunCount(_stream);
        return count > 0 ? count : 0;
    }

private:
    AAudioStream* _stream = nullptr;
    StreamContext _ctx;

    int32_t _targetSampleRate = 48000;
    int32_t _sampleRate = 0;
    int32_t _framesPerBurst = 0;

    aaudio_result_t _lastError = AAUDIO_OK;
};

AudioDevice* AudioDevice::create() {
    return new AAudioDevice();
}

}  // namespace piano

#else  // !__ANDROID__

namespace piano {

// 非 Android 平台（如桌面预览）暂不提供设备实现。
// 返回 nullptr 而不是编译失败，便于将来在桌面做单元测试。
AudioDevice* AudioDevice::create() {
    return nullptr;
}

}  // namespace piano

#endif  // __ANDROID__
