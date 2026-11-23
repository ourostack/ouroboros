import { execFileSync } from "node:child_process"

export interface ProcessRow {
  pid: number
  ppid: number
  pgid: number
}

/** What must be killed so nothing a worker started outlives it. */
export interface ProcessTreeTargets {
  /** Process groups led by the worker or something it started: a detached child (sync's git) and all it ran. */
  groups: number[]
  /** Processes of the tree that sit in a group led from outside it (the worker itself, in the daemon's group). */
  pids: number[]
  /** Every process of the tree and its group when the table was read, to tell later whether a pid is still ours. */
  members: ProcessRow[]
}

/** The process table, from `ps`. Empty when it cannot be read. */
export function listProcesses(): ProcessRow[] {
  let output: string
  try {
    output = execFileSync("ps", ["-A", "-o", "pid=,ppid=,pgid="], { encoding: "utf-8", timeout: 2_000, killSignal: "SIGKILL" })
  } catch {
    return []
  }
  return output.split("\n").flatMap((line) => {
    const [pid, ppid, pgid] = line.trim().split(/\s+/).map(Number)
    return Number.isInteger(pid) && Number.isInteger(ppid) && Number.isInteger(pgid) ? [{ pid: pid!, ppid: ppid!, pgid: pgid! }] : []
  })
}

/** Sends a signal to a process, or to a process group when the pid is negative. Throws when it is gone. */
export function sendSignal(pid: number, signal: NodeJS.Signals): void {
  process.kill(pid, signal)
}

/**
 * The worker and everything below it. A group is killed whole only when its leader is in the tree, so the daemon's
 * own group is never touched; the tree's members in other groups are killed one by one. Init (1) and pid 0 are
 * never named: as a group, -1 means every process and 0 the caller's own group.
 */
export function processTreeTargets(rootPid: number, rows: ProcessRow[]): ProcessTreeTargets {
  if (rootPid <= 1) return { groups: [], pids: [], members: [] }
  const tree = new Set<number>([rootPid])
  let grew = true
  while (grew) {
    grew = false
    for (const row of rows) {
      if (!tree.has(row.pid) && tree.has(row.ppid)) {
        tree.add(row.pid)
        grew = true
      }
    }
  }
  const groupOf = new Map(rows.map((row) => [row.pid, row.pgid]))
  const groups = new Set<number>()
  const pids: number[] = []
  for (const pid of tree) {
    if (pid <= 1) continue
    const pgid = groupOf.get(pid) ?? -1
    if (pgid > 1 && tree.has(pgid)) groups.add(pgid)
    else pids.push(pid)
  }
  return {
    groups: [...groups].sort((a, b) => a - b),
    pids: pids.sort((a, b) => a - b),
    members: rows.filter((row) => tree.has(row.pid)),
  }
}

/**
 * The targets that are still what they were, from a fresh read of the table, so a later pass never signals a pid or
 * group the system has since handed to something else. A group counts while it holds a member's child (git forks ssh
 * after the first read), or a member that launchd took over when its parent died. A process counts while it keeps its
 * group and its parent is a member or launchd. A pid reused within the grace by a child of launchd would still pass;
 * macOS hands out pids in order, so that needs the whole pid range to wrap in about a second.
 */
export function targetsStillInTree(targets: ProcessTreeTargets, rows: ProcessRow[]): ProcessTreeTargets {
  const memberPids = new Set(targets.members.map((member) => member.pid))
  const groupOf = new Map(targets.members.map((member) => [member.pid, member.pgid]))
  const stillOurs = (row: ProcessRow): boolean => memberPids.has(row.ppid) || (row.ppid === 1 && memberPids.has(row.pid))
  const groups = targets.groups.filter((group) => rows.some((row) => row.pgid === group && stillOurs(row)))
  const pids = targets.pids.filter((pid) =>
    rows.some((row) => row.pid === pid && row.pgid === groupOf.get(pid) && (row.ppid === 1 || memberPids.has(row.ppid))))
  return { groups, pids, members: targets.members }
}

/**
 * Signal every target except `skipPid` (already signalled). A process that is already gone is not an error. Returns
 * how many groups and processes were signalled.
 */
export function killProcessTree(
  targets: ProcessTreeTargets,
  skipPid: number,
  kill: (pid: number, signal: NodeJS.Signals) => void,
  signal: NodeJS.Signals,
): { groups: number; processes: number } {
  const signalled = { groups: 0, processes: 0 }
  const send = (pid: number): boolean => {
    try {
      kill(pid, signal)
      return true
    } catch {
      return false
    }
  }
  for (const group of targets.groups) if (send(-group)) signalled.groups += 1
  for (const pid of targets.pids) if (pid !== skipPid && send(pid)) signalled.processes += 1
  return signalled
}
