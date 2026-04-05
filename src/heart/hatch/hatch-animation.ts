import { emitNervesEvent } from "../../nerves/runtime"

const EGG = "\uD83E\uDD5A"
const SNAKE = "\uD83D\uDC0D"
const DOTS = " . . . "

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Play the hatch animation: egg -> dots -> snake + name.
 * The writer function receives each chunk. Default writer is process.stderr.write.
 */
export async function playHatchAnimation(
  hatchlingName: string,
  writer?: (text: string) => void,
): Promise<void> {
  emitNervesEvent({
    component: "daemon",
    event: "daemon.hatch_animation_start",
    message: "playing hatch animation",
    meta: { hatchlingName },
  })

  const write = writer ?? ((text: string) => process.stderr.write(text))

  // Total animation time randomized between 3–5 seconds
  const totalMs = 3000 + Math.floor(Math.random() * 2000)
  const eggPhase = Math.floor(totalMs * 0.4)
  const dotsPhase = Math.floor(totalMs * 0.4)
  const revealPause = totalMs - eggPhase - dotsPhase

  write(`\n  ${EGG}`)
  await wait(eggPhase)
  write(DOTS)
  await wait(dotsPhase)
  write(`${SNAKE} \x1b[1m${hatchlingName}\x1b[0m`)
  await wait(revealPause)
  write("\n\n")
}
