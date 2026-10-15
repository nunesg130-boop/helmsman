// Helpers for tests that read or edit state.json directly.
//
// Since state version 6, state.json keeps media connections in
// `mediaConnections`, keyed by connection id with a `type` field. Versions 1-5
// kept them in `connections`, keyed by service name.

/** Returns the stored media connection of one service, as a live reference. */
export function diskConnection(diskState, service) {
  const matches = Object.values(diskState.mediaConnections || {}).filter((record) => record.type === service);
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one stored ${service} connection, found ${matches.length}.`);
  }
  return matches[0];
}

/** Returns the stored id of one service's media connection. */
export function diskConnectionId(diskState, service) {
  const entry = Object.entries(diskState.mediaConnections || {}).find(([, record]) => record.type === service);
  if (!entry) throw new Error(`No stored ${service} connection.`);
  return entry[0];
}

/**
 * Rewrites a version 6 document's media connections into the pre-version-6
 * layout, for tests that simulate a file written by an older release. The
 * caller sets `version` itself.
 */
export function withLegacyConnections(diskState) {
  const legacy = structuredClone(diskState);
  const connections = {};
  for (const record of Object.values(legacy.mediaConnections || {})) {
    const { type, ...connection } = record;
    connections[type] = connection;
  }
  delete legacy.mediaConnections;
  legacy.connections = connections;
  return legacy;
}
