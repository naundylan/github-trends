import { promises as fs } from "fs";
import { randomUUID } from "crypto";
import { fetchTrendingRepos } from "./lib/scraper.js";
import { Octokit } from "@octokit/rest";
import { loadHistory, saveHistory, diffAgainstHistory } from "./lib/history.js";
import { categorizeAndSummarize } from "./lib/openrouter.js";
import { sendTrendingMessage } from "./lib/telegram.js";
import { categoryToFilename } from "./lib/categories.js";

const octokit = new Octokit({ auth: process.env.GH_TOKEN });
const [OWNER, REPO] = process.env.GITHUB_REPOSITORY.split("/");

const LANGUAGES = (process.env.TRENDING_LANGUAGES || "").split(",").filter(Boolean);
const TARGET_LANGS = LANGUAGES.length ? LANGUAGES : ["", "javascript", "python", "typescript", "go", "rust"];

// Giới hạn số repo xử lý mỗi lần chạy — tránh spam Telegram và token OpenRouter
const MAX_PER_RUN = 10;
// Delay giữa mỗi tin nhắn Telegram (ms)
const MSG_DELAY_MS = 2000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchTrendingAllLangs() {
  const seen = new Map();
  for (const lang of TARGET_LANGS) {
    try {
      const repos = await fetchTrendingRepos({ language: lang, since: "daily" });
      for (const r of repos) {
        if (!seen.has(r.fullName)) seen.set(r.fullName, r);
      }
    } catch (err) {
      console.warn(`Crawl lang "${lang}" failed: ${err.message}`);
    }
  }
  return [...seen.values()];
}

async function enrichWithTopics(repos) {
  const out = [];
  for (const repo of repos) {
    try {
      const { data } = await octokit.repos.getAllTopics({ owner: repo.owner, repo: repo.name });
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
  console.log(`${toProcess.length} repos eligible (new or resurfaced). Processing max ${MAX_PER_RUN} this run.`);

  const limited = toProcess
  .sort((a, b) => b.starsToday - a.starsToday)
  .slice(0, MAX_PER_RUN);

  if (limited.length === 0) {
    await saveHistory(updatedHistory);
    console.log("Nothing new. Done.");
    return;
  }

  const enriched = await enrichWithTopics(limited);

  // Gọi OpenRouter theo batch 5 repo/lần (prompt giờ dài hơn)
  const BATCH_SIZE = 5;
  const results = [];
  for (let i = 0; i < enriched.length; i += BATCH_SIZE) {
    const batch = enriched.slice(i, i + BATCH_SIZE);
    console.log(`Calling OpenRouter for batch ${Math.floor(i / BATCH_SIZE) + 1}...`);
    const res = await categorizeAndSummarize(batch);
    results.push(...res);
  }

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
      summary: item.summary,
      usecases: item.usecases,
      ideas: item.ideas,
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
      summary: item.summary,
      usecases: item.usecases,
      ideas: item.ideas,
      pendingId,
    });

    console.log(`✓ Sent: ${repo.fullName} [${item.category}]`);
    await sleep(MSG_DELAY_MS);
  }

  await saveHistory(updatedHistory);
  console.log(`Done. Sent ${results.length} messages.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
