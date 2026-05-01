const { Octokit } = require("@octokit/rest");
const { createAppAuth } = require("@octokit/auth-app");
const { execSync } = require("child_process");
const fs = require("fs");

const CREDS_PATH = "./app-credentials.json";
const OWNER = "stefanpenner-cs";
const REPO = "cron-debugging";
const WORKFLOW_FILE = ".github/workflows/cron-multi-schedule.yml";

async function getAppOctokit() {
  const creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf-8"));
  return {
    creds,
    octokit: new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: creds.app_id,
        privateKey: creds.pem,
        installationId: 128750615,
      },
    }),
  };
}

function getUserOctokit() {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN ||
    execSync("gh auth token", { encoding: "utf-8" }).trim();
  return new Octokit({ auth: token });
}

async function main() {
  const action = process.argv[2];

  if (action === "setup") {
    await setup();
  } else if (action === "check") {
    await check();
  } else {
    console.log("Usage:");
    console.log("  node multi-cron-attribution-test.js setup   # bot edits multi-schedule workflow");
    console.log("  node multi-cron-attribution-test.js check   # check actor on recent schedule runs");
    console.log("");
    console.log("Test: multi-schedule.yml has two cron expressions (*/10 and */15).");
    console.log("Both are in the same file. If the bot edits the file, do both");
    console.log("cron expressions get the bot as actor? Or does each expression");
    console.log("track its actor independently?");
    console.log("");
    console.log("Hypothesis: actor is per-file, not per-expression. All crons in");
    console.log("the file share the same actor.");
  }

  return;
}

async function setup() {
  console.log("=== Multi-Cron Attribution Test: Setup ===\n");

  const { creds, octokit: botOctokit } = await getAppOctokit();

  // First, check who current runs attribute to
  console.log("1. Checking current attribution on multi-schedule runs...");
  const userOctokit = getUserOctokit();
  const { data: currentRuns } = await userOctokit.actions.listWorkflowRuns({
    owner: OWNER, repo: REPO,
    workflow_id: "cron-multi-schedule.yml",
    event: "schedule",
    per_page: 5,
  });

  if (currentRuns.workflow_runs.length > 0) {
    console.log("   Current schedule runs:");
    for (const run of currentRuns.workflow_runs) {
      console.log(`     run ${run.id} | actor: ${run.actor.login} | created: ${run.created_at}`);
    }
  } else {
    console.log("   No schedule runs yet.");
  }

  // Bot edits the multi-schedule workflow file
  console.log("\n2. Bot editing multi-schedule workflow file...");
  const { data: file } = await botOctokit.repos.getContent({
    owner: OWNER, repo: REPO, path: WORKFLOW_FILE,
  });

  const content = Buffer.from(file.content, "base64").toString("utf-8");
  const marker = "# multi-cron-test:";
  const newLine = `${marker} bot-edit at ${new Date().toISOString()}`;
  let newContent;
  if (content.includes(marker)) {
    newContent = content.replace(new RegExp(`${marker}.*`), newLine);
  } else {
    newContent = content + `\n${newLine}\n`;
  }

  const { data: commit } = await botOctokit.repos.createOrUpdateFileContents({
    owner: OWNER, repo: REPO, path: WORKFLOW_FILE,
    message: `test: bot edits multi-schedule workflow for attribution test`,
    content: Buffer.from(newContent).toString("base64"),
    sha: file.sha,
    branch: "main",
  });

  console.log(`   Committed: ${commit.commit.sha}`);
  console.log(`   Author: ${commit.commit.author.name}`);
  console.log(`   Committer: ${commit.commit.committer.name}`);

  console.log("\n3. Now wait for both cron expressions to fire:");
  console.log("   - */10 (every 10 min)");
  console.log("   - */15 (every 15 min)");
  console.log("   Then run: node multi-cron-attribution-test.js check");
  console.log("");
  console.log("   Key question: will BOTH show the same actor, or can they differ?");

  try { execSync("git pull --rebase", { stdio: "inherit" }); } catch {}
}

async function check() {
  console.log("=== Multi-Cron Attribution Test: Check ===\n");

  const userOctokit = getUserOctokit();

  const { data: runs } = await userOctokit.actions.listWorkflowRuns({
    owner: OWNER, repo: REPO,
    workflow_id: "cron-multi-schedule.yml",
    event: "schedule",
    per_page: 20,
  });

  if (runs.workflow_runs.length === 0) {
    console.log("No schedule runs yet for multi-schedule.yml. Wait for crons to fire.");
    return;
  }

  console.log("Schedule runs for cron-multi-schedule.yml:\n");
  console.log("| Run ID | Actor | Actor Type | Created | SHA (first 7) |");
  console.log("|--------|-------|------------|---------|---------------|");

  const seenActors = new Set();
  for (const run of runs.workflow_runs) {
    console.log(`| ${run.id} | ${run.actor.login} | ${run.actor.type} | ${run.created_at} | ${run.head_sha.slice(0, 7)} |`);
    seenActors.add(run.actor.login);
  }

  console.log("");

  // Check the workflow file's git log to see who last committed
  console.log("Git log for the workflow file (via API):");
  const { data: commits } = await userOctokit.repos.listCommits({
    owner: OWNER, repo: REPO,
    path: WORKFLOW_FILE,
    per_page: 5,
  });

  for (const c of commits) {
    console.log(`  ${c.sha.slice(0, 7)} | author: ${c.commit.author.name} | committer: ${c.commit.committer.name} | ${c.commit.message.split("\n")[0]}`);
  }

  console.log("\n--- Analysis ---");
  if (seenActors.size === 1) {
    console.log(`All runs have the same actor: ${[...seenActors][0]}`);
    console.log("Consistent with: actor is per-workflow-file, not per-cron-expression.");
  } else {
    console.log(`Multiple actors found: ${[...seenActors].join(", ")}`);
    console.log("This would mean actor can differ between cron expressions in the same file!");
  }

  // Check if any runs happened after the bot commit
  const botCommit = commits.find(c => c.commit.author.name.includes("[bot]"));
  if (botCommit) {
    const botTime = new Date(botCommit.commit.author.date);
    const runsAfterBot = runs.workflow_runs.filter(r => new Date(r.created_at) > botTime);
    console.log(`\nRuns after bot commit (${botCommit.sha.slice(0, 7)}):`);
    if (runsAfterBot.length > 0) {
      for (const r of runsAfterBot) {
        console.log(`  ${r.id} | actor: ${r.actor.login} (${r.actor.type})`);
      }
    } else {
      console.log("  None yet — wait for the next fire.");
    }
  }
}

main().catch(err => {
  console.error("Error:", err.message);
  if (err.response) console.error("Status:", err.response.status, JSON.stringify(err.response.data));
  process.exit(1);
});
