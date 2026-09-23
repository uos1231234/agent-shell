# ADR-029: per-session 权限独立 + permission.changed 推送（方案 B）——全局广播删除

**Status**: Accepted (2026-09-07)

**Context**: v0.22 的权限控件（PermissionControl）为全局广播：`permission.full` 命令无 sessionId，宿主 `setFullPermission` 遍历全部 openHandles 统一设置（assembly 的 `for...of`），前端为本地 useState 乐观显示（无出站信号、无查询命令，刷新/多标签页状态失真）。2026-09-07 核查"前端切换权限对会话是否实时"时暴露三重边界问题：① 只覆盖已打开会话（新开会话不受影响）；② 前端显示 ≠ 后端真实状态（刷新后失配，无状态查询通道）；③ 已挂起的审批请求不受切换影响（正确语义，但需文档化）。

**决策**（用户拍板 2026-09-07，方案 B，push 信号）：

1. **每个会话的权限独立**——`permission.full` 命令加 `sessionId`（`{ kind: 'permission.full'; sessionId: string; enabled: boolean }`）；`SignalGateHandlers.setFullPermission(sessionId, enabled)` 只作用于目标会话（会话未打开抛干净错误，与 runPrompt 同款）。**全局广播删除**（assembly 的 `for...of openHandles` 遍历不复存在）。
2. **state push 同步**——新增出站信号 `permission.changed { sessionId, full }`：
   - 宿主在 `session.open` / `session.create` 完成后推送当前状态（**含重复 open 已打开会话的幂等推送**——注意 attachHandle 幂等短路，推送必须放在 open handler 层而非 attachHandle 内，否则"标签页 B 打开已打开会话"拿不到状态）；
   - `permission.full` 生效后由**状态持有者（宿主 handler）**emit，gate 保持纯路由。
3. **前端删本地乐观**——store 加 `SessionView.permissionFull` 字段忠实投影信号，PermissionControl 显示 = store = 后端事实源，刷新/多标签页天然同步（WS 广播所有客户端）。这是"UI 是信号的忠实投影"原则（v0.22 §4.1）的权限版。
4. **不提供 pull 命令**（否决方案 A 的 permission.get）——权限是低频操作，初始状态由 open/create 推送、变更由命令回执推送，两个时机都有信号，pull 命令冗余且破坏"只 push"的对称性。
5. **边界**：已挂起的审批请求不受权限切换影响（gate.request 的 promise 仍需用户回包，fail-closed 兜底）——"切换自动放行挂起审批"是假实时，不做。

**Consequences**:
- 存储层本就 per-session（registry.securitySessions 每会话独立 SessionSecurityState），决策使控制与存储一致。
- 测试：库级 assembly per-session 独立性测试（切 A 后 B 不受影响、open/create 推送、未打开会话报错）+ webapp reducer 测试（只更新目标会话）。
- 验证：库 1876 tests 绿 / webapp 71 tests 绿 / 双 tsc 0 错。
- 相关文件：src/signals/types.ts（命令+信号+handler 签名）、src/signals/gate.ts（per-session 路由）、src/host/assembly.ts（删除全局广播 + 推送）、webapp（store reducer + PermissionControl）。