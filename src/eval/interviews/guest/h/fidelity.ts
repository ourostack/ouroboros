/**
 * How each H arm departs from the harness as shipped, with the reason, for the report's `fidelity` (keyed
 * `H:<arm>`). Every setting an arm turns off is here: the codex arm's test checks each `false` or `disabled` in its
 * config against these notes by key name.
 */

/** Departures every H arm shares, and where the `ouro` arm still differs from the others. */
export const H_OURO_FIDELITY: readonly string[] = [
  "no provider retries, as in every arm: each error from the host's runtime is marked not retryable, so a retry is never a second metered call",
  "offers web_search and fetch_url, which fail in the sandbox (no route off the host); the other arms don't offer web search at all, since their hosted search tools can't reach the host's runtime",
  "the bundle sits at its production path, so the working folder the model sees differs from the other arms' neutral path",
  "skills aren't listed in the prompt: a skill reaches the model only when the agent reads its file, while the other arms list each skill's name and when-line",
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
  "analytics, the otel exporters and check_for_update_on_startup are off: the sandbox has no route off the host; the model sees no difference",
  "the request's own settings (tool_choice, parallel_tool_calls, reasoning, include, store, prompt_cache_key and the like) are not passed on: the host's runtime sets the model's settings, as it does for the ouro arm",
  "codex's leading developer messages become one system message, joined with a blank line, and a message's text parts are joined with a newline, since the harness's messages carry one string each",
  "codex doesn't know the model's name, so it runs as for any unknown model: its generic base prompt, no apply_patch tool, and output of each tool call cut at 10,000 bytes",
  "the brand words in codex's base prompt are replaced before the call reaches the model",
  "the shell can still show the brand through the CODEX_HOME variable's name, which isn't in the prompt; codex adds no helper folder to PATH, since it refuses to create one under /tmp",
  "codex runs from a neutral home under /tmp (the agent container is read-only elsewhere), with the bundle linked at /tmp/agent/AgentBundles/sanctuary.agent",
  "the whole conversation is killed at 540 seconds, inside the host's 600-second guest deadline",
  "built from source at the pinned commit for x86_64 gnu, not codex's released musl build, without the release's version stamp",
]

export const H_OPENHANDS_FIDELITY: readonly string[] = [
  "num_retries = 0: LiteLLM's retries are off, since a retry would be a second metered call",
  "the agent's tools are the terminal and the file editor, as pre-registration v2 names, plus the SDK's own finish tool and, when a skill is installed, its invoke_skill tool; the SDK's default preset also gives the task tracker and the browser, and the browser couldn't reach anything in the sandbox",
  "no condenser: the default preset summarises a long history with extra model calls; these conversations are short",
  "load_user_skills = True: the bundle's skills are installed as user skills and listed in the prompt's skills block, as codex lists them; the default preset loads none",
  "the model is called through chat completions without streaming (api_mode chat, stream False), since the H wire answers chat only whole",
  "the request's own settings (max_completion_tokens, prompt_cache_key) are not passed on: the host's runtime sets the model's settings, as it does for the ouro arm",
  "the SDK doesn't know the model's name (openai/model), so it uses its defaults for an unknown model; LITELLM_LOCAL_MODEL_COST_MAP = True makes LiteLLM read the cost map it ships with instead of fetching one",
  "the Butler's persona and the label line are the system message's suffix, after the SDK's own system prompt",
  "the system prompt is the default preset's (system_prompt_kwargs cli_mode False), so its security-risk wording is the preset's, not the command line's",
  "the brand words in the SDK's system prompt and tool descriptions are replaced before the call reaches the model",
  "the shell can still show the brand: the tmux socket and session names in TMUX, the ~/.openhands folder, and the LITELLM_LOCAL_MODEL_COST_MAP variable; none is in the prompt. AI_AGENT is set to a neutral name, where the SDK would set its own",
  "the SDK runs on the uv-managed Python 3.13 and uv 0.13.7 its own agent-server image uses, with bytecode compiled at build time because the image is read-only when the arm runs",
  "runs from a neutral home under /tmp (the agent container is read-only elsewhere), with the bundle linked at /tmp/agent/AgentBundles/sanctuary.agent",
  "the supervisor process is killed at 540 seconds, inside the host's 600-second guest deadline; the terminal's tmux and anything it started stop when the host removes the container at the guest's end",
  "SHELL is /bin/bash: tmux runs its session through SHELL, and the image's user has no login shell to fall back on",
  "the supervisor's stdout carries only its status lines; anything the SDK or LiteLLM prints goes to stderr",
]
