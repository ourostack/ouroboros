/**
 * Watch's only way to touch files. It reads anywhere, but writes only into its own private folder (0700, files 0600),
 * and it refuses any write, append, rename or unlink under a protected folder (the agent bundles).
 *
 * How a write is kept out of a protected folder:
 * - A path is protected if any folder on its way up is a protected folder, compared by device and inode, so letter
 *   case (macOS names are case-insensitive) and links can't disguise it.
 * - Writes open with `O_NOFOLLOW`, so a link planted in the private folder (even one whose target doesn't exist yet)
 *   is refused rather than followed, and the opened file must be a regular file with one name, in the private folder.
 * Reads open the file `O_RDONLY`, so an agent's logs can't be changed through Watch even by mistake.
 */
import fs from "node:fs"
import path from "node:path"
import { emitNervesEvent } from "../../nerves/runtime"

/** A file opened once for reading; every read goes through the same descriptor. */
export interface ReadHandle {
  ino: number
  size: number
  read(start: number, length?: number): Buffer
}

export interface GuardedFs {
  /** Opens `file` read-only, runs `use`, and closes it. Null if the file doesn't exist. */
  withFile<T>(file: string, use: (handle: ReadHandle) => T): T | null
  /** The whole file, read-only, or null if it doesn't exist. */
  readWhole(file: string): Buffer | null
  exists(file: string): boolean
  list(dir: string): string[]
  /** The guarded primitive. Only `r`, `wx` and `a` (no truncating flag, so nothing is emptied before the checks); any but `r` must be a file in the private folder. */
  open(file: string, flags: string): number
  rename(from: string, to: string): void
  unlink(file: string): void
  readPrivate(name: string): string | null
  writePrivate(name: string, text: string): void
  appendPrivate(name: string, text: string): void
}

const WRITE_FLAGS: Record<string, number> = {
  wx: fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
  a: fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND,
}
const PRIVATE_NAME = /^[a-z][a-z0-9.-]{0,63}$/
/** The only names Watch keeps in its private folder; an existing folder holding anything else is refused. */
const WATCH_FILES = /^(?:cursor\.json|rows\.ndjson|salt)(?:\.tmp)?$/

/** The deepest folder on `target`'s way up that exists, with links resolved. */
function existingAncestor(target: string): string {
  let current = path.resolve(target)
  for (;;) {
    try {
      return fs.realpathSync.native(current)
    } catch {
      const parent = path.dirname(current)
      /* v8 ignore next -- the file-system root always resolves @preserve */
      if (parent === current) return current
      current = parent
    }
  }
}

function identity(stats: fs.Stats): string {
  return `${stats.dev}:${stats.ino}`
}

/** Whether two names are the same folder name; macOS and Windows names ignore letter case. */
export function sameName(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin" || platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b
}

function isInsideByName(child: string, parent: string): boolean {
  const childParts = path.resolve(child).split(path.sep)
  const parentParts = path.resolve(parent).split(path.sep)
  return parentParts.length <= childParts.length && parentParts.every((part, index) => sameName(part, childParts[index]))
}

export function createGuardedFs(options: { protectedRoots: readonly string[]; privateDir: string }): GuardedFs {
  const refuse = (reason: string): never => {
    emitNervesEvent({ level: "error", component: "eval", event: "eval.watch_write_refused", message: "Watch refused a write", meta: { reason } })
    throw new Error(reason === "protected" ? "Watch never writes in a protected folder" : `Watch writes only in its private folder (${reason})`)
  }
  const protectedIds = new Set<string>()
  for (const root of options.protectedRoots) {
    try {
      protectedIds.add(identity(fs.statSync(root)))
    } catch {
      // A protected folder that doesn't exist yet is still caught by name below.
    }
  }
  /** Whether any folder from `target` up is protected, by identity or by name. */
  const isProtected = (target: string): boolean => {
    if (options.protectedRoots.some((root) => isInsideByName(target, root))) return true
    let current = existingAncestor(target)
    for (;;) {
      if (protectedIds.has(identity(fs.statSync(current)))) return true
      const parent = path.dirname(current)
      if (parent === current) return false
      current = parent
    }
  }

  if (isProtected(options.privateDir)) refuse("protected")
  fs.mkdirSync(options.privateDir, { recursive: true, mode: 0o700 })
  if (fs.lstatSync(options.privateDir).isSymbolicLink()) refuse("link")
  // A folder that already holds anything but Watch's own files (such as `--out ~`) is not Watch's to take over.
  if (fs.readdirSync(options.privateDir).some((name) => !WATCH_FILES.test(name))) refuse("not-empty")
  fs.chmodSync(options.privateDir, 0o700)
  const privateDir = fs.realpathSync.native(options.privateDir)
  const privateId = identity(fs.statSync(privateDir))

  /** Refuses unless `target` names a file directly in the private folder, outside every protected folder. */
  const checkWritable = (target: string): string => {
    if (isProtected(target)) refuse("protected")
    const resolved = path.resolve(target)
    let parentId: string
    try {
      parentId = identity(fs.statSync(path.dirname(resolved)))
    } catch {
      return refuse("outside")
    }
    if (parentId !== privateId) refuse("outside")
    return path.join(privateDir, path.basename(resolved))
  }
  const privatePath = (name: string): string => {
    if (!PRIVATE_NAME.test(name)) refuse("name")
    return checkWritable(path.join(privateDir, name))
  }

  const gfs: GuardedFs = {
    withFile(file, use) {
      let fd: number
      try {
        fd = fs.openSync(file, "r")
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
        throw error
      }
      try {
        const stats = fs.fstatSync(fd)
        return use({
          ino: stats.ino,
          size: stats.size,
          read(start, limit) {
            const length = Math.min(Math.max(0, stats.size - start), limit ?? Number.MAX_SAFE_INTEGER)
            const buffer = Buffer.alloc(length)
            let done = 0
            while (done < length) {
              const got = fs.readSync(fd, buffer, done, length - done, start + done)
              /* v8 ignore next -- only when the file shrinks while it is read @preserve */
              if (got === 0) break
              done += got
            }
            return buffer.subarray(0, done)
          },
        })
      } finally {
        fs.closeSync(fd)
      }
    },
    readWhole(file) {
      return gfs.withFile(file, (handle) => handle.read(0))
    },
    exists(file) {
      return fs.existsSync(file)
    },
    list(dir) {
      try {
        return fs.readdirSync(dir).sort()
      } catch {
        return []
      }
    },
    open(file, flags) {
      if (flags === "r") return fs.openSync(file, "r")
      const mode = WRITE_FLAGS[flags]
      if (mode === undefined) return refuse("flags")
      const target = checkWritable(file)
      let fd: number
      try {
        fd = fs.openSync(target, mode | fs.constants.O_NOFOLLOW, 0o600)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ELOOP") return refuse("link")
        throw error
      }
      const stats = fs.fstatSync(fd)
      if (!stats.isFile() || stats.nlink !== 1) {
        fs.closeSync(fd)
        refuse("link")
      }
      return fd
    },
    rename(from, to) {
      const source = checkWritable(from)
      const destination = checkWritable(to)
      fs.renameSync(source, destination)
    },
    unlink(file) {
      fs.unlinkSync(checkWritable(file))
    },
    readPrivate(name) {
      const target = privatePath(name)
      let fd: number
      try {
        fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
        return refuse("link")
      }
      try {
        if (!fs.fstatSync(fd).isFile()) refuse("link")
        return fs.readFileSync(fd, "utf8")
      } finally {
        fs.closeSync(fd)
      }
    },
    writePrivate(name, text) {
      const target = privatePath(name)
      const temporary = `${target}.tmp`
      // A leftover temporary file, or a link planted in its place, is removed by its own name (a link's target is
      // never touched), never written through.
      try {
        if (fs.lstatSync(temporary).isSymbolicLink()) fs.unlinkSync(temporary)
        else gfs.unlink(temporary)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
      const fd = gfs.open(temporary, "wx")
      try {
        fs.writeSync(fd, text)
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
      gfs.rename(temporary, target)
    },
    appendPrivate(name, text) {
      const fd = gfs.open(privatePath(name), "a")
      try {
        fs.writeSync(fd, text)
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
    },
  }
  return gfs
}
