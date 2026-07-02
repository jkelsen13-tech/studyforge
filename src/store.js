import { promises as fs } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
const DATA_FILE = path.join(DATA_DIR, "units.json");

export const ASSETS_DIR = path.join(DATA_DIR, "assets");

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

async function writeAll(units) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${DATA_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(units, null, 2));
  await fs.rename(tmp, DATA_FILE);
}

function withLock(fn) {
  const run = writeLock.then(fn);
  writeLock = run.catch(() => {});
  return run;
}

export async function listUnits() {
  const units = await readAll();
  return units
    .map((u) => ({
      id: u.id,
      title: u.title,
      moduleCount: u.modules.length,
      unitTestCount: u.unitTest.length,
      activityCount: u.modules.reduce((n, m) => n + m.activities.length, 0),
      unitTestBest: u.progress?.unitTestBest ?? null,
      createdAt: u.createdAt,
    }))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function getUnit(id) {
  const units = await readAll();
  return units.find((u) => u.id === id) || null;
}

export function createUnit(unit) {
  return withLock(async () => {
    const units = await readAll();
    const record = { id: randomUUID(), createdAt: new Date().toISOString(), ...unit };
    units.push(record);
    await writeAll(units);
    return record;
  });
}

export function deleteUnit(id) {
  return withLock(async () => {
    const units = await readAll();
    const next = units.filter((u) => u.id !== id);
    if (next.length === units.length) return false;
    await writeAll(next);
    return true;
  });
}

/** Apply mutate(unit) to one unit and persist. Returns the unit or null. */
export function updateUnit(id, mutate) {
  return withLock(async () => {
    const units = await readAll();
    const unit = units.find((u) => u.id === id);
    if (!unit) return null;
    const result = mutate(unit);
    if (result === false) return null; // mutation aborted (e.g. module not found)
    await writeAll(units);
    return unit;
  });
}
