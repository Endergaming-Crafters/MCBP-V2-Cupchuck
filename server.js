const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const fs = require('fs').promises;
const path = require('path');
const bodyParser = require('body-parser');
const cors = require('cors');

// Import bot controller
const botCtrl = require('./bot-control');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Configuration
const DATA_DIR = './data';
const VIEWS_DIR = './views';
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const USERS_PATH = path.join(DATA_DIR, 'users.json');
const ROLES_PATH = path.join(DATA_DIR, 'roles.json');
const BOTS_PATH = path.join(DATA_DIR, 'bots.json');
const QC_PATH = path.join(DATA_DIR, 'quick-commands.json');

// Middleware
app.use(bodyParser.json());
app.use(cors());
app.use(express.static('.')); // Serve static files from root

// Session storage
const sessions = {};

// Helper functions
async function loadJson(filePath) {
    try {
        const data = await fs.readFile(filePath, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            // File doesn't exist, return default
            if (filePath === QC_PATH || filePath === USERS_PATH) {
                return {};
            }
            return [];
        }
        throw error;
    }
}

async function saveJson(filePath, data) {
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

async function loadConfig() {
    try {
        const config = await loadJson(CONFIG_PATH);
        return config;
    } catch (error) {
        console.error('Failed to load config:', error);
        return { server: { port: 3000 }, theme: 'dark' };
    }
}

// Authentication middleware
function authMiddleware(req, res, next) {
    const token = req.headers['x-auth-token'];
    if (!token || !sessions[token]) {
        return res.status(401).json({ ok: false, message: 'Not authenticated' });
    }
    req.user = sessions[token];
    next();
}

// Permission middleware
function hasPermission(permission) {
    return (req, res, next) => {
        const user = req.user;
        
        // Admin with wildcard has all permissions
        if (user.permissions.includes('*')) {
            return next();
        }
        
        if (!user.permissions.includes(permission)) {
            return res.status(403).json({ 
                ok: false, 
                message: `Missing permission: ${permission}` 
            });
        }
        
        next();
    };
}

// Serve HTML pages
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, VIEWS_DIR, 'index.html'));
});

app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, VIEWS_DIR, 'dashboard.html'));
});

app.get('/bots', (req, res) => {
    res.sendFile(path.join(__dirname, VIEWS_DIR, 'bots.html'));
});

app.get('/bot-details', (req, res) => {
    res.sendFile(path.join(__dirname, VIEWS_DIR, 'bot-details.html'));
});

app.get('/users', (req, res) => {
    res.sendFile(path.join(__dirname, VIEWS_DIR, 'users.html'));
});

app.get('/roles', (req, res) => {
    res.sendFile(path.join(__dirname, VIEWS_DIR, 'roles.html'));
});

// API Routes

// Authentication
app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const users = await loadJson(USERS_PATH);
        
        if (!users[username] || users[username].password !== password) {
            return res.status(401).json({ 
                ok: false, 
                message: 'Invalid credentials' 
            });
        }
        
        // Load user's role and permissions
        const roles = await loadJson(ROLES_PATH);
        const userRole = roles.find(r => r.id === users[username].role);
        
        const token = Math.random().toString(36).substring(2) + 
                     Math.random().toString(36).substring(2);
        
        sessions[token] = {
            username,
            role: users[username].role,
            permissions: userRole ? userRole.permissions : [],
            level: userRole ? userRole.level : 0
        };
        
        // Update last login
        users[username].lastLogin = new Date().toISOString();
        await saveJson(USERS_PATH, users);
        
        res.json({
            ok: true,
            token,
            username,
            role: users[username].role,
            permissions: userRole ? userRole.permissions : []
        });
        
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ ok: false, message: 'Server error' });
    }
});

app.get('/api/verify', authMiddleware, (req, res) => {
    res.json({ ok: true, user: req.user });
});

// Config
app.get('/api/config', authMiddleware, async (req, res) => {
    try {
        const config = await loadConfig();
        res.json({ ok: true, config });
    } catch (error) {
        res.status(500).json({ ok: false, message: 'Failed to load config' });
    }
});

app.put('/api/config', authMiddleware, hasPermission('manage_settings'), async (req, res) => {
    try {
        const { theme, background } = req.body;
        const config = await loadConfig();
        
        if (theme) config.theme = theme;
        if (background) config.background = { ...config.background, ...background };
        
        await saveJson(CONFIG_PATH, config);
        res.json({ ok: true, config });
    } catch (error) {
        res.status(500).json({ ok: false, message: 'Failed to save config' });
    }
});

// Bots API
app.get('/api/bots', authMiddleware, hasPermission('view_bots'), async (req, res) => {
    try {
        const bots = await loadJson(BOTS_PATH);
        // Add status from bot controller
        const botsWithStatus = bots.map(bot => ({
            ...bot,
            status: botCtrl.getBotStatus(bot.id)
        }));
        res.json({ ok: true, bots: botsWithStatus });
    } catch (error) {
        res.status(500).json({ ok: false, message: 'Failed to load bots' });
    }
});

app.get('/api/bots/:id', authMiddleware, hasPermission('view_bots'), async (req, res) => {
    try {
        const bots = await loadJson(BOTS_PATH);
        const bot = bots.find(b => b.id === req.params.id);
        
        if (!bot) {
            return res.status(404).json({ ok: false, message: 'Bot not found' });
        }
        
        // Add status and stats
        bot.status = botCtrl.getBotStatus(bot.id);
        bot.stats = botCtrl.getBotStats(bot.id);
        
        res.json({ ok: true, bot });
    } catch (error) {
        res.status(500).json({ ok: false, message: 'Failed to load bot' });
    }
});

app.post('/api/bots', authMiddleware, hasPermission('create_bots'), async (req, res) => {
    try {
        const bots = await loadJson(BOTS_PATH);
        const newBot = {
            id: 'bot-' + Date.now(),
            ...req.body,
            created: new Date().toISOString(),
            lastStarted: null,
            lastStopped: null
        };
        
        bots.push(newBot);
        await saveJson(BOTS_PATH, bots);
        res.json({ ok: true, bot: newBot });
    } catch (error) {
        res.status(500).json({ ok: false, message: 'Failed to create bot' });
    }
});

app.put('/api/bots/:id', authMiddleware, hasPermission('edit_bots'), async (req, res) => {
    try {
        const bots = await loadJson(BOTS_PATH);
        const index = bots.findIndex(b => b.id === req.params.id);
        
        if (index === -1) {
            return res.status(404).json({ ok: false, message: 'Bot not found' });
        }
        
        // Update bot (keep password if not provided)
        if (!req.body.password) {
            delete req.body.password;
        }
        
        bots[index] = { ...bots[index], ...req.body, updated: new Date().toISOString() };
        await saveJson(BOTS_PATH, bots);
        
        res.json({ ok: true, bot: bots[index] });
    } catch (error) {
        res.status(500).json({ ok: false, message: 'Failed to update bot' });
    }
});

app.delete('/api/bots/:id', authMiddleware, hasPermission('delete_bots'), async (req, res) => {
    try {
        const bots = await loadJson(BOTS_PATH);
        const index = bots.findIndex(b => b.id === req.params.id);
        
        if (index === -1) {
            return res.status(404).json({ ok: false, message: 'Bot not found' });
        }
        
        // Stop bot if running
        botCtrl.stopBot(req.params.id);
        
        // Remove bot
        bots.splice(index, 1);
        await saveJson(BOTS_PATH, bots);
        
        res.json({ ok: true });
    } catch (error) {
        res.status(500).json({ ok: false, message: 'Failed to delete bot' });
    }
});

app.post('/api/bots/:id/start', authMiddleware, hasPermission('start_bots'), async (req, res) => {
    try {
        const bots = await loadJson(BOTS_PATH);
        const bot = bots.find(b => b.id === req.params.id);
        
        if (!bot) {
            return res.status(404).json({ ok: false, message: 'Bot not found' });
        }
        
        // Start bot
        botCtrl.startBot(bot, io);
        
        // Update last started
        bot.lastStarted = new Date().toISOString();
        await saveJson(BOTS_PATH, bots);
        
        res.json({ ok: true });
    } catch (error) {
        res.status(500).json({ ok: false, message: 'Failed to start bot' });
    }
});

app.post('/api/bots/:id/stop', authMiddleware, hasPermission('stop_bots'), async (req, res) => {
    try {
        const bots = await loadJson(BOTS_PATH);
        const bot = bots.find(b => b.id === req.params.id);
        
        if (!bot) {
            return res.status(404).json({ ok: false, message: 'Bot not found' });
        }
        
        // Stop bot
        botCtrl.stopBot(req.params.id);
        
        // Update last stopped
        bot.lastStopped = new Date().toISOString();
        await saveJson(BOTS_PATH, bots);
        
        res.json({ ok: true });
    } catch (error) {
        res.status(500).json({ ok: false, message: 'Failed to stop bot' });
    }
});

// Users API
app.get('/api/users', authMiddleware, hasPermission('view_users'), async (req, res) => {
    try {
        const users = await loadJson(USERS_PATH);
        res.json({ ok: true, users });
    } catch (error) {
        res.status(500).json({ ok: false, message: 'Failed to load users' });
    }
});

app.get('/api/users/:username', authMiddleware, hasPermission('view_users'), async (req, res) => {
    try {
        const users = await loadJson(USERS_PATH);
        const user = users[req.params.username];
        
        if (!user) {
            return res.status(404).json({ ok: false, message: 'User not found' });
        }
        
        res.json({ ok: true, user });
    } catch (error) {
        res.status(500).json({ ok: false, message: 'Failed to load user' });
    }
});

app.post('/api/users', authMiddleware, hasPermission('create_users'), async (req, res) => {
    try {
        const { username, password, role, protected: isProtected } = req.body;
        const users = await loadJson(USERS_PATH);
        
        if (users[username]) {
            return res.status(400).json({ ok: false, message: 'User already exists' });
        }
        
        // Verify role exists
        const roles = await loadJson(ROLES_PATH);
        const roleExists = roles.some(r => r.id === role);
        if (!roleExists) {
            return res.status(400).json({ ok: false, message: 'Invalid role' });
        }
        
        // Check if user can assign this role (based on level)
        const currentUserRole = roles.find(r => r.id === req.user.role);
        const targetRole = roles.find(r => r.id === role);
        
        if (currentUserRole && targetRole && currentUserRole.level <= targetRole.level) {
            return res.status(403).json({ 
                ok: false, 
                message: 'Cannot assign role with equal or higher level' 
            });
        }
        
        users[username] = {
            password,
            role,
            protected: !!isProtected,
            created: new Date().toISOString(),
            lastLogin: null
        };
        
        await saveJson(USERS_PATH, users);
        res.json({ ok: true });
    } catch (error) {
        res.status(500).json({ ok: false, message: 'Failed to create user' });
    }
});

app.put('/api/users/:username', authMiddleware, hasPermission('edit_users'), async (req, res) => {
    try {
        const username = req.params.username;
        const users = await loadJson(USERS_PATH);
        const roles = await loadJson(ROLES_PATH);
        
        if (!users[username]) {
            return res.status(404).json({ ok: false, message: 'User not found' });
        }
        
        // Check if user is protected
        if (users[username].protected) {
            return res.status(403).json({ ok: false, message: 'User is protected' });
        }
        
        // Check if current user can modify this user
        const currentUserRole = roles.find(r => r.id === req.user.role);
        const targetUserRole = roles.find(r => r.id === users[username].role);
        
        if (currentUserRole && targetUserRole && currentUserRole.level <= targetUserRole.level) {
            return res.status(403).json({ 
                ok: false, 
                message: 'Cannot modify user with equal or higher role level' 
            });
        }
        
        // Update user
        if (req.body.password) {
            users[username].password = req.body.password;
        }
        
        if (req.body.role) {
            // Verify new role exists and current user can assign it
            const newRole = roles.find(r => r.id === req.body.role);
            if (!newRole) {
                return res.status(400).json({ ok: false, message: 'Invalid role' });
            }
            
            if (currentUserRole && currentUserRole.level <= newRole.level) {
                return res.status(403).json({ 
                    ok: false, 
                    message: 'Cannot assign role with equal or higher level' 
                });
            }
            
            users[username].role = req.body.role;
        }
        
        await saveJson(USERS_PATH, users);
        res.json({ ok: true });
    } catch (error) {
        res.status(500).json({ ok: false, message: 'Failed to update user' });
    }
});

app.delete('/api/users/:username', authMiddleware, hasPermission('delete_users'), async (req, res) => {
    try {
        const username = req.params.username;
        const users = await loadJson(USERS_PATH);
        
        if (!users[username]) {
            return res.status(404).json({ ok: false, message: 'User not found' });
        }
        
        // Check if user is protected
        if (users[username].protected) {
            return res.status(403).json({ ok: false, message: 'User is protected' });
        }
        
        // Cannot delete yourself
        if (username === req.user.username) {
            return res.status(403).json({ ok: false, message: 'Cannot delete yourself' });
        }
        
        // Check role hierarchy
        const roles = await loadJson(ROLES_PATH);
        const currentUserRole = roles.find(r => r.id === req.user.role);
        const targetUserRole = roles.find(r => r.id === users[username].role);
        
        if (currentUserRole && targetUserRole && currentUserRole.level <= targetUserRole.level) {
            return res.status(403).json({ 
                ok: false, 
                message: 'Cannot delete user with equal or higher role level' 
            });
        }
        
        delete users[username];
        await saveJson(USERS_PATH, users);
        res.json({ ok: true });
    } catch (error) {
        res.status(500).json({ ok: false, message: 'Failed to delete user' });
    }
});

// Roles API
app.get('/api/roles', authMiddleware, hasPermission('manage_roles'), async (req, res) => {
    try {
        const roles = await loadJson(ROLES_PATH);
        res.json({ ok: true, roles });
    } catch (error) {
        res.status(500).json({ ok: false, message: 'Failed to load roles' });
    }
});

app.get('/api/roles/:id', authMiddleware, hasPermission('manage_roles'), async (req, res) => {
    try {
        const roles = await loadJson(ROLES_PATH);
        const role = roles.find(r => r.id === req.params.id);
        
        if (!role) {
            return res.status(404).json({ ok: false, message: 'Role not found' });
        }
        
        res.json({ ok: true, role });
    } catch (error) {
        res.status(500).json({ ok: false, message: 'Failed to load role' });
    }
});

app.post('/api/roles', authMiddleware, hasPermission('manage_roles'), async (req, res) => {
    try {
        const { name, level, description, permissions, protected: isProtected } = req.body;
        const roles = await loadJson(ROLES_PATH);
        
        // Check if role already exists
        if (roles.some(r => r.id === name.toLowerCase().replace(/[^a-z0-9]/g, '_'))) {
            return res.status(400).json({ ok: false, message: 'Role already exists' });
        }
        
        // Check current user's level
        const currentUserRole = roles.find(r => r.id === req.user.role);
        if (currentUserRole && level >= currentUserRole.level) {
            return res.status(403).json({ 
                ok: false, 
                message: 'Cannot create role with level equal or higher than yours' 
            });
        }
        
        const newRole = {
            id: name.toLowerCase().replace(/[^a-z0-9]/g, '_'),
            name,
            level: parseInt(level),
            description: description || '',
            permissions: permissions || [],
            protected: !!isProtected
        };
        
        roles.push(newRole);
        await saveJson(ROLES_PATH, roles);
        res.json({ ok: true, role: newRole });
    } catch (error) {
        res.status(500).json({ ok: false, message: 'Failed to create role' });
    }
});

app.put('/api/roles/:id', authMiddleware, hasPermission('manage_roles'), async (req, res) => {
    try {
        const roleId = req.params.id;
        const roles = await loadJson(ROLES_PATH);
        const index = roles.findIndex(r => r.id === roleId);
        
        if (index === -1) {
            return res.status(404).json({ ok: false, message: 'Role not found' });
        }
        
        // Check if role is protected
        if (roles[index].protected) {
            return res.status(403).json({ ok: false, message: 'Role is protected' });
        }
        
        // Check current user's level
        const currentUserRole = roles.find(r => r.id === req.user.role);
        if (currentUserRole && roles[index].level >= currentUserRole.level) {
            return res.status(403).json({ 
                ok: false, 
                message: 'Cannot modify role with level equal or higher than yours' 
            });
        }
        
        // Update role
        if (req.body.level !== undefined) {
            const newLevel = parseInt(req.body.level);
            if (currentUserRole && newLevel >= currentUserRole.level) {
                return res.status(403).json({ 
                    ok: false, 
                    message: 'Cannot set level equal or higher than yours' 
                });
            }
            roles[index].level = newLevel;
        }
        
        if (req.body.name !== undefined) {
            roles[index].name = req.body.name;
        }
        
        if (req.body.description !== undefined) {
            roles[index].description = req.body.description;
        }
        
        if (req.body.permissions !== undefined) {
            roles[index].permissions = req.body.permissions;
        }
        
        await saveJson(ROLES_PATH, roles);
        res.json({ ok: true, role: roles[index] });
    } catch (error) {
        res.status(500).json({ ok: false, message: 'Failed to update role' });
    }
});

app.delete('/api/roles/:id', authMiddleware, hasPermission('manage_roles'), async (req, res) => {
    try {
        const roleId = req.params.id;
        const roles = await loadJson(ROLES_PATH);
        const index = roles.findIndex(r => r.id === roleId);
        
        if (index === -1) {
            return res.status(404).json({ ok: false, message: 'Role not found' });
        }
        
        // Check if role is protected
        if (roles[index].protected) {
            return res.status(403).json({ ok: false, message: 'Role is protected' });
        }
        
        // Check current user's level
        const currentUserRole = roles.find(r => r.id === req.user.role);
        if (currentUserRole && roles[index].level >= currentUserRole.level) {
            return res.status(403).json({ 
                ok: false, 
                message: 'Cannot delete role with level equal or higher than yours' 
            });
        }
        
        // Check if role is in use
        const users = await loadJson(USERS_PATH);
        const usersWithRole = Object.values(users).filter(u => u.role === roleId);
        
        if (usersWithRole.length > 0) {
            // Reassign users to viewer role
            for (const [username, user] of Object.entries(users)) {
                if (user.role === roleId) {
                    user.role = 'viewer';
                }
            }
            await saveJson(USERS_PATH, users);
        }
        
        // Remove role
        roles.splice(index, 1);
        await saveJson(ROLES_PATH, roles);
        
        res.json({ ok: true, affectedUsers: usersWithRole.length });
    } catch (error) {
        res.status(500).json({ ok: false, message: 'Failed to delete role' });
    }
});

app.get('/api/roles/:id/users', authMiddleware, hasPermission('manage_roles'), async (req, res) => {
    try {
        const users = await loadJson(USERS_PATH);
        const count = Object.values(users).filter(u => u.role === req.params.id).length;
        res.json({ ok: true, count });
    } catch (error) {
        res.status(500).json({ ok: false, message: 'Failed to count users' });
    }
});

// Permissions API
app.get('/api/permissions', authMiddleware, async (req, res) => {
    // Return all available permissions
    const permissions = [
        // Bot Operations
        'view_bots', 'start_bots', 'stop_bots', 'create_bots', 'delete_bots', 'edit_bots',
        // User Management
        'view_users', 'create_users', 'edit_users', 'delete_users',
        // Role Management
        'manage_roles', 'assign_roles',
        // Quick Commands
        'create_qc', 'edit_qc', 'delete_qc', 'use_qc',
        // Chat/Console
        'view_console', 'send_messages', 'execute_commands',
        // System/UI
        'change_theme', 'view_logs', 'manage_settings'
    ];
    
    res.json({ ok: true, permissions });
});

// Bot-specific Quick Commands API
app.get('/api/bots/:botId/quick-commands', authMiddleware, async (req, res) => {
    try {
        const qcs = await loadJson(QC_PATH);
        const userQCs = qcs[req.user.username] || [];
        
        // Filter QCs for this specific bot
        const botQCs = userQCs.filter(qc => qc.botId === req.params.botId);
        
        res.json({ ok: true, commands: botQCs });
    } catch (error) {
        res.status(500).json({ ok: false, message: 'Failed to load quick commands' });
    }
});

app.post('/api/bots/:botId/quick-commands', authMiddleware, hasPermission('create_qc'), async (req, res) => {
    try {
        const { name, command } = req.body;
        const qcs = await loadJson(QC_PATH);
        
        if (!qcs[req.user.username]) {
            qcs[req.user.username] = [];
        }
        
        const newQC = {
            id: 'qc-' + Date.now(),
            name,
            command,
            botId: req.params.botId,
            created: new Date().toISOString(),
            createdBy: req.user.username
        };
        
        qcs[req.user.username].push(newQC);
        await saveJson(QC_PATH, qcs);
        res.json({ ok: true, command: newQC });
    } catch (error) {
        res.status(500).json({ ok: false, message: 'Failed to create quick command' });
    }
});

app.put('/api/bots/:botId/quick-commands/:qcId', authMiddleware, hasPermission('edit_qc'), async (req, res) => {
    try {
        const { name, command } = req.body;
        const qcs = await loadJson(QC_PATH);
        const userQCs = qcs[req.user.username] || [];
        
        const index = userQCs.findIndex(qc => qc.id === req.params.qcId && qc.botId === req.params.botId);
        if (index === -1) {
            return res.status(404).json({ ok: false, message: 'Quick command not found' });
        }
        
        userQCs[index].name = name;
        userQCs[index].command = command;
        userQCs[index].updated = new Date().toISOString();
        
        qcs[req.user.username] = userQCs;
        await saveJson(QC_PATH, qcs);
        
        res.json({ ok: true, command: userQCs[index] });
    } catch (error) {
        res.status(500).json({ ok: false, message: 'Failed to update quick command' });
    }
});

app.delete('/api/bots/:botId/quick-commands/:qcId', authMiddleware, hasPermission('delete_qc'), async (req, res) => {
    try {
        const qcs = await loadJson(QC_PATH);
        const userQCs = qcs[req.user.username] || [];
        
        const index = userQCs.findIndex(qc => qc.id === req.params.qcId && qc.botId === req.params.botId);
        if (index === -1) {
            return res.status(404).json({ ok: false, message: 'Quick command not found' });
        }
        
        userQCs.splice(index, 1);
        qcs[req.user.username] = userQCs;
        await saveJson(QC_PATH, qcs);
        
        res.json({ ok: true });
    } catch (error) {
        res.status(500).json({ ok: false, message: 'Failed to delete quick command' });
    }
});

app.post('/api/bots/:botId/quick-commands/:qcId/execute', authMiddleware, hasPermission('use_qc'), async (req, res) => {
    try {
        const qcs = await loadJson(QC_PATH);
        const userQCs = qcs[req.user.username] || [];
        
        const qc = userQCs.find(q => q.id === req.params.qcId && q.botId === req.params.botId);
        if (!qc) {
            return res.status(404).json({ ok: false, message: 'Quick command not found' });
        }
        
        // Send command through bot
        botCtrl.sendMessage(req.params.botId, qc.command);
        res.json({ ok: true });
    } catch (error) {
        res.status(500).json({ ok: false, message: 'Failed to execute command' });
    }
});

// Global Quick Commands API (for backward compatibility)
app.get('/api/quick-commands', authMiddleware, async (req, res) => {
    try {
        const qcs = await loadJson(QC_PATH);
        const userQCs = qcs[req.user.username] || [];
        res.json({ ok: true, commands: userQCs });
    } catch (error) {
        res.status(500).json({ ok: false, message: 'Failed to load quick commands' });
    }
});

app.post('/api/quick-commands', authMiddleware, hasPermission('create_qc'), async (req, res) => {
    try {
        const { name, command, botId } = req.body;
        const qcs = await loadJson(QC_PATH);
        
        if (!qcs[req.user.username]) {
            qcs[req.user.username] = [];
        }
        
        const newQC = {
            id: 'qc-' + Date.now(),
            name,
            command,
            botId: botId || 'global',
            created: new Date().toISOString(),
            createdBy: req.user.username
        };
        
        qcs[req.user.username].push(newQC);
        await saveJson(QC_PATH, qcs);
        res.json({ ok: true, command: newQC });
    } catch (error) {
        res.status(500).json({ ok: false, message: 'Failed to create quick command' });
    }
});

app.delete('/api/quick-commands/:id', authMiddleware, hasPermission('delete_qc'), async (req, res) => {
    try {
        const qcs = await loadJson(QC_PATH);
        const userQCs = qcs[req.user.username] || [];
        
        const index = userQCs.findIndex(qc => qc.id === req.params.id);
        if (index === -1) {
            return res.status(404).json({ ok: false, message: 'Quick command not found' });
        }
        
        userQCs.splice(index, 1);
        qcs[req.user.username] = userQCs;
        await saveJson(QC_PATH, qcs);
        
        res.json({ ok: true });
    } catch (error) {
        res.status(500).json({ ok: false, message: 'Failed to delete quick command' });
    }
});

app.post('/api/quick-commands/:id/execute', authMiddleware, hasPermission('use_qc'), async (req, res) => {
    try {
        const { botId } = req.body;
        const qcs = await loadJson(QC_PATH);
        const userQCs = qcs[req.user.username] || [];
        
        const qc = userQCs.find(q => q.id === req.params.id);
        if (!qc) {
            return res.status(404).json({ ok: false, message: 'Quick command not found' });
        }
        
        // Send command through bot
        const targetBotId = botId || qc.botId;
        if (targetBotId === 'global') {
            return res.status(400).json({ ok: false, message: 'Bot ID required' });
        }
        
        botCtrl.sendMessage(targetBotId, qc.command);
        res.json({ ok: true });
    } catch (error) {
        res.status(500).json({ ok: false, message: 'Failed to execute command' });
    }
});

// Chat API
app.post('/api/chat', authMiddleware, hasPermission('send_messages'), async (req, res) => {
    try {
        const { message, botId } = req.body;
        
        if (!botId) {
            return res.status(400).json({ ok: false, message: 'Bot ID required' });
        }
        
        botCtrl.sendMessage(botId, message);
        res.json({ ok: true });
    } catch (error) {
        res.status(500).json({ ok: false, message: 'Failed to send message' });
    }
});

// Socket.IO
io.on('connection', (socket) => {
    const token = socket.handshake.auth.token;
    
    if (!token || !sessions[token]) {
        socket.disconnect();
        return;
    }
    
    const user = sessions[token];
    socket.user = user;
    
    // Send initial bot statuses
    const botStatuses = botCtrl.getAllBotStatuses();
    socket.emit('bot-statuses', botStatuses);
    
    // Handle bot status requests
    socket.on('request-bot-status', (data) => {
        const status = botCtrl.getBotStatus(data.botId);
        socket.emit('bot-status', { botId: data.botId, ...status });
    });
    
    // Handle disconnect
    socket.on('disconnect', () => {
        // Clean up if needed
    });
});

// Health check
app.get('/health', (req, res) => {
    res.json({ ok: true, status: 'healthy', timestamp: new Date().toISOString() });
});

// Error handling
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ ok: false, message: 'Internal server error' });
});

// Start server
async function startServer() {
    try {
        // Ensure data directory exists
        try {
            await fs.access(DATA_DIR);
        } catch {
            await fs.mkdir(DATA_DIR, { recursive: true });
        }
        
        // Ensure required files exist
        const requiredFiles = [
            { path: CONFIG_PATH, default: { server: { port: 3000 }, theme: 'dark' } },
            { path: USERS_PATH, default: {} },
            { path: ROLES_PATH, default: [] },
            { path: BOTS_PATH, default: [] },
            { path: QC_PATH, default: {} }
        ];
        
        for (const file of requiredFiles) {
            try {
                await fs.access(file.path);
            } catch {
                await saveJson(file.path, file.default);
            }
        }
        
        const config = await loadConfig();
        const port = config.server.port || 3000;
        
        // Initialize bot controller with Socket.IO
        botCtrl.setSocketIO(io);
        
        server.listen(port, () => {
            console.log(`🚀 MCBP V2 "Cupchuck" server listening on port ${port}`);
            console.log(`📁 Data directory: ${path.resolve(DATA_DIR)}`);
            console.log(`🌐 Web interface: http://localhost:${port}`);
        });
        
    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('Shutting down...');
    botCtrl.shutdownAll();
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});

startServer();