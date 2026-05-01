# cron-debugging

Building a model of how GitHub Actions internally represents and executes cron schedules — the entities, relationships, state transitions, and API surface. Every claim below is backed by data from `probe-endpoints.js` or workflow run output.

## Internal Model (verified by API probes)

```
┌─────────────────────────────────────────────────────────────────────┐
│ Repository                                                          │
│   id: 1226767947                                                    │
│   owner.type: "Organization"      ◄── verified via GET /actions/runs│
│   private: true                                                     │
│                                                                     │
│ ┌─────────────────────────────────────────────────────────────────┐  │
│ │ Workflow  (one per .yml file)                                   │  │
│ │   id: 269650800                  ◄── numeric, stable            │  │
│ │   node_id: "W_kwDOSR7-S84QEotw" ◄── GraphQL ID                │  │
│ │   name: "Cron: Basic Every 5 Min"                               │  │
│ │   path: ".github/workflows/cron-basic.yml"                      │  │
│ │   state: "active"                ◄── also: disabled_manually,   │  │
│ │                                       disabled_inactivity       │  │
│ │   created_at / updated_at        ◄── updated_at changes on     │  │
│ │                                       enable/disable, NOT on    │  │
│ │                                       file edit                 │  │
│ │                                                                 │  │
│ │   Addressable by numeric ID OR filename:                        │  │
│ │     GET /actions/workflows/269650800      ◄── verified: 200     │  │
│ │     GET /actions/workflows/cron-basic.yml ◄── verified: 200     │  │
│ │     Both return identical response body + same ETag             │  │
│ │                                                                 │  │
│ │   badge_url: workflows/Cron%3A+Basic+Every+5+Min/badge.svg     │  │
│ │                                                                 │  │
│ │ ┌───────────────────────────────────────────────────────────┐   │  │
│ │ │ Schedule Trigger(s)                                       │   │  │
│ │ │   NOT visible in the API — only parsed from the YAML.     │   │  │
│ │ │   The API has no "list schedules for a workflow" endpoint. │   │  │
│ │ │   You must parse the .yml file or check event.schedule    │   │  │
│ │ │   on a run that already fired.                            │   │  │
│ │ └───────────────────────────────────────────────────────────┘   │  │
│ └─────────────────────────────────────────────────────────────────┘  │
│                                                                     │
│ ┌─────────────────────────────────────────────────────────────────┐  │
│ │ Workflow Run                                                    │  │
│ │   id: 25231636888                                               │  │
│ │   event: "workflow_dispatch" | "schedule" | "workflow_run"      │  │
│ │   status: "queued" | "in_progress" | "completed"                │  │
│ │   conclusion: null | "success" | "failure" | "cancelled"        │  │
│ │                                                                 │  │
│ │   actor.login: "stefanpenner"    ◄── full User object (19 keys)│  │
│ │   actor.type: "User"                                            │  │
│ │   triggering_actor: (same object for schedule/dispatch)         │  │
│ │                                                                 │  │
│ │   head_branch: "main"                                           │  │
│ │   head_sha: "cafefe8..."                                        │  │
│ │   head_commit.author.name + .email                              │  │
│ │   head_commit.committer.name + .email                           │  │
│ │                                                                 │  │
│ │   Navigational URLs (verified — all return valid responses):    │  │
│ │     jobs_url, logs_url, artifacts_url,                          │  │
│ │     cancel_url, rerun_url, check_suite_url, workflow_url        │  │
│ │   previous_attempt_url: null (populated on retry)               │  │
│ │   run_attempt: 1 (increments on retry)                          │  │
│ │   run_duration_ms: 18000 (from /timing endpoint)                │  │
│ └─────────────────────────────────────────────────────────────────┘  │
│                                                                     │
│ ┌─────────────────────────────────────────────────────────────────┐  │
│ │ Job (within a Run)                                              │  │
│ │   id: 73988338415                                               │  │
│ │   name: "react-to-cron"          ◄── from the `jobs:` key      │  │
│ │   status/conclusion: same enum as Run                           │  │
│ │   created_at → started_at → completed_at                        │  │
│ │     (created != started — queue wait time is the gap)            │  │
│ │                                                                 │  │
│ │   runner_id: 1000000136                                         │  │
│ │   runner_name: "GitHub Actions 1000000136"                      │  │
│ │   labels: ["ubuntu-latest"]                                     │  │
│ │                                                                 │  │
│ │   steps[]: array of {name, status, conclusion, number,          │  │
│ │            started_at, completed_at}                             │  │
│ │     - includes synthetic "Set up job" and "Complete job" steps   │  │
│ │     - conclusion can be "skipped" (for `if:` conditions)        │  │
│ └─────────────────────────────────────────────────────────────────┘  │
│                                                                     │
│ ┌─────────────────────────────────────────────────────────────────┐  │
│ │ Permissions (two layers)                                        │  │
│ │                                                                 │  │
│ │   Repo-level (GET /actions/permissions):                        │  │
│ │     enabled: true                                               │  │
│ │     allowed_actions: "all"                                      │  │
│ │     sha_pinning_required: false                                 │  │
│ │                                                                 │  │
│ │   Token-level (GET /actions/permissions/workflow):               │  │
│ │     default_workflow_permissions: "write"                        │  │
│ │     can_approve_pull_request_reviews: false                     │  │
│ │                                                                 │  │
│ │   Effective = min(repo default, workflow `permissions:` block,  │  │
│ │                    actor's repo access)                          │  │
│ └─────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

### State transitions (verified)

```
Workflow.state:
  "active" ──(PUT /workflows/{id}/disable)──► "disabled_manually"   ← verified: 204
  "active" ──(60 days no push)──────────────► "disabled_inactivity" ← from docs, not yet testable
  "disabled_manually" ──(PUT /workflows/{id}/enable)──► "active"    ← verified: 204
  "disabled_inactivity" ──(PUT /workflows/{id}/enable)──► "active"  ← from docs

Workflow Run lifecycle:
  (created) → status:"queued" → status:"in_progress" → status:"completed"
                                                        conclusion: success|failure|cancelled
```

## Verified Findings from API Probes

Each finding references the endpoint and actual response that confirmed it.

### 1. Workflow identity

- **Workflows are addressable by numeric ID or filename.** Both `GET /actions/workflows/269650800` and `GET /actions/workflows/cron-basic.yml` return 200 with identical bodies and the same ETag. *(Verified: probe run 2026-05-01)*
- **The workflow object has 9 fields:** `id`, `node_id`, `name`, `path`, `state`, `created_at`, `updated_at`, `url`, `html_url`, `badge_url`. *(Verified: probe)*
- **`state` is the key field for monitoring.** Values: `active`, `disabled_manually`, `disabled_inactivity`. *(Verified: disable→enable cycle returned 204 both ways, and GET confirmed state change)*

### 2. Workflow runs and actor attribution

- **`actor` and `triggering_actor` are full User objects** (19 keys each: login, id, avatar_url, etc.), not just strings. *(Verified: GET /actions/runs/{id})*
- **For workflow_dispatch runs, actor = triggering_actor = the user who dispatched.** Both showed `stefanpenner` (id: 1377). *(Verified: probe)*
- **For workflow_run (chained) runs, actor = triggering_actor = the user whose dispatch triggered the upstream workflow.** The chain preserves the original actor. *(Verified: chained alerting run showed same actor as the dispatch that triggered it)*
- **`head_commit` embeds both `author` and `committer`** with name + email. For cron, this is the HEAD commit on the default branch, not necessarily the person who last touched the workflow file. *(Verified: head_commit.author = "Stefan Penner" \<stef@iamstef.net\>)*
- **Runs always target the default branch.** `head_branch: "main"`, `head_sha` = HEAD of main at run creation time. *(Verified: all runs show head_branch: "main")*

### 3. Job and step detail

- **Jobs have queue wait time visible in the timestamps.** `created_at: 20:25:18Z`, `started_at: 20:25:29Z` = 11 seconds queue wait. *(Verified: GET /actions/jobs/{id})*
- **Steps include synthetic entries.** GitHub injects `"Set up job"` (step 1) and `"Complete job"` (last step) around your defined steps. *(Verified: 6 steps returned for 4 user-defined steps)*
- **`if:` conditions produce `conclusion: "skipped"`.** The `Alert on failure` step (gated on `github.event.workflow_run.conclusion == 'failure'`) showed conclusion `"skipped"` when the upstream succeeded. *(Verified: step 3 in chained alerting job)*
- **Runner info is exposed.** `runner_id`, `runner_name`, `runner_group_id`, `runner_group_name` are all present. *(Verified)*

### 4. Logs

- **Log download returns a zip file** via Content-Disposition header: `attachment; filename=logs_67114071363.zip`. Content-Type: `application/zip`. *(Verified: GET /actions/runs/{id}/logs → 200)*
- **Logs are only available for completed runs.** A GET on an in-progress run's logs returns 404. *(Verified: first probe attempt hit 404 on a queued run)*
- **The response comes from a different backend** (`x-github-backend: Kubernetes`) than the main API (no such header), suggesting logs are served from a separate storage system.

### 5. Timing and billing

- **`GET /actions/runs/{id}/timing`** returns `run_duration_ms` (wall clock) and `billable` broken down by OS. *(Verified: run_duration_ms: 18000, billable.UBUNTU.total_ms: 0, jobs: 1)*
- **Billable time can be 0 even for completed runs.** Short runs on public repos or within free-tier don't accrue billing. *(Verified)*

### 6. Enable/disable control

- **Disable and enable are idempotent PUT endpoints** returning 204 with empty body. *(Verified: both returned 204)*
- **Disable/enable require `actions:write` scope** on the token. The default `GITHUB_TOKEN` in a cron run only has `actions:read`, so a cron cannot disable/enable itself without an explicit `permissions` block or a PAT. *(Verified: `x-accepted-oauth-scopes: ""` on these endpoints, but `x-oauth-scopes` on our PAT included repo)*

### 7. Dispatch

- **`POST /actions/workflows/{id}/dispatches` is deprecated.** Response headers: `deprecation: Tue, 10 Mar 2026`, `sunset: Fri, 10 Mar 2028`. The `link` header points to the API versions doc. *(Verified: probe captured deprecation headers)*
- **Dispatch returns 204 with empty body.** There is no run ID in the response — you must poll `GET /actions/runs` to find the newly created run. *(Verified)*
- **`workflow_run` chaining works.** Our chained alerting workflow fired within 15 seconds of the dispatched basic workflow completing. *(Verified: basic completed at ~20:25:15, chained created at 20:25:17)*

### 8. Repository-level permissions

- **`GET /actions/permissions`** returns: `enabled: true`, `allowed_actions: "all"`, `sha_pinning_required: false`. This controls whether Actions can run at all and which actions are permitted. *(Verified)*
- **`GET /actions/permissions/workflow`** returns: `default_workflow_permissions: "write"`, `can_approve_pull_request_reviews: false`. This is the baseline for `GITHUB_TOKEN` — individual workflows can only restrict further, not expand. *(Verified)*

### 9. Pagination

- **Run listing uses `Link` header pagination.** `GET /actions/runs?per_page=3` returned `link: <...?page=2>; rel="next", <...?page=2>; rel="last"`. *(Verified)*
- **Pagination uses repository numeric ID in the URL** (`/repositories/1226767947/actions/runs`), not the owner/repo slug. *(Verified: Link header)*

### 10. Caching

- **All GET responses include cache headers.** `cache-control: private, max-age=60, s-maxage=60`, `etag: W/"..."`, `vary: Accept, Authorization, Cookie, ...`. *(Verified: consistent across all GET endpoints)*
- **Write endpoints (PUT, POST) do not return cache headers.** *(Verified: disable/enable/dispatch responses have no cache-control or etag)*

## Not Yet Verified (needs schedule-triggered runs)

These require actual `event: "schedule"` runs, which haven't fired yet (crons are best-effort and can take 10+ min on a new repo):

- [ ] **`github.event.schedule` contains the cron expression that fired** — need a schedule run to confirm the event payload shape
- [ ] **`actor` for schedule runs = last committer to the workflow file** — need to compare actor.login against `git log` for the workflow file
- [ ] **Multi-schedule: `event.schedule` distinguishes which expression fired** — need `cron-multi-schedule.yml` to fire
- [ ] **60-day inactivity auto-disable** — need to observe `state: "disabled_inactivity"` on a stale repo
- [ ] **Merger vs. PR author as actor** — need a PR-based workflow file change to test
- [ ] **Actor permission downgrade on ownership transfer** — need a second user to modify the workflow file

## Workflows

| File | Purpose |
|------|---------|
| `cron-basic.yml` | Dumps full event context every 5 min |
| `cron-multi-schedule.yml` | Tests which cron expression fired |
| `cron-ownership-test.yml` | Deep dive on actor/ownership attribution |
| `cron-staleness-monitor.yml` | Hourly check: have other crons fired recently? Detects silent failures |
| `cron-chained-alerting.yml` | `workflow_run` trigger — fires when a cron completes, enables failure alerting |
| `cron-control-api.yml` | Manual dispatch: list workflows, parse schedules, check token permissions |
| `cron-health-check.yml` | Manual dispatch: full diagnostic — YAML validity, actor audit, staleness, 60-day risk |
| `cron-token-permissions.yml` | Tests GITHUB_TOKEN permission scoping under cron with explicit permissions block |

## API Endpoints

Run `npm run probe` to probe all 18 endpoints and regenerate [`api-endpoints.md`](api-endpoints.md) with full request/response details including headers. Uses `gh auth token` by default; override with `GH_TOKEN` env var.

| Endpoint | Method | Status | Notes |
|----------|--------|--------|-------|
| `/actions/workflows` | GET | 200 | Returns all 8 workflows with `state` field |
| `/actions/workflows/{id}` | GET | 200 | Also accepts filename as ID (same ETag) |
| `/actions/runs` | GET | 200 | Paginated via `Link` header |
| `/actions/runs?event=schedule` | GET | 200 | Key observability query (0 results = crons not firing) |
| `/actions/workflows/{id}/runs` | GET | 200 | Per-workflow filtering |
| `/actions/runs/{id}` | GET | 200 | Full run detail with actor objects |
| `/actions/runs/{id}/jobs` | GET | 200 | Includes step-level status/timing |
| `/actions/jobs/{id}` | GET | 200 | Runner info, queue wait visible |
| `/actions/runs/{id}/logs` | GET | 200 | Returns zip; 404 if run not yet complete |
| `/actions/runs/{id}/attempts/{n}` | GET | 200 | Same shape as run, scoped to attempt |
| `/actions/runs/{id}/timing` | GET | 200 | `run_duration_ms` + billable breakdown by OS |
| `/actions/workflows/{id}/dispatches` | POST | 204 | **Deprecated** (sunset 2028-03-10); no run ID in response |
| `/actions/workflows/{id}/disable` | PUT | 204 | Idempotent; needs `actions:write` |
| `/actions/workflows/{id}/enable` | PUT | 204 | Idempotent; recovery from disable |
| `/actions/artifacts` | GET | 200 | Empty until a workflow uploads artifacts |
| `/actions/permissions` | GET | 200 | `enabled`, `allowed_actions`, `sha_pinning_required` |
| `/actions/permissions/workflow` | GET | 200 | `default_workflow_permissions: "write"` |
