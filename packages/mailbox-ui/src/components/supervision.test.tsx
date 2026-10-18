import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Supervision } from "./supervision"
import { jsonResponse, supervisionView } from "../test-fixtures"

const props = { agents: ["alpha", "beta"], agentName: "alpha", refreshGeneration: 0, onSelectOwner: vi.fn() }
const deferred = () => {
  let resolve!: (response: Response) => void
  const promise = new Promise<Response>(done => { resolve = done })
  return { promise, resolve }
}
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(supervisionView("alpha"))))
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe("Supervision", () => {
  it("copies exact local inspection and evidence-checked retirement commands without sending browser mutations", async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } })
    render(<Supervision {...props} />)
    await screen.findByText("alpha terminal")
    fireEvent.click(screen.getByRole("button", { name: "Copy inspection command" }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`ouro shepherd inspect --agent 'alpha' --id '${"a".repeat(64)}' --json`))
    fireEvent.click(screen.getByText("Local recovery after terminal retirement"))
    fireEvent.click(screen.getByRole("button", { name: "Copy retirement command" }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining("--resolution retired --expected-revision 3")))
    expect(screen.getByText(/entire terminal must be absent/i)).toBeTruthy()
    expect(vi.mocked(fetch).mock.calls.every(([, options]) => !options?.method || options.method === "GET")).toBe(true)
  })

  it("makes clipboard failure explicit and keeps selectable command text", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn(async () => { throw new Error("denied") }) } })
    render(<Supervision {...props} />)
    await screen.findByText("alpha terminal")
    fireEvent.click(screen.getByRole("button", { name: "Copy status command" }))
    expect((await screen.findByRole("alert")).textContent).toMatch(/copy failed.*select.*command/i)
    expect(screen.getByText("ouro shepherd status --agent 'alpha' --json")).toBeTruthy()
  })

  it("does not manufacture a mutation command from an unknown custody revision", async () => {
    const view = supervisionView("alpha")
    view.custody.revision = null
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(view)))
    render(<Supervision {...props} />)
    await screen.findByText("alpha terminal")
    expect(screen.queryByRole("button", { name: "Copy retirement command" })).toBeNull()
    expect(screen.getByRole("button", { name: "Copy inspection command" })).toBeTruthy()
  })

  it("opens at machine level without choosing an arbitrary owning agent", () => {
    render(<Supervision {...props} agentName={null} />)
    expect(screen.getByRole("heading", { name: "Supervision" })).toBeTruthy()
    expect(screen.getByLabelText("Owning Ouro agent")).toBeTruthy()
    expect(screen.getByText(/choose an owning Ouro agent/i)).toBeTruthy()
    expect(fetch).not.toHaveBeenCalled()
  })

  it("renders honest terminal activity, observation age, historical judgment and read-only custody", async () => {
    render(<Supervision {...props} />)
    expect(await screen.findByText("alpha terminal")).toBeTruthy()
    expect(screen.getByText("Agent reports finished")).toBeTruthy()
    expect(screen.getByText(/not proof of merge, publication or deployment/i)).toBeTruthy()
    expect(screen.getByText(/Original state: unknown/)).toBeTruthy()
    expect(screen.getByText(/do not retry blindly/i)).toBeTruthy()
    expect(screen.queryByRole("button", { name: /retry input|resume|approve|reconcile/i })).toBeNull()
    expect(screen.getByText(/Observation age:/)).toBeTruthy()
    expect(screen.getByText(/Guarded input: unsupported/)).toBeTruthy()
    expect(screen.getByText(/Last recorded action: Let through without a response/)).toBeTruthy()
  })

  it("never commits late data for a previous owner and clears old identity immediately", async () => {
    const alpha = deferred()
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("/alpha/") ? alpha.promise : jsonResponse(supervisionView("beta"))))
    const app = render(<Supervision {...props} />)
    app.rerender(<Supervision {...props} agentName="beta" />)
    expect(await screen.findByText("beta terminal")).toBeTruthy()
    await act(async () => alpha.resolve(jsonResponse(supervisionView("alpha"))))
    expect(screen.queryByText("alpha terminal")).toBeNull()
    expect(screen.getByText("beta terminal")).toBeTruthy()
  })

  it("refuses a response for another owner and exposes an actionable initial failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(supervisionView("beta"))))
    render(<Supervision {...props} />)
    expect((await screen.findByRole("alert")).textContent).toMatch(/another agent/)
    expect(screen.getByRole("button", { name: /retry observation/i })).toBeTruthy()
    expect(screen.queryByText("beta terminal")).toBeNull()
  })

  it("retains only same-owner history with an explicit failed refresh label", async () => {
    const app = render(<Supervision {...props} />)
    await screen.findByText("alpha terminal")
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({}, 503)))
    app.rerender(<Supervision {...props} refreshGeneration={1} />)
    expect((await screen.findByRole("alert")).textContent).toMatch(/last successful observation for alpha/i)
    expect(screen.getByText("alpha terminal")).toBeTruthy()
  })

  it("coalesces refreshes while a read is in flight instead of aborting every event", async () => {
    const first = deferred()
    const fetcher = vi.fn(async () => first.promise)
    vi.stubGlobal("fetch", fetcher)
    const app = render(<Supervision {...props} />)
    app.rerender(<Supervision {...props} refreshGeneration={1} />)
    app.rerender(<Supervision {...props} refreshGeneration={2} />)
    expect(fetcher).toHaveBeenCalledTimes(1)
    fetcher.mockImplementation(async () => jsonResponse(supervisionView("alpha")))
    await act(async () => first.resolve(jsonResponse(supervisionView("alpha"))))
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))
  })

  it("ages displayed observations locally and refreshes at five seconds only while visible", async () => {
    vi.useFakeTimers()
    const current = supervisionView("alpha")
    current.freshness.observedAt = new Date().toISOString()
    current.sessions.items[0]!.observedAt = current.freshness.observedAt
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(current)))
    render(<Supervision {...props} />)
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(screen.getByTestId("supervision-freshness").textContent).toContain("fresh")
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(fetch).toHaveBeenCalledTimes(2)
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" })
    await act(async () => { await vi.advanceTimersByTimeAsync(30_001) })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId("supervision-freshness").textContent).toContain("stale")
    expect(screen.getByTestId("supervision-count-idle").textContent).toBe("0")
    expect(screen.getByTestId("supervision-count-unknown").textContent).toBe("1")
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" })
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); await Promise.resolve() })
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it("renders unavailable counts as unknown, preserves truncation, and navigates native details by keyboard", async () => {
    const view = supervisionView("alpha")
    view.counts = null
    view.sessions.totalCount = 300
    view.sessions.truncated = true
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(view)))
    render(<Supervision {...props} />)
    await screen.findByText("alpha terminal")
    expect(screen.getByTestId("supervision-count-idle").textContent).toBe("Unknown")
    expect(screen.getByText(/Showing 1 of 300 terminals/)).toBeTruthy()
    const summary = screen.getByText("Timeline for alpha terminal")
    expect(summary.tagName).toBe("SUMMARY")
    fireEvent.change(screen.getByLabelText("Owning Ouro agent"), { target: { value: "beta" } })
    expect(props.onSelectOwner).toHaveBeenCalledWith("beta")
  })
})
