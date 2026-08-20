import { pathToFileURL } from "node:url"
import * as path from "node:path"

import { describe, expect, it } from "vitest"

async function broker(): Promise<{ dispatch(request: unknown, dependencies?: { readBootId(): string }): Promise<unknown> }> {
  return import(pathToFileURL(path.resolve("deploy/unraid/sanctuary-unit16-host-broker.mjs")).href) as Promise<{
    dispatch(request: unknown, dependencies?: { readBootId(): string }): Promise<unknown>
  }>
}

describe("Sanctuary Unit 16 host broker", () => {
  it("stages a bounded host reboot attestation without executing reboot", async () => {
    const { dispatch } = await broker()
    const result = await dispatch({
      operation: "request_reboot",
      targetId: "sanctuary",
      idempotencyKey: "0123456789abcdef0123456789abcdef",
    }, { readBootId: () => "11111111-2222-3333-4444-555555555555\n" }) as Record<string, unknown>

    expect(result).toMatchObject({ accepted: true, targetId: "sanctuary", staged: true })
    expect(result.requestId).toMatch(/^[0-9a-f]{64}$/u)
    expect(result.prebootId).toMatch(/^[A-Za-z0-9-]{4,128}$/u)
  })

  it("rejects unknown operations, extra authority, and invalid target coordinates", async () => {
    const { dispatch } = await broker()
    await expect(dispatch({ operation: "run_command", executable: "/bin/sh" })).rejects.toThrow(/not whitelisted/u)
    await expect(dispatch({
      operation: "request_reboot",
      targetId: "sanctuary",
      idempotencyKey: "0123456789abcdef0123456789abcdef",
      executable: "/sbin/reboot",
    })).rejects.toThrow(/shape is invalid/u)
    await expect(dispatch({
      operation: "request_reboot",
      targetId: "another-host",
      idempotencyKey: "0123456789abcdef0123456789abcdef",
    })).rejects.toThrow(/target host is invalid/u)
  })
})
