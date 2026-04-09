/**
 * Image paste detection and resolution for the TUI.
 *
 * When a user drags an image file onto the terminal, macOS pastes the absolute
 * path (often with backslash-escaped spaces). This module detects image paths
 * in the input text, replaces them with `[Image #N]` references, reads the
 * files, registers them as shared attachments, and produces OpenAI-compatible
 * `image_url` content blocks.
 */
import { createHash } from "node:crypto"
import { access, mkdir, readFile, unlink, writeFile } from "fs/promises"
import { execFileSync } from "child_process"
import * as path from "path"
import type OpenAI from "openai"
import { emitNervesEvent } from "../../nerves/runtime"
import { getAgentName, getAgentRoot } from "../../heart/identity"
import { renderAttachmentBlock } from "../../heart/attachments/render"
import { rememberRecentAttachment } from "../../heart/attachments/store"
import { buildCliLocalFileAttachmentRecord, type AttachmentRecord } from "../../heart/attachments/types"
import { materializeAttachment } from "../../heart/attachments/materialize"

/** Matches image file extensions (case-insensitive) */
export const IMAGE_EXTENSION_REGEX = /\.(png|jpe?g|gif|webp)$/i

/** Check whether a string (possibly backslash-escaped) ends with an image extension */
export function isImagePath(str: string): boolean {
  return IMAGE_EXTENSION_REGEX.test(unescapePath(str))
}

/** Strip shell escape backslashes from a path (macOS/Linux drag-drop format) */
export function unescapePath(str: string): string {
  // Handle double-backslashes first (actual backslash in filename)
  // then remove single escape backslashes
  return str.replace(/\\(.)/g, "$1")
}

/** Detect temp screenshot paths from macOS screencapture */
const TEMP_SCREENSHOT_RE = /\/TemporaryItems\/.*screencaptureui.*\/Screenshot/i

/** Map file extension to MIME media type */
function extensionToMediaType(ext: string): string {
  switch (ext.toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg"
    case ".png":
      return "image/png"
    case ".gif":
      return "image/gif"
    case ".webp":
      return "image/webp"
    default:
      return "image/png"
  }
}

/**
 * Read an image file and return base64 + media type.
 * Falls back to clipboard for temp screenshot paths (macOS screencapture
 * creates ephemeral files in TemporaryItems that are cleaned up quickly).
 * Returns null on any error.
 */
export async function tryReadImage(
  absolutePath: string,
): Promise<{ buffer: Buffer; base64: string; mediaType: string; fromClipboard: boolean } | null> {
  // Try reading the file directly first
  try {
    const buffer = await readFile(absolutePath)
    if (buffer.length > 0) {
      const ext = path.extname(absolutePath)
      return {
        buffer: Buffer.from(buffer),
        base64: Buffer.from(buffer).toString("base64"),
        mediaType: extensionToMediaType(ext),
        fromClipboard: false,
      }
    }
  } catch {
    // File not found or permission denied — try clipboard fallback
  }

  // Clipboard fallback for macOS temp screenshots
  /* v8 ignore start -- clipboard fallback requires real macOS screencapture @preserve */
  if (process.platform === "darwin" && TEMP_SCREENSHOT_RE.test(absolutePath)) {
    const clipboardImage = await getImageFromClipboard()
    if (clipboardImage) return clipboardImage
  }
  /* v8 ignore stop */

  emitNervesEvent({
    component: "senses",
    event: "senses.image_read_error",
    message: `Failed to read image: ${absolutePath}`,
    meta: { path: absolutePath },
  })
  return null
}

/**
 * Read image data from macOS clipboard via osascript.
 * Used as fallback when temp screenshot files are already cleaned up.
 */
/* v8 ignore start -- macOS clipboard integration @preserve */
async function getImageFromClipboard(): Promise<{ buffer: Buffer; base64: string; mediaType: string; fromClipboard: boolean } | null> {
  const tmpPath = "/tmp/ouro_clipboard_image.png"
  try {
    // Check if clipboard has image data
    execFileSync("osascript", ["-e", "the clipboard as «class PNGf»"], { stdio: "pipe" })

    // Save clipboard image to temp file
    execFileSync("osascript", [
      "-e", "set png_data to (the clipboard as «class PNGf»)",
      "-e", `set fp to open for access POSIX file "${tmpPath}" with write permission`,
      "-e", "write png_data to fp",
      "-e", "close access fp",
    ], { stdio: "pipe" })

    const buffer = await readFile(tmpPath)
    void unlink(tmpPath).catch(() => {})

    if (buffer.length === 0) return null

    return {
      buffer: Buffer.from(buffer),
      base64: Buffer.from(buffer).toString("base64"),
      mediaType: "image/png",
      fromClipboard: true,
    }
  } catch {
    return null
  }
}
/* v8 ignore stop */

/** Format an image reference placeholder */
export function formatImageRef(n: number): string {
  return `[Image #${n}]`
}

/**
 * Scan input for absolute image file paths and replace with [Image #N] references.
 * Handles backslash-escaped characters (macOS drag-drop) and paths with spaces.
 */
export function replacePathsWithRefs(input: string): { text: string; images: Map<number, string> } {
  const images = new Map<number, string>()
  // Match absolute paths: start with /, contain non-whitespace or backslash-escaped chars,
  // end with an image extension. The (?:\\.|\S) alternation allows `\ ` sequences.
  const pathRegex = /(?:\/(?:\\.|[^\s])+\.(?:png|jpe?g|gif|webp))/gi
  let counter = 0
  const text = input.replace(pathRegex, (match) => {
    counter++
    images.set(counter, unescapePath(match))
    return formatImageRef(counter)
  })
  return { text, images }
}

/**
 * Process submit input: detect image paths, replace with refs, return map.
 * This is the entry point called by InputArea on submit.
 */
export function processSubmitInput(text: string): { text: string; images: Map<number, string> } {
  return replacePathsWithRefs(text)
}

function extensionForMediaType(mediaType: string): string {
  switch (mediaType) {
    case "image/jpeg":
      return ".jpg"
    case "image/gif":
      return ".gif"
    case "image/webp":
      return ".webp"
    default:
      return ".png"
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath)
    return true
  } catch {
    return false
  }
}

async function persistClipboardImage(
  agentRoot: string,
  originalPath: string,
  image: { buffer: Buffer; mediaType: string },
): Promise<string> {
  const hash = createHash("sha1").update(originalPath).digest("hex").slice(0, 16)
  const targetPath = path.join(
    agentRoot,
    "state",
    "attachments",
    "imports",
    "cli",
    `${hash}${extensionForMediaType(image.mediaType)}`,
  )
  await mkdir(path.dirname(targetPath), { recursive: true })
  await writeFile(targetPath, image.buffer)
  return targetPath
}

/**
 * Build OpenAI content parts from text + image map.
 * For each image in the map, reads the file and creates an `image_url` content part.
 * Images that fail to read are silently skipped.
 * Returns `[{ type: "text", text }]` when no images resolve.
 */
export async function resolveImageContent(
  text: string,
  images: Map<number, string>,
): Promise<OpenAI.ChatCompletionContentPart[]> {
  if (images.size === 0) {
    return [{ type: "text" as const, text }]
  }

  const agentName = getAgentName()
  const agentRoot = getAgentRoot(agentName)
  const parts: OpenAI.ChatCompletionContentPart[] = []
  const rememberedAttachments: AttachmentRecord[] = []

  // Read all images in parallel
  const entries = Array.from(images.entries())
  const results = await Promise.all(
    entries.map(async ([, absolutePath]) => {
      const image = await tryReadImage(absolutePath)
      if (!image) return null

      const sourcePath = image.fromClipboard || !await pathExists(absolutePath)
        ? await persistClipboardImage(agentRoot, absolutePath, image)
        : absolutePath

      const attachment = rememberRecentAttachment(
        agentName,
        buildCliLocalFileAttachmentRecord({
          path: sourcePath,
          mimeType: image.mediaType,
          byteCount: image.buffer.length,
        }),
        agentRoot,
      )
      rememberedAttachments.push(attachment)

      try {
        const materialized = await materializeAttachment(agentName, attachment.id, {
          agentRoot,
          variant: "vision_safe",
        })
        const normalizedBuffer = await readFile(materialized.path)
        return {
          attachment,
          mediaType: materialized.mimeType ?? image.mediaType,
          base64: Buffer.from(normalizedBuffer).toString("base64"),
        }
      } catch {
        return {
          attachment,
          mediaType: image.mediaType,
          base64: image.base64,
        }
      }
    }),
  )

  for (const result of results) {
    if (result) {
      parts.push({
        type: "image_url" as const,
        image_url: { url: `data:${result.mediaType};base64,${result.base64}` },
      })
    }
  }

  // Always include the text part
  const attachmentBlock = renderAttachmentBlock(rememberedAttachments)
  const textWithAttachments = [text, attachmentBlock].filter(Boolean).join("\n")
  parts.push({ type: "text" as const, text: textWithAttachments || text })

  // If no images resolved, return just text
  if (parts.length === 1) {
    return [{ type: "text" as const, text }]
  }

  return parts
}
