// v0.20 rendering base — thin forwarding hook (plan v0.20-rendering-base.md §5.4).
//
// createRenderingLoopHook(bus) returns an AfterToolExecutionHook that does
// exactly one thing: forward every ToolTurn to the bus in order, then return
// undefined. It knows no tool names, does no matching/extraction/rendering,
// and never intervenes in control flow — `return undefined` is the LoopHooks
// contract's "not intervening" signal (callHook then uses default behavior,
// see src/im/loop-hooks.ts).
//
// All intelligence lives behind the bus: matching/extraction run inside
// RenderRules registered on the RenderingSignalBus (signal-bus.ts). This file
// stays one line of forwarding per turn — deliberately, per plan §5.4
// "没有第二行逻辑".
//
// toolName note (plan D3a): ToolTurn.toolName is optional. bus.emit's
// parameter is `string`, so this hook forwards `t.toolName ?? ''` — a pure
// type bridge, not logic: no rule matches '' so nothing is emitted, which is
// exactly the "toolName undefined → match all false → silent" behavior.

import type { RenderingSignalBus } from '../signal-bus.js'
import type { AfterToolExecutionHook } from '../../im/loop-hooks.js'

export const createRenderingLoopHook = (bus: RenderingSignalBus): AfterToolExecutionHook =>
  async ({ toolResults }) => {
    for (const t of toolResults) await bus.emit(t.toolName ?? '', t)
    return undefined
  }
