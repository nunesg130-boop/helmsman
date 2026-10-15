# Manual formatting guide

The **Manual** page (Overview workspace, between Launchpad and Logs) shows
your own operations manual, written in Markdown. This guide lists exactly what
the Manual understands. Anything else is shown as plain text.

Helmsman ships with an empty manual. Your manual is stored only in
`manual.json` in your own `/data` volume. It is **not encrypted**, so keep
passwords, API keys, tokens and private keys out of it.

## Getting text in

- **Write it**: choose **Write the manual** (or **Edit**) and type in the editor.
- **Start from a template**: choose **Start from template** for a generic
  skeleton with hosts, network, services, backups, runbooks, known issues and a
  change log, then replace the examples.
- **Import a file**: drop one `.md`, `.markdown` or `.txt` file on the Manual
  page or the editor, or choose **Import file**.

Every route opens the text in the editor as a draft. Nothing is saved until you
choose **Save manual**. A manual can be up to 256 KiB.

## Structure

| Markdown | Result |
|---|---|
| `# Title` | The page title, when it is the first heading before any other text. A later `#` heading starts a section like `##`. |
| `## Heading` | A new section card and an entry in the contents list. |
| `### Heading` / `#### Heading` | A subheading inside the current section. |
| Plain lines of text | A paragraph. Lines next to each other join into one paragraph. |
| A blank line | Separates blocks: paragraphs, lists, tables, callouts and code. |
| `---` | A divider line. |

Text before the first `##` heading appears in an untitled card at the top.

## Tables

```md
| Host | Address | State |
|---|---|---|
| media-node | 10.20.0.10 | Healthy |
| nvr | 10.20.0.42 | Pending — disk recheck |
```

- The header row and the `|---|` divider line are required.
- `:---:` centers a column and `---:` right-aligns it.
- Write `\|` for a literal `|` inside a cell. A `|` inside `` `code` `` is kept.
- Rows with fewer cells than the header are padded with empty cells.
- Every table row is its own search result, so a search for an address, VMID or
  host name lands on its row.

### Status badges

A table cell that is exactly one of the words below becomes a coloured badge.
So does a cell that starts with one of them followed by `—`, `–`, `-`, `·` or
`:` and a detail, such as `Pending — disk recheck`. Matching ignores case.
Text elsewhere in the manual is never turned into a badge.

| Colour | Words |
|---|---|
| Green | healthy, confirmed, confirmed current, resolved, active, running, done, complete, completed, validated, enabled, preserved, restored, writable, controlled, hardened, current, migrated |
| Yellow | pending, pending verification, pending confirmation, limited, degraded, high, open, reconfirm, revalidate, retest, unverified, unconfirmed, unprotected, in progress |
| Red | down, critical, failed, not implemented, blocked, never available |
| Blue | checking, documented, documented state, repository release, medium, explained, release, completed migration |
| Grey | planned, low, rollback, rollback copy, source copy, offline, stopped, retired, legacy, unknown |

## Lists

```md
- A bullet (also `*` or `+`)
- Another bullet
  continued on an indented line

1. A numbered step
2. The next step

- [ ] An open task
- [x] A finished task
```

- Indent a plain line by two or more spaces to continue the item above it.
- Bulleted and numbered items next to each other become separate lists.
- Nested lists are not supported: an indented `-` line becomes another item at
  the same level.

## Callouts

```md
> [!WARNING] Mount check
> Confirm external disks are mounted before starting guests.
```

| Type | Colour |
|---|---|
| `[!NOTE]`, `[!TIP]` | Blue |
| `[!IMPORTANT]` | Green |
| `[!WARNING]` | Yellow |
| `[!CAUTION]` | Red |

- The text after `]` on the first line is the callout's title. Without it, the
  type name is used.
- A plain `>` quote without a type becomes a grey callout.
- A blank `>` line inside a callout starts a new paragraph.

## Inline formatting

| Markdown | Result |
|---|---|
| `` `code` `` | Inline code |
| `**bold**` or `__bold__` | Bold |
| `*italic*` or `_italic_` | Italic |
| `[text](https://example.net)` | A link that opens in a new tab |
| `[text](#manual-hosts)` | A link that scrolls to a section in the manual |

- Only `http://` and `https://` links are made clickable, and never ones that
  contain a user name or password. Other links show their text only.
- Two sections with the same heading get `-2`, `-3` and so on.
- A section's anchor is `manual-` followed by its heading in lower case with
  spaces and punctuation turned into `-`. `## 6. Storage and mounts` becomes
  `#manual-6-storage-and-mounts`. Links that leave out `manual-` also work.

## Code blocks

````md
```bash
docker compose ps
docker compose logs --tail=100
```
````

Fences can use three or more backticks or tildes. The language name after the
fence is allowed but not used for colouring. Code is searchable.

## What is not supported

- Raw HTML, images, footnotes, nested lists and Setext (underlined) headings.
  HTML is shown as text, never run.
- Control characters other than tab and line feed. Windows line endings are
  converted automatically.

## Writing it with an AI assistant

Gather what the assistant needs, with secrets removed: notes on your hosts,
network and services, and output from read-only commands such as `ip -br addr`,
`docker ps`, `pvecm status` or `pvesh get /cluster/resources --type vm`. If you
already have a manual, paste it so the assistant updates it instead of starting
over. Then use this prompt:

> Write a Helmsman operations manual in Markdown following the format guide
> below.
>
> - Start with a `# Title` line, then use `##` headings for sections: Hosts,
>   Network, Services, Storage and backups, Runbooks, Known issues and Change
>   log, plus any others my notes need.
> - Put inventories in tables with a header row and a `|---|` divider.
> - Put the status in its own table column and use only the badge words in the
>   guide, optionally followed by ` — ` and a short detail, for example
>   `Pending — disk recheck`.
> - Use `> [!WARNING]` callouts for things that can cause damage if skipped.
> - Don't use HTML, images, footnotes or nested lists.
> - Never include passwords, API keys, tokens or private keys, even if they
>   appear in what I paste. Tell me where you saw one so I can rotate it.
> - Don't invent addresses, ports or versions. Write `TBD` and list your
>   questions after the manual.
>
> [paste this guide]
> [paste notes, command output and any existing manual]

Paste the result into the editor or save it as a `.md` file and import it,
then check it and choose **Save manual**.

## Search

Press `/` or Ctrl/⌘ K anywhere in Helmsman to search pages, connected services,
Proxmox workloads and the manual together. Manual results cover section
headings, subheadings, paragraphs, list items, callouts, code blocks and
individual table rows. Opening a result scrolls to it and highlights the match.
On the Manual page, **Find in the manual** filters sections as you type.
