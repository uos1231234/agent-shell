# ADR-028: 数据落盘与用户知情——args 随落盘全量保留（撤销 ADR v0.24 "args 不落盘"）

**Status**: Accepted (2026-09-09)

**Supersedes**: v0.24 拍板"args 不落盘"（docs/plans/v0.24-deliverables-ux.md 决策表第 3 行，已加 superseded 注记）

**Context**: v0.24（2026-09-07）曾拍板"ToolTurn.args 只活在内存（databus 投影 + gate 信号），不落盘、不进 prompt"，动机：① assistant turn 的 `toolCalls[].function.arguments` 已含参数原文，databus 再落盘是冗余副本；② 敏感内容明文扩散（write 含文件全文）；③ 前端恢复路径 historyToItems 已从 assistant turn safeParse 出参数，闭环不依赖 ToolTurn.args 落盘。实现位置 `src/im/loop.ts` persistTurn 调用点（`{ ...tr, args: undefined }`）。

2026-09-09 核查落盘数据时发现该决策的**隐藏代价**：落盘剥离导致 **recovery 恢复后的内存 Databus args 恒为 undefined**——databus 的消费方是 LLM 侧工具活动理解（databus_query 工具、压缩管线、子代理工具史），args 是工具事件语义核心；"调了 write"与"调了 write 写了什么"是两个信息量级。热路径（运行中内存 databus）带 args，恢复路径不带，同一会话前后行为不一致；databus_query 在恢复后首查即缺参数，增加 LLM 使用困难。

**决策**：**撤销 v0.24 剥离，args 随落盘全量保留**。`persistTurn(tr)` 原样落盘（conversation.jsonl 与 databus.jsonl 的 tool 行均带完整 args）。同时确立配套原则：

1. **"冗余"论点只在渲染视角成立，在 databus 消费视角不成立**——databus_query 只返回 databus 行，背后没有 assistant turn 可兜底；databus 的语义契约是工具事件完整记录（call 身份 + 参数 + 结果）。
2. **敏感内容取舍不替用户决定**——落盘范围（明文、TTL、谁可访问、安全边界）写入 **用户协议须提及.md**（docs/），作为未来正式用户协议的必提 checklist，由用户自决（删除会话 / 手工清理 ~/.databus/sessions/ 是当前可用的退出选项）。
3. **估算口径（v0.24 改动② wire-format，args 不进 prompt 序列化）不受影响、保持不变**——落盘与上下文估算两条路径独立。

**Consequences**:
- 磁盘增量：tool turn 落盘多一份 args 副本（含 write 全文）——这是"完整工具史可召回"的代价，接受。
- 恢复路径与热路径行为一致：recoverSession 重建的内存 Databus 带 args，databus_query / 子代理 / 压缩管线无差别。
- 测试：tests/im/loop-args-boundary.test.ts 断言翻转为"落盘带 args 且与内存一致"。
- 验证：真实 mock 会话落盘 conversation.jsonl + databus.jsonl tool 行均带完整 args [已验证]；全量 2185 tests 绿。
- 相关文件：src/im/loop.ts（删剥离）、tests/im/loop-args-boundary.test.ts、docs/plans/v0.24-deliverables-ux.md（superseded 注记）、docs/用户协议须提及.md（新建）。