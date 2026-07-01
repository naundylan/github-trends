/**
 * Cloudflare Worker — nhận webhook callback từ Telegram khi user bấm nút "Lưu vào Obsidian".
 * Khi đó: đọc pending item từ GitHub (state/pending/<id>.json), append vào notes/<Category>.md,
 * xoá file pending, rồi edit lại message Telegram thành "Đã lưu".
 *
 * ENV cần cấu hình trong Worker (Settings -> Variables):
 * - TELEGRAM_BOT_TOKEN
 * - GH_TOKEN          (Personal Access Token, quyền repo contents read/write)
 * - GH_OWNER
 * - GH_REPO
 */

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("OK", { status: 200 });
    }

    const update = await request.json();
    const callback = update.callback_query;
    if (!callback || !callback.data?.startsWith("save:")) {
      return new Response("ignored", { status: 200 });
    }

    const pendingId = callback.data.slice("save:".length);
    const chatId = callback.message.chat.id;
    const messageId = callback.message.message_id;

    try {
      const pending = await getJsonFile(env, `state/pending/${pendingId}.json`);
      if (!pending) {
        await answerCallback(env, callback.id, "Item không còn tồn tại (đã lưu trước đó?).");
        return new Response("ok", { status: 200 });
      }

      await appendToNote(env, pending);
      await deleteFile(env, `state/pending/${pendingId}.json`, `chore: clear pending ${pending.repo}`);

      await answerCallback(env, callback.id, "Đã lưu vào Obsidian ✅");
      await editMessageMarkSaved(env, chatId, messageId);
    } catch (err) {
      console.error(err);
      await answerCallback(env, callback.id, "Lỗi khi lưu, thử lại sau.");
    }

    return new Response("ok", { status: 200 });
  },
};

async function ghHeaders(env) {
  return {
    Authorization: `Bearer ${env.GH_TOKEN}`,
    "User-Agent": "github-trends-worker",
    Accept: "application/vnd.github+json",
  };
}

async function getJsonFile(env, path) {
  const url = `https://api.github.com/repos/${env.GH_OWNER}/${env.GH_REPO}/contents/${path}`;
  const res = await fetch(url, { headers: await ghHeaders(env) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub get ${path} failed: ${res.status}`);
  const data = await res.json();
  const content = atob(data.content.replace(/\n/g, ""));
  return { ...JSON.parse(content), _sha: data.sha };
}

async function getFileRaw(env, path) {
  const url = `https://api.github.com/repos/${env.GH_OWNER}/${env.GH_REPO}/contents/${path}`;
  const res = await fetch(url, { headers: await ghHeaders(env) });
  if (res.status === 404) return { content: "", sha: undefined };
  if (!res.ok) throw new Error(`GitHub get ${path} failed: ${res.status}`);
  const data = await res.json();
  return { content: atob(data.content.replace(/\n/g, "")), sha: data.sha };
}

async function putFile(env, path, content, message, sha) {
  const url = `https://api.github.com/repos/${env.GH_OWNER}/${env.GH_REPO}/contents/${path}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { ...(await ghHeaders(env)), "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      content: btoa(unescape(encodeURIComponent(content))),
      sha,
    }),
  });
  if (!res.ok) throw new Error(`GitHub put ${path} failed: ${res.status} ${await res.text()}`);
}

async function deleteFile(env, path, message) {
  const url = `https://api.github.com/repos/${env.GH_OWNER}/${env.GH_REPO}/contents/${path}`;
  const getRes = await fetch(url, { headers: await ghHeaders(env) });
  if (getRes.status === 404) return;
  const { sha } = await getRes.json();
  await fetch(url, {
    method: "DELETE",
    headers: { ...(await ghHeaders(env)), "Content-Type": "application/json" },
    body: JSON.stringify({ message, sha }),
  });
}

async function appendToNote(env, pending) {
  const { content, sha } = await getFileRaw(env, pending.notePath);
  const date = pending.createdAt?.slice(0, 10) || new Date().toISOString().slice(0, 10);

  const section = [
    `## ${pending.repo} (${date})`,
    "",
    `- ⭐ ${pending.stars} sao (+${pending.starsToday} hôm nay) | ${pending.language || "?"}`,
    `- 🔗 ${pending.url}`,
    "",
    pending.summary_vi,
    "",
    "---",
    "",
  ].join("\n");

  const newContent = content ? `${content}\n${section}` : `# ${pending.category}\n\n${section}`;

  await putFile(env, pending.notePath, newContent, `feat: save ${pending.repo} to ${pending.category}`, sha);
}

async function answerCallback(env, callbackQueryId, text) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
  });
}

async function editMessageMarkSaved(env, chatId, messageId) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageReplyMarkup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      reply_markup: {
        inline_keyboard: [[{ text: "✅ Đã lưu", callback_data: "noop" }]],
      },
    }),
  });
}
