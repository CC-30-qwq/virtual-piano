/****************************************************************************
 * 钢琴音频内核 —— 常驻 PCM 池实现
 ****************************************************************************/

#include "SamplePool.h"

#include <new>

namespace piano {

bool SamplePool::reserve(uint64_t totalFrames) {
    release();

    if (totalFrames == 0) {
        return true;   // 一层都没选是合法的，只是不会有声音
    }

    // 立体声交错 = 每帧两个 int16。先确认帧数没超过 size_t 能表达的范围，
    // 再乘 —— 否则溢出会分配出一块远小于预期的内存，
    // 之后按帧数写入就是堆越界（这类 bug 在真机上表现为随机崩溃）
    constexpr uint64_t kMaxFrames = static_cast<uint64_t>(SIZE_MAX) / 2u / sizeof(int16_t);
    if (totalFrames > kMaxFrames) {
        return false;
    }

    const size_t samples = static_cast<size_t>(totalFrames) * 2u;
    // 用 nothrow 版本：分配失败时返回 nullptr 让调用方处理，
    // 而不是抛 bad_alloc —— 这个工程里没有异常处理的约定
    // （音频回调更是明确禁止抛异常）。
    _data.reset(new (std::nothrow) int16_t[samples]);
    if (!_data) {
        return false;   // 分配失败（内存不够），保持空池
    }

    _capacityFrames = static_cast<size_t>(totalFrames);
    _cursorFrames = 0;
    return true;
}

int16_t* SamplePool::scratch() noexcept {
    if (!_data) {
        return nullptr;
    }
    return _data.get() + _cursorFrames * 2u;
}

bool SamplePool::commit(uint32_t frames) noexcept {
    if (_cursorFrames + frames > _capacityFrames) {
        return false;
    }
    _cursorFrames += frames;
    return true;
}

bool SamplePool::setCommitted(size_t frames) noexcept {
    if (frames > _capacityFrames) {
        return false;
    }
    _cursorFrames = frames;
    return true;
}

void SamplePool::release() noexcept {
    _data.reset();
    _capacityFrames = 0;
    _cursorFrames = 0;
}

}  // namespace piano
