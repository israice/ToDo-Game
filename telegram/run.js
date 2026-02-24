const { Telegraf, Markup } = require('telegraf');
const config = require('./config');
const api = require('./browser');

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// In-memory session storage
const sessions = new Map();

bot.use((ctx, next) => {
  const userId = ctx.from?.id;
  if (userId) {
    ctx.session = sessions.get(userId) || { action: null, step: null, authenticated: false };
    return next().then(() => {
      if (ctx.session) sessions.set(userId, ctx.session);
    });
  }
  return next();
});

// Auth keyboard (Login | Registration)
const authKeyboard = Markup.inlineKeyboard([
  [
    Markup.button.callback(config.telegram.buttons.login, config.telegram.actions.LOGIN),
    Markup.button.callback(config.telegram.buttons.register, config.telegram.actions.REGISTER)
  ]
]);

// Main keyboard with task actions
const mainKeyboard = Markup.inlineKeyboard([
  [
    Markup.button.callback(config.telegram.buttons.add_task, config.telegram.actions.ADD_TASK),
    Markup.button.callback(config.telegram.buttons.delete_task, config.telegram.actions.DELETE_TASK)
  ],
  [
    Markup.button.callback(config.telegram.buttons.rename_task, config.telegram.actions.RENAME_TASK),
    Markup.button.callback(config.telegram.buttons.complete_task, config.telegram.actions.COMPLETE_TASK)
  ],
  [
    Markup.button.callback(config.telegram.buttons.show_tasks, config.telegram.actions.SHOW_TASKS)
  ]
]);

// Back to auth keyboard
const backToAuthKeyboard = Markup.inlineKeyboard([
  [Markup.button.callback(config.telegram.messages.auth.back_to_auth, 'back_to_auth')]
]);

bot.start(async (ctx) => {
  const userId = ctx.from?.id;
  if (userId) {
    await api.closeUserSession(userId);
  }
  ctx.session = { action: null, step: null, authenticated: false };
  ctx.reply(config.telegram.messages.auth.start, authKeyboard);
});

bot.command('stop', async (ctx) => {
  const userId = ctx.from?.id;
  if (userId) {
    await api.closeUserSession(userId);
  }
  ctx.reply('✅ Сервер остановлен пользователем');
});

// === AUTH FLOW ===

bot.action(config.telegram.actions.LOGIN, (ctx) => {
  ctx.reply(config.telegram.messages.auth.login_prompt);
  ctx.session = { action: config.telegram.actions.LOGIN, step: 'enter_username', authenticated: false };
});

bot.action(config.telegram.actions.REGISTER, (ctx) => {
  ctx.reply(config.telegram.messages.auth.register_username_prompt);
  ctx.session = { action: config.telegram.actions.REGISTER, step: 'enter_username', authenticated: false };
});

bot.action('back_to_auth', (ctx) => {
  ctx.session = { action: null, step: null, authenticated: false };
  ctx.editMessageText(config.telegram.messages.auth.start, authKeyboard);
});

// === TASK FLOW (only for authenticated users) ===

function checkAuth(ctx) {
  if (!ctx.session?.authenticated) {
    ctx.reply(config.telegram.messages.no_action, authKeyboard);
    return false;
  }
  return true;
}

bot.action(config.telegram.actions.ADD_TASK, (ctx) => {
  if (!checkAuth(ctx)) return;
  ctx.reply(config.telegram.messages.prompts.add_task);
  ctx.session = { ...ctx.session, action: config.telegram.actions.ADD_TASK };
});

async function loadAndShowTasks(ctx, action) {
  if (!checkAuth(ctx)) return;
  const userId = ctx.from?.id;
  ctx.reply(config.telegram.messages.loading_tasks);
  try {
    const tasks = await api.getTasks(userId);
    if (tasks.length === 0) {
      ctx.reply(config.telegram.messages.no_tasks, mainKeyboard);
      ctx.session = { ...ctx.session, action: null };
      return;
    }
    const taskList = tasks.map((task, i) => `${i + 1}. ${task}`).join('\n');
    await ctx.reply(config.telegram.messages.task_list.replace('%s', taskList));

    if (action === null) {
      ctx.session = { ...ctx.session, action: null };
      return;
    }

    ctx.session = { ...ctx.session, action, step: 'select_task', tasks };
  } catch (error) {
    ctx.reply(config.telegram.messages.error.replace('%s', error.message), mainKeyboard);
    ctx.session = { ...ctx.session, action: null };
  }
}

bot.action(config.telegram.actions.DELETE_TASK, (ctx) => loadAndShowTasks(ctx, config.telegram.actions.DELETE_TASK));
bot.action(config.telegram.actions.RENAME_TASK, (ctx) => loadAndShowTasks(ctx, config.telegram.actions.RENAME_TASK));
bot.action(config.telegram.actions.COMPLETE_TASK, (ctx) => loadAndShowTasks(ctx, config.telegram.actions.COMPLETE_TASK));
bot.action(config.telegram.actions.SHOW_TASKS, (ctx) => loadAndShowTasks(ctx, null));

// Handle text messages
bot.on('text', async (ctx) => {
  const userId = ctx.from?.id;
  const session = ctx.session || {};
  const { action, step, tasks, selectedTask, tempCredentials } = session;

  // === AUTH FLOW ===

  if (step === 'enter_username') {
    const username = ctx.message.text.trim();
    if (action === config.telegram.actions.REGISTER) {
      ctx.session = { ...session, step: 'enter_password', tempCredentials: { username } };
      ctx.reply(config.telegram.messages.auth.register_password_prompt);
      return;
    } else if (action === config.telegram.actions.LOGIN) {
      ctx.session = { ...session, step: 'enter_password', tempCredentials: { username } };
      ctx.reply(config.telegram.messages.auth.password_prompt);
      return;
    }
  }

  if (step === 'enter_password') {
    const password = ctx.message.text.trim();
    const username = tempCredentials?.username;

    if (!username) {
      ctx.reply(config.telegram.messages.session_error, authKeyboard);
      return;
    }

    ctx.reply(config.telegram.messages.executing);

    if (action === config.telegram.actions.LOGIN) {
      const result = await api.login(userId, username, password);
      if (result.success) {
        ctx.reply(config.telegram.messages.auth.login_success, mainKeyboard);
        ctx.session = { action: null, step: null, authenticated: true };
      } else {
        if (result.alreadyInUse) {
          ctx.reply('❌ Этот аккаунт уже используется другим пользователем', authKeyboard);
        } else {
          ctx.reply(config.telegram.messages.auth.login_failed, authKeyboard);
        }
        ctx.session = { action: null, step: null, authenticated: false };
      }
      return;
    }

    if (action === config.telegram.actions.REGISTER) {
      const result = await api.register(userId, username, password);
      if (result.success) {
        ctx.reply(config.telegram.messages.auth.register_success, mainKeyboard);
        ctx.session = { action: null, step: null, authenticated: true };
      } else {
        if (result.alreadyInUse) {
          ctx.reply('❌ Этот аккаунт уже используется другим пользователем', authKeyboard);
        } else if (result.alreadyExists) {
          ctx.reply('❌ Пользователь с таким именем уже существует. Попробуйте другое имя или войдите.', authKeyboard);
        } else {
          ctx.reply(config.telegram.messages.auth.register_failed.replace('%s', result.error || 'Неизвестная ошибка'), authKeyboard);
        }
        ctx.session = { action: null, step: null, authenticated: false };
      }
      return;
    }
  }

  // === TASK FLOW (only for authenticated users) ===

  if (!session.authenticated) {
    ctx.reply(config.telegram.messages.no_action, authKeyboard);
    return;
  }

  if (!action) {
    ctx.reply(config.telegram.messages.no_action, mainKeyboard);
    return;
  }

  if (step === 'select_task') {
    const taskNumber = parseInt(ctx.message.text.trim()) - 1;
    if (isNaN(taskNumber) || taskNumber < 0 || taskNumber >= tasks.length) {
      ctx.reply(config.telegram.messages.invalid_number);
      return;
    }

    const selectedTask = tasks[taskNumber];

    if (action === config.telegram.actions.RENAME_TASK) {
      ctx.session = { ...session, step: 'enter_new_name', tasks, selectedTask };
      ctx.reply(config.telegram.messages.auth.rename_prompt);
      return;
    }

    ctx.reply(config.telegram.messages.executing);
    try {
      if (action === config.telegram.actions.DELETE_TASK) {
        await api.deleteTask(userId, taskNumber);
      } else if (action === config.telegram.actions.COMPLETE_TASK) {
        await api.completeTask(userId, taskNumber);
      }
      ctx.reply(config.telegram.messages.done, mainKeyboard);
    } catch (error) {
      ctx.reply(config.telegram.messages.error.replace('%s', error.message), mainKeyboard);
    }
    ctx.session = { action: null, step: null, authenticated: true };
    return;
  }

  if (step === 'enter_new_name') {
    const newTaskText = ctx.message.text.trim();
    const taskIndex = tasks.indexOf(selectedTask);
    ctx.reply(config.telegram.messages.executing);
    try {
      await api.renameTask(userId, taskIndex, newTaskText);
      ctx.reply(config.telegram.messages.done, mainKeyboard);
    } catch (error) {
      ctx.reply(config.telegram.messages.error.replace('%s', error.message), mainKeyboard);
    }
    ctx.session = { action: null, step: null, authenticated: true };
    return;
  }

  ctx.reply(config.telegram.messages.executing);
  try {
    await api.addTask(userId, ctx.message.text);
    ctx.reply(config.telegram.messages.done, mainKeyboard);
  } catch (error) {
    ctx.reply(config.telegram.messages.error.replace('%s', error.message), mainKeyboard);
  }
  ctx.session = { action: null, step: null, authenticated: true };
});

// Graceful restart support
let restarting = false;

process.on('SIGUSR2', async () => {
  if (restarting) return;
  restarting = true;
  
  console.log('\n🔄 Graceful restart requested...');
  
  // Stop accepting new messages
  await bot.stop('SIGUSR2');
  
  // Wait for pending messages to complete
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  // Restart
  console.log('🔄 Restarting bot...');
  
  // Re-launch
  bot.start('SIGUSR2');
  bot.launch();
  
  restarting = false;
  console.log('✓ Bot restarted');
});

bot.launch();
console.log('Telegram bot started...');

// Notify admins on startup
async function notifyAdmins() {
  if (config.telegram.adminIds.length > 0) {
    for (const adminId of config.telegram.adminIds) {
      try {
        await bot.telegram.sendMessage(
          adminId,
          config.telegram.messages.server_restart,
          authKeyboard
        );
        console.log(`✓ Startup notification sent to admin ${adminId}`);
      } catch (error) {
        console.log(`⚠ Admin ${adminId} not reachable: ${error.message}`);
        console.log(`   Ask them to message the bot first (press /start)`);
      }
    }
  } else {
    console.log('⚠ ADMIN_TELEGRAM_ID not set, skipping notification');
  }
}

setTimeout(() => {
  notifyAdmins();
}, 2000);

console.log('API service ready. Use /stop to close all sessions.');

process.once('SIGINT', async () => {
  console.log('\n🛑 Остановка сервера пользователем (Ctrl+C)...');
  await api.close();
  bot.stop('SIGINT');
  console.log('✅ Сервер остановлен\n');
  process.exit(0);
});

process.once('SIGTERM', async () => {
  console.log('\n🛑 Остановка сервера (SIGTERM)...');
  await api.close();
  bot.stop('SIGTERM');
  console.log('✅ Сервер остановлен\n');
  process.exit(0);
});
