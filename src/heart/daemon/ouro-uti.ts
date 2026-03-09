import { execFileSync } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { getRepoRoot } from "../identity"
import { emitNervesEvent } from "../../nerves/runtime"

const LSREGISTER_PATH =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

const ICON_SIZES = [16, 32, 128, 256, 512]

export interface RegisterOuroBundleUtiDeps {
  platform?: NodeJS.Platform
  homeDir?: string
  repoRoot?: string
  existsSync?: (targetPath: string) => boolean
  mkdirSync?: (targetPath: string, options?: fs.MakeDirectoryOptions) => void
  writeFileSync?: (targetPath: string, data: string, encoding: BufferEncoding) => void
  rmSync?: (targetPath: string, options?: fs.RmOptions) => void
  execFileSync?: (file: string, args: readonly string[]) => void
}

export interface OuroUtiRegistrationResult {
  attempted: boolean
  registered: boolean
  iconInstalled: boolean
  skippedReason?: string
  registrationBundlePath?: string
}

function resolveIconSourcePath(repoRoot: string): string {
  return path.resolve(repoRoot, "..", "ouroboros-website", "public", "images", "ouroboros.png")
}

function buildIconAsset(
  iconSourcePath: string,
  icnsPath: string,
  iconsetDir: string,
  deps: Required<Pick<RegisterOuroBundleUtiDeps, "mkdirSync" | "rmSync" | "execFileSync">>,
): boolean {
  try {
    deps.mkdirSync(iconsetDir, { recursive: true })

    for (const size of ICON_SIZES) {
      const basePng = path.join(iconsetDir, `icon_${size}x${size}.png`)
      const retinaPng = path.join(iconsetDir, `icon_${size}x${size}@2x.png`)
      deps.execFileSync("sips", ["-z", String(size), String(size), iconSourcePath, "--out", basePng])
      deps.execFileSync("sips", ["-z", String(size * 2), String(size * 2), iconSourcePath, "--out", retinaPng])
    }

    deps.execFileSync("iconutil", ["-c", "icns", iconsetDir, "-o", icnsPath])
    deps.rmSync(iconsetDir, { recursive: true, force: true })
    return true
  } catch (error) {
    deps.rmSync(iconsetDir, { recursive: true, force: true })
    emitNervesEvent({
      level: "warn",
      component: "daemon",
      event: "daemon.ouro_uti_icon_error",
      message: "failed building .ouro icon; continuing without custom icon",
      meta: { error: error instanceof Error ? error.message : String(error) },
    })
    return false
  }
}

function buildInfoPlist(iconInstalled: boolean): string {
  const iconTag = iconInstalled ? "\n    <key>CFBundleTypeIconFile</key>\n    <string>ouro</string>" : ""
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>CFBundleIdentifier</key>",
    "  <string>bot.ouro.bundle-registry</string>",
    "  <key>CFBundleName</key>",
    "  <string>Ouro Bundle Registry</string>",
    "  <key>CFBundlePackageType</key>",
    "  <string>APPL</string>",
    "  <key>UTExportedTypeDeclarations</key>",
    "  <array>",
    "    <dict>",
    "      <key>UTTypeIdentifier</key>",
    "      <string>bot.ouro.bundle</string>",
    "      <key>UTTypeConformsTo</key>",
    "      <array>",
    "        <string>public.folder</string>",
    "        <string>com.apple.package</string>",
    "      </array>",
    "      <key>UTTypeTagSpecification</key>",
    "      <dict>",
    "        <key>public.filename-extension</key>",
    "        <array>",
    "          <string>ouro</string>",
    "        </array>",
    "      </dict>",
    "    </dict>",
    "  </array>",
    "  <key>CFBundleDocumentTypes</key>",
    "  <array>",
    "    <dict>",
    "      <key>CFBundleTypeName</key>",
    "      <string>Ouro Agent Bundle</string>",
    "      <key>LSItemContentTypes</key>",
    "      <array>",
    "        <string>bot.ouro.bundle</string>",
    "      </array>",
    "      <key>CFBundleTypeRole</key>",
    "      <string>Editor</string>",
    "      <key>LSTypeIsPackage</key>",
    "      <true/>",
    `      ${iconTag.trim()}`,
    "    </dict>",
    "  </array>",
    "</dict>",
    "</plist>",
    "",
  ]
    .filter((line) => line.length > 0)
    .join("\n")
}

export function registerOuroBundleUti(deps: RegisterOuroBundleUtiDeps = {}): OuroUtiRegistrationResult {
  const platform = deps.platform ?? process.platform
  if (platform !== "darwin") {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.ouro_uti_register_skip",
      message: "skipped .ouro UTI registration on non-macOS platform",
      meta: { platform },
    })
    return {
      attempted: false,
      registered: false,
      iconInstalled: false,
      skippedReason: "non-macos",
    }
  }

  const homeDir = deps.homeDir ?? os.homedir()
  const repoRoot = deps.repoRoot ?? getRepoRoot()
  const existsSync = deps.existsSync ?? fs.existsSync
  const mkdirSync = deps.mkdirSync ?? fs.mkdirSync
  const writeFileSync = deps.writeFileSync ?? fs.writeFileSync
  const rmSync = deps.rmSync ?? fs.rmSync
  const exec = deps.execFileSync ?? ((file: string, args: readonly string[]) => execFileSync(file, args))

  const supportRoot = path.join(homeDir, "Library", "Application Support", "ouro", "uti")
  const appBundlePath = path.join(supportRoot, "OuroBundleRegistry.app")
  const contentsDir = path.join(appBundlePath, "Contents")
  const resourcesDir = path.join(contentsDir, "Resources")
  const plistPath = path.join(contentsDir, "Info.plist")
  const icnsPath = path.join(resourcesDir, "ouro.icns")
  const iconsetDir = path.join(supportRoot, "ouro.iconset")
  const iconSourcePath = resolveIconSourcePath(repoRoot)

  emitNervesEvent({
    component: "daemon",
    event: "daemon.ouro_uti_register_start",
    message: "registering .ouro UTI on macOS",
    meta: { appBundlePath },
  })

  let iconInstalled = false
  try {
    mkdirSync(resourcesDir, { recursive: true })

    if (existsSync(iconSourcePath)) {
      iconInstalled = buildIconAsset(iconSourcePath, icnsPath, iconsetDir, {
        mkdirSync,
        rmSync,
        execFileSync: exec,
      })
    } else {
      emitNervesEvent({
        component: "daemon",
        event: "daemon.ouro_uti_icon_skip",
        message: "icon source image missing; continuing without custom icon",
        meta: { iconSourcePath },
      })
    }

    writeFileSync(plistPath, buildInfoPlist(iconInstalled), "utf-8")
    exec(LSREGISTER_PATH, ["-f", appBundlePath])

    emitNervesEvent({
      component: "daemon",
      event: "daemon.ouro_uti_register_end",
      message: "registered .ouro UTI on macOS",
      meta: { iconInstalled },
    })

    return {
      attempted: true,
      registered: true,
      iconInstalled,
      registrationBundlePath: appBundlePath,
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    emitNervesEvent({
      level: "warn",
      component: "daemon",
      event: "daemon.ouro_uti_register_error",
      message: "failed .ouro UTI registration; continuing non-blocking",
      meta: { reason },
    })
    return {
      attempted: true,
      registered: false,
      iconInstalled,
      skippedReason: reason,
      registrationBundlePath: appBundlePath,
    }
  }
}
