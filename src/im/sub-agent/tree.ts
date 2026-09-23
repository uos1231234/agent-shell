// v0.12: Hierarchical sub-agent tree (Codex-style family isolation).
//
// AgentTree is the single source of truth for parent/sibling/grandparent
// relationships. Databus composition (ownDatabus / familyDatabus) and mailbox
// route enforcement both derive from it; no second copy of the hierarchy
// lives anywhere else.
//
// Design (ADR-016/017, v0.12 plan §3-§4):
//   - Parent creates and owns `familyDatabus`, handed to each child as that
//     child's `ownDatabus`. Sibling sharing is therefore a mechanical
//     consequence of tree construction, not a runtime merge rule.
//   - A node's parent is immutable once created.
//   - Communication is allowed only between self, parent/child,
//     grandparent/grandchild, and siblings. Everything else (cousins,
//     uncles, nephews, great-grandparents, unrelated) is rejected.

import { randomUUID } from 'node:crypto'
import { Databus } from '../databus.js'
import type { AgentId } from '../databus.js'

export class AgentNode {
  readonly id: AgentId
  readonly parent: AgentNode | null
  readonly depth: number
  readonly ownDatabus: Databus      // this agent's projection bus
  readonly familyDatabus: Databus   // handed to children as their ownDatabus
  private readonly children = new Map<AgentId, AgentNode>()

  constructor(opts: {
    id: AgentId
    parent?: AgentNode | null
    ownDatabus?: Databus
    familyDatabus?: Databus
  }) {
    this.id = opts.id
    this.parent = opts.parent ?? null
    this.depth = this.parent === null ? 0 : this.parent.depth + 1
    this.ownDatabus = opts.ownDatabus ?? new Databus()
    this.familyDatabus = opts.familyDatabus ?? new Databus()
    // Register self in parent's children map so the parent can look us up.
    if (this.parent !== null) {
      this.parent.children.set(this.id, this)
    }
  }

  createChild(id: AgentId): AgentNode {
    // The child's ownDatabus is this node's familyDatabus (siblings share it);
    // the child gets a fresh familyDatabus for its own descendants.
    return new AgentNode({
      id,
      parent: this,
      ownDatabus: this.familyDatabus,
      familyDatabus: new Databus(),
    })
  }

  getChild(id: AgentId): AgentNode | undefined {
    return this.children.get(id)
  }

  isSibling(other: AgentNode): boolean {
    if (this === other) return false // a node is not its own sibling
    if (this.parent === null || other.parent === null) return false
    return this.parent === other.parent
  }

  isParentOf(other: AgentNode): boolean {
    return other.parent === this
  }

  isChildOf(other: AgentNode): boolean {
    return this.parent === other
  }

  isGrandchildOf(other: AgentNode): boolean {
    return this.parent !== null && this.parent.parent === other
  }

  isGrandparentOf(other: AgentNode): boolean {
    return other.isGrandchildOf(this)
  }

  canCommunicateWith(other: AgentNode): boolean {
    if (this === other) return true
    if (this.isParentOf(other) || this.isChildOf(other)) return true
    if (this.isGrandparentOf(other) || this.isGrandchildOf(other)) return true
    if (this.isSibling(other)) return true
    return false
  }
}

export class AgentTree {
  readonly root: AgentNode
  /** v0.17: session UUID bound to this tree. Threaded into Databus instances and
   * inherited by sub-agents so every bus + node in the hierarchy shares one id. */
  readonly sessionId: string | undefined
  private readonly nodes = new Map<AgentId, AgentNode>()

  constructor(opts: {
    rootId?: AgentId
    rootOwnDatabus?: Databus
    sessionId?: string
  }) {
    const id = opts.rootId ?? 'main'
    const ownDatabus = opts.rootOwnDatabus ?? new Databus()
    this.root = new AgentNode({ id, ownDatabus })
    this.nodes.set(this.root.id, this.root)
    this.sessionId = opts.sessionId
  }

  registerChild(parentId: AgentId, childId: AgentId): AgentNode {
    if (this.nodes.has(childId)) {
      throw new Error(`AgentTree: node "${childId}" already exists`)
    }
    const parent = this.nodes.get(parentId)
    if (parent === undefined) {
      throw new Error(`AgentTree: parent node "${parentId}" not found`)
    }
    const child = parent.createChild(childId)
    this.nodes.set(child.id, child)
    return child
  }

  get(id: AgentId): AgentNode | undefined {
    return this.nodes.get(id)
  }

  has(id: AgentId): boolean {
    return this.nodes.has(id)
  }

  canCommunicate(a: AgentId, b: AgentId): boolean {
    const nodeA = this.nodes.get(a)
    const nodeB = this.nodes.get(b)
    // Unknown = untrusted = cannot communicate. Fail closed.
    if (nodeA === undefined || nodeB === undefined) return false
    return nodeA.canCommunicateWith(nodeB)
  }

  // Rebind the root node's id and/or ownDatabus. Only allowed when the tree
  // contains exactly the root node (no children registered yet). This is used
  // by createMinimalIM to align the tree root with the caller's workingAgentId
  // and optional caller-supplied databus before any sub-agents are spawned.
  //
  // Implementation note — the `as { id: AgentId }` type assertions below bypass
  // TypeScript's `readonly` compile-time guard. This is intentional and safe:
  //   - TS `readonly` produces NO runtime protection (no Object.freeze /
  //     Object.defineProperty writable:false), so the assignment works at runtime.
  //   - All relationship predicates (isSibling, isParentOf, canCommunicateWith)
  //     compare object *references*, not id strings — so mutating `id` cannot
  //     corrupt them.
  //   - The `nodes` Map key is updated synchronously (delete old → set new), so
  //     `tree.get(id)` lookups stay consistent.
  //   - The root has no parent, so no parent.children map holds a stale key.
  // Future hazard: if a secondary index keyed by `id` is ever added to AgentNode
  // or AgentTree, it MUST be updated here too. Today there is none.
  rebindRoot(opts: { rootId?: AgentId; rootOwnDatabus?: Databus; sessionId?: string }): void {
    if (this.nodes.size !== 1) {
      throw new Error('Cannot rebind root: tree already has children')
    }
    this.nodes.delete(this.root.id)
    if (opts.rootId !== undefined) {
      (this.root as { id: AgentId }).id = opts.rootId
    }
    if (opts.rootOwnDatabus !== undefined) {
      (this.root as { ownDatabus: Databus }).ownDatabus = opts.rootOwnDatabus
    }
    // v0.17: rebind sessionId alongside rootId (both are "tree identity" set at
    // createMinimalIM time). Uses the same type-assertion pattern as id/ownDatabus
    // above — readonly is compile-time only, safe to mutate on the sole root node.
    if (opts.sessionId !== undefined) {
      (this as { sessionId: string | undefined }).sessionId = opts.sessionId
    }
    this.nodes.set(this.root.id, this.root)
  }
}

// Mint a globally-unique instance id per run_subagent call. UUID (node:crypto)
// avoids leaking call order (no serial counter) and needs no coordination. The
// templateName prefix keeps ids human-readable (e.g. "reviewer-a1b2c3d4-...").
//
// The `_parent` parameter is retained for API compatibility with the v0.12 plan
// signature (plan §5.3) but currently unused — UUID already guarantees global
// uniqueness without parent context. The underscore prefix marks the intentional
// unused param. If a future design wants parent-scoped ids (e.g. for namespaced
// mailbox routing), `_parent` is the extension point.
export const generateInstanceId = (templateName: string, _parent: AgentNode): string => {
  return `${templateName}-${randomUUID()}`
}
