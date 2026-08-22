import { promises as fs } from "fs";
import { randomUUID } from "crypto";
import { fetchTrendingRepos } from "./lib/scraper.js";
import { Octokit } from "@octokit/rest";
import {
  loadHistory,
  diffAgainstHistory,
} from "./lib/history.js";
import {
  categorizeAndSummarize,
} from "./lib/openrouter.js";
import {
  sendTrendingMessage,
} from "./lib/telegram.js";
import {
  categoryToFilename,
} from "./lib/categories.js";

const octokit = new Octokit({
  auth: process.env.GH_TOKEN,
});

const repository =
  process.env.GITHUB_REPOSITORY || "";

const [OWNER, REPO] = repository.split("/");

const LANGUAGES = (
  process.env.TRENDING_LANGUAGES || ""
)
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);

const TARGET_LANGS = LANGUAGES.length
  ? LANGUAGES
  : [
      "",
      "javascript",
      "python",
      "typescript",
      "go",
      "rust",
    ];

const MAX_PER_RUN = 10;

/*
 * 2 repo/batch ổn định hơn 3.
 *
 * Chậm hơn một chút nhưng:
 * - JSON ngắn hơn
 * - ít bị truncate
 * - ít repo bị mất
 */
const BATCH_SIZE = 2;

const MSG_DELAY_MS = 2000;
const HISTORY_PATH =
  "state/trending-history.json";

const sleep = (ms) =>
  new Promise((resolve) =>
    setTimeout(resolve, ms)
  );

async function fetchTrendingAllLangs() {
  const seen = new Map();

  for (const lang of TARGET_LANGS) {
    try {
      console.log(
        `Fetching trending: ${lang || "all"}`
      );

      const repos =
        await fetchTrendingRepos({
          language: lang,
          since: "daily",
        });

      for (const repo of repos) {
        if (!seen.has(repo.fullName)) {
          seen.set(
            repo.fullName,
            repo
          );
        }
      }
    } catch (err) {
      console.warn(
        `⚠ Crawl lang "${lang}" failed: ${err.message}`
      );
    }
  }

  return [...seen.values()];
}

async function enrichWithTopics(repos) {
  const output = [];

  for (const repo of repos) {
    try {
      const { data } =
        await octokit.repos.getAllTopics({
          owner: repo.owner,
          repo: repo.name,
        });

      output.push({
        ...repo,
        topics: data.names || [],
      });
    } catch (err) {
      console.warn(
        `⚠ Cannot fetch topics for ${repo.fullName}: ${err.message}`
      );

      output.push({
        ...repo,
        topics: [],
      });
    }
  }

  return output;
}

async function createCommit(files) {
  const { data: refData } =
    await octokit.git.getRef({
      owner: OWNER,
      repo: REPO,
      ref: "heads/main",
    });

  const latestSha =
    refData.object.sha;

  const { data: commitData } =
    await octokit.git.getCommit({
      owner: OWNER,
      repo: REPO,
      commit_sha: latestSha,
    });

  const treeSha =
    commitData.tree.sha;

  const treeItems =
    await Promise.all(
      files.map(
        async ({
          path,
          content,
        }) => {
          const { data: blob } =
            await octokit.git.createBlob({
              owner: OWNER,
              repo: REPO,

              content: Buffer.from(
                content,
                "utf8"
              ).toString("base64"),

              encoding: "base64",
            });

          return {
            path,
            mode: "100644",
            type: "blob",
            sha: blob.sha,
          };
        }
      )
    );

  const { data: newTree } =
    await octokit.git.createTree({
      owner: OWNER,
      repo: REPO,

      base_tree: treeSha,
      tree: treeItems,
    });

  const pendingCount =
    Math.max(0, files.length - 1);

  const { data: newCommit } =
    await octokit.git.createCommit({
      owner: OWNER,
      repo: REPO,

      message:
        `chore: queue ${pendingCount} pending notes + update history`,

      tree: newTree.sha,
      parents: [latestSha],
    });

  return {
    latestSha,
    newCommitSha:
      newCommit.sha,
  };
}

async function commitBatch(files) {
  const MAX_COMMIT_ATTEMPTS = 4;

  for (
    let attempt = 1;
    attempt <=
    MAX_COMMIT_ATTEMPTS;
    attempt++
  ) {
    try {
      console.log(
        `Git commit attempt ${attempt}/${MAX_COMMIT_ATTEMPTS}...`
      );

      const {
        newCommitSha,
      } = await createCommit(files);

      /*
       * force: false
       *
       * Không overwrite commit workflow khác.
       * Nếu branch vừa thay đổi → request fail
       * → loop retry dựa trên HEAD mới.
       */
      await octokit.git.updateRef({
        owner: OWNER,
        repo: REPO,

        ref: "heads/main",
        sha: newCommitSha,

        force: false,
      });

      console.log(
        `✓ Commit successful: ${newCommitSha.slice(0, 7)}`
      );

      return;
    } catch (err) {
      console.warn(
        `⚠ Commit attempt ${attempt} failed: ${err.message}`
      );

      if (
        attempt ===
        MAX_COMMIT_ATTEMPTS
      ) {
        throw err;
      }

      await sleep(
        attempt * 2000
      );
    }
  }
}

async function analyzeRepos(repos) {
  const results = [];

  const totalBatches =
    Math.ceil(
      repos.length /
        BATCH_SIZE
    );

  for (
    let i = 0;
    i < repos.length;
    i += BATCH_SIZE
  ) {
    const batch =
      repos.slice(
        i,
        i + BATCH_SIZE
      );

    const batchNumber =
      Math.floor(
        i / BATCH_SIZE
      ) + 1;

    console.log("");
    console.log(
      `========== AI batch ${batchNumber}/${totalBatches} ==========`
    );

    console.log(
      batch
        .map(
          (r) =>
            `- ${r.fullName}`
        )
        .join("\n")
    );

    const startedAt =
      Date.now();

    try {
      const batchResults =
        await categorizeAndSummarize(
          batch
        );

      results.push(
        ...batchResults
      );

      console.log(
        `✓ Batch ${batchNumber} done in ${(
          (Date.now() -
            startedAt) /
          1000
        ).toFixed(1)}s`
      );
    } catch (err) {
      /*
       * Bình thường openrouter.js đã tự fallback
       * nên gần như không vào đây.
       *
       * Nhưng vẫn có guard cuối cùng.
       */
      console.error(
        `⚠ Unexpected AI batch failure: ${err.message}`
      );

      for (const repo of batch) {
        results.push({
          repo:
            repo.fullName,
          category:
            "Other",

          summary:
            repo.description ||
            `${repo.fullName} đang trending trên GitHub.`,

          usecases: [],
          ideas: [],
        });
      }
    }
  }

  return results;
}

async function main() {
  if (!OWNER || !REPO) {
    throw new Error(
      "GITHUB_REPOSITORY không hợp lệ."
    );
  }

  const todayISO =
    new Date()
      .toISOString()
      .slice(0, 10);

  console.log(
    "================================"
  );

  console.log(
    "GitHub Trending Crawl"
  );

  console.log(
    "================================"
  );

  console.log(
    `Repository: ${OWNER}/${REPO}`
  );

  console.log(
    `Languages: ${TARGET_LANGS.join(", ")}`
  );

  console.log(
    `Max repos: ${MAX_PER_RUN}`
  );

  console.log(
    `Batch size: ${BATCH_SIZE}`
  );

  console.log("");

  /*
   * 1. CRAWL
   */
  console.log(
    "Crawling GitHub Trending..."
  );

  const trending =
    await fetchTrendingAllLangs();

  console.log(
    `Found ${trending.length} unique repos across languages.`
  );

  /*
   * 2. HISTORY
   */
  const history =
    await loadHistory();

  const {
    toProcess,
    history:
      updatedHistory,
  } = diffAgainstHistory(
    history,
    trending,
    todayISO
  );

  console.log(
    `${toProcess.length} repos eligible. Processing max ${MAX_PER_RUN} this run.`
  );

  /*
   * Ưu tiên repo tăng sao mạnh nhất.
   */
  const limited =
    [...toProcess]
      .sort(
        (a, b) =>
          (b.starsToday || 0) -
          (a.starsToday || 0)
      )
      .slice(
        0,
        MAX_PER_RUN
      );

  if (
    limited.length === 0
  ) {
    console.log(
      "Nothing new. Done."
    );

    return;
  }

  /*
   * Những repo chưa được xử lý vì MAX_PER_RUN
   * phải xóa khỏi updated history.
   *
   * Nếu không lần sau chúng bị coi là đã xử lý.
   */
  const limitedNames =
    new Set(
      limited.map(
        (repo) =>
          repo.fullName
      )
    );

  for (
    const key of
    Object.keys(
      updatedHistory
    )
  ) {
    const entry =
      updatedHistory[key];

    const wasAddedToday =
      entry?.first_seen ===
        todayISO &&
      entry?.last_seen ===
        todayISO;

    if (
      wasAddedToday &&
      !limitedNames.has(
        key
      )
    ) {
      delete updatedHistory[
        key
      ];
    }
  }

  /*
   * 3. GITHUB TOPICS
   */
  console.log(
    "Fetching repository topics..."
  );

  const enriched =
    await enrichWithTopics(
      limited
    );

  /*
   * 4. AI
   */
  const results =
    await analyzeRepos(
      enriched
    );

  console.log("");
  console.log(
    `AI returned ${results.length}/${enriched.length} results.`
  );

  /*
   * 5. BUILD PENDING FILES
   */
  const byName =
    new Map(
      enriched.map(
        (repo) => [
          repo.fullName,
          repo,
        ]
      )
    );

  const pendingFiles = [];
  const toSend = [];

  for (
    const item of results
  ) {
    if (!item?.repo)
      continue;

    const repo =
      byName.get(
        item.repo
      );

    if (!repo) {
      console.warn(
        `⚠ Unknown AI repo: ${item.repo}`
      );

      continue;
    }

    const pendingId =
      randomUUID();

    const notePath =
      `notes/${categoryToFilename(
        item.category
      )}`;

    const pendingPayload =
      {
        id: pendingId,

        repo:
          repo.fullName,

        url: repo.url,

        category:
          item.category,

        summary:
          item.summary,

        usecases:
          item.usecases,

        ideas:
          item.ideas,

        stars:
          repo.stars,

        starsToday:
          repo.starsToday,

        language:
          repo.language,

        topics:
          repo.topics || [],

        notePath,

        createdAt:
          new Date()
            .toISOString(),
      };

    pendingFiles.push({
      path:
        `state/pending/${pendingId}.json`,

      content:
        JSON.stringify(
          pendingPayload,
          null,
          2
        ) + "\n",
    });

    toSend.push({
      repo,
      item,
      pendingId,
    });
  }

  /*
   * History cùng commit với pending.
   */
  pendingFiles.push({
    path:
      HISTORY_PATH,

    content:
      JSON.stringify(
        updatedHistory,
        null,
        2
      ) + "\n",
  });

  /*
   * 6. COMMIT
   */
  console.log("");
  console.log(
    `Committing ${toSend.length} pending files + history...`
  );

  await commitBatch(
    pendingFiles
  );

  /*
   * 7. TELEGRAM
   *
   * Một message fail không làm chết toàn job.
   */
  let sent = 0;
  let failed = 0;

  for (
    const {
      repo,
      item,
      pendingId,
    } of toSend
  ) {
    try {
      await sendTrendingMessage({
        repo,

        category:
          item.category,

        summary:
          item.summary,

        usecases:
          item.usecases,

        ideas:
          item.ideas,

        pendingId,
      });

      sent++;

      console.log(
        `✓ Telegram: ${repo.fullName} [${item.category}]`
      );
    } catch (err) {
      failed++;

      console.warn(
        `⚠ Telegram failed for ${repo.fullName}: ${err.message}`
      );
    }

    await sleep(
      MSG_DELAY_MS
    );
  }

  console.log("");
  console.log(
    "================================"
  );

  console.log(
    `Done.`
  );

  console.log(
    `Pending: ${toSend.length}`
  );

  console.log(
    `Telegram sent: ${sent}`
  );

  console.log(
    `Telegram failed: ${failed}`
  );

  console.log(
    "================================"
  );
}

main().catch((err) => {
  /*
   * Chỉ những lỗi thực sự nghiêm trọng mới tới đây:
   * - GitHub credential sai
   * - commit hoàn toàn không được
   * - GITHUB_REPOSITORY sai
   * ...
   *
   * JSON AI lỗi sẽ KHÔNG còn làm workflow chết.
   */
  console.error(
    "FATAL:",
    err
  );

  process.exit(1);
});
