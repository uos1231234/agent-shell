// rg-resolver.ts
//
// Resolves the ripgrep binary location. ripgrep is a HARD dependency for the
// search subsystem — if we cannot find it, we throw RgNotFoundError with
// install instructions. There is NO Node RegExp fallback.
//
// Resolution order:
//   1. System PATH  (`which rg` / `where rg`)
//   2. Bundled      (future — returns null for now)
//   3. Downloaded   (future — throws "not yet implemented" for now)
//
// The download + bundled paths are stubbed with clear TODO markers. The
// system-PATH path is fully implemented and is the only path that works
// today. If rg is not on PATH the error message tells the user exactly how
// to install it.

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export type RgResolution = {
  path: string
  source: 'system-path' | 'bundled' | 'downloaded'
}

export class RgNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RgNotFoundError'
  }
}

/**
 * User-facing install instructions. Embedded in the RgNotFoundError message
 * so callers (and the LLM) see exactly what to do.
 */
export const RG_INSTALL_INSTRUCTIONS = `ripgrep (rg) is required but was not found on your PATH.

Install it with one of:
  - scoop install ripgrep          (Windows / Scoop)
  - choco install ripgrep          (Windows / Chocolatey)
  - winget install BurntSushi.Ripgrep.MSVC  (Windows / Winget)
  - brew install ripgrep           (macOS / Homebrew)
  - apt install ripgrep            (Debian / Ubuntu)
  - dnf install ripgrep            (Fedora)
  - pacman -S ripgrep              (Arch)
  - Download a binary from https://github.com/BurntSouce/ripgrep/releases

After installing, ensure the 'rg' binary is on your PATH and re-run.`

const EXECUTABLE_NAME = process.platform === 'win32' ? 'rg.exe' : 'rg'

/**
 * Find `rg` on the system PATH by shelling out to the OS lookup utility.
 * Returns the absolute path or null if not found.
 *
 * We use execFileSync (sync) because resolution happens once at startup;
 * making it async would just add a microtask hop with no benefit.
 */
const findOnSystemPath = (): string | null => {
  try {
    if (process.platform === 'win32') {
      // `where rg` prints one path per line; take the first.
      const out = execFileSync('where', [EXECUTABLE_NAME], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
        windowsHide: true,
      }).trim()
      const first = out.split(/\r?\n/)[0]
      return first && existsSync(first) ? first : null
    }
    const out = execFileSync('which', [EXECUTABLE_NAME], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
      windowsHide: true,
    }).trim()
    return out && existsSync(out) ? out : null
  } catch {
    return null
  }
}

/**
 * Path to a hypothetical bundled rg binary inside this package.
 * Not yet shipped — returns null until we bundle a binary.
 */
const getBundledRgPath = (): string | null => {
  // Package layout: src/im/tools/search/rg-resolver.ts → ../../../../bin/rg
  // (package root / bin / rg)
  const here = typeof __dirname !== 'undefined'
    ? __dirname
    : dirname(fileURLToPath(import.meta.url))
  const candidate = join(here, '..', '..', '..', '..', 'bin', EXECUTABLE_NAME)
  return existsSync(candidate) ? candidate : null
}

/**
 * Resolve the rg binary.
 *
 * @throws RgNotFoundError if rg cannot be found anywhere.
 */
export const resolveRg = async (): Promise<RgResolution> => {
  // 1. System PATH
  const sysPath = findOnSystemPath()
  if (sysPath) return { path: sysPath, source: 'system-path' }

  // 2. Bundled (future)
  const bundled = getBundledRgPath()
  if (bundled) return { path: bundled, source: 'bundled' }

  // 3. Download (future — not yet implemented)
  // TODO: implement auto-download from GitHub releases to <pkg>/bin/rg.
  // For now, downloading is not supported; we throw with instructions.

  throw new RgNotFoundError(RG_INSTALL_INSTRUCTIONS)
}
