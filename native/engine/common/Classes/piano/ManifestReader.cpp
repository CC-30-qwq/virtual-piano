/****************************************************************************
 * 钢琴音频内核 —— manifest 解析实现
 ****************************************************************************/

#include "ManifestReader.h"

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
 * 每个字段都检查剩余长度 —— 读越界不能只是崩一下，得能干净地报错返回，
 * 否则用户看到的是启动闪退。
 *
 * 一旦出错（`ensure` 失败）就置 `_ok = false` 并**保持**：后续所有读取都变成
 * 空操作，调用方只要在最后检查一次 `ok()` 即可 —— 不必逐字段判错。
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

/** 释放类/踏板采样：只记元数据，不读音频 */
void readAux(Reader& r, std::vector<AuxSample>& out, uint32_t count, bool withVariant) {
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
}

/** 踏板采样：没有音高，只有帧数与路径 */
void readPedal(Reader& r, std::vector<AuxSample>& out, uint32_t count) {
    out.reserve(count);
    for (uint32_t i = 0; i < count && r.ok(); ++i) {
        AuxSample s;
        s.frames = r.u32();
        s.path = r.str();
        out.push_back(std::move(s));
    }
}

}  // namespace

bool parseManifest(const uint8_t* data, size_t size, ManifestData& out) {
    if (data == nullptr || size < kHeaderSize) {
        return false;
    }
    if (std::memcmp(data, kMagic, 4) != 0) {
        return false;
    }

    Reader r(data, size);
    r.skip(4);  // 魔数已校验过
    if (r.u32() != kExpectedVersion) {
        return false;
    }

    out.sampleRate    = static_cast<int32_t>(r.u32());
    out.channels      = static_cast<int32_t>(r.u32());
    out.bitsPerSample = static_cast<int32_t>(r.u32());
    out.lowestMidi    = static_cast<int32_t>(r.u32());
    out.highestMidi   = static_cast<int32_t>(r.u32());

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
    out.velocityRanges.reserve(velCount);
    for (uint32_t i = 0; i < velCount && r.ok(); ++i) {
        VelocityRange range;
        range.index       = static_cast<uint8_t>(r.u32());
        range.minVelocity = static_cast<uint8_t>(r.u32());
        range.maxVelocity = static_cast<uint8_t>(r.u32());
        out.velocityRanges.push_back(range);
    }

    // ---- 根音与力度层 ----
    out.roots.reserve(rootCount);
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
        out.roots.push_back(std::move(root));
    }

    // ---- 释放类与踏板 ----
    readAux(r, out.hammer, hammerCount, false);
    readAux(r, out.harmonics, harmCount, true);
    readPedal(r, out.pedalUp, pedalUpCnt);
    readPedal(r, out.pedalDown, pedalDnCnt);

    return r.ok();
}

}  // namespace piano
