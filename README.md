# StudyForge ⚒

Upload lecture slides, PDFs, or handwritten notes and StudyForge organizes them into study units with quizzes, unit tests, and interactive exercises — all generated from your own material.

## What it does

1. **Upload** one or more files — phone screenshots of slides (JPG/PNG/HEIC), PDF slide decks, or photos of handwritten notes.
2. **Auto-organize** — Claude (claude-sonnet-4-6) reads everything with vision and splits the material into **units and modules**, preserving the original teaching order and extracting thorough study notes per module.
3. **Practice per module** — each module gets:
   - a **module quiz** (8–12 multiple-choice questions with explanations), fully editable before or after you take it;
   - **interactive activities** built from the material:
     - 🏷️ **Labeling** — label the actual diagrams from your uploaded slides by placing terms onto numbered points on the image
     - 🔗 **Matching** — pair terms with their definitions
     - 🔀 **Ordering** — put the steps of a process in the right sequence
     - 🎮 **Scenario** — a step-by-step simulation where you apply what the slides explain and get feedback on each decision
4. **Unit test** — every unit gets a 20–30 question test spanning all its modules.
5. **Track progress** — best scores per module quiz and unit test, plus checkmarks on completed activities.

Quizzes and tests run DMV-style: one question at a time, instant green/red feedback, explanations on wrong answers, a live score, and a results screen listing every missed question.

Everything is saved locally (`data/units.json` + slide images in `data/assets/`), so you can retake, edit, and keep studying later.

## Setup

Requires Node.js 18+.

```bash
npm install
cp .env.example .env   # then put your Anthropic API key in .env
npm start
```

Open http://localhost:3000.

Your API key lives only in `.env` (`ANTHROPIC_API_KEY=...`), which is gitignored — never commit it or hardcode it.

## How generation works

Generation runs as a background job with live progress in the UI:

1. **Structure pass (vision)** — all files go to Claude in one request; it maps units/modules, writes complete study notes per module, and proposes diagram-labeling activities with normalized coordinates on your uploaded images.
2. **Module passes (parallel)** — each module's notes are turned into a quiz plus matching/ordering/scenario activities suited to the content.
3. **Unit test pass** — a comprehensive test is written across all module notes.

All model output is constrained with structured JSON schemas and validated server-side.

## Tech

- **Backend:** Node.js + Express, `@anthropic-ai/sdk` (streaming + structured JSON output), `multer` for uploads, `sharp` for image normalization, `heic-convert` for iPhone HEIC photos.
- **Frontend:** dependency-free vanilla JS single-page app served from `public/`.
- **Storage:** flat JSON file + saved slide images — no database needed.

## API

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/api/units/generate` | Multipart upload (`files`) → `{ jobId }`; pipeline runs async |
| `GET` | `/api/jobs/:id` | Poll generation progress (`status`, `phase`, `unitIds`) |
| `GET` | `/api/units` | List saved units |
| `GET` | `/api/units/:id` | Fetch one unit (modules, quizzes, activities, unit test) |
| `DELETE` | `/api/units/:id` | Delete a unit |
| `PUT` | `/api/units/:id/modules/:moduleId/quiz` | Edit a module's quiz (and title) |
| `PUT` | `/api/units/:id/unit-test` | Edit the unit test (and unit title) |
| `POST` | `/api/units/:id/progress` | Record best quiz/test scores and completed activities |
