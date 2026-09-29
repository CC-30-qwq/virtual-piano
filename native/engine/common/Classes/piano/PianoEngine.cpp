/****************************************************************************
 * 钢琴音频内核 —— 门面实现（M0 骨架）
 ****************************************************************************/

#include "PianoEngine.h"

#include <atomic>
#include <cstring>
#include <memory>

#include "AudioDevice.h"
#include "Diagnostics.h"
#include "EventQueue.h"
#include "ParamStore.h"
#include "SampleBank.h"
#include "VoicePool.h"

// Cocos 日志。用 __has_include 兜底，便于将来脱离引擎做单元测试。
#if __has_include("cocos/base/Log.h")
    #include "cocos/base/Log.h"
    #define PIANO_LOG_INFO(...) CC_LOG_INFO(__VA_ARGS__)
#else
    #include <cstdio>
    #define PIANO_LOG_INFO(...) std::printf(__VA_ARGS__)
#endif

namespace piano {
namespace {

/** 事件字段是否在合法范围内。非法事件一律丢弃，避免越界访问采样表。 */
bool isValidEvent(const PianoEvent& e) {
    if (e.note > 127 || e.velocity > 127) return false;
    switch (e.type) {
        case EventType::NoteOn:
        case EventType::NoteOff:
        case EventType::PedalDown:
        case EventType::PedalUp:
        case EventType::PedalValue:
        case EventType::AllNotesOff:
        case EventType::PitchBend:
            return true;
    }
    return false;  // 未知类型：可能是 TS 与 C++ 的枚举不同步
}

}  // namespace

// ---------------------------------------------------------------------------

struct PianoEngine::Impl {
    int32_t sampleRate        = 48000;
    int32_t framesPerCallback = 0;

    bool created = false;
    bool running = false;

    /** 可调参数。存储与校验都在 ParamStore 里，本结构不关心它的语义 */
    ParamStore params;

    /** 音频设备。start() 时创建，stop() 时销毁。 */
    std::unique_ptr<AudioDevice> device;

    /** 演奏事件队列。UI 线程写，音频线程读 —— 见 EventQueue 的线程约定。 */
    EventQueue queue;

    /**
     * 校验用的暂存缓冲。
     *
     * submitEvents 要先把非法事件滤掉再整批入队，而 pushBulk 要求输入连续。
     * 预先分配好，避免在这条每帧热路径上分配内存。
     */
    PianoEvent staging[kEventQueueCapacity];

    /** 音源库。只在主线程载入，载入完成后音频线程只读。 */
    SampleBank bank;

    /** 复音管理。音频线程独占调用，主线程只读计数。 */
    VoicePool pool;

    /** voice 启动次序用的帧计数器，仅在音频线程递增。 */
    uint32_t renderFrame = 0;

    /**
     * 诊断计数（累计事件数、发声数）。
     *
     * 跨线程读写，所以内部一律用原子量 —— 曾经这些成员与设备、队列、音源
     * 混在同一个结构里，看不出哪些是「只在音频线程碰」的。
     */
    Diagnostics diag;

    /** 把一条事件派发给复音管理层 */
    void dispatchEvent(const PianoEvent& e);

    /**
     * 当前**实际生效**的采样率。
     *
     * 设备起来之后以设备回报的值为准 —— AAudio 并不保证采纳请求值
     * （请求 48k 却给 44.1k 是常见的）；还没有设备时退回请求值。
     *
     * 释放斜坡时长与变调比例都是按它算的，所以只允许从这一处取。
     * 曾经 `loadBank()` 直接用了请求值，把 `start()` 里设好的真实值覆盖掉 ——
     * 症状是「释放时长与音高都略有偏差」，而且只在设备没采纳请求采样率的机型上出现。
     */
    int32_t effectiveSampleRate() const {
        return device ? device->sampleRate() : sampleRate;
    }

    /** AAudio 回调用的是函数指针，需要一层转发到成员函数 */
    static void renderTrampoline(void* user, float* out, int32_t frames) {
        static_cast<Impl*>(user)->render(out, frames);
    }

    /** 渲染回调。跑在音频线程上 —— 禁止加锁、分配、IO。 */
    void render(float* out, int32_t frames);
};

void PianoEngine::Impl::render(float* out, int32_t frames) {
    const int32_t samples = frames * 2;  // 立体声交错
    std::memset(out, 0, sizeof(float) * static_cast<size_t>(samples));

    // 排空事件队列并派发。
    //
    // ⚠️ 现在是「本块开始时把所有事件一次处理掉」，**还没有按 timeMs 做
    // 块内调度**。约定的 lookahead 调度（见《技术方案》§3.2）在下一轮补上 ——
    // 届时要按事件的 timeMs 在块内的正确采样位置触发，而不是挤在块首。
    // 当前实现的时序精度是「一个音频块」（48kHz、192 帧下约 4ms），
    // 对功能验证够用，对手感还不够。
    //
    // 栈上固定缓冲：音频回调内禁止任何堆分配。
    {
        PianoEvent batch[64];
        for (;;) {
            const size_t n = queue.pop(batch, 64);
            if (n == 0) break;
            for (size_t i = 0; i < n; ++i) {
                dispatchEvent(batch[i]);
            }
            diag.consumeEvents(n);
        }
    }

    // 渲染全部发声中的 voice（累加到 out，不是覆盖）
    pool.renderAdd(out, frames);
    diag.setActiveVoices(pool.activeCount());
    ++renderFrame;
}

void PianoEngine::Impl::dispatchEvent(const PianoEvent& e) {
    switch (e.type) {
        case EventType::NoteOn:
            // 用 renderFrame 作启动次序，供偷取策略判断「谁更早」
            pool.noteOn(e.note, e.velocity, renderFrame);
            break;

        case EventType::NoteOff:
            pool.noteOff(e.note);
            break;

        case EventType::PedalDown:
            pool.setPedalValue(127);
            break;

        case EventType::PedalUp:
            pool.setPedalValue(0);
            break;

        case EventType::PedalValue:
            // 半踏板：踏板值承载在 note 字段上
            pool.setPedalValue(e.note);
            break;

        case EventType::AllNotesOff:
            pool.allNotesOff(false);
            break;

        case EventType::PitchBend:
            // 钢琴没有弯音。协议里留着是为了将来接 MIDI 时不至于丢弃未知事件。
            break;
    }
}

// ---------------------------------------------------------------------------

PianoEngine::PianoEngine() : _impl(std::make_unique<Impl>()) {}

PianoEngine::~PianoEngine() {
    destroy();
}

bool PianoEngine::create(int32_t sampleRate, int32_t framesPerCallback) {
    if (_impl->created) {
        PIANO_LOG_INFO("[piano] create 被重复调用，沿用既有配置");
        return true;
    }
    if (sampleRate <= 0) {
        PIANO_LOG_INFO("[piano] create 失败：非法采样率 %d", sampleRate);
        return false;
    }

    _impl->sampleRate        = sampleRate;
    _impl->framesPerCallback = framesPerCallback;
    _impl->created           = true;

    // 默认参数：音量满、其余中性、A4 = 440Hz
    _impl->params.resetToDefaults();

    PIANO_LOG_INFO("[piano] 内核已创建 sampleRate=%d framesPerCallback=%d",
                   sampleRate, framesPerCallback);
    return true;
}

void PianoEngine::destroy() {
    if (!_impl->created) return;
    stop();
    // M1 在这里释放采样常驻内存。
    _impl->created = false;
    PIANO_LOG_INFO("[piano] 内核已销毁");
}

bool PianoEngine::start() {
    if (!_impl->created) {
        PIANO_LOG_INFO("[piano] start 失败：尚未 create");
        return false;
    }
    if (_impl->running) return true;

    _impl->device.reset(AudioDevice::create());
    if (!_impl->device) {
        PIANO_LOG_INFO("[piano] 当前平台没有音频设备实现，启动失败");
        return false;
    }

    AudioDevice::Config config;
    config.sampleRate        = _impl->sampleRate;
    config.framesPerCallback = _impl->framesPerCallback;

    if (!_impl->device->start(config, &Impl::renderTrampoline, _impl.get())) {
        PIANO_LOG_INFO("[piano] 音频流启动失败");
        _impl->device.reset();
        return false;
    }

    // 设备实际生效的采样率可能与请求的不同，复音管理要用真实值算释放时长
    _impl->pool.setSampleRate(_impl->effectiveSampleRate());

    _impl->running = true;
    PIANO_LOG_INFO("[piano] 音频流已启动 sampleRate=%d framesPerBurst=%d",
                   _impl->device->sampleRate(), _impl->device->framesPerBurst());
    return true;
}

void PianoEngine::stop() {
    if (!_impl->running) return;

    // 先让音频线程停下来再做别的，否则它可能还在读已经被释放的东西
    if (_impl->device) {
        _impl->device->stop();
        _impl->device.reset();
    }

    // M1 在这里对所有 voice 执行 allNotesOff(immediate)。

    _impl->running = false;
    PIANO_LOG_INFO("[piano] 音频流已停止");
}

uint32_t PianoEngine::submitEvents(const void* buffer, uint32_t count) {
    if (!_impl->running || buffer == nullptr || count == 0) return 0;

    const auto* events = static_cast<const PianoEvent*>(buffer);

    // 先滤掉非法事件再整批入队：pushBulk 要求输入连续，
    // 而逐条 push 会在每帧热路径上做 count 次原子操作。
    uint32_t valid = 0;
    for (uint32_t i = 0; i < count; ++i) {
        const PianoEvent& e = events[i];
        if (!isValidEvent(e)) {
            _impl->diag.dropEvents(1);
            continue;
        }
        if (valid < kEventQueueCapacity) {
            _impl->staging[valid++] = e;
        } else {
            // 单帧事件数超过队列容量。正常演奏不可能发生，记下来便于排查。
            _impl->diag.dropEvents(1);
        }
    }

    if (valid == 0) return 0;

    const size_t queued = _impl->queue.pushBulk(_impl->staging, valid);
    _impl->diag.acceptEvents(queued);
    return static_cast<uint32_t>(queued);
}

void PianoEngine::setParam(ParamId id, float value) {
    if (!_impl->params.set(id, value)) {
        PIANO_LOG_INFO("[piano] setParam 忽略未知参数 ID=%u", static_cast<unsigned>(id));
    }
}

float PianoEngine::getParam(ParamId id) const {
    return _impl->params.value(id);
}

bool PianoEngine::started() const {
    return _impl->running;
}

uint32_t PianoEngine::xrunCount() const {
    if (!_impl->device) {
        return 0;
    }
    const int32_t count = _impl->device->xrunCount();
    return count > 0 ? static_cast<uint32_t>(count) : 0;
}

double PianoEngine::streamTimeMs() const {
    return _impl->device ? _impl->device->streamTimeMs() : 0.0;
}

int32_t PianoEngine::framesPerBurst() const {
    return _impl->device ? _impl->device->framesPerBurst() : 0;
}

// ---------------------------------------------------------------- 音源

bool PianoEngine::loadBank(uint16_t residentLayerMask) {
    auto source = createPlatformSampleSource();
    if (!source) {
        PIANO_LOG_INFO("[piano] 当前平台没有采样数据源，音源不可用");
        return false;
    }

    std::vector<uint8_t> manifest;
    if (!source->readFile("manifest.bin", manifest)) {
        PIANO_LOG_INFO("[piano] 读不到 manifest.bin（音源包没打进 assets？）");
        return false;
    }

    if (!_impl->bank.loadManifest(manifest.data(), manifest.size())) {
        PIANO_LOG_INFO("[piano] manifest 解析失败");
        return false;
    }

    _impl->bank.setLayerMask(residentLayerMask);

    // 这一步是同步的，要读完几百 MB 并解码 —— 中端机需要几秒。
    // 调用方应当放在启动流程里、并且不要挡住首帧渲染。
    PIANO_LOG_INFO("[piano] 开始载入常驻采样，预计 %.0f MB",
                   _impl->bank.estimateResidentBytes() / 1024.0 / 1024.0);

    if (!_impl->bank.loadResident(*source)) {
        // 部分失败不当作整体失败：载入成功的层照常可用，
        // 演奏时缺失的力度层会由相邻层顶替（见 SampleBank::findLayer）。
        PIANO_LOG_INFO("[piano] 部分采样载入失败，将由其相邻层顶替");
    }

    _impl->pool.setBank(&_impl->bank);
    // 用实际生效的采样率，而不是请求值 —— 否则会把 start() 里设好的真实值覆盖掉
    _impl->pool.setSampleRate(_impl->effectiveSampleRate());

    PIANO_LOG_INFO("[piano] 音源载入完成，常驻 %.0f MB，根音 %u 个",
                   _impl->bank.residentBytes() / 1024.0 / 1024.0,
                   static_cast<unsigned>(_impl->bank.rootNotes().size()));
    return true;
}

size_t PianoEngine::residentBytes() const {
    return _impl->bank.residentBytes();
}

int PianoEngine::activeVoices() const {
    return _impl->diag.activeVoices();
}

uint64_t PianoEngine::acceptedEvents() const {
    return _impl->diag.acceptedEvents();
}

uint64_t PianoEngine::droppedEvents() const {
    return _impl->diag.droppedEvents();
}

uint64_t PianoEngine::consumedEvents() const {
    return _impl->diag.consumedEvents();
}

// ---------------------------------------------------------------------------

PianoEngine& sharedEngine() {
    static PianoEngine engine;
    return engine;
}

extern "C" const char* piano_engine_build_tag() {
    return "piano-engine-m0-skeleton";
}

}  // namespace piano
