/****************************************************************************
 * 钢琴音频内核 —— 音源库
 *
 * 对应《横屏高仿真钢琴落地实施方案》M1-2。
 *
 * ## 职责（只有两条）
 *
 *   - 载入策略：哪些力度层常驻、怎么按 manifest 的声明把 PCM 读进内存
 *   - 查表：「音高 + 力度 → 采样层」
 *
 * 另外两件事已经拆出去了，本类不再负责：
 *   - 二进制格式的解析 → `ManifestReader`（换音源格式只动它）
 *   - 常驻 PCM 的所有权   → `SamplePool`（换内存策略只动它）
 *   - 数据模型           → `BankModel.h`
 *
 * 不负责：FLAC 解码、文件 IO、尾部流式。前者由 `SampleSource` 抽象，
 * 后者属于 M1-6，届时会在这之上加一层流式读取。
 *
 * ## 常驻内存是分档的
 *
 * 480 个 attack 段全载入要约 264 MB —— 对中低端机不现实。所以载入哪几个
 * 力度层是可配置的（见 `setLayerMask`），没载入的层由**相邻的已载入层**
 * 顶替。这是采样器的标准做法：相邻力度层之间的差异，用音量加一点高频
 * 补偿就能盖住大部分场景。
 *
 * 档位取舍见《技术方案》§4.3。
 ****************************************************************************/

#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <vector>

#include "BankModel.h"
#include "ManifestReader.h"
#include "SamplePool.h"
#include "SampleSource.h"

namespace piano {

/**
 * 采样数据源工厂。**每个解码线程各取一个实例** ——
 * `SampleSource` 是有状态的（持有当前打开的文件、解码器、缓冲），
 * 一个实例被两个线程同时 open/read 会直接串数据。
 *
 * 用裸函数指针而不是 `std::function`：实现就是 `createPlatformSampleSource`，
 * 不需要捕获任何东西，也省掉一次间接调用。
 */
using SampleSourceFactory = std::unique_ptr<SampleSource> (*)();

/** 载入进度回调。`done`/`total` 都是「条数」（一层采样文件 = 一条） */
using LoadProgressFn = std::function<void(size_t done, size_t total)>;

class SampleBank {
public:
    SampleBank();
    ~SampleBank();

    SampleBank(const SampleBank&)            = delete;
    SampleBank& operator=(const SampleBank&) = delete;

    // ---------------------------------------------------------------- manifest

    /**
     * 解析二进制 manifest。可在没有采样数据时单独调用 ——
     * 只建立索引，不碰内存池。
     *
     * 解析失败时银行会被**整体清空**（而不是留下半套索引）。
     */
    bool loadManifest(const uint8_t* data, size_t size);

    bool loaded() const { return _loaded; }

    int32_t sampleRate() const { return _manifest.sampleRate; }
    int32_t channels() const { return _manifest.channels; }
    int32_t bitsPerSample() const { return _manifest.bitsPerSample; }

    const std::vector<RootNote>& rootNotes() const { return _manifest.roots; }
    const std::vector<VelocityRange>& velocityRanges() const { return _manifest.velocityRanges; }
    const std::vector<AuxSample>& hammerSamples() const { return _manifest.hammer; }
    const std::vector<AuxSample>& harmonicSamples() const { return _manifest.harmonics; }
    const std::vector<AuxSample>& pedalUpSamples() const { return _manifest.pedalUp; }
    const std::vector<AuxSample>& pedalDownSamples() const { return _manifest.pedalDown; }

    // ---------------------------------------------------------------- 载入策略

    /**
     * 设置要载入哪几个力度层。
     *
     * @param mask 位 0..15 对应力度层 1..16；默认全选（264 MB，仅高端机可行）
     *
     * 必须在 `loadResident` 之前调用。
     */
    void setLayerMask(uint16_t mask) { _layerMask = mask; }

    uint16_t layerMask() const { return _layerMask; }

    /** 按当前层掩码，预计需要的常驻内存字节数 */
    size_t estimateResidentBytes() const;

    /**
     * 把所有选中的 attack 段载入常驻内存。
     *
     * @return 是否全部成功。任何一条失败都会返回 false（已载入的保留）。
     */
    bool loadResident(SampleSource& source);

    /**
     * 并行载入：每线程一个数据源实例，同时解码。
     *
     * **产出的 PCM 与串行版本逐字节相同** —— 同一个解码器、同一条文件、
     * 同一段目标偏移，只是并发执行。这是「不降低音质」前提下的主要提速手段。
     *
     * @param factory 每次调用返回一个**新的**数据源实例
     * @param workers 解码线程数。0 = 按硬件并发自动取（夹在 1..4）
     * @return 是否全部成功。任何一条失败都会返回 false（成功的照常保留）
     */
    bool loadResident(const SampleSourceFactory& factory, int workers = 0);

    /**
     * 载入进度回调。会在**工作线程**上被调用，实现方自己保证线程安全
     * （通常只是往一个 `std::atomic<int>` 里写）。
     */
    void setProgressCallback(LoadProgressFn fn) { _onProgress = std::move(fn); }

    /** 实际常驻内存字节数 */
    size_t residentBytes() const { return _pool.bytes(); }

    // ---------------------------------------------------------------- 查表

    /**
     * 找出负责某个音高的根音。
     *
     * 采样是按小三度铺的（30 个根音覆盖 88 键），所以要先找到最近的根音，
     * 再由播放端变调。超出音域返回 nullptr。
     */
    const RootNote* findRoot(int32_t midi) const;

    /**
     * 找出该根音下、与给定力度**最接近**的已载入层。
     *
     * 该层没载入时向两侧找最近的已载入层 —— 宁可音色略有偏差，
     * 也不能不发声。整根音都没载入时返回 nullptr。
     */
    const SampleLayer* findLayer(const RootNote& root, uint8_t velocity) const;

    /**
     * 把 MIDI 力度映射到力度层编号 1..16。
     *
     * 用 manifest 里的非均匀区间，不是等分 —— Salamander 最轻的一层独占
     * 1-26，最响的独占 121-127。
     */
    uint8_t layerIndexForVelocity(uint8_t velocity) const;

    /** 并行载入的默认线程数：硬件并发，夹在 [1, 4] */
    static int defaultWorkerCount();

private:
    void clear();

    /** 该层是否被当前掩码选中 */
    bool isSelected(const SampleLayer& layer) const;

    /**
     * 一条待载入的采样。把「读哪条、写到池里哪个位置」先算好，
     * 解码线程之间才不会互相踩 —— 每个 job 的目标区段互不相邻。
     */
    struct LoadJob {
        SampleLayer* layer = nullptr;
        /** 池内预分配的起始帧下标 */
        size_t offsetFrames = 0;
        /** 实际读到的帧数（成功时有效） */
        uint32_t framesRead = 0;
        bool ok = false;
    };

    /**
     * 按掩码排出全部待载入项，并预分配各自在池内的偏移。
     *
     * 非 const：返回的 job 持有可写的 `SampleLayer*`，收尾时要往层里写回指针。
     */
    std::vector<LoadJob> planJobs();

    /**
     * 解码一条并写入它在池内的预定位置。
     *
     * 不做任何跨 job 的簿记（不碰游标、不写 `layer.attack`）—— 那些都在
     * `finalizeJobs` 里单线程收尾，于是本函数可以被多个线程同时调用。
     */
    bool readJob(SampleSource& source, LoadJob& job);

    /**
     * 收尾：把成功的项按顺序压实（失败项留出的空洞由后面的采样补上），
     * 写回 `layer.attack`，并一次性确认池的占用。
     *
     * 全部成功时**不发生任何搬运** —— 此时预分配偏移正好等于压实后的位置。
     *
     * @return 是否全部成功
     */
    bool finalizeJobs(std::vector<LoadJob>& jobs);

    bool _loaded = false;

    /** 解析出来的音源索引（格式细节见 ManifestReader.h） */
    ManifestData _manifest;

    uint16_t _layerMask = 0xFFFF;

    /** 载入进度回调。只在工作线程上读，载入开始前设好、结束后不再改 */
    LoadProgressFn _onProgress;

    /**
     * 常驻 PCM 的所有权在这里，不在层结构里。
     *
     * 层里只存指向池内的裸指针（`SampleLayer::attack`）—— 那是音频线程
     * 唯一的读取入口，所以池**只在主线程载入期改动**，载入完成后不再重分配。
     */
    SamplePool _pool;
};

}  // namespace piano
