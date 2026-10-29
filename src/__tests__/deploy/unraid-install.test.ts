import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { describe, expect, it } from "vitest"

const ROOT = path.resolve(__dirname, "../../..")
const INSTALLER = path.join(ROOT, "deploy/unraid/install.sh")
const source = fs.readFileSync(INSTALLER, "utf8")

describe("Unraid first-install script", () => {
  it("is valid bash and executable", () => {
    const check = spawnSync("bash", ["-n", INSTALLER], { encoding: "utf8" })
    expect(check.status, check.stderr).toBe(0)
    expect(fs.statSync(INSTALLER).mode & 0o111).not.toBe(0)
  })

  it("prints its header for --help and rejects unknown options before touching the host", () => {
    const help = spawnSync("bash", [INSTALLER, "--help"], { encoding: "utf8" })
    expect(help.status).toBe(0)
    expect(help.stdout).toContain("Ouro Butler installer for Unraid 7.2 or newer.")
    expect(help.stdout).toContain("--vault-server <url>")
    expect(help.stdout).not.toContain("set -euo pipefail")
    const unknown = spawnSync("bash", [INSTALLER, "--frobnicate"], { encoding: "utf8" })
    expect(unknown.status).toBe(1)
    expect(unknown.stderr).toContain("unknown option --frobnicate")
  })

  it("never puts a secret on a command line", () => {
    expect(source).toContain("stty -echo")
    expect(source).toContain('printf \'%s\' "$ANTHROPIC_KEY" | ouro_stdin auth --agent "$AGENT" --provider anthropic --api-key-file /dev/stdin')
    expect(source).toContain('--scope machine --value-file /dev/stdin')
    expect(source).toContain('TOKEN="$BOT_TOKEN" node -e')
    for (const secret of ["ANTHROPIC_KEY", "BOT_TOKEN"]) {
      const uses = source.split("\n").filter((line) => line.includes(`$${secret}`) || line.includes(`\${${secret}`))
      for (const line of uses) expect(line, line).not.toMatch(/--value\s+"|--api-key\s+"|curl /u)
    }
    expect(source).toContain("unset ANTHROPIC_KEY")
    expect(source).toContain("unset BOT_TOKEN")
  })

  it("installs through the upgrade script's fresh contract and the root authority", () => {
    expect(source).toContain('"${UPGRADE[@]}" preflight "$VERSION" --fresh')
    expect(source).toContain('"${UPGRADE[@]}" prepare "$VERSION" --fresh --owner-id "$OWNER_ID"')
    expect(source).toContain('setsid nohup "${UPGRADE[@]}" install "$VERSION"')
    expect(source).toContain('"${UPGRADE[@]}" verify')
    expect(source).toContain('install -d -m 0700 -o 0 -g 0 "$AUTHORITY"')
  })

  it("creates Unraid keys with the Butler's read-only set, plus Docker update for the write key", () => {
    expect(source).toContain('READ_PERMISSIONS="ARRAY:READ_ANY,DASHBOARD:READ_ANY,DISK:READ_ANY,DOCKER:READ_ANY,INFO:READ_ANY,LOGS:READ_ANY,NOTIFICATIONS:READ_ANY,SHARE:READ_ANY,VARS:READ_ANY"')
    expect(source).toContain('create_unraid_key "Butler RO $STAMP" "$READ_PERMISSIONS" unraidReadApiKey')
    expect(source).toContain('create_unraid_key "Butler RW $STAMP" "$READ_PERMISSIONS,DOCKER:UPDATE_ANY" unraidWriteApiKey')
    expect(source).toContain("--key unraidGraphqlUrl --scope machine")
  })

  it("writes a generic house description from the owner's answers and names no particular household", () => {
    expect(source).toContain('write_butler_file "$BUNDLE/house/house.json"')
    expect(source).toContain('write_butler_file "$BUNDLE/house/HOUSE.md"')
    expect(source).not.toMatch(/mendelow|\bAri\b|calibre|PocketBook|8541786263/iu)
  })

  it("is attached to every GitHub release so releases/latest/download/install.sh resolves", () => {
    const workflow = fs.readFileSync(path.join(ROOT, ".github/workflows/coverage.yml"), "utf8")
    const releaseJob = workflow.slice(workflow.indexOf("  github-release:"))
    expect(releaseJob).toContain('gh release create "$TAG" "$TARBALL" deploy/unraid/install.sh')
    expect(source).toContain("https://github.com/ourostack/ouroboros/releases/latest/download/install.sh")
  })
})
