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
    owner: OWNER, repo: REPO, path, message,
    content: Buffer.from(content, "utf-8").toString("base64"),
    sha,
  });
}

async function commitBatch(files) {
  // files: [{ path, content }]
  // Dùng Git Tree API để commit tất cả trong 1 lần
  const { data: refData } = await octokit.git.getRef({
    owner: OWNER, repo: REPO, ref: "heads/main",
  });
  const latestSha = refData.object.sha;

  const { data: commitData } = await octokit.git.getCommit({
    owner: OWNER, repo: REPO, commit_sha: latestSha,
  });
  const treeSha = commitData.tree.sha;

  // Tạo blobs cho từng file
  const treeItems = await Promise.all(files.map(async ({ path, content }) => {
    const { data: blob } = await octokit.git.createBlob({
      owner: OWNER, repo: REPO,
      content: Buffer.from(content, "utf-8").toString("base64"),
      encoding: "base64",
    });
    return { path, mode: "100644", type: "blob", sha: blob.sha };
  }));

  // Tạo tree mới
  const { data: newTree } = await octokit.git.createTree({
    owner: OWNER, repo: REPO,
    base_tree: treeSha,
    tree: treeItems,
  });

  // Tạo commit
  const { data: newCommit } = await octokit.git.createCommit({
    owner: OWNER, repo: REPO,
    message: `chore: queue ${files.length} pending notes`,
    tree: newTree.sha,
    parents: [latestSha],
  });

  // Update ref
  await octokit.git.updateRef({
    owner: OWNER, repo: REPO,
    ref: "heads/main",
    sha: newCommit.sha,
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
  const BATCH_SIZE = 3;
  const results = [];
  for (let i = 0; i < enriched.length; i += BATCH_SIZE) {
    const batch = enriched.slice(i, i + BATCH_SIZE);
    console.log(`Calling OpenRouter for batch ${Math.floor(i / BATCH_SIZE) + 1}...`);
    const res = await categorizeAndSummarize(batch);
    results.push(...res);
  }

  const byName = new Map(enriched.map((r) => [r.fullName, r]));

  for (const item of results) {
    const byName = new Map(enriched.map((r) => [r.fullName, r]));
    const pendingFiles = [];
    const toSend = [];

    for (const item of results) {
      const repo = byName.get(item.repo);
      if (!repo) continue;

      const pendingId = randomUUID();
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

      pendingFiles.push({
        path: `state/pending/${pendingId}.json`,
        content: JSON.stringify(pendingPayload, null, 2),
      });
      toSend.push({ repo, item, pendingId });
    }

    // 1 commit duy nhất cho toàn bộ pending files
    if (pendingFiles.length > 0) {
      console.log(`Committing ${pendingFiles.length} pending files in 1 commit...`);
      await commitBatch(pendingFiles);
    }

    // Gửi Telegram từng cái, delay giữa các message
    for (const { repo, item, pendingId } of toSend) {
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
    console.log(`Done. Sent ${toSend.length} messages.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
