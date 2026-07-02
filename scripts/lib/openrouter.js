import { CATEGORIES } from "./categories.js";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODEL = process.env.OPENROUTER_MODEL || "poolside/laguna-xs.2:free";

export async function categorizeAndSummarize(repos) {
  const listText = repos
    .map((r, i) => {
      return `${i + 1}. ${r.fullName}
- Mô tả gốc: ${r.description || "(không có)"}
- Ngôn ngữ: ${r.language || "(không rõ)"}
- Topics: ${(r.topics || []).join(", ") || "(không có)"}
- Sao hôm nay: ${r.starsToday}, tổng sao: ${r.stars}`;
    })
    .join("\n\n");

  const systemPrompt = `Bạn là một kỹ sư phần mềm giàu kinh nghiệm, có tư duy sáng tạo và tầm nhìn xa. Nhiệm vụ của bạn là phân tích các repo GitHub trending và viết nội dung chất lượng cao bằng tiếng Việt.

Với mỗi repo, hãy trả về JSON với các trường sau:
- "repo": "owner/name"
- "category": chọn ĐÚNG 1 trong danh sách sau (không tự tạo category mới):
${CATEGORIES.map((c) => `  ${c}`).join("\n")}
- "summary": 2-3 câu mô tả rõ dự án làm gì, vấn đề nó giải quyết, điểm nổi bật kỹ thuật
- "usecases": mảng 3-4 string, mỗi string là 1 use case thực tế cụ thể (ai dùng, dùng để làm gì, trong bối cảnh nào)
- "ideas": mảng 3-5 string, mỗi string là 1 ý tưởng sáng tạo táo bạo — tưởng tượng xa, kết hợp với các tool/dự án khác, ứng dụng trong tương lai, viễn tưởng được, càng độc đáo càng tốt

CHỈ trả về JSON thuần (không markdown, không giải thích), dạng:
[{ "repo": "...", "category": "...", "summary": "...", "usecases": ["...", "..."], "ideas": ["...", "..."] }]`;

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
        { role: "user", content: `Phân tích các repo sau:\n\n${listText}` },
      ],
      temperature: 0.7,
      max_tokens: 8000,
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
  } catch {
    throw new Error(`Không parse được JSON từ OpenRouter: ${cleaned.slice(0, 200)}`);
  }

  return parsed.map((item) => ({
    ...item,
    category: CATEGORIES.includes(item.category) ? item.category : "Other",
    usecases: Array.isArray(item.usecases) ? item.usecases : [],
    ideas: Array.isArray(item.ideas) ? item.ideas : [],
  }));
}
