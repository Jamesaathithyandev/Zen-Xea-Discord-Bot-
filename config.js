/**
 * ============================================================================
 * Zen Xea Discord Bot - Central Configuration File
 * ============================================================================
 * ALL configurable numbers, timings, role names, limits, and options
 * can be edited directly here in this single file.
 *
 * Changes take effect immediately upon saving and restarting the bot.
 * ============================================================================
 */

require('dotenv').config();

// ============================================================================
// 1. TIMEZONE & WORKING SCHEDULE
// ============================================================================

/**
 * Primary timezone used for all scheduler jobs, logs, and date parsing.
 * Default: 'Asia/Kolkata'
 */
const TIMEZONE = 'Asia/Kolkata';

/**
 * Working days of the week (Luxon weekday numbers):
 * 1 = Monday, 2 = Tuesday, 3 = Wednesday, 4 = Thursday,
 * 5 = Friday, 6 = Saturday, 7 = Sunday
 * Default: [1, 2, 3, 4, 5, 6] (Monday through Saturday)
 */
const WORKING_DAYS = [1, 2, 3, 4, 5, 6];
const WORKING_DAYS_LABEL = 'Mon-Sat';

// ============================================================================
// 2. BREAK CONFIGURATION (Types & Allowed Duration Limits in Minutes)
// ============================================================================

/**
 * List of selectable break types presented in select menus and commands.
 */
const BREAK_TYPES = [
  'Lunch break',
  'Tea / short break',
  'Personal break',
  'Other',
];

/**
 * Maximum allowed break limits in minutes.
 * If a break exceeds this threshold, the employee receives an automatic reminder.
 * You can change any number below (e.g. change 75 to 90 or 60).
 */
const BREAK_LIMITS_MIN = {
  'Lunch break': 75,        // Lunch duration limit in minutes
  'Tea / short break': 30,  // Short / tea break limit in minutes
  'Personal break': 30,     // Personal break limit in minutes
  'Other': 30,              // Other break limit in minutes
  'default': 30,            // Fallback limit for unspecified break types
};

// ============================================================================
// 3. DAILY REMINDERS & AUTOMATION TIMINGS (24-Hour "HH:MM" Format)
// ============================================================================

/**
 * End-of-Day (EOD) reminder time.
 * At this time on working days, employees with active tasks get a DM reminder.
 * Default: '19:30' (7:30 PM)
 */
const EOD_REMINDER_TIME = '19:30';

/**
 * Auto End-of-Day cutoff time.
 * At this time on working days, any running task is automatically paused.
 * Default: '20:30' (8:30 PM)
 */
const AUTO_END_DAY_TIME = '20:30';

/**
 * Daily department performance report dispatch time.
 * Default: '20:00' (8:00 PM)
 */
const DAILY_REPORT_TIME = '20:00';

/**
 * Weekly department report schedule:
 * WEEKLY_REPORT_DAY: 1 = Monday ... 7 = Sunday (Default: 1 = Monday)
 * WEEKLY_REPORT_TIME: Dispatch time in 24h format (Default: '09:00')
 */
const WEEKLY_REPORT_DAY = 1;
const WEEKLY_REPORT_TIME = '09:00';

/**
 * Monthly department report schedule:
 * MONTHLY_REPORT_DAY: Day of month (Default: 1 = 1st of the month)
 * MONTHLY_REPORT_TIME: Dispatch time in 24h format (Default: '09:00')
 */
const MONTHLY_REPORT_DAY = 1;
const MONTHLY_REPORT_TIME = '09:00';

/**
 * Hours before a task deadline when automated reminder DMs should be sent.
 * Default: [24, 2] (24 hours before, and 2 hours before)
 */
const DEADLINE_REMINDERS_HOURS = [24, 2];

// ============================================================================
// 4. EMPLOYEE WORK SHIFT TIMINGS & ALERTS (24-Hour "HH:MM" Format)
// ============================================================================

/**
 * Default shift timings applied when an employee has no custom shift set via /shift set.
 * Default start: '09:30' (9:30 AM)
 * Default end: '18:30' (6:30 PM)
 */
const DEFAULT_SHIFT_START = '09:30';
const DEFAULT_SHIFT_END = '18:30';

/**
 * Whether to monitor shifts and send login/logout alerts for employees.
 * Set to false if you want to disable shift alerts completely.
 */
const SHIFT_ALERTS_ENABLED = true;

/**
 * Whether employees without an explicit custom shift should follow the default shift.
 * Default: true
 */
const APPLY_DEFAULT_SHIFTS = true;

// ============================================================================
// 5. TIME ADJUSTMENT LIMITS
// ============================================================================

/**
 * Maximum single adjustment limit in minutes allowed via /adjust.
 * Default: 720 (equivalent to 12 hours)
 */
const MAX_ADJUSTMENT_MINUTES = 720;

// ============================================================================
// 5. PERMISSIONS: MANAGER ROLES (Case-Insensitive)
// ============================================================================

/**
 * Server role names that grant manager permissions.
 * Anyone with Administrator permission also qualifies automatically.
 */
const MANAGER_ROLES = [
  'founder',
  'management',
  'hr manager',
  'dm manager',
  'seo manager',
  'tech lead',
  'sales manager',
];

// ============================================================================
// 6. UI: PRIORITIES, BADGES, AND STATUS DETAILS
// ============================================================================

const PRIORITIES = {
  Low: {
    color: 0x2ecc71, // Green
    emoji: '🟢',
  },
  Normal: {
    color: 0x3498db, // Blue / Amber
    emoji: '🟡',
  },
  Urgent: {
    color: 0xe74c3c, // Red
    emoji: '🔴',
  },
};

const STATUS_DETAILS = {
  assigned: { label: 'Assigned', emoji: '📋' },
  in_progress: { label: 'In Progress', emoji: '▶️' },
  on_break: { label: 'On Break', emoji: '☕' },
  paused: { label: 'Paused', emoji: '⏸️' },
  blocked: { label: 'Blocked', emoji: '🚫' },
  completed: { label: 'Completed', emoji: '✅' },
  cancelled: { label: 'Cancelled', emoji: '❌' },
};

// ============================================================================
// 7. HELPER UTILITIES
// ============================================================================

/**
 * Convert 24-hour time 'HH:MM' into 12-hour format with AM/PM (e.g. '20:30' -> '8:30 PM')
 * @param {string} time24h
 * @returns {string}
 */
function formatTime12h(time24h) {
  if (!time24h || typeof time24h !== 'string' || !time24h.includes(':')) {
    return time24h || '';
  }
  const [hStr, mStr] = time24h.split(':');
  const h = parseInt(hStr, 10);
  const m = parseInt(mStr, 10);
  if (isNaN(h) || isNaN(m)) return time24h;

  const period = h >= 12 ? 'PM' : 'AM';
  const displayH = h % 12 || 12;
  const displayM = m === 0 ? ':00' : `:${String(m).padStart(2, '0')}`;
  return `${displayH}${displayM} ${period}`;
}

/**
 * Retrieve the configured minute limit for a given break type
 * @param {string} breakType
 * @returns {number}
 */
function getBreakLimit(breakType) {
  return BREAK_LIMITS_MIN[breakType] || BREAK_LIMITS_MIN['default'] || 30;
}

module.exports = {
  TIMEZONE,
  WORKING_DAYS,
  WORKING_DAYS_LABEL,
  BREAK_TYPES,
  BREAK_LIMITS_MIN,
  EOD_REMINDER_TIME,
  AUTO_END_DAY_TIME,
  DAILY_REPORT_TIME,
  WEEKLY_REPORT_DAY,
  WEEKLY_REPORT_TIME,
  MONTHLY_REPORT_DAY,
  MONTHLY_REPORT_TIME,
  DEADLINE_REMINDERS_HOURS,
  DEFAULT_SHIFT_START,
  DEFAULT_SHIFT_END,
  SHIFT_ALERTS_ENABLED,
  APPLY_DEFAULT_SHIFTS,
  MAX_ADJUSTMENT_MINUTES,
  MANAGER_ROLES,
  PRIORITIES,
  STATUS_DETAILS,
  formatTime12h,
  getBreakLimit,
  DISCORD_TOKEN: process.env.DISCORD_TOKEN,
  CLIENT_ID: process.env.CLIENT_ID,
  GUILD_ID: process.env.GUILD_ID,
};
