const assert = require("node:assert/strict")
const { readFileSync } = require("node:fs")
const { join } = require("node:path")
const { test } = require("node:test")
const { runInNewContext } = require("node:vm")
const { recoverCancelledChecks } = require("./recover-cancelled-checks.cjs")

function fixture() {
  const run = {
    id: 50, workflow_id: 20, run_attempt: 1, check_suite_id: 90,
    event: "pull_request", status: "completed", conclusion: "cancelled",
    head_sha: "current", repository: { full_name: "ourostack/ouroboros" },
    pull_requests: [{ number: 1388 }],
  }
  const state = {
    run,
    pr: {
      number: 1388, state: "open", draft: false, auto_merge: {},
      head: { sha: "current" }, base: { ref: "main" },
    },
    jobs: [{ name: "prepass", conclusion: "cancelled", steps: [] }],
    checks: [{
      name: "coverage", status: "completed", conclusion: "cancelled", head_sha: "current",
      check_suite: { id: 90 }, app: { id: 15368 },
    }],
    branch: { protection: { required_status_checks: { checks: [{ context: "coverage", app_id: 15368 }] } } },
    rules: [],
    runs: [run],
    reruns: [],
  }
  let runReads = 0
  let prReads = 0
  const github = {
    rest: {
      actions: {
        getWorkflowRun: async () => ({ data: (++runReads > 1 && state.nextRun) || state.run }),
        listJobsForWorkflowRunAttempt: async (params) => {
          assert.equal(params.attempt_number, 1)
          return { data: state.jobs }
        },
        listWorkflowRuns: async () => ({ data: state.runs }),
        reRunWorkflow: async (params) => { state.reruns.push(params) },
      },
      pulls: { get: async () => ({ data: (++prReads > 1 && state.nextPr) || state.pr }) },
      repos: { getBranch: async () => ({ data: state.branch }) },
      checks: { listForRef: async () => ({ data: state.checks }) },
    },
    request: async (route) => {
      assert.equal(route, "GET /repos/{owner}/{repo}/rules/branches/{branch}")
      return { data: state.rules }
    },
    paginate: async (method, params) => (await method(params)).data,
  }
  const context = {
    eventName: "workflow_run", repo: { owner: "ourostack", repo: "ouroboros" },
    payload: { workflow_run: structuredClone(run) },
  }
  return { state, github, context, core: { info() {} } }
}

test("recovers a genuinely cancelled required check once, using the original run", async () => {
  const input = fixture()
  assert.equal((await recoverCancelledChecks(input)).outcome, "rerun")
  assert.deepEqual(input.state.reruns, [{ owner: "ourostack", repo: "ouroboros", run_id: 50 }])
})

for (const [name, change] of [
  ["disarmed PR", (s) => { s.pr.auto_merge = null }],
  ["draft PR", (s) => { s.pr.draft = true }],
  ["closed PR", (s) => { s.pr.state = "closed" }],
  ["old head", (s) => { s.pr.head.sha = "new" }],
  ["previous recovery or manual rerun", (s) => { s.run.run_attempt = 2 }],
  ["non-PR run", (s) => { s.run.event = "push" }],
  ["merge queue run, which the queue rebuilds itself", (s) => { s.run.event = "merge_group" }],
  ["foreign repository", (s) => { s.run.repository.full_name = "elsewhere/repo" }],
  ["unassociated PR", (s) => { s.run.pull_requests = [] }],
  ["ambiguous PR association", (s) => { s.run.pull_requests.push({ number: 1389 }) }],
  ["invalid PR association", (s) => { s.run.pull_requests[0].number = "1388" }],
  ["failed run", (s) => { s.run.conclusion = "failure" }],
  ["still running", (s) => { s.run.status = "in_progress" }],
  ["no cancelled required check", (s) => { s.checks[0].name = "optional" }],
  ["different required-check app", (s) => { s.checks[0].app.id = 42 }],
  ["old check suite", (s) => { s.checks[0].check_suite.id = 89 }],
  ["old check head", (s) => { s.checks[0].head_sha = "old" }],
  ["pending required check", (s) => { s.checks[0].status = "in_progress" }],
  ["job failure", (s) => { s.jobs[0].conclusion = "failure" }],
  ["job timeout", (s) => { s.jobs[0].conclusion = "timed_out" }],
  ["no job evidence", (s) => { s.jobs = [] }],
  ["newer run for this PR/head", (s) => { s.runs.push({ ...s.run, id: 51 }) }],
  ["newer same-head run with unknown PR association", (s) => {
    s.runs.push({ ...s.run, id: 51, pull_requests: [] })
  }],
  ["head moved during inspection", (s) => { s.nextPr = { ...s.pr, head: { sha: "new" } } }],
  ["disarmed during inspection", (s) => { s.nextPr = { ...s.pr, auto_merge: null } }],
  ["target branch changed during inspection", (s) => {
    s.nextPr = { ...s.pr, base: { ref: "other-target" } }
  }],
  ["run already restarted during inspection", (s) => { s.nextRun = { ...s.run, run_attempt: 2 } }],
]) {
  test(`does not recover: ${name}`, async () => {
    const input = fixture()
    change(input.state)
    assert.equal((await recoverCancelledChecks(input)).outcome, "skipped")
    assert.deepEqual(input.state.reruns, [])
  })
}

test("does not mistake a failed preflight's self-cancelled jobs for a recoverable cancellation", async () => {
  const input = fixture()
  input.state.jobs[0].steps = [
    { name: "Release preflight (PRs only)", conclusion: "failure" },
    { name: "Stop the run early on a failed pre-pass (PRs only)", conclusion: "success" },
  ]
  const result = await recoverCancelledChecks(input)
  assert.equal(result.outcome, "skipped")
  assert.match(result.reason, /failed gate/)
  assert.deepEqual(input.state.reruns, [])
})

test("does not retry while another required check has genuinely failed", async () => {
  const input = fixture()
  input.state.checks.push({ ...input.state.checks[0], name: "xray", conclusion: "failure" })
  input.state.branch.protection.required_status_checks.checks.push({ context: "xray", app_id: 15368 })
  assert.equal((await recoverCancelledChecks(input)).outcome, "skipped")
  assert.deepEqual(input.state.reruns, [])
})

test("recognizes ruleset-required checks without branch protection", async () => {
  const input = fixture()
  input.state.branch = {}
  input.state.rules = [{
    type: "required_status_checks",
    parameters: { required_status_checks: [{ context: "coverage", integration_id: 15368 }] },
  }]
  assert.equal((await recoverCancelledChecks(input)).outcome, "rerun")
})

test("supports required legacy contexts without an app restriction", async () => {
  const input = fixture()
  input.state.branch.protection.required_status_checks = { contexts: ["coverage"] }
  assert.equal((await recoverCancelledChecks(input)).outcome, "rerun")
})

test("does not recover when neither protection nor rulesets require the cancelled check", async () => {
  const input = fixture()
  input.state.branch = {}
  assert.equal((await recoverCancelledChecks(input)).outcome, "skipped")
  assert.deepEqual(input.state.reruns, [])
})

test("does not treat a PR test invocation as a privileged completion event", async () => {
  const input = fixture()
  input.context.eventName = "pull_request"
  assert.equal((await recoverCancelledChecks(input)).outcome, "skipped")
  assert.deepEqual(input.state.reruns, [])
})

test("a newer run of a different PR does not block this lineage", async () => {
  const input = fixture()
  input.state.runs.push({ ...input.state.run, id: 51, pull_requests: [{ number: 1389 }] })
  assert.equal((await recoverCancelledChecks(input)).outcome, "rerun")
})

test("the rerun endpoint's incremented attempt consumes this lineage's entire recovery budget", async () => {
  const input = fixture()
  input.github.rest.actions.reRunWorkflow = async (params) => {
    input.state.reruns.push(params)
    input.state.run = { ...input.state.run, run_attempt: 2 }
  }
  assert.equal((await recoverCancelledChecks(input)).outcome, "rerun")
  assert.equal((await recoverCancelledChecks(input)).outcome, "skipped")
  assert.equal(input.state.reruns.length, 1)
})

test("surfaces API errors without retrying or reporting a successful recovery", async () => {
  const input = fixture()
  input.github.rest.actions.reRunWorkflow = async () => { throw new Error("forbidden") }
  await assert.rejects(recoverCancelledChecks(input), /forbidden/)
})

test("coverage concurrency only supersedes runs belonging to the same PR", () => {
  const workflow = readFileSync(join(__dirname, "../workflows/coverage.yml"), "utf8")
  const group = workflow.match(/^  group: (.+)$/m)[1]
  const cancel = workflow.match(/^  cancel-in-progress: \$\{\{ (.+) \}\}$/m)[1]
  const context = (number, run_id, event_name = "pull_request") => ({
    workflow: "coverage-gate", event: { pull_request: { number } }, run_id, event_name,
  })
  const render = (github) => group.replace(/\$\{\{ (.+?) \}\}/g,
    (_, expression) => runInNewContext(expression, { github }))
  assert.equal(render(context(1, 100)), render(context(1, 101)))
  assert.notEqual(render(context(1, 100)), render(context(2, 101)))
  assert.notEqual(render(context(1, 100)), render(context(null, 101, "push")))
  assert.notEqual(render(context(null, 100, "push")), render(context(null, 101, "push")))
  assert.equal(runInNewContext(cancel, { github: context(1, 100) }), true)
  assert.equal(runInNewContext(cancel, { github: context(null, 100, "push") }), false)
  // Each merge queue build has its own group and is never cancelled by another.
  const queued = (run_id) => context(null, run_id, "merge_group")
  assert.notEqual(render(queued(100)), render(queued(101)))
  assert.notEqual(render(queued(100)), render(context(1, 101)))
  assert.equal(runInNewContext(cancel, { github: queued(100) }), false)
})

test("elevated recovery executes only trusted default-branch code, never PR artifacts", () => {
  const workflow = readFileSync(join(__dirname, "../workflows/recover-cancelled-checks.yml"), "utf8")
  assert.match(workflow, /workflow_run:/)
  assert.match(workflow, /types: \[completed\]/)
  assert.match(workflow, /group: recover-cancelled-\$\{\{ github.event.workflow_run.id \}\}/)
  assert.match(workflow, /cancel-in-progress: false/)
  assert.match(workflow, /ref: \$\{\{ github.event.repository.default_branch \}\}/)
  assert.match(workflow, /persist-credentials: false/)
  assert.match(workflow, /actions: write/)
  assert.doesNotMatch(workflow, /head_sha|head_branch|pull_request_target|download-artifact|secrets\./)
})
