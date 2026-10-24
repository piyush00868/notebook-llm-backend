# Mindora — Backend

The Express API for **Mindora**, an AI knowledge workspace. It ingests documents (PDF, web pages, YouTube transcripts, pasted text), chunks and embeds them into a vector store, and answers questions against a notebook's own sources with inline, numbered citations.

The client lives in [`../frontend`](../frontend) and talks to this API over HTTP.

---

## Stack

| | |
|---|---|
| Runtime | Node.js, TypeScript 6 (run directly via `tsx`, no build step) |
| Framework | Express 5 |
| Database | PostgreSQL (Neon) via **Prisma 8 data-contract mode** (`@prisma/orm-postgres`) |
| Auth | Clerk (`@clerk/express`) |
| Vector store | Pinecone |
| Embeddings | Mistral (`mistral-embed`) |
| LLM | Groq (`openai/gpt-oss-20b` by default) |
| Extraction | `pdf-parse`, `jsdom` + `@mozilla/readability`, Supadata API (YouTube transcripts) |
| Validation | Zod 4 |

---

## Quick start

### Prerequisites

- Node.js 20+
- A Clerk application
- A Neon (or any PostgreSQL) database
- Pinecone, Mistral and Groq API keys

### 1. Install

```bash
npm install
```

`postinstall` runs `prisma skills sync` and ignores failures, so it will not block install.

### 2. Configure the environment

```bash
cp .env.example .env
```

Every variable the server reads is listed in `.env.example`. The two easiest to miss are `PINECONE_INDEX_NAME` — an empty value means there is no index to write to — and `GROQ_MODEL`, which is optional and falls back to a default.

### 3. Sync the database schema

The schema lives in `src/prisma/contract.prisma`. Migrations are already committed under `migrations/`. Apply them with:

```bash
npx prisma db execute   # or apply migrations/app/* through your Prisma workflow
```

After editing the contract, regenerate the client artefacts:

```bash
npm run contract:emit
```

This rewrites `src/prisma/contract.json` and `src/prisma/contract.d.ts`. **The server will not reflect schema edits until this runs** — the client is generated from the contract, not from a live database.

### 4. Run

```bash
npm run dev      # tsx watch — restarts on change
npm start        # single run
```

Serves on **http://localhost:4000** unless `PORT` says otherwise. There is no `/health` route.

---

## Scripts

| Script | Command | Purpose |
|---|---|---|
| `npm run dev` | `tsx watch src/server.ts` | Development, auto-restart |
| `npm start` | `tsx src/server.ts` | Run once |
| `npm run contract:emit` | `prisma contract emit` | Regenerate Prisma contract artefacts |
| `npm run test` | — | **Not implemented** — exits 1 |
| `postinstall` | `prisma skills sync \|\| exit 0` | Best-effort Prisma setup |

There is **no build script** (TypeScript runs directly) and **no lint script**.

---

## Environment variables

| Variable | Required | Default | Used by |
|---|---|---|---|
| `PORT` | No | `4000` | `server.ts` |
| `DATABASE_URL` | **Yes** | none | Prisma client and CLI |
| `CLERK_SECRET_KEY` | **Yes** | none | `clerkMiddleware()` reads it internally — not referenced in `src/` |
| `CLERK_PUBLISHABLE_KEY` | Frontend only | none | Needed by the client, not the server |
| `MISTRAL_API_KEY` | **Yes** | none | `services/embedding/embedding.service.ts` |
| `PINECONE_API_KEY` | **Yes** | none | `services/vector/vector.service.ts` |
| `PINECONE_INDEX_NAME` | **Yes** | none | `services/vector/vector.service.ts` |
| `GROQ_API_KEY` | **Yes** | none | `services/LLM/llm.service.ts` |
| `GROQ_MODEL` | No | `openai/gpt-oss-20b` | `services/LLM/llm.service.ts` |
| `SUPADATA_API_KEY` | **Yes** | none | `services/ingestion/youtube.service.ts` — YouTube transcript fetch via Supadata API |

---

## API

Routers are mounted in `src/server.ts` under `/users`, `/workspaces`, `/notebooks`, `/documents`. **Every router applies `requireAuth` as its first line** — there are no public endpoints.

### `/users`

| Method | Path | Notes |
|---|---|---|
| GET | `/users/me` | Resolves or provisions the Clerk-linked `User` |

### `/workspaces`

| Method | Path | Notes |
|---|---|---|
| POST | `/workspaces/` | Create; 201 |
| GET | `/workspaces/` | List **all** workspaces for the caller |
| GET | `/workspaces/:id` | Ownership-checked |
| DELETE | `/workspaces/:id` | Returns `200 { message, workspace }` |

### `/notebooks`

| Method | Path | Notes |
|---|---|---|
| POST | `/notebooks/` | Create; 201 |
| GET | `/notebooks/:id` | Includes documents |
| DELETE | `/notebooks/:id` | Returns `200 { message, notebook }` |
| POST | `/notebooks/:id/ask` | Stateless RAG, `topK 5` — **persists nothing** |
| POST | `/notebooks/:id/chats` | Create a conversation |
| GET | `/notebooks/:id/chats` | List, newest first |
| GET | `/notebooks/chats/:chatId/messages` | **No pagination — returns every message** |
| DELETE | `/notebooks/chats/:chatId` | Messages cascade in the DB |
| POST | `/notebooks/chats/:chatId/ask` | Persists both the question and the answer |

> Two `ask` routes exist on purpose. `/notebooks/:id/ask` runs retrieval but writes no `Chat`/`ChatMessage` rows, so answers vanish on reload. The client uses the **chat-scoped** route. Only `/notebooks/:id/ask` and `/notebooks/chats/:chatId/ask` filter retrieval by notebook correctly.

### `/documents`

| Method | Path | Notes |
|---|---|---|
| POST | `/documents/` | Create a document row directly (no embedding) |
| GET | `/documents/:id` | Includes chunks — this is how the client resolves citations |
| DELETE | `/documents/:id` | Returns `204` |
| POST | `/documents/upload` | Multipart PDF, 20 MB cap, `application/pdf` only |
| POST | `/documents/url` | Web page via Readability |
| POST | `/documents/youtube` | Transcript via Supadata API |
| POST | `/documents/text` | Pasted text |

---

## Data model

Prisma 8 contract mode. The client in `src/prisma/db.ts` is `postgres<Contract>({ contractJson, url })`, queried as `db.orm.public.<Model>`.

```
User        clerkUserId (unique), email (unique), username, name
  └─ Workspace   name
       └─ Notebook   name
            ├─ Document   title, content, sourceType, sourceUrl, status
            │    └─ Chunk   content, chunkIndex          [cascade]
            └─ Chat
                 └─ ChatMessage  role, content, sources (JSON)  [cascade]
```

Cascade chain: `Workspace → Notebook → {Document → Chunk, Chat → ChatMessage}`.

Two columns are declared but **never written or read by any code**: `Document.storageKey` and `Chunk.pineconeId`. Embeddings live only in Pinecone, not in Postgres.

---

## How it works

### Document ingestion

All four source types follow the same shape:

1. Authenticate, then `assertOwner` on the target notebook.
2. Extract text — PDF buffer, Readability, YouTube transcript, or the request body.
3. `normalizeText()` — CRLF→LF, collapse whitespace, strip `Page N of M` footers.
4. Create the document with status `PENDING` (PDF) or `PROCESSING` (the rest).
5. `createDocumentChunks()` — `chunkText(content, 1000, 200)`, preferring paragraph → sentence → word boundaries. Skips if chunks already exist.
6. `indexDocumentChunks()` — Mistral embeddings for every chunk, then one Pinecone upsert keyed `chunk-<id>` with metadata `{documentId, notebookId, chunkIndex, chunkId}`.
7. Mark `COMPLETED`, or `FAILED` if steps 5–6 throw.

Step 6 is what makes a source retrievable. A document with chunks but no Pinecone vectors exists in the UI and can never be cited.

### YouTube ingestion (Supadata)

YouTube transcripts are fetched through the Supadata API rather than direct scraping. YouTube blocks datacenter IP ranges (Render, Vercel) with `429` / bot-check pages before it will release captions; Supadata proxies the request through its own infrastructure so it works from any server. Only the bearer API key travels with the request — no OAuth consent flow, no Google credentials.

Configure `SUPADATA_API_KEY` in the backend environment. The mode defaults to `native` (existing captions only, no AI transcription credits spent); set `SUPADATA_MODE=auto` or `SUPADATA_MODE=generate` to allow AI-generated transcripts for videos without existing captions.

### RAG answering

1. Embed the question with Mistral.
2. Pinecone `query`, filtered to the notebook: `{ notebookId: { $eq } }`.
3. Map matches back to `Chunk` rows, preserving score and order.
4. Build a `[1]…[n]`-numbered context block and a parallel `sources[]` array.
5. Call Groq with a `json_schema` response format whose citation enum is constrained to the retrieved indexes, validate with Zod, then re-render server-side to append `[n]` markers. Anything unanswerable or unparseable collapses to a fixed fallback string.
6. Return `{ answer, sources }`.

---

## Authentication and authorization

`clerkMiddleware()` runs globally; `requireAuth` per router rejects anything without a Clerk `userId`.

`assertOwner(ownerClerkUserId, currentClerkUserId)` is the only authorization primitive — ownership is all-or-nothing, with no roles. Every guarded controller resolves `chat/document → notebook → workspace → owner` and wraps the call in `try/catch` to emit a 403.

`auth.service.ts` provisions users lazily: look up by `clerkUserId`, else match on primary email and backfill the link, else create the row.

---

## Project structure

```
src/
├── server.ts                 Express app, middleware, router mounting
├── prisma/                   db client + contract.prisma / .json / .d.ts
├── routes/                   thin route tables, each starting with requireAuth
├── controllers/              validation, ownership, HTTP semantics
├── services/
│   ├── auth.service.ts       Clerk ↔ DB user linking
│   ├── authorization.service.ts
│   ├── workspace|notebook|document|chat.service.ts
│   ├── ingestion/            pdf, url, youtube (Supadata), text, chunk
│   ├── embedding/            Mistral
│   ├── vector/               Pinecone
│   ├── LLM/                  Groq + structured answer rendering
│   └── RAG/                  retrieve → answer
└── middleware/               auth, multer upload
```

---

## Gotchas

Verified against the current source.

**Deleting a document orphans its Pinecone vectors.** `deleteDocument` removes `Chunk` and `Document` rows but never calls a Pinecone `deleteMany`. Deleting a workspace or notebook cascades in Postgres and does nothing in Pinecone.

**`sourceType` is inconsistent.** The Zod enum accepts `WEB`, but `uploadUrlController` writes the literal `URL`. Nothing rejects it because the column is a free `String`, not an enum. `status` is likewise unconstrained.

**The PDF upload response reports a stale status.** It returns the document object captured *before* the status transitions, so it says `PENDING` while the row is already `COMPLETED`.

**`assertOwner` throws the bare string `"FORBIDDEN"`** and relies entirely on every call site wrapping it in `try/catch`. An unwrapped call would surface as a 500, not a 403.

**`getChatMessages` has no pagination.** A long conversation returns every message in one payload.

**Hardening absent.** No rate limiting, no error-handling middleware, no 404 handler, no structured logging (raw `console.error`), no OpenAPI spec. `express.json()` keeps its 100 kB default; only multer raises a limit, to 20 MB.

**Scratch files in `src/`.** Eight `test-*.ts` / `test.*.ts` files sit at the `src` root with top-level `await`, not referenced by any script but compiled by `tsconfig`. `src/services/user.service.ts` is literally `export {};`. `embedding.service.ts` exports a `testEmbedding()` debug helper.

**Opaque root artefacts.** `db-schema.json` and `contract-full.txt` are not readable as text and appear unused by any code.

**Generated docs drift.** `prisma-8.md` references commands (`npx prisma db init`) that have no npm script.

---

## Production notes

- Set `CLERK_SECRET_KEY` to a production instance. Development keys are origin-restricted.
- CORS is currently `cors()` with no allowlist. Restrict it to your deployed frontend origin.
- Text ingestion is **synchronous** — a very large paste blocks the request while embedding finishes. PDFs use the same pattern. If ingestion volume grows, move it to a background job and drive status from `PENDING`/`PROCESSING`.
- Schema changes require editing `src/prisma/contract.prisma`, adding a migration under `migrations/`, then running `npm run contract:emit`.
