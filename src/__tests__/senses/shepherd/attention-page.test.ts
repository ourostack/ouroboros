import { afterEach, describe, expect, it, vi } from "vitest"
import { JSDOM } from "jsdom"
import { attentionPage } from "../../../senses/shepherd/attention-page"

const windows: JSDOM[] = []
afterEach(() => { for (const dom of windows.splice(0)) dom.window.close() })
const id = "11111111-1111-4111-8111-111111111111"
const initial = { targets: [{ id, label: "Ship attention" }], target: id, active: false, messages: [] as Array<{ role: string; text: string }> }

function page(options: { active?: boolean; messages?: typeof initial.messages; loseAck?: boolean; savedDraft?: string; fragment?: string } = {}) {
  let state = { ...initial, active: options.active ?? false, messages: options.messages ?? [] }
  const requests: Array<{ route: string; body?: { id: string; message: string } }> = []
  let poll: () => void = () => {}
  let lost = false
  const dom = new JSDOM(attentionPage("test"), {
    url: `http://127.0.0.1:12345/#${options.fragment ?? "a".repeat(64)}`, runScripts: "dangerously",
    beforeParse(window) {
      if (options.savedDraft) window.sessionStorage.setItem("ouroAttentionDraft", options.savedDraft)
      Object.defineProperty(window.crypto, "randomUUID", { value: () => crypto.randomUUID() })
      window.setInterval = ((fn: () => void) => { poll = fn; return 1 }) as typeof window.setInterval
      window.fetch = vi.fn(async (route, init) => {
        const body = init?.body ? JSON.parse(String(init.body)) : undefined
        requests.push({ route: String(route), body })
        if (route === "/send" && options.loseAck && !lost) { lost = true; throw new Error("ack lost") }
        if (route === "/send") state = { ...state, messages: [{ role: "you", text: body.message }] }
        return { ok: true, json: async () => state } as Response
      })
    },
  })
  windows.push(dom)
  return { dom, requests, poll: () => poll(), setState: (next: typeof state) => { state = next } }
}

describe("compact attention interaction", () => {
  it("renders replies as inert text and keeps them stable across polling", async () => {
    const { dom, poll } = page({ messages: [{ role: "ouro", text: '<img src=x onerror="window.attacked=true">' }] })
    await vi.waitFor(() => expect(dom.window.document.querySelector(".message")?.textContent).toContain("<img"))
    expect(dom.window.document.querySelector("#conversation img")).toBeNull()
    const message = dom.window.document.querySelector(".message")
    poll()
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(dom.window.document.querySelector(".message")).toBe(message)
  })

  it("keeps a draft during an active reply and disables Send and session switching", async () => {
    const { dom, requests } = page({ active: true, savedDraft: "my next thought" })
    await vi.waitFor(() => expect((dom.window.document.getElementById("target") as HTMLSelectElement).value).toBe(id))
    expect((dom.window.document.getElementById("send") as HTMLButtonElement).disabled).toBe(true)
    expect((dom.window.document.getElementById("target") as HTMLSelectElement).disabled).toBe(true)
    const draft = dom.window.document.getElementById("draft") as HTMLTextAreaElement
    expect(draft.value).toBe("my next thought")
    draft.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    expect(requests.filter(request => request.route === "/send")).toHaveLength(0)
  })

  it("preserves an unknown-ack draft and retries only the same request id", async () => {
    const { dom, requests } = page({ loseAck: true })
    const document = dom.window.document
    await vi.waitFor(() => expect((document.getElementById("send") as HTMLButtonElement).disabled).toBe(false))
    const draft = document.getElementById("draft") as HTMLTextAreaElement
    const submit = () => document.getElementById("compose")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }))
    draft.value = "continue this session"
    draft.dispatchEvent(new dom.window.Event("input"))
    submit()
    await vi.waitFor(() => expect(document.getElementById("error")!.textContent).toContain("ack lost"))
    expect(draft.value).toBe("continue this session")
    expect(dom.window.sessionStorage.getItem("ouroAttentionPending")).toBeTruthy()
    submit()
    await vi.waitFor(() => expect(draft.value).toBe(""))
    const sent = requests.filter(request => request.route === "/send")
    expect(sent).toHaveLength(2)
    expect(sent[0]!.body).toEqual(sent[1]!.body)
    expect(dom.window.sessionStorage.getItem("ouroAttentionPending")).toBeNull()
  })

  it("binds the native click's UUID before it starts polling, not after browser focus changes", async () => {
    const { requests } = page({ fragment: `${"a".repeat(64)}&session=${id}` })
    await vi.waitFor(() => expect(requests.length).toBe(1))
    expect(requests[0]).toEqual({ route: "/select", body: { target: id } })
  })
})
