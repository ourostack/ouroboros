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

  it("hashes the manifest from its one read, so a later failing read cannot turn a present image into an error", () => {
    const result = runGate("second-raw-error", "present")

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

const verifyPath = join(process.cwd(), "scripts/container-post-push-verify.sh")

// Each registry read of a reference takes the next state from its comma-separated sequence (the last one repeats).
function runVerify(versionStates: string, shaStates: string, shaRaw = sharedRaw) {
  const binDir = mkdtempSync(join(tmpdir(), "ouro-container-verify-"))
  writeFileSync(
    join(binDir, "docker"),
    `#!/usr/bin/env bash
set -eu
reference=""
for argument in "$@"; do
  case "$argument" in ghcr.io/*) reference="$argument" ;; esac
done
if [ "$reference" = "$MOCK_VERSION_REF" ]; then key=version; states="$MOCK_VERSION_STATES"; raw="$MOCK_VERSION_RAW"; else key=sha; states="$MOCK_SHA_STATES"; raw="$MOCK_SHA_RAW"; fi
counter="$MOCK_DIR/$key.count"
n=$(cat "$counter" 2>/dev/null || echo 0)
echo $((n + 1)) >"$counter"
IFS=, read -r -a list <<<"$states"
index=$n
[ "$index" -lt "\${#list[@]}" ] || index=$((\${#list[@]} - 1))
case "\${list[$index]}" in
  present) printf '%s' "$raw" ;;
  absent) printf 'ERROR: %s: not found\n' "$reference" >&2; exit 1 ;;
  auth) printf 'ERROR: failed to authorize: 401 Unauthorized\n' >&2; exit 1 ;;
  empty) exit 0 ;;
esac
`,
    { mode: 0o755 },
  )
  const result = spawnSync(verifyPath, [versionRef, shaRef, "3", "0"], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      MOCK_DIR: binDir,
      MOCK_VERSION_REF: versionRef,
      MOCK_SHA_REF: shaRef,
      MOCK_VERSION_STATES: versionStates,
      MOCK_SHA_STATES: shaStates,
      MOCK_VERSION_RAW: sharedRaw,
      MOCK_SHA_RAW: shaRaw,
    },
  })
  rmSync(binDir, { recursive: true })
  return result
}

describe("container post-push verification", () => {
  it.each([
    ["both absent then present", "absent,present", "absent,present"],
    ["partial then present", "present", "absent,present"],
  ])("retries observed absence: %s", (_name, versionStates, shaStates) => {
    const result = runVerify(versionStates, shaStates)

    expect(result.status).toBe(0)
    expect(result.stdout).toBe(`publish=false\ndigest=${sharedDigest}\n`)
  })

  it("fails after the bounded attempts when the references stay absent", () => {
    const result = runVerify("absent", "absent")

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("still not readable after 3 attempts")
  })

  it("fails at once, without retrying, on a digest mismatch", () => {
    const result = runVerify("present", "present", '{"manifests":[{}],"schemaVersion":2}\n')

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("immutable digest mismatch")
    expect(result.stderr).not.toContain("attempt 1/3")
  })

  it.each([["auth"], ["empty"]])("fails at once on a %s inspection", (state) => {
    const result = runVerify(state, "present")

    expect(result.status).not.toBe(0)
    expect(result.stderr).not.toContain("attempt 1/3")
  })
})
