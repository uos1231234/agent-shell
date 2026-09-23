// protocol/types.test.ts — verify ContentPart types are usable and ChatMessage
// user role accepts both plain string and ContentPart[].

import { describe, it, expect } from 'vitest'
import type {
  ChatMessage,
  ContentPart,
  TextContentPart,
  ImageUrlContentPart,
} from '../../src/protocol/types.js'

describe('protocol types — multimodal content parts', () => {
  it('TextContentPart has the right shape', () => {
    const part: TextContentPart = { type: 'text', text: 'hello' }
    expect(part.type).toBe('text')
    expect(part.text).toBe('hello')
  })

  it('ImageUrlContentPart has the right shape', () => {
    const part: ImageUrlContentPart = {
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,iVBOR=' },
    }
    expect(part.type).toBe('image_url')
    expect(part.image_url.url).toMatch(/^data:image\/png/)
  })

  it('ContentPart is a union of text + image_url', () => {
    const parts: ContentPart[] = [
      { type: 'text', text: 'What is in this image?' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
    ]
    expect(parts).toHaveLength(2)
  })

  it('ChatMessage user role accepts plain string content (backward compat)', () => {
    const msg: ChatMessage = { role: 'user', content: 'hello' }
    expect(msg.content).toBe('hello')
  })

  it('ChatMessage user role accepts ContentPart[] (new multimodal)', () => {
    const msg: ChatMessage = {
      role: 'user',
      content: [
        { type: 'text', text: 'Describe this' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
      ],
    }
    expect(Array.isArray(msg.content)).toBe(true)
  })

  it('ChatMessage system role still requires string (not widened)', () => {
    const msg: ChatMessage = { role: 'system', content: 'you are helpful' }
    expect(msg.content).toBe('you are helpful')
  })

  it('ChatMessage user content (ContentPart[]) is JSON-serializable', () => {
    const msg: ChatMessage = {
      role: 'user',
      content: [
        { type: 'text', text: 'See image' },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/' } },
      ],
    }
    const json = JSON.stringify(msg)
    const parsed = JSON.parse(json)
    expect(parsed.role).toBe('user')
    expect(parsed.content[0].type).toBe('text')
    expect(parsed.content[1].image_url.url).toMatch(/^data:image\/jpeg/)
  })
})
