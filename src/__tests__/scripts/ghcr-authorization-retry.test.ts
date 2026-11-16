import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"

import { afterEach, describe, expect, it } from "vitest"

const retryPath = join(process.cwd(), "scripts/ghcr-authorization-retry.sh")
const denial = "ERROR: failed to push ghcr.io/ourostack/ouroboros-butler: failed to authorize: failed to fetch oauth token: denied: denied"
const permissionDenial = "ERROR: failed to push ghcr.io/ourostack/ouroboros-butler: denied: permission_denied: write_package"
const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// A fake command that prints the next scripted outcome on each call and counts its calls.
function runWithOutcomes(outcomes: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "ghcr-retry-"))
  tempDirs.push(dir)
  const commandPath = join(dir, "registry-command")
  const countPath = join(dir, "count")
  writeFileSync(countPath, "0")
  writeFileSync(
    commandPath,
    `#!/usr/bin/env bash
count=$(( $(cat "${countPath}") + 1 ))
echo "$count" > "${countPath}"
IFS='|' read -r -a outcomes <<<"$MOCK_OUTCOMES"
outcome=\${outcomes[$((count - 1))]}
if [ "$outcome" = ok ]; then echo pushed; exit 0; fi
echo "$outcome" >&2
exit 1
`,
    { mode: 0o755 },
  )
  const result = spawnSync(retryPath, [commandPath], {
    encoding: "utf8",
    env: { ...process.env, MOCK_OUTCOMES: outcomes.join("|"), GHCR_RETRY_DELAYS: "0 0" },
  })
  return { ...result, calls: Number(readFileSync(countPath, "utf8")) }
}

describe("GHCR authorization retry", () => {
  it("retries GHCR's transient denial and succeeds on the third attempt", () => {
    const result = runWithOutcomes([denial, denial, "ok"])

    expect(result.status).toBe(0)
    expect(result.calls).toBe(3)
    expect(result.stdout).toContain("pushed")
    expect(result.stdout).toContain("GHCR denied authorization on attempt 2 of 3")
  })

  it("stops after three denials and keeps the command's failure", () => {
    const result = runWithOutcomes([denial, denial, denial, "ok"])

    expect(result.status).toBe(1)
    expect(result.calls).toBe(3)
  })

  it.each([permissionDenial, "ERROR: failed to solve: process did not complete successfully: exit code 1"])(
    "does not retry any other failure: %s",
    (failure) => {
      const result = runWithOutcomes([failure, "ok"])

      expect(result.status).toBe(1)
      expect(result.calls).toBe(1)
    },
  )

  it("classifies a failed build record by the same denial", () => {
    const dir = mkdtempSync(join(tmpdir(), "ghcr-retry-"))
    tempDirs.push(dir)
    const denied = join(dir, "denied.txt")
    const forbidden = join(dir, "forbidden.txt")
    writeFileSync(denied, `Status:  Error\nError:   Unknown ${denial}\n`)
    writeFileSync(forbidden, `Status:  Error\nError:   Unknown ${permissionDenial}\n`)

    expect(spawnSync(retryPath, ["--is-denial", denied]).status).toBe(0)
    expect(spawnSync(retryPath, ["--is-denial", forbidden]).status).toBe(1)
  })
})
