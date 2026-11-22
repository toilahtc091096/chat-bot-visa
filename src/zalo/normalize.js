// Chuyển tin nhắn zca-js thành 1 dòng trong bảng messages.

function parseParams(params) {
  if (!params || typeof params !== "string") return {};
  try {
    return JSON.parse(params);
  } catch {
    return {};
  }
}

/** @param {{threadId: string, data: any}} message GroupMessage của zca-js */
export function normalizeMessage(message) {
  const d = message.data;
  const row = {
    id: String(d.msgId),
    group_id: String(message.threadId),
    sender_id: String(d.uidFrom ?? ""),
    sender_name: d.dName || null,
    ts: Number(d.ts),
    msg_type: d.msgType || null,
    text: null,
    attachment_url: null,
    thumb_url: null,
    quote_msg_id: d.quote ? String(d.quote.globalMsgId ?? "") : null,
    quote_text: d.quote ? d.quote.msg || d.quote.attach || null : null,
    raw_json: JSON.stringify(d),
  };

  const c = d.content;
  if (typeof c === "string") {
    row.text = c;
  } else if (c && typeof c === "object") {
    const params = parseParams(c.params);
    row.attachment_url = params.hd || c.href || null;
    row.thumb_url = c.thumb || null;
    // Với ảnh, "title" thường là chú thích; với file là tên file
    row.text = [c.title, c.description].filter((s) => typeof s === "string" && s.trim()).join(" - ") || null;
  }
  return row;
}

export function isImageMessage(row) {
  return row.msg_type === "chat.photo" && !!(row.attachment_url || row.thumb_url);
}
