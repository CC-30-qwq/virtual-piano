/****************************************************************************
 * 钢琴音频内核 —— 无锁环形队列实现
 ****************************************************************************/

#include "EventQueue.h"

#include <cassert>

namespace piano {
namespace {

size_t roundUpPow2(size_t v) noexcept {
    if (v < 2) {
        return 2;
    }
    size_t p = 1;
    while (p < v) {
        p <<= 1;
    }
    return p;
}

}  // namespace

EventQueue::EventQueue(size_t capacityPow2) noexcept
    : _capacity(roundUpPow2(capacityPow2)),
      _mask(_capacity - 1),
      _buffer(std::make_unique<PianoEvent[]>(_capacity)) {
}

bool EventQueue::push(const PianoEvent& event) noexcept {
    // 自己的索引直接读，不需要任何同步
    const size_t head = _head.load(std::memory_order_relaxed);

    // 对方的索引用 acquire —— 必须看到消费者已经释放出来的槽位，
    // 否则可能覆盖它还没读完的数据
    const size_t tail = _tail.load(std::memory_order_acquire);

    if (head - tail >= _capacity) {
        // 这里**不**计入 dropped：返回 false 只是告诉调用方「现在满」，
        // 它完全可以重试并成功。队列无从知道调用方接下来怎么做，
        // 把它算成「丢弃」会污染统计（压力测试里生产者就是靠重试做到零丢失的）。
        // 真正的静默丢弃只发生在 pushBulk 的部分写入上。
        return false;
    }

    _buffer[head & _mask] = event;

    // release：保证上面的数据写入对消费者可见之后，新的 head 才可见
    _head.store(head + 1, std::memory_order_release);
    return true;
}

size_t EventQueue::pushBulk(const PianoEvent* events, size_t count) noexcept {
    if (events == nullptr || count == 0) {
        return 0;
    }

    const size_t head = _head.load(std::memory_order_relaxed);
    const size_t tail = _tail.load(std::memory_order_acquire);

    const size_t used = head - tail;
    const size_t space = used >= _capacity ? 0 : _capacity - used;
    const size_t n = count < space ? count : space;

    // 分两段拷贝，处理跨越缓冲区末尾的情况
    const size_t index = head & _mask;
    const size_t firstChunk = (index + n) <= _capacity ? n : (_capacity - index);

    for (size_t i = 0; i < firstChunk; ++i) {
        _buffer[index + i] = events[i];
    }
    for (size_t i = firstChunk; i < n; ++i) {
        _buffer[i - firstChunk] = events[i];
    }

    if (n < count) {
        _dropped.fetch_add(count - n, std::memory_order_relaxed);
    }

    // 一次性发布整批 —— 前面所有数据写入都被这一次 release 覆盖
    _head.store(head + n, std::memory_order_release);
    return n;
}

size_t EventQueue::pop(PianoEvent* out, size_t max) noexcept {
    if (out == nullptr || max == 0) {
        return 0;
    }

    const size_t tail = _tail.load(std::memory_order_relaxed);
    const size_t head = _head.load(std::memory_order_acquire);

    const size_t available = head - tail;
    const size_t n = max < available ? max : available;
    if (n == 0) {
        return 0;
    }

    const size_t index = tail & _mask;
    const size_t firstChunk = (index + n) <= _capacity ? n : (_capacity - index);

    for (size_t i = 0; i < firstChunk; ++i) {
        out[i] = _buffer[index + i];
    }
    for (size_t i = firstChunk; i < n; ++i) {
        out[i] = _buffer[i - firstChunk];
    }

    // release：消费者已经读完这些槽位，生产者可以覆写它们了
    _tail.store(tail + n, std::memory_order_release);
    return n;
}

bool EventQueue::peek(PianoEvent& out) const noexcept {
    const size_t tail = _tail.load(std::memory_order_relaxed);
    const size_t head = _head.load(std::memory_order_acquire);
    if (tail == head) {
        return false;
    }
    out = _buffer[tail & _mask];
    return true;
}

size_t EventQueue::size() const noexcept {
    const size_t head = _head.load(std::memory_order_acquire);
    const size_t tail = _tail.load(std::memory_order_acquire);
    return head - tail;
}

bool EventQueue::empty() const noexcept {
    return size() == 0;
}

void EventQueue::clear() noexcept {
    const size_t head = _head.load(std::memory_order_relaxed);
    _tail.store(head, std::memory_order_release);
    _dropped.store(0, std::memory_order_relaxed);
}

}  // namespace piano
