/* StudyForge frontend — screens:
   home/upload → generating (job poll) → unit overview →
   quiz player / results, review editor, activity players
   (labeling, matching, ordering, scenario) */

const $ = (id) => document.getElementById(id);

const screens = {
  home: $("screen-home"),
  generating: $("screen-generating"),
  unit: $("screen-unit"),
  review: $("screen-review"),
  quiz: $("screen-quiz"),
  results: $("screen-results"),
  activity: $("screen-activity"),
  recall: $("screen-recall"),
};

function showScreen(name) {
  for (const [key, el] of Object.entries(screens)) {
    el.hidden = key !== name;
  }
  window.scrollTo({ top: 0 });
}

// ---------- State ----------
let selectedFiles = [];   // File objects queued for upload
let unit = null;          // currently open unit
let player = null;        // { context, questions, kind, moduleId } for the quiz player
let editor = null;        // { kind: 'moduleQuiz'|'unitTest', moduleId?, title, questions }
let activity = null;      // { moduleId, data } for the activity player
let current = 0;
let score = 0;
let answers = [];
let pollTimer = null;

const shuffle = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

const letter = (i) => String.fromCharCode(65 + i);

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
      showError("upload-error", "You can upload at most 12 files per unit.");
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

  const form = new FormData();
  selectedFiles.forEach((f) => form.append("files", f));

  try {
    $("generating-status").textContent = "Uploading files…";
    showScreen("generating");
    const res = await fetch("/api/units/generate", { method: "POST", body: form });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "Generation failed.");
    pollJob(body.jobId);
  } catch (err) {
    showScreen("home");
    showError("upload-error", err.message);
  }
});

function pollJob(jobId) {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    try {
      const res = await fetch(`/api/jobs/${jobId}`);
      const job = await res.json();
      if (!res.ok) throw new Error(job.error || "Job lost.");

      if (job.status === "running") {
        $("generating-status").textContent = job.phase;
        return;
      }
      clearInterval(pollTimer);

      if (job.status === "error") throw new Error(job.error || "Generation failed.");

      selectedFiles = [];
      renderFileList();
      await loadUnitList();
      if (job.unitIds.length === 1) {
        await openUnit(job.unitIds[0]);
      } else {
        showScreen("home");
      }
    } catch (err) {
      clearInterval(pollTimer);
      showScreen("home");
      showError("upload-error", err.message);
    }
  }, 1500);
}

// ============================================================
// UNITS LIST
// ============================================================
async function loadUnitList() {
  try {
    const res = await fetch("/api/units");
    const units = await res.json();
    const card = $("saved-units-card");
    const list = $("unit-list");
    list.innerHTML = "";
    card.hidden = units.length === 0;

    for (const u of units) {
      const li = document.createElement("li");

      const info = document.createElement("div");
      const title = document.createElement("div");
      title.textContent = u.title;
      const meta = document.createElement("div");
      meta.className = "quiz-meta";
      const bits = [
        `${u.moduleCount} module${u.moduleCount === 1 ? "" : "s"}`,
        `${u.unitTestCount}-question unit test`,
      ];
      if (u.activityCount > 0) bits.push(`${u.activityCount} activities`);
      if (u.unitTestBest != null) bits.push(`best ${u.unitTestBest}%`);
      meta.textContent = bits.join(" · ");
      info.append(title, meta);

      const actions = document.createElement("div");
      actions.className = "quiz-item-actions";

      const open = document.createElement("button");
      open.className = "btn btn-primary";
      open.textContent = "Open";
      open.addEventListener("click", () => openUnit(u.id));

      const del = document.createElement("button");
      del.className = "btn-danger-link";
      del.textContent = "Delete";
      del.addEventListener("click", async () => {
        if (!confirm(`Delete "${u.title}"?`)) return;
        await fetch(`/api/units/${u.id}`, { method: "DELETE" });
        loadUnitList();
      });

      actions.append(open, del);
      li.append(info, actions);
      list.appendChild(li);
    }
  } catch {
    /* list is non-critical; leave hidden on failure */
  }
}

// ============================================================
// UNIT OVERVIEW
// ============================================================
async function openUnit(id) {
  const res = await fetch(`/api/units/${id}`);
  if (!res.ok) return;
  unit = await res.json();
  renderUnit();
  showScreen("unit");
}

async function refreshUnit() {
  if (!unit) return;
  const res = await fetch(`/api/units/${unit.id}`);
  if (res.ok) unit = await res.json();
}

const ACTIVITY_ICONS = { labeling: "🏷️", matching: "🔗", ordering: "🔀", scenario: "🎮" };

function renderUnit() {
  $("unit-title").textContent = unit.title;
  const activityTotal = unit.modules.reduce((n, m) => n + m.activities.length, 0);
  $("unit-meta").textContent = `${unit.modules.length} module${unit.modules.length === 1 ? "" : "s"} · ${activityTotal} interactive activit${activityTotal === 1 ? "y" : "ies"} · created ${new Date(unit.createdAt).toLocaleDateString()}`;

  const container = $("unit-modules");
  container.innerHTML = "";

  unit.modules.forEach((mod, i) => {
    const card = document.createElement("div");
    card.className = "card";

    const head = document.createElement("div");
    head.className = "module-head";

    const info = document.createElement("div");
    const num = document.createElement("div");
    num.className = "module-number";
    num.textContent = `Module ${i + 1}`;
    const title = document.createElement("h2");
    title.textContent = mod.title;
    const summary = document.createElement("p");
    summary.className = "muted";
    summary.textContent = mod.summary;
    info.append(num, title, summary);
    head.appendChild(info);

    if (mod.progress?.quizBest != null) {
      const badge = document.createElement("span");
      badge.className = "best-badge";
      badge.textContent = `Quiz best: ${mod.progress.quizBest}%`;
      head.appendChild(badge);
    }
    card.appendChild(head);

    const actions = document.createElement("div");
    actions.className = "module-actions";

    const quizBtn = document.createElement("button");
    quizBtn.className = "btn btn-primary";
    quizBtn.textContent = `Take Quiz (${mod.quiz.length} questions)`;
    quizBtn.addEventListener("click", () =>
      startPlayer({
        context: `${unit.title} — Module ${i + 1}: ${mod.title}`,
        questions: mod.quiz,
        kind: "moduleQuiz",
        moduleId: mod.id,
      }),
    );

    const editBtn = document.createElement("button");
    editBtn.className = "btn btn-secondary";
    editBtn.textContent = "Edit Quiz";
    editBtn.addEventListener("click", () => openEditor({ kind: "moduleQuiz", moduleId: mod.id }));

    const recallBtn = document.createElement("button");
    recallBtn.className = "btn btn-secondary";
    const concepts = mod.recall?.concepts || [];
    if (concepts.length > 0) {
      const avg = concepts.reduce((n, c) => n + c.level, 0) / concepts.length;
      recallBtn.textContent = `🧠 Recall Practice (mastery ${avg.toFixed(1)}/4)`;
    } else {
      recallBtn.textContent = "🧠 Recall Practice";
    }
    recallBtn.addEventListener("click", () => startRecall(mod));

    actions.append(quizBtn, editBtn, recallBtn);
    card.appendChild(actions);

    if (mod.activities.length > 0) {
      const chips = document.createElement("div");
      chips.className = "activity-chips";
      for (const act of mod.activities) {
        const chip = document.createElement("button");
        chip.className = "activity-chip";
        const icon = ACTIVITY_ICONS[act.type] || "✨";
        chip.append(document.createTextNode(`${icon} ${act.title}`));
        if (mod.progress?.activitiesDone?.includes(act.id)) {
          const done = document.createElement("span");
          done.className = "done-mark";
          done.textContent = "✓";
          chip.appendChild(done);
        }
        chip.addEventListener("click", () => startActivity(mod.id, act));
        chips.appendChild(chip);
      }
      card.appendChild(chips);
    }

    container.appendChild(card);
  });

  $("unit-test-meta").textContent = `${unit.unitTest.length} questions covering all modules`;
  const best = $("unit-test-best");
  if (unit.progress?.unitTestBest != null) {
    best.textContent = `Best: ${unit.progress.unitTestBest}%`;
    best.hidden = false;
  } else {
    best.hidden = true;
  }
}

$("btn-start-unit-test").addEventListener("click", () =>
  startPlayer({
    context: `${unit.title} — Unit Test`,
    questions: unit.unitTest,
    kind: "unitTest",
  }),
);
$("btn-edit-unit-test").addEventListener("click", () => openEditor({ kind: "unitTest" }));

// ============================================================
// REVIEW & EDIT (module quiz or unit test)
// ============================================================
function blankQuestion() {
  return { question: "", options: ["", "", "", ""], correctIndex: 0, explanation: "" };
}

function openEditor({ kind, moduleId }) {
  if (kind === "moduleQuiz") {
    const mod = unit.modules.find((m) => m.id === moduleId);
    editor = {
      kind,
      moduleId,
      title: mod.title,
      titleLabel: "Module title",
      questions: JSON.parse(JSON.stringify(mod.quiz)),
    };
  } else {
    editor = {
      kind,
      title: unit.title,
      titleLabel: "Unit title",
      questions: JSON.parse(JSON.stringify(unit.unitTest)),
    };
  }
  renderReview();
  showScreen("review");
}

function renderReview() {
  $("quiz-title-label").textContent = editor.titleLabel;
  $("quiz-title").value = editor.title;
  $("review-count").textContent = `${editor.questions.length} question${editor.questions.length === 1 ? "" : "s"}`;
  hideError("review-error");

  const container = $("review-questions");
  container.innerHTML = "";
  editor.questions.forEach((q, qi) => container.appendChild(buildQuestionCard(q, qi)));
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
    text.placeholder = `Option ${letter(oi)}`;
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
    editor.questions.splice(qi, 1);
    renderReview();
  });
  footer.appendChild(del);
  card.appendChild(footer);

  return card;
}

$("quiz-title").addEventListener("input", (e) => {
  if (editor) editor.title = e.target.value;
});

$("btn-add-question").addEventListener("click", () => {
  editor.questions.push(blankQuestion());
  renderReview();
  const cards = $("review-questions").children;
  cards[cards.length - 1]?.scrollIntoView({ behavior: "smooth", block: "center" });
});

$("btn-review-cancel").addEventListener("click", () => {
  editor = null;
  showScreen("unit");
});

function validateEditor() {
  if (!editor.title.trim()) return "Give it a title.";
  if (editor.questions.length === 0) return "You need at least one question.";
  for (let i = 0; i < editor.questions.length; i++) {
    const q = editor.questions[i];
    if (!q.question.trim()) return `Question ${i + 1} is missing its text.`;
    if (q.options.some((o) => !o.trim())) return `Question ${i + 1} has an empty answer option.`;
  }
  return null;
}

$("btn-save-quiz").addEventListener("click", async () => {
  const error = validateEditor();
  if (error) return showError("review-error", error);
  hideError("review-error");

  const url =
    editor.kind === "moduleQuiz"
      ? `/api/units/${unit.id}/modules/${editor.moduleId}/quiz`
      : `/api/units/${unit.id}/unit-test`;

  const res = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: editor.title.trim(), questions: editor.questions }),
  });
  const body = await res.json();
  if (!res.ok) return showError("review-error", body.error || "Failed to save.");

  unit = body;
  editor = null;
  renderUnit();
  loadUnitList();
  showScreen("unit");
});

// ============================================================
// QUIZ PLAYER (module quizzes and unit tests)
// ============================================================
function startPlayer(config) {
  player = config;
  current = 0;
  score = 0;
  answers = new Array(player.questions.length).fill(null);
  renderQuestion();
  showScreen("quiz");
}

function renderQuestion() {
  const total = player.questions.length;
  const q = player.questions[current];

  $("quiz-context").textContent = player.context;
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

    const l = document.createElement("span");
    l.className = "option-letter";
    l.textContent = letter(oi);

    const label = document.createElement("span");
    label.textContent = opt;

    btn.append(l, label);
    btn.addEventListener("click", () => answerQuestion(oi));
    optionsEl.appendChild(btn);
  });
}

function answerQuestion(chosen) {
  const q = player.questions[current];
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
    title.textContent = `✗ Incorrect — the answer is ${letter(q.correctIndex)}.`;
    feedback.appendChild(title);
    if (q.explanation) {
      const expl = document.createElement("div");
      expl.textContent = q.explanation;
      feedback.appendChild(expl);
    }
  }
  feedback.hidden = false;

  const next = $("btn-next");
  next.textContent = current + 1 === player.questions.length ? "See Results →" : "Next Question →";
  next.hidden = false;
  next.focus();
}

$("btn-next").addEventListener("click", () => {
  current++;
  if (current >= player.questions.length) {
    finishPlayer();
  } else {
    renderQuestion();
  }
});

async function finishPlayer() {
  const pct = Math.round((score / player.questions.length) * 100);

  // Record best score on the unit (fire-and-forget from the user's view).
  if (unit && (player.kind === "moduleQuiz" || player.kind === "unitTest")) {
    try {
      const res = await fetch(`/api/units/${unit.id}/progress`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: player.kind, moduleId: player.moduleId, score: pct }),
      });
      if (res.ok) unit = await res.json();
    } catch {
      /* progress saving is best-effort */
    }
  }

  renderResults(pct);
  showScreen("results");
}

// ============================================================
// RESULTS
// ============================================================
function renderResults(pct) {
  const total = player.questions.length;
  $("results-score").textContent = `${pct}%`;
  $("results-summary").textContent = `You answered ${score} of ${total} questions correctly on "${player.context}".`;

  const missed = player.questions
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
    yours.textContent = `Your answer: ${letter(chosen)}. ${q.options[chosen]}`;

    const right = document.createElement("div");
    right.className = "missed-correct";
    right.textContent = `Correct answer: ${letter(q.correctIndex)}. ${q.options[q.correctIndex]}`;

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

$("btn-retake").addEventListener("click", () => startPlayer(player));
$("btn-results-back").addEventListener("click", () => {
  renderUnit();
  showScreen("unit");
});

// ============================================================
// ACTIVITY PLAYER
// ============================================================
const activityUI = {
  body: () => $("activity-body"),
  feedback: () => $("activity-feedback"),
  check: () => $("btn-activity-check"),
  reset: () => $("btn-activity-reset"),
};

function startActivity(moduleId, data) {
  activity = { moduleId, data };
  $("activity-title").textContent = `${ACTIVITY_ICONS[data.type] || "✨"} ${data.title}`;
  $("activity-instructions").textContent = data.instructions;
  renderActivity();
  showScreen("activity");
}

function renderActivity() {
  const fb = activityUI.feedback();
  fb.hidden = true;
  fb.className = "feedback";
  activityUI.reset().hidden = true;
  activityUI.check().hidden = false;
  activityUI.check().disabled = false;

  const body = activityUI.body();
  body.innerHTML = "";

  const { data } = activity;
  if (data.type === "labeling") renderLabeling(body, data);
  else if (data.type === "matching") renderMatching(body, data);
  else if (data.type === "ordering") renderOrdering(body, data);
  else if (data.type === "scenario") renderScenario(body, data);
}

async function completeActivity(scoreText, allCorrect) {
  const fb = activityUI.feedback();
  fb.innerHTML = "";
  fb.classList.add(allCorrect ? "good" : "bad");
  const title = document.createElement("div");
  title.className = "feedback-title";
  title.textContent = scoreText;
  fb.appendChild(title);
  fb.hidden = false;

  activityUI.check().hidden = true;
  activityUI.reset().hidden = false;

  if (unit) {
    try {
      const res = await fetch(`/api/units/${unit.id}/progress`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "activity", moduleId: activity.moduleId, activityId: activity.data.id }),
      });
      if (res.ok) unit = await res.json();
    } catch {
      /* best-effort */
    }
  }
}

$("btn-activity-back").addEventListener("click", () => {
  renderUnit();
  showScreen("unit");
});
$("btn-activity-reset").addEventListener("click", renderActivity);

// ---------- Labeling ----------
function renderLabeling(body, data) {
  // Markers are numbered points on the image; the user pairs each with a
  // label from the shuffled word bank (click a marker, then a label — or the
  // reverse). Check compares assignments against the generated answer key.
  const assignments = new Array(data.labels.length).fill(null); // marker index -> label text
  let selectedMarker = null;
  let selectedChip = null;

  const stage = document.createElement("div");
  stage.className = "labeling-stage";
  const img = document.createElement("img");
  img.src = data.image;
  img.alt = data.title;
  stage.appendChild(img);

  const markers = data.labels.map((label, i) => {
    const m = document.createElement("button");
    m.className = "label-marker";
    m.textContent = i + 1;
    m.style.left = `${label.x * 100}%`;
    m.style.top = `${label.y * 100}%`;
    m.addEventListener("click", () => {
      if (checkDone) return;
      selectedMarker = selectedMarker === i ? null : i;
      markers.forEach((mk, j) => mk.classList.toggle("selected", selectedMarker === j));
      tryAssign();
    });
    stage.appendChild(m);
    return m;
  });

  const hint = document.createElement("p");
  hint.className = "hint-text";
  hint.textContent = "Tap a numbered point, then tap the label that belongs there (or pick the label first).";

  const list = document.createElement("ul");
  list.className = "assignment-list";
  const slots = data.labels.map((_, i) => {
    const li = document.createElement("li");
    const num = document.createElement("span");
    num.className = "assignment-num";
    num.textContent = i + 1;
    const slot = document.createElement("span");
    slot.className = "assignment-slot";
    slot.textContent = "— unassigned —";
    li.append(num, slot);
    li.addEventListener("click", () => {
      if (checkDone || assignments[i] === null) return;
      // Clicking a filled row clears it back to the bank.
      const text = assignments[i];
      assignments[i] = null;
      slot.textContent = "— unassigned —";
      slot.classList.remove("filled");
      chips.find((c) => c.textContent === text)?.classList.remove("used");
      updateCheckState();
    });
    list.appendChild(li);
    return { li, slot };
  });

  const bank = document.createElement("div");
  bank.className = "word-bank";
  const chips = shuffle(data.labels.map((l) => l.text)).map((text) => {
    const chip = document.createElement("button");
    chip.className = "word-chip";
    chip.textContent = text;
    chip.addEventListener("click", () => {
      if (checkDone || chip.classList.contains("used")) return;
      selectedChip = selectedChip === chip ? null : chip;
      chips.forEach((c) => c.classList.toggle("selected", c === selectedChip));
      tryAssign();
    });
    bank.appendChild(chip);
    return chip;
  });

  let checkDone = false;

  function tryAssign() {
    if (selectedMarker === null || !selectedChip) return;
    const i = selectedMarker;
    // If the marker already had a label, release it back to the bank.
    if (assignments[i]) {
      chips.find((c) => c.textContent === assignments[i])?.classList.remove("used");
    }
    assignments[i] = selectedChip.textContent;
    slots[i].slot.textContent = selectedChip.textContent;
    slots[i].slot.classList.add("filled");
    selectedChip.classList.add("used");
    selectedChip.classList.remove("selected");
    markers[i].classList.remove("selected");
    selectedMarker = null;
    selectedChip = null;
    updateCheckState();
  }

  function updateCheckState() {
    activityUI.check().disabled = assignments.some((a) => a === null);
  }

  updateCheckState();

  activityUI.check().onclick = () => {
    checkDone = true;
    let correct = 0;
    data.labels.forEach((label, i) => {
      const ok = assignments[i] === label.text;
      if (ok) correct++;
      markers[i].classList.add(ok ? "correct" : "wrong");
      slots[i].li.classList.add(ok ? "correct" : "wrong");
      if (!ok) {
        const fix = document.createElement("span");
        fix.className = "assignment-fix";
        fix.textContent = `✓ ${label.text}`;
        slots[i].li.appendChild(fix);
      }
    });
    chips.forEach((c) => (c.disabled = true));
    completeActivity(
      `You placed ${correct} of ${data.labels.length} labels correctly.`,
      correct === data.labels.length,
    );
  };

  body.append(stage, hint, list, bank);
}

// ---------- Matching ----------
function renderMatching(body, data) {
  // Click one item in each column to pair them; pairs get a shared tag.
  // Clicking a paired item unpairs it.
  const n = data.pairs.length;
  const rightOrder = shuffle(data.pairs.map((_, i) => i)); // display order -> pair index
  const pairsChosen = new Array(n).fill(null); // left index -> right pair index
  let selectedLeft = null;
  let selectedRight = null;
  let checkDone = false;

  const grid = document.createElement("div");
  grid.className = "match-grid";
  const leftCol = document.createElement("div");
  leftCol.className = "match-col";
  const rightCol = document.createElement("div");
  rightCol.className = "match-col";
  grid.append(leftCol, rightCol);

  const leftBtns = data.pairs.map((p, i) => {
    const btn = document.createElement("button");
    btn.className = "match-item";
    btn.textContent = p.left;
    btn.addEventListener("click", () => {
      if (checkDone) return;
      if (pairsChosen[i] !== null) return unpair(i);
      selectedLeft = selectedLeft === i ? null : i;
      refreshSelection();
      tryPair();
    });
    leftCol.appendChild(btn);
    return btn;
  });

  const rightBtns = rightOrder.map((pairIdx) => {
    const btn = document.createElement("button");
    btn.className = "match-item";
    btn.textContent = data.pairs[pairIdx].right;
    btn.dataset.pairIdx = pairIdx;
    btn.addEventListener("click", () => {
      if (checkDone) return;
      const owner = pairsChosen.indexOf(pairIdx);
      if (owner !== -1) return unpair(owner);
      selectedRight = selectedRight === pairIdx ? null : pairIdx;
      refreshSelection();
      tryPair();
    });
    rightCol.appendChild(btn);
    return btn;
  });

  function rightBtnFor(pairIdx) {
    return rightBtns.find((b) => Number(b.dataset.pairIdx) === pairIdx);
  }

  function refreshSelection() {
    leftBtns.forEach((b, i) => b.classList.toggle("selected", selectedLeft === i));
    rightBtns.forEach((b) => b.classList.toggle("selected", selectedRight === Number(b.dataset.pairIdx)));
  }

  function tagPairs() {
    leftBtns.forEach((b, i) => {
      const existing = b.querySelector(".pair-tag");
      if (existing) existing.remove();
      if (pairsChosen[i] !== null) {
        const tag = document.createElement("span");
        tag.className = "pair-tag";
        tag.textContent = `#${i + 1}`;
        b.prepend(tag);
      }
      b.classList.toggle("paired", pairsChosen[i] !== null);
    });
    rightBtns.forEach((b) => {
      const existing = b.querySelector(".pair-tag");
      if (existing) existing.remove();
      const owner = pairsChosen.indexOf(Number(b.dataset.pairIdx));
      if (owner !== -1) {
        const tag = document.createElement("span");
        tag.className = "pair-tag";
        tag.textContent = `#${owner + 1}`;
        b.prepend(tag);
      }
      b.classList.toggle("paired", owner !== -1);
    });
  }

  function tryPair() {
    if (selectedLeft === null || selectedRight === null) return;
    pairsChosen[selectedLeft] = selectedRight;
    selectedLeft = null;
    selectedRight = null;
    refreshSelection();
    tagPairs();
    activityUI.check().disabled = pairsChosen.some((p) => p === null);
  }

  function unpair(leftIdx) {
    pairsChosen[leftIdx] = null;
    tagPairs();
    activityUI.check().disabled = true;
  }

  activityUI.check().disabled = true;

  activityUI.check().onclick = () => {
    checkDone = true;
    let correct = 0;
    leftBtns.forEach((b, i) => {
      const ok = pairsChosen[i] === i;
      if (ok) correct++;
      b.classList.add(ok ? "correct" : "wrong");
      const rb = rightBtnFor(pairsChosen[i]);
      rb?.classList.add(ok ? "correct" : "wrong");
      if (!ok) {
        const fix = document.createElement("div");
        fix.className = "missed-correct";
        fix.textContent = `✓ ${data.pairs[i].right}`;
        b.appendChild(fix);
      }
    });
    completeActivity(`You matched ${correct} of ${n} pairs correctly.`, correct === n);
  };

  body.appendChild(grid);
}

// ---------- Ordering ----------
function renderOrdering(body, data) {
  // Items start shuffled (guaranteed not already correct); ↑/↓ reorder.
  let order = shuffle(data.items.map((_, i) => i));
  if (order.every((v, i) => v === i) && order.length > 1) {
    [order[0], order[1]] = [order[1], order[0]];
  }
  let checkDone = false;

  const list = document.createElement("ol");
  list.className = "order-list";

  function render() {
    list.innerHTML = "";
    order.forEach((itemIdx, pos) => {
      const li = document.createElement("li");

      const posEl = document.createElement("span");
      posEl.className = "order-pos";
      posEl.textContent = pos + 1;

      const text = document.createElement("span");
      text.className = "order-text";
      text.textContent = data.items[itemIdx];

      li.append(posEl, text);

      if (!checkDone) {
        const buttons = document.createElement("div");
        buttons.className = "order-buttons";
        const up = document.createElement("button");
        up.className = "order-move";
        up.textContent = "↑";
        up.disabled = pos === 0;
        up.addEventListener("click", () => {
          [order[pos - 1], order[pos]] = [order[pos], order[pos - 1]];
          render();
        });
        const down = document.createElement("button");
        down.className = "order-move";
        down.textContent = "↓";
        down.disabled = pos === order.length - 1;
        down.addEventListener("click", () => {
          [order[pos + 1], order[pos]] = [order[pos], order[pos + 1]];
          render();
        });
        buttons.append(up, down);
        li.appendChild(buttons);
      } else {
        const ok = itemIdx === pos;
        li.classList.add(ok ? "correct" : "wrong");
        if (!ok) {
          const fix = document.createElement("span");
          fix.className = "order-fix";
          fix.textContent = `step ${itemIdx + 1}`;
          li.appendChild(fix);
        }
      }
      list.appendChild(li);
    });
  }

  render();

  activityUI.check().onclick = () => {
    checkDone = true;
    render();
    const correct = order.filter((itemIdx, pos) => itemIdx === pos).length;
    completeActivity(
      `You placed ${correct} of ${order.length} steps in the right position.`,
      correct === order.length,
    );
  };

  body.appendChild(list);
}

// ---------- Scenario ----------
function renderScenario(body, data) {
  // A step-by-step simulation: each step shows a situation and choices; every
  // choice gets feedback, then the learner moves on. Score = best choices made.
  let step = 0;
  let bestCount = 0;

  activityUI.check().hidden = true; // scenario advances itself

  function renderStep() {
    body.innerHTML = "";

    const progress = document.createElement("div");
    progress.className = "scenario-progress";
    progress.textContent = `Step ${step + 1} of ${data.steps.length}`;

    const situation = document.createElement("div");
    situation.className = "scenario-situation";
    situation.textContent = data.steps[step].situation;

    const options = document.createElement("div");
    options.className = "scenario-options";

    const opts = shuffle(data.steps[step].options);
    opts.forEach((opt) => {
      const btn = document.createElement("button");
      btn.className = "option-btn";
      const label = document.createElement("span");
      label.textContent = opt.text;
      btn.appendChild(label);
      btn.addEventListener("click", () => {
        if (opt.isBest) bestCount++;
        [...options.children].forEach((b, i) => {
          b.disabled = true;
          if (opts[i].isBest) b.classList.add("correct");
          else if (opts[i] === opt) b.classList.add("wrong");
          else b.classList.add("dimmed");
        });

        const fb = document.createElement("div");
        fb.className = `feedback ${opt.isBest ? "good" : "bad"}`;
        const title = document.createElement("div");
        title.className = "feedback-title";
        title.textContent = opt.isBest ? "✓ Good call!" : "✗ Not the best choice.";
        fb.appendChild(title);
        if (opt.feedback) {
          const detail = document.createElement("div");
          detail.textContent = opt.feedback;
          fb.appendChild(detail);
        }
        body.appendChild(fb);

        const next = document.createElement("div");
        next.className = "actions";
        const nextBtn = document.createElement("button");
        nextBtn.className = "btn btn-primary";
        nextBtn.textContent = step + 1 === data.steps.length ? "Finish →" : "Next Step →";
        nextBtn.addEventListener("click", () => {
          step++;
          if (step >= data.steps.length) {
            body.innerHTML = "";
            completeActivity(
              `You made the best call on ${bestCount} of ${data.steps.length} steps.`,
              bestCount === data.steps.length,
            );
          } else {
            renderStep();
          }
        });
        next.appendChild(nextBtn);
        body.appendChild(next);
        nextBtn.focus();
      });
      options.appendChild(btn);
    });

    body.append(progress, situation, options);
  }

  renderStep();
}

// ============================================================
// SPACED RECALL
// ============================================================
let recall = null; // { moduleId, moduleTitle, question, answered }

function startRecall(mod) {
  recall = { moduleId: mod.id, moduleTitle: mod.title, question: null, answered: false };
  $("recall-context").textContent = `Spaced Recall — ${mod.title}`;
  $("recall-mastery-card").hidden = true;
  showScreen("recall");
  nextRecallQuestion();
}

function levelDots(level, changed) {
  const wrap = document.createElement("div");
  wrap.className = "level-dots";
  for (let i = 1; i <= 4; i++) {
    const dot = document.createElement("span");
    dot.className = "level-dot";
    if (i <= level) dot.classList.add("filled");
    if (changed === "up" && i === level) dot.classList.replace("filled", "gained");
    if (changed === "down" && i === level + 1) dot.classList.add("lost");
    wrap.appendChild(dot);
  }
  return wrap;
}

function renderRecallLevel(level, levelName, changed) {
  const badge = $("recall-level");
  badge.innerHTML = "";
  const name = document.createElement("span");
  name.className = "level-name";
  name.textContent = `Level ${level} · ${levelName}`;
  badge.append(name, levelDots(level, changed));
}

function renderMastery(concepts) {
  const card = $("recall-mastery-card");
  const list = $("recall-mastery");
  list.innerHTML = "";
  card.hidden = !concepts || concepts.length === 0;
  for (const c of concepts || []) {
    const li = document.createElement("li");
    const info = document.createElement("div");
    info.className = "mastery-info";
    const name = document.createElement("span");
    name.textContent = c.name;
    const sub = document.createElement("span");
    sub.className = "mastery-sub";
    sub.textContent = `${c.attempts} attempt${c.attempts === 1 ? "" : "s"}`;
    info.append(name, sub);
    li.append(info, levelDots(c.level));
    list.appendChild(li);
  }
}

async function nextRecallQuestion() {
  hideError("recall-error");
  $("recall-question-area").hidden = true;
  $("recall-feedback").hidden = true;
  $("btn-recall-submit").hidden = true;
  $("btn-recall-next").hidden = true;
  $("recall-loading").hidden = false;
  $("recall-loading-text").textContent = recall.question
    ? "Generating your next question…"
    : "Finding this module's key concepts and generating your first question…";
  $("recall-concept").innerHTML = "&nbsp;";
  $("recall-level").innerHTML = "";

  try {
    const res = await fetch(`/api/units/${unit.id}/modules/${recall.moduleId}/recall/question`, { method: "POST" });
    const q = await res.json();
    if (!res.ok) throw new Error(q.error || "Could not generate a question.");

    recall.question = q;
    recall.answered = false;
    $("recall-loading").hidden = true;
    $("recall-concept").textContent = q.concept;
    renderRecallLevel(q.level, q.levelName);
    renderMastery(q.concepts);
    $("recall-prompt").textContent = q.prompt;
    renderRecallInput(q);
    $("recall-question-area").hidden = false;
  } catch (err) {
    $("recall-loading").hidden = true;
    showError("recall-error", err.message);
  }
}

function renderRecallInput(q) {
  const input = $("recall-input");
  input.innerHTML = "";
  const submit = $("btn-recall-submit");

  if (q.level === 0 && q.options) {
    // Recognition: click an option to answer immediately.
    submit.hidden = true;
    const options = document.createElement("div");
    options.className = "quiz-options";
    q.options.forEach((opt, oi) => {
      const btn = document.createElement("button");
      btn.className = "option-btn";
      const l = document.createElement("span");
      l.className = "option-letter";
      l.textContent = letter(oi);
      const label = document.createElement("span");
      label.textContent = opt;
      btn.append(l, label);
      btn.addEventListener("click", () => {
        if (recall.answered) return;
        [...options.children].forEach((b) => (b.disabled = true));
        btn.classList.add("selected");
        submitRecallAnswer(opt);
      });
      options.appendChild(btn);
    });
    input.appendChild(options);
    return;
  }

  // Levels 1-2: single-line answer; levels 3-4: free response.
  const el = document.createElement(q.level <= 2 ? "input" : "textarea");
  el.className = "recall-text-input" + (q.level >= 3 ? " recall-textarea" : "");
  el.id = "recall-answer";
  el.placeholder =
    q.level <= 2 ? "Type the missing part…" : "Answer in your own words — wording doesn't need to match the material.";
  if (el.tagName === "INPUT") {
    el.type = "text";
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit.click();
    });
  }
  input.appendChild(el);
  el.focus();

  submit.hidden = false;
  submit.onclick = () => {
    const value = el.value.trim();
    if (!value) return showError("recall-error", "Type an answer first.");
    hideError("recall-error");
    el.disabled = true;
    submitRecallAnswer(value);
  };
}

async function submitRecallAnswer(response) {
  if (recall.answered) return;
  recall.answered = true;
  const submit = $("btn-recall-submit");
  submit.disabled = true;
  submit.textContent = "Grading…";

  try {
    const res = await fetch("/api/recall/answer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ questionId: recall.question.questionId, response }),
    });
    const grade = await res.json();
    if (!res.ok) throw new Error(grade.error || "Grading failed.");

    renderRecallLevel(grade.newLevel, grade.levelName, grade.levelChange);
    renderMastery(grade.concepts);

    const fb = $("recall-feedback");
    fb.innerHTML = "";
    fb.className = `feedback ${grade.correct ? "good" : "bad"}`;
    const title = document.createElement("div");
    title.className = "feedback-title";
    title.textContent = grade.correct ? "✓ Correct!" : grade.levelChange === "stay" ? "◐ Partially there." : "✗ Not quite.";
    fb.appendChild(title);
    if (grade.feedback) {
      const detail = document.createElement("div");
      detail.textContent = grade.feedback;
      fb.appendChild(detail);
    }
    const move = document.createElement("div");
    move.className = `level-move ${grade.levelChange}`;
    move.textContent =
      grade.levelChange === "up"
        ? `Level up: ${grade.concept} → Level ${grade.newLevel} (${grade.levelName})`
        : grade.levelChange === "down"
          ? `Level down: ${grade.concept} → Level ${grade.newLevel} (${grade.levelName})`
          : `${grade.concept} stays at Level ${grade.newLevel} (${grade.levelName})`;
    fb.appendChild(move);
    fb.hidden = false;

    const next = $("btn-recall-next");
    next.hidden = false;
    next.focus();
  } catch (err) {
    recall.answered = false;
    // Re-enable whatever input this level used so the learner can retry.
    $("recall-input")
      .querySelectorAll("input, textarea, button")
      .forEach((el) => {
        el.disabled = false;
        el.classList.remove("selected");
      });
    showError("recall-error", err.message);
  } finally {
    submit.disabled = false;
    submit.textContent = "Submit Answer";
    if (recall.answered) submit.hidden = true;
  }
}

$("btn-recall-next").addEventListener("click", nextRecallQuestion);
$("btn-recall-end").addEventListener("click", async () => {
  recall = null;
  await refreshUnit();
  renderUnit();
  showScreen("unit");
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
  clearInterval(pollTimer);
  loadUnitList();
  showScreen("home");
});

// Boot
loadUnitList();
