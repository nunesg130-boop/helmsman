import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (path) => readFileSync(join(root, path), "utf8");

const serviceIconAssets = Object.freeze([
  Object.freeze({ service: "Bazarr", file: "bazarr.png", width: 200, height: 200, hash: "aefd3aac28d67fd4d48b24dd2ae33b3b0a9f26e7950c2e1d34bef98cecf18876", format: "png" }),
  Object.freeze({ service: "Jellyfin", file: "jellyfin.svg", width: 512, height: 512, hash: "7f53cf083dbb3119ec8c5acbd8049c5033227617e461540f70591ac109124306", format: "svg", viewBox: "0 0 512 512", auditedInlineStyle: true }),
  Object.freeze({ service: "Portainer", file: "portainer.svg", width: 168.18, height: 218.62, hash: "5d1e07021683d15ea67225c60975729f4ee0ed380f3a0fb21ffb2ad00eb6e85b", format: "svg", viewBox: "0.72 0 168.18 218.62" }),
  Object.freeze({ service: "Prowlarr", file: "prowlarr.png", width: 460, height: 460, hash: "fe75eafc608e288c9736b740afe1c30c715eaf56dc284fec1926491d245fea52", format: "png" }),
  Object.freeze({ service: "Proxmox", file: "proxmox.png", width: 595, height: 516, hash: "c8dca83af2f6519f025aad6325cc702ad491b19727bae42b9b87b6d20fa13440", format: "png" }),
  Object.freeze({ service: "qBittorrent", file: "qbittorrent.svg", width: 1024, height: 1024, hash: "f96f40f70830e245cc184291d1173aa705b68b0865970b44aa1ee63350bcb9c2", format: "svg", viewBox: "0 0 1024 1024" }),
  Object.freeze({ service: "Radarr", file: "radarr.svg", width: 512, height: 512, hash: "4767088c158c5507957232782f491ad1c3a048c013ce04d58da81148158a89b3", format: "svg", viewBox: "0 0 512 512", auditedInlineStyle: true }),
  Object.freeze({ service: "Seerr", file: "seerr.svg", width: 96, height: 96, hash: "b12e5dfd641d961cfb68360da33fe28873b95ea9b64c23233d5b87a37cbfa4c4", format: "svg", viewBox: "0 0 96 96", auditedStyleElement: true }),
  Object.freeze({ service: "Sonarr", file: "sonarr.svg", width: 512, height: 512, hash: "a5debe565281eb16b746d75b9ce72e22f2fb15c19b4f55428fdf62b84be79306", format: "svg", viewBox: "0 0 512 512", auditedInlineStyle: true })
]);
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function jpegDimensions(contents) {
  if (contents.byteLength < 4 || contents[0] !== 0xff || contents[1] !== 0xd8) return null;
  const startOfFrameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 3 < contents.byteLength) {
    if (contents[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (offset < contents.byteLength && contents[offset] === 0xff) offset += 1;
    const marker = contents[offset];
    offset += 1;
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= contents.byteLength) return null;
    const length = contents.readUInt16BE(offset);
    if (length < 2 || offset + length > contents.byteLength) return null;
    if (startOfFrameMarkers.has(marker) && length >= 7) {
      return { height: contents.readUInt16BE(offset + 3), width: contents.readUInt16BE(offset + 5) };
    }
    offset += length;
  }
  return null;
}

const packageJson = JSON.parse(read("package.json"));
assert.equal(packageJson.version, "1.1.1", "the public release must use the selected SemVer");
assert.equal(packageJson.license, "AGPL-3.0-only", "package metadata must declare the source license");
assert.equal(packageJson.private, true, "the package must remain protected from accidental npm publication");
assert.equal(packageJson.repository?.url, "https://github.com/nunesg130-boop/helmsman.git");

const readme = read("README.md");
const securityPolicy = read("SECURITY.md");
const deploymentGuide = read("deploy/DOCKER.md");
const browserAccessDocumentation = `${readme}\n${securityPolicy}\n${deploymentGuide}`;
assert.match(readme, /^# Helmsman v1[.]1[.]1$/mu, "the public README must identify the stable release");
assert.match(readme, /`v1[.]1[.]1` Git tag[\s\S]*?version, `latest`, and full-commit image tags/iu);
assert.match(readme, /## v1[.]1[.]0[\s\S]*?built-in Helmsman journal[\s\S]*?Loki Explorer/iu);
assert.doesNotMatch(readme, /unreleased logging preview|Logging development preview/iu);
assert.match(browserAccessDocumentation, /exact (?:enabled )?Jellyfin administrator/iu);
assert.match(browserAccessDocumentation, /username and password/iu);
assert.match(browserAccessDocumentation, /server ID and user ID[\s\S]{0,160}(?:never requested|never asks)/iu);
assert.match(browserAccessDocumentation, /30-day[\s\S]{0,160}HttpOnly/iu);
assert.match(browserAccessDocumentation, /monitoring connector[\s\S]{0,160}(?:distinct|separate)/iu);
assert.match(browserAccessDocumentation, /Authentik[\s\S]{0,200}(?:external MFA|MFA layer)/iu);
assert.match(browserAccessDocumentation, /Jellyfin is unreachable[\s\S]{0,240}read-only[\s\S]{0,180}(?:writes|state-changing actions)[\s\S]{0,100}(?:fail closed|fresh validation)/iu);
assert.match(browserAccessDocumentation, /v1[.]0[.]0-beta[.]2[\s\S]{0,240}(?:temporar|only long enough)[\s\S]{0,260}(?:removes|removed)/iu);
assert.match(browserAccessDocumentation, /reset-access --confirm/u);
assert.doesNotMatch(browserAccessDocumentation, /rotate-access-key --confirm/u, "the removed access-key recovery command must not ship in public documentation");

for (const required of [
  "LICENSE",
  "CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md",
  "SECURITY.md",
  "SUPPORT.md",
  "PUBLIC_RELEASE_CHECKLIST.md",
  "assets/services/THIRD_PARTY_NOTICES.md",
  "assets/services/bazarr.png",
  "assets/services/jellyfin.svg",
  "assets/services/portainer.svg",
  "assets/services/prowlarr.png",
  "assets/services/proxmox.png",
  "assets/services/qbittorrent.svg",
  "assets/services/radarr.svg",
  "assets/services/seerr.svg",
  "assets/services/sonarr.svg",
  "assets/services/licenses/GPL-2.0.txt",
  "assets/services/licenses/GPL-3.0.txt",
  "assets/services/licenses/MIT-Seerr.txt",
  "assets/services/licenses/Zlib-Portainer.txt",
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

// Keep these checks generic. A public-release test must not preserve private
// names, addresses, or deployment identifiers merely to deny-list them.
const prohibited = [
  ["embedded private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u],
  ["GitHub personal access token", /\b(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,})\b/u],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/u],
  ["privileged SSH target on a private address", /\b(?:root|admin)@(?:10(?:[.]\d{1,3}){3}|192[.]168(?:[.]\d{1,3}){2}|172[.](?:1[6-9]|2\d|3[01])(?:[.]\d{1,3}){2})\b/u],
  ["credential-bearing URL", /\bhttps?:\/\/[^\/\s:@"']+:[^\/\s@"']+@/iu],
  ["operator-specific home path", /(?:[A-Za-z]:\\Users\\(?!Public\\)[^\\\s"'`]+\\|\/(?:home|Users)\/(?!example\/|user\/|Shared\/)[^\/\s"'`]+\/)/u]
];

for (const file of textFiles(root)) {
  const path = relative(root, file).replaceAll("\\", "/");
  const source = readFileSync(file, "utf8");
  for (const [label, pattern] of prohibited) {
    assert.doesNotMatch(source, pattern, `${path} contains ${label}`);
  }
}

const permittedBinaryFiles = new Set([
  "assets/helmsman-logo.png",
  "assets/icon-192.png",
  "assets/icon-512.png",
  "assets/icon-maskable-512.png",
  "assets/services/bazarr.png",
  "assets/services/prowlarr.png",
  "assets/services/proxmox.png",
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
assert.deepEqual(
  serviceAssets,
  [
    "THIRD_PARTY_NOTICES.md",
    "bazarr.png",
    "jellyfin.svg",
    "licenses",
    "portainer.svg",
    "prowlarr.png",
    "proxmox.png",
    "qbittorrent.svg",
    "radarr.svg",
    "seerr.svg",
    "sonarr.svg"
  ],
  "public source must contain exactly the reviewed nine-icon service inventory and its notices"
);
assert.deepEqual(
  readdirSync(join(root, "assets/services/licenses")).sort(),
  ["GPL-2.0.txt", "GPL-3.0.txt", "MIT-Seerr.txt", "Zlib-Portainer.txt"],
  "public source must carry exactly the reviewed third-party license notices"
);
assert.match(read("assets/services/licenses/GPL-2.0.txt"), /GNU GENERAL PUBLIC LICENSE\s+Version 2, June 1991/u);
assert.match(read("assets/services/licenses/GPL-3.0.txt"), /GNU GENERAL PUBLIC LICENSE\s+Version 3, 29 June 2007/u);
assert.match(read("assets/services/licenses/MIT-Seerr.txt"), /Copyright \(c\) 2020 sct[\s\S]*Permission is hereby granted/u);
assert.match(read("assets/services/licenses/Zlib-Portainer.txt"), /Copyright \(c\) 2018 Portainer[.]io[\s\S]*This notice may not be removed or altered/u);
for (const asset of serviceIconAssets) {
  const iconPath = join(root, "assets/services", asset.file);
  const contents = readFileSync(iconPath);
  const digest = createHash("sha256").update(contents).digest("hex");
  assert.equal(digest, asset.hash, `${asset.file} must remain the exact reviewed file`);
  if (asset.format === "png") {
    assert.ok(contents.subarray(0, 8).equals(pngSignature), `${asset.file} must remain a PNG`);
    assert.equal(contents.readUInt32BE(16), asset.width, `${asset.file} width must remain pinned`);
    assert.equal(contents.readUInt32BE(20), asset.height, `${asset.file} height must remain pinned`);
  } else if (asset.format === "jpeg") {
    assert.deepEqual(jpegDimensions(contents), { width: asset.width, height: asset.height }, `${asset.file} must remain the pinned JPEG`);
  } else {
    const svg = contents.toString("utf8");
    assert.match(svg, /^\s*(?:<\?xml[^>]*>\s*)?<svg\b/u, `${asset.file} must remain an SVG document`);
    assert.match(svg, new RegExp(`viewBox="${asset.viewBox.replaceAll(".", "[.]")}"`, "u"), `${asset.file} viewBox must remain pinned`);
    assert.doesNotMatch(
      svg,
      /<!DOCTYPE|<!ENTITY|<(?:script|foreignObject|iframe|object|embed|image|audio|video)\b|\son[a-z][a-z0-9_-]*\s*=|(?:href|src)\s*=\s*["'](?!#)|@import\b|url\(\s*["']?(?!#)/iu,
      `${asset.file} must remain inert and self-contained`
    );
    const hasInlineStyle = /\sstyle\s*=/iu.test(svg);
    assert.equal(hasInlineStyle, Boolean(asset.auditedInlineStyle), `${asset.file} inline-style policy must remain pinned`);
    const hasStyleElement = /<style\b/iu.test(svg);
    assert.equal(hasStyleElement, Boolean(asset.auditedStyleElement), `${asset.file} style-element policy must remain pinned`);
  }
}
const artworkNotices = read("assets/services/THIRD_PARTY_NOTICES.md");
for (const asset of serviceIconAssets) {
  assert.ok(artworkNotices.includes(`| ${asset.service} |`), `${asset.service} must appear in the reviewed icon inventory`);
  assert.ok(artworkNotices.includes(`assets/services/${asset.file}`), `${asset.file} must be identified in the notices`);
  assert.ok(artworkNotices.includes(asset.hash), `${asset.file} hash must be pinned in the notices`);
}
assert.match(artworkNotices, /(?:only to identify\s+compatible third-party integrations|for referential\s+connector identification)/iu, "service icons must be limited to referential identification");
assert.match(artworkNotices, /No service owner sponsors, endorses, or is affiliated\s+with Helmsman/iu, "the service-owner non-affiliation boundary must ship");
assert.match(artworkNotices, /https:\/\/www[.]proxmox[.]com\//u, "the required official Proxmox mark destination must be documented");
assert.match(artworkNotices, /Box vector created by Freepik - www[.]freepik[.]com/u, "the Prowlarr/Freepik credit must ship verbatim");
assert.match(artworkNotices, /GNU General Public License\s+version 3/iu, "the Prowlarr GPLv3 basis must be documented");
assert.match(artworkNotices, /4561859c2b3e8edf5ffab994f72ec8f97aca8c53/u, "the Prowlarr source references must be commit-pinned");
assert.match(artworkNotices, /Neither Prowlarr, its\s+contributors, nor Freepik sponsors, endorses, or is\s+affiliated with Helmsman/iu, "the Prowlarr non-affiliation notice must ship");
assert.match(artworkNotices, /used only for referential identification\s+of the third-party\s+Prowlarr connector/iu, "the Prowlarr icon purpose must remain limited to connector identification");
assert.match(artworkNotices, /Creative Commons Attribution-ShareAlike 4[.]0/iu, "the Jellyfin CC BY-SA basis must ship");
assert.match(artworkNotices, /minification is the\s+only known representational change/iu, "the Jellyfin serialization change must be documented");
assert.match(artworkNotices, /Copyright \(C\)[\s\S]*2014-2017 Mark McDowall, Keivan Beigi, Taloth Saldono and contributors/u, "the Sonarr copyright notice must ship");
assert.match(artworkNotices, /copyright: Provided by HVS <hvs linuxmail org> \(raster first proposal\) and Atif Afzal\(@atfzl github\)/u, "the qBittorrent artwork credit must ship verbatim");
assert.match(artworkNotices, /License: `GPL-2[.]0-or-later`/u, "the qBittorrent artwork license must be explicit");
assert.match(artworkNotices, /Every displayed\s+Proxmox logo links to the official Proxmox website[\s\S]*visually subordinate/iu, "the Proxmox media-kit presentation conditions must ship");
assert.match(artworkNotices, /March 5, 2026 rebrand announcement/iu, "the Portainer rebrand source must ship");
assert.match(artworkNotices, /has not been established as\s+byte-for-byte identical[\s\S]*does\s+not claim that repository license/iu, "the Portainer origin and license uncertainty must remain explicit");
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
assert.match(dockerfile, /COPY --chown=0:0 assets\/services\/licenses\/ [.]\/assets\/services\/licenses\//u, "the container must carry third-party license notices");

const publisher = read("scripts/Publish-HelmsmanRelease.ps1");
const launcher = read("Publish-Helmsman.ps1");
assert.doesNotMatch(publisher, /The Jellyfin server was not changed/iu);
for (const [name, source] of [["launcher", launcher], ["publisher", publisher]]) {
  assert.doesNotMatch(source, /SkipLocalTests|Invoke-LocalTestsIfAvailable|npm[.]cmd|Get-LocalTestDecision/u, `${name} must not execute candidate release code with maintainer credentials available`);
}

console.log("Public release contract: PASS");
