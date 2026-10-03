# Weekly Time Log

An Obsidian plugin that turns your [Full Calendar Remastered](https://github.com/YouFoundJK/plugin-full-calendar) time blocks into a weekly time log, matched to your [Tasks](https://github.com/obsidian-tasks-group/obsidian-tasks) and rolled up by tag. It shows charts in Obsidian and exports CSV.

## Install

Copy this folder to `<vault>/.obsidian/plugins/weekly-time-log/`, then enable **Weekly Time Log** under Settings → Community plugins. Requires Full Calendar Remastered (with its plugin API) and works best with Tasks.

On first use, Full Calendar asks you to grant access. *Read events* and *Read providers* are required; *Read settings* is optional (only used for the first day of the week).

## Use

- **Full log**: ribbon clock icon or the command *Open weekly time log*. Week navigation, totals, hours by tag/grouping (expand a group to see its tasks), hours by day, and a table of every block with its label.
- **Labels**: type any task, or one or more tags (`#postdoc #meeting`), in a block's Label field. Suggestions appear as you type, and new tags are created on the spot. A task label brings in that task's tags.
- **Review**: *Review N* button or the command *Review this week's time blocks*. One block at a time: `1`–`9` choose, `Enter` accept the suggestion, `0` not task work, `/` type any task or tag, `S` skip, `←` back.
- **Export**: *Export CSV* writes `Time Logs/Time Log YYYY-MM-DD.csv` (one row per block).
- **In a note**:

  ````
  ```time-log
  show: hours        # full (default) | chart | hours
  group: Role        # a tag grouping, or tag | task | calendar
  week: last         # this | last | 2026-09-28 | 2026-W40 (default: from the note's filename)
  ```
  ````

## Automatic

Whenever a `time-log` block is shown, its week's CSV is saved to the export folder and re-saved each time a label changes (unchanged files aren't rewritten). Once a day (the first time Obsidian is open), last week's CSV is also saved and, if anything is unreviewed, a reminder appears. Reviewing re-saves the CSV. Both can be turned off in settings. The background check never opens the access dialog and never saves an empty week.

## How blocks are matched

Heuristic, no trained model. Each block is scored against open tasks (plus tasks completed during or after that week) using:

- word overlap between the block title and the task (rare words weigh more)
- the task's tags: `#tag` written in the event, title words matching the tag, or your past labels
- your confirmed labels for similar block titles
- whether the task is scheduled that day / that week

Anything that isn't confirmed is shown as *suggested* and goes into the review queue. Confirmed labels are stored in `data.json` and drive future suggestions.

## Tag groupings

Settings → *Tag groupings*, one per line. Each becomes a chart view and a CSV column:

```
Project: uist2026, chi2026, phd
Role: postdoc (uist2026, chi2026), faculty (teaching), student (phd)
```

Tags in parentheses also count toward that value, and nested tags (`#phd/thesis`) match their parent. Within one grouping each block counts once, so hours add up to the week's total.

The plain **Tag** view counts a block under every tag it has, so its column can add up to more than the week's total. Totals, groupings and the CSV (one row per block) never double count.

## Files

| File | |
|---|---|
| `main.js` | All plugin code. Plain CommonJS, no build step. |
| `styles.css` | Styles; uses Obsidian theme variables. |
| `manifest.json` | Plugin metadata. |
| `data.json` | Created at runtime: only this install's Full Calendar token and last background check. Not committed. |

## Where your data lives

Labels and settings are stored **in the vault**, at `Time Logs/time-log-data.json` (configurable under *Data file*), not in the plugin folder. Replacing, reinstalling or upgrading the plugin keeps them, and they sync and back up with the vault. It's one file for all weeks, since suggestions learn from every label at once. Weekly CSVs are written next to it, one per week.

If that file can't be parsed, the plugin shows a notice and never overwrites it.
