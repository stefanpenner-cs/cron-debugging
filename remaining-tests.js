const { Octokit } = require("@octokit/rest");
const { createAppAuth } = require("@octokit/auth-app");
const { execSync } = require("child_process");
const fs = require("fs");

const CREDS_PATH = "./app-credentials.json";
const OWNER = "stefanpenner-cs";
const REPO = "cron-debugging";

async function getAppOctokit() {
  const creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf-8"));
  const appOctokit = new Octokit({
    authStrategy: createAppAuth,
    auth: { appId: creds.app_id, privateKey: creds.pem },
  });
  const { data: installations } = await appOctokit.request("GET /app/installations");
  const installation = installations.find(i => i.account?.login === OWNER);
  if (!installation) { console.error(`App not installed on ${OWNER}`); process.exit(1); }
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

// ============================================================
// Test 1: Rebase merge attribution
// ============================================================
async function rebaseSetup() {
  console.log("=== Rebase Merge Test: Setup ===\n");
  console.log("Bot authors cron change on branch, user merges with REBASE method.\n");

  const { creds, octokit: botOctokit } = await getAppOctokit();
  const userOctokit = getUserOctokit();
  const workflowFile = ".github/workflows/cron-rebase-merge-test.yml";
  const branchName = `test/rebase-merge-cron-${Date.now()}`;

  // Create branch from main
  console.log("1. Creating branch from main...");
  const { data: ref } = await botOctokit.git.getRef({ owner: OWNER, repo: REPO, ref: "heads/main" });
  await botOctokit.git.createRef({
    owner: OWNER, repo: REPO,
    ref: `refs/heads/${branchName}`,
    sha: ref.object.sha,
  });

  // Bot changes the cron expression on the branch
  console.log("2. Bot changing cron expression on branch...");
  const { data: file } = await botOctokit.repos.getContent({
    owner: OWNER, repo: REPO, path: workflowFile, ref: branchName,
  });
  const content = Buffer.from(file.content, "base64").toString("utf-8");
  const currentCron = content.match(/cron: "([^"]+)"/)[1];
  const newCron = currentCron === "*/5 * * * *" ? "*/6 * * * *" : "*/5 * * * *";
  const newContent = content.replace(`cron: "${currentCron}"`, `cron: "${newCron}"`);

  const { data: commit } = await botOctokit.repos.createOrUpdateFileContents({
    owner: OWNER, repo: REPO, path: workflowFile,
    message: `test: bot changes cron ${currentCron} → ${newCron} (rebase test)`,
    content: Buffer.from(newContent).toString("base64"),
    sha: file.sha,
    branch: branchName,
  });
  console.log(`   Commit author: ${commit.commit.author.name}`);
  console.log(`   Cron: ${currentCron} → ${newCron}`);

  // Bot opens PR
  console.log("3. Bot opening PR...");
  const { data: pr } = await botOctokit.pulls.create({
    owner: OWNER, repo: REPO,
    title: `test: rebase merge cron change (${currentCron} → ${newCron})`,
    body: "Bot authored cron change. User merges with REBASE method.\nWho becomes actor?",
    head: branchName, base: "main",
  });
  console.log(`   PR #${pr.number}: ${pr.html_url}`);

  // User merges with REBASE
  console.log("4. User merging with REBASE method...");
  const { data: merge } = await userOctokit.pulls.merge({
    owner: OWNER, repo: REPO,
    pull_number: pr.number,
    merge_method: "rebase",
  });
  console.log(`   Merged! SHA: ${merge.sha}`);

  // Check commit attribution
  const { data: mergeCommit } = await userOctokit.git.getCommit({
    owner: OWNER, repo: REPO, commit_sha: merge.sha,
  });
  console.log(`   Commit author:    ${mergeCommit.author.name}`);
  console.log(`   Commit committer: ${mergeCommit.committer.name}`);

  // Check push event
  await new Promise(r => setTimeout(r, 3000));
  const { data: events } = await userOctokit.request("GET /repos/{owner}/{repo}/events", {
    owner: OWNER, repo: REPO, per_page: 5,
  });
  const pushEvent = events.find(e => e.type === "PushEvent");
  if (pushEvent) console.log(`   Push event actor: ${pushEvent.actor.login}`);

  // Cleanup branch
  await botOctokit.git.deleteRef({ owner: OWNER, repo: REPO, ref: `heads/${branchName}` }).catch(() => {});

  console.log("\nWait for schedule run, then: node remaining-tests.js rebase-check");
  try { execSync("git pull --rebase", { stdio: "inherit" }); } catch {}
}

async function rebaseCheck() {
  console.log("=== Rebase Merge Test: Check ===\n");
  const userOctokit = getUserOctokit();
  const { data: runs } = await userOctokit.actions.listWorkflowRuns({
    owner: OWNER, repo: REPO,
    workflow_id: "cron-rebase-merge-test.yml",
    event: "schedule", per_page: 10,
  });
  if (runs.workflow_runs.length === 0) {
    console.log("No schedule runs yet.");
    return;
  }
  for (const run of runs.workflow_runs) {
    console.log(`  ${run.id} | actor: ${run.actor.login} (${run.actor.type}) | ${run.created_at}`);
  }
}

// ============================================================
// Test 2: Reactivation actor update
// ============================================================
async function reactivationSetup() {
  console.log("=== Reactivation Test: Setup ===\n");
  console.log("1. Disable workflow\n2. Bot changes cron expression\n3. Re-enable\n4. Check who actor is\n");

  const { creds, octokit: botOctokit } = await getAppOctokit();
  const userOctokit = getUserOctokit();
  const workflowFile = ".github/workflows/cron-reactivation-test.yml";

  // Get workflow ID
  const { data: wf } = await userOctokit.actions.getWorkflow({
    owner: OWNER, repo: REPO, workflow_id: "cron-reactivation-test.yml",
  });
  console.log(`Workflow: ${wf.name} (${wf.id}), state: ${wf.state}`);

  // Record pre-disable runs
  const { data: preRuns } = await userOctokit.actions.listWorkflowRuns({
    owner: OWNER, repo: REPO, workflow_id: "cron-reactivation-test.yml",
    event: "schedule", per_page: 3,
  });
  if (preRuns.workflow_runs.length > 0) {
    console.log("\nPre-disable schedule runs:");
    for (const r of preRuns.workflow_runs) {
      console.log(`  ${r.id} | actor: ${r.actor.login} | ${r.created_at}`);
    }
  }

  // Step 1: Disable the workflow
  console.log("\n1. Disabling workflow...");
  await userOctokit.request("PUT /repos/{owner}/{repo}/actions/workflows/{workflow_id}/disable", {
    owner: OWNER, repo: REPO, workflow_id: wf.id,
  });
  const { data: wfDisabled } = await userOctokit.actions.getWorkflow({
    owner: OWNER, repo: REPO, workflow_id: "cron-reactivation-test.yml",
  });
  console.log(`   State: ${wfDisabled.state}`);

  // Step 2: Bot changes cron expression while disabled
  console.log("\n2. Bot changing cron expression while workflow is disabled...");
  const { data: file } = await botOctokit.repos.getContent({
    owner: OWNER, repo: REPO, path: workflowFile,
  });
  const content = Buffer.from(file.content, "base64").toString("utf-8");
  const currentCron = content.match(/cron: "([^"]+)"/)[1];
  const newCron = currentCron === "*/5 * * * *" ? "*/6 * * * *" : "*/5 * * * *";
  const newContent = content.replace(`cron: "${currentCron}"`, `cron: "${newCron}"`);

  const { data: commit } = await botOctokit.repos.createOrUpdateFileContents({
    owner: OWNER, repo: REPO, path: workflowFile,
    message: `test: bot changes disabled workflow cron ${currentCron} → ${newCron}`,
    content: Buffer.from(newContent).toString("base64"),
    sha: file.sha, branch: "main",
  });
  console.log(`   Committed: ${commit.commit.sha.slice(0, 7)}`);
  console.log(`   Author: ${commit.commit.author.name}`);
  console.log(`   Cron: ${currentCron} → ${newCron}`);

  // Step 3: Re-enable the workflow
  console.log("\n3. Re-enabling workflow...");
  await userOctokit.request("PUT /repos/{owner}/{repo}/actions/workflows/{workflow_id}/enable", {
    owner: OWNER, repo: REPO, workflow_id: wf.id,
  });
  const { data: wfEnabled } = await userOctokit.actions.getWorkflow({
    owner: OWNER, repo: REPO, workflow_id: "cron-reactivation-test.yml",
  });
  console.log(`   State: ${wfEnabled.state}`);

  console.log("\nSetup complete. The bot changed cron while disabled, then user re-enabled.");
  console.log("Question: is the actor the bot (who changed syntax) or the user (who re-enabled)?");
  console.log("\nWait for schedule run, then: node remaining-tests.js reactivation-check");
  try { execSync("git pull --rebase", { stdio: "inherit" }); } catch {}
}

async function reactivationCheck() {
  console.log("=== Reactivation Test: Check ===\n");
  const userOctokit = getUserOctokit();
  const { data: runs } = await userOctokit.actions.listWorkflowRuns({
    owner: OWNER, repo: REPO,
    workflow_id: "cron-reactivation-test.yml",
    event: "schedule", per_page: 10,
  });
  if (runs.workflow_runs.length === 0) {
    console.log("No schedule runs yet.");
    return;
  }
  for (const run of runs.workflow_runs) {
    console.log(`  ${run.id} | actor: ${run.actor.login} (${run.actor.type}) | ${run.created_at}`);
  }
}

// ============================================================
// Test 3: Default branch change as actor hijack
// ============================================================
async function defaultBranchSetup() {
  console.log("=== Default Branch Change Test: Setup ===\n");
  console.log("Temporarily switch default branch to test if actor changes.\n");

  const userOctokit = getUserOctokit();
  const { creds, octokit: botOctokit } = await getAppOctokit();

  // Record current actor on this workflow
  const { data: preRuns } = await userOctokit.actions.listWorkflowRuns({
    owner: OWNER, repo: REPO,
    workflow_id: "cron-default-branch-test.yml",
    event: "schedule", per_page: 3,
  });
  if (preRuns.workflow_runs.length > 0) {
    console.log("Pre-change schedule runs:");
    for (const r of preRuns.workflow_runs) {
      console.log(`  ${r.id} | actor: ${r.actor.login} | ${r.created_at}`);
    }
  } else {
    console.log("No pre-change schedule runs yet (new workflow).");
  }

  // Create a temp branch from main
  console.log("\n1. Creating temp branch...");
  const { data: ref } = await userOctokit.git.getRef({ owner: OWNER, repo: REPO, ref: "heads/main" });
  await userOctokit.git.createRef({
    owner: OWNER, repo: REPO,
    ref: "refs/heads/temp-default-branch-test",
    sha: ref.object.sha,
  });

  // Switch default branch to temp, then back to main
  console.log("2. Switching default branch to temp-default-branch-test (as bot)...");
  await botOctokit.repos.update({
    owner: OWNER, repo: REPO,
    default_branch: "temp-default-branch-test",
  });

  // Verify
  const { data: repoData1 } = await userOctokit.repos.get({ owner: OWNER, repo: REPO });
  console.log(`   Default branch: ${repoData1.default_branch}`);

  console.log("3. Switching default branch back to main (as bot)...");
  await botOctokit.repos.update({
    owner: OWNER, repo: REPO,
    default_branch: "main",
  });

  const { data: repoData2 } = await userOctokit.repos.get({ owner: OWNER, repo: REPO });
  console.log(`   Default branch: ${repoData2.default_branch}`);

  // Cleanup temp branch
  console.log("4. Deleting temp branch...");
  await userOctokit.git.deleteRef({
    owner: OWNER, repo: REPO, ref: "heads/temp-default-branch-test",
  }).catch(() => {});

  console.log("\nSetup complete. The BOT changed the default branch (back and forth).");
  console.log("Question: did this change the actor for all cron workflows to the bot?");
  console.log("\nWait for schedule runs, then: node remaining-tests.js default-branch-check");
}

async function defaultBranchCheck() {
  console.log("=== Default Branch Change Test: Check ===\n");
  const userOctokit = getUserOctokit();

  // Check several workflows to see if actors changed
  const workflows = [
    "cron-default-branch-test.yml",
    "cron-ownership-test.yml",
    "cron-token-permissions.yml",
  ];

  for (const wf of workflows) {
    const { data: runs } = await userOctokit.actions.listWorkflowRuns({
      owner: OWNER, repo: REPO, workflow_id: wf,
      event: "schedule", per_page: 5,
    });
    console.log(`${wf}:`);
    if (runs.workflow_runs.length === 0) {
      console.log("  No schedule runs yet.");
    } else {
      for (const run of runs.workflow_runs) {
        console.log(`  ${run.id} | actor: ${run.actor.login} (${run.actor.type}) | ${run.created_at}`);
      }
    }
    console.log("");
  }
}

// ============================================================
// Test 4: Per-expression vs per-file actor
// ============================================================
async function perExpressionSetup() {
  console.log("=== Per-Expression Test: Setup ===\n");
  console.log("Bot changes ONLY the */9 expression (A), leaves */11 (B) untouched.\n");

  const { creds, octokit: botOctokit } = await getAppOctokit();
  const userOctokit = getUserOctokit();
  const workflowFile = ".github/workflows/cron-per-expression-test.yml";

  // Record pre-change runs
  const { data: preRuns } = await userOctokit.actions.listWorkflowRuns({
    owner: OWNER, repo: REPO,
    workflow_id: "cron-per-expression-test.yml",
    event: "schedule", per_page: 5,
  });
  if (preRuns.workflow_runs.length > 0) {
    console.log("Pre-change schedule runs:");
    for (const r of preRuns.workflow_runs) {
      console.log(`  ${r.id} | actor: ${r.actor.login} | ${r.created_at}`);
    }
  } else {
    console.log("No pre-change schedule runs yet (new workflow).");
  }

  // Bot changes only the first cron expression
  console.log("\n1. Bot changing ONLY expression A (*/9)...");
  const { data: file } = await botOctokit.repos.getContent({
    owner: OWNER, repo: REPO, path: workflowFile,
  });
  const content = Buffer.from(file.content, "base64").toString("utf-8");

  // Change */9 to */10 (only the first expression)
  const firstCron = content.match(/- cron: "(\*\/9[^"]*)"/) || content.match(/- cron: "(\*\/10 \* \* \* \*)"/);
  if (!firstCron) {
    console.error("Could not find first cron expression!");
    process.exit(1);
  }
  const oldFirst = firstCron[1];
  const newFirst = oldFirst === "*/9 * * * *" ? "*/10 * * * *" : "*/9 * * * *";
  const newContent = content.replace(`- cron: "${oldFirst}"`, `- cron: "${newFirst}"`);

  // Verify only one expression changed
  const secondCron = newContent.match(/- cron: "\*\/11[^"]*"/);
  if (!secondCron) {
    console.error("Second expression (*/11) was lost during edit!");
    process.exit(1);
  }
  console.log(`   Expression A: "${oldFirst}" → "${newFirst}"`);
  console.log(`   Expression B: "*/11 * * * *" (unchanged)`);

  const { data: commit } = await botOctokit.repos.createOrUpdateFileContents({
    owner: OWNER, repo: REPO, path: workflowFile,
    message: `test: bot changes only expression A (${oldFirst} → ${newFirst}), leaves B unchanged`,
    content: Buffer.from(newContent).toString("base64"),
    sha: file.sha, branch: "main",
  });
  console.log(`   Committed: ${commit.commit.sha.slice(0, 7)}`);
  console.log(`   Author: ${commit.commit.author.name}`);

  console.log("\nSetup complete. Bot changed expression A, left expression B alone.");
  console.log("Key question: does expression B's actor also change to the bot?");
  console.log("  If YES → actor is per-file");
  console.log("  If NO  → actor is per-expression");
  console.log("\nWait for BOTH expressions to fire, then: node remaining-tests.js per-expression-check");
  try { execSync("git pull --rebase", { stdio: "inherit" }); } catch {}
}

async function perExpressionCheck() {
  console.log("=== Per-Expression Test: Check ===\n");
  const userOctokit = getUserOctokit();
  const { data: runs } = await userOctokit.actions.listWorkflowRuns({
    owner: OWNER, repo: REPO,
    workflow_id: "cron-per-expression-test.yml",
    event: "schedule", per_page: 20,
  });
  if (runs.workflow_runs.length === 0) {
    console.log("No schedule runs yet.");
    return;
  }

  console.log("Schedule runs:\n");
  for (const run of runs.workflow_runs) {
    // Get the job logs to find which expression fired
    let schedule = "unknown";
    try {
      const { data: jobs } = await userOctokit.actions.listJobsForWorkflowRun({
        owner: OWNER, repo: REPO, run_id: run.id,
      });
      if (jobs.jobs.length > 0) {
        const logResp = await userOctokit.request(
          "GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs",
          { owner: OWNER, repo: REPO, job_id: jobs.jobs[0].id }
        );
        const logs = typeof logResp.data === "string" ? logResp.data : "";
        const schedMatch = logs.match(/schedule:\s+(\S+)/);
        if (schedMatch) schedule = schedMatch[1];
      }
    } catch {}
    console.log(`  ${run.id} | actor: ${run.actor.login} (${run.actor.type}) | schedule: ${schedule} | ${run.created_at}`);
  }

  // Analysis
  const actors = new Set(runs.workflow_runs.map(r => r.actor.login));
  console.log(`\nDistinct actors: ${[...actors].join(", ")}`);
  if (actors.size === 1) {
    console.log("All runs have the same actor → actor is likely per-FILE (both expressions share one actor).");
  } else {
    console.log("Different actors for different runs! Need to match against schedule expression to determine if per-expression.");
  }
}

// ============================================================
// Poll helper
// ============================================================
async function poll(workflowFile, label, minRuns = 1) {
  console.log(`=== Polling ${label} ===\n`);
  const userOctokit = getUserOctokit();
  for (let i = 1; i <= 25; i++) {
    const { data: runs } = await userOctokit.actions.listWorkflowRuns({
      owner: OWNER, repo: REPO, workflow_id: workflowFile,
      event: "schedule", per_page: 5,
    });
    if (runs.workflow_runs.length >= minRuns) {
      console.log(`\nFound ${runs.workflow_runs.length} run(s)!\n`);
      for (const run of runs.workflow_runs) {
        console.log(`  ${run.id} | actor: ${run.actor.login} (${run.actor.type}) | ${run.created_at}`);
      }
      return;
    }
    console.log(`  [${i}/25] ${runs.workflow_runs.length} runs (need ${minRuns})...`);
    if (i < 25) await new Promise(r => setTimeout(r, 60000));
  }
  console.log("\nTimed out.");
}

// ============================================================
// Check ALL at once
// ============================================================
async function checkAll() {
  console.log("=== Checking ALL test results ===\n");
  const userOctokit = getUserOctokit();

  const tests = [
    { file: "cron-rebase-merge-test.yml", label: "Rebase Merge" },
    { file: "cron-reactivation-test.yml", label: "Reactivation" },
    { file: "cron-default-branch-test.yml", label: "Default Branch" },
    { file: "cron-per-expression-test.yml", label: "Per-Expression" },
  ];

  for (const test of tests) {
    const { data: runs } = await userOctokit.actions.listWorkflowRuns({
      owner: OWNER, repo: REPO, workflow_id: test.file,
      event: "schedule", per_page: 10,
    });
    console.log(`--- ${test.label} (${test.file}) ---`);
    if (runs.workflow_runs.length === 0) {
      console.log("  No schedule runs yet.\n");
    } else {
      for (const run of runs.workflow_runs) {
        console.log(`  ${run.id} | actor: ${run.actor.login} (${run.actor.type}) | ${run.created_at}`);
      }
      console.log("");
    }
  }

  // Also check if default-branch test affected other workflows
  console.log("--- Cross-check: ownership-test actor (should reveal default-branch hijack) ---");
  const { data: ownershipRuns } = await userOctokit.actions.listWorkflowRuns({
    owner: OWNER, repo: REPO, workflow_id: "cron-ownership-test.yml",
    event: "schedule", per_page: 5,
  });
  for (const run of ownershipRuns.workflow_runs) {
    console.log(`  ${run.id} | actor: ${run.actor.login} (${run.actor.type}) | ${run.created_at}`);
  }
}

// CLI
const action = process.argv[2];
const actions = {
  "rebase-setup": rebaseSetup,
  "rebase-check": rebaseCheck,
  "reactivation-setup": reactivationSetup,
  "reactivation-check": reactivationCheck,
  "default-branch-setup": defaultBranchSetup,
  "default-branch-check": defaultBranchCheck,
  "per-expression-setup": perExpressionSetup,
  "per-expression-check": perExpressionCheck,
  "check-all": checkAll,
  "poll-rebase": () => poll("cron-rebase-merge-test.yml", "Rebase Merge"),
  "poll-reactivation": () => poll("cron-reactivation-test.yml", "Reactivation"),
  "poll-default-branch": () => poll("cron-default-branch-test.yml", "Default Branch"),
  "poll-per-expression": () => poll("cron-per-expression-test.yml", "Per-Expression", 2),
};

if (actions[action]) {
  actions[action]().catch(err => {
    console.error("Error:", err.message);
    if (err.response) console.error(err.response.status, JSON.stringify(err.response.data));
    process.exit(1);
  });
} else {
  console.log("Remaining Tests");
  console.log("================\n");
  console.log("Usage: node remaining-tests.js <command>\n");
  console.log("Setup (run in order, or in parallel):");
  console.log("  rebase-setup           Bot authors cron change, user rebase-merges");
  console.log("  reactivation-setup     Disable → bot changes cron → re-enable");
  console.log("  default-branch-setup   Temporarily switch default branch (bot)");
  console.log("  per-expression-setup   Bot changes one of two cron expressions\n");
  console.log("Check:");
  console.log("  rebase-check           Check rebase merge actor");
  console.log("  reactivation-check     Check reactivation actor");
  console.log("  default-branch-check   Check default branch actors (multiple workflows)");
  console.log("  per-expression-check   Check per-expression actors (needs both to fire)");
  console.log("  check-all              Check all tests at once\n");
  console.log("Poll:");
  console.log("  poll-rebase            Poll until rebase test fires");
  console.log("  poll-reactivation      Poll until reactivation test fires");
  console.log("  poll-default-branch    Poll until default branch test fires");
  console.log("  poll-per-expression    Poll until per-expression test fires (2+ runs)");
}
