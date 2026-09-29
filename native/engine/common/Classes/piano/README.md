# 钢琴音频内核（C++）

自研的实时钢琴音频内核，双端共用（本项目当前只编 Android）。
所有自研 C++ 代码都放在这个目录下。

对应文档：[落地实施方案 §2](../../../../../docs/横屏高仿真钢琴落地实施方案.md)、[技术方案 §4](../../../../../docs/横屏高仿真钢琴技术方案.md)

## 为什么绕开 Cocos 的音频层

已核实 Cocos 3.8.8 的音频 API 不满足需求：

| 限制 | 后果 |
|---|---|
| `AudioPlayer` 无 `playbackRate` / 变调接口 | Salamander 是「小三度采样 + 变调覆盖 88 键」，跑不起来 |
| `AudioSource.playOneShot` 受 `maxAudioChannel` 上限约束 | 超出会**丢弃**发声，64 复音无法保证 |
| 无 ADSR / 滤波器 / 实时音量自动化 | 半踏板、琴盖、明亮度补偿都做不了 |

所以音频这条路完全自己走：`AudioDevice`（Oboe）+ 采样器内核，经 JSB 绑定暴露给 TS。

## 目录内容（M0-1 现状）

| 文件 | 说明 |
|---|---|
| `PianoEvent.h` | 演奏事件结构，16 字节定长。**接口契约，已冻结** |
| `PianoParams.h` | 参数 ID、复音上限、队列容量常量 |
| `PianoEngine.h` / `.cpp` | 对外门面。M0 阶段为骨架，尚无音频设备 |

尚未接入：`EventQueue`（M1-1）、`AudioDevice`（M0-3）、`SfizzAdapter`（M1-2）、`StreamLoader`（M1-2D）。

## 三条不可违反的约束

**1. 音频回调里禁止一切阻塞操作。**
不得加锁、不得堆分配（`new` / `malloc` / 会扩容的容器）、不得文件 IO、不得 JNI 调用、不得抛异常。这是代码评审的**一票否决项** —— 违反会导致爆音甚至崩溃。

**2. 触屏事件必须按帧批量提交。**
`submitEvents` 是全工程唯一的每帧跨语言调用，禁止为每个音符单独调一次，也禁止用 `jsb.reflection.callStaticMethod` 传事件（JNI 反射 + 字符串解析会直接吃掉延迟预算）。

**3. `PianoEvent` 的 16 字节布局不可改。**
TS 侧按定长数组写入 `ArrayBuffer`，布局错位的症状是「音符乱响」而不是崩溃，极难排查。`static_assert` 已经卡住了，不要绕过。

## 接入 CMake

源码清单在同级的 `common/piano.cmake`。需要在 `native/engine/common/CMakeLists.txt`
**末尾**追加一行：

```cmake
include(${CMAKE_CURRENT_LIST_DIR}/piano.cmake)
```

⚠️ **为什么现在没有替你加上**：`native/engine/common/` 整个目录是 Cocos 首次原生构建时
从模板生成的（当前仓库里还不存在）。如果提前手建 `CMakeLists.txt`，Cocos 会认为该文件
已存在而跳过复制，导致模板里的 `Classes/Game.cpp` 永远不会生成，构建直接失败。

所以正确顺序是：

1. 先做一次 Android 构建，让 Cocos 生成 `native/engine/common/`
2. 在生成的 `CMakeLists.txt` 末尾加上那行 `include`
3. 再构建一次，用下面的命令验证

本目录与 `piano.cmake` 都不在 Cocos 模板里，首次构建不会被动到，可以放心先提交。

## 验证代码确实被编进去了

```bash
find build -name "libcocos.so" -exec strings {} \; | grep piano-engine
```

查到 `piano-engine-m0-skeleton` 即接入成功。查不到说明那行 `include` 没生效。
