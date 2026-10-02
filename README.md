# 🚀 Interview Scorecard

A modern lightweight web app to **create, run, and export interview questionnaires** with scoring, recruiter notes, domain-based evaluation, and CSV recap export.

---

## ✨ Overview

**Interview Scorecard** helps recruiters, hiring managers, and tech leads structure interviews with a reusable questionnaire system.

It provides:

- a **questionnaire editor**
- a **live interview scoring interface**
- a **domain-based summary**
- a **score overview** (overall level + radar by domain)
- a **weak point overview**
- a **CSV export** for HR or hiring follow-up

This project is built with plain **HTML, CSS, and JavaScript**, with no framework
and no build step. The only external code is the charting library, and it is
optional: it is fetched from a CDN on demand, and the app is fully usable if it
never arrives.

---

## 🧩 Features

- 📂 Load questionnaires from JSON files
- 🛠️ Create and edit questionnaires directly in the browser
- 📝 Add recruiter notes during interviews
- ✅ Score each answer on a configurable scale (`maxScorePerQuestion`)
- 📊 View:
  - total score
  - completion rate
  - levels by domain
  - weak points
- 📈 Score overview: overall level, and a radar of the score per domain
- 🟢🟡🔴 Coloured status column in the recap, driven by the score
- 📤 Export interview results to CSV, with candidate / interviewer / date header
- 💾 Persist questionnaire **and recorded answers** in `localStorage`
- 🧯 Repair malformed questionnaires on load instead of failing
- 👀 Live preview in editor mode
- 🌙 Clean dark UI
- 📱 Responsive layout

---

## 📸 Main Capabilities

### Interview mode
Run a questionnaire during a candidate interview and evaluate each answer in real time.

### Score overview
Below the scorecard, the overall verdict sits next to a radar of the score per
domain:

* the **overall level** is the headline: the rate obtained on the questionnaire
  and the matching level, coloured with the same rule as the question borders.
  "Pending" means nothing has been rated yet, as opposed to having rated zero
  everywhere;
* the **radar** has one axis per domain, showing the percentage obtained on each
  one. The points follow the level thresholds declared in
  `grading.globalLevels`, and hovering an axis shows the exact score and level.
  With fewer than three domains a radar is meaningless, so it is dropped and the
  verdict is shown on its own.

Both read the exact same aggregated result as the summary sidebar and the CSV
export, so they cannot drift apart, and they update as you score.

The verdict does not depend on the chart library: the library is only fetched
for the radar, and the level is readable even when the CDN never answers.

### Editor mode
Create or update a questionnaire structure with:
- sections
- questions
- expected answers
- labels
- overall-level thresholds and labels
- descriptions

### Export
Generate:
- a **JSON questionnaire file**
- a **CSV interview summary** ready to share with HR or managers

---

## 🗂️ Project Structure

```text
.
├── index.html     # Main application layout
├── styles.css     # UI styling and responsive layout
├── app.js         # Application logic, editor, scoring, export
├── interview-config-sample.json   # Template questionnaire
├── interview-config.local.json    # Your working questionnaire (git-ignored)
├── .gitignore
└── LICENSE
```

---

## ⚙️ Tech Stack

* **HTML5**
* **CSS3**
* **Vanilla JavaScript**
* **Chart.js 4.5.1** (MIT), loaded from jsDelivr at runtime for the charts only

No bundler.
No framework.
No backend required.

### About the charting library

The charts are the one thing this project does not ship itself. Chart.js is
pinned to `4.5.1` and pulled from `cdn.jsdelivr.net` **after** the scorecard is
already interactive, so:

* a slow, proxied or unreachable CDN never delays an interview;
* if the fetch fails, a warning is logged in the console and the chart card
  simply does not appear — scoring, notes, export and persistence are untouched;
* nothing is written to disk and there is no `node_modules`, so the project
  stays a plain folder you can copy around.

To go fully offline, download that one file and point `CHART_CDN_URL` at the
local path in `app.js`.

---

## ▶️ Getting Started

### Run locally

Serve the folder with a lightweight HTTP server:

```bash
python3 -m http.server 8000
```

Then open:

```text
http://localhost:8000
```

Opening `index.html` directly with `file://` also works in most browsers, but
reading a local questionnaire through the File API is unreliable there, so the
HTTP server is the recommended path.

### Your working questionnaire

`interview-config.local.json` is the file you edit day to day. It is
git-ignored on purpose: it usually carries internal context and you do not
want it committed by accident. Copy `interview-config-sample.json` to
`interview-config.local.json` to start a new one.

`localStorage` is per browser and per origin, so a questionnaire saved in one
browser does not show up in another.

---

## 🧪 Questionnaire Format

The app uses a JSON-based questionnaire structure.

### Example

```json
{
  "meta": {
    "title": "Linux Systems & DevOps Engineer Interview",
    "subtitle": "Evaluation questionnaire for recruiter or tech lead",
    "maxScorePerQuestion": 2
  },
  "grading": {
    "labels": {
      "2": "Correct",
      "1": "Partial",
      "0": "Incorrect"
    },
    "globalLevels": [
      { "min": 70, "label": "Good" },
      { "min": 50, "label": "Average / needs improvement" },
      { "min": 0, "label": "Insufficient" }
    ]
  },
  "sections": [
    {
      "id": "section-linux",
      "title": "Linux",
      "description": "Core Linux administration questions",
      "questions": [
        {
          "id": "q-linux-1",
          "label": "Linux fundamentals",
          "text": "Explain the difference between a process and a thread.",
          "expectedAnswer": [
            "A process has its own memory space",
            "Threads share the same process memory",
            "Threads are lighter than processes"
          ]
        }
      ]
    }
  ]
}
```

### Scoring scale

`meta.maxScorePerQuestion` drives the whole scoring model:

* every question gets one rating button per score from `maxScorePerQuestion`
  down to `0`;
* `grading.labels` must provide a label for each score in that range
  (`"0"` … `"N"`). Missing ones receive an explicit default label with its
  score, such as `Very good (4/5)`;
* totals are `questionCount * maxScorePerQuestion`, so the value displayed
  next to the score always matches the buttons on screen.

The accepted range is `1` to `10`; anything outside is clamped. It is editable
from the questionnaire editor ("Max score per question") and can be changed
between two interviews.

`grading.globalLevels` maps a percentage to a level. Thresholds are matched by
value, not by position, so the order in the file does not matter, and a level
covering `0` is always guaranteed. The editor lets you add or remove levels and
change their labels and minimum percentages; the 0% level itself is retained.

### Colour bands and weak points

A rated question gets a coloured border on its card, on thirds of the scale so
it reads the same whatever `maxScorePerQuestion` is:

| Band | Condition | Colour |
| --- | --- | --- |
| bad | `0`, or up to a third of the scale | red |
| mid | the middle third | yellow |
| good | two thirds of the scale or more | green |

On the default `0`-`2` scale that means `Incorrect` is red, `Partiel` is yellow
and `Correct` is green.

Weak points (the list in the summary sidebar) use a **separate** rule: anything
at or below half the scale is listed. A partial answer is therefore yellow but
still worth raising in the debrief — the border answers "how did the answer go",
the list answers "what should we discuss".

Section and question `id` values must be unique: they are the keys used to
restore recorded answers. Duplicates are automatically suffixed on load so two
questions can never share a score.

The recap table's **Status** column is tinted from the score itself, not from the
label wording: `Incorrect` red, `Partiel` yellow, `Correct` green on the default
0-2 scale. Renaming or translating `grading.labels` therefore never changes the
colours. Unrated questions get a neutral grey cell.

---

## 🧠 How It Works

### 1. Load or create a questionnaire

You can either:

* import an existing JSON questionnaire
* create a new one from the built-in editor

### 2. Run the interview

For each question, the interviewer can:

* assign a score
* add notes
* review expected answers

### 3. Review the summary

The app computes:

* total score
* completion ratio
* overall level
* levels by domain
* weak areas
* the score overview charts

### 4. Export results

Export a CSV summary including:

* questionnaire metadata
* overall evaluation
* domain breakdown
* question-by-question notes

---

## 💾 Local Persistence

Two independent states are kept in `localStorage`:

```text
app.interview.config     # the questionnaire being edited
app.interview.filename   # its source filename
app.interview.answers    # recorded scores, notes and interview metadata
```

The questionnaire is saved on every editor change. Scores, notes, candidate,
interviewer and date are saved while you interview, and restored when you
switch views or reopen the app. Answers belonging to questions that no longer
exist are dropped, so a stale entry can never reach an export.

Use **Rebuild scorecard** to re-render the scorecard from the current
questionnaire; it asks for confirmation and clears recorded answers first.
Loading a different questionnaire does the same.

Clearing browser storage, or using a different browser or a different origin
(`localhost` vs `127.0.0.1`), starts from a clean state. Export the CSV before
you rely on anything being kept.

---

## 📤 Exported Data

### Questionnaire export

The editor exports the full questionnaire as a formatted JSON file. The
filename is the one the questionnaire was loaded from, so re-exporting
overwrites your source file after a confirmation from the browser.

### Interview export

The interview view exports a CSV file containing:

* questionnaire title and subtitle
* candidate, interviewer and interview date
* export timestamp
* overall score, rate and level
* per-domain summary
* a recap of every question: label, question text, domain, status, points and
  recruiter notes

The separator is selectable (`;` for Excel FR/DE, `,` for Excel US/UK) and is
also declared in a `sep=` header line. The file is UTF-8 with a BOM and CRLF
line endings.

Cells starting with `=`, `+`, `-`, `@`, tab or carriage return are prefixed
with a quote, so a note is never executed as a spreadsheet formula when HR
opens the file.

---

## 🎨 UI Highlights

* modern dark theme
* sticky summary sidebar
* clear score visualization
* radar overview, coloured from the questionnaire's own level thresholds
* section-level scoring
* weak point detection, on its own half-marks threshold
* recap table whose Status column is tinted per answer
* editor live preview
* responsive layout for smaller screens

---

## 🔍 Current Scope

This project is ideal for:

* technical interviews
* recruiter screening
* hiring scorecards
* structured candidate evaluations
* internal interview templates

---

## 🛣️ Possible Improvements

* visible autosave indicator
* import validation report (today repairs are silent)
* duplicate question inside a section
* import/export history
* multi-language UI
* PDF export
* several interview sessions per questionnaire
* weighted scoring per section
* a test suite in the repo (today: manual QA only)
* authentication and backend persistence

---

## 📄 License

You can release this project under the **MIT License** if you want to keep it open and reusable.

---

## 🤝 Contributing

Contributions, improvements, and UI enhancements are welcome.

You can contribute by:

* improving the questionnaire editor
* enhancing exports
* adding validation
* refining the user experience
* extending the scoring model
