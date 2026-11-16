// The mock the Ouro AX X-ray checks the CLI against in CI: a loopback server that answers with made-up data only.
// It is started by .github/workflows/ax-xray.yml, and `--mock` proves it is the mock by reading `mock` from it.
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? "0");
const host = "127.0.0.1";

const server = createServer((request, response) => {
  if (request.method !== "GET" || request.url !== "/") {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ mock: "ouroboros-ax-xray", agent: "inbox-agent" }));
});

server.listen(port, host, () => {
  const address = server.address();
  if (address && typeof address === "object") console.log(`http://${host}:${address.port}/`);
});
