/**
 * Procedural sound effects. Everything is synthesised at runtime with the Web
 * Audio API, so the game ships with no audio assets and no download cost — an
 * important property for an install-size-sensitive mobile build.
 */

export type SoundName =
  | 'shoot-pistol'
  | 'shoot-smg'
  | 'shoot-rifle'
  | 'shoot-shotgun'
  | 'shoot-sniper'
  | 'hit'
  | 'hurt'
  | 'reload'
  | 'pickup'
  | 'heal'
  | 'kill'
  | 'zone'
  | 'click'
  | 'death'
  | 'victory'

interface ShotProfile {
  duration: number
  startFreq: number
  endFreq: number
  noise: number
  gain: number
}

const SHOT_PROFILES: Record<string, ShotProfile> = {
  'shoot-pistol': { duration: 0.13, startFreq: 420, endFreq: 70, noise: 0.55, gain: 0.32 },
  'shoot-smg': { duration: 0.09, startFreq: 520, endFreq: 90, noise: 0.5, gain: 0.24 },
  'shoot-rifle': { duration: 0.16, startFreq: 340, endFreq: 55, noise: 0.7, gain: 0.36 },
  'shoot-shotgun': { duration: 0.28, startFreq: 240, endFreq: 40, noise: 0.9, gain: 0.44 },
  'shoot-sniper': { duration: 0.4, startFreq: 200, endFreq: 34, noise: 0.85, gain: 0.5 },
}

export class AudioEngine {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private noiseBuffer: AudioBuffer | null = null
  private enabled = true
  private lastPlayed = new Map<SoundName, number>()

  /** Must be called from a user gesture — mobile browsers block audio otherwise. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume()
      return
    }
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return
    try {
      this.ctx = new Ctor()
      this.master = this.ctx.createGain()
      this.master.gain.value = 0.85
      this.master.connect(this.ctx.destination)
      this.noiseBuffer = this.makeNoiseBuffer(this.ctx)
    } catch {
      this.ctx = null
    }
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    if (this.master) this.master.gain.value = enabled ? 0.85 : 0
  }

  get isEnabled(): boolean {
    return this.enabled
  }

  private makeNoiseBuffer(ctx: AudioContext): AudioBuffer {
    const length = Math.floor(ctx.sampleRate * 0.6)
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate)
    const data = buffer.getChannelData(0)
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1
    return buffer
  }

  /**
   * @param volume 0..1 attenuation, typically derived from distance to the listener.
   */
  play(name: SoundName, volume = 1): void {
    if (!this.enabled || volume <= 0.01) return
    if (!this.ctx || !this.master) return
    if (this.ctx.state === 'suspended') void this.ctx.resume()

    // Cheap voice limiter: identical sounds firing in the same few milliseconds
    // (a shotgun's pellets all landing, say) would otherwise clip badly.
    const now = this.ctx.currentTime
    const last = this.lastPlayed.get(name) ?? -1
    if (now - last < 0.02) return
    this.lastPlayed.set(name, now)

    const shot = SHOT_PROFILES[name]
    if (shot) {
      this.playShot(shot, volume)
      return
    }

    switch (name) {
      case 'hit':
        this.playTone(880, 620, 0.07, 0.18 * volume, 'square')
        break
      case 'hurt':
        this.playNoise(0.18, 0.3 * volume, 900, 'lowpass')
        this.playTone(180, 90, 0.2, 0.2 * volume, 'sawtooth')
        break
      case 'reload':
        this.playTone(300, 300, 0.05, 0.16 * volume, 'square')
        this.playTone(220, 420, 0.09, 0.14 * volume, 'square', 0.11)
        break
      case 'pickup':
        this.playTone(520, 780, 0.1, 0.16 * volume, 'triangle')
        break
      case 'heal':
        this.playTone(440, 660, 0.16, 0.16 * volume, 'sine')
        this.playTone(660, 880, 0.16, 0.12 * volume, 'sine', 0.12)
        break
      case 'kill':
        this.playTone(660, 990, 0.1, 0.2 * volume, 'triangle')
        this.playTone(990, 1320, 0.12, 0.16 * volume, 'triangle', 0.09)
        break
      case 'zone':
        this.playTone(150, 110, 0.5, 0.14 * volume, 'sawtooth')
        break
      case 'click':
        this.playTone(600, 600, 0.035, 0.12 * volume, 'square')
        break
      case 'death':
        this.playTone(320, 60, 0.7, 0.26 * volume, 'sawtooth')
        break
      case 'victory':
        [0, 0.13, 0.26, 0.42].forEach((delay, i) => {
          this.playTone(523 * (1 + i * 0.26), 523 * (1 + i * 0.26), 0.24, 0.2 * volume, 'triangle', delay)
        })
        break
    }
  }

  private playShot(profile: ShotProfile, volume: number): void {
    const ctx = this.ctx
    const master = this.master
    if (!ctx || !master) return
    const t0 = ctx.currentTime
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(profile.gain * volume, t0)
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + profile.duration)
    gain.connect(master)

    // Body: a fast downward sweep gives the "thump".
    const osc = ctx.createOscillator()
    osc.type = 'sawtooth'
    osc.frequency.setValueAtTime(profile.startFreq, t0)
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, profile.endFreq), t0 + profile.duration)
    osc.connect(gain)
    osc.start(t0)
    osc.stop(t0 + profile.duration)

    // Crack: filtered noise layered on top.
    if (this.noiseBuffer) {
      const src = ctx.createBufferSource()
      src.buffer = this.noiseBuffer
      const filter = ctx.createBiquadFilter()
      filter.type = 'bandpass'
      filter.frequency.setValueAtTime(1800, t0)
      filter.frequency.exponentialRampToValueAtTime(400, t0 + profile.duration)
      filter.Q.value = 0.8
      const noiseGain = ctx.createGain()
      noiseGain.gain.setValueAtTime(profile.noise * profile.gain * volume, t0)
      noiseGain.gain.exponentialRampToValueAtTime(0.0001, t0 + profile.duration)
      src.connect(filter)
      filter.connect(noiseGain)
      noiseGain.connect(master)
      src.start(t0)
      src.stop(t0 + profile.duration)
    }
  }

  private playTone(
    startFreq: number,
    endFreq: number,
    duration: number,
    gainValue: number,
    type: OscillatorType,
    delay = 0,
  ): void {
    const ctx = this.ctx
    const master = this.master
    if (!ctx || !master) return
    const t0 = ctx.currentTime + delay
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = type
    osc.frequency.setValueAtTime(startFreq, t0)
    if (endFreq !== startFreq) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), t0 + duration)
    }
    gain.gain.setValueAtTime(gainValue, t0)
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration)
    osc.connect(gain)
    gain.connect(master)
    osc.start(t0)
    osc.stop(t0 + duration)
  }

  private playNoise(duration: number, gainValue: number, cutoff: number, filterType: BiquadFilterType): void {
    const ctx = this.ctx
    const master = this.master
    if (!ctx || !master || !this.noiseBuffer) return
    const t0 = ctx.currentTime
    const src = ctx.createBufferSource()
    src.buffer = this.noiseBuffer
    const filter = ctx.createBiquadFilter()
    filter.type = filterType
    filter.frequency.value = cutoff
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(gainValue, t0)
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration)
    src.connect(filter)
    filter.connect(gain)
    gain.connect(master)
    src.start(t0)
    src.stop(t0 + duration)
  }
}

export const audio = new AudioEngine()

/** Distance attenuation used for every positional sound in the game. */
export function distanceVolume(distance: number, falloff = 55): number {
  return Math.max(0, 1 - distance / falloff) ** 1.6
}
