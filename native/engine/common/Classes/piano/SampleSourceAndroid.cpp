/****************************************************************************
 * 钢琴音频内核 —— Android 采样数据源
 *
 * 音源包作为 Android **assets** 随 APK 分发（见 native/engine/android/app/build.gradle
 * 里额外挂的 assets 源目录）。注意 assets 不是文件系统路径 —— `fopen` /
 * `drflac_open_file` 都打不开它，必须经 AAssetManager。
 *
 * AAssetManager 从 Cocos 的 `cc::FileUtilsAndroid` 取，不自己走 JNI ——
 * 引擎已经持有它了，重复获取只会多一处出错的地方。
 *
 * ## dr_flac 的实现放在这里
 *
 * dr_flac 是单头库，`DR_FLAC_IMPLEMENTATION` 必须在**恰好一个**翻译单元里定义。
 * 放在这个文件是因为：它是唯一用到 dr_flac 的地方，而且已经平台隔离
 * （非 Android 平台整段被条件编译掉，不会与其他实现冲突）。
 ****************************************************************************/

#include "SampleBank.h"

#if defined(__ANDROID__)

    #include <android/asset_manager.h>

    #include <cstring>

    #include "platform/android/FileUtils-android.h"

    #define DR_FLAC_IMPLEMENTATION
    #include "dr_flac.h"

namespace piano {
namespace {

// dr_flac 的三个回调。签名必须与 dr_flac.h 里的 typedef 逐字一致 ——
// 注意 read 返回的是**读到的字节数**（不是结果码），而 seek/tell 返回布尔。
// 记错了会得到一个「找不到匹配的重载」的编译错误。

/** 读取回调：返回实际读到的字节数 */
size_t assetRead(void* user, void* out, size_t bytesToRead) {
    auto* asset = static_cast<AAsset*>(user);
    const int n = AAsset_read(asset, out, bytesToRead);
    return n > 0 ? static_cast<size_t>(n) : 0;
}

/** 定位回调 */
drflac_bool32 assetSeek(void* user, int offset, drflac_seek_origin origin) {
    auto* asset = static_cast<AAsset*>(user);
    const int whence = (origin == DRFLAC_SEEK_SET) ? SEEK_SET
                     : (origin == DRFLAC_SEEK_CUR) ? SEEK_CUR
                                                   : SEEK_END;
    return AAsset_seek(asset, static_cast<off_t>(offset), whence) >= 0 ? DRFLAC_TRUE
                                                                      : DRFLAC_FALSE;
}

/** 上报当前读写位置 */
drflac_bool32 assetTell(void* user, drflac_int64* cursor) {
    auto* asset = static_cast<AAsset*>(user);
    const off_t pos = AAsset_seek(asset, 0, SEEK_CUR);
    if (pos < 0) {
        return DRFLAC_FALSE;
    }
    *cursor = static_cast<drflac_int64>(pos);
    return DRFLAC_TRUE;
}

class AssetSampleSource final : public SampleSource {
public:
    bool open(const char* relativePath) override {
        close();

        AAssetManager* manager = cc::FileUtilsAndroid::getAssetManager();
        if (manager == nullptr || relativePath == nullptr) {
            return false;
        }

        _asset = AAssetManager_open(manager, relativePath, AASSET_MODE_RANDOM);
        if (_asset == nullptr) {
            return false;
        }

        drflac_uint32 channels = 0;
        drflac_uint32 sampleRate = 0;
        drflac_uint64 frames = 0;
        // 一次性读全 —— 采样最长二十几秒，值得换解码器状态机的简单。
        // 直接要 s16：音源本身就是 16bit，不会有精度损失。
        _pcm = drflac_open_and_read_pcm_frames_s16(assetRead, assetSeek, assetTell, _asset,
                                                   &channels, &sampleRate, &frames, nullptr);
        if (_pcm == nullptr) {
            close();
            return false;
        }

        // 解码完就不需要 asset 了，早点还回去
        AAsset_close(_asset);
        _asset = nullptr;

        // 只支持立体声 —— 音源与引擎输出都是立体声，单声道素材说明包有问题，
        // 与其猜怎么上混，不如直接拒绝，让上层按「这条没载入」处理。
        if (channels != 2 || frames == 0) {
            close();
            return false;
        }

        _frames = static_cast<uint32_t>(frames);
        return true;
    }

    uint32_t frames() const override { return _frames; }

    uint32_t readAll(int16_t* out) override {
        if (_pcm == nullptr || out == nullptr) {
            return 0;
        }
        std::memcpy(out, _pcm, static_cast<size_t>(_frames) * 2 * sizeof(int16_t));
        return _frames;
    }

    void close() override {
        if (_pcm != nullptr) {
            drflac_free(_pcm, nullptr);
            _pcm = nullptr;
        }
        if (_asset != nullptr) {
            AAsset_close(_asset);
            _asset = nullptr;
        }
        _frames = 0;
    }

    bool readFile(const char* relativePath, std::vector<uint8_t>& out) override {
        AAssetManager* manager = cc::FileUtilsAndroid::getAssetManager();
        if (manager == nullptr || relativePath == nullptr) {
            return false;
        }

        AAsset* asset = AAssetManager_open(manager, relativePath, AASSET_MODE_BUFFER);
        if (asset == nullptr) {
            return false;
        }

        const off_t length = AAsset_getLength(asset);
        if (length <= 0) {
            AAsset_close(asset);
            return false;
        }

        out.resize(static_cast<size_t>(length));
        const int read = AAsset_read(asset, out.data(), out.size());
        AAsset_close(asset);

        if (read != static_cast<int>(out.size())) {
            out.clear();
            return false;
        }
        return true;
    }

private:
    AAsset* _asset = nullptr;
    drflac_int16* _pcm = nullptr;
    uint32_t _frames = 0;
};

}  // namespace

std::unique_ptr<SampleSource> createPlatformSampleSource() {
    return std::make_unique<AssetSampleSource>();
}

}  // namespace piano

#else  // !__ANDROID__

namespace piano {

std::unique_ptr<SampleSource> createPlatformSampleSource() {
    // 非 Android 平台（如桌面单元测试）不提供默认数据源。
    // 返回 nullptr 而不是编译失败 —— 测试可以自己实现一个内存版。
    return nullptr;
}

}  // namespace piano

#endif  // __ANDROID__
