/****************************************************************************
 * 钢琴音频内核 —— 采样数据源
 *
 * 文件 IO 与解码的抽象。从 SampleBank.h 里拆出来：银行不关心数据从哪儿来，
 * 只关心拿到的 PCM 对不对。
 ****************************************************************************/

#pragma once

#include <cstdint>
#include <memory>
#include <vector>

namespace piano {

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

}  // namespace piano
