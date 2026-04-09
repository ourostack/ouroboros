import * as http from "node:http"
import type { SenseProbe } from "./health-monitor"

export function createHttpHealthProbe(name: string, port: number, timeoutMs: number = 5000): SenseProbe {
  return {
    name,
    check: () =>
      new Promise<{ ok: boolean; detail?: string }>((resolve) => {
        const req = http.get(
          {
            hostname: "127.0.0.1",
            port,
            path: "/health",
            timeout: timeoutMs,
          },
          (res) => {
            let body = ""
            res.on("data", (chunk: Buffer) => {
              body += chunk.toString()
            })
            res.on("end", () => {
              if (res.statusCode !== 200) {
                resolve({ ok: false, detail: `HTTP ${res.statusCode}` })
                return
              }
              try {
                const parsed = JSON.parse(body) as { status?: string }
                if (parsed.status === "ok") {
                  resolve({ ok: true })
                } else {
                  resolve({ ok: false, detail: `unexpected status: ${String(parsed.status)}` })
                }
              } catch {
                resolve({ ok: false, detail: "invalid JSON response" })
              }
            })
          },
        )
        req.on("timeout", () => {
          req.destroy()
          resolve({ ok: false, detail: "timeout" })
        })
        req.on("error", (err) => {
          resolve({ ok: false, detail: err.message })
        })
      }),
  }
}
