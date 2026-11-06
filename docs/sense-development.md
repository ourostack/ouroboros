# Sense Development Contract

Ouro senses are transcript/session surfaces. Transports are how a sense touches
the outside world.

## Shape

- A sense owns the durable channel concept: `voice`, `mail`, `bluebubbles`,
  `teams`, `cli`, `inner`.
- A transport adapts a specific medium into that sense: Twilio phone is a
  Voice transport; a browser-driven Riverside/meeting joiner should also be a
  Voice transport.
- A voice session should persist as ordinary text under
  `state/sessions/<friend>/voice/<session>.json`; audio is an attachment or
  playback artifact, not the canonical transcript.
- Transport connection IDs are not automatically session IDs. For example,
  Twilio CallSid belongs to a single phone call, while the voice session key
  should represent the stable phone voice channel so repeated calls continue
  the same conversation.

## Turn Contract

All outward sense turns run in tool-required mode. A visible response is not
necessarily stored in `assistant.content`.

Use `runSenseTurn()` for non-interactive senses. If a transport needs live
delivery, pass a `deliverySink`; the sink receives the same outward `speak` and
`settle` text that chat-style channels receive through callbacks. If a
transport needs to replay the text after the turn, use
`extractOutwardSenseDeliveryText()` from `src/senses/shared-turn.ts` instead of
reading session messages by hand.

Authoritative outward delivery is:

- `settle.answer` followed by a tool result of `(delivered)`
- `speak.message` followed by a tool result of `(spoken)`

These are not outward delivery:

- inner-dialog `settle` followed by `(settled)`
- malformed or blank tool arguments
- tool calls without a matching ack
- tool acks after another non-tool message has started
- raw assistant reasoning such as `<think>...</think>`

## Voice

Voice is one transcript-first sense with multiple speaking transports.
See [Voice Architecture](voice-architecture.md) for the fuller transport model.

- Spoken voice is part of agent identity. Keep one current spoken identity per
  voice transport family instead of presenting multiple provider voices as
  equally canonical. Native Realtime phone should use `voice.openaiRealtimeVoice`
  as the current phone voice, `voice.openaiRealtimeVoiceStyle` as the spoken
  identity target, and `voice.openaiRealtimeVoiceSpeed` only for small cadence
  nudges; ElevenLabs remains a legacy cascade compatibility path unless it earns
  a distinct non-redundant role.
- Twilio phone: `record-play` mode keeps the conservative call webhook ->
  record -> Whisper.cpp -> stable voice session -> tool-delivered text ->
  ElevenLabs -> Twilio Play smoke path. `media-stream` mode uses the same
  voice session/STT/TTS contract over a bidirectional Twilio Media Stream: VAD
  frames caller utterances, Whisper.cpp transcribes generated utterance WAVs,
  the agent-authored greeting can prebuffer while the phone is still ringing,
  ElevenLabs emits `ulaw_8000` chunks back to Twilio, and caller speech during
  playback sends Twilio `clear` before the utterance is queued as an
  interruption/follow-up.
- Native Realtime phone is a `media-stream` conversation engine, not a separate
  sense. Keep its prompt voice-native and low-latency: load the agent's core
  identity/voice guidance, recent voice transcript, and tools, but do not send
  the entire general-purpose prompt blob into every Realtime call.
- OpenAI SIP is the preferred low-latency phone transport for any phone-number
  lane that can route SIP. It still belongs under the same `voice` sense:
  Twilio or another SIP provider owns the phone number/trunk, OpenAI owns the
  live media leg, and Ouro owns session keys, transcripts, tools, routing, and
  call-control policy. The current reversible path is
  `voice.twilioConversationEngine=openai-sip`: Twilio returns `<Dial><Sip>`,
  OpenAI posts `realtime.call.incoming` to Ouro, and Ouro accepts/controls the
  call.
- Voice calls are not mouth-only. The voice tool surface includes call controls
  such as `voice_end_call` and `voice_play_audio`; active phone transports
  should implement those controls through the strongest media path available.
  Twilio Media Streams can inject raw audio frames. Direct OpenAI SIP can
  produce short model-rendered tone cues, while arbitrary URL/file clip bytes
  must report the media-bridge limitation instead of pretending playback
  happened.
- Voice pending is synchronous by default. Pending voice messages older than
  fifteen minutes are archived under `state/pending-expired/...` before model
  injection, so stale call scripts or superseded identity notes cannot surprise
  the friend during a fresh live conversation.
- Meeting/browser: meeting URL intake and audio routing should feed the same
  Voice session contract. Browser automation joins the room; it should not
  become a separate conversational sense unless it has a distinct durable
  channel identity.
- Overview/Ouro Mailbox should show the text transcript. Audio files are
  playback evidence, not the primary record.

## Adapter Checklist

When adding or changing a sense transport:

1. Decide the durable sense and session key first.
2. Convert inbound medium events into transcript text or bounded attachments.
3. Start a real agent turn with enough context for the agent to respond as
   itself. Do not hardcode greetings or social filler in the transport.
4. Deliver outward text from callbacks when streaming is available.
5. If replay is needed, recover only tool-acknowledged outward delivery with
   `extractOutwardSenseDeliveryText()`.
6. Persist artifacts beside the sense state and make the text transcript the
   thing humans inspect in overview surfaces.
