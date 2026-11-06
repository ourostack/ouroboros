import { describe, expect, it } from "vitest"

import { probeImageBuffer } from "../../../heart/attachments/image-format"
import { minimalImages, pngBytes } from "../../fixtures/minimal-images"

describe("portable image format probe", () => {
  it("reads PNG and both GIF signatures with dimensions", () => {
    const png = pngBytes()
    expect(probeImageBuffer(png)).toEqual({
      mimeType: "image/png",
      pixelWidth: 1,
      pixelHeight: 1,
    })

    for (const signature of ["GIF87a", "GIF89a"]) {
      const gif = Buffer.from(minimalImages["image/gif"])
      gif.write(signature, 0, "ascii")
      expect(probeImageBuffer(gif)).toEqual({
        mimeType: "image/gif",
        pixelWidth: 1,
        pixelHeight: 1,
      })
    }
  })

  it("reads WebP extended, lossless, lossy, and unknown chunk variants", () => {
    const base = (chunk: string) => {
      const bytes = Buffer.alloc(30)
      bytes.write("RIFF", 0, "ascii")
      bytes.write("WEBP", 8, "ascii")
      bytes.write(chunk, 12, "ascii")
      return bytes
    }
    const extended = base("VP8X")
    extended[24] = 0x7f
    extended[27] = 0x3f
    expect(probeImageBuffer(extended)).toMatchObject({
      mimeType: "image/webp",
      pixelWidth: 128,
      pixelHeight: 64,
    })

    const lossless = base("VP8L")
    lossless[20] = 0x2f
    lossless[21] = 0xff
    lossless[22] = 0x01
    lossless[23] = 0x02
    lossless[24] = 0x00
    expect(probeImageBuffer(lossless)).toMatchObject({
      mimeType: "image/webp",
      pixelWidth: 512,
      pixelHeight: 9,
    })

    const lossy = base("VP8 ")
    lossy[23] = 0x9d
    lossy[24] = 0x01
    lossy[25] = 0x2a
    lossy.writeUInt16LE(640, 26)
    lossy.writeUInt16LE(480, 28)
    expect(probeImageBuffer(lossy)).toMatchObject({
      mimeType: "image/webp",
      pixelWidth: 640,
      pixelHeight: 480,
    })

    expect(probeImageBuffer(base("ANIM"))).toBeUndefined()
  })

  it("reads JPEG SOF dimensions and tolerates JPEGs without a dimension marker", () => {
    const jpeg = Buffer.from([
      0xff, 0xd8,
      0xff, 0xe0, 0x00, 0x02,
      0xff, 0xc0, 0x00, 0x07, 0x08, 0x00, 0x10, 0x00, 0x20,
    ])
    expect(probeImageBuffer(jpeg)).toEqual({
      mimeType: "image/jpeg",
      pixelWidth: 32,
      pixelHeight: 16,
    })
    expect(probeImageBuffer(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).toBeUndefined()
    expect(probeImageBuffer(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01]))).toBeUndefined()
    expect(probeImageBuffer(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]))).toBeUndefined()
  })

  it("rejects unknown and truncated data", () => {
    expect(probeImageBuffer(Buffer.alloc(0))).toBeUndefined()
    expect(probeImageBuffer(Buffer.from("not-an-image"))).toBeUndefined()
    expect(probeImageBuffer(Buffer.from("RIFF....WEBPVP8X"))).toBeUndefined()
  })

  it("rejects zero-dimension portable images and handles irregular JPEG markers", () => {
    const png = Buffer.alloc(24)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png)
    png.writeUInt32BE(1, 16)
    expect(probeImageBuffer(png)).toBeUndefined()

    const gif = Buffer.alloc(10)
    gif.write("GIF89a", 0, "ascii")
    gif.writeUInt16LE(1, 6)
    expect(probeImageBuffer(gif)).toBeUndefined()

    const lossyWebp = Buffer.alloc(30)
    lossyWebp.write("RIFF", 0, "ascii")
    lossyWebp.write("WEBP", 8, "ascii")
    lossyWebp.write("VP8 ", 12, "ascii")
    lossyWebp[23] = 0x9d
    lossyWebp[24] = 0x01
    lossyWebp[25] = 0x2a
    expect(probeImageBuffer(lossyWebp)).toBeUndefined()

    const jpegWithPadding = Buffer.from([
      0xff, 0xd8,
      0xff, 0xe0, 0x00, 0x03, 0x00,
      0x00,
      0xff, 0xc0, 0x00, 0x07, 0x08, 0x00, 0x01, 0x00, 0x01,
    ])
    expect(probeImageBuffer(jpegWithPadding)).toMatchObject({
      mimeType: "image/jpeg",
      pixelWidth: 1,
      pixelHeight: 1,
    })
    expect(probeImageBuffer(Buffer.from([0xff, 0xd8, 0xff, 0xd8, 0x00, 0x00]))).toBeUndefined()
    expect(probeImageBuffer(Buffer.from([0xff, 0xd8, 0xff, 0xd9, 0x00, 0x00]))).toBeUndefined()
    expect(probeImageBuffer(Buffer.from([0xff, 0xd8, 0xff, 0xff, 0xff, 0xff]))).toBeUndefined()
    expect(probeImageBuffer(Buffer.from([0xff, 0xd8, 0xff, 0xff, 0xff, 0xe0]))).toBeUndefined()
  })
})
