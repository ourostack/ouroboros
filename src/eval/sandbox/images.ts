/**
 * Which images a sandboxed run uses: the agent's and the household's, and any other agent images by name, for a
 * guest that needs its own (an interview arm built on another harness). The household always runs from `household`.
 */
import { emitNervesEvent } from "../../nerves/runtime"

export type SandboxImages = { agent: string; household: string; named?: Readonly<Record<string, string>> }

/** `--images <agent>,<household>[,<name>=<agent image>...]`: the run's own image tags, so it never uses another checkout's. */
export function parseSandboxImages(value: string): SandboxImages {
  const usage = "--images must be <agent image>,<household image>, then any <name>=<agent image>"
  const [agent, household, ...rest] = value.split(",").map((part) => part.trim())
  if (!agent || !household) throw new Error(usage)
  if (rest.length === 0) return { agent, household }
  const named: Record<string, string> = {}
  for (const entry of rest) {
    const at = entry.indexOf("=")
    const name = entry.slice(0, at)
    const tag = entry.slice(at + 1)
    // A name is a plain word starting with a letter or digit, so `__proto__` can never set the map's prototype.
    if (at < 1 || !tag || !/^[A-Za-z0-9][\w-]*$/.test(name) || Object.hasOwn(named, name)) throw new Error(usage)
    named[name] = tag
  }
  return { agent, household, named }
}

/** The agent image for a guest: the one it names, which the run's images must give, or the default agent image. */
export function agentImageOf(images: SandboxImages, name: string | undefined): string {
  if (name === undefined) return images.agent
  const tag = images.named && Object.hasOwn(images.named, name) ? images.named[name] : undefined
  if (!tag) throw new Error(`no agent image named ${name}: the run's images name ${Object.keys(images.named ?? {}).join(", ") || "none"}`)
  emitNervesEvent({ component: "eval", event: "eval.sandbox_named_image", message: "the guest runs in its own agent image", meta: { name, image: tag } })
  return tag
}
