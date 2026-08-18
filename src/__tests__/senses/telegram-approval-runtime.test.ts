import { describe, expect, it, vi } from "vitest"

import {
  approvalContinuationRunAgentOptions,
  executeApprovedTelegramTool,
} from "../../senses/telegram-approval-runtime"
import { ApprovalExecutionFailedError } from "../../heart/tool-approval"

describe("Telegram approval runtime safety", () => {
  it("reuses the approval coordinator when the resumed provider turn requests another gated tool", () => {
    const approvalCoordinator = { propose: vi.fn() }
    const toolContext = { agentName: "sanctuary" }

    expect(approvalContinuationRunAgentOptions(toolContext, approvalCoordinator)).toEqual({
      toolContext,
      approvalCoordinator,
    })
  })

  it("preserves a successful approved restart result", async () => {
    const result = '{"ok":true,"data":{"container":{"id":"abc","name":"calibre-web"},"beforeState":"running","afterState":"running","observedRestart":true,"degraded":false}}'
    const execute = vi.fn().mockResolvedValue(result)

    await expect(executeApprovedTelegramTool("unraid_restart_container", { container: "calibre-web" }, execute))
      .resolves.toBe(result)
  })

  it.each([
    ['{"ok":false,"error":{"code":"ambiguous","message":"restart outcome is ambiguous","degraded":true}}', "restart outcome is ambiguous"],
    ["not-json", "approved restart returned an invalid result"],
    ['{"data":{}}', "approved restart returned an invalid result"],
    ['{"ok":true}', "approved restart returned an invalid result"],
    ['{"ok":true,"data":{}}', "approved restart returned an invalid result"],
    ['{"ok":true,"data":{"container":{"id":"abc","name":"calibre-web"},"beforeState":"running","afterState":"running","observedRestart":false,"degraded":false}}', "approved restart returned an invalid result"],
    ['{"ok":true,"data":{"container":{"id":"abc","name":"calibre-web"},"beforeState":"running","afterState":"running","observedRestart":true,"degraded":true}}', "approved restart returned an invalid result"],
  ])("turns a failed or invalid approved restart into a failed approval", async (result, message) => {
    const execute = vi.fn().mockResolvedValue(result)

    await expect(executeApprovedTelegramTool("unraid_restart_container", { container: "calibre-web" }, execute))
      .rejects.toEqual(expect.objectContaining({
        name: ApprovalExecutionFailedError.name,
        message,
      }))
  })

  it("does not reinterpret ordinary approved tool output", async () => {
    const execute = vi.fn().mockResolvedValue("ordinary output")

    await expect(executeApprovedTelegramTool("ponder", {}, execute)).resolves.toBe("ordinary output")
  })
})
