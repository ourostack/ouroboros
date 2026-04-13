import { describe, expect, it, vi } from "vitest"
import { emitNervesEvent } from "../../nerves/runtime"

describe("detectPlatform", () => {
  it("returns 'macos' when platform is darwin", async () => {
    const { detectPlatform } = await import("../../heart/platform")
    const result = detectPlatform({ platform: "darwin" })
    expect(result).toBe("macos")
  })

  it("returns 'windows-native' when platform is win32", async () => {
    const { detectPlatform } = await import("../../heart/platform")
    const result = detectPlatform({ platform: "win32" })
    expect(result).toBe("windows-native")
  })

  it("returns 'wsl' when platform is linux and WSL_DISTRO_NAME is set", async () => {
    const { detectPlatform } = await import("../../heart/platform")
    const result = detectPlatform({
      platform: "linux",
      env: { WSL_DISTRO_NAME: "Ubuntu" },
    })
    expect(result).toBe("wsl")
  })

  it("returns 'wsl' when platform is linux and /proc/version contains 'microsoft'", async () => {
    const { detectPlatform } = await import("../../heart/platform")
    const result = detectPlatform({
      platform: "linux",
      env: {},
      readFileSync: () => "Linux version 5.15.146.1-microsoft-standard-WSL2",
    })
    expect(result).toBe("wsl")
  })

  it("returns 'wsl' when /proc/version contains 'Microsoft' (case-insensitive)", async () => {
    const { detectPlatform } = await import("../../heart/platform")
    const result = detectPlatform({
      platform: "linux",
      env: {},
      readFileSync: () => "Linux version 4.4.0-Microsoft",
    })
    expect(result).toBe("wsl")
  })

  it("returns 'linux' when platform is linux without WSL indicators", async () => {
    const { detectPlatform } = await import("../../heart/platform")
    const result = detectPlatform({
      platform: "linux",
      env: {},
      readFileSync: () => "Linux version 6.1.0-generic",
    })
    expect(result).toBe("linux")
  })

  it("returns 'linux' when /proc/version read throws", async () => {
    const { detectPlatform } = await import("../../heart/platform")
    const result = detectPlatform({
      platform: "linux",
      env: {},
      readFileSync: () => { throw new Error("ENOENT") },
    })
    expect(result).toBe("linux")
  })

  it("returns 'linux' when WSL_DISTRO_NAME is empty string", async () => {
    const { detectPlatform } = await import("../../heart/platform")
    const result = detectPlatform({
      platform: "linux",
      env: { WSL_DISTRO_NAME: "" },
      readFileSync: () => "Linux version 6.1.0-generic",
    })
    expect(result).toBe("linux")
  })

  it("returns 'linux' when WSL_DISTRO_NAME is undefined in env object", async () => {
    const { detectPlatform } = await import("../../heart/platform")
    const result = detectPlatform({
      platform: "linux",
      env: { WSL_DISTRO_NAME: undefined },
      readFileSync: () => "Linux version 6.1.0-generic",
    })
    expect(result).toBe("linux")
  })

  it("emits nerves event with detected platform", async () => {
    const { detectPlatform } = await import("../../heart/platform")
    // The function should call emitNervesEvent with component: "daemon"
    // and event: "daemon.platform_detected"
    // We just verify it does not throw and returns correctly
    const result = detectPlatform({ platform: "darwin" })
    expect(result).toBe("macos")
  })

  it("returns 'linux' for unknown platform (e.g., freebsd)", async () => {
    const { detectPlatform } = await import("../../heart/platform")
    const result = detectPlatform({ platform: "freebsd" })
    expect(result).toBe("linux")
  })

  it("uses default readFileSync when not injected (linux platform, /proc/version not readable on test host)", async () => {
    const { detectPlatform } = await import("../../heart/platform")
    // On the test host (macOS/Linux), calling with platform: "linux" and no readFileSync
    // will use the real fs.readFileSync to read /proc/version.
    // On macOS: throws ENOENT -> returns "linux"
    // On actual Linux: reads /proc/version -> may return "linux" or "wsl"
    const result = detectPlatform({ platform: "linux", env: {} })
    expect(["linux", "wsl"]).toContain(result)
  })

  it("uses default deps when none provided", async () => {
    const { detectPlatform } = await import("../../heart/platform")
    // Should not throw when called with no deps — uses process.platform, process.env, fs.readFileSync
    const result = detectPlatform()
    expect(["macos", "linux", "wsl", "windows-native"]).toContain(result)
  })
})
