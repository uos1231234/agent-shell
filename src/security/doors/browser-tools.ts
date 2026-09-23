// browser-tools.ts
//
// SecurityDoor that limits browser + computer-interaction tools to 1 concurrent
// invocation per session. open_url and read_media interact with the external
// world (opening a browser, reading media) — serializing them prevents races
// and keeps external side effects predictable.
//
// The door implements the optional release() method: check() reserves a slot,
// release() frees it after the tool finishes (called by ToolRegistry.releaseTool
// in a finally block inside ToolRegistry.execute — v0.20, formerly
// SecurityRouter.releaseTool).

import type {
  SessionId,
  SessionSecurityState,
  SecurityDecision,
  SecurityDoor,
} from '../types.js'

/** Tools that interact with the external world (browser, media, desktop). */
const BROWSER_TOOLS = new Set(['open_url', 'read_media'])

export function createBrowserToolsDoor(): SecurityDoor {
  // Per-session in-flight tracking. Keyed by sessionId so different sessions
  // don't block each other.
  const inFlight = new Set<SessionId>()

  return {
    name: 'browser-tools',
    check(sessionId, _state, toolName, _args, _ctx) {
      if (!BROWSER_TOOLS.has(toolName)) {
        return { allow: true }
      }
      if (inFlight.has(sessionId)) {
        return {
          allow: false,
          reason: `another browser/computer tool is already running in this session; ` +
            `browser tools are limited to 1 concurrent call`,
        }
      }
      inFlight.add(sessionId)
      return { allow: true }
    },
    release(sessionId, toolName) {
      if (BROWSER_TOOLS.has(toolName)) {
        inFlight.delete(sessionId)
      }
    },
  }
}
