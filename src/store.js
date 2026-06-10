import { promises as fs } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
const DATA_FILE = path.join(DATA_DIR, "quizzes.json");

// Serialize writes so concurrent requests can't interleave read-modify-write.
let writeLock = Promise.resolve();

async function readAll() {
  try {
    return JSON.parse(await fs.readFile(DATA_FILE, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

async function writeAll(quizzes) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${DATA_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(quizzes, null, 2));
  await fs.rename(tmp, DATA_FILE);
}

function withLock(fn) {
  const run = writeLock.then(fn);
  writeLock = run.catch(() => {});
  return run;
}

export async function listQuizzes() {
  const quizzes = await readAll();
  return quizzes
    .map(({ id, title, questions, createdAt }) => ({
      id,
      title,
      questionCount: questions.length,
      createdAt,
    }))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function getQuiz(id) {
  const quizzes = await readAll();
  return quizzes.find((q) => q.id === id) || null;
}

export function createQuiz({ title, questions }) {
  return withLock(async () => {
    const quizzes = await readAll();
    const quiz = {
      id: randomUUID(),
      title,
      questions,
      createdAt: new Date().toISOString(),
    };
    quizzes.push(quiz);
    await writeAll(quizzes);
    return quiz;
  });
}

export function updateQuiz(id, { title, questions }) {
  return withLock(async () => {
    const quizzes = await readAll();
    const quiz = quizzes.find((q) => q.id === id);
    if (!quiz) return null;
    quiz.title = title;
    quiz.questions = questions;
    await writeAll(quizzes);
    return quiz;
  });
}

export function deleteQuiz(id) {
  return withLock(async () => {
    const quizzes = await readAll();
    const next = quizzes.filter((q) => q.id !== id);
    if (next.length === quizzes.length) return false;
    await writeAll(next);
    return true;
  });
}
