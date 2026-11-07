import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { execFileSync } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { registerGlobalLogSink, type LogEvent } from "../../nerves"
import { loadPsycheAt, resetPsycheCache } from "../../mind/prompt"
import { setSyncOwnerNotifier, type SyncOwnerNotice } from "../../heart/sync"
import { voicePsycheExcerpts } from "../../senses/voice/twilio-phone"

const ID = ["-c", "user.name=Owner", "-c", "user.email=owner@example.invalid", "-c", "commit.gpgsign=false"]
const CONFLICTED = "mine\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> origin/main\nafter\n"

let root: string
let events: LogEvent[]
let unregister: () => void
let notices: SyncOwnerNotice[]

function soulPath(): string {
  return path.join(root, "psyche", "SOUL.md")
}

function write(text: string): void {
  fs.mkdirSync(path.join(root, "psyche"), { recursive: true })
  fs.writeFileSync(soulPath(), text)
}

function git(...args: string[]): void {
  execFileSync("git", [...ID, ...args], { cwd: root, stdio: "ignore" })
}

const markerEvents = () => events.filter((e) => e.event === "psyche.conflict_markers")

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "psyche-markers-"))
  events = []
  notices = []
  unregister = registerGlobalLogSink((e) => events.push(e))
  setSyncOwnerNotifier((_name, notice) => {
    notices.push(notice)
  })
  resetPsycheCache()
})

afterEach(() => {
  unregister()
  setSyncOwnerNotifier(null)
  fs.rmSync(root, { recursive: true, force: true })
})

describe("psyche conflict markers", () => {
  it("a <<<<<<< … >>>>>>> pair uses the last good text in memory", () => {
    write("good soul")
    expect(loadPsycheAt(root).soul).toBe("good soul")
    write(CONFLICTED)
    expect(loadPsycheAt(root).soul).toBe("good soul")
    expect(markerEvents()).toHaveLength(1)
  })

  it("after a restart it uses git show HEAD:psyche/<name>", () => {
    write("committed soul")
    git("init", "-q")
    git("add", ".")
    git("commit", "-q", "-m", "init")
    write(CONFLICTED)
    expect(loadPsycheAt(root).soul).toBe("committed soul")
  })

  it("after a restart a committed copy that also has markers is not used", () => {
    write(CONFLICTED)
    git("init", "-q")
    git("add", ".")
    git("commit", "-q", "-m", "init")
    expect(loadPsycheAt(root).soul).toBe("")
  })

  it("neither: the section is omitted and psyche.conflict_markers is emitted once", async () => {
    write(CONFLICTED)
    expect(loadPsycheAt(root).soul).toBe("")
    expect(loadPsycheAt(root).soul).toBe("")
    expect(markerEvents()).toHaveLength(1)
    expect(markerEvents()[0].meta).toMatchObject({ path: soulPath() })
    await vi_waitFor(() => notices.length === 1)
    expect(notices[0].text).toBe("psyche/SOUL.md has unresolved merge conflict markers.")
    expect(notices[0].text).not.toMatch(/<<<<<<<|>>>>>>>/)
    write(CONFLICTED + "more\n")
    loadPsycheAt(root)
    expect(markerEvents()).toHaveLength(2)
  })

  it("a lone ======= line is valid", () => {
    write("above\n=======\nbelow\n<<<<<<< not closed\n")
    expect(loadPsycheAt(root).soul).toContain("=======")
    expect(markerEvents()).toHaveLength(0)
  })

  it("a closing marker before the opening one is not a pair", () => {
    write(">>>>>>> first\n<<<<<<< second\n")
    expect(loadPsycheAt(root).soul).toContain("second")
  })

  it("twilio keeps its character cap", async () => {
    write("s".repeat(5000))
    fs.writeFileSync(path.join(root, "psyche", "IDENTITY.md"), "i".repeat(5000))
    fs.writeFileSync(path.join(root, "psyche", "TACIT.md"), "short")
    const { soul, identity, tacit } = voicePsycheExcerpts(root)
    expect(soul).toBe(`${"s".repeat(1600)}\n[truncated for low-latency voice]`)
    expect(identity.startsWith("i".repeat(3200))).toBe(true)
    expect(identity.length).toBe(3200 + "\n[truncated for low-latency voice]".length)
    expect(tacit).toBe("short")
  })

  it("twilio gets the last good text when the file has markers", () => {
    write("good soul")
    voicePsycheExcerpts(root)
    write(CONFLICTED)
    expect(voicePsycheExcerpts(root).soul).toBe("good soul")
  })
})

async function vi_waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 10))
}
