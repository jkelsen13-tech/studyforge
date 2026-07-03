import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "crypto";

const MODEL = "claude-sonnet-4-6";

export const LEVEL_NAMES = ["Recognition", "Light cued recall", "Deep cued recall", "Free recall", "Transfer"];
export const MAX_LEVEL = 4;

// ---------------------------------------------------------------------------
// The question engine system prompt (GENERATE + GRADE modes)
// ---------------------------------------------------------------------------

const ENGINE_SYSTEM = `You are the question engine for a spaced-recall learning app. You operate in two modes: GENERATE and GRADE. The calling app specifies which mode to run and provides the relevant inputs.

BACKGROUND — LEARNER MODES

Learners fall on a spectrum between two cognitive modes:

- Group 1 learners retain information primarily through repetition and pattern recognition. They can correctly recall and apply material without necessarily holding a causal/mechanistic model of why it's true. They benefit from scaffolded retrieval — cues, partial structure, recognizable formats — before being asked to generate answers unscaffolded.

- Group 2 learners retain information by building an understanding of the underlying structure first. Memorization without comprehension feels unstable to them and doesn't stick. They benefit from being pushed to free recall and transfer questions quickly, since scaffolding can feel like busywork once the concept is understood.

Neither mode is superior — they're different retrieval architectures, and most learners sit somewhere on a spectrum rather than purely one or the other. You do not need to guess which type a learner is. The app tracks a mastery LEVEL (0-4) per learner per concept and moves learners between levels based on performance. Your job is to generate the right question for a given level, and grade the response accurately.

MODE: GENERATE
Input: source material (text), a FOCUS CONCEPT within it, LEVEL (0-4).
Generate ONE question about the focus concept at the specified difficulty:

LEVEL 0 (recognition): Multiple choice, exactly 4 options, 1 correct. Distractors should be plausible misconceptions, not random. correct_answer must be the exact text of the correct option.

LEVEL 1 (light cued recall): Fill-in-the-blank. Reproduce a key sentence from the material with ONE term blanked out as "_____". correct_answer is the blanked term.

LEVEL 2 (heavy cued recall): Fill-in-the-blank. Reproduce a key sentence with the DEFINING PHRASE or explanation blanked out as "_____", not just a single term. correct_answer is the blanked phrase.

LEVEL 3 (free recall): Open-ended prompt starting with "Explain," "Describe," or "What is the relationship between." No scaffold. The learner must type a response in their own words.

LEVEL 4 (transfer): Present a NEW scenario not found in the source material and ask the learner to apply the concept to it.

For levels 1-4, options must be null. grading_notes must describe what a correct answer needs to contain conceptually — it gets passed back to you in GRADE mode.

MODE: GRADE
Input: original prompt, grading_notes, learner's typed response, LEVEL.

For LEVEL 0-2 (multiple-choice, fill-in-blank): grade for exact or near-exact match (allow minor spelling/typo variance and trivial word-order differences, no semantic leniency — these formats have a single correct answer).

For LEVEL 3-4 (free recall, transfer): grade for MEANING, not string match. The learner's wording will not match the source material. Check whether the response demonstrates the causal/mechanistic understanding described in grading_notes, not whether it repeats specific phrasing. A correct answer in different words is CORRECT. A fluent answer that misses the actual mechanism is INCORRECT — do not reward confident phrasing over accuracy.

level_change logic: "up" if correct, "down" if incorrect (never drop more than one level per miss), "stay" only if the response is partially correct/ambiguous. Keep feedback to 1-3 sentences: say what was right, and name what was missing or wrong.`;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const CONCEPTS_SCHEMA = {
  type: "object",
  properties: {
    concepts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "Short concept name, 2-6 words" },
          description: { type: "string", description: "One sentence stating what this concept is" },
        },
        required: ["name", "description"],
        additionalProperties: false,
      },
    },
  },
  required: ["concepts"],
  additionalProperties: false,
};

const GENERATE_SCHEMA = {
  type: "object",
  properties: {
    mode: { const: "generate" },
    level: { type: "integer", enum: [0, 1, 2, 3, 4] },
    prompt: { type: "string" },
    options: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }] },
    correct_answer: { type: "string" },
    grading_notes: { type: "string" },
  },
  required: ["mode", "level", "prompt", "options", "correct_answer", "grading_notes"],
  additionalProperties: false,
};

const GRADE_SCHEMA = {
  type: "object",
  properties: {
    mode: { const: "grade" },
    correct: { type: "boolean" },
    feedback: { type: "string" },
    level_change: { type: "string", enum: ["up", "down", "stay"] },
  },
  required: ["mode", "correct", "feedback", "level_change"],
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

function requireKey() {
  if (!process.env.ANTHROPIC_API_KEY) {
    const err = new Error("ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add your key.");
    err.status = 500;
    throw err;
  }
}

async function callEngine(userText, schema, { system = ENGINE_SYSTEM, maxTokens = 4000 } = {}) {
  requireKey();
  const client = new Anthropic();
  const message = await client.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    thinking: { type: "adaptive" },
    system,
    output_config: { format: { type: "json_schema", schema } },
    messages: [{ role: "user", content: userText }],
  });

  if (message.stop_reason === "refusal" || message.stop_reason === "max_tokens") {
    const err = new Error("The question engine could not produce a response. Try again.");
    err.status = 502;
    throw err;
  }
  const text = message.content.find((b) => b.type === "text")?.text;
  if (!text) {
    const err = new Error("The question engine returned no content. Try again.");
    err.status = 502;
    throw err;
  }
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------
// Concept extraction (lazy, once per module)
// ---------------------------------------------------------------------------

export async function extractConcepts(moduleTitle, content) {
  const result = await callEngine(
    `Extract the most important discrete concepts a learner must master from this study material (module: "${moduleTitle}"). Return 3-8 concepts. Each concept must be specific enough to write questions about on its own.\n\nSTUDY MATERIAL:\n${content}`,
    CONCEPTS_SCHEMA,
    { system: "You identify the key concepts in study material for a spaced-recall learning app." },
  );

  const concepts = (result.concepts || [])
    .filter((c) => typeof c.name === "string" && c.name.trim())
    .slice(0, 8)
    .map((c) => ({
      id: randomUUID(),
      name: c.name.trim(),
      description: (c.description || "").trim(),
      level: 0,
      attempts: 0,
      lastPracticed: null,
    }));

  if (concepts.length === 0) {
    const err = new Error("No concepts could be extracted from this module.");
    err.status = 422;
    throw err;
  }
  return concepts;
}

// ---------------------------------------------------------------------------
// GENERATE
// ---------------------------------------------------------------------------

export async function generateQuestion({ content, conceptName, level }) {
  const q = await callEngine(
    `MODE: GENERATE\nLEVEL: ${level}\nFOCUS CONCEPT: ${conceptName}\n\nSOURCE MATERIAL:\n${content}`,
    GENERATE_SCHEMA,
  );

  if (typeof q.prompt !== "string" || !q.prompt.trim() || typeof q.correct_answer !== "string") {
    const err = new Error("The question engine returned a malformed question. Try again.");
    err.status = 502;
    throw err;
  }
  const options =
    level === 0 && Array.isArray(q.options)
      ? q.options.filter((o) => typeof o === "string" && o.trim()).slice(0, 4)
      : null;
  if (level === 0 && (!options || options.length < 2 || !options.includes(q.correct_answer))) {
    const err = new Error("The question engine returned unusable options. Try again.");
    err.status = 502;
    throw err;
  }

  return {
    prompt: q.prompt.trim(),
    options,
    correctAnswer: q.correct_answer,
    gradingNotes: q.grading_notes || "",
  };
}

// ---------------------------------------------------------------------------
// GRADE
// ---------------------------------------------------------------------------

function normalize(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const row = [i];
    for (let j = 1; j <= n; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[n];
}

/**
 * Levels 0-1 have a single short correct answer, so they're graded locally
 * (exact/near-exact match with typo tolerance — the engine spec allows no
 * semantic leniency there anyway). Levels 2-4 go to GRADE mode: level 2
 * because reproducing a whole phrase needs judgment about word order, and
 * levels 3-4 because they're graded on meaning.
 */
export async function gradeResponse({ level, prompt, correctAnswer, gradingNotes, response }) {
  if (level <= 1) {
    const want = normalize(correctAnswer);
    const got = normalize(response);
    const tolerance = level === 0 ? 0 : Math.min(3, Math.max(1, Math.floor(want.length * 0.2)));
    const correct = got === want || (tolerance > 0 && levenshtein(got, want) <= tolerance);
    return {
      correct,
      feedback: correct
        ? `Correct — "${correctAnswer}".`
        : `Not quite. The correct answer is "${correctAnswer}".`,
      levelChange: correct ? "up" : "down",
    };
  }

  const result = await callEngine(
    `MODE: GRADE\nLEVEL: ${level}\n\nORIGINAL PROMPT:\n${prompt}\n\nGRADING NOTES (what a correct answer must contain):\n${gradingNotes}\n\nREFERENCE ANSWER (for levels 0-2 string matching; context only for 3-4):\n${correctAnswer}\n\nLEARNER'S RESPONSE:\n${response}`,
    GRADE_SCHEMA,
  );

  return {
    correct: result.correct === true,
    feedback: (result.feedback || "").trim() || (result.correct ? "Correct." : "Incorrect."),
    levelChange: ["up", "down", "stay"].includes(result.level_change) ? result.level_change : result.correct ? "up" : "down",
  };
}

export function applyLevelChange(level, change) {
  if (change === "up") return Math.min(MAX_LEVEL, level + 1);
  if (change === "down") return Math.max(0, level - 1);
  return level;
}

// ---------------------------------------------------------------------------
// Pending-question registry (answers are validated against server-held keys
// so the correct answer never reaches the client before grading)
// ---------------------------------------------------------------------------

const pending = new Map();
const PENDING_TTL_MS = 30 * 60 * 1000;

function prunePending() {
  const now = Date.now();
  for (const [id, q] of pending) {
    if (now - q.createdAt > PENDING_TTL_MS) pending.delete(id);
  }
}

export function stashQuestion(question) {
  prunePending();
  const id = randomUUID();
  pending.set(id, { ...question, createdAt: Date.now() });
  return id;
}

export function takeQuestion(id) {
  const q = pending.get(id) || null;
  if (q) pending.delete(id);
  return q;
}

// ---------------------------------------------------------------------------
// Concept selection: lowest level first, then least recently practiced
// ---------------------------------------------------------------------------

export function selectConcept(concepts) {
  return [...concepts].sort((a, b) => {
    if (a.level !== b.level) return a.level - b.level;
    const at = a.lastPracticed || "";
    const bt = b.lastPracticed || "";
    return at < bt ? -1 : at > bt ? 1 : 0;
  })[0];
}
