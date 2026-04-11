import * as fs from "fs"
import * as http from "http"
import * as path from "path"

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
}

export function normalizeOutlookRequestPath(urlValue = "/"): string {
  const parsed = new URL(urlValue, "http://127.0.0.1")
  const normalizedPath = parsed.pathname.replace(/\/+$/, "")
  if (normalizedPath.length === 0) return "/"
  return normalizedPath
}

export function normalizeLegacyOutlookApiPath(pathname: string): string {
  if (pathname.startsWith("/outlook/api/")) return pathname.slice("/outlook".length)
  if (pathname === "/outlook/api") return "/api"
  return pathname
}

function defaultSpaDistCandidates(): string[] {
  return [
    path.resolve(__dirname, "..", "..", "..", "packages", "outlook-ui", "dist"),
    path.resolve(__dirname, "..", "..", "packages", "outlook-ui", "dist"),
    path.resolve(__dirname, "..", "..", "..", "..", "packages", "outlook-ui", "dist"),
    path.resolve(__dirname, "..", "..", "outlook-ui"),
    path.resolve(__dirname, "..", "outlook-ui"),
  ]
}

export function resolveSpaDistDir(candidates = defaultSpaDistCandidates()): string | null {
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "index.html"))) return candidate
  }
  return null
}

export function serveStaticFile(response: http.ServerResponse, filePath: string): boolean {
  try {
    if (!fs.existsSync(filePath)) return false
    const ext = path.extname(filePath)
    const contentType = MIME_TYPES[ext] ?? "application/octet-stream"
    const content = fs.readFileSync(filePath)
    response.writeHead(200, {
      "content-type": contentType,
      "cache-control": ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
    })
    response.end(content)
    return true
  } catch {
    return false
  }
}
