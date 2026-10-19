const STORAGE_KEYS = {
  config: 'app.interview.config',
  filename: 'app.interview.filename',
  answers: 'app.interview.answers'
};

const MAX_SCORE_LIMIT = 10;
const DEFAULT_MAX_SCORE = 2;

/* Pinned version, loaded on demand from jsDelivr. The scorecard works
   identically without it: if the CDN is unreachable the chart card simply
   never appears. Chart.js is MIT licensed (https://www.chartjs.org). */
const CHART_CDN_URL = 'https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.min.js';
let chartLibraryPromise = null;
let domainChartInstance = null;
let ringChartInstance = null;

const DEFAULT_LEVELS = [
  { min: 70, label: 'Good' },
  { min: 50, label: 'Average / needs improvement' },
  { min: 0, label: 'Insufficient' }
];

let editorState = null;
let currentQuestionnaireFileName = '';
let interviewState = null;
let interviewDirty = true;
let saveTimer = null;
let idCounter = 0;

/* ------------------------------------------------------------------ */
/* Chart library (optional, lazy loaded)                               */
/* ------------------------------------------------------------------ */

/* Resolves with the library, or with null when it cannot be fetched: an
   offline interview must not break the scorecard. A failed attempt is
   forgotten so a later render can try again. */
function ensureChartLibrary() {
  if (typeof window.Chart === 'function') return Promise.resolve(window.Chart);
  if (chartLibraryPromise) return chartLibraryPromise;

  chartLibraryPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = CHART_CDN_URL;
    script.async = true;
    script.onload = () => resolve(window.Chart);
    script.onerror = () => reject(new Error('Chart library could not be loaded'));
    document.head.appendChild(script);
  }).catch((error) => {
    console.warn(error.message + ' - the score overview chart is disabled.');
    /* Reset deferred to a microtask on purpose: when the failure is synchronous
       (blocked by a CSP, missing <head>) this handler runs before the promise
       above is assigned, so resetting inline would be clobbered and the chart
       could never be retried. */
    Promise.resolve().then(() => {
      if (typeof window.Chart !== 'function') chartLibraryPromise = null;
    });
    return null;
  });

  return chartLibraryPromise;
}

/* hex -> rgba(), so fills stay derived from the theme colours. */
function withAlpha(color, alpha) {
  const match = /^#([0-9a-f]{6})$/i.exec(toText(color).trim());
  if (!match) return color;

  const value = parseInt(match[1], 16);
  return 'rgba(' + ((value >> 16) & 255) + ', ' + ((value >> 8) & 255) + ', ' + (value & 255) + ', ' + alpha + ')';
}

/* Radar axis labels have no room to wrap, so long domain titles are trimmed
   and the full name stays available in the tooltip. */
function shortenLabel(value, maxLength) {
  const limit = Number(maxLength) || 22;
  const text = toText(value).trim();
  if (text.length <= limit) return text;
  return text.slice(0, limit - 1).trimEnd() + '…';
}

/* Single source of truth for colours: read them back from the CSS variables
   so the charts cannot drift away from the theme. */
function themeColors() {
  const styles = window.getComputedStyle(document.documentElement);
  const read = (name, fallback) => (styles.getPropertyValue(name) || '').trim() || fallback;

  return {
    ok: read('--ok', '#22c55e'),
    warn: read('--warn', '#eab308'),
    bad: read('--bad', '#ef4444'),
    accent: read('--accent', '#38bdf8'),
    muted: read('--muted', '#94a3b8'),
    text: read('--text', '#e5e7eb'),
    grid: 'rgba(148, 163, 184, 0.18)'
  };
}

function bandColors(colors) {
  return { good: colors.ok, mid: colors.warn, bad: colors.bad };
}

function destroyCharts() {
  if (domainChartInstance) {
    domainChartInstance.destroy();
    domainChartInstance = null;
  }
  if (ringChartInstance) {
    ringChartInstance.destroy();
    ringChartInstance = null;
  }
}

/* ------------------------------------------------------------------ */
/* Generic helpers                                                     */
/* ------------------------------------------------------------------ */

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function toText(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return String(value);
}

function toStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => item !== null && item !== undefined).map((item) => toText(item));
}

function clampMaxScore(value) {
  const parsed = Math.round(Number(value));
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_MAX_SCORE;
  return Math.min(parsed, MAX_SCORE_LIMIT);
}

/* Levels are matched by threshold, not by position, so a questionnaire that
   lists them in the wrong order still grades correctly. */
function matchLevelIndex(levels, percent) {
  if (!Array.isArray(levels) || !levels.length) return -1;

  let bestIndex = -1;
  let bestMin = -Infinity;

  levels.forEach((level, index) => {
    const min = Number(level.min);
    if (!Number.isFinite(min) || percent < min) return;
    if (min > bestMin) {
      bestMin = min;
      bestIndex = index;
    }
  });

  return bestIndex;
}

function getLevel(levels, percent) {
  const index = matchLevelIndex(levels, percent);
  return index === -1 ? 'Unknown' : levels[index].label;
}

/* Band follows the questionnaire's own thresholds rather than hardcoded ones:
   best level = good, lowest level = bad, anything between = mid. */
function levelBand(levels, percent) {
  if (!Array.isArray(levels) || !levels.length) return 'mid';

  const ordered = levels.slice().sort((a, b) => Number(b.min) - Number(a.min));
  const index = matchLevelIndex(ordered, percent);

  if (index === -1) return 'bad';
  if (index === 0) return 'good';
  if (index === ordered.length - 1) return 'bad';
  return 'mid';
}

/* ------------------------------------------------------------------ */
/* Questionnaire normalization                                         */
/* ------------------------------------------------------------------ */

function defaultLabelFor(score, maxScore) {
  let label;
  if (score >= maxScore) label = 'Correct';
  else if (score <= 0) label = 'Incorrect';
  else {
    const ratio = score / maxScore;
    if (ratio >= 0.9) label = 'Excellent';
    else if (ratio >= 0.8) label = 'Very good';
    else if (ratio >= 0.7) label = 'Good';
    else if (ratio >= 0.6) label = 'Satisfactory';
    else if (ratio >= 0.5) label = 'Partial';
    else if (ratio >= 0.4) label = 'Needs improvement';
    else if (ratio >= 0.3) label = 'Limited';
    else if (ratio >= 0.2) label = 'Very limited';
    else label = 'Minimal';
  }

  return label + ' (' + score + '/' + maxScore + ')';
}

function normalizeLabels(input, maxScore) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const labels = {};

  for (let score = 0; score <= maxScore; score += 1) {
    const key = String(score);
    const label = source[key];
    labels[key] = typeof label === 'string' && label.trim() ? label.trim() : defaultLabelFor(score, maxScore);
  }

  return labels;
}

/* Labels created by the editor always end with their exact score. Recognising
   that form lets a scale change refresh only generated labels, while labels
   deliberately written in the JSON remain the source of truth. */
function isGeneratedScoreLabel(label, score) {
  const names = 'Correct|Incorrect|Excellent|Very good|Good|Satisfactory|Partial|Needs improvement|Limited|Very limited|Minimal';
  return new RegExp('^(?:' + names + ') \\(' + score + '/\\d+\\)$').test(toText(label).trim());
}

function labelsForScaleChange(labels, nextMaxScore) {
  const source = labels && typeof labels === 'object' && !Array.isArray(labels) ? labels : {};
  const next = {};

  for (let score = 0; score <= nextMaxScore; score += 1) {
    const key = String(score);
    const label = source[key];
    next[key] = typeof label === 'string' && label.trim() && !isGeneratedScoreLabel(label, score)
      ? label.trim()
      : defaultLabelFor(score, nextMaxScore);
  }

  return next;
}

function normalizeLevels(input) {
  const source = Array.isArray(input) ? input : [];
  const seenMins = new Set();
  const levels = [];

  source.forEach((level) => {
    if (!level || typeof level !== 'object') return;
    const min = Math.round(Number(level.min));
    if (!Number.isFinite(min)) return;
    const clamped = Math.min(100, Math.max(0, min));
    if (seenMins.has(clamped)) return;
    seenMins.add(clamped);
    levels.push({ min: clamped, label: toText(level.label).trim() || 'Unlabelled' });
  });

  levels.sort((a, b) => b.min - a.min);

  if (!levels.length) {
    return DEFAULT_LEVELS.map((level) => ({ min: level.min, label: level.label }));
  }
  /* Guarantee full coverage so a below-all-thresholds score never reads "Unknown". */
  if (!levels.some((level) => level.min <= 0)) {
    levels.push({ min: 0, label: 'Insufficient' });
  }

  return levels;
}

function sanitizeId(value) {
  return toText(value).trim().replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
}

function uniqueId(used, rawValue, fallback) {
  let candidate = sanitizeId(rawValue) || fallback;
  while (used.has(candidate)) {
    idCounter += 1;
    candidate = fallback + '-' + idCounter;
  }
  used.add(candidate);
  return candidate;
}

function emptyState() {
  return {
    meta: {
      title: 'New questionnaire',
      subtitle: 'Describe the context of the test here',
      maxScorePerQuestion: DEFAULT_MAX_SCORE
    },
    grading: {
      labels: normalizeLabels({}, DEFAULT_MAX_SCORE),
      globalLevels: DEFAULT_LEVELS.map((level) => ({ min: level.min, label: level.label }))
    },
    sections: []
  };
}

/* Every questionnaire passes through here before it reaches the UI: it repairs
   missing / malformed grading data and guarantees globally unique ids, so
   nothing downstream has to guess. */
function normalizeQuestionnaire(input) {
  const data = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const rawMeta = data.meta && typeof data.meta === 'object' ? data.meta : {};
  const rawGrading = data.grading && typeof data.grading === 'object' ? data.grading : {};

  const maxScore = clampMaxScore(rawMeta.maxScorePerQuestion);

  const usedIds = new Set();
  const sections = (Array.isArray(data.sections) ? data.sections : [])
    .filter((section) => section && typeof section === 'object')
    .map((section, sIndex) => {
      const sectionId = uniqueId(usedIds, section.id, 'section-' + (sIndex + 1));
      const questions = (Array.isArray(section.questions) ? section.questions : [])
        .filter((question) => question && typeof question === 'object')
        .map((question, qIndex) => ({
          id: uniqueId(usedIds, question.id, 'q-' + sectionId + '-' + (qIndex + 1)),
          label: toText(question.label),
          text: toText(question.text),
          expectedAnswer: toStringArray(question.expectedAnswer)
        }));

      return {
        id: sectionId,
        title: toText(section.title).trim() || 'Section ' + (sIndex + 1),
        description: toText(section.description),
        questions
      };
    });

  return {
    meta: {
      title: toText(rawMeta.title).trim() || 'Untitled questionnaire',
      subtitle: toText(rawMeta.subtitle),
      maxScorePerQuestion: maxScore
    },
    grading: {
      labels: normalizeLabels(rawGrading.labels, maxScore),
      globalLevels: normalizeLevels(rawGrading.globalLevels)
    },
    sections
  };
}

/* ------------------------------------------------------------------ */
/* Storage                                                             */
/* ------------------------------------------------------------------ */

function readStorage(key) {
  try {
    return localStorage.getItem(key);
  } catch (e) {
    console.warn('localStorage read failed for ' + key, e);
    return null;
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (e) {
    console.warn('localStorage write failed for ' + key, e);
    return false;
  }
}

function persistState() {
  if (!editorState) return;
  writeStorage(STORAGE_KEYS.config, JSON.stringify(editorState));
  writeStorage(STORAGE_KEYS.filename, currentQuestionnaireFileName || '');
  /* The questionnaire changed, so the rendered scorecard is stale. */
  interviewDirty = true;
}

function loadPersistedState() {
  const stored = readStorage(STORAGE_KEYS.config);
  if (!stored) return null;

  try {
    const parsed = JSON.parse(stored);
    currentQuestionnaireFileName = readStorage(STORAGE_KEYS.filename) || '';
    return normalizeQuestionnaire(parsed);
  } catch (e) {
    console.warn('Could not restore questionnaire from localStorage', e);
    return null;
  }
}

function emptyInterviewState() {
  return {
    answers: {},
    candidate: '',
    interviewer: '',
    date: new Date().toISOString().slice(0, 10),
    csvDelimiter: ';'
  };
}

function loadInterviewState() {
  const base = emptyInterviewState();
  const stored = readStorage(STORAGE_KEYS.answers);
  if (!stored) return base;

  try {
    const parsed = JSON.parse(stored);
    if (!parsed || typeof parsed !== 'object') return base;
    return {
      answers: parsed.answers && typeof parsed.answers === 'object' && !Array.isArray(parsed.answers)
        ? parsed.answers
        : {},
      candidate: toText(parsed.candidate),
      interviewer: toText(parsed.interviewer),
      date: toText(parsed.date) || base.date,
      csvDelimiter: parsed.csvDelimiter === ',' ? ',' : ';'
    };
  } catch (e) {
    console.warn('Could not restore interview answers from localStorage', e);
    return base;
  }
}

function saveInterviewState() {
  if (!interviewState) return;
  writeStorage(STORAGE_KEYS.answers, JSON.stringify(interviewState));
}

function scheduleSaveInterviewState() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveInterviewState();
  }, 250);
}

/* Called before any rebuild so a pending debounce can't lose the last keystrokes. */
function flushInterviewState() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  saveInterviewState();
}

function discardAnswers() {
  interviewState = emptyInterviewState();
  saveInterviewState();
}

function countAnswers() {
  if (!interviewState || !interviewState.answers) return 0;

  return Object.keys(interviewState.answers).filter((key) => {
    const entry = interviewState.answers[key];
    if (!entry || typeof entry !== 'object') return false;
    const scored = entry.score !== null && entry.score !== undefined;
    return scored || toText(entry.notes).trim() !== '';
  }).length;
}

function canReplaceAnswers(reason) {
  const answered = countAnswers();
  if (answered === 0) return true;

  return window.confirm(
    answered + ' answered question(s) are recorded.\n\n' +
    reason + '\n\nRecorded answers will be cleared. Continue?'
  );
}

/* Drops answers for questions that no longer exist, so a stale localStorage
   entry can never leak into a CSV export. */
function pruneAnswers(questionnaire) {
  const valid = new Set();
  questionnaire.sections.forEach((section) => {
    section.questions.forEach((question) => valid.add(question.id));
  });

  let removed = 0;
  Object.keys(interviewState.answers).forEach((key) => {
    if (!valid.has(key)) {
      delete interviewState.answers[key];
      removed += 1;
    }
  });

  if (removed) scheduleSaveInterviewState();
}

/* ------------------------------------------------------------------ */
/* Status helpers                                                      */
/* ------------------------------------------------------------------ */

function setLoadStatus(message, isError = false) {
  const el = document.getElementById('loadStatus');
  if (!el) return;
  el.textContent = message || '';
  el.style.color = isError ? 'var(--bad)' : '';
}

function setEditorStatus(message, isError = false) {
  const statusBox = document.getElementById('editorStatus');
  if (!statusBox) return;
  statusBox.textContent = message;
  statusBox.style.borderColor = isError ? 'var(--bad)' : 'var(--border)';
}

function makeUniqueId(prefix) {
  const used = new Set();
  if (editorState && Array.isArray(editorState.sections)) {
    editorState.sections.forEach((section) => {
      used.add(section.id);
      (section.questions || []).forEach((question) => used.add(question.id));
    });
  }

  let candidate;
  do {
    idCounter += 1;
    candidate = prefix + '-' + idCounter;
  } while (used.has(candidate));

  return candidate;
}

/* ------------------------------------------------------------------ */
/* View switching                                                      */
/* ------------------------------------------------------------------ */

function showView(view) {
  const interviewView = document.getElementById('interviewView');
  const editorView = document.getElementById('editorView');
  const openEditorBtn = document.getElementById('openEditorBtn');
  const backToInterviewBtn = document.getElementById('backToInterviewBtn');

  if (!interviewView || !editorView) return;

  if (view === 'editor') {
    interviewView.style.display = 'none';
    editorView.style.display = 'block';
    if (openEditorBtn) openEditorBtn.style.display = 'none';
    if (backToInterviewBtn) backToInterviewBtn.style.display = 'inline-flex';
    renderEditor();
    return;
  }

  interviewView.style.display = 'block';
  editorView.style.display = 'none';
  if (openEditorBtn) openEditorBtn.style.display = 'inline-flex';
  if (backToInterviewBtn) backToInterviewBtn.style.display = 'none';

  /* Rebuild only when the questionnaire actually changed: the DOM (and the
     unsaved notes still inside it) survives a simple view switch. */
  if (editorState && interviewDirty) {
    buildInterviewUI(editorState);
    interviewDirty = false;
  }
}

/* ------------------------------------------------------------------ */
/* Interview scorecard                                                 */
/* ------------------------------------------------------------------ */

function renderRatingInputs(maxScore, labels, groupName) {
  let html = '';
  for (let score = maxScore; score >= 0; score -= 1) {
    html += '<label><input type="radio" name="' + escapeHtml(groupName) + '" value="' + score + '"> '
      + escapeHtml(labels[String(score)]) + '</label>';
  }
  return html;
}

function applySavedAnswer(questionEl, maxScore) {
  const saved = interviewState.answers[questionEl.dataset.questionId];
  if (!saved || typeof saved !== 'object') return;

  const score = Number(saved.score);
  if (Number.isInteger(score) && score >= 0 && score <= maxScore) {
    const input = questionEl.querySelector('input[type="radio"][value="' + score + '"]');
    if (input) input.checked = true;
  }

  const notes = toText(saved.notes);
  if (notes) {
    const textarea = questionEl.querySelector('textarea');
    if (textarea) textarea.value = notes;
  }
}

function collectAnswers() {
  const answers = {};
  const questions = [...document.querySelectorAll('#app .question')];

  questions.forEach((questionEl) => {
    const checked = questionEl.querySelector('input[type="radio"]:checked');
    const score = checked ? Number(checked.value) : null;
    const notes = toText(questionEl.querySelector('textarea').value);
    if (score === null && !notes.trim()) return;
    answers[questionEl.dataset.questionId] = { score, notes };
  });

  interviewState.answers = answers;
  scheduleSaveInterviewState();
}

function syncInterviewMetaFromForm() {
  const candidateInput = document.getElementById('candidateInput');
  const interviewerInput = document.getElementById('interviewerInput');
  const dateInput = document.getElementById('interviewDateInput');

  if (candidateInput) interviewState.candidate = candidateInput.value.trim();
  if (interviewerInput) interviewState.interviewer = interviewerInput.value.trim();
  if (dateInput && dateInput.value) interviewState.date = dateInput.value;

  scheduleSaveInterviewState();
}

/* ------------------------------------------------------------------ */
/* CSV export                                                          */
/* ------------------------------------------------------------------ */

/* Neutralises spreadsheet formula injection: a note such as "=1+1" or
   "@SUM(A1)" must stay text when HR opens the file. */
function toCsvCell(cell) {
  let value = cell === null || cell === undefined ? '' : String(cell);
  const isNumber = value !== '' && !Number.isNaN(Number(value));
  if (value !== '' && !isNumber && /^[=+\-@\t\r]/.test(value)) {
    value = "'" + value;
  }
  return '"' + value.replaceAll('"', '""') + '"';
}

/* Grouped by section id, never by title: two sections sharing a title would
   otherwise both claim the same answers. */
function groupResponsesBySection(sections, responses, maxScore, levels) {
  return sections.map((section) => {
    const items = responses.filter((response) => response.sectionId === section.id);
    const max = items.length * maxScore;
    const score = items.reduce((sum, item) => sum + (item.points ?? 0), 0);
    const percent = max ? Math.round((score / max) * 100) : 0;
    return {
      domain: section.title,
      score,
      max,
      percent,
      level: getLevel(levels, percent)
    };
  });
}

function toCsv(result, requestedDelimiter) {
  const delimiter = requestedDelimiter === ',' ? ',' : ';';
  const rows = [];

  rows.push(['Title', result.meta.title]);
  rows.push(['Subtitle', result.meta.subtitle]);
  rows.push(['Candidate', result.meta.candidate]);
  rows.push(['Interviewer', result.meta.interviewer]);
  rows.push(['Interview date', result.meta.interviewDate]);
  rows.push(['Max score per question', result.meta.maxScorePerQuestion]);
  rows.push(['Exported at', result.meta.exportedAt]);
  rows.push([]);
  rows.push(['Total score', result.summary.totalScore, '/', result.summary.totalMax]);
  rows.push(['Overall rate', result.summary.ratio + '%']);
  rows.push(['Overall level', result.summary.level]);
  rows.push([]);
  rows.push(['Domain', 'Score', 'Max', 'Percentage', 'Level']);
  result.byDomain.forEach((domain) => {
    rows.push([domain.domain, domain.score, domain.max, domain.percent + '%', domain.level]);
  });
  rows.push([]);
  rows.push(['Question', 'Question text', 'Domain', 'Status', 'Points', 'Notes']);
  result.responses.forEach((response) => {
    rows.push([
      response.questionLabel,
      response.questionText,
      response.domain,
      response.status,
      response.points ?? '',
      response.notes
    ]);
  });

  const body = rows.map((row) => row.map(toCsvCell).join(delimiter)).join('\r\n');
  /* Excel honours this hint and stops guessing the separator. */
  return 'sep=' + delimiter + '\r\n' + body;
}

/* Colour band for the question card, on thirds of the scale so it stays
   meaningful for any maxScorePerQuestion:

     0          -> bad  (red)
     <= 1/3     -> bad
     >= 2/3     -> good (green)
     otherwise  -> mid  (yellow)

   Integer arithmetic, so no scale can hit a float comparison surprise. On the
   default 0-2 scale that reads 0 = red, 1 = yellow, 2 = green. */
function scoreBand(score, maxScore) {
  const max = Number(maxScore);
  if (!Number.isFinite(max) || max <= 0) return 'mid';
  if (score <= 0) return 'bad';
  if (score * 3 >= max * 2) return 'good';
  if (score * 3 <= max) return 'bad';
  return 'mid';
}

/* A different question from the colour band: this one is "worth raising in the
   debrief". Half marks stays a weak point even though it is only yellow, so
   the two rules are deliberately not the same threshold. */
function isWeakScore(score, maxScore) {
  return score <= maxScore / 2;
}

/* Class for the recap table's Status cell. The colour is derived from the score
   and never from the label text: grading.labels is questionnaire data, so it
   can be renamed or translated without the colours drifting. */
function statusClass(score, maxScore) {
  return score === null ? 'status-none' : 'status-' + scoreBand(score, maxScore);
}

/* One recap row, kept pure so both the escaping and the status colour are
   covered by the tests. Every field is escaped: all of them can come from a
   questionnaire file or from recruiter notes. */
function recapRow(row) {
  return `<tr>
        <td>${escapeHtml(row.label)}</td>
        <td>${escapeHtml(row.domain)}</td>
        <td class="status ${escapeHtml(row.statusClass)}">${escapeHtml(row.status)}</td>
        <td>${escapeHtml(row.points)}</td>
        <td>${row.notes ? escapeHtml(row.notes) : '<span class="muted">No notes</span>'}</td>
      </tr>`;
}

/* Composition of the recorded answers for the doughnut, best grade first.
   Unrated questions are kept as their own slice on purpose: a ring that
   silently dropped them would look complete when the interview is not. */
function gradeDistribution(responses, maxScore, labels) {
  const counts = new Map();
  let unrated = 0;

  responses.forEach((response) => {
    if (response.points === null) {
      unrated += 1;
      return;
    }
    counts.set(response.points, (counts.get(response.points) || 0) + 1);
  });

  const slices = [];
  for (let score = maxScore; score >= 0; score -= 1) {
    const count = counts.get(score) || 0;
    if (!count) continue;
    slices.push({
      name: labels[String(score)] || String(score),
      count: count,
      band: scoreBand(score, maxScore)
    });
  }

  if (unrated) slices.push({ name: 'Not rated', count: unrated, band: 'none' });
  return slices;
}

function buildInterviewUI(config) {
  const app = document.getElementById('app');
  if (!app || !interviewState) return;

  flushInterviewState();
  destroyCharts();

  const questionnaire = normalizeQuestionnaire(config);
  const maxScore = questionnaire.meta.maxScorePerQuestion;
  const labels = questionnaire.grading.labels;
  const totalQuestions = questionnaire.sections.reduce((sum, section) => sum + section.questions.length, 0);
  const totalMax = totalQuestions * maxScore;

  pruneAnswers(questionnaire);

  app.innerHTML = `
    <header class="hero">
      <h2 class="questionnaire-title">${escapeHtml(questionnaire.meta.title)}</h2>
      <p>${escapeHtml(questionnaire.meta.subtitle)}</p>
    </header>
    <div class="layout">
      <aside class="summary">
        <div class="card">
          <h2>Summary</h2>
          <div class="kpis">
            <div class="kpi"><span>Score</span><strong id="totalScore">0 / ${totalMax}</strong></div>
            <div class="kpi"><span>Completed</span><strong id="answeredCount">0 / ${totalQuestions}</strong></div>
          </div>
        </div>
        <div class="card">
          <h2>Levels by domain</h2>
          <ul id="domainLevels" class="compact-list"></ul>
        </div>
        <div class="card">
          <h2>Weak points</h2>
          <ul id="weaknesses" class="compact-list">
            <li>No weak points identified.</li>
          </ul>
        </div>
      </aside>
      <main class="main" id="questionnaire"></main>
    </div>
    <section class="card chart-card" id="chartCard">
      <h2>Score overview</h2>
      <div class="chart-grid chart-grid-no-radar" id="chartGrid">
        <div class="chart-verdict">
          <span class="chart-verdict-caption">Overall level</span>
          <strong class="chart-verdict-rate" id="ratio">0%</strong>
          <span class="chart-verdict-level" id="globalLevel">Pending</span>
        </div>
        <div class="chart-box chart-box-radar" hidden>
          <canvas id="domainChart" role="img" aria-label="Score percentage by domain"></canvas>
        </div>
        <div class="chart-box chart-box-ring" hidden>
          <canvas id="distributionChart" role="img" aria-label="Answer breakdown by grade"></canvas>
        </div>
      </div>
    </section>
    <section class="card recap-card">
      <div class="toolbar" style="justify-content: space-between;">
        <div>
          <h2 style="margin:0;">HR Summary</h2>
          <div class="helper">Export as CSV for easy sharing with HR / manager.</div>
        </div>
        <div class="toolbar" style="margin:0;">
          <button id="exportPdfBtn" type="button">Preview</button>
          <button id="exportResultBtn" type="button">Export CSV summary</button>
        </div>
      </div>
      <dialog id="csvSeparatorDialog" class="csv-separator-dialog" aria-labelledby="csvSeparatorTitle">
        <form method="dialog">
          <h3 id="csvSeparatorTitle">Choose CSV separator</h3>
          <p>Which separator should this export use?</p>
          <div class="csv-separator-actions">
            <button type="button" data-csv-delimiter=";">Semicolon (;)</button>
            <button type="button" data-csv-delimiter=",">Comma (,)</button>
          </div>
          <button class="dialog-cancel" value="cancel">Cancel</button>
        </form>
      </dialog>
      <div class="recap-meta">
        <div class="form-row">
          <label for="candidateInput">Candidate</label>
          <input type="text" id="candidateInput" value="${escapeHtml(interviewState.candidate)}" placeholder="Candidate name" />
        </div>
        <div class="form-row">
          <label for="interviewerInput">Interviewer</label>
          <input type="text" id="interviewerInput" value="${escapeHtml(interviewState.interviewer)}" placeholder="Interviewer name" />
        </div>
        <div class="form-row">
          <label for="interviewDateInput">Interview date</label>
          <input type="date" id="interviewDateInput" value="${escapeHtml(interviewState.date)}" />
        </div>
      </div>
      <div class="table-wrap">
        <table class="recap-table">
          <thead>
            <tr>
              <th>Question</th>
              <th>Domain</th>
              <th>Status</th>
              <th>Points</th>
              <th>Answer / notes</th>
            </tr>
          </thead>
          <tbody id="recapTableBody"></tbody>
        </table>
      </div>
    </section>
  `;

  const questionnaireEl = document.getElementById('questionnaire');

  questionnaire.sections.forEach((section, sIndex) => {
    const sectionEl = document.createElement('section');
    sectionEl.className = 'card section-card';
    sectionEl.dataset.sectionId = section.id;
    sectionEl.innerHTML = `
      <h2>${escapeHtml(section.title)}</h2>
      <p class="muted">${escapeHtml(section.description)}</p>
      <div class="section-score" data-section-score>0 / ${section.questions.length * maxScore} (0%)</div>
    `;

    section.questions.forEach((question, qIndex) => {
      const questionEl = document.createElement('div');
      questionEl.className = 'question';
      questionEl.dataset.questionId = question.id;
      questionEl.dataset.sectionId = section.id;
      questionEl.dataset.label = question.label;
      questionEl.dataset.text = question.text;
      questionEl.dataset.domain = section.title;
      questionEl.innerHTML = `
        <h3>${escapeHtml(question.label)}</h3>
        <p>${escapeHtml(question.text)}</p>
        <div class="rating">${renderRatingInputs(maxScore, labels, 'q-' + sIndex + '-' + qIndex)}</div>
        <textarea placeholder="Observed answer / recruiter notes"></textarea>
        <details>
          <summary>Expected answer</summary>
          <ul>${question.expectedAnswer.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
        </details>
      `;

      applySavedAnswer(questionEl, maxScore);
      sectionEl.appendChild(questionEl);
    });

    questionnaireEl.appendChild(sectionEl);
  });

  function getQuestionScore(questionEl) {
    const checked = questionEl.querySelector('input[type="radio"]:checked');
    return checked ? Number(checked.value) : null;
  }

  function collectResult() {
    const questions = [...document.querySelectorAll('#app .question')];
    const responses = questions.map((questionEl) => {
      const score = getQuestionScore(questionEl);
      const notes = toText(questionEl.querySelector('textarea').value).trim();
      return {
        questionId: questionEl.dataset.questionId,
        sectionId: questionEl.dataset.sectionId,
        questionLabel: questionEl.dataset.label,
        questionText: questionEl.dataset.text,
        domain: questionEl.dataset.domain,
        status: score === null ? 'Not rated' : labels[String(score)],
        points: score,
        notes
      };
    });

    const totalScore = responses.reduce((sum, item) => sum + (item.points ?? 0), 0);
    const ratio = totalMax ? Math.round((totalScore / totalMax) * 100) : 0;

    const byDomain = groupResponsesBySection(
      questionnaire.sections,
      responses,
      maxScore,
      questionnaire.grading.globalLevels
    );

    return {
      meta: {
        title: questionnaire.meta.title,
        subtitle: questionnaire.meta.subtitle,
        candidate: interviewState.candidate,
        interviewer: interviewState.interviewer,
        interviewDate: interviewState.date,
        exportedAt: new Date().toISOString(),
        maxScorePerQuestion: maxScore
      },
      summary: {
        totalQuestions,
        totalScore,
        totalMax,
        ratio,
        level: getLevel(questionnaire.grading.globalLevels, ratio)
      },
      byDomain,
      responses
    };
  }

  /* Reads the same collectResult() as the sidebar and the CSV, so the chart
     can never disagree with them. */
  function renderCharts() {
    const Chart = window.Chart;
    const grid = document.getElementById('chartGrid');
    const radarCanvas = document.getElementById('domainChart');
    const ringCanvas = document.getElementById('distributionChart');
    if (typeof Chart !== 'function' || !grid || !radarCanvas || !ringCanvas) return;

    const result = collectResult();
    const colors = themeColors();
    const bands = bandColors(colors);
    const levels = questionnaire.grading.globalLevels;

    /* Percentage per domain, one radar axis each. Below three axes a radar is
       degenerate, so it is dropped and the room goes to the ring. */
    const radarBox = document.querySelector('#chartCard .chart-box-radar');
    const ringBox = document.querySelector('#chartCard .chart-box-ring');
    const showRadar = result.byDomain.length >= 3;

    /* hidden only, never an inline display: the two would fight each other. */
    if (radarBox) radarBox.hidden = !showRadar;
    if (ringBox) ringBox.hidden = false;
    grid.className = 'chart-grid' + (showRadar ? ' chart-grid-full' : ' chart-grid-no-radar');

    if (!showRadar && domainChartInstance) {
      domainChartInstance.destroy();
      domainChartInstance = null;
    }

    const radarData = {
      labels: result.byDomain.map((domain) => shortenLabel(domain.domain)),
      datasets: [{
        label: 'Score %',
        data: result.byDomain.map((domain) => domain.percent),
        borderColor: colors.accent,
        backgroundColor: withAlpha(colors.accent, 0.18),
        borderWidth: 2,
        pointBackgroundColor: result.byDomain.map((domain) => bands[levelBand(levels, domain.percent)]),
        pointBorderColor: colors.accent,
        pointRadius: 4,
        pointHoverRadius: 7
      }]
    };

    const radarOptions = {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 220 },
      interaction: { intersect: false },
      scales: {
        r: {
          min: 0,
          max: 100,
          ticks: { stepSize: 25, display: false, backdropColor: 'transparent' },
          angleLines: { color: colors.grid },
          grid: { color: colors.grid },
          pointLabels: {
            color: colors.text,
            font: { size: 12, weight: '600' },
            padding: 10
          }
        }
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => result.byDomain[items[0].dataIndex].domain,
            label: (context) => {
              const domain = result.byDomain[context.dataIndex];
              return domain.score + ' / ' + domain.max + ' (' + domain.percent + '%) - ' + domain.level;
            }
          }
        }
      }
    };

    const distribution = gradeDistribution(result.responses, maxScore, labels);
    const ringData = {
      labels: distribution.map((slice) => slice.name),
      datasets: [{
        data: distribution.map((slice) => slice.count),
        backgroundColor: distribution.map((slice) => {
          if (slice.band === 'good') return colors.ok;
          if (slice.band === 'mid') return colors.warn;
          if (slice.band === 'bad') return colors.bad;
          return 'rgba(148, 163, 184, 0.42)';
        }),
        borderWidth: 0
      }]
    };

    const ringOptions = {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '68%',
      animation: { duration: 220 },
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            color: colors.text,
            usePointStyle: true,
            boxWidth: 9,
            padding: 10
          }
        },
        tooltip: {
          callbacks: {
            label: (context) => {
              const slice = distribution[context.dataIndex];
              const total = result.summary.totalQuestions;
              const pct = total ? Math.round((slice.count / total) * 100) : 0;
              return slice.name + ': ' + slice.count + ' (' + pct + '%)';
            }
          }
        }
      }
    };

    if (domainChartInstance) {
      domainChartInstance.data = radarData;
      /* Tooltip callbacks close over `result`. Refresh the options too, or a
         changed rating would keep displaying the values from the first draw. */
      domainChartInstance.options = radarOptions;
      domainChartInstance.update();
    } else {
      domainChartInstance = new Chart(radarCanvas, { type: 'radar', data: radarData, options: radarOptions });
    }

    if (ringChartInstance) {
      ringChartInstance.data = ringData;
      /* Same principle for the answer-breakdown percentage in its tooltip. */
      ringChartInstance.options = ringOptions;
      ringChartInstance.update();
    } else {
      ringChartInstance = new Chart(ringCanvas, { type: 'doughnut', data: ringData, options: ringOptions });
    }
  }

  function exportResultCsv(delimiter) {
    interviewState.csvDelimiter = delimiter === ',' ? ',' : ';';
    syncInterviewMetaFromForm();

    const csv = toCsv(collectResult(), interviewState.csvDelimiter);
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'interview-recap.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  function pdfFilename() {
    return 'interview-recap.pdf';
  }

  /* Printable dashboard: the same summary, charts, weak points and recap as
     the live scorecard, rather than the long questionnaire itself. */
  function buildPdfReport(result) {
    const colorForBand = (band) => ({ good: '#16a34a', mid: '#ca8a04', bad: '#dc2626', none: '#94a3b8' }[band] || '#38bdf8');
    const barChart = (title, items) => `<section class="pdf-chart"><h3>${escapeHtml(title)}</h3>${items.length
      ? items.map((item) => `<div class="pdf-bar-row"><span>${escapeHtml(item.label)}</span><div class="pdf-bar-track"><i style="width:${Math.max(0, Math.min(100, item.value))}%;background:${colorForBand(item.band)}"></i></div><b>${item.valueLabel}</b></div>`).join('')
      : '<p class="pdf-muted">No data available.</p>'}</section>`;

    const domainRows = result.byDomain.map((domain) => `<tr>
      <td>${escapeHtml(domain.domain)}</td><td>${domain.score} / ${domain.max}</td><td>${domain.percent}%</td><td>${escapeHtml(domain.level)}</td>
    </tr>`).join('');
    const domainChart = result.byDomain.map((domain) => ({
      label: domain.domain,
      value: domain.percent,
      valueLabel: domain.percent + '%',
      band: levelBand(questionnaire.grading.globalLevels, domain.percent)
    }));
    const distribution = gradeDistribution(result.responses, maxScore, labels);
    const distributionChart = distribution.map((slice) => ({
      label: slice.name,
      value: result.summary.totalQuestions ? Math.round((slice.count / result.summary.totalQuestions) * 100) : 0,
      valueLabel: slice.count + ' (' + (result.summary.totalQuestions ? Math.round((slice.count / result.summary.totalQuestions) * 100) : 0) + '%)',
      band: slice.band
    }));
    const chartSnapshot = (canvasId, label) => {
      const canvas = document.getElementById(canvasId);
      if (!canvas || !canvas.width || !canvas.height || canvas.parentElement.hidden) return '';

      const chart = canvasId === 'domainChart' ? domainChartInstance : ringChartInstance;
      const changes = [];
      try {
        /* The live charts use light labels for the dark UI. Make a white-paper
           snapshot instead, without changing the scorecard after export. */
        if (chart && canvasId === 'domainChart') {
          const radial = chart.options.scales && chart.options.scales.r;
          if (radial && radial.pointLabels && radial.angleLines && radial.grid) {
            changes.push([radial.pointLabels, 'color', radial.pointLabels.color]);
            changes.push([radial.angleLines, 'color', radial.angleLines.color]);
            changes.push([radial.grid, 'color', radial.grid.color]);
            radial.pointLabels.color = '#172033';
            radial.angleLines.color = '#cbd5e1';
            radial.grid.color = '#cbd5e1';
          }
        } else if (chart) {
          const legendLabels = chart.options.plugins && chart.options.plugins.legend && chart.options.plugins.legend.labels;
          if (legendLabels) {
            changes.push([legendLabels, 'color', legendLabels.color]);
            legendLabels.color = '#172033';
          }
        }
        if (chart && changes.length) chart.update('none');

        if (chart && canvasId === 'distributionChart') {
          const arcs = chart.getDatasetMeta(0).data;
          const context = canvas.getContext('2d');
          context.save();
          context.font = '700 13px Arial, sans-serif';
          context.textAlign = 'center';
          context.textBaseline = 'middle';
          arcs.forEach((arc, index) => {
            const slice = distribution[index];
            if (!slice || !slice.count) return;
            const percent = result.summary.totalQuestions
              ? Math.round((slice.count / result.summary.totalQuestions) * 100)
              : 0;
            const angle = (arc.startAngle + arc.endAngle) / 2;
            const radius = (arc.innerRadius + arc.outerRadius) / 2;
            const x = arc.x + Math.cos(angle) * radius;
            const y = arc.y + Math.sin(angle) * radius;
            context.lineWidth = 4;
            context.strokeStyle = 'rgba(255, 255, 255, 0.9)';
            context.strokeText(percent + '%', x, y);
            context.fillStyle = '#172033';
            context.fillText(percent + '%', x, y);
          });
          context.restore();
        }

        const image = document.createElement('canvas');
        image.width = canvas.width;
        image.height = canvas.height;
        const context = image.getContext('2d');
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, image.width, image.height);
        context.drawImage(canvas, 0, 0);
        return `<figure class="pdf-score-chart"><img src="${image.toDataURL('image/png')}" alt="${escapeHtml(label)}"><figcaption>${escapeHtml(label)}</figcaption></figure>`;
      } catch (error) {
        console.warn('Unable to include score overview chart in PDF preview:', error);
        return '';
      } finally {
        changes.forEach(([target, property, value]) => { target[property] = value; });
        if (chart && changes.length) chart.update('none');
      }
    };
    const visualCharts = [
      chartSnapshot('domainChart', 'Score by domain'),
      chartSnapshot('distributionChart', 'Answer breakdown')
    ].filter(Boolean).join('');
    const chartsHtml = visualCharts || barChart('Score by domain', domainChart) + barChart('Answer breakdown', distributionChart);
    const weakPoints = result.responses.filter((response) => response.points !== null && isWeakScore(response.points, maxScore));
    const weakHtml = weakPoints.length
      ? '<ul>' + weakPoints.map((response) => '<li>' + escapeHtml(response.questionLabel) + ' - ' + response.points + '/' + maxScore + '</li>').join('') + '</ul>'
      : '<p class="pdf-muted">No weak points identified.</p>';
    const recapRows = result.responses.map((response) => `<tr>
      <td>${escapeHtml(response.questionLabel)}</td><td>${escapeHtml(response.domain)}</td><td class="pdf-status-${statusClass(response.points, maxScore).replace('status-', '')}">${escapeHtml(response.status)}</td><td>${response.points === null ? '-' : response.points + ' / ' + maxScore}</td><td>${response.notes ? escapeHtml(response.notes).replaceAll('\n', '<br>') : '<span class="pdf-muted">No notes</span>'}</td>
    </tr>`).join('');

    const report = document.createElement('article');
    report.className = 'pdf-export-source';
    report.innerHTML = `<style>
      .pdf-export-source { width: 760px; background: #fff; color: #172033; font: 12px/1.45 Arial, sans-serif; padding: 34px; }
      .pdf-export-source * { box-sizing: border-box; }
      .pdf-export-source h1 { margin: 0 0 5px; font-size: 25px; color: #111827; }
      .pdf-export-source h2 { margin: 22px 0 8px; font-size: 18px; color: #111827; }
      .pdf-export-source h3 { margin: 0 0 8px; font-size: 13px; color: #111827; }
      .pdf-export-source p { margin: 6px 0; }
      .pdf-export-source table { width: 100%; min-width: 0; border-collapse: collapse; margin: 10px 0 18px; }
      .pdf-export-source th, .pdf-export-source td { border: 1px solid #cbd5e1; padding: 7px; text-align: left; vertical-align: top; }
      .pdf-export-source th { background: #eaf3f8; }
      .pdf-export-source thead { display: table-header-group; }
      .pdf-export-source tr { break-inside: avoid; page-break-inside: avoid; }
      .pdf-status-good { background: #dcfce7; color: #166534; font-weight: 700; }
      .pdf-status-mid { background: #fef9c3; color: #854d0e; font-weight: 700; }
      .pdf-status-bad { background: #fee2e2; color: #991b1b; font-weight: 700; }
      .pdf-status-none { background: #f1f5f9; color: #64748b; }
      .pdf-meta { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 18px; margin: 18px 0; }
      .pdf-summary { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin: 18px 0; }
      .pdf-summary div, .pdf-panel { border: 1px solid #cbd5e1; border-radius: 6px; padding: 9px; }
      .pdf-summary span, .pdf-muted { color: #64748b; }
      .pdf-summary strong { display: block; font-size: 16px; color: #111827; }
      .pdf-panel h2, .pdf-recap h2 { margin-top: 0; }
      .pdf-panel { margin-top: 14px; }
      .pdf-chart-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; align-items: start; }
      .pdf-chart { width: 100%; border: 1px solid #cbd5e1; border-radius: 6px; padding: 10px; break-inside: avoid; page-break-inside: avoid; }
      .pdf-score-chart { width: 100%; min-width: 0; margin: 0; padding: 8px; border: 1px solid #cbd5e1; border-radius: 6px; background: #fff; color: #172033; text-align: center; break-inside: avoid; page-break-inside: avoid; }
      .pdf-score-chart img { display: block; width: 100%; height: 220px; object-fit: contain; }
      .pdf-score-chart figcaption { margin-top: 3px; font-size: 11px; font-weight: 700; }
      .pdf-bar-row { display: grid; grid-template-columns: minmax(75px, 1fr) 2fr auto; gap: 6px; align-items: center; margin: 7px 0; font-size: 10px; }
      .pdf-bar-track { height: 10px; overflow: hidden; border-radius: 99px; background: #e2e8f0; }
      .pdf-bar-track i { display: block; height: 100%; border-radius: inherit; }
      .pdf-recap { break-before: page; page-break-before: always; }
      .pdf-recap-inline { margin-top: 18px; }
      .pdf-recap-inline h2 { margin: 0 0 8px; }
      .pdf-recap-inline table { margin-bottom: 0; }
      .pdf-export-source ul { margin: 6px 0 0; padding-left: 19px; }
      .print-weakness-page ul { columns: 2; column-gap: 28px; column-fill: auto; }
      .print-weakness-page li { margin: 0 0 10px; padding-right: 4px; overflow-wrap: anywhere; break-inside: avoid; page-break-inside: avoid; }
    </style>
    <header><h1>${escapeHtml(result.meta.title)}</h1><p class="pdf-muted">${escapeHtml(result.meta.subtitle)}</p></header>
    <div class="pdf-meta"><div><strong>Candidate:</strong> ${escapeHtml(result.meta.candidate || 'Not specified')}</div><div><strong>Interviewer:</strong> ${escapeHtml(result.meta.interviewer || 'Not specified')}</div><div><strong>Interview date:</strong> ${escapeHtml(result.meta.interviewDate || 'Not specified')}</div><div><strong>Generated:</strong> ${escapeHtml(new Date(result.meta.exportedAt).toLocaleString())}</div></div>
    <section><h2>Score overview</h2><div class="pdf-summary"><div><span>Score</span><strong>${result.summary.totalScore} / ${result.summary.totalMax}</strong></div><div><span>Rate</span><strong>${result.summary.ratio}%</strong></div><div><span>Level</span><strong>${escapeHtml(result.summary.level)}</strong></div></div></section>
    <section class="pdf-chart-grid">${chartsHtml}</section>
    <section><h2>Levels by domain</h2><table><thead><tr><th>Domain</th><th>Score</th><th>Rate</th><th>Level</th></tr></thead><tbody>${domainRows}</tbody></table></section>
    <section class="pdf-panel pdf-weaknesses"><h2>Weak points</h2>${weakHtml}</section>
    <section class="pdf-recap"><h2>HR summary</h2><table><thead><tr><th>Question</th><th>Domain</th><th>Status</th><th>Points</th><th>Answer / notes</th></tr></thead><tbody>${recapRows}</tbody></table></section>`;
    return report;
  }

  function exportResultPdf() {
    syncInterviewMetaFromForm();
    const printWindow = window.open('', 'scorecard-pdf');
    if (!printWindow) {
      window.alert('The print window was blocked. Allow pop-ups for this page and try again.');
      return;
    }

    const result = collectResult();
    const report = buildPdfReport(result);
    const title = escapeHtml(pdfFilename().replace(/\.pdf$/i, ''));

    /* Same native-print approach as cv.devroede.dev: show the actual A4 pages
       first, then let the user choose when to open the browser print dialog. */
    printWindow.document.open();
    let previewPrepared = false;
    const preparePrintPreview = () => {
      if (previewPrepared) return;
      /* Wait for fonts, canvas snapshots and CSS layout. Measuring inside the
         load callback itself is too early in Chromium and misses overflow. */
      printWindow.requestAnimationFrame(() => printWindow.requestAnimationFrame(() => {
        const previewDocument = printWindow.document;
        const recap = previewDocument.querySelector('.pdf-recap');
        const weaknesses = previewDocument.querySelector('.pdf-weaknesses');
        const preview = previewDocument.getElementById('printPreview');
        if (!recap || !preview) {
          window.setTimeout(preparePrintPreview, 25);
          return;
        }
        previewPrepared = true;
        const overflows = (sheet, content) => {
          const style = printWindow.getComputedStyle(sheet);
          const usableBottom = sheet.getBoundingClientRect().bottom - parseFloat(style.paddingBottom || '0');
          return content.getBoundingClientRect().bottom > usableBottom + 0.5;
        };

        /* Build both the dashboard and recap into physical A4 sheets. This keeps
           the screen preview honest: no overflow can be silently cropped. */
        const header = recap.querySelector('thead').innerHTML;
        const rows = [...recap.querySelectorAll('tbody tr')];
        recap.remove();
        const weaknessItems = weaknesses ? [...weaknesses.querySelectorAll('li')] : [];
        if (weaknessItems.length) weaknesses.remove();

        const firstPage = preview.querySelector('.print-page');
        const firstSource = firstPage && firstPage.querySelector('.pdf-export-source');
        if (firstPage && firstSource) {
          const blocks = [...firstSource.children].filter((child) => child.tagName !== 'STYLE');
          blocks.forEach((block) => block.remove());

          let dashboardPage = firstPage;
          let dashboardSource = firstSource;
          let blockCount = 0;
          const addDashboardPage = () => {
            dashboardPage = previewDocument.createElement('section');
            dashboardPage.className = 'print-page';
            dashboardSource = previewDocument.createElement('article');
            dashboardSource.className = 'pdf-export-source';
            dashboardPage.appendChild(dashboardSource);
            preview.appendChild(dashboardPage);
            blockCount = 0;
          };

          blocks.forEach((block) => {
            dashboardSource.appendChild(block);
            blockCount += 1;
            if (overflows(dashboardPage, dashboardSource) && blockCount > 1) {
              dashboardSource.removeChild(block);
              addDashboardPage();
              dashboardSource.appendChild(block);
              blockCount = 1;
            }
          });
        }

        /* Weak points can be numerous, so split the list item by item instead
           of allowing one tall card to run through the bottom of an A4 page. */
        let weaknessPage;
        let weaknessSource;
        if (weaknessItems.length) {
          let weaknessList;
          const addWeaknessPage = (continued) => {
            weaknessPage = previewDocument.createElement('section');
            weaknessPage.className = 'print-page print-weakness-page';
            weaknessSource = previewDocument.createElement('article');
            weaknessSource.className = 'pdf-export-source';
            weaknessSource.innerHTML = `<section class="pdf-panel"><h2>Weak points${continued ? ' (continued)' : ''}</h2><ul></ul></section>`;
            weaknessPage.appendChild(weaknessSource);
            preview.appendChild(weaknessPage);
            weaknessList = weaknessSource.querySelector('ul');
          };

          addWeaknessPage(false);
          weaknessItems.forEach((item) => {
            weaknessList.appendChild(item);
            if (overflows(weaknessPage, weaknessSource) && weaknessList.children.length > 1) {
              item.remove();
              addWeaknessPage(true);
              weaknessList.appendChild(item);
            }
          });
        }

        let page;
        let body;
        let recapIsInline = false;
        const addPage = (includeTitle) => {
          page = previewDocument.createElement('section');
          page.className = 'print-page print-recap-page';
          page.innerHTML = `<article class="pdf-export-source">${includeTitle ? '<h2>HR summary</h2>' : '<h2>HR summary (continued)</h2>'}<table><thead>${header}</thead><tbody></tbody></table></article>`;
          preview.appendChild(page);
          body = page.querySelector('tbody');
        };

        /* Use the remaining room on the final weak-points page before opening
           a dedicated recap sheet.  A table header is kept with the first row
           so the recap is still legible when only part of it fits. */
        if (weaknessPage && weaknessSource) {
          const inlineRecap = previewDocument.createElement('section');
          inlineRecap.className = 'pdf-recap-inline';
          inlineRecap.innerHTML = `<h2>HR summary</h2><table><thead>${header}</thead><tbody></tbody></table>`;
          weaknessSource.appendChild(inlineRecap);

          if (overflows(weaknessPage, inlineRecap.querySelector('table'))) {
            inlineRecap.remove();
            addPage(true);
          } else {
            page = weaknessPage;
            body = inlineRecap.querySelector('tbody');
            recapIsInline = true;
          }
        } else {
          addPage(true);
        }

        rows.forEach((row) => {
          body.appendChild(row);
          if (overflows(page, page.querySelector('table'))) {
            /* The header may fit in the remaining space while its first row
               does not. In that case, keep the recap together on a new page. */
            if (recapIsInline && body.children.length === 1) {
              body.closest('.pdf-recap-inline').remove();
              addPage(true);
              body.appendChild(row);
              recapIsInline = false;
            } else if (body.children.length > 1) {
              body.removeChild(row);
              addPage(false);
              body.appendChild(row);
              recapIsInline = false;
            }
          }
        });
      }));
    };
    printWindow.document.write(`<!doctype html>
      <html lang="en"><head><meta charset="utf-8"><title>${title}</title>
      <style>
        @page { size: A4 portrait; margin: 0; }
        html, body { margin: 0; padding: 0; }
        body { background: #e2e8f0; }
        body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        .print-page { box-sizing: border-box; width: 210mm; height: 297mm; margin: 10mm auto; padding: 10mm; overflow: hidden; background: #fff; box-shadow: 0 2mm 8mm rgba(15, 23, 42, .2); break-after: page; page-break-after: always; }
        .print-page:last-child { break-after: auto; page-break-after: auto; }
        .pdf-export-source { width: auto !important; margin: 0; padding: 0 !important; }
        .print-recap-page h2 { margin-top: 0; }
        .print-weakness-page h2 { margin-top: 0; }
        @media print {
          body { background: #fff; }
          /* The preview pages are the actual print pages: keeping their exact
             size prevents Chrome from recalculating and clipping weak points. */
          .print-page { margin: 0; box-shadow: none; }
        }
      </style></head><body><main id="printPreview"><section class="print-page">${report.outerHTML}</section></main></body></html>`);
    printWindow.document.close();
    /* Run after the newly written document is active; reused pop-up windows
       can otherwise fire a stale load event before document.write(). */
    window.setTimeout(preparePrintPreview, 50);
  }

  function update() {
    const questions = [...document.querySelectorAll('#app .question')];
    let answered = 0;
    let totalScore = 0;
    const weaknesses = [];

    questions.forEach((questionEl) => {
      const score = getQuestionScore(questionEl);

      /* Clears any previous score-* band whatever the scale is. */
      Array.from(questionEl.classList).forEach((className) => {
        if (className.startsWith('score-')) questionEl.classList.remove(className);
      });

      if (score !== null) {
        answered += 1;
        totalScore += score;
        questionEl.classList.add('score-rated');
        questionEl.classList.add('score-' + scoreBand(score, maxScore));
        if (isWeakScore(score, maxScore)) {
          weaknesses.push(questionEl.dataset.label + ' (' + score + '/' + maxScore + ')');
        }
      } else {
        questionEl.classList.add('score-unrated');
      }
    });

    const ratio = totalMax ? Math.round((totalScore / totalMax) * 100) : 0;
    document.getElementById('totalScore').textContent = totalScore + ' / ' + totalMax;
    document.getElementById('answeredCount').textContent = answered + ' / ' + totalQuestions;
    document.getElementById('ratio').textContent = ratio + '%';

    /* "Pending" means nothing has been rated yet, not "rated zero everywhere". */
    const levelEl = document.getElementById('globalLevel');
    const rated = answered > 0;
    levelEl.textContent = rated ? getLevel(questionnaire.grading.globalLevels, ratio) : 'Pending';
    /* Same colour rule as the radar points, so the verdict and the shape agree. */
    levelEl.className = 'chart-verdict-level' + (rated ? ' level-' + levelBand(questionnaire.grading.globalLevels, ratio) : '');

    /* Owned here, not in renderCharts: that one never runs without the CDN, and
       a card showing a lone 0% would be worse than no card at all. */
    document.getElementById('chartCard').style.display = totalQuestions ? '' : 'none';

    const weakUl = document.getElementById('weaknesses');
    weakUl.innerHTML = weaknesses.length
      ? weaknesses.map((item) => `<li>${escapeHtml(item)}</li>`).join('')
      : '<li>No weak points identified.</li>';

    const domainLevels = document.getElementById('domainLevels');
    domainLevels.innerHTML = '';

    document.querySelectorAll('#app .section-card').forEach((sectionEl) => {
      const sectionQuestions = [...sectionEl.querySelectorAll('.question')];
      const max = sectionQuestions.length * maxScore;
      const score = sectionQuestions.reduce((sum, questionEl) => sum + (getQuestionScore(questionEl) ?? 0), 0);
      const percent = max ? Math.round((score / max) * 100) : 0;
      const title = sectionEl.querySelector('h2').textContent;
      sectionEl.querySelector('[data-section-score]').textContent = score + ' / ' + max + ' (' + percent + '%)';

      const li = document.createElement('li');
      li.textContent = title + ': ' + percent + '% (' + getLevel(questionnaire.grading.globalLevels, percent) + ')';
      domainLevels.appendChild(li);
    });

    const recapBody = document.getElementById('recapTableBody');
    recapBody.innerHTML = questions.map((questionEl) => {
      const score = getQuestionScore(questionEl);
      return recapRow({
        label: questionEl.dataset.label,
        domain: questionEl.dataset.domain,
        status: score === null ? 'Not rated' : labels[String(score)],
        statusClass: statusClass(score, maxScore),
        points: score === null ? '-' : String(score),
        notes: toText(questionEl.querySelector('textarea').value).trim()
      });
    }).join('');

    collectAnswers();
    renderCharts();
  }

  const scheduleUpdate = (function debouncedUpdate() {
    let timer = null;
    return () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        update();
      }, 200);
    };
  })();

  document.querySelectorAll('#app input[type="radio"]').forEach((input) => {
    input.addEventListener('change', update);
  });

  document.querySelectorAll('#app textarea').forEach((textarea) => {
    /* State is captured synchronously so leaving the tab can never lose the
       last keystrokes; only the heavy recap re-render is debounced. */
    textarea.addEventListener('input', () => {
      collectAnswers();
      scheduleUpdate();
    });
  });

  ['candidateInput', 'interviewerInput', 'interviewDateInput'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', syncInterviewMetaFromForm);
  });

  const exportBtn = document.getElementById('exportResultBtn');
  const csvSeparatorDialog = document.getElementById('csvSeparatorDialog');
  if (exportBtn) {
    exportBtn.addEventListener('click', () => csvSeparatorDialog.showModal());
  }

  if (csvSeparatorDialog) {
    csvSeparatorDialog.querySelectorAll('[data-csv-delimiter]').forEach((button) => {
      button.addEventListener('click', () => {
        exportResultCsv(button.dataset.csvDelimiter);
        csvSeparatorDialog.close();
      });
    });
  }

  const exportPdfBtn = document.getElementById('exportPdfBtn');
  if (exportPdfBtn) {
    exportPdfBtn.addEventListener('click', exportResultPdf);
  }

  update();

  /* The chart library is fetched once, after the scorecard is interactive, so
     a slow or unreachable CDN can never delay an interview. */
  ensureChartLibrary().then((Chart) => {
    if (Chart) renderCharts();
  });
}

/* ------------------------------------------------------------------ */
/* Editor                                                              */
/* ------------------------------------------------------------------ */

function hydrateEditorForm() {
  const titleInput = document.getElementById('titleInput');
  const subtitleInput = document.getElementById('subtitleInput');
  const maxScoreInput = document.getElementById('maxScoreInput');
  if (!titleInput || !subtitleInput || !editorState) return;

  titleInput.value = editorState.meta.title || '';
  subtitleInput.value = editorState.meta.subtitle || '';
  if (maxScoreInput) maxScoreInput.value = editorState.meta.maxScorePerQuestion;
  renderGradingLabelsEditor();
  renderGlobalLevelsEditor();
  renderSectionsEditor();
  renderPreview();
}

function renderGradingLabelsEditor() {
  const container = document.getElementById('gradingLabelsEditor');
  if (!container || !editorState) return;

  const maxScore = editorState.meta.maxScorePerQuestion;
  editorState.grading.labels = normalizeLabels(editorState.grading.labels, maxScore);
  container.innerHTML = Array.from({ length: maxScore + 1 }, (_, score) => maxScore - score)
    .map((score) => `<label class="grading-label">
      <span>${score} / ${maxScore}</span>
      <input type="text" data-score-label="${score}" value="${escapeHtml(editorState.grading.labels[String(score)])}" />
    </label>`).join('');

  container.querySelectorAll('[data-score-label]').forEach((input) => {
    input.addEventListener('input', () => {
      const score = input.dataset.scoreLabel;
      editorState.grading.labels[score] = input.value.trim() || defaultLabelFor(Number(score), maxScore);
      persistState();
      renderPreview();
    });
  });
}

function renderGlobalLevelsEditor() {
  const container = document.getElementById('globalLevelsEditor');
  if (!container || !editorState) return;

  editorState.grading.globalLevels = normalizeLevels(editorState.grading.globalLevels);
  container.innerHTML = editorState.grading.globalLevels.map((level, index) => {
    const isRequired = level.min === 0;
    return `<div class="global-level">
      <label for="globalLevelMin-${index}">
        <span>Minimum (%)</span>
        <input type="number" id="globalLevelMin-${index}" min="0" max="100" step="1" value="${level.min}" data-global-level-min="${index}"${isRequired ? ' disabled' : ''} />
      </label>
      <label for="globalLevelLabel-${index}">
        <span>Label</span>
        <input type="text" id="globalLevelLabel-${index}" value="${escapeHtml(level.label)}" data-global-level-label="${index}" />
      </label>
      <button type="button" data-global-level-delete="${index}"${isRequired ? ' disabled title="The 0% level is required"' : ''}>Delete</button>
    </div>`;
  }).join('');

  container.querySelectorAll('[data-global-level-min]').forEach((input) => {
    input.addEventListener('input', () => {
      const index = Number(input.dataset.globalLevelMin);
      const level = editorState.grading.globalLevels[index];
      if (!level) return;
      level.min = input.value;
      persistState();
      setEditorStatus('Changes saved.');
    });
    input.addEventListener('change', () => {
      editorState.grading.globalLevels = normalizeLevels(editorState.grading.globalLevels);
      persistState();
      renderGlobalLevelsEditor();
      renderPreview();
    });
  });

  container.querySelectorAll('[data-global-level-label]').forEach((input) => {
    input.addEventListener('input', () => {
      const index = Number(input.dataset.globalLevelLabel);
      const level = editorState.grading.globalLevels[index];
      if (!level) return;
      level.label = input.value;
      persistState();
      renderPreview();
      setEditorStatus('Changes saved.');
    });
  });

  container.querySelectorAll('[data-global-level-delete]').forEach((button) => {
    button.addEventListener('click', () => {
      const index = Number(button.dataset.globalLevelDelete);
      const level = editorState.grading.globalLevels[index];
      if (!level || level.min === 0) return;
      editorState.grading.globalLevels.splice(index, 1);
      editorState.grading.globalLevels = normalizeLevels(editorState.grading.globalLevels);
      persistState();
      renderGlobalLevelsEditor();
      renderPreview();
      setEditorStatus('Level removed.');
    });
  });
}

function nextAvailableLevelMin(levels) {
  const used = new Set(levels.map((level) => Number(level.min)));
  for (let min = 100; min >= 0; min -= 1) {
    if (!used.has(min)) return min;
  }
  return 100;
}

function syncEditorMeta() {
  const titleInput = document.getElementById('titleInput');
  const subtitleInput = document.getElementById('subtitleInput');
  const maxScoreInput = document.getElementById('maxScoreInput');
  if (!editorState || !titleInput || !subtitleInput) return;

  const previousMaxScore = clampMaxScore(editorState.meta.maxScorePerQuestion);
  const nextMaxScore = clampMaxScore(maxScoreInput ? maxScoreInput.value : previousMaxScore);
  document.querySelectorAll('#gradingLabelsEditor [data-score-label]').forEach((input) => {
    const score = input.dataset.scoreLabel;
    editorState.grading.labels[score] = input.value.trim() || defaultLabelFor(Number(score), previousMaxScore);
  });

  editorState.meta.title = titleInput.value.trim();
  editorState.meta.subtitle = subtitleInput.value.trim();
  editorState.meta.maxScorePerQuestion = nextMaxScore;
  editorState.grading.labels = nextMaxScore === previousMaxScore
    ? normalizeLabels(editorState.grading.labels, nextMaxScore)
    : labelsForScaleChange(editorState.grading.labels, nextMaxScore);
  editorState.grading.globalLevels = normalizeLevels(editorState.grading.globalLevels);

  if (maxScoreInput) maxScoreInput.value = editorState.meta.maxScorePerQuestion;

  persistState();
  if (nextMaxScore !== previousMaxScore) renderGradingLabelsEditor();
  renderPreview();
}

function renderSectionsEditor() {
  const sectionsList = document.getElementById('sectionsList');
  if (!sectionsList || !editorState) return;

  sectionsList.innerHTML = '';
  if (!editorState.sections.length) {
    sectionsList.innerHTML = '<div class="empty">No sections yet.</div>';
    return;
  }

  editorState.sections.forEach((section, sIndex) => {
    const wrapper = document.createElement('div');
    wrapper.className = 'list-item';
    wrapper.innerHTML = `
      <div class="toolbar" style="justify-content: space-between;">
        <div>
          <strong>Section ${sIndex + 1}</strong>
          <span class="badge">${escapeHtml(section.id)}</span>
        </div>
        <div class="toolbar" style="margin:0;">
          <button type="button" data-action="move-section-up" data-section="${sIndex}" title="Move section up" aria-label="Move section ${sIndex + 1} up">↑</button>
          <button type="button" data-action="move-section-down" data-section="${sIndex}" title="Move section down" aria-label="Move section ${sIndex + 1} down">↓</button>
          <button type="button" data-action="delete-section" data-section="${sIndex}" title="Delete section" aria-label="Delete section ${sIndex + 1}">Delete</button>
        </div>
      </div>

      <div class="inline-grid" style="margin-top:12px;">
        <div class="form-row">
          <label for="sectionTitle-${sIndex}">Section title</label>
          <input type="text" id="sectionTitle-${sIndex}" data-field="section-title" data-section="${sIndex}" value="${escapeHtml(section.title)}" />
        </div>
        <div class="form-row">
          <label for="sectionId-${sIndex}">Identifier</label>
          <input type="text" id="sectionId-${sIndex}" data-field="section-id" data-section="${sIndex}" value="${escapeHtml(section.id)}" />
        </div>
      </div>

      <div class="form-row" style="margin-top:12px;">
        <label for="sectionDescription-${sIndex}">Description</label>
        <textarea id="sectionDescription-${sIndex}" data-field="section-description" data-section="${sIndex}">${escapeHtml(section.description)}</textarea>
      </div>

      <div class="list-box" style="margin-top:12px;">
        <div class="toolbar" style="justify-content: space-between;">
          <h4 style="margin:0;">Questions</h4>
          <button type="button" data-action="add-question" data-section="${sIndex}">Add question</button>
        </div>
        <div data-question-list="${sIndex}"></div>
      </div>
    `;
    sectionsList.appendChild(wrapper);

    const questionList = wrapper.querySelector('[data-question-list="' + sIndex + '"]');
    if (!section.questions.length) {
      questionList.innerHTML = '<div class="empty">No questions in this section.</div>';
      return;
    }

    section.questions.forEach((question, qIndex) => {
      const questionEl = document.createElement('div');
      questionEl.className = 'list-item';
      questionEl.innerHTML = `
        <div class="toolbar" style="justify-content: space-between;">
          <div>
            <strong>Question ${qIndex + 1}</strong>
            <span class="badge">${escapeHtml(question.id)}</span>
          </div>
          <div class="toolbar" style="margin:0;">
            <button type="button" data-action="move-question-up" data-section="${sIndex}" data-question="${qIndex}" title="Move question up" aria-label="Move question ${qIndex + 1} up">↑</button>
            <button type="button" data-action="move-question-down" data-section="${sIndex}" data-question="${qIndex}" title="Move question down" aria-label="Move question ${qIndex + 1} down">↓</button>
            <button type="button" data-action="delete-question" data-section="${sIndex}" data-question="${qIndex}" title="Delete question" aria-label="Delete question ${qIndex + 1}">Delete</button>
          </div>
        </div>

        <div class="inline-grid" style="margin-top:12px;">
          <div class="form-row">
            <label for="questionLabel-${sIndex}-${qIndex}">Label</label>
            <input type="text" id="questionLabel-${sIndex}-${qIndex}" data-field="question-label" data-section="${sIndex}" data-question="${qIndex}" value="${escapeHtml(question.label)}" />
          </div>
          <div class="form-row">
            <label for="questionId-${sIndex}-${qIndex}">Identifier</label>
            <input type="text" id="questionId-${sIndex}-${qIndex}" data-field="question-id" data-section="${sIndex}" data-question="${qIndex}" value="${escapeHtml(question.id)}" />
          </div>
        </div>

        <div class="form-row" style="margin-top:12px;">
          <label for="questionText-${sIndex}-${qIndex}">Question</label>
          <textarea id="questionText-${sIndex}-${qIndex}" data-field="question-text" data-section="${sIndex}" data-question="${qIndex}">${escapeHtml(question.text)}</textarea>
        </div>

        <div class="form-row" style="margin-top:12px;">
          <label for="questionAnswers-${sIndex}-${qIndex}">Expected answers (one line = one expected point)</label>
          <textarea id="questionAnswers-${sIndex}-${qIndex}" data-field="question-answers" data-section="${sIndex}" data-question="${qIndex}">${escapeHtml(question.expectedAnswer.join('\n'))}</textarea>
        </div>
      `;
      questionList.appendChild(questionEl);
    });
  });

  bindDynamicEditorEvents();
}

function bindDynamicEditorEvents() {
  const sectionsList = document.getElementById('sectionsList');
  if (!sectionsList || !editorState) return;

  sectionsList.querySelectorAll('[data-field]').forEach((input) => {
    input.addEventListener('input', (event) => {
      const field = event.target.dataset.field;
      const sIndex = Number(event.target.dataset.section);
      const qIndex = event.target.dataset.question !== undefined ? Number(event.target.dataset.question) : null;
      const value = event.target.value;
      const section = editorState.sections[sIndex];

      if (!section) return;

      if (field === 'section-title') section.title = value;
      if (field === 'section-id') section.id = value;
      if (field === 'section-description') section.description = value;

      const question = qIndex === null ? null : section.questions[qIndex];
      if (question) {
        if (field === 'question-label') question.label = value;
        if (field === 'question-id') question.id = value;
        if (field === 'question-text') question.text = value;
        if (field === 'question-answers') {
          question.expectedAnswer = value.split('\n').map((line) => line.trim()).filter(Boolean);
        }
      }

      persistState();
      renderPreview();
      setEditorStatus('Changes saved.');
    });
  });

  sectionsList.querySelectorAll('[data-action]').forEach((button) => {
    button.addEventListener('click', () => {
      const action = button.dataset.action;
      const sIndex = Number(button.dataset.section);
      const qIndex = button.dataset.question !== undefined ? Number(button.dataset.question) : null;
      const section = editorState.sections[sIndex];

      if (!section) return;

      if (action === 'delete-section') {
        const total = editorState.sections.reduce((sum, item) => sum + item.questions.length, 0);
        if (!window.confirm('Delete "' + (section.title || 'this section') + '" and its '
          + section.questions.length + ' question(s) (currently ' + total + ' in the questionnaire)?')) {
          return;
        }
        editorState.sections.splice(sIndex, 1);
      }
      if (action === 'move-section-up' && sIndex > 0) {
        [editorState.sections[sIndex - 1], editorState.sections[sIndex]] = [editorState.sections[sIndex], editorState.sections[sIndex - 1]];
      }
      if (action === 'move-section-down' && sIndex < editorState.sections.length - 1) {
        [editorState.sections[sIndex + 1], editorState.sections[sIndex]] = [editorState.sections[sIndex], editorState.sections[sIndex + 1]];
      }
      if (action === 'add-question') {
        section.questions.push({
          id: makeUniqueId('q'),
          label: 'New question',
          text: '',
          expectedAnswer: []
        });
      }
      if (action === 'delete-question' && section.questions[qIndex]) {
        if (!window.confirm('Delete "' + (section.questions[qIndex].label || 'this question') + '"?')) {
          return;
        }
        section.questions.splice(qIndex, 1);
      }
      if (action === 'move-question-up' && qIndex > 0) {
        const arr = section.questions;
        [arr[qIndex - 1], arr[qIndex]] = [arr[qIndex], arr[qIndex - 1]];
      }
      if (action === 'move-question-down' && qIndex < section.questions.length - 1) {
        const arr = section.questions;
        [arr[qIndex + 1], arr[qIndex]] = [arr[qIndex], arr[qIndex + 1]];
      }

      persistState();
      renderSectionsEditor();
      renderPreview();
      setEditorStatus('Structure updated.');
    });
  });
}

function renderPreview() {
  const preview = document.getElementById('preview');
  if (!preview || !editorState) return;

  const sectionCount = editorState.sections.length;
  const questionCount = editorState.sections.reduce((sum, section) => sum + section.questions.length, 0);
  const maxScore = editorState.meta.maxScorePerQuestion;
  const totalMax = questionCount * maxScore;
  const levels = normalizeLevels(editorState.grading.globalLevels);

  preview.innerHTML = `
    <div class="list-item">
      <strong>${escapeHtml(editorState.meta.title || 'Untitled')}</strong><br>
      <span class="helper">${escapeHtml(editorState.meta.subtitle || '')}</span>
      <p style="margin:8px 0 0;">${sectionCount} section(s) · ${questionCount} question(s) · ${totalMax} point(s) max (${maxScore} per question)</p>
      <p class="helper" style="margin:8px 0 0;">Levels: ${levels.map((level) => escapeHtml(level.label) + ' ≥ ' + level.min + '%').join(' · ')}</p>
    </div>
    ${editorState.sections.map((section) => `
      <div class="list-item">
        <h3 style="margin:0 0 6px 0;">${escapeHtml(section.title || 'Untitled section')}</h3>
        <p class="helper">${escapeHtml(section.description || '')}</p>
        ${section.questions.length ? `
          <ul class="compact-list">
            ${section.questions.map((question) => `
              <li>
                <strong>${escapeHtml(question.label || 'No label')}</strong><br>
                ${escapeHtml(question.text || '')}
              </li>
            `).join('')}
          </ul>
        ` : '<div class="empty">No questions.</div>'}
      </div>
    `).join('')}
  `;
}

function renderEditor() {
  if (!editorState) {
    editorState = emptyState();
  }
  hydrateEditorForm();
}

/* ------------------------------------------------------------------ */
/* Loading, creating, exporting                                        */
/* ------------------------------------------------------------------ */

function loadQuestionnaireFromObject(data, filename = '') {
  if (!canReplaceAnswers('Loading a different questionnaire.')) return false;

  discardAnswers();
  editorState = normalizeQuestionnaire(data);
  currentQuestionnaireFileName = filename || currentQuestionnaireFileName || '';
  persistState();
  buildInterviewUI(editorState);
  interviewDirty = false;
  renderEditor();
  setLoadStatus(currentQuestionnaireFileName || 'Questionnaire loaded');
  setEditorStatus('Questionnaire loaded.');
  return true;
}

function newQuestionnaire() {
  if (!canReplaceAnswers('Starting a new questionnaire.')) return;

  discardAnswers();
  editorState = emptyState();
  currentQuestionnaireFileName = '';
  persistState();
  buildInterviewUI(editorState);
  interviewDirty = false;
  renderEditor();
  setEditorStatus('New questionnaire created.');
  setLoadStatus('New questionnaire');
}

function readQuestionnaireFile(file) {
  return file.text()
    .then((text) => {
      loadQuestionnaireFromObject(JSON.parse(text), file.name || '');
    })
    .catch((error) => {
      setLoadStatus('Unable to load: ' + error.message, true);
      setEditorStatus('Unable to load: ' + error.message, true);
    });
}

function onInterviewFileSelected() {
  const fileInput = document.getElementById('configFileInput');
  const file = fileInput && fileInput.files ? fileInput.files[0] : null;

  if (!file) {
    setLoadStatus('Select a questionnaire file first.');
    return;
  }

  readQuestionnaireFile(file);
}

/* Rebuilds the scorecard from the in-memory questionnaire. Answers are kept
   only if the user explicitly agrees to drop them. */
function refreshInterviewView() {
  if (!editorState) {
    setLoadStatus('Select a questionnaire file first.');
    return;
  }

  if (!canReplaceAnswers('Rebuilding the scorecard.')) return;

  discardAnswers();
  buildInterviewUI(editorState);
  interviewDirty = false;
  setLoadStatus(currentQuestionnaireFileName || 'Scorecard rebuilt');
}

function loadSelectedEditorFile() {
  const fileInput = document.getElementById('fileInput');
  const file = fileInput && fileInput.files ? fileInput.files[0] : null;

  if (!file) {
    setEditorStatus('Select a file before loading.', true);
    return;
  }

  readQuestionnaireFile(file);
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function exportQuestionnaire() {
  try {
    syncEditorMeta();
    const blob = new Blob([JSON.stringify(editorState, null, 2)], { type: 'application/json' });
    triggerDownload(blob, currentQuestionnaireFileName || 'questionnaire.json');
    setEditorStatus('Questionnaire exported.');
  } catch (error) {
    setEditorStatus('Unable to export: ' + error.message, true);
  }
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

function setupApp() {
  const openEditorBtn = document.getElementById('openEditorBtn');
  const backToInterviewBtn = document.getElementById('backToInterviewBtn');
  const loadBtn = document.getElementById('loadConfigBtn');
  const configFileInput = document.getElementById('configFileInput');
  const editorFileInput = document.getElementById('fileInput');
  const newQuestionnaireBtn = document.getElementById('newQuestionnaireBtn');
  const exportBtn = document.getElementById('exportBtn');
  const addSectionBtn = document.getElementById('addSectionBtn');
  const addGlobalLevelBtn = document.getElementById('addGlobalLevelBtn');
  const titleInput = document.getElementById('titleInput');
  const subtitleInput = document.getElementById('subtitleInput');
  const maxScoreInput = document.getElementById('maxScoreInput');

  if (openEditorBtn) {
    openEditorBtn.addEventListener('click', () => {
      flushInterviewState();
      persistState();
      showView('editor');
    });
  }

  if (backToInterviewBtn) {
    backToInterviewBtn.addEventListener('click', () => {
      syncEditorMeta();
      flushInterviewState();
      showView('interview');
    });
  }

  if (loadBtn) {
    loadBtn.addEventListener('click', refreshInterviewView);
  }

  if (configFileInput) {
    configFileInput.addEventListener('change', onInterviewFileSelected);
  }

  if (editorFileInput) {
    editorFileInput.addEventListener('change', loadSelectedEditorFile);
  }

  if (newQuestionnaireBtn) {
    newQuestionnaireBtn.addEventListener('click', newQuestionnaire);
  }

  if (exportBtn) {
    exportBtn.addEventListener('click', exportQuestionnaire);
  }

  if (addSectionBtn) {
    addSectionBtn.addEventListener('click', () => {
      if (!editorState) editorState = emptyState();
      editorState.sections.push({
        id: makeUniqueId('section'),
        title: 'New section',
        description: '',
        questions: []
      });
      persistState();
      renderSectionsEditor();
      renderPreview();
      setEditorStatus('Section added.');
    });
  }

  if (addGlobalLevelBtn) {
    addGlobalLevelBtn.addEventListener('click', () => {
      if (!editorState) editorState = emptyState();
      editorState.grading.globalLevels = normalizeLevels(editorState.grading.globalLevels);
      editorState.grading.globalLevels.push({
        min: nextAvailableLevelMin(editorState.grading.globalLevels),
        label: 'New level'
      });
      editorState.grading.globalLevels = normalizeLevels(editorState.grading.globalLevels);
      persistState();
      renderGlobalLevelsEditor();
      renderPreview();
      setEditorStatus('Level added.');
    });
  }

  if (titleInput) {
    titleInput.addEventListener('input', syncEditorMeta);
  }

  if (subtitleInput) {
    subtitleInput.addEventListener('input', syncEditorMeta);
  }

  if (maxScoreInput) {
    maxScoreInput.addEventListener('change', syncEditorMeta);
  }

  window.addEventListener('beforeunload', flushInterviewState);

  interviewState = loadInterviewState();
  editorState = loadPersistedState() || emptyState();

  showView('interview');
  setLoadStatus(currentQuestionnaireFileName || (editorState.sections.length ? 'Questionnaire ready' : 'Select a questionnaire file.'));
}

window.addEventListener('DOMContentLoaded', setupApp);
