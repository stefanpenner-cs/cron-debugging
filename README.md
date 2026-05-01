# GitHub Actions Cron: An Empirical Investigation

How GitHub internally resolves cron schedule ownership, actor attribution, and token scoping — tested with bot commits, PR merges, and API probes on a live repository.

## The Core Question

When a `schedule` event fires, GitHub picks an **actor** — the user account under whose identity the workflow runs. This controls:

- **`GITHUB_TOKEN` permissions** — scoped to what that actor can access
- **Fork access** — whether the run can access fork secrets
- **Notifications** — who gets failure emails
- **60-day inactivity** — if the actor leaves, crons may stop

GitHub's docs say the actor is "the last person who modified the cron syntax in the workflow file." We set out to verify this claim — and found it's more nuanced than it sounds.

## Key Findings

### 1. Actor tracks cron SYNTAX changes, not file changes

**Claim:** Modifying a workflow file (comments, steps, env vars) without touching the `cron:` expression does NOT change the schedule actor.

**Evidence:** We had a GitHub App (`cron-actor-probe[bot]`) make 5+ commits to `cron-basic.yml`, including being the last pusher to `main`. The bot modified only comments and metadata — never the `cron:` line. Every schedule run still showed `actor: stefanpenner`.

```sh
# The bot's last push to main (the most recent push by anyone):
gh api repos/stefanpenner-cs/cron-debugging/events \
  --jq '.[] | select(.type=="PushEvent") | "\(.actor.login) pushed \(.payload.head[:7]) at \(.created_at)"' \
  | head -3
```
```
cron-actor-probe[bot] pushed 8903c7b at 2026-05-01T20:57:55Z
cron-actor-probe[bot] pushed 02b29a4 at 2026-05-01T20:56:18Z
stefanpenner pushed 160a35e at 2026-05-01T20:56:04Z
```

```sh
# Schedule runs AFTER the bot-only pushes — all show stefanpenner:
gh api "repos/stefanpenner-cs/cron-debugging/actions/runs?event=schedule&per_page=5" \
  --jq '.workflow_runs[] | "\(.name) | actor: \(.actor.login) | sha: \(.head_sha[:7]) | \(.created_at)"'
```
```
Cron: Multi-Schedule       | actor: stefanpenner | sha: 8903c7b | 2026-05-01T21:10:48Z
Cron: Token Permission Scope | actor: stefanpenner | sha: 8903c7b | 2026-05-01T21:08:13Z
Cron: Ownership Attribution  | actor: stefanpenner | sha: 8903c7b | 2026-05-01T21:06:41Z
```

The `head_sha` is `8903c7b` — the bot's commit. The bot was the last author, last committer, and last pusher. But the actor is `stefanpenner` because `stefanpenner` was the last to write the `cron:` expression.

**What this rules out:**

| Hypothesis | Prediction | Actual | Verdict |
|------------|-----------|--------|---------|
| Actor = last **pusher** to default branch | `cron-actor-probe[bot]` | `stefanpenner` | **RULED OUT** |
| Actor = last **commit author** on workflow file | `cron-actor-probe[bot]` | `stefanpenner` | **RULED OUT** |
| Actor = last **commit committer** on workflow file | `GitHub` (noreply) | `stefanpenner` | **RULED OUT** |
| Actor = last person to modify **cron syntax** | `stefanpenner` | `stefanpenner` | **CONSISTENT** |

[Bot commit](https://github.com/stefanpenner-cs/cron-debugging/commit/9a74d99) |
[Schedule run 25233183365](https://github.com/stefanpenner-cs/cron-debugging/actions/runs/25233183365) |
[Ownership attribution run log](https://github.com/stefanpenner-cs/cron-debugging/actions/runs/25233183365)

### 2. Schedule event payload structure

**Claim:** The `schedule` event payload contains the exact cron expression that fired, has no `sender` field, and each expression in a multi-cron file fires independently.

**Evidence:** From run logs of `cron-ownership-test.yml` (run 25233183365):

```json
{
  "event_name": "schedule",
  "event": {
    "schedule": "*/5 * * * *",
    "repository": { "..." }
  }
}
```

No `sender` field — unlike `push`, `pull_request`, or `workflow_dispatch` events, schedule events have no sender because the trigger isn't a user action.

From run logs of `cron-multi-schedule.yml` (run 25233331699), which has two cron expressions (`*/10` and `*/15`):

```
github.event.schedule = '*/10 * * * *'
Triggered by the 10-minute schedule
```

Each expression fires as a separate workflow run. The docs confirm this:

> "A single workflow can be triggered by multiple `schedule` events. Access the `schedule` event that triggered the workflow through the `github.event.schedule` context."

The `github.event.schedule` context variable contains the exact cron string that matched, enabling conditional logic per schedule:

```yaml
- name: Branch on schedule
  run: |
    if [ "${{ github.event.schedule }}" = "*/10 * * * *" ]; then
      echo "10-minute task"
    elif [ "${{ github.event.schedule }}" = "*/15 * * * *" ]; then
      echo "15-minute task"
    fi
```

[Multi-schedule workflow](.github/workflows/cron-multi-schedule.yml) |
[Run 25233331699](https://github.com/stefanpenner-cs/cron-debugging/actions/runs/25233331699)

### 3. PR merge method affects commit attribution (but not cron actor)

**Claim:** Squash-merge preserves the PR branch author. Merge-commit uses the merger's identity. Neither changes the cron actor unless the cron syntax was modified.

**Evidence:** Four PRs tested, each modifying `cron-basic.yml` (comments only, not cron syntax):

| PR | Opener | Merger | Method | Commit Author | Commit Committer | Cron Actor |
|----|--------|--------|--------|---------------|------------------|------------|
| [#1](https://github.com/stefanpenner-cs/cron-debugging/pull/1) | bot | user | squash | `cron-actor-probe[bot]` | `GitHub` | `stefanpenner` |
| [#2](https://github.com/stefanpenner-cs/cron-debugging/pull/2) | bot | user | merge | `Stefan Penner` | `GitHub` | `stefanpenner` |
| [#3](https://github.com/stefanpenner-cs/cron-debugging/pull/3) | bot | bot | squash | `cron-actor-probe[bot]` | `GitHub` | `stefanpenner` |
| [#4](https://github.com/stefanpenner-cs/cron-debugging/pull/4) | bot | bot | merge | `cron-actor-probe[bot]` | `GitHub` | `stefanpenner` |

```sh
# Verify PR #3 (bot opened + bot merged, squash):
gh api repos/stefanpenner-cs/cron-debugging/pulls/3 \
  --jq '{opened_by: .user.login, merged_by: .merged_by.login, merge_sha: .merge_commit_sha[:7]}'
```
```json
{ "opened_by": "cron-actor-probe[bot]", "merged_by": "cron-actor-probe[bot]", "merge_sha": "7f4d81a" }
```

Even when the bot both opened AND merged the PR (making it the push event actor, commit author, and merger), the cron actor remained `stefanpenner` — because the cron syntax wasn't changed.

### 4. Push event actor vs commit identity — three different things

GitHub tracks three separate identity concepts for commits on the default branch:

```
Git commit
  ├── author   — who wrote the code (Git concept, from git config)
  ├── committer — who applied it (Git concept; "GitHub" for API/PR merges)
  │
GitHub push event
  └── actor — who triggered the push (GitHub concept)
              ├── git push → the authenticated user
              ├── API createOrUpdateFileContents → the app/bot
              ├── PR merge by user → the user who clicked merge
              └── PR merge by bot → the bot
```

```sh
# See all three for a single commit:
gh api repos/stefanpenner-cs/cron-debugging/commits/9a74d99 \
  --jq '{author: .commit.author.name, committer: .commit.committer.name, pushed_by: .author.login}'
```
```json
{ "author": "cron-actor-probe[bot]", "committer": "GitHub", "pushed_by": "cron-actor-probe[bot]" }
```

The cron actor ignores all three. It tracks a **fourth** concept: who last modified the cron syntax.

### 5. GITHUB_TOKEN permissions respect the `permissions:` block

**Claim:** An explicit `permissions:` block in a workflow restricts the token to exactly those permissions, regardless of the repo's default settings.

**Evidence:** `cron-token-permissions.yml` declares:

```yaml
permissions:
  contents: read
  actions: read
  issues: write
```

Run logs from run 25233237231 confirm only the declared permissions were granted:

```
GITHUB_TOKEN Permissions
  Actions: read
  Contents: read
```

And the workflow's own test confirms `actions:write` operations fail:

```
GET /actions/workflows (actions:read): 200
PUT /actions/workflows/:id/disable (needs actions:write — we only have read): 403
Expected: disable returns 403 because we only declared actions:read
```

The repo default is `write` for all permissions, but the workflow-level block overrides it.

Note: the GitHub docs have **no special carve-out for `schedule` events** regarding GITHUB_TOKEN. Unlike `pull_request` events from forks (which get read-only tokens), schedule events run on the default branch and receive the normal default permissions — unless overridden by a `permissions:` block.

[Token permissions workflow](.github/workflows/cron-token-permissions.yml) |
[Run 25233237231](https://github.com/stefanpenner-cs/cron-debugging/actions/runs/25233237231)

### 6. Cron schedules are invisible to the API

**Claim:** The workflow API returns no schedule information. Cron expressions exist only in the YAML source.

**Evidence:**

```sh
gh api repos/stefanpenner-cs/cron-debugging/actions/workflows/269650800 \
  --jq '{id, name, state, path}'
```
```json
{
  "id": 269650800,
  "name": "Cron: Basic Every 5 Min",
  "state": "active",
  "path": ".github/workflows/cron-basic.yml"
}
```

No `schedule`, `cron`, or `next_run_at` field. To discover a workflow's schedule, you must read the YAML via the contents API or wait for a run and check `github.event.schedule`.

Both numeric ID (`269650800`) and filename (`cron-basic.yml`) work as workflow identifiers and return identical responses with the same ETag.

[API probe results](api-endpoints.md)

### 7. Workflow state machine

```
                  PUT .../disable (204)
  ┌─────────┐ ──────────────────────► ┌────────────────────┐
  │  active  │                         │ disabled_manually  │
  └─────────┘ ◄────────────────────── └────────────────────┘
                  PUT .../enable (204)

  ┌─────────┐ ── 60 days no push ──► ┌──────────────────────┐
  │  active  │    (PUBLIC REPOS ONLY) │ disabled_inactivity  │
  └─────────┘ ◄── push + re-enable ─ └──────────────────────┘
```

Both disable and enable return `204` with empty body and are idempotent (calling disable on an already-disabled workflow returns `204`).

The 60-day inactivity disable applies **only to public repositories** (per GitHub docs). This is tracked via `repository.pushed_at`. We haven't tested this path — it requires 60 days of inactivity on a public repo.

```sh
# Disable:
gh api -X PUT repos/stefanpenner-cs/cron-debugging/actions/workflows/269650800/disable
# Enable:
gh api -X PUT repos/stefanpenner-cs/cron-debugging/actions/workflows/269650800/enable
```

### 8. `workflow_run` chaining works with ~2s latency

A workflow triggered by `workflow_run` fires within seconds of the upstream run completing:

```
Cron: Basic completed at ~20:25:15Z
Chained alerting created at 20:25:17Z (2s later)
```

[Basic run](https://github.com/stefanpenner-cs/cron-debugging/actions/runs/25231636888) |
[Chained run](https://github.com/stefanpenner-cs/cron-debugging/actions/runs/25231646672)

### 9. GitHub injects synthetic job steps

A workflow job with 4 user-defined steps returns 6 steps via the API. GitHub prepends `"Set up job"` and appends `"Complete job"`. Steps gated on `if:` conditions show `conclusion: "skipped"`.

```sh
gh api repos/stefanpenner-cs/cron-debugging/actions/jobs/73988338415 \
  --jq '[.steps[] | {name, conclusion}]'
```
```json
[
  { "name": "Set up job", "conclusion": "success" },
  { "name": "Inspect the triggering workflow run", "conclusion": "success" },
  { "name": "Alert on failure", "conclusion": "skipped" },
  { "name": "Full github context", "conclusion": "success" },
  { "name": "Full event payload", "conclusion": "success" },
  { "name": "Complete job", "conclusion": "success" }
]
```

## What GitHub's Docs Say

### Correct: Actor tracks cron syntax, not file modifications

> "Notifications for scheduled workflows are sent to the user who last modified the cron syntax in the workflow file."
>
> — [Events that trigger workflows: schedule](https://docs.github.com/en/actions/writing-workflows/choosing-when-your-workflow-runs/events-that-trigger-workflows#schedule)

Our tests confirm this. The bot modified `cron-basic.yml` 5+ times (comments, timestamps) and was the last pusher — but the actor remained `stefanpenner` because the `cron:` line was untouched.

### Correct: Reactivation updates the actor

> "For a deactivated scheduled workflow, if a user with write permissions to the repository makes a commit that changes the cron schedule on the workflow, the workflow will be reactivated, and that user will become the actor."
>
> — [Events that trigger workflows: schedule](https://docs.github.com/en/actions/writing-workflows/choosing-when-your-workflow-runs/events-that-trigger-workflows#schedule)

Not yet tested (would require disabling and re-enabling with a cron syntax change by a different user).

### Misleading: "Last person to commit to the cron syntax"

The docs use "commit" loosely. Our PR tests show that for merged PRs:

- **squash merge**: commit author = PR branch author (possibly a bot)
- **merge commit**: commit author = whoever clicked merge
- **In both cases**: the cron actor didn't change because the cron syntax wasn't modified

The docs don't clarify whether "commit" means the git author, the git committer, the push event actor, or the PR merger. Based on our tests, none of these matter — only the **cron syntax diff** matters.

### Silent: Bot/app accounts as cron actors

The docs never mention whether a GitHub App or bot account can become a cron schedule actor. Our bot was the last to push, author, and commit — but the cron syntax was unchanged, so we can't confirm whether a bot *can* become the actor if it modifies the cron expression.

### Important: 60-day auto-disable only applies to PUBLIC repositories

> "In a public repository, scheduled workflows are automatically disabled when no repository activity has occurred in 60 days."
>
> — [Events that trigger workflows: schedule](https://docs.github.com/en/actions/writing-workflows/choosing-when-your-workflow-runs/events-that-trigger-workflows#schedule)

The docs say "public repository" — **private repos are not subject to the 60-day rule**. The docs don't define what counts as "repository activity." The `repository.pushed_at` field suggests it's push-based:

```json
{ "pushed_at": "2026-05-01T20:57:54Z" }
```

### Undocumented: Changing the default branch changes the actor

> "Certain repository events change the `actor` associated with the workflow. For example, a user who changes the default branch of the repository, which changes the branch on which scheduled workflows run, becomes `actor` for those scheduled workflows."
>
> — [Events that trigger workflows: schedule](https://docs.github.com/en/actions/writing-workflows/choosing-when-your-workflow-runs/events-that-trigger-workflows#schedule)

This is a surprising attack surface: anyone with admin access to change the default branch can hijack the actor for all cron workflows, even without touching any workflow files.

### EMU-specific: Account status matters, org membership doesn't

> "Scheduled workflows will not run if the last `actor` associated with the scheduled workflow has been deprovisioned by the Enterprise Managed User identity provider (IdP). However, if the last `actor` Enterprise Managed User has not been deprovisioned by the IdP, and has only been removed as a member from a given organization in the enterprise, scheduled workflows will still run with that user set as the `actor`."
>
> "Similarly, for an enterprise without Enterprise Managed Users, removing a user from an organization will not prevent scheduled workflows which had that user as their `actor` from running."
>
> "Thus, the _user account's_ status, in both Enterprise Managed User and non-Enterprise Managed User scenarios, is what's important, _not_ the user's _membership status_ in the organization where the scheduled workflow is located."
>
> — [Events that trigger workflows: schedule](https://docs.github.com/en/actions/writing-workflows/choosing-when-your-workflow-runs/events-that-trigger-workflows#schedule)

This means: removing a user from your org does NOT stop their crons. The user's GitHub account must be fully deleted or deprovisioned. An actor who left the org still has their crons running under their identity.

## Internal Model

What GitHub must track internally to produce the behavior we observe:

```
Repository
  ├── pushed_at                          ← 60-day inactivity clock
  │
  ├── Workflow (.github/workflows/foo.yml)
  │     ├── id: 269650800               ← numeric, also addressable by filename
  │     ├── state: active | disabled_*   ← binary on/off, no "paused"
  │     │
  │     ├── schedule_entries[]:          ← parsed from YAML on push
  │     │     ├── cron: "*/5 * * * *"   ← the expression
  │     │     └── actor: User           ← last person to modify THIS expression
  │     │                                  (NOT in API — inferred from behavior)
  │     │
  │     │   Note: each expression fires as a separate run, but our tests
  │     │   show all expressions in one file share the same actor.
  │     │   Unclear if actor is per-expression or per-file.
  │     │
  │     └── GITHUB_TOKEN permissions:
  │           ├── default: repo-level setting (usually "write")
  │           └── override: workflow-level `permissions:` block
  │
  ├── Push Event (generated on every ref update)
  │     ├── actor: who pushed            ← DIFFERENT from commit author
  │     └── This is NOT used for cron actor resolution
  │
  └── Commit (git object)
        ├── author   ← git concept (who wrote it)
        ├── committer ← git concept ("GitHub" for API/PR merges)
        └── Neither is used for cron actor resolution
```

### Key insight: GitHub parses the YAML on push

When you push to the default branch, GitHub doesn't just store the file — it parses the workflow YAML and extracts the `schedule` entries. The API never exposes these parsed entries, but the behavior proves they exist:

1. Each cron expression fires independently
2. `github.event.schedule` contains the exact expression string
3. The actor is tracked separately from the git commit metadata
4. Changing a comment in the file doesn't update the actor

This means GitHub maintains a **shadow state** for each cron entry that's separate from the git history. The YAML is the source of truth for the expression, but the actor is tracked in GitHub's internal database and only updates when the expression itself changes.

## What's Still Unknown

- [ ] **Can a bot become the cron actor?** — Our bot never changed the actual cron expression. Test needed: bot modifies the `cron:` line itself. If the actor changes to the bot, it confirms the docs' "cron syntax" claim applies to app accounts too.
- [ ] **Is actor per-expression or per-file?** — Our multi-schedule test had the same person (stefanpenner) write both expressions. Need: two different users each write one expression in the same file.
- [ ] **What exactly triggers the 60-day disable?** — Only applies to public repos. Does any API call count as "activity"? Or only pushes? And is it per-repo or per-workflow?
- [ ] **Rebase merge attribution** — Does `rebase` merge behave like squash (preserves author) or merge-commit (uses merger)?
- [ ] **What happens when the actor loses repo access?** — Do crons stop? Switch to another actor? Continue with degraded permissions?
- [ ] **Reactivation actor update** — Does re-enabling a disabled workflow with a cron syntax change actually update the actor as docs claim?
- [ ] **Default branch change as actor hijack** — Docs say changing the default branch changes the actor for all cron workflows. Not yet tested.
- [ ] **Bot modifies cron syntax** — Definitive test: have the bot change the actual `cron:` expression (not just comments). If the actor flips to the bot, it confirms the mechanism end-to-end.

## Reproduction

### Prerequisites

```sh
npm install
# For bot tests: node create-app.js (creates a GitHub App via manifest flow)
```

### Run the API probe

```sh
npm run probe
# Hits 18 endpoints, generates api-endpoints.md with full request/response
```

### Test bot commit attribution

```sh
node bot-commit.js
# Bot commits a timestamp comment to cron-basic.yml via API
# Wait for next cron fire, then check:
gh api "repos/stefanpenner-cs/cron-debugging/actions/runs?event=schedule&per_page=5" \
  --jq '.workflow_runs[] | "\(.name) | actor: \(.actor.login) | sha: \(.head_sha[:7])"'
```

### Test PR merge attribution

```sh
node pr-attribution-test.js all
# Runs 4 scenarios (bot/user × squash/merge), then check cron runs
```

### Test multi-cron attribution

```sh
node multi-cron-attribution-test.js setup   # bot edits multi-schedule file
node multi-cron-attribution-test.js check   # compare actors across expressions
```

### Check schedule event payload

```sh
# From any schedule run:
gh api repos/stefanpenner-cs/cron-debugging/actions/runs/25233183365/jobs \
  --jq '.jobs[0].id' | xargs -I{} gh api repos/stefanpenner-cs/cron-debugging/actions/jobs/{}/logs 2>&1 \
  | grep -A5 "event_name.*schedule"
```

### Test token permissions

```sh
# cron-token-permissions.yml has explicit permissions: block
# Check that actions:write returns 403 when only actions:read declared:
gh api repos/stefanpenner-cs/cron-debugging/actions/runs/25233237231/jobs \
  --jq '.jobs[0].id' | xargs -I{} gh api repos/stefanpenner-cs/cron-debugging/actions/jobs/{}/logs 2>&1 \
  | grep -E "403|200|Permission"
```

## Workflows

| File | Schedule | Purpose |
|------|----------|---------|
| [`cron-basic.yml`](.github/workflows/cron-basic.yml) | `*/5 * * * *` | Dumps full `github` context every 5 min |
| [`cron-multi-schedule.yml`](.github/workflows/cron-multi-schedule.yml) | `*/10`, `*/15` | Tests which expression fired via `github.event.schedule` |
| [`cron-ownership-test.yml`](.github/workflows/cron-ownership-test.yml) | `*/5 * * * *` | Checks git log for last modifier, queries run API for actor |
| [`cron-token-permissions.yml`](.github/workflows/cron-token-permissions.yml) | `*/10 * * * *` | Explicit `permissions:` block, tests that restrictions apply |
| [`cron-staleness-monitor.yml`](.github/workflows/cron-staleness-monitor.yml) | `0 * * * *` | Hourly: have other crons fired recently? |
| [`cron-chained-alerting.yml`](.github/workflows/cron-chained-alerting.yml) | (none) | `workflow_run` trigger for failure alerting |
| [`cron-control-api.yml`](.github/workflows/cron-control-api.yml) | (none) | Manual dispatch: list/parse/control workflows |
| [`cron-health-check.yml`](.github/workflows/cron-health-check.yml) | (none) | Manual dispatch: full diagnostic |

## Scripts

| Script | Purpose |
|--------|---------|
| [`probe-endpoints.js`](probe-endpoints.js) | Probes 18 API endpoints, generates [`api-endpoints.md`](api-endpoints.md) |
| [`create-app.js`](create-app.js) | Creates `cron-actor-probe` GitHub App via manifest flow |
| [`bot-commit.js`](bot-commit.js) | Commits to workflow file as app bot |
| [`pr-attribution-test.js`](pr-attribution-test.js) | Opens/merges PRs as bot/user in all permutations |
| [`multi-cron-attribution-test.js`](multi-cron-attribution-test.js) | Tests multi-cron same-file actor attribution |

All scripts use `gh auth token` by default; override with `GH_TOKEN` env var.

## Appendix: Full Run Evidence

Every schedule run observed, ordered chronologically:

| Run ID | Workflow | Actor | SHA | Created |
|--------|----------|-------|-----|---------|
| 25232340174 | Ownership Attribution | `stefanpenner` | `82819aa` | 2026-05-01T20:43:41Z |
| 25232384888 | Token Permission Scope | `stefanpenner` | `82819aa` | 2026-05-01T20:44:55Z |
| 25232462897 | Multi-Schedule | `stefanpenner` | `0a5929a` | 2026-05-01T20:46:59Z |
| 25232522305 | Multi-Schedule | `stefanpenner` | `4673dde` | 2026-05-01T20:48:37Z |
| 25232766145 | Basic Every 5 Min | `stefanpenner` | `531586a` | 2026-05-01T20:55:19Z |
| 25233183365 | Ownership Attribution | `stefanpenner` | `8903c7b` | 2026-05-01T21:06:41Z |
| 25233237231 | Token Permission Scope | `stefanpenner` | `8903c7b` | 2026-05-01T21:08:13Z |
| 25233331699 | Multi-Schedule | `stefanpenner` | `8903c7b` | 2026-05-01T21:10:48Z |

Note: Runs 6-8 have `head_sha: 8903c7b` — the bot's commit. The bot was the last author, committer, AND pusher for this SHA. Yet all three show `actor: stefanpenner`. This is the strongest evidence that actor resolution is independent of push/commit identity.
