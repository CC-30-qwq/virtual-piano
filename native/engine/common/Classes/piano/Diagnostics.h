/****************************************************************************
 * 钢琴音频内核 —— 诊断计数
 *
 * 从 PianoEngine::Impl 里拆出来的独立职责：只回答「跑了多少、丢了多少」，
 * 不参与任何音频逻辑。
 *
 * 拆出来的两个理由：
 *   1. Impl 之前把设备、队列、音源、复音、参数、诊断全塞在一个结构里，
 *      改动任何一处都要读那个 200 行的结构体定义；
 *   2. 这些计数与平台无关，抽出来就能在宿主侧直接验证（见 tests/cpp）。
 ****************************************************************************/

#pragma once

#include <atomic>
#include <cstdint>

namespace piano {

/**
 * 内核运行期的诊断计数。
 *
 * ## 线程约定
 *
 * 全部是跨线程访问的：**音频线程与提交线程写，UI 线程读**，所以一律用原子量。
 * 内存序一律 relaxed 就够 —— 这些数只用于显示与告警，不参与任何同步决策，
 * 读到稍微过期的值没有任何后果。
 */
class Diagnostics {
public:
    // ---------------------------------------------------------------- 写

    /** 事件被受理（成功入队） */
    void acceptEvents(uint64_t n) noexcept {
        _accepted.fetch_add(n, std::memory_order_relaxed);
    }

    /** 事件被丢弃（非法，或队列满） */
    void dropEvents(uint64_t n) noexcept {
        _dropped.fetch_add(n, std::memory_order_relaxed);
    }

    /** 音频线程消费（真正派发）的事件数 */
    void consumeEvents(uint64_t n) noexcept {
        _consumed.fetch_add(n, std::memory_order_relaxed);
    }

    /**
     * 当前发声中的 voice 数。
     *
     * 用 store 而不是累加：这是**瞬时值**，由音频线程每个回调刷新一次
     * （`activeCount()` 是权威来源，主线程要读只能拿这个影子值）。
     */
    void setActiveVoices(int32_t n) noexcept {
        _activeVoices.store(n, std::memory_order_relaxed);
    }

    // ---------------------------------------------------------------- 读

    uint64_t acceptedEvents() const noexcept {
        return _accepted.load(std::memory_order_relaxed);
    }

    uint64_t droppedEvents() const noexcept {
        return _dropped.load(std::memory_order_relaxed);
    }

    uint64_t consumedEvents() const noexcept {
        return _consumed.load(std::memory_order_relaxed);
    }

    int32_t activeVoices() const noexcept {
        return _activeVoices.load(std::memory_order_relaxed);
    }

private:
    std::atomic<uint64_t> _accepted{0};
    std::atomic<uint64_t> _dropped{0};
    std::atomic<uint64_t> _consumed{0};
    std::atomic<int32_t>  _activeVoices{0};
};

}  // namespace piano
