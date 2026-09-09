import type * as NodeFs from "node:fs"
import { vi } from "vitest"

export const D004_INODE_A = 11540474050979512n
export const D004_INODE_B = 11540474050979513n

export interface D004Identity {
  dev: bigint
  ino: bigint
}

export function d004IdentityKey(identity: D004Identity): string {
  return `${identity.dev}:${identity.ino}`
}

// Test-only metadata seam. All I/O and native Stats prototypes/mode/size fields
// remain real. Only dev/ino are substituted, with the representation that Node
// returns for the caller's actual bigint option. No guard is replaced.
export function installD004StatMetadata(
  filesystem: Pick<typeof NodeFs, "lstatSync" | "fstatSync">,
  identityFor: (physical: NodeFs.BigIntStats, subject: NodeFs.PathLike | number) => D004Identity | undefined,
): void {
  const lstat = filesystem.lstatSync
  const fstat = filesystem.fstatSync
  const shape = (actual: NodeFs.Stats | NodeFs.BigIntStats, physical: NodeFs.BigIntStats, subject: NodeFs.PathLike | number) => {
    const identity = identityFor(physical, subject)
    if (!identity) return actual
    const bigint = typeof actual.ino === "bigint"
    return Object.assign(Object.create(Object.getPrototypeOf(actual)), actual, {
      dev: bigint ? identity.dev : Number(identity.dev),
      ino: bigint ? identity.ino : Number(identity.ino),
    })
  }
  vi.spyOn(filesystem, "lstatSync").mockImplementation(((file: NodeFs.PathLike, options?: NodeFs.StatOptions) => {
    const actual = lstat(file, options)
    if (!actual) return actual
    const physical = typeof actual.ino === "bigint" ? actual as NodeFs.BigIntStats : lstat(file, { ...options, bigint: true })
    return physical ? shape(actual, physical, file) : actual
  }) as typeof NodeFs.lstatSync)
  vi.spyOn(filesystem, "fstatSync").mockImplementation(((fd: number, options?: NodeFs.StatOptions) => {
    const actual = fstat(fd, options)
    const physical = typeof actual.ino === "bigint" ? actual as NodeFs.BigIntStats : fstat(fd, { ...options, bigint: true })
    return shape(actual, physical, fd)
  }) as typeof NodeFs.fstatSync)
}
