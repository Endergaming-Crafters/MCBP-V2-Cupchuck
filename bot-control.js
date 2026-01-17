const mineflayer = require('mineflayer');
const { Vec3 } = require('vec3');
const fs = require('fs').promises;
const path = require('path');

const BOTS_PATH = path.join(__dirname, 'data', 'bots.json');

class BotManager {
    constructor() {
        this.bots = new Map(); // id -> bot instance
        this.botData = new Map(); // id -> bot configuration
        this.botStatus = new Map(); // id -> status object
        this.io = null;
        this.keepAliveTimers = new Map();
        this.reconnectTimers = new Map();
        this.messageQueue = new Map(); // id -> array of queued messages
        this.reconnectAttempts = new Map(); // id -> number of reconnect attempts
        
        this.loadBots();
    }

    async loadBots() {
        try {
            const data = await fs.readFile(BOTS_PATH, 'utf8');
            const bots = JSON.parse(data);
            
            bots.forEach(bot => {
                this.botData.set(bot.id, bot);
                this.botStatus.set(bot.id, {
                    status: 'offline',
                    connectedSince: null,
                    lastError: null,
                    stats: {}
                });
                this.messageQueue.set(bot.id, []);
                this.reconnectAttempts.set(bot.id, 0);
            });
            
        } catch (error) {
            console.error('Failed to load bots:', error);
        }
    }

    setSocketIO(io) {
        this.io = io;
    }

    // Start a specific bot
    async startBot(botConfig, io = this.io) {
        const botId = botConfig.id;
        
        // Clear any pending reconnect timer
        const reconnectTimer = this.reconnectTimers.get(botId);
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            this.reconnectTimers.delete(botId);
        }

        // Check if bot is already running
        if (this.bots.has(botId)) {
            this.emitLog(botId, 'warn', 'Bot is already running');
            return;
        }

        this.emitLog(botId, 'info', `Starting bot ${botConfig.name} (${botConfig.username})`);
        this.updateStatus(botId, { status: 'connecting' });

        try {
            const bot = mineflayer.createBot({
                host: botConfig.server,
                port: botConfig.port,
                username: botConfig.username,
                password: botConfig.password || undefined,
                auth: botConfig.auth || 'offline',
                version: botConfig.version,
                hideErrors: false,
                viewDistance: 'far', // Always see messages from far away
                chatLengthLimit: 256, // Allow longer chat messages
                colorsEnabled: true // Enable chat colors
            });

            this.bots.set(botId, bot);
            bot.botId = botId;
            bot.botConfig = botConfig;
            
            // Reset manually stopped flag when starting
            bot.manuallyStopped = false;

            // Reset reconnect attempts on successful start
            this.reconnectAttempts.set(botId, 0);

            // Bot event handlers
            bot.once('spawn', () => {
                this.emitLog(botId, 'info', `Bot spawned as ${bot.username}`);
                this.updateStatus(botId, { 
                    status: 'online',
                    connectedSince: new Date().toISOString(),
                    world: bot.game.dimension,
                    dimension: bot.game.dimension,
                    position: bot.entity.position
                });

                // Handle AuthMe registration/login
                setTimeout(() => {
                    if (botConfig.password) {
                        try {
                            bot.chat(`/register ${botConfig.password} ${botConfig.password}`);
                            this.emitLog(botId, 'info', 'Sent AuthMe registration command');
                        } catch(e) {}
                        
                        setTimeout(() => {
                            try {
                                bot.chat(`/login ${botConfig.password}`);
                                this.emitLog(botId, 'info', 'Sent AuthMe login command');
                            } catch(e) {}
                        }, 2000);
                    }
                }, 5000);

                // Start keep-alive loop
                this.startKeepAlive(botId);

                // Send any queued messages
                this.processMessageQueue(botId);
            });

            bot.on('chat', (username, message) => {
                if (username === bot.username) return; // Don't echo own messages
                
                // Always log chat messages
                this.emitChat(botId, username, message);
                
                // Check for commands or mentions
                if (message.toLowerCase().includes(bot.username.toLowerCase()) || 
                    message.startsWith('!') || 
                    message.startsWith('@')) {
                    this.emitLog(botId, 'info', `Message mention/command from ${username}: ${message}`);
                }
            });

            bot.on('message', (jsonMsg, position) => {
                const text = jsonMsg.toString();
                
                // Always log ALL messages (system, chat, action, etc.)
                if (position === 'chat') {
                    this.emitLog(botId, 'message', `[CHAT] ${text}`);
                } else if (position === 'system') {
                    this.emitLog(botId, 'message', `[SYSTEM] ${text}`);
                } else if (position === 'game_info') {
                    this.emitLog(botId, 'message', `[GAME] ${text}`);
                } else {
                    this.emitLog(botId, 'message', text);
                }
            });

            bot.on('playerJoined', (player) => {
                this.emitLog(botId, 'info', `Player joined: ${player.username}`);
            });

            bot.on('playerLeft', (player) => {
                this.emitLog(botId, 'info', `Player left: ${player.username}`);
            });

            bot.on('death', () => {
                this.emitLog(botId, 'warn', 'Bot died');
            });

            bot.on('health', () => {
                if (bot.health <= 10) {
                    this.emitLog(botId, 'warn', `Low health: ${bot.health}/20`);
                }
            });

            bot.on('kicked', (reason) => {
                this.emitLog(botId, 'warn', `Kicked: ${reason}`);
                this.updateStatus(botId, { 
                    status: 'offline',
                    lastError: `Kicked: ${reason}`
                });
                
                // Only auto-reconnect if not manually stopped
                if (botConfig.enabled !== false && !bot.manuallyStopped) {
                    this.scheduleReconnect(botId, botConfig);
                }
                
                this.cleanupBot(botId);
            });

            bot.on('error', (err) => {
                this.emitLog(botId, 'error', `Error: ${err.message || err}`);
                this.updateStatus(botId, { 
                    status: 'error',
                    lastError: err.message
                });
                
                // Only auto-reconnect if not manually stopped
                if (botConfig.enabled !== false && !bot.manuallyStopped) {
                    this.scheduleReconnect(botId, botConfig);
                }
                
                this.cleanupBot(botId);
            });

            bot.on('end', (reason) => {
                this.emitLog(botId, 'warn', `Bot disconnected: ${reason || 'No reason provided'}`);
                this.updateStatus(botId, { status: 'offline' });
                
                // Only auto-reconnect if not manually stopped
                if (botConfig.enabled !== false && !bot.manuallyStopped) {
                    this.scheduleReconnect(botId, botConfig);
                }
                
                this.cleanupBot(botId);
            });

            // Collect stats
            bot.on('move', () => {
                const stats = this.botStatus.get(botId).stats || {};
                stats.position = bot.entity.position;
                stats.world = bot.game.dimension;
                stats.dimension = bot.game.dimension;
                stats.health = bot.health;
                stats.food = bot.food;
                if (bot.player && bot.player.ping) {
                    stats.ping = bot.player.ping;
                }
                this.updateStatus(botId, { stats });
            });

            // Listen for entity spawns (players, mobs, etc.)
            bot.on('entitySpawn', (entity) => {
                if (entity.type === 'player') {
                    // Log player appearances
                    this.emitLog(botId, 'info', `Player entity spawned: ${entity.username}`);
                }
            });

            // Listen for server messages (broadcasts, etc.)
            bot.on('messagestr', (message, position, jsonMsg) => {
                this.emitLog(botId, 'message', `[SERVER] ${message}`);
            });

        } catch (error) {
            this.emitLog(botId, 'error', `Failed to create bot: ${error.message}`);
            this.updateStatus(botId, { 
                status: 'error',
                lastError: error.message
            });
            
            // Only auto-reconnect if bot is enabled
            if (botConfig.enabled !== false) {
                this.scheduleReconnect(botId, botConfig);
            }
        }
    }

    // Schedule auto-reconnect (only for enabled bots)
    scheduleReconnect(botId, botConfig) {
        // Check if bot is enabled for auto-reconnect
        if (!botConfig || botConfig.enabled === false) {
            this.emitLog(botId, 'info', 'Bot is disabled, not auto-reconnecting');
            return;
        }
        
        // Check if bot was manually stopped
        const bot = this.bots.get(botId);
        if (bot && bot.manuallyStopped) {
            this.emitLog(botId, 'info', 'Bot was manually stopped, not auto-reconnecting');
            return;
        }

        // Clear any existing timer
        const existingTimer = this.reconnectTimers.get(botId);
        if (existingTimer) {
            clearTimeout(existingTimer);
        }

        // Increment reconnect attempts
        const attempts = (this.reconnectAttempts.get(botId) || 0) + 1;
        this.reconnectAttempts.set(botId, attempts);
        
        // Schedule reconnect with exponential backoff (max 5 minutes)
        const delay = Math.min(300000, 5000 * Math.pow(1.5, attempts));
        
        this.emitLog(botId, 'info', `Scheduled auto-reconnect in ${Math.round(delay/1000)} seconds (attempt ${attempts})`);
        
        const timer = setTimeout(() => {
            this.emitLog(botId, 'info', 'Attempting to auto-reconnect...');
            this.startBot(botConfig, this.io);
        }, delay);
        
        this.reconnectTimers.set(botId, timer);
    }

    // Stop a specific bot (manual stop, no auto-reconnect)
    stopBot(botId) {
        const bot = this.bots.get(botId);
        
        // Clear any pending reconnect timer
        const reconnectTimer = this.reconnectTimers.get(botId);
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            this.reconnectTimers.delete(botId);
        }
        
        // Reset reconnect attempts
        this.reconnectAttempts.set(botId, 0);
        
        if (bot) {
            this.emitLog(botId, 'info', 'Stopping bot (manual)...');
            
            // Set flag to prevent auto-reconnect
            bot.manuallyStopped = true;
            
            bot.quit('Stopped by user');
            this.cleanupBot(botId, false); // false = don't schedule reconnect
        } else {
            this.updateStatus(botId, { status: 'offline' });
        }
    }

    // Stop all bots
    shutdownAll() {
        this.emitLog('system', 'info', 'Shutting down all bots...');
        this.bots.forEach((bot, botId) => {
            try {
                bot.quit('System shutdown');
            } catch (e) {}
            this.cleanupBot(botId, false); // Don't reconnect on shutdown
        });
        this.bots.clear();
    }

    // Send message through a bot
    sendMessage(botId, message) {
        const bot = this.bots.get(botId);
        if (bot && bot.chat) {
            try {
                bot.chat(message);
                this.emitLog(botId, 'info', `Sent: ${message}`);
                return true;
            } catch (error) {
                this.emitLog(botId, 'error', `Failed to send message: ${error.message}`);
                
                // Queue message for when bot reconnects
                const queue = this.messageQueue.get(botId) || [];
                queue.push(message);
                this.messageQueue.set(botId, queue);
                this.emitLog(botId, 'info', `Message queued (${queue.length} in queue)`);
                
                return false;
            }
        } else {
            // Bot not connected, queue message
            const queue = this.messageQueue.get(botId) || [];
            queue.push(message);
            this.messageQueue.set(botId, queue);
            this.emitLog(botId, 'info', `Bot not connected, message queued (${queue.length} in queue)`);
            return false;
        }
    }

    // Process queued messages when bot reconnects
    processMessageQueue(botId) {
        const queue = this.messageQueue.get(botId) || [];
        if (queue.length === 0) return;

        this.emitLog(botId, 'info', `Processing ${queue.length} queued messages`);
        
        // Send queued messages with delays
        queue.forEach((message, index) => {
            setTimeout(() => {
                const bot = this.bots.get(botId);
                if (bot && bot.chat) {
                    try {
                        bot.chat(message);
                        this.emitLog(botId, 'info', `Sent queued: ${message}`);
                    } catch (error) {
                        this.emitLog(botId, 'error', `Failed to send queued message: ${error.message}`);
                    }
                }
            }, 1000 * index); // 1 second delay between messages
        });
        
        // Clear queue
        this.messageQueue.set(botId, []);
    }

    // Get bot status
    getBotStatus(botId) {
        return this.botStatus.get(botId) || { status: 'offline' };
    }

    // Get all bot statuses
    getAllBotStatuses() {
        const statuses = {};
        this.botStatus.forEach((status, botId) => {
            statuses[botId] = status;
        });
        return statuses;
    }

    // Get bot stats
    getBotStats(botId) {
        const status = this.botStatus.get(botId);
        return status ? status.stats || {} : {};
    }

    // Update bot status
    updateStatus(botId, updates) {
        const currentStatus = this.botStatus.get(botId) || { status: 'offline', stats: {} };
        const newStatus = { ...currentStatus, ...updates };
        this.botStatus.set(botId, newStatus);
        
        // Emit status update via Socket.IO
        if (this.io) {
            this.io.emit('bot-status', { botId, ...newStatus });
        }
    }

    // Emit log message
    emitLog(botId, level, message) {
        console.log(`[${botId}] ${level}: ${message}`);
        
        if (this.io) {
            this.io.emit('bot-log', {
                botId,
                level,
                message,
                timestamp: new Date().toISOString()
            });
        }
    }

    // Emit chat message
    emitChat(botId, username, message) {
        if (this.io) {
            this.io.emit('bot-chat', {
                botId,
                username,
                message,
                timestamp: new Date().toISOString()
            });
        }
    }

    // Cleanup bot resources
    cleanupBot(botId, scheduleReconnect = true) {
        const bot = this.bots.get(botId);
        if (bot) {
            this.bots.delete(botId);
        }
        
        // Clear keep-alive timer
        const keepAliveTimer = this.keepAliveTimers.get(botId);
        if (keepAliveTimer) {
            clearInterval(keepAliveTimer);
            this.keepAliveTimers.delete(botId);
        }
        
        // Clear reconnect timer unless we're manually stopping
        if (!scheduleReconnect) {
            const reconnectTimer = this.reconnectTimers.get(botId);
            if (reconnectTimer) {
                clearTimeout(reconnectTimer);
                this.reconnectTimers.delete(botId);
            }
        }
    }

    // Start keep-alive movements
    startKeepAlive(botId) {
        const bot = this.bots.get(botId);
        if (!bot) return;

        // Clear any existing timer
        const existingTimer = this.keepAliveTimers.get(botId);
        if (existingTimer) {
            clearInterval(existingTimer);
        }

        const timer = setInterval(() => {
            if (!bot || !bot.entity) return;

            try {
                // Random small movement to prevent AFK
                const dx = Math.floor(Math.random() * 3) - 1;
                const dz = Math.floor(Math.random() * 3) - 1;
                const pos = bot.entity.position.offset(dx, 0, dz);
                
                bot.lookAt(pos);
                bot.setControlState('forward', true);
                
                setTimeout(() => {
                    if (bot && bot.setControlState) {
                        bot.setControlState('forward', false);
                    }
                }, 1000);

                // Jump occasionally
                if (Math.random() > 0.7) {
                    bot.setControlState('jump', true);
                    setTimeout(() => {
                        if (bot && bot.setControlState) {
                            bot.setControlState('jump', false);
                        }
                    }, 500);
                }

                // Look around to see more
                if (Math.random() > 0.5) {
                    bot.look(bot.entity.yaw + (Math.random() * 60 - 30), bot.entity.pitch + (Math.random() * 20 - 10));
                }

            } catch (error) {
                this.emitLog(botId, 'error', `Keep-alive error: ${error.message}`);
            }
        }, 45000); // Every 45 seconds (less than typical AFK timeout)

        this.keepAliveTimers.set(botId, timer);
    }
}

// Create singleton instance
const botManager = new BotManager();

// Export functions for server.js
module.exports = {
    // Bot management
    startBot: (botConfig, io) => botManager.startBot(botConfig, io),
    stopBot: (botId) => botManager.stopBot(botId),
    shutdownAll: () => botManager.shutdownAll(),
    sendMessage: (botId, message) => botManager.sendMessage(botId, message),
    
    // Status and info
    getBotStatus: (botId) => botManager.getBotStatus(botId),
    getAllBotStatuses: () => botManager.getAllBotStatuses(),
    getBotStats: (botId) => botManager.getBotStats(botId),
    
    // Socket.IO setup
    setSocketIO: (io) => botManager.setSocketIO(io)
};