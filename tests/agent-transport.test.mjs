import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { chatCompletion, listModels, stripReasoning, toolCallsFromContent } from "../server/llm-client.mjs";
import { parseServiceUrl } from "../server/network.mjs";
import { performOutboundJsonRequest } from "../server/outbound-json.mjs";

const TOOLS = [
  { type: "function", function: { name: "overview", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "service_status", parameters: { type: "object", properties: { name: { type: "string" } } } } }
];

function reply(message, status = 200) {
  return async () => ({ status, json: status === 200 ? { choices: [{ message, finish_reason: "stop" }] } : null });
}

test("chat completions read standard tool calls and ignore unknown tools", async () => {
  const result = await chatCompletion(reply({
    role: "assistant",
    content: null,
    tool_calls: [
      { id: "a", type: "function", function: { name: "service_status", arguments: "{\"name\":\"sonarr\"}" } },
      { id: "b", type: "function", function: { name: "delete_everything", arguments: "{}" } },
      { id: "c", type: "function", function: { name: "overview", arguments: "not json" } }
    ]
  }), { model: "qwen2.5:3b", messages: [], tools: TOOLS });
  assert.deepEqual(result.toolCalls, [{ id: "a", name: "service_status", arguments: { name: "sonarr" } }]);
});

test("tool calls written as text by small models are recognised only for known tools", () => {
  assert.deepEqual(toolCallsFromContent("<tool_call>{\"name\":\"overview\",\"arguments\":{}}</tool_call>", ["overview"]), [
    { id: "text-1", name: "overview", arguments: {} }
  ]);
  assert.deepEqual(toolCallsFromContent("```json\n{\"name\": \"service_status\", \"arguments\": {\"name\": \"radarr\"}}\n```", ["service_status"])[0].arguments, { name: "radarr" });
  assert.deepEqual(toolCallsFromContent("{\"name\":\"shell\",\"arguments\":{\"cmd\":\"rm -rf /\"}}", ["overview"]), []);
  assert.deepEqual(toolCallsFromContent("Everything is healthy.", ["overview"]), []);
});

test("reasoning blocks are removed from answers", async () => {
  assert.equal(stripReasoning("<think>long reasoning</think>\nSonarr is down."), "Sonarr is down.");
  const result = await chatCompletion(reply({ role: "assistant", content: "<think>x</think>All healthy." }), { model: "m", messages: [] });
  assert.equal(result.content, "All healthy.");
});

test("model server errors become clear messages", async () => {
  await assert.rejects(chatCompletion(reply(null, 404), { model: "qwen2.5:3b", messages: [] }), { code: "MODEL_NOT_FOUND" });
  await assert.rejects(chatCompletion(reply(null, 401), { model: "qwen2.5:3b", messages: [] }), { code: "MODEL_SERVER_AUTH_REJECTED" });
  await assert.rejects(chatCompletion(reply(null, 500), { model: "qwen2.5:3b", messages: [] }), { code: "MODEL_REQUEST_FAILED" });
  await assert.rejects(chatCompletion(reply({}), { model: "../etc", messages: [] }), { code: "MODEL_NOT_CONFIGURED" });
  await assert.rejects(listModels(async () => ({ status: 200, json: { models: [] } })), { code: "MODEL_SERVER_INCOMPATIBLE" });
  assert.deepEqual(await listModels(async () => ({ status: 200, json: { data: [{ id: "b" }, { id: "a" }, { id: "bad id!" }, { id: "a" }] } })), ["a", "b"]);
});

async function server(t, handler) {
  const instance = http.createServer(handler);
  await new Promise((resolve) => instance.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => instance.close(resolve)));
  const { port } = instance.address();
  const target = parseServiceUrl(`http://model.test:${port}/base`);
  return { targetResolution: { target, addresses: [{ address: "127.0.0.1", family: 4 }], pinned: { address: "127.0.0.1", family: 4 } } };
}

test("outbound requests are pinned, carry the bearer token, and send JSON", async (t) => {
  const seen = [];
  const { targetResolution } = await server(t, (request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      seen.push({ url: request.url, host: request.headers.host, authorization: request.headers.authorization, body, cookie: request.headers.cookie });
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ ok: true }));
    });
  });
  const result = await performOutboundJsonRequest({ targetResolution, method: "POST", path: "/v1/chat/completions", body: { a: 1 }, bearerToken: "secret" });
  assert.deepEqual(result.json, { ok: true });
  assert.equal(seen[0].url, "/base/v1/chat/completions");
  assert.match(seen[0].host, /^model\.test:\d+$/u, "the request keeps the configured hostname while connecting to the pinned address");
  assert.equal(seen[0].authorization, "Bearer secret");
  assert.equal(seen[0].body, "{\"a\":1}");
  assert.equal(seen[0].cookie, undefined);
});

test("outbound requests reject redirects, web pages, oversized and compressed answers", async (t) => {
  let mode = "redirect";
  const { targetResolution } = await server(t, (_request, response) => {
    if (mode === "redirect") {
      response.statusCode = 302;
      response.setHeader("Location", "http://169.254.169.254/");
      response.end();
    } else if (mode === "html") {
      response.setHeader("Content-Type", "text/html");
      response.end("<!doctype html><title>login</title>");
    } else if (mode === "large") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ data: "x".repeat(4_000) }));
    } else if (mode === "gzip") {
      response.setHeader("Content-Encoding", "gzip");
      response.end("x");
    } else {
      response.statusCode = 503;
      response.end("down");
    }
  });
  const call = () => performOutboundJsonRequest({ targetResolution, path: "/v1/models", maxResponseBytes: 2_048 });
  await assert.rejects(call(), { code: "UPSTREAM_REDIRECT_REJECTED" });
  mode = "html";
  await assert.rejects(call(), { code: "UPSTREAM_CONTENT_REJECTED" });
  mode = "large";
  await assert.rejects(call(), { code: "UPSTREAM_RESPONSE_TOO_LARGE" });
  mode = "gzip";
  await assert.rejects(call(), { code: "UPSTREAM_CONTENT_REJECTED" });
  mode = "error";
  assert.deepEqual(await call(), { status: 503, json: null, bytes: 0 });
});

test("outbound requests time out and only allow fixed safe paths", async (t) => {
  const { targetResolution } = await server(t, () => {});
  await assert.rejects(performOutboundJsonRequest({ targetResolution, path: "/v1/models", timeoutMs: 300 }), { code: "UPSTREAM_TIMEOUT" });
  for (const path of ["v1/models", "/v1/../admin", "//evil", "/v1/models?x=1", "/v1/%2e%2e"]) {
    await assert.rejects(performOutboundJsonRequest({ targetResolution, path }), { code: "INVALID_PATH" }, path);
  }
});
