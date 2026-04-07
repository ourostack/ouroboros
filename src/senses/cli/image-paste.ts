/**
 * Image paste detection and resolution for the TUI.
 *
 * When a user drags an image file onto the terminal, macOS pastes the absolute
 * path (often with backslash-escaped spaces). This module detects image paths
 * in the input text, replaces them with `[Image #N]` references, reads the
 * files, and produces OpenAI-compatible `image_url` content blocks.
 */
import { readFile } from "fs/promises"
import * as path from "path"
import type OpenAI from "openai"
import { emitNervesEvent } from "../../nerves/runtime"

/** Matches image file extensions (case-insensitive) */
export const IMAGE_EXTENSION_REGEX = /\.(png|jpe?g|gif|webp)$/i

/** Check whether a string (possibly backslash-escaped) ends with an image extension */
export function isImagePath(str: string): boolean {
  return IMAGE_EXTENSION_REGEX.test(unescapePath(str))
}

/** Convert backslash-escaped spaces to plain spaces (macOS drag-drop format) */
export function unescapePath(str: string): string {
  return str.replace(/\\ /g, " ")
}

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
 * Returns null on any error (file not found, permission denied, etc.)
 */
export async function tryReadImage(absolutePath: string): Promise<{ base64: string; mediaType: string } | null> {
  try {
    const buffer = await readFile(absolutePath)
    const ext = path.extname(absolutePath)
    return {
      base64: Buffer.from(buffer).toString("base64"),
      mediaType: extensionToMediaType(ext),
    }
  } catch {
    emitNervesEvent({
      component: "senses",
      event: "senses.image_read_error",
      message: `Failed to read image: ${absolutePath}`,
      meta: { path: absolutePath },
    })
    return null
  }
}

/** Format an image reference placeholder */
export function formatImageRef(n: number): string {
  return `[Image #${n}]`
}

/**
 * Scan input for absolute path tokens ending with image extensions.
 * Matches `/` followed by non-whitespace chars (allowing `\ ` for escaped spaces)
 * ending with an image extension.
 */
export function replacePathsWithRefs(input: string): { text: string; images: Map<number, string> } {
  const images = new Map<number, string>()
  // Match absolute paths starting with / that end with an image extension.
  // Allow backslash-escaped characters (like `\ ` for spaces in macOS drag-drop).
  const pathRegex = /(\/(?:[^\s\\]|\\.)+\.(?:png|jpe?g|gif|webp))/gi
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
