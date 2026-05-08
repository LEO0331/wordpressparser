# WordPress Parser System Design Deep Dive

## 1) System Purpose and Scope
This system turns heterogeneous content sources into reusable author artifacts:
- Inputs: WordPress JSON, WordPress/Pixnet URLs, WordPress WXR XML export.
- Core outputs: `skill.md`, `knowledge.md`, `persona.md`, `wiki.md`, metadata.
- Optional sidecar: MCP server to list/read/create/update/publish WordPress posts.

Primary goals:
- Fast local-first operation (Node + Express, no required external DB).
- Backward-compatible artifact generation path.
- Safe ingestion defaults (URL safety checks, controlled error messages, admin-gated mutations).
- Deployable on Vercel with optional Blob persistence.

Non-goals (current design):
- Real-time streaming processing.
- Multi-tenant RBAC model.
- Full-text database/search engine.
- Distributed queue/event bus.

---

## 2) High-Level Architecture

### 2.1 Runtime topology
- **Main App (Express monolith)**
  - HTTP API + static frontend (`public/`) in one process.
  - Module boundaries in `src/` for ingestion, normalization, analysis, generation, storage.
- **Optional MCP Sidecar (`mcp/`)**
  - Separate stdio process, independent of main HTTP app.
  - Wraps WordPress REST API with safe tool contracts.

### 2.2 Core request pipeline
1. Ingest source (`/api/normalize`, `/api/extract-url`, `/api/convert-xml`).
2. Normalize to common item shape:
   - `{ title, content, date, url, categories, tags }` (+ XML extras where needed).
3. Analyze corpus (`analyzeCorpus`):
   - knowledge track + persona track.
4. Generate artifacts (`/api/generate` or `/api/build`/`/api/profiles/save`).
5. Persist profile to filesystem or Vercel Blob.

### 2.3 Why monolith + modular files
Chosen:
- One deployable unit simplifies ops, local dev, and CI.
- Internal module boundaries preserve maintainability without distributed-system overhead.

Alternative:
- Split into microservices (`ingestion`, `analysis`, `storage`, `api-gateway`).
- Tradeoff: stronger isolation/scaling at cost of latency, operational complexity, retries, tracing, and auth propagation.

---

## 3) Key Components and Tradeoffs

## 3.1 API Layer (`server.js`)
Design:
- Thin route handlers.
- Shared safe error wrapper (`sendSafeError`).
- Admin-only mutation middleware for update/correct/rollback.

Tradeoff:
- Simple and readable route code, but business logic still imported synchronously in-process.
- Alternative: command-handler/DI framework for richer policy injection; current app keeps complexity lower.

## 3.2 Normalization (`src/parser.js`)
Design:
- Multiple schema candidates (`posts`, `items`, `channel.item`, etc.).
- HTML stripping + entity decoding to plain text.
- Unified normalization before analysis/generation.

Tradeoff:
- Robust to noisy upstream shapes, but plain-text normalization loses rich markup semantics.
- Alternative: keep rich AST/DOM model and defer simplification later; higher fidelity but more complexity and memory.

## 3.3 URL Extraction (`src/url_extract.js`)
Design:
- Platform detection (`auto|wordpress|pixnet`).
- SSRF guardrails: protocol validation, blocked local hosts, DNS resolution, private-IP rejection.
- Pagination loops with capped bounds (`MAX_PAGES`, `PAGE_SIZE`).

Tradeoff:
- Good safety baseline and deterministic upper bounds, but more DNS/IO checks per request.
- Alternative: allowlist-only domains for stricter policy; safer but less flexible for arbitrary WordPress hosts.

## 3.4 XML Bridge (`src/xml_bridge.js`, `src/zip_writer.js`)
Design:
- Parse WXR XML, sanitize/normalize, convert HTML to markdown.
- Build one markdown file per post/page with frontmatter.
- Return ZIP binary from memory.

Tradeoff:
- In-memory ZIP keeps implementation simple and fast for moderate exports.
- Alternative: stream ZIP generation to reduce peak memory for very large exports.

## 3.5 Analysis + Generation (`src/generator.js`, `src/skill_template.js`)
Design:
- Deterministic parser mode + optional AI mode.
- Locale-aware templates (`en`, `zh-TW`).
- Knowledge/persona split yields stable, explainable outputs.

Tradeoff:
- Template-driven outputs are predictable; less expressive than full model-driven generation.
- Alternative: fully generative pipeline with stronger creativity but lower determinism and harder regression testing.

## 3.6 Storage (`src/profile_store.js`)
Design:
- Dual backend abstraction: local filesystem or Vercel Blob.
- Same profile contract across both backends.
- Version snapshots for rollback.

Tradeoff:
- Very low infrastructure overhead; snapshot-per-save can grow storage footprint over time.
- Alternative: database with deltas/version graph (Postgres + JSONB); better queryability, heavier ops/migration cost.

## 3.7 MCP Sidecar (`mcp/`)
Design:
- Separate process + protocol framing (`Content-Length` JSON-RPC over stdio).
- Version fallback strategy (`v3` -> `v2`) for WP API compatibility.

Tradeoff:
- Sidecar isolation prevents coupling with main deployment.
- Alternative: embed MCP endpoints into main Express service; simpler deployment, weaker isolation/failure boundaries.

---

## 4) Canonical Data Shapes

### 4.1 Normalized corpus item
```ts
{
  title: string;
  content: string;
  date: string | null;
  url: string | null;
  categories: string[];
  tags: string[];
}
```

### 4.2 Profile artifact bundle
```ts
{
  meta: object;
  knowledgeMarkdown: string;
  personaMarkdown: string;
  skillMarkdown: string;
  wikiMarkdown: string;
  knowledgeAnalysis: object;
  personaAnalysis: object;
  normalizedItems: NormalizedItem[];
}
```

### 4.3 XML conversion result
```ts
{
  zipBuffer: Buffer;
  metadata: {
    totalItems: number;
    convertedItems: number;
    skippedItems: number;
    warningCount: number;
    warnings: string[];
  }
}
```

---

## 5) Data Structure Choices: Why This vs Alternatives

| Area | Chosen structure | Why chosen here | Alternatives | Tradeoff summary |
|---|---|---|---|---|
| Stopword membership | `Set<string>` | O(1) average lookup for high-frequency filtering | Array + `includes`, Trie | `Set` is simplest + fast; trie helps prefix use-cases not needed now |
| HTML entity map | `Map<string,string>` | Clear key-value semantics; iteration over pairs | Plain object | `Map` preserves insertion order and avoids prototype pitfalls |
| Keyword frequency | `Map<string, number>` | Frequent increment/update operations | Plain object, Counter lib | `Map` cleaner for non-fixed keys and avoids `hasOwnProperty` edge cases |
| Corpus records | `Array<Item>` | Natural ordering, easy sort by date and pagination-like slicing | Linked list, balanced tree | Arrays are cache-friendly and simplest for bounded in-memory datasets |
| URL/API query building | `URLSearchParams` | Correct encoding, avoids manual string concat bugs | Manual query string | Safer and less error-prone for query construction |
| Binary ZIP output | `Buffer` + chunk arrays | Efficient byte operations, native Node compatibility | Base64 strings, streaming lib | In-memory buffer is simple; streaming would scale better for huge files |
| CRC lookup table | `Uint32Array(256)` | Compact fixed-size numeric table with fast indexed access | JS array<number> | Typed array improves predictable binary math performance |
| Private-IP policy | `Set` for blocked hosts + helper funcs | Fast host checks + explicit IP classifiers | Regex-only checks | Structured checks are clearer and safer than single regex |
| Error typing | `Error` + `code` string | Lightweight classification without heavy custom hierarchy | Custom error classes | Code strings are simple; classes improve typing but add boilerplate |
| Version listing | `Array<string>` sorted reverse | Direct output for UI/API consumption | Priority queue / tree | Array sort is fine at current scale and simpler |
| Blob/profile index | `Map<slug, meta>` during aggregation | Deduplicates slugs while scanning blob entries | Object dictionary | `Map` clearer for dynamic key iteration + ordering |
| Route dispatch (MCP tools) | `switch` on tool name | Small finite command set, explicit control flow | Object command map | `switch` is verbose but explicit; map can reduce boilerplate |

---

## 6) Architecture Tradeoffs (Design Decisions)

### Decision A: Normalize early to common shape
- Chosen: source-specific parsing first, then converge to one internal shape.
- Why: minimizes downstream branching in analysis/generation/storage.
- Alternative: preserve source-specific models end-to-end.
- Tradeoff: easier maintenance now vs potential loss of source-specific richness.

### Decision B: Dual storage backend via environment switch
- Chosen: filesystem by default, Vercel Blob when token exists.
- Why: local dev convenience + cloud persistence without DB dependency.
- Alternative: always use managed DB/object store.
- Tradeoff: simpler onboarding vs fewer query/reporting capabilities.

### Decision C: Explicit admin-key guard on mutating profile endpoints
- Chosen: static key from env, checked by middleware.
- Why: minimal overhead protection suitable for internal tooling.
- Alternative: OAuth/JWT/session auth with role model.
- Tradeoff: lightweight and easy, but coarse-grained and rotation-sensitive.

### Decision D: Sidecar MCP process
- Chosen: independent process and transport from main app.
- Why: isolates WordPress publish/read capabilities and protocol concerns.
- Alternative: merge into main API.
- Tradeoff: better fault isolation vs extra runtime component to manage.

### Decision E: Deterministic parser mode fallback
- Chosen: AI mode optional; parser mode always available.
- Why: operational reliability and predictable tests.
- Alternative: AI-only generation path.
- Tradeoff: stable baseline output quality vs potentially less nuanced content.

---

## 7) Scalability and Reliability Notes

Current strengths:
- Bounded paginated fetch loops (`MAX_PAGES`, `PAGE_SIZE`).
- Clear separation of read vs admin mutation endpoints.
- Regression-heavy test suite across parser, routes, MCP, storage.

Known scale limits:
- In-memory processing for corpus + ZIP may hit memory ceilings for very large imports.
- No queue/backpressure model for long-running ingestion/generation.
- Blob listing for profile discovery can become expensive at large object counts.

Pragmatic evolution path:
1. Add request-level size/time budgets and async job mode for heavy tasks.
2. Stream ZIP and large artifact writes.
3. Add index metadata store (SQLite/Postgres) while keeping blob/files for artifacts.

---

## 8) Deep-Dive Q&A Prep

## 8.1 System design questions
1. **Why monolith first?**
   - Single deployment artifact, low ops burden, faster iteration. Module boundaries preserve internal structure until scale demands service split.

2. **How do you avoid coupling across ingestion types?**
   - Normalize all sources to the same item schema before analysis/generation.

3. **How do you handle backward compatibility?**
   - Keep existing endpoints/contracts stable; add new capability as isolated routes (`/api/convert-xml`) and preserve legacy fallback (`rag.json` -> `wiki.md`).

4. **What is the biggest operational risk today?**
   - Memory spikes on very large XML/corpus workloads due to in-memory processing.

## 8.2 Data structure questions
1. **Why Set/Map over object/array?**
   - Membership and aggregation are primary operations (O(1) average), with cleaner semantics and fewer prototype-key pitfalls.

2. **Why Buffer and typed arrays for ZIP?**
   - Binary format generation requires deterministic byte control and good performance.

3. **Why arrays for core items?**
   - Need stable order + sort + sequential scan; dataset sizes are moderate, making arrays optimal and simple.

## 8.3 Security questions
1. **How is SSRF mitigated?**
   - URL protocol validation, localhost blocking, DNS resolution checks, private IP rejection.

2. **How are mutating endpoints protected?**
   - Admin key middleware on update/correct/rollback endpoints.

3. **How is output safety handled for markdown conversion?**
   - HTML sanitization and markdown URL scheme filtering (`javascript:`, `data:`, etc. dropped).

## 8.4 Tradeoff challenge questions
1. **Why not relational DB now?**
   - Current workload is artifact-centric and append/snapshot heavy; filesystem/blob is enough with lower complexity.

2. **Why not event-driven architecture?**
   - Current synchronous request-response model is simpler and acceptable for present workload profile.

3. **When would you split services?**
   - If p95 latency and memory pressure rise significantly, or if independent scaling of ingestion/generation is needed.

---

## 9) Recommended Next Improvements (if asked in interview)
1. Add asynchronous job queue for heavy XML conversion/generation.
2. Introduce streaming ZIP pipeline to cap memory footprint.
3. Add profile metadata index for faster listing/search at scale.
4. Add structured observability (trace IDs, latency histograms, error cardinality).
5. Replace static admin key with scoped auth (JWT/OAuth) for production multi-user use.

