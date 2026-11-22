// Giao diện web: JavaScript thuần, không cần build.
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    body: options.body && typeof options.body !== "string" ? JSON.stringify(options.body) : options.body,
  });
  const data = res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text();
  if (!res.ok) throw new Error(data?.error || data || res.statusText);
  return data;
}

function fmtTime(ts) {
  return ts ? new Date(ts).toLocaleString("vi-VN", { dateStyle: "short", timeStyle: "short" }) : "";
}

function showDialog(html) {
  $("#dlg-body").innerHTML = html;
  $("#dlg").showModal();
}

// ---------- tabs ----------
const loaders = {};
document.querySelectorAll("nav button").forEach((btn) =>
  btn.addEventListener("click", () => {
    document.querySelectorAll("nav button").forEach((b) => b.classList.toggle("active", b === btn));
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("hidden", t.id !== "tab-" + btn.dataset.tab));
    loaders[btn.dataset.tab]?.();
  }),
);

// ---------- loại hồ sơ ----------
async function loadTypes() {
  const types = await api("/api/types");
  for (const sel of [$("#f-type"), $("#chat-type")]) {
    const current = sel.value;
    sel.querySelectorAll("option:not(:first-child)").forEach((o) => o.remove());
    for (const t of types) sel.insertAdjacentHTML("beforeend", `<option value="${esc(t.name)}">${esc(t.name)} (${t.n})</option>`);
    sel.value = current;
  }
}

// ================= BẢNG LỖI =================
const STATUS_LABEL = { ai: "AI đoán", reviewed: "Đã duyệt", rejected: "Không phải lỗi" };
const SEVERITY_LABEL = { thap: "Thấp", trung_binh: "Trung bình", cao: "Cao" };
const EDIT_COLS = ["ho_so_type", "title", "meaning", "cause", "fix", "prevention"];

async function loadErrors() {
  const params = new URLSearchParams({ type: $("#f-type").value, status: $("#f-status").value, q: $("#f-q").value });
  const rows = await api("/api/errors?" + params);
  $("#error-count").textContent = `${rows.length} lỗi`;
  $("#errors-table tbody").innerHTML = rows
    .map(
      (e) => `<tr data-id="${e.id}" class="st-${e.status}">
        <td>${e.id}</td>
        ${EDIT_COLS.map((c) => `<td contenteditable="plaintext-only" data-col="${c}"${c === "cause" && e.cause_ai && e.cause_ai !== e.cause ? ` title="AI đoán ban đầu: ${esc(e.cause_ai)}"` : ""}>${esc(e[c])}</td>`).join("")}
        <td><select data-col="severity">${Object.entries(SEVERITY_LABEL).map(([k, v]) => `<option value="${k}"${e.severity === k ? " selected" : ""}>${v}</option>`).join("")}</select></td>
        <td><select data-col="status">${Object.entries(STATUS_LABEL).map(([k, v]) => `<option value="${k}"${e.status === k ? " selected" : ""}>${v}</option>`).join("")}</select>
          <div class="small muted">${e.reviewed_by ? "bởi " + esc(e.reviewed_by) : e.confidence != null ? "tin cậy " + Math.round(e.confidence * 100) + "%" : ""}</div></td>
        <td><button class="secondary" data-act="src" title="Xem tin nhắn gốc">💬</button></td>
      </tr>`,
    )
    .join("");
}

async function saveField(tr, col, value, cell) {
  try {
    const updated = await api(`/api/errors/${tr.dataset.id}`, { method: "PATCH", body: { [col]: value } });
    tr.className = "st-" + updated.status;
    tr.querySelector('[data-col="status"]').value = updated.status;
    if (cell) {
      cell.classList.add("saved");
      setTimeout(() => cell.classList.remove("saved"), 800);
    }
  } catch (err) {
    alert("Lưu lỗi: " + err.message);
  }
}

const tbody = $("#errors-table tbody");
tbody.addEventListener("focusin", (ev) => {
  if (ev.target.dataset.col) ev.target.dataset.orig = ev.target.textContent;
});
tbody.addEventListener("focusout", (ev) => {
  const td = ev.target;
  if (!td.matches("td[contenteditable]") || td.textContent === td.dataset.orig) return;
  saveField(td.closest("tr"), td.dataset.col, td.textContent.trim(), td);
});
tbody.addEventListener("change", (ev) => {
  if (ev.target.matches("select[data-col]")) saveField(ev.target.closest("tr"), ev.target.dataset.col, ev.target.value);
});
tbody.addEventListener("click", async (ev) => {
  if (ev.target.dataset.act !== "src") return;
  const id = ev.target.closest("tr").dataset.id;
  const msgs = await api(`/api/errors/${id}/messages`);
  showDialog(
    `<h3>Tin nhắn gốc của lỗi #${id}</h3>` +
      (msgs.length
        ? msgs
            .map(
              (m) => `<div class="msg assistant"><b>${esc(m.sender_name)}</b> <span class="muted small">${fmtTime(m.ts)}</span>
            ${m.quote_text ? `<div class="small muted">↪ ${esc(m.quote_text)}</div>` : ""}
            <div>${esc(m.text || "")}</div>
            ${m.image_id ? `<img src="/api/images/${m.image_id}/file" loading="lazy" /><div class="small muted">[${esc(m.image_category || "?")}] ${esc(m.image_description || "")}</div>` : ""}</div>`,
            )
            .join("")
        : "<p class='muted'>Lỗi này được thêm tay, không có tin nhắn gốc.</p>"),
  );
});

let searchTimer;
$("#f-q").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadErrors, 300);
});
$("#f-type").addEventListener("change", loadErrors);
$("#f-status").addEventListener("change", loadErrors);
$("#btn-add-error").addEventListener("click", async () => {
  const title = prompt("Tên lỗi:");
  if (!title) return;
  const ho_so_type = prompt("Loại hồ sơ:", $("#f-type").value || "Chung") || "Chung";
  await api("/api/errors", { method: "POST", body: { title, ho_so_type } });
  await Promise.all([loadErrors(), loadTypes()]);
});
loaders.errors = () => Promise.all([loadTypes(), loadErrors()]);

// ================= CHATBOT =================
let chatHistory = [];

function renderAnswer(text) {
  // Markdown tối giản: **đậm**, `code`; giữ xuống dòng
  return esc(text).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>");
}

function renderChat() {
  $("#chat-log").innerHTML =
    chatHistory.map((m) => `<div class="msg ${m.role}">${m.role === "user" ? esc(m.content) : renderAnswer(m.content)}</div>`).join("") ||
    `<p class="muted">Chọn loại hồ sơ rồi bấm "Cần lưu ý gì...", hoặc mô tả hồ sơ bạn đang làm.</p>`;
  $("#chat-log").scrollTop = $("#chat-log").scrollHeight;
}

async function sendChat(text) {
  if (!text.trim()) return;
  chatHistory.push({ role: "user", content: text.trim() });
  chatHistory.push({ role: "assistant", content: "Đang tra sổ lỗi..." });
  renderChat();
  $("#chat-form button").disabled = true;
  try {
    const res = await api("/api/chat", { method: "POST", body: { hoSoType: $("#chat-type").value, history: chatHistory.slice(0, -1) } });
    chatHistory[chatHistory.length - 1].content = res.text;
    renderChat();
  } catch (err) {
    chatHistory.splice(-2, 2); // bỏ câu hỏi lỗi để lần sau gửi lại được
    renderChat();
    $("#chat-log").insertAdjacentHTML("beforeend", `<div class="msg assistant">⚠️ Lỗi: ${esc(err.message)}</div>`);
    $("#chat-input").value = text;
  } finally {
    $("#chat-form button").disabled = false;
  }
}

$("#chat-form").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const text = $("#chat-input").value;
  $("#chat-input").value = "";
  sendChat(text);
});
$("#chat-input").addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && !ev.shiftKey) {
    ev.preventDefault();
    $("#chat-form").requestSubmit();
  }
});
$("#btn-checklist").addEventListener("click", () => {
  const type = $("#chat-type").value;
  sendChat(type ? `Tôi sắp làm hồ sơ loại "${type}". Cần lưu ý những gì để không mắc lỗi cũ? Cho tôi checklist.` : "Tổng hợp các lỗi hay gặp nhất và checklist chung khi làm hồ sơ.");
});
$("#btn-chat-clear").addEventListener("click", () => {
  chatHistory = [];
  renderChat();
});
loaders.chat = () => {
  loadTypes();
  renderChat();
};

// ================= ẢNH =================
async function loadCategories() {
  const cats = await api("/api/categories");
  const sel = $("#img-cat");
  const current = sel.value;
  sel.querySelectorAll("option:nth-child(n+3)").forEach((o) => o.remove());
  for (const c of cats) sel.insertAdjacentHTML("beforeend", `<option value="${c.id}">${esc(c.name)} (${c.image_count})</option>`);
  sel.value = current;
  $("#categories").innerHTML =
    cats
      .map(
        (c) => `<div class="card cat" data-id="${c.id}">
        <input data-f="name" value="${esc(c.name)}" />
        <input data-f="description" value="${esc(c.description || "")}" placeholder="Mô tả" />
        <textarea data-f="hints" placeholder="Mỗi dòng một hint">${esc(c.hints.join("\n"))}</textarea>
        <div class="toolbar"><button data-act="save-cat">Lưu</button><span class="muted small">${c.image_count} ảnh</span></div>
      </div>`,
      )
      .join("") || `<p class="muted">Chưa có category. Category sẽ được AI tạo khi phân loại ảnh đầu tiên.</p>`;
}

$("#categories").addEventListener("click", async (ev) => {
  if (ev.target.dataset.act !== "save-cat") return;
  const card = ev.target.closest(".cat");
  await api(`/api/categories/${card.dataset.id}`, {
    method: "PATCH",
    body: {
      name: $('[data-f="name"]', card).value.trim(),
      description: $('[data-f="description"]', card).value.trim(),
      hints: $('[data-f="hints"]', card).value.split("\n").map((s) => s.trim()).filter(Boolean),
    },
  });
  loadCategories();
});

const METHOD_LABEL = { hash: "ảnh giống", hint: "theo hint", vision: "xem đầy đủ", manual: "người sửa", failed: "lỗi tải" };

async function loadImages() {
  const params = new URLSearchParams({ category_id: $("#img-cat").value, method: $("#img-method").value });
  const imgs = await api("/api/images?" + params);
  $("#images-grid").innerHTML =
    imgs
      .map(
        (i) => `<div class="img-card" data-id="${i.id}">
        <img src="/api/images/${i.id}/file" loading="lazy" alt="" />
        <div><b>${esc(i.category || "(chưa có)")}</b> <span class="muted">· ${METHOD_LABEL[i.method] || "chờ xử lý"}</span></div>
        <div class="muted">${esc(i.sender_name)} · ${fmtTime(i.ts)}</div>
        <div>${esc(i.description || "")}</div>
        <div class="toolbar"><button class="secondary" data-act="recat">Đổi category</button><button class="secondary" data-act="reclassify" title="Cho AI phân loại lại">↻</button></div>
      </div>`,
      )
      .join("") || `<p class="muted">Chưa có ảnh.</p>`;
}

$("#images-grid").addEventListener("click", async (ev) => {
  const card = ev.target.closest(".img-card");
  if (!card) return;
  if (ev.target.tagName === "IMG") return showDialog(`<img src="${ev.target.src}" />`);
  if (ev.target.dataset.act === "recat") {
    const category = prompt("Category đúng của ảnh này (gõ tên có sẵn hoặc tên mới):");
    if (!category) return;
    const hint = prompt("Dấu hiệu để nhận ra loại ảnh này (không bắt buộc), ví dụ: 'Ảnh có logo ... ở góc trên thì là loại này':");
    await api(`/api/images/${card.dataset.id}`, { method: "PATCH", body: { category, hint } });
    loaders.images();
  }
  if (ev.target.dataset.act === "reclassify") {
    ev.target.disabled = true;
    try {
      await api(`/api/images/${card.dataset.id}/reclassify`, { method: "POST" });
    } catch (err) {
      alert(err.message);
    }
    loaders.images();
  }
});
$("#img-cat").addEventListener("change", loadImages);
$("#img-method").addEventListener("change", loadImages);
loaders.images = () => Promise.all([loadCategories(), loadImages()]);

// ================= HỆ THỐNG =================
const ZALO_LABEL = { disconnected: "Chưa đăng nhập", waiting_qr: "Chờ quét QR", scanned: "Đã quét, chờ xác nhận", connected: "Đã kết nối", error: "Lỗi" };
const PRICE = { "claude-haiku-5-5": [0.1, 0.5], "claude-sonnet-5-5": [2, 10], "claude-opus-5-5": [4, 20] }; // USD / 1 triệu token

let statusTimer;
async function loadStatus() {
  const s = await api("/api/status");
  $("#who").textContent = s.user;
  $("#zalo-status").textContent = ZALO_LABEL[s.zalo.status] + (s.zalo.account ? ` (${s.zalo.account})` : "") + (s.zalo.listening ? " · đang nghe tin mới" : "");
  $("#zalo-detail").textContent = s.zalo.detail || "";
  const showQr = s.zalo.status === "waiting_qr";
  $("#qr-box").classList.toggle("hidden", !showQr);
  if (showQr) $("#qr-img").src = "/api/zalo/qr.png?t=" + Date.now();
  $("#group-name").textContent = s.groupName || s.groupId || "(chưa chọn)";
  $("#msg-stats").textContent = s.messages
    ? `${s.messages.n} tin nhắn đã lưu${s.messages.n ? `, từ ${fmtTime(s.messages.min_ts)} đến ${fmtTime(s.messages.max_ts)}` : ""}. Chờ xử lý: ${s.pendingMessages} tin, ${s.pendingImages} ảnh.`
    : "";
  const b = s.backfill;
  const p = s.pipeline;
  $("#jobs").textContent = [
    !s.hasApiKey && "⚠️ Chưa cấu hình ANTHROPIC_API_KEY",
    b.running ? `Đang lấy lịch sử: ${b.pages} trang, +${b.added} tin (cũ nhất ${fmtTime(b.oldestTs)})` : b.pages ? `Lấy lịch sử xong: +${b.added} tin${b.error ? " · lỗi: " + b.error : ""}` : "",
    p.running ? "Đang phân loại ảnh và trích xuất lỗi..." : p.lastRun ? `Xử lý lần cuối: ${fmtTime(p.lastRun)}${p.error ? " · lỗi: " + p.error : ""}` : "",
    "Lỗi: " + (s.errors.map((e) => `${STATUS_LABEL[e.status]} ${e.n}`).join(", ") || "chưa có"),
  ]
    .filter(Boolean)
    .join("\n");
  let total = 0;
  $("#usage").innerHTML =
    s.usage30d
      .map((u) => {
        const [pi, po] = PRICE[u.model] || [0, 0];
        const cost = (u.input_tokens * pi + u.output_tokens * po) / 1e6;
        total += cost;
        return `<div>${esc(u.model)}: ${u.calls} lần gọi, ${u.input_tokens.toLocaleString()} token vào, ${u.output_tokens.toLocaleString()} token ra ≈ $${cost.toFixed(3)}</div>`;
      })
      .join("") + `<div><b>Tổng ≈ $${total.toFixed(3)}</b> <span class="muted small">(ước tính, chưa trừ giảm giá cache)</span></div>`;
  clearTimeout(statusTimer);
  if (!$("#tab-system").classList.contains("hidden")) statusTimer = setTimeout(loadStatus, b.running || p.running || s.zalo.status !== "connected" ? 3000 : 15000);
}

$("#btn-qr").addEventListener("click", async () => {
  await api("/api/zalo/login-qr", { method: "POST" });
  setTimeout(loadStatus, 1500);
});
$("#btn-groups").addEventListener("click", async () => {
  try {
    const groups = await api("/api/zalo/groups");
    $("#group-select").innerHTML = groups.map((g) => `<option value="${esc(g.id)}">${esc(g.name)}${g.members ? ` (${g.members} người)` : ""}</option>`).join("");
    $("#group-select").classList.remove("hidden");
    $("#btn-save-group").classList.remove("hidden");
  } catch (err) {
    alert(err.message);
  }
});
$("#btn-save-group").addEventListener("click", async () => {
  const sel = $("#group-select");
  await api("/api/zalo/group", { method: "POST", body: { id: sel.value, name: sel.selectedOptions[0].textContent } });
  sel.classList.add("hidden");
  $("#btn-save-group").classList.add("hidden");
  loadStatus();
});
$("#btn-backfill").addEventListener("click", async () => {
  if (!confirm("Lấy lịch sử nhóm rồi cho AI xử lý? Việc này tốn token cho lần chạy đầu.")) return;
  await api("/api/zalo/backfill", { method: "POST", body: { days: Number($("#backfill-days").value) } });
  setTimeout(loadStatus, 1000);
});
$("#btn-process").addEventListener("click", async () => {
  await api("/api/pipeline/run", { method: "POST", body: { force: true } });
  setTimeout(loadStatus, 1000);
});
loaders.system = loadStatus;

// khởi động
loaders.errors();
api("/api/status").then((s) => ($("#who").textContent = s.user));
