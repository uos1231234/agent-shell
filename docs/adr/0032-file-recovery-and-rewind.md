# ADR-032: 文件可恢复（file-history 快照 + session.rewind）

> Status: Active
> Date: 2026-09-11（用户拍板方向）/ 2026-09-12（v0.36.1 缺口修复补记）
> Context: v0.35 安全加固收尾时，用户提出「安全的本质是可恢复」——沙箱常破坏体验，
> 而 AI 改错代码用户能撤销即可；真正无解的是「AI 删库」。

---

## Context

agent-shell 此前的安全面全是**拦截型**：危险命令分类器（v0.15/v0.35）、敏感路径门禁
（v0.15/v0.35.2）、写审批。它们回答"这件事要不要做"，不回答"做错了怎么办"。

实证缺口：`src/im/tools/write.ts` 直接 `fsWriteFile` 裸写；`edit.ts` /
`search-replace.ts` 同类。仓库里的 `.bak` 只保护**宿主自身状态**（config / mcp /
system-agent-persistence / wiki-mcp），**用户工作区文件零保护**。既有 `/undo`
（`src/host/session-undo.ts`）只撤**对话回合**，不碰文件。

对标事实（`本地对标仓库`）：mimo-codex 用 file-history（写前 copyFile，MAX 100）；
mimo-cli 用 git 快照（prune 7d）；**AtomCode 做过但因磁盘占用在 v5.0.5 禁用**
（`snapshot.rs:125`，"temporarily disabled ... to protect disk space"）。
→ 任何快照方案必须**自带配额 + GC**，否则会重演 AtomCode。

---

## Decisions

### D1 — 保护范围按"有没有别的撤销机制"划，不按"重不重要"划

白名单 = 代码 + Markdown/HTML/CSS + 结构化文本（json/yaml/toml…）+ 几个无扩展名
的常规文本文件（Makefile/Dockerfile/…）。

**`.docx` / `.xlsx` 刻意放弃**：它们是 zip 包，AI 改一次基本整块重写，快照既无信息量
又占地方；而 Office/WPS 自带版本历史。反过来，代码文件**没有任何默认撤销机制**
（除非用户自己会 git）——这才是要补的缺口。目录黑名单（node_modules/.git/dist…）
与敏感文件（复用 `isSensitivePath`）一律不进快照库：快照的语义是把内容复制到另一个
目录，绝不能因此扩大凭据的落盘面。

### D2 — 内容寻址 + 四道闸门同批交付

对象按内容 sha256 命名（同内容只落一份，结构性去重）。四道闸门：单文件 2MB /
索引 2000 条 / 总字节 128MB / LRU 回收 + 对象清扫。这是对 AtomCode 教训的正面回应：
配额不是后续优化，是功能的一部分。

### D3 — 快照是旁路：失败不阻断、但必须留痕

快照失败（TOCTOU、磁盘满、rename 被占用）**不抛**——写盘才是用户要的事。但**不静默**：
`recordInner` / `prune` / `rewind` 的失败路径都出 `logger.warn`（组件名
`file-history`）。v0.36 首版是空 catch，v0.36.1 补上（P0-2）——"零观测"曾让 Windows 上
prune 的 rename 失败看起来像"一切正常"。

### D4 — 回滚权只在用户手里

LLM 不持有 rewind 能力（工具面没有它），入口是 gate 命令 `session.rewind`：
网页端按钮发 `{ sessionId, entries: 'last-turn' }`，宿主换算条数并执行。**前端不直连
磁盘、不自己数快照**（快照记录在宿主侧）——一切走信号关。CLI 不做 `/rewind`（用户
2026-09-12 裁定：本功能只在网页端上线）；后端能力保留，将来要 CLI 入口只需加一个
slash 命令调同一条 gate 命令。

### D5 — 三组结果分开报，不假装成功

回执是 `{ restored, deleted, unbacked, entries }`，**不是**一个"完成"。`unbacked`
（当时超出单文件上限、没有内容副本的文件）必须如实上报——它撤不回来。同理，工具层
在"文件确实被改了但没留底"时会在返回文本尾部追加一行提示（`snapshotGapNotice` /
`summarizeSnapshotGaps`），把设计边界**显性化**给用户，而不是悄悄扩大保护范围。

### D6 — 索引操作串行化（v0.36.1 P0-1）

竞态：`writeIndex` 是 read → 写 tmp → rename，而 `appendIndex` 是独立一次 append。
两者交错时 append 可能落在**已被 rename 掉的旧 inode** 上 → 该条记录随旧 inode 消失。
Node 单线程让窗口只存在于 await 边界，概率低但不是零；Windows 上更常见的表现是 rename
被占用而 EPERM（prune 静默失败、不回收）。

做法：实例内一条 Promise 队列（`withIndexLock`），把所有**索引**读写串起来。只串索引——
对象写入是内容寻址且幂等的。**不做**跨进程文件锁：当前是单进程多实例，跨实例冲突窗口
极小且后果只是少一条记录。

### D7 — `'last-turn'` 是**近似**，且刻意选择近似

快照记录没有 turn 标识（`record` 由工具层调用，拿不到 loop 的 turn 边界），所以只能按
时间簇聚类：从最新一条往回走，相邻两条间隔 > 10 分钟即认为跨了 turn。偏差两边都有
（同一 turn 内停手超 10 分钟 → 少撤；两个 turn 挨得近 → 多撤）。可接受的理由：按钮语义
就是"撤掉刚才这批改动"，且结果面板逐条列出**具体撤了哪些文件**，用户能立刻看见。

---

## Consequences

- 用户获得"AI 改坏代码可一键还原"的能力，且**不依赖**用户会 git、不依赖 OS 沙箱
  （Windows 上同样可用）。这是与「沙箱路线」正交的一条路：沙箱管"跑不出去"，快照管
  "改错了能回来"。
- 代价：磁盘占用受四道闸门约束；`record` 会再读一次源文件（2MB 以内的文本可接受）。
- 与 `session.undo` 正交（那个撤对话、这个撤文件），可单独或组合使用。

## 明确不做（本轮）

- 跨进程文件锁（窗口极小、后果仅丢单条记录）
- prune 按会话分组回收（配额是**全局资源**语义，对标 mimo-codex 的全局 MAX_SNAPSHOTS）
- 保留 `unbacked` 的记录（无内容副本，留着也不能还原）
- rewind 中途崩溃一致性（索引删除在还原循环之后，中途崩只是记录还在、可重试，无部分
  回滚窗口——静态审查已确认，不修）
- 把 docx/xlsx 纳入保护（用户拍板放弃）
- 删除只进回收站 / 「AI 删库」的最终解法（用户指定上线前再定；关键 tradeoff：「删除只
  进回收站」会极大降低 LLM 帮用户清理磁盘的效率——回收站不清空即不释放空间，这是产品
  账不只是安全账）
