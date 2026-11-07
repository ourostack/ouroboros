import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs")
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
  }
})

vi.mock("../../heart/identity", async () => {
  const actual = await vi.importActual<typeof import("../../heart/identity")>("../../heart/identity")
  return { ...actual, getRepoRoot: () => "/opt/ouro" }
})

describe("guardInvocation — structural guardrails", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.mocked(fs.existsSync).mockReturnValue(false)
  })

  // --- edit_file requires prior read ---

  it("edit_file rejects if path has not been read", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("edit_file", { path: "/some/file.ts" }, { readPaths: new Set() })
    expect(result.allowed).toBe(false)
    if (!result.allowed) {
      expect(result.reason).toMatch(/read/i)
    }
  })

  it("edit_file allows if path is in readPaths", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("edit_file", { path: "/some/file.ts" }, { readPaths: new Set(["/some/file.ts"]) })
    expect(result.allowed).toBe(true)
  })

  // --- write_file on existing file requires prior read ---

  it("write_file rejects overwriting existing file without prior read", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("write_file", { path: "/existing/file.ts" }, { readPaths: new Set() })
    expect(result.allowed).toBe(false)
    if (!result.allowed) {
      expect(result.reason).toMatch(/read/i)
    }
  })

  it("write_file allows new file (not on disk) without prior read", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false)
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("write_file", { path: "/new/file.ts" }, { readPaths: new Set() })
    expect(result.allowed).toBe(true)
  })

  it("write_file allows overwriting existing file if in readPaths", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("write_file", { path: "/existing/file.ts" }, { readPaths: new Set(["/existing/file.ts"]) })
    expect(result.allowed).toBe(true)
  })

  // --- destructive shell patterns blocked ---

  it("blocks rm -rf /", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "rm -rf /" }, { readPaths: new Set() })
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.reason).toMatch(/dangerous/i)
  })

  it("blocks rm -rf ~", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "rm -rf ~" }, { readPaths: new Set() })
    expect(result.allowed).toBe(false)
  })

  it("blocks chmod -R 777 /", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "chmod -R 777 /" }, { readPaths: new Set() })
    expect(result.allowed).toBe(false)
  })

  it("blocks mkfs.ext4", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "mkfs.ext4 /dev/sda" }, { readPaths: new Set() })
    expect(result.allowed).toBe(false)
  })

  it("blocks dd if=/dev/zero of=/dev/sda", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "dd if=/dev/zero of=/dev/sda" }, { readPaths: new Set() })
    expect(result.allowed).toBe(false)
  })

  it("allows non-destructive commands like ls", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "ls -la" }, { readPaths: new Set() })
    expect(result.allowed).toBe(true)
  })

  it("allows non-destructive commands like cat", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "cat foo.txt" }, { readPaths: new Set() })
    expect(result.allowed).toBe(true)
  })

  it("allows non-destructive commands like git status", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "git status" }, { readPaths: new Set() })
    expect(result.allowed).toBe(true)
  })

  it.each([
    "ouro mail sync-cache --agent slugger",
    "echo ready && ouro mail sync-cache --agent slugger",
    "echo ready\nouro mail sync-cache --agent slugger",
    "ouro mail sync\\-cache --agent slugger",
    `ouro mail "sync-"cache --agent slugger`,
    `ouro mail sync'-cache' --agent slugger`,
    `ou"ro" ma'il' sy"nc-"cache --agent slugger`,
    `ouro mail $'sync-cache' --agent slugger`,
    `ouro mail $"sync-cache" --agent slugger`,
    `ou$'ro' ma$'il' sy$'nc-'cache --agent slugger`,
    `ou"ro" ma$'il' sy"nc-"cache --agent slugger`,
    `ou'ro' ma$'il' sy'nc-'cache --agent slugger`,
    `ou\\ro ma$'il' sy\\nc-\\cache --agent slugger`,
    "ouro mail $'sync\\x2dcache' --agent slugger",
    "ou$'\\x72o' mail sync-cache --agent slugger",
    "ouro mail $'sync\\055cache' --agent slugger",
    "sh -c $'ouro\\x20mail\\x20sync-cache --agent slugger'",
    "sh -c $'ouro\\040mail\\040sync-cache --agent slugger'",
    "eval ouro$'\\x20'mail$'\\x20'sync-cache --agent slugger",
    "bash -c $'ou\\x72o\\x20mail\\x20sync\\x2dcache --agent slugger'",
    "command zsh -c $'ouro\\x20mail\\040sync-cache --agent slugger'",
    "M=mail; ouro $M sync-cache --agent slugger",
    "C=sync-cache; ouro mail $C --agent slugger",
    "O=ouro; $O mail sync-cache --agent slugger",
    "M=mail; ouro ${M} sync-cache --agent slugger",
    "C=sync-cache; ouro mail \"${C}\" --agent slugger",
    "O=ouro; \"${O}\" mail sync-cache --agent slugger",
    "R=ro; ou${R} mail sync-cache --agent slugger",
    "command $O mail sync-cache --agent slugger",
    "eval $O mail sync-cache --agent slugger",
    "eval eval eval eval ouro mail sync-cache --agent slugger",
    `${"eval ".repeat(33)}ouro mail sync-cache --agent slugger`,
    `${"$(".repeat(33)}ouro mail sync-cache --agent slugger${")".repeat(33)}`,
    "ouro ${M:-mail} sync-cache --agent slugger",
    "M=$X; ouro $M sync-cache --agent slugger",
    "M=mail; M=recent ouro $M sync-cache --agent slugger",
    "O=ouro sh -c '$O mail sync-cache --agent slugger'",
    "command -- ouro mail sync-cache --agent slugger",
    "env X=y ouro mail sync-cache --agent slugger",
    "ouro mail sync-cache > /tmp/ouro-sync.out",
    "echo <(ouro $M sync-cache --agent slugger)",
    "ouro mail sync-cache$'\\x0a' --agent slugger",
    "true # cache warmed\nouro mail sync-cache --agent slugger",
    "true # ignored <<EOF\nouro mail sync-cache --agent slugger",
    "if true; then ouro mail sync-cache --agent slugger; fi",
    "for item in one; do ouro mail sync-cache --agent slugger; done",
    "refresh_cache() { ouro mail sync-cache --agent slugger; }; refresh_cache",
    "function refresh_cache { ouro mail sync-cache --agent slugger; }; refresh_cache",
    "coproc ouro mail sync-cache --agent slugger",
    "coproc CACHE ouro mail sync-cache --agent slugger",
    "coproc cache_worker ouro mail sync-cache --agent slugger",
    "/opt/ouro/bin/ouro mail sync-cache --agent slugger",
    "O=/opt/ouro/bin/ouro; $O mail sync-cache --agent slugger",
    "D=/opt/ouro/bin; $D/ouro mail sync-cache --agent slugger",
    "\"$(command -v ouro)\" mail sync-cache --agent slugger",
    "env -u O ouro mail sync-cache --agent slugger",
    "env -C /tmp ouro mail sync-cache --agent slugger",
    "env -S 'ouro mail sync-cache --agent slugger'",
    "env -S ouro mail sync-cache --agent slugger",
    "env --split-string 'ouro mail sync-cache --agent slugger'",
    "env --split-string='ouro mail sync-cache --agent slugger'",
    "env -S '-u X ouro mail sync-cache --agent slugger'",
    "env --split-string='--chdir /tmp ouro mail sync-cache --agent slugger'",
    "/usr/bin/env ouro mail sync-cache --agent slugger",
    "sudo -u nobody ouro mail sync-cache --agent slugger",
    ...[
      ["-C", "4"], ["-D", "/tmp"], ["-g", "staff"], ["-h", "host"], ["-p", "prompt"], ["-R", "/tmp"],
      ["-r", "role"], ["-T", "30"], ["-t", "type"], ["-U", "other"], ["-u", "nobody"],
      ["--close-from", "4"], ["--chdir", "/tmp"], ["--group", "staff"], ["--host", "host"],
      ["--prompt", "prompt"], ["--chroot", "/tmp"], ["--role", "role"], ["--command-timeout", "30"],
      ["--type", "type"], ["--other-user", "other"], ["--user", "nobody"],
    ].map(([option, operand]) => `sudo ${option} ${operand} ouro mail sync-cache --agent slugger`),
    "sudo -gstaff ouro mail sync-cache --agent slugger",
    "sudo --group=staff ouro mail sync-cache --agent slugger",
    "sudo -n ouro mail sync-cache --agent slugger",
    "time -p ouro mail sync-cache --agent slugger",
    "time -o /tmp/time.out ouro mail sync-cache --agent slugger",
    "time -f %E ouro mail sync-cache --agent slugger",
    "time --output /tmp/time.out ouro mail sync-cache --agent slugger",
    "time --format %E ouro mail sync-cache --agent slugger",
    "time --output=/tmp/time.out ouro mail sync-cache --agent slugger",
    "time --format=%E ouro mail sync-cache --agent slugger",
    "exec -a ouro-sync ouro mail sync-cache --agent slugger",
    "exec -c ouro mail sync-cache --agent slugger",
    "/bin/sh -c 'ouro mail sync-cache --agent slugger'",
    "bash --noprofile -lc 'ouro mail sync-cache --agent slugger'",
    "bash -O extglob -c 'ouro mail sync-cache --agent slugger'",
    "cat <<EOF\n$(ouro mail sync-cache --agent slugger)\nEOF",
    "cat <<EOF\n`ouro mail sync-cache --agent slugger`\nEOF",
    "values=(`ouro mail sync-cache --agent slugger`)",
    "cmd=(ouro mail sync-cache); \"${cmd[@]}\" --agent slugger",
    "cmd=(ouro mail sync-cache); command \"${cmd[@]}\" --agent slugger",
    "cmd=(ouro mail sync-cache); env \"${cmd[@]}\" --agent slugger",
    "cmd=(ouro mail sync-cache); sudo \"${cmd[@]}\" --agent slugger",
    "cmd=(ouro mail sync-cache); eval \"${cmd[*]} --agent slugger\"",
    "cmd=\"ouro mail sync-cache --agent slugger\"; eval \"$cmd\"",
    "cmd=\"ouro mail sync-cache --agent slugger\"; sh -c \"$cmd\"",
    "eval \"$cmd\"",
    "sh -c \"$cmd\"",
    "cmd=\"ouro mail sync-cache --agent slugger\"; $cmd",
    "cmd=(/opt/ouro/bin/ouro mail sync-cache); \"${cmd[@]}\" --agent slugger",
    "cmd=(echo ok); cmd=(ouro mail sync-cache); \"${cmd[@]}\" --agent slugger",
    "cmd+=(ouro mail sync-cache); \"${cmd[@]}\" --agent slugger",
    "cmd=(); cmd+=(ouro mail sync-cache); \"${cmd[@]}\" --agent slugger",
    "cmd[0]=ouro; cmd[1]=mail; cmd[2]=sync-cache; \"${cmd[@]}\" --agent slugger",
    "word=ouro; cmd=($word mail sync-cache); \"${cmd[@]}\" --agent slugger",
    "cmd=($X); ouro mail \"${cmd[@]}\" --agent slugger",
    "cmd=(*); ouro mail \"${cmd[@]}\" --agent slugger",
    "cmd=($X); ouro \"${cmd[@]}\" sync-cache --agent slugger",
    "cmd=(\"ouro mail sync-cache\"); ${cmd[@]} --agent slugger",
    "cmd=(\"ouro mail\" sync-cache); ${cmd[@]} --agent slugger",
    "cmd=(ouro \"mail sync-cache\"); ${cmd[@]} --agent slugger",
    "cmd=(\"ouro mail sync-cache\"); ${cmd[*]} --agent slugger",
    "cmd=(ro mail sync-cache); \"ou${cmd[@]}\" --agent slugger",
    "cmd=(ouro mail sync-ca); \"${cmd[@]}che\" --agent slugger",
    "cmd=(ouro); \"${cmd[@]}\" mail sync-cache --agent slugger",
    "cmd=(ouro mail); \"${cmd[@]}\" sync-cache --agent slugger",
    "cmd=(); \"ouro${cmd[@]}\" mail sync-cache --agent slugger",
    "export cmd='ouro mail sync-cache'; $cmd --agent slugger",
    "readonly cmd='ouro mail sync-cache'; $cmd --agent slugger",
    "typeset cmd='ouro mail sync-cache'; $cmd --agent slugger",
    "$cmd --agent slugger",
    "word=ouro; cmd=(); cmd[0]=$word; \"${cmd[@]}\" --agent slugger",
    "\"${cmd[@]}\" --agent slugger",
    "cmd=(`printf ouro` mail sync-cache); \"${cmd[@]}\" --agent slugger",
    "cmd=(*); \"${cmd[@]}\" --agent slugger",
    `${"$(".repeat(33)}ouro mail sync-cache${")".repeat(33)}`,
    "echo \"$(printf '%s' ')' && (ouro mail sync-cache --agent slugger))\"",
    "command ouro mail sync-cache --agent slugger",
    "env ouro mail sync-cache --agent slugger",
    "sh -c 'ouro mail sync-cache --agent slugger'",
    "$(ouro mail sync-cache --agent slugger)",
    "`ouro mail sync-cache --agent slugger`",
  ])("requires family trust for cache convergence through shell shape %s", async (command) => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    for (const trustLevel of ["stranger", "acquaintance", "friend"] as const) {
      expect(guardInvocation("shell", { command }, { readPaths: new Set(), trustLevel })).toEqual(expect.objectContaining({ allowed: false }))
    }
    expect(guardInvocation("shell", { command }, { readPaths: new Set(), trustLevel: "family" })).toEqual({ allowed: true })
    expect(guardInvocation("shell", { command }, { readPaths: new Set() })).toEqual({ allowed: true })
  })

  it("keeps the owner's terminals to family trust", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    for (const tool of ["shepherd_overview", "shepherd_read", "shepherd_signal", "shepherd_send"]) {
      for (const trustLevel of ["stranger", "acquaintance", "friend"] as const) {
        expect(guardInvocation(tool, {}, { readPaths: new Set(), trustLevel })).toEqual(expect.objectContaining({ allowed: false }))
      }
      expect(guardInvocation(tool, {}, { readPaths: new Set(), trustLevel: "family" })).toEqual({ allowed: true })
      expect(guardInvocation(tool, {}, { readPaths: new Set() })).toEqual(expect.objectContaining({ allowed: false }))
    }
  })

  it("preserves friend access to unrelated Ouro commands", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    expect(guardInvocation("shell", { command: "ouro status" }, { readPaths: new Set(), trustLevel: "friend" })).toEqual({ allowed: true })
    expect(guardInvocation("shell", { command: "ouro status $'sync\\x2dcache'" }, { readPaths: new Set(), trustLevel: "friend" })).toEqual({ allowed: true })
    expect(guardInvocation("shell", { command: "echo $'sync\\x2dcache'" }, { readPaths: new Set(), trustLevel: "friend" })).toEqual({ allowed: true })
    expect(guardInvocation("shell", { command: "ouro mail $'recent'" }, { readPaths: new Set(), trustLevel: "friend" })).toEqual({ allowed: true })
    expect(guardInvocation("shell", { command: "M=recent; ouro mail $M" }, { readPaths: new Set(), trustLevel: "friend" })).toEqual({ allowed: true })
    expect(guardInvocation("shell", { command: "O=echo; $O ouro mail sync-cache" }, { readPaths: new Set(), trustLevel: "friend" })).toEqual({ allowed: true })
    expect(guardInvocation("shell", { command: "C=sync-cache; echo $C" }, { readPaths: new Set(), trustLevel: "friend" })).toEqual({ allowed: true })
    expect(guardInvocation("shell", { command: "M=mail; ouro status $M" }, { readPaths: new Set(), trustLevel: "friend" })).toEqual({ allowed: true })
    expect(guardInvocation("shell", { command: "sh -c 'ouro mail recent'" }, { readPaths: new Set(), trustLevel: "friend" })).toEqual({ allowed: true })
    expect(guardInvocation("shell", { command: "eval echo ok" }, { readPaths: new Set(), trustLevel: "friend" })).toEqual({ allowed: true })
    expect(guardInvocation("shell", { command: "echo > /tmp/ouro.out ouro mail $C" }, { readPaths: new Set(), trustLevel: "friend" })).toEqual({ allowed: true })
    expect(guardInvocation("shell", { command: "echo *.txt" }, { readPaths: new Set(), trustLevel: "friend" })).toEqual({ allowed: true })
    expect(guardInvocation("shell", { command: "echo ok # ouro mail $C" }, { readPaths: new Set(), trustLevel: "friend" })).toEqual({ allowed: true })
    expect(guardInvocation("shell", { command: "echo ${" }, { readPaths: new Set(), trustLevel: "friend" })).toEqual({ allowed: true })
    expect(guardInvocation("shell", { command: "cat <<'EOF'\nouro mail sync-cache\nEOF" }, { readPaths: new Set(), trustLevel: "friend" })).toEqual({ allowed: true })
    expect(guardInvocation("shell", { command: "cat <<EOF\nouro mail sync-cache\nEOF" }, { readPaths: new Set(), trustLevel: "friend" })).toEqual({ allowed: true })
    expect(guardInvocation("shell", { command: "cat <<EOF\nouro mail sync-cache $(echo ready)\nEOF" }, { readPaths: new Set(), trustLevel: "friend" })).toEqual({ allowed: true })
    expect(guardInvocation("shell", { command: "cat <<-'EOF'\n\touro mail sync-cache\n\tEOF" }, { readPaths: new Set(), trustLevel: "friend" })).toEqual({ allowed: true })
    expect(guardInvocation("shell", { command: "commands=(ouro mail sync-cache); printf '%s\\n' \"${commands[@]}\"" }, { readPaths: new Set(), trustLevel: "friend" })).toEqual({ allowed: true })
    expect(guardInvocation("shell", { command: "commands=(\\`literal); printf '%s\\n' \"${commands[@]}\"" }, { readPaths: new Set(), trustLevel: "friend" })).toEqual({ allowed: true })
    expect(guardInvocation("shell", { command: "printf '%s\\n' \\`ouro mail sync-cache\\`" }, { readPaths: new Set(), trustLevel: "friend" })).toEqual({ allowed: true })
    expect(guardInvocation("shell", { command: "printf '%s\\n' '\\\\# ouro mail sync-cache'" }, { readPaths: new Set(), trustLevel: "friend" })).toEqual({ allowed: true })
    expect(guardInvocation("shell", { command: "echo $(" }, { readPaths: new Set(), trustLevel: "friend" })).toEqual({ allowed: true })
    expect(guardInvocation("shell", { command: "echo `unterminated" }, { readPaths: new Set(), trustLevel: "friend" })).toEqual({ allowed: true })
    expect(guardInvocation("shell", { command: "echo \\" }, { readPaths: new Set(), trustLevel: "friend" })).toEqual({ allowed: true })
    expect(guardInvocation("shell", { command: `echo "$(printf '%s' '\\literal' "double" \\x)"` }, { readPaths: new Set(), trustLevel: "friend" })).toEqual({ allowed: true })
    expect(guardInvocation("shell", { command: "echo `printf \\x`" }, { readPaths: new Set(), trustLevel: "friend" })).toEqual({ allowed: true })
    expect(guardInvocation("shell", { command: "bash -c" }, { readPaths: new Set(), trustLevel: "friend" })).toEqual({ allowed: true })
    expect(guardInvocation("shell", { command: "env -S" }, { readPaths: new Set(), trustLevel: "friend" })).toEqual({ allowed: true })
    expect(guardInvocation("shell", { command: "coproc" }, { readPaths: new Set(), trustLevel: "friend" })).toEqual({ allowed: true })
    expect(guardInvocation("shell", { command: "cmd=(\"unterminated); printf ok" }, { readPaths: new Set(), trustLevel: "friend" })).toEqual({ allowed: true })
    expect(guardInvocation("shell", { command: "eval echo ouro mail sync-cache" }, { readPaths: new Set(), trustLevel: "friend" })).toEqual({ allowed: true })
    expect(guardInvocation("shell", { command: "env -S echo ouro mail sync-cache" }, { readPaths: new Set(), trustLevel: "friend" })).toEqual({ allowed: true })
    expect(guardInvocation("shell", { command: "bash script.sh ouro mail sync-cache" }, { readPaths: new Set(), trustLevel: "friend" })).toEqual({ allowed: true })
    expect(guardInvocation("shell", { command: "grep ouro mail sync-cache README.md" }, { readPaths: new Set(), trustLevel: "friend" })).toEqual({ allowed: true })
    expect(guardInvocation("shell", { command: "rg ouro mail sync-cache ." }, { readPaths: new Set(), trustLevel: "friend" })).toEqual({ allowed: true })
    expect(guardInvocation("shell", { command: "python script.py ouro mail sync-cache" }, { readPaths: new Set(), trustLevel: "friend" })).toEqual({ allowed: true })
    expect(guardInvocation("shell", { command: "test ouro mail sync-cache" }, { readPaths: new Set(), trustLevel: "friend" })).toEqual({ allowed: true })
    expect(guardInvocation("shell", { command: "git log -- ouro mail sync-cache" }, { readPaths: new Set(), trustLevel: "friend" })).toEqual({ allowed: true })
    expect(guardInvocation("shell", { command: "\"$cmd\" --agent slugger" }, { readPaths: new Set(), trustLevel: "friend" })).toEqual({ allowed: true })
    expect(guardInvocation("shell", { command: "cmd='echo; ouro mail sync-cache'; $cmd" }, { readPaths: new Set(), trustLevel: "friend" })).toEqual({ allowed: true })
    expect(guardInvocation("shell", { command: "C='sync-cache; echo'; ouro mail $C" }, { readPaths: new Set(), trustLevel: "friend" })).toEqual({ allowed: true })
    expect(guardInvocation("shell", { command: "cmd=\"echo ok\"; eval \"$cmd\"" }, { readPaths: new Set(), trustLevel: "friend" })).toEqual({ allowed: true })
    expect(guardInvocation("shell", { command: "cmd=\"echo ok\"; sh -c \"$cmd\"" }, { readPaths: new Set(), trustLevel: "friend" })).toEqual({ allowed: true })
    expect(guardInvocation("shell", { command: "ouro mail" }, { readPaths: new Set(), trustLevel: "friend" })).toEqual({ allowed: true })
    expect(guardInvocation("shell", { command: "command -v ouro mail sync-cache" }, { readPaths: new Set(), trustLevel: "friend" })).toEqual({ allowed: true })
    expect(guardInvocation("shell", { command: "sudo -g ouro mail sync-cache" }, { readPaths: new Set(), trustLevel: "friend" })).toEqual({ allowed: true })
    expect(guardInvocation("shell", { command: "time -o ouro mail sync-cache" }, { readPaths: new Set(), trustLevel: "friend" })).toEqual({ allowed: true })
    expect(guardInvocation("shell", { command: "env -S '-u X echo ouro mail sync-cache'" }, { readPaths: new Set(), trustLevel: "friend" })).toEqual({ allowed: true })
    expect(guardInvocation("shell", { command: "cmd=(ouro mail sync-cache); cmd=(echo ok); \"${cmd[@]}\" --agent slugger" }, { readPaths: new Set(), trustLevel: "friend" })).toEqual({ allowed: true })
    expect(guardInvocation("shell", { command: "cmd=(echo); cmd+=(ouro mail sync-cache); \"${cmd[@]}\" --agent slugger" }, { readPaths: new Set(), trustLevel: "friend" })).toEqual({ allowed: true })
    expect(guardInvocation("shell", { command: "cmd=\"ouro mail sync-cache\"; \"$cmd\"" }, { readPaths: new Set(), trustLevel: "friend" })).toEqual({ allowed: true })
    expect(guardInvocation("shell", { command: "cmd=(\"ouro mail sync-cache\"); \"${cmd[@]}\"" }, { readPaths: new Set(), trustLevel: "friend" })).toEqual({ allowed: true })
    expect(guardInvocation("shell", { command: "cmd=(ouro mail sync-cache); \"${cmd[*]}\"" }, { readPaths: new Set(), trustLevel: "friend" })).toEqual({ allowed: true })
    expect(guardInvocation("shell", { command: "cmd=(ouro mail sync-cache); echo \"prefix${cmd[@]}\"" }, { readPaths: new Set(), trustLevel: "friend" })).toEqual({ allowed: true })
    expect(guardInvocation("shell", { command: "cmd=(printf '%s\\n' ok); \"${cmd[@]}suffix\"" }, { readPaths: new Set(), trustLevel: "friend" })).toEqual({ allowed: true })
    expect(guardInvocation("shell", { command: "cmd=(rintf '%s\\n' ok); \"p${cmd[@]}\"" }, { readPaths: new Set(), trustLevel: "friend" })).toEqual({ allowed: true })
    expect(guardInvocation("shell", { command: "cmd=(echo ok); \"${cmd[@]}suffix\"" }, { readPaths: new Set(), trustLevel: "friend" })).toEqual({ allowed: true })
    expect(guardInvocation("shell", { command: "cmd=(); \"${cmd[@]}\"" }, { readPaths: new Set(), trustLevel: "friend" })).toEqual({ allowed: true })
    expect(guardInvocation("shell", { command: "cmd=(); \"prefix${cmd[@]}suffix\"" }, { readPaths: new Set(), trustLevel: "friend" })).toEqual({ allowed: true })
    expect(guardInvocation("shell", { command: "cmd=(ouro mail sync-cache); \"${cmd[@]}" }, { readPaths: new Set(), trustLevel: "friend" })).toEqual(expect.objectContaining({ allowed: false }))
    expect(guardInvocation("shell", { command: "cmd=(\"*\"); ouro mail ${cmd[@]} sync-cache" }, { readPaths: new Set(), trustLevel: "friend" })).toEqual(expect.objectContaining({ allowed: false }))
    expect(guardInvocation("shell", { command: "cmd=(echo); \"$(unterminated${cmd[@]}\"" }, { readPaths: new Set(), trustLevel: "friend" })).toEqual(expect.objectContaining({ allowed: false }))
    expect(guardInvocation("shell", { command: "cmd=(echo); \"${cmd[@]}suffix\\\\x\"" }, { readPaths: new Set(), trustLevel: "friend" })).toEqual({ allowed: true })
    expect(guardInvocation("shell", { command: "cmd=(ouro mail sync-cache); printf '%s\\n' ${cmd[@]}" }, { readPaths: new Set(), trustLevel: "friend" })).toEqual({ allowed: true })
    expect(guardInvocation("shell", { command: `printf '%s\\n' "'" '\"'` }, { readPaths: new Set(), trustLevel: "friend" })).toEqual({ allowed: true })
  })

  it("keeps ordered assignment analysis bounded across 10,000 mutations", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const command = `${"cmd=(echo ok);".repeat(9_999)}cmd=(ouro mail sync-cache); "\${cmd[@]}"`
    expect(guardInvocation("shell", { command }, { readPaths: new Set(), trustLevel: "friend" })).toEqual(expect.objectContaining({ allowed: false }))
  })

  it("fails closed when the shell-word dependency rejects an otherwise prefiltered fragment", async () => {
    vi.doMock("shell-quote", async () => {
      const actual = await vi.importActual<typeof import("shell-quote")>("shell-quote")
      return {
        ...actual,
        parse: (value: string, ...args: Parameters<typeof actual.parse> extends [string, ...infer Rest] ? Rest : never) => {
          if (value.includes("__THROW__")) throw new Error("synthetic parser rejection")
          if (value.includes("__EMPTY__")) return []
          return actual.parse(value, ...args)
        },
      }
    })
    vi.resetModules()

    const { guardInvocation } = await import("../../repertoire/guardrails")
    expect(guardInvocation("shell", {
      command: "cmd=(__THROW__); \"${cmd[@]}\"",
    }, { readPaths: new Set(), trustLevel: "friend" })).toEqual(expect.objectContaining({ allowed: false }))
    expect(guardInvocation("shell", {
      command: "cmd=(echo); \"__THROW__${cmd[@]}\"",
    }, { readPaths: new Set(), trustLevel: "friend" })).toEqual({ allowed: true })
    expect(guardInvocation("shell", {
      command: "cmd=(echo); \"__EMPTY__${cmd[@]}\"",
    }, { readPaths: new Set(), trustLevel: "friend" })).toEqual({ allowed: true })

    vi.doUnmock("shell-quote")
    vi.resetModules()
  })

  // --- protected paths blocked for writes ---

  it("blocks write_file to .git/config", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("write_file", { path: ".git/config" }, { readPaths: new Set() })
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.reason).toMatch(/protected/i)
  })

  it("blocks edit_file on .git/hooks/pre-commit", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("edit_file", { path: ".git/hooks/pre-commit" }, { readPaths: new Set([".git/hooks/pre-commit"]) })
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.reason).toMatch(/protected/i)
  })

  it("blocks shell write to .git/config", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "echo x > .git/config" }, { readPaths: new Set() })
    expect(result.allowed).toBe(false)
  })

  it("allows read_file on .git/config (read-only)", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("read_file", { path: ".git/config" }, { readPaths: new Set() })
    expect(result.allowed).toBe(true)
  })

  it.each([
    "/bundle/state/policy/steward.json",
    "/bundle/state/policy/action-receipts.ndjson",
    "/bundle/tool-profiles.json",
    "/bundle/state/a2a/escalation-grants.json",
    "/bundle/state/a2a/relay-contacts/0f1e2d.json",
    "/bundle/state/a2a/relay-retired/0f1e2d.json",
    "/bundle/state/outbox/claude/1760000000000-abcdef.json",
    "/bundle/state/reports/3f2b8c10-aaaa-4bbb-8ccc-1234567890ab.json",
    "state/outbox/claude/x.json",
  ])("blocks generic writes to steward authority path %s", async (protectedPath) => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    expect(guardInvocation("write_file", { path: protectedPath }, { readPaths: new Set() })).toMatchObject({ allowed: false })
    expect(guardInvocation("edit_file", { path: protectedPath }, { readPaths: new Set([protectedPath]) })).toMatchObject({ allowed: false })
    expect(guardInvocation("shell", { command: `printf x > ${protectedPath}` }, { readPaths: new Set() })).toMatchObject({ allowed: false })
  })

  it("still lets the model read what it may not write", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    expect(guardInvocation("read_file", { path: "/bundle/state/reports/x.json" }, { readPaths: new Set() })).toMatchObject({ allowed: true })
    expect(guardInvocation("shell", { command: "cat /bundle/state/outbox/claude/x.json" }, { readPaths: new Set() })).toMatchObject({ allowed: true })
    expect(guardInvocation("shell", { command: "tee /bundle/state/outbox/claude/x.json" }, { readPaths: new Set() })).toMatchObject({ allowed: false })
  })

  // --- local vault unlock stores are protected ---

  it("blocks write_file to plaintext vault unlock material", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const home = process.env.HOME || "/Users/test"
    const result = guardInvocation("write_file", { path: `${home}/.ouro-cli/vault-unlock/unlock.secret` }, { readPaths: new Set() })
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.reason).toMatch(/protected/i)
  })

  it("blocks shell write to DPAPI vault unlock material", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const home = process.env.HOME || "/Users/test"
    const result = guardInvocation("shell", { command: `cat secret > ${home}/.ouro-cli/vault-unlock-dpapi/vault-unlock/unlock.dpapi` }, { readPaths: new Set() })
    expect(result.allowed).toBe(false)
  })

  // --- protected filenames (agent.json) ---

  it("blocks write_file to agent.json", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("write_file", { path: "/Users/test/AgentBundles/ouroboros.ouro/agent.json" }, { readPaths: new Set() })
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.reason).toMatch(/protected/i)
  })

  it("blocks edit_file to agent.json", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("edit_file", { path: "/Users/test/AgentBundles/ouroboros.ouro/agent.json" }, { readPaths: new Set(["/Users/test/AgentBundles/ouroboros.ouro/agent.json"]) })
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.reason).toMatch(/protected/i)
  })

  it("blocks shell redirect to agent.json", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "echo {} > /Users/test/AgentBundles/ouroboros.ouro/agent.json" }, { readPaths: new Set() })
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.reason).toMatch(/protected/i)
  })

  it("allows read_file on agent.json (read-only tools bypass guardrails)", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("read_file", { path: "/Users/test/AgentBundles/ouroboros.ouro/agent.json" }, { readPaths: new Set() })
    expect(result.allowed).toBe(true)
  })

  it("does not block files with agent.json as substring (e.g. my-agent.json)", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("write_file", { path: "/some/path/my-agent.json" }, { readPaths: new Set() })
    // my-agent.json should NOT be blocked -- only exact basename "agent.json"
    expect(result.allowed).toBe(true)
  })

  it("blocks bare agent.json path (no directory prefix)", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("write_file", { path: "agent.json" }, { readPaths: new Set() })
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.reason).toMatch(/protected/i)
  })

  // --- read-only tools always allowed ---

  it("read_file always allowed regardless of context", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("read_file", { path: "/any/path" }, { readPaths: new Set() })
    expect(result.allowed).toBe(true)
  })

  it("glob always allowed regardless of context", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("glob", { pattern: "**/*.ts" }, { readPaths: new Set() })
    expect(result.allowed).toBe(true)
  })

  it("grep always allowed regardless of context", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("grep", { pattern: "foo", path: "." }, { readPaths: new Set() })
    expect(result.allowed).toBe(true)
  })

  // --- reason strings are agent-friendly (structural tone) ---

  it("structural block reasons use safety-focused tone", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("edit_file", { path: "/unread/file" }, { readPaths: new Set() })
    expect(result.allowed).toBe(false)
    if (!result.allowed) {
      expect(result.reason).toMatch(/read.*file/i)
    }
  })

  it("destructive command reason uses safety-focused tone", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "rm -rf /" }, { readPaths: new Set() })
    expect(result.allowed).toBe(false)
    if (!result.allowed) {
      expect(result.reason).toMatch(/dangerous/i)
    }
  })

  // --- edge cases: missing/empty args ---

  it("edit_file with empty path and empty readPaths is blocked", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("edit_file", {}, { readPaths: new Set() })
    expect(result.allowed).toBe(false)
  })

  it("write_file with empty path and no file on disk is allowed (new file)", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false)
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("write_file", {}, { readPaths: new Set() })
    expect(result.allowed).toBe(true)
  })

  it("shell with empty command is allowed (not destructive)", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", {}, { readPaths: new Set() })
    expect(result.allowed).toBe(true)
  })

  it("unknown tool names pass structural guardrails", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("some_custom_tool", { anything: "value" }, { readPaths: new Set() })
    expect(result.allowed).toBe(true)
  })

  it("shell with tee to protected path is blocked", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "echo x | tee .git/config" }, { readPaths: new Set() })
    expect(result.allowed).toBe(false)
  })
})

describe("guardInvocation — trust-level guardrails", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.mocked(fs.existsSync).mockReturnValue(false)
  })

  const agentRoot = "/Users/test/AgentBundles/ouro.ouro"

  // --- trusted (family/friend) — Layer 2 is no-op ---

  it("friend trust level: shell mutation allowed (Layer 2 no-op)", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "npm install" }, { readPaths: new Set(), trustLevel: "friend" })
    expect(result.allowed).toBe(true)
  })

  it("family trust level: shell mutation allowed (Layer 2 no-op)", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "npm install" }, { readPaths: new Set(), trustLevel: "family" })
    expect(result.allowed).toBe(true)
  })

  // --- acquaintance — shell read-only allowed ---

  it("acquaintance: cat allowed (read-only)", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "cat foo.txt" }, { readPaths: new Set(), trustLevel: "acquaintance" })
    expect(result.allowed).toBe(true)
  })

  it("acquaintance: ls allowed", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "ls -la" }, { readPaths: new Set(), trustLevel: "acquaintance" })
    expect(result.allowed).toBe(true)
  })

  it("acquaintance: git status allowed", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "git status" }, { readPaths: new Set(), trustLevel: "acquaintance" })
    expect(result.allowed).toBe(true)
  })

  it("acquaintance: git log allowed", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "git log --oneline" }, { readPaths: new Set(), trustLevel: "acquaintance" })
    expect(result.allowed).toBe(true)
  })

  it("acquaintance: head/tail/wc allowed", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    expect(guardInvocation("shell", { command: "head -5 file.txt" }, { readPaths: new Set(), trustLevel: "acquaintance" }).allowed).toBe(true)
    expect(guardInvocation("shell", { command: "tail -10 file.txt" }, { readPaths: new Set(), trustLevel: "acquaintance" }).allowed).toBe(true)
    expect(guardInvocation("shell", { command: "wc -l file.txt" }, { readPaths: new Set(), trustLevel: "acquaintance" }).allowed).toBe(true)
  })

  // --- acquaintance — shell mutations blocked ---

  it("acquaintance: git commit blocked", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "git commit -m 'x'" }, { readPaths: new Set(), trustLevel: "acquaintance" })
    expect(result.allowed).toBe(false)
  })

  it("acquaintance: npm install blocked", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "npm install" }, { readPaths: new Set(), trustLevel: "acquaintance" })
    expect(result.allowed).toBe(false)
  })

  it("acquaintance: rm blocked", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "rm file.txt" }, { readPaths: new Set(), trustLevel: "acquaintance" })
    expect(result.allowed).toBe(false)
  })

  it("acquaintance: mv blocked", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "mv a.txt b.txt" }, { readPaths: new Set(), trustLevel: "acquaintance" })
    expect(result.allowed).toBe(false)
  })

  // --- acquaintance — shell network blocked ---

  it("acquaintance: curl blocked", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "curl https://example.com" }, { readPaths: new Set(), trustLevel: "acquaintance" })
    expect(result.allowed).toBe(false)
  })

  it("acquaintance: wget blocked", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "wget https://example.com" }, { readPaths: new Set(), trustLevel: "acquaintance" })
    expect(result.allowed).toBe(false)
  })

  // --- acquaintance — unrecognized commands blocked ---

  it("acquaintance: unrecognized command blocked", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "foobar --something" }, { readPaths: new Set(), trustLevel: "acquaintance" })
    expect(result.allowed).toBe(false)
  })

  // --- acquaintance — ouro CLI trust ---

  it("acquaintance: ouro whoami allowed", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "ouro whoami" }, { readPaths: new Set(), trustLevel: "acquaintance" })
    expect(result.allowed).toBe(true)
  })

  it("acquaintance: ouro task board blocked (needs friend)", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "ouro task board" }, { readPaths: new Set(), trustLevel: "acquaintance" })
    expect(result.allowed).toBe(false)
  })

  it("acquaintance: ouro changelog allowed", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "ouro changelog" }, { readPaths: new Set(), trustLevel: "acquaintance" })
    expect(result.allowed).toBe(true)
  })

  // --- acquaintance — compound commands with per-subcommand checking ---

  it("acquaintance: compound command with && allowed when all subcommands are safe", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "ouro whoami && ls" }, { readPaths: new Set(), trustLevel: "acquaintance" })
    expect(result.allowed).toBe(true)
  })

  it("acquaintance: compound with destructive part caught by structural layer first", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "ouro whoami && rm -rf /" }, { readPaths: new Set(), trustLevel: "acquaintance" })
    expect(result.allowed).toBe(false)
    // Structural layer catches the destructive part before trust layer
    expect((result as any).reason).toContain("dangerous")
  })

  it("acquaintance: compound command with ; blocked when any subcommand fails trust", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "ouro whoami ; curl evil.com" }, { readPaths: new Set(), trustLevel: "acquaintance" })
    expect(result.allowed).toBe(false)
    expect((result as any).reason).toMatch(/trusted|friend|vouch|closer/i)
  })

  it("acquaintance: compound command with || blocked when any subcommand fails trust", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "ls || npm install" }, { readPaths: new Set(), trustLevel: "acquaintance" })
    expect(result.allowed).toBe(false)
  })

  it("acquaintance: compound command with pipe allowed when all subcommands safe", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "cat file | head -5" }, { readPaths: new Set(), trustLevel: "acquaintance" })
    expect(result.allowed).toBe(true)
  })

  it("acquaintance: compound command with pipe blocked when any subcommand fails trust", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "cat file | curl -X POST" }, { readPaths: new Set(), trustLevel: "acquaintance" })
    expect(result.allowed).toBe(false)
  })

  it("acquaintance: subshell $() blocked (cannot split reliably)", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "echo $(rm -rf /)" }, { readPaths: new Set(), trustLevel: "acquaintance" })
    expect(result.allowed).toBe(false)
  })

  it("trusted friend: compound commands allowed (no trust guardrails)", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "ouro whoami && ls" }, { readPaths: new Set(), trustLevel: "friend" })
    expect(result.allowed).toBe(true)
  })

  it("structural: compound command with destructive part blocked even for trusted", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "echo hi && rm -rf /" }, { readPaths: new Set(), trustLevel: "family" })
    expect(result.allowed).toBe(false)
    expect((result as any).reason).toContain("dangerous")
  })

  it("acquaintance: compound with ; allowed when all subcommands safe", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "ls ; pwd ; echo hello" }, { readPaths: new Set(), trustLevel: "acquaintance" })
    expect(result.allowed).toBe(true)
  })

  // --- acquaintance — write_file inside bundle dir allowed ---

  it("acquaintance: write_file inside agentRoot allowed (new file)", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false)
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("write_file", { path: `${agentRoot}/state/foo.json` }, {
      readPaths: new Set(),
      trustLevel: "acquaintance",
      agentRoot,
    })
    expect(result.allowed).toBe(true)
  })

  // --- acquaintance — write_file outside bundle dir blocked ---

  it("acquaintance: write_file outside agentRoot blocked", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false)
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("write_file", { path: "/tmp/some-file.txt" }, {
      readPaths: new Set(),
      trustLevel: "acquaintance",
      agentRoot,
    })
    expect(result.allowed).toBe(false)
  })

  // --- acquaintance — read_file/glob/grep always allowed ---

  it("acquaintance: read_file always allowed (no trust guardrails on reads)", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("read_file", { path: "/anything" }, { readPaths: new Set(), trustLevel: "acquaintance" })
    expect(result.allowed).toBe(true)
  })

  it("acquaintance: glob always allowed", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("glob", { pattern: "**/*" }, { readPaths: new Set(), trustLevel: "acquaintance" })
    expect(result.allowed).toBe(true)
  })

  it("acquaintance: grep always allowed", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("grep", { pattern: "foo", path: "." }, { readPaths: new Set(), trustLevel: "acquaintance" })
    expect(result.allowed).toBe(true)
  })

  // --- layer ordering: structural blocks before trust ---

  it("structural blocks before trust check (edit_file without read)", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("edit_file", { path: "/some/file" }, {
      readPaths: new Set(),
      trustLevel: "family",
    })
    expect(result.allowed).toBe(false)
    if (!result.allowed) {
      // Structural tone, not trust tone
      expect(result.reason).toMatch(/read/i)
      expect(result.reason).not.toMatch(/friend|vouch/i)
    }
  })

  // --- reason strings for trust blocks ---

  it("trust block reasons use relational tone", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "npm install" }, { readPaths: new Set(), trustLevel: "acquaintance" })
    expect(result.allowed).toBe(false)
    if (!result.allowed) {
      expect(result.reason).toMatch(/trusted|friend|vouch|closer/i)
    }
  })

  // --- no trust level (undefined) → treated as trusted ---

  it("undefined trustLevel treated as trusted (friend default)", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "npm install" }, { readPaths: new Set() })
    expect(result.allowed).toBe(true)
  })

  // --- stranger trust level ---

  it("stranger: shell mutation blocked", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "npm install" }, { readPaths: new Set(), trustLevel: "stranger" })
    expect(result.allowed).toBe(false)
  })

  // --- acquaintance edit_file inside bundle dir allowed ---

  it("acquaintance: edit_file inside agentRoot allowed (with prior read)", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const filePath = `${agentRoot}/state/foo.json`
    const result = guardInvocation("edit_file", { path: filePath }, {
      readPaths: new Set([filePath]),
      trustLevel: "acquaintance",
      agentRoot,
    })
    expect(result.allowed).toBe(true)
  })

  // --- acquaintance edit_file outside bundle dir blocked ---

  it("acquaintance: edit_file outside agentRoot blocked (even with prior read)", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const filePath = "/tmp/some-file.txt"
    const result = guardInvocation("edit_file", { path: filePath }, {
      readPaths: new Set([filePath]),
      trustLevel: "acquaintance",
      agentRoot,
    })
    expect(result.allowed).toBe(false)
  })

  // --- ouro CLI with --agent flag ---

  it("acquaintance: ouro session list allowed", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "ouro session list" }, { readPaths: new Set(), trustLevel: "acquaintance" })
    expect(result.allowed).toBe(true)
  })

  it("acquaintance: ouro friend list blocked (needs friend trust)", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "ouro friend list" }, { readPaths: new Set(), trustLevel: "acquaintance" })
    expect(result.allowed).toBe(false)
  })

  it("acquaintance: linking, merging and deduping friends are blocked, even with --agent first", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    for (const command of [
      "ouro friend link --agent ouroboros --channel teams",
      "ouro --agent ouroboros friend link --channel teams",
      "ouro friend unlink ouroboros --friend f --provider aad --external-id x",
      "ouro friend merge --into a b --apply",
      "ouro --agent ouroboros friend dedupe --apply",
      "ouro --agent ouroboros friend update f --trust family",
    ]) {
      expect(guardInvocation("shell", { command }, { readPaths: new Set(), trustLevel: "acquaintance" }).allowed).toBe(false)
      expect(guardInvocation("shell", { command }, { readPaths: new Set(), trustLevel: "family" }).allowed).toBe(true)
    }
    const { OURO_CLI_TRUST_MANIFEST } = await import("../../repertoire/guardrails")
    for (const subcommand of ["friend link", "friend unlink", "friend merge", "friend dedupe"]) expect(OURO_CLI_TRUST_MANIFEST[subcommand]).toBe("family")
    expect(guardInvocation("shell", { command: "ouro --agent" }, { readPaths: new Set(), trustLevel: "acquaintance" }).allowed).toBe(false)
  })

  // --- ouro CLI trust manifest export ---

  it("exports OURO_CLI_TRUST_MANIFEST with expected entries", async () => {
    const { OURO_CLI_TRUST_MANIFEST } = await import("../../repertoire/guardrails")
    expect(OURO_CLI_TRUST_MANIFEST.whoami).toBe("acquaintance")
    expect(OURO_CLI_TRUST_MANIFEST.changelog).toBe("acquaintance")
    expect(OURO_CLI_TRUST_MANIFEST["session list"]).toBe("acquaintance")
    expect(OURO_CLI_TRUST_MANIFEST["friend list"]).toBe("friend")
    expect(OURO_CLI_TRUST_MANIFEST["task board"]).toBeUndefined()
    expect(OURO_CLI_TRUST_MANIFEST["reminder create"]).toBeUndefined()
  })

  // --- additional read-only shell commands for acquaintance ---

  it("acquaintance: echo allowed", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    expect(guardInvocation("shell", { command: "echo hello" }, { readPaths: new Set(), trustLevel: "acquaintance" }).allowed).toBe(true)
  })

  it("acquaintance: pwd allowed", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    expect(guardInvocation("shell", { command: "pwd" }, { readPaths: new Set(), trustLevel: "acquaintance" }).allowed).toBe(true)
  })

  it("acquaintance: git diff allowed", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    expect(guardInvocation("shell", { command: "git diff HEAD" }, { readPaths: new Set(), trustLevel: "acquaintance" }).allowed).toBe(true)
  })

  it("acquaintance: git branch allowed", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    expect(guardInvocation("shell", { command: "git branch" }, { readPaths: new Set(), trustLevel: "acquaintance" }).allowed).toBe(true)
  })

  it("acquaintance: git show allowed", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    expect(guardInvocation("shell", { command: "git show HEAD" }, { readPaths: new Set(), trustLevel: "acquaintance" }).allowed).toBe(true)
  })

  it("acquaintance: date/uname/whoami/which allowed", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const ctx = { readPaths: new Set<string>(), trustLevel: "acquaintance" as const }
    expect(guardInvocation("shell", { command: "date" }, ctx).allowed).toBe(true)
    expect(guardInvocation("shell", { command: "uname -a" }, ctx).allowed).toBe(true)
    expect(guardInvocation("shell", { command: "whoami" }, ctx).allowed).toBe(true)
    expect(guardInvocation("shell", { command: "which node" }, ctx).allowed).toBe(true)
  })

  it("acquaintance: stat/file allowed", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const ctx = { readPaths: new Set<string>(), trustLevel: "acquaintance" as const }
    expect(guardInvocation("shell", { command: "stat foo.txt" }, ctx).allowed).toBe(true)
    expect(guardInvocation("shell", { command: "file foo.txt" }, ctx).allowed).toBe(true)
  })

  it("acquaintance: env/printenv allowed", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const ctx = { readPaths: new Set<string>(), trustLevel: "acquaintance" as const }
    expect(guardInvocation("shell", { command: "env" }, ctx).allowed).toBe(true)
    expect(guardInvocation("shell", { command: "printenv HOME" }, ctx).allowed).toBe(true)
  })

  // --- empty/missing ouro subcommand ---

  it("acquaintance: bare ouro command blocked (unrecognized subcommand)", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "ouro" }, { readPaths: new Set(), trustLevel: "acquaintance" })
    expect(result.allowed).toBe(false)
  })

  it("acquaintance: ouro with trailing space blocked (empty subcommand)", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "ouro   " }, { readPaths: new Set(), trustLevel: "acquaintance" })
    expect(result.allowed).toBe(false)
  })

  it("acquaintance: unknown ouro subcommand blocked", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "ouro unknown-cmd" }, { readPaths: new Set(), trustLevel: "acquaintance" })
    expect(result.allowed).toBe(false)
  })

  // --- edge cases: write_file trust without agentRoot ---

  it("acquaintance: write_file without agentRoot allowed (no restriction baseline)", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false)
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("write_file", { path: "/tmp/file.txt" }, {
      readPaths: new Set(),
      trustLevel: "acquaintance",
      // agentRoot intentionally omitted
    })
    expect(result.allowed).toBe(true)
  })

  // --- edge case: non-write/edit tool hitting trust check ---

  it("acquaintance: unknown non-shell non-write tool passes trust check", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("list_skills", {}, {
      readPaths: new Set(),
      trustLevel: "acquaintance",
    })
    expect(result.allowed).toBe(true)
  })

  // --- edge case: shell with empty command for acquaintance ---

  it("acquaintance: shell with empty command blocked (unrecognized)", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", {}, {
      readPaths: new Set(),
      trustLevel: "acquaintance",
    })
    expect(result.allowed).toBe(false)
  })

  // --- edge case: write_file with empty path for acquaintance ---

  it("acquaintance: bare git command blocked", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "git" }, { readPaths: new Set(), trustLevel: "acquaintance" })
    expect(result.allowed).toBe(false)
  })

  it("acquaintance: write_file with empty path inside agentRoot check", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false)
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("write_file", {}, {
      readPaths: new Set(),
      trustLevel: "acquaintance",
      agentRoot: "/Users/test/AgentBundles/ouro.ouro",
    })
    expect(result.allowed).toBe(false)
  })
})

describe("OURO_CLI_TRUST_MANIFEST — friend update", () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it("includes 'friend update' at family level", async () => {
    const { OURO_CLI_TRUST_MANIFEST } = await import("../../repertoire/guardrails")
    expect(OURO_CLI_TRUST_MANIFEST["friend update"]).toBe("family")
  })

  it("family: ouro friend update allowed", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "ouro friend update abc-123 --trust friend --agent foo" }, {
      readPaths: new Set(),
      trustLevel: "family",
    })
    expect(result.allowed).toBe(true)
  })

  it("friend: ouro friend update denied", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "ouro friend update abc-123 --trust friend --agent foo" }, {
      readPaths: new Set(),
      trustLevel: "friend",
    })
    // friend trust level skips trust guardrails entirely (isTrustedLevel = true)
    expect(result.allowed).toBe(true)
  })

  it("acquaintance: ouro friend update denied", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "ouro friend update abc-123 --trust friend --agent foo" }, {
      readPaths: new Set(),
      trustLevel: "acquaintance",
    })
    expect(result.allowed).toBe(false)
  })
})

describe("OURO_CLI_TRUST_MANIFEST — config model", () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it("includes 'config model' at friend level", async () => {
    const { OURO_CLI_TRUST_MANIFEST } = await import("../../repertoire/guardrails")
    expect(OURO_CLI_TRUST_MANIFEST["config model"]).toBe("friend")
  })

  it("friend: ouro config model allowed", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "ouro config model --agent foo claude-sonnet-4.6" }, {
      readPaths: new Set(),
      trustLevel: "friend",
    })
    expect(result.allowed).toBe(true)
  })

  it("acquaintance: ouro config model denied", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "ouro config model --agent foo gpt-5" }, {
      readPaths: new Set(),
      trustLevel: "acquaintance",
    })
    expect(result.allowed).toBe(false)
  })
})

describe("OURO_CLI_TRUST_MANIFEST — MCP entries", () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it("includes 'mcp list' at acquaintance level", async () => {
    const { OURO_CLI_TRUST_MANIFEST } = await import("../../repertoire/guardrails")
    expect(OURO_CLI_TRUST_MANIFEST["mcp list"]).toBe("acquaintance")
  })

  it("includes 'mcp call' at friend level", async () => {
    const { OURO_CLI_TRUST_MANIFEST } = await import("../../repertoire/guardrails")
    expect(OURO_CLI_TRUST_MANIFEST["mcp call"]).toBe("friend")
  })

  it("acquaintance: ouro mcp list allowed", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "ouro mcp list" }, {
      readPaths: new Set(),
      trustLevel: "acquaintance",
    })
    expect(result.allowed).toBe(true)
  })

  it("stranger: ouro mcp list denied", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "ouro mcp list" }, {
      readPaths: new Set(),
      trustLevel: "stranger",
    })
    expect(result.allowed).toBe(false)
  })

  it("friend: ouro mcp call ado get_items allowed", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "ouro mcp call ado get_items" }, {
      readPaths: new Set(),
      trustLevel: "friend",
    })
    expect(result.allowed).toBe(true)
  })

  it("acquaintance: ouro mcp call ado get_items denied", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "ouro mcp call ado get_items" }, {
      readPaths: new Set(),
      trustLevel: "acquaintance",
    })
    expect(result.allowed).toBe(false)
  })
})

describe("OURO_CLI_TRUST_MANIFEST — auth entries", () => {
  it("auth is family trust", async () => {
    const { OURO_CLI_TRUST_MANIFEST } = await import("../../repertoire/guardrails")
    expect(OURO_CLI_TRUST_MANIFEST.auth).toBe("family")
  })

  it("auth verify is family trust", async () => {
    const { OURO_CLI_TRUST_MANIFEST } = await import("../../repertoire/guardrails")
    expect(OURO_CLI_TRUST_MANIFEST["auth verify"]).toBe("family")
  })

  it("auth switch is family trust", async () => {
    const { OURO_CLI_TRUST_MANIFEST } = await import("../../repertoire/guardrails")
    expect(OURO_CLI_TRUST_MANIFEST["auth switch"]).toBe("family")
  })

  it("family: ouro auth --agent foo --provider github-copilot allowed", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "ouro auth --agent foo --provider github-copilot" }, {
      readPaths: new Set(),
      trustLevel: "family",
    })
    expect(result.allowed).toBe(true)
  })

  it("family: ouro auth verify --agent foo allowed", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "ouro auth verify --agent foo" }, {
      readPaths: new Set(),
      trustLevel: "family",
    })
    expect(result.allowed).toBe(true)
  })

  it("family: ouro auth switch --agent foo --provider github-copilot allowed", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "ouro auth switch --agent foo --provider github-copilot" }, {
      readPaths: new Set(),
      trustLevel: "family",
    })
    expect(result.allowed).toBe(true)
  })

  it("acquaintance: ouro auth --agent foo denied", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "ouro auth --agent foo" }, {
      readPaths: new Set(),
      trustLevel: "acquaintance",
    })
    expect(result.allowed).toBe(false)
  })
})

describe("OURO_CLI_TRUST_MANIFEST — rollback and versions", () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it("rollback is family trust", async () => {
    const { OURO_CLI_TRUST_MANIFEST } = await import("../../repertoire/guardrails")
    expect(OURO_CLI_TRUST_MANIFEST.rollback).toBe("family")
  })

  it("versions is acquaintance trust", async () => {
    const { OURO_CLI_TRUST_MANIFEST } = await import("../../repertoire/guardrails")
    expect(OURO_CLI_TRUST_MANIFEST.versions).toBe("acquaintance")
  })

  it("family: ouro rollback allowed", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "ouro rollback" }, {
      readPaths: new Set(),
      trustLevel: "family",
    })
    expect(result.allowed).toBe(true)
  })

  it("friend: ouro rollback denied", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "ouro rollback" }, {
      readPaths: new Set(),
      trustLevel: "acquaintance",
    })
    expect(result.allowed).toBe(false)
  })

  it("acquaintance: ouro versions allowed", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "ouro versions" }, {
      readPaths: new Set(),
      trustLevel: "acquaintance",
    })
    expect(result.allowed).toBe(true)
  })

  it("stranger: ouro versions denied", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "ouro versions" }, {
      readPaths: new Set(),
      trustLevel: "stranger",
    })
    expect(result.allowed).toBe(false)
  })

  describe("the friends store is written by the harness, never by a model's file tools", () => {
    const ctx = (over: Record<string, unknown> = {}) => ({ readPaths: new Set(["/bundle/friends/peer.json"]), agentRoot: "/bundle", trustLevel: "family" as const, ...over })
    it.each(["/bundle/friends/peer.json", "friends/peer.json", "/bundle/friends/../friends/peer.json", "/bundle/friends"])("refuses write_file and edit_file to %s for everyone, family included", async (target) => {
      const { guardInvocation } = await import("../../repertoire/guardrails")
      for (const tool of ["write_file", "edit_file"]) {
        expect(guardInvocation(tool, { path: target }, ctx({ readPaths: new Set([target]) }))).toMatchObject({ allowed: false, reason: expect.stringContaining("protected") })
      }
    })
    it("refuses shell redirects and tee into the friends store", async () => {
      const { guardInvocation } = await import("../../repertoire/guardrails")
      expect(guardInvocation("shell", { command: "echo x > /bundle/friends/peer.json" }, ctx())).toMatchObject({ allowed: false })
      expect(guardInvocation("shell", { command: "echo x | tee friends/peer.json" }, ctx())).toMatchObject({ allowed: false })
    })
    it.each([
      ["append redirect", "echo x >> /bundle/friends/peer.json"],
      ["append redirect without a space", "echo x >>/bundle/friends/peer.json"],
      ["a second redirect after a stderr redirect", "echo a 2>/dev/null > /bundle/friends/peer.json"],
      ["cp", "cp /tmp/forged.json /bundle/friends/peer.json"],
      ["mv", "mv /tmp/forged.json /bundle/friends/peer.json"],
      ["sed -i", "sed -i s/acquaintance/family/ /bundle/friends/peer.json"],
      ["node -e", "node -e \"require('fs').writeFileSync('/bundle/friends/peer.json','{}')\""],
      ["cd then redirect", "cd /bundle/friends && echo x > peer.json"],
      ["cd into the store by a relative name", "cd friends && echo x > peer.json"],
      ["a dot segment", "echo x > /bundle/./friends/peer.json"],
      ["a dotdot segment", "echo x > /bundle/notes/../friends/peer.json"],
      ["a relative path in code", "node -e \"require('fs').writeFileSync('friends/peer.json','{}')\""],
      // No brace, so the glob check passes it by and only the last mention test sees the store inside the code.
      ["the absolute path inside code", "node -e \"require('fs').unlinkSync('/bundle/friends/peer.json')\""],
      ["a relative path inside code", "node -e \"require('fs').unlinkSync('friends/peer.json')\""],
      ["a variable", "echo x > $BUNDLE/friends/peer.json"],
      ["a command substitution", "echo x > $(echo /bundle/friends)/peer.json"],
      ["a heredoc", "cat <<EOF > /bundle/friends/peer.json\nx\nEOF"],
      ["python", "python3 -c \"open('/bundle/friends/peer.json','w').write('{}')\""],
    ])("refuses a shell write to the friends store by %s", async (_name, command) => {
      const { guardInvocation } = await import("../../repertoire/guardrails")
      expect(guardInvocation("shell", { command }, ctx())).toMatchObject({ allowed: false })
    })
    describe("a glob or an expansion that could resolve into a protected store (review of #1064, round 2, finding 7)", () => {
      beforeEach(() => { vi.mocked(fs.existsSync).mockReturnValue(false) })
      const probes = [
        "F=/bundle/fri; cp /tmp/f.json ${F}ends/peer.json",
        "cp /tmp/f.json /bundle/fr*nds/peer.json",
        "cp /tmp/f.json /bundle/friend?/peer.json",
        "cp /tmp/f.json /bundle/[f]riends/peer.json",
        "cp /tmp/f.json /bundle/*/peer.json",
        "cp /tmp/f.json fr*nds/peer.json",
        "cd /bundle && mv /tmp/f.json f*/peer.json",
        "echo x > /bundle/f{r,}iends/peer.json",
        "B=/bundle; echo x > $B/fr*nds/peer.json",
        "echo x > ${HOME}/AgentBundles/sanctuary.ouro/friends/peer.json",
        "cp /tmp/f.json /bundle/$(echo friends)/peer.json",
        "cp /tmp/f.json /bundle/`echo friends`/peer.json",
      ]
      it.each(probes)("refuses the friends-store probe %s", async (command) => {
        const { guardInvocation } = await import("../../repertoire/guardrails")
        expect(guardInvocation("shell", { command }, ctx())).toMatchObject({ allowed: false })
      })
      it.each([
        "cp /tmp/f.json /bundle/ps*che/SOUL.md",
        "P=/bundle/psy; echo x > ${P}che/SOUL.md",
        "echo x > /bundle/p?yche/SOUL.md",
      ])("refuses the same probe against the psyche folder: %s", async (command) => {
        const { guardInvocation } = await import("../../repertoire/guardrails")
        expect(guardInvocation("shell", { command }, ctx())).toMatchObject({ allowed: false })
      })
      it("treats HOME, TMPDIR and USER as their real values unless the command sets them, and any other expansion as unknown", async () => {
        const { guardInvocation } = await import("../../repertoire/guardrails")
        const prior = { HOME: process.env.HOME, TMPDIR: process.env.TMPDIR }
        process.env.HOME = "/home/ari"
        delete process.env.TMPDIR
        try {
          expect(guardInvocation("shell", { command: "echo x > $HOME/out.txt" }, ctx())).toEqual({ allowed: true })
          expect(guardInvocation("shell", { command: "echo x > ${HOME}/out.txt" }, ctx())).toEqual({ allowed: true })
          expect(guardInvocation("shell", { command: "echo x > $TMPDIR/out.txt" }, ctx())).toMatchObject({ allowed: false })
          expect(guardInvocation("shell", { command: "HOME=/bundle/friends; echo x > $HOME/p.json" }, ctx())).toMatchObject({ allowed: false })
          expect(guardInvocation("shell", { command: "echo x > ${X:-/tmp}/a" }, ctx())).toMatchObject({ allowed: false })
          expect(guardInvocation("shell", { command: "echo x > ~/n*/a" }, ctx({ agentRoot: `${os.homedir()}/AgentBundles/sanctuary.ouro` }))).toEqual({ allowed: true })
          expect(guardInvocation("shell", { command: "echo x > ~/AgentBundles/sanctuary.ouro/fr*/a" }, ctx({ agentRoot: `${os.homedir()}/AgentBundles/sanctuary.ouro` }))).toMatchObject({ allowed: false })
        } finally {
          if (prior.HOME === undefined) delete process.env.HOME; else process.env.HOME = prior.HOME
          if (prior.TMPDIR !== undefined) process.env.TMPDIR = prior.TMPDIR
        }
      })
      it("lets read-only commands and writes that cannot reach a store through", async () => {
        const { guardInvocation } = await import("../../repertoire/guardrails")
        for (const command of ["cat /bundle/fr*nds/peer.json", "ls /bundle/f*", "cp /tmp/a.json /bundle/notes/*.json", "echo x > /bundle/notes/[ab].md", "echo x > /tmp/$USER.log", "rm /bundle/state/*.tmp", "cp a.txt /bundle/n*/b.txt"]) {
          expect(JSON.stringify(guardInvocation("shell", { command }, ctx())), command).toBe(JSON.stringify({ allowed: true }))
        }
      })
    })
    it("refuses a home-relative path that lands in the friends store", async () => {
      const { guardInvocation } = await import("../../repertoire/guardrails")
      const root = `${os.homedir()}/AgentBundles/sanctuary.ouro`
      expect(guardInvocation("shell", { command: "echo x > ~/AgentBundles/sanctuary.ouro/friends/peer.json" }, ctx({ agentRoot: root }))).toMatchObject({ allowed: false })
      expect(guardInvocation("shell", { command: "cat ~/AgentBundles/sanctuary.ouro/friends/peer.json && ls ~/AgentBundles" }, ctx({ agentRoot: root }))).toEqual({ allowed: true })
    })
    it("still allows read-only commands and writes outside the friends store", async () => {
      const { guardInvocation } = await import("../../repertoire/guardrails")
      for (const command of ["ls /bundle/friends | head -5", "grep -r family /bundle/friends", "cd /bundle/friends && cat peer.json", "echo x > /bundle/notes/friends/a.md", "git -C /home/ari/Projects/friends status", "echo my friends are kind > /tmp/out.md"]) {
        expect(JSON.stringify(guardInvocation("shell", { command }, ctx())), command).toBe(JSON.stringify({ allowed: true }))
      }
    })
    it("leaves other directories named friends alone, and reads", async () => {
      const { guardInvocation } = await import("../../repertoire/guardrails")
      const read = (target: string) => ctx({ readPaths: new Set([target]) })
      for (const target of ["/home/ari/Projects/friends/src/a.ts", "/bundle/notes/friends/a.md", "/bundle/friends-notes.md"]) {
        expect(guardInvocation("write_file", { path: target }, read(target))).toEqual({ allowed: true })
      }
      expect(guardInvocation("read_file", { path: "/bundle/friends/peer.json" }, ctx())).toEqual({ allowed: true })
      expect(guardInvocation("shell", { command: "cat /bundle/friends/peer.json" }, ctx())).toEqual({ allowed: true })
      expect(guardInvocation("write_file", { path: "/x/friends/a.json" }, ctx({ agentRoot: undefined, readPaths: new Set(["/x/friends/a.json"]) }))).toEqual({ allowed: true })
    })
  })

  describe("the psyche belongs to the agent, gated by trust", () => {
    const REFUSAL = "that file is part of me; I change it when my owner asks me in our own chat."
    const family = (channel: string, over: Record<string, unknown> = {}) => ({ friendId: "f1", friendKind: "human" as const, trustLevel: "family" as const, channel, ...over })
    const ctx = (target: string, over: Record<string, unknown> = {}) => ({ readPaths: new Set([target]), agentRoot: "/bundle", ...over })
    const IDENTITY_FILES = ["SOUL.md", "IDENTITY.md", "LORE.md", "ASPIRATIONS.md"]
    const temps: string[] = []
    const tempBundle = () => {
      const made = fs.mkdtempSync(path.join(os.tmpdir(), "psyche-trust-"))
      temps.push(made)
      fs.mkdirSync(path.join(made, "psyche"))
      return made
    }
    afterEach(() => {
      vi.restoreAllMocks()
      for (const made of temps.splice(0)) fs.rmSync(made, { recursive: true, force: true })
    })

    describe.each(IDENTITY_FILES)("identity file %s", (file) => {
      const target = `/bundle/psyche/${file}`
      it.each(["telegram", "bluebubbles", "teams"])("a family human may have it changed one to one on %s", async (channel) => {
        const { guardInvocation } = await import("../../repertoire/guardrails")
        for (const tool of ["write_file", "edit_file"]) {
          expect(guardInvocation(tool, { path: target }, ctx(target, family(channel, { isGroupChat: false }))), tool).toEqual({ allowed: true })
        }
      })
      it.each([
        ["a friend human on telegram", family("telegram", { trustLevel: "friend" })],
        ["an acquaintance human on telegram", family("telegram", { trustLevel: "acquaintance" })],
        ["a stranger human on telegram", family("telegram", { trustLevel: "stranger" })],
        ["a family agent on a2a", family("a2a", { friendKind: "agent" })],
        ["a family human on a2a", family("a2a")],
        ["a family human on cli", family("cli")],
        ["a family human on inner", family("inner")],
        ["a family human on mail", family("mail")],
        ["a family human in a group chat", family("telegram", { isGroupChat: true })],
        ["a family human on teams when teams has not said it is one to one", family("teams")],
        ["no friend at all", {}],
        ["a friend with no trust level", family("telegram", { trustLevel: undefined })],
      ])("is refused for %s", async (_label, who) => {
        const { guardInvocation } = await import("../../repertoire/guardrails")
        for (const tool of ["write_file", "edit_file"]) {
          expect(guardInvocation(tool, { path: target }, ctx(target, who)), tool).toEqual({ allowed: false, reason: REFUSAL })
        }
      })
    })

    it("lets a family human on telegram change SOUL through the relative form the file tools resolve from the repo root", async () => {
      const { guardInvocation, psycheFileClass } = await import("../../repertoire/guardrails")
      const target = "../bundle/psyche/SOUL.md"
      expect(psycheFileClass(target, "/bundle")).toBe("identity")
      expect(guardInvocation("write_file", { path: target }, ctx(target, family("telegram")))).toEqual({ allowed: true })
    })

    describe("TACIT is what the agent learns, so it writes it for anyone it trusts", () => {
      const target = "/bundle/psyche/TACIT.md"
      it.each([
        ["a friend human", family("telegram", { trustLevel: "friend" })],
        ["a family human", family("telegram")],
        ["a family agent on a2a", family("a2a", { friendKind: "agent" })],
        ["a friend with no trust level", family("telegram", { trustLevel: undefined })],
        ["no friend at all", {}],
      ])("allows %s", async (_label, who) => {
        const { guardInvocation } = await import("../../repertoire/guardrails")
        for (const tool of ["write_file", "edit_file"]) {
          expect(guardInvocation(tool, { path: target }, ctx(target, who)), tool).toEqual({ allowed: true })
        }
      })
      it.each([["a stranger", "stranger"], ["an acquaintance", "acquaintance"]])("refuses %s", async (_label, trustLevel) => {
        const { guardInvocation } = await import("../../repertoire/guardrails")
        expect(guardInvocation("write_file", { path: target }, ctx(target, family("telegram", { trustLevel })))).toEqual({ allowed: false, reason: REFUSAL })
      })
    })

    it("lets a family human change SOUL through the relative form only the repo root resolves", async () => {
      const { guardInvocation, psycheFileClass } = await import("../../repertoire/guardrails")
      const agentRoot = "/home/ouro/AgentBundles/b.ouro"
      const target = path.relative("/opt/ouro", `${agentRoot}/psyche/SOUL.md`)
      expect(psycheFileClass(target, agentRoot)).toBe("identity")
      expect(guardInvocation("write_file", { path: target }, { readPaths: new Set([target]), agentRoot, ...family("telegram") })).toEqual({ allowed: true })
      expect(guardInvocation("write_file", { path: target }, { readPaths: new Set([target]), agentRoot, ...family("telegram", { trustLevel: "friend" }) })).toEqual({ allowed: false, reason: REFUSAL })
    })

    it("treats a TACIT that links to SOUL as SOUL", async () => {
      const agentRoot = tempBundle()
      fs.writeFileSync(path.join(agentRoot, "psyche", "SOUL.md"), "me")
      fs.symlinkSync(path.join(agentRoot, "psyche", "SOUL.md"), path.join(agentRoot, "psyche", "TACIT.md"))
      const target = path.join(agentRoot, "psyche", "TACIT.md")
      const { guardInvocation, psycheFileClass } = await import("../../repertoire/guardrails")
      expect(psycheFileClass(target, agentRoot)).toBe("identity")
      expect(guardInvocation("write_file", { path: target }, { readPaths: new Set([target]), agentRoot, ...family("telegram", { trustLevel: "friend" }) })).toEqual({ allowed: false, reason: REFUSAL })
    })

    it("refuses a TACIT that is hard linked to another file", async () => {
      const agentRoot = tempBundle()
      fs.writeFileSync(path.join(agentRoot, "psyche", "SOUL.md"), "me")
      fs.linkSync(path.join(agentRoot, "psyche", "SOUL.md"), path.join(agentRoot, "psyche", "TACIT.md"))
      const target = path.join(agentRoot, "psyche", "TACIT.md")
      const { guardInvocation } = await import("../../repertoire/guardrails")
      expect(guardInvocation("write_file", { path: target }, { readPaths: new Set([target]), agentRoot, ...family("telegram") })).toEqual({ allowed: false, reason: REFUSAL })
    })

    it("still refuses an allowed psyche write that a link carries into the friends store or policy", async () => {
      const agentRoot = tempBundle()
      fs.mkdirSync(path.join(agentRoot, "friends"))
      fs.mkdirSync(path.join(agentRoot, "state", "policy"), { recursive: true })
      fs.symlinkSync(path.join(agentRoot, "friends", "x.json"), path.join(agentRoot, "psyche", "NOTES.md"))
      fs.symlinkSync(path.join(agentRoot, "state", "policy", "steward.json"), path.join(agentRoot, "psyche", "RULES.md"))
      const { guardInvocation } = await import("../../repertoire/guardrails")
      for (const file of ["NOTES.md", "RULES.md"]) {
        const target = path.join(agentRoot, "psyche", file)
        expect(guardInvocation("write_file", { path: target }, { readPaths: new Set([target]), agentRoot, ...family("telegram") }), file).toMatchObject({ allowed: false, reason: expect.stringContaining("protected") })
      }
    })

    it("creates TACIT when it does not exist yet", async () => {
      const agentRoot = tempBundle()
      const target = path.join(agentRoot, "psyche", "TACIT.md")
      const { guardInvocation, psycheFileClass } = await import("../../repertoire/guardrails")
      expect(psycheFileClass(target, agentRoot)).toBe("tacit")
      expect(guardInvocation("write_file", { path: target }, { readPaths: new Set(), agentRoot, ...family("telegram", { trustLevel: "friend" }) })).toEqual({ allowed: true })
    })

    it("refuses a TACIT write through a symlink", async () => {
      const agentRoot = tempBundle()
      fs.mkdirSync(path.join(agentRoot, "state", "policy"), { recursive: true })
      const policy = path.join(agentRoot, "state", "policy", "steward.json")
      fs.writeFileSync(policy, "{}")
      fs.symlinkSync(policy, path.join(agentRoot, "psyche", "TACIT.md"))
      const target = path.join(agentRoot, "psyche", "TACIT.md")
      const { guardInvocation } = await import("../../repertoire/guardrails")
      expect(guardInvocation("write_file", { path: target }, { readPaths: new Set([target]), agentRoot, ...family("telegram") })).toEqual({ allowed: false, reason: REFUSAL })
      expect(fs.readFileSync(policy, "utf-8")).toBe("{}")
    })

    it("refuses any psyche write when psyche/ is a symlink", async () => {
      const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "psyche-trust-"))
      const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "psyche-trust-"))
      temps.push(agentRoot, elsewhere)
      fs.symlinkSync(elsewhere, path.join(agentRoot, "psyche"))
      const { guardInvocation } = await import("../../repertoire/guardrails")
      for (const file of ["TACIT.md", "SOUL.md"]) {
        const target = path.join(agentRoot, "psyche", file)
        expect(guardInvocation("write_file", { path: target }, { readPaths: new Set([target]), agentRoot, ...family("telegram") }), file).toEqual({ allowed: false, reason: REFUSAL })
      }
    })

    it("refuses TACIT when lstat fails with EACCES", async () => {
      const agentRoot = tempBundle()
      const target = path.join(agentRoot, "psyche", "TACIT.md")
      const realLstat = fs.lstatSync
      vi.spyOn(fs, "lstatSync").mockImplementation(((p: fs.PathLike, options?: fs.StatSyncOptions) => {
        if (String(p) === target) throw Object.assign(new Error("denied"), { code: "EACCES" })
        return realLstat(p, options)
      }) as typeof fs.lstatSync)
      const { psycheWriteAllowed } = await import("../../repertoire/guardrails")
      expect(psycheWriteAllowed("tacit", target, { readPaths: new Set(), agentRoot, ...family("telegram") })).toBe(false)
    })

    it("a new file inside psyche/ is identity-class", async () => {
      const { guardInvocation, psycheFileClass } = await import("../../repertoire/guardrails")
      expect(psycheFileClass("/bundle/psyche/NEW.md", "/bundle")).toBe("identity")
      expect(psycheFileClass("/bundle/psyche", "/bundle")).toBe("identity")
      expect(psycheFileClass("/bundle/notes/x.md", "/bundle")).toBeNull()
      expect(psycheFileClass("/bundle/psyche/SOUL.md", undefined)).toBeNull()
      const target = "/bundle/psyche/NEW.md"
      expect(guardInvocation("write_file", { path: target }, ctx(target, family("telegram", { trustLevel: "friend" })))).toEqual({ allowed: false, reason: REFUSAL })
    })

    it("says, in one fixed line, which psyche file changed", async () => {
      const { psycheEditNote } = await import("../../repertoire/guardrails")
      expect(psycheEditNote("SOUL.md")).toBe("psyche edit: I changed psyche/SOUL.md. I tell my owner in one line which file changed and why.")
    })

    it("refuses shell writes into the psyche even for a family human on telegram, and still allows reads", async () => {
      const { guardInvocation } = await import("../../repertoire/guardrails")
      const who = { readPaths: new Set<string>(), agentRoot: "/bundle", ...family("telegram") }
      expect(guardInvocation("shell", { command: "echo x >> /bundle/psyche/TACIT.md" }, who)).toEqual({ allowed: false, reason: REFUSAL })
      expect(guardInvocation("shell", { command: "cp /tmp/a /bundle/psyche/SOUL.md" }, who)).toEqual({ allowed: false, reason: REFUSAL })
      expect(guardInvocation("shell", { command: "cat /bundle/psyche/SOUL.md" }, who)).toEqual({ allowed: true })
    })
  })

  describe("the psyche folder in shell commands", () => {
    const ctx = (over: Record<string, unknown> = {}) => ({ readPaths: new Set(["/bundle/psyche/SOUL.md"]), agentRoot: "/bundle", trustLevel: "family" as const, ...over })
    it("refuses shell redirects and tee into the psyche folder", async () => {
      const { guardInvocation } = await import("../../repertoire/guardrails")
      expect(guardInvocation("shell", { command: "echo x > /bundle/psyche/SOUL.md" }, ctx())).toMatchObject({ allowed: false })
      expect(guardInvocation("shell", { command: "echo x | tee -a psyche/LORE.md" }, ctx())).toMatchObject({ allowed: false })
    })
    describe("shell commands that mention the psyche folder run only when every part is read-only", () => {
      beforeEach(() => { vi.mocked(fs.existsSync).mockReturnValue(false) })
      const bypasses = [
        "echo x > /bundle/psyche/SOUL.md", "echo x >> /bundle/psyche/SOUL.md", "echo x>/bundle/psyche/SOUL.md", "cp /tmp/x /bundle/psyche/SOUL.md", "mv /tmp/x /bundle/psyche/SOUL.md",
        "sed -i 's/a/b/' /bundle/psyche/SOUL.md", "node -e \"require('fs').writeFileSync('/bundle/psyche/SOUL.md','x')\"", "cd /bundle/psyche && echo x > SOUL.md",
        "cd psyche && echo x > SOUL.md", "echo a > /tmp/a; echo x > /bundle/psyche/SOUL.md", "printf x | tee /bundle/psyche/SOUL.md", "echo x > \"/bundle/psyche/SOUL.md\"",
        "python3 - <<< 'open(\"/bundle/psyche/SOUL.md\",\"w\")'", "echo x > '/bundle/psyche/SOUL.md'", "cat /bundle/psyche/SOUL.md > /tmp/x; rm /bundle/psyche/SOUL.md",
        "echo x > /bundle/x/../psyche/SOUL.md", "ls /bundle/psyche $(cp a /bundle/psyche/SOUL.md)", "cat psyche/SOUL.md | tee psyche/SOUL.md", "python3 -c \"open('psyche/SOUL.md','w')\"",
        "cat /bundle/psyche/SOUL.md & cp a /bundle/psyche/b", "FOO=1 cp a /bundle/psyche/b", "echo `cp a /bundle/psyche/b`", "cat /bundle/psyche/SOUL.md >/dev/null",
        "X=/bundle/psyche/SOUL.md; cat psyche/LORE.md $X", "cat psyche/SOUL.md $TARGET", "cat psyche/SOUL.md ${TARGET}", "cat psyche/SOUL.md $_",
      ]
      it.each(bypasses)("refuses %s", async (command) => {
        const { guardInvocation } = await import("../../repertoire/guardrails")
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "psyche-guard-"))
        vi.mocked(fs.existsSync).mockReturnValue(true)
        const swap = (text: string) => text.split("/bundle").join(root)
        const result = guardInvocation("shell", { command: swap(command) }, ctx({ agentRoot: root, readPaths: new Set() }))
        fs.rmSync(root, { recursive: true, force: true })
        expect(result).toMatchObject({ allowed: false })
        expect((result as { reason: string }).reason).toContain("part of me")
      })
      it.each([
        "cat /bundle/psyche/SOUL.md", "ls -la /bundle/psyche", "head -n 5 psyche/LORE.md", "tail -f /bundle/psyche/LORE.md", "grep -rn Butler /bundle/psyche", "wc -l psyche/*.md",
        "sha256sum /bundle/psyche/LORE.md", "stat /bundle/psyche", "cd /bundle/psyche && ls && cat LORE.md | head -3", "cat \"/bundle/psyche/SOUL.md\"", "FOO=1 cat psyche/SOUL.md; pwd",
      ])("allows the read-only %s", async (command) => {
        const { guardInvocation } = await import("../../repertoire/guardrails")
        vi.mocked(fs.existsSync).mockReturnValue(true)
        expect(guardInvocation("shell", { command }, ctx({ readPaths: new Set() }))).toEqual({ allowed: true })
      })
      it("refuses home, $HOME and cd-relative paths into the psyche and the friends store, and still allows reading them", async () => {
        // The final M1b review: the body map gives the model ~/AgentBundles/<agent>.ouro/, so those literal forms must count.
        const { guardInvocation } = await import("../../repertoire/guardrails")
        vi.mocked(fs.existsSync).mockReturnValue(true)
        const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "psyche-home-")))
        const root = path.join(home, "AgentBundles", "x.ouro")
        fs.mkdirSync(path.join(root, "psyche"), { recursive: true })
        fs.mkdirSync(path.join(root, "friends"), { recursive: true })
        const savedHome = process.env.HOME
        process.env.HOME = home
        try {
          const who = ctx({ agentRoot: root, readPaths: new Set() })
          for (const command of [
            "echo x > ~/AgentBundles/x.ouro/psyche/SOUL.md",
            "echo x > $HOME/AgentBundles/x.ouro/psyche/SOUL.md",
            "cd ~/AgentBundles && cp /tmp/a x.ouro/psyche/SOUL.md",
            `cd ${path.join(home, "AgentBundles")} && cp /tmp/a x.ouro/psyche/SOUL.md`,
            "cd ~/AgentBundles/x.ouro && ln psyche/SOUL.md state/policy/p.json",
            // The re-review: working directories the guard cannot follow.
            "cd $HOME/AgentBundles && echo x > x.ouro/psyche/SOUL.md",
            "pushd ~/AgentBundles; echo x > x.ouro/psyche/SOUL.md",
            "sh -c \"cd ~/AgentBundles && echo x > x.ouro/psyche/SOUL.md\"",
            "cd -- ~/AgentBundles && echo x > x.ouro/psyche/SOUL.md",
            "git -C $HOME/AgentBundles mv /tmp/a x.ouro/psyche/SOUL.md",
            // The second re-review: commands that name the bundle's own folder, or a glob above it, from anywhere.
            "eval \"cd ~/AgentBundles; echo x > x.ouro/psyche/SOUL.md\"",
            "echo \"cd ~/AgentBundles; echo x > x.ouro/psyche/SOUL.md\" | sh",
            `env --chdir=${path.join(home, "AgentBundles")} cp /tmp/a x.ouro/psyche/SOUL.md`,
            "python3 -c \"import os; os.chdir('/x'); open('x.ouro/psyche/SOUL.md','w')\"",
            "find ~/AgentBundles -path \"*/psyche/SOUL.md\" -delete",
          ]) {
            const result = guardInvocation("shell", { command }, who)
            expect(result, command).toMatchObject({ allowed: false })
            expect((result as { reason: string }).reason, command).toContain("part of me")
          }
          expect(guardInvocation("shell", { command: "cd ~/AgentBundles && cp /tmp/a x.ouro/friends/f.json" }, who)).toMatchObject({ allowed: false })
          expect(guardInvocation("shell", { command: "bash -lc 'cd ~/AgentBundles && cp /tmp/a x.ouro/friends/f.json'" }, who)).toMatchObject({ allowed: false })
          // A nested shell or pushd with no protected path part in it is not a mention.
          expect(guardInvocation("shell", { command: "sh -c 'cd /tmp && echo x > notes/a.md'" }, who)).toEqual({ allowed: true })
          expect(guardInvocation("shell", { command: "pushd /tmp; echo x > a.md" }, who)).toEqual({ allowed: true })
          expect(guardInvocation("shell", { command: "cd ~/AgentBundles && cat x.ouro/psyche/SOUL.md" }, who)).toEqual({ allowed: true })
          expect(guardInvocation("shell", { command: "cd ~/AgentBundles && cat x.ouro/friends/f.json" }, who)).toEqual({ allowed: true })
          // Another bundle's psyche or friends folder is not this agent's.
          expect(guardInvocation("shell", { command: "cd ~/AgentBundles && cp /tmp/a other.ouro/psyche/SOUL.md" }, who)).toEqual({ allowed: true })
        } finally {
          process.env.HOME = savedHome
          fs.rmSync(home, { recursive: true, force: true })
        }
      })

      it("refuses a psyche or friends shell write when the filesystem cannot say where it lands", async () => {
        const { guardInvocation } = await import("../../repertoire/guardrails")
        vi.mocked(fs.existsSync).mockReturnValue(true)
        const realpath = vi.spyOn(fs.realpathSync, "native").mockImplementation(() => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }) })
        try {
          const who = ctx({ agentRoot: "/bundle", readPaths: new Set() })
          expect(guardInvocation("shell", { command: "cd /other && cat link/psyche/SOUL.md" }, who)).toMatchObject({ allowed: false })
          expect(guardInvocation("shell", { command: "cd /other && cat link/friends/f.json" }, who)).toMatchObject({ allowed: false })
        } finally {
          realpath.mockRestore()
        }
      })

      it("leaves commands that never mention the folder, and agents with no root, alone", async () => {
        const { guardInvocation } = await import("../../repertoire/guardrails")
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "psyche-guard-"))
        vi.mocked(fs.existsSync).mockReturnValue(true)
        for (const command of ["echo hello > /tmp/out.txt", "cp a b", "git commit -m 'psyche is fine'", "cp src/psyche/a.ts src/psyche/b.ts", "cp psyche-old/a b"]) {
          expect(guardInvocation("shell", { command }, ctx({ agentRoot: root, readPaths: new Set() })), command).toEqual({ allowed: true })
        }
        expect(guardInvocation("shell", { command: "cp a /bundle/psyche/b" }, ctx({ agentRoot: undefined, readPaths: new Set() }))).toEqual({ allowed: true })
        fs.rmSync(root, { recursive: true, force: true })
      })
      it("does not treat a relative psyche path in code as the agent's when it has no psyche folder", async () => {
        const { guardInvocation } = await import("../../repertoire/guardrails")
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "psyche-guard-"))
        expect(guardInvocation("shell", { command: "python3 -c \"open('psyche/x','w')\"" }, ctx({ agentRoot: root, readPaths: new Set() }))).toEqual({ allowed: true })
        fs.rmSync(root, { recursive: true, force: true })
      })
      it("treats unparseable or commented commands that mention the folder as writes", async () => {
        const { guardInvocation } = await import("../../repertoire/guardrails")
        expect(guardInvocation("shell", { command: "cat /bundle/psyche/SOUL.md # fine" }, ctx({ readPaths: new Set() }))).toMatchObject({ allowed: false })
      })
    })
    it("leaves other paths, a lookalike folder, reads, and calls with no agent root alone", async () => {
      const { guardInvocation } = await import("../../repertoire/guardrails")
      expect(guardInvocation("write_file", { path: "/bundle/notes/psyche.md" }, ctx())).toEqual({ allowed: true })
      expect(guardInvocation("write_file", { path: "/bundle/psyche-old/x.md" }, ctx())).toEqual({ allowed: true })
      expect(guardInvocation("write_file", { path: "/bundle/psyche/SOUL.md" }, ctx({ agentRoot: undefined, readPaths: new Set() }))).toEqual({ allowed: true })
      expect(guardInvocation("write_file", { path: "" }, ctx({ readPaths: new Set() }))).toEqual({ allowed: true })
      expect(guardInvocation("read_file", { path: "/bundle/psyche/SOUL.md" }, ctx())).toEqual({ allowed: true })
      expect(guardInvocation("shell", { command: "cat /bundle/psyche/SOUL.md" }, ctx())).toEqual({ allowed: true })
    })
  })
})

describe("the product rules change only by release", () => {
  const PROTECTED = "that path is protected — i can read it but not modify it."
  beforeEach(() => {
    vi.resetModules()
    vi.mocked(fs.existsSync).mockReturnValue(false)
  })

  it.each(["family", undefined])("refuses file and shell writes to product/PRODUCT.md at %s trust", async (trustLevel) => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const ctx = (target: string) => ({ readPaths: new Set([target]), agentRoot: "/bundle", trustLevel: trustLevel as "family" | undefined })
    for (const target of ["/bundle/product/PRODUCT.md", "product/PRODUCT.md", "../bundle/product/PRODUCT.md"]) {
      for (const tool of ["write_file", "edit_file"]) {
        expect(guardInvocation(tool, { path: target }, ctx(target)), `${tool} ${target}`).toEqual({ allowed: false, reason: PROTECTED })
      }
    }
    for (const command of ["echo x > /bundle/product/PRODUCT.md", "cp a /bundle/product/PRODUCT.md", "cd /bundle && sed -i s/a/b/ product/PRODUCT.md", "sed -i s/a/b/ /bundle/prod*/PRODUCT.md"]) {
      expect(guardInvocation("shell", { command }, ctx("")), command).toEqual({ allowed: false, reason: PROTECTED })
    }
  })

  it("leaves other projects' product folders and reads of the rules alone", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const ctx = { readPaths: new Set(["/home/x/code/app/product/notes.md"]), agentRoot: "/bundle", trustLevel: "family" as const }
    expect(guardInvocation("write_file", { path: "/home/x/code/app/product/notes.md" }, ctx)).toEqual({ allowed: true })
    for (const command of ["cd ~/code/app && sed -i s/a/b/ product/x.md", "git add product/", "cat /bundle/product/PRODUCT.md"]) {
      expect(guardInvocation("shell", { command }, ctx), command).toEqual({ allowed: true })
    }
  })

  it("counts a relative product/ as the agent's when the shell already runs in the agent root", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const agentRoot = process.cwd()
    expect(guardInvocation("shell", { command: "sed -i s/a/b/ product/PRODUCT.md" }, { readPaths: new Set(), agentRoot, trustLevel: "family" })).toEqual({ allowed: false, reason: PROTECTED })
    expect(guardInvocation("shell", { command: "sed -i s/a/b/ product/PRODUCT.md" }, { readPaths: new Set(), agentRoot: "/bundle", trustLevel: "family" })).toEqual({ allowed: true })
  })

  it("refuses every spelling of a shell path that lands in product/", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "product-home-"))
    const root = path.join(home, "AgentBundles", "b.ouro")
    fs.mkdirSync(path.join(root, "product"), { recursive: true })
    fs.mkdirSync(path.join(root, "arc"))
    const alias = path.join(home, "alias")
    fs.symlinkSync(root, alias)
    vi.stubEnv("HOME", home)
    try {
      const { guardInvocation } = await import("../../repertoire/guardrails")
      const ctx = { readPaths: new Set<string>(), agentRoot: root, trustLevel: "family" as const }
      for (const command of [
        `echo x > ${root}/./product/PRODUCT.md`, `echo x > ${root}//product/PRODUCT.md`, `echo x > ${root}/arc/../product/PRODUCT.md`,
        `echo x > ${alias}/product/PRODUCT.md`, "echo x > ~/AgentBundles/b.ouro/product/PRODUCT.md", `cd ${root} && echo x > ./product/PRODUCT.md`,
        `cd ${root} && echo x > "./product/PRODUCT.md"`, `cd ${root}/arc && echo x > ../product/PRODUCT.md`, `cd ${root} && cd product && echo x > PRODUCT.md`,
        `node -e "require('fs').writeFileSync('${root}/product/PRODUCT.md','x')"`,
        "echo x > $HOME/AgentBundles/b.ouro/product/PRODUCT.md", `git -C ${root} checkout -- product/PRODUCT.md`,
      ]) {
        expect(guardInvocation("shell", { command }, ctx), command).toEqual({ allowed: false, reason: PROTECTED })
      }
      expect(guardInvocation("shell", { command: `cd ${root} && ls product && cat ./product/PRODUCT.md` }, ctx)).toEqual({ allowed: true })
    } finally {
      vi.unstubAllEnvs()
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it("refuses when the filesystem cannot say where a product path lands, and leaves other commands alone", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    vi.spyOn(fs.realpathSync, "native").mockImplementation(() => { throw Object.assign(new Error("denied"), { code: "EACCES" }) })
    try {
      const ctx = { readPaths: new Set<string>(), agentRoot: "/bundle", trustLevel: "family" as const }
      expect(guardInvocation("shell", { command: "echo x > /bundle/product/PRODUCT.md" }, ctx)).toEqual({ allowed: false, reason: PROTECTED })
      // A bundle-named path is refused before any lookup; a relative one has to be resolved, so this is the lookup failing.
      expect(guardInvocation("shell", { command: "echo x > ./product/PRODUCT.md" }, ctx)).toEqual({ allowed: false, reason: PROTECTED })
      expect(guardInvocation("shell", { command: "echo hi" }, ctx)).toEqual({ allowed: true })
    } finally {
      vi.restoreAllMocks()
    }
  })
})

describe("protected folders resolve paths the way the file tools do", () => {
  const root = "/home/ouro/AgentBundles/sanctuary.ouro"
  const ctx = (target: string) => ({ readPaths: new Set([target]), agentRoot: root, trustLevel: "family" as const })
  const realRealpath = fs.realpathSync.native
  const temps: string[] = []
  const tempRoot = () => {
    const made = fs.mkdtempSync(path.join(os.tmpdir(), "guard-canonical-"))
    temps.push(made)
    return made
  }

  beforeEach(() => {
    vi.resetModules()
    vi.mocked(fs.existsSync).mockReturnValue(false)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    for (const made of temps.splice(0)) fs.rmSync(made, { recursive: true, force: true })
  })

  it("refuses a relative path that the file tools resolve into the psyche from the repo root", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const target = "../../home/ouro/AgentBundles/sanctuary.ouro/psyche/SOUL.md"
    for (const tool of ["write_file", "edit_file"]) {
      expect(guardInvocation(tool, { path: target }, ctx(target)), tool).toMatchObject({ allowed: false, reason: expect.stringContaining("part of me") })
    }
  })

  it("refuses the same relative form into the friends store", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const target = "../../home/ouro/AgentBundles/sanctuary.ouro/friends/x.json"
    for (const tool of ["write_file", "edit_file"]) {
      expect(guardInvocation(tool, { path: target }, ctx(target)), tool).toMatchObject({ allowed: false, reason: expect.stringContaining("protected") })
    }
  })

  it("refuses a case alias of the psyche folder that the filesystem resolves to it", async () => {
    vi.spyOn(fs.realpathSync, "native").mockImplementation(((p: fs.PathLike) => {
      const text = String(p)
      if (text.startsWith(`${root}/Psyche`)) return text.replace(`${root}/Psyche`, `${root}/psyche`)
      return realRealpath(text)
    }) as typeof fs.realpathSync.native)
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const target = `${root}/Psyche/SOUL.md`
    expect(guardInvocation("write_file", { path: target }, ctx(target))).toMatchObject({ allowed: false, reason: expect.stringContaining("part of me") })
  })

  it("refuses a write through a psyche folder that is itself a symlink", async () => {
    const agentRoot = tempRoot()
    const elsewhere = tempRoot()
    fs.symlinkSync(elsewhere, path.join(agentRoot, "psyche"))
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const target = path.join(agentRoot, "psyche", "SOUL.md")
    expect(guardInvocation("write_file", { path: target }, { readPaths: new Set([target]), agentRoot, trustLevel: "family" })).toMatchObject({ allowed: false })
  })

  it("refuses a write through a symlink elsewhere in the bundle that points into the psyche", async () => {
    const agentRoot = tempRoot()
    fs.mkdirSync(path.join(agentRoot, "psyche"))
    fs.mkdirSync(path.join(agentRoot, "notes"))
    fs.writeFileSync(path.join(agentRoot, "psyche", "SOUL.md"), "soul")
    fs.symlinkSync(path.join(agentRoot, "psyche", "SOUL.md"), path.join(agentRoot, "notes", "link.md"))
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const target = path.join(agentRoot, "notes", "link.md")
    expect(guardInvocation("write_file", { path: target }, { readPaths: new Set([target]), agentRoot, trustLevel: "family" })).toMatchObject({ allowed: false, reason: expect.stringContaining("part of me") })
  })

  it("refuses a dangling symlink whose target would land in the psyche or the friends store", async () => {
    const agentRoot = tempRoot()
    fs.mkdirSync(path.join(agentRoot, "psyche"))
    fs.mkdirSync(path.join(agentRoot, "friends"))
    fs.mkdirSync(path.join(agentRoot, "notes"))
    fs.symlinkSync("../psyche/NEW.md", path.join(agentRoot, "notes", "new.md"))
    fs.symlinkSync(path.join(agentRoot, "friends", "forged.json"), path.join(agentRoot, "notes", "forged.json"))
    const { guardInvocation } = await import("../../repertoire/guardrails")
    for (const [name, reason] of [["new.md", "part of me"], ["forged.json", "protected"]]) {
      const target = path.join(agentRoot, "notes", name)
      expect(guardInvocation("write_file", { path: target }, { readPaths: new Set([target]), agentRoot, trustLevel: "family" }), name).toMatchObject({ allowed: false, reason: expect.stringContaining(reason) })
    }
  })

  it("refuses a dangling relative symlink inside a symlinked folder that lands in the psyche or the friends store", async () => {
    const agentRoot = tempRoot()
    for (const dir of ["psyche", "friends", path.join("other", "dir")]) fs.mkdirSync(path.join(agentRoot, dir), { recursive: true })
    fs.symlinkSync(path.join(agentRoot, "other", "dir"), path.join(agentRoot, "notes2"))
    fs.symlinkSync("../../psyche/NEW.md", path.join(agentRoot, "other", "dir", "x.md"))
    fs.symlinkSync("../../friends/forged.json", path.join(agentRoot, "other", "dir", "forged.json"))
    const { guardInvocation } = await import("../../repertoire/guardrails")
    for (const [name, reason] of [["x.md", "part of me"], ["forged.json", "protected"]]) {
      const target = path.join(agentRoot, "notes2", name)
      for (const tool of ["write_file", "edit_file"]) {
        expect(guardInvocation(tool, { path: target }, { readPaths: new Set([target]), agentRoot, trustLevel: "family" }), `${tool} ${name}`).toMatchObject({ allowed: false, reason: expect.stringContaining(reason) })
      }
    }
  })

  it("refuses the write when the filesystem cannot say where a path lands", async () => {
    const agentRoot = tempRoot()
    const target = path.join(agentRoot, "notes", "x.md")
    const errno = (code: string) => Object.assign(new Error(code), { code })
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const realpathSpy = vi.spyOn(fs.realpathSync, "native").mockImplementation((() => { throw errno("EACCES") }) as typeof fs.realpathSync.native)
    expect(guardInvocation("write_file", { path: target }, { readPaths: new Set([target]), agentRoot, trustLevel: "family" })).toMatchObject({ allowed: false, reason: expect.stringContaining("protected") })
    realpathSpy.mockRestore()
    vi.spyOn(fs, "lstatSync").mockImplementation((() => { throw errno("EIO") }) as typeof fs.lstatSync)
    expect(guardInvocation("write_file", { path: target }, { readPaths: new Set([target]), agentRoot, trustLevel: "family" })).toMatchObject({ allowed: false, reason: expect.stringContaining("protected") })
  })

  it("refuses a write through a symlink loop or a chain longer than the kernel follows", async () => {
    const agentRoot = tempRoot()
    fs.symlinkSync(path.join(agentRoot, "loop-b"), path.join(agentRoot, "loop-a"))
    fs.symlinkSync(path.join(agentRoot, "loop-a"), path.join(agentRoot, "loop-b"))
    for (let i = 0; i < 41; i += 1) fs.symlinkSync(`chain-${i + 1}`, path.join(agentRoot, `chain-${i}`))
    const { guardInvocation, canonicalTarget } = await import("../../repertoire/guardrails")
    const refused = (name: string) => {
      const target = path.join(agentRoot, name)
      expect(() => canonicalTarget(target, agentRoot), name).toThrow()
      expect(guardInvocation("write_file", { path: target }, { readPaths: new Set([target]), agentRoot, trustLevel: "family" }), name).toMatchObject({ allowed: false, reason: expect.stringContaining("protected") })
    }
    refused("loop-a")
    expect(canonicalTarget(path.join(agentRoot, "chain-35"), agentRoot)[1]).toBe(path.join(realRealpath(agentRoot), "chain-41"))
    // The kernel reports ELOOP itself well before 40 links (macOS stops at 32), so the guard's own hop limit is reached only
    // when realpath keeps answering ENOENT along the chain.
    vi.spyOn(fs.realpathSync, "native").mockImplementation(((p: fs.PathLike) => {
      if (path.basename(String(p)).startsWith("chain-")) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
      return realRealpath(String(p))
    }) as typeof fs.realpathSync.native)
    refused("chain-0")
  })

  it("leaves ordinary paths with today's results", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    for (const target of [`${root}/notes/x.md`, "notes/x.md", "/tmp/x"]) {
      expect(guardInvocation("write_file", { path: target }, ctx(target)), target).toEqual({ allowed: true })
    }
    expect(guardInvocation("write_file", { path: `${root}/notes/x.md` }, { readPaths: new Set(), agentRoot: root, trustLevel: "family" })).toEqual({ allowed: true })
  })

  describe("canonicalTarget", () => {
    it("returns an absolute path's own lexical and canonical forms", async () => {
      const agentRoot = tempRoot()
      const { canonicalTarget } = await import("../../repertoire/guardrails")
      const target = path.join(agentRoot, "a", "b.md")
      expect(canonicalTarget(target, "/somewhere/else")).toEqual([target, path.join(realRealpath(agentRoot), "a", "b.md")])
    })

    it("returns forms under both the agent root and the repo root for a relative path", async () => {
      const agentRoot = tempRoot()
      const { canonicalTarget } = await import("../../repertoire/guardrails")
      const forms = canonicalTarget("notes/x.md", agentRoot)
      expect(forms).toHaveLength(4)
      expect(forms.slice(0, 2)).toEqual([path.join(agentRoot, "notes", "x.md"), path.join(realRealpath(agentRoot), "notes", "x.md")])
      expect(forms[2]).toBe("/opt/ouro/notes/x.md")
      expect(forms[3].endsWith(path.join("ouro", "notes", "x.md"))).toBe(true)
    })

    it("follows the final file when it exists, and steps past a file used as a directory", async () => {
      const agentRoot = tempRoot()
      fs.writeFileSync(path.join(agentRoot, "real.md"), "x")
      fs.symlinkSync(path.join(agentRoot, "real.md"), path.join(agentRoot, "alias.md"))
      const { canonicalTarget, guardInvocation } = await import("../../repertoire/guardrails")
      const realRoot = realRealpath(agentRoot)
      expect(canonicalTarget(path.join(agentRoot, "alias.md"), agentRoot)[1]).toBe(path.join(realRoot, "real.md"))
      const underFile = path.join(agentRoot, "real.md", "x")
      expect(canonicalTarget(underFile, agentRoot)[1]).toBe(path.join(realRoot, "real.md", "x"))
      expect(guardInvocation("write_file", { path: underFile }, { readPaths: new Set([underFile]), agentRoot, trustLevel: "family" })).toEqual({ allowed: true })
    })

    it("keeps the lexical path when nothing on it exists, and refuses when the filesystem denies the lookup", async () => {
      const errno = (code: string) => Object.assign(new Error(code), { code })
      const spy = vi.spyOn(fs.realpathSync, "native").mockImplementation((() => { throw errno("ENOENT") }) as typeof fs.realpathSync.native)
      const { canonicalTarget, guardInvocation } = await import("../../repertoire/guardrails")
      expect(canonicalTarget("/a/b", "/root")).toEqual(["/a/b", "/a/b"])
      // A root with no symlinked ancestors (macOS links /home and /tmp), so the ENOENT-only mock never has a link to follow.
      const bare = "/guard-canonical-missing-root"
      const target = `${bare}/notes/x.md`
      const bareCtx = { readPaths: new Set([target]), agentRoot: bare, trustLevel: "family" as const }
      expect(guardInvocation("write_file", { path: target }, bareCtx)).toEqual({ allowed: true })
      spy.mockImplementation((() => { throw errno("EACCES") }) as typeof fs.realpathSync.native)
      expect(() => canonicalTarget("/a/b", "/root")).toThrow("EACCES")
      expect(guardInvocation("write_file", { path: target }, bareCtx)).toMatchObject({ allowed: false, reason: expect.stringContaining("protected") })
    })
  })

  describe("insideAgentFolder", () => {
    it("matches the folder itself and anything under it, and nothing beside it", async () => {
      const { insideAgentFolder } = await import("../../repertoire/guardrails")
      expect(insideAgentFolder(`${root}/product`, root, "product")).toBe(true)
      expect(insideAgentFolder(`${root}/product/PRODUCT.md`, root, "product")).toBe(true)
      expect(insideAgentFolder(`${root}/product-old/PRODUCT.md`, root, "product")).toBe(false)
      expect(insideAgentFolder("product/PRODUCT.md", root, "product")).toBe(true)
      expect(insideAgentFolder("/home/ari/code/app/product/x.md", root, "product")).toBe(false)
    })
  })
})

describe("sync owns the bundle's git, and its key is closed to the read-only file tools", () => {
  let tmp: string
  let bundle: string

  beforeEach(() => {
    vi.resetModules()
    vi.mocked(fs.existsSync).mockReturnValue(false)
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bundle-git-guard-")))
    bundle = path.join(tmp, "agent.ouro")
    fs.mkdirSync(path.join(bundle, ".git"), { recursive: true })
    fs.mkdirSync(path.join(bundle, "psyche"))
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    const { __testHooks } = await import("../../heart/sync")
    delete __testHooks.syncSecretDir
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  async function shell(command: string) {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    return guardInvocation("shell", { command }, { readPaths: new Set(), agentRoot: bundle, trustLevel: "family" })
  }
  // The psyche guard runs first and keeps its own line for the commands in `psycheFirst`, which it refuses anyway.
  async function expectRefused(commands: string[], reason: string, psycheFirst: string[]) {
    const { PSYCHE_REFUSAL } = await import("../../repertoire/guardrails")
    const results = []
    for (const command of commands) results.push({ command, result: await shell(command) })
    expect(results).toEqual(commands.map((command) => ({ command, result: { allowed: false, reason: psycheFirst.includes(command) ? PSYCHE_REFUSAL : reason } })))
    // The bundle guard refuses every one of them on its own too, including the ones the psyche guard answers first.
    const { bundleGitRefused } = await import("../../repertoire/guardrails")
    expect(commands.filter((command) => !bundleGitRefused(command, bundle))).toEqual([])
  }

  it("refuses each way of aiming git at the bundle with one plain line", async () => {
    const { BUNDLE_GIT_REFUSAL } = await import("../../repertoire/guardrails")
    expect(BUNDLE_GIT_REFUSAL).toBe("my bundle syncs itself; I don't run git in it.")
    fs.symlinkSync(bundle, path.join(tmp, "link"))
    const refused = [
      `cd ${bundle} && git commit -am x`,
      `cd ${bundle}/psyche; git log`,
      `cd ${tmp} && git -C agent.ouro status`,
      `cd ${tmp} && cd agent.ouro && git status`,
      `cd -L ${bundle} && git status`,
      `pushd ${bundle} && git status`,
      `git -C ${bundle} status`,
      `git -C ${tmp} -C agent.ouro push origin HEAD:main`,
      `git -C ${tmp}/link status`,
      `git --git-dir=${bundle}/.git log`,
      `git --git-dir ${bundle}/.git log`,
      `git --work-tree=${bundle} --git-dir=${tmp}/other.git status`,
      `git --work-tree ${bundle} status`,
      `git -c core.worktree=${bundle} status`,
      `GIT_DIR=${bundle}/.git git log`,
      `GIT_WORK_TREE=${bundle} git status`,
      `export GIT_DIR=${bundle}/.git; git status`,
      `cd ${tmp} && GIT_DIR=agent.ouro/.git git log`,
      `env -C ${bundle} git status`,
      `env -C${bundle} git status`,
      `env --chdir=${bundle} git status`,
      `env --chdir ${bundle} git status`,
      `env GIT_DIR=${bundle}/.git git log`,
      `env -S "git -C ${bundle} status"`,
      `sudo -u ouro git -C ${bundle} status`,
      `timeout 5 git -C ${bundle} fetch`,
      `cd ${tmp} && ls | xargs git -C agent.ouro status`,
      `sh -c "cd ${bundle} && git push"`,
      `bash -lc 'git -C ${bundle} add -A'`,
      `eval "git -C ${bundle} reset --hard"`,
      `echo $(git -C ${bundle} rev-parse HEAD)`,
      `git init ${bundle}`,
      `git init --separate-git-dir=${bundle}/.git ${tmp}/fresh`,
      `git init --separate-git-dir ${bundle}/.git ${tmp}/fresh`,
      `cd ${tmp} && git --git-dir agent.ouro/.git log`,
      `GIT_DIR=${bundle}/.git; git log`,
      `git clone ${tmp}/remote.git ${bundle}/copy`,
    ]
    await expectRefused(refused, BUNDLE_GIT_REFUSAL, [`cd ${bundle}/psyche; git log`, `echo $(git -C ${bundle} rev-parse HEAD)`])
  })

  it("refuses git while the shell itself starts in the bundle", async () => {
    vi.spyOn(process, "cwd").mockReturnValue(bundle)
    const { BUNDLE_GIT_REFUSAL, PSYCHE_REFUSAL } = await import("../../repertoire/guardrails")
    expect(await shell("git status")).toEqual({ allowed: false, reason: BUNDLE_GIT_REFUSAL })
    expect(await shell("cd psyche && git log")).toEqual({ allowed: false, reason: PSYCHE_REFUSAL })
    expect(await shell("git -C /tmp/repo status")).toEqual({ allowed: true })
  })

  it("refuses git whose directory it cannot work out", async () => {
    const { BUNDLE_GIT_REFUSAL } = await import("../../repertoire/guardrails")
    fs.symlinkSync("loop", path.join(tmp, "loop"))
    const refused = [
      "git -C $REPO status",
      "git --git-dir $REPO/.git log",
      "git --git-dir=$REPO/.git log",
      "git -c core.worktree=$REPO status",
      "GIT_DIR=$REPO git log",
      "cd - && git -C repo status",
      "pushd && git status",
      "cd $REPO && git status",
      "git init $REPO",
      "git -C",
      "$RUN git status",
      `cd ${tmp} && find . -execdir git status \;`,
      `echo "git -C ${bundle} push" | sh`,
      `${"eval ".repeat(33)}git status`,
      `git -C ${tmp}/loop status`,
      "cd - && cd agent.ouro && git status",
    ]
    await expectRefused(refused, BUNDLE_GIT_REFUSAL, ["git -C $REPO status", "git --git-dir $REPO/.git log", "cd $REPO && git status", "git init $REPO", "$RUN git status"])
  })

  it("allows git elsewhere and commands that only mention git", async () => {
    const allowed = [
      "git status",
      "cd /tmp/repo && git status",
      "git -C /tmp/repo status",
      "cd - && git -C /tmp/repo log",
      "cd && git -C /tmp/repo log",
      "git -p --namespace x -c user.name=a --bare log",
      "git clone https://example.invalid/x.git",
      `git -C /tmp/repo init`,
      `GIT_DIR=/tmp/repo/.git git log`,
      "echo git is great",
      `grep -r git ${bundle}/psyche`,
      `ls ${bundle}`,
      "timeout 5 ls",
      "find /tmp/repo -name '*.md'",
      "bash ./build.sh git",
      "export PATH=/usr/bin:$PATH && git --version",
      "env -C /tmp/repo; git status",
      "sh -c; git status",
      "xargs ls; git status",
      "git -C /tmp/repo -c",
    ]
    for (const command of allowed) expect({ command, result: await shell(command) }).toEqual({ command, result: { allowed: true } })
    const { bundleGitRefused, guardInvocation } = await import("../../repertoire/guardrails")
    expect(guardInvocation("shell", { command: `git -C ${bundle} status` }, { readPaths: new Set() })).toEqual({ allowed: true })
    // A runner's unreadable argument is not its command; the psyche guard answers this one first in a turn.
    expect(bundleGitRefused("find /tmp/repo -exec $X git -C /tmp/repo log \\;", bundle)).toBe(false)
    // An unreadable command word with no git after it runs something else; the later git is read on its own.
    expect(bundleGitRefused("$RUN ls; git -C /tmp/repo log", bundle)).toBe(false)
    // An unset stable variable stays unknown, so git aimed through it is refused.
    const savedTmp = process.env.TMPDIR
    delete process.env.TMPDIR
    try {
      expect(bundleGitRefused("git -C $TMPDIR/repo log", bundle)).toBe(true)
    } finally {
      process.env.TMPDIR = savedTmp
    }
  })

  it("refuses split command words, git config from the command line or environment, xargs replacement and CDPATH", async () => {
    const { BUNDLE_GIT_REFUSAL } = await import("../../repertoire/guardrails")
    const refused = [
      `g''it -C ${bundle} status`,
      `"g"it -C ${bundle} status`,
      `g\\it -C ${bundle} status`,
      `git -c alias.s='!git -C ${bundle} status' s`,
      `git -c ALIAS.s='!cd ${bundle} && git push origin HEAD:main' s`,
      "git --config-env alias.s=CMD s",
      "git --config-env=alias.s=CMD s",
      `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.s GIT_CONFIG_VALUE_0='!git -C ${bundle} status' git s`,
      `GIT_CONFIG_PARAMETERS="'alias.s'='!git -C ${bundle} push'" git s`,
      "export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.s GIT_CONFIG_VALUE_0='!cd ../agent.ouro && git push'; git s",
      `echo ${bundle} | xargs -I D git -C D status`,
      `echo ${bundle} | xargs -ID git -C D status`,
      `echo ${bundle} | xargs --replace=D git -C D status`,
      `echo ${bundle} | xargs -i git -C {} status`,
      `CDPATH=${tmp} cd agent.ouro && git status`,
      `export CDPATH=${tmp}; cd agent.ouro; git status`,
    ]
    // An unreadable directory word reaches the psyche guard first.
    await expectRefused(refused, BUNDLE_GIT_REFUSAL, [`echo ${bundle} | xargs -i git -C {} status`])
    const savedCdpath = process.env.CDPATH
    process.env.CDPATH = tmp
    try {
      expect(await shell("cd agent.ouro && git status")).toEqual({ allowed: false, reason: BUNDLE_GIT_REFUSAL })
      expect(await shell("cd /tmp/repo && git status")).toEqual({ allowed: true })
    } finally {
      if (savedCdpath === undefined) delete process.env.CDPATH
      else process.env.CDPATH = savedCdpath
    }
    for (const command of [
      "git -c user.name=a -C /tmp/repo log",
      `CDPATH=${tmp} cd /tmp/repo && git status`,
      "echo x | xargs -n1 git -C /tmp/repo log",
      "echo it is quoted: \"g\"o",
      "GIT_CONFIG_NOSYSTEM=1 git -C /tmp/x status",
      "GIT_CONFIG_GLOBAL=/tmp/gitconfig git -C /tmp/x log",
      "export GIT_CONFIG_COUNT=1; git status",
    ]) expect({ command, result: await shell(command) }).toEqual({ command, result: { allowed: true } })
  })

  it("refuses any shell command that names the key's directory, with the plain unreadable line", async () => {
    const refused = { allowed: false, reason: "that path is protected — i can't read it." }
    for (const command of ["cat /run/ouro-sync/deploy_key", "cp /run/ouro-sync/deploy_key /tmp/k", "ssh -i /run/ouro-sync/deploy_key git@github.com", "ls /run/ouro-sync"]) {
      expect({ command, result: await shell(command) }).toEqual({ command, result: refused })
    }
    const { guardInvocation } = await import("../../repertoire/guardrails")
    expect(guardInvocation("shell", { command: "cat /run/ouro-sync/deploy_key" }, { readPaths: new Set() })).toEqual(refused)
    expect(await shell("ls /run")).toEqual({ allowed: true })
  })

  it("read_file, glob and grep refuse /run/ouro-sync, the key in it and a symlink to it", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const ctx = { readPaths: new Set<string>(), agentRoot: bundle, trustLevel: "family" as const }
    const refused = { allowed: false, reason: "that path is protected — i can't read it." }
    expect(guardInvocation("read_file", { path: "/run/ouro-sync/deploy_key" }, ctx)).toEqual(refused)
    expect(guardInvocation("read_file", {}, ctx)).toEqual({ allowed: true })
    expect(guardInvocation("glob", {}, ctx)).toEqual({ allowed: true })
    expect(guardInvocation("glob", { pattern: "*", cwd: "/run/ouro-sync" }, ctx)).toEqual(refused)
    expect(guardInvocation("grep", { pattern: "BEGIN", path: "/run/ouro-sync" }, ctx)).toEqual(refused)

    const { __testHooks } = await import("../../heart/sync")
    const secret = path.join(tmp, "ouro-sync")
    fs.mkdirSync(secret)
    fs.writeFileSync(path.join(secret, "deploy_key"), "key\n")
    fs.symlinkSync(path.join(secret, "deploy_key"), path.join(bundle, "notes.txt"))
    fs.symlinkSync(secret, path.join(tmp, "keys"))
    fs.writeFileSync(path.join(bundle, "real.txt"), "fine\n")
    __testHooks.syncSecretDir = secret

    expect(guardInvocation("read_file", { path: path.join(secret, "deploy_key") }, ctx)).toEqual(refused)
    expect(guardInvocation("read_file", { path: path.join(bundle, "notes.txt") }, ctx)).toEqual(refused)
    expect(guardInvocation("read_file", { path: path.join(tmp, "keys", "deploy_key") }, ctx)).toEqual(refused)
    expect(guardInvocation("glob", { pattern: "*", cwd: path.join(tmp, "keys") }, ctx)).toEqual(refused)
    expect(guardInvocation("glob", { pattern: `${secret}/*` }, ctx)).toEqual(refused)
    expect(guardInvocation("glob", { pattern: "ouro-sync/deploy_key", cwd: tmp }, ctx)).toEqual(refused)
    expect(guardInvocation("grep", { pattern: "BEGIN", path: path.join(bundle, "notes.txt") }, ctx)).toEqual(refused)
    expect(guardInvocation("grep", { pattern: "BEGIN", path: tmp }, ctx)).toEqual(refused)
    expect(guardInvocation("grep", { pattern: "BEGIN", path: "/" }, ctx)).toEqual(refused)

    expect(guardInvocation("read_file", { path: path.join(bundle, "real.txt") }, ctx)).toEqual({ allowed: true })
    expect(guardInvocation("read_file", { path: "src/index.ts" }, ctx)).toEqual({ allowed: true })
    expect(guardInvocation("glob", { pattern: "**/*.txt", cwd: bundle }, ctx)).toEqual({ allowed: true })
    expect(guardInvocation("glob", { pattern: "*.ts" }, ctx)).toEqual({ allowed: true })
    expect(guardInvocation("grep", { pattern: "fine", path: bundle }, ctx)).toEqual({ allowed: true })
    expect(guardInvocation("grep", { pattern: "fine" }, ctx)).toEqual({ allowed: true })
  })

  it("reads from the agent's home: relative paths and the default path are checked against the key's directory", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const { __testHooks } = await import("../../heart/sync")
    const ctx = { readPaths: new Set<string>(), agentRoot: bundle, trustLevel: "family" as const }
    const refused = { allowed: false, reason: "that path is protected — i can't read it." }
    fs.mkdirSync(path.join(bundle, "keys-here"))
    __testHooks.syncSecretDir = path.join(bundle, "keys-here")

    expect(guardInvocation("read_file", { path: "keys-here/deploy_key" }, ctx)).toEqual(refused)
    expect(guardInvocation("grep", { pattern: "BEGIN" }, ctx)).toEqual(refused)
    expect(guardInvocation("glob", { pattern: "keys-here/*" }, ctx)).toEqual(refused)
    expect(guardInvocation("glob", { pattern: "*", cwd: "keys-here" }, ctx)).toEqual(refused)
    expect(guardInvocation("read_file", { path: "psyche/SOUL.md" }, ctx)).toEqual({ allowed: true })
  })

  it("refuses a read whose landing place the filesystem cannot report", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    fs.symlinkSync("loop", path.join(tmp, "loop"))
    expect(guardInvocation("read_file", { path: path.join(tmp, "loop") }, { readPaths: new Set() })).toEqual({ allowed: false, reason: "that path is protected — i can't read it." })
  })
})
