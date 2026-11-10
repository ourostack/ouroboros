import * as fs from "node:fs"
import * as path from "node:path"
import { describe, expect, it, vi } from "vitest"
import { emitNervesEvent } from "../../nerves/runtime"

vi.mock("../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))

import {
  OPTIONAL_PACKAGES,
  OptionalPackageMissingError,
  describeStartupError,
  importOptional,
  missingOptionalPackage,
} from "../../heart/optional-packages"

function moduleNotFound(name: string): Error {
  return Object.assign(new Error(`Cannot find module '${name}'\nRequire stack:\n- /opt/ouro/dist/x.js`), { code: "MODULE_NOT_FOUND" })
}

describe("optional packages", () => {
  it("lists exactly package.json's optionalDependencies, none of which is also a hard dependency", () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../package.json"), "utf8")) as {
      dependencies: Record<string, string>
      optionalDependencies: Record<string, string>
    }
    expect([...OPTIONAL_PACKAGES].sort()).toEqual(Object.keys(pkg.optionalDependencies).sort())
    for (const name of OPTIONAL_PACKAGES) expect(pkg.dependencies[name]).toBeUndefined()
  })

  it("recognises only a missing optional package itself", () => {
    expect(missingOptionalPackage(moduleNotFound("stripe"))).toBe("stripe")
    expect(missingOptionalPackage(`Cannot find module '@microsoft/teams.apps'`)).toBe("@microsoft/teams.apps")
    expect(missingOptionalPackage(moduleNotFound("./internals/hidden-keys"))).toBeNull()
    expect(missingOptionalPackage(moduleNotFound("openai"))).toBeNull()
    expect(missingOptionalPackage(new Error("socket hang up"))).toBeNull()
  })

  it("returns what the loader returns", async () => {
    await expect(importOptional("stripe", "Virtual cards", async () => ({ ok: 1 }))).resolves.toEqual({ ok: 1 })
  })

  it("turns the package's absence into an error naming the feature and the fix", async () => {
    vi.mocked(emitNervesEvent).mockClear()
    const failure = await importOptional("stripe", "Virtual cards", async () => { throw moduleNotFound("stripe") }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(OptionalPackageMissingError)
    expect(failure).toMatchObject({ packageName: "stripe", feature: "Virtual cards", name: "OptionalPackageMissingError" })
    expect((failure as Error).message).toBe(
      "Virtual cards needs stripe, an optional package this install left out (npm --omit=optional). Reinstall @ouro.bot/cli without --omit=optional to use it.",
    )
    expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      level: "error",
      event: "engine.optional_package_missing",
      meta: { package: "stripe", feature: "Virtual cards" },
    }))
  })

  it("rethrows any other failure unchanged, including another package's absence", async () => {
    const broken = moduleNotFound("./internals/hidden-keys")
    await expect(importOptional("stripe", "Virtual cards", async () => { throw broken })).rejects.toBe(broken)
    const other = moduleNotFound("mailparser")
    await expect(importOptional("stripe", "Virtual cards", async () => { throw other })).rejects.toBe(other)
  })

  it("describes a sense's startup failure", () => {
    expect(describeStartupError(moduleNotFound("smtp-server"), "the Mail sense")).toContain("the Mail sense needs smtp-server")
    expect(describeStartupError(new Error("no credentials"), "the Teams sense")).toBe("no credentials")
    expect(describeStartupError("plain", "the Teams sense")).toBe("plain")
  })
})
