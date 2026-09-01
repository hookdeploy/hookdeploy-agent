export const ENROLL_CODE_LENGTH = 8
export const ENROLL_CODE_GROUP = 4
export const ENROLL_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

export function normalizeEnrollCode(raw: string): string {
  return raw
    .replace(/[-\s]/g, "")
    .toUpperCase()
    .split("")
    .filter((ch) => ENROLL_CODE_ALPHABET.includes(ch))
    .join("")
    .slice(0, ENROLL_CODE_LENGTH)
}

export function splitEnrollCode(raw: string): string[] {
  const compact = normalizeEnrollCode(raw)
  return Array.from({ length: ENROLL_CODE_LENGTH }, (_, i) => compact[i] ?? "")
}

export function joinEnrollCode(boxes: readonly string[]): string {
  return normalizeEnrollCode(boxes.join(""))
}

export function enrollCodeComplete(boxes: readonly string[]): boolean {
  return joinEnrollCode(boxes).length === ENROLL_CODE_LENGTH
}

export function applyOtpInput(
  boxes: readonly string[],
  index: number,
  typed: string,
): { boxes: string[]; focus: number } {
  const chars = normalizeEnrollCode(typed)
  if (!chars) {
    const next = boxes.slice()
    next[index] = ""
    return { boxes: next, focus: index }
  }
  const next = boxes.slice()
  let cursor = index
  for (const ch of chars) {
    if (cursor >= ENROLL_CODE_LENGTH) break
    next[cursor] = ch
    cursor += 1
  }
  return { boxes: next, focus: Math.min(cursor, ENROLL_CODE_LENGTH - 1) }
}

export function applyOtpBackspace(
  boxes: readonly string[],
  index: number,
): { boxes: string[]; focus: number } {
  const next = boxes.slice()
  if (next[index]) {
    next[index] = ""
    return { boxes: next, focus: index }
  }
  const prev = Math.max(0, index - 1)
  next[prev] = ""
  return { boxes: next, focus: prev }
}
