/**
 * Zen Xea Discord Bot - Main Entry Point & Interaction Routing
 * Production-quality task & time tracker for internal server departments.
 * Discord.js v14 with default Guilds intent only.
 */

require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  Events,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  AttachmentBuilder,
  EmbedBuilder,
} = require('discord.js');

const config = require('./config');
const db = require('./db');
const {
  isManager,
  formatDuration,
  formatDateIST,
  buildTaskEmbed,
  buildTaskActionRows,
  autoPickTask,
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
} = require('./logic');

const {
  generateReportData,
  buildReportEmbeds,
  generateCsvExport,
} = require('./reports');

const scheduler = require('./scheduler');

// Create Discord Client with only the default Guilds intent
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

// Helper to safely reply/followUp to an interaction with error message
async function replyError(interaction, message) {
  try {
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content: `❌ ${message}`, ephemeral: true });
    } else {
      await interaction.reply({ content: `❌ ${message}`, ephemeral: true });
    }
  } catch (err) {
    console.error('[Bot] Failed to send error reply:', err.message);
  }
}

// Helper to update the original task card embed and buttons
async function updateTaskCardMessage(channel, messageId, task) {
  if (!channel || !messageId) return;
  try {
    const msg = await channel.messages.fetch(messageId).catch(() => null);
    if (msg) {
      const embed = buildTaskEmbed(task);
      const rows = buildTaskActionRows(task);
      await msg.edit({ embeds: [embed], components: rows });
    }
  } catch (err) {
    console.error(`[Bot] Could not update task card message ${messageId}:`, err.message);
  }
}

// ==========================================
// CLIENT READY EVENT
// ==========================================
client.once(Events.ClientReady, () => {
  console.log(`[Bot] Logged in as ${client.user.tag} (ID: ${client.user.id})`);
  console.log(`[Bot] Environment Timezone: ${config.TIMEZONE}`);
  console.log(`[Bot] Working Days: ${config.WORKING_DAYS.join(', ')}`);

  // Initialize DB and start scheduler
  db.initDb('taskbot.db');
  scheduler.startScheduler(client);
});

// ==========================================
// INTERACTION ROUTER
// ==========================================
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // 1. Slash Commands
    if (interaction.isChatInputCommand()) {
      await handleSlashCommand(interaction);
      return;
    }

    // 2. Button Interactions
    if (interaction.isButton()) {
      await handleButtonInteraction(interaction);
      return;
    }

    // 3. String Select Menu Interactions
    if (interaction.isStringSelectMenu()) {
      await handleSelectMenuInteraction(interaction);
      return;
    }

    // 4. Modal Submit Interactions
    if (interaction.isModalSubmit()) {
      await handleModalSubmitInteraction(interaction);
      return;
    }
  } catch (error) {
    console.error('[Bot] Uncaught error in interactionCreate:', error);
    await replyError(interaction, error.message || 'An unexpected error occurred.');
  }
});

// ==========================================
// 1. SLASH COMMAND HANDLER
// ==========================================
async function handleSlashCommand(interaction) {
  const { commandName } = interaction;
  const member = interaction.member;
  const user = interaction.user;
  const hasManagerRole = isManager(member);
  const nowTs = Math.floor(Date.now() / 1000);

  // --- /assign ---
  if (commandName === 'assign') {
    if (!hasManagerRole) {
      return replyError(interaction, 'Only managers can assign tasks.');
    }

    const targetUser = interaction.options.getUser('member', true);
    const title = interaction.options.getString('title', true);
    const estimateHours = interaction.options.getNumber('estimate_hours', true);
    const priority = interaction.options.getString('priority') || 'Normal';
    const description = interaction.options.getString('description');
    const deadline = interaction.options.getString('deadline');

    // Category name is Department (fallback General)
    const department = interaction.channel?.parent?.name || 'General';

    const task = assignTask({
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      department,
      title,
      description,
      priority,
      assigneeId: targetUser.id,
      assignedBy: user.id,
      estimateHours,
      deadlineStr: deadline,
      nowTs,
    });

    const embed = buildTaskEmbed(task, nowTs);
    const rows = buildTaskActionRows(task);

    // Post task card in channel
    const cardMsg = await interaction.channel.send({
      content: `📋 **New Task Assigned** to <@${targetUser.id}> by <@${user.id}>:`,
      embeds: [embed],
      components: rows,
    });

    db.updateTaskMessageId(task.id, cardMsg.id);

    return interaction.reply({
      content: `✅ Task #${task.id} successfully created and posted in this channel.`,
      ephemeral: true,
    });
  }

  // --- /start ---
  if (commandName === 'start') {
    const taskIdOpt = interaction.options.getInteger('task_id');
    const pick = autoPickTask(user.id, ['assigned', 'paused'], taskIdOpt);
    if (!pick.success) return replyError(interaction, pick.message);

    const task = pick.task;
    const updated = startTask(task.id, user.id, nowTs);

    await updateTaskCardMessage(interaction.channel, task.message_id, updated);
    await interaction.channel.send({
      content: `▶️ Task #${task.id} started by <@${user.id}> at ${formatDateIST(nowTs)}.`,
      allowedMentions: { parse: [] },
    });

    return interaction.reply({
      content: `✅ Started Task #${task.id} ("${task.title}"). Work timer running.`,
      ephemeral: true,
    });
  }

  // --- /break ---
  if (commandName === 'break') {
    const reasonOpt = interaction.options.getString('reason') || 'Tea / short break';
    const taskIdOpt = interaction.options.getInteger('task_id');
    const pick = autoPickTask(user.id, ['in_progress'], taskIdOpt);
    if (!pick.success) return replyError(interaction, pick.message);

    const task = pick.task;
    const updated = breakTask(task.id, user.id, reasonOpt, nowTs);

    await updateTaskCardMessage(interaction.channel, task.message_id, updated);
    await interaction.channel.send({
      content: `☕ Task #${task.id} placed on break (**${reasonOpt}**) by <@${user.id}> at ${formatDateIST(nowTs)}.`,
      allowedMentions: { parse: [] },
    });

    return interaction.reply({
      content: `✅ Break started (**${reasonOpt}**) on Task #${task.id}. Work paused.`,
      ephemeral: true,
    });
  }

  // --- /resume ---
  if (commandName === 'resume') {
    const taskIdOpt = interaction.options.getInteger('task_id');
    const pick = autoPickTask(user.id, ['on_break'], taskIdOpt);
    if (!pick.success) return replyError(interaction, pick.message);

    const task = pick.task;
    const { updatedTask, breakDurationMin, breakReason } = resumeTask(task.id, user.id, nowTs);

    await updateTaskCardMessage(interaction.channel, task.message_id, updatedTask);
    await interaction.channel.send({
      content: `▶️ Task #${task.id} resumed by <@${user.id}>. Break (**${breakReason}**) lasted **${breakDurationMin}m**.`,
      allowedMentions: { parse: [] },
    });

    return interaction.reply({
      content: `✅ Resumed Task #${task.id}. Work timer running.`,
      ephemeral: true,
    });
  }

  // --- /endday ---
  if (commandName === 'endday') {
    const taskIdOpt = interaction.options.getInteger('task_id');
    const pick = autoPickTask(user.id, ['in_progress', 'on_break'], taskIdOpt);
    if (!pick.success) return replyError(interaction, pick.message);

    const task = pick.task;

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`task_endday_completed:${task.id}`)
        .setLabel('Completed')
        .setEmoji('✅')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`task_endday_not_completed:${task.id}`)
        .setLabel('Not Completed')
        .setEmoji('⏳')
        .setStyle(ButtonStyle.Secondary)
    );

    return interaction.reply({
      content: `📋 **End Day Check for Task #${task.id} ("${task.title}")**:\nHave you completed this task before ending your day?`,
      components: [row],
      ephemeral: true,
    });
  }

  // --- /complete ---
  if (commandName === 'complete') {
    const taskIdOpt = interaction.options.getInteger('task_id');
    const pick = autoPickTask(user.id, ['in_progress', 'on_break', 'paused'], taskIdOpt);
    if (!pick.success) return replyError(interaction, pick.message);

    const task = pick.task;
    const summary = completeTask(task.id, user.id, nowTs);

    await updateTaskCardMessage(interaction.channel, task.message_id, summary.updatedTask);
    await interaction.channel.send({
      content:
        `✅ **Task #${task.id} Completed!**\n` +
        `• Title: **${task.title}**\n` +
        `• Completed by: <@${user.id}>\n` +
        `• Worked: **${formatDuration(summary.workedMin)}** vs ${formatDuration(summary.estimateMin)} estimate (${summary.estimateComparison})\n` +
        `• Breaks: **${formatDuration(summary.breakMin)}** across ${summary.breaksCount} break(s)\n` +
        `• Deadline: **${summary.deadlineStatus}**\n` +
        `• Assigner: <@${summary.assignedBy}>`,
      allowedMentions: { users: [summary.assignedBy] }, // Ping assigner here only
    });

    return interaction.reply({
      content: `🎉 Task #${task.id} successfully marked as completed!`,
      ephemeral: true,
    });
  }

  // --- /blocked ---
  if (commandName === 'blocked') {
    const reason = interaction.options.getString('reason', true);
    const taskIdOpt = interaction.options.getInteger('task_id');
    const pick = autoPickTask(user.id, ['in_progress', 'on_break', 'paused'], taskIdOpt);
    if (!pick.success) return replyError(interaction, pick.message);

    const task = pick.task;
    const updated = blockedTask(task.id, user.id, reason, nowTs);

    await updateTaskCardMessage(interaction.channel, task.message_id, updated);
    await interaction.channel.send({
      content:
        `🚫 **Task #${task.id} Marked as BLOCKED** by <@${user.id}>!\n` +
        `**Reason:** ${reason}\n` +
        `CC Assigner: <@${task.assigned_by}>`,
      allowedMentions: { users: [task.assigned_by] }, // Ping assigner here
    });

    return interaction.reply({
      content: `🚫 Task #${task.id} marked as blocked. Assigner notified.`,
      ephemeral: true,
    });
  }

  // --- /unblock ---
  if (commandName === 'unblock') {
    const taskIdOpt = interaction.options.getInteger('task_id');
    let task = null;

    if (taskIdOpt) {
      task = db.getTaskById(taskIdOpt);
      if (!task) return replyError(interaction, `Task #${taskIdOpt} not found.`);
      if (task.status !== 'blocked') {
        return replyError(interaction, `Task #${taskIdOpt} is not blocked (status: ${task.status}).`);
      }
    } else {
      const pick = autoPickTask(user.id, ['blocked']);
      if (!pick.success) return replyError(interaction, pick.message);
      task = pick.task;
    }

    const updated = unblockTask(task.id, user.id, hasManagerRole, nowTs);
    await updateTaskCardMessage(interaction.channel, task.message_id, updated);

    await interaction.channel.send({
      content: `🔓 Task #${task.id} has been UNBLOCKED by <@${user.id}>. Status is now **paused**; press **Start** to resume work.`,
      allowedMentions: { parse: [] },
    });

    return interaction.reply({
      content: `✅ Task #${task.id} unblocked and set to paused.`,
      ephemeral: true,
    });
  }

  // --- /update ---
  if (commandName === 'update') {
    const note = interaction.options.getString('note', true);
    const taskIdOpt = interaction.options.getInteger('task_id');
    const pick = autoPickTask(
      user.id,
      ['assigned', 'in_progress', 'on_break', 'paused', 'blocked'],
      taskIdOpt
    );
    if (!pick.success) return replyError(interaction, pick.message);

    const task = pick.task;
    addUpdateNote(task.id, user.id, note, nowTs);

    await interaction.channel.send({
      content: `📝 **Progress Update on Task #${task.id}** by <@${user.id}>:\n> ${note}`,
      allowedMentions: { parse: [] },
    });

    return interaction.reply({
      content: `✅ Note recorded for Task #${task.id}.`,
      ephemeral: true,
    });
  }

  // --- /tasks ---
  if (commandName === 'tasks') {
    const targetUser = interaction.options.getUser('member');
    if (targetUser && targetUser.id !== user.id && !hasManagerRole) {
      return replyError(interaction, 'Only managers can view tasks assigned to other members.');
    }

    const queryUserId = targetUser ? targetUser.id : user.id;
    const openTasks = db.getUserOpenTasks(queryUserId, interaction.guildId);

    const embed = new EmbedBuilder()
      .setColor(0x3498db)
      .setTitle(`📋 Open Tasks for ${targetUser ? targetUser.username : user.username}`)
      .setDescription(
        openTasks.length === 0
          ? '_No open tasks found._'
          : openTasks
              .map(
                (t) =>
                  `• [${config.PRIORITIES[t.priority]?.emoji || '•'} **#${t.id}**] **${t.title}** (${t.status}) — Est: ${formatDuration(t.estimate_min)}`
              )
              .join('\n')
      );

    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  // --- /reassign ---
  if (commandName === 'reassign') {
    if (!hasManagerRole) return replyError(interaction, 'Only managers can reassign tasks.');

    const taskId = interaction.options.getInteger('task_id', true);
    const newMember = interaction.options.getUser('member', true);

    const { updatedTask, oldAssigneeId } = reassignTask(
      taskId,
      newMember.id,
      user.id,
      hasManagerRole,
      nowTs
    );

    await updateTaskCardMessage(interaction.channel, updatedTask.message_id, updatedTask);

    await interaction.channel.send({
      content: `🔄 Task #${taskId} reassigned from <@${oldAssigneeId}> to <@${newMember.id}> by <@${user.id}>. Status: **${updatedTask.status}**.`,
      allowedMentions: { parse: [] },
    });

    // DM the new assignee
    await scheduler.sendDMOrChannelFallback(
      client,
      newMember.id,
      interaction.channelId,
      `📋 You have been reassigned Task #${taskId}: **${updatedTask.title}** by <@${user.id}>.`
    );

    return interaction.reply({
      content: `✅ Task #${taskId} reassigned to <@${newMember.id}>.`,
      ephemeral: true,
    });
  }

  // --- /edit ---
  if (commandName === 'edit') {
    if (!hasManagerRole) return replyError(interaction, 'Only managers can edit tasks.');

    const taskId = interaction.options.getInteger('task_id', true);
    const title = interaction.options.getString('title');
    const estimateHours = interaction.options.getNumber('estimate_hours');
    const deadline = interaction.options.getString('deadline');
    const priority = interaction.options.getString('priority');
    const description = interaction.options.getString('description');

    const { updatedTask, changes } = editTask(
      taskId,
      {
        title: title || undefined,
        estimateHours: estimateHours !== null ? estimateHours : undefined,
        deadlineStr: deadline !== null ? deadline : undefined,
        priority: priority || undefined,
        description: description !== null ? description : undefined,
      },
      user.id,
      hasManagerRole,
      nowTs
    );

    await updateTaskCardMessage(interaction.channel, updatedTask.message_id, updatedTask);

    await interaction.channel.send({
      content: `✏️ **Task #${taskId} Edited by <@${user.id}>**:\n${changes.map((c) => `• ${c}`).join('\n')}`,
      allowedMentions: { parse: [] },
    });

    return interaction.reply({
      content: `✅ Task #${taskId} updated.`,
      ephemeral: true,
    });
  }

  // --- /cancel ---
  if (commandName === 'cancel') {
    if (!hasManagerRole) return replyError(interaction, 'Only managers can cancel tasks.');

    const taskId = interaction.options.getInteger('task_id', true);
    const reason = interaction.options.getString('reason', true);

    const updated = cancelTask(taskId, user.id, reason, hasManagerRole, nowTs);
    await updateTaskCardMessage(interaction.channel, updated.message_id, updated);

    await interaction.channel.send({
      content: `❌ **Task #${taskId} Cancelled by <@${user.id}>**\n**Reason:** ${reason}`,
      allowedMentions: { parse: [] },
    });

    return interaction.reply({
      content: `✅ Task #${taskId} cancelled.`,
      ephemeral: true,
    });
  }

  // --- /adjust ---
  if (commandName === 'adjust') {
    if (!hasManagerRole) return replyError(interaction, 'Only managers can adjust task time.');

    const taskId = interaction.options.getInteger('task_id', true);
    const minutes = interaction.options.getInteger('minutes', true);
    const kind = interaction.options.getString('kind', true);
    const reason = interaction.options.getString('reason', true);

    const { task, adjustment } = adjustTask(
      taskId,
      minutes,
      kind,
      reason,
      user.id,
      hasManagerRole,
      nowTs
    );

    await updateTaskCardMessage(interaction.channel, task.message_id, task);

    await interaction.channel.send({
      content:
        `⏱️ **Time Adjustment on Task #${taskId}** by <@${user.id}>:\n` +
        `• **Kind:** ${kind}\n` +
        `• **Minutes:** ${minutes > 0 ? '+' : ''}${minutes} min\n` +
        `• **Reason:** ${reason}`,
      allowedMentions: { parse: [] },
    });

    return interaction.reply({
      content: `✅ Adjusted ${minutes}m (${kind}) for Task #${taskId}.`,
      ephemeral: true,
    });
  }

  // --- /recurring ---
  if (commandName === 'recurring') {
    const sub = interaction.options.getSubcommand();

    if (sub === 'add') {
      if (!hasManagerRole) return replyError(interaction, 'Only managers can configure recurring tasks.');

      const memberOpt = interaction.options.getUser('member', true);
      const title = interaction.options.getString('title', true);
      const estimateHours = interaction.options.getNumber('estimate_hours', true);
      const schedule = interaction.options.getString('schedule', true);
      const time = interaction.options.getString('time', true);
      const weekday = interaction.options.getInteger('weekday');
      const priority = interaction.options.getString('priority') || 'Normal';

      if (!/^\d{2}:\d{2}$/.test(time)) {
        return replyError(interaction, 'Time must be in HH:MM format (24-hour, e.g. 09:30).');
      }

      const rec = db.insertRecurring({
        guild_id: interaction.guildId,
        channel_id: interaction.channelId,
        assignee_id: memberOpt.id,
        created_by: user.id,
        title,
        estimate_min: Math.round(estimateHours * 60),
        priority,
        schedule,
        time,
        weekday: schedule === 'weekly' ? weekday || 1 : null,
      });

      return interaction.reply({
        content: `✅ Recurring task template #${rec.id} created for <@${memberOpt.id}> (${schedule} at ${time} IST).`,
        ephemeral: true,
      });
    }

    if (sub === 'list') {
      const list = db.getRecurringList(interaction.guildId);
      const embed = new EmbedBuilder()
        .setColor(0x3498db)
        .setTitle('🔄 Recurring Task Templates')
        .setDescription(
          list.length === 0
            ? '_No active recurring task templates._'
            : list
                .map(
                  (r) =>
                    `• **#${r.id}** "${r.title}" → <@${r.assignee_id}> (${r.schedule} at ${r.time} IST) in <#${r.channel_id}>`
                )
                .join('\n')
        );

      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (sub === 'remove') {
      if (!hasManagerRole) return replyError(interaction, 'Only managers can remove recurring tasks.');
      const id = interaction.options.getInteger('id', true);
      const success = db.deactivateRecurring(id, interaction.guildId);
      if (!success) return replyError(interaction, `Recurring task template #${id} not found.`);
      return interaction.reply({
        content: `✅ Recurring task template #${id} removed.`,
        ephemeral: true,
      });
    }
  }

  // --- /leave ---
  if (commandName === 'leave') {
    const sub = interaction.options.getSubcommand();

    if (sub === 'add') {
      const start = interaction.options.getString('start', true);
      const end = interaction.options.getString('end', true);
      const reason = interaction.options.getString('reason');
      const targetUser = interaction.options.getUser('member');

      if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
        return replyError(interaction, 'Dates must be in YYYY-MM-DD format.');
      }
      if (start > end) {
        return replyError(interaction, 'Start date must be before or equal to end date.');
      }

      if (targetUser && targetUser.id !== user.id && !hasManagerRole) {
        return replyError(interaction, 'Only managers can record leave for other members.');
      }

      const leaveUserId = targetUser ? targetUser.id : user.id;
      const leave = db.insertLeave({
        guild_id: interaction.guildId,
        user_id: leaveUserId,
        start_date: start,
        end_date: end,
        reason,
      });

      return interaction.reply({
        content: `✅ Leave #${leave.id} recorded for <@${leaveUserId}> from ${start} to ${end}.`,
        ephemeral: true,
      });
    }

    if (sub === 'cancel') {
      const id = interaction.options.getInteger('id', true);
      const success = db.cancelLeave(id, interaction.guildId, hasManagerRole ? null : user.id);
      if (!success) {
        return replyError(interaction, `Leave #${id} not found or you lack permission to cancel it.`);
      }
      return interaction.reply({ content: `✅ Leave #${id} cancelled.`, ephemeral: true });
    }

    if (sub === 'list') {
      const targetUser = interaction.options.getUser('member');
      const queryUserId = targetUser ? targetUser.id : user.id;
      const leaves = db.getUserLeaves(interaction.guildId, queryUserId);

      const embed = new EmbedBuilder()
        .setColor(0x3498db)
        .setTitle(`🏖️ Leaves for ${targetUser ? targetUser.username : user.username}`)
        .setDescription(
          leaves.length === 0
            ? '_No leave records found._'
            : leaves.map((l) => `• **#${l.id}**: ${l.start_date} to ${l.end_date} (${l.reason || 'No reason'})`).join('\n')
        );

      return interaction.reply({ embeds: [embed], ephemeral: true });
    }
  }

  // --- /holiday ---
  if (commandName === 'holiday') {
    const sub = interaction.options.getSubcommand();

    if (sub === 'add') {
      if (!hasManagerRole) return replyError(interaction, 'Only managers can add server holidays.');
      const date = interaction.options.getString('date', true);
      const name = interaction.options.getString('name', true);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return replyError(interaction, 'Holiday date must be YYYY-MM-DD.');
      }
      db.insertHoliday(interaction.guildId, date, name);
      return interaction.reply({ content: `✅ Holiday added: **${name}** on ${date}.`, ephemeral: true });
    }

    if (sub === 'remove') {
      if (!hasManagerRole) return replyError(interaction, 'Only managers can remove holidays.');
      const date = interaction.options.getString('date', true);
      const success = db.deleteHoliday(interaction.guildId, date);
      if (!success) return replyError(interaction, `No holiday found on date ${date}.`);
      return interaction.reply({ content: `✅ Holiday on ${date} removed.`, ephemeral: true });
    }

    if (sub === 'list') {
      const holidays = db.getHolidays(interaction.guildId);
      const embed = new EmbedBuilder()
        .setColor(0x3498db)
        .setTitle('🎉 Server Holidays')
        .setDescription(
          holidays.length === 0
            ? '_No holidays configured._'
            : holidays.map((h) => `• **${h.date}**: ${h.name}`).join('\n')
        );
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }
  }

  // --- /report ---
  if (commandName === 'report') {
    const period = interaction.options.getString('period', true);
    const memberOpt = interaction.options.getUser('member');
    const deptOpt = interaction.options.getString('department');

    if (!hasManagerRole && (memberOpt || deptOpt)) {
      return replyError(interaction, 'Staff members can only view their own personal performance reports.');
    }

    const filterUserId = hasManagerRole ? memberOpt?.id : user.id;
    const filterDept = hasManagerRole ? deptOpt : null;

    const reportData = generateReportData({
      period,
      guildId: interaction.guildId,
      userId: filterUserId,
      department: filterDept,
    });

    const embeds = buildReportEmbeds(reportData);
    return interaction.reply({ embeds, ephemeral: true });
  }

  // --- /export ---
  if (commandName === 'export') {
    const period = interaction.options.getString('period', true);
    const memberOpt = interaction.options.getUser('member');
    const deptOpt = interaction.options.getString('department');

    if (!hasManagerRole && (memberOpt || deptOpt)) {
      return replyError(interaction, 'Staff members can only export their own personal data.');
    }

    const filterUserId = hasManagerRole ? memberOpt?.id : user.id;
    const filterDept = hasManagerRole ? deptOpt : null;

    const { csvContent, reportData } = generateCsvExport({
      period,
      guildId: interaction.guildId,
      userId: filterUserId,
      department: filterDept,
    });

    const filename = `export-${period}-${reportData.startDt.toFormat('yyyyMMdd')}.csv`;
    const attachment = new AttachmentBuilder(Buffer.from(csvContent, 'utf-8'), {
      name: filename,
    });

    return interaction.reply({
      content: `📁 **CSV Data Export (${reportData.label})**`,
      files: [attachment],
      ephemeral: true,
    });
  }

  // --- /shift ---
  if (commandName === 'shift') {
    const sub = interaction.options.getSubcommand();

    if (sub === 'set') {
      if (!hasManagerRole) {
        return replyError(interaction, 'Only administrators and managers can assign work shifts.');
      }

      const targetMember = interaction.options.getUser('member', true);
      const start = interaction.options.getString('start', true).trim();
      const end = interaction.options.getString('end', true).trim();

      const timeRegex = /^([01]\d|2[0-3]):[0-5]\d$/;
      if (!timeRegex.test(start) || !timeRegex.test(end)) {
        return replyError(interaction, 'Shift times must be in valid 24-hour format HH:MM (e.g. 09:30 or 18:30).');
      }

      db.setShift({
        guild_id: interaction.guildId,
        user_id: targetMember.id,
        shift_start: start,
        shift_end: end,
        updated_by: user.id,
        updated_ts: nowTs,
      });

      const startFmt = config.formatTime12h(start);
      const endFmt = config.formatTime12h(end);

      return interaction.reply({
        content: `✅ Work shift configured for <@${targetMember.id}>: **${startFmt}** to **${endFmt} IST** (${start} - ${end}).`,
        ephemeral: true,
      });
    }

    if (sub === 'list') {
      const targetUser = interaction.options.getUser('member');

      if (targetUser) {
        const shift = db.getShift(interaction.guildId, targetUser.id);
        const shiftStr = shift
          ? `**${config.formatTime12h(shift.shift_start)}** to **${config.formatTime12h(shift.shift_end)} IST** (Custom)`
          : `**${config.formatTime12h(config.DEFAULT_SHIFT_START)}** to **${config.formatTime12h(config.DEFAULT_SHIFT_END)} IST** (Server Default)`;

        const embed = new EmbedBuilder()
          .setColor(0x3498db)
          .setTitle(`⏰ Work Shift: ${targetUser.username}`)
          .setDescription(`• Assigned Shift: ${shiftStr}`);

        return interaction.reply({ embeds: [embed], ephemeral: true });
      }

      // List all custom shifts
      const shifts = db.getAllShifts(interaction.guildId);
      const defaultStr = `Default Shift: **${config.formatTime12h(config.DEFAULT_SHIFT_START)}** to **${config.formatTime12h(config.DEFAULT_SHIFT_END)} IST**`;

      const listStr =
        shifts.length === 0
          ? '_No custom shifts assigned. All employees use the server default._'
          : shifts
              .map(
                (s) =>
                  `• <@${s.user_id}>: **${config.formatTime12h(s.shift_start)}** - **${config.formatTime12h(s.shift_end)} IST**`
              )
              .join('\n');

      const embed = new EmbedBuilder()
        .setColor(0x3498db)
        .setTitle('⏰ Employee Work Shifts')
        .setDescription(`${defaultStr}\n\n**Custom Assigned Shifts:**\n${listStr}`);

      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (sub === 'remove') {
      if (!hasManagerRole) {
        return replyError(interaction, 'Only administrators and managers can remove custom work shifts.');
      }

      const targetMember = interaction.options.getUser('member', true);
      const removed = db.deleteShift(interaction.guildId, targetMember.id);

      if (!removed) {
        return replyError(interaction, `<@${targetMember.id}> does not have a custom shift assigned (already on default).`);
      }

      return interaction.reply({
        content: `✅ Custom shift removed for <@${targetMember.id}>. Reverted to server default (${config.formatTime12h(config.DEFAULT_SHIFT_START)} - ${config.formatTime12h(config.DEFAULT_SHIFT_END)} IST).`,
        ephemeral: true,
      });
    }
  }
}

// ==========================================
// 2. BUTTON INTERACTION HANDLER
// ==========================================
async function handleButtonInteraction(interaction) {
  const { customId, message } = interaction;
  const user = interaction.user;
  const nowTs = Math.floor(Date.now() / 1000);

  // Handle End Day Ephemeral Prompt Buttons: Completed / Not Completed
  if (customId.startsWith('task_endday_completed:')) {
    const taskId = parseInt(customId.split(':')[1], 10);
    const task = db.getTaskById(taskId);
    if (!task) return replyError(interaction, `Task #${taskId} not found.`);
    if (task.assignee_id !== user.id) {
      return replyError(interaction, `Only the assignee (<@${task.assignee_id}>) can complete this task.`);
    }

    if (task.status === 'completed') {
      return interaction.update({
        content: `ℹ️ Task #${taskId} is already completed.`,
        components: [],
      });
    }

    const summary = completeTask(taskId, user.id, nowTs);
    await updateTaskCardMessage(interaction.channel, task.message_id, summary.updatedTask);
    await interaction.channel.send({
      content:
        `✅ **Task #${task.id} Completed!**\n` +
        `• Title: **${task.title}**\n` +
        `• Completed by: <@${user.id}>\n` +
        `• Worked: **${formatDuration(summary.workedMin)}** vs ${formatDuration(summary.estimateMin)} estimate (${summary.estimateComparison})\n` +
        `• Breaks: **${formatDuration(summary.breakMin)}** across ${summary.breaksCount} break(s)\n` +
        `• Deadline: **${summary.deadlineStatus}**\n` +
        `• Assigner: <@${summary.assignedBy}>`,
      allowedMentions: { users: [summary.assignedBy] },
    });

    return interaction.update({
      content: `🎉 **Task #${task.id} marked as completed!** Day ended and summary posted. Great job today!`,
      components: [],
    });
  }

  if (customId.startsWith('task_endday_not_completed:')) {
    const taskId = parseInt(customId.split(':')[1], 10);
    const task = db.getTaskById(taskId);
    if (!task) return replyError(interaction, `Task #${taskId} not found.`);
    if (task.assignee_id !== user.id) {
      return replyError(interaction, `Only the assignee (<@${task.assignee_id}>) can end day on this task.`);
    }

    const modal = new ModalBuilder()
      .setCustomId(`task_endday_modal:${task.id}`)
      .setTitle(`End Day - Update Status (#${task.id})`);

    const noteInput = new TextInputBuilder()
      .setCustomId('status_update')
      .setLabel('Status / progress update before closing:')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setPlaceholder('What was accomplished today? Next steps? Any blockers?');

    modal.addComponents(new ActionRowBuilder().addComponents(noteInput));
    return interaction.showModal(modal);
  }

  // Look up task via interaction.message.id for standard card buttons
  const task = db.getTaskByMessageId(message.id);
  if (!task) {
    return replyError(interaction, 'No task associated with this message card.');
  }

  // Permission check: Only the assignee can use task buttons!
  if (task.assignee_id !== user.id) {
    return replyError(
      interaction,
      `Only the assigned team member (<@${task.assignee_id}>) can use these task buttons.`
    );
  }

  // Button: Start
  if (customId === 'task_start') {
    const updated = startTask(task.id, user.id, nowTs);
    await updateTaskCardMessage(interaction.channel, message.id, updated);
    await interaction.channel.send({
      content: `▶️ Task #${task.id} started by <@${user.id}> at ${formatDateIST(nowTs)}.`,
      allowedMentions: { parse: [] },
    });
    return interaction.deferUpdate();
  }

  // Button: Break
  if (customId === 'task_break') {
    // Show ephemeral select menu with break options
    const select = new StringSelectMenuBuilder()
      .setCustomId(`task_break_select:${task.id}`)
      .setPlaceholder('Select break type...')
      .addOptions(
        config.BREAK_TYPES.map((b) => ({
          label: `${b} (${config.BREAK_LIMITS_MIN[b] || 30}m limit)`,
          value: b,
        }))
      );

    const row = new ActionRowBuilder().addComponents(select);
    return interaction.reply({
      content: '☕ **Select your break type:**',
      components: [row],
      ephemeral: true,
    });
  }

  // Button: Resume
  if (customId === 'task_resume') {
    const { updatedTask, breakDurationMin, breakReason } = resumeTask(task.id, user.id, nowTs);
    await updateTaskCardMessage(interaction.channel, message.id, updatedTask);
    await interaction.channel.send({
      content: `▶️ Task #${task.id} resumed by <@${user.id}>. Break (**${breakReason}**) lasted **${breakDurationMin}m**.`,
      allowedMentions: { parse: [] },
    });
    return interaction.deferUpdate();
  }

  // Button: End Day (Ask status before closing: Completed or Not Completed)
  if (customId === 'task_endday') {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`task_endday_completed:${task.id}`)
        .setLabel('Completed')
        .setEmoji('✅')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`task_endday_not_completed:${task.id}`)
        .setLabel('Not Completed')
        .setEmoji('⏳')
        .setStyle(ButtonStyle.Secondary)
    );

    return interaction.reply({
      content: `📋 **End Day Check for Task #${task.id} ("${task.title}")**:\nHave you completed this task before ending your day?`,
      components: [row],
      ephemeral: true,
    });
  }

  // Button: Complete
  if (customId === 'task_complete') {
    const summary = completeTask(task.id, user.id, nowTs);
    await updateTaskCardMessage(interaction.channel, message.id, summary.updatedTask);
    await interaction.channel.send({
      content:
        `✅ **Task #${task.id} Completed!**\n` +
        `• Title: **${task.title}**\n` +
        `• Completed by: <@${user.id}>\n` +
        `• Worked: **${formatDuration(summary.workedMin)}** vs ${formatDuration(summary.estimateMin)} estimate (${summary.estimateComparison})\n` +
        `• Breaks: **${formatDuration(summary.breakMin)}** across ${summary.breaksCount} break(s)\n` +
        `• Deadline: **${summary.deadlineStatus}**\n` +
        `• Assigner: <@${summary.assignedBy}>`,
      allowedMentions: { users: [summary.assignedBy] }, // Ping assigner here
    });
    return interaction.deferUpdate();
  }

  // Button: Blocked (opens modal)
  if (customId === 'task_blocked') {
    const modal = new ModalBuilder()
      .setCustomId(`task_blocked_modal:${task.id}`)
      .setTitle(`Block Task #${task.id}`);

    const reasonInput = new TextInputBuilder()
      .setCustomId('reason')
      .setLabel('Reason why this task is blocked:')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setPlaceholder('Describe what is blocking this task...');

    modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
    return interaction.showModal(modal);
  }

  // Button: Update (opens modal for note)
  if (customId === 'task_update') {
    const modal = new ModalBuilder()
      .setCustomId(`task_update_modal:${task.id}`)
      .setTitle(`Update Task #${task.id}`);

    const noteInput = new TextInputBuilder()
      .setCustomId('note')
      .setLabel('Progress update note:')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setPlaceholder('Describe your progress or current status...');

    modal.addComponents(new ActionRowBuilder().addComponents(noteInput));
    return interaction.showModal(modal);
  }
}

// ==========================================
// 3. SELECT MENU INTERACTION HANDLER
// ==========================================
async function handleSelectMenuInteraction(interaction) {
  const { customId, values, user } = interaction;
  const nowTs = Math.floor(Date.now() / 1000);

  if (customId.startsWith('task_break_select:')) {
    const taskId = parseInt(customId.split(':')[1], 10);
    const reason = values[0];

    const updated = breakTask(taskId, user.id, reason, nowTs);
    await updateTaskCardMessage(interaction.channel, updated.message_id, updated);

    await interaction.channel.send({
      content: `☕ Task #${taskId} placed on break (**${reason}**) by <@${user.id}> at ${formatDateIST(nowTs)}.`,
      allowedMentions: { parse: [] },
    });

    return interaction.update({
      content: `✅ Break (**${reason}**) started. Work session paused.`,
      components: [],
    });
  }
}

// ==========================================
// 4. MODAL SUBMIT INTERACTION HANDLER
// ==========================================
async function handleModalSubmitInteraction(interaction) {
  const { customId, user } = interaction;
  const nowTs = Math.floor(Date.now() / 1000);

  // Blocked modal submit
  if (customId.startsWith('task_blocked_modal:')) {
    const taskId = parseInt(customId.split(':')[1], 10);
    const reason = interaction.fields.getTextInputValue('reason');

    const updated = blockedTask(taskId, user.id, reason, nowTs);
    await updateTaskCardMessage(interaction.channel, updated.message_id, updated);

    await interaction.channel.send({
      content:
        `🚫 **Task #${taskId} Marked as BLOCKED** by <@${user.id}>!\n` +
        `**Reason:** ${reason}\n` +
        `CC Assigner: <@${updated.assigned_by}>`,
      allowedMentions: { users: [updated.assigned_by] },
    });

    return interaction.reply({
      content: `🚫 Task #${taskId} marked as blocked. Assigner notified.`,
      ephemeral: true,
    });
  }

  // Update note modal submit
  if (customId.startsWith('task_update_modal:')) {
    const taskId = parseInt(customId.split(':')[1], 10);
    const note = interaction.fields.getTextInputValue('note');

    addUpdateNote(taskId, user.id, note, nowTs);

    await interaction.channel.send({
      content: `📝 **Progress Update on Task #${taskId}** by <@${user.id}>:\n> ${note}`,
      allowedMentions: { parse: [] },
    });

    return interaction.reply({
      content: `✅ Note recorded for Task #${taskId}.`,
      ephemeral: true,
    });
  }

  // End Day status update modal submit
  if (customId.startsWith('task_endday_modal:')) {
    const taskId = parseInt(customId.split(':')[1], 10);
    const note = interaction.fields.getTextInputValue('status_update');
    const task = db.getTaskById(taskId);
    if (!task) return replyError(interaction, `Task #${taskId} not found.`);

    const { updatedTask, workedMin, estimateMin } = endDayTask(taskId, user.id, nowTs, false, note);
    await updateTaskCardMessage(interaction.channel, task.message_id, updatedTask);

    await interaction.channel.send({
      content:
        `⏸️ Day ended for Task #${taskId} by <@${user.id}> at ${formatDateIST(nowTs)}. Worked so far: **${formatDuration(workedMin)}** / ${formatDuration(estimateMin)}.\n` +
        `📝 **Status Update:** ${note}`,
      allowedMentions: { parse: [] },
    });

    return interaction.reply({
      content: `✅ Status updated and day ended. Task #${taskId} is paused. Continue tomorrow with \`/start\`.`,
      ephemeral: true,
    });
  }
}

// Start bot if run directly
if (require.main === module) {
  if (!config.DISCORD_TOKEN) {
    console.error('Missing DISCORD_TOKEN in .env. Bot cannot start.');
  } else {
    client.login(config.DISCORD_TOKEN).catch((err) => {
      console.error('Failed to login to Discord:', err.message);
    });
  }
}

module.exports = { client, handleSlashCommand, handleButtonInteraction };

