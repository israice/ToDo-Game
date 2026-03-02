# Telegram Bot for TODO GAME

Telegram bot for managing tasks in TODO GAME via direct API.

## 📋 Description

The bot provides an interface for managing tasks in the TODO application through Telegram. It uses direct HTTP API instead of browser automation.

## 🔧 Features

| Action | Description |
|----------|----------|
| 🔑 Login | Sign in to an existing account |
| 📝 Registration | Create a new account |
| 📝 Add task | Create a new task |
| 🗑️ Delete task | Delete a task by number |
| ✏️ Rename | Change the task name |
| ✅ Complete | Mark a task as completed |
| 📋 Show tasks | View the task list |

## 🚀 How it works

```
┌─────────────────────────────────────────┐
│  Telegram Bot (run.js)                  │
│  • Receives commands from the user      │
│  • Manages sessions (tokens)            │
│  • Calls API methods                    │
└─────────────────┬───────────────────────┘
                  │ HTTP requests
                  ↓
┌─────────────────────────────────────────┐
│  TODO GAME API (run.py)              │
│  • /api/auth/login                      │
│  • /api/auth/register                   │
│  • /api/bot/tasks/*                     │
└─────────────────┬───────────────────────┘
                  │
                  ↓
┌─────────────────────────────────────────┐
│  SQLite (users.db)                      │
└─────────────────────────────────────────┘
```

## 📦 Installation

1. **Clone the repository:**
   ```bash
   git clone <repository-url>
   cd todo-game/BACKEND/TELEGRAM
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Set up environment variables:**
   ```bash
   # Copy the example
   copy .env.example .env

   # Edit .env and specify:
   TELEGRAM_BOT_TOKEN=your_bot_token
   API_URL=https://todo.weforks.org
   ```

## ▶️ Launch

```bash
npm start
```

After launching, the bot will wait for commands in Telegram.

## 📱 Usage in Telegram

1. **Start the bot:** Send `/start`
2. **Choose an action** from the button menu
3. **Follow the bot's instructions:**
   - To **log in** — enter your username and password
   - To **register** — enter a new username and password
   - To **manage tasks** — choose an action and follow the prompts

### Example dialog

```
You: /start
Bot: Choose an action:
     [🔑 Login] [📝 Registration]

You: [pressed 🔑 Login]
Bot: Enter your username:

You: myusername
Bot: Enter your password:

You: mypassword
Bot: ✅ Login successful! Now you can manage tasks.
     [📝 Add task] [🗑️ Delete task]
     [✏️ Rename] [✅ Complete]
     [📋 Show tasks]

You: [pressed 📋 Show tasks]
Bot: 📋 Loading task list...
Bot: 📝 Your tasks:
     1. Buy milk
     2. Walk the dog
     3. Clean the house
```

## 📁 Project structure

```
BACKEND/TELEGRAM/
├── run.js              # Telegram bot (main)
├── browser.js          # API service (HTTP requests)
├── config.js           # Configuration
├── package.json        # Dependencies
├── .env                # Environment variables
└── README.md           # Documentation
```

## ⚙️ Configuration

### Environment variables (.env)

| Variable | Description |
|------------|----------|
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather |
| `API_URL` | TODO GAME API URL (default: https://todo.weforks.org) |
| `ADMIN_TELEGRAM_ID` | Admin Telegram IDs (comma-separated) |

### config.js

```javascript
module.exports = {
  telegram: {
    adminIds: [...],         // Admin IDs
    buttons: { ... },        // Button labels
    actions: { ... },        // Internal action names
    messages: { ... }        // Bot messages
  },
  api: {
    baseUrl: '...'           // API URL from .env
  }
};
```

## 🔍 Debugging

Enable detailed console logging:
- User sessions
- Loaded task lists
- API request execution results

## 📝 Dependencies

- [telegraf](https://telegraf.js.org/) — framework for Telegram bots
- [dotenv](https://github.com/motdotla/dotenv) — environment variable management

## ⚠️ Notes

- The bot works with multiple users simultaneously
- Sessions are stored in memory (reset on restart)
- Each token is unique and bound to a user
- Access to the TODO GAME API is required for operation

## 🔐 Security

- Tokens are generated using SHA-256
- Tokens are stored in the database on the server
- Ability to revoke a token via logout
- One account cannot be used by multiple users simultaneously

## 📄 License

MIT
