# 🚀 Interview Scorecard

A modern lightweight web app to **create, run, and export interview questionnaires** with scoring, recruiter notes, domain-based evaluation, and CSV recap export.

---

## ✨ Overview

**Interview Scorecard** helps recruiters, hiring managers, and tech leads structure interviews with a reusable questionnaire system.

It provides:

- a **questionnaire editor**
- a **live interview scoring interface**
- a **domain-based summary**
- a **weak point overview**
- a **CSV export** for HR or hiring follow-up

This project is built with plain **HTML, CSS, and JavaScript**, with no framework and no build step.

---

## 🧩 Features

- 📂 Load questionnaires from JSON files
- 🛠️ Create and edit questionnaires directly in the browser
- 📝 Add recruiter notes during interviews
- ✅ Score each answer with a simple rating system
- 📊 View:
  - total score
  - completion rate
  - global level
  - levels by domain
  - weak points
- 📤 Export interview results to CSV
- 💾 Persist questionnaire state in `localStorage`
- 👀 Live preview in editor mode
- 🌙 Clean dark UI
- 📱 Responsive layout

---

## 📸 Main Capabilities

### Interview mode
Run a questionnaire during a candidate interview and evaluate each answer in real time.

### Editor mode
Create or update a questionnaire structure with:
- sections
- questions
- expected answers
- labels
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
└── app.js         # Application logic, editor, scoring, export
````

---

## ⚙️ Tech Stack

* **HTML5**
* **CSS3**
* **Vanilla JavaScript**

No dependencies.
No bundler.
No framework.
No backend required.

---

## ▶️ Getting Started

### Run locally

You can open the project directly in your browser:

```bash
open index.html
```

Or serve it locally with a lightweight HTTP server:

```bash
python3 -m http.server 8000
```

Then open:

```text
http://localhost:8000
```

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
      { "min": 85, "label": "Very strong" },
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

### 4. Export results

Export a CSV summary including:

* questionnaire metadata
* overall evaluation
* domain breakdown
* question-by-question notes

---

## 💾 Local Persistence

The current questionnaire is automatically saved in the browser using `localStorage`.

Stored keys:

```text
app.interview.config
app.interview.filename
```

This allows you to reopen the app and continue working from the latest saved state.

---

## 📤 Exported Data

### Questionnaire export

The editor exports the full questionnaire as a formatted JSON file.

### Interview export

The interview view exports a CSV file containing:

* questionnaire title and subtitle
* export timestamp
* overall score
* overall level
* per-domain summary
* detailed recap of each question
* recruiter notes

---

## 🎨 UI Highlights

* modern dark theme
* sticky summary sidebar
* clear score visualization
* section-level scoring
* weak point detection
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

* candidate profile section
* interviewer name / interview metadata
* autosave indicator
* questionnaire validation
* duplicate section / question actions
* import/export history
* multi-language support
* PDF export
* separate interview session storage
* weighted scoring per section
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

