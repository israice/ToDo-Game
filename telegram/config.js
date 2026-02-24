require('dotenv').config();

module.exports = {
  // === Telegram Bot Config ===
  telegram: {
    adminIds: process.env.ADMIN_TELEGRAM_ID?.split(',').map(id => id.trim()).filter(id => id.length > 0) || [],
    buttons: {
      login: '🔑 Login',
      register: '📝 Registration',
      add_task: '📝 Добавить задание',
      delete_task: '🗑️ Удалить задание',
      rename_task: '✏️ Переименовать',
      complete_task: '✅ Выполнить',
      show_tasks: '📋 Показать задачи'
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
        start: 'Выберите действие:\nЕсли у вас уже есть аккаунт — нажмите Login, иначе — Registration',
        login_prompt: 'Введите ваше имя пользователя:',
        password_prompt: 'Введите пароль:',
        login_success: '✅ Успешный вход! Теперь вы можете управлять задачами.',
        login_failed: '❌ Неверное имя пользователя или пароль. Попробуйте снова.',
        register_success: '✅ Регистрация успешна! Теперь вы можете войти.',
        register_failed: '❌ Ошибка регистрации: %s',
        register_username_prompt: 'Введите имя пользователя для регистрации:',
        register_password_prompt: 'Введите пароль:',
        rename_prompt: 'Введите новое имя для задачи:',
        back_to_auth: '🔙 Вернуться к авторизации'
      },
      start: 'Выберите действие:',
      prompts: {
        add_task: 'Введите текст для нового задания:'
      },
      no_action: 'Сначала выберите действие из меню:',
      executing: '✅ Выполняю...',
      loading_tasks: '📋 Загружаю список задач...',
      no_tasks: '❌ Список задач пуст',
      task_list: '📝 Ваши задачи:\n\n%s\n\nВведите номер:',
      invalid_number: '❌ Неверный номер. Попробуйте снова:',
      done: '✅ Готово!',
      error: '❌ Ошибка: %s',
      browser_closed: '❌ Пожалуйста, авторизуйтесь заново.',
      server_restart: '🔄 Сервер перезапустился. Требуется авторизация.',
      session_error: '❌ Ошибка сессии. Начните сначала: /start',
      taskIndexOutOfRange: '✗ Task index %d out of range (total: %d)'
    }
  },

  // === API Configuration ===
  api: {
    baseUrl: process.env.API_URL || 'https://todo.weforks.org'
  },

  // === Credentials (optional, for default user) ===
  credentials: {
    username: process.env.TODO_USERNAME,
    password: process.env.TODO_PASSWORD
  }
};
