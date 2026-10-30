# Weekly Time Log

An Obsidian plugin that turns your [Full Calendar Remastered](https://github.com/YouFoundJK/plugin-full-calendar) time blocks into a weekly time log, matched to your [Tasks](https://github.com/obsidian-tasks-group/obsidian-tasks) and rolled up by tag. It shows charts in Obsidian and exports CSV.

## Install

Copy this folder to `<vault>/.obsidian/plugins/weekly-time-log/`, then enable **Weekly Time Log** under Settings → Community plugins. Requires Full Calendar Remastered (with its plugin API) and works best with Tasks.

On first use, Full Calendar asks you to grant access. *Read events* and *Read providers* are required; *Read settings* is optional (only used for the first day of the week).

## Use

- **Full log**: ribbon clock icon or the command *Open weekly time log*. Week navigation, totals, hours by tag/grouping (expand a group to see its tasks), hours by day, and a table of every block with its label.
- **Labels**: in a block's Label field, pick any mix of tasks and tags; each becomes a chip. Enter on an empty field ("Use: …") saves, Backspace removes the last chip. New tags are created on the spot. Tasks bring in their tags; a block with several tasks splits its hours between them in the Task view and counts once in groupings.
- **Review**: *Review N* button or the command *Review this week's time blocks*. One block at a time: `1`–`9` choose, `Enter` accept the suggestion, `0` not task work, `/` type any task or tag, `S` skip, `←` back.
- **Export**: *Export CSV* writes `Time Logs/Time Log YYYY-MM-DD.csv` (one row per block).
- **In a note**:

  ````
  ```time-log
  show: hours        # full (default) | chart | hours | days | timeline | agenda | upcoming | tracker
  from: today        # agenda only: hide days before today
  group: Role        # what daily charts and the summary line split by (default: area); none = plain
  detail: Role       # grouping for the folded breakdown in show: full (default: the full log's choice)
  buttons: false     # hide Review / Export CSV / Open full log (shown under every layout by default)
  week: last         # this | last | 2026-09-28 | 2026-W40 (default: from the note's filename)
  ```
  ````

## Coming up and planning

A sidebar panel (calendar-clock ribbon icon, or *Open coming up*; it opens by itself the first time) so what's ahead stays in view:

- **Grid** of the next weeks (*Weeks ahead*, default 6), each day shaded by how many tasks are planned for it. Hover a day to see them; click it to list only that day.
- **One line per task**, in sections: Needs a plan, Late, Today, Tomorrow, This week, Before meetings, Next week, Later, Not scheduled (folded). A task's day is its ⏳ scheduled date, else its 📅 due date. Tags show as a coloured dot. Tick the box to finish a task (through Tasks, so recurring tasks recur), or use ⏩ to move it to another day. **Click** a task for its details under it: scheduled and due dates (and how far off they are), tags, hours logged and booked with every block behind them, which note it's in, a search to add blocks to it, and buttons to edit, open, schedule, move, finish or mute it. In the details, click a block to see it in Full Calendar (it opens at that day and time, and the block flashes), and ✕ one that isn't for this task: it stops counting, and that task is never guessed for that block again (in the time log too). **Double-click** a task to edit it in the Tasks plugin's own dialog.
- **Hours** next to each task come from your calendar: `2h` logged is the Full Calendar events in the last 8 weeks that the log matched to the task, and `+1h` booked is the ones still ahead, up to its day (plus the task itself, if you gave it a time). Matches are either confirmed (you labelled the block in the weekly review) or guesses from the event's title and tags. Click a task to see every block behind its numbers, with guesses marked; ✕ a wrong one.
- **Before meetings**: calendar events in the next week, with the open actions from earlier meetings with the same people (from Meeting Log, if it's enabled).
- **Status bar**: `2 to plan · 1 late · 3 today`; click it to open the panel. `show: upcoming` puts the same panel in a note.

Tasks tagged with anything under *Leave out tags* (default `#papers_unread`), and tasks in your templates folder, aren't shown.

**Booking time: drag a task onto Full Calendar.** Open the calendar beside the panel (the calendar-plus icon on a task, or *Schedule…* in its details, opens it), go to any week, and drag a task from Coming up:

- onto **empty time**: books a block for it (1 hour by default, under *Block length*) on your "Planned" calendar (or the one under *Book blocks on*), titled like the task. Stretch it in Full Calendar to change its length; drop the task again for more sessions. The first time, Full Calendar asks for *Write events* access.
- onto **a block you already have** (a "Deep work", or a past event): that block now counts for the task, and nothing new is made.
- onto **a day** (the all-day row, or month view): moves the task's ⏳ date there.

A label by the cursor says which it will be.

If dragging isn't handy, **click the task** and search under *Add a block*: any block from the last 8 weeks or coming up can be added (*now: …* says if it's counted for another task; adding it moves it). Blocks also count by themselves when their title shares words or tags with the task, and so does a time on the task's own line (Full Calendar writes one if you drag the task's own box into a time slot, e.g. `10:00 - 11:30 Write intro ⏳ 2026-11-02`).

**Needs a plan**: any task scheduled (⏳) or due (📅) in the next two weeks, or overdue, with nothing booked for it. These are listed first in red, counted in the status bar, and once a day a notice lists them. Big or small isn't asked up front. For small ones, the bell-off icon says *no plan needed* and the task stops being flagged (undo under Settings → *No plan needed*). Booking time also clears it. For fewer flags, Settings → *What needs a plan* → *Only 📅 deadlines* flags just deadlines, plus tasks you've already logged time on.

## Automatic

Whenever a `time-log` block is shown, its week's CSV is saved to the export folder and re-saved each time a label changes (unchanged files aren't rewritten). Once a day (the first time Obsidian is open), last week's CSV is also saved and, if anything is unreviewed, a reminder appears. Reviewing re-saves the CSV. Both can be turned off in settings. The background check never opens the access dialog and never saves an empty week.

## aTimeLogger and the Tracker

For time that never goes on the calendar (eating, hygiene, exercise, non-work):

- **aTimeLogger:** keep tracking on the phone. Export CSV and put it in `Time Logs/aTimeLogger/` (or set a full path on the Mac, e.g. an iCloud Drive folder, under *aTimeLogger exports*). Every CSV there is read; overlapping exports are de-duplicated; replacing a file updates the log. Settings shows what was read and which aTimeLogger types still need an area.
- **Tracker panel (Mac):** big activity buttons, running timer, today's entries, *+ Add past entry*; `Track: <activity>` commands; `show: tracker` block.

Settings → *Activities* maps names to areas, one per line (`Eating: Meals`, `Sleep: Rest`). Tracked and imported time goes straight into the log with its area, never needs review, and wins over any calendar block it overlaps, so nothing is counted twice.

## Which calendars count

Every Full Calendar calendar is included except its Tasks calendar; switch any off under Settings → *Calendars to log*. Calendars you add later are included automatically. If anything in the week doesn't become a block (a calendar you switched off, all-day events, a repeat pattern the plugin can't follow), the log says "N calendar events not shown — why?" with the details per calendar.

Repeating events: daily, weekly (including every N weeks, several days), monthly (by date, "2nd Tuesday", "last Friday") and yearly patterns are supported.

## How blocks are matched

Heuristic, no trained model. Each block is scored against open tasks (plus tasks completed during or after that week) using:

- word overlap between the block title and the task (rare words weigh more)
- the task's tags: `#tag` written in the event, title words matching the tag, or your past labels
- your confirmed labels for similar block titles
- whether the task is scheduled that day / that week

Anything that isn't confirmed is shown as *suggested* and goes into the review queue. Confirmed labels are stored in `data.json` and drive future suggestions.

## Areas

Every block also gets an **area**: a broad category for all your time (Work, Meals, Exercise, Personal, Social, Rest by default). Areas aren't tags. They're predicted from the block's title ("lunch", "gym"), its tags, similar blocks you sorted before, and a default for task work, and you confirm or change them in review (area buttons) or in the blocks table (Area column). Daily charts and the timeline are coloured by area, so they stay readable and add up to all the hours you logged, meals and exercise included.

Review covers areas too: blocks whose area isn't confirmed come up even if their label is (option 1 keeps the label), and Shift+1…8 picks an area. The timeline shows each area's hours, with a ▸ Breakdown toggle to split the week by area, grouping, tag, task or calendar.

Edit them under Settings → *Areas*, one per line: `Work: meeting, writing, #postdoc, #faculty`. Plain words match block titles; `#tags` count any block carrying that tag. Up to 8; the order sets the colours.

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
