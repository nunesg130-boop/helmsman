#!/usr/bin/env node
// Helmsman demo: the real Helmsman server, wired to built-in fake services.
//
//   npm run demo                 # http://127.0.0.1:4180, sign in as demo / demo
//   npm run demo -- --port 5000
//   npm run demo -- --data ./demo-data   # keep the data between runs
//
// Everything Helmsman normally does runs unchanged: setup, the Jellyfin owner
// sign-in, encrypted credentials, network policy, monitoring, the media model,
// Proxmox and Portainer inventory, the manual and the network map. Only the
// upstream services are fake. They answer from fixed, invented data in this
// process, so no network traffic leaves the machine.
//
// This is a development tool. It lives in scripts/, which the production
// container image does not include, and by default it only listens on
// loopback.
//
// Showcase mode (`--showcase`, or the separate demo image built from
// deploy/demo/Dockerfile) is for showing Helmsman to someone else: it listens on all
// interfaces, requires a non-default password, turns on the agent's container
// health, stuck-download and indexer policies, and keeps staging believable
// problems so there is always something for the agent to handle. It can also
// forward the agent's model calls to a real OpenAI-compatible model server
// (`--model-url`, `--model`). Nothing in it can reach real infrastructure:
// every upstream except that one model server is answered in this process.

import http from "node:http";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deflateSync } from "node:zlib";
import { createHash, randomUUID } from "node:crypto";
import { createBroker, createHttpServer } from "../server/broker.mjs";
import { MANUAL_TEMPLATE } from "../src/ui/manual-markdown.js";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEMO_USERNAME = "demo";
const DEFAULT_DEMO_PASSWORD = "demo";
const DEMO_SUBNET = "10.77.0.0/24";
const DAY = 86_400_000;
const MINUTE = 60_000;

// The owner password the fake Jellyfin accepts. Set by startDemo().
let demoPassword = DEFAULT_DEMO_PASSWORD;

// ---------------------------------------------------------------- options --

function envFlag(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

/**
 * Reads options from the command line, with HELMSMAN_DEMO_* environment
 * variables as defaults so the demo container can be configured from
 * compose. The password is best given through HELMSMAN_DEMO_PASSWORD so it
 * does not appear in the process list.
 */
export function parseArguments(argv, env = process.env) {
  const options = {
    port: env.HELMSMAN_DEMO_PORT ? Number(env.HELMSMAN_DEMO_PORT) : 4180,
    data: env.HELMSMAN_DEMO_DATA || null,
    showcase: envFlag(env.HELMSMAN_DEMO_SHOWCASE),
    password: env.HELMSMAN_DEMO_PASSWORD || null,
    modelUrl: env.HELMSMAN_DEMO_MODEL_URL || null,
    model: env.HELMSMAN_DEMO_MODEL || null,
    modelContextTokens: env.HELMSMAN_DEMO_MODEL_CONTEXT ? Number(env.HELMSMAN_DEMO_MODEL_CONTEXT) : null,
    chaosMinutes: env.HELMSMAN_DEMO_CHAOS_MINUTES ? Number(env.HELMSMAN_DEMO_CHAOS_MINUTES) : null
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--port") options.port = Number(argv[++index]);
    else if (argument === "--data") options.data = argv[++index];
    else if (argument === "--outage") options.outage = true;
    else if (argument === "--showcase") options.showcase = true;
    else if (argument === "--password") options.password = argv[++index];
    else if (argument === "--model-url") options.modelUrl = argv[++index];
    else if (argument === "--model") options.model = argv[++index];
    else if (argument === "--model-context") options.modelContextTokens = Number(argv[++index]);
    else if (argument === "--chaos-minutes") options.chaosMinutes = Number(argv[++index]);
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`Unknown option ${argument}. Try --help.`);
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) {
    throw new Error("--port must be a TCP port from 1 to 65535.");
  }
  if (options.chaosMinutes !== null && (!Number.isFinite(options.chaosMinutes) || options.chaosMinutes < 1 || options.chaosMinutes > 120)) {
    throw new Error("--chaos-minutes must be from 1 to 120.");
  }
  if (Boolean(options.modelUrl) !== Boolean(options.model)) {
    throw new Error("--model-url and --model go together: the model server and the model name to use on it.");
  }
  if (options.modelUrl) options.modelUrl = validModelUrl(options.modelUrl);
  if (options.modelContextTokens !== null
    && (!Number.isInteger(options.modelContextTokens) || options.modelContextTokens < 2_048 || options.modelContextTokens > 131_072)) {
    throw new Error("--model-context must be a whole number of tokens from 2048 to 131072.");
  }
  if (options.showcase) {
    if (!options.password || options.password === DEFAULT_DEMO_PASSWORD || options.password.length < 8) {
      throw new Error("Showcase mode listens on the network, so it needs a password of at least 8 characters (HELMSMAN_DEMO_PASSWORD).");
    }
    options.chaosMinutes ??= 4;
  }
  return options;
}

// The real model server the agent's calls go to, when one is configured.
// Only the three model endpoints the agent uses are forwarded.
let realModel = null;

function validModelUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("--model-url must be a URL such as http://192.168.0.50:11434.");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("--model-url must be a plain http or https URL without credentials or a query.");
  }
  // The agent asks for /v1/..., so a base URL that already ends in /v1 is
  // trimmed back to the server root.
  return url.origin + url.pathname.replace(/\/+$/u, "").replace(/\/v1$/u, "");
}

// ------------------------------------------------------------- fake world --

const HOSTS = Object.freeze({
  "jellyfin.helmsman-demo.test": "10.77.0.10",
  "seerr.helmsman-demo.test": "10.77.0.11",
  "radarr.helmsman-demo.test": "10.77.0.12",
  "sonarr.helmsman-demo.test": "10.77.0.13",
  "prowlarr.helmsman-demo.test": "10.77.0.14",
  "bazarr.helmsman-demo.test": "10.77.0.15",
  "qbittorrent.helmsman-demo.test": "10.77.0.16",
  "pve.helmsman-demo.test": "10.77.0.4",
  "portainer.helmsman-demo.test": "10.77.0.20",
  "ai.helmsman-demo.test": "10.77.0.30",
  "ha.helmsman-demo.test": "10.77.0.31"
});

const SERVER_ID = "d3m0d3m0d3m0d3m0d3m0d3m0d3m0d3m0";
const OWNER_ID = "0wn3r0wn3r0wn3r0wn3r0wn3r0wn3r00";
const OWNER_TOKEN = "demo-jellyfin-session-token";

// Invented titles only. tmdb/tvdb ids are arbitrary numbers in a range that
// keeps them distinct from one another.
const MOVIES = [
  { title: "The Lighthouse Keeper's Map", year: 2024, tmdb: 900_001, state: "available", color: [38, 70, 83] },
  { title: "Copper Valley", year: 2023, tmdb: 900_002, state: "available", color: [42, 157, 143] },
  { title: "Night Shift at Orbit Station", year: 2025, tmdb: 900_003, state: "available", color: [233, 196, 106], resume: 0.42 },
  { title: "Paper Kites", year: 2022, tmdb: 900_004, state: "available", color: [244, 162, 97] },
  { title: "A Quiet Harbor", year: 2024, tmdb: 900_005, state: "available", color: [231, 111, 81] },
  { title: "The Glass Orchard", year: 2026, tmdb: 900_006, state: "downloading", color: [96, 108, 56], progress: 0.63 },
  { title: "Saltwater Radio", year: 2026, tmdb: 900_007, state: "requested", color: [40, 54, 24] },
  { title: "Midnight Cartographers", year: 2026, tmdb: 900_008, state: "upcoming", color: [188, 108, 37], releaseInDays: 6 },
  { title: "Ferris & the Fog", year: 2025, tmdb: 900_009, state: "available", color: [69, 123, 157], subtitlesMissing: true },
  { title: "Thirteen Lanterns", year: 2026, tmdb: 900_010, state: "upcoming", color: [29, 53, 87], releaseInDays: 19 }
];

const SERIES = [
  { title: "Harborlight", year: 2023, tmdb: 910_001, tvdb: 810_001, state: "available", color: [131, 56, 236], nextUp: true },
  { title: "The Understairs Club", year: 2024, tmdb: 910_002, tvdb: 810_002, state: "available", color: [58, 134, 255] },
  { title: "Static Bloom", year: 2025, tmdb: 910_003, tvdb: 810_003, state: "downloading", color: [255, 0, 110], progress: 0.28 },
  { title: "Ridgeline Rescue", year: 2026, tmdb: 910_004, tvdb: 810_004, state: "upcoming", color: [251, 86, 7], releaseInDays: 2 },
  { title: "Low Tide Detectives", year: 2025, tmdb: 910_005, tvdb: 810_005, state: "requested", color: [255, 190, 11] }
];

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "");
}

function hex32(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function torrentHash(value) {
  return createHash("sha1").update(value).digest("hex");
}

function isoDaysFromNow(days) {
  return new Date(Date.now() + days * DAY).toISOString();
}

function dateOnly(days) {
  return isoDaysFromNow(days).slice(0, 10);
}

const ALL = [
  ...MOVIES.map((item, index) => ({ ...item, kind: "movie", arrId: index + 1 })),
  ...SERIES.map((item, index) => ({ ...item, kind: "series", arrId: index + 1 }))
].map((item) => ({ ...item, jellyfinId: hex32(`jf-${item.title}`), imageTag: hex32(`tag-${item.title}`), slug: slug(item.title) }));

const inLibrary = (item) => item.state === "available";

// A tiny solid-colour PNG used for every poster, so artwork loading works end
// to end without bundling any real artwork.
function posterPng([red, green, blue]) {
  const width = 2;
  const height = 3;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let row = 0; row < height; row += 1) {
    const offset = row * (width * 3 + 1);
    raw[offset] = 0;
    for (let column = 0; column < width; column += 1) {
      raw[offset + 1 + column * 3] = red;
      raw[offset + 2 + column * 3] = green;
      raw[offset + 3 + column * 3] = blue;
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes) => {
    let c = 0xffffffff;
    for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

function artworkFor(service, upstreamPath) {
  const kind = service === "radarr" ? "movie" : service === "sonarr" ? "series" : null;
  const match = ALL.find((item) => upstreamPath.includes(item.jellyfinId)
    || upstreamPath.includes(`/${item.slug}.`)
    || (kind === item.kind && upstreamPath.includes(`/MediaCover/${item.arrId}/`)));
  return posterPng(match?.color || [90, 90, 110]);
}

// --------------------------------------------------------- media upstreams --

function jellyfinItem(item, extra = {}) {
  return {
    Id: item.jellyfinId,
    Name: item.title,
    Type: item.kind === "movie" ? "Movie" : "Series",
    ProductionYear: item.year,
    PremiereDate: `${item.year}-03-01T00:00:00.0000000Z`,
    DateCreated: isoDaysFromNow(-(item.arrId + (item.kind === "movie" ? 0 : 3))),
    ProviderIds: { Tmdb: String(item.tmdb), ...(item.tvdb ? { Tvdb: String(item.tvdb) } : {}) },
    ImageTags: { Primary: item.imageTag },
    UserData: { PlaybackPositionTicks: 0, Played: false, ...(extra.UserData || {}) },
    ...extra
  };
}

function jellyfinUser() {
  return {
    Id: OWNER_ID,
    Name: DEMO_USERNAME,
    ServerId: SERVER_ID,
    Policy: { IsAdministrator: true, IsDisabled: false }
  };
}

function jellyfin(upstreamPath, method, body) {
  if (upstreamPath === "/System/Info/Public" || upstreamPath === "/System/Info") {
    return { Id: SERVER_ID, ServerName: "Demo Jellyfin", Version: "10.11.2", ProductName: "Jellyfin Server" };
  }
  if (upstreamPath === "/Users/AuthenticateByName" && method === "POST") {
    let credentials = {};
    try { credentials = JSON.parse(body.toString("utf8")); } catch { /* treated as wrong */ }
    if (credentials.Username !== DEMO_USERNAME || credentials.Pw !== demoPassword) return { status: 401, json: {} };
    return { AccessToken: OWNER_TOKEN, ServerId: SERVER_ID, User: jellyfinUser() };
  }
  if (upstreamPath === "/Users/Me") return jellyfinUser();
  if (upstreamPath === "/Sessions/Logout") return { status: 204, json: null };
  const library = ALL.filter(inLibrary);
  if (upstreamPath === "/Items") return { Items: library.map((item) => jellyfinItem(item)), TotalRecordCount: library.length };
  if (upstreamPath === "/Items/Latest") return library.slice(0, 8).map((item) => jellyfinItem(item));
  if (upstreamPath === "/UserItems/Resume") {
    const items = library.filter((item) => item.resume).map((item) => jellyfinItem(item, {
      UserData: { PlaybackPositionTicks: 36_000_000_000 * item.resume, PlayedPercentage: item.resume * 100, Played: false },
      RunTimeTicks: 72_000_000_000
    }));
    return { Items: items, TotalRecordCount: items.length };
  }
  if (upstreamPath === "/Shows/NextUp") {
    const items = library.filter((item) => item.nextUp).map((item) => ({
      Id: hex32(`ep-${item.title}`),
      Name: "The Second Light",
      Type: "Episode",
      SeriesId: item.jellyfinId,
      SeriesName: item.title,
      ParentIndexNumber: 2,
      IndexNumber: 4,
      ProviderIds: {},
      ImageTags: {},
      SeriesPrimaryImageTag: item.imageTag
    }));
    return { Items: items, TotalRecordCount: items.length };
  }
  if (upstreamPath === "/Sessions") return [];
  if (/\/Images\//u.test(upstreamPath)) return { image: artworkFor("jellyfin", upstreamPath) };
  return { status: 404, json: {} };
}

function seerrMedia(item) {
  return {
    mediaType: item.kind === "movie" ? "movie" : "tv",
    tmdbId: item.tmdb,
    ...(item.tvdb ? { tvdbId: item.tvdb } : {}),
    status: item.state === "available" ? 5 : item.state === "downloading" ? 3 : 2
  };
}

function seerr(upstreamPath) {
  if (upstreamPath === "/api/v1/status") return { version: "2.7.3", commitTag: "demo" };
  if (upstreamPath === "/api/v1/auth/me") return { id: 1, displayName: "demo", permissions: 2 };
  const requested = ALL.filter((item) => item.state !== "available" || item.arrId % 3 === 0);
  if (upstreamPath === "/api/v1/request/count") {
    return {
      total: requested.length,
      pending: requested.filter((item) => item.state === "requested").length,
      approved: requested.filter((item) => item.state !== "requested").length,
      processing: requested.filter((item) => item.state === "downloading").length,
      available: requested.filter(inLibrary).length
    };
  }
  if (upstreamPath === "/api/v1/request") {
    return {
      pageInfo: { pages: 1, pageSize: 200, results: requested.length, page: 1 },
      results: requested.map((item, index) => ({
        id: 100 + index,
        type: item.kind === "movie" ? "movie" : "tv",
        status: item.state === "requested" ? 1 : 2,
        createdAt: isoDaysFromNow(-(index + 1)),
        updatedAt: isoDaysFromNow(-index),
        requestedBy: { id: 1, displayName: "demo" },
        ...(item.kind === "series" ? { seasons: [{ seasonNumber: 1, status: 2 }] } : {}),
        media: { ...seerrMedia(item), title: item.title, posterPath: `/${item.slug}.png` }
      }))
    };
  }
  if (upstreamPath === "/api/v1/discover/trending") {
    return {
      page: 1,
      totalPages: 1,
      results: ALL.map((item) => ({
        id: item.tmdb,
        mediaType: item.kind === "movie" ? "movie" : "tv",
        ...(item.kind === "movie" ? { title: item.title, releaseDate: `${item.year}-03-01` } : { name: item.title, firstAirDate: `${item.year}-03-01` }),
        overview: `An invented ${item.kind === "movie" ? "film" : "series"} used by the Helmsman demo.`,
        posterPath: `/${item.slug}.png`,
        mediaInfo: { status: seerrMedia(item).status }
      }))
    };
  }
  if (/\.(?:png|jpe?g|webp)$/u.test(upstreamPath)) return { image: artworkFor("seerr", upstreamPath) };
  return { status: 404, json: {} };
}

function arr(service, upstreamPath, method = "GET", body = Buffer.alloc(0)) {
  if (faults.has(service)) return { status: 503, json: {} };
  const indexers = arrIndexers(upstreamPath, method, body);
  if (indexers) return indexers;
  const movies = service === "radarr";
  const items = ALL.filter((item) => item.kind === (movies ? "movie" : "series"));
  if (upstreamPath === "/api/v3/system/status") {
    return { appName: movies ? "Radarr" : "Sonarr", version: movies ? "6.0.4.10291" : "4.0.15.2941" };
  }
  if (upstreamPath === "/api/v3/health") {
    return movies ? [] : [{ source: "IndexerSearchCheck", type: "notice", message: "Demo notice: one indexer is slow to respond." }];
  }
  if (upstreamPath === "/api/v3/movie" || upstreamPath === "/api/v3/series") {
    return items.filter((item) => item.state !== "requested").map((item) => ({
      id: item.arrId,
      title: item.title,
      year: item.year,
      tmdbId: item.tmdb,
      ...(item.tvdb ? { tvdbId: item.tvdb } : {}),
      monitored: true,
      ...(movies ? { hasFile: inLibrary(item) } : (() => {
        const files = inLibrary(item) ? 8 : item.state === "downloading" ? 2 : 0;
        return {
          statistics: { episodeFileCount: files, episodeCount: 8, totalEpisodeCount: 10, percentOfEpisodes: Math.round((files / 8) * 100) },
          seasons: [{ seasonNumber: 1, monitored: true, statistics: { episodeFileCount: files, episodeCount: 8 } }]
        };
      })()),
      added: isoDaysFromNow(-(item.arrId + 2)),
      images: [{ coverType: "poster", url: `/MediaCover/${item.arrId}/poster.jpg?lastWrite=63893491200000000${item.arrId}` }]
    }));
  }
  if (upstreamPath === "/api/v3/queue") {
    const records = items.filter((item) => item.state === "downloading").map((item, index) => ({
      id: 500 + index + (movies ? 0 : 50),
      ...(movies
        ? { movieId: item.arrId, movie: { id: item.arrId, title: item.title, year: item.year, tmdbId: item.tmdb } }
        : { seriesId: item.arrId, series: { id: item.arrId, title: item.title, year: item.year, tvdbId: item.tvdb, tmdbId: item.tmdb },
          episode: { seasonNumber: 1, episodeNumber: 3, title: "Episode three" } }),
      downloadId: torrentHash(item.title).toUpperCase(),
      title: `${item.title.replace(/\s+/gu, ".")}.${item.year}`,
      ...(stalledQueues.has(service) && index === 0
        ? { status: "warning", trackedDownloadStatus: "warning", trackedDownloadState: "downloading", errorMessage: "The download is stalled with no connections" }
        : { status: "downloading", trackedDownloadStatus: "ok", trackedDownloadState: "downloading" }),
      size: 4_000_000_000,
      sizeleft: Math.round(4_000_000_000 * (1 - item.progress)),
      timeleft: "00:24:00",
      protocol: "torrent",
      downloadClient: "qBittorrent"
    }));
    return { page: 1, pageSize: 500, totalRecords: records.length, records };
  }
  if (upstreamPath === "/api/v3/calendar") {
    return items.filter((item) => item.releaseInDays).map((item) => (movies
      ? { id: item.arrId, title: item.title, year: item.year, tmdbId: item.tmdb, monitored: true, hasFile: false, digitalRelease: isoDaysFromNow(item.releaseInDays) }
      : {
        id: 700 + item.arrId,
        seriesId: item.arrId,
        title: "Pilot",
        seasonNumber: 1,
        episodeNumber: 1,
        airDateUtc: isoDaysFromNow(item.releaseInDays),
        airDate: dateOnly(item.releaseInDays),
        hasFile: false,
        monitored: true,
        series: { id: item.arrId, title: item.title, year: item.year, tvdbId: item.tvdb, tmdbId: item.tmdb }
      }));
  }
  if (upstreamPath.includes("/MediaCover/")) return { image: artworkFor(service, upstreamPath) };
  return { status: 404, json: {} };
}

// Demo indexers. Their `fields` hold a fake secret so tests can prove
// Helmsman never passes indexer settings on.
const DEMO_INDEXER_SECRET = "demo-indexer-secret-0123456789abcdef";
const INDEXERS = [
  { id: 1, name: "Example Public Tracker", protocol: "torrent", privacy: "public", priority: 25 },
  { id: 2, name: "Example Private Tracker", protocol: "torrent", privacy: "private", priority: 10 },
  { id: 3, name: "Example Usenet", protocol: "usenet", privacy: "private", priority: 20 }
];
const failingIndexers = new Set();
const indexerFailures = new Map();

function indexerRecord(indexer) {
  return { ...indexer, enable: true, implementation: "Cardigann", fields: [{ name: "apiKey", value: DEMO_INDEXER_SECRET }] };
}

function prowlarr(upstreamPath, method = "GET", body = Buffer.alloc(0)) {
  if (upstreamPath === "/api/v1/system/status") return { appName: "Prowlarr", version: "2.1.5.5216" };
  if (upstreamPath === "/api/v1/health") return [];
  if (upstreamPath === "/api/v1/indexerstatus") {
    return [...failingIndexers].map((id) => ({
      id,
      indexerId: id,
      initialFailure: indexerFailures.get(id),
      mostRecentFailure: new Date().toISOString(),
      disabledTill: new Date(Date.now() + 30 * 60_000).toISOString()
    }));
  }
  if (upstreamPath === "/api/v1/indexer" && method === "GET") return INDEXERS.map(indexerRecord);
  const single = /^\/api\/v1\/indexer\/(\d+)$/u.exec(upstreamPath);
  if (single && method === "GET") {
    const indexer = INDEXERS.find(({ id }) => id === Number(single[1]));
    return indexer ? indexerRecord(indexer) : { status: 404, json: {} };
  }
  if (upstreamPath === "/api/v1/indexerstats") {
    return { indexers: INDEXERS.map(({ id, name }) => ({ indexerId: id, indexerName: name, numberOfQueries: 40 * id, numberOfGrabs: 3 * id, numberOfFailedQueries: failingIndexers.has(id) ? 6 : 0, averageResponseTime: 300 + id * 120 })) };
  }
  if (upstreamPath === "/api/v1/applications" && method === "GET") {
    return [
      { id: 1, name: "Sonarr", implementationName: "Sonarr", syncLevel: "fullSync", fields: [{ name: "apiKey", value: DEMO_INDEXER_SECRET }] },
      { id: 2, name: "Radarr", implementationName: "Radarr", syncLevel: "fullSync", fields: [{ name: "apiKey", value: DEMO_INDEXER_SECRET }] }
    ];
  }
  const failure = [{ propertyName: "BaseUrl", errorMessage: "Unable to connect to indexer: the site answered with a Cloudflare challenge", severity: "error" }];
  if (upstreamPath === "/api/v1/indexer/test" && method === "POST") {
    let id = null;
    try {
      id = JSON.parse(body.toString("utf8")).id;
    } catch {
      return { status: 400, json: [] };
    }
    return failingIndexers.has(id) ? { status: 400, json: failure } : {};
  }
  if (upstreamPath === "/api/v1/indexer/testall" && method === "POST") {
    const results = INDEXERS.map(({ id }) => ({ id, isValid: !failingIndexers.has(id), validationFailures: failingIndexers.has(id) ? failure : [] }));
    return results.every(({ isValid }) => isValid) ? results : { status: 400, json: results };
  }
  if (upstreamPath === "/api/v1/applications/testall" && method === "POST") {
    return [{ id: 1, isValid: true, validationFailures: [] }, { id: 2, isValid: true, validationFailures: [] }];
  }
  if (upstreamPath === "/api/v1/command" && method === "POST") return { status: 201, json: { id: 1, name: "ApplicationIndexerSync" } };
  return { status: 404, json: {} };
}

// An indexer starts failing in Prowlarr, as when a tracker's site is down.
function failIndexer(name = "Example Public Tracker") {
  const indexer = INDEXERS.find((candidate) => candidate.name === name);
  if (!indexer) throw new Error(`The demo has no indexer called ${name}.`);
  failingIndexers.add(indexer.id);
  indexerFailures.set(indexer.id, new Date().toISOString());
}

function recoverIndexer(name = "Example Public Tracker") {
  const indexer = INDEXERS.find((candidate) => candidate.name === name);
  if (indexer) failingIndexers.delete(indexer.id);
}

// Radarr's and Sonarr's indexers, as Prowlarr syncs them: they fail along
// with the Prowlarr indexer of the same name.
function arrIndexers(upstreamPath, method, body) {
  const record = (indexer) => ({ id: indexer.id, name: `${indexer.name} (Prowlarr)`, protocol: indexer.protocol, priority: indexer.priority, enableRss: true, enableAutomaticSearch: true, enableInteractiveSearch: true, implementation: "Torznab", fields: [{ name: "apiKey", value: DEMO_INDEXER_SECRET }] });
  const failure = [{ propertyName: "BaseUrl", errorMessage: "Unable to connect to indexer, check the log above the ValidationFailure for more details", severity: "error" }];
  if (upstreamPath === "/api/v3/indexer" && method === "GET") return INDEXERS.map(record);
  if (upstreamPath === "/api/v3/indexerstatus") {
    return [...failingIndexers].map((id) => ({ id, indexerId: id, initialFailure: indexerFailures.get(id), mostRecentFailure: new Date().toISOString(), disabledTill: new Date(Date.now() + 15 * 60_000).toISOString() }));
  }
  const single = /^\/api\/v3\/indexer\/(\d+)$/u.exec(upstreamPath);
  if (single && method === "GET") {
    const indexer = INDEXERS.find(({ id }) => id === Number(single[1]));
    return indexer ? record(indexer) : { status: 404, json: {} };
  }
  if (upstreamPath === "/api/v3/indexer/test" && method === "POST") {
    let id = null;
    try {
      id = JSON.parse(body.toString("utf8")).id;
    } catch {
      return { status: 400, json: [] };
    }
    return failingIndexers.has(id) ? { status: 400, json: failure } : {};
  }
  if (upstreamPath === "/api/v3/indexer/testall" && method === "POST") {
    const results = INDEXERS.map(({ id }) => ({ id, isValid: !failingIndexers.has(id), validationFailures: failingIndexers.has(id) ? failure : [] }));
    return results.every(({ isValid }) => isValid) ? results : { status: 400, json: results };
  }
  return null;
}

function bazarr(upstreamPath) {
  if (upstreamPath === "/api/system/status") return { data: { bazarr_version: "1.5.3" } };
  if (upstreamPath === "/api/system/health") return { data: [] };
  if (upstreamPath === "/api/movies/wanted") {
    const wanted = ALL.filter((item) => item.kind === "movie" && item.subtitlesMissing);
    return {
      total: wanted.length,
      data: wanted.map((item) => ({ radarrId: item.arrId, title: item.title, tmdbId: item.tmdb, missing_subtitles: [{ name: "English", code2: "en" }] }))
    };
  }
  if (upstreamPath === "/api/episodes/wanted") return { total: 0, data: [] };
  return { status: 404, json: {} };
}

function qbittorrent(upstreamPath) {
  if (upstreamPath === "/api/v2/app/version") return { text: "v5.1.2" };
  if (upstreamPath === "/api/v2/transfer/info") {
    return { connection_status: "connected", dl_info_speed: 6_400_000, up_info_speed: 420_000, dht_nodes: 312 };
  }
  if (upstreamPath === "/api/v2/torrents/info") {
    const downloading = ALL.filter((item) => item.state === "downloading").map((item) => ({
      hash: torrentHash(item.title),
      name: `${item.title.replace(/\s+/gu, ".")}.${item.year}`,
      state: "downloading",
      progress: item.progress,
      dlspeed: 3_200_000,
      upspeed: 120_000,
      eta: 1_440,
      size: 4_000_000_000,
      category: item.kind === "movie" ? "radarr" : "sonarr",
      added_on: Math.floor((Date.now() - DAY) / 1000)
    }));
    const seeding = ALL.filter(inLibrary).slice(0, 3).map((item) => ({
      hash: torrentHash(`seed-${item.title}`),
      name: `${item.title.replace(/\s+/gu, ".")}.${item.year}`,
      state: "uploading",
      progress: 1,
      dlspeed: 0,
      upspeed: 100_000,
      eta: 8_640_000,
      size: 3_000_000_000,
      category: item.kind === "movie" ? "radarr" : "sonarr",
      added_on: Math.floor((Date.now() - 5 * DAY) / 1000)
    }));
    return [...downloading, ...seeding];
  }
  return { status: 404, json: {} };
}

const MEDIA = { jellyfin, seerr, radarr: (p, m, b) => arr("radarr", p, m, b), sonarr: (p, m, b) => arr("sonarr", p, m, b), prowlarr, bazarr, qbittorrent };

function upstreamResponse(result) {
  if (result && Buffer.isBuffer(result.image)) {
    return { status: 200, body: result.image, contentType: "image/png", cookies: [] };
  }
  if (result && typeof result.text === "string") {
    return { status: 200, body: Buffer.from(result.text, "utf8"), contentType: "text/plain", cookies: [] };
  }
  if (result && Number.isInteger(result.status)) {
    return {
      status: result.status,
      body: Buffer.from(result.json === null ? "" : JSON.stringify(result.json), "utf8"),
      contentType: "application/json",
      cookies: []
    };
  }
  return { status: 200, body: Buffer.from(JSON.stringify(result), "utf8"), contentType: "application/json", cookies: [] };
}

async function dispatchUpstream({ route, request, body }) {
  const handler = MEDIA[route.service];
  if (!handler) return upstreamResponse({ status: 404, json: {} });
  return upstreamResponse(handler(route.upstreamPath, request?.method || route.method, body || Buffer.alloc(0)));
}

// Media actions (retry, search, blocklist) are accepted. Blocklisting a
// stalled download clears it, as the replacement search would.
async function dispatchMediaAction({ route } = {}) {
  // A repeat stall is blocklisted (blocklistAndSearch); a first one is
  // removed without a blocklist, which the broker sends as removeFromQueue
  // followed by a search. Either clears the item, as the new search would.
  if (["blocklistAndSearch", "removeFromQueue"].includes(route?.operation)) stalledQueues.delete(route.service);
  return { status: 201, body: Buffer.from("{}", "utf8"), contentType: "application/json", cookies: [] };
}

// ------------------------------------------------ infrastructure upstreams --

const GUESTS = [
  { vmid: 100, type: "qemu", node: "pve-1", name: "media", status: "running", cpu: 0.18, maxcpu: 6, mem: 7_200_000_000, maxmem: 12_000_000_000, disk: 40_000_000_000, maxdisk: 120_000_000_000, uptime: 9 * 86_400 },
  { vmid: 101, type: "lxc", node: "pve-1", name: "requests", status: "running", cpu: 0.03, maxcpu: 2, mem: 600_000_000, maxmem: 2_000_000_000, disk: 3_000_000_000, maxdisk: 16_000_000_000, uptime: 9 * 86_400 },
  { vmid: 102, type: "lxc", node: "pve-1", name: "dns", status: "running", cpu: 0.01, maxcpu: 1, mem: 180_000_000, maxmem: 512_000_000, disk: 1_200_000_000, maxdisk: 8_000_000_000, uptime: 21 * 86_400 },
  { vmid: 200, type: "qemu", node: "pve-2", name: "home-automation", status: "running", cpu: 0.07, maxcpu: 2, mem: 2_400_000_000, maxmem: 4_000_000_000, disk: 18_000_000_000, maxdisk: 32_000_000_000, uptime: 4 * 86_400 },
  { vmid: 201, type: "lxc", node: "pve-2", name: "nvr", status: "running", cpu: 0.31, maxcpu: 4, mem: 3_800_000_000, maxmem: 8_000_000_000, disk: 9_000_000_000, maxdisk: 20_000_000_000, uptime: 4 * 86_400 },
  { vmid: 202, type: "qemu", node: "pve-2", name: "sandbox", status: "stopped", maxcpu: 2, maxmem: 4_000_000_000, maxdisk: 32_000_000_000 }
];

function proxmox(routeId, node) {
  const now = Math.floor(Date.now() / 1000);
  const nodes = [
    { node: "pve-1", status: "online", cpu: 0.21, maxcpu: 16, mem: 22_000_000_000, maxmem: 64_000_000_000, disk: 60_000_000_000, maxdisk: 240_000_000_000, uptime: 21 * 86_400 },
    { node: "pve-2", status: "online", cpu: 0.12, maxcpu: 8, mem: 9_000_000_000, maxmem: 32_000_000_000, disk: 30_000_000_000, maxdisk: 240_000_000_000, uptime: 4 * 86_400 }
  ];
  switch (routeId) {
    case "permissions": return { data: { "/": { "Sys.Audit": 1, "VM.Audit": 1, "VM.PowerMgmt": 1 } } };
    case "version": return { data: { version: "9.0.6", release: "9.0" } };
    case "clusterStatus": return {
      data: [
        { type: "cluster", name: "demo-cluster", nodes: 2, quorate: 1 },
        { type: "node", name: "pve-1", nodeid: 1, online: 1, local: 1 },
        { type: "node", name: "pve-2", nodeid: 2, online: 1, local: 0 }
      ]
    };
    case "nodes": return { data: nodes.map(({ node: name, status, uptime, maxcpu, maxmem, maxdisk }) => ({ node: name, status, uptime, maxcpu, maxmem, maxdisk })) };
    case "nodeResources": return { data: nodes };
    case "guests": return { data: GUESTS };
    case "storage": return {
      data: [
        { node: "pve-1", storage: "local-zfs", status: "available", disk: 410_000_000_000, maxdisk: 900_000_000_000 },
        { node: "pve-2", storage: "local-zfs", status: "available", disk: 120_000_000_000, maxdisk: 450_000_000_000 },
        { node: "pve-1", storage: "backups", status: "available", disk: 1_100_000_000_000, maxdisk: 4_000_000_000_000 }
      ]
    };
    case "tasks": return { data: [{ type: "qmstart", node, status: "OK", endtime: now - 3_600 }] };
    case "backups": return {
      data: GUESTS.filter((guest) => guest.node === node && guest.status === "running")
        .map((guest) => ({ type: "vzdump", id: guest.vmid, node, status: "OK", endtime: now - 6 * 3_600 }))
    };
    default: return null;
  }
}

async function dispatchProxmox({ route }) {
  const result = proxmox(route.routeId, route.node);
  if (!result) return { status: 404, body: Buffer.from("{}", "utf8"), contentType: "application/json" };
  return { status: 200, body: Buffer.from(JSON.stringify(result), "utf8"), contentType: "application/json" };
}

const CONTAINERS = ["jellyfin", "radarr", "sonarr", "prowlarr", "bazarr", "qbittorrent", "seerr", "helmsman"].map((name, index) => ({
  Id: createHash("sha256").update(name).digest("hex"),
  Names: [`/${name}`],
  Image: `example/${name}:latest`,
  State: name === "bazarr" ? "exited" : "running",
  Status: name === "bazarr" ? "Exited (0) 2 hours ago" : `Up ${index + 2} days`,
  Created: Math.floor((Date.now() - 30 * DAY) / 1000),
  Labels: { "com.docker.compose.project": name === "helmsman" ? "helmsman" : "media" }
}));

function portainer(routeId) {
  switch (routeId) {
    case "systemStatus": return { Version: "2.33.1" };
    case "legacyStatus": return { Version: "2.33.1" };
    case "identity": return { Id: 1, Username: "helmsman" };
    case "environments": return [{ Id: 1, Name: "media-host", Status: 1, ContainerEngine: "Docker", Type: 1 }];
    case "stacks": return [
      { Id: 1, Name: "media", Status: 1, EndpointId: 1 },
      { Id: 2, Name: "helmsman", Status: 1, EndpointId: 1 }
    ];
    case "containers": return CONTAINERS;
    default: return null;
  }
}

async function dispatchPortainer({ route }) {
  if (route.actionId === "container") {
    const container = CONTAINERS.find((entry) => entry.Id === route.containerId);
    if (!container) return { status: 404, body: Buffer.alloc(0), contentType: "application/json" };
    if (route.operation === "stop") {
      container.State = "exited";
      container.Status = "Exited (0) Less than a second ago";
    } else {
      repairContainer(container);
    }
    return { status: 204, body: Buffer.alloc(0), contentType: "application/json" };
  }
  const result = portainer(route.routeId);
  if (!result) return { status: 404, body: Buffer.from("{}", "utf8"), contentType: "application/json" };
  return { status: 200, body: Buffer.from(JSON.stringify(result), "utf8"), contentType: "application/json" };
}

// ------------------------------------------------------ agent upstreams --
//
// A scripted stand-in for a local model, and a stand-in Home Assistant. The
// fake model follows the OpenAI chat format with tool calls, so the agent's
// real conversation loop, tools, proposals and notifications all run. Its
// answers are templates, not intelligence.

const DEMO_MODEL = "demo-model";
const DEMO_HA_TOKEN = "demo-home-assistant-token";
const DEMO_NOTIFY_SERVICE = "mobile_app_demo_phone";
const notifications = [];

function modelReply(content) {
  return { choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 0, completion_tokens: 0 } };
}

function modelCall(messages, name, args) {
  const count = messages.filter((message) => message.role === "tool").length;
  return {
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{ id: `call_${count + 1}`, type: "function", function: { name, arguments: JSON.stringify(args) } }]
      },
      finish_reason: "tool_calls"
    }]
  };
}

function fakeModel(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const tools = new Set((body?.tools || []).map((tool) => tool.function?.name));
  const prompt = [...messages].reverse().find((message) => message.role === "user" && !message.content.startsWith("Answer now"))?.content || "";
  const called = messages.filter((message) => message.tool_calls).flatMap((message) => message.tool_calls.map((call) => call.function.name));
  const results = messages.filter((message) => message.role === "tool").map((message) => message.content);
  const firstLines = (text, count) => String(text || "").split("\n").filter(Boolean).slice(0, count).join(" ");

  const incident = /^A problem (?:just started|got worse) \(([^)]+)\)\.\nOpen incidents:\n- [^/]+ \/ ([^:]+): ([a-z_]+)( [A-Z_]+)?/u.exec(prompt);
  if (incident) {
    const [, name, capability, state, code = ""] = incident;
    const id = name.trim().toLowerCase();
    if (tools.has("list_workloads") && !called.includes("list_workloads")) return modelCall(messages, "list_workloads", { filter: id });
    const containerLine = results.find((text) => text.includes(`container ${id} `)) || "";
    const stopped = /: (exited|created)/u.test(containerLine);
    if (stopped && tools.has("propose_action") && !called.includes("propose_action")) {
      return modelCall(messages, "propose_action", { target: `container:${id}`, action: "start", reason: `${name.trim()} is down and its container is stopped.` });
    }
    return modelReply(`${name.trim()} is failing its ${capability.trim()} check (${state}${code}).${stopped ? ` Its container is stopped, which explains it. Next step: start the ${id} container and watch the next check.` : " Its container is running, so check the service's own logs next."}`);
  }
  if (prompt.startsWith("Write the owner's daily summary")) {
    const overview = prompt.split("Current overview:\n")[1] || "";
    return modelReply(`Good morning. ${firstLines(overview.split("\n").slice(1).join("\n"), 3)}`);
  }
  if (tools.has("overview") && !called.includes("overview")) return modelCall(messages, "overview", {});
  return modelReply(`${firstLines(results.at(-1), 4)} (This demo answers with a scripted stand-in for a local model.)`);
}

function json(status, value) {
  const bytes = value === undefined ? 0 : Buffer.byteLength(JSON.stringify(value));
  return { status, json: status >= 200 && status < 300 ? value ?? null : null, bytes };
}

const FORWARDED_MODEL_ROUTES = new Set(["GET /v1/models", "GET /api/tags", "POST /v1/chat/completions"]);

// Sends one of the agent's model calls to the real model server. Helmsman
// saved the demo host, so its own network policy never sees this address;
// the demo process makes the call and returns the answer as if the demo
// host had given it.
async function forwardToRealModel(method, requestPath, body) {
  if (!FORWARDED_MODEL_ROUTES.has(`${method} ${requestPath}`)) return json(404, {});
  let response;
  try {
    response = await fetch(`${realModel.url}${requestPath}`, {
      method,
      headers: { Accept: "application/json", ...(method === "POST" ? { "Content-Type": "application/json" } : {}) },
      body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
      redirect: "error",
      signal: AbortSignal.timeout(290_000)
    });
  } catch (error) {
    throw Object.assign(new Error(`The demo could not reach the model server: ${error.message}`), { code: "UPSTREAM_UNREACHABLE", status: 502 });
  }
  const text = await response.text();
  if (text.length > 8 * 1024 * 1024) return json(502, {});
  let value = null;
  try { value = text ? JSON.parse(text) : null; } catch { value = null; }
  if (response.ok && value === null) return json(502, {});
  return json(response.status, value);
}

async function dispatchAgent({ targetResolution, method, path: requestPath, body, bearerToken }) {
  const host = targetResolution?.target?.hostname;
  if (host === "ai.helmsman-demo.test" && realModel) return forwardToRealModel(method, requestPath, body);
  if (host === "ai.helmsman-demo.test") {
    if (method === "GET" && requestPath === "/v1/models") return json(200, { object: "list", data: [{ id: DEMO_MODEL }, { id: "qwen2.5:3b" }] });
    // Ollama's own list, for the size and quantization the Model dropdown shows.
    if (method === "GET" && requestPath === "/api/tags") {
      return json(200, { models: [
        { name: `${DEMO_MODEL}:latest`, size: 2_497_293_918, details: { quantization_level: "Q4_K_M" } },
        { name: "qwen2.5:3b", size: 1_929_912_432, details: { quantization_level: "Q4_K_M" } }
      ] });
    }
    if (method === "POST" && requestPath === "/v1/chat/completions") {
      if (body?.model !== DEMO_MODEL && body?.model !== "qwen2.5:3b") return json(404, {});
      return json(200, fakeModel(body));
    }
    return json(404, {});
  }
  if (host === "ha.helmsman-demo.test") {
    if (bearerToken !== DEMO_HA_TOKEN) return json(401, {});
    if (method === "GET" && requestPath === "/api/") return json(200, { message: "API running." });
    if (method === "POST" && requestPath === `/api/services/notify/${DEMO_NOTIFY_SERVICE}`) {
      notifications.push({ at: new Date().toISOString(), title: body?.title, message: body?.message });
      if (notifications.length > 100) notifications.shift();
      if (process.env.HELMSMAN_DEMO_VERBOSE || demoPrintNotifications) {
        process.stdout.write(`\n  [phone] ${body?.title}\n          ${String(body?.message || "").replace(/\n/gu, "\n          ")}\n`);
      }
      return json(200, []);
    }
    if (method === "POST" && requestPath.startsWith("/api/services/notify/")) return json(400, {});
    return json(404, {});
  }
  throw Object.assign(new Error("Not part of the demo."), { code: "UPSTREAM_UNREACHABLE", status: 502 });
}

let demoPrintNotifications = false;

// ---------------------------------------------------------------- faults --
//
// `breakService("sonarr")` makes Sonarr's API fail and stops its container,
// so the agent has something to notice. Starting the container again (by a
// rule, an approved proposal or the Portainer button) fixes it.

const faults = new Set();
const stalledQueues = new Set();

// The first download in Radarr's or Sonarr's queue reports "stalled with no
// connections", as a torrent without seeds does.
function stallDownload(service = "sonarr") {
  if (!["sonarr", "radarr"].includes(service)) throw new Error("The demo can stall a sonarr or radarr download.");
  stalledQueues.add(service);
}

function breakService(name) {
  if (!["sonarr", "radarr"].includes(name)) throw new Error("The demo can break sonarr or radarr.");
  faults.add(name);
  const container = CONTAINERS.find((entry) => entry.Names[0] === `/${name}`);
  if (container) {
    container.State = "exited";
    container.Status = "Exited (137) Less than a second ago";
  }
}

// Docker health check failing while the container keeps running; a restart
// clears it, as it would for a real container that recovers.
function makeUnhealthy(name) {
  const container = CONTAINERS.find((entry) => entry.Names[0] === `/${name}`);
  if (!container) throw new Error(`The demo has no container called ${name}.`);
  container.State = "running";
  container.Status = "Up 2 hours (unhealthy)";
}

function repairContainer(container) {
  container.State = "running";
  container.Status = "Up Less than a second";
  faults.delete(container.Names[0].slice(1));
}

// ---------------------------------------------------------------- chaos --
//
// Showcase mode keeps staging one believable problem at a time, each one
// something the agent's real policies handle. A scenario that is still
// unresolved after `healMinutes` is put right by the demo itself, so the
// world never stays broken, and the next one starts `everyMinutes` after the
// last one ended.

function containerNamed(name) {
  return CONTAINERS.find((entry) => entry.Names[0] === `/${name}`);
}

export const SCENARIOS = Object.freeze({
  "sonarr-down": {
    label: "Sonarr crashed (its container exited)",
    handledBy: "the restart-sonarr rule",
    start: () => breakService("sonarr"),
    active: () => faults.has("sonarr"),
    heal: () => repairContainer(containerNamed("sonarr"))
  },
  // Radarr has no restart rule on purpose: the agent suggests starting it
  // and the visitor gets to approve that in the dashboard.
  "radarr-down": {
    label: "Radarr crashed (its container exited)",
    handledBy: "a suggestion to approve (Helmy proposes starting the container)",
    start: () => breakService("radarr"),
    active: () => faults.has("radarr"),
    heal: () => repairContainer(containerNamed("radarr"))
  },
  "qbittorrent-unhealthy": {
    label: "qBittorrent's health check is failing",
    handledBy: "container health (restart unhealthy containers)",
    start: () => makeUnhealthy("qbittorrent"),
    active: () => /unhealthy/u.test(containerNamed("qbittorrent").Status),
    heal: () => repairContainer(containerNamed("qbittorrent"))
  },
  // Stalled on Radarr, not Sonarr: a stalled item degrades the service's
  // queue check, and the Sonarr restart rule would answer any Sonarr
  // incident with a restart, which does nothing for a stalled download.
  "download-stalled": {
    label: "A Radarr download stalled with no seeds",
    handledBy: "stuck downloads (blocklist and search again)",
    start: () => stallDownload("radarr"),
    active: () => stalledQueues.has("radarr"),
    heal: () => stalledQueues.delete("radarr")
  },
  "indexer-failing": {
    label: "An indexer started failing in Prowlarr",
    handledBy: "indexer testing (test, then notify)",
    start: () => failIndexer(),
    active: () => failingIndexers.size > 0,
    // The agent only tests indexers, it never changes them, so this one is
    // always ended by the demo once the agent has had time to report it.
    heal: () => recoverIndexer()
  }
});

/**
 * Starts the scenario loop. `clock` and `schedule` exist for tests. Returns
 * { stop, tick, status }.
 */
export function startChaos({ everyMinutes = 4, healMinutes = 20, order = Object.keys(SCENARIOS), log = () => {}, clock = Date.now, schedule = true } = {}) {
  let index = 0;
  let current = null;
  let idleSince = clock();
  const history = [];

  const tick = () => {
    const now = clock();
    if (current) {
      const scenario = SCENARIOS[current.id];
      const ageMs = now - current.startedAt;
      if (!scenario.active()) {
        const outcome = { id: current.id, outcome: "resolved", seconds: Math.round(ageMs / 1000) };
        history.push(outcome);
        log(`Resolved: ${scenario.label}, after ${outcome.seconds}s.`);
        current = null;
        idleSince = now;
      } else if (ageMs >= healMinutes * MINUTE) {
        scenario.heal();
        history.push({ id: current.id, outcome: "healed-by-demo", seconds: Math.round(ageMs / 1000) });
        log(`Reset by the demo: ${scenario.label}.`);
        current = null;
        idleSince = now;
      }
      return;
    }
    if (now - idleSince < everyMinutes * MINUTE) return;
    const id = order[index % order.length];
    index += 1;
    SCENARIOS[id].start();
    current = { id, startedAt: now };
    log(`Staged: ${SCENARIOS[id].label}. Expect ${SCENARIOS[id].handledBy}.`);
  };

  const timer = schedule ? setInterval(tick, 15_000) : null;
  timer?.unref();
  return {
    tick,
    stop() { if (timer) clearInterval(timer); },
    status: () => ({ current: current ? { ...current } : null, history: [...history] })
  };
}

async function lookup(hostname) {
  const address = HOSTS[String(hostname).toLowerCase()];
  if (!address) throw Object.assign(new Error(`${hostname} is not part of the demo`), { code: "ENOTFOUND" });
  return [{ address, family: 4 }];
}

// --------------------------------------------------------------- setup API --

function apiRequest(context, pathname, method = "GET", payload = undefined, auth = null) {
  const body = payload === undefined ? null : Buffer.from(JSON.stringify(payload), "utf8");
  return new Promise((resolve, reject) => {
    const outgoing = http.request({
      hostname: "127.0.0.1",
      port: context.port,
      path: pathname,
      method,
      headers: {
        Host: `127.0.0.1:${context.port}`,
        Origin: context.origin,
        ...(auth?.cookie ? { Cookie: auth.cookie } : {}),
        ...(auth?.csrf ? { "X-Helmsman-CSRF": auth.csrf } : {}),
        ...(body ? { "Content-Type": "application/json", "Content-Length": String(body.length) } : {})
      }
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { json = null; }
        resolve({ status: response.statusCode, headers: response.headers, json });
      });
    });
    outgoing.on("error", reject);
    outgoing.end(body || undefined);
  });
}

async function expectOk(promise, label) {
  const response = await promise;
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`${label} failed with HTTP ${response.status}: ${JSON.stringify(response.json)}`);
  }
  return response;
}

function cookieFrom(response) {
  const header = response.headers["set-cookie"];
  return (Array.isArray(header) ? header[0] : String(header || "")).split(";", 1)[0];
}

const MEDIA_CONNECTIONS = [
  ["jellyfin", "http://jellyfin.helmsman-demo.test:8096", "token", "demo-jellyfin-api-key"],
  ["seerr", "http://seerr.helmsman-demo.test:5055", "apiKey", "demo-seerr-api-key"],
  ["radarr", "http://radarr.helmsman-demo.test:7878", "apiKey", "demo-radarr-api-key"],
  ["sonarr", "http://sonarr.helmsman-demo.test:8989", "apiKey", "demo-sonarr-api-key"],
  ["prowlarr", "http://prowlarr.helmsman-demo.test:9696", "apiKey", "demo-prowlarr-api-key"],
  ["bazarr", "http://bazarr.helmsman-demo.test:6767", "apiKey", "demo-bazarr-api-key"],
  ["qbittorrent", "http://qbittorrent.helmsman-demo.test:8080", "apiKey", "qbt_demo000000000000000000000000"]
];

function demoNetworkMap() {
  const zone = (id, title, row, order) => ({ id, title, row, order });
  const item = (id, name, kind, zoneId, col, row, extra = {}) => ({ id, name, kind, zone: zoneId, col, row, ...extra });
  return {
    zones: [
      zone("internet", "Internet", 0, 0),
      zone("edge", "Network edge", 1, 0),
      zone("servers", "Proxmox cluster", 2, 0),
      zone("apps", "Media services", 2, 1)
    ],
    items: [
      item("isp", "ISP", "internet", "internet", 0, 0, { state: "online" }),
      item("router", "Router", "router", "edge", 0, 0, { address: "10.77.0.1", state: "online" }),
      item("switch", "Core switch", "switch", "edge", 1, 0, { address: "10.77.0.2", state: "online" }),
      item("ap", "Access point", "access-point", "edge", 2, 0, { state: "online" }),
      item("pve-1", "pve-1", "host", "servers", 0, 0, { address: "10.77.0.4", source: { type: "node", name: "pve-1" } }),
      item("pve-2", "pve-2", "host", "servers", 1, 0, { address: "10.77.0.5", source: { type: "node", name: "pve-2" } }),
      item("media-vm", "media", "vm", "servers", 0, 1, { source: { type: "guest", vmid: 100 } }),
      item("nvr", "nvr", "lxc", "servers", 1, 1, { source: { type: "guest", vmid: 201 } }),
      item("jellyfin", "Jellyfin", "service", "apps", 0, 0, { source: { type: "service", id: "jellyfin" } }),
      item("radarr", "Radarr", "service", "apps", 1, 0, { source: { type: "service", id: "radarr" } }),
      item("sonarr", "Sonarr", "service", "apps", 2, 0, { source: { type: "service", id: "sonarr" } }),
      item("qbit", "qBittorrent", "service", "apps", 0, 1, { source: { type: "service", id: "qbittorrent" } })
    ],
    links: [
      { id: "isp-router", from: "isp", to: "router", kind: "wan", label: "1 Gbps" },
      { id: "router-switch", from: "router", to: "switch", kind: "wired" },
      { id: "switch-ap", from: "switch", to: "ap", kind: "wired" },
      { id: "switch-pve-1", from: "switch", to: "pve-1", kind: "wired" },
      { id: "switch-pve-2", from: "switch", to: "pve-2", kind: "wired" },
      { id: "pve-1-media", from: "pve-1", to: "media-vm", kind: "wired" },
      { id: "pve-2-nvr", from: "pve-2", to: "nvr", kind: "wired" },
      { id: "media-jellyfin", from: "media-vm", to: "jellyfin", kind: "flow" },
      { id: "media-radarr", from: "media-vm", to: "radarr", kind: "flow" },
      { id: "media-sonarr", from: "media-vm", to: "sonarr", kind: "flow" },
      { id: "media-qbit", from: "media-vm", to: "qbit", kind: "flow" }
    ]
  };
}

async function configure(context) {
  const claim = await expectOk(apiRequest(context, "/api/v2/setup/claim", "POST", {
    setupToken: context.broker.setupToken,
    deviceName: "Demo setup",
    origin: context.origin,
    allowedCidrs: [DEMO_SUBNET],
    allowPublicHttps: false
  }), "Setup claim");
  const auth = { cookie: cookieFrom(claim), csrf: claim.json.csrfToken };

  for (const [service, url, authMode, credential] of MEDIA_CONNECTIONS) {
    await expectOk(apiRequest(context, `/api/v2/services/${service}`, "PUT", {
      url,
      authMode,
      credential,
      clearCredential: false,
      monitoringEnabled: true
    }, auth), `Saving the ${service} connection`);
  }

  const enrolled = await expectOk(apiRequest(context, "/api/v2/auth/jellyfin/enroll", "POST", {
    username: DEMO_USERNAME,
    password: demoPassword,
    deviceName: "Demo setup",
    origin: context.origin
  }, auth), "Jellyfin owner enrollment");
  const owner = { cookie: cookieFrom(enrolled), csrf: enrolled.json.csrfToken || auth.csrf };

  await expectOk(apiRequest(context, "/api/v2/infrastructure/targets", "POST", {
    type: "proxmox",
    displayName: "Demo cluster",
    url: "https://pve.helmsman-demo.test:8006",
    enabled: true,
    monitoringEnabled: true,
    monitoringIntervalSeconds: 60,
    tlsMode: "system",
    certificateFingerprint: "",
    credentials: { tokenId: "helmsman@pve!demo", tokenSecret: randomUUID() }
  }, owner), "Adding the Proxmox environment");

  await expectOk(apiRequest(context, "/api/v2/infrastructure/services", "POST", {
    type: "portainer",
    displayName: "Demo Portainer",
    url: "https://portainer.helmsman-demo.test:9443",
    enabled: true,
    monitoringEnabled: true,
    tlsMode: "system",
    certificateFingerprint: "",
    credentials: { accessToken: "ptr_demo_access_token" }
  }, owner), "Adding Portainer");

  const manual = await expectOk(apiRequest(context, "/api/v2/manual", "GET", undefined, owner), "Reading the manual");
  await expectOk(apiRequest(context, "/api/v2/manual", "PUT", {
    markdown: MANUAL_TEMPLATE,
    revision: manual.json?.manual?.revision ?? null
  }, owner), "Saving the sample manual");

  const map = await expectOk(apiRequest(context, "/api/v2/network-map", "GET", undefined, owner), "Reading the network map");
  await expectOk(apiRequest(context, "/api/v2/network-map", "PUT", {
    map: demoNetworkMap(),
    revision: map.json?.networkMap?.revision ?? null
  }, owner), "Saving the sample network map");

  // With a real model the agent still points at the demo host; the demo
  // forwards those calls (see forwardToRealModel).
  await expectOk(apiRequest(context, "/api/v2/agent/ai", "PUT", {
    url: "http://ai.helmsman-demo.test:11434",
    model: realModel ? realModel.model : DEMO_MODEL,
    contextTokens: realModel ? realModel.contextTokens : 4096,
    timeoutSeconds: realModel ? 240 : 30
  }, owner), realModel ? `Connecting the model ${realModel.model}` : "Connecting the demo model");
  await expectOk(apiRequest(context, "/api/v2/agent/notify", "PUT", {
    url: "http://ha.helmsman-demo.test:8123",
    service: DEMO_NOTIFY_SERVICE,
    token: DEMO_HA_TOKEN
  }, owner), "Connecting the demo Home Assistant");
  const portainerServer = (await expectOk(apiRequest(context, "/api/v2/infrastructure/services", "GET", undefined, owner), "Reading Portainer"))
    .json.services.find((service) => service.type === "portainer");
  const restartRule = (service, cooldownMinutes, maxPerDay) => ({
    id: `restart-${service}`,
    enabled: true,
    when: { service, minutes: 1 },
    then: { kind: "container", serviceId: portainerServer.id, containerName: service, operation: "restart" },
    cooldownMinutes,
    maxPerDay
  });
  await expectOk(apiRequest(context, "/api/v2/agent/rules", "PUT", {
    rules: [context.showcase ? restartRule("sonarr", 10, 10) : restartRule("sonarr", 30, 3)]
  }, owner), "Adding the sample agent rules");
  if (context.showcase) {
    // The policies the chaos scenarios exercise, at their quickest settings.
    await expectOk(apiRequest(context, "/api/v2/agent/container-health", "PUT", {
      enabled: true, scope: "only", containers: ["jellyfin", "qbittorrent", "seerr"], minutes: 1, repeatCount: 3, repeatHours: 24
    }, owner), "Turning on container health");
    await expectOk(apiRequest(context, "/api/v2/agent/downloads", "PUT", {
      enabled: true, minutes: 10, automatic: true
    }, owner), "Turning on stuck-download clean-up");
    await expectOk(apiRequest(context, "/api/v2/agent/indexers", "PUT", {
      enabled: true, tests: 2, spacingMinutes: 5
    }, owner), "Turning on indexer testing");
  }
  await expectOk(apiRequest(context, "/api/v2/agent/settings", "PUT", {
    enabled: true,
    timeZone: "America/New_York",
    autonomy: context.autonomy !== false
  }, owner), "Turning the agent on");

  await expectOk(apiRequest(context, "/api/v2/operations/refresh", "POST", {}, owner), "First monitoring cycle");
  // The setup browser session is not needed once everything is saved.
  await apiRequest(context, "/api/v2/session", "DELETE", {}, owner).catch(() => {});
}

// -------------------------------------------------------------------- main --

/**
 * Starts the demo and returns once it is configured. Used by `npm run demo`
 * and by tests/demo.test.mjs, which keeps the demo working as the API changes.
 */
export async function startDemo(options = {}) {
  const port = options.port ?? 4180;
  // Module state is set per start, so tests can start demos one after another.
  demoPassword = options.password || DEFAULT_DEMO_PASSWORD;
  realModel = options.modelUrl
    ? { url: validModelUrl(options.modelUrl), model: options.model, contextTokens: options.modelContextTokens || 8_192 }
    : null;
  // Showcase listens on every interface for a reverse proxy or a LAN peer.
  // Setup still runs over loopback, which first-time setup requires.
  const host = options.showcase ? "0.0.0.0" : "127.0.0.1";
  let dataDir;
  let temporary = false;
  if (options.data) {
    dataDir = path.resolve(options.data);
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
  } else {
    dataDir = await mkdtemp(path.join(os.tmpdir(), "helmsman-demo-"));
    temporary = true;
  }

  const broker = await createBroker({
    dataDir,
    rootDir: PROJECT_ROOT,
    lookup,
    dispatchUpstream,
    dispatchMediaAction,
    dispatchProxmox,
    dispatchPortainer,
    dispatchAgent,
    ...(options.monitorIntervalMs ? { monitorIntervalMs: options.monitorIntervalMs } : {}),
    log: (message) => {
      if (process.env.HELMSMAN_DEMO_VERBOSE) process.stdout.write(`${message}\n`);
    }
  });
  const server = createHttpServer(broker.handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const actualPort = server.address().port;
  const context = {
    broker,
    port: actualPort,
    origin: `http://127.0.0.1:${actualPort}`,
    autonomy: options.autonomy,
    showcase: Boolean(options.showcase)
  };

  let stopped = null;
  let chaos = null;
  const stop = () => {
    stopped ??= (async () => {
      chaos?.stop();
      broker.beginShutdown();
      await new Promise((resolve) => server.close(resolve));
      await broker.drain();
      if (temporary) await rm(dataDir, { recursive: true, force: true });
    })();
    return stopped;
  };

  try {
    if (broker.setupToken) await configure(context);
  } catch (error) {
    await stop();
    throw error;
  }
  if (options.chaosMinutes) {
    chaos = startChaos({ everyMinutes: options.chaosMinutes, log: options.chaosLog || (() => {}) });
  }
  return {
    ...context,
    dataDir,
    temporary,
    username: DEMO_USERNAME,
    password: demoPassword,
    host,
    showcase: context.showcase,
    chaos: () => chaos?.status() ?? null,
    stop,
    breakService,
    makeUnhealthy,
    stallDownload,
    failIndexer,
    recoverIndexer,
    demoIndexerSecret: DEMO_INDEXER_SECRET,
    notifications,
    printNotifications(value = true) { demoPrintNotifications = value; }
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  // Like the real server, keep recent output for Logs → Server output.
  (await import("../server/diagnostics.mjs")).installOutputCapture();
  if (options.help) {
    process.stdout.write([
      "Usage: npm run demo -- [--port 4180] [--data DIR] [--outage]",
      "       npm run demo -- --showcase [--model-url URL --model NAME] [--chaos-minutes 4]",
      "",
      "Runs Helmsman against built-in fake services on http://127.0.0.1:PORT.",
      `Sign in with ${DEMO_USERNAME} / ${DEFAULT_DEMO_PASSWORD}.`,
      "Without --data, a temporary data directory is created and removed on exit.",
      "--outage stops Sonarr a minute after start so you can watch the agent react.",
      "",
      "--showcase is for showing Helmsman to someone else. It listens on all",
      "interfaces, needs a password of 8+ characters (HELMSMAN_DEMO_PASSWORD or",
      "--password), turns on the agent's container-health, stuck-download and",
      "indexer policies, and stages a new problem every few minutes.",
      "--model-url and --model send the agent's model calls to a real",
      "OpenAI-compatible server, for example Ollama at http://HOST:11434.",
      "--chaos-minutes sets the quiet time between staged problems (1-120).",
      "Every option also has a HELMSMAN_DEMO_* environment variable.",
      ""
    ].join("\n"));
    return;
  }
  const say = (line) => process.stdout.write(`\n  Demo: ${line}\n`);
  const demo = await startDemo({ ...options, chaosLog: say });
  demo.printNotifications(true);
  if (options.outage) {
    setTimeout(() => {
      demo.breakService("sonarr");
      say("Sonarr has been stopped. Watch for the agent's notifications.");
    }, 60_000).unref();
  }
  const shutdown = async () => {
    await demo.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  const where = demo.showcase
    ? `http://<this machine>:${demo.port} (listening on all interfaces; put HTTPS in front before sharing)`
    : demo.origin;
  process.stdout.write([
    "",
    `Helmsman demo is running with built-in fake services${demo.showcase ? " in showcase mode" : ""}.`,
    "",
    `  Open      ${where}`,
    `  Sign in   ${demo.username} / ${demo.showcase ? "(the password you set)" : demo.password}`,
    `  Model     ${realModel ? `${realModel.model} at ${realModel.url}` : "scripted stand-in"}`,
    `  Problems  ${options.chaosMinutes ? `a new one every ~${options.chaosMinutes} min after the last clears` : "none staged"}`,
    `  Data      ${demo.dataDir}${demo.temporary ? " (removed on exit)" : ""}`,
    "",
    "Press Ctrl+C to stop.",
    ""
  ].join("\n"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`Helmsman demo could not start: ${error.message}\n`);
    process.exit(1);
  });
}
