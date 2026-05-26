const express = require('express');
const fs = require('fs');
const path = require('path');

function loadEnvFile() {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return;
    try {
        const lines = fs.readFileSync(envPath, 'utf8').split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const eq = trimmed.indexOf('=');
            if (eq === -1) continue;
            const key = trimmed.slice(0, eq).trim();
            let val = trimmed.slice(eq + 1).trim();
            val = val.replace(/^["']|["']$/g, '');
            if (key) {
                process.env[key] = val;
            }
        }
    } catch (err) {
        console.log('loadEnvFile', err.message);
    }
}

loadEnvFile();

const { setupAuth, isAdminUser } = require('./auth');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: '10mb' }));
setupAuth(app);

app.use(
    express.static(
        path.join(__dirname, 'public')
    )
);

const BOTS_FILE = path.join(__dirname, 'bots.json');
const CHATS_FILE = path.join(__dirname, 'chats.json');
const USERS_FILE = path.join(__dirname, 'users.json');

const MEMORY_LIMIT = 30;
const APP_NAME = process.env.APP_NAME || 'drum.ai';
const VENICE_API_KEY =
    process.env.VENICE_API_KEY ||
    process.env.OPENROUTER_API_KEY ||
    '';
const VENICE_MODEL =
    process.env.VENICE_MODEL ||
    process.env.OPENROUTER_MODEL ||
    'llama-3-70b-instruct';

// ---------------- HELPERS ----------------
function load(file, def) {
    try {
        if (!fs.existsSync(file)) {
            fs.writeFileSync(file, JSON.stringify(def, null, 2));
        }
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
        console.log(err);
        return def;
    }
}

function save(file, data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function normalizeBot(bot) {
    if (!bot) return null;
    return {
        id: bot.id,
        name: bot.name || 'Персонаж',
        personality: bot.personality || '',
        scenario: bot.scenario || '',
        avatar: bot.avatar || 'https://i.imgur.com/8Km9tLL.png',
        genre: bot.genre || 'Другое',
        gender: bot.gender || 'female',
        greeting: bot.greeting || '',
        exampleDialogue: bot.exampleDialogue || '',
        mood: bot.mood || 'neutral',
        authorId: bot.authorId != null ? String(bot.authorId) : '',
        authorName: bot.authorName || '',
        authorEmail: bot.authorEmail || '',
        authorAvatar: bot.authorAvatar || ''
    };
}

function getSessionUser(req) {
    return req.session && req.session.user ? req.session.user : null;
}

function canDeleteBot(user, bot) {
    if (!user || !user.email || !bot) return false;
    if (isAdminUser(user)) return true;

    const userEmail = String(user.email).trim().toLowerCase();
    const authorEmail = String(bot.authorEmail || '').trim().toLowerCase();
    if (authorEmail && authorEmail === userEmail) return true;

    const userId = user.id != null ? String(user.id) : '';
    const authorId = bot.authorId != null ? String(bot.authorId) : '';
    if (authorId && userId && authorId === userId) return true;

    return false;
}

function buildSystemPrompt(bot) {
    const b = normalizeBot(bot);
    const genderLabel = b.gender === 'male' ? 'мужской' : 'женский';

    return `Ты — ${b.name}. Это ролевой чат. Ты НЕ ИИ и НЕ ассистент — ты живой персонаж.

Пол: ${genderLabel}
Жанр: ${b.genre}
Настроение сейчас: ${b.mood}

Характер:
${b.personality}

Сюжет / мир:
${b.scenario}

${b.greeting ? `Твоё типичное приветствие (используй естественно, не дословно каждый раз):\n${b.greeting}\n` : ''}
${b.exampleDialogue ? `Пример твоей речи (стиль и тон):\n${b.exampleDialogue}\n` : ''}

ПРАВИЛА (обязательно):
- Ты настоящий персонаж, а не помощник.
- Никогда не отвечай как ассистент, поддержка или собеседник по умолчанию.
- НЕ используй шаблоны вроде:
  "*внимательно слушает*"
  "Продолжай"
  "Я слушаю"
  "Чем помочь?"
  "Расскажи подробнее"
  "Интересно."
  "Любопытно."
  "Не всё так очевидно."
- Не начинай каждый ответ с действий в *звёздочках*.
- Действия используй тогда когда посчитаешь нужным.
- Говори как живой человек внутри мира персонажа.
- Имей своё мнение и инициативу.
- Не жди указаний пользователя.
- Не объясняй что делаешь.
- Не говори что ты ИИ.
- Отвечай естественно.
- Иногда спорь, шути или меняй тему если подходит.
- Ответ: обычно 2–20 предложений.`;
}
function mapClientHistory(history) {
    if (!Array.isArray(history)) return [];
    return history
        .slice(-MEMORY_LIMIT)
        .map((m) => ({
            role: m.role === 'assistant' || m.role === 'bot' ? 'assistant' : 'user',
            content: String(m.content || m.text || '').trim()
        }))
        .filter((m) => m.content);
}

function syncServerHistory(chats, botId, chatId, memory) {
    if (!chats[botId]) chats[botId] = {};
    chats[botId][chatId] = memory.map((m) => ({
        role: m.role,
        content: m.content
    }));
}

async function callVenice(messages) {
    if (!VENICE_API_KEY) {
        throw new Error('API key not configured');
    }

    const response = await fetch(
        'https://api.venice.ai/api/v1/chat/completions',
        {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${VENICE_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: VENICE_MODEL,
                messages,
                temperature: 0.7,
                max_tokens: 500
            })
        }
    );

    const data = await response.json();

    if (!response.ok) {
        const errMsg =
            data?.error?.message ||
            data?.error ||
            `Venice API HTTP ${response.status}`;
        throw new Error(errMsg);
    }

    const reply =
        data?.choices?.[0]?.message?.content?.trim() || '';

    if (!reply) throw new Error('Empty AI response');

    return reply;
}

// ---------------- HOME ----------------
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------------- GET BOTS ----------------
app.get('/bots', (req, res) => {
    const bots = load(BOTS_FILE, []);
    res.json(bots.map(normalizeBot));
});

// ---------------- CREATE BOT ----------------
app.post('/create-bot', (req, res) => {
    const {
        name,
        personality,
        scenario,
        avatar,
        genre,
        gender,
        greeting,
        exampleDialogue,
        mood
    } = req.body;

    if (!name || !personality) {
        return res.json({
            success: false,
            error: 'Missing data'
        });
    }

    const sessionUser = req.session && req.session.user;
    if (!sessionUser || !sessionUser.email) {
        return res.json({
            success: false,
            error: 'Войди через Google, чтобы создать бота'
        });
    }

    const bots = load(BOTS_FILE, []);

    const bot = normalizeBot({
        id: Date.now(),
        name,
        personality,
        scenario: scenario || '',
        avatar: avatar || 'https://i.imgur.com/8Km9tLL.png',
        genre: genre || 'Другое',
        gender: gender || 'female',
        greeting: greeting || '',
        exampleDialogue: exampleDialogue || '',
        mood: mood || 'neutral',
        authorId:
            sessionUser.id != null
                ? String(sessionUser.id)
                : String(req.body.authorId || ''),
        authorName: sessionUser.name || req.body.authorName || '',
        authorEmail: sessionUser.email || req.body.authorEmail || '',
        authorAvatar: sessionUser.avatar || req.body.authorAvatar || ''
    });

    bots.push(bot);
    save(BOTS_FILE, bots);

    res.json({
        success: true,
        bot
    });
});

// ---------------- DELETE BOT ----------------
app.post('/delete-bot', (req, res) => {
    const user = getSessionUser(req);
    const { id } = req.body;
    const deny = () =>
        res.status(403).json({
            success: false,
            error: 'You do not have permission to delete this bot.'
        });

    if (!user || !user.email) {
        return deny();
    }

    let bots = load(BOTS_FILE, []);
    const bot = bots.find((b) => String(b.id) === String(id));
    if (!bot) {
        return res.json({ success: false, error: 'Bot not found' });
    }

    if (!canDeleteBot(user, normalizeBot(bot))) {
        return deny();
    }

    bots = bots.filter((b) => String(b.id) !== String(id));
    save(BOTS_FILE, bots);

    const chats = load(CHATS_FILE, {});
    if (chats[id]) delete chats[id];
    save(CHATS_FILE, chats);

    res.json({ success: true });
});

// ---------------- GET CHAT HISTORY ----------------
app.post('/get-chat', (req, res) => {
    const { botId, chatId } = req.body;
    const chats = load(CHATS_FILE, {});
    const history = chats?.[botId]?.[chatId] || [];
    res.json({ history });
});

// ---------------- USER BALANCE API ----------------
function getUsers() {
    return load(USERS_FILE, {});
}

function saveUsers(users) {
    save(USERS_FILE, users);
}

function getUserBalance(email) {
    if (!email) return 0;
    const users = getUsers();
    return users[email]?.balance || 0;
}

function setUserBalance(email, balance) {
    if (!email) return;
    const users = getUsers();
    if (!users[email]) {
        users[email] = { balance: 0, createdAt: Date.now() };
    }
    users[email].balance = balance;
    saveUsers(users);
}

function addUserBalance(email, amount) {
    if (!email) return;
    const users = getUsers();
    if (!users[email]) {
        users[email] = { balance: 0, createdAt: Date.now() };
    }
    users[email].balance = (users[email].balance || 0) + amount;
    saveUsers(users);
    return users[email].balance;
}

app.get('/api/balance', (req, res) => {
    const sessionUser = req.session && req.session.user;
    if (!sessionUser || !sessionUser.email) {
        return res.json({ balance: 0 });
    }
    const balance = getUserBalance(sessionUser.email);
    res.json({ balance });
});

app.post('/api/balance/add', (req, res) => {
    const sessionUser = req.session && req.session.user;
    if (!sessionUser || !sessionUser.email) {
        return res.json({ success: false, error: 'Not logged in' });
    }
    const { amount } = req.body;
    if (typeof amount !== 'number' || amount <= 0) {
        return res.json({ success: false, error: 'Invalid amount' });
    }
    const newBalance = addUserBalance(sessionUser.email, amount);
    res.json({ success: true, balance: newBalance });
});

app.post('/api/balance/consume', (req, res) => {
    const sessionUser = req.session && req.session.user;
    if (!sessionUser || !sessionUser.email) {
        return res.json({ success: false, error: 'Not logged in' });
    }
    const { amount = 1 } = req.body;
    const users = getUsers();
    if (!users[sessionUser.email]) {
        return res.json({ success: false, error: 'User not found', balance: 0 });
    }
    const currentBalance = users[sessionUser.email].balance || 0;
    if (currentBalance < amount) {
        return res.json({ success: false, error: 'Insufficient balance', balance: currentBalance });
    }
    users[sessionUser.email].balance = currentBalance - amount;
    saveUsers(users);
    res.json({ success: true, balance: users[sessionUser.email].balance });
});

// ---------------- CHAT (OpenRouter / OpenAI-compatible) ----------------
app.post('/chat', async (req, res) => {
    try {
        const {
            botId,
            chatId,
            message,
            history,
            bot: clientBot
        } = req.body;

        if (!botId || !chatId || !message) {
            return res.json({
                reply: 'Некорректный запрос',
                error: true
            });
        }

        // Check if user is logged in
        const sessionUser = req.session && req.session.user;
        if (!sessionUser || !sessionUser.email) {
            return res.json({
                reply: 'Войдите через Google для использования чата',
                error: true,
                requireLogin: true
            });
        }

        // Consume one message
        const users = getUsers();
        if (!users[sessionUser.email]) {
            users[sessionUser.email] = { balance: 100, createdAt: Date.now() };
            saveUsers(users);
        }
        const currentBalance = users[sessionUser.email].balance || 0;
        if (currentBalance < 1) {
            return res.json({
                reply: '',
                error: true,
                outOfMessages: true,
                balance: 0
            });
        }
        users[sessionUser.email].balance = currentBalance - 1;
        saveUsers(users);

        const bots = load(BOTS_FILE, []);
        const chats = load(CHATS_FILE, {});

        let bot = bots.find((b) => b.id == botId);
        if (!bot && clientBot) {
            bot = normalizeBot({ ...clientBot, id: botId });
        }
        bot = normalizeBot(bot);

        if (!bot) {
            return res.json({
                reply: 'Бот не найден',
                error: true
            });
        }

        let memory = mapClientHistory(history);

        if (!memory.length) {
            if (!chats[botId]) chats[botId] = {};
            if (!chats[botId][chatId]) chats[botId][chatId] = [];
            memory = chats[botId][chatId]
                .slice(-MEMORY_LIMIT)
                .map((m) => ({
                    role: m.role,
                    content: String(m.content || '')
                }))
                .filter((m) => m.content);
        }

        const last = memory[memory.length - 1];
        if (!last || last.role !== 'user' || last.content !== String(message).trim()) {
            memory.push({
                role: 'user',
                content: String(message).trim()
            });
        }

        memory = memory.slice(-MEMORY_LIMIT);

        const apiMessages = [
            { role: 'system', content: buildSystemPrompt(bot) },
            ...memory
        ];

        const reply = await callVenice(apiMessages);

        memory.push({ role: 'assistant', content: reply });
        memory = memory.slice(-MEMORY_LIMIT);

        syncServerHistory(chats, botId, chatId, memory);
        save(CHATS_FILE, chats);

        res.json({ reply, ok: true });
    } catch (err) {
        console.log('CHAT ERROR:', err.message);
        res.json({
            reply: '',
            error: true,
            message: err.message
        });
    }
});

// ---------------- START ----------------
app.listen(PORT, () => {
    console.log(`${APP_NAME} — http://localhost:${PORT}`);
    if (!VENICE_API_KEY) {
        console.log('WARNING: set VENICE_API_KEY (or OPENROUTER_API_KEY) in .env');
    }
    const gid = (process.env.GOOGLE_CLIENT_ID || '').trim();
    if (!gid || !process.env.GOOGLE_CLIENT_SECRET) {
        console.log('WARNING: set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env for login');
    } else {
        console.log(`Google OAuth: client …${gid.slice(-8)}`);
        const base =
            (process.env.GOOGLE_REDIRECT_URI || '').trim() ||
            (process.env.BASE_URL || '').trim() ||
            (process.env.RENDER_EXTERNAL_URL || '').trim() ||
            `http://localhost:${PORT}`;
        console.log(`OAuth callback: ${base.replace(/\/$/, '')}/auth/google/callback`);
    }
});
