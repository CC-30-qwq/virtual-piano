# 测试

两层测试，都**不需要额外安装任何东西**：TS 层用 Cocos 编辑器自带的 node 与 tsc，
C++ 层用本机 MSVC。

| 层 | 命令 | 覆盖 | 依赖 |
|---|---|---|---|
| TS | `bash tests/run.sh` | 类型检查 + 键位/视口/输入/事件契约与攒批 | 编辑器自带 `CocosCreator.exe`（当 node 用） |
| C++ | `bash tests/cpp/run.sh` | 无锁队列、音源解析与内存池、发声、复音、参数与诊断 | 本机 MSVC（`cl.exe`） |
| C++ 编译核对 | `bash tests/cpp/syntax_check.sh` | 只编译不链接，覆盖 `PianoEngine.cpp` 这类链不进去的文件 | 同上 |

## 为什么能这样测

Cocos 的 TS 编译是**剥离类型**的 —— 构建通过不代表类型正确。
而 `tsc --noEmit` 又会因为引擎自带的 `cc.d.ts` / `jsb.d.ts` 报出约 60 个
与业务无关的错误（缺 DOM、WebGPU、`pal/*` 类型）。`tsconfig.json` 里加了
`skipLibCheck` 之后，类型检查结果就只剩我们自己代码的问题，可以直接当 CI 关卡。

工程内没有 node 环境和测试框架，但 **Cocos 编辑器自带的 node 与 TypeScript
可以直接用** —— `ELECTRON_RUN_AS_NODE=1` 会让 `CocosCreator.exe` 以纯 node 运行。

C++ 侧同理：NDK 的 clang 编出来的东西本机跑不了，所以**把不依赖 Cocos 的那部分
内核单独编成宿主可执行文件**。这些源码本来就不该依赖引擎，能这样测反而说明分层是干净的。

## 覆盖范围

### TS 层（`tests/run.sh`）

编译目标：`KeyLayout.ts`、`KeyboardViewport.ts`、`KeyboardInput.ts`、`PianoTypes.ts`、
`EventBatcher.ts`（含 `AudioClock.ts`）。这些文件都不 import `cc`，可以单独编到 node 下跑。

产物**按源码的相对目录结构摆放**，不做拍平 —— 模块之间用相对路径互相 require
（例如 `KeyboardInput` 要 `../audio/PianoTypes`），拍平之后跨目录就解析不到了。

| 文件 | 项数 | 断言内容 |
|---|---|---|
| `keylayout.test.js` | 29 | 88 键范围与完整性、白键紧密排布、黑键对准分界线、黑键音级、命中测试（黑键优先/命中区放宽）、滚动夹紧与居中 |
| `viewport.test.js` | 46 | 自动铺满、比视口窄时居中、滚动夹紧、**缩放锚点不动**（捏哪放大哪）、缩放上下限、复位、夹紧优先于锚点、可见范围、变更通知的几何/偏移区分 |
| `keyboardinput.test.js` | 68 | 按下与松开、未命中仍计数、重复 id、十指并发、全部释放、滑奏换键、同键内移动不触发、移出键盘保持原音、**键缝抖动防抖**、力度（含黑键按自身高度归一）、固定力度、`KeyboardState` 只在实际变化时通知 |
| `pianotypes.test.js` | 47 | 常量与枚举逐项与 C++ 对齐、16 字节布局、小端序、越界钳位（**钳到 127 而不是掩码**）、容量与清空 |
| `eventbatcher.test.js` | 53 | 从出口字节反解事件布局、多事件互不覆盖、时钟偏移与前瞻换算、帧间时间戳差、缓冲满丢弃、后端不可用不计丢弃、`reset` 语义 |

### C++ 层（`tests/cpp/run.sh`）

源码清单来自 `native/engine/common/Classes/piano/pure_sources.cmake`
（**与 Android 构建共用同一份**，不要在脚本里另写一遍）。

| 文件 | 断言内容 |
|---|---|
| `eventqueue_test.cpp` | 单线程行为、环绕、批量、**1e7 事件 SPSC 并发压测**（序号连续性查丢包/乱序/撕裂） |
| `samplebank_test.cpp` | manifest 解析、损坏数据拒绝、非均匀力度映射、根音查找、常驻载入与失败回退，外加对**真实 `build-bank/manifest.bin`** 的集成检查（30 根音 / 16 区间 / 88 锤击 …） |
| `voice_test.cpp` | 变调音高精度、Hermite 插值质量、头尾无爆音、释放斜坡、累加混音 |
| `voicepool_test.cpp` | 复音上限、偷取策略（优先偷释放态）、踏板挂起、同音重触发、缺失力度层回退 |
| `kernelstate_test.cpp` | 参数默认值/往返/越界不越写、诊断计数的累加量与瞬时量、**并发累加不丢** |

⚠️ 必须用 `/O2`（脚本已固定）：Debug 下编译器重排保守，内存序写错也常常能跑对。

### 编译核对（`tests/cpp/syntax_check.sh`）

有些文件既不在宿主测试里、又只能在 Android 构建时被编译 —— 典型是 `PianoEngine.cpp`：
它用了平台无关的接口，但宿主测试链不进去（`AudioDevice::create()` 在本机返回 nullptr）。
这个脚本对它们只做 `/c`：能抓语法与类型错误，抓不到行为错误。

## 不在这两层里的东西

- **渲染与触摸的 `cc` 依赖部分**：`KeyboardView`（Graphics 绘制与绘制顺序）、
  `TouchRouter`（相机坐标换算）、`KeyboardGesture` 的事件处理、
  `PianoController` 的装配 —— 只能在编辑器或真机验证。
  ⚠️ `KeyboardView` 曾漏过一个 `Graphics.fill()` 语义相关的 bug（整块键盘变蓝），
  就是因为这一层测不到；共用逻辑已尽量下沉到纯类，但绘制本身仍只能靠人眼。
- **JSB 绑定链**：`PianoBridge.cpp` / `Game.cpp` 需要 Cocos 头文件，靠 Android 构建验证。
- **真机音频行为**：延迟、欠载、音色 —— 靠 M0-5/M0-7 的延迟测量页与听感复检。

## 接 CI

两个 `run.sh` 任一项失败都返回非 0，可以直接接。（仓库目前没有 CI 配置。）

```bash
bash tests/run.sh && bash tests/cpp/run.sh && bash tests/cpp/syntax_check.sh
```

Cocos 安装路径不同的话用环境变量覆盖：

```bash
COCOS_CREATOR="D:/Cocos/editors/Creator/3.8.8/CocosCreator.exe" bash tests/run.sh
VCVARS="C:/Program Files/Microsoft Visual Studio/2022/Community/VC/Auxiliary/Build/vcvars64.bat" bash tests/cpp/run.sh
```
