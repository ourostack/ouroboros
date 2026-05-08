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

- Twilio phone: call webhook -> record -> Whisper.cpp -> stable voice session
  -> tool-delivered text -> ElevenLabs -> Twilio Play. The default managed
  phone path gives Twilio a streaming Play URL, so ElevenLabs audio chunks can
  flow as they arrive. Full duplex interruption/barge-in is a future
  bidirectional media-stream transport, not a separate voice sense.
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
