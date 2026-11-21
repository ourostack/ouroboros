// Guards the census walker reads directly: which `!==` checks lead on to the words read below them.
export function guarded(args: string[]) {
  const [word] = args
  if (word !== "solo") throw new Error("Usage: solo")
  return word
}

export function chained(args: string[]) {
  const [word] = args
  if (word !== "one" && (word !== "two")) {
    throw new Error("Usage: one|two")
  }
  return word
}

export function mixed(args: string[]) {
  const [word, flag] = args
  if (flag === "--quiet" && word !== "loud") return null
  return word
}

export function fallsThrough(args: string[]) {
  const [word] = args
  if (word !== "open") console.log("not open")
  return word
}

export function withElse(args: string[]) {
  const [word] = args
  if (word !== "shut") throw new Error("Usage: shut")
  else console.log("shut")
  return word
}

export function either(args: string[]) {
  const [word, other] = args
  if (word !== "left" || other === "right") throw new Error("Usage: left")
  return word
}
