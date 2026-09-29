/****************************************************************************
 * 钢琴音频内核 —— 音源库实现
 *
 * 只有两件事在这里：**载入策略**与**查表**。
 * 二进制格式的解析在 ManifestReader.cpp，内存所有权在 SamplePool.cpp。
 ****************************************************************************/

#include "SampleBank.h"

namespace piano {

SampleBank::SampleBank() = default;
SampleBank::~SampleBank() = default;

void SampleBank::clear() {
    _loaded = false;
    _manifest = ManifestData{};
    _pool.release();
}

bool SampleBank::loadManifest(const uint8_t* data, size_t size) {
    // 先清空：解析失败时银行必须是**空的**，不能留下半旧半新的索引 ——
    // 那种状态下 findRoot/findLayer 会返回指向已失效数据的指针。
    clear();

    ManifestData parsed;
    if (!parseManifest(data, size, parsed)) {
        return false;
    }

    _manifest = std::move(parsed);
    _loaded = true;
    return true;
}

bool SampleBank::isSelected(const SampleLayer& layer) const {
    // 掩码的位 0..15 对应力度层 1..16
    return (_layerMask & (1u << (layer.velocityLayer - 1))) != 0;
}

size_t SampleBank::estimateResidentBytes() const {
    size_t frames = 0;
    for (const RootNote& root : _manifest.roots) {
        for (uint8_t i = 0; i < root.layerCount; ++i) {
            const SampleLayer& layer = root.layers[i];
            if (!isSelected(layer)) {
                continue;
            }
            frames += layer.attackFrames;
        }
    }
    // int16 立体声 = 4 字节/帧
    return frames * 4;
}

bool SampleBank::loadLayer(SampleSource& source, SampleLayer& layer) {
    if (!source.open(layer.attackPath.c_str())) {
        return false;
    }

    const uint32_t frames = source.frames();
    if (frames == 0 || frames > layer.attackFrames) {
        // 文件比 manifest 声明的长或短，都按实际读到的来，
        // 但缓冲是按 manifest 分配的 —— 超了就只能截断
        source.close();
        return false;
    }

    int16_t* dst = _pool.scratch();
    if (dst == nullptr) {
        source.close();
        return false;   // 池没分配（容量算错），不该发生
    }

    const uint32_t read = source.readAll(dst);
    source.close();

    if (read != frames) {
        return false;   // 这块空间留给下一层复用（读失败不该占用常驻额度）
    }

    // 读成功了才确认占用：指针指向池内该层的位置，音频线程据此读
    if (!_pool.commit(frames)) {
        return false;
    }
    layer.attack = dst;
    layer.attackFrames = frames;
    return true;
}

bool SampleBank::loadResident(SampleSource& source) {
    if (!_loaded) {
        return false;
    }

    // 先算总帧数，一次性分配。
    // **不能载入过程中增量扩容** —— 音频线程会读这块内存，指针一挪就出事。
    size_t totalFrames = 0;
    for (const RootNote& root : _manifest.roots) {
        for (uint8_t i = 0; i < root.layerCount; ++i) {
            const SampleLayer& layer = root.layers[i];
            if (!isSelected(layer)) {
                continue;
            }
            totalFrames += layer.attackFrames;
        }
    }

    if (totalFrames == 0) {
        return true;  // 一层都没选，合法（只是不会有声音）
    }

    if (!_pool.reserve(totalFrames)) {
        return false;  // 内存不够。保持空池，不要留下半个池子
    }

    bool allOk = true;
    for (size_t ri = 0; ri < _manifest.roots.size(); ++ri) {
        RootNote& root = _manifest.roots[ri];
        for (uint8_t li = 0; li < root.layerCount; ++li) {
            SampleLayer& layer = root.layers[li];
            if (!isSelected(layer)) {
                continue;
            }
            if (!loadLayer(source, layer)) {
                allOk = false;
            }
        }
    }

    return allOk;
}

const RootNote* SampleBank::findRoot(int32_t midi) const {
    // 根音按小三度铺开，覆盖各自上下一个半音的区间。
    // 直接找「最近的那个根音」即可 —— 采样点之间的最大距离是 1 个半音。
    const RootNote* best = nullptr;
    int32_t bestDistance = 0;

    for (const RootNote& root : _manifest.roots) {
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
    for (const VelocityRange& range : _manifest.velocityRanges) {
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
