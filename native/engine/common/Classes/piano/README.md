# 钢琴音频内核（C++）

自研的实时钢琴音频内核，双端共用（本项目当前只编 Android）。
所有自研 C++ 代码都放在这个目录下。

对应文档：[落地实施方案 §3](../../../../../docs/横屏高仿真钢琴落地实施方案.md)、[技术方案 §4](../../../../../docs/横屏高仿真钢琴技术方案.md)

## 为什么绕开 Cocos 的音频层

已核实 Cocos 3.8.8 的音频 API 不满足需求：

| 限制 | 后果 |
|---|---|
| `AudioPlayer` 无 `playbackRate` / 变调接口 | Salamander 是「小三度采样 + 变调覆盖 88 键」，跑不起来 |
| `AudioSource.playOneShot` 受 `maxAudioChannel` 上限约束 | 超出会**丢弃**发声，64 复音无法保证 |
| 无 ADSR / 滤波器 / 实时音量自动化 | 半踏板、琴盖、明亮度补偿都做不了 |

所以音频这条路完全自己走：`AudioDevice`（AAudio）+ 采样器内核，经 JSB 绑定暴露给 TS。

## 目录结构：按「依赖了什么」分层

这个分层是刻意的 —— 它决定了哪些代码能在宿主机上测、哪些只能等真机。

### 契约（无依赖，改一处必须两边同步）

| 文件 | 说明 |
|---|---|
| `PianoEvent.h` | 演奏事件结构，16 字节定长。**接口契约，已冻结**，7 条 `static_assert` 卡住字段偏移 |
| `PianoParams.h` | 参数 ID、参数个数、复音上限、队列容量 |

### 纯逻辑（不依赖 Cocos，可宿主测试）

| 文件 | 说明 |
|---|---|
| `EventQueue.h/.cpp` | SPSC 无锁环形队列，解耦提交线程与音频线程 |
| `BankModel.h` | 音源数据模型：采样层、根音、力度区间、释放类采样元数据 |
| `ManifestReader.h/.cpp` | 二进制 manifest 的格式与解析（换音源格式只动这里） |
| `SamplePool.h/.cpp` | 常驻 PCM 的所有权与游标（换内存策略只动这里） |
| `SampleBank.h/.cpp` | 载入策略（哪些层常驻）+ 查表（音高/力度 → 采样层） |
| `SampleSource.h` | 采样数据源的抽象（文件 IO 与解码被隔在这后面，测试可喂内存数据） |
| `Resampler.h` | Hermite 四点插值与变调比例 |
| `Voice.h/.cpp` | 单个发声中的音：采样播放、变调、释放斜坡、尾淡出 |
| `VoicePool.h/.cpp` | 复音管理（定长 64、无运行期分配）、偷取策略、踏板挂起 |
| `Diagnostics.h` | 诊断计数（跨线程，内部原子量） |
| `ParamStore.h` | 参数存储、边界校验与默认值 |

前四类由 `pure_sources.cmake` 的清单驱动，`tests/cpp/run.sh` 用同一份清单编成宿主可执行文件跑测试。

### 平台与引擎（只能靠 Android 构建 / 真机验证）

| 文件 | 说明 |
|---|---|
| `AudioDevice.h` | 音频设备抽象：生命周期、时钟、欠载计数 |
| `AudioDeviceAAudio.cpp` | AAudio 实现与 `AudioDevice::create()` 工厂 |
| `SampleSourceAndroid.cpp` | 经 AAssetManager 读 assets + `dr_flac.h` 解码，落地 `DR_FLAC_IMPLEMENTATION` |
| `PianoEngine.h/.cpp` | 对外门面 + 音频渲染回调。**唯一的上帝结构体**（见下） |
| `PianoBridge.h/.cpp` | sebind 注册全局 `jsbPiano`，零拷贝读 TS 的 ArrayBuffer |

### 构建脚本

| 文件 | 说明 |
|---|---|
| `pure_sources.cmake` | 不依赖 Cocos 的源码清单，**Android 构建与宿主测试共用同一份** |
| `../piano.cmake` | 把上面的清单 + 平台源码挂进 `CC_COMMON_SOURCES`，并链接 AAudio |

## 三条不可违反的约束

**1. 音频回调里禁止一切阻塞操作。**
不得加锁、不得堆分配（`new` / `malloc` / 会扩容的容器）、不得文件 IO、不得 JNI 调用、不得抛异常。这是代码评审的**一票否决项** —— 违反会导致爆音甚至崩溃。

**2. 触屏事件必须按帧批量提交。**
`submitEvents` 是全工程唯一的每帧跨语言调用，禁止为每个音符单独调一次，也禁止用 `jsb.reflection.callStaticMethod` 传事件（JNI 反射 + 字符串解析会直接吃掉延迟预算）。

**3. `PianoEvent` 的 16 字节布局不可改。**
TS 侧按定长数组写入 `ArrayBuffer`，布局错位的症状是「音符乱响」而不是崩溃，极难排查。`static_assert` 已经卡住了，不要绕过。

## 已知的技术债

| 位置 | 问题 |
|---|---|
| `PianoEngine::Impl` | 仍是一个装着设备、队列、音源、复音、参数、诊断的结构体。C1 已把参数（`ParamStore`）与诊断（`Diagnostics`）拆出去，剩下的音频状态与调度逻辑尚未再分 |
| `ParamStore` | 普通数组，没做跨线程无锁化。参数还没有读取方，接 M4 时必须先解决（见该文件头的约定） |
| `PianoEngine::render` | 事件在**块首**一次性派发，还没按 `timeMs` 做块内调度 —— 时序精度是「一个音频块」（48kHz/192 帧约 4ms），功能验证够用，手感不够 |
| 尾部流式 | `StreamLoader` 不存在（M1-6）。`SampleLayer::tailFrames` 只记了元数据 |
| 释放采样 | hammer / harmonics 已解析入库，但还没接入发声（M1-5 的后半） |

## 接入 CMake

已在 `native/engine/common/CMakeLists.txt` **末尾**加了一行：

```cmake
include(${CMAKE_CURRENT_LIST_DIR}/piano.cmake)
```

新增内核 `.cpp` 时**只需改 `pure_sources.cmake`**（如果它不依赖 Cocos）或 `piano.cmake` 的平台段。
两项都不要漏 —— `tests/cpp/syntax_check.sh` 能提前发现「编不过」，但发现不了「忘了加进清单」。

## 验证代码确实被编进去了

```bash
find build -name "libcocos.so" -exec strings {} \; | grep piano-engine
```

查到 `piano-engine-m0-skeleton` 即接入成功。查不到说明那行 `include` 没生效。

## 宿主侧怎么测

```bash
bash tests/cpp/run.sh            # 编译并运行全部内核测试（纯逻辑）
bash tests/cpp/syntax_check.sh   # 只编译（覆盖 PianoEngine.cpp 这类链不进去的文件）
```

两者都不用 CMake、不用 NDK，只需要本机 MSVC。
