/****************************************************************************
 * SampleBank 测试
 *
 * 覆盖三类容易出错的地方：
 *
 *   1. **二进制 manifest 解析** —— 布局错位的症状是读到乱七八糟的路径和帧数，
 *      但不会崩，只会在演奏时表现为「音不对」或「加载失败」。
 *   2. **非均匀力度区间映射** —— Salamander 的 16 层不是等分的，
 *      按等分实现会导致弱奏和强奏的层次整体错位。
 *   3. **损坏 manifest 的处理** —— 资源包可能被截断。读越界必须干净报错，
 *      而不是崩溃（用户看到的是启动闪退，极难定位）。
 *
 * 另外会对真实的 build-bank/manifest.bin 做一次集成检查（若存在）。
 ****************************************************************************/

#include "SampleBank.h"

#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

using namespace piano;

namespace {

int g_failures = 0;

void check(bool cond, const char* what) {
    if (!cond) {
        std::printf("  [FAIL] %s\n", what);
        ++g_failures;
    } else {
        std::printf("  [ ok ] %s\n", what);
    }
}

// ------------------------------------------------------------------ 构造工具

void putU32(std::vector<uint8_t>& out, uint32_t v) {
    out.push_back(static_cast<uint8_t>(v));
    out.push_back(static_cast<uint8_t>(v >> 8));
    out.push_back(static_cast<uint8_t>(v >> 16));
    out.push_back(static_cast<uint8_t>(v >> 24));
}

void putF32(std::vector<uint8_t>& out, float v) {
    uint32_t bits = 0;
    std::memcpy(&bits, &v, 4);
    putU32(out, bits);
}

void putStr(std::vector<uint8_t>& out, const std::string& s) {
    out.push_back(static_cast<uint8_t>(s.size()));
    out.push_back(static_cast<uint8_t>(s.size() >> 8));
    out.insert(out.end(), s.begin(), s.end());
}

/** 造一份最小但结构完整的 manifest：2 个根音 × 3 层 */
std::vector<uint8_t> makeManifest() {
    struct LayerSpec { uint32_t vel; uint32_t attackFrames; uint32_t tailFrames; float gainDb; };
    struct RootSpec { uint32_t midi; std::vector<LayerSpec> layers; };

    // 故意让第 3 层没有尾部（模拟高音区素材短于 attack 的情况）
    std::vector<RootSpec> roots = {
        {21, {{1, 100, 200, 0.0f}, {2, 110, 210, -1.0f}, {3, 120, 0, -2.0f}}},
        {24, {{1, 101, 201, 0.0f}, {2, 111, 211, -1.0f}, {3, 121, 0, -2.0f}}},
    };

    std::vector<uint8_t> out;
    out.push_back('P'); out.push_back('N'); out.push_back('O'); out.push_back('B');
    putU32(out, 1);          // version
    putU32(out, 48000);      // sampleRate
    putU32(out, 2);          // channels
    putU32(out, 16);         // bitsPerSample
    putU32(out, 21);         // lowestMidi
    putU32(out, 108);        // highestMidi
    putU32(out, 3);          // velocityLayerCount
    putU32(out, static_cast<uint32_t>(roots.size()));
    putU32(out, 1);          // hammer
    putU32(out, 1);          // harmonics
    putU32(out, 1);          // pedal up
    putU32(out, 1);          // pedal down
    while (out.size() < 64) out.push_back(0);

    // 非均匀区间：故意做成 1-30 / 31-100 / 101-127
    putU32(out, 1); putU32(out, 1);   putU32(out, 30);
    putU32(out, 2); putU32(out, 31);  putU32(out, 100);
    putU32(out, 3); putU32(out, 101); putU32(out, 127);

    for (const RootSpec& root : roots) {
        putU32(out, root.midi);
        putU32(out, static_cast<uint32_t>(root.layers.size()));
        for (const LayerSpec& layer : root.layers) {
            putU32(out, layer.vel);
            putU32(out, layer.attackFrames);
            putU32(out, layer.tailFrames);
            putF32(out, layer.gainDb);
            putStr(out, "piano/root" + std::to_string(root.midi) +
                            "v" + std::to_string(layer.vel) + "_a.flac");
            putStr(out, layer.tailFrames ? "piano/tail.flac" : "");
        }
    }

    putU32(out, 21); putU32(out, 500); putStr(out, "rel/rel1.flac");
    putU32(out, 21); putU32(out, 600); putStr(out, "V3"); putStr(out, "harm/harmV3A0.flac");
    putU32(out, 700); putStr(out, "pedal/pedalU1.flac");
    putU32(out, 800); putStr(out, "pedal/pedalD1.flac");

    return out;
}

/** 内存数据源：不碰文件系统，也不需要真 FLAC */
class MemorySource : public SampleSource {
public:
    /** 记录被请求过的路径，用来验证载入流程 */
    std::vector<std::string> requested;
    /** 设成 true 就对所有请求报失败，用于测错误路径 */
    bool failAll = false;

    bool open(const char* relativePath) override {
        requested.emplace_back(relativePath);
        if (failAll) return false;
        _frames = 50;          // 固定返回 50 帧，短于 manifest 声明
        return true;
    }
    uint32_t frames() const override { return _frames; }
    uint32_t readAll(int16_t* out) override {
        for (uint32_t i = 0; i < _frames * 2; ++i) out[i] = static_cast<int16_t>(i);
        return _frames;
    }
    void close() override {}
    /** 这些用例不测 manifest 读取，测试自带的 manifest 是内存里造的 */
    bool readFile(const char*, std::vector<uint8_t>&) override { return false; }
    uint32_t _frames = 0;
};

// ------------------------------------------------------------------ 测试

void testParse() {
    std::printf("\n== 解析 ==\n");

    const std::vector<uint8_t> data = makeManifest();
    SampleBank bank;
    check(bank.loadManifest(data.data(), data.size()), "manifest 解析成功");
    check(bank.loaded(), "loaded 置位");

    // 解析失败后再往下索引空数组就是越界访问了 —— 直接崩掉整个测试进程，
    // 后面的用例全跑不成。这里提前收手，让失败信息看得清楚。
    if (!bank.loaded()) {
        check(false, "解析失败，跳过后续字段校验");
        return;
    }

    check(bank.sampleRate() == 48000, "采样率");
    check(bank.channels() == 2, "声道数");
    check(bank.bitsPerSample() == 16, "位深");

    check(bank.velocityRanges().size() == 3, "力度区间条数");
    check(bank.rootNotes().size() == 2, "根音数");

    const RootNote& r0 = bank.rootNotes()[0];
    check(r0.midi == 21, "根音 0 的 midi");
    check(r0.layerCount == 3, "根音 0 的层数");
    check(r0.layers[1].attackFrames == 110, "层 2 的 attackFrames");
    check(r0.layers[0].attackPath == "piano/root21v1_a.flac", "attack 路径");
    check(r0.layers[2].tailFrames == 0, "层 3 无尾部");
    check(!r0.layers[0].resident(), "未载入时 resident 为假");

    // gainDb = -1.0 → 线性约 0.891
    check(r0.layers[1].gain > 0.88f && r0.layers[1].gain < 0.90f, "gainDb 换算为线性增益");

    check(bank.hammerSamples().size() == 1, "锤击采样条数");
    check(bank.harmonicSamples().size() == 1, "弦共振采样条数");
    check(bank.harmonicSamples()[0].variant == "V3", "弦共振变体标记");
    check(bank.pedalUpSamples().size() == 1, "踏板上采样条数");
    check(bank.pedalDownSamples().size() == 1, "踏板下采样条数");
}

void testRejectsBadData() {
    std::printf("\n== 拒绝损坏数据 ==\n");

    SampleBank bank;
    const std::vector<uint8_t> good = makeManifest();

    check(!bank.loadManifest(nullptr, 0), "空指针被拒");
    check(!bank.loadManifest(good.data(), 10), "过短的输入被拒");

    std::vector<uint8_t> badMagic = good;
    badMagic[1] = 'X';
    check(!bank.loadManifest(badMagic.data(), badMagic.size()), "魔数错误被拒");

    std::vector<uint8_t> badVersion = good;
    badVersion[4] = 99;
    check(!bank.loadManifest(badVersion.data(), badVersion.size()), "版本不符被拒");

    // 截断：只给前 40% —— 必须干净返回 false 而不是读越界
    check(!bank.loadManifest(good.data(), good.size() * 4 / 10), "截断的 manifest 被拒");

    check(!bank.loaded(), "被拒后 loaded 保持为假");
}

void testVelocityMapping() {
    std::printf("\n== 力度映射（非均匀区间）==\n");

    const std::vector<uint8_t> data = makeManifest();
    SampleBank bank;
    bank.loadManifest(data.data(), data.size());

    // 区间是 1-30 / 31-100 / 101-127，故意不等分。
    // 按等分实现的话 1-42 都会落到第 1 层 —— 那正是这个测试要拦住的。
    check(bank.layerIndexForVelocity(1) == 1, "力度 1 → 层 1");
    check(bank.layerIndexForVelocity(30) == 1, "力度 30 → 层 1（区间上界）");
    check(bank.layerIndexForVelocity(31) == 2, "力度 31 → 层 2（区间下界）");
    check(bank.layerIndexForVelocity(64) == 2, "力度 64 → 层 2（等分会误判成 2 或 3）");
    check(bank.layerIndexForVelocity(100) == 2, "力度 100 → 层 2");
    check(bank.layerIndexForVelocity(101) == 3, "力度 101 → 层 3");
    check(bank.layerIndexForVelocity(127) == 3, "力度 127 → 层 3");
}

void testFindRoot() {
    std::printf("\n== 根音查找 ==\n");

    const std::vector<uint8_t> data = makeManifest();
    SampleBank bank;
    bank.loadManifest(data.data(), data.size());

    check(bank.findRoot(21) != nullptr && bank.findRoot(21)->midi == 21, "精确命中 21");
    check(bank.findRoot(24) != nullptr && bank.findRoot(24)->midi == 24, "精确命中 24");
    // 22 离 21 更近（距离 1）而不是 24（距离 2）
    check(bank.findRoot(22) != nullptr && bank.findRoot(22)->midi == 21, "22 取最近的 21");
    // 23 两边等距，实现取先遇到的。不约束具体哪个，只要求不崩且落在音域内
    const RootNote* mid = bank.findRoot(23);
    check(mid != nullptr && (mid->midi == 21 || mid->midi == 24), "23 落在相邻根音之一");
    // 远超音域也应返回最近的根音（由调用方判断是否可弹）
    check(bank.findRoot(1) != nullptr, "极低音返回最近根音而非空");
}

void testResidentAndFallback() {
    std::printf("\n== 常驻载入与回退 ==\n");

    const std::vector<uint8_t> data = makeManifest();

    // 只载入第 1、3 层，第 2 层故意不载 —— 用来验证回退
    SampleBank bank;
    bank.loadManifest(data.data(), data.size());
    bank.setLayerMask((1u << 0) | (1u << 2));

    MemorySource source;
    check(bank.loadResident(source), "载入成功");
    check(bank.residentBytes() > 0, "常驻字节数非零");

    // 每个根音应请求 2 个文件（层 1 和层 3）
    check(source.requested.size() == 4, "请求了 4 个文件（2 根音 × 2 层）");

    const RootNote& root = bank.rootNotes()[0];
    check(root.layers[0].resident(), "层 1 已常驻");
    check(!root.layers[1].resident(), "层 2 未常驻（掩码排除）");
    check(root.layers[2].resident(), "层 3 已常驻");
    check(root.anyResident(), "根音整体可发声");

    // 力度 64 对应层 2，但层 2 没载入 → 应回退到层 1 或层 3
    const SampleLayer* fallback = bank.findLayer(root, 64);
    check(fallback != nullptr, "未载入的层能回退");
    check(fallback != nullptr && (fallback->velocityLayer == 1 || fallback->velocityLayer == 3),
          "回退到相邻的已载入层");

    // 载入的层应能精确命中
    const SampleLayer* exact = bank.findLayer(root, 1);   // 力度 1 → 层 1
    check(exact != nullptr && exact->velocityLayer == 1, "已载入的层精确命中");

    // 常驻内存估算应与实际一致
    const size_t estimate = bank.estimateResidentBytes();
    check(estimate > 0, "内存估算非零");
}

void testLoadFailure() {
    std::printf("\n== 载入失败的处理 ==\n");

    const std::vector<uint8_t> data = makeManifest();
    SampleBank bank;
    bank.loadManifest(data.data(), data.size());

    MemorySource source;
    source.failAll = true;
    check(!bank.loadResident(source), "数据源失败时 loadResident 返回 false");
    check(bank.residentBytes() == 0, "失败后常驻字节数为 0");
    check(!bank.rootNotes()[0].layers[0].resident(), "失败后层未标记为常驻");

    // 整根音都没载入时 findLayer 应返回空（调用方据此跳过发声而不是崩）
    check(bank.findLayer(bank.rootNotes()[0], 64) == nullptr, "无可用层时返回空");
}

/** 真实的 manifest.bin 集成检查 */
void testRealManifest(const char* path) {
    std::printf("\n== 真实 manifest 集成检查 ==\n");

    std::FILE* f = std::fopen(path, "rb");
    if (f == nullptr) {
        std::printf("  （跳过，未找到 %s）\n", path);
        return;
    }
    std::fseek(f, 0, SEEK_END);
    const long size = std::ftell(f);
    std::fseek(f, 0, SEEK_SET);
    std::vector<uint8_t> data(static_cast<size_t>(size));
    const size_t read = std::fread(data.data(), 1, data.size(), f);
    std::fclose(f);

    if (read != data.size()) {
        check(false, "读取 manifest.bin");
        return;
    }

    SampleBank bank;
    if (!bank.loadManifest(data.data(), data.size())) {
        check(false, "解析真实 manifest.bin");
        return;
    }

    std::printf("  采样率 %d，根音 %zu 个，力度区间 %zu 条\n",
                bank.sampleRate(), bank.rootNotes().size(), bank.velocityRanges().size());

    check(bank.rootNotes().size() == 30, "30 个根音");
    check(bank.velocityRanges().size() == 16, "16 个力度区间");
    check(bank.hammerSamples().size() == 88, "88 个锤击采样");
    check(bank.harmonicSamples().size() == 69, "69 个弦共振采样");
    check(bank.pedalUpSamples().size() == 2, "2 个踏板上采样");
    check(bank.pedalDownSamples().size() == 2, "2 个踏板下采样");

    // 每个根音都应有 16 层
    bool allSixteen = true;
    for (const RootNote& root : bank.rootNotes()) {
        if (root.layerCount != 16) allSixteen = false;
    }
    check(allSixteen, "每个根音都有 16 个力度层");

    // 根音应覆盖 A0(21) 到 C8(108)
    const auto& roots = bank.rootNotes();
    check(roots.front().midi == 21, "最低根音 A0");
    check(roots.back().midi == 108, "最高根音 C8");

    // 真实力度区间是非均匀的：最轻一层独占 1-26
    check(bank.layerIndexForVelocity(1) == 1, "力度 1 → 层 1");
    check(bank.layerIndexForVelocity(26) == 1, "力度 26 → 层 1");
    check(bank.layerIndexForVelocity(27) == 2, "力度 27 → 层 2");
    check(bank.layerIndexForVelocity(127) == 16, "力度 127 → 层 16");

    // 内存估算：全 16 层的量级应在 250MB 上下
    const size_t est = bank.estimateResidentBytes();
    std::printf("  全 16 层常驻内存估算：%.0f MB\n", est / 1024.0 / 1024.0);
    check(est > 200u * 1024 * 1024 && est < 350u * 1024 * 1024,
          "全量常驻估算落在 200-350MB（与方案 §4.3 一致）");
}

}  // namespace

int main(int argc, char** argv) {
    // 无缓冲输出：测试一旦崩溃，缓冲里的内容会随进程一起丢掉，
    // 那样就完全看不出挂在哪一步了。
    std::setvbuf(stdout, nullptr, _IONBF, 0);

    std::printf("SampleBank 测试\n");

    testParse();
    testRejectsBadData();
    testVelocityMapping();
    testFindRoot();
    testResidentAndFallback();
    testLoadFailure();
    testRealManifest(argc > 1 ? argv[1] : "build-bank/manifest.bin");

    std::printf("\n%s（失败 %d 项）\n", g_failures == 0 ? "全部通过" : "存在失败", g_failures);
    return g_failures == 0 ? 0 : 1;
}
