import * as fs from "node:fs"
import * as path from "node:path"
import { createHash } from "node:crypto"
import { emitNervesEvent } from "../nerves/runtime"
import type { A2ATask } from "./types"

function taskFileName(taskId: string, ownerScope: string): string {
  return `${createHash("sha256").update(`${ownerScope}\n${taskId}`).digest("hex")}.json`
}

export class FileA2ATaskStore {
  private readonly dir: string

  constructor(agentRoot: string) {
    this.dir = path.join(agentRoot, "state", "a2a", "tasks")
    fs.mkdirSync(this.dir, { recursive: true })
    emitNervesEvent({
      component: "channels",
      event: "channel.a2a_task_store_init",
      message: "initialized A2A task store",
      meta: { dir: this.dir },
    })
  }

  put(task: A2ATask, ownerScope = "legacy"): void {
    fs.writeFileSync(path.join(this.dir, taskFileName(task.id, ownerScope)), `${JSON.stringify(task, null, 2)}\n`, "utf-8")
  }

  get(taskId: string, ownerScope = "legacy"): A2ATask | null {
    try {
      const raw = fs.readFileSync(path.join(this.dir, taskFileName(taskId, ownerScope)), "utf-8")
      return JSON.parse(raw) as A2ATask
    } catch {
      return null
    }
  }
}
