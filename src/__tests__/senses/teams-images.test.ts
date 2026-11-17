import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ProviderRuntime } from "../../heart/core"

const mocks = vi.hoisted(() => ({ getProviderRuntime: vi.fn() }))
vi.mock("../../heart/core", () => ({ getProviderRuntime: mocks.getProviderRuntime }))

import { teamsInboundText } from "../../senses/teams-attachments"

let root = ""
afterEach(() => {
  vi.resetAllMocks()
  if (root) fs.rmSync(root, { recursive: true, force: true })
})

describe("Teams image understanding", () => {
  it("carries downloaded image bytes into the configured Copilot provider without MiniMax credentials", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "teams-images-"))
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYZkAAAAASUVORK5CYII=", "base64")
    const streamTurn = vi.fn<ProviderRuntime["streamTurn"]>().mockResolvedValue({
      content: "a synthetic screenshot",
      toolCalls: [],
      outputItems: [],
    })
    mocks.getProviderRuntime.mockResolvedValue({
      id: "github-copilot", model: "claude-opus-5.5", streamTurn, resetTurnState: vi.fn(),
    })

    const result = await teamsInboundText("what is shown?", {
      agentName: "synthetic-agent",
      agentRoot: root,
      getBotToken: async () => "synthetic-bot-token",
      fetch: vi.fn(async () => new Response(png, { headers: { "content-type": "image/png" } })),
      attachments: [{
        contentType: "image/png", name: "synthetic.png",
        contentUrl: "https://smba.trafficmanager.net/amer/v3/attachments/synthetic/views/original",
      }],
    })

    expect(result).toContain("[image description: a synthetic screenshot]")
    expect(result).not.toContain("image description failed")
    expect(mocks.getProviderRuntime).toHaveBeenCalledWith("human", { agentName: "synthetic-agent", agentRoot: root })
    expect(streamTurn.mock.calls[0]![0].messages).toEqual([{
      role: "user",
      content: [
        { type: "text", text: expect.stringContaining('User message: "what is shown?"') },
        { type: "image_url", image_url: { url: `data:image/png;base64,${png.toString("base64")}` } },
      ],
    }])
  })
})
