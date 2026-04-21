import * as http from "node:http"
import { SMTPServer, type SMTPServerDataStream, type SMTPServerSession } from "smtp-server"
import { emitNervesEvent } from "../nerves/runtime"
import { normalizeMailAddress, resolveMailAddress, type MailroomRegistry } from "./core"
import { ingestRawMailToStore, type MailroomStore } from "./file-store"

export interface MailroomSmtpIngressOptions {
  registry: MailroomRegistry
  store: MailroomStore
  maxMessageBytes?: number
}

export interface MailroomIngressServers {
  smtp: SMTPServer
  health: http.Server
}

function collectStream(stream: SMTPServerDataStream, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    stream.on("data", (chunk: Buffer) => {
      total += chunk.byteLength
      if (total > maxBytes) {
        reject(new Error(`message exceeds max size ${maxBytes}`))
        stream.destroy()
        return
      }
      chunks.push(chunk)
    })
    stream.on("error", reject)
    stream.on("end", () => resolve(Buffer.concat(chunks)))
  })
}

function sessionRecipients(session: SMTPServerSession): string[] {
  /* v8 ignore next -- smtp-server supplies rcptTo during DATA; fallback is a defensive harness edge. @preserve */
  return (session.envelope.rcptTo ?? []).map((address) => normalizeMailAddress(address.address))
}

export function createMailroomSmtpServer(options: MailroomSmtpIngressOptions): SMTPServer {
  const maxMessageBytes = options.maxMessageBytes ?? 25 * 1024 * 1024
  const server = new SMTPServer({
    disabledCommands: ["AUTH"],
    logger: false,
    onRcptTo(address, _session, callback) {
      const normalized = normalizeMailAddress(address.address)
      const resolved = resolveMailAddress(options.registry, normalized)
      if (!resolved) {
        emitNervesEvent({
          component: "senses",
          event: "senses.mail_smtp_recipient_rejected",
          message: "smtp recipient rejected",
          meta: { address: normalized },
        })
        const error = new Error(`unknown recipient ${normalized}`) as Error & { responseCode?: number }
        error.responseCode = 550
        callback(error)
        return
      }
      emitNervesEvent({
        component: "senses",
        event: "senses.mail_smtp_recipient_accepted",
        message: "smtp recipient accepted",
        meta: { address: normalized, agentId: resolved.agentId },
      })
      callback()
    },
    async onData(stream, session, callback) {
      try {
        const raw = await collectStream(stream, maxMessageBytes)
        const mailFrom = session.envelope.mailFrom
        /* v8 ignore next -- smtp-server exposes normal and null senders as address objects; false/undefined are defensive direct-call states. @preserve */
        const rawMailFrom = mailFrom === false ? "" : mailFrom?.address ?? ""
        const envelope = {
          mailFrom: rawMailFrom ? normalizeMailAddress(rawMailFrom) : "",
          rcptTo: sessionRecipients(session),
          /* v8 ignore next -- smtp-server network sessions carry remoteAddress; fallback is a defensive direct-call edge. @preserve */
          ...(session.remoteAddress ? { remoteAddress: session.remoteAddress } : {}),
        }
        const result = await ingestRawMailToStore({
          registry: options.registry,
          store: options.store,
          envelope,
          rawMime: raw,
        })
        emitNervesEvent({
          component: "senses",
          event: "senses.mail_smtp_data_stored",
          message: "smtp data stored",
          meta: { accepted: result.accepted.length, rejected: result.rejectedRecipients.length },
        })
        callback()
      } catch (error) {
        emitNervesEvent({
          level: "error",
          component: "senses",
          event: "senses.mail_smtp_data_error",
          message: "smtp data handling failed",
          meta: { error: error instanceof Error ? error.message : String(error) },
        })
        callback(error instanceof Error ? error : new Error(String(error)))
      }
    },
  })
  emitNervesEvent({
    component: "senses",
    event: "senses.mail_smtp_server_created",
    message: "mailroom smtp server created",
    meta: { maxMessageBytes },
  })
  return server
}

export function createMailroomHealthServer(registry: MailroomRegistry): http.Server {
  const server = http.createServer((_request, response) => {
    const body = JSON.stringify({
      ok: true,
      service: "ouro-mailroom",
      domain: registry.domain,
      mailboxes: registry.mailboxes.length,
      sourceGrants: registry.sourceGrants.length,
    })
    response.writeHead(200, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    })
    response.end(body)
  })
  emitNervesEvent({
    component: "senses",
    event: "senses.mail_health_server_created",
    message: "mailroom health server created",
    meta: { domain: registry.domain },
  })
  return server
}

export function startMailroomIngress(options: MailroomSmtpIngressOptions & {
  smtpPort: number
  httpPort: number
  host?: string
}): MailroomIngressServers {
  const smtp = createMailroomSmtpServer(options)
  const health = createMailroomHealthServer(options.registry)
  /* v8 ignore next -- production/container entrypoints may omit host; unit tests bind loopback explicitly. @preserve */
  const host = options.host ?? "0.0.0.0"
  smtp.listen(options.smtpPort, host)
  health.listen(options.httpPort, host)
  emitNervesEvent({
    component: "senses",
    event: "senses.mail_ingress_started",
    message: "mailroom ingress started",
    meta: { smtpPort: options.smtpPort, httpPort: options.httpPort, host },
  })
  return { smtp, health }
}
