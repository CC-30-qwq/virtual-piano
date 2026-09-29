# 测试

目前只覆盖**不依赖 Cocos 运行时**的纯逻辑。带 `cc` 依赖的代码（渲染、触摸）
只能在编辑器或真机里验证，不在这一层。

## 为什么能这样测

Cocos 的 TS 编译是**剥离类型**的 —— 构建通过不代表类型正确。
而 `tsc --noEmit` 又会因为引擎自带的 `cc.d.ts` / `jsb.d.ts` 报出约 60 个
与业务无关的错误（缺 DOM、WebGPU、`pal/*` 类型）。`tsconfig.json` 里加了
`skipLibCheck` 之后，类型检查结果就只剩我们自己代码的问题，可以直接当 CI 关卡。

## 运行

```bash
bash tests/run.sh
```

脚本会依次跑类型检查与全部测试，任一项失败则退出码非 0，可直接接 CI。

工程内没有 node 环境和测试框架，但 **Cocos 编辑器自带的 node 与 TypeScript
可以直接用** —— `ELECTRON_RUN_AS_NODE=1` 会让 `CocosCreator.exe` 以纯 node 运行。
所以不需要额外安装任何东西。Cocos 安装路径不同的话用环境变量覆盖：

```bash
COCOS_CREATOR="D:/Cocos/editors/Creator/3.8.8/CocosCreator.exe" bash tests/run.sh
```

## 覆盖范围

### keylayout.test.js —— 键位几何（24 项）

`KeyLayout.ts` 不 import 任何 `cc` 模块，可以单独编译到 node 下运行。

| 项 | 断言内容 |
|---|---|
| 键数 | 52 白 + 36 黑 = 88，范围恰为 A0(21)…C8(108) |
| 完整性 | 88 个音高无缺失、无重复，越界返回 null |
| 白键排布 | 从 x=0 起紧密排列，总宽 = 52 × 键宽 |
| 黑键定位 | 每个黑键中心精确落在相邻白键分界线上 |
| 黑键音级 | 每八度恰为 C# D# F# G# A# |
| 命中测试 | 白键低位命中自身；黑键覆盖区**黑键优先**；黑键正下方低位仍命中白键 |
| 滚动 | 偏移夹紧边界；键盘比视口窄时居中；居中定位后目标键恰在视口中心 |

### pianotypes.test.js —— TS ↔ C++ 事件契约（47 项）

**这是全工程最值得测的一处。** `PianoEvent` 是定长二进制结构，两侧布局一旦错位，
症状是「音符乱响」而不是崩溃，靠日志几乎查不出来。

C++ 侧由 `PianoEvent.h` 的 `static_assert` 在**编译期**卡住 7 个字段的偏移量；
这里在**测试期**卡住 TS 侧的同一组偏移量。两边合起来才构成闭环。

| 项 | 断言内容 |
|---|---|
| 常量 | `EVENT_STRIDE` / `MAX_VOICES` / `EVENT_QUEUE_CAPACITY` |
| 枚举值 | `EventType` / `EventSource` / `ParamId` 逐项与 C++ 对齐 |
| 字节布局 | type@0 note@1 velocity@2 source@3 timeMs@4 reserved@8,12 |
| 小端序 | 用 `timeMs = 1.0` 的 IEEE754 字节序反查确认 |
| 越界钳位 | 200 钳到 127（**不是**掩码成 72）；负数钳到 0 |
| 容量 | 写满后返回 false 且不增计数；`clear()` 后可继续写 |
| 互不覆盖 | 多事件写入后逐条回读，确认没有错位 |

## 后续

`TouchRouter` 的力度映射与滑奏防抖目前无法在这一层测（依赖 `EventTouch`）。
若要覆盖，需要把「位置 → 力度」的换算抽成纯函数单独放出来。
