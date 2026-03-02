<div align="center">

# 🎮 TODO GAME

## **Your tasks. Your game. Your victory.**

<br>

[![Python](https://img.shields.io/badge/Python-3.8+-3776AB?style=for-the-badge&logo=python&logoColor=white)](https://python.org)
[![Flask](https://img.shields.io/badge/Flask-000000?style=for-the-badge&logo=flask&logoColor=white)](https://flask.palletsprojects.com)
[![SQLite](https://img.shields.io/badge/SQLite-003B57?style=for-the-badge&logo=sqlite&logoColor=white)](https://sqlite.org)
[![License](https://img.shields.io/badge/MIT-green?style=for-the-badge)](LICENSE)

---

</div>

## 🚀 Live Website
> https://todo.weforks.org/

<div align="center">
  <img src="TOOLS/v0.0.12-1.png" alt="Dashboard" height="300">
  <img src="TOOLS/v0.0.12-2.png" alt="Dashboard" height="300">
</div>

<br>

## 🎯 What is this?

**TODO GAME** — this is not just another boring to-do list.

It's a full-fledged **RPG system** built into your daily workflow. Every task is a monster you need to defeat. Every checkmark is **+XP** for your character.

```
   ╔══════════════════════════════════════════╗
   ║  LEVEL UP YOUR LIFE                      ║
   ║  ████████████████░░░░░░  78%  LVL 12    ║
   ║  🔥 COMBO x7   ⚡ +245 XP   📅 STREAK 14 ║
   ╚══════════════════════════════════════════╝
```

## 🔥 Why it's addictive

<table>
<tr>
<td width="50%">

### ⚔️ COMBAT SYSTEM

Complete a task → earn **20-35 XP**

But that's just the beginning...

**COMBO SYSTEM:**
- Completed a task? The timer starts!
- **5 seconds** for the next one
- Combo x2 → x3 → x4 → **x10!**
- Each combo = **+10% to XP**

*One good streak = more XP than the entire day*

</td>
<td width="50%">

### 📈 PROGRESSION

```
LVL 1   ░░░░░░░░░░  Rookie
LVL 10  ████░░░░░░  Routine Warrior
LVL 25  ███████░░░  Task Master
LVL 50  ██████████  LEGEND
```

Exponential curve:
- Early levels fly by fast
- Higher ones — require dedication
- A sense of progress **every single day**

</td>
</tr>
</table>

---

## 🏆 12 ACHIEVEMENTS

Hunt them all down:

| Achievement | Condition | Rarity |
|:----------:|---------|:--------:|
| 🏅 **First Steps** | Complete your first quest | Common |
| ⚔️ **Traveler** | Complete 5 quests | Common |
| 🛡️ **Veteran** | Complete 10 quests | Uncommon |
| 🦁 **Hero** | Complete 25 quests | Rare |
| 👑 **Legend** | Complete 50 quests | **EPIC** |
| 🔥 **Combo Starter** | Combo x3 | Common |
| ⚡ **On Fire!** | Combo x5 | Uncommon |
| 🌟 **Unstoppable** | Combo x10 | Rare |
| ⭐ **Rising Star** | Reach level 5 | Common |
| 💎 **Master** | Reach level 10 | Uncommon |
| 💪 **Weekly Warrior** | 7-day streak | Rare |
| 🏆 **Monthly Master** | 30-day streak | **LEGENDARY** |

---

## 🎧 FULL IMMERSION

<div align="center">

**Procedurally generated sounds** via Web Audio API

</div>

```
🔊 Adding a task        → soft "bloop"
✅ Completing            → satisfying "ding!"
🔥 Combo                → escalating "whoosh!"
⬆️ Level Up             → epic fanfare
🏆 Achievement          → triumphant chord
```

*Every action feels like a small victory*

---

## 🌗 TWO THEMES

<table>
<tr>
<td align="center" width="50%">

### ☀️ Light Theme
For daytime sessions

</td>
<td align="center" width="50%">

### 🌙 Dark Theme
For late-night grinding

</td>
</tr>
</table>

Switch with a single button. Settings are saved.

---

## 👥 SOCIAL NETWORK

<table>
<tr>
<td width="50%">

### 🔍 Find Friends
- Search for players by username
- Send friend requests
- Accept or decline incoming requests

</td>
<td width="50%">

### 📰 Activity Feed
- See what your friends are up to
- Get inspired by their progress
- Compete in productivity

</td>
</tr>
</table>

---

## 📸 MEDIA IN TASKS

Attach to your tasks:
- 🖼️ **Images:** PNG, JPG, GIF, WebP
- 🎬 **Videos:** MP4, WebM, MOV

*Visualize your progress. Share with friends.*

---

## 📑 THREE TABS

| Tab | Contents |
|:-------:|------------|
| **TODO** | Your tasks and progress |
| **SOCIAL** | Friends and activity feed |
| **HISTORY** | Action history and achievements |

---

## 🚀 LAUNCH IN 60 SECONDS

### Option 1: Locally (web only)

```bash
# Clone
git clone https://github.com/YOUR_USERNAME/todo-game.git
cd todo-game

# Install
pip install flask flask-wtf bcrypt python-dotenv

# Play
python run.py
```

Open **http://localhost:5010** and create an account.

**That's it.** No 10-minute npm install. No config files. It just works.

### Option 2: Locally (web + Telegram bot)

```bash
# Windows
cd BACKEND
start-all.bat

# Linux/Mac
cd BACKEND
chmod +x start-all.sh
./start-all.sh
```

Launches both services in separate windows.

### Option 3: Docker (web + Telegram bot)

```bash
docker-compose up -d --build
```

Settings in `.env`:
- `SECRET_KEY` — secret for sessions
- `PORT` — port (default 5010)
- `TELEGRAM_BOT_TOKEN` — bot token from @BotFather
- `API_URL` — API URL (for the bot)
- `ADMIN_TELEGRAM_ID` — admin's Telegram ID

---

## 🤖 TELEGRAM BOT

The bot lets you manage tasks via Telegram.

### Quick Start

1. **Create a bot:** Message @BotFather on Telegram, create a bot, get the token
2. **Configure .env:** Add `TELEGRAM_BOT_TOKEN=your_token`
3. **Launch the bot:**
   ```bash
   cd BACKEND/TELEGRAM
   npm install
   node run.js
   ```
4. **Message the bot:** Send `/start` in Telegram

### Bot Features

- 🔑 Login and registration in TODO GAME
- 📝 Adding tasks
- ✅ Completing tasks
- 🗑️ Deleting tasks
- ✏️ Renaming tasks
- 📋 Viewing task list

**More details:** See [BACKEND/TELEGRAM/README.md](BACKEND/TELEGRAM/README.md)

---

## 🔄 AUTO-UPDATE (CI/CD)

The server updates automatically on every `git push`.

### Setup in 2 Minutes

1. **Configure `.env`:**
   ```bash
   WEBHOOK_SECRET=your-super-secret-key
   REPO_URL=https://github.com/YOUR_USERNAME/todo-game.git
   ```

2. **Set up the webhook on GitHub:**
   - Settings → Webhooks → Add webhook
   - **Payload URL:** `https://your-server.com/webhook`
   - **Content type:** `application/json`
   - **Secret:** your `WEBHOOK_SECRET`
   - **Events:** Just the push event

3. **Done!** Now on every `git push` the server will update automatically.

**More details:** See [WEBHOOK_SETUP.md](WEBHOOK_SETUP.md)

---

## 🛡️ SECURITY

- 🔐 Passwords are hashed with **bcrypt**
- 🛡️ CSRF protection on all forms
- 💾 Data is stored **locally** in SQLite
- 🚫 No telemetry, no cloud

**Your tasks — yours only.**

---

## 🧬 UNDER THE HOOD

<div align="center">

| | |
|:---:|:---:|
| **Backend** | **Frontend** |
| Python 3.8+ | Vanilla JavaScript |
| Flask | HTML5 + CSS3 |
| SQLite3 | Web Audio API |
| bcrypt | CSS Custom Properties |

</div>

**Minimalism:**
- No React/Vue/Angular
- No Webpack/Vite
- No node_modules
- ~3400 lines of code

*Loads fast. Runs fast. Easy to understand.*

---

## 🎮 HOW TO PLAY

```
1. 📝 Add a task              "Write the report"
2. ✅ Complete it              +27 XP!
3. ⚡ Quickly add another      "Reply to emails"
4. ✅ Complete in 5 seconds    +31 XP × 2 COMBO!
5. 🔥 Keep the streak going   COMBO x3... x4... x5!
6. 📈 Watch your XP grow      ████████░░ NEW LEVEL!
7. 🏆 Earn an achievement     🎉 "Combo Starter"!
8. 🔁 Repeat every day        📅 Streak +1
```

---

<div align="center">

## ⭐ LIKED IT?

**Give it a star** — it motivates us to keep developing the project

---

### 🐛 Bugs and ideas → [Issues](../../issues)

### 🤝 Want to contribute? → [Pull Requests](../../pulls)

### 📋 Version history → [VERSION.md](VERSION.md)

---

<br>

```
╔═══════════════════════════════════════════════════╗
║                                                   ║
║   "Gamification doesn't make work easier.        ║
║    It makes it more interesting."                ║
║                                                   ║
╚═══════════════════════════════════════════════════╝
```

<br>

**MIT License** | Made with 🎮 ☕ and a desire to beat procrastination

</div>
