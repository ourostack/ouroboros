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
  it("does not promote an initially future-dated payload when the clock catches up or the same payload is repolled", async () => {
    vi.useFakeTimers()
    const view = supervisionView("alpha")
    const future = new Date(Date.now() + 60_000).toISOString()
    view.freshness.observedAt = future
    Object.assign(view.sessions.items[0]!, { observedAt: future, capability: "supported", managed: {
      kind: "agent_session", provider: "copilot", profileSha256: "b".repeat(64), qualification: "qualified",
      qualificationReason: null, workCoverage: "complete", renderCaptureStartedAt: future,
    } })
    Object.assign(view.custody.claims.items[0]!, { managed: {
      receiptVersion: 1, nativeRequestId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      provider: "copilot", profileSha256: "b".repeat(64), editorInserted: true,
      backendWriteAdmitted: true, providerAcknowledged: true, providerInputId: "historical-ack",
    } })
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(view)))
    const app = render(<Supervision {...props} />)
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(screen.getByText(/Native qualification: unknown/)).toBeTruthy()
    await act(async () => { await vi.advanceTimersByTimeAsync(61_000) })
    expect(screen.getByText(/Native qualification: unknown/)).toBeTruthy()
    expect(screen.getByText(/Native work coverage: unknown/)).toBeTruthy()
    expect(screen.getByTestId("supervision-freshness").textContent).toContain("unknown")
    expect(screen.getByText(/Render capture age upper bound:/).textContent).toContain("unknown")
    expect(screen.getByText("Provider acknowledgement: proven")).toBeTruthy()
    const fresh = new Date().toISOString()
    view.freshness.observedAt = fresh
    view.sessions.items[0]!.observedAt = fresh
    Object.assign(view.sessions.items[0]!.managed!, { renderCaptureStartedAt: fresh })
    app.rerender(<Supervision {...props} refreshGeneration={1} />)
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(screen.getByText(/Native qualification: qualified/)).toBeTruthy()
    expect(screen.getByText("Provider acknowledgement: proven")).toBeTruthy()
  })

  it("never revives aged managed currentness on clock rollback or an identical successful repoll", async () => {
    vi.useFakeTimers()
    const at = Date.now()
    const view = supervisionView("alpha")
    Object.assign(view.sessions.items[0]!, { capability: "supported", managed: {
      kind: "agent_session", provider: "copilot", profileSha256: "b".repeat(64), qualification: "qualified",
      qualificationReason: null, workCoverage: "complete", renderCaptureStartedAt: new Date(at).toISOString(),
    } })
    Object.assign(view.custody.claims.items[0]!, { managed: {
      receiptVersion: 1, nativeRequestId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      provider: "copilot", profileSha256: "b".repeat(64), editorInserted: true,
      backendWriteAdmitted: true, providerAcknowledged: true, providerInputId: "historical-ack",
    } })
    let unavailable = false
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(unavailable ? {} : view, unavailable ? 503 : 200)))
    const app = render(<Supervision {...props} />)
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(screen.getByText(/Native qualification: qualified/)).toBeTruthy()
    unavailable = true
    await act(async () => { await vi.advanceTimersByTimeAsync(31_000) })
    expect(screen.getByText(/Native qualification: unknown/)).toBeTruthy()
    vi.setSystemTime(at + 10_000)
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
    expect(screen.getByText(/Native qualification: unknown/)).toBeTruthy()
    expect(screen.getByText(/Native work coverage: unknown/)).toBeTruthy()
    expect(screen.getByText("Provider acknowledgement: proven")).toBeTruthy()
    unavailable = false
    app.rerender(<Supervision {...props} refreshGeneration={1} />)
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(screen.getByText(/Native qualification: unknown/)).toBeTruthy()
    expect(screen.getByTestId("supervision-count-unknown").textContent).toBe("1")
    expect(screen.getByText("Provider acknowledgement: proven")).toBeTruthy()
  })

  it.each([false, true, null])("renders managed custody evidence %s separately from current qualification without inventing no effects", async stage => {
    const view = supervisionView("alpha")
    Object.assign(view.sessions.items[0]!, { managed: {
      kind: "agent_session", provider: "copilot", profileSha256: "b".repeat(64), qualification: "unqualified",
      qualificationReason: "managed_native_runtime_unqualified", workCoverage: "complete",
      renderCaptureStartedAt: view.freshness.observedAt,
    } })
    Object.assign(view.custody.claims.items[0]!, { managed: {
      receiptVersion: stage === null ? null : 1, nativeRequestId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      provider: "copilot", profileSha256: "b".repeat(64),
      editorInserted: stage, backendWriteAdmitted: stage, providerAcknowledged: stage,
      providerInputId: stage ? "exact-provider-ack" : null,
    } })
    if (stage) view.custody.claims.items[0]!.state = "sent"
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(view)))
    render(<Supervision {...props} />)
    await screen.findByText("alpha terminal")
    expect(screen.getByText(/Session kind: agent_session/)).toBeTruthy()
    expect(screen.getByText(/Provider: copilot/)).toBeTruthy()
    expect(screen.getAllByText("b".repeat(64)).length).toBeGreaterThan(0)
    expect(screen.getByText(/Native qualification: unqualified/).textContent).toContain("managed_native_runtime_unqualified")
    expect(screen.getByText(/Native work coverage: complete/)).toBeTruthy()
    expect(screen.getByText(/Render capture age upper bound:/)).toBeTruthy()
    const expected = stage === null ? "unknown" : stage ? "proven" : "unproven"
    expect(screen.getByText(`Editor insertion: ${expected}`)).toBeTruthy()
    expect(screen.getByText(`Backend write: ${expected}`)).toBeTruthy()
    expect(screen.getByText(`Provider acknowledgement: ${expected}`)).toBeTruthy()
    expect(screen.getByText(/Native request:/).textContent).toContain("ffffffff-ffff-4fff-8fff-ffffffffffff")
    expect(screen.getByText(/Exact managed receipt lookup is read-only/)).toBeTruthy()
    expect(screen.queryByText(/not inserted|not written|delivery confirmed|task completed/i)).toBeNull()
    if (stage) expect(screen.getByText(/exact-provider-ack/)).toBeTruthy()
    expect(vi.mocked(fetch).mock.calls.every(([, options]) => !options?.method || options.method === "GET")).toBe(true)
  })

  it("ages managed qualification and work coverage in the rendered browser without aging historical ACK evidence", async () => {
    vi.useFakeTimers()
    const view = supervisionView("alpha")
    Object.assign(view.sessions.items[0]!, { managed: {
      kind: "agent_session", provider: "copilot", profileSha256: "b".repeat(64), qualification: "qualified",
      qualificationReason: null, workCoverage: "complete", renderCaptureStartedAt: new Date().toISOString(),
    } })
    Object.assign(view.custody.claims.items[0]!, { managed: {
      receiptVersion: 1, nativeRequestId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      provider: "copilot", profileSha256: "b".repeat(64), editorInserted: true,
      backendWriteAdmitted: true, providerAcknowledged: true, providerInputId: "historical-ack",
    } })
    view.custody.claims.items[0]!.state = "sent"
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(view)))
    render(<Supervision {...props} />)
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(screen.getByText(/Native qualification: qualified/)).toBeTruthy()
    await act(async () => { await vi.advanceTimersByTimeAsync(31_000) })
    expect(screen.getByText(/Native qualification: unknown/)).toBeTruthy()
    expect(screen.getByText(/Native work coverage: unknown/)).toBeTruthy()
    expect(screen.getByText("Provider acknowledgement: proven")).toBeTruthy()
    expect(screen.getByText(/Render capture age upper bound:/).textContent).toContain("31s")
  })

  it.each(["absent", "stale", "future"] as const)("does not promote current inventory into managed readiness with %s capture timing", async mode => {
    const view = supervisionView("alpha")
    const at = Date.now()
    Object.assign(view.sessions.items[0]!, { managed: {
      kind: "agent_session", provider: "copilot", profileSha256: "b".repeat(64), qualification: "qualified",
      qualificationReason: null, workCoverage: "complete",
      renderCaptureStartedAt: mode === "absent" ? null : new Date(at + (mode === "stale" ? -31_000 : 60_000)).toISOString(),
    } })
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(view)))
    render(<Supervision {...props} />)
    await screen.findByText("alpha terminal")
    expect(screen.getByText(/Native qualification: unknown/)).toBeTruthy()
    expect(screen.getByText(/Native work coverage: unknown/)).toBeTruthy()
    expect(screen.getByText(/Guarded input: unknown/)).toBeTruthy()
    expect(screen.getByTestId("supervision-count-idle").textContent).toBe("0")
    expect(screen.getByTestId("supervision-count-unknown").textContent).toBe("1")
    expect(screen.getByText(/Render capture age upper bound:/).textContent).toContain(mode === "stale" ? "31s" : "unknown")
  })

  it("keeps a managed terminal visible when its native identity could not be read", async () => {
    const view = supervisionView("alpha")
    Object.assign(view.sessions.items[0]!, { kind: "agent_session", capability: "unknown" })
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(view)))
    render(<Supervision {...props} />)
    await screen.findByText("alpha terminal")
    expect(screen.getByText(/Session kind: agent_session.*Native identity, qualification/)).toBeTruthy()
    expect(screen.queryByText(/Process instance:.*314/)).toBeNull()
  })

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
    expect(screen.getByText(/every trigger requires a current protected mandate and qualified native guarded input/i)).toBeTruthy()
    expect(screen.getByText(/automatic menu, navigation and control keys are refused/i)).toBeTruthy()
    expect(screen.getByText(/unsupported or unqualified hosts are observation-only/i)).toBeTruthy()
    expect(screen.getByText(/Stored mandate.*pause state: absent/i)).toBeTruthy()
    expect(screen.queryByText(/^Authority:/)).toBeNull()
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
