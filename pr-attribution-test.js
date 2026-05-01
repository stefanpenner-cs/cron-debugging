const { Octokit } = require("@octokit/rest");
const { createAppAuth } = require("@octokit/auth-app");
const { execSync } = require("child_process");
const fs = require("fs");

const CREDS_PATH = "./app-credentials.json";
const OWNER = "stefanpenner-cs";
const REPO = "cron-debugging";
const WORKFLOW_FILE = ".github/workflows/cron-basic.yml";

const SCENARIOS = {
  "bot-opens-user-merges": {
    description: "Bot opens PR, user merges → who is cron actor?",
    opener: "bot",
    merger: "user",
  },
  "bot-opens-bot-merges": {
    description: "Bot opens AND merges PR → who is cron actor?",
    opener: "bot",
    merger: "bot",
  },
  "user-opens-bot-merges": {
    description: "User opens PR, bot merges → who is cron actor?",
    opener: "user",
    merger: "bot",
  },
};

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

async function createBranchWithWorkflowEdit(octokit, branchName, label) {
  // Get current main SHA
  const { data: ref } = await octokit.git.getRef({
    owner: OWNER, repo: REPO, ref: "heads/main",
  });
  const mainSha = ref.object.sha;

  // Create branch
  await octokit.git.createRef({
    owner: OWNER, repo: REPO,
    ref: `refs/heads/${branchName}`,
    sha: mainSha,
  });

  // Read current workflow file from main
  const { data: file } = await octokit.repos.getContent({
    owner: OWNER, repo: REPO, path: WORKFLOW_FILE, ref: branchName,
  });

  const content = Buffer.from(file.content, "base64").toString("utf-8");
  const marker = "# pr-attribution-test:";
  const newLine = `${marker} ${label} at ${new Date().toISOString()}`;
  let newContent;
  if (content.includes(marker)) {
    newContent = content.replace(new RegExp(`${marker}.*`), newLine);
  } else {
    newContent = content + `\n${newLine}\n`;
  }

  // Commit the change
  const { data: commit } = await octokit.repos.createOrUpdateFileContents({
    owner: OWNER, repo: REPO, path: WORKFLOW_FILE,
    message: `test: ${label}`,
    content: Buffer.from(newContent).toString("base64"),
    sha: file.sha,
    branch: branchName,
  });

  return { mainSha, commitSha: commit.commit.sha, committer: commit.commit.author.name };
}

async function createPR(octokit, branchName, title, body) {
  const { data: pr } = await octokit.pulls.create({
    owner: OWNER, repo: REPO,
    title, body,
    head: branchName,
    base: "main",
  });
  return pr;
}

async function mergePR(octokit, prNumber, mergeMethod) {
  const { data: merge } = await octokit.pulls.merge({
    owner: OWNER, repo: REPO,
    pull_number: prNumber,
    merge_method: mergeMethod,
  });
  return merge;
}

async function deleteBranch(octokit, branchName) {
  try {
    await octokit.git.deleteRef({
      owner: OWNER, repo: REPO, ref: `heads/${branchName}`,
    });
  } catch {}
}

async function runScenario(scenarioKey, mergeMethod = "squash") {
  const scenario = SCENARIOS[scenarioKey];
  if (!scenario) {
    console.error(`Unknown scenario: ${scenarioKey}`);
    console.error(`Available: ${Object.keys(SCENARIOS).join(", ")}`);
    process.exit(1);
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`Scenario: ${scenario.description}`);
  console.log(`Merge method: ${mergeMethod}`);
  console.log(`${"=".repeat(60)}\n`);

  const { creds, octokit: botOctokit } = await getAppOctokit();
  const userOctokit = getUserOctokit();

  const opener = scenario.opener === "bot" ? botOctokit : userOctokit;
  const merger = scenario.merger === "bot" ? botOctokit : userOctokit;
  const openerLabel = scenario.opener === "bot" ? creds.app_slug + "[bot]" : "stefanpenner";
  const mergerLabel = scenario.merger === "bot" ? creds.app_slug + "[bot]" : "stefanpenner";

  const branchName = `test/${scenarioKey}-${Date.now()}`;
  const label = `${scenarioKey} (${mergeMethod})`;

  // Step 1: Create branch + commit (as opener)
  console.log(`1. Creating branch ${branchName} with workflow edit (as ${openerLabel})...`);
  const { committer } = await createBranchWithWorkflowEdit(opener, branchName, label);
  console.log(`   Commit author: ${committer}`);

  // Step 2: Open PR (as opener)
  console.log(`2. Opening PR (as ${openerLabel})...`);
  const pr = await createPR(opener, branchName,
    `test: ${scenarioKey} (${mergeMethod})`,
    `PR attribution test.\n\nOpener: ${openerLabel}\nMerger: ${mergerLabel}\nMerge method: ${mergeMethod}`
  );
  console.log(`   PR #${pr.number}: ${pr.html_url}`);

  // Step 3: Merge PR (as merger)
  console.log(`3. Merging PR #${pr.number} (as ${mergerLabel}, method: ${mergeMethod})...`);
  const merge = await mergePR(merger, pr.number, mergeMethod);
  console.log(`   Merged! SHA: ${merge.sha}`);

  // Step 4: Clean up branch
  console.log(`4. Deleting branch ${branchName}...`);
  await deleteBranch(botOctokit, branchName);

  // Step 5: Check the merge commit
  console.log(`5. Checking merge commit attribution...`);
  const { data: commitData } = await userOctokit.git.getCommit({
    owner: OWNER, repo: REPO, commit_sha: merge.sha,
  });
  console.log(`   commit.author: ${commitData.author.name} <${commitData.author.email}>`);
  console.log(`   commit.committer: ${commitData.committer.name} <${commitData.committer.email}>`);

  // Step 6: Record what to check
  console.log(`\n--- Result ---`);
  console.log(`PR opened by:     ${openerLabel}`);
  console.log(`PR merged by:     ${mergerLabel}`);
  console.log(`Merge method:     ${mergeMethod}`);
  console.log(`Merge commit author:    ${commitData.author.name}`);
  console.log(`Merge commit committer: ${commitData.committer.name}`);
  console.log(`\nWait for next cron fire of cron-basic.yml, then check:`);
  console.log(`  gh api repos/${OWNER}/${REPO}/actions/runs?event=schedule\\&per_page=5`);
  console.log(`  → actor.login should reveal who GH considers the "owner"\n`);

  // Sync local
  try { execSync("git pull --rebase", { stdio: "inherit" }); } catch {}

  return {
    scenario: scenarioKey,
    mergeMethod,
    prNumber: pr.number,
    prUrl: pr.html_url,
    mergeSha: merge.sha,
    commitAuthor: commitData.author.name,
    commitCommitter: commitData.committer.name,
    opener: openerLabel,
    merger: mergerLabel,
  };
}

async function runAll() {
  const results = [];

  for (const key of Object.keys(SCENARIOS)) {
    for (const method of ["squash", "merge"]) {
      const result = await runScenario(key, method);
      results.push(result);

      // Brief pause between scenarios to avoid rate limits
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log("ALL SCENARIOS COMPLETE");
  console.log("=".repeat(60));
  console.log("\nResults summary:\n");
  console.log("| Opener | Merger | Method | Commit Author | Commit Committer |");
  console.log("|--------|--------|--------|---------------|------------------|");
  for (const r of results) {
    console.log(`| ${r.opener} | ${r.merger} | ${r.mergeMethod} | ${r.commitAuthor} | ${r.commitCommitter} |`);
  }

  fs.writeFileSync("pr-attribution-results.json", JSON.stringify(results, null, 2));
  console.log("\nFull results saved to pr-attribution-results.json");
  console.log("\nNow wait for cron-basic.yml schedule runs and check actor after each merge.");
}

// CLI
const args = process.argv.slice(2);
if (args[0] === "all") {
  runAll().catch(err => { console.error("Error:", err.message); process.exit(1); });
} else if (args[0] && SCENARIOS[args[0]]) {
  const method = args[1] || "squash";
  runScenario(args[0], method).catch(err => { console.error("Error:", err.message); process.exit(1); });
} else {
  console.log("Usage:");
  console.log("  node pr-attribution-test.js all                    # run all 6 permutations");
  console.log("  node pr-attribution-test.js <scenario> [method]    # run one");
  console.log("");
  console.log("Scenarios:");
  for (const [key, val] of Object.entries(SCENARIOS)) {
    console.log(`  ${key.padEnd(25)} ${val.description}`);
  }
  console.log("");
  console.log("Merge methods: squash (default), merge");
}
