// The openhands arm's supervisor (deploy/eval/openhands/supervise.py), run by Python against stand-in `openhands` and
// `pydantic` packages: its stdout carries only status lines, whatever the SDK prints while it loads or runs.
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

const SUPERVISOR = path.resolve(__dirname, "../../../../deploy/eval/openhands/supervise.py")

const STUBS: Record<string, string> = {
  "pydantic/__init__.py": "class SecretStr:\n    def __init__(self, value):\n        self.value = value\n",
  "openhands/__init__.py": "",
  "openhands/sdk/__init__.py": [
    "import sys",
    "print('noise while the SDK loads')",
    "class _Kw:",
    "    def __init__(self, **kwargs):",
    "        self.kwargs = kwargs",
    "class LLM(_Kw): pass",
    "class Agent(_Kw): pass",
    "class AgentContext(_Kw): pass",
    "class Tool(_Kw): pass",
    "class _Status:",
    "    value = 'finished'",
    "class _State:",
    "    execution_status = _Status()",
    "class Conversation:",
    "    def __init__(self, **kwargs):",
    "        self.state = _State()",
    "        self.message = None",
    "    def send_message(self, message):",
    "        self.message = message",
    "    def run(self):",
    "        print()",
    "        print('Give Feedback / Get Help', flush=True)",
    "        if self.message == 'fail':",
    "            raise RuntimeError('boom')",
    "    def close(self):",
    "        sys.stderr.write('closed\\n')",
    "",
  ].join("\n"),
  "openhands/tools/__init__.py": "",
  "openhands/tools/file_editor/__init__.py": "class FileEditorTool:\n    name = 'file_editor'\n",
  "openhands/tools/terminal/__init__.py": "class TerminalTool:\n    name = 'terminal'\n",
}

describe("the openhands supervisor", () => {
  const made: string[] = []
  afterEach(() => { for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })

  it("prints only its status lines on stdout, one per message, and sends what the SDK prints to stderr", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "h-supervise-"))
    made.push(root)
    for (const [file, text] of Object.entries(STUBS)) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
      fs.writeFileSync(path.join(root, file), text)
    }
    const spec = path.join(root, "spec.json")
    fs.writeFileSync(spec, JSON.stringify({ baseUrl: "http://127.0.0.1:1/v1", workdir: root, systemSuffix: "persona" }))
    const ran = spawnSync("python3", [SUPERVISOR, spec], {
      input: `${JSON.stringify("hi")}\n\n${JSON.stringify("fail")}\n${JSON.stringify("never")}\n`,
      env: { PATH: process.env.PATH, PYTHONPATH: root, PYTHONDONTWRITEBYTECODE: "1" },
      encoding: "utf8",
    })
    expect(ran.stdout.split("\n")).toStrictEqual(['{"status": "finished"}', '{"error": "RuntimeError: boom"}', ""])
    expect(ran.status).toBe(1)
    expect(ran.stderr).toContain("noise while the SDK loads")
    expect(ran.stderr).toContain("Give Feedback / Get Help")
    expect(ran.stderr).toContain("closed")
  })
})
