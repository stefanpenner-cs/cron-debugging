const { Octokit } = require("@octokit/rest");
const { createAppAuth } = require("@octokit/auth-app");
const { execSync } = require("child_process");
const fs = require("fs");

const CREDS_PATH = "./app-credentials.json";
const OWNER = "stefanpenner-cs";
const REPO = "cron-debugging";
const WORKFLOW_FILE = ".github/workflows/cron-basic.yml";
const STATE_FILE = "./cron-syntax-change-state.json";

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
      auth: {
        appId: creds.app_id,
        privateKey: creds.pem,
        installationId: installation.id,
      },
    }),
  };
}

function getUserOctokit() {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN ||
    execSync("gh auth token", { encoding: "utf-8" }).trim();
  return new Octokit({ auth: token });
}

async function setup() {
  console.log("=== Cron Syntax Change Test: Setup ===\n");
  console.log("Goal: bot changes the actual cron expression to test whether");
  console.log("the schedule actor changes to the bot.\n");

  const { creds, octokit: botOctokit } = await getAppOctokit();
  const userOctokit = getUserOctokit();

  // Record pre-change state
  console.log("1. Recording pre-change schedule runs...");
  const { data: preRuns } = await userOctokit.actions.listWorkflowRuns({
    owner: OWNER, repo: REPO,
    workflow_id: "cron-basic.yml",
    event: "schedule",
    per_page: 3,
  });

  if (preRuns.workflow_runs.length > 0) {
    for (const run of preRuns.workflow_runs) {
      console.log(`   run ${run.id} | actor: ${run.actor.login} | ${run.created_at}`);
    }
  } else {
    console.log("   No schedule runs yet.");
  }

  // Read the current workflow file
  console.log("\n2. Reading current workflow file...");
  const { data: file } = await botOctokit.repos.getContent({
    owner: OWNER, repo: REPO, path: WORKFLOW_FILE,
  });

  const content = Buffer.from(file.content, "base64").toString("utf-8");

  // Find the current cron expression
  const cronMatch = content.match(/- cron: "([^"]+)"/);
  if (!cronMatch) {
    console.error("Could not find cron expression in workflow file!");
    process.exit(1);
  }

  const oldCron = cronMatch[1];
  console.log(`   Current cron: "${oldCron}"`);

  // Change to a different expression
  // Toggle between */5 and */7 so the test is repeatable
  const newCron = oldCron === "*/5 * * * *" ? "*/7 * * * *" : "*/5 * * * *";
  console.log(`   New cron:     "${newCron}"`);

  const newContent = content.replace(
    `- cron: "${oldCron}"`,
    `- cron: "${newCron}"`
  );

  // Bot commits the cron syntax change
  console.log("\n3. Bot committing cron syntax change...");
  const { data: commit } = await botOctokit.repos.createOrUpdateFileContents({
    owner: OWNER, repo: REPO, path: WORKFLOW_FILE,
    message: `test: bot changes cron syntax from "${oldCron}" to "${newCron}"`,
    content: Buffer.from(newContent).toString("base64"),
    sha: file.sha,
    branch: "main",
  });

  console.log(`   Committed: ${commit.commit.sha}`);
  console.log(`   Author:    ${commit.commit.author.name} <${commit.commit.author.email}>`);
  console.log(`   Committer: ${commit.commit.committer.name} <${commit.commit.committer.email}>`);

  // Verify via the push event
  console.log("\n4. Verifying push event...");
  const { data: events } = await userOctokit.request("GET /repos/{owner}/{repo}/events", {
    owner: OWNER, repo: REPO, per_page: 5,
  });

  const pushEvent = events.find(e => e.type === "PushEvent" && e.payload?.head === commit.commit.sha);
  if (pushEvent) {
    console.log(`   Push actor: ${pushEvent.actor.login}`);
  }

  // Save state for the check phase
  const state = {
    timestamp: new Date().toISOString(),
    commitSha: commit.commit.sha,
    oldCron,
    newCron,
    commitAuthor: commit.commit.author.name,
    commitAuthorEmail: commit.commit.author.email,
    preChangeActor: preRuns.workflow_runs.length > 0 ? preRuns.workflow_runs[0].actor.login : null,
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  console.log(`\n5. State saved to ${STATE_FILE}`);

  console.log("\n" + "=".repeat(60));
  console.log("SETUP COMPLETE");
  console.log("=".repeat(60));
  console.log(`\nThe bot changed the cron expression from "${oldCron}" to "${newCron}".`);
  console.log(`\nThe cron "${newCron}" will fire at the next matching minute.`);
  console.log("Wait for a schedule run, then run:");
  console.log("  node cron-syntax-change-test.js check");
  console.log("\nOr poll with:");
  console.log("  node cron-syntax-change-test.js poll");

  try { execSync("git pull --rebase", { stdio: "inherit" }); } catch {}
}

async function check() {
  console.log("=== Cron Syntax Change Test: Check ===\n");

  if (!fs.existsSync(STATE_FILE)) {
    console.error("No state file found. Run setup first:");
    console.error("  node cron-syntax-change-test.js setup");
    process.exit(1);
  }

  const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
  console.log(`Setup ran at: ${state.timestamp}`);
  console.log(`Cron changed: "${state.oldCron}" → "${state.newCron}"`);
  console.log(`By commit:    ${state.commitSha} (author: ${state.commitAuthor})`);
  console.log(`Pre-change actor: ${state.preChangeActor}`);
  console.log("");

  const userOctokit = getUserOctokit();

  // Get all schedule runs
  const { data: runs } = await userOctokit.actions.listWorkflowRuns({
    owner: OWNER, repo: REPO,
    workflow_id: "cron-basic.yml",
    event: "schedule",
    per_page: 20,
  });

  const changeTime = new Date(state.timestamp);
  const runsAfter = runs.workflow_runs.filter(r => new Date(r.created_at) > changeTime);
  const runsBefore = runs.workflow_runs.filter(r => new Date(r.created_at) <= changeTime);

  console.log(`Schedule runs BEFORE syntax change (${runsBefore.length}):`);
  for (const run of runsBefore.slice(0, 5)) {
    console.log(`  ${run.id} | actor: ${run.actor.login} | sha: ${run.head_sha.slice(0, 7)} | ${run.created_at}`);
  }

  console.log(`\nSchedule runs AFTER syntax change (${runsAfter.length}):`);
  if (runsAfter.length === 0) {
    console.log("  None yet — the new cron hasn't fired. Wait and re-run check.");
    return;
  }

  for (const run of runsAfter) {
    console.log(`  ${run.id} | actor: ${run.actor.login} | sha: ${run.head_sha.slice(0, 7)} | ${run.created_at}`);
  }

  // Analysis
  console.log("\n" + "=".repeat(60));
  console.log("ANALYSIS");
  console.log("=".repeat(60));

  const preActors = new Set(runsBefore.map(r => r.actor.login));
  const postActors = new Set(runsAfter.map(r => r.actor.login));

  console.log(`\nPre-change actors:  ${[...preActors].join(", ") || "(none)"}`);
  console.log(`Post-change actors: ${[...postActors].join(", ")}`);

  const botBecameActor = [...postActors].some(a => a.includes("[bot]") || a === "cron-actor-probe[bot]");
  const actorChanged = state.preChangeActor && ![...postActors].has(state.preChangeActor);

  if (botBecameActor || actorChanged) {
    console.log("\n*** ACTOR CHANGED after bot modified cron syntax! ***");
    console.log("This confirms: changing the cron expression DOES update the actor.");
    if (botBecameActor) {
      console.log("The bot became the cron actor by modifying the cron syntax.");
    }
  } else {
    console.log("\nActor did NOT change — still the same as before the syntax change.");
    console.log("This could mean:");
    console.log("  a) The mechanism is NOT purely about cron syntax diffs");
    console.log("  b) Bot/app accounts cannot become cron actors");
    console.log("  c) The actor is determined by something else (e.g., the push event actor's GitHub user type)");
  }

  // Also check the commit details for the runs
  console.log("\nDetailed run info for post-change runs:");
  for (const run of runsAfter.slice(0, 3)) {
    console.log(`\n  Run ${run.id}:`);
    console.log(`    actor:             ${run.actor.login} (type: ${run.actor.type})`);
    console.log(`    triggering_actor:  ${run.triggering_actor.login} (type: ${run.triggering_actor.type})`);
    console.log(`    head_sha:          ${run.head_sha}`);
    console.log(`    head_branch:       ${run.head_branch}`);
    console.log(`    created_at:        ${run.created_at}`);
  }

  // Get the job logs for the most recent post-change run
  if (runsAfter.length > 0) {
    const latestRun = runsAfter[0];
    console.log(`\nFetching job details for run ${latestRun.id}...`);
    try {
      const { data: jobs } = await userOctokit.actions.listJobsForWorkflowRun({
        owner: OWNER, repo: REPO, run_id: latestRun.id,
      });
      if (jobs.jobs.length > 0) {
        console.log(`  Job status: ${jobs.jobs[0].status} / ${jobs.jobs[0].conclusion}`);
      }
    } catch (e) {
      console.log(`  (could not fetch job details: ${e.message})`);
    }
  }
}

async function poll() {
  console.log("=== Cron Syntax Change Test: Poll ===\n");

  if (!fs.existsSync(STATE_FILE)) {
    console.error("No state file found. Run setup first.");
    process.exit(1);
  }

  const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
  const changeTime = new Date(state.timestamp);
  const userOctokit = getUserOctokit();

  console.log(`Waiting for schedule run after ${state.timestamp}...`);
  console.log(`Cron expression: "${state.newCron}"`);
  console.log(`Checking every 60s...\n`);

  for (let attempt = 1; attempt <= 20; attempt++) {
    const { data: runs } = await userOctokit.actions.listWorkflowRuns({
      owner: OWNER, repo: REPO,
      workflow_id: "cron-basic.yml",
      event: "schedule",
      per_page: 5,
    });

    const runsAfter = runs.workflow_runs.filter(r => new Date(r.created_at) > changeTime);

    if (runsAfter.length > 0) {
      console.log(`\nFound ${runsAfter.length} run(s) after syntax change!\n`);
      await check();
      return;
    }

    const elapsed = Math.round((Date.now() - changeTime.getTime()) / 1000);
    console.log(`  [${attempt}/20] ${elapsed}s elapsed — no new schedule runs yet`);

    if (attempt < 20) {
      await new Promise(r => setTimeout(r, 60000));
    }
  }

  console.log("\nTimed out after 20 minutes. The cron may have longer latency.");
  console.log("Run manually: node cron-syntax-change-test.js check");
}

async function restore() {
  console.log("=== Cron Syntax Change Test: Restore ===\n");
  console.log("Restoring cron expression to */5 * * * * as the HUMAN user.\n");
  console.log("This verifies the reverse: does the actor change back to the human?\n");

  const userOctokit = getUserOctokit();

  const { data: file } = await userOctokit.repos.getContent({
    owner: OWNER, repo: REPO, path: WORKFLOW_FILE,
  });

  const content = Buffer.from(file.content, "base64").toString("utf-8");
  const cronMatch = content.match(/- cron: "([^"]+)"/);
  if (!cronMatch) {
    console.error("Could not find cron expression!");
    process.exit(1);
  }

  const currentCron = cronMatch[1];
  if (currentCron === "*/5 * * * *") {
    console.log("Cron is already */5 * * * * — nothing to restore.");
    return;
  }

  const newContent = content.replace(
    `- cron: "${currentCron}"`,
    `- cron: "*/5 * * * *"`
  );

  const { data: commit } = await userOctokit.repos.createOrUpdateFileContents({
    owner: OWNER, repo: REPO, path: WORKFLOW_FILE,
    message: `test: restore cron to */5 (human user change)`,
    content: Buffer.from(newContent).toString("base64"),
    sha: file.sha,
    branch: "main",
  });

  console.log(`Committed: ${commit.commit.sha}`);
  console.log(`Author:    ${commit.commit.author.name}`);
  console.log(`Cron restored to: "*/5 * * * *"`);
  console.log("\nWait for schedule runs and check actor — should revert to stefanpenner.");

  try { execSync("git pull --rebase", { stdio: "inherit" }); } catch {}
}

// CLI
const action = process.argv[2];
const actions = { setup, check, poll, restore };

if (actions[action]) {
  actions[action]().catch(err => {
    console.error("Error:", err.message);
    if (err.response) {
      console.error("Status:", err.response.status);
      console.error("Data:", JSON.stringify(err.response.data, null, 2));
    }
    process.exit(1);
  });
} else {
  console.log("Cron Syntax Change Test");
  console.log("=======================");
  console.log("Tests whether changing the actual cron expression (not just comments)");
  console.log("changes the schedule actor. This is the definitive test that prior");
  console.log("experiments could not answer.\n");
  console.log("Usage:");
  console.log("  node cron-syntax-change-test.js setup    # bot changes cron syntax");
  console.log("  node cron-syntax-change-test.js check    # check actor on post-change runs");
  console.log("  node cron-syntax-change-test.js poll     # wait + auto-check (up to 20 min)");
  console.log("  node cron-syntax-change-test.js restore  # human restores cron to */5");
}
