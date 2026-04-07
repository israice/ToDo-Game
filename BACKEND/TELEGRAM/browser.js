const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const config = require('./config');

const SESSIONS_FILE = path.join(__dirname, '.sessions.json');

class ApiService {
  constructor() {
    this.sessions = new Map(); // Map<userId, { token, username, userId }>
    this.loadSessions();
  }

  loadSessions() {
    try {
      if (fs.existsSync(SESSIONS_FILE)) {
        const data = fs.readFileSync(SESSIONS_FILE, 'utf8');
        const sessionsData = JSON.parse(data);
        Object.entries(sessionsData).forEach(([userId, session]) => {
          this.sessions.set(parseInt(userId), session);
        });
        console.log(`✓ Loaded ${this.sessions.size} sessions from file`);
      }
    } catch (error) {
      console.error('⚠️ Error loading sessions:', error.message);
    }
  }

  saveSessions() {
    try {
      const sessionsData = {};
      this.sessions.forEach((session, userId) => {
        sessionsData[userId] = session;
      });
      fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessionsData, null, 2), 'utf8');
      console.log(`✓ Saved ${this.sessions.size} sessions to file`);
    } catch (error) {
      console.error('⚠️ Error saving sessions:', error.message);
    }
  }

  _request(method, path, data = {}) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(data);
      const url = new URL(path, config.api.baseUrl);
      const lib = url.protocol === 'https:' ? https : http;

      const options = {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: method,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      };

      const req = lib.request(options, (res) => {
        let responseData = '';
        res.on('data', chunk => responseData += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(responseData));
          } catch (e) {
            reject(new Error(`Invalid JSON response: ${responseData}`));
          }
        });
      });

      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  getSession(userId) {
    return this.sessions.get(userId);
  }

  _checkAccountInUse(username, userId) {
    for (const [uid, session] of this.sessions.entries()) {
      if (session.username === username && uid !== userId) {
        return { success: false, error: 'This account is already in use by another user', alreadyInUse: true };
      }
    }
    return null;
  }

  async login(userId, username, password) {
    console.log(`User ${userId} logging in as "${username}"...`);

    const inUse = this._checkAccountInUse(username, userId);
    if (inUse) {
      console.log(`✗ Login failed: account "${username}" is already in use`);
      return inUse;
    }

    try {
      const result = await this._request('POST', '/api/auth/login', { username, password });

      if (result.success) {
        this.sessions.set(userId, {
          token: result.token,
          username: result.username,
          userId: result.user_id
        });
        this.saveSessions();
        console.log(`✓ Login successful for user ${userId}`);
        return { success: true };
      } else {
        console.log(`✗ Login failed for user ${userId}:`, result.error);
        return { success: false, error: result.error };
      }
    } catch (error) {
      console.log(`✗ Login error for user ${userId}:`, error.message);
      return { success: false, error: error.message };
    }
  }

  async register(userId, username, password) {
    console.log(`User ${userId} registering as "${username}"...`);

    const inUse = this._checkAccountInUse(username, userId);
    if (inUse) {
      console.log(`✗ Registration failed: account "${username}" is already in use`);
      return inUse;
    }

    try {
      const result = await this._request('POST', '/api/auth/register', { username, password });

      if (result.success) {
        this.sessions.set(userId, {
          token: result.token,
          username: result.username,
          userId: result.user_id
        });
        this.saveSessions();
        console.log(`✓ Registration successful for user ${userId}`);
        return { success: true };
      } else {
        console.log(`✗ Registration failed for user ${userId}:`, result.error);
        return {
          success: false,
          error: result.error,
          alreadyExists: result.alreadyExists || false
        };
      }
    } catch (error) {
      console.log(`✗ Registration error for user ${userId}:`, error.message);
      return { success: false, error: error.message };
    }
  }

  async getTasks(userId) {
    const session = this.sessions.get(userId);
    if (!session) {
      throw new Error('Not authenticated');
    }

    const result = await this._request('GET', '/api/bot/tasks', { token: session.token });
    
    if (!result.success) {
      throw new Error(result.error || 'Failed to get tasks');
    }

    return result.tasks.map(t => t.text);
  }

  async addTask(userId, text) {
    const session = this.sessions.get(userId);
    if (!session) {
      throw new Error('Not authenticated');
    }

    console.log(`User ${userId} adding task: "${text}"`);
    const now = new Date();
    const in15 = new Date(now.getTime() + 15 * 60 * 1000);
    const result = await this._request('POST', '/api/bot/tasks/add', {
      token: session.token,
      text,
      scheduled_start: now.toISOString(),
      scheduled_end: in15.toISOString()
    });
    
    if (!result.success) {
      throw new Error(result.error || 'Failed to add task');
    }
    
    console.log('✓ Task added successfully');
    return result;
  }

  async _getTaskByIndex(userId, index) {
    const session = this.sessions.get(userId);
    if (!session) throw new Error('Not authenticated');

    const tasksResult = await this._request('GET', '/api/bot/tasks', { token: session.token });
    if (!tasksResult.success) throw new Error('Failed to get tasks');

    const tasks = tasksResult.tasks;
    if (index < 0 || index >= tasks.length) {
      console.log(`Task index ${index + 1} out of range (total: ${tasks.length})`);
      return null;
    }
    return { task: tasks[index], tasks };
  }

  async completeTask(userId, index) {
    const result = await this._getTaskByIndex(userId, index);
    if (!result) return;
    const { task } = result;

    console.log(`User ${userId} completing task #${index + 1}: "${task.text}"`);
    const session = this.sessions.get(userId);
    const res = await this._request('POST', `/api/bot/tasks/${task.id}/complete`, { token: session.token });
    if (!res.success) throw new Error(res.error || 'Failed to complete task');
    console.log('✓ Task completed successfully');
    return res;
  }

  async deleteTask(userId, index) {
    const result = await this._getTaskByIndex(userId, index);
    if (!result) return;
    const { task } = result;

    console.log(`User ${userId} deleting task #${index + 1}: "${task.text}"`);
    const session = this.sessions.get(userId);
    const res = await this._request('POST', `/api/bot/tasks/${task.id}/delete`, { token: session.token });
    if (!res.success) throw new Error(res.error || 'Failed to delete task');
    console.log('✓ Task deleted successfully');
    return res;
  }

  async renameTask(userId, index, newText) {
    const result = await this._getTaskByIndex(userId, index);
    if (!result) return;
    const { task } = result;

    console.log(`User ${userId} renaming task #${index + 1} to: "${newText}"`);
    const session = this.sessions.get(userId);
    const res = await this._request('POST', `/api/bot/tasks/${task.id}/rename`, { token: session.token, text: newText });
    if (!res.success) throw new Error(res.error || 'Failed to rename task');
    console.log('✓ Task renamed successfully');
    return res;
  }

  async closeUserSession(userId) {
    const session = this.sessions.get(userId);
    if (session) {
      // Invalidate token on server
      try {
        await this._request('POST', '/api/auth/logout', { token: session.token });
      } catch (e) {
        // Ignore logout errors
      }

      this.sessions.delete(userId);
      this.saveSessions();
      console.log(`✓ Session closed for user ${userId}`);
    }
  }

  async close() {
    // Close all user sessions
    const userIds = Array.from(this.sessions.keys());
    for (const userId of userIds) {
      await this.closeUserSession(userId);
    }
    console.log('✓ All sessions closed');
  }
}

// Singleton instance
const instance = new ApiService();

module.exports = instance;
