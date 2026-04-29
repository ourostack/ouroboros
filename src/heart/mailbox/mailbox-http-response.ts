import * as http from "http"

export function writeJson(response: http.ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" })
  response.end(`${JSON.stringify(payload, null, 2)}\n`)
}
