import { promises as fs } from "fs";
import { Octokit } from "@octokit/rest";

const HISTORY_PATH = "state/trending-history.json";
const RESURFACE_DAYS = 21;

function getOctokit() {
  return new Octokit({ auth: process.env.GH_TOKEN });
}

function getOwnerRepo() {
  const [OWNER, REPO] = process.env.GITHUB_REPOSITORY.split("/");
  return { OWNER, REPO };
}

export async function loadHistory() {
  try {
    const raw = await fs.readFile(HISTORY_PATH, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw err;
  }
}

export async function saveHistory(history) {
  const octokit = getOctokit();
  const { OWNER, REPO } = getOwnerRepo();
  const content = JSON.stringify(history, null, 2) + "\n";

  // Lấy SHA hiện tại của file (cần để update)
  let sha;
  try {
    const { data } = await octokit.repos.getContent({
      owner: OWNER, repo: REPO, path: HISTORY_PATH,
    });
    sha = data.sha;
  } catch (err) {
    if (err.status !== 404) throw err;
  }

  await octokit.repos.createOrUpdateFileContents({
    owner: OWNER,
    repo: REPO,
    path: HISTORY_PATH,
    message: `chore: update trending history (${new Date().toISOString().slice(0, 10)})`,
    content: Buffer.from(content, "utf-8").toString("base64"),
    sha,
  });

  // Vẫn ghi local để các bước sau trong cùng run có thể đọc
  await fs.mkdir("state", { recursive: true });
  await fs.writeFile(HISTORY_PATH, content, "utf-8");
}

export function diffAgainstHistory(history, trendingRepos, todayISO) {
  const toProcess = [];
  const today = new Date(todayISO);

  for (const repo of trendingRepos) {
    const key = repo.fullName;
    const entry = history[key];

    if (!entry) {
      toProcess.push({ ...repo, reason: "new" });
      history[key] = {
        first_seen: todayISO,
        last_seen: todayISO,
        last_saved: todayISO,
      };
      continue;
    }

    const lastSaved = new Date(entry.last_saved || entry.first_seen);
    const daysSinceSaved = (today - lastSaved) / (1000 * 60 * 60 * 24);

    if (daysSinceSaved >= RESURFACE_DAYS) {
      toProcess.push({ ...repo, reason: "resurfaced" });
      entry.last_saved = todayISO;
    }

    entry.last_seen = todayISO;
  }

  return { toProcess, history };
}