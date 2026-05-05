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
      promptText: promptText.slice(0, 500),
      duration: duration >= 10 ? 10 : 5,
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
            () => runwayGenerate(scene.image_url, scene.text, scene.duration_sec || 5),
            { retries: 2 },
          );
          await downloadTo(videoUrl, clipPath);
        } catch (e) {
          log("runway failed, falling back to still image:", e.message);
          // Fallback: animate still image with subtle zoom (Ken Burns)
          const imgPath = join(work, `img-${i}.jpg`);
          await downloadTo(scene.image_url, imgPath);
          await ffmpegRun([
            "-y", "-loop", "1", "-i", imgPath,
            "-t", String(scene.duration_sec || 5),
            "-vf", "scale=1280:720,zoompan=z='min(zoom+0.0015,1.2)':d=125:s=1280x720",
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

    // Concat with FFmpeg concat demuxer
    const listPath = join(work, "list.txt");
    await writeFile(listPath, clips.map((c) => `file '${c}'`).join("\n"));
    const finalPath = join(work, "final.mp4");
    await ffmpegRun([
      "-y", "-f", "concat", "-safe", "0", "-i", listPath,
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-movflags", "+faststart",
      finalPath,
    ]);

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
