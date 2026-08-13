import { beforeEach, describe, expect, it, vi } from "vitest"

const { emitNervesEvent } = vi.hoisted(() => ({ emitNervesEvent: vi.fn() }))

vi.mock("../../../nerves/runtime", () => ({ emitNervesEvent }))

import {
  __resetBlueBubblesLatestTurnsForTests,
  awaitDeliveryAdmission,
  cancel,
  clearPending,
  finish,
  isCurrent,
  promote,
  reserveObservation,
} from "../../../senses/bluebubbles/latest-turn"

describe("BlueBubbles latest-turn registry", () => {
  beforeEach(() => {
    __resetBlueBubblesLatestTurnsForTests()
    emitNervesEvent.mockReset()
  })

  it("allocates synchronous monotonic observations and fences delivery behind a later matching pending hint", async () => {
    const first = reserveObservation({ chatGuid: "chat-guid", chatIdentifier: "ari@example.com" })
    const firstPromotion = promote(first, { chatGuid: "chat-guid", chatIdentifier: "ari@example.com" })
    expect(firstPromotion.status).toBe("promoted")
    if (firstPromotion.status !== "promoted") throw new Error("expected promotion")

    const later = reserveObservation({ chatIdentifier: "ari@example.com" })
    expect(later.ordinal).toBe(first.ordinal + 1)
    let settled = false
    const admission = awaitDeliveryAdmission(firstPromotion.capability).then((value) => {
      settled = true
      return value
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    clearPending(later)
    await expect(admission).resolves.toBe(true)
  })

  it("promotes identifier-only observations through a proved GUID alias and aborts the older capability", async () => {
    const first = reserveObservation({ chatGuid: "chat-guid", chatIdentifier: "ari@example.com" })
    const firstPromotion = promote(first, { chatGuid: "chat-guid", chatIdentifier: "ari@example.com" })
    if (firstPromotion.status !== "promoted") throw new Error("expected first promotion")
    const later = reserveObservation({ chatIdentifier: "ari@example.com" })

    const secondPromotion = promote(later, { chatIdentifier: "ari@example.com" })
    expect(secondPromotion.status).toBe("promoted")
    if (secondPromotion.status !== "promoted") throw new Error("expected second promotion")
    expect(secondPromotion.capability.canonicalChat).toEqual({
      chatGuid: "chat-guid",
      chatIdentifier: "ari@example.com",
      sessionKey: "chat:chat-guid",
    })
    expect(firstPromotion.capability.signal.aborted).toBe(true)
    expect(isCurrent(firstPromotion.capability)).toBe(false)
    expect(isCurrent(secondPromotion.capability)).toBe(true)
    await expect(awaitDeliveryAdmission(firstPromotion.capability)).resolves.toBe(false)

    const repeatedPair = reserveObservation({ chatGuid: "chat-guid", chatIdentifier: "ari@example.com" })
    expect(promote(repeatedPair, {
      chatGuid: "chat-guid",
      chatIdentifier: "ari@example.com",
    }).status).toBe("promoted")
  })

  it("uses one alias lane for equivalent phone and email identifier spellings", async () => {
    const phone = reserveObservation({
      chatGuid: "phone-chat-guid",
      chatIdentifier: "+1 (973) 508-0289",
    })
    const phonePromotion = promote(phone, {
      chatGuid: "phone-chat-guid",
      chatIdentifier: "+1 (973) 508-0289",
    })
    if (phonePromotion.status !== "promoted") throw new Error("expected phone promotion")

    const compactPhone = reserveObservation({ chatIdentifier: "+19735080289" })
    expect(compactPhone.hints).toEqual(["identifier:+19735080289"])
    let phoneAdmissionSettled = false
    const phoneAdmission = awaitDeliveryAdmission(phonePromotion.capability).then((value) => {
      phoneAdmissionSettled = true
      return value
    })
    await Promise.resolve()
    expect(phoneAdmissionSettled).toBe(false)

    const compactPromotion = promote(compactPhone, { chatIdentifier: "+19735080289" })
    expect(compactPromotion.status).toBe("promoted")
    await expect(phoneAdmission).resolves.toBe(false)

    const email = reserveObservation({ chatGuid: "email-chat-guid", chatIdentifier: "Ari@Example.COM" })
    expect(promote(email, {
      chatGuid: "email-chat-guid",
      chatIdentifier: "Ari@Example.COM",
    }).status).toBe("promoted")
    const lowerEmail = reserveObservation({ chatIdentifier: "ari@example.com" })
    const lowerPromotion = promote(lowerEmail, { chatIdentifier: "ari@example.com" })
    expect(lowerPromotion.status).toBe("promoted")
    if (lowerPromotion.status !== "promoted") throw new Error("expected lowercase email promotion")
    expect(lowerPromotion.capability.canonicalChat.chatGuid).toBe("email-chat-guid")

    const opaqueIdentifier = reserveObservation({ chatIdentifier: "group-chat-123" })
    expect(opaqueIdentifier.hints).toEqual(["identifier:group-chat-123"])
    clearPending(opaqueIdentifier)
    const punctuationIdentifier = reserveObservation({ chatIdentifier: "()" })
    expect(punctuationIdentifier.hints).toEqual(["identifier:()"])
    clearPending(punctuationIdentifier)
  })

  it("keeps distinct chats independent and retains high-water protection after finish", () => {
    const a = reserveObservation({ chatGuid: "chat-a" })
    const b = reserveObservation({ chatGuid: "chat-b" })
    const aPromotion = promote(a, { chatGuid: "chat-a" })
    const bPromotion = promote(b, { chatGuid: "chat-b" })
    if (aPromotion.status !== "promoted" || bPromotion.status !== "promoted") {
      throw new Error("expected promotions")
    }
    expect(isCurrent(aPromotion.capability)).toBe(true)
    expect(isCurrent(bPromotion.capability)).toBe(true)

    finish(aPromotion.capability)
    expect(isCurrent(aPromotion.capability)).toBe(false)
    expect(isCurrent(bPromotion.capability)).toBe(true)
    expect(promote(a, { chatGuid: "chat-a" })).toEqual({ status: "stale" })
  })

  it("admits delivery past older and unrelated pending observations", async () => {
    const older = reserveObservation({ chatGuid: "chat-guid" })
    const current = reserveObservation({ chatGuid: "chat-guid" })
    const currentPromotion = promote(current, { chatGuid: "chat-guid" })
    if (currentPromotion.status !== "promoted") throw new Error("expected current promotion")
    const unrelated = reserveObservation({ chatGuid: "other-chat" })

    await expect(awaitDeliveryAdmission(currentPromotion.capability)).resolves.toBe(true)

    clearPending(older)
    clearPending(unrelated)
  })

  it("does not create an unknown lane and makes conflicting identifier aliases unresolved", () => {
    const unknown = reserveObservation({ chatIdentifier: "unknown" })
    expect(unknown.hints).toEqual([])
    expect(promote(unknown, { chatIdentifier: "unknown" })).toEqual({ status: "unresolved" })

    const first = reserveObservation({ chatGuid: "chat-a", chatIdentifier: "shared" })
    expect(promote(first, { chatGuid: "chat-a", chatIdentifier: "shared" }).status).toBe("promoted")
    const conflicting = reserveObservation({ chatGuid: "chat-b", chatIdentifier: "shared" })
    expect(promote(conflicting, { chatGuid: "chat-b", chatIdentifier: "shared" }).status).toBe("promoted")
    const identifierOnly = reserveObservation({ chatIdentifier: "shared" })
    expect(promote(identifierOnly, { chatIdentifier: "shared" })).toEqual({ status: "unresolved" })
  })

  it("ignores stale cancel and finish calls after a newer generation owns the chat", () => {
    const first = reserveObservation({ chatGuid: "chat-guid" })
    const firstPromotion = promote(first, { chatGuid: "chat-guid" })
    if (firstPromotion.status !== "promoted") throw new Error("expected first promotion")
    const later = reserveObservation({ chatGuid: "chat-guid" })
    const secondPromotion = promote(later, { chatGuid: "chat-guid" })
    if (secondPromotion.status !== "promoted") throw new Error("expected second promotion")

    cancel(firstPromotion.capability, "stale")
    finish(firstPromotion.capability)
    expect(isCurrent(secondPromotion.capability)).toBe(true)
    expect(secondPromotion.capability.signal.aborted).toBe(false)
  })

  it("cancels the current generation with its supplied reason", async () => {
    const reservation = reserveObservation({ chatGuid: "chat-guid" })
    const promotion = promote(reservation, { chatGuid: "chat-guid" })
    if (promotion.status !== "promoted") throw new Error("expected promotion")

    cancel(promotion.capability, "turn-timeout")

    expect(promotion.capability.signal.aborted).toBe(true)
    expect(promotion.capability.signal.reason).toEqual(new Error("turn-timeout"))
    expect(isCurrent(promotion.capability)).toBe(false)
    await expect(awaitDeliveryAdmission(promotion.capability)).resolves.toBe(false)
  })

  it("emits one static promotion event for Nerves coverage", () => {
    const reservation = reserveObservation({ chatGuid: "chat-guid" })
    expect(promote(reservation, { chatGuid: "chat-guid" }).status).toBe("promoted")
    expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      component: "senses",
      event: "senses.bluebubbles_latest_turn_promoted",
    }))
  })

  it("settles pending observations when the process-local registry resets", () => {
    reserveObservation({ chatGuid: "pending-at-reset" })

    expect(() => __resetBlueBubblesLatestTurnsForTests()).not.toThrow()

    const fresh = reserveObservation({ chatGuid: "pending-at-reset" })
    expect(fresh.ordinal).toBe(1)
    clearPending(fresh)
  })
})
