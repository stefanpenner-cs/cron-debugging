# cron-debugging

How GitHub Actions internally represents and executes cron schedules. Every claim backed by an API probe or workflow run.

All paths below are relative to `/repos/stefanpenner-cs/cron-debugging`. Full request/response details in [`api-endpoints.md`](api-endpoints.md).

## Findings

### Are cron schedules visible via the API?

**No.** The workflow object has no schedule field. You must parse the YAML or wait for a run and check `event.schedule`.

```sh
gh api repos/stefanpenner-cs/cron-debugging/actions/workflows/269650800
```

<details><summary>Response</summary>

```json
{
  "id": 269650800,
  "node_id": "W_kwDOSR7-S84QEotw",
  "name": "Cron: Basic Every 5 Min",
  "path": ".github/workflows/cron-basic.yml",
  "state": "active",
  "created_at": "2026-05-01T14:22:47.000-06:00",
  "updated_at": "2026-05-01T14:26:10.000-06:00",
  "url": "https://api.github.com/repos/stefanpenner-cs/cron-debugging/actions/workflows/269650800",
  "html_url": "https://github.com/stefanpenner-cs/cron-debugging/blob/main/.github/workflows/cron-basic.yml",
  "badge_url": "https://github.com/stefanpenner-cs/cron-debugging/workflows/Cron:%20Basic%20Every%205%20Min/badge.svg"
}
```

</details>

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

<details><summary>Response</summary>

```json
{
  "total_count": 0,
  "workflow_runs": []
}
```

</details>

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

<details><summary>Response</summary>

```json
{
  "id": 25231646672,
  "name": "Cron: Chained Alerting (workflow_run)",
  "node_id": "WFR_kwLOSR7-S88AAAAF3-xf0A",
  "head_branch": "main",
  "head_sha": "cafefe8b53d62300eec29114c3d28585ce357a67",
  "path": ".github/workflows/cron-chained-alerting.yml",
  "display_title": "Cron: Chained Alerting (workflow_run)",
  "run_number": 1,
  "event": "workflow_run",
  "status": "completed",
  "conclusion": "success",
  "workflow_id": 269650801,
  "check_suite_id": 67114071363,
  "check_suite_node_id": "CS_kwDOSR7-S88AAAAPoE91Qw",
  "url": "https://api.github.com/repos/stefanpenner-cs/cron-debugging/actions/runs/25231646672",
  "html_url": "https://github.com/stefanpenner-cs/cron-debugging/actions/runs/25231646672",
  "pull_requests": [],
  "created_at": "2026-05-01T20:25:17Z",
  "updated_at": "2026-05-01T20:25:35Z",
  "actor": {
    "login": "stefanpenner",
    "id": 1377,
    "node_id": "MDQ6VXNlcjEzNzc=",
    "avatar_url": "https://avatars.githubusercontent.com/u/1377?v=4",
    "gravatar_id": "",
    "url": "https://api.github.com/users/stefanpenner",
    "html_url": "https://github.com/stefanpenner",
    "followers_url": "https://api.github.com/users/stefanpenner/followers",
    "following_url": "https://api.github.com/users/stefanpenner/following{/other_user}",
    "gists_url": "https://api.github.com/users/stefanpenner/gists{/gist_id}",
    "starred_url": "https://api.github.com/users/stefanpenner/starred{/owner}{/repo}",
    "subscriptions_url": "https://api.github.com/users/stefanpenner/subscriptions",
    "organizations_url": "https://api.github.com/users/stefanpenner/orgs",
    "repos_url": "https://api.github.com/users/stefanpenner/repos",
    "events_url": "https://api.github.com/users/stefanpenner/events{/privacy}",
    "received_events_url": "https://api.github.com/users/stefanpenner/received_events",
    "type": "User",
    "user_view_type": "public",
    "site_admin": false
  },
  "run_attempt": 1,
  "referenced_workflows": [],
  "run_started_at": "2026-05-01T20:25:17Z",
  "triggering_actor": {
    "login": "stefanpenner",
    "id": 1377,
    "node_id": "MDQ6VXNlcjEzNzc=",
    "avatar_url": "https://avatars.githubusercontent.com/u/1377?v=4",
    "gravatar_id": "",
    "url": "https://api.github.com/users/stefanpenner",
    "html_url": "https://github.com/stefanpenner",
    "followers_url": "https://api.github.com/users/stefanpenner/followers",
    "following_url": "https://api.github.com/users/stefanpenner/following{/other_user}",
    "gists_url": "https://api.github.com/users/stefanpenner/gists{/gist_id}",
    "starred_url": "https://api.github.com/users/stefanpenner/starred{/owner}{/repo}",
    "subscriptions_url": "https://api.github.com/users/stefanpenner/subscriptions",
    "organizations_url": "https://api.github.com/users/stefanpenner/orgs",
    "repos_url": "https://api.github.com/users/stefanpenner/repos",
    "events_url": "https://api.github.com/users/stefanpenner/events{/privacy}",
    "received_events_url": "https://api.github.com/users/stefanpenner/received_events",
    "type": "User",
    "user_view_type": "public",
    "site_admin": false
  },
  "jobs_url": "https://api.github.com/repos/stefanpenner-cs/cron-debugging/actions/runs/25231646672/jobs",
  "logs_url": "https://api.github.com/repos/stefanpenner-cs/cron-debugging/actions/runs/25231646672/logs",
  "check_suite_url": "https://api.github.com/repos/stefanpenner-cs/cron-debugging/check-suites/67114071363",
  "artifacts_url": "https://api.github.com/repos/stefanpenner-cs/cron-debugging/actions/runs/25231646672/artifacts",
  "cancel_url": "https://api.github.com/repos/stefanpenner-cs/cron-debugging/actions/runs/25231646672/cancel",
  "rerun_url": "https://api.github.com/repos/stefanpenner-cs/cron-debugging/actions/runs/25231646672/rerun",
  "previous_attempt_url": null,
  "workflow_url": "https://api.github.com/repos/stefanpenner-cs/cron-debugging/actions/workflows/269650801",
  "head_commit": {
    "id": "cafefe8b53d62300eec29114c3d28585ce357a67",
    "tree_id": "647d851c5f4387f7751d2e6ce8f9e41d9abba19f",
    "message": "Add cron behavior probes for ownership, control, observability, and failure detection\n\n...",
    "timestamp": "2026-05-01T20:22:40Z",
    "author": {
      "name": "Stefan Penner",
      "email": "stef@iamstef.net"
    },
    "committer": {
      "name": "Stefan Penner",
      "email": "stef@iamstef.net"
    }
  },
  "repository": {
    "id": 1226767947,
    "node_id": "R_kgDOSR7-Sw",
    "name": "cron-debugging",
    "full_name": "stefanpenner-cs/cron-debugging",
    "private": true,
    "owner": {
      "login": "stefanpenner-cs",
      "id": 109183179,
      "type": "Organization"
    }
  },
  "head_repository": {
    "id": 1226767947,
    "node_id": "R_kgDOSR7-Sw",
    "name": "cron-debugging",
    "full_name": "stefanpenner-cs/cron-debugging",
    "private": true,
    "owner": {
      "login": "stefanpenner-cs",
      "id": 109183179,
      "type": "Organization"
    }
  }
}
```

</details>

[Evidence](api-endpoints.md#get-a-single-workflow-run) | [Run in UI](https://github.com/stefanpenner-cs/cron-debugging/actions/runs/25231646672)

### How do you see queue wait time?

Compare `created_at` vs `started_at` on the job. The gap is queue wait.

```sh
gh api repos/stefanpenner-cs/cron-debugging/actions/jobs/73988338415
```

<details><summary>Response</summary>

```json
{
  "id": 73988338415,
  "run_id": 25231646672,
  "workflow_name": "Cron: Chained Alerting (workflow_run)",
  "head_branch": "main",
  "run_url": "https://api.github.com/repos/stefanpenner-cs/cron-debugging/actions/runs/25231646672",
  "run_attempt": 1,
  "node_id": "CR_kwDOSR7-S88AAAAROgxy7w",
  "head_sha": "cafefe8b53d62300eec29114c3d28585ce357a67",
  "url": "https://api.github.com/repos/stefanpenner-cs/cron-debugging/actions/jobs/73988338415",
  "html_url": "https://github.com/stefanpenner-cs/cron-debugging/actions/runs/25231646672/job/73988338415",
  "status": "completed",
  "conclusion": "success",
  "created_at": "2026-05-01T20:25:18Z",
  "started_at": "2026-05-01T20:25:29Z",
  "completed_at": "2026-05-01T20:25:34Z",
  "name": "react-to-cron",
  "steps": [
    {
      "name": "Set up job",
      "status": "completed",
      "conclusion": "success",
      "number": 1,
      "started_at": "2026-05-01T20:25:30Z",
      "completed_at": "2026-05-01T20:25:30Z"
    },
    {
      "name": "Inspect the triggering workflow run",
      "status": "completed",
      "conclusion": "success",
      "number": 2,
      "started_at": "2026-05-01T20:25:30Z",
      "completed_at": "2026-05-01T20:25:31Z"
    },
    {
      "name": "Alert on failure",
      "status": "completed",
      "conclusion": "skipped",
      "number": 3,
      "started_at": "2026-05-01T20:25:31Z",
      "completed_at": "2026-05-01T20:25:31Z"
    },
    {
      "name": "Full github context",
      "status": "completed",
      "conclusion": "success",
      "number": 4,
      "started_at": "2026-05-01T20:25:31Z",
      "completed_at": "2026-05-01T20:25:31Z"
    },
    {
      "name": "Full event payload",
      "status": "completed",
      "conclusion": "success",
      "number": 5,
      "started_at": "2026-05-01T20:25:31Z",
      "completed_at": "2026-05-01T20:25:31Z"
    },
    {
      "name": "Complete job",
      "status": "completed",
      "conclusion": "success",
      "number": 6,
      "started_at": "2026-05-01T20:25:31Z",
      "completed_at": "2026-05-01T20:25:31Z"
    }
  ],
  "check_run_url": "https://api.github.com/repos/stefanpenner-cs/cron-debugging/check-runs/73988338415",
  "labels": [
    "ubuntu-latest"
  ],
  "runner_id": 1000000136,
  "runner_name": "GitHub Actions 1000000136",
  "runner_group_id": 0,
  "runner_group_name": "GitHub Actions"
}
```

</details>

11s queue wait. [Evidence](api-endpoints.md#get-a-single-job) | [Job in UI](https://github.com/stefanpenner-cs/cron-debugging/actions/runs/25231646672/job/73988338415)

### Does GitHub inject synthetic steps?

**Yes.** 4 user-defined steps → 6 returned. GitHub adds `"Set up job"` (step 1) and `"Complete job"` (last). Steps gated on `if:` conditions show `conclusion: "skipped"`.

```sh
gh api repos/stefanpenner-cs/cron-debugging/actions/jobs/73988338415 --jq '.steps'
```

<details><summary>Response</summary>

```json
[
  {
    "name": "Set up job",
    "status": "completed",
    "conclusion": "success",
    "number": 1,
    "started_at": "2026-05-01T20:25:30Z",
    "completed_at": "2026-05-01T20:25:30Z"
  },
  {
    "name": "Inspect the triggering workflow run",
    "status": "completed",
    "conclusion": "success",
    "number": 2,
    "started_at": "2026-05-01T20:25:30Z",
    "completed_at": "2026-05-01T20:25:31Z"
  },
  {
    "name": "Alert on failure",
    "status": "completed",
    "conclusion": "skipped",
    "number": 3,
    "started_at": "2026-05-01T20:25:31Z",
    "completed_at": "2026-05-01T20:25:31Z"
  },
  {
    "name": "Full github context",
    "status": "completed",
    "conclusion": "success",
    "number": 4,
    "started_at": "2026-05-01T20:25:31Z",
    "completed_at": "2026-05-01T20:25:31Z"
  },
  {
    "name": "Full event payload",
    "status": "completed",
    "conclusion": "success",
    "number": 5,
    "started_at": "2026-05-01T20:25:31Z",
    "completed_at": "2026-05-01T20:25:31Z"
  },
  {
    "name": "Complete job",
    "status": "completed",
    "conclusion": "success",
    "number": 6,
    "started_at": "2026-05-01T20:25:31Z",
    "completed_at": "2026-05-01T20:25:31Z"
  }
]
```

</details>

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

<details><summary>Response</summary>

```json
{
  "billable": {
    "UBUNTU": {
      "total_ms": 0,
      "jobs": 1,
      "job_runs": [
        {
          "job_id": 73988338415,
          "duration_ms": 0
        }
      ]
    }
  },
  "run_duration_ms": 18000
}
```

</details>

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

<details><summary>Response</summary>

```json
{
  "enabled": true,
  "allowed_actions": "all",
  "sha_pinning_required": false
}
```

</details>

```sh
gh api repos/stefanpenner-cs/cron-debugging/actions/permissions/workflow
```

<details><summary>Response</summary>

```json
{
  "default_workflow_permissions": "write",
  "can_approve_pull_request_reviews": false
}
```

</details>

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
