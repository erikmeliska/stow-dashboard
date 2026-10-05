/**
 * Day timeline for /sessions (issue #31): time runs horizontally, one
 * swimlane per workspace, grouped client → project → workspace. Pure and
 * client-safe; all times are minutes from LOCAL midnight of `day`.
 *
 * Placement is the week view's (calendarSlot + daySegment: real end up to
 * 5 h, 15-min minimum, zero-minute sessions are points). Linked children and
 * nested subagents ride under their parent bar as `subs` at their own times.
 */
import { calendarSlot, clusterStats, daySegment } from './session-calendar.mjs';
import { sessionProjectKey, sessionProjectLabel } from './session-project.mjs';
import { UNASSIGNED } from './session-projects.mjs';
import { formatWorkspace } from './workspace.mjs';

/** Width a point (dot) reserves in its track, in minutes. */
export const POINT_MIN = 6;

function span(row, day) {
  const slot = calendarSlot(row);
  const seg = slot && daySegment(slot, day);
  if (!seg) return null;
  return { start: seg.top, end: seg.point ? seg.top : seg.top + seg.height, point: !!seg.point, continued: seg.continued, continues: seg.continues };
}

/**
 * Families → bars on `day` (events without a segment there are dropped).
 * `extentStart/extentEnd` cover the bar and its subs: what track packing reserves.
 */
export function timelineBars(events, day) {
  const out = [];
  for (const e of events || []) {
    const sp = span(e, day);
    if (!sp) continue;
    const subs = [];
    for (const [kind, rows] of [['agent', e.agents], ['child', e.children]]) {
      for (const r of rows || []) {
        const s = span(r, day);
        if (s) subs.push({ id: r.agent_id || r.session_id, kind, start: s.start, end: s.end, point: s.point, row: r });
      }
    }
    subs.sort((a, b) => a.start - b.start);
    const ends = [sp.point ? sp.start + POINT_MIN : sp.end, ...subs.map((s) => (s.point ? s.start + POINT_MIN : s.end))];
    out.push({
      id: e.session_id, e, ...sp, subs,
      extentStart: Math.min(sp.start, ...subs.map((s) => s.start)),
      extentEnd: Math.max(...ends),
    });
  }
  return out.sort((a, b) => a.start - b.start || b.end - a.end);
}

/** Greedy interval packing: each bar goes to the first track that is free by its extentStart (touching is free). */
export function packTracks(bars) {
  const tracks = [];
  const ends = [];
  for (const b of [...bars].sort((x, y) => x.extentStart - y.extentStart || y.extentEnd - x.extentEnd)) {
    let i = ends.findIndex((t) => t <= b.extentStart);
    if (i === -1) { i = tracks.length; tracks.push([]); ends.push(0); }
    tracks[i].push(b);
    ends[i] = b.extentEnd;
  }
  return tracks;
}

/** How many sessions run at once over the day: steps with count > 0 and the peak. Points have no duration and don't count. */
export function concurrencyProfile(bars) {
  const ev = [];
  for (const b of bars || []) {
    if (b.point || b.end <= b.start) continue;
    ev.push([b.start, 1], [b.end, -1]);
  }
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]); // an end before a start at the same minute: touching isn't overlap
  const steps = [];
  let count = 0, peak = 0, from = null;
  for (const [t, d] of ev) {
    if (count > 0 && from != null && t > from) {
      const last = steps.at(-1);
      if (last && last.end === from && last.count === count) last.end = t;
      else steps.push({ start: from, end: t, count });
    }
    count += d;
    from = t;
    peak = Math.max(peak, count);
  }
  return { steps, peak };
}

function group(list, keyOf) {
  const m = new Map();
  for (const x of list) {
    const k = keyOf(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}

const byCost = (a, b) => b.stats.cost_usd - a.stats.cost_usd || a.name.localeCompare(b.name);

function summarize(bars) {
  const { steps, peak } = concurrencyProfile(bars);
  return { stats: clusterStats(bars.map((b) => b.e)), profile: steps, peak };
}

/**
 * Bars of `day` as Client[] → projects → workspace lanes → tracks. Clients and
 * projects by cost (Unassigned client last), lanes main checkout first, then
 * worktrees by name. Every group carries stats, the concurrency profile and its peak.
 */
export function buildTimeline(events, day) {
  const bars = timelineBars(events, day);
  const clients = [];
  for (const [cid, cbars] of group(bars, (b) => b.e.client_id || UNASSIGNED)) {
    const projects = [];
    for (const [key, pbars] of group(cbars, (b) => sessionProjectKey(b.e) || '—')) {
      const lanes = [...group(pbars, (b) => b.e.workspace || null)]
        .sort(([a], [b]) => (a == null ? -1 : b == null ? 1 : a.localeCompare(b)))
        .map(([ws, lbars]) => ({ workspace: ws, label: ws ? formatWorkspace(ws) : 'main checkout', tracks: packTracks(lbars) }));
      projects.push({ key, name: sessionProjectLabel(pbars[0].e) || key, lanes, ...summarize(pbars) });
    }
    projects.sort(byCost);
    const first = cbars[0].e;
    const unassigned = cid === UNASSIGNED;
    clients.push({ id: cid, name: unassigned ? 'Unassigned' : first.client_name || cid, unassigned, projects, ...summarize(cbars) });
  }
  return clients.sort((a, b) => (a.unassigned - b.unassigned) || byCost(a, b));
}

/** Whole hours from the first bar to the last one (at least minHours, within 0..24); 8–18 for an empty day. */
export function timeWindow(bars, { minHours = 4 } = {}) {
  if (!bars?.length) return { startHour: 8, endHour: 18 };
  let startHour = Math.max(0, Math.floor(Math.min(...bars.map((b) => b.extentStart)) / 60));
  let endHour = Math.min(24, Math.ceil(Math.max(...bars.map((b) => b.extentEnd)) / 60));
  if (endHour - startHour < minHours) {
    endHour = Math.min(24, startHour + minHours);
    startHour = Math.max(0, endHour - minHours);
  }
  return { startHour, endHour };
}
