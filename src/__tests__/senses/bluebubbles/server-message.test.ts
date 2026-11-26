import { describe, expect, it } from "vitest"
import { serverMessageFromPayload } from "../../../senses/bluebubbles/server-message"
import { blueBubblesUrlTrust } from "../../../senses/bluebubbles/url-trust"

describe("serverMessageFromPayload", () => {
  it("reads every field the answer reader checks from the server's reply", () => {
    expect(serverMessageFromPayload({ status: 200, data: {
      guid: "m-1", text: "L7 2", isFromMe: false, handle: { address: "+15551234567", service: "iMessage" },
      chats: [{ guid: "iMessage;-;+15551234567" }, { nope: 1 }, "x"], dateCreated: 1000, dateEdited: 2000, dateRetracted: 3000, threadOriginatorGuid: "t-1",
    } })).toEqual({
      guid: "m-1", text: "L7 2", isFromMe: false, sender: "+15551234567", service: "iMessage", chatGuids: ["iMessage;-;+15551234567"],
      dateCreated: 1000, dateEdited: 2000, dateRetracted: 3000, threadOriginatorGuid: "t-1",
    })
  })

  it("leaves out what is missing or of the wrong type, and returns null with no message", () => {
    expect(serverMessageFromPayload({ guid: "m-2", text: 5, isFromMe: "yes", handle: [], chats: "c", dateCreated: 0, dateEdited: null, threadOriginatorGuid: " " }))
      .toEqual({ guid: "m-2", text: "", isFromMe: false, chatGuids: [] })
    expect(serverMessageFromPayload({ data: { text: "L7 2" } })).toBeNull()
    expect(serverMessageFromPayload(null)).toBeNull()
    expect(serverMessageFromPayload([])).toBeNull()
  })
})

describe("blueBubblesUrlTrust", () => {
  it("trusts the same Mac, authenticated TLS and the tailnet, and nothing else", () => {
    for (const url of ["http://127.0.0.1:1234", "http://localhost:1234", "http://[::1]:1234", "http://127.8.9.1"]) expect(blueBubblesUrlTrust(url)).toBe("loopback")
    expect(blueBubblesUrlTrust("https://bb.example.com")).toBe("tls")
    for (const url of ["http://100.64.0.1:1234", "http://100.127.255.255", "http://mac-mini.tail1234.ts.net:1234"]) expect(blueBubblesUrlTrust(url)).toBe("tailnet")
    for (const url of ["http://192.168.1.5:1234", "http://100.128.0.1", "http://100.63.0.1", "http://8.8.8.8", "http://bb.example.com", "not a url"]) expect(blueBubblesUrlTrust(url)).toBe("untrusted")
  })
})
