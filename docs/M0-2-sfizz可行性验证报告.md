# M0-2 sfizz 可行性验证报告

- 日期：2026-09-28
- 验证对象：`sfztools/sfizz` v1.2.3（BSD-2-Clause）
- 源码：`https://codeload.github.com/sfztools/sfizz/tar.gz/refs/tags/1.2.3`
- 方法：源码审查为主。**未能做真实运行验证**（原因见 §4）

---

## 1. 结论速览

| # | 待验证问题 | 结论 | 可信度 |
|---|---|---|---|
| 1 | 线程模型能否对接 Oboe 回调 | ✅ 可以 | 高（API 文档 + 源码） |
| 2 | ARIA 扩展覆盖率 | 🟡 证据充分但**未实测** | 中 |
| 3 | 低音区流式能力 | ✅ 支持 | 高（有 FilePool 实现） |
| 4 | 授权与商用 | ✅ BSD-2-Clause | 高（已核对 LICENSE 原文） |

**总体判断：技术路线可行，但存在一个比 sfizz 本身严重得多的外部风险 —— 网络（§4）。**

---

## 2. 逐项证据

### 2.1 线程模型（✅）

- C++ API：`void renderBlock(AudioSpan<float> buffer) noexcept`
- C API：`sfizz_render_block(synth, channels, num_channels, num_frames)`
- 事件按延迟调度，文档明确要求「延迟应小于下一次 `renderBlock()` 的块长度」——
  这正是我们需要的 lookahead 调度模型，与《技术方案》§3.2 的时间戳对齐思路一致。
- 源码中对会取锁的接口明确标注「需在 RT 线程之外运行，且可能长时间不返回」，
  说明设计的线程边界清晰：`renderBlock` 归 RT 线程，其余归控制线程。

**对接方式**：Oboe 是 `mixing` 模式（回调送出数据），sfizz 是 `synthesize` 模式（回调索要数据）。
把 `sfizz_render_block` 放进 Oboe 回调即可，无需额外线程。

### 2.2 ARIA / SFZ 覆盖率（🟡 未实测）

Salamander 的 SFZ 建立在这些语法之上，逐一核对 sfizz 源码：

| 语法 | sfizz 支持 | 证据 |
|---|---|---|
| `#define` 宏 | ✅ | `src/sfizz/parser/Parser.cpp:152` 处理 `define` 指令，含 `$identifier` 校验 |
| `$VAR` 变量替换 | ✅ | 同上，变量未定义时会在 `Parser.cpp:541` 发出警告 |
| `set_hdcc$NN` | ✅ | 出现在 3 个文件中 |
| `xxx_oncc$NN`（如 `offset_oncc98`、`amplitude_oncc`） | ✅ | **通用派生**：`Opcode.cpp:109` 用 `StrAppend(&derivedName, "_oncc", ccNumberSuffix())` 拼出，不为每个组合单独登记 |
| `loop_mode` / `loop_crossfade` | ✅ | 各出现在 2 个文件 |
| `trigger` | ✅ | 出现在 2 个文件 |
| `sw_last`（keyswitch） | ✅ | 出现在 1 个文件 |

> ⚠️ **注意**：若用 `grep "amplitude_oncc"` 查源码会得到 0 命中，这不代表不支持 ——
> 它是运行时按 `基名 + _onccNN` 派生的。不要据此误判。

**未能闭合的部分**：没有在真实 Salamander SFZ 上跑一遍。
理论上剩下的风险点在于个别 opcode 的**语义差异**（支持解析 ≠ 行为完全一致），
这类问题只能靠实跑发现。

### 2.3 流式能力（✅）

- `src/sfizz/FilePool.{h,cpp}` 实现按需加载：
  - voice 需要采样时向 FilePool 请求，**后台线程**加载；
  - 有 GC 机制回收「为播放而加载」的采样（预加载的不受影响）；
  - 有 `preload_size` 控制，修改它会触发重载逻辑。
- 另有 freewheeling 模式：每次渲染回调前等待后台加载完成（离线渲染用，
  实时场景不用，但说明流式链路是完整的）。

**对本项目的意义**：低音区「常驻 attack + 尾部流式」的方案（技术方案 §4.3）
可以直接映射到 sfizz 的 preload_size + FilePool，**不需要我们自己写流式**。
这是 sfizz 路线最大的收益点 —— M0-6 的低音区流式验证工作因此可以大幅缩减。

### 2.4 授权（✅）

```
BSD 2-Clause License
Copyright (c) 2021-2023, sfizz contributors (detailed in AUTHORS.md)
All rights reserved.
```

BSD-2-Clause，商用友好，只需保留版权声明与免责声明。
（注：已归档的 `sfztools/sfizz-juce` 是 GPLv3，**不要用那个**。）

### 2.5 Android 构建（✅ 有专门处理）

`cmake/SfizzConfig.cmake` 对 ARM 分支加 `-mfpu=neon`，并**正确地在 Android 上省略 `-mfloat-abi=hard`**
（该 flag 在 Android 工具链下非法）。说明维护者考虑过 Android。

---

## 3. 引入成本（原估 2 人日，需上修）

**sfizz 的 `external/` 全部是 git submodule，共 10 个：**

```
abseil-cpp   atomic_queue   cephes   cxxopts   filesystem
fmidi        jsl            simde    st_audiofile   threadpool
```

从 codeload 下载的 tarball **不包含** submodule 内容 —— 实测 `external/abseil-cpp`、
`external/simde`、`external/filesystem` 均为 0 个文件。

而 `cmake/GitSubmoduleCheck.cmake` 会在 CMake 配置阶段执行
`git submodule update --init --recursive`，**需要 git 直连 GitHub**。

**影响**：
- 在当前网络下，需要逐个从 codeload 拉取并手工放置，或配置代理。
- `abseil-cpp` 体积可观，在 44 KB/s 下耗时明显。
- 且 submodule 版本必须与 sfizz 1.2.3 记录的一致，手工放置容易出错。

**建议**：把 M1 的 2 人日上修到 **3 人日**，并在开工前先把依赖拉齐（可作为 M0 的收尾任务）。

---

## 4. 最重要的发现：网络环境是项目级阻塞

### 4.1 实测连通性

| 通道 | 结果 |
|---|---|
| `github.com` | ❌ 000（不通） |
| `api.github.com` | ❌ 000 |
| `raw.githubusercontent.com` | ❌ 000 |
| `archive.org`（音源原始托管） | ❌ 000 |
| `ghproxy` / `ghfast.top` 等加速站 | ❌ 000 |
| **`codeload.github.com`** | ✅ 通，但 **44 KB/s** |
| **`cdn.jsdelivr.net`** | 🟡 部分可用（sfizz 能取，Salamander 未缓存） |
| `gitee.com` | ✅ 通 |

### 4.2 为什么这比 sfizz 本身严重

**M2 音源流水线必须从 `sfzinstruments/SalamanderGrandPiano` 拉取约 700MB 音源。**

- `github.com` 与 `raw.githubusercontent.com` 均不通；
- 唯一可用的 `codeload` 只有 44 KB/s → 700MB 需要 **4.4 小时以上**，
  且中途断线无法续传（实测服务器**不支持 byte range**，`curl -C -` 直接报错）；
- `archive.org` 这个备选源也不通。

也就是说，**按当前网络，M2 实际上无法执行**。

### 4.3 必须做的决策（阻塞 M2）

1. **配置代理 / VPN**（最直接）。团队若已有，验证 `github.com` 可达即可解封。
2. **人工预下载**：在有网络的环境拉好音源包，走移动硬盘/内网分发，
   并纳入版本控制或内部制品库。
3. **换音源**：若无法解决网络，需重新评估音源选型 ——
   但 Salamander 的「16 力度层 + 小三度采样 + CC BY」组合很难找到等价替代，
   且换源意味着《技术方案》§2 全部重做。
4. **jsDelivr 兜底**（仅对音源部分可能有效）：jsDelivr 有文件大小上限，
   单条采样约 1–2MB 或许可过，但 480 个文件逐个拉取同样受限于其回源速度。
   需实测，暂不作为方案。

**建议**：优先按 1 处理。这属于环境问题，越早解决越好，否则 M2（排期 10 人日、关键路径最长）
会整体卡住。

---

## 5. 结论与建议

1. **sfizz 技术路线成立**，四个问题中三个已确证、一个证据充分但待实测。
2. **M1 工时从 2 人日上修到 3 人日**（submodule 依赖引入）。
3. **M0-6（低音区流式验证）可以并入 M1** —— sfizz 的 FilePool 已提供该能力，
   自研方案下的这套工作量大部分可以省掉。
4. **M2 被网络阻塞，需先做 §4.3 的决策**。这是当前项目的第一优先级风险，
   高于 sfizz 集成本身。
5. 补齐实测的剩余路径：拿到 Salamander 的 SFZ + Data 文件后（这两个是纯文本、体积小），
   在 x86 桌面环境下编译 sfizz 跑一遍即可闭合问题 2 —— 无需等 Android 构建。

---

## 6. 未完成事项

| 项 | 原因 |
|---|---|
| 在真实 Salamander SFZ 上运行 sfizz | 音源仓库拉取被网络阻塞 |
| sfizz 编译产物体积（.so 大小） | 依赖 submodule 未拉齐，无法编译 |
| ARM NEON 下的实际 CPU 占用 | 同上 |
