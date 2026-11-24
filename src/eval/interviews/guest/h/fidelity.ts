/**
 * How each H arm departs from the harness as shipped, with the reason, for the report's `fidelity` (keyed
 * `H:<arm>`). Every setting an arm turns off is here: the codex arm's test checks each `false` or `disabled` in its
 * config against these notes by key name.
 */

/** Departures every H arm shares, and where the `ouro` arm still differs from the others. */
export const H_OURO_FIDELITY: readonly string[] = [
  "no provider retries, as in every arm: each error from the host's runtime is marked not retryable, so a retry is never a second metered call",
  "offers web_search and fetch_url, which fail in the sandbox (no route off the host); the other arms don't offer web search at all, since their hosted search tools can't reach the host's runtime",
  "the bundle sits at its production path, where the turn reads it; the arm's list shows the model that path, and /home/ouro, as the other arms' neutral ones (/tmp/agent/AgentBundles/sanctuary.agent), which the guest links to the real ones",
  "every arm's list rewrites the container's user name (ouro) and real paths in what the model sees, tool results included, so a rewritten name that is no path (the user agent, AGENT_HOME, ~/.agent) finds nothing when the model types it, nor does an id or file name with a brand word inside it; model names are in no list, so the host's scan voids a session that shows one",
  "the neutral home is a real folder under /tmp in every arm, with the bundle linked at /tmp/agent/AgentBundles/sanctuary.agent; in the ouro arm, the real home's entries are linked into it when the arm starts, and one the turn makes later is not",
  "skills aren't listed in the prompt: a skill reaches the model only when the agent reads its file, while the other arms list each skill's name and when-line",
  "in every arm, the host's brand scan, the leak check and the replacement lists leave a provider's encrypted reasoning (each encrypted_content string, and a reasoning item's id, which Copilot also returns as opaque base64) as it is, since the scan can't read ciphertext and changing it would corrupt it; the provider decrypts it for the model, so a brand word in that reasoning goes unchecked, while its summary and every other field are scanned and rewritten; in an id (a call's, an item's or a response's), a brand word counts only as a whole segment, between the value's ends or _ - . : /, since most ids are random letters; a digit or a capital letter does not split a segment, so an arm's own id such as gpt4o_1 would pass, and no arm builds ids that way",
]

export const H_CODEX_FIDELITY: readonly string[] = [
  "request_max_retries, stream_max_retries and unbounded_connection_retries are off: a retry would be a second metered call, and the H wire answers every failure with a 400 codex never retries",
  "view_image is off: its output is an image, which the H wire can't carry",
  "multi_agent (sub-agents) is off, through both the deprecated [features] multi_agent and [agents] enabled = false: its tools are a namespace, not functions, which the H wire can't carry",
  "the goal tools (get_goal, create_goal, update_goal) stay on: codex's goals feature is stable and on by default at this commit",
  "request_user_input is offered, as stock codex offers it, though its description says it works only in Plan mode, which the arm never uses",
  "web_search is disabled: it is a hosted tool the host's runtime can't run, and the sandbox has no route off the host",
  "plugins and apps are off, and with them tool suggestions: the sandbox has no route off the host",
  "bundled skills are off ([skills.bundled] enabled = false): they are about codex itself, not the household",
  "analytics, the otel exporters (exporter, trace_exporter and metrics_exporter) and check_for_update_on_startup are off: the sandbox has no route off the host; the model sees no difference",
  "the request's own settings (tool_choice, parallel_tool_calls, reasoning, include, store, prompt_cache_key and the like) are not passed on: the host's runtime sets the model's settings, as it does for the ouro arm",
  "on a Responses API target (Copilot), codex's reasoning items go back to the model between calls as codex sends them, ciphertext included and each in its place, as the ouro arm's own reasoning does; a chat-completions target (MiniMax) returns none, in every arm",
  "codex's leading developer messages become one system message, joined with a blank line, and a message's text parts are joined with a newline, since the harness's messages carry one string each",
  "codex doesn't know the model's name, so it runs as for any unknown model: its generic base prompt, no apply_patch tool, and output of each tool call cut at 10,000 bytes",
  "codex's base prompt is rewritten before the call reaches the model: its first sentences say a coding agent running in a terminal-based coding assistant, and the line on what Codex refers to is removed",
  "what the shell shows of the brand (the variables codex sets, CODEX_HOME, CODEX_THREAD_ID, CODEX_SESSION_ID and CODEX_CI, and codex's own name in output) is rewritten to AGENT_ and agent in tool results; codex adds no helper folder to PATH, since it refuses to create one under /tmp",
  "codex runs from a neutral home under /tmp (the agent container is read-only elsewhere), with the bundle linked at /tmp/agent/AgentBundles/sanctuary.agent",
  "codex is killed at 540 seconds, inside the host's 600-second guest deadline, and the turn reports that it exited 137; commands it started stop when the host removes the container at the guest's end",
  "the books checks read each exec_command as a shell call in its workdir; a command typed into an open session through write_stdin is not read as one",
  "built from source at the pinned commit for x86_64 gnu (on the x86_64 sandbox host, which runs every session), not codex's released musl build, without the release's version stamp",
]

export const H_OPENHANDS_FIDELITY: readonly string[] = [
  "num_retries = 0: LiteLLM's retries are off, since a retry would be a second metered call",
  "the agent's tools are the terminal and the file editor, as pre-registration v2 names, plus the SDK's own finish tool and, when a skill is installed, its invoke_skill tool; the SDK's default preset also gives the task tracker and the browser, and the browser couldn't reach anything in the sandbox",
  "no condenser: the default preset summarises a long history with extra model calls; these conversations are short",
  "load_user_skills = True: the bundle's skills are installed as user skills and listed in the prompt's skills block, as codex lists them; the default preset loads none",
  "the model's reasoning is not sent back between calls: the H wire's chat answer carries none, while on a Responses API target (Copilot) the ouro and codex arms send theirs back",
  "the model is called through chat completions without streaming (api_mode chat, stream False), since the H wire answers chat only whole",
  "the request's own settings (max_completion_tokens, prompt_cache_key) are not passed on: the host's runtime sets the model's settings, as it does for the ouro arm",
  "the SDK doesn't know the model's name (openai/model), so it uses its defaults for an unknown model; LITELLM_LOCAL_MODEL_COST_MAP = True makes LiteLLM read the cost map it ships with instead of fetching one",
  "the Butler's persona and the label line are the system message's suffix, after the SDK's own system prompt",
  "the system prompt is the default preset's (system_prompt_kwargs cli_mode False), so its security-risk wording is the preset's, not the command line's",
  "the SDK's system prompt and tool descriptions are rewritten before the call reaches the model: the self-documentation section, the previous-conversations and skills-docs lines and the security-risk note's origin are removed, the opening says a helpful AI assistant, and the git identity reads agent <agent@agent.dev>",
  "what the shell shows of the brand (the tmux socket and session names in TMUX, the ~/.openhands folder) is rewritten to agent in tool results; the LITELLM_LOCAL_MODEL_COST_MAP variable has no brand word. AI_AGENT is set to a neutral name, where the SDK would set its own",
  "the SDK runs on the uv-managed Python 3.13 and uv 0.13.7 its own agent-server image uses, with bytecode compiled at build time because the image is read-only when the arm runs",
  "runs from a neutral home under /tmp (the agent container is read-only elsewhere), with the bundle linked at /tmp/agent/AgentBundles/sanctuary.agent",
  "the books checks read each terminal call as a shell call in the folder the terminal reported after the call before (tmux keeps the folder between calls); the first starts in the workdir",
  "the supervisor process is killed at 540 seconds, inside the host's 600-second guest deadline; the terminal's tmux and anything it started stop when the host removes the container at the guest's end",
  "SHELL is /bin/bash: tmux runs its session through SHELL, and the image's user has no login shell to fall back on",
  "the supervisor's stdout carries only its status lines; anything the SDK or LiteLLM prints goes to stderr",
]
