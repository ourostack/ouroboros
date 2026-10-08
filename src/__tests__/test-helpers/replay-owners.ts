import type * as FsNamespace from "node:fs"
import { vi } from "vitest"

/**
 * The replay-window checks need root-owned files and the tests are not root: report every file as owned by the uid
 * chosen for its path, through both lstat (directories) and fstat (the window file is opened first, then checked by fd).
 * `fs` must be the test's mocked `node:fs` namespace so its functions can be spied on.
 */
export function mockOwners(fs: typeof FsNamespace, uidFor: (file: string) => number): void {
  const lstat = fs.lstatSync as (f: FsNamespace.PathLike, o?: unknown) => FsNamespace.Stats
  const fstat = fs.fstatSync as (fd: number, o?: unknown) => FsNamespace.Stats
  const open = fs.openSync
  const paths = new Map<number, string>()
  const withUid = (stat: FsNamespace.Stats, uid: number) => Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { uid })
  vi.spyOn(fs, "lstatSync").mockImplementation(((file: FsNamespace.PathLike, options?: unknown) => withUid(lstat(file, options), uidFor(String(file)))) as typeof fs.lstatSync)
  vi.spyOn(fs, "openSync").mockImplementation(((file: FsNamespace.PathLike, flags?: FsNamespace.OpenMode, mode?: FsNamespace.Mode) => {
    const fd = open(file, flags, mode)
    paths.set(fd, String(file))
    return fd
  }) as typeof fs.openSync)
  vi.spyOn(fs, "fstatSync").mockImplementation(((fd: number, options?: unknown) => {
    const stat = fstat(fd, options)
    return paths.has(fd) ? withUid(stat, uidFor(paths.get(fd)!)) : stat
  }) as typeof fs.fstatSync)
}
