import { afterEach, describe, expect, it, vi } from "vitest"

const startupMocks = vi.hoisted(() => ({
  emit: vi.fn(),
  writeTombstone: vi.fn(),
}))

vi.mock("../../../nerves/runtime", () => ({ emitNervesEvent: startupMocks.emit }))
vi.mock("../../../heart/daemon/daemon-tombstone", () => ({
  writeDaemonTombstone: startupMocks.writeTombstone,
}))

import {
  createProviderReadinessPreparationFailure,
  createSanctuaryBundlePreparationFailure,
  failFastButlerExternalEventsStartup,
  failFastContainerCredentialBootstrapStartup,
  failFastSanctuaryBundlePreparationStartup,
  productStartupFor,
  providerReadinessAgents,
  startDaemonAfterContainerCredentialBootstrap,
} from "../../../heart/daemon/daemon-bootstrap-startup"
import { ButlerExternalEventAdoptionError } from "../../../heart/external-events/router"
import { loadProduct } from "../../../heart/product/active"
import type { OuroProduct, ProductStartupInput } from "../../../heart/product/types"

describe("a product prepares its bundle at startup (J2)", () => {
  const base: ProductStartupInput = { mode: "production", argv: ["node", "daemon-entry.js"], managedAgents: ["host"], repoRoot: "/opt/ouro", bundlesRoot: "/bundles", runtimePackageVersion: "1.0.0" }
  const flagged: ProductStartupInput = { ...base, argv: ["node", "daemon-entry.js", "--package-managed-agent", "host"] }
  const fixture = (startup?: OuroProduct["startup"]): OuroProduct => ({ seamVersion: 1, id: "fixture", agents: ["host", "former-host"], ...(startup ? { startup } : {}) })
  afterEach(() => { loadProduct(undefined) })

  it("asks the product that runs the managed agent, with what the daemon knows", () => {
    const startup = { preflight: vi.fn(), prepareManagedBundle: vi.fn() }
    const make = vi.fn(() => startup)
    loadProduct("/fixture.js", () => ({ product: fixture(make) }))
    expect(productStartupFor(flagged)).toBe(startup)
    expect(make).toHaveBeenCalledWith(flagged)
  })

  it("has nothing to prepare without a product, or for an agent no product runs", () => {
    loadProduct(undefined)
    expect(productStartupFor(base)).toBeNull()
    expect(productStartupFor({ ...flagged, mode: "dev" })).toBeNull()
    loadProduct("/fixture.js", () => ({ product: fixture(() => ({ preflight: vi.fn(), prepareManagedBundle: vi.fn() })) }))
    expect(productStartupFor({ ...base, managedAgents: ["slugger"] })).toBeNull()
    loadProduct("/fixture.js", () => ({ product: fixture() }))
    expect(productStartupFor(base)).toBeNull()
  })

  it.each([
    ["no product is loaded", undefined, ["host"]],
    ["the product has no startup", fixture(), ["host"]],
    ["no managed agent is the product's", fixture(() => ({ preflight: vi.fn(), prepareManagedBundle: vi.fn() })), ["slugger"]],
    ["two managed agents are the product's", fixture(() => ({ preflight: vi.fn(), prepareManagedBundle: vi.fn() })), ["host", "former-host"]],
  ] as const)("refuses a packaged bundle when %s", (_case, product, managedAgents) => {
    loadProduct(product ? "/fixture.js" : undefined, () => ({ product }))
    startupMocks.emit.mockClear()
    const startup = productStartupFor({ ...flagged, managedAgents })!
    expect(() => startup.preflight()).toThrow("human-required: roll back to a verified Ouro Butler release or install that release again")
    expect(() => startup.prepareManagedBundle()).toThrow("human-required")
    expect(startupMocks.emit).toHaveBeenCalledWith(expect.objectContaining({ level: "error", event: "daemon.product_startup_missing", meta: expect.objectContaining({ managedAgents: [...managedAgents] }) }))
  })
})

describe("daemon container credential bootstrap startup boundary", () => {
  it("scopes Workbench daemon readiness to its selected safe agent", () => {
    expect(providerReadinessAgents(["ouroboros", "slugger"], "ouroboros")).toEqual(["ouroboros"])
    expect(providerReadinessAgents(["ouroboros", "slugger"], "missing")).toEqual(["ouroboros", "slugger"])
    expect(providerReadinessAgents(["ouroboros", "slugger"], "../ouroboros")).toEqual(["ouroboros", "slugger"])
    expect(providerReadinessAgents(["ouroboros", "slugger"], undefined)).toEqual(["ouroboros", "slugger"])
  })

  it("turns structured Sanctuary repair actions into plain guidance", () => {
    const messages = [
      createSanctuaryBundlePreparationFailure("restart_from_verified_release").message,
      createSanctuaryBundlePreparationFailure("run_verified_update_recovery").message,
      createSanctuaryBundlePreparationFailure("roll_back_or_install_verified_release").message,
    ]

    expect(messages).toEqual([
      "Sanctuary installation needs attention\n  human-required: restart Ouro Butler from its verified release so the installed bundle can finish updating",
      "Sanctuary installation needs attention\n  human-required: resume the reviewed Butler update recovery procedure",
      "Sanctuary installation needs attention\n  human-required: roll back to a verified Ouro Butler release or install that release again",
    ])
    expect(messages.join("\n")).not.toMatch(/(?:restart_from|run_verified|roll_back)/u)
  })

  it("runs package preflight, credential migration, bundle ensure, and provider preparation in order before starting", async () => {
    const preflight = vi.fn(async () => undefined)
    let releaseBootstrap!: () => void
    let releaseBundle!: () => void
    let releasePreparation!: () => void
    const loadBootstrap = vi.fn(() => new Promise<void>((resolve) => { releaseBootstrap = resolve }))
    const prepareManagedBundle = vi.fn(() => new Promise<void>((resolve) => { releaseBundle = resolve }))
    const prepareDaemon = vi.fn(() => new Promise<void>((resolve) => { releasePreparation = resolve }))
    const startDaemon = vi.fn(async () => undefined)
    const markStartupFailure = vi.fn()
    const exit = vi.fn()

    const startup = startDaemonAfterContainerCredentialBootstrap({
      preflight,
      loadBootstrap,
      prepareManagedBundle,
      prepareDaemon,
      startDaemon,
      markStartupFailure,
      exit,
    })
    await Promise.resolve()
    expect(preflight).toHaveBeenCalledTimes(1)
    expect(loadBootstrap).toHaveBeenCalledTimes(1)
    expect(startDaemon).not.toHaveBeenCalled()

    releaseBootstrap()
    await Promise.resolve()
    expect(prepareManagedBundle).toHaveBeenCalledTimes(1)
    expect(prepareDaemon).not.toHaveBeenCalled()
    expect(startDaemon).not.toHaveBeenCalled()

    releaseBundle()
    await Promise.resolve()
    expect(prepareDaemon).toHaveBeenCalledTimes(1)
    expect(startDaemon).not.toHaveBeenCalled()

    releasePreparation()
    await expect(startup).resolves.toBe(true)
    expect(startDaemon).toHaveBeenCalledTimes(1)
    expect(markStartupFailure).not.toHaveBeenCalled()
    expect(exit).not.toHaveBeenCalled()
    expect(preflight.mock.invocationCallOrder[0]).toBeLessThan(loadBootstrap.mock.invocationCallOrder[0]!)
    expect(loadBootstrap.mock.invocationCallOrder[0]).toBeLessThan(prepareDaemon.mock.invocationCallOrder[0]!)
    expect(loadBootstrap.mock.invocationCallOrder[0]).toBeLessThan(prepareManagedBundle.mock.invocationCallOrder[0]!)
    expect(prepareManagedBundle.mock.invocationCallOrder[0]).toBeLessThan(prepareDaemon.mock.invocationCallOrder[0]!)
    expect(prepareDaemon.mock.invocationCallOrder[0]).toBeLessThan(startDaemon.mock.invocationCallOrder[0]!)
  })

  it("fails before credential bootstrap when package preflight is invalid", async () => {
    startupMocks.writeTombstone.mockClear()
    startupMocks.emit.mockClear()
    const loadBootstrap = vi.fn(async () => undefined)
    const prepareManagedBundle = vi.fn(async () => undefined)
    const prepareDaemon = vi.fn(async () => undefined)
    const startDaemon = vi.fn(async () => undefined)
    const markStartupFailure = vi.fn()
    const exit = vi.fn()

    await expect(startDaemonAfterContainerCredentialBootstrap({
      preflight: vi.fn(() => { throw createSanctuaryBundlePreparationFailure("roll_back_or_install_verified_release") }),
      loadBootstrap,
      prepareManagedBundle,
      prepareDaemon,
      startDaemon,
      markStartupFailure,
      exit,
    })).resolves.toBe(false)

    expect(markStartupFailure).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledWith(1)
    expect(loadBootstrap).not.toHaveBeenCalled()
    expect(prepareManagedBundle).not.toHaveBeenCalled()
    expect(prepareDaemon).not.toHaveBeenCalled()
    expect(startDaemon).not.toHaveBeenCalled()
    expect(startupMocks.writeTombstone).toHaveBeenCalledWith("startupFailurePublic", expect.objectContaining({ message: "Sanctuary installation needs attention\n  human-required: roll back to a verified Ouro Butler release or install that release again" }))
  })

  it("classifies bundle ensure failure separately and stops before provider preparation", async () => {
    startupMocks.writeTombstone.mockClear()
    startupMocks.emit.mockClear()
    const prepareDaemon = vi.fn(async () => undefined)
    const startDaemon = vi.fn(async () => undefined)
    const markStartupFailure = vi.fn()
    const exit = vi.fn()

    await expect(startDaemonAfterContainerCredentialBootstrap({
      preflight: vi.fn(),
      loadBootstrap: vi.fn(async () => undefined),
      prepareManagedBundle: vi.fn(async () => { throw createSanctuaryBundlePreparationFailure("run_verified_update_recovery") }),
      prepareDaemon,
      startDaemon,
      markStartupFailure,
      exit,
    })).resolves.toBe(false)

    expect(markStartupFailure).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledOnce()
    expect(prepareDaemon).not.toHaveBeenCalled()
    expect(startDaemon).not.toHaveBeenCalled()
    expect(startupMocks.emit).toHaveBeenCalledWith(expect.objectContaining({
      event: "daemon.entry_error",
      message: "Sanctuary installation needs attention\n  human-required: resume the reviewed Butler update recovery procedure",
    }))
  })

  it("terminates the startup branch without starting or forwarding a raw bootstrap rejection", async () => {
    const loadBootstrap = vi.fn(async () => { throw new Error("secret-bearing rejection") })
    const startDaemon = vi.fn(async () => undefined)
    const markStartupFailure = vi.fn()
    const exit = vi.fn()

    await expect(startDaemonAfterContainerCredentialBootstrap({
      loadBootstrap,
      startDaemon,
      markStartupFailure,
      exit,
    })).resolves.toBe(false)
    expect(markStartupFailure).toHaveBeenCalledWith()
    expect(startDaemon).not.toHaveBeenCalled()
    expect(exit).toHaveBeenCalledWith(1)
    expect(JSON.stringify(startupMocks.writeTombstone.mock.calls)).not.toContain("secret-bearing rejection")
    expect(JSON.stringify(startupMocks.emit.mock.calls)).not.toContain("secret-bearing rejection")
  })

  it("fails closed and redacts daemon preparation failures before startup", async () => {
    startupMocks.writeTombstone.mockClear()
    startupMocks.emit.mockClear()
    const startDaemon = vi.fn(async () => undefined)
    const markStartupFailure = vi.fn()
    const exit = vi.fn()

    await expect(startDaemonAfterContainerCredentialBootstrap({
      loadBootstrap: vi.fn(async () => undefined),
      prepareDaemon: vi.fn(async () => { throw new Error("raw provider token and vault failure") }),
      startDaemon,
      markStartupFailure,
      exit,
    })).resolves.toBe(false)

    expect(markStartupFailure).toHaveBeenCalledTimes(1)
    expect(startDaemon).not.toHaveBeenCalled()
    expect(exit).toHaveBeenCalledWith(1)
    expect(startupMocks.writeTombstone).toHaveBeenCalledWith(
      "startupFailurePublic",
      expect.objectContaining({
        message: "provider runtime preparation failed before startup; run `ouro doctor` for diagnosis",
      }),
    )
    expect(startupMocks.emit).toHaveBeenCalledWith(expect.objectContaining({
      message: "provider runtime preparation failed before startup; run `ouro doctor` for diagnosis",
    }))
    expect(JSON.stringify(startupMocks.writeTombstone.mock.calls)).not.toContain("raw provider token")
    expect(JSON.stringify(startupMocks.emit.mock.calls)).not.toContain("raw provider token")
  })

  it("surfaces only controlled daemon preparation guidance before startup", async () => {
    startupMocks.writeTombstone.mockClear()
    startupMocks.emit.mockClear()
    const publicMessage = "Provider checks need attention\nslugger: outward provider minimax / MiniMax-M2.5 failed live check\n  human-choice: ouro auth --agent slugger --provider minimax"
    const exit = vi.fn()

    await expect(startDaemonAfterContainerCredentialBootstrap({
      loadBootstrap: vi.fn(async () => undefined),
      prepareDaemon: vi.fn(async () => {
        throw createProviderReadinessPreparationFailure([{
          summary: "slugger: outward provider minimax / MiniMax-M2.5 failed live check",
          actions: [{ actor: "human-choice", command: "ouro auth --agent slugger --provider minimax" }],
        }])
      }),
      startDaemon: vi.fn(async () => undefined),
      markStartupFailure: vi.fn(),
      exit,
    })).resolves.toBe(false)

    expect(startupMocks.writeTombstone).toHaveBeenCalledWith(
      "startupFailurePublic",
      expect.objectContaining({ message: publicMessage }),
    )
    expect(startupMocks.emit).toHaveBeenCalledWith(expect.objectContaining({
      event: "daemon.entry_error",
      message: publicMessage,
      meta: { error: publicMessage },
    }))
    expect(exit).toHaveBeenCalledWith(1)
  })

  it("writes only a fixed redacted startup failure and exits PID 1 nonzero immediately", () => {
    startupMocks.writeTombstone.mockClear()
    startupMocks.emit.mockClear()
    const exit = vi.fn()

    failFastContainerCredentialBootstrapStartup({ exit })

    expect(startupMocks.writeTombstone).toHaveBeenCalledWith(
      "startupFailurePublic",
      expect.objectContaining({
        message: "container credential bootstrap rejected; recoverable claim retained for reconciliation",
      }),
    )
    expect(startupMocks.emit).toHaveBeenCalledWith({
      level: "error",
      component: "daemon",
      event: "daemon.entry_error",
      message: "daemon entrypoint failed before server startup",
      meta: {
        error: "container credential bootstrap rejected; recoverable claim retained for reconciliation",
      },
    })
    expect(exit).toHaveBeenCalledWith(1)
    expect(JSON.stringify(startupMocks.writeTombstone.mock.calls)).not.toContain("secret-bearing rejection")
    expect(JSON.stringify(startupMocks.emit.mock.calls)).not.toContain("secret-bearing rejection")
  })

  it("reports only controlled or fixed Sanctuary preparation guidance", () => {
    startupMocks.writeTombstone.mockClear()
    startupMocks.emit.mockClear()
    const controlledExit = vi.fn()
    failFastSanctuaryBundlePreparationStartup({ failure: createSanctuaryBundlePreparationFailure("roll_back_or_install_verified_release"), exit: controlledExit })
    expect(startupMocks.writeTombstone).toHaveBeenLastCalledWith("startupFailurePublic", expect.objectContaining({ message: "Sanctuary installation needs attention\n  human-required: roll back to a verified Ouro Butler release or install that release again" }))
    expect(controlledExit).toHaveBeenCalledWith(1)

    const redactedExit = vi.fn()
    failFastSanctuaryBundlePreparationStartup({ failure: new Error("secret raw path"), exit: redactedExit })
    expect(startupMocks.writeTombstone).toHaveBeenLastCalledWith("startupFailurePublic", expect.objectContaining({ message: "Sanctuary installation needs attention\n  human-required: resume the reviewed Butler update recovery procedure" }))
    expect(JSON.stringify(startupMocks.writeTombstone.mock.calls)).not.toContain("secret raw path")
    expect(redactedExit).toHaveBeenCalledWith(1)
  })

  it("stops the start when the Butler's external events can't be adopted, with the adoption's own guidance", () => {
    startupMocks.writeTombstone.mockClear()
    startupMocks.emit.mockClear()
    const exit = vi.fn()
    const guidance = "Butler external events need attention: merging /e/sanctuary into /e/butler failed: differ\n  agent-runnable: fix it"
    failFastButlerExternalEventsStartup({ failure: new ButlerExternalEventAdoptionError(guidance), exit })
    expect(startupMocks.writeTombstone).toHaveBeenLastCalledWith("startupFailurePublic", expect.objectContaining({ message: guidance }))
    expect(startupMocks.emit).toHaveBeenLastCalledWith(expect.objectContaining({ level: "error", event: "daemon.entry_error", meta: { error: guidance } }))
    expect(exit).toHaveBeenCalledWith(1)

    failFastButlerExternalEventsStartup({ failure: new Error("raw detail"), exit })
    expect(startupMocks.writeTombstone).toHaveBeenLastCalledWith("startupFailurePublic", expect.objectContaining({ message: expect.stringMatching(/^Butler external events need attention\n  agent-runnable: /u) }))
    expect(JSON.stringify(startupMocks.writeTombstone.mock.calls)).not.toContain("raw detail")
  })

  it("still exits nonzero when tombstone or event reporting fails", () => {
    const exitAfterTombstoneFailure = vi.fn()
    startupMocks.writeTombstone.mockImplementationOnce(() => { throw new Error("disk unavailable") })
    failFastContainerCredentialBootstrapStartup({
      exit: exitAfterTombstoneFailure,
    })
    expect(exitAfterTombstoneFailure).toHaveBeenCalledWith(1)

    const exitAfterEventFailure = vi.fn()
    startupMocks.emit.mockImplementationOnce(() => { throw new Error("logger unavailable") })
    failFastContainerCredentialBootstrapStartup({
      exit: exitAfterEventFailure,
    })
    expect(exitAfterEventFailure).toHaveBeenCalledWith(1)
  })
})
