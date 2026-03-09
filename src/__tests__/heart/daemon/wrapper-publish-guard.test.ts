import { describe, expect, it } from "vitest"

import { assessWrapperPublishSync } from "../../../heart/daemon/wrapper-publish-guard"

describe("assessWrapperPublishSync", () => {
  it("passes when the wrapper package did not change", () => {
    expect(assessWrapperPublishSync({
      changedFiles: ["src/heart/daemon/daemon-cli.ts"],
      localVersion: "0.1.0-alpha.20",
      cliVersion: "0.1.0-alpha.20",
      publishedVersion: "0.1.0-alpha.20",
    })).toEqual({
      ok: true,
      message: "wrapper package unchanged",
    })
  })

  it("fails when the wrapper version drifts behind the cli version even if wrapper files did not change", () => {
    expect(assessWrapperPublishSync({
      changedFiles: ["src/heart/daemon/daemon-cli.ts"],
      localVersion: "0.1.0-alpha.21",
      cliVersion: "0.1.0-alpha.27",
      publishedVersion: "0.1.0-alpha.21",
    })).toEqual({
      ok: false,
      message: "ouro.bot wrapper version 0.1.0-alpha.21 must match @ouro.bot/cli version 0.1.0-alpha.27",
    })
  })

  it("fails when wrapper files changed but the local wrapper version is already published", () => {
    expect(assessWrapperPublishSync({
      changedFiles: ["packages/ouro.bot/index.js"],
      localVersion: "0.1.0-alpha.6",
      cliVersion: "0.1.0-alpha.6",
      publishedVersion: "0.1.0-alpha.6",
    })).toEqual({
      ok: false,
      message: "ouro.bot wrapper changed but ouro.bot@0.1.0-alpha.6 is already published; bump packages/ouro.bot/package.json before merging",
    })
  })

  it("passes when wrapper files changed and the local wrapper version is unpublished", () => {
    expect(assessWrapperPublishSync({
      changedFiles: ["packages/ouro.bot/index.js", "packages/ouro.bot/package.json"],
      localVersion: "0.1.0-alpha.21",
      cliVersion: "0.1.0-alpha.21",
      publishedVersion: "0.1.0-alpha.6",
    })).toEqual({
      ok: true,
      message: "wrapper package changed and local wrapper version is unpublished",
    })
  })
})
