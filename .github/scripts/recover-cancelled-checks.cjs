const FAILED = new Set(["failure", "timed_out", "action_required", "startup_failure"])

async function recoverCancelledChecks({ github, context, core }) {
  const repo = context.repo
  const skip = (reason) => {
    core.info(`Cancellation recovery skipped: ${reason}`)
    return { outcome: "skipped", reason }
  }
  if (context.eventName !== "workflow_run") return skip("not a workflow completion")
  const runId = context.payload.workflow_run.id
  const readRun = async () => (await github.rest.actions.getWorkflowRun({ ...repo, run_id: runId })).data
  const run = await readRun()
  const runEligible = (candidate) =>
    candidate.id === runId &&
    candidate.repository?.full_name === `${repo.owner}/${repo.repo}` &&
    candidate.event === "pull_request" &&
    candidate.status === "completed" &&
    candidate.conclusion === "cancelled" &&
    candidate.run_attempt === 1
  if (!runEligible(run)) return skip("not an original cancelled PR run in this repository")
  if (run.pull_requests?.length !== 1) return skip("missing or ambiguous pull request association")
  const number = run.pull_requests[0].number
  if (!Number.isSafeInteger(number) || number < 1) return skip("invalid pull request association")
  const readPr = async () => (await github.rest.pulls.get({ ...repo, pull_number: number })).data
  const pr = await readPr()
  const prEligible = (candidate) =>
    candidate.state === "open" && !candidate.draft && Boolean(candidate.auto_merge) &&
    candidate.head.sha === run.head_sha && candidate.base.ref === pr.base.ref
  if (!prEligible(pr)) return skip("pull request is not armed at this head")

  const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRunAttempt, {
    ...repo, run_id: run.id, attempt_number: run.run_attempt, per_page: 100,
  })
  // Cancelling the whole run after preflight fails also labels that failed job
  // "cancelled". Its step conclusions retain the failure and must veto recovery.
  if (jobs.length === 0) return skip("missing job evidence")
  if (jobs.some((job) => FAILED.has(job.conclusion) ||
    job.steps?.some((step) => FAILED.has(step.conclusion)))) {
    return skip("failed gate in the cancelled run")
  }

  const branch = (await github.rest.repos.getBranch({ ...repo, branch: pr.base.ref })).data
  const rules = (await github.request("GET /repos/{owner}/{repo}/rules/branches/{branch}", {
    ...repo, branch: pr.base.ref,
  })).data
  const protection = branch.protection?.required_status_checks
  const required = [
    ...(protection?.checks ?? protection?.contexts?.map((name) => ({ context: name })) ?? []),
    ...rules.filter((rule) => rule.type === "required_status_checks")
      .flatMap((rule) => rule.parameters.required_status_checks.map((check) => ({
        context: check.context, app_id: check.integration_id,
      }))),
  ]
  const isRequired = (check) => required.some((rule) =>
    rule.context === check.name &&
    (rule.app_id == null || rule.app_id === -1 || rule.app_id === check.app?.id))
  const checks = await github.paginate(github.rest.checks.listForRef, {
    ...repo, ref: pr.head.sha, filter: "latest", per_page: 100,
  })
  const currentChecks = checks.filter((check) => check.head_sha === pr.head.sha && isRequired(check))
  if (currentChecks.some((check) => FAILED.has(check.conclusion))) return skip("another required gate failed")
  if (!currentChecks.some((check) => check.check_suite?.id === run.check_suite_id &&
    check.status === "completed" && check.conclusion === "cancelled")) {
    return skip("no cancelled required check belongs to this run")
  }
  const runs = await github.paginate(github.rest.actions.listWorkflowRuns, {
    ...repo, workflow_id: run.workflow_id, head_sha: run.head_sha, event: "pull_request", per_page: 100,
  })
  if (runs.some((candidate) => candidate.id > run.id && candidate.head_sha === run.head_sha &&
    (!candidate.pull_requests?.length || candidate.pull_requests.some((pull) => pull.number === number)))) {
    return skip("a newer run already covers this PR head")
  }

  // The workflow serializes completion deliveries by run id. Re-read just before
  // writing: a manual retry, new head, or disarm during inspection wins.
  if (!prEligible(await readPr()) || !runEligible(await readRun())) {
    return skip("pull request or run changed during inspection")
  }
  await github.rest.actions.reRunWorkflow({ ...repo, run_id: run.id })
  core.info(`Cancellation recovery requested for run ${run.id}, attempt 1; later attempts are ineligible`)
  return { outcome: "rerun", runId: run.id }
}

module.exports = { recoverCancelledChecks }
