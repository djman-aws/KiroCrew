---
title: Crew log based telemetry export -- one counting fold per module, behind the existing consent gate
status: draft
author: chenmingwei23
created: 2026-10-16
last-audited: 2026-10-16
audited-at: 1a2eb5435c
doc-pr: null
implementation-prs: []
tracking-issues: [21270, 21271]
supersedes: []
superseded-by: []
---

# RFC: crew log based telemetry export

- Status: draft. Nothing is built. Code facts are measured at `1a2eb5435c`.
- Author: chenmingwei23
- Tracking issues: [#21270](https://github.com/kirodotdev/KiroCrew/issues/21270)
  (the epic), [#21271](https://github.com/kirodotdev/KiroCrew/issues/21271) (this
  document)
- Related: [metrics.md](../system-specs/modules/metrics.md) (the instruments, the
  consent gate and the local sink that already exist),
  [crew-log-projection.md](../system-specs/modules/crew-log-projection.md) (the fold
  contract, the eager publish and the savepoints this design rests on),
  [crew-log-core.md](../system-specs/modules/crew-log-core.md),
  [crew-log-emitter.md](../system-specs/modules/crew-log-emitter.md)

## 1. Summary

Telemetry today cannot say how Kiro Crew is actually used. How many sessions a
conductor opens against a worker, how many turns each kind of actor causes, how
deep a session tree gets -- none of it is recorded as a metric. The raw facts are
already in the crew log: `session/opened` carries the agent name,
`turn/started` carries a closed `actor` value. What is missing is a summary layer
and one export path.

This RFC proposes both, in the smallest shape the existing code already supports:

1. **One small counting fold per module** on the crew log, each holding a fixed
   set of numbers and nothing else.
2. **One OpenTelemetry subscriber** on the projection bus, which reads those folds
   when they advance and records the numbers. It is a subscriber like any other,
   not a second path into the raw log.
3. **No new consent surface.** It is gated by `telemetry.enabled`, which is off by
   default and writes to a local sink with no network egress.

## 2. Motivation

`src/kiro_crew/metrics/` records the process and its machine: HTTP requests,
database calls, tool calls, turns, provider traffic, installed inventory. Those
instruments are keyed by the runtime, never by the shape of the crew running on
it, so a maintainer cannot answer a question about how the product is used from
them.

The crew log holds the facts, entry by entry. It just holds them as individual
events: answering "how many sessions did a worker open" from it means folding the
log, which is the thing a projection already does for every other reader.

## 3. Goals and non-goals

Goals:

- Report counts and distributions per module, derived from the crew log.
- Add no work to the crew log append path.
- Keep every attribute value inside a closed set that a reader can point at in the
  code.
- Ship behind the consent gate that already exists, still off by default.

Non-goals:

- Moving the existing instruments. Process, host, gateway internals and installed
  inventory stay in `src/kiro_crew/metrics/` and are not touched.
- A new egress path. No raw crew log entry is exported, and no new network
  destination is added.
- Per-person detail. See section 8.

## 4. Design

### 4.1 Which source owns which data

| Kind of data | Where it comes from |
|---|---|
| What happens inside a session, a crew or a member | a counting fold on the crew log |
| The process, the host, gateway internals, the installed inventory | the existing instruments in `src/kiro_crew/metrics/` |

The split is by kind of data, not by convenience. A fact the crew log already
records is read from the crew log; a fact only the running process knows stays
where it is measured.

### 4.2 The export goes through a projection

The crew log append path pays one `queue.Queue.put_nowait` and nothing else; the
eager worker folds the delta on another thread, and `crew_log/bus.py` publishes a
`FoldAdvanced` when it lands. The OpenTelemetry export subscribes to that
publish.

This is the whole reason the shape is a projection rather than a hook on the
append path: **what telemetry wants is counts and distributions, which are
summaries.** A projection is where a summary is computed in this codebase, and
putting it there means the append path carries no subscriber at all -- a slow or
failing exporter cannot reach a writer.

The opposite choice is reasonable for a different payload. A comparable system
that exports raw events forwards whole event bodies as log records: it has nothing
to summarise, so it hangs its forwarder off the event hook and sends
synchronously. When that same system does want a summary, it folds one first. The
shape follows the payload, not a preference, and our payload is a summary.

The export contract that S1 ([#21272](https://github.com/kirodotdev/KiroCrew/issues/21272))
establishes is this subscriber, kept deliberately small: two instrument kinds,
a counter and a histogram, and one subscription on `SCOPE_SESSION`
(`crew_log/bus.py`). It carries no observable-gauge channel and no loop over
scopes, because the one gauge this design needs does not ride the bus at all
(section 5). Each module's counters and histograms register only when the gate
is on.

### 4.3 One counting fold per module, not one export projection

The dashboard folds are the pattern to copy: `projection_dashboard.py` carries
`panel`, `agentic` and `mistakes` as three separate folds, each owning one subject
and each with its own limits.

A single export projection would instead run every module's step on every entry
any module names, and carry one `state_version` for all of them -- so a change to
one module's counters invalidates every saved copy of every other module's.
Separate folds keep that blast radius at one module.

A fold declares `affects`, `mode` and `state_version` in
`crew_log/projection_registry.py`. Eager is the default and requires `affects`,
and an eager fold must be named in `EAGER_SLOT_FOLD_NAMES` or
`EAGER_SESSION_FOLD_NAMES` or it is refused at import. A counting fold is
ordinary on all three counts.

### 4.4 What a counting fold may hold

A fixed set of numbers. The step adds one or subtracts one.

No lists, no identifiers, no names, no paths. That single rule is both the privacy
control and the performance control: `crew-log-projection.md` section 2 requires a
fold's state to be bounded by construction, and a fold that only counts is bounded
by its own shape rather than by a limit someone has to remember to set.

### 4.5 Every attribute value comes from a closed set

Each attribute value must point at a closed constant in the code, mapped down in
the fold -- not at the export layer -- to an enum with an `other` fallback. The
fold does the mapping so that a savepoint stores the already-mapped value and a
replay reproduces it from the log alone; nothing the mapping reads may come from
outside the log, or a restored count could disagree with the count first
recorded.

- `turn/started.actor` is already closed. `ACTOR_VALUES` in
  `crew_log/entry_types_lifecycle.py` declares eight values with
  `enum_closed=True`, and the emitter coerces anything outside the set to `other`
  before it builds the entry, so no call site can widen it. The attribute is the
  field as declared.
- `session/opened.agent` is **not** closed. It is declared a plain string
  (`Field("agent", JSON_STRING, required=True)`), because an operator's own agent
  spec is a legitimate value. So the fold maps it: a filename in
  `OWNED_KIRO_AGENT_FILES` (`agent_files.py`) keeps its own value, and everything
  else folds, as S1 ([#21272](https://github.com/kirodotdev/KiroCrew/issues/21272))
  implements it, into a small set of fixed buckets that always includes `other`.
  Whatever the exact buckets, each is decided by the log content alone: the
  operator's chosen name never becomes an attribute value, and the mapping reads
  nothing from outside the log.

Nothing in `agent_kind` may be decided by a fact the log does not carry. In
particular, whether a session belongs to a crew member is not such a fact today:
`session/opened` has an `agent` string and no field that marks a session as a
member's. A bucket that tried to say so would have to read crew config outside
the log -- exactly the cross-log dependency the fold-side mapping rule above
forbids, because a savepoint resumed under different crew bindings would then
recount differently. If such a bucket is wanted, it needs a log-derived signal
first: an existing declared field that already distinguishes a member session,
or a new one S1 adds to `session/opened` as a second append-path exception
alongside `depth`. That is question 8 in section 11, not a thing this document
decides.

Five things stay on the machine in every story: agent names an operator wrote,
member keys, slot keys, working directories and MCP server names.

This is the bar `metrics/schema.py` already sets. It pins the `NS_CORE`
namespace, caps attribute count and value length, and states why: the recorder
caches one instrument per distinct name for the life of the process, so an
unbounded value is a cardinality bomb rather than a slightly noisy chart.

### 4.6 Consent, and where the numbers go

`TelemetryConfig` in `config/sections_telemetry.py` owns the gate.
`telemetry.enabled` defaults to false, and with it off the metric call sites are
no-ops that write nothing. With it on, aggregated metrics go to a local sink under
the data home and **no network egress happens**: `otlp_endpoint` is empty by
default and pointing it at a collector is a separate, deliberate opt-in. An
enterprise policy can pin the whole thing off through the
`capabilities.telemetry` governance scope.

This RFC adds no switch of its own. The subscriber is registered only when that
gate is on. A session's fold render is CUMULATIVE over the session's life, while
an OTel counter's `.add()` wants a DELTA, so the callback keeps an in-memory
per-session memo of the last rendered value it exported and diffs the new
delivery against that memo, adding only what changed; the OpenTelemetry SDK's
own periodic export does the writing from there. No I/O, and no lock the
callback waits on, runs inside a bus callback. Section 4.7 covers how the first
delivery for a session is handled, which is the case this diff alone does not
settle.

The roots gauge of section 5 does not go through a bus callback at all. It is
registered with `meter.create_observable_gauge` and read on the OpenTelemetry
collect thread, so nothing is added to the writer thread or to the bus for it;
section 5 carries that wiring.

### 4.7 Restart

Both fold families resume from disk, so a counting fold does not restart from
zero. `crew_log/checkpoint.py` carries `CHECKPOINT_DIR` for session folds and
`SLOT_CHECKPOINT_DIR` for slot folds, with `slot_checkpoint_path`, `load_slot` and
`slot_resume_still_verifies` as the slot half; `crew-log-projection.md` section
7.1 is the contract, including the identity block a savepoint must match before it
is admitted.

One consequence for this design: a counting fold keyed by slot is as cheap to
resume as a session-keyed one, so it does not need `mode = "lazy"` to avoid a
cold fold.

The export's own memo (section 4.6) is a different story, because it is
in-memory and does not resume from disk. A session's render stays cumulative
across a gateway restart, but the memo that tracks "what has already been
exported for this session" starts empty again, so the restarted process's
first delivery for any session -- a brand-new session, or one that was already
open before the restart -- cannot be diffed against a real prior: diffing it
against an empty memo would re-add a total already exported once. The export
therefore treats EVERY session's first delivery in a process's life as a
baseline: it records that delivery's value as the floor and emits nothing, then
diffs every later delivery against that floor. The cost lands on one side
only -- a session already mid-life at restart time under-counts the turns it
had accrued before the restart, never over-counts -- and that direction is the
one a monotonic counter can tolerate, because a counter the export reports as
`N` is a floor the true count never falls below. A monotonic instrument is
still the right type for a strictly-increasing quantity (a session or turn
count only grows); what makes a restart safe for it is this baseline-on-first-
sight rule in the export, not the fold's own on-disk resume.

One correction is owed alongside the first implementation: the module docstring in
`crew_log/eager.py` describes a savepoint for a slot fold as something that "would
be a store of its own", written before `SLOT_CHECKPOINT_DIR` existed. It exists.
That text is corrected in the pull request that adds the first counting fold,
rather than here, because it is a code comment.

## 5. What this round adds

| Metric | Type | Attributes | Where the number comes from |
|---|---|---|---|
| session starts by agent kind | counter | `agent_kind`, folded from `session/opened.agent` per section 4.5 | the `session/opened` entry |
| turn starts by actor | counter | `actor`, the declared `ACTOR_VALUES` | the `turn/started` entry |
| session tree depth | histogram | none | the `depth` field on `session/opened` |
| session tree roots | observable gauge | none | `count_roots_with_children`, a new reader S2 adds to the session tree projection, scanned on each OpenTelemetry collect |
| export lag | histogram | none | the subscriber timing its own callback |

The roots metric reads the tree structure that already lives in the session
tree projection; it does not keep that structure in a counting fold. This is
the distinction section 4.3 draws, applied to one gauge: **the counting fold
holds only numbers and never a session id, and the roots gauge holds nothing at
all -- it is scanned fresh on each collect.** The projection is already the
place the tree is folded and bounded; the export is one more reader of it, the
same way every dashboard panel is a reader of a projection. So "a counting fold
holds no identifier" and "the roots gauge reports how many roots have children"
do not conflict: the gauge never asks the fold for that number, it asks the
projection, which holds the tree because holding the tree is its job.

A gauge is wired differently from a counter, and in the simplest way the
OpenTelemetry SDK already offers. S2
([#21273](https://github.com/kirodotdev/KiroCrew/issues/21273)) registers it
with `meter.create_observable_gauge`, the same call the existing inventory
gauges use (`metrics/inventory_gauges.py`). The SDK then calls the gauge's
observe function on its own collect thread, once per collect; that function
reads `count_roots_with_children` off the session tree projection and returns
the number. Because the SDK pulls a value on every collect, the gauge always
has one to return -- there is no dirty flag, no cached last value, and so no gap
on a quiet interval. Nothing is added to the writer thread or to `crew_log/bus.py`:
the gauge does not subscribe to `TREE_ADVANCED` or to any publish at all.

The scan is bounded. The session tree store walks at most `TREE_UNIT_CAP`
(`crew_log/session_tree.py`, 4096) units per scan, so the gauge's read is a
bounded pass on the collect thread, off the hot path, not on the append path
and not in any bus callback.

`count_roots_with_children` does not exist on the projection today; S2 adds it
as a new read method on `SessionTreeProjection`
(`crew_log/session_tree_projection.py`), taking that projection's `_lock` for
the read the same way its other readers do. S2's implementation reports a count
of 0 before the projection has finished seeding (an incomplete or unseeded tree
reads as 0). Whether a not-yet-seeded tree should instead report its count as
unknown -- so a reader cannot mistake "not measured yet" for "measured as zero",
per the `crew-log-projection.md` section 2 rule that absent is never read as
zero -- is left as question 7 in section 11 rather than settled here.

"Tree size" (how many sessions a tree holds) is not in this round. Counting it
once per tree is the same count-once problem a roots counter would have had,
and a size gauge read off the projection the same way is a reasonable next-round
metric; it is left for the phase that adds it rather than specified here.

Exact metric names and histogram bucket boundaries are **as in the implementation
pull requests** for [#21272](https://github.com/kirodotdev/KiroCrew/issues/21272)
(session and turn counts) and
[#21273](https://github.com/kirodotdev/KiroCrew/issues/21273) (the session tree).
This document fixes no number: a bucket boundary is measured against real logs, not
chosen in prose, and a name invented here would be a second source of truth for it.
Names live in the `NS_CORE` namespace that `metrics/schema.py` enforces.

Two notes on the new field. `session/opened` declares no `depth` today, so
[#21273](https://github.com/kirodotdev/KiroCrew/issues/21273) adds one; it is a
value the writer already holds at the moment it writes the entry, which is why it
is the one addition section 6 allows on the append path. And it needs a name that
cannot be confused with `turn/started.depth`, which is already declared as prompt
depth and means something else.

## 6. The rules that keep it off the hot path

1. **Nothing new on the append path.** The single exception is the `depth` field
   in section 5, a value already in hand at write time.
2. **A counting fold's step adds one or subtracts one.** No scan, no allocation
   that grows with the log.
3. **The bus callback touches memory only.** No I/O, no waiting on a lock. The
   roots gauge adds nothing to the bus at all: it is an observable gauge the
   OpenTelemetry SDK reads on its own collect thread, so its one bounded scan of
   the projection runs there, not in any bus callback and not on the append
   path.
4. **The export reports its own cost** as one of its own metrics, so "it does not
   slow anything down" is a measurement rather than a claim.
5. **A counting fold adds no new wake.** Every committed entry already wakes the
   eager worker, because `status` and `class` declare `affects = KNOWN_TYPES`. A
   new fold rides a wake that already happens.

## 7. Phases

Each phase is one pull request, independently shippable and independently
abandonable, because each adds one fold and the metrics that read it.

| # | Phase | Exit criteria | This round |
|---|---|---|---|
| S1 | The export subscriber, plus the first counting fold: session starts by agent kind, turn starts by actor ([#21272](https://github.com/kirodotdev/KiroCrew/issues/21272)) | With the gate off, no instrument is created and no fold state is written. With it on, the two counters appear in the local sink and the `agent_kind` mapping emits no operator-written name. The export reports its own callback time. | pull request |
| S2 | Session tree: a `depth` field on the opening entry, a depth histogram, and a roots observable gauge read off the session tree projection on each collect ([#21273](https://github.com/kirodotdev/KiroCrew/issues/21273)) | An entry written before the field exists still folds, reported as unknown depth rather than zero. The append path gains no lookup. The roots gauge adds nothing to the writer thread or the bus; the count is scanned on the collect thread (bounded by `TREE_UNIT_CAP`), and no counting fold holds a session id. | pull request |
| S3 | Sessions open at once | The count returns to zero after every session in a run is closed, including a session that was killed and wrote no closing entry. The source for a session that died without writing `session/closed` is named in section 11, question 6, before this phase is scoped. | later |
| S4 | Work ledger: nesting, item states, and how long a report waits to be accepted | written when the phase is scoped | later |
| S5 | Shared MCP: which route a tool call took | written when the phase is scoped | later |
| S6 | Counts of crew members, dashboards and projects | written when the phase is scoped | later |
| S7 | This document, and the questions in section 11 | A maintainer has answered section 11 or listed what must change. | document |

S3 is deliberately not folded into S1. A session that is killed writes no closing
entry, so an add-on-open and subtract-on-close pair drifts upward forever; its
exit criterion above is the whole reason it is a phase of its own, and section 11
question 6 is the open point that has to be answered before it is scoped.

S1 is blocked on question 1 and question 3 of section 11: both decide what the
first fold is allowed to count.

## 8. Backward compatibility

Compatible. Nothing here rejects, renames or removes anything the code accepts
today.

- No existing metric changes name, type or attributes.
- No existing entry type changes. S2 ADDS an optional field to `session/opened`;
  an entry written without it is read as unknown rather than as zero, which is
  what `crew-log-projection.md` section 2 already requires of a reader ("absent is
  never read as zero").
- A new fold is a new name in the registry. An older copy of the code that does
  not know the name reads no savepoint for it, which is the cold-fold path that
  already exists for every fold on its first read.
- The consent default does not move. `telemetry.enabled` stays false.

## 9. Security and privacy considerations

**A distribution can describe one person.** "How many sessions are usually open"
is a fact about somebody's working day. Three things bound it: the folds hold
counts only and never a per-person breakdown; nothing leaves the machine unless
the operator points `otlp_endpoint` at a collector themselves; and the whole
thing is off by default. Those are real, but they bound exposure rather than
settle scope, which is why question 3 of section 11 has to be answered before S1
merges.

**No free-form value becomes an attribute.** Section 4.5 is the mechanism, and
the five values it keeps on the machine -- operator-written agent names, member
keys, slot keys, working directories, MCP server names -- are the ones that would
otherwise identify a person, a project or a private service by name.

**A counting fold is a new reader of crew log entries.** It must read only
declared entry types: `entry_types.py` does not validate an undeclared one, so a
fold depending on an undeclared type would be reading a shape nothing holds it to.

**Cardinality is a resource question as well as a privacy one.** One unbounded
attribute value costs the recorder one cached instrument per distinct value for
the life of the process, as `metrics/schema.py` states. Closed sets are the
control; a cap on how many values are tolerated would not be.

## 10. Alternatives considered

**One export projection for everything.** Rejected in section 4.3: one
`state_version` shared across modules, and every module's step running on every
entry any of them names.

**A synchronous subscriber on the append path.** This is what a system exporting
raw events does, and section 4.2 says why it does not transfer here: our payload
is a summary, so there is a cheaper place to compute it, and the append path's
single `put_nowait` is a property worth keeping.

**Reading the crew log from the export side on a timer.** It would need its own
fold, its own resume logic and its own position tracking -- a second
implementation of the projection layer, free to disagree with the first about the
same bytes.

**A slot-keyed counting fold declared `mode = "lazy"` to avoid a cold fold on
restart.** Unnecessary: section 4.7 shows slot folds resume from disk, so lazy
would buy nothing and cost the export its publish.

**A "session tree roots" counter that counts a root once as it opens.** A
counter steps on each event, and a root's open entry comes before any child
exists, so a counter cannot know at that moment whether the root will ever get
children; counting it later, on a child's open, counts the same root once per
child unless the fold remembers which roots it already counted, which section
4.4 forbids. The roots metric is an **observable gauge** instead (section 5),
read on demand off the session tree projection rather than accumulated: the
projection already holds the tree, so the gauge asks it "how many roots have
children right now" at collect time and holds nothing itself. The same reading
gives a "tree size" gauge whenever a later round wants one, so size is left to
that round rather than forced into this one.

## 11. Questions for the OSS team

1. **Is approval given for a data category or for a named list of metrics?** A
   category -- session, crew and member activity -- lets S3 to S6 land without
   returning here. A named list means each phase comes back for review. We would
   rather have the narrower answer stated than assume the wider one.
2. **May a self-chosen name ever be an attribute value?** This document says no,
   and names the five values it keeps on the machine in section 4.5. Is that the
   right bar, or is the closed-enum-with-`other` rule itself too permissive?
3. **Are workload distributions in scope at all?** Specifically "how many sessions
   are usually open", reported as a distribution with no per-person detail. The
   alternatives are to drop it, or to report it only as an aggregate across
   installs.
4. **Does crew-shaped data need its own consent?** This document reuses
   `telemetry.enabled` and adds no switch, on the grounds that it is the same
   local sink with the same default. A maintainer may read crew activity as a
   different category from process metrics and want its own gate.
5. **Is there anything here that must not be collected even locally**, with the
   gate on and no endpoint configured?
6. **Where should S3 learn that a session died without writing
   `session/closed`?** An add-on-open, subtract-on-close counter drifts upward
   forever across a crash unless something else tells it the session is gone.
   This document does not yet name that source: a candidate is an existing
   reaper or runtime-ownership entry already written when orphaned state is
   cleaned up, if one exists and is itself a declared crew log entry type; if
   none does, S3 needs one added before it can be scoped, which is a question
   for whoever owns that cleanup path today.
7. **Should the roots gauge report 0 or unknown before the tree has seeded?**
   S2's implementation reports 0 for an unseeded or incomplete tree. A reader
   cannot then tell "no roots have children yet" from "not measured yet". The
   alternative is to report the count as unknown until the projection has
   seeded, per the rule that absent is never read as zero; it costs the gauge a
   seeded/not-seeded signal from the projection. We would rather have the choice
   stated than ship 0 by default without a decision.
8. **Should there be a `member` bucket in `agent_kind`, and where would its
   signal come from?** This round has none, because the log does not say whether
   a session belongs to a crew member and a fold may read only the log (section
   4.5). Adding one needs either an existing declared field on `session/opened`
   that already distinguishes a member session, or a new field S1 adds there as
   a second append-path exception alongside `depth`. We would rather ask than
   quietly fold member sessions into `other` forever or reach outside the log
   for the answer.
