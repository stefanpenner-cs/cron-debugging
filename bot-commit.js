const { Octokit } = require("@octokit/rest");
const { createAppAuth } = require("@octokit/auth-app");
const fs = require("fs");

const CREDS_PATH = "./app-credentials.json";
const OWNER = "stefanpenner-cs";
const REPO = "cron-debugging";
const WORKFLOW_FILE = ".github/workflows/cron-basic.yml";

async function main() {
  if (!fs.existsSync(CREDS_PATH)) {
    console.error(`No credentials found at ${CREDS_PATH}. Run: node create-app.js`);
    process.exit(1);
  }

  const creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf-8"));
  console.log(`Using app: ${creds.app_name} (ID: ${creds.app_id})`);

  const appOctokit = new Octokit({
    authStrategy: createAppAuth,
    auth: { appId: creds.app_id, privateKey: creds.pem },
  });

  // Find the installation for our repo
  console.log("Finding installation...");
  const { data: installations } = await appOctokit.request("GET /app/installations");

  const installation = installations.find((inst) => {
    return inst.account?.login === OWNER;
  });

  if (!installation) {
    console.error(`App is not installed on ${OWNER}. Install it first:`);
    console.error(`https://github.com/organizations/${OWNER}/settings/installations`);
    process.exit(1);
  }

  console.log(`Found installation: ${installation.id} on ${installation.account.login}`);

  // Get an installation token
  const installOctokit = new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: creds.app_id,
      privateKey: creds.pem,
      installationId: installation.id,
    },
  });

  // Read the current workflow file content
  console.log(`Reading ${WORKFLOW_FILE}...`);
  const { data: fileData } = await installOctokit.repos.getContent({
    owner: OWNER,
    repo: REPO,
    path: WORKFLOW_FILE,
  });

  const currentContent = Buffer.from(fileData.content, "base64").toString("utf-8");

  // Make a small modification: update or add a comment with timestamp
  const marker = "# bot-probe-timestamp:";
  const newTimestamp = `${marker} ${new Date().toISOString()}`;
  let newContent;

  if (currentContent.includes(marker)) {
    newContent = currentContent.replace(/# bot-probe-timestamp:.*/, newTimestamp);
  } else {
    newContent = currentContent + `\n${newTimestamp}\n`;
  }

  // Commit as the app bot
  console.log("Committing as app bot...");
  const { data: commit } = await installOctokit.repos.createOrUpdateFileContents({
    owner: OWNER,
    repo: REPO,
    path: WORKFLOW_FILE,
    message: `chore: bot probe timestamp [${creds.app_slug}]`,
    content: Buffer.from(newContent).toString("base64"),
    sha: fileData.sha,
    branch: "main",
  });

  console.log("\nCommit created!");
  console.log(`  sha: ${commit.commit.sha}`);
  console.log(`  author: ${commit.commit.author.name} <${commit.commit.author.email}>`);
  console.log(`  committer: ${commit.commit.committer.name} <${commit.commit.committer.email}>`);
  console.log(`  url: ${commit.commit.html_url}`);

  console.log("\nNow wait for the next cron fire and check:");
  console.log("  - github.actor — should be the app bot account");
  console.log("  - github.triggering_actor — should also be the app bot");
  console.log(`  - git log on ${WORKFLOW_FILE} — last committer should be the bot`);
  console.log("\nOr trigger manually:");
  console.log(`  gh workflow run cron-basic.yml --repo ${OWNER}/${REPO}`);

  // Also probe who the actor would be via the API
  console.log("\nProbing current workflow runs for actor info...");
  const { data: runs } = await installOctokit.actions.listWorkflowRuns({
    owner: OWNER,
    repo: REPO,
    workflow_id: "cron-basic.yml",
    per_page: 1,
  });

  if (runs.workflow_runs.length > 0) {
    const lastRun = runs.workflow_runs[0];
    console.log(`  Last run actor: ${lastRun.actor.login} (before bot commit)`);
    console.log(`  Last run event: ${lastRun.event}`);
  }

  // Pull to sync local repo
  console.log("\nPulling to sync local repo...");
  const { execSync } = require("child_process");
  try {
    execSync("git pull --rebase", { stdio: "inherit" });
  } catch {
    console.log("  (pull failed — may need manual sync)");
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  if (err.response) {
    console.error("Status:", err.response.status);
    console.error("Data:", JSON.stringify(err.response.data, null, 2));
  }
  process.exit(1);
});
