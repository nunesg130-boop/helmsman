import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildLaunchpadCss, sanitizeCustomCss } from "../server/launchpad-theme.mjs";
import { validateLaunchpad } from "../server/launchpad-schema.mjs";
import { parseLaunchpadYaml } from "../server/yaml.mjs";

const EXAMPLE = validateLaunchpad(parseLaunchpadYaml(readFileSync(new URL("./fixtures/launchpad-spec-example.yaml", import.meta.url), "utf8"))).model;

test("tokens and tile accents become custom properties", () => {
  const css = buildLaunchpadCss(EXAMPLE);
  assert.match(css, /\.lp-root \{ --lp-accent: #7c5cff; --lp-radius: 14px; \}/u);
  assert.match(css, /\.lp-tile\[data-id="jellyfin"\] \{ --lp-tile-accent: #00a4dc; \}/u);
  assert.match(css, /backdrop-filter: blur\(20px\)/u, "custom CSS is appended");
  assert.ok(css.indexOf("backdrop-filter") > css.indexOf("--lp-tile-accent"), "custom CSS comes last so it can override");
});

test("an empty model gives an empty-but-valid stylesheet", () => {
  assert.equal(typeof buildLaunchpadCss({ version: 2, theme: { tokens: {}, css: "" }, pages: [] }), "string");
});

test("@import is removed", () => {
  assert.doesNotMatch(sanitizeCustomCss("@import url(https://evil.example/x.css);\na { color: red }"), /@import/iu);
  assert.doesNotMatch(sanitizeCustomCss("@IMPORT 'https://evil.example/x.css';"), /import/iu);
  assert.match(sanitizeCustomCss("@import url(x.css);\na { color: red }"), /a \{ color: red \}/u);
});

test("off-site url() is removed, same-origin and data: kept", () => {
  assert.doesNotMatch(sanitizeCustomCss("a { background: url(https://evil.example/x.png) }"), /evil/u);
  assert.doesNotMatch(sanitizeCustomCss("a { background: url( '//evil.example/x.png' ) }"), /evil/u);
  assert.doesNotMatch(sanitizeCustomCss("a { background: u\\72l(https://evil.example/x.png) }"), /evil/u, "escaped url( is caught");
  assert.match(sanitizeCustomCss("a { background: url(/api/v2/launchpad/icons/x) }"), /url\(\/api\/v2\/launchpad\/icons\/x\)/u);
  assert.match(sanitizeCustomCss("a { background: url(\"data:image/png;base64,AA==\") }"), /data:image\/png/u);
});

test("image-set() cannot load bare remote strings", () => {
  assert.doesNotMatch(sanitizeCustomCss("a { background-image: image-set(\"https://evil.example/x.png\" 1x) }"), /image-set\(/iu);
  assert.doesNotMatch(sanitizeCustomCss("a { background-image: -webkit-image-set('https://evil.example/x.png' 1x) }"), /image-set\(/iu);
});

test("expression() and closing tags are neutralized", () => {
  assert.doesNotMatch(sanitizeCustomCss("a { width: expression(alert(1)) }"), /expression\(/iu);
  assert.doesNotMatch(sanitizeCustomCss("a{}</style><script>x</script>"), /<\//u);
});
