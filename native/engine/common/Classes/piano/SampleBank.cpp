/****************************************************************************
 * 钢琴音频内核 —— 音源库实现
 *
 * 只有两件事在这里：**载入策略**与**查表**。
 * 二进制格式的解析在 ManifestReader.cpp，内存所有权在 SamplePool.cpp。
 ****************************************************************************/

#include "SampleBank.h"

#include <algorithm>
#include <atomic>
#include <cstring>
#include <thread>

namespace piano {

namespace {

/****************************************************************************
 * 并行载入的线程数
 *
 * 上限取 4 而不是 hardware_concurrency()：解码是纯计算，但产出要写进同一块
 * 内存，线程再多也只是在抢内存带宽，还会跟音频线程争核。中低端机上 4 条
 * 已经能把「读文件」的等待盖住，再往上收益迅速变平。
 ****************************************************************************/
constexpr int kMaxLoadWorkers = 4;

}  // namespace

int SampleBank::defaultWorkerCount() {
    const unsigned hw = std::thread::hardware_concurrency();
    const int count = hw == 0 ? 1 : static_cast<int>(hw);
    return std::max(1, std::min(count, kMaxLoadWorkers));
}

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

std::vector<SampleBank::LoadJob> SampleBank::planJobs() {
    std::vector<LoadJob> jobs;

    // 先数一遍条数，避免边 push 边扩容
    size_t count = 0;
    for (const RootNote& root : _manifest.roots) {
        for (uint8_t i = 0; i < root.layerCount; ++i) {
            if (isSelected(root.layers[i])) {
                ++count;
            }
        }
    }
    jobs.reserve(count);

    size_t offset = 0;
    for (RootNote& root : _manifest.roots) {
        for (uint8_t i = 0; i < root.layerCount; ++i) {
            SampleLayer& layer = root.layers[i];
            if (!isSelected(layer)) {
                continue;
            }
            LoadJob job;
            job.layer = &layer;
            job.offsetFrames = offset;
            jobs.push_back(job);
            // 预留量按 manifest 声明，实际读到的可能更短 —— 差额在 finalize 里压掉
            offset += layer.attackFrames;
        }
    }
    return jobs;
}

bool SampleBank::readJob(SampleSource& source, LoadJob& job) {
    SampleLayer& layer = *job.layer;

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

    int16_t* dst = _pool.base() == nullptr ? nullptr : _pool.base() + job.offsetFrames * 2u;
    if (dst == nullptr) {
        source.close();
        return false;   // 池没分配（容量算错），不该发生
    }

    const uint32_t read = source.readAll(dst);
    source.close();

    if (read != frames) {
        return false;   // 这块空间在 finalize 里被压实掉（读失败不该占用常驻额度）
    }

    job.framesRead = frames;
    job.ok = true;
    return true;
}

bool SampleBank::finalizeJobs(std::vector<LoadJob>& jobs) {
    int16_t* base = _pool.base();
    if (base == nullptr) {
        return false;   // 池没分配（容量算错），不该发生
    }

    size_t cursor = 0;
    bool allOk = true;

    for (LoadJob& job : jobs) {
        if (!job.ok) {
            allOk = false;   // 失败项留出的空间由后面的采样补上
            continue;
        }

        // 全部成功时 offsetFrames 恒等于 cursor，这里不搬任何数据。
        // 只有前面出现过失败，后面的采样才需要往前挪 —— 往低地址搬，
        // 且目标区段总在「已处理过的区域」内，所以就地 memmove 是安全的。
        int16_t* src = base + job.offsetFrames * 2u;
        int16_t* dst = base + cursor * 2u;
        if (src != dst) {
            std::memmove(dst, src, static_cast<size_t>(job.framesRead) * 2u * sizeof(int16_t));
        }

        job.layer->attack = dst;
        job.layer->attackFrames = job.framesRead;
        cursor += job.framesRead;
    }

    if (!_pool.setCommitted(cursor)) {
        return false;   // 只可能发生在调用方算错容量时
    }
    return allOk;
}

bool SampleBank::loadResident(SampleSource& source) {
    if (!_loaded) {
        return false;
    }

    std::vector<LoadJob> jobs = planJobs();

    // 一次算好总帧数、一次性分配。
    // **不能载入过程中增量扩容** —— 音频线程会读这块内存，指针一挪就出事。
    size_t totalFrames = 0;
    for (const LoadJob& job : jobs) {
        totalFrames += job.layer->attackFrames;
    }
    if (totalFrames == 0) {
        return true;   // 一层都没选（或选中的都是空采样），合法：只是不会有声音
    }
    if (!_pool.reserve(totalFrames)) {
        return false;   // 内存不够。保持空池，不要留下半个池子
    }

    size_t done = 0;
    for (LoadJob& job : jobs) {
        readJob(source, job);
        if (_onProgress) {
            _onProgress(++done, jobs.size());
        }
    }

    return finalizeJobs(jobs);
}

bool SampleBank::loadResident(const SampleSourceFactory& factory, int workers) {
    if (!_loaded) {
        return false;
    }
    if (!factory) {
        return false;
    }

    std::vector<LoadJob> jobs = planJobs();

    size_t totalFrames = 0;
    for (const LoadJob& job : jobs) {
        totalFrames += job.layer->attackFrames;
    }
    if (totalFrames == 0) {
        return true;
    }
    if (!_pool.reserve(totalFrames)) {
        return false;
    }

    const int wanted = workers > 0 ? workers : defaultWorkerCount();

    // 每个线程一个数据源实例。**不能共用** —— SampleSource 持有当前打开的
    // 文件与解码器状态，两个线程同时 open/read 会串数据（而且不是稳定复现的
    // 那种，是最难查的一类）。
    std::vector<std::unique_ptr<SampleSource>> sources;
    sources.reserve(static_cast<size_t>(wanted));
    for (int i = 0; i < wanted; ++i) {
        std::unique_ptr<SampleSource> s = factory();
        if (!s) {
            break;   // 平台不给实例（或内存不够）：用现有的条数跑
        }
        sources.push_back(std::move(s));
    }
    if (sources.empty()) {
        return false;
    }

    // 只有一个实例时不必起线程 —— 线程启动与 join 的开销换不来任何东西
    const size_t workerCount = sources.size();

    std::atomic<size_t> next{0};
    std::atomic<size_t> done{0};
    std::atomic<bool> allOk{true};

    auto consume = [&](SampleSource& source) {
        for (;;) {
            const size_t i = next.fetch_add(1, std::memory_order_relaxed);
            if (i >= jobs.size()) {
                break;
            }
            if (!readJob(source, jobs[i])) {
                allOk.store(false, std::memory_order_relaxed);
            }
            if (_onProgress) {
                _onProgress(done.fetch_add(1, std::memory_order_relaxed) + 1, jobs.size());
            }
        }
    };

    if (workerCount == 1) {
        consume(*sources[0]);
    } else {
        std::vector<std::thread> threads;
        threads.reserve(workerCount);
        for (size_t w = 1; w < workerCount; ++w) {
            threads.emplace_back([&consume, &sources, w] { consume(*sources[w]); });
        }
        consume(*sources[0]);   // 主调线程也当一条 worker，不空等
        for (std::thread& t : threads) {
            t.join();
        }
    }

    // 收尾必须在所有线程都停下之后、由单线程做 —— 它会写 layer.attack，
    // 而那是音频线程的读取入口
    const bool ok = finalizeJobs(jobs);
    return ok && allOk.load();
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
