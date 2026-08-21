import { pathToFileURL } from "node:url"
import path from "node:path"
import fs from "node:fs"

import { describe, expect, it } from "vitest"

type TargetModule = {
  targetProfile(name: string): { name: string; containerName: string }
  attestDeploymentTarget(input: Record<string, unknown>): Record<string, unknown>
  attestOwnedListeners(input: Record<string, unknown>): Record<string, unknown>
  runDeploymentTargetAudit(profile: string, expectedImageId: string, dependencies: Record<string, unknown>): Promise<Record<string, unknown>>
  captureCanonicalRecords(dependencies: Record<string, unknown>): Promise<Record<string, unknown>[]>
  parseProcUdp(content: string, ipv6: boolean): Array<{ inode: string; localAddress: string; port: number }>
  parseProcUnix(content: string): Array<{ inode: string; path: string; flags: string; type: string; state: string }>
  cgroupProcessIds(rootPid: number, containerId: string, dependencies: Record<string, unknown>): { path: string; processIds: number[]; threadIds: number[] }
  ownedSocketInodes(threadIds: number[], dependencies?: Record<string, unknown>): string[]
  queryGraphqlAutostart(fetchImpl: typeof fetch, readDescriptor: () => string): Promise<Map<string, { containerId: string; autoStart: boolean }>>
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
      staging: { command: "sanctuary-unit16-run.sh", containerName: "ouro-butler-staging", requiredRunning: 1, restartPolicy: "unless-stopped", networkMode: "host", inboundTcpListeners: 0, inboundUdpListeners: 0, loopbackTcpControls: [6876] },
      final: { command: "sanctuary-unit18-target-audit.sh", containerName: "ouro-butler", requiredRunning: 1, requiredStopped: "ouro-butler-rollback", restartPolicy: "unless-stopped", networkMode: "host", inboundTcpListeners: 0, inboundUdpListeners: 0, loopbackTcpControls: [6876] },
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
    await expect(runDeploymentTargetAudit("staging", imageId, {
      captureCanonicalRecords: () => snapshots.shift(),
      readNetns: () => "net:[42]",
      cgroupProcessIds: () => ({ path: `/docker/${stagingId}`, processIds: [321], threadIds: [321, 401] }),
      ownedSocketInodes: () => ["900"],
      readTcpListeners: () => [],
      readUdpListeners: () => [],
      readUnixSockets: () => [{ inode: "900", path: "/tmp/ouroboros-daemon.sock", flags: "00010000", type: "0001", state: "01" }],
    })).resolves.toMatchObject({ deployment: { targetContainerId: stagingId }, listeners: { inboundTcpListenerCount: 0, inboundUdpListenerCount: 0 } })
    expect(snapshots).toHaveLength(0)
  })

  it("pins canonical names to list-time IDs before the single inspect", async () => {
    const { captureCanonicalRecords } = await load()
    const inspectedIds: string[][] = []
    const result = await captureCanonicalRecords({
      dockerTopology: () => [{ id: stagingId, name: "ouro-butler-staging" }],
      inspectCanonical: (ids: string[]) => {
        inspectedIds.push(ids)
        return [{ Id: stagingId, Name: "/ouro-butler-staging", Image: imageId, State: { Running: true, Pid: 321 }, HostConfig: { RestartPolicy: { Name: "unless-stopped" }, NetworkMode: "host" } }]
      },
      autostartNames: () => ["ouro-butler-staging"],
      graphqlAutostartNames: () => new Map([["ouro-butler-staging", { containerId: stagingId, autoStart: true }]]),
    })
    expect(inspectedIds).toEqual([[stagingId]])
    expect(result).toHaveLength(1)
    await expect(captureCanonicalRecords({
      dockerTopology: () => [{ id: stagingId, name: "ouro-butler-staging" }],
      inspectCanonical: () => [{ Id: stagingId, Name: "/ouro-butler", Image: imageId, State: { Running: true, Pid: 321 }, HostConfig: { RestartPolicy: { Name: "unless-stopped" }, NetworkMode: "host" } }],
      autostartNames: () => ["ouro-butler-staging"],
      graphqlAutostartNames: () => new Map([["ouro-butler-staging", { containerId: stagingId, autoStart: true }]]),
    })).rejects.toThrow(/changed/u)
  })

  it("requires GraphQL and the durable Unraid file to agree on exact autostart identity", async () => {
    const { captureCanonicalRecords } = await load()
    await expect(captureCanonicalRecords({
      dockerTopology: () => [{ id: stagingId, name: "ouro-butler-staging" }],
      inspectCanonical: () => [{ Id: stagingId, Name: "/ouro-butler-staging", Image: imageId, State: { Running: true, Pid: 321 }, HostConfig: { RestartPolicy: { Name: "unless-stopped" }, NetworkMode: "host" } }],
      autostartNames: () => ["ouro-butler-staging"],
      graphqlAutostartNames: () => new Map(),
    })).rejects.toThrow(/autostart|presence/u)
  })

  it("binds the GraphQL autostart record to the exact inspected Docker container ID", async () => {
    const { captureCanonicalRecords } = await load()
    await expect(captureCanonicalRecords({
      dockerTopology: () => [{ id: stagingId, name: "ouro-butler-staging" }],
      inspectCanonical: () => [{ Id: stagingId, Name: "/ouro-butler-staging", Image: imageId, State: { Running: true, Pid: 321 }, HostConfig: { RestartPolicy: { Name: "unless-stopped" }, NetworkMode: "host" } }],
      autostartNames: () => ["ouro-butler-staging"],
      graphqlAutostartNames: () => new Map([["ouro-butler-staging", { containerId: productionId, autoStart: true }]]),
    })).rejects.toThrow(/identity/u)
  })

  it("sends the bounded exact-target GraphQL autostart query with the canonical read descriptor", async () => {
    const { queryGraphqlAutostart } = await load()
    let captured: { input?: RequestInfo | URL; init?: RequestInit } = {}
    const fetchImpl: typeof fetch = async (input, init) => {
      captured = { input, init }
      return new Response(JSON.stringify({ data: { vars: { id: `${"f".repeat(64)}:vars` }, docker: { containers: [{ id: `${"f".repeat(64)}:${stagingId}`, names: ["/ouro-butler-staging"], autoStart: true }] } } }), { status: 200, headers: { "content-type": "application/json" } })
    }
    await expect(queryGraphqlAutostart(fetchImpl, () => "private-descriptor")).resolves.toEqual(new Map([["ouro-butler-staging", { containerId: stagingId, autoStart: true }]]))
    expect(captured.input).toBe("http://127.0.0.1/graphql")
    expect(captured.init).toMatchObject({ method: "POST", headers: { "content-type": "application/json", "x-api-key": "private-descriptor" } })
    expect(JSON.parse(String(captured.init?.body))).toEqual({ query: "query AcceptanceContainerTopology { vars { id } docker { containers(skipCache: true) { id names autoStart } } }", variables: {} })
  })

  it("rejects canonical GraphQL records whose PrefixedID is not from the current Unraid server", async () => {
    const { queryGraphqlAutostart } = await load()
    const serverPrefix = "f".repeat(64)
    const otherPrefix = "e".repeat(64)
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({
      data: {
        vars: { id: `${serverPrefix}:vars` },
        docker: { containers: [{ id: `${otherPrefix}:${stagingId}`, names: ["/ouro-butler-staging"], autoStart: true }] },
      },
    }), { status: 200, headers: { "content-type": "application/json" } })
    await expect(queryGraphqlAutostart(fetchImpl, () => "private-descriptor")).rejects.toThrow(/server|identity/u)
  })

  it("requires GraphQL presence and exact false autostart for the retained rollback", async () => {
    const { captureCanonicalRecords } = await load()
    const finalRecords = [
      { Id: productionId, Name: "/ouro-butler", Image: imageId, State: { Running: true, Pid: 321 }, HostConfig: { RestartPolicy: { Name: "unless-stopped" }, NetworkMode: "host" } },
      { Id: rollbackId, Name: "/ouro-butler-rollback", Image: imageId, State: { Running: false, Pid: 0 }, HostConfig: { RestartPolicy: { Name: "unless-stopped" }, NetworkMode: "host" } },
    ]
    const base = {
      dockerTopology: () => [{ id: productionId, name: "ouro-butler" }, { id: rollbackId, name: "ouro-butler-rollback" }],
      inspectCanonical: () => finalRecords,
      autostartNames: () => ["ouro-butler"],
    }
    await expect(captureCanonicalRecords({ ...base, graphqlAutostartNames: () => new Map([["ouro-butler", { containerId: productionId, autoStart: true }]]) })).rejects.toThrow(/topology|presence/u)
    await expect(captureCanonicalRecords({ ...base, graphqlAutostartNames: () => new Map([
      ["ouro-butler", { containerId: productionId, autoStart: true }],
      ["ouro-butler-rollback", { containerId: rollbackId, autoStart: true }],
    ]) })).rejects.toThrow(/autostart/u)
    await expect(captureCanonicalRecords({ ...base, graphqlAutostartNames: () => new Map([
      ["ouro-butler", { containerId: productionId, autoStart: true }],
      ["ouro-butler-rollback", { containerId: rollbackId, autoStart: false }],
    ]) })).resolves.toHaveLength(2)
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
    const control = { inode: "900", path: "/home/ouro/AgentBundles/sanctuary.ouro/state/acceptance/telegram-control.sock", flags: "00010000", type: "0001", state: "01" }
    expect(attestOwnedListeners({ rootPid: 321, netnsBefore: "net:[42]", netnsAfter: "net:[42]", processIdsBefore: [321, 322], processIdsAfter: [321, 322], socketInodesBefore: ["900"], socketInodesAfter: ["900"], tcpListenersBefore: [], tcpListenersAfter: [], udpListenersBefore: [], udpListenersAfter: [], unixSocketsBefore: [control], unixSocketsAfter: [control] })).toMatchObject({ inboundTcpListenerCount: 0, inboundUdpListenerCount: 0, unixControlSocketCount: 1 })
  })

  it("allows only the documented loopback Mailbox control listener", async () => {
    const { attestOwnedListeners } = await load()
    expect(attestOwnedListeners({ rootPid: 321, netnsBefore: "net:[42]", netnsAfter: "net:[42]", processIdsBefore: [321], processIdsAfter: [321], socketInodesBefore: ["901"], socketInodesAfter: ["901"], tcpListenersBefore: [{ inode: "901", localAddress: "127.0.0.1", port: 6876 }], tcpListenersAfter: [{ inode: "901", localAddress: "127.0.0.1", port: 6876 }], udpListenersBefore: [], udpListenersAfter: [], unixSocketsBefore: [], unixSocketsAfter: [] })).toMatchObject({ inboundTcpListenerCount: 0, loopbackTcpControlCount: 1 })
  })

  it("rejects an owned externally bound UDP listener", async () => {
    const { attestOwnedListeners } = await load()
    const udp = [{ inode: "902", localAddress: "0.0.0.0", port: 5353 }]
    expect(() => attestOwnedListeners({ rootPid: 321, netnsBefore: "net:[42]", netnsAfter: "net:[42]", processIdsBefore: [321], processIdsAfter: [321], socketInodesBefore: ["902"], socketInodesAfter: ["902"], tcpListenersBefore: [], tcpListenersAfter: [], udpListenersBefore: udp, udpListenersAfter: udp, unixSocketsBefore: [], unixSocketsAfter: [] })).toThrow(/UDP/u)
  })

  it("inventories every bound IPv4 UDP socket, including connected sockets", async () => {
    const { attestOwnedListeners, parseProcUdp } = await load()
    const header = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode"
    const bound = "  1: 00000000:14E9 00000000:0000 07 00000000:00000000 00:00000000 00000000  1000 0 902"
    const connected = "  2: 0100007F:C001 08080808:0035 01 00000000:00000000 00:00000000 00000000  1000 0 903"
    const unbound = "  3: 00000000:0000 00000000:0000 07 00000000:00000000 00:00000000 00000000  1000 0 904"
    const parsed = parseProcUdp(`${header}\n${bound}\n${connected}\n${unbound}\n`, false)
    expect(parsed).toEqual([
      { inode: "902", localAddress: "0.0.0.0", port: 5353 },
      { inode: "903", localAddress: "127.0.0.1", port: 49153 },
    ])
    const connectedOnly = parsed.filter(({ inode }) => inode === "903")
    expect(() => attestOwnedListeners({ rootPid: 321, netnsBefore: "net:[42]", netnsAfter: "net:[42]", processIdsBefore: [321], processIdsAfter: [321], socketInodesBefore: ["903"], socketInodesAfter: ["903"], tcpListenersBefore: [], tcpListenersAfter: [], udpListenersBefore: connectedOnly, udpListenersAfter: connectedOnly, unixSocketsBefore: [], unixSocketsAfter: [] })).toThrow(/UDP/u)
  })

  it("inventories connected bound IPv6 UDP sockets", async () => {
    const { attestOwnedListeners, parseProcUdp } = await load()
    const header = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode"
    const connected = "  1: 00000000000000000000000001000000:C001 00000000000000000000000008080808:0035 01 00000000:00000000 00:00000000 00000000  1000 0 905"
    const parsed = parseProcUdp(`${header}\n${connected}\n`, true)
    expect(parsed).toEqual([
      { inode: "905", localAddress: "00000000000000000000000001000000", port: 49153 },
    ])
    expect(() => attestOwnedListeners({ rootPid: 321, netnsBefore: "net:[42]", netnsAfter: "net:[42]", processIdsBefore: [321], processIdsAfter: [321], socketInodesBefore: ["905"], socketInodesAfter: ["905"], tcpListenersBefore: [], tcpListenersAfter: [], udpListenersBefore: parsed, udpListenersAfter: parsed, unixSocketsBefore: [], unixSocketsAfter: [] })).toThrow(/UDP/u)
  })

  it("deduplicates inherited descriptors for the same stable socket inode", async () => {
    const { attestOwnedListeners } = await load()
    expect(attestOwnedListeners({ rootPid: 321, netnsBefore: "net:[42]", netnsAfter: "net:[42]", processIdsBefore: [321, 322], processIdsAfter: [321, 322], socketInodesBefore: ["901", "901"], socketInodesAfter: ["901", "901"], tcpListenersBefore: [{ inode: "901", localAddress: "127.0.0.1", port: 6876 }], tcpListenersAfter: [{ inode: "901", localAddress: "127.0.0.1", port: 6876 }], udpListenersBefore: [], udpListenersAfter: [], unixSocketsBefore: [], unixSocketsAfter: [] })).toMatchObject({ ownedSocketCount: 1, loopbackTcpControlCount: 1 })
  })

  it("rejects listener ownership drift between the bounded before and after inventories", async () => {
    const { attestOwnedListeners } = await load()
    expect(() => attestOwnedListeners({ rootPid: 321, netnsBefore: "net:[42]", netnsAfter: "net:[42]", processIdsBefore: [321], processIdsAfter: [321], socketInodesBefore: ["903"], socketInodesAfter: ["903"], tcpListenersBefore: [{ inode: "903", localAddress: "127.0.0.1", port: 6876 }], tcpListenersAfter: [{ inode: "903", localAddress: "127.0.0.1", port: 6877 }], udpListenersBefore: [], udpListenersAfter: [], unixSocketsBefore: [], unixSocketsAfter: [] })).toThrow(/changed/u)
  })

  it("rejects cgroup process and thread membership drift", async () => {
    const { runDeploymentTargetAudit } = await load()
    const snapshots = [input("staging").topologyBefore, input("staging").topologyAfter]
    const memberships = [
      { path: `/docker/${stagingId}`, processIds: [321], threadIds: [321, 401] },
      { path: `/docker/${stagingId}`, processIds: [321, 322], threadIds: [321, 401, 322] },
    ]
    await expect(runDeploymentTargetAudit("staging", imageId, {
      captureCanonicalRecords: () => snapshots.shift(), readNetns: () => "net:[42]", cgroupProcessIds: () => memberships.shift(), ownedSocketInodes: () => [], readTcpListeners: () => [], readUdpListeners: () => [], readUnixSockets: () => [],
    })).rejects.toThrow(/cgroup process/u)
  })

  it.each([
    ["process", { path: `/docker/${stagingId}`, processIds: [321, 322], threadIds: [321, 401, 322] }, /cgroup process/u],
    ["thread", { path: `/docker/${stagingId}`, processIds: [321], threadIds: [321, 401, 402] }, /cgroup thread/u],
    ["path", { path: `/docker/${productionId}`, processIds: [321], threadIds: [321, 401] }, /cgroup changed/u],
  ])("rejects cgroup %s drift visible only after the listener scans", async (_label, terminal, error) => {
    const { runDeploymentTargetAudit } = await load()
    const snapshots = [input("staging").topologyBefore, input("staging").topologyAfter]
    const memberships = [
      { path: `/docker/${stagingId}`, processIds: [321], threadIds: [321, 401] },
      { path: `/docker/${stagingId}`, processIds: [321], threadIds: [321, 401] },
      terminal,
    ]
    await expect(runDeploymentTargetAudit("staging", imageId, {
      captureCanonicalRecords: () => snapshots.shift(), readNetns: () => "net:[42]", cgroupProcessIds: () => memberships.shift(), ownedSocketInodes: () => [], readTcpListeners: () => [], readUdpListeners: () => [], readUnixSockets: () => [],
    })).rejects.toThrow(error)
  })

  it("rejects owned FD socket drift visible only after the listener scans", async () => {
    const { runDeploymentTargetAudit } = await load()
    const snapshots = [input("staging").topologyBefore, input("staging").topologyAfter]
    const socketSets = [["900", "900"], ["900"], ["900", "901"]]
    await expect(runDeploymentTargetAudit("staging", imageId, {
      captureCanonicalRecords: () => snapshots.shift(),
      readNetns: () => "net:[42]",
      cgroupProcessIds: () => ({ path: `/docker/${stagingId}`, processIds: [321], threadIds: [321, 401] }),
      ownedSocketInodes: () => socketSets.shift(),
      readTcpListeners: () => [], readUdpListeners: () => [], readUnixSockets: () => [],
    })).rejects.toThrow(/socket ownership/u)
  })

  it("binds exact cgroup-v2 membership to the Docker container identity", async () => {
    const { cgroupProcessIds } = await load()
    const reads: string[] = []
    expect(cgroupProcessIds(321, stagingId, {
      readCgroup: (pid: number) => { expect(pid).toBe(321); return `0::/docker/${stagingId}\n` },
      readCgroupMembership: (path: string) => { reads.push(path); return path.endsWith("cgroup.procs") ? "321\n322\n" : "321\n400\n322\n" },
    })).toEqual({ path: `/docker/${stagingId}`, processIds: [321, 322], threadIds: [321, 322, 400] })
    expect(reads).toEqual([`/sys/fs/cgroup/docker/${stagingId}/cgroup.procs`, `/sys/fs/cgroup/docker/${stagingId}/cgroup.threads`])
    expect(() => cgroupProcessIds(321, stagingId, {
      readCgroup: () => `0::/docker/${productionId}\n`, readCgroupMembership: () => "321\n",
    })).toThrow(/cgroup/u)
    expect(() => cgroupProcessIds(321, stagingId, {
      readCgroup: () => `0::/docker/${stagingId}\n`, readCgroupMembership: () => "322\n",
    })).toThrow(/root/u)
  })

  it("scans every cgroup thread FD table and deduplicates inherited sockets", async () => {
    const { ownedSocketInodes } = await load()
    const listed: number[] = []
    const linked: string[] = []
    expect(ownedSocketInodes([321, 400], {
      listFileDescriptors: (tid: number) => { listed.push(tid); return tid === 321 ? ["3", "4"] : ["3", "7"] },
      readDescriptorLink: (tid: number, fd: string) => { linked.push(`${tid}:${fd}`); return fd === "4" ? "/tmp/file" : fd === "7" ? "socket:[901]" : "socket:[900]" },
    })).toEqual(["900", "900", "901"])
    expect(listed).toEqual([321, 400])
    expect(linked).toEqual(["321:3", "321:4", "400:3", "400:7"])
  })

  it("rejects deduplicated owned socket-set drift", async () => {
    const { attestOwnedListeners } = await load()
    expect(() => attestOwnedListeners({ rootPid: 321, targetContainerId: stagingId, cgroupPathBefore: `/docker/${stagingId}`, cgroupPathAfter: `/docker/${stagingId}`, netnsBefore: "net:[42]", netnsAfter: "net:[42]", processIdsBefore: [321], processIdsAfter: [321], socketInodesBefore: ["900", "900"], socketInodesAfter: ["900", "901"], tcpListenersBefore: [], tcpListenersAfter: [], udpListenersBefore: [], udpListenersAfter: [], unixSocketsBefore: [], unixSocketsAfter: [] })).toThrow(/socket ownership changed/u)
  })

  it("parses and rejects owned named Unix datagram endpoints", async () => {
    const { attestOwnedListeners, parseProcUnix } = await load()
    const header = "Num       RefCount Protocol Flags    Type St Inode Path"
    const datagram = "0000000000000000: 00000002 00000000 00000000 0002 01 900 /tmp/undocumented-dgram.sock"
    const parsed = parseProcUnix(`${header}\n${datagram}\n`)
    expect(parsed).toEqual([{ inode: "900", path: "/tmp/undocumented-dgram.sock", flags: "00000000", type: "0002", state: "01" }])
    expect(() => attestOwnedListeners({ rootPid: 321, netnsBefore: "net:[42]", netnsAfter: "net:[42]", processIdsBefore: [321], processIdsAfter: [321], socketInodesBefore: ["900"], socketInodesAfter: ["900"], tcpListenersBefore: [], tcpListenersAfter: [], udpListenersBefore: [], udpListenersAfter: [], unixSocketsBefore: parsed, unixSocketsAfter: parsed })).toThrow(/Unix/u)
  })

  it("inventories pathname-less Unix rows, rejects unnamed listeners, and permits unnamed non-listening socketpairs", async () => {
    const { attestOwnedListeners, parseProcUnix } = await load()
    const header = "Num       RefCount Protocol Flags    Type St Inode Path"
    const listener = "0000000000000000: 00000002 00000000 00010000 0001 01 900"
    const socketpair = "0000000000000000: 00000002 00000000 00000000 0001 03 901"
    const parsed = parseProcUnix(`${header}\n${listener}\n${socketpair}\n`)
    expect(parsed).toEqual([
      { inode: "900", path: "", flags: "00010000", type: "0001", state: "01" },
      { inode: "901", path: "", flags: "00000000", type: "0001", state: "03" },
    ])
    const baseline = { rootPid: 321, netnsBefore: "net:[42]", netnsAfter: "net:[42]", processIdsBefore: [321], processIdsAfter: [321], tcpListenersBefore: [], tcpListenersAfter: [], udpListenersBefore: [], udpListenersAfter: [] }
    expect(() => attestOwnedListeners({ ...baseline, socketInodesBefore: ["900"], socketInodesAfter: ["900"], unixSocketsBefore: [parsed[0]], unixSocketsAfter: [parsed[0]] })).toThrow(/Unix/u)
    expect(attestOwnedListeners({ ...baseline, socketInodesBefore: ["901"], socketInodesAfter: ["901"], unixSocketsBefore: [parsed[1]], unixSocketsAfter: [parsed[1]] })).toMatchObject({ ownedSocketCount: 1, unixControlSocketCount: 0 })
  })

  it.each([
    ["wildcard", { tcpListeners: [{ inode: "900", localAddress: "0.0.0.0", port: 8080 }] }],
    ["host listener", { tcpListeners: [{ inode: "900", localAddress: "192.168.1.5", port: 8080 }] }],
    ["undocumented loopback", { tcpListeners: [{ inode: "900", localAddress: "127.0.0.1", port: 8080 }] }],
    ["netns drift", { netnsAfter: "net:[43]" }],
    ["undocumented Unix socket", { unixSockets: [{ inode: "900", path: "/tmp/other.sock" }] }],
  ])("rejects %s listener state", async (_label, mutation) => {
    const { attestOwnedListeners } = await load()
    const baseline = { rootPid: 321, netnsBefore: "net:[42]", netnsAfter: "net:[42]", processIdsBefore: [321], processIdsAfter: [321], socketInodesBefore: ["900"], socketInodesAfter: ["900"], tcpListenersBefore: [], tcpListenersAfter: [], udpListenersBefore: [], udpListenersAfter: [], unixSocketsBefore: [], unixSocketsAfter: [] }
    expect(() => attestOwnedListeners({ ...baseline, ...mutation })).toThrow()
  })
})
