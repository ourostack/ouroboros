import { describe, expect, it } from "vitest"
import { chatToolDefinitions } from "../../repertoire/tools-chat"
import { voiceToolDefinitions } from "../../repertoire/tools-voice"
import { telegramContactToolDefinition } from "../../repertoire/tools-telegram-contacts"
import type { ToolDefinition } from "../../repertoire/tools-base"

const definitions: ToolDefinition[] = [...chatToolDefinitions, ...voiceToolDefinitions, telegramContactToolDefinition]

describe("chat, voice and Telegram contact tool cards", () => {
  it("gives every tool an Ouro AX card named after it, with its own error codes", () => {
    for (const definition of definitions) {
      const name = definition.tool.function.name
      expect(definition.ax?.id).toBe(`tool:${name}`)
      expect(definition.ax!.errors.length).toBeGreaterThan(0)
      for (const error of definition.ax!.errors) expect(error.code).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/)
    }
  })

  it("says write for every one of them, since none asks for approval and each changes something", () => {
    expect(definitions.map((definition) => definition.ax?.effect)).toEqual(definitions.map(() => "write"))
    expect(telegramContactToolDefinition.approvalPolicy!({}, undefined as never)).toEqual({ kind: "not_required" })
  })
})
