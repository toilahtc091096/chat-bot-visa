import fs from "node:fs";
import path from "node:path";

// Đọc file .env đơn giản (không cần thư viện dotenv). Biến môi trường thật luôn được ưu tiên.
function loadDotEnv(file = ".env") {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    let value = m[2];
    if (/^".*"$|^'.*'$/.test(value)) value = value.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}
loadDotEnv();

const env = process.env;
const dataDir = path.resolve(env.DATA_DIR || "./data");
fs.mkdirSync(path.join(dataDir, "images"), { recursive: true });

export const config = {
  port: Number(env.PORT || 3000),
  dataDir,
  dbPath: path.join(dataDir, "app.db"),
  imagesDir: path.join(dataDir, "images"),
  zaloCredentialsPath: path.join(dataDir, "zalo-credentials.json"),
  zaloQrPath: path.join(dataDir, "zalo-qr.png"),
  timezone: env.TZ || "Asia/Ho_Chi_Minh",

  // "ten:matkhau,ten2:matkhau2" – tài khoản đăng nhập web (3-5 người)
  users: Object.fromEntries(
    (env.APP_USERS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((pair) => {
        const i = pair.indexOf(":");
        return [pair.slice(0, i), pair.slice(i + 1)];
      }),
  ),

  // Zalo
  // direct: app tự đăng nhập Zalo (QR). external: dự án khác đã đăng nhập Zalo và gửi tin sang qua POST /api/ingest
  zaloMode: env.ZALO_MODE === "external" ? "external" : "direct",
  ingestToken: env.INGEST_TOKEN || "",
  zaloGroupId: env.ZALO_GROUP_ID || "", // có thể chọn trên web thay vì đặt ở đây
  backfillDays: Number(env.BACKFILL_DAYS || 30),
  zaloPageDelayMs: Number(env.ZALO_PAGE_DELAY_MS || 2000),

  // LLM
  modelExtract: env.LLM_MODEL_EXTRACT || "claude-sonnet-5-5",
  modelChat: env.LLM_MODEL_CHAT || "claude-haiku-5-5",
  modelImageCheap: env.LLM_MODEL_IMAGE_CHEAP || "claude-haiku-5-5",
  modelImageFull: env.LLM_MODEL_IMAGE_FULL || "claude-sonnet-5-5",
  maskPii: (env.MASK_PII || "true") !== "false",

  // Xử lý tự động: chỉ xử lý khi tin nhắn cuối đã "yên" được bao nhiêu phút
  processIntervalMin: Number(env.PROCESS_INTERVAL_MIN || 30),
  processQuietMin: Number(env.PROCESS_QUIET_MIN || 15),
  chunkSize: Number(env.EXTRACT_CHUNK_SIZE || 120),
  contextSize: Number(env.EXTRACT_CONTEXT_SIZE || 20),

  // Ảnh: ngưỡng khoảng cách hash để coi 2 ảnh là "gần giống nhau"
  imageHashMaxDistance: Number(env.IMAGE_HASH_MAX_DISTANCE || 6),
  imageCheapMinConfidence: Number(env.IMAGE_CHEAP_MIN_CONFIDENCE || 0.75),
};
