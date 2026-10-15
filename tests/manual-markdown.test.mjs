import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  MANUAL_STATE_GROUPS,
  MANUAL_TEMPLATE,
  manualSnippet,
  manualStateTone,
  parseManual,
  renderManualInline,
  searchManualEntries
} from "../src/ui/manual-markdown.js";

test("manual Markdown escapes raw HTML and unsafe links", () => {
  const html = renderManualInline("<img src=x onerror=alert(1)> **bold** `<b>` [ok](https://example.net) [bad](javascript:alert(1)) [mail](mailto:a@example.net)");
  for (const unsafe of ["<img", "<b>", "javascript:", "mailto:"]) {
    assert.equal(html.toLowerCase().includes(unsafe), false, `rendered HTML must not contain ${unsafe}`);
  }
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/u);
  assert.match(html, /<strong>bold<\/strong>/u);
  assert.match(html, /<code>&lt;b&gt;<\/code>/u);
  assert.match(html, /<a href="https:\/\/example\.net\/" target="_blank" rel="noopener noreferrer">ok<\/a>/u);
  const credentialLink = `[x](${["https://user", "secret@example.net"].join(":")})`; // assembled so the release scan sees no literal credential URL
  assert.match(renderManualInline(credentialLink), /^x$/u, "credentials in a link drop the link");
  assert.match(renderManualInline("[\"onmouseover=\"x](#a)"), /href="#a">&quot;onmouseover=&quot;x</u);
});

test("manual sections, tables, callouts and code are parsed into a searchable document", () => {
  const manual = parseManual([
    "# Homelab",
    "Intro <script>x</script>",
    "",
    "## Hosts",
    "| Host | IP | State |",
    "|---|---|---|",
    "| nvr | 10.20.0.42 | Pending |",
    "| media-node | 10.20.0.10 | Healthy — after recovery |",
    "",
    "> [!WARNING] Mount rule",
    "> Validate the UUID mount.",
    "",
    "```",
    "pvecm status <x>",
    "```",
    "",
    "## Hosts",
    "- [x] done"
  ].join("\n"));
  assert.equal(manual.title, "Homelab");
  assert.match(manual.intro.html, /Intro &lt;script&gt;x&lt;\/script&gt;/u);
  assert.deepEqual(manual.sections.map(({ id }) => id), ["manual-hosts", "manual-hosts-2"]);
  const [hosts] = manual.sections;
  assert.match(hosts.html, /<span class="manual-state is-warning"><i aria-hidden="true"><\/i>Pending<\/span>/u);
  assert.match(hosts.html, /manual-state is-healthy[^]*Healthy<\/span> after recovery/u);
  assert.match(hosts.html, /<aside class="manual-callout is-warning"[^>]*><strong class="manual-callout__label">Mount rule<\/strong>/u);
  assert.match(hosts.html, /<pre class="manual-code"[^>]*><code>pvecm status &lt;x&gt;<\/code><\/pre>/u);
  const allHtml = [manual.intro.html, ...manual.sections.map(({ html }) => html)].join("");
  assert.equal(allHtml.toLowerCase().includes("<script"), false, "rendered HTML never carries source markup");
  assert.equal(manual.entries.at(-1).text, "done", "task markers are not part of the search text");

  const results = searchManualEntries(manual.entries, "42");
  assert.equal(results[0].entry.kind, "row");
  assert.equal(results[0].entry.sectionTitle, "Hosts");
  const snippet = manualSnippet(results[0].entry.text, results[0].matchStart, results[0].matchLength);
  assert.equal(snippet.match, "42");
  assert.equal(searchManualEntries(manual.entries, "hosts")[0].entry.kind, "section");
  assert.deepEqual(searchManualEntries(manual.entries, "   "), []);
  assert.ok(searchManualEntries(manual.entries, "hosts uuid").length > 0, "a section title can satisfy part of the query");
});

test("state words map to fixed tones", () => {
  assert.equal(manualStateTone("Pending"), "warning");
  assert.equal(manualStateTone("**Healthy**"), "healthy");
  assert.equal(manualStateTone("Critical"), "danger");
  assert.equal(manualStateTone("Planned"), "neutral");
  assert.equal(manualStateTone("media-node"), null);
});

test("the starter template is generic and renders every block type", () => {
  const manual = parseManual(MANUAL_TEMPLATE);
  assert.equal(manual.title, "Homelab manual");
  assert.deepEqual(manual.sections.map(({ title }) => title), [
    "Hosts", "Network", "Services", "Storage and backups", "Runbooks", "Known issues", "Change log"
  ]);
  const html = manual.sections.map(({ html }) => html).join("");
  for (const fragment of ["manual-state is-healthy", "manual-state is-warning", "manual-callout is-warning", "manual-code", "manual-task", "<ol"]) {
    assert.ok(html.includes(fragment), `template renders ${fragment}`);
  }
  assert.ok(Buffer.byteLength(MANUAL_TEMPLATE) < 4096, "template stays small");
});

test("the formatting guide documents every badge word and renders in the Manual", async () => {
  const guide = await readFile(new URL("../docs/MANUAL-FORMAT.md", import.meta.url), "utf8");
  const colours = { healthy: "Green", warning: "Yellow", danger: "Red", info: "Blue", neutral: "Grey" };
  for (const [tone, words] of Object.entries(MANUAL_STATE_GROUPS)) {
    const row = guide.split("\n").find((line) => line.startsWith(`| ${colours[tone]} |`));
    assert.ok(row, `guide has a ${colours[tone]} row`);
    const listed = row.split("|")[2].split(",").map((word) => word.trim());
    assert.deepEqual(listed, [...words], `guide lists the ${tone} words exactly`);
  }
  const rendered = parseManual(guide);
  assert.equal(rendered.title, "Manual formatting guide");
  assert.ok(rendered.sections.length >= 8);
});
