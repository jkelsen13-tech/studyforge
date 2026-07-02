import { randomUUID } from "crypto";

// In-memory registry for long-running generation jobs. The frontend polls
// GET /api/jobs/:id while the multi-stage pipeline runs.
const jobs = new Map();
const JOB_TTL_MS = 60 * 60 * 1000;

function prune() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.startedAt > JOB_TTL_MS) jobs.delete(id);
  }
}

export function createJob() {
  prune();
  const job = {
    id: randomUUID(),
    status: "running", // running | done | error
    phase: "Uploading files…",
    startedAt: Date.now(),
    unitIds: [],
    error: null,
  };
  jobs.set(job.id, job);
  return job;
}

export function getJob(id) {
  return jobs.get(id) || null;
}

export function updateJob(id, patch) {
  const job = jobs.get(id);
  if (job) Object.assign(job, patch);
  return job;
}
