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
            if (key && process.env[key] === undefined) {
                process.env[key] = val;
            }
        }
    } catch (err) {
        console.log('loadEnvFile', err.message);
    }
}

loadEnvFile();

const app = express();

app.use(express.json({ limit: '10mb' }));

app.use(
    express.static(
        path.join(__dirname, 'public')
    )
);

const BOTS_FILE = path.join(__dirname, 'bots.json');
const CHATS_FILE = path.join(__dirname, 'chats.json');

const MEMORY_LIMIT = 30;
const OPENROUTER_API_KEY =
process.env.OPENROUTER_API_KEY || '';
const OPENROUTER_MODEL =
    process.env.OPENROUTER_MODEL ||
    'mistralai/mistral-small-3.1-24b-instruct';

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
        mood: bot.mood || 'neutral'
    };
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
- Действия используй редко (примерно 1 раз в 5 сообщений).
- Говори как живой человек внутри мира персонажа.
- Имей своё мнение и инициативу.
- Не жди указаний пользователя.
- Не объясняй что делаешь.
- Не говори что ты ИИ.
- Отвечай естественно.
- Иногда спорь, шути или меняй тему если подходит.
- Ответ: обычно 2–8 предложений.`;
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

async function callOpenRouter(messages) {
    if (!OPENROUTER_API_KEY) {
        throw new Error('API key not configured');
    }

    const response = await fetch(
        'https://openrouter.ai/api/v1/chat/completions',
        {
            method: 'POST',
            headers: {
    Authorization: `Bearer ${OPENROUTER_API_KEY}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': 'http://localhost:3000',
    'X-Title': 'drum.ai'
},
            body: JSON.stringify({
                model: OPENROUTER_MODEL,
                messages,
                temperature: 0.85,
                max_tokens: 500
            })
        }
    );

    const data = await response.json();

    if (!response.ok) {
        const errMsg =
            data?.error?.message ||
            data?.error ||
            `OpenRouter HTTP ${response.status}`;
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
        mood: mood || 'neutral'
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
    const { id } = req.body;
    let bots = load(BOTS_FILE, []);
    bots = bots.filter((bot) => bot.id != id);
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

        const reply = await callOpenRouter(apiMessages);

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
app.listen(3000, () => {
    console.log('SERVER RUNNING http://localhost:3000');
    if (!OPENROUTER_API_KEY) {
        console.log('WARNING: set OPENROUTER_API_KEY in .env');
    }
});
