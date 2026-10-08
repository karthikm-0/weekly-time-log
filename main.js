'use strict';

const {
  Plugin, ItemView, Modal, AbstractInputSuggest, MarkdownRenderChild, Notice, PluginSettingTab, Setting, moment,
  normalizePath, prepareFuzzySearch, getAllTags, TFile,
} = require('obsidian');

const VIEW_TYPE = 'weekly-time-log-view';
const FC_ID = 'full-calendar-remastered';

// Storage is split so a plugin reinstall/upgrade never loses your labels:
//  - vault file (dataFile): labels and preferences; syncs and backs up with the vault
//  - plugin data.json: only what belongs to this install
const DEFAULT_DATA_FILE = 'Time Logs/time-log-data.json';
const LOCAL_KEYS = ['token', 'lastCheck', 'dataFile'];

const DEFAULTS = {
  token: null,           // Full Calendar API token
  calendarIds: null,     // null = every calendar source except Tasks
  weekStart: 'calendar', // 'calendar' | '0' (Sun) | '1' (Mon)
  exportFolder: 'Time Logs',
  // One grouping per line, e.g. "Role: postdoc (uist2026, chi2026), faculty"
  tagGroups: '',
  // Broad life areas, predicted for every block (not tags). One per line:
  // "Area: hint words, #tags". Order sets the chart colours.
  areas: [
    'Work: meeting, sync, writing, email, review, lecture, grading, research',
    'Meals: lunch, dinner, breakfast, brunch, coffee, eat',
    'Exercise: gym, run, workout, yoga, walk, swim, climb, bike',
    'Personal: errands, groceries, doctor, appointment, family, chores',
    'Social: drinks, party, friends, hangout',
    'Rest: nap, break, rest',
  ].join('\n'),
  defaultTaskArea: 'Work', // area for blocks attached to a task when nothing else says otherwise
  areaLabels: {},          // blockKey -> { area, title, tags }: confirmed areas, also training data
  view: null,            // last grouping picked in the full log
  minScore: 0.55,
  autoExport: true,      // save last week's CSV daily, and re-save after reviewing
  remind: true,          // nudge while last week has unreviewed blocks
  useTagColors: true,    // reuse colours tags already have (Colored Tags, snippets)
  lastCheck: null,       // ISO date of the last background check
  dataFile: DEFAULT_DATA_FILE,
  // blockKey -> { kind: 'task'|'tag'|'mix'|'none', task, taskDesc, taskPath, tasks, extraTags, tags, title, date }
  // Every confirmed label; also the training data for future suggestions.
  annotations: {},
};

const TAG_ONLY_MIN = 0.6;   // tag confidence needed to suggest "tag only"
const NONE_MIN = 0.6;       // share of similar past blocks marked "not task work"
const HISTORY_SIM_MIN = 0.6; // title similarity for a past label to count

// ---------------------------------------------------------------------------
// Tasks parsing

const TASK_LINE = /^\s*(?:[-*+]|\d+[.)])\s+\[(.)\]\s+(.*)$/;
const SIGNIFIER = /[⏳📅🛫✅➕❌🔁🆔⛔🏁🔺⏫🔼🔽⏬]/u;
const TAG = /(^|\s)#([\p{L}\p{N}_/-]+)/gu;
const DAY_PLANNER_TIME = /^\d{1,2}:\d{2}\s*(?:-\s*\d{1,2}:\d{2}\s*)?/;

function dateAfter(text, emoji) {
  const m = text.match(new RegExp(emoji + '\\uFE0F?\\s*(\\d{4}-\\d{2}-\\d{2})', 'u'));
  return m ? m[1] : null;
}

function findTags(text) {
  const out = [];
  for (const t of (text || '').matchAll(TAG)) out.push(t[2]);
  return out;
}

function parseTask(line, path, lineNo) {
  const m = line.match(TASK_LINE);
  if (!m) return null;
  const status = m[1];
  const body = m[2];
  if (status === '-') return null; // cancelled
  const cut = body.search(SIGNIFIER);
  const desc = (cut >= 0 ? body.slice(0, cut) : body)
    .replace(TAG, ' ')
    .replace(DAY_PLANNER_TIME, '')
    .replace(/\s+/g, ' ')
    .trim();
  return {
    key: `${path}::${desc}`,
    path,
    line: lineNo,
    desc,
    tags: findTags(body),
    done: status === 'x' || status === 'X',
    scheduled: dateAfter(body, '⏳'),
    due: dateAfter(body, '📅'),
    doneDate: dateAfter(body, '✅'),
  };
}

// ---------------------------------------------------------------------------
// Text matching

const STOP = new Set(('a an and the of to for in on at by with from into my our your is are be this that it as or vs via ' +
  're task tasks todo work on').split(' '));

function tokens(s) {
  return (s || '').toLowerCase().replace(/[_\-/#]/g, ' ')
    .split(/[^\p{L}\p{N}]+/u).filter(t => t.length > 1 && !STOP.has(t));
}

function uniqTokens(s) {
  return [...new Set(tokens(s))];
}

function norm(s) {
  return tokens(s).join(' ');
}

function sameWord(a, b) {
  if (a === b) return true;
  const min = Math.min(a.length, b.length);
  if (min < 4) return false;
  let i = 0;
  while (i < min && a[i] === b[i]) i++;
  return i >= 4 && i >= 0.75 * min; // write/writing, paper/papers
}

/** Dice similarity on token sets, tolerant of word endings. */
function similarity(a, b) {
  if (!a.length || !b.length) return 0;
  const ha = a.filter(w => b.some(x => sameWord(w, x))).length;
  const hb = b.filter(w => a.some(x => sameWord(w, x))).length;
  return (ha + hb) / (a.length + b.length);
}

function bump(map, key, by) {
  map.set(key, (map.get(key) || 0) + by);
}

function topEntry(map) {
  let best = null;
  for (const [k, v] of map) if (!best || v > best[1]) best = [k, v];
  return best;
}

// ---------------------------------------------------------------------------
// Recurrence expansion (enough for typical calendar blocks)

const WEEKDAY_RRULE = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const WEEKDAY_FC = { U: 0, M: 1, T: 2, W: 3, R: 4, F: 5, S: 6 };

function parseRRule(str) {
  const line = (str || '').split(/\r?\n/).find(l => /FREQ=/.test(l)) || '';
  const parts = {};
  for (const p of line.replace(/^RRULE:/, '').split(';')) {
    const [k, v] = p.split('=');
    if (k && v) parts[k.toUpperCase()] = v;
  }
  return {
    freq: parts.FREQ,
    interval: parseInt(parts.INTERVAL || '1', 10) || 1,
    byDay: parts.BYDAY ? parts.BYDAY.split(',').map(d => WEEKDAY_RRULE[d.slice(-2)]).filter(d => d !== undefined) : null,
    until: parts.UNTIL ? moment(parts.UNTIL.slice(0, 8), 'YYYYMMDD').format('YYYY-MM-DD') : null,
    count: parts.COUNT ? parseInt(parts.COUNT, 10) : null,
  };
}

/** Returns ISO dates in [from, to) on which the rule fires. */
function expandDates(rule, startDate, from, to) {
  if (!startDate || !rule.freq) return [];
  const start = moment(startDate, 'YYYY-MM-DD');
  const out = [];
  let n = 0;
  const startWeek = start.clone().startOf('isoWeek');
  for (let d = start.clone(); d.isBefore(to) && n < 5000; d.add(1, 'day')) {
    const iso = d.format('YYYY-MM-DD');
    if (rule.until && iso > rule.until) break;
    let hit = false;
    if (rule.freq === 'DAILY') {
      hit = d.diff(start, 'days') % rule.interval === 0;
    } else if (rule.freq === 'WEEKLY') {
      const days = rule.byDay && rule.byDay.length ? rule.byDay : [start.day()];
      const weeks = Math.round(d.clone().startOf('isoWeek').diff(startWeek, 'days') / 7);
      hit = days.includes(d.day()) && weeks % rule.interval === 0;
    } else if (rule.freq === 'MONTHLY' && !rule.byDay) {
      hit = d.date() === start.date() && d.diff(start, 'months') % rule.interval === 0;
    } else if (rule.freq === 'YEARLY') {
      hit = d.date() === start.date() && d.month() === start.month();
    }
    if (!hit) continue;
    n++;
    if (rule.count && n > rule.count) break;
    if (!d.isBefore(from)) out.push(iso);
  }
  return out;
}

function fcRecurringToRule(ev) {
  if (ev.fcrDaily) return { freq: 'DAILY', interval: ev.repeatInterval || 1, until: ev.endRecur || null };
  if (ev.daysOfWeek && ev.daysOfWeek.length) {
    return {
      freq: 'WEEKLY',
      interval: ev.repeatInterval || 1,
      byDay: ev.daysOfWeek.map(d => (typeof d === 'number' ? d : WEEKDAY_FC[d])),
      until: ev.endRecur || null,
    };
  }
  return { freq: null };
}

function atTime(date, time) {
  return moment(`${date} ${time}`, ['YYYY-MM-DD HH:mm', 'YYYY-MM-DD H:mm', 'YYYY-MM-DD hh:mm a', 'YYYY-MM-DD h:mm a']);
}

// ---------------------------------------------------------------------------

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function fmtHours(h) {
  return h >= 10 ? h.toFixed(0) : h.toFixed(1).replace(/\.0$/, '');
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** Stable string for a choice, used as <select> value. */
function choiceValue(c) {
  if (!c) return '';
  if (c.kind === 'task') return `task:${c.task.key}`;
  if (c.kind === 'tag') return `tag:${c.tags.join(' ')}`;
  if (c.kind === 'mix') return `mix:${c.tasks.map(t => t.key).join('|')}#${c.tags.join(' ')}`;
  return 'none';
}

/** Tasks and tags in a label, whatever its kind. */
function choiceParts(c) {
  if (!c || c.kind === 'none') return { tasks: [], tags: [] };
  if (c.kind === 'task') return { tasks: [c.task], tags: [] };
  if (c.kind === 'tag') return { tasks: [], tags: c.tags };
  return { tasks: c.tasks, tags: c.tags };
}

/** The simplest label for a set of tasks and tags: one task, tags only, or a mix. */
function makeChoice(tasks, tags) {
  if (!tasks.length && !tags.length) return null;
  if (tasks.length === 1 && !tags.length) return { kind: 'task', task: tasks[0] };
  if (!tasks.length) return { kind: 'tag', tags };
  return { kind: 'mix', tasks, tags };
}

function hashes(tags) {
  return tags.map(t => '#' + t).join(' ');
}

function choiceLabel(c) {
  if (!c) return 'Unattached';
  if (c.kind === 'task') return c.task.desc;
  if (c.kind === 'tag') return `${hashes(c.tags)} (${c.tags.length > 1 ? 'tags' : 'tag'} only)`;
  if (c.kind === 'mix') return [...c.tasks.map(t => t.desc), ...c.tags.map(t => '#' + t)].join(' + ');
  return 'Not task work';
}

// ---------------------------------------------------------------------------
// Tag groups: user-defined ways to roll tags up ("Project", "Role", ...)
//
//   Project: uist2026, chi2026, phd
//   Role: postdoc (uist2026, chi2026), faculty (teaching)
//
// A value matches its own tag or any listed in parentheses; nested tags
// (#phd/thesis) match their parent. Within one group a block counts once.

function splitTopLevel(text) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of text) {
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out.map(x => x.trim()).filter(Boolean);
}

function parseTagGroups(text) {
  const groups = [];
  for (const line of (text || '').split('\n')) {
    const i = line.indexOf(':');
    if (i < 1) continue;
    const name = line.slice(0, i).trim();
    const values = splitTopLevel(line.slice(i + 1)).map(part => {
      const m = part.match(/^#?([^\s(]+)\s*(?:\((.*)\))?$/);
      if (!m) return null;
      const extra = (m[2] || '').split(/[\s,]+/).map(x => x.replace(/^#/, '')).filter(Boolean);
      return { name: m[1], aliases: [m[1], ...extra].map(x => x.toLowerCase()) };
    }).filter(Boolean);
    if (name && values.length) groups.push({ name, values });
  }
  return groups;
}

function tagValue(tags, group) {
  const lower = tags.map(t => t.toLowerCase());
  for (const v of group.values) {
    if (lower.some(t => v.aliases.some(a => t === a || t.startsWith(a + '/')))) return v.name;
  }
  return null;
}

/** "Work: meeting, writing, #postdoc" -> { name, words, tags }, at most 8 (one colour each). */
function parseAreas(text) {
  const out = [];
  for (const line of (text || '').split('\n')) {
    const i = line.indexOf(':');
    const name = (i < 0 ? line : line.slice(0, i)).trim();
    if (!name || out.some(a => a.name.toLowerCase() === name.toLowerCase())) continue;
    const parts = i < 0 ? [] : line.slice(i + 1).split(',').map(x => x.trim()).filter(Boolean);
    out.push({
      name,
      tags: parts.filter(x => x.startsWith('#')).map(x => x.slice(1).toLowerCase()),
      words: [...new Set(parts.filter(x => !x.startsWith('#')).flatMap(tokens))],
    });
  }
  return out.slice(0, 8);
}

/** The ways the charts can be grouped: Area, each tag group, then Tag, Task, Calendar. */
function dimensions(settings) {
  return [
    { id: 'area', label: 'Area' },
    ...parseTagGroups(settings.tagGroups).map(g => ({ id: `group:${g.name}`, label: g.name, group: g })),
    { id: 'tag', label: 'Tag' },
    { id: 'task', label: 'Task' },
    { id: 'calendar', label: 'Calendar' },
  ];
}

function findDimension(settings, ref) {
  const dims = dimensions(settings);
  const r = (ref || '').toLowerCase();
  return dims.find(d => d.id.toLowerCase() === r || d.label.toLowerCase() === r) || dims[0];
}

/** What a block counts toward in the Task view; several tasks split its hours evenly. */
function taskLeaves(b) {
  if (b.tasks && b.tasks.length) return b.tasks.map(t => ({ key: t.key, label: t.desc, task: t, share: 1 / b.tasks.length }));
  if (b.choice && b.choice.kind === 'tag') {
    return [{ key: choiceValue(b.choice), label: `${hashes(b.choice.tags)} (no specific task)`, muted: true, share: 1 }];
  }
  return [{ key: b.choice ? '~none' : '~open', label: b.choice ? 'Not task work' : 'Unattached', muted: true, share: 1 }];
}

/** Rows of { label, hours, n, unconfirmed, muted, children } for one dimension. */
function buildTree(blocks, dim) {
  const top = new Map();
  const add = (map, g0, b, h) => {
    if (!map.has(g0.key)) map.set(g0.key, { ...g0, hours: 0, n: 0, unconfirmed: 0, kids: new Map() });
    const g = map.get(g0.key);
    g.hours += h;
    g.n++;
    if (b.status !== 'confirmed') g.unconfirmed += h;
    return g;
  };
  const addWithTasks = (g0, b, h) => {
    const g = add(top, g0, b, h);
    for (const leaf of taskLeaves(b)) add(g.kids, leaf, b, h * leaf.share);
  };
  for (const b of blocks) {
    if (dim.id === 'task') {
      for (const leaf of taskLeaves(b)) add(top, leaf, b, b.hours * leaf.share);
      continue;
    }
    if (dim.id === 'tag') {
      // Each tag gets the block's full hours, so this view can sum past the total.
      const tags = b.tags.length ? [...new Set(b.tags)] : [null];
      for (const tg of tags) {
        addWithTasks(tg ? { key: tg, label: `#${tg}` } : { key: '~', label: 'Untagged', muted: true }, b, b.hours);
      }
      continue;
    }
    let g0;
    if (dim.id === 'area') {
      g0 = b.area ? { key: b.area, label: b.area } : { key: '~', label: 'Unsorted', muted: true };
    } else if (dim.id === 'calendar') {
      g0 = { key: b.calendarId, label: b.calendar };
    } else {
      const v = tagValue(b.tags, dim.group);
      g0 = v ? { key: v, label: v } : { key: '~', label: `No ${dim.label.toLowerCase()}`, muted: true };
    }
    addWithTasks(g0, b, b.hours);
  }
  const order = (a, b) => (a.muted ? 1 : 0) - (b.muted ? 1 : 0) || b.hours - a.hours;
  return [...top.values()].sort(order).map(r => ({ ...r, children: [...r.kids.values()].sort(order) }));
}

/**
 * Horizontal bars with expandable children. Child bars share the parent scale,
 * so a task's bar shows its share of the group.
 */
function renderTree(container, rows, { isOpen, toggle, tip, openTask, color = null }) {
  const max = Math.max(...rows.map(r => r.hours), 0.0001);
  const list = container.createDiv({ cls: 'wtl-hbars' });
  const bar = (row, r, cls) => {
    const label = row.createDiv({ cls: 'wtl-hbar-label' });
    label.createSpan({ text: r.label });
    if (r.task && !r.task.ghost && openTask) {
      label.addClass('is-link');
      label.onclick = e => { e.stopPropagation(); openTask(r.task); };
    }
    const fill = row.createDiv({ cls: 'wtl-hbar-track' }).createDiv({ cls: `wtl-hbar ${cls}${r.muted ? ' is-muted' : ''}` });
    fill.style.width = `${(r.hours / max) * 100}%`;
    if (color && cls === '' && !r.muted && hasColor(color, r.key)) paint(fill, color, r.key);
    row.createDiv({ cls: 'wtl-hbar-value', text: `${fmtHours1(r.hours)} h` });
    const pend = r.unconfirmed ? `\n${r.unconfirmed.toFixed(2)} h not yet confirmed` : '';
    tip(row, `${r.label}\n${r.hours.toFixed(2)} h · ${plural(r.n, 'block')}${pend}`);
    return label;
  };
  for (const r of rows) {
    const row = list.createDiv({ cls: 'wtl-hbar-row' });
    const kids = r.children || [];
    if (!kids.length) {
      row.createSpan({ cls: 'wtl-caret is-empty' });
      bar(row, r, '');
      continue;
    }
    row.addClass('is-group');
    const caret = row.createSpan({ cls: 'wtl-caret', text: '▸' });
    bar(row, r, '');
    const box = list.createDiv({ cls: 'wtl-tree-children' });
    for (const c of kids) {
      const crow = box.createDiv({ cls: 'wtl-hbar-row is-child' });
      crow.createSpan({ cls: 'wtl-caret is-empty' });
      bar(crow, c, 'is-child');
    }
    const sync = () => {
      const open = isOpen(r.key);
      box.toggleClass('is-open', open);
      caret.toggleClass('is-open', open);
      row.setAttr('aria-expanded', String(open));
    };
    row.onclick = () => { toggle(r.key); sync(); };
    sync();
  }
}

// ---------------------------------------------------------------------------
// Daily views: columns (how much) and timeline (when)

const sumHours = bs => bs.reduce((a, b) => a + b.hours, 0);
/** A block is reviewed once both its label and its area are confirmed. */
const needsReview = b => b.status !== 'confirmed' || b.areaStatus !== 'confirmed';
const isOther = b => !!(b.choice && b.choice.kind === 'none'); // "Not task work"

function dayRows(report) {
  const days = [];
  for (let d = report.start.clone(); d.isBefore(report.end); d.add(1, 'day')) {
    const iso = d.format('YYYY-MM-DD');
    const blocks = report.blocks.filter(b => b.date === iso);
    const other = sumHours(blocks.filter(isOther));
    const total = sumHours(blocks);
    days.push({ day: d.clone(), iso, blocks, work: total - other, other, total });
  }
  return days;
}

function hourOf(m) {
  return m.hours() + m.minutes() / 60;
}

function dayTip(d) {
  const lines = [d.day.format('ddd MMM D'), `${d.work.toFixed(2)} h work`];
  if (d.other) lines.push(`${d.other.toFixed(2)} h not task work`);
  if (d.blocks.length) {
    const first = d.blocks.reduce((a, b) => (b.start.isBefore(a.start) ? b : a));
    const last = d.blocks.reduce((a, b) => (b.end.isAfter(a.end) ? b : a));
    lines.push(`${first.start.format('h:mma')} – ${last.end.format('h:mma')} · ${plural(d.blocks.length, 'block')}`);
  }
  return lines.join('\n');
}

function legend(container, items) {
  const lg = container.createDiv({ cls: 'wtl-legend' });
  for (const [cls, label] of items) {
    const it = lg.createSpan({ cls: 'wtl-legend-item' });
    it.createSpan({ cls: `wtl-swatch ${cls}` });
    it.createSpan({ text: label });
  }
}

// Categorical colours: the validated 8-slot palette (light/dark steps live in
// styles.css as --wtl-c1..8). Stacks follow slot order, which is what keeps
// neighbouring colours distinguishable, including for colour-blind readers.
const SLOTS = 8;
// Same hexes as styles.css; used to keep palette colours away from your own tag colours.
const SLOT_HEX = {
  light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'],
  dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
};

function toRgb(c) {
  if (c.startsWith('#')) return [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
  const m = c.match(/(\d+),\s*(\d+),\s*(\d+)/);
  return m ? [m[1], m[2], m[3]].map(Number) : [0, 0, 0];
}

/** OKLab, for perceptual colour distance. */
function oklab(c) {
  const [r, g, b] = toRgb(c).map(v => {
    v /= 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const z = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * z,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * z,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * z,
  ];
}

/** Perceptual distance (OKLab x100); under 15 two chart colours are too easy to confuse. */
function colourDistance(a, b) {
  const [p, q] = [oklab(a), oklab(b)];
  return 100 * Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

/** Of the free palette slots, the one furthest from every colour already on screen. */
function furthestSlot(free, onScreen, theme) {
  let best = free[0];
  let bestD = -1;
  for (const n of free) {
    const d = onScreen.length ? Math.min(...onScreen.map(c => colourDistance(SLOT_HEX[theme][n - 1], c))) : Infinity;
    if (d > bestD) { bestD = d; best = n; }
  }
  return best;
}

/**
 * The categories a block counts toward in the daily charts, as [{ key, label, share }].
 * Shares add up to 1 so days never inflate: in the Tag view a block with two tags
 * gives each half its hours. "Not task work" is left out of the coloured charts.
 */
function blockCategories(b, dim) {
  // Areas cover all your time (meals, gym...), so nothing is left out there.
  if (dim.id === 'area') return [b.area ? { key: b.area, label: b.area, share: 1 } : { key: '~', label: 'Unsorted', share: 1 }];
  if (isOther(b)) return [];
  if (dim.id === 'tag') {
    const tags = [...new Set(b.tags)];
    if (!tags.length) return [{ key: '~', label: 'Untagged', share: 1 }];
    return tags.map(t => ({ key: t, label: `#${t}`, share: 1 / tags.length }));
  }
  if (dim.id === 'calendar') return [{ key: b.calendarId, label: b.calendar, share: 1 }];
  if (dim.id === 'task') return taskLeaves(b).map(l => ({ key: l.key, label: l.label, share: l.share }));
  const v = tagValue(b.tags, dim.group);
  return [v ? { key: v, label: v, share: 1 } : { key: '~', label: `No ${dim.label.toLowerCase()}`, share: 1 }];
}

/** Per-day hours by category, with colour slots resolved; uncoloured keys fold into one grey bucket. */
function categoryDays(report, color) {
  const days = dayRows(report);
  const labels = new Map();
  const week = new Map();
  for (const d of days) {
    d.cats = new Map();
    for (const b of d.blocks) {
      for (const c of blockCategories(b, color.dim)) {
        labels.set(c.key, c.label);
        const k = hasColor(color, c.key) ? c.key : '~other';
        bump(d.cats, k, b.hours * c.share);
        bump(week, c.key, b.hours * c.share);
      }
    }
  }
  for (const d of days) d.shown = [...d.cats.values()].reduce((a, h) => a + h, 0);
  const folded = [...week.keys()].filter(k => !hasColor(color, k));
  const otherLabel = folded.length === 1 ? labels.get(folded[0]) : 'Other';
  // Legend order = stack order = slot order; grey bucket last.
  // Your own tag colours first (biggest first), then palette colours in slot order.
  const custom = [...week.keys()].filter(k => color.custom.has(k)).sort((a, b) => week.get(b) - week.get(a));
  const pal = [...week.keys()].filter(k => !color.custom.has(k) && color.slots.has(k)).sort((a, b) => color.slots.get(a) - color.slots.get(b));
  const series = [...custom, ...pal].map(k => ({ key: k, label: labels.get(k), hours: week.get(k) }));
  if (folded.length) {
    series.push({ key: '~other', label: otherLabel, slot: null, hours: folded.reduce((a, k) => a + week.get(k), 0), folded: folded.map(k => labels.get(k)) });
  }
  return { days, series };
}

const swatchClass = slot => (slot ? `wtl-c${slot}` : 'is-neutral');
const hasColor = (color, key) => color.custom.has(key) || color.slots.has(key);

/** Colour an element for a category: your tag colour, else a palette slot, else grey. */
function paint(el, color, key) {
  if (color.custom.has(key)) el.style.background = color.custom.get(key);
  else el.addClass(swatchClass(color.slots.get(key)));
}

/** Height for one stacked segment: its share of the track minus its share of the 2px gaps. */
function segHeight(h, max, n) {
  const f = h / max;
  return `calc(${f * 100}% - ${(f * 2 * Math.max(0, n - 1)).toFixed(2)}px)`;
}

/** Legend values: always one decimal ("10.5 h", "3 h"). */
function fmtHours1(h) {
  return h.toFixed(1).replace(/\.0$/, '');
}

/** Hours per day as columns: plain (work + "not task work"), or stacked by category. */
function renderDays(container, report, tip, color = null) {
  const days = dayRows(report);
  if (color && color.dim.id === 'area') {
    const total = days.reduce((a, d) => a + d.total, 0);
    const active = days.filter(d => d.total > 0);
    const parts = [`${fmtHours(total)} h logged`];
    if (active.length) parts.push(`${fmtHours(total / active.length)} h a day on average`);
    container.createDiv({ cls: 'wtl-days-summary', text: parts.join(' · ') });
    return renderCategoryDays(container, report, tip, color, moment().format('YYYY-MM-DD'));
  }
  const work = days.reduce((a, d) => a + d.work, 0);
  const active = days.filter(d => d.work > 0);
  const busiest = active.reduce((a, d) => (!a || d.work > a.work ? d : a), null);
  const parts = [`${fmtHours(work)} h of work`];
  if (active.length) parts.push(`${fmtHours(work / active.length)} h avg over ${plural(active.length, 'day')}`);
  if (busiest && active.length > 1) parts.push(`most on ${busiest.day.format('ddd')} (${fmtHours(busiest.work)} h)`);
  container.createDiv({ cls: 'wtl-days-summary', text: parts.join(' · ') });

  const today = moment().format('YYYY-MM-DD');
  if (color) return renderCategoryDays(container, report, tip, color, today);

  const max = Math.max(1, ...days.map(d => d.total));
  const cols = container.createDiv({ cls: 'wtl-days' });
  for (const d of days) {
    const col = cols.createDiv({ cls: 'wtl-day' + (d.iso === today ? ' is-today' : '') + (d.total ? '' : ' is-empty') });
    col.createDiv({ cls: 'wtl-day-value', text: d.work ? fmtHours(d.work) : '' });
    const track = col.createDiv({ cls: 'wtl-day-track' });
    const segs = [];
    if (d.work) segs.push(['', d.work]);
    if (d.other) segs.push([' is-other', d.other]);
    segs.forEach(([cls, h], i) => {
      const seg = track.createDiv({ cls: `wtl-day-seg${cls}${i === segs.length - 1 ? ' is-top' : ''}` });
      seg.style.height = segHeight(h, max, segs.length);
    });
    col.createDiv({ cls: 'wtl-day-label', text: d.day.format('ddd') });
    col.createDiv({ cls: 'wtl-day-sub', text: d.day.format('D') });
    tip(col, dayTip(d));
  }
  if (days.some(d => d.other)) legend(container, [['', 'Work'], ['is-other', 'Not task work']]);
}

function renderCategoryDays(container, report, tip, color, today) {
  const { days, series } = categoryDays(report, color);
  const all = color.dim.id === 'area';
  const max = Math.max(1, ...days.map(d => d.shown));
  const cols = container.createDiv({ cls: 'wtl-days' });
  for (const d of days) {
    const col = cols.createDiv({ cls: 'wtl-day' + (d.iso === today ? ' is-today' : '') + (d.shown ? '' : ' is-empty') });
    col.createDiv({ cls: 'wtl-day-value', text: d.shown ? fmtHours(d.shown) : '' });
    const track = col.createDiv({ cls: 'wtl-day-track' });
    const segs = series.filter(sr => d.cats.get(sr.key));
    segs.forEach((sr, i) => {
      const seg = track.createDiv({ cls: `wtl-day-seg${i === segs.length - 1 ? ' is-top' : ''}` });
      paint(seg, color, sr.key);
      seg.style.height = segHeight(d.cats.get(sr.key), max, segs.length);
    });
    col.createDiv({ cls: 'wtl-day-label', text: d.day.format('ddd') });
    col.createDiv({ cls: 'wtl-day-sub', text: d.day.format('D') });
    const lines = [d.day.format('ddd MMM D'), `${d.shown.toFixed(2)} h${all ? '' : ' work'}`];
    for (const sr of [...segs].reverse()) lines.push(`  ${sr.label}  ${d.cats.get(sr.key).toFixed(2)} h`);
    if (d.other && !all) lines.push(`not task work ${d.other.toFixed(2)} h (not shown)`);
    tip(col, lines.join('\n'));
  }
  // Legend doubles as the labels: colour plus the week's hours as text.
  const lg = container.createDiv({ cls: 'wtl-legend is-wrap' });
  for (const sr of series) {
    const it = lg.createSpan({ cls: 'wtl-legend-item' });
    paint(it.createSpan({ cls: 'wtl-swatch' }), color, sr.key);
    it.createSpan({ text: sr.label });
    it.createSpan({ cls: 'wtl-legend-value', text: `${fmtHours1(sr.hours)} h` });
    if (sr.folded && sr.folded.length > 1) it.setAttr('aria-label', sr.folded.join(', '));
  }
  const hidden = all ? 0 : days.reduce((a, d) => a + d.other, 0);
  const notes = [];
  if (hidden) notes.push(`Not task work (${fmtHours1(hidden)} h) isn't shown.`);
  if (color.dim.id === 'tag' && report.blocks.some(b => b.tags.length > 1)) notes.push('Blocks with several tags are split evenly between them.');
  if (notes.length) container.createDiv({ cls: 'wtl-muted wtl-days-note', text: notes.join(' ') });
}

/** One row per day across the hours of the day; each block where it happened. */
function renderTimeline(container, report, tip, color = null) {
  const days = dayRows(report);
  let lo = 24;
  let hi = 0;
  for (const b of report.blocks) {
    const s0 = hourOf(b.start);
    const e0 = b.end.isSame(b.start, 'day') ? hourOf(b.end) : 24;
    lo = Math.min(lo, Math.floor(s0));
    hi = Math.max(hi, Math.ceil(e0));
  }
  // Always show at least a 9–5 frame so short weeks still read as a workday.
  lo = Math.min(lo, 9);
  hi = Math.max(hi, 17);
  const span = hi - lo;
  const step = span > 12 ? 3 : 2;
  const pct = h => `${((h - lo) / span) * 100}%`;

  const wrap = container.createDiv({ cls: 'wtl-timeline' });
  const axis = wrap.createDiv({ cls: 'wtl-tl-row wtl-tl-axis' });
  axis.createDiv({ cls: 'wtl-tl-label' });
  const ticks = axis.createDiv({ cls: 'wtl-tl-track' });
  for (let h = Math.ceil(lo / step) * step; h <= hi; h += step) {
    const t = ticks.createSpan({ cls: 'wtl-tl-tick', text: moment({ hour: h % 24 }).format('ha') });
    t.style.left = pct(h);
  }
  axis.createDiv({ cls: 'wtl-tl-total' });

  const today = moment().format('YYYY-MM-DD');
  for (const d of days) {
    const row = wrap.createDiv({ cls: 'wtl-tl-row' + (d.iso === today ? ' is-today' : '') });
    row.createDiv({ cls: 'wtl-tl-label', text: d.day.format('ddd D') });
    const track = row.createDiv({ cls: 'wtl-tl-track' });
    for (let h = Math.ceil(lo / step) * step; h <= hi; h += step) {
      track.createDiv({ cls: 'wtl-tl-grid' }).style.left = pct(h);
    }
    for (const b of d.blocks) {
      const s0 = hourOf(b.start);
      const e0 = b.end.isSame(b.start, 'day') ? hourOf(b.end) : 24;
      const byArea = color && color.dim.id === 'area';
      const rect = track.createDiv({ cls: 'wtl-tl-block' + (isOther(b) && !byArea ? ' is-other' : '') });
      if (color && (byArea || !isOther(b))) {
        // Coloured by its largest category (first, for an even split).
        const cats = blockCategories(b, color.dim);
        paint(rect, color, cats.length && hasColor(color, cats[0].key) ? cats[0].key : '~other');
      }
      rect.style.left = pct(s0);
      rect.style.width = `${((e0 - s0) / span) * 100}%`;
      const label = b.choice ? choiceLabel(b.choice) : 'Unattached';
      const area = b.area ? `\n${b.area}${b.areaStatus === 'confirmed' ? '' : ' (suggested)'}` : '';
      tip(rect, `${b.title}\n${b.start.format('ddd h:mm')}–${b.end.format('h:mma')} · ${fmtHours(b.hours)} h\n${label}${area}`);
    }
    const rowTotal = color && color.dim.id === 'area' ? d.total : d.work;
    row.createDiv({ cls: 'wtl-tl-total', text: rowTotal ? `${fmtHours(rowTotal)} h` : '' });
  }
  if (color) {
    const { series } = categoryDays(report, color);
    const lg = container.createDiv({ cls: 'wtl-legend is-wrap' });
    for (const sr of series) {
      const it = lg.createSpan({ cls: 'wtl-legend-item' });
      paint(it.createSpan({ cls: 'wtl-swatch' }), color, sr.key);
      it.createSpan({ text: sr.label });
      it.createSpan({ cls: 'wtl-legend-value', text: `${fmtHours1(sr.hours)} h` });
    }
    if (color.dim.id !== 'area' && report.blocks.some(isOther)) {
      const it = lg.createSpan({ cls: 'wtl-legend-item' });
      it.createSpan({ cls: 'wtl-swatch is-other is-outline' });
      it.createSpan({ text: 'Not task work' });
    }
  } else if (report.blocks.some(isOther)) {
    legend(container, [['', 'Work'], ['is-other', 'Not task work']]);
  }
}

/**
 * Agenda: just what's planned, as a short list per day. Days without blocks are
 * skipped; `fromToday` drops earlier days. Dots use the area colours.
 */
function renderAgenda(container, report, tip, color, { fromToday = false } = {}) {
  const today = moment().format('YYYY-MM-DD');
  const days = dayRows(report).filter(d => d.blocks.length && (!fromToday || d.iso >= today));
  const list = container.createDiv({ cls: 'wtl-agenda' });
  if (!days.length) {
    list.createDiv({ cls: 'wtl-muted', text: fromToday ? 'Nothing else planned this week.' : 'Nothing planned this week.' });
    return;
  }
  for (const d of days) {
    const day = list.createDiv({ cls: 'wtl-agenda-day' + (d.iso === today ? ' is-today' : '') + (d.iso < today ? ' is-past' : '') });
    const head = day.createDiv({ cls: 'wtl-agenda-head' });
    head.createSpan({ cls: 'wtl-agenda-date', text: d.iso === today ? `Today · ${d.day.format('ddd MMM D')}` : d.day.format('ddd MMM D') });
    head.createSpan({ cls: 'wtl-agenda-total', text: `${fmtHours1(d.total)} h` });
    for (const b of [...d.blocks].sort((x, y) => x.start - y.start)) {
      const row = day.createDiv({ cls: 'wtl-agenda-row' });
      row.createSpan({ cls: 'wtl-agenda-time', text: `${b.start.format('h:mm')}–${b.end.format('h:mma')}` });
      const dot = row.createSpan({ cls: 'wtl-agenda-dot' });
      if (color) paint(dot, color, b.area && hasColor(color, b.area) ? b.area : '~other');
      const main = row.createSpan({ cls: 'wtl-agenda-main' });
      main.createSpan({ cls: 'wtl-agenda-title', text: b.title });
      if (b.choice && b.choice.kind !== 'none') {
        const label = b.choice.kind === 'tag' ? hashes(b.choice.tags) : choiceLabel(b.choice);
        main.createSpan({ cls: 'wtl-agenda-label' + (b.status === 'confirmed' ? '' : ' is-pending'), text: label });
      }
      row.createSpan({ cls: 'wtl-agenda-hours', text: `${fmtHours1(b.hours)} h` });
      const area = b.area ? `\n${b.area}${b.areaStatus === 'confirmed' ? '' : ' (suggested)'}` : '';
      tip(row, `${b.title}\n${b.start.format('ddd h:mm')}–${b.end.format('h:mma')}${area}`);
    }
  }
  if (color) {
    const used = new Set(days.flatMap(d => d.blocks.map(b => b.area || '~other')));
    const lg = container.createDiv({ cls: 'wtl-legend is-wrap' });
    for (const [name] of color.slots) {
      if (!used.has(name)) continue;
      const it = lg.createSpan({ cls: 'wtl-legend-item' });
      paint(it.createSpan({ cls: 'wtl-swatch' }), color, name);
      it.createSpan({ text: name });
    }
    if (used.has('~other')) {
      const it = lg.createSpan({ cls: 'wtl-legend-item' });
      it.createSpan({ cls: 'wtl-swatch is-neutral' });
      it.createSpan({ text: 'Unsorted' });
    }
  }
}

/**
 * "▸ Breakdown": a folded section with a switcher (Area, groupings, Tag, Task,
 * Calendar) and expandable bars. `state` keeps open/dimension/expanded rows
 * across redraws for whoever owns it.
 */
function renderBreakdown(host, report, settings, state, { tip, openTask, title = 'Breakdown', colorsFor = null } = {}) {
  const det = host.createEl('details', { cls: 'wtl-details' });
  det.open = !!state.open;
  det.addEventListener('toggle', () => { state.open = det.open; });
  det.createEl('summary', { text: title });
  const seg = det.createDiv({ cls: 'wtl-seg wtl-breakdown-seg' });
  const body = det.createDiv();
  state.expanded = state.expanded || new Set();
  const draw = () => {
    const dim = findDimension(settings, state.dim || 'area');
    seg.empty();
    for (const d of dimensions(settings)) {
      const b = seg.createEl('button', { text: d.label, cls: d.id === dim.id ? 'is-active' : '' });
      b.onclick = e => { e.preventDefault(); state.dim = d.id; draw(); };
    }
    body.empty();
    renderTree(body, buildTree(report.blocks, dim), {
      isOpen: k => state.expanded.has(`${dim.id}|${k}`),
      toggle: k => {
        const key = `${dim.id}|${k}`;
        if (state.expanded.has(key)) state.expanded.delete(key); else state.expanded.add(key);
      },
      tip: tip || ((row, text) => row.setAttr('aria-label', text)),
      openTask,
      // Group bars wear their area/tag colour, matching the charts above.
      color: colorsFor ? colorsFor(dim) : null,
    });
  };
  draw();
  return det;
}

module.exports = class WeeklyTimeLogPlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    this.registerView(VIEW_TYPE, leaf => new TimeLogView(leaf, this));
    this.addRibbonIcon('clock', 'Open weekly time log', () => this.openView());
    this.addCommand({ id: 'open', name: 'Open weekly time log', callback: () => this.openView() });
    this.addCommand({
      id: 'review',
      name: 'Review this week\'s time blocks',
      callback: async () => {
        try {
          this.openReview(await this.buildReport(0));
        } catch (e) {
          new Notice(`Weekly Time Log: ${e.message}`);
        }
      },
    });
    this.addCommand({
      id: 'export-csv',
      name: 'Export this week to CSV',
      callback: async () => {
        try {
          await this.exportCsv(await this.buildReport(0));
        } catch (e) {
          new Notice(`Weekly Time Log: ${e.message}`);
        }
      },
    });
    this.addCommand({
      id: 'insert-block',
      name: 'Insert time log block in note',
      editorCallback: editor => editor.replaceSelection('```time-log\n```\n'),
    });
    this.registerMarkdownCodeBlockProcessor('time-log', (source, el, ctx) => {
      ctx.addChild(new TimeLogBlock(this, el, source, ctx.sourcePath));
    });
    this.addSettingTab(new TimeLogSettings(this.app, this));
    // Tag colours can change (theme switch, Colored Tags updates): re-read them.
    this.registerEvent(this.app.workspace.on('css-change', () => {
      this.tagBaseline = null;
      this.tagColorCache = null;
      this.refreshViews();
    }));

    // Background check: shortly after startup (lets Google events load), then every few hours.
    this.loadedAt = Date.now();
    this.app.workspace.onLayoutReady(() => {
      this.watchCalendar();
      this.registerInterval(window.setTimeout(() => this.weeklyCheck(), 60 * 1000));
      this.registerInterval(window.setInterval(() => this.weeklyCheck(), 3 * 60 * 60 * 1000));
    });
  }

  // ---- Calendar loading ---------------------------------------------------

  /**
   * Full Calendar loads Google events some time after Obsidian starts (and syncs
   * them later), and its API has no "loaded" event. So: check a cheap signature of
   * its events, every 3 s for the first two minutes and every minute after,
   * and redraw open logs whenever it changes.
   */
  watchCalendar() {
    let ticks = 0;
    let wasSettled = false;
    const redraw = () => {
      this.refreshBlocks();
      this.refreshViews();
    };
    const check = async () => {
      ticks++;
      // Anything drawn while the calendar was still loading gets one redraw once it settles.
      if (!wasSettled && this.calendarSettled()) {
        wasSettled = true;
        redraw();
      }
      if (ticks > 40 && ticks % 20 !== 0) return; // after ~2 min: once a minute
      if (!this.settings.token) return;
      let sig;
      try {
        this.silent = true;
        const events = (await this.calendarApi()).getEvents({}, []);
        let sum = 0;
        for (const e of events) sum = (sum + (e.startMillis || 0) % 1e9 + (e.endMillis || 0) % 1e9 + (e.title || '').length) % 1e12;
        sig = `${events.length}:${sum}`;
      } catch (e) {
        return; // Full Calendar not ready yet
      } finally {
        this.silent = false;
      }
      if (sig === this.calendarSig) return;
      this.calendarSig = sig;
      this.calendarChangedAt = Date.now();
      // Includes the first successful read: notes are drawn while Obsidian restores
      // tabs, often before this watcher starts, and may show an empty week.
      redraw();
    };
    check();
    this.registerInterval(window.setInterval(check, 3000));
  }

  /** False while the calendar may still be loading (so an empty week might not be empty). */
  calendarSettled() {
    if (Date.now() - (this.loadedAt || 0) > 2 * 60 * 1000) return true;
    if (!this.calendarSig || this.calendarSig.startsWith('0:')) return false;
    return Date.now() - this.calendarChangedAt > 6000;
  }

  onunload() {
    if (this.probeHost) this.probeHost.remove();
  }

  // ---- Background export & reminder ---------------------------------------

  /** Once a day: save last week's CSV and nudge if anything is unreviewed. */
  async weeklyCheck() {
    const s = this.settings;
    const today = moment().format('YYYY-MM-DD');
    if ((!s.autoExport && !s.remind) || s.lastCheck === today || !s.token) return;
    if (!this.calendarSettled()) {
      this.registerInterval(window.setTimeout(() => this.weeklyCheck(), 30 * 1000));
      return;
    }
    let report;
    try {
      this.silent = true; // never pop the access dialog from the background
      report = await this.buildReport(-1);
    } catch (e) {
      console.warn('Weekly Time Log: background check skipped:', e.message);
      return; // retried on the next interval
    } finally {
      this.silent = false;
    }
    if (!report.blocks.length) return; // calendar may still be loading; never save an empty week
    if (s.autoExport) await this.exportCsv(report, { quiet: true });
    const pending = report.blocks.filter(needsReview).length;
    if (pending && s.remind) this.remind(report, pending);
    s.lastCheck = today;
    await this.saveSettings();
  }

  remind(report, pending) {
    const range = `${report.start.format('MMM D')} – ${report.end.clone().subtract(1, 'day').format('MMM D')}`;
    const frag = createFragment(f => {
      f.createDiv({ text: `Time log for ${range}: ${plural(pending, 'block')} to review.` });
      const row = f.createDiv({ cls: 'wtl-notice-buttons' });
      const review = row.createEl('button', { text: 'Review', cls: 'mod-cta' });
      review.onclick = () => {
        notice.hide();
        this.openReview(report);
      };
      row.createEl('button', { text: 'Later' }).onclick = () => notice.hide();
    });
    const notice = new Notice(frag, 0);
  }

  openReview(report, onDone) {
    new ReviewModal(this.app, this, report, async () => {
      await this.autoSave(report);
      if (onDone) onDone();
      this.refreshViews();
    }).open();
  }

  /** Re-save a week's CSV after labels change (only if auto-export is on). */
  async autoSave(report) {
    if (this.settings.autoExport && report.blocks.length) await this.exportCsv(report, { quiet: true });
  }

  // v0.1 stored bare manual matches as `overrides`.
  migrateOverrides() {
    const old = this.settings.overrides;
    if (!old) return;
    for (const [key, v] of Object.entries(old)) {
      if (this.settings.annotations[key]) continue;
      this.settings.annotations[key] = v === '__none__'
        ? { kind: 'none', tags: [], title: '' }
        : { kind: 'task', task: v, taskPath: v.split('::')[0], taskDesc: v.split('::').slice(1).join('::'), tags: [], title: '' };
    }
    delete this.settings.overrides;
    this.saveSettings();
  }

  async loadSettings() {
    const local = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULTS, local);
    const shared = await this.readDataFile();
    if (shared) {
      for (const [k, v] of Object.entries(shared)) if (!LOCAL_KEYS.includes(k) && k !== 'version') this.settings[k] = v;
    }
    this.settings.annotations = this.settings.annotations || {};
    this.migrateOverrides();
    // First run with the vault file (or upgrade from plugin-only storage): write it out.
    if (!shared) await this.saveSettings();
  }

  async readDataFile() {
    const adapter = this.app.vault.adapter;
    const path = normalizePath(this.settings ? this.settings.dataFile : DEFAULT_DATA_FILE);
    try {
      if (!(await adapter.exists(path))) return null;
      return JSON.parse(await adapter.read(path));
    } catch (e) {
      // Never overwrite a file we couldn't parse; fall back to what's in memory.
      this.dataFileError = `${path}: ${e.message}`;
      new Notice(`Weekly Time Log: couldn't read ${path} (${e.message}). Not overwriting it.`);
      return null;
    }
  }

  async saveSettings() {
    const local = {};
    const shared = { version: 1 };
    for (const [k, v] of Object.entries(this.settings)) {
      if (LOCAL_KEYS.includes(k)) local[k] = v; else shared[k] = v;
    }
    await this.saveData(local);
    if (this.dataFileError) return;
    const adapter = this.app.vault.adapter;
    const path = normalizePath(this.settings.dataFile || DEFAULT_DATA_FILE);
    const folder = path.split('/').slice(0, -1).join('/');
    if (folder && !(await adapter.exists(folder))) await adapter.mkdir(folder);
    await adapter.write(path, JSON.stringify(shared, null, 2));
  }

  /** Opens the full log, optionally at the week starting `weekStart`. */
  async openView(weekStart = null) {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getLeaf('tab');
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
    if (weekStart && leaf.view instanceof TimeLogView) {
      const { start } = await this.weekBounds(0);
      leaf.view.offset = Math.floor(weekStart.diff(start, 'days') / 7);
      await leaf.view.refresh();
    }
  }

  refreshViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) leaf.view.refresh();
    this.refreshBlocks();
  }

  /** Re-render every time-log block in open notes (debounced: reviews fire many changes). */
  refreshBlocks() {
    window.clearTimeout(this.blockTimer);
    this.blockTimer = window.setTimeout(() => {
      for (const b of this.liveBlocks || []) b.render();
    }, 500);
  }

  // ---- Full Calendar access ----------------------------------------------

  fullCalendar() {
    const fc = this.app.plugins.plugins[FC_ID];
    if (!fc) throw new Error('Full Calendar Remastered is not enabled.');
    if (!fc.api || typeof fc.api.withToken !== 'function') {
      throw new Error('This version of Full Calendar Remastered has no plugin API.');
    }
    return fc;
  }

  // events:read and providers:read are required; settings:read (for the calendar's
  // first day of week) is optional and may be unticked in Full Calendar's dialog.
  calendarApi() {
    if (!this.apiPromise) {
      this.apiPromise = this.authorize().finally(() => { this.apiPromise = null; });
    }
    return this.apiPromise;
  }

  async authorize() {
    const fc = this.fullCalendar();
    const usable = api => {
      try {
        api.getCalendarSources();
        return true;
      } catch (e) {
        return false; // token from an older version, missing providers:read
      }
    };
    let api = this.settings.token ? fc.api.withToken(this.settings.token) : null;
    if (!api || !usable(api)) {
      if (this.silent) throw new Error('calendar access needs to be granted first');
      const token = await fc.api.requestAccess(
        this.manifest.id,
        'Read your calendar blocks and calendar list to build a weekly time log matched to Tasks. ' +
          'Settings access is optional (only used for the first day of the week).',
        ['events:read', 'providers:read', 'settings:read'],
      );
      if (!token) throw new Error('Calendar access was not granted.');
      this.settings.token = token;
      await this.saveSettings();
      api = fc.api.withToken(token);
      if (!api || !usable(api)) {
        throw new Error('Weekly Time Log needs "Read events" and "Read providers" access in Full Calendar.');
      }
    }
    return api;
  }

  async calendarSources() {
    const api = await this.calendarApi();
    const sources = api.getCalendarSources() || [];
    let firstDay = 0;
    try {
      firstDay = api.getSettings().firstDay ?? 0;
    } catch (e) {
      // settings:read not granted; fall back to Sunday
    }
    return { sources, firstDay };
  }

  /** 0 = Sunday, 1 = Monday; "Same as calendar" reads Full Calendar's setting. */
  async firstDay() {
    let first = this.settings.weekStart;
    if (first === 'calendar') first = (await this.calendarSources()).firstDay;
    return Number(first) || 0;
  }

  /**
   * Start of week number `week` in `year`. Monday weeks use ISO numbering;
   * other starts use "week 1 contains Jan 1" (US-style, e.g. Sunday weeks).
   */
  async weekNumberStart(year, week) {
    const first = await this.firstDay();
    if (first === 1) return moment(`${year}-W${String(week).padStart(2, '0')}-1`, 'GGGG-[W]WW-E');
    const jan1 = moment(`${year}-01-01`, 'YYYY-MM-DD');
    return jan1.subtract((jan1.day() - first + 7) % 7, 'days').add((week - 1) * 7, 'days');
  }

  /** The week containing `anchor` (default today), shifted by `offset` weeks. */
  async weekBounds(offset = 0, anchor = null) {
    const first = await this.firstDay();
    const day = (anchor ? moment(anchor) : moment()).startOf('day');
    const start = day.clone().subtract((day.day() - first + 7) % 7, 'days').add(offset * 7, 'days');
    return { start, end: start.clone().add(7, 'days') };
  }

  // ---- Data collection ----------------------------------------------------

  async collectBlocks(start, end) {
    const api = await this.calendarApi();
    const { sources } = await this.calendarSources();
    const names = new Map(sources.map(s => [s.id, s.name || s.id]));
    const wanted = this.settings.calendarIds
      ? new Set(this.settings.calendarIds)
      : new Set(sources.filter(s => s.type !== 'tasks').map(s => s.id));

    let events;
    try {
      events = api.getEvents({}, []);
    } catch (e) {
      throw new Error(`Calendar not ready yet (${e.message}). Open the calendar once, then refresh.`);
    }

    const s0 = start.valueOf();
    const e0 = end.valueOf();
    const blocks = [];
    const overridden = new Set(); // recurring instances replaced by a one-off edit

    const add = (calendarId, ev, startM, endM) => {
      const hours = Math.max(0, (endM.valueOf() - startM.valueOf()) / 36e5);
      if (!hours) return;
      const title = (ev.title || '').trim() || '(untitled)';
      blocks.push({
        key: `${calendarId}|${ev.uid || ev.title}|${startM.format('YYYY-MM-DDTHH:mm')}`,
        calendarId,
        calendar: names.get(calendarId) || calendarId,
        title,
        description: ev.description || '',
        explicitTags: [...new Set(findTags(`${title} ${ev.description || ''}`))],
        start: startM,
        end: endM,
        date: startM.format('YYYY-MM-DD'),
        hours,
      });
    };

    const recurring = [];
    for (const r of events) {
      if (!wanted.has(r.calendarId)) continue;
      const ev = (r.rawEvent && r.rawEvent.event) || {};
      if (ev.allDay || r.allDay) continue;
      if (ev.type === 'rrule' || ev.type === 'recurring') {
        recurring.push({ calendarId: r.calendarId, ev });
        continue;
      }
      if (ev.recurringEventId) overridden.add(`${ev.recurringEventId}|${ev.date}`);
      if (r.startMillis == null || r.startMillis < s0 || r.startMillis >= e0) continue;
      add(r.calendarId, ev, moment(r.startMillis), moment(r.endMillis ?? r.startMillis + 36e5));
    }

    for (const { calendarId, ev } of recurring) {
      if (!ev.startTime) continue;
      const rule = ev.type === 'rrule' ? parseRRule(ev.rrule) : fcRecurringToRule(ev);
      const first = ev.type === 'rrule' ? ev.startDate : ev.startRecur;
      const skip = new Set(ev.skipDates || []);
      for (const date of expandDates(rule, first, start, end)) {
        if (skip.has(date) || overridden.has(`${ev.uid}|${date}`)) continue;
        const startM = atTime(date, ev.startTime);
        let endM = ev.endTime ? atTime(date, ev.endTime) : startM.clone().add(1, 'hour');
        if (!endM.isAfter(startM)) endM.add(1, 'day');
        add(calendarId, ev, startM, endM);
      }
    }

    blocks.sort((a, b) => a.start.valueOf() - b.start.valueOf());
    return blocks;
  }

  /** tag (without #) -> number of uses across the vault. */
  collectVaultTags() {
    const counts = new Map();
    const mc = this.app.metadataCache;
    if (typeof mc.getTags === 'function') {
      for (const [t, n] of Object.entries(mc.getTags())) counts.set(t.replace(/^#/, ''), n);
    } else {
      for (const f of this.app.vault.getMarkdownFiles()) {
        for (const t of getAllTags(mc.getFileCache(f)) || []) bump(counts, t.replace(/^#/, ''), 1);
      }
    }
    return counts;
  }

  async collectTasks(weekStartIso) {
    const tasks = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      const cache = this.app.metadataCache.getFileCache(file);
      const items = (cache && cache.listItems || []).filter(li => li.task !== undefined);
      if (!items.length) continue;
      const lines = (await this.app.vault.cachedRead(file)).split('\n');
      for (const li of items) {
        const t = parseTask(lines[li.position.start.line] || '', file.path, li.position.start.line);
        if (!t || !t.desc) continue;
        // Open tasks, plus tasks finished during/after this week (the work may predate the checkmark).
        if (t.done && !(t.doneDate && t.doneDate >= weekStartIso)) continue;
        tasks.push(t);
      }
    }
    return tasks;
  }

  // ---- Learning & scoring -------------------------------------------------

  /** Everything learned from confirmed labels. */
  buildModel() {
    const entries = Object.entries(this.settings.annotations).map(([key, a]) => ({
      ...a, key, tokens: uniqTokens(a.title), norm: norm(a.title),
    }));
    const tokenTags = new Map(); // word -> Map(tag -> times the word appeared in a block labeled with tag)
    const tokenCount = new Map();
    for (const a of entries) {
      for (const w of a.tokens) {
        bump(tokenCount, w, 1);
        if (!tokenTags.has(w)) tokenTags.set(w, new Map());
        for (const tg of a.tags || []) bump(tokenTags.get(w), tg, 1);
      }
    }
    return { entries, tokenTags, tokenCount };
  }

  /** How similar, previously labeled blocks were labeled. */
  historyVotes(block, bTokens, bNorm, model) {
    const v = { task: new Map(), tag: new Map(), none: 0, total: 0, n: 0 };
    for (const a of model.entries) {
      if (a.key === block.key || !a.tokens.length) continue;
      const sim = a.norm === bNorm ? 1 : similarity(bTokens, a.tokens);
      if (sim < HISTORY_SIM_MIN) continue;
      v.total += sim;
      v.n++;
      if (a.kind === 'none') v.none += sim;
      if (a.kind === 'task') bump(v.task, a.task, sim);
      if (a.kind === 'mix') for (const t of a.tasks || []) bump(v.task, t.key, sim);
      for (const tg of a.tags || []) bump(v.tag, tg, sim);
    }
    return v;
  }

  /** tag -> { p, why } */
  predictTags(block, bTokens, votes, vocab, model) {
    const out = new Map();
    const offer = (tag, p, why) => {
      const cur = out.get(tag);
      if (!cur || p > cur.p) out.set(tag, { p: Math.min(1, p), why });
    };
    for (const tg of block.explicitTags) offer(tg, 1, `#${tg} is in the event`);
    if (votes.total) {
      for (const [tg, w] of votes.tag) {
        offer(tg, w / votes.total, `you tagged ${plural(votes.n, 'similar block')} #${tg}`);
      }
    }
    for (const { tag, tokens: tt } of vocab) {
      if (!tt.length) continue;
      const cover = tt.filter(w => bTokens.some(x => sameWord(w, x))).length / tt.length;
      // Full matches on more specific tags (#meeting/advisor) edge out general ones (#meeting).
      if (cover >= 0.5) offer(tag, 0.8 * cover + (cover === 1 ? 0.03 * Math.min(3, tt.length - 1) : 0), `title matches #${tag}`);
    }
    for (const w of bTokens) {
      const n = model.tokenCount.get(w) || 0;
      if (n < 2) continue;
      for (const [tg, c] of model.tokenTags.get(w) || []) {
        offer(tg, 0.7 * (c / n), `"${w}" usually means #${tg} for you`);
      }
    }
    return out;
  }

  scoreBlocks(report) {
    const { blocks, tasks, start, end } = report;
    const weekStart = start.format('YYYY-MM-DD');
    const weekEnd = end.format('YYYY-MM-DD');
    const model = this.buildModel();

    for (const t of tasks) {
      t.descTokens = uniqTokens(t.desc);
      t.tagTokens = [...new Set(t.tags.flatMap(tokens))];
      t.norm = norm(t.desc);
    }
    // Every tag you use anywhere in the vault, plus task tags and tags from past labels.
    const counts = new Map(report.tagCounts || []);
    const byLower = new Map();
    const addTag = tg => { if (tg && !byLower.has(tg.toLowerCase())) byLower.set(tg.toLowerCase(), tg); };
    for (const t of tasks) t.tags.forEach(addTag);
    for (const a of model.entries) (a.tags || []).forEach(addTag);
    for (const tg of counts.keys()) addTag(tg);
    const countOf = tg => counts.get(tg) || counts.get(byLower.get(tg.toLowerCase())) || 0;
    report.tagVocab = [...byLower.values()].sort((a, b) => countOf(b) - countOf(a) || a.localeCompare(b));
    report.tagCount = countOf;
    const vocab = report.tagVocab.map(tag => ({ tag, tokens: uniqTokens(tag) }));

    // Rarity weighting: words shared by many tasks ("write") count less than distinctive ones ("intro").
    const df = new Map();
    for (const t of tasks) for (const w of new Set([...t.descTokens, ...t.tagTokens])) bump(df, w, 1);
    const weightCache = new Map();
    const weight = w => {
      if (!weightCache.has(w)) {
        let n = 0;
        for (const [k, c] of df) if (sameWord(k, w)) n = Math.max(n, c);
        weightCache.set(w, 1 / Math.max(1, n));
      }
      return weightCache.get(w);
    };

    for (const b of blocks) {
      const bTokens = uniqTokens(b.title);
      const bNorm = norm(b.title);
      const bWeights = bTokens.map(weight);
      const bTotal = bWeights.reduce((a, c) => a + c, 0);
      const votes = this.historyVotes(b, bTokens, bNorm, model);
      const tagP = this.predictTags(b, bTokens, votes, vocab, model);
      const candidates = [];

      for (const t of tasks) {
        const reasons = [];
        let text = 0;
        if (bNorm.length >= 4 && t.norm.length >= 4 && (bNorm.includes(t.norm) || t.norm.includes(bNorm))) {
          text = 1;
        } else if (bTotal > 0 && t.descTokens.length) {
          let got = 0;
          bTokens.forEach((w, i) => {
            if (t.descTokens.some(d => sameWord(d, w))) got += bWeights[i];
            else if (t.tagTokens.some(d => sameWord(d, w))) got += bWeights[i] * 0.5;
          });
          const tWeights = t.descTokens.map(weight);
          const tTotal = tWeights.reduce((a, c) => a + c, 0);
          let tGot = 0;
          t.descTokens.forEach((w, i) => { if (bTokens.some(d => sameWord(d, w))) tGot += tWeights[i]; });
          text = 0.6 * (got / bTotal) + 0.4 * (tTotal ? tGot / tTotal : 0);
        }
        if (text >= 0.9) reasons.push('title matches task');
        else if (text >= 0.2) reasons.push('similar wording');

        let tagBonus = 0;
        let tagWhy = null;
        for (const tg of t.tags) {
          const p = tagP.get(tg);
          if (p && 0.35 * p.p > tagBonus) { tagBonus = 0.35 * p.p; tagWhy = p.why; }
        }
        if (tagWhy) reasons.push(tagWhy);

        const histBonus = votes.total ? 0.6 * ((votes.task.get(t.key) || 0) / votes.total) : 0;
        if (histBonus) reasons.push(`you picked this for ${plural(votes.n, 'similar block')}`);

        if (text < 0.2 && !tagBonus && !histBonus) continue;

        let dateBonus = 0;
        if (t.scheduled === b.date) { dateBonus = 0.3; reasons.push('scheduled that day'); }
        else if (t.scheduled && t.scheduled >= weekStart && t.scheduled < weekEnd) { dateBonus = 0.15; reasons.push('scheduled this week'); }
        else if (t.due && t.due >= b.date) dateBonus = 0.05;
        if (!t.scheduled) reasons.push('not scheduled');
        if (t.done && t.doneDate && t.doneDate < b.date) dateBonus -= 0.3;

        candidates.push({ task: t, score: text + tagBonus + histBonus + dateBonus, reasons });
      }
      candidates.sort((x, y) => y.score - x.score || (y.task.scheduled ? 1 : 0) - (x.task.scheduled ? 1 : 0));

      const tagRank = [...tagP.entries()].map(([tag, v]) => ({ tag, ...v })).sort((x, y) => y.p - x.p);
      const best = candidates[0];
      let suggestion = null;
      if (votes.total && votes.none / votes.total >= NONE_MIN && (!best || best.score < 1)) {
        suggestion = { kind: 'none', score: votes.none / votes.total, reasons: [`you marked ${plural(votes.n, 'similar block')} as not task work`] };
      } else if (best && best.score >= this.settings.minScore) {
        suggestion = { kind: 'task', task: best.task, score: best.score, reasons: best.reasons };
      } else if (tagRank[0] && tagRank[0].p >= TAG_ONLY_MIN) {
        const sure = tagRank.filter(t => t.p >= TAG_ONLY_MIN);
        const tags = sure.map(t => t.tag)
          .filter(tg => !sure.some(o => o.tag.toLowerCase().startsWith(tg.toLowerCase() + '/')))
          .slice(0, 3);
        const why = [...new Set(sure.filter(t => tags.includes(t.tag)).map(t => t.why))];
        suggestion = { kind: 'tag', tags, score: tagRank[0].p, reasons: why };
      }

      b.candidates = candidates;
      b.tagRank = tagRank;
      b.suggestion = suggestion;
    }
  }

  /** Resolve each block to its confirmed label, else its suggestion. */
  assign(report) {
    const byKey = new Map(report.tasks.map(t => [t.key, t]));
    for (const b of report.blocks) {
      const a = this.settings.annotations[b.key];
      if (a) {
        b.status = 'confirmed';
        // A task may have moved or been deleted since; keep the label anyway.
        const resolve = (key, desc, path, tags) => byKey.get(key) || { key, desc: desc || key, path, tags: tags || [], ghost: true };
        if (a.kind === 'task') {
          b.choice = { kind: 'task', task: resolve(a.task, a.taskDesc, a.taskPath, a.tags) };
        } else if (a.kind === 'mix') {
          b.choice = { kind: 'mix', tasks: (a.tasks || []).map(t => resolve(t.key, t.desc, t.path, t.tags)), tags: a.extraTags || [] };
        } else if (a.kind === 'tag') {
          b.choice = { kind: 'tag', tags: a.tags || [] };
        } else {
          b.choice = { kind: 'none' };
        }
      } else if (b.suggestion) {
        b.status = 'suggested';
        b.choice = b.suggestion;
      } else {
        b.status = 'open';
        b.choice = null;
      }
      const parts = choiceParts(b.choice);
      b.tasks = parts.tasks;
      b.task = parts.tasks[0] || null;
      b.tags = [...new Set([...parts.tasks.flatMap(t => t.tags), ...parts.tags])];
    }
    return report;
  }

  rescore(report) {
    this.scoreBlocks(report);
    this.assign(report);
    return this.assignAreas(report);
  }

  // ---- Areas ---------------------------------------------------------------

  /**
   * Each block's area: what you confirmed, else a prediction from (strongest wins)
   * the area's #tags, similar blocks you sorted, words like "lunch"/"gym",
   * tags you usually sort into an area, and a default for task work.
   */
  assignAreas(report) {
    const areas = parseAreas(this.settings.areas);
    const names = new Map(areas.map(a => [a.name.toLowerCase(), a.name]));
    const entries = Object.entries(this.settings.areaLabels || {}).map(([key, e]) => ({
      key, ...e, tokens: uniqTokens(e.title), norm: norm(e.title),
    }));
    const tagAreas = new Map(); // tag -> Map(area -> count)
    for (const e of entries) {
      for (const tg of e.tags || []) {
        const k = tg.toLowerCase();
        if (!tagAreas.has(k)) tagAreas.set(k, new Map());
        bump(tagAreas.get(k), e.area, 1);
      }
    }
    const defaultArea = names.get((this.settings.defaultTaskArea || '').toLowerCase()) || null;

    for (const b of report.blocks) {
      const confirmed = (this.settings.areaLabels || {})[b.key];
      if (confirmed && names.has(confirmed.area.toLowerCase())) {
        b.area = names.get(confirmed.area.toLowerCase());
        b.areaStatus = 'confirmed';
        b.areaWhy = [];
        continue;
      }
      const votes = new Map();
      const offer = (area, p, why) => {
        const cur = votes.get(area);
        if (!cur || p > cur.p) votes.set(area, { p, why });
      };
      const bTokens = uniqTokens(b.title);
      const bNorm = norm(b.title);
      const lowerTags = b.tags.map(t => t.toLowerCase());

      for (const a of areas) {
        const tg = lowerTags.find(t => a.tags.some(x => t === x || t.startsWith(x + '/')));
        if (tg) offer(a.name, 0.95, `#${tg} is listed under ${a.name}`);
      }
      const hist = new Map();
      let total = 0;
      let n = 0;
      for (const e of entries) {
        if (e.key === b.key || !e.tokens.length) continue;
        const sim = e.norm === bNorm ? 1 : similarity(bTokens, e.tokens);
        if (sim < HISTORY_SIM_MIN) continue;
        total += sim;
        n++;
        bump(hist, e.area, sim);
      }
      for (const [area, w] of hist) offer(area, 0.9 * (w / total), `you put ${plural(n, 'similar block')} in ${area}`);
      for (const a of areas) {
        const hit = a.words.find(w => bTokens.some(x => sameWord(w, x)));
        if (hit) offer(a.name, 0.8, `"${hit}" sounds like ${a.name}`);
      }
      for (const t of lowerTags) {
        const counts = tagAreas.get(t);
        if (!counts) continue;
        const sum = [...counts.values()].reduce((x, y) => x + y, 0);
        for (const [area, c] of counts) offer(area, 0.75 * (c / sum), `#${t} is usually ${area} for you`);
      }
      if (!votes.size && defaultArea && (b.tasks.length || b.tags.length)) offer(defaultArea, 0.55, 'attached to a task');

      let best = null;
      for (const [area, v] of votes) if (names.has(area.toLowerCase()) && (!best || v.p > best.p)) best = { area, ...v };
      if (best && best.p >= 0.5) {
        b.area = names.get(best.area.toLowerCase());
        b.areaStatus = 'suggested';
        b.areaWhy = [best.why];
      } else {
        b.area = null;
        b.areaStatus = 'open';
        b.areaWhy = [];
      }
    }
    return report;
  }

  async setArea(report, block, area) {
    this.settings.areaLabels = this.settings.areaLabels || {};
    if (!area) delete this.settings.areaLabels[block.key];
    else this.settings.areaLabels[block.key] = { area, title: block.title, tags: block.tags };
    await this.saveSettings();
    this.assignAreas(report);
    this.refreshBlocks();
  }

  async annotate(report, block, choice) {
    if (!choice) {
      delete this.settings.annotations[block.key];
    } else {
      const parts = choiceParts(choice);
      this.settings.annotations[block.key] = {
        kind: choice.kind,
        task: choice.kind === 'task' ? choice.task.key : undefined,
        taskDesc: choice.kind === 'task' ? choice.task.desc : undefined,
        taskPath: choice.kind === 'task' ? choice.task.path : undefined,
        tasks: choice.kind === 'mix' ? parts.tasks.map(t => ({ key: t.key, desc: t.desc, path: t.path, tags: t.tags })) : undefined,
        extraTags: choice.kind === 'mix' ? parts.tags : undefined,
        // All tags involved, for learning and grouping.
        tags: [...new Set([...parts.tasks.flatMap(t => t.tags), ...parts.tags])],
        title: block.title,
        date: block.date,
      };
    }
    await this.saveSettings();
    this.rescore(report);
    this.refreshBlocks();
  }

  async buildReport(offset = 0, anchor = null) {
    const { start, end } = await this.weekBounds(offset, anchor);
    const [blocks, tasks] = await Promise.all([
      this.collectBlocks(start, end),
      this.collectTasks(start.format('YYYY-MM-DD')),
    ]);
    return this.rescore({ start, end, blocks, tasks, tagCounts: this.collectVaultTags() });
  }

  // ---- Colours -------------------------------------------------------------

  /**
   * Colour slots for a dimension, keyed by category. Colour follows the category,
   * not this week's ranking: grouping values use their order in settings;
   * tags/calendars/tasks keep the slot they were first given (stored in the data
   * file), and when all 8 are taken the least recently seen one is reused.
   */
  colorsFor(report, dim) {
    if (!dim || dim.id === 'none') return null;
    const slots = new Map();
    const custom = new Map();
    if (dim.id === 'area') {
      // Areas take palette colours in their listed order: consecutive slots are the
      // validated neighbour pairs, so a stack of areas stays easy to tell apart.
      parseAreas(this.settings.areas).forEach((a, i) => slots.set(a.name, i + 1));
      return { dim, slots, custom };
    }
    const theme = typeof document !== 'undefined' && document.body.classList.contains('theme-dark') ? 'dark' : 'light';
    if (dim.group) {
      for (const v of dim.group.values) {
        const c = v.aliases.map(a => this.tagColor(a)).find(Boolean);
        if (c) custom.set(v.name, c);
      }
      // Values without a tag colour take palette colours, in settings order, each the
      // free one furthest from what's already used. Deterministic, so colours stay put.
      const onScreen = [...custom.values()];
      let free = [...Array(SLOTS).keys()].map(i => i + 1);
      for (const v of dim.group.values) {
        if (custom.has(v.name) || !free.length) continue;
        const n = furthestSlot(free, onScreen, theme);
        slots.set(v.name, n);
        onScreen.push(SLOT_HEX[theme][n - 1]);
        free = free.filter(x => x !== n);
      }
      return { dim, slots, custom };
    }
    if (dim.id === 'tag') {
      for (const b of report.blocks) for (const c of blockCategories(b, dim)) {
        if (c.key !== '~' && !custom.has(c.key)) {
          const col = this.tagColor(c.key);
          if (col) custom.set(c.key, col);
        }
      }
    }
    const hours = new Map();
    // Palette slots only for categories without a colour of their own.
    for (const b of report.blocks) for (const c of blockCategories(b, dim)) if (c.key !== '~' && !custom.has(c.key)) bump(hours, c.key, b.hours * c.share);
    const onScreen = [...custom.values()];
    const all = (this.settings.colors = this.settings.colors || {});
    const store = (all[dim.id] = all[dim.id] || {});
    const week = report.start.format('YYYY-MM-DD');
    let changed = false;
    for (const key of [...hours.keys()].sort((a, b) => hours.get(b) - hours.get(a))) {
      if (!store[key]) {
        const used = new Set(Object.values(store).map(e => e.slot));
        const free = [...Array(SLOTS).keys()].map(i => i + 1).filter(n => !used.has(n));
        // The free palette colour furthest from your tag colours and the others shown.
        let slot = free.length ? furthestSlot(free, onScreen, theme) : undefined;
        if (!slot) {
          const victim = Object.entries(store)
            .filter(([k]) => !hours.has(k))
            .sort((a, b) => a[1].seen.localeCompare(b[1].seen))[0];
          if (!victim) continue; // more than 8 categories this week: the rest fold into "Other"
          slot = victim[1].slot;
          delete store[victim[0]];
        }
        store[key] = { slot, seen: week };
        changed = true;
        onScreen.push(SLOT_HEX[theme][slot - 1]);
      } else if (store[key].seen < week) {
        store[key].seen = week;
        changed = true;
      }
      slots.set(key, store[key].slot);
    }
    if (changed) this.saveSettings();
    return { dim, slots, custom };
  }

  /**
   * The colour a tag already shows in this vault (Colored Tags plugin, CSS snippets,
   * themes), read from a hidden tag pill; null if it only has the theme's default.
   */
  tagColor(tag) {
    if (!this.settings.useTagColors || typeof document === 'undefined') return null;
    if (!this.probeHost) {
      this.probeHost = document.body.createDiv({ cls: 'markdown-preview-view markdown-rendered wtl-probe' });
    }
    const read = t => {
      const a = this.probeHost.createEl('a', { cls: 'tag', text: `#${t}`, href: `#${t}` });
      const cs = getComputedStyle(a);
      const out = [cs.backgroundColor, cs.color];
      a.remove();
      return out;
    };
    if (!this.tagBaseline) this.tagBaseline = read('wtl-probe-no-such-tag');
    this.tagColorCache = this.tagColorCache || new Map();
    if (this.tagColorCache.has(tag)) return this.tagColorCache.get(tag);
    let best = null;
    for (const t of [tag, tag.toLowerCase()]) {
      const [bg, fg] = read(t);
      // Use whichever of pill background / text differs from the default and is most colourful.
      let bestChroma = 0.12;
      for (const [c, base] of [[bg, this.tagBaseline[0]], [fg, this.tagBaseline[1]]]) {
        if (c === base) continue;
        const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
        if (!m || (m[4] !== undefined && Number(m[4]) === 0)) continue;
        const [r, g, b] = [m[1], m[2], m[3]].map(Number);
        const chroma = (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
        if (chroma > bestChroma) { bestChroma = chroma; best = `rgb(${r}, ${g}, ${b})`; }
      }
      if (best) break;
    }
    this.tagColorCache.set(tag, best);
    return best;
  }

  // ---- Export --------------------------------------------------------------

  toCsv(report) {
    const groups = parseTagGroups(this.settings.tagGroups);
    const header = ['week_start', 'date', 'weekday', 'start', 'end', 'hours', 'block', 'calendar',
      'area', 'area_status', 'label', 'task', 'task_file', 'tags', ...groups.map(g => g.name.toLowerCase()),
      'task_scheduled', 'task_due', 'task_done', 'status', 'confidence', 'why'];
    const rows = report.blocks.map(b => {
      // Several tasks: '; '-separated, in the same order in every task_* column.
      const ts = b.tasks || [];
      const col = f => (ts.some(t => f(t)) ? ts.map(f).join('; ') : '');
      return [
        report.start.format('YYYY-MM-DD'), b.date, b.start.format('ddd'),
        b.start.format('HH:mm'), b.end.format('HH:mm'), b.hours.toFixed(2), b.title, b.calendar,
        b.area || '', b.area ? b.areaStatus : '', b.choice ? b.choice.kind : '', col(t => t.desc), col(t => t.path || ''), b.tags.map(x => '#' + x).join(' '),
        ...groups.map(g => tagValue(b.tags, g) || ''),
        col(t => t.scheduled || ''), col(t => t.due || ''), col(t => (t.done ? 'yes' : 'no')),
        b.status,
        b.status === 'suggested' && b.choice.score != null ? Math.min(1, b.choice.score).toFixed(2) : '',
        b.status === 'suggested' ? (b.choice.reasons || []).join('; ') : '',
      ];
    });
    return [header, ...rows].map(r => r.map(csvCell).join(',')).join('\n') + '\n';
  }

  csvPath(start) {
    const folder = normalizePath(this.settings.exportFolder || 'Time Logs');
    return { folder, path: normalizePath(`${folder}/Time Log ${start.format('YYYY-MM-DD')}.csv`) };
  }

  /** Writes the week's CSV; skips the write when nothing changed. */
  async exportCsv(report, { quiet = false } = {}) {
    const { folder, path } = this.csvPath(report.start);
    if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
    const csv = this.toCsv(report);
    const existing = this.app.vault.getAbstractFileByPath(path);
    let changed = true;
    if (existing instanceof TFile) {
      changed = (await this.app.vault.read(existing)) !== csv;
      if (changed) await this.app.vault.modify(existing, csv);
    } else {
      await this.app.vault.create(path, csv);
    }
    if (!quiet) {
      const pending = report.blocks.filter(needsReview).length;
      new Notice(`Time log ${changed ? 'exported' : 'already up to date'}: ${path}` +
        (pending ? ` (${plural(pending, 'block')} not yet reviewed)` : ''));
    }
    return { path, changed };
  }
};

// ---------------------------------------------------------------------------
// Typed label picker: suggestions while you type, or create a new tag

/** Everything one block can be labeled with; its own suggestions first. */
function labelItems(report, b) {
  const items = [];
  const seen = new Set();
  const push = (choice, extra = {}) => {
    const v = choiceValue(choice);
    if (seen.has(v)) return;
    seen.add(v);
    items.push({ choice, ...extra });
  };
  if (b.suggestion) push(b.suggestion, { suggested: true, reasons: b.suggestion.reasons });
  for (const c of b.candidates.slice(0, 5)) push({ kind: 'task', task: c.task }, { likely: true, reasons: c.reasons });
  for (const t of b.tagRank.slice(0, 3)) push({ kind: 'tag', tags: [t.tag] }, { likely: true, reasons: [t.why] });
  // Tasks planned for that day are likely even when the title doesn't match.
  for (const t of report.tasks.filter(t => t.scheduled === b.date).slice(0, 3)) {
    push({ kind: 'task', task: t }, { likely: true, reasons: ['scheduled that day'] });
  }
  push({ kind: 'none' }, { likely: true });
  for (const t of report.tasks) push({ kind: 'task', task: t });
  for (const tg of report.tagVocab) push({ kind: 'tag', tags: [tg] }, { count: report.tagCount ? report.tagCount(tg) : 0 });
  return items;
}

function itemSearchText(it) {
  const c = it.choice;
  if (c.kind === 'task') return c.task.desc; // by name only, so "#meeting" never matches a task
  if (c.kind === 'tag') return c.tags.join(' ');
  return 'Not task work';
}

/** "Grant reporting" -> "grant_reporting"; Obsidian tags can't contain spaces. */
function normalizeTag(text) {
  return text.trim().replace(/^#+/, '').replace(/\s+/g, '_').replace(/[^\p{L}\p{N}_/-]/gu, '');
}

/**
 * Pure ranking, separate from the UI so it is easy to test. `picked` holds the
 * chips already in the field: they're left out, and "Use …" saves them.
 */
function rankLabels(items, query, picked = { tasks: [], tags: [] }) {
  const q = query.trim();
  const pickedTasks = new Set(picked.tasks.map(t => t.key));
  const pickedTags = new Set(picked.tags.map(t => t.toLowerCase()));
  const any = picked.tasks.length + picked.tags.length > 0;
  const pool = items.filter(i => {
    const c = i.choice;
    if (c.kind === 'task') return !pickedTasks.has(c.task.key);
    if (c.kind === 'tag') return c.tags.length === 1 ? !pickedTags.has(c.tags[0].toLowerCase()) : !any;
    return !any; // "not task work" and multi-part suggestions only on an empty field
  });

  let out;
  if (!q) {
    out = pool.filter(i => i.suggested || i.likely);
  } else {
    const wantsTag = q.startsWith('#');
    const qq = q.replace(/^#+/, '').toLowerCase();
    const fuzzy = prepareFuzzySearch(qq);
    const hits = [];
    for (const it of pool) {
      if (wantsTag && it.choice.kind !== 'tag') continue;
      const text = itemSearchText(it).toLowerCase();
      const f = fuzzy(text);
      if (!f) continue;
      // What you typed decides; suggestions and usage only break ties.
      let score = f.score;
      if (text === qq) score += 4;
      else if (text.startsWith(qq)) score += 3;
      else if (text.split(/[\s/_-]+/).some(w => w.startsWith(qq))) score += 2;
      else if (text.includes(qq)) score += 1;
      score += (it.suggested ? 0.3 : it.likely ? 0.15 : 0) + (it.count ? Math.min(0.3, Math.log10(1 + it.count) / 6) : 0);
      hits.push({ it, score });
    }
    hits.sort((a, b) => b.score - a.score);
    out = hits.map(h => h.it).slice(0, 30);
    const tag = normalizeTag(q);
    const exists = items.some(i => i.choice.kind === 'tag' && i.choice.tags.length === 1 && i.choice.tags[0].toLowerCase() === tag.toLowerCase());
    if (tag && !exists && !pickedTags.has(tag.toLowerCase())) {
      const create = { choice: { kind: 'tag', tags: [tag] }, create: true };
      // A leading "#" means "this is a tag": offer creating it first, unless an existing tag matches.
      const tagHit = out.some(i => i.choice.kind === 'tag');
      if (!out.length || (q.startsWith('#') && !tagHit)) out.unshift(create); else out.push(create);
    }
  }
  // Save what's picked: first when nothing is being typed (Enter saves), last otherwise.
  if (any) {
    const use = { choice: makeChoice(picked.tasks, picked.tags), commit: true };
    if (q) out.push(use); else out.unshift(use);
  }
  return out;
}

/**
 * Label field: tasks and tags you pick become chips; nothing is saved until
 * "Use …" (Enter on an empty field). Backspace removes the last chip.
 * `replaceable`: the starting chips are only a suggestion, so the first pick replaces them.
 */
class LabelPicker {
  constructor(app, parent, items, initial, onCommit, { placeholder = 'Add a task or #tag…', replaceable = false } = {}) {
    this.items = items;
    this.initial = initial;
    this.onCommit = onCommit;
    this.replaceable = replaceable;
    this.wrap = parent.createDiv({ cls: 'wtl-picker-wrap' });
    this.el = this.wrap.createDiv({ cls: 'wtl-picker' });
    this.chipsEl = this.el.createSpan({ cls: 'wtl-chips' });
    this.input = this.el.createEl('input', { type: 'text', cls: 'wtl-picker-input', attr: { placeholder, spellcheck: 'false' } });
    // Shown while there are unsaved changes; nothing is ever dropped silently.
    this.saveBtn = this.wrap.createEl('button', { cls: 'wtl-picker-save mod-cta', text: '✓' });
    this.saveBtn.setAttr('aria-label', 'Save label (Enter on an empty field)');
    this.saveBtn.onclick = e => { e.stopPropagation(); this.commit(makeChoice(this.tasks, this.tags)); };
    this.reset();
    this.suggest = new LabelSuggest(app, this.input, this);
    this.input.addEventListener('keydown', e => {
      if (e.key === 'Backspace' && !this.input.value && (this.tasks.length || this.tags.length)) {
        e.preventDefault();
        if (this.tags.length) this.tags.pop(); else this.tasks.pop();
        this.untouched = false;
        this.changed();
      } else if (e.key === 'Escape' && this.isDirty()) {
        e.preventDefault();
        e.stopPropagation();
        this.input.value = '';
        this.reset();
      } else if (e.key === 'Enter' && !this.suggest.isOpen) {
        // The list is closed: Enter still does the obvious thing.
        e.preventDefault();
        if (this.input.value.trim()) {
          const best = this.suggest.getSuggestions(this.input.value).find(i => !i.commit);
          if (best && best.choice.kind !== 'none') this.add(best.choice);
        } else if (this.isDirty()) {
          this.commit(makeChoice(this.tasks, this.tags));
        }
      }
    });
    this.el.addEventListener('click', () => this.input.focus());
  }

  isDirty() {
    if (this.input.value.trim()) return true;
    if (this.untouched) return false;
    const now = makeChoice(this.tasks, this.tags);
    return choiceValue(now) !== choiceValue(this.initial);
  }

  reset() {
    const p = choiceParts(this.initial);
    this.tasks = [...p.tasks];
    this.tags = [...p.tags];
    this.untouched = true;
    this.renderChips();
  }

  renderChips() {
    this.chipsEl.empty();
    this.wrap.toggleClass('is-dirty', !this.untouched && choiceValue(makeChoice(this.tasks, this.tags)) !== choiceValue(this.initial));
    this.el.toggleClass('is-pending', this.replaceable && this.untouched && !!(this.tasks.length || this.tags.length));
    const chip = (text, cls, onRemove) => {
      const c = this.chipsEl.createSpan({ cls: `wtl-chip ${cls}` });
      c.createSpan({ text });
      const x = c.createSpan({ cls: 'wtl-chip-x', text: '×' });
      x.setAttr('aria-label', 'Remove');
      x.onclick = e => { e.stopPropagation(); onRemove(); this.untouched = false; this.changed(); };
    };
    for (const t of this.tasks) chip(t.desc, 'is-task', () => { this.tasks = this.tasks.filter(x => x !== t); });
    for (const tg of this.tags) chip(`#${tg}`, 'is-tag', () => { this.tags = this.tags.filter(x => x !== tg); });
  }

  changed() {
    this.renderChips();
    this.input.focus();
    this.input.dispatchEvent(new Event('input'));
  }

  add(choice) {
    if (this.replaceable && this.untouched) { this.tasks = []; this.tags = []; }
    this.untouched = false;
    const p = choiceParts(choice);
    for (const t of p.tasks) if (!this.tasks.some(x => x.key === t.key)) this.tasks.push(t);
    for (const tg of p.tags) if (!this.tags.some(x => x.toLowerCase() === tg.toLowerCase())) this.tags.push(tg);
    this.input.value = '';
    this.changed();
  }

  commit(choice) {
    this.suggest.close();
    this.onCommit(choice);
  }
}

class LabelSuggest extends AbstractInputSuggest {
  constructor(app, inputEl, picker) {
    super(app, inputEl);
    this.picker = picker;
    this.limit = 40;
    // Show suggestions as soon as the field is focused.
    inputEl.addEventListener('focus', () => inputEl.dispatchEvent(new Event('input')));
  }

  open() {
    super.open();
    this.isOpen = true;
  }

  close() {
    super.close();
    this.isOpen = false;
  }

  getSuggestions(query) {
    const p = this.picker;
    // Untouched suggestion chips are about to be replaced, so don't treat them as picked.
    const picked = p.replaceable && p.untouched ? { tasks: [], tags: [] } : { tasks: p.tasks, tags: p.tags };
    return rankLabels(p.items, query, picked);
  }

  renderSuggestion(it, el) {
    el.addClass('wtl-suggest-item');
    const top = el.createDiv({ cls: 'wtl-suggest-top' });
    const c = it.choice;
    if (it.commit) {
      top.createSpan({ cls: 'wtl-suggest-use', text: `Use: ${choiceLabel(c)}` });
      top.createSpan({ cls: 'wtl-review-meta', text: '  Enter' });
    } else if (it.create) {
      top.createSpan({ text: `Create #${c.tags[0]}` });
    } else if (c.kind === 'task') {
      top.createSpan({ text: c.task.desc });
      const meta = [];
      if (c.task.tags.length) meta.push(hashes(c.task.tags));
      if (c.task.scheduled) meta.push(`⏳ ${c.task.scheduled}`);
      if (meta.length) top.createSpan({ cls: 'wtl-review-meta', text: '  ' + meta.join('  ') });
    } else if (c.kind === 'tag') {
      top.createSpan({ text: hashes(c.tags) });
      if (it.count) top.createSpan({ cls: 'wtl-review-meta', text: `  used ${it.count}×` });
    } else {
      top.createSpan({ text: 'Not task work' });
    }
    if (it.suggested) top.createSpan({ cls: 'wtl-badge wtl-badge-suggested', text: 'suggested' });
    if (it.reasons && it.reasons.length) el.createDiv({ cls: 'wtl-review-why', text: it.reasons.join(' · ') });
  }

  selectSuggestion(it) {
    if (it.commit) return this.picker.commit(it.choice);
    if (it.choice.kind === 'none') return this.picker.commit(it.choice);
    // Tasks and tags stack as chips; "Use …" saves.
    this.picker.add(it.choice);
  }
}

// ---------------------------------------------------------------------------
// View

class TimeLogView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.offset = 0;
    this.report = null;
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return 'Weekly time log'; }
  getIcon() { return 'clock'; }

  async onOpen() {
    this.contentEl.addClass('wtl-view');
    await this.refresh();
  }

  /** True while a label field in this view has focus (or unsaved chips). */
  editing() {
    const a = document.activeElement;
    return !!(a && this.contentEl.contains(a) && a.closest('.wtl-picker-wrap'))
      || !!this.contentEl.querySelector('.wtl-picker-wrap.is-dirty');
  }

  /** Background redraws (theme/colour changes, other views) wait until you're done editing. */
  deferIfEditing(fn) {
    if (!this.editing()) return false;
    this.deferred = fn;
    if (!this.deferWatch) {
      this.deferWatch = true;
      this.registerDomEvent(this.contentEl, 'focusout', () => window.setTimeout(() => {
        if (this.deferred && !this.editing()) { const f = this.deferred; this.deferred = null; f(); }
      }, 50));
    }
    return true;
  }

  async refresh(force = false) {
    if (!force && this.deferIfEditing(() => this.refresh(true))) return;
    const root = this.contentEl;
    root.empty();
    this.renderNav(root, null);
    root.createDiv({ cls: 'wtl-muted', text: 'Loading…' });
    try {
      this.report = await this.plugin.buildReport(this.offset);
      this.render();
    } catch (e) {
      console.error(e);
      root.empty();
      this.renderNav(root, null);
      root.createDiv({ cls: 'wtl-error', text: e.message });
    }
  }

  rerender(force = false) {
    if (!force && this.deferIfEditing(() => this.rerender(true))) return;
    const top = this.contentEl.scrollTop;
    this.render();
    this.contentEl.scrollTop = top;
  }

  review() {
    this.plugin.openReview(this.report, () => this.rerender(true));
  }

  /** Re-save the CSV a moment after the last edit in the table. */
  scheduleSave() {
    window.clearTimeout(this.saveTimer);
    const report = this.report;
    this.saveTimer = window.setTimeout(() => this.plugin.autoSave(report), 2000);
  }

  async acceptAll() {
    // Snapshot first: each confirmation re-scores the rest of the week.
    const pending = this.report.blocks.filter(b => b.status === 'suggested').map(b => [b, b.suggestion, b.areaStatus === 'suggested' ? b.area : null]);
    for (const [b, s, area] of pending) {
      await this.plugin.annotate(this.report, b, s);
      if (area) await this.plugin.setArea(this.report, b, area);
    }
    new Notice(`Confirmed ${plural(pending.length, 'suggestion')}.`);
    this.rerender(true);
    this.scheduleSave();
  }

  renderNav(root, report) {
    const nav = root.createDiv({ cls: 'wtl-nav' });
    const btn = (text, onClick, cls) => {
      const b = nav.createEl('button', { text, cls });
      b.onclick = onClick;
      return b;
    };
    btn('‹', () => { this.offset--; this.refresh(); }).setAttr('aria-label', 'Previous week');
    nav.createDiv({
      cls: 'wtl-title',
      text: report ? `${report.start.format('MMM D')} – ${report.end.clone().subtract(1, 'day').format('MMM D, YYYY')}` : 'Weekly time log',
    });
    btn('›', () => { this.offset++; this.refresh(); }).setAttr('aria-label', 'Next week');
    nav.createDiv({ cls: 'wtl-spacer' });
    if (this.offset !== 0) btn('This week', () => { this.offset = 0; this.refresh(); });
    btn('Refresh', () => this.refresh());
    if (report) {
      const pending = report.blocks.filter(needsReview).length;
      if (pending) btn(`Review ${pending}`, () => this.review(), 'mod-cta');
      btn('Export CSV', () => this.plugin.exportCsv(report));
    }
  }

  render() {
    const report = this.report;
    const root = this.contentEl;
    root.empty();
    this.renderNav(root, report);

    const sum = bs => bs.reduce((a, b) => a + b.hours, 0);
    const total = sum(report.blocks);
    const confirmed = report.blocks.filter(b => b.status === 'confirmed');
    const suggested = report.blocks.filter(b => b.status === 'suggested');
    const open = report.blocks.filter(b => b.status === 'open');

    const tiles = root.createDiv({ cls: 'wtl-tiles' });
    const tile = (label, value, sub) => {
      const t = tiles.createDiv({ cls: 'wtl-tile' });
      t.createDiv({ cls: 'wtl-tile-label', text: label });
      t.createDiv({ cls: 'wtl-tile-value', text: value });
      if (sub) t.createDiv({ cls: 'wtl-tile-sub', text: sub });
      return t;
    };
    tile('Total logged', `${fmtHours(total)} h`, plural(report.blocks.length, 'block'));
    tile('Confirmed', `${fmtHours(sum(confirmed))} h`, total ? `${Math.round((sum(confirmed) / total) * 100)}% of time` : '—');
    const toReview = report.blocks.filter(needsReview).length;
    const rev = tile('To review', String(toReview),
      `${suggested.length} suggested · ${open.length} unattached`);
    if (toReview) {
      rev.addClass('is-clickable');
      rev.onclick = () => this.review();
    }

    if (!report.blocks.length) {
      root.createDiv({
        cls: 'wtl-muted',
        text: this.plugin.calendarSettled()
          ? 'No timed calendar blocks this week. Check the calendars selected in settings.'
          : 'Waiting for your calendar to load…',
      });
      return;
    }

    this.tooltip = root.createDiv({ cls: 'wtl-tooltip' });
    const charts = root.createDiv({ cls: 'wtl-charts' });
    this.renderGrouped(charts.createDiv({ cls: 'wtl-card wtl-card-wide' }), report);
    this.renderByDay(charts.createDiv({ cls: 'wtl-card' }), report);
    this.renderTimelineCard(charts.createDiv({ cls: 'wtl-card wtl-card-wide' }), report);
    this.renderTable(root.createDiv({ cls: 'wtl-card' }), report);
  }

  hover(el, text) {
    el.addEventListener('mousemove', e => {
      this.tooltip.setText(text);
      this.tooltip.addClass('is-visible');
      const r = this.contentEl.getBoundingClientRect();
      this.tooltip.style.left = `${e.clientX - r.left + this.contentEl.scrollLeft + 12}px`;
      this.tooltip.style.top = `${e.clientY - r.top + this.contentEl.scrollTop + 12}px`;
    });
    el.addEventListener('mouseleave', () => this.tooltip.removeClass('is-visible'));
  }

  renderGrouped(card, report) {
    const dim = findDimension(this.plugin.settings, this.plugin.settings.view);
    const head = card.createDiv({ cls: 'wtl-card-head' });
    head.createEl('h4', { text: `Hours by ${dim.label.toLowerCase()}` });
    const seg = head.createDiv({ cls: 'wtl-seg' });
    for (const d of dimensions(this.plugin.settings)) {
      const b = seg.createEl('button', { text: d.label, cls: d.id === dim.id ? 'is-active' : '' });
      b.onclick = async () => {
        this.plugin.settings.view = d.id;
        await this.plugin.saveSettings();
        this.rerender(true);
      };
    }
    if (dim.id === 'tag' && report.blocks.some(b => b.tags.length > 1)) {
      const total = report.blocks.reduce((a, b) => a + b.hours, 0);
      card.createDiv({ cls: 'wtl-muted', text: `Blocks with several tags count under each tag, so this view adds up to more than the ${fmtHours(total)} h total.` });
    }
    if (!parseTagGroups(this.plugin.settings.tagGroups).length) {
      card.createDiv({ cls: 'wtl-muted', text: 'Tip: define groupings like Project or Role in settings to roll tags up.' });
    }
    // Groups start expanded; remember what you collapse while the view is open.
    this.collapsed = this.collapsed || new Set();
    renderTree(card, buildTree(report.blocks, dim), {
      isOpen: k => !this.collapsed.has(`${dim.id}|${k}`),
      toggle: k => {
        const key = `${dim.id}|${k}`;
        if (this.collapsed.has(key)) this.collapsed.delete(key); else this.collapsed.add(key);
      },
      tip: (el, text) => this.hover(el, text),
      openTask: t => this.openTask(t),
    });
  }

  currentColors(report) {
    // Daily views always show areas: a handful of colours, and every hour counts.
    return this.plugin.colorsFor(report, findDimension(this.plugin.settings, 'area'));
  }

  renderByDay(card, report) {
    const color = this.currentColors(report);
    card.createEl('h4', { text: `Hours by day${color ? `, by ${color.dim.label.toLowerCase()}` : ''}` });
    renderDays(card, report, (el, text) => this.hover(el, text), color);
  }

  renderTimelineCard(card, report) {
    card.createEl('h4', { text: 'When you worked' });
    renderTimeline(card, report, (el, text) => this.hover(el, text), this.currentColors(report));
    this.timelineBreakdown = this.timelineBreakdown || {};
    renderBreakdown(card, report, this.plugin.settings, this.timelineBreakdown, {
      colorsFor: d => this.plugin.colorsFor(report, d),
      tip: (el, text) => this.hover(el, text),
      openTask: t => this.openTask(t),
    });
  }

  renderTable(card, report) {
    const head = card.createDiv({ cls: 'wtl-card-head' });
    head.createEl('h4', { text: 'Blocks' });
    if (report.blocks.some(b => b.status === 'suggested')) {
      const b = head.createEl('button', { text: 'Accept all suggestions' });
      b.onclick = () => this.acceptAll();
    }
    card.createDiv({ cls: 'wtl-muted', text: 'Type a task or #tag in Label (new tags are fine), or ✓ to accept the suggestion. Suggestions learn from what you confirm.' });
    const wrap = card.createDiv({ cls: 'wtl-table-wrap' });
    const table = wrap.createEl('table', { cls: 'wtl-table' });
    const tr0 = table.createEl('thead').createEl('tr');
    for (const h of ['Day', 'Time', 'Block', 'Hours', 'Area', 'Label', 'Status']) tr0.createEl('th', { text: h });
    const areaNames = parseAreas(this.plugin.settings.areas).map(a => a.name);
    const body = table.createEl('tbody');

    for (const b of report.blocks) {
      const tr = body.createEl('tr');
      tr.createEl('td', { text: b.start.format('ddd D') });
      tr.createEl('td', { text: `${b.start.format('h:mm')}–${b.end.format('h:mma')}` });
      tr.createEl('td', { text: b.title });
      tr.createEl('td', { text: fmtHours(b.hours), cls: 'wtl-num' });

      // Area: a short fixed list, so a plain dropdown. Suggested areas show in italics.
      const ac = tr.createEl('td', { cls: 'wtl-area-cell' });
      const sel = ac.createEl('select', { cls: 'dropdown wtl-area-select' + (b.areaStatus === 'confirmed' ? '' : ' is-pending') });
      sel.createEl('option', { text: 'Unsorted', value: '' });
      for (const n of areaNames) sel.createEl('option', { text: n, value: n });
      sel.value = b.area || '';
      if (b.areaWhy && b.areaWhy.length) sel.setAttr('aria-label', `Suggested: ${b.areaWhy.join('; ')}`);
      sel.onchange = async () => {
        await this.plugin.setArea(report, b, sel.value || null);
        this.rerender(true);
        this.scheduleSave();
      };

      const cell = tr.createEl('td', { cls: 'wtl-label-cell' });
      new LabelPicker(this.app, cell, labelItems(report, b), b.choice, async choice => {
        await this.plugin.annotate(report, b, choice);
        this.rerender(true);
        this.scheduleSave();
      }, { placeholder: b.choice ? '' : 'Add a task or #tag…', replaceable: b.status !== 'confirmed' });
      if (b.status === 'confirmed' && b.suggestion && choiceValue(b.suggestion) !== choiceValue(b.choice)) {
        const reset = cell.createEl('button', { cls: 'wtl-accept clickable-icon', text: '↺' });
        reset.setAttr('aria-label', `Forget my label (suggestion: ${choiceLabel(b.suggestion)})`);
        reset.onclick = async () => {
          await this.plugin.annotate(report, b, null);
          this.rerender(true);
          this.scheduleSave();
        };
      }

      const st = tr.createEl('td', { cls: 'wtl-status' });
      const badge = st.createSpan({ cls: `wtl-badge wtl-badge-${b.status}`, text: b.status === 'open' ? 'unattached' : b.status });
      if (b.status === 'suggested') {
        badge.setAttr('aria-label', (b.choice.reasons || []).join('\n'));
        const ok = st.createEl('button', { cls: 'wtl-accept', text: '✓' });
        ok.setAttr('aria-label', 'Accept suggestion');
        ok.onclick = async () => {
          const area = b.areaStatus === 'suggested' ? b.area : null;
          await this.plugin.annotate(report, b, b.suggestion);
          if (area) await this.plugin.setArea(report, b, area);
          this.rerender(true);
          this.scheduleSave();
        };
      }
    }
  }

  taskLabel(t) {
    const bits = [t.desc];
    if (t.scheduled) bits.push(`⏳ ${t.scheduled}`);
    else if (t.due) bits.push(`📅 ${t.due}`);
    if (t.done) bits.push('✅');
    if (t.ghost) bits.push('(no longer found)');
    return bits.join('  ');
  }

  async openTask(task) {
    const file = this.app.vault.getAbstractFileByPath(task.path);
    if (!(file instanceof TFile)) return;
    await this.app.workspace.getLeaf(false).openFile(file, { eState: { line: task.line } });
  }
}

// ---------------------------------------------------------------------------
// ```time-log``` block for weekly notes
//
//   week: this | last | 2026-09-28 | 2026-W40   (default: from the note's filename, else this week)
//   group: Project | Role | tag | task | calendar | none   (default: last view picked in the full log)
//   show: full | chart | hours | days | timeline | agenda (default: full)
//   from: today                                  (agenda: hide days before today)
//   buttons: false                               (hide Review / Export / Open full log)

/**
 * Returns { anchor } for dates / this / last, { year, week } for week numbers
 * ("2026-W40", "W40", "Week 40"), or null. Week numbers are turned into dates
 * later using the week-start setting. `year` fills in references without one.
 */
function parseWeekRef(ref, year = null) {
  if (!ref) return null;
  const r = String(ref).trim().toLowerCase();
  if (r === 'this') return { anchor: moment() };
  if (r === 'last') return { anchor: moment().subtract(7, 'days') };
  let m = r.match(/(\d{4})[-\s_.]*w(\d{1,2})\b/);
  if (m) return { year: Number(m[1]), week: Number(m[2]) };
  m = r.match(/\d{4}-\d{2}-\d{2}/);
  if (m) return { anchor: moment(m[0], 'YYYY-MM-DD') };
  m = r.match(/(?:^|[^a-z0-9])w(?:eek)?\s*(\d{1,2})\b/);
  if (m) return { year: Number(year) || moment().year(), week: Number(m[1]) };
  return null;
}

class TimeLogBlock extends MarkdownRenderChild {
  constructor(plugin, el, source, sourcePath) {
    super(el);
    this.plugin = plugin;
    this.opts = {};
    for (const line of source.split('\n')) {
      const m = line.match(/^\s*([\w-]+)\s*:\s*(.+?)\s*$/);
      if (m) this.opts[m[1].toLowerCase()] = m[2];
    }
    this.sourcePath = sourcePath || '';
  }

  /** Week from: block option, note property, filename, folder path; else today. */
  resolveWeek() {
    const path = this.sourcePath;
    const name = path.split('/').pop().replace(/\.md$/, '');
    const pathYear = (path.match(/(?:^|\/)(\d{4})(?:\/|$|[-_ ])/) || [])[1];
    const fm = (this.plugin.app.metadataCache.getCache(path) || {}).frontmatter || {};
    const year = fm.year || pathYear;
    return parseWeekRef(this.opts.week, year)
      || parseWeekRef(fm.week, year) || parseWeekRef(fm.date, year)
      || parseWeekRef(name, year) || parseWeekRef(path, year)
      || { anchor: moment(), guessed: true };
  }

  onload() {
    (this.plugin.liveBlocks = this.plugin.liveBlocks || new Set()).add(this);
    this.render();
  }

  onunload() {
    if (this.plugin.liveBlocks) this.plugin.liveBlocks.delete(this);
  }

  async render() {
    const el = this.containerEl;
    el.empty();
    el.addClass('wtl-block');
    let report;
    try {
      this.week = this.resolveWeek();
      const anchor = this.week.anchor || await this.plugin.weekNumberStart(this.week.year, this.week.week);
      report = await this.plugin.buildReport(0, anchor);
    } catch (e) {
      el.createDiv({ cls: 'wtl-error', text: `Time log: ${e.message}` });
      return;
    }
    // Keep this week's CSV current while the block is on screen. Re-renders on every
    // label change; unchanged CSVs aren't rewritten and empty weeks are never saved.
    if (this.plugin.settings.autoExport && report.blocks.length) {
      try {
        await this.plugin.exportCsv(report, { quiet: true });
      } catch (e) {
        console.warn('Weekly Time Log: CSV save failed', e);
      }
    }
    const { path } = this.plugin.csvPath(report.start);

    const show = (this.opts.show || 'full').toLowerCase();
    if (!report.blocks.length && !this.plugin.calendarSettled()) {
      // Full Calendar is still loading (e.g. right after Obsidian starts); we redraw when it's in.
      el.createDiv({ cls: 'wtl-muted', text: 'Time log: waiting for your calendar to load…' });
      return;
    }
    const settings = this.plugin.settings;
    const areaDim = findDimension(settings, 'area');
    // Daily charts and the one-line summary go by Area unless the block says otherwise;
    // the detailed breakdown uses the grouping picked in the full log.
    const chartDim = this.opts.group ? findDimension(settings, this.opts.group) : areaDim;
    const dim = findDimension(settings, this.opts.group || this.opts.detail || settings.view);
    if (show === 'hours') return this.renderHours(report, chartDim);

    const head = el.createDiv({ cls: 'wtl-block-head' });
    head.createSpan({ cls: 'wtl-block-title', text: 'Time log' });
    head.createSpan({ cls: 'wtl-muted', text: `${report.start.format('MMM D')} – ${report.end.clone().subtract(1, 'day').format('MMM D')}` });
    if (this.week.guessed) {
      head.createSpan({ cls: 'wtl-muted', text: '· current week (add "week: 2026-W40" to pin)' });
    }

    const nativeTip = (node, text) => node.setAttr('aria-label', text);
    // group: none = plain single-colour daily charts
    const color = (this.opts.group || '').toLowerCase() === 'none' ? null : this.plugin.colorsFor(report, chartDim);
    if (show === 'days') {
      renderDays(el, report, nativeTip, color);
      return this.renderFoot(report, path);
    }
    if (show === 'agenda') {
      const areaColor = (this.opts.group || '').toLowerCase() === 'none' ? null : this.plugin.colorsFor(report, areaDim);
      renderAgenda(el, report, nativeTip, areaColor, { fromToday: (this.opts.from || '').toLowerCase() === 'today' });
      return this.renderFoot(report, path);
    }
    this.breakdown = this.breakdown || { dim: this.opts.detail || null };
    if (show === 'timeline') {
      renderTimeline(el, report, nativeTip, color);
      if (report.blocks.length) renderBreakdown(el, report, settings, this.breakdown, { colorsFor: d => this.plugin.colorsFor(report, d) });
      return this.renderFoot(report, path);
    }

    const total = report.blocks.reduce((a, b) => a + b.hours, 0);
    const confirmed = report.blocks.filter(b => b.status === 'confirmed').reduce((a, b) => a + b.hours, 0);
    const pending = report.blocks.filter(needsReview).length;
    const stats = show === 'chart' ? createDiv() : el.createDiv({ cls: 'wtl-block-stats' });
    const stat = (value, label) => {
      const d = stats.createDiv({ cls: 'wtl-block-stat' });
      d.createSpan({ cls: 'wtl-block-stat-value', text: value });
      d.createSpan({ cls: 'wtl-muted', text: label });
    };
    stat(`${fmtHours(total)} h`, 'logged');
    stat(`${fmtHours(confirmed)} h`, 'confirmed');
    stat(String(pending), 'to review');

    if (show === 'full' && report.blocks.length) {
      el.createDiv({ cls: 'wtl-block-sub', text: color ? `By day, by ${chartDim.label.toLowerCase()}` : 'By day' });
      renderDays(el, report, nativeTip, color);
    }

    if (report.blocks.length && show === 'full') {
      // Everything beyond areas is one click away.
      renderBreakdown(el, report, settings, this.breakdown, {
        title: 'Breakdown by area, tag, task…',
        colorsFor: d => this.plugin.colorsFor(report, d),
      });
    } else if (report.blocks.length) {
      el.createDiv({ cls: 'wtl-block-sub', text: `By ${dim.label.toLowerCase()}` });
      this.expanded = this.expanded || new Set();
      renderTree(el, buildTree(report.blocks, dim), {
        isOpen: k => this.expanded.has(k),
        toggle: k => { if (this.expanded.has(k)) this.expanded.delete(k); else this.expanded.add(k); },
        tip: (row, text) => row.setAttr('aria-label', text),
      });
    } else {
      el.createDiv({ cls: 'wtl-muted', text: this.plugin.calendarSettled() ? 'No calendar blocks this week.' : 'Waiting for your calendar to load…' });
    }

    this.renderFoot(report, path);
  }

  showButtons() {
    return String(this.opts.buttons || '').toLowerCase() !== 'false';
  }

  /** Review / Export CSV / Open full log, under every layout (unless "buttons: false"). */
  renderFoot(report, path) {
    if (!this.showButtons()) return;
    const pending = report.blocks.filter(needsReview).length;
    const foot = this.containerEl.createDiv({ cls: 'wtl-block-foot' });
    if (pending) {
      foot.createEl('button', { text: `Review ${pending}`, cls: 'mod-cta' }).onclick = () =>
        this.plugin.openReview(report, () => this.render());
    }
    foot.createEl('button', { text: 'Export CSV' }).onclick = async () => {
      await this.plugin.exportCsv(report);
      this.render();
    };
    foot.createEl('button', { text: 'Open full log' }).onclick = () => this.plugin.openView(report.start);
    const file = this.plugin.app.vault.getAbstractFileByPath(path);
    foot.createSpan({
      cls: 'wtl-muted',
      text: file instanceof TFile ? `Saved ${moment(file.stat.mtime).fromNow()} · ${path}` : 'Not exported yet',
    });
  }

  /** One line: "11.5 h logged · 6 h postdoc · 3 h student · 2 to review" */
  renderHours(report, dim) {
    const el = this.containerEl;
    el.removeClass('wtl-block');
    el.addClass('wtl-block-line');
    const total = report.blocks.reduce((a, b) => a + b.hours, 0);
    const pending = report.blocks.filter(needsReview).length;
    el.createSpan({ cls: 'wtl-line-total', text: `${fmtHours(total)} h` });
    el.createSpan({ text: ' logged' });
    const groups = buildTree(report.blocks, dim).filter(g => !g.muted).slice(0, 4);
    for (const g of groups) {
      el.createSpan({ cls: 'wtl-muted', text: ' · ' });
      el.createSpan({ text: `${fmtHours1(g.hours)} h ${g.label}` });
    }
    if (!this.showButtons()) return;
    const link = (text, fn) => {
      el.createSpan({ cls: 'wtl-muted', text: ' · ' });
      const a = el.createEl('a', { text, href: '#', cls: 'wtl-line-link' });
      a.onclick = e => { e.preventDefault(); fn(); };
    };
    if (pending) link(`review ${pending}`, () => this.plugin.openReview(report, () => this.render()));
    link('export', async () => { await this.plugin.exportCsv(report); this.render(); });
    link('open log', () => this.plugin.openView(report.start));
  }
}

// ---------------------------------------------------------------------------
// Review: one block at a time, keyboard driven

class ReviewModal extends Modal {
  constructor(app, plugin, report, onDone) {
    super(app);
    this.plugin = plugin;
    this.report = report;
    this.onDone = onDone;
    this.queue = report.blocks.filter(needsReview);
    this.i = 0;
    this.choices = [];
  }

  onOpen() {
    this.modalEl.addClass('wtl-review');
    // Shortcuts are off while typing in the label field.
    const key = (k, fn) => this.scope.register([], k, () => {
      if (this.input && document.activeElement === this.input) return true;
      fn();
      return false;
    });
    for (let n = 1; n <= 9; n++) key(String(n), () => this.pick(n - 1));
    key('0', () => this.choose({ kind: 'none' }));
    key('Enter', () => this.pick(0));
    key('s', () => this.next());
    key('ArrowRight', () => this.next());
    key('ArrowLeft', () => this.prev());
    key('/', () => this.input && this.input.focus());
    // Shift+1…8 picks an area (number keys alone pick a label).
    this.modalEl.addEventListener('keydown', e => {
      if (!e.shiftKey || e.metaKey || e.ctrlKey || e.altKey || !/^Digit[1-8]$/.test(e.code)) return;
      if (this.input && document.activeElement === this.input) return;
      const hit = (this.areaKeys || [])[Number(e.code.slice(5)) - 1];
      if (!hit) return;
      e.preventDefault();
      e.stopPropagation();
      hit[0].click();
    }, true);
    this.render();
  }

  onClose() {
    this.contentEl.empty();
    this.onDone();
  }

  current() {
    return this.queue[this.i];
  }

  render() {
    const el = this.contentEl;
    el.empty();
    const b = this.current();
    if (!b) {
      el.createEl('h3', { text: 'All caught up' });
      el.createDiv({ cls: 'wtl-muted', text: 'Every block this week has a confirmed label.' });
      el.createEl('button', { text: 'Close', cls: 'mod-cta' }).onclick = () => this.close();
      return;
    }

    el.createDiv({ cls: 'wtl-review-progress', text: `Block ${this.i + 1} of ${this.queue.length}` });
    const card = el.createDiv({ cls: 'wtl-review-block' });
    card.createDiv({ cls: 'wtl-review-title', text: b.title });
    card.createDiv({
      cls: 'wtl-muted',
      text: `${b.start.format('ddd MMM D · h:mm')}–${b.end.format('h:mma')} · ${fmtHours(b.hours)} h · ${b.calendar}`,
    });
    if (b.description) card.createDiv({ cls: 'wtl-review-desc', text: b.description.slice(0, 240) });

    // Area, saved together with whatever label you pick below.
    if (this.areaFor !== b.key) {
      this.areaFor = b.key;
      this.area = b.area || null;
    }
    const areas = parseAreas(this.plugin.settings.areas);
    const areaColor = this.plugin.colorsFor(this.report, findDimension(this.plugin.settings, 'area'));
    const row = el.createDiv({ cls: 'wtl-area-row' });
    row.createSpan({ cls: 'wtl-area-row-label', text: 'Area' });
    const areaBtns = [];
    const sync = () => {
      for (const [x, n] of areaBtns) {
        x.toggleClass('is-active', n === this.area);
        x.setAttr('aria-pressed', String(n === this.area));
      }
    };
    areas.forEach((a, i) => {
      const btn = row.createEl('button', { cls: 'wtl-area-btn' });
      btn.createSpan({ cls: 'wtl-area-check', text: '✓' });
      paint(btn.createSpan({ cls: 'wtl-swatch' }), areaColor, a.name);
      btn.createSpan({ text: a.name });
      btn.createSpan({ cls: 'wtl-area-key', text: `⇧${i + 1}` });
      areaBtns.push([btn, a.name]);
      btn.onclick = e => {
        e.preventDefault();
        this.area = this.area === a.name ? null : a.name;
        sync();
      };
    });
    sync();
    this.areaKeys = areaBtns; // Shift+1…8 (see onOpen)
    if (b.areaStatus === 'suggested' && b.areaWhy.length) {
      el.createDiv({ cls: 'wtl-review-why wtl-area-why', text: `Area suggested: ${b.areaWhy.join(' · ')}` });
    }

    // Options: suggestion first, then other task candidates, then tag-only.
    const choices = [];
    const seen = new Set();
    const add = (choice, reasons, suggested, keep = false) => {
      const v = choiceValue(choice);
      if (seen.has(v)) return;
      seen.add(v);
      choices.push({ choice, reasons, suggested, keep });
    };
    // Label already confirmed (here for its area): option 1 keeps it, so Enter just saves the area.
    const keep = b.status === 'confirmed' ? b.choice : null;
    if (keep) add(keep, ['your confirmed label'], true, true);
    if (b.suggestion && b.suggestion.kind !== 'none') add(b.suggestion, b.suggestion.reasons, !keep);
    for (const c of b.candidates.slice(0, 4)) add({ kind: 'task', task: c.task }, c.reasons);
    for (const t of b.tagRank.slice(0, 2)) if (t.p >= 0.3) add({ kind: 'tag', tags: [t.tag] }, [t.why]);
    this.choices = choices;

    const list = el.createDiv({ cls: 'wtl-review-options' });
    choices.forEach((c, idx) => {
      const row = list.createDiv({ cls: 'wtl-review-option' + (c.suggested ? ' is-suggested' : '') });
      row.createSpan({ cls: 'wtl-key', text: String(idx + 1) });
      const main = row.createDiv({ cls: 'wtl-review-option-main' });
      const name = main.createDiv({ cls: 'wtl-review-option-name' });
      if (c.keep) {
        name.setText(`Keep label: ${choiceLabel(c.choice)}`);
      } else if (c.choice.kind === 'task') {
        name.setText(c.choice.task.desc);
        const meta = [];
        if (c.choice.task.tags.length) meta.push(c.choice.task.tags.map(t => '#' + t).join(' '));
        if (c.choice.task.scheduled) meta.push(`⏳ ${c.choice.task.scheduled}`);
        if (meta.length) name.createSpan({ cls: 'wtl-review-meta', text: '  ' + meta.join('  ') });
      } else if (c.choice.kind === 'tag') {
        name.setText(hashes(c.choice.tags));
        name.createSpan({ cls: 'wtl-review-meta', text: '  no specific task' });
      } else {
        name.setText(choiceLabel(c.choice));
      }
      if (c.reasons && c.reasons.length) main.createDiv({ cls: 'wtl-review-why', text: c.reasons.join(' · ') });
      if (c.suggested) row.createSpan({ cls: 'wtl-badge wtl-badge-suggested', text: 'suggested' });
      row.onclick = () => this.pick(idx);
    });

    const noneSuggested = !keep && b.suggestion && b.suggestion.kind === 'none';
    const noneRow = list.createDiv({ cls: 'wtl-review-option' + (noneSuggested ? ' is-suggested' : '') });
    noneRow.createSpan({ cls: 'wtl-key', text: '0' });
    const nm = noneRow.createDiv({ cls: 'wtl-review-option-main' });
    nm.createDiv({ cls: 'wtl-review-option-name', text: 'Not task work' });
    if (noneSuggested) {
      nm.createDiv({ cls: 'wtl-review-why', text: b.suggestion.reasons.join(' · ') });
      noneRow.createSpan({ cls: 'wtl-badge wtl-badge-suggested', text: 'suggested' });
      // Enter accepts the highlighted suggestion.
      this.choices.unshift({ choice: { kind: 'none' }, hidden: true });
    }
    noneRow.onclick = () => this.choose({ kind: 'none' });

    const typed = list.createDiv({ cls: 'wtl-review-option wtl-review-type' });
    typed.createSpan({ cls: 'wtl-key', text: '/' });
    const picker = new LabelPicker(this.app, typed, labelItems(this.report, b), null, choice => this.choose(choice), {
      placeholder: 'Add tasks and #tags; Enter on an empty field saves',
    });
    this.input = picker.input;

    const foot = el.createDiv({ cls: 'wtl-review-foot' });
    foot.createDiv({ cls: 'wtl-muted', text: '⇧1–8 area · 1–9 label · Enter accept · 0 not task work · / add tasks & tags · S skip · ← back' });
    const btns = foot.createDiv({ cls: 'wtl-review-buttons' });
    if (this.i > 0) btns.createEl('button', { text: 'Back' }).onclick = () => this.prev();
    btns.createEl('button', { text: 'Skip' }).onclick = () => this.next();
  }

  pick(idx) {
    const visible = this.choices.filter(c => !c.hidden);
    // Enter (idx 0) prefers the highlighted suggestion even when it is "not task work".
    const c = idx === 0 && this.choices[0] && this.choices[0].hidden ? this.choices[0] : visible[idx];
    return c ? this.choose(c.choice) : Promise.resolve();
  }

  async choose(choice) {
    if (this.saving) return; // one save at a time (fast double Enter)
    this.saving = true;
    try {
      const b = this.current();
      const area = this.area; // read before saving: the label save re-scores the week
      await this.plugin.annotate(this.report, b, choice);
      if (area) await this.plugin.setArea(this.report, b, area);
    } finally {
      this.saving = false;
    }
    this.next();
  }

  next() {
    this.i++;
    this.render();
  }

  prev() {
    if (this.i > 0) this.i--;
    this.render();
  }
}

// ---------------------------------------------------------------------------
// Settings

class TimeLogSettings extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  async display() {
    const { containerEl } = this;
    const s = this.plugin.settings;
    containerEl.empty();

    let sources = [];
    try {
      sources = (await this.plugin.calendarSources()).sources;
    } catch (e) {
      containerEl.createEl('p', { text: e.message });
    }

    containerEl.createEl('h3', { text: 'Calendars to log' });
    const active = s.calendarIds ? new Set(s.calendarIds) : new Set(sources.filter(x => x.type !== 'tasks').map(x => x.id));
    for (const src of sources) {
      new Setting(containerEl)
        .setName(src.name || src.id)
        .setDesc(src.type === 'tasks' ? 'Tasks shown on the calendar (off by default: these are tasks, not blocks)' : src.type)
        .addToggle(t => t.setValue(active.has(src.id)).onChange(async v => {
          if (v) active.add(src.id); else active.delete(src.id);
          s.calendarIds = [...active];
          await this.plugin.saveSettings();
        }));
    }

    containerEl.createEl('h3', { text: 'Options' });
    new Setting(containerEl)
      .setName('Week starts on')
      .addDropdown(d => d
        .addOptions({ calendar: 'Same as calendar', 0: 'Sunday', 1: 'Monday' })
        .setValue(String(s.weekStart))
        .onChange(async v => { s.weekStart = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('CSV export folder')
      .addText(t => t.setValue(s.exportFolder).onChange(async v => { s.exportFolder = v.trim() || 'Time Logs'; await this.plugin.saveSettings(); }));

    const ar = new Setting(containerEl)
      .setName('Areas')
      .setDesc('Broad categories for all your time, predicted for every block (not tags). One per line: ' +
        '"Area: hint words, #tags". Hint words match block titles; #tags count blocks with that tag. ' +
        'Up to 8; the order sets their chart colours.')
      .addTextArea(t => {
        t.setValue(s.areas || '').onChange(async v => { s.areas = v; await this.plugin.saveSettings(); });
        t.inputEl.rows = 7;
        t.inputEl.addClass('wtl-groups-input');
      });
    ar.settingEl.addClass('wtl-setting-wide');

    new Setting(containerEl)
      .setName('Area for task work')
      .setDesc('Used for blocks attached to a task or tag when nothing else points to an area.')
      .addDropdown(d => {
        d.addOption('', 'None (leave unsorted)');
        for (const a of parseAreas(s.areas)) d.addOption(a.name, a.name);
        d.setValue(s.defaultTaskArea || '').onChange(async v => { s.defaultTaskArea = v; await this.plugin.saveSettings(); });
      });

    const tg = new Setting(containerEl)
      .setName('Tag groupings')
      .setDesc('One per line. Each becomes a chart view and a CSV column. ' +
        'Parentheses list extra tags that count toward a value; nested tags (#phd/thesis) match their parent.')
      .addTextArea(t => {
        t.setPlaceholder('Project: uist2026, chi2026, phd\nRole: postdoc (uist2026, chi2026), faculty (teaching)')
          .setValue(s.tagGroups || '')
          .onChange(async v => { s.tagGroups = v; await this.plugin.saveSettings(); });
        t.inputEl.rows = 4;
        t.inputEl.addClass('wtl-groups-input');
      });
    tg.settingEl.addClass('wtl-setting-wide');

    new Setting(containerEl)
      .setName('Auto-save CSV')
      .setDesc('Keep CSVs in the export folder current: whenever a time-log block is shown or its labels change, ' +
        'and once a day for last week. Unreviewed blocks are marked "suggested".')
      .addToggle(t => t.setValue(s.autoExport).onChange(async v => { s.autoExport = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('Review reminders')
      .setDesc('Once a day, remind me while last week still has blocks to review.')
      .addToggle(t => t.setValue(s.remind).onChange(async v => { s.remind = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('Use my tag colours in charts')
      .setDesc('Charts reuse the colours your tags already have (e.g. from the Colored Tags plugin or CSS snippets). ' +
        'Tags without one get a colour from a colour-blind-safe palette.')
      .addToggle(t => t.setValue(s.useTagColors).onChange(async v => {
        s.useTagColors = v;
        this.plugin.tagColorCache = null;
        await this.plugin.saveSettings();
        this.plugin.refreshViews();
      }));

    new Setting(containerEl)
      .setName('Suggestion strictness')
      .setDesc('Higher = fewer, more confident task suggestions.')
      .addSlider(sl => sl.setLimits(0.3, 1.2, 0.05).setValue(s.minScore).setDynamicTooltip()
        .onChange(async v => { s.minScore = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('Forget learned labels')
      .setDesc(`${plural(Object.keys(s.annotations).length, 'confirmed label')} and ` +
        `${plural(Object.keys(s.areaLabels || {}).length, 'confirmed area')} used to make suggestions.`)
      .addButton(b => b.setButtonText('Reset').setWarning().onClick(async () => {
        if (!window.confirm('Forget every confirmed label and area? Suggestions will start from scratch.')) return;
        s.annotations = {};
        s.areaLabels = {};
        await this.plugin.saveSettings();
        this.display();
      }));

    new Setting(containerEl)
      .setName('Data file')
      .setDesc('Your labels and these settings live in this vault file, so reinstalling or upgrading the plugin keeps them. ' +
        'Changing the path writes a copy there; the old file is left in place.')
      .addText(t => t.setValue(s.dataFile).onChange(async v => {
        const path = v.trim();
        if (!path.endsWith('.json')) return;
        s.dataFile = path;
        this.plugin.dataFileError = null;
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName('Calendar access')
      .setDesc(s.token ? 'Authorized with Full Calendar.' : 'Will ask Full Calendar for access on first run.')
      .addButton(b => b.setButtonText('Re-authorize').onClick(async () => {
        s.token = null;
        await this.plugin.saveSettings();
        this.display();
      }));
  }
}
