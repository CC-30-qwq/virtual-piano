#############################################################################
# 不依赖 Cocos 的内核源码 —— **这份清单只维护一处**
#
# 两个消费方：
#   1. native/engine/common/piano.cmake —— 参与 Android 构建（与引擎一起进 libcocos.so）
#   2. tests/cpp/run.sh               —— 编成宿主可执行文件跑测试
#      （NDK clang 编出来的东西在本机跑不了，所以宿主测试要单独编一遍）
#
# ## 为什么值得单独一份
#
# 这两处曾经各写一遍。于是新增一个内核 .cpp 时，漏加任何一处都不会立刻报错：
#   - 漏在 piano.cmake 里 → 要等一场完整的 Android 构建（几分钟）才浮现
#   - 漏在 run.sh 里      → 宿主测试链接失败，看起来像源码有问题
# 历史上已经漏过一次（见 tests/cpp/voicepool_test.cpp 的文件头注释）。
#
# ## 约定
#
# 只写**文件名**，目录由消费方自己拼（CMake 用 ${PIANO_DIR}，run.sh 用 $PIANO）——
# 这样两头都不必知道对方的路径变量叫什么。
#
# 只列 .cpp：纯头文件的模块（Resampler / PianoEvent / Diagnostics …）
# 靠 include 进来，不需要编译。
#############################################################################

set(PIANO_PURE_SOURCES
    EventQueue.cpp
    ManifestReader.cpp
    SampleBank.cpp
    SamplePool.cpp
    Voice.cpp
    VoicePool.cpp
)
