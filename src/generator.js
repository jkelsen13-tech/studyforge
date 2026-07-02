import Anthropic from "@anthropic-ai/sdk";
import heicConvert from "heic-convert";
import sharp from "sharp";
import { randomUUID } from "crypto";

const MODEL = "claude-sonnet-4-6";

// Claude's vision input performs best at or below ~1568px on the long edge,
// and base64 images must stay under the API's 5MB limit.
const MAX_IMAGE_DIMENSION = 1568;
const JPEG_QUALITY = 82;
const MODULE_CONCURRENCY = 3;

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "webp", "heic", "heif"]);

// ---------------------------------------------------------------------------
// File preparation
// ---------------------------------------------------------------------------

function fileExtension(name) {
  return (name || "").split(".").pop().toLowerCase();
}

export function isSupportedFile(file) {
  const ext = fileExtension(file.originalname);
  return (
    ext === "pdf" ||
    IMAGE_EXTENSIONS.has(ext) ||
    file.mimetype === "application/pdf" ||
    file.mimetype?.startsWith("image/")
  );
}

/**
 * Normalize uploads into { kind, name, buffer } entries. Images are converted
 * from HEIC if needed, EXIF-rotated, capped in size, and re-encoded as JPEG
 * (the same bytes are later saved to disk for labeling activities). PDFs pass
 * through untouched.
 */
export async function prepareFiles(files) {
  return Promise.all(
    files.map(async (file) => {
      const ext = fileExtension(file.originalname);

      if (ext === "pdf" || file.mimetype === "application/pdf") {
        return { kind: "pdf", name: file.originalname, buffer: file.buffer };
      }

      let buffer = file.buffer;
      if (ext === "heic" || ext === "heif" || file.mimetype === "image/heic" || file.mimetype === "image/heif") {
        buffer = Buffer.from(await heicConvert({ buffer, format: "JPEG", quality: 0.9 }));
      }

      const normalized = await sharp(buffer)
        .rotate()
        .resize(MAX_IMAGE_DIMENSION, MAX_IMAGE_DIMENSION, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: JPEG_QUALITY })
        .toBuffer();

      return { kind: "image", name: file.originalname, buffer: normalized };
    }),
  );
}

function fileContentBlocks(prepared) {
  const blocks = [];
  prepared.forEach((file, i) => {
    blocks.push({ type: "text", text: `FILE ${i}: ${file.name} (${file.kind})` });
    if (file.kind === "pdf") {
      blocks.push({
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: file.buffer.toString("base64") },
      });
    } else {
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data: file.buffer.toString("base64") },
      });
    }
  });
  return blocks;
}

// ---------------------------------------------------------------------------
// JSON schemas for structured output
// ---------------------------------------------------------------------------

const QUESTION_ITEM = {
  type: "object",
  properties: {
    question: { type: "string" },
    options: { type: "array", items: { type: "string" }, description: "Exactly 4 answer options" },
    correctIndex: { type: "integer", enum: [0, 1, 2, 3] },
    explanation: { type: "string", description: "2-3 sentence explanation of the correct answer" },
  },
  required: ["question", "options", "correctIndex", "explanation"],
  additionalProperties: false,
};

const STRUCTURE_SCHEMA = {
  type: "object",
  properties: {
    units: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          modules: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                summary: { type: "string", description: "1-2 sentence overview of the module" },
                content: {
                  type: "string",
                  description:
                    "Thorough markdown study notes capturing ALL meaningful content from this module's source material",
                },
                labelingActivities: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      fileIndex: { type: "integer", description: "FILE number of the source image" },
                      title: { type: "string" },
                      instructions: { type: "string" },
                      labels: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            text: { type: "string" },
                            x: { type: "number", description: "0-1, fraction of image width" },
                            y: { type: "number", description: "0-1, fraction of image height" },
                          },
                          required: ["text", "x", "y"],
                          additionalProperties: false,
                        },
                      },
                    },
                    required: ["fileIndex", "title", "instructions", "labels"],
                    additionalProperties: false,
                  },
                },
              },
              required: ["title", "summary", "content", "labelingActivities"],
              additionalProperties: false,
            },
          },
        },
        required: ["title", "modules"],
        additionalProperties: false,
      },
    },
  },
  required: ["units"],
  additionalProperties: false,
};

const MODULE_SCHEMA = {
  type: "object",
  properties: {
    quiz: { type: "array", items: QUESTION_ITEM },
    activities: {
      type: "array",
      items: {
        anyOf: [
          {
            type: "object",
            properties: {
              type: { const: "matching" },
              title: { type: "string" },
              instructions: { type: "string" },
              pairs: {
                type: "array",
                items: {
                  type: "object",
                  properties: { left: { type: "string" }, right: { type: "string" } },
                  required: ["left", "right"],
                  additionalProperties: false,
                },
              },
            },
            required: ["type", "title", "instructions", "pairs"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              type: { const: "ordering" },
              title: { type: "string" },
              instructions: { type: "string" },
              items: { type: "array", items: { type: "string" }, description: "Steps in the CORRECT order" },
            },
            required: ["type", "title", "instructions", "items"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              type: { const: "scenario" },
              title: { type: "string" },
              instructions: { type: "string" },
              steps: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    situation: { type: "string" },
                    options: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          text: { type: "string" },
                          isBest: { type: "boolean" },
                          feedback: { type: "string" },
                        },
                        required: ["text", "isBest", "feedback"],
                        additionalProperties: false,
                      },
                    },
                  },
                  required: ["situation", "options"],
                  additionalProperties: false,
                },
              },
            },
            required: ["type", "title", "instructions", "steps"],
            additionalProperties: false,
          },
        ],
      },
    },
  },
  required: ["quiz", "activities"],
  additionalProperties: false,
};

const UNIT_TEST_SCHEMA = {
  type: "object",
  properties: { questions: { type: "array", items: QUESTION_ITEM } },
  required: ["questions"],
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const STRUCTURE_PROMPT = `You are StudyForge, an expert at organizing lecture materials into a course structure. The files above are lecture materials (slide screenshots, PDF slide decks, photos of handwritten notes). Each file is preceded by a marker line "FILE <n>: <name>".

Task 1 — Organize into units and modules:
- A unit is a major course division; a module is one coherent lesson or topic within it.
- Most uploads form ONE unit. Only create multiple units when the material clearly spans separate major divisions. At most 3 units.
- Create 2-8 modules per unit (a single module only if the material genuinely covers one small topic). Preserve the original teaching order.

Task 2 — Extract content per module:
- "content": thorough markdown study notes capturing ALL meaningful content from that module's source material — definitions, processes, formulas, examples, and descriptions of diagrams. Quizzes and exercises are generated from these notes later, so completeness matters more than brevity.
- "summary": 1-2 sentences describing what the module covers.

Task 3 — Propose diagram-labeling activities:
- For modules whose source IMAGE files contain a clear diagram, chart, or figure with visually distinct parts, propose up to 2 labeling activities.
- fileIndex is the FILE number of that image. Only use image files, never PDFs.
- Provide 3-8 labels. Each label's x and y are normalized coordinates (0-1, fractions of image width and height) placed directly ON the part being labeled.
- Only propose a labeling activity when the parts are genuinely distinguishable and labeling them has study value. Otherwise return an empty array for that module.`;

function modulePrompt(unitTitle, moduleTitle, content) {
  return `You are StudyForge. Generate practice material for one module of a course.

Unit: ${unitTitle}
Module: ${moduleTitle}

STUDY NOTES (the only source material — everything must be answerable from these):
${content}

Generate:

1. "quiz" — 8 to 12 multiple-choice questions.
- Exactly 4 options each; exactly one correct, recorded as zero-based correctIndex.
- Distractors plausible but clearly wrong to someone who studied. Vary which position holds the correct answer.
- Each explanation is 2-3 sentences on why the correct answer is right.

2. "activities" — 1 to 3 interactive exercises, choosing only types that genuinely fit this content:
- "matching": 4-8 pairs matching a term (left) to its definition/role/example (right). Keep "right" texts short enough to scan.
- "ordering": 4-8 steps of a process or sequence, listed in the CORRECT order. Only if the content contains a real sequence.
- "scenario": a 2-4 step applied scenario that simulates using what this module teaches (a realistic situation where the learner must apply the concepts). Each step has a "situation" and exactly 3 options; exactly one option has isBest=true. Every option's "feedback" explains in 1-2 sentences why that choice is right or wrong.

Prefer a scenario when the material describes something you *do* or *apply*; prefer matching for vocabulary-heavy material; prefer ordering for processes.`;
}

function unitTestPrompt(unitTitle, modules) {
  const notes = modules.map((m) => `### MODULE: ${m.title}\n${m.content}`).join("\n\n");
  return `You are StudyForge. Generate a comprehensive UNIT TEST for the unit "${unitTitle}" covering all of its modules.

STUDY NOTES BY MODULE:
${notes}

Requirements:
- 20 to 30 multiple-choice questions spanning ALL modules, weighted by how much material each module contains. If the material is thin, write as many high-quality questions as it supports rather than padding.
- Exactly 4 options each; exactly one correct, recorded as zero-based correctIndex. Vary the correct position.
- Distractors plausible but clearly wrong to someone who studied.
- Each explanation is 2-3 sentences.
- Favor questions that connect ideas across modules where the material allows it.`;
}

// ---------------------------------------------------------------------------
// API call + validation helpers
// ---------------------------------------------------------------------------

async function callStructured(client, content, schema, maxTokens) {
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: maxTokens,
    thinking: { type: "adaptive" },
    output_config: { format: { type: "json_schema", schema } },
    messages: [{ role: "user", content }],
  });

  const message = await stream.finalMessage();

  if (message.stop_reason === "refusal") {
    const err = new Error("The model declined to process this material. Try different files.");
    err.status = 422;
    throw err;
  }
  if (message.stop_reason === "max_tokens") {
    const err = new Error("The generated content was too long and got cut off. Try uploading fewer files at once.");
    err.status = 422;
    throw err;
  }

  const text = message.content.find((b) => b.type === "text")?.text;
  if (!text) {
    const err = new Error("The model returned no content. Try again.");
    err.status = 502;
    throw err;
  }
  return JSON.parse(text);
}

export function validateQuestions(questions, max = 30) {
  return (questions || [])
    .filter(
      (q) =>
        typeof q.question === "string" &&
        q.question.trim() &&
        Array.isArray(q.options) &&
        q.options.length === 4 &&
        q.options.every((o) => typeof o === "string" && o.trim()) &&
        Number.isInteger(q.correctIndex) &&
        q.correctIndex >= 0 &&
        q.correctIndex <= 3,
    )
    .slice(0, max)
    .map((q) => ({
      question: q.question.trim(),
      options: q.options.map((o) => o.trim()),
      correctIndex: q.correctIndex,
      explanation: typeof q.explanation === "string" ? q.explanation.trim() : "",
    }));
}

const clamp01 = (n) => Math.min(0.98, Math.max(0.02, n));

function validateLabeling(raw, assetUrls) {
  const image = assetUrls[raw.fileIndex];
  if (!image) return null; // points at a PDF or out-of-range index
  const labels = (raw.labels || [])
    .filter((l) => typeof l.text === "string" && l.text.trim() && Number.isFinite(l.x) && Number.isFinite(l.y))
    .slice(0, 12)
    .map((l) => ({ text: l.text.trim(), x: clamp01(l.x), y: clamp01(l.y) }));
  if (labels.length < 2) return null;
  return {
    id: randomUUID(),
    type: "labeling",
    title: raw.title?.trim() || "Label the diagram",
    instructions: raw.instructions?.trim() || "Match each label to the correct point on the image.",
    image,
    labels,
  };
}

function validateActivity(raw) {
  const base = {
    id: randomUUID(),
    type: raw.type,
    title: (raw.title || "").trim() || "Practice activity",
    instructions: (raw.instructions || "").trim(),
  };

  if (raw.type === "matching") {
    const pairs = (raw.pairs || [])
      .filter((p) => typeof p.left === "string" && p.left.trim() && typeof p.right === "string" && p.right.trim())
      .slice(0, 10)
      .map((p) => ({ left: p.left.trim(), right: p.right.trim() }));
    return pairs.length >= 3 ? { ...base, pairs } : null;
  }

  if (raw.type === "ordering") {
    const items = (raw.items || []).filter((s) => typeof s === "string" && s.trim()).slice(0, 10).map((s) => s.trim());
    return items.length >= 3 ? { ...base, items } : null;
  }

  if (raw.type === "scenario") {
    const steps = (raw.steps || [])
      .map((step) => {
        const options = (step.options || [])
          .filter((o) => typeof o.text === "string" && o.text.trim())
          .slice(0, 4)
          .map((o) => ({
            text: o.text.trim(),
            isBest: o.isBest === true,
            feedback: typeof o.feedback === "string" ? o.feedback.trim() : "",
          }));
        if (options.length < 2 || !options.some((o) => o.isBest)) return null;
        // Guarantee a single best answer per step.
        let seenBest = false;
        for (const o of options) {
          if (o.isBest && seenBest) o.isBest = false;
          if (o.isBest) seenBest = true;
        }
        return typeof step.situation === "string" && step.situation.trim()
          ? { situation: step.situation.trim(), options }
          : null;
      })
      .filter(Boolean)
      .slice(0, 6);
    return steps.length >= 1 ? { ...base, steps } : null;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Run the full generation pipeline:
 *   Stage 1 (vision): segment files into units/modules, extract study notes,
 *     and propose labeling activities on the uploaded images.
 *   Stage 2 (text, parallel per module): module quiz + interactive activities.
 *   Stage 3 (text, per unit): the unit test.
 *
 * @param prepared  output of prepareFiles()
 * @param assetUrls sparse array mapping file index -> served image URL (images only)
 * @param onProgress(phase) progress callback for the job registry
 * @returns array of complete unit objects (without ids/createdAt — store adds those)
 */
export async function generateUnits(prepared, assetUrls, onProgress = () => {}) {
  if (!process.env.ANTHROPIC_API_KEY) {
    const err = new Error("ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add your key.");
    err.status = 500;
    throw err;
  }
  const client = new Anthropic();

  onProgress("Reading your materials and mapping units & modules…");
  const structure = await callStructured(
    client,
    [...fileContentBlocks(prepared), { type: "text", text: STRUCTURE_PROMPT }],
    STRUCTURE_SCHEMA,
    32000,
  );

  const rawUnits = (structure.units || [])
    .filter((u) => typeof u.title === "string" && Array.isArray(u.modules) && u.modules.length > 0)
    .slice(0, 3);

  if (rawUnits.length === 0) {
    const err = new Error("No course structure could be extracted from the uploaded material.");
    err.status = 422;
    throw err;
  }

  const totalModules = rawUnits.reduce((n, u) => n + Math.min(u.modules.length, 8), 0);
  let builtModules = 0;

  const units = [];
  for (const rawUnit of rawUnits) {
    const rawModules = rawUnit.modules.slice(0, 8);

    const modules = await mapWithConcurrency(rawModules, MODULE_CONCURRENCY, async (rawModule) => {
      onProgress(`Building module ${Math.min(builtModules + 1, totalModules)} of ${totalModules}: ${rawModule.title}`);
      const generated = await callStructured(
        client,
        [{ type: "text", text: modulePrompt(rawUnit.title, rawModule.title, rawModule.content) }],
        MODULE_SCHEMA,
        16000,
      );
      builtModules++;

      const labeling = (rawModule.labelingActivities || [])
        .slice(0, 2)
        .map((l) => validateLabeling(l, assetUrls))
        .filter(Boolean);
      const interactive = (generated.activities || []).map(validateActivity).filter(Boolean);

      return {
        id: randomUUID(),
        title: rawModule.title.trim(),
        summary: (rawModule.summary || "").trim(),
        content: rawModule.content || "",
        quiz: validateQuestions(generated.quiz, 15),
        activities: [...labeling, ...interactive],
        progress: { quizBest: null, activitiesDone: [] },
      };
    });

    onProgress(`Writing the unit test for “${rawUnit.title}”…`);
    const test = await callStructured(
      client,
      [{ type: "text", text: unitTestPrompt(rawUnit.title, modules) }],
      UNIT_TEST_SCHEMA,
      32000,
    );

    units.push({
      title: rawUnit.title.trim(),
      modules,
      unitTest: validateQuestions(test.questions, 30),
      progress: { unitTestBest: null },
    });
  }

  return units;
}
