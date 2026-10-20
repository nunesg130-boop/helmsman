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
// This is a development tool. It lives in scripts/, which the container image
// does not include, and it only listens on loopback.

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
const DEMO_PASSWORD = "demo";
const DEMO_SUBNET = "10.77.0.0/24";
const DAY = 86_400_000;

// ---------------------------------------------------------------- options --

function parseArguments(argv) {
  const options = { port: 4180, data: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--port") options.port = Number(argv[++index]);
    else if (argument === "--data") options.data = argv[++index];
    else if (argument === "--outage") options.outage = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`Unknown option ${argument}. Try --help.`);
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) {
    throw new Error("--port must be a TCP port from 1 to 65535.");
  }
  return options;
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
    if (credentials.Username !== DEMO_USERNAME || credentials.Pw !== DEMO_PASSWORD) return { status: 401, json: {} };
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
  if (route?.operation === "blocklistAndSearch") stalledQueues.delete(route.service);
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

async function dispatchAgent({ targetResolution, method, path: requestPath, body, bearerToken }) {
  const host = targetResolution?.target?.hostname;
  if (host === "ai.helmsman-demo.test") {
    if (method === "GET" && requestPath === "/v1/models") return json(200, { object: "list", data: [{ id: DEMO_MODEL }, { id: "qwen2.5:3b" }] });
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
    password: DEMO_PASSWORD,
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

  await expectOk(apiRequest(context, "/api/v2/agent/ai", "PUT", {
    url: "http://ai.helmsman-demo.test:11434",
    model: DEMO_MODEL,
    contextTokens: 4096,
    timeoutSeconds: 30
  }, owner), "Connecting the demo model");
  await expectOk(apiRequest(context, "/api/v2/agent/notify", "PUT", {
    url: "http://ha.helmsman-demo.test:8123",
    service: DEMO_NOTIFY_SERVICE,
    token: DEMO_HA_TOKEN
  }, owner), "Connecting the demo Home Assistant");
  const portainerServer = (await expectOk(apiRequest(context, "/api/v2/infrastructure/services", "GET", undefined, owner), "Reading Portainer"))
    .json.services.find((service) => service.type === "portainer");
  await expectOk(apiRequest(context, "/api/v2/agent/rules", "PUT", {
    rules: [{
      id: "restart-sonarr",
      enabled: true,
      when: { service: "sonarr", minutes: 1 },
      then: { kind: "container", serviceId: portainerServer.id, containerName: "sonarr", operation: "restart" },
      cooldownMinutes: 30,
      maxPerDay: 3
    }]
  }, owner), "Adding the sample agent rule");
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
    server.listen(port, "127.0.0.1", resolve);
  });
  const actualPort = server.address().port;
  const context = { broker, port: actualPort, origin: `http://127.0.0.1:${actualPort}`, autonomy: options.autonomy };

  let stopped = null;
  const stop = () => {
    stopped ??= (async () => {
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
  return {
    ...context,
    dataDir,
    temporary,
    username: DEMO_USERNAME,
    password: DEMO_PASSWORD,
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
      "",
      "Runs Helmsman against built-in fake services on http://127.0.0.1:PORT.",
      `Sign in with ${DEMO_USERNAME} / ${DEMO_PASSWORD}.`,
      "Without --data, a temporary data directory is created and removed on exit.",
      "--outage stops Sonarr a minute after start so you can watch the agent react.",
      ""
    ].join("\n"));
    return;
  }
  const demo = await startDemo(options);
  demo.printNotifications(true);
  if (options.outage) {
    setTimeout(() => {
      demo.breakService("sonarr");
      process.stdout.write("\n  Demo: Sonarr has been stopped. Watch for the agent's notifications.\n");
    }, 60_000).unref();
  }
  const shutdown = async () => {
    await demo.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdout.write([
    "",
    "Helmsman demo is running with built-in fake services.",
    "",
    `  Open      ${demo.origin}`,
    `  Sign in   ${demo.username} / ${demo.password}`,
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
