# Persisted graph execution: pure kernel contract

Status: the pure compiler and node kernel are implemented in `graph-plan.js`
and `graph-step.js`. They are not connected to production ingress. Full executor
acceptance, persistence, migrations, closure/join resolution, revocation and SQL
atomicity are separate work. Passing these pure tests does not satisfy that gate.

## Compilation

`compileWorkflow(workflow)` copies bounded plain input data and calls the existing
`assertWorkflow`. It returns all definition fields (including layout) plus:

- `nodes`, `edges`: complete copied arrays, in definition order.
- `byId`: `Map<nodeId, node>` referencing the copied nodes.
- `incoming`, `outgoing`: `Map<nodeId, Edge[]>`, retaining every edge and port.
- `ranks`: maximum predecessor depth, with start rank zero.
- `topologicalOrder`: deterministic node IDs in topological order.
- `startId`: the sole start node ID.

No paths are expanded, nodes reordered in the definition, aggregates collapsed,
limits hoisted, or schema-valid graph shapes forbidden. The old pure evaluator's
path/output execution caps are not applied by this compiler. Returned maps are
runtime indexes, not a JSON persistence representation. Mutating a returned plan
cannot mutate the supplied workflow.

## Unit and step inputs

```js
{
  id: 'input-unit-id',
  kind: 'event' | 'batch' | 'fragment',
  members: [{
    id: 'member-occurrence-id',
    runId: 'original-delivery-run-id',
    event: { /* observed schema metadata */ },
    display: { /* current display configuration */ },
    schedules: [ /* schema schedule configs */ ],
    dueAtMs: 0,
    deadlineMs: null,              // absolute workflow deadline, never rewritten
    defaultPriceText: null,
    baseTimeMs: 0,                 // optional; frozen observed-time fallback
    scheduleDeadlineMs: null,     // optional; absolute schedule wait horizon
    context: {},                  // optional opaque provenance
    targetKind: 'auto',            // optional, retained along with other metadata
  }],
  ancestry: [ /* opaque bounded plain-data stage references */ ],
}
```

Member IDs are unique within a unit; different IDs can reference the same run.
Only the durable explicit merge may deduplicate that lineage. Event units contain
at most one member; empty units are permitted and complete without emissions.
Ancestry is copied intact, including nested stage references. The kernel neither
appends stages nor interprets membership as a latest-selection instruction.

`stepNode(node, unit, {now, dictionaries})` processes exactly one node. `now` is a
required safe integer timestamp in the JavaScript Date range. The durable caller
supplies/fixes execution time and persists accepted decisions. The kernel never
reads the wall clock, traverses edges, acquires leases, consumes counters, accesses
the DB, renders output, sends messages, or calls providers.

Inputs are not mutated, and returned units/member payloads/ancestry do not share
mutable references with inputs or sibling emissions. Additional plain-data
member/unit provenance is retained. Accessors, reserved prototype properties,
cycles, symbols, functions and non-plain objects are rejected. Optional undefined
values are permitted in memory; omitting them in JSON has the same missing-value
meaning. Persisting input Maps or matcher instances inside a unit is unsupported.

`KERNEL_LIMITS` bounds a materialization to 10,000 members, 512 ancestry entries,
128 schedules per member and 128 distinct schedules per unit, depth 32, 200,000 values,
and an 8 MiB conservative data-byte budget. Oversize input throws
`GRAPH_INPUT_LIMIT`; it is never silently truncated to fit a unit. The persistence
owner must surface/backpressure that condition, not silently split quota units.
Existing event normalization still bounds known metadata as `normalizeEvent`
does; absent, null or wrongly typed known fields stay missing in evaluation.

## Results and identity ownership

```js
{
  state: 'complete' | 'wait' | 'limit' | 'aggregate' | 'send' | 'merge',
  emissions: [{port: 'out' | 'yes' | 'no' | 'unknown', unit}],
  trace: [{nodeId, memberId, runId, outcome, /* reason/detail as appropriate */}],
  continuation: unit,             // only wait, send and merge
  wakeAtMs: 0,                    // only wait
  groups: [{key, keyId, unit}],    // only limit and aggregate
  destination: 'default',         // only send; unresolved alias
  intent: {nodeId, type, config},  // only limit, aggregate, send and merge
}
```

Optional fields above are omitted when inapplicable. `complete` alone may emit
outgoing units; it can also mean every member was excluded. An intent or wait has
no outgoing emissions. The caller must not treat `continuation` or `groups` as
permission to advance before fulfilling the corresponding operation.

All returned views retain the input `id`; this is not a new durable identity.
The persistence layer allocates output identities using its activation plus
port/group/ordinal identity, and handles edge fanout idempotently. `member.id`
and `runId` are preserved. A strict subset of a batch/fragment is `fragment`;
an unchanged batch remains `batch`, and a single event remains `event`. Member
order is stable. Branch emissions use `yes`, `no`, `unknown` order; field groups
use first encountered key order.

For `wait`, persist the returned continuation and re-run the same node with it
at/after `wakeAtMs`. Do not reconstruct the original pre-wait input: it lacks the
frozen temporal state. Persisted trace/outcome deduplication belongs to the caller.
For an intent, `intent.config` is the copied schema node config, not inferred
execution policy or an automatic successful outcome.

### Boundary to the parent flow store

The kernel also preserves the store's extra metadata, including member
`lineageId` and unit `batchInputs: [{unitId, ordinal}]` / `receivedCount`, without
interpreting or recalculating it. A fragment's `receivedCount` therefore remains
historical batch metadata; use `members.length` for its current membership count.

- `complete`: resolve each emission's port against the compiled outgoing edges,
  allocate output unit IDs and pass the outputs to `settle`. A kernel emission
  without an attached edge has no outgoing work. Edge closure is never inferred
  solely from the absence of an emission in this single activation.
- `wait`: atomically persist **both** `continuation` and `wakeAtMs` before releasing
  the step. A store API saving only the wake time and reloading the original unit
  cannot preserve frozen horizons/fallback anchors or pruned membership. It needs
  a saved resume-unit/snapshot facility; the kernel cannot supply that guarantee.
- `limit`: resolve each `groups[i]` with a separate typed-key admission/receipt;
  the single-gate `settle` operation must not charge a heterogeneous unit under
  one arbitrarily selected key. Share successful predecessor receipts across
  downstream fanout, rather than reevaluating quota during delivery.
- `aggregate`: pass `intent.config` and `groups.map(({key, unit}) => ({key, unit}))`
  to `admitBatch`, assigning partition unit IDs where required by the store.
- `merge`: persist the arrival for the closure-aware coordinator; do not settle
  it as a successful outgoing branch merely because there is an arrival.
- `send`: project an authorized, versioned delivery plan; no graph emission is
  produced by this kernel.

Claim's `evaluation_at_ms` can fix predicate decisions. Temporal waits must be
checked against the current supplied clock and persisted continuation, rather
than repeatedly checking whether the original pre-wait clock was ready.

## Node semantics

### Conditions and dictionaries

The entire predicate is evaluated independently for each member, including
nested `all`, `any` and `not`. Results partition the unit into nonempty
`yes`/`no`/`unknown` emissions. Group operators never combine different members'
fields. Unknown metadata follows existing three-valued behavior; `exists` on a
missing field is false, and a known numeric zero remains known. Unknown predicate
field names are schema errors, not newly supported attributes.

Evaluation uses a normalized view of the original event. When published time is
known, `ageMinutes = max(0, (now - publishedAtMs) / 60000)` at condition/dictionary
execution. Otherwise an already supplied valid age remains usable. The original
`member.event` is not overwritten with derived age or stripped metadata. A
persisted earlier decision is not retroactively evaluated at delivery time.

`dictionaries[alias]` must expose synchronous `match(text, 8)`, returning at most
eight `{term, start, end, category?}` match records. Array fields are joined with
newlines. Matches in any observed requested field give `yes`; no matches and
any missing requested field give `unknown`; fully observed negative fields give
`no`. A missing matcher or entirely missing input gives `unknown`. Async or
malformed match results throw `GRAPH_MATCHER_INVALID`. Callback exceptions remain
execution errors, not a negative dictionary result. No cache or dictionary loads
are owned by this kernel.

### Transforms, start, stop and send

Transform replaces every retained member's entire display config and clears
`defaultPriceText` to null. It does not rewrite event metadata or render text.
Thus a transform after an aggregate applies to each retained item; another
transform replaces its predecessor rather than accumulating display mutations.

Start applies optional provider/kind filters per member, recording excluded
members. Stop records the configured exclusion reason and emits nothing. Send
returns an unresolved destination alias and eligible member continuation as an
intent. Permission checks, final temporal checks, rendering and submission stay
with the executor/transport.

### Delay, schedule, and expiry

Every node first excludes members whose effective deadline is strictly less than
`now`. Deadlines are inclusive. The effective deadline is the minimum of the
unchanged workflow `deadlineMs` and optional `scheduleDeadlineMs`.

On a member's first kernel visit, missing `baseTimeMs` is fixed to its normalized
observed timestamp, otherwise the supplied `now`. The caller should persist that
at start. Observed delay uses observed time or this fallback; published delay
with missing publication time excludes that member's path with an unknown trace.
Delays are absolute: `dueAtMs = max(dueAtMs, anchor + minutes * 60000)`. They do
not accumulate on retries or redefine the anchor to the preceding node's finish.
An individual delay beyond its effective deadline excludes that member.

A schedule visit retains the config without duplicates and sets
`scheduleDeadlineMs = min(existing scheduleDeadlineMs, now + maxWaitDays * DAY)`.
It never rewrites `deadlineMs`. On resume the persisted minimum prevents a rolling
horizon; later schedule nodes may tighten it, never extend it.
Fresh inputs already carrying schedules without `scheduleDeadlineMs` acquire a
fixed horizon on their first kernel visit using the strictest carried maximum
wait. This is initialization, not reconstruction of historical schedule entry
time: resumed persisted inputs must retain the returned absolute value.

For either temporal node, all retained members must be ready simultaneously:
intersect their carried schedules using the existing `scheduleDelivery`, starting
at `max(now, all dueAtMs)`, bounded by the earliest effective deadline. There is
no early emission of ready members. If not currently ready, return a continuation
and wake at the earlier of the common ready time or earliest deadline plus 1 ms.
After expiry, remove the affected members and reconsider healthy survivors. A
schedule conflict does not immediately expire every other member. No wait may
have an infinite/unrepresentable wake time; malformed temporal input throws.

### Limit and aggregate

These nodes partition normalized field values and return intent groups only.
Valid grouping fields remain `all`, `sourceKey`, `providerId`, `author`, `currency`.

```js
{field: 'all', type: 'all'}
{field: 'author', type: 'missing'}
{field: 'author', type: 'string', value: 'unknown'}
```

`keyId` is the deterministic JSON encoding of that key. Missing values cannot
collide with literal `unknown` or `all`. Keys are literal normalized event values,
not guessed identity mappings. Namespace/owner/workflow/node/window must be added
by the persistence layer; keyId alone is not a global SQL grouping key.

The kernel does not charge/drop/defer a limit or pick an aggregate window, close
a batch, enforce maxItems by trimming, or select the latest event. For both
aggregate modes all supplied members survive grouping. In particular, the caller
must resolve a `latest` aggregate and feed only its sealed membership to a later
condition; the condition must never resurrect an older matching event.

### Merge

Merge always returns `state: 'merge'`, its copied mode/conflict config and a
continuation, without an `out` emission. The durable owner must collect arrivals,
distinguish open from closed-empty edges, apply any/all lineage semantics, resolve
display conflicts and create output fragments. A single arrival cannot satisfy
closure, and this pure module never implements merge as pass-through.

## Pure verification boundary

`node --test scripts/test/automation-graph-step.test.js` covers the kernel only:
full DAG preservation, nested/member predicates, missing metadata, dictionary
contracts, immutable input/output isolation, absolute temporal resumes, member
expiry, typed groups and explicit stateful intents. Full SQL acceptance remains
required before connecting the new executor to production ingress.
