/**
 * 9-layer fallback matching engine for Helix
 */

export type Replacer = (content: string, find: string) => Generator<string, void, unknown>

const SINGLE_CANDIDATE_SIMILARITY_THRESHOLD = 0.65
const MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD = 0.65

function levenshtein(a: string, b: string): number {
  if (a === '' || b === '') return Math.max(a.length, b.length)
  const matrix = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  )
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost)
    }
  }
  return matrix[a.length][b.length]
}

/** Layer 1: Exact string match */
export const SimpleReplacer: Replacer = function* (_content, find) {
  yield find
}

/** Layer 2: Trimmed lines match */
export const LineTrimmedReplacer: Replacer = function* (content, find) {
  const originalLines = content.split('\n')
  const searchLines = find.split('\n')
  if (searchLines[searchLines.length - 1] === '') searchLines.pop()

  for (let i = 0; i <= originalLines.length - searchLines.length; i++) {
    let matches = true
    for (let j = 0; j < searchLines.length; j++) {
      if (originalLines[i + j].trim() !== searchLines[j].trim()) { matches = false; break }
    }
    if (matches) {
      let start = 0
      for (let k = 0; k < i; k++) start += originalLines[k].length + 1
      let end = start
      for (let k = 0; k < searchLines.length; k++) {
        end += originalLines[i + k].length
        if (k < searchLines.length - 1) end += 1
      }
      yield content.substring(start, end)
    }
  }
}

/** Layer 3: Block anchor + Levenshtein similarity matching */
export const BlockAnchorReplacer: Replacer = function* (content, find) {
  const originalLines = content.split('\n')
  const searchLines = find.split('\n')
  if (searchLines.length < 3) return
  if (searchLines[searchLines.length - 1] === '') searchLines.pop()

  const firstLineSearch = searchLines[0].trim()
  const lastLineSearch = searchLines[searchLines.length - 1].trim()
  const searchBlockSize = searchLines.length
  const maxLineDelta = Math.max(1, Math.floor(searchBlockSize * 0.25))

  const candidates: Array<{ startLine: number; endLine: number }> = []
  for (let i = 0; i < originalLines.length; i++) {
    if (originalLines[i].trim() !== firstLineSearch) continue
    for (let j = i + 2; j < originalLines.length; j++) {
      if (originalLines[j].trim() === lastLineSearch) {
        const actualBlockSize = j - i + 1
        if (Math.abs(actualBlockSize - searchBlockSize) <= maxLineDelta) {
          candidates.push({ startLine: i, endLine: j })
        }
        break
      }
    }
  }

  if (candidates.length === 0) return

  if (candidates.length === 1) {
    const { startLine, endLine } = candidates[0]
    const actualBlockSize = endLine - startLine + 1
    let similarity = 0
    const linesToCheck = Math.min(searchBlockSize - 2, actualBlockSize - 2)
    if (linesToCheck > 0) {
      for (let j = 1; j < searchBlockSize - 1 && j < actualBlockSize - 1; j++) {
        const o = originalLines[startLine + j].trim()
        const s = searchLines[j].trim()
        const maxLen = Math.max(o.length, s.length)
        if (maxLen === 0) continue
        similarity += (1 - levenshtein(o, s) / maxLen) / linesToCheck
        if (similarity >= SINGLE_CANDIDATE_SIMILARITY_THRESHOLD) break
      }
    } else {
      similarity = 1.0
    }
    if (similarity >= SINGLE_CANDIDATE_SIMILARITY_THRESHOLD) {
      let start = 0
      for (let k = 0; k < startLine; k++) start += originalLines[k].length + 1
      let end = start
      for (let k = startLine; k <= endLine; k++) {
        end += originalLines[k].length
        if (k < endLine) end += 1
      }
      yield content.substring(start, end)
    }
    return
  }

  let bestMatch: { startLine: number; endLine: number } | null = null
  let maxSimilarity = -1
  for (const candidate of candidates) {
    const { startLine, endLine } = candidate
    const actualBlockSize = endLine - startLine + 1
    let similarity = 0
    const linesToCheck = Math.min(searchBlockSize - 2, actualBlockSize - 2)
    if (linesToCheck > 0) {
      for (let j = 1; j < searchBlockSize - 1 && j < actualBlockSize - 1; j++) {
        const o = originalLines[startLine + j].trim()
        const s = searchLines[j].trim()
        const maxLen = Math.max(o.length, s.length)
        if (maxLen === 0) continue
        similarity += 1 - levenshtein(o, s) / maxLen
      }
      similarity /= linesToCheck
    } else {
      similarity = 1.0
    }
    if (similarity > maxSimilarity) { maxSimilarity = similarity; bestMatch = candidate }
  }
  if (maxSimilarity >= MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD && bestMatch) {
    const { startLine, endLine } = bestMatch
    let start = 0
    for (let k = 0; k < startLine; k++) start += originalLines[k].length + 1
    let end = start
    for (let k = startLine; k <= endLine; k++) {
      end += originalLines[k].length
      if (k < endLine) end += 1
    }
    yield content.substring(start, end)
  }
}

/** Layer 4: Whitespace-normalized matching */
export const WhitespaceNormalizedReplacer: Replacer = function* (content, find) {
  const normalizeWs = (text: string) => text.replace(/\s+/g, ' ').trim()
  const normalizedFind = normalizeWs(find)
  const lines = content.split('\n')

  for (let i = 0; i < lines.length; i++) {
    if (normalizeWs(lines[i]) === normalizedFind) {
      yield lines[i]
    } else {
      const normalizedLine = normalizeWs(lines[i])
      if (normalizedLine.includes(normalizedFind)) {
        const words = find.trim().split(/\s+/)
        if (words.length > 0) {
          const pattern = words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+')
          try { const m = lines[i].match(new RegExp(pattern)); if (m) yield m[0] } catch { }
        }
      }
    }
  }

  const findLines = find.split('\n')
  if (findLines.length > 1) {
    for (let i = 0; i <= lines.length - findLines.length; i++) {
      const block = lines.slice(i, i + findLines.length).join('\n')
      if (normalizeWs(block) === normalizedFind) yield block
    }
  }
}

/** Layer 5: Indentation-flexible matching */
export const IndentationFlexibleReplacer: Replacer = function* (content, find) {
  const removeIndent = (text: string) => {
    const lines = text.split('\n')
    const nonEmpty = lines.filter(l => l.trim().length > 0)
    if (nonEmpty.length === 0) return text
    const minIndent = Math.min(...nonEmpty.map(l => { const m = l.match(/^(\s*)/); return m ? m[1].length : 0 }))
    return lines.map(l => l.trim().length === 0 ? l : l.slice(minIndent)).join('\n')
  }
  const normalizedFind = removeIndent(find)
  const contentLines = content.split('\n')
  const findLines = find.split('\n')
  for (let i = 0; i <= contentLines.length - findLines.length; i++) {
    const block = contentLines.slice(i, i + findLines.length).join('\n')
    if (removeIndent(block) === normalizedFind) yield block
  }
}

/** Layer 6: Escape-normalized matching */
export const EscapeNormalizedReplacer: Replacer = function* (content, find) {
  const unescape = (str: string) =>
    str.replace(/\\(n|t|r|'|"|`|\\|\n|\$)/g, (_, c) => {
      switch (c) { case 'n': return '\n'; case 't': return '\t'; case 'r': return '\r'; default: return c }
    })
  const unescapedFind = unescape(find)
  if (content.includes(unescapedFind)) yield unescapedFind
  const lines = content.split('\n')
  const findLines = unescapedFind.split('\n')
  for (let i = 0; i <= lines.length - findLines.length; i++) {
    const block = lines.slice(i, i + findLines.length).join('\n')
    if (unescape(block) === unescapedFind) yield block
  }
}

/** Layer 7: Trimmed boundary matching */
export const TrimmedBoundaryReplacer: Replacer = function* (content, find) {
  const trimmedFind = find.trim()
  if (trimmedFind === find) return
  if (content.includes(trimmedFind)) yield trimmedFind
  const lines = content.split('\n')
  const findLines = find.split('\n')
  for (let i = 0; i <= lines.length - findLines.length; i++) {
    const block = lines.slice(i, i + findLines.length).join('\n')
    if (block.trim() === trimmedFind) yield block
  }
}

/** Layer 8: Context-aware anchor matching */
export const ContextAwareReplacer: Replacer = function* (content, find) {
  const findLines = find.split('\n')
  if (findLines.length < 3) return
  if (findLines[findLines.length - 1] === '') findLines.pop()
  const contentLines = content.split('\n')
  const firstLine = findLines[0].trim()
  const lastLine = findLines[findLines.length - 1].trim()
  for (let i = 0; i < contentLines.length; i++) {
    if (contentLines[i].trim() !== firstLine) continue
    for (let j = i + 2; j < contentLines.length; j++) {
      if (contentLines[j].trim() === lastLine) {
        const blockLines = contentLines.slice(i, j + 1)
        if (blockLines.length === findLines.length) {
          let matching = 0, total = 0
          for (let k = 1; k < blockLines.length - 1; k++) {
            const b = blockLines[k].trim(), f = findLines[k].trim()
            if (b.length > 0 || f.length > 0) { total++; if (b === f) matching++ }
          }
          if (total === 0 || matching / total >= 0.5) { yield blockLines.join('\n'); break }
        }
        break
      }
    }
  }
}

/** Layer 9: Multiple occurrence matching */
export const MultiOccurrenceReplacer: Replacer = function* (content, find) {
  let startIndex = 0
  while (true) {
    const index = content.indexOf(find, startIndex)
    if (index === -1) break
    yield find
    startIndex = index + find.length
  }
}

export const ALL_REPLACERS: Replacer[] = [
  SimpleReplacer,
  LineTrimmedReplacer,
  BlockAnchorReplacer,
  WhitespaceNormalizedReplacer,
  IndentationFlexibleReplacer,
  EscapeNormalizedReplacer,
  TrimmedBoundaryReplacer,
  ContextAwareReplacer,
  MultiOccurrenceReplacer,
]

function isDisproportionateMatch(search: string, oldString: string): boolean {
  const oldLines = oldString.split('\n').length
  const searchLines = search.split('\n').length
  if (searchLines >= Math.max(oldLines + 3, oldLines * 2)) return true
  if (oldLines === 1) return false
  return search.trim().length > Math.max(oldString.trim().length + 500, oldString.trim().length * 4)
}

export function replace(content: string, oldString: string, newString: string, replaceAll = false): string {
  if (oldString === newString) throw new Error('oldString and newString are identical')
  if (oldString === '') throw new Error('oldString cannot be empty')

  let notFound = true

  for (const replacer of ALL_REPLACERS) {
    for (const search of replacer(content, oldString)) {
      const index = content.indexOf(search)
      if (index === -1) continue
      notFound = false
      if (isDisproportionateMatch(search, oldString)) {
        throw new Error(
          'Refusing replacement because the matched span is much larger than oldString. ' +
          'Re-read the file and provide the full exact oldString for the intended replacement.',
        )
      }
      if (replaceAll) return content.replaceAll(search, newString)
      const lastIndex = content.lastIndexOf(search)
      if (index !== lastIndex) continue
      return content.substring(0, index) + newString + content.substring(index + search.length)
    }
  }

  if (notFound) {
    throw new Error(
      'Could not find oldString in the file. It must match exactly, including whitespace, indentation, and line endings.',
    )
  }
  throw new Error('Found multiple matches for oldString. Provide more surrounding context to make the match unique.')
}

export function normalizeLineEndings(text: string): string {
  return text.replaceAll('\r\n', '\n')
}

export function detectLineEnding(text: string): '\n' | '\r\n' {
  return text.includes('\r\n') ? '\r\n' : '\n'
}

export function convertToLineEnding(text: string, ending: '\n' | '\r\n'): string {
  return ending === '\n' ? text : text.replaceAll('\n', '\r\n')
}
