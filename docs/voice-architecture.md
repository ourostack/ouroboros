# Voice Architecture

Voice is a first-class Ouro sense. SIP, Twilio, browser meetings, local
microphones, and future direct agent-to-agent audio are transports under that
sense.

The AX rule is simple: the agent is speaking by Voice. Provider names describe
how audio reaches the room; they do not define the agent's identity, memory, or
durable conversation channel.

## Sense Ownership

The Voice sense owns:

- stable voice session keys and text transcripts
- agent identity and spoken style guidance
- voice-native prompt compaction
- voice-specific tools such as `voice_end_call` and `voice_play_audio`
- overview UI transcript behavior
- call/meeting routing policy and audit events

Transports own connection mechanics:

- phone number ingress/egress
- media framing and codec conversion
- browser or device automation
- provider-specific webhooks and call IDs
- provider-specific hangup, transfer, or playback commands

Transport connection IDs are metadata. They must not become the canonical
session. A Twilio `CallSid`, OpenAI SIP `call_id`, browser tab id, or meeting
participant id can identify one live connection; the Voice session key should
represent the stable speaking channel.

## Transport Families

### Twilio Media Stream Phone

This is the current working phone alpha.

The phone number terminates at Twilio, Twilio streams bidirectional audio to
Ouro, and Ouro connects that stream to OpenAI Realtime. This keeps maximum local
control: Ouro can inspect raw frames, tune interruption behavior, inject short
audio clips, and maintain compatibility with the older Whisper.cpp plus
ElevenLabs cascade.

The cost is latency and bridge complexity. There are two realtime systems in
the loop: Twilio media streams and OpenAI Realtime over WebSocket. Ouro must
manage playback buffers, truncation, VAD edge cases, and provider call state.

Use this transport when:

- we need immediate compatibility with the existing number and tunnel
- we need raw call-media control such as `voice_play_audio`
- SIP provisioning is not complete
- we want a conservative rollback path for phone calls

### OpenAI SIP Phone

OpenAI SIP is the preferred phone-number transport whenever a phone or meeting
lane can route media over SIP. It is not Twilio-only.

The general shape is:

1. A SIP trunk provider owns or routes the phone number.
2. The SIP trunk points at OpenAI's SIP endpoint for the project.
3. OpenAI emits `realtime.call.incoming` to an Ouro webhook.
4. Ouro accepts or rejects the call with the Realtime call API.
5. Ouro opens a Realtime control WebSocket for the accepted `call_id`.
6. Ouro keeps the same Voice session, transcript, tool, and call-control model.

Twilio Elastic SIP Trunking is one SIP trunk provider that can do this. It is
not the substrate. Telnyx, SignalWire, Vonage/Plivo, a carrier SIP trunk, or a
self-hosted PBX/SBC may also fit if they can route the number to OpenAI's SIP
URI, preserve the metadata we need, and meet reliability and control
requirements.

SIP should improve latency for ordinary phone conversation because the live
media leg goes directly into OpenAI Realtime instead of through Ouro as a
frame-forwarding bridge. It should also reduce the amount of provider-specific
media code Ouro has to maintain.

SIP does not remove Ouro from the loop. Ouro still owns acceptance policy,
session keys, transcript persistence, voice tools, outbound intent, identity,
and audit.

Phone transports resolve the caller into the same friend graph used by text,
mail, and other senses. An explicit friend id is honored only when it names an
existing friend record; otherwise a normalized phone number resolves through the
canonical `imessage-handle` external id. Voice trust and tool permissions must
therefore follow the known friend record instead of creating a phone-only
stranger identity.

Remaining media questions before replacing Twilio Media Streams:

- Direct OpenAI SIP does not expose an output-audio append primitive. It can
  ask Realtime to render short generated cues, so `voice_play_audio` is exposed
  for `source=tone` on SIP as a model-rendered audio cue. URL/file clips still
  need a media bridge, most likely a Twilio Conference/SIP mixer or another SIP
  B2BUA that can inject raw audio while keeping the Realtime leg alive.
- What is the cleanest outbound call flow? Inbound SIP is direct: trunk to
  OpenAI, webhook to Ouro. Twilio `<Dial><Sip>` can still make an answered
  human hear ringback while the second leg connects, so current Twilio outbound
  calls default to `openai-realtime` Media Streams when inbound is
  `openai-sip` and `voice.twilioTransportMode=media-stream`. The target SIP
  shape is a provider or B2BUA that originates the human leg and bridges/refers
  it to OpenAI without audible post-pickup ringback.
- Which SIP provider gives the best mix of latency, caller ID control,
  webhook/API quality, number portability, pricing, and operational visibility?

Current implementation:

- `voice.twilioConversationEngine=openai-sip` makes the existing Twilio Voice
  webhook return `<Dial><Sip>` to OpenAI's project SIP endpoint. This is the
  first reversible SIP path because it keeps the existing number and fallback
  Twilio webhook in place while moving live media to OpenAI SIP. The TwiML does
  not use Twilio `answerOnBridge`, but outbound `<Dial><Sip>` may still leak
  ringback after pickup while Twilio connects the SIP leg. On Media Stream
  machines, outbound calls default to `openai-realtime`; use
  `voice.twilioOutboundConversationEngine` only when that default needs to be
  overridden.
- Native Realtime calls use Ouro floor-control: Realtime transcribes detected
  caller turns, but Ouro disables provider auto-response and asks for the next
  response only after a short caller-floor hold. New caller speech cancels that
  pending answer, which prevents the agent from jumping on every small pause.
- OpenAI posts `realtime.call.incoming` to
  `/voice/agents/<agent>/sip/openai`; Ouro verifies the OpenAI webhook
  signature, accepts the call, opens the Realtime control WebSocket, sends the
  first voice turn, records transcripts, runs voice tools, and maps
  `voice_end_call` to OpenAI's call hangup endpoint.
- Outbound SIP starts the first greeting immediately after answer unless Twilio
  has already positively identified voicemail or fax. Async AMD can still hang
  up the call if a later machine/fax result arrives, but `unknown` is treated as
  a live human path because post-pickup silence is worse than the occasional
  voicemail false positive.
- Direct SIP can render short `voice_play_audio source=tone` cues through the
  Realtime model. Arbitrary URL/file clip bytes still need a real mixer or media
  bridge, most likely a Twilio Conference/SIP mixer using conference
  announcements, before they can be injected without dropping the Realtime leg.
- Pending voice messages are treated as synchronous call residue, not a durable
  inbox. Shared voice turns archive pending older than fifteen minutes under
  `state/pending-expired/...` before model injection.

Decision: if a transport can use SIP for a live phone-number style audio leg,
prefer SIP. Keep Media Streams as fallback and as the current raw-audio
injection path.

### Browser And Meeting Voice

Browser meeting voice remains a separate Voice transport, not a SIP
replacement.

SIP should be used for meeting transports when the meeting exposes a SIP or
phone dial-in and the job is just conversational audio. That path loses
browser-only context: screen state, chat, participant UI, waiting rooms, mute
controls, captions, file shares, and provider-specific meeting affordances.

For Google Meet, Riverside, Zoom, Teams, or browser-only podcast rooms, Ouro
needs a browser/WebRTC lane that can join the room, route microphone/speaker
audio, and optionally observe meeting UI. That transport should still write the
same Voice transcript and expose the same voice tools where possible.

### Local And Direct Voice

Local microphone/speaker and future direct agent-to-agent voice should also sit
under Voice. These lanes may connect to OpenAI Realtime by WebRTC or WebSocket
without any phone provider at all.

## No-Human Voice Evals

Voice should not rely on Ari answering a phone as the main regression suite.
Live calls are audition and confidence checks; they are not the first proof.

The no-human eval ladder is:

1. Deterministic timeline replay: fixed events, fixed thresholds, no provider
   network calls. This catches obvious conversation-shape failures such as
   silence after pickup, slow first audio, slow response after transcript,
   missing tool holding phrases, missing friend context, lost transcripts,
   failed hangup, and bad barge-in clearing/truncation.
2. Transport adapter replay: Twilio Media Streams, OpenAI SIP control, browser
   meeting, and local/direct lanes emit the shared Voice eval vocabulary while
   preserving source metadata. The eval is transport-agnostic but not
   transport-blind.
3. Provider sandbox replay: fixed audio bytes and fixed chunking/VAD settings
   exercise the real provider path without a human in the loop.
4. Live human audition: only after the automated gates pass, and never as the
   only evidence for a merge.

`npm run voice:eval` runs the first built-in ladder slice. It includes a healthy
Voice timeline and an expected known-bad latency canary, so the command proves
both that the happy path passes and that the evaluator still catches slow calls.

Trace replay is the next automated gate:

```bash
npm run voice:eval -- --trace path/to/voice-trace.json
```

A trace artifact declares `schemaVersion: 1`, `traceId`, `scenarioId`,
`expectedOutcome`, either `expectationProfile: "voice-phone-default"` or inline
latency/assertion budgets, and an ordered `events` array. Events keep raw-ish
provider names such as `openai.realtime.output_audio.delta` or
`twilio.media.clear.sent`, plus source transport metadata, and replay maps them
into the shared Voice eval vocabulary before grading. Unknown unmarked events
fail fast; explicitly ignored provider-noise events stay visible in summaries
without entering the grading timeline. Redacted traces are allowed, but replay
must not use redacted transcript text to satisfy transcript-content assertions.

Use trace replay for captured SIP, Twilio Media Stream, browser meeting, and
local/direct adapter traces before provider sandbox audio replay or live human
audition. It is meant to answer "would this call shape have felt synchronous,
tool-aware, identity-aware, and interruption-safe?" without needing someone to
pick up the phone.

## Identity And Providers

The agent should have one coherent spoken identity for a transport family. Do
not present ElevenLabs, OpenAI Realtime, Twilio, and meeting voices as multiple
canonical selves.

Current direction:

- OpenAI Realtime is the live conversation center.
- The current native phone model default is `gpt-realtime-2`, with
  `gpt-realtime-whisper` used for Realtime transcription metadata.
- `voice.openaiRealtimeVoice` is the current phone voice selector.
- `voice.openaiRealtimeVoiceStyle` is the transport-level spoken identity
  target, for example "scrappy, upbeat, warm, lightly British".
- `voice.openaiRealtimeVoiceSpeed` can lightly bias cadence without changing
  identity; keep it conservative because phone calls need clarity.
- `marin` and `cedar` are the quality-first OpenAI Realtime voice candidates,
  but agents may audition another supported voice when identity fit matters.
- Slugger's current phone direction is a Realtime audition shaped as scrappy,
  upbeat, warm, lightly British, masculine/neutral-masc, and not posh or
  announcer-like.
- ElevenLabs is legacy cascade compatibility unless a future non-redundant use
  earns it a specific role.

Useful non-redundant ElevenLabs roles would need to be explicit, such as
offline voice rendering, long-form produced audio, or a fallback lane when
Realtime is unavailable. It should not remain just because it can also speak.

## Implementation Direction

Keep the code vocabulary aligned with the architecture:

- `voice` is the sense.
- `PhoneTransport` or equivalent is the phone-number adapter boundary.
- `TwilioMediaStreamPhoneTransport` is the current implementation.
- `OpenAISipPhoneTransport` is the target implementation.
- `BrowserMeetingVoiceTransport` is the meeting/browser implementation.
- `voice_end_call` and `voice_play_audio` are Voice call tools whose transport
  implementations may differ.

The SIP thin slice proves:

1. A Twilio-routed phone call reaches OpenAI SIP.
2. Ouro receives and verifies `realtime.call.incoming`.
3. Ouro accepts the call with Slugger's voice-native session configuration.
4. Slugger greets and converses through the same stable Voice session.
5. Transcripts persist in the same overview-visible text path.
6. `voice_end_call` maps to the OpenAI call-control API.
7. Twilio Media Streams remains available as fallback until SIP has parity for
   non-speech call audio, provider failure recovery, and richer operations.
