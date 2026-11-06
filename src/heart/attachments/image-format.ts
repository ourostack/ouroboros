export interface ProbedImageBuffer {
  mimeType: "image/gif" | "image/jpeg" | "image/png" | "image/webp"
  pixelWidth: number
  pixelHeight: number
}

function uint24LE(bytes: Buffer, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16)
}

function jpegDimensions(bytes: Buffer): { pixelWidth: number; pixelHeight: number } | undefined {
  let offset = 2
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1
      continue
    }
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1
    const marker = bytes[offset]
    offset += 1
    if (marker === undefined || marker === 0xd8 || marker === 0xd9) continue
    if (offset + 2 > bytes.length) return undefined
    const segmentLength = bytes.readUInt16BE(offset)
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return undefined
    if (
      [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]
        .includes(marker)
      && segmentLength >= 7
    ) {
      return {
        pixelHeight: bytes.readUInt16BE(offset + 3),
        pixelWidth: bytes.readUInt16BE(offset + 5),
      }
    }
    offset += segmentLength
  }
  return undefined
}

export function probeImageBuffer(bytes: Buffer): ProbedImageBuffer | undefined {
  if (
    bytes.length >= 24
    && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    const pixelWidth = bytes.readUInt32BE(16)
    const pixelHeight = bytes.readUInt32BE(20)
    if (pixelWidth <= 0 || pixelHeight <= 0) return undefined
    return {
      mimeType: "image/png",
      pixelWidth,
      pixelHeight,
    }
  }

  if (bytes.length >= 10) {
    const signature = bytes.subarray(0, 6).toString("ascii")
    if (signature === "GIF87a" || signature === "GIF89a") {
      const pixelWidth = bytes.readUInt16LE(6)
      const pixelHeight = bytes.readUInt16LE(8)
      if (pixelWidth <= 0 || pixelHeight <= 0) return undefined
      return {
        mimeType: "image/gif",
        pixelWidth,
        pixelHeight,
      }
    }
  }

  if (
    bytes.length >= 30
    && bytes.subarray(0, 4).toString("ascii") === "RIFF"
    && bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    const chunk = bytes.subarray(12, 16).toString("ascii")
    if (chunk === "VP8X") {
      return {
        mimeType: "image/webp",
        pixelWidth: uint24LE(bytes, 24) + 1,
        pixelHeight: uint24LE(bytes, 27) + 1,
      }
    }
    if (chunk === "VP8L" && bytes[20] === 0x2f) {
      return {
        mimeType: "image/webp",
        pixelWidth: 1 + bytes[21]! + ((bytes[22]! & 0x3f) << 8),
        pixelHeight: 1 + (bytes[22]! >> 6) + (bytes[23]! << 2) + ((bytes[24]! & 0x0f) << 10),
      }
    }
    if (
      chunk === "VP8 "
      && bytes[23] === 0x9d
      && bytes[24] === 0x01
      && bytes[25] === 0x2a
    ) {
      const pixelWidth = bytes.readUInt16LE(26) & 0x3fff
      const pixelHeight = bytes.readUInt16LE(28) & 0x3fff
      if (pixelWidth <= 0 || pixelHeight <= 0) return undefined
      return {
        mimeType: "image/webp",
        pixelWidth,
        pixelHeight,
      }
    }
    return undefined
  }

  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    const dimensions = jpegDimensions(bytes)
    return dimensions ? { mimeType: "image/jpeg", ...dimensions } : undefined
  }

  return undefined
}
