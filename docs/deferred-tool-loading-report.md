# Deferred tool loading: trial report

The trial from `deferred-tool-loading-design.md` is implemented behind `OURO_DEFERRED_TOOLS=1` (also `true` or
`on`). It is **off by default**: with the flag unset, the request is byte-for-byte what it was before.

## What the flag does

- Each turn sends a core set of 27 tools plus `find_tools`. The other tools are deferred.
- `find_tools` takes a query (keyword search) or `select:name,name` (exact load). Its description carries a grouped
  catalogue of the deferred names, so the model knows what exists.
- Tools found are added **at the end** of the tool list, so core order stays stable for prompt caching. They stay
  loaded for the rest of the `runAgent` call. A deferred tool already called in the conversation history stays
  loaded on later turns.
- Required tools and tools with unresolved historical effects are always kept loaded.
- The search pool is the relationship-scoped tool list, so `find_tools` cannot reveal a tool the relationship
  envelope hides. `find_tools` skips the relationship preflight (it carries no authority).
- A deferred tool called before it is loaded is refused by the existing "was not advertised" path.
- Handlers, trust, purchase and trip checks, approvals and tokens are untouched. The MCP export is built from
  definitions and is unaffected.
- Hard-disabled turns and the sanctuary-health-private profile never defer.

Core set: settle, ponder, observe, rest, speak, surface, send_message, load_skill, list_skills, read_file,
write_file, edit_file, glob, grep, ls, shell, shell_status, shell_tail, web_search, fetch_url, note, diary_write,
consult_diary, consult_notes, search_facts, get_friend_note, save_friend_note.

## Measurements

`node scripts/measure-prompt.cjs --deferred` on its fixtures. **Schema bytes are the registry's OpenAI-format JSON
size, not the bytes of a provider request.** Token figures are the script's estimate (bytes / 4 plus prompt),
not provider-counted tokens. Provider wire payloads were not measured (see Limits).

| Channel | Tools off → on | Schema bytes off → on | Per-turn tokens off → on | Saved per turn |
|---|---|---|---|---|
| cli | 113 → 26 | 65,463 → 15,357 | 19,547 → 7,021 | 12,526 |
| teams | 135 → 26 | 77,873 → 15,647 | 22,676 → 7,119 | 15,557 |
| bluebubbles | 115 → 25 | 66,499 → 14,907 | 19,983 → 7,085 | 12,898 |
| inner | 111 → 24 | 65,446 → 15,340 | 20,023 → 7,496 | 12,527 |
| mcp | 112 → 25 | 64,982 → 14,876 | 19,454 → 6,927 | 12,527 |

**First-request savings vs full-turn overhead.** The table is the saving on the first request of a turn that
needs no deferred tool, which is most turns. A turn that needs one deferred tool also pays: one extra model round
trip, the `find_tools` call and result (a few hundred tokens), and the loaded schemas (about 150–300 tokens each,
for example five `coding_*` tools is roughly 1,000–1,500 tokens) on every later request in that turn. Even then the
turn stays several thousand tokens under baseline, but it is one round trip slower. Net savings over a real turn
mix were not measured; the design note's advice to log real tool use for a week still stands.

## Scenarios

Paired baseline (flag off) vs flag on. **These were simulated, not live:** a model-playing subagent was given the
real system prompt, the real tool list for that mode, and ran the real `find_tools` search code
(`scripts/deferred-scenarios.cjs`). Each run is one decision pass with a single sample and the tool results were
assumed, so this shows discoverability and tool choice, not provider behaviour.

| Scenario | Baseline | Flag on | Result |
|---|---|---|---|
| Skill discovery | `list_skills` | `list_skills` (core, 0 searches) | Same |
| Delegation | `coding_spawn`, same args | `find_tools("coding agent spawn")`, then `coding_spawn`, same args | Found first try; +1 round trip |
| Image second pass | `list_recent_attachments`, then `describe_image` | `find_tools`, then `list_recent_attachments` | Found; +1 round trip; also loaded an unrelated tool (search noise) |
| Memory routing | `save_friend_note` | `save_friend_note` (core, 0 searches) | Same |
| Session search | `search_facts` (no chat-history tool existed) | 2 searches, nothing matched, then `consult_diary` | Same fallback; 2 wasted searches |
| Trip (guarded) | `trip_replace_preview` then `trip_upsert` with token | 3 searches, then the same preview and `trip_upsert` with token | Guard path intact; first search missed `trip_replace_preview` and `trip_get`, needing more searches |
| Purchase (guarded) | `commerce_checkout_preview`, stops for confirmation | 2 searches, same preview, stops for confirmation | Guard path intact |

Findings: the agent found and used every tool it needed. The cost is extra searches on the first use, worst for
guarded multi-step flows (trip: 3 searches). Keyword search is noisy. Candidates for follow-up: add the trip
and commerce tools to the core set if real-use logs show they are common, or boost exact-name matches.

## Guard and regression evidence

- Unit tests (`deferred-tools.test.ts`, `core-deferred-tools.test.ts`): flag off sends all tools and no
  `find_tools`; flag on defers, loads via `find_tools` and advertises the tool on the next request; an unloaded
  deferred call is rejected; a tool called earlier in history stays loaded; an unmatched query is reported.
- No handler, guard, approval, or token code changed. The full suite and the coverage gate pass.

## Limits

- No live provider run: provider request bytes, `tool_choice`, and argument fidelity on a real model were not
  measured. Scenarios above are simulated.
- Token counts are estimates.
- One sample per scenario.

## Recommendation

Merge as an off-by-default flag (done by this change). Do not turn it on in the live bundle yet. Before enabling:
run it on a non-production agent for about a week with real provider usage, log `engine.deferred_tools_loaded`,
promote the commonly loaded tools to the core set, and compare provider-reported tokens, latency and failure rate.
The saving (about 12,500–15,500 estimated tokens on a turn that needs no deferred tool) is large enough to justify
that trial.
