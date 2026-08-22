import { describe, expect, it } from "vitest"
import * as fs from "fs"
import * as path from "path"

const packageJson = require(path.resolve(__dirname, "../../../package.json"))
const wrapperPackageJson = require(path.resolve(__dirname, "../../../packages/ouro.bot/package.json"))
const mailboxPackageJson = require(path.resolve(__dirname, "../../../packages/mailbox-ui/package.json"))
const {
  PACKAGE_PAYLOAD_PATH_PREFIXES,
} = require(path.resolve(__dirname, "../../../scripts/package-assets.cjs"))

describe("package metadata", () => {
  it("declares the same Node runtime floor on the CLI and public wrapper", () => {
    expect(wrapperPackageJson.engines?.node).toBe(packageJson.engines.node)
  })

  it("ships the RepairGuide bundle in the npm package", () => {
    expect(packageJson.files).toContain("RepairGuide.ouro/")
  })

  it("uses the deterministic build helper without a skip fallback", () => {
    expect(packageJson.scripts.build).toBe("node scripts/build.cjs")
    expect(packageJson.scripts.build).not.toContain("||")
    expect(packageJson.scripts.build).not.toContain("build skipped")
  })

  it("builds and verifies package assets before npm pack", () => {
    expect(packageJson.scripts["package:verify-assets"]).toBe("node scripts/package-assets.cjs")
    expect(packageJson.scripts.prepack).toContain("npm run build")
    expect(packageJson.scripts.prepack).toContain("npm run package:verify-assets")
  })

  it("keeps package asset verification aligned with npm package files", () => {
    expect([...packageJson.files].sort()).toEqual([
      ...PACKAGE_PAYLOAD_PATH_PREFIXES,
      "changelog.json",
      "npm-shrinkwrap.json",
    ].sort())
  })

  it("gates publish on both packed artifact E2E suites", () => {
    expect(packageJson.scripts["test:e2e:ouro-bot-package"]).toBe("node scripts/ouro-bot-package-e2e.cjs")
    const workflow = fs.readFileSync(path.resolve(__dirname, "../../../.github/workflows/coverage.yml"), "utf8")
    const packageJob = workflow.slice(workflow.indexOf("  package-e2e:"), workflow.indexOf("  publish:"))
    expect(packageJob).toContain("npm run test:e2e:package")
    expect(packageJob).toContain("npm run test:e2e:ouro-bot-package")
    expect(packageJob).toContain("docker build --pull --no-cache --file \"$PACKAGE_ROOT/package/deploy/unraid/Dockerfile\"")
    expect(packageJob).toContain("--tag ouro-butler-package-smoke")
    expect(packageJob).toContain("shrinkwrap.packages[\"\"].version !== expected")
    expect(packageJob).toContain("docker run --rm --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m,mode=1777")
    expect(packageJob).toContain('test "$(id -u)" = 10001')
    expect(packageJob).toContain('test "$(id -g)" = 10001')
    expect(packageJob).toContain('printf "%s" "{}" >"$BW_VERIFY_ROOT/appdata/data.json"')
    expect(packageJob).toContain('BITWARDENCLI_APPDATA_DIR="$BW_VERIFY_ROOT/appdata" bw --version 2>"$BW_VERIFY_ROOT/stderr"')
    expect(packageJob).toContain('test ! -s "$BW_VERIFY_ROOT/stderr"')
    expect(packageJob).toContain('test "$BW_VERSION" = 2026.7.0')
    expect(packageJob).toContain('test ! -e "/home/ouro/.config/Bitwarden CLI"')
    expect(packageJob).not.toContain('$(bw --version)')
  })

  it("keeps current mail parsing fixes while overriding the vulnerable merge implementation", () => {
    expect(packageJson.dependencies.mailparser).toBe("^3.9.15")
    expect(packageJson.overrides["deepmerge-ts"]).toBe("^8.0.1")
  })

  it("keeps the mailbox build tool above the patched Vite floor", () => {
    expect(mailboxPackageJson.devDependencies.vite).toBe("^6.4.3")
  })
})
