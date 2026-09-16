import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (path) => readFileSync(join(root, path), "utf8");

const packageJson = JSON.parse(read("package.json"));
assert.equal(packageJson.version, "1.0.0-beta.1", "the public beta must use the selected SemVer");
assert.equal(packageJson.license, "AGPL-3.0-only", "package metadata must declare the source license");
assert.equal(packageJson.private, true, "the package must remain protected from accidental npm publication");
assert.equal(packageJson.repository?.url, "https://github.com/nunesg130-boop/helmsman.git");

for (const required of [
  "LICENSE",
  "CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md",
  "SECURITY.md",
  "SUPPORT.md",
  "PUBLIC_RELEASE_CHECKLIST.md",
  "assets/services/THIRD_PARTY_NOTICES.md",
  ".github/CODEOWNERS",
  ".github/PULL_REQUEST_TEMPLATE.md",
  ".github/ISSUE_TEMPLATE/bug_report.yml",
  ".github/ISSUE_TEMPLATE/feature_request.yml",
  ".github/dependabot.yml",
  ".github/workflows/codeql.yml"
]) {
  assert.ok(statSync(join(root, required)).isFile(), `${required} must ship in a public release`);
}

const license = read("LICENSE");
assert.match(license, /GNU AFFERO GENERAL PUBLIC LICENSE/u);
assert.match(license, /Version 3, 19 November 2007/u);

const textExtensions = new Set([
  "", ".cjs", ".cmd", ".conf", ".css", ".env", ".example", ".html", ".ini", ".js",
  ".json", ".md", ".mjs", ".ps1", ".sh", ".svg", ".txt", ".webmanifest", ".yaml", ".yml"
]);
const skipDirectories = new Set([".git", "node_modules"]);

function textFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error(`public release cannot contain a symlink: ${join(directory, entry.name)}`);
    if (entry.isDirectory()) {
      if (!skipDirectories.has(entry.name)) files.push(...textFiles(join(directory, entry.name)));
      continue;
    }
    if (entry.isFile() && textExtensions.has(extname(entry.name).toLowerCase())) files.push(join(directory, entry.name));
  }
  return files;
}

const prohibited = [
  ["personal author name", /Gabriel\s+Nunes/iu],
  ["personalized root SSH target", /root@192[.]168[.]0[.]7/iu],
  ["real-derived primary Proxmox address", /192[.]168[.]0[.]4(?=[:/\s"'`]|$)/u],
  ["real-derived secondary Proxmox address", /192[.]168[.]0[.]5(?=[:/\s"'`]|$)/u],
  ["real-derived media host address", /192[.]168[.]0[.]7(?=[:/\s"'`]|$)/u],
  ["real-derived request host address", /192[.]168[.]0[.]104(?=[:/\s"'`]|$)/u],
  ["real-derived node name", /\bunitrend\b/iu],
  ["real-derived backup name", /\bMain-Backups\b/u],
  ["real-derived workload name", /\bJelly-Arr\b/u],
  ["copied media fixture", /President Curtis|11893146|tt43716930/iu],
  ["obsolete private-only release guidance", /Start with a private repository/iu]
];

for (const file of textFiles(root)) {
  const path = relative(root, file).replaceAll("\\", "/");
  if (path === "scripts/public-release-contract.mjs") continue;
  const source = readFileSync(file, "utf8");
  for (const [label, pattern] of prohibited) {
    assert.doesNotMatch(source, pattern, `${path} contains ${label}`);
  }
}

const permittedBinaryFiles = new Set([
  "assets/helmsman-logo.png",
  "assets/icon-192.png",
  "assets/icon-512.png",
  "assets/icon-maskable-512.png"
]);
function inspectPublicFiles(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (skipDirectories.has(entry.name)) continue;
    const fullPath = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`public release cannot contain a symlink: ${fullPath}`);
    if (entry.isDirectory()) {
      inspectPublicFiles(fullPath);
      continue;
    }
    const path = relative(root, fullPath).replaceAll("\\", "/");
    const extension = extname(entry.name).toLowerCase();
    assert.ok(
      textExtensions.has(extension) || permittedBinaryFiles.has(path),
      `${path} is an unreviewed binary or archive type`
    );
  }
}
inspectPublicFiles(root);

const serviceAssets = readdirSync(join(root, "assets/services")).sort();
assert.deepEqual(serviceAssets, ["THIRD_PARTY_NOTICES.md"], "public source must not bundle unverified third-party service artwork");
for (const workloadAsset of ["assets/workloads/vm.svg", "assets/workloads/container.svg"]) {
  const source = read(workloadAsset);
  assert.match(source, /^<svg\b/u);
  assert.doesNotMatch(source, /<(?:script|foreignObject|iframe|object|embed|image)\b|\son[a-z]+\s*=|(?:href|src)\s*=/iu);
}

const workflow = read(".github/workflows/container.yml");
assert.doesNotMatch(workflow, /pull_request_target\s*:/u, "untrusted PR code must not run with base-repository trust");
assert.match(workflow, /permissions:\s*\n\s+contents:\s*read/u, "workflow permissions must default to read only");
for (const line of workflow.split(/\r?\n/u)) {
  const match = line.match(/^\s*uses:\s*([^#\s]+)(?:\s*#.*)?$/u);
  if (!match) continue;
  assert.match(match[1], /@[0-9a-f]{40}$/u, `GitHub Action must be pinned to a full commit: ${match[1]}`);
}

const dockerfile = read("Dockerfile");
assert.match(dockerfile, /org[.]opencontainers[.]image[.]licenses="AGPL-3[.]0-only"/u);
assert.match(dockerfile, /COPY[^\n]*LICENSE/u, "the container must carry the project license");

const publisher = read("scripts/Publish-HelmsmanRelease.ps1");
const launcher = read("Publish-Helmsman.ps1");
assert.doesNotMatch(publisher, /The Jellyfin server was not changed/iu);
assert.doesNotMatch(publisher, /root@192[.]168[.]0[.]7/u);
for (const [name, source] of [["launcher", launcher], ["publisher", publisher]]) {
  assert.doesNotMatch(source, /SkipLocalTests|Invoke-LocalTestsIfAvailable|npm[.]cmd|Get-LocalTestDecision/u, `${name} must not execute candidate release code with maintainer credentials available`);
}

console.log("Public release contract: PASS");
