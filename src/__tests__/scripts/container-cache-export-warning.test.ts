import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

const scriptPath = join(process.cwd(), "scripts/container-cache-export-warning.sh")
const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function warn(log: string) {
  const dir = mkdtempSync(join(tmpdir(), "cache-warning-"))
  tempDirs.push(dir)
  const logPath = join(dir, "build.log")
  writeFileSync(logPath, log)
  return spawnSync(scriptPath, [logPath], { encoding: "utf8" })
}

// Shaped like run 44578021381, where the image push finished (#33) and only the cache export (#35) failed.
const cacheExportFailure = `#33 exporting to image
#33 pushing manifest for ghcr.io/ourostack/ouroboros-butler 4.6s done
#33 DONE 29.9s

#35 exporting to GitHub Actions Cache
#35 sending cache export 17.4s done
#35 ERROR: internal
`

describe("container cache export warning", () => {
  it("warns, without failing, when only the GitHub Actions cache export errored", () => {
    const result = warn(cacheExportFailure)

    expect(result.status).toBe(0)
    expect(result.stdout).toContain("::warning::The GitHub Actions build cache export failed (ERROR: internal)")
  })

  it("stays silent when the cache export succeeded", () => {
    const result = warn("#35 exporting to GitHub Actions Cache\n#35 sending cache export 3.1s done\n#35 DONE 3.4s\n")

    expect(result.status).toBe(0)
    expect(result.stdout).toBe("")
  })

  it("does not report a failure of another build step as a cache export failure", () => {
    const result = warn("#33 exporting to image\n#33 pushing manifest\n#33 ERROR: denied: permission_denied\n#35 exporting to GitHub Actions Cache\n#35 DONE 1s\n")

    expect(result.status).toBe(0)
    expect(result.stdout).toBe("")
  })
})

describe("container publish cache boundary", () => {
  const workflow = readFileSync(".github/workflows/container-publish.yml", "utf8")

  it("ignores only the cache export error and keeps every build attempt otherwise fatal", () => {
    expect(workflow.match(/cache-to: .*ignore-error=true/gu)).toHaveLength(1)
    expect(workflow.match(/^\s+(?!#).*ignore-error/gmu)).toHaveLength(1)
    const lastAttempt = workflow.slice(workflow.indexOf("(attempt 3 of 3)\n        if: steps.retry-3.outcome"))
    expect(lastAttempt.slice(0, lastAttempt.indexOf("uses: docker/build-push-action@v6"))).not.toContain("continue-on-error")
    expect(workflow).toContain("scripts/container-cache-export-warning.sh")
  })
})
