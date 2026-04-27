# Known issues and recovery

A short runbook for bugs we've encountered and how to recognize / recover
from them. Add to this when you find a new one.

## "Slugger only produces `<think>` content with no answer" — MiniMax replay rejection

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

## "Slugger replies to himself in iMessage groups"

**Symptom**: Slugger's own outbound message in a group chat appears
back in the conversation as if from another participant; the agent
then responds to it.

**Trigger**: BlueBubbles re-broadcasts the agent's own outbound
message back through the WebSocket with `isFromMe` missing or false.
The harness's only self-detection check was that single flag — in
direct chats the flag is reliable, in groups it isn't.

**Detection**: search the BB sense log for `senses.bluebubbles_self_handle_filtered`
events. That event indicates the secondary guard caught a real echo.
If you see consecutive replies in a group where Slugger seems to be
talking to a phantom version of himself, this is likely the cause.

**Recovery (post-#610, alpha.488+)**: configure
`bluebubbles.ownHandles` in the agent's vault config to list the
agent's known iMessage handles (phone numbers and/or email
addresses). Run `ouro connect bluebubbles --agent <name>` and
populate the new prompt — it accepts comma-separated values. The
`isAgentSelfHandle` guard catches echoes that the `isFromMe` flag
missed.

## "Heartbeat keeps firing 'fresh work arrived' even after rest + HEARTBEAT_OK"

**Symptom**: Slugger's inner-dialog heartbeat appears to be in a
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

## "MCP empty-reply diagnostic appears even though Slugger is actually thinking"

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
