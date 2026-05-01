const { Octokit } = require("@octokit/rest");
const { execSync } = require("child_process");
const fs = require("fs");

const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || execSync("gh auth token", { encoding: "utf-8" }).trim();

const octokit = new Octokit({ auth: token });
const OWNER = "stefanpenner-cs";
const REPO = "cron-debugging";

const results = [];

async function probe(name, method, url, { body, description, notes } = {}) {
  const fullUrl = url.replace("{owner}", OWNER).replace("{repo}", REPO);
  const requestOpts = {
    method,
    url: fullUrl,
    headers: { "X-GitHub-Api-Version": "2022-11-28" },
  };
  if (body) requestOpts.data = body;

  const entry = {
    name,
    description,
    notes,
    request: {
      method,
      url: fullUrl,
      headers: {
        Authorization: "token [REDACTED]",
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "octokit-probe",
      },
      body: body || null,
    },
    response: null,
    error: null,
  };

  try {
    const resp = await octokit.request(requestOpts);
    entry.response = {
      status: resp.status,
      headers: filterHeaders(resp.headers),
      body: resp.data,
    };
  } catch (err) {
    entry.response = {
      status: err.status || "N/A",
      headers: filterHeaders(err.response?.headers || {}),
      body: err.response?.data || { message: err.message },
    };
    entry.error = true;
  }

  results.push(entry);
  console.log(
    `  ${entry.error ? "✗" : "✓"} ${method} ${fullUrl} → ${entry.response.status}`
  );
  return entry;
}

function filterHeaders(headers) {
  const dominated = [
    "x-github-api-version-selected",
    "x-github-media-type",
    "x-github-request-id",
    "x-ratelimit-limit",
    "x-ratelimit-remaining",
    "x-ratelimit-reset",
    "x-ratelimit-used",
    "x-ratelimit-resource",
    "content-type",
    "content-length",
    "cache-control",
    "etag",
    "last-modified",
    "vary",
    "access-control-allow-origin",
    "access-control-expose-headers",
    "referrer-policy",
    "strict-transport-security",
    "x-content-type-options",
    "x-frame-options",
    "x-xss-protection",
    "x-accepted-oauth-scopes",
    "x-oauth-scopes",
    "x-oauth-client-id",
    "x-github-sso",
    "date",
    "server",
    "transfer-encoding",
    "content-security-policy",
    "x-github-api-version-selected",
  ];
  const keep = {};
  for (const [k, v] of Object.entries(headers)) {
    keep[k] = v;
  }
  return keep;
}

function truncateBody(body, maxKeys = 30) {
  if (body === null || body === undefined) return null;
  if (typeof body !== "object") return body;

  if (Array.isArray(body)) {
    if (body.length === 0) return body;
    return {
      _note: `array with ${body.length} item(s) — showing first`,
      first_item: truncateBody(body[0], maxKeys),
    };
  }

  const keys = Object.keys(body);
  const result = {};
  for (const k of keys.slice(0, maxKeys)) {
    const v = body[k];
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const subKeys = Object.keys(v);
      if (subKeys.length > 10) {
        result[k] = `{object with ${subKeys.length} keys: ${subKeys.slice(0, 8).join(", ")}, ...}`;
      } else {
        result[k] = v;
      }
    } else if (Array.isArray(v)) {
      if (v.length === 0) {
        result[k] = [];
      } else if (v.length <= 3 && typeof v[0] !== "object") {
        result[k] = v;
      } else {
        result[k] = `[array of ${v.length}]`;
      }
    } else {
      result[k] = v;
    }
  }
  if (keys.length > maxKeys) {
    result._truncated = `${keys.length - maxKeys} more keys`;
  }
  return result;
}

function generateMarkdown() {
  const sections = [];

  for (const r of results) {
    const lines = [];
    lines.push(`### ${r.name}`);
    if (r.description) lines.push("", r.description);
    if (r.notes) lines.push("", `> ${r.notes}`);
    lines.push("");

    lines.push("**Request**");
    lines.push("```");
    lines.push(`${r.request.method} ${r.request.url}`);
    for (const [k, v] of Object.entries(r.request.headers)) {
      lines.push(`${k}: ${v}`);
    }
    if (r.request.body) {
      lines.push("");
      lines.push(JSON.stringify(r.request.body, null, 2));
    }
    lines.push("```");
    lines.push("");

    lines.push(
      `**Response** — \`${r.response.status}${r.error ? " (error)" : ""}\``
    );

    lines.push("");
    lines.push("Headers:");
    lines.push("```");
    for (const [k, v] of Object.entries(r.response.headers)) {
      lines.push(`${k}: ${v}`);
    }
    lines.push("```");

    lines.push("");
    lines.push("Body:");
    lines.push("```json");
    lines.push(JSON.stringify(truncateBody(r.response.body), null, 2));
    lines.push("```");

    sections.push(lines.join("\n"));
  }

  return sections.join("\n\n---\n\n");
}

async function main() {
  console.log("Probing GitHub Actions API endpoints...\n");

  // ── Workflows ──
  console.log("== Workflows ==");

  const listWf = await probe("List repository workflows", "GET",
    "/repos/{owner}/{repo}/actions/workflows", {
      description: "Returns all workflow files registered in the repo.",
      notes: "state field reveals active/disabled_manually/disabled_inactivity — key for cron monitoring.",
    });

  const workflows = listWf.response.body?.workflows || [];
  const firstWf = workflows[0];
  const cronWf = workflows.find(w => w.path?.includes("cron-basic")) || firstWf;

  if (cronWf) {
    await probe("Get a single workflow", "GET",
      `/repos/{owner}/{repo}/actions/workflows/${cronWf.id}`, {
        description: "Fetch details for one workflow by ID.",
        notes: "Also accepts the workflow filename as the ID, e.g. cron-basic.yml.",
      });

    await probe("Get workflow by filename", "GET",
      `/repos/{owner}/{repo}/actions/workflows/${cronWf.path?.split("/").pop()}`, {
        description: "Same endpoint but using the filename instead of numeric ID.",
      });
  }

  // ── Workflow Runs ──
  console.log("\n== Workflow Runs ==");

  const listRuns = await probe("List workflow runs for repo", "GET",
    "/repos/{owner}/{repo}/actions/runs?per_page=3", {
      description: "All runs across all workflows. Filterable by event, status, branch, actor.",
      notes: "Use event=schedule to filter to cron-triggered runs only.",
    });

  await probe("List workflow runs (schedule only)", "GET",
    "/repos/{owner}/{repo}/actions/runs?event=schedule&per_page=3", {
      description: "Filtered to only schedule-triggered runs.",
      notes: "This is the key query for cron observability — if this returns nothing, your crons haven't fired.",
    });

  if (cronWf) {
    await probe("List runs for a specific workflow", "GET",
      `/repos/{owner}/{repo}/actions/workflows/${cronWf.id}/runs?per_page=3`, {
        description: "Runs for a single workflow. Can also filter by event, status, etc.",
      });
  }

  const runs = listRuns.response.body?.workflow_runs || [];
  const firstRun = runs.find(r => r.status === "completed") || runs[0];

  if (firstRun) {
    await probe("Get a single workflow run", "GET",
      `/repos/{owner}/{repo}/actions/runs/${firstRun.id}`, {
        description: "Full details for one run — actor, triggering_actor, conclusion, timing.",
        notes: "For cron: actor = last committer to workflow file. triggering_actor = same.",
      });

    // ── Jobs ──
    console.log("\n== Jobs ==");

    const jobsResult = await probe("List jobs for a workflow run", "GET",
      `/repos/{owner}/{repo}/actions/runs/${firstRun.id}/jobs`, {
        description: "All jobs within a run — each has its own status, conclusion, steps.",
      });

    const jobs = jobsResult.response.body?.jobs || [];
    if (jobs[0]) {
      await probe("Get a single job", "GET",
        `/repos/{owner}/{repo}/actions/jobs/${jobs[0].id}`, {
          description: "Detailed job info including step-level status and timing.",
        });
    }

    // ── Logs ──
    console.log("\n== Logs ==");

    await probe("Download workflow run logs", "GET",
      `/repos/{owner}/{repo}/actions/runs/${firstRun.id}/logs`, {
        description: "Returns a redirect (302) to a zip archive of all job logs.",
        notes: "Octokit follows the redirect and returns the zip. Useful for post-mortem on cron failures.",
      });

    // ── Run Attempts ──
    console.log("\n== Run Attempts ==");

    await probe("Get workflow run attempt", "GET",
      `/repos/{owner}/{repo}/actions/runs/${firstRun.id}/attempts/1`, {
        description: "Get details for a specific attempt of a run (runs can be retried).",
      });

    // ── Timing ──
    console.log("\n== Timing ==");

    await probe("Get workflow run usage/timing", "GET",
      `/repos/{owner}/{repo}/actions/runs/${firstRun.id}/timing`, {
        description: "Billable time breakdown by OS. Useful for tracking cron cost.",
      });
  }

  // ── Workflow Dispatch ──
  console.log("\n== Workflow Dispatch ==");

  if (cronWf) {
    // Don't actually dispatch — just document the request shape
    await probe("Create workflow dispatch event", "POST",
      `/repos/{owner}/{repo}/actions/workflows/${cronWf.id}/dispatches`, {
        body: { ref: "main" },
        description: "Manually trigger a workflow. All our cron workflows accept this.",
        notes: "This is the escape hatch for testing cron workflows without waiting for the schedule.",
      });
  }

  // ── Enable / Disable ──
  console.log("\n== Enable / Disable ==");

  if (cronWf) {
    await probe("Disable a workflow", "PUT",
      `/repos/{owner}/{repo}/actions/workflows/${cronWf.id}/disable`, {
        description: "Disables a workflow — it won't run on schedule or any other trigger.",
        notes: "Requires actions:write scope. GITHUB_TOKEN in a cron run only has actions:read by default.",
      });

    await probe("Enable a workflow", "PUT",
      `/repos/{owner}/{repo}/actions/workflows/${cronWf.id}/enable`, {
        description: "Re-enables a previously disabled workflow.",
        notes: "This is how you recover from 60-day auto-disable or manual disable.",
      });
  }

  // ── Artifacts ──
  console.log("\n== Artifacts ==");

  await probe("List workflow run artifacts", "GET",
    `/repos/{owner}/{repo}/actions/artifacts?per_page=3`, {
      description: "Artifacts uploaded during workflow runs. Cron jobs can upload diagnostic artifacts.",
    });

  // ── Workflow Permissions ──
  console.log("\n== Repository-level workflow permissions ==");

  await probe("Get default workflow permissions", "GET",
    `/repos/{owner}/{repo}/actions/permissions`, {
      description: "Org/repo-level Actions permissions — whether Actions is enabled, allowed actions policy.",
    });

  await probe("Get default GITHUB_TOKEN permissions", "GET",
    `/repos/{owner}/{repo}/actions/permissions/workflow`, {
      description: "Default GITHUB_TOKEN permission level (read or read-write) and whether workflows can approve PRs.",
      notes: "This is the baseline — individual workflows can restrict further via the permissions key.",
    });

  // ── Write output ──
  console.log(`\nProbed ${results.length} endpoints. Writing output...`);

  const md = generateMarkdown();
  fs.writeFileSync("api-endpoints.md", `# GitHub Actions API Endpoints for Cron Workflows\n\nGenerated by \`probe-endpoints.js\` on ${new Date().toISOString()}\n\nRepo: \`${OWNER}/${REPO}\`\n\n---\n\n${md}\n`);
  console.log("Wrote api-endpoints.md");

  const json = JSON.stringify(results, null, 2);
  fs.writeFileSync("api-endpoints.json", json);
  console.log("Wrote api-endpoints.json (full responses)");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
