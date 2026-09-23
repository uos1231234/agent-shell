// rg-resolver.test.ts
//
// Tests for the ripgrep binary resolver. The resolver finds rg on the
// system PATH or throws RgNotFoundError with install instructions.
//
// These tests run against the real system: if rg IS on PATH, we verify
// the resolver returns a usable resolution; if rg is NOT on PATH, we
// verify the error message contains install instructions.

import { describe, it, expect } from 'vitest'
import {
  resolveRg,
  RgNotFoundError,
  RG_INSTALL_INSTRUCTIONS,
} from '../../../../src/im/tools/search/rg-resolver.js'

describe('resolveRg', () => {
  it('RG_INSTALL_INSTRUCTIONS is a non-empty string with install hints', () => {
    expect(typeof RG_INSTALL_INSTRUCTIONS).toBe('string')
    expect(RG_INSTALL_INSTRUCTIONS.length).toBeGreaterThan(50)
    // Should mention at least one package manager.
    expect(RG_INSTALL_INSTRUCTIONS.toLowerCase()).toContain('install')
  })

  it('resolves to a system-path source when rg is on PATH', async () => {
    try {
      const res = await resolveRg()
      // rg is available — verify the resolution shape.
      expect(res.path).toBeTruthy()
      expect(typeof res.path).toBe('string')
      expect(res.source).toBe('system-path')
    } catch (e) {
      // rg is NOT on this system — that's a valid environment too.
      // Verify the error is RgNotFoundError with install instructions.
      expect(e).toBeInstanceOf(RgNotFoundError)
      expect((e as Error).message).toContain('ripgrep')
    }
  })

  it('throws RgNotFoundError (not a generic Error) when rg is missing', async () => {
    // This test only runs meaningfully when rg is absent. When rg IS
    // present, resolveRg succeeds and we skip the assertion.
    try {
      await resolveRg()
      // rg is present — nothing to assert here.
    } catch (e) {
      expect(e).toBeInstanceOf(RgNotFoundError)
      expect(e).toBeInstanceOf(Error)
      const msg = (e as Error).message
      // The error must contain actionable install instructions.
      expect(msg).toContain('ripgrep')
      expect(msg).toContain('PATH')
    }
  })

  it('RgNotFoundError has the correct name', () => {
    const err = new RgNotFoundError('test')
    expect(err.name).toBe('RgNotFoundError')
    expect(err.message).toBe('test')
    expect(err instanceof Error).toBe(true)
  })
})
