import { describe, expect, it } from "vitest"
import * as path from "path"

const {
  buildWrapperInstallArgs,
  buildWrapperPackArgs,
  wrapperFixtureVersions,
} = require(path.resolve(__dirname, "../../../scripts/ouro-bot-package-e2e.cjs"))

describe("packed ouro.bot wrapper E2E", () => {
  it("packs the wrapper package into an isolated destination", () => {
    expect(buildWrapperPackArgs("/tmp/ouro-wrapper-pack")).toEqual([
      "pack",
      "./packages/ouro.bot",
      "--pack-destination",
      "/tmp/ouro-wrapper-pack",
    ])
  })

  it("installs the packed wrapper into an isolated prefix", () => {
    expect(buildWrapperInstallArgs("/tmp/ouro-wrapper-install", "/tmp/ouro.bot-0.1.0.tgz")).toEqual([
      "install",
      "--prefix",
      "/tmp/ouro-wrapper-install",
      "/tmp/ouro.bot-0.1.0.tgz",
    ])
  })

  it("covers fresh, older, equal, and newer installed state", () => {
    expect(wrapperFixtureVersions("0.1.0-alpha.728")).toEqual([
      null,
      "0.0.1",
      "0.1.0-alpha.728",
      "999.0.0",
    ])
  })
})
