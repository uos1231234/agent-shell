// v0.11: SubAgentRegistry — in-memory config store + disk loader.
//
// Holds the declarative configs for user-defined / agent-created sub-agents,
// plus the shared Databus instance that all sub-agents project their tool
// turns into. Disk is the source of truth; memory is the runtime cache.
//
// Disk layout: ~/.databus/agents/<name>.json

import { mkdir, readdir, readFile, writeFile, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { Databus } from '../databus.js'
import type { ToolRegistry } from '../../shell/registry.js'
import { validateSubAgentConfig, type SubAgentConfig } from './config.js'
import {
  DEFAULT_SUB_AGENT_TOOL_POLICY,
  type SubAgentToolPolicy,
} from './policy.js'
import { AgentTree } from './tree.js'

export const defaultAgentsDir = (): string =>
  join(homedir(), '.databus', 'agents')

export class SubAgentRegistry {
  // All sub-agents (user-defined or agent-created) share this Databus so they
  // can read each other's tool events via databus_query / databus_subscribe.
  /** @deprecated use agentTree family buses; kept for backward compat */
  readonly sharedDatabus = new Databus()
  // v0.12: tree-structured hierarchy. Every registry always has a tree, even
  // when callers do not opt in — they get a default rootless AgentTree. The
  // tree is the single source of truth for parent/child/sibling identity;
  // sharedDatabus above is kept only for the v0.11 → v0.12 migration window.
  readonly agentTree: AgentTree
  /** v0.17: session UUID this registry's tree belongs to. Read by run-subagent
   * to inherit the tree-level session for sub-agent ToolContexts. */
  readonly sessionId: string | undefined
  private readonly configs = new Map<string, SubAgentConfig>()
  // v0.11.1 P2.8: optional ToolRegistry reference for re-validation on
  // register(). When present, register() runs validateSubAgentConfig before
  // storing. When absent, register() trusts the caller (backward compat for
  // tests that construct a registry without a ToolRegistry).
  private readonly registry: ToolRegistry | undefined
  // v0.11.3 P0-2: policy injected at registry creation; flows to all config
  // validation paths (register + loadFromDisk). Single owner of policy —
  // callers decide the policy once at construction time. Defaults to
  // DEFAULT_SUB_AGENT_TOOL_POLICY so omitting it preserves v0.11.2 behavior.
  private readonly toolPolicy: SubAgentToolPolicy

  constructor(opts?: {
    registry?: ToolRegistry
    toolPolicy?: SubAgentToolPolicy
    agentTree?: AgentTree
    sessionId?: string
  }) {
    this.registry = opts?.registry
    this.toolPolicy = opts?.toolPolicy ?? DEFAULT_SUB_AGENT_TOOL_POLICY
    this.sessionId = opts?.sessionId
    // agentTree must always be non-undefined (v0.12 §5.3): callers that do not
    // opt in get a default AgentTree so downstream code can rely on the field.
    // v0.17: thread sessionId into the tree so the whole hierarchy shares it.
    this.agentTree = opts?.agentTree
      ?? new AgentTree(opts?.sessionId !== undefined ? { sessionId: opts.sessionId } : {})
  }

  async register(cfg: SubAgentConfig, diskDir?: string): Promise<void> {
    // P2.8: re-validate on register so library-level callers (not just
    // define_subagent) get the same safety checks.
    // v0.39: the policy governing toolRefs is the config's OWN declaration
    // (cfg.toolPolicy) when present; otherwise the constructor policy
    // (this.toolPolicy) applies — the SAME fallback loadFromDisk uses. This
    // closes the v0.39 gap where a bare register() silently fell through to
    // validateSubAgentConfig's permissive bare-call path, bypassing the
    // environment policy the registry was constructed with (nesting toggle).
    const validated = this.registry
      ? validateSubAgentConfig(cfg, this.registry, { toolPolicy: this.toolPolicy })
      : cfg
    this.configs.set(validated.name, validated)
    if (diskDir) {
      // v0.11.2 S3: await the disk write so callers can observe failures.
      // No auto-rollback — the caller decides what to do on rejection.
      await this.writeToDisk(validated, diskDir)
    }
  }

  get(name: string): SubAgentConfig | undefined {
    return this.configs.get(name)
  }

  list(): string[] {
    return [...this.configs.keys()].sort()
  }

  // Load all *.json files from `dir` into memory. Returns the number of valid
  // configs loaded. Files that fail validation are skipped with a console.warn.
  async loadFromDisk(dir: string, registry: ToolRegistry): Promise<number> {
    let loaded = 0
    try {
      const entries = await readdir(dir, { withFileTypes: true })
      const files = entries
        .filter((e) => e.isFile() && e.name.endsWith('.json'))
        .map((e) => e.name)
        .sort()

      for (const file of files) {
        const path = join(dir, file)
        try {
          const raw = await readFile(path, 'utf8')
          const parsed = JSON.parse(raw) as unknown
          const cfg = validateSubAgentConfig(parsed, registry, { toolPolicy: this.toolPolicy })
          this.configs.set(cfg.name, cfg)
          loaded += 1
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          console.warn(`Skipped invalid sub-agent config ${path}: ${msg}`)
        }
      }
    } catch (e) {
      // Directory may not exist yet — that's fine, just nothing to load.
      if ((e as { code?: string }).code !== 'ENOENT') {
        const msg = e instanceof Error ? e.message : String(e)
        console.warn(`Failed to load sub-agent configs from ${dir}: ${msg}`)
      }
    }
    return loaded
  }

  private async writeToDisk(cfg: SubAgentConfig, dir: string): Promise<void> {
    const path = join(dir, `${cfg.name}.json`)
    await mkdir(dirname(path), { recursive: true })
    // P2.7: write to a temp file first, then atomically rename. This prevents
    // partial/corrupt JSON if the process is killed mid-write.
    const tmp = `${path}.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const payload: Record<string, unknown> = {
      name: cfg.name,
      systemPrompt: cfg.systemPrompt,
      toolRefs: [...cfg.toolRefs],
    }
    if (cfg.config) {
      payload.config = cfg.config
    }
    // v0.39: the declared policy is part of the identity — serialize it.
    if (cfg.toolPolicy) {
      payload.toolPolicy = cfg.toolPolicy
    }
    await writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8')
    await rename(tmp, path)
  }
}
