import { CATEGORIES } from "./categories.js";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODEL = process.env.OPENROUTER_MODEL || "poolside/laguna-xs.2:free";

/**
 * Gửi 1 batch repo cho OpenRouter, nhận về category + tóm tắt tiếng Việt cho từng repo.
 * repos: [{ fullName, description, language, stars, starsToday, url, topics }]
 */
export async function categorizeAndSummarize(repos) {
  const listText = repos
    .map((r, i) => {
      return `${i + 1}. ${r.fullName}
- Mô tả: ${r.description || "(không có)"}
- Ngôn ngữ chính: ${r.language || "(không rõ)"}
- Topics: ${(r.topics || []).join(", ") || "(không có)"}
- Sao hôm nay: ${r.starsToday}, tổng sao: ${r.stars}`;
    })
    .join("\n\n");

  const systemPrompt = `Bạn là trợ lý phân loại và tóm tắt repo GitHub trending bằng tiếng Việt.
Với mỗi repo, hãy:
1. Chọn ĐÚNG 1 category trong danh sách sau (không được tạo category khác, không được sửa tên):
${CATEGORIES.map((c) => `- ${c}`).join("\n")}
2. Viết tóm tắt 1-2 câu tiếng Việt, ngắn gọn, nêu repo này làm gì và điểm đáng chú ý.

CHỈ trả về JSON thuần (không markdown, không giải thích thêm), dạng mảng:
[
  { "repo": "owner/name", "category": "tên category đúng như trong danh sách", "summary_vi": "..." }
]`;

  const userPrompt = `Danh sách repo cần xử lý:\n\n${listText}`;

  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.3,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenRouter error ${res.status}: ${text}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || "[]";
  const cleaned = content.replace(/```json|```/g, "").trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`Không parse được JSON từ OpenRouter: ${cleaned}`);
  }

  // Fallback an toàn: nếu category không nằm trong danh sách -> "Other"
  return parsed.map((item) => ({
    ...item,
    category: CATEGORIES.includes(item.category) ? item.category : "Other",
  }));
}
