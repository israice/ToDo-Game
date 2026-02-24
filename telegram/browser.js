const https = require('https');
const http = require('http');
const config = require('./config');

class ApiService {
  constructor() {
    this.sessions = new Map(); // Map<userId, { token, username, userId }>
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

  async login(userId, username, password) {
    console.log(`User ${userId} logging in as "${username}"...`);

    // Check if this username is already in use
    for (const [uid, session] of this.sessions.entries()) {
      if (session.username === username && uid !== userId) {
        console.log(`✗ Login failed: account "${username}" is already in use by user ${uid}`);
        return { success: false, error: 'Этот аккаунт уже используется другим пользователем', alreadyInUse: true };
      }
    }

    try {
      const result = await this._request('POST', '/api/auth/login', { username, password });
      
      if (result.success) {
        this.sessions.set(userId, {
          token: result.token,
          username: result.username,
          userId: result.user_id
        });
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

    // Check if this username is already in use
    for (const [uid, session] of this.sessions.entries()) {
      if (session.username === username && uid !== userId) {
        console.log(`✗ Registration failed: account "${username}" is already in use by user ${uid}`);
        return { success: false, error: 'Этот аккаунт уже используется другим пользователем', alreadyInUse: true };
      }
    }

    try {
      const result = await this._request('POST', '/api/auth/register', { username, password });
      
      if (result.success) {
        this.sessions.set(userId, {
          token: result.token,
          username: result.username,
          userId: result.user_id
        });
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
    const result = await this._request('POST', '/api/bot/tasks/add', { 
      token: session.token, 
      text 
    });
    
    if (!result.success) {
      throw new Error(result.error || 'Failed to add task');
    }
    
    console.log('✓ Task added successfully');
    return result;
  }

  async completeTask(userId, index) {
    const session = this.sessions.get(userId);
    if (!session) {
      throw new Error('Not authenticated');
    }

    // First get tasks to find the one at index
    const tasksResult = await this._request('GET', '/api/bot/tasks', { token: session.token });
    if (!tasksResult.success) {
      throw new Error('Failed to get tasks');
    }

    const tasks = tasksResult.tasks;
    if (index < 0 || index >= tasks.length) {
      console.log(`Task index ${index + 1} out of range (total: ${tasks.length})`);
      return;
    }

    const task = tasks[index];
    console.log(`User ${userId} completing task #${index + 1}: "${task.text}"`);

    const result = await this._request('POST', `/api/bot/tasks/${task.id}/complete`, { 
      token: session.token 
    });
    
    if (!result.success) {
      throw new Error(result.error || 'Failed to complete task');
    }
    
    console.log('✓ Task completed successfully');
    return result;
  }

  async deleteTask(userId, index) {
    const session = this.sessions.get(userId);
    if (!session) {
      throw new Error('Not authenticated');
    }

    // First get tasks to find the one at index
    const tasksResult = await this._request('GET', '/api/bot/tasks', { token: session.token });
    if (!tasksResult.success) {
      throw new Error('Failed to get tasks');
    }

    const tasks = tasksResult.tasks;
    if (index < 0 || index >= tasks.length) {
      console.log(`Task index ${index + 1} out of range (total: ${tasks.length})`);
      return;
    }

    const task = tasks[index];
    console.log(`User ${userId} deleting task #${index + 1}: "${task.text}"`);

    const result = await this._request('POST', `/api/bot/tasks/${task.id}/delete`, { 
      token: session.token 
    });
    
    if (!result.success) {
      throw new Error(result.error || 'Failed to delete task');
    }
    
    console.log('✓ Task deleted successfully');
    return result;
  }

  async renameTask(userId, index, newText) {
    const session = this.sessions.get(userId);
    if (!session) {
      throw new Error('Not authenticated');
    }

    // First get tasks to find the one at index
    const tasksResult = await this._request('GET', '/api/bot/tasks', { token: session.token });
    if (!tasksResult.success) {
      throw new Error('Failed to get tasks');
    }

    const tasks = tasksResult.tasks;
    if (index < 0 || index >= tasks.length) {
      console.log(`Task index ${index + 1} out of range (total: ${tasks.length})`);
      return;
    }

    const task = tasks[index];
    console.log(`User ${userId} renaming task #${index + 1} to: "${newText}"`);

    const result = await this._request('POST', `/api/bot/tasks/${task.id}/rename`, { 
      token: session.token,
      text: newText 
    });
    
    if (!result.success) {
      throw new Error(result.error || 'Failed to rename task');
    }
    
    console.log('✓ Task renamed successfully');
    return result;
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
