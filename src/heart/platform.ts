import * as fs from "fs"
import { emitNervesEvent } from "../nerves/runtime"

export type Platform = "macos" | "linux" | "wsl" | "windows-native"

export interface PlatformDeps {
  platform?: string
  env?: Record<string, string | undefined>
  readFileSync?: (path: string) => string
}

export function detectPlatform(deps: PlatformDeps = {}): Platform {
  const platform = deps.platform ?? process.platform
  const env = deps.env ?? process.env
  const readFile = deps.readFileSync ?? ((p: string) => fs.readFileSync(p, "utf-8"))

  let result: Platform

  if (platform === "darwin") {
    result = "macos"
  } else if (platform === "win32") {
    result = "windows-native"
  } else if (platform === "linux") {
    result = detectLinuxOrWsl(env, readFile)
  } else {
    // Unknown platform — treat as linux
    result = "linux"
  }

  emitNervesEvent({
    component: "daemon",
    event: "daemon.platform_detected",
    message: "detected platform",
    meta: { platform, result },
  })

  return result
}

function detectLinuxOrWsl(
  env: Record<string, string | undefined>,
  readFile: (path: string) => string,
): Platform {
  // Primary: WSL_DISTRO_NAME env var
  if (env.WSL_DISTRO_NAME && env.WSL_DISTRO_NAME.length > 0) {
    return "wsl"
  }

  // Fallback: /proc/version containing "microsoft" (case-insensitive)
  try {
    const procVersion = readFile("/proc/version")
    if (/microsoft/i.test(procVersion)) {
      return "wsl"
    }
  } catch {
    // /proc/version not readable — not WSL
  }

  return "linux"
}
