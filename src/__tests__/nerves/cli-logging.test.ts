import { beforeEach, describe, expect, it, vi } from "vitest"

const createNdjsonFileSink = vi.hoisted(() => vi.fn(() => vi.fn()))
const createLogger = vi.hoisted(() => vi.fn(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
})))
const setRuntimeLogger = vi.hoisted(() => vi.fn())
const logPath = vi.hoisted(() => vi.fn(() => "/tmp/testagent-cli-runtime.ndjson"))

vi.mock("../../nerves", async () => {
  const actual = await vi.importActual<typeof import("../../nerves")>("../../nerves")
  return {
    ...actual,
    createTraceId: vi.fn(() => "trace-123"),
    createNdjsonFileSink: (...args: unknown[]) => createNdjsonFileSink(...args),
    createLogger: (...args: unknown[]) => createLogger(...args),
  }
})

vi.mock("../../nerves/runtime", async () => {
  const actual = await vi.importActual<typeof import("../../nerves/runtime")>("../../nerves/runtime")
  return {
    ...actual,
    setRuntimeLogger: (...args: unknown[]) => setRuntimeLogger(...args),
  }
})

vi.mock("../../heart/config", async () => {
  const actual = await vi.importActual<typeof import("../../heart/config")>("../../heart/config")
  return {
    ...actual,
    logPath: (...args: unknown[]) => logPath(...args),
  }
})

describe("CLI logging contract", () => {
  beforeEach(() => {
    createNdjsonFileSink.mockClear()
    createLogger.mockClear()
    setRuntimeLogger.mockClear()
    logPath.mockClear()
  })

  it("exports a CLI runtime logger configurator that routes nerves logs to terminal + NDJSON sinks by default", async () => {
    const cli = await import("../../nerves/cli-logging")
    expect(typeof (cli as { configureCliRuntimeLogger?: unknown }).configureCliRuntimeLogger).toBe("function")
    ;(cli as { configureCliRuntimeLogger: (friendId: string) => void }).configureCliRuntimeLogger("friend-123")

    expect(logPath).toHaveBeenCalledWith("cli", "runtime")
    expect(createNdjsonFileSink).toHaveBeenCalledWith(
      "/tmp/testagent-cli-runtime.ndjson",
      expect.objectContaining({
        maxSizeBytes: 25 * 1024 * 1024,
        maxGenerations: 5,
        compress: true,
      }),
    )
    expect(createLogger).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "info",
        sinks: [expect.any(Function), expect.any(Function)],
      }),
    )
    expect(setRuntimeLogger).toHaveBeenCalledTimes(1)
  })

  it("supports sink selection override", async () => {
    const cli = await import("../../nerves/cli-logging")
    ;(cli as any).configureCliRuntimeLogger("friend-123", { sinks: ["terminal"] })

    expect(logPath).not.toHaveBeenCalled()
    expect(createNdjsonFileSink).not.toHaveBeenCalled()
    expect(createLogger).toHaveBeenCalledWith(
      expect.objectContaining({
        sinks: [expect.any(Function)],
      }),
    )
  })
})
