import * as path from "node:path"
import { promisify } from "node:util"
import { emitNervesEvent } from "../../nerves/runtime"

export interface TerminalProcessIdentity { agent: string; cwd: string | null; instance?: string }
type RunCommand = (command: string, args: string[]) => Promise<string>

async function runCommand(command: string, args: string[]): Promise<string> {
  const { execFile } = await import("node:child_process")
  const exec = promisify(execFile)
  const { stdout } = await exec(command, args, { timeout: 3_000, maxBuffer: 4 * 1024 * 1024 })
  return stdout
}

/** Batched process/cwd lookups; Node launchers need one additional argv snapshot, never a subprocess per surface. */
export async function identifyTerminalProcesses(ttys: string[], run: RunCommand = runCommand): Promise<Map<string, TerminalProcessIdentity>> {
  const result = new Map<string, TerminalProcessIdentity>()
  if (ttys.length === 0) return result
  const wanted = new Set(ttys.map((tty) => tty.replace(/^\/dev\//, "")))
  const agents = new Map<string, { pid: number; parent: number; agent: string }[]>()
  const snapshots = new Map<number, string>()
  const nodeLaunchers = new Map<number, { parent: number; tty: string }>()
  try {
    for (const line of (await run("ps", ["-axo", "pid=,ppid=,pgid=,tpgid=,tty=,comm="])).split("\n")) {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s+(.+)$/)
      if (!match) continue
      const [, pid, parent, group, foreground, tty, command] = match
      if (!wanted.has(tty!) || group !== foreground) continue
      snapshots.set(Number(pid), `${pid} ${parent} ${group} ${foreground} ${tty} ${command}`)
      const executable = path.basename(command!)
      if (executable === "node") nodeLaunchers.set(Number(pid), { parent: Number(parent), tty: tty! })
      const agent = executable === "claude" ? "Claude Code" : executable === "copilot" ? "Copilot" : executable === "codex" ? "Codex" : null
      if (!agent) continue
      const candidates = agents.get(tty!) ?? []
      candidates.push({ pid: Number(pid), parent: Number(parent), agent })
      agents.set(tty!, candidates)
    }
  } catch (error) {
    emitNervesEvent({ level: "warn", component: "senses", event: "senses.shepherd_process_lookup_error", message: "could not identify terminal foreground agents", meta: { error: String(error) } })
    return result
  }
  if (nodeLaunchers.size > 0) {
    try {
      for (const line of (await run("ps", ["-p", [...nodeLaunchers.keys()].join(","), "-o", "pid=,args="])).split("\n")) {
        const match = line.trim().match(/^(\d+)\s+\S+\s+(\S+)/)
        if (!match) continue
        const launcher = nodeLaunchers.get(Number(match[1]))
        if (!launcher || !/(?:^|\/)copilot\/pkg\/[^/]+\/[^/]+\/cli-main\.js$/.test(match[2]!)) continue
        const candidates = agents.get(launcher.tty) ?? []
        candidates.push({ pid: Number(match[1]), parent: launcher.parent, agent: "Copilot" })
        agents.set(launcher.tty, candidates)
      }
    } catch (error) {
      emitNervesEvent({ level: "warn", component: "senses", event: "senses.shepherd_process_lookup_error", message: "could not identify Node-hosted terminal agents", meta: { error: String(error) } })
    }
  }
  const selected = new Map<string, { pid: number; agent: string; unique: boolean }>()
  for (const [tty, candidates] of agents) {
    const roots = candidates.filter((candidate) => !candidates.some((parent) => parent.pid === candidate.parent))
    const outer = roots[0] ?? candidates[0]!
    selected.set(tty, { ...outer, unique: roots.length === 1 })
    result.set(tty, { agent: outer.agent, cwd: null })
  }
  if (selected.size === 0) return result
  try {
    const cwdByPid = new Map<number, string>()
    let pid = 0
    const output = await run("lsof", ["-a", "-p", [...selected.values()].map((agent) => agent.pid).join(","), "-d", "cwd", "-Fn"])
    for (const line of output.split("\n")) {
      if (line.startsWith("p")) pid = Number(line.slice(1))
      else if (line.startsWith("n") && pid) cwdByPid.set(pid, line.slice(1))
    }
    for (const [tty, agent] of selected) result.set(tty, { agent: agent.agent, cwd: cwdByPid.get(agent.pid) ?? null })
  } catch (error) {
    emitNervesEvent({ level: "warn", component: "senses", event: "senses.shepherd_cwd_lookup_error", message: "could not read foreground agent folders", meta: { error: String(error) } })
  }
  // A fresh batched snapshot verifies the same foreground process, not just a reusable PID.
  // Unsupported ps variants and disappearing processes leave presentation intact but no authority.
  try {
    const starts = new Map<number, string[]>()
    for (const line of (await run("ps", ["-p", [...selected.values()].map(agent => agent.pid).join(","), "-o", "pid=,ppid=,pgid=,tpgid=,tty=,lstart=,comm="])).split("\n")) {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/)
      if (!match) continue
      const [, pid, parent, group, foreground, tty, start, command] = match
      if (snapshots.get(Number(pid)) !== `${pid} ${parent} ${group} ${foreground} ${tty} ${command}`) continue
      const values = starts.get(Number(pid)) ?? []
      values.push(start!.replace(/\s+/g, " "))
      starts.set(Number(pid), values)
    }
    for (const [tty, agent] of selected) {
      const values = starts.get(agent.pid)
      if (agent.unique && values?.length === 1) result.get(tty)!.instance = `${agent.pid}:${values[0]}`
    }
  } catch (error) {
    emitNervesEvent({ level: "warn", component: "senses", event: "senses.shepherd_process_lookup_error", message: "could not verify foreground process start identity", meta: { error: String(error) } })
  }
  return result
}
