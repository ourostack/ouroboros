import { describe, expect, it, vi } from "vitest"

const dmOgPayload = {
  type: "new-message",
  data: {
    guid: "CCDE56E5-8D22-4DF9-B1A8-98E868A1B234",
    text: "https://ouroboros.bot",
    handle: {
      address: "ari@mendelow.me",
      service: "iMessage",
      country: "US",
    },
    attachments: [
      {
        guid: "BD74C362-B41E-43D2-BD13-E3F984F5E6E5",
        transferName: "0701F4A6-4C84-4265-9666-8B97FD19CE0B.pluginPayloadAttachment",
        totalBytes: 1239,
      },
      {
        guid: "D79C1BC9-A31F-4FA8-B6C0-A3AB4062E082",
        transferName: "FEA3D9B6-605B-4F1A-9AA1-98F05A8CAB58.pluginPayloadAttachment",
        totalBytes: 65917,
      },
    ],
    dateCreated: 1772944130631,
    isDelivered: true,
    isFromMe: false,
    balloonBundleId: "com.apple.messages.URLBalloonProvider",
    associatedMessageGuid: null,
    associatedMessageType: null,
    threadOriginatorGuid: null,
    hasPayloadData: true,
    chats: [
      {
        guid: "any;-;ari@mendelow.me",
        style: 45,
        chatIdentifier: "ari@mendelow.me",
        displayName: "",
      },
    ],
    dateEdited: null,
    dateRetracted: null,
    partCount: 1,
  },
}

const dmImagePayload = {
  type: "new-message",
  data: {
    guid: "E6451C2E-CDFA-4C12-9C1B-ADD8D2F2DEB4",
    text: "",
    handle: {
      address: "ari@mendelow.me",
      service: "iMessage",
      country: "US",
    },
    attachments: [
      {
        guid: "5FBD7BDD-EE5C-46BC-8C02-9E277E8A3EF3",
        uti: "public.heic",
        mimeType: "image/jpeg",
        transferName: "IMG_5045.heic.jpeg",
        totalBytes: 3789572,
        height: 800,
        width: 600,
      },
    ],
    dateCreated: 1772946699113,
    isFromMe: false,
    chats: [
      {
        guid: "any;-;ari@mendelow.me",
        style: 45,
        chatIdentifier: "ari@mendelow.me",
        displayName: "",
      },
    ],
  },
}

const dmAudioPayload = {
  type: "new-message",
  data: {
    guid: "5D50082A-49A1-46C5-BB71-58C60A0EB3A8",
    text: "",
    handle: {
      address: "ari@mendelow.me",
      service: "iMessage",
      country: "US",
    },
    attachments: [
      {
        guid: "5E5B5B46-382E-46EF-97F8-F582D8209B79",
        uti: "com.apple.coreaudio-format",
        mimeType: "audio/mp3",
        transferName: "Audio Message.mp3.mp3",
        totalBytes: 11495,
      },
    ],
    dateCreated: 1772946845074,
    isFromMe: false,
    chats: [
      {
        guid: "any;-;ari@mendelow.me",
        style: 45,
        chatIdentifier: "ari@mendelow.me",
        displayName: "",
      },
    ],
  },
}

const dmThreadPayload = {
  type: "new-message",
  data: {
    guid: "C4B2E437-A373-43F6-9740-9CD84E5893A0",
    text: "threaded reply",
    handle: {
      address: "ari@mendelow.me",
      service: "iMessage",
      country: "US",
    },
    attachments: [],
    dateCreated: 1772946888623,
    isFromMe: false,
    threadOriginatorGuid: "54D4109C-7170-41A1-8161-F6F8C863CC0D",
    chats: [
      {
        guid: "any;-;ari@mendelow.me",
        style: 45,
        chatIdentifier: "ari@mendelow.me",
        displayName: "",
      },
    ],
  },
}

const dmTopLevelPayload = {
  type: "new-message",
  data: {
    guid: "B20D4E2B-2E6E-48B5-95CD-6E24A368E4A7",
    text: "top-level follow-up",
    handle: {
      address: "ari@mendelow.me",
      service: "iMessage",
      country: "US",
    },
    attachments: [],
    dateCreated: 1772946889999,
    isFromMe: false,
    threadOriginatorGuid: null,
    chats: [
      {
        guid: "any;-;ari@mendelow.me",
        style: 45,
        chatIdentifier: "ari@mendelow.me",
        displayName: "",
      },
    ],
  },
}

const groupThreadPayload = {
  type: "new-message",
  data: {
    guid: "E29915DA-FC59-412A-BACC-B5EEDBA414EB",
    text: "yay!",
    handle: {
      address: "ari@mendelow.me",
      service: "iMessage",
      country: "US",
    },
    attachments: [],
    dateCreated: 1772947679927,
    isFromMe: false,
    threadOriginatorGuid: "3E02B90F-D374-4381-BDD2-3572D3EB1195",
    chats: [
      {
        guid: "any;+;35820e69c97c459992d29a334f412979",
        style: 43,
        chatIdentifier: "35820e69c97c459992d29a334f412979",
        displayName: "Consciousness TBD",
      },
    ],
  },
}

const reactionPayload = {
  type: "new-message",
  data: {
    guid: "BA2CFB68-52D2-4D8F-8A33-394C37035347",
    text: "Loved “yep, threaded replies solid. both came through with the correct quoted message”",
    handle: {
      address: "ari@mendelow.me",
      service: "iMessage",
      country: "US",
    },
    attachments: [],
    dateCreated: 1772948058386,
    isFromMe: false,
    associatedMessageGuid: "p:0/CB4EB152-A678-4F0E-8075-1AB09B5496F8",
    associatedMessageType: "love",
    chats: [
      {
        guid: "any;-;ari@mendelow.me",
        style: 45,
        chatIdentifier: "ari@mendelow.me",
        displayName: "",
      },
    ],
  },
}

const editedPayload = {
  type: "updated-message",
  data: {
    guid: "4A4F2A85-21AD-4AC6-98A8-34B8F4D07AA9",
    text: "edited version",
    handle: {
      address: "ari@mendelow.me",
      service: "iMessage",
      country: "US",
    },
    attachments: [],
    dateCreated: 1772949000000,
    dateEdited: 1772949005000,
    dateRetracted: null,
    isDelivered: true,
    dateRead: null,
    associatedMessageGuid: null,
    associatedMessageType: null,
    chats: [
      {
        guid: "any;-;ari@mendelow.me",
        style: 45,
        chatIdentifier: "ari@mendelow.me",
        displayName: "",
      },
    ],
  },
}

const unsentPayload = {
  type: "updated-message",
  data: {
    guid: "A9C0AB3C-858A-42BC-9951-66A5C9B1B2B8",
    text: "",
    handle: {
      address: "ari@mendelow.me",
      service: "iMessage",
      country: "US",
    },
    attachments: [],
    dateCreated: 1772949100000,
    dateEdited: null,
    dateRetracted: 1772949105000,
    isDelivered: true,
    dateRead: null,
    associatedMessageGuid: null,
    associatedMessageType: null,
    chats: [
      {
        guid: "any;-;ari@mendelow.me",
        style: 45,
        chatIdentifier: "ari@mendelow.me",
        displayName: "",
      },
    ],
  },
}

const readPayload = {
  type: "updated-message",
  data: {
    guid: "174D57C8-5985-4528-8539-E4DBD777FE59",
    text: "still here — are you testing message delivery or do you need something?",
    handle: {
      address: "ari@mendelow.me",
      service: "iMessage",
      country: "US",
    },
    attachments: [],
    dateCreated: 1772948413321,
    dateEdited: null,
    dateRetracted: null,
    isDelivered: true,
    dateRead: 1772948415000,
    associatedMessageGuid: null,
    associatedMessageType: null,
    chats: [
      {
        guid: "any;-;ari@mendelow.me",
        style: 45,
        chatIdentifier: "ari@mendelow.me",
        displayName: "",
      },
    ],
  },
}

const phoneIdentifierPayload = {
  type: "new-message",
  data: {
    guid: "D18CF8C5-846D-4178-B5DE-0D54B4EE04A8",
    text: "hello there",
    handle: {
      id: "+1 (973) 508-0289",
    },
    attachments: [],
    dateCreated: 1772949300000,
    chats: [
      {
        identifier: "+1 (973) 508-0289",
      },
    ],
  },
}

const genericAttachmentPayload = {
  type: "new-message",
  data: {
    guid: "F17A8D58-D59E-478D-919D-E17B6F202EFA",
    text: "",
    senderId: "Slugger Device",
    attachments: [
      {
        guid: "file-1",
      },
    ],
    chats: [],
  },
}

const deliveryPayload = {
  type: "updated-message",
  data: {
    guid: "4CA13C89-6E12-4979-9D6D-42C4C2E74403",
    text: "",
    chats: [
      {
        guid: "any;-;ari@mendelow.me",
      },
    ],
    dateDelivered: 1772949405000,
  },
}

const updatedMessageWithoutMutationPayload = {
  type: "updated-message",
  data: {
    guid: "6E3AEF9D-A3B1-4CF4-9547-E7C319CF4170",
    text: "",
    associatedMessageType: "   ",
    attachments: [],
    chats: [
      {
        guid: "any;-;ari@mendelow.me",
      },
    ],
  },
}

const blankEditPayload = {
  type: "updated-message",
  data: {
    guid: "55F491B5-A8FD-48B5-98B1-319AA2B6AA42",
    text: "   ",
    chats: [
      {
        guid: "any;-;ari@mendelow.me",
      },
    ],
    dateEdited: 1772949605000,
  },
}

const editWithoutTextFieldPayload = {
  type: "updated-message",
  data: {
    guid: "01F7B8E0-C038-449E-B91A-B5AC3196C113",
    chats: [
      {
        guid: "any;-;ari@mendelow.me",
      },
    ],
    dateEdited: 1772949705000,
  },
}

const missingTextPayload = {
  type: "new-message",
  data: {
    guid: "2E4F2F28-A84C-4B58-B15A-E82E15F37090",
    handle: {
      address: "ari@mendelow.me",
    },
    attachments: [],
    chats: [
      {
        guid: "any;-;ari@mendelow.me",
      },
    ],
  },
}

const bareReactionGuidPayload = {
  type: "new-message",
  data: {
    guid: "C07843EE-EC0C-4A56-876B-B508D67DBD1A",
    associatedMessageGuid: "4AA4D1BC-6A73-4FF0-AF15-8C0A341A388B",
    associatedMessageType: "like",
    chats: [
      {
        guid: "any;-;ari@mendelow.me",
      },
    ],
  },
}

const reactionWithoutTargetGuidPayload = {
  type: "new-message",
  data: {
    guid: "EBD812E0-3F0E-41E0-B854-AF4145F4A919",
    associatedMessageType: "laugh",
    chats: [
      {
        guid: "any;-;ari@mendelow.me",
      },
    ],
  },
}

const chatGuidOnlyPayload = {
  type: "new-message",
  data: {
    guid: "67320EA8-8244-458D-B1F8-EA2A106F8C29",
    text: "route by guid",
    attachments: [],
    chats: [
      {
        guid: "chat-guid-only",
      },
    ],
  },
}

const unknownRoutingPayload = {
  type: "new-message",
  data: {
    guid: "6F9A8D0F-E89A-4F93-83B6-32D1C6D0B95B",
    attachments: [],
    chats: null,
  },
}

const blankHandlePayload = {
  type: "new-message",
  data: {
    guid: "C8B32623-0717-4F82-9242-32D30B81D48E",
    text: "blank handle",
    handle: {
      address: "",
    },
    attachments: [],
    chats: [
      {
        guid: "any;-;   ",
      },
    ],
  },
}

describe("normalizeBlueBubblesEvent", () => {
  it("normalizes a DM OG-card message with explicit fallback context", async () => {
    const { normalizeBlueBubblesEvent } = await import("../../senses/bluebubbles-model")
    const result = normalizeBlueBubblesEvent(dmOgPayload)

    expect(result.kind).toBe("message")
    expect(result.chat.isGroup).toBe(false)
    expect(result.chat.sessionKey).toBe("chat:any;-;ari@mendelow.me")
    expect(result.sender.externalId).toBe("ari@mendelow.me")
    expect(result.messageGuid).toBe("CCDE56E5-8D22-4DF9-B1A8-98E868A1B234")
    expect(result.textForAgent).toContain("https://ouroboros.bot")
    expect(result.textForAgent).toContain("link preview")
    expect(result.attachments).toHaveLength(2)
  })

  it("normalizes image attachments into explicit fallback text", async () => {
    const { normalizeBlueBubblesEvent } = await import("../../senses/bluebubbles-model")
    const result = normalizeBlueBubblesEvent(dmImagePayload)

    expect(result.kind).toBe("message")
    expect(result.textForAgent).toContain("image attachment")
    expect(result.textForAgent).toContain("IMG_5045.heic.jpeg")
  })

  it("normalizes audio attachments into explicit fallback text", async () => {
    const { normalizeBlueBubblesEvent } = await import("../../senses/bluebubbles-model")
    const result = normalizeBlueBubblesEvent(dmAudioPayload)

    expect(result.kind).toBe("message")
    expect(result.textForAgent).toContain("audio attachment")
    expect(result.textForAgent).toContain("Audio Message.mp3.mp3")
  })

  it("keeps DM threaded replies on the chat trunk session", async () => {
    const { normalizeBlueBubblesEvent } = await import("../../senses/bluebubbles-model")
    const result = normalizeBlueBubblesEvent(dmThreadPayload)

    expect(result.kind).toBe("message")
    expect(result.chat.sessionKey).toBe("chat:any;-;ari@mendelow.me")
    expect(result.replyToGuid).toBe("54D4109C-7170-41A1-8161-F6F8C863CC0D")
  })

  it("keeps group threaded replies on the group chat trunk session", async () => {
    const { normalizeBlueBubblesEvent } = await import("../../senses/bluebubbles-model")
    const result = normalizeBlueBubblesEvent(groupThreadPayload)

    expect(result.kind).toBe("message")
    expect(result.chat.isGroup).toBe(true)
    expect(result.chat.displayName).toBe("Consciousness TBD")
    expect(result.chat.sessionKey).toBe("chat:any;+;35820e69c97c459992d29a334f412979")
  })

  it("extracts participantHandles from group chat participants", async () => {
    const { normalizeBlueBubblesEvent } = await import("../../senses/bluebubbles-model")
    const payload = {
      type: "new-message",
      data: {
        guid: "PART-TEST-001",
        text: "group with participants",
        handle: { address: "sender@example.com" },
        attachments: [],
        dateCreated: 1772947700000,
        isFromMe: false,
        chats: [
          {
            guid: "any;+;groupchat123",
            style: 43,
            chatIdentifier: "groupchat123",
            displayName: "Test Group",
            participants: [
              { address: "alice@example.com" },
              { address: "+1 (555) 123-4567" },
              { address: "bob@example.com" },
            ],
          },
        ],
      },
    }
    const result = normalizeBlueBubblesEvent(payload)
    expect(result.chat.isGroup).toBe(true)
    expect(result.chat.participantHandles).toEqual([
      "alice@example.com",
      "+15551234567",
      "bob@example.com",
    ])
  })

  it("falls back to id field when participant has no address and skips empty entries", async () => {
    const { normalizeBlueBubblesEvent } = await import("../../senses/bluebubbles-model")
    const payload = {
      type: "new-message",
      data: {
        guid: "PART-ID-FALLBACK-001",
        isFromMe: false,
        dateCreated: 1710000000000,
        text: "hi",
        chats: [{
          guid: "iMessage;+;chat001",
          style: 43,
          participants: [
            { id: "alice@example.com" },
            { id: "+1 555 999 8888" },
            { other: "no-address-or-id" },
          ],
        }],
      },
    }
    const result = normalizeBlueBubblesEvent(payload)
    expect(result.chat.participantHandles).toEqual(["alice@example.com", "+15559998888"])
  })

  it("returns empty participantHandles when chat has no participants", async () => {
    const { normalizeBlueBubblesEvent } = await import("../../senses/bluebubbles-model")
    const result = normalizeBlueBubblesEvent(dmOgPayload)
    expect(result.chat.participantHandles).toEqual([])
  })

  it("uses the same DM chat trunk for top-level and threaded replies", async () => {
    const { normalizeBlueBubblesEvent } = await import("../../senses/bluebubbles-model")
    const topLevel = normalizeBlueBubblesEvent(dmTopLevelPayload)
    const threaded = normalizeBlueBubblesEvent(dmThreadPayload)

    expect(topLevel.kind).toBe("message")
    expect(threaded.kind).toBe("message")
    expect(topLevel.chat.sessionKey).toBe("chat:any;-;ari@mendelow.me")
    expect(threaded.chat.sessionKey).toBe(topLevel.chat.sessionKey)
  })

  it("normalizes associated-message reactions as first-class mutations", async () => {
    const { normalizeBlueBubblesEvent } = await import("../../senses/bluebubbles-model")
    const result = normalizeBlueBubblesEvent(reactionPayload)

    expect(result.kind).toBe("mutation")
    expect(result.mutationType).toBe("reaction")
    expect(result.shouldNotifyAgent).toBe(true)
    expect(result.targetMessageGuid).toBe("CB4EB152-A678-4F0E-8075-1AB09B5496F8")
    expect(result.textForAgent).toContain("reacted with")
  })

  it("normalizes edited-message updates as notifyable mutations", async () => {
    const { normalizeBlueBubblesEvent } = await import("../../senses/bluebubbles-model")
    const result = normalizeBlueBubblesEvent(editedPayload)

    expect(result.kind).toBe("mutation")
    expect(result.mutationType).toBe("edit")
    expect(result.shouldNotifyAgent).toBe(true)
    expect(result.textForAgent).toContain("edited")
    expect(result.textForAgent).toContain("edited version")
  })

  it("normalizes unsent-message updates as notifyable mutations", async () => {
    const { normalizeBlueBubblesEvent } = await import("../../senses/bluebubbles-model")
    const result = normalizeBlueBubblesEvent(unsentPayload)

    expect(result.kind).toBe("mutation")
    expect(result.mutationType).toBe("unsend")
    expect(result.shouldNotifyAgent).toBe(true)
    expect(result.textForAgent).toContain("unsent")
  })

  it("normalizes read/delivery state changes without dropping them silently", async () => {
    const { normalizeBlueBubblesEvent } = await import("../../senses/bluebubbles-model")
    const result = normalizeBlueBubblesEvent(readPayload)

    expect(result.kind).toBe("mutation")
    expect(result.mutationType).toBe("read")
    expect(result.shouldNotifyAgent).toBe(false)
    expect(result.chat.sessionKey).toBe("chat:any;-;ari@mendelow.me")
  })

  it("falls back to chat identifier routing and normalizes phone handles", async () => {
    const { normalizeBlueBubblesEvent } = await import("../../senses/bluebubbles-model")
    const result = normalizeBlueBubblesEvent(phoneIdentifierPayload)

    expect(result.kind).toBe("message")
    expect(result.chat.chatGuid).toBeUndefined()
    expect(result.chat.chatIdentifier).toBe("+1 (973) 508-0289")
    expect(result.chat.sessionKey).toBe("chat_identifier:+1 (973) 508-0289")
    expect(result.chat.sendTarget).toEqual({ kind: "chat_identifier", value: "+1 (973) 508-0289" })
    expect(result.sender.rawId).toBe("+1 (973) 508-0289")
    expect(result.sender.externalId).toBe("+19735080289")
  })

  it("emits explicit generic attachment fallback text and unknown sender identity", async () => {
    const { normalizeBlueBubblesEvent } = await import("../../senses/bluebubbles-model")
    const now = vi.spyOn(Date, "now").mockReturnValue(1772949500000)

    try {
      const result = normalizeBlueBubblesEvent(genericAttachmentPayload)

      expect(result.kind).toBe("message")
      expect(result.text).toBe("")
      expect(result.textForAgent).toBe("[attachment]")
      expect(result.chat.sessionKey).toBe("chat_identifier:unknown")
      expect(result.chat.sendTarget).toEqual({ kind: "chat_identifier", value: "unknown" })
      expect(result.sender.externalId).toBe("Slugger Device")
      expect(result.timestamp).toBe(1772949500000)
      expect(result.fromMe).toBe(false)
      expect(result.requiresRepair).toBe(true)
    } finally {
      now.mockRestore()
    }
  })

  it("normalizes delivery updates as silent mutations with repair required", async () => {
    const { normalizeBlueBubblesEvent } = await import("../../senses/bluebubbles-model")
    const result = normalizeBlueBubblesEvent(deliveryPayload)

    expect(result.kind).toBe("mutation")
    expect(result.mutationType).toBe("delivery")
    expect(result.textForAgent).toContain("delivered")
    expect(result.shouldNotifyAgent).toBe(false)
    expect(result.requiresRepair).toBe(true)
  })

  it("falls back to a generic edit mutation when edited text is blank", async () => {
    const { normalizeBlueBubblesEvent } = await import("../../senses/bluebubbles-model")
    const result = normalizeBlueBubblesEvent(blankEditPayload)

    expect(result.kind).toBe("mutation")
    expect(result.mutationType).toBe("edit")
    expect(result.textForAgent).toBe("edited a message")
  })

  it("falls back to a generic edit mutation when edited text is absent", async () => {
    const { normalizeBlueBubblesEvent } = await import("../../senses/bluebubbles-model")
    const result = normalizeBlueBubblesEvent(editWithoutTextFieldPayload)

    expect(result.kind).toBe("mutation")
    expect(result.mutationType).toBe("edit")
    expect(result.textForAgent).toBe("edited a message")
  })

  it("preserves non-mutation updated-message payloads as explicit message events", async () => {
    const { normalizeBlueBubblesEvent } = await import("../../senses/bluebubbles-model")
    const result = normalizeBlueBubblesEvent(updatedMessageWithoutMutationPayload)

    expect(result.kind).toBe("message")
    expect(result.eventType).toBe("updated-message")
    expect(result.chat.chatIdentifier).toBe("ari@mendelow.me")
    expect(result.textForAgent).toBe("")
    expect(result.requiresRepair).toBe(true)
  })

  it("normalizes missing message text to an empty string", async () => {
    const { normalizeBlueBubblesEvent } = await import("../../senses/bluebubbles-model")
    const result = normalizeBlueBubblesEvent(missingTextPayload)

    expect(result.kind).toBe("message")
    expect(result.text).toBe("")
    expect(result.textForAgent).toBe("")
    expect(result.chat.chatIdentifier).toBe("ari@mendelow.me")
  })

  it("normalizes reactions whether the target guid is bare or absent", async () => {
    const { normalizeBlueBubblesEvent } = await import("../../senses/bluebubbles-model")
    const bareResult = normalizeBlueBubblesEvent(bareReactionGuidPayload)
    const missingResult = normalizeBlueBubblesEvent(reactionWithoutTargetGuidPayload)

    expect(bareResult.kind).toBe("mutation")
    expect(bareResult.targetMessageGuid).toBe("4AA4D1BC-6A73-4FF0-AF15-8C0A341A388B")
    expect(missingResult.kind).toBe("mutation")
    expect(missingResult.targetMessageGuid).toBeUndefined()
  })

  it("falls back through guid-only and unknown chat identity without losing routing", async () => {
    const { normalizeBlueBubblesEvent } = await import("../../senses/bluebubbles-model")
    const guidOnlyResult = normalizeBlueBubblesEvent(chatGuidOnlyPayload)
    const unknownResult = normalizeBlueBubblesEvent(unknownRoutingPayload)

    expect(guidOnlyResult.kind).toBe("message")
    expect(guidOnlyResult.chat.chatGuid).toBe("chat-guid-only")
    expect(guidOnlyResult.chat.chatIdentifier).toBeUndefined()
    expect(guidOnlyResult.chat.sendTarget).toEqual({ kind: "chat_guid", value: "chat-guid-only" })
    expect(guidOnlyResult.sender.rawId).toBe("chat-guid-only")

    expect(unknownResult.kind).toBe("message")
    expect(unknownResult.chat.sessionKey).toBe("chat_identifier:unknown")
    expect(unknownResult.sender.rawId).toBe("unknown")
    expect(unknownResult.sender.displayName).toBe("unknown")
  })

  it("treats blank handles and blank extracted identifiers as explicit unknown sender state", async () => {
    const { normalizeBlueBubblesEvent } = await import("../../senses/bluebubbles-model")
    const result = normalizeBlueBubblesEvent(blankHandlePayload)

    expect(result.kind).toBe("message")
    expect(result.chat.chatGuid).toBe("any;-;")
    expect(result.chat.chatIdentifier).toBeUndefined()
    expect(result.sender.rawId).toBe("")
    expect(result.sender.externalId).toBe("")
    expect(result.sender.displayName).toBe("Unknown")
  })

  it("rejects invalid envelopes and payloads without a guid", async () => {
    const { normalizeBlueBubblesEvent } = await import("../../senses/bluebubbles-model")

    expect(() => normalizeBlueBubblesEvent(null)).toThrow("Invalid BlueBubbles payload")
    expect(() =>
      normalizeBlueBubblesEvent({
        type: "new-message",
        data: { text: "missing guid" },
      }),
    ).toThrow("BlueBubbles payload is missing data.guid")
  })
})
