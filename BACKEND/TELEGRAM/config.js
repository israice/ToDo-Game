require('dotenv').config();

module.exports = {
  // === Telegram Bot Config ===
  telegram: {
    adminIds: process.env.ADMIN_TELEGRAM_ID?.split(',').map(id => id.trim()).filter(id => id.length > 0) || [],
    buttons: {
      login: '🔑 Login',
      register: '📝 Registration',
      add_task: '📝 Add task',
      delete_task: '🗑️ Delete task',
      rename_task: '✏️ Rename',
      complete_task: '✅ Complete',
      show_tasks: '📋 Show tasks'
    },
    actions: {
      LOGIN: 'login',
      REGISTER: 'register',
      ADD_TASK: 'add_task',
      DELETE_TASK: 'delete_task',
      RENAME_TASK: 'rename_task',
      COMPLETE_TASK: 'complete_task',
      SHOW_TASKS: 'show_tasks'
    },
    messages: {
      auth: {
        start: 'Choose an action:\nIf you already have an account — press Login, otherwise — Registration',
        login_prompt: 'Enter your username:',
        password_prompt: 'Enter your password:',
        login_success: '✅ Login successful! You can now manage your tasks.',
        login_failed: '❌ Invalid username or password. Please try again.',
        register_success: '✅ Registration successful! You can now log in.',
        register_failed: '❌ Registration error: %s',
        register_username_prompt: 'Enter a username for registration:',
        register_password_prompt: 'Enter a password:',
        rename_prompt: 'Enter a new name for the task:',
        back_to_auth: '🔙 Back to authentication'
      },
      start: 'Choose an action:',
      prompts: {
        add_task: 'Enter text for the new task:'
      },
      no_action: 'Please choose an action from the menu first:',
      executing: '✅ Executing...',
      loading_tasks: '📋 Loading task list...',
      no_tasks: '❌ Task list is empty',
      task_list: '📝 Your tasks:\n\n%s\n\nEnter a number:',
      invalid_number: '❌ Invalid number. Please try again:',
      done: '✅ Done!',
      error: '❌ Error: %s',
      browser_closed: '❌ Please log in again.',
      server_restart: '🔄 Server restarted. Authentication required.',
      session_error: '❌ Session error. Start over: /start',
      taskIndexOutOfRange: '✗ Task index %d out of range (total: %d)'
    }
  },

  // === API Configuration ===
  api: {
    // Default matches SETTINGS.py; overridden by API_URL env var in Docker
    baseUrl: process.env.API_URL || 'http://localhost:5000'
  },

  // === Credentials (optional, for default user) ===
  credentials: {
    username: process.env.TODO_USERNAME,
    password: process.env.TODO_PASSWORD
  }
};
