import { spawnSync } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, describe, expect, it } from "vitest"

const script = path.resolve(__dirname, "../../../scripts/npm-verify-exact-version.sh")
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

// A fake npm: `version` answers come from a queue (an empty one means E404); `versions`, `dist-tags` and
// `config` reads can be made to fail.
function run(options: { versionAnswers?: string[]; listFails?: boolean; listed?: string[]; deadline?: number }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-exact-"))
  dirs.push(dir)
  fs.writeFileSync(path.join(dir, "answers"), (options.versionAnswers ?? []).join("\n"))
  fs.writeFileSync(path.join(dir, "calls"), "")
  fs.writeFileSync(path.join(dir, "npm"), `#!/usr/bin/env bash
echo "$*" >> "${dir}/calls"
case "$1:$3" in
  "view:version")
    next=$(head -n 1 "${dir}/answers")
    sed -i.bak 1d "${dir}/answers"
    if [ -n "$next" ]; then echo "$next"; exit 0; fi
    echo "npm error code E404" >&2
    echo "npm error 404 No match found for version 0.1.0-alpha.9" >&2
    exit 1 ;;
  "view:versions")
    ${options.listFails ? 'echo "npm error network down" >&2; exit 1' : `echo '${JSON.stringify(options.listed ?? ["0.1.0-alpha.8"])}'; exit 0`} ;;
  "view:dist-tags") ${options.listFails ? 'exit 1' : 'echo \'{"latest":"0.1.0-alpha.8"}\''} ;;
  "config:registry") ${options.listFails ? 'exit 1' : 'echo https://registry.npmjs.org/'} ;;
esac
`, { mode: 0o755 })
  const result = spawnSync("bash", [script, "@ouro.bot/cli", "0.1.0-alpha.9"], {
    encoding: "utf8",
    env: { PATH: `${dir}:${process.env.PATH}`, VERSION_DEADLINE_SECONDS: String(options.deadline ?? 2), POLL_INTERVAL_SECONDS: "1" },
  })
  const calls = fs.readFileSync(path.join(dir, "calls"), "utf8").trim().split("\n").filter(Boolean)
  return { ...result, calls }
}

describe("npm-verify-exact-version", () => {
  it("retries E404 and succeeds when the exact version appears before the deadline", () => {
    const result = run({ versionAnswers: ["", "0.1.0-alpha.9"], deadline: 10 })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("serves missing, expected 0.1.0-alpha.9 (npm error code E404); retrying")
    expect(result.stdout).toContain("verified at 0.1.0-alpha.9")
  })

  it("exhausts at the deadline with bounded diagnostics and a failing exit", () => {
    const result = run({ deadline: 2 })
    expect(result.status).toBe(1)
    expect(result.calls.filter((call) => call === "view @ouro.bot/cli@0.1.0-alpha.9 version").length).toBeGreaterThanOrEqual(2)
    expect(result.stdout).toContain("npm error 404 No match found for version 0.1.0-alpha.9")
    expect(result.stdout).toContain("version list: does not include 0.1.0-alpha.9")
    expect(result.stdout).toContain("dist-tags: {\"latest\":\"0.1.0-alpha.8\"}")
    expect(result.stdout).toContain("::error::@ouro.bot/cli@0.1.0-alpha.9 serves missing, expected 0.1.0-alpha.9")
  })

  it("still fails explicitly when every diagnostic read fails", () => {
    const result = run({ deadline: 1, listFails: true })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain("version list read failed: npm error network down")
    expect(result.stdout).toContain("::error::@ouro.bot/cli@0.1.0-alpha.9 serves missing")
  })

  it("reports a version list that includes the version the exact query still cannot read", () => {
    const result = run({ deadline: 1, listed: ["0.1.0-alpha.8", "0.1.0-alpha.9"] })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain("version list: includes 0.1.0-alpha.9")
  })
})
