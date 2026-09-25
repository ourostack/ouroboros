import { chownSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { afterAll } from "vitest"

// Every test file gets its own TMPDIR and HOME (D-031). Tests that derive sibling paths
// from a temp directory (the mailroom search cache sits at <rootDir>/../mail-search),
// fixed names, or product defaults under the home directory (external-event records in
// ~/.ouro-cli/daemon/external-events) collided across files and across two coverage runs
// at once, and wrote test records into the developer's real home. os.tmpdir() and
// os.homedir() read TMPDIR and HOME on every call.
const MARKER = "OURO_TEST_ISOLATED_ROOT"

// A Vitest run launched from inside an isolated test (cross-process tests spawn child
// runs) shares its parent's private directories: the parent and child meet there.
if (process.env[MARKER] === undefined) {
  const runnerTmpdir = tmpdir()
  const runnerHome = process.env.HOME
  // Unix socket paths are capped (104 bytes on macOS), and tests put sockets in the temp
  // dir, so the private root must be short: the real /tmp (/private/tmp on macOS) keeps
  // every path shorter than the default /var/folders/.../T/ root it replaces.
  const shortRoot = existsSync("/tmp") ? realpathSync("/tmp") : runnerTmpdir
  const isolated = mkdtempSync(join(shortRoot, "ov-"))
  // On macOS new files take their group from the parent directory, and /tmp is group wheel;
  // tests that check private-file ownership expect the process's own group.
  chownSync(isolated, process.getuid!(), process.getgid!())
  const home = join(isolated, "home")
  mkdirSync(home)
  // Tests that commit in scratch repositories need an identity; the real ~/.gitconfig is out of reach.
  writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = Ouro Test\n\temail = test@ouro.invalid\n[init]\n\tdefaultBranch = main\n")
  process.env.TMPDIR = isolated
  process.env.HOME = home
  process.env[MARKER] = isolated

  afterAll(() => {
    process.env.TMPDIR = runnerTmpdir
    if (runnerHome === undefined) delete process.env.HOME
    else process.env.HOME = runnerHome
    delete process.env[MARKER]
    rmSync(isolated, { recursive: true, force: true })
  })
}
