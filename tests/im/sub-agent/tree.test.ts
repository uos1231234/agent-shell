// v0.12: Unit tests for the hierarchical sub-agent tree.
// Covers node creation, depth, bus sharing, sibling/parent/grandparent
// relationships, communication policy, and tree-level registration/errors.

import { describe, it, expect } from 'vitest'
import { AgentNode, AgentTree, generateInstanceId } from '../../../src/im/sub-agent/tree.js'
import { Databus } from '../../../src/im/databus.js'

describe('AgentNode — root construction', () => {
  it('creates a root with default id "main"', () => {
    const tree = new AgentTree({})
    expect(tree.root.id).toBe('main')
  })

  it('creates a root with a custom id', () => {
    const tree = new AgentTree({ rootId: 'orchestrator' })
    expect(tree.root.id).toBe('orchestrator')
  })

  it('root has depth 0 and null parent', () => {
    const tree = new AgentTree({})
    expect(tree.root.depth).toBe(0)
    expect(tree.root.parent).toBeNull()
  })

  it('root creates distinct ownDatabus and familyDatabus when omitted', () => {
    const node = new AgentNode({ id: 'r' })
    expect(node.ownDatabus).toBeInstanceOf(Databus)
    expect(node.familyDatabus).toBeInstanceOf(Databus)
    expect(node.ownDatabus).not.toBe(node.familyDatabus)
  })

  it('root uses provided rootOwnDatabus', () => {
    const bus = new Databus()
    const tree = new AgentTree({ rootOwnDatabus: bus })
    expect(tree.root.ownDatabus).toBe(bus)
  })
})

describe('AgentTree.registerChild — depth and bus wiring', () => {
  it('registerChild creates a child at depth 1', () => {
    const tree = new AgentTree({})
    const child = tree.registerChild('main', 'reviewer-a')
    expect(child.depth).toBe(1)
    expect(child.parent).toBe(tree.root)
  })

  it("child's ownDatabus === parent's familyDatabus (siblings share)", () => {
    const tree = new AgentTree({})
    const child = tree.registerChild('main', 'reviewer-a')
    expect(child.ownDatabus).toBe(tree.root.familyDatabus)
  })

  it("child's familyDatabus is a new Databus distinct from own", () => {
    const tree = new AgentTree({})
    const child = tree.registerChild('main', 'reviewer-a')
    expect(child.familyDatabus).toBeInstanceOf(Databus)
    expect(child.familyDatabus).not.toBe(child.ownDatabus)
  })

  it('two siblings share the same ownDatabus', () => {
    const tree = new AgentTree({})
    const a = tree.registerChild('main', 'reviewer-a')
    const b = tree.registerChild('main', 'reviewer-b')
    expect(a.ownDatabus).toBe(b.ownDatabus)
  })

  it('grandchild is at depth 2 and its ownDatabus === child.familyDatabus', () => {
    const tree = new AgentTree({})
    const child = tree.registerChild('main', 'reviewer-a')
    const grandchild = tree.registerChild('reviewer-a', 'worker')
    expect(grandchild.depth).toBe(2)
    expect(grandchild.ownDatabus).toBe(child.familyDatabus)
    expect(grandchild.parent).toBe(child)
  })
})

describe('AgentNode — relationship predicates', () => {
  const setup = () => {
    const tree = new AgentTree({})
    const a = tree.registerChild('main', 'a')
    const b = tree.registerChild('main', 'b')
    const a1 = tree.registerChild('a', 'a1')
    const b1 = tree.registerChild('b', 'b1')
    const a1x = tree.registerChild('a1', 'a1x')
    return { tree, root: tree.root, a, b, a1, b1, a1x }
  }

  it('isSibling: true for same-parent children', () => {
    const { a, b } = setup()
    expect(a.isSibling(b)).toBe(true)
    expect(b.isSibling(a)).toBe(true)
  })

  it('isSibling: false for cousins (different parents)', () => {
    const { a1, b1 } = setup()
    expect(a1.isSibling(b1)).toBe(false)
  })

  it('isSibling: false for a node vs itself', () => {
    const { a } = setup()
    expect(a.isSibling(a)).toBe(false)
  })

  it('isParentOf / isChildOf are correct', () => {
    const { root, a } = setup()
    expect(root.isParentOf(a)).toBe(true)
    expect(a.isChildOf(root)).toBe(true)
    expect(a.isParentOf(root)).toBe(false)
    expect(root.isChildOf(a)).toBe(false)
  })

  it('isGrandparentOf / isGrandchildOf are correct', () => {
    const { root, a1 } = setup()
    expect(root.isGrandparentOf(a1)).toBe(true)
    expect(a1.isGrandchildOf(root)).toBe(true)
  })
})

describe('AgentNode.canCommunicateWith', () => {
  const setup = () => {
    const tree = new AgentTree({})
    const a = tree.registerChild('main', 'a')
    const b = tree.registerChild('main', 'b')
    const a1 = tree.registerChild('a', 'a1')
    const b1 = tree.registerChild('b', 'b1')
    const a1x = tree.registerChild('a1', 'a1x') // great-grandchild of root
    return { tree, root: tree.root, a, b, a1, b1, a1x }
  }

  it('self -> true', () => {
    const { a } = setup()
    expect(a.canCommunicateWith(a)).toBe(true)
  })

  it('parent <-> child -> true', () => {
    const { root, a } = setup()
    expect(root.canCommunicateWith(a)).toBe(true)
    expect(a.canCommunicateWith(root)).toBe(true)
  })

  it('siblings -> true', () => {
    const { a, b } = setup()
    expect(a.canCommunicateWith(b)).toBe(true)
    expect(b.canCommunicateWith(a)).toBe(true)
  })

  it('grandparent <-> grandchild -> true', () => {
    const { root, a1 } = setup()
    expect(root.canCommunicateWith(a1)).toBe(true)
    expect(a1.canCommunicateWith(root)).toBe(true)
  })

  it('cousins -> false', () => {
    const { a1, b1 } = setup()
    expect(a1.canCommunicateWith(b1)).toBe(false)
    expect(b1.canCommunicateWith(a1)).toBe(false)
  })

  it('uncle <-> nephew -> false', () => {
    const { a, b1 } = setup()
    // a is sibling of b; b1 is child of b -> a is uncle of b1
    expect(a.canCommunicateWith(b1)).toBe(false)
    expect(b1.canCommunicateWith(a)).toBe(false)
  })

  it('great-grandparent -> false', () => {
    const { root, a1x } = setup()
    expect(root.canCommunicateWith(a1x)).toBe(false)
    expect(a1x.canCommunicateWith(root)).toBe(false)
  })
})

describe('AgentTree — registry and communication', () => {
  it('get / has return registered nodes', () => {
    const tree = new AgentTree({})
    tree.registerChild('main', 'a')
    expect(tree.has('main')).toBe(true)
    expect(tree.has('a')).toBe(true)
    expect(tree.has('missing')).toBe(false)
    expect(tree.get('a')?.id).toBe('a')
    expect(tree.get('missing')).toBeUndefined()
  })

  it('canCommunicate: unknown agent -> false', () => {
    const tree = new AgentTree({})
    tree.registerChild('main', 'a')
    expect(tree.canCommunicate('main', 'ghost')).toBe(false)
    expect(tree.canCommunicate('ghost', 'main')).toBe(false)
    expect(tree.canCommunicate('ghost1', 'ghost2')).toBe(false)
  })

  it('canCommunicate: delegates correctly for registered nodes', () => {
    const tree = new AgentTree({})
    const a = tree.registerChild('main', 'a')
    const b = tree.registerChild('main', 'b')
    const a1 = tree.registerChild('a', 'a1')
    expect(tree.canCommunicate('a', 'b')).toBe(true)
    expect(tree.canCommunicate('main', 'a1')).toBe(true)
    expect(tree.canCommunicate('b', 'a1')).toBe(false) // uncle/nephew
  })

  it('registerChild: unknown parent -> throws', () => {
    const tree = new AgentTree({})
    expect(() => tree.registerChild('nope', 'c')).toThrow(
      'AgentTree: parent node "nope" not found',
    )
  })

  it('registerChild: duplicate child id -> throws', () => {
    const tree = new AgentTree({})
    tree.registerChild('main', 'a')
    expect(() => tree.registerChild('main', 'a')).toThrow(
      'AgentTree: node "a" already exists',
    )
  })

  it('duplicate id is rejected before parent lookup (so a child id colliding with root is caught)', () => {
    const tree = new AgentTree({})
    expect(() => tree.registerChild('main', 'main')).toThrow(
      'AgentTree: node "main" already exists',
    )
  })
})

describe('AgentNode.createChild — direct construction', () => {
  it('createChild wires parent.children so getChild works', () => {
    const parent = new AgentNode({ id: 'p' })
    const child = parent.createChild('c')
    expect(parent.getChild('c')).toBe(child)
    expect(parent.getChild('other')).toBeUndefined()
  })

  it('createChild sibling shares ownDatabus', () => {
    const parent = new AgentNode({ id: 'p' })
    const c1 = parent.createChild('c1')
    const c2 = parent.createChild('c2')
    expect(c1.ownDatabus).toBe(c2.ownDatabus)
    expect(c1.ownDatabus).toBe(parent.familyDatabus)
  })
})

describe('generateInstanceId', () => {
  it('includes the template name', () => {
    const tree = new AgentTree({})
    const id = generateInstanceId('reviewer', tree.root)
    expect(id.startsWith('reviewer-')).toBe(true)
  })

  it('produces unique values across multiple calls', () => {
    const tree = new AgentTree({})
    const ids = new Set<string>()
    for (let i = 0; i < 100; i += 1) {
      ids.add(generateInstanceId('reviewer', tree.root))
    }
    expect(ids.size).toBe(100)
  })
})
