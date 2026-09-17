import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { performUpstreamRequest } from "../server/broker.mjs";
import {
  connectionAuthorizationBoundaryHash,
  normalizeApprovedHostCidrs,
  normalizePolicy,
  parseServiceUrl,
  resolveAndAuthorizeExplicitTarget,
  resolveAndAuthorizeTarget
} from "../server/network.mjs";
import { authorizeBridgeRoute } from "../server/routes.mjs";

const PRIVATE_POLICY = Object.freeze({
  allowedCidrs: ["10.0.0.0/8"],
  allowPublicHttps: false
});

test("authorization boundaries canonicalize CIDR sets instead of their input order", () => {
  const connection = {
    url: "http://media.test:8096",
    targetRevision: "11111111-1111-4111-8111-111111111111",
    approvedHostCidrs: ["fd12:3456:789a::40/128", "10.20.30.40/32"]
  };
  const reorderedConnection = {
    ...connection,
    approvedHostCidrs: [...connection.approvedHostCidrs].reverse()
  };
  const policy = {
    allowedCidrs: ["fd00::/64", "10.0.0.0/8"],
    allowPublicHttps: false
  };
  const reorderedPolicy = {
    ...policy,
    allowedCidrs: [...policy.allowedCidrs].reverse()
  };
  assert.deepEqual(normalizePolicy(policy).allowedCidrs, ["10.0.0.0/8", "fd00::/64"]);
  assert.deepEqual(normalizeApprovedHostCidrs(connection.approvedHostCidrs), [
    "10.20.30.40/32",
    "fd12:3456:789a::40/128"
  ]);
  assert.equal(
    connectionAuthorizationBoundaryHash(connection, policy),
    connectionAuthorizationBoundaryHash(reorderedConnection, reorderedPolicy)
  );
});

test("network policy canonicalizes IPv4 network bases before deduplication", () => {
  assert.deepEqual(normalizePolicy({
    allowedCidrs: ["10.20.30.40/16", "10.20.0.0/16", "192.168.50.255/24"],
    allowPublicHttps: false
  }).allowedCidrs, ["10.20.0.0/16", "192.168.50.0/24"]);
});

test("network policy canonicalizes equivalent IPv6 spellings and host bits", () => {
  assert.deepEqual(normalizePolicy({
    allowedCidrs: [
      "fd12:3456:789a:bcde:ffff:0000:0000:0001/65",
      "fd12:3456:789a:bcde:9abc::beef/65",
      "FD00:0000:0000:0000:0000:0000:0000:0042/64"
    ],
    allowPublicHttps: false
  }).allowedCidrs, ["fd00::/64", "fd12:3456:789a:bcde:8000::/65"]);
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function browserRequest(headers = {}) {
  return { headers };
}

test("strict service URLs reject credential, query, fragment, and path ambiguity", () => {
  const rejected = [
    "ftp://media.test:8096",
    "http://" + "user:pass@media.test:8096",
    "http://media.test:8096/?token=secret",
    "http://media.test:8096/#fragment",
    "http://media.test:8096/%2e%2e/admin",
    "http://media.test:8096/%252e%252e/admin",
    "http://media.test:8096/safe/../admin",
    "http://media.test:8096/a\\b"
  ];

  for (const value of rejected) {
    assert.throws(() => parseServiceUrl(value), undefined, value);
  }
  assert.equal(parseServiceUrl("HTTP://MEDIA.TEST:8096/").url, "http://media.test:8096");
  assert.equal(parseServiceUrl("https://media.test/base/").url, "https://media.test/base");
});

test("network policy is bounded and blocks SSRF, mixed DNS, and unsafe public transport", async () => {
  assert.deepEqual(normalizePolicy({
    allowedCidrs: ["10.0.0.0/8", "10.0.0.0/8", "fd00::/64"],
    allowPublicHttps: false
  }).allowedCidrs, ["10.0.0.0/8", "fd00::/64"]);
  assert.throws(
    () => normalizePolicy({ allowedCidrs: ["10.0.0.1"], allowPublicHttps: false }),
    /CIDR/u
  );

  for (const [url, policy] of [
    ["http://127.0.0.1:8096", { allowedCidrs: ["127.0.0.0/8"], allowPublicHttps: false }],
    ["http://169.254.169.254", { allowedCidrs: ["169.254.0.0/16"], allowPublicHttps: false }],
    ["http://192.168.1.2:8096", PRIVATE_POLICY],
    ["http://93.184.216.34", { allowedCidrs: ["93.184.216.34/32"], allowPublicHttps: true }],
    ["http://[::ffff:10.20.30.40]:8096", { allowedCidrs: ["::ffff:0:0/96"], allowPublicHttps: false }]
  ]) {
    await assert.rejects(
      resolveAndAuthorizeTarget(url, policy),
      (error) => error.code === "TARGET_NOT_ALLOWED",
      url
    );
  }

  await assert.rejects(
    resolveAndAuthorizeTarget("http://mixed.test:8096", PRIVATE_POLICY, {
      lookup: async () => [
        { address: "10.20.30.40", family: 4 },
        { address: "127.0.0.1", family: 4 }
      ]
    }),
    (error) => error.code === "DNS_MIXED_POLICY"
  );

  await assert.rejects(
    resolveAndAuthorizeTarget("https://timeout.test", {
      allowedCidrs: [],
      allowPublicHttps: true
    }, {
      lookup: () => new Promise(() => {}),
      lookupTimeoutMs: 5
    }),
    (error) => error.code === "DNS_FAILED"
  );

  const privateTarget = await resolveAndAuthorizeTarget("http://media.test:8096", PRIVATE_POLICY, {
    lookup: async () => [{ address: "10.20.30.40", family: 4 }]
  });
  assert.equal(privateTarget.pinned.address, "10.20.30.40");

  const publicTarget = await resolveAndAuthorizeTarget("https://public.test", {
    allowedCidrs: [],
    allowPublicHttps: true
  }, {
    lookup: async () => [{ address: "93.184.216.34", family: 4 }]
  });
  assert.equal(publicTarget.pinned.address, "93.184.216.34");
});

test("explicit registration creates connection-bound exact host approvals", async () => {
  const noManualNetworks = {
    allowedCidrs: [],
    allowPublicHttps: false
  };
  const lookup = async () => [
    { address: "10.20.30.40", family: 4 },
    { address: "FD12:3456:789A::40", family: 6 }
  ];

  const enrolled = await resolveAndAuthorizeExplicitTarget(
    "http://media.test:8096",
    noManualNetworks,
    { lookup }
  );
  assert.deepEqual(enrolled.approvedHostCidrs, [
    "10.20.30.40/32",
    "fd12:3456:789a::40/128"
  ]);
  assert.equal(enrolled.pinned.address, "10.20.30.40");

  const runtime = await resolveAndAuthorizeTarget(
    "http://media.test:8096",
    noManualNetworks,
    { lookup, approvedHostCidrs: enrolled.approvedHostCidrs }
  );
  assert.deepEqual(runtime.approvedHostCidrs, enrolled.approvedHostCidrs);

  const subset = await resolveAndAuthorizeTarget(
    "http://media.test:8096",
    noManualNetworks,
    {
      lookup: async () => [{ address: "10.20.30.40", family: 4 }],
      approvedHostCidrs: enrolled.approvedHostCidrs
    }
  );
  assert.equal(subset.pinned.address, "10.20.30.40");

  await assert.rejects(
    resolveAndAuthorizeTarget("http://media.test:8096", noManualNetworks, {
      lookup: async () => [{ address: "10.20.30.41", family: 4 }],
      approvedHostCidrs: enrolled.approvedHostCidrs
    }),
    (error) => error.code === "TARGET_ADDRESS_CHANGED"
  );

  await assert.rejects(
    resolveAndAuthorizeTarget("http://media.test:8096", noManualNetworks, {
      lookup: async () => [
        { address: "10.20.30.40", family: 4 },
        { address: "10.20.30.41", family: 4 }
      ],
      approvedHostCidrs: enrolled.approvedHostCidrs
    }),
    (error) => error.code === "DNS_MIXED_POLICY"
  );
});

test("manual CIDRs remain an explicit registration boundary", async () => {
  const lookup = async () => [{ address: "10.20.30.40", family: 4 }];
  await assert.rejects(
    resolveAndAuthorizeExplicitTarget(
      "http://media.test:8096",
      { allowedCidrs: ["10.44.0.0/16"], allowPublicHttps: false },
      { lookup }
    ),
    (error) => error.code === "TARGET_NOT_ALLOWED"
  );

  const allowed = await resolveAndAuthorizeExplicitTarget(
    "http://media.test:8096",
    PRIVATE_POLICY,
    { lookup }
  );
  assert.equal(allowed.pinned.address, "10.20.30.40");
});

test("exact host approvals are bounded, private-only, and never bypass immutable denials", async () => {
  assert.deepEqual(normalizeApprovedHostCidrs([
    "10.20.30.40/32",
    "FD12:3456:789A:0:0:0:0:40/128",
    "fd12:3456:789a::40/128"
  ]), ["10.20.30.40/32", "fd12:3456:789a::40/128"]);

  for (const invalid of [
    ["10.20.30.0/24"],
    ["fd12:3456:789a::/64"],
    ["127.0.0.1/32"],
    ["169.254.169.254/32"],
    ["93.184.216.34/32"]
  ]) {
    assert.throws(
      () => normalizeApprovedHostCidrs(invalid),
      (error) => error.code === "INVALID_APPROVED_HOSTS",
      invalid[0]
    );
  }
  assert.throws(
    () => normalizeApprovedHostCidrs(Array.from({ length: 33 }, (_, index) => `10.0.0.${index + 1}/32`)),
    (error) => error.code === "INVALID_APPROVED_HOSTS"
  );

  for (const url of [
    "http://127.0.0.1:8096",
    "http://169.254.169.254:8096",
    "http://[::ffff:10.20.30.40]:8096"
  ]) {
    await assert.rejects(
      resolveAndAuthorizeExplicitTarget(url, { allowedCidrs: [], allowPublicHttps: false }),
      (error) => error.code === "TARGET_NOT_ALLOWED",
      url
    );
  }
});

test("explicit registration retains the public HTTPS opt-in and rejects public HTTP", async () => {
  const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];
  for (const [url, allowPublicHttps] of [
    ["http://public.test:8080", true],
    ["https://public.test", false]
  ]) {
    await assert.rejects(
      resolveAndAuthorizeExplicitTarget(url, { allowedCidrs: [], allowPublicHttps }, { lookup: publicLookup }),
      (error) => error.code === "TARGET_NOT_ALLOWED",
      url
    );
  }

  const allowed = await resolveAndAuthorizeExplicitTarget(
    "https://public.test",
    { allowedCidrs: [], allowPublicHttps: true },
    { lookup: publicLookup }
  );
  assert.equal(allowed.pinned.address, "93.184.216.34");
  assert.deepEqual(allowed.approvedHostCidrs, []);
});

test("service routes remain deny-by-default", () => {
  const allowed = [
    ["jellyfin", "GET", "/bridge/jellyfin/System/Info/Public"],
    ["jellyfin", "GET", "/bridge/jellyfin/System/Info"],
    ["jellyfin", "GET", "/bridge/jellyfin/Items/movie-1/Images/Primary?maxWidth=342&quality=85&tag=abcdef0123456789"],
    ["seerr", "GET", "/bridge/seerr/api/v1/status"],
    ["seerr", "GET", "/bridge/seerr/imageproxy/tmdb/t/p/w342/poster-1.jpg"],
    ["radarr", "GET", "/bridge/radarr/api/v3/queue?page=1"],
    ["radarr", "GET", "/bridge/radarr/MediaCover/42/poster-250.jpg?lastWrite=638934912000000000"],
    ["radarr", "GET", "/bridge/radarr/MediaCover/42/poster.jpg?lastWrite=638934912000000000"],
    ["sonarr", "GET", "/bridge/sonarr/MediaCover/73/poster-500.jpg?lastWrite=638934912000000073"],
    ["sonarr", "GET", "/bridge/sonarr/api/v3/health"],
    ["sonarr", "GET", "/bridge/sonarr/api/v3/calendar?includeSeries=true"],
    ["prowlarr", "GET", "/bridge/prowlarr/api/v1/indexerstatus"],
    ["bazarr", "GET", "/bridge/bazarr/api/system/status"],
    ["qbit", "GET", "/bridge/qbit/api/v2/app/version"]
  ];
  const denied = [
    ["jellyfin", "DELETE", "/bridge/jellyfin/Items/123"],
    ["jellyfin", "GET", "/bridge/jellyfin/Users"],
    ["seerr", "POST", "/bridge/seerr/api/v1/request"],
    ["radarr", "POST", "/bridge/radarr/api/v3/command"],
    ["qbit", "POST", "/bridge/qbit/api/v2/torrents/stop"],
    ["qbit", "GET", "/bridge/qbit/api/v2/app/preferences"],
    ["seerr", "GET", "/bridge/seerr/api/v1/search?apiKey=secret"],
    ["jellyfin", "GET", "/bridge/jellyfin/not-allowed/%2e%2e/System/Info/Public"],
    ["jellyfin", "GET", "/bridge/jellyfin/Items/movie-1/Images/Primary?maxWidth=480&quality=90&tag=abcdef0123456789"],
    ["jellyfin", "GET", "/bridge/jellyfin/Items/movie-1/Images/Primary?maxWidth=342&quality=85"],
    ["jellyfin", "GET", "/bridge/jellyfin/Items/movie-1/Images/Primary?maxWidth=342&quality=85&tag=abcdef&extra=1"],
    ["jellyfin", "GET", "/bridge/jellyfin/Items/movie-1/Images/Primary?maxWidth=342&quality=85&tag=unsafe%20tag"],
    ["radarr", "GET", "/bridge/radarr/api/v3/movie"],
    ["radarr", "GET", "/bridge/radarr/MediaCover/42/poster-250.jpg?lastWrite=not-a-revision"],
    ["sonarr", "GET", "/bridge/sonarr/api/v3/calendar"],
    ["sonarr", "GET", "/bridge/sonarr/api/v3/calendar?includeSeries=false"],
    ["sonarr", "GET", "/bridge/sonarr/api/v3/series?includeSeasonImages=true"],
    ["seerr", "GET", "/bridge/seerr/imageproxy/tmdb/t/p/w500/poster-1.jpg"],
    ["radarr", "GET", "/bridge/radarr/MediaCover/42/poster.jpg?url=https%3A%2F%2Fevil.test"],
    ["jellyfin", "GET", "http://evil.test/bridge/jellyfin/System/Info/Public"]
  ];

  for (const [service, method, pathname] of allowed) {
    assert.equal(authorizeBridgeRoute(service, method, pathname).allowed, true, pathname);
  }
  for (const [service, method, pathname] of denied) {
    assert.equal(authorizeBridgeRoute(service, method, pathname).allowed, false, pathname);
  }

  // The broker needs exact internal route metadata for one-time exchanges,
  // while its public HTTP handler continues to deny every /bridge surface.
  for (const [service, method, pathname, isLogin] of [
    ["jellyfin", "POST", "/bridge/jellyfin/Users/AuthenticateByName", true],
    ["jellyfin", "GET", "/bridge/jellyfin/Users/Me", false],
    ["jellyfin", "POST", "/bridge/jellyfin/Sessions/Logout", false],
    ["seerr", "POST", "/bridge/seerr/api/v1/auth/local", true]
  ]) {
    const route = authorizeBridgeRoute(service, method, pathname);
    assert.equal(route.allowed, true, pathname);
    assert.equal(route.isLogin, isLogin, pathname);
    assert.equal(route.internalOnly, true, pathname);
  }
  assert.equal(
    authorizeBridgeRoute("jellyfin", "GET", "/bridge/jellyfin/Users/Me?userId=1").allowed,
    false
  );
  assert.equal(
    authorizeBridgeRoute("jellyfin", "POST", "/bridge/jellyfin/Sessions/Logout?token=secret").allowed,
    false
  );
});

test("outbound transport pins DNS and strips ambient browser and edge headers", async (t) => {
  const observed = [];
  const upstream = http.createServer((request, response) => {
    observed.push({ url: request.url, headers: request.headers });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end("{}");
  });
  const port = await listen(upstream);
  t.after(() => close(upstream));

  const target = parseServiceUrl(`http://pin.test:${port}`);
  const route = authorizeBridgeRoute("radarr", "GET", "/bridge/radarr/api/v3/system/status");
  const result = await performUpstreamRequest({
    request: browserRequest({
      "x-api-key": "dedicated-arr-key",
      authorization: "Bearer must-not-pass",
      cookie: "authentik_session=must-not-pass; arbitrary=must-not-pass",
      origin: "https://command.example.test",
      referer: "https://command.example.test/settings",
      "x-jellofin-device-token": "must-not-pass",
      "x-jellofin-csrf": "must-not-pass",
      "x-authentik-username": "must-not-pass",
      "x-forwarded-for": "must-not-pass"
    }),
    body: Buffer.alloc(0),
    targetResolution: {
      target,
      addresses: [{ address: "127.0.0.1", family: 4 }],
      pinned: { address: "127.0.0.1", family: 4 }
    },
    route,
    deviceOrigin: "https://command.example.test",
    targetRevision: "11111111-1111-4111-8111-111111111111",
    limits: {
      maxApiResponseBytes: 1024,
      maxImageResponseBytes: 1024,
      upstreamTimeoutMs: 2_000
    }
  });

  assert.equal(result.status, 200);
  assert.equal(observed.length, 1);
  assert.equal(observed[0].url, "/api/v3/system/status");
  assert.equal(observed[0].headers.host, `pin.test:${port}`);
  assert.equal(observed[0].headers["x-api-key"], "dedicated-arr-key");
  for (const header of [
    "authorization",
    "cookie",
    "origin",
    "referer",
    "x-jellofin-device-token",
    "x-jellofin-csrf",
    "x-authentik-username",
    "x-forwarded-for"
  ]) {
    assert.equal(observed[0].headers[header], undefined, header);
  }
});

test("outbound transport clears source response chunks and rejected assembled bodies", async (t) => {
  const jellyfinToken = "browser-auth-token-that-must-not-remain-in-source-chunks";
  const rejectedSecret = "rejected-login-body-that-must-be-zeroed";
  const upstream = http.createServer((request, response) => {
    if (request.url === "/Users/AuthenticateByName") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.write(`{"AccessToken":"${jellyfinToken}",`);
      setImmediate(() => response.end('"ServerId":"server-1","User":{"Id":"owner-1"}}'));
      return;
    }
    response.writeHead(200, {
      "Content-Type": "application/json",
      "Set-Cookie": [
        "connect.sid=s%3Afirst.signature; Path=/; HttpOnly",
        "connect.sid=s%3Asecond.signature; Path=/; HttpOnly"
      ]
    });
    response.end(`{"secret":"${rejectedSecret}"}`);
  });
  const port = await listen(upstream);
  t.after(() => close(upstream));

  const originalConcat = Buffer.concat;
  const captures = [];
  Buffer.concat = function instrumentedConcat(chunks, totalLength) {
    const result = originalConcat.call(Buffer, chunks, totalLength);
    if (result.includes(jellyfinToken) || result.includes(rejectedSecret)) {
      captures.push({ result, chunks: [...chunks] });
    }
    return result;
  };
  t.after(() => { Buffer.concat = originalConcat; });

  const target = parseServiceUrl(`http://pin.test:${port}`);
  const common = {
    request: browserRequest({
      authorization: 'MediaBrowser Client="Helmsman", Device="Browser", DeviceId="device-1", Version="1.0.2"',
      "content-type": "application/json"
    }),
    targetResolution: {
      target,
      addresses: [{ address: "127.0.0.1", family: 4 }],
      pinned: { address: "127.0.0.1", family: 4 }
    },
    deviceOrigin: "https://command.example.test",
    targetRevision: "12121212-1212-4212-8212-121212121212",
    limits: {
      maxApiResponseBytes: 4096,
      maxImageResponseBytes: 4096,
      upstreamTimeoutMs: 2_000
    }
  };

  const jellyfinBody = Buffer.from('{"Username":"Owner","Pw":"transient"}', "utf8");
  const jellyfin = await performUpstreamRequest({
    ...common,
    body: jellyfinBody,
    route: authorizeBridgeRoute("jellyfin", "POST", "/bridge/jellyfin/Users/AuthenticateByName")
  });
  assert.match(jellyfin.body.toString("utf8"), new RegExp(jellyfinToken, "u"));
  const jellyfinCapture = captures.find(({ result }) => result === jellyfin.body);
  assert.ok(jellyfinCapture, "the Jellyfin authentication response should be instrumented");
  assert.ok(jellyfinCapture.chunks.length >= 1);
  for (const chunk of jellyfinCapture.chunks) {
    assert.ok(chunk.equals(Buffer.alloc(chunk.length)), "each copied source chunk must be zeroed");
  }

  const seerrBody = Buffer.from('{"email":"owner@example.test","password":"transient"}', "utf8");
  await assert.rejects(
    performUpstreamRequest({
      ...common,
      request: browserRequest({ "content-type": "application/json" }),
      body: seerrBody,
      route: authorizeBridgeRoute("seerr", "POST", "/bridge/seerr/api/v1/auth/local")
    }),
    (error) => error.code === "LOGIN_EXCHANGE_FAILED"
  );
  const rejectedCapture = captures.find(({ result }) => result !== jellyfin.body);
  assert.ok(rejectedCapture, "the rejected login response should be instrumented");
  assert.ok(rejectedCapture.result.equals(Buffer.alloc(rejectedCapture.result.length)),
    "a concatenated body must be zeroed when later validation rejects it");
  for (const chunk of rejectedCapture.chunks) {
    assert.ok(chunk.equals(Buffer.alloc(chunk.length)), "rejected source chunks must be zeroed");
  }

  jellyfinBody.fill(0);
  seerrBody.fill(0);
  jellyfin.body.fill(0);
});

test("outbound transport rejects redirects and oversized responses", async (t) => {
  let behavior = "redirect";
  const upstream = http.createServer((_request, response) => {
    if (behavior === "redirect") {
      response.writeHead(302, { Location: "http://127.0.0.1/should-never-follow" });
      response.end();
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end("x".repeat(64));
  });
  const port = await listen(upstream);
  t.after(() => close(upstream));

  const target = parseServiceUrl(`http://pin.test:${port}`);
  const route = authorizeBridgeRoute("radarr", "GET", "/bridge/radarr/api/v3/system/status");
  const base = {
    request: browserRequest({ "x-api-key": "dedicated-arr-key" }),
    body: Buffer.alloc(0),
    targetResolution: {
      target,
      addresses: [{ address: "127.0.0.1", family: 4 }],
      pinned: { address: "127.0.0.1", family: 4 }
    },
    route,
    deviceOrigin: "https://command.example.test",
    targetRevision: "22222222-2222-4222-8222-222222222222",
    limits: {
      maxApiResponseBytes: 1024,
      maxImageResponseBytes: 1024,
      upstreamTimeoutMs: 2_000
    }
  };

  await assert.rejects(
    performUpstreamRequest(base),
    (error) => error.code === "UPSTREAM_REDIRECT_REJECTED"
  );

  behavior = "oversize";
  await assert.rejects(
    performUpstreamRequest({
      ...base,
      limits: { ...base.limits, maxApiResponseBytes: 8 }
    }),
    (error) => error.code === "UPSTREAM_RESPONSE_TOO_LARGE"
  );
});

test("Seerr session wrappers become only the exact connect.sid cookie upstream", async (t) => {
  const observed = [];
  const upstream = http.createServer((request, response) => {
    observed.push(request.headers);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end('{"id":12}');
  });
  const port = await listen(upstream);
  t.after(() => close(upstream));

  const targetRevision = "33333333-3333-4333-8333-333333333333";
  const session = "s%3Astrict-session.signature";
  const wrapped = Buffer.from(`connect.sid\0${session}`, "utf8").toString("base64url");
  const brokerCookie = `JFC_SEERR_${targetRevision.replaceAll("-", "")}=${wrapped}`;
  const target = parseServiceUrl(`http://pin.test:${port}`);
  const route = authorizeBridgeRoute("seerr", "GET", "/bridge/seerr/api/v1/auth/me");
  const base = {
    request: browserRequest({
      cookie: `${brokerCookie}; authentik_session=must-not-pass`,
      "x-api-key": "must-not-pass-when-session-is-used"
    }),
    body: Buffer.alloc(0),
    targetResolution: {
      target,
      addresses: [{ address: "127.0.0.1", family: 4 }],
      pinned: { address: "127.0.0.1", family: 4 }
    },
    route,
    deviceOrigin: "https://command.example.test",
    targetRevision,
    limits: {
      maxApiResponseBytes: 1024,
      maxImageResponseBytes: 1024,
      upstreamTimeoutMs: 2_000
    }
  };

  // Explicit X-Api-Key takes precedence and prevents an ambient session from
  // being combined with it.
  const keyed = await performUpstreamRequest(base);
  assert.equal(keyed.status, 200);
  assert.equal(observed[0]["x-api-key"], "must-not-pass-when-session-is-used");
  assert.equal(observed[0].cookie, undefined);

  const sessionOnly = await performUpstreamRequest({
    ...base,
    request: browserRequest({ cookie: `${brokerCookie}; authentik_session=must-not-pass` })
  });
  assert.equal(sessionOnly.status, 200);
  assert.equal(observed[1].cookie, `connect.sid=${session}`);
  assert.equal(observed[1]["x-api-key"], undefined);
  assert.equal(observed[1].authorization, undefined);

  await assert.rejects(
    performUpstreamRequest({
      ...base,
      request: browserRequest({ cookie: `${brokerCookie}; ${brokerCookie}` })
    }),
    (error) => error.code === "AMBIGUOUS_SERVICE_SESSION"
  );
  assert.equal(observed.length, 2, "ambiguous cookies must fail before opening an upstream request");
});

test("Seerr login accepts one strict session cookie and rejects expired or ambiguous sessions", async (t) => {
  let cookies = [];
  const upstream = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": cookies });
    response.end('{"id":12}');
  });
  const port = await listen(upstream);
  t.after(() => close(upstream));

  const target = parseServiceUrl(`http://pin.test:${port}`);
  const route = authorizeBridgeRoute("seerr", "POST", "/bridge/seerr/api/v1/auth/local");
  const body = Buffer.from('{"email":"local@example.test","password":"transient"}', "utf8");
  const base = {
    request: browserRequest({ "content-type": "application/json" }),
    body,
    targetResolution: {
      target,
      addresses: [{ address: "127.0.0.1", family: 4 }],
      pinned: { address: "127.0.0.1", family: 4 }
    },
    route,
    deviceOrigin: "https://command.example.test",
    targetRevision: "44444444-4444-4444-8444-444444444444",
    limits: {
      maxApiResponseBytes: 1024,
      maxImageResponseBytes: 1024,
      upstreamTimeoutMs: 2_000
    }
  };

  cookies = ["connect.sid=s%3Avalid.signature; Path=/; HttpOnly; SameSite=Lax"];
  const valid = await performUpstreamRequest(base);
  assert.deepEqual(valid.loginSession, { name: "connect.sid", value: "s%3Avalid.signature" });
  assert.deepEqual(valid.cookies, [], "login sessions stay internal instead of becoming browser cookies");

  cookies = [];
  const missing = await performUpstreamRequest(base);
  assert.equal(missing.loginSession, null);

  cookies = ["connect.sid=; Path=/; Max-Age=0"];
  await assert.rejects(
    performUpstreamRequest(base),
    (error) => error.code === "LOGIN_EXCHANGE_FAILED"
  );

  cookies = [
    "connect.sid=s%3Afirst.signature; Path=/; HttpOnly",
    "connect.sid=s%3Asecond.signature; Path=/; HttpOnly"
  ];
  await assert.rejects(
    performUpstreamRequest(base),
    (error) => error.code === "LOGIN_EXCHANGE_FAILED"
  );

  body.fill(0);
});
