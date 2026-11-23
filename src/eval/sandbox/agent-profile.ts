/**
 * Which agent a sandboxed run puts in the agent container. A profile names the agent, says where its bundle comes
 * from and lists the bundle paths the turn may write; everything else in the bundle is mounted read-only.
 *
 * - The bundle sits where the agent's own runtime looks for it, `/home/ouro/AgentBundles/<agent>.ouro`, and the
 *   Telegram guest is started with `--agent <agent>`.
 * - The bundle source fills the run's bundle folder from the case's `include` paths and says what it left out (the
 *   gaps every report lists). The Butler's source projects the bundle under test over the public seed bundle; a
 *   later slice adds a source that exports a committed bundle.
 * - The writable paths are relative to the bundle, inside it, and each mounted over its read-only copy.
 *
 * `sanctuaryProfile` is the Butler's, and what every run used before profiles existed; it is still the default, so
 * the replay eval and the interviews run exactly as they did.
 */
import path from "node:path"
import { emitNervesEvent } from "../../nerves/runtime"
import { projectBundle } from "./projection"

export type BundleSource = (input: { include: string[]; out: string }) => { gaps: string[] }

export interface AgentProfile {
  /** The agent's name, as `--agent` takes it and as its bundle folder is named. */
  agent: string
  /** Fills the run's bundle folder and returns what it left out. */
  bundleSource: BundleSource
  /** Bundle-relative paths the turn and its tools may write. */
  writable: readonly string[]
}

/** Where every agent's bundles sit in the agent container. */
export const CONTAINER_BUNDLES = "/home/ouro/AgentBundles"
/** What the Butler's turn and its books CLI write. */
export const SANCTUARY_WRITABLE = ["books/work", "books/removed", "books/ledger.ndjson", "state", "friends", "arc", "desk/_record"] as const

const AGENT_NAME = /^[a-z][a-z0-9-]{0,62}$/
const WRITABLE_PATH = /^[A-Za-z0-9._-][A-Za-z0-9._/-]*$/

/** The Butler's profile: its bundle under test projected over the public seed bundle. */
export function sanctuaryProfile(input: { bundleDir: string; seedBundleDir: string }): AgentProfile {
  return {
    agent: "sanctuary",
    bundleSource: ({ include, out }) => projectBundle({ bundleDir: input.bundleDir, seedBundleDir: input.seedBundleDir, include, out }),
    writable: SANCTUARY_WRITABLE,
  }
}

/** The bundle's path in the agent container. */
export function containerBundle(profile: Pick<AgentProfile, "agent">): string {
  return `${CONTAINER_BUNDLES}/${profile.agent}.ouro`
}

/** Throws unless the agent's name is a plain name and every writable path stays inside the bundle, once. */
export function checkProfile(profile: Pick<AgentProfile, "agent" | "writable">): void {
  const problems: string[] = []
  if (!AGENT_NAME.test(profile.agent)) problems.push("the agent's name must be lowercase letters, digits and dashes")
  if (profile.writable.length === 0) problems.push("it lists no writable path")
  const seen = new Set<string>()
  for (const entry of profile.writable) {
    // Docker splits a `-v` value on `:` and its options on `,`, so a path is held to plain characters.
    if (!WRITABLE_PATH.test(entry) || entry !== path.posix.normalize(entry) || entry === "." || entry.split("/").includes("..") || entry.endsWith("/")) {
      problems.push(`writable path ${JSON.stringify(entry)} must be a plain path inside the bundle`)
    } else if (seen.has(entry)) {
      problems.push(`writable path ${entry} is listed twice`)
    }
    seen.add(entry)
  }
  if (problems.length > 0) {
    emitNervesEvent({ level: "error", component: "eval", event: "eval.sandbox_profile_refused", message: "refused an agent profile", meta: { agent: profile.agent, problems: problems.length } })
    throw new Error(`agent profile ${JSON.stringify(profile.agent)}: ${problems.join("; ")}`)
  }
}

/** The agent container's bundle mounts: the whole bundle read-only, then each writable path over it. Checks the profile first. */
export function bundleMounts(profile: Pick<AgentProfile, "agent" | "writable">, hostBundle: string): string[] {
  checkProfile(profile)
  const target = containerBundle(profile)
  return ["-v", `${hostBundle}:${target}:ro`, ...profile.writable.flatMap((entry) => ["-v", `${path.join(hostBundle, entry)}:${target}/${entry}`])]
}
