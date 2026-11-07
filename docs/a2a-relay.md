# Reaching an agent while it is offline (A2A relay)

An agent's sealed A2A message to a peer goes direct first. When the peer does not answer (its machine is asleep, its tunnel is down), the same sealed message is queued at the peer's [friends-relay](https://github.com/ourostack/friends-relay) inbox, and the peer handles it when it comes back. The relay only ever holds ciphertext, and every queued message passes the same checks as a direct one (seal, signature, pinned key, replay, friend trust).

A peer learns where to queue mail for an agent by asking it, over a sealed call, after a direct message has gone through. Only an active friend or family peer gets the answer. So a relay only helps between agents that have talked directly at least once.

## Turn it on for an agent

You need a friends-relay deployment and an invite from it (`POST /admin/invites` with the relay's admin credential). Run the relay with `RELAY_STORE=postgres`, `RELAY_INVITE_POLICY=closed`, and `RELAY_DIRECTORY_CREDENTIAL` set, and set `RELAY_MESSAGE_TTL_MS` below 6 days: agents refuse envelopes older than 7 days.

On the machine that runs the agent:

```bash
ouro vault config set --agent <agent> --scope machine --key a2a.relay.url --value https://relay.example
ouro vault config set --agent <agent> --scope machine --key a2a.relay.inviteToken
```

The second command has no `--value`, so the CLI asks for the invite without echoing it and the invite stays out of your shell history.

Then restart the agent's A2A sense (or the daemon). At start the sense registers with the relay, saves the registration in the same machine config (`a2a.relay.registration`), clears the invite, and polls the inbox every 30 seconds.

## Change or revoke

- **New credentials** (for example, to cut off a former friend that still holds the old ones): set a new `a2a.relay.inviteToken` and restart. The agent keeps its inbox handle and gets new credentials.
- **Move to another relay**: set the new `a2a.relay.url` and an invite for it, and restart. The agent registers on the new relay and keeps the old registration until the old inbox is empty: at each start it handles what is queued there, pass after pass, and removes the old registration once a pull comes back empty. A message it cannot handle yet (for example, one another process is handling at that moment) keeps the old registration until a later start.
  - **One move at a time.** If you move again while the relay before the current one still holds messages, the sense logs `channel.a2a_relay_move_waiting` and stays on the current relay. It retries at each start and makes the move once that older inbox is empty or that relay is gone. Nothing to clear by hand.
  - **Old relay gone.** If the old relay refuses connections, its name no longer resolves, or it answers 401 or 404 (for example, it was shut down or lost its registrations), the agent retires it anyway, logs `channel.a2a_relay_previous_gone` and tells the owner that messages still waiting there are lost. Senders' next messages go through the new relay or directly.
- **Registration lost**: if the relay stops accepting the agent's inbox credential, the sense logs `channel.a2a_relay_unauthorized` and stops polling. Set a new `a2a.relay.inviteToken` and restart.

Check what is set with `ouro vault config status --agent <agent> --scope machine`.
