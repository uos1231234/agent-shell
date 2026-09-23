// SSE (Server-Sent Events) parser.
// Pure data stream → iterable of events.
// Yields the raw `data:` payload; the higher-level caller interprets it as JSON / [DONE] / etc.

export type SSEEvent = {
  event?: string
  data: string
  id?: string
}

const SEP = '\n\n'
const MAX_EVENT_BYTES = 1024 * 1024

// We maintain an internal buffer to handle chunks that split lines / events.
export async function* parseSSEStream(stream: ReadableStream<Uint8Array>): AsyncIterable<SSEEvent> {
  const reader = stream.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''

  const readMore = async (): Promise<string | null> => {
    const { value, done } = await reader.read()
    if (done) return null
    return decoder.decode(value, { stream: true })
  }

  while (true) {
    // Find the next complete event (terminated by a blank line).
    let sepIndex = buffer.indexOf(SEP)
    while (sepIndex === -1) {
      const more = await readMore()
      if (more === null) {
        // Stream ended; flush whatever is left.
        if (buffer.length > 0) {
          const remaining = buffer
          buffer = ''
          for (const ev of parseEventBlock(remaining)) yield ev
        }
        return
      }
      buffer += more
      if (buffer.length > MAX_EVENT_BYTES) {
        throw new Error(`SSE event larger than ${MAX_EVENT_BYTES} bytes without terminator - malformed stream`)
      }
      sepIndex = buffer.indexOf(SEP)
    }

    const block = buffer.slice(0, sepIndex)
    buffer = buffer.slice(sepIndex + SEP.length)
    for (const ev of parseEventBlock(block)) yield ev
  }
}

// Parse a single event block (text between blank lines, no trailing \n\n).
// Returns [] for empty blocks (e.g. stray blank lines from the server).
function* parseEventBlock(block: string): Iterable<SSEEvent> {
  if (block.length === 0) return

  let eventName: string | undefined
  const dataLines: string[] = []
  let id: string | undefined

  for (const rawLine of block.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    if (line.length === 0) continue
    if (line.startsWith(':')) continue        // SSE comment

    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value: string
    if (colon === -1) {
      value = ''
    } else {
      // SSE spec: a single leading space after the colon is stripped.
      const rest = line.slice(colon + 1)
      value = rest.startsWith(' ') ? rest.slice(1) : rest
    }

    if (field === 'event') eventName = value
    else if (field === 'data') dataLines.push(value)
    else if (field === 'id') id = value
    // Other fields (retry) are ignored — out of scope.
  }

  if (dataLines.length === 0) return
  const ev: SSEEvent = { data: dataLines.join('\n') }
  if (eventName !== undefined) ev.event = eventName
  if (id !== undefined) ev.id = id
  yield ev
}
