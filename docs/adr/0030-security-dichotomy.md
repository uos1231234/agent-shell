# ADR-030: 安全二分——整体安全在 shell（二楼），工具安全在 im/tools（三楼）

**Status**: Accepted (2026-09-07)

**Context**: 架构审查时发现 `src/shell/` 对 `src/im/tools/` 有 3 条 import（registry → helpers 的 reason 校验/报错翻译/结果截断 + approval-store 审批记账本；compose → reasonField 规则文本），按"shell 不 import im"的字面楼规曾被误判为"历史遗留违反"，并一度建议"搬家下沉到 shared"。用户否决该定性，并给出根因性决策。

**决策**（用户拍板 2026-09-07）：**安全分两类——整体安全在 shell（二楼），工具安全在 im/tools（三楼）**。

- **整体安全**（会话怎么安全跑完：guard / 预算 / 终止条件 / 状态机）→ shell；
- **工具安全**（单个工具调用怎么把关：reason 校验、报错翻译、结果修剪、审批记账）→ im/tools；
- 因此二楼的工具登记册（收发工具调用）引用三楼工具安全零件，是**符合分层意图的刻意设计，不是债，不搬家不下沉**。

**边界纪律**：shell → im 的引用**只允许**落在 `im/tools` 的工具安全零件上；一旦出现对 im 整体安全（loop / guards）、会话、记忆投影等业务层的引用，即越过"整体安全在二楼"的边界，属真违反，需纠正。引用面恰好封顶于 3 条，可复验：`grep "from '../im" src/shell/*.ts`。

**Consequences**:
- 3 条 import 保留，不迁移；"shell 零 im import"的表述在 AGENTS.md 中修正为"shell 允许引用 im/tools 的工具安全零件"。
- 分层审查的判定框架更新：审查报告的"跨层 import"结论必须区分**工具安全引用（合法）**与**业务引用（违规）**，不能只看 import 路径字面。
- 相关文件：src/shell/registry.ts、src/shell/compose.ts、src/im/tools/helpers.ts、src/im/tools/security/approval-store.ts（均为现状确认，无代码改动）。