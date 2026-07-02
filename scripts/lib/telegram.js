const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

/**
 * Telegram HTML mode — chỉ cần escape & < >
 * Giới hạn 1 message: 4096 ký tự
 */
export async function sendTrendingMessage({ repo, category, summary, usecases = [], ideas = [], pendingId }) {
  const usecaseLines = usecases.map((u) => `  • ${esc(u)}`).join("\n");
  const ideaLines = ideas.map((d) => `  • ${esc(d)}`).join("\n");

  const parts = [
    `🔥 <b>${esc(repo.fullName)}</b>`,
    `⭐ ${esc(String(repo.stars))} sao (+${esc(String(repo.starsToday))} hôm nay)  |  ${esc(repo.language || "?")}`,
    `📂 <b>${esc(category)}</b>`,
    ``,
    `📌 <b>Tóm tắt</b>`,
    esc(summary),
    ``,
    `🎯 <b>Use cases thực tế</b>`,
    usecaseLines || "  (không có)",
    ``,
    `💡 <b>Ý tưởng sáng tạo</b>`,
    ideaLines || "  (không có)",
    ``,
    `🔗 <a href="${esc(repo.url)}">${esc(repo.url)}</a>`,
  ];

  // Trim nếu vượt 4096 ký tự
  let text = parts.join("\n");
  if (text.length > 4000) {
    text = text.slice(0, 3950) + "\n\n<i>... (đã cắt bớt)</i>";
  }

  const body = {
    chat_id: process.env.TELEGRAM_CHAT_ID,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [
        [{ text: "💾 Lưu vào Obsidian", callback_data: `save:${pendingId}` }],
      ],
    },
  };

  const res = await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Telegram sendMessage lỗi: ${errText}`);
  }

  return res.json();
}

function esc(text = "") {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
