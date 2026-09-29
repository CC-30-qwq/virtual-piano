/****************************************************************************
 * 内核状态容器测试 —— ParamStore + Diagnostics
 *
 * 这两个类是 C1 从 `PianoEngine::Impl` 里拆出来的独立职责：
 *   - `ParamStore`  参数的定长存储、边界校验与默认值
 *   - `Diagnostics` 运行期计数（跨线程读写，内部原子量）
 *
 * 它们都不依赖平台，所以能像 EventQueue / Voice 一样在宿主侧验证 ——
 * 这也正是把它们从 Impl 里拆出来的收益之一：**拆开之后才测得到**。
 *
 * 重点在两处容易错、且错了不会崩的地方：
 *   - 越界参数 ID：写进去会踩到相邻字段，读出来会拿到垃圾值，都不崩
 *   - 诊断计数：`activeVoices` 是**瞬时量**（store）而不是累加量，
 *     混用会得到一个只涨不跌的数，看起来像「voice 泄漏」
 ****************************************************************************/

#include "Diagnostics.h"
#include "ParamStore.h"

#include <cstdio>
#include <thread>
#include <vector>

using namespace piano;

namespace {

int g_failures = 0;

void check(bool condition, const char* what) {
    if (!condition) {
        std::printf("  [FAIL] %s\n", what);
        ++g_failures;
    } else {
        std::printf("  [ ok ] %s\n", what);
    }
}

void checkNear(float actual, float expected, const char* what) {
    const float diff = actual > expected ? actual - expected : expected - actual;
    if (diff > 1e-6f) {
        std::printf("  [FAIL] %s（期望 %g，实际 %g）\n", what, expected, actual);
        ++g_failures;
    } else {
        std::printf("  [ ok ] %s\n", what);
    }
}

/** 参数 ID 的全集，遍历时用 —— 新增参数时这里也要补，否则漏测 */
const ParamId kAllParams[] = {
    ParamId::MasterVolume, ParamId::Brightness, ParamId::LidPosition,
    ParamId::ReverbMix, ParamId::ReverbSize, ParamId::ReverbDecay,
    ParamId::ReverbDamping, ParamId::TuningA4, ParamId::ReleaseLevel,
    ParamId::HammerLevel, ParamId::PedalNoiseLevel, ParamId::VelocityDepth,
};

// 新增参数却忘了加进上面的列表时，这里直接编译不过 ——
// 否则「每个参数都有默认值」这类断言会静默漏测新增项。
static_assert(sizeof(kAllParams) / sizeof(kAllParams[0]) == kParamCount,
              "kAllParams 必须与 ParamId 一一对应");

// ---------------------------------------------------------------- ParamStore

void testParamDefaults() {
    std::printf("--- 默认值 ---\n");

    ParamStore store;   // 构造后未 reset：应当全 0（而不是未初始化的垃圾）
    bool allZero = true;
    for (ParamId id : kAllParams) {
        if (store.value(id) != 0.0f) allZero = false;
    }
    check(allZero, "构造后应为全 0，不留未初始化内存");

    store.resetToDefaults();
    checkNear(store.value(ParamId::MasterVolume), 1.0f, "主音量默认满");
    checkNear(store.value(ParamId::Brightness), 0.0f, "明亮度默认中性");
    checkNear(store.value(ParamId::LidPosition), 1.0f, "琴盖默认全开");
    checkNear(store.value(ParamId::TuningA4), 440.0f, "A4 默认 440Hz");
    checkNear(store.value(ParamId::ReverbMix), 0.25f, "混响默认干湿比");

    // 每一项都要有默认值（不能靠 value() 的 fallback 蒙混过去）
    store.set(ParamId::ReverbDecay, -123.0f);
    store.resetToDefaults();
    checkNear(store.value(ParamId::ReverbDecay), 0.5f, "被改过的项也应复位");
}

void testParamRoundTrip() {
    std::printf("--- 存取往返 ---\n");

    ParamStore store;
    float v = 1.0f;
    for (ParamId id : kAllParams) {
        store.set(id, v);
        v += 1.0f;
    }

    v = 1.0f;
    bool ok = true;
    for (ParamId id : kAllParams) {
        if (store.value(id) != v) ok = false;
        v += 1.0f;
    }
    check(ok, "每个 ID 都应存得进、取得出（互不串位）");
}

void testParamBounds() {
    std::printf("--- 越界 ID ---\n");

    ParamStore store;
    store.resetToDefaults();

    // 越界 ID：必须被拒绝，而不是写到数组外面
    const ParamId beyond = static_cast<ParamId>(kParamCount + 7);
    check(!store.set(beyond, 42.0f), "越界 set 应被拒绝");
    checkNear(store.value(beyond), 0.0f, "越界读返回默认 fallback");
    checkNear(store.value(beyond, -1.0f), -1.0f, "越界读可指定 fallback");

    // 拒绝之后不能污染任何已知参数
    const float defaults[] = {1.0f, 0.0f, 1.0f, 0.25f, 0.5f, 0.5f, 0.5f, 440.0f, 1.0f, 1.0f, 1.0f, 1.0f};
    bool untouched = true;
    int i = 0;
    for (ParamId id : kAllParams) {
        if (store.value(id) != defaults[i]) untouched = false;
        ++i;
    }
    check(untouched, "越界写入不得踩到相邻参数");
}

// ---------------------------------------------------------------- Diagnostics

void testDiagnosticsBasics() {
    std::printf("--- 诊断计数 ---\n");

    Diagnostics diag;
    check(diag.acceptedEvents() == 0 && diag.droppedEvents() == 0
              && diag.consumedEvents() == 0 && diag.activeVoices() == 0,
          "初值应全为 0");

    diag.acceptEvents(3);
    diag.acceptEvents(4);
    check(diag.acceptedEvents() == 7, "受理数是累加量");

    diag.dropEvents(1);
    diag.dropEvents(2);
    check(diag.droppedEvents() == 3, "丢弃数是累加量");

    diag.consumeEvents(5);
    diag.consumeEvents(5);
    check(diag.consumedEvents() == 10, "消费数是累加量");

    // 发声数是**瞬时量**：每帧刷新一次，必须覆盖而不是累加。
    // 若这里写成 fetch_add，读到的会是一个只涨不跌的数 —— 看起来像 voice 泄漏。
    diag.setActiveVoices(12);
    diag.setActiveVoices(12);
    check(diag.activeVoices() == 12, "发声数是瞬时量（store 覆盖，不累加）");
    diag.setActiveVoices(0);
    check(diag.activeVoices() == 0, "归零也要能覆盖回 0");
}

void testDiagnosticsConcurrency() {
    std::printf("--- 诊断计数：并发累加不丢 ---\n");

    Diagnostics diag;
    const int threads = 4;
    const uint64_t perThread = 250000;

    std::vector<std::thread> workers;
    workers.reserve(threads);
    for (int t = 0; t < threads; ++t) {
        workers.emplace_back([&diag, perThread]() {
            for (uint64_t i = 0; i < perThread; ++i) {
                diag.acceptEvents(1);
            }
        });
    }
    for (auto& w : workers) w.join();

    const uint64_t expected = static_cast<uint64_t>(threads) * perThread;
    if (diag.acceptedEvents() != expected) {
        std::printf("  [FAIL] 并发累加丢计数（期望 %llu，实际 %llu）\n",
                    static_cast<unsigned long long>(expected),
                    static_cast<unsigned long long>(diag.acceptedEvents()));
        ++g_failures;
    } else {
        std::printf("  [ ok ] %d 线程 × %llu 次累加无丢失\n",
                    threads, static_cast<unsigned long long>(perThread));
    }
}

}  // namespace

int main() {
    std::printf("内核状态容器测试（ParamStore + Diagnostics）\n");
    std::printf("kParamCount = %zu\n", kParamCount);

    testParamDefaults();
    testParamRoundTrip();
    testParamBounds();
    testDiagnosticsBasics();
    testDiagnosticsConcurrency();

    std::printf("\n%s（失败 %d 项）\n", g_failures == 0 ? "全部通过" : "存在失败", g_failures);
    return g_failures == 0 ? 0 : 1;
}
