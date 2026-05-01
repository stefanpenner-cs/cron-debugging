# cron-debugging

Experiments to understand GitHub Actions `schedule` (cron) trigger behavior.

## Key questions

### 1. Basic mechanics
- What does the event payload look like?
- What's in `github.event.schedule`?
- Which branch does the cron run against? (answer: always the default branch)

### 2. Ownership / attribution
- **Who is `github.actor`?** For cron, it's the user who *last committed to the workflow file on the default branch*.
- **What happens when someone else modifies the workflow file?** Actor changes.
- **What happens when the cron line itself changes?** New cron expression shows in `github.event.schedule`.
- **Does the merger matter vs. the committer?** Need to test merge-commit vs. squash-merge attribution.

### 3. Multi-schedule
- A single workflow can have multiple `cron:` entries.
- `github.event.schedule` tells you which one fired.

## Goal

Build a high-level internal model of how GitHub represents and executes cron schedules — the entities, relationships, and state transitions that must exist behind the API surface. Each workflow here is a probe designed to reveal one piece of that model.

```
┌─────────────────────────────────────────────────────────────────┐
│                        Repository                               │
│  default_branch ─► "main"                                       │
│  pushed_at ─► (timestamp, 60-day inactivity clock)              │
│                                                                 │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  Workflow  (.github/workflows/foo.yml)                     │  │
│  │  state: active | disabled_manually | disabled_inactivity   │  │
│  │  path: .github/workflows/foo.yml                           │  │
│  │                                                            │  │
│  │  actor ─► User (last committer to this file on default)    │  │
│  │    └─► determines GITHUB_TOKEN identity & permissions      │  │
│  │    └─► changes silently on any push touching this file     │  │
│  │                                                            │  │
│  │  ┌──────────────────────────────────────────────────────┐  │  │
│  │  │  Schedule Trigger(s)                                 │  │  │
│  │  │  cron: "*/5 * * * *"  ◄── one or more expressions   │  │  │
│  │  │  cron: "0 * * * *"                                   │  │  │
│  │  │                                                      │  │  │
│  │  │  Each expression fires independently.                │  │  │
│  │  │  github.event.schedule = the expression that fired.  │  │  │
│  │  └──────────────────────────────────────────────────────┘  │  │
│  │                                                            │  │
│  │  ┌──────────────────────────────────────────────────────┐  │  │
│  │  │  Permissions Block (optional)                        │  │  │
│  │  │  Sets upper bound on GITHUB_TOKEN scope.             │  │  │
│  │  │  Effective perms = min(this block, actor's access)   │  │  │
│  │  └──────────────────────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  Workflow Run                                              │  │
│  │  event: "schedule"                                         │  │
│  │  actor ─► (resolved at run creation time, not at fire)     │  │
│  │  triggering_actor ─► (same as actor for schedule)          │  │
│  │  ref: refs/heads/{default_branch}                          │  │
│  │  sha: HEAD of default branch at fire time                  │  │
│  │  conclusion: success | failure | cancelled                 │  │
│  └────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘

State transitions:
  active ──(60 days no push)──► disabled_inactivity
  active ──(UI/API disable)──► disabled_manually
  disabled_* ──(UI re-enable)──► active
  actor ──(someone else pushes workflow file)──► new actor (silent!)
```

### Open questions these workflows will answer
- Does the *merger* vs. *PR author* become actor on squash-merge?
- If actor loses repo access, does the cron keep running? With what token?
- Does `workflow_run` reliably chain off cron for alerting?
- Can you detect a cron that *stopped running* (negative event)?
- What does the API surface look like for disabled workflows?

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

## Known behaviors (from docs)

1. **Schedule only runs on default branch.** The workflow file must exist on the default branch for the cron to be registered.
2. **`github.actor` = last person to commit to the workflow file** on the default branch. This is the person whose permissions are used for `GITHUB_TOKEN`.
3. **Cron is best-effort.** GitHub doesn't guarantee exact timing, especially under load. Minimum interval is ~5 minutes in practice.
4. **Disabled after 60 days of inactivity.** If no repo activity for 60 days, scheduled workflows are auto-disabled.
5. **`workflow_dispatch` is a useful escape hatch** — allows manual triggering with the same workflow for testing.
