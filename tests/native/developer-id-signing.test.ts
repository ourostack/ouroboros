import { execFileSync, spawnSync } from "child_process"
import { createHash } from "crypto"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, truncateSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { dirname, join } from "path"

import { afterEach, describe, expect, it } from "vitest"

const tempRoots: string[] = []

function keychainArtifacts(prefix: string): Set<string> {
  return new Set(readdirSync("/tmp").filter((entry) => entry.startsWith(prefix)))
}

function driverEnvironment(extra: Record<string, string> = {}): Record<string, string> {
  const profile = process.env.OURO_SIGNING_PROFILE_FILE
  return profile ? { ...extra, LLVM_PROFILE_FILE: profile } : extra
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true })
  }
})

function compileDriver(): string {
  const root = mkdtempSync(join(tmpdir(), "ouro-signing-driver-"))
  tempRoots.push(root)
  const output = join(root, "driver")
  execFileSync("/usr/bin/xcrun", [
    "--sdk",
    "macosx",
    "clang",
    "-std=c17",
    "-Wall",
    "-Wextra",
    "-Werror",
    ...(process.env.OURO_SIGNING_PROFILE_FILE
      ? ["-DOURO_NATIVE_COVERAGE", "-fprofile-instr-generate", "-fcoverage-mapping"]
      : []),
    join(process.cwd(), "native", "developer-id-signing", "driver.c"),
    "-framework",
    "Security",
    "-framework",
    "CoreFoundation",
    "-o",
    output,
  ])
  return output
}

function commitment(
  secret: Buffer,
  domain: string,
  transactionId: string,
  attemptId: string,
  pairGenerationId: string,
  nonceBase64: string,
): string {
  const preimage = JSON.stringify({
    attemptId,
    domain,
    nonceBase64,
    pairGenerationId,
    scheme: "sha256-jcs-one-time-nonce-v1",
    transactionId,
    valueUtf8Base64: secret.toString("base64"),
  })
  return createHash("sha256").update(preimage).digest("base64url")
}

function encodeFrame(fields: Buffer[]): Buffer {
  const count = Buffer.alloc(4)
  count.writeUInt32BE(fields.length)
  return Buffer.concat([count, ...fields.flatMap((field) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(field.length)
    return [length, field]
  })])
}

describe.runIf(process.platform === "darwin")("Developer ID signing native driver", () => {
  it("compiles warning-free and exposes the closed effectful contract", () => {
    const executable = compileDriver()
    const result = spawnSync(executable, ["--contract"], { encoding: "utf8", env: driverEnvironment() })

    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      acceptedModes: ["--contract", "--execute"],
      driver: "developer-id-signing",
      frame: { exact: true, maximumFieldBytes: 1048576, requiredFields: 2 },
      nativePlan: "developer-id-signing-native-plan.v1.bin",
      schemaVersion: 1,
      secretTransport: "stdin-only",
      signingAuthority: "workflow-and-native-plan-bound",
      sideEffects: "ephemeral-keychain-asset-signing",
    })
    expect(result.stderr).toBe("")
  })

  it("rejects unknown argv without reading environment secrets", () => {
    const executable = compileDriver()
    const contractWithoutEnvironment = spawnSync(executable, ["--contract"], {
      encoding: "utf8",
      env: driverEnvironment(),
    })
    const contractWithPoisonedEnvironment = spawnSync(executable, ["--contract"], {
      encoding: "utf8",
      env: driverEnvironment({
        DEVELOPER_ID_APPLICATION_P12: "must-not-be-read",
        DEVELOPER_ID_APPLICATION_PASSWORD: "must-not-be-read",
      }),
    })
    const result = spawnSync(executable, ["--sign"], {
      encoding: "utf8",
      env: driverEnvironment({ DEVELOPER_ID_APPLICATION_P12: "must-not-be-read" }),
    })
    const coverageUnknown = process.env.OURO_SIGNING_PROFILE_FILE
      ? spawnSync(executable, ["--coverage-unknown", "0"], { encoding: "utf8", env: driverEnvironment() })
      : null

    expect(result.status).toBe(64)
    expect(result.stdout).toBe("")
    expect(result.stderr).toMatch(/usage:.*--contract.*--execute/i)
    if (coverageUnknown) expect(coverageUnknown.status).toBe(64)
    expect(contractWithPoisonedEnvironment).toMatchObject({
      status: contractWithoutEnvironment.status,
      stdout: contractWithoutEnvironment.stdout,
      stderr: contractWithoutEnvironment.stderr,
    })
    const source = readFileSync(
      join(process.cwd(), "native", "developer-id-signing", "driver.c"),
      "utf8",
    )
    expect(source).not.toMatch(/\b(getenv|secure_getenv|environ)\b/)
    expect(source).toContain("O_RDONLY | O_NOFOLLOW")
    expect(source).toContain("path_matches_descriptor")
    const symbols = execFileSync("/usr/bin/nm", ["-u", executable], { encoding: "utf8" })
    const forbiddenSymbols = process.env.OURO_SIGNING_PROFILE_FILE
      ? /\b(_secure_getenv|_environ|_NSProcessInfo|_execve|_system)\b/
      : /\b(_getenv|_secure_getenv|_environ|_NSProcessInfo|_execve|_system)\b/
    expect(symbols).not.toMatch(forbiddenSymbols)
    expect(symbols).toMatch(/_SecPKCS12Import/)
    expect(symbols).toMatch(/_SecKeychainCreate/)
    expect(symbols).toMatch(/_SecCodeSignerAddSignature/)
    expect(symbols).toMatch(/_setrlimit/)
    expect(symbols).not.toMatch(/_posix_spawn/)
  })

  it("rejects commitment drift before importing an identity", () => {
    const executable = compileDriver()
    const root = dirname(executable)
    mkdirSync(join(root, "assets"))
    writeFileSync(join(root, "asset.c"), "int main(void) { return 0; }\n")
    execFileSync("/usr/bin/xcrun", ["clang", join(root, "asset.c"), "-o", join(root, "assets", "tool")])
    const assets = encodeFrame([
      Buffer.from("assets/tool"),
      Buffer.from("bot.ouro.tool"),
    ])
    writeFileSync(join(root, "developer-id-signing-native-plan.v1.bin"), encodeFrame([
      Buffer.from("transaction-1"),
      Buffer.from("attempt-1"),
      Buffer.from("generation-1"),
      Buffer.from("bm9uY2U="),
      Buffer.from("x".repeat(43)),
      Buffer.from("y".repeat(43)),
      Buffer.from("TEAM123"),
      Buffer.from("Developer ID Application: Test (TEAM123)"),
      assets,
    ]))
    const frame = encodeFrame([
      Buffer.from("synthetic-p12"),
      Buffer.from("synthetic-password"),
    ])
    const rejected = spawnSync(executable, ["--execute"], {
      encoding: "utf8",
      env: driverEnvironment(),
      input: frame,
      cwd: root,
    })
    expect(rejected.status).toBe(65)
    expect(rejected.stdout).toBe("")
    expect(rejected.stderr).toMatch(/signing failed/i)
    const poisoned = spawnSync(executable, ["--execute"], {
      encoding: "utf8",
      env: driverEnvironment({ OURO_DRIVER_FIELD_1: "different", PATH: "/definitely/not/used" }),
      input: frame,
      cwd: root,
    })
    expect(poisoned).toMatchObject({
      status: rejected.status,
      stdout: rejected.stdout,
      stderr: rejected.stderr,
    })
    for (const invalid of [Buffer.alloc(0), frame.subarray(0, frame.length - 1), Buffer.concat([frame, Buffer.from([0])])]) {
      const invalidResult = spawnSync(executable, ["--execute"], { env: driverEnvironment(), input: invalid, cwd: root })
      expect(invalidResult.status).toBe(65)
      expect(invalidResult.stdout).toHaveLength(0)
    }
  })

  it("imports one queued pair, signs the plan-bound asset set, verifies it, and removes the keychain", () => {
    const keychainsBefore = keychainArtifacts("ouro-signing-")
    const executable = compileDriver()
    const root = dirname(executable)
    const password = Buffer.from("Synthetic-Passphrase-9!")
    const team = Buffer.from("TEAM123")
    const commonName = Buffer.from("Developer ID Application: Test (TEAM123)")
    const config = join(root, "openssl.cnf")
    writeFileSync(config, [
      "[req]",
      "distinguished_name=dn",
      "x509_extensions=ext",
      "prompt=no",
      "[dn]",
      "CN=Developer ID Application: Test (TEAM123)",
      "OU=TEAM123",
      "O=Ouro Test",
      "C=US",
      "[ext]",
      "keyUsage=digitalSignature",
      "extendedKeyUsage=codeSigning",
    ].join("\n"))
    const key = join(root, "identity.key")
    const certificate = join(root, "identity.pem")
    const p12 = join(root, "identity.p12")
    execFileSync("/usr/bin/openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-config", config, "-keyout", key, "-out", certificate,
    ], { stdio: "ignore" })
    execFileSync("/usr/bin/openssl", [
      "pkcs12", "-export", "-inkey", key, "-in", certificate, "-out", p12,
      "-passout", `pass:${password.toString()}`,
    ], { stdio: "ignore" })
    mkdirSync(join(root, "assets"))
    const plannedAssets = [
      { path: "assets/control-plane", signingIdentifier: "bot.ouro.control-plane" },
      { path: "assets/unlock-broker", signingIdentifier: "bot.ouro.unlock-broker" },
    ]
    for (const asset of plannedAssets) {
      const source = join(root, `${asset.signingIdentifier}.c`)
      writeFileSync(source, "int main(void) { return 0; }\n")
      execFileSync("/usr/bin/xcrun", ["clang", source, "-o", join(root, asset.path)])
    }

    const p12Base64 = Buffer.from(readFileSync(p12).toString("base64"))
    const transactionId = "transaction-1"
    const attemptId = "attempt-1"
    const generationId = "generation-1"
    const nonceBase64 = "bm9uY2U="
    const planFields = [
      Buffer.from(transactionId),
      Buffer.from(attemptId),
      Buffer.from(generationId),
      Buffer.from(nonceBase64),
      Buffer.from(commitment(p12Base64, "ouro-developer-id-p12-b64-v1", transactionId, attemptId, generationId, nonceBase64)),
      Buffer.from(commitment(password, "ouro-developer-id-p12-password-v1", transactionId, attemptId, generationId, nonceBase64)),
      team,
      commonName,
      encodeFrame(plannedAssets.flatMap((asset) => [
        Buffer.from(asset.path),
        Buffer.from(asset.signingIdentifier),
      ])),
    ]
    const planPath = join(root, "developer-id-signing-native-plan.v1.bin")
    writeFileSync(planPath, encodeFrame(planFields))
    const result = spawnSync(executable, ["--execute"], {
      encoding: "utf8",
      env: driverEnvironment(),
      input: encodeFrame([p12Base64, password]),
      cwd: root,
    })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stderr).toBe("")
    expect(JSON.parse(result.stdout)).toEqual({
      applicationCommonName: commonName.toString(),
      assets: plannedAssets.map((asset) => ({
        path: asset.path,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        signingIdentifier: asset.signingIdentifier,
      })),
      certificateDerSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      ephemeralKeychainRemoved: true,
      schemaVersion: 1,
      secretValuesPersisted: false,
      teamIdentifier: team.toString(),
    })
    for (const asset of plannedAssets) {
      expect(spawnSync("/usr/bin/codesign", ["--verify", "--strict", join(root, asset.path)]).status).toBe(0)
    }
    expect([...keychainArtifacts("ouro-signing-")].filter((path) => !keychainsBefore.has(path))).toEqual([])
    if (process.env.OURO_SIGNING_PROFILE_FILE) {
      writeFileSync(join(root, "coverage-empty-file"), "")
      writeFileSync(join(root, "coverage-oversized-file"), "")
      truncateSync(join(root, "coverage-oversized-file"), 3 * 1024 * 1024)
      const runRejectedPlan = (fields: Buffer[]) => {
        writeFileSync(planPath, encodeFrame(fields))
        expect(spawnSync(executable, ["--execute"], {
          cwd: root,
          env: driverEnvironment(),
          input: encodeFrame([p12Base64, password]),
        }).status).toBe(65)
      }
      runRejectedPlan([Buffer.from("malformed")])
      runRejectedPlan(planFields.map((field, index) => index === 6 ? Buffer.from("not safe") : field))
      runRejectedPlan(planFields.map((field, index) => index === 7 ? Buffer.from("bad\"cn") : field))
      runRejectedPlan(planFields.map((field, index) => index === 8
        ? encodeFrame([Buffer.from("assets/control-plane")])
        : field))
      runRejectedPlan(planFields.map((field, index) => index === 8
        ? encodeFrame([
            Buffer.from("assets/control-plane"), Buffer.from("bot.ouro.one"),
            Buffer.from("assets/control-plane"), Buffer.from("bot.ouro.two"),
          ])
        : field))
      runRejectedPlan(planFields.map((field, index) => index === 8
        ? encodeFrame([Buffer.from("assets/missing"), Buffer.from("bot.ouro.missing")])
        : field))
      runRejectedPlan(planFields.map((field, index) => index === 8
        ? encodeFrame([Buffer.from("assets"), Buffer.from("bot.ouro.directory")])
        : field))
      runRejectedPlan(planFields.map((field, index) => index === 8
        ? encodeFrame([Buffer.from("../asset"), Buffer.from("bot.ouro.invalid")])
        : field))
      writeFileSync(planPath, encodeFrame(planFields))
      expect(spawnSync(executable, ["--coverage-probe"], {
        cwd: root,
        env: driverEnvironment(),
      }).status).toBe(0)
      expect(spawnSync(executable, ["--execute"], {
        cwd: root,
        env: driverEnvironment(),
        input: Buffer.alloc(4 + 2 * (4 + 1048576) + 1),
      }).status).toBe(65)
      let unfaultedOrdinals = 0
      for (let ordinal = 1; ordinal <= 160; ordinal += 1) {
        const faulted = spawnSync(executable, ["--coverage-execute", String(ordinal)], {
          cwd: root,
          env: driverEnvironment(),
          input: encodeFrame([p12Base64, password]),
        })
        if (faulted.status === 0) {
          unfaultedOrdinals += 1
        } else {
          expect(faulted.status).toBe(65)
        }
      }
      expect(unfaultedOrdinals).toBeGreaterThan(0)
    }
  }, 60_000)
})
