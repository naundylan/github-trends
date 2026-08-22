import { CATEGORIES } from "./categories.js";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

const PRIMARY_MODEL =
  process.env.OPENROUTER_MODEL?.trim() ||
  "nvidia/nemotron-3.5-lightning:free";

// Nếu model chính chết / endpoint biến mất thì OpenRouter tự chọn free model khác.
const MODELS = [...new Set([
  PRIMARY_MODEL,
  "openrouter/free",
])];

const REQUEST_TIMEOUT_MS = 120_000;
const MAX_RETRIES_PER_MODEL = 2;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeItem(item, repo) {
  const category = CATEGORIES.includes(item?.category)
    ? item.category
    : "Other";

  return {
    repo: repo.fullName,
    category,

    summary:
      typeof item?.summary === "string" && item.summary.trim()
        ? item.summary.trim()
        : repo.description ||
          `Repository ${repo.fullName} đang trending trên GitHub.`,

    usecases: Array.isArray(item?.usecases)
      ? item.usecases
          .filter((x) => typeof x === "string")
          .map((x) => x.trim())
          .filter(Boolean)
          .slice(0, 4)
      : [],

    ideas: Array.isArray(item?.ideas)
      ? item.ideas
          .filter((x) => typeof x === "string")
          .map((x) => x.trim())
          .filter(Boolean)
          .slice(0, 5)
      : [],
  };
}

function fallbackItem(repo) {
  return {
    repo: repo.fullName,
    category: "Other",

    summary:
      repo.description ||
      `${repo.fullName} là một repository đang trending trên GitHub.`,

    usecases: [
      `Khám phá và đánh giá ${repo.fullName} cho các dự án phần mềm phù hợp.`,
      "Tham khảo cách dự án được tổ chức và triển khai.",
    ],

    ideas: [
      "Kết hợp dự án này với các công cụ AI hoặc automation để xây dựng workflow mới.",
      "Phân tích source code để tìm các thành phần có thể tái sử dụng trong dự án khác.",
    ],
  };
}

/**
 * Tìm một JSON object/array hoàn chỉnh trong text.
 *
 * Không dùng regex vì JSON có thể chứa:
 * - object nested
 * - array nested
 * - dấu } trong string
 * - escape quote
 */
function extractBalancedJson(text) {
  if (!text) return null;

  let cleaned = String(text)
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  // Thử parse nguyên response trước.
  try {
    return JSON.parse(cleaned);
  } catch {
    // tiếp tục
  }

  const starts = [];

  for (let i = 0; i < cleaned.length; i++) {
    if (cleaned[i] === "{" || cleaned[i] === "[") {
      starts.push(i);
    }
  }

  for (const start of starts) {
    const opening = cleaned[start];
    const closing = opening === "{" ? "}" : "]";

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < cleaned.length; i++) {
      const char = cleaned[i];

      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }

        if (char === "\\") {
          escaped = true;
          continue;
        }

        if (char === '"') {
          inString = false;
        }

        continue;
      }

      if (char === '"') {
        inString = true;
        continue;
      }

      if (char === opening) {
        depth++;
      } else if (char === closing) {
        depth--;

        if (depth === 0) {
          const candidate = cleaned.slice(start, i + 1);

          try {
            return JSON.parse(candidate);
          } catch {
            break;
          }
        }
      }
    }
  }

  return null;
}

function parseModelResponse(content, repos) {
  const parsed = extractBalancedJson(content);

  if (!parsed) {
    throw new Error("Model trả về JSON không hợp lệ hoặc bị cắt.");
  }

  let items;

  if (Array.isArray(parsed)) {
    items = parsed;
  } else if (Array.isArray(parsed.repos)) {
    items = parsed.repos;
  } else if (Array.isArray(parsed.results)) {
    items = parsed.results;
  } else {
    throw new Error('JSON không chứa mảng "repos".');
  }

  const byRepo = new Map();

  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    if (!item.repo) continue;

    byRepo.set(
      String(item.repo).trim().toLowerCase(),
      item
    );
  }

  // Luôn trả đủ số repo trong batch.
  // Model thiếu repo nào thì fallback repo đó.
  return repos.map((repo) => {
    const aiItem = byRepo.get(repo.fullName.toLowerCase());

    if (!aiItem) {
      console.warn(
        `⚠ Model không trả kết quả cho ${repo.fullName}. Dùng fallback.`
      );

      return fallbackItem(repo);
    }

    return normalizeItem(aiItem, repo);
  });
}

function makePrompt(repos) {
  const repoText = repos
    .map((r, i) => {
      return `${i + 1}. ${r.fullName}
Mô tả: ${r.description || "(không có)"}
Ngôn ngữ: ${r.language || "(không rõ)"}
Topics: ${(r.topics || []).join(", ") || "(không có)"}
Stars hôm nay: ${r.starsToday}
Tổng stars: ${r.stars}`;
    })
    .join("\n\n");

  const categoriesText = CATEGORIES.join(", ");

  const systemPrompt = `
Bạn là kỹ sư phần mềm chuyên phân tích GitHub repository.

Nhiệm vụ:
Phân tích chính xác từng repository được cung cấp.

Category bắt buộc phải là đúng một giá trị trong danh sách:
${categoriesText}

Với mỗi repo:

- repo: chính xác owner/name được cung cấp
- category: đúng 1 category trong danh sách
- summary: 1-2 câu tiếng Việt ngắn gọn, mô tả dự án làm gì và điểm nổi bật
- usecases: 2-3 use case thực tế
- ideas: 2-3 ý tưởng ứng dụng hoặc kết hợp sáng tạo

QUAN TRỌNG:
- Không bỏ sót repository.
- Không thêm repository không tồn tại trong input.
- Không Markdown.
- Không code fence.
- Không giải thích.
- Chỉ trả JSON hợp lệ.
- Không được dừng giữa JSON.

Cấu trúc BẮT BUỘC:

{
  "repos": [
    {
      "repo": "owner/name",
      "category": "category",
      "summary": "text",
      "usecases": [
        "text",
        "text"
      ],
      "ideas": [
        "text",
        "text"
      ]
    }
  ]
}
`.trim();

  const userPrompt = `
Phân tích ${repos.length} repository sau.

Bạn PHẢI trả đúng ${repos.length} phần tử trong mảng "repos".

${repoText}
`.trim();

  return {
    systemPrompt,
    userPrompt,
  };
}

async function requestOpenRouter({
  model,
  repos,
  structuredOutput = true,
}) {
  const { systemPrompt, userPrompt } = makePrompt(repos);

  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, REQUEST_TIMEOUT_MS);

  try {
    const payload = {
      model,

      messages: [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content: userPrompt,
        },
      ],

      // Task JSON nên để thấp.
      temperature: 0.15,

      // Batch chỉ 2-3 repo, không cần 8000.
      max_tokens: 4500,
    };

    // Một số model/provider support JSON mode.
    // Nếu provider không support thì phía dưới sẽ retry không có response_format.
    if (structuredOutput) {
      payload.response_format = {
        type: "json_object",
      };
    }

    console.log(
      `  → Model: ${model} | repos: ${repos.length} | JSON mode: ${structuredOutput}`
    );

    const res = await fetch(OPENROUTER_URL, {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      },

      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const raw = await res.text();

    if (!res.ok) {
      const error = new Error(
        `OpenRouter ${res.status}: ${raw.slice(0, 500)}`
      );

      error.status = res.status;
      throw error;
    }

    let data;

    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error(
        `OpenRouter trả response API không phải JSON: ${raw.slice(0, 300)}`
      );
    }

    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error(
        `OpenRouter không trả content. finish_reason=${
          data.choices?.[0]?.finish_reason || "unknown"
        }`
      );
    }

    const finishReason = data.choices?.[0]?.finish_reason;

    if (finishReason === "length") {
      console.warn(
        "⚠ Model đạt giới hạn output token. Sẽ thử parse hoặc retry."
      );
    }

    return {
      content,
      finishReason,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function analyzeBatchWithModel(model, repos) {
  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES_PER_MODEL; attempt++) {
    // Lần đầu thử JSON mode.
    // Lần sau không ép JSON mode nếu provider không support.
    const structuredOutput = attempt === 1;

    try {
      console.log(
        `  Attempt ${attempt}/${MAX_RETRIES_PER_MODEL}`
      );

      const { content } = await requestOpenRouter({
        model,
        repos,
        structuredOutput,
      });

      return parseModelResponse(content, repos);
    } catch (err) {
      lastError = err;

      console.warn(
        `  ⚠ ${model} attempt ${attempt} failed: ${err.message}`
      );

      if (attempt < MAX_RETRIES_PER_MODEL) {
        await sleep(1500 * attempt);
      }
    }
  }

  throw lastError;
}

async function analyzeBatch(repos) {
  let lastError;

  for (const model of MODELS) {
    try {
      return await analyzeBatchWithModel(model, repos);
    } catch (err) {
      lastError = err;

      console.warn(
        `⚠ Model ${model} failed completely: ${err.message}`
      );
    }
  }

  throw lastError;
}

export async function categorizeAndSummarize(repos) {
  if (!Array.isArray(repos) || repos.length === 0) {
    return [];
  }

  if (!process.env.OPENROUTER_API_KEY) {
    console.warn(
      "⚠ OPENROUTER_API_KEY không tồn tại. Dùng fallback local."
    );

    return repos.map(fallbackItem);
  }

  console.log(
    `OpenRouter primary model: ${PRIMARY_MODEL}`
  );

  try {
    return await analyzeBatch(repos);
  } catch (batchError) {
    console.warn(
      `⚠ Batch ${repos.length} repos failed: ${batchError.message}`
    );
  }

  /*
   * Nếu batch nhiều repo thất bại,
   * retry từng repo riêng lẻ.
   *
   * Đây là lớp bảo vệ quan trọng:
   *
   * 3 repos
   *   ↓ JSON lỗi
   * retry từng repo
   *   ├ repo A ✓
   *   ├ repo B ✓
   *   └ repo C lỗi → fallback
   *
   * Không làm chết toàn workflow.
   */
  if (repos.length > 1) {
    console.log(
      `↳ Retrying ${repos.length} repos individually...`
    );

    const results = [];

    for (const repo of repos) {
      try {
        const result = await analyzeBatch([repo]);

        results.push(
          result[0] || fallbackItem(repo)
        );
      } catch (err) {
        console.warn(
          `⚠ AI failed for ${repo.fullName}: ${err.message}`
        );

        results.push(fallbackItem(repo));
      }
    }

    return results;
  }

  console.warn(
    `⚠ AI unavailable for ${repos[0].fullName}. Using local fallback.`
  );

  return [fallbackItem(repos[0])];
}
