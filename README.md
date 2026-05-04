# GitHub Actions Cron: An Empirical Investigation

How GitHub internally resolves cron schedule ownership, actor attribution, and token scoping — tested with bot commits, PR merges, and API probes on a live repository.

## TL;DR

The cron schedule **actor** depends on how the cron syntax change reached the default branch:

- **Direct push / API commit** → the pusher/app
- **Squash merge** → the person who merged the PR (push event actor)
- **Rebase merge** → the original commit author (NOT the merger!)
- Editing a workflow file without touching the `cron:` line? Actor doesn't change.

GitHub's docs say "the user who last modified the cron syntax." This is misleading and merge-method-dependent. Squash merge attributes to the merger; rebase merge attributes to the commit author.

## The Core Question

When a `schedule` event fires, GitHub picks an **actor** — the account under whose identity the workflow runs. This controls:

- **Notifications** — who gets failure emails
- **Fork access** — whether the run can access fork secrets
- **60-day inactivity** — public repos disable crons after 60 days of no activity
- **Account status** — if the actor is deleted or deprovisioned (EMU), crons stop

Notably, `GITHUB_TOKEN` permissions are **not** scoped to the actor — they follow the repo defaults or the workflow's `permissions:` block regardless of who the actor is ([Finding #4](#4-github_token-permissions-are-independent-of-the-actor)).

## Key Findings

### 1. Actor tracks the last cron syntax change (merge-method-dependent)

The cron actor is determined by the last commit that changed a `cron:` expression on the default branch. But **how** it identifies the responsible account depends on the merge method:
- **Direct push / API**: the pusher
- **Squash merge**: the push event actor (= the merger)
- **Rebase merge**: the commit author (NOT the merger)

#### Non-syntax changes don't update the actor

A GitHub App (`cron-actor-probe[bot]`) made 5+ commits to `cron-basic.yml` — modifying only comments and metadata, never the `cron:` line. It was the last author, committer, and pusher. Every schedule run still showed `actor: stefanpenner`.

```sh
# Schedule runs AFTER bot-only pushes — all show stefanpenner:
gh api "repos/stefanpenner-cs/cron-debugging/actions/runs?event=schedule&per_page=3" \
  --jq '.workflow_runs[] | "\(.name) | actor: \(.actor.login) | sha: \(.head_sha[:7])"'
```
```
Cron: Multi-Schedule        | actor: stefanpenner | sha: 8903c7b
Cron: Token Permission Scope | actor: stefanpenner | sha: 8903c7b
Cron: Ownership Attribution  | actor: stefanpenner | sha: 8903c7b
```

`head_sha: 8903c7b` is the bot's commit. Bot was last pusher. Actor is still `stefanpenner`.

#### Syntax changes DO update the actor

The bot pushed a commit that changed `cron: "*/5 * * * *"` to `cron: "*/7 * * * *"` ([commit `132086c`](https://github.com/stefanpenner-cs/cron-debugging/commit/132086c)). The next schedule run showed `actor: cron-actor-probe[bot]`.

[Schedule run with bot actor](https://github.com/stefanpenner-cs/cron-debugging/actions/runs/25236316750) |
[Previous run with human actor](https://github.com/stefanpenner-cs/cron-debugging/actions/runs/25235357865)

#### Squash merge: the merger wins

When a PR is squash-merged, the **merger** (push event actor) becomes the cron actor, not the commit author:

| Test | Cron syntax author | Merger (push event actor) | Cron actor | Run |
|------|-------------------|--------------------------|------------|-----|
| [PR #5](https://github.com/stefanpenner-cs/cron-debugging/pull/5) | `cron-actor-probe[bot]` | `stefanpenner` | **`stefanpenner`** | [25237190498](https://github.com/stefanpenner-cs/cron-debugging/actions/runs/25237190498) |
| [PR #6](https://github.com/stefanpenner-cs/cron-debugging/pull/6) | `stefanpenner` | `cron-actor-probe[bot]` | **`cron-actor-probe[bot]`** | [25237280090](https://github.com/stefanpenner-cs/cron-debugging/actions/runs/25237280090) |

#### Rebase merge: the commit author wins

When a PR is rebase-merged, the **original commit author** becomes the cron actor, NOT the merger:

| Test | Cron syntax author | Merger | Cron actor | Run |
|------|-------------------|--------|------------|-----|
| [PR #127](https://github.com/stefanpenner-cs/cron-debugging/pull/127) | `cron-actor-probe[bot]` | `stefanpenner` | **`cron-actor-probe[bot]`** | [25327979376](https://github.com/stefanpenner-cs/cron-debugging/actions/runs/25327979376) |

The push event for the rebase merge shows `actor: stefanpenner` (verified via events API), but the cron actor became the bot. This means GitHub uses the rebased commit's **author field** for cron actor tracking, not the push event actor.

```sh
# Push event actor is the merger (stefanpenner):
gh api repos/stefanpenner-cs/cron-debugging/events --jq \
  '.[] | select(.type=="PushEvent" and .payload.head[:7]=="ceb52b0") | {actor: .actor.login}'
# → { "actor": "stefanpenner" }

# But cron actor is the commit author (bot):
gh api repos/stefanpenner-cs/cron-debugging/actions/runs/25327979376 \
  --jq '{actor: .actor.login, actor_type: .actor.type}'
# → { "actor": "cron-actor-probe[bot]", "actor_type": "Bot" }
```

**This is a merge-method-dependent behavior:** squash merge → actor is the merger; rebase merge → actor is the commit author.

#### What this rules out

| Hypothesis | Verdict | Evidence |
|------------|---------|----------|
| Actor = last pusher to default branch | **RULED OUT** | Bot was last pusher (8903c7b), actor stayed `stefanpenner` |
| Actor = last commit author on workflow file | **RULED OUT** | Bot was author (non-syntax change), actor stayed `stefanpenner` |
| Actor = last commit committer | **RULED OUT** | Committer is always `GitHub` for API/PR merges |
| Actor = push event actor of last cron syntax change | **PARTIAL** | True for squash merge + direct push, but NOT for rebase merge |
| Actor depends on merge method | **CONFIRMED** | Squash → merger; Rebase → commit author |

### 2. Bots can become cron actors

GitHub's docs never mention whether app/bot accounts can be actors. **They can.** When `cron-actor-probe[bot]` pushed a cron syntax change, the actor became `cron-actor-probe[bot]` with `actor.type: Bot`.

```sh
gh api repos/stefanpenner-cs/cron-debugging/actions/runs/25236316750 \
  --jq '{actor: .actor.login, actor_type: .actor.type}'
```
```json
{ "actor": "cron-actor-probe[bot]", "actor_type": "Bot" }
```

This has security implications: a GitHub App with `contents:write` + `workflows:write` can silently become the cron actor by modifying a cron expression.

### 3. Schedule event payload

The `schedule` event payload contains the exact cron expression that fired and has no `sender` field.

```json
{
  "schedule": "*/5 * * * *",
  "repository": { "..." }
}
```

The event name is available via `github.event_name` (= `"schedule"`), not in the payload itself.

Each expression in a multi-cron workflow fires as a separate run. `github.event.schedule` contains the matching expression, enabling conditional logic:

```sh
if [ "${{ github.event.schedule }}" = "*/10 * * * *" ]; then
  echo "10-minute task"
fi
```

[Multi-schedule workflow](.github/workflows/cron-multi-schedule.yml) |
[Run 25233331699](https://github.com/stefanpenner-cs/cron-debugging/actions/runs/25233331699)

### 4. GITHUB_TOKEN permissions are independent of the actor

An explicit `permissions:` block restricts the token regardless of the repo's default settings. More importantly, **the actor's identity doesn't affect the token** — a bot-actor run gets the same permissions as a human-actor run.

**Human actor, explicit permissions** (`cron-token-permissions.yml`):
```
GITHUB_TOKEN Permissions: Actions: read, Contents: read
PUT /disable → 403 (correctly blocked)
```

**Bot actor, default permissions** (`cron-basic.yml`, no `permissions:` block):
```
GITHUB_TOKEN Permissions: Actions: write, Contents: write, Issues: write, ...
POST /issues → 201, PUT /disable → 204 (all writes succeed)
```

A bot-actor schedule run with no `permissions:` block gets full repo-default write access.

[Human actor run](https://github.com/stefanpenner-cs/cron-debugging/actions/runs/25233237231) |
[Bot actor run](https://github.com/stefanpenner-cs/cron-debugging/actions/runs/25236985054) |
[Bot token test run](https://github.com/stefanpenner-cs/cron-debugging/actions/runs/25237485693)

### 5. Actor tracking is per-file, not per-expression

A workflow file with two cron expressions (`*/10` and `*/11`) was tested. The bot changed only expression A (`*/9` → `*/10`), leaving expression B (`*/11`) untouched. Both expressions fire with `actor: cron-actor-probe[bot]`.

| Expression | Changed by | Actor | Run |
|-----------|-----------|-------|-----|
| `*/10` | Bot (*/9→*/10) | `cron-actor-probe[bot]` | [25327979331](https://github.com/stefanpenner-cs/cron-debugging/actions/runs/25327979331) |
| `*/11` | Nobody (original) | `cron-actor-probe[bot]` | [25328059618](https://github.com/stefanpenner-cs/cron-debugging/actions/runs/25328059618) |

Any push that changes ANY cron expression in a workflow file updates the actor for ALL expressions in that file. Cross-verified: the ownership-test (separate file, unchanged) still shows `actor: stefanpenner`.

### 6. Three identity concepts (and the merge-method twist)

GitHub tracks three identity concepts per commit. Which one determines the cron actor depends on the merge method:

```
Git commit
  ├── author    — who wrote the code (git config)
  ├── committer — who applied it ("GitHub" for PR merges)
  │
Push event
  └── actor — who triggered the ref update

For cron actor:
  ├── git push           → push event actor (the pusher)
  ├── API commit         → push event actor (the app/bot)
  ├── squash merge       → push event actor (the merger)    ← merger wins
  ├── rebase merge       → commit AUTHOR (NOT the merger!)  ← author wins
  ├── merge commit       → untested (likely push event actor)
  └── merge queue        → untested (likely github-merge-queue[bot])
```

The rebase merge exception is significant: a bot-authored cron change that is rebase-merged by a human makes the **bot** the cron actor, not the human. With squash merge, the **human** would be the actor.

## Other Observations

**Cron schedules are invisible to the API.** The workflow endpoint returns no schedule information — no `cron`, `schedule`, or `next_run_at` field. You must read the YAML source or check `github.event.schedule` from a run. Both numeric ID and filename work as identifiers (same ETag). [API probe results](api-endpoints.md)

**Workflow state machine.** `active` ↔ `disabled_manually` via PUT disable/enable (204, idempotent). `active` → `disabled_inactivity` after 60 days with no push (**public repos only**).

**`workflow_run` chaining** fires within ~2s of the upstream run completing. [Basic run](https://github.com/stefanpenner-cs/cron-debugging/actions/runs/25231636888) → [Chained run](https://github.com/stefanpenner-cs/cron-debugging/actions/runs/25231646672)

**GitHub injects synthetic steps.** A job with 4 user steps returns 6 via API — GitHub adds "Set up job" and "Complete job".

**PR merge methods and commit identity.** Squash preserves the PR branch author. Merge-commit uses the merger. Committer is always `GitHub` for web/API merges. None of this affects the cron actor unless the cron syntax changed.

## What GitHub's Docs Say

### Correct (but misleading): Actor tracks cron syntax changes

> "Notifications for scheduled workflows are sent to the user who last modified the cron syntax in the workflow file."

True in spirit, but "modified" is ambiguous. For squash merge, it's the merger (push event actor). For rebase merge, it's the original commit author. The distinction matters when author ≠ merger.

Evidence: [PR #5](https://github.com/stefanpenner-cs/cron-debugging/pull/5) (squash: bot authored, user merged → actor = user), [PR #6](https://github.com/stefanpenner-cs/cron-debugging/pull/6) (squash: user authored, bot merged → actor = bot), [PR #127](https://github.com/stefanpenner-cs/cron-debugging/pull/127) (rebase: bot authored, user merged → actor = bot).

### Confirmed (with nuance): Reactivation and actor tracking

> "For a deactivated scheduled workflow, if a user with write permissions to the repository makes a commit that changes the cron schedule on the workflow, the workflow will be reactivated, and that user will become the actor."

**Tested.** The workflow was disabled via API. While disabled, the bot pushed a cron syntax change (`*/5` → `*/6`). The workflow did NOT auto-reactivate — it had to be manually re-enabled. After re-enabling, the schedule run showed `actor: cron-actor-probe[bot]`.

```sh
gh api repos/stefanpenner-cs/cron-debugging/actions/runs/25327908440 \
  --jq '{actor: .actor.login, actor_type: .actor.type, created_at: .created_at}'
```
```json
{ "actor": "cron-actor-probe[bot]", "actor_type": "Bot", "created_at": "2026-05-04T15:30:10Z" }
```

The docs are right that the cron syntax changer becomes the actor. But the docs imply the workflow auto-reactivates on a cron change — it didn't. The disable/enable cycle is independent of actor tracking. [Run 25327908440](https://github.com/stefanpenner-cs/cron-debugging/actions/runs/25327908440)

### 60-day auto-disable is PUBLIC repos only

> "In a public repository, scheduled workflows are automatically disabled when no repository activity has occurred in 60 days."

The docs say "public repository" — private repos are not subject to this rule.

### Nuanced: Default branch swap affects new schedules, not established ones

> "Certain repository events change the `actor` associated with the workflow. For example, a user who changes the default branch of the repository... becomes `actor` for those scheduled workflows."

**Tested with mixed results.** The bot used `repos.update` to swap the default branch (`main` → `temp-default-branch-test` → back to `main`). Two different outcomes:

**Established workflow (unaffected):** `cron-ownership-test.yml` (running for days) still showed `actor: stefanpenner` after the swap.
```sh
gh api repos/stefanpenner-cs/cron-debugging/actions/runs/25327441147 \
  --jq '{actor: .actor.login, created_at: .created_at}'
# → { "actor": "stefanpenner", "created_at": "2026-05-04T15:20:44Z" }
```

**New workflow (affected):** `cron-default-branch-test.yml` (created at the same time, first schedule run) showed `actor: cron-actor-probe[bot]` — even though the bot never touched this file's cron expression.
```sh
gh api repos/stefanpenner-cs/cron-debugging/actions/runs/25327999011 \
  --jq '{actor: .actor.login, created_at: .created_at}'
# → { "actor": "cron-actor-probe[bot]", "created_at": "2026-05-04T15:31:54Z" }
```

The default branch swap appears to affect **newly-registering** schedules but not already-established ones. The bot's default branch change during the initial schedule registration window likely set the actor for unregistered workflows to the bot.

**Caveat:** The 4 new workflows were all created within seconds of the bot's pushes and the default branch swap (~14:44-14:45 UTC). There may be a race condition in GitHub's internal schedule registration that conflated these events.

### Account status matters, org membership doesn't

> "Removing a user from an organization will not prevent scheduled workflows which had that user as their `actor` from running."

Removing a user from your org does NOT stop their crons. The account must be fully deleted or deprovisioned (EMU).

## Internal Model

```
Repository
  ├── pushed_at                          ← 60-day inactivity clock (public only)
  │
  ├── Workflow (.github/workflows/foo.yml)
  │     ├── id: numeric                  ← also addressable by filename
  │     ├── state: active | disabled_*
  │     │
  │     ├── schedule_entries[]:          ← parsed from YAML on push
  │     │     ├── cron: "*/5 * * * *"
  │     │     └── actor: User | Bot     ← push event actor of last commit
  │     │                                  that changed this expression
  │     │
  │     └── GITHUB_TOKEN permissions:
  │           ├── default: repo-level setting
  │           └── override: workflow `permissions:` block
  │           (NOT affected by actor identity)
  │
  ├── Push Event (on every ref update)
  │     └── actor: who triggered the ref update on GitHub
  │         ← THIS determines cron actor
  │
  └── Commit (git object)
        ├── author                       ← irrelevant to cron actor
        └── committer                    ← irrelevant to cron actor
```

GitHub maintains **shadow state** for each cron entry separate from the git history. The YAML is the source of truth for the expression, but the actor is tracked internally and only updates when the expression changes AND a push event delivers it to the default branch.

## What's Still Unknown

- [x] **Is actor per-expression or per-file?** — Per-FILE. Bot changed only expression A (*/9→*/10), left expression B (*/11) unchanged. Both expressions show `actor: cron-actor-probe[bot]`. [*/10 run](https://github.com/stefanpenner-cs/cron-debugging/actions/runs/25327979331) | [*/11 run](https://github.com/stefanpenner-cs/cron-debugging/actions/runs/25328059618)
- [x] **Rebase merge commit identity** — Rebase merge preserves original commit author as cron actor, unlike squash merge where the merger wins. [Run 25327979376](https://github.com/stefanpenner-cs/cron-debugging/actions/runs/25327979376)
- [ ] **What happens when the actor loses repo access?** — Do crons stop? Switch to another actor? Continue with degraded permissions?
- [x] **Reactivation actor update** — Bot changed cron while disabled, user re-enabled. Actor = bot (cron syntax changer). Workflow did NOT auto-reactivate. [Run 25327908440](https://github.com/stefanpenner-cs/cron-debugging/actions/runs/25327908440)
- [x] **Default branch change as actor hijack** — Round-trip swap (main → temp → main) did NOT change the actor. Contradicts docs. Permanent switch untested. [Run 25327441147](https://github.com/stefanpenner-cs/cron-debugging/actions/runs/25327441147)
- [ ] **Merge queue actor attribution** — The push event actor would be `github-merge-queue[bot]`. If cron actor tracks push event actor, merge queue could silently set crons to a system bot.
- [ ] **Web UI direct commit to cron syntax** — Confirms baseline: author = user, committer = GitHub, push actor = user.
- [ ] **60-day inactivity definition** — What counts as "repository activity"? Only pushes? Any API call?

## Reproduction

```sh
npm install
# For bot tests: node create-app.js (creates GitHub App via manifest flow)
```

| Script | What it does |
|--------|-------------|
| `node probe-endpoints.js` | Probes 18 API endpoints → [`api-endpoints.md`](api-endpoints.md) |
| `node bot-commit.js` | Bot commits comment to workflow file (no syntax change) |
| `node cron-syntax-change-test.js setup` | Bot changes actual cron expression (syntax change) |
| `node pr-attribution-test.js all` | 4 PR scenarios: bot/user × squash/merge (no syntax change) |
| `node actor-disambiguate-test.js testA` | Bot authors cron change, user merges |
| `node actor-disambiguate-test.js testB` | User authors cron change, bot merges |
| `node bot-token-test.js setup` | Tests GITHUB_TOKEN under bot actor |
| `node multi-cron-attribution-test.js setup` | Tests multi-cron same-file attribution |
| `node remaining-tests.js setup-all` | Runs rebase, reactivation, default-branch, per-expression tests |

All scripts use `gh auth token` by default; override with `GH_TOKEN` env var.

## Workflows

| File | Schedule | Purpose |
|------|----------|---------|
| [`cron-basic.yml`](.github/workflows/cron-basic.yml) | `*/7` | Dumps full `github` context |
| [`cron-actor-disambiguate.yml`](.github/workflows/cron-actor-disambiguate.yml) | `*/5` | Author-vs-merger disambiguation |
| [`cron-bot-token-test.yml`](.github/workflows/cron-bot-token-test.yml) | `*/8` | GITHUB_TOKEN under bot actor |
| [`cron-multi-schedule.yml`](.github/workflows/cron-multi-schedule.yml) | `*/10`, `*/15` | Multi-expression discrimination |
| [`cron-ownership-test.yml`](.github/workflows/cron-ownership-test.yml) | `*/5` | Git log + run API actor comparison |
| [`cron-token-permissions.yml`](.github/workflows/cron-token-permissions.yml) | `*/10` | Explicit `permissions:` block test |
| [`cron-rebase-merge-test.yml`](.github/workflows/cron-rebase-merge-test.yml) | `*/6` | Rebase merge: bot authored, user merged |
| [`cron-reactivation-test.yml`](.github/workflows/cron-reactivation-test.yml) | `*/6` | Disable → bot changes cron → re-enable |
| [`cron-default-branch-test.yml`](.github/workflows/cron-default-branch-test.yml) | `*/5` | Default branch swap actor test |
| [`cron-per-expression-test.yml`](.github/workflows/cron-per-expression-test.yml) | `*/10`, `*/11` | Per-expression vs per-file actor |
| [`cron-staleness-monitor.yml`](.github/workflows/cron-staleness-monitor.yml) | hourly | Have other crons fired recently? |
| [`cron-chained-alerting.yml`](.github/workflows/cron-chained-alerting.yml) | — | `workflow_run` failure alerting |
| [`cron-control-api.yml`](.github/workflows/cron-control-api.yml) | — | Manual: list/parse/control workflows |
| [`cron-health-check.yml`](.github/workflows/cron-health-check.yml) | — | Manual: full diagnostic |
