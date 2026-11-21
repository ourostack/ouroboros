// The fixture CLI's dispatcher: the error codes its commands raise, as literals outside any card.
export function raise(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

export function run(words: string[]): void {
  if (words[0] === "up") throw raise("daemon-down", "the daemon didn't answer on its socket")
  if (words[0] === "friend") throw raise("no-friend", "no friend has that id")
  throw raise("unknown-door", `no command ${words.join(" ")}`)
}
