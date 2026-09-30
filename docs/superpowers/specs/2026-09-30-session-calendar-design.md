---
status: approved
plan: docs/superpowers/plans/2026-09-30-session-calendar.md
created: 2026-09-30
origin: PoC vo vaulte "Erickov mind" (Google kalendár AI Sessions na web@trisoft.sk + mesačný report 2026-09)
---

# Session kalendár, popisy sessions a Codex ingest — návrh

## Kontext a cieľ

V PoC mimo Stow sme zobrali sessions za mesiac z `cc-sessions.db` (a Codexu z `~/.codex`) a nechali subagentov napísať popisy. Z toho vznikol Google kalendár a mesačný report. Obsah bol dobrý, ale bežal mimo Stow a výsledky sa do Stow nevrátili.

**Cieľ:** rovnaký obsah priamo v Stow dashboarde:
1. **Codex sessions** v session store, rovnocenne s Claude a Antigravity.
2. **Kalendárový pohľad** na hlavné sessions (týždeň / mesiac).
3. **Popisy sessions:** ručne pre jednu session (už existuje) a **hromadne pre všetky nevyplnené v aktuálne zobrazenom období**.

Všetko má stavať na existujúcej logike: `ingest-run.mjs`, `usage.mjs` (parseCodexLines), `summary.mjs`, `session-tree.mjs`, `session-filters.mjs`, `DetailPanel` na `/sessions`.

### Čo má popis obsahovať (z PoC, osvedčené)

| Pole | Zdroj | Poznámka |
|---|---|---|
| `title` | LLM (fallback: Claude `custom-title`/`ai-title`, potom prvý prompt) | ≤ 60 znakov, bez názvu projektu |
| `what` | LLM | 2–4 vety, konkrétne, v jazyku používateľa |
| `outcome` | LLM | `done` / `partial` / `abandoned` / **`exploration`** (nové) |
| `improvements` | LLM | čo reálne vzniklo, ≤ 5 |
| `followups` | LLM | čo ostalo / ďalší krok, ≤ 4 |
| `kind` | deterministicky, LLM len ako doplnok | `work` / `scheduled` / `agent-spawn` / `trivial` |
| projekt, harness, model, aktívny čas, ťahy, tokeny, cena, quality, branch | **už v DB** | LLM ich negeneruje |

V PoC bolo z 217 sessions 135 `work`, 48 `agent-spawn` (hlavne recenzie persón v Antigravity), 28 `scheduled` (ranný digest) a 6 `trivial`. Kalendár ukazuje predvolene len `work`.

---

## F1 — Codex ingest

**Nový modul `src/lib/cc/codex-ingest.mjs`**, rovnaký tvar ako `gemini-ingest.mjs`:
- `listCodexFiles(dir)`: exportovať z `usage.mjs`, neduplikovať.
- `parseCodexSession(text, {rawRef, projectDirs})` → sessions row + `_tools`, `_skills`, `_editedSkills`:
  - tokeny a model z `newFileState('codex')` + `parseCodexLines` (delta logika a reset čítačov sú už otestované),
  - `cost_usd` z `costForCodex` per model. Konzervačnú logiku z `addSession()` vytiahnuť do exportovanej funkcie a použiť na oboch miestach,
  - `session_id` = `session_meta.payload.id`; `cwd`, `git_branch`, `git_repo` zo `session_meta` (`git.branch`, `git.repository_url`),
  - `entrypoint` = `codex-` + normalizovaný `originator` (`cli` / `desktop` / `vscode` / `t3code`),
  - `turns` = počet `task_complete` (fallback `task_started`),
  - `_tools` z `function_call.name` / `custom_tool_call.name`,
  - `active_s` z existujúceho `tickActive` (gap < 300 s),
  - `project_dir`: rovnaký ledger matching ako Gemini (najhlbší projekt podľa `cwd`).
- **Subagenti Codexu** majú explicitný `parent_thread_id` v `session_meta`. `setParent()` sa nastaví priamo, bez časovej heuristiky. `kind = 'codex-subagent'` sa pridá do `CHILD_KINDS`.
- `ingest-run.mjs`:
  - `defaultIngestPaths` doplniť o `codexDir` (`CC_CODEX_DIR`, default `~/.codex/sessions`),
  - v `ingestAll` pridať tretí loop podľa vzoru Gemini (signature `basename:size:sec`, `ingest_state`, jedna transakcia na súbor).
- `session-filters.mjs`: `sourceOf` a `SOURCE_FILTERS` doplniť o `codex`.
- Quality skóre pre Codex zatiaľ `null` (ako Gemini). Adaptér na Claude-like lines je samostatná úloha.
- **Testy:** `codex-ingest.test.mjs` na fixtúrach (hlavná session, subagent s `parent_thread_id`, reset tokenov) + test v `ingest-run.test.mjs` s `codexDir`.
- ⚠️ Nemeniť správanie `usage.mjs` (poznámka TRI-STOW-0003 v CLAUDE.md), len vytiahnuť a exportovať helpery.

## F2 — Dátový model popisu a klasifikácia

**Summary schéma v2**, spätne kompatibilná. Stĺpec `summary` ostáva JSON string:
```json
{ "v": 2, "title": "…", "what": "…", "outcome": "done|partial|abandoned|exploration",
  "improvements": [], "followups": [], "kind_hint": "work|agent-spawn|trivial", "model": "haiku" }
```
- `SUMMARY_SCHEMA` a `SYSTEM_PROMPT` v `summary.mjs` rozšíriť o `title`, `exploration` a `kind_hint`. Prompt dostane aj názov projektu a metadáta. Pravidlá pre `kind_hint` a „nevymýšľaj“ zobrať z PoC promptu (príloha nižšie).
- **Nový stĺpec `title`** (cez `MIGRATION_COLS`), plnený pri ingeste:
  - Claude: posledný `custom-title` / `ai-title` z jsonl,
  - Codex: prvý reálny user prompt (bez `<environment_context>`), orezaný.
  - Po vygenerovaní summary sa `title` prepíše zo summary. Tým má kalendár nadpis aj bez LLM.
- **Efektívny `kind`**, čistá funkcia `effectiveKind(session)` v `session-link.mjs`, vyhodnocuje sa v tomto poradí:
  1. `parent_session_id` alebo `CHILD_KINDS` → `agent-spawn`,
  2. prvý prompt začína `<scheduled-task` → `scheduled`. Deterministicky pri ingeste do `kind`, napr. `kind='scheduled'`,
  3. `entrypoint` `sdk-*` bez interakcie → `agent-spawn`,
  4. inak `summary.kind_hint` (LLM), napr. persona-review spawny v Antigravity, ktoré sa inak rozlíšiť nedajú,
  5. default `work`.
- **Distill pre Codex:** `distillCodex(lines)` v `summary.mjs` (USER / ASSISTANT / TOOL z `response_item`) a vetva v `summarizeSession` podľa `entrypoint`/`raw_ref`.
- **Kvalita distillátu:** do hlavičky distillátu pridať to, čo v PoC pomohlo najviac: editované súbory (Edit/Write `file_path`), git commit messages a posledné 3 odpovede agenta. Súčasných 40 % hlava / 60 % chvost ponechať.

## F3 — Hromadné generovanie popisov

**Job runner `src/lib/cc/summary-batch.mjs`**, vzor `runIngest` inFlight singleton:
- `startBatch({since, until, ids?, filter, concurrency=3, model, force=false})`:
  - vyberie sessions `summary IS NULL` (alebo `v<2` pri `force='upgrade'`) v období, len top-level `work`/neznámy kind,
  - agent-spawn a scheduled preskočí, kým ich filter nezahrnie,
  - volá existujúce `summarizeSession(db, id)` s obmedzenou paralelnosťou,
  - drží stav `{id, total, done, failed[], running, startedAt}`. Pri `cli-missing` celý job zastaví, rovnako ako `evalSummaries`.
- **API:**
  - `POST /api/sessions/summarize-batch` body `{since, until, ids?, force?}` → `{jobId, total}`, druhý súbežný beh vráti bežiaci job,
  - `GET /api/sessions/summarize-batch` → stav jobu.
  - Voliteľne SSE event `cc_summarized` cez existujúci scan SSE kanál, inak stačí polling každé 2 s.
- **CLI:** `npm run cc:eval -- --summaries --since 2026-09-01 --until 2026-10-01 --concurrency 3`. `evalSummaries` prepnúť na `summary-batch.mjs`, aby existovala jedna implementácia.
- **MCP** (`src/mcp/server.mjs`), nové nástroje:
  - `list_sessions {since, until, project?, kind?}` → riadky + summary,
  - `summarize_sessions {since, until, force?}` → spustí batch a vráti stav.
  - Aktualizovať smoke test a zoznam v CLAUDE.md.
  - Vďaka tomu vie mesačný report generovať agent priamo zo Stow, bez PoC skriptov.
- **Import PoC popisov (jednorazovo):** `scripts/cc-import-summaries.mjs <sessions.json>` zapíše 217 hotových popisov z PoC ako summary v2 (`model: 'sonnet-poc'`), cez `setSummary` a len tam, kde je `summary IS NULL`. September je potom v kalendári hneď vyplnený a nemusí sa generovať znova.
- **Model (rozhodnuté):** hromadné generovanie používa **Sonnet 5.5** (`claude-sonnet-5-5`, env `CC_SUMMARY_BATCH_MODEL`). Ručné Generate pre jednu session ostáva na `CC_SUMMARY_MODEL` (default haiku). `model` sa dá prepísať parametrom batchu.
- **Odhad trvania:** `estimateBatch({count, concurrency})` → `{count, seconds}`:
  - `summarizeSession` si do summary JSON uloží aj `ms` (trvanie volania CLI),
  - odhad = `ceil(count / concurrency) × medián(ms)` posledných 50 batch-model summaries,
  - kým história nie je, fallback **30 s/session** pre Sonnet a 10 s pre haiku,
  - zobrazuje sa zaokrúhlene („~4 min“).
  - `GET /api/sessions/summarize-batch?since&until` bez jobu vráti `{missing, estimateSeconds}`. Ten istý výpočet používa UI prompt aj MCP.

## F4 — Kalendárový pohľad (kukátko)

**Umiestnenie:** prepínač pohľadu na `/sessions`: `Tabuľka | Kalendár` (query `?view=calendar&date=2026-09-09&span=week`). Filtre (search, model, source, quality, quick chips) aj pravý `DetailPanel` so `SummaryBlock` sa zdieľajú, žiadna nová stránka ani duplicitný detail.

**Dáta:**
- `listSessions` a `GET /api/sessions` doplniť o `since` / `until` (ISO, lokálne hranice dňa prepočítané na UTC). Kalendár si ťahá len zobrazené obdobie a limit 1000 prestane vadiť.
- Oprava: `analytics.mjs` `perDay` počíta UTC dni, `/sessions` lokálne. Zjednotiť na lokálne dni (helper `localDay` zo `session-tree.mjs`).

**Pravidlá umiestnenia udalosti** (čistá funkcia `calendarSlot(session)` v novom `src/lib/cc/session-calendar.mjs`, testovaná):
- `start = started_at`,
- `end = ended_at`, ak rozpätie ≤ 5 h. Inak `start + max(active_s, 30 min)`, lebo desktop sessions nechané otvorené cez noc by inak zaplnili deň,
- minimálna výška 15 min,
- prekrývajúce sa udalosti idú vedľa seba do stĺpcov (`layoutDay(events)` → `{col, cols}`),
- ukazujú sa len top-level rodiny (`buildSessionTree`) a subagenti sa rátajú do rodiča (`familyOf().rollup`: cena, tokeny, počet sub-sessions),
- predvolene sa zobrazuje `effectiveKind === 'work'`. Chip „+ agent/scheduled“ ich zobrazí stlmene.

**Týždeň (default):** časová mriežka 7 × 24 h (lokálny čas, pondelok ako prvý deň), date-fns na navigáciu (‹ Dnes ›). Blok udalosti:
- farba podľa projektu (deterministický hash `project_dir` → `--viz-1..6` + odtieň),
- text `title` (fallback prvý prompt), pod ním projekt · aktívne min · $,
- ikonka výsledku ✅ 🟡 ⛔ 🔍, bodka „bez popisu“ pre chýbajúci summary,
- ikonka harnessu (Claude / Gemini / Codex).

**Mesiac:** mriežka dní, v každom dni max. 4 chipy + „+N“ a súčet aktívnych hodín dňa. Voliteľne heatmap pozadie podľa hodín.

**Hlavička obdobia:** štatistiky zobrazeného obdobia (sessions, aktívne h, cena, podiel done/partial) zo `sessionAnalytics({since, until})`.

**Otázka na doplnenie popisov (rozhodnuté):**
- Po načítaní obrazovky aj po zmene obdobia sa zavolá `GET …/summarize-batch?since&until`.
- Ak `missing > 0` a nebeží job, zobrazí sa nad kalendárom **nemodálny banner**: „V tomto období chýba popis pri **N** sessions. Dotiahnuť? Odhad **~X min** (Sonnet 5.5).“ Tlačidlá **[Dotiahnuť] [Teraz nie]**.
- „Teraz nie“ skryje banner pre toto obdobie do konca behu appky (sessionStorage kľúč `since|until`). Pri ďalšom otvorení appky sa otázka zopakuje.
- **Rozsah = presne to, čo je v kalendári zobrazené** (rozhodnuté): aktuálne obdobie (týždeň alebo mesiac, **maximálne jeden mesiac**, ľubovoľný) **plus aktívne filtre** (search, model, source, quality, quick chips, zapnuté agent/scheduled). Banner aj batch dostanú zoznam `ids` zobrazených udalostí bez popisu, nie vlastný výber na serveri. Tým sa počet v banneri a to, čo sa dotiahne, vždy zhodujú.
- Z toho sa vynechajú sessions mladšie ako 10 min, aby sa nepopisovala práve bežiaca session.
- API pre banner: `POST /api/sessions/summarize-batch/estimate {ids}` → `{missing, estimateSeconds}`. Batch: `POST /api/sessions/summarize-batch {ids}`. Varianta `since/until` ostáva len pre CLI a MCP.
- Po „Dotiahnuť“ sa banner zmení na progress („12 / 34 · zostáva ~2 min“). Udalosti sa prekresľujú, ako popisy pribúdajú. Zlyhania sa ukážu na konci s možnosťou zopakovať ich.
- Ak už beží job (napr. spustený cez MCP), namiesto otázky sa rovno ukáže jeho progress.
- Banner je **len v kalendárovom pohľade**. Tabuľka ho nemá.
- Najdlhší pohľad je mesiac. Iné rozsahy (kvartál, „všetko“) kalendár nemá, takže jeden batch má najviac ~1 mesiac sessions (v septembri 135 hlavných).

**Klik na udalosť** → `open(id)` → existujúci `DetailPanel`. `SummaryBlock` sa rozšíri o `title` a `kind`, tlačidlo Generate/Regenerate ostáva, čo je ručná tvorba popisu.

**Knižnica:** žiadnu kalendárovú knižnicu nepridávať. Týždenná mriežka je jednoduchý CSS grid (Tailwind) + date-fns, čo sedí so zvyškom appky bez závislostí.

## F5 (voliteľné, neskôr) — Export obdobia
- „Export .ics“ z kalendára (UID `<session_id>@stow-sessions`, formát z PoC `99-Meta/ai-sessions/build_ics.py` vo vaulte).
- „Report obdobia“ (markdown) cez MCP `list_sessions` + agent: čomu som sa venoval / hotové / rozrobené / čo treba riešiť.

## Poradie a závislosti

```
F1 Codex ingest ──┐
F2 schéma v2 + title + kind ──┼─> F3 batch (API/CLI/MCP) ──> F4 kalendár UI ──> F5
```
F1 a F2 sú nezávislé, dajú sa robiť paralelne. F4 potrebuje `since/until` z F2 a tlačidlo z F3.

## Otvorené otázky
1. ~~Model pre batch~~ → **Sonnet 5.5** (rozhodnuté 2026-09-30).
2. ~~Automaticky alebo na klik~~ → **pri načítaní obrazovky sa opýta**, s počtom chýbajúcich a odhadom času (rozhodnuté 2026-09-30).
3. ~~Obdobie pre banner~~ → **všetko zobrazené v kalendári** (obdobie ≤ 1 mesiac + aktívne filtre). Banner je len v kalendári (rozhodnuté 2026-09-30).
4. ~~Codex subagenti v kalendári~~ → **len v rollupe rodiča**. `parent_session_id` = koreňový thread (`session_meta.payload.session_id`), nie priamy `parent_thread_id`: v dátach je aj vnorenie depth 2 a strom rodín je jednoúrovňový (rozhodnuté 2026-09-30).

## Rozhodnutia z revízie proti kódu (2026-09-30)

5. **Stav batch jobu je v SQLite** (tabuľka `summary_jobs` v `cc-sessions.db`), nie v pamäti procesu. MCP server je samostatný stdio proces a Deno app má dynamický port, takže in-process singleton by job spustený z MCP pred UI skryl. Súbežný beh blokuje job so živým heartbeatom (< 60 s). Job so starším heartbeatom sa považuje za mŕtvy.
6. **Nadpis:** ingest ukladá `title` + `title_source` (`custom` | `ai` | `prompt`) a summary do stĺpca `title` **nezapisuje**. Zobrazený nadpis sa počíta pri čítaní (`displayTitle`) v poradí: ručný `custom-title` > `summary.title` > `ai-title` > prvý prompt. Pri scheduled tasku je nadpisom meno tasku z `<scheduled-task name="…">`.
7. **PoC import** zapíše v2 popis všade, kde popis chýba **alebo je v1** (29 v1 popisov v DB nemá `title` ani `kind_hint`). Spúšťa sa až po F1, aby sa trafili aj 2 Codex sessions.
8. **Nový stĺpec `user_prompts`** (počet ľudských promptov, teda tých, čo nezačínajú `<`). `kind='scheduled'` sa pri ingeste uloží len vtedy, keď prvý prompt je `<scheduled-task` a `user_prompts = 0`. Keď človek pokračoval, ide o `work` (pravidlo z PoC). Pravidlo „sdk bez interakcie“ = `sdk-*` a `user_prompts ≤ 1`. `listParentCandidates` berie `kind IN ('main','scheduled')`, aby security review zo scheduled behu nezostal sirotou.
9. **Štatistiky hlavičky obdobia** sa počítajú na klientovi zo zobrazených udalostí, nie cez `sessionAnalytics({since, until})`. Tak sedia s bannerom aj s filtrami. `perDay` v `analytics.mjs` sa na lokálne dni opraví aj tak.
10. **Texty UI sú anglicky**, rovnako ako zvyšok `/sessions`. Banner: „N sessions in this period have no summary. Fill them in? ~X min (Sonnet 5.5) [Fill in] [Not now]“.
11. **Ikonka harnessu** je písmenkový odznak (C / G / X). Lucide nemá brand ikony a nová závislosť kvôli tomu nedáva zmysel.
12. **Codex subagent** má v `CHILD_KINDS` príznak `explicitParent: true`. `linkChildren` ho z časového párovania vynechá, lebo rodiča nastaví ingest priamo.
13. **Mesačný pohľad** ťahá presne kalendárny mesiac (`[1. deň, 1. deň ďalšieho)`). Dni z okolitých mesiacov v mriežke sú stlmené a prázdne.
14. F5 (export .ics, report) nie je súčasťou plánu.

## Príloha — PoC prompt pre popis (osvedčený)
- kontext o projektoch používateľa (InteliMail ekosystém, TriSoft, Vydavateľstvo, vault, Sandbox),
- výstup: `title`, `project`, `what` (2–4 vety, konkrétne), `outcome`, `improvements` ≤ 5, `followups` ≤ 4, `kind` + `skip_reason`,
- pravidlá pre kind:
  - `scheduled` = automatický beh bez ďalšej interakcie; ak človek potom pokračoval, je to `work`,
  - `agent-spawn` = strojovo generovaný prompt (dispatch, persona review, security review),
  - `trivial` = < 2 zmysluplné výmeny, nič nevzniklo,
- „Nevymýšľaj – ak sa z výťahu nedá zistiť výsledok, napíš to opatrne.“
- Referenčné dáta PoC: vault `99-Meta/ai-sessions/2026-09/sessions.json` (217 sessions s popismi). Dajú sa použiť ako fixtúry alebo na porovnanie kvality haiku vs. sonnet.
