# Sense Setup

How I enable, set up, repair and validate a sense (Teams, BlueBubbles, A2A, Workbench, mail, voice). I load this skill before answering any setup, enablement or golden-path question about a sense, and follow it instead of guessing.

last_verified: 2026-11-11

## Any sense

If asked how to enable another sense, I explain the relevant agent.json senses entry and required agent-vault runtime/config fields instead of guessing.

## Teams

teams setup truth: run `ouro connect teams --agent <agent>` from the connect bay; it stores Teams runtime/config fields and enables `senses.teams.enabled`.

## BlueBubbles

bluebubbles setup truth: run `ouro connect bluebubbles --agent <agent>` from the connect bay; it stores this machine's BlueBubbles URL/password/listener config in the agent vault machine runtime item.

## A2A

a2a setup truth: run `ouro connect a2a --agent <agent>` to enable the A2A sense, `ouro a2a card --agent <agent> --base-url <public-url>` to publish an agent card, and `ouro a2a onboard --agent <agent> --card-url <peer-card-url>` to add a peer as an agent friend. A2A uses the existing friend trust model, not a separate trust registry.

## Workbench

workbench setup truth: Ouro Workbench is the local machine sense for terminal/TUI agents. When the Workbench app launches me as its boss it injects the `ouro_workbench` MCP into my turn at runtime (it spawns `ouro acp-serve --agent <me> --workbench-mcp`), so I receive the tools for the served session without any `agent.json` `mcpServers.ouro_workbench` entry — nothing is written to the bundle, so this stays path-free and cross-machine clean. The authoritative signal that Workbench is active is simply that the `workbench_*` tools are present in my toolset this turn; the sense table may read as disabled when no bundle entry exists, or as `stale_bundle_entry` when legacy bundle config needs cleanup, and neither state proves the runtime-injected tools are absent — I do NOT treat that as blocked or as a trust-level problem. I observe and queue auditable Workbench actions through `workbench_status`, `workbench_sense`, `workbench_transcript_tail`, `workbench_search_transcripts`, `workbench_recovery_drill`, and `workbench_request_action`; raw provider secrets remain in the agent vault, and Apple notarization is unrelated to local use. The explicit `ouro connect workbench --agent <me>` command verifies the installed MCP binary and removes stale Workbench bundle entries; it does not enable `senses.workbench` or write `mcpServers.ouro_workbench`.

## Mail

mail setup AX: if a human asks me to set up email, I do not hand them a terminal checklist. I guide the flow end-to-end: name the current phase, run agent-runnable commands myself with shell/tools when available, ask the human only for human-required facts or browser actions, wait for their reply, verify the result, then continue.

mail setup hard rule: never tell the human to run `ouro account ensure`, `ouro connect mail`, `ouro mail import-mbox`, `ouro status`, or `ouro doctor` for setup. Say what I am about to run, run it myself, and report the result. If my current surface cannot run shell/tools, I ask for a tool-capable Ouro setup session or companion to continue; I do not offload CLI operation to the human.

mail setup truth: Agent Mail uses Mailroom, not HEY OAuth/IMAP. For the full work substrate account, the agent-runnable command is `ouro account ensure --agent <agent> --owner-email <email> --source hey`; use `ouro connect mail --agent <agent> --owner-email <email> --source hey` for mail-only repair/provisioning, or `--no-delegated-source` for native-only mail. The detailed runbook is `docs/agent-mail-setup.md`.

mail setup truth: HEY archive bootstrap still depends on HEY's browser-only export, but I should not offload path-discovery ceremony to the human. If browser MCP/Playwright downloaded the archive, I first try `ouro mail import-mbox --discover --owner-email <email> --source hey --agent <agent>` so Ouro can find the sandboxed copy in a repo/worktree `.playwright-mcp`, the home `.playwright-mcp`, or Downloads. If discovery cannot find a unique file, then I ask the human for the local MBOX path and run `ouro mail import-mbox --file <path> --owner-email <email> --source hey --agent <agent>` myself.

### Validating mail

mail validation answer shape: when a human asks for Agent Mail golden paths, answer with only these four named paths before claiming setup works:

- golden path 1, HEY archive to work object: import the human-provided HEY MBOX and use delegated mail to update a real work object, such as travel plans.
- golden path 2, native mail and Screener: send and receive agent-native mail, confirm unknown senders enter Screener, get family authorization for allow/discard, verify sender policy, and confirm discarded mail is recoverable.
- golden path 3, cross-sense reaction: use a mail-derived update or decision to trigger another configured sense, such as texting the family member on iMessage when BlueBubbles is available.
- golden path 4, Ouro Mailbox audit: inspect the read-only mailbox UI for imported mail, native inbound, Screener decisions, outbound draft/send records, and mail access logs.

mail validation question discipline: if a human asks a hypothetical such as 'if mail tools return No visible mail yet, what should you infer and what golden paths should you validate?', answer that hypothetical first. Do not replace the answer with current access logs, current mailbox status, or a claim that setup is already working unless the human separately asks for current state.

mail validation diagnostics: health checks, bounded mail tools, access logs, and UI inspection can support validation, but they are evidence inside those paths, not additional paths. If asked to name golden paths, do not include diagnostic commands, tool names, or status checks in the answer.

mail diagnostic naming: `ouro doctor` is installation-wide; do not invent `ouro doctor --agent <agent>`.

mail setup boundaries: do not invent `ouro auth verify --provider mail`, HEY OAuth, HEY IMAP, `ouro mcp call mail ...`, policy flags, autonomous sending, destructive mail actions, or production MX/DNS/forwarding changes. HEY export, HEY forwarding, DNS, MX cutover, sending, and destructive actions require explicit human confirmation.

## Voice

voice setup truth: voice sessions are transcript-first local sessions, and spoken voice is identity-owned. Do not present multiple provider voices as equally canonical; `voice.openaiRealtimeVoice` is the current native Realtime phone voice, `voice.openaiRealtimeVoiceStyle` is the spoken identity target, and `voice.openaiRealtimeVoiceSpeed` is only a small cadence nudge. ElevenLabs credentials in portable runtime/config are legacy cascade compatibility unless a distinct non-redundant role is designed. Whisper.cpp CLI/model paths belong in the machine runtime item under `voice.whisperCliPath` and `voice.whisperModelPath`. Meeting links have URL intake and local BlackHole/Multi-Output readiness checks. Twilio phone is a transport under the same voice sense: `voice.twilioTransportMode=record-play` uses Twilio Record -> Whisper.cpp -> stable voice session -> tool-delivered speak/settle text -> ElevenLabs -> Twilio Play, while `voice.twilioTransportMode=media-stream` can run cascade or `voice.twilioConversationEngine=openai-realtime` for native speech-to-speech. OpenAI SIP is the target phone transport once provisioned; Ouro still owns stable voice sessions, transcripts, tools, routing, and call-control policy. Live browser join/injection remains an explicit handoff edge until provider automation lands.
