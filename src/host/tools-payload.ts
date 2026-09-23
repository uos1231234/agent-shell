// v0.28: session.event 'tools' 的 payload 构建——白名单 refs → {name,
// description}[]。纪律载体在 description（唯一事实源是 registry，本模块只读
// 不复制）。放在 src/host（宿主装配层，v0.26 自 src/webshell 迁入——装配层
// 不得依赖 web 传输层）而不是 examples/web-host.ts：宿主入口
// 顶层就跑 main()，测试无法 import；本模块仅 import type，零运行时依赖。
// MCP/skill 工具不在此列（动态披露面，非白名单静态面）——ref 在 registry 的
// 系统工具表里不存在时直接跳过。

import type { ToolRegistry } from '../shell/registry.js'
import type { SessionToolsPayload } from '../signals/types.js'

/** v0.28: 白名单 refs → {name, description}[]。ref 在 registry 不存在时跳过。 */
export const buildToolsPayload = (
  registry: ToolRegistry,
  refs: readonly string[],
): SessionToolsPayload => {
  const tools = refs.flatMap((name) => {
    const tool = registry.getSystemTool(name)
    return tool ? [{ name: tool.name, description: tool.description }] : []
  })
  return { tools }
}
