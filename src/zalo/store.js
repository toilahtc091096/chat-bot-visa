import { db } from "../db.js";

const insert = db.prepare(`
  INSERT OR IGNORE INTO messages
    (id, group_id, sender_id, sender_name, ts, msg_type, text, attachment_url, thumb_url, quote_msg_id, quote_text, raw_json)
  VALUES
    (@id, @group_id, @sender_id, @sender_name, @ts, @msg_type, @text, @attachment_url, @thumb_url, @quote_msg_id, @quote_text, @raw_json)
`);

/** Lưu tin nhắn, bỏ qua tin đã có. Trả về số tin mới. */
export const saveMessages = db.transaction((rows) => {
  let added = 0;
  for (const row of rows) added += insert.run(row).changes;
  return added;
});
