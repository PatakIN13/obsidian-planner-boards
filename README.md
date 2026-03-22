# Planner Boards

A universal interactive planner constructor for [Obsidian](https://obsidian.md). The daily planner is the core unit; weekly, monthly, and yearly views are dynamic aggregators. Beautiful planner tables with formulas, checkboxes, progress bars, and automatic synchronization.

![Version](https://img.shields.io/github/v/release/PatakIN13/obsidian-planner-boards?label=version&color=blue)
![Obsidian](https://img.shields.io/badge/Obsidian-1.0.0+-purple)

---

## 📦 Installation

1. Copy three files into your vault:
   ```
   <vault>/.obsidian/plugins/planner-boards/
   ├── main.js
   ├── styles.css
   └── manifest.json
   ```
2. **Settings** → **Community plugins** → enable **Planner Boards**
3. A 📋 icon will appear in the left ribbon

---

## 🏗️ Architecture

### Hub (main page)

The 📋 icon in the ribbon opens the Hub — a single entry point:

| Widget | Description |
|--------|-------------|
| **📅 Calendar** | Full month view with ← Today → navigation. Colored dots: 🟢 daily planner exists, 🟠 finance entry exists, 🔵 ICS events. Click a day → opens the board at that date |
| **📊 Week** | Mon–Sun table: tasks (3/5), habits (2/4), income, expenses, balance. Summary row. Quick overview of today's tasks and habits |
| **📋 Boards** | Cards for all boards with `show-on-main: true`. Click → open board |

Data is aggregated from **all visible boards** — if you have multiple boards, the hub shows the combined picture.

### Board

Each board is a `.planner-board` file in a folder. It contains **5 independent modes** + settings:

| Mode | Navigation | Daily files | Description |
|------|------------|:-----------:|-------------|
| **📅 Planner** | Year → Month → Week → Day | ✅ | Tasks, habits, schedule, wellness, notes. Dashboards at every level |
| **💰 Finance** | Year → Month → Week → Day | ✅ | Income, expenses (fixed/variable), debts, savings. Dashboards with totals |
| **🎯 Goals** | Year → Quarter → Month | — | Goal tracker with statuses and progress |
| **🚀 Projects** | Year → Quarter → Month | — | Project tasks with priorities, assignees, and deadlines |
| **📖 Reading** | Year → Quarter → Month | — | Books, articles, courses — rating, status, notes |
| **⚙️ Settings** | — | — | General, dictionaries, templates |

### Navigation hierarchy

```
Year 2026
├── January
│   ├── Week 30.12 — 05.01
│   │   ├── 2026-01-01 (planner + finance)
│   │   ├── 2026-01-02
│   │   └── ...
│   └── Week 06.01 — 12.01
│       └── ...
├── February
│   └── ...
└── ...
```

- **Year / Month / Week** — dynamic dashboards that aggregate data from daily files
- **Day** — a daily file (`.planner`), created manually and filled with data

---

## 📅 Planner — detailed

### Daily planner

Created via the board calendar or the "+ Create day" button. File is saved to:
```
<board folder>/daily-planner/January 2026/2026-01-15.planner
```

Contains the following sections:

| Section | Description |
|---------|-------------|
| **Weekly tasks** | Shared tasks with priorities (carried over within the week) |
| **Daily tasks** | Tasks with priorities and checkboxes |
| **Habits** | Habit checkboxes (configured via templates) |
| **Schedule** | Time slots (08:00, 09:00, …) |
| **Wellness** | Ratings: mood, energy, sleep, water |
| **Workouts** | Type, duration, intensity |
| **Notes** | Free-form text |

### Dashboards (weekly, monthly, yearly)

Automatically aggregate data from daily files:
- **Task and habit completion percentage**
- **Expense / income totals**
- **Day heat map**
- **Average wellness scores**

---

## 💰 Finance — detailed

### Daily finance

File: `<board folder>/daily-finance/January 2026/2026-01-15.planner`

| Section | Description |
|---------|-------------|
| **Income** | Category, amount, description |
| **Fixed expenses** | Rent, utilities, subscriptions |
| **Variable expenses** | Groceries, transport, entertainment |
| **Debts** | Creditor, payment, status |
| **Savings** | Goal, amount |

Records are added via a modal dialog (buttons in section headers).

### Finance dashboards

- **Weekly**: income/expense table by day, totals
- **Monthly**: summary by week, balance
- **Yearly**: summary by month, overall trends

---

## 🎯 Goals / 🚀 Projects / 📖 Reading

These modes operate at the Year → Quarter → Month level (no daily files).

| Mode | Columns | Actions |
|------|---------|---------|
| **Goals** | Goal, category, status, progress, deadline | Add / remove via modal |
| **Projects** | Task, status, priority, assignee, progress, deadline | Add / remove via modal |
| **Reading** | Title, author, type, status, rating, notes | Add / remove via modal |

Dashboards collect statistics: goals achieved, tasks completed, books read.

---

## ⚙️ Board settings

Opened via the ⚙️ button in the board header. Three tabs:

### General
- Folders for templates (daily-planner, daily-finance, goal-tracker, …)
- File naming format

### Dictionaries
Dynamic value lists for dropdown fields, grouped by mode:

| Group | Dictionaries |
|-------|--------------|
| **Planner** | Categories, priorities (weekly and daily) |
| **Finance** | Fixed expenses, variable expenses |
| **Goals** | Statuses, categories |
| **Projects** | Statuses, priorities |
| **Reading** | Statuses |

Dictionary changes apply to **new** files only — existing files are not affected.

### Templates
Full editable template previews. You can:
- Pre-fill the habit table
- Set up a creditor list for finance
- Define default project tasks

The default template is inserted when creating a new daily file.

---

## 📅 Online calendar sync (ICS)

The plugin can read ICS feeds (Google Calendar, iCloud, Outlook):

1. **Plugin settings** → "Calendars" section → add an ICS URL
2. Assign a color and name for each source
3. Events auto-refresh (every 30 min by default)

In the hub, ICS events appear as:
- 🔵 dots on calendar days
- "Today" / "Tomorrow" lists below the calendar

---

## 📁 File structure

```
My Planner/
├── Planner Board.planner-board      ← board file (settings, dictionaries)
├── daily-planner/
│   ├── January 2026/
│   │   ├── 2026-01-01.planner
│   │   ├── 2026-01-02.planner
│   │   └── ...
│   └── February 2026/
│       └── ...
├── daily-finance/
│   ├── January 2026/
│   │   └── 2026-01-01.planner
│   └── ...
├── goals/
│   └── 2026.planner
├── projects/
│   └── 2026.planner
└── reading/
    └── 2026.planner
```

---

## 🎨 Themes

Select the default theme in plugin settings:

| Theme | Description |
|-------|-------------|
| `default` | Standard Obsidian theme |
| `soft` | Soft pastel tones |
| `dark` | Dark high-contrast |
| `minimal` | Minimalist |

---

## 🌐 Localization

The plugin is fully translated into Russian and English. Language is selected in plugin settings.

---

## 🔧 For developers

### Building

```bash
npm install
npm run build    # → main.js
npm run dev      # → watch mode
```

### Testing

```bash
npm test         # run unit tests
npm run build    # production build
npm run dev      # watch mode
```

### Templates

Templates are TypeScript functions in `src/templates/`. Each template takes a YAML schema and returns an extended schema with sections and columns.

Available templates:

| Key | File | Used in |
|-----|------|---------|
| `daily-planner` | `daily-planner.ts` | Planner (day) |
| `daily-finance` | `daily-finance.ts` | Finance (day) |
| `finance-planner` | `finance-planner.ts` | Finance (month) |
| `goal-tracker` | `goal-tracker.ts` | Goals |
| `project-tracker` | `project-tracker.ts` | Projects |
| `reading-log` | `reading-log.ts` | Reading |

### Code architecture

| File | Description |
|------|-------------|
| `src/main.ts` | Plugin entry point, commands, ribbon, view registration |
| `src/planner-view.ts` | Hub / Dashboard — main page with calendar and aggregator |
| `src/single-planner-view.ts` | BoardView — main view for `.planner-board` files (all 5 modes + settings) |
| `src/settings.ts` | Plugin settings (theme, language, currency, ICS calendars) |
| `src/i18n.ts` | Russian and English localization |
| `src/calendar/` | ICS sync, parser, cache |
| `src/templates/` | Template generators |
| `src/parser/` | YAML schema parser |
| `src/engine/` | Table rendering engine |
| `src/renderers/` | Cell renderers (checkbox, progress bar, multi-select, …) |

---

## 📄 License

MIT

---

🇷🇺 Полностью поддерживает русский язык. Выберите язык в настройках плагина.
