/****************************************************************************
 * 钢琴音频内核 —— 音源库实现
 ****************************************************************************/

#include "SampleBank.h"

#include <cmath>
#include <cstring>

namespace piano {
namespace {

constexpr char kMagic[4] = {'P', 'N', 'O', 'B'};
constexpr uint32_t kExpectedVersion = 1;
constexpr size_t kHeaderSize = 64;

/**
 * 带边界检查的二进制读取器。
 *
 * manifest 是从资源包里读的，可能被截断或损坏。**每个字段都检查剩余长度** ——
 * 读越界不能只是崩一下，得能干净地报错返回，否则用户看到的是启动闪退。
 */
class Reader {
public:
    Reader(const uint8_t* data, size_t size) : _data(data), _size(size) {}

    bool ok() const { return _ok; }
    size_t offset() const { return _offset; }

    uint32_t u32() {
        if (!ensure(4)) return 0;
        const uint32_t v = static_cast<uint32_t>(_data[_offset]) |
                           (static_cast<uint32_t>(_data[_offset + 1]) << 8) |
                           (static_cast<uint32_t>(_data[_offset + 2]) << 16) |
                           (static_cast<uint32_t>(_data[_offset + 3]) << 24);
        _offset += 4;
        return v;
    }

    float f32() {
        const uint32_t bits = u32();
        float v = 0.0f;
        std::memcpy(&v, &bits, sizeof(v));
        return v;
    }

    std::string str() {
        if (!ensure(2)) return {};
        const uint16_t len = static_cast<uint16_t>(_data[_offset]) |
                             (static_cast<uint16_t>(_data[_offset + 1]) << 8);
        _offset += 2;
        if (!ensure(len)) return {};
        std::string s(reinterpret_cast<const char*>(_data + _offset), len);
        _offset += len;
        return s;
    }

    void skip(size_t n) {
        if (ensure(n)) {
            _offset += n;    // 别忘了推进 —— 只做边界检查的 skip 会静默错位
        }
    }

private:
    bool ensure(size_t n) {
        if (!_ok || _offset + n > _size) {
            _ok = false;
            return false;
        }
        return true;
    }

    const uint8_t* _data;
    size_t _size;
    size_t _offset = 0;
    bool _ok = true;
};

}  // namespace

SampleBank::SampleBank() = default;
SampleBank::~SampleBank() = default;

void SampleBank::clear() {
    _loaded = false;
    _velocityRanges.clear();
    _roots.clear();
    _hammer.clear();
    _harmonics.clear();
    _pedalUp.clear();
    _pedalDown.clear();
    _pool.reset();
    _residentBytes = 0;
}

bool SampleBank::loadManifest(const uint8_t* data, size_t size) {
    if (data == nullptr || size < kHeaderSize) {
        return false;
    }
    if (std::memcmp(data, kMagic, 4) != 0) {
        return false;
    }

    clear();

    Reader r(data, size);
    r.skip(4);  // 魔数已校验过
    if (r.u32() != kExpectedVersion) {
        return false;
    }

    _sampleRate    = static_cast<int32_t>(r.u32());
    _channels      = static_cast<int32_t>(r.u32());
    _bitsPerSample = static_cast<int32_t>(r.u32());
    _lowestMidi    = static_cast<int32_t>(r.u32());
    _highestMidi   = static_cast<int32_t>(r.u32());

    const uint32_t velCount    = r.u32();
    const uint32_t rootCount   = r.u32();
    const uint32_t hammerCount = r.u32();
    const uint32_t harmCount   = r.u32();
    const uint32_t pedalUpCnt  = r.u32();
    const uint32_t pedalDnCnt  = r.u32();

    r.skip(kHeaderSize - r.offset());  // 头部补齐的零

    if (!r.ok() || rootCount > kMaxRootNotes || velCount > kMaxVelocityLayers) {
        return false;
    }

    // ---- 力度区间 ----
    _velocityRanges.reserve(velCount);
    for (uint32_t i = 0; i < velCount && r.ok(); ++i) {
        VelocityRange range;
        range.index       = static_cast<uint8_t>(r.u32());
        range.minVelocity = static_cast<uint8_t>(r.u32());
        range.maxVelocity = static_cast<uint8_t>(r.u32());
        _velocityRanges.push_back(range);
    }

    // ---- 根音与力度层 ----
    _roots.reserve(rootCount);
    for (uint32_t i = 0; i < rootCount && r.ok(); ++i) {
        RootNote root;
        root.midi = static_cast<int32_t>(r.u32());

        const uint32_t layerCount = r.u32();
        if (layerCount > kMaxVelocityLayers) {
            return false;
        }
        root.layerCount = static_cast<uint8_t>(layerCount);

        for (uint32_t j = 0; j < layerCount && r.ok(); ++j) {
            SampleLayer& layer = root.layers[j];
            layer.velocityLayer = static_cast<uint8_t>(r.u32());
            layer.attackFrames  = r.u32();
            layer.tailFrames    = r.u32();
            layer.gain          = std::pow(10.0f, r.f32() / 20.0f);  // dB → 线性
            layer.attackPath    = r.str();
            (void)r.str();   // tail 路径：M1-6 才用，这里丢弃
        }
        _roots.push_back(std::move(root));
    }

    // ---- 释放类与踏板 ----
    auto readAux = [&r](std::vector<AuxSample>& out, uint32_t count, bool withVariant) {
        out.reserve(count);
        for (uint32_t i = 0; i < count && r.ok(); ++i) {
            AuxSample s;
            s.midi = static_cast<int32_t>(r.u32());
            s.frames = r.u32();
            if (withVariant) {
                s.variant = r.str();
            }
            s.path = r.str();
            out.push_back(std::move(s));
        }
    };

    readAux(_hammer, hammerCount, false);
    readAux(_harmonics, harmCount, true);

    auto readPedal = [&r](std::vector<AuxSample>& out, uint32_t count) {
        out.reserve(count);
        for (uint32_t i = 0; i < count && r.ok(); ++i) {
            AuxSample s;
            s.frames = r.u32();
            s.path = r.str();
            out.push_back(std::move(s));
        }
    };
    readPedal(_pedalUp, pedalUpCnt);
    readPedal(_pedalDown, pedalDnCnt);

    if (!r.ok()) {
        clear();
        return false;
    }

    _loaded = true;
    return true;
}

size_t SampleBank::estimateResidentBytes() const {
    size_t frames = 0;
    for (const RootNote& root : _roots) {
        for (uint8_t i = 0; i < root.layerCount; ++i) {
            const SampleLayer& layer = root.layers[i];
            if ((_layerMask & (1u << (layer.velocityLayer - 1))) == 0) {
                continue;
            }
            frames += layer.attackFrames;
        }
    }
    // int16 立体声 = 4 字节/帧
    return frames * 4;
}

bool SampleBank::loadResident(SampleSource& source) {
    if (!_loaded) {
        return false;
    }

    // 先算总帧数，一次性分配。
    // **不能载入过程中增量扩容** —— 音频线程会读这块内存，指针一挪就出事。
    size_t totalFrames = 0;
    size_t wantedLayers = 0;
    for (const RootNote& root : _roots) {
        for (uint8_t i = 0; i < root.layerCount; ++i) {
            const SampleLayer& layer = root.layers[i];
            if ((_layerMask & (1u << (layer.velocityLayer - 1))) == 0) {
                continue;
            }
            totalFrames += layer.attackFrames;
            ++wantedLayers;
        }
    }

    if (totalFrames == 0) {
        return true;  // 一层都没选，合法（只是不会有声音）
    }

    _pool = std::make_unique<int16_t[]>(totalFrames * 2);
    _residentBytes = 0;

    bool allOk = true;
    size_t cursor = 0;

    for (size_t ri = 0; ri < _roots.size(); ++ri) {
        RootNote& root = _roots[ri];
        for (uint8_t li = 0; li < root.layerCount; ++li) {
            SampleLayer& layer = root.layers[li];
            if ((_layerMask & (1u << (layer.velocityLayer - 1))) == 0) {
                continue;
            }

            if (!source.open(layer.attackPath.c_str())) {
                allOk = false;
                continue;
            }

            const uint32_t frames = source.frames();
            if (frames == 0 || frames > layer.attackFrames) {
                // 文件比 manifest 声明的长或短，都按实际读到的来，
                // 但缓冲是按 manifest 分配的 —— 超了就只能截断
                source.close();
                allOk = false;
                continue;
            }

            const uint32_t read = source.readAll(_pool.get() + cursor * 2);
            source.close();

            if (read != frames) {
                allOk = false;
                continue;
            }

            // 指向池内该层的位置，音频线程据此读
            layer.attack = _pool.get() + cursor * 2;
            layer.attackFrames = frames;

            cursor += frames;
            _residentBytes += static_cast<size_t>(frames) * 4;
        }
    }

    return allOk;
}

const RootNote* SampleBank::findRoot(int32_t midi) const {
    // 根音按小三度铺开，覆盖各自上下一个半音的区间。
    // 直接找「最近的那个根音」即可 —— 采样点之间的最大距离是 1 个半音。
    const RootNote* best = nullptr;
    int32_t bestDistance = 0;

    for (const RootNote& root : _roots) {
        const int32_t distance = root.midi > midi ? root.midi - midi : midi - root.midi;
        if (best == nullptr || distance < bestDistance) {
            best = &root;
            bestDistance = distance;
            if (distance == 0) {
                break;
            }
        }
    }
    return best;
}

uint8_t SampleBank::layerIndexForVelocity(uint8_t velocity) const {
    for (const VelocityRange& range : _velocityRanges) {
        if (velocity >= range.minVelocity && velocity <= range.maxVelocity) {
            return range.index;
        }
    }
    // 区间表没覆盖到（manifest 不完整）：退回等分，至少能出声
    return static_cast<uint8_t>(velocity / 8 + 1);
}

const SampleLayer* SampleBank::findLayer(const RootNote& root, uint8_t velocity) const {
    const uint8_t wanted = layerIndexForVelocity(velocity);

    // 先找完全匹配
    for (uint8_t i = 0; i < root.layerCount; ++i) {
        if (root.layers[i].velocityLayer == wanted) {
            if (root.layers[i].resident()) {
                return &root.layers[i];
            }
            break;
        }
    }

    // 该层没载入：向两侧找最近的已载入层。
    // 宁可音色略有偏差，也不能不发声 —— 演奏时漏音比音色不准严重得多。
    const SampleLayer* best = nullptr;
    int wantedDistance = 0;
    for (uint8_t i = 0; i < root.layerCount; ++i) {
        const SampleLayer& layer = root.layers[i];
        if (!layer.resident()) {
            continue;
        }
        const int distance = layer.velocityLayer > wanted
                                 ? layer.velocityLayer - wanted
                                 : wanted - layer.velocityLayer;
        if (best == nullptr || distance < wantedDistance) {
            best = &layer;
            wantedDistance = distance;
        }
    }
    return best;
}

}  // namespace piano
