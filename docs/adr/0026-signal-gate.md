# ADR-026: Signal Gate — 信号关（前后端信息流唯一管理点）

**Status**: Active (2026-09-06)

**Context**: 用户对既有 宿主应用外壳不满（信息不透明、状态不自主），2026-09-06 拍板自产前端壳（v0.22）。但在做前端之前，必须先回答一个问题：**前端需要的信息怎么从状态机流出去、需要前端参与的功能怎么把状态机接回来**。

回答这个问题时，先看清 harness 的现状（[已验证] 读 v0.20 及之前源码）：

1. **状态机是宝贝，不可耦合**。用户的铁律只有一句话——"所有想要耦合到我的宝贝状态机上的都不行，最多就是给你 Hook 点用"。状态机对外唯一的接缝是 v0.19/v0.20 的 Hook 体系（5 个 round 级 hook + HookSystem 生命周期事件），那是信息流接缝，不是功能出口。
2. **部分功能自备信号发射器来沟通前后端**。需要与外部世界说话的功能，各自在自己的模块里放了一个局部总线：rendering 有 `RenderingSignalBus`（v0.20）、记忆分层有 memory-layers 的 `SignalBus`、审批在 extensions.ts 留了个 fail-closed stub（注释 "TODO: wire up the actual handler"）、提问挂在 `ctx.requestHandler`、日志有全局 `logger.setSink`、StateLine 有 subscribe 通知点。

**现状的不足**：发射器散落在功能里，意味着**跨边界的信息流散落在功能里，没有被管理**。每个功能自开一条通往前端的管线，语义各写一套（有的事件总线、有的函数调用、有的 stub 等接线），前端要理解 18 个不同形状的挂点才能组装出"一个 harness 在干什么"。这违背本工作区的核心思想——**信息流管理，不是功能管理**：信息在哪里流转、经过哪里、谁在消费，应当是体系的一部分，而不是每个功能随手开的一条暗道。

---

## 决策时的思考（用户拍板记录，2026-09-06）

以下按用户的表述记录决策的思考链，不修饰成通用工程语言：

1. **信号关 = 信息流唯一管理点**。前后端交互本质是信息流。把散落在各功能自备发射器里的信息流收编到一个唯一的管理点，这个点就是"信号关"。它不是新发明的中间层，是让跨边界信息流第一次被统一管理——可以统一被观察、路由、记录、重放。

2. **否决线只有一句话**："所有想要耦合到我的宝贝状态机上的都不行，最多就是给你 Hook 点用，再加上部分功能自备一个信号发射器来沟通前后端。"——这句话同时定义了**过去**（状态机的对外世界 = Hook 点 + 功能自备发射器）和**现在**（信号关把这些收编了，仍然不改状态机）。

3. **两类东西都必须走信号关**：
   - **需要前端的功能** → 连接到信号关。审批、提问这类本质是**前端提供的服务**（前端是人机交互的地方，只有它能批、能答），它们不是单向通知，是"后端挂起等前端回话"——所以信号关必须有请求-应答语义（request/resolve + 超时 fail-closed），这是信号关区别于纯事件总线的根本。
   - **需要前后端流转的信息流** → 也走信号关。delta、工具轨迹、渲染产物、日志、记忆活动，全部从这一道门出去。
   
   两者统一进一道门，因为它们是同一枚硬币的两面（出站信息流 / 入站功能请求），共用同一套路由、超时、鉴权、归属标注、记录语义——拆成两条管线，这些语义就要写两遍，还会漂移出不一致。

4. **出站信号统一收口**。渲染基座在 v0.20 有自己的 RenderingSignalBus，但拍板"降级为 Gate 的一级"——bus 先给 Gate，Gate 再转发给渲染基座。理由：渲染产物也是要流到前端的出站信息，**不特殊**，一律在 Gate 收口。前端只订阅 Gate 这一个出口，不需要知道渲染 bus 存在。

---

## Decision

### D1 — Signal Gate 是 harness 自身的信息流管理点，不是插件系统

收编所有跨边界交互为三种通道（按信息流方向划分，不按功能划分）：

| 通道 | 方向 | 语义 | 例子 |
|---|---|---|---|
| **出站事件** GateSignal | 后端→前端 | fire-and-forget | assistant.delta、tool.result、artifact、turn.end、log |
| **请求-应答** GateRequest | 后端挂起等前端 | 阻塞式等待 + 超时 fail-closed | approval（前端审批服务）、ask_user（前端提问服务） |
| **入站命令** GateCommand | 前端→后端 | 带回执的路由 | user.prompt、session.create、approval.decision |

**约束**：Gate 是 harness 自身的信息流接缝（核心哲学第 6 条），不是第三方插件 API。它收编的是 harness 自己的 18 个"需要与人交互"挂点，不制造"任何外部代码都能注册事件"的扩展点。

### D2 — 前端与状态机之间只有信号关系，Signal Gate 是唯一双向中转站

状态机的对外世界保持不变（Hook 点 + 信号发射器收编进 Gate），前端不认识状态机、状态机不认识前端，都只认识 Gate。凡是想耦合到状态机的东西都被这一道门挡在外面——这是 D1 思考链第 2 条的落地。

### D3 — Gate 纯内存可独立测试，Web 层只是通道之一

`createSignalGate()` 是纯函数：只维护 subscribers map + pending requests map + sessions set。不依赖 I/O。可被 CLI 直接用（无前端），可被未来 ACP 协议复用。Web 层（`createWebShellServer()`）只是 Gate 的一个通道适配器，未来可以有第二个（ACP stdio），不需要改 Gate。

### D4 — 单向依赖：状态机不认识 Gate

状态机（loop.ts）的唯一改动 = `onStreamChunk?` 可选回调。默认 undefined 零行为变化。状态机不 import Gate——Gate 通过接线器主动订阅状态机的既有挂点（Hook 点 + 发射器）。

### D5 — 审批不新增机制，替换 handler（"前端提供的服务"接进信号关的第一例）

extensions.ts 的 fail-closed reject stub 替换为 `createGateApprovalHandler`——经 `gate.request('approval')` 调用前端审批服务。审批的判定/grant/fail-closed 语义留在既有链路（write-approval door + ApprovalStore），Gate 只替换"问人"这一环（接线在 signals 侧，extensions.ts 本体不改）。

### D6 — 渲染基座降级为 Gate 的一级（出站信号统一收口）

RenderingSignalBus 先给 Gate（wireRenderingToGateway），Gate 再转发给渲染基座（base.handleSignal）。基座内部实现（renderMarkdown/ArtifactStore/onArtifact）不变；autoSubscribe:false 创建，wiring 是唯一信号入口。**理由见 D1 思考链第 4 条：渲染不特殊，所有出站信号在 Gate 收口。**

### D7 — Web 层用 `ws@8` + `node:http`（纯翻译通道）

`ws@8` 只进 `src/webshell/`，**库核心零外部依赖**。HTTP 用原生 `node:http`（不引 Express/Fastify）。同端口路径分派：/api/v1/cmd → HTTP POST、/api/v1/ws → WS upgrade、/api/v1/snapshot → HTTP GET、/healthz → 免鉴权、其余 → 静态 fallback。Web 层不含业务——"该不该、怎么答"全在 Gate/状态机侧，Web 层只做 HTTP JSON ↔ gate.command / WS ↔ gate 信号的翻译。

### D8 — 断线恢复 = 内存 seq 游标 + 越界全量重拉

不落盘 journal。每条出站信号带单调 seq；服务端维护 500 帧 ring buffer。客户端 `{type:'subscribe', cursors?}` → 回放；buffer 不够 → 发 `resync` → 客户端走 `/api/v1/snapshot` 全量重拉。本机 UI（127.0.0.1）断线罕见、重连快，不落盘是正确的取舍（实证来源：官方 deepseek api-gateway 是远程 Host↔Client 才需持久 journal）。

### D9 — Bearer token 鉴权（fragment 传递）

`randomBytes(32).base64url`（256-bit）；token 放 URL fragment（不进 server 日志）。REST 用 `Authorization: Bearer` 头；WS 用 `Sec-WebSocket-Protocol` 子协议字段（浏览器 WS 无法设 Authorization）。timingSafeEqual 常量时间比较。

---

**Rationale**：本工作区的核心思想是**信息流管理，不是功能管理**。信号关是这个思想在"前后端边界"上的正面落地——跨边界的信息流第一次有唯一管理点，可以被统一观察（谁在发、发给谁）、统一记录（log/turn/tool 全有出站信号）、统一路由（三种通道按方向分）。状态机的纯净性（宝贝不可耦合）与信息流的可管理性（散落发射器收编）在此同时成立：状态机多了一个"发信号"的动作，前端少了一堆"猜状态机在干嘛"的适配。

---

## Consequence

- 新增 `src/signals/`（types + gate + assemble + 8 接线器）+ `src/webshell/`（server + auth + stream）。
- 状态机改动最小：call.ts +1 可选回调、loop.ts +1 可选字段 + 条件 spread、session/types.ts +1 indexed access 字段。
- extensions.ts 未改动——approval handler 是 opt-in 注入。
- 1772 tests 绿（156 文件），0 tsc 错误（验收报告：`docs/v0.21-验收报告.md`）。
- 不新增 guard/metric/config 字段（ADR-015）；不引入第三方插件 API（核心哲学第 6 条）；不改 compose/projection 上下文工程；ADR-020 必保事件清单不改语义（Gate 只新增消费者）。

---

## 类型引用规范

Gate 的信号类型全部引用真实源码类型（import type），不自造平行类型：
- `ToolTurn` ← `im/databus.js` · `IMLoopResult` ← `im/loop.js` · `ApprovalRequest` ← `approval-store.js` · `ArtifactHandle` ← `rendering/base.js` · `LogLevel/LogFields` ← `shared/logger.js` · `SessionHandle/SessionInfo` ← `session/types.js` · `StreamChunk` ← `protocol/types.js`

`GateRequestInput`（request 入参，不含 requestId）是 Gate 内部的入参形态分化，不是重复——requestId 由 Gate 生成（`req-${randomUUID()}`），调用方不应预设。

---

## 信息流架构图

```
┌─────────────────────────────────────────────────────────┐
│ 前端 SPA (v0.22 webapp/)                                 │
│   只连 Web 层契约（WS 事件流 + REST 指令）                │
└───────────────▲──────────────────────────────────────────┘
                │ WS/REST（唯一双向通道）
┌───────────────┴──────────────────────────────────────────┐
│ Web 服务层 (src/webshell/)                                │
│   只做翻译：HTTP JSON ↔ gate.command / gate.snapshot      │
│             WS ↔ gate 信号；不含业务                       │
└───────────────▲──────────────────────────────────────────┘
                │ Gate 进程内 API
┌───────────────┴──────────────────────────────────────────┐
│ Signal Gate (src/signals/) = 信息流唯一管理点              │
│   出站 emit/on · 请求 request/resolve · 入站 command      │
│   （功能自备发射器在此收编：rendering/state-line/logger）   │
└───────────────▲──────────────────────────────────────────┘
                │ ① 接线器订阅既有挂点（Hook 点 + 发射器）
┌───────────────┴──────────────────────────────────────────┐
│ agent-shell 状态机（宝贝，不可耦合，只有 Hook 点）          │
│   call.ts +1 onStreamChunk?（观察者）                    │
└──────────────────────────────────────────────────────────┘
```
