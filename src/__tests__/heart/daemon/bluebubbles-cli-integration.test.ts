import { describe, expect, it, vi } from "vitest"
import {
  blueBubblesListenerReadyAfterApply,
  formatBlueBubblesHostActionText,
  formatBlueBubblesWebhookConnectLine,
  reconcileBlueBubblesWebhookAfterConnect,
} from "../../../heart/daemon/bluebubbles-cli-integration"

const exact = {
  ok: true,
  state: "exact" as const,
  changed: false,
  ownedCount: 1,
  exactCount: 1,
  detail: "one exact Ouro-owned BlueBubbles webhook is registered",
}

describe("BlueBubbles CLI integration", () => {
  it("only treats a completed live daemon restart as listener-ready evidence", () => {
    expect(blueBubblesListenerReadyAfterApply("restarted Ouro; BlueBubbles is loaded for Slugger")).toBe(true)
    expect(blueBubblesListenerReadyAfterApply("daemon is not running; next `ouro up` will load the change")).toBe(false)
  })

  it("renders exact and saved-but-incomplete webhook outcomes", () => {
    expect(formatBlueBubblesWebhookConnectLine(exact)).toBe(
      "webhook: one exact Ouro-owned BlueBubbles webhook is registered",
    )
    expect(formatBlueBubblesWebhookConnectLine({ ...exact, ok: false, state: "auth-failed", detail: "credentials rejected" })).toBe(
      "webhook saved-but-incomplete: credentials rejected",
    )
  })

  it("renders every host state independently with an agent-runnable repair", () => {
    const text = formatBlueBubblesHostActionText({
      action: "status",
      changed: false,
      state: {
        app: "present",
        plist: "current",
        service: "loaded",
        serviceDetail: "",
        process: "running",
        http: { ok: true, detail: "HTTP server responded with 200" },
        plistPath: "/tmp/com.bluebubbles.server.plist",
        launchdDomain: "gui/501",
        launchAgentLabel: "com.bluebubbles.server",
      },
    })
    expect(text).toContain("actor: agent-runnable")
    expect(text).toContain("service: loaded")
    expect(text).not.toContain("service: loaded ()")
    expect(text).toContain("HTTP: healthy (HTTP server responded with 200)")
  })

  it("renders unchecked and unhealthy HTTP states", () => {
    const base = {
      action: "status" as const,
      changed: false,
      state: {
        app: "missing" as const,
        plist: "drifted" as const,
        service: "not-loaded" as const,
        serviceDetail: "missing",
        process: "not-running" as const,
        plistPath: "/tmp/com.bluebubbles.server.plist",
        launchdDomain: "gui/501",
        launchAgentLabel: "com.bluebubbles.server" as const,
      },
    }
    expect(formatBlueBubblesHostActionText({ ...base, state: { ...base.state, http: { ok: false, detail: "refused" } } })).toContain("HTTP: unhealthy")
    expect(formatBlueBubblesHostActionText({ ...base, state: { ...base.state, http: { ok: null, detail: "not configured" } } })).toContain("HTTP: not checked")
  })

  it("uses the injected connect reconciler and contains thrown failures without leaking details", async () => {
    const input = {
      serverUrl: "http://bluebubbles.local",
      password: "secret",
      callbackPort: 18790,
      callbackPath: "/bluebubbles-webhook",
      agentName: "slugger",
      machineId: "machine_test",
      requestTimeoutMs: 1234,
      listenerReady: true,
    }
    const reconcile = vi.fn().mockResolvedValue(exact)
    await expect(reconcileBlueBubblesWebhookAfterConnect(input, { reconcile })).resolves.toEqual(exact)
    expect(reconcile).toHaveBeenCalledWith(input)

    await expect(reconcileBlueBubblesWebhookAfterConnect(input, {
      reconcile: vi.fn().mockRejectedValue(new Error("secret transport detail")),
    })).resolves.toMatchObject({
      ok: false,
      state: "api-unreachable",
      detail: "webhook verification failed before BlueBubbles returned a diagnostic result",
    })
  })
})
