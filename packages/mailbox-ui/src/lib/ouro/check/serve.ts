export { globToRegExp, listPages, serve };
export type { Server };

import { readdir, readFile, stat } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, relative, resolve, sep } from "node:path";

// The built-folder side of check.ts: a static server for the folder, as a host would serve it, and the folder's pages.

interface Server {
  origin: string;
  close: () => Promise<void>;
}

const TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".txt": "text/plain",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

// Serves `folder` on a free local port: a path ending in / (or naming a folder) gets its index.html.
async function serve(folder: string): Promise<Server> {
  const root = resolve(folder);
  const server = http.createServer(async (req, res) => {
    let path: string;
    try {
      path = decodeURIComponent(new URL(req.url!, "http://x").pathname);
    } catch {
      // A lone % that starts no escape, such as /50%off.png.
      return void res.writeHead(400).end();
    }
    if (path.endsWith("/")) path += "index.html";
    let file = join(root, path);
    if (file !== root && !file.startsWith(root + sep)) return void res.writeHead(403).end();
    try {
      if ((await stat(file)).isDirectory()) file = join(file, "index.html");
      const body = await readFile(file);
      res.writeHead(200, { "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream" }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise((done) => server.close(() => done())),
  };
}

// A glob as a regular expression over a whole path: ** crosses folders, * and ? stay within one.
function globToRegExp(glob: string): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      source += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
      i += glob[i + 2] === "/" ? 2 : 1;
    } else if (c === "*") source += "[^/]*";
    else if (c === "?") source += "[^/]";
    else source += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

// Every HTML page in a built folder, as the path a browser asks for (/, /docs/, /404.html), sorted; with `glob`, those
// it matches. Hidden folders and node_modules are left out.
async function listPages(folder: string, glob?: string): Promise<string[]> {
  const root = resolve(folder);
  const pages: string[] = [];
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith(".html")) pages.push(`/${relative(root, path).split(sep).join("/")}`.replace(/(^|\/)index\.html$/, "$1"));
    }
  };
  await walk(root);
  const match = glob === undefined ? null : globToRegExp(glob.startsWith("/") ? glob : `/${glob}`);
  return pages.filter((page) => !match || match.test(page)).sort();
}
