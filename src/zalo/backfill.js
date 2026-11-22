import { config } from "../config.js";
import { getApi } from "./client.js";
import { normalizeMessage } from "./normalize.js";
import { saveMessages } from "./store.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const backfillState = { running: false, pages: 0, added: 0, oldestTs: null, error: null };

/**
 * Kéo lịch sử nhóm (mới nhất -> cũ dần) cho tới khi quá BACKFILL_DAYS ngày.
 * Mỗi trang 50 tin, nghỉ giữa các trang để tránh bị Zalo để ý.
 */
export async function backfillGroup(groupId, days = config.backfillDays) {
  const api = getApi();
  if (!api) throw new Error("Chưa đăng nhập Zalo");
  if (!groupId) throw new Error("Chưa chọn nhóm Zalo");
  if (backfillState.running) throw new Error("Đang kéo lịch sử rồi");

  Object.assign(backfillState, { running: true, pages: 0, added: 0, oldestTs: null, error: null });
  const stopBefore = Date.now() - days * 24 * 3600 * 1000;
  try {
    let page = await api.getCloudMessage(groupId);
    while (true) {
      backfillState.pages++;
      const rows = page.groupMsgs.map(normalizeMessage).filter((r) => r.ts >= stopBefore);
      backfillState.added += saveMessages(rows);
      const oldest = Math.min(...page.groupMsgs.map((m) => Number(m.data.ts)));
      if (Number.isFinite(oldest)) backfillState.oldestTs = oldest;

      if (!page.hasMore || (Number.isFinite(oldest) && oldest < stopBefore)) break;
      await sleep(config.zaloPageDelayMs);

      let next;
      try {
        next = await api.getCloudMessage(groupId, page.lastMsgId, { isOld: page.isOld });
      } catch (err) {
        if (err?.code === -69) break; // Zalo báo hết dữ liệu
        throw err;
      }
      if (!next.groupMsgs.length && (next.isFiltered || next.lastMsgId === page.lastMsgId)) break;
      page = next;
    }
  } catch (err) {
    backfillState.error = err.message;
    throw err;
  } finally {
    backfillState.running = false;
  }
  return { ...backfillState };
}
