# ResearchMind AI — V4 (React + FastAPI + PostgreSQL)

Production-track rebuild of the Streamlit V3 app. Dark glassmorphism UI,
teal/coral identity, multi-agent research assistant, all free except
GPT-4o-mini (the only paid API call in the whole stack).

## What's real vs. what needs your machine

Everything in this repo was written, run, and tested — except three things
a sandbox environment genuinely cannot reach (but a normal machine can):

1. **GPT-4o-mini calls** (needs `OPENAI_API_KEY`)
2. **Semantic Scholar / arXiv / OpenAlex search** (needs open internet)
3. **The free local embedding model download** (~90MB, one-time, from
   HuggingFace)

Everything else — auth, brute-force lockout, JWT refresh, document upload +
background text extraction (real PDF/DOCX/PPTX/XLSX/TXT files), per-user
data isolation (verified even under a colliding doc_id), RAG chat routing,
all 6 agents' step pipelines, all AI feature endpoints, rate limiting,
cascading delete/reset-workspace, and the entire frontend build — has
automated test coverage (17/17 pass; see `backend/tests/test_full_flow.py`),
verified on a fresh install in a clean virtual environment.

## Quick start

### 1. Backend

```bash
cd backend
python3 -m venv venv
source venv/bin/activate      # Windows: venv\Scripts\activate
pip install -r requirements.txt

cp .env.example .env
# Edit .env and fill in:
#   OPENAI_API_KEY=sk-...
#   SEMANTIC_SCHOLAR_API_KEY=...   (get a free key: semanticscholar.org/product/api)
#   JWT_SECRET=<any long random string>
#   ADMIN_USERNAMES=<your-username>   (auto-promotes you to admin on next login)
#   SMTP_* (optional — leave blank to just log emails to the console locally)
#   STRIPE_* (optional — leave blank to disable billing; test mode is free)

uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

First real chat/upload call will download the embedding model (~90MB,
one-time) — this needs a normal internet connection, then works offline.
The Citation Agent's re-ranker downloads a second small model
(`cross-encoder/ms-marco-MiniLM-L-6-v2`, ~90MB) the first time it runs.

Open the API docs at **http://localhost:8000/docs** (not `0.0.0.0:8000` —
that address is only meaningful to the server, not a browser).

Run the test suite (mocks the 3 external calls listed above, tests
everything else for real):
```bash
pip install pytest httpx
pytest tests/ -v
```

### 2. Frontend

```bash
cd frontend
npm install
cp .env.example .env    # VITE_API_URL=http://localhost:8000
npm run dev
```

Open http://localhost:5173

### 3. Production

- **UAT server (systemd service name, log path, deploy commands): see [`SERVER.md`](./SERVER.md).**

- Swap `DATABASE_URL` in `backend/.env` to Postgres — no code changes needed.
- `uvicorn app.main:app --workers 4` for multiple workers.
- `npm run build` in `frontend/` → deploy the `dist/` folder to any static host.
- Update `FRONTEND_ORIGINS` in backend `.env` to your real frontend URL.
- Backend and frontend are two separate deployments (e.g. Render/Railway for
  the backend, Vercel/Netlify for the frontend) — Streamlit Cloud can't host
  this stack, since it's not a single Streamlit script anymore.

## What's in here

**Backend** (`backend/app/`)
- `routers/` — auth, documents, query (chat), agents, features, voice
- `services/` — vectorstore (ChromaDB, per-user isolated), document_processor,
  llm_service (GPT-4o-mini), research_search (arXiv + Semantic Scholar +
  OpenAlex + link-summarizer), agent_service (LangGraph pipelines),
  guardrails, rate_limit, memory_service, voice_service
- `models.py` — Users, Documents, ChatMessages, AgentRuns/AgentSteps
  (drives the frontend's side panel), SmartMemory

**Frontend** (`frontend/src/`)
- Dark glassmorphism theme (teal/coral), small lucide-react icons throughout
- `components/AgentPanel.jsx` — sliding side panel with a live step-tracker
  for every agent run: the answer/content comes first, paper/reference
  cards and steps come after (with an inline "Summarize this" button per
  reference), and a "Delete this result" button sits right under each run
- `components/AgentLauncherView.jsx` — every agent (except Citation) accepts
  a document, a topic/question, or both; if a document is given with no
  topic text, the topic is auto-extracted from the document
- `components/ChatWindow.jsx` — a document can be attached/detached per
  conversation via a chip above the input; with no document attached, chat
  answers from general knowledge like a normal AI assistant instead of
  restricting itself to document content
- `components/Sidebar.jsx` — Agents and Tools grouped separately
- Full auth flow with JWT refresh, logout, reset-workspace
- Quiz (instant right/wrong), Flashcards (flip cards), Presentation preview,
  Voice assistant (record → transcribe → answer → speak)

## Behavior notes worth knowing

- **Citation Agent always requires a document** — page-number citations
  don't exist without one. Every other agent works with just a topic, just
  a document, or both, and Research/Citation also accept **multiple**
  documents at once (compare/cite across several files).
- **Answers match the question's language** — chat, voice, and citation
  answers are prompted to respond in whatever language the question was
  asked in, rather than drifting into a random one.
- **Citation page numbers are informational, not clickable** — there's no
  in-app PDF viewer yet, so "Page 3" is a label, not a link.

## New in this version (all free except Stripe's real transaction fees)

- **Agent history** — every past agent run is listed (sidebar → "Agent
  History") and can be reopened in the side panel or deleted individually.
- **Multi-document context** — Chat and the Research/Citation agents accept
  several documents at once (checkbox multi-select in the UI) to compare or
  cite across files, not just one at a time.
- **Better confidence scoring** — Citation Agent results are re-ranked by a
  free local cross-encoder (`cross-encoder/ms-marco-MiniLM-L-6-v2`, ~90MB
  one-time download) instead of relying on raw vector-similarity distance.
- **Live streaming agent steps** — `/agents/stream` + a WebSocket
  (`/ws/agents/{run_id}`) push each step to the UI in real time as it
  happens, instead of waiting for the whole run to finish.
- **Email verification & password reset** — via plain SMTP (your own
  Gmail/Outlook "app password", not a paid email API). If SMTP isn't
  configured, emails are logged to the console instead of failing, so
  local dev works with zero setup.
- **Two-factor authentication (2FA)** — TOTP-based (Google Authenticator,
  Authy, etc.) — free, no SMS provider.
- **Admin dashboard** — user list, plan management, platform stats
  (signups, feature usage, agent-type breakdown). Bootstrap your first
  admin via the `ADMIN_USERNAMES` env var — they're auto-promoted on their
  next login.
- **Usage limits per plan (free vs. Pro)** — document count and daily
  chat/agent limits, enforced server-side and tunable via env vars.
- **Stripe billing** — checkout + billing portal + webhook for the
  free→Pro upgrade. Integrating Stripe is free; only real charges cost
  anything, and test mode (test keys, test card numbers) is entirely free
  for development.
- **Analytics** — the admin stats endpoint surfaces signups over time,
  agent-type usage, and feature usage counts.


## Known limitations (honest, same spirit as the original roadmap)

- Document processing uses FastAPI `BackgroundTasks`, not a real distributed
  queue (Celery+Redis) — fine for one process, revisit under heavy load.
- If the server crashes mid-processing, a document can get stuck in
  "processing" — no automatic timeout/retry yet.
- Rate limiting is in-process (per-worker) — fine for one machine, swap for
  Redis-backed limiting before running multiple workers/machines.
- Voice works via file upload, not a live in-browser microphone stream (same
  as V3 — `MediaRecorder` records to a file, then uploads it).
- No Alembic migrations yet — schema changes need manual handling until
  that's set up.

## Fixes discovered on real-machine (Windows) testing

These aren't hypothetical — they were hit and fixed on an actual Windows +
conda setup, and `requirements.txt` now reflects the versions that actually
work instead of the ones originally guessed:

- **PyMuPDF DLL load failure** (`ImportError: DLL load failed while
  importing _extra`) — the originally pinned 1.24.5 didn't ship a working
  wheel for this environment; left unpinned so pip resolves a current build.
- **LangGraph import crash** (`Reviver.__init__() got an unexpected keyword
  argument 'allowed_objects'`) — the pinned langgraph/langchain-core pair had
  drifted out of sync with their own sub-packages; loosened to `>=0.2`/`>=0.3`
  so pip resolves a mutually compatible set.
- **OpenAI client crash** (`Client.__init__() got an unexpected keyword
  argument 'proxies'`) — older openai versions break on newer httpx; pinned
  to `>=1.40,<2.0` (the `<2.0` is deliberate — v2 wasn't part of this
  session's testing, so staying on 1.x until it has been).

