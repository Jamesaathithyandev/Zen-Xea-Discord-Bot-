/**
 * Zen Xea Discord Bot - Acceptance Test Suite
 * Tests logic.js, reports.js, scheduler.js, and db.js with an in-memory database.
 * Verifies all 10 acceptance tests specified in the requirements.
 */

const assert = require('assert');
const { DateTime } = require('luxon');
const config = require('./config');
const db = require('./db');
const {
  isManager,
  formatDuration,
  getTaskTimeStats,
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
} = require('./logic');

const {
  generateReportData,
  buildReportEmbeds,
  generateCsvExport,
} = require('./reports');

const scheduler = require('./scheduler');

// Setup mock Discord Client
function createMockClient() {
  const sentMessages = [];
  const sentDMs = [];

  return {
    sentMessages,
    sentDMs,
    users: {
      fetch: async (id) => ({
        id,
        send: async (msg) => {
          sentDMs.push({ userId: id, msg });
          return msg;
        },
      }),
    },
    channels: {
      fetch: async (id) => ({
        id,
        isTextBased: () => true,
        parent: { name: 'Technology' },
        send: async (msg) => {
          sentMessages.push({ channelId: id, msg });
          return { id: 'msg_' + Date.now(), edit: async () => {} };
        },
        messages: {
          fetch: async (mid) => ({
            id: mid,
            edit: async (data) => data,
          }),
        },
      }),
    },
    guilds: {
      fetch: async (id) => ({
        id,
        channels: {
          fetch: async () => [
            {
              id: 'chan_tech',
              name: 'tech-reports',
              isTextBased: () => true,
              parent: { name: 'Technology' },
              send: async (msg) => {
                sentMessages.push({ channelId: 'chan_tech', msg });
              },
            },
          ],
        },
      }),
    },
  };
}

async function runTests() {
  console.log('====================================================');
  console.log('🚀 RUNNING ACCEPTANCE TEST SUITE (ZEN XEA DISCORD BOT)');
  console.log('====================================================\n');

  // Initialize fresh in-memory database
  db.initDb(':memory:');

  const nowIST = DateTime.now().setZone(config.TIMEZONE);
  const baseTs = Math.floor(nowIST.toSeconds());

  // ----------------------------------------------------
  // TEST 1: assign -> start -> break(Lunch) -> resume -> endday -> start -> complete
  // ----------------------------------------------------
  console.log('Test 1: Full lifecycle work and break calculation...');
  {
    const task = assignTask({
      guildId: 'guild1',
      channelId: 'chan1',
      department: 'Technology',
      title: 'Implement OAuth2 Flow',
      description: 'Setup Google and GitHub OAuth',
      priority: 'Normal',
      assigneeId: 'user1',
      assignedBy: 'mgr1',
      estimateHours: 2, // 120 minutes
      nowTs: baseTs,
    });
    assert.strictEqual(task.status, 'assigned');
    assert.strictEqual(task.estimate_min, 120);

    // 1. Start task at baseTs
    const started = startTask(task.id, 'user1', baseTs);
    assert.strictEqual(started.status, 'in_progress');

    // 2. Work for 30 min, then take Lunch break
    const tBreak = baseTs + 30 * 60;
    const onBreak = breakTask(task.id, 'user1', 'Lunch break', tBreak);
    assert.strictEqual(onBreak.status, 'on_break');

    // 3. Break for 45 min, then resume
    const tResume = tBreak + 45 * 60;
    const { updatedTask: resumed, breakDurationMin } = resumeTask(
      task.id,
      'user1',
      tResume
    );
    assert.strictEqual(resumed.status, 'in_progress');
    assert.strictEqual(breakDurationMin, 45);

    // 4. Work for 60 min, then End Day with status update note
    const tEndDay = tResume + 60 * 60;
    const { updatedTask: paused, workedMin: workedSoFar, note } = endDayTask(
      task.id,
      'user1',
      tEndDay,
      false,
      'Completed initial setup and OAuth tests'
    );
    assert.strictEqual(paused.status, 'paused');
    assert.strictEqual(workedSoFar, 90); // 30 + 60 = 90 min
    assert.strictEqual(note, 'Completed initial setup and OAuth tests');
    const latestNote = db.getLatestUpdateForTask(task.id);
    assert.ok(latestNote);
    assert.strictEqual(latestNote.note, 'Completed initial setup and OAuth tests');

    // 5. Next day: start task again (12 hours later)
    const tNextDay = tEndDay + 12 * 3600;
    const restarted = startTask(task.id, 'user1', tNextDay);
    assert.strictEqual(restarted.status, 'in_progress');

    // 6. Work for 20 min, then Complete
    const tComplete = tNextDay + 20 * 60;
    const summary = completeTask(task.id, 'user1', tComplete);

    assert.strictEqual(summary.updatedTask.status, 'completed');
    assert.strictEqual(summary.workedMin, 110, 'Expected worked time 110 min (30 + 60 + 20)');
    assert.strictEqual(summary.breakMin, 45, 'Expected break time 45 min');
    assert.strictEqual(summary.estimateMin, 120);
    assert.strictEqual(summary.estimateComparison, '10m under estimate');

    const stats = getTaskTimeStats(task.id, tComplete);
    assert.strictEqual(stats.workedMin, 110);
    assert.strictEqual(stats.breakMin, 45);

    console.log('  ✅ Test 1 PASSED: Work (110m) and Break (45m) totals accurate.\n');
  }

  // ----------------------------------------------------
  // TEST 2: Starting a second task while one is active is refused
  // ----------------------------------------------------
  console.log('Test 2: Starting a second active task is refused...');
  {
    const taskA = assignTask({
      guildId: 'guild1',
      channelId: 'chan1',
      department: 'Technology',
      title: 'Task A',
      estimateHours: 1,
      assigneeId: 'user_multi',
      assignedBy: 'mgr1',
      nowTs: baseTs,
    });

    const taskB = assignTask({
      guildId: 'guild1',
      channelId: 'chan1',
      department: 'Technology',
      title: 'Task B',
      estimateHours: 1,
      assigneeId: 'user_multi',
      assignedBy: 'mgr1',
      nowTs: baseTs,
    });

    // Start Task A
    startTask(taskA.id, 'user_multi', baseTs);

    // Attempt to start Task B while Task A is in_progress
    assert.throws(
      () => {
        startTask(taskB.id, 'user_multi', baseTs + 60);
      },
      /already have Task #.*in_progress/,
      'Should refuse starting Task B while Task A is in_progress'
    );

    // Put Task A on break
    breakTask(taskA.id, 'user_multi', 'Tea / short break', baseTs + 120);

    // Attempt to start Task B while Task A is on_break
    assert.throws(
      () => {
        startTask(taskB.id, 'user_multi', baseTs + 180);
      },
      /already have Task #.*on_break/,
      'Should refuse starting Task B while Task A is on_break'
    );

    // Pause Task A (end day)
    endDayTask(taskA.id, 'user_multi', baseTs + 240);

    // Now Task B can start successfully
    const startedB = startTask(taskB.id, 'user_multi', baseTs + 300);
    assert.strictEqual(startedB.status, 'in_progress');
    endDayTask(taskB.id, 'user_multi', baseTs + 360);

    console.log('  ✅ Test 2 PASSED: Second active task start strictly refused.\n');
  }

  // ----------------------------------------------------
  // TEST 3: Permission checks (non-assignee & non-manager)
  // ----------------------------------------------------
  console.log('Test 3: Non-assignee button actions & non-manager commands refused...');
  {
    const taskP = assignTask({
      guildId: 'guild1',
      channelId: 'chan1',
      department: 'HR',
      title: 'Onboarding Checklist',
      estimateHours: 2,
      assigneeId: 'user_perm',
      assignedBy: 'mgr1',
      nowTs: baseTs,
    });

    // Non-assignee tries to start task
    assert.throws(
      () => {
        startTask(taskP.id, 'intruder_user', baseTs);
      },
      /Only the assignee.*can start this task/,
      'Non-assignee cannot start'
    );

    startTask(taskP.id, 'user_perm', baseTs);

    // Non-assignee tries to take a break
    assert.throws(
      () => {
        breakTask(taskP.id, 'intruder_user', 'Lunch break', baseTs + 60);
      },
      /Only the assignee.*can take a break/,
      'Non-assignee cannot break'
    );

    // Non-assignee tries to complete task
    assert.throws(
      () => {
        completeTask(taskP.id, 'intruder_user', baseTs + 120);
      },
      /Only the assignee.*can complete this task/,
      'Non-assignee cannot complete'
    );

    // Manager role verification
    const staffMember = { id: 'staff1', roles: ['Junior Developer'], permissions: [] };
    const managerMember = { id: 'mgr1', roles: ['Tech Lead'] };
    const adminMember = { id: 'admin1', permissions: ['Administrator'] };

    assert.strictEqual(isManager(staffMember), false);
    assert.strictEqual(isManager(managerMember), true);
    assert.strictEqual(isManager(adminMember), true);

    // Non-manager running manager commands
    assert.throws(
      () => {
        adjustTask(taskP.id, 30, 'work', 'Testing adjust', 'staff1', false, baseTs);
      },
      /Only managers can adjust task time/,
      'Staff cannot adjust'
    );

    assert.throws(
      () => {
        editTask(taskP.id, { title: 'Hacked' }, 'staff1', false, baseTs);
      },
      /Only managers can edit a task/,
      'Staff cannot edit'
    );

    assert.throws(
      () => {
        cancelTask(taskP.id, 'staff1', 'Unauthorized cancel', false, baseTs);
      },
      /Only managers can cancel a task/,
      'Staff cannot cancel'
    );

    assert.throws(
      () => {
        reassignTask(taskP.id, 'staff2', 'staff1', false, baseTs);
      },
      /Only managers can reassign a task/,
      'Staff cannot reassign'
    );

    endDayTask(taskP.id, 'user_perm', baseTs + 180);
    console.log('  ✅ Test 3 PASSED: Assignee and manager permission checks enforced.\n');
  }

  // ----------------------------------------------------
  // TEST 4: Blocked time is excluded from totals; unblock works
  // ----------------------------------------------------
  console.log('Test 4: Blocked time excluded from work/break totals; unblock works...');
  {
    const taskBlk = assignTask({
      guildId: 'guild1',
      channelId: 'chan1',
      department: 'Sales',
      title: 'Client Pitch Deck',
      estimateHours: 1,
      assigneeId: 'user_sales',
      assignedBy: 'mgr1',
      nowTs: baseTs,
    });

    // Start and work for 20 minutes
    startTask(taskBlk.id, 'user_sales', baseTs);
    const tBlock = baseTs + 20 * 60;

    // Block the task
    const blocked = blockedTask(
      taskBlk.id,
      'user_sales',
      'Awaiting pricing tier confirmation from client',
      tBlock
    );
    assert.strictEqual(blocked.status, 'blocked');
    assert.strictEqual(
      blocked.blocked_reason,
      'Awaiting pricing tier confirmation from client'
    );

    // 2 hours pass while blocked
    const tUnblock = tBlock + 120 * 60;
    const statsWhileBlocked = getTaskTimeStats(taskBlk.id, tUnblock);
    assert.strictEqual(
      statsWhileBlocked.workedMin,
      20,
      'Blocked time must not increase worked time'
    );
    assert.strictEqual(
      statsWhileBlocked.breakMin,
      0,
      'Blocked time must not count as break time'
    );

    // Unblock task (status becomes paused)
    const unblocked = unblockTask(taskBlk.id, 'user_sales', false, tUnblock);
    assert.strictEqual(unblocked.status, 'paused');
    assert.strictEqual(unblocked.blocked_reason, null);

    // Resume working with startTask
    startTask(taskBlk.id, 'user_sales', tUnblock);

    // Work another 30 minutes and complete
    const tDone = tUnblock + 30 * 60;
    const summary = completeTask(taskBlk.id, 'user_sales', tDone);

    assert.strictEqual(summary.workedMin, 50, 'Worked time should be 20m + 30m = 50m');
    assert.strictEqual(summary.breakMin, 0);

    console.log('  ✅ Test 4 PASSED: Blocked time (120m) excluded; totals reflect exact 50m.\n');
  }

  // ----------------------------------------------------
  // TEST 5: /adjust changes totals and report; max +/-720 limit
  // ----------------------------------------------------
  console.log('Test 5: Time adjustments (+/-720 max) and report visibility...');
  {
    const taskAdj = assignTask({
      guildId: 'guild1',
      channelId: 'chan1',
      department: 'SEO',
      title: 'Keyword Research',
      estimateHours: 2,
      assigneeId: 'user_seo',
      assignedBy: 'mgr1',
      nowTs: baseTs,
    });

    startTask(taskAdj.id, 'user_seo', baseTs);
    endDayTask(taskAdj.id, 'user_seo', baseTs + 60 * 60); // 60 min worked

    // Verify rejection over +/- 720 minutes
    assert.throws(
      () => {
        adjustTask(taskAdj.id, 721, 'work', 'Too big', 'mgr1', true, baseTs + 3700);
      },
      /cannot exceed \+\/- 720 minutes/,
      'Should reject > 720'
    );

    assert.throws(
      () => {
        adjustTask(taskAdj.id, -721, 'work', 'Too small', 'mgr1', true, baseTs + 3700);
      },
      /cannot exceed \+\/- 720 minutes/,
      'Should reject < -720'
    );

    assert.throws(
      () => {
        adjustTask(taskAdj.id, 0, 'work', 'Zero minutes', 'mgr1', true, baseTs + 3700);
      },
      /non-zero signed integer/,
      'Should reject 0'
    );

    // Valid adjustment: +45m work
    adjustTask(
      taskAdj.id,
      45,
      'work',
      'Worked offline during broadband outage',
      'mgr1',
      true,
      baseTs + 3700
    );

    // Valid adjustment: -10m break
    adjustTask(
      taskAdj.id,
      -10,
      'break',
      'Correcting accidental break logging',
      'mgr1',
      true,
      baseTs + 3700
    );

    const stats = getTaskTimeStats(taskAdj.id, baseTs + 3800);
    assert.strictEqual(stats.workedMin, 105, '60m + 45m adj = 105m');
    assert.strictEqual(stats.workAdjMin, 45);
    assert.strictEqual(stats.breakAdjMin, -10);

    // Verify report reflects the adjustment
    const report = generateReportData({
      period: 'daily',
      guildId: 'guild1',
      userId: 'user_seo',
      options: { refDt: nowIST },
    });

    const userEntry = report.users.find((u) => u.userId === 'user_seo');
    assert.ok(userEntry);
    assert.strictEqual(userEntry.totalWorkedMin, 105);

    console.log('  ✅ Test 5 PASSED: Adjustments properly bounded and included in reports.\n');
  }

  // ----------------------------------------------------
  // TEST 6: Reassign keeps earlier sessions credited to original user
  // ----------------------------------------------------
  console.log('Test 6: Reassign preserves session attribution to original user...');
  {
    const taskRe = assignTask({
      guildId: 'guild1',
      channelId: 'chan1',
      department: 'Digital Marketing',
      title: 'Ad Campaign Setup',
      estimateHours: 2,
      assigneeId: 'user_orig',
      assignedBy: 'mgr1',
      nowTs: baseTs,
    });

    // Original user works 40 minutes
    startTask(taskRe.id, 'user_orig', baseTs);
    endDayTask(taskRe.id, 'user_orig', baseTs + 40 * 60);

    // Manager reassigns to user_new
    const { updatedTask: reassigned } = reassignTask(
      taskRe.id,
      'user_new',
      'mgr1',
      true,
      baseTs + 50 * 60
    );
    assert.strictEqual(reassigned.assignee_id, 'user_new');
    assert.strictEqual(reassigned.status, 'paused', 'Work existed, so status should be paused');

    // New assignee starts and works 30 minutes, then completes
    startTask(taskRe.id, 'user_new', baseTs + 60 * 60);
    completeTask(taskRe.id, 'user_new', baseTs + 90 * 60);

    // Generate daily report for guild
    const report = generateReportData({
      period: 'daily',
      guildId: 'guild1',
      options: { refDt: nowIST },
    });

    const origUserReport = report.users.find((u) => u.userId === 'user_orig');
    const newUserReport = report.users.find((u) => u.userId === 'user_new');

    assert.ok(origUserReport, 'Original user must be present in report');
    assert.ok(newUserReport, 'New user must be present in report');
    assert.strictEqual(origUserReport.totalWorkedMin, 40, 'Original user retains 40m');
    assert.strictEqual(newUserReport.totalWorkedMin, 30, 'New user credited 30m');

    console.log('  ✅ Test 6 PASSED: Reassignment maintained past session attribution.\n');
  }

  // ----------------------------------------------------
  // TEST 7: Cancelled tasks excluded from on-time statistics
  // ----------------------------------------------------
  console.log('Test 7: Cancelled tasks excluded from on-time stats but time counts...');
  {
    // Task 1: Completed on time
    const tGood = assignTask({
      guildId: 'guild_stats',
      channelId: 'chan_stats',
      department: 'Technology',
      title: 'Quick Bug Fix',
      estimateHours: 1, // 60 min
      assigneeId: 'user_stat',
      assignedBy: 'mgr1',
      nowTs: baseTs,
    });
    startTask(tGood.id, 'user_stat', baseTs);
    // Work 40m and complete
    completeTask(tGood.id, 'user_stat', baseTs + 40 * 60);

    // Task 2: Worked 90m (over estimate) and then cancelled
    const tCancel = assignTask({
      guildId: 'guild_stats',
      channelId: 'chan_stats',
      department: 'Technology',
      title: 'Deprecated Feature Exploration',
      estimateHours: 1, // 60 min
      assigneeId: 'user_stat',
      assignedBy: 'mgr1',
      nowTs: baseTs + 3600,
    });
    startTask(tCancel.id, 'user_stat', baseTs + 3600);
    // Cancel task after 90m
    const cancelled = cancelTask(
      tCancel.id,
      'mgr1',
      'Stakeholder cancelled feature',
      true,
      baseTs + 3600 + 90 * 60
    );
    assert.strictEqual(cancelled.status, 'cancelled');

    const report = generateReportData({
      period: 'daily',
      guildId: 'guild_stats',
      options: { refDt: nowIST },
    });

    assert.strictEqual(report.teamTotals.completed, 1, 'Only completed task counts in completions');
    assert.strictEqual(report.teamTotals.onTime, 1, 'Completed task was on time');
    assert.strictEqual(report.teamTotals.overEstimate, 0, 'Cancelled task excluded from over-estimate stats');
    assert.strictEqual(report.teamTotals.workedMin, 130, 'Cancelled task time (90m) STILL counts in totals (40+90=130)');

    console.log('  ✅ Test 7 PASSED: Cancelled tasks excluded from on-time stats, time included.\n');
  }

  // ----------------------------------------------------
  // TEST 8: Break and deadline reminders fire once only
  // ----------------------------------------------------
  console.log('Test 8: Break and deadline reminders fire once only across scheduler runs...');
  {
    const mockClient = createMockClient();

    // 1. Break reminder
    const taskBreakRem = assignTask({
      guildId: 'guild_rem',
      channelId: 'chan_rem',
      department: 'Technology',
      title: 'Break Reminder Test Task',
      estimateHours: 2,
      assigneeId: 'user_rem1',
      assignedBy: 'mgr1',
      nowTs: baseTs,
    });
    startTask(taskBreakRem.id, 'user_rem1', baseTs);
    // Take Lunch break (limit 75m)
    breakTask(taskBreakRem.id, 'user_rem1', 'Lunch break', baseTs + 10);

    // Scheduler runs at baseTs + 80 minutes (break is 80m > 75m limit)
    const dtAt80 = DateTime.fromSeconds(baseTs + 80 * 60, { zone: config.TIMEZONE });

    await scheduler.runBreakReminders(mockClient, dtAt80);
    assert.strictEqual(mockClient.sentDMs.length, 1, 'Should send break reminder once');
    assert.ok(mockClient.sentDMs[0].msg.content.includes('Break Limit Exceeded'));

    // Second scheduler run at baseTs + 81 minutes
    const dtAt81 = DateTime.fromSeconds(baseTs + 81 * 60, { zone: config.TIMEZONE });
    await scheduler.runBreakReminders(mockClient, dtAt81);
    assert.strictEqual(mockClient.sentDMs.length, 1, 'Must NOT send duplicate break reminder');

    // 2. Deadline reminder
    const deadlineTs = baseTs + 24 * 3600; // 24 hours from base
    const taskDeadRem = assignTask({
      guildId: 'guild_rem',
      channelId: 'chan_rem',
      department: 'Technology',
      title: 'Deadline Test Task',
      estimateHours: 4,
      assigneeId: 'user_rem2',
      assignedBy: 'mgr1',
      deadlineStr: DateTime.fromSeconds(deadlineTs, { zone: config.TIMEZONE }).toFormat('yyyy-MM-dd HH:mm'),
      nowTs: baseTs,
    });

    mockClient.sentDMs.length = 0; // reset counter

    // Run scheduler at remaining 23 hours (matches 24h window)
    const dtAt23h = DateTime.fromSeconds(deadlineTs - 23 * 3600, { zone: config.TIMEZONE });
    await scheduler.runDeadlineReminders(mockClient, dtAt23h);
    assert.strictEqual(mockClient.sentDMs.length, 1, '24h deadline reminder sent');
    assert.ok(mockClient.sentDMs[0].msg.content.includes('hours'));

    // Second run at 22 hours
    const dtAt22h = DateTime.fromSeconds(deadlineTs - 22 * 3600, { zone: config.TIMEZONE });
    await scheduler.runDeadlineReminders(mockClient, dtAt22h);
    assert.strictEqual(mockClient.sentDMs.length, 1, '24h reminder must NOT re-fire');

    // Run scheduler at remaining 1.5 hours (matches 2h window)
    const dtAt1h = DateTime.fromSeconds(deadlineTs - 90 * 60, { zone: config.TIMEZONE });
    await scheduler.runDeadlineReminders(mockClient, dtAt1h);
    assert.strictEqual(mockClient.sentDMs.length, 2, '2h deadline reminder sent');

    // Run again in 2h window
    await scheduler.runDeadlineReminders(mockClient, dtAt1h);
    assert.strictEqual(mockClient.sentDMs.length, 2, '2h reminder must NOT re-fire');

    // Overdue run (10 min after deadline)
    const dtOverdue = DateTime.fromSeconds(deadlineTs + 10 * 60, { zone: config.TIMEZONE });
    await scheduler.runDeadlineReminders(mockClient, dtOverdue);
    assert.strictEqual(mockClient.sentDMs.length, 3, 'Overdue reminder sent');

    // Run overdue check again
    await scheduler.runDeadlineReminders(mockClient, dtOverdue);
    assert.strictEqual(mockClient.sentDMs.length, 3, 'Overdue reminder must NOT re-fire');

    console.log('  ✅ Test 8 PASSED: Break and deadline reminders fired exactly once.\n');
  }

  // ----------------------------------------------------
  // TEST 9: Auto end-of-day & leave/holiday skipping
  // ----------------------------------------------------
  console.log('Test 9: Auto end-of-day ends tasks; leave/holiday skips reminders & recurring...');
  {
    const mockClient = createMockClient();
    const todayStr = nowIST.toFormat('yyyy-MM-dd');

    // 1. Task for auto end-of-day
    const taskAutoEod = assignTask({
      guildId: 'guild_auto',
      channelId: 'chan_auto',
      department: 'Technology',
      title: 'Late Night Coding',
      estimateHours: 3,
      assigneeId: 'user_night',
      assignedBy: 'mgr1',
      nowTs: baseTs,
    });
    startTask(taskAutoEod.id, 'user_night', baseTs);

    // Simulate 20:30 IST on a working day
    const dtAutoEod = nowIST.set({ hour: 20, minute: 30, second: 0 });
    await scheduler.runAutoEndOfDay(mockClient, dtAutoEod);

    const afterEod = db.getTaskById(taskAutoEod.id);
    assert.strictEqual(afterEod.status, 'paused', 'Auto EOD must set task status to paused');

    // Check message sent to channel
    const autoLog = mockClient.sentMessages.find((m) =>
      m.msg.content.includes('auto-ended at 8:30 PM')
    );
    assert.ok(autoLog, 'Channel must log auto-ended at 8:30 PM message');

    // 2. User on leave skips EOD reminders
    const taskLeave = assignTask({
      guildId: 'guild_auto',
      channelId: 'chan_auto',
      department: 'Technology',
      title: 'Task for user on leave',
      estimateHours: 2,
      assigneeId: 'user_on_leave',
      assignedBy: 'mgr1',
      nowTs: baseTs,
    });
    startTask(taskLeave.id, 'user_on_leave', baseTs);

    // Record leave for user_on_leave today
    db.insertLeave({
      guild_id: 'guild_auto',
      user_id: 'user_on_leave',
      start_date: todayStr,
      end_date: todayStr,
      reason: 'Sick leave',
    });

    mockClient.sentDMs.length = 0;
    const dtEodReminder = nowIST.set({ hour: 19, minute: 30, second: 0 });
    await scheduler.runEndOfDayReminder(mockClient, dtEodReminder);

    const dmToLeaveUser = mockClient.sentDMs.find((m) => m.userId === 'user_on_leave');
    assert.strictEqual(dmToLeaveUser, undefined, 'User on leave must NOT receive EOD reminder');

    // 3. Recurring task skipped on holiday
    db.insertHoliday('guild_auto', todayStr, 'Company Foundation Day');
    db.insertRecurring({
      guild_id: 'guild_auto',
      channel_id: 'chan_auto',
      assignee_id: 'user_rec_hol',
      created_by: 'mgr1',
      title: 'Daily Standup Prep',
      estimate_min: 30,
      priority: 'Normal',
      schedule: 'daily',
      time: '09:00',
    });

    const dtStandup = nowIST.set({ hour: 9, minute: 1, second: 0 });
    await scheduler.runRecurringTasks(mockClient, dtStandup);

    const recTasks = db
      .getDb()
      .prepare("SELECT * FROM tasks WHERE title = 'Daily Standup Prep'")
      .all();
    assert.strictEqual(recTasks.length, 0, 'Recurring task must NOT trigger on holiday');

    console.log('  ✅ Test 9 PASSED: Auto EOD paused tasks; leave & holiday skipped reminders/recurring.\n');
  }

  // ----------------------------------------------------
  // TEST 10: Weekly/monthly period clipping & CSV export
  // ----------------------------------------------------
  console.log('Test 10: Weekly/monthly period clipping and CSV export schema...');
  {
    // Task created 10 days ago (outside weekly, inside monthly)
    const tenDaysAgoDt = nowIST.minus({ days: 10 });
    const tenDaysAgoTs = Math.floor(tenDaysAgoDt.toSeconds());

    const taskMonthlyOnly = assignTask({
      guildId: 'guild_report',
      channelId: 'chan_report',
      department: 'Technology',
      title: 'Past Week Task',
      estimateHours: 2,
      assigneeId: 'user_rep',
      assignedBy: 'mgr1',
      nowTs: tenDaysAgoTs,
    });
    startTask(taskMonthlyOnly.id, 'user_rep', tenDaysAgoTs);
    endDayTask(taskMonthlyOnly.id, 'user_rep', tenDaysAgoTs + 60 * 60); // 60 min worked

    // Task created today (inside weekly and monthly)
    const taskCurrent = assignTask({
      guildId: 'guild_report',
      channelId: 'chan_report',
      department: 'Technology',
      title: 'Current Week Task',
      estimateHours: 1,
      assigneeId: 'user_rep',
      assignedBy: 'mgr1',
      nowTs: baseTs,
    });
    startTask(taskCurrent.id, 'user_rep', baseTs);
    endDayTask(taskCurrent.id, 'user_rep', baseTs + 45 * 60); // 45 min worked

    // Weekly report (current week)
    const weeklyData = generateReportData({
      period: 'weekly',
      guildId: 'guild_report',
      options: { refDt: nowIST },
    });

    const weeklyUser = weeklyData.users.find((u) => u.userId === 'user_rep');
    assert.ok(weeklyUser, 'User must be present in weekly report');
    assert.strictEqual(
      weeklyUser.totalWorkedMin,
      45,
      'Weekly report must only include data from current week (45m)'
    );

    // Monthly report (current month)
    const monthlyData = generateReportData({
      period: 'monthly',
      guildId: 'guild_report',
      options: { refDt: nowIST },
    });

    const monthlyUser = monthlyData.users.find((u) => u.userId === 'user_rep');
    assert.ok(monthlyUser, 'User must be present in monthly report');
    // If today and 10 days ago are both in current month, both sessions are included:
    if (tenDaysAgoDt.month === nowIST.month) {
      assert.strictEqual(
        monthlyUser.totalWorkedMin,
        105,
        'Monthly report includes both sessions (45m + 60m = 105m)'
      );
    }

    // Embed building verification
    const embeds = buildReportEmbeds(weeklyData);
    assert.ok(Array.isArray(embeds));
    assert.ok(embeds.length >= 1);
    assert.ok(embeds[0].data.title.includes('Performance Report'));

    // CSV export verification
    const { csvContent } = generateCsvExport({
      period: 'weekly',
      guildId: 'guild_report',
      options: { refDt: nowIST },
    });

    const expectedHeaders =
      'date,department,user,task_id,title,priority,status,estimate_min,worked_min,break_min,adjustments_min,variance_min,deadline,completed_at';

    const lines = csvContent.split('\n');
    assert.strictEqual(lines[0], expectedHeaders, 'CSV headers must match exact requirement');
    assert.ok(lines.length >= 2, 'CSV must contain data rows');

    console.log('  ✅ Test 10 PASSED: Weekly/monthly clipping accurate; CSV export headers verified.\n');
  }

  // ----------------------------------------------------
  // TEST 11: Employee Work Shift Assignment & Login/Logout Alerts
  // ----------------------------------------------------
  console.log('Test 11: Employee work shift assignment and login/logout reminders...');
  {
    const mockClient = createMockClient();
    const shiftGuildId = 'guild_shift_test';
    const workerWithTask = 'worker_with_task';
    const workerNoTask = 'worker_no_task';
    const todayStr = nowIST.toFormat('yyyy-MM-dd');

    // 1. Assign shift to workerWithTask: 09:30 to 18:30 IST
    db.setShift({
      guild_id: shiftGuildId,
      user_id: workerWithTask,
      shift_start: '09:30',
      shift_end: '18:30',
      updated_by: 'admin_user',
      updated_ts: baseTs,
    });

    const storedShift = db.getShift(shiftGuildId, workerWithTask);
    assert.ok(storedShift);
    assert.strictEqual(storedShift.shift_start, '09:30');
    assert.strictEqual(storedShift.shift_end, '18:30');

    // Also assign shift to workerNoTask: 09:30 to 18:30 IST
    db.setShift({
      guild_id: shiftGuildId,
      user_id: workerNoTask,
      shift_start: '09:30',
      shift_end: '18:30',
      updated_by: 'admin_user',
      updated_ts: baseTs,
    });

    // Assign active task to workerWithTask
    assignTask({
      guildId: shiftGuildId,
      channelId: 'chan_shift',
      department: 'Technology',
      title: 'Database Index Optimization',
      estimateHours: 4,
      assigneeId: workerWithTask,
      assignedBy: 'admin_user',
      nowTs: baseTs,
    });
    // workerNoTask has NO tasks assigned to them

    // 2. Check Login Alert at 09:45 IST on a working day
    // Worker has NOT started working yet (task is still 'assigned')
    mockClient.sentDMs.length = 0;
    mockClient.sentMessages.length = 0;
    const dtShiftMorning = nowIST.set({ hour: 9, minute: 45, second: 0 });

    await scheduler.runShiftReminders(mockClient, dtShiftMorning);

    // workerWithTask MUST receive login alert
    const loginAlert = mockClient.sentDMs.find((d) => d.userId === workerWithTask);
    assert.ok(loginAlert, 'workerWithTask must receive shift login reminder');
    assert.ok(loginAlert.msg.content.includes('Shift Started at 9:30 AM IST'));
    assert.ok(loginAlert.msg.content.includes('Database Index Optimization'));

    // workerNoTask must NOT receive login alert (no active task under their name)
    const noTaskAlert = mockClient.sentDMs.find((d) => d.userId === workerNoTask);
    assert.strictEqual(noTaskAlert, undefined, 'workerNoTask must NOT receive alert because they have no active tasks');

    // Run again at 09:50 IST -> Should NOT send duplicate alert
    await scheduler.runShiftReminders(mockClient, nowIST.set({ hour: 9, minute: 50, second: 0 }));
    const countAfterSecondRun = mockClient.sentDMs.filter((d) => d.userId === workerWithTask).length;
    assert.strictEqual(countAfterSecondRun, 1, 'Login alert must only fire once per day');

    // 3. Worker starts task at 10:00 IST
    const openTasks = db.getUserOpenTasks(workerWithTask, shiftGuildId);
    startTask(openTasks[0].id, workerWithTask, Math.floor(nowIST.set({ hour: 10, minute: 0 }).toSeconds()));

    // 4. Check Logout Alert at 18:35 IST
    // Shift ended at 18:30, but task is still in_progress
    mockClient.sentDMs.length = 0;
    const dtShiftEvening = nowIST.set({ hour: 18, minute: 35, second: 0 });

    await scheduler.runShiftReminders(mockClient, dtShiftEvening);

    const logoutAlert = mockClient.sentDMs.find((d) => d.userId === workerWithTask);
    assert.ok(logoutAlert, 'workerWithTask must receive shift logout alert when task is still active after shift end');
    assert.ok(logoutAlert.msg.content.includes('Shift Ended at 6:30 PM IST'));
    assert.ok(logoutAlert.msg.content.includes('Database Index Optimization'));

    // Run again -> Should NOT duplicate
    await scheduler.runShiftReminders(mockClient, nowIST.set({ hour: 18, minute: 40, second: 0 }));
    const countLogoutAfterSecondRun = mockClient.sentDMs.filter((d) => d.userId === workerWithTask).length;
    assert.strictEqual(countLogoutAfterSecondRun, 1, 'Logout alert must only fire once per day');

    // 5. Clean up task
    endDayTask(openTasks[0].id, workerWithTask, Math.floor(nowIST.set({ hour: 18, minute: 45 }).toSeconds()));

    console.log('  ✅ Test 11 PASSED: Work shift assignment, login/logout alerts, and task-gating verified.\n');
  }

  console.log('====================================================');
  console.log('🎉 ALL 11 ACCEPTANCE TESTS PASSED SUCCESSFULLY!');
  console.log('====================================================');
}

if (require.main === module) {
  runTests().catch((err) => {
    console.error('❌ Test failed with error:', err);
    process.exit(1);
  });
}

module.exports = { runTests };
