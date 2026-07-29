import { levelForXp, levelProgress, xpForLevel } from './leveling'

describe('leveling', () => {
  it('starts everyone at level 1', () => {
    expect(levelForXp(0)).toBe(1)
    expect(levelForXp(50)).toBe(1)
  })

  it('is the inverse of the xp-for-level curve at boundaries', () => {
    for (let lvl = 1; lvl <= 30; lvl++) {
      expect(levelForXp(xpForLevel(lvl))).toBe(lvl)
    }
  })

  it('reports progress toward the next level', () => {
    const base = xpForLevel(5)
    const next = xpForLevel(6)
    const mid = Math.floor((base + next) / 2)
    const p = levelProgress(mid)
    expect(p.level).toBe(5)
    expect(p.progress).toBeGreaterThan(0.4)
    expect(p.progress).toBeLessThan(0.6)
    expect(p.xpForNext).toBe(next - mid)
  })
})
