const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

/**
 * Gửi 1 message cho 1 repo, kèm nút "Lưu vào Obsidian".
 * callback_data phải gọn (Telegram giới hạn 64 byte) -> chỉ encode index tham chiếu
 * tới 1 "pending item" mà Worker đã lưu sẵn trên GitHub, KHÔNG nhồi full data vào đây.
 */
export async function sendTrendingMessage({ repo, category, summary, pendingId }) {
  const text = [
    `🔥 *${escapeMd(repo.fullName)}*`,
    `📂 Category: ${escapeMd(category)}`,
    `⭐ ${repo.stars} sao (+${repo.starsToday} hôm nay) | ${escapeMd(repo.language || "?")}`,
    "",
    escapeMd(summary),
    "",
    `🔗 ${repo.url}`,
  ].join("\n");

  const body = {
    chat_id: process.env.TELEGRAM_CHAT_ID,
    text,
    parse_mode: "MarkdownV2",
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

function escapeMd(text = "") {
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
}
