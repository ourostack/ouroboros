// The programs an agent's shell can start as `node <path>` beside the ouro command, each with its Ouro AX card (see
// cli-manifest.ts). Most are started by the daemon, a container or a Sanctuary host job, not by hand; a card says so.
// Each failure a card names ends the program's stderr (or its JSON) with that code.
import type { CliCommandDeclaration, CliErrorCard } from "../cli-manifest"

/** The guard every sense and worker entry runs before it loads anything: no `--agent <name>`. */
function missingAgent(path: string): CliErrorCard {
  return {
    code: "missing-agent",
    means: `node ${path} was started without --agent <name>, so it can't tell which agent bundle to run.`,
    fix: `Let ouro up start it, or pass the agent: node ${path} --agent <name>.`,
  }
}

const ROOT_LIFECYCLE = "node dist/heart/daemon/sanctuary-authority-root-lifecycle.js"
const REDACTION = "node dist/heart/session-redaction-repair-cli-main.js"
const PROBE = "node dist/senses/sanctuary-health-acceptance-probe-entry.js"

/** A root lifecycle step run as someone other than root. */
function rootOnly(step: string): CliErrorCard {
  return {
    code: "needs-root",
    means: `${ROOT_LIFECYCLE} ${step} runs only as root (uid and gid 0) on the Sanctuary host.`,
    fix: `Run ${step} from the host's root job, not from the agent's shell.`,
  }
}

/** A root lifecycle step that needs an installed authority. */
function notActive(step: string): CliErrorCard {
  return {
    code: "not-active",
    means: `${ROOT_LIFECYCLE} ${step} found no activation record, so no Sanctuary authority is installed to change.`,
    fix: `Install the authority with docker-man-template-transaction.mjs authority-install first, then rerun ${step}.`,
  }
}

/** A root lifecycle step given the wrong words. */
function rootUsage(step: string, words: string): CliErrorCard {
  return {
    code: "usage",
    means: `${ROOT_LIFECYCLE} ${step} takes ${words}, and got something else.`,
    fix: `Run ${step} with exactly ${words}.`,
  }
}

/** A redaction repair step that started but didn't finish. */
function repairUnfinished(step: string): CliErrorCard[] {
  return [
    {
      code: "not-applied",
      means: `${REDACTION} ${step} stopped before it changed the session; the file is as it was.`,
      fix: `Its write didn't land and the session is unchanged; run ${step} again with the same manifest.`,
    },
    {
      code: "indeterminate",
      means: `${REDACTION} ${step} found the session at neither its preimage nor its postimage (it changed underneath), or reading the session back after the write threw.`,
      fix: "Stop, and compare the session with the manifest and preimage by hand before any other step.",
    },
  ]
}

/** A redaction repair step the repair itself refused, such as a manifest digest that doesn't match. */
function repairRefused(step: string): CliErrorCard {
  return {
    code: "repair-refused",
    means: `${REDACTION} ${step} refused: the session, manifest or digest didn't pass its checks, and nothing changed.`,
    fix: "Read the JSON error, then rerun inspect for a fresh manifest and use its exact digest.",
  }
}

/** A probe step given the wrong coordinates. */
function probeUsage(step: string): CliErrorCard {
  return {
    code: "usage",
    means: `${PROBE} ${step} needs --label, --scenario, --owner-image and --owner-container in that order${step === "finalize" ? ", then the two -after digests" : ""}.`,
    fix: `Pass the coordinates the acceptance runner recorded for this scenario to ${step}.`,
  }
}

export const ENTRY_POINT_COMMANDS: readonly CliCommandDeclaration[] = [
  { name: "node dist/heart/agent-entry.js", effect: "private", summary: "Run one agent's worker process.", ax: { id: "cli:node dist/heart/agent-entry.js", group: "entry-points", effect: "write", when: "The daemon starts one per agent; run it by hand only to debug a worker crash with the daemon stopped.", errors: [missingAgent("dist/heart/agent-entry.js")] } },
  { name: "node dist/heart/daemon/container-healthcheck.js", effect: "private", readOnly: true, summary: "Check a Sanctuary container's health.", ax: { id: "cli:node dist/heart/daemon/container-healthcheck.js", group: "entry-points", effect: "read", when: "Docker runs it as the Sanctuary container's healthcheck; run it inside the container to see which readiness check fails.", errors: [
    { code: "missing-agent", means: "The container healthcheck needs --agent <name> for the agent the container runs.", fix: "Pass the same --agent the container's start command uses." },
    { code: "unhealthy", means: "A readiness check failed: the bundle, daemon health file, PID 1 daemon, or one managed process isn't ready.", fix: "Read the reason on stderr, then check ouro status and the daemon logs inside the container." },
  ] } },
  { name: "node dist/heart/daemon/container-spec-auditor-main.js", effect: "private", readOnly: true, summary: "Audit a Sanctuary container spec.", ax: { id: "cli:node dist/heart/daemon/container-spec-auditor-main.js", group: "entry-points", effect: "read", when: "Before or after deploying Sanctuary: check a template, persistent template or running container against the expected image and mounts.", errors: [
    { code: "usage", means: "The container spec auditor got no complete mode: it needs --mount-contract and one staged, persistent or effective set of flags.", fix: "Read the usage in the JSON error and pass every flag of one mode." },
  ] } },
  { name: "node dist/heart/daemon/daemon-entry.js", effect: "private", summary: "Run the Ouro daemon.", ax: { id: "cli:node dist/heart/daemon/daemon-entry.js", group: "entry-points", effect: "write", when: "ouro up starts the background runtime through this; start it by hand only with a custom --socket while debugging.", errors: [
    { code: "unsupported-home", means: "The daemon refused to start because the Ouro home folder sits on a FAT or exFAT disk, which can't hold its locks and links.", fix: "Move the Ouro home to an APFS, HFS+ or ext4 volume, then run ouro up." },
  ] } },
  { name: ROOT_LIFECYCLE, effect: "private", summary: "Run Sanctuary's root lifecycle steps.", ax: { id: `cli:${ROOT_LIFECYCLE}`, group: "sanctuary-host", effect: "write", when: "Root jobs on the Sanctuary host call it with one step: boot, vault, repin-execution, upgrade or upgrade-rollback.", errors: [
    { code: "usage", means: `${ROOT_LIFECYCLE} got no step it knows, or the wrong number of words for one.`, fix: "Pass one step and exactly its words, such as boot alone." },
    { code: "needs-root", means: `${ROOT_LIFECYCLE} runs only as root (uid and gid 0) on the Sanctuary host, whatever the step.`, fix: "Run boot, vault, repin-execution, upgrade or upgrade-rollback from the host's root job, not from the agent's shell." },
  ] } },
  { name: `${ROOT_LIFECYCLE} vault`, effect: "private", summary: "Move the Sanctuary authority's vault items.", ax: { id: `cli:${ROOT_LIFECYCLE} vault`, group: "sanctuary-host", effect: "consequential", confirm: "Vault restore and remove change which token the Butler's Telegram front door can reach.", when: "Inside the authority install transaction only: snapshot, restore or remove the root-held vault items, one verb at a time.", errors: [
    rootUsage("vault", "one verb: snapshot, presence, remove or restore"),
    rootOnly("vault"),
    { code: "outside-install", means: `${ROOT_LIFECYCLE} vault remove was run outside the authority install transaction, which could strand the Butler.`, fix: "Run docker-man-template-transaction.mjs authority-install, which removes it safely." },
  ] } },
  { name: `${ROOT_LIFECYCLE} repin-execution`, effect: "private", summary: "Repin the authority's prlimit and setsid.", ax: { id: `cli:${ROOT_LIFECYCLE} repin-execution`, group: "sanctuary-host", effect: "consequential", confirm: "The authority will launch only prlimit and setsid binaries with these digests; wrong ones stop the Butler starting.", when: "After the host's prlimit or setsid binary changes: record their new sha256 digests so the authority keeps launching.", errors: [rootUsage("repin-execution", "the prlimit and setsid sha256 digests"), rootOnly("repin-execution"), notActive("repin-execution")] } },
  { name: `${ROOT_LIFECYCLE} upgrade`, effect: "private", summary: "Upgrade the Sanctuary authority's image.", ax: { id: `cli:${ROOT_LIFECYCLE} upgrade`, group: "sanctuary-host", effect: "consequential", confirm: "The live Butler moves to the target image; upgrade-rollback is the way back.", when: "Move the installed authority to a target image id and reference, waiting out a boot in flight.", errors: [rootUsage("upgrade", "a target image id and image reference, then optionally --fail-after <step> or --hold-commit"), rootOnly("upgrade"), notActive("upgrade")] } },
  { name: `${ROOT_LIFECYCLE} upgrade-rollback`, effect: "private", summary: "Roll the Sanctuary authority's upgrade back.", ax: { id: `cli:${ROOT_LIFECYCLE} upgrade-rollback`, group: "sanctuary-host", effect: "consequential", confirm: "The Butler goes back to the image it ran before the last upgrade.", when: "When an upgraded authority misbehaves: return it to the image it ran before, from the root job.", errors: [rootUsage("upgrade-rollback", "no further words"), rootOnly("upgrade-rollback"), notActive("upgrade-rollback")] } },
  { name: `${ROOT_LIFECYCLE} boot`, effect: "private", summary: "Boot the Sanctuary authority.", ax: { id: `cli:${ROOT_LIFECYCLE} boot`, group: "sanctuary-host", effect: "write", when: "The host keeper retries it at start-up; it brings an installed authority up and does nothing when none is active.", errors: [rootUsage("boot", "no further words"), rootOnly("boot")] } },
  { name: "node dist/heart/daemon/sanctuary-host-supervisor-entry.js", effect: "private", summary: "Supervise one Sanctuary host job.", ax: { id: "cli:node dist/heart/daemon/sanctuary-host-supervisor-entry.js", group: "sanctuary-host", effect: "write", when: "The host runs it with a job's --spec file to launch and watch that job under a lock; agents don't start it.", errors: [
    { code: "missing-spec", means: "The Sanctuary host supervisor needs --spec <path> naming the job it supervises.", fix: "Pass the job's spec file with --spec." },
  ] } },
  { name: "node dist/heart/daemon/sanctuary-telegram-authority-entry.js", effect: "private", summary: "Run the Sanctuary Telegram authority.", ax: { id: "cli:node dist/heart/daemon/sanctuary-telegram-authority-entry.js", group: "sanctuary-host", effect: "write", when: "The root service runs the Butler's Telegram front door from its --config; --retire-only only retires a previous one.", errors: [
    { code: "missing-config", means: "The Sanctuary Telegram authority needs --config <path> for its root-held active config.", fix: "Pass the active config path the authority service unit names." },
  ] } },
  { name: "node dist/heart/daemon/sanctuary-telegram-test-driver-entry.js", effect: "private", summary: "Drive test turns through the Telegram authority.", ax: { id: "cli:node dist/heart/daemon/sanctuary-telegram-test-driver-entry.js", group: "sanctuary-host", effect: "consequential", confirm: "send delivers a real [test] owner turn to the live Butler, which answers it in the owner's Telegram chat.", when: "As root during acceptance: send a [test] owner turn through the live authority and read its log.", errors: [
    { code: "missing-config", means: "The Sanctuary test driver needs --config <active.json> before its command, to reach the live authority.", fix: "Pass --config with the authority's active config, then send or log." },
  ] } },
  { name: "node dist/heart/session-playback-cli-main.js", effect: "private", readOnly: true, summary: "Show what replaying a session would change.", ax: { id: "cli:node dist/heart/session-playback-cli-main.js", group: "diagnostics", effect: "read", when: "When an agent loops on replay: see what the sanitizer would drop or insert in a saved session file, writing nothing.", errors: [
    { code: "usage", means: "Session playback needs the path of a saved session.json.", fix: "Pass the session file, adding --json for the report as data." },
  ] } },
  { name: REDACTION, effect: "private", summary: "Repair a session's redaction with a fixed recipe.", ax: { id: `cli:${REDACTION}`, group: "diagnostics", effect: "write", when: "Only for the one known redaction defect: inspect a session, then apply or roll back with the manifest inspect wrote.", errors: [
    { code: "usage", means: `${REDACTION} takes only its three fixed shapes: inspect, apply or rollback with their exact flags.`, fix: "Start with inspect --agent <name> --session <path> --artifacts-dir <dir>." },
  ] } },
  { name: `${REDACTION} inspect`, effect: "private", summary: "Plan a session's redaction repair.", ax: { id: `cli:${REDACTION} inspect`, group: "diagnostics", effect: "write", when: "First step of the repair: write a manifest and preimage for one session into --artifacts-dir, leaving the session alone.", errors: [
    { code: "usage", means: `${REDACTION} inspect needs --agent, --session and --artifacts-dir, in that order.`, fix: "Pass all three with their values and nothing else." },
    repairRefused("inspect"),
  ] } },
  { name: `${REDACTION} apply`, effect: "private", summary: "Apply a planned redaction repair.", ax: { id: `cli:${REDACTION} apply`, group: "diagnostics", effect: "consequential", confirm: "The session file is rewritten from the manifest; rollback with the preimage undoes it.", when: "After inspect: rewrite the session from the manifest, given its exact --manifest-sha256.", errors: [
    { code: "usage", means: `${REDACTION} apply needs --manifest-sha256 <digest> and the manifest path, and nothing else.`, fix: "Pass the digest and manifest path inspect printed." },
    repairRefused("apply"), ...repairUnfinished("apply"),
  ] } },
  { name: `${REDACTION} rollback`, effect: "private", summary: "Undo an applied redaction repair.", ax: { id: `cli:${REDACTION} rollback`, group: "diagnostics", effect: "consequential", confirm: "The session file goes back to the preimage inspect saved.", when: "If an applied repair looks wrong: put the session back from the preimage, with the manifest's digest.", errors: [
    { code: "usage", means: `${REDACTION} rollback needs --manifest-sha256 <digest>, the manifest path and the preimage path, and nothing else.`, fix: "Pass the digest and both paths inspect printed." },
    repairRefused("rollback"), ...repairUnfinished("rollback"),
  ] } },
  { name: "node dist/heart/session-stats-cli-main.js", effect: "private", readOnly: true, summary: "Summarize a saved session.", ax: { id: "cli:node dist/heart/session-stats-cli-main.js", group: "diagnostics", effect: "read", when: "Size up a saved session file: message counts, token use and the last usage record, before deciding to trim it.", errors: [
    { code: "usage", means: "Session stats needs the path of a saved session.json.", fix: "Pass the session file, adding --json for the numbers as data." },
  ] } },
  { name: "node dist/mailroom/entry.js", effect: "private", summary: "Run the mailroom's SMTP and HTTP ingress.", ax: { id: "cli:node dist/mailroom/entry.js", group: "mail", effect: "write", when: "The hosted mailroom container runs it to accept mail for a registry's domain into a file or Azure store.", errors: [
    { code: "missing-store", means: "The mailroom needs somewhere to keep mail: --store <dir> or --azure-account-url <url>.", fix: "Pass one of the two." },
    { code: "missing-registry", means: "The mailroom needs its domain registry: --registry <file> or --registry-base64 <data>.", fix: "Pass one of the two." },
    { code: "bad-port", means: "A mailroom port flag isn't a whole number from 0 to 65535.", fix: "Pass --smtp-port and --http-port as plain port numbers." },
  ] } },
  { name: "node dist/nerves/coverage/cli-main.js", effect: "private", summary: "Audit nerves event coverage for a test run.", ax: { id: "cli:node dist/nerves/coverage/cli-main.js", group: "diagnostics", effect: "write", when: "After a test run: check every source file emitted its nerves events, writing nerves-coverage.json into the run.", errors: [
    { code: "no-run-dir", means: "The nerves audit found no test run: nothing was recorded and no --run-dir was given.", fix: "Run the tests first, or pass --run-dir with a run's folder." },
    { code: "audit-failed", means: "The nerves audit ran and some files are missing nerves events.", fix: "Read nerves-coverage.json for the files, and add the events they need." },
  ] } },
  { name: "node dist/nerves/review/cli-main.js", effect: "private", readOnly: true, summary: "Filter an agent's recent nerves events.", ax: { id: "cli:node dist/nerves/review/cli-main.js", group: "diagnostics", effect: "read", when: "Investigate what a running agent did lately: tail its nerves log, filtered by component, event, level or age.", errors: [
    { code: "bad-duration", means: "The nerves review's --since isn't a duration it reads.", fix: "Give --since as a number and unit, such as 5m, 2h or 1d." },
  ] } },
  { name: "node dist/senses/a2a-entry.js", effect: "private", summary: "Run an agent's A2A sense.", ax: { id: "cli:node dist/senses/a2a-entry.js", group: "entry-points", effect: "write", when: "The daemon starts it so other agents can reach this one over A2A; --port and --base-url set where it listens.", errors: [missingAgent("dist/senses/a2a-entry.js")] } },
  { name: "node dist/senses/app-sessions-entry.js", effect: "private", summary: "Run an agent's app-sessions sense.", ax: { id: "cli:node dist/senses/app-sessions-entry.js", group: "entry-points", effect: "write", when: "The daemon starts it to watch the coding app's sessions and send the owner a notice when one waits on a prompt.", errors: [missingAgent("dist/senses/app-sessions-entry.js")] } },
  { name: "node dist/senses/bluebubbles/entry.js", effect: "private", summary: "Run an agent's iMessage sense.", ax: { id: "cli:node dist/senses/bluebubbles/entry.js", group: "entry-points", effect: "write", when: "The daemon starts it on the iMessage host to carry messages between the BlueBubbles server and the agent.", errors: [missingAgent("dist/senses/bluebubbles/entry.js")] } },
  { name: "node dist/senses/cli-entry.js", effect: "private", summary: "Chat with an agent in this terminal.", ax: { id: "cli:node dist/senses/cli-entry.js", group: "entry-points", effect: "write", when: "The terminal chat behind ouro chat; start it directly only to talk to an agent without the daemon.", errors: [missingAgent("dist/senses/cli-entry.js")] } },
  { name: "node dist/senses/mail-entry.js", effect: "private", summary: "Run an agent's mail sense.", ax: { id: "cli:node dist/senses/mail-entry.js", group: "entry-points", effect: "write", when: "The daemon starts it to read the agent's mailbox and hand new mail to the agent.", errors: [missingAgent("dist/senses/mail-entry.js")] } },
  { name: PROBE, effect: "private", summary: "Run a Sanctuary health acceptance probe step.", ax: { id: `cli:${PROBE}`, group: "sanctuary-host", effect: "write", when: "The acceptance runner calls it with one step, run, stop, recover or finalize, for a recorded health scenario.", errors: [
    { code: "missing-mode", means: `${PROBE} was started with no step at all.`, fix: "Pass run, stop, recover or finalize, then the scenario's coordinates." },
    { code: "usage", means: `${PROBE} got a first word that isn't one of its steps.`, fix: "Start with run, stop, recover or finalize; the usage on stderr shows the rest." },
  ] } },
  { name: `${PROBE} run`, effect: "private", summary: "Run one health acceptance scenario.", ax: { id: `cli:${PROBE} run`, group: "sanctuary-host", effect: "write", when: "Inject the scenario's health fault into the agent's state and wait for the scheduler's receipt.", errors: [probeUsage("run")] } },
  { name: `${PROBE} stop`, effect: "private", summary: "Stop a running health acceptance probe.", ax: { id: `cli:${PROBE} stop`, group: "sanctuary-host", effect: "write", when: "End a probe run that's still going, for the same scenario coordinates it started with.", errors: [probeUsage("stop")] } },
  { name: `${PROBE} recover`, effect: "private", summary: "Restore state after a health probe.", ax: { id: `cli:${PROBE} recover`, group: "sanctuary-host", effect: "write", when: "After an interrupted probe: put the agent's health state back from the snapshot the run saved.", errors: [probeUsage("recover")] } },
  { name: `${PROBE} finalize`, effect: "private", summary: "Finish a health acceptance scenario.", ax: { id: `cli:${PROBE} finalize`, group: "sanctuary-host", effect: "write", when: "Close a scenario by proving the owner image and container after it, then clear the probe's workspace.", errors: [probeUsage("finalize")] } },
  { name: "node dist/eval/run-entry.js", effect: "private", summary: "Run the replay eval's cases on a model.", ax: { id: "cli:node dist/eval/run-entry.js", group: "diagnostics", effect: "consequential", confirm: "It spends model credits or premium requests on the account the flags name, up to the caps you pass.", when: "Measure a model on the replay eval's cases, writing a private report; every run reserves its worst-case spend first.", errors: [
    { code: "budget-stopped", means: "The eval stopped early: a run's reservation would pass a cap, or the provider answered 402 or 429. The report holds the runs that finished.", fix: "Read the summary on stdout. Raise the cap only if that spend is approved; the report keeps every finished run as measured, so a rerun adds runs rather than replacing them." },
    { code: "eval-error", means: "The eval refused to start or failed: a bad or missing flag, a case that fails its self-test, a report file that exists already, a target without its prices or caps, or a run that threw.", fix: "Read the `eval:` line above it on stderr, fix that, and run again with a new --output path." },
  ] } },
  { name: "node dist/eval/interview-entry.js", effect: "private", summary: "Run blind-interview sessions on a model.", ax: { id: "cli:node dist/eval/interview-entry.js", group: "diagnostics", effect: "consequential", confirm: "It spends model credits or premium requests on the account the flags name, up to the caps you pass, and a session it starts can never run again.", when: "Run the pre-registered blind-interview sessions on one model, writing a private report and request log; each session reserves its worst case first.", errors: [
    { code: "budget-stopped", means: "The study stopped: a session's reservation would pass a cap, or the provider answered 402 or 429. Later sessions are recorded as not run.", fix: "Read the counts on stdout; the study stays stopped, since a session that didn't run counts as ouro not chosen first." },
    { code: "eval-error", means: "The interviews refused to start (a bad flag, sandbox or target, a host lock already held by another holder or lost mid-run, or a session not allowed or already started) or failed after starting.", fix: "Read the `interviews:` line on stderr; sessions it began are in the started file and can't run again, so name the others with --session." },
  ] } },
  { name: "node dist/eval/watch-entry.js", effect: "private", summary: "Count a live agent's turns from its logs.", ax: { id: "cli:node dist/eval/watch-entry.js", group: "diagnostics", effect: "write", when: "See how a running agent's turns went by day and channel; it reads only new log lines and keeps its private rows outside the bundle.", errors: [
    { code: "usage", means: "Watch was started without --agent-root.", fix: "Pass --agent-root with the agent's bundle folder, such as ~/AgentBundles/<agent>.ouro." },
    { code: "watch-failed", means: "Watch refused or failed: its --out folder is inside a bundle or holds other files, a private file is a link, or a private write failed. The line above names only an error code.", fix: "Point --out at an empty folder outside ~/AgentBundles, or remove the link from the private folder, and run again." },
  ] } },
  { name: "node dist/senses/shepherd/judge-evaluation-entry.js", effect: "private", summary: "Evaluate Shepherd's judge on its cases.", ax: { id: "cli:node dist/senses/shepherd/judge-evaluation-entry.js", group: "diagnostics", effect: "write", when: "Measure how Shepherd's judge classifies its evaluation cases, writing a report; it never qualifies v1 on its own.", errors: [
    { code: "not-passed", means: "The Shepherd judge evaluation finished, but its classification didn't pass or closing its report threw.", fix: "Read the JSON summary on stdout and the report for the failing cases." },
    { code: "evaluation-error", means: "The Shepherd judge evaluation stopped before running a case (bad arguments, an output that exists already, no judge for the agent, or a bad case corpus), or writing its report threw.", fix: "Read the error in the JSON on stdout, fix it, and run again with a new --output path." },
    { code: "evaluation-crashed", means: "The Shepherd judge evaluation threw before it finished, outside its own checks; stderr's JSON holds what it threw.", fix: "Read the error in the JSON on stderr, fix its cause, and run it again." },
  ] } },
  { name: "node dist/senses/shepherd-entry.js", effect: "private", summary: "Run an agent's Shepherd sense.", ax: { id: "cli:node dist/senses/shepherd-entry.js", group: "entry-points", effect: "write", when: "The daemon starts it so Shepherd can drive the agent's coding sessions; use ouro shepherd for the actions.", errors: [missingAgent("dist/senses/shepherd-entry.js")] } },
  { name: "node dist/senses/teams-entry.js", effect: "private", summary: "Run an agent's Teams sense.", ax: { id: "cli:node dist/senses/teams-entry.js", group: "entry-points", effect: "write", when: "The daemon starts it once the bot's credentials load, so the agent answers in Microsoft Teams.", errors: [missingAgent("dist/senses/teams-entry.js")] } },
  { name: "node dist/senses/telegram-entry.js", effect: "private", summary: "Run an agent's Telegram sense.", ax: { id: "cli:node dist/senses/telegram-entry.js", group: "entry-points", effect: "write", when: "The daemon starts it so the agent answers its owner on Telegram through the bot token in its vault.", errors: [missingAgent("dist/senses/telegram-entry.js")] } },
  { name: "node dist/senses/voice-entry.js", effect: "private", summary: "Run an agent's voice sense.", ax: { id: "cli:node dist/senses/voice-entry.js", group: "entry-points", effect: "write", when: "The daemon starts it to run the voice transports attached on this machine, such as phone calls.", errors: [missingAgent("dist/senses/voice-entry.js")] } },
  { name: "node dist/senses/voice-realtime-eval-entry.js", effect: "private", readOnly: true, summary: "Grade the voice realtime evaluation suite.", ax: { id: "cli:node dist/senses/voice-realtime-eval-entry.js", group: "diagnostics", effect: "read", when: "Check voice behaviour offline: run the built-in scenarios, and grade recorded call traces passed with --trace.", errors: [
    { code: "eval-error", means: "The voice evaluation stopped before running: it got an unknown argument, or reading a --trace file threw.", fix: "Pass only --trace <file> pairs, pointing at trace files that exist." },
    { code: "eval-failed", means: "The voice evaluation ran and a scenario or trace didn't match what it expects.", fix: "Read expectedKnownBadFailed and happyPathPassed for the built-ins, and traceSummary.mismatchedScenarioIds for traces." },
  ] } },
  { name: "node dist/senses/voice-twilio-entry.js", effect: "private", summary: "Run a standalone Twilio phone bridge.", ax: { id: "cli:node dist/senses/voice-twilio-entry.js", group: "entry-points", effect: "write", when: "For local voice testing only: bridge Twilio calls to the agent through a tunnel given as --public-url.", errors: [missingAgent("dist/senses/voice-twilio-entry.js")] } },
]
