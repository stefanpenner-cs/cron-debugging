const { Octokit } = require("@octokit/rest");
const { createAppAuth } = require("@octokit/auth-app");
const { execSync } = require("child_process");
const fs = require("fs");

const CREDS_PATH = "./app-credentials.json";
const OWNER = "stefanpenner-cs";
const REPO = "cron-debugging";
const WORKFLOW_FILE = ".github/workflows/cron-actor-disambiguate.yml";

function getAppOctokit() {
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

async function testA() {
  console.log("=== Test A: Bot AUTHORS cron change, User MERGES ===\n");
  console.log("Question: Is the actor the author (bot) or the merger (user)?\n");

  const { creds, octokit: botOctokit } = getAppOctokit();
  const userOctokit = getUserOctokit();

  const branchName = `test/bot-authors-cron-${Date.now()}`;

  // 1. Create branch from main
  console.log("1. Creating branch from main...");
  const { data: ref } = await botOctokit.git.getRef({
    owner: OWNER, repo: REPO, ref: "heads/main",
  });
  await botOctokit.git.createRef({
    owner: OWNER, repo: REPO,
    ref: `refs/heads/${branchName}`,
    sha: ref.object.sha,
  });

  // 2. Bot changes the cron expression on the branch
  console.log("2. Bot changing cron expression on branch...");
  const { data: file } = await botOctokit.repos.getContent({
    owner: OWNER, repo: REPO, path: WORKFLOW_FILE, ref: branchName,
  });

  const content = Buffer.from(file.content, "base64").toString("utf-8");
  const currentCron = content.match(/cron: "([^"]+)"/)[1];
  const newCron = currentCron === "*/5 * * * *" ? "*/6 * * * *" : "*/5 * * * *";
  const newContent = content.replace(`cron: "${currentCron}"`, `cron: "${newCron}"`);

  const { data: commit } = await botOctokit.repos.createOrUpdateFileContents({
    owner: OWNER, repo: REPO, path: WORKFLOW_FILE,
    message: `test: bot changes cron ${currentCron} → ${newCron}`,
    content: Buffer.from(newContent).toString("base64"),
    sha: file.sha,
    branch: branchName,
  });
  console.log(`   Commit author: ${commit.commit.author.name}`);
  console.log(`   Cron change: ${currentCron} → ${newCron}`);

  // 3. Bot opens PR
  console.log("3. Bot opening PR...");
  const { data: pr } = await botOctokit.pulls.create({
    owner: OWNER, repo: REPO,
    title: `test A: bot authors cron change (${currentCron} → ${newCron})`,
    body: `Bot authored the cron syntax change.\nUser will merge.\nWho becomes the actor?`,
    head: branchName,
    base: "main",
  });
  console.log(`   PR #${pr.number}: ${pr.html_url}`);

  // 4. User merges PR (squash)
  console.log("4. User (stefanpenner) merging PR via squash...");
  const { data: merge } = await userOctokit.pulls.merge({
    owner: OWNER, repo: REPO,
    pull_number: pr.number,
    merge_method: "squash",
  });
  console.log(`   Merged! SHA: ${merge.sha}`);

  // 5. Check merge commit attribution
  const { data: mergeCommit } = await userOctokit.git.getCommit({
    owner: OWNER, repo: REPO, commit_sha: merge.sha,
  });
  console.log(`   Merge commit author:    ${mergeCommit.author.name}`);
  console.log(`   Merge commit committer: ${mergeCommit.committer.name}`);

  // 6. Check push event
  console.log("5. Checking push event actor...");
  await new Promise(r => setTimeout(r, 2000));
  const { data: events } = await userOctokit.request("GET /repos/{owner}/{repo}/events", {
    owner: OWNER, repo: REPO, per_page: 5,
  });
  const pushEvent = events.find(e => e.type === "PushEvent" && e.payload.head?.startsWith(merge.sha.slice(0, 7)));
  if (pushEvent) {
    console.log(`   Push event actor: ${pushEvent.actor.login}`);
  } else {
    console.log(`   Push event not found yet (may take a moment to appear)`);
  }

  // Cleanup branch
  await botOctokit.git.deleteRef({ owner: OWNER, repo: REPO, ref: `heads/${branchName}` }).catch(() => {});

  console.log(`\n--- Summary ---`);
  console.log(`Cron syntax changed: ${currentCron} → ${newCron}`);
  console.log(`Change AUTHORED by:  ${creds.app_slug}[bot]`);
  console.log(`Change MERGED by:    stefanpenner (squash merge)`);
  console.log(`\nWait for next cron fire of "Cron: Actor Disambiguation", then run:`);
  console.log(`  node actor-disambiguate-test.js check`);

  try { execSync("git pull --rebase", { stdio: "inherit" }); } catch {}
}

async function testB() {
  console.log("=== Test B: User AUTHORS cron change, Bot MERGES ===\n");
  console.log("Question: Is the actor the author (user) or the merger (bot)?\n");

  const { creds, octokit: botOctokit } = getAppOctokit();
  const userOctokit = getUserOctokit();

  const branchName = `test/user-authors-cron-${Date.now()}`;

  // 1. Create branch from main (as bot, doesn't matter who creates the branch)
  console.log("1. Creating branch from main...");
  const { data: ref } = await botOctokit.git.getRef({
    owner: OWNER, repo: REPO, ref: "heads/main",
  });
  await botOctokit.git.createRef({
    owner: OWNER, repo: REPO,
    ref: `refs/heads/${branchName}`,
    sha: ref.object.sha,
  });

  // 2. User changes the cron expression on the branch
  // The user's token may lack `workflow` scope for the REST API on workflow files.
  // Fall back to bot creating the commit but we note this limitation.
  console.log("2. User changing cron expression on branch...");
  const { data: file } = await userOctokit.repos.getContent({
    owner: OWNER, repo: REPO, path: WORKFLOW_FILE, ref: branchName,
  });

  const content = Buffer.from(file.content, "base64").toString("utf-8");
  const currentCron = content.match(/cron: "([^"]+)"/)[1];
  const newCron = currentCron === "*/5 * * * *" ? "*/7 * * * *" : "*/5 * * * *";
  const newContent = content.replace(`cron: "${currentCron}"`, `cron: "${newCron}"`);

  let commitAuthor;
  try {
    const { data: commit } = await userOctokit.repos.createOrUpdateFileContents({
      owner: OWNER, repo: REPO, path: WORKFLOW_FILE,
      message: `test: user changes cron ${currentCron} → ${newCron}`,
      content: Buffer.from(newContent).toString("base64"),
      sha: file.sha,
      branch: branchName,
    });
    commitAuthor = commit.commit.author.name;
    console.log(`   Commit author: ${commitAuthor}`);
  } catch (err) {
    if (err.status === 403 || err.status === 404 || err.status === 422) {
      console.log(`   User API lacks workflow scope, using git push instead...`);
      execSync(`git fetch origin`, { stdio: "inherit" });
      execSync(`git checkout ${branchName}`, { stdio: "inherit" });
      fs.writeFileSync(WORKFLOW_FILE.replace('.github/', '.github/'), newContent);
      execSync(`git add "${WORKFLOW_FILE}"`, { stdio: "inherit" });
      execSync(`git commit -m "test: user changes cron ${currentCron} → ${newCron}"`, { stdio: "inherit" });
      execSync(`git push origin ${branchName}`, { stdio: "inherit" });
      execSync(`git checkout main`, { stdio: "inherit" });
      commitAuthor = "Stefan Penner";
      console.log(`   Commit author: ${commitAuthor} (via git push)`);
    } else {
      throw err;
    }
  }
  console.log(`   Cron change: ${currentCron} → ${newCron}`);

  // 3. User opens PR
  console.log("3. User opening PR...");
  const { data: pr } = await userOctokit.pulls.create({
    owner: OWNER, repo: REPO,
    title: `test B: user authors cron change (${currentCron} → ${newCron})`,
    body: `User authored the cron syntax change.\nBot will merge.\nWho becomes the actor?`,
    head: branchName,
    base: "main",
  });
  console.log(`   PR #${pr.number}: ${pr.html_url}`);

  // 4. Bot merges PR (squash)
  console.log("4. Bot merging PR via squash...");
  const { data: merge } = await botOctokit.pulls.merge({
    owner: OWNER, repo: REPO,
    pull_number: pr.number,
    merge_method: "squash",
  });
  console.log(`   Merged! SHA: ${merge.sha}`);

  // 5. Check merge commit attribution
  const { data: mergeCommit } = await userOctokit.git.getCommit({
    owner: OWNER, repo: REPO, commit_sha: merge.sha,
  });
  console.log(`   Merge commit author:    ${mergeCommit.author.name}`);
  console.log(`   Merge commit committer: ${mergeCommit.committer.name}`);

  // 6. Check push event
  console.log("5. Checking push event actor...");
  await new Promise(r => setTimeout(r, 2000));
  const { data: events } = await userOctokit.request("GET /repos/{owner}/{repo}/events", {
    owner: OWNER, repo: REPO, per_page: 5,
  });
  const pushEvent = events.find(e => e.type === "PushEvent" && e.payload.head?.startsWith(merge.sha.slice(0, 7)));
  if (pushEvent) {
    console.log(`   Push event actor: ${pushEvent.actor.login}`);
  } else {
    console.log(`   Push event not found yet`);
  }

  // Cleanup branch
  await botOctokit.git.deleteRef({ owner: OWNER, repo: REPO, ref: `heads/${branchName}` }).catch(() => {});

  console.log(`\n--- Summary ---`);
  console.log(`Cron syntax changed: ${currentCron} → ${newCron}`);
  console.log(`Change AUTHORED by:  stefanpenner`);
  console.log(`Change MERGED by:    ${creds.app_slug}[bot] (squash merge)`);
  console.log(`\nWait for next cron fire, then run:`);
  console.log(`  node actor-disambiguate-test.js check`);

  try { execSync("git pull --rebase", { stdio: "inherit" }); } catch {}
}

async function check() {
  console.log("=== Actor Disambiguation: Check Runs ===\n");

  const userOctokit = getUserOctokit();

  const { data: runs } = await userOctokit.actions.listWorkflowRuns({
    owner: OWNER, repo: REPO,
    workflow_id: "cron-actor-disambiguate.yml",
    event: "schedule",
    per_page: 20,
  });

  if (runs.workflow_runs.length === 0) {
    console.log("No schedule runs yet. Wait for cron to fire.");
    return;
  }

  console.log("Schedule runs for Cron: Actor Disambiguation:\n");
  console.log("| Run ID | Actor | Actor Type | SHA (7) | Created |");
  console.log("|--------|-------|------------|---------|---------|");

  for (const run of runs.workflow_runs) {
    console.log(`| ${run.id} | ${run.actor.login} | ${run.actor.type} | ${run.head_sha.slice(0, 7)} | ${run.created_at} |`);
  }

  // Show git log for the workflow file
  console.log("\nCommit history for this workflow file:");
  const { data: commits } = await userOctokit.repos.listCommits({
    owner: OWNER, repo: REPO,
    path: WORKFLOW_FILE,
    per_page: 10,
  });

  for (const c of commits) {
    console.log(`  ${c.sha.slice(0, 7)} | author: ${c.commit.author.name} | committer: ${c.commit.committer.name} | ${c.commit.message.split("\n")[0]}`);
  }

  // Show push events
  console.log("\nRecent push events:");
  const { data: events } = await userOctokit.request("GET /repos/{owner}/{repo}/events", {
    owner: OWNER, repo: REPO, per_page: 10,
  });
  for (const e of events.filter(e => e.type === "PushEvent").slice(0, 5)) {
    console.log(`  ${e.actor.login} pushed ${e.payload.head?.slice(0, 7)} to ${e.payload.ref} at ${e.created_at}`);
  }

  console.log("\n--- Analysis ---");
  const actors = new Set(runs.workflow_runs.map(r => r.actor.login));
  if (actors.size === 1) {
    console.log(`All runs have same actor: ${[...actors][0]}`);
  } else {
    console.log(`Actor CHANGED across runs: ${[...actors].join(" → ")}`);
    console.log("Compare run SHAs against commit history above to determine what caused the change.");
  }
}

const action = process.argv[2];
if (action === "testA") {
  testA().catch(err => { console.error("Error:", err.message); if (err.response) console.error(err.response.status, err.response.data); process.exit(1); });
} else if (action === "testB") {
  testB().catch(err => { console.error("Error:", err.message); if (err.response) console.error(err.response.status, err.response.data); process.exit(1); });
} else if (action === "check") {
  check().catch(err => { console.error("Error:", err.message); process.exit(1); });
} else {
  console.log("Usage:");
  console.log("  node actor-disambiguate-test.js testA   # bot AUTHORS cron change, user MERGES");
  console.log("  node actor-disambiguate-test.js testB   # user AUTHORS cron change, bot MERGES");
  console.log("  node actor-disambiguate-test.js check   # check schedule run actors");
  console.log("");
  console.log("Run testA first, wait for cron fire, check.");
  console.log("Then run testB, wait for cron fire, check.");
  console.log("");
  console.log("This disambiguates:");
  console.log("  - Is the actor the person who AUTHORED the cron syntax change?");
  console.log("  - Or the person who MERGED/PUSHED the commit to default branch?");
}
