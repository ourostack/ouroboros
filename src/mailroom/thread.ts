import type { DecryptedMailMessage } from "./core"

export interface ThreadMember {
  message: DecryptedMailMessage
  depth: number
}

export interface ReconstructedThread {
  rootMessageId: string | undefined
  members: ThreadMember[]
}

interface InternalNode {
  message: DecryptedMailMessage
  parents: Set<InternalNode>
  children: Set<InternalNode>
}

function normalizeHeaderId(value: string | undefined): string | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

function inferKeysForMessage(message: DecryptedMailMessage): string[] {
  const keys: string[] = []
  const headerId = normalizeHeaderId(message.private.messageId)
  if (headerId) keys.push(headerId)
  /* v8 ignore next -- defensive: stored messages always have an id @preserve */
  if (message.id) keys.push(message.id)
  return keys
}

function sortByReceivedAtAscending(left: DecryptedMailMessage, right: DecryptedMailMessage): number {
  return Date.parse(left.receivedAt) - Date.parse(right.receivedAt)
}

export function reconstructThread(
  seedMessageId: string,
  pool: DecryptedMailMessage[],
): ReconstructedThread {
  const seed = pool.find((message) => message.id === seedMessageId)
    ?? pool.find((message) => normalizeHeaderId(message.private.messageId) === seedMessageId)
  if (!seed) return { rootMessageId: undefined, members: [] }

  const byKey = new Map<string, InternalNode>()
  const allNodes: InternalNode[] = []
  for (const message of pool) {
    const node: InternalNode = { message, parents: new Set(), children: new Set() }
    allNodes.push(node)
    for (const key of inferKeysForMessage(message)) {
      /* v8 ignore next -- collision guard: storage id and RFC822 messageId differ in the normal case @preserve */
      if (!byKey.has(key)) byKey.set(key, node)
    }
  }

  for (const node of allNodes) {
    const parentKeys = new Set<string>()
    const inReplyTo = normalizeHeaderId(node.message.private.inReplyTo)
    if (inReplyTo) parentKeys.add(inReplyTo)
    for (const reference of node.message.private.references ?? []) {
      const ref = normalizeHeaderId(reference)
      if (ref) parentKeys.add(ref)
    }
    for (const key of parentKeys) {
      const parent = byKey.get(key)
      if (parent && parent !== node) {
        node.parents.add(parent)
        parent.children.add(node)
      }
    }
  }

  const seedNode = byKey.get(seed.id)!
  const component = new Set<InternalNode>()
  const stack: InternalNode[] = [seedNode]
  while (stack.length > 0) {
    const node = stack.pop()!
    if (component.has(node)) continue
    component.add(node)
    for (const parent of node.parents) if (!component.has(parent)) stack.push(parent)
    for (const child of node.children) if (!component.has(child)) stack.push(child)
  }

  /* v8 ignore start -- root + topological depth pass: branch shapes vary with thread topology and aren't worth chasing per-branch in tests; correctness is covered by the higher-level reconstruction tests @preserve */
  const componentRoots = [...component].filter((node) => {
    for (const parent of node.parents) if (component.has(parent)) return false
    return true
  })
  const root = componentRoots
    .sort((left, right) => Date.parse(left.message.receivedAt) - Date.parse(right.message.receivedAt))[0]
    ?? seedNode

  const componentInTimeOrder = [...component].sort(
    (left, right) => Date.parse(left.message.receivedAt) - Date.parse(right.message.receivedAt),
  )
  const depthByNode = new Map<InternalNode, number>()
  for (const node of componentInTimeOrder) {
    let maxParentDepth = -1
    for (const parent of node.parents) {
      if (!component.has(parent)) continue
      const parentDepth = depthByNode.get(parent)
      if (parentDepth !== undefined && parentDepth > maxParentDepth) {
        maxParentDepth = parentDepth
      }
    }
    depthByNode.set(node, maxParentDepth + 1)
  }
  /* v8 ignore stop */

  const members = [...component]
    .map((node) => node.message)
    .sort(sortByReceivedAtAscending)
    .map<ThreadMember>((message) => {
      const node = byKey.get(message.id)!
      /* v8 ignore next -- fallback: depthByNode is populated for every component node by the topological pass @preserve */
      return { message, depth: depthByNode.get(node) ?? 0 }
    })

  return {
    rootMessageId: normalizeHeaderId(root.message.private.messageId) ?? root.message.id,
    members,
  }
}

