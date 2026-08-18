# Known issues and recovery

A short runbook for bugs we've encountered and how to recognize / recover
from them. Add to this when you find a new one.

## Private Runtime Spend Boundaries

Starting the private runtime worker is process supervision, not a model turn.
Denied/default private-runtime policy records or queues work with zero provider calls.
Provider-readiness pings are explicit readiness checks, not private turns.

## BlueBubbles is running but inbound messages are silent

**Symptom**: the BlueBubbles app/process and Ouro daemon look healthy, but new iMessages do not reach the agent.

**Detection**: run `ouro doctor` and `ouro bluebubbles host status --json`. Host status deliberately separates app presence, LaunchAgent state, current process state, and bounded HTTP health. Doctor separately reports whether the Ouro-owned webhook is exact, missing, drifted, API-unreachable, or auth-failed. When upstream and exact webhook are healthy but there is no recent inbound evidence, doctor reports quiet/unverified: this is uncertainty, not proof of a broken pipe. Secret-bearing callback query strings are redacted.

**Recovery**: run `ouro connect bluebubbles --agent <name>` again. Standard setup repairs the native host and reconciles one owned `[*]` callback without deleting unrelated BlueBubbles webhooks. The daemon retries that reconciliation every 180 seconds. For a dedicated BlueBubbles macOS account, run only the fresh nonce-bound `human-required` command returned by Ouro in that logged-in account's Terminal, then run the matching `ouro bluebubbles host collect --request-id <id>` from the origin account. A collected launchd receipt is point-in-time evidence; current process and HTTP checks remain authoritative for current serving health.

Do not send a synthetic iMessage just to make the diagnostic green. A real new inbound message may add evidence later, but diagnosis itself remains read-only.

## Doctor reports a hosted-mail cache mismatch

**Detection**: the Mailroom category compares a bounded, read-only hosted index authority snapshot with local search-cache metadata, projection, and key provenance. A mismatch means the reconstructible local cache is stale, malformed, or incomplete; it does not mean hosted mail is missing.

**Recovery**: run `ouro mail sync-cache --agent <name>`. The command refreshes credentials, re-observes complete hosted authority, and accepts convergence only after consecutive equal fingerprints within at most three authority passes. Body work uses at most 20 concurrent body reads; foreground output reports settlement and emits a 30-second heartbeat during stalls. Durable per-message missing-key receipts let unchanged unavailable encrypted records remain explained without repeated body downloads. The command atomically repairs only the local cache and does not mutate hosted mail. Definitive auth/config faults must be repaired first; transient or ambiguous authority does not authorize local deletion.

## Doctor identifies an oversized agent log stream

Run only the exact command doctor prints, such as `ouro logs prune --agent <name>`. A prune candidate must be a canonical direct `<name>.ouro` directory with present `agent.json`; directories without `agent.json` are task/work directories, not agents. The command rejects unsafe names, unknown bundles, symlinked bundle/log paths, and symlinked or non-regular active/generation entries before rotation. There is no aggregate or path-shaped prune command.

## A rollback unexpectedly advances on restart

Exact rollback intent is persistent. The standard Ouro bootstrap installs/verifies the stable recovery launcher before version intent is first committed. `ouro rollback <version>` installs and validates the selected runtime, then atomically pins and activates it. Ordinary `ouro up` preserves that pin. Use `ouro versions` to inspect `pinned` versus `latest` intent and its target. To leave the pin, run `ouro up --latest`; Ouro changes the intent only after the latest version passes preflight. If an update is interrupted, rerun `ouro up` and the installed recovery launcher reconciles the installed link to the last committed intent.

## `ouro status --json` times out

Status has a command-specific 5,000 ms end-to-end socket-operation deadline; long agent turns keep their longer command timeout. A timeout still returns parseable diagnostic JSON classified as `timeout`, rather than hanging for the general ten-minute command window. This distinguishes a deadline from immediate socket unavailability, but does not by itself prove whether the timeout occurred before or after connection. Run `ouro doctor` or `ouro up` as indicated by the accompanying details.

## Codex or another dev-tool host appears frozen around an Ouro MCP call

Run `ouro mcp doctor --agent <name> --json`. The bounded canary records capture time, child PID, protocol phase, duration, exit code/signal, and sanitized stderr. It returns exactly one evidence classification: `ouro-bridge-failed`, `ouro-bridge-healthy-at-capture`, or `host-stall-unexplained`. Pass `--host-stall-observed` only when the host stall was independently observed. A healthy bridge at capture does not prove Codex caused or did not cause an earlier stall, and `host-stall-unexplained` intentionally preserves that uncertainty. Re-run `ouro setup --tool codex --agent <name>` when registration or bridge evidence fails, then open a fresh Codex session because existing MCP subprocesses keep their old runtime.

## "Agent only produces `<think>` content with no answer" — MiniMax replay rejection

**Symptom**: agent sends MCP / CLI / BB messages but the operator sees
empty replies, raw `<think>...</think>` tags, or the diagnostic
"(agent produced reasoning but no final answer this turn — try
again, or check the session transcript for the trace)". The agent's
session shows many user messages in a row with no assistant messages
in between.

**Trigger**: MiniMax-M2.7 (and likely other MiniMax reasoning
variants) sometimes emits an assistant turn that contains both
inline `<think>...</think>` reasoning AND tool_calls. When that
combination is replayed in a subsequent turn, MiniMax rejects with
HTTP 400 error 2013 ("tool result's tool id not found"). Once a
session has one such poisoned assistant message, every subsequent
turn fails the same way and the failover layer fires repeatedly.

**Detection**: search the daemon log for `tool result's tool id` —
if it appears repeatedly with the same `call_function_*` id, the
session is poisoned. Confirm by reading the session JSON and looking
for an `assistant` event whose `content` field starts with
`<think>` AND whose `toolCalls` array is non-empty.

**Recovery (post-#612, alpha.492+)**: this is now self-healing. The
load-time repair in `sanitizeProviderMessages` strips inline `<think>`
blocks from any assistant message that also has tool_calls, and
inserts an explanatory synthetic tool-result that tells the agent
what happened. Just restart the daemon — the next turn will load
the cleaned shape and proceed normally.

**Recovery (pre-#612, manual)**: edit the session JSON directly.
Find the affected assistant event, set its `content` to either an
empty string or null, and add a synthetic tool event right after it
with the same `tool_call_id` and any non-empty `content`. Restart
the daemon.

## "Agent replies to itself in iMessage groups"

**Symptom**: the agent's own outbound message in a group chat appears
back in the conversation as if from another participant; the agent
then responds to it.

**Trigger**: BlueBubbles re-broadcasts the agent's own outbound
message back through the WebSocket with `isFromMe` missing or false.
The harness's only self-detection check was that single flag — in
direct chats the flag is reliable, in groups it isn't.

**Detection**: search the BB sense log for `senses.bluebubbles_self_handle_filtered`
events. That event indicates the secondary guard caught a real echo.
If you see consecutive replies in a group where the agent seems to be
talking to a phantom version of itself, this is likely the cause.

**Recovery (post-#610, alpha.488+)**: configure
`bluebubbles.ownHandles` in the agent's vault config to list the
agent's known iMessage handles (phone numbers and/or email
addresses). Run `ouro connect bluebubbles --agent <name>` and
populate the new prompt — it accepts comma-separated values. The
`isAgentSelfHandle` guard catches echoes that the `isFromMe` flag
missed.

## "Heartbeat keeps firing 'fresh work arrived' even after rest + HEARTBEAT_OK"

**Symptom**: the agent's private-runtime heartbeat appears to be in a
self-sustaining loop; rest is repeatedly rejected with "fresh work
arrived for me this turn — inspect the pending messages above and
take the next concrete action before you rest" even though the
top-level state is quiet.

**Trigger**: the rest tool's gate at `core.ts` reads from the turn-
start snapshot of `pendingMessages`. The snapshot doesn't update
mid-turn — so once pending was non-empty, every rest call within
the same turn gets the same rejection forever. PR #607 capped
*consecutive instinct turns* at 3; this is a different shape, an
*intra-turn* gate.

**Recovery (post-#611, alpha.491+)**: the gate is now once-per-turn.
The first rest call within a turn is rejected if pending work was
present at turn start; subsequent rest calls in the same turn pass.
The agent gets notified once and can then process or rest as needed.
Look for `engine.fresh_work_gate_fired` info events — they fire
exactly once per turn the gate triggers.

## "Repeated heartbeat probes make rest feel like failure"

**Symptom**: an agent cleanly rests with `status=HEARTBEAT_OK`,
then the harness/test loop fires the same heartbeat again a minute
later. The transcript can start to feel accusatory: the agent has
already verified there is no work, but is summoned again to prove it.

**Trigger**: heartbeat dispatch used to be observation-only for
runaway detection. It warned about suspicious cadence but still woke
the model for each duplicate heartbeat, even when the previous
heartbeat ended in clean `HEARTBEAT_OK` and no pending work existed.

**Recovery (post-inner-distress-relief)**: `HEARTBEAT_OK` is treated
as a valid quiet state. Repeated heartbeat messages inside the quiet
window are accepted by the worker without another model turn while
the pending queue is empty. Real work still gets through: pending
messages, explicit pokes, awaits, chats, and non-heartbeat habits drop
the quiet state and run normally. Look for
`senses.heartbeat_ok_rest_reused` info events when the worker reuses
the prior clean rest.

## "MCP empty-reply diagnostic appears even though the agent is actually thinking"

**Symptom**: operator sees "(agent produced reasoning but no final
answer this turn — try again, or check the session transcript for
the trace)" in their MCP client.

**Trigger**: the model emitted a complete `<think>...</think>` block
but no tool call AND no post-think text. With `tool_choice: required`
this is a model-side violation; MiniMax doesn't strictly enforce
the constraint for reasoning models.

**Recovery (post-#611, alpha.491+)**: the engine retries up to two
times with a corrective nudge ("no tool was called this turn — emit
the tool call now"). After cap, falls through to the diagnostic
shown above. Look for `engine.no_tool_call_retry` warn events. If
the diagnostic still appears after publish, the model is genuinely
stuck — re-prompt with simpler input or switch providers.

## AX rule for any future repair logic

**The agent must always have full awareness of its own state and any
failures.** When you write a session repair, message rewrite, or
sanitization pass, ask:

1. Does the agent's next turn see a clear signal of what was changed?
2. Can the agent take a concrete next action based on that signal?
3. Is the original information preserved somewhere (audit log, side
   field, nerves event) for human investigation?

If the answer to any of these is "no," the fix is incomplete. Silent
strips, silent rewrites, and silent migrations all degrade the
agent's ability to do their work.

The synthetic tool-result message after a session-repair is the
canonical place to surface "what just happened" to the agent —
write it like a post-incident note: cause, mitigation, suggested
next action. See `buildSyntheticToolResultMessage` in
`src/heart/session-events.ts` for the pattern.

## Regression test bundle

Provider replay-rejection bugs have a dedicated regression bundle
at `src/__tests__/heart/provider-replay-regressions.test.ts`. The
file exists as a documentation index — when a provider rejects on
what looks like a valid turn, grep that file first; the shape may
already be captured.

When you encounter a NEW replay rejection: capture the shape from
the daemon log, write the test BEFORE the fix (it should fail),
land the fix, verify the test passes. Each entry there cites the
PR + the runbook entry above.

## Sanitize-pass repair quick reference

`sanitizeProviderMessages` runs before every replay and applies a
fixed pipeline of repairs. Each repair emits a structured nerves
event so an operator can grep and quantify how often a given shape
occurs in real traffic. The four classes shipped so far:

| repair | nerves event | trigger | recovery shape |
| --- | --- | --- | --- |
| inline `<think>` + tool_calls | `engine.inline_reasoning_stripped` (info) | persist time | strip the `<think>` block from `content`, preserve original on `_inline_reasoning` |
| inline `<think>` on load (legacy) | `mind.session_invariant_repair` (info) | session load | same strip, plus an explanatory synthetic tool result for affected `tool_call_id`s |
| orphan tool result | `mind.session_orphan_tool_result_repair` (info) | sanitize | drop tool messages whose preceding assistant has no matching `tool_call_id` |
| invariant violation | `mind.session_invariant_violation` (info) | validate | reported but not repaired — operator action only |

When a session looks stuck, search the daemon log for these event
names — the meta tells you what was repaired, how many times, and
which call ids were affected. For deeper inspection of which
specific repairs *would* run on a saved session without committing,
the sanitize pipeline is testable as a pure function (see
`src/__tests__/heart/provider-replay-regressions.test.ts` for the
shape of an isolated repro).
