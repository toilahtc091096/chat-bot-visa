import fs from "node:fs";
import { Zalo, ThreadType, LoginQRCallbackEventType } from "zca-js";
import { config } from "../config.js";
import { db, getSetting } from "../db.js";
import { normalizeMessage } from "./normalize.js";
import { saveMessages } from "./store.js";

// Trạng thái hiển thị trên trang /zalo
export const zaloState = {
  status: "disconnected", // disconnected | waiting_qr | scanned | connected | error
  detail: "",
  account: null,
  listening: false,
};

let api = null;
let listenerStarted = false;
export const getApi = () => api;

const zalo = new Zalo({ selfListen: true, checkUpdate: false, logging: false });

function setState(status, detail = "") {
  zaloState.status = status;
  zaloState.detail = detail;
  console.log(`[zalo] ${status}${detail ? ": " + detail : ""}`);
}

async function afterLogin(newApi, { listen = true } = {}) {
  api = newApi;
  try {
    const info = await api.fetchAccountInfo();
    zaloState.account = info?.profile?.displayName || info?.displayName || null;
  } catch {
    zaloState.account = null;
  }
  setState("connected");
  if (listen) startListener();
  return api;
}

/** Đăng nhập lại bằng cookie đã lưu (không cần quét QR). */
export async function loginWithSavedCredentials({ listen = true } = {}) {
  if (!fs.existsSync(config.zaloCredentialsPath)) return null;
  try {
    const creds = JSON.parse(fs.readFileSync(config.zaloCredentialsPath, "utf8"));
    return await afterLogin(await zalo.login(creds), { listen });
  } catch (err) {
    setState("error", `Cookie đã lưu không dùng được, cần quét QR lại (${err.message})`);
    return null;
  }
}

/** Bắt đầu đăng nhập QR. Ảnh QR được lưu ra file để trang web hiển thị. */
export async function startQrLogin() {
  if (zaloState.status === "waiting_qr" || zaloState.status === "scanned") return;
  if (fs.existsSync(config.zaloQrPath)) fs.unlinkSync(config.zaloQrPath);
  setState("waiting_qr", "Đang tạo mã QR...");

  zalo
    .loginQR({ qrPath: config.zaloQrPath }, async (event) => {
      switch (event.type) {
        case LoginQRCallbackEventType.QRCodeGenerated:
          await event.actions.saveToFile(config.zaloQrPath);
          setState("waiting_qr", "Mở Zalo trên điện thoại của tài khoản phụ và quét mã QR");
          break;
        case LoginQRCallbackEventType.QRCodeExpired:
          setState("waiting_qr", "Mã QR hết hạn, đang tạo mã mới...");
          event.actions.retry();
          break;
        case LoginQRCallbackEventType.QRCodeScanned:
          setState("scanned", `Đã quét bởi ${event.data.display_name}, hãy bấm xác nhận trên điện thoại`);
          break;
        case LoginQRCallbackEventType.QRCodeDeclined:
          setState("error", "Đăng nhập bị từ chối trên điện thoại");
          event.actions.abort();
          break;
        case LoginQRCallbackEventType.GotLoginInfo:
          fs.writeFileSync(
            config.zaloCredentialsPath,
            JSON.stringify({ cookie: event.data.cookie, imei: event.data.imei, userAgent: event.data.userAgent }),
            { mode: 0o600 },
          );
          break;
      }
    })
    .then((newApi) => {
      if (fs.existsSync(config.zaloQrPath)) fs.unlinkSync(config.zaloQrPath);
      return afterLogin(newApi);
    })
    .catch((err) => setState("error", `Đăng nhập QR thất bại: ${err.message}`));
}

export function currentGroupId() {
  return getSetting("zalo_group_id", config.zaloGroupId) || "";
}

/** Lắng nghe tin nhắn mới theo thời gian thực, chỉ lưu tin của nhóm đã chọn. */
function startListener() {
  if (!api || listenerStarted) return;
  listenerStarted = true;
  const listener = api.listener;
  listener.on("message", (message) => {
    const groupId = currentGroupId();
    if (message.type !== ThreadType.Group || String(message.threadId) !== groupId) return;
    const saved = saveMessages([normalizeMessage(message)]);
    if (saved) console.log(`[zalo] Lưu tin mới từ ${message.data.dName}`);
  });
  listener.on("connected", () => {
    zaloState.listening = true;
    console.log("[zalo] Listener đã kết nối");
  });
  listener.on("closed", (code, reason) => {
    zaloState.listening = false;
    // 3000: có phiên Zalo Web khác đang mở cùng tài khoản
    setState("error", `Mất kết nối listener (${code}${reason ? " " + reason : ""}). ` +
      (code === 3000 ? "Có thể tài khoản đang mở Zalo Web ở nơi khác." : ""));
  });
  listener.on("error", (err) => console.error("[zalo] listener error", err));
  listener.start({ retryOnClose: true });
}

/** Danh sách nhóm của tài khoản (để chọn nhóm trên web). */
export async function listGroups() {
  if (!api) throw new Error("Chưa đăng nhập Zalo");
  const all = await api.getAllGroups();
  const ids = Object.keys(all.gridVerMap || {});
  const groups = [];
  for (let i = 0; i < ids.length; i += 50) {
    const info = await api.getGroupInfo(ids.slice(i, i + 50));
    for (const [id, g] of Object.entries(info.gridInfoMap || {})) {
      groups.push({ id, name: g.name, members: g.totalMember ?? null });
    }
  }
  return groups.sort((a, b) => a.name.localeCompare(b.name, "vi"));
}

export function messageCount(groupId) {
  return db.prepare("SELECT COUNT(*) AS n, MIN(ts) AS min_ts, MAX(ts) AS max_ts FROM messages WHERE group_id = ?").get(groupId);
}
