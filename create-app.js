const http = require("http");
const { execSync } = require("child_process");
const fs = require("fs");

const ORG = "stefanpenner-cs";
const PORT = 3847;
const CALLBACK_URL = `http://localhost:${PORT}/callback`;
const CREDS_PATH = "./app-credentials.json";

const manifest = {
  name: "cron-actor-probe",
  url: "https://github.com/stefanpenner-cs/cron-debugging",
  hook_attributes: { url: "https://example.com/hook", active: false },
  redirect_url: CALLBACK_URL,
  public: false,
  default_permissions: {
    contents: "write",
    metadata: "read",
  },
  default_events: [],
};

const formHtml = `<!DOCTYPE html>
<html>
<body>
  <h2>Create GitHub App: cron-actor-probe</h2>
  <p>This will create a GitHub App on the <strong>${ORG}</strong> org with <code>contents:write</code> permission.</p>
  <p>Click the button, then approve on GitHub.</p>
  <form action="https://github.com/organizations/${ORG}/settings/apps/new?state=probe" method="post">
    <input type="hidden" name="manifest" value='${JSON.stringify(manifest)}'>
    <button type="submit" style="font-size:1.5em;padding:10px 30px;cursor:pointer;">
      Create App on GitHub
    </button>
  </form>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(formHtml);
    return;
  }

  if (url.pathname === "/callback") {
    const code = url.searchParams.get("code");
    if (!code) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Missing code parameter");
      return;
    }

    console.log("Got code, exchanging for app credentials...");

    try {
      const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || execSync("gh auth token", { encoding: "utf-8" }).trim();
      const response = await fetch(
        `https://api.github.com/app-manifests/${code}/conversions`,
        {
          method: "POST",
          headers: {
            Authorization: `token ${token}`,
            Accept: "application/vnd.github+json",
          },
        }
      );

      if (!response.ok) {
        const err = await response.text();
        console.error("GitHub API error:", response.status, err);
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end(`GitHub API error: ${response.status}\n${err}`);
        return;
      }

      const appData = await response.json();

      const creds = {
        app_id: appData.id,
        app_slug: appData.slug,
        app_name: appData.name,
        client_id: appData.client_id,
        pem: appData.pem,
        webhook_secret: appData.webhook_secret,
        created_at: new Date().toISOString(),
      };

      fs.writeFileSync(CREDS_PATH, JSON.stringify(creds, null, 2));
      console.log(`App created! ID: ${creds.app_id}, slug: ${creds.app_slug}`);
      console.log(`Credentials saved to ${CREDS_PATH}`);

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<h2>App created!</h2>
        <pre>ID: ${creds.app_id}\nSlug: ${creds.app_slug}\nName: ${creds.app_name}</pre>
        <p>Credentials saved to <code>${CREDS_PATH}</code></p>
        <p><strong>Next step:</strong> Install the app on the repo:</p>
        <p><a href="https://github.com/organizations/${ORG}/settings/installations" target="_blank">
          Go to org installation settings
        </a></p>
        <p>Then run: <code>node bot-commit.js</code></p>
        <p>You can close this page.</p>`);
    } catch (err) {
      console.error("Error:", err);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(`Error: ${err.message}`);
    }

    setTimeout(() => {
      console.log("Shutting down server.");
      server.close();
      process.exit(0);
    }, 1000);
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

if (fs.existsSync(CREDS_PATH)) {
  const existing = JSON.parse(fs.readFileSync(CREDS_PATH, "utf-8"));
  console.log(`App already exists: ID=${existing.app_id}, slug=${existing.app_slug}`);
  console.log(`Delete ${CREDS_PATH} to create a new one.`);
  process.exit(0);
}

server.listen(PORT, () => {
  console.log(`Open http://localhost:${PORT} in your browser to create the app.`);
  try {
    execSync(`open http://localhost:${PORT}`);
  } catch {}
});
