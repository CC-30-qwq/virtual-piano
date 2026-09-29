/****************************************************************************
 * VoicePool 测试
 *
 * 覆盖三块：复音上限与偷取、踏板挂起、以及「没载入音源时不能崩」。
 *
 * 偷取策略尤其值得测 —— 它是**听感问题**：偷错了会让刚按下的音被掐掉，
 * 表现为随机漏音，而且只在复音用满时才出现，极难复现和定位。
 *
 * ## 为什么这个测试文件本身很重要
 *
 * VoicePool.cpp 之前没被加进 run.sh 的源码列表，那个 `kMaxVoices` 未定义的
 * 错误就一直没暴露，直到跑了一次三分钟的 Android 构建才蹦出来。
 * 内核里的每个 .cpp 都该在这里被编译到。
 ****************************************************************************/

#define _USE_MATH_DEFINES
#include <cmath>

#include "VoicePool.h"

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

// ------------------------------------------------------------------ 造测试数据

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

/** 造一份只有 2 个根音、每根音 2 层的 manifest */
std::vector<uint8_t> makeManifest() {
    const uint32_t roots[2] = {21, 24};
    std::vector<uint8_t> out;
    out.push_back('P'); out.push_back('N'); out.push_back('O'); out.push_back('B');
    putU32(out, 1); putU32(out, 48000); putU32(out, 2); putU32(out, 16);
    putU32(out, 21); putU32(out, 108);
    putU32(out, 2);   // 力度层数
    putU32(out, 2);   // 根音数
    putU32(out, 0); putU32(out, 0); putU32(out, 0); putU32(out, 0);
    while (out.size() < 64) out.push_back(0);

    putU32(out, 1); putU32(out, 1);  putU32(out, 63);
    putU32(out, 2); putU32(out, 64); putU32(out, 127);

    for (uint32_t midi : roots) {
        putU32(out, midi);
        putU32(out, 2);
        for (uint32_t vel = 1; vel <= 2; ++vel) {
            putU32(out, vel);
            putU32(out, 400);      // attackFrames
            putU32(out, 0);        // tailFrames
            putF32(out, 0.0f);
            putStr(out, "piano/n" + std::to_string(midi) + "v" + std::to_string(vel) + ".flac");
            putStr(out, "");
        }
    }
    return out;
}

/** 内存数据源：每个采样都是固定不变的常量，便于判断「有没有出声」 */
class MemorySource : public SampleSource {
public:
    bool open(const char*) override { return true; }
    uint32_t frames() const override { return 400; }
    uint32_t readAll(int16_t* out) override {
        for (uint32_t i = 0; i < 400 * 2; ++i) out[i] = 8000;
        return 400;
    }
    void close() override {}
    bool readFile(const char*, std::vector<uint8_t>&) override { return false; }
};

/** 建一个装好 2 个根音 × 2 层的音源库 */
void buildBank(SampleBank& bank) {
    const std::vector<uint8_t> manifest = makeManifest();
    bank.loadManifest(manifest.data(), manifest.size());
    MemorySource source;
    bank.loadResident(source);
}

/** 渲染 frames 帧，返回输出中是否有非零样本 */
bool renderHasSound(VoicePool& pool, int32_t frames) {
    std::vector<float> out(static_cast<size_t>(frames) * 2, 0.0f);
    pool.renderAdd(out.data(), frames);
    for (float v : out) {
        if (v != 0.0f) return true;
    }
    return false;
}

// ------------------------------------------------------------------ 测试

void testNoBank() {
    std::printf("\n== 没有音源时不崩 ==\n");

    VoicePool pool;   // 没绑 bank
    pool.noteOn(60, 100, 0);
    pool.noteOff(60);
    pool.setPedal(true);
    pool.setPedal(false);
    pool.allNotesOff(false);

    check(pool.activeCount() == 0, "没绑音源时 noteOn 不产生 voice");
    check(!renderHasSound(pool, 64), "没绑音源时输出静音");
}

void testBasicTrigger() {
    std::printf("\n== 基本触发 ==\n");

    SampleBank bank;
    buildBank(bank);

    VoicePool pool;
    pool.setBank(&bank);
    pool.setSampleRate(48000);

    check(pool.activeCount() == 0, "初始无发声");

    // 力度 100 落在第 2 层
    pool.noteOn(21, 100, 0);
    check(pool.activeCount() == 1, "noteOn 后有一个 voice 在发声");
    check(renderHasSound(pool, 256), "渲染输出有声音");

    pool.noteOff(21);
    check(pool.releasingCount() == 1, "noteOff 后进入释放态");
    check(pool.activeCount() == 1, "释放中仍占用 voice");

    // 渲染足够长的时间让它衰减完
    std::vector<float> silence(48000 * 2, 0.0f);
    pool.renderAdd(silence.data(), 48000);
    check(pool.activeCount() == 0, "释放结束后 voice 被回收");
}

void testPitchMapping() {
    std::printf("\n== 音高映射到根音 ==\n");

    SampleBank bank;
    buildBank(bank);

    VoicePool pool;
    pool.setBank(&bank);
    pool.setSampleRate(48000);

    // 音源只有 21 和 24 两个根音。22 应该落到最近的 21，
    // 靠变调补上那一个半音的差距。
    pool.noteOn(22, 100, 0);
    check(pool.activeCount() == 1, "邻近音高能找到根音并发声");

    pool.allNotesOff(true);
    check(pool.activeCount() == 0, "allNotesOff(true) 立即静音");
}

void testOutOfRange() {
    std::printf("\n== 超范围音高 ==\n");

    SampleBank bank;
    buildBank(bank);

    VoicePool pool;
    pool.setBank(&bank);
    pool.setSampleRate(48000);

    // 超出音域的键不该崩，也不该读出界
    pool.noteOn(127, 100, 0);
    pool.noteOn(0, 100, 0);
    check(true, "极值音高不崩溃");

    pool.allNotesOff(true);
}

void testPedalSustain() {
    std::printf("\n== 踏板挂起 ==\n");

    SampleBank bank;
    buildBank(bank);

    VoicePool pool;
    pool.setBank(&bank);
    pool.setSampleRate(48000);

    pool.setPedalValue(127);      // 踏板踩到底
    pool.noteOn(21, 100, 0);
    pool.noteOff(21);

    check(pool.releasingCount() == 0, "踏板踩下时 noteOff 不触发释放");
    check(pool.activeCount() == 1, "音被挂起，仍在发声");

    pool.setPedalValue(0);        // 抬踏板
    check(pool.releasingCount() == 1, "抬踏板后挂起的音开始释放");
}

void testStealing() {
    std::printf("\n== 复音偷取 ==\n");

    SampleBank bank;
    buildBank(bank);

    VoicePool pool;
    pool.setBank(&bank);
    pool.setSampleRate(48000);

    // 用**互不相同的音高**填满复音。
    //
    // 不能用同一个音高连按 —— noteOn 会把同音高的上一个放掉（真实钢琴
    // 重击同一键时旧振动被新振动取代），那样一个音高永远堆不出 64 个 voice，
    // 测试就测不到偷取了。
    for (int i = 0; i < kMaxVoices; ++i) {
        pool.noteOn(static_cast<uint8_t>(21 + i), 100, static_cast<uint32_t>(i));
    }
    check(pool.activeCount() == kMaxVoices, "复音数到达上限");
    check(pool.releasingCount() == 0, "此时没有音在释放");

    // 放掉一半，让它们进入释放态
    const int toRelease = kMaxVoices / 2;
    for (int i = 0; i < toRelease; ++i) {
        pool.noteOff(static_cast<uint8_t>(21 + i));
    }
    const int releasingBefore = pool.releasingCount();
    check(releasingBefore == toRelease, "一半的音进入释放态");

    // 复音已满，再触发必须偷 —— 且应该偷释放态的，而不是刚按下的那些
    pool.noteOn(120, 100, 999999);

    check(pool.activeCount() == kMaxVoices, "偷取后总数仍在上限内");
    check(pool.releasingCount() == releasingBefore - 1,
          "偷走了一个释放态的 voice（而不是掐掉还在按住的音）");

    // 被偷之后剩下的音应该还在正常发声
    check(renderHasSound(pool, 256), "偷取后仍能正常出声");

    pool.allNotesOff(true);
    check(pool.activeCount() == 0, "allNotesOff 清空所有 voice");
}

void testRetriggerSameNote() {
    std::printf("\n== 同音重触发 ==\n");

    SampleBank bank;
    buildBank(bank);

    VoicePool pool;
    pool.setBank(&bank);
    pool.setSampleRate(48000);

    // 同一个音连续触发多次：旧的那个应被放掉，
    // 否则声音会叠加，听感上像是音量突然翻倍
    for (int i = 0; i < 5; ++i) {
        pool.noteOn(21, 100, static_cast<uint32_t>(i));
    }

    int releasing = pool.releasingCount();
    // 第一个之后每次都会把上一个放掉，所以至少有 4 个在释放
    check(releasing >= 4, "同音重触发会把上一个放掉，不会无限叠加");

    pool.allNotesOff(true);
}

void testUnresidentLayer() {
    std::printf("\n== 力度层没载入时 ==\n");

    const std::vector<uint8_t> manifest = makeManifest();
    SampleBank bank;
    bank.loadManifest(manifest.data(), manifest.size());

    // 只载入第 1 层，第 2 层不载
    bank.setLayerMask(1u);
    MemorySource source;
    bank.loadResident(source);

    VoicePool pool;
    pool.setBank(&bank);
    pool.setSampleRate(48000);

    // 力度 100 对应第 2 层（没载入）→ 应回退到第 1 层，而不是不发声
    pool.noteOn(21, 100, 0);
    check(pool.activeCount() == 1, "没载入的力度层回退到相邻层，仍然发声");

    pool.allNotesOff(true);
}

}  // namespace

int main() {
    std::setvbuf(stdout, nullptr, _IONBF, 0);

    std::printf("VoicePool 测试（kMaxVoices = %d）\n", kMaxVoices);

    testNoBank();
    testBasicTrigger();
    testPitchMapping();
    testOutOfRange();
    testPedalSustain();
    testStealing();
    testRetriggerSameNote();
    testUnresidentLayer();

    std::printf("\n%s（失败 %d 项）\n", g_failures == 0 ? "全部通过" : "存在失败", g_failures);
    return g_failures == 0 ? 0 : 1;
}
