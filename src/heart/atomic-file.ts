import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import * as path from "node:path"
import { randomUUID } from "node:crypto"
import { emitNervesEvent } from "../nerves/runtime"

export interface AtomicWriteOptions {
  /** File mode for the new file. Agent state is private, so the default is 0o600. */
  mode?: number
  /** Where the temporary file is written, when readers of the target folder must never see it. Must be on the same filesystem. */
  temporaryDirectory?: string
}

/**
 * Replace a file all at once: a reader sees the old contents or the new, never a torn write.
 * The temporary name is unique per call, so concurrent writers in one process cannot collide, and
 * the file and its folder are flushed to disk before this returns.
 */
export function writeFileAtomicSync(filePath: string, contents: string | Uint8Array, options: AtomicWriteOptions = {}): void {
  const directory = path.dirname(filePath)
  const temporaryDirectory = options.temporaryDirectory ?? directory
  fs.mkdirSync(directory, { recursive: true })
  fs.mkdirSync(temporaryDirectory, { recursive: true })
  const temporary = path.join(temporaryDirectory, `${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    const handle = fs.openSync(temporary, "wx", options.mode ?? 0o600)
    try {
      fs.writeFileSync(handle, contents)
      fs.fsyncSync(handle)
    } finally {
      fs.closeSync(handle)
    }
    fs.renameSync(temporary, filePath)
  } catch (error) {
    fs.rmSync(temporary, { force: true })
    emitNervesEvent({
      level: "warn",
      component: "engine",
      event: "engine.atomic_write_failed",
      message: "atomic file write failed",
      meta: { file: path.basename(filePath), reason: error instanceof Error ? error.message : String(error) },
    })
    throw error
  }
  const directoryHandle = fs.openSync(directory, "r")
  try { fs.fsyncSync(directoryHandle) } finally { fs.closeSync(directoryHandle) }
}

/** `writeFileAtomicSync` for a JSON value, pretty-printed with a trailing newline. */
export function writeJsonAtomicSync(filePath: string, value: unknown, options: AtomicWriteOptions = {}): void {
  writeFileAtomicSync(filePath, `${JSON.stringify(value, null, 2)}\n`, options)
}

/** The async `writeFileAtomicSync`, for large buffers on a sense's hot path. Folders it creates are private (0o700). */
export async function writeFileAtomic(filePath: string, buffer: Uint8Array): Promise<void> {
  const directory = path.dirname(filePath)
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  let handle: fsp.FileHandle | undefined
  try {
    handle = await fsp.open(temporary, "wx", 0o600)
    await handle.writeFile(buffer)
    await handle.sync()
    await handle.close()
    handle = undefined
    await fsp.rename(temporary, filePath)
    const directoryHandle = await fsp.open(directory, "r")
    try { await directoryHandle.sync() } finally { await directoryHandle.close() }
  } finally {
    await handle?.close().catch(() => undefined)
    await fsp.unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error })
  }
}
