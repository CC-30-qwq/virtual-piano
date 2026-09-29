// 一次性基准：用工程自带的 dr_flac 解一批 FLAC，量吞吐。
//
// 目的：估算真机上「解码 252MB 常驻 PCM」到底要多久，以及并行解码能快多少。
// 之所以要用同一份 dr_flac：ffmpeg 的解码器比它快得多，用 ffmpeg 的数字
// 会严重低估真机耗时。
//
// 用法：drflac_bench <目录> [线程数]

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <filesystem>
#include <string>
#include <thread>
#include <vector>

#define DR_FLAC_IMPLEMENTATION
#include "dr_flac.h"

namespace fs = std::filesystem;

struct Stat {
    std::string path;
    uint64_t frames = 0;
    double ms = 0;
};

static Stat decodeOne(const std::string& path) {
    Stat s;
    s.path = path;

    const auto t0 = std::chrono::steady_clock::now();

    unsigned int channels = 0, sampleRate = 0;
    drflac_uint64 frames = 0;
    drflac_int16* pcm = drflac_open_file_and_read_pcm_frames_s16(
        path.c_str(), &channels, &sampleRate, &frames, nullptr);
    if (pcm != nullptr) {
        drflac_free(pcm, nullptr);
        s.frames = frames;
    }

    s.ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
    return s;
}

int main(int argc, char** argv) {
    if (argc < 2) {
        std::printf("用法: drflac_bench <目录> [线程数]\n");
        return 2;
    }
    const std::string dir = argv[1];
    const int workers = argc > 2 ? std::atoi(argv[2]) : 1;
    const std::string filter = argc > 3 ? argv[3] : "";

    std::vector<std::string> files;
    for (const auto& e : fs::directory_iterator(dir)) {
        const std::string name = e.path().filename().string();
        if (e.path().extension() != ".flac") continue;
        if (!filter.empty() && name.find(filter) == std::string::npos) continue;
        files.push_back(e.path().string());
    }
    std::sort(files.begin(), files.end());
    if (files.empty()) {
        std::printf("目录里没有 .flac\n");
        return 2;
    }

    std::vector<Stat> stats(files.size());
    std::atomic<size_t> next{0};

    const auto wall0 = std::chrono::steady_clock::now();
    auto consume = [&] {
        for (;;) {
            const size_t i = next.fetch_add(1);
            if (i >= files.size()) break;
            stats[i] = decodeOne(files[i]);
        }
    };

    std::vector<std::thread> threads;
    for (int w = 1; w < workers; ++w) threads.emplace_back(consume);
    consume();
    for (auto& t : threads) t.join();
    const double wallMs =
        std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - wall0).count();

    uint64_t frames = 0;
    double cpuMs = 0, maxMs = 0;
    std::string slowest;
    for (const Stat& s : stats) {
        frames += s.frames;
        cpuMs += s.ms;
        if (s.ms > maxMs) { maxMs = s.ms; slowest = fs::path(s.path).filename().string(); }
    }

    const double pcmMb = static_cast<double>(frames) * 4.0 / 1048576.0;
    std::printf("文件 %zu 个，线程 %d\n", files.size(), workers);
    std::printf("产出 PCM      %.1f MB\n", pcmMb);
    std::printf("墙钟          %.0f ms\n", wallMs);
    std::printf("CPU 累计      %.0f ms\n", cpuMs);
    std::printf("吞吐（墙钟）  %.0f MB/s\n", pcmMb / (wallMs / 1000.0));
    std::printf("单条最慢      %.1f ms (%s)\n", maxMs, slowest.c_str());
    return 0;
}
