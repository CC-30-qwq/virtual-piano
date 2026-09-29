/****************************************************************************
 * 钢琴音频内核 —— 常驻 PCM 池
 *
 * 从 SampleBank 里拆出来的原因：**内存所有权**是这里唯一的职责。
 *
 * 之前「往池里写」与「把池内指针写回采样层」散在 `loadResident` 里，
 * 于是 `SampleLayer::attack` 这个裸指针的来源与生命周期要走遍整个银行才看得清。
 * 现在池只回答一个问题：这块内存是谁的、用到哪了。
 ****************************************************************************/

#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>

namespace piano {

/**
 * 常驻采样的内存池。
 *
 * ## 为什么一次性分配
 *
 * 音频线程会直接读池内地址（`SampleLayer::attack`）。**载入过程中增量扩容
 * 会让已发出的指针全部失效** —— 那是崩溃级的错误，所以容量一次算好、
 * 一次分配，运行期只前移游标。
 *
 * ## 为什么是「写位置 + 确认」两步
 *
 * 读一层采样可能失败（文件缺失、解码失败）。失败的那次写入不该占用容量 ——
 * 否则常驻字节数会把失败的部分也算进去。所以：
 *   - `scratch()`  取当前写入位置（失败时这块空间被下一层复用）
 *   - `commit()`   读成功了才确认占用，游标前移
 */
class SamplePool {
public:
    SamplePool() = default;
    ~SamplePool() = default;

    SamplePool(const SamplePool&)            = delete;
    SamplePool& operator=(const SamplePool&) = delete;

    /**
     * 一次性分配 `totalFrames` 帧（立体声交错）的空间。
     *
     * 重复调用会先释放旧的 —— 重新载入音源包时用得上。
     *
     * @return 是否分配成功（内存不够时返回 false，而不是抛异常）
     */
    bool reserve(uint64_t totalFrames);

    /**
     * 当前写入位置。池未分配时返回 nullptr。
     *
     * ⚠️ 调用方必须先 `reserve` 足够容量。越界写入不会越出分配范围
     * （容量由 `commit` 把关），但会损坏池内已有的数据。
     */
    int16_t* scratch() noexcept;

    /**
     * 确认刚才写入的 `frames` 帧已被占用，游标前移。
     *
     * @return 是否确认成功。容量不足时返回 false 且不移动游标 ——
     *         这只可能发生在调用方算错容量的情况下。
     */
    bool commit(uint32_t frames) noexcept;

    /** 已确认占用的字节数（= 常驻采样占用，供 UI 显示） */
    size_t bytes() const noexcept { return _cursorFrames * 4; }

    /** 池容量（帧） */
    size_t capacityFrames() const noexcept { return _capacityFrames; }

    /** 当前写入位置对应的帧下标 */
    size_t cursorFrames() const noexcept { return _cursorFrames; }

    /** 释放全部内存并复位 */
    void release() noexcept;

private:
    std::unique_ptr<int16_t[]> _data;
    size_t _capacityFrames = 0;
    size_t _cursorFrames = 0;
};

}  // namespace piano
