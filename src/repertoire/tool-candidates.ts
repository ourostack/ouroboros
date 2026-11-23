// The real tools a mistyped tool name could mean. The MCP server and the in-turn dispatcher both answer an unknown tool
// with these, so a model is sent to a real tool by the same rule wherever it calls one.

/** A name as compared: a host's `mcp__<server>__` prefix dropped, lowercase, letters and digits only. */
function comparable(name: string): string {
  const bare = name.includes("__") ? name.slice(name.lastIndexOf("__") + 2) : name
  return bare.toLowerCase().replace(/[^a-z0-9]/g, "")
}

/** Edit distance between two comparable names. */
function nameDistance(x: string, y: string): number {
  let previous = Array.from({ length: y.length + 1 }, (_, j) => j)
  for (let i = 1; i <= x.length; i++) {
    const current = [i]
    for (let j = 1; j <= y.length; j++) {
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1))
    }
    previous = current
  }
  return previous[y.length]!
}

/**
 * The real tools a mistyped name could mean: the ones whose name contains it or that it contains (`report` gives the
 * three report tools), else the one within a few edits of it, else none. Never a guess: a wrong suggestion would send
 * the agent to a tool that does something else.
 */
export function toolCandidates(name: string, names: readonly string[]): string[] {
  const wanted = comparable(name)
  const exact = names.filter((candidate) => comparable(candidate) === wanted)
  if (exact.length > 0) return exact
  if (wanted.length >= 3) {
    const containing = names.filter((candidate) => comparable(candidate).includes(wanted))
    if (containing.length > 0) return containing
  }
  const limit = Math.max(1, Math.floor(wanted.length / 3))
  const near = names.map((candidate) => ({ candidate, distance: nameDistance(wanted, comparable(candidate)) })).filter((n) => n.distance <= limit)
  if (near.length > 0) {
    const best = Math.min(...near.map((n) => n.distance))
    return near.filter((n) => n.distance === best).map((n) => n.candidate)
  }
  // A longer name that holds a tool's whole name, such as `send_message_now`: the longest such tool.
  const inside = names.filter((candidate) => comparable(candidate).length >= 4 && wanted.includes(comparable(candidate)))
  if (inside.length === 0) return []
  const longest = Math.max(...inside.map((candidate) => comparable(candidate).length))
  return inside.filter((candidate) => comparable(candidate).length === longest)
}
