#!/usr/bin/env node
// The harness's in-turn tools over stdio JSON-RPC, one message a line, for the Ouro AX X-ray's `--tools`: tools/list
// serves every registered tool with its card and the dispatcher's shared error cards; tools/call answers the
// dispatcher's checks as a typed outcome and never runs a tool. It reads the built harness, so run `npm run build` first.
import { createRequire } from "node:module";
import readline from "node:readline";

const require = createRequire(import.meta.url);
// The Butler's product is loaded as its image loads it, so the tools it adds (the root-host tool) are X-rayed with core's.
require("../../dist/heart/product/active.js").loadProduct(require.resolve("../../dist/products/butler.js"));
const { listInTurnTools, callInTurnTool, DISPATCH_ERRORS } = require("../../dist/repertoire/in-turn-tools-door.js");

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id === undefined) return;
  if (message.method === "tools/list") return send({ id: message.id, result: { tools: listInTurnTools(), errors: DISPATCH_ERRORS } });
  if (message.method === "tools/call") {
    const { name, arguments: args = {} } = message.params ?? {};
    return send({ id: message.id, result: await callInTurnTool(String(name), args) });
  }
  send({ id: message.id, error: { code: -32601, message: `no method ${message.method}; this server answers tools/list and tools/call` } });
});
