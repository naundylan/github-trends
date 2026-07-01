import { promises as fs } from "fs";
import { randomUUID } from "crypto";
import { fetchRepositories } from "@huchenme/github-trending";
import { Octokit } from "@octokit/rest";
import { loadHistory, saveHistory, diffAgainstHistory } from "./lib/history.js";
import { categorizeAndSummarize } from "./lib/openrouter.js";
import { sendTrendingMessage } from "./lib/telegram.js";
import { categoryToFilename } from "./lib/categories.js";

const octokit = new Octokit({ auth: process.env.GH_TOKEN });
const [OWNER, REPO] = process.env.GITHUB_REPOSITORY.split("/");

const LANGUAGES = (process.env.TRENDING_LANGUAGES || "").split(",").filter(Boolean);
// Để trống TRENDING_LANGUAGES -> crawl "All languages" + một vài ngôn ngữ phổ biến.
const TARGET_LANGS = LANGUAGES.length ? LANGUAGES : ["", "javascript", "python", "typescript", "go", "rust"];

async function fetchTrendingAllLangs() {
  const seen = new Map();
  for (const lang of TARGET_LANGS) {
    const repos = await fetchRepositories({ language: lang, since: "daily" });
    for (const r of repos) {
      const fullName = `${r.author}/${r.name}`;
      if (!seen.has(fullName)) {
        seen.set(fullName, {
          fullName,
          owner: r.author,
          name: r.name,
          description: r.description,
          language: r.language,
          stars: r.stars,
          starsToday: r.currentPeriodStars,
          url: r.url || `https://github.com/${fullName}`,
        });
      }
    }
  }
  return [...seen.values()];
}

async function enrichWithTopics(repos) {
  const out = [];
  for (const repo of repos) {
    try {
      const { data } = await octokit.repos.getAllTopics({
        owner: repo.owner,
        repo: repo.name,
      });
      out.push({ ...repo, topics: data.names || [] });
    } catch {
      out.push({ ...repo, topics: [] });
    }
  }
  return out;
}

async function putFileOnGithub(path, content, message) {
  let sha;
  try {
    const { data } = await octokit.repos.getContent({ owner: OWNER, repo: REPO, path });
    sha = data.sha;
  } catch (err) {
    if (err.status !== 404) throw err;
  }
  await octokit.repos.createOrUpdateFileContents({
    owner: OWNER,
    repo: REPO,
    path,
    message,
    content: Buffer.from(content, "utf-8").toString("base64"),
    sha,
  });
}

async function main() {
  const todayISO = new Date().toISOString().slice(0, 10);

  console.log("Crawling GitHub Trending...");
  const trending = await fetchTrendingAllLangs();
  console.log(`Found ${trending.length} unique repos across languages.`);

  const history = await loadHistory();
  const { toProcess, history: updatedHistory } = diffAgainstHistory(history, trending, todayISO);
  console.log(`${toProcess.length} repos to process (new or resurfaced).`);

  if (toProcess.length === 0) {
    await saveHistory(updatedHistory);
    console.log("Nothing new. Done.");
    return;
  }

  const enriched = await enrichWithTopics(toProcess);

  // Gọi OpenRouter theo batch (vd 10 repo/lần) để tránh prompt quá dài.
  const BATCH_SIZE = 10;
  const results = [];
  for (let i = 0; i < enriched.length; i += BATCH_SIZE) {
    const batch = enriched.slice(i, i + BATCH_SIZE);
    const res = await categorizeAndSummarize(batch);
    results.push(...res);
  }

  // Map kết quả phân loại lại với data gốc của repo
  const byName = new Map(enriched.map((r) => [r.fullName, r]));

  for (const item of results) {
    const repo = byName.get(item.repo);
    if (!repo) continue;

    const pendingId = randomUUID();
    const pendingPath = `state/pending/${pendingId}.json`;
    const notePath = `notes/${categoryToFilename(item.category)}`;

    const pendingPayload = {
      id: pendingId,
      repo: repo.fullName,
      url: repo.url,
      category: item.category,
      summary_vi: item.summary_vi,
      stars: repo.stars,
      starsToday: repo.starsToday,
      language: repo.language,
      notePath,
      createdAt: new Date().toISOString(),
    };

    await putFileOnGithub(
      pendingPath,
      JSON.stringify(pendingPayload, null, 2),
      `chore: queue pending note for ${repo.fullName}`
    );

    await sendTrendingMessage({
      repo,
      category: item.category,
      summary: item.summary_vi,
      pendingId,
    });

    console.log(`Queued + sent Telegram message for ${repo.fullName}`);
  }

  await saveHistory(updatedHistory);
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
