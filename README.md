# virtual-piano（虚拟钢琴）

基于 **Cocos Creator 3.8.8** 的**高仿真钢琴**小游戏：横屏布局的 88 键键盘，配真实钢琴音源与**自研 C++ 原生音频引擎**，追求低延迟、高并发的琴键演奏体验。

项目为移动端（Android）设计，重点解决三个工程难题：**音源冷启动耗时**、**琴键点击区域失效**、**移动端底部键盘被裁切**——每个问题在 `docs/` 下都有完整的定位与修复文档。

## 技术栈

| 分类 | 技术 |
|---|---|
| 引擎 | Cocos Creator 3.8.8 |
| 语言 | TypeScript（业务逻辑） + C++（原生音频引擎） |
| 音源 | Salamander Grand Piano（真实钢琴采样） |
| 目标平台 | Android（含 x86_64 模拟器配置） |
| 测试 | 自研 JS 测试（6 套）+ C++ 测试 |

## 核心特性

### 高仿真键盘
- `KeyLayout.ts`：88 键的键位、音高与坐标布局计算。
- `KeyboardView` / `KeyboardViewport`：键盘渲染与**横屏视口适配**（解决移动端底部被裁切问题）。
- `KeyboardGesture` / `KeyboardInput` / `TouchRouter`：手势识别、多点触控输入与事件路由，支持滑奏（glissando）与多指和弦。
- `KeyboardState`：按键按下/抬起状态管理，避免重复触发。

### 音频引擎
采用**后端抽象**设计，原生与 Web 两套实现可互换：

- `PianoEngine`：音频总控，向上暴露演奏 API。
- `AudioBackend`（接口）→ `NativeBackend`（C++ 原生引擎） / `WebBackend`（WebAudio 回退）。
- `WebAudioEngine`：Web 端实现。
- `AudioClock` / `EngineAudioClock`：高精度音频时钟，保证音符时序准确。
- `EventBatcher`：输入事件合批，减少跨语言（JS ↔ C++）调用次数。
- `EventCodec`：事件编解码，压缩跨语言传输的数据量。
- `PreviewBankData` / `PianoTypes`：音源库数据与类型定义。
- `native/engine/`：C++ 原生音频引擎源码。

### 音源管线
- `audio-src/`：音源原料。
- `build-bank/`：打包后的音源库。
- `tools/audio-pipeline`、`tools/fetch-salamander.sh`、`tools/verify-salamander.py`：音源的下载、处理与校验流程。

### UI
- `ui/DebugHud.ts`：调试信息面板（帧率、延迟、事件统计）。
- `ui/SceneBackground.ts`：场景背景。

## 项目结构

```
virtual-piano/
├── assets/
│   ├── scenes/                 # 游戏场景
│   └── scripts/
│       ├── PianoController.ts  # 主控制器
│       ├── audio/              # 音频引擎（后端抽象 / 时钟 / 事件合批 / 类型）
│       ├── keyboard/           # 键盘布局、渲染、输入、手势、视口
│       └── ui/                 # 调试 HUD、背景
├── native/engine/              # C++ 原生音频引擎
├── audio-src/                  # 音源原料
├── build-bank/                 # 音源库打包产物
├── build-configs/              # 构建配置（android.json / android-x86_64.json）
├── tools/                      # 音源管线与校验脚本
├── tests/                      # 单元测试（eventbatcher / eventcodec / keyboardinput / keylayout / pianotypes / viewport）
├── docs/                       # 技术方案与问题定位文档（见下）
├── settings/ · profiles/       # 编辑器与构建配置
└── package.json · tsconfig.json
```

## 设计文档

`docs/` 下是该项目的核心工程记录，建议按问题线索阅读：

| 文档 | 内容 |
|---|---|
| [横屏高仿真钢琴技术方案.md](docs/横屏高仿真钢琴技术方案.md) | 整体技术选型与架构设计 |
| [横屏高仿真钢琴落地实施方案.md](docs/横屏高仿真钢琴落地实施方案.md) | 具体实施步骤与里程碑 |
| [M0-2-sfizz可行性验证报告.md](docs/M0-2-sfizz可行性验证报告.md) | 音源方案 sfizz 的可行性验证 |
| [音源冷启动载入耗时定位与优化方案.md](docs/音源冷启动载入耗时定位与优化方案.md) | 冷启动加载耗时的定位与优化 |
| [琴键点击区域失效定位与修复方案.md](docs/琴键点击区域失效定位与修复方案.md) | 触摸命中区域失效问题的根因与修复 |
| [移动端键盘底部被裁问题定位与修复方案.md](docs/移动端键盘底部被裁问题定位与修复方案.md) | 横屏适配与安全区处理 |
| [构建环境与命令行构建.md](docs/构建环境与命令行构建.md) | 命令行构建流程 |
| [项目代码功能清单与解耦方案.md](docs/项目代码功能清单与解耦方案.md) | 模块职责梳理与解耦计划 |

## 开发与测试

1. 安装 **Cocos Creator 3.8.8**，打开本目录，等待资源导入。
2. 通过编辑器预览运行，或在「构建发布」中选择 **Android** 平台构建（构建配置见 `build-configs/`）。
3. 运行单元测试：

```bash
cd tests && ./run.sh
```

覆盖 `EventBatcher`、`EventCodec`、`KeyboardInput`、`KeyLayout`、`PianoTypes`、`Viewport` 六个模块。

## 备注

项目在架构上明确区分**业务层（TypeScript）与性能层（C++）**：键盘布局、手势、UI 用 TS 实现以便快速迭代；音频调度与事件处理下沉到 C++ 原生引擎以压榨延迟。跨语言调用通过 `EventBatcher` 合批 + `EventCodec` 编码来降低开销，这是本项目性能优化的关键点。
