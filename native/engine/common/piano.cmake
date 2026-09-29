#############################################################################
# 自研钢琴音频内核 —— 源码清单与接入方式
#
# ## 为什么单独一个文件
#
# native/engine/common/CMakeLists.txt 是 Cocos 模板生成的，直接往里堆源码，
# 将来引擎升级或模板重新生成时容易被冲掉。这里把清单隔离出来，
# CMakeLists.txt 只需要多一行 include，改动面最小、也最好恢复。
#
# ## 接入方式（重要）
#
# 在 native/engine/common/CMakeLists.txt 的**最末尾**追加一行：
#
#     include(${CMAKE_CURRENT_LIST_DIR}/piano.cmake)
#
# 必须加在末尾，不能加在开头 —— 因为文件开头的
# `include(${COCOS_X_PATH}/CMakeLists.txt)` 之后才轮到
# `list(APPEND CC_COMMON_SOURCES ...)`，而 CC_COMMON_SOURCES 的实际消费
# 发生在这一串之后。插到前面，本次 append 会被后面的赋值盖掉。
#
# ## 生效范围
#
# CC_COMMON_SOURCES 会被平台 CMakeLists（如 native/engine/android/CMakeLists.txt）
# 汇入 CC_ALL_SOURCES，最终进 `add_library(cocos SHARED ...)`，
# 与引擎一起编进 libcocos.so。因此本文件对所有原生平台通用。
#
# ## 验证是否生效
#
# 构建后执行（产物路径以实际为准）：
#
#     find build -name "libcocos.so" -exec strings {} \; | grep piano-engine
#
# 能查到 "piano-engine-m0-skeleton" 即说明接入成功；
# 查不到就说明这行 include 没加上，或被模板覆盖了。
#############################################################################

set(PIANO_DIR ${CMAKE_CURRENT_LIST_DIR}/Classes/piano)

list(APPEND CC_COMMON_SOURCES
    ${PIANO_DIR}/PianoEvent.h
    ${PIANO_DIR}/PianoParams.h
    ${PIANO_DIR}/PianoEngine.h
    ${PIANO_DIR}/PianoEngine.cpp
    ${PIANO_DIR}/EventQueue.h
    ${PIANO_DIR}/EventQueue.cpp
    ${PIANO_DIR}/SampleBank.h
    ${PIANO_DIR}/SampleBank.cpp
    ${PIANO_DIR}/Resampler.h
    ${PIANO_DIR}/Voice.h
    ${PIANO_DIR}/Voice.cpp
    ${PIANO_DIR}/VoicePool.h
    ${PIANO_DIR}/VoicePool.cpp
    ${PIANO_DIR}/SampleSourceAndroid.cpp
    ${PIANO_DIR}/AudioDevice.h
    ${PIANO_DIR}/AudioDeviceAAudio.cpp
    ${PIANO_DIR}/PianoBridge.h
    ${PIANO_DIR}/PianoBridge.cpp
)

# 供 Game.cpp 等调用方直接 #include "PianoEngine.h"
include_directories(${PIANO_DIR})

# 单头 FLAC 解码器 dr_flac.h
include_directories(${CMAKE_CURRENT_LIST_DIR}/third_party)

#############################################################################
# AAudio
#
# AAudio 是 NDK 平台库，sysroot 里自带，不需要任何外部依赖 ——
# 在 GitHub 不通的环境下这点很关键。
#
# 但 libaaudio.so 只从 API 26 起提供，因此要求 minSdk >= 26。
# 本工程已把 minSdk 抬到 26，见 native/engine/android/app/build.gradle。
#
# 用 link_libraries（目录作用域）而不是 target_link_libraries：
# 本文件是在 add_library(cocos ...) **之前**被 include 的，
# 那时 target 还不存在。目录作用域会对随后创建的 target 生效。
#############################################################################
if(ANDROID)
    link_libraries(aaudio)
endif()

#############################################################################
# 后续接入点（按里程碑逐步放开）
#
# M1-1  EventQueue.cpp
#
# M1-2  SfizzAdapter.cpp，接入 third_party/sfizz
#       —— 需要先解决 sfizz 的 10 个 external submodule（见 M0-2 报告）
#
# M1-2D StreamLoader.cpp（自研降级路线才需要）
#############################################################################
