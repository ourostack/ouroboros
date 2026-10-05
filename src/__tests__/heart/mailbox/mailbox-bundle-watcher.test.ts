import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { describe, expect, it, vi } from "vitest"

vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

type Listener = (eventType: string, filename: string | null) => void

interface FakeHandle {
  dir: string
  recursive: boolean
  listener: Listener
  close: ReturnType<typeof vi.fn>
  errorListener: ((error: Error) => void) | null
}

/** In-memory directory tree: path -> child names (a trailing "/" marks a subdirectory). */
function createFakeTree(tree: Record<string, string[]>) {
  const handles: FakeHandle[] = []
  const readdirCalls: string[] = []
  let nextTimerId = 1
  const pending = new Map<number, () => void>()
  /** Live (not yet cleared or fired) timers, oldest first; `shift()` fires and removes the oldest. */
  const timers = {
    get length() { return pending.size },
    shift(): (() => void) | undefined {
      const first = pending.entries().next().value as [number, () => void] | undefined
      if (!first) return undefined
      pending.delete(first[0])
      return first[1]
    },
    at(index: number): (() => void) | undefined {
      return [...pending.values()].at(index)
    },
    splice(): Array<() => void> {
      const all = [...pending.values()]
      pending.clear()
      return all
    },
  }
  const deps = {
    platform: "linux" as NodeJS.Platform,
    existsSync: (target: string) => target in tree,
    watch: (dir: string, options: { recursive: boolean }, listener: Listener) => {
      const handle: FakeHandle = { dir, recursive: options.recursive, listener, close: vi.fn(), errorListener: null }
      handles.push(handle)
      return {
        close: handle.close,
        on: (_event: "error", errorListener: (error: Error) => void) => {
          handle.errorListener = errorListener
        },
      }
    },
    readdir: async (dir: string) => {
      readdirCalls.push(dir)
      const names = tree[dir]
      if (!names) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
      return names.map((name) => ({ name: name.replace(/\/$/, ""), isDirectory: () => name.endsWith("/") }))
    },
    setTimeout: (callback: () => void) => {
      const id = nextTimerId++
      pending.set(id, callback)
      return id as unknown as ReturnType<typeof setTimeout>
    },
    clearTimeout: vi.fn((id: unknown) => { pending.delete(id as number) }),
  }
  return { tree, deps, handles, readdirCalls, timers }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

describe("createBundleWatcher on Linux", () => {
  it("returns after one synchronous watch and never asks the kernel for a recursive walk", async () => {
    const { createBundleWatcher } = await import("../../../heart/mailbox/mailbox-http-transport")
    const fake = createFakeTree({ "/bundles": ["a.ouro/", "notes.md"], "/bundles/a.ouro": ["state/", "agent.json"], "/bundles/a.ouro/state": [] })

    const watcher = createBundleWatcher("/bundles", vi.fn(), fake.deps)

    // The daemon's event loop is blocked for as long as this call takes. Node's recursive watcher on
    // Linux stat()s and inotify-watches every file in the tree before returning (7-10 s for a 12k-file bundle).
    expect(fake.handles).toHaveLength(1)
    expect(fake.handles[0]!.dir).toBe("/bundles")
    expect(fake.handles.every((handle) => handle.recursive === false)).toBe(true)
    // Discovery is async: at most the root's (non-blocking) readdir has been issued.
    expect(fake.readdirCalls.length).toBeLessThanOrEqual(1)

    await settle()
    expect(fake.handles.map((handle) => handle.dir).sort()).toEqual(["/bundles", "/bundles/a.ouro", "/bundles/a.ouro/state"])
    expect(fake.handles.every((handle) => handle.recursive === false)).toBe(true)
    watcher.stop()
  })

  it("handles a chown-style event storm without touching the filesystem", async () => {
    const { createBundleWatcher } = await import("../../../heart/mailbox/mailbox-http-transport")
    const names = Array.from({ length: 3_500 }, (_, index) => `receipt-${index}.json`)
    const fake = createFakeTree({ "/bundles": ["receipts/"], "/bundles/receipts": names })
    const onChange = vi.fn()
    const watcher = createBundleWatcher("/bundles", onChange, fake.deps)
    await settle()
    const readdirsBeforeStorm = fake.readdirCalls.length
    const receipts = fake.handles.find((handle) => handle.dir === "/bundles/receipts")!

    // Node's JS recursive watcher answers every one of these with readdirSync(whole directory) + statSync.
    for (const name of names) receipts.listener("change", name)

    expect(fake.readdirCalls.length).toBe(readdirsBeforeStorm)
    expect(fake.timers.length).toBe(1)
    fake.timers.shift()?.()
    expect(onChange).toHaveBeenCalledTimes(1)
    watcher.stop()
  })

  it("debounces change events through one timer and clears the pending one", async () => {
    const { createBundleWatcher } = await import("../../../heart/mailbox/mailbox-http-transport")
    const fake = createFakeTree({ "/bundles": [] })
    const onChange = vi.fn()
    const watcher = createBundleWatcher("/bundles", onChange, fake.deps)
    const root = fake.handles[0]!
    root.listener("change", "x")
    root.listener("change", "y")
    expect(fake.deps.clearTimeout).toHaveBeenCalledTimes(1)
    expect(fake.timers.length).toBe(1)
    fake.timers.at(-1)!()
    expect(onChange).toHaveBeenCalledTimes(1)
    watcher.stop()
  })

  it("starts watching a directory created later and stops watching one that was removed", async () => {
    const { createBundleWatcher } = await import("../../../heart/mailbox/mailbox-http-transport")
    const fake = createFakeTree({ "/bundles": ["old/"], "/bundles/old": [] })
    const watcher = createBundleWatcher("/bundles", vi.fn(), fake.deps)
    await settle()
    const oldHandle = fake.handles.find((handle) => handle.dir === "/bundles/old")!

    fake.tree["/bundles"] = ["fresh/"]
    fake.tree["/bundles/fresh"] = ["deeper/"]
    fake.tree["/bundles/fresh/deeper"] = []
    delete fake.tree["/bundles/old"]
    fake.handles[0]!.listener("rename", "fresh")
    fake.handles[0]!.listener("rename", "old")
    // Both renames land in the same debounce window and reconcile the root once.
    while (fake.timers.length > 0) fake.timers.shift()!()
    await settle()

    expect(oldHandle.close).toHaveBeenCalledTimes(1)
    expect(fake.handles.map((handle) => handle.dir)).toEqual(expect.arrayContaining(["/bundles/fresh", "/bundles/fresh/deeper"]))
    expect(fake.readdirCalls.filter((dir) => dir === "/bundles")).toHaveLength(2)
    watcher.stop()
  })

  it("queues rename events that arrive while a reconcile is running", async () => {
    const { createBundleWatcher } = await import("../../../heart/mailbox/mailbox-http-transport")
    const fake = createFakeTree({ "/bundles": [] })
    const watcher = createBundleWatcher("/bundles", vi.fn(), fake.deps)
    await settle()
    const root = fake.handles[0]!
    fake.tree["/bundles"] = ["one/"]
    fake.tree["/bundles/one"] = []
    root.listener("rename", "one")
    fake.timers.shift()!()
    // Second drain starts before the first finishes: it must not run concurrently, and the new event is still handled.
    fake.tree["/bundles"] = ["one/", "two/"]
    fake.tree["/bundles/two"] = []
    root.listener("rename", "two")
    fake.timers.shift()!()
    await settle()
    while (fake.timers.length > 0) fake.timers.shift()!()
    await settle()
    expect(fake.handles.map((handle) => handle.dir)).toEqual(expect.arrayContaining(["/bundles/one", "/bundles/two"]))
    watcher.stop()
  })

  it("drops a watch whose handle reports an error and still reports a change", async () => {
    const { createBundleWatcher } = await import("../../../heart/mailbox/mailbox-http-transport")
    const fake = createFakeTree({ "/bundles": ["a/"], "/bundles/a": [] })
    const onChange = vi.fn()
    const watcher = createBundleWatcher("/bundles", onChange, fake.deps)
    await settle()
    const handle = fake.handles.find((candidate) => candidate.dir === "/bundles/a")!
    handle.errorListener?.(new Error("EMFILE"))
    expect(handle.close).toHaveBeenCalledTimes(1)
    fake.timers.shift()?.()
    expect(onChange).toHaveBeenCalledTimes(1)

    // A close() that throws must not escape.
    handle.close.mockImplementation(() => { throw new Error("already closed") })
    const root = fake.handles[0]!
    root.close.mockImplementation(() => { throw new Error("already closed") })
    root.errorListener?.(new Error("EMFILE"))
    watcher.stop()
  })

  it("ignores a directory that disappears mid-walk and a watch that cannot be created", async () => {
    const { createBundleWatcher } = await import("../../../heart/mailbox/mailbox-http-transport")
    const fake = createFakeTree({ "/bundles": ["gone/", "denied/"], "/bundles/denied": [] })
    const realWatch = fake.deps.watch
    fake.deps.watch = (dir, options, listener) => {
      if (dir === "/bundles/denied") throw new Error("ENOSPC")
      return realWatch(dir, options, listener)
    }
    const watcher = createBundleWatcher("/bundles", vi.fn(), fake.deps)
    await settle()
    expect(fake.handles.map((handle) => handle.dir).sort()).toEqual(["/bundles", "/bundles/gone"])
    // "gone" had no tree entry, so readdir rejected and its watch was released.
    expect(fake.handles.find((handle) => handle.dir === "/bundles/gone")!.close).toHaveBeenCalledTimes(1)
    watcher.stop()
  })

  it("stop() closes every watch, cancels timers and prevents further walking", async () => {
    const { createBundleWatcher } = await import("../../../heart/mailbox/mailbox-http-transport")
    const fake = createFakeTree({ "/bundles": ["a/"], "/bundles/a": ["b/"], "/bundles/a/b": [] })
    const watcher = createBundleWatcher("/bundles", vi.fn(), fake.deps)
    fake.handles[0]!.listener("change", "x")
    fake.handles[0]!.listener("rename", "a")
    watcher.stop()
    await settle()
    for (const timer of fake.timers.splice(0)) timer()
    await settle()
    expect(fake.handles.every((handle) => handle.close.mock.calls.length === 1)).toBe(true)
    expect(fake.handles.map((handle) => handle.dir)).not.toContain("/bundles/a/b")
  })

  it("does nothing when the bundles root is missing", async () => {
    const { createBundleWatcher } = await import("../../../heart/mailbox/mailbox-http-transport")
    const fake = createFakeTree({})
    createBundleWatcher("/missing", vi.fn(), fake.deps).stop()
    expect(fake.handles).toEqual([])
  })

  it("survives a root watch that throws", async () => {
    const { createBundleWatcher } = await import("../../../heart/mailbox/mailbox-http-transport")
    const fake = createFakeTree({ "/bundles": [] })
    fake.deps.watch = () => { throw new Error("unsupported") }
    createBundleWatcher("/bundles", vi.fn(), fake.deps).stop()
  })
})

describe("createBundleWatcher reconcile ordering", () => {
  function deferredReaddir(fake: ReturnType<typeof createFakeTree>) {
    const gates: Array<() => void> = []
    const inner = fake.deps.readdir
    fake.deps.readdir = (dir: string) => new Promise((resolve, reject) => {
      gates.push(() => inner(dir).then(resolve, reject))
    })
    return gates
  }

  it("does not run two reconciles at once", async () => {
    const { createBundleWatcher } = await import("../../../heart/mailbox/mailbox-http-transport")
    const fake = createFakeTree({ "/bundles": [] })
    const gates = deferredReaddir(fake)
    const watcher = createBundleWatcher("/bundles", vi.fn(), fake.deps)
    gates.shift()!()
    await settle()
    fake.handles[0]!.listener("rename", "x")
    for (const timer of fake.timers.splice()) timer()
    await settle()
    expect(gates).toHaveLength(1)
    // A second rename while the first rescan is still blocked on readdir queues behind it.
    fake.handles[0]!.listener("rename", "y")
    for (const timer of fake.timers.splice()) timer()
    await settle()
    expect(gates).toHaveLength(1)
    gates.shift()!()
    await settle()
    expect(gates).toHaveLength(1)
    gates.shift()!()
    await settle()
    watcher.stop()
  })

  it("stops walking when stopped while a directory is being read", async () => {
    const { createBundleWatcher } = await import("../../../heart/mailbox/mailbox-http-transport")
    const fake = createFakeTree({ "/bundles": ["a/"], "/bundles/a": [] })
    const gates = deferredReaddir(fake)
    const watcher = createBundleWatcher("/bundles", vi.fn(), fake.deps)
    watcher.stop()
    gates.shift()!()
    await settle()
    expect(fake.handles.map((handle) => handle.dir)).toEqual(["/bundles"])
  })

  it("stops between nested directories", async () => {
    const { createBundleWatcher } = await import("../../../heart/mailbox/mailbox-http-transport")
    const fake = createFakeTree({ "/bundles": ["a/"], "/bundles/a": ["b/"], "/bundles/a/b": [] })
    const gates = deferredReaddir(fake)
    const watcher = createBundleWatcher("/bundles", vi.fn(), fake.deps)
    gates.shift()!()
    await settle()
    watcher.stop()
    gates.shift()!()
    await settle()
    expect(gates).toHaveLength(0)
  })

  it("starts a rescan that finds the watcher already stopped", async () => {
    const { createBundleWatcher } = await import("../../../heart/mailbox/mailbox-http-transport")
    const fake = createFakeTree({ "/bundles": [] })
    const watcher = createBundleWatcher("/bundles", vi.fn(), fake.deps)
    await settle()
    fake.handles[0]!.listener("rename", "x")
    const fire = () => { for (const timer of fake.timers.splice()) timer() }
    watcher.stop()
    fire()
    await settle()
  })
})

describe("createBundleWatcher on platforms with native recursive watch", () => {
  it("keeps one recursive watch and reports its changes and errors", async () => {
    const { createBundleWatcher } = await import("../../../heart/mailbox/mailbox-http-transport")
    const fake = createFakeTree({ "/bundles": ["a/"] })
    fake.deps.platform = "darwin"
    const onChange = vi.fn()
    const watcher = createBundleWatcher("/bundles", onChange, fake.deps)
    expect(fake.handles).toHaveLength(1)
    expect(fake.handles[0]!.recursive).toBe(true)
    expect(fake.readdirCalls).toEqual([])
    fake.handles[0]!.listener("change", "x")
    fake.timers.shift()!()
    expect(onChange).toHaveBeenCalledTimes(1)
    fake.handles[0]!.errorListener?.(new Error("boom"))
    expect(fake.handles[0]!.close).toHaveBeenCalledTimes(1)
    watcher.stop()
    expect(fake.handles[0]!.close).toHaveBeenCalledTimes(1)
  })
})

describe("createBundleWatcher with the real filesystem", () => {
  it.each(["host default", "linux strategy"])("reports edits in existing directories and in directories created after startup (%s)", async (variant) => {
    const { createBundleWatcher } = await import("../../../heart/mailbox/mailbox-http-transport")
    const linuxDeps = {
      platform: "linux" as NodeJS.Platform,
      existsSync: fs.existsSync,
      watch: (target: string, options: { recursive: boolean }, listener: Listener) => fs.watch(target, options, listener),
      readdir: (target: string) => fs.promises.readdir(target, { withFileTypes: true }),
      setTimeout,
      clearTimeout,
    }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-watcher-"))
    fs.mkdirSync(path.join(root, "agent.ouro", "state"), { recursive: true })
    const onChange = vi.fn()
    const watcher = variant === "linux strategy" ? createBundleWatcher(root, onChange, linuxDeps) : createBundleWatcher(root, onChange)
    const waitFor = async (predicate: () => boolean) => {
      const deadline = Date.now() + 5_000
      while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25))
      expect(predicate()).toBe(true)
    }
    try {
      await new Promise((resolve) => setTimeout(resolve, 200))
      fs.writeFileSync(path.join(root, "agent.ouro", "state", "a.json"), "{}")
      await waitFor(() => onChange.mock.calls.length >= 1)

      fs.mkdirSync(path.join(root, "agent.ouro", "later", "nested"), { recursive: true })
      await new Promise((resolve) => setTimeout(resolve, 1_200))
      const before = onChange.mock.calls.length
      fs.writeFileSync(path.join(root, "agent.ouro", "later", "nested", "b.json"), "{}")
      await waitFor(() => onChange.mock.calls.length > before)
    } finally {
      watcher.stop()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
