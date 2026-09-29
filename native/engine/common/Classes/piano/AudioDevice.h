/****************************************************************************
 * 钢琴音频内核 —— 音频设备抽象
 *
 * 对应《横屏高仿真钢琴落地实施方案》§3.3。
 *
 * 目前只有 Android 的 AAudio 实现。选它而不是 Oboe 的原因：
 * AAudio 是 NDK 平台 API，不引入任何外部依赖 —— 在 GitHub 不通的环境下
 * 这一点很重要。代价是它要求 minSdk >= 26（见 AudioDeviceAAudio.cpp 顶部说明）。
 ****************************************************************************/

#pragma once

#include <cstdint>

namespace piano {

/**
 * 音频输出设备。
 *
 * ## 线程约定
 *
 * `RenderFn` 在**音频线程**上被调用。该回调内**禁止**：
 *   - 加锁
 *   - 堆分配（new / malloc / 会扩容的容器）
 *   - 文件 IO、网络、日志输出
 *   - JNI 调用
 *   - 抛异常
 *
 * 这是代码评审的一票否决项 —— 违反会导致爆音甚至崩溃。
 */
class AudioDevice {
public:
    /** 音频流配置 */
    struct Config {
        /** 目标采样率。Android 设备普遍原生 48kHz，用它可避免一次重采样 */
        int32_t sampleRate = 48000;
        /** 期望的回调帧数；0 表示由设备层自行取最小值 */
        int32_t framesPerCallback = 0;
    };

    /**
     * 渲染回调：把 `frames` 帧的浮点立体声（交错）写进 `out`。
     *
     * @param user  start() 时传入的上下文指针
     * @param out   输出缓冲，长度 = frames * 2（立体声交错）
     * @param frames 帧数（不是采样数）
     */
    using RenderFn = void (*)(void* user, float* out, int32_t frames);

    virtual ~AudioDevice() = default;

    AudioDevice(const AudioDevice&) = delete;
    AudioDevice& operator=(const AudioDevice&) = delete;

    /** 打开并启动音频流。失败返回 false。 */
    virtual bool start(const Config& config, RenderFn render, void* user) = 0;

    /** 停止并关闭音频流。可重复调用。 */
    virtual void stop() = 0;

    /** 实际生效的采样率 */
    virtual int32_t sampleRate() const = 0;

    /** 实际生效的回调帧数（每 burst） */
    virtual int32_t framesPerBurst() const = 0;

    /**
     * 音频时钟，单位毫秒，自本轮流启动起算。
     *
     * 这是 TS 侧时间戳对齐的基准：事件携带的 `timeMs` 就是在这条时间轴上的
     * 目标位置。见《技术方案》§3.2。
     */
    virtual double streamTimeMs() const = 0;

    /** 累计欠载次数。持续增长说明缓冲设置过小。 */
    virtual int32_t xrunCount() const = 0;

    /** 创建当前平台的设备实现；不支持的平台返回 nullptr。 */
    static AudioDevice* create();

protected:
    AudioDevice() = default;
};

}  // namespace piano
