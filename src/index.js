// External render worker.
// Polls the `render-worker` edge function for pending jobs, generates a short
// clip per scene with Runway Gen-3 (image-to-video), stitches them with FFmpeg,
// uploads the final mp4 to Lovable Cloud storage, and marks the job complete.

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fetch from "node-fetch";
import pRetry from "p-retry";

const {
  SUPABASE_FUNCTIONS_URL,
  WORKER_SECRET,
  RUNWAY_API_KEY,
  POLL_INTERVAL_MS = "4000",
  WORKER_ID = `worker-${process.pid}`,
  FFMPEG = "ffmpeg",
} = process.env;

for (const [k, v] of Object.entries({ SUPABASE_FUNCTIONS_URL, WORKER_SECRET, RUNWAY_API_KEY })) {
  if (!v) { console.error(`Missing env ${k}`); process.exit(1); }
}

const WORKER_URL = `${SUPABASE_FUNCTIONS_URL.replace(/\/$/, "")}/render-worker`;
const RUNWAY_URL = "https://api.dev.runwayml.com/v1";

const log = (...a) => console.log(new Date().toISOString(), "[worker]", ...a);

// Cinematic anime motion directive injected into every scene prompt so Runway
// produces a fully animated shot (camera move + character/environmental motion)
// instead of a near-still image. Keep concise — Runway promptText is capped.
const ANIME_STYLE = [
  "cinematic anime film still in motion",
  "fluid character animation, natural body movement, blinking, breathing",
  "smooth camera movement: slow dolly-in, subtle parallax, tracking shot",
  "environmental motion: drifting clouds, swaying foliage, wind in hair and clothing, shifting light",
  "consistent studio-quality color grading, soft volumetric lighting, depth of field, subtle film grain",
  "seamless continuous motion, no static frames, 24fps anime feel",
].join(", ");

function buildAnimePrompt(sceneText) {
  const base = (sceneText || "").trim();
  const combined = `${base}. ${ANIME_STYLE}`;
  return combined.slice(0, 500);
}

async function rpc(action, payload = {}) {
  const res = await fetch(WORKER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-worker-secret": WORKER_SECRET },
    body: JSON.stringify({ action, ...payload }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`rpc ${action} ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

function ffmpegRun(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args, { stdio: ["ignore", "inherit", "inherit"] });
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
  });
}

async function downloadTo(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${url}: ${res.status}`);
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
}

// --- Runway Gen-3 image-to-video ---------------------------------------------
async function runwayGenerate(imageUrl, promptText, duration) {
  const create = await fetch(`${RUNWAY_URL}/image_to_video`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RUNWAY_API_KEY}`,
      "Content-Type": "application/json",
      "X-Runway-Version": "2024-11-06",
    },
      body: JSON.stringify({
        model: "gen3a_turbo",
        promptImage: imageUrl,
        promptText: buildAnimePrompt(promptText),
        // Always request 10s clips so each scene has room for a real camera move
        // and character animation rather than a 5s near-still.
        duration: 10,
        ratio: "1280:768",
      }),
  });
  if (!create.ok) throw new Error(`runway create ${create.status}: ${await create.text()}`);
  const { id } = await create.json();

  // Poll task until SUCCEEDED / FAILED
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const t = await fetch(`${RUNWAY_URL}/tasks/${id}`, {
      headers: { Authorization: `Bearer ${RUNWAY_API_KEY}`, "X-Runway-Version": "2024-11-06" },
    });
    if (!t.ok) throw new Error(`runway poll ${t.status}: ${await t.text()}`);
    const data = await t.json();
    if (data.status === "SUCCEEDED") return data.output?.[0];
    if (data.status === "FAILED") throw new Error(`runway failed: ${data.failure ?? "unknown"}`);
  }
  throw new Error("runway timeout");
}

// --- Per-job pipeline --------------------------------------------------------
async function processJob(job) {
  const { id: jobId, project_id } = job;
  log("processing job", jobId, "project", project_id);

  const { scenes } = await rpc("scenes", { project_id });
  if (!scenes?.length) throw new Error("no scenes");

  const work = await mkdtemp(join(tmpdir(), `job-${jobId}-`));
  try {
    const clips = [];
    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      log(`scene ${i + 1}/${scenes.length}`);

      let clipPath = join(work, `clip-${i}.mp4`);

      if (scene.image_url) {
        try {
          const videoUrl = await pRetry(
            () => runwayGenerate(scene.image_url, scene.text, scene.duration_sec || 10),
            { retries: 2 },
          );
          await downloadTo(videoUrl, clipPath);
        } catch (e) {
          log("runway failed, falling back to still image:", e.message);
          // Fallback: animate still image with strong Ken Burns + subtle pan so
          // even the fallback feels like a moving camera, not a slide.
          const imgPath = join(work, `img-${i}.jpg`);
          await downloadTo(scene.image_url, imgPath);
          const dur = scene.duration_sec || 8;
          const frames = Math.max(1, Math.round(dur * 25));
          await ffmpegRun([
            "-y", "-loop", "1", "-i", imgPath,
            "-t", String(dur),
            "-vf",
            // Upscale, then slow zoom + diagonal pan for cinematic feel,
            // and a faint film-grade curve for color consistency.
            `scale=2560:1440,zoompan=z='min(zoom+0.0008,1.25)':x='iw/2-(iw/zoom/2)+sin(on/40)*30':y='ih/2-(ih/zoom/2)+cos(on/55)*20':d=${frames}:s=1280x720,eq=contrast=1.05:saturation=1.08:gamma=0.98`,
            "-r", "25", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "veryfast",
            clipPath,
          ]);
        }
      } else {
        // No image: black slate with text duration
        await ffmpegRun([
          "-y", "-f", "lavfi", "-i", `color=c=black:s=1280x720:d=${scene.duration_sec || 5}`,
          "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", clipPath,
        ]);
      }

      clips.push(clipPath);

      const progress = 20 + Math.floor(((i + 1) / scenes.length) * 70);
      await rpc("progress", { job_id: jobId, progress });
    }

    // Stitch clips with seamless crossfade transitions (xfade) so cuts feel
    // story-driven, not abrupt. Falls back to plain concat for a single clip.
    const finalPath = join(work, "final.mp4");
    if (clips.length === 1) {
      await ffmpegRun([
        "-y", "-i", clips[0],
        "-vf", "scale=1280:720,eq=contrast=1.04:saturation=1.06:gamma=0.98",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast",
        "-movflags", "+faststart", finalPath,
      ]);
    } else {
      // Probe each clip for its duration so xfade offsets line up exactly.
      const durations = [];
      for (const c of clips) {
        const d = await new Promise((resolve, reject) => {
          const p = spawn("ffprobe", [
            "-v", "error", "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1", c,
          ]);
          let out = "";
          p.stdout.on("data", (b) => (out += b));
          p.on("close", (code) => code === 0 ? resolve(parseFloat(out)) : reject(new Error("ffprobe failed")));
        });
        durations.push(d);
      }

      const XFADE = 0.8; // seconds of crossfade between scenes
      const inputs = clips.flatMap((c) => ["-i", c]);
      // Normalize every input to 1280x720 @ 25fps with consistent grade
      const norm = clips
        .map((_, i) => `[${i}:v]scale=1280:720,setsar=1,fps=25,eq=contrast=1.04:saturation=1.06:gamma=0.98[v${i}]`)
        .join(";");

      let chain = "";
      let prev = "v0";
      let offset = durations[0] - XFADE;
      for (let i = 1; i < clips.length; i++) {
        const out = i === clips.length - 1 ? "vout" : `x${i}`;
        chain += `;[${prev}][v${i}]xfade=transition=fade:duration=${XFADE}:offset=${offset.toFixed(3)}[${out}]`;
        prev = out;
        offset += durations[i] - XFADE;
      }
      const filter = `${norm}${chain}`;

      await ffmpegRun([
        "-y", ...inputs,
        "-filter_complex", filter,
        "-map", "[vout]",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast",
        "-r", "25", "-movflags", "+faststart",
        finalPath,
      ]);
    }

    // Request a signed upload URL and PUT the file
    const filename = `final-${Date.now()}.mp4`;
    const sign = await rpc("sign_upload", { project_id, filename });
    const fileBuf = await readFile(finalPath);
    const upload = await fetch(sign.signedUrl ?? sign.signedURL ?? sign.url, {
      method: "PUT",
      headers: { "Content-Type": "video/mp4" },
      body: fileBuf,
    });
    if (!upload.ok) throw new Error(`upload ${upload.status}: ${await upload.text()}`);

    await rpc("complete", { job_id: jobId, video_path: sign.path });
    log("job complete", jobId);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

// --- Main loop --------------------------------------------------------------
async function loop() {
  while (true) {
    try {
      const { job } = await rpc("claim", { worker_id: WORKER_ID });
      if (!job) {
        await new Promise((r) => setTimeout(r, Number(POLL_INTERVAL_MS)));
        continue;
      }
      try {
        await processJob(job);
      } catch (err) {
        log("job failed", job.id, err);
        await rpc("fail", { job_id: job.id, error: err?.message ?? String(err) }).catch(() => {});
      }
    } catch (err) {
      log("poll error", err.message);
      await new Promise((r) => setTimeout(r, Number(POLL_INTERVAL_MS)));
    }
  }
}

log("starting worker", WORKER_ID, "->", WORKER_URL);
loop();
