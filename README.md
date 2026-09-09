# LeadLoop

Open-source, self-hosted follow-up sequencer for Gmail. No AI, no auto-sending.

You (or your AI agents) write and send the personalized first email. Then you tag the thread into a sequence, and LeadLoop drafts every follow-up from the sequence's steps — threaded, variables filled, on each step's delay — as Gmail drafts you review and send yourself. A reply stops the run.

## What it does

- **Sequences** — each carries its follow-up emails inline as ordered steps (bump → case study → breakup): a body with `{{variable}}` placeholders + a delay in days, per step
- **Runs** — a thread enrolled in a sequence. LeadLoop syncs the thread, drafts the next step when due, advances, and stops on reply
- **Examples** — tag winning runs so your GTM team can study what worked
- **Three doors to enroll a thread** — MCP tool for agents, Gmail sidebar for one-offs, dashboard form for everything else (including phone sends)

LeadLoop never writes copy and sends only on an explicit dashboard/MCP action ("Send LeadLoop drafts", and only drafts it created). Otherwise it renders your steps, creates drafts, and keeps the cadence.

## The core workflow

1. You or an agent send a personalized first email through Gmail.
2. Enroll the thread: `start_sequence(sequence_id, recipient_email, variables: {first_name: "Sara", company: "Acme"})`. No Gmail thread ID needed — the Worker finds your newest sent thread to that address.
3. Variables are validated against every step in the sequence up front. Missing variables are rejected with the exact list, so a draft can never go out with a raw `{{placeholder}}`.
4. A cron job checks every 10 minutes. When a step is due, LeadLoop syncs the thread, then creates a threaded Gmail draft with variables substituted.
5. You review the draft in Gmail and hit send. If the previous draft was never sent, LeadLoop defers instead of stacking drafts.
6. A reply marks the run `replied` and dismisses remaining steps. When steps run out, the run is `completed`.
7. Won the deal? Save the run as an example — the full conversation is copied into one row for GTM analysis.

## Architecture

```
Gmail Add-on (Apps Script)  ←→  Cloudflare Worker (API)  ←→  Supabase (DB + Auth)
                                        ↕
Dashboard (Next.js on Cloudflare Workers)
                                        ↕
AI agents (MCP clients: Cursor, Claude, …)  ←→  /mcp endpoint
```

| Component | Tech | Purpose |
|-----------|------|---------|
| `apps/gmail-addon/` | Google Apps Script | Thin Gmail sidebar UI |
| `leadloop-worker/` | Cloudflare Workers + Hono | API, sequence engine, queue consumer, cron |
| `apps/leadloop-dashboard/` | Next.js 16, React 19, Tailwind (on Cloudflare Workers via OpenNext) | Management dashboard |
| `supabase/migrations/` | PostgreSQL | Database schema + RLS policies |

## Prerequisites

You'll need accounts (all have free tiers sufficient for personal use):

- [Supabase](https://supabase.com) — database and auth
- [Cloudflare](https://cloudflare.com) — API Worker + dashboard hosting, queues, cron
- [Google Cloud Console](https://console.cloud.google.com) — OAuth client for Gmail
- [Node.js](https://nodejs.org) 18+ (npm workspaces are used, no other package manager needed)

## Setup

### 1. Clone and install

```bash
git clone https://github.com/YOUR_USERNAME/leadloop.git
cd leadloop
npm install
```

### 2. Supabase

Create a new Supabase project, then:

```bash
npm install -g supabase
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase db push
```

This runs the migrations in `supabase/migrations/` which create all tables and RLS policies.

In the Supabase dashboard:

1. Go to **Authentication > Providers > Google** and enable it.
2. Enter your Google OAuth client ID and secret (see step 4 below).
3. Copy the callback URL Supabase gives you — you'll need it for Google Cloud Console.
4. Go to **Authentication > URL Configuration**:
   - Set **Site URL** to your dashboard URL (e.g. `https://leadloop-dashboard.YOUR_SUBDOMAIN.workers.dev`)
   - Add `https://leadloop-dashboard.YOUR_SUBDOMAIN.workers.dev/auth/callback` to **Redirect URLs**
   - For local dev, also add `http://localhost:3000/auth/callback`

Note down your **Project URL**, **anon key**, and **service role key** from **Settings > API**.

### 3. Cloudflare Worker

```bash
cd leadloop-worker
```

Edit `wrangler.jsonc` and fill in your Supabase URL, anon key, and dashboard URL in the `vars` section.

Set up secrets:

```bash
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
wrangler secret put ADDON_API_KEY
wrangler secret put MCP_API_KEY
```

For `ADDON_API_KEY`, generate any random string (e.g. `openssl rand -hex 32`). This is a shared secret between the Gmail add-on and the Worker. `MCP_API_KEY` works the same way but for AI agents connecting to the [MCP server](#mcp-server-ai-agents) — use a different random string.

For local development, copy the example env file:

```bash
cp .dev.vars.example .dev.vars
# Fill in your values
npm run dev
```

Deploy:

```bash
npm run deploy
```

Note the Worker URL (e.g. `https://leadloop-worker.YOUR_SUBDOMAIN.workers.dev`).

### 4. Google OAuth client

1. Go to [Google Cloud Console](https://console.cloud.google.com) and create a new project (or use an existing one).
2. Go to **APIs & Services > OAuth consent screen**. Configure it for **External** users (or Internal if you have a Workspace org). Add the Gmail API scopes:
   - `https://www.googleapis.com/auth/gmail.readonly`
   - `https://www.googleapis.com/auth/gmail.compose`
   - `https://www.googleapis.com/auth/gmail.modify`
3. Go to **APIs & Services > Credentials** and create an **OAuth 2.0 Client ID** (Web application).
4. Under **Authorized redirect URIs**, add the Supabase callback URL from step 2.
5. Under **Authorized JavaScript origins**, add your dashboard URL (e.g. `https://leadloop-dashboard.YOUR_SUBDOMAIN.workers.dev`).
6. Copy the **Client ID** and **Client Secret** — these go into both Supabase (step 2) and the Worker secrets (step 3).
7. **Publish the app.** On the OAuth consent screen, set the publishing status to **In production** (or use the **Internal** user type if the project belongs to your Google Workspace org). While the status is **Testing**, Google expires every refresh token after **7 days** — LeadLoop's background drafting then dies a week after each sign-in with `invalid_grant`, and you have to sign in again. Publishing an unverified app with Gmail scopes just adds an "unverified app" screen at sign-in; it does not need Google's verification review for a personal or small-team deployment.

If you must stay in **Testing** mode for now, add your email as a test user and expect to reconnect Gmail weekly.

### 5. Dashboard

```bash
cd apps/leadloop-dashboard
cp .env.local.example .env.local
# Fill in your Supabase URL, anon key, and Worker URL
```

The dashboard runs on Cloudflare Workers via the [OpenNext adapter](https://opennext.js.org/cloudflare). The `NEXT_PUBLIC_*` variables are inlined at build time from `.env.local`, so make sure they're filled in before deploying.

Deploy:

```bash
npm run deploy
```

Note the dashboard URL (e.g. `https://leadloop-dashboard.YOUR_SUBDOMAIN.workers.dev`). Set it as the `DASHBOARD_URL` variable on the API Worker (Cloudflare dashboard > leadloop-worker > Settings > Variables) so CORS allows the dashboard origin, and use it in the Supabase and Google OAuth settings from steps 2 and 4.

For local development:

```bash
npm run dev:dashboard   # Next.js dev server
npm run preview:dashboard   # build + preview in the Workers runtime
```

### 6. Gmail Add-on

Install the Google Apps Script CLI:

```bash
npm install -g @google/clasp
clasp login
```

Create and push the add-on:

```bash
cd apps/gmail-addon
clasp create --type standalone --title "LeadLoop"
clasp push
```

#### New machine? Re-link the existing project (~2 minutes)

`.clasp.json` holds the script ID and is gitignored, so a fresh clone can't push. Recreate it — do NOT run `clasp create` (makes a duplicate project) or `clasp clone` (overwrites local `.gs` files):

```bash
cd apps/gmail-addon
clasp login
cp .clasp.json.example .clasp.json
clasp list   # prints your projects + script IDs
```

1. Copy the LeadLoop script ID from `clasp list` (or [script.google.com](https://script.google.com) > open the project > **Project Settings** > **Script ID**)
2. Paste it over `YOUR_APPS_SCRIPT_ID` in `.clasp.json`
3. Run `clasp push`

If push fails with an Apps Script API error: enable it at [script.google.com/home/usersettings](https://script.google.com/home/usersettings), then push again.

Configure the add-on:

1. Open the script in the Apps Script editor: `clasp open`
2. Go to **Project Settings > Script Properties** and add:
   - `WORKER_URL` = your deployed Worker URL (e.g. `https://leadloop-worker.YOUR_SUBDOMAIN.workers.dev`)
3. To install as a Gmail add-on for testing:
   - In the Apps Script editor, click **Deploy > Test deployments**
   - Click **Install** next to the Gmail add-on entry
4. Open Gmail — the LeadLoop sidebar should appear when you open a message.
5. Click **Settings** in the add-on and paste the same `ADDON_API_KEY` value you set in the Worker. (Cloudflare secrets can't be read back — if you've lost it, rotate: `openssl rand -hex 32`, then `npx wrangler secret put ADDON_API_KEY` and paste the new value here.)

## Usage

### Dashboard

- **Sequences** — Create sequences and write their follow-up steps inline (body with `{{name}}`, `{{company}}`, etc. + wait days each), start runs (recipient email + variables), watch run progress (step X of Y, next draft date), stop runs, save winners as examples.
- **Examples** — Browse saved winning conversations, filter by text or sequence. This is the GTM team's corpus.
- **Settings** — Gmail connection status, usage stats, connect your AI agents over MCP.

### Gmail Add-on

When reading an email:
- **No run yet** — "Start sequence" form: pick a sequence, fill its variables (recipient prefilled from the thread), go.
- **Active run** — status card: step X of Y, next draft date, **Stop run**, **Save as example**.

Gmail add-ons don't run on mobile — for phone-sent emails, enroll via the dashboard or MCP instead.

### MCP server (AI agents)

**Live now:** `https://leadloop-worker.tanujsiripurapu.workers.dev/mcp` — the intended loop: your agent writes and sends the personalized first email, then immediately calls `start_sequence` with the lead's variables it already knows. No Gmail plumbing on the agent side.

Connect an agent (~3 minutes):

1. Set the secret (once): `cd leadloop-worker && npx wrangler secret put MCP_API_KEY` — paste any random string (`openssl rand -hex 32` makes one)
2. Paste into `.cursor/mcp.json`, swapping in your key and your Gmail:

```json
{
  "mcpServers": {
    "leadloop": {
      "url": "https://leadloop-worker.tanujsiripurapu.workers.dev/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_MCP_API_KEY",
        "X-User-Email": "you@example.com"
      }
    }
  }
}
```

3. Ask the agent to run `list_sequences`. Success = a JSON list. 401 or 403 = wrong key; "User not found" = `X-User-Email` doesn't match the `gmail_email` on your profile.

Claude Code instead of Cursor:

```bash
claude mcp add --transport http leadloop \
  https://leadloop-worker.tanujsiripurapu.workers.dev/mcp \
  --header "Authorization: Bearer YOUR_MCP_API_KEY" \
  --header "X-User-Email: you@example.com"
```

The 16 tools:

- **Sequences** — `list_sequences`, `get_sequence` (steps + the union of required variables), `create_sequence` (name + inline `steps: [{body, delay_days}]`), `update_sequence` (also replaces steps wholesale), `delete_sequence`.
- **Runs** — `start_sequence` (enroll by `recipient_email` or `gmail_thread_id` + variables; strict validation), `list_runs`, `get_run` (progress + messages + `next_draft_at`/`unsent_draft_status`), `draft_now` (bump selected runs' next draft to now; drafts only), `send_leadloop_drafts` (send selected runs' LeadLoop-created drafts — sends real email, requires explicit run ids), `stop_run`, `save_run_as_example`.
- **Examples** — `list_examples` (text search + tag/outcome/sequence filters), `create_example`, `update_example`, `delete_example`.

The agent workflow: `create_sequence(name, steps)` once, then per lead — write and send the first email, `start_sequence(sequence_id, recipient_email, variables)`. Drafts appear on cadence (or on `draft_now`); nothing is sent until you (or an agent) explicitly call `send_leadloop_drafts` with run ids.

Local test (needs `MCP_API_KEY` in `.dev.vars`): run `npm run dev` in `leadloop-worker/`, then:

```bash
npx @modelcontextprotocol/inspector --cli http://localhost:8787/mcp \
  --transport http --method tools/list \
  --header "Authorization: Bearer YOUR_MCP_API_KEY" \
  --header "X-User-Email: you@example.com"
```

## Project structure

```
leadloop/
├── apps/
│   ├── gmail-addon/          # Google Apps Script add-on
│   │   └── src/
│   │       ├── main.gs       # Entry points and action handlers
│   │       ├── ui.gs         # Card UI builders
│   │       └── api.gs        # Worker API client
│   └── leadloop-dashboard/   # Next.js dashboard
│       └── app/
│           ├── (dashboard)/  # Authenticated pages
│           └── login/        # Auth flow
├── leadloop-worker/          # Cloudflare Worker API
│   └── src/
│       ├── routes/           # API endpoints
│       ├── mcp/              # MCP server + agent tools
│       ├── jobs/             # Queue consumer (follow-up drafts)
│       ├── services/         # Gmail, runs, threads
│       ├── middleware/       # Auth, CORS
│       └── lib/              # Types, Supabase client, step rendering
└── supabase/
    └── migrations/           # Database schema
```

## Development

From the repo root:

```bash
# Start the Worker locally
npm run dev:worker

# Start the dashboard locally
npm run dev:dashboard

# Deploy the Worker
npm run deploy:worker

# Deploy the dashboard
npm run deploy:dashboard

# Push add-on changes
cd apps/gmail-addon && clasp push
```

Run the Worker tests:

```bash
cd leadloop-worker && npm test
```

## How it works

1. **Auth**: Users sign in with Google via Supabase Auth. The OAuth flow captures a Gmail refresh token, enabling the Worker to fetch mail and create drafts on their behalf.
2. **Gmail Add-on**: A thin Apps Script client that renders Cards in the Gmail sidebar. All business logic lives in the Worker — the add-on just makes API calls.
3. **Enrollment**: `start_sequence` (MCP, sidebar, or dashboard — one shared code path) resolves the thread from your sent mail if you only give an email address, validates variables against every step in the sequence, creates the run, and schedules step 1 at last-sent-time + the step's `delay_days`.
4. **The engine**: A cron job checks every 10 minutes for due steps and queues draft creation (the dashboard/MCP "Draft now" enqueues the same jobs immediately). The consumer atomically leases each row, re-syncs the thread, and reconciles first: a reply dismisses the follow-up and marks the run `replied`; a previous draft sent manually is marked `superseded` and the cadence re-anchors on the real send time; an unsent previous draft defers the step. Otherwise it renders the step body with the run's variables, creates a threaded Gmail draft, advances the step, and schedules the next one. Sending happens only via the explicit "Send LeadLoop drafts" action (dashboard or MCP), which sends the exact stored draft ids and reschedules the next step from the actual send. Runs complete when steps run out.
5. **Examples**: Saving a run copies the full conversation into one `outreach_examples` row (subject, rendered thread text, tags, the winning sequence). Self-contained — it survives thread deletion.
6. **Security**: All tables use Row Level Security. The add-on authenticates via a shared API key + user email header. The dashboard uses Supabase JWT auth. The MCP endpoint uses its own bearer API key + user email header, and every tool query is scoped to that user.
7. **Gmail credential loss**: Every Gmail call goes through one token exchange (`getAccessToken`). If Google answers `invalid_grant` — the refresh token was revoked, invalidated by a password change, or hit the 7-day Testing-mode expiry — the Worker nulls the profile's token and records the reason in `profiles.gmail_auth_error`. From then on the cron sweep skips that user's due follow-ups (they stay `pending`), the queue consumer does not retry, and the dashboard shows a banner with the reason and a **Reconnect Gmail** button. Signing in again stores a fresh token, clears the error, and the backlog drafts on the next sweeps (50 per 10 minutes). Only Google-side 5xx/429 failures are retried, with backoff.

## Troubleshooting

**"Gmail is disconnected" banner / `Token refresh failed (400 invalid_grant)` in Worker logs.** Google no longer accepts the stored refresh token. Click **Reconnect Gmail** (or sign out and back in). If it recurs about 7 days after every sign-in, the OAuth consent screen is still in **Testing** — see step 7 of the Google OAuth setup.

**`Token refresh failed (401 invalid_client)` / `unauthorized_client`.** The Worker's `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` secrets don't match the OAuth client configured in Supabase Auth. Re-run `wrangler secret put` with the right values; no re-login needed.

**Follow-ups are due but nothing is drafting.** Check the banner/Settings first. Then, in Workers observability, filter `leadloop-worker` logs for `Queue job failed` or `paused for user` — the message includes Google's error code and description.

## License

[MIT](LICENSE)
