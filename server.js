import "dotenv/config";
import express from "express";
import multer from "multer";
import path from "path";
import { promises as fs } from "fs";
import { fileURLToPath } from "url";
import Anthropic from "@anthropic-ai/sdk";

import { prepareFiles, generateUnits, isSupportedFile, validateQuestions } from "./src/generator.js";
import { createJob, getJob, updateJob } from "./src/jobs.js";
import { ASSETS_DIR, listUnits, getUnit, createUnit, deleteUnit, updateUnit } from "./src/store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 12 },
});

app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/assets", express.static(ASSETS_DIR));

function apiErrorResponse(err) {
  if (err instanceof Anthropic.AuthenticationError) {
    return { status: 500, error: "Invalid ANTHROPIC_API_KEY. Check your .env file." };
  }
  if (err instanceof Anthropic.RateLimitError) {
    return { status: 429, error: "Rate limited by the Claude API. Wait a minute and try again." };
  }
  if (err instanceof Anthropic.APIError) {
    return { status: 502, error: `Claude API error: ${err.message}` };
  }
  return { status: err.status || 500, error: err.message || "Generation failed." };
}

// ---------------------------------------------------------------------------
// Generation (async job — the pipeline makes several model calls)
// ---------------------------------------------------------------------------

app.post("/api/units/generate", upload.array("files"), async (req, res) => {
  const files = req.files || [];
  if (files.length === 0) {
    return res.status(400).json({ error: "Upload at least one file." });
  }
  const unsupported = files.filter((f) => !isSupportedFile(f));
  if (unsupported.length > 0) {
    return res.status(400).json({
      error: `Unsupported file type: ${unsupported.map((f) => f.originalname).join(", ")}. Use JPG, PNG, HEIC, or PDF.`,
    });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add your key." });
  }

  const job = createJob();
  res.status(202).json({ jobId: job.id });

  // Run the pipeline detached from the request.
  (async () => {
    try {
      updateJob(job.id, { phase: "Preparing files…" });
      const prepared = await prepareFiles(files);

      // Persist normalized images so labeling activities can render them.
      const assetDir = path.join(ASSETS_DIR, job.id);
      await fs.mkdir(assetDir, { recursive: true });
      const assetUrls = [];
      await Promise.all(
        prepared.map(async (file, i) => {
          if (file.kind !== "image") return;
          await fs.writeFile(path.join(assetDir, `img_${i}.jpg`), file.buffer);
          assetUrls[i] = `/assets/${job.id}/img_${i}.jpg`;
        }),
      );

      const units = await generateUnits(prepared, assetUrls, (phase) => updateJob(job.id, { phase }));

      const unitIds = [];
      for (const unit of units) {
        const saved = await createUnit(unit);
        unitIds.push(saved.id);
      }
      updateJob(job.id, { status: "done", phase: "Done", unitIds });
    } catch (err) {
      console.error("Unit generation failed:", err);
      updateJob(job.id, { status: "error", error: apiErrorResponse(err).error });
    }
  })();
});

app.get("/api/jobs/:id", (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found (it may have expired)." });
  res.json({ status: job.status, phase: job.phase, unitIds: job.unitIds, error: job.error });
});

// ---------------------------------------------------------------------------
// Units CRUD
// ---------------------------------------------------------------------------

app.get("/api/units", async (req, res, next) => {
  try {
    res.json(await listUnits());
  } catch (err) {
    next(err);
  }
});

app.get("/api/units/:id", async (req, res, next) => {
  try {
    const unit = await getUnit(req.params.id);
    if (!unit) return res.status(404).json({ error: "Unit not found." });
    res.json(unit);
  } catch (err) {
    next(err);
  }
});

app.delete("/api/units/:id", async (req, res, next) => {
  try {
    const removed = await deleteUnit(req.params.id);
    if (!removed) return res.status(404).json({ error: "Unit not found." });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Editing quizzes (module quiz / unit test) and unit title
// ---------------------------------------------------------------------------

function cleanQuestions(body, maxCount) {
  if (!Array.isArray(body.questions) || body.questions.length === 0) return null;
  const cleaned = validateQuestions(body.questions, maxCount);
  return cleaned.length === body.questions.length ? cleaned : null;
}

app.put("/api/units/:id/modules/:moduleId/quiz", async (req, res, next) => {
  try {
    const questions = cleanQuestions(req.body, 50);
    if (!questions) {
      return res.status(400).json({ error: "Every question needs text, exactly 4 non-empty options, and a correct answer." });
    }
    const title = typeof req.body.title === "string" && req.body.title.trim() ? req.body.title.trim() : null;

    const unit = await updateUnit(req.params.id, (u) => {
      const mod = u.modules.find((m) => m.id === req.params.moduleId);
      if (!mod) return false;
      mod.quiz = questions;
      if (title) mod.title = title;
    });
    if (!unit) return res.status(404).json({ error: "Unit or module not found." });
    res.json(unit);
  } catch (err) {
    next(err);
  }
});

app.put("/api/units/:id/unit-test", async (req, res, next) => {
  try {
    const questions = cleanQuestions(req.body, 50);
    if (!questions) {
      return res.status(400).json({ error: "Every question needs text, exactly 4 non-empty options, and a correct answer." });
    }
    const title = typeof req.body.title === "string" && req.body.title.trim() ? req.body.title.trim() : null;

    const unit = await updateUnit(req.params.id, (u) => {
      u.unitTest = questions;
      if (title) u.title = title;
    });
    if (!unit) return res.status(404).json({ error: "Unit not found." });
    res.json(unit);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Progress (best scores, completed activities)
// ---------------------------------------------------------------------------

app.post("/api/units/:id/progress", async (req, res, next) => {
  try {
    const { kind, moduleId, score, activityId } = req.body || {};

    const unit = await updateUnit(req.params.id, (u) => {
      if (kind === "unitTest" && Number.isFinite(score)) {
        u.progress = u.progress || {};
        u.progress.unitTestBest = Math.max(u.progress.unitTestBest ?? 0, Math.round(score));
        return;
      }
      const mod = u.modules.find((m) => m.id === moduleId);
      if (!mod) return false;
      mod.progress = mod.progress || { quizBest: null, activitiesDone: [] };
      if (kind === "moduleQuiz" && Number.isFinite(score)) {
        mod.progress.quizBest = Math.max(mod.progress.quizBest ?? 0, Math.round(score));
        return;
      }
      if (kind === "activity" && typeof activityId === "string") {
        if (!mod.progress.activitiesDone.includes(activityId)) mod.progress.activitiesDone.push(activityId);
        return;
      }
      return false;
    });

    if (!unit) return res.status(404).json({ error: "Unit, module, or progress kind not found." });
    res.json(unit);
  } catch (err) {
    next(err);
  }
});

// Multer and JSON-body errors arrive here.
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const message =
      err.code === "LIMIT_FILE_SIZE"
        ? "A file exceeded the 50MB limit."
        : err.code === "LIMIT_FILE_COUNT"
          ? "Too many files — upload at most 12 at once."
          : err.message;
    return res.status(400).json({ error: message });
  }
  console.error(err);
  res.status(500).json({ error: "Something went wrong on the server." });
});

app.listen(PORT, () => {
  console.log(`StudyForge running at http://localhost:${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn("WARNING: ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add your key.");
  }
});
