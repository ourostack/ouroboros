# Deferred tool loading: design note (not implemented)

## Problem

Tool schemas are now the biggest always-on text: about 16,250–19,500 tokens per turn (66–78 KB), against
about 3,100–3,600 tokens of system prompt. Most turns use a handful of tools.

## Idea

Send a small core set of schemas every turn (for example `settle`, `ponder`, `rest`, `observe`, `surface`,
`load_skill`, `read_file`, `shell`, the memory tools) plus one `find_tools` tool. When the model needs
something else it calls `find_tools` with a short query; the harness returns the matching schemas and adds them to
the following requests in that turn and the next few.

## Risks

- The model must know that a capability exists. A one-line-per-group catalogue costs a few hundred tokens, far
  less than the schemas, but it brings back a version of the name list we just removed.
- Guards must not depend on a tool being loaded. Trust, purchase and trip checks run in the handler, so they
  hold either way, but the relationship envelope must still filter what `find_tools` can return.
- Provider prompt caching: changing the tool list mid-conversation invalidates the cached prefix. Add tools only
  at the end of the list and keep core order stable.
- The MCP export lists tools from definitions, not the prompt, and should stay complete.
- Extra round trip on first use of a deferred tool: latency and one more failure point.

## Recommendation

Worth doing, but as its own change, behind a flag, and measured first: log which tools real turns call over a
week, put the top 15–20 in the core set, defer the rest, and compare cost and failure rate on the flag. Expect
roughly 10,000 tokens saved per turn if 70% of schema bytes are deferred. Do not start until the mini is
unpinned, so the change is tried on a normal build.
