import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { db } from "./db.js";

let client;
export function llm() {
  if (!client) client = new Anthropic(); // đọc ANTHROPIC_API_KEY từ môi trường
  return client;
}

/** Dùng trong test để thay client thật. */
export function setLlmClient(c) {
  client = c;
}

export class LlmRefusalError extends Error {}

function recordUsage(purpose, model, usage) {
  if (!usage) return;
  db.prepare(
    "INSERT INTO llm_usage(purpose, model, input_tokens, output_tokens, cache_read_tokens) VALUES (?,?,?,?,?)",
  ).run(
    purpose,
    model,
    usage.input_tokens ?? 0,
    usage.output_tokens ?? 0,
    usage.cache_read_input_tokens ?? 0,
  );
}

/**
 * Gọi Claude và nhận về JSON đúng schema (structured outputs).
 * @returns {Promise<{data: any, usage: any}>}
 */
export async function structured({ purpose, model, system, content, schema, effort = "medium", maxTokens = 16000 }) {
  const response = await llm().messages.parse({
    model,
    max_tokens: maxTokens,
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    output_config: { effort, format: zodOutputFormat(schema) },
    messages: [{ role: "user", content }],
  });
  recordUsage(purpose, model, response.usage);
  if (response.stop_reason === "refusal") {
    throw new LlmRefusalError(`Model từ chối yêu cầu (${response.stop_details?.category ?? "không rõ"})`);
  }
  if (response.stop_reason === "max_tokens") {
    throw new Error("Kết quả bị cắt vì vượt max_tokens, hãy giảm EXTRACT_CHUNK_SIZE");
  }
  if (!response.parsed_output) throw new Error("Không đọc được JSON từ model");
  return { data: response.parsed_output, usage: response.usage };
}

/** Gọi Claude trả lời dạng văn bản (chatbot). */
export async function chatText({ purpose, model, system, messages, effort = "low", maxTokens = 8000 }) {
  const response = await llm().messages.create({
    model,
    max_tokens: maxTokens,
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    output_config: { effort },
    messages,
  });
  recordUsage(purpose, model, response.usage);
  if (response.stop_reason === "refusal") {
    throw new LlmRefusalError("Model từ chối trả lời câu hỏi này");
  }
  return response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/** Che bớt thông tin cá nhân trước khi gửi lên LLM (CCCD, hộ chiếu, SĐT, email). */
export function maskPii(text) {
  if (!text) return text;
  return text
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
    .replace(/(?<!\d)(?:\+?84|0)(?:[\s.-]?\d){9,10}(?!\d)/g, "[sđt]")
    .replace(/(?<![\w])(?:\d{12}|\d{9})(?!\d)/g, "[số giấy tờ]")
    .replace(/\b[A-Z]\d{7,8}\b/g, "[số hộ chiếu]");
}
