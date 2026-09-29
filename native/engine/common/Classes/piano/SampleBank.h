/****************************************************************************
 * 钢琴音频内核 —— 音源库
 *
 * 对应《横屏高仿真钢琴落地实施方案》M1-2。
 *
 * ## 职责
 *
 *   - 解析二进制 manifest（格式见 tools/audio-pipeline/build_samples.py）
 *   - 把「常驻段」（attack）载入内存
 *   - 提供「音高 + 力度 → 采样层」的查表
 *
 * 不负责：FLAC 解码、文件 IO、尾部流式。前者由 SampleSource 抽象，
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
#include <memory>
#include <string>
#include <vector>

namespace piano {

/** 力度层数量上限（Salamander 是 16 层） */
constexpr int kMaxVelocityLayers = 16;
/** 根音数量上限（Salamander 是 30 个） */
constexpr int kMaxRootNotes = 64;

/**
 * 采样数据源。
 *
 * 抽象出来有两个好处：宿主测试可以喂内存数据（不需要文件系统，
 * 也不需要真的 FLAC），Android 侧则用 dr_flac 读文件。
 */
class SampleSource {
public:
    virtual ~SampleSource() = default;

    /**
     * 打开一个采样文件。
     *
     * @param relativePath 相对音源包根目录的路径，如 "piano/A0v1_a.flac"
     * @return 成功返回 true
     */
    virtual bool open(const char* relativePath) = 0;

    /** 当前打开文件的帧数（立体声帧，不是采样点数） */
    virtual uint32_t frames() const = 0;

    /**
     * 读取当前打开文件的全部帧。
     *
     * @param out 输出缓冲，立体声交错，长度至少 frames()*2
     * @return 实际读到的帧数；失败返回 0
     */
    virtual uint32_t readAll(int16_t* out) = 0;

    virtual void close() = 0;

    /**
     * 把一个小文件整个读进内存（manifest 用）。
     *
     * 单独一个接口而不是复用 open/readAll：manifest 不是音频、
     * 不经过解码，且要在载入任何采样之前就读到。
     */
    virtual bool readFile(const char* relativePath, std::vector<uint8_t>& out) = 0;
};

/** 创建当前平台的采样数据源；不支持的平台返回 nullptr。 */
std::unique_ptr<SampleSource> createPlatformSampleSource();

/** 单个力度层的采样 */
struct SampleLayer {
    /** 常驻 PCM，立体声交错。未载入时为 nullptr */
    const int16_t* attack = nullptr;
    uint32_t attackFrames = 0;

    /** 尾部帧数。M1-6 之前只记元数据，不做流式读取 */
    uint32_t tailFrames = 0;

    /** 线性增益（由 manifest 的 gainDb 换算） */
    float gain = 1.0f;

    /** 对应的原始力度层编号 1..16 */
    uint8_t velocityLayer = 0;

    /**
     * 常驻段的相对路径（相对音源包根目录）。
     *
     * 载入时用；载入完成后不再改动，音频线程只读不受影响。
     * 尾部（`tail`）的路径不在层里 —— M1-6 做流式时再补上，
     * 那之前的版本根本不会去读它。
     */
    std::string attackPath;

    bool resident() const { return attack != nullptr; }
};

/** 一个根音（小三度采样的一个采样点），覆盖它上下各一个半音 */
struct RootNote {
    int32_t midi = 0;
    uint8_t layerCount = 0;
    SampleLayer layers[kMaxVelocityLayers];

    /** 该根音是否有任何一层已载入 */
    bool anyResident() const {
        for (uint8_t i = 0; i < layerCount; ++i) {
            if (layers[i].resident()) return true;
        }
        return false;
    }
};

/** 力度层 → MIDI 力度的映射区间（Salamander 是非均匀划分的） */
struct VelocityRange {
    uint8_t index = 0;
    uint8_t minVelocity = 0;
    uint8_t maxVelocity = 127;
};

/** 释放类/踏板采样的元数据（M1-5 才用得到，这里先解析出来备用） */
struct AuxSample {
    int32_t midi = 0;
    uint32_t frames = 0;
    std::string path;
    std::string variant;
};

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
     */
    bool loadManifest(const uint8_t* data, size_t size);

    bool loaded() const { return _loaded; }

    int32_t sampleRate() const { return _sampleRate; }
    int32_t channels() const { return _channels; }
    int32_t bitsPerSample() const { return _bitsPerSample; }

    const std::vector<RootNote>& rootNotes() const { return _roots; }
    const std::vector<VelocityRange>& velocityRanges() const { return _velocityRanges; }
    const std::vector<AuxSample>& hammerSamples() const { return _hammer; }
    const std::vector<AuxSample>& harmonicSamples() const { return _harmonics; }
    const std::vector<AuxSample>& pedalUpSamples() const { return _pedalUp; }
    const std::vector<AuxSample>& pedalDownSamples() const { return _pedalDown; }

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

    /** 实际常驻内存字节数 */
    size_t residentBytes() const { return _residentBytes; }

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

private:
    void clear();

    bool _loaded = false;
    int32_t _sampleRate = 48000;
    int32_t _channels = 2;
    int32_t _bitsPerSample = 16;
    int32_t _lowestMidi = 21;
    int32_t _highestMidi = 108;

    std::vector<VelocityRange> _velocityRanges;
    std::vector<RootNote> _roots;

    std::vector<AuxSample> _hammer;
    std::vector<AuxSample> _harmonics;
    std::vector<AuxSample> _pedalUp;
    std::vector<AuxSample> _pedalDown;

    uint16_t _layerMask = 0xFFFF;

    /** 常驻 PCM 池。一次性分配，运行期不再扩容 —— 音频线程要读它 */
    std::unique_ptr<int16_t[]> _pool;
    size_t _residentBytes = 0;
};

}  // namespace piano
