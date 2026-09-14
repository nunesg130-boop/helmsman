import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

class FakeClassList {
  constructor() {
    this.values = new Set();
  }

  add(...values) {
    values.forEach((value) => this.values.add(value));
  }

  remove(...values) {
    values.forEach((value) => this.values.delete(value));
  }

  contains(value) {
    return this.values.has(value);
  }

  toggle(value, force) {
    if (force === true) this.values.add(value);
    else if (force === false) this.values.delete(value);
    else if (this.values.has(value)) this.values.delete(value);
    else this.values.add(value);
    return this.values.has(value);
  }
}

class FakeElement {
  constructor({ id = "", childSpan = false } = {}) {
    this.id = id;
    this.classList = new FakeClassList();
    this.dataset = {};
    this.attributes = new Map();
    this.hidden = false;
    this.isConnected = true;
    this.scrollTop = 0;
    this.textContent = "";
    this.value = "";
    this.checked = false;
    this.customValidity = "";
    this.markup = "";
    this.markupWrites = 0;
    this.listeners = new Map();
    this.children = [];
    this.childSpan = childSpan ? new FakeElement() : null;
    this.selectorResults = new Map();
  }

  set innerHTML(value) {
    this.markup = String(value);
    this.markupWrites += 1;
  }

  get innerHTML() {
    return this.markup;
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  append(child) {
    this.children.push(child);
  }

  focus() {
    if (globalThis.document) globalThis.document.activeElement = this;
  }

  remove() {
    this.isConnected = false;
  }

  reportValidity() {
    return true;
  }

  setCustomValidity(value) {
    this.customValidity = String(value || "");
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  querySelector(selector) {
    if (selector === "span" && this.childSpan) return this.childSpan;
    return this.selectorResults.get(selector)?.[0] || null;
  }

  querySelectorAll(selector) {
    return this.selectorResults.get(selector) || [];
  }

  registerSelector(selector, ...elements) {
    this.selectorResults.set(selector, elements);
  }
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);

async function waitFor(predicate, label, timeoutMs = 1_000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((resolve) => nativeSetTimeout(resolve, 5));
  }
}

function installFakeBrowser(fetchHandler, suffix) {
  const selectors = [
    "#app",
    "#main-content",
    "#modal-layer",
    "#drawer-layer",
    "#toast-region",
    "#page-eyebrow",
    "#page-title",
    "#mode-badge",
    "#incident-count",
    "#monitor-summary"
  ];
  const elements = new Map(selectors.map((selector) => [selector, new FakeElement({ id: selector.slice(1) })]));
  elements.set("#session-button", new FakeElement({ id: "session-button", childSpan: true }));

  const routes = ["overview", "incidents", "pipeline", "services", "environments", "nodes", "workloads", "portainer", "logs", "settings"].map((route) => {
    const element = new FakeElement();
    element.dataset.route = route;
    return element;
  });
  const workspaceButtons = ["media", "infrastructure"].flatMap((workspace) => Array.from({ length: 2 }, () => {
    const element = new FakeElement();
    element.dataset.action = "switch-workspace";
    element.dataset.workspace = workspace;
    return element;
  }));
  const mediaOnly = [new FakeElement(), new FakeElement()];
  const infrastructureOnly = [new FakeElement(), new FakeElement()];
  const infrastructureIncidentCounts = [new FakeElement()];
  const documentListeners = new Map();
  const windowListeners = new Map();
  const intervalCallbacks = [];
  const requestLog = [];
  const scrollCalls = [];
  const confirmCalls = [];
  const confirmResponses = [];
  const body = new FakeElement();
  const location = {
    hash: "#/overview",
    origin: "http://127.0.0.1:4180",
    replace(value) {
      this.hash = String(value);
    }
  };

  const document = {
    activeElement: new FakeElement(),
    body,
    documentElement: new FakeElement(),
    visibilityState: "visible",
    addEventListener(type, listener) {
      if (!documentListeners.has(type)) documentListeners.set(type, []);
      documentListeners.get(type).push(listener);
    },
    createElement: () => new FakeElement(),
    getElementById(id) {
      return elements.get(`#${id}`) || null;
    },
    querySelector: (selector) => elements.get(selector) || null,
    querySelectorAll(selector) {
      if (selector === "[data-route]") return routes;
      if (selector === "[data-action='switch-workspace']") return workspaceButtons;
      if (selector === ".workspace-media-only") return mediaOnly;
      if (selector === ".workspace-infrastructure-only") return infrastructureOnly;
      if (selector === "[data-infrastructure-incident-count]") return infrastructureIncidentCounts;
      return [];
    }
  };
  const localStorageValues = new Map();
  const sessionStorageValues = new Map();
  const storageFor = (values) => ({
    getItem(key) {
      return values.has(String(key)) ? values.get(String(key)) : null;
    },
    setItem(key, value) {
      values.set(String(key), String(value));
    },
    removeItem(key) {
      values.delete(String(key));
    },
    clear() {
      values.clear();
    }
  });
  const localStorage = storageFor(localStorageValues);
  const sessionStorage = storageFor(sessionStorageValues);
  const clipboardWrites = [];

  const fetch = async (path, options = {}) => {
    const call = { path: String(path), options };
    requestLog.push(call);
    return fetchHandler(call, requestLog);
  };

  Object.defineProperties(globalThis, {
    document: { value: document, configurable: true },
    fetch: { value: fetch, configurable: true },
    location: { value: location, configurable: true },
    navigator: {
      value: {
        platform: "Runtime test",
        clipboard: {
          async writeText(value) {
            clipboardWrites.push(String(value));
          }
        }
      },
      configurable: true
    },
    requestAnimationFrame: { value: (callback) => callback(), configurable: true },
    FormData: {
      value: class FakeFormData {
        constructor(form) {
          this.values = form?.formDataValues instanceof Map ? form.formDataValues : new Map();
        }

        get(name) {
          return this.values.get(name) ?? null;
        }
      },
      configurable: true
    },
    trustedTypes: {
      value: { createPolicy: (_name, rules) => ({ createHTML: (value) => rules.createHTML(value) }) },
      configurable: true
    },
    scrollY: { value: 0, writable: true, configurable: true },
    scrollTo: {
      value: (options = {}) => {
        const top = Number(options.top || 0);
        scrollCalls.push({ ...options, top });
        globalThis.scrollY = top;
        document.documentElement.scrollTop = top;
        document.body.scrollTop = top;
      },
      configurable: true
    },
    window: { value: globalThis, configurable: true },
    localStorage: { value: localStorage, configurable: true },
    sessionStorage: { value: sessionStorage, configurable: true }
  });
  Object.defineProperty(globalThis, "confirm", {
    value: (message) => {
      confirmCalls.push(String(message));
      return confirmResponses.length ? Boolean(confirmResponses.shift()) : true;
    },
    configurable: true
  });

  globalThis.addEventListener = (type, listener) => {
    if (!windowListeners.has(type)) windowListeners.set(type, []);
    windowListeners.get(type).push(listener);
  };
  globalThis.setInterval = (callback) => {
    intervalCallbacks.push(callback);
    return intervalCallbacks.length;
  };
  globalThis.clearInterval = () => {};
  // Toast lifetimes should not hold the smoke-test process open.
  globalThis.setTimeout = (callback) => {
    queueMicrotask(callback);
    return 1;
  };
  globalThis.clearTimeout = () => {};

  async function dispatchDocument(type, event) {
    for (const listener of documentListeners.get(type) || []) await listener(event);
  }

  async function dispatchWindow(type, event = {}) {
    for (const listener of windowListeners.get(type) || []) await listener(event);
  }

  return {
    suffix,
    document,
    elements,
    intervalCallbacks,
    location,
    requestLog,
    scrollCalls,
    workspaceButtons,
    mediaOnly,
    infrastructureOnly,
    infrastructureIncidentCounts,
    localStorageValues,
    sessionStorageValues,
    clipboardWrites,
    confirmCalls,
    confirmResponses,
    dispatchDocument,
    dispatchWindow,
    main: elements.get("#main-content")
  };
}

async function importShell(environment) {
  await import(`../src/app-v5.js?runtime-v5-smoke=${environment.suffix}-${Date.now()}`);
}

function assertSecretAbsentFromBrowserStorage(environment, secret) {
  const persisted = [
    ...environment.localStorageValues.entries(),
    ...environment.sessionStorageValues.entries()
  ];
  assert.ok(
    persisted.every(([key, value]) => !String(key).includes(secret) && !String(value).includes(secret)),
    "access keys must never be written to localStorage or sessionStorage"
  );
  assert.doesNotMatch(`${environment.location.origin}${environment.location.hash}`, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"), "access keys must never enter the URL");
}

function minimalOperationsSnapshot() {
  return {
    version: 1,
    generatedAt: "2026-09-14T12:00:00.000Z",
    overall: { state: "healthy", headline: "Ready", summary: "Ready." },
    services: [],
    pipeline: { state: "healthy", stages: [] },
    incidents: { open: [], recent: [] },
    workload: {},
    events: []
  };
}

async function setupGateContract() {
  const environment = installFakeBrowser(({ path }) => {
    if (path === "/api/v2/status") {
      return jsonResponse({
        setupRequired: true,
        authenticated: false,
        accessKeyConfigured: false,
        csrfToken: null,
        storage: { credentialsEncrypted: true, externalKey: false }
      });
    }
    return jsonResponse({ code: "NOT_FOUND", message: "Unexpected test route." }, 404);
  }, "setup");

  await importShell(environment);
  await waitFor(() => environment.main.innerHTML.includes("Claim this container"), "first-time setup gate");
  const markup = environment.main.innerHTML;
  assert.match(markup, /id="setup-form"/u);
  assert.match(markup, /aria-labelledby="setup-title"/u);
  assert.match(markup, /<h2 id="setup-title">Claim this container<\/h2>/u, "the setup heading reference must resolve");
  assert.match(markup, /<fieldset class="network-policy-fieldset" aria-describedby="setup-network-mode-help">[\s\S]*<legend>Private service access<\/legend>/u);
  assert.match(markup, /name="networkMode" type="radio" value="exact"[^>]*checked/u, "exact-service pins must be the setup default");
  assert.match(markup, /name="allowedCidrs"[^>]*disabled/u, "the setup CIDR textarea must start disabled in exact mode");
  assert.doesNotMatch(markup, /name="allowedCidrs"[^>]*required[^>]*disabled/u, "a disabled exact-mode CIDR textarea must not be required");
  assert.match(markup, /no broad LAN allowlist is created/u);
  assert.match(markup, /Public HTTPS access is a separate opt-in/u);
  assert.match(markup, /name="setupToken" type="password"/u, "the one-time claim token must remain masked");
  assert.doesNotMatch(markup, /vault/iu, "first-time setup must not retain browser-vault language");
  assert.doesNotMatch(markup, /passphrase/iu, "first-time setup must not ask for or mention a passphrase");
  assert.equal(environment.requestLog.filter(({ path }) => path === "/api/v2/status").length, 1);
}

async function accessKeyGateContract() {
  const environment = installFakeBrowser(({ path }) => {
    if (path === "/api/v2/status") {
      return jsonResponse({
        setupRequired: false,
        authenticated: false,
        accessKeyConfigured: true,
        csrfToken: null,
        storage: { credentialsEncrypted: true, externalKey: false }
      });
    }
    return jsonResponse({ code: "NOT_FOUND", message: "Unexpected test route." }, 404);
  }, "pairing-heading");

  await importShell(environment);
  await waitFor(() => environment.main.innerHTML.includes("Unlock Helmsman"), "access-key gate");
  assert.match(environment.main.innerHTML, /aria-labelledby="access-title"/u);
  assert.match(
    environment.main.innerHTML,
    /<h2 id="access-title">Unlock Helmsman<\/h2>/u,
    "the access-key heading reference must resolve"
  );
  assert.match(environment.main.innerHTML, /id="access-login-form"/u);
  assert.match(environment.main.innerHTML, /name="accessKey" type="password"/u, "the reusable key must remain masked");
  assert.match(environment.main.innerHTML, /one-year session/u);
  assert.match(environment.main.innerHTML, /rotate-access-key --confirm/u);
  assert.doesNotMatch(environment.main.innerHTML, /one-time browser invite|pair this browser/iu);
}

async function accessKeyRecoveryGateContract() {
  const environment = installFakeBrowser(({ path }) => {
    if (path === "/api/v2/status") {
      return jsonResponse({
        setupRequired: false,
        authenticated: false,
        accessKeyConfigured: false,
        csrfToken: null,
        storage: { credentialsEncrypted: true, externalKey: false }
      });
    }
    return jsonResponse({ code: "NOT_FOUND", message: "Unexpected test route." }, 404);
  }, "access-key-recovery");

  await importShell(environment);
  await waitFor(() => environment.main.innerHTML.includes("Create an access key"), "access-key recovery gate");
  assert.match(environment.main.innerHTML, /aria-labelledby="access-recovery-title"/u);
  assert.match(environment.main.innerHTML, /Settings → Security and access/u);
  assert.match(environment.main.innerHTML, /rotate-access-key --confirm/u);
  assert.doesNotMatch(environment.main.innerHTML, /id="access-login-form"/u, "a missing key must not render an unusable login form");
  assert.doesNotMatch(environment.main.innerHTML, /reset-access|session\/invite|session\/pair/u);
}

async function setupClaimAccessKeyContract() {
  const generatedKey = "hm-generated-<script>claim-xss</script>";
  const setupToken = "one-time-setup-token";
  const csrfToken = "claim-csrf-token";
  const config = { policy: { allowedCidrs: [], allowPublicHttps: false }, services: [] };
  const snapshot = minimalOperationsSnapshot();
  const environment = installFakeBrowser(({ path, options }) => {
    if (path === "/api/v2/status") {
      return jsonResponse({
        setupRequired: true,
        authenticated: false,
        accessKeyConfigured: false,
        csrfToken: null,
        storage: { credentialsEncrypted: true, externalKey: false }
      });
    }
    if (path === "/api/v2/setup/claim" && options.method === "POST") {
      return jsonResponse({
        accessKey: generatedKey,
        csrfToken,
        session: { id: "161f1a48-b46d-43cd-bdd0-e921438f61be", name: "Claim Browser" },
        config: clone(config)
      }, 201);
    }
    if (path === "/api/v2/operations/snapshot") return jsonResponse(clone(snapshot));
    if (path === "/api/v2/sessions") {
      return jsonResponse({
        currentSessionId: "161f1a48-b46d-43cd-bdd0-e921438f61be",
        sessions: []
      });
    }
    return jsonResponse({ code: "NOT_FOUND", message: "Unexpected test route." }, 404);
  }, "setup-claim-access-key");

  await importShell(environment);
  await waitFor(() => environment.main.innerHTML.includes("Claim this container"), "claim form");
  const form = new FakeElement({ id: "setup-form" });
  form.dataset.networkMode = "exact";
  form.formDataValues = new Map([
    ["setupToken", setupToken],
    ["deviceName", "Claim Browser"],
    ["networkMode", "exact"],
    ["allowPublicHttps", null]
  ]);
  form.registerSelector("#setup-error", new FakeElement());
  await environment.dispatchDocument("submit", { target: form, preventDefault() {} });
  await waitFor(() => environment.main.innerHTML.includes("New Helmsman access key"), "one-time access-key reveal");

  const claim = environment.requestLog.find(({ path }) => path === "/api/v2/setup/claim");
  assert.ok(claim, "first-time setup must use the claim route");
  assert.equal(claim.options.credentials, "same-origin");
  assert.equal(claim.options.headers.has("X-Jellofin-CSRF"), false, "claim must not require an existing CSRF token");
  assert.deepEqual(JSON.parse(claim.options.body), {
    setupToken,
    deviceName: "Claim Browser",
    origin: "http://127.0.0.1:4180",
    allowedCidrs: [],
    allowPublicHttps: false
  });
  assert.equal(environment.location.hash, "#/settings", "a successful claim must open Settings so the generated key cannot be missed");
  assert.match(environment.main.innerHTML, /hm-generated-&lt;script&gt;claim-xss&lt;\/script&gt;/u);
  assert.doesNotMatch(environment.main.innerHTML, /<script>claim-xss<\/script>/u, "the one-time key reveal must be escaped");
  assert.equal((environment.main.innerHTML.match(/hm-generated-/gu) || []).length, 1, "the generated key must appear only once in the rendered page");
  assert.match(environment.main.innerHTML, /save it in your password manager/iu);
  assert.match(environment.main.innerHTML, /cannot recover it/iu);
  assertSecretAbsentFromBrowserStorage(environment, generatedKey);

  const actionTarget = (action) => {
    const element = { dataset: { action }, disabled: false, isConnected: true };
    element.closest = () => element;
    return element;
  };
  await environment.dispatchDocument("click", { target: actionTarget("copy-access-key") });
  assert.deepEqual(environment.clipboardWrites, [generatedKey], "copy must use the in-memory reveal without persisting it");
  await environment.dispatchDocument("click", { target: actionTarget("dismiss-access-key") });
  assert.doesNotMatch(environment.main.innerHTML, /hm-generated-/u, "dismissing the one-time reveal must remove the key from the page");
}

async function firstAccessKeyCreationContract() {
  const csrfToken = "legacy-session-csrf";
  const generatedKey = "hm-first-universal-access-key";
  const currentSessionId = "56565656-5656-4565-8565-565656565656";
  const config = { policy: { allowedCidrs: [], allowPublicHttps: false }, services: [] };
  const snapshot = minimalOperationsSnapshot();
  const environment = installFakeBrowser(({ path, options }) => {
    if (path === "/api/v2/status") {
      return jsonResponse({
        setupRequired: false,
        authenticated: true,
        accessKeyConfigured: false,
        csrfToken,
        session: { id: currentSessionId, name: "Migrated Browser" },
        storage: { credentialsEncrypted: true, externalKey: false }
      });
    }
    if (path === "/api/v2/config") return jsonResponse(clone(config));
    if (path === "/api/v2/operations/snapshot") return jsonResponse(clone(snapshot));
    if (path === "/api/v2/sessions") {
      return jsonResponse({
        currentSessionId,
        sessions: [{
          id: currentSessionId,
          name: "Migrated Browser",
          origin: "http://127.0.0.1:4180",
          createdAt: "2026-09-14T12:00:00.000Z",
          expiresAt: "2027-09-14T12:00:00.000Z"
        }]
      });
    }
    if (path === "/api/v2/access/rotate" && options.method === "POST") {
      return jsonResponse({
        accessKey: generatedKey,
        csrfToken: "first-key-csrf",
        session: { id: currentSessionId, name: "Migrated Browser" }
      });
    }
    return jsonResponse({ code: "NOT_FOUND", message: "Unexpected test route." }, 404);
  }, "first-access-key-creation");

  environment.location.hash = "#/settings";
  await importShell(environment);
  await waitFor(() => environment.main.innerHTML.includes("Access key not configured"), "first-key Settings state");
  assert.match(environment.main.innerHTML, />Create access key<\/button>/u);
  const target = { dataset: { action: "rotate-access-key" }, disabled: false, isConnected: true };
  target.closest = () => target;
  await environment.dispatchDocument("click", { target });
  await waitFor(() => environment.requestLog.some(({ path }) => path === "/api/v2/access/rotate"), "first access-key creation");

  assert.deepEqual(environment.confirmCalls, [], "creating the first key must not show a destructive-rotation confirmation");
  const request = environment.requestLog.find(({ path }) => path === "/api/v2/access/rotate");
  assert.equal(request.options.headers.get("X-Jellofin-CSRF"), csrfToken);
  assert.match(environment.main.innerHTML, /hm-first-universal-access-key/u);
}

async function accessKeyLoginContract() {
  const rejectedKey = "hm-rejected-secret";
  const acceptedKey = "hm-accepted-secret";
  const csrfToken = "login-csrf-token";
  const config = { policy: { allowedCidrs: [], allowPublicHttps: false }, services: [] };
  const snapshot = minimalOperationsSnapshot();
  let attempts = 0;
  const environment = installFakeBrowser(({ path, options }) => {
    if (path === "/api/v2/status") {
      return jsonResponse({
        setupRequired: false,
        authenticated: false,
        accessKeyConfigured: true,
        csrfToken: null,
        storage: { credentialsEncrypted: true, externalKey: false }
      });
    }
    if (path === "/api/v2/access/login" && options.method === "POST") {
      attempts += 1;
      if (attempts === 1) {
        return jsonResponse({ code: "ACCESS_DENIED", message: `Rejected ${rejectedKey}` }, 401);
      }
      return jsonResponse({
        csrfToken,
        session: { id: "467f10c9-7f8c-4164-aa34-a1c87f69670c", name: "Remote Browser" },
        config: clone(config)
      });
    }
    if (path === "/api/v2/config") return jsonResponse(clone(config));
    if (path === "/api/v2/operations/snapshot") return jsonResponse(clone(snapshot));
    if (path === "/api/v2/sessions") {
      return jsonResponse({ currentSessionId: "467f10c9-7f8c-4164-aa34-a1c87f69670c", sessions: [] });
    }
    return jsonResponse({ code: "NOT_FOUND", message: "Unexpected test route." }, 404);
  }, "access-key-login");

  await importShell(environment);
  await waitFor(() => environment.main.innerHTML.includes("Unlock Helmsman"), "access-key login form");
  const form = new FakeElement({ id: "access-login-form" });
  const error = new FakeElement();
  const accessKeyInput = new FakeElement();
  form.registerSelector("#access-login-error", error);
  form.registerSelector("input[name='accessKey']", accessKeyInput);
  form.formDataValues = new Map([["accessKey", rejectedKey], ["deviceName", "Remote Browser"]]);
  accessKeyInput.value = rejectedKey;
  await environment.dispatchDocument("submit", { target: form, preventDefault() {} });
  await waitFor(() => attempts === 1, "rejected access-key login");
  await waitFor(() => error.textContent.length > 0, "redacted login error");
  assert.equal(error.textContent, "The access key was not accepted. Check the key and try again.");
  assert.doesNotMatch(error.textContent, new RegExp(rejectedKey, "u"), "a backend error must not echo a rejected key");
  assert.equal(accessKeyInput.value, "", "the access-key input must be cleared after an attempt");
  assertSecretAbsentFromBrowserStorage(environment, rejectedKey);

  form.formDataValues = new Map([["accessKey", acceptedKey], ["deviceName", "Remote Browser"]]);
  accessKeyInput.value = acceptedKey;
  await environment.dispatchDocument("submit", { target: form, preventDefault() {} });
  await waitFor(() => environment.main.innerHTML.includes("operations-page"), "successful access-key login");
  const login = environment.requestLog.filter(({ path }) => path === "/api/v2/access/login").at(-1);
  assert.equal(login.options.credentials, "same-origin");
  assert.equal(login.options.headers.has("X-Jellofin-CSRF"), false, "login must not require an existing CSRF token");
  assert.deepEqual(JSON.parse(login.options.body), {
    accessKey: acceptedKey,
    deviceName: "Remote Browser",
    origin: "http://127.0.0.1:4180"
  });
  assert.equal(accessKeyInput.value, "", "the accepted key must be cleared from the detached form");
  assert.doesNotMatch(environment.main.innerHTML, new RegExp(acceptedKey, "u"), "the submitted key must not enter authenticated markup");
  assertSecretAbsentFromBrowserStorage(environment, acceptedKey);
}

async function networkPolicyInteractionContract() {
  const csrfToken = "network-policy-csrf-token";
  const config = {
    policy: { allowedCidrs: [], allowPublicHttps: false, revision: 1 },
    services: []
  };
  const snapshot = {
    version: 1,
    generatedAt: "2026-09-12T21:09:14.000Z",
    overall: { state: "healthy", headline: "Ready", summary: "Ready." },
    services: [],
    pipeline: { state: "healthy", stages: [] },
    incidents: { open: [], recent: [] },
    workload: {},
    events: []
  };

  const environment = installFakeBrowser(({ path, options }) => {
    if (path === "/api/v2/status") {
      return jsonResponse({
        setupRequired: false,
        authenticated: true,
        csrfToken,
        session: { name: "Network Browser" },
        storage: { credentialsEncrypted: true, externalKey: false }
      });
    }
    if (path === "/api/v2/config" && String(options.method || "GET") === "GET") return jsonResponse(clone(config));
    if (path === "/api/v2/config" && options.method === "PUT") {
      const body = JSON.parse(options.body);
      config.policy = { ...body, revision: config.policy.revision + 1 };
      return jsonResponse(clone(config));
    }
    if (path === "/api/v2/operations/snapshot") return jsonResponse(clone(snapshot));
    if (path === "/api/v2/sessions") return jsonResponse({ currentSessionId: "", sessions: [] });
    return jsonResponse({ code: "NOT_FOUND", message: "Unexpected test route." }, 404);
  }, "network-policy");

  environment.location.hash = "#/settings";
  await importShell(environment);
  await waitFor(() => environment.main.innerHTML.includes("settings-page-v5"), "network settings");
  assert.match(environment.main.innerHTML, /name="networkMode" type="radio" value="exact"[^>]*checked/u);
  assert.match(environment.main.innerHTML, /name="allowedCidrs"[^>]*disabled/u);
  assert.match(environment.main.innerHTML, /Independent of the private-address mode/u);

  const form = new FakeElement({ id: "network-form" });
  form.dataset.networkMode = "exact";
  const exact = new FakeElement();
  exact.name = "networkMode";
  exact.value = "exact";
  exact.checked = true;
  const manual = new FakeElement();
  manual.name = "networkMode";
  manual.value = "manual";
  const fields = new FakeElement();
  fields.hidden = true;
  const textarea = new FakeElement({ id: "settings-allowed-cidrs" });
  textarea.name = "allowedCidrs";
  textarea.value = "10.0.0.0/8";
  textarea.disabled = true;
  textarea.required = false;
  form.registerSelector("input[name='networkMode']:checked", exact);
  form.registerSelector("input[name='networkMode'][value='manual']", manual);
  form.registerSelector("[data-network-cidr-fields]", fields);
  form.registerSelector("textarea[name='allowedCidrs']", textarea);
  manual.closest = (selector) => selector === "#setup-form, #network-form" ? form : null;
  exact.closest = manual.closest;

  const writesBeforeToggle = environment.main.markupWrites;
  exact.checked = false;
  manual.checked = true;
  manual.focus();
  form.registerSelector("input[name='networkMode']:checked", manual);
  await environment.dispatchDocument("change", { target: manual });
  assert.equal(form.dataset.networkMode, "manual");
  assert.equal(fields.hidden, false);
  assert.equal(textarea.disabled, false);
  assert.equal(textarea.required, true);
  assert.equal(manual.attributes.get("aria-expanded"), "true");
  assert.equal(environment.document.activeElement, manual, "opening manual CIDRs must retain radio focus");
  assert.equal(environment.main.markupWrites, writesBeforeToggle, "switching network modes must not rebuild the page");

  manual.checked = false;
  exact.checked = true;
  form.registerSelector("input[name='networkMode']:checked", exact);
  await environment.dispatchDocument("change", { target: exact });
  assert.equal(fields.hidden, true);
  assert.equal(textarea.disabled, true);
  assert.equal(textarea.required, false);
  assert.equal(manual.attributes.get("aria-expanded"), "false");
  assert.equal(textarea.value, "10.0.0.0/8", "an in-place toggle may hide but must not erase the operator's draft");

  form.formDataValues = new Map([
    ["networkMode", "exact"],
    ["allowedCidrs", "10.0.0.0/8"],
    ["allowPublicHttps", "on"]
  ]);
  await environment.dispatchDocument("submit", { target: form, preventDefault() {} });
  await waitFor(
    () => environment.requestLog.filter(({ path, options }) => path === "/api/v2/config" && options.method === "PUT").length === 1,
    "exact-service policy save"
  );
  const exactSave = environment.requestLog.find(({ path, options }) => path === "/api/v2/config" && options.method === "PUT");
  assert.equal(exactSave.options.credentials, "same-origin");
  assert.equal(exactSave.options.headers.get("X-Jellofin-CSRF"), csrfToken);
  assert.deepEqual(JSON.parse(exactSave.options.body), { allowedCidrs: [], allowPublicHttps: true });
  await waitFor(() => environment.main.innerHTML.includes('name="allowPublicHttps" checked'), "saved public HTTPS opt-in");

  form.dataset.networkMode = "manual";
  form.formDataValues = new Map([
    ["networkMode", "manual"],
    ["allowedCidrs", " 192.168.10.4/32\n\n192.168.10.0/24,  fd00::/64 "],
    ["allowPublicHttps", null]
  ]);
  await environment.dispatchDocument("submit", { target: form, preventDefault() {} });
  await waitFor(
    () => environment.requestLog.filter(({ path, options }) => path === "/api/v2/config" && options.method === "PUT").length === 2,
    "manual CIDR policy save"
  );
  const manualSave = environment.requestLog.filter(
    ({ path, options }) => path === "/api/v2/config" && options.method === "PUT"
  ).at(-1);
  assert.deepEqual(JSON.parse(manualSave.options.body), {
    allowedCidrs: ["192.168.10.4/32", "192.168.10.0/24", "fd00::/64"],
    allowPublicHttps: false
  });
}

async function emptyStateLayoutContract() {
  const [styles, shellStyles, documentMarkup, application] = await Promise.all([
    readFile(new URL("../src/ui/control.css", import.meta.url), "utf8"),
    readFile(new URL("../styles.css", import.meta.url), "utf8"),
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../src/app-v5.js", import.meta.url), "utf8")
  ]);
  const textSpanOverride = styles.match(
    /\.detail-page \.empty-state > span,\s*\.settings-page-v5 \.empty-state > span\s*\{([^}]*)\}/u
  )?.[1] || "";
  assert.match(textSpanOverride, /width:\s*min\(100%,\s*520px\)/u, "empty-state copy must not inherit the legacy 48px icon width");
  assert.match(textSpanOverride, /height:\s*auto/u, "empty-state copy must grow to its text height");
  assert.match(textSpanOverride, /background:\s*transparent/u, "empty-state copy must not look like an icon tile");
  assert.match(textSpanOverride, /line-height:\s*1\.55/u, "empty-state copy must remain readable");
  assert.match(documentMarkup, /<body\s+av-disable="true">/u, "the app shell must opt out of AliasVault's page-wide autofill injection");
  assert.match(documentMarkup, /content="A private, local-first operations center for your media and infrastructure stack\."/u);
  assert.doesNotMatch(documentMarkup, /id="monitor-summary"\s+role="status"/u, "background polling must not repeatedly announce a global status region");
  assert.match(shellStyles, /\.world-option\s*\{[\s\S]*?min-height:\s*44px/u, "sidebar workspace controls need a 44px touch target");
  assert.match(shellStyles, /\.topbar-workspace-switch button\s*\{[\s\S]*?min-height:\s*44px/u, "mobile workspace controls need a 44px touch target");
  assert.match(shellStyles, /\[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\}/u, "semantic hidden state must override flex navigation display rules");
  assert.match(shellStyles, /\.media-art-image:not\(\[hidden\]\)\s*\+\s*\.art-fallback-letter/u, "a hidden retrying artwork image must reveal its text fallback");
  assert.match(shellStyles, /:has\(\.hero-art-image:not\(\[hidden\]\)\)/u, "a hidden retrying hero image must reveal its visual fallback");
  for (const route of ["home", "discover", "library", "requests", "activity", "calendar", "health", "connections"]) {
    assert.equal((documentMarkup.match(new RegExp(`class="[^"]*workspace-media-only[^"]*"[^>]+data-route="${route}"`, "gu")) || []).length, 2, `${route} must appear only in the desktop and mobile Media navigation`);
  }
  for (const route of ["overview", "environments", "nodes", "workloads", "portainer", "incidents"]) {
    assert.equal((documentMarkup.match(new RegExp(`class="[^"]*workspace-infrastructure-only[^"]*"[^>]+data-route="${route}"`, "gu")) || []).length, 2, `${route} must appear only in the desktop and mobile Infrastructure navigation`);
  }
  for (const [code, copy] of [
    ["FORBIDDEN", "Authenticated user lacks permission for this capability or environment"],
    ["TLS_PIN_MISMATCH", "Certificate fingerprint does not match"],
    ["TLS_CERTIFICATE_UNTRUSTED", "Certificate is not trusted by the container"],
    ["TLS_CERTIFICATE_INVALID", "Certificate is invalid or expired"],
    ["UPSTREAM_REDIRECT_REJECTED", "API request redirected; configure the final HTTPS URL"],
    ["UPSTREAM_CONTENT_REJECTED", "Service returned HTML or unsupported API content"],
    ["UPSTREAM_RESPONSE_FAILED", "Upstream response ended unexpectedly"],
    ["BROKER_BUSY", "Helmsman request capacity reached"],
    ["TARGET_ADDRESS_CHANGED", "Saved hostname now resolves to an unapproved address"],
    ["PORTAINER_INVENTORY_PARTIAL", "Portainer inventory coverage is partial"]
  ]) {
    assert.match(application, new RegExp(`${code}: "${copy.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}"`, "u"), `${code} needs specific operator-facing evidence`);
  }
  assert.match(application, /function safeMediaFocusKey[\s\S]*?\^m-\[a-z0-9\]/u, "media focus restoration must validate its stable DOM key");
  assert.match(application, /\[data-media-key='\$\{focusedMediaKey\}'\]\[data-action='\$\{focusedMediaAction\}'\]/u, "structural media refreshes must restore a focused card by safe key and action");
  assert.match(application, /api\("\/api\/v2\/access\/login"/u, "the unauthenticated gate must use the reusable access-key login route");
  assert.match(application, /api\("\/api\/v2\/access\/rotate"/u, "Settings must use the authenticated access-key rotation route");
  assert.doesNotMatch(application, /\/api\/v2\/session\/(?:invite|pair)/u, "the retired browser-invite routes must not remain reachable from the runtime");
  assert.doesNotMatch(application, /(?:localStorage|sessionStorage)\?\.setItem\([^\n]*accessKey/iu, "access keys must not be persisted in web storage");
  assert.match(application, /contains\("media-art-image"\)[\s\S]*?contains\("hero-art-image"\)/u, "failed poster and hero artwork must both reveal their CSS fallback");
}

async function mediaArtworkLoadingContract() {
  const artworkUrl = (index) => `/api/v2/media/artwork/${index.toString(16).padStart(32, "0")}`;
  const mediaItem = (index, title = `Media title ${index}`) => ({
    id: `movie:tmdb:${index}`,
    title,
    mediaType: "movie",
    year: "2026",
    artworkUrl: artworkUrl(index),
    progress: 12,
    available: true
  });
  const cards = Array.from({ length: 6 }, (_value, index) => mediaItem(index + 2));
  const snapshot = {
    version: 1,
    generatedAt: "2026-09-13T12:00:00.000Z",
    overall: { state: "healthy", headline: "Ready", summary: "Ready." },
    services: [],
    pipeline: { state: "healthy", stages: [] },
    incidents: { open: [], recent: [] },
    workload: {},
    events: [],
    media: {
      schema: 1,
      generatedAt: "2026-09-13T12:00:00.000Z",
      records: cards,
      home: {
        nowPlaying: [mediaItem(1, "Featured title")],
        continueWatching: cards,
        recentlyAdded: [],
        pendingRequests: [],
        activeDownloads: [],
        blockedImports: [],
        upcoming: [],
        missing: [],
        subtitleBacklog: []
      },
      library: cards,
      discover: cards,
      requests: [],
      activity: [],
      calendar: [],
      subtitleBacklog: [],
      metrics: { libraryTotal: cards.length }
    }
  };
  const environment = installFakeBrowser(({ path }) => {
    if (path === "/api/v2/status") {
      return jsonResponse({
        setupRequired: false,
        authenticated: true,
        csrfToken: "media-artwork-csrf",
        session: { name: "Artwork Browser" },
        storage: { credentialsEncrypted: true, externalKey: false }
      });
    }
    if (path === "/api/v2/config") return jsonResponse({ policy: { allowedCidrs: [] }, services: [] });
    if (path === "/api/v2/operations/snapshot") return jsonResponse(clone(snapshot));
    if (path === "/api/v2/sessions") return jsonResponse({ currentSessionId: "", sessions: [] });
    return jsonResponse({ code: "NOT_FOUND", message: "Unexpected test route." }, 404);
  }, "media-artwork-loading");

  environment.location.hash = "#/home";
  await importShell(environment);
  await waitFor(() => environment.main.innerHTML.includes("media-home-page"), "media artwork home");

  const hero = environment.main.innerHTML.match(/<img class="hero-art-image"[^>]+>/u)?.[0] || "";
  assert.match(hero, /width="342" height="513"/u, "hero artwork must publish its intrinsic poster dimensions");
  assert.match(hero, /loading="eager" fetchpriority="high"/u, "the visible hero artwork must load eagerly at high priority");
  assert.match(hero, new RegExp(`data-artwork-src="${artworkUrl(1)}"`, "u"), "the hero retry source must stay on the same-origin artwork route");

  const homePosters = [...environment.main.innerHTML.matchAll(/<img class="media-art-image"[^>]+>/gu)].map(([markup]) => markup);
  assert.equal(homePosters.length, cards.length, "the Continue Watching rail must render each available poster");
  for (const poster of homePosters.slice(0, 4)) {
    assert.match(poster, /width="342" height="513"/u);
    assert.match(poster, /loading="eager" fetchpriority="high"/u, "only the initial visible rail cards should be promoted");
  }
  for (const poster of homePosters.slice(4)) {
    assert.match(poster, /loading="lazy" fetchpriority="low"/u, "posters outside the initial viewport must remain lazy and low priority");
  }

  environment.location.hash = "#/library";
  globalThis.scrollY = 812;
  environment.document.documentElement.scrollTop = 812;
  environment.document.body.scrollTop = 812;
  await environment.dispatchWindow("hashchange", { type: "hashchange" });
  assert.equal(globalThis.scrollY, 0, "route navigation must reset the document to the top");
  assert.equal(environment.document.documentElement.scrollTop, 0);
  assert.equal(environment.document.body.scrollTop, 0);
  assert.deepEqual(environment.scrollCalls.at(-1), { top: 0, left: 0, behavior: "instant" });
  const libraryPosters = [...environment.main.innerHTML.matchAll(/<img class="media-art-image"[^>]+>/gu)].map(([markup]) => markup);
  assert.equal(libraryPosters.length, cards.length);
  assert.ok(libraryPosters.slice(0, 4).every((markup) => /loading="eager" fetchpriority="high"/u.test(markup)));
  assert.ok(libraryPosters.slice(4).every((markup) => /loading="lazy" fetchpriority="low"/u.test(markup)));

  const writesBeforePoll = environment.main.markupWrites;
  const markupBeforePoll = environment.main.innerHTML;
  const snapshotsBeforePoll = environment.requestLog.filter(({ path }) => path === "/api/v2/operations/snapshot").length;
  snapshot.media.library[0].progress = 48;
  await environment.intervalCallbacks.at(-1)();
  await waitFor(
    () => environment.requestLog.filter(({ path }) => path === "/api/v2/operations/snapshot").length === snapshotsBeforePoll + 1,
    "media artwork stability poll"
  );
  assert.equal(environment.main.markupWrites, writesBeforePoll, "volatile media progress must not reconstruct artwork elements");
  assert.equal(environment.main.innerHTML, markupBeforePoll, "stable artwork URLs must survive polling without being reset");

  const failedImage = new FakeElement({ id: "transient-artwork" });
  failedImage.classList.add("media-art-image");
  failedImage.dataset.artworkSrc = artworkUrl(2);
  failedImage.setAttribute("src", artworkUrl(2));
  await environment.dispatchDocument("error", { target: failedImage });
  assert.equal(failedImage.isConnected, true, "a first image failure must keep the element available for a bounded retry");
  assert.equal(failedImage.dataset.artworkRetryCount, "1");
  assert.equal(failedImage.attributes.get("src"), artworkUrl(2), "the retry must reuse the stable URL without a query cache-buster");
  assert.equal(failedImage.hidden, false);

  await environment.dispatchDocument("error", { target: failedImage });
  assert.equal(failedImage.isConnected, true, "a second transient failure receives the final bounded retry");
  assert.equal(failedImage.dataset.artworkRetryCount, "2");
  assert.equal(failedImage.attributes.get("src"), artworkUrl(2));

  await environment.dispatchDocument("error", { target: failedImage });
  assert.equal(failedImage.isConnected, false, "a third failure must reveal the fallback without entering a retry loop");
}

async function mediaSemanticsContract() {
  const today = new Date().toISOString();
  const snapshot = {
    version: 1,
    generatedAt: today,
    overall: { state: "healthy", headline: "Ready", summary: "Ready." },
    services: [],
    pipeline: { state: "healthy", stages: [] },
    incidents: { open: [], recent: [] },
    workload: {},
    events: [],
    media: {
      schema: 1,
      generatedAt: today,
      records: [
        {
          id: "movie:tmdb:1108427",
          title: "Moana",
          mediaType: "movie",
          year: "2026",
          providerIds: { tmdb: "1108427" },
          requested: true,
          monitored: true,
          available: false,
          lifecycle: { stage: "monitored" }
        },
        {
          id: "movie:tmdb:999",
          title: "The Runner",
          mediaType: "movie",
          year: "2026",
          providerIds: { tmdb: "999" },
          requested: false,
          monitored: false,
          available: false,
          lifecycle: { stage: "unknown" }
        },
        {
          id: "series:tvdb:500",
          title: "VisionQuest",
          mediaType: "series",
          year: "2026",
          providerIds: { tvdb: "500" },
          monitored: true,
          imported: true,
          available: true,
          lifecycle: { stage: "available" }
        }
      ],
      home: {
        nowPlaying: [],
        continueWatching: [],
        recentlyAdded: [],
        pendingRequests: [],
        activeDownloads: [],
        blockedImports: [],
        upcoming: [{
          id: "radarr:movie:future",
          title: "Future Signal",
          mediaType: "movie",
          year: "2027",
          monitored: true,
          available: false,
          state: "upcoming",
          releaseAt: today,
          lifecycle: { stage: "monitored" },
          artworkUrl: "/api/v2/media/artwork/0123456789abcdef0123456789abcdef"
        }],
        missing: [],
        subtitleBacklog: []
      },
      library: [],
      discover: [
        {
          id: "seerr-discover:1108427",
          mediaId: "movie:tmdb:1108427",
          title: "Movie 1108427",
          mediaType: "movie",
          year: "2026",
          providerIds: { tmdb: "1108427" },
          state: "processing",
          mediaStatus: "processing"
        },
        {
          id: "seerr-discover:999",
          mediaId: "movie:tmdb:999",
          title: "The Runner",
          mediaType: "movie",
          year: "2026",
          providerIds: { tmdb: "999" },
          state: "not_requested",
          mediaStatus: "unknown"
        }
      ],
      requests: [
        {
          id: "seerr-request:100",
          requestId: 100,
          mediaId: "movie:tmdb:1108427",
          title: "Moana",
          mediaType: "movie",
          requested: true,
          requestedSeasons: [],
          requestStatus: "completed",
          mediaStatus: "available",
          requestCompleted: true,
          requestFulfilled: true,
          available: false,
          lifecycle: { stage: "requested" },
          requestedAt: today
        },
        {
          id: "seerr-request:101",
          requestId: 101,
          mediaId: "series:tvdb:500",
          title: "VisionQuest",
          mediaType: "series",
          requested: true,
          requestedSeasons: [2],
          requestScope: "seasons",
          requestStatus: "approved",
          mediaStatus: "processing",
          requestFulfilled: false,
          available: false,
          requestedAt: today
        },
        {
          id: "seerr-request:102",
          requestId: 102,
          mediaId: "series:tvdb:500",
          title: "VisionQuest",
          mediaType: "series",
          requested: true,
          requestedSeasons: [3],
          requestScope: "seasons",
          requestStatus: "pending",
          mediaStatus: "partially_available",
          requestFulfilled: false,
          available: false,
          requestedAt: today
        },
        {
          id: "seerr-request:103",
          requestId: 103,
          title: "Processing Signal",
          mediaType: "movie",
          requested: true,
          requestedSeasons: [],
          requestStatus: "approved",
          mediaStatus: "processing",
          requestFulfilled: false,
          available: false,
          requestedAt: today
        },
        {
          id: "seerr-request:104",
          requestId: 104,
          title: "Partial Signal",
          mediaType: "series",
          requested: true,
          requestedSeasons: [1, 2],
          requestScope: "seasons",
          seasonStatuses: [
            { seasonNumber: 1, status: "available" },
            { seasonNumber: 2, status: "partially_available" }
          ],
          requestStatus: "approved",
          mediaStatus: "partially_available",
          requestFulfilled: false,
          partiallyAvailable: true,
          available: false,
          requestedAt: today
        },
        {
          id: "seerr-request:105",
          requestId: 105,
          title: "Removed Signal",
          mediaType: "movie",
          requested: true,
          requestedSeasons: [],
          requestStatus: "completed",
          mediaStatus: "deleted",
          requestCompleted: true,
          requestFulfilled: false,
          available: false,
          requestedAt: today
        },
        {
          id: "seerr-request:106",
          requestId: 106,
          title: "Failed Signal",
          mediaType: "movie",
          requested: true,
          requestedSeasons: [],
          requestStatus: "failed",
          mediaStatus: "unknown",
          requestFulfilled: false,
          available: false,
          requestedAt: today
        },
        {
          id: "seerr-request:107",
          requestId: 107,
          title: "Blocked Signal",
          mediaType: "movie",
          requested: true,
          requestedSeasons: [],
          requestStatus: "completed",
          mediaStatus: "blocklisted",
          requestCompleted: true,
          requestFulfilled: false,
          available: false,
          requestedAt: today
        },
        {
          id: "seerr-request:108",
          requestId: 108,
          title: "Recovered Signal",
          mediaType: "movie",
          requested: true,
          requestedSeasons: [],
          requestStatus: "failed",
          mediaStatus: "unknown",
          requestFulfilled: false,
          available: true,
          requestedAt: today
        },
        {
          id: "seerr-request:109",
          requestId: 109,
          title: "Available With Error",
          mediaType: "movie",
          requested: true,
          requestedSeasons: [],
          requestStatus: "completed",
          mediaStatus: "available",
          requestFulfilled: true,
          available: true,
          error: "Current import verification failed.",
          requestedAt: today
        }
      ],
      activity: [],
      calendar: [
        {
          id: "sonarr:episode:1",
          title: "Lights Out",
          episodeTitle: "Lights Out",
          mediaType: "episode",
          seasonNumber: 1,
          episodeNumber: 1,
          state: "upcoming",
          monitored: true,
          releaseAt: today,
          lifecycle: { stage: "monitored" }
        },
        {
          id: "radarr:movie:400",
          title: "400",
          mediaType: "movie",
          state: "upcoming",
          monitored: true,
          releaseAt: today,
          lifecycle: { stage: "monitored" }
        }
      ],
      subtitleBacklog: [],
      metrics: { libraryTotal: 1 }
    }
  };
  const environment = installFakeBrowser(({ path }) => {
    if (path === "/api/v2/status") {
      return jsonResponse({
        setupRequired: false,
        authenticated: true,
        csrfToken: "media-semantics-csrf",
        session: { name: "Media Semantics Browser" },
        storage: { credentialsEncrypted: true, externalKey: false }
      });
    }
    if (path === "/api/v2/config") return jsonResponse({ policy: { allowedCidrs: [] }, services: [] });
    if (path === "/api/v2/operations/snapshot") return jsonResponse(clone(snapshot));
    if (path === "/api/v2/sessions") return jsonResponse({ currentSessionId: "", sessions: [] });
    return jsonResponse({ code: "NOT_FOUND", message: "Unexpected test route." }, 404);
  }, "media-semantics");

  environment.location.hash = "#/discover";
  await importShell(environment);
  await waitFor(() => environment.main.innerHTML.includes("discover-feature"), "Discover semantics page");
  assert.match(environment.main.innerHTML, /<h2>Moana<\/h2>/u, "a matched canonical title must replace a synthetic Movie <id> hero title");
  assert.doesNotMatch(environment.main.innerHTML, /Movie 1108427/u);
  assert.match(environment.main.innerHTML, /The Runner[\s\S]*?Not requested/u, "unrequested discovery results need an explicit request state");
  assert.doesNotMatch(environment.main.innerHTML, />Unknown</u, "Discover must not expose an internal unknown lifecycle");
  assert.doesNotMatch(environment.main.innerHTML, /Moana[\s\S]{0,160}Available/u, "a requested title without Jellyfin proof must not be called available");

  environment.location.hash = "#/requests";
  await environment.dispatchWindow("hashchange", { type: "hashchange" });
  assert.equal((environment.main.innerHTML.match(/<article class="request-row\b/gu) || []).length, 10, "separate movie and season requests must retain distinct request identities");
  const requestRows = [...environment.main.innerHTML.matchAll(/<article class="request-row[\s\S]*?<\/article>/gu)].map((match) => match[0]);
  const requestRow = (title) => requestRows.find((row) => row.includes(`<strong>${title}</strong>`)) || "";
  assert.match(environment.main.innerHTML, /Moana[\s\S]{0,1400}status-pill status-available[^>]*>[\s\S]*?Available/u, "a fulfilled Seerr request must render as available");
  assert.doesNotMatch(environment.main.innerHTML, /Awaiting Jellyfin/u, "Seerr's available status must never be inverted into Awaiting Jellyfin");
  assert.equal((requestRow("Moana").match(/journey-step is-done/gu) || []).length, 5, "the fulfilled request must complete all five lifecycle steps");
  assert.match(environment.main.innerHTML, /Request state[\s\S]*?Request approved/u);
  assert.match(environment.main.innerHTML, /Season 2/u);
  assert.match(environment.main.innerHTML, /Season 3/u);
  assert.match(environment.main.innerHTML, /status-pill status-partial[^>]*>[\s\S]*?Awaiting acquisition/u, "approved acquisition work must not use the approval-pending color or filter state");
  for (const row of requestRows.filter((candidate) => candidate.includes("<strong>VisionQuest</strong>"))) {
    assert.doesNotMatch(row, /status-pill status-available/u, "record-wide series availability must not fulfill either newer season request");
  }
  assert.match(requestRow("VisionQuest"), /data-media-state="in_progress"/u, "an approved request belongs to In progress, not Awaiting approval");
  assert.match(requestRow("VisionQuest"), /Awaiting acquisition/u, "a season request without season availability evidence must use a conservative acquisition label");
  assert.doesNotMatch(requestRow("VisionQuest"), /Processing|Partially acquired/u, "a season request must not inherit title-wide processing or partial state");
  const pendingRow = requestRows.find((row) => /Season 3/u.test(row)) || "";
  assert.match(pendingRow, /data-media-state="pending"[\s\S]*?Awaiting approval/u, "only a Seerr pending request belongs to Awaiting approval");
  assert.doesNotMatch(pendingRow, /Partially acquired/u, "approval-pending season requests must not inherit title-wide partial state");
  assert.match(requestRow("Processing Signal"), /data-media-state="in_progress"[\s\S]*?Processing/u);
  assert.match(requestRow("Partial Signal"), /data-media-state="in_progress"[\s\S]*?Partially acquired/u);
  assert.match(requestRow("Removed Signal"), /data-media-state="closed"[\s\S]*?Removed/u);
  assert.match(requestRow("Blocked Signal"), /data-media-state="closed"[\s\S]*?Blocklisted in Seerr/u);
  assert.match(requestRow("Failed Signal"), /data-media-state="attention"[\s\S]*?Needs attention/u);
  assert.match(requestRow("Recovered Signal"), /data-media-state="available"[\s\S]*?Available/u, "confirmed availability supersedes a historical failed request state");
  assert.match(requestRow("Available With Error"), /data-media-state="attention"[\s\S]*?Needs attention/u, "a concrete current error supersedes availability in both filtering and labeling");
  for (const row of requestRows.filter((candidate) => candidate.includes('data-media-state="pending"'))) {
    assert.doesNotMatch(
      row,
      /Processing|Partially acquired|Removed|Blocklisted in Seerr|Needs attention/u,
      "non-pending workflow and history states must never leak into the Awaiting approval bucket"
    );
  }
  const filterRows = requestRows.map((row, index) => {
    const element = new FakeElement({ id: `request-filter-row-${index}` });
    element.dataset.mediaState = /data-media-state="([^"]+)"/u.exec(row)?.[1] || "";
    element.dataset.mediaTitle = row.toLowerCase();
    return element;
  });
  const requestCount = new FakeElement({ id: "request-filter-count" });
  const expectedFilterCounts = { all: 10, pending: 1, in_progress: 3, available: 2, attention: 2, closed: 2 };
  const requestFilters = Object.keys(expectedFilterCounts).map((value) => {
    const filter = new FakeElement({ id: `request-filter-${value}` });
    filter.dataset.action = "media-filter";
    filter.dataset.mediaFilterName = "requests";
    filter.dataset.mediaFilterValue = value;
    filter.closest = (selector) => selector === "[data-action]" ? filter : null;
    return filter;
  });
  environment.main.registerSelector("[data-media-filter-item]", ...filterRows);
  environment.main.registerSelector("[data-media-result-count]", requestCount);
  environment.main.registerSelector("[data-media-filter-name='requests']", ...requestFilters);
  for (const filter of requestFilters) {
    await environment.dispatchDocument("click", { target: filter });
    const expected = expectedFilterCounts[filter.dataset.mediaFilterValue];
    assert.equal(filterRows.filter((row) => !row.hidden).length, expected, `${filter.dataset.mediaFilterValue} request filter count`);
    assert.equal(requestCount.textContent, `${expected} ${expected === 1 ? "request" : "requests"}`);
    assert.equal(filter.classList.contains("is-active"), true);
    assert.equal(filter.attributes.get("aria-pressed"), "true");
    for (const other of requestFilters.filter((candidate) => candidate !== filter)) {
      assert.equal(other.classList.contains("is-active"), false);
      assert.equal(other.attributes.get("aria-pressed"), "false");
    }
  }
  const pendingFilter = requestFilters.find(({ dataset }) => dataset.mediaFilterValue === "pending");
  await environment.dispatchDocument("click", { target: pendingFilter });
  assert.equal(filterRows.find((row) => !row.hidden)?.dataset.mediaState, "pending", "Awaiting approval exposes only the true Seerr pending request");

  const drawer = environment.elements.get("#drawer-layer");
  const openRequest = async (requestId) => {
    const opener = new FakeElement({ id: `open-request-${requestId}` });
    opener.dataset.action = "open-media-detail";
    opener.dataset.mediaId = `request:${requestId}`;
    opener.closest = (selector) => selector === "[data-action]" ? opener : null;
    await environment.dispatchDocument("click", { target: opener });
    return drawer.innerHTML;
  };
  const processingDrawer = await openRequest(103);
  assert.match(processingDrawer, /<li class="is-done">[\s\S]*?<strong>Requested<\/strong>/u);
  assert.match(processingDrawer, /<li class="is-current">[\s\S]*?<strong>Monitored<\/strong><small>Processing<\/small>/u, "request details must retain the processing journey stage");
  const partialDrawer = await openRequest(104);
  assert.match(partialDrawer, /<li class="is-current">[\s\S]*?<strong>Imported<\/strong><small>Partially acquired<\/small>/u, "partial acquisition must not jump back to Requested in details");
  const scopedDrawer = await openRequest(101);
  assert.match(scopedDrawer, /<li class="is-current">[\s\S]*?<strong>Requested<\/strong><small>Awaiting acquisition<\/small>/u, "title-wide processing must not advance a season-scoped request journey");
  const failedDrawer = await openRequest(106);
  assert.match(failedDrawer, /<li class="has-issue">[\s\S]*?<strong>Requested<\/strong><small>Needs attention<\/small>/u, "a failed request needs an issue marker even without a free-text error");
  const drawerCloser = new FakeElement({ id: "close-request-drawer" });
  drawerCloser.dataset.action = "close-media-drawer";
  drawerCloser.closest = (selector) => selector === "[data-action]" ? drawerCloser : null;
  await environment.dispatchDocument("click", { target: drawerCloser });

  environment.location.hash = "#/calendar";
  await environment.dispatchWindow("hashchange", { type: "hashchange" });
  assert.doesNotMatch(environment.main.innerHTML, /<strong>Lights Out<\/strong><small>Lights Out<\/small>/u, "calendar cards must not repeat a title as their kind");
  assert.match(environment.main.innerHTML, /<strong>Lights Out<\/strong><small>S01E01<\/small><em>Upcoming<\/em>/u);
  assert.match(environment.main.innerHTML, /<strong>400<\/strong><small>Movie<\/small><em>Upcoming<\/em>/u);
  assert.doesNotMatch(environment.main.innerHTML, />Unknown</u, "monitored calendar entries should be called upcoming, not unknown");

  environment.location.hash = "#/home";
  await environment.dispatchWindow("hashchange", { type: "hashchange" });
  assert.match(environment.main.innerHTML, /Future Signal[\s\S]{0,180}2027 · Upcoming/u);
  assert.doesNotMatch(environment.main.innerHTML, /Future Signal[\s\S]{0,180}(?:Unknown|Available)/u);
  assert.match(
    environment.main.innerHTML,
    /<img class="media-art-image"[^>]+src="\/api\/v2\/media\/artwork\/0123456789abcdef0123456789abcdef"/u,
    "a future Radarr title with trusted artwork must render an image instead of a letter-only placeholder"
  );
  assert.match(environment.main.innerHTML, /data-action="open-request-filter" data-media-filter-value="pending"[\s\S]*?Awaiting approval/u);
  const pendingSummary = new FakeElement({ id: "pending-request-summary" });
  pendingSummary.dataset.action = "open-request-filter";
  pendingSummary.dataset.mediaFilterValue = "pending";
  pendingSummary.closest = (selector) => selector === "[data-action]" ? pendingSummary : null;
  await environment.dispatchDocument("click", { target: pendingSummary });
  environment.location.hash = "#/requests";
  await environment.dispatchWindow("hashchange", { type: "hashchange" });
  assert.match(
    environment.main.innerHTML,
    /class="filter-chip is-active"[^>]+data-media-filter-name="requests" data-media-filter-value="pending"[^>]+aria-pressed="true">Awaiting approval/u,
    "the Home approval summary must open Requests with the exact pending filter selected"
  );
}

async function serviceDialogInteractionContract() {
  const csrfToken = "service-dialog-csrf-token";
  const config = {
    policy: { allowedCidrs: ["192.168.0.7/32"], allowPublicHttps: false },
    services: [{
      id: "jellyfin",
      name: "Jellyfin",
      role: "Library and playback",
      url: "http://192.168.0.7:8096",
      configured: true,
      authMode: "token",
      credentialConfigured: true,
      credentialLabel: "API key or access token",
      credentialHint: "Use a dedicated token.",
      authOptions: [
        {
          id: "token",
          label: "API key or access token",
          input: "secret",
          credentialLabel: "API key or access token",
          hint: "Use a Jellyfin Dashboard API key or an existing user access token."
        },
        {
          id: "login",
          label: "Username + password",
          input: "login",
          identityLabel: "Jellyfin username",
          hint: "Helmsman exchanges the login once for an access token, then discards the password."
        }
      ],
      monitoringEnabled: true
    }]
  };
  const snapshot = {
    version: 1,
    generatedAt: "2026-09-12T21:09:14.000Z",
    overall: {
      state: "healthy",
      headline: "Everything is working",
      summary: "All configured checks are healthy.",
      serviceCount: 1,
      affectedServiceCount: 0,
      openIncidentCount: 0
    },
    services: [{
      id: "jellyfin",
      label: "Jellyfin",
      state: "healthy",
      connectionState: "connected",
      latencyMs: 42,
      checkedAt: "2026-09-12T21:09:14.000Z",
      checks: [{ id: "system", state: "healthy", checkedAt: "2026-09-12T21:09:14.000Z" }]
    }],
    pipeline: { state: "healthy", stages: [] },
    incidents: { open: [], recent: [] },
    workload: {},
    events: []
  };
  let draftTestResult = {
    service: "jellyfin",
    state: "healthy",
    checkedAt: "2026-09-12T21:09:15.000Z",
    version: "10.11.8",
    checks: [{ id: "identity", label: "Token authorization", state: "healthy", status: 200, latencyMs: 13 }]
  };

  const environment = installFakeBrowser(({ path, options }) => {
    if (path === "/api/v2/status") {
      return jsonResponse({
        setupRequired: false,
        authenticated: true,
        csrfToken,
        session: { name: "Interaction Browser" },
        storage: { credentialsEncrypted: true, externalKey: false }
      });
    }
    if (path === "/api/v2/config" && String(options.method || "GET") === "GET") return jsonResponse(clone(config));
    if (path === "/api/v2/operations/snapshot") return jsonResponse(clone(snapshot));
    if (path === "/api/v2/operations/refresh") return jsonResponse(clone(snapshot));
    if (path === "/api/v2/services/jellyfin/test" && String(options.method || "GET") === "POST") {
      return jsonResponse(clone(draftTestResult));
    }
    if (path === "/api/v2/services/jellyfin" && options.method === "PUT") {
      return jsonResponse(clone(config.services[0]));
    }
    if (path === "/api/v2/sessions") return jsonResponse({ currentSessionId: "", sessions: [] });
    return jsonResponse({ code: "NOT_FOUND", message: "Unexpected test route." }, 404);
  }, "service-dialog-interactions");

  environment.location.hash = "#/services";
  await importShell(environment);
  await waitFor(() => environment.main.innerHTML.includes("service-grid-v5"), "Services route");

  const modal = environment.elements.get("#modal-layer");
  assert.equal(modal.innerHTML, "", "the closed modal layer must not retain a hidden credential form");
  assert.doesNotMatch(
    `${environment.main.innerHTML}${modal.innerHTML}`,
    /name="credential"|type="password"/u,
    "an authenticated Services page must not expose an offscreen password-manager target"
  );

  const serviceForm = new FakeElement({ id: "service-form" });
  serviceForm.dataset.serviceId = "jellyfin";
  serviceForm.dataset.originalUrl = config.services[0].url;
  serviceForm.dataset.originalAuthMode = "token";
  serviceForm.dataset.authMode = "token";
  serviceForm.dataset.credentialConfigured = "true";
  const urlInput = new FakeElement({ id: "service-url" });
  urlInput.name = "url";
  urlInput.value = config.services[0].url;
  const credentialInput = new FakeElement({ id: "service-credential" });
  credentialInput.name = "credential";
  credentialInput.dataset.newPlaceholder = "Enter credential";
  credentialInput.dataset.savedPlaceholder = "Blank keeps the saved credential";
  const usernameInput = new FakeElement({ id: "service-username" });
  usernameInput.name = "username";
  usernameInput.dataset.newPlaceholder = "Enter Jellyfin username";
  usernameInput.dataset.savedPlaceholder = "Blank keeps the saved sign-in";
  const passwordInput = new FakeElement({ id: "service-password" });
  passwordInput.name = "password";
  passwordInput.dataset.newPlaceholder = "Enter account password";
  passwordInput.dataset.savedPlaceholder = "Blank keeps the saved sign-in";
  const tokenRadio = new FakeElement({ id: "service-token-radio" });
  tokenRadio.name = "authMode";
  tokenRadio.value = "token";
  tokenRadio.checked = true;
  const loginRadio = new FakeElement({ id: "service-login-radio" });
  loginRadio.name = "authMode";
  loginRadio.value = "login";
  const tokenPanel = new FakeElement({ id: "service-token-panel" });
  tokenPanel.dataset.authMode = "token";
  tokenPanel.dataset.authInput = "secret";
  tokenPanel.registerSelector("input", credentialInput);
  tokenPanel.registerSelector("input[name='credential']", credentialInput);
  const loginPanel = new FakeElement({ id: "service-login-panel" });
  loginPanel.dataset.authMode = "login";
  loginPanel.dataset.authInput = "login";
  loginPanel.hidden = true;
  loginPanel.registerSelector("input", usernameInput, passwordInput);
  loginPanel.registerSelector("input[name='username']", usernameInput);
  loginPanel.registerSelector("input[name='password']", passwordInput);
  const retentionNote = new FakeElement();
  const monitorCheckbox = new FakeElement({ id: "service-monitoring-enabled" });
  monitorCheckbox.checked = true;
  const health = new FakeElement();
  const healthDot = new FakeElement();
  const healthLabel = new FakeElement();
  const healthLatency = new FakeElement();
  const healthCheckedAt = new FakeElement();
  const monitorReports = new FakeElement();
  const testResult = new FakeElement({ id: "service-test-result" });
  testResult.hidden = true;
  const testResultDot = new FakeElement();
  const testResultTitle = new FakeElement();
  const testResultDetail = new FakeElement();
  const testResultCapabilities = new FakeElement();
  const testResultNote = new FakeElement();
  testResult.registerSelector(".health-dot", testResultDot);
  testResult.registerSelector("[data-test-title]", testResultTitle);
  testResult.registerSelector("[data-test-detail]", testResultDetail);
  testResult.registerSelector("[data-test-capabilities]", testResultCapabilities);
  testResult.registerSelector("[data-test-note]", testResultNote);
  health.registerSelector("[data-monitor-dot]", healthDot);
  health.registerSelector("[data-monitor-state]", healthLabel);
  health.registerSelector("[data-monitor-latency]", healthLatency);
  health.registerSelector("[data-monitor-checked]", healthCheckedAt);
  serviceForm.registerSelector("#service-error", new FakeElement({ id: "service-error" }));
  serviceForm.registerSelector("#service-test-result", testResult);
  serviceForm.registerSelector("input[name='url']", urlInput);
  serviceForm.registerSelector("input[name='authMode']:checked", tokenRadio);
  serviceForm.registerSelector("input[name='authMode']", tokenRadio, loginRadio);
  serviceForm.registerSelector("[data-auth-panel]", tokenPanel, loginPanel);
  serviceForm.registerSelector("[data-auth-retention]", retentionNote);
  serviceForm.formDataValues = new Map([
    ["url", urlInput.value],
    ["authMode", "token"],
    ["credential", ""]
  ]);
  modal.registerSelector("#service-form", serviceForm);
  modal.registerSelector("input[name='url']", urlInput);
  modal.registerSelector(".service-health-inline", health);
  modal.registerSelector("[data-monitor-reports]", monitorReports);

  const opener = {
    dataset: { action: "open-service", serviceId: "jellyfin" },
    closest(selector) {
      return selector === "[data-action]" || selector === "[data-action], [data-service-id]" ? this : null;
    }
  };
  await environment.dispatchDocument("click", { target: opener });
  await waitFor(() => modal.innerHTML.includes('id="service-form"'), "service dialog");
  assert.match(modal.innerHTML, /Saved monitor/u, "the persisted monitor result must be labeled separately");
  assert.doesNotMatch(modal.innerHTML, /Not yet/u, "a monitor checkedAt timestamp must render on initial open");
  assert.match(modal.innerHTML, /Current connection test/u, "the draft test result must have its own label");
  assert.equal(environment.document.activeElement, urlInput, "opening a service should focus its URL once");
  assert.match(modal.innerHTML, /<form[^>]+id="service-form"[^>]+autocomplete="off"[^>]+data-form-type="other"/u);
  assert.match(modal.innerHTML, /<legend>Authentication method<\/legend>/u);
  assert.match(modal.innerHTML, /name="authMode" type="radio" value="token"[^>]*checked/u);
  assert.match(modal.innerHTML, /name="authMode" type="radio" value="login"/u);
  assert.match(modal.innerHTML, /Jellyfin username/u);
  assert.match(modal.innerHTML, /One-time sign-in exchange/u);
  assert.match(modal.innerHTML, /password is discarded immediately/u);
  assert.match(modal.innerHTML, /name="username" type="text" autocomplete="username"[^>]*disabled/u);
  assert.match(modal.innerHTML, /name="password" type="password" autocomplete="current-password"[^>]*disabled/u);
  assert.doesNotMatch(modal.innerHTML, /name="clearCredential"/u, "configured Jellyfin must not offer an invalid credential-clear action");
  assert.match(modal.innerHTML, /name="credential" type="password" autocomplete="off"/u);
  assert.match(modal.innerHTML, /data-1p-ignore="true"/u);
  assert.match(modal.innerHTML, /data-bwignore="true"/u);
  assert.match(modal.innerHTML, /data-lpignore="true"/u);
  assert.match(modal.innerHTML, /data-protonpass-ignore="true"/u);
  assert.match(
    modal.innerHTML,
    /<button class="button" type="button" data-action="test-service">Test connection<\/button>/u,
    "every service dialog must expose a visible, non-submit connection test"
  );

  const writesAfterOpen = modal.markupWrites;
  credentialInput.value = "unsaved-secret-must-survive";
  credentialInput.focus();
  credentialInput.closest = (selector) => selector === "[data-action], [data-service-id]" ? serviceForm : null;
  await environment.dispatchDocument("click", { target: credentialInput });
  assert.equal(modal.markupWrites, writesAfterOpen, "clicking a text field must not rebuild the service dialog");
  assert.equal(environment.document.activeElement, credentialInput, "clicking the credential field must not return focus to the URL");
  assert.equal(credentialInput.value, "unsaved-secret-must-survive");

  monitorCheckbox.checked = false;
  monitorCheckbox.focus();
  monitorCheckbox.closest = (selector) => selector === "[data-action], [data-service-id]" ? serviceForm : null;
  await environment.dispatchDocument("click", { target: monitorCheckbox });
  assert.equal(modal.markupWrites, writesAfterOpen, "clicking the monitoring checkbox must not rebuild the service dialog");
  assert.equal(monitorCheckbox.checked, false, "the user's checkbox choice must survive delegated click handling");

  urlInput.closest = (selector) => selector === "#service-form" ? serviceForm : null;
  urlInput.value = "http://192.168.0.8:8096";
  serviceForm.formDataValues.set("url", urlInput.value);
  await environment.dispatchDocument("input", { target: urlInput });
  assert.equal(credentialInput.required, true, "changing the URL must require a fresh credential");
  assert.match(retentionNote.textContent, /URL or authentication method changed/u);
  assert.equal(modal.markupWrites, writesAfterOpen, "editing a service URL must update requirements in place");
  urlInput.value = config.services[0].url;
  serviceForm.formDataValues.set("url", urlInput.value);
  await environment.dispatchDocument("input", { target: urlInput });
  assert.equal(credentialInput.required, false, "the saved credential may be retained after restoring the original URL");

  serviceForm.formDataValues.set("credential", credentialInput.value);
  const testButton = new FakeElement({ id: "test-service-button" });
  testButton.dataset.action = "test-service";
  testButton.closest = (selector) => {
    if (selector === "[data-action]") return testButton;
    if (selector === "#service-form") return serviceForm;
    return null;
  };
  await environment.dispatchDocument("click", { target: testButton });
  await waitFor(
    () => environment.requestLog.some(({ path }) => path === "/api/v2/services/jellyfin/test"),
    "draft connection test request"
  );
  await waitFor(() => testResultTitle.textContent === "Connection and credential verified", "successful test result");
  const connectionTestCall = environment.requestLog.find(({ path }) => path === "/api/v2/services/jellyfin/test");
  assert.equal(connectionTestCall.options.method, "POST");
  assert.equal(connectionTestCall.options.credentials, "same-origin");
  assert.equal(connectionTestCall.options.headers.get("X-Jellofin-CSRF"), csrfToken);
  assert.deepEqual(JSON.parse(connectionTestCall.options.body), {
    url: config.services[0].url,
    authMode: "token",
    credential: "unsaved-secret-must-survive"
  });
  assert.equal(testResult.hidden, false);
  assert.equal(testResult.dataset.state, "healthy");
  assert.equal(testResultDetail.textContent, "The read-only capability check passed.");
  assert.match(testResultCapabilities.innerHTML, /Token authorization/u);
  assert.match(testResultCapabilities.innerHTML, /Healthy/u);
  assert.match(testResultNote.textContent, /nothing was saved/u);
  assert.equal(testButton.disabled, false);
  assert.equal(testButton.attributes.has("aria-busy"), false);
  assert.equal(modal.markupWrites, writesAfterOpen, "testing must not rebuild or close the service dialog");
  assert.equal(modal.classList.contains("is-open"), true);
  assert.equal(
    environment.requestLog.some(({ path, options }) => path === "/api/v2/services/jellyfin" && options.method === "PUT"),
    false,
    "testing a draft connection must not save it"
  );

  tokenRadio.checked = false;
  loginRadio.checked = true;
  serviceForm.registerSelector("input[name='authMode']:checked", loginRadio);
  serviceForm.formDataValues.set("authMode", "login");
  serviceForm.formDataValues.set("credential", "");
  serviceForm.formDataValues.set("username", "media-admin");
  serviceForm.formDataValues.set("password", "one-time-password");
  usernameInput.value = "media-admin";
  passwordInput.value = "one-time-password";
  loginRadio.closest = (selector) => selector === "#service-form" ? serviceForm : null;
  await environment.dispatchDocument("change", { target: loginRadio });
  assert.equal(tokenPanel.hidden, true);
  assert.equal(credentialInput.disabled, true);
  assert.equal(credentialInput.required, false);
  assert.equal(loginPanel.hidden, false);
  assert.equal(usernameInput.disabled, false);
  assert.equal(passwordInput.disabled, false);
  assert.equal(usernameInput.required, true);
  assert.equal(passwordInput.required, true);
  assert.equal(testResult.hidden, true, "changing authentication must invalidate the previous test result");
  assert.equal(testResultTitle.textContent, "", "a result for old credentials must not remain visible");
  assert.equal(modal.markupWrites, writesAfterOpen, "switching authentication modes must not rebuild the dialog");

  const requestsBeforeLoginTest = environment.requestLog.filter(
    ({ path }) => path === "/api/v2/services/jellyfin/test"
  ).length;
  await environment.dispatchDocument("click", { target: testButton });
  await waitFor(
    () => environment.requestLog.filter(({ path }) => path === "/api/v2/services/jellyfin/test").length === requestsBeforeLoginTest + 1,
    "one-time Jellyfin login test"
  );
  const loginTestCall = environment.requestLog.filter(
    ({ path }) => path === "/api/v2/services/jellyfin/test"
  ).at(-1);
  assert.deepEqual(JSON.parse(loginTestCall.options.body), {
    url: config.services[0].url,
    authMode: "login",
    login: { username: "media-admin", password: "one-time-password" }
  });

  loginRadio.checked = false;
  tokenRadio.checked = true;
  serviceForm.registerSelector("input[name='authMode']:checked", tokenRadio);
  serviceForm.formDataValues.set("authMode", "token");
  serviceForm.formDataValues.set("credential", credentialInput.value);
  tokenRadio.closest = loginRadio.closest;
  await environment.dispatchDocument("change", { target: tokenRadio });
  assert.equal(tokenPanel.hidden, false);
  assert.equal(credentialInput.disabled, false);
  assert.equal(credentialInput.required, false);
  assert.equal(loginPanel.hidden, true);
  assert.equal(usernameInput.disabled, true);
  assert.equal(passwordInput.disabled, true);
  assert.equal(credentialInput.value, "unsaved-secret-must-survive", "mode switches must preserve unsaved direct credentials");

  draftTestResult = {
    service: "jellyfin",
    connectionState: "connected",
    state: "limited",
    checkedAt: "2026-09-12T21:09:16.000Z",
    checks: [
      { id: "identity", label: "Token authorization", state: "healthy", status: 200, latencyMs: 11 },
      {
        id: "status",
        label: '<img src=x onerror="credential-leak">',
        state: "limited",
        status: 200,
        code: "INVALID_RESPONSE",
        latencyMs: 17,
        metrics: { arbitrary: "credential-leak" },
        reports: Array.from({ length: 14 }, (_value, index) => ({
          severity: index === 0 ? "error" : "warning",
          source: index === 0 ? '<img src=x onerror="test-report-xss">' : `JellyfinCheck${index + 1}`,
          message: index === 0 ? "Unsafe <script>test-report-xss</script>" : `Test report ${index + 1}`
        }))
      }
    ]
  };
  await environment.dispatchDocument("click", { target: testButton });
  await waitFor(() => testResultDetail.textContent.includes("Server status needs attention"), "limited capability detail");
  assert.equal(testResult.dataset.state, "limited");
  assert.match(testResultDetail.textContent, /accepted the credential/u, "operational warnings must not obscure connection success");
  assert.match(testResultCapabilities.innerHTML, /Server status/u, "limited checks must use a safe capability label");
  assert.match(testResultCapabilities.innerHTML, /Unexpected response format/u);
  assert.doesNotMatch(testResultCapabilities.innerHTML, /credential-leak|<img/iu, "raw labels and metrics must not render");
  assert.match(testResultCapabilities.innerHTML, /Reported by Jellyfin/u, "connection tests must show the reporting service");
  assert.match(testResultCapabilities.innerHTML, /Unsafe &lt;script&gt;test-report-xss&lt;\/script&gt;/u);
  assert.doesNotMatch(testResultCapabilities.innerHTML, /<script>test-report-xss<\/script>|<img src=x onerror="test-report-xss">/u);
  assert.equal(
    (testResultCapabilities.innerHTML.match(/class="operations-report is-/gu) || []).length,
    12,
    "connection-test reports must remain bounded"
  );

  draftTestResult = {
    service: "jellyfin",
    connectionState: "unverified",
    state: "degraded",
    checkedAt: "2026-09-12T21:09:17.000Z",
    checks: [
      { id: "status", state: "healthy", status: 200, latencyMs: 9 },
      { id: "identity", state: "degraded", status: 200, code: "INVALID_RESPONSE", latencyMs: 12 }
    ]
  };
  await environment.dispatchDocument("click", { target: testButton });
  await waitFor(() => testResultTitle.textContent === "Service reached; credential not verified", "explicit unverified connection result");
  assert.equal(testResult.dataset.state, "degraded");

  credentialInput.focus();
  snapshot.generatedAt = "2026-09-12T21:10:44.000Z";
  snapshot.overall.state = "limited";
  snapshot.overall.headline = "A check needs attention";
  snapshot.overall.affectedServiceCount = 1;
  snapshot.overall.openIncidentCount = 1;
  snapshot.services[0].state = "limited";
  snapshot.services[0].checkedAt = snapshot.generatedAt;
  snapshot.services[0].checks = [{
    id: "system",
    state: "limited",
    code: "HTTP_ERROR",
    checkedAt: snapshot.generatedAt,
    reports: [{
      severity: "warning",
      source: "SystemCheck",
      message: 'Jellyfin reports <img src=x onerror="saved-report-xss">'
    }]
  }];
  snapshot.incidents.open = [{
    service: "jellyfin",
    capability: "system",
    state: "limited",
    code: "HTTP_ERROR",
    summary: "Jellyfin check is limited",
    lastSeen: snapshot.generatedAt,
    occurrenceCount: 2
  }];
  assert.ok(environment.intervalCallbacks.length, "the runtime must schedule its monitor poll");
  await environment.intervalCallbacks.at(-1)();
  await waitFor(
    () => environment.requestLog.filter(({ path }) => path === "/api/v2/operations/snapshot").length >= 2,
    "service-dialog background snapshot"
  );
  assert.equal(modal.markupWrites, writesAfterOpen, "a structural monitor refresh must not rebuild an open service dialog");
  assert.equal(healthLabel.textContent, "Connected · Limited health", "the saved monitor state must distinguish connection from operational health");
  assert.equal(healthDot.className, "health-dot is-limited", "a connected service must retain its separate operational warning tone");
  assert.equal(healthCheckedAt.attributes.get("datetime"), snapshot.generatedAt, "the saved monitor timestamp must use checkedAt");
  assert.notEqual(healthCheckedAt.textContent, "Not yet");
  assert.equal(monitorReports.hidden, false, "new saved-monitor reports must become visible without rebuilding the dialog");
  assert.match(monitorReports.innerHTML, /Reported by Jellyfin/u);
  assert.match(monitorReports.innerHTML, /Jellyfin reports &lt;img src=x onerror=&quot;saved-report-xss&quot;&gt;/u);
  assert.doesNotMatch(monitorReports.innerHTML, /<img src=x onerror="saved-report-xss">/u);
  assert.equal(environment.document.activeElement, credentialInput, "a monitor refresh must not steal focus from an open service field");
  assert.equal(credentialInput.value, "unsaved-secret-must-survive", "a monitor refresh must preserve unsaved credential text");
  assert.equal(monitorCheckbox.checked, false, "a monitor refresh must preserve the unsaved checkbox state");

  const snapshotRequestsBeforeAuthFailure = environment.requestLog.filter(
    ({ path }) => path === "/api/v2/operations/snapshot"
  ).length;
  snapshot.services[0].connectionState = "auth_required";
  snapshot.services[0].state = "down";
  snapshot.services[0].checks = [{
    id: "identity",
    state: "auth_required",
    code: "AUTH_REQUIRED",
    httpStatus: 401,
    checkedAt: snapshot.generatedAt
  }];
  await environment.intervalCallbacks.at(-1)();
  await waitFor(
    () => environment.requestLog.filter(({ path }) => path === "/api/v2/operations/snapshot").length === snapshotRequestsBeforeAuthFailure + 1,
    "service-dialog authentication failure refresh"
  );
  assert.equal(healthLabel.textContent, "Authentication required");
  assert.equal(healthDot.className, "health-dot is-auth-required");
  assert.equal(modal.markupWrites, writesAfterOpen, "authentication-state refreshes must not rebuild the dialog");

  tokenRadio.checked = false;
  loginRadio.checked = true;
  serviceForm.registerSelector("input[name='authMode']:checked", loginRadio);
  serviceForm.formDataValues = new Map([
    ["url", config.services[0].url],
    ["authMode", "login"],
    ["username", "save-user"],
    ["password", "save-password"],
    ["monitoringEnabled", "on"]
  ]);
  usernameInput.value = "save-user";
  passwordInput.value = "save-password";
  await environment.dispatchDocument("change", { target: loginRadio });
  await environment.dispatchDocument("submit", { target: serviceForm, preventDefault() {} });
  await waitFor(
    () => environment.requestLog.some(({ path, options }) => path === "/api/v2/services/jellyfin" && options.method === "PUT"),
    "one-time Jellyfin login save"
  );
  const loginSaveCall = environment.requestLog.find(
    ({ path, options }) => path === "/api/v2/services/jellyfin" && options.method === "PUT"
  );
  assert.deepEqual(JSON.parse(loginSaveCall.options.body), {
    url: config.services[0].url,
    authMode: "login",
    login: { username: "save-user", password: "save-password" },
    monitoringEnabled: true
  });
  await waitFor(() => modal.innerHTML === "", "service dialog to close after save");

  const closer = {
    dataset: { action: "close-modal" },
    closest(selector) {
      return selector === "[data-action]" || selector === "[data-action], [data-service-id]" ? this : null;
    }
  };
  await environment.dispatchDocument("click", { target: closer });
  assert.equal(modal.innerHTML, "", "closing the dialog must remove credential inputs from the DOM");
  assert.equal(modal.attributes.get("aria-hidden"), "true");
  assert.equal(modal.classList.contains("is-open"), false);
  assert.doesNotMatch(`${environment.main.innerHTML}${modal.innerHTML}`, /name="credential"|type="password"/u);
}

async function infrastructureWorkspaceContract() {
  const csrfToken = "infrastructure-csrf-token";
  const targetId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const fingerprint = "ab".repeat(32);
  const targetUrl = "https://192.168.0.4:8006";
  const tokenIdValue = "helmsman@pve!monitoring";
  const tokenSecretValue = "proxmox-token-secret";
  let targets = [];
  const snapshot = {
    version: 1,
    generatedAt: "2026-09-13T01:00:00.000Z",
    overall: { state: "healthy", headline: "Media is healthy", summary: "All media checks passed." },
    services: [],
    pipeline: { state: "healthy", stages: [] },
    incidents: { open: [], recent: [] },
    workload: {},
    events: [],
    infrastructure: {
      generatedAt: "2026-09-13T01:00:00.000Z",
      overall: { state: "disabled", headline: "No targets", summary: "Add Proxmox to begin." },
      targets: []
    }
  };
  const healthyTest = {
    service: "proxmox",
    connectionState: "connected",
    state: "healthy",
    checkedAt: "2026-09-13T01:00:05.000Z",
    version: "8.4.1",
    discovery: {
      kind: "standalone",
      name: "pve-main",
      clusterName: null,
      quorate: null,
      nodeNames: ["pve-main"]
    },
    checks: [
      { id: "reachability", state: "healthy", status: 200, latencyMs: 7 },
      { id: "tls", state: "healthy", status: 200, latencyMs: 8 },
      { id: "identity", state: "healthy", status: 200, latencyMs: 9 },
      { id: "nodes", state: "healthy", status: 200, latencyMs: 10 }
    ]
  };

  const environment = installFakeBrowser(({ path, options }) => {
    const method = String(options.method || "GET").toUpperCase();
    if (path === "/api/v2/status") {
      return jsonResponse({
        setupRequired: false,
        authenticated: true,
        csrfToken,
        session: { name: "Infrastructure Browser" },
        storage: { credentialsEncrypted: true, externalKey: false }
      });
    }
    if (path === "/api/v2/config" && method === "GET") {
      return jsonResponse({
        policy: { allowedCidrs: [], allowPublicHttps: false },
        services: [],
        infrastructureEnvironments: clone(targets),
        infrastructureTargets: clone(targets)
      });
    }
    if (path === "/api/v2/sessions" && method === "GET") {
      return jsonResponse({ currentSessionId: "", sessions: [] });
    }
    if (path === "/api/v2/operations/snapshot" && method === "GET") return jsonResponse(clone(snapshot));
    if (path === "/api/v2/infrastructure/environments" && method === "GET") return jsonResponse({ environments: clone(targets) });
    if (path === "/api/v2/infrastructure/environments/test" && method === "POST") return jsonResponse(clone(healthyTest));
    if (path === `/api/v2/infrastructure/environments/${targetId}/test` && method === "POST") return jsonResponse(clone(healthyTest));
    if (path === "/api/v2/infrastructure/environments" && method === "POST") {
      targets = [{
        id: targetId,
        type: "proxmox",
        typeName: "Proxmox VE",
        role: "Virtualization",
        displayName: "Main Proxmox",
        url: targetUrl,
        enabled: true,
        monitoringEnabled: true,
        monitoringIntervalSeconds: 60,
        tlsMode: "pinned",
        certificateFingerprint: fingerprint,
        credentialConfigured: true,
        targetRevision: "revision-1",
        environmentKind: "standalone",
        environmentName: "pve-main"
      }];
      snapshot.infrastructure = {
        generatedAt: "2026-09-13T01:00:10.000Z",
        overall: { state: "healthy", headline: "Infrastructure is healthy", summary: "The Proxmox target is healthy." },
        targets: [{
          id: targetId,
          type: "proxmox",
          displayName: "Main Proxmox",
          state: "healthy",
          connectionState: "connected",
          version: "8.4.1",
          latencyMs: 10,
          checkedAt: "2026-09-13T01:00:10.000Z",
          discovery: clone(healthyTest.discovery),
          endpoints: [{
            id: targetId,
            label: "Primary endpoint",
            state: "healthy",
            connectionState: "connected",
            selected: true,
            checkedAt: "2026-09-13T01:00:10.000Z"
          }],
          nodes: [{
            name: "pve-main",
            status: "online",
            local: true,
            cpuPercent: 14,
            cpuCores: 8,
            memoryUsedBytes: 4_000,
            memoryTotalBytes: 8_000,
            rootDiskUsedBytes: 20_000,
            rootDiskTotalBytes: 100_000,
            uptimeSeconds: 86_400,
            version: "pve-manager/8.4.1",
            workloadCount: 2,
            runningWorkloadCount: 1,
            virtualMachineCount: 1,
            containerCount: 1
          }],
          workloads: [
            { vmid: 100, type: "qemu", node: "pve-main", name: "Jellyfin", status: "running", cpuPercent: 12, memoryUsedBytes: 2_000, memoryTotalBytes: 4_000, diskUsedBytes: 10_000, diskTotalBytes: 50_000, uptimeSeconds: 3_600 },
            { vmid: 104, type: "lxc", node: "pve-main", name: "Lab", status: "stopped", memoryTotalBytes: 2_000, diskTotalBytes: 20_000 }
          ],
          storage: [{ name: "local-zfs", node: "pve-main", status: "available", type: "zfspool", usedBytes: 20_000, totalBytes: 100_000, usagePercent: 20 }],
          activity: [{ id: "task-1", type: "qmstart", node: "pve-main", vmid: 100, status: "success", endedAt: "2026-09-13T01:00:00.000Z" }],
          metrics: {
            nodeTotal: 1,
            nodesOnline: 1,
            nodeCpuUsagePercent: 14,
            nodeMemoryUsedBytes: 4_000,
            nodeMemoryTotalBytes: 8_000,
            guestTotal: 8,
            guestsRunning: 7,
            guestsStopped: 1,
            storageUsagePercent: 42,
            failedTasks24h: 0,
            backupFailures24h: 0
          },
          checks: clone(healthyTest.checks)
        }]
      };
      return jsonResponse(clone(targets[0]), 201);
    }
    if (path === `/api/v2/infrastructure/environments/${targetId}` && method === "PUT") {
      return jsonResponse(clone(targets[0]));
    }
    return jsonResponse({ code: "NOT_FOUND", message: "Unexpected test route." }, 404);
  }, "infrastructure-workspace");

  await importShell(environment);
  await waitFor(() => environment.main.innerHTML.includes("operations-page"), "media workspace startup");
  assert.equal(environment.elements.get("#page-eyebrow").textContent, "Media operations");

  const infrastructureSwitch = environment.workspaceButtons.find((button) => button.dataset.workspace === "infrastructure");
  infrastructureSwitch.closest = (selector) => selector === "[data-action]" ? infrastructureSwitch : null;
  await environment.dispatchDocument("click", { target: infrastructureSwitch });
  await waitFor(() => environment.main.innerHTML.includes("infrastructure-overview"), "Infrastructure workspace");
  assert.equal(environment.localStorageValues.get("helmsman.workspace"), "infrastructure");
  assert.equal(environment.elements.get("#page-eyebrow").textContent, "Infrastructure");
  assert.equal(infrastructureSwitch.attributes.get("aria-pressed"), "true");
  assert.ok(environment.workspaceButtons.filter((button) => button.dataset.workspace === "media")
    .every((button) => button.attributes.get("aria-pressed") === "false"));
  assert.ok(environment.mediaOnly.every((element) => element.hidden), "media-only navigation must hide in Infrastructure");
  assert.ok(environment.infrastructureOnly.every((element) => !element.hidden), "infrastructure navigation must become available");
  assert.ok(environment.requestLog.some(({ path }) => path === "/api/v2/infrastructure/environments"), "workspace switch must load environment metadata");

  environment.location.hash = "#/services";
  await environment.dispatchWindow("hashchange", { type: "hashchange" });
  assert.match(environment.main.innerHTML, /id="infrastructure-environments"/u);
  assert.match(environment.main.innerHTML, /Connect your first Proxmox environment/u);
  assert.equal(environment.elements.get("#modal-layer").innerHTML, "", "closed Infrastructure view must not retain a token form");

  const modal = environment.elements.get("#modal-layer");
  const form = new FakeElement({ id: "proxmox-form" });
  const displayName = new FakeElement({ id: "proxmox-display-name" });
  displayName.name = "displayName";
  const urlInput = new FakeElement({ id: "proxmox-url" });
  urlInput.name = "url";
  const systemRadio = new FakeElement({ id: "proxmox-tls-system" });
  systemRadio.name = "tlsMode";
  systemRadio.value = "system";
  systemRadio.checked = true;
  const pinnedRadio = new FakeElement({ id: "proxmox-tls-pinned" });
  pinnedRadio.name = "tlsMode";
  pinnedRadio.value = "pinned";
  const fingerprintPanel = new FakeElement({ id: "proxmox-fingerprint-panel" });
  fingerprintPanel.dataset.tlsPanel = "pinned";
  fingerprintPanel.hidden = true;
  const fingerprintInput = new FakeElement({ id: "proxmox-certificate-fingerprint" });
  fingerprintInput.name = "certificateFingerprint";
  const tokenId = new FakeElement({ id: "proxmox-token-id" });
  tokenId.name = "proxmoxTokenId";
  const tokenSecret = new FakeElement({ id: "proxmox-token-secret" });
  tokenSecret.name = "proxmoxTokenSecret";
  const monitorCheckbox = new FakeElement({ id: "proxmox-monitoring-enabled" });
  monitorCheckbox.name = "monitoringEnabled";
  monitorCheckbox.checked = true;
  const credentialNote = new FakeElement();
  const error = new FakeElement({ id: "proxmox-error" });
  const submit = new FakeElement({ id: "proxmox-submit" });
  const testResult = new FakeElement({ id: "proxmox-test-result" });
  testResult.hidden = true;
  const testDot = new FakeElement();
  const testTitle = new FakeElement();
  const testDetail = new FakeElement();
  const testCapabilities = new FakeElement();
  const testNote = new FakeElement();
  const discoveryResult = new FakeElement();
  testResult.registerSelector(".health-dot", testDot);
  testResult.registerSelector("[data-test-title]", testTitle);
  testResult.registerSelector("[data-test-detail]", testDetail);
  testResult.registerSelector("[data-test-capabilities]", testCapabilities);
  testResult.registerSelector("[data-test-note]", testNote);

  form.dataset.infrastructureTargetId = "";
  form.dataset.originalUrl = "";
  form.dataset.originalTlsMode = "system";
  form.dataset.originalFingerprint = "";
  form.dataset.credentialConfigured = "false";
  form.dataset.targetEnabled = "true";
  form.dataset.monitoringIntervalSeconds = "60";
  form.dataset.discoveryConfirmed = "false";
  form.registerSelector("input[name='url']", urlInput);
  form.registerSelector("input[name='tlsMode']:checked", systemRadio);
  form.registerSelector("input[name='tlsMode']", systemRadio, pinnedRadio);
  form.registerSelector("[data-tls-panel='pinned']", fingerprintPanel);
  form.registerSelector("input[name='certificateFingerprint']", fingerprintInput);
  form.registerSelector("input[name='proxmoxTokenId']", tokenId);
  form.registerSelector("input[name='proxmoxTokenSecret']", tokenSecret);
  form.registerSelector("[data-proxmox-credential-note]", credentialNote);
  form.registerSelector("#proxmox-error", error);
  form.registerSelector("#proxmox-test-result", testResult);
  form.registerSelector("[data-proxmox-discovery]", discoveryResult);
  form.registerSelector("button[type='submit']", submit);
  form.formDataValues = new Map([
    ["displayName", ""],
    ["url", ""],
    ["tlsMode", "system"],
    ["certificateFingerprint", ""],
    ["proxmoxTokenId", ""],
    ["proxmoxTokenSecret", ""],
    ["monitoringEnabled", "on"]
  ]);
  modal.registerSelector("#proxmox-form", form);
  modal.registerSelector("#proxmox-display-name", displayName);

  const fieldClosest = (selector) => selector === "#proxmox-form" ? form : null;
  for (const field of [displayName, urlInput, systemRadio, pinnedRadio, fingerprintInput, tokenId, tokenSecret, monitorCheckbox]) {
    field.closest = fieldClosest;
  }
  const addButton = new FakeElement({ id: "add-proxmox" });
  addButton.dataset.action = "open-infrastructure-target";
  addButton.closest = (selector) => selector === "[data-action]" ? addButton : null;
  await environment.dispatchDocument("click", { target: addButton });
  await waitFor(() => modal.innerHTML.includes('id="proxmox-form"'), "Add Proxmox modal");
  assert.equal(environment.document.activeElement, displayName, "opening Add Proxmox must focus Display name once");
  assert.match(modal.innerHTML, /role="dialog"[^>]+aria-modal="true"[^>]+aria-labelledby="proxmox-modal-title"/u);
  assert.match(modal.innerHTML, /name="proxmoxTokenSecret" type="password" autocomplete="new-password"/u);
  assert.match(modal.innerHTML, /placeholder="https:\/\/proxmox\.example\.internal:8006"/u, "the Proxmox URL example must remain topology-neutral");
  assert.match(modal.innerHTML, /pvenode cert info/u, "pinned TLS setup must provide a local-console verification command");
  assert.match(modal.innerHTML, /do not trust a fingerprint learned only through the network being enrolled/u);
  assert.match(modal.innerHTML, /data-1p-ignore="true"/u);
  assert.match(modal.innerHTML, /data-bwignore="true"/u);
  assert.match(modal.innerHTML, /data-lpignore="true"/u);
  assert.match(modal.innerHTML, /data-protonpass-ignore="true"/u);
  assert.doesNotMatch(modal.innerHTML, /name="username"|name="password"/u);
  assert.match(modal.innerHTML, /data-action="test-infrastructure-target">Connect and discover/u);

  const writesAfterAddOpen = modal.markupWrites;
  displayName.value = "Main Proxmox";
  displayName.focus();
  await environment.dispatchDocument("click", { target: displayName });
  assert.equal(modal.markupWrites, writesAfterAddOpen, "clicking the Proxmox name must not rebuild the modal");
  assert.equal(environment.document.activeElement, displayName);

  monitorCheckbox.checked = false;
  monitorCheckbox.focus();
  await environment.dispatchDocument("click", { target: monitorCheckbox });
  assert.equal(modal.markupWrites, writesAfterAddOpen, "clicking Proxmox monitoring must not rebuild the modal");
  assert.equal(monitorCheckbox.checked, false, "delegation must preserve the checkbox choice");
  monitorCheckbox.checked = true;

  systemRadio.checked = false;
  pinnedRadio.checked = true;
  form.registerSelector("input[name='tlsMode']:checked", pinnedRadio);
  form.formDataValues.set("tlsMode", "pinned");
  await environment.dispatchDocument("change", { target: pinnedRadio });
  assert.equal(fingerprintPanel.hidden, false);
  assert.equal(fingerprintInput.disabled, false);
  assert.equal(fingerprintInput.required, true);
  assert.equal(pinnedRadio.attributes.get("aria-expanded"), "true");
  assert.equal(modal.markupWrites, writesAfterAddOpen, "changing Proxmox TLS mode must update in place");

  urlInput.value = targetUrl;
  fingerprintInput.value = fingerprint.match(/.{2}/gu).join(":");
  tokenId.value = tokenIdValue;
  tokenSecret.value = tokenSecretValue;
  form.formDataValues.set("displayName", displayName.value);
  form.formDataValues.set("url", urlInput.value);
  form.formDataValues.set("certificateFingerprint", fingerprintInput.value);
  form.formDataValues.set("proxmoxTokenId", tokenId.value);
  form.formDataValues.set("proxmoxTokenSecret", tokenSecret.value);
  for (const field of [urlInput, fingerprintInput, tokenId, tokenSecret]) {
    await environment.dispatchDocument("input", { target: field });
  }
  assert.equal(urlInput.customValidity, "");
  assert.equal(fingerprintInput.customValidity, "");
  assert.equal(tokenId.customValidity, "");
  assert.equal(tokenSecret.customValidity, "");
  assert.equal(modal.markupWrites, writesAfterAddOpen, "typing Proxmox fields must not rebuild the modal");

  const testButton = new FakeElement({ id: "test-proxmox" });
  testButton.dataset.action = "test-infrastructure-target";
  testButton.closest = (selector) => {
    if (selector === "[data-action]") return testButton;
    if (selector === "#proxmox-form") return form;
    return null;
  };
  tokenSecret.focus();
  await environment.dispatchDocument("click", { target: testButton });
  await waitFor(() => environment.requestLog.some(({ path }) => path === "/api/v2/infrastructure/environments/test"), "draft Proxmox test");
  await waitFor(() => testTitle.textContent === "Connection and credential verified", "draft Proxmox test result");
  const draftTestCall = environment.requestLog.find(({ path }) => path === "/api/v2/infrastructure/environments/test");
  assert.equal(draftTestCall.options.method, "POST");
  assert.equal(draftTestCall.options.credentials, "same-origin");
  assert.equal(draftTestCall.options.headers.get("X-Jellofin-CSRF"), csrfToken);
  assert.deepEqual(JSON.parse(draftTestCall.options.body), {
    type: "proxmox",
    url: targetUrl,
    tlsMode: "pinned",
    certificateFingerprint: fingerprint,
    credentials: { tokenId: tokenIdValue, tokenSecret: tokenSecretValue }
  }, "draft tests must not send display or monitor configuration");
  assert.equal(testResult.hidden, false);
  assert.equal(testResult.dataset.state, "healthy");
  assert.equal(testTitle.textContent, "Connection and credential verified");
  assert.match(testCapabilities.innerHTML, /API authorization/u);
  assert.match(testNote.textContent, /nothing was saved/u);
  assert.equal(form.dataset.discoveryConfirmed, "true");
  assert.match(discoveryResult.innerHTML, /Discovered standalone server pve-main/u);
  assert.equal(modal.markupWrites, writesAfterAddOpen, "testing Proxmox must not rebuild the modal");
  assert.equal(environment.document.activeElement, tokenSecret, "testing must not steal field focus");
  assert.equal(
    environment.requestLog.some(({ path, options }) => path === "/api/v2/infrastructure/environments" && options.method === "POST"),
    false,
    "testing a Proxmox draft must not save it"
  );

  form.formDataValues.set("monitoringEnabled", "on");
  await environment.dispatchDocument("submit", { target: form, preventDefault() {} });
  await waitFor(
    () => environment.requestLog.some(({ path, options }) => path === "/api/v2/infrastructure/environments" && options.method === "POST"),
    "Proxmox environment save"
  );
  const createCall = environment.requestLog.find(
    ({ path, options }) => path === "/api/v2/infrastructure/environments" && options.method === "POST"
  );
  assert.equal(createCall.options.credentials, "same-origin");
  assert.equal(createCall.options.headers.get("X-Jellofin-CSRF"), csrfToken);
  assert.deepEqual(JSON.parse(createCall.options.body), {
    type: "proxmox",
    displayName: "Main Proxmox",
    url: targetUrl,
    enabled: true,
    monitoringEnabled: true,
    monitoringIntervalSeconds: 60,
    tlsMode: "pinned",
    certificateFingerprint: fingerprint,
    credentials: { tokenId: tokenIdValue, tokenSecret: tokenSecretValue }
  });
  await waitFor(() => modal.innerHTML === "", "Proxmox modal close after save");
  assert.doesNotMatch(`${environment.main.innerHTML}${modal.innerHTML}`, /name="proxmoxTokenSecret"/u, "closed modal must remove token inputs");

  const snapshotsBeforeHydration = environment.requestLog.filter(({ path }) => path === "/api/v2/operations/snapshot").length;
  await environment.intervalCallbacks.at(-1)();
  await waitFor(
    () => environment.requestLog.filter(({ path }) => path === "/api/v2/operations/snapshot").length === snapshotsBeforeHydration + 1,
    "saved Proxmox monitor hydration"
  );

  const taskHistoryDiagnostic = {
    severity: "warning",
    source: "Recent failed tasks · Node pve-main",
    message: "GET /api2/json/nodes/pve-main/tasks?source=archive&limit=100 failed. Proxmox rejected the node-scoped task-history request (HTTP 400). Verify Proxmox API compatibility and the configured base URL.",
    tokenSecret: "pve-root@pam!helmsman=runtime-secret-must-not-render",
    upstreamBody: "raw upstream body must not render"
  };
  snapshot.infrastructure.targets[0].checks = [
    ...snapshot.infrastructure.targets[0].checks,
    {
      id: "tasks",
      label: "Recent failed tasks",
      state: "limited",
      code: "TASK_HISTORY_UNAVAILABLE",
      httpStatus: 400,
      reports: [taskHistoryDiagnostic]
    }
  ];
  snapshot.incidents = {
    open: [
      { service: "seerr", capability: "trending", state: "down", code: "HTTP_ERROR", status: 500, summary: "Media incident must stay out of Infrastructure", firstSeen: snapshot.generatedAt, lastSeen: snapshot.generatedAt, occurrenceCount: 2 },
      {
        service: `proxmox-${targetId}`,
        capability: "tasks",
        state: "limited",
        code: "TASK_HISTORY_UNAVAILABLE",
        status: 400,
        summary: "Infrastructure incident is visible",
        firstSeen: snapshot.generatedAt,
        lastSeen: snapshot.generatedAt,
        occurrenceCount: 2
      }
    ],
    recent: [
      { service: "seerr", capability: "discovery", previousState: "down", recoveredAt: snapshot.generatedAt, occurrenceCount: 1 },
      { service: `proxmox-${targetId}`, capability: "backup_visibility", previousState: "limited", recoveredAt: snapshot.generatedAt, occurrenceCount: 1 }
    ]
  };
  const snapshotsBeforeIncidentScope = environment.requestLog.filter(({ path }) => path === "/api/v2/operations/snapshot").length;
  await environment.intervalCallbacks.at(-1)();
  await waitFor(
    () => environment.requestLog.filter(({ path }) => path === "/api/v2/operations/snapshot").length === snapshotsBeforeIncidentScope + 1,
    "mixed-scope incident snapshot"
  );
  environment.location.hash = "#/incidents";
  await environment.dispatchWindow("hashchange", { type: "hashchange" });
  assert.match(environment.main.innerHTML, /Infrastructure incident is visible/u, "Infrastructure Incidents must include Proxmox incidents");
  assert.match(environment.main.innerHTML, /TASK_HISTORY_UNAVAILABLE · HTTP 400/u, "Infrastructure Incidents must retain the safe code and HTTP status");
  assert.match(environment.main.innerHTML, /Recent failed tasks · Node pve-main/u, "Infrastructure Incidents must identify the affected node");
  assert.match(environment.main.innerHTML, /GET \/api2\/json\/nodes\/pve-main\/tasks\?source=archive&amp;limit=100 failed/u, "Infrastructure Incidents must show the fixed safe operation");
  assert.match(environment.main.innerHTML, /Verify Proxmox API compatibility and the configured base URL/u, "Infrastructure Incidents must show the fixed diagnostic action");
  assert.match(environment.main.innerHTML, /Next step.*Verify the configured Proxmox base URL and PVE API compatibility.*retest/su, "Infrastructure Incidents must show actionable HTTP 400 guidance");
  assert.doesNotMatch(environment.main.innerHTML, /runtime-secret-must-not-render|raw upstream body must not render/u, "Infrastructure Incidents must omit unknown credential and upstream-body fields");
  assert.match(environment.main.innerHTML, /Backup visibility/u, "Infrastructure Incidents must include Proxmox recoveries");
  assert.doesNotMatch(environment.main.innerHTML, /Media incident must stay out of Infrastructure|Seerr/u, "Infrastructure Incidents must exclude media incidents and recoveries");
  environment.location.hash = "#/environments";
  await environment.dispatchWindow("hashchange", { type: "hashchange" });

  const environmentDetailButton = new FakeElement({ id: "environment-detail" });
  environmentDetailButton.dataset.action = "open-infrastructure-environment-detail";
  environmentDetailButton.dataset.infrastructureTargetId = targetId;
  environmentDetailButton.closest = (selector) => selector === "[data-action]" ? environmentDetailButton : null;
  await environment.dispatchDocument("click", { target: environmentDetailButton });
  assert.match(modal.innerHTML, /API endpoints/u);
  assert.match(modal.innerHTML, /pve-main/u);
  const closeDetail = new FakeElement({ id: "close-environment-detail" });
  closeDetail.dataset.action = "close-modal";
  closeDetail.closest = (selector) => selector === "[data-action]" ? closeDetail : null;
  await environment.dispatchDocument("click", { target: closeDetail });

  environment.location.hash = "#/nodes";
  await environment.dispatchWindow("hashchange", { type: "hashchange" });
  assert.match(environment.main.innerHTML, /Proxmox nodes/u);
  assert.match(environment.main.innerHTML, /pve-main/u);
  assert.match(environment.main.innerHTML, /API 1\/1/u, "node cards must keep environment endpoint availability separate from node state");
  assert.match(environment.main.innerHTML, /node-mark"><img class="service-brand-icon service-brand-icon--light-plate" src="\.\/assets\/services\/proxmox\.png"/u, "node cards must use the normalized Proxmox mark on its light plate");
  const nodeDetailButton = new FakeElement({ id: "node-detail" });
  nodeDetailButton.dataset.action = "open-infrastructure-node";
  nodeDetailButton.dataset.infrastructureNodeId = `${targetId}:pve-main`;
  nodeDetailButton.closest = (selector) => selector === "[data-action]" ? nodeDetailButton : null;
  await environment.dispatchDocument("click", { target: nodeDetailButton });
  assert.match(modal.innerHTML, /Environment API · 1 of 1 endpoints available/u);
  assert.match(modal.innerHTML, /does not override the node state/u);
  assert.match(modal.innerHTML, /detail-modal-mark"><img class="service-brand-icon service-brand-icon--light-plate" src="\.\/assets\/services\/proxmox\.png"/u, "node detail must use the normalized Proxmox mark on its light plate");
  await environment.dispatchDocument("click", { target: closeDetail });
  environment.location.hash = "#/workloads";
  await environment.dispatchWindow("hashchange", { type: "hashchange" });
  assert.match(environment.main.innerHTML, /Jellyfin/u);
  assert.match(environment.main.innerHTML, /Lab/u);
  const stoppedWorkloadButton = new FakeElement({ id: "stopped-workload" });
  stoppedWorkloadButton.dataset.action = "open-infrastructure-workload";
  stoppedWorkloadButton.dataset.infrastructureWorkloadId = `${targetId}:pve-main:lxc:104`;
  stoppedWorkloadButton.closest = (selector) => selector === "[data-action]" ? stoppedWorkloadButton : null;
  await environment.dispatchDocument("click", { target: stoppedWorkloadButton });
  assert.match(modal.innerHTML, /deliberately stopped guest is informational/u);
  await environment.dispatchDocument("click", { target: closeDetail });
  environment.location.hash = "#/environments";
  await environment.dispatchWindow("hashchange", { type: "hashchange" });

  form.dataset.infrastructureTargetId = targetId;
  form.dataset.originalUrl = targetUrl;
  form.dataset.originalTlsMode = "pinned";
  form.dataset.originalFingerprint = fingerprint;
  form.dataset.credentialConfigured = "true";
  form.dataset.targetEnabled = "true";
  form.dataset.monitoringIntervalSeconds = "60";
  displayName.value = "Main Proxmox";
  urlInput.value = `${targetUrl}/`;
  fingerprintInput.value = fingerprint;
  tokenId.value = "";
  tokenSecret.value = "";
  monitorCheckbox.checked = true;
  testResult.hidden = true;
  testTitle.textContent = "";
  testDetail.textContent = "";
  testCapabilities.innerHTML = "";
  testNote.textContent = "";
  form.formDataValues = new Map([
    ["displayName", "Main Proxmox"],
    ["url", urlInput.value],
    ["tlsMode", "pinned"],
    ["certificateFingerprint", fingerprint],
    ["proxmoxTokenId", ""],
    ["proxmoxTokenSecret", ""],
    ["monitoringEnabled", "on"]
  ]);
  const editButton = new FakeElement({ id: "edit-proxmox" });
  editButton.dataset.action = "open-infrastructure-target";
  editButton.dataset.infrastructureTargetId = targetId;
  editButton.closest = (selector) => selector === "[data-action]" ? editButton : null;
  await environment.dispatchDocument("click", { target: editButton });
  await waitFor(() => modal.innerHTML.includes("Protected API token saved"), "edit Proxmox modal");
  const writesAfterEditOpen = modal.markupWrites;
  assert.match(modal.innerHTML, /Blank keeps the saved token/u);
  assert.doesNotMatch(modal.innerHTML, /value="proxmox-token-secret"/u, "saved token values must remain write-only");
  assert.equal(tokenId.value, "");
  assert.equal(tokenSecret.value, "");
  assert.equal(tokenId.required, false, "blank token ID must retain the saved credential");
  assert.equal(tokenSecret.required, false, "blank token secret must retain the saved credential");
  assert.match(credentialNote.textContent, /Leave both token fields blank/u);
  assert.equal(urlInput.value, `${targetUrl}/`, "a root trailing slash must remain an equivalent connection URL");

  urlInput.value = `${targetUrl}?view=nodes`;
  form.formDataValues.set("url", urlInput.value);
  await environment.dispatchDocument("input", { target: urlInput });
  assert.equal(tokenId.required, true, "a query change must require a fresh Proxmox token");
  assert.equal(tokenSecret.required, true);
  assert.match(credentialNote.textContent, /connection address or certificate trust changed/u);
  urlInput.value = `${targetUrl}/api2`;
  form.formDataValues.set("url", urlInput.value);
  await environment.dispatchDocument("input", { target: urlInput });
  assert.equal(tokenId.required, true, "a path change must require a fresh Proxmox token");
  urlInput.value = `${targetUrl}/`;
  form.formDataValues.set("url", urlInput.value);
  await environment.dispatchDocument("input", { target: urlInput });
  assert.equal(tokenId.required, false, "restoring only a root slash must allow saved credential retention");
  assert.equal(tokenSecret.required, false);
  assert.equal(modal.markupWrites, writesAfterEditOpen, "connection comparison must update edit requirements in place");

  const savedTestsBefore = environment.requestLog.filter(
    ({ path }) => path === `/api/v2/infrastructure/environments/${targetId}/test`
  ).length;
  await environment.dispatchDocument("click", { target: testButton });
  await waitFor(
    () => environment.requestLog.filter(({ path }) => path === `/api/v2/infrastructure/environments/${targetId}/test`).length === savedTestsBefore + 1,
    "saved Proxmox target test"
  );
  await waitFor(() => testTitle.textContent === "Connection and credential verified", "saved Proxmox test result");
  const savedTestCall = environment.requestLog.filter(
    ({ path }) => path === `/api/v2/infrastructure/environments/${targetId}/test`
  ).at(-1);
  assert.equal(savedTestCall.options.method, "POST");
  assert.deepEqual(JSON.parse(savedTestCall.options.body), {}, "an unchanged edit test must reuse the saved write-only token");
  assert.equal(modal.markupWrites, writesAfterEditOpen, "saved-target testing must not rebuild the modal");

  tokenSecret.value = "unsaved-proxmox-draft";
  tokenSecret.focus();
  monitorCheckbox.checked = false;
  const mainWritesBeforePoll = environment.main.markupWrites;
  const modalWritesBeforePoll = modal.markupWrites;
  snapshot.generatedAt = "2026-09-13T01:01:00.000Z";
  snapshot.infrastructure.generatedAt = snapshot.generatedAt;
  snapshot.infrastructure.targets[0].checkedAt = snapshot.generatedAt;
  snapshot.infrastructure.targets[0].latencyMs = 17;
  snapshot.infrastructure.targets[0].metrics.nodeCpuUsagePercent = 23;
  snapshot.infrastructure.targets[0].metrics.guestsRunning = 6;
  const snapshotsBeforeVolatilePoll = environment.requestLog.filter(({ path }) => path === "/api/v2/operations/snapshot").length;
  await environment.intervalCallbacks.at(-1)();
  await waitFor(
    () => environment.requestLog.filter(({ path }) => path === "/api/v2/operations/snapshot").length === snapshotsBeforeVolatilePoll + 1,
    "volatile Proxmox monitor poll"
  );
  assert.equal(environment.main.markupWrites, mainWritesBeforePoll, "volatile Proxmox metrics must not repaint the workspace");
  assert.equal(modal.markupWrites, modalWritesBeforePoll, "background polling must not rebuild the Proxmox modal");
  assert.equal(environment.document.activeElement, tokenSecret, "background polling must preserve Proxmox field focus");
  assert.equal(tokenSecret.value, "unsaved-proxmox-draft", "background polling must preserve the unsaved token draft");
  assert.equal(monitorCheckbox.checked, false, "background polling must preserve the unsaved monitor choice");

  const closeEdit = new FakeElement({ id: "close-proxmox-edit" });
  closeEdit.dataset.action = "close-modal";
  closeEdit.closest = (selector) => selector === "[data-action]" ? closeEdit : null;
  await environment.dispatchDocument("click", { target: closeEdit });
  snapshot.events = [{
    level: "warn",
    summary: "Storage visibility needs attention",
    service: `proxmox-${targetId}`,
    capability: "storage",
    code: "HTTP_ERROR",
    httpStatus: 503,
    at: "2026-09-13T01:01:00.000Z"
  }];
  const snapshotsBeforeLogEvent = environment.requestLog.filter(({ path }) => path === "/api/v2/operations/snapshot").length;
  await environment.intervalCallbacks.at(-1)();
  await waitFor(
    () => environment.requestLog.filter(({ path }) => path === "/api/v2/operations/snapshot").length === snapshotsBeforeLogEvent + 1,
    "Proxmox log event snapshot"
  );
  environment.location.hash = "#/logs";
  await environment.dispatchWindow("hashchange", { type: "hashchange" });
  assert.match(environment.main.innerHTML, /Main Proxmox · storage/u, "global Logs must resolve a Proxmox target to its display name");
  assert.match(environment.main.innerHTML, /HTTP_ERROR · HTTP 503/u, "Logs must retain safe error code and bounded HTTP status evidence");
  assert.doesNotMatch(environment.main.innerHTML, new RegExp(`proxmox-${targetId}`, "u"), "global Logs must not expose an opaque target id as the operator label");

  const mediaSwitch = environment.workspaceButtons.find((button) => button.dataset.workspace === "media");
  mediaSwitch.closest = (selector) => selector === "[data-action]" ? mediaSwitch : null;
  await environment.dispatchDocument("click", { target: mediaSwitch });
  assert.equal(environment.location.hash, "#/logs", "switching workspaces must preserve the shared Logs route");
  assert.equal(environment.localStorageValues.get("helmsman.workspace"), "media");
  assert.ok(environment.mediaOnly.every((element) => !element.hidden), "Media navigation must become available in Media");
  assert.ok(environment.infrastructureOnly.every((element) => element.hidden), "Infrastructure navigation must hide in Media");

  environment.location.hash = "#/library";
  await environment.dispatchWindow("hashchange", { type: "hashchange" });
  await environment.dispatchDocument("click", { target: infrastructureSwitch });
  assert.equal(environment.location.hash, "#/overview", "switching from a Media-only route must use the Infrastructure landing route");

  environment.location.hash = "#/settings";
  await environment.dispatchWindow("hashchange", { type: "hashchange" });
  await environment.dispatchDocument("click", { target: mediaSwitch });
  assert.equal(environment.location.hash, "#/settings", "switching workspaces must preserve the shared Settings route");

  await environment.dispatchDocument("click", { target: infrastructureSwitch });
  environment.location.hash = "#/workloads";
  await environment.dispatchWindow("hashchange", { type: "hashchange" });
  await environment.dispatchDocument("click", { target: mediaSwitch });
  assert.equal(environment.location.hash, "#/home", "switching from an Infrastructure-only route must use the Media landing route");
}

async function portainerInfrastructureContract() {
  const serviceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const hostileEnvironment = 'Docker host <img src=x onerror="portainer-environment-xss">';
  const hostileContainer = "reverse-proxy <script>portainer-container-xss</script>";
  const hiddenToken = "portainer-access-token-must-never-render";
  const config = {
    policy: { allowedCidrs: [], allowPublicHttps: false },
    services: [],
    infrastructureEnvironments: [],
    infrastructureTargets: [],
    infrastructureServiceDefinitions: [{ id: "portainer", name: "Portainer", role: "Container management" }],
    infrastructureServices: [{
      id: serviceId,
      type: "portainer",
      typeName: "Portainer",
      role: "Container management",
      displayName: "Container Control",
      url: "https://portainer.example.internal:9443",
      enabled: true,
      monitoringEnabled: true,
      tlsMode: "system",
      certificateFingerprint: null,
      credentialConfigured: true,
      credentialUpdatedAt: "2026-09-13T02:00:00.000Z",
      accessToken: hiddenToken
    }]
  };
  const snapshot = {
    version: 1,
    generatedAt: "2026-09-13T02:00:00.000Z",
    overall: { state: "healthy", serviceCount: 0, affectedServiceCount: 0, openIncidentCount: 0 },
    services: [],
    pipeline: { state: "healthy", stages: [] },
    workload: {},
    media: null,
    infrastructure: {
      generatedAt: "2026-09-13T02:00:00.000Z",
      state: "degraded",
      targets: [],
      services: [{
        id: serviceId,
        type: "portainer",
        displayName: "Container Control",
        state: "degraded",
        connectionState: "connected",
        version: "2.45.0",
        checkedAt: "2026-09-13T02:00:00.000Z",
        latencyMs: 18,
        capabilities: [
          { id: "status", label: "Server status", state: "healthy", status: 200, latencyMs: 5 },
          { id: "identity", label: "Token authorization", state: "healthy", status: 200, latencyMs: 7 },
          {
            id: "environment-1",
            label: "Docker environment",
            state: "degraded",
            code: "CONTAINERS_UNHEALTHY",
            reports: [{ severity: "error", source: "Docker environment", message: "reverse-proxy is unhealthy" }]
          },
          {
            id: "containers-2",
            label: "Restricted containers",
            state: "degraded",
            code: "FORBIDDEN",
            status: 403,
            reports: [{ severity: "error", source: "Restricted containers", message: "The authenticated Portainer user cannot read this environment." }]
          }
        ],
        inventory: {
          environments: [{ id: 1, name: hostileEnvironment, state: "up", platform: "Docker", containerCapable: true, edge: false, agentVersion: "2.34.0" }],
          containers: [{
            id: "abcdef0123456789abcdef0123456789",
            shortId: "abcdef012345",
            name: hostileContainer,
            image: "traefik:v3.5",
            environmentId: 1,
            environmentName: hostileEnvironment,
            state: "running",
            status: "Up 3 hours (unhealthy)",
            health: "unhealthy",
            stack: "edge",
            createdAt: "2026-09-12T23:00:00.000Z",
            ports: [{ privatePort: 443, publicPort: 443, protocol: "tcp" }],
            accessToken: hiddenToken
          }],
          stacks: [{ id: 9, name: "edge", state: "active", type: 2, environmentId: 1, environmentName: hostileEnvironment, updatedAt: "2026-09-13T01:30:00.000Z" }]
        },
        accessToken: hiddenToken
      }]
    },
    incidents: {
      open: [{
        service: `portainer-${serviceId}`,
        capability: "environment-1",
        state: "degraded",
        code: "CONTAINERS_UNHEALTHY",
        occurrenceCount: 2,
        firstSeen: "2026-09-13T01:30:00.000Z",
        lastSeen: "2026-09-13T02:00:00.000Z"
      }],
      recent: []
    },
    events: [{
      level: "warn",
      summary: "Container inventory needs attention",
      service: `portainer-${serviceId}`,
      capability: "environment-1",
      code: "CONTAINERS_UNHEALTHY",
      at: "2026-09-13T02:00:00.000Z"
    }]
  };
  const environment = installFakeBrowser(({ path }) => {
    if (path === "/api/v2/status") return jsonResponse({ setupRequired: false, authenticated: true, csrfToken: "portainer-csrf", session: { name: "Portainer Browser" } });
    if (path === "/api/v2/config") return jsonResponse(clone(config));
    if (path === "/api/v2/operations/snapshot") return jsonResponse(clone(snapshot));
    if (path === "/api/v2/sessions") return jsonResponse({ currentSessionId: "", sessions: [] });
    return jsonResponse({ code: "NOT_FOUND", message: "Unexpected test route." }, 404);
  }, "portainer-infrastructure");
  environment.localStorageValues.set("helmsman.workspace", "infrastructure");
  environment.location.hash = "#/portainer";
  await importShell(environment);
  await waitFor(() => environment.main.innerHTML.includes("portainer-infrastructure"), "Portainer infrastructure route");
  const markup = environment.main.innerHTML;
  assert.equal(environment.elements.get("#page-title").textContent, "Portainer");
  assert.match(markup, /assets\/services\/portainer\.svg/u);
  assert.match(markup, /Container Control/u);
  assert.match(markup, /Portainer 2\.45\.0/u);
  assert.match(markup, /Connected · Degraded/u, "a container-environment 403 must not erase verified Portainer identity");
  assert.match(markup, /Authenticated user lacks permission for this capability or environment · FORBIDDEN · HTTP 403/u, "a Portainer environment 403 must be identified as an authorization failure");
  assert.match(markup, /class="portainer-environment-card"/u);
  assert.match(markup, /class="portainer-container-row is-down"/u);
  assert.match(markup, /class="portainer-stack-card"/u);
  assert.match(markup, /Stopped and exited containers are informational/u);
  assert.match(markup, /No controls are sent to Portainer/u);
  assert.match(markup, /Docker host &lt;img src=x onerror=&quot;portainer-environment-xss&quot;&gt;/u);
  assert.match(markup, /reverse-proxy &lt;script&gt;portainer-container-xss&lt;\/script&gt;/u);
  assert.doesNotMatch(markup, /<script>portainer-container-xss<\/script>|<img src=x onerror="portainer-environment-xss">/u);
  assert.doesNotMatch(`${markup}${environment.elements.get("#modal-layer").innerHTML}`, new RegExp(hiddenToken, "u"));

  const editConnection = new FakeElement({ id: "edit-portainer" });
  editConnection.dataset.action = "open-portainer-service";
  editConnection.dataset.portainerServiceId = serviceId;
  editConnection.closest = (selector) => selector === "[data-action]" ? editConnection : null;
  await environment.dispatchDocument("click", { target: editConnection });
  const modal = environment.elements.get("#modal-layer");
  assert.match(modal.innerHTML, /id="portainer-form"/u);
  assert.match(modal.innerHTML, /name="accessToken" type="password" autocomplete="new-password"/u);
  assert.match(modal.innerHTML, /Blank keeps the saved token/u);
  assert.match(modal.innerHTML, /data-action="test-portainer-service">Test read-only access/u);
  assert.match(modal.innerHTML, /data-action="delete-portainer-service"/u);
  assert.match(modal.innerHTML, /No controls are sent to Portainer|GET-only checks/u);
  assert.doesNotMatch(modal.innerHTML, new RegExp(hiddenToken, "u"));
  const closeConnection = new FakeElement({ id: "close-portainer" });
  closeConnection.dataset.action = "close-modal";
  closeConnection.closest = (selector) => selector === "[data-action]" ? closeConnection : null;
  await environment.dispatchDocument("click", { target: closeConnection });
  assert.equal(modal.innerHTML, "", "closing Portainer must remove its token field from the DOM");

  environment.location.hash = "#/incidents";
  await environment.dispatchWindow("hashchange", { type: "hashchange" });
  assert.match(environment.main.innerHTML, /Container Control · Environment 1/u);
  assert.match(environment.main.innerHTML, /CONTAINERS_UNHEALTHY/u);
  assert.match(environment.main.innerHTML, /reverse-proxy is unhealthy/u);

  environment.location.hash = "#/logs";
  await environment.dispatchWindow("hashchange", { type: "hashchange" });
  assert.match(environment.main.innerHTML, /Container Control · environment-1/u, "Logs must resolve a Portainer monitor id to its configured display name");
  assert.doesNotMatch(environment.main.innerHTML, new RegExp(`portainer-${serviceId}`, "u"));

  const mediaSwitch = environment.workspaceButtons.find((button) => button.dataset.workspace === "media");
  mediaSwitch.closest = (selector) => selector === "[data-action]" ? mediaSwitch : null;
  await environment.dispatchDocument("click", { target: mediaSwitch });
  assert.equal(environment.location.hash, "#/logs", "switching workspaces must preserve shared Logs");
  environment.location.hash = "#/health";
  await environment.dispatchWindow("hashchange", { type: "hashchange" });
  assert.doesNotMatch(environment.main.innerHTML, /Container Control|CONTAINERS_UNHEALTHY|reverse-proxy is unhealthy/u, "Media Health must not render Portainer incidents");
  environment.location.hash = "#/portainer";
  await environment.dispatchWindow("hashchange", { type: "hashchange" });
  assert.equal(environment.location.hash, "#/home", "Media must canonicalize an Infrastructure-only Portainer route to Home");
}

async function authenticatedRuntimeContract() {
  const csrfToken = "runtime-csrf-token";
  const rotatedCsrfToken = "rotated-runtime-csrf-token";
  const rotatedAccessKey = "hm-rotated-<script>rotation-xss</script>";
  const currentSessionId = "11111111-1111-4111-8111-111111111111";
  const rotatedSessionId = "33333333-3333-4333-8333-333333333333";
  const otherSessionId = "22222222-2222-4222-8222-222222222222";
  const hostileSessionName = 'Kitchen <img src=x onerror="session-xss">';
  const hostileSessionOrigin = 'http://kitchen.test/\"><svg/onload=session-xss>';
  const hostileHeadline = '<img src=x onerror="alert(1)">';
  const hostileSummary = "Seerr failed </h3><script>alert(1)</script>";
  const hostileReportSource = 'IndexerCheck </small><img src=x onerror="runtime-report-source-xss">';
  const hostileReportMessage = "1337x unavailable <script>runtime-report-message-xss</script>";
  const serviceReports = Array.from({ length: 14 }, (_value, index) => ({
    severity: index === 0 ? "error" : "warning",
    source: index === 0 ? hostileReportSource : `IndexerCheck${index + 1}`,
    message: index === 0 ? hostileReportMessage : `Indexer report ${index + 1}`
  }));
  const config = {
    policy: { allowedCidrs: ["192.168.0.7/32"], allowPublicHttps: false },
    services: [
      {
        id: "jellyfin",
        name: "Jellyfin",
        role: "Library and playback",
        url: "http://192.168.0.7:8096",
        configured: true,
        authMode: "token",
        credentialConfigured: true,
        credentialLabel: "API token",
        credentialHint: "Use a dedicated token.",
        monitoringEnabled: true
      },
      {
        id: "seerr",
        name: "Seerr",
        role: "Discovery and requests",
        url: "http://192.168.0.104:5055",
        configured: true,
        authMode: "apiKey",
        credentialConfigured: true,
        credentialLabel: "API key",
        credentialHint: "Use a dedicated key.",
        authOptions: [
          {
            id: "apiKey",
            label: "API key",
            input: "secret",
            credentialLabel: "API key",
            hint: "Use the global API key from Seerr Settings > General."
          },
          {
            id: "login",
            label: "Email + password",
            input: "login",
            identityLabel: "Seerr account email",
            hint: "Requires Seerr local sign-in. Helmsman stores only the resulting encrypted session and discards the password."
          }
        ],
        monitoringEnabled: true
      }
    ]
  };
  const snapshot = {
    version: 1,
    generatedAt: "2026-09-12T21:09:14.000Z",
    overall: {
      state: "limited",
      headline: hostileHeadline,
      summary: "Core requests work, but discovery is limited.",
      serviceCount: 2,
      affectedServiceCount: 1,
      openIncidentCount: 1
    },
    services: [
      {
        id: "jellyfin",
        label: "Jellyfin",
        state: "limited",
        connectionState: "connected",
        latencyMs: 42,
        checkedAt: "2026-09-12T21:09:14.000Z",
        checks: [
          { id: "identity", state: "healthy", checkedAt: "2026-09-12T21:09:14.000Z" },
          { id: "system", state: "limited", code: "HTTP_ERROR", checkedAt: "2026-09-12T21:09:14.000Z" }
        ]
      },
      {
        id: "seerr",
        label: "Seerr",
        state: "healthy",
        latencyMs: 81,
        checkedAt: "2026-09-12T21:09:14.000Z",
        checks: [
          { id: "requestcounts", state: "healthy", checkedAt: "2026-09-12T21:09:14.000Z" },
          { id: "trending", state: "limited", checkedAt: "2026-09-12T21:09:14.000Z", reports: serviceReports }
        ]
      }
    ],
    pipeline: {
      state: "limited",
      stages: [
        { id: "requests", label: "Requests", state: "healthy", serviceCount: 1, failingCheckCount: 0, metrics: { waiting: 1 } },
        { id: "search", label: "Search", state: "limited", serviceCount: 1, failingCheckCount: 1, metrics: {} }
      ]
    },
    incidents: {
      open: [{ service: "seerr", capability: "trending", state: "limited", impact: "optional", code: "HTTP_ERROR", httpStatus: 500, summary: hostileSummary, firstSeen: "2026-09-12T21:00:00.000Z", lastSeen: "2026-09-12T21:09:14.000Z", occurrenceCount: 7 }],
      recent: []
    },
    workload: { pendingRequests: 1, downloading: 2, stalled: 0 },
    events: []
  };

  let accessRotated = false;
  const environment = installFakeBrowser(({ path, options }) => {
    if (path === "/api/v2/status") {
      return jsonResponse({
        setupRequired: false,
        authenticated: true,
        accessKeyConfigured: true,
        csrfToken,
        session: { id: currentSessionId, name: "Runtime Browser" },
        storage: { credentialsEncrypted: true, externalKey: false }
      });
    }
    if (path === "/api/v2/config" && String(options.method || "GET") === "GET") return jsonResponse(clone(config));
    if (path === "/api/v2/operations/snapshot") return jsonResponse(clone(snapshot));
    if (path === "/api/v2/operations/refresh") return jsonResponse(clone(snapshot));
    if (path === "/api/v2/sessions" && String(options.method || "GET") === "GET") {
      if (accessRotated) {
        return jsonResponse({
          currentSessionId: rotatedSessionId,
          sessions: [{
            id: rotatedSessionId,
            name: "Rotated Runtime Browser",
            origin: "http://127.0.0.1:4180",
            createdAt: "2026-09-14T12:00:00.000Z",
            expiresAt: "2027-09-14T12:00:00.000Z"
          }]
        });
      }
      return jsonResponse({
        currentSessionId,
        sessions: [
          {
            id: otherSessionId,
            name: hostileSessionName,
            origin: hostileSessionOrigin,
            createdAt: "2026-09-12T20:00:00.000Z",
            expiresAt: "2027-09-12T20:00:00.000Z"
          },
          {
            id: currentSessionId,
            name: "Runtime Browser",
            origin: "http://127.0.0.1:4180",
            createdAt: "2026-09-12T21:00:00.000Z",
            expiresAt: "2027-09-12T21:00:00.000Z"
          }
        ]
      });
    }
    if (path === `/api/v2/sessions/${otherSessionId}` && String(options.method || "GET") === "DELETE") {
      return new Response(null, { status: 204 });
    }
    if (path === "/api/v2/session" && options.method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    if (path === "/api/v2/access/rotate" && options.method === "POST") {
      accessRotated = true;
      return jsonResponse({
        accessKey: rotatedAccessKey,
        csrfToken: rotatedCsrfToken,
        session: { id: rotatedSessionId, name: "Rotated Runtime Browser" }
      });
    }
    return jsonResponse({ code: "NOT_FOUND", message: "Unexpected test route." }, 404);
  }, "authenticated");

  await importShell(environment);
  await waitFor(() => environment.main.innerHTML.includes("operations-page"), "operations Overview");

  assert.ok(environment.requestLog.some(({ path }) => path === "/api/v2/config"), "authenticated startup must request configuration");
  assert.ok(environment.requestLog.some(({ path }) => path === "/api/v2/operations/snapshot"), "authenticated startup must request the operations snapshot");
  assert.ok(environment.requestLog.some(({ path }) => path === "/api/v2/sessions"), "authenticated startup must request authorized browser sessions");
  assert.match(environment.main.innerHTML, /operations-overall/u);
  assert.doesNotMatch(environment.main.innerHTML, /<img src=x/u, "hostile API headings must not create elements");
  assert.doesNotMatch(environment.main.innerHTML, /<script>alert\(1\)<\/script>/u, "hostile incident text must not create scripts");
  assert.match(environment.main.innerHTML, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/u);
  assert.match(environment.main.innerHTML, /&lt;\/h3&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;/u);
  assert.match(environment.main.innerHTML, /Reported by Seerr/u, "the Overview must identify the service that supplied report details");
  assert.match(environment.main.innerHTML, /1337x unavailable &lt;script&gt;runtime-report-message-xss&lt;\/script&gt;/u);
  assert.match(environment.main.innerHTML, /IndexerCheck &lt;\/small&gt;&lt;img src=x onerror=&quot;runtime-report-source-xss&quot;&gt;/u);
  assert.doesNotMatch(environment.main.innerHTML, /<script>runtime-report-message-xss<\/script>|<img src=x onerror="runtime-report-source-xss">/u);
  assert.equal(
    (environment.main.innerHTML.match(/class="operations-report is-/gu) || []).length,
    12,
    "the Overview must not render more than twelve reports for a check"
  );

  environment.location.hash = "#/incidents";
  await environment.dispatchWindow("hashchange", { type: "hashchange" });
  assert.match(environment.main.innerHTML, /Reported by Seerr/u, "the Incidents page must include correlated service reports");
  assert.match(environment.main.innerHTML, /1337x unavailable &lt;script&gt;runtime-report-message-xss&lt;\/script&gt;/u);
  assert.doesNotMatch(environment.main.innerHTML, /<script>runtime-report-message-xss<\/script>/u);

  environment.location.hash = "#/services";
  await environment.dispatchWindow("hashchange", { type: "hashchange" });
  assert.match(environment.main.innerHTML, /service-grid-v5/u, "the Services route must render its configured services");
  assert.match(environment.main.innerHTML, /Credential saved/u);
  assert.match(environment.main.innerHTML, /Connected · Limited health/u, "operational warnings must not hide a verified connection");
  assert.match(environment.main.innerHTML, /Credential not verified/u, "a healthy public-only check must not imply credential success");

  const seerrOpener = {
    dataset: { action: "open-service", serviceId: "seerr" },
    closest(selector) {
      return selector === "[data-action]" ? this : null;
    }
  };
  await environment.dispatchDocument("click", { target: seerrOpener });
  const modal = environment.elements.get("#modal-layer");
  assert.match(modal.innerHTML, /value="apiKey"[^>]*checked/u);
  assert.match(modal.innerHTML, /Email \+ password/u);
  assert.match(modal.innerHTML, /Seerr account email/u);
  assert.match(modal.innerHTML, /name="username" type="email" autocomplete="username"/u);
  assert.match(modal.innerHTML, /Requires Seerr local sign-in/u);
  assert.match(modal.innerHTML, /password is discarded immediately/u);
  assert.match(modal.innerHTML, /health-dot is-stale[^>]*data-monitor-dot/u, "unverified authentication must not use a healthy dot");
  assert.match(modal.innerHTML, /Credential not verified/u);
  assert.match(modal.innerHTML, /Reported by Seerr/u, "the service dialog must show its latest upstream reports");
  assert.match(modal.innerHTML, /1337x unavailable &lt;script&gt;runtime-report-message-xss&lt;\/script&gt;/u);
  assert.doesNotMatch(modal.innerHTML, /<script>runtime-report-message-xss<\/script>/u);
  assert.doesNotMatch(modal.innerHTML, /name="clearCredential"/u, "configured Seerr must not offer an invalid credential-clear action");
  const modalCloser = {
    dataset: { action: "close-modal" },
    closest(selector) {
      return selector === "[data-action]" ? this : null;
    }
  };
  await environment.dispatchDocument("click", { target: modalCloser });

  snapshot.services[1].connectionState = "auth_required";
  snapshot.services[1].state = "down";
  snapshot.services[1].checks = [{
    id: "identity",
    state: "auth_required",
    code: "AUTH_REQUIRED",
    httpStatus: 401,
    checkedAt: snapshot.generatedAt
  }];
  await environment.intervalCallbacks.at(-1)();
  assert.match(
    environment.main.innerHTML,
    /health-dot is-auth-required[\s\S]*Authentication required/u,
    "an explicit authentication failure must use the red authentication state"
  );

  environment.location.hash = "#/settings";
  await environment.dispatchWindow("hashchange", { type: "hashchange" });
  assert.match(environment.main.innerHTML, /settings-page-v5/u, "the Settings route must render the security controls");
  assert.match(environment.main.innerHTML, /Allowed service networks/u);
  assert.match(environment.main.innerHTML, /name="networkMode" type="radio" value="manual"[^>]*checked/u, "saved CIDRs must reopen in manual mode");
  assert.match(environment.main.innerHTML, /name="allowedCidrs"[^>]*required/u, "manual mode must require its CIDR textarea");
  assert.doesNotMatch(environment.main.innerHTML, /name="allowedCidrs"[^>]*disabled/u, "manual mode must enable its CIDR textarea");
  assert.match(environment.main.innerHTML, /Universal access key/u);
  assert.match(environment.main.innerHTML, /trusted for one year/u);
  assert.match(environment.main.innerHTML, /data-action="rotate-access-key"/u);
  assert.doesNotMatch(environment.main.innerHTML, /Create browser invite|one-time browser invite/iu);
  assert.match(environment.main.innerHTML, /Authorized browsers/u);
  assert.match(environment.main.innerHTML, /data-current-session="true"/u, "the active session must be marked structurally");
  assert.match(environment.main.innerHTML, /Current browser/u, "the active session must have a visible label");
  assert.match(environment.main.innerHTML, /Kitchen &lt;img src=x onerror=&quot;session-xss&quot;&gt;/u);
  assert.match(environment.main.innerHTML, /http:\/\/kitchen\.test\/&quot;&gt;&lt;svg\/onload=session-xss&gt;/u);
  assert.doesNotMatch(environment.main.innerHTML, /<svg\/onload=session-xss>/u, "session metadata must not create elements");

  // Restore the incident's current capability after the authentication-state
  // exercise so report content remains part of the structural fingerprint.
  snapshot.services[1].connectionState = "connected";
  snapshot.services[1].state = "limited";
  snapshot.services[1].checks = [
    { id: "requestcounts", state: "healthy", checkedAt: snapshot.generatedAt },
    { id: "trending", state: "limited", checkedAt: snapshot.generatedAt, reports: serviceReports }
  ];
  const snapshotsBeforeRestore = environment.requestLog.filter(
    ({ path }) => path === "/api/v2/operations/snapshot"
  ).length;
  await environment.intervalCallbacks.at(-1)();
  await waitFor(
    () => environment.requestLog.filter(({ path }) => path === "/api/v2/operations/snapshot").length === snapshotsBeforeRestore + 1,
    "restored report snapshot"
  );
  environment.location.hash = "#/overview";
  await environment.dispatchWindow("hashchange", { type: "hashchange" });

  // The fake DOM does not parse innerHTML, so register the live nodes that the
  // runtime patches between structural renders.
  const assessmentTime = new FakeElement();
  assessmentTime.textContent = "Sep 12, 9:09 PM";
  environment.main.registerSelector(".operations-overall__facts > div:nth-child(3) dd time", assessmentTime);
  const occurrenceEvidence = new FakeElement();
  occurrenceEvidence.textContent = "Observed 7 times";
  const latestFailureTime = new FakeElement();
  latestFailureTime.textContent = "Sep 12, 9:09 PM";
  const incidentRow = new FakeElement();
  incidentRow.registerSelector(".operations-evidence li", occurrenceEvidence);
  incidentRow.registerSelector("footer span:nth-child(2) time", latestFailureTime);
  environment.main.registerSelector(".operations-incidents__list .operations-incident", incidentRow);
  const jellyfinFacts = new FakeElement();
  jellyfinFacts.textContent = "42 ms";
  const seerrFacts = new FakeElement();
  seerrFacts.textContent = "81 ms";
  const jellyfinRow = new FakeElement();
  jellyfinRow.registerSelector(".operations-service__copy em", jellyfinFacts);
  const seerrRow = new FakeElement();
  seerrRow.registerSelector(".operations-service__copy em", seerrFacts);
  environment.main.registerSelector(".operations-services__list .operations-service", jellyfinRow, seerrRow);
  const pendingValue = new FakeElement();
  pendingValue.textContent = "1";
  const downloadingValue = new FakeElement();
  downloadingValue.textContent = "2";
  const stalledValue = new FakeElement();
  stalledValue.textContent = "0";
  environment.main.registerSelector(".operations-workload__metric strong", pendingValue, downloadingValue, stalledValue);

  const writesBeforePoll = environment.main.markupWrites;
  const markupBeforePoll = environment.main.innerHTML;
  snapshot.generatedAt = "2026-09-12T21:10:44.000Z";
  snapshot.services[0].latencyMs = 47;
  snapshot.services[0].checkedAt = "2026-09-12T21:10:44.000Z";
  snapshot.services[0].checks[0].checkedAt = "2026-09-12T21:10:44.000Z";
  snapshot.services[0].metrics = { downloadSpeedBps: 48_000_000 };
  snapshot.incidents.open[0].lastSeen = "2026-09-12T21:10:44.000Z";
  snapshot.incidents.open[0].occurrenceCount = 8;
  snapshot.workload.downloading = 3;
  assert.ok(environment.intervalCallbacks.length, "the shell must schedule background monitoring polls");
  await environment.intervalCallbacks.at(-1)();
  await waitFor(
    () => environment.requestLog.filter(({ path }) => path === "/api/v2/operations/snapshot").length >= 2,
    "background snapshot request"
  );
  assert.equal(environment.main.markupWrites, writesBeforePoll, "volatile monitor data must not replace the main page markup");
  assert.equal(environment.main.innerHTML, markupBeforePoll);
  assert.equal(jellyfinFacts.textContent, "47 ms", "visible service latency must update in place");
  assert.equal(occurrenceEvidence.textContent, "Observed 8 times", "visible incident observations must update in place");
  assert.notEqual(latestFailureTime.textContent, "Sep 12, 9:09 PM", "the visible latest-failure timestamp must update in place");
  assert.equal(latestFailureTime.attributes.get("datetime"), "2026-09-12T21:10:44.000Z");
  assert.notEqual(assessmentTime.textContent, "Sep 12, 9:09 PM", "the visible assessment timestamp must update in place");
  assert.equal(assessmentTime.attributes.get("datetime"), "2026-09-12T21:10:44.000Z");
  assert.equal(downloadingValue.textContent, "3", "visible workload counts must update in place");
  assert.equal(environment.requestLog.filter(({ path }) => path === "/api/v2/sessions").length, 1, "health polling must not refetch or repaint browser sessions");

  const writesBeforeReportChange = environment.main.markupWrites;
  const snapshotsBeforeReportChange = environment.requestLog.filter(
    ({ path }) => path === "/api/v2/operations/snapshot"
  ).length;
  snapshot.services[1].checks[1].reports[0].message = '1337x recovered; another indexer reports <img src=x onerror="changed-report-xss">';
  await environment.intervalCallbacks.at(-1)();
  await waitFor(
    () => environment.requestLog.filter(({ path }) => path === "/api/v2/operations/snapshot").length === snapshotsBeforeReportChange + 1,
    "report-content snapshot request"
  );
  assert.ok(environment.main.markupWrites > writesBeforeReportChange, "changed service report content may trigger one structural repaint");
  assert.match(environment.main.innerHTML, /another indexer reports &lt;img src=x onerror=&quot;changed-report-xss&quot;&gt;/u);
  assert.doesNotMatch(environment.main.innerHTML, /<img src=x onerror="changed-report-xss">/u);

  const actionTarget = (action, data = {}) => {
    const element = { dataset: { action, ...data }, disabled: false, isConnected: true };
    element.closest = () => element;
    return element;
  };
  const refreshTarget = actionTarget("refresh-live");
  await environment.dispatchDocument("click", { target: refreshTarget });
  await waitFor(() => environment.requestLog.some(({ path }) => path === "/api/v2/operations/refresh"), "manual refresh mutation");

  environment.location.hash = "#/settings";
  await environment.dispatchWindow("hashchange", { type: "hashchange" });
  const revokeTarget = actionTarget("revoke-session", { sessionId: otherSessionId });
  await environment.dispatchDocument("click", { target: revokeTarget });
  await waitFor(() => environment.requestLog.some(({ path }) => path === `/api/v2/sessions/${otherSessionId}`), "session revocation mutation");
  assert.doesNotMatch(environment.main.innerHTML, /Kitchen &lt;img/u, "a revoked browser must leave the rendered session list");
  assert.match(environment.main.innerHTML, /Current browser/u, "revoking another browser must preserve the current session");

  const rotateTarget = actionTarget("rotate-access-key");
  const rotationsBeforeConfirmation = environment.requestLog.filter(({ path }) => path === "/api/v2/access/rotate").length;
  environment.confirmResponses.push(false);
  await environment.dispatchDocument("click", { target: rotateTarget });
  assert.equal(
    environment.requestLog.filter(({ path }) => path === "/api/v2/access/rotate").length,
    rotationsBeforeConfirmation,
    "cancelling rotation must not send a request"
  );
  assert.equal(environment.confirmCalls.length, 1, "an already-configured key must require confirmation");
  assert.match(environment.confirmCalls[0], /current key will stop working[\s\S]*every other browser will be signed out/iu);

  environment.confirmResponses.push(true);
  await environment.dispatchDocument("click", { target: rotateTarget });
  await waitFor(() => environment.requestLog.some(({ path }) => path === "/api/v2/access/rotate"), "access-key rotation mutation");
  assert.equal(environment.confirmCalls.length, 2, "approving the confirmation must continue through the same rotation boundary");
  await waitFor(() => environment.main.innerHTML.includes("hm-rotated-"), "rotated access-key reveal");
  assert.match(environment.main.innerHTML, /hm-rotated-&lt;script&gt;rotation-xss&lt;\/script&gt;/u);
  assert.doesNotMatch(environment.main.innerHTML, /<script>rotation-xss<\/script>/u, "a rotated access key must be escaped");
  assert.equal((environment.main.innerHTML.match(/hm-rotated-/gu) || []).length, 1, "the rotated key must appear once");
  assert.equal(environment.requestLog.filter(({ path }) => path === "/api/v2/sessions").length, 2, "rotation must refresh the authorized-browser list");
  assert.match(environment.main.innerHTML, /Rotated Runtime Browser/u, "rotation must display the refreshed current session");
  assert.doesNotMatch(environment.main.innerHTML, /Kitchen &lt;img/u, "rotation must not restore revoked browser sessions");
  assertSecretAbsentFromBrowserStorage(environment, rotatedAccessKey);

  await environment.dispatchDocument("click", { target: actionTarget("copy-access-key") });
  assert.deepEqual(environment.clipboardWrites, [rotatedAccessKey]);
  environment.location.hash = "#/overview";
  await environment.dispatchWindow("hashchange", { type: "hashchange" });
  environment.location.hash = "#/settings";
  await environment.dispatchWindow("hashchange", { type: "hashchange" });
  assert.doesNotMatch(environment.main.innerHTML, /hm-rotated-/u, "the one-time reveal must not return after leaving Settings");

  const mutations = environment.requestLog.filter(({ path }) => [
    "/api/v2/operations/refresh",
    "/api/v2/access/rotate",
    `/api/v2/sessions/${otherSessionId}`
  ].includes(path));
  assert.equal(mutations.length, 3);
  for (const mutation of mutations) {
    assert.equal(mutation.options.credentials, "same-origin", `${mutation.path} must send only same-origin browser credentials`);
    assert.equal(mutation.options.headers.get("X-Jellofin-CSRF"), csrfToken, `${mutation.path} must carry the authenticated CSRF token`);
    assert.equal(mutation.options.method, mutation.path.startsWith("/api/v2/sessions/") ? "DELETE" : "POST");
  }
  const rotation = mutations.find(({ path }) => path === "/api/v2/access/rotate");
  assert.deepEqual(JSON.parse(rotation.options.body), {});
  assert.equal(rotation.options.headers.get("X-Jellofin-CSRF"), csrfToken, "rotation must use the pre-rotation authenticated CSRF token");

  await environment.dispatchDocument("click", { target: actionTarget("logout") });
  const logout = environment.requestLog.find(({ path }) => path === "/api/v2/session");
  assert.equal(logout.options.headers.get("X-Jellofin-CSRF"), rotatedCsrfToken, "the rotated session's CSRF token must replace the previous token");
  assert.match(environment.main.innerHTML, /Unlock Helmsman/u, "signing out after rotation must return to reusable-key login");
}

const failures = [];

for (const [name, contract] of [
  ["setup gate without browser-vault language", setupGateContract],
  ["universal access-key gate", accessKeyGateContract],
  ["access-key recovery gate", accessKeyRecoveryGateContract],
  ["first-time access-key reveal", setupClaimAccessKeyContract],
  ["first access-key creation skips rotation confirmation", firstAccessKeyCreationContract],
  ["reusable access-key login and redaction", accessKeyLoginContract],
  ["exact and manual network policy modes", networkPolicyInteractionContract],
  ["readable empty-state layout", emptyStateLayoutContract],
  ["prioritized and retry-bounded media artwork", mediaArtworkLoadingContract],
  ["truthful media request and calendar semantics", mediaSemanticsContract],
  ["stable service dialog interactions", serviceDialogInteractionContract],
  ["Infrastructure workspace and Proxmox dialog", infrastructureWorkspaceContract],
  ["Infrastructure-only Portainer inventory", portainerInfrastructureContract],
  ["authenticated operations runtime", authenticatedRuntimeContract]
]) {
  try {
    await contract();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(`${name}: ${error.stack || error.message}`);
    console.error(`FAIL ${name}: ${error.message}`);
  }
}

if (failures.length) {
  throw new Error(`Runtime v5 smoke test failed:\n${failures.map((failure) => `  - ${failure}`).join("\n")}`);
}

console.log("Runtime v5 smoke test passed: setup, universal access-key login and rotation, key redaction, network modes, service authentication, Infrastructure and Proxmox workflows, authenticated Overview, routes, stable polling, browser-session revocation, CSRF, same-origin credentials, and escaping.");
