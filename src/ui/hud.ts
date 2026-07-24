/**
 * Driving HUD: speed, gear and a suspension read-out.
 *
 * The suspension bars are a development aid as much as a display — they make
 * it obvious at a glance whether each corner is loading independently, which
 * is exactly the behaviour the physics is meant to produce.
 */

export interface HudHandle {
  element: HTMLElement
  update(state: HudState): void
  setDebugVisible(visible: boolean): void
}

export interface HudState {
  speedKmh: number
  /** Per-wheel suspension compression, -1..1. */
  compression: number[]
  /** Per-wheel mud packing, 0..1. */
  dirt: number[]
  grounded: boolean[]
  fps: number
}

export function createHud(parent: HTMLElement): HudHandle {
  const root = document.createElement('div')
  root.className = 'hud'
  root.innerHTML = `
    <div class="speedo">
      <div class="speedo-value" id="speed-value">0</div>
      <div class="speedo-unit">KM/H</div>
    </div>
    <div class="suspension" id="suspension">
      ${['أمامي يسار', 'أمامي يمين', 'خلفي يسار', 'خلفي يمين']
        .map(
          (label, i) => `
        <div class="susp-row">
          <span class="susp-label">${label}</span>
          <span class="susp-track"><i class="susp-fill" id="susp-${i}"></i></span>
          <span class="susp-dirt" id="dirt-${i}"></span>
        </div>`,
        )
        .join('')}
      <div class="susp-fps" id="fps"></div>
    </div>
  `
  parent.appendChild(root)

  const speedValue = root.querySelector<HTMLElement>('#speed-value')!
  const suspension = root.querySelector<HTMLElement>('#suspension')!
  const fpsLabel = root.querySelector<HTMLElement>('#fps')!
  const fills = [0, 1, 2, 3].map((i) => root.querySelector<HTMLElement>(`#susp-${i}`)!)
  const dirts = [0, 1, 2, 3].map((i) => root.querySelector<HTMLElement>(`#dirt-${i}`)!)

  let lastSpeed = -1

  return {
    element: root,

    update(state: HudState): void {
      const speed = Math.round(state.speedKmh)
      // Writing to the DOM every frame for an unchanged integer is wasted work.
      if (speed !== lastSpeed) {
        speedValue.textContent = String(speed)
        lastSpeed = speed
      }

      for (let i = 0; i < fills.length; i++) {
        const compression = state.compression[i] ?? 0
        const fill = fills[i]!
        fill.style.width = `${Math.round(Math.abs(compression) * 100)}%`
        fill.classList.toggle('airborne', !(state.grounded[i] ?? false))
        dirts[i]!.style.opacity = String(0.15 + (state.dirt[i] ?? 0) * 0.85)
      }

      fpsLabel.textContent = `${Math.round(state.fps)} fps`
    },

    setDebugVisible(visible: boolean): void {
      suspension.style.display = visible ? '' : 'none'
    },
  }
}
