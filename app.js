function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function getLevel(levels, percent) {
  return levels.find((level) => percent >= level.min)?.label ?? 'Unknown';
}

function uid(prefix) {
  return prefix + '-' + Math.random().toString(36).slice(2, 9);
}

function emptyState() {
  return {
    meta: {
      title: 'New questionnaire',
      subtitle: 'Describe the context of the test here',
      maxScorePerQuestion: 2
    },
    grading: {
      labels: { "2": "Correct", "1": "Partial", "0": "Incorrect" },
      globalLevels: [
        { min: 85, label: 'Very strong' },
        { min: 70, label: 'Good' },
        { min: 50, label: 'Average / needs improvement' },
        { min: 0, label: 'Insufficient' }
      ]
    },
    sections: []
  };
}

let editorState = null;
let currentQuestionnaireFileName = '';

function persistState() {
  try {
    if (editorState) {
      localStorage.setItem('app.interview.config', JSON.stringify(editorState));
      localStorage.setItem('app.interview.filename', currentQuestionnaireFileName || '');
    }
  } catch (e) {
    console.warn('Could not persist questionnaire to localStorage', e);
  }
}

function loadPersistedState() {
  try {
    const stored = localStorage.getItem('app.interview.config');
    if (stored) {
      const parsed = JSON.parse(stored);
      currentQuestionnaireFileName = localStorage.getItem('app.interview.filename') || '';
      return parsed;
    }
  } catch (e) {
    console.warn('Could not restore questionnaire from localStorage', e);
  }
  return null;
}

function setLoadStatus(message) {
  const el = document.getElementById('loadStatus');
  if (el) el.textContent = message || '';
}

function setEditorStatus(message, isError = false) {
  const statusBox = document.getElementById('editorStatus');
  if (!statusBox) return;
  statusBox.textContent = message;
  statusBox.style.borderColor = isError ? 'var(--bad)' : 'var(--border)';
}

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
  } else {
    interviewView.style.display = 'block';
    editorView.style.display = 'none';
    if (openEditorBtn) openEditorBtn.style.display = 'inline-flex';
    if (backToInterviewBtn) backToInterviewBtn.style.display = 'none';
    if (editorState) {
      buildInterviewUI(editorState);
    }
  }
}

function normalizeQuestionnaire(data) {
  if (!data.meta) data.meta = {};
  if (!data.grading) {
    data.grading = {
      labels: { "2": "Correct", "1": "Partial", "0": "Incorrect" },
      globalLevels: [
        { min: 85, label: 'Very strong' },
        { min: 70, label: 'Good' },
        { min: 50, label: 'Average / needs improvement' },
        { min: 0, label: 'Insufficient' }
      ]
    };
  }
  if (!Array.isArray(data.sections)) data.sections = [];
  data.meta.maxScorePerQuestion = Number(data.meta.maxScorePerQuestion || 2);

  data.sections = data.sections.map((section) => ({
    id: section.id || uid('section'),
    title: section.title || '',
    description: section.description || '',
    questions: Array.isArray(section.questions) ? section.questions.map((question) => ({
      id: question.id || uid('q'),
      label: question.label || '',
      text: question.text || '',
      expectedAnswer: Array.isArray(question.expectedAnswer) ? question.expectedAnswer : []
    })) : []
  }));

  return data;
}

function buildInterviewUI(config) {
  const app = document.getElementById('app');
  if (!app) return;

  const totalQuestions = config.sections.reduce((sum, section) => sum + section.questions.length, 0);
  const totalMax = totalQuestions * (config.meta.maxScorePerQuestion || 2);

  app.innerHTML = `
    <header class="hero">
      <h1>${escapeHtml(config.meta.title || 'Questionnaire')}</h1>
      <p>${escapeHtml(config.meta.subtitle || '')}</p>
    </header>
    <div class="layout">
      <aside class="summary">
        <div class="card">
          <h2>Summary</h2>
          <div class="kpis">
            <div class="kpi"><span>Score</span><strong id="totalScore">0 / ${totalMax}</strong></div>
            <div class="kpi"><span>Completed</span><strong id="answeredCount">0 / ${totalQuestions}</strong></div>
            <div class="kpi"><span>Rate</span><strong id="ratio">0%</strong></div>
            <div class="kpi"><span>Level</span><strong id="globalLevel">Pending</strong></div>
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
    <section class="card recap-card">
      <div class="toolbar" style="justify-content: space-between;">
        <div>
          <h2 style="margin:0;">HR Summary</h2>
          <div class="helper">Export as CSV for easy sharing with HR / manager.</div>
        </div>
        <div class="toolbar" style="margin:0;">
          <button id="exportResultBtn" type="button">Export CSV summary</button>
          <input type="text" id="resultFilename" value="interview-recap.csv" style="width:220px;" />
        </div>
      </div>
      <div class="table-wrap">
        <table>
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

  const questionnaire = document.getElementById('questionnaire');

  config.sections.forEach((section) => {
    const sectionEl = document.createElement('section');
    sectionEl.className = 'card section-card';
    sectionEl.dataset.sectionId = section.id;
    sectionEl.innerHTML = `
      <h2>${escapeHtml(section.title)}</h2>
      <p class="muted">${escapeHtml(section.description || '')}</p>
      <div class="section-score" data-section-score>0 / ${section.questions.length * (config.meta.maxScorePerQuestion || 2)} (0%)</div>
    `;

    section.questions.forEach((question) => {
      const q = document.createElement('div');
      q.className = 'question';
      q.dataset.questionId = question.id;
      q.dataset.label = question.label;
      q.dataset.domain = section.title;
      q.dataset.text = question.text;
      q.innerHTML = `
        <h3>${escapeHtml(question.label)}</h3>
        <p>${escapeHtml(question.text)}</p>
        <div class="rating">
          <label><input type="radio" name="${question.id}" value="2"> ${escapeHtml(config.grading.labels["2"])}</label>
          <label><input type="radio" name="${question.id}" value="1"> ${escapeHtml(config.grading.labels["1"])}</label>
          <label><input type="radio" name="${question.id}" value="0"> ${escapeHtml(config.grading.labels["0"])}</label>
        </div>
        <textarea placeholder="Observed answer / recruiter notes"></textarea>
        <details>
          <summary>Expected answer</summary>
          <ul>${(question.expectedAnswer || []).map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
        </details>
      `;
      sectionEl.appendChild(q);
    });

    questionnaire.appendChild(sectionEl);
  });

  function getQuestionScore(questionEl) {
    const checked = questionEl.querySelector('input[type="radio"]:checked');
    return checked ? Number(checked.value) : null;
  }

  function collectResult() {
    const questions = [...document.querySelectorAll('#app .question')];
    const responses = questions.map((q) => {
      const score = getQuestionScore(q);
      const notes = q.querySelector('textarea').value.trim();
      const status = score === null ? 'Not rated' : config.grading.labels[String(score)];
      return {
        questionId: q.dataset.questionId,
        questionLabel: q.dataset.label,
        questionText: q.dataset.text,
        domain: q.dataset.domain,
        status,
        points: score,
        notes
      };
    });

    const totalScore = responses.reduce((sum, item) => sum + (item.points ?? 0), 0);
    const ratio = totalMax ? Math.round((totalScore / totalMax) * 100) : 0;

    const byDomain = config.sections.map((section) => {
      const items = responses.filter((r) => r.domain === section.title);
      const max = items.length * (config.meta.maxScorePerQuestion || 2);
      const score = items.reduce((sum, item) => sum + (item.points ?? 0), 0);
      const percent = max ? Math.round((score / max) * 100) : 0;
      return {
        domain: section.title,
        score,
        max,
        percent,
        level: getLevel(config.grading.globalLevels, percent)
      };
    });

    return {
      meta: {
        title: config.meta.title,
        subtitle: config.meta.subtitle,
        exportedAt: new Date().toISOString()
      },
      summary: {
        totalQuestions,
        totalScore,
        totalMax,
        ratio,
        level: getLevel(config.grading.globalLevels, ratio)
      },
      byDomain,
      responses
    };
  }

  function toCsv(result) {
    const rows = [];
    rows.push(['Title', result.meta.title]);
    rows.push(['Subtitle', result.meta.subtitle]);
    rows.push(['Exported at', result.meta.exportedAt]);
    rows.push([]);
    rows.push(['Total score', result.summary.totalScore, '/', result.summary.totalMax]);
    rows.push(['Overall rate', `${result.summary.ratio}%`]);
    rows.push(['Overall level', result.summary.level]);
    rows.push([]);
    rows.push(['Domain', 'Score', 'Max', 'Percentage', 'Level']);
    result.byDomain.forEach((d) => rows.push([d.domain, d.score, d.max, `${d.percent}%`, d.level]));
    rows.push([]);
    rows.push(['Question', 'Domain', 'Status', 'Points', 'Answer / notes']);
    result.responses.forEach((r) => rows.push([
      r.questionLabel,
      r.domain,
      r.status,
      r.points ?? '',
      r.notes
    ]));

    return rows.map((row) =>
      row.map((cell) => {
        const value = cell == null ? '' : String(cell);
        return `"${value.replaceAll('"', '""')}"`;
      }).join(';')
    ).join('\n');
  }

  function exportResultCsv() {
    const data = collectResult();
    const csv = toCsv(data);
    const blob = new Blob(["\ufeff" + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const filenameInput = document.getElementById('resultFilename');
    a.href = url;
    a.download = filenameInput.value.trim() || 'interview-recap.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  function update() {
    const questions = [...document.querySelectorAll('#app .question')];
    let answered = 0;
    let totalScore = 0;
    const weaknesses = [];

    questions.forEach((q) => {
      const score = getQuestionScore(q);
      q.classList.remove('score-0', 'score-1', 'score-2');
      if (score !== null) {
        answered += 1;
        totalScore += score;
        q.classList.add(`score-${score}`);
        if (score <= 1) weaknesses.push(q.dataset.label);
      }
    });

    const ratio = totalMax ? Math.round((totalScore / totalMax) * 100) : 0;
    document.getElementById('totalScore').textContent = `${totalScore} / ${totalMax}`;
    document.getElementById('answeredCount').textContent = `${answered} / ${totalQuestions}`;
    document.getElementById('ratio').textContent = `${ratio}%`;
    document.getElementById('globalLevel').textContent = getLevel(config.grading.globalLevels, ratio);

    const weakUl = document.getElementById('weaknesses');
    weakUl.innerHTML = weaknesses.length
      ? weaknesses.map(item => `<li>${escapeHtml(item)}</li>`).join('')
      : '<li>No weak points identified.</li>';

    const domainLevels = document.getElementById('domainLevels');
    domainLevels.innerHTML = '';

    document.querySelectorAll('#app .section-card').forEach((sectionEl) => {
      const sectionQuestions = [...sectionEl.querySelectorAll('.question')];
      const max = sectionQuestions.length * (config.meta.maxScorePerQuestion || 2);
      const score = sectionQuestions.reduce((sum, q) => sum + (getQuestionScore(q) ?? 0), 0);
      const percent = max ? Math.round((score / max) * 100) : 0;
      const title = sectionEl.querySelector('h2').textContent;
      sectionEl.querySelector('[data-section-score]').textContent = `${score} / ${max} (${percent}%)`;

      const li = document.createElement('li');
      li.textContent = `${title}: ${percent}% (${getLevel(config.grading.globalLevels, percent)})`;
      domainLevels.appendChild(li);
    });

    const recapBody = document.getElementById('recapTableBody');
    recapBody.innerHTML = questions.map((q) => {
      const score = getQuestionScore(q);
      const notes = q.querySelector('textarea').value.trim();
      const status = score === null ? 'Not rated' : config.grading.labels[String(score)];
      const points = score === null ? '-' : String(score);
      return `
        <tr>
          <td>${escapeHtml(q.dataset.label)}</td>
          <td>${escapeHtml(q.dataset.domain)}</td>
          <td>${escapeHtml(status)}</td>
          <td>${escapeHtml(points)}</td>
          <td>${notes ? escapeHtml(notes) : '<span class="muted">No notes</span>'}</td>
        </tr>
      `;
    }).join('');
  }

  document.querySelectorAll('#app input[type="radio"]').forEach((input) => {
    input.addEventListener('change', update);
  });

  document.querySelectorAll('#app textarea').forEach((textarea) => {
    textarea.addEventListener('input', update);
  });

  const exportBtn = document.getElementById('exportResultBtn');
  if (exportBtn) {
    exportBtn.addEventListener('click', exportResultCsv);
  }

  update();
}

function hydrateEditorForm() {
  const titleInput = document.getElementById('titleInput');
  const subtitleInput = document.getElementById('subtitleInput');
  if (!titleInput || !subtitleInput || !editorState) return;

  titleInput.value = editorState.meta.title || '';
  subtitleInput.value = editorState.meta.subtitle || '';
  renderSectionsEditor();
  renderPreview();
}

function syncEditorMeta() {
  const titleInput = document.getElementById('titleInput');
  const subtitleInput = document.getElementById('subtitleInput');
  if (!editorState || !titleInput || !subtitleInput) return;

  editorState.meta.title = titleInput.value.trim();
  editorState.meta.subtitle = subtitleInput.value.trim();
  editorState.meta.maxScorePerQuestion = 2;
  persistState();
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
          <button type="button" data-action="move-section-up" data-section="${sIndex}">↑</button>
          <button type="button" data-action="move-section-down" data-section="${sIndex}">↓</button>
          <button type="button" data-action="delete-section" data-section="${sIndex}">Delete</button>
        </div>
      </div>

      <div class="inline-grid" style="margin-top:12px;">
        <div class="form-row">
          <label>Section title</label>
          <input type="text" data-field="section-title" data-section="${sIndex}" value="${escapeHtml(section.title || '')}" />
        </div>
        <div class="form-row">
          <label>Identifier</label>
          <input type="text" data-field="section-id" data-section="${sIndex}" value="${escapeHtml(section.id || '')}" />
        </div>
      </div>

      <div class="form-row" style="margin-top:12px;">
        <label>Description</label>
        <textarea data-field="section-description" data-section="${sIndex}">${escapeHtml(section.description || '')}</textarea>
      </div>

      <div class="list-box" style="margin-top:12px;">
        <div class="toolbar" style="justify-content: space-between;">
          <h4 style="margin:0;">Questions</h4>
          <button type="button" data-action="add-question" data-section="${sIndex}">Add question</button>
        </div>
        <div id="questionList-${sIndex}"></div>
      </div>
    `;
    sectionsList.appendChild(wrapper);

    const questionList = wrapper.querySelector(`#questionList-${sIndex}`);
    if (!section.questions.length) {
      questionList.innerHTML = '<div class="empty">No questions in this section.</div>';
    } else {
      section.questions.forEach((question, qIndex) => {
        const q = document.createElement('div');
        q.className = 'list-item';
        q.innerHTML = `
          <div class="toolbar" style="justify-content: space-between;">
            <div>
              <strong>Question ${qIndex + 1}</strong>
              <span class="badge">${escapeHtml(question.id)}</span>
            </div>
            <div class="toolbar" style="margin:0;">
              <button type="button" data-action="move-question-up" data-section="${sIndex}" data-question="${qIndex}">↑</button>
              <button type="button" data-action="move-question-down" data-section="${sIndex}" data-question="${qIndex}">↓</button>
              <button type="button" data-action="delete-question" data-section="${sIndex}" data-question="${qIndex}">Delete</button>
            </div>
          </div>

          <div class="inline-grid" style="margin-top:12px;">
            <div class="form-row">
              <label>Label</label>
              <input type="text" data-field="question-label" data-section="${sIndex}" data-question="${qIndex}" value="${escapeHtml(question.label || '')}" />
            </div>
            <div class="form-row">
              <label>Identifier</label>
              <input type="text" data-field="question-id" data-section="${sIndex}" data-question="${qIndex}" value="${escapeHtml(question.id || '')}" />
            </div>
          </div>

          <div class="form-row" style="margin-top:12px;">
            <label>Question</label>
            <textarea data-field="question-text" data-section="${sIndex}" data-question="${qIndex}">${escapeHtml(question.text || '')}</textarea>
          </div>

          <div class="form-row" style="margin-top:12px;">
            <label>Expected answers (one line = one expected point)</label>
            <textarea data-field="question-answers" data-section="${sIndex}" data-question="${qIndex}">${escapeHtml((question.expectedAnswer || []).join('\n'))}</textarea>
          </div>
        `;
        questionList.appendChild(q);
      });
    }
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

      if (field === 'section-title') editorState.sections[sIndex].title = value;
      if (field === 'section-id') editorState.sections[sIndex].id = value;
      if (field === 'section-description') editorState.sections[sIndex].description = value;
      if (field === 'question-label') editorState.sections[sIndex].questions[qIndex].label = value;
      if (field === 'question-id') editorState.sections[sIndex].questions[qIndex].id = value;
      if (field === 'question-text') editorState.sections[sIndex].questions[qIndex].text = value;
      if (field === 'question-answers') {
        editorState.sections[sIndex].questions[qIndex].expectedAnswer = value
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean);
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

      if (action === 'delete-section') {
        editorState.sections.splice(sIndex, 1);
      }
      if (action === 'move-section-up' && sIndex > 0) {
        [editorState.sections[sIndex - 1], editorState.sections[sIndex]] = [editorState.sections[sIndex], editorState.sections[sIndex - 1]];
      }
      if (action === 'move-section-down' && sIndex < editorState.sections.length - 1) {
        [editorState.sections[sIndex + 1], editorState.sections[sIndex]] = [editorState.sections[sIndex], editorState.sections[sIndex + 1]];
      }
      if (action === 'add-question') {
        editorState.sections[sIndex].questions.push({
          id: uid('q'),
          label: 'New question',
          text: '',
          expectedAnswer: []
        });
      }
      if (action === 'delete-question') {
        editorState.sections[sIndex].questions.splice(qIndex, 1);
      }
      if (action === 'move-question-up' && qIndex > 0) {
        const arr = editorState.sections[sIndex].questions;
        [arr[qIndex - 1], arr[qIndex]] = [arr[qIndex], arr[qIndex - 1]];
      }
      if (action === 'move-question-down' && qIndex < editorState.sections[sIndex].questions.length - 1) {
        const arr = editorState.sections[sIndex].questions;
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

  preview.innerHTML = `
    <div class="list-item">
      <strong>${escapeHtml(editorState.meta.title || 'Untitled')}</strong><br>
      <span class="helper">${escapeHtml(editorState.meta.subtitle || '')}</span>
      <p style="margin:8px 0 0;">${sectionCount} section(s) · ${questionCount} question(s)</p>
    </div>
    ${editorState.sections.map(section => `
      <div class="list-item">
        <h3 style="margin:0 0 6px 0;">${escapeHtml(section.title || 'Untitled section')}</h3>
        <p class="helper">${escapeHtml(section.description || '')}</p>
        ${section.questions.length ? `
          <ul class="compact-list">
            ${section.questions.map(question => `
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

function loadQuestionnaireFromObject(data, filename = '') {
  editorState = normalizeQuestionnaire(data);
  currentQuestionnaireFileName = filename || currentQuestionnaireFileName || '';
  persistState();
  buildInterviewUI(editorState);
  renderEditor();
  setLoadStatus(currentQuestionnaireFileName || 'Questionnaire loaded');
  setEditorStatus('Questionnaire loaded.');
}

function newQuestionnaire() {
  editorState = emptyState();
  currentQuestionnaireFileName = '';
  persistState();
  buildInterviewUI(editorState);
  renderEditor();
  setEditorStatus('New questionnaire created.');
  setLoadStatus('New questionnaire');
}

function loadSelectedQuestionnaire() {
  const fileInput = document.getElementById('configFileInput');
  const file = fileInput && fileInput.files ? fileInput.files[0] : null;

  if (file) {
    file.text()
      .then((text) => {
        const config = JSON.parse(text);
        loadQuestionnaireFromObject(config, file.name || '');
      })
      .catch((error) => {
        setLoadStatus(`Loading error: ${error.message}`);
      });
    return;
  }

  if (editorState) {
    buildInterviewUI(editorState);
    setLoadStatus(currentQuestionnaireFileName || 'Questionnaire reloaded');
    return;
  }

  const stored = loadPersistedState();
  if (stored) {
    loadQuestionnaireFromObject(stored, currentQuestionnaireFileName);
    return;
  }

  setLoadStatus('Select a questionnaire file first.');
}

function loadSelectedEditorFile() {
  const fileInput = document.getElementById('fileInput');
  const file = fileInput && fileInput.files ? fileInput.files[0] : null;
  if (!file) {
    setEditorStatus('Select a file before loading.', true);
    return;
  }

  file.text()
    .then((text) => {
      const parsed = JSON.parse(text);
      loadQuestionnaireFromObject(parsed, file.name || '');
      setEditorStatus('Questionnaire loaded.');
    })
    .catch((error) => setEditorStatus(`Unable to load: ${error.message}`, true));
}

function exportQuestionnaire() {
  try {
    syncEditorMeta();
    const blob = new Blob([JSON.stringify(editorState, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = currentQuestionnaireFileName || 'questionnaire.json';
    a.click();
    URL.revokeObjectURL(url);
    setEditorStatus('Questionnaire exported.');
  } catch (error) {
    setEditorStatus(`Unable to export: ${error.message}`, true);
  }
}

function setupApp() {
  const openEditorBtn = document.getElementById('openEditorBtn');
  const backToInterviewBtn = document.getElementById('backToInterviewBtn');
  const loadBtn = document.getElementById('loadConfigBtn');
  const configFileInput = document.getElementById('configFileInput');
  const editorFileInput = document.getElementById('fileInput');
  const newQuestionnaireBtn = document.getElementById('newQuestionnaireBtn');
  const exportBtn = document.getElementById('exportBtn');
  const addSectionBtn = document.getElementById('addSectionBtn');
  const titleInput = document.getElementById('titleInput');
  const subtitleInput = document.getElementById('subtitleInput');

  if (openEditorBtn) {
    openEditorBtn.addEventListener('click', () => {
      persistState();
      showView('editor');
    });
  }

  if (backToInterviewBtn) {
    backToInterviewBtn.addEventListener('click', () => {
      syncEditorMeta();
      persistState();
      showView('interview');
    });
  }

  if (loadBtn) {
    loadBtn.addEventListener('click', loadSelectedQuestionnaire);
  }

  if (configFileInput) {
    configFileInput.addEventListener('change', loadSelectedQuestionnaire);
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
        id: uid('section'),
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

  if (titleInput) {
    titleInput.addEventListener('input', syncEditorMeta);
  }

  if (subtitleInput) {
    subtitleInput.addEventListener('input', syncEditorMeta);
  }

  const stored = loadPersistedState();
  if (stored) {
    editorState = normalizeQuestionnaire(stored);
  } else {
    editorState = emptyState();
  }

  buildInterviewUI(editorState);
  renderEditor();
  showView('interview');
}

window.addEventListener('DOMContentLoaded', setupApp);
