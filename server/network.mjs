import { lookup as systemLookup } from "node:dns/promises";
import { createHash } from "node:crypto";
import { BlockList, isIP } from "node:net";

const CONTROL_OR_WHITESPACE = /[\u0000-\u0020\u007f-\u009f\u2028\u2029]/u;
const ENCODED_PATH_HAZARD = /%(?:00|0a|0d|25|2e|2f|5c)/iu;
const LITERAL_DOT_SEGMENT = /\/\.{1,2}(?:\/|[?#]|$)/u;
const MAX_TARGET_LENGTH = 2048;
const MAX_CIDRS = 64;
const MAX_DNS_ANSWERS = 32;
const MAX_APPROVED_HOST_CIDRS = MAX_DNS_ANSWERS;
const DEFAULT_DNS_TIMEOUT_MS = 5_000;

const FORBIDDEN_IPV4 = [
  ["0.0.0.0", 8],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4]
];

const FORBIDDEN_IPV4_HOSTS = [
  "100.100.100.200", // Alibaba metadata
  "168.63.129.16", // Azure host agent/WireServer
  "192.0.0.192" // Oracle metadata
];

const FORBIDDEN_IPV6 = [
  ["::", 128],
  ["::1", 128],
  ["::", 96], // deprecated IPv4-compatible encodings
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96], // standard NAT64 prefix
  ["64:ff9b:1::", 48], // local-use NAT64 prefix
  ["100::", 64],
  ["2001::", 32], // Teredo transition addresses
  ["2001:db8::", 32],
  ["2002::", 16], // deprecated 6to4 transition addresses
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
  ["fd00:ec2::254", 128]
];

// Keep IPv4 and IPv6 lists separate. Node's BlockList deliberately considers an
// IPv4 address to be inside ::ffff:0:0/96. That is useful for general ACLs, but
// would make the IPv4-mapped-IPv6 defence below reject every ordinary IPv4
// target if both families shared one list.
const PRIVATE_BLOCKS = {
  ipv4: new BlockList(),
  ipv6: new BlockList()
};
PRIVATE_BLOCKS.ipv4.addSubnet("10.0.0.0", 8, "ipv4");
PRIVATE_BLOCKS.ipv4.addSubnet("100.64.0.0", 10, "ipv4");
PRIVATE_BLOCKS.ipv4.addSubnet("172.16.0.0", 12, "ipv4");
PRIVATE_BLOCKS.ipv4.addSubnet("192.168.0.0", 16, "ipv4");
PRIVATE_BLOCKS.ipv6.addSubnet("fc00::", 7, "ipv6");

const FORBIDDEN_BLOCKS = {
  ipv4: new BlockList(),
  ipv6: new BlockList()
};
for (const [network, prefix] of FORBIDDEN_IPV4) {
  FORBIDDEN_BLOCKS.ipv4.addSubnet(network, prefix, "ipv4");
}
for (const address of FORBIDDEN_IPV4_HOSTS) {
  FORBIDDEN_BLOCKS.ipv4.addAddress(address, "ipv4");
}
for (const [network, prefix] of FORBIDDEN_IPV6) {
  FORBIDDEN_BLOCKS.ipv6.addSubnet(network, prefix, "ipv6");
}

export class NetworkPolicyError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "NetworkPolicyError";
    this.code = code;
    this.status = status;
  }
}

function addressType(address) {
  const version = isIP(address);
  if (version === 4) return "ipv4";
  if (version === 6) return "ipv6";
  throw new NetworkPolicyError("INVALID_ADDRESS", "DNS returned an invalid address.", 502);
}

function cleanHostname(hostname) {
  const value = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  return value.toLowerCase();
}

function canonicalAddress(address) {
  const version = isIP(address);
  if (version === 4) return address;
  if (version === 6) {
    // WHATWG URL serialization gives equivalent IPv6 spellings one stable
    // representation. Brackets are URL syntax and are not part of the address.
    return cleanHostname(new URL(`http://[${address}]/`).hostname);
  }
  throw new NetworkPolicyError("INVALID_ADDRESS", "An approved host contains an invalid address.");
}

function maskedIpv4Network(address, prefix) {
  let remaining = prefix;
  return address.split(".").map((part) => {
    const significantBits = Math.min(remaining, 8);
    remaining -= significantBits;
    if (significantBits === 0) return "0";
    const mask = 0xff << (8 - significantBits);
    return String(Number(part) & mask);
  }).join(".");
}

function expandedIpv6Groups(address) {
  const canonical = canonicalAddress(address);
  const halves = canonical.split("::");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const omitted = halves.length === 2 ? 8 - left.length - right.length : 0;
  return [
    ...left,
    ...Array.from({ length: omitted }, () => "0"),
    ...right
  ].map((group) => Number.parseInt(group, 16));
}

function maskedIpv6Network(address, prefix) {
  let remaining = prefix;
  const groups = expandedIpv6Groups(address).map((group) => {
    const significantBits = Math.min(remaining, 16);
    remaining -= significantBits;
    if (significantBits === 0) return 0;
    const mask = (0xffff << (16 - significantBits)) & 0xffff;
    return group & mask;
  });
  return canonicalAddress(groups.map((group) => group.toString(16)).join(":"));
}

function normalizeCidr(value) {
  if (typeof value !== "string" || value.length > 128 || CONTROL_OR_WHITESPACE.test(value)) {
    throw new NetworkPolicyError("INVALID_CIDR", "Each allowed network must be a valid CIDR.");
  }
  const parts = value.split("/");
  if (parts.length !== 2 || !/^\d{1,3}$/u.test(parts[1])) {
    throw new NetworkPolicyError("INVALID_CIDR", "Each allowed network must include a CIDR prefix.");
  }
  const network = cleanHostname(parts[0]);
  const version = isIP(network);
  const prefix = Number(parts[1]);
  const maximum = version === 4 ? 32 : version === 6 ? 128 : -1;
  if (maximum < 0 || prefix < 0 || prefix > maximum) {
    throw new NetworkPolicyError("INVALID_CIDR", "An allowed network contains an invalid address or prefix.");
  }
  const normalizedNetwork = version === 4
    ? maskedIpv4Network(network, prefix)
    : maskedIpv6Network(network, prefix);
  try {
    const check = new BlockList();
    check.addSubnet(normalizedNetwork, prefix, version === 4 ? "ipv4" : "ipv6");
  } catch {
    throw new NetworkPolicyError("INVALID_CIDR", "An allowed network is not a canonical CIDR subnet.");
  }
  return `${normalizedNetwork}/${prefix}`;
}

function buildAllowedBlocks(cidrs) {
  const blocks = { ipv4: new BlockList(), ipv6: new BlockList() };
  for (const cidr of cidrs) {
    const [network, rawPrefix] = cidr.split("/");
    const version = isIP(network);
    const type = version === 4 ? "ipv4" : "ipv6";
    blocks[type].addSubnet(network, Number(rawPrefix), type);
  }
  return blocks;
}

function exactHostCidr(address) {
  const canonical = canonicalAddress(address);
  return `${canonical}/${isIP(canonical) === 4 ? 32 : 128}`;
}

export function normalizeApprovedHostCidrs(input) {
  if (!Array.isArray(input) || input.length > MAX_APPROVED_HOST_CIDRS) {
    throw new NetworkPolicyError(
      "INVALID_APPROVED_HOSTS",
      `Supply no more than ${MAX_APPROVED_HOST_CIDRS} exact approved host addresses.`
    );
  }
  const approved = [];
  const seen = new Set();
  for (const value of input) {
    if (typeof value !== "string" || value.length > 128 || CONTROL_OR_WHITESPACE.test(value)) {
      throw new NetworkPolicyError("INVALID_APPROVED_HOSTS", "Each approved host must be an exact host CIDR.");
    }
    const parts = value.split("/");
    if (parts.length !== 2 || !/^\d{1,3}$/u.test(parts[1])) {
      throw new NetworkPolicyError("INVALID_APPROVED_HOSTS", "Each approved host must be an exact host CIDR.");
    }
    const address = canonicalAddress(parts[0]);
    const type = addressType(address);
    const prefix = Number(parts[1]);
    if ((type === "ipv4" && prefix !== 32) || (type === "ipv6" && prefix !== 128)) {
      throw new NetworkPolicyError("INVALID_APPROVED_HOSTS", "Approved hosts must use /32 for IPv4 or /128 for IPv6.");
    }
    // Exact host approvals are deliberately limited to safe private address
    // space. Public HTTPS remains governed by allowPublicHttps, and immutable
    // SSRF-deny ranges can never be smuggled into a saved connection.
    if (FORBIDDEN_BLOCKS[type].check(address, type) || !PRIVATE_BLOCKS[type].check(address, type)) {
      throw new NetworkPolicyError("INVALID_APPROVED_HOSTS", "An approved host is outside safe private address space.");
    }
    const normalized = exactHostCidr(address);
    if (!seen.has(normalized)) {
      approved.push(normalized);
      seen.add(normalized);
    }
  }
  return approved.sort();
}

export function normalizePolicy(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new NetworkPolicyError("INVALID_POLICY", "Network policy must be an object.");
  }
  if (!Array.isArray(input.allowedCidrs) || input.allowedCidrs.length > MAX_CIDRS) {
    throw new NetworkPolicyError("INVALID_POLICY", `Supply no more than ${MAX_CIDRS} allowed CIDR ranges.`);
  }
  if (typeof input.allowPublicHttps !== "boolean") {
    throw new NetworkPolicyError("INVALID_POLICY", "allowPublicHttps must be true or false.");
  }
  const allowedCidrs = [...new Set(input.allowedCidrs.map(normalizeCidr))].sort();
  return {
    allowedCidrs,
    allowPublicHttps: input.allowPublicHttps
  };
}

export function connectionAuthorizationBoundaryHash(connection, policyInput) {
  if (!connection || typeof connection !== "object" || Array.isArray(connection)) {
    throw new NetworkPolicyError("INVALID_TARGET", "A configured service connection is required.");
  }
  const target = parseServiceUrl(connection.url);
  if (typeof connection.targetRevision !== "string" || connection.targetRevision.length > 128) {
    throw new NetworkPolicyError("INVALID_TARGET", "The service target revision is invalid.");
  }
  const policy = normalizePolicy(policyInput);
  const approvedHostCidrs = normalizeApprovedHostCidrs(connection.approvedHostCidrs || []);
  return createHash("sha256").update(JSON.stringify({
    url: target.url,
    targetRevision: connection.targetRevision,
    approvedHostCidrs,
    policy
  }), "utf8").digest("hex");
}

export function parseServiceUrl(rawValue) {
  if (typeof rawValue !== "string"
    || rawValue.length < 1
    || rawValue.length > MAX_TARGET_LENGTH
    || CONTROL_OR_WHITESPACE.test(rawValue)
    || rawValue.includes("\\")
    || LITERAL_DOT_SEGMENT.test(rawValue)) {
    throw new NetworkPolicyError("INVALID_TARGET", "Enter one valid HTTP or HTTPS service URL.");
  }
  // WHATWG URL parsing removes encoded dot segments. Inspect the input first so
  // `%2e%2e` cannot become an apparently harmless normalized pathname.
  if (ENCODED_PATH_HAZARD.test(rawValue)) {
    throw new NetworkPolicyError("INVALID_TARGET", "The service base path contains an unsafe encoding or shape.");
  }

  let url;
  try {
    url = new URL(rawValue);
  } catch {
    throw new NetworkPolicyError("INVALID_TARGET", "Enter one valid HTTP or HTTPS service URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new NetworkPolicyError("INVALID_TARGET", "Service URLs must use HTTP or HTTPS.");
  }
  if (url.username || url.password) {
    throw new NetworkPolicyError("INVALID_TARGET", "Credentials cannot be embedded in a service URL.");
  }
  if (url.search || url.hash) {
    throw new NetworkPolicyError("INVALID_TARGET", "A service URL cannot contain a query or fragment.");
  }
  if (!url.hostname || url.hostname.length > 255) {
    throw new NetworkPolicyError("INVALID_TARGET", "The service URL needs a valid hostname or IP address.");
  }
  if (ENCODED_PATH_HAZARD.test(url.pathname)
    || url.pathname.includes("//")
    || url.pathname.length > 512) {
    throw new NetworkPolicyError("INVALID_TARGET", "The service base path contains an unsafe encoding or shape.");
  }

  const protocol = url.protocol;
  const hostname = cleanHostname(url.hostname);
  const port = Number(url.port || (protocol === "https:" ? 443 : 80));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new NetworkPolicyError("INVALID_TARGET", "The service URL contains an invalid TCP port.");
  }
  const basePath = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/u, "");
  const canonicalUrl = `${url.origin}${basePath}`;
  return {
    url: canonicalUrl,
    protocol,
    hostname,
    port,
    basePath,
    authority: url.host
  };
}

function ipv4Integer(address) {
  const pieces = address.split(".").map(Number);
  return pieces.reduce((total, piece) => ((total << 8) | piece) >>> 0, 0) >>> 0;
}

function isDirectedNetworkOrBroadcast(address, cidrs) {
  if (isIP(address) !== 4) return false;
  const integer = ipv4Integer(address);
  for (const cidr of cidrs) {
    const [network, rawPrefix] = cidr.split("/");
    if (isIP(network) !== 4) continue;
    const prefix = Number(rawPrefix);
    if (prefix >= 31) continue;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    const base = ipv4Integer(network) & mask;
    const broadcast = (base | (~mask >>> 0)) >>> 0;
    if (integer === (base >>> 0) || integer === broadcast) return true;
  }
  return false;
}

function addressDecision(address, target, policy, allowedBlocks, approvedHostBlocks, enrollPrivate) {
  const type = addressType(address);
  if (FORBIDDEN_BLOCKS[type].check(address, type)) return { allowed: false, reason: "forbidden" };
  if (isDirectedNetworkOrBroadcast(address, policy.allowedCidrs)) {
    return { allowed: false, reason: "network-or-broadcast" };
  }

  const isPrivate = PRIVATE_BLOCKS[type].check(address, type);
  if (isPrivate) {
    if (enrollPrivate) return { allowed: true, reason: "explicit-private-host" };
    if (approvedHostBlocks[type].check(address, type)) {
      return { allowed: true, reason: "approved-private-host" };
    }
    return allowedBlocks[type].check(address, type)
      ? { allowed: true, reason: "approved-private" }
      : { allowed: false, reason: "private-not-approved" };
  }

  if (target.protocol !== "https:") return { allowed: false, reason: "public-http" };
  return policy.allowPublicHttps
    ? { allowed: true, reason: "approved-public-https" }
    : { allowed: false, reason: "public-https-disabled" };
}

async function defaultLookup(hostname) {
  return systemLookup(hostname, { all: true, verbatim: true });
}

async function timedLookup(lookup, hostname, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("DNS lookup timed out.")), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([Promise.resolve().then(() => lookup(hostname)), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function resolveTarget(targetInput, options) {
  const target = typeof targetInput === "string" ? parseServiceUrl(targetInput) : targetInput;
  const literalVersion = isIP(target.hostname);
  let answers;
  if (literalVersion) {
    answers = [{ address: target.hostname, family: literalVersion }];
  } else {
    try {
      const timeoutMs = Number.isFinite(options.lookupTimeoutMs)
        ? Math.max(1, Math.min(30_000, Number(options.lookupTimeoutMs)))
        : DEFAULT_DNS_TIMEOUT_MS;
      answers = await timedLookup(options.lookup || defaultLookup, target.hostname, timeoutMs);
    } catch {
      throw new NetworkPolicyError("DNS_FAILED", "The service hostname could not be resolved.", 502);
    }
  }
  if (!Array.isArray(answers) || answers.length < 1 || answers.length > MAX_DNS_ANSWERS) {
    throw new NetworkPolicyError("DNS_FAILED", "The service hostname returned no usable addresses.", 502);
  }

  const unique = [];
  const seen = new Set();
  for (const answer of answers) {
    const candidate = cleanHostname(typeof answer === "string" ? answer : answer?.address || "");
    const version = isIP(candidate);
    if (!version) throw new NetworkPolicyError("DNS_FAILED", "DNS returned an invalid address.", 502);
    const address = canonicalAddress(candidate);
    if (!seen.has(address)) {
      unique.push({ address, family: version });
      seen.add(address);
    }
  }

  return { target, addresses: unique };
}

function authorizeResolution(resolution, policyInput, approvedHostCidrs, enrollPrivate) {
  const policy = normalizePolicy(policyInput);
  const normalizedApprovedHosts = normalizeApprovedHostCidrs(approvedHostCidrs);
  const allowedBlocks = buildAllowedBlocks(policy.allowedCidrs);
  const approvedHostBlocks = buildAllowedBlocks(normalizedApprovedHosts);
  const decisions = resolution.addresses.map(({ address }) => (
    addressDecision(address, resolution.target, policy, allowedBlocks, approvedHostBlocks, enrollPrivate)
  ));
  const permitted = decisions.filter((decision) => decision.allowed).length;
  if (permitted !== decisions.length) {
    let code = permitted > 0 ? "DNS_MIXED_POLICY" : "TARGET_NOT_ALLOWED";
    if (permitted === 0
      && normalizedApprovedHosts.length > 0
      && decisions.some((decision) => decision.reason === "private-not-approved")) {
      code = "TARGET_ADDRESS_CHANGED";
    }
    const message = permitted > 0
      ? "The service hostname resolved to a mixture of permitted and blocked addresses."
      : code === "TARGET_ADDRESS_CHANGED"
        ? "The service hostname resolved to a private address that has not been approved for this connection."
        : "The service target is outside the configured network policy.";
    throw new NetworkPolicyError(code, message, 403);
  }

  // Never choose one address from a hostname that straddles private and public
  // address space, even when both sides are independently permitted. That
  // ambiguity makes later DNS changes unsafe and is a common rebinding shape.
  const addressScopes = new Set(resolution.addresses.map(({ address }) => {
    const type = addressType(address);
    return PRIVATE_BLOCKS[type].check(address, type) ? "private" : "public";
  }));
  if (addressScopes.size > 1) {
    throw new NetworkPolicyError(
      "DNS_MIXED_POLICY",
      "The service hostname resolved to both private and public addresses.",
      403
    );
  }

  return {
    target: resolution.target,
    addresses: resolution.addresses,
    pinned: resolution.addresses[0],
    approvedHostCidrs: normalizeApprovedHostCidrs(
      resolution.addresses
        .filter(({ address }) => {
          const type = addressType(address);
          return PRIVATE_BLOCKS[type].check(address, type)
            && !FORBIDDEN_BLOCKS[type].check(address, type);
        })
        .map(({ address }) => exactHostCidr(address))
    )
  };
}

export async function resolveAndAuthorizeTarget(targetInput, policyInput, options = {}) {
  const resolution = await resolveTarget(targetInput, options);
  const approvedHostCidrs = options.approvedHostCidrs === undefined ? [] : options.approvedHostCidrs;
  return authorizeResolution(resolution, policyInput, approvedHostCidrs, false);
}

export async function resolveAndAuthorizeExplicitTarget(targetInput, policyInput, options = {}) {
  const resolution = await resolveTarget(targetInput, options);
  const policy = normalizePolicy(policyInput);
  // An empty manual list selects exact-host enrollment. Once an operator
  // supplies CIDRs they are an intentional registration boundary, so an
  // explicit save must still fit one of those ranges.
  return authorizeResolution(resolution, policy, [], policy.allowedCidrs.length === 0);
}

export function isSecureBrowserOrigin(origin) {
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.origin !== origin || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    return false;
  }
  if (url.protocol === "https:") return true;
  if (url.protocol !== "http:") return false;
  const hostname = cleanHostname(url.hostname);
  return hostname === "localhost" || hostname.endsWith(".localhost")
    || hostname === "::1" || hostname.startsWith("127.");
}
