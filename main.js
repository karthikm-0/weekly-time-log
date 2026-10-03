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
  view: null,            // last grouping picked in the full log
  minScore: 0.55,
  autoExport: true,      // save last week's CSV daily, and re-save after reviewing
  remind: true,          // nudge while last week has unreviewed blocks
  lastCheck: null,       // ISO date of the last background check
  dataFile: DEFAULT_DATA_FILE,
  // blockKey -> { kind: 'task'|'tag'|'none', task, taskDesc, taskPath, tags, title, date }
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
  return 'none';
}

function hashes(tags) {
  return tags.map(t => '#' + t).join(' ');
}

function choiceLabel(c) {
  if (!c) return 'Unattached';
  if (c.kind === 'task') return c.task.desc;
  if (c.kind === 'tag') return `${hashes(c.tags)} (${c.tags.length > 1 ? 'tags' : 'tag'} only)`;
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

/** The ways the charts can be grouped: each tag group, then Tag, Task, Calendar. */
function dimensions(settings) {
  return [
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

function taskLeaf(b) {
  if (b.task) return { key: b.task.key, label: b.task.desc, task: b.task };
  if (b.choice && b.choice.kind === 'tag') return { key: choiceValue(b.choice), label: `${hashes(b.choice.tags)} (no specific task)`, muted: true };
  return { key: b.choice ? '~none' : '~open', label: b.choice ? 'Not task work' : 'Unattached', muted: true };
}

/** Rows of { label, hours, n, unconfirmed, muted, children } for one dimension. */
function buildTree(blocks, dim) {
  const top = new Map();
  const add = (map, g0, b) => {
    if (!map.has(g0.key)) map.set(g0.key, { ...g0, hours: 0, n: 0, unconfirmed: 0, kids: new Map() });
    const g = map.get(g0.key);
    g.hours += b.hours;
    g.n++;
    if (b.status !== 'confirmed') g.unconfirmed += b.hours;
    return g;
  };
  for (const b of blocks) {
    if (dim.id === 'task') { add(top, taskLeaf(b), b); continue; }
    if (dim.id === 'tag') {
      // Each tag gets the block's full hours, so this view can sum past the total.
      const tags = b.tags.length ? [...new Set(b.tags)] : [null];
      for (const tg of tags) {
        const g0 = tg ? { key: tg, label: `#${tg}` } : { key: '~', label: 'Untagged', muted: true };
        add(add(top, g0, b).kids, taskLeaf(b), b);
      }
      continue;
    }
    let g0;
    if (dim.id === 'calendar') {
      g0 = { key: b.calendarId, label: b.calendar };
    } else {
      const v = tagValue(b.tags, dim.group);
      g0 = v ? { key: v, label: v } : { key: '~', label: `No ${dim.label.toLowerCase()}`, muted: true };
    }
    add(add(top, g0, b).kids, taskLeaf(b), b);
  }
  const order = (a, b) => (a.muted ? 1 : 0) - (b.muted ? 1 : 0) || b.hours - a.hours;
  return [...top.values()].sort(order).map(r => ({ ...r, children: [...r.kids.values()].sort(order) }));
}

/**
 * Horizontal bars with expandable children. Child bars share the parent scale,
 * so a task's bar shows its share of the group.
 */
function renderTree(container, rows, { isOpen, toggle, tip, openTask }) {
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
    row.createDiv({ cls: 'wtl-hbar-value', text: `${fmtHours(r.hours)} h` });
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

    // Background check: shortly after startup (lets Google events load), then every few hours.
    this.app.workspace.onLayoutReady(() => {
      this.registerInterval(window.setTimeout(() => this.weeklyCheck(), 60 * 1000));
      this.registerInterval(window.setInterval(() => this.weeklyCheck(), 3 * 60 * 60 * 1000));
    });
  }

  onunload() {}

  // ---- Background export & reminder ---------------------------------------

  /** Once a day: save last week's CSV and nudge if anything is unreviewed. */
  async weeklyCheck() {
    const s = this.settings;
    const today = moment().format('YYYY-MM-DD');
    if ((!s.autoExport && !s.remind) || s.lastCheck === today || !s.token) return;
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
    const pending = report.blocks.filter(b => b.status !== 'confirmed').length;
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
        if (a.kind === 'task') {
          // The task may have moved or been deleted since; keep the label anyway.
          const task = byKey.get(a.task) || { key: a.task, desc: a.taskDesc || a.task, path: a.taskPath, tags: a.tags || [], ghost: true };
          b.choice = { kind: 'task', task };
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
      b.task = b.choice && b.choice.kind === 'task' ? b.choice.task : null;
      b.tags = b.task ? b.task.tags : b.choice && b.choice.kind === 'tag' ? b.choice.tags : [];
    }
    return report;
  }

  rescore(report) {
    this.scoreBlocks(report);
    return this.assign(report);
  }

  async annotate(report, block, choice) {
    if (!choice) {
      delete this.settings.annotations[block.key];
    } else {
      this.settings.annotations[block.key] = {
        kind: choice.kind,
        task: choice.kind === 'task' ? choice.task.key : undefined,
        taskDesc: choice.kind === 'task' ? choice.task.desc : undefined,
        taskPath: choice.kind === 'task' ? choice.task.path : undefined,
        tags: choice.kind === 'task' ? choice.task.tags : choice.kind === 'tag' ? choice.tags : [],
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

  // ---- Export --------------------------------------------------------------

  toCsv(report) {
    const groups = parseTagGroups(this.settings.tagGroups);
    const header = ['week_start', 'date', 'weekday', 'start', 'end', 'hours', 'block', 'calendar',
      'label', 'task', 'task_file', 'tags', ...groups.map(g => g.name.toLowerCase()),
      'task_scheduled', 'task_due', 'task_done', 'status', 'confidence', 'why'];
    const rows = report.blocks.map(b => {
      const t = b.task;
      return [
        report.start.format('YYYY-MM-DD'), b.date, b.start.format('ddd'),
        b.start.format('HH:mm'), b.end.format('HH:mm'), b.hours.toFixed(2), b.title, b.calendar,
        b.choice ? b.choice.kind : '', t ? t.desc : '', t ? t.path || '' : '', b.tags.map(x => '#' + x).join(' '),
        ...groups.map(g => tagValue(b.tags, g) || ''),
        t ? t.scheduled || '' : '', t ? t.due || '' : '', t ? (t.done ? 'yes' : 'no') : '',
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
      const pending = report.blocks.filter(b => b.status !== 'confirmed').length;
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
  if (c.kind === 'task') return `${c.task.desc} ${c.task.tags.map(t => '#' + t).join(' ')}`;
  if (c.kind === 'tag') return hashes(c.tags);
  return 'Not task work';
}

/** "Grant reporting" -> "grant_reporting"; Obsidian tags can't contain spaces. */
function normalizeTag(text) {
  return text.trim().replace(/^#+/, '').replace(/\s+/g, '_').replace(/[^\p{L}\p{N}_/-]/gu, '');
}

/**
 * Pure ranking, separate from the UI so it is easy to test.
 * "#postdoc #mee" keeps the finished tags (#postdoc) and completes the last word,
 * so a block can get several tags.
 */
function rankLabels(items, query) {
  const m = query.match(/^((?:#\S+\s+)+)(.*)$/);
  const prefix = m ? [...new Set(m[1].trim().split(/\s+/).map(normalizeTag).filter(Boolean))] : [];
  const q = (m ? m[2] : query).trim();
  const has = tg => prefix.some(p => p.toLowerCase() === tg.toLowerCase());
  const withPrefix = it => (prefix.length ? { ...it, choice: { kind: 'tag', tags: [...prefix, ...it.choice.tags] }, adds: it.choice.tags } : it);
  const pool = prefix.length
    ? items.filter(i => i.choice.kind === 'tag' && i.choice.tags.length === 1 && !has(i.choice.tags[0]))
    : items;

  let out;
  if (!q) {
    out = pool.filter(i => i.suggested || i.likely).map(withPrefix);
  } else {
    const fuzzy = prepareFuzzySearch(q.replace(/^#/, ''));
    const hits = [];
    for (const it of pool) {
      const f = fuzzy(itemSearchText(it));
      if (f) {
        const usage = it.count ? Math.min(0.5, Math.log10(1 + it.count) / 4) : 0;
        hits.push({ it, score: f.score + (it.suggested ? 2 : it.likely ? 1 : 0) + usage });
      }
    }
    hits.sort((a, b) => b.score - a.score);
    out = hits.map(h => withPrefix(h.it)).slice(0, 30);
    const tag = normalizeTag(q);
    const exists = items.some(i => i.choice.kind === 'tag' && i.choice.tags.length === 1 && i.choice.tags[0].toLowerCase() === tag.toLowerCase());
    if (tag && !exists && !has(tag)) {
      const create = { choice: { kind: 'tag', tags: [...prefix, tag] }, create: true, adds: [tag] };
      // A leading "#" means "this is a tag": offer creating it first, unless an existing tag matches.
      const tagHit = out.some(i => i.choice.kind === 'tag');
      if (!out.length || (q.startsWith('#') && !tagHit)) out.unshift(create); else out.push(create);
    }
  }
  // With tags already typed, offer to use exactly those.
  if (prefix.length) out.unshift({ choice: { kind: 'tag', tags: prefix }, commit: true });
  return out;
}

class LabelSuggest extends AbstractInputSuggest {
  constructor(app, inputEl, items, onPick) {
    super(app, inputEl);
    this.items = items;
    this.onPick = onPick;
    this.limit = 40;
    // Show this block's suggestions as soon as the field is focused.
    inputEl.addEventListener('focus', () => inputEl.dispatchEvent(new Event('input')));
  }

  getSuggestions(query) {
    return rankLabels(this.items, query);
  }

  renderSuggestion(it, el) {
    el.addClass('wtl-suggest-item');
    const top = el.createDiv({ cls: 'wtl-suggest-top' });
    const c = it.choice;
    const kept = it.adds ? c.tags.filter(t => !it.adds.includes(t)) : [];
    if (it.commit) {
      top.createSpan({ text: `Use ${hashes(c.tags)}` });
    } else if (it.create) {
      top.createSpan({ text: `${kept.length ? hashes(kept) + ' + ' : ''}create #${it.adds[0]}` });
    } else if (c.kind === 'task') {
      top.createSpan({ text: c.task.desc });
      const meta = [];
      if (c.task.tags.length) meta.push(c.task.tags.map(t => '#' + t).join(' '));
      if (c.task.scheduled) meta.push(`⏳ ${c.task.scheduled}`);
      if (meta.length) top.createSpan({ cls: 'wtl-review-meta', text: '  ' + meta.join('  ') });
    } else if (c.kind === 'tag') {
      top.createSpan({ text: kept.length ? `${hashes(kept)} + ${hashes(it.adds)}` : hashes(c.tags) });
      top.createSpan({ cls: 'wtl-review-meta', text: it.count ? `  used ${it.count}×` : '' });
    } else {
      top.createSpan({ text: 'Not task work' });
    }
    if (it.suggested) top.createSpan({ cls: 'wtl-badge wtl-badge-suggested', text: 'suggested' });
    if (it.reasons && it.reasons.length) el.createDiv({ cls: 'wtl-review-why', text: it.reasons.join(' · ') });
  }

  selectSuggestion(it) {
    this.close();
    this.onPick(it.choice);
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

  async refresh() {
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

  rerender() {
    const top = this.contentEl.scrollTop;
    this.render();
    this.contentEl.scrollTop = top;
  }

  review() {
    this.plugin.openReview(this.report, () => this.rerender());
  }

  /** Re-save the CSV a moment after the last edit in the table. */
  scheduleSave() {
    window.clearTimeout(this.saveTimer);
    const report = this.report;
    this.saveTimer = window.setTimeout(() => this.plugin.autoSave(report), 2000);
  }

  async acceptAll() {
    // Snapshot first: each confirmation re-scores the rest of the week.
    const pending = this.report.blocks.filter(b => b.status === 'suggested').map(b => [b, b.suggestion]);
    for (const [b, s] of pending) await this.plugin.annotate(this.report, b, s);
    new Notice(`Confirmed ${plural(pending.length, 'suggestion')}.`);
    this.rerender();
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
      const pending = report.blocks.filter(b => b.status !== 'confirmed').length;
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
    const rev = tile('To review', String(suggested.length + open.length),
      `${suggested.length} suggested · ${open.length} unattached`);
    if (suggested.length + open.length) {
      rev.addClass('is-clickable');
      rev.onclick = () => this.review();
    }

    if (!report.blocks.length) {
      root.createDiv({ cls: 'wtl-muted', text: 'No timed calendar blocks this week. Check the calendars selected in settings.' });
      return;
    }

    this.tooltip = root.createDiv({ cls: 'wtl-tooltip' });
    const charts = root.createDiv({ cls: 'wtl-charts' });
    this.renderGrouped(charts.createDiv({ cls: 'wtl-card wtl-card-wide' }), report);
    this.renderByDay(charts.createDiv({ cls: 'wtl-card' }), report);
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
        this.rerender();
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

  renderByDay(card, report) {
    card.createEl('h4', { text: 'Hours by day' });
    const days = [];
    for (let d = report.start.clone(); d.isBefore(report.end); d.add(1, 'day')) {
      const iso = d.format('YYYY-MM-DD');
      const bs = report.blocks.filter(b => b.date === iso);
      days.push({
        label: d.format('ddd'), sub: d.format('D'), iso,
        hours: bs.reduce((a, b) => a + b.hours, 0),
        attached: bs.filter(b => b.task).reduce((a, b) => a + b.hours, 0),
        n: bs.length,
      });
    }
    const max = Math.max(1, ...days.map(d => d.hours));
    const cols = card.createDiv({ cls: 'wtl-vbars' });
    for (const d of days) {
      const col = cols.createDiv({ cls: 'wtl-vbar-col' });
      col.createDiv({ cls: 'wtl-vbar-value', text: d.hours ? fmtHours(d.hours) : '' });
      const track = col.createDiv({ cls: 'wtl-vbar-track' });
      const bar = track.createDiv({ cls: 'wtl-vbar' });
      bar.style.height = `${(d.hours / max) * 100}%`;
      col.createDiv({ cls: 'wtl-vbar-label', text: d.label });
      col.createDiv({ cls: 'wtl-vbar-sub', text: d.sub });
      this.hover(col, `${moment(d.iso).format('ddd MMM D')}\n${d.hours.toFixed(2)} h total · ${d.attached.toFixed(2)} h on tasks\n${plural(d.n, 'block')}`);
    }
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
    for (const h of ['Day', 'Time', 'Block', 'Hours', 'Label', 'Status']) tr0.createEl('th', { text: h });
    const body = table.createEl('tbody');

    for (const b of report.blocks) {
      const tr = body.createEl('tr');
      tr.createEl('td', { text: b.start.format('ddd D') });
      tr.createEl('td', { text: `${b.start.format('h:mm')}–${b.end.format('h:mma')}` });
      tr.createEl('td', { text: b.title });
      tr.createEl('td', { text: fmtHours(b.hours), cls: 'wtl-num' });

      const cell = tr.createEl('td', { cls: 'wtl-label-cell' });
      const current = b.choice ? choiceLabel(b.choice) : '';
      const input = cell.createEl('input', {
        type: 'text',
        cls: 'wtl-label-input' + (b.status === 'confirmed' ? '' : ' is-pending'),
        value: current,
        attr: { placeholder: 'Type a task or #tags…', spellcheck: 'false' },
      });
      // On focus: tag labels stay so you can add another ("#postdoc " + "#meeting");
      // task labels clear so suggestions show. Restored if nothing was picked.
      const isTags = b.choice && b.choice.kind === 'tag';
      input.addEventListener('focus', () => { input.value = isTags ? hashes(b.choice.tags) + ' ' : ''; }, true);
      input.addEventListener('blur', () => { window.setTimeout(() => { if (document.activeElement !== input) input.value = current; }, 200); });
      new LabelSuggest(this.app, input, labelItems(report, b), async choice => {
        await this.plugin.annotate(report, b, choice);
        this.rerender();
        this.scheduleSave();
      });
      if (b.status === 'confirmed' && b.suggestion && choiceValue(b.suggestion) !== choiceValue(b.choice)) {
        const reset = cell.createEl('button', { cls: 'wtl-accept clickable-icon', text: '↺' });
        reset.setAttr('aria-label', `Forget my label (suggestion: ${choiceLabel(b.suggestion)})`);
        reset.onclick = async () => {
          await this.plugin.annotate(report, b, null);
          this.rerender();
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
          await this.plugin.annotate(report, b, b.suggestion);
          this.rerender();
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
//   group: Project | Role | tag | task          (default: last view picked in the full log)
//   show: full | chart | hours                  (default: full)

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
    const { path } = this.plugin.csvPath(report.start);

    const show = (this.opts.show || 'full').toLowerCase();
    const dim = findDimension(this.plugin.settings, this.opts.group || this.plugin.settings.view);
    if (show === 'hours') return this.renderHours(report, dim);

    const head = el.createDiv({ cls: 'wtl-block-head' });
    head.createSpan({ cls: 'wtl-block-title', text: 'Time log' });
    head.createSpan({ cls: 'wtl-muted', text: `${report.start.format('MMM D')} – ${report.end.clone().subtract(1, 'day').format('MMM D')}` });
    if (this.week.guessed) {
      head.createSpan({ cls: 'wtl-muted', text: '· current week (add "week: 2026-W40" to pin)' });
    }

    const total = report.blocks.reduce((a, b) => a + b.hours, 0);
    const confirmed = report.blocks.filter(b => b.status === 'confirmed').reduce((a, b) => a + b.hours, 0);
    const pending = report.blocks.filter(b => b.status !== 'confirmed').length;
    const stats = show === 'chart' ? createDiv() : el.createDiv({ cls: 'wtl-block-stats' });
    const stat = (value, label) => {
      const d = stats.createDiv({ cls: 'wtl-block-stat' });
      d.createSpan({ cls: 'wtl-block-stat-value', text: value });
      d.createSpan({ cls: 'wtl-muted', text: label });
    };
    stat(`${fmtHours(total)} h`, 'logged');
    stat(`${fmtHours(confirmed)} h`, 'confirmed');
    stat(String(pending), 'to review');

    // Grouped bars (collapsed; click a group to see its tasks)
    if (report.blocks.length) {
      el.createDiv({ cls: 'wtl-block-sub', text: `By ${dim.label.toLowerCase()}` });
      this.expanded = this.expanded || new Set();
      renderTree(el, buildTree(report.blocks, dim), {
        isOpen: k => this.expanded.has(k),
        toggle: k => { if (this.expanded.has(k)) this.expanded.delete(k); else this.expanded.add(k); },
        tip: (row, text) => row.setAttr('aria-label', text),
      });
    } else {
      el.createDiv({ cls: 'wtl-muted', text: 'No calendar blocks this week.' });
    }

    if (show === 'chart') return;
    const foot = el.createDiv({ cls: 'wtl-block-foot' });
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
    const pending = report.blocks.filter(b => b.status !== 'confirmed').length;
    el.createSpan({ cls: 'wtl-line-total', text: `${fmtHours(total)} h` });
    el.createSpan({ text: ' logged' });
    const groups = buildTree(report.blocks, dim).filter(g => !g.muted).slice(0, 4);
    for (const g of groups) {
      el.createSpan({ cls: 'wtl-muted', text: ' · ' });
      el.createSpan({ text: `${fmtHours(g.hours)} h ${g.label}` });
    }
    if (pending) {
      el.createSpan({ cls: 'wtl-muted', text: ' · ' });
      const link = el.createEl('a', { text: `${pending} to review`, href: '#' });
      link.onclick = e => {
        e.preventDefault();
        this.plugin.openReview(report, () => this.render());
      };
    }
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
    this.queue = report.blocks.filter(b => b.status !== 'confirmed');
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

    // Options: suggestion first, then other task candidates, then tag-only.
    const choices = [];
    const seen = new Set();
    const add = (choice, reasons, suggested) => {
      const v = choiceValue(choice);
      if (seen.has(v)) return;
      seen.add(v);
      choices.push({ choice, reasons, suggested });
    };
    if (b.suggestion && b.suggestion.kind !== 'none') add(b.suggestion, b.suggestion.reasons, true);
    for (const c of b.candidates.slice(0, 4)) add({ kind: 'task', task: c.task }, c.reasons);
    for (const t of b.tagRank.slice(0, 2)) if (t.p >= 0.3) add({ kind: 'tag', tags: [t.tag] }, [t.why]);
    this.choices = choices;

    const list = el.createDiv({ cls: 'wtl-review-options' });
    choices.forEach((c, idx) => {
      const row = list.createDiv({ cls: 'wtl-review-option' + (c.suggested ? ' is-suggested' : '') });
      row.createSpan({ cls: 'wtl-key', text: String(idx + 1) });
      const main = row.createDiv({ cls: 'wtl-review-option-main' });
      const name = main.createDiv({ cls: 'wtl-review-option-name' });
      if (c.choice.kind === 'task') {
        name.setText(c.choice.task.desc);
        const meta = [];
        if (c.choice.task.tags.length) meta.push(c.choice.task.tags.map(t => '#' + t).join(' '));
        if (c.choice.task.scheduled) meta.push(`⏳ ${c.choice.task.scheduled}`);
        if (meta.length) name.createSpan({ cls: 'wtl-review-meta', text: '  ' + meta.join('  ') });
      } else {
        name.setText(hashes(c.choice.tags));
        name.createSpan({ cls: 'wtl-review-meta', text: '  no specific task' });
      }
      if (c.reasons && c.reasons.length) main.createDiv({ cls: 'wtl-review-why', text: c.reasons.join(' · ') });
      if (c.suggested) row.createSpan({ cls: 'wtl-badge wtl-badge-suggested', text: 'suggested' });
      row.onclick = () => this.pick(idx);
    });

    const noneRow = list.createDiv({ cls: 'wtl-review-option' + (b.suggestion && b.suggestion.kind === 'none' ? ' is-suggested' : '') });
    noneRow.createSpan({ cls: 'wtl-key', text: '0' });
    const nm = noneRow.createDiv({ cls: 'wtl-review-option-main' });
    nm.createDiv({ cls: 'wtl-review-option-name', text: 'Not task work' });
    if (b.suggestion && b.suggestion.kind === 'none') {
      nm.createDiv({ cls: 'wtl-review-why', text: b.suggestion.reasons.join(' · ') });
      noneRow.createSpan({ cls: 'wtl-badge wtl-badge-suggested', text: 'suggested' });
      // Enter accepts the highlighted suggestion.
      this.choices.unshift({ choice: { kind: 'none' }, hidden: true });
    }
    noneRow.onclick = () => this.choose({ kind: 'none' });

    const typed = list.createDiv({ cls: 'wtl-review-option wtl-review-type' });
    typed.createSpan({ cls: 'wtl-key', text: '/' });
    this.input = typed.createEl('input', {
      type: 'text',
      cls: 'wtl-label-input',
      attr: { placeholder: 'Type a task, or #tags (several: #postdoc #meeting)…', spellcheck: 'false' },
    });
    new LabelSuggest(this.app, this.input, labelItems(this.report, b), choice => this.choose(choice));

    const foot = el.createDiv({ cls: 'wtl-review-foot' });
    foot.createDiv({ cls: 'wtl-muted', text: '1–9 choose · Enter accept suggestion · 0 not task work · / type · S skip · ← back' });
    const btns = foot.createDiv({ cls: 'wtl-review-buttons' });
    if (this.i > 0) btns.createEl('button', { text: 'Back' }).onclick = () => this.prev();
    btns.createEl('button', { text: 'Skip' }).onclick = () => this.next();
  }

  pick(idx) {
    const visible = this.choices.filter(c => !c.hidden);
    // Enter (idx 0) prefers the highlighted suggestion even when it is "not task work".
    const c = idx === 0 && this.choices[0] && this.choices[0].hidden ? this.choices[0] : visible[idx];
    if (c) this.choose(c.choice);
  }

  async choose(choice) {
    await this.plugin.annotate(this.report, this.current(), choice);
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
      .setDesc('Once a day, save last week\'s CSV (unreviewed blocks are marked "suggested"). Re-saves after you review.')
      .addToggle(t => t.setValue(s.autoExport).onChange(async v => { s.autoExport = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('Review reminders')
      .setDesc('Once a day, remind me while last week still has blocks to review.')
      .addToggle(t => t.setValue(s.remind).onChange(async v => { s.remind = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('Suggestion strictness')
      .setDesc('Higher = fewer, more confident task suggestions.')
      .addSlider(sl => sl.setLimits(0.3, 1.2, 0.05).setValue(s.minScore).setDynamicTooltip()
        .onChange(async v => { s.minScore = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('Forget learned labels')
      .setDesc(`${plural(Object.keys(s.annotations).length, 'confirmed block')} used to make suggestions.`)
      .addButton(b => b.setButtonText('Reset').setWarning().onClick(async () => {
        if (!window.confirm('Forget every confirmed label? Suggestions will start from scratch.')) return;
        s.annotations = {};
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
