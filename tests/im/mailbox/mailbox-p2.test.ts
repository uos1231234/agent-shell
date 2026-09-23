// v0.11.1 P2.5/P2.6: Mailbox sender isolation and capacity limits.
//
// P2.5: reserved sender names ('databus', 'system', 'drive-coordinator')
//       are rejected — only the system can use them.
// P2.6: inbox capacity (MAX_INBOX_SIZE=1000) and body length (MAX_BODY_LENGTH=10_000).

import { describe, it, expect } from 'vitest'
import { Mailbox } from '../../../src/im/mailbox/index.js'

describe('P2.5 Mailbox reserved sender isolation', () => {
  it('rejects reserved sender "databus"', () => {
    const mb = new Mailbox()
    expect(() =>
      mb.send({ from: 'databus', to: 'agent-a', subject: 'x', body: 'y' }),
    ).toThrow('reserved for system use')
  })

  it('rejects reserved sender "system"', () => {
    const mb = new Mailbox()
    expect(() =>
      mb.send({ from: 'system', to: 'agent-a', subject: 'x', body: 'y' }),
    ).toThrow('reserved for system use')
  })

  it('rejects reserved sender "drive-coordinator"', () => {
    const mb = new Mailbox()
    expect(() =>
      mb.send({ from: 'drive-coordinator', to: 'agent-a', subject: 'x', body: 'y' }),
    ).toThrow('reserved for system use')
  })

  it('accepts normal sender names', () => {
    const mb = new Mailbox()
    const id = mb.send({ from: 'agent-a', to: 'agent-b', subject: 'x', body: 'y' })
    expect(id).toMatch(/^M-/)
  })

  it('accepts sender names that contain reserved as substring', () => {
    const mb = new Mailbox()
    expect(() =>
      mb.send({ from: 'my-system-bot', to: 'agent-a', subject: 'x', body: 'y' }),
    ).not.toThrow()
  })

  it('systemSend bypasses reserved-sender check for framework use', () => {
    const mb = new Mailbox()
    // Framework code (databus_subscribe, drive-coordinator) legitimately
    // sends from reserved identities. systemSend is the escape hatch.
    const id = mb.systemSend({ from: 'databus', to: 'agent-a', subject: 'event', body: 'payload' })
    expect(id).toMatch(/^M-/)
    const inbox = mb.readOwnInbox('agent-a', { unreadOnly: false })
    expect(inbox).toHaveLength(1)
    expect(inbox[0]!.from).toBe('databus')
  })

  it('systemSend still enforces body length and capacity', () => {
    const mb = new Mailbox()
    expect(() =>
      mb.systemSend({ from: 'databus', to: 'agent-a', subject: 'x', body: 'x'.repeat(10_001) }),
    ).toThrow('exceeds')
  })
})

describe('P2.6 Mailbox capacity limits', () => {
  it('rejects body exceeding MAX_BODY_LENGTH (10000 chars)', () => {
    const mb = new Mailbox()
    const longBody = 'x'.repeat(10_001)
    expect(() =>
      mb.send({ from: 'agent-a', to: 'agent-b', subject: 'x', body: longBody }),
    ).toThrow('exceeds')
  })

  it('accepts body of exactly MAX_BODY_LENGTH (10000 chars)', () => {
    const mb = new Mailbox()
    const exactBody = 'x'.repeat(10_000)
    const id = mb.send({ from: 'agent-a', to: 'agent-b', subject: 'x', body: exactBody })
    expect(id).toMatch(/^M-/)
  })

  it('rejects when inbox reaches MAX_INBOX_SIZE (1000 messages)', () => {
    const mb = new Mailbox()
    // Fill inbox to exactly 1000.
    for (let i = 0; i < 1000; i++) {
      mb.send({ from: 'agent-a', to: 'agent-b', subject: `s${i}`, body: 'b' })
    }
    expect(mb.inboxSize('agent-b')).toBe(1000)
    // The 1001st message should be rejected.
    expect(() =>
      mb.send({ from: 'agent-a', to: 'agent-b', subject: 'overflow', body: 'b' }),
    ).toThrow('full')
  })

  it('does not reject when inbox is at 999 (boundary -1)', () => {
    const mb = new Mailbox()
    for (let i = 0; i < 999; i++) {
      mb.send({ from: 'agent-a', to: 'agent-b', subject: `s${i}`, body: 'b' })
    }
    // The 1000th message should succeed.
    const id = mb.send({ from: 'agent-a', to: 'agent-b', subject: 'ok', body: 'b' })
    expect(id).toMatch(/^M-/)
  })

  it('capacity check is per-recipient', () => {
    const mb = new Mailbox()
    for (let i = 0; i < 1000; i++) {
      mb.send({ from: 'agent-a', to: 'agent-b', subject: `s${i}`, body: 'b' })
    }
    // agent-b is full, but agent-c is empty — should succeed.
    const id = mb.send({ from: 'agent-a', to: 'agent-c', subject: 'ok', body: 'b' })
    expect(id).toMatch(/^M-/)
  })
})
