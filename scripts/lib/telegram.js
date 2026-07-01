const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

export async function sendTrendingMessage({ repo, category, summary, pendingId }) {
  const text = [
    `🔥 <b>${esc(repo.fullName)}</b>`,
    `📂 Category: ${esc(category)}`,
    `⭐ ${esc(String(repo.stars))} sao (+${esc(String(repo.starsToday))} hôm nay) | ${esc(repo.language || "?")}`,
    ``,
    esc(summary),
    ``,
    `🔗 <a href="${esc(repo.url)}">${esc(repo.url)}</a>`,
  ].join("\n");

  const body = {
    chat_id: process.env.TELEGRAM_CHAT_ID,
    text,
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "💾 Lưu vào Obsidian",
            callback_data: `save:${pendingId}`,
          },
        ],
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