const { Octokit } = require("@octokit/rest");
const { createAppAuth } = require("@octokit/auth-app");
const { execSync } = require("child_process");
const fs = require("fs");

const CREDS_PATH = "./app-credentials.json";
const OWNER = "stefanpenner-cs";
const REPO = "cron-debugging";
const WORKFLOW_FILE = ".github/workflows/cron-bot-token-test.yml";

async function getAppOctokit() {
  const creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf-8"));
  const appOctokit = new Octokit({
    authStrategy: createAppAuth,
    auth: { appId: creds.app_id, privateKey: creds.pem },
  });
  const { data: installations } = await appOctokit.request("GET /app/installations");
  const installation = installations.find(i => i.account?.login === OWNER);
  if (!installation) {
    console.error(`App not installed on ${OWNER}`);
    process.exit(1);
  }
  return {
    creds,
    octokit: new Octokit({
      authStrategy: createAppAuth,
      auth: { appId: creds.app_id, privateKey: creds.pem, installationId: installation.id },
    }),
  };
}

function getUserOctokit() {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN ||
    execSync("gh auth token", { encoding: "utf-8" }).trim();
  return new Octokit({ auth: token });
}

async function setup() {
  console.log("=== Bot Token Test: Setup ===\n");
  console.log("Step 1: Human pushes the workflow file (sets actor to human)");
  console.log("Step 2: Bot changes the cron expression (transfers actor to bot)");
  console.log("Step 3: Wait for schedule run, then check token permissions\n");

  const { creds, octokit: botOctokit } = await getAppOctokit();

  console.log("1. Reading workflow file...");
  const { data: file } = await botOctokit.repos.getContent({
    owner: OWNER, repo: REPO, path: WORKFLOW_FILE,
  });

  const content = Buffer.from(file.content, "base64").toString("utf-8");
  const cronMatch = content.match(/- cron: "([^"]+)"/);
  if (!cronMatch) {
    console.error("Could not find cron expression!");
    process.exit(1);
  }

  const oldCron = cronMatch[1];
  const newCron = oldCron === "*/5 * * * *" ? "*/8 * * * *" : "*/5 * * * *";
  console.log(`   Current cron: "${oldCron}"`);
  console.log(`   New cron:     "${newCron}"`);

  const newContent = content.replace(`- cron: "${oldCron}"`, `- cron: "${newCron}"`);

  console.log("\n2. Bot committing cron syntax change...");
  const { data: commit } = await botOctokit.repos.createOrUpdateFileContents({
    owner: OWNER, repo: REPO, path: WORKFLOW_FILE,
    message: `test: bot changes bot-token-test cron "${oldCron}" → "${newCron}"`,
    content: Buffer.from(newContent).toString("base64"),
    sha: file.sha,
    branch: "main",
  });

  console.log(`   Committed: ${commit.commit.sha}`);
  console.log(`   Author:    ${commit.commit.author.name}`);

  console.log("\n3. Now wait for the schedule to fire, then run:");
  console.log("   node bot-token-test.js check");

  try { execSync("git pull --rebase", { stdio: "inherit" }); } catch {}
}

async function check() {
  console.log("=== Bot Token Test: Check ===\n");

  const userOctokit = getUserOctokit();

  const { data: runs } = await userOctokit.actions.listWorkflowRuns({
    owner: OWNER, repo: REPO,
    workflow_id: "cron-bot-token-test.yml",
    event: "schedule",
    per_page: 5,
  });

  if (runs.workflow_runs.length === 0) {
    console.log("No schedule runs yet. Wait for cron to fire.");
    return;
  }

  console.log("Schedule runs:\n");
  for (const run of runs.workflow_runs) {
    console.log(`  ${run.id} | actor: ${run.actor.login} (${run.actor.type}) | ${run.created_at} | ${run.conclusion}`);
  }

  const latest = runs.workflow_runs[0];
  console.log(`\nLatest run: ${latest.id} (actor: ${latest.actor.login})`);

  if (latest.conclusion !== "success" && latest.conclusion !== "failure") {
    console.log(`Run is still ${latest.status}. Wait for it to complete.`);
    return;
  }

  console.log("\nFetching job logs...\n");
  const { data: jobs } = await userOctokit.actions.listJobsForWorkflowRun({
    owner: OWNER, repo: REPO, run_id: latest.id,
  });

  for (const job of jobs.jobs) {
    console.log(`--- Job: ${job.name} (${job.conclusion}) ---`);

    try {
      const logResp = await userOctokit.request(
        "GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs",
        { owner: OWNER, repo: REPO, job_id: job.id }
      );
      const logs = typeof logResp.data === "string" ? logResp.data : "";
      const lines = logs.split("\n").filter(l =>
        l.includes("GET ") || l.includes("POST ") || l.includes("PUT ") ||
        l.includes("DELETE ") || l.includes("actor") || l.includes("Summary") ||
        l.includes("200") || l.includes("201") || l.includes("204") ||
        l.includes("403") || l.includes("404")
      );
      for (const line of lines) {
        const clean = line.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s*/, "");
        console.log(`  ${clean}`);
      }
    } catch (e) {
      console.log(`  (could not fetch logs: ${e.message})`);
    }
    console.log("");
  }

  console.log("=== Analysis ===");
  console.log(`Actor: ${latest.actor.login} (${latest.actor.type})`);
  if (latest.actor.type === "Bot") {
    console.log("Bot IS the actor. Check above results:");
    console.log("  - default-permissions job: if writes returned 2xx → bot actor gets full repo defaults");
    console.log("  - explicit-permissions job: if writes returned 403 → permissions block restricts bot actor too");
  } else {
    console.log("Actor is NOT a bot. The bot may not have changed the cron expression yet.");
    console.log("Run: node bot-token-test.js setup");
  }
}

async function poll() {
  console.log("=== Bot Token Test: Poll ===\n");
  const userOctokit = getUserOctokit();

  for (let i = 1; i <= 20; i++) {
    const { data: runs } = await userOctokit.actions.listWorkflowRuns({
      owner: OWNER, repo: REPO,
      workflow_id: "cron-bot-token-test.yml",
      event: "schedule",
      per_page: 1,
    });

    if (runs.workflow_runs.length > 0) {
      const run = runs.workflow_runs[0];
      if (run.actor.type === "Bot") {
        console.log(`\nBot-actor run found: ${run.id} (${run.conclusion || run.status})\n`);
        if (run.conclusion) {
          await check();
        } else {
          console.log("Run still in progress. Waiting...");
        }
        return;
      }
    }

    console.log(`  [${i}/20] No bot-actor schedule run yet...`);
    if (i < 20) await new Promise(r => setTimeout(r, 60000));
  }

  console.log("\nTimed out. Run: node bot-token-test.js check");
}

const action = process.argv[2];
const actions = { setup, check, poll };

if (actions[action]) {
  actions[action]().catch(err => {
    console.error("Error:", err.message);
    if (err.response) console.error(err.response.status, JSON.stringify(err.response.data));
    process.exit(1);
  });
} else {
  console.log("Bot Token Permission Test");
  console.log("=========================");
  console.log("Tests what GITHUB_TOKEN permissions a schedule run gets when the actor is a bot.\n");
  console.log("Two jobs in the workflow:");
  console.log("  1. default-permissions: no explicit block → should get repo defaults (write-all)");
  console.log("  2. explicit-permissions: read-only block → should restrict to read-only\n");
  console.log("Usage:");
  console.log("  node bot-token-test.js setup   # bot changes cron expression (becomes actor)");
  console.log("  node bot-token-test.js poll    # wait for bot-actor schedule run");
  console.log("  node bot-token-test.js check   # inspect run results");
}
