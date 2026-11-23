import { spawnSync } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, describe, expect, it } from "vitest"

const root = path.resolve(__dirname, "../../..")
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

// A fake npm: `dist-tags` answers come from a queue (the last one repeats); other reads can be made to fail.
function run(options: { latest: string[]; deadline: number; diagnosticsFail?: boolean }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-latest-"))
  dirs.push(dir)
  fs.writeFileSync(path.join(dir, "answers"), options.latest.join("\n"))
  fs.writeFileSync(path.join(dir, "npm"), `#!/usr/bin/env bash
case "$1:$3" in
  "view:dist-tags"|"dist-tag:")
    next=$(head -n 1 "${dir}/answers")
    if [ "$(wc -l < "${dir}/answers")" -gt 0 ]; then sed -i.bak 1d "${dir}/answers"; fi
    [ -z "$next" ] && next=${options.latest[options.latest.length - 1]}
    echo "{\\"latest\\":\\"$next\\"}" ;;
  "view:time") ${options.diagnosticsFail ? 'echo "npm error network down" >&2; exit 1' : 'echo \'{"0.1.0-alpha.9":"2026-01-01T00:00:00Z"}\''} ;;
  *) echo "dist-tags" ;;
esac
`, { mode: 0o755 })
  fs.writeFileSync(path.join(dir, "curl"), `#!/usr/bin/env bash
${options.diagnosticsFail ? 'echo "curl: could not resolve host" >&2; exit 6' : 'echo \'{"latest":"0.1.0-alpha.8"}\' > /tmp/npm-latest-body; echo "HTTP/2 200"; echo "age: 400"'}
`, { mode: 0o755 })
  return spawnSync("bash", [path.join(root, "scripts/npm-verify-latest-tag.sh"), "@ouro.bot/cli", "0.1.0-alpha.9"], {
    cwd: root,
    encoding: "utf8",
    env: { PATH: `${dir}:${process.env.PATH}`, LATEST_DEADLINE_SECONDS: String(options.deadline), POLL_INTERVAL_SECONDS: "1" },
  })
}

describe("npm-verify-latest-tag", () => {
  it("retries while latest reads behind and succeeds once it catches up", () => {
    const result = run({ latest: ["0.1.0-alpha.8", "0.1.0-alpha.9"], deadline: 10 })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("behind 0.1.0-alpha.9, which this run published; retrying")
    expect(result.stdout).toContain("latest reads 0.1.0-alpha.9, at or after 0.1.0-alpha.9")
  })

  it("accepts a later version and never writes a tag", () => {
    const result = run({ latest: ["0.1.0-alpha.12"], deadline: 2 })
    expect(result.status).toBe(0)
    expect(result.stdout).not.toContain("retrying")
  })

  it("exhausts with read-only diagnostics from other read paths and a failing exit", () => {
    const result = run({ latest: ["0.1.0-alpha.8"], deadline: 2 })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain("npm view dist-tags:")
    expect(result.stdout).toContain("dist-tags endpoint: {\"latest\":\"0.1.0-alpha.8\"}")
    expect(result.stdout).toContain("age: 400")
    expect(result.stdout).toContain("latest publish times:")
    expect(result.stdout).toContain("::error::@ouro.bot/cli: latest reads 0.1.0-alpha.8, behind 0.1.0-alpha.9")
  })

  it("still fails explicitly when the diagnostic reads fail", () => {
    const result = run({ latest: ["0.1.0-alpha.8"], deadline: 1, diagnosticsFail: true })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain("dist-tags endpoint read failed: curl: could not resolve host")
    expect(result.stdout).toContain("publish times read failed: npm error network down")
    expect(result.stdout).toContain("::error::@ouro.bot/cli: latest reads 0.1.0-alpha.8")
  })
})
