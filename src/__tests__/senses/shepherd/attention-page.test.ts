import { afterEach, describe, expect, it, vi } from "vitest"
import { JSDOM } from "jsdom"
import { attentionPage } from "../../../senses/shepherd/attention-page"

const windows: JSDOM[] = []
afterEach(() => { for (const dom of windows.splice(0)) dom.window.close() })
const id = "11111111-1111-4111-8111-111111111111"
const initial = { targets: [{ id, label: "Ship attention" }], target: id, active: false, messages: [] as Array<{ role: string; text: string }> }

function page(options: { active?: boolean; messages?: typeof initial.messages; loseAck?: boolean; savedDraft?: string; fragment?: string;
  saved?: Record<string, string>; failFirstSelect?: boolean; deferSend?: boolean; reconcileAcks?: boolean } = {}) {
  let state = { ...initial, active: options.active ?? false, messages: options.messages ?? [] }
  const requests: Array<{ route: string; body?: { id: string; message: string } }> = []
  let poll: () => void = () => {}
  let lost = false
  let selectionFailed = false
  const held = Promise.withResolvers<void>()
  const accepted = new Map<string, { id: string; target: string }>()
  const dom = new JSDOM(attentionPage("test"), {
    url: `http://127.0.0.1:12345/#${options.fragment ?? "a".repeat(64)}`, runScripts: "dangerously",
    beforeParse(window) {
      if (options.savedDraft) window.sessionStorage.setItem("ouroAttentionDraft", options.savedDraft)
      for (const [key, value] of Object.entries(options.saved ?? {})) window.sessionStorage.setItem(key, value)
      Object.defineProperty(window.crypto, "randomUUID", { value: () => crypto.randomUUID() })
      window.setInterval = ((fn: () => void) => { poll = fn; return 1 }) as typeof window.setInterval
      window.fetch = vi.fn(async (route, init) => {
        const body = init?.body ? JSON.parse(String(init.body)) : undefined
        requests.push({ route: String(route), body })
        if (route === "/select" && options.failFirstSelect && !selectionFailed) { selectionFailed = true; throw new Error("initial discovery unavailable") }
        if (route === "/send") {
          accepted.set(body.id, { id: body.id, target: state.target })
          if (options.deferSend) await held.promise
        }
        if (route === "/send" && options.loseAck && !lost) { lost = true; throw new Error("ack lost") }
        if (route === "/send") state = { ...state, messages: [{ role: "you", text: body.message }] }
        const pending = (init?.headers as Record<string, string>)?.["X-Ouro-Pending"]
        const reply = { ...state, acknowledged: options.reconcileAcks && pending ? accepted.get(pending) ?? null : null }
        return { ok: true, json: async () => reply } as Response
      })
    },
  })
  windows.push(dom)
  return { dom, requests, poll: () => poll(), acknowledge: () => held.resolve(), setState: (next: typeof state) => { state = next } }
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

  it("blocks About changes while an accepted HTTP acknowledgement is unknown, including after reload", async () => {
    const first = page({ loseAck: true })
    const document = first.dom.window.document
    await vi.waitFor(() => expect((document.getElementById("send") as HTMLButtonElement).disabled).toBe(false))
    const draft = document.getElementById("draft") as HTMLTextAreaElement
    draft.value = "must not run twice"
    draft.dispatchEvent(new first.dom.window.Event("input"))
    document.getElementById("compose")!.dispatchEvent(new first.dom.window.Event("submit", { cancelable: true }))
    await vi.waitFor(() => expect(document.getElementById("error")!.textContent).toContain("ack lost"))
    const pending = JSON.parse(first.dom.window.sessionStorage.getItem("ouroAttentionPending")!)
    expect(pending.target).toBe(id)
    const picker = document.getElementById("target") as HTMLSelectElement
    expect(picker.disabled).toBe(true)
    picker.dispatchEvent(new first.dom.window.Event("change"))
    expect(JSON.parse(first.dom.window.sessionStorage.getItem("ouroAttentionPending")!)).toEqual(pending)
    const saved = Object.fromEntries(Object.keys(first.dom.window.sessionStorage).map(key => [key, first.dom.window.sessionStorage.getItem(key)!]))
    const restored = page({ saved })
    await vi.waitFor(() => expect((restored.dom.window.document.getElementById("target") as HTMLSelectElement).value).toBe(id))
    expect((restored.dom.window.document.getElementById("target") as HTMLSelectElement).disabled).toBe(true)
    restored.dom.window.document.getElementById("compose")!.dispatchEvent(new restored.dom.window.Event("submit", { cancelable: true }))
    await vi.waitFor(() => expect(restored.requests.some(request => request.route === "/send")).toBe(true))
    expect(restored.requests.find(request => request.route === "/send")!.body).toEqual(pending)
  })

  it("reconciles a lost HTTP acknowledgement from its exact per-view receipt without resubmitting", async () => {
    const { dom, requests, poll } = page({ loseAck: true, reconcileAcks: true })
    await vi.waitFor(() => expect((dom.window.document.getElementById("send") as HTMLButtonElement).disabled).toBe(false))
    const draft = dom.window.document.getElementById("draft") as HTMLTextAreaElement
    draft.value = "already accepted"
    draft.dispatchEvent(new dom.window.Event("input"))
    dom.window.document.getElementById("compose")!.dispatchEvent(new dom.window.Event("submit", { cancelable: true }))
    await vi.waitFor(() => expect(dom.window.sessionStorage.getItem("ouroAttentionPending")).toBeTruthy())
    poll()
    await vi.waitFor(() => expect(dom.window.sessionStorage.getItem("ouroAttentionPending")).toBeNull())
    expect(requests.filter(request => request.route === "/send")).toHaveLength(1)
    expect(draft.value).toBe("")
  })

  it("keeps polling after initialization fails, while forbidding sends until an explicit binding succeeds", async () => {
    const { dom, poll, requests, setState } = page({ failFirstSelect: true })
    const document = dom.window.document
    await vi.waitFor(() => expect(document.getElementById("error")!.textContent).toContain("unavailable"))
    expect((document.getElementById("send") as HTMLButtonElement).disabled).toBe(true)
    const picker = document.getElementById("target") as HTMLSelectElement
    picker.value = id
    picker.dispatchEvent(new dom.window.Event("change"))
    await vi.waitFor(() => expect((document.getElementById("send") as HTMLButtonElement).disabled).toBe(false))
    const draft = document.getElementById("draft") as HTMLTextAreaElement
    draft.value = "now bound"
    document.getElementById("compose")!.dispatchEvent(new dom.window.Event("submit", { cancelable: true }))
    await vi.waitFor(() => expect(requests.some(request => request.route === "/send")).toBe(true))
    await vi.waitFor(() => expect(draft.value).toBe(""))
    setState({ ...initial, messages: [{ role: "ouro", text: "reply after recovered initialization" }] })
    poll()
    await vi.waitFor(() => expect(document.getElementById("conversation")!.textContent).toContain("reply after recovered initialization"))
  })

  it("preserves edits made while the original send acknowledgement is in flight", async () => {
    const { dom, acknowledge } = page({ deferSend: true })
    const document = dom.window.document
    await vi.waitFor(() => expect((document.getElementById("send") as HTMLButtonElement).disabled).toBe(false))
    const draft = document.getElementById("draft") as HTMLTextAreaElement
    draft.value = "original message"
    document.getElementById("compose")!.dispatchEvent(new dom.window.Event("submit", { cancelable: true }))
    draft.value = "newer unsent thought"
    draft.dispatchEvent(new dom.window.Event("input"))
    acknowledge()
    await vi.waitFor(() => expect(dom.window.sessionStorage.getItem("ouroAttentionPending")).toBeNull())
    expect(draft.value).toBe("newer unsent thought")
    expect(dom.window.sessionStorage.getItem("ouroAttentionDraft")).toBe("newer unsent thought")
  })
})
