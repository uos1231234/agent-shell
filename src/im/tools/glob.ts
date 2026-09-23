// glob.ts
//
// Minimal glob matcher that supports the patterns used by the `find` tool.
// Grammar:
//   '*'   matches zero or more chars within a single path segment (no '/')
//   '**'  matches zero or more path segments (including '/')
//   '?'   matches exactly one char within a single path segment
//   other characters match literally
//
// This is a deliberately small subset. It does not support brace expansion
// `{a,b}`, character classes `[...]`, extglob `+(...)`, or negation `!`.
// That's enough for the patterns the LLM is likely to use with `find`.

const escapeRegex = (s: string): string => s.replace(/[.+^${}()|[\]\\]/g, '\\$&')

const splitSegments = (pattern: string): string[] => {
  let p = pattern
  if (p.endsWith('/')) p += '**'
  return p.split('/')
}

const segmentToRegex = (segment: string): string => {
  let out = ''
  for (let i = 0; i < segment.length; i += 1) {
    const c = segment[i]!
    if (c === '*') {
      if (segment[i + 1] === '*') {
        out += '.*'
        i += 1
      } else {
        out += '[^/]*'
      }
    } else if (c === '?') {
      out += '[^/]'
    } else {
      out += escapeRegex(c)
    }
  }
  return out
}

// A `**` segment is greedy: it should match zero or more *whole* path
// segments. The trick is to position the literal `/` separator so that
// every path-segment boundary is owned by exactly one token, never two.
//
// Position-by-position (body of the `**` segment alone; the surrounding
// `/` separators are added by `globToRegex`):
//   start:  `**/...` -> `(?:.*/)?`   (zero or more whole segments, then
//                                   a `/` that is shared with the next
//                                   segment; zero match is empty, any
//                                   non-zero match ends in `/`)
//   middle: `a/**/b` -> `(?:/.*)?/`  (a/, then zero or more /segments,
//                                   then /; zero match is just the
//                                   single `/` separating a from b)
//   end:    `.../**` -> `(?:/.*)?`   (.../ then zero or more segments;
//                                   zero match is empty, any non-zero
//                                   match begins with `/` which is the
//                                   separator inherited from the
//                                   previous segment)
const doubleStarAt = (segments: string[], i: number): string => {
  const isStart = i === 0
  const isEnd = i === segments.length - 1
  if (isStart && isEnd) return '.*'
  if (isStart) return '(?:.*/)?'
  if (isEnd) return '(?:/.*)?'
  return '(?:/.*)?/'
}

const globToRegex = (pattern: string): RegExp => {
  const segments = splitSegments(pattern)
  const parts: string[] = []
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i]!
    if (seg === '**') {
      parts.push(doubleStarAt(segments, i))
    } else {
      parts.push(segmentToRegex(seg))
    }
    // A literal `/` separator is added only between two *non-`***`
    // segments. When either side is `**`, the body of the `**` segment
    // already encodes the separator on its end, so adding another `/`
    // would produce a stray `//` (and break the zero-segment case).
    if (i < segments.length - 1 && seg !== '**' && segments[i + 1] !== '**') {
      parts.push('/')
    }
  }
  return new RegExp('^' + parts.join('') + '$')
}

export const matchGlob = (pattern: string, path: string): boolean => {
  if (pattern === '' && path === '') return true
  if (pattern === path) return true
  return globToRegex(pattern).test(path)
}
