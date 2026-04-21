import * as fs from "node:fs"
import * as net from "node:net"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { provisionMailboxRegistry } from "../../mailroom/core"
import { FileMailroomStore, type MailroomStore } from "../../mailroom/file-store"
import { createMailroomHealthServer, createMailroomSmtpServer, startMailroomIngress } from "../../mailroom/smtp-ingress"

const tempRoots: string[] = []

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-mail-smtp-"))
  tempRoots.push(dir)
  return dir
}

function getFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as net.AddressInfo
      const port = address.port
      server.close(() => resolve(port))
    })
  })
}

async function listen(server: { listen(port: number, host: string, callback: () => void): unknown }): Promise<number> {
  const port = await getFreePort()
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      resolve(port)
    })
  })
}

function close(server: { close(callback: () => void): unknown }): Promise<void> {
  return new Promise((resolve) => server.close(resolve))
}

async function smtpSession(port: number, commands: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port })
    let transcript = ""
    let index = 0
    socket.setEncoding("utf-8")
    socket.on("data", (chunk) => {
      transcript += chunk
      if (index < commands.length && /\r?\n$/.test(transcript)) {
        socket.write(commands[index])
        index += 1
      } else if (index >= commands.length && transcript.includes("221")) {
        socket.end()
      }
    })
    socket.on("error", reject)
    socket.on("end", () => resolve(transcript))
  })
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe("mailroom smtp ingress", () => {
  it("answers health checks and can be started as a paired ingress", async () => {
    const { registry } = provisionMailboxRegistry({ agentId: "slugger" })
    const health = createMailroomHealthServer(registry)
    const healthPort = await listen(health)
    const body = await new Promise<string>((resolve) => {
      net.createConnection({ host: "127.0.0.1", port: healthPort }, function connected() {
        this.write("GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
        let response = ""
        this.setEncoding("utf-8")
        this.on("data", (chunk) => { response += chunk })
        this.on("end", () => resolve(response))
      })
    })
    expect(body).toContain('"service":"ouro-mailroom"')
    await close(health)

    const smtpPort = await getFreePort()
    const httpPort = await getFreePort()
    const servers = startMailroomIngress({
      registry,
      store: new FileMailroomStore({ rootDir: tempDir() }),
      smtpPort,
      httpPort,
      host: "127.0.0.1",
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    await close(servers.smtp)
    await close(servers.health)
  })

  it("rejects unknown recipients during RCPT TO and stores accepted messages", async () => {
    const rootDir = tempDir()
    const { registry } = provisionMailboxRegistry({
      agentId: "slugger",
      ownerEmail: "ari@mendelow.me",
      source: "hey",
    })
    const store = new FileMailroomStore({ rootDir })
    const server = createMailroomSmtpServer({ registry, store })
    const port = await listen(server)

    const rejected = await smtpSession(port, [
      "HELO localhost\r\n",
      "MAIL FROM:<ari@mendelow.me>\r\n",
      "RCPT TO:<unknown@ouro.bot>\r\n",
      "QUIT\r\n",
    ])
    expect(rejected).toContain("550")

    const accepted = await smtpSession(port, [
      "HELO localhost\r\n",
      "MAIL FROM:<ari@mendelow.me>\r\n",
      "RCPT TO:<me.mendelow.ari.slugger@ouro.bot>\r\n",
      "DATA\r\n",
      "From: Ari <ari@mendelow.me>\r\nTo: me.mendelow.ari.slugger@ouro.bot\r\nSubject: SMTP proof\r\n\r\nHello Slugger.\r\n.\r\n",
      "QUIT\r\n",
    ])
    expect(accepted).toContain("250")
    expect(await store.listMessages({ agentId: "slugger" })).toHaveLength(1)

    const nullSender = await smtpSession(port, [
      "HELO localhost\r\n",
      "MAIL FROM:<>\r\n",
      "RCPT TO:<me.mendelow.ari.slugger@ouro.bot>\r\n",
      "DATA\r\n",
      "From: Mailer Daemon <postmaster@example.com>\r\nTo: me.mendelow.ari.slugger@ouro.bot\r\nSubject: Null sender\r\n\r\nDelivery status.\r\n.\r\n",
      "QUIT\r\n",
    ])
    expect(nullSender).toContain("250")
    const stored = await store.listMessages({ agentId: "slugger" })
    expect(stored).toHaveLength(2)
    expect(stored.find((message) => message.privateEnvelope && message.envelope.mailFrom === "")).toBeTruthy()
    await close(server)
  })

  it("does not advertise STARTTLS until a real certificate path exists", async () => {
    const { registry } = provisionMailboxRegistry({ agentId: "slugger" })
    const server = createMailroomSmtpServer({
      registry,
      store: new FileMailroomStore({ rootDir: tempDir() }),
    })
    const port = await listen(server)
    const transcript = await smtpSession(port, [
      "EHLO localhost\r\n",
      "QUIT\r\n",
    ])
    expect(transcript).toContain("250")
    expect(transcript).not.toContain("STARTTLS")
    await close(server)
  })

  it("surfaces data handling failures", async () => {
    const { registry } = provisionMailboxRegistry({
      agentId: "slugger",
      ownerEmail: "ari@mendelow.me",
      source: "hey",
    })
    const server = createMailroomSmtpServer({
      registry,
      store: new FileMailroomStore({ rootDir: tempDir() }),
      maxMessageBytes: 1,
    })
    const port = await listen(server)
    const transcript = await smtpSession(port, [
      "HELO localhost\r\n",
      "MAIL FROM:<ari@mendelow.me>\r\n",
      "RCPT TO:<me.mendelow.ari.slugger@ouro.bot>\r\n",
      "DATA\r\n",
      "From: Ari <ari@mendelow.me>\r\n\r\nToo large.\r\n.\r\n",
      "QUIT\r\n",
    ])
    expect(transcript).toMatch(/4\d\d|5\d\d/)
    await close(server)
  })

  it("wraps non-Error store failures from SMTP DATA handling", async () => {
    const { registry } = provisionMailboxRegistry({
      agentId: "slugger",
      ownerEmail: "ari@mendelow.me",
      source: "hey",
    })
    const throwingStore = {
      async putRawMessage() {
        throw "string failure"
      },
      async getMessage() {
        return null
      },
      async listMessages() {
        return []
      },
      async readRawPayload() {
        return null
      },
      async recordAccess(entry) {
        return { ...entry, id: "access", accessedAt: new Date(0).toISOString() }
      },
      async listAccessLog() {
        return []
      },
    } satisfies MailroomStore
    const server = createMailroomSmtpServer({ registry, store: throwingStore })
    const port = await listen(server)
    const transcript = await smtpSession(port, [
      "HELO localhost\r\n",
      "MAIL FROM:<ari@mendelow.me>\r\n",
      "RCPT TO:<me.mendelow.ari.slugger@ouro.bot>\r\n",
      "DATA\r\n",
      "From: Ari <ari@mendelow.me>\r\n\r\nStore fails.\r\n.\r\n",
      "QUIT\r\n",
    ])
    expect(transcript).toMatch(/4\d\d|5\d\d/)
    await close(server)
  })
})
