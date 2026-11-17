// A stand-in for the shepherd CLI for tests. It appends each call's argv and JSON stdin to calls.jsonl next to itself, then
// answers with the reply set for its verb (argv[0]) in reply.json next to itself: { body, code, stderr, delayMs }.
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const dir = path.dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const stdin = argv.includes("--input") ? fs.readFileSync(0, "utf-8") : null
fs.appendFileSync(path.join(dir, "calls.jsonl"), `${JSON.stringify({ argv, input: stdin === null ? undefined : JSON.parse(stdin) })}\n`)
const replyFile = path.join(dir, "reply.json")
const replies = fs.existsSync(replyFile) ? JSON.parse(fs.readFileSync(replyFile, "utf-8")) : {}
const reply = replies[argv[0]] ?? {}
setTimeout(() => {
  if (reply.stderr) process.stderr.write(reply.stderr)
  process.stdout.write(`${typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body ?? {})}\n`)
  process.exitCode = reply.code ?? 0
}, reply.delayMs ?? 0)
