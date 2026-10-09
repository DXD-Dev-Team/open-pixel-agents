import { MAX_DELTA_TIME_SEC, OFFICE_CANVAS_FLUSH_EVENT } from '../../constants.js'

export interface GameLoopCallbacks {
  update: (dt: number) => void
  render: (ctx: CanvasRenderingContext2D) => void
}

export function startGameLoop(
  canvas: HTMLCanvasElement,
  callbacks: GameLoopCallbacks,
): () => void {
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingEnabled = false

  let lastTime = 0
  let rafId = 0
  let stopped = false

  // A native test host can have its animation frames suspended when another
  // window covers it. Flush through this same live renderer before capturing
  // its existing canvas; do not construct a separate scene or canvas.
  const flush = () => {
    if (stopped) return
    const time = performance.now()
    const dt = lastTime === 0 ? 0 : Math.min(Math.max(0, (time - lastTime) / 1000), MAX_DELTA_TIME_SEC)
    lastTime = time
    callbacks.update(dt)
    ctx.imageSmoothingEnabled = false
    callbacks.render(ctx)
  }
  canvas.addEventListener(OFFICE_CANVAS_FLUSH_EVENT, flush)

  const frame = (time: number) => {
    if (stopped) return
    const dt = lastTime === 0 ? 0 : Math.min((time - lastTime) / 1000, MAX_DELTA_TIME_SEC)
    lastTime = time

    callbacks.update(dt)

    ctx.imageSmoothingEnabled = false
    callbacks.render(ctx)

    rafId = requestAnimationFrame(frame)
  }

  rafId = requestAnimationFrame(frame)

  return () => {
    stopped = true
    cancelAnimationFrame(rafId)
    canvas.removeEventListener(OFFICE_CANVAS_FLUSH_EVENT, flush)
  }
}
