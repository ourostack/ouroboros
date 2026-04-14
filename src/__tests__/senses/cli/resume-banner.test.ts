import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../../heart/daemon/socket-client", () => ({
  DEFAULT_DAEMON_SOCKET_PATH: "/tmp/ouroboros-test-mock.sock",
  sendDaemonCommand: vi.fn().mockResolvedValue({ ok: true }),
  checkDaemonSocketAlive: vi.fn().mockResolvedValue(false),
}))

vi.mock("../../../heart/identity", () => ({
  getAgentName: vi.fn(() => "testagent"),
  resetAgentConfigCache: vi.fn(),
  loadAgentConfig: vi.fn(() => ({
    name: "testagent",
    provider: "minimax",
    phrases: {
      thinking: ["pondering"],
      tool: ["working"],
      followup: ["continuing"],
    },
  })),
}))

import { TuiStore } from "../../../senses/cli/tui-store"
import type { TuiProps } from "../../../senses/cli/ouro-tui"
import { emitNervesEvent } from "../../../nerves/runtime"

describe("Resume banner and regular messages", () => {
  let store: TuiStore

  beforeEach(() => {
    store = new TuiStore()
    emitNervesEvent({
      component: "senses",
      event: "senses.resume_banner_test_start",
      message: "Resume banner test started",
      meta: {},
    })
  })

  describe("TuiStore.addResumeMessages", () => {
    it("pushes exchanges as normal user/assistant messages to completedMessages", () => {
      store.addResumeMessages([
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ])

      const completed = store.completedMessages
      expect(completed).toHaveLength(2)
      expect(completed[0].role).toBe("user")
      expect(completed[0].content).toBe("hi")
      expect(completed[1].role).toBe("assistant")
      expect(completed[1].content).toBe("hello")
    })

    it("does not touch inputHistory", () => {
      expect(store.inputHistory).toHaveLength(0)

      store.addResumeMessages([
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ])

      expect(store.inputHistory).toHaveLength(0)
    })

    it("prepends resume messages before any existing completed messages", () => {
      store.addUserMessage("new message")
      store.addResumeMessages([
        { role: "user", content: "old" },
        { role: "assistant", content: "old reply" },
      ])

      const completed = store.completedMessages
      // Resume messages should come before the new message
      expect(completed[0].content).toBe("old")
      expect(completed[1].content).toBe("old reply")
      expect(completed[2].content).toBe("new message")
    })

    it("handles empty exchanges array", () => {
      store.addResumeMessages([])
      expect(store.completedMessages).toHaveLength(0)
    })

    it("notifies subscribers", () => {
      const listener = vi.fn()
      store.subscribe(listener)
      listener.mockClear()

      store.addResumeMessages([{ role: "user", content: "hi" }])
      expect(listener).toHaveBeenCalled()
    })
  })

  describe("TuiProps.resumeInfo", () => {
    it("accepts optional resumeInfo field with correct shape", () => {
      // Compile-time: TuiProps should accept resumeInfo
      const props: Pick<TuiProps, "resumeInfo"> = {
        resumeInfo: { messageCount: 5, timeAgo: "3m ago" },
      }
      expect(props.resumeInfo).toBeDefined()
      expect(props.resumeInfo!.messageCount).toBe(5)
      expect(props.resumeInfo!.timeAgo).toBe("3m ago")
    })

    it("allows resumeInfo to be undefined", () => {
      const props: Pick<TuiProps, "resumeInfo"> = {}
      expect(props.resumeInfo).toBeUndefined()
    })

    it("rejects invalid resumeInfo shape at compile time", () => {
      // @ts-expect-error -- resumeInfo requires messageCount and timeAgo
      const _props: Pick<TuiProps, "resumeInfo"> = { resumeInfo: { wrong: true } }
      void _props
    })
  })
})
