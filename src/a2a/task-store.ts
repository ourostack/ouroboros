import * as fs from "node:fs"
import * as path from "node:path"
import { emitNervesEvent } from "../nerves/runtime"
import type { A2ATask } from "./types"

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

  put(task: A2ATask): void {
    fs.writeFileSync(path.join(this.dir, `${task.id}.json`), `${JSON.stringify(task, null, 2)}\n`, "utf-8")
  }

  get(taskId: string): A2ATask | null {
    try {
      const raw = fs.readFileSync(path.join(this.dir, `${taskId}.json`), "utf-8")
      return JSON.parse(raw) as A2ATask
    } catch {
      return null
    }
  }
}

