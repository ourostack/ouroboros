import { describe, expect, it } from "vitest"
import { parseTeamsQuotedReply } from "../../senses/teams"

const quote = (mri: string | null, body: string) =>
  `<blockquote itemscope="" itemtype="http://schema.skype.com/Reply" itemid="1700000000000">` +
  (mri ? `<strong itemprop="mri" itemid="${mri}">Someone</strong>` : "") +
  `<span itemprop="time" itemid="1700000000000"></span>${body}</blockquote><p>that one</p>`

describe("a Teams quoted reply (2026-10-29)", () => {
  const ids = { botId: "28:app-id", userId: "29:user-id" }

  it.each([
    { kind: "the bot's own message", mri: "28:app-id", author: "agent" },
    { kind: "the person's own message", mri: "8:orgid:user-id", author: "other" },
    { kind: "the person's own message by channel id", mri: "29:user-id", author: "person" },
    { kind: "someone else's message", mri: "29:other-id", author: "other" },
  ])("reads the preview and author of $kind", ({ mri, author }) => {
    const content = quote(mri, `<p itemprop="preview">ship &amp; tag 0.9 &lt;now&gt;&nbsp;&quot;ok&quot; &#39;yes&#39;</p>`)
    expect(parseTeamsQuotedReply([{ contentType: "text/html", content }], ids)).toEqual({ text: `ship & tag 0.9 <now> "ok" 'yes'`, author })
  })

  it("reads the whole quote when there is no preview, and no author when none is named", () => {
    const content = quote(null, "<p>line one<br/>line two</p>")
    expect(parseTeamsQuotedReply([{ contentType: "text/html", content }], ids)).toEqual({ text: "line one line two" })
  })

  it("caps a long quote at 1200 characters", () => {
    const content = quote("28:app-id", `<p itemprop="preview">${"x".repeat(1300)}</p>`)
    expect(parseTeamsQuotedReply([{ contentType: "text/html", content }], ids)?.text).toHaveLength(1200)
  })

  it.each([
    { kind: "no attachments", attachments: undefined },
    { kind: "an image attachment", attachments: [{ contentType: "image/png", content: "<blockquote></blockquote>" }] },
    { kind: "html with no reply quote", attachments: [{ contentType: "text/html", content: "<p>just text</p>" }] },
    { kind: "html whose content is not a string", attachments: [{ contentType: "text/html", content: { html: true } }] },
    { kind: "a reply quote with no words", attachments: [{ contentType: "text/html", content: quote("28:app-id", `<p itemprop="preview">  </p>`) }] },
  ])("finds no quote in $kind", ({ attachments }) => {
    expect(parseTeamsQuotedReply(attachments, ids)).toBeUndefined()
  })

  it("compares ids without the channel prefix when the bot id has none", () => {
    const content = quote("28:app-id", `<p itemprop="preview">hi</p>`)
    expect(parseTeamsQuotedReply([{ contentType: "text/html", content }], { botId: "app-id" })).toEqual({ text: "hi", author: "agent" })
  })
})
