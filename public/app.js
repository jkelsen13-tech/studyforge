/* StudyForge frontend — single-page app with five screens:
   home/upload → generating → review/edit → quiz player → results */

const $ = (id) => document.getElementById(id);

const screens = {
  home: $("screen-home"),
  generating: $("screen-generating"),
  review: $("screen-review"),
  quiz: $("screen-quiz"),
  results: $("screen-results"),
};

function showScreen(name) {
  for (const [key, el] of Object.entries(screens)) {
    el.hidden = key !== name;
  }
  window.scrollTo({ top: 0 });
}

// ---------- State ----------
let selectedFiles = [];          // File objects queued for upload
let draft = null;                // { id?, title, questions } being reviewed/edited
let quiz = null;                 // saved quiz being played
let current = 0;                 // current question index in player
let score = 0;
let answers = [];                // chosen option index per question

// ============================================================
// HOME / UPLOAD
// ============================================================
const dropzone = $("dropzone");
const fileInput = $("file-input");

dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") fileInput.click();
});
fileInput.addEventListener("change", () => {
  addFiles([...fileInput.files]);
  fileInput.value = "";
});

["dragenter", "dragover"].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.add("dragover");
  }),
);
["dragleave", "drop"].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
  }),
);
dropzone.addEventListener("drop", (e) => addFiles([...e.dataTransfer.files]));

const SUPPORTED_RE = /\.(jpe?g|png|heic|heif|pdf)$/i;

function addFiles(files) {
  hideError("upload-error");
  for (const file of files) {
    if (!SUPPORTED_RE.test(file.name)) {
      showError("upload-error", `"${file.name}" is not a supported type. Use JPG, PNG, HEIC, or PDF.`);
      continue;
    }
    if (selectedFiles.some((f) => f.name === file.name && f.size === file.size)) continue;
    if (selectedFiles.length >= 12) {
      showError("upload-error", "You can upload at most 12 files per quiz.");
      break;
    }
    selectedFiles.push(file);
  }
  renderFileList();
}

function renderFileList() {
  const list = $("file-list");
  list.innerHTML = "";
  selectedFiles.forEach((file, i) => {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = file.name;
    const size = document.createElement("span");
    size.className = "file-size";
    size.textContent = formatSize(file.size);
    const remove = document.createElement("button");
    remove.className = "file-remove";
    remove.textContent = "✕";
    remove.title = "Remove file";
    remove.addEventListener("click", () => {
      selectedFiles.splice(i, 1);
      renderFileList();
    });
    li.append(name, size, remove);
    list.appendChild(li);
  });
  $("btn-generate").disabled = selectedFiles.length === 0;
}

function formatSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

$("btn-generate").addEventListener("click", async () => {
  hideError("upload-error");
  showScreen("generating");

  const form = new FormData();
  selectedFiles.forEach((f) => form.append("files", f));

  try {
    const res = await fetch("/api/generate", { method: "POST", body: form });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "Quiz generation failed.");

    draft = { id: null, title: body.title, questions: body.questions };
    selectedFiles = [];
    renderFileList();
    renderReview();
    showScreen("review");
  } catch (err) {
    showScreen("home");
    showError("upload-error", err.message);
  }
});

// ============================================================
// SAVED QUIZZES
// ============================================================
async function loadQuizList() {
  try {
    const res = await fetch("/api/quizzes");
    const quizzes = await res.json();
    const card = $("saved-quizzes-card");
    const list = $("quiz-list");
    list.innerHTML = "";
    card.hidden = quizzes.length === 0;

    for (const q of quizzes) {
      const li = document.createElement("li");

      const info = document.createElement("div");
      const title = document.createElement("div");
      title.textContent = q.title;
      const meta = document.createElement("div");
      meta.className = "quiz-meta";
      meta.textContent = `${q.questionCount} questions · ${new Date(q.createdAt).toLocaleDateString()}`;
      info.append(title, meta);

      const actions = document.createElement("div");
      actions.className = "quiz-item-actions";

      const start = document.createElement("button");
      start.className = "btn btn-primary";
      start.textContent = "Start";
      start.addEventListener("click", () => startSavedQuiz(q.id));

      const edit = document.createElement("button");
      edit.className = "btn btn-secondary";
      edit.textContent = "Edit";
      edit.addEventListener("click", () => editSavedQuiz(q.id));

      const del = document.createElement("button");
      del.className = "btn-danger-link";
      del.textContent = "Delete";
      del.addEventListener("click", async () => {
        if (!confirm(`Delete "${q.title}"?`)) return;
        await fetch(`/api/quizzes/${q.id}`, { method: "DELETE" });
        loadQuizList();
      });

      actions.append(start, edit, del);
      li.append(info, actions);
      list.appendChild(li);
    }
  } catch {
    /* list is non-critical; leave hidden on failure */
  }
}

async function startSavedQuiz(id) {
  const res = await fetch(`/api/quizzes/${id}`);
  if (!res.ok) return;
  quiz = await res.json();
  startQuiz();
}

async function editSavedQuiz(id) {
  const res = await fetch(`/api/quizzes/${id}`);
  if (!res.ok) return;
  const q = await res.json();
  draft = { id: q.id, title: q.title, questions: q.questions };
  renderReview();
  showScreen("review");
}

// ============================================================
// REVIEW & EDIT
// ============================================================
function blankQuestion() {
  return { question: "", options: ["", "", "", ""], correctIndex: 0, explanation: "" };
}

function renderReview() {
  $("quiz-title").value = draft.title;
  $("review-count").textContent = `${draft.questions.length} question${draft.questions.length === 1 ? "" : "s"}`;
  hideError("review-error");

  const container = $("review-questions");
  container.innerHTML = "";
  draft.questions.forEach((q, qi) => container.appendChild(buildQuestionCard(q, qi)));
}

function buildQuestionCard(q, qi) {
  const card = document.createElement("div");
  card.className = "card q-card";

  const number = document.createElement("div");
  number.className = "q-number";
  number.textContent = `Question ${qi + 1}`;
  card.appendChild(number);

  const questionInput = document.createElement("textarea");
  questionInput.value = q.question;
  questionInput.placeholder = "Question text…";
  questionInput.addEventListener("input", () => (q.question = questionInput.value));
  card.appendChild(questionInput);

  const optionInputs = [];
  q.options.forEach((opt, oi) => {
    const row = document.createElement("div");
    row.className = "option-row";

    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = `correct-${qi}`;
    radio.checked = q.correctIndex === oi;
    radio.title = "Mark as correct answer";

    const text = document.createElement("input");
    text.type = "text";
    text.value = opt;
    text.placeholder = `Option ${String.fromCharCode(65 + oi)}`;
    text.classList.toggle("is-correct", q.correctIndex === oi);
    text.addEventListener("input", () => (q.options[oi] = text.value));

    radio.addEventListener("change", () => {
      q.correctIndex = oi;
      optionInputs.forEach((inp, j) => inp.classList.toggle("is-correct", j === oi));
    });

    optionInputs.push(text);
    row.append(radio, text);
    card.appendChild(row);
  });

  const explLabel = document.createElement("label");
  explLabel.className = "field-label explanation-label";
  explLabel.textContent = "Explanation (shown on wrong answers)";
  card.appendChild(explLabel);

  const explInput = document.createElement("textarea");
  explInput.value = q.explanation;
  explInput.placeholder = "Why is the correct answer right?";
  explInput.addEventListener("input", () => (q.explanation = explInput.value));
  card.appendChild(explInput);

  const footer = document.createElement("div");
  footer.className = "q-card-footer";
  const del = document.createElement("button");
  del.className = "btn-danger-link";
  del.textContent = "Delete question";
  del.addEventListener("click", () => {
    draft.questions.splice(qi, 1);
    renderReview();
  });
  footer.appendChild(del);
  card.appendChild(footer);

  return card;
}

$("quiz-title").addEventListener("input", (e) => (draft.title = e.target.value));

$("btn-add-question").addEventListener("click", () => {
  draft.questions.push(blankQuestion());
  renderReview();
  // Scroll to the new (last) question card
  const cards = $("review-questions").children;
  cards[cards.length - 1]?.scrollIntoView({ behavior: "smooth", block: "center" });
});

function validateDraft() {
  if (!draft.title.trim()) return "Give your quiz a title.";
  if (draft.questions.length === 0) return "Your quiz needs at least one question.";
  for (let i = 0; i < draft.questions.length; i++) {
    const q = draft.questions[i];
    if (!q.question.trim()) return `Question ${i + 1} is missing its text.`;
    if (q.options.some((o) => !o.trim())) return `Question ${i + 1} has an empty answer option.`;
  }
  return null;
}

async function persistDraft() {
  const error = validateDraft();
  if (error) {
    showError("review-error", error);
    return null;
  }
  hideError("review-error");

  const payload = { title: draft.title.trim(), questions: draft.questions };
  const res = await fetch(draft.id ? `/api/quizzes/${draft.id}` : "/api/quizzes", {
    method: draft.id ? "PUT" : "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  if (!res.ok) {
    showError("review-error", body.error || "Failed to save quiz.");
    return null;
  }
  draft.id = body.id;
  return body;
}

$("btn-save-quiz").addEventListener("click", async () => {
  const saved = await persistDraft();
  if (saved) {
    await loadQuizList();
    showScreen("home");
  }
});

$("btn-launch-quiz").addEventListener("click", async () => {
  const saved = await persistDraft();
  if (saved) {
    quiz = saved;
    loadQuizList();
    startQuiz();
  }
});

// ============================================================
// QUIZ PLAYER
// ============================================================
function startQuiz() {
  current = 0;
  score = 0;
  answers = new Array(quiz.questions.length).fill(null);
  renderQuestion();
  showScreen("quiz");
}

function renderQuestion() {
  const total = quiz.questions.length;
  const q = quiz.questions[current];

  $("quiz-position").textContent = `Question ${current + 1} of ${total}`;
  $("quiz-score").textContent = `Score: ${score}/${current}`;
  $("progress-fill").style.width = `${(current / total) * 100}%`;
  $("quiz-question").textContent = q.question;

  const feedback = $("quiz-feedback");
  feedback.hidden = true;
  feedback.className = "feedback";
  $("btn-next").hidden = true;

  const optionsEl = $("quiz-options");
  optionsEl.innerHTML = "";
  q.options.forEach((opt, oi) => {
    const btn = document.createElement("button");
    btn.className = "option-btn";

    const letter = document.createElement("span");
    letter.className = "option-letter";
    letter.textContent = String.fromCharCode(65 + oi);

    const label = document.createElement("span");
    label.textContent = opt;

    btn.append(letter, label);
    btn.addEventListener("click", () => answerQuestion(oi));
    optionsEl.appendChild(btn);
  });
}

function answerQuestion(chosen) {
  const q = quiz.questions[current];
  const correct = chosen === q.correctIndex;
  answers[current] = chosen;
  if (correct) score++;

  const buttons = [...$("quiz-options").children];
  buttons.forEach((btn, oi) => {
    btn.disabled = true;
    if (oi === q.correctIndex) btn.classList.add("correct");
    else if (oi === chosen) btn.classList.add("wrong");
    else btn.classList.add("dimmed");
  });

  $("quiz-score").textContent = `Score: ${score}/${current + 1}`;

  const feedback = $("quiz-feedback");
  feedback.innerHTML = "";
  const title = document.createElement("div");
  title.className = "feedback-title";

  if (correct) {
    feedback.classList.add("good");
    title.textContent = "✓ Correct!";
    feedback.appendChild(title);
  } else {
    feedback.classList.add("bad");
    title.textContent = `✗ Incorrect — the answer is ${String.fromCharCode(65 + q.correctIndex)}.`;
    feedback.appendChild(title);
    if (q.explanation) {
      const expl = document.createElement("div");
      expl.textContent = q.explanation;
      feedback.appendChild(expl);
    }
  }
  feedback.hidden = false;

  const next = $("btn-next");
  next.textContent = current + 1 === quiz.questions.length ? "See Results →" : "Next Question →";
  next.hidden = false;
  next.focus();
}

$("btn-next").addEventListener("click", () => {
  current++;
  if (current >= quiz.questions.length) {
    renderResults();
    showScreen("results");
  } else {
    renderQuestion();
  }
});

// ============================================================
// RESULTS
// ============================================================
function renderResults() {
  const total = quiz.questions.length;
  const pct = Math.round((score / total) * 100);
  $("results-score").textContent = `${pct}%`;
  $("results-summary").textContent = `You answered ${score} of ${total} questions correctly on "${quiz.title}".`;

  const missed = quiz.questions
    .map((q, i) => ({ q, chosen: answers[i] }))
    .filter(({ q, chosen }) => chosen !== q.correctIndex);

  $("missed-section").hidden = missed.length === 0;
  const list = $("missed-list");
  list.innerHTML = "";

  for (const { q, chosen } of missed) {
    const item = document.createElement("div");
    item.className = "missed-item";

    const question = document.createElement("div");
    question.className = "missed-q";
    question.textContent = q.question;

    const yours = document.createElement("div");
    yours.className = "missed-your";
    yours.textContent = `Your answer: ${String.fromCharCode(65 + chosen)}. ${q.options[chosen]}`;

    const right = document.createElement("div");
    right.className = "missed-correct";
    right.textContent = `Correct answer: ${String.fromCharCode(65 + q.correctIndex)}. ${q.options[q.correctIndex]}`;

    item.append(question, yours, right);

    if (q.explanation) {
      const expl = document.createElement("div");
      expl.className = "missed-explanation";
      expl.textContent = q.explanation;
      item.appendChild(expl);
    }
    list.appendChild(item);
  }
}

$("btn-retake").addEventListener("click", startQuiz);
$("btn-results-home").addEventListener("click", () => {
  loadQuizList();
  showScreen("home");
});

// ============================================================
// Shared helpers
// ============================================================
function showError(id, message) {
  const el = $(id);
  el.textContent = message;
  el.hidden = false;
}
function hideError(id) {
  $(id).hidden = true;
}

$("brand-home").addEventListener("click", () => {
  loadQuizList();
  showScreen("home");
});

// Boot
loadQuizList();
