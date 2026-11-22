import { config } from "./config.js";
import { createApp } from "./server.js";
import { startScheduler } from "./pipeline.js";
import { loginWithSavedCredentials } from "./zalo/client.js";

const app = createApp();
app.listen(config.port, () => console.log(`[web] Đang chạy tại http://localhost:${config.port}`));

if (config.zaloMode === "external") {
  console.log("[zalo] Chế độ external: nhận tin từ dự án khác qua POST /api/ingest");
} else {
  await loginWithSavedCredentials();
}
startScheduler();
