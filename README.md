# github-trends

Tự động crawl GitHub Trending mỗi 6 tiếng, dùng AI (qua OpenRouter) tóm tắt + phân loại
theo category, gửi về Telegram. Bấm nút "💾 Lưu vào Obsidian" trên Telegram thì hệ thống
tự append note vào file đúng category trong repo này — sau đó Obsidian (qua plugin
Obsidian Git) tự pull về máy bạn khi mở app.

## Kiến trúc

```
GitHub Action (cron 6h)
  -> crawl trending (@huchenme/github-trending)
  -> lọc theo state/trending-history.json (check trùng, ngưỡng 3 tuần)
  -> lấy topics qua Octokit
  -> gọi OpenRouter (phân loại + tóm tắt tiếng Việt)
  -> ghi state/pending/<id>.json (chờ user xác nhận)
  -> gửi Telegram kèm nút "Lưu vào Obsidian"

User bấm nút trên Telegram
  -> Cloudflare Worker nhận callback
  -> đọc state/pending/<id>.json
  -> append nội dung vào notes/<Category>.md
  -> xoá file pending
  -> sửa nút Telegram thành "Đã lưu"

Obsidian vault (Obsidian Git plugin)
  -> tự pull repo này định kỳ / khi mở app
  -> note mới tự xuất hiện trong vault, không cần làm gì thêm
```

## 1. Tạo repo GitHub

Tạo repo mới tên `github-trends` (public hoặc private đều được, Action vẫn chạy bình thường).
Clone toàn bộ các file trong project này vào repo, push lên `main`.

## 2. Cài đặt local (để test trước khi đẩy lên Action)

```bash
npm install
cp .env.example .env
# điền các giá trị thật vào .env
node scripts/crawl.js
```

Nếu chạy ổn (thấy log "Queued + sent Telegram message for ..." và có tin nhắn Telegram),
chuyển sang cấu hình GitHub Action.

## 3. Tạo Telegram Bot

1. Chat với [@BotFather](https://t.me/BotFather) trên Telegram, dùng lệnh `/newbot`, đặt tên bot.
2. Lưu lại **token** BotFather trả về (dạng `123456:ABC-xxx`) — đây là `TELEGRAM_BOT_TOKEN`.
3. Lấy `TELEGRAM_CHAT_ID`: nhắn 1 tin bất kỳ cho bot vừa tạo, sau đó mở:
   `https://api.telegram.org/bot<TOKEN>/getUpdates`
   Tìm field `chat.id` trong JSON trả về — đó là `TELEGRAM_CHAT_ID` của bạn.

## 4. Tạo Personal Access Token (GH_TOKEN)

Vào GitHub → Settings → Developer settings → Personal access tokens → Fine-grained token.
Tạo token với quyền **Contents: Read and write** trên riêng repo `github-trends`.
Token này dùng cho cả:
- GitHub Action (đặt làm secret `GITHUB_TOKEN` mặc định của Action thực ra đã đủ quyền viết
  vào repo chứa nó, nên có thể dùng `secrets.GITHUB_TOKEN` có sẵn, không cần tạo PAT riêng
  cho phần Action).
- Cloudflare Worker (**bắt buộc tạo PAT riêng**, vì Worker chạy ngoài GitHub Action,
  không có quyền truy cập `secrets.GITHUB_TOKEN` mặc định).

## 5. Lấy OpenRouter API Key

Đăng ký tại [openrouter.ai](https://openrouter.ai), tạo API key, lưu lại `OPENROUTER_API_KEY`.
Model mặc định trong code là model free `poolside/laguna-xs.2:free` — có thể đổi qua biến
`OPENROUTER_MODEL` nếu model đó bị deprecate hoặc bạn muốn dùng model khác.

## 6. Cấu hình GitHub Action Secrets & Variables

Vào repo `github-trends` → Settings → Secrets and variables → Actions.

**Secrets** (tab Secrets):
| Tên | Giá trị |
|---|---|
| `OPENROUTER_API_KEY` | API key từ OpenRouter |
| `TELEGRAM_BOT_TOKEN` | Token bot từ BotFather |
| `TELEGRAM_CHAT_ID` | Chat ID của bạn |

(`GITHUB_TOKEN` không cần tạo — GitHub tự cấp sẵn cho mỗi Action run.)

**Variables** (tab Variables, optional):
| Tên | Giá trị | Ghi chú |
|---|---|---|
| `OPENROUTER_MODEL` | `poolside/laguna-xs.2:free` | để trống = dùng default trong code |
| `TRENDING_LANGUAGES` | `` (để trống) | hoặc vd `javascript,python,go` nếu muốn giới hạn |

## 7. Bật GitHub Action

Workflow đã có sẵn ở `.github/workflows/trending.yml`, chạy cron mỗi 6 tiếng
(`0 */6 * * *`) và có thể chạy tay qua tab **Actions → GitHub Trending Crawl → Run workflow**
để test trước khi chờ cron.

## 8. Deploy Cloudflare Worker (xử lý nút "Lưu")

1. Cài Wrangler CLI: `npm install -g wrangler`
2. Tạo project Worker mới (hoặc dùng lại Worker cũ nếu bạn muốn gộp chung với luồng
   free-for-dev — chỉ cần thêm route xử lý riêng), copy nội dung `worker/index.js` vào.
3. Cấu hình biến môi trường cho Worker (`wrangler secret put <NAME>` hoặc qua Dashboard
   → Worker → Settings → Variables):
   - `TELEGRAM_BOT_TOKEN`
   - `GH_TOKEN` (PAT tạo ở bước 4, quyền Contents read/write)
   - `GH_OWNER` (username GitHub của bạn)
   - `GH_REPO` (`github-trends`)
4. Deploy: `wrangler deploy`
5. Lấy URL Worker (dạng `https://github-trends-webhook.<your-subdomain>.workers.dev`).

## 9. Set Telegram Webhook trỏ về Worker

Gọi 1 lần (thay `<TOKEN>` và `<WORKER_URL>`):

```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=<WORKER_URL>"
```

Kiểm tra đã set đúng:

```bash
curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
```

## 10. Gắn vào Obsidian vault qua Obsidian Git

1. Trong Obsidian, cài plugin community **Obsidian Git**.
2. Cách đơn giản nhất: clone repo `github-trends` này vào làm 1 thư mục con trong vault
   hiện tại của bạn (vd `<vault>/github-trends/`), rồi cấu hình Obsidian Git pull tự động
   theo interval (Settings → Obsidian Git → "Auto pull interval").
   - Nếu vault chính của bạn đã được quản lý bởi 1 git repo khác, có thể thêm
     `github-trends` như **git submodule**, hoặc đơn giản hơn là dùng 1 vault/folder riêng
     chỉ để chứa repo này và add làm "Attachment folder"/symlink vào vault chính.
3. Từ giờ, mỗi khi bạn mở Obsidian, plugin tự `git pull` → note mới trong `notes/*.md`
   tự xuất hiện, không cần thao tác gì thêm.

## Cấu trúc dữ liệu

```
state/
  trending-history.json   # check trùng theo "owner/repo", ngưỡng 3 tuần (resurface)
  pending/<uuid>.json      # note đang chờ user bấm "Lưu" trên Telegram
notes/
  AI-LLM.md
  Web-Frontend.md
  CLI-Tool.md
  ...                      # mỗi category 1 file, repo mới append nối tiếp vào cuối
```

## Tuỳ chỉnh category

Sửa trực tiếp mảng `CATEGORIES` trong `scripts/lib/categories.js`. Đây là danh sách
closed-set — OpenRouter chỉ được chọn trong danh sách này, nếu trả về category lạ
hệ thống tự fallback về `"Other"`.

## Điều chỉnh ngưỡng "mới nổi lại" (resurface)

Mặc định 21 ngày (3 tuần), sửa hằng số `RESURFACE_DAYS` trong `scripts/lib/history.js`.

## Điều chỉnh tần suất cron

Sửa biểu thức cron trong `.github/workflows/trending.yml`
(hiện tại `0 */6 * * *` = mỗi 6 tiếng, vào phút 0 của giờ chẵn 6).
