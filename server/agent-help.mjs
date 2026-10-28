// Facts about Helmsman itself that the agent can look up like manual lines.

/**
 * Short facts about Helmsman itself, searched together with the owner's
 * manual, so "where are my conversations saved?" has an answer.
 */
export const HELMSMAN_HELP = `# About Helmsman
- Saved conversations: when Keep conversations for training is on (Settings → Agent), each question and answer is saved in Helmsman's data folder under agent-conversations, one file per day, kept 90 days or up to 100 MB.
- Training data: rate answers with the thumbs under each one, or Fix answer to write the right one; download them from Settings → Agent → Training data.
- Approving: requests from the agent run only when the owner presses Approve; typing yes in chat never runs anything.
- Logs: the Logs page shows Helmsman's event log and server output; turn on debug logging for a few hours under Settings → Logging, and download logs with the Download button.
- Refresh: the refresh button at the top checks every service again right away.
- Indexer tests: Prowlarr, Radarr and Sonarr indexers can be tested from each service's dialog; the agent may test Prowlarr indexers itself.
- Stuck downloads: Settings → Automation → Stuck downloads clears stalled, failed and unsafe downloads and searches again.
- Holding alerts: while a Proxmox node restarts or is out of contact, Helmsman holds other alerts for up to 30 minutes and then sends one summary.
- Connections: add or change services under Media → Connections and Infrastructure.
- Helmy: the helper can be hidden with the eye button in its chat or under Settings → Agent → In this browser.`;
