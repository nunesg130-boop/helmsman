import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { emptyLaunchpadModel, validateLaunchpad } from "../server/launchpad-schema.mjs";
import { parseLaunchpadYaml } from "../server/yaml.mjs";

const EXAMPLE = readFileSync(new URL("./fixtures/launchpad-spec-example.yaml", import.meta.url), "utf8");
const UUID_A = "3f0c1d2e-4b5a-4c6d-8e7f-901234567890";
const UUID_B = "4a1b2c3d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

function check(text) {
  return validateLaunchpad(parseLaunchpadYaml(text));
}

function oneTile(tileYaml, { page = "", group = "" } = {}) {
  const indented = tileYaml.trim().split("\n").map((line) => `          ${line}`).join("\n");
  return `version: 2
pages:
  - id: home
    title: Home${page}
    groups:
      - id: g
        title: G${group}
        tiles:
${indented}
`;
}

const LINK = (extra = "", url = "https://x.example.net") => `- id: t
  type: link
  title: T
  url: ${url}
  layout: { desktop: { x: 0, y: 0, w: 2, h: 1 } }${extra ? `\n${extra}` : ""}`;

function errorsFor(text) {
  const { model, errors } = check(text);
  assert.equal(model, null, "an invalid document has no model");
  assert.ok(errors.length > 0, "expected errors");
  return errors;
}

test("spec example validates", () => {
  const { model, errors } = check(EXAMPLE);
  assert.deepEqual(errors, []);
  const tiles = model.pages[0].groups[0].tiles;
  assert.equal(tiles.length, 5);
  const jellyfin = tiles.find((tile) => tile.id === "jellyfin");
  assert.deepEqual(jellyfin.layout.phone, { x: 0, y: 0, w: 2, h: 1 });
  assert.deepEqual(jellyfin.managed, { kind: "media", id: "jellyfin" });
  const grafana = tiles.find((tile) => tile.id === "grafana-embed");
  assert.equal(grafana.layout.tablet, undefined);
  assert.equal(grafana.layout.phone, undefined);
  const router = tiles.find((tile) => tile.id === "router");
  assert.equal(router.links[0].url, "http://192.168.0.1/");
  assert.equal(model.pages[0].groups[0].collapsed, false);
  assert.equal(tiles.find((tile) => tile.id === "todo").visibility, "owner");
});

test("empty document is an empty launchpad", () => {
  for (const text of ["", "version: 2\n", "# just a comment\n"]) {
    const { model, errors } = check(text);
    assert.deepEqual(errors, [], text);
    assert.deepEqual(model, emptyLaunchpadModel());
  }
});

test("unknown key has path and line", () => {
  const errors = errorsFor(oneTile(LINK("  colour: red")));
  assert.equal(errors.length, 1);
  assert.equal(errors[0].path, "pages[0].groups[0].tiles[0].colour");
  assert.equal(errors[0].line, 14);
  assert.ok(errors[0].column > 0);
});

test("anchors and aliases are rejected", () => {
  const errors = errorsFor("version: 2\npages: &p []\ntheme: *p\n");
  assert.ok(errors.some((error) => error.message.includes("anchors and aliases are not supported")));

  let bomb = "a: &a [x, x, x, x, x, x, x, x, x]\n";
  for (let level = 1; level < 9; level += 1) {
    const previous = String.fromCharCode(96 + level);
    const current = String.fromCharCode(97 + level);
    bomb += `${current}: &${current} [${Array(9).fill(`*${previous}`).join(", ")}]\n`;
  }
  const started = Date.now();
  errorsFor(bomb);
  assert.ok(Date.now() - started < 100, "alias bomb is rejected without expansion");
});

test("url rules apply to links and folder links", () => {
  const rejected = [
    "javascript:alert(1)",
    "data:text/html,hi",
    "ftp://files.example.net",
    ["https://user", "secret@sonarr.example.net"].join(":"),
    `https://example.net/${"a".repeat(600)}`
  ];
  for (const url of rejected) {
    const errors = errorsFor(oneTile(LINK("", JSON.stringify(url))));
    assert.ok(errors.some((error) => error.path === "pages[0].groups[0].tiles[0].url"), url);
    const folder = `- id: f
  type: folder
  title: F
  links:
    - { title: A, url: ${JSON.stringify(url)} }
  layout: { desktop: { x: 0, y: 0, w: 2, h: 1 } }`;
    const folderErrors = errorsFor(oneTile(folder));
    assert.ok(folderErrors.some((error) => error.path === "pages[0].groups[0].tiles[0].links[0].url"), url);
  }
});

test("search engine templates", () => {
  const search = (engine) => oneTile(`- id: s
  type: search
  title: S
  engine: ${JSON.stringify(engine)}
  layout: { desktop: { x: 0, y: 0, w: 2, h: 1 } }`);
  assert.deepEqual(check(search("tiles")).errors, []);
  assert.deepEqual(check(search("https://x.example/?q={query}")).errors, []);
  for (const engine of ["http://x.example/?q={query}", "https://x.example/?q=", "https://x.example/{query}{query}"]) {
    errorsFor(search(engine));
  }
});

test("ids must be unique slugs", () => {
  const twoGroups = `version: 2
pages:
  - id: home
    title: Home
    groups:
      - id: a
        title: A
        tiles:
          - { id: t, type: note, title: N, markdown: hi, layout: { desktop: { x: 0, y: 0, w: 1, h: 1 } } }
      - id: b
        title: B
        tiles:
          - { id: t, type: note, title: N, markdown: hi, layout: { desktop: { x: 0, y: 0, w: 1, h: 1 } } }
`;
  assert.ok(errorsFor(twoGroups).some((error) => error.message.includes("unique")));
  errorsFor(oneTile(LINK().replace("id: t", "id: Bad_ID")));
});

test("layout rules", () => {
  errorsFor(oneTile(LINK().replace("layout: { desktop: { x: 0, y: 0, w: 2, h: 1 } }", "layout: { phone: { x: 0, y: 0, w: 2, h: 1 } }")));
  errorsFor(oneTile(LINK().replace("w: 2", "w: 13")));
  errorsFor(oneTile(LINK("").replace("h: 1 } }", "h: 1 }, phone: { x: 0, y: 0, w: 3, h: 1 } }")));
  errorsFor(oneTile(LINK().replace("h: 1", "h: 9")));
  errorsFor(oneTile(LINK().replace("x: 0, y: 0, w: 2", "x: 11, y: 0, w: 2")));
});

test("limits", () => {
  let pages = "version: 2\npages:\n";
  for (let index = 0; index < 21; index += 1) pages += `  - { id: p${index}, title: P, groups: [] }\n`;
  assert.ok(errorsFor(pages).some((error) => error.message.includes("20")));

  const links = Array.from({ length: 25 }, (_, index) => `    - { title: L${index}, url: "https://l${index}.example" }`).join("\n");
  errorsFor(oneTile(`- id: f
  type: folder
  title: F
  links:
${links}
  layout: { desktop: { x: 0, y: 0, w: 2, h: 1 } }`));

  errorsFor(oneTile(`- id: n
  type: note
  title: N
  markdown: ${"x".repeat(4097)}
  layout: { desktop: { x: 0, y: 0, w: 2, h: 1 } }`));
});

test("managed kinds", () => {
  const ok = [
    "{ kind: media, id: sonarr }",
    `{ kind: environment, id: ${UUID_A} }`,
    `{ kind: service, id: ${UUID_A} }`,
    `{ kind: container, service: ${UUID_A}, environment: 12, name: sonarr }`,
    `{ kind: workload, environment: ${UUID_B}, vmid: 109 }`
  ];
  for (const managed of ok) {
    const { errors, model } = check(oneTile(LINK(`  managed: ${managed}`)));
    assert.deepEqual(errors, [], managed);
    assert.equal(typeof model.pages[0].groups[0].tiles[0].managed.kind, "string");
  }
  for (const managed of [
    "{ kind: media, id: plex }",
    "{ kind: container, service: not-a-uuid, environment: 12, name: sonarr }",
    `{ kind: workload, environment: ${UUID_B}, vmid: -1 }`,
    `{ kind: workload, environment: ${UUID_B} }`
  ]) {
    errorsFor(oneTile(LINK(`  managed: ${managed}`)));
  }
  errorsFor(oneTile(`- id: i
  type: iframe
  title: I
  url: https://grafana.example
  managed: { kind: media, id: sonarr }
  layout: { desktop: { x: 0, y: 0, w: 2, h: 1 } }`));
});

test("reserved keys and values", () => {
  errorsFor(oneTile(LINK("  visibility: viewers")));
  const widget = errorsFor(oneTile(LINK("  widget: {}")));
  assert.ok(widget.some((error) => error.message.includes("reserved")));
});

test("theme rules", () => {
  const theme = (body) => `version: 2\ntheme:\n${body}\npages: []\n`;
  assert.deepEqual(check(theme("  tokens: { accent: \"#abc\", radius: 0, density: compact }")).errors, []);
  errorsFor(theme("  tokens: { radius: 33 }"));
  errorsFor(theme("  tokens: { density: huge }"));
  errorsFor(theme("  tokens: { accent: red }"));
  errorsFor(theme(`  css: ${JSON.stringify("a".repeat(32 * 1024 + 1))}`));
});

test("syntax errors carry a line", () => {
  const errors = errorsFor("version: 2\npages:\n  - id: [\n");
  assert.ok(errors[0].line > 0);
});
