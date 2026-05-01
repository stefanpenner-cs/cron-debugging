# cron-debugging

How GitHub Actions internally represents and executes cron schedules. Every claim backed by an API probe or workflow run.

All paths below are relative to `/repos/stefanpenner-cs/cron-debugging`. Full request/response details in [`api-endpoints.md`](api-endpoints.md).

## Findings

### Are cron schedules visible via the API?

**No.** The workflow object has no schedule field. You must parse the YAML or wait for a run and check `event.schedule`.

```sh
gh api repos/stefanpenner-cs/cron-debugging/actions/workflows/269650800
```
```json
{ "id": 269650800, "name": "Cron: Basic Every 5 Min", "path": ".github/workflows/cron-basic.yml",
  "state": "active", "created_at": "...", "updated_at": "..." }
```
No cron expression anywhere in the response. [Full response](api-endpoints.md#get-a-single-workflow)

### Can you address a workflow by filename?

**Yes.** Both return identical bodies and the same ETag:

```sh
gh api repos/stefanpenner-cs/cron-debugging/actions/workflows/269650800
gh api repos/stefanpenner-cs/cron-debugging/actions/workflows/cron-basic.yml
```
Both → `200`, ETag: `W/"454f5525e904fb95bad4ea8303eaa14d5e53001bfb2360041eea8d3650d589e9"`. [Evidence](api-endpoints.md#get-workflow-by-filename)

### How do you detect if crons are firing?

Filter runs by `event=schedule`. Zero results = crons haven't fired.

```sh
gh api repos/stefanpenner-cs/cron-debugging/actions/runs?event=schedule\&per_page=3
```
```json
{ "total_count": 0, "workflow_runs": [] }
```
[Evidence](api-endpoints.md#list-workflow-runs-schedule-only)

### What does the workflow state machine look like?

```
"active" ──disable──► "disabled_manually"  (204)
"disabled_manually" ──enable──► "active"   (204)
"active" ──(60 days no push)──► "disabled_inactivity"  (docs, not yet testable)
```

```sh
gh api -X PUT repos/stefanpenner-cs/cron-debugging/actions/workflows/269650800/disable
gh api -X PUT repos/stefanpenner-cs/cron-debugging/actions/workflows/269650800/enable
```

Both disable and enable are idempotent, return 204 with empty body. [Disable](api-endpoints.md#disable-a-workflow) | [Enable](api-endpoints.md#enable-a-workflow)

### Who is the `actor` on a workflow run?

`actor` and `triggering_actor` are **full User objects** (19 keys), not strings. For dispatch and chained (`workflow_run`) events, both point to the user who initiated the chain.

```sh
gh api repos/stefanpenner-cs/cron-debugging/actions/runs/25231646672
```
```json
{ "event": "workflow_run", "actor": "{19-key User object}", "triggering_actor": "{19-key User object}" }
```
[Evidence](api-endpoints.md#get-a-single-workflow-run) | [Run in UI](https://github.com/stefanpenner-cs/cron-debugging/actions/runs/25231646672)

### How do you see queue wait time?

Compare `created_at` vs `started_at` on the job. The gap is queue wait.

```sh
gh api repos/stefanpenner-cs/cron-debugging/actions/jobs/73988338415
```
```json
{ "created_at": "2026-05-01T20:25:18Z", "started_at": "2026-05-01T20:25:29Z",
  "completed_at": "2026-05-01T20:25:34Z", "runner_id": 1000000136,
  "runner_name": "GitHub Actions 1000000136", "labels": ["ubuntu-latest"] }
```
11s queue wait. [Evidence](api-endpoints.md#get-a-single-job) | [Job in UI](https://github.com/stefanpenner-cs/cron-debugging/actions/runs/25231646672/job/73988338415)

### Does GitHub inject synthetic steps?

**Yes.** 4 user-defined steps → 6 returned. GitHub adds `"Set up job"` (step 1) and `"Complete job"` (last). Steps gated on `if:` conditions show `conclusion: "skipped"`.

```sh
gh api repos/stefanpenner-cs/cron-debugging/actions/jobs/73988338415 --jq '.steps'
```
[Evidence](api-endpoints.md#get-a-single-job)

### How do logs work?

Zip download. 404 if the run isn't complete yet. Served from a different backend (`x-github-backend: Kubernetes`).

```sh
gh api repos/stefanpenner-cs/cron-debugging/actions/runs/25231646672/logs > logs.zip
```
```
Content-Disposition: attachment; filename=logs_67114071363.zip
Content-Type: application/zip
```
[Evidence](api-endpoints.md#download-workflow-run-logs)

### How do you get billing/timing info?

```sh
gh api repos/stefanpenner-cs/cron-debugging/actions/runs/25231646672/timing
```
```json
{ "run_duration_ms": 18000, "billable": { "UBUNTU": { "total_ms": 0, "jobs": 1 } } }
```
Billable can be 0 for short runs / free tier. [Evidence](api-endpoints.md#get-workflow-run-usagetiming)

### Is `POST /dispatches` deprecated?

**Yes.** Response headers confirm:

```sh
gh api -X POST repos/stefanpenner-cs/cron-debugging/actions/workflows/269650800/dispatches -f ref=main
```
```
204 (empty body)
deprecation: Tue, 10 Mar 2026 00:00:00 GMT
sunset: Fri, 10 Mar 2028 00:00:00 GMT
```
No run ID returned — you must poll `/actions/runs` to find the new run. [Evidence](api-endpoints.md#create-workflow-dispatch-event)

### Does `workflow_run` chaining work?

**Yes.** Basic workflow completed at ~20:25:15, chained alerting created at 20:25:17 (2s latency).

[Basic run](https://github.com/stefanpenner-cs/cron-debugging/actions/runs/25231636888) | [Chained run](https://github.com/stefanpenner-cs/cron-debugging/actions/runs/25231646672)

### What are the default token permissions?

```sh
gh api repos/stefanpenner-cs/cron-debugging/actions/permissions
```
```json
{ "enabled": true, "allowed_actions": "all", "sha_pinning_required": false }
```

```sh
gh api repos/stefanpenner-cs/cron-debugging/actions/permissions/workflow
```
```json
{ "default_workflow_permissions": "write", "can_approve_pull_request_reviews": false }
```
[Permissions](api-endpoints.md#get-default-workflow-permissions) | [Token](api-endpoints.md#get-default-github_token-permissions)

### How does pagination work?

`Link` header with `rel="next"` / `rel="last"`. URLs use the numeric repo ID, not the slug.

```sh
gh api repos/stefanpenner-cs/cron-debugging/actions/runs?per_page=3 --include 2>&1 | grep -i link
```
```
link: <https://api.github.com/repositories/1226767947/actions/runs?per_page=3&page=2>; rel="next", ...
```
[Evidence](api-endpoints.md#list-workflow-runs-for-repo)

### Caching behavior?

All GETs: `cache-control: private, max-age=60, s-maxage=60` + ETag + Vary.
All writes (PUT/POST): no cache headers. [Evidence](api-endpoints.md)

## Not yet verified

Requires actual `event: "schedule"` runs:

- `github.event.schedule` contains the cron expression that fired
- `actor` for schedule runs = last committer to the workflow file
- Multi-schedule: `event.schedule` distinguishes which expression fired
- 60-day inactivity auto-disable (`state: "disabled_inactivity"`)

## Workflows

| File | Purpose |
|------|---------|
| [`cron-basic.yml`](.github/workflows/cron-basic.yml) | Dumps full event context every 5 min |
| [`cron-multi-schedule.yml`](.github/workflows/cron-multi-schedule.yml) | Tests which cron expression fired |
| [`cron-ownership-test.yml`](.github/workflows/cron-ownership-test.yml) | Actor/ownership attribution |
| [`cron-staleness-monitor.yml`](.github/workflows/cron-staleness-monitor.yml) | Hourly: have other crons fired recently? |
| [`cron-chained-alerting.yml`](.github/workflows/cron-chained-alerting.yml) | `workflow_run` trigger for failure alerting |
| [`cron-control-api.yml`](.github/workflows/cron-control-api.yml) | Manual dispatch: list workflows, parse schedules |
| [`cron-health-check.yml`](.github/workflows/cron-health-check.yml) | Manual dispatch: full diagnostic |
| [`cron-token-permissions.yml`](.github/workflows/cron-token-permissions.yml) | GITHUB_TOKEN permission scoping under cron |

## Probe

```sh
npm run probe    # hits 18 endpoints, regenerates api-endpoints.md
```

Uses `gh auth token`; override with `GH_TOKEN` env var.
