import "dotenv/config";
import express from "express";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
import Anthropic from "@anthropic-ai/sdk";

import { generateQuiz, isSupportedFile } from "./src/quizGenerator.js";
import { listQuizzes, getQuiz, createQuiz, updateQuiz, deleteQuiz } from "./src/store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 12 },
});

app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname, "public")));

function validateQuizBody(body) {
  if (!body || typeof body.title !== "string" || !body.title.trim()) {
    return "Quiz needs a title.";
  }
  if (!Array.isArray(body.questions) || body.questions.length === 0) {
    return "Quiz needs at least one question.";
  }
  for (const q of body.questions) {
    if (typeof q.question !== "string" || !q.question.trim()) return "Every question needs text.";
    if (!Array.isArray(q.options) || q.options.length !== 4) return "Every question needs exactly 4 options.";
    if (q.options.some((o) => typeof o !== "string" || !o.trim())) return "Answer options cannot be empty.";
    if (!Number.isInteger(q.correctIndex) || q.correctIndex < 0 || q.correctIndex > 3) {
      return "Every question needs a correct answer selected.";
    }
    if (typeof q.explanation !== "string") return "Explanations must be text.";
  }
  return null;
}

function sanitizeQuizBody(body) {
  return {
    title: body.title.trim(),
    questions: body.questions.map((q) => ({
      question: q.question.trim(),
      options: q.options.map((o) => o.trim()),
      correctIndex: q.correctIndex,
      explanation: (q.explanation || "").trim(),
    })),
  };
}

// Generate a draft quiz from uploaded files (not saved until the user confirms).
app.post("/api/generate", upload.array("files"), async (req, res) => {
  try {
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

    const draft = await generateQuiz(files);
    res.json(draft);
  } catch (err) {
    console.error("Quiz generation failed:", err);
    if (err instanceof Anthropic.AuthenticationError) {
      return res.status(500).json({ error: "Invalid ANTHROPIC_API_KEY. Check your .env file." });
    }
    if (err instanceof Anthropic.RateLimitError) {
      return res.status(429).json({ error: "Rate limited by the Claude API. Wait a minute and try again." });
    }
    if (err instanceof Anthropic.APIError) {
      return res.status(502).json({ error: `Claude API error: ${err.message}` });
    }
    res.status(err.status || 500).json({ error: err.message || "Quiz generation failed." });
  }
});

app.get("/api/quizzes", async (req, res, next) => {
  try {
    res.json(await listQuizzes());
  } catch (err) {
    next(err);
  }
});

app.post("/api/quizzes", async (req, res, next) => {
  try {
    const error = validateQuizBody(req.body);
    if (error) return res.status(400).json({ error });
    res.status(201).json(await createQuiz(sanitizeQuizBody(req.body)));
  } catch (err) {
    next(err);
  }
});

app.get("/api/quizzes/:id", async (req, res, next) => {
  try {
    const quiz = await getQuiz(req.params.id);
    if (!quiz) return res.status(404).json({ error: "Quiz not found." });
    res.json(quiz);
  } catch (err) {
    next(err);
  }
});

app.put("/api/quizzes/:id", async (req, res, next) => {
  try {
    const error = validateQuizBody(req.body);
    if (error) return res.status(400).json({ error });
    const quiz = await updateQuiz(req.params.id, sanitizeQuizBody(req.body));
    if (!quiz) return res.status(404).json({ error: "Quiz not found." });
    res.json(quiz);
  } catch (err) {
    next(err);
  }
});

app.delete("/api/quizzes/:id", async (req, res, next) => {
  try {
    const removed = await deleteQuiz(req.params.id);
    if (!removed) return res.status(404).json({ error: "Quiz not found." });
    res.status(204).end();
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
