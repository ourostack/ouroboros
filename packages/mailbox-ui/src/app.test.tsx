import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { App } from "./app"
import { TestEventSource, agentView, defaultResponse, jsonResponse, machineView } from "./test-fixtures"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function source(): TestEventSource {
  return TestEventSource.instances.at(-1)!
}

beforeEach(() => {
  window.history.replaceState(null, "", "/")
  TestEventSource.instances = []
  vi.stubGlobal("EventSource", TestEventSource)
  vi.stubGlobal("fetch", vi.fn(async (url: string) => defaultResponse(url)))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("Mailbox current identity and connection", () => {
  it("opens machine-level Supervision without fetching an arbitrary agent inspector", async () => {
    window.history.replaceState(null, "", "#/supervision")
    render(<App />)
    expect(await screen.findByRole("heading", { name: "Supervision" })).toBeTruthy()
    expect(screen.getByText(/choose an owning Ouro agent/i)).toBeTruthy()
    expect(vi.mocked(fetch).mock.calls.every(([url]) => url === "/api/machine")).toBe(true)
    fireEvent.change(screen.getByLabelText("Owning Ouro agent"), { target: { value: "beta" } })
    expect(await screen.findByText("beta terminal")).toBeTruthy()
    expect(window.location.hash).toBe("#/supervision/beta")
    expect(vi.mocked(fetch).mock.calls.some(([url]) => url === "/api/agents/beta")).toBe(false)
  })

  it("preserves agent navigation while opening Supervision directly and by sidebar", async () => {
    window.history.replaceState(null, "", "#/supervision/alpha/cmux%3ASF-1")
    render(<App />)
    expect(await screen.findByText("alpha terminal")).toBeTruthy()
    expect(screen.getByText("Timeline for alpha terminal").parentElement?.hasAttribute("open")).toBe(true)
    fireEvent.click(screen.getByRole("button", { name: /^beta/ }))
    expect(await screen.findByText("Owned by beta")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Supervision" }))
    expect(screen.getByRole("heading", { name: "Supervision" })).toBeTruthy()
    expect(screen.queryByText("Owned by beta")).toBeNull()
  })

  it("renders an actionable initial machine failure instead of an endless spinner", async () => {
    let failed = false
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "/api/machine" && !failed) { failed = true; return jsonResponse({}, 503) }
      return defaultResponse(url)
    }))
    render(<App />)
    expect(await screen.findByRole("alert")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: /retry/i }))
    expect(await screen.findByRole("heading", { name: "alpha" })).toBeTruthy()
  })

  it("identifies an initial agent failure without telling the user to select again", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      url === "/api/agents/alpha" ? jsonResponse({}, 404) : defaultResponse(url)))
    render(<App />)
    expect((await screen.findByRole("alert")).textContent).toMatch(/alpha/)
    expect(screen.queryByText("Choose an agent")).toBeNull()
  })

  it("clears the previous agent immediately when selecting a new identity", async () => {
    const beta = deferred<Response>()
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      url === "/api/agents/beta" ? beta.promise : defaultResponse(url)))
    render(<App />)
    await screen.findByText("Owned by alpha")
    fireEvent.click(screen.getByRole("button", { name: /^beta/ }))
    expect(screen.queryByText("Owned by alpha")).toBeNull()
    expect(screen.getByText(/loading beta/i)).toBeTruthy()
    await act(async () => beta.resolve(jsonResponse(agentView("beta"))))
    expect(await screen.findByText("Owned by beta")).toBeTruthy()
  })

  it("ignores an older agent response that arrives after the selected agent", async () => {
    const alpha = deferred<Response>()
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      url === "/api/agents/alpha" ? alpha.promise : defaultResponse(url)))
    render(<App />)
    fireEvent.click(await screen.findByRole("button", { name: /^beta/ }))
    await screen.findByText("Owned by beta")
    await act(async () => alpha.resolve(jsonResponse(agentView("alpha"))))
    expect(screen.queryByText("Owned by alpha")).toBeNull()
    expect(screen.getByText("Owned by beta")).toBeTruthy()
    expect(screen.getByRole("heading", { name: "beta" })).toBeTruthy()
  })

  it("does not clear the selected agent when a prior identity's failed request finishes", async () => {
    const alpha = deferred<Response>()
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      url === "/api/agents/alpha" ? alpha.promise : defaultResponse(url)))
    render(<App />)
    fireEvent.click(await screen.findByRole("button", { name: /^beta/ }))
    await screen.findByText("Owned by beta")
    await act(async () => alpha.resolve(jsonResponse({}, 404)))
    expect(screen.getByText("Owned by beta")).toBeTruthy()
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("refuses a response whose agent identity does not match the requested owner", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      url === "/api/agents/alpha" ? jsonResponse(agentView("beta")) : defaultResponse(url)))
    render(<App />)
    expect((await screen.findByRole("alert")).textContent).toMatch(/another agent/)
    expect(screen.queryByText("Owned by alpha")).toBeNull()
    expect(screen.queryByRole("heading", { name: "alpha" })).toBeNull()
  })

  it("aborts pending network work when the application unmounts", async () => {
    const pending = deferred<Response>()
    let requestSignal: AbortSignal | null | undefined
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/machine") {
        requestSignal = init?.signal
        return pending.promise
      }
      return defaultResponse(url)
    }))
    const app = render(<App />)
    app.unmount()
    expect(requestSignal?.aborted).toBe(true)
    await act(async () => pending.resolve(jsonResponse(machineView())))
    expect(screen.queryByText("Owned by alpha")).toBeNull()
  })

  it("ignores an older machine refresh after a newer snapshot has committed", async () => {
    render(<App />)
    await screen.findByText("Owned by alpha")
    const older = deferred<Response>()
    let refreshing = 0
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "/api/machine") {
        refreshing += 1
        return refreshing === 1 ? older.promise : jsonResponse(machineView("newer-snapshot"))
      }
      return defaultResponse(url)
    }))
    act(() => source().change())
    act(() => source().change())
    await screen.findByText("newer-snapshot")
    await act(async () => older.resolve(jsonResponse(machineView("older-snapshot"))))
    expect(screen.queryByText("older-snapshot")).toBeNull()
    expect(screen.getByText("newer-snapshot")).toBeTruthy()
  })

  it("shows disconnection and refreshes on open without a filesystem event", async () => {
    render(<App />)
    await screen.findByText("Owned by alpha")
    act(() => source().disconnect())
    expect(screen.getByText(/reconnecting|disconnected/i)).toBeTruthy()
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      url === "/api/machine" ? jsonResponse(machineView("reconnected-snapshot")) : defaultResponse(url)))
    act(() => source().open())
    expect(await screen.findByText("reconnected-snapshot")).toBeTruthy()
    await waitFor(() => expect(screen.queryByText(/reconnecting|disconnected/i)).toBeNull())
  })

  it("keeps only same-identity data with an explicit failed-refresh label", async () => {
    render(<App />)
    await screen.findByText("Owned by alpha")
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      url === "/api/agents/alpha" ? jsonResponse({}, 503) : defaultResponse(url)))
    act(() => source().change())
    expect((await screen.findByRole("alert")).textContent).toMatch(/alpha/)
    expect(screen.getByText("Owned by alpha")).toBeTruthy()
    expect(screen.getByText(/last successful snapshot for alpha/i)).toBeTruthy()
  })
})
