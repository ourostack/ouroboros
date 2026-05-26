/* v8 ignore file -- type-only A2A protocol definitions */

export interface A2AAgentCard {
  name: string
  description: string
  supportedInterfaces: Array<{
    url: string
    protocolBinding: "JSONRPC" | "GRPC" | "HTTP+JSON" | string
    protocolVersion: string
    tenant?: string
  }>
  version: string
  capabilities: {
    streaming?: boolean
    pushNotifications?: boolean
    extendedAgentCard?: boolean
    extensions?: Array<{
      uri?: string
      description?: string
      required?: boolean
      params?: Record<string, unknown>
    }>
  }
  defaultInputModes: string[]
  defaultOutputModes: string[]
  skills: Array<{
    id: string
    name: string
    description: string
    tags?: string[]
    examples?: string[]
    inputModes?: string[]
    outputModes?: string[]
  }>
  metadata?: Record<string, unknown>
  protocolVersion?: string
  url?: string
  preferredTransport?: "JSONRPC" | string
  additionalInterfaces?: Array<{
    url: string
    transport: "JSONRPC" | "GRPC" | "HTTP+JSON" | string
  }>
}

export type A2ATaskState =
  | "TASK_STATE_SUBMITTED"
  | "TASK_STATE_WORKING"
  | "TASK_STATE_COMPLETED"
  | "TASK_STATE_FAILED"
  | "TASK_STATE_CANCELED"
  | "TASK_STATE_REJECTED"
  | "TASK_STATE_AUTH_REQUIRED"
  | "TASK_STATE_INPUT_REQUIRED"
  | "submitted"
  | "working"
    | "completed"
    | "failed"
    | "canceled"
    | "rejected"
    | "auth-required"
    | "input-required"
    | "unknown"

export interface A2AMessagePart {
  kind?: "text"
  text: string
}

export interface A2AMessage {
  role: "ROLE_USER" | "ROLE_AGENT" | "user" | "agent"
  parts: A2AMessagePart[]
  messageId?: string
  taskId?: string
  contextId?: string
  metadata?: Record<string, unknown>
}

export interface A2AArtifact {
  artifactId: string
  name?: string
  parts: A2AMessagePart[]
}

export interface A2ATask {
  id: string
  contextId: string
  status: {
    state: A2ATaskState
    timestamp: string
    message?: A2AMessage
  }
  history: A2AMessage[]
  artifacts?: A2AArtifact[]
  metadata?: Record<string, unknown>
}

export interface A2AJsonRpcRequest {
  jsonrpc: "2.0"
  id?: string | number | null
  method: string
  params?: unknown
}

export interface A2AJsonRpcSuccess {
  jsonrpc: "2.0"
  id?: string | number | null
  result: unknown
}

export interface A2AJsonRpcError {
  jsonrpc: "2.0"
  id?: string | number | null
  error: {
    code: number
    message: string
    data?: unknown
  }
}

export type A2AJsonRpcResponse = A2AJsonRpcSuccess | A2AJsonRpcError
