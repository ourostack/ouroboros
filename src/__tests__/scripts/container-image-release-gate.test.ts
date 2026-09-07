import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"

import { describe, expect, it } from "vitest"

const gatePath = join(process.cwd(), "scripts/container-image-release-gate.sh")
const versionRef = "ghcr.io/ourostack/ouroboros-butler:0.1.0-alpha.743"
const shaRef = "ghcr.io/ourostack/ouroboros-butler:sha-0123456789012345678901234567890123456789"
const sharedRaw = '{"manifests":[],"mediaType":"application/vnd.oci.image.index.v1+json","schemaVersion":2}\n'
const sharedDigest = `sha256:${createHash("sha256").update(sharedRaw).digest("hex")}`

function runGate(versionState: string, shaState: string, shaRaw = sharedRaw) {
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
  raw="$MOCK_VERSION_RAW"
elif [ "$reference" = "$MOCK_SHA_REF" ]; then
  state="$MOCK_SHA_STATE"
  raw="$MOCK_SHA_RAW"
else
  printf 'unexpected reference: %s\\n' "$reference" >&2
  exit 64
fi
case "$state" in
  present)
    case " $* " in
      *" --raw "*) printf '%s' "$raw" ;;
      *" --format {{.Manifest.Digest}} "*) printf 'Name: %s\\nMediaType: application/vnd.oci.image.index.v1+json\\n' "$reference"; exit 255 ;;
      *) printf 'unexpected inspection shape: %s\\n' "$*" >&2; exit 64 ;;
    esac
    ;;
  second-raw-error)
    case " $* " in
      *" --raw "*) ;;
      *) printf 'unexpected inspection shape: %s\\n' "$*" >&2; exit 64 ;;
    esac
    if [ ! -f "$MOCK_SECOND_RAW_MARKER" ]; then
      : >"$MOCK_SECOND_RAW_MARKER"
      printf '%s' "$raw"
    else
      printf 'ERROR: second raw inspection failed\\n' >&2
      exit 1
    fi
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
      MOCK_VERSION_RAW: sharedRaw,
      MOCK_SHA_RAW: shaRaw,
      MOCK_SECOND_RAW_MARKER: join(binDir, "second-raw.marker"),
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

  it("skips matching immutable references when old Buildx rejects the Manifest.Digest field", () => {
    const result = runGate("present", "present")

    expect(result.status).toBe(0)
    expect(result.stdout).toBe(`publish=false\ndigest=${sharedDigest}\n`)
  })

  it("fails closed when the digest-fetch inspection fails after the presence probe succeeds", () => {
    const result = runGate("second-raw-error", "absent")
    const output = `${result.stdout}${result.stderr}`

    expect(result.status).not.toBe(0)
    expect(output).toContain("second raw inspection failed")
    expect(output).not.toContain("publish=true")
    expect(output).not.toContain("publish=false")
    expect(output).not.toContain(sharedDigest)
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
    const result = runGate("present", "present", '{"manifests":[{}],"schemaVersion":2}\n')

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
