# Render Worker (Railway-ready)

External Node 20 + FFmpeg worker. Polls the `render-worker` edge function,
generates a clip per scene with Runway Gen-3, stitches with FFmpeg, uploads
the final MP4 to Lovable Cloud storage, and marks the project `completed`.

## Deploy to Railway (one-time)

1. Push this repo (or just the `worker/` folder) to GitHub.
2. On https://railway.app → **New Project → Deploy from GitHub repo**.
3. Pick the repo. If the worker is in a subfolder, set **Root Directory** to `worker`.
4. Railway auto-detects the `Dockerfile` (FFmpeg is preinstalled inside it).
5. Open **Variables** and add:

   | Key | Value |
   |---|---|
   | `SUPABASE_FUNCTIONS_URL` | `https://rqqjecalvmvvfjekozgx.functions.supabase.co` |
   | `WORKER_SECRET` | `8fK29sLxPq93mZx7AqW91dLkP0XzR2Nm` |
   | `RUNWAY_API_KEY` | `key_7877c3ca1aab25a3437f3196b907c18e674086d192fed814be72be9bfdfb3a4fd82a4577bb6887713a6a87e48f2d0842b4e18750fd80eb53cf23e8f779c5a5f7` |
   | `POLL_INTERVAL_MS` | `4000` |
   | `WORKER_ID` | `railway-worker-1` |

6. Click **Deploy**. Logs should show `starting worker railway-worker-1 -> https://…/render-worker`.

No public port is needed — this is a background worker, not an HTTP server.

## Run locally

```bash
cp .env.example .env
npm install
npm start    # requires ffmpeg on PATH
```

Or via Docker:

```bash
docker build -t render-worker .
docker run --env-file .env render-worker
```

## How it works

1. Polls the `render-worker` edge function with a shared `WORKER_SECRET`.
2. Atomically claims the next pending job (`claim_next_render_job` Postgres function with `FOR UPDATE SKIP LOCKED`).
3. For each scene: calls Runway Gen-3 image-to-video; on failure falls back to a Ken-Burns animation of the still.
4. Concatenates clips with FFmpeg.
5. Uploads the MP4 with a signed URL.
6. Marks the job `completed` and the project `completed` with `video_url`.

## Run locally

```bash
cp .env.example .env   # fill in WORKER_SECRET + RUNWAY_API_KEY
npm install
npm start
```

Requires `ffmpeg` on PATH.

## Deploy (Railway / Fly / Render / Docker)

```bash
docker build -t render-worker .
docker run --env-file .env render-worker
```

Scale horizontally — the DB-side `SKIP LOCKED` claim guarantees each job is
processed exactly once.

## Environment

| Var | Description |
|---|---|
| `SUPABASE_FUNCTIONS_URL` | e.g. `https://<ref>.functions.supabase.co` |
| `WORKER_SECRET` | Must match the secret stored in Lovable Cloud |
| `RUNWAY_API_KEY` | Runway Gen-3 API key |
| `POLL_INTERVAL_MS` | Poll cadence when idle (default 4000) |
| `WORKER_ID` | Logged into job payload |
| `FFMPEG` | ffmpeg binary path |