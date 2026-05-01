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

**Claim:** Modifying a workflow file (comments, steps, env vars) without touching the `cron:` expression does NOT change the schedule actor. Modifying the actual cron expression DOES change the actor — and bots can become actors.

#### Part A: Non-syntax changes do NOT update the actor

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

#### Part B: Syntax changes DO update the actor (confirmed with bot)

**Evidence:** The bot pushed a commit directly to `main` that changed the actual cron expression from `*/5 * * * *` to `*/7 * * * *` ([commit `132086c`](https://github.com/stefanpenner-cs/cron-debugging/commit/132086c)). The next schedule run showed `actor: cron-actor-probe[bot]` — the actor changed from `stefanpenner` to the bot.

```sh
# Bot's commit changing the cron expression:
gh api repos/stefanpenner-cs/cron-debugging/commits/132086c \
  --jq '{sha: .sha[:7], author: .commit.author.name, message: .commit.message | split("\n")[0]}'
```
```json
{ "sha": "132086c", "author": "cron-actor-probe[bot]", "message": "test: bot changes cron syntax from \"*/5 * * * *\" to \"*/7 * * * *\"" }
```

```sh
# Schedule run AFTER the bot changed cron syntax — actor is now the bot:
gh api "repos/stefanpenner-cs/cron-debugging/actions/workflows/cron-basic.yml/runs?event=schedule&per_page=5" \
  --jq '.workflow_runs[] | "\(.actor.login) (\(.actor.type)) | sha: \(.head_sha[:7]) | \(.created_at)"'
```
```
cron-actor-probe[bot] (Bot) | sha: 1a33249 | 2026-05-01T22:42:43Z
stefanpenner (User)         | sha: 8903c7b | 2026-05-01T22:10:56Z
stefanpenner (User)         | sha: 8903c7b | 2026-05-01T21:48:56Z
```

The actor flipped from `stefanpenner` to `cron-actor-probe[bot]` at exactly the boundary where the cron expression changed. Note that `head_sha: 1a33249` is a later commit by `stefanpenner` — but the actor is still the bot, because the bot was the last to modify the cron expression.

**What this rules out and confirms:**

| Hypothesis | Prediction | Actual | Verdict |
|------------|-----------|--------|---------|
| Actor = last **pusher** to default branch | `cron-actor-probe[bot]` | `stefanpenner` | **RULED OUT** (Part A) |
| Actor = last **commit author** on workflow file | `cron-actor-probe[bot]` | `stefanpenner` | **RULED OUT** (Part A) |
| Actor = last **commit committer** on workflow file | `GitHub` (noreply) | `stefanpenner` | **RULED OUT** (Part A) |
| Actor = last person to modify **cron syntax** | `stefanpenner` | `stefanpenner` | **CONSISTENT** (Part A) |
| Syntax change updates actor | `cron-actor-probe[bot]` | `cron-actor-probe[bot]` | **CONFIRMED** (Part B) |
| Bots can become cron actors | `cron-actor-probe[bot]` | `cron-actor-probe[bot]` | **CONFIRMED** (Part B) |

[Bot comment-only commit](https://github.com/stefanpenner-cs/cron-debugging/commit/9a74d99) |
[Bot cron-syntax commit `132086c`](https://github.com/stefanpenner-cs/cron-debugging/commit/132086c) |
[Schedule run with bot actor (25236316750)](https://github.com/stefanpenner-cs/cron-debugging/actions/runs/25236316750) |
[Previous run with human actor (25235357865)](https://github.com/stefanpenner-cs/cron-debugging/actions/runs/25235357865)

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

The cron actor ignores all three when the cron syntax is unchanged. When the cron syntax IS changed, it tracks the **push event actor** — whoever caused the commit to land on the default branch:

- **Direct push**: the authenticated pusher (confirmed: bot pushed → bot became actor)
- **PR merge**: the person/bot who clicked merge, NOT the commit author (confirmed: bot authored cron change, user merged → actor is user)

```sh
# PR #5: bot authored cron syntax change, stefanpenner merged
gh api repos/stefanpenner-cs/cron-debugging/pulls/5 \
  --jq '{author: .user.login, merged_by: .merged_by.login}'
```
```json
{ "author": "cron-actor-probe[bot]", "merged_by": "stefanpenner" }
```
```sh
# Resulting schedule run — actor is the merger, not the author:
gh api repos/stefanpenner-cs/cron-debugging/actions/runs/25237190498 \
  --jq '{actor: .actor.login, actor_type: .actor.type}'
```
```json
{ "actor": "stefanpenner", "actor_type": "User" }
```

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

Our tests confirm this in both directions. The bot modified `cron-basic.yml` 5+ times (comments, timestamps) without changing the `cron:` line — actor remained `stefanpenner`. Then the bot changed the actual cron expression (`*/5` → `*/7`) — actor immediately changed to `cron-actor-probe[bot]` ([run 25236316750](https://github.com/stefanpenner-cs/cron-debugging/actions/runs/25236316750)).

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

The docs don't clarify whether "commit" means the git author, the git committer, the push event actor, or the PR merger. **We now know it's the push event actor** — whoever caused the commit to land on the default branch:

- [PR #5](https://github.com/stefanpenner-cs/cron-debugging/pull/5): bot authored the cron syntax change, `stefanpenner` merged → actor is `stefanpenner` ([run 25237190498](https://github.com/stefanpenner-cs/cron-debugging/actions/runs/25237190498))
- [Commit `132086c`](https://github.com/stefanpenner-cs/cron-debugging/commit/132086c): bot pushed cron syntax change directly → actor is `cron-actor-probe[bot]` ([run 25236316750](https://github.com/stefanpenner-cs/cron-debugging/actions/runs/25236316750))

The commit author is irrelevant. What matters is who triggers the push to the default branch.

### Confirmed (undocumented): Bot/app accounts CAN be cron actors

The docs never mention whether a GitHub App or bot account can become a cron schedule actor. **We confirmed they can.** When `cron-actor-probe[bot]` changed the cron expression from `*/5 * * * *` to `*/7 * * * *` via direct push to `main`, the next schedule run showed `actor: cron-actor-probe[bot]` with `actor.type: Bot`.

```sh
gh api repos/stefanpenner-cs/cron-debugging/actions/runs/25236316750 \
  --jq '{actor: .actor.login, actor_type: .actor.type, triggering_actor: .triggering_actor.login}'
```
```json
{ "actor": "cron-actor-probe[bot]", "actor_type": "Bot", "triggering_actor": "cron-actor-probe[bot]" }
```

This has security implications: a compromised GitHub App with `contents:write` can silently become the cron actor by modifying a cron expression, potentially inheriting broader permissions than the app itself has.

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
  │     │     └── actor: User | Bot     ← last account to modify THIS expression
  │     │                                  (NOT in API — inferred from behavior)
  │     │                                  Confirmed: bot accounts CAN be actors
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
  │     └── THIS is what determines cron actor when syntax changes
  │         (confirmed: merger of PR = push actor = cron actor)
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

- [x] **Can a bot become the cron actor?** — **YES.** Bot changed cron expression via direct push to `main`, actor flipped to `cron-actor-probe[bot]`. See [Finding #1, Part B](#1-actor-tracks-cron-syntax-changes-not-file-changes) and [run 25236316750](https://github.com/stefanpenner-cs/cron-debugging/actions/runs/25236316750).
- [x] **Bot modifies cron syntax** — **Confirmed.** Bot changed `*/5 * * * *` → `*/7 * * * *` in [commit `132086c`](https://github.com/stefanpenner-cs/cron-debugging/commit/132086c). Actor changed from `stefanpenner` to `cron-actor-probe[bot]`.
- [x] **Author vs merger for cron syntax changes** — **It's the merger (push event actor).** [PR #5](https://github.com/stefanpenner-cs/cron-debugging/pull/5): bot authored cron change, `stefanpenner` merged → actor is `stefanpenner` ([run 25237190498](https://github.com/stefanpenner-cs/cron-debugging/actions/runs/25237190498)). The commit author is irrelevant; what matters is who triggers the push to the default branch.
- [ ] **Is actor per-expression or per-file?** — Our multi-schedule test had the same person (stefanpenner) write both expressions. Need: two different users each write one expression in the same file.
- [ ] **What exactly triggers the 60-day disable?** — Only applies to public repos. Does any API call count as "activity"? Or only pushes? And is it per-repo or per-workflow?
- [ ] **Rebase merge attribution** — Does `rebase` merge behave like squash (preserves author) or merge-commit (uses merger)?
- [ ] **What happens when the actor loses repo access?** — Do crons stop? Switch to another actor? Continue with degraded permissions?
- [ ] **Reactivation actor update** — Does re-enabling a disabled workflow with a cron syntax change actually update the actor as docs claim?
- [ ] **Default branch change as actor hijack** — Docs say changing the default branch changes the actor for all cron workflows. Not yet tested.
- [ ] **Merge queue actor attribution** — With merge queue enabled, the push event actor is `github-merge-queue[bot]`, not the PR author or the person who queued. If cron actor tracks push event actor, merge queue could set it to a system bot. Needs merge queue enabled to test.
- [ ] **Web UI direct commit to cron syntax** — Editing a workflow file's cron expression via GitHub's web editor and committing straight to main. Author = user, committer = GitHub, push actor = user. Confirms baseline behavior without PR indirection.

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

### Test bot cron syntax change (actor transfer)

```sh
node cron-syntax-change-test.js setup    # bot changes cron expression (*/5 ↔ */7)
node cron-syntax-change-test.js poll     # wait + auto-check (up to 20 min)
node cron-syntax-change-test.js check    # check actor on post-change runs
node cron-syntax-change-test.js restore  # human restores cron to */5
```

### Test author vs merger disambiguation

```sh
node actor-disambiguate-test.js testA    # bot authors cron change, user merges
node actor-disambiguate-test.js testB    # user authors cron change, bot merges
node actor-disambiguate-test.js check    # check schedule run actors
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
| [`cron-actor-disambiguate.yml`](.github/workflows/cron-actor-disambiguate.yml) | `*/6 * * * *` | Tests author-vs-merger for cron actor attribution |
| [`cron-basic.yml`](.github/workflows/cron-basic.yml) | `*/7 * * * *` | Dumps full `github` context (currently bot-owned actor) |
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
| [`cron-syntax-change-test.js`](cron-syntax-change-test.js) | Bot changes actual cron expression, verifies actor changes |
| [`actor-disambiguate-test.js`](actor-disambiguate-test.js) | Tests author-vs-merger for cron actor (PR-based syntax changes) |

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

### After bot changed cron syntax (`*/5` → `*/7` in commit `132086c`)

| Run ID | Workflow | Actor | Actor Type | SHA | Created |
|--------|----------|-------|------------|-----|---------|
| 25236316750 | Basic Every 5 Min | `cron-actor-probe[bot]` | `Bot` | `1a33249` | 2026-05-01T22:42:43Z |

**This is the definitive evidence.** The actor changed from `stefanpenner` (User) to `cron-actor-probe[bot]` (Bot) at the exact boundary where the cron expression was modified. The `head_sha` `1a33249` is a subsequent commit by `stefanpenner` — but the actor remains the bot, because the bot was the last to touch the `cron:` line.

### Author vs merger disambiguation (PR #5: bot authored, user merged)

| Run ID | Workflow | Actor | Actor Type | SHA | Created |
|--------|----------|-------|------------|-----|---------|
| 25237190498 | Actor Disambiguation | `stefanpenner` | `User` | `d7be9ce` | 2026-05-01T22:50:51Z |

PR #5 had `cron-actor-probe[bot]` as the commit author of the cron syntax change, but `stefanpenner` merged the PR. The actor is `stefanpenner` — **the merger, not the commit author**. This confirms the cron actor follows the push event actor (whoever triggers the push to the default branch), not the git commit author.
