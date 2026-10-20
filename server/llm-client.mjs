// Client for an OpenAI-compatible chat API: Ollama, LM Studio, llama.cpp's
// server, vLLM and hosted APIs that use the same format. Only two routes are
// ever called: GET /v1/models and POST /v1/chat/completions.
//
// `send(method, path, body)` is supplied by the caller and performs the
// network request (see agent.mjs), so this module stays pure and testable.

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/u;
const MAX_MODELS = 200;
const MAX_CONTENT_CHARS = 8_000;
const MAX_TOOL_CALLS = 4;
const MAX_ARGUMENT_CHARS = 2_000;

export const LLM_ROUTES = Object.freeze({
  models: "/v1/models",
  chat: "/v1/chat/completions"
});

export class LlmError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.name = "LlmError";
    this.code = code;
    this.status = status;
  }
}

export function validModelId(value) {
  return typeof value === "string" && MODEL_ID.test(value);
}

export async function listModels(send) {
  const response = await send("GET", LLM_ROUTES.models);
  if (response.status === 401 || response.status === 403) {
    throw new LlmError("MODEL_SERVER_AUTH_REJECTED", "The model server rejected the API key.", 502);
  }
  if (response.status !== 200 || !response.json || !Array.isArray(response.json.data)) {
    throw new LlmError("MODEL_SERVER_INCOMPATIBLE", "The model server did not answer like an OpenAI-compatible API at /v1/models.");
  }
  const ids = [];
  for (const entry of response.json.data.slice(0, MAX_MODELS)) {
    if (entry && validModelId(entry.id) && !ids.includes(entry.id)) ids.push(entry.id);
  }
  return ids.sort((left, right) => left.localeCompare(right));
}

/** Removes reasoning blocks some local models print before their answer. */
export function stripReasoning(text) {
  return String(text ?? "")
    .replace(/<think>[\s\S]*?<\/think>/giu, "")
    .replace(/^[\s\S]*?<\/think>/iu, "")
    .trim();
}

function parseArguments(raw) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
  if (typeof raw !== "string" || raw.length > MAX_ARGUMENT_CHARS) return null;
  const text = raw.trim();
  if (text === "") return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function candidateObjects(text) {
  const found = [];
  const tagged = text.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/giu);
  for (const match of tagged) found.push(match[1]);
  const fenced = text.matchAll(/```(?:json)?\s*([\s\S]*?)```/giu);
  for (const match of fenced) found.push(match[1]);
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) found.push(trimmed);
  return found;
}

/**
 * Small models sometimes write a tool call as text instead of using the API's
 * tool_calls field. Accept that only for a known tool name and an object of
 * arguments; anything else stays ordinary text.
 */
export function toolCallsFromContent(content, toolNames) {
  const names = new Set(toolNames);
  const calls = [];
  for (const candidate of candidateObjects(String(content ?? ""))) {
    let parsed;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const name = entry.name ?? entry.function?.name ?? entry.tool;
      const args = parseArguments(entry.arguments ?? entry.parameters ?? entry.function?.arguments ?? {});
      if (typeof name === "string" && names.has(name) && args) {
        calls.push({ id: `text-${calls.length + 1}`, name, arguments: args });
      }
      if (calls.length >= MAX_TOOL_CALLS) return calls;
    }
  }
  return calls;
}

export async function chatCompletion(send, { model, messages, tools, maxTokens = 400, temperature = 0.2 }) {
  if (!validModelId(model)) throw new LlmError("MODEL_NOT_CONFIGURED", "Choose a model for the agent.", 409);
  const body = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: false,
    ...(tools?.length ? { tools, tool_choice: "auto" } : {})
  };
  const response = await send("POST", LLM_ROUTES.chat, body);
  if (response.status === 401 || response.status === 403) {
    throw new LlmError("MODEL_SERVER_AUTH_REJECTED", "The model server rejected the API key.");
  }
  if (response.status === 404) {
    throw new LlmError("MODEL_NOT_FOUND", `The model server does not have the model "${model}".`);
  }
  if (response.status !== 200 || !response.json) {
    throw new LlmError("MODEL_REQUEST_FAILED", `The model server answered with HTTP ${response.status}.`);
  }
  const choice = Array.isArray(response.json.choices) ? response.json.choices[0] : null;
  const message = choice?.message;
  if (!message || typeof message !== "object") {
    throw new LlmError("MODEL_SERVER_INCOMPATIBLE", "The model server's answer had no message.");
  }
  const toolNames = (tools || []).map((tool) => tool?.function?.name).filter(Boolean);
  const toolCalls = [];
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls.slice(0, MAX_TOOL_CALLS)) {
      const name = call?.function?.name;
      const args = parseArguments(call?.function?.arguments);
      if (typeof name === "string" && toolNames.includes(name) && args) {
        toolCalls.push({
          id: typeof call.id === "string" && call.id.length <= 64 ? call.id : `call-${toolCalls.length + 1}`,
          name,
          arguments: args
        });
      }
    }
  }
  const rawContent = typeof message.content === "string" ? message.content.slice(0, MAX_CONTENT_CHARS) : "";
  const content = stripReasoning(rawContent);
  if (toolCalls.length === 0 && content) toolCalls.push(...toolCallsFromContent(content, toolNames));
  return {
    content: toolCalls.length && toolCalls[0].id.startsWith("text-") ? "" : content,
    toolCalls,
    finishReason: typeof choice.finish_reason === "string" ? choice.finish_reason : null,
    usage: response.json.usage && typeof response.json.usage === "object"
      ? {
          promptTokens: Number.isSafeInteger(response.json.usage.prompt_tokens) ? response.json.usage.prompt_tokens : null,
          completionTokens: Number.isSafeInteger(response.json.usage.completion_tokens) ? response.json.usage.completion_tokens : null
        }
      : null
  };
}

/** A rough, conservative token estimate for budgeting a small context window. */
export function estimateTokens(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return Math.ceil(text.length / 3.2);
}
