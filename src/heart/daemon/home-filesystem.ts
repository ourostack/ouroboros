import * as fs from "fs"
import * as path from "path"
import { emitNervesEvent } from "../../nerves/runtime"

/**
 * Linux `statfs` magic numbers for filesystems that cannot hold `~/.ouro-cli`:
 * no Unix sockets (the daemon's `listen` fails with EPERM), no symlinks (the
 * `CurrentVersion` switch needs them) and no POSIX modes (a 0600 secret file
 * is world-readable). Removable media and appliance data partitions often use them.
 */
const UNSUPPORTED_LINUX_FILESYSTEMS: ReadonlyMap<number, string> = new Map([
  [0x4d44, "FAT"],
  [0x2011bab0, "exFAT"],
])

export interface HomeFilesystemDeps {
  platform: NodeJS.Platform
  statfsType: (dir: string) => number
  exists: (dir: string) => boolean
}

const defaultDeps: HomeFilesystemDeps = {
  platform: process.platform,
  statfsType: (dir) => fs.statfsSync(dir).type,
  exists: (dir) => fs.existsSync(dir),
}

function nearestExistingDir(dir: string, exists: (dir: string) => boolean): string {
  let current = path.resolve(dir)
  while (!exists(current)) {
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return current
}

/**
 * Returns a message when `ouroCliHome` (or, before it exists, its nearest
 * existing parent) sits on a filesystem the runtime cannot use, and null
 * otherwise. Read-only: it never writes to the directory it checks.
 */
export function unsupportedHomeFilesystem(ouroCliHome: string, deps: HomeFilesystemDeps = defaultDeps): string | null {
  if (deps.platform !== "linux") return null
  const checkedDir = nearestExistingDir(ouroCliHome, deps.exists)
  let type: number
  try {
    type = deps.statfsType(checkedDir)
  } catch {
    return null
  }
  const filesystem = UNSUPPORTED_LINUX_FILESYSTEMS.get(type)
  if (!filesystem) return null
  const message = `${ouroCliHome} is on ${filesystem}, which has no Unix sockets, symlinks or file permissions. Set HOME to a directory on ext4 or another POSIX filesystem, then run ouro up again.`
  emitNervesEvent({
    level: "error",
    component: "daemon",
    event: "daemon.home_filesystem_unsupported",
    message: "the ouro home is on a filesystem the runtime cannot use",
    meta: { ouroCliHome, checkedDir, filesystem },
  })
  return message
}
