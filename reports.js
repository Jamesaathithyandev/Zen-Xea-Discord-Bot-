/**
 * Zen Xea Discord Bot - Reports & Analytics Layer
 * Aggregates work sessions, break sessions, adjustments, leaves, and calculates on-time vs over estimates.
 * Generates Discord embeds (respecting Discord limits) and CSV exports.
 */

const { DateTime } = require('luxon');
const { EmbedBuilder } = require('discord.js');
const config = require('./config');
const db = require('./db');
const { formatDuration, formatDateIST } = require('./logic');

/**
 * Calculate period start and end DateTime in Asia/Kolkata
 * @param {'daily'|'weekly'|'monthly'} period
 * @param {object} [options]
 * @param {DateTime} [options.refDt] - Reference DateTime (defaults to now in Asia/Kolkata)
 * @param {boolean} [options.isPrevious=false] - Whether to report for previous week/month
 * @returns {{ startDt: DateTime, endDt: DateTime, label: string }}
 */
function getPeriodBoundaries(period, { refDt = null, isPrevious = false } = {}) {
  const now = refDt || DateTime.now().setZone(config.TIMEZONE);

  if (period === 'daily') {
    const startDt = now.startOf('day');
    const endDt = now.endOf('day');
    return {
      startDt,
      endDt,
      label: `Daily (${startDt.toFormat('yyyy-MM-dd')})`,
    };
  }

  if (period === 'weekly') {
    // If isPrevious is true (e.g. scheduled report running Monday morning)
    const targetDt = isPrevious ? now.minus({ weeks: 1 }) : now;
    const startDt = targetDt.startOf('week'); // Monday 00:00:00
    const endDt = targetDt.endOf('week');     // Sunday 23:59:59
    return {
      startDt,
      endDt,
      label: `Weekly (${startDt.toFormat('yyyy-MM-dd')} to ${endDt.toFormat('yyyy-MM-dd')})`,
    };
  }

  if (period === 'monthly') {
    const targetDt = isPrevious ? now.minus({ months: 1 }) : now;
    const startDt = targetDt.startOf('month'); // 1st 00:00:00
    const endDt = targetDt.endOf('month');     // Last day 23:59:59
    return {
      startDt,
      endDt,
      label: `Monthly (${startDt.toFormat('MMMM yyyy')})`,
    };
  }

  throw new Error(`Unsupported period: ${period}`);
}

/**
 * Gather all activity data for a specific period, optionally filtered by member, department, or guild
 * @param {object} params
 * @param {'daily'|'weekly'|'monthly'} params.period
 * @param {string} [params.guildId]
 * @param {string} [params.userId]
 * @param {string} [params.department]
 * @param {object} [params.options] - options for boundaries (refDt, isPrevious)
 * @returns {object} Aggregated report data
 */
function generateReportData({ period, guildId = null, userId = null, department = null, options = {} }) {
  const { startDt, endDt, label } = getPeriodBoundaries(period, options);
  const periodStartTs = Math.floor(startDt.toSeconds());
  const periodEndTs = Math.floor(endDt.toSeconds());
  const nowTs = Math.floor(Date.now() / 1000);

  const database = db.getDb();

  // 1. Fetch relevant tasks
  let taskSql = 'SELECT * FROM tasks WHERE 1=1';
  const taskParams = [];

  if (guildId) {
    taskSql += ' AND guild_id = ?';
    taskParams.push(guildId);
  }
  if (department) {
    taskSql += ' AND LOWER(department) = LOWER(?)';
    taskParams.push(department);
  }
  if (userId) {
    taskSql += ' AND assignee_id = ?';
    taskParams.push(userId);
  }

  const allCandidateTasks = database.prepare(taskSql).all(...taskParams);
  const taskMap = new Map();
  for (const t of allCandidateTasks) {
    taskMap.set(t.id, t);
  }

  // 2. Fetch all sessions overlapping with the period
  // A session overlaps if start_ts < periodEndTs AND (end_ts IS NULL OR end_ts > periodStartTs)
  const sessionSql = `
    SELECT * FROM sessions
    WHERE start_ts <= ? AND (end_ts IS NULL OR end_ts >= ?)
  `;
  const allSessions = database.prepare(sessionSql).all(periodEndTs, periodStartTs);

  // 3. Fetch adjustments in the period
  const adjSql = `
    SELECT * FROM adjustments
    WHERE ts >= ? AND ts <= ?
  `;
  const allAdjustments = database.prepare(adjSql).all(periodStartTs, periodEndTs);

  // 4. Data structures for aggregation
  // Per-user mapping: userId -> userStats
  const userMap = new Map();

  function getOrCreateUserStats(uid) {
    if (!userMap.has(uid)) {
      userMap.set(uid, {
        userId: uid,
        workedSec: 0,
        breakSec: 0,
        workAdjMin: 0,
        breakAdjMin: 0,
        completedTasks: 0,
        onTimeTasks: 0,
        overEstimateTasks: 0,
        tasksWorked: new Map(), // taskId -> taskWorkedEntry
        blockedTasks: [],
        leaveDays: 0,
      });
    }
    return userMap.get(uid);
  }

  // Process sessions
  for (const s of allSessions) {
    const task = taskMap.get(s.task_id);
    if (!task) continue; // Not matching guild/dept/user filters

    const uStats = getOrCreateUserStats(s.user_id);

    const effectiveStart = s.start_ts;
    const effectiveEnd = s.end_ts || Math.min(nowTs, periodEndTs);

    const overlapStart = Math.max(effectiveStart, periodStartTs);
    const overlapEnd = Math.min(effectiveEnd, periodEndTs);

    if (overlapEnd > overlapStart) {
      const durSec = overlapEnd - overlapStart;
      if (s.kind === 'work') {
        uStats.workedSec += durSec;
      } else if (s.kind === 'break') {
        uStats.breakSec += durSec;
      }

      // Track task worked
      if (!uStats.tasksWorked.has(s.task_id)) {
        uStats.tasksWorked.set(s.task_id, {
          task,
          periodWorkedSec: 0,
          periodBreakSec: 0,
          periodWorkAdjMin: 0,
          periodBreakAdjMin: 0,
        });
      }
      const tw = uStats.tasksWorked.get(s.task_id);
      if (s.kind === 'work') tw.periodWorkedSec += durSec;
      else if (s.kind === 'break') tw.periodBreakSec += durSec;
    }
  }

  // Process adjustments
  for (const adj of allAdjustments) {
    const task = taskMap.get(adj.task_id);
    if (!task) continue;

    const uStats = getOrCreateUserStats(adj.user_id);
    if (adj.kind === 'work') {
      uStats.workAdjMin += adj.minutes;
    } else if (adj.kind === 'break') {
      uStats.breakAdjMin += adj.minutes;
    }

    if (!uStats.tasksWorked.has(adj.task_id)) {
      uStats.tasksWorked.set(adj.task_id, {
        task,
        periodWorkedSec: 0,
        periodBreakSec: 0,
        periodWorkAdjMin: 0,
        periodBreakAdjMin: 0,
      });
    }
    const tw = uStats.tasksWorked.get(adj.task_id);
    if (adj.kind === 'work') tw.periodWorkAdjMin += adj.minutes;
    else if (adj.kind === 'break') tw.periodBreakAdjMin += adj.minutes;
  }

  // Also include tasks assigned to user that were completed in this period even if session started before
  for (const task of allCandidateTasks) {
    const uStats = getOrCreateUserStats(task.assignee_id);
    if (task.status === 'blocked') {
      uStats.blockedTasks.push(task);
    }
  }

  // Calculate task completions, on-time vs over-estimate stats per user
  for (const [uid, uStats] of userMap.entries()) {
    // Total worked & break minutes for user
    uStats.totalWorkedMin = Math.max(0, Math.round(uStats.workedSec / 60) + uStats.workAdjMin);
    uStats.totalBreakMin = Math.max(0, Math.round(uStats.breakSec / 60) + uStats.breakAdjMin);

    // Evaluate each task worked
    for (const [taskId, tw] of uStats.tasksWorked.entries()) {
      const task = tw.task;
      tw.workedMin = Math.max(0, Math.round(tw.periodWorkedSec / 60) + tw.periodWorkAdjMin);
      tw.breakMin = Math.max(0, Math.round(tw.periodBreakSec / 60) + tw.periodBreakAdjMin);
      tw.adjustmentsMin = tw.periodWorkAdjMin;

      // Overall task totals (full task history, not just clipped period, for actual vs estimate)
      const overallStats = database
        .prepare(`
          SELECT
            SUM(CASE WHEN kind = 'work' THEN COALESCE(end_ts, ?) - start_ts ELSE 0 END) as overall_work_sec,
            SUM(CASE WHEN kind = 'break' THEN COALESCE(end_ts, ?) - start_ts ELSE 0 END) as overall_break_sec
          FROM sessions WHERE task_id = ?
        `)
        .get(nowTs, nowTs, taskId);

      const overallAdj = database
        .prepare(`
          SELECT
            SUM(CASE WHEN kind = 'work' THEN minutes ELSE 0 END) as overall_work_adj,
            SUM(CASE WHEN kind = 'break' THEN minutes ELSE 0 END) as overall_break_adj
          FROM adjustments WHERE task_id = ?
        `)
        .get(taskId);

      const totalWorkSoFar = Math.max(
        0,
        Math.round((overallStats.overall_work_sec || 0) / 60) + (overallAdj.overall_work_adj || 0)
      );

      tw.totalWorkSoFar = totalWorkSoFar;
      tw.estimateMin = task.estimate_min;

      // Latest note for task
      const latestNote = db.getLatestUpdateForTask(taskId);
      tw.latestNote = latestNote ? latestNote.note : null;

      // Status marker:
      // Cancelled tasks are excluded from on-time / over-estimate statistics but their time still counts
      if (task.status === 'cancelled') {
        tw.marker = 'cancelled';
      } else if (task.status === 'completed') {
        // Was it completed in this period?
        if (task.completed_ts >= periodStartTs && task.completed_ts <= periodEndTs) {
          uStats.completedTasks++;
          if (totalWorkSoFar <= task.estimate_min) {
            tw.marker = 'on_time';
            uStats.onTimeTasks++;
          } else {
            tw.marker = 'over';
            uStats.overEstimateTasks++;
          }
        } else {
          tw.marker = totalWorkSoFar <= task.estimate_min ? 'on_time' : 'over';
        }
      } else {
        tw.marker = 'ongoing';
      }
    }

    // Calculate days on leave in period for this user
    let leaveDays = 0;
    let currDay = startDt.startOf('day');
    const lastDay = endDt.startOf('day');

    while (currDay <= lastDay) {
      const dateStr = currDay.toFormat('yyyy-MM-dd');
      // If user has a leave on this date in guild
      if (db.isUserOnLeave(guildId || taskMap.values().next().value?.guild_id || '', uid, dateStr)) {
        leaveDays++;
      }
      currDay = currDay.plus({ days: 1 });
    }
    uStats.leaveDays = leaveDays;
  }

  // Filter out users who have 0 activity if we are summarizing
  const activeUserStats = Array.from(userMap.values()).filter(
    (u) => u.totalWorkedMin > 0 || u.totalBreakMin > 0 || u.tasksWorked.size > 0 || u.leaveDays > 0 || u.blockedTasks.length > 0
  );

  // Compute team totals
  let teamWorkedMin = 0;
  let teamBreakMin = 0;
  let teamCompleted = 0;
  let teamOnTime = 0;
  let teamOverEstimate = 0;

  for (const u of activeUserStats) {
    teamWorkedMin += u.totalWorkedMin;
    teamBreakMin += u.totalBreakMin;
    teamCompleted += u.completedTasks;
    teamOnTime += u.onTimeTasks;
    teamOverEstimate += u.overEstimateTasks;
  }

  return {
    period,
    label,
    startDt,
    endDt,
    department: department || 'All Departments',
    teamTotals: {
      workedMin: teamWorkedMin,
      breakMin: teamBreakMin,
      completed: teamCompleted,
      onTime: teamOnTime,
      overEstimate: teamOverEstimate,
    },
    users: activeUserStats,
  };
}

/**
 * Format report into one or more Discord embeds respecting limits:
 * - 25 fields max per embed
 * - 1024 characters max per field value
 * - 6000 total characters per embed
 * @param {object} reportData
 * @returns {EmbedBuilder[]}
 */
function buildReportEmbeds(reportData) {
  const embeds = [];

  let currentEmbed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle(`📊 Performance Report: ${reportData.label}`)
    .setDescription(
      `**Department:** ${reportData.department}\n` +
      `**Period:** ${reportData.startDt.toFormat('yyyy-MM-dd HH:mm')} - ${reportData.endDt.toFormat('yyyy-MM-dd HH:mm')} IST\n\n` +
      `**📈 Team Totals**\n` +
      `• Total Worked: **${formatDuration(reportData.teamTotals.workedMin)}**\n` +
      `• Total Breaks: **${formatDuration(reportData.teamTotals.breakMin)}**\n` +
      `• Tasks Completed: **${reportData.teamTotals.completed}** (${reportData.teamTotals.onTime} on-time, ${reportData.teamTotals.overEstimate} over estimate)\n` +
      `─────────────────────────────`
    )
    .setTimestamp();

  let fieldCount = 0;
  let currentEmbedCharCount = currentEmbed.data.title.length + currentEmbed.data.description.length;

  function pushEmbed() {
    embeds.push(currentEmbed);
    currentEmbed = new EmbedBuilder()
      .setColor(0x3498db)
      .setTitle(`📊 Performance Report (Cont.): ${reportData.label}`)
      .setTimestamp();
    fieldCount = 0;
    currentEmbedCharCount = currentEmbed.data.title.length;
  }

  if (reportData.users.length === 0) {
    currentEmbed.addFields({
      name: 'No Activity',
      value: 'No task activity, breaks, or leave recorded during this period.',
    });
    embeds.push(currentEmbed);
    return embeds;
  }

  for (const user of reportData.users) {
    const userLines = [];
    userLines.push(
      `**Worked:** ${formatDuration(user.totalWorkedMin)} | **Breaks:** ${formatDuration(user.totalBreakMin)}`
    );
    userLines.push(
      `**Completed:** ${user.completedTasks} (${user.onTimeTasks} on-time, ${user.overEstimateTasks} over)`
    );
    if (user.leaveDays > 0) {
      userLines.push(`**Leave:** ${user.leaveDays} day(s) in period`);
    }

    // List of tasks worked
    if (user.tasksWorked.size > 0) {
      userLines.push(`**Tasks:**`);
      for (const tw of user.tasksWorked.values()) {
        const markerEmoji =
          tw.marker === 'on_time'
            ? '✅ on-time'
            : tw.marker === 'over'
            ? '⚠️ over'
            : tw.marker === 'cancelled'
            ? '❌ cancelled'
            : '🔄 ongoing';

        let line = `• #${tw.task.id} **${tw.task.title}**: ${formatDuration(tw.totalWorkSoFar)} / ${formatDuration(tw.estimateMin)} [${markerEmoji}]`;
        if (tw.latestNote) {
          line += `\n  ↳ _Note: ${tw.latestNote}_`;
        }
        userLines.push(line);
      }
    }

    // Blocked tasks
    if (user.blockedTasks.length > 0) {
      userLines.push(`**🚫 Blocked Tasks:**`);
      for (const bt of user.blockedTasks) {
        userLines.push(`• #${bt.id} **${bt.title}** (Reason: ${bt.blocked_reason || 'Unknown'})`);
      }
    }

    // Chunk into fields of max 1024 chars if a single user's text is very long
    let fieldValue = userLines.join('\n');
    let fieldTitle = `👤 <@${user.userId}>`;

    const chunks = [];
    while (fieldValue.length > 1000) {
      const splitIdx = fieldValue.lastIndexOf('\n', 1000);
      const cut = splitIdx > 0 ? splitIdx : 1000;
      chunks.push(fieldValue.slice(0, cut));
      fieldValue = fieldValue.slice(cut).trim();
    }
    chunks.push(fieldValue);

    for (let i = 0; i < chunks.length; i++) {
      const title = i === 0 ? fieldTitle : `${fieldTitle} (cont.)`;
      const val = chunks[i] || '_No details_';

      if (fieldCount >= 24 || currentEmbedCharCount + title.length + val.length > 5500) {
        pushEmbed();
      }

      currentEmbed.addFields({ name: title, value: val, inline: false });
      fieldCount++;
      currentEmbedCharCount += title.length + val.length;
    }
  }

  embeds.push(currentEmbed);
  return embeds;
}

/**
 * Generate CSV export string for a period
 * Columns: date, department, user, task_id, title, priority, status, estimate_min, worked_min,
 *          break_min, adjustments_min, variance_min, deadline, completed_at
 * @param {object} params
 * @returns {string} CSV content
 */
function generateCsvExport({ period, guildId = null, userId = null, department = null, options = {} }) {
  const reportData = generateReportData({ period, guildId, userId, department, options });

  const headers = [
    'date',
    'department',
    'user',
    'task_id',
    'title',
    'priority',
    'status',
    'estimate_min',
    'worked_min',
    'break_min',
    'adjustments_min',
    'variance_min',
    'deadline',
    'completed_at',
  ];

  const rows = [];
  const reportDateStr = reportData.startDt.toFormat('yyyy-MM-dd');

  function escapeCsv(val) {
    if (val === null || val === undefined) return '';
    const str = String(val);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }

  for (const user of reportData.users) {
    for (const tw of user.tasksWorked.values()) {
      const task = tw.task;
      const workedMin = tw.workedMin;
      const breakMin = tw.breakMin;
      const adjMin = tw.adjustmentsMin;
      const varianceMin = workedMin - task.estimate_min;

      const deadline = task.deadline_ts ? formatDateIST(task.deadline_ts) : 'None';
      const completedAt = task.completed_ts ? formatDateIST(task.completed_ts) : 'None';

      rows.push([
        escapeCsv(reportDateStr),
        escapeCsv(task.department || 'General'),
        escapeCsv(user.userId),
        escapeCsv(task.id),
        escapeCsv(task.title),
        escapeCsv(task.priority),
        escapeCsv(task.status),
        escapeCsv(task.estimate_min),
        escapeCsv(workedMin),
        escapeCsv(breakMin),
        escapeCsv(adjMin),
        escapeCsv(varianceMin),
        escapeCsv(deadline),
        escapeCsv(completedAt),
      ]);
    }
  }

  const csvContent = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
  return { csvContent, reportData };
}

module.exports = {
  getPeriodBoundaries,
  generateReportData,
  buildReportEmbeds,
  generateCsvExport,
};

