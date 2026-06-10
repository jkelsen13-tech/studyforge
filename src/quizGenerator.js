import Anthropic from "@anthropic-ai/sdk";
import heicConvert from "heic-convert";
import sharp from "sharp";

const MODEL = "claude-sonnet-4-6";

// Claude's vision input performs best at or below ~1568px on the long edge,
// and base64 images must stay under the API's 5MB limit.
const MAX_IMAGE_DIMENSION = 1568;
const JPEG_QUALITY = 82;

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "webp", "heic", "heif"]);

const QUIZ_SCHEMA = {
  type: "object",
  properties: {
    title: {
      type: "string",
      description: "A short, descriptive title for the quiz based on the material's topic",
    },
    questions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          question: { type: "string" },
          options: {
            type: "array",
            items: { type: "string" },
            description: "Exactly 4 answer options",
          },
          correctIndex: {
            type: "integer",
            enum: [0, 1, 2, 3],
            description: "Zero-based index of the correct option",
          },
          explanation: {
            type: "string",
            description: "A 2-3 sentence explanation of why the correct answer is right",
          },
        },
        required: ["question", "options", "correctIndex", "explanation"],
        additionalProperties: false,
      },
    },
  },
  required: ["title", "questions"],
  additionalProperties: false,
};

const GENERATION_PROMPT = `You are StudyForge, an expert at turning lecture materials into practice quizzes.

First, carefully read and extract ALL meaningful content from every uploaded file above — slide text, diagrams, definitions, formulas, examples, and handwritten notes. Then generate a multiple-choice practice quiz from that content.

Requirements:
- Generate between 20 and 30 questions. Cover the material broadly; if the material is thin, write as many high-quality questions as it supports (still aiming for 20+) rather than padding with questions the material cannot answer.
- Every question must have exactly 4 answer options.
- Exactly one option is correct; record its zero-based index in correctIndex.
- Distractors must be plausible but clearly wrong to someone who studied the material.
- Vary which option position holds the correct answer.
- Each explanation must be 2-3 sentences explaining why the correct answer is right (and, where useful, why the tempting distractor is wrong).
- Questions must be answerable from the uploaded material alone. Test understanding, not trivia about slide formatting.
- Write a concise quiz title that reflects the subject matter.`;

function fileExtension(name) {
  return (name || "").split(".").pop().toLowerCase();
}

export function isSupportedFile(file) {
  const ext = fileExtension(file.originalname);
  return ext === "pdf" || IMAGE_EXTENSIONS.has(ext) || file.mimetype === "application/pdf" || file.mimetype?.startsWith("image/");
}

async function toContentBlock(file) {
  const ext = fileExtension(file.originalname);

  if (ext === "pdf" || file.mimetype === "application/pdf") {
    return {
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: file.buffer.toString("base64"),
      },
    };
  }

  let buffer = file.buffer;
  if (ext === "heic" || ext === "heif" || file.mimetype === "image/heic" || file.mimetype === "image/heif") {
    buffer = Buffer.from(await heicConvert({ buffer, format: "JPEG", quality: 0.9 }));
  }

  // Normalize every image: apply EXIF rotation, cap dimensions, re-encode as
  // JPEG so phone photos reliably fit under the API's per-image size limit.
  const normalized = await sharp(buffer)
    .rotate()
    .resize(MAX_IMAGE_DIMENSION, MAX_IMAGE_DIMENSION, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer();

  return {
    type: "image",
    source: {
      type: "base64",
      media_type: "image/jpeg",
      data: normalized.toString("base64"),
    },
  };
}

function validateQuestions(questions) {
  return questions
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
    .slice(0, 30)
    .map((q) => ({
      question: q.question.trim(),
      options: q.options.map((o) => o.trim()),
      correctIndex: q.correctIndex,
      explanation: typeof q.explanation === "string" ? q.explanation.trim() : "",
    }));
}

export async function generateQuiz(files) {
  if (!process.env.ANTHROPIC_API_KEY) {
    const err = new Error("ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add your key.");
    err.status = 500;
    throw err;
  }

  const client = new Anthropic();

  const fileBlocks = await Promise.all(files.map(toContentBlock));

  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 32000,
    thinking: { type: "adaptive" },
    output_config: { format: { type: "json_schema", schema: QUIZ_SCHEMA } },
    messages: [
      {
        role: "user",
        content: [...fileBlocks, { type: "text", text: GENERATION_PROMPT }],
      },
    ],
  });

  const message = await stream.finalMessage();

  if (message.stop_reason === "refusal") {
    const err = new Error("The model declined to process this material. Try different files.");
    err.status = 422;
    throw err;
  }
  if (message.stop_reason === "max_tokens") {
    const err = new Error("The generated quiz was too long and got cut off. Try uploading fewer files at once.");
    err.status = 422;
    throw err;
  }

  const text = message.content.find((b) => b.type === "text")?.text;
  if (!text) {
    const err = new Error("The model returned no quiz content. Try again.");
    err.status = 502;
    throw err;
  }

  const parsed = JSON.parse(text);
  const questions = validateQuestions(parsed.questions || []);

  if (questions.length === 0) {
    const err = new Error("No usable questions could be generated from the uploaded material.");
    err.status = 422;
    throw err;
  }

  return {
    title: typeof parsed.title === "string" && parsed.title.trim() ? parsed.title.trim() : "Practice Quiz",
    questions,
  };
}
