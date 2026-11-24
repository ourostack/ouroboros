"""H's `openhands` arm, inside the agent container: one OpenHands conversation (Software Agent SDK at ecea9a91d8d0)
with its terminal and file-editor tools, on the H wire as its only model provider.

Usage: supervise.py <spec.json>, where the spec gives `baseUrl`, `workdir` and `systemSuffix` (the Butler's persona
and the label line). Each line on stdin is one message, as a JSON string: the job first, then each follow-up, the
owner's next message in the same conversation. After each, one JSON line is printed: {"status"} with the
conversation's state when it stopped, or {"error"} and exit status 1 when it failed.
"""

import json
import os
import sys

# Status lines go only to the real stdout, kept here; anything a library prints (LiteLLM's error banner, a logger)
# goes to stderr instead, so it can never be read as a status line and put the turns out of step.
_STATUS = os.fdopen(os.dup(1), "w", encoding="utf-8")
os.dup2(2, 1)
sys.stdout = sys.stderr

from pydantic import SecretStr  # noqa: E402

from openhands.sdk import LLM, Agent, AgentContext, Conversation, Tool  # noqa: E402
from openhands.tools.file_editor import FileEditorTool  # noqa: E402
from openhands.tools.terminal import TerminalTool  # noqa: E402


def report(line: dict) -> None:
    _STATUS.write(json.dumps(line) + "\n")
    _STATUS.flush()


def main(spec_file: str) -> int:
    with open(spec_file, encoding="utf-8") as handle:
        spec = json.load(handle)
    # No retries: a retried call would be metered twice. The model name is the wire's; the host picks the model.
    llm = LLM(
        usage_id="agent",
        model="openai/model",
        base_url=spec["baseUrl"],
        api_key=SecretStr("eval"),
        api_mode="chat",
        num_retries=0,
        stream=False,
    )
    agent = Agent(
        llm=llm,
        tools=[Tool(name=TerminalTool.name), Tool(name=FileEditorTool.name)],
        agent_context=AgentContext(system_message_suffix=spec["systemSuffix"], load_user_skills=True),
        # The default preset's prompt wording; without it the SDK uses its command-line wording for security risk.
        system_prompt_kwargs={"cli_mode": False},
    )
    conversation = Conversation(agent=agent, workspace=spec["workdir"], visualizer=None)
    try:
        for line in sys.stdin:
            if not line.strip():
                continue
            try:
                conversation.send_message(json.loads(line))
                conversation.run()
            except Exception as error:  # noqa: BLE001 -- any failure ends the conversation, and the host is told why
                report({"error": f"{type(error).__name__}: {error}"})
                return 1
            status = conversation.state.execution_status
            report({"status": getattr(status, "value", str(status))})
        return 0
    finally:
        # Shuts down the terminal's tmux server, so nothing the conversation started outlives it.
        conversation.close()


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
