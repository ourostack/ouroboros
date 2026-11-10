import { beforeEach, describe, expect, it, vi } from "vitest"

const nerves = vi.hoisted(() => ({ emit: vi.fn() }))
vi.mock("../../../nerves/runtime", () => ({ emitNervesEvent: nerves.emit }))

import { unsupportedHomeFilesystem, type HomeFilesystemDeps } from "../../../heart/daemon/home-filesystem"

function deps(type: number, existing: string[] = ["/"], platform: NodeJS.Platform = "linux"): HomeFilesystemDeps & { checked: string[] } {
  const checked: string[] = []
  return {
    platform,
    exists: (dir) => existing.includes(dir),
    statfsType: (dir) => { checked.push(dir); return type },
    checked,
  }
}

describe("unsupportedHomeFilesystem", () => {
  beforeEach(() => nerves.emit.mockClear())

  it("refuses an exFAT or FAT home with guidance", () => {
    const exfat = deps(0x2011bab0, ["/userdata/media/ouro/.ouro-cli"])
    expect(unsupportedHomeFilesystem("/userdata/media/ouro/.ouro-cli", exfat)).toBe(
      "/userdata/media/ouro/.ouro-cli is on exFAT, which has no Unix sockets, symlinks or file permissions. Set HOME to a directory on ext4 or another POSIX filesystem, then run ouro up again.",
    )
    expect(nerves.emit).toHaveBeenCalledWith(expect.objectContaining({ level: "error", event: "daemon.home_filesystem_unsupported" }))
    expect(unsupportedHomeFilesystem("/mnt/sd/.ouro-cli", deps(0x4d44, ["/mnt/sd/.ouro-cli"]))).toContain("is on FAT,")
  })

  it("checks the nearest existing parent before the home is created", () => {
    const exfat = deps(0x2011bab0, ["/userdata/media"])
    expect(unsupportedHomeFilesystem("/userdata/media/ouro/.ouro-cli", exfat)).toContain("exFAT")
    expect(exfat.checked).toEqual(["/userdata/media"])
    const nothing = deps(0xef53, [])
    expect(unsupportedHomeFilesystem("/a/b", nothing)).toBeNull()
    expect(nothing.checked).toEqual(["/"])
  })

  it("accepts POSIX filesystems, other platforms and an unreadable statfs", () => {
    expect(unsupportedHomeFilesystem("/home/ouro/.ouro-cli", deps(0xef53, ["/home/ouro/.ouro-cli"]))).toBeNull()
    expect(unsupportedHomeFilesystem("/Volumes/SD/.ouro-cli", deps(0x2011bab0, ["/Volumes/SD/.ouro-cli"], "darwin"))).toBeNull()
    const failing = deps(0, ["/x"])
    failing.statfsType = () => { throw new Error("ENOSYS") }
    expect(unsupportedHomeFilesystem("/x", failing)).toBeNull()
    expect(nerves.emit).not.toHaveBeenCalled()
  })

  it("reads the real filesystem by default without writing to it", () => {
    expect(unsupportedHomeFilesystem("/definitely/not/here/.ouro-cli")).toBeNull()
  })
})
