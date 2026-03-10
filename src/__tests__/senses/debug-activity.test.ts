import { describe, expect, it, vi } from "vitest"

describe("debug activity controller", () => {
  it("uses one evolving status lane with typing and followup transitions", async () => {
    const operations: string[] = []
    const { createDebugActivityController } = await import("../../senses/debug-activity")
    const controller = createDebugActivityController({
      thinkingPhrases: ["thinking"],
      followupPhrases: ["followup"],
      transport: {
        sendStatus: vi.fn(async (text: string) => {
          operations.push(`send:${text}`)
          return "status-guid"
        }),
        editStatus: vi.fn(async (messageGuid: string, text: string) => {
          operations.push(`edit:${messageGuid}:${text}`)
        }),
        setTyping: vi.fn(async (active: boolean) => {
          operations.push(`typing:${active}`)
        }),
      },
    })

    controller.onModelStart()
    controller.onToolStart("read_file", { path: "notes.txt" })
    controller.onToolEnd("read_file", "ok", true)
    controller.onTextChunk("final answer incoming")
    await controller.finish()

    expect(operations).toEqual([
      "send:thinking...",
      "typing:true",
      "edit:status-guid:running read_file (notes.txt)...",
      "edit:status-guid:\u2713 read_file (ok)",
      "edit:status-guid:followup...",
      "typing:false",
    ])
  })

  it("re-sends status updates when the initial send returns no message guid", async () => {
    const sendStatus = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce("status-guid")
    const editStatus = vi.fn()
    const setTyping = vi.fn()
    const { createDebugActivityController } = await import("../../senses/debug-activity")
    const controller = createDebugActivityController({
      thinkingPhrases: ["thinking"],
      followupPhrases: ["followup"],
      transport: { sendStatus, editStatus, setTyping },
    })

    controller.onModelStart()
    controller.onToolStart("grep", {})
    await controller.finish()

    expect(sendStatus).toHaveBeenNthCalledWith(1, "thinking...")
    expect(sendStatus).toHaveBeenNthCalledWith(2, "running grep...")
    expect(editStatus).not.toHaveBeenCalled()
    expect(setTyping).toHaveBeenNthCalledWith(1, true)
    expect(setTyping).toHaveBeenNthCalledWith(2, false)
  })

  it("reports transport failures without breaking later operations", async () => {
    const onTransportError = vi.fn()
    const sendStatus = vi.fn().mockResolvedValue("status-guid")
    const editStatus = vi
      .fn()
      .mockRejectedValueOnce(new Error("edit down"))
      .mockResolvedValueOnce(undefined)
    const setTyping = vi.fn().mockResolvedValue(undefined)
    const { createDebugActivityController } = await import("../../senses/debug-activity")
    const controller = createDebugActivityController({
      thinkingPhrases: ["thinking"],
      followupPhrases: ["followup"],
      transport: { sendStatus, editStatus, setTyping },
      onTransportError,
    })

    controller.onModelStart()
    controller.onToolStart("read_file", {})
    controller.onToolEnd("read_file", "ok", true)
    await controller.finish()

    expect(onTransportError).toHaveBeenCalledTimes(1)
    expect(onTransportError).toHaveBeenCalledWith("status_update", expect.any(Error))
    expect(editStatus).toHaveBeenNthCalledWith(1, "status-guid", "running read_file...")
    expect(editStatus).toHaveBeenNthCalledWith(2, "status-guid", "\u2713 read_file (ok)")
  })

  it("formats errors through the shared formatter and stops typing", async () => {
    const operations: string[] = []
    const { createDebugActivityController } = await import("../../senses/debug-activity")
    const controller = createDebugActivityController({
      thinkingPhrases: ["thinking"],
      followupPhrases: ["followup"],
      transport: {
        sendStatus: vi.fn(async (text: string) => {
          operations.push(`send:${text}`)
          return "status-guid"
        }),
        editStatus: vi.fn(async (messageGuid: string, text: string) => {
          operations.push(`edit:${messageGuid}:${text}`)
        }),
        setTyping: vi.fn(async (active: boolean) => {
          operations.push(`typing:${active}`)
        }),
      },
    })

    controller.onModelStart()
    controller.onError(new Error("boom"))
    await controller.finish()

    expect(operations).toEqual([
      "send:thinking...",
      "typing:true",
      "edit:status-guid:Error: boom",
      "typing:false",
    ])
  })

  it("can restart a turn in followup mode and surfaces non-Error transport failures", async () => {
    const onTransportError = vi.fn()
    const { createDebugActivityController } = await import("../../senses/debug-activity")
    const controller = createDebugActivityController({
      thinkingPhrases: ["thinking"],
      followupPhrases: ["followup"],
      transport: {
        sendStatus: vi.fn().mockRejectedValue("send failed"),
        editStatus: vi.fn(),
        setTyping: vi.fn().mockResolvedValue(undefined),
      },
      onTransportError,
    })

    controller.onToolStart("grep", {})
    controller.onModelStart()
    await controller.finish()

    expect(onTransportError).toHaveBeenCalledWith("status_update", "send failed")
  })

  it("can start typing before the initial visible status when configured", async () => {
    const operations: string[] = []
    const { createDebugActivityController } = await import("../../senses/debug-activity")
    const controller = createDebugActivityController({
      thinkingPhrases: ["thinking"],
      followupPhrases: ["followup"],
      transport: {
        sendStatus: vi.fn(async (text: string) => {
          operations.push(`send:${text}`)
          return "status-guid"
        }),
        editStatus: vi.fn(async (messageGuid: string, text: string) => {
          operations.push(`edit:${messageGuid}:${text}`)
        }),
        setTyping: vi.fn(async (active: boolean) => {
          operations.push(`typing:${active}`)
        }),
      },
      startTypingOnModelStart: true,
    } as any)

    controller.onModelStart()
    controller.onToolStart("read_file", { path: "notes.txt" })
    await controller.finish()

    expect(operations).toEqual([
      "typing:true",
      "send:thinking...",
      "edit:status-guid:running read_file (notes.txt)...",
      "typing:false",
    ])
  })

  it("can start and stop typing on a short turn without waiting for a visible status to begin", async () => {
    const operations: string[] = []
    const { createDebugActivityController } = await import("../../senses/debug-activity")
    const controller = createDebugActivityController({
      thinkingPhrases: ["thinking"],
      followupPhrases: ["followup"],
      transport: {
        sendStatus: vi.fn(async (text: string) => {
          operations.push(`send:${text}`)
          return "status-guid"
        }),
        editStatus: vi.fn(async (messageGuid: string, text: string) => {
          operations.push(`edit:${messageGuid}:${text}`)
        }),
        setTyping: vi.fn(async (active: boolean) => {
          operations.push(`typing:${active}`)
        }),
      },
      startTypingOnModelStart: true,
    } as any)

    controller.onModelStart()
    await controller.finish()

    expect(operations).toEqual([
      "typing:true",
      "send:thinking...",
      "typing:false",
    ])
  })
})
