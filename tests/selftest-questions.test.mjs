import assert from "node:assert/strict";
import test from "node:test";

import { workloadNames } from "../server/agent-tools.mjs";
import { CATEGORIES, generateQuestions } from "../server/selftest-questions.mjs";
import { labSnapshot } from "./helpers/lab-fixture.mjs";

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

test("the same seed gives the same questions", () => {
  const a = generateQuestions(labSnapshot(), { seed: 7, count: 40 });
  const b = generateQuestions(labSnapshot(), { seed: 7, count: 40 });
  assert.deepEqual(a, b);
  assert.equal(a.length, 40);
  for (const question of a) {
    assert.match(question.id, /^q-[0-9a-f]{12}$/u);
    assert.ok(CATEGORIES.includes(question.category));
    assert.equal(typeof question.followUp, "boolean");
  }
  const c = generateQuestions(labSnapshot(), { seed: 8, count: 40 });
  assert.notDeepEqual(a.map((q) => q.id), c.map((q) => q.id), "a different seed gives a different order");
});

test("exclude removes asked ids and never repeats within a batch", () => {
  const first = generateQuestions(labSnapshot(), { seed: 3, count: 60 });
  assert.equal(new Set(first.map((q) => q.id)).size, first.length, "no duplicate ids");
  const exclude = new Set(first.slice(0, 30).map((q) => q.id));
  const next = generateQuestions(labSnapshot(), { seed: 3, count: 60, exclude });
  assert.equal(new Set(next.map((q) => q.id)).size, next.length);
  for (const question of next) assert.equal(exclude.has(question.id), false);
});

test("every category produces a question for the fixture lab", () => {
  const seen = new Set(generateQuestions(labSnapshot(), { count: 500 }).map((q) => q.category));
  for (const category of CATEGORIES) assert.ok(seen.has(category), `missing ${category}`);
});

test("a follow-up directly follows its base question and is marked followUp", () => {
  const questions = generateQuestions(labSnapshot(), { seed: 5, count: 500 });
  const followUps = questions.filter((q) => q.followUp);
  assert.ok(followUps.length > 0);
  questions.forEach((question, index) => {
    if (!question.followUp) return;
    assert.ok(index > 0 && questions[index - 1].followUp === false, "preceded by a base question");
    assert.equal(question.category, "follow-up");
  });
  const small = generateQuestions(labSnapshot(), { seed: 5, count: 11 });
  assert.ok(small.length <= 11);
  if (small[0]) assert.equal(small[0].followUp, false);
});

test("questions are plain text under 1,000 characters", () => {
  const hostile = labSnapshot();
  const workloads = hostile.infrastructure.environments[0].workloads;
  workloads.push({ vmid: 300, name: "x".repeat(2000), type: "lxc", node: "Main", status: "running" });
  workloads.push({ vmid: 301, name: 'a "quoted" | name\n\u0007\u0085end', type: "qemu", node: "norco", status: "running" });
  for (const snapshot of [labSnapshot(), hostile]) {
    const questions = generateQuestions(snapshot, { count: 500 });
    assert.ok(questions.length > 0);
    for (const question of questions) {
      assert.ok(question.text.length > 0 && question.text.length <= 1000, question.text.slice(0, 40));
      assert.equal(CONTROL.test(question.text), false, JSON.stringify(question.text.slice(0, 80)));
    }
  }
});

test("guests that share a name are asked about by VMID", () => {
  const questions = generateQuestions(labSnapshot(), { count: 500 });
  assert.ok(questions.some((q) => /VM 109/u.test(q.text)));
  assert.ok(questions.some((q) => /VM 201/u.test(q.text)));
  const backups = questions.filter((q) => q.category === "backups" && /docker/iu.test(q.text));
  assert.ok(backups.length > 0);
  for (const question of backups) assert.match(question.text, /VM (109|201)/u, question.text);
  for (const question of questions.filter((q) => /\bdocker\b/iu.test(q.text) && !/Main Docker/u.test(q.text))) {
    assert.match(question.text, /(VM|LXC) (109|201)|docker (host|container|stack|image)/iu, question.text);
  }
});

test("unknowable questions name only things Helmsman does not hold", () => {
  const snapshot = labSnapshot();
  const questions = generateQuestions(snapshot, { count: 500 }).filter((q) => q.category === "unknowable");
  assert.ok(questions.length > 0);
  const names = [...new Set([...workloadNames(snapshot), "Seerr", "Portainer", "Main Docker", "arr"])];
  for (const question of questions) {
    assert.match(question.text, /snapshot|storage|capacity|nas|ipv6|mount|peak/iu, question.text);
    for (const name of names) assert.equal(question.text.toLowerCase().includes(name.toLowerCase()), false, `${name} in ${question.text}`);
  }
});

test("an empty inventory yields no questions", () => {
  assert.deepEqual(generateQuestions({}), []);
  assert.deepEqual(generateQuestions({ infrastructure: {} }, { count: 50 }), []);
  assert.deepEqual(generateQuestions(null), []);
});

test("a malformed portainer section never throws and yields no container questions", () => {
  const baseline = generateQuestions(labSnapshot(), { count: 500 });
  const containerNames = /radarr|suggestarr|aliasvault|Jelly-Arr container|Main Docker/u;
  for (const portainer of [[null], {}, [{ inventory: null }], [{ inventory: { containers: { a: 1 } } }], [{ inventory: { containers: [null, 5] } }]]) {
    const snapshot = labSnapshot();
    snapshot.infrastructure.portainer = portainer;
    let questions;
    assert.doesNotThrow(() => { questions = generateQuestions(snapshot, { count: 500 }); }, JSON.stringify(portainer));
    assert.ok(questions.length > 0);
    assert.ok(questions.some((q) => q.category === "guest-lookup"), "other questions remain");
    assert.equal(questions.some((q) => q.category === "containers" || /same host|docker host/iu.test(q.text) && q.category === "neighbours"), false, JSON.stringify(portainer));
    assert.equal(questions.some((q) => containerNames.test(q.text) && q.category !== "guest-lookup" && q.category !== "backups" && q.category !== "neighbours" && q.category !== "manual" && q.category !== "follow-up"), false);
    assert.ok(questions.length < baseline.length);
  }
});
