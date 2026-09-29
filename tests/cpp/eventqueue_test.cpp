/****************************************************************************
 * EventQueue 压力测试
 *
 * 无锁队列的正确性**只能靠运行验证** —— 编译通过说明不了原子序对不对、
 * 环形索引有没有算错、并发下会不会丢事件或读到撕裂数据。
 *
 * ## 怎么判定「没丢、没错、没撕裂」
 *
 * 生产者给每个事件打上单调递增的序号（写进 reserved0），消费者逐个校验：
 *
 *   - 序号**连续**      → 没丢事件
 *   - 序号**单调递增**  → 顺序正确（SPSC 队列必须保序）
 *   - 其余字段**逐条匹配** → 没有撕裂（读到半个旧事件半个新事件）
 *
 * 生产者遇到队满时自旋重试而不是丢弃，这样「一条都不能少」才是可断言的。
 *
 * ## 为什么必须用 release 构建跑
 *
 * Debug 下编译器的重排更保守，内存序写错也常常能跑对。
 * 要用 /O2 跑 —— 那才是优化器会真正重排指令的场景。
 ****************************************************************************/

#include "EventQueue.h"

#include <atomic>
#include <cstdio>
#include <cstdlib>
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

/** 造一个内容可校验的事件：序号写进 reserved0，其余字段由序号派生 */
PianoEvent makeEvent(uint64_t seq) {
    PianoEvent e{};
    e.type      = EventType::NoteOn;
    e.note      = static_cast<uint8_t>(seq % 128);
    e.velocity  = static_cast<uint8_t>((seq * 7) % 128);
    e.source    = EventSource::Touch;
    e.timeMs    = static_cast<float>(seq) * 0.5f;
    e.reserved0 = static_cast<uint32_t>(seq);         // 低 32 位序号
    e.reserved1 = static_cast<uint32_t>(seq >> 32);   // 高 32 位序号
    return e;
}

uint64_t seqOf(const PianoEvent& e) {
    return (static_cast<uint64_t>(e.reserved1) << 32) | e.reserved0;
}

/** 逐字段比对，用来发现撕裂 */
bool sameEvent(const PianoEvent& a, const PianoEvent& b) {
    return a.type == b.type && a.note == b.note && a.velocity == b.velocity &&
           a.source == b.source && a.timeMs == b.timeMs &&
           a.reserved0 == b.reserved0 && a.reserved1 == b.reserved1;
}

// ------------------------------------------------------------------ 单线程

void testBasics() {
    std::printf("\n== 基本行为 ==\n");

    EventQueue q(8);
    check(q.capacity() == 8, "容量取整为 2 的幂");
    check(q.empty(), "初始为空");
    check(q.size() == 0, "初始 size 为 0");

    check(q.push(makeEvent(1)), "push 成功");

    PianoEvent out{};
    check(q.peek(out), "peek 有数据");
    check(seqOf(out) == 1, "peek 不消费");
    check(q.size() == 1, "peek 后 size 不变");

    check(q.pop(&out, 1) == 1, "pop 取到 1 条");
    check(seqOf(out) == 1, "pop 内容正确");
    check(q.empty(), "pop 后为空");

    // 容量边界：写满
    EventQueue q2(4);
    for (int i = 0; i < 4; ++i) {
        check(q2.push(makeEvent(static_cast<uint64_t>(i))), "写满过程中 push 成功");
    }
    check(q2.size() == 4, "写满后 size == 容量");
    check(!q2.push(makeEvent(99)), "队满时 push 返回 false");
    // push 返回 false 只是「现在满」，调用方可以重试 —— 不计入 dropped。
    // 只有 pushBulk 的部分写入才是队列自己吞掉的静默丢弃。
    check(q2.dropped() == 0, "push 被拒不计入 dropped（调用方可能重试成功）");

    // 取一条再写一条：验证单调索引不会把「满」误判成「空」
    check(q2.pop(&out, 1) == 1, "从满队列取 1 条");
    check(q2.push(makeEvent(100)), "腾出空间后可再写");
    check(q2.size() == 4, "仍为满");
}

void testWrapAround() {
    std::printf("\n== 环绕 ==\n");

    EventQueue q(4);
    PianoEvent out[4];

    // 反复穿过缓冲区边界，验证两段拷贝的下标算法
    for (uint64_t round = 0; round < 10000; ++round) {
        for (int i = 0; i < 3; ++i) {
            q.push(makeEvent(round * 3 + i));
        }
        const size_t n = q.pop(out, 3);
        if (n != 3) {
            std::printf("  [FAIL] 环绕第 %llu 轮取出 %zu 条\n",
                        static_cast<unsigned long long>(round), n);
            ++g_failures;
            return;
        }
        for (int i = 0; i < 3; ++i) {
            const uint64_t expect = round * 3 + static_cast<uint64_t>(i);
            if (seqOf(out[i]) != expect || !sameEvent(out[i], makeEvent(expect))) {
                std::printf("  [FAIL] 环绕第 %llu 轮第 %d 条数据损坏\n",
                            static_cast<unsigned long long>(round), i);
                ++g_failures;
                return;
            }
        }
    }
    check(true, "跨边界读写 3 万条数据无损坏");
}

void testBulk() {
    std::printf("\n== 批量 ==\n");

    EventQueue q(16);
    PianoEvent in[16];
    PianoEvent out[16];

    // 先占住前 8 个槽位，让下一次批量写入跨过缓冲区末尾
    for (int i = 0; i < 8; ++i) q.push(makeEvent(1000 + static_cast<uint64_t>(i)));
    check(q.pop(out, 8) == 8, "取出前 8 条腾出头部空间");

    for (int i = 0; i < 12; ++i) in[i] = makeEvent(2000 + static_cast<uint64_t>(i));
    check(q.pushBulk(in, 12) == 12, "批量写入 12 条");

    // 此时写指针已经绕过缓冲区末尾，再写 4 条必然跨界
    for (int i = 0; i < 4; ++i) in[i] = makeEvent(3000 + static_cast<uint64_t>(i));
    check(q.pushBulk(in, 4) == 4, "跨界批量写入 4 条");

    const size_t n = q.pop(out, 16);
    check(n == 16, "一次取出全部 16 条");

    bool ok = true;
    for (int i = 0; i < 12; ++i) {
        if (!sameEvent(out[i], makeEvent(2000 + static_cast<uint64_t>(i)))) ok = false;
    }
    for (int i = 0; i < 4; ++i) {
        if (!sameEvent(out[12 + i], makeEvent(3000 + static_cast<uint64_t>(i)))) ok = false;
    }
    check(ok, "跨界批量数据逐条正确");

    // 批量写入超出剩余空间：应写入能放下的部分并如实报告
    EventQueue q2(8);
    PianoEvent big[16];
    for (int i = 0; i < 16; ++i) big[i] = makeEvent(static_cast<uint64_t>(i));
    check(q2.pushBulk(big, 16) == 8, "超量批量只写入容量上限");
    check(q2.dropped() == 8, "超出部分计入丢弃");
}

// ------------------------------------------------------------------ 并发

void testConcurrent(uint64_t total) {
    std::printf("\n== 并发压力（%llu 条）==\n",
                static_cast<unsigned long long>(total));

    EventQueue q(1024);
    std::atomic<bool> producerDone{false};
    std::atomic<uint64_t> consumed{0};
    uint64_t gaps = 0;
    uint64_t corrupt = 0;

    std::thread producer([&] {
        for (uint64_t i = 1; i <= total; ++i) {
            // 队满时自旋重试 —— 这样「一条都不能少」才是可断言的
            while (!q.push(makeEvent(i))) {
                std::this_thread::yield();
            }
        }
        producerDone.store(true, std::memory_order_release);
    });

    std::thread consumer([&] {
        PianoEvent batch[64];
        uint64_t expect = 1;
        for (;;) {
            const size_t n = q.pop(batch, 64);
            if (n == 0) {
                if (producerDone.load(std::memory_order_acquire) && q.empty()) break;
                std::this_thread::yield();
                continue;
            }
            for (size_t i = 0; i < n; ++i) {
                const uint64_t seq = seqOf(batch[i]);
                if (seq != expect) ++gaps;                       // 丢了或乱了序
                if (!sameEvent(batch[i], makeEvent(seq))) ++corrupt;  // 撕裂
                expect = seq + 1;
                ++consumed;
            }
        }
    });

    producer.join();
    consumer.join();

    check(gaps == 0, "序号连续 —— 无丢失、无乱序");
    check(corrupt == 0, "逐字段比对一致 —— 无撕裂");
    check(consumed.load() == total, "消费条数等于生产条数");
    check(q.dropped() == 0, "无事件被丢弃");
}

}  // namespace

int main(int argc, char** argv) {
    uint64_t total = 10000000ULL;  // 默认 1e7
    if (argc > 1) {
        total = std::strtoull(argv[1], nullptr, 10);
    }

    std::printf("EventQueue 测试\n");
    std::printf("sizeof(PianoEvent) = %zu（必须为 16）\n", sizeof(PianoEvent));
    if (sizeof(PianoEvent) != 16) {
        std::printf("  [FAIL] PianoEvent 尺寸不对，事件布局已损坏\n");
        return 1;
    }

    testBasics();
    testWrapAround();
    testBulk();
    testConcurrent(total);

    std::printf("\n%s（失败 %d 项）\n", g_failures == 0 ? "全部通过" : "存在失败", g_failures);
    return g_failures == 0 ? 0 : 1;
}
