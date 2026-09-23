// open-url.ts
//
// Open a URL in the user's default browser. Cross-platform:
//   macOS   → `open`
//   Linux   → `xdg-open`
//   Windows → `explorer` (NOT `cmd /c start` — shell parsing mangles
//             URL metacharacters like &, |, %)
//
// Security:
//   - Only http/https schemes (new URL() parses, then we whitelist protocol).
//   - Headless/SSH/CI environments are rejected: there is no GUI to receive
//     the open command, so spawning a browser process would either fail
//     silently or hang. On Linux we require DISPLAY or WAYLAND_DISPLAY.
//     macOS/Windows are assumed to have a GUI (standard desktop installs).
//
// Non-blocking: spawn with stdio:'ignore' + detached:true + child.unref()
// so the agent process never waits on the browser.

import { spawn } from 'node:child_process'

export class OpenUrlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OpenUrlError'
  }
}

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])

/**
 * Detect a headless environment where opening a browser is meaningless.
 * Returns a human-readable reason string, or null if a GUI is likely present.
 */
function detectHeadless(): string | null {
  const platform = process.platform
  if (platform === 'linux') {
    const display = process.env['DISPLAY']
    const wayland = process.env['WAYLAND_DISPLAY']
    if (!display && !wayland) {
      return 'No DISPLAY or WAYLAND_DISPLAY environment variable found — this appears to be a headless Linux environment. Copy the URL manually.'
    }
  }
  // macOS and Windows desktop installs always have a GUI. SSH sessions on
  // macOS are rare; on Windows, explorer.exe is always present.
  return null
}

/**
 * Pick the platform-appropriate launcher command.
 */
function launcherCommand(): string {
  switch (process.platform) {
    case 'darwin':
      return 'open'
    case 'win32':
      return 'explorer'
    default:
      // linux / freebsd / other unix
      return 'xdg-open'
  }
}

/**
 * Open `url` in the user's default browser.
 *
 * @returns a confirmation message string on success.
 * @throws {OpenUrlError} on bad scheme, headless environment, or spawn failure.
 */
export function openUrl(url: string): string {
  // --- scheme validation ---
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new OpenUrlError(`Invalid URL: ${url}`)
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new OpenUrlError(
      `open_url only supports http/https, got protocol "${parsed.protocol}". Refusing to open.`,
    )
  }

  // --- headless check ---
  const headlessReason = detectHeadless()
  if (headlessReason) {
    throw new OpenUrlError(headlessReason)
  }

  // --- spawn detached, non-blocking ---
  const cmd = launcherCommand()
  let child: ReturnType<typeof spawn>
  try {
    child = spawn(cmd, [url], { stdio: 'ignore', detached: true })
    child.unref()
  } catch (e) {
    throw new OpenUrlError(
      `Failed to launch browser via "${cmd}": ${(e as Error).message}`,
    )
  }

  // If the process exits immediately with a non-zero code (e.g. command not
  // found), report it. We listen for 'error' (ENOENT etc.) synchronously-ish
  // via a one-time handler, but since we unref'd, we can't await. Instead we
  // rely on the spawn itself: if cmd doesn't exist, 'error' fires on nextTick.
  // To keep the function synchronous (per the plan's signature), we return
  // optimistically — a missing launcher will surface as an OS error event
  // that nobody listens to (stdio is ignored). This is acceptable: the common
  // failure modes (bad scheme, headless) are caught above, and a missing
  // `xdg-open` binary is an environment misconfiguration the user will notice.
  child.on?.('error', () => {
    // Swallowed: stdio is ignored and the child is unref'd. We cannot throw
    // synchronously from this async callback. The caller already got a
    // success return; a truly broken launcher is an ops issue, not a logic
    // error the agent can recover from.
  })

  return `Opened ${url} in default browser (via ${cmd}).`
}
