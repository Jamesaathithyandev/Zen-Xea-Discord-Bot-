# Zen Xea - Internal Department Task & Time Tracking Discord Bot

A production-grade Discord bot built in Node.js (v20+) using `discord.js` v14, `better-sqlite3`, `luxon`, and `node-cron`. Designed for internal company servers, Zen Xea serves every department (**HR, Digital Marketing, SEO, Technology, Sales**) with automated task lifecycle management, granular work & break time tracking, deadline reminders, recurring schedules, leave/holiday handling, and scheduled department performance reporting.

---

## Key Features

- **Department Auto-Detection**: Tasks inherit their department from the channel category (e.g., `Technology`, `Sales`, `HR`) with a clean fallback to `General`.
- **Comprehensive Lifecycle**: `assigned` ➔ `in_progress` ➔ `on_break` ➔ `paused` ➔ `blocked` ➔ `completed` / `cancelled`.
- **Precision Time Tracking**:
  - Work time and Break time are tracked independently in UTC Unix seconds and compared against estimates.
  - Break time is automatically tracked by break type (Lunch: 75m, Tea/Short: 30m, Personal: 30m, Other: 30m).
  - Blocked time is strictly excluded from work and break statistics.
  - Full audit adjustments by managers via `/adjust` (signed minutes, max $\pm720$ min with mandatory reason).
- **Interactive UI Cards & End-Day Workflow**:
  - Priority colors & emojis (🟢 Low, 🟡 Normal, 🔴 Urgent).
  - Row 1 Action Buttons: **Start**, **Break** (ephemeral select menu), **Resume**, **End Day**, **Complete**.
  - Row 2 Action Buttons: **Blocked** (modal for reason), **Update Note** (modal for progress).
  - **End Day Status Check**: When clicking **End Day** or using `/endday`, the bot prompts the employee to confirm task completion:
    - **Completed (`✅ Completed`)**: Marks the task as completed, generates a variance summary against estimates, and notifies the assigner.
    - **Not Completed (`⏳ Not Completed`)**: Opens a modal prompting for an end-of-day progress and status update, pauses the task until tomorrow, and logs the update publicly in the channel.
  - Static custom IDs that persist across bot restarts.
- **Strict Role-Based Access Control**:
  - Only the assigned employee can click task buttons or use action commands on their task.
  - Concurrent task prevention: employees cannot start a second task if one is already active (`in_progress` or `on_break`).
  - Managers (`Administrator` or roles: `founder`, `management`, `hr manager`, `dm manager`, `seo manager`, `tech lead`, `sales manager`) hold exclusive access to `/assign`, `/reassign`, `/edit`, `/cancel`, `/adjust`, `/recurring`, `/holiday`, and server-wide reports.
- **Smart Reminders & Automation (`Asia/Kolkata` IST)**:
  - **End-of-day Reminder**: DMs all employees with active tasks at 19:30 IST on working days (Mon–Sat).
  - **Auto End-of-Day**: Automatically pauses running tasks at 20:30 IST with a public channel log.
  - **Break Overtime Alerts**: DMs user once when their break exceeds the category limit.
  - **Deadline Reminders**: Sends DMs at 24 hours and 2 hours prior to deadline, plus an overdue alert.
  - **DM Fallback**: If an employee has direct messages disabled, pings them in the task's channel.
  - **Leave & Holiday Awareness**: All reminders and recurring triggers are automatically suppressed for employees on leave or on holidays/non-working days.
  - **Restart Safe**: Scheduler tracks execution state and reminder flags in SQLite (`meta` and `tasks` tables).
- **Scheduled Performance Reports & CSV Exports**:
  - Daily at 20:00 IST, Weekly on Monday at 09:00 IST (previous week), and Monthly on the 1st at 09:00 IST (previous month).
  - Automatically posts reports to the department's dedicated report channel (category channel containing `report`).
  - Ephemeral on-demand `/report` and `/export` (CSV attachment) with user and department filters.

---

## Architecture & Technology Stack

| Component | Technology | Description |
| :--- | :--- | :--- |
| **Runtime** | Node.js 20+ (ES2022+ CommonJS) | High performance asynchronous runtime |
| **Discord Library** | `discord.js` v14 | Slash commands, Buttons, Modals, Select Menus |
| **Intents** | Default `Guilds` (`GatewayIntentBits.Guilds`) | **Zero privileged intents** required (no MessageContent, no GuildMembers intent) |
| **Database** | `better-sqlite3` | Embedded synchronous SQLite with WAL mode (`taskbot.db`) |
| **Timezone & Dates** | `luxon` | Timezone math anchored to `Asia/Kolkata` (IST) |
| **Task Scheduler** | `node-cron` | 1-minute ticker executing restart-safe automated jobs |
| **Configuration** | `dotenv` + `config.js` | Environment variables and central constants |

### File Structure

```
├── .env.example         # Environment template (DISCORD_TOKEN, CLIENT_ID, GUILD_ID)
├── config.js            # Editable constants (MANAGER_ROLES, BREAK_LIMITS, times, working days)
├── db.js                # SQLite schema definition, indexes, queries & in-memory support
├── logic.js             # State transitions, permissions, embeds, action rows & time math
├── reports.js           # Period clipping, aggregation, Discord limits handling & CSV generation
├── scheduler.js         # node-cron jobs (EOD, auto-EOD, break/deadline reminders, recurring)
├── deploy-commands.js   # Discord REST slash command registration script
├── index.js             # Discord client startup, interaction router (commands, buttons, modals)
├── test.js              # Comprehensive acceptance test suite (10 test cases)
├── package.json         # Scripts, dependencies, and metadata
└── README.md            # System documentation
```

---

## State Transition Workflow

```
       [ /assign ]
            │
            ▼
     ┌──────────────┐
     │   assigned   │ ◄────────────────────────┐
     └──────┬───────┘                          │
            │ Start                            │
            ▼                                  │
     ┌──────────────┐   Break   ┌──────────┐   │
     │ in_progress  ├──────────►│ on_break │   │
     └──────┬───────┘           └────┬─────┘   │
       ▲    │   ▲                    │         │
       │    │   └────── Resume ──────┘         │
       │    │                                  │
       │    ├───────── End Day ────────┐       │
       │    │                          │       │
       │    │   Blocked                ▼       │
       │    ├──────────────► ┌─────────────┐   │
       │    │                │   blocked   │   │
       │    │                └──────┬──────┘   │
       │    │                       │ Unblock  │
       │    │                       ▼          │
       │    └─────────────────► ┌────────┐     │
       └──────── Start ─────────┤ paused │     │
                                └───┬────┘     │
                                    │          │
         ┌──────────────────────────┴──────────┴───────────────┐
         │                                                     │
         │ Complete (Assignee)              Cancel (Manager)   │
         ▼                                                     ▼
  ┌──────────────┐                                      ┌─────────────┐
  │  completed   │                                      │  cancelled  │
  └──────────────┘                                      └─────────────┘
```

---

## Installation & Setup

### 1. Prerequisites
- Node.js 20.0.0 or higher
- npm 9.0.0 or higher
- A Discord Bot application created on the [Discord Developer Portal](https://discord.com/developers/applications)

### 2. Bot Permissions & Intents
1. Go to **Bot** in your application settings.
2. In **Privileged Gateway Intents**, leave all options **OFF** (no privileged intents are used).
3. Under **OAuth2 ➔ URL Generator**:
   - Scopes: `bot`, `applications.commands`
   - Bot Permissions:
     - `Send Messages`
     - `Send Messages in Threads`
     - `Embed Links`
     - `Attach Files`
     - `Read Message History`
     - `Use External Emojis`
4. Use the generated link to invite the bot to your server.

### 3. Clone & Install Dependencies
```bash
# Navigate to the project directory
cd "Discord Bot Zen Xea"

# Install production dependencies
npm install
```

### 4. Configure Environment Variables
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```
Populate `.env` with your credentials:
```env
DISCORD_TOKEN=your_bot_token_here
CLIENT_ID=your_client_id_here
GUILD_ID=your_test_guild_id_here   # Optional: instantaneous command registration during development
```

### 5. Deploy Slash Commands
Register all 19 application commands with Discord:
```bash
npm run deploy
```
*(If `GUILD_ID` is set in `.env`, commands deploy immediately to that guild. If omitted, commands are registered globally).*

### 6. Start the Bot
```bash
npm start
```

---

## Configuration Reference (`config.js`)

All operational settings can be adjusted in `config.js`:

```javascript
// Timezone for all date parsing, logging, and cron jobs
const TIMEZONE = 'Asia/Kolkata';

// Roles recognized as Managers (case-insensitive)
const MANAGER_ROLES = [
  'founder',
  'management',
  'hr manager',
  'dm manager',
  'seo manager',
  'tech lead',
  'sales manager',
];

// Available break types in the select menu
const BREAK_TYPES = [
  'Lunch break',
  'Tea / short break',
  'Personal break',
  'Other',
];

// Maximum allowed duration in minutes before alerting
const BREAK_LIMITS_MIN = {
  'Lunch break': 75,
  'Tea / short break': 30,
  'Personal break': 30,
  'Other': 30,
  'default': 30,
};

// Scheduler execution times (24-hour IST format)
const EOD_REMINDER_TIME = '19:30';
const AUTO_END_DAY_TIME = '20:30';
const DAILY_REPORT_TIME = '20:00';

// Working days (1 = Monday, ..., 6 = Saturday)
const WORKING_DAYS = [1, 2, 3, 4, 5, 6];

// Hours before deadline to dispatch DM reminders
const DEADLINE_REMINDERS_HOURS = [24, 2];
```

---

## Slash Commands Directory

| Command | Permissions | Description |
| :--- | :--- | :--- |
| `/assign member title estimate_hours [priority] [description] [deadline]` | **Managers** | Creates and posts a new task card in the channel category. |
| `/start [task_id]` | **Assignee** | Starts work timer. Auto-picks single active task if ID omitted. |
| `/break [reason] [task_id]` | **Assignee** | Pauses work timer and starts break timer. |
| `/resume [task_id]` | **Assignee** | Ends break session, logs duration, resumes work timer. |
| `/endday [task_id]` | **Assignee** | Pauses active task and logs worked time vs estimate. |
| `/complete [task_id]` | **Assignee** | Marks task completed, posts variance summary, pings assigner. |
| `/blocked reason [task_id]` | **Assignee** | Marks task blocked, excludes duration from time totals, pings assigner. |
| `/unblock [task_id]` | **Assignee / Mgr** | Resets blocked task to paused status so work can resume. |
| `/update note [task_id]` | **Assignee** | Posts timestamped progress update and saves to updates table. |
| `/tasks [member]` | **Everyone / Mgr** | Lists open tasks ordered by priority (Urgent first). Staff see own tasks. |
| `/reassign task_id member` | **Managers** | Transfers task; keeps prior sessions credited to original user. |
| `/edit task_id [fields...]` | **Managers** | Edits title, estimate, deadline, priority, or description with changelog. |
| `/cancel task_id reason` | **Managers** | Cancels non-completed task; retains logged time in overall totals. |
| `/adjust task_id minutes kind reason` | **Managers** | Adjusts work or break time ($\pm720$ min max) with public log. |
| `/recurring add/list/remove` | **Managers** | Manages automated recurring task creation templates. |
| `/leave add/cancel/list` | **Staff / Mgr** | Records leave periods. Skips reminders and recurring tasks during leaves. |
| `/holiday add/remove/list` | **Managers** | Adds official company holidays. Suppresses automated notifications. |
| `/report period [member] [dept]` | **Staff / Mgr** | Generates performance embed. Staff only view own records (ephemeral). |
| `/export period [member] [dept]` | **Staff / Mgr** | Generates downloadable CSV export file (ephemeral). |
| `/shift set/list/remove` | **Admins / Mgr** | Sets shift start & end times (HH:MM). Sends login/logout task reminders. |

---

## Acceptance Test Suite

The system includes a dedicated unit and integration test runner (`test.js`) executed with Node's built-in `assert` against an in-memory SQLite database (`:memory:`):

```bash
npm test
```

### Verified Test Cases:
1. **Full Lifecycle Calculation**: `assign ➔ start ➔ break(Lunch) ➔ resume ➔ endday ➔ start ➔ complete` correctly computes work and break minutes.
2. **Concurrent Task Prevention**: Starting a second task when one is already `in_progress` or `on_break` is strictly refused.
3. **Role & Permission Isolation**: Non-assignees cannot execute button actions. Non-managers cannot invoke manager-only commands.
4. **Blocked Time Exclusion**: Time elapsed while a task is in `blocked` status is not counted as work or break.
5. **Time Adjustments**: `/adjust` validates non-zero signed integers $\le \pm720$ minutes and updates reports immediately.
6. **Reassignment Attribution**: Reassigning a task maintains historical session attribution to the original team member.
7. **Cancelled Tasks**: Cancelled tasks are excluded from on-time/over-estimate statistics, but their worked time is included in team totals.
8. **Deduplication of Reminders**: Break overtime, 24-hour, 2-hour, and overdue reminders fire only once across repeated scheduler runs.
9. **Auto End-of-Day & Exclusions**: Auto end-of-day pauses open tasks at 20:30 IST. Users on leave or on server holidays receive zero reminders.
10. **Period Clipping & CSV Schema**: Reports accurately clip sessions to period boundaries; CSV output conforms to exact column specifications.

---

## Assumptions & Design Decisions

1. **Category-Based Departments**: In line with the specification, the department name is derived from `interaction.channel.parent.name`. If a task is created in a top-level channel without a category, it defaults to `"General"`.
2. **Department Report Routing**: Scheduled department reports search for a text channel inside the department category whose name contains `"report"` (case-insensitive, e.g. `#tech-reports`, `#sales-reports`). If no matching report channel exists, the report is delivered to the channel where tasks were originally created.
3. **Ghost-Ping Prevention**: To avoid unnecessary pings, all routine channel log messages are dispatched with `allowedMentions: { parse: [] }`. Pings are explicitly allowed only when a task is marked **Blocked** (pings assigner), **Completed** (pings assigner), or when a DM fails and falls back to a channel mention.
4. **Restart-Safe Reminders**: Because node processes can restart at any point during a workday, reminder states are saved immediately to SQLite (`reminded_24h`, `reminded_2h`, `reminded_overdue`, `break_reminded`, and `meta` date keys) rather than relying on in-memory timers.
5. **Session Clipping**: For sessions that cross boundary lines (e.g. a session running from 23:45 Sunday to 00:30 Monday), reports clip the session duration to the requested interval so daily, weekly, and monthly totals remain strictly contained within their respective windows.

