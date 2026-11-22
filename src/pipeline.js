import { config } from "./config.js";
import { classifyPendingImages } from "./images.js";
import { processAll } from "./extract.js";
import { currentGroupId } from "./zalo/client.js";

export const pipelineState = { running: false, lastRun: null, lastResult: null, error: null };

/** Phân loại ảnh mới rồi trích xuất lỗi từ tin nhắn mới. */
export async function runPipeline({ force = false } = {}) {
  if (pipelineState.running) return { skipped: true };
  const groupId = currentGroupId();
  if (!groupId) return { skipped: true, reason: "Chưa chọn nhóm" };
  if (!process.env.ANTHROPIC_API_KEY) return { skipped: true, reason: "Chưa có ANTHROPIC_API_KEY" };

  pipelineState.running = true;
  pipelineState.error = null;
  try {
    const images = await classifyPendingImages();
    const extract = await processAll(groupId, { force });
    pipelineState.lastResult = { images, extract };
    return pipelineState.lastResult;
  } catch (err) {
    pipelineState.error = err.message;
    console.error("[pipeline]", err);
    throw err;
  } finally {
    pipelineState.running = false;
    pipelineState.lastRun = Date.now();
  }
}

export function startScheduler() {
  const everyMs = config.processIntervalMin * 60 * 1000;
  if (!everyMs) return;
  setInterval(() => runPipeline().catch(() => {}), everyMs).unref();
  console.log(`[pipeline] Tự động xử lý mỗi ${config.processIntervalMin} phút`);
}
