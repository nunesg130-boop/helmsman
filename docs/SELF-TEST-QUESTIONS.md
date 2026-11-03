# Self-test question files

**Self-test** (Settings → Agent → Training) normally asks the agent questions
it makes from your own inventory. You can also upload a file of your own
questions and run those as a batch instead. The answers show up in the same
review list as generated ones, to rate as **Good** or fix.

Choose **Choose file** under **Upload questions**. Helmsman checks the file and
shows a report before anything runs. Nothing is asked until you press
**Start uploaded batch**.

## The two formats

A file is read by its extension: `.csv` or `.json`. Other files are refused.
Save the file as UTF-8.

### CSV

The first line names the columns. It must include a `question` column and a
`category` column, in any order. Other columns are ignored, and the report
says so.

```csv
question,category
is caddy's backup recent?,backups
"which containers are stopped, if any?",containers
rank guests by memory usage,ranking
which node is frigate on?,follow-up
what about pihole?,follow-up
```

- Put a field in double quotes when it contains a comma or a line break.
- Write a double quote inside a quoted field as two: `"the ""main"" node"`.
- Empty lines are ignored.

### JSON

One object. Each key is a category, and its value is a list of questions as
text.

```json
{
  "backups": ["is caddy's backup recent?", "does frigate have a backup from the last week?"],
  "containers": ["which containers are stopped, if any?"],
  "follow-up": ["which node is frigate on?", "what about pihole?"]
}
```

## Categories

Every question needs one of these categories. A question with no category, or
with any other category, stops the whole file, and the report names each line
or item at fault.

| Category | For questions about |
|---|---|
| `guest-lookup` | One VM or LXC: whether it is running, its node, memory, ID |
| `ranking` | Guests ordered by memory, CPU, uptime or backup age |
| `node` | A Proxmox node itself: memory, CPU, uptime |
| `containers` | One Docker container: host, ports, image, stack |
| `neighbours` | What else runs on the same node or Docker host |
| `backups` | When something was last backed up, and whether that is recent |
| `history` | Past problems and outages Helmsman recorded |
| `manual` | What your manual says |
| `services` | Your media services' current health |
| `follow-up` | Pairs of questions (below) |
| `unknowable` | Things Helmsman cannot know, to check the agent says so |

### Follow-up pairs

Questions in `follow-up` go in pairs, in file order: a question, then the one
asked after it. The second is asked with the first question and the agent's
answer to it as the conversation before it, the way you would ask in chat:

1. `which node is frigate on?`
2. `what about pihole?`

The number of `follow-up` questions must be even. A blank question in a pair
stops the file, because both halves are needed. In a CSV file the pairs are
counted among the `follow-up` rows only, so other rows may sit between them,
but keeping each pair on neighbouring lines is easiest to read.

## Limits

- Up to 1,000 questions per file, after blanks and repeats are skipped.
- The file can be up to 1 MB.
- A question can be up to 1,000 characters. Line breaks inside a question
  become spaces.

## What the report shows

**Errors** stop the file: nothing runs until you fix it and choose it again.

- Not a `.csv` or `.json` file, an empty file, or a file over 1 MB.
- A CSV file without `question` and `category` columns, or with a quote that
  is never closed.
- JSON that is not valid, or not one object of lists.
- A missing or unknown category.
- An odd number of `follow-up` questions, or a blank question in a pair.
- A question over 1,000 characters.
- More than 1,000 questions.

**Warnings** don't stop the file. You can press **Start uploaded batch**
anyway.

- **Blank question, skipped:** a row with a category but no question.
- **The same as …, skipped:** a question exactly like an earlier one in the
  file. A repeated follow-up pair is skipped whole.
- **Possibly the same as …, kept:** a question that differs from an earlier
  one only in capitals, spaces or punctuation, such as `is caddy up?` and
  `Is Caddy up`. It is kept, in case the difference is on purpose.

The report lists up to 50 errors and 50 warnings, then how many more there
are.

## Good to know

- **Keep conversations for training** must be on, as for any Self-test batch.
- Starting an uploaded batch replaces whatever was left of a stopped batch,
  as starting a generated one does.
- Uploaded questions can be asked again in later files. Generated batches
  never repeat a question already asked, and uploaded ones don't change that.
- The review list's **Changed** filter compares answers to the same uploaded
  question across batches, as it does for generated questions.
