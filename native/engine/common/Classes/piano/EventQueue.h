/****************************************************************************
 * 钢琴音频内核 —— 单生产者/单消费者无锁环形队列
 *
 * 对应《横屏高仿真钢琴落地实施方案》§3.3。
 *
 * ## 为什么要无锁
 *
 * 队列的一端是**音频线程**。音频回调里绝对不能加锁 —— 一旦被 UI 线程抢占，
 * 回调无法按时填满缓冲，直接就是爆音（xrun）。所以这里用 SPSC 环形队列
 * 把两个线程解耦：生产者只管塞，消费者只管取，中间没有任何同步原语。
 *
 * ## 为什么索引单调递增而不是取模
 *
 * `_head` / `_tail` 只增不减，用位与取实际下标。好处是「队列里有多少元素」
 * 直接就是 `head - tail`，天然区分「空」和「满」（取模写法要靠牺牲一个槽位
 * 或者额外的计数器来区分）。size_t 走满一圈要 2^64 个事件，实际不可能。
 *
 * ## 线程约定（务必遵守）
 *
 *   - `push` / `pushBulk`  **只允许同一个生产者线程**调用
 *   - `pop`                **只允许同一个消费者线程**调用
 *   - `clear` / `size`     仅在没有并发访问时调用（如启动前、停止后）
 *
 * 违反单生产者/单消费者约定会静默损坏数据，且症状随机 —— 不要图省事让多个
 * 线程同时 push。
 ****************************************************************************/

#pragma once

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <memory>

#include "PianoEvent.h"
#include "PianoParams.h"

namespace piano {

class EventQueue {
public:
    /** @param capacityPow2 容量，必须是 2 的幂；默认取 kEventQueueCapacity */
    explicit EventQueue(size_t capacityPow2 = kEventQueueCapacity) noexcept;

    ~EventQueue() = default;

    EventQueue(const EventQueue&)            = delete;
    EventQueue& operator=(const EventQueue&) = delete;

    // ---------------------------------------------------------------- 生产者

    /**
     * 入队一个事件。
     *
     * @return 队列满时返回 false（**不阻塞**）。由调用方决定重试还是放弃 ——
     *         因此这种情况**不计入** `dropped()`。
     */
    bool push(const PianoEvent& event) noexcept;

    /**
     * 批量入队。
     *
     * 每帧只调用一次，而不是每个音符调一次 —— 虽然这里没有跨语言开销，
     * 但摊薄了原子操作。
     *
     * @return 实际入队的条数；队列满时可能少于 count
     */
    size_t pushBulk(const PianoEvent* events, size_t count) noexcept;

    // ---------------------------------------------------------------- 消费者

    /**
     * 取出至多 max 条事件。
     *
     * @return 实际取出的条数；队列空时返回 0
     */
    size_t pop(PianoEvent* out, size_t max) noexcept;

    /** 窥视队首但不取出；空队列返回 false */
    bool peek(PianoEvent& out) const noexcept;

    // ---------------------------------------------------------------- 状态

    /** 队列中的事件数（近似值 —— 并发下生产者可能立刻又写入） */
    size_t size() const noexcept;

    bool empty() const noexcept;

    /** 容量上限 */
    size_t capacity() const noexcept {
        return _capacity;
    }

    /**
     * 累计**静默丢弃**的事件数。
     *
     * 只统计 `pushBulk` 因空间不足而没能写入的部分 —— 那是队列自己吞掉的，
     * 调用方只能靠这个计数发现。`push` 返回 false 不计入（见其说明）。
     */
    uint64_t dropped() const noexcept {
        return _dropped.load(std::memory_order_relaxed);
    }

    /** 清空。仅在没有并发访问时安全。 */
    void clear() noexcept;

private:
    // ⚠️ 声明顺序 = 初始化顺序，而 `_buffer` 的分配要用到 `_capacity`。
    // 把 `_buffer` 写在前面会让它拿着**尚未初始化**的容量去分配 ——
    // 这类问题在优化构建下静默发作，且症状随机。顺序不要动。
    const size_t _capacity;
    const size_t _mask;
    std::unique_ptr<PianoEvent[]> _buffer;

    // 两个线程各写各的索引，所以各自用 relaxed 读写自己的那个；
    // 读对方的那个必须用 acquire，写自己的用 release —— 否则数据可见性没有保证。
    alignas(64) std::atomic<size_t> _head{0};  // 生产者写入位置
    alignas(64) std::atomic<size_t> _tail{0};  // 消费者读取位置

    std::atomic<uint64_t> _dropped{0};
};

}  // namespace piano
