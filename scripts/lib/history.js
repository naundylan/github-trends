import { promises as fs } from "fs";

const HISTORY_PATH = "state/trending-history.json";
const RESURFACE_DAYS = 21; // 3 tuần

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
  await fs.mkdir("state", { recursive: true });
  await fs.writeFile(HISTORY_PATH, JSON.stringify(history, null, 2) + "\n", "utf-8");
}

/**
 * Trả về danh sách repo cần xử lý (mới hoặc mới nổi lại sau >= 21 ngày),
 * đồng thời update lastSeen cho toàn bộ repo crawl được hôm nay.
 */
export function diffAgainstHistory(history, trendingRepos, todayISO) {
  const toProcess = [];
  const today = new Date(todayISO);

  for (const repo of trendingRepos) {
    const key = repo.fullName; // "owner/name"
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
