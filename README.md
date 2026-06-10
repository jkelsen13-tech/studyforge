# StudyForge ⚒

Upload lecture slides, PDFs, or handwritten notes and auto-generate editable practice quizzes with instant feedback and explanations.

## What it does

1. **Upload** one or more files — phone screenshots of slides (JPG/PNG/HEIC), PDF slide decks, or photos of handwritten notes.
2. **Generate** — Claude (claude-sonnet-4-6) reads every file with vision and writes 20–30 multiple-choice questions, each with 4 options, a correct answer, and a 2–3 sentence explanation.
3. **Review & edit** — before the quiz is saved, edit any question or option, change the correct answer, delete questions, or add your own.
4. **Take the quiz** — one question at a time with instant green/red feedback, explanations on wrong answers, a live score, and a results screen listing every missed question with the correct answer and explanation.

Quizzes are saved locally (in `data/quizzes.json`) so you can retake or edit them later.

## Setup

Requires Node.js 18+.

```bash
npm install
cp .env.example .env   # then put your Anthropic API key in .env
npm start
```

Open http://localhost:3000.

Your API key lives only in `.env` (`ANTHROPIC_API_KEY=...`), which is gitignored — never commit it or hardcode it.

## Tech

- **Backend:** Node.js + Express, `@anthropic-ai/sdk` (streaming + structured JSON output), `multer` for uploads, `sharp` for image normalization, `heic-convert` for iPhone HEIC photos.
- **Frontend:** dependency-free vanilla JS single-page app served from `public/`.
- **Storage:** flat JSON file — no database needed.

## API

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/api/generate` | Multipart upload (`files`) → draft quiz JSON (not saved) |
| `GET` | `/api/quizzes` | List saved quizzes |
| `POST` | `/api/quizzes` | Save a quiz |
| `GET` | `/api/quizzes/:id` | Fetch one quiz |
| `PUT` | `/api/quizzes/:id` | Update a quiz |
| `DELETE` | `/api/quizzes/:id` | Delete a quiz |
