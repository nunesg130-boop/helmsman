import assert from "node:assert/strict";
import test from "node:test";

import { listModelDetails } from "../server/llm-client.mjs";

test("Ollama's model list gives each model's size and quantization, matched with or without :latest", async () => {
  const send = async (method, path) => {
    assert.equal(method, "GET");
    assert.equal(path, "/api/tags");
    return { status: 200, json: { models: [
      { name: "helmsman-qwen3-v2:latest", size: 2_497_293_918, details: { quantization_level: "Q4_K_M" } },
      { name: "qwen2.5:3b", size: 1_929_912_432, details: { quantization_level: "Q4_K_M" } },
      { name: "bad name!", size: 1 },
      { name: "odd", size: -4, details: { quantization_level: "<script>" } }
    ] } };
  };
  const details = await listModelDetails(send);
  assert.deepEqual(details["helmsman-qwen3-v2"], { sizeBytes: 2_497_293_918, quantization: "Q4_K_M" });
  assert.deepEqual(details["helmsman-qwen3-v2:latest"], details["helmsman-qwen3-v2"]);
  assert.deepEqual(details["qwen2.5:3b"], { sizeBytes: 1_929_912_432, quantization: "Q4_K_M" });
  assert.deepEqual(details.odd, { sizeBytes: null, quantization: null }, "bad values are dropped");
  assert.equal(details["bad name!"], undefined);
});

test("a server that isn't Ollama, or fails, gives no details and no error", async () => {
  assert.deepEqual(await listModelDetails(async () => ({ status: 404, json: null })), {});
  assert.deepEqual(await listModelDetails(async () => { throw new Error("refused"); }), {});
});
