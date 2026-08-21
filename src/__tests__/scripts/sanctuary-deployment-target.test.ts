import { pathToFileURL } from "node:url"
import path from "node:path"
import fs from "node:fs"

import { describe, expect, it } from "vitest"

type TargetModule = {
  targetProfile(name: string): { name: string; containerName: string }
  attestDeploymentTarget(input: Record<string, unknown>): Record<string, unknown>
  attestOwnedListeners(input: Record<string, unknown>): Record<string, unknown>
  runDeploymentTargetAudit(profile: string, expectedImageId: string, dependencies: Record<string, unknown>): Record<string, unknown>
  captureCanonicalRecords(dependencies: Record<string, unknown>): Record<string, unknown>[]
}

async function load(): Promise<TargetModule> {
  return import(pathToFileURL(path.resolve("deploy/unraid/sanctuary-deployment-target.mjs")).href) as Promise<TargetModule>
}

const imageId = `sha256:${"a".repeat(64)}`
const productionId = "b".repeat(64)
const stagingId = "c".repeat(64)
const rollbackId = "d".repeat(64)

function record(name: string, id: string, running: boolean, autoStart: boolean, image = imageId, restartPolicy = "unless-stopped") {
  return { id, names: [`/${name}`], imageId: image, running, autoStart, restartPolicy, pid: running ? 321 : 0, networkMode: "host" }
}

function input(profile: "staging" | "final") {
  const records = profile === "staging"
    ? [record("ouro-butler-staging", stagingId, true, true)]
    : [record("ouro-butler", productionId, true, true), record("ouro-butler-rollback", rollbackId, false, false)]
  return { profile, expectedImageId: imageId, topologyBefore: records, inspected: records, topologyAfter: records }
}

describe("Sanctuary fixed deployment target", () => {
  it("packages Unit 16 with the fixed staging profile and no caller-selected container", () => {
    const source = fs.readFileSync("deploy/unraid/sanctuary-unit16-run.sh", "utf8")
    expect(source).toContain("TARGET_PROFILE=staging")
    expect(source).toContain("PRODUCTION_CONTAINER=ouro-butler-staging")
    expect(source).toContain('"$TARGET_AUDITOR" "$TARGET_PROFILE" "$IMAGE_ID"')
    expect(source).toContain('"$BROKER_PROGRAM" "$TARGET_PROFILE"')
    expect(source).not.toMatch(/TARGET_CONTAINER=\$\{/u)
  })

  it("packages Unit 18 with a fixed final profile and no caller-selected container", () => {
    const source = fs.readFileSync("deploy/unraid/sanctuary-unit18-target-audit.sh", "utf8")
    expect(source).toContain('/usr/local/bin/node "$AUDITOR" final "$IMAGE_ID"')
    expect(source).not.toContain("$2")
    expect(source).not.toMatch(/TARGET_CONTAINER/u)
  })
  it("maps only packaged staging and final profiles to canonical targets", async () => {
    const { targetProfile } = await load()
    expect(targetProfile("staging")).toMatchObject({ name: "staging", containerName: "ouro-butler-staging" })
    expect(targetProfile("final")).toMatchObject({ name: "final", containerName: "ouro-butler" })
    for (const invalid of ["production", "ouro-butler", "other", ""]) expect(() => targetProfile(invalid)).toThrow(/profile/u)
  })

  it("publishes the same two fixed profiles in the packaged acceptance contract", () => {
    const contract = JSON.parse(fs.readFileSync("deploy/unraid/sanctuary-acceptance-contract.json", "utf8"))
    expect(contract.deploymentTargetProfiles).toEqual({
      staging: { command: "sanctuary-unit16-run.sh", containerName: "ouro-butler-staging", requiredRunning: 1, restartPolicy: "unless-stopped", networkMode: "host", inboundTcpListeners: 0, loopbackTcpControls: [6876] },
      final: { command: "sanctuary-unit18-target-audit.sh", containerName: "ouro-butler", requiredRunning: 1, requiredStopped: "ouro-butler-rollback", restartPolicy: "unless-stopped", networkMode: "host", inboundTcpListeners: 0, loopbackTcpControls: [6876] },
    })
  })

  it("accepts the exact staging topology before production exists and exact final topology", async () => {
    const { attestDeploymentTarget } = await load()
    expect(attestDeploymentTarget(input("staging"))).toMatchObject({ profile: "staging", targetContainerId: stagingId, activeRunningCardinality: 1 })
    expect(attestDeploymentTarget(input("final"))).toMatchObject({ profile: "final", targetContainerId: productionId, activeRunningCardinality: 1 })
  })

  it("binds the live audit to one fixed target PID and stable network namespace", async () => {
    const { runDeploymentTargetAudit } = await load()
    const snapshots = [input("staging").topologyBefore, input("staging").topologyAfter]
    expect(runDeploymentTargetAudit("staging", imageId, {
      captureCanonicalRecords: () => snapshots.shift(),
      readNetns: () => "net:[42]",
      processTree: () => [321],
      ownedSocketInodes: () => ["900"],
      readTcpListeners: () => [],
      readUnixSockets: () => [{ inode: "900", path: "/tmp/ouroboros-daemon.sock" }],
    })).toMatchObject({ deployment: { targetContainerId: stagingId }, listeners: { inboundTcpListenerCount: 0 } })
    expect(snapshots).toHaveLength(0)
  })

  it("pins canonical names to list-time IDs before the single inspect", async () => {
    const { captureCanonicalRecords } = await load()
    const inspectedIds: string[][] = []
    const result = captureCanonicalRecords({
      dockerTopology: () => [{ id: stagingId, name: "ouro-butler-staging" }],
      inspectCanonical: (ids: string[]) => {
        inspectedIds.push(ids)
        return [{ Id: stagingId, Name: "/ouro-butler-staging", Image: imageId, State: { Running: true, Pid: 321 }, HostConfig: { RestartPolicy: { Name: "unless-stopped" }, NetworkMode: "host" } }]
      },
      autostartNames: () => ["ouro-butler-staging"],
    })
    expect(inspectedIds).toEqual([[stagingId]])
    expect(result).toHaveLength(1)
    expect(() => captureCanonicalRecords({
      dockerTopology: () => [{ id: stagingId, name: "ouro-butler-staging" }],
      inspectCanonical: () => [{ Id: stagingId, Name: "/ouro-butler", Image: imageId, State: { Running: true, Pid: 321 }, HostConfig: { RestartPolicy: { Name: "unless-stopped" }, NetworkMode: "host" } }],
      autostartNames: () => ["ouro-butler-staging"],
    })).toThrow(/changed/u)
  })

  it.each([
    ["wrong profile", { profile: "other" }],
    ["wrong target name", { topologyBefore: [record("ouro-butler", productionId, true, true)], inspected: [record("ouro-butler", productionId, true, true)], topologyAfter: [record("ouro-butler", productionId, true, true)] }],
    ["two running", { topologyBefore: [record("ouro-butler-staging", stagingId, true, true), record("ouro-butler", productionId, true, false)], inspected: [record("ouro-butler-staging", stagingId, true, true), record("ouro-butler", productionId, true, false)], topologyAfter: [record("ouro-butler-staging", stagingId, true, true), record("ouro-butler", productionId, true, false)] }],
    ["alias", { topologyBefore: [{ ...record("ouro-butler-staging", stagingId, true, true), names: ["/ouro-butler-staging", "/alias"] }], inspected: [record("ouro-butler-staging", stagingId, true, true)], topologyAfter: [record("ouro-butler-staging", stagingId, true, true)] }],
    ["restart policy drift", { inspected: [record("ouro-butler-staging", stagingId, true, true, imageId, "no")] }],
    ["identity drift", { topologyAfter: [record("ouro-butler-staging", "e".repeat(64), true, true)] }],
    ["duplicate", { topologyBefore: [record("ouro-butler-staging", stagingId, true, true), record("ouro-butler-staging", "e".repeat(64), false, false)], inspected: [record("ouro-butler-staging", stagingId, true, true)], topologyAfter: [record("ouro-butler-staging", stagingId, true, true)] }],
  ])("fails closed for %s", async (_label, mutation) => {
    const { attestDeploymentTarget } = await load()
    expect(() => attestDeploymentTarget({ ...input("staging"), ...mutation })).toThrow()
  })
})

describe("Sanctuary effective listener containment", () => {
  it("accepts a stable target process tree with only Unix control sockets", async () => {
    const { attestOwnedListeners } = await load()
    expect(attestOwnedListeners({ rootPid: 321, netnsBefore: "net:[42]", netnsAfter: "net:[42]", processIds: [321, 322], socketInodes: ["900"], tcpListeners: [], unixSockets: [{ inode: "900", path: "/home/ouro/AgentBundles/sanctuary.ouro/state/acceptance/telegram-control.sock" }] })).toMatchObject({ inboundTcpListenerCount: 0, unixControlSocketCount: 1 })
  })

  it("allows only the documented loopback Mailbox control listener", async () => {
    const { attestOwnedListeners } = await load()
    expect(attestOwnedListeners({ rootPid: 321, netnsBefore: "net:[42]", netnsAfter: "net:[42]", processIds: [321], socketInodes: ["901"], tcpListeners: [{ inode: "901", localAddress: "127.0.0.1", port: 6876 }], unixSockets: [] })).toMatchObject({ inboundTcpListenerCount: 0, loopbackTcpControlCount: 1 })
  })

  it.each([
    ["wildcard", { tcpListeners: [{ inode: "900", localAddress: "0.0.0.0", port: 8080 }] }],
    ["host listener", { tcpListeners: [{ inode: "900", localAddress: "192.168.1.5", port: 8080 }] }],
    ["undocumented loopback", { tcpListeners: [{ inode: "900", localAddress: "127.0.0.1", port: 8080 }] }],
    ["ambiguous owner", { socketInodes: ["900", "900"] }],
    ["netns drift", { netnsAfter: "net:[43]" }],
    ["undocumented Unix socket", { unixSockets: [{ inode: "900", path: "/tmp/other.sock" }] }],
  ])("rejects %s listener state", async (_label, mutation) => {
    const { attestOwnedListeners } = await load()
    const baseline = { rootPid: 321, netnsBefore: "net:[42]", netnsAfter: "net:[42]", processIds: [321], socketInodes: ["900"], tcpListeners: [], unixSockets: [] }
    expect(() => attestOwnedListeners({ ...baseline, ...mutation })).toThrow()
  })
})
