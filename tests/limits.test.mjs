import assert from "node:assert/strict";
import test from "node:test";
import {
  CREDENTIAL_NAMESPACE_BUDGET,
  DEFAULT_LIMITS,
  LimitConfigurationError,
  MEDIA_CONNECTION_RESERVE,
  STORED_LIMIT_CEILINGS,
  resolveLimits
} from "../server/limits.mjs";
import { buildProbePlan } from "../server/service-probes.mjs";

test("limits default to the values Helmsman has always used", () => {
  assert.deepEqual(resolveLimits({}), {
    proxmoxEnvironments: 25,
    proxmoxEndpoints: 25,
    endpointsPerEnvironment: 4,
    infrastructureServices: 8,
    calendarPastDays: 1,
    calendarFutureDays: 35
  });
  assert.deepEqual(resolveLimits({}), DEFAULT_LIMITS);
  assert.deepEqual(resolveLimits({ HELMSMAN_MAX_PROXMOX_ENVIRONMENTS: "  " }), DEFAULT_LIMITS);
});

test("limits read bounded whole numbers from the environment", () => {
  const limits = resolveLimits({
    HELMSMAN_MAX_PROXMOX_ENVIRONMENTS: "40",
    HELMSMAN_MAX_PROXMOX_ENDPOINTS: "30",
    HELMSMAN_MAX_ENDPOINTS_PER_ENVIRONMENT: "8",
    HELMSMAN_MAX_INFRASTRUCTURE_SERVICES: "10",
    HELMSMAN_CALENDAR_PAST_DAYS: "0",
    HELMSMAN_CALENDAR_FUTURE_DAYS: "90"
  });
  assert.equal(limits.proxmoxEnvironments, 40);
  assert.equal(limits.proxmoxEndpoints, 30);
  assert.equal(limits.endpointsPerEnvironment, 8);
  assert.equal(limits.infrastructureServices, 10);
  assert.equal(limits.calendarPastDays, 0);
  assert.equal(limits.calendarFutureDays, 90);
  assert.equal(Object.isFrozen(limits), true);
});

test("limits reject malformed and out-of-range values with the variable name", () => {
  for (const [name, value] of [
    ["HELMSMAN_MAX_PROXMOX_ENVIRONMENTS", "0"],
    ["HELMSMAN_MAX_PROXMOX_ENVIRONMENTS", "41"],
    ["HELMSMAN_MAX_PROXMOX_ENDPOINTS", "-1"],
    ["HELMSMAN_MAX_ENDPOINTS_PER_ENVIRONMENT", "9"],
    ["HELMSMAN_MAX_INFRASTRUCTURE_SERVICES", "2.5"],
    ["HELMSMAN_CALENDAR_PAST_DAYS", "15"],
    ["HELMSMAN_CALENDAR_FUTURE_DAYS", "6"],
    ["HELMSMAN_CALENDAR_FUTURE_DAYS", "1e2"],
    ["HELMSMAN_CALENDAR_FUTURE_DAYS", "ninety"]
  ]) {
    assert.throws(
      () => resolveLimits({ [name]: value }),
      (error) => error instanceof LimitConfigurationError && error.message.startsWith(name),
      `${name}=${value}`
    );
  }
});

test("credential-bearing limits stay inside the encrypted store budget", () => {
  const available = CREDENTIAL_NAMESPACE_BUDGET - MEDIA_CONNECTION_RESERVE;
  assert.equal(DEFAULT_LIMITS.proxmoxEndpoints + DEFAULT_LIMITS.infrastructureServices <= available, true);
  assert.throws(
    () => resolveLimits({ HELMSMAN_MAX_PROXMOX_ENDPOINTS: "40", HELMSMAN_MAX_INFRASTRUCTURE_SERVICES: "8" }),
    /together they may be at most 40/u
  );
  assert.doesNotThrow(() => resolveLimits({ HELMSMAN_MAX_PROXMOX_ENDPOINTS: "32", HELMSMAN_MAX_INFRASTRUCTURE_SERVICES: "8" }));
  // Two staged copies of every credential plus 64 browser sessions must fit
  // the store's 192-namespace ceiling.
  assert.equal(CREDENTIAL_NAMESPACE_BUDGET * 2 + 64 <= 192, true);
});

test("endpoints per environment cannot exceed the endpoint total", () => {
  assert.throws(
    () => resolveLimits({ HELMSMAN_MAX_PROXMOX_ENDPOINTS: "4", HELMSMAN_MAX_ENDPOINTS_PER_ENVIRONMENT: "6" }),
    /cannot be larger than HELMSMAN_MAX_PROXMOX_ENDPOINTS/u
  );
});

test("stored ceilings are never below the defaults", () => {
  for (const [key, value] of Object.entries(DEFAULT_LIMITS)) {
    assert.equal(STORED_LIMIT_CEILINGS[key] >= value, true, key);
  }
  assert.equal(STORED_LIMIT_CEILINGS.mediaConnections, MEDIA_CONNECTION_RESERVE);
});

test("the calendar window follows the configured limits", () => {
  const checkedAt = Date.parse("2026-03-10T15:00:00.000Z");
  const calendarPath = (plan) => plan.find((entry) => entry.id === "calendar")?.path;
  const standard = calendarPath(buildProbePlan("radarr", { checkedAt }));
  assert.equal(standard, "/api/v3/calendar?start=2026-03-09&end=2026-04-14");
  const widened = calendarPath(buildProbePlan("sonarr", {
    checkedAt,
    limits: { ...DEFAULT_LIMITS, calendarPastDays: 7, calendarFutureDays: 60 }
  }));
  assert.equal(widened, "/api/v3/calendar?start=2026-03-03&end=2026-05-09&includeSeries=true");
});
