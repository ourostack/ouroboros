/**
 * The eval kill switch: while the file `~/.ouro-eval/STOP` exists, the budget ledger refuses every reservation and
 * every later model call, so a running batch stops at its next call, and Watch exits before it reads anything. Make
 * it with `mkdir -p ~/.ouro-eval && touch ~/.ouro-eval/STOP`, and delete it to allow runs again. Any kind of entry at
 * that path counts, a broken link included.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { emitNervesEvent } from "../nerves/runtime"

/** The eval's private folder on this machine. */
export function evalHome(home: string = os.homedir()): string {
  return path.join(home, ".ouro-eval")
}

export function stopFile(home: string = os.homedir()): string {
  return path.join(evalHome(home), "STOP")
}

/** Why evals must stop now, or undefined while they may run. */
export function stopRequested(file: string = stopFile()): string | undefined {
  if (!fs.lstatSync(file, { throwIfNoEntry: false })) return undefined
  emitNervesEvent({ component: "eval", level: "warn", event: "eval.kill_switch_set", message: "the eval kill switch is set", meta: {} })
  // The reason reaches stdout and the report, so it names the switch, not the home folder.
  return "the kill switch ~/.ouro-eval/STOP is set"
}
