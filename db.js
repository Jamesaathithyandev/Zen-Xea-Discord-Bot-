/**
 * Zen Xea Discord Bot - Database Layer (better-sqlite3)
 * Stores timestamps in UTC Unix seconds.
 */

const Database = require('better-sqlite3');
const path = require('path');

let dbInstance = null;

/**
 * Initialize SQLite database and create schema.
 * @param {string} [dbPath='taskbot.db'] - Path to database file or ':memory:'
 * @returns {Database.Database}
 */
function initDb(dbPath = 'taskbot.db') {
  if (dbInstance) {
    return dbInstance;
  }

  const resolvedPath = dbPath === ':memory:' ? ':memory:' : path.resolve(process.cwd(), dbPath);
  dbInstance = new Database(resolvedPath);

  // Enable WAL mode for file-based databases to enhance concurrency
  if (dbPath !== ':memory:') {
    dbInstance.pragma('journal_mode = WAL');
  }
  dbInstance.pragma('foreign_keys = ON');

  createSchema(dbInstance);
  return dbInstance;
}

/**
 * Create tables and indexes according to specification
 */
function createSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT,
      channel_id TEXT,
      message_id TEXT,
      department TEXT,
      title TEXT NOT NULL,
      description TEXT,
      priority TEXT NOT NULL DEFAULT 'Normal',
      assignee_id TEXT NOT NULL,
      assigned_by TEXT NOT NULL,
      estimate_min INTEGER NOT NULL,
      deadline_ts INTEGER,
      status TEXT NOT NULL DEFAULT 'assigned',
      blocked_reason TEXT,
      cancel_reason TEXT,
      created_ts INTEGER NOT NULL,
      completed_ts INTEGER,
      reminded_24h INTEGER DEFAULT 0,
      reminded_2h INTEGER DEFAULT 0,
      reminded_overdue INTEGER DEFAULT 0,
      recurring_id INTEGER
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL, -- 'work' or 'break'
      note TEXT,
      start_ts INTEGER NOT NULL,
      end_ts INTEGER,    -- NULL = running
      break_reminded INTEGER DEFAULT 0,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS adjustments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      by_user_id TEXT NOT NULL,
      kind TEXT NOT NULL, -- 'work' or 'break'
      minutes INTEGER NOT NULL,
      reason TEXT NOT NULL,
      ts INTEGER NOT NULL,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS updates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      note TEXT NOT NULL,
      ts INTEGER NOT NULL,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS recurring (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      assignee_id TEXT NOT NULL,
      created_by TEXT NOT NULL,
      title TEXT NOT NULL,
      estimate_min INTEGER NOT NULL,
      priority TEXT NOT NULL DEFAULT 'Normal',
      schedule TEXT NOT NULL, -- 'daily', 'weekdays', 'weekly'
      time TEXT NOT NULL,     -- 'HH:MM' IST
      weekday INTEGER,        -- 1=Monday ... 7=Sunday
      last_run_date TEXT,     -- 'YYYY-MM-DD'
      active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS leaves (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      start_date TEXT NOT NULL, -- 'YYYY-MM-DD'
      end_date TEXT NOT NULL,   -- 'YYYY-MM-DD'
      reason TEXT
    );

    CREATE TABLE IF NOT EXISTS holidays (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      date TEXT NOT NULL,       -- 'YYYY-MM-DD'
      name TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS shifts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      shift_start TEXT NOT NULL, -- 'HH:MM'
      shift_end TEXT NOT NULL,   -- 'HH:MM'
      updated_by TEXT,
      updated_ts INTEGER,
      UNIQUE(guild_id, user_id)
    );

    -- Indexes for high efficiency
    CREATE INDEX IF NOT EXISTS idx_tasks_guild_dept ON tasks(guild_id, department);
    CREATE INDEX IF NOT EXISTS idx_tasks_assignee_status ON tasks(assignee_id, status);
    CREATE INDEX IF NOT EXISTS idx_tasks_message_id ON tasks(message_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_task_kind ON sessions(task_id, kind);
    CREATE INDEX IF NOT EXISTS idx_sessions_user_open ON sessions(user_id, end_ts);
    CREATE INDEX IF NOT EXISTS idx_adjustments_task ON adjustments(task_id);
    CREATE INDEX IF NOT EXISTS idx_updates_task ON updates(task_id);
    CREATE INDEX IF NOT EXISTS idx_recurring_active ON recurring(active, schedule);
    CREATE INDEX IF NOT EXISTS idx_leaves_user ON leaves(guild_id, user_id, start_date, end_date);
    CREATE INDEX IF NOT EXISTS idx_holidays_date ON holidays(guild_id, date);
    CREATE INDEX IF NOT EXISTS idx_shifts_user ON shifts(guild_id, user_id);
  `);
}

/**
 * Get current db instance or initialize default
 */
function getDb() {
  if (!dbInstance) {
    initDb();
  }
  return dbInstance;
}

/**
 * Close database connection
 */
function closeDb() {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

// ==========================================
// QUERY HELPERS
// ==========================================

// --- Tasks ---
function insertTask(taskData) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO tasks (
      guild_id, channel_id, message_id, department, title, description,
      priority, assignee_id, assigned_by, estimate_min, deadline_ts,
      status, blocked_reason, cancel_reason, created_ts, completed_ts,
      reminded_24h, reminded_2h, reminded_overdue, recurring_id
    ) VALUES (
      @guild_id, @channel_id, @message_id, @department, @title, @description,
      @priority, @assignee_id, @assigned_by, @estimate_min, @deadline_ts,
      @status, @blocked_reason, @cancel_reason, @created_ts, @completed_ts,
      0, 0, 0, @recurring_id
    )
  `);
  const info = stmt.run({
    guild_id: taskData.guild_id || null,
    channel_id: taskData.channel_id || null,
    message_id: taskData.message_id || null,
    department: taskData.department || 'General',
    title: taskData.title,
    description: taskData.description || null,
    priority: taskData.priority || 'Normal',
    assignee_id: taskData.assignee_id,
    assigned_by: taskData.assigned_by,
    estimate_min: taskData.estimate_min,
    deadline_ts: taskData.deadline_ts || null,
    status: taskData.status || 'assigned',
    blocked_reason: taskData.blocked_reason || null,
    cancel_reason: taskData.cancel_reason || null,
    created_ts: taskData.created_ts,
    completed_ts: taskData.completed_ts || null,
    recurring_id: taskData.recurring_id || null,
  });
  return getTaskById(info.lastInsertRowid);
}

function getTaskById(id) {
  const db = getDb();
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
}

function getTaskByMessageId(messageId) {
  const db = getDb();
  return db.prepare('SELECT * FROM tasks WHERE message_id = ?').get(messageId);
}

function updateTaskMessageId(taskId, messageId) {
  const db = getDb();
  db.prepare('UPDATE tasks SET message_id = ? WHERE id = ?').run(messageId, taskId);
}

function updateTaskStatus(taskId, status, extraFields = {}) {
  const db = getDb();
  const updates = ['status = ?'];
  const values = [status];

  if (extraFields.blocked_reason !== undefined) {
    updates.push('blocked_reason = ?');
    values.push(extraFields.blocked_reason);
  }
  if (extraFields.cancel_reason !== undefined) {
    updates.push('cancel_reason = ?');
    values.push(extraFields.cancel_reason);
  }
  if (extraFields.completed_ts !== undefined) {
    updates.push('completed_ts = ?');
    values.push(extraFields.completed_ts);
  }

  values.push(taskId);
  const sql = `UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`;
  db.prepare(sql).run(...values);
  return getTaskById(taskId);
}

function updateTaskAssignee(taskId, newAssigneeId, status) {
  const db = getDb();
  db.prepare('UPDATE tasks SET assignee_id = ?, status = ? WHERE id = ?').run(
    newAssigneeId,
    status,
    taskId
  );
  return getTaskById(taskId);
}

function updateTaskDetails(taskId, fields) {
  const db = getDb();
  const updates = [];
  const values = [];

  for (const [key, value] of Object.entries(fields)) {
    updates.push(`${key} = ?`);
    values.push(value);
  }

  if (updates.length === 0) return getTaskById(taskId);

  values.push(taskId);
  db.prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  return getTaskById(taskId);
}

function getUserActiveTasks(userId, guildId = null) {
  const db = getDb();
  if (guildId) {
    return db
      .prepare(
        `SELECT * FROM tasks WHERE assignee_id = ? AND guild_id = ? AND status IN ('in_progress', 'on_break')`
      )
      .all(userId, guildId);
  }
  return db
    .prepare(
      `SELECT * FROM tasks WHERE assignee_id = ? AND status IN ('in_progress', 'on_break')`
    )
    .all(userId);
}

function getUserOpenTasks(userId, guildId = null) {
  const db = getDb();
  let sql = `
    SELECT * FROM tasks
    WHERE assignee_id = ?
      AND status NOT IN ('completed', 'cancelled')
  `;
  const params = [userId];
  if (guildId) {
    sql += ` AND guild_id = ?`;
    params.push(guildId);
  }
  sql += `
    ORDER BY CASE priority
      WHEN 'Urgent' THEN 1
      WHEN 'Normal' THEN 2
      WHEN 'Low' THEN 3
      ELSE 4
    END ASC, id DESC
  `;
  return db.prepare(sql).all(...params);
}

function getAllOpenTasks(guildId = null) {
  const db = getDb();
  let sql = `SELECT * FROM tasks WHERE status NOT IN ('completed', 'cancelled')`;
  const params = [];
  if (guildId) {
    sql += ` AND guild_id = ?`;
    params.push(guildId);
  }
  sql += `
    ORDER BY CASE priority
      WHEN 'Urgent' THEN 1
      WHEN 'Normal' THEN 2
      WHEN 'Low' THEN 3
      ELSE 4
    END ASC, id DESC
  `;
  return db.prepare(sql).all(...params);
}

// --- Sessions ---
function insertSession(sessionIdData) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO sessions (task_id, user_id, kind, note, start_ts, end_ts, break_reminded)
    VALUES (@task_id, @user_id, @kind, @note, @start_ts, @end_ts, @break_reminded)
  `);
  const info = stmt.run({
    task_id: sessionIdData.task_id,
    user_id: sessionIdData.user_id,
    kind: sessionIdData.kind,
    note: sessionIdData.note || null,
    start_ts: sessionIdData.start_ts,
    end_ts: sessionIdData.end_ts || null,
    break_reminded: sessionIdData.break_reminded || 0,
  });
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(info.lastInsertRowid);
}

function closeSession(sessionId, endTs) {
  const db = getDb();
  db.prepare('UPDATE sessions SET end_ts = ? WHERE id = ?').run(endTs, sessionId);
}

function getActiveSessionForTask(taskId) {
  const db = getDb();
  return db
    .prepare('SELECT * FROM sessions WHERE task_id = ? AND end_ts IS NULL ORDER BY id DESC LIMIT 1')
    .get(taskId);
}

function getActiveSessionsForUser(userId) {
  const db = getDb();
  return db
    .prepare('SELECT * FROM sessions WHERE user_id = ? AND end_ts IS NULL')
    .all(userId);
}

function closeActiveSessionsForTask(taskId, endTs) {
  const db = getDb();
  const activeSessions = db
    .prepare('SELECT * FROM sessions WHERE task_id = ? AND end_ts IS NULL')
    .all(taskId);
  for (const s of activeSessions) {
    db.prepare('UPDATE sessions SET end_ts = ? WHERE id = ?').run(endTs, s.id);
  }
  return activeSessions;
}

function getSessionsForTask(taskId) {
  const db = getDb();
  return db.prepare('SELECT * FROM sessions WHERE task_id = ? ORDER BY start_ts ASC').all(taskId);
}

function markBreakReminded(sessionId) {
  const db = getDb();
  db.prepare('UPDATE sessions SET break_reminded = 1 WHERE id = ?').run(sessionId);
}

// --- Adjustments ---
function insertAdjustment(adjData) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO adjustments (task_id, user_id, by_user_id, kind, minutes, reason, ts)
    VALUES (@task_id, @user_id, @by_user_id, @kind, @minutes, @reason, @ts)
  `);
  const info = stmt.run({
    task_id: adjData.task_id,
    user_id: adjData.user_id,
    by_user_id: adjData.by_user_id,
    kind: adjData.kind,
    minutes: adjData.minutes,
    reason: adjData.reason,
    ts: adjData.ts,
  });
  return db.prepare('SELECT * FROM adjustments WHERE id = ?').get(info.lastInsertRowid);
}

function getAdjustmentsForTask(taskId) {
  const db = getDb();
  return db.prepare('SELECT * FROM adjustments WHERE task_id = ? ORDER BY ts ASC').all(taskId);
}

// --- Updates (Notes) ---
function insertUpdateNote(taskId, userId, note, ts) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO updates (task_id, user_id, note, ts)
    VALUES (?, ?, ?, ?)
  `);
  const info = stmt.run(taskId, userId, note, ts);
  return db.prepare('SELECT * FROM updates WHERE id = ?').get(info.lastInsertRowid);
}

function getUpdatesForTask(taskId) {
  const db = getDb();
  return db.prepare('SELECT * FROM updates WHERE task_id = ? ORDER BY ts DESC').all(taskId);
}

function getLatestUpdateForTask(taskId) {
  const db = getDb();
  return db.prepare('SELECT * FROM updates WHERE task_id = ? ORDER BY ts DESC LIMIT 1').get(taskId);
}

// --- Recurring Tasks ---
function insertRecurring(recData) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO recurring (
      guild_id, channel_id, assignee_id, created_by, title,
      estimate_min, priority, schedule, time, weekday, last_run_date, active
    ) VALUES (
      @guild_id, @channel_id, @assignee_id, @created_by, @title,
      @estimate_min, @priority, @schedule, @time, @weekday, NULL, 1
    )
  `);
  const info = stmt.run({
    guild_id: recData.guild_id,
    channel_id: recData.channel_id,
    assignee_id: recData.assignee_id,
    created_by: recData.created_by,
    title: recData.title,
    estimate_min: recData.estimate_min,
    priority: recData.priority || 'Normal',
    schedule: recData.schedule,
    time: recData.time,
    weekday: recData.weekday || null,
  });
  return db.prepare('SELECT * FROM recurring WHERE id = ?').get(info.lastInsertRowid);
}

function getRecurringList(guildId) {
  const db = getDb();
  return db
    .prepare('SELECT * FROM recurring WHERE guild_id = ? AND active = 1 ORDER BY id ASC')
    .all(guildId);
}

function getRecurringById(id) {
  const db = getDb();
  return db.prepare('SELECT * FROM recurring WHERE id = ?').get(id);
}

function deactivateRecurring(id, guildId) {
  const db = getDb();
  const res = db
    .prepare('UPDATE recurring SET active = 0 WHERE id = ? AND guild_id = ?')
    .run(id, guildId);
  return res.changes > 0;
}

function updateRecurringLastRun(id, lastRunDate) {
  const db = getDb();
  db.prepare('UPDATE recurring SET last_run_date = ? WHERE id = ?').run(lastRunDate, id);
}

// --- Leaves ---
function insertLeave(leaveData) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO leaves (guild_id, user_id, start_date, end_date, reason)
    VALUES (?, ?, ?, ?, ?)
  `);
  const info = stmt.run(
    leaveData.guild_id,
    leaveData.user_id,
    leaveData.start_date,
    leaveData.end_date,
    leaveData.reason || null
  );
  return db.prepare('SELECT * FROM leaves WHERE id = ?').get(info.lastInsertRowid);
}

function cancelLeave(leaveId, guildId, userId = null) {
  const db = getDb();
  if (userId) {
    const res = db
      .prepare('DELETE FROM leaves WHERE id = ? AND guild_id = ? AND user_id = ?')
      .run(leaveId, guildId, userId);
    return res.changes > 0;
  }
  const res = db
    .prepare('DELETE FROM leaves WHERE id = ? AND guild_id = ?')
    .run(leaveId, guildId);
  return res.changes > 0;
}

function getUserLeaves(guildId, userId) {
  const db = getDb();
  return db
    .prepare('SELECT * FROM leaves WHERE guild_id = ? AND user_id = ? ORDER BY start_date DESC')
    .all(guildId, userId);
}

function isUserOnLeave(guildId, userId, dateStr) {
  const db = getDb();
  // Check if dateStr is between start_date and end_date (inclusive)
  const leave = db
    .prepare(
      `SELECT * FROM leaves
       WHERE guild_id = ? AND user_id = ?
         AND start_date <= ? AND end_date >= ?
       LIMIT 1`
    )
    .get(guildId, userId, dateStr, dateStr);
  return !!leave;
}

function getLeavesInPeriod(guildId, startDateStr, endDateStr, userId = null) {
  const db = getDb();
  let sql = `
    SELECT * FROM leaves
    WHERE guild_id = ?
      AND start_date <= ?
      AND end_date >= ?
  `;
  const params = [guildId, endDateStr, startDateStr];
  if (userId) {
    sql += ` AND user_id = ?`;
    params.push(userId);
  }
  return db.prepare(sql).all(...params);
}

// --- Holidays ---
function insertHoliday(guildId, dateStr, name) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO holidays (guild_id, date, name)
    VALUES (?, ?, ?)
  `);
  const info = stmt.run(guildId, dateStr, name);
  return db.prepare('SELECT * FROM holidays WHERE id = ?').get(info.lastInsertRowid);
}

function deleteHoliday(guildId, dateStr) {
  const db = getDb();
  const res = db
    .prepare('DELETE FROM holidays WHERE guild_id = ? AND date = ?')
    .run(guildId, dateStr);
  return res.changes > 0;
}

function isHoliday(guildId, dateStr) {
  const db = getDb();
  const holiday = db
    .prepare('SELECT * FROM holidays WHERE guild_id = ? AND date = ? LIMIT 1')
    .get(guildId, dateStr);
  return !!holiday;
}

function getHolidays(guildId) {
  const db = getDb();
  return db.prepare('SELECT * FROM holidays WHERE guild_id = ? ORDER BY date ASC').all(guildId);
}

// --- Meta (Scheduler Last Run Markers) ---
function getMeta(key) {
  const db = getDb();
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setMeta(key, value) {
  const db = getDb();
  db.prepare(`
    INSERT INTO meta (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

// --- Deadline Reminders Tracking ---
function markTaskDeadlineReminded(taskId, field) {
  const db = getDb();
  if (!['reminded_24h', 'reminded_2h', 'reminded_overdue'].includes(field)) {
    throw new Error(`Invalid deadline reminder field: ${field}`);
  }
  db.prepare(`UPDATE tasks SET ${field} = 1 WHERE id = ?`).run(taskId);
}

// --- Employee Work Shifts ---
function setShift({ guild_id, user_id, shift_start, shift_end, updated_by, updated_ts }) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO shifts (guild_id, user_id, shift_start, shift_end, updated_by, updated_ts)
    VALUES (@guild_id, @user_id, @shift_start, @shift_end, @updated_by, @updated_ts)
    ON CONFLICT(guild_id, user_id) DO UPDATE SET
      shift_start = excluded.shift_start,
      shift_end = excluded.shift_end,
      updated_by = excluded.updated_by,
      updated_ts = excluded.updated_ts
  `);
  stmt.run({
    guild_id,
    user_id,
    shift_start,
    shift_end,
    updated_by,
    updated_ts,
  });
  return getShift(guild_id, user_id);
}

function getShift(guildId, userId) {
  const db = getDb();
  return db
    .prepare('SELECT * FROM shifts WHERE guild_id = ? AND user_id = ?')
    .get(guildId, userId);
}

function getAllShifts(guildId) {
  const db = getDb();
  return db
    .prepare('SELECT * FROM shifts WHERE guild_id = ? ORDER BY id ASC')
    .all(guildId);
}

function deleteShift(guildId, userId) {
  const db = getDb();
  const res = db
    .prepare('DELETE FROM shifts WHERE guild_id = ? AND user_id = ?')
    .run(guildId, userId);
  return res.changes > 0;
}

function hasUserStartedWorkToday(userId, startOfDayTs) {
  const db = getDb();
  const session = db
    .prepare(`
      SELECT id FROM sessions
      WHERE user_id = ? AND (start_ts >= ? OR end_ts IS NULL)
      LIMIT 1
    `)
    .get(userId, startOfDayTs);
  return !!session;
}

module.exports = {
  initDb,
  getDb,
  closeDb,
  // Tasks
  insertTask,
  getTaskById,
  getTaskByMessageId,
  updateTaskMessageId,
  updateTaskStatus,
  updateTaskAssignee,
  updateTaskDetails,
  getUserActiveTasks,
  getUserOpenTasks,
  getAllOpenTasks,
  // Sessions
  insertSession,
  closeSession,
  getActiveSessionForTask,
  getActiveSessionsForUser,
  closeActiveSessionsForTask,
  getSessionsForTask,
  markBreakReminded,
  // Adjustments
  insertAdjustment,
  getAdjustmentsForTask,
  // Updates
  insertUpdateNote,
  getUpdatesForTask,
  getLatestUpdateForTask,
  // Recurring
  insertRecurring,
  getRecurringList,
  getRecurringById,
  deactivateRecurring,
  updateRecurringLastRun,
  // Leaves
  insertLeave,
  cancelLeave,
  getUserLeaves,
  isUserOnLeave,
  getLeavesInPeriod,
  // Holidays
  insertHoliday,
  deleteHoliday,
  isHoliday,
  getHolidays,
  // Meta
  getMeta,
  setMeta,
  // Deadline
  markTaskDeadlineReminded,
  // Shifts
  setShift,
  getShift,
  getAllShifts,
  deleteShift,
  hasUserStartedWorkToday,
};

