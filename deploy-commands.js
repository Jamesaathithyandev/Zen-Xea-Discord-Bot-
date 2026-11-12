/**
 * Zen Xea Discord Bot - Slash Command Registration
 * Registers guild or global slash commands via Discord REST API.
 */

require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');
const config = require('./config');

const commands = [
  // 1. /assign
  new SlashCommandBuilder()
    .setName('assign')
    .setDescription('Assign a new task to a team member (Managers only)')
    .setDMPermission(false)
    .addUserOption((opt) =>
      opt.setName('member').setDescription('Team member to assign the task to').setRequired(true)
    )
    .addStringOption((opt) =>
      opt.setName('title').setDescription('Task title').setRequired(true)
    )
    .addNumberOption((opt) =>
      opt.setName('estimate_hours').setDescription('Estimated duration in hours (e.g. 2.5)').setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName('priority')
        .setDescription('Task priority')
        .setRequired(false)
        .addChoices(
          ...Object.keys(config.PRIORITIES).map((p) => ({
            name: `${p} ${config.PRIORITIES[p].emoji}`,
            value: p,
          }))
        )
    )
    .addStringOption((opt) =>
      opt.setName('description').setDescription('Detailed description').setRequired(false)
    )
    .addStringOption((opt) =>
      opt.setName('deadline').setDescription('Deadline in IST (format: YYYY-MM-DD HH:mm)').setRequired(false)
    ),

  // 2. /start
  new SlashCommandBuilder()
    .setName('start')
    .setDescription('Start working on a task')
    .setDMPermission(false)
    .addIntegerOption((opt) =>
      opt.setName('task_id').setDescription('Task ID (optional if you have only 1 active task)').setRequired(false)
    ),

  // 3. /break
  new SlashCommandBuilder()
    .setName('break')
    .setDescription('Pause work to take a break')
    .setDMPermission(false)
    .addStringOption((opt) =>
      opt
        .setName('reason')
        .setDescription('Break type/reason')
        .setRequired(false)
        .addChoices(
          ...config.BREAK_TYPES.map((b) => ({
            name: `${b} (${config.getBreakLimit(b)}m limit)`,
            value: b,
          }))
        )
    )
    .addIntegerOption((opt) =>
      opt.setName('task_id').setDescription('Task ID (optional if single active task)').setRequired(false)
    ),

  // 4. /resume
  new SlashCommandBuilder()
    .setName('resume')
    .setDescription('Resume work from a break')
    .setDMPermission(false)
    .addIntegerOption((opt) =>
      opt.setName('task_id').setDescription('Task ID (optional if single active task)').setRequired(false)
    ),

  // 5. /endday
  new SlashCommandBuilder()
    .setName('endday')
    .setDescription('End your day and pause open tasks')
    .setDMPermission(false)
    .addIntegerOption((opt) =>
      opt.setName('task_id').setDescription('Task ID (optional if single active task)').setRequired(false)
    ),

  // 6. /complete
  new SlashCommandBuilder()
    .setName('complete')
    .setDescription('Mark a task as completed')
    .setDMPermission(false)
    .addIntegerOption((opt) =>
      opt.setName('task_id').setDescription('Task ID (optional if single active task)').setRequired(false)
    ),

  // 7. /blocked
  new SlashCommandBuilder()
    .setName('blocked')
    .setDescription('Mark a task as blocked and notify assigner')
    .setDMPermission(false)
    .addStringOption((opt) =>
      opt.setName('reason').setDescription('Reason why the task is blocked').setRequired(true)
    )
    .addIntegerOption((opt) =>
      opt.setName('task_id').setDescription('Task ID (optional if single active task)').setRequired(false)
    ),

  // 8. /unblock
  new SlashCommandBuilder()
    .setName('unblock')
    .setDescription('Unblock a blocked task (Assignee or Manager)')
    .setDMPermission(false)
    .addIntegerOption((opt) =>
      opt.setName('task_id').setDescription('Task ID (optional if single blocked task)').setRequired(false)
    ),

  // 9. /update
  new SlashCommandBuilder()
    .setName('update')
    .setDescription('Add a progress update note to a task')
    .setDMPermission(false)
    .addStringOption((opt) =>
      opt.setName('note').setDescription('Progress update note').setRequired(true)
    )
    .addIntegerOption((opt) =>
      opt.setName('task_id').setDescription('Task ID (optional if single active task)').setRequired(false)
    ),

  // 10. /tasks
  new SlashCommandBuilder()
    .setName('tasks')
    .setDescription('List open tasks (Urgent first)')
    .setDMPermission(false)
    .addUserOption((opt) =>
      opt.setName('member').setDescription('View tasks of another member (Managers only)').setRequired(false)
    ),

  // 11. /reassign
  new SlashCommandBuilder()
    .setName('reassign')
    .setDescription('Reassign a task to another member (Managers only)')
    .setDMPermission(false)
    .addIntegerOption((opt) =>
      opt.setName('task_id').setDescription('Task ID').setRequired(true)
    )
    .addUserOption((opt) =>
      opt.setName('member').setDescription('New assignee').setRequired(true)
    ),

  // 12. /edit
  new SlashCommandBuilder()
    .setName('edit')
    .setDescription('Edit task details (Managers only)')
    .setDMPermission(false)
    .addIntegerOption((opt) =>
      opt.setName('task_id').setDescription('Task ID').setRequired(true)
    )
    .addStringOption((opt) =>
      opt.setName('title').setDescription('New title').setRequired(false)
    )
    .addNumberOption((opt) =>
      opt.setName('estimate_hours').setDescription('New estimate in hours').setRequired(false)
    )
    .addStringOption((opt) =>
      opt.setName('deadline').setDescription('New deadline in IST (YYYY-MM-DD HH:mm)').setRequired(false)
    )
    .addStringOption((opt) =>
      opt
        .setName('priority')
        .setDescription('New priority')
        .setRequired(false)
        .addChoices(
          ...Object.keys(config.PRIORITIES).map((p) => ({
            name: `${p} ${config.PRIORITIES[p].emoji}`,
            value: p,
          }))
        )
    )
    .addStringOption((opt) =>
      opt.setName('description').setDescription('New description').setRequired(false)
    ),

  // 13. /cancel
  new SlashCommandBuilder()
    .setName('cancel')
    .setDescription('Cancel an active task (Managers only)')
    .setDMPermission(false)
    .addIntegerOption((opt) =>
      opt.setName('task_id').setDescription('Task ID').setRequired(true)
    )
    .addStringOption((opt) =>
      opt.setName('reason').setDescription('Reason for cancellation').setRequired(true)
    ),

  // 14. /adjust
  new SlashCommandBuilder()
    .setName('adjust')
    .setDescription('Adjust worked or break time for a task (Managers only)')
    .setDMPermission(false)
    .addIntegerOption((opt) =>
      opt.setName('task_id').setDescription('Task ID').setRequired(true)
    )
    .addIntegerOption((opt) =>
      opt.setName('minutes').setDescription(`Signed minutes to adjust (e.g. +30 or -15, max +/-${config.MAX_ADJUSTMENT_MINUTES})`).setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName('kind')
        .setDescription('Kind of time to adjust')
        .setRequired(true)
        .addChoices({ name: 'Work', value: 'work' }, { name: 'Break', value: 'break' })
    )
    .addStringOption((opt) =>
      opt.setName('reason').setDescription('Reason for adjustment').setRequired(true)
    ),

  // 15. /recurring
  new SlashCommandBuilder()
    .setName('recurring')
    .setDescription('Manage recurring scheduled tasks (Managers only)')
    .setDMPermission(false)
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('Add a recurring task schedule')
        .addUserOption((opt) =>
          opt.setName('member').setDescription('Assignee').setRequired(true)
        )
        .addStringOption((opt) =>
          opt.setName('title').setDescription('Task title').setRequired(true)
        )
        .addNumberOption((opt) =>
          opt.setName('estimate_hours').setDescription('Estimated hours').setRequired(true)
        )
        .addStringOption((opt) =>
          opt
            .setName('schedule')
            .setDescription('Recurrence frequency')
            .setRequired(true)
            .addChoices(
              { name: `Daily (${config.WORKING_DAYS_LABEL || 'Mon-Sat'})`, value: 'daily' },
              { name: 'Weekdays (Mon-Fri)', value: 'weekdays' },
              { name: 'Weekly (Specific day)', value: 'weekly' }
            )
        )
        .addStringOption((opt) =>
          opt.setName('time').setDescription('Time in IST (HH:MM, e.g. 09:30)').setRequired(true)
        )
        .addIntegerOption((opt) =>
          opt
            .setName('weekday')
            .setDescription('Weekday for weekly schedule')
            .setRequired(false)
            .addChoices(
              { name: 'Monday', value: 1 },
              { name: 'Tuesday', value: 2 },
              { name: 'Wednesday', value: 3 },
              { name: 'Thursday', value: 4 },
              { name: 'Friday', value: 5 },
              { name: 'Saturday', value: 6 }
            )
        )
        .addStringOption((opt) =>
          opt
            .setName('priority')
            .setDescription('Priority')
            .setRequired(false)
            .addChoices(
              { name: 'Low 🟢', value: 'Low' },
              { name: 'Normal 🟡', value: 'Normal' },
              { name: 'Urgent 🔴', value: 'Urgent' }
            )
        )
    )
    .addSubcommand((sub) =>
      sub.setName('list').setDescription('List recurring task templates')
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('Remove a recurring task template')
        .addIntegerOption((opt) =>
          opt.setName('id').setDescription('Recurring template ID').setRequired(true)
        )
    ),

  // 16. /leave
  new SlashCommandBuilder()
    .setName('leave')
    .setDescription('Manage leave requests and records')
    .setDMPermission(false)
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('Record leave days')
        .addStringOption((opt) =>
          opt.setName('start').setDescription('Start date (YYYY-MM-DD)').setRequired(true)
        )
        .addStringOption((opt) =>
          opt.setName('end').setDescription('End date (YYYY-MM-DD)').setRequired(true)
        )
        .addStringOption((opt) =>
          opt.setName('reason').setDescription('Reason for leave').setRequired(false)
        )
        .addUserOption((opt) =>
          opt.setName('member').setDescription('Member on leave (Managers only for other members)').setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('cancel')
        .setDescription('Cancel a recorded leave')
        .addIntegerOption((opt) =>
          opt.setName('id').setDescription('Leave ID to cancel').setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('list')
        .setDescription('List leaves')
        .addUserOption((opt) =>
          opt.setName('member').setDescription('Filter by member').setRequired(false)
        )
    ),

  // 17. /holiday
  new SlashCommandBuilder()
    .setName('holiday')
    .setDescription('Manage official server holidays (Managers only)')
    .setDMPermission(false)
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('Add an official holiday')
        .addStringOption((opt) =>
          opt.setName('date').setDescription('Holiday date (YYYY-MM-DD)').setRequired(true)
        )
        .addStringOption((opt) =>
          opt.setName('name').setDescription('Name of holiday').setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('Remove an official holiday')
        .addStringOption((opt) =>
          opt.setName('date').setDescription('Holiday date (YYYY-MM-DD)').setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub.setName('list').setDescription('List configured server holidays')
    ),

  // 18. /report
  new SlashCommandBuilder()
    .setName('report')
    .setDescription('View performance reports (Managers can see all; staff see own data)')
    .setDMPermission(false)
    .addStringOption((opt) =>
      opt
        .setName('period')
        .setDescription('Reporting period')
        .setRequired(true)
        .addChoices(
          { name: 'Daily', value: 'daily' },
          { name: 'Weekly', value: 'weekly' },
          { name: 'Monthly', value: 'monthly' }
        )
    )
    .addUserOption((opt) =>
      opt.setName('member').setDescription('Filter by member (Managers only)').setRequired(false)
    )
    .addStringOption((opt) =>
      opt.setName('department').setDescription('Filter by department (Managers only)').setRequired(false)
    ),

  // 19. /export
  new SlashCommandBuilder()
    .setName('export')
    .setDescription('Export task and session data to CSV')
    .setDMPermission(false)
    .addStringOption((opt) =>
      opt
        .setName('period')
        .setDescription('Export period')
        .setRequired(true)
        .addChoices(
          { name: 'Daily', value: 'daily' },
          { name: 'Weekly', value: 'weekly' },
          { name: 'Monthly', value: 'monthly' }
        )
    )
    .addUserOption((opt) =>
      opt.setName('member').setDescription('Filter by member (Managers only)').setRequired(false)
    )
    .addStringOption((opt) =>
      opt.setName('department').setDescription('Filter by department (Managers only)').setRequired(false)
    ),

  // 20. /shift
  new SlashCommandBuilder()
    .setName('shift')
    .setDescription('Manage employee work shifts and alert timings (Admins/Managers only)')
    .setDMPermission(false)
    .addSubcommand((sub) =>
      sub
        .setName('set')
        .setDescription('Set work shift start and end times for an employee')
        .addUserOption((opt) =>
          opt.setName('member').setDescription('Team member').setRequired(true)
        )
        .addStringOption((opt) =>
          opt.setName('start').setDescription('Shift start time in IST (HH:MM, e.g. 09:30)').setRequired(true)
        )
        .addStringOption((opt) =>
          opt.setName('end').setDescription('Shift end time in IST (HH:MM, e.g. 18:30)').setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('list')
        .setDescription('View employee work shifts')
        .addUserOption((opt) =>
          opt.setName('member').setDescription('Filter by member').setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('Reset employee shift to default timing')
        .addUserOption((opt) =>
          opt.setName('member').setDescription('Team member to reset').setRequired(true)
        )
    ),
];

async function deployCommands() {
  const token = config.DISCORD_TOKEN;
  const clientId = config.CLIENT_ID;
  const guildId = config.GUILD_ID;

  if (!token || !clientId) {
    console.error('Missing DISCORD_TOKEN or CLIENT_ID in environment variables.');
    return;
  }

  const rest = new REST({ version: '10' }).setToken(token);

  try {
    console.log(`Started refreshing ${commands.length} application (/) commands.`);

    if (guildId) {
      // Guild-specific registration (fastest propagation for dev/internal server)
      await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
        body: commands.map((c) => c.toJSON()),
      });
      console.log(`Successfully reloaded slash commands for Guild ID: ${guildId}.`);
    } else {
      // Global registration
      await rest.put(Routes.applicationCommands(clientId), {
        body: commands.map((c) => c.toJSON()),
      });
      console.log('Successfully reloaded global slash commands.');
    }
  } catch (error) {
    console.error('Error deploying commands:', error);
  }
}

if (require.main === module) {
  deployCommands();
}

module.exports = { commands, deployCommands };

