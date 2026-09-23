// index.ts — barrel for the v0.16 security subsystem.
//
// Re-exports the door factory functions. Type re-exports from types.ts are
// commented out until Agent A lands src/security/types.ts; once it exists,
// uncomment the type re-export line and remove the local interface blocks
// from each door file.
//
// Consumers (extensions.ts / bootstrapExtensions) import from here:
//   import {
//     createSensitivePathDoor,
//     createDangerousCommandDoor,
//     createWriteApprovalDoor,
//   } from '../security/index.js'

export { createSensitivePathDoor } from './doors/sensitive-path.js'
export { createDangerousCommandDoor } from './doors/dangerous-command.js'
export { createWriteApprovalDoor } from './doors/write-approval.js'
export { createBrowserToolsDoor } from './doors/browser-tools.js'
export type { WriteApprovalDoorOptions } from './doors/write-approval.js'

export type {
  SessionId,
  SessionSecurityState,
  SecurityDecision,
  SecurityDoor,
} from './types.js'
/**
 * @deprecated v0.20: SecurityRouter is dissolved into ToolRegistry (hook
 * morphology — registry.checkDoors() at the systemSecurityHooks position).
 * Retained only as the executable spec for door-dispatch semantics
 * (tests/security/router.test.ts). New code: use ToolRegistry.registerDoor().
 */
export { SecurityRouter } from './router.js'
