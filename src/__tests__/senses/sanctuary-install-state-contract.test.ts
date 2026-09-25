import { describe, expect, it } from "vitest"

import { sanctuaryInstallStateRequiredToolCalls, sanctuaryVersionQuestionRequiredToolCalls } from "../../senses/sanctuary-install-state-contract"

const request = "use sanctuary_get_install_state now. in one compact reply, tell me the runtime package version, packaged bundle version, live bundle version, parity, journal state, ready state, and repair action. don't repeat the answer."
const currentResult = JSON.stringify({
  ok: true,
  data: {
    runtimePackageVersion: "0.1.0-alpha.805",
    packagedBundleVersion: "0.1.0-alpha.805",
    liveBundleVersion: "0.1.0-alpha.805",
    parity: "exact",
    mismatchCodes: [],
    journalState: "absent",
    ready: true,
    repair: { actor: "none", action: "none" },
  },
})

describe("Sanctuary install-state contract", () => {
  it("activates only for an explicit authorized install-state tool request", () => {
    expect(sanctuaryInstallStateRequiredToolCalls(request, ["sanctuary_get_install_state"])?.names).toEqual(["sanctuary_get_install_state"])
    expect(sanctuaryInstallStateRequiredToolCalls("Please run SANCTUARY_GET_INSTALL_STATE now.", ["sanctuary_get_install_state"])?.names).toEqual(["sanctuary_get_install_state"])
    expect(sanctuaryInstallStateRequiredToolCalls("How is Sanctuary?", ["sanctuary_get_install_state"])).toBeUndefined()
    expect(sanctuaryInstallStateRequiredToolCalls(request, ["unraid_get_system"])).toBeUndefined()
    expect(sanctuaryInstallStateRequiredToolCalls("Do not use sanctuary_get_install_state; answer from memory.", ["sanctuary_get_install_state"])).toBeUndefined()
    expect(sanctuaryInstallStateRequiredToolCalls("Don't call sanctuary_get_install_state now.", ["sanctuary_get_install_state"])).toBeUndefined()
    expect(sanctuaryInstallStateRequiredToolCalls("Don’t use sanctuary_get_install_state; answer from memory.", ["sanctuary_get_install_state"])).toBeUndefined()
    expect(sanctuaryInstallStateRequiredToolCalls("Do not under any circumstances whatsoever ever use sanctuary_get_install_state; answer from memory.", ["sanctuary_get_install_state"])).toBeUndefined()
    expect(sanctuaryInstallStateRequiredToolCalls("Do not, under any circumstances, use sanctuary_get_install_state.", ["sanctuary_get_install_state"])).toBeUndefined()
    expect(sanctuaryInstallStateRequiredToolCalls("I am asking you not to call sanctuary_get_install_state.", ["sanctuary_get_install_state"])).toBeUndefined()
    expect(sanctuaryInstallStateRequiredToolCalls("I don't want you to call sanctuary_get_install_state.", ["sanctuary_get_install_state"])).toBeUndefined()
    expect(sanctuaryInstallStateRequiredToolCalls("I don’t want you to call sanctuary_get_install_state.", ["sanctuary_get_install_state"])).toBeUndefined()
    expect(sanctuaryInstallStateRequiredToolCalls("You must not call sanctuary_get_install_state.", ["sanctuary_get_install_state"])).toBeUndefined()
    expect(sanctuaryInstallStateRequiredToolCalls("You can't call sanctuary_get_install_state.", ["sanctuary_get_install_state"])).toBeUndefined()
    expect(sanctuaryInstallStateRequiredToolCalls("Do not attempt to call sanctuary_get_install_state.", ["sanctuary_get_install_state"])).toBeUndefined()
    expect(sanctuaryInstallStateRequiredToolCalls("Do not ever attempt to call sanctuary_get_install_state.", ["sanctuary_get_install_state"])).toBeUndefined()
    expect(sanctuaryInstallStateRequiredToolCalls("Did you call sanctuary_get_install_state earlier?", ["sanctuary_get_install_state"])).toBeUndefined()
    expect(sanctuaryInstallStateRequiredToolCalls("Did you call sanctuary_get_install_state earlier? Call sanctuary_get_install_state now.", ["sanctuary_get_install_state"])?.names).toEqual(["sanctuary_get_install_state"])
    expect(sanctuaryInstallStateRequiredToolCalls("Do not answer from memory; call sanctuary_get_install_state now.", ["sanctuary_get_install_state"])?.names).toEqual(["sanctuary_get_install_state"])
    expect(sanctuaryInstallStateRequiredToolCalls("Never guess: use sanctuary_get_install_state now.", ["sanctuary_get_install_state"])?.names).toEqual(["sanctuary_get_install_state"])
    expect(sanctuaryInstallStateRequiredToolCalls("Do not use stale data, run sanctuary_get_install_state now.", ["sanctuary_get_install_state"])?.names).toEqual(["sanctuary_get_install_state"])
    expect(sanctuaryInstallStateRequiredToolCalls("Do not answer until you call sanctuary_get_install_state.", ["sanctuary_get_install_state"])?.names).toEqual(["sanctuary_get_install_state"])
    expect(sanctuaryInstallStateRequiredToolCalls("Don't forget to call sanctuary_get_install_state.", ["sanctuary_get_install_state"])?.names).toEqual(["sanctuary_get_install_state"])
    expect(sanctuaryInstallStateRequiredToolCalls("Can you call sanctuary_get_install_state now?", ["sanctuary_get_install_state"])?.names).toEqual(["sanctuary_get_install_state"])
  })

  it("accepts only the successful current install-state result with empty arguments", () => {
    const contract = sanctuaryInstallStateRequiredToolCalls(request, ["sanctuary_get_install_state"])!

    expect(contract.validateRequiredToolResult("other", currentResult, {})).toBe(false)
    expect(contract.validateRequiredToolResult("sanctuary_get_install_state", currentResult, { extra: "no" })).toBe(false)
    expect(contract.validateRequiredToolResult("sanctuary_get_install_state", "not json", {})).toBe(false)
    expect(contract.validateRequiredToolResult("sanctuary_get_install_state", JSON.stringify({ ok: false }), {})).toBe(false)
    expect(contract.validateRequiredToolResult("sanctuary_get_install_state", JSON.stringify({ ok: true, data: { runtimePackageVersion: 805 } }), {})).toBe(false)
    expect(contract.validateRequiredToolResult("sanctuary_get_install_state", JSON.stringify({
      ok: true,
      data: {
        runtimePackageVersion: "0.1.0-alpha.806",
        packagedBundleVersion: "0.1.0-alpha.806",
        liveBundleVersion: "0.1.0-alpha.805",
        parity: "mismatch",
        journalState: "absent",
        ready: false,
        repair: { action: "restart_from_verified_release" },
      },
    }), {})).toBe(false)
    expect(contract.validateRequiredToolResult("sanctuary_get_install_state", JSON.stringify({
      ok: true,
      data: {
        runtimePackageVersion: "",
        packagedBundleVersion: "",
        liveBundleVersion: "0.1.0-alpha.805",
        parity: "mismatch",
        mismatchCodes: ["runtime_package_version"],
        journalState: "absent",
        ready: false,
        repair: { actor: "agent-runnable", action: "resume_verified_commit" },
      },
    }), {})).toBe(false)
    expect(contract.validateRequiredToolResult("sanctuary_get_install_state", JSON.stringify({
      ok: true,
      data: {
        runtimePackageVersion: "0.1.0-alpha.805",
        packagedBundleVersion: "0.1.0-alpha.805",
        liveBundleVersion: "0.1.0-alpha.804",
        parity: "unknown",
        journalState: "absent",
        ready: false,
        repair: { actor: "human-required", action: "restart_from_verified_release" },
      },
    }), {})).toBe(false)
    expect(contract.validateRequiredToolResult("sanctuary_get_install_state", currentResult, {})).toBe(true)
  })

  it("rejects stale terminal facts and accepts all seven fresh facts", () => {
    const contract = sanctuaryInstallStateRequiredToolCalls(request, ["sanctuary_get_install_state"])!

    expect(contract.validateTerminalAnswer("Runtime 0.1.0-alpha.805, packaged 0.1.0-alpha.805, live 0.1.0-alpha.805, parity exact, journal absent, ready true, repair none.")).toMatch(/fresh install-state result/iu)
    expect(contract.validateRequiredToolResult("sanctuary_get_install_state", currentResult, {})).toBe(true)
    expect(contract.validateTerminalAnswer("Runtime 0.1.0-alpha.799, packaged 0.1.0-alpha.799, live 0.1.0-alpha.799, parity exact, journal absent, ready true, repair none.")).toMatch(/fresh install-state result/iu)
    expect(contract.validateTerminalAnswer("Runtime **0.1.0-alpha.805**, packaged **0.1.0-alpha.805**, live **0.1.0-alpha.805**, parity **exact**, journal **absent**, ready **true**, repair **none**.")).toBeUndefined()
    expect(contract.validateTerminalAnswer("Runtime 0.1.0-alpha.805, packaged 0.1.0-alpha.805, live 0.1.0-alpha.805, parity exact, journal absent, ready true, repair none. Runtime 0.1.0-alpha.805, packaged 0.1.0-alpha.805, live 0.1.0-alpha.805, parity exact, journal absent, ready true, repair none.")).toMatch(/exactly once/iu)
    expect(contract.validateTerminalAnswer("Runtime 0.1.0-alpha.805, packaged 0.1.0-alpha.805, live 0.1.0-alpha.805, parity exact, journal absent, ready true, repair none. Runtime 0.1.0-alpha.799.")).toMatch(/exactly once/iu)
    expect(contract.validateTerminalAnswer("Runtime 0.1.0-alpha.805, packaged 0.1.0-alpha.805, live 0.1.0-alpha.805, parity mismatch now exact, journal absent, ready true, repair none.")).toMatch(/exactly once/iu)
    expect(contract.validateTerminalAnswer("Runtime 0.1.0-alpha.805, packaged 0.1.0-alpha.805, live 0.1.0-alpha.805, parity exact, journal rollback now absent, ready true, repair none.")).toMatch(/exactly once/iu)
    expect(contract.validateTerminalAnswer("Runtime 0.1.0-alpha.805, packaged 0.1.0-alpha.805, live 0.1.0-alpha.805, parity exact, journal absent, ready false now true, repair none.")).toMatch(/exactly once/iu)
    expect(contract.validateTerminalAnswer("Runtime 0.1.0-alpha.805, packaged 0.1.0-alpha.805, live 0.1.0-alpha.805, parity exact, journal absent, ready true, repair restart_from_verified_release then none.")).toMatch(/exactly once/iu)
    expect(contract.validateTerminalAnswer("Runtime 0.1.0-alpha.805, packaged 0.1.0-alpha.805, live 0.1.0-alpha.805, parity exact, journal absent, ready true, repair none. The install is not ready.")).toMatch(/exactly once/iu)
    expect(contract.validateTerminalAnswer("Runtime 0.1.0-alpha.805, packaged 0.1.0-alpha.805, live 0.1.0-alpha.805, parity exact, journal absent, ready true, repair none. The installed package version is 0.1.0-alpha.799.")).toMatch(/exactly once/iu)
    expect(contract.validateTerminalAnswer("Runtime 0.1.0-alpha.805, packaged 0.1.0-alpha.805, live 0.1.0-alpha.805, parity exact, journal absent, ready true, repair none, but the install is not ready.")).toMatch(/exactly once/iu)
    expect(contract.validateTerminalAnswer("Runtime 0.1.0-alpha.805, packaged 0.1.0-alpha.805, live 0.1.0-alpha.805, parity exact, journal absent, ready true, repair none, but parity is not exact.")).toMatch(/exactly once/iu)
    expect(contract.validateTerminalAnswer("Runtime 0.1.0-alpha.805, packaged 0.1.0-alpha.805, live 0.1.0-alpha.805, parity exact, journal absent, ready true, repair none, but repair is required.")).toMatch(/exactly once/iu)
    expect(contract.validateTerminalAnswer("Runtime 0.1.0-alpha.805, packaged 0.1.0-alpha.805, live 0.1.0-alpha.805, parity exact, journal absent, ready true, repair none, but the install isn’t ready.")).toMatch(/exactly once/iu)
    expect(contract.validateTerminalAnswer("Runtime 0.1.0-alpha.805, packaged 0.1.0-alpha.805, live 0.1.0-alpha.805, parity exact, journal absent, ready true, repair none and runtime is 0.1.0-alpha.799.")).toMatch(/exactly once/iu)
    expect(contract.validateTerminalAnswer("Runtime 0.1.0-alpha.805, packaged 0.1.0-alpha.805, live 0.1.0-alpha.805, parity exact, journal absent, ready true, repair none. The library currently has 10 movies.")).toBeUndefined()
    expect(contract.validateTerminalAnswer("Runtime 0.1.0-alpha.805, packaged 0.1.0-alpha.805, live 0.1.0-alpha.805, parity exact, journal absent, ready true, repair none. The movie runtime is 90 minutes, and I can repair the loose shelf tomorrow.")).toBeUndefined()
    expect(contract.validateTerminalAnswer("Runtime 0.1.0-alpha.805, packaged 0.1.0-alpha.805, live 0.1.0-alpha.805, parity exact, journal absent, ready true, repair none. Repair the loose shelf tomorrow. Runtime of the movie is 90 minutes.")).toBeUndefined()
  })

  it("accepts a valid missing-live-bundle result and requires its null value in the answer", () => {
    const contract = sanctuaryInstallStateRequiredToolCalls(request, ["sanctuary_get_install_state"])!
    const result = JSON.stringify({
      ok: true,
      data: {
        runtimePackageVersion: "0.1.0-alpha.805",
        packagedBundleVersion: "0.1.0-alpha.805",
        liveBundleVersion: null,
        parity: "mismatch",
        mismatchCodes: ["bundle_meta_missing"],
        journalState: "rollback",
        ready: false,
        repair: { actor: "human-required", action: "restart_from_verified_release" },
      },
    })

    expect(contract.validateRequiredToolResult("sanctuary_get_install_state", result, {})).toBe(true)
    expect(contract.validateTerminalAnswer("Runtime 0.1.0-alpha.805, packaged 0.1.0-alpha.805, live null, parity mismatch, journal rollback, ready false, repair restart_from_verified_release.")).toBeUndefined()
    expect(contract.validateTerminalAnswer("Runtime 0.1.0-alpha.805, live null, packaged 0.1.0-alpha.805, parity mismatch, journal rollback, ready false, repair restart_from_verified_release.")).toMatch(/exactly once/iu)
    expect(contract.validateTerminalAnswer("Runtime 0.1.0-alpha.805, packaged 0.1.0-alpha.805, live null, parity mismatch, journal rollback, ready false, repair restart_from_verified_release, but the install is ready.")).toMatch(/exactly once/iu)
  })

  it("grounds an arbitrary corrupt live-version string from a valid mismatch result", () => {
    for (const liveBundleVersion of ["corrupt", "corrupt/", "corrupt-", "v1.", "(corrupt)"]) {
      const contract = sanctuaryInstallStateRequiredToolCalls(request, ["sanctuary_get_install_state"])!
      const result = JSON.stringify({
        ok: true,
        data: {
          runtimePackageVersion: "0.1.0-alpha.805",
          packagedBundleVersion: "0.1.0-alpha.805",
          liveBundleVersion,
          parity: "mismatch",
          mismatchCodes: ["bundle_meta_field"],
          journalState: "absent",
          ready: false,
          repair: { actor: "human-required", action: "restart_from_verified_release" },
        },
      })

      expect(contract.validateRequiredToolResult("sanctuary_get_install_state", result, {})).toBe(true)
      expect(contract.validateTerminalAnswer(`Runtime 0.1.0-alpha.805, packaged 0.1.0-alpha.805, live ${liveBundleVersion}, parity mismatch, journal absent, ready false, repair restart_from_verified_release.`)).toBeUndefined()
    }
    expect(sanctuaryInstallStateRequiredToolCalls(request, ["sanctuary_get_install_state"])!.validateRequiredToolResult("sanctuary_get_install_state", JSON.stringify({
      ok: true,
      data: {
        runtimePackageVersion: "0.1.0-alpha.805",
        packagedBundleVersion: "0.1.0-alpha.805",
        liveBundleVersion: "",
        parity: "mismatch",
        mismatchCodes: ["bundle_meta_field"],
        journalState: "absent",
        ready: false,
        repair: { actor: "human-required", action: "restart_from_verified_release" },
      },
    }), {})).toBe(false)
  })

  it("rejects repair values outside the successful install-state result contract", () => {
    const contract = sanctuaryInstallStateRequiredToolCalls(request, ["sanctuary_get_install_state"])!
    const result = JSON.stringify({
      ok: true,
      data: {
        runtimePackageVersion: "0.1.0-alpha.806",
        packagedBundleVersion: "0.1.0-alpha.806",
        liveBundleVersion: "0.1.0-alpha.805",
        parity: "mismatch",
        mismatchCodes: ["bundle_meta_field"],
        journalState: "committing",
        ready: false,
        repair: { actor: "agent-runnable", action: "resume_verified_commit" },
      },
    })

    expect(contract.validateRequiredToolResult("sanctuary_get_install_state", result, {})).toBe(false)
  })
})

describe("Sanctuary version question contract", () => {
  const tools = ["sanctuary_get_install_state"]
  it.each([
    "quick check after tonight's fixes — what version are you on?",
    "What version are you running?",
    "which version is live",
    "what's your current version",
    "what are you on right now?",
    "Are you on the latest?",
    "version are you on?",
  ])("requires a fresh install-state read for %j", (question) => {
    expect(sanctuaryVersionQuestionRequiredToolCalls(question, tools)?.names).toEqual(["sanctuary_get_install_state"])
  })

  it("stays out of unrelated questions, explicit install-state requests and agents without the tool", () => {
    expect(sanctuaryVersionQuestionRequiredToolCalls("How is Sanctuary?", tools)).toBeUndefined()
    expect(sanctuaryVersionQuestionRequiredToolCalls("Call sanctuary_get_install_state and tell me the version.", tools)).toBeUndefined()
    expect(sanctuaryVersionQuestionRequiredToolCalls("What version are you on?", ["unraid_get_system"])).toBeUndefined()
  })

  it("accepts only the freshly read version and asks for it when missing", () => {
    const contract = sanctuaryVersionQuestionRequiredToolCalls("What version are you on?", tools)!
    expect(contract.validateTerminalAnswer("I'm on 0.1.0-alpha.805.")).toMatch(/Call sanctuary_get_install_state/u)
    expect(contract.validateRequiredToolResult("unraid_get_system", currentResult, {})).toBe(false)
    expect(contract.validateRequiredToolResult("sanctuary_get_install_state", currentResult, { force: "1" })).toBe(false)
    expect(contract.validateRequiredToolResult("sanctuary_get_install_state", "not json", {})).toBe(false)
    expect(contract.validateRequiredToolResult("sanctuary_get_install_state", currentResult, {})).toBe(true)
    expect(contract.validateTerminalAnswer("Just checked: 0.1.0-alpha.805, parity exact.")).toBeUndefined()
    expect(contract.validateTerminalAnswer("Running v0.1.0-alpha.805.")).toBeUndefined()
    expect(contract.validateTerminalAnswer("All good, parity exact.")).toMatch(/0\.1\.0-alpha\.805/u)
    expect(contract.validateTerminalAnswer("Just checked the live state: 0.1.0-alpha.841.")).toMatch(/do not state 0\.1\.0-alpha\.841/u)
  })

  it("accepts the packaged or live version when the live bundle is absent", () => {
    const contract = sanctuaryVersionQuestionRequiredToolCalls("what version are you on", tools)!
    const noLive = JSON.parse(currentResult)
    noLive.data.liveBundleVersion = null
    noLive.data.parity = "mismatch"
    noLive.data.mismatchCodes = ["bundle_meta_missing"]
    noLive.data.ready = false
    noLive.data.repair = { actor: "human-required", action: "run_verified_update_recovery" }
    expect(contract.validateRequiredToolResult("sanctuary_get_install_state", JSON.stringify(noLive), {})).toBe(true)
    expect(contract.validateTerminalAnswer("Runtime 0.1.0-alpha.805; live bundle missing.")).toBeUndefined()
  })
})
