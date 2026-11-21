// An entry point that reads process.argv inside a function the module runs.
function main(): void {
  const agent = process.argv[2]
  if (!agent) throw new Error("usage: daemon-entry <agent>")
}

main()
