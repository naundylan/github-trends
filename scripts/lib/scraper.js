/**
 * Tự scrape github.com/trending bằng cheerio — không phụ thuộc API bên thứ 3.
 */
import * as cheerio from "cheerio";

const BASE = "https://github.com";

export async function fetchTrendingRepos({ language = "", since = "daily" } = {}) {
  const url = language
    ? `${BASE}/trending/${encodeURIComponent(language)}?since=${since}`
    : `${BASE}/trending?since=${since}`;

  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; github-trends-bot/1.0; +https://github.com)",
      Accept: "text/html,application/xhtml+xml",
    },
  });

  if (!res.ok) throw new Error(`GitHub trending fetch failed: ${res.status} ${url}`);

  const html = await res.text();
  const $ = cheerio.load(html);
  const repos = [];

  $("article.Box-row").each((_, el) => {
    const $el = $(el);

    const fullNameRaw = $el.find("h2 a").attr("href") || "";
    const fullName = fullNameRaw.replace(/^\//, "");
    if (!fullName) return;

    const [owner, name] = fullName.split("/");
    const description = $el.find("p").first().text().trim() || "";
    const language = $el.find('[itemprop="programmingLanguage"]').text().trim() || "";

    const starsText = $el
      .find('a[href$="/stargazers"]')
      .first()
      .text()
      .trim()
      .replace(/,/g, "");
    const stars = parseInt(starsText, 10) || 0;

    const starsToday =
      parseInt(
        $el
          .text()
          .match(/([0-9,]+)\s+stars?\s+today/i)?.[1]
          ?.replace(/,/g, "") || "0",
        10
      ) || 0;

    repos.push({
      fullName,
      owner,
      name,
      description,
      language,
      stars,
      starsToday,
      url: `${BASE}/${fullName}`,
    });
  });

  return repos;
}