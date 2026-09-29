/****************************************************************************
 * 钢琴音频内核 —— 对外门面
 *
 * 对应《横屏高仿真钢琴落地实施方案》§3.2（TS ↔ C++ 绑定接口）。
 *
 * M0-1 阶段：本文件只有骨架，不含音频设备与采样器。
 *   M0-3 接入 AudioDevice（Oboe）
 *   M1-1 接入 EventQueue
 *   M1-2 接入 sfizz
 ****************************************************************************/

#pragma once

#include <cstdint>
#include <memory>

#include "PianoEvent.h"
#include "PianoParams.h"

namespace piano {

class AudioDevice;

/**
 * 音频内核门面。TS 侧通过 JsbBridge 访问的唯一入口。
 *
 * ## 线程约定（重要）
 *
 * - `create` / `destroy` / `start` / `stop` / `loadBank` / `setParam` / `submitEvents`
 *   **只能在主线程调用**。
 * - 内部音频线程只做渲染，不得反向调用脚本层，也不得触碰任何加锁的模块。
 * - `submitEvents` 是全工程唯一的每帧跨语言调用。禁止为每个音符单独调用一次
 *   （JNI 反射 + 字符串解析的开销会直接吃掉延迟预算），务必按帧批量提交。
 */
class PianoEngine {
public:
    PianoEngine();
    ~PianoEngine();

    PianoEngine(const PianoEngine&)            = delete;
    PianoEngine& operator=(const PianoEngine&) = delete;

    // ---------------------------------------------------------------- 生命周期

    /**
     * 创建内核。尚未启动音频流。
     *
     * @param sampleRate        目标采样率，Android 建议固定 48000
     * @param framesPerCallback 期望的回调帧数；传 0 表示由设备层取最小值
     * @return 是否创建成功
     */
    bool create(int32_t sampleRate = 48000, int32_t framesPerCallback = 0);

    /** 销毁内核，释放音频流与常驻采样内存。可重复调用。 */
    void destroy();

    /** 启动音频流。启动后 `streamTimeMs()` 才有意义。 */
    bool start();

    // ---------------------------------------------------------------- 音源

    /**
     * 载入音源包。
     *
     * 数据源由平台实现（Android 走 assets + dr_flac，见 SampleSourceAndroid.cpp）。
     * 会同步读完所有常驻采样 —— 这是个耗时操作，**不要在音频线程上调**，
     * 也不要在启动动画期间调（约 250MB 的解码，中端机要几秒）。
     *
     * @param residentLayerMask 要常驻的力度层掩码，位 0..15 对应层 1..16。
     *        默认全 16 层（约 250MB）；低内存机型应传更小的掩码，
     *        未常驻的层会由相邻层顶替（音色略有偏差但不漏音）。
     * @return 是否成功
     */
    bool loadBank(uint16_t residentLayerMask = 0xFFFF);

    /** 常驻采样占用的字节数 */
    size_t residentBytes() const;

    /** 当前发声中的 voice 数 */
    int activeVoices() const;

    /** 停止音频流并静音全部发声中的音符。 */
    void stop();

    // ---------------------------------------------------------------- 演奏事件

    /**
     * 批量提交演奏事件。
     *
     * `buffer` 指向连续的 `PianoEvent` 数组（TS 侧为 ArrayBuffer，零拷贝）。
     * 返回实际入队的事件数；队列满或内核未启动时可能小于 `count`。
     *
     * 非法事件（note / velocity 越界）会被静默丢弃并计入 `droppedEvents()`。
     */
    uint32_t submitEvents(const void* buffer, uint32_t count);

    // ---------------------------------------------------------------- 参数

    /** 设置参数，取值含义见 `ParamId`。未知 ID 会被忽略。 */
    void setParam(ParamId id, float value);

    /** 读取当前参数值；未知 ID 返回 0。 */
    float getParam(ParamId id) const;

    // ---------------------------------------------------------------- 诊断

    /** 音频流是否已启动 */
    bool started() const;

    /** 音频流因缓冲欠载而丢帧的累计次数。持续增长说明缓冲设置过小。 */
    uint32_t xrunCount() const;

    /** 自 `start()` 起的音频时钟，单位毫秒。未启动时返回 0。 */
    double streamTimeMs() const;

    /** 累计接受的合法事件数。 */
    uint64_t acceptedEvents() const;

    /** 累计丢弃的非法事件数。仅用于排查，正常演奏时应恒为 0。 */
    uint64_t droppedEvents() const;

    /**
     * 音频线程累计**消费**的事件数。
     *
     * 与 `acceptedEvents()` 对照即可判断队列是否通畅：两者应当同步增长。
     * 若 accepted 涨而 consumed 不涨，说明音频线程没在跑（流没起来或被挂起）。
     */
    uint64_t consumedEvents() const;

    /** 设备实际生效的回调帧数。持续偏大说明缓冲没压下来。 */
    int32_t framesPerBurst() const;

private:
    struct Impl;
    std::unique_ptr<Impl> _impl;
};

/**
 * 进程内的共享实例。
 *
 * JSB 绑定（PianoBridge）与 `Game` 的平台生命周期钩子共用同一个实例 ——
 * 否则会各自持有一条音频流，互相打架。
 *
 * 用函数内静态量而不是全局变量，避免静态初始化顺序问题。
 */
PianoEngine& sharedEngine();

/**
 * 构建标记。用于在编译产物中确认自研代码确实被链接进来：
 *
 *     strings libcocos.so | grep piano-engine
 *
 * 若这条命令查不到，说明 CMake 接入没生效（见 common/piano.cmake 的说明）。
 */
extern "C" const char* piano_engine_build_tag();

}  // namespace piano
