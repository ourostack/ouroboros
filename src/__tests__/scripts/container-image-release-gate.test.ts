import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"

import { describe, expect, it } from "vitest"

const gatePath = join(process.cwd(), "scripts/container-image-release-gate.sh")
const versionRef = "ghcr.io/ourostack/ouroboros-butler:0.1.0-alpha.743"
const shaRef = "ghcr.io/ourostack/ouroboros-butler:sha-0123456789012345678901234567890123456789"
const sharedDigest = `sha256:${"a".repeat(64)}`

function runGate(versionState: string, shaState: string, shaDigest = sharedDigest) {
  const binDir = mkdtempSync(join(tmpdir(), "ouro-container-gate-"))
  const dockerPath = join(binDir, "docker")
  writeFileSync(
    dockerPath,
    `#!/usr/bin/env bash
set -eu
reference=""
for argument in "$@"; do
  case "$argument" in ghcr.io/*) reference="$argument" ;; esac
done
if [ "$reference" = "$MOCK_VERSION_REF" ]; then
  state="$MOCK_VERSION_STATE"
  digest="$MOCK_VERSION_DIGEST"
elif [ "$reference" = "$MOCK_SHA_REF" ]; then
  state="$MOCK_SHA_STATE"
  digest="$MOCK_SHA_DIGEST"
else
  printf 'unexpected reference: %s\\n' "$reference" >&2
  exit 64
fi
case "$state" in
  present)
    case " $* " in
      *" --raw "*) printf '{"schemaVersion":2}\\n' ;;
      *) printf '%s\\n' "$digest" ;;
    esac
    ;;
  absent) printf 'ERROR: %s: not found\\n' "$reference" >&2; exit 1 ;;
  auth) printf 'ERROR: failed to authorize: 401 Unauthorized\\n' >&2; exit 1 ;;
  network) printf 'ERROR: failed to do request: dial tcp: network is unreachable\\n' >&2; exit 1 ;;
  helper) printf 'ERROR: error getting credentials - err: executable file not found in PATH\\n' >&2; exit 1 ;;
  *) printf 'unexpected state: %s\\n' "$state" >&2; exit 64 ;;
esac
`,
    { mode: 0o755 },
  )

  const result = spawnSync(gatePath, [versionRef, shaRef], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      MOCK_VERSION_REF: versionRef,
      MOCK_SHA_REF: shaRef,
      MOCK_VERSION_STATE: versionState,
      MOCK_SHA_STATE: shaState,
      MOCK_VERSION_DIGEST: sharedDigest,
      MOCK_SHA_DIGEST: shaDigest,
    },
  })
  rmSync(binDir, { recursive: true })
  return result
}

function runGateWithReferences(versionReference: string, shaReference: string) {
  const result = spawnSync(gatePath, [versionReference, shaReference], { encoding: "utf8" })
  return result
}

describe("container image release gate", () => {
  it("publishes only when both immutable references are absent", () => {
    const result = runGate("absent", "absent")

    expect(result.status).toBe(0)
    expect(result.stdout).toBe("publish=true\n")
  })

  it("skips an already-published matching version and exact SHA", () => {
    const result = runGate("present", "present")

    expect(result.status).toBe(0)
    expect(result.stdout).toBe(`publish=false\ndigest=${sharedDigest}\n`)
  })

  it.each([
    ["present", "absent"],
    ["absent", "present"],
  ])("rejects partial publication (%s, %s)", (versionState, shaState) => {
    const result = runGate(versionState, shaState)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("partial publication")
  })

  it("rejects immutable references with different digests", () => {
    const result = runGate("present", "present", `sha256:${"b".repeat(64)}`)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("immutable digest mismatch")
  })

  it.each(["auth", "network", "helper"])("fails closed on a %s inspection error", (failure) => {
    const result = runGate(failure, "absent")

    expect(result.status).not.toBe(0)
    expect(result.stdout).not.toContain("publish=true")
    expect(result.stderr).toContain("registry inspection failed")
  })

  it.each([
    ["ghcr.io/ourostack/ouroboros-butler:latest", shaRef],
    ["ghcr.io/ourostack/ouroboros-butler", shaRef],
    [`ghcr.io/ourostack/ouroboros-butler@${sharedDigest}`, shaRef],
    [versionRef, "ghcr.io/ourostack/ouroboros-butler:sha-short"],
    [versionRef, "example.invalid/ouroboros-butler:sha-0123456789012345678901234567890123456789"],
  ])("rejects noncanonical immutable release coordinates before registry access (%s, %s)", (versionReference, shaReference) => {
    const result = runGateWithReferences(versionReference, shaReference)

    expect(result.status).toBe(64)
    expect(result.stderr).toContain("canonical immutable")
  })
})
