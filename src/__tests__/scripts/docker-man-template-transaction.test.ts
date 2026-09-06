import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const execFileSync = vi.hoisted(() => vi.fn())

vi.mock("node:child_process", () => ({ execFileSync }))

type JournalState = "rollback" | "committing"

interface TransactionRecord {
  schemaVersion: 1
  state: JournalState
  target: { path: string; name: "ouro-butler"; templateUrl: string; icon: string }
  priorTemplate: { present: boolean; bytesBase64: string | null; metadata: { uid: number; gid: number; mode: number } | null }
  priorTemplateDigest: string | null
  targetTemplateDigest: string
  canonicalVersionTag: string
  reviewedManifestDigest: string
  rollbackImageId: string
  targetImageId: string
  jellyfin: JellyfinState
  digest: string
}

interface JellyfinState {
  containerId: string
  imageId: string
  state: "created" | "running" | "paused" | "restarting" | "removing" | "exited" | "dead"
  restartCount: number
}

interface TransactionModule {
  runDockerManTemplateTransactionCli(args: string[], options?: Record<string, unknown>, write?: (text: string) => void): unknown
  prepareDockerManTemplateTransaction(input: Record<string, unknown>, options: Record<string, unknown>): TransactionRecord
  inspectDockerManTemplateTransaction(options: Record<string, unknown>): TransactionRecord | null
  inspectDockerManTemplateTransactionForRecovery(options: Record<string, unknown>): TransactionRecord | null
  inspectCurrentJellyfinState(): JellyfinState
  verifyDockerManTemplateTransactionJellyfin(options: Record<string, unknown>): true
  markDockerManTemplateTransactionCommitting(options: Record<string, unknown>): TransactionRecord
  rollbackDockerManTemplateTransaction(options: Record<string, unknown>): boolean
  commitDockerManTemplateTransaction(proof: Record<string, unknown>, options: Record<string, unknown>): boolean
  decideDockerManTemplateRecovery(record: TransactionRecord, evidence: Record<string, unknown>): string
  isSafeRecoveryTemporaryMetadata(metadata: Record<string, unknown>, expectedUid: number, expectedGid: number): boolean
}

const roots: string[] = []
const image = (character: string) => `sha256:${character.repeat(64)}`
const canonicalVersionTag = "ghcr.io/ourostack/ouroboros-butler:0.1.0-alpha.798"
const templateUrl = "https://raw.githubusercontent.com/ourostack/ouroboros/main/deploy/unraid/sanctuary.xml"
const icon = "https://raw.githubusercontent.com/ourostack/ouroboros/main/assets/ouroboros.png"
const communityAppsEntryPath = "/usr/local/emhttp/plugins/community.applications/include/exec.php"
const communityAppsHelperPath = "/usr/local/emhttp/plugins/community.applications/include/previous_apps_helpers.php"
const jellyfin: JellyfinState = { containerId: "1".repeat(64), imageId: image("9"), state: "running", restartCount: 3 }
const jellyfinFormat = '{"name":{{json .Name}},"containerId":{{json .Id}},"imageId":{{json .Image}},"state":{{json .State.Status}},"restartCount":{{json .RestartCount}}}'

function serveJellyfin(value: Partial<JellyfinState> = jellyfin, name = "/jellyfin") {
  execFileSync.mockReturnValue(`${JSON.stringify({ name, ...value })}\n`)
}

function template(repository = canonicalVersionTag, name = "ouro-butler"): string {
  return [
    "<?xml version=\"1.0\"?>",
    "<Container version=\"2\">",
    `  <Name>${name}</Name>`,
    `  <Repository>${repository}</Repository>`,
    `  <TemplateURL>${templateUrl}</TemplateURL>`,
    `  <Icon>${icon}</Icon>`,
    "  <WebUI/>",
    "</Container>",
    "",
  ].join("\n")
}

const transactionSemanticMarkup = [
  ["Name", "<Name>ouro-butler</Name>"],
  ["Repository", `<Repository>${canonicalVersionTag}</Repository>`],
  ["TemplateURL", `<TemplateURL>${templateUrl}</TemplateURL>`],
  ["Icon", `<Icon>${icon}</Icon>`],
  ["WebUI", "<WebUI/>"],
] as const

const hiddenTransactionSemanticMarkup = transactionSemanticMarkup.flatMap(([name, markup]) => [
  [name, "comment", markup, `<!-- ${markup} -->`],
  [name, "CDATA", markup, `<![CDATA[${markup}]]>`],
  [name, "nested", markup, `<Wrapper>${markup}</Wrapper>`],
] as const)

async function load(): Promise<TransactionModule> {
  return import(pathToFileURL(join(process.cwd(), "deploy/unraid/docker-man-template-transaction.mjs")).href) as Promise<TransactionModule>
}

function fixture(prior: string | null = null) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ouro-dockerman-template-")))
  roots.push(root)
  const templateRoot = join(root, "templates-user")
  const journalRoot = join(root, "custom", "ouro-butler")
  mkdirSync(templateRoot, { recursive: true, mode: 0o700 })
  mkdirSync(journalRoot, { recursive: true, mode: 0o700 })
  chmodSync(templateRoot, 0o700)
  chmodSync(journalRoot, 0o700)
  const sourceTemplatePath = join(root, "staged.xml")
  const targetPath = join(templateRoot, "my-ouro-butler.xml")
  const journalPath = join(journalRoot, "docker-man-template-transaction.json")
  writeFileSync(sourceTemplatePath, template(), { mode: 0o600 })
  chmodSync(sourceTemplatePath, 0o600)
  if (prior !== null) {
    writeFileSync(targetPath, prior, { mode: 0o600 })
    chmodSync(targetPath, 0o600)
  }
  const options = { targetPath, journalPath, expectedUid: process.getuid?.() ?? 0, expectedGid: process.getgid?.() ?? 0 }
  const input = {
    sourceTemplatePath,
    canonicalVersionTag,
    reviewedManifestDigest: image("c"),
    rollbackImageId: image("a"),
    targetImageId: image("b"),
  }
  return { root, templateRoot, customRoot: join(root, "custom"), journalRoot, sourceTemplatePath, targetPath, journalPath, options, input }
}

function temporaryPaths(state: ReturnType<typeof fixture>) {
  return {
    target: join(state.templateRoot, ".my-ouro-butler.xml.ouro-transaction.tmp"),
    journal: join(state.journalRoot, ".docker-man-template-transaction.json.ouro-transaction.tmp"),
  }
}

function finalProof(targetPath: string, stateModel: "previous-apps-inline-v1" | "previous-apps-helper-v1" = "previous-apps-inline-v1") {
  const delegated = stateModel === "previous-apps-helper-v1"
  return {
    container: {
      name: "/ouro-butler",
      imageId: image("b"),
      imageReference: canonicalVersionTag,
      running: true,
      healthy: true,
      autostart: true,
      labels: {
        "net.unraid.docker.managed": "dockerman",
        "net.unraid.docker.icon": icon,
      },
    },
    bundle: { ok: true, data: { parity: "exact", journalState: "absent", ready: true } },
    dockerMan: { templatePath: targetPath, name: "ouro-butler", repository: canonicalVersionTag, templateUrl, icon },
    communityApps: {
      installed: true,
      name: "ouro-butler",
      repository: canonicalVersionTag,
      templateUrl,
      stateModel,
      entryPath: communityAppsEntryPath,
      entryFunction: "previous_apps",
      implementationPath: delegated ? communityAppsHelperPath : communityAppsEntryPath,
      implementationSymbol: delegated ? "PreviousAppsHelpers::collectDockerApplications" : "previous_apps",
    },
    jellyfin: structuredClone(jellyfin),
  }
}

function signedRecord(record: TransactionRecord, mutate: (candidate: any) => void): TransactionRecord {
  const candidate = structuredClone(record)
  mutate(candidate)
  const { digest: _discarded, ...unsigned } = candidate
  return {
    ...unsigned,
    digest: `sha256:${createHash("sha256").update(JSON.stringify(unsigned)).digest("hex")}`,
  } as TransactionRecord
}

function committingInspection() {
  return { ok: true, data: { parity: "exact", journalState: "committing", ready: false } }
}

function readyInspection() {
  return { ok: true, data: { parity: "exact", journalState: "absent", ready: true } }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

beforeEach(() => {
  execFileSync.mockReset()
  serveJellyfin()
})

describe("root-owned DockerMan template transaction", () => {
  it("captures only Jellyfin identity, image, state, and restart count under the journal digest", async () => {
    const transaction = await load()
    const state = fixture("prior-template\n")

    const record = transaction.prepareDockerManTemplateTransaction(state.input, state.options)

    expect(record.jellyfin).toEqual(jellyfin)
    expect(Object.keys(record.jellyfin).sort()).toEqual(["containerId", "imageId", "restartCount", "state"])
    expect(execFileSync).toHaveBeenCalledWith("/usr/bin/docker", ["container", "inspect", "--format", jellyfinFormat, "jellyfin"], { encoding: "utf8", maxBuffer: 65_536, stdio: ["ignore", "pipe", "ignore"] })
    expect(transaction.inspectCurrentJellyfinState()).toEqual(jellyfin)
    expect(transaction.verifyDockerManTemplateTransactionJellyfin(state.options)).toBe(true)
    const output: string[] = []
    transaction.runDockerManTemplateTransactionCli(["jellyfin-status"], state.options, (text) => output.push(text))
    transaction.runDockerManTemplateTransactionCli(["verify-jellyfin"], state.options, (text) => output.push(text))
    expect(output).toEqual([`${JSON.stringify(jellyfin)}\n`, '{"unchanged":true}\n'])

    const absent = fixture("prior-template\n")
    expect(() => transaction.verifyDockerManTemplateTransactionJellyfin(absent.options)).toThrow(/journal is absent/u)
  })

  it.each([
    ["missing container", () => execFileSync.mockImplementation(() => { throw new Error("absent") })],
    ["wrong name", () => serveJellyfin(jellyfin, "/not-jellyfin")],
    ["missing container ID", () => serveJellyfin({ ...jellyfin, containerId: undefined })],
    ["malformed image ID", () => serveJellyfin({ ...jellyfin, imageId: "latest" })],
    ["unknown state", () => serveJellyfin({ ...jellyfin, state: "unknown" as JellyfinState["state"] })],
    ["fractional restart count", () => serveJellyfin({ ...jellyfin, restartCount: 1.5 })],
    ["negative restart count", () => serveJellyfin({ ...jellyfin, restartCount: -1 })],
  ])("fails before creating or changing transaction state when Jellyfin is %s", async (_scenario, arrange) => {
    const transaction = await load()
    const state = fixture("prior-template\n")
    arrange()

    expect(() => transaction.prepareDockerManTemplateTransaction(state.input, state.options)).toThrow(/Jellyfin/u)
    expect(readFileSync(state.targetPath, "utf8")).toBe("prior-template\n")
    expect(existsSync(state.journalPath)).toBe(false)
    expect(existsSync(temporaryPaths(state).target)).toBe(false)
    expect(existsSync(temporaryPaths(state).journal)).toBe(false)
  })

  it("does not create a missing recovery parent when Jellyfin cannot be inspected", async () => {
    const transaction = await load()
    const state = fixture("prior-template\n")
    rmSync(state.journalRoot, { recursive: true })
    serveJellyfin(jellyfin, "/wrong")

    expect(() => transaction.runDockerManTemplateTransactionCli(["recover-status"], state.options, () => undefined)).toThrow(/Jellyfin/u)
    expect(existsSync(state.journalRoot)).toBe(false)
    expect(readFileSync(state.targetPath, "utf8")).toBe("prior-template\n")
  })

  it.each([
    ["container ID", { ...jellyfin, containerId: "2".repeat(64) }],
    ["image ID", { ...jellyfin, imageId: image("8") }],
    ["state", { ...jellyfin, state: "exited" as const }],
    ["restart count", { ...jellyfin, restartCount: 4 }],
  ])("preserves the journal, template, and crash residue when Jellyfin %s changes", async (_field, changed) => {
    const transaction = await load()

    const recovery = fixture("prior-template\n")
    transaction.prepareDockerManTemplateTransaction(recovery.input, recovery.options)
    const recoveryTemporary = temporaryPaths(recovery).target
    writeFileSync(recoveryTemporary, template(), { mode: 0o600 })
    chmodSync(recoveryTemporary, 0o600)
    const recoveryJournal = readFileSync(recovery.journalPath)
    const recoveryTarget = readFileSync(recovery.targetPath)
    serveJellyfin(changed)
    expect(() => transaction.inspectDockerManTemplateTransactionForRecovery(recovery.options)).toThrow(/Jellyfin.*changed/u)
    expect(readFileSync(recovery.journalPath)).toEqual(recoveryJournal)
    expect(readFileSync(recovery.targetPath)).toEqual(recoveryTarget)
    expect(existsSync(recoveryTemporary)).toBe(true)

    serveJellyfin()
    const rollback = fixture("prior-template\n")
    transaction.prepareDockerManTemplateTransaction(rollback.input, rollback.options)
    const rollbackJournal = readFileSync(rollback.journalPath)
    const rollbackTarget = readFileSync(rollback.targetPath)
    serveJellyfin(changed)
    expect(() => transaction.rollbackDockerManTemplateTransaction(rollback.options)).toThrow(/Jellyfin.*changed/u)
    expect(readFileSync(rollback.journalPath)).toEqual(rollbackJournal)
    expect(readFileSync(rollback.targetPath)).toEqual(rollbackTarget)

    serveJellyfin()
    const marking = fixture("prior-template\n")
    transaction.prepareDockerManTemplateTransaction(marking.input, marking.options)
    const markingJournal = readFileSync(marking.journalPath)
    const markingTarget = readFileSync(marking.targetPath)
    serveJellyfin(changed)
    expect(() => transaction.markDockerManTemplateTransactionCommitting(marking.options)).toThrow(/Jellyfin.*changed/u)
    expect(readFileSync(marking.journalPath)).toEqual(markingJournal)
    expect(readFileSync(marking.targetPath)).toEqual(markingTarget)

    serveJellyfin()
    const commit = fixture("prior-template\n")
    transaction.prepareDockerManTemplateTransaction(commit.input, commit.options)
    transaction.markDockerManTemplateTransactionCommitting(commit.options)
    const commitJournal = readFileSync(commit.journalPath)
    const commitTarget = readFileSync(commit.targetPath)
    serveJellyfin(changed)
    expect(() => transaction.commitDockerManTemplateTransaction(finalProof(commit.targetPath), commit.options)).toThrow(/Jellyfin.*changed/u)
    expect(readFileSync(commit.journalPath)).toEqual(commitJournal)
    expect(readFileSync(commit.targetPath)).toEqual(commitTarget)
  })

  it("rejects a repeated prepare if Jellyfin changed after the durable checkpoint", async () => {
    const transaction = await load()
    const state = fixture("prior-template\n")
    transaction.prepareDockerManTemplateTransaction(state.input, state.options)
    const journalBefore = readFileSync(state.journalPath)
    const targetBefore = readFileSync(state.targetPath)
    serveJellyfin({ ...jellyfin, restartCount: jellyfin.restartCount + 1 })

    expect(() => transaction.prepareDockerManTemplateTransaction(state.input, state.options)).toThrow(/pending template transaction/u)
    expect(readFileSync(state.journalPath)).toEqual(journalBefore)
    expect(readFileSync(state.targetPath)).toEqual(targetBefore)
  })
  it("rejects a truncated source before creating a journal or replacing the template", async () => {
    const transaction = await load()
    const state = fixture("prior-template\n")
    writeFileSync(state.sourceTemplatePath, template().replace("</Container>", ""), { mode: 0o600 })

    expect(() => transaction.prepareDockerManTemplateTransaction(state.input, state.options)).toThrow(/canonical DockerMan XML structure/u)
    expect(readFileSync(state.targetPath, "utf8")).toBe("prior-template\n")
    expect(existsSync(state.journalPath)).toBe(false)
    expect(existsSync(temporaryPaths(state).target)).toBe(false)
    expect(existsSync(temporaryPaths(state).journal)).toBe(false)
  })

  it.each(hiddenTransactionSemanticMarkup)("does not accept %s markup hidden in %s as transaction identity", async (_name, _disguise, markup, replacement) => {
    const transaction = await load()
    const state = fixture("prior-template\n")
    writeFileSync(state.sourceTemplatePath, template().replace(markup, replacement), { mode: 0o600 })

    expect(() => transaction.prepareDockerManTemplateTransaction(state.input, state.options)).toThrow(/canonical DockerMan XML structure/u)
    expect(readFileSync(state.targetPath, "utf8")).toBe("prior-template\n")
    expect(existsSync(state.journalPath)).toBe(false)
    expect(existsSync(temporaryPaths(state).target)).toBe(false)
    expect(existsSync(temporaryPaths(state).journal)).toBe(false)
  })

  it("requires Container itself to be the transaction template root", async () => {
    const transaction = await load()
    const state = fixture("prior-template\n")
    writeFileSync(state.sourceTemplatePath, template().replace("<Container version=\"2\">", "<Wrapper><Container version=\"2\">").replace("</Container>", "</Container></Wrapper>"), { mode: 0o600 })

    expect(() => transaction.prepareDockerManTemplateTransaction(state.input, state.options)).toThrow(/canonical DockerMan XML structure/u)
    expect(readFileSync(state.targetPath, "utf8")).toBe("prior-template\n")
    expect(existsSync(state.journalPath)).toBe(false)
  })

  it("fatally rejects invalid UTF-8 before any transaction mutation", async () => {
    const transaction = await load()
    const state = fixture("prior-template\n")
    const marker = "INVALID-BYTE"
    const source = Buffer.from(template().replace("<Name>", `<!-- ${marker} -->\n  <Name>`))
    source[source.indexOf(marker) + 1] = 0xFF
    writeFileSync(state.sourceTemplatePath, source, { mode: 0o600 })

    expect(() => transaction.prepareDockerManTemplateTransaction(state.input, state.options)).toThrow(/canonical DockerMan XML structure/u)
    expect(readFileSync(state.targetPath, "utf8")).toBe("prior-template\n")
    expect(existsSync(state.journalPath)).toBe(false)
    expect(existsSync(temporaryPaths(state).target)).toBe(false)
    expect(existsSync(temporaryPaths(state).journal)).toBe(false)
  })

  it("runs CLI prepare validation before creating a fresh journal parent", async () => {
    const transaction = await load()
    const state = fixture("prior-template\n")
    writeFileSync(state.sourceTemplatePath, template().replace("</Container>", ""), { mode: 0o600 })
    rmSync(state.journalRoot, { recursive: true })
    chmodSync(state.customRoot, 0o700)
    const entriesBefore = readdirSync(state.root, { recursive: true }).sort()

    expect(() => transaction.runDockerManTemplateTransactionCli([
      "prepare",
      "--source-template", state.sourceTemplatePath,
      "--version-tag", canonicalVersionTag,
      "--manifest-digest", image("c"),
      "--rollback-image-id", image("a"),
      "--target-image-id", image("b"),
    ], state.options, () => undefined)).toThrow(/canonical DockerMan XML structure/u)
    expect(readdirSync(state.root, { recursive: true }).sort()).toEqual(entriesBefore)
    expect(existsSync(state.journalRoot)).toBe(false)
    expect(existsSync(state.journalPath)).toBe(false)
    expect(existsSync(temporaryPaths(state).target)).toBe(false)
    expect(existsSync(temporaryPaths(state).journal)).toBe(false)
    expect(readFileSync(state.targetPath, "utf8")).toBe("prior-template\n")
  })

  it.each([
    ["wrong-mode", (state: ReturnType<typeof fixture>) => chmodSync(state.targetPath, 0o644)],
    ["symlink", (state: ReturnType<typeof fixture>) => { rmSync(state.targetPath); symlinkSync(state.sourceTemplatePath, state.targetPath) }],
  ])("validates an existing %s target before creating a fresh journal parent", async (_shape, makeUnsafe) => {
    const transaction = await load()
    const state = fixture("prior-template\n")
    rmSync(state.journalRoot, { recursive: true })
    chmodSync(state.customRoot, 0o700)
    makeUnsafe(state)

    expect(() => transaction.runDockerManTemplateTransactionCli([
      "prepare",
      "--source-template", state.sourceTemplatePath,
      "--version-tag", canonicalVersionTag,
      "--manifest-digest", image("c"),
      "--rollback-image-id", image("a"),
      "--target-image-id", image("b"),
    ], state.options, () => undefined)).toThrow(/DockerMan template metadata/u)
    expect(existsSync(state.journalRoot)).toBe(false)
  })

  it("creates a fresh journal parent only after CLI validation and installs the retained bytes", async () => {
    const transaction = await load()
    const state = fixture("prior-template\n")
    const original = readFileSync(state.sourceTemplatePath)
    rmSync(state.journalRoot, { recursive: true })
    chmodSync(state.customRoot, 0o700)
    const output: string[] = []

    transaction.runDockerManTemplateTransactionCli([
      "prepare",
      "--source-template", state.sourceTemplatePath,
      "--version-tag", canonicalVersionTag,
      "--manifest-digest", image("c"),
      "--rollback-image-id", image("a"),
      "--target-image-id", image("b"),
    ], {
      ...state.options,
      checkpoint: (point: string) => {
        if (point === "after-template-journal") writeFileSync(state.sourceTemplatePath, "changed after validation\n", { mode: 0o600 })
      },
    }, (text) => output.push(text))

    expect(lstatSync(state.journalRoot).mode & 0o777).toBe(0o700)
    expect(readFileSync(state.targetPath)).toEqual(original)
    expect(existsSync(state.journalPath)).toBe(true)
    expect(output.join("")).toContain('"state":"rollback"')
  })

  it.each([
    ["unknown"],
    ["status", "--unexpected", "value"],
  ])("does not create a journal parent for an invalid CLI operation shape: %s", async (...args) => {
    const transaction = await load()
    const state = fixture("prior-template\n")
    rmSync(state.journalRoot, { recursive: true })
    chmodSync(state.customRoot, 0o700)

    expect(() => transaction.runDockerManTemplateTransactionCli(args, state.options, () => undefined)).toThrow(/Usage/u)
    expect(existsSync(state.journalRoot)).toBe(false)
    expect(readFileSync(state.targetPath, "utf8")).toBe("prior-template\n")
  })

  it("installs canonical version-tagged bytes only after a durable complete rollback record", async () => {
    const transaction = await load()
    const state = fixture("prior-template\n")

    const record = transaction.prepareDockerManTemplateTransaction(state.input, state.options)

    expect(record).toMatchObject({
      schemaVersion: 1,
      state: "rollback",
      target: { path: state.targetPath, name: "ouro-butler", templateUrl, icon },
      priorTemplate: {
        present: true,
        bytesBase64: Buffer.from("prior-template\n").toString("base64"),
        metadata: { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0, mode: 0o600 },
      },
      canonicalVersionTag,
      reviewedManifestDigest: image("c"),
      rollbackImageId: image("a"),
      targetImageId: image("b"),
    })
    expect(record.priorTemplateDigest).toMatch(/^sha256:[0-9a-f]{64}$/u)
    expect(record.targetTemplateDigest).toMatch(/^sha256:[0-9a-f]{64}$/u)
    expect(record.digest).toMatch(/^sha256:[0-9a-f]{64}$/u)
    expect(readFileSync(state.targetPath, "utf8")).toBe(template())
    expect(lstatSync(state.targetPath).mode & 0o777).toBe(0o600)
    expect(lstatSync(state.journalPath).mode & 0o777).toBe(0o600)
    expect(transaction.inspectDockerManTemplateTransaction(state.options)).toEqual(record)
    expect(transaction.prepareDockerManTemplateTransaction(state.input, state.options)).toEqual(record)
    expect(Array.from(new Set([readFileSync(state.journalPath, "utf8")]))).toHaveLength(1)
  })

  it("restores exact prior bytes and metadata, including an explicitly absent prior template", async () => {
    const transaction = await load()
    const present = fixture("prior-template\n")
    transaction.prepareDockerManTemplateTransaction(present.input, present.options)
    expect(transaction.rollbackDockerManTemplateTransaction(present.options)).toBe(true)
    expect(readFileSync(present.targetPath, "utf8")).toBe("prior-template\n")
    expect(lstatSync(present.targetPath).mode & 0o777).toBe(0o600)
    expect(transaction.inspectDockerManTemplateTransaction(present.options)).toBeNull()

    const absent = fixture()
    transaction.prepareDockerManTemplateTransaction(absent.input, absent.options)
    expect(transaction.rollbackDockerManTemplateTransaction(absent.options)).toBe(true)
    expect(() => lstatSync(absent.targetPath)).toThrow()
    expect(transaction.inspectDockerManTemplateTransaction(absent.options)).toBeNull()
  })

  it("repeats an interrupted restoration and commits only after every exact final proof", async () => {
    const transaction = await load()
    const state = fixture("prior-template\n")
    transaction.prepareDockerManTemplateTransaction(state.input, state.options)
    writeFileSync(state.targetPath, "prior-template\n", { mode: 0o600 })
    expect(transaction.rollbackDockerManTemplateTransaction(state.options)).toBe(true)
    expect(transaction.rollbackDockerManTemplateTransaction(state.options)).toBe(false)

    transaction.prepareDockerManTemplateTransaction(state.input, state.options)
    expect(transaction.markDockerManTemplateTransactionCommitting(state.options).state).toBe("committing")
    expect(transaction.markDockerManTemplateTransactionCommitting(state.options).state).toBe("committing")
    expect(transaction.commitDockerManTemplateTransaction(finalProof(state.targetPath), state.options)).toBe(true)
    expect(transaction.commitDockerManTemplateTransaction(finalProof(state.targetPath), state.options)).toBe(false)
    expect(readFileSync(state.targetPath, "utf8")).toBe(template())
  })

  it.each(["previous-apps-inline-v1", "previous-apps-helper-v1"] as const)("accepts only the closed %s Community Apps implementation proof", async (stateModel) => {
    const transaction = await load()
    const state = fixture("prior-template\n")
    transaction.prepareDockerManTemplateTransaction(state.input, state.options)
    transaction.markDockerManTemplateTransactionCommitting(state.options)

    expect(transaction.commitDockerManTemplateTransaction(finalProof(state.targetPath, stateModel), state.options)).toBe(true)
  })

  it("fails closed on incomplete final proofs and never accepts a Docker WebUI label", async () => {
    const transaction = await load()
    for (const mutate of [
      (proof: any) => { delete proof.container.name },
      (proof: any) => { proof.container.imageId = image("d") },
      (proof: any) => { proof.container.imageReference = "ghcr.io/ourostack/ouroboros-butler:latest" },
      (proof: any) => { proof.container.running = false },
      (proof: any) => { proof.container.healthy = false },
      (proof: any) => { proof.container.autostart = false },
      (proof: any) => { proof.container.labels["net.unraid.docker.managed"] = "composeman" },
      (proof: any) => { proof.container.labels["net.unraid.docker.icon"] = "https://example.invalid/icon.png" },
      (proof: any) => { proof.container.labels["net.unraid.docker.webui"] = "http://localhost" },
      (proof: any) => { proof.bundle.data.ready = false },
      (proof: any) => { proof.bundle.data.journalState = "committing" },
      (proof: any) => { proof.dockerMan.templatePath += ".other" },
      (proof: any) => { delete proof.dockerMan.name },
      (proof: any) => { delete proof.dockerMan.repository },
      (proof: any) => { delete proof.dockerMan.templateUrl },
      (proof: any) => { delete proof.dockerMan.icon },
      (proof: any) => { proof.communityApps.installed = false },
      (proof: any) => { delete proof.communityApps.name },
      (proof: any) => { proof.communityApps.repository = "ghcr.io/ourostack/ouroboros-butler:stale" },
      (proof: any) => { delete proof.communityApps.templateUrl },
      (proof: any) => { delete proof.communityApps.stateModel },
      (proof: any) => { proof.communityApps.stateModel = "derived-correlation" },
      (proof: any) => { proof.communityApps.stateModel = "previous-apps-helper-v1" },
      (proof: any) => { proof.communityApps.entryFunction = "invented_query" },
      (proof: any) => { proof.communityApps.entryPath = "/tmp/pretend.php" },
      (proof: any) => { proof.communityApps.implementationSymbol = "PreviousAppsHelpers::collectDockerApplications" },
      (proof: any) => { proof.communityApps.implementationPath = communityAppsHelperPath },
      (proof: any) => { delete proof.jellyfin },
      (proof: any) => { proof.jellyfin.restartCount += 1 },
    ]) {
      const state = fixture("prior-template\n")
      transaction.prepareDockerManTemplateTransaction(state.input, state.options)
      transaction.markDockerManTemplateTransactionCommitting(state.options)
      const proof = finalProof(state.targetPath)
      mutate(proof)
      expect(() => transaction.commitDockerManTemplateTransaction(proof, state.options)).toThrow(/proof|install|container|bundle|DockerMan|Community Apps/u)
      expect(transaction.inspectDockerManTemplateTransaction(state.options)?.state).toBe("committing")
    }
  })

  it("maps only the reviewed crash topologies and never rolls back a committing bundle", async () => {
    const transaction = await load()
    const state = fixture()
    const rollback = transaction.prepareDockerManTemplateTransaction(state.input, state.options)
    const committing = transaction.markDockerManTemplateTransactionCommitting(state.options)

    expect(transaction.decideDockerManTemplateRecovery(rollback, { bundleJournalState: "rollback", production: "rollback-exact" })).toBe("rollback-both")
    expect(transaction.decideDockerManTemplateRecovery(committing, { bundleJournalState: "rollback", production: "rollback-exact" })).toBe("rollback-both")
    expect(transaction.decideDockerManTemplateRecovery(committing, { bundleJournalState: "committing", production: "target-exact-committing", inspection: committingInspection() })).toBe("finish-bundle-commit")
    expect(transaction.decideDockerManTemplateRecovery(committing, { bundleJournalState: "absent", production: "target-exact-ready", inspection: readyInspection() })).toBe("finish-template-commit")
    expect(transaction.decideDockerManTemplateRecovery(rollback, { bundleJournalState: "absent", production: "rollback-exact" })).toBe("restore-prior-template")
    expect(transaction.decideDockerManTemplateRecovery(rollback, { bundleJournalState: "absent", production: "adoption-source-exact" })).toBe("restore-prior-template")
    expect(transaction.decideDockerManTemplateRecovery(rollback, { bundleJournalState: "absent", production: "adoption-target-exact-ready", inspection: readyInspection() })).toBe("roll-forward-adoption")
    expect(transaction.decideDockerManTemplateRecovery(rollback, { bundleJournalState: "absent", production: "adoption-evidence-exact-stopped" })).toBe("quarantine-adoption")
    expect(() => transaction.decideDockerManTemplateRecovery(rollback, { bundleJournalState: "committing", production: "rollback-exact" })).toThrow(/incompatible/u)
    expect(() => transaction.decideDockerManTemplateRecovery(committing, { bundleJournalState: "committing", production: "rollback-exact", inspection: committingInspection() })).toThrow(/incompatible/u)
    expect(() => transaction.decideDockerManTemplateRecovery(committing, { bundleJournalState: "absent", production: "adoption-source-exact" })).toThrow(/incompatible/u)
    expect(() => transaction.decideDockerManTemplateRecovery(committing, { bundleJournalState: "committing", production: "target-exact-committing", inspection: readyInspection() })).toThrow(/inspection/u)
  })

  it("leaves every durable interruption point recoverable and rollback idempotent", async () => {
    const transaction = await load()

    for (const checkpoint of ["after-template-journal", "after-template-replacement"]) {
      const state = fixture("prior-template\n")
      expect(() => transaction.prepareDockerManTemplateTransaction(state.input, {
        ...state.options,
        checkpoint: (point: string) => { if (point === checkpoint) throw new Error(`kill:${point}`) },
      })).toThrow(`kill:${checkpoint}`)
      expect(transaction.inspectDockerManTemplateTransactionForRecovery(state.options)?.state).toBe("rollback")
      expect(transaction.rollbackDockerManTemplateTransaction(state.options)).toBe(true)
      expect(readFileSync(state.targetPath, "utf8")).toBe("prior-template\n")
      expect(transaction.rollbackDockerManTemplateTransaction(state.options)).toBe(false)
    }

    const templateCommitting = fixture("prior-template\n")
    transaction.prepareDockerManTemplateTransaction(templateCommitting.input, templateCommitting.options)
    expect(() => transaction.markDockerManTemplateTransactionCommitting({
      ...templateCommitting.options,
      checkpoint: (point: string) => { if (point === "after-template-committing") throw new Error("kill:after-template-committing") },
    })).toThrow("kill:after-template-committing")
    expect(transaction.inspectDockerManTemplateTransaction(templateCommitting.options)?.state).toBe("committing")
    expect(transaction.rollbackDockerManTemplateTransaction(templateCommitting.options)).toBe(true)
    expect(readFileSync(templateCommitting.targetPath, "utf8")).toBe("prior-template\n")

    const restoration = fixture("prior-template\n")
    transaction.prepareDockerManTemplateTransaction(restoration.input, restoration.options)
    expect(() => transaction.rollbackDockerManTemplateTransaction({
      ...restoration.options,
      checkpoint: (point: string) => { if (point === "after-template-restore") throw new Error("kill:after-template-restore") },
    })).toThrow("kill:after-template-restore")
    expect(readFileSync(restoration.targetPath, "utf8")).toBe("prior-template\n")
    expect(existsSync(restoration.journalPath)).toBe(true)
    expect(transaction.rollbackDockerManTemplateTransaction(restoration.options)).toBe(true)
    expect(transaction.rollbackDockerManTemplateTransaction(restoration.options)).toBe(false)
  })

  it("cleans one safe interrupted atomic write only during recovery and re-enters from authoritative durable state", async () => {
    const transaction = await load()

    const initialJournal = fixture("prior-template\n")
    const initialTemporary = temporaryPaths(initialJournal)
    writeFileSync(initialTemporary.journal, "partial journal", { mode: 0o600 })
    chmodSync(initialTemporary.journal, 0o600)
    expect(() => transaction.inspectDockerManTemplateTransaction(initialJournal.options)).toThrow(/temporary/u)
    const initialIdentityOutput: string[] = []
    transaction.runDockerManTemplateTransactionCli(["recovery-identity"], initialJournal.options, (text) => initialIdentityOutput.push(text))
    expect(initialIdentityOutput).toEqual(["null\n"])
    expect(existsSync(initialTemporary.journal)).toBe(true)
    expect(transaction.inspectDockerManTemplateTransactionForRecovery(initialJournal.options)).toBeNull()
    expect(existsSync(initialTemporary.journal)).toBe(false)
    expect(readFileSync(initialJournal.targetPath, "utf8")).toBe("prior-template\n")

    const templateInstall = fixture("prior-template\n")
    expect(() => transaction.prepareDockerManTemplateTransaction(templateInstall.input, {
      ...templateInstall.options,
      checkpoint: (point: string) => { if (point === "after-template-journal") throw new Error("kill") },
    })).toThrow("kill")
    const installTemporary = temporaryPaths(templateInstall)
    writeFileSync(installTemporary.target, template(), { mode: 0o600 })
    chmodSync(installTemporary.target, 0o600)
    expect(transaction.inspectDockerManTemplateTransactionForRecovery(templateInstall.options)?.state).toBe("rollback")
    expect(transaction.rollbackDockerManTemplateTransaction(templateInstall.options)).toBe(true)
    expect(existsSync(installTemporary.target)).toBe(false)
    expect(readFileSync(templateInstall.targetPath, "utf8")).toBe("prior-template\n")

    const committingJournal = fixture("prior-template\n")
    transaction.prepareDockerManTemplateTransaction(committingJournal.input, committingJournal.options)
    const committingTemporary = temporaryPaths(committingJournal)
    writeFileSync(committingTemporary.journal, readFileSync(committingJournal.journalPath), { mode: 0o600 })
    chmodSync(committingTemporary.journal, 0o600)
    const identityOutput: string[] = []
    transaction.runDockerManTemplateTransactionCli(["recovery-identity"], committingJournal.options, (text) => identityOutput.push(text))
    expect(JSON.parse(identityOutput.join(""))).toMatchObject({ state: "rollback", jellyfin })
    expect(existsSync(committingTemporary.journal)).toBe(true)
    const recoveryOutput: string[] = []
    transaction.runDockerManTemplateTransactionCli(["recover-status"], committingJournal.options, (text) => recoveryOutput.push(text))
    expect(JSON.parse(recoveryOutput.join(""))).toMatchObject({ state: "rollback", jellyfin })
    expect(transaction.rollbackDockerManTemplateTransaction(committingJournal.options)).toBe(true)
    expect(existsSync(committingTemporary.journal)).toBe(false)

    const restoration = fixture("prior-template\n")
    transaction.prepareDockerManTemplateTransaction(restoration.input, restoration.options)
    const restorationTemporary = temporaryPaths(restoration)
    writeFileSync(restorationTemporary.target, "prior-template\n", { mode: 0o600 })
    chmodSync(restorationTemporary.target, 0o600)
    expect(transaction.inspectDockerManTemplateTransactionForRecovery(restoration.options)?.state).toBe("rollback")
    expect(transaction.rollbackDockerManTemplateTransaction(restoration.options)).toBe(true)
    expect(existsSync(restorationTemporary.target)).toBe(false)
    expect(readFileSync(restoration.targetPath, "utf8")).toBe("prior-template\n")
  })

  it("rejects ambiguous or unsafe recovery residue without deleting it", async () => {
    const transaction = await load()

    for (const mutate of [
      (state: ReturnType<typeof fixture>) => { const paths = temporaryPaths(state); writeFileSync(paths.journal, "unsafe", { mode: 0o644 }); chmodSync(paths.journal, 0o644) },
      (state: ReturnType<typeof fixture>) => { const paths = temporaryPaths(state); symlinkSync(state.sourceTemplatePath, paths.journal) },
      (state: ReturnType<typeof fixture>) => { const paths = temporaryPaths(state); writeFileSync(paths.journal, "one", { mode: 0o600 }); chmodSync(paths.journal, 0o600); writeFileSync(paths.target, "two", { mode: 0o600 }); chmodSync(paths.target, 0o600) },
      (state: ReturnType<typeof fixture>) => { const paths = temporaryPaths(state); writeFileSync(paths.target, "orphan", { mode: 0o600 }); chmodSync(paths.target, 0o600) },
    ]) {
      const state = fixture("prior-template\n")
      mutate(state)
      expect(() => transaction.inspectDockerManTemplateTransactionForRecovery(state.options)).toThrow(/temporary|ambiguous/u)
      expect(readFileSync(state.targetPath, "utf8")).toBe("prior-template\n")
    }

    const file = { isFile: () => true, isSymbolicLink: () => false, uid: 501, gid: 20, mode: 0o100600 }
    expect(transaction.isSafeRecoveryTemporaryMetadata(file, 501, 20)).toBe(true)
    expect(transaction.isSafeRecoveryTemporaryMetadata({ ...file, uid: 502 }, 501, 20)).toBe(false)
    expect(transaction.isSafeRecoveryTemporaryMetadata({ ...file, gid: 21 }, 501, 20)).toBe(false)
    expect(transaction.isSafeRecoveryTemporaryMetadata({ ...file, mode: 0o100644 }, 501, 20)).toBe(false)
    expect(transaction.isSafeRecoveryTemporaryMetadata({ ...file, isFile: () => false, isSymbolicLink: () => true }, 501, 20)).toBe(false)
  })

  it("treats dangling journal, target, and source-ancestor symlinks as unsafe existing objects", async () => {
    const transaction = await load()

    const danglingJournal = fixture("prior-template\n")
    symlinkSync(join(danglingJournal.root, "missing-journal"), danglingJournal.journalPath)
    expect(() => transaction.inspectDockerManTemplateTransaction(danglingJournal.options)).toThrow(/journal metadata/u)
    expect(() => transaction.prepareDockerManTemplateTransaction(danglingJournal.input, danglingJournal.options)).toThrow(/journal metadata/u)
    expect(readFileSync(danglingJournal.targetPath, "utf8")).toBe("prior-template\n")

    const danglingTarget = fixture()
    symlinkSync(join(danglingTarget.root, "missing-target"), danglingTarget.targetPath)
    expect(() => transaction.prepareDockerManTemplateTransaction(danglingTarget.input, danglingTarget.options)).toThrow(/DockerMan template metadata/u)
    expect(lstatSync(danglingTarget.targetPath).isSymbolicLink()).toBe(true)

    const interruptedRollback = fixture()
    transaction.prepareDockerManTemplateTransaction(interruptedRollback.input, interruptedRollback.options)
    rmSync(interruptedRollback.targetPath)
    symlinkSync(join(interruptedRollback.root, "missing-restored-target"), interruptedRollback.targetPath)
    expect(() => transaction.rollbackDockerManTemplateTransaction(interruptedRollback.options)).toThrow(/DockerMan template metadata/u)
    expect(lstatSync(interruptedRollback.targetPath).isSymbolicLink()).toBe(true)
    expect(existsSync(interruptedRollback.journalPath)).toBe(true)

    const linkedAncestor = fixture("prior-template\n")
    const realSourceParent = join(linkedAncestor.root, "real-source")
    const linkedSourceParent = join(linkedAncestor.root, "linked-source")
    mkdirSync(realSourceParent, { mode: 0o700 })
    chmodSync(realSourceParent, 0o700)
    writeFileSync(join(realSourceParent, "sanctuary.xml"), template(), { mode: 0o600 })
    symlinkSync(realSourceParent, linkedSourceParent)
    linkedAncestor.input.sourceTemplatePath = join(linkedSourceParent, "sanctuary.xml")
    expect(() => transaction.prepareDockerManTemplateTransaction(linkedAncestor.input, linkedAncestor.options)).toThrow(/transaction parent/u)
    expect(readFileSync(linkedAncestor.targetPath, "utf8")).toBe("prior-template\n")
  })

  it("rejects unsafe paths, duplicate case-folded templates, temporary residue, and malformed records before mutation", async () => {
    const transaction = await load()

    for (const mutate of [
      (state: ReturnType<typeof fixture>) => { const link = join(state.root, "source-link.xml"); symlinkSync(state.sourceTemplatePath, link); state.input.sourceTemplatePath = link },
      (state: ReturnType<typeof fixture>) => writeFileSync(join(state.templateRoot, ".my-ouro-butler.xml.ouro-transaction.tmp"), "residue"),
      (state: ReturnType<typeof fixture>) => writeFileSync(join(state.journalRoot, ".docker-man-template-transaction.json.ouro-transaction.tmp"), "residue"),
      (state: ReturnType<typeof fixture>) => chmodSync(state.templateRoot, 0o755),
    ]) {
      const state = fixture("prior-template\n")
      mutate(state)
      expect(() => transaction.prepareDockerManTemplateTransaction(state.input, state.options)).toThrow()
      expect(readFileSync(state.targetPath, "utf8")).toBe("prior-template\n")
    }

    const collision = fixture()
    const caseFoldedPath = join(collision.templateRoot, "MY-OURO-BUTLER.XML")
    writeFileSync(caseFoldedPath, "collision", { mode: 0o600 })
    expect(() => transaction.prepareDockerManTemplateTransaction(collision.input, collision.options)).toThrow(/case-folded/u)
    expect(readFileSync(caseFoldedPath, "utf8")).toBe("collision")

    for (const [mutate, expected] of [
      [(record: any) => { record.state = "wrong" }, /journal state/u],
      [(record: any) => { record.priorTemplate.bytesBase64 = "not-base64" }, /prior bytes/u],
      [(record: any) => { record.targetImageId = "mutable" }, /release identity/u],
      [(record: any) => { record.canonicalVersionTag = "ghcr.io/ourostack/ouroboros-butler:latest" }, /release identity/u],
      [(record: any) => { record.jellyfin.restartCount = -1 }, /Jellyfin checkpoint/u],
    ]) {
      const state = fixture("prior-template\n")
      const valid = transaction.prepareDockerManTemplateTransaction(state.input, state.options)
      writeFileSync(state.journalPath, `${JSON.stringify(signedRecord(valid, mutate as (candidate: any) => void))}\n`, { mode: 0o600 })
      chmodSync(state.journalPath, 0o600)
      expect(() => transaction.inspectDockerManTemplateTransaction(state.options)).toThrow(expected as RegExp)
      expect(readFileSync(state.targetPath, "utf8")).toBe(template())
    }

    const badDigest = fixture("prior-template\n")
    const valid = transaction.prepareDockerManTemplateTransaction(badDigest.input, badDigest.options)
    writeFileSync(badDigest.journalPath, `${JSON.stringify({ ...valid, digest: image("f") })}\n`, { mode: 0o600 })
    chmodSync(badDigest.journalPath, 0o600)
    expect(() => transaction.inspectDockerManTemplateTransaction(badDigest.options)).toThrow(/journal digest/u)
    expect(readFileSync(badDigest.targetPath, "utf8")).toBe(template())
  })
})
