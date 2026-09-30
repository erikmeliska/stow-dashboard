'use client'

import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { ArrowDown, ArrowLeft, ArrowUp, Bot, CalendarDays, ChevronDown, ChevronRight, CornerDownRight, Filter, RefreshCw, ShieldCheck, Sparkles, Table2, X } from 'lucide-react'
import { format, parse, isValid } from 'date-fns'
import { Button } from '@/components/ui/button'
import { ThemeToggle } from '@/components/ThemeToggle'
import { filterSessions, QUALITY_FILTERS, QUICK_FILTERS, SOURCE_FILTERS } from '@/lib/cc/session-filters.mjs'
import { buildSessionTree, familyOf, groupFamilies, GROUP_BY, sortFamilies } from '@/lib/cc/session-tree.mjs'
import { CHILD_KINDS, effectiveKind } from '@/lib/cc/session-link.mjs'
import { periodRange } from '@/lib/cc/session-calendar.mjs'
import { displayTitle, parseSummary, summaryVersion, OUTCOME_ICON } from '@/lib/cc/summary-view.mjs'
import { CalendarView } from './calendar-view'

function fmtTokens(n) {
  if (n == null) return '—'
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(0) + 'k'
  return String(n)
}
function fmtCost(c) { return c == null ? '—' : `$${c.toFixed(2)}` }
function fmtDuration(s) {
  if (!s) return '—'
  const m = Math.round(s / 60)
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`
}
function fmtStart(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (n) => String(n).padStart(2, '0')
  // Local time (transcripts store UTC); rendered client-side only, so no hydration mismatch.
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
const ACTIVE_MS = 10 * 60 * 1000
/** A session is "active" while its transcript is still being written (last activity < 10 min ago). */
function isActive(s) { return s.ended_at ? Date.now() - Date.parse(s.ended_at) < ACTIVE_MS : false }
function projectName(dir) { return dir ? dir.split('/').filter(Boolean).slice(-1)[0] : '—' }
function kindLabel(kind) { return CHILD_KINDS[kind]?.label || kind || 'main' }
const SCHEDULED_BADGE = <span className="text-xs px-1 py-0.5 rounded bg-secondary text-secondary-foreground">scheduled</span>
function fmtAgent(a) { return [a.agent_type, a.description].filter(Boolean).join(' — ') || a.agent_id }
/** "3 subagents · 12 security reviews" for tooltips and the header line. */
function describeSubs(agents, children) {
  const parts = []
  if (agents) parts.push(`${agents} subagent${agents === 1 ? '' : 's'}`)
  const byKind = new Map()
  for (const c of children || []) byKind.set(c.kind, (byKind.get(c.kind) || 0) + 1)
  for (const [k, n] of byKind) parts.push(`${n} ${kindLabel(k)}${n === 1 ? '' : 's'}`)
  return parts.join(' · ')
}

const ACTION_CLS = {
  deny: 'bg-red-500/20 text-red-600 dark:text-red-400',
  warn: 'bg-orange-500/20 text-orange-600 dark:text-orange-400',
  override: 'bg-blue-500/20 text-blue-600 dark:text-blue-400',
}

function DetailPanel({ detail, project, onFilterProject, onOpen, onSummarize, summarizing, summaryError }) {
  if (!detail) return <p className="text-sm text-muted-foreground">Select a session to see its tools, skills and guard hits.</p>
  if (!detail.session) return <p className="text-sm text-muted-foreground">Session not found.</p>
  const s = detail.session
  const fam = familyOf(s, detail.agents || [], detail.children || [])
  const isChild = Boolean(CHILD_KINDS[s.kind])
  return (
    <div className="space-y-4 text-sm">
      <div>
        <div className="font-mono text-xs text-muted-foreground break-all">{s.session_id}</div>
        <div className="font-medium mt-1 flex items-center gap-2 flex-wrap">
          {projectName(s.project_dir)}
          {s.kind === 'scheduled' && SCHEDULED_BADGE}
          {isChild && <span className="text-xs font-normal px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-700 dark:text-amber-400 inline-flex items-center gap-1"><ShieldCheck className="h-3 w-3" />{kindLabel(s.kind)}</span>}
          {s.entrypoint && <span className="text-xs font-normal px-1.5 py-0.5 rounded bg-muted text-muted-foreground" title="Entrypoint (how the session was started)">{s.entrypoint}</span>}
        </div>
        <div className="text-xs text-muted-foreground break-all">{s.project_dir}</div>
        {s.project_dir && (
          project === s.project_dir ? (
            <button onClick={() => onFilterProject(null)} className="mt-1 text-xs inline-flex items-center gap-1 text-primary hover:underline">
              <X className="h-3 w-3" /> Clear directory filter
            </button>
          ) : (
            <button onClick={() => onFilterProject(s.project_dir)} className="mt-1 text-xs inline-flex items-center gap-1 text-primary hover:underline">
              <Filter className="h-3 w-3" /> Only sessions from this directory
            </button>
          )
        )}
        {detail.parent && (
          <button onClick={() => onOpen(detail.parent.session_id)} className="mt-1 text-xs inline-flex items-center gap-1 text-primary hover:underline" title={detail.parent.session_id}>
            <CornerDownRight className="h-3 w-3" /> part of {projectName(detail.parent.project_dir)} · {fmtStart(detail.parent.started_at)}
          </button>
        )}
      </div>
      {fam.sub_count > 0 && <PackageBlock fam={fam} onOpen={onOpen} />}
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Model</dt><dd>{s.model || '—'}</dd>
        <dt className="text-muted-foreground">Started</dt><dd>{fmtStart(s.started_at)}</dd>
        <dt className="text-muted-foreground">Duration / active</dt><dd>{fmtDuration(s.duration_s)} / {fmtDuration(s.active_s)}</dd>
        <dt className="text-muted-foreground">Turns</dt><dd>{s.turns}</dd>
        <dt className="text-muted-foreground">Input / output</dt><dd>{fmtTokens(s.input_tokens)} / {fmtTokens(s.output_tokens)}</dd>
        <dt className="text-muted-foreground">Cache read / write</dt><dd>{fmtTokens(s.cache_read)} / {fmtTokens((s.cache_write_5m || 0) + (s.cache_write_1h || 0))}</dd>
        <dt className="text-muted-foreground">Cost (list price)</dt><dd>{fmtCost(s.cost_usd)}</dd>
        {fam.agents.length > 0 && <dd className="col-span-2 text-muted-foreground">Figures above include the nested subagents; the Package block splits them out.</dd>}
      </dl>
      <Section title="Context" empty="No git/ticket context found in the transcript">
        {[
          s.git_repo && <Row key="repo" label="Repo" value={s.git_repo} />,
          s.git_branch && <Row key="branch" label="Branch" value={s.git_branch} />,
          s.pr && <Row key="pr" label="PR" value={`#${s.pr}`} />,
          s.ticket_id && <Row key="ticket" label={<>Ticket <span className="text-muted-foreground">({s.ticket_source})</span></>} value={s.ticket_id} />,
        ].filter(Boolean)}
      </Section>
      <QualityBlock s={s} />
      <SummaryBlock s={s} onSummarize={onSummarize} summarizing={summarizing} error={summaryError} />
      <Section title="Tools" empty="No tool calls">
        {detail.tools.map((t) => <Row key={t.tool} label={t.tool} value={t.count} />)}
      </Section>
      <Section title="Skills" empty="No skills used">
        {detail.skills.map((k) => (
          <Row key={k.skill} label={<>{k.skill}{k.edited ? <span className="ml-1 text-xs text-green-600 dark:text-green-400">edited</span> : null}</>} value={k.count} />
        ))}
      </Section>
      <Section title="Guard hits" empty="No guard hits">
        {detail.guard_hits.map((g, i) => (
          <div key={i} className="flex items-start gap-2 py-0.5">
            <span className={`text-xs px-1.5 py-0.5 rounded font-medium shrink-0 ${ACTION_CLS[g.action] || 'bg-muted text-muted-foreground'}`}>{g.action}</span>
            <code className="text-xs break-all">{g.command}</code>
          </div>
        ))}
      </Section>
    </div>
  )
}

/** Whole family at a glance: total, this transcript only, nested subagents, linked child sessions. */
function PackageBlock({ fam, onOpen }) {
  const rows = [
    ['Total', fam.rollup, 'font-medium'],
    ['Main only', fam.own, ''],
    fam.agents.length > 0 && [<span key="a" className="inline-flex items-center gap-1"><Bot className="h-3 w-3" />Subagents · {fam.agents.length}</span>, fam.agents_sum, ''],
    fam.children.length > 0 && [<span key="c" className="inline-flex items-center gap-1"><ShieldCheck className="h-3 w-3" />Linked · {fam.children.length}</span>, fam.children_sum, ''],
  ].filter(Boolean)
  return (
    <div className="rounded-md border p-2 space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="font-medium">Package <span className="text-xs font-normal text-muted-foreground">{describeSubs(fam.agents.length, fam.children)}</span></h3>
        <span className="text-lg font-semibold tabular-nums">{fmtCost(fam.rollup.cost_usd)}</span>
      </div>
      <table className="w-full text-xs tabular-nums">
        <thead>
          <tr className="text-muted-foreground">
            <th className="text-left font-normal py-0.5"></th>
            <th className="text-right font-normal py-0.5">Cost</th>
            <th className="text-right font-normal py-0.5">Active</th>
            <th className="text-right font-normal py-0.5">Tokens</th>
            <th className="text-right font-normal py-0.5">Turns</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map(([label, x, cls], i) => (
            <tr key={i} className={cls}>
              <td className="py-0.5 whitespace-nowrap">{label}</td>
              <td className="py-0.5 text-right">{fmtCost(x.cost_usd)}</td>
              <td className="py-0.5 text-right">{fmtDuration(x.active_s)}</td>
              <td className="py-0.5 text-right">{fmtTokens(x.input_tokens + x.output_tokens)}</td>
              <td className="py-0.5 text-right">{x.turns}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {fam.agents.length > 0 && (
        <Section title="Subagents" empty="">
          <Collapsible items={fam.agents} render={(a) => (
            <div key={a.agent_id} className="flex justify-between gap-2 py-0.5 text-xs" title={`${a.agent_id} · ${a.model || ''} · ${a.turns ?? 0} turns`}>
              <span className="truncate"><Bot className="inline h-3 w-3 mr-1 text-muted-foreground" />{fmtAgent(a)}</span>
              <span className="tabular-nums text-muted-foreground whitespace-nowrap">{fmtCost(a.cost_usd)} · {fmtDuration(a.active_s)}</span>
            </div>
          )} />
        </Section>
      )}
      {fam.children.length > 0 && (
        <Section title="Linked sessions" empty="">
          <Collapsible items={fam.children} render={(c) => (
            <button key={c.session_id} onClick={() => onOpen(c.session_id)} className="w-full flex justify-between gap-2 py-0.5 text-xs text-left hover:text-primary" title={c.session_id}>
              <span className="truncate"><ShieldCheck className="inline h-3 w-3 mr-1 text-muted-foreground" />{kindLabel(c.kind)} · {fmtStart(c.started_at)}</span>
              <span className="tabular-nums text-muted-foreground whitespace-nowrap">{fmtCost(c.cost_usd)} · {fmtDuration(c.active_s)}</span>
            </button>
          )} />
        </Section>
      )}
    </div>
  )
}

const PREVIEW_ROWS = 3

/** First PREVIEW_ROWS items, then a "Show N more" / "Show less" toggle. Resets when the item set changes. */
function Collapsible({ items, render }) {
  const [open, setOpen] = useState(false)
  const key = items.map((x) => x.agent_id || x.session_id).join('|')
  useEffect(() => { setOpen(false) }, [key])
  const shown = open ? items : items.slice(0, PREVIEW_ROWS)
  const hidden = items.length - PREVIEW_ROWS
  return (
    <>
      {shown.map(render)}
      {hidden > 0 && (
        <button onClick={() => setOpen((v) => !v)} className="py-0.5 text-xs text-primary hover:underline inline-flex items-center gap-1">
          {open ? <><ChevronDown className="h-3 w-3" /> Show less</> : <><ChevronRight className="h-3 w-3" /> Show {hidden} more</>}
        </button>
      )}
    </>
  )
}

function QualityBlock({ s }) {
  let d = null
  try { d = s.quality_detail ? JSON.parse(s.quality_detail) : null } catch { d = null }
  return (
    <div>
      <h3 className="font-medium mb-1">Quality <span className="text-xs font-normal text-muted-foreground">heuristic</span></h3>
      {s.quality_score == null ? <p className="text-xs text-muted-foreground">Not scored — run <code>npm run cc:ingest</code>.</p> : (
        <>
          <div className="text-2xl font-semibold tabular-nums">{s.quality_score}<span className="text-sm font-normal text-muted-foreground">/100</span></div>
          {d && (
            <div className="divide-y">
              <Row label="Verification ran" value={`${d.verified ? 'yes' : 'no'} · ${d.points.verified}`} />
              <Row label="Clean finish" value={`${d.clean_finish ? 'yes' : 'no'} · ${d.points.clean_finish}`} />
              <Row label="Tool error rate" value={`${d.error_rate_pct}% · ${d.points.error_rate}`} />
              <Row label="Loops" value={`${d.loops} · ${d.points.no_loops}`} />
              <Row label="Guard incidents" value={`${d.guard_incidents} · ${d.points.guard_clean}`} />
            </div>
          )}
        </>
      )}
    </div>
  )
}

function SummaryBlock({ s, onSummarize, summarizing, error }) {
  const sum = parseSummary(s)
  const v = summaryVersion(s)
  const title = displayTitle(s)
  const kind = effectiveKind(s)
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <h3 className="font-medium">Summary</h3>
        <Button variant="outline" size="sm" onClick={() => onSummarize(s.session_id)} disabled={summarizing}>
          <Sparkles className={`h-3.5 w-3.5 mr-1 ${summarizing ? 'animate-pulse' : ''}`} /> {summarizing ? 'Working…' : sum ? 'Regenerate' : 'Generate'}
        </Button>
      </div>
      {title && <p className="text-sm font-medium mb-1">{title}</p>}
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      {!sum && !error && <p className="text-xs text-muted-foreground">No summary yet — uses your local <code>claude</code> CLI (~1k tokens).</p>}
      {sum && (
        <div className="space-y-1 text-xs">
          <p>{sum.what}</p>
          <Row label="Outcome" value={sum.outcome ? `${OUTCOME_ICON[sum.outcome] || ''} ${sum.outcome}` : '—'} />
          <Row label="Kind" value={kind} />
          {sum.improvements?.length > 0 && <div><span className="text-muted-foreground">Improvements:</span><ul className="list-disc pl-4">{sum.improvements.map((x, i) => <li key={i}>{x}</li>)}</ul></div>}
          {sum.followups?.length > 0 && <div><span className="text-muted-foreground">Follow-ups:</span><ul className="list-disc pl-4">{sum.followups.map((x, i) => <li key={i}>{x}</li>)}</ul></div>}
          <p className="text-muted-foreground">{s.summary_model} · {fmtStart(s.summarized_at)}{v === 1 ? ' · older format, Regenerate to add a title' : ''}</p>
        </div>
      )}
    </div>
  )
}

function Section({ title, empty, children }) {
  const items = Array.isArray(children) ? children : [children]
  return (
    <div>
      <h3 className="font-medium mb-1">{title}</h3>
      {items.length ? <div className="divide-y">{items}</div> : <p className="text-xs text-muted-foreground">{empty}</p>}
    </div>
  )
}

function Row({ label, value }) {
  return (
    <div className="flex justify-between gap-2 py-0.5 text-xs">
      <span className="truncate">{label}</span>
      <span className="tabular-nums text-muted-foreground">{value}</span>
    </div>
  )
}

/** Sortable header cell: click toggles direction, arrow shows the active sort. */
function Th({ sortKey, sort, onSort, right, title, children }) {
  const active = sort.key === sortKey
  return (
    <th className={`py-2 pr-3 font-medium ${right ? 'text-right' : ''}`} title={title}>
      <button onClick={() => onSort(sortKey)} className={`inline-flex items-center gap-0.5 hover:text-foreground ${active ? 'text-foreground' : ''}`}>
        {children}
        {active && (sort.dir === 'desc' ? <ArrowDown className="h-3 w-3" /> : <ArrowUp className="h-3 w-3" />)}
      </button>
    </th>
  )
}

/** Group header row with subtotals (count, cost, active, tokens), then the group's family rows. */
function GroupRows({ group, showHeader, children }) {
  return (
    <>
      {showHeader && (
        <tr className="bg-muted/50 text-xs">
          <td colSpan={5} className="py-1 pr-3 pl-1 font-medium">{group.label} <span className="font-normal text-muted-foreground">· {group.count} session{group.count === 1 ? '' : 's'}</span></td>
          <td className="py-1 pr-3 text-right tabular-nums text-muted-foreground">{group.sum.turns}</td>
          <td className="py-1 pr-3 text-right tabular-nums text-muted-foreground">{fmtTokens(group.sum.input_tokens + group.sum.output_tokens)}</td>
          <td className="py-1 pr-3 text-right tabular-nums font-medium">{fmtCost(group.sum.cost_usd)}</td>
          <td className="py-1 pr-3 text-right tabular-nums text-muted-foreground">{fmtDuration(group.sum.active_s)}</td>
          <td colSpan={2}></td>
        </tr>
      )}
      {children}
    </>
  )
}

const CELL = 'py-1.5 pr-3'
const NUM = `${CELL} text-right tabular-nums whitespace-nowrap`

/** One family: the head row (rollup numbers) and, when expanded, its subagents and linked sessions. */
function FamilyRows({ fam, selected, expanded, onToggle, onOpen }) {
  const s = fam
  const hasSubs = fam.sub_count > 0
  const r = fam.rollup
  const breakdown = hasSubs
    ? `main ${fmtCost(fam.own.cost_usd)} · subagents ${fmtCost(fam.agents_sum.cost_usd)} · linked ${fmtCost(fam.children_sum.cost_usd)}`
    : ''
  const isChildHead = Boolean(CHILD_KINDS[s.kind]) // orphan child shown at top level
  return (
    <>
      <tr
        onClick={() => onOpen(s.session_id)}
        className={`border-b cursor-pointer hover:bg-muted/40 ${selected === s.session_id ? 'bg-muted/60' : ''}`}
      >
        <td className={`${CELL} whitespace-nowrap tabular-nums`}>
          <span className="inline-flex items-center gap-1">
            {hasSubs ? (
              <button
                onClick={(e) => { e.stopPropagation(); onToggle() }}
                className="h-4 w-4 -ml-1 inline-flex items-center justify-center rounded leading-none align-middle text-muted-foreground hover:text-foreground hover:bg-muted"
                title={expanded ? 'Collapse' : 'Expand subagents and linked sessions'}
                aria-label={expanded ? 'Collapse' : 'Expand'}
              >
                {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              </button>
            ) : <span className="inline-block h-4 w-4 -ml-1 align-middle" />}
            {fmtStart(s.started_at)}
          </span>
        </td>
        <td className={`${CELL} truncate max-w-[16rem]`} title={s.project_dir || ''}>
          {projectName(s.project_dir)}
          {s.kind === 'scheduled' && <span className="ml-1">{SCHEDULED_BADGE}</span>}
          {isChildHead && <span className="ml-1 text-xs px-1 py-0.5 rounded bg-amber-500/20 text-amber-700 dark:text-amber-400">{kindLabel(s.kind)}</span>}
        </td>
        <td className={`${CELL} whitespace-nowrap font-mono text-xs`} title={s.ticket_source ? `from ${s.ticket_source}` : ''}>{s.ticket_id || ''}</td>
        <td className={`${CELL} text-muted-foreground whitespace-nowrap`}>{s.model || '—'}</td>
        <td className={`${CELL} whitespace-nowrap text-xs`} title={hasSubs ? describeSubs(fam.agents.length, fam.children) : ''}>
          {fam.agents.length > 0 && <span className="inline-flex items-center gap-0.5 mr-1.5 text-muted-foreground"><Bot className="h-3.5 w-3.5" />{fam.agents.length}</span>}
          {fam.children.length > 0 && <span className="inline-flex items-center gap-0.5 text-amber-700 dark:text-amber-400"><ShieldCheck className="h-3.5 w-3.5" />{fam.children.length}</span>}
        </td>
        <td className={NUM} title={hasSubs ? `main ${fam.own.turns} · subagents ${fam.agents_sum.turns} · linked ${fam.children_sum.turns}` : ''}>{r.turns}</td>
        <td className={NUM}>{fmtTokens(r.input_tokens + r.output_tokens)}</td>
        <td className={`${NUM} ${hasSubs ? 'font-medium' : ''}`} title={breakdown}>{fmtCost(s.cost_usd == null && !hasSubs ? null : r.cost_usd)}</td>
        <td className={NUM} title={hasSubs ? `main ${fmtDuration(fam.own.active_s)} · subagents ${fmtDuration(fam.agents_sum.active_s)} · linked ${fmtDuration(fam.children_sum.active_s)}` : ''}>{fmtDuration(r.active_s)}</td>
        <td className={`${NUM} text-muted-foreground`}>{s.quality_score ?? '—'}</td>
        <td className="py-1.5">
          {isActive(s) && <span className="text-xs px-1.5 py-0.5 rounded bg-green-500/20 text-green-700 dark:text-green-400">active</span>}
          {s.status !== 'done' && <span className="text-xs text-muted-foreground">{s.status}</span>}
        </td>
      </tr>
      {expanded && fam.agents.map((a) => (
        <tr key={a.agent_id} className="border-b bg-muted/20 text-xs text-muted-foreground" title={`${a.agent_id} · ${a.model || ''}`}>
          <td className={`${CELL} whitespace-nowrap tabular-nums pl-6`}><span className="inline-flex items-center gap-1"><CornerDownRight className="h-3 w-3" />{fmtStart(a.started_at)}</span></td>
          <td className={`${CELL} truncate max-w-[24rem] text-foreground`} colSpan={2}><Bot className="inline h-3 w-3 mr-1 text-muted-foreground" />{fmtAgent(a)}</td>
          <td className={`${CELL} whitespace-nowrap`}>{a.model || '—'}</td>
          <td className={CELL}>subagent</td>
          <td className={NUM}>{a.turns ?? '—'}</td>
          <td className={NUM}>{fmtTokens((a.input_tokens || 0) + (a.output_tokens || 0))}</td>
          <td className={NUM}>{fmtCost(a.cost_usd)}</td>
          <td className={NUM}>{fmtDuration(a.active_s)}</td>
          <td className={NUM}></td>
          <td></td>
        </tr>
      ))}
      {expanded && fam.children.map((c) => (
        <tr
          key={c.session_id}
          onClick={() => onOpen(c.session_id)}
          className={`border-b cursor-pointer text-xs hover:bg-muted/40 ${selected === c.session_id ? 'bg-muted/60' : 'bg-muted/20'}`}
          title={c.session_id}
        >
          <td className={`${CELL} whitespace-nowrap tabular-nums pl-6`}><span className="inline-flex items-center gap-1"><CornerDownRight className="h-3 w-3 text-muted-foreground" />{fmtStart(c.started_at)}</span></td>
          <td className={`${CELL} truncate max-w-[24rem]`} colSpan={2}><ShieldCheck className="inline h-3 w-3 mr-1 text-amber-700 dark:text-amber-400" />{kindLabel(c.kind)}</td>
          <td className={`${CELL} text-muted-foreground whitespace-nowrap`}>{c.model || '—'}</td>
          <td className={`${CELL} text-muted-foreground`}>{c.entrypoint || 'linked'}</td>
          <td className={NUM}>{c.turns}</td>
          <td className={NUM}>{fmtTokens((c.input_tokens || 0) + (c.output_tokens || 0))}</td>
          <td className={NUM}>{fmtCost(c.cost_usd)}</td>
          <td className={NUM}>{fmtDuration(c.active_s)}</td>
          <td className={`${NUM} text-muted-foreground`}>{c.quality_score ?? '—'}</td>
          <td className="py-1.5">{isActive(c) && <span className="text-xs px-1.5 py-0.5 rounded bg-green-500/20 text-green-700 dark:text-green-400">active</span>}</td>
        </tr>
      ))}
    </>
  )
}

export default function SessionsPage() {
  // useSearchParams needs a Suspense boundary for the static prerender.
  return <Suspense fallback={null}><SessionsView /></Suspense>
}

function SessionsView() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const project = searchParams.get('project') || null
  const [sessions, setSessions] = useState([])
  const [agents, setAgents] = useState([])
  const [expanded, setExpanded] = useState(() => new Set())
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState(null)
  const [detail, setDetail] = useState(null)
  const [summarizing, setSummarizing] = useState(false)
  const [summaryError, setSummaryError] = useState(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [modelFilter, setModelFilter] = useState('any')
  const [qualityFilter, setQualityFilter] = useState('any')
  const [sourceFilter, setSourceFilter] = useState('any')
  const [quick, setQuick] = useState(() => new Set())
  const [groupBy, setGroupBy] = useState('none')
  const [sort, setSort] = useState({ key: 'started_at', dir: 'desc' })
  const view = searchParams.get('view') === 'calendar' ? 'calendar' : 'table'
  const span = searchParams.get('span') === 'month' ? 'month' : 'week'
  const dateParam = searchParams.get('date') || ''
  const date = useMemo(() => {
    const d = dateParam ? parse(dateParam, 'yyyy-MM-dd', new Date()) : new Date()
    return isValid(d) ? d : new Date()
  }, [dateParam])
  const range = useMemo(() => periodRange(date, span), [date, span])
  const rangeKey = `${range.since.toISOString()}|${range.until.toISOString()}`

  /** Merge into the current query string (null deletes) and replace the URL. */
  function setParams(patch) {
    const qs = new URLSearchParams(searchParams.toString())
    for (const [k, v] of Object.entries(patch)) (v == null ? qs.delete(k) : qs.set(k, v))
    const s = qs.toString() // not qs.size: older WebKit (desktop shell) lacks it
    router.replace(`/sessions${s ? `?${s}` : ''}`)
  }

  const loadSeq = useRef(0)
  async function load({ ingest = true } = {}) {
    const myId = ++loadSeq.current
    setLoading(true)
    try {
      // Bring the store up to date first (incremental: ~0.1 s when nothing changed).
      if (ingest) await fetch('/api/sessions/ingest', { method: 'POST' }).catch(() => {})
      const qs = new URLSearchParams(project ? { project } : {})
      if (view === 'calendar') { qs.set('since', range.since.toISOString()); qs.set('until', range.until.toISOString()) }
      else qs.set('limit', '1000')
      const r = await fetch(`/api/sessions?${qs}`)
      const d = await r.json()
      if (myId !== loadSeq.current) return // a newer load superseded this one
      setSessions(d.sessions || [])
      setAgents(d.agents || [])
    } finally {
      if (myId === loadSeq.current) setLoading(false)
    }
  }
  useEffect(() => { load() }, [project, view, rangeKey]) // eslint-disable-line react-hooks/exhaustive-deps

  async function open(id) {
    setSelected(id); setSummaryError(null)
    const r = await fetch(`/api/sessions?id=${encodeURIComponent(id)}`)
    setDetail(await r.json())
  }

  async function summarize(id) {
    setSummarizing(true); setSummaryError(null)
    try {
      const r = await fetch('/api/sessions/summarize', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) })
      const d = await r.json()
      if (!r.ok) { setSummaryError(d.error ? `${d.error}${d.detail ? ` — ${d.detail}` : ''}` : `HTTP ${r.status}`); return }
      setDetail(d)
      setSessions((prev) => prev.map((s) => (s.session_id === id ? { ...s, ...d.session } : s)))
    } catch (e) {
      setSummaryError(String(e?.message || e))
    } finally {
      setSummarizing(false)
    }
  }

  const families = useMemo(() => buildSessionTree(sessions, agents), [sessions, agents])
  const availableModels = Array.from(new Set(sessions.map((s) => s.model).filter(Boolean))).sort()
  // Filters apply to the family head; its subagents and linked sessions ride along.
  const filtered = filterSessions(families, { search: searchQuery, model: modelFilter, quality: qualityFilter, source: sourceFilter, quick: [...quick] })
  const filtering = searchQuery.trim() !== '' || modelFilter !== 'any' || qualityFilter !== 'any' || sourceFilter !== 'any' || quick.size > 0
  const groups = useMemo(() => groupFamilies(sortFamilies(filtered, sort), groupBy), [filtered, sort, groupBy])
  const totalCost = filtered.reduce((a, f) => a + (f.rollup.cost_usd || 0), 0)
  const subAgents = filtered.reduce((a, f) => a + f.agents.length, 0)
  const subChildren = filtered.flatMap((f) => f.children)
  const subsLine = describeSubs(subAgents, subChildren)

  function toggle(id) {
    setExpanded((prev) => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next })
  }
  function toggleQuick(k) {
    setQuick((prev) => { const next = new Set(prev); next.has(k) ? next.delete(k) : next.add(k); return next })
  }
  function sortBy(key) {
    setSort((prev) => (prev.key === key ? { key, dir: prev.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: key === 'started_at' ? 'desc' : 'desc' }))
  }
  const SEL = 'h-7 rounded-md border bg-transparent px-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring'

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <div className="flex-none px-4 py-2 border-b">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link href="/" className="text-muted-foreground hover:text-foreground transition-colors"><ArrowLeft className="h-5 w-5" /></Link>
            <h1 className="text-xl font-bold">Sessions</h1>
            <div className="inline-flex rounded-md border p-0.5" role="tablist" aria-label="View">
              {[['table', Table2, 'Table'], ['calendar', CalendarDays, 'Calendar']].map(([v, Icon, label]) => (
                <button key={v} role="tab" aria-selected={view === v}
                  onClick={() => setParams({ view: v === 'table' ? null : v })}
                  className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs ${view === v ? 'bg-secondary text-secondary-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
                  <Icon className="h-3.5 w-3.5" /> {label}
                </button>
              ))}
            </div>
            {project && (
              <button
                onClick={() => setParams({ project: null })}
                className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-secondary text-secondary-foreground hover:bg-muted"
                title={`${project} — click to clear`}
              >
                {projectName(project)} <X className="h-3 w-3" />
              </button>
            )}
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search ticket or project…"
              className="h-7 w-48 rounded-md border bg-transparent px-2 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
            <select
              value={modelFilter}
              onChange={(e) => setModelFilter(e.target.value)}
              className="h-7 rounded-md border bg-transparent px-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              title="Model"
            >
              <option value="any">Model: any</option>
              {availableModels.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
            <select
              value={qualityFilter}
              onChange={(e) => setQualityFilter(e.target.value)}
              className="h-7 rounded-md border bg-transparent px-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              title="Quality score (heuristic)"
            >
              {Object.entries(QUALITY_FILTERS).map(([key, { label }]) => (
                <option key={key} value={key}>{label}</option>
              ))}
            </select>
            <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)} className={SEL} title="Where the session was started">
              {Object.entries(SOURCE_FILTERS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select>
            {view === 'table' && <select value={groupBy} onChange={(e) => setGroupBy(e.target.value)} className={SEL} title="Group rows with subtotals">
              {Object.entries(GROUP_BY).map(([key, { label }]) => <option key={key} value={key}>{key === 'none' ? label : `Group: ${label}`}</option>)}
            </select>}
            <span className="text-sm text-muted-foreground">
              {filtering ? `${filtered.length} of ${families.length}` : families.length} sessions{subsLine ? ` (+ ${subsLine})` : ''} · {fmtCost(totalCost)} list price
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => load()} disabled={loading}>
              <RefreshCw className={`h-4 w-4 mr-1 ${loading ? 'animate-spin' : ''}`} /> Reload
            </Button>
            <ThemeToggle />
          </div>
        </div>
        <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
          {Object.entries(QUICK_FILTERS).map(([key, { label, title }]) => (
            <button
              key={key}
              onClick={() => toggleQuick(key)}
              title={title}
              className={`text-xs px-2 py-0.5 rounded-full border transition-colors ${quick.has(key) ? 'bg-primary text-primary-foreground border-primary' : 'bg-transparent text-muted-foreground hover:text-foreground hover:bg-muted'}`}
            >
              {label}
            </button>
          ))}
          {quick.size > 0 && (
            <button onClick={() => setQuick(new Set())} className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-0.5"><X className="h-3 w-3" /> clear</button>
          )}
        </div>
      </div>
      <div className="flex-1 flex overflow-hidden">
        <div className="flex-1 overflow-auto px-4">
          {view === 'table' && (<>
          {!loading && sessions.length === 0 && (
            <p className="text-sm text-muted-foreground py-6">{project ? 'No sessions recorded for this project yet.' : <>No sessions yet — run <code>npm run cc:ingest</code>.</>}</p>
          )}
          {!loading && sessions.length > 0 && filtered.length === 0 && (
            <p className="text-sm text-muted-foreground py-6">No sessions match the current filters.</p>
          )}
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-background">
              <tr className="text-left text-xs text-muted-foreground border-b">
                <Th sortKey="started_at" sort={sort} onSort={sortBy}>Started</Th>
                <th className="py-2 pr-3 font-medium">Project</th>
                <th className="py-2 pr-3 font-medium">Ticket</th>
                <th className="py-2 pr-3 font-medium">Model</th>
                <Th sortKey="sub_count" sort={sort} onSort={sortBy} title="Subagents and linked sessions (security reviews) — numbers on the row include them">Sub</Th>
                <Th sortKey="turns" sort={sort} onSort={sortBy} right>Turns</Th>
                <Th sortKey="tokens" sort={sort} onSort={sortBy} right>Tokens</Th>
                <Th sortKey="cost_usd" sort={sort} onSort={sortBy} right>Cost</Th>
                <Th sortKey="active_s" sort={sort} onSort={sortBy} right>Active</Th>
                <Th sortKey="quality_score" sort={sort} onSort={sortBy} right title="Quality score (heuristic)">Q</Th>
                <th className="py-2 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <GroupRows key={g.key} group={g} showHeader={groupBy !== 'none'}>
                  {g.items.map((f) => (
                    <FamilyRows key={f.session_id} fam={f} selected={selected} expanded={expanded.has(f.session_id)} onToggle={() => toggle(f.session_id)} onOpen={open} />
                  ))}
                </GroupRows>
              ))}
            </tbody>
          </table>
          </>)}
          {view === 'calendar' && (
            <CalendarView
              families={filtered}
              range={range}
              selected={selected}
              onOpen={open}
              onNavigate={(d) => setParams({ date: format(d, 'yyyy-MM-dd') })}
              onSpan={(s) => setParams({ span: s === 'week' ? null : s })}
              onRefresh={() => load({ ingest: false })}
            />
          )}
        </div>
        <aside className="w-96 flex-none border-l overflow-auto p-4">
          <DetailPanel
            detail={detail}
            project={project}
            onFilterProject={(dir) => setParams({ project: dir || null })}
            onOpen={open}
            onSummarize={summarize}
            summarizing={summarizing}
            summaryError={summaryError}
          />
        </aside>
      </div>
    </div>
  )
}
