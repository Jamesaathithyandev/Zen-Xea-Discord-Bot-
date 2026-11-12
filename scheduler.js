/**
 * Zen Xea Discord Bot - Scheduler & Automation Layer (node-cron)
 * Runs every minute in Asia/Kolkata timezone.
 * Handles EOD reminders, auto end-of-day, break reminders, deadline reminders,
 * recurring tasks, and scheduled department reports.
 * All jobs are restart-safe using database tracking.
 */

const cron = require('node-cron');
const { DateTime } = require('luxon');
const config = require('./config');
const db = require('./db');
const {
  assignTask,
  endDayTask,
  buildTaskEmbed,
  buildTaskActionRows,
  formatDateIST,
} = require('./logic');
const {
  generateReportData,
  buildReportEmbeds,
} = require('./reports');

/**
 * Check if a date is a non-working day or holiday
 * @param {string} guildId
 * @param {DateTime} nowDt
 * @returns {boolean}
 */
function isNonWorkingOrHoliday(guildId, nowDt) {
  // Check working days (Mon-Sat: 1-6)
  if (!config.WORKING_DAYS.includes(nowDt.weekday)) {
    return true;
  }
  const dateStr = nowDt.toFormat('yyyy-MM-dd');
  if (db.isHoliday(guildId, dateStr)) {
    return true;
  }
  return false;
}

/**
 * Send DM to a user, with fallback to posting a mention in the task channel if DMs are closed
 * @param {object} client - Discord client
 * @param {string} userId
 * @param {string} channelId
 * @param {string} content
 * @param {object} [options]
 */
async function sendDMOrChannelFallback(client, userId, channelId, content, options = {}) {
  let dmSent = false;
  try {
    const user = await client.users.fetch(userId);
    if (user) {
      await user.send({ content, ...options });
      dmSent = true;
    }
  } catch (err) {
    // Closed DMs or cannot message user
    dmSent = false;
  }

  if (!dmSent && channelId) {
    try {
      const channel = await client.channels.fetch(channelId);
      if (channel && channel.isTextBased()) {
        await channel.send({
          content: `<@${userId}> ${content}`,
          allowedMentions: { users: [userId] },
          ...options,
        });
      }
    } catch (err) {
      // Channel might be deleted or bot lacks permission
      console.error(`[Scheduler] Failed to post fallback to channel ${channelId}:`, err.message);
    }
  }
}

/**
 * Find department report channel:
 * Channel in the same category whose name contains "report" (case-insensitive).
 * Fallback: the channel where tasks were created.
 * @param {object} guild
 * @param {string} department
 * @param {string} [fallbackChannelId]
 * @returns {object|null}
 */
async function findReportChannel(guild, department, fallbackChannelId = null) {
  if (!guild || !guild.channels) return null;

  try {
    const channels = await guild.channels.fetch();

    // Look for channel in category matching department with 'report' in name
    const reportChannel = channels.find(
      (ch) =>
        ch &&
        ch.isTextBased() &&
        ch.parent &&
        ch.parent.name.toLowerCase() === department.toLowerCase() &&
        ch.name.toLowerCase().includes('report')
    );

    if (reportChannel) return reportChannel;

    // Fallback: search any channel in category
    if (fallbackChannelId) {
      const fallback = await guild.channels.fetch(fallbackChannelId).catch(() => null);
      if (fallback && fallback.isTextBased()) return fallback;
    }
  } catch (err) {
    console.error(`[Scheduler] Error finding report channel for ${department}:`, err.message);
  }

  return null;
}

// ==========================================
// AUTOMATION JOBS
// ==========================================

/**
 * 1. End-of-Day Reminder:
 * At EOD_REMINDER_TIME on working days, DM everyone with a task in_progress or on_break.
 * Skip users on leave and on holidays/non-working days.
 */
async function runEndOfDayReminder(client, nowDt = DateTime.now().setZone(config.TIMEZONE)) {
  const todayStr = nowDt.toFormat('yyyy-MM-dd');
  const currentTime = nowDt.toFormat('HH:mm');

  if (currentTime < config.EOD_REMINDER_TIME) return;

  const markerKey = `eod_reminder_${todayStr}`;
  if (db.getMeta(markerKey)) return;

  const database = db.getDb();
  // Fetch active tasks
  const activeTasks = database
    .prepare("SELECT * FROM tasks WHERE status IN ('in_progress', 'on_break')")
    .all();

  // Group by user
  const userTasks = new Map();
  for (const t of activeTasks) {
    if (!userTasks.has(t.assignee_id)) {
      userTasks.set(t.assignee_id, []);
    }
    userTasks.get(t.assignee_id).push(t);
  }

  for (const [userId, tasks] of userTasks.entries()) {
    const guildId = tasks[0].guild_id;

    // Skip if non-working day or holiday
    if (isNonWorkingOrHoliday(guildId, nowDt)) continue;

    // Skip if user on leave
    if (db.isUserOnLeave(guildId, userId, todayStr)) continue;

    const taskListStr = tasks.map((t) => `• #${t.id}: **${t.title}** (${t.status})`).join('\n');
    const eodFormatted = config.formatTime12h ? config.formatTime12h(config.EOD_REMINDER_TIME) : '7:30 PM';
    const msg =
      `🔔 **End-of-Day Reminder (${eodFormatted} IST)**\n` +
      `You still have active tasks in progress or on break:\n${taskListStr}\n` +
      `Please remember to wrap up and use **End Day** or **/endday** before leaving!`;

    await sendDMOrChannelFallback(client, userId, tasks[0].channel_id, msg);
  }

  db.setMeta(markerKey, 'done');
}

/**
 * 2. Auto End-of-Day:
 * At AUTO_END_DAY_TIME, end the day for every in_progress/on_break task (status paused) and
 * log "auto-ended at 8:30 PM, ask your manager to /adjust if you worked later".
 */
async function runAutoEndOfDay(client, nowDt = DateTime.now().setZone(config.TIMEZONE)) {
  const todayStr = nowDt.toFormat('yyyy-MM-dd');
  const currentTime = nowDt.toFormat('HH:mm');

  if (currentTime < config.AUTO_END_DAY_TIME) return;

  const markerKey = `auto_eod_${todayStr}`;
  if (db.getMeta(markerKey)) return;

  const nowTs = Math.floor(nowDt.toSeconds());
  const database = db.getDb();

  const activeTasks = database
    .prepare("SELECT * FROM tasks WHERE status IN ('in_progress', 'on_break')")
    .all();

  for (const task of activeTasks) {
    try {
      const { updatedTask } = endDayTask(task.id, task.assignee_id, nowTs, true);

      // Post log in channel
      if (client && client.channels && task.channel_id) {
        try {
          const channel = await client.channels.fetch(task.channel_id);
          if (channel && channel.isTextBased()) {
            const autoTimeFormatted = config.formatTime12h ? config.formatTime12h(config.AUTO_END_DAY_TIME) : '8:30 PM';
            await channel.send({
              content: `⏰ Task #${task.id} auto-ended at ${autoTimeFormatted}, ask your manager to /adjust if you worked later.`,
              allowedMentions: { parse: [] },
            });

            // Update card embed
            if (task.message_id) {
              const msg = await channel.messages.fetch(task.message_id).catch(() => null);
              if (msg) {
                const embed = buildTaskEmbed(updatedTask, nowTs);
                const rows = buildTaskActionRows(updatedTask);
                await msg.edit({ embeds: [embed], components: rows });
              }
            }
          }
        } catch (chErr) {
          console.error(`[Scheduler] Error updating channel on auto EOD:`, chErr.message);
        }
      }
    } catch (err) {
      console.error(`[Scheduler] Error auto-ending task #${task.id}:`, err.message);
    }
  }

  db.setMeta(markerKey, 'done');
}

/**
 * 3. Break Reminder:
 * If a break exceeds its limit in BREAK_LIMITS_MIN, DM the user once per break.
 * Tracked per session: break_reminded = 1.
 */
async function runBreakReminders(client, nowDt = DateTime.now().setZone(config.TIMEZONE)) {
  const nowTs = Math.floor(nowDt.toSeconds());
  const todayStr = nowDt.toFormat('yyyy-MM-dd');
  const database = db.getDb();

  const openBreaks = database
    .prepare(`
      SELECT s.*, t.guild_id, t.channel_id, t.title
      FROM sessions s
      JOIN tasks t ON s.task_id = t.id
      WHERE s.kind = 'break' AND s.end_ts IS NULL AND s.break_reminded = 0
    `)
    .all();

  for (const session of openBreaks) {
    // Skip if on leave or non-working day/holiday
    if (isNonWorkingOrHoliday(session.guild_id, nowDt)) continue;
    if (db.isUserOnLeave(session.guild_id, session.user_id, todayStr)) continue;

    const breakName = session.note || 'Other';
    const limitMin = config.BREAK_LIMITS_MIN[breakName] || config.BREAK_LIMITS_MIN['default'] || 30;
    const durationMin = Math.floor((nowTs - session.start_ts) / 60);

    if (durationMin >= limitMin) {
      const content =
        `⚠️ **Break Limit Exceeded**\n` +
        `Your break (**${breakName}**) on Task #${session.task_id} ("${session.title}") has reached **${durationMin}m** ` +
        `(allowed limit: ${limitMin}m). Please resume your task when ready.`;

      await sendDMOrChannelFallback(client, session.user_id, session.channel_id, content);
      db.markBreakReminded(session.id);
    }
  }
}

/**
 * 4. Deadline Reminders:
 * For tasks not completed/cancelled, DM the assignee at each hour in DEADLINE_REMINDERS_HOURS
 * before the deadline, and once when overdue. Track what was sent per task.
 */
async function runDeadlineReminders(client, nowDt = DateTime.now().setZone(config.TIMEZONE)) {
  const nowTs = Math.floor(nowDt.toSeconds());
  const todayStr = nowDt.toFormat('yyyy-MM-dd');
  const database = db.getDb();

  const tasksWithDeadlines = database
    .prepare(`
      SELECT * FROM tasks
      WHERE status NOT IN ('completed', 'cancelled')
        AND deadline_ts IS NOT NULL
    `)
    .all();

  for (const task of tasksWithDeadlines) {
    if (isNonWorkingOrHoliday(task.guild_id, nowDt)) continue;
    if (db.isUserOnLeave(task.guild_id, task.assignee_id, todayStr)) continue;

    const remainingSec = task.deadline_ts - nowTs;
    const remainingHours = remainingSec / 3600;

    // 24-hour reminder
    if (task.reminded_24h === 0 && remainingHours <= 24 && remainingHours > 2) {
      const msg = `⏰ **Deadline Reminder**\nTask #${task.id} (**${task.title}**) is due in ~${Math.round(remainingHours)} hours (${formatDateIST(task.deadline_ts)}).`;
      await sendDMOrChannelFallback(client, task.assignee_id, task.channel_id, msg);
      db.markTaskDeadlineReminded(task.id, 'reminded_24h');
    }

    // 2-hour reminder
    if (task.reminded_2h === 0 && remainingHours <= 2 && remainingHours > 0) {
      const remainingMins = Math.max(1, Math.round(remainingSec / 60));
      const msg = `⏰ **Urgent Deadline Reminder**\nTask #${task.id} (**${task.title}**) is due in ~${remainingMins} minutes (${formatDateIST(task.deadline_ts)})!`;
      await sendDMOrChannelFallback(client, task.assignee_id, task.channel_id, msg);
      db.markTaskDeadlineReminded(task.id, 'reminded_2h');
    }

    // Overdue reminder
    if (task.reminded_overdue === 0 && remainingSec <= 0) {
      const msg = `🚨 **Task Overdue**\nTask #${task.id} (**${task.title}**) was due at ${formatDateIST(task.deadline_ts)}. Please update status or complete it!`;
      await sendDMOrChannelFallback(client, task.assignee_id, task.channel_id, msg);
      db.markTaskDeadlineReminded(task.id, 'reminded_overdue');
    }
  }
}

/**
 * 7. Recurring Tasks:
 * Create due tasks and post their cards. Skip leave days, holidays and non-working days.
 */
async function runRecurringTasks(client, nowDt = DateTime.now().setZone(config.TIMEZONE)) {
  const todayStr = nowDt.toFormat('yyyy-MM-dd');
  const currentTime = nowDt.toFormat('HH:mm');
  const nowTs = Math.floor(nowDt.toSeconds());
  const database = db.getDb();

  const recurringList = database
    .prepare('SELECT * FROM recurring WHERE active = 1')
    .all();

  for (const rec of recurringList) {
    if (rec.last_run_date === todayStr) continue;
    if (currentTime < rec.time) continue;

    // Skip non-working days / holidays
    if (isNonWorkingOrHoliday(rec.guild_id, nowDt)) continue;

    // Skip if assignee is on leave
    if (db.isUserOnLeave(rec.guild_id, rec.assignee_id, todayStr)) continue;

    // Check schedule pattern
    let isDue = false;
    if (rec.schedule === 'daily') {
      isDue = true;
    } else if (rec.schedule === 'weekdays') {
      // Mon-Fri: Luxon weekday 1 to 5
      if (nowDt.weekday >= 1 && nowDt.weekday <= 5) {
        isDue = true;
      }
    } else if (rec.schedule === 'weekly') {
      if (nowDt.weekday === rec.weekday) {
        isDue = true;
      }
    }

    if (!isDue) continue;

    try {
      let dept = 'General';
      let channel = null;

      if (client && client.channels && rec.channel_id) {
        channel = await client.channels.fetch(rec.channel_id).catch(() => null);
        if (channel && channel.parent) {
          dept = channel.parent.name;
        }
      }

      // Create new task
      const newTask = assignTask({
        guildId: rec.guild_id,
        channelId: rec.channel_id,
        department: dept,
        title: rec.title,
        description: `Automated recurring task (${rec.schedule})`,
        priority: rec.priority,
        assigneeId: rec.assignee_id,
        assignedBy: rec.created_by,
        estimateHours: rec.estimate_min / 60,
        recurringId: rec.id,
        nowTs,
      });

      // Post embed card in channel if client is online
      if (channel && channel.isTextBased()) {
        const embed = buildTaskEmbed(newTask, nowTs);
        const rows = buildTaskActionRows(newTask);
        const msg = await channel.send({
          content: `🔄 **New Recurring Task** assigned to <@${newTask.assignee_id}>`,
          embeds: [embed],
          components: rows,
        });
        db.updateTaskMessageId(newTask.id, msg.id);
      }

      // Update last_run_date
      db.updateRecurringLastRun(rec.id, todayStr);
    } catch (err) {
      console.error(`[Scheduler] Error generating recurring task #${rec.id}:`, err.message);
    }
  }
}

/**
 * 8. Scheduled Reports:
 * - Daily at DAILY_REPORT_TIME
 * - Weekly Monday 09:00 (previous week)
 * - Monthly on 1st at 09:00 (previous month)
 * Post per department. Skip departments with no activity.
 */
async function runScheduledReports(client, nowDt = DateTime.now().setZone(config.TIMEZONE)) {
  const todayStr = nowDt.toFormat('yyyy-MM-dd');
  const currentTime = nowDt.toFormat('HH:mm');
  const database = db.getDb();

  // Find all distinct departments and guilds
  const depts = database
    .prepare('SELECT DISTINCT guild_id, department, channel_id FROM tasks WHERE department IS NOT NULL')
    .all();

  // A. Daily Report
  if (currentTime >= config.DAILY_REPORT_TIME && !isNonWorkingOrHoliday(depts[0]?.guild_id || '', nowDt)) {
    const dailyMarker = `daily_report_${todayStr}`;
    if (!db.getMeta(dailyMarker)) {
      for (const d of depts) {
        try {
          const reportData = generateReportData({
            period: 'daily',
            guildId: d.guild_id,
            department: d.department,
            options: { refDt: nowDt },
          });

          if (reportData.users.length === 0) continue; // Skip departments with no activity

          if (client && client.guilds) {
            const guild = await client.guilds.fetch(d.guild_id).catch(() => null);
            if (guild) {
              const targetChannel = await findReportChannel(guild, d.department, d.channel_id);
              if (targetChannel) {
                const embeds = buildReportEmbeds(reportData);
                await targetChannel.send({ embeds });
              }
            }
          }
        } catch (err) {
          console.error(`[Scheduler] Daily report error for ${d.department}:`, err.message);
        }
      }
      db.setMeta(dailyMarker, 'done');
    }
  }

  // B. Weekly Report (Monday at 09:00 for previous week)
  const weeklyDay = config.WEEKLY_REPORT_DAY || 1;
  const weeklyTime = config.WEEKLY_REPORT_TIME || '09:00';
  if (nowDt.weekday === weeklyDay && currentTime >= weeklyTime) {
    const weekKey = `weekly_report_${nowDt.year}_W${nowDt.weekNumber}`;
    if (!db.getMeta(weekKey)) {
      for (const d of depts) {
        try {
          const reportData = generateReportData({
            period: 'weekly',
            guildId: d.guild_id,
            department: d.department,
            options: { refDt: nowDt, isPrevious: true },
          });

          if (reportData.users.length === 0) continue;

          if (client && client.guilds) {
            const guild = await client.guilds.fetch(d.guild_id).catch(() => null);
            if (guild) {
              const targetChannel = await findReportChannel(guild, d.department, d.channel_id);
              if (targetChannel) {
                const embeds = buildReportEmbeds(reportData);
                await targetChannel.send({ embeds });
              }
            }
          }
        } catch (err) {
          console.error(`[Scheduler] Weekly report error for ${d.department}:`, err.message);
        }
      }
      db.setMeta(weekKey, 'done');
    }
  }

  // C. Monthly Report (1st of month at 09:00 for previous month)
  const monthlyDay = config.MONTHLY_REPORT_DAY || 1;
  const monthlyTime = config.MONTHLY_REPORT_TIME || '09:00';
  if (nowDt.day === monthlyDay && currentTime >= monthlyTime) {
    const monthKey = `monthly_report_${nowDt.year}_M${nowDt.month}`;
    if (!db.getMeta(monthKey)) {
      for (const d of depts) {
        try {
          const reportData = generateReportData({
            period: 'monthly',
            guildId: d.guild_id,
            department: d.department,
            options: { refDt: nowDt, isPrevious: true },
          });

          if (reportData.users.length === 0) continue;

          if (client && client.guilds) {
            const guild = await client.guilds.fetch(d.guild_id).catch(() => null);
            if (guild) {
              const targetChannel = await findReportChannel(guild, d.department, d.channel_id);
              if (targetChannel) {
                const embeds = buildReportEmbeds(reportData);
                await targetChannel.send({ embeds });
              }
            }
          }
        } catch (err) {
          console.error(`[Scheduler] Monthly report error for ${d.department}:`, err.message);
        }
      }
      db.setMeta(monthKey, 'done');
    }
  }
}

/**
 * 9. Shift Reminders (Shift Start Login & Shift End Logout):
 * Sends an alert if an employee hasn't logged in/started work after their shift begins,
 * or hasn't logged out/ended day after their shift ends, asking for a task status update.
 * ONLY triggers if the employee has active task(s) assigned under their name.
 * Skips employees on leave and on holidays/non-working days.
 */
async function runShiftReminders(client, nowDt = DateTime.now().setZone(config.TIMEZONE)) {
  if (config.SHIFT_ALERTS_ENABLED === false) return;

  // Check working day
  if (!config.WORKING_DAYS.includes(nowDt.weekday)) return;

  const todayStr = nowDt.toFormat('yyyy-MM-dd');
  const currentTime = nowDt.toFormat('HH:mm');
  const startOfDayTs = Math.floor(nowDt.startOf('day').toSeconds());
  const database = db.getDb();

  // Find all active/open tasks (status NOT in completed, cancelled)
  const openTasks = database
    .prepare("SELECT * FROM tasks WHERE status NOT IN ('completed', 'cancelled')")
    .all();

  // Group by (guild_id + user_id)
  const userTaskGroups = new Map();
  for (const t of openTasks) {
    const key = `${t.guild_id}:${t.assignee_id}`;
    if (!userTaskGroups.has(key)) {
      userTaskGroups.set(key, []);
    }
    userTaskGroups.get(key).push(t);
  }

  for (const [key, tasks] of userTaskGroups.entries()) {
    const [guildId, userId] = key.split(':');

    // Skip if holiday or user on leave
    if (db.isHoliday(guildId, todayStr)) continue;
    if (db.isUserOnLeave(guildId, userId, todayStr)) continue;

    // Fetch shift schedule for this user
    const userShift =
      db.getShift(guildId, userId) ||
      (config.APPLY_DEFAULT_SHIFTS
        ? { shift_start: config.DEFAULT_SHIFT_START, shift_end: config.DEFAULT_SHIFT_END }
        : null);

    if (!userShift) continue;

    // A. Shift Start Login Alert:
    // If shift has started, and user hasn't logged in (no work session today, not currently working)
    if (currentTime >= userShift.shift_start && currentTime < userShift.shift_end) {
      const loginMarker = `shift_login_${todayStr}_${userId}`;
      if (!db.getMeta(loginMarker)) {
        const hasStartedToday = db.hasUserStartedWorkToday(userId, startOfDayTs);
        const hasActiveSession = tasks.some(
          (t) => t.status === 'in_progress' || t.status === 'on_break'
        );

        if (!hasStartedToday && !hasActiveSession) {
          // Employee has NOT logged in or started working today
          const taskSample = tasks.slice(0, 3).map((t) => `#${t.id} ("${t.title}")`).join(', ');
          const shiftStartFormatted = config.formatTime12h
            ? config.formatTime12h(userShift.shift_start)
            : userShift.shift_start;

          const content =
            `⏰ **Work Shift Reminder (Shift Started at ${shiftStartFormatted} IST)**\n` +
            `Your shift has started, but you haven't logged in or started working on your task yet!\n` +
            `• Assigned Task(s): **${taskSample}**\n` +
            `Please click **Start** or use \`/start\` to begin tracking your work, or provide a status update.`;

          await sendDMOrChannelFallback(client, userId, tasks[0].channel_id, content);
          db.setMeta(loginMarker, 'done');
        }
      }
    }

    // B. Shift End Logout Alert:
    // If shift has ended, but user still has a task in_progress or on_break
    if (currentTime >= userShift.shift_end) {
      const logoutMarker = `shift_logout_${todayStr}_${userId}`;
      if (!db.getMeta(logoutMarker)) {
        const runningTasks = tasks.filter(
          (t) => t.status === 'in_progress' || t.status === 'on_break'
        );

        if (runningTasks.length > 0) {
          // Employee has NOT logged out / ended day
          const taskSample = runningTasks.map((t) => `#${t.id} ("${t.title}")`).join(', ');
          const shiftEndFormatted = config.formatTime12h
            ? config.formatTime12h(userShift.shift_end)
            : userShift.shift_end;

          const content =
            `🔔 **Work Shift Reminder (Shift Ended at ${shiftEndFormatted} IST)**\n` +
            `Your shift has ended, but you still have running task(s) that haven't been closed!\n` +
            `• Running Task(s): **${taskSample}**\n` +
            `Please click **End Day** or mark as **Completed**, and update your progress before logging off.`;

          await sendDMOrChannelFallback(client, userId, runningTasks[0].channel_id, content);
          db.setMeta(logoutMarker, 'done');
        }
      }
    }
  }
}

/**
 * Main tick handler executed every minute
 */
async function tick(client) {
  const nowDt = DateTime.now().setZone(config.TIMEZONE);

  try {
    await runBreakReminders(client, nowDt);
    await runDeadlineReminders(client, nowDt);
    await runShiftReminders(client, nowDt);
    await runEndOfDayReminder(client, nowDt);
    await runAutoEndOfDay(client, nowDt);
    await runRecurringTasks(client, nowDt);
    await runScheduledReports(client, nowDt);
  } catch (err) {
    console.error('[Scheduler] Unexpected error during scheduler tick:', err);
  }
}

/**
 * Start the node-cron scheduler
 * @param {object} client - Discord client
 * @returns {cron.ScheduledTask}
 */
function startScheduler(client) {
  // Run every minute in Asia/Kolkata
  const job = cron.schedule('* * * * *', () => tick(client), {
    timezone: config.TIMEZONE,
  });
  console.log(`[Scheduler] Cron scheduled (* * * * *) in timezone ${config.TIMEZONE}`);
  return job;
}

module.exports = {
  isNonWorkingOrHoliday,
  sendDMOrChannelFallback,
  findReportChannel,
  runEndOfDayReminder,
  runAutoEndOfDay,
  runBreakReminders,
  runDeadlineReminders,
  runShiftReminders,
  runRecurringTasks,
  runScheduledReports,
  tick,
  startScheduler,
};

