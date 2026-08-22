/**
 * Scrape github.com/trending trực tiếp bằng Cheerio.
 */

import * as cheerio from "cheerio";

const BASE =
  "https://github.com";

const REQUEST_TIMEOUT_MS =
  30_000;

export async function fetchTrendingRepos({
  language = "",
  since = "daily",
} = {}) {
  const url = language
    ? `${BASE}/trending/${encodeURIComponent(
        language
      )}?since=${since}`
    : `${BASE}/trending?since=${since}`;

  const controller =
    new AbortController();

  const timer =
    setTimeout(
      () =>
        controller.abort(),
      REQUEST_TIMEOUT_MS
    );

  try {
    const res =
      await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; github-trends-bot/1.0)",
          Accept:
            "text/html,application/xhtml+xml",
        },

        signal:
          controller.signal,
      });

    if (!res.ok) {
      throw new Error(
        `GitHub Trending ${res.status}: ${url}`
      );
    }

    const html =
      await res.text();

    const $ =
      cheerio.load(html);

    const repos = [];

    $("article.Box-row").each(
      (_, element) => {
        const $el =
          $(element);

        const href =
          $el
            .find("h2 a")
            .attr("href") ||
          "";

        const fullName =
          href
            .replace(
              /^\/+/,
              ""
            )
            .trim();

        if (
          !fullName ||
          !fullName.includes("/")
        ) {
          return;
        }

        const [
          owner,
          name,
        ] =
          fullName.split(
            "/"
          );

        if (
          !owner ||
          !name
        ) {
          return;
        }

        const description =
          $el
            .find("p")
            .first()
            .text()
            .trim() ||
          "";

        const language =
          $el
            .find(
              '[itemprop="programmingLanguage"]'
            )
            .text()
            .trim() ||
          "";

        const starsText =
          $el
            .find(
              'a[href$="/stargazers"]'
            )
            .first()
            .text()
            .trim()
            .replace(
              /,/g,
              ""
            );

        const stars =
          Number.parseInt(
            starsText,
            10
          ) || 0;

        const text =
          $el.text();

        const todayMatch =
          text.match(
            /([\d,]+)\s+stars?\s+today/i
          );

        const starsToday =
          Number.parseInt(
            todayMatch?.[1]?.replace(
              /,/g,
              ""
            ) || "0",
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

          url:
            `${BASE}/${fullName}`,
        });
      }
    );

    return repos;
  } finally {
    clearTimeout(
      timer
    );
  }
}
