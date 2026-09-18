import { createHash } from "node:crypto";

export const MEDIA_SCHEMA = 1;

const MAX_LIBRARY_ITEMS = 500;
const MAX_COLLECTION_ITEMS = 200;
const MAX_HOME_ITEMS = 24;
const MAX_TEXT_CODE_POINTS = 180;
const MAX_ERROR_CODE_POINTS = 420;
const MAX_ARTWORK_SOURCES = 4;
const ARTWORK_DESCRIPTOR_VERSION = 4;
const JELLYFIN_IMAGE_TAG = /^[A-Za-z0-9_-]{1,96}$/u;
const ARR_LAST_WRITE = /^[0-9]{1,20}$/u;
const ARR_RESOURCE_ID = /^[1-9][0-9]{0,9}$/u;
const ARR_URL_BASE_SEGMENT = /^(?!\.{1,2}$)[A-Za-z0-9._~-]{1,64}$/u;
const TMDB_IMAGE_PATH = /^\/t\/p\/(?:original|w[1-9][0-9]{1,3})\/([A-Za-z0-9_-]{1,196}\.(?:jpe?g|png|webp))$/iu;
const TARGET_REVISION = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const MEDIA_TYPES = new Set(["movie", "series", "episode"]);
const LIFECYCLE_STEPS = Object.freeze(["requested", "monitored", "downloading", "imported", "available"]);
const SERVICE_PRIORITY = Object.freeze({ jellyfin: 0, radarr: 1, sonarr: 1, seerr: 2 });

function own(value, key) {
  try {
    return value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, key)
      ? value[key]
      : undefined;
  } catch {
    return undefined;
  }
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function list(value, keys = []) {
  if (Array.isArray(value)) return value;
  const source = record(value);
  if (!source) return [];
  for (const key of keys) {
    const candidate = own(source, key);
    if (Array.isArray(candidate)) return candidate;
    const nested = record(candidate);
    if (nested) {
      for (const nestedKey of ["results", "records", "items", "data"]) {
        if (Array.isArray(own(nested, nestedKey))) return own(nested, nestedKey);
      }
    }
  }
  return [];
}

function text(value, maximum = MAX_TEXT_CODE_POINTS) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  let normalized;
  try {
    normalized = String(value).normalize("NFKC");
  } catch {
    return null;
  }
  normalized = normalized
    .replace(/[\p{Cc}\p{Cf}\p{Cs}]+/gu, " ")
    .replace(/</gu, "\u2039")
    .replace(/>/gu, "\u203a")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized) return null;
  const points = Array.from(normalized);
  return points.length <= maximum ? normalized : `${points.slice(0, maximum - 1).join("")}\u2026`;
}

function diagnosticText(value) {
  const normalized = text(value, MAX_ERROR_CODE_POINTS * 4);
  if (!normalized) return null;
  const redacted = normalized
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]+@/giu, "$1[REDACTED]@")
    .replace(/\b((?:authorization|proxy-authorization)\s*(?::|=)\s*)(?:bearer|basic)\s+[^\s,;]+/giu, "$1[REDACTED]")
    .replace(/((?:["']?(?:x[-_ ]?api[-_ ]?key|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|token|password|passwd|pwd|secret|credential|auth|cookie|set-cookie|session(?:id)?)["']?)\s*(?::|=)\s*)(?:["'][^"']*["']|[^\s,;&}]+)/giu,
      "$1[REDACTED]")
    .replace(/\b(?:qbt_|sk-|eyJ)[A-Za-z0-9._~+/-]{10,}={0,2}/gu, "[REDACTED]")
    .replace(/[A-Za-z0-9_+/-]{32,}={0,2}/gu, (candidate) => {
      const core = candidate.replace(/={1,2}$/u, "");
      const mixed = /[a-z]/u.test(core) && /[A-Z]/u.test(core)
        || /[A-Za-z]/u.test(core) && /\d/u.test(core)
        || /[_+/-]/u.test(core);
      return new Set(core.toLowerCase()).size >= 10 && mixed ? "[REDACTED]" : candidate;
    });
  return text(redacted, MAX_ERROR_CODE_POINTS);
}

function identifier(value, maximum = 96) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const normalized = String(value).trim();
  return normalized.length > 0 && normalized.length <= maximum && /^[A-Za-z0-9._:-]+$/u.test(normalized)
    ? normalized
    : null;
}

function positiveInteger(value, maximum = 9_999_999_999) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 && number <= maximum ? number : null;
}

function providerInteger(value, maximum = 9_999_999_999) {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 && value <= maximum ? value : null;
  }
  if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number <= maximum ? number : null;
}

function nonNegativeInteger(value, maximum = 9_999_999_999) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 && number <= maximum ? number : null;
}

function boundedNumber(value, minimum, maximum, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback;
}

function isoDate(value) {
  if (typeof value !== "string" && typeof value !== "number" && !(value instanceof Date)) return null;
  const milliseconds = new Date(value).getTime();
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function mediaType(value, fallback = null) {
  const token = String(value || "").trim().toLowerCase();
  const aliases = { tv: "series", show: "series", season: "series" };
  const normalized = aliases[token] || token;
  return MEDIA_TYPES.has(normalized) ? normalized : fallback;
}

function providerIds(sourceValue) {
  const source = record(sourceValue) || {};
  const nested = record(own(source, "ProviderIds")) || record(own(source, "providerIds")) || {};
  const tmdb = providerInteger(
    own(source, "tmdbId") ?? own(source, "tmdb_id")
    ?? own(nested, "Tmdb") ?? own(nested, "TMDB") ?? own(nested, "tmdb") ?? own(nested, "TheMovieDb")
  );
  const tvdb = providerInteger(
    own(source, "tvdbId") ?? own(source, "tvdb_id") ?? own(nested, "Tvdb") ?? own(nested, "TVDB") ?? own(nested, "tvdb")
  );
  const imdbCandidate = own(source, "imdbId") ?? own(source, "imdb_id")
    ?? own(nested, "Imdb") ?? own(nested, "IMDB") ?? own(nested, "imdb");
  const imdbText = typeof imdbCandidate === "string" ? imdbCandidate.trim().toLowerCase() : "";
  const imdb = /^tt[0-9]{5,12}$/u.test(imdbText) ? imdbText : null;
  return { ...(tmdb ? { tmdb } : {}), ...(tvdb ? { tvdb } : {}), ...(imdb ? { imdb } : {}) };
}

function sourceIdFor(service, value) {
  if (["radarr", "sonarr", "seerr", "bazarr"].includes(service)) {
    const number = positiveInteger(value);
    return number ? String(number) : null;
  }
  if (service === "jellyfin") {
    const id = identifier(value, 80);
    return id && /^[A-Za-z0-9_-]+$/u.test(id) ? id : null;
  }
  if (service === "qbittorrent") {
    const hash = String(value || "").trim().toLowerCase();
    return /^[a-f0-9]{20,64}$/u.test(hash) ? hash : null;
  }
  return identifier(value);
}

function posterFile(value) {
  if (typeof value !== "string") return null;
  const raw = value.split("?")[0].split("/").pop() || "";
  return /^[A-Za-z0-9_-]{1,200}\.(?:jpe?g|png|webp)$/iu.test(raw) ? raw : null;
}

function jellyfinPrimaryTag(itemValue) {
  const item = record(itemValue);
  const tags = record(own(item, "ImageTags")) || record(own(item, "imageTags"));
  const candidate = own(tags, "Primary") ?? own(tags, "primary");
  return jellyfinImageTag(candidate);
}

function jellyfinImageTag(value) {
  return typeof value === "string" && JELLYFIN_IMAGE_TAG.test(value) ? value : null;
}

function jellyfinInheritedPrimaryArtwork(itemValue) {
  const item = record(itemValue);
  if (!item) return null;
  for (const [idKey, tagKey] of [
    ["SeriesId", "SeriesPrimaryImageTag"],
    ["seriesId", "seriesPrimaryImageTag"],
    ["ParentPrimaryImageItemId", "ParentPrimaryImageTag"],
    ["parentPrimaryImageItemId", "parentPrimaryImageTag"]
  ]) {
    const resource = sourceIdFor("jellyfin", own(item, idKey));
    const revision = jellyfinImageTag(own(item, tagKey));
    if (resource && revision) {
      return { service: "jellyfin", kind: "primary", resource, revision, variant: "w342q85" };
    }
  }
  return null;
}

function arrPosterMetadata(itemValue, sourceId) {
  const item = record(itemValue);
  if (!item || !ARR_RESOURCE_ID.test(sourceId || "")) return null;
  const direct = own(item, "lastWrite");
  if ((typeof direct === "string" || typeof direct === "number") && ARR_LAST_WRITE.test(String(direct))) {
    return { revision: String(direct) };
  }
  let posterReported = false;
  for (const imageValue of list(own(item, "images")).slice(0, 24)) {
    const image = record(imageValue);
    if (!image || String(own(image, "coverType") || "").toLowerCase() !== "poster") continue;
    posterReported = true;
    const imageDirect = own(image, "lastWrite");
    if ((typeof imageDirect === "string" || typeof imageDirect === "number")
      && ARR_LAST_WRITE.test(String(imageDirect))) return { revision: String(imageDirect) };
    const candidate = own(image, "url");
    if (typeof candidate !== "string" || candidate.length > 1_024 || !candidate.startsWith("/")) continue;
    let parsed;
    try {
      parsed = new URL(candidate, "http://arr.invalid");
    } catch {
      continue;
    }
    const segments = parsed.pathname.split("/");
    const prefix = segments.slice(1, -3);
    const file = segments.at(-1) || "";
    if (parsed.origin !== "http://arr.invalid"
      || segments[0] !== ""
      || segments.at(-3) !== "MediaCover"
      || segments.at(-2) !== sourceId
      || !/^poster(?:-(?:250|500))?\.(?:jpe?g|png|webp)$/u.test(file)
      || prefix.some((segment) => !ARR_URL_BASE_SEGMENT.test(segment))) continue;
    const fields = [...parsed.searchParams];
    if (fields.length === 0) return {};
    if (fields.length === 1 && fields[0][0] === "lastWrite" && ARR_LAST_WRITE.test(fields[0][1])) {
      return { revision: fields[0][1] };
    }
  }
  // excludeLocalCovers=true deliberately leaves remote poster metadata in the
  // catalog. A reported poster is enough to try the fixed, service-local cover
  // routes; no untrusted remote URL is ever requested directly.
  return posterReported ? {} : null;
}

function tmdbPosterFile(value) {
  if (typeof value !== "string" || value.length > 1_024) return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:"
    || parsed.hostname.toLowerCase() !== "image.tmdb.org"
    || parsed.port
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash) return null;
  return TMDB_IMAGE_PATH.exec(parsed.pathname)?.[1] || null;
}

function arrSeerrArtworkCandidate(itemValue, service) {
  const item = record(itemValue);
  if (!item) return null;
  const remotePoster = tmdbPosterFile(own(item, "remotePoster") ?? own(item, "remote_poster"));
  if (remotePoster) return { service: "seerr", kind: "poster", resource: remotePoster, variant: "w342" };
  for (const imageValue of list(own(item, "images")).slice(0, 24)) {
    const image = record(imageValue);
    if (!image || String(own(image, "coverType") || "").toLowerCase() !== "poster") continue;
    for (const value of [own(image, "remoteUrl"), own(image, "url")]) {
      const file = tmdbPosterFile(value);
      if (file) return { service: "seerr", kind: "poster", resource: file, variant: "w342" };
    }
  }
  // Sonarr normally reports a TVDB remote poster. Never relay that arbitrary
  // URL. A validated TMDb ID can instead be resolved through Seerr's fixed TV
  // detail route when (and only when) the local Sonarr cover misses.
  const tmdbId = service === "sonarr" ? providerIds(item).tmdb : null;
  if (tmdbId) return { service: "seerr", kind: "tv-poster", resource: String(tmdbId), variant: "w342" };
  return null;
}

function seerrRequestArtworkCandidate(type, tmdbId) {
  const resource = sourceIdFor("seerr", tmdbId);
  if (!resource || !["movie", "series"].includes(type)) return null;
  return {
    service: "seerr",
    kind: type === "movie" ? "movie-poster" : "tv-poster",
    resource,
    variant: "w342"
  };
}

function artworkCandidate(service, sourceId, item) {
  if (service === "jellyfin" && sourceId) {
    const revision = jellyfinPrimaryTag(item);
    return revision
      ? { service, kind: "primary", resource: sourceId, revision, variant: "w342q85" }
      : null;
  }
  if (["radarr", "sonarr"].includes(service) && ARR_RESOURCE_ID.test(sourceId || "")) {
    const metadata = arrPosterMetadata(item, sourceId);
    if (!metadata) return null;
    return {
      service,
      kind: "poster",
      resource: sourceId,
      ...metadata,
      variant: "poster-250"
    };
  }
  if (service === "seerr") {
    const file = posterFile(own(item, "posterPath") ?? own(item, "poster_path"));
    if (file) return { service, kind: "poster", resource: file, variant: "w342" };
  }
  return null;
}

function commonItem(service, itemValue, options = {}) {
  const item = record(itemValue);
  if (!item) return null;
  const sourceId = sourceIdFor(service, options.sourceId ?? own(item, "Id") ?? own(item, "id"));
  const ids = providerIds(options.providerSource || item);
  if (!sourceId && !Object.keys(ids).length) return null;
  const type = mediaType(options.mediaType ?? own(item, "Type") ?? own(item, "type") ?? own(item, "mediaType"), options.fallbackType);
  if (!type) return null;
  const title = text(options.title ?? own(item, "Name") ?? own(item, "name") ?? own(item, "title")
    ?? own(item, "originalTitle") ?? own(item, "originalName"));
  if (!title) return null;
  const year = positiveInteger(options.year ?? own(item, "ProductionYear") ?? own(item, "year"), 9999);
  const artwork = artworkCandidate(service, sourceId, item);
  const artworkFallback = ["radarr", "sonarr"].includes(service) ? arrSeerrArtworkCandidate(item, service) : null;
  return {
    service,
    sourceId: sourceId || `${type}:${Object.entries(ids)[0].join(":")}`,
    mediaType: type,
    title,
    ...(options.titleFallback === true ? { titleFallback: true } : {}),
    year,
    providerIds: ids,
    ...(artwork ? { artwork } : {}),
    ...(artworkFallback ? { artworkFallback } : {})
  };
}

function jellyfinItems(body, category) {
  return list(body, ["Items", "items"]).slice(0, MAX_LIBRARY_ITEMS).flatMap((itemValue) => {
    const item = record(itemValue);
    if (!item) return [];
    const common = commonItem("jellyfin", item, {
      fallbackType: category === "nextUp" || category === "resume" ? "episode" : null,
      title: own(item, "SeriesName") ?? own(item, "Name")
    });
    if (!common) return [];
    const userData = record(own(item, "UserData")) || {};
    const playedPercent = boundedNumber(own(userData, "PlayedPercentage"), 0, 100);
    const runtimeTicks = boundedNumber(own(item, "RunTimeTicks"), 0, Number.MAX_SAFE_INTEGER);
    const positionTicks = boundedNumber(own(userData, "PlaybackPositionTicks"), 0, Number.MAX_SAFE_INTEGER);
    const progress = playedPercent ?? (runtimeTicks > 0 && positionTicks !== null
      ? boundedNumber(positionTicks / runtimeTicks * 100, 0, 100)
      : null);
    const useBaseCover = ["resume", "nextUp"].includes(category) && common.mediaType === "episode";
    const seriesSourceId = useBaseCover
      ? sourceIdFor("jellyfin", own(item, "SeriesId") ?? own(item, "seriesId"))
      : null;
    const homeArtwork = useBaseCover ? jellyfinInheritedPrimaryArtwork(item) : null;
    return [{
      ...common,
      available: true,
      addedAt: isoDate(own(item, "DateCreated")),
      releaseAt: isoDate(own(item, "PremiereDate")),
      ...(progress !== null ? { progress: Math.round(progress * 10) / 10 } : {}),
      ...(seriesSourceId ? { seriesSourceId } : {}),
      ...(homeArtwork ? { homeArtwork } : {}),
      ...(category ? { category } : {})
    }];
  });
}

function jellyfinSessions(body) {
  if (!Array.isArray(body)) return [];
  const nowPlaying = [];
  const seen = new Set();
  for (const sessionValue of body.slice(0, MAX_COLLECTION_ITEMS)) {
    const session = record(sessionValue);
    const item = record(own(session, "NowPlayingItem"));
    const playState = record(own(session, "PlayState")) || {};
    if (!item) continue;
    const type = mediaType(own(item, "Type"));
    if (!type) continue;
    const common = commonItem("jellyfin", item, {
      mediaType: type,
      title: own(item, "SeriesName") ?? own(item, "Name")
    });
    if (!common || seen.has(common.sourceId)) continue;
    seen.add(common.sourceId);
    const seriesSourceId = common.mediaType === "episode"
      ? sourceIdFor("jellyfin", own(item, "SeriesId") ?? own(item, "seriesId"))
      : null;
    const runtimeTicks = boundedNumber(own(item, "RunTimeTicks"), 0, Number.MAX_SAFE_INTEGER);
    const positionTicks = boundedNumber(own(playState, "PositionTicks"), 0, Number.MAX_SAFE_INTEGER);
    const progress = runtimeTicks > 0 && positionTicks !== null
      ? boundedNumber(positionTicks / runtimeTicks * 100, 0, 100)
      : null;
    nowPlaying.push({
      ...common,
      available: true,
      state: own(playState, "IsPaused") === true ? "paused" : "playing",
      ...(progress !== null ? { progress: Math.round(progress * 10) / 10 } : {}),
      episodeTitle: common.mediaType === "episode" ? text(own(item, "Name")) : null,
      seasonNumber: boundedNumber(own(item, "ParentIndexNumber"), 0, 10_000),
      episodeNumber: boundedNumber(own(item, "IndexNumber"), 0, 100_000),
      ...(seriesSourceId ? { seriesSourceId } : {})
    });
  }
  return nowPlaying;
}

function enumToken(value) {
  return String(value ?? "")
    .trim()
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .replace(/[\s-]+/gu, "_")
    .toLowerCase();
}

function seerrRequestStatus(value) {
  const token = enumToken(value);
  return {
    "1": "pending",
    "2": "approved",
    "3": "declined",
    "4": "failed",
    "5": "completed",
    pending: "pending",
    approved: "approved",
    declined: "declined",
    failed: "failed",
    completed: "completed"
  }[token] || "unknown";
}

function seerrMediaStatus(value, fallback = "unknown") {
  const token = enumToken(value);
  return {
    "1": "unknown",
    "2": "pending",
    "3": "processing",
    "4": "partially_available",
    "5": "available",
    "6": "blocklisted",
    "7": "deleted",
    unknown: "unknown",
    pending: "pending",
    processing: "processing",
    partially_available: "partially_available",
    partiallyavailable: "partially_available",
    available: "available",
    blocklisted: "blocklisted",
    deleted: "deleted"
  }[token] || fallback;
}

function seerrRequestedSeasonStatuses(request, media, is4k = false) {
  const output = [];
  const seen = new Set();
  const availability = new Map();
  for (const value of list(own(media, "seasons")).slice(0, MAX_COLLECTION_ITEMS)) {
    const season = record(value);
    const seasonNumber = nonNegativeInteger(own(season, "seasonNumber"), 10_000);
    if (!season || seasonNumber === null || availability.has(seasonNumber)) continue;
    availability.set(seasonNumber, season);
  }
  for (const value of list(own(request, "seasons")).slice(0, MAX_COLLECTION_ITEMS)) {
    const requestedSeason = record(value);
    const seasonNumber = nonNegativeInteger(requestedSeason ? own(requestedSeason, "seasonNumber") : value, 10_000);
    if (seasonNumber === null || seen.has(seasonNumber)) continue;
    seen.add(seasonNumber);
    const season = availability.get(seasonNumber);
    output.push({
      seasonNumber,
      status: season
        ? seerrMediaStatus(is4k ? own(season, "status4k") : own(season, "status"))
        : "unknown"
    });
  }
  return output.sort((left, right) => left.seasonNumber - right.seasonNumber);
}

function normalizedSeerrSeasonStatuses(value) {
  const output = [];
  const seen = new Set();
  for (const entryValue of Array.isArray(value) ? value.slice(0, MAX_COLLECTION_ITEMS) : []) {
    const entry = record(entryValue);
    const seasonNumber = nonNegativeInteger(own(entry, "seasonNumber"), 10_000);
    if (!entry || seasonNumber === null || seen.has(seasonNumber)) continue;
    seen.add(seasonNumber);
    output.push({ seasonNumber, status: seerrMediaStatus(own(entry, "status")) });
  }
  return output.sort((left, right) => left.seasonNumber - right.seasonNumber);
}

function seerrRequests(body) {
  return list(body, ["results", "requests"]).slice(0, MAX_COLLECTION_ITEMS).flatMap((requestValue) => {
    const request = record(requestValue);
    const media = record(own(request, "media")) || request;
    if (!request || !media) return [];
    const id = positiveInteger(own(request, "id"));
    const tmdbId = positiveInteger(own(media, "tmdbId") ?? own(media, "tmdb_id"));
    const type = mediaType(own(media, "mediaType") ?? own(request, "type"));
    const suppliedTitle = text(
      own(media, "title") ?? own(media, "name") ?? own(media, "originalTitle") ?? own(media, "originalName")
      ?? own(request, "title") ?? own(request, "name") ?? own(request, "originalTitle") ?? own(request, "originalName")
    );
    const requestState = seerrRequestStatus(own(request, "status"));
    const mediaState = seerrMediaStatus(
      own(request, "is4k") === true ? own(media, "status4k") : own(media, "status")
    );
    const common = commonItem("seerr", media, {
      sourceId: id,
      mediaType: type,
      // The request list intentionally contains workflow data rather than
      // display metadata. A typed Seerr detail lookup normally replaces this
      // fallback; retaining the provider ID still makes a failed lookup
      // identifiable instead of rendering several indistinguishable rows.
      title: suppliedTitle || `${type === "movie" ? "Movie" : "Series"} · TMDb ${tmdbId}`,
      titleFallback: !suppliedTitle,
      providerSource: media
    });
    if (!common || !id || !tmdbId) return [];
    const artworkFallback = common.artwork ? null : seerrRequestArtworkCandidate(type, tmdbId);
    const is4k = own(request, "is4k") === true;
    const seasonStatuses = type === "series" ? seerrRequestedSeasonStatuses(request, media, is4k) : [];
    return [{
      ...common,
      id: `seerr-request:${id}`,
      requestId: id,
      status: requestState,
      requestStatus: requestState,
      mediaStatus: mediaState,
      is4k,
      requestedSeasons: seasonStatuses.map(({ seasonNumber }) => seasonNumber),
      seasonStatuses,
      requestedAt: isoDate(own(request, "createdAt") ?? own(request, "updatedAt")),
      requested: true,
      ...(artworkFallback ? { artworkFallback } : {})
    }];
  });
}

function seerrDiscover(body) {
  return list(body, ["results"]).slice(0, MAX_COLLECTION_ITEMS).flatMap((itemValue) => {
    const item = record(itemValue);
    if (!item) return [];
    const tmdb = positiveInteger(own(item, "id"));
    const type = mediaType(own(item, "mediaType") ?? own(item, "media_type"));
    if (!tmdb || !type) return [];
    const mediaInfo = record(own(item, "mediaInfo"));
    const status = mediaInfo
      ? seerrMediaStatus(own(mediaInfo, "status"))
      : "not_requested";
    const suppliedTitle = own(item, "title") ?? own(item, "name") ?? own(item, "originalTitle") ?? own(item, "originalName");
    if (!text(suppliedTitle)) return [];
    const common = commonItem("seerr", { ...item, tmdbId: tmdb }, {
      sourceId: tmdb,
      mediaType: type,
      title: suppliedTitle,
      year: String(own(item, "releaseDate") ?? own(item, "release_date") ?? own(item, "firstAirDate") ?? own(item, "first_air_date") ?? "").slice(0, 4)
    });
    if (!common) return [];
    return [{
      ...common,
      state: status,
      mediaStatus: status,
      overview: text(own(item, "overview"), 500),
      releaseAt: isoDate(own(item, "releaseDate") ?? own(item, "release_date") ?? own(item, "firstAirDate") ?? own(item, "first_air_date")),
      rating: boundedNumber(own(item, "voteAverage") ?? own(item, "vote_average"), 0, 10)
    }];
  });
}

function arrLibrary(service, body) {
  const fallbackType = service === "radarr" ? "movie" : "series";
  return list(body, ["records", "items"]).slice(0, MAX_LIBRARY_ITEMS).flatMap((itemValue) => {
    const item = record(itemValue);
    if (!item) return [];
    const common = commonItem(service, item, { fallbackType });
    if (!common) return [];
    const statistics = record(own(item, "statistics")) || {};
    const imported = service === "radarr"
      ? own(item, "hasFile") === true
      : boundedNumber(own(statistics, "episodeFileCount"), 0, 100_000, 0) > 0;
    return [{
      ...common,
      monitored: own(item, "monitored") === true,
      imported,
      addedAt: isoDate(own(item, "added")),
      releaseAt: isoDate(own(item, "digitalRelease") ?? own(item, "physicalRelease") ?? own(item, "inCinemas") ?? own(item, "firstAired")),
      missingCount: service === "sonarr"
        ? positiveInteger(own(statistics, "episodeCount")) !== null
          ? Math.max(0, positiveInteger(own(statistics, "episodeCount")) - (positiveInteger(own(statistics, "episodeFileCount")) || 0))
          : null
        : own(item, "monitored") === true && own(item, "isAvailable") === true && !imported ? 1 : 0
    }];
  });
}

function statusMessage(item) {
  const direct = diagnosticText(own(item, "errorMessage") ?? own(item, "statusMessage"));
  if (direct) return direct;
  const statusMessages = list(own(item, "statusMessages"), ["messages"]);
  for (const groupValue of statusMessages.slice(0, 8)) {
    const group = record(groupValue);
    const messages = Array.isArray(own(group, "messages")) ? own(group, "messages") : [own(group, "message")];
    for (const messageValue of messages.slice(0, 8)) {
      const message = record(messageValue);
      const normalized = diagnosticText(own(message, "title") ?? own(message, "message") ?? messageValue);
      if (normalized) return normalized;
    }
  }
  return null;
}

function downloadHash(value) {
  const hash = String(value || "").trim().toLowerCase();
  return /^[a-f0-9]{20,64}$/u.test(hash) ? hash : null;
}

function durationSeconds(value) {
  if (typeof value === "number") return Math.round(boundedNumber(value, 0, 31_536_000, 0));
  if (typeof value !== "string") return null;
  const match = /^(?:(\d+)\.)?(\d{1,2}):(\d{2}):(\d{2})$/u.exec(value.trim());
  if (!match) return null;
  return Math.min(31_536_000, Number(match[1] || 0) * 86_400 + Number(match[2]) * 3_600 + Number(match[3]) * 60 + Number(match[4]));
}

function arrQueue(service, body) {
  return list(body, ["records", "items"]).slice(0, MAX_COLLECTION_ITEMS).flatMap((itemValue) => {
    const item = record(itemValue);
    if (!item) return [];
    const nestedMedia = record(own(item, service === "radarr" ? "movie" : "series")) || item;
    const hash = downloadHash(own(item, "downloadId"));
    const common = commonItem(service, nestedMedia, {
      sourceId: own(nestedMedia, "id"),
      fallbackType: service === "radarr" ? "movie" : "series",
      title: own(nestedMedia, "title") ?? own(item, "title"),
      providerSource: nestedMedia
    });
    if (!common && !hash) return [];
    const size = boundedNumber(own(item, "size"), 0, Number.MAX_SAFE_INTEGER);
    const remaining = boundedNumber(own(item, "sizeleft") ?? own(item, "sizeLeft"), 0, Number.MAX_SAFE_INTEGER);
    const progress = size > 0 && remaining !== null ? boundedNumber((size - remaining) / size * 100, 0, 100) : null;
    return [{
      ...(common || {
        service,
        sourceId: hash,
        mediaType: service === "radarr" ? "movie" : "series",
        title: text(own(item, "title")) || "Unknown download",
        year: null,
        providerIds: {}
      }),
      id: identifier(own(item, "id")) || hash,
      ...(positiveInteger(own(item, "id"), 2_147_483_647) ? { queueId: positiveInteger(own(item, "id"), 2_147_483_647) } : {}),
      downloadId: hash,
      state: text(own(item, "trackedDownloadState") ?? own(item, "trackedDownloadStatus") ?? own(item, "status"), 64)?.toLowerCase() || "unknown",
      ...(progress !== null ? { progress: Math.round(progress * 10) / 10 } : {}),
      etaSeconds: durationSeconds(own(item, "timeleft") ?? own(item, "timeLeft")),
      error: statusMessage(item)
    }];
  });
}

function arrCalendar(service, body) {
  const fallbackType = service === "radarr" ? "movie" : "episode";
  return list(body, ["records", "items"]).slice(0, MAX_COLLECTION_ITEMS).flatMap((itemValue) => {
    const item = record(itemValue);
    if (!item) return [];
    const series = record(own(item, "series"));
    const media = service === "sonarr" ? item : series || item;
    const common = commonItem(service, media, {
      sourceId: own(item, "id"),
      fallbackType,
      title: own(series, "title") ?? own(item, "title"),
      providerSource: media
    });
    if (!common) return [];
    const releaseAt = isoDate(
      own(item, "airDateUtc")
      ?? own(item, "airDate")
      ?? own(item, "digitalRelease")
      ?? own(item, "physicalRelease")
      ?? own(item, "inCinemas")
      ?? own(item, "releaseDate")
    );
    if (!releaseAt) return [];
    const seriesSourceId = service === "sonarr"
      ? sourceIdFor("sonarr", own(series, "id") ?? own(item, "seriesId"))
      : null;
    const seriesArtwork = seriesSourceId ? artworkCandidate("sonarr", seriesSourceId, series) : null;
    const seriesArtworkFallback = seriesSourceId ? arrSeerrArtworkCandidate(series, "sonarr") : null;
    const episodeTitle = service === "sonarr" ? text(own(item, "title")) : null;
    return [{
      ...common,
      ...(seriesArtwork ? { artwork: seriesArtwork } : {}),
      ...(seriesArtworkFallback ? { artworkFallback: seriesArtworkFallback } : {}),
      ...(series ? { parentProviderIds: providerIds(series) } : {}),
      ...(seriesSourceId ? { seriesSourceId } : {}),
      id: `${service}-calendar:${common.sourceId}`,
      releaseAt,
      state: own(item, "hasFile") === true ? "imported" : "upcoming",
      monitored: own(item, "monitored") === true || own(series, "monitored") === true,
      imported: own(item, "hasFile") === true,
      episodeTitle: episodeTitle && episodeTitle !== common.title ? episodeTitle : null,
      seasonNumber: boundedNumber(own(item, "seasonNumber"), 0, 10_000),
      episodeNumber: boundedNumber(own(item, "episodeNumber"), 0, 100_000)
    }];
  });
}

function qbitTorrents(body) {
  return list(body).slice(0, MAX_COLLECTION_ITEMS).flatMap((itemValue) => {
    const item = record(itemValue);
    if (!item) return [];
    const hash = downloadHash(own(item, "hash"));
    const name = text(own(item, "name"));
    if (!hash || !name) return [];
    return [{
      service: "qbittorrent",
      sourceId: hash,
      id: hash,
      downloadId: hash,
      mediaType: null,
      title: name,
      providerIds: {},
      state: text(own(item, "state"), 64)?.toLowerCase() || "unknown",
      progress: Math.round(boundedNumber(own(item, "progress"), 0, 1, 0) * 1_000) / 10,
      downloadSpeedBps: Math.round(boundedNumber(own(item, "dlspeed") ?? own(item, "downloadSpeed"), 0, Number.MAX_SAFE_INTEGER, 0)),
      uploadSpeedBps: Math.round(boundedNumber(own(item, "upspeed") ?? own(item, "uploadSpeed"), 0, Number.MAX_SAFE_INTEGER, 0)),
      etaSeconds: Math.round(boundedNumber(own(item, "eta"), 0, 31_536_000, 0)),
      sizeBytes: Math.round(boundedNumber(own(item, "size") ?? own(item, "total_size"), 0, Number.MAX_SAFE_INTEGER, 0))
    }];
  });
}

function bazarrWanted(body, fallbackType) {
  return list(body, ["data", "records", "items"]).slice(0, MAX_COLLECTION_ITEMS).flatMap((itemValue) => {
    const item = record(itemValue);
    if (!item) return [];
    const idValue = own(item, "id") ?? own(item, fallbackType === "movie" ? "radarrId" : "sonarrEpisodeId")
      ?? own(item, fallbackType === "movie" ? "radarr_id" : "sonarr_episode_id");
    const common = commonItem("bazarr", item, {
      sourceId: idValue,
      fallbackType,
      title: own(item, "title") ?? own(item, "seriesTitle") ?? own(item, "series_title")
    });
    if (!common) return [];
    const missing = Array.isArray(own(item, "missing_subtitles"))
      ? own(item, "missing_subtitles")
      : Array.isArray(own(item, "missingSubtitles")) ? own(item, "missingSubtitles") : [];
    return [{
      ...common,
      id: `${fallbackType}:${common.sourceId}`,
      missingLanguages: missing.slice(0, 24).map((entry) => text(record(entry)?.name ?? entry, 40)).filter(Boolean),
      seasonNumber: boundedNumber(own(item, "season") ?? own(item, "season_number"), 0, 10_000),
      episodeNumber: boundedNumber(own(item, "episode") ?? own(item, "episode_number"), 0, 100_000)
    }];
  });
}

/** Converts exactly one fixed read-only probe response to bounded media inventory. */
export function inventoryFromProbeBody(service, checkId, body) {
  if (service === "jellyfin" && ["library", "latest", "resume", "nextUp"].includes(checkId)) {
    return { [checkId]: jellyfinItems(body, checkId) };
  }
  if (service === "jellyfin" && checkId === "sessions") return { nowPlaying: jellyfinSessions(body) };
  if (service === "seerr" && checkId === "requests") return { requests: seerrRequests(body) };
  if (service === "seerr" && checkId === "trending") return { discover: seerrDiscover(body) };
  if (["radarr", "sonarr"].includes(service) && checkId === "catalog") return { library: arrLibrary(service, body) };
  if (["radarr", "sonarr"].includes(service) && checkId === "queue") return { activity: arrQueue(service, body) };
  if (["radarr", "sonarr"].includes(service) && checkId === "calendar") return { calendar: arrCalendar(service, body) };
  if (service === "qbittorrent" && checkId === "torrents") return { activity: qbitTorrents(body) };
  if (service === "bazarr" && checkId === "wantedMovies") return { subtitleBacklog: bazarrWanted(body, "movie") };
  if (service === "bazarr" && checkId === "wantedEpisodes") return { subtitleBacklog: bazarrWanted(body, "episode") };
  return {};
}

function copyInventoryItem(value) {
  // All callers feed the normalized output above. A JSON round trip drops
  // prototypes/accessors and ensures later adapters cannot mutate a cycle.
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

/** Re-bounds inventory at the monitor trust boundary. */
export function normalizeServiceMediaInventory(service, value) {
  const source = record(value) || {};
  const limits = {
    library: MAX_LIBRARY_ITEMS,
    latest: MAX_COLLECTION_ITEMS,
    resume: MAX_COLLECTION_ITEMS,
    nextUp: MAX_COLLECTION_ITEMS,
    nowPlaying: MAX_COLLECTION_ITEMS,
    requests: MAX_COLLECTION_ITEMS,
    discover: MAX_COLLECTION_ITEMS,
    activity: MAX_COLLECTION_ITEMS,
    calendar: MAX_COLLECTION_ITEMS,
    subtitleBacklog: MAX_COLLECTION_ITEMS
  };
  const output = {};
  for (const [key, maximum] of Object.entries(limits)) {
    if (!Array.isArray(own(source, key))) continue;
    const normalized = [];
    for (const candidate of own(source, key).slice(0, maximum)) {
      const copied = copyInventoryItem(candidate);
      if (!record(copied) || copied.service !== service) continue;
      const reparsed = revalidateInventoryItem(service, key, copied);
      if (reparsed) normalized.push(reparsed);
    }
    output[key] = normalized;
  }
  return output;
}

function revalidateInventoryItem(service, category, item) {
  const sourceId = sourceIdFor(service, own(item, "sourceId"));
  const ids = providerIds(item);
  if (!sourceId && !Object.keys(ids).length) return null;
  const type = mediaType(own(item, "mediaType"));
  if (!type && category !== "activity") return null;
  const title = text(own(item, "title"));
  if (!title) return null;
  const artwork = record(own(item, "artwork"));
  const jellyfinSeriesSourceId = service === "jellyfin" && type === "episode" && ["resume", "nextUp", "nowPlaying"].includes(category)
    ? sourceIdFor("jellyfin", own(item, "seriesSourceId"))
    : null;
  const sonarrSeriesSourceId = service === "sonarr" && type === "episode" && category === "calendar"
    ? sourceIdFor("sonarr", own(item, "seriesSourceId"))
    : null;
  const seriesSourceId = jellyfinSeriesSourceId || sonarrSeriesSourceId;
  let safeArtwork = null;
  if (service === "jellyfin") {
    safeArtwork = artworkCandidate(service, sourceId, { ImageTags: { Primary: own(artwork, "revision") } });
  } else if (["radarr", "sonarr"].includes(service) && artwork) {
    const resource = sourceIdFor(service, own(artwork, "resource"));
    const expectedResource = sonarrSeriesSourceId || sourceId;
    const rawRevision = own(artwork, "revision");
    const revision = rawRevision === undefined || rawRevision === null || rawRevision === ""
      ? null
      : ARR_LAST_WRITE.test(String(rawRevision)) ? String(rawRevision) : false;
    if (resource
      && resource === expectedResource
      && own(artwork, "service") === service
      && own(artwork, "kind") === "poster"
      && own(artwork, "variant") === "poster-250"
      && revision !== false) {
      safeArtwork = {
        service,
        kind: "poster",
        resource,
        ...(revision ? { revision } : {}),
        variant: "poster-250"
      };
    }
  } else if (service === "seerr") {
    safeArtwork = artworkCandidate(service, sourceId, { posterPath: own(artwork, "resource") });
  }
  const artworkFallback = record(own(item, "artworkFallback"));
  const fallbackFile = posterFile(own(artworkFallback, "resource"));
  const fallbackLookupId = sourceIdFor("seerr", own(artworkFallback, "resource"));
  const safeArtworkFallback = ["radarr", "sonarr"].includes(service)
    && fallbackFile
    && own(artworkFallback, "resource") === fallbackFile
    && own(artworkFallback, "service") === "seerr"
    && own(artworkFallback, "kind") === "poster"
    && own(artworkFallback, "variant") === "w342"
    ? { service: "seerr", kind: "poster", resource: fallbackFile, variant: "w342" }
    : service === "sonarr"
      && fallbackLookupId
      && own(artworkFallback, "service") === "seerr"
      && own(artworkFallback, "kind") === "tv-poster"
      && own(artworkFallback, "variant") === "w342"
      ? { service: "seerr", kind: "tv-poster", resource: fallbackLookupId, variant: "w342" }
      : service === "seerr"
        && fallbackLookupId
        && own(artworkFallback, "service") === "seerr"
        && own(artworkFallback, "kind") === (type === "movie" ? "movie-poster" : "tv-poster")
        && own(artworkFallback, "variant") === "w342"
        ? {
            service: "seerr",
            kind: type === "movie" ? "movie-poster" : "tv-poster",
            resource: fallbackLookupId,
            variant: "w342"
          }
      : null;
  const homeArtwork = record(own(item, "homeArtwork"));
  const homeArtworkResource = sourceIdFor("jellyfin", own(homeArtwork, "resource"));
  const safeHomeArtwork = service === "jellyfin" && type === "episode" && ["resume", "nextUp"].includes(category)
    ? artworkCandidate("jellyfin", homeArtworkResource, {
        ImageTags: { Primary: own(homeArtwork, "revision") }
      })
    : null;
  const output = {
    service,
    sourceId: sourceId || `${type}:${Object.entries(ids)[0].join(":")}`,
    mediaType: type,
    title,
    ...(own(item, "titleFallback") === true ? { titleFallback: true } : {}),
    year: positiveInteger(own(item, "year"), 9999),
    providerIds: ids,
    ...(safeArtwork ? { artwork: safeArtwork } : {}),
    ...(safeArtworkFallback ? { artworkFallback: safeArtworkFallback } : {}),
    ...(seriesSourceId ? { seriesSourceId } : {}),
    ...(safeHomeArtwork ? { homeArtwork: safeHomeArtwork } : {})
  };
  const booleans = ["requested", "monitored", "imported", "available"];
  for (const key of booleans) if (own(item, key) === true) output[key] = true;
  for (const key of ["addedAt", "releaseAt", "requestedAt"]) {
    const date = isoDate(own(item, key));
    if (date) output[key] = date;
  }
  for (const [key, min, max] of [
    ["progress", 0, 100], ["downloadSpeedBps", 0, Number.MAX_SAFE_INTEGER],
    ["uploadSpeedBps", 0, Number.MAX_SAFE_INTEGER], ["etaSeconds", 0, 31_536_000],
    ["sizeBytes", 0, Number.MAX_SAFE_INTEGER], ["rating", 0, 10],
    ["missingCount", 0, 100_000], ["seasonNumber", 0, 10_000], ["episodeNumber", 0, 100_000]
  ]) {
    const rawNumber = own(item, key);
    if (rawNumber === null || rawNumber === undefined || rawNumber === "" || typeof rawNumber === "boolean") continue;
    const number = boundedNumber(rawNumber, min, max);
    if (number !== null) output[key] = Math.round(number * 10) / 10;
  }
  for (const [key, maximum] of [["id", 160], ["downloadId", 64], ["state", 64], ["status", 64], ["episodeTitle", 180]]) {
    const normalized = key === "downloadId"
      ? downloadHash(own(item, key))
      : key === "state" && category === "nowPlaying"
        ? (["playing", "paused"].includes(own(item, key)) ? own(item, key) : null)
        : text(own(item, key), maximum);
    if (normalized) output[key] = normalized;
  }
  if (["radarr", "sonarr"].includes(service) && category === "activity") {
    const queueId = positiveInteger(own(item, "queueId"), 2_147_483_647);
    if (queueId) output.queueId = queueId;
  }
  if (service === "seerr") {
    if (category === "requests") {
      const requestId = positiveInteger(own(item, "requestId") ?? own(item, "sourceId"));
      if (!requestId) return null;
      output.id = `seerr-request:${requestId}`;
      output.requestId = requestId;
      output.requestStatus = seerrRequestStatus(own(item, "requestStatus") ?? own(item, "status"));
      output.status = output.requestStatus;
      output.mediaStatus = seerrMediaStatus(own(item, "mediaStatus"));
      output.is4k = own(item, "is4k") === true;
      const seasonStatuses = normalizedSeerrSeasonStatuses(own(item, "seasonStatuses"));
      const requestedSeasons = new Set(seasonStatuses.map(({ seasonNumber }) => seasonNumber));
      for (const value of Array.isArray(own(item, "requestedSeasons"))
        ? own(item, "requestedSeasons").slice(0, MAX_COLLECTION_ITEMS)
        : []) {
        const seasonNumber = nonNegativeInteger(value, 10_000);
        if (seasonNumber !== null) requestedSeasons.add(seasonNumber);
      }
      output.requestedSeasons = [...requestedSeasons].sort((left, right) => left - right);
      output.seasonStatuses = seasonStatuses;
    } else if (category === "discover") {
      output.mediaStatus = seerrMediaStatus(own(item, "mediaStatus"), "not_requested");
      output.state = output.mediaStatus;
    }
  }
  const error = diagnosticText(own(item, "error"));
  if (error) output.error = error;
  const overview = text(own(item, "overview"), 500);
  if (overview) output.overview = overview;
  if (Array.isArray(own(item, "missingLanguages"))) {
    output.missingLanguages = own(item, "missingLanguages").slice(0, 24).map((entry) => text(entry, 40)).filter(Boolean);
  }
  const parentIds = providerIds({ providerIds: own(item, "parentProviderIds") });
  if (Object.keys(parentIds).length) output.parentProviderIds = parentIds;
  return output;
}

function mergeInventory(target, addition) {
  for (const [key, values] of Object.entries(addition)) {
    if (!Array.isArray(values)) continue;
    if (!Array.isArray(target[key])) target[key] = [];
    target[key].push(...values);
  }
}

function identityTokens(item) {
  const type = item.mediaType === "episode" ? "episode" : item.mediaType;
  return Object.entries(item.providerIds || {}).map(([provider, value]) => `${type}:${provider}:${value}`);
}

function parsedParentSeriesEvidence(value) {
  if (typeof value !== "string") return null;
  const [kind, namespace, rawId, ...extra] = value.split(":");
  if (extra.length || !rawId) return null;
  if (kind === "source" && ["jellyfin", "sonarr"].includes(namespace)) {
    const sourceId = sourceIdFor(namespace, rawId);
    return sourceId ? { kind, service: namespace, sourceId } : null;
  }
  if (kind !== "provider" || !["tmdb", "tvdb", "imdb"].includes(namespace)) return null;
  const ids = providerIds({ providerIds: { [namespace]: rawId } });
  return ids[namespace] ? { kind, provider: namespace, providerId: ids[namespace] } : null;
}

function parentSeriesEvidenceTokens(itemValue) {
  const item = record(itemValue);
  if (!item || item.mediaType !== "episode") return new Set();
  const evidence = new Set();
  if (item.parentSeriesEvidence instanceof Set) {
    for (const token of item.parentSeriesEvidence) {
      const parsed = parsedParentSeriesEvidence(token);
      if (parsed) evidence.add(token);
    }
  }
  const seriesService = ["jellyfin", "sonarr"].includes(item.service) ? item.service : null;
  const seriesSourceId = seriesService ? sourceIdFor(seriesService, item.seriesSourceId) : null;
  if (seriesService && seriesSourceId) evidence.add(`source:${seriesService}:${seriesSourceId}`);

  // Jellyfin Resume/Next Up can omit SeriesId while still returning a bounded
  // inherited primary-image descriptor. Its resource is safe parent evidence
  // only when it later resolves to an actual Jellyfin series record; it is
  // never used directly as a Seerr resource ID.
  const inheritedArtwork = record(item.homeArtwork);
  const inheritedSeriesId = item.service === "jellyfin"
    && !seriesSourceId
    && inheritedArtwork?.service === "jellyfin"
    && inheritedArtwork?.kind === "primary"
    ? sourceIdFor("jellyfin", inheritedArtwork.resource)
    : null;
  if (inheritedSeriesId) evidence.add(`source:jellyfin:${inheritedSeriesId}`);

  const parentIds = providerIds({ providerIds: item.parentProviderIds });
  for (const [provider, providerId] of Object.entries(parentIds)) {
    evidence.add(`provider:${provider}:${providerId}`);
  }
  return evidence;
}

function recordKey(item) {
  return identityTokens(item)[0] || `${item.service}:${item.sourceId}`;
}

function canonicalRecordId(item) {
  const order = item.mediaType === "movie" ? ["tmdb", "imdb", "tvdb"] : ["tvdb", "tmdb", "imdb"];
  for (const provider of order) {
    if (item.providerIds?.[provider]) return `${item.mediaType}:${provider}:${item.providerIds[provider]}`;
  }
  return item.id;
}

function lifecycle(recordValue) {
  const record = recordValue;
  const achieved = {
    requested: record.requested === true,
    monitored: record.monitored === true,
    downloading: record.downloading === true,
    imported: record.imported === true,
    available: record.available === true
  };
  let index = -1;
  for (let candidate = 0; candidate < LIFECYCLE_STEPS.length; candidate += 1) {
    if (achieved[LIFECYCLE_STEPS[candidate]]) index = candidate;
  }
  return {
    stage: index >= 0 ? LIFECYCLE_STEPS[index] : "unknown",
    steps: LIFECYCLE_STEPS.map((step, stepIndex) => ({ step, complete: stepIndex <= index }))
  };
}

function mergeTitle(target, item) {
  const source = item.service || item.titleSource;
  const currentPriority = SERVICE_PRIORITY[target.titleSource] ?? 99;
  const nextPriority = SERVICE_PRIORITY[source] ?? 99;
  const currentFallback = target.titleFallback === true;
  const nextFallback = item.titleFallback === true;
  if (!target.title
    || currentFallback && !nextFallback
    || currentFallback === nextFallback && nextPriority < currentPriority) {
    target.title = item.title;
    target.titleSource = source;
    target.titleFallback = nextFallback;
  }
}

function mergeArtworkCandidate(candidates, artwork) {
  const index = candidates.findIndex((candidate) => (
    candidate.service === artwork.service
    && candidate.kind === artwork.kind
    && candidate.resource === artwork.resource
    && candidate.variant === artwork.variant
  ));
  if (index < 0) {
    candidates.push(artwork);
    return;
  }
  if (!candidates[index].revision && artwork.revision) candidates[index] = artwork;
}

function mergeRecordTarget(target, other) {
  mergeTitle(target, other);
  target.year ||= other.year;
  Object.assign(target.providerIds, other.providerIds);
  for (const service of other.sources) if (!target.sources.includes(service)) target.sources.push(service);
  for (const sourceKey of other.sourceKeys) target.sourceKeys.add(sourceKey);
  for (const evidence of other.parentSeriesEvidence) target.parentSeriesEvidence.add(evidence);
  for (const artwork of other.artworkCandidates) mergeArtworkCandidate(target.artworkCandidates, artwork);
  target.requested ||= other.requested;
  target.monitored ||= other.monitored;
  target.downloading ||= other.downloading;
  target.imported ||= other.imported;
  target.available ||= other.available;
  if (other.progress !== null && (target.progress === null || other.progress > target.progress)) target.progress = other.progress;
  if (other.downloadSpeedBps !== null) target.downloadSpeedBps = Math.max(target.downloadSpeedBps || 0, other.downloadSpeedBps);
  if (other.etaSeconds !== null) target.etaSeconds = target.etaSeconds === null ? other.etaSeconds : Math.min(target.etaSeconds, other.etaSeconds);
  if (other.addedAt && (!target.addedAt || other.addedAt > target.addedAt)) target.addedAt = other.addedAt;
  if (other.releaseAt && (!target.releaseAt || other.releaseAt < target.releaseAt)) target.releaseAt = other.releaseAt;
  target.missingCount = Math.max(target.missingCount, other.missingCount);
}

function mediaRecords(inventories) {
  const records = new Map();
  const index = new Map();
  const categories = ["library", "requests", "discover", "activity", "calendar", "resume", "nextUp", "nowPlaying", "latest", "subtitleBacklog"];
  for (const service of ["seerr", "radarr", "sonarr", "jellyfin", "bazarr"]) {
    const inventory = inventories.get(service) || {};
    for (const category of categories) {
      for (const item of inventory[category] || []) {
        if (!item.mediaType) continue;
        const tokens = identityTokens(item);
        const existingKeys = [...new Set(tokens.map((token) => index.get(token)).filter(Boolean))];
        const existingKey = existingKeys[0];
        const key = existingKey || recordKey(item);
        let target = records.get(key);
        if (!target) {
          target = {
            id: key,
            mediaType: item.mediaType,
            title: item.title,
            titleSource: item.service,
            titleFallback: item.titleFallback === true,
            year: item.year || null,
            providerIds: {},
            sources: [],
            sourceKeys: new Set(),
            parentSeriesEvidence: new Set(),
            artworkCandidates: [],
            requested: false,
            monitored: false,
            downloading: false,
            imported: false,
            available: false,
            progress: null,
            downloadSpeedBps: null,
            etaSeconds: null,
            addedAt: null,
            releaseAt: null,
            missingCount: 0
          };
          records.set(key, target);
        }
        for (const duplicateKey of existingKeys.slice(1)) {
          const duplicate = records.get(duplicateKey);
          if (!duplicate || duplicate === target) continue;
          mergeRecordTarget(target, duplicate);
          for (const [token, indexedKey] of index) if (indexedKey === duplicateKey) index.set(token, key);
          records.delete(duplicateKey);
        }
        mergeTitle(target, item);
        target.year ||= item.year || null;
        Object.assign(target.providerIds, item.providerIds);
        if (!target.sources.includes(item.service)) target.sources.push(item.service);
        target.sourceKeys.add(`${item.service}:${item.sourceId}`);
        for (const evidence of parentSeriesEvidenceTokens(item)) target.parentSeriesEvidence.add(evidence);
        if (item.artwork) mergeArtworkCandidate(target.artworkCandidates, item.artwork);
        if (item.artworkFallback) mergeArtworkCandidate(target.artworkCandidates, item.artworkFallback);
        target.requested ||= item.requested === true || category === "requests";
        target.monitored ||= item.monitored === true;
        target.imported ||= item.imported === true;
        target.available ||= item.available === true || item.service === "jellyfin";
        target.downloading ||= category === "activity" && !["completed", "imported"].includes(item.state);
        if (item.progress !== undefined && (target.progress === null || item.progress > target.progress)) target.progress = item.progress;
        if (item.downloadSpeedBps !== undefined) target.downloadSpeedBps = Math.max(target.downloadSpeedBps || 0, item.downloadSpeedBps);
        if (item.etaSeconds !== undefined) target.etaSeconds = target.etaSeconds === null ? item.etaSeconds : Math.min(target.etaSeconds, item.etaSeconds);
        if (item.addedAt && (!target.addedAt || item.addedAt > target.addedAt)) target.addedAt = item.addedAt;
        if (item.releaseAt && (!target.releaseAt || item.releaseAt < target.releaseAt)) target.releaseAt = item.releaseAt;
        target.missingCount = Math.max(target.missingCount, item.missingCount || 0);
        for (const token of tokens) index.set(token, key);
      }
    }
  }
  return [...records.values()].map((entry) => {
    entry.sources.sort((left, right) => (SERVICE_PRIORITY[left] ?? 99) - (SERVICE_PRIORITY[right] ?? 99) || left.localeCompare(right));
    entry.artworkCandidates.sort((left, right) => (SERVICE_PRIORITY[left.service] ?? 99) - (SERVICE_PRIORITY[right.service] ?? 99));
    entry.id = canonicalRecordId(entry);
    entry.lifecycle = lifecycle(entry);
    delete entry.titleSource;
    delete entry.titleFallback;
    return entry;
  }).sort((left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id));
}

function correlateActivity(inventories, records) {
  const qbit = new Map((inventories.get("qbittorrent")?.activity || []).map((item) => [item.downloadId, item]));
  const byIdentity = new Map();
  for (const media of records) for (const token of identityTokens(media)) byIdentity.set(token, media);
  const activity = [];
  for (const service of ["radarr", "sonarr"]) {
    for (const item of inventories.get(service)?.activity || []) {
      const torrent = item.downloadId ? qbit.get(item.downloadId) : null;
      const linked = identityTokens(item).map((token) => byIdentity.get(token)).find(Boolean);
      const state = item.error ? "blocked" : torrent?.state || item.state || "unknown";
      activity.push({
        id: `activity:${service}:${item.id || item.sourceId || item.downloadId}`,
        service,
        mediaId: linked?.id || null,
        mediaType: item.mediaType,
        title: linked?.title || item.title,
        year: linked?.year || item.year || null,
        providerIds: item.providerIds,
        ...(item.queueId ? { queueId: item.queueId } : {}),
        ...(item.queueId ? { queueActionTarget: { service, queueId: item.queueId } } : {}),
        downloadId: item.downloadId || null,
        state,
        progress: torrent?.progress ?? item.progress ?? null,
        downloadSpeedBps: torrent?.downloadSpeedBps ?? 0,
        etaSeconds: torrent?.etaSeconds ?? item.etaSeconds ?? null,
        error: item.error || null,
        artworkUrl: linked?.artworkUrl || null
      });
    }
  }
  const claimed = new Set(activity.map((item) => item.downloadId).filter(Boolean));
  for (const torrent of qbit.values()) {
    if (claimed.has(torrent.downloadId)) continue;
    activity.push({
      id: `activity:qbittorrent:${torrent.downloadId}`,
      service: "qbittorrent",
      mediaId: null,
      mediaType: null,
      title: torrent.title,
      year: null,
      providerIds: {},
      downloadId: torrent.downloadId,
      state: torrent.state,
      progress: torrent.progress,
      downloadSpeedBps: torrent.downloadSpeedBps,
      etaSeconds: torrent.etaSeconds,
      error: null,
      artworkUrl: null
    });
  }
  return activity.slice(0, MAX_COLLECTION_ITEMS);
}

function artworkToken(sources) {
  return createHash("sha256")
    .update(JSON.stringify({ version: ARTWORK_DESCRIPTOR_VERSION, sources }))
    .digest("hex")
    .slice(0, 32);
}

function connectionTargetRevision(connectionRevisions, service) {
  const revisions = record(connectionRevisions);
  const candidate = own(revisions, service);
  return typeof candidate === "string" && TARGET_REVISION.test(candidate) ? candidate : null;
}

function attachArtwork(records, connectionRevisions) {
  const map = {};
  for (const item of records) {
    item.artworkUrl = registerArtwork(map, item.artworkCandidates, connectionRevisions);
    delete item.artworkCandidates;
  }
  return map;
}

function registerArtwork(map, candidates, connectionRevisions) {
  const sources = (Array.isArray(candidates) ? candidates : []).slice(0, MAX_ARTWORK_SOURCES).flatMap((source) => {
    const targetRevision = connectionTargetRevision(connectionRevisions, source.service);
    return targetRevision ? [{ ...source, targetRevision }] : [];
  });
  if (!sources.length) return null;
  const token = artworkToken(sources);
  map[token] ||= { version: ARTWORK_DESCRIPTOR_VERSION, sources };
  return `/api/v2/media/artwork/${token}`;
}

function findRecord(records, item) {
  const tokens = new Set(identityTokens(item));
  if (tokens.size) return records.find((record) => identityTokens(record).some((token) => tokens.has(token))) || null;
  return records.find((record) => record.sourceKeys.has(`${item.service}:${item.sourceId}`)) || null;
}

function matchingParentSeriesRecords(records, ...items) {
  const evidence = new Set(items.flatMap((item) => [...parentSeriesEvidenceTokens(item)]));
  if (!evidence.size) return [];
  return records.filter((candidate) => {
    if (candidate.mediaType !== "series") return false;
    return [...evidence].some((token) => {
      const parsed = parsedParentSeriesEvidence(token);
      if (!parsed) return false;
      return parsed.kind === "source"
        ? candidate.sourceKeys.has(`${parsed.service}:${parsed.sourceId}`)
        : candidate.providerIds?.[parsed.provider] === parsed.providerId;
    });
  });
}

function findParentSeriesRecord(records, ...items) {
  const matches = matchingParentSeriesRecords(records, ...items);
  return matches.length === 1 ? matches[0] : null;
}

function linkedLifecycleSemantics(linked) {
  return linked ? {
    lifecycle: linked.lifecycle,
    requested: linked.requested,
    monitored: linked.monitored,
    downloading: linked.downloading,
    imported: linked.imported,
    available: linked.available
  } : {};
}

function mediaActionTargets(recordValue) {
  const source = record(recordValue);
  if (!source || !(source.sourceKeys instanceof Set)) return [];
  const expected = source.mediaType === "movie"
    ? ["radarr"]
    : source.mediaType === "series" ? ["sonarr"] : [];
  const targets = [];
  for (const service of expected) {
    const prefix = `${service}:`;
    const matches = [...source.sourceKeys]
      .filter((entry) => typeof entry === "string" && entry.startsWith(prefix))
      .map((entry) => positiveInteger(entry.slice(prefix.length)))
      .filter(Boolean);
    if (matches.length === 1) targets.push({ service, resourceId: matches[0] });
  }
  return targets;
}

function seasonRequestTargetFromProviderIds(value) {
  const tmdbId = positiveInteger(record(value)?.tmdb);
  return tmdbId ? { service: "seerr", resourceId: tmdbId } : null;
}

function seasonRequestTarget(recordValue) {
  const source = record(recordValue);
  return source?.mediaType === "series"
    ? seasonRequestTargetFromProviderIds(source.providerIds)
    : null;
}

function seasonRequestTargetForItem(item, linked, records) {
  if (item?.mediaType === "series") {
    return seasonRequestTarget(linked) || seasonRequestTargetFromProviderIds(item.providerIds);
  }
  if (item?.mediaType !== "episode") return null;
  const evidence = new Set([
    ...parentSeriesEvidenceTokens(item),
    ...parentSeriesEvidenceTokens(linked)
  ]);
  if (!evidence.size) return null;
  const parents = matchingParentSeriesRecords(records, item, linked);
  // The control plane authorizes season reads and writes only against one
  // current canonical series record. Do not publish an episode capability
  // that its authoritative gate cannot revalidate, and fail closed when
  // conflicting parent records are present.
  if (parents.length !== 1) return null;
  const parent = parents[0];
  // A provider/source collision can merge two episode rows even when one of
  // their parent series is absent from the current catalog. Requiring every
  // retained parent token to identify the same canonical parent prevents the
  // resolved half of that collision from authorizing the unresolved half.
  for (const token of evidence) {
    const parsed = parsedParentSeriesEvidence(token);
    const matchesParent = parsed?.kind === "source"
      ? parent.sourceKeys.has(`${parsed.service}:${parsed.sourceId}`)
      : parsed?.kind === "provider"
        && parent.providerIds?.[parsed.provider] === parsed.providerId;
    if (!matchesParent) return null;
  }
  const targetIds = new Set();
  for (const token of evidence) {
    const parsed = parsedParentSeriesEvidence(token);
    if (parsed?.kind === "provider" && parsed.provider === "tmdb") {
      targetIds.add(parsed.providerId);
    }
  }
  const resolved = seasonRequestTarget(parent);
  if (!resolved) return null;
  targetIds.add(resolved.resourceId);
  return targetIds.size === 1
    ? { service: "seerr", resourceId: [...targetIds][0] }
    : null;
}

function requestLifecycleSemantics(item, linked) {
  const requestStatus = seerrRequestStatus(item.requestStatus ?? item.status);
  const mediaStatus = seerrMediaStatus(item.mediaStatus);
  const requestedSeasonStatuses = Array.isArray(item.seasonStatuses)
    ? item.seasonStatuses.map(({ status }) => seerrMediaStatus(status))
    : [];
  const requestCompleted = requestStatus === "completed";
  // Seerr's request list normally joins request.seasons (workflow records) but
  // does not always include media.seasons (availability records). A fully
  // AVAILABLE parent media row is still conclusive for every requested season.
  // When detailed media-season rows are present, they can also prove a scoped
  // request fulfilled while the overall series remains only partially present.
  const requestFulfilled = mediaStatus === "available"
    || requestedSeasonStatuses.length > 0
      && requestedSeasonStatuses.every((status) => status === "available");
  // An exact provider-ID match to a Jellyfin movie is direct availability
  // evidence even when Seerr's periodic library sync is briefly behind. A
  // series-level Jellyfin record cannot prove that a newly requested season is
  // present, so scoped series requests remain governed by Seerr's season data.
  const libraryMovieAvailable = item.mediaType === "movie" && linked?.available === true;
  const availabilityObserved = requestFulfilled || libraryMovieAvailable;
  // Sonarr's normalized catalog/queue state and Seerr's parent media status
  // are title-wide. Neither can prove the state of one requested season.
  const canInheritTitleWideLifecycle = item.mediaType === "movie"
    || item.mediaType === "series" && !(item.requestedSeasons?.length > 0);
  const partiallyAvailable = requestedSeasonStatuses.length
    ? !requestFulfilled && requestedSeasonStatuses.some((status) => ["partially_available", "available"].includes(status))
    : canInheritTitleWideLifecycle && mediaStatus === "partially_available";
  const flags = {
    requested: true,
    monitored: canInheritTitleWideLifecycle && linked?.monitored === true,
    downloading: canInheritTitleWideLifecycle && linked?.downloading === true && !availabilityObserved,
    imported: availabilityObserved || item.mediaType === "movie" && linked?.imported === true,
    // Seerr's AVAILABLE state is populated by its Jellyfin/Plex availability
    // sync. For season requests, requestFulfilled requires every requested
    // season to be available, so existing older episodes cannot satisfy it.
    available: availabilityObserved
  };
  const requestBucket = item.error
    ? "attention"
    : availabilityObserved
      ? "available"
      : requestStatus === "failed"
        ? "attention"
        : requestStatus === "declined" || ["blocklisted", "deleted"].includes(mediaStatus)
          ? "closed"
          : requestStatus === "pending" ? "pending" : "in_progress";
  return {
    ...flags,
    lifecycle: lifecycle(flags),
    requestBucket,
    requestStatus,
    mediaStatus,
    requestCompleted,
    requestFulfilled,
    partiallyAvailable,
    requestScope: item.mediaType === "movie"
      ? "movie"
      : item.requestedSeasons?.length ? "seasons" : "series"
  };
}

function enrichCollection(items, records, options = {}) {
  return items.slice(0, MAX_COLLECTION_ITEMS).map((item) => {
    const linked = findRecord(records, item);
    const parentSeries = findParentSeriesRecord(records, item);
    const requestTarget = seasonRequestTargetForItem(item, linked, records);
    const artworkUrl = typeof options.artworkUrlForItem === "function"
      ? options.artworkUrlForItem(item, linked)
      : parentSeries?.artworkUrl || linked?.artworkUrl || null;
    const enriched = {
      ...item,
      ...(options.requestScoped === true ? requestLifecycleSemantics(item, linked) : linkedLifecycleSemantics(linked)),
      title: linked?.title || item.title,
      year: linked?.year || item.year || null,
      mediaId: linked?.id || null,
      actionTargets: mediaActionTargets(parentSeries || linked),
      ...(requestTarget ? { seasonRequestTarget: requestTarget } : {}),
      artworkUrl
    };
    delete enriched.titleFallback;
    delete enriched.homeArtwork;
    delete enriched.seriesSourceId;
    return enriched;
  });
}

function continueWatchingKey(item) {
  if (item.mediaType === "episode") {
    const seriesSourceId = sourceIdFor("jellyfin", item.seriesSourceId)
      || sourceIdFor("jellyfin", record(item.homeArtwork)?.resource);
    if (seriesSourceId) return `jellyfin:series:${seriesSourceId}`;
  }
  return identityTokens(item)[0] || `${item.service}:${item.sourceId}`;
}

function dedupeContinueWatching(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = continueWatchingKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function continueWatchingArtworkUrl(item, linked, records, artwork, connectionRevisions) {
  if (item.mediaType !== "episode") return linked?.artworkUrl || null;
  const seriesSourceId = sourceIdFor("jellyfin", item.seriesSourceId);
  if (seriesSourceId) {
    const seriesRecord = records.find((candidate) => (
      candidate.mediaType === "series"
      && candidate.sourceKeys.has(`jellyfin:${seriesSourceId}`)
    ));
    if (seriesRecord?.artworkUrl) return seriesRecord.artworkUrl;
  }
  return registerArtwork(artwork, item.homeArtwork ? [item.homeArtwork] : [], connectionRevisions);
}

function publicRecord(record, records) {
  const requestTarget = seasonRequestTargetForItem(record, record, records);
  return {
    id: record.id,
    mediaType: record.mediaType,
    title: record.title,
    year: record.year,
    providerIds: { ...record.providerIds },
    sources: [...record.sources],
    actionTargets: mediaActionTargets(record),
    ...(requestTarget ? { seasonRequestTarget: requestTarget } : {}),
    lifecycle: record.lifecycle,
    requested: record.requested,
    monitored: record.monitored,
    downloading: record.downloading,
    imported: record.imported,
    available: record.available,
    progress: record.progress,
    downloadSpeedBps: record.downloadSpeedBps,
    etaSeconds: record.etaSeconds,
    addedAt: record.addedAt,
    releaseAt: record.releaseAt,
    missingCount: record.missingCount,
    artworkUrl: record.artworkUrl
  };
}

/** Builds the read-only desktop Media workspace model from normalized services. */
export function buildMediaSnapshot(services, generatedAt, connectionRevisions = {}) {
  const inventories = new Map();
  for (const serviceValue of Array.isArray(services) ? services : []) {
    const service = record(serviceValue);
    if (!service || typeof service.id !== "string") continue;
    inventories.set(service.id, normalizeServiceMediaInventory(service.id, service.inventory));
  }
  const records = mediaRecords(inventories);
  const artwork = attachArtwork(records, connectionRevisions);
  const publicRecords = records.map((item) => publicRecord(item, records));
  const titleRecords = publicRecords.filter((item) => item.mediaType === "movie" || item.mediaType === "series");
  const library = titleRecords.filter((item) => item.monitored || item.imported || item.available).slice(0, MAX_LIBRARY_ITEMS);
  const requests = enrichCollection(inventories.get("seerr")?.requests || [], records, { requestScoped: true });
  const discover = enrichCollection(inventories.get("seerr")?.discover || [], records);
  const calendarSeen = new Set();
  const calendar = [
    ...(inventories.get("radarr")?.calendar || []),
    ...(inventories.get("sonarr")?.calendar || [])
  ].filter((item) => {
    const key = `${item.service}:${item.sourceId}`;
    if (calendarSeen.has(key)) return false;
    calendarSeen.add(key);
    return true;
  }).sort((left, right) => String(left.releaseAt).localeCompare(String(right.releaseAt))).slice(0, MAX_COLLECTION_ITEMS);
  const enrichedCalendar = enrichCollection(calendar, records);
  const subtitleBacklog = enrichCollection(inventories.get("bazarr")?.subtitleBacklog || [], records);
  const activity = correlateActivity(inventories, records);
  const continueWatchingItems = dedupeContinueWatching([
    ...(inventories.get("jellyfin")?.resume || []),
    ...(inventories.get("jellyfin")?.nextUp || [])
  ]);
  const continueWatching = enrichCollection(continueWatchingItems, records, {
    artworkUrlForItem: (item, linked) => continueWatchingArtworkUrl(
      item,
      linked,
      records,
      artwork,
      connectionRevisions
    )
  }).slice(0, MAX_HOME_ITEMS);
  const nowPlaying = enrichCollection(inventories.get("jellyfin")?.nowPlaying || [], records)
    .slice(0, MAX_HOME_ITEMS);
  const recentIds = new Set((inventories.get("jellyfin")?.latest || []).flatMap(identityTokens));
  const recentlyAdded = publicRecords
    .filter((item) => item.sources.includes("jellyfin") && (identityTokens(item).some((token) => recentIds.has(token)) || item.addedAt))
    .sort((left, right) => String(right.addedAt || "").localeCompare(String(left.addedAt || "")))
    .slice(0, MAX_HOME_ITEMS);
  const pendingRequestItems = requests.filter((item) => item.requestBucket === "pending");
  const activeDownloadItems = activity.filter((item) => {
    const state = String(item.state || "").toLowerCase();
    if (/(?:paused|error|failed|missingfiles|uploading|completed|stalledup|queuedup|checkingup)/u.test(state)) return false;
    return item.progress !== null && item.progress < 100
      || /(?:download|queued|stalled|checking|moving|allocating|importpending|warning)/u.test(state);
  });
  const blockedImportItems = activity.filter((item) => item.error || /(?:blocked|failed|error)/u.test(item.state));
  const now = Number.isFinite(Date.parse(generatedAt)) ? Date.parse(generatedAt) : Date.now();
  const upcoming = enrichedCalendar.filter((item) => Date.parse(item.releaseAt) >= now).slice(0, MAX_HOME_ITEMS);
  const missingRecords = titleRecords.filter((item) => item.monitored && item.missingCount > 0);
  const missingMovies = missingRecords
    .filter((item) => item.mediaType === "movie")
    .reduce((total, item) => total + item.missingCount, 0);
  const missingEpisodes = missingRecords
    .filter((item) => item.mediaType === "series" || item.mediaType === "episode")
    .reduce((total, item) => total + item.missingCount, 0);
  return {
    schema: MEDIA_SCHEMA,
    generatedAt: isoDate(generatedAt) || new Date(0).toISOString(),
    records: publicRecords,
    home: {
      nowPlaying,
      continueWatching,
      recentlyAdded,
      pendingRequests: pendingRequestItems.slice(0, MAX_HOME_ITEMS),
      activeDownloads: activeDownloadItems.slice(0, MAX_HOME_ITEMS),
      blockedImports: blockedImportItems.slice(0, MAX_HOME_ITEMS),
      upcoming,
      missing: missingRecords.slice(0, MAX_HOME_ITEMS),
      subtitleBacklog: subtitleBacklog.slice(0, MAX_HOME_ITEMS)
    },
    library,
    discover,
    requests,
    activity,
    calendar: enrichedCalendar,
    subtitleBacklog,
    metrics: {
      libraryTotal: titleRecords.filter((item) => item.available).length,
      nowPlayingTotal: nowPlaying.length,
      monitoredTotal: titleRecords.filter((item) => item.monitored).length,
      missingTotal: missingMovies + missingEpisodes,
      missingMovies,
      missingEpisodes,
      pendingRequestTotal: pendingRequestItems.length,
      activeDownloadTotal: activeDownloadItems.length,
      blockedImportTotal: blockedImportItems.length,
      subtitleBacklogTotal: subtitleBacklog.length
    },
    artwork
  };
}
