/**
 * Zen Xea Discord Bot - Business Logic Layer
 * State transitions, time calculations, role validation, card generation.
 */

const { DateTime } = require('luxon');
const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
} = require('discord.js');
const config = require('./config');
const db = require('./db');

/**
 * Check if a member has manager privileges.
 * Managers = anyone with Administrator OR a role named (case-insensitive):
 * founder, management, hr manager, dm manager, seo manager, tech lead, sales manager.
 * @param {object} member - Discord GuildMember or mock test member
 * @returns {boolean}
 */
function isManager(member) {
  if (!member) return false;

  // Direct boolean flag (useful in testing)
  if (member.isAdmin || member.isManager) return true;

  // Discord.js Permissions check
  if (member.permissions) {
    if (typeof member.permissions.has === 'function') {
      try {
        if (member.permissions.has(PermissionFlagsBits.Administrator)) {
          return true;
        }
      } catch (_) {
        // fallback if permissions format differs
      }
    } else if (Array.isArray(member.permissions) && member.permissions.includes('Administrator')) {
      return true;
    }
  }

  // Discord.js Roles check (Collection/Map in discord.js or Array in mocks)
  if (member.roles) {
    const rolesList = [];
    if (member.roles.cache && typeof member.roles.cache.values === 'function') {
      for (const r of member.roles.cache.values()) {
        rolesList.push(r.name.toLowerCase());
      }
    } else if (Array.isArray(member.roles)) {
      for (const r of member.roles) {
        if (typeof r === 'string') rolesList.push(r.toLowerCase());
        else if (r && r.name) rolesList.push(r.name.toLowerCase());
      }
    }

    const managerRoles = config.MANAGER_ROLES.map((r) => r.toLowerCase());
    if (rolesList.some((roleName) => managerRoles.includes(roleName))) {
      return true;
    }
  }

  return false;
}

/**
 * Format duration in minutes to human-readable string (e.g., '1h 30m', '45m', '0m')
 * @param {number} minutes
 * @returns {string}
 */
function formatDuration(minutes) {
  if (minutes === null || minutes === undefined || isNaN(minutes)) return '0m';
  const mins = Math.round(minutes);
  if (mins === 0) return '0m';
  const sign = mins < 0 ? '-' : '';
  const absMins = Math.abs(mins);
  const h = Math.floor(absMins / 60);
  const m = absMins % 60;
  if (h === 0) return `${sign}${m}m`;
  if (m === 0) return `${sign}${h}h`;
  return `${sign}${h}h ${m}m`;
}

/**
 * Format Unix seconds to Asia/Kolkata date string
 * @param {number} unixTs - Unix timestamp in seconds
 * @returns {string}
 */
function formatDateIST(unixTs) {
  if (!unixTs) return 'None';
  return DateTime.fromSeconds(unixTs, { zone: config.TIMEZONE }).toFormat(
    'yyyy-MM-dd HH:mm IST'
  );
}

/**
 * Parse an IST date string 'YYYY-MM-DD HH:mm' into UTC Unix seconds
 * @param {string} dateStr
 * @returns {number|null}
 */
function parseDeadlineIST(dateStr) {
  if (!dateStr) return null;
  const dt = DateTime.fromFormat(dateStr.trim(), 'yyyy-MM-dd HH:mm', {
    zone: config.TIMEZONE,
  });
  if (!dt.isValid) {
    throw new Error(
      `Invalid deadline format "${dateStr}". Expected format: YYYY-MM-DD HH:mm (IST)`
    );
  }
  return Math.floor(dt.toSeconds());
}

/**
 * Calculate worked time and break time stats for a task
 * @param {number} taskId
 * @param {number} [nowTs]
 * @returns {{ workedMin: number, breakMin: number, workAdjMin: number, breakAdjMin: number, breaksCount: number }}
 */
function getTaskTimeStats(taskId, nowTs = Math.floor(Date.now() / 1000)) {
  const sessions = db.getSessionsForTask(taskId);
  const adjustments = db.getAdjustmentsForTask(taskId);

  let workSec = 0;
  let breakSec = 0;
  let breaksCount = 0;

  for (const s of sessions) {
    const end = s.end_ts || nowTs;
    const duration = Math.max(0, end - s.start_ts);
    if (s.kind === 'work') {
      workSec += duration;
    } else if (s.kind === 'break') {
      breakSec += duration;
      breaksCount++;
    }
  }

  let workAdjMin = 0;
  let breakAdjMin = 0;
  for (const adj of adjustments) {
    if (adj.kind === 'work') {
      workAdjMin += adj.minutes;
    } else if (adj.kind === 'break') {
      breakAdjMin += adj.minutes;
    }
  }

  const workedMin = Math.max(0, Math.round(workSec / 60) + workAdjMin);
  const breakMin = Math.max(0, Math.round(breakSec / 60) + breakAdjMin);

  return {
    workedMin,
    breakMin,
    workAdjMin,
    breakAdjMin,
    breaksCount,
  };
}

/**
 * Build the Discord Embed for a task card
 * @param {object} task
 * @param {number} [nowTs]
 * @returns {EmbedBuilder}
 */
function buildTaskEmbed(task, nowTs = Math.floor(Date.now() / 1000)) {
  const stats = getTaskTimeStats(task.id, nowTs);
  const priorityInfo = config.PRIORITIES[task.priority] || config.PRIORITIES.Normal;
  const statusInfo = config.STATUS_DETAILS[task.status] || {
    label: task.status,
    emoji: '❓',
  };

  const embed = new EmbedBuilder()
    .setColor(priorityInfo.color)
    .setTitle(`${priorityInfo.emoji} #${task.id}: ${task.title}`)
    .setDescription(task.description ? task.description : '_No description provided._')
    .addFields(
      {
        name: 'Status',
        value: `${statusInfo.emoji} **${statusInfo.label}**`,
        inline: true,
      },
      {
        name: 'Priority',
        value: `${priorityInfo.emoji} ${task.priority}`,
        inline: true,
      },
      {
        name: 'Department',
        value: task.department || 'General',
        inline: true,
      },
      {
        name: 'Assignee',
        value: `<@${task.assignee_id}>`,
        inline: true,
      },
      {
        name: 'Assigned By',
        value: `<@${task.assigned_by}>`,
        inline: true,
      },
      {
        name: 'Estimate',
        value: formatDuration(task.estimate_min),
        inline: true,
      },
      {
        name: 'Worked Time',
        value: `${formatDuration(stats.workedMin)}${
          stats.workAdjMin !== 0
            ? ` (${stats.workAdjMin > 0 ? '+' : ''}${stats.workAdjMin}m adj)`
            : ''
        }`,
        inline: true,
      },
      {
        name: 'Breaks Time',
        value: `${formatDuration(stats.breakMin)} (${stats.breaksCount} breaks)`,
        inline: true,
      },
      {
        name: 'Deadline',
        value: formatDateIST(task.deadline_ts),
        inline: true,
      }
    )
    .setFooter({
      text: `Task #${task.id} • Created: ${formatDateIST(task.created_ts)}`,
    });

  if (task.status === 'blocked' && task.blocked_reason) {
    embed.addFields({
      name: '🚫 Blocked Reason',
      value: task.blocked_reason,
      inline: false,
    });
  }

  if (task.status === 'cancelled' && task.cancel_reason) {
    embed.addFields({
      name: '❌ Cancellation Reason',
      value: task.cancel_reason,
      inline: false,
    });
  }

  return embed;
}

/**
 * Build the Discord Action Rows with buttons for a task
 * Row 1 buttons: Start, Break, Resume, End Day, Complete.
 * Row 2 buttons: Blocked, Update.
 * Buttons use fixed customIds handled in global interactionCreate listener.
 * @param {object} task
 * @returns {ActionRowBuilder[]}
 */
function buildTaskActionRows(task) {
  const isTerminal = task.status === 'completed' || task.status === 'cancelled';

  // Row 1 buttons
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('task_start')
      .setLabel('Start')
      .setStyle(ButtonStyle.Success)
      .setDisabled(isTerminal || task.status === 'in_progress' || task.status === 'on_break'),
    new ButtonBuilder()
      .setCustomId('task_break')
      .setLabel('Break')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(isTerminal || task.status !== 'in_progress'),
    new ButtonBuilder()
      .setCustomId('task_resume')
      .setLabel('Resume')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(isTerminal || task.status !== 'on_break'),
    new ButtonBuilder()
      .setCustomId('task_endday')
      .setLabel('End Day')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(isTerminal || (task.status !== 'in_progress' && task.status !== 'on_break')),
    new ButtonBuilder()
      .setCustomId('task_complete')
      .setLabel('Complete')
      .setStyle(ButtonStyle.Success)
      .setDisabled(isTerminal || task.status === 'assigned')
  );

  // Row 2 buttons
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('task_blocked')
      .setLabel('Blocked')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(isTerminal || task.status === 'blocked'),
    new ButtonBuilder()
      .setCustomId('task_update')
      .setLabel('Update Note')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(isTerminal)
  );

  return [row1, row2];
}

/**
 * Auto-pick task if taskId is omitted, or validate existing task
 * @param {string} userId
 * @param {string[]} validStatuses
 * @param {number|null} taskId
 * @returns {{ success: boolean, task?: object, message?: string }}
 */
function autoPickTask(userId, validStatuses, taskId = null) {
  if (taskId) {
    const task = db.getTaskById(taskId);
    if (!task) {
      return { success: false, message: `Task #${taskId} not found.` };
    }
    if (!validStatuses.includes(task.status)) {
      return {
        success: false,
        message: `Task #${taskId} is currently **${task.status}**, which cannot perform this action (expected: ${validStatuses.join(', ')}).`,
      };
    }
    return { success: true, task };
  }

  // Find all open tasks assigned to this user matching the valid statuses
  const openTasks = db.getUserOpenTasks(userId);
  const matching = openTasks.filter((t) => validStatuses.includes(t.status));

  if (matching.length === 1) {
    return { success: true, task: matching[0] };
  }

  if (matching.length === 0) {
    return {
      success: false,
      message: `No active task found for you with status: **${validStatuses.join(', ')}**. Please check your tasks with \`/tasks\`.`,
    };
  }

  // Multiple tasks match
  const taskListStr = matching
    .map((t) => `• #${t.id}: **${t.title}** (${t.status})`)
    .join('\n');
  return {
    success: false,
    message: `You have multiple matching tasks. Please specify \`task_id\`:\n${taskListStr}`,
  };
}

// ==========================================
// TASK ACTIONS
// ==========================================

/**
 * Assign a new task (Manager only)
 */
function assignTask({
  guildId,
  channelId,
  department = 'General',
  title,
  description = null,
  priority = 'Normal',
  assigneeId,
  assignedBy,
  estimateHours,
  deadlineStr = null,
  recurringId = null,
  nowTs = Math.floor(Date.now() / 1000),
}) {
  if (!title || typeof title !== 'string' || !title.trim()) {
    throw new Error('Task title is required.');
  }
  const estHours = Number(estimateHours);
  if (isNaN(estHours) || estHours <= 0) {
    throw new Error('Estimate hours must be a positive number.');
  }
  const estimateMin = Math.round(estHours * 60);

  const deadlineTs = deadlineStr ? parseDeadlineIST(deadlineStr) : null;
  if (deadlineTs && deadlineTs <= nowTs) {
    throw new Error('Deadline must be in the future.');
  }

  const validPriority = ['Low', 'Normal', 'Urgent'].includes(priority)
    ? priority
    : 'Normal';

  const task = db.insertTask({
    guild_id: guildId,
    channel_id: channelId,
    department,
    title: title.trim(),
    description: description ? description.trim() : null,
    priority: validPriority,
    assignee_id: assigneeId,
    assigned_by: assignedBy,
    estimate_min: estimateMin,
    deadline_ts: deadlineTs,
    status: 'assigned',
    created_ts: nowTs,
    recurring_id: recurringId,
  });

  return task;
}

/**
 * Start a task.
 * Refuse if user already has another task in_progress or on_break.
 * Allowed from assigned or paused.
 */
function startTask(taskId, userId, nowTs = Math.floor(Date.now() / 1000)) {
  const task = db.getTaskById(taskId);
  if (!task) throw new Error(`Task #${taskId} not found.`);
  if (task.assignee_id !== userId) {
    throw new Error(`Only the assignee (<@${task.assignee_id}>) can start this task.`);
  }

  if (task.status !== 'assigned' && task.status !== 'paused') {
    throw new Error(
      `Cannot start Task #${taskId}. Current status is **${task.status}** (must be assigned or paused).`
    );
  }

  // Refuse if user already has another task in_progress or on_break
  const activeTasks = db.getUserActiveTasks(userId, task.guild_id);
  const otherActive = activeTasks.find((t) => t.id !== taskId);
  if (otherActive) {
    throw new Error(
      `Cannot start Task #${taskId}. You already have Task #${otherActive.id} ("${otherActive.title}") **${otherActive.status}**. Please pause or complete it first.`
    );
  }

  // Close any stray open sessions on this task
  db.closeActiveSessionsForTask(taskId, nowTs);

  // Open work session
  db.insertSession({
    task_id: taskId,
    user_id: userId,
    kind: 'work',
    start_ts: nowTs,
  });

  const updatedTask = db.updateTaskStatus(taskId, 'in_progress');
  return updatedTask;
}

/**
 * Take a break.
 * Allowed only from in_progress.
 */
function breakTask(taskId, userId, reason = 'Tea / short break', nowTs = Math.floor(Date.now() / 1000)) {
  const task = db.getTaskById(taskId);
  if (!task) throw new Error(`Task #${taskId} not found.`);
  if (task.assignee_id !== userId) {
    throw new Error(`Only the assignee (<@${task.assignee_id}>) can take a break on this task.`);
  }

  if (task.status !== 'in_progress') {
    throw new Error(`Cannot take a break. Task #${taskId} is not in_progress (current: **${task.status}**).`);
  }

  // Close active work session
  db.closeActiveSessionsForTask(taskId, nowTs);

  // Open break session
  db.insertSession({
    task_id: taskId,
    user_id: userId,
    kind: 'break',
    note: reason,
    start_ts: nowTs,
    break_reminded: 0,
  });

  const updatedTask = db.updateTaskStatus(taskId, 'on_break');
  return updatedTask;
}

/**
 * Resume task from break.
 * Allowed only from on_break.
 */
function resumeTask(taskId, userId, nowTs = Math.floor(Date.now() / 1000)) {
  const task = db.getTaskById(taskId);
  if (!task) throw new Error(`Task #${taskId} not found.`);
  if (task.assignee_id !== userId) {
    throw new Error(`Only the assignee (<@${task.assignee_id}>) can resume this task.`);
  }

  if (task.status !== 'on_break') {
    throw new Error(`Cannot resume Task #${taskId}. Task is not on_break (current: **${task.status}**).`);
  }

  // Find active break session to measure duration
  const breakSession = db.getActiveSessionForTask(taskId);
  let breakDurationMin = 0;
  if (breakSession) {
    breakDurationMin = Math.max(0, Math.round((nowTs - breakSession.start_ts) / 60));
  }

  // Close active break session
  db.closeActiveSessionsForTask(taskId, nowTs);

  // Open new work session
  db.insertSession({
    task_id: taskId,
    user_id: userId,
    kind: 'work',
    start_ts: nowTs,
  });

  const updatedTask = db.updateTaskStatus(taskId, 'in_progress');
  return { updatedTask, breakDurationMin, breakReason: breakSession ? breakSession.note : 'Break' };
}

/**
 * End day.
 * From in_progress or on_break. Closes sessions, status paused.
 * Optionally records a progress/status update note.
 */
function endDayTask(taskId, userId, nowTs = Math.floor(Date.now() / 1000), isAuto = false, note = null) {
  const task = db.getTaskById(taskId);
  if (!task) throw new Error(`Task #${taskId} not found.`);

  if (!isAuto && task.assignee_id !== userId) {
    throw new Error(`Only the assignee (<@${task.assignee_id}>) can end day on this task.`);
  }

  if (task.status !== 'in_progress' && task.status !== 'on_break') {
    throw new Error(
      `Cannot end day on Task #${taskId}. Task is not active (current status: **${task.status}**).`
    );
  }

  // Close active sessions
  db.closeActiveSessionsForTask(taskId, nowTs);

  // If a note was provided, record update
  if (note && note.trim()) {
    db.insertUpdateNote(taskId, userId, note.trim(), nowTs);
  }

  const updatedTask = db.updateTaskStatus(taskId, 'paused');
  const stats = getTaskTimeStats(taskId, nowTs);

  return {
    updatedTask,
    workedMin: stats.workedMin,
    estimateMin: task.estimate_min,
    note: note ? note.trim() : null,
  };
}

/**
 * Block a task.
 * Allowed from in_progress, on_break or paused.
 */
function blockedTask(taskId, userId, reason, nowTs = Math.floor(Date.now() / 1000)) {
  const task = db.getTaskById(taskId);
  if (!task) throw new Error(`Task #${taskId} not found.`);
  if (task.assignee_id !== userId) {
    throw new Error(`Only the assignee (<@${task.assignee_id}>) can mark this task as blocked.`);
  }

  if (!['in_progress', 'on_break', 'paused'].includes(task.status)) {
    throw new Error(
      `Cannot mark Task #${taskId} as blocked. Status must be in_progress, on_break, or paused (current: **${task.status}**).`
    );
  }

  if (!reason || !reason.trim()) {
    throw new Error('A reason is required when blocking a task.');
  }

  // Close open sessions
  db.closeActiveSessionsForTask(taskId, nowTs);

  const updatedTask = db.updateTaskStatus(taskId, 'blocked', {
    blocked_reason: reason.trim(),
  });

  return updatedTask;
}

/**
 * Unblock a task.
 * Allowed by assignee or manager.
 * Changes status: blocked -> paused.
 */
function unblockTask(taskId, userId, hasManagerRole, nowTs = Math.floor(Date.now() / 1000)) {
  const task = db.getTaskById(taskId);
  if (!task) throw new Error(`Task #${taskId} not found.`);

  const isAssignee = task.assignee_id === userId;
  if (!isAssignee && !hasManagerRole) {
    throw new Error('Only the assignee or a manager can unblock this task.');
  }

  if (task.status !== 'blocked') {
    throw new Error(`Task #${taskId} is not blocked (current status: **${task.status}**).`);
  }

  const updatedTask = db.updateTaskStatus(taskId, 'paused', {
    blocked_reason: null,
  });

  return updatedTask;
}

/**
 * Complete a task.
 * Allowed from in_progress, on_break or paused.
 * Posts summary: worked vs estimate, total breaks, deadline missed or not, assigner ping.
 */
function completeTask(taskId, userId, nowTs = Math.floor(Date.now() / 1000)) {
  const task = db.getTaskById(taskId);
  if (!task) throw new Error(`Task #${taskId} not found.`);
  if (task.assignee_id !== userId) {
    throw new Error(`Only the assignee (<@${task.assignee_id}>) can complete this task.`);
  }

  if (!['in_progress', 'on_break', 'paused'].includes(task.status)) {
    throw new Error(
      `Cannot complete Task #${taskId}. Current status is **${task.status}** (must be in_progress, on_break, or paused).`
    );
  }

  // Close active sessions
  db.closeActiveSessionsForTask(taskId, nowTs);

  const updatedTask = db.updateTaskStatus(taskId, 'completed', {
    completed_ts: nowTs,
  });

  const stats = getTaskTimeStats(taskId, nowTs);
  const diffMin = stats.workedMin - task.estimate_min;

  let estimateComparison = 'on time';
  if (diffMin < 0) {
    estimateComparison = `${formatDuration(Math.abs(diffMin))} under estimate`;
  } else if (diffMin > 0) {
    estimateComparison = `${formatDuration(diffMin)} longer than estimate`;
  }

  let deadlineStatus = 'No deadline set';
  if (task.deadline_ts) {
    if (nowTs <= task.deadline_ts) {
      deadlineStatus = 'Met on time ✅';
    } else {
      const overdueMins = Math.round((nowTs - task.deadline_ts) / 60);
      deadlineStatus = `Missed by ${formatDuration(overdueMins)} ⚠️`;
    }
  }

  return {
    updatedTask,
    workedMin: stats.workedMin,
    breakMin: stats.breakMin,
    breaksCount: stats.breaksCount,
    estimateMin: task.estimate_min,
    estimateComparison,
    deadlineStatus,
    assignedBy: task.assigned_by,
  };
}

/**
 * Cancel a task (Manager only).
 * Any non-completed status.
 */
function cancelTask(taskId, managerId, reason, hasManagerRole, nowTs = Math.floor(Date.now() / 1000)) {
  if (!hasManagerRole) {
    throw new Error('Only managers can cancel a task.');
  }

  const task = db.getTaskById(taskId);
  if (!task) throw new Error(`Task #${taskId} not found.`);

  if (task.status === 'completed') {
    throw new Error(`Cannot cancel Task #${taskId} because it is already completed.`);
  }

  if (!reason || !reason.trim()) {
    throw new Error('A reason is required to cancel a task.');
  }

  // Close active sessions
  db.closeActiveSessionsForTask(taskId, nowTs);

  const updatedTask = db.updateTaskStatus(taskId, 'cancelled', {
    cancel_reason: reason.trim(),
  });

  return updatedTask;
}

/**
 * Reassign task (Manager only).
 * Closes open sessions, new assignee, status paused if work already exists else assigned.
 * Past sessions stay credited to original user.
 */
function reassignTask(taskId, newAssigneeId, managerId, hasManagerRole, nowTs = Math.floor(Date.now() / 1000)) {
  if (!hasManagerRole) {
    throw new Error('Only managers can reassign a task.');
  }

  const task = db.getTaskById(taskId);
  if (!task) throw new Error(`Task #${taskId} not found.`);

  if (task.status === 'completed' || task.status === 'cancelled') {
    throw new Error(`Cannot reassign Task #${taskId} because it is **${task.status}**.`);
  }

  // Close open sessions
  db.closeActiveSessionsForTask(taskId, nowTs);

  // Check if work already exists on this task
  const sessions = db.getSessionsForTask(taskId);
  const adjustments = db.getAdjustmentsForTask(taskId);
  const hasWork = sessions.some((s) => s.kind === 'work') || adjustments.some((a) => a.kind === 'work');

  const newStatus = hasWork ? 'paused' : 'assigned';
  const updatedTask = db.updateTaskAssignee(taskId, newAssigneeId, newStatus);

  return { updatedTask, oldAssigneeId: task.assignee_id };
}

/**
 * Edit task details (Manager only).
 */
function editTask(
  taskId,
  { title, estimateHours, deadlineStr, priority, description },
  managerId,
  hasManagerRole,
  nowTs = Math.floor(Date.now() / 1000)
) {
  if (!hasManagerRole) {
    throw new Error('Only managers can edit a task.');
  }

  const task = db.getTaskById(taskId);
  if (!task) throw new Error(`Task #${taskId} not found.`);

  const changes = [];
  const fieldsToUpdate = {};

  if (title !== undefined && title.trim() && title.trim() !== task.title) {
    changes.push(`Title: "${task.title}" → "${title.trim()}"`);
    fieldsToUpdate.title = title.trim();
  }

  if (estimateHours !== undefined && estimateHours !== null) {
    const est = Number(estimateHours);
    if (isNaN(est) || est <= 0) {
      throw new Error('Estimate hours must be a positive number.');
    }
    const newEstMin = Math.round(est * 60);
    if (newEstMin !== task.estimate_min) {
      changes.push(
        `Estimate: ${formatDuration(task.estimate_min)} → ${formatDuration(newEstMin)}`
      );
      fieldsToUpdate.estimate_min = newEstMin;
    }
  }

  if (deadlineStr !== undefined) {
    const newDeadlineTs = deadlineStr ? parseDeadlineIST(deadlineStr) : null;
    if (newDeadlineTs !== task.deadline_ts) {
      changes.push(
        `Deadline: ${formatDateIST(task.deadline_ts)} → ${formatDateIST(newDeadlineTs)}`
      );
      fieldsToUpdate.deadline_ts = newDeadlineTs;
    }
  }

  if (priority !== undefined && ['Low', 'Normal', 'Urgent'].includes(priority)) {
    if (priority !== task.priority) {
      changes.push(`Priority: ${task.priority} → ${priority}`);
      fieldsToUpdate.priority = priority;
    }
  }

  if (description !== undefined && description !== task.description) {
    changes.push('Description updated');
    fieldsToUpdate.description = description ? description.trim() : null;
  }

  if (changes.length === 0) {
    return { updatedTask: task, changes: ['No changes made.'] };
  }

  const updatedTask = db.updateTaskDetails(taskId, fieldsToUpdate);
  return { updatedTask, changes };
}

/**
 * Adjust time (Manager only).
 * Signed integer minutes, max +/-720 each, reason required.
 */
function adjustTask(taskId, minutes, kind, reason, byUserId, hasManagerRole, nowTs = Math.floor(Date.now() / 1000)) {
  if (!hasManagerRole) {
    throw new Error('Only managers can adjust task time.');
  }

  const task = db.getTaskById(taskId);
  if (!task) throw new Error(`Task #${taskId} not found.`);

  const mins = parseInt(minutes, 10);
  if (isNaN(mins) || mins === 0) {
    throw new Error('Adjustment minutes must be a non-zero signed integer.');
  }

  const maxLimit = config.MAX_ADJUSTMENT_MINUTES || 720;
  if (mins < -maxLimit || mins > maxLimit) {
    throw new Error(`Adjustment minutes cannot exceed +/- ${maxLimit} minutes (${maxLimit / 60} hours).`);
  }

  if (!['work', 'break'].includes(kind)) {
    throw new Error("Adjustment kind must be 'work' or 'break'.");
  }

  if (!reason || !reason.trim()) {
    throw new Error('Reason is required for adjusting time.');
  }

  const adjustment = db.insertAdjustment({
    task_id: taskId,
    user_id: task.assignee_id,
    by_user_id: byUserId,
    kind,
    minutes: mins,
    reason: reason.trim(),
    ts: nowTs,
  });

  return { task, adjustment };
}

/**
 * Add progress note / update to a task.
 */
function addUpdateNote(taskId, userId, note, nowTs = Math.floor(Date.now() / 1000)) {
  const task = db.getTaskById(taskId);
  if (!task) throw new Error(`Task #${taskId} not found.`);
  if (task.assignee_id !== userId) {
    throw new Error(`Only the assignee (<@${task.assignee_id}>) can add update notes.`);
  }

  if (!note || !note.trim()) {
    throw new Error('Update note cannot be empty.');
  }

  const update = db.insertUpdateNote(taskId, userId, note.trim(), nowTs);
  return { task, update };
}

module.exports = {
  isManager,
  formatDuration,
  formatDateIST,
  parseDeadlineIST,
  getTaskTimeStats,
  buildTaskEmbed,
  buildTaskActionRows,
  autoPickTask,
  // Actions
  assignTask,
  startTask,
  breakTask,
  resumeTask,
  endDayTask,
  blockedTask,
  unblockTask,
  completeTask,
  cancelTask,
  reassignTask,
  editTask,
  adjustTask,
  addUpdateNote,
};

