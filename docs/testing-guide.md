# Testing Guide

This is the operator smoke guide for the current runtime. It focuses on the real user path:

`npx ouro.bot@latest` -> `ouro up` -> `ouro status` -> `ouro chat` / daemon senses -> `ouro stop`

For local development: `npm run dev` (builds and starts daemon from local repo) or `ouro dev` (if the `ouro` binary is current).

## 1. Bootstrap And Launcher Truth

Run this from outside the repo so you exercise the published bootstrap path rather than a local workspace binary:

```bash
cd ~
npx ouro.bot@latest -v
npx ouro.bot@latest up
ouro -v
ouro status
```

Expected:

- `npx ouro.bot@latest -v` and `ouro -v` report the same version.
- `ouro up` opens the shared boot checklist instead of a raw transcript wall:
  - the full startup path is visible up front
  - the current step keeps live detail while work is happening
  - provider verification names the selected providers Ouro is checking right now
  - daemon boot waits keep narrating real startup progress instead of leaving a blinking cursor while the service is still warming up
  - startup does not claim success unless the daemon survives the final handoff check
  - if startup fails, the command exits non-zero and `ouro logs` shows the live daemon log tail that the diagnosis points to
- `ouro status` shows:
  - daemon overview
  - version
  - last updated
  - discovered agents
  - senses
  - workers

If the launcher was stale, `ouro up` should repair it instead of leaving you split across different runtime paths.

## 2. Existing-Agent Chat Smoke

Open a chat with an existing bundle:

```bash
ouro chat <agent>
```

Expected:

- the agent starts from the current runtime
- prompt/runtime info is available
- the agent responds without cold-start confusion

Good probes:

- `what senses do you have?`
- `what version are you on?`
- `what does interactive mean?`

## 3. First-Run / Hatch Smoke

To exercise agent creation:

```bash
ouro hatch
```

Or explicitly:

```bash
ouro hatch --agent Hatchling --human Ari --provider anthropic --setup-token <token>
```

Expected:

- system setup happens first
- Adoption Specialist runs
- a canonical bundle is created under `~/AgentBundles/Hatchling.ouro/`
- the hatchling vault unlock secret is typed and confirmed by the human in hidden terminal prompts, not generated or printed
- selected provider credentials are stored in the hatchling's vault
- interactive hatch does not create, mutate, or persist a SerpentGuide vault

Verify:

- `~/AgentBundles/Hatchling.ouro/agent.json`
- `~/AgentBundles/Hatchling.ouro/bundle-meta.json`
- canonical psyche/task/skill/state directories exist
- the hatchling vault is unlockable on this machine

## 4. Provider Auth Recovery Smoke

Provider credentials and provider selection are separate. `ouro auth` stores credentials in the owning agent's vault. Provider/model selection lives in the bundle's `agent.json`.

When a provider needs first-time setup or reauth, use the installed runtime path instead of repo-local scripts:

```bash
ouro auth --agent Hatchling
ouro auth --agent Hatchling --provider openai-codex
```

Expected:

- `ouro auth` stores credentials only in the owning agent's vault
- `ouro auth --agent Hatchling` reauths the provider already selected for Hatchling's outward lane
- `--provider <provider>` authenticates that provider in the owning agent's vault without switching a lane
- auth, provider refresh, and guided connectors show a visible progress checklist while waiting on browser login, vault reads/writes, daemon reload, and verification
- `ouro logs` now tails the daemon/agent logs from the installed runtime path instead of falling back to a socket help message
- bare `ouro` in a human TTY opens the shared home deck instead of silently meaning `ouro up`
- root `ouro connect --agent <agent>` prints a short `checking current connections` preflight, verifies the currently selected providers through the shared live check path with a bounded one-attempt orientation policy, and opens the shared connect wizard without spending the full startup retry budget
- a failed or timed-out root `ouro connect` orientation probe can mark the current menu as `needs attention`, but it must not mutate provider lane selection; `ouro up`, `ouro check`, `ouro auth verify`, and chat startup own full provider retry behavior
- auth, vault, hatch, and guided connector completions land on the shared guide language with `What changed` and `Next moves` instead of raw transcript walls
- `ouro up` replacement paths say they are replacing the running background service and do not mark `starting daemon` complete before replacement readiness is known
- if the background service dies after startup work but before handoff is complete, `ouro up` fails with a daemon diagnosis instead of printing a false-ready board
- provider lanes remain in `~/AgentBundles/Hatchling.ouro/agent.json`
- use `ouro use --agent <agent> --lane <outward|inner> --provider <provider> --model <model>` to switch a lane after credentials exist and the provider/model check passes
- use `ouro provider refresh --agent <agent>` to refresh the daemon's in-memory provider credential cache from the vault
- use `ouro vault config status --agent <agent> --scope all` to inspect portable and machine-local runtime credential fields without printing values
- use `ouro connect --agent <agent>` for the guided connect bay, or jump directly to `ouro connect providers|perplexity|embeddings|teams|bluebubbles|voice --agent <agent>`
- if a session already failed, the follow-up move is to retry the failed `ouro` command or reconnect the session

## 5. Daemon Messaging Smoke

From another terminal:

```bash
ouro msg --to <agent> --session smoke --task smoke-task "status ping"
ouro poke <agent> --task smoke-task
```

Expected:

- `ouro msg` queues or delivers through the daemon cleanly
- `ouro poke` triggers task work for that agent

## 6. Sense Smoke

### CLI

CLI is `interactive`, so it should appear in `ouro status` without pretending the daemon hosts it.

### BlueBubbles

If BlueBubbles is enabled and attached on this machine:

- `ouro status` should show `BlueBubbles` as `ready` or `running`
- inbound iMessages should create or continue the correct chat trunk
- the inbound sidecar under `state/senses/bluebubbles/inbound/` is capture truth, not completion truth; handled-message truth lives under `state/senses/bluebubbles/processed/`
- typing and read behavior should feel immediate

If BlueBubbles is enabled but not attached here, `ouro status` should show `not_attached`, not degrade daemon startup. Attach it with:

```bash
ouro connect bluebubbles --agent <agent>
ouro connect voice --agent <agent>
```

### Voice

Voice is a single transcript-first sense with multiple transports. The Twilio phone transport has two modes. `record-play` is the conservative phone smoke path: Twilio records the caller, Ouro downloads the recording, Whisper.cpp transcribes it, the normal stable `voice` session turn runs, ElevenLabs generates MP3 audio from tool-delivered `speak`/`settle` text, and Twilio plays that response before listening again. `media-stream` is the lower-latency conversational path. In cascade mode it opens a bidirectional Twilio Media Stream, frames caller utterances with VAD, uses Whisper.cpp plus ElevenLabs `ulaw_8000`, and clears playback on barge-in. In native Realtime mode it routes Twilio audio through OpenAI Realtime speech-to-speech, keeps the same stable voice transcript/session key, exposes action tools plus `voice_end_call`, and uses a compact voice-native identity prompt rather than the full general-purpose prompt. For phone-number lanes that can route SIP, `voice.twilioConversationEngine=openai-sip` is the preferred inbound smoke path: Twilio returns `<Dial><Sip>` to OpenAI, OpenAI calls Ouro's SIP webhook, and Ouro owns the Realtime control socket, transcript, tools, and hangup. When SIP is paired with `media-stream`, outbound defaults to OpenAI Realtime Media Streams so pickup goes straight to the agent instead of making the human hear Twilio-to-SIP ringback after answering.

Spoken voice is part of the agent's identity. For native OpenAI Realtime phone testing, `voice.openaiRealtimeVoice` is the current phone voice and should be auditioned as a single coherent identity. `voice.openaiRealtimeVoiceStyle` must be audible in the first greeting as well as later turns, and `voice.openaiRealtimeVoiceSpeed` should stay close to `1.0` unless the live call remains too slow or too sleepy. ElevenLabs tests cover legacy cascade compatibility only unless a future design gives it a distinct non-redundant job.

Live voice tools should be exercised as media controls. `voice_end_call` must end the active call after a natural goodbye. `voice_play_audio` must inject a short tone or clip into the phone media stream on Media Stream transports. On direct OpenAI SIP, `source=tone` should produce a short model-rendered audio cue through Realtime; URL/file clips should return the media-bridge limitation instead of claiming playback succeeded. Tool calls on voice must also keep the caller oriented: long-running tools may trigger one tiny holding phrase, and the final result should arrive through the same response queue instead of racing a second `response.create`. Native Realtime phone tests should assert `turn_detection.create_response=false`; Ouro owns floor-control and should request the next response only after a short post-transcript hold that is cancelled by new caller speech.

Outbound SIP AMD tests must cover the current pickup contract: `human` and `unknown` answers start the greeting immediately, explicit machine/fax can still hang up after answer, and no OpenAI SIP TwiML should contain Twilio `answerOnBridge`. For Twilio outbound UX, also cover the default outbound Realtime Media Stream route because `<Dial><Sip>` can still leak answered-call ringback while the SIP leg connects.

Voice friend-resolution tests should prove the phone path reuses canonical friend context. A known phone number should resolve through the same `imessage-handle` friend record used by BlueBubbles/text, including trust level, so family-only tools do not fail just because the interaction is happening over voice.

Pending voice delivery is intentionally short-lived. Voice pending older than fifteen minutes should be archived to `state/pending-expired/...` before it reaches `pendingMessages`, preserving evidence without letting stale phone scripts or obsolete voice-identity notes appear in a later live call.

For implementation work, keep the sense/transport boundary in [Sense Development Contract](sense-development.md) in view. In particular, outward sense turns run in tool-required mode: transports that need replayable text must recover `settle.answer` only after `(delivered)` and `speak.message` only after `(spoken)`, not by reading `assistant.content` directly.

For a managed phone smoke, attach the transport to this machine and expose the Voice entrypoint through Cloudflare Tunnel:

```bash
ouro connect voice --agent <agent>
ouro vault config set --agent <agent> --scope machine --key voice.twilioPublicUrl --value https://<cloudflare-tunnel-or-hostname>
ouro vault config set --agent <agent> --scope machine --key voice.twilioBasePath --value /voice/agents/<agent>/twilio
ouro vault config set --agent <agent> --scope machine --key voice.twilioTransportMode --value media-stream
ouro vault config set --agent <agent> --scope machine --key voice.twilioOutboundConversationEngine --value openai-realtime
ouro up --agent <agent>
```

Then set the Twilio number's Voice webhook to `POST https://<cloudflare-tunnel-or-hostname>/voice/agents/<agent>/twilio/incoming` and call the number. The transcript should land under the ordinary `state/sessions/<friend>/voice/<stable-phone-channel>.json` session path; CallSid remains the per-call artifact directory under `state/voice/twilio-phone/`. The standalone bridge remains available for one-off local testing with `node dist/senses/voice-twilio-entry.js --agent <agent> --public-url https://<cloudflare-tunnel>`.

For the SIP smoke, keep the same Twilio Voice webhook and add:

```bash
ouro vault config set --agent <agent> --scope machine --key voice.twilioConversationEngine --value openai-sip
ouro vault config set --agent <agent> --scope machine --key voice.twilioOutboundConversationEngine --value openai-realtime
ouro vault config set --agent <agent> --key voice.openaiSipProjectId
ouro vault config set --agent <agent> --key voice.openaiSipWebhookSecret
ouro vault config set --agent <agent> --scope machine --key voice.openaiSipWebhookPath --value /voice/agents/<agent>/sip/openai
ouro up --agent <agent>
```

The OpenAI webhook endpoint should subscribe to `realtime.call.incoming` and point at `POST https://<cloudflare-tunnel-or-hostname>/voice/agents/<agent>/sip/openai`. `GET /voice/agents/<agent>/sip/openai/health` should return `ok`. On a successful call, Twilio's first TwiML response should contain `<Dial><Sip>sip:<project-id>@sip.api.openai.com;transport=tls`, the SIP webhook should accept the OpenAI call, and `voice_end_call` should call OpenAI's `/realtime/calls/<call_id>/hangup`.

### Teams

If Teams is enabled and configured:

- `ouro status` should show `Teams` as `ready` or `running`
- the adapter should respond without boot-introducing itself

## 7. Logs And Shutdown

```bash
ouro logs
ouro stop
ouro status
```

Expected:

- `ouro logs` tails daemon/runtime logs
- `ouro stop` shuts down cleanly
- `ouro status` shows the stopped state clearly instead of raw socket errors

## 8. Human CLI Progress Smoke

For human-facing CLI changes, especially auth, repair, startup, and connector flows:

- any wait that may last more than a few seconds should have a current step on screen
- output should be a short checklist, not a repeated wall of repair text
- TTY surfaces should render through the shared Ouro board family rather than each command inventing its own ad hoc transcript
- `ouro`, `ouro up`, `ouro connect`, `ouro auth verify`, and `ouro repair` should agree on provider/vault truth for the same machine state
- `ouro help`, `ouro whoami`, `ouro versions`, and the `ouro hatch` welcome shell should visually read like the same CLI family
- secret prompts must not echo or print the secret later
- success output should include where the credential/config was stored and the next action
- failure output should keep the last visible progress context and give one useful repair path

Agent-direct shortcuts can stay terse when they are meant for automation, but human-required and human-choice flows should be understandable to someone who does not know terminal vocabulary.

## 9. Repo-Code Validation

For runtime code changes inside the repo:

```bash
npm test
npx tsc --noEmit
npm run test:coverage
npm run test:integration
npm run test:e2e:package
npm run test:e2e:real-smoke -- --secrets-file /absolute/path/to/ouro-real-smoke.json
```

The first five should pass before merge when the change touches runtime, daemon, provider, auth, or package-install behavior. The real-smoke lane is the live external check for sacrificial credentials; run it when you are working on provider auth, portable capability onboarding, or live verification behavior and you have the secrets file available.

What each lane proves:

- `npm test`: fast in-process behavior coverage
- `npm run test:coverage`: enforced 100% coverage + nerves audit
- `npm run test:integration`: built runtime in child processes against a hermetic fake machine (temp `HOME`, temp bundles, fake vault CLI/unlock store, fake provider server)
- `npm run test:e2e:package`: locally packed npm tarball installed into a fresh prefix, then the installed `ouro` binary is executed for both version truth and a human-facing help surface
- `npm run test:e2e:real-smoke -- --secrets-file /absolute/path/to/ouro-real-smoke.json`: real external provider/capability smoke with sacrificial credentials, using the same provider ping implementation as `ouro up`, `ouro auth verify`, and the connect bay while preserving each command's retry policy

CI now mirrors that split on pull requests:

- coverage gate
- hermetic integration lane
- local package e2e lane

`main` also keeps:

- the published-package smoke after `npm publish`
- a scheduled `real-smoke` workflow that runs the live external lane whenever repo secret `OURO_REAL_SMOKE_SECRETS_JSON` is configured

Recommended `OURO_REAL_SMOKE_SECRETS_JSON` shape:

```json
{
  "providerCheck": {
    "provider": "minimax",
    "model": "MiniMax-M2.5",
    "config": {
      "apiKey": "replace-me"
    }
  },
  "portableChecks": {
    "perplexityApiKey": "replace-me",
    "openaiEmbeddingsApiKey": "replace-me"
  }
}
```

The workflow writes that secret into a temp file with restrictive permissions, runs the shared real-smoke script, and never prints the raw JSON or the secret values.

## Troubleshooting

### `ouro` and `npx ouro.bot@latest` disagree on version

Run:

```bash
cd ~
npx ouro.bot@latest up
ouro -v
```

`ouro up` should repair the local launcher and current daemon state.

### `ouro status` cannot reach the daemon

Run:

```bash
ouro up
ouro status
```

If the daemon is not running, status should describe that plainly rather than surfacing raw socket noise.

### A provider says to reauthenticate

Run:

```bash
ouro auth --agent <agent>
```

Use this when you need to authenticate or reauthenticate the provider already selected for that agent on this machine. `ouro auth` stores credentials only; it does not choose the runtime provider/model.

If you are deliberately adding credentials for another provider, run:

```bash
ouro auth --agent <agent> --provider <provider>
```

If you are deliberately switching a runtime lane, run:

```bash
ouro use --agent <agent> --lane <outward|inner> --provider <provider> --model <model>
```

After reauth succeeds, retry the failed `ouro` command or reconnect the session that
already errored.

If a repair message says the agent can run a refresh or verify command, that is agent-runnable. If it requires browser login, MFA, provider dashboard access, API token creation, or secret entry, it is human-required; enter secrets in the terminal or provider UI, never in chat.

### A sense shows `needs_config`

Check:

- `~/AgentBundles/<agent>.ouro/agent.json` (check sense enablement)
- `~/AgentBundles/<agent>.ouro/agent.json` (check outward/inner provider+model)
- the agent's vault provider credentials
- portable runtime config in `runtime/config`
- machine-local attachments in `runtime/machines/<machine-id>/config`

Sense enablement and provider+model selection live in `agent.json`; all raw credentials live in the owning agent's vault.

### BlueBubbles or Teams behavior feels wrong

Use:

```bash
ouro status
ouro logs
```

Then verify the sense-specific credentials are configured for that integration, the sense is enabled in `agent.json`, and the relevant outward/inner lane is configured in `agent.json`. Prefer the guided connect bay for repairs. For BlueBubbles specifically, `ouro connect bluebubbles --agent <agent>` stores local server details under this machine's vault item. For Voice, `ouro connect voice --agent <agent>` names the required ElevenLabs portable key/voice ID and Whisper.cpp machine attachment fields, with Twilio phone transport setup, meeting URL intake, and local BlackHole/Multi-Output readiness checks available before live provider automation.
