/**
 * The Butler's agent names: `butler`, and `sanctuary` from before the rename (M2). Every check that picks Butler behaviour
 * asks this, so an install runs the same whichever name its bundle has.
 */
export const BUTLER_AGENT_NAMES = ["butler", "sanctuary"] as const

/** One of the Butler's names. Saved state written before the rename says `sanctuary`; readers accept either. */
export type ButlerAgentName = typeof BUTLER_AGENT_NAMES[number]

/** Whether this agent (or a saved record's `agent` field) is the Butler, under its name or its name from before the rename. */
export function isButlerAgent(agentName: unknown): agentName is ButlerAgentName {
  return typeof agentName === "string" && (BUTLER_AGENT_NAMES as readonly string[]).includes(agentName)
}

/** The Butler's own paths and names inside its container, all derived from the name its bundle has. */
export interface ButlerContainerPaths {
  agentRoot: string
  /** Where the host's operator trust folder is mounted read-only; operator-trust.ts reads `/etc/ouro/trust/<bundle name>`. */
  trustRoot: string
  crontabPath: string
  habitNamespace: string
  healthJobId: string
  healthTaskPath: string
  healthCommand: string
  healthCronMarker: string
}

export function butlerContainerPaths(name: ButlerAgentName): ButlerContainerPaths {
  const agentRoot = `/home/ouro/AgentBundles/${name}.ouro`
  const habitNamespace = `habit:${name}`
  const healthJobId = `${name}:sanctuary-health`
  return {
    agentRoot,
    trustRoot: `/etc/ouro/trust/${name}`,
    crontabPath: `/home/ouro/.ouro-cli/scheduler/${name}.crontab`,
    habitNamespace,
    healthJobId,
    healthTaskPath: `${agentRoot}/habits/sanctuary-health.md`,
    healthCommand: `/usr/local/bin/node /opt/ouro/dist/heart/daemon/ouro-entry.js poke ${name} --habit sanctuary-health --trigger cron`,
    healthCronMarker: `# ouro:${habitNamespace}:${healthJobId}`,
  }
}

/**
 * The Butler an image runs, from its ENTRYPOINT (`docker image inspect --format '{{json .Config.Entrypoint}}'`): the argument
 * after `--package-managed-agent` when it is a Butler name. Anything else, including an image with no package activation,
 * means `sanctuary`, the name every image had before the rename. The host mounts the bundle and trust where this name says.
 */
export function butlerNameFromEntrypoint(entrypoint: unknown): ButlerAgentName {
  if (!Array.isArray(entrypoint)) return "sanctuary"
  const flag = entrypoint.indexOf("--package-managed-agent")
  const name: unknown = flag >= 0 ? entrypoint[flag + 1] : undefined
  return isButlerAgent(name) ? name : "sanctuary"
}

/** The one Butler among the agents this daemon manages, or null when there is none or more than one. */
export function managedButlerAgent(managedAgents: readonly string[]): ButlerAgentName | null {
  const butlers = managedAgents.filter(isButlerAgent)
  return butlers.length === 1 ? butlers[0]! : null
}

/** The Butler named by the one bundle under `bundlesRoot`; null with both bundles there, or neither. */
export function butlerOnDisk(bundlesRoot: string, exists: (bundlePath: string) => boolean): ButlerAgentName | null {
  const present = BUTLER_AGENT_NAMES.filter((name) => exists(`${bundlesRoot}/${name}.ouro`))
  return present.length === 1 ? present[0]! : null
}
