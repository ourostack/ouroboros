import * as fs from "node:fs"
import * as path from "node:path"

/** The four hand-offs of 2026-11-16 on the Mac mini: predecessor, successor, and how the successor's first message opens. */
export const TODAYS_PAIRS: Array<[string, string, string]> = [
  ["cfb84353-ea6b-42e2-96ba-de795561431e", "4deb13bb-8332-4832-8448-03b62431711b", `You are "desk epoch 3 (2)", the successor to Ari's coordinator session "desk epoch 3" (cfb84353-ea6b-42e2-96ba-de795561431e). It handed off at 400 MB of history under lane guide rule 22. Don't resume it or read its history.`],
  ["84b913b0-eff7-44d0-a951-be5f3764b2a9", "16caf80c-46df-4dcf-8ccd-f2c4b909a507", `You are the new CIT Pages coordinator, the fresh successor of Copilot app session 84b913b0-eff7-44d0-a951-be5f3764b2a9 ("cit pages"). It handed off because its history passed the 500 MB resume cap.`],
  ["2fa5297c-adf6-4d12-b06c-0e5681e60ebc", "86423aa7-95e7-415f-9db4-582de9d5eee6", `You are Ari's Tandem coordinator, the fresh successor to session 2fa5297c. That session's history reached 947 MB, over the 500 MB resume cap, so it handed off and archived itself.`],
  ["93a4d349-b026-446d-8eee-3e2f7c1e1b86", "d7a6b134-ce9d-432a-ad3c-ddc842ed9df9", `You are the successor to Ari's session "Agent loop teaching guide" (93a4d349-b026-446d-8eee-3e2f7c1e1b86). Its history (\`events.jsonl\`) is 6.2 GB, and resuming it exhausts the Mac mini's 64 GB of memory.`],
]

/** A history as the app writes one: start-up hook events first (tens of KB), then the first message, then its turn. */
export function history(root: string, id: string, first: string | null, options: { turned?: boolean; padBytes?: number; at?: string } = {}): void {
  const dir = path.join(root, "session-state", id)
  fs.mkdirSync(dir, { recursive: true })
  const hook = JSON.stringify({ type: "hook.end", data: { output: "x".repeat(1000) } })
  const lines = [JSON.stringify({ type: "session.start", data: { sessionId: id } }), ...Array.from({ length: Math.ceil((options.padBytes ?? 24_000) / hook.length) }, () => hook)]
  if (first !== null) lines.push(JSON.stringify({ type: "user.message", timestamp: options.at ?? "2026-11-16T15:40:00Z", data: { content: first } }))
  if (options.turned) lines.push(JSON.stringify({ type: "assistant.message", data: { content: "On it." } }), JSON.stringify({ type: "assistant.turn_end", data: {} }))
  fs.writeFileSync(path.join(dir, "events.jsonl"), `${lines.join("\n")}\n`)
}
