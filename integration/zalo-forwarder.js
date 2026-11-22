/**
 * Chép file này vào dự án ĐANG đăng nhập Zalo (dự án lọc hồ sơ).
 * Nó chuyển tin nhắn của nhóm "Xử lý hồ sơ lỗi" sang Sổ lỗi hồ sơ qua POST /api/ingest.
 * Không cần thư viện ngoài (Node 18+ có sẵn fetch). Viết bằng ESM; nếu dự án dùng
 * CommonJS thì đổi `export function` thành `module.exports = { ... }`.
 *
 * Biến môi trường trong dự án kia:
 *   SO_LOI_URL=http://127.0.0.1:3000      địa chỉ Sổ lỗi hồ sơ
 *   SO_LOI_TOKEN=...                      giống INGEST_TOKEN bên Sổ lỗi
 *   SO_LOI_GROUP_ID=...                   id nhóm Zalo "Xử lý hồ sơ lỗi"
 */

const URL_ = (process.env.SO_LOI_URL || "http://127.0.0.1:3000").replace(/\/$/, "") + "/api/ingest";
const TOKEN = process.env.SO_LOI_TOKEN || "";
const GROUP_ID = process.env.SO_LOI_GROUP_ID || "";
const MAX_QUEUE = 5000;

const queue = [];
let flushing = false;

async function post(messages) {
  const res = await fetch(URL_, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Ingest-Token": TOKEN },
    body: JSON.stringify({ messages }),
  });
  if (!res.ok) throw new Error(`Sổ lỗi trả về HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

async function flush() {
  if (flushing || !queue.length) return;
  flushing = true;
  try {
    while (queue.length) {
      const batch = queue.slice(0, 50);
      await post(batch);
      queue.splice(0, batch.length);
    }
  } catch (err) {
    // Sổ lỗi đang tắt hoặc lỗi mạng: giữ lại trong hàng đợi, thử lại ở lần sau
    console.warn("[so-loi] Chưa gửi được, sẽ thử lại:", err.message);
  } finally {
    flushing = false;
  }
}

setInterval(flush, 5000).unref();

/**
 * Gọi trong listener.on("message", ...) có sẵn của dự án kia. Không làm thay đổi xử lý hiện tại.
 * @param message GroupMessage/UserMessage của zca-js
 */
export function forwardToSoLoi(message) {
  if (!GROUP_ID || String(message.threadId) !== GROUP_ID) return;
  queue.push({ threadId: String(message.threadId), data: message.data });
  if (queue.length > MAX_QUEUE) queue.shift();
  if (queue.length >= 50) flush();
}

/**
 * Gửi lịch sử N ngày của nhóm sang Sổ lỗi. Dùng chính `api` đã đăng nhập của dự án kia,
 * nên KHÔNG cần đăng nhập Zalo lần nữa. Chạy 1 lần lúc đầu (gửi trùng cũng không sao).
 */
export async function backfillToSoLoi(api, days = 30, { delayMs = 2000 } = {}) {
  if (!GROUP_ID) throw new Error("Chưa đặt SO_LOI_GROUP_ID");
  const stopBefore = Date.now() - days * 24 * 3600 * 1000;
  let page = await api.getCloudMessage(GROUP_ID);
  let total = 0;
  while (true) {
    const msgs = page.groupMsgs.filter((m) => Number(m.data.ts) >= stopBefore);
    if (msgs.length) {
      const r = await post(msgs.map((m) => ({ threadId: String(m.threadId), data: m.data })));
      total += r.added;
    }
    const oldest = Math.min(...page.groupMsgs.map((m) => Number(m.data.ts)));
    console.log(`[so-loi] Đã gửi ${total} tin, tới ${new Date(oldest).toLocaleString("vi-VN")}`);
    if (!page.hasMore || oldest < stopBefore) break;
    await new Promise((r) => setTimeout(r, delayMs));
    let next;
    try {
      next = await api.getCloudMessage(GROUP_ID, page.lastMsgId, { isOld: page.isOld });
    } catch (err) {
      if (err?.code === -69) break;
      throw err;
    }
    if (!next.groupMsgs.length && (next.isFiltered || next.lastMsgId === page.lastMsgId)) break;
    page = next;
  }
  return total;
}
