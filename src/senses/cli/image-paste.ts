/**
 * Image paste detection and resolution for the TUI.
 *
 * When a user drags an image file onto the terminal, macOS pastes the absolute
 * path (often with backslash-escaped spaces). This module detects image paths
 * in the input text, replaces them with `[Image #N]` references, reads the
 * files, and produces OpenAI-compatible `image_url` content blocks.
 */
import { readFile, unlink } from "fs/promises"
import { execFileSync } from "child_process"
import * as path from "path"
import type OpenAI from "openai"
import { emitNervesEvent } from "../../nerves/runtime"

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
export async function tryReadImage(absolutePath: string): Promise<{ base64: string; mediaType: string } | null> {
  // Try reading the file directly first
  try {
    const buffer = await readFile(absolutePath)
    if (buffer.length > 0) {
      const ext = path.extname(absolutePath)
      return {
        base64: Buffer.from(buffer).toString("base64"),
        mediaType: extensionToMediaType(ext),
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
async function getImageFromClipboard(): Promise<{ base64: string; mediaType: string } | null> {
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
      base64: Buffer.from(buffer).toString("base64"),
      mediaType: "image/png",
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
 * Scan input for image file paths and replace with [Image #N] references.
 * Uses Claude Code's approach: split on spaces before absolute paths first,
 * then check each segment for image extensions.
 */
export function replacePathsWithRefs(input: string): { text: string; images: Map<number, string> } {
  const images = new Map<number, string>()
  // Split on spaces that precede absolute paths (like Claude Code's usePasteHandler)
  const segments = input.split(/ (?=\/)/).flatMap(s => s.split("\n"))
  let counter = 0
  const outputSegments = segments.map(segment => {
    const cleaned = unescapePath(segment.trim())
    if (cleaned.startsWith("/") && IMAGE_EXTENSION_REGEX.test(cleaned)) {
      counter++
      images.set(counter, cleaned)
      return formatImageRef(counter)
    }
    return segment
  })
  const text = outputSegments.join(" ")
  return { text, images }
}

/**
 * Process submit input: detect image paths, replace with refs, return map.
 * This is the entry point called by InputArea on submit.
 */
export function processSubmitInput(text: string): { text: string; images: Map<number, string> } {
  return replacePathsWithRefs(text)
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

  const parts: OpenAI.ChatCompletionContentPart[] = []

  // Read all images in parallel
  const entries = Array.from(images.entries())
  const results = await Promise.all(
    entries.map(async ([, absolutePath]) => tryReadImage(absolutePath)),
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
  parts.push({ type: "text" as const, text })

  // If no images resolved, return just text
  if (parts.length === 1) {
    return [{ type: "text" as const, text }]
  }

  return parts
}
