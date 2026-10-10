# Local audio lane

The local audio lane lets an agent join any call app on a Mac (FaceTime, Zoom, Google Meet, a podcast recorder) through two BlackHole virtual audio devices. It reuses the same OpenAI Realtime media-stream session that phone calls use. The session runs inside the `ouro voice join` process, and the audio comes from local processes (sox for capture, ffmpeg for playback) instead of a Twilio WebSocket. There is no network path into it.

This page covers the conversation mode. Group and listen modes, the SPEAK/PASS decision, and the name gate arrive in a later change (PR G). Durable memory of a call arrives in PR F.

## How the audio is wired

The call app's speaker output goes to `BlackHole 16ch`. The lane captures that device. The call app's microphone is `BlackHole 2ch`. The lane plays the agent's voice into that device. The lane never opens a physical microphone: the device names are fixed in the code, the tool takes no device arguments, and the tool refuses any argument that looks like a device.

| Direction | Device the call app uses | What the lane does |
| --- | --- | --- |
| Call app speaker output | BlackHole 16ch | sox captures it as 8 kHz mono mu-law |
| Call app microphone | BlackHole 2ch | ffmpeg plays the agent's audio into it |

The agent's reply audio goes through a paced playback queue (20 ms frames, a small lead, and a clear when the caller interrupts), so barge-in works the same way it does on a phone call.

## Join, leave, status

```
ouro voice join --agent <name> [--friend <id>] [--participants <text>] [--occasion <text>] [--mode conversation]
ouro voice leave --agent <name>
ouro voice status --agent <name>
```

Optional join flags: `--owner-alone`, `--owner-name <name>`, `--silent-consent <statement>`, `--notify-session <friend:channel:key>`, `--idle-silence-ms <n>`, `--max-duration-ms <n>`, and the file-driven pair `--input-file <wav>` with `--output-file <wav>`.

`ouro voice join` runs in the foreground and holds the session. `ouro voice leave` and `ouro voice status` talk to it over a unix socket at `<agent bundle>/state/voice/local-audio/control.sock` (directory mode 0700, socket mode 0600). There is no TCP listener, no HTTP route and no daemon involvement. When that path would be too long for a unix socket (about 100 bytes), the socket moves to `<tmpdir>/ouro-la-<hash>.sock` (a short hash of the state directory, mode 0600). A pid file and a `status.json` sit next to the control socket.

Only one join can run per agent. A join first takes an exclusive lock file (`join.lock`, created with O_EXCL, holding the pid). A second `ouro voice join` sees a live holder and refuses cleanly: it does not touch the first join's sox processes, socket or files. A lock whose process is gone is reclaimed. Leftover socket and pid files are deleted only when the socket proves nobody is listening (connection refused or missing), never because a status request timed out. `ouro voice leave` on a join that is still starting (its socket is not open yet) sends that process SIGTERM, and the join treats it like a leave.

## What is checked before the agent speaks

Joining fails loudly, with the exact fix, instead of producing a silent call:

1. ffmpeg must be installed (`brew install ffmpeg`) and must list `BlackHole 2ch` among its AudioToolbox devices. ffmpeg addresses output devices by index, so the lane looks the index up by name at every join instead of assuming it. Playback uses ffmpeg rather than sox because sox's CoreAudio output can deadlock when the process runs at lowered priority: a zsh background job is niced by default, and so is a launchd Background job. In that state the sox main thread holds a lock inside `AudioDeviceStart` while the device's IO thread waits for it, and the call hears nothing. In live joins on this Mac, 5 of 5 niced joins were silent with sox and 2 of 2 spoke with ffmpeg.
2. Both BlackHole devices must exist. The check lists devices with `SwitchAudioSource`, so that tool must be installed (`brew install switchaudio-osx`); if it is missing the error says so, and it does not claim the BlackHole devices are missing. If a BlackHole device is genuinely missing, the error names `brew install --cask blackhole-2ch blackhole-16ch`.
3. Neither BlackHole device may be muted. A muted BlackHole loops back pure silence. The check reads CoreAudio's mute property through a small Swift program that is compiled once into the agent's private state directory (`state/voice/local-audio/tools/`, mode 0700). The binary's name carries a hash of its source, the build writes only new exclusive files, a failed build leaves nothing behind, and the owner and mode are verified before every run. The error says to open Audio MIDI Setup, select the device and clear Mute on the Main channel. If the mute state cannot be read (no `swiftc`), the next check covers it.
4. A capture probe plays a 3 second tone into BlackHole 16ch (the device the lane captures) and listens on BlackHole 16ch. The tone starts only after the listener has delivered its first audio, so a slow device open cannot make the probe miss it. If it hears nothing, the join fails and names both likely causes: the device is muted, or the process lacks Microphone permission (System Settings, Privacy and Security, Microphone). The probe uses its own sox process, so it never consumes the first seconds of the live capture.

During the call, digital silence and faint background hiss never count as activity for idle detection.

## Cleanup

Each audio process (sox capture, ffmpeg playback) runs in its own process group. It is killed when the session closes, when the parent receives SIGINT or SIGTERM, and when the parent exits. The pids are written to `sox.pids` with their start times, and the next start sweeps any sox or ffmpeg left behind by a crash (the start time check keeps a reused pid safe).

sox can ignore SIGTERM while it is blocked inside CoreAudio, so shutdown sends SIGTERM and then SIGKILL after a 500 ms grace (immediately SIGKILL when the parent itself is exiting). Capture uses sox `--buffer 1024 --input-buffer 8192`. The input buffer stays large enough to avoid "unhandled buffer overrun" drops, and the small processing buffer keeps reply latency down. Stale-process sweeps send SIGTERM and then SIGKILL after a grace, parse process start times independent of the locale (`LC_ALL=C`), and never block the event loop on the hot path. A leave or stop signal that arrives while the join is still starting cancels the start (checked after every step) and ends the call cleanly. Stop-signal handlers are registered before any device starts, so a SIGTERM during startup still writes the end record and notifies the owner.

## Identity and trust

The agent is told it is in a shared audio room, not on a phone line. The instructions say several people may share the audio, that it cannot tell voices apart, and that it should infer from content and ask when it matters. Participants and occasion are passed as data stated by the person who started the session.

Trust is acquaintance unless the join says the owner is alone (`--owner-alone`). When the owner is alone and the friend is identified, the recorded trust level applies. In every other case the session runs at acquaintance, so tool guardrails behave accordingly. Identity is injected into the session when the join starts. Nothing about the room can raise it.

## Disclosure

Every join announces itself aloud: "I'm <agent>, <owner>'s AI assistant; I'm transcribing." The lane tracks that announcement: it counts as spoken only when its Realtime response completed, its transcript finished, a caller barge-in did not cut it, and its audio finished playing out. If it was cut, the lane asks again. If it is still not confirmed after 20 seconds, the join leaves with the end reason `disclosure_failed` and tells the owner. The moment it is confirmed is recorded as `disclosureSpokenAt` in the call metadata (null until then), and the agent is told only then that it has announced itself. The owner's join notice says the agent is announcing itself, never that it already did.

The agent may not name the model provider, but if anyone sincerely asks whether it is an AI, it says yes. Wording changes that turn phone phrasing into room phrasing apply only to the voice transport's own text, never to the agent's SOUL, identity, memory or friend notes.

A silent join is allowed only on the owner's own consent statement. From the CLI that is `--silent-consent`. From the tool, the statement must be one whole sentence of the owner's current message, word for word (whitespace, case and end punctuation aside), of at least five words, that both states consent and asks for a silent join (for example "Everyone agreed to a silent join with no announcement."); a fragment or paraphrase is refused, and the agent should join with the announcement instead. A silent join also fails if the consent cannot be written to the call metadata at `<agent bundle>/state/voice/local-audio/calls/<call id>.json`, which holds the participants, occasion, trust inputs, `disclosureSpokenAt`, the output latency used and the end reason.

## Ending a call

The session ends on `ouro voice leave`, when the capture or playback device stops, when the Realtime session closes, after the idle-silence cap, or at the maximum duration. Conversation mode ends after 5 minutes of silence from everyone and 2 hours in total. Both caps can be overridden per join.

## The tool

`voice_join_local_audio` (actions join, leave, status) lets a family-trusted owner ask the agent to join from a chat. It is offered only in a direct text session (cli, bluebubbles, telegram) with a family-trust friend. It is not offered on voice, inner, habit, group, mail, or A2A turns, in autonomous, delegated or external-event turns, or in relationship-scoped turns, and the handler checks the same rule again when it runs. The tool launches `ouro voice join` as a detached process and waits for it to report joined or failed. The tool waits up to 300 seconds. If the join still has not reported by then, the tool asks it to leave (when its socket is up) or sends its process group SIGTERM, and the reply says which, so no join is left running unsupervised. The owner is notified when the join starts and ends: the notice is delivered live through the same path `send_message` uses (bluebubbles and telegram chats; a cli session queues), and falls back to the owner's pending queue if live delivery fails or is blocked.

The tool is not offered in Teams: Teams reports `isGroupChat` as false for every chat and the harness does not yet record whether a Teams chat is one-to-one, so it cannot rule out a group.

Local audio sessions can use only two tools while in the call: `voice_end_call` and `voice_play_audio`. The restriction applies at any trust level, both when tools are advertised to the model and when a call is executed.

## File-driven mode

`--input-file` and `--output-file` replace the devices. Both must be real file paths: a value starting with `-` (sox reads `-` as standard input and `-d` as the default audio device), a device node or a directory is refused; the input must be an existing regular file and the output's directory must exist. Relative paths are resolved before use. On leave the lane waits for queued reply audio to play out (up to 30 seconds) before finishing, and on a stop signal the WAV writer gets SIGTERM with a grace period before SIGKILL so the file is finalized. The lane decodes the input recording with sox, feeds it to the session at real time (one 20 ms frame per 20 ms, then silence), and writes the agent's audio to the output WAV. Routing checks and the probe are skipped. This is how the lane is tested without audio hardware, and how latency is measured: the two WAVs share a timeline.

## Output latency

The transport subtracts the speaker path from the measured reply latency. The default of 40 ms is an estimate, not a measurement. Set `OURO_LOCAL_AUDIO_OUTPUT_LATENCY_MS` (milliseconds, zero or more) to your own number. The value used is recorded in the call metadata as `outputLatencyMs` with `outputLatencyMeasured: false`.

## Events

Every event is named `senses.voice_local_*`, for example `senses.voice_local_joined`, `senses.voice_local_ended`, `senses.voice_local_join_failed`, and `senses.voice_local_reply_latency` (milliseconds from the last speech frame to the first reply audio). The tool emits `tool.voice_local_audio_*`.

## Deferred

- Group and listen modes, SPEAK/PASS, and the name gate: PR G.
- Durable memory of a call: PR F.
