import { readdir, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

export type WorkflowWorkspaceCheck = {
  workDir: string
  warnings: string[]
}

/**
 * The benchmark runner owns fixture materialization. The workflow only checks
 * that the workspace it received is usable and does not silently scout an
 * empty directory.
 */
export const checkWorkflowWorkspace = async (workDir: string): Promise<WorkflowWorkspaceCheck> => {
  const trimmed = workDir.trim()
  if (trimmed.length === 0) {
    throw new Error('LongHorizon baseline requires a non-empty workDir')
  }
  const resolved = resolve(trimmed)
  let info
  try {
    info = await stat(resolved)
  } catch (error) {
    throw new Error(`LongHorizon baseline workspace is not readable: ${resolved} (${error instanceof Error ? error.message : String(error)})`)
  }
  if (!info.isDirectory()) {
    throw new Error(`LongHorizon baseline workspace is not a directory: ${resolved}`)
  }
  let entries: string[]
  try {
    entries = await readdir(resolved)
  } catch (error) {
    throw new Error(`LongHorizon baseline workspace is not readable: ${resolved} (${error instanceof Error ? error.message : String(error)})`)
  }
  if (entries.length === 0) {
    throw new Error(
      `LongHorizon baseline workspace is empty: ${resolved}; `
      + 'the benchmark runner must copy/materialize the target repository before starting the workflow',
    )
  }
  const warnings = entries.some((entry) => ['package.json', 'pnpm-workspace.yaml', 'Cargo.toml', 'pyproject.toml', 'go.mod', '.git'].includes(entry))
    ? []
    : ['workspace has no common project manifest; scouts may need a task-specific entry point']
  return { workDir: resolved, warnings }
}
