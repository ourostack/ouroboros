// Serves the built Mailbox app for Ouro check, with made-up data from the app's own test fixtures in place of its API:
// the check reads the app as an agent's person would, and nothing here reaches a real machine.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { defaultResponse, machineView } from "../src/test-fixtures.ts";

const [folder = "dist", portArg = "6878"] = process.argv.slice(2);
const root = resolve(folder);
const port = Number(portArg);
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".png": "image/png",
};

function json(response: import("node:http").ServerResponse, payload: unknown) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname.startsWith("/api/")) {
    const path = url.pathname.slice("/api".length);
    if (path === "/events") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      return;
    }
    if (path === "/machine") return json(response, machineView());
    if (path.endsWith("/continuity")) {
      return json(response, {
        presence: { self: null, peers: [] },
        cares: { activeCount: 0, items: [] },
        episodes: { recentCount: 0, items: [] },
      });
    }
    if (path.endsWith("/orientation")) {
      return json(response, {
        currentSession: null,
        centerOfGravity: "Keeping the mailbox steady.",
        primaryObligation: null,
        resumeHandle: null,
        otherActiveSessions: [],
        rawState: null,
      });
    }
    if (path.endsWith("/habits")) {
      return json(response, { totalCount: 0, activeCount: 0, pausedCount: 0, degradedCount: 0, overdueCount: 0, items: [] });
    }
    if (path.endsWith("/habit-runs")) return json(response, { totalCount: 0, limit: 20, items: [] });
    const fixture = defaultResponse(`/api${path}`);
    if (fixture.ok) {
      const body = (await fixture.json()) as Record<string, unknown>;
      const orientation = body["orientation"] as Record<string, unknown> | undefined;
      if (orientation && !Array.isArray(orientation["otherActiveSessions"])) orientation["otherActiveSessions"] = [];
      return json(response, body);
    }
    return json(response, { items: [] });
  }
  const file = normalize(join(root, url.pathname === "/" ? "index.html" : url.pathname));
  if (!file.startsWith(root)) {
    response.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    response.end(body);
  } catch {
    const index = await readFile(join(root, "index.html"));
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(index);
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`http://127.0.0.1:${port}/`);
});
