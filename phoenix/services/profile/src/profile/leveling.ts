/**
 * XP → level curve. Cumulative XP to *reach* level N is 100 * (N-1)^2, so each
 * level costs a bit more than the last. Level 1 is the floor.
 */
export function xpForLevel(level: number): number {
  const n = Math.max(1, level) - 1
  return 100 * n * n
}

export function levelForXp(xp: number): number {
  if (xp <= 0) return 1
  return Math.floor(Math.sqrt(xp / 100)) + 1
}

export interface LevelProgress {
  level: number
  xpIntoLevel: number
  xpForNext: number
  progress: number // 0..1 toward the next level
}

export function levelProgress(xp: number): LevelProgress {
  const level = levelForXp(xp)
  const base = xpForLevel(level)
  const next = xpForLevel(level + 1)
  const span = next - base
  const into = xp - base
  return { level, xpIntoLevel: into, xpForNext: next - xp, progress: span > 0 ? into / span : 0 }
}
