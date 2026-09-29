/****************************************************************************
 * 钢琴音频内核 —— JSB 绑定实现
 *
 * 用 Cocos 的 sebind（`bindings/sebind/sebind.h`）而不是 `jsb.reflection`：
 * 反射调用要经过字符串解析，开销大得多，而 submitEvents 是每帧都要走的热路径。
 * 参考用法见引擎自带的 `tests/sebind-tests/common/Classes/demo/sebind_fruits.cpp`。
 ****************************************************************************/

#include "PianoBridge.h"

#include <cstdint>

#include "PianoEngine.h"
#include "PianoParams.h"

#include "bindings/jswrapper/SeApi.h"
#include "bindings/sebind/sebind.h"

namespace piano {
namespace {

/**
 * 绑定用的空壳类。
 *
 * 内核是单例，不需要暴露构造函数 —— 所有接口都是静态函数。
 */
struct PianoBridgeHost {};

// ---------------------------------------------------------------- 生命周期

int32_t jsbCreate(int32_t sampleRate, int32_t framesPerCallback) {
    return sharedEngine().create(sampleRate, framesPerCallback) ? 1 : 0;
}

void jsbDestroy() {
    sharedEngine().destroy();
}

int32_t jsbStart() {
    return sharedEngine().start() ? 1 : 0;
}

void jsbStop() {
    sharedEngine().stop();
}

// ---------------------------------------------------------------- 演奏事件

/**
 * 批量提交演奏事件。
 *
 * `buffer` 是 TS 侧 `EventWriter` 写的 ArrayBuffer，这里**零拷贝**取数据指针。
 * 布局与 `PianoEvent` 一致，两侧由 static_assert 与单元测试共同保证。
 */
int32_t jsbSubmitEvents(se::Object* buffer, int32_t count) {
    if (buffer == nullptr || count <= 0) {
        return 0;
    }

    uint8_t* data = nullptr;
    size_t length = 0;
    if (!buffer->getArrayBufferData(&data, &length)) {
        // 不是 ArrayBuffer，或者已经被 GC —— 静默返回 0，
        // 让 TS 侧的统计发现异常，而不是在这里抛错打断渲染循环
        return 0;
    }

    // 防御：调用方给的 count 不能超过缓冲实际能容纳的事件数
    const size_t maxCount = length / sizeof(PianoEvent);
    if (static_cast<size_t>(count) > maxCount) {
        count = static_cast<int32_t>(maxCount);
    }

    return static_cast<int32_t>(sharedEngine().submitEvents(data, static_cast<uint32_t>(count)));
}

// ---------------------------------------------------------------- 参数

void jsbSetParam(int32_t id, float value) {
    sharedEngine().setParam(static_cast<ParamId>(id), value);
}

// ---------------------------------------------------------------- 音源包

/**
 * 发起载入音源包。**异步** —— 立即返回，解码在后台线程上进行。
 *
 * @param layerMask 要常驻的力度层掩码（位 0..15 对应层 1..16）。
 *        传 -1 或 0xFFFF 表示全 16 层，约 250MB。
 *        ⚠️ 传更小的值会**降低音质**（未常驻的层由相邻层顶替），当前不接受。
 * @return 是否已受理（1）／已在载或起不了线程（0）
 *
 * 是否真的载好要用 `getLoadProgress` 查。返回值只表示「请求被接受了」，
 * 不是「已经能发声」—— 早先它的语义是「同步载完了」，改成异步之后
 * 若沿用旧语义，TS 侧会把「刚开始载」误当成「已就绪」。
 */
int32_t jsbLoadBank(int32_t layerMask) {
    const uint16_t mask = layerMask < 0 ? 0xFFFF : static_cast<uint16_t>(layerMask & 0xFFFF);
    return sharedEngine().loadBank(mask) ? 1 : 0;
}

/** 载入进度：-2 失败 / -1 未开始 / 0..99 进行中 / 100 已完成 */
int32_t jsbGetLoadProgress() {
    return sharedEngine().loadProgress();
}

double jsbGetResidentBytes() {
    return static_cast<double>(sharedEngine().residentBytes());
}

int32_t jsbGetActiveVoices() {
    return sharedEngine().activeVoices();
}

// ---------------------------------------------------------------- 诊断

int32_t jsbGetXrunCount() {
    return static_cast<int32_t>(sharedEngine().xrunCount());
}

double jsbGetStreamTimeMs() {
    return sharedEngine().streamTimeMs();
}

int32_t jsbGetFramesPerBurst() {
    return sharedEngine().framesPerBurst();
}

double jsbGetAcceptedEvents() {
    return static_cast<double>(sharedEngine().acceptedEvents());
}

double jsbGetDroppedEvents() {
    return static_cast<double>(sharedEngine().droppedEvents());
}

double jsbGetConsumedEvents() {
    return static_cast<double>(sharedEngine().consumedEvents());
}

/**
 * 状态描述。诊断用 —— TS 侧把它显示在调试读数上，
 * 一眼就能看出是「没启动」还是「绑定断了」。
 */
std::string jsbGetStatus() {
    return sharedEngine().started() ? "running" : "stopped";
}

}  // namespace

bool jsb_register_piano(se::Object* globalThis) {
    if (globalThis == nullptr) {
        return false;
    }

    sebind::class_<PianoBridgeHost> bridge("jsbPiano");
    bridge.staticFunction("create", &jsbCreate)
        .staticFunction("destroy", &jsbDestroy)
        .staticFunction("start", &jsbStart)
        .staticFunction("stop", &jsbStop)
        .staticFunction("submitEvents", &jsbSubmitEvents)
        .staticFunction("setParam", &jsbSetParam)
        .staticFunction("loadBank", &jsbLoadBank)
        .staticFunction("getLoadProgress", &jsbGetLoadProgress)
        .staticFunction("getResidentBytes", &jsbGetResidentBytes)
        .staticFunction("getActiveVoices", &jsbGetActiveVoices)
        .staticFunction("getXrunCount", &jsbGetXrunCount)
        .staticFunction("getStreamTimeMs", &jsbGetStreamTimeMs)
        .staticFunction("getFramesPerBurst", &jsbGetFramesPerBurst)
        .staticFunction("getAcceptedEvents", &jsbGetAcceptedEvents)
        .staticFunction("getDroppedEvents", &jsbGetDroppedEvents)
        .staticFunction("getConsumedEvents", &jsbGetConsumedEvents)
        .staticFunction("getStatus", &jsbGetStatus)
        .install(globalThis);

    return true;
}

}  // namespace piano
