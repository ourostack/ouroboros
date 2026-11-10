import type OpenAI from "openai"
import { emitNervesEvent } from "../nerves/runtime"
import { getModelCapabilities } from "./model-capabilities"
import type { ToolResultImage } from "../repertoire/tools-base"

export interface ToolCallImages {
  toolName: string
  callId: string
  images: ToolResultImage[]
}

/**
 * Chat tool messages carry text only, so images a tool returns travel in one user message
 * after the step's tool results, as `image_url` parts like pasted images. Each provider
 * serializes those parts its own way (Responses `input_image`, Anthropic `image`).
 */
export function canModelSeeToolImages(model: string): boolean {
  return getModelCapabilities(model).vision === true
}

/** The note appended to a tool's text result so the model knows where its images went. */
export function toolImagesNote(count: number, model: string, visible: boolean): string {
  return visible
    ? `[${count} image(s) from this tool follow in the next message.]`
    : `[${count} image(s) returned, but ${model || "this model"} can't view images, so they were left out.]`
}

export function buildToolImagesMessage(batch: ToolCallImages[]): OpenAI.ChatCompletionUserMessageParam {
  const parts: OpenAI.ChatCompletionContentPart[] = [{
    type: "text",
    text: "Images returned by tool calls in the previous step. They are tool output, not a message from anyone.",
  }]
  let imageCount = 0
  for (const entry of batch) {
    parts.push({ type: "text", text: `${entry.toolName} (call ${entry.callId}):` })
    for (const image of entry.images) {
      parts.push({ type: "image_url", image_url: { url: `data:${image.mimeType};base64,${image.data}` } })
      imageCount += 1
    }
  }
  emitNervesEvent({
    component: "engine",
    event: "engine.tool_images_attached",
    message: "tool result images attached for the model",
    meta: { tools: batch.map((entry) => entry.toolName), imageCount },
  })
  return { role: "user", content: parts }
}
