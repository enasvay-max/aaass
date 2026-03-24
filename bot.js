require('dotenv').config();

const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const GoalBlock = goals.GoalBlock;
const http = require('http');
const socketIO = require('socket.io');
const express = require('express');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');

// ============= GROQ AI INTEGRATION =============
const Groq = require('groq-sdk');
const groq = new Groq({ apiKey: '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' });

// ============= TELEGRAM BOT INTEGRATION =============
const TelegramBot = require('node-telegram-bot-api');
let telegramBot = null;
let discordClient = null;

// ============= PARSE CLI ARGS =============
function parseArgs() {
  const args = process.argv.slice(2);
  
  let serverIp = process.env.SERVER_IP || 'localhost';
  let serverPort = parseInt(process.env.SERVER_PORT) || 25565;
  let botCount = 1;
  let webPort = parseInt(process.env.WEB_PORT) || 3000;
  
  if (args.length > 0 && !args[0].startsWith('-')) {
    const ipPort = args[0];
    if (ipPort.includes(':')) {
      const parts = ipPort.split(':');
      serverIp = parts[0];
      serverPort = parseInt(parts[1]) || 25565;
    } else {
      serverIp = ipPort;
    }
  }
  
  if (args.length > 1 && !args[1].startsWith('-')) {
    const count = parseInt(args[1]);
    if (count > 0) botCount = Math.min(count, 100);
  }

  if (args.length > 2 && !args[2].startsWith('-')) {
    const port = parseInt(args[2]);
    if (port > 0 && port < 65536) webPort = port;
  }
  
  return { serverIp, serverPort, botCount, webPort };
}

const { serverIp, serverPort, botCount, webPort } = parseArgs();

// ============= GLOBAL STATE =============
const botsMap = new Map();
const botStates = new Map();
const chatLog = [];
const activityLog = [];
const maxLogSize = 5000;
let messageTriggers = [];
let botGroups = new Map();
let waypoints = new Map();
let combatStats = { kills: 0, deaths: 0, hits: 0, crits: 0, dps: 0 };
let protectedPlayers = new Map(); // Кто под защитой телохранителей
let accountPool = []; // Ротация аккаунтов
let learningData = new Map(); // Машинное обучение
let exploredTerritory = new Set(); // Исследованная территория
let battleLog = []; // Лог боев
let tradeOffers = new Map(); // Торговые предложения
let playerMessages = new Map(); // Для анти-спама

// Загрузка данных
function loadData() {
    try {
        if (fs.existsSync('accounts.json')) {
            accountPool = JSON.parse(fs.readFileSync('accounts.json', 'utf8'));
            console.log(`📋 Загружено ${accountPool.length} аккаунтов`);
        }
        if (fs.existsSync('learning.json')) {
            learningData = new Map(Object.entries(JSON.parse(fs.readFileSync('learning.json', 'utf8'))));
            console.log(`🧠 Загружено ${learningData.size} записей обучения`);
        }
        if (fs.existsSync('explored.json')) {
            exploredTerritory = new Set(JSON.parse(fs.readFileSync('explored.json', 'utf8')));
        }
    } catch (err) {}
}

function saveAccounts() { fs.writeFileSync('accounts.json', JSON.stringify(accountPool, null, 2)); }
function saveLearning() { fs.writeFileSync('learning.json', JSON.stringify(Object.fromEntries(learningData), null, 2)); }
function saveExplored() { fs.writeFileSync('explored.json', JSON.stringify(Array.from(exploredTerritory), null, 2)); }

// ============= AI ASSISTANT =============
const aiContext = {
  system: `Ты - игровой бот в Minecraft. Твоя задача: общаться с игроками, 
           отвечать на вопросы, быть дружелюбным. Твое имя: {botname}. 
           Отвечай кратко, по делу, на русском языке. 
           Ты можешь: приветствовать, прощаться, отвечать на вопросы о игре,
           рассказывать шутки, помогать новичкам, знать правила сервера.
           Не спамь, не флуди. Будь позитивным!`
};

async function getAIResponse(message, botName, playerName) {
  try {
    const completion = await groq.chat.completions.create({
      messages: [
        { role: "system", content: aiContext.system.replace('{botname}', botName) },
        { role: "user", content: `Игрок ${playerName} сказал: "${message}". Ответь ему как бот ${botName}. Будь дружелюбным и кратким.` }
      ],
      model: "mixtral-8x7b-32768",
      temperature: 0.7,
      max_tokens: 150,
    });
    
    return completion.choices[0]?.message?.content || "Извини, я не понял. Повтори пожалуйста.";
  } catch (err) {
    console.error('AI Error:', err);
    return "Извини, у меня проблемы со связью. Попробуй позже.";
  }
}

// ============= TELEGRAM INTEGRATION =============
function initTelegramBot(token) {
    if (!token) return;
    telegramBot = new TelegramBot(token, { polling: true });
    
    telegramBot.onText(/\/status/, (msg) => {
        const chatId = msg.chat.id;
        const online = Array.from(botsMap.values()).filter(b => botStates.get(b.uuid)?.online).length;
        telegramBot.sendMessage(chatId, `🤖 Боты: ${botsMap.size} всего, ${online} онлайн\n⚔️ Киллов: ${combatStats.kills}\n📍 Сервер: ${serverIp}:${serverPort}`);
    });
    
    telegramBot.onText(/\/bots/, (msg) => {
        const chatId = msg.chat.id;
        const botList = Array.from(botsMap.values()).map(b => `${b.username} ${botStates.get(b.uuid)?.online ? '🟢' : '🔴'}`).join('\n');
        telegramBot.sendMessage(chatId, `📋 Список ботов:\n${botList || 'Нет ботов'}`);
    });
    
    telegramBot.onText(/\/say (.+)/, (msg, match) => {
        const chatId = msg.chat.id;
        const text = match[1];
        const bot = botsMap.values().next().value;
        if (bot) {
            bot.chat(text);
            telegramBot.sendMessage(chatId, `✅ Сообщение отправлено: ${text}`);
        } else {
            telegramBot.sendMessage(chatId, '❌ Нет активных ботов');
        }
    });
    
    console.log('🤖 Telegram бот запущен');
}

function sendTelegramNotification(message) {
    if (telegramBot) {
        const chatId = process.env.TELEGRAM_CHAT_ID || '123456789';
        telegramBot.sendMessage(chatId, message);
    }
}

// ============= DISCORD INTEGRATION (через webhook) =============
async function sendDiscordWebhook(webhookUrl, message) {
    try {
        await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: message })
        });
    } catch (err) {
        console.error('Discord webhook error:', err);
    }
}

// ============= ЛОГИРОВАНИЕ =============
function log(type, message, botId = null) {
  const timestamp = new Date().toLocaleTimeString('ru-RU');
  const logEntry = { id: uuidv4(), type, message, timestamp, botId };
  chatLog.push(logEntry);
  if (chatLog.length > maxLogSize) chatLog.shift();
  
  // Сохраняем для аналитики
  activityLog.push({ time: Date.now(), type, botId });
  if (activityLog.length > 10000) activityLog.shift();
  
  const colors = { 'SYSTEM': '\x1b[36m', 'BOT': '\x1b[32m', 'CHAT': '\x1b[37m', 'ERROR': '\x1b[31m', 'AI': '\x1b[35m', 'COMBAT': '\x1b[31m', 'STALKER': '\x1b[33m', 'GUARD': '\x1b[34m', 'DIPLOMAT': '\x1b[36m', 'TRADER': '\x1b[32m' };
  const reset = '\x1b[0m';
  const color = colors[type] || colors['SYSTEM'];
  const botLabel = botId ? ` [${botsMap.get(botId)?.username || botId.slice(0, 8)}]` : '';
  console.log(`${color}[${timestamp}] <${type}>${botLabel} ${message}${reset}`);
  
  if (typeof io !== 'undefined') io.emit('chat', logEntry);
  
  // Отправка в Telegram при важных событиях
  if (type === 'COMBAT' || type === 'ERROR') {
    sendTelegramNotification(`⚠️ ${type}: ${message}`);
  }
}

// ============= РЕЖИМ "СТАЛКЕР" =============
function startStalkerMode(bot, botId, targetPlayer) {
    let isHidden = false;
    let followDistance = 15;
    
    const stalkerInterval = setInterval(() => {
        if (!botsMap.has(botId) || !botStates.get(botId)?.online) {
            clearInterval(stalkerInterval);
            return;
        }
        
        const target = bot.players[targetPlayer];
        if (!target || !target.entity) return;
        
        const distance = bot.entity.position.distanceTo(target.entity.position);
        
        // Если игрок близко - прячемся
        if (distance < 8) {
            if (!isHidden) {
                // Ищем укрытие - ближайший блок
                const nearbyBlocks = bot.findBlocks({ matching: ['stone', 'dirt', 'oak_log'], maxDistance: 5, count: 1 });
                if (nearbyBlocks.length > 0) {
                    const cover = bot.blockAt(nearbyBlocks[0]);
                    bot.pathfinder.setGoal(new GoalBlock(cover.position.x, cover.position.y, cover.position.z));
                    log('STALKER', `🔍 ${bot.username} прячется от ${targetPlayer}`, botId);
                    isHidden = true;
                }
            }
        } else if (distance > followDistance) {
            // Следуем на расстоянии
            const pos = target.entity.position;
            const followPos = { x: pos.x + 5, y: pos.y, z: pos.z + 5 };
            bot.pathfinder.setGoal(new GoalBlock(followPos.x, followPos.y, followPos.z));
            isHidden = false;
        }
        
        // Копируем движения игрока
        if (bot.controlState.forward !== target.entity.velocity.x) {
            bot.setControlState('forward', target.entity.velocity.x > 0);
        }
        
    }, 3000);
    
    return stalkerInterval;
}

// ============= РЕЖИМ "ТЕЛОХРАНИТЕЛЬ" =============
function startBodyguardMode(bot, botId, protectedPlayer) {
    protectedPlayers.set(botId, protectedPlayer);
    
    const guardInterval = setInterval(() => {
        if (!botsMap.has(botId) || !botStates.get(botId)?.online) {
            clearInterval(guardInterval);
            return;
        }
        
        const target = bot.players[protectedPlayer];
        if (!target || !target.entity) return;
        
        // Следуем за охраняемым
        const pos = target.entity.position;
        bot.pathfinder.setGoal(new GoalBlock(pos.x, pos.y, pos.z));
        
        // Проверяем здоровье охраняемого
        if (target.entity.health < 15 && bot.health > 10) {
            // Делимся едой/здоровьем
            bot.chat(`/msg ${protectedPlayer} ❤️ Держи еду, восстанавливай здоровье!`);
            // Попытка выбросить еду
            const foodSlot = bot.inventory.slots.find(s => s && s.name.includes('bread') || s?.name.includes('apple'));
            if (foodSlot) {
                bot.tossStack(foodSlot);
            }
        }
        
        // Ищем врагов вокруг
        for (const [name, player] of Object.entries(bot.players || {})) {
            if (player.entity && name !== bot.username && name !== protectedPlayer) {
                const dist = bot.entity.position.distanceTo(player.entity.position);
                if (dist < 10 && player.entity.health < player.entity.health - 5) {
                    // Кто-то атакует охраняемого
                    bot.attack(player.entity);
                    log('GUARD', `🛡️ ${bot.username} защищает ${protectedPlayer} от ${name}!`, botId);
                    bot.chat(`⚠️ ${protectedPlayer}, тебя атакует ${name}! Я его отвлеку!`);
                }
            }
        }
        
    }, 2000);
    
    return guardInterval;
}

// ============= РЕЖИМ "ДИПЛОМАТ" =============
function startDiplomatMode(bot, botId) {
    const greetedPlayers = new Set();
    const knowledgeBase = {
        "правила": "На сервере запрещены: гриферство, мат, реклама. Нарушители получают бан.",
        "как играть": "Нажми E для инвентаря, W A S D для движения. Добывай ресурсы, строй, сражайся!",
        "сервер": `IP: ${serverIp}:${serverPort}. Добро пожаловать!`,
        "бот": `Я бот ${bot.username}. Могу помочь, ответить на вопросы, просто поговорить.`
    };
    
    const diplomatInterval = setInterval(() => {
        if (!botsMap.has(botId) || !botStates.get(botId)?.online) {
            clearInterval(diplomatInterval);
            return;
        }
        
        // Приветствие новых игроков
        for (const [name, player] of Object.entries(bot.players || {})) {
            if (player.entity && name !== bot.username && !greetedPlayers.has(name)) {
                greetedPlayers.add(name);
                bot.chat(`👋 Привет, ${name}! Добро пожаловать на сервер! Я бот ${bot.username}. Напиши !help для списка команд.`);
                log('DIPLOMAT', `👋 ${bot.username} поприветствовал ${name}`, botId);
            }
        }
        
    }, 10000);
    
    return diplomatInterval;
}

// ============= РЕЖИМ "ТОРГОВЕЦ" =============
function startTraderMode(bot, botId) {
    // Собираем ресурсы для торговли
    const collectInterval = setInterval(() => {
        if (!botsMap.has(botId) || !botStates.get(botId)?.online) {
            clearInterval(collectInterval);
            return;
        }
        
        // Собираем предметы с земли
        const nearbyItems = Object.values(bot.entities || {}).filter(e => e.objectType === 'Item' && bot.entity.position.distanceTo(e.position) < 5);
        for (const item of nearbyItems) {
            bot.lookAt(item.position);
            setTimeout(() => bot.activateItem(), 100);
        }
        
    }, 5000);
    
    // Поиск жителей для торговли
    const villagerInterval = setInterval(() => {
        if (!botsMap.has(botId)) {
            clearInterval(villagerInterval);
            return;
        }
        
        const villagers = bot.entities.filter(e => e.entityType === 'villager');
        if (villagers.length > 0) {
            const nearest = villagers[0];
            bot.lookAt(nearest.position);
            bot.activateEntity(nearest);
            log('TRADER', `💰 ${bot.username} торгует с жителем`, botId);
        }
        
    }, 30000);
    
    return { collectInterval, villagerInterval };
}

// ============= ЧАТ-КОМАНДЫ ДЛЯ ИГРОКОВ =============
function processChatCommands(bot, username, message) {
    const cmd = message.toLowerCase().trim();
    const args = cmd.split(' ');
    
    if (cmd === '!help') {
        bot.chat(`📋 Команды: !follow [бот] - следовать, !stop - остановиться, !come - подойти, !go [x] [z] - идти, !trade - торговать, !info - информация, !dance - танцевать, !jump - прыгнуть, !wave - помахать, !sit - сесть`);
        return true;
    }
    
    if (cmd === '!stop') {
        bot.pathfinder.stop();
        bot.chat(`⏹️ Остановился`);
        return true;
    }
    
    if (cmd === '!come') {
        const player = bot.players[username];
        if (player && player.entity) {
            const pos = player.entity.position;
            bot.pathfinder.setGoal(new GoalBlock(pos.x, pos.y, pos.z));
            bot.chat(`🏃 Иду к ${username}`);
        }
        return true;
    }
    
    if (cmd.startsWith('!go')) {
        const x = parseFloat(args[1]);
        const z = parseFloat(args[2]);
        if (!isNaN(x) && !isNaN(z)) {
            bot.pathfinder.setGoal(new GoalBlock(x, 64, z));
            bot.chat(`📍 Иду к ${x}, ${z}`);
        }
        return true;
    }
    
    if (cmd === '!dance') {
        startDance(bot);
        bot.chat(`💃 Танцую!`);
        return true;
    }
    
    if (cmd === '!jump') {
        bot.setControlState('jump', true);
        setTimeout(() => bot.setControlState('jump', false), 200);
        return true;
    }
    
    if (cmd === '!wave') {
        bot.swingArm();
        bot.chat(`👋 Привет, ${username}!`);
        return true;
    }
    
    if (cmd === '!sit') {
        bot.setControlState('sneak', true);
        setTimeout(() => bot.setControlState('sneak', false), 3000);
        return true;
    }
    
    if (cmd === '!info') {
        const pos = bot.entity.position;
        bot.chat(`🤖 ${bot.username} | ❤️ ${bot.health} HP | 📍 X:${Math.round(pos.x)} Y:${Math.round(pos.y)} Z:${Math.round(pos.z)}`);
        return true;
    }
    
    if (cmd.startsWith('!follow')) {
        const targetBotName = args[1];
        const targetBot = Array.from(botsMap.values()).find(b => b.username.toLowerCase() === targetBotName?.toLowerCase());
        if (targetBot) {
            startStalkerMode(bot, bot.uuid, targetBot.username);
            bot.chat(`🔍 Следую за ${targetBotName}`);
        } else {
            bot.chat(`❌ Бот ${targetBotName} не найден`);
        }
        return true;
    }
    
    if (cmd.startsWith('!trade')) {
        const target = args[1];
        if (target) {
            tradeOffers.set(bot.uuid, { player: username, target, items: [], status: 'pending' });
            bot.chat(`💎 ${username}, отправь предметы для обмена с ${target}`);
        }
        return true;
    }
    
    return false;
}

function startDance(bot) {
    let step = 0;
    const dance = setInterval(() => {
        if (!bot.entity) { clearInterval(dance); return; }
        step++;
        if (step % 2 === 0) bot.setControlState('jump', true);
        else bot.setControlState('jump', false);
        bot.look(Math.sin(step) * Math.PI, 0);
        if (step > 20) {
            clearInterval(dance);
            bot.setControlState('jump', false);
        }
    }, 300);
}

// ============= ПРОДВИНУТАЯ БОЕВАЯ СИСТЕМА =============
function startAdvancedCombat(bot, botId, enemyName) {
    const combatInterval = setInterval(() => {
        if (!botsMap.has(botId)) {
            clearInterval(combatInterval);
            return;
        }
        
        const enemy = bot.players[enemyName];
        if (!enemy || !enemy.entity) return;
        
        const distance = bot.entity.position.distanceTo(enemy.entity.position);
        const myHealth = bot.health;
        const enemyHealth = enemy.entity.health || 20;
        
        // Тактика: окружение
        const allies = Array.from(botsMap.values()).filter(b => b !== bot && botStates.get(b.uuid)?.online);
        const enemyPos = enemy.entity.position;
        
        // Распределение ролей
        if (allies.length > 1) {
            const roles = ['tank', 'dps', 'support'];
            allies.forEach((ally, index) => {
                const role = roles[index % roles.length];
                if (role === 'tank') {
                    // Танк впереди
                    ally.pathfinder.setGoal(new GoalBlock(enemyPos.x + 2, enemyPos.y, enemyPos.z));
                } else if (role === 'dps') {
                    // ДД сбоку
                    ally.pathfinder.setGoal(new GoalBlock(enemyPos.x + 5, enemyPos.y, enemyPos.z + 3));
                }
            });
        }
        
        // Уклонение от стрел
        if (enemy.entity.velocity.x > 0.5 || enemy.entity.velocity.z > 0.5) {
            // Уклоняемся в сторону
            const strafe = Math.random() > 0.5 ? 'left' : 'right';
            bot.setControlState(strafe, true);
            setTimeout(() => bot.setControlState(strafe, false), 500);
        }
        
        // Использование укрытий при низком здоровье
        if (myHealth < 8) {
            const cover = bot.findBlocks({ matching: ['stone', 'dirt'], maxDistance: 10, count: 1 });
            if (cover.length > 0) {
                const block = bot.blockAt(cover[0]);
                bot.pathfinder.setGoal(new GoalBlock(block.position.x, block.position.y, block.position.z));
                bot.chat(`🏥 Отступаю, нужно восстановиться!`);
            }
        }
        
        // Атака
        if (distance < 5 && myHealth > 5) {
            bot.attack(enemy.entity);
            combatStats.hits++;
            
            // Крит если здоровье врага низкое
            if (enemyHealth < 5) {
                combatStats.crits++;
                log('COMBAT', `💥 КРИТ! ${bot.username} добивает ${enemyName}!`, botId);
            }
            
            // Синхронная атака с союзниками
            allies.forEach(ally => {
                if (ally.entity.position.distanceTo(enemyPos) < 5) {
                    ally.attack(enemy.entity);
                }
            });
        }
        
    }, 1000);
    
    return combatInterval;
}

// ============= РОТАЦИЯ АККАУНТОВ =============
function rotateAccount(botId) {
    if (accountPool.length === 0) return;
    
    const currentBot = botsMap.get(botId);
    if (currentBot) {
        const newAccount = accountPool[Math.floor(Math.random() * accountPool.length)];
        log('SYSTEM', `🔄 Ротация аккаунта: ${currentBot.username} -> ${newAccount.username}`, botId);
        
        currentBot.end();
        setTimeout(() => {
            createBot(botsMap.size, newAccount.username, newAccount.password);
        }, 5000);
    }
}

// ============= МАШИННОЕ ОБУЧЕНИЕ =============
function recordPlayerBehavior(bot, playerName, action) {
    const key = `${playerName}_${action}`;
    const current = learningData.get(key) || { count: 0, timestamp: Date.now() };
    current.count++;
    learningData.set(key, current);
    saveLearning();
    
    // Анализ и адаптация
    if (current.count > 10) {
        // Если игрок часто делает одно и то же, бот учится предсказывать
        log('LEARNING', `🧠 Бот запомнил: ${playerName} часто ${action}`, bot.uuid);
    }
}

function predictPlayerMove(bot, playerName) {
    const recentActions = Array.from(learningData.entries())
        .filter(([key]) => key.startsWith(playerName))
        .sort((a, b) => b[1].timestamp - a[1].timestamp)
        .slice(0, 5);
    
    if (recentActions.length > 0) {
        const mostCommon = recentActions[0];
        log('PREDICT', `🔮 Прогноз: ${playerName} вероятно сделает ${mostCommon[0].split('_')[1]}`, bot.uuid);
        return mostCommon[0].split('_')[1];
    }
    return null;
}

// ============= КАПЧА-ДЕТЕКТ =============
function detectCaptcha(message) {
    const captchaPatterns = [
        /captcha/i, /капча/i, /verify/i, /верификация/i,
        /введите код/i, /enter code/i, /prove you are human/i
    ];
    
    return captchaPatterns.some(pattern => pattern.test(message));
}

function solveCaptcha(bot, message) {
    if (detectCaptcha(message)) {
        // Поиск цифр в сообщении
        const numbers = message.match(/\d+/g);
        if (numbers && numbers.length > 0) {
            const code = numbers.join('');
            bot.chat(`/captcha ${code}`);
            log('CAPTCHA', `🔐 Решена капча: ${code}`, bot.uuid);
            return true;
        }
    }
    return false;
}

// ============= СОЗДАНИЕ БОТА =============
function createBot(botIndex, customUsername = null, customPassword = null) {
  const botId = uuidv4();
  const username = customUsername || (accountPool[botIndex % accountPool.length]?.username) || generateRandomUsername();
  const password = customPassword || (accountPool[botIndex % accountPool.length]?.password) || generateRandomPassword();
  
  const botConfig = {
    host: serverIp,
    port: serverPort,
    username: username,
    version: '1.17.1',
    auth: 'offline',
    viewDistance: 'tiny'
  };
  
  const bot = mineflayer.createBot(botConfig);
  bot.uuid = botId;
  bot.registered = false;
  
  botsMap.set(botId, bot);
  
  botStates.set(botId, {
    id: botId,
    username: username,
    health: 20,
    food: 20,
    x: 0, y: 0, z: 0,
    online: false,
    inCombat: false,
    mode: 'idle',
    protectedPlayer: null
  });
  
  bot.on('login', () => {
    botStates.get(botId).online = true;
    log('SYSTEM', `✅ Бот ${username} подключился`, botId);
    io.emit('bot_status', { bots: Array.from(botStates.values()) });
  });
  
  bot.on('message', async (jsonMsg) => {
    try {
      const message = jsonMsg.toString();
      
      // Капча-детект
      if (solveCaptcha(bot, message)) return;
      
      const match = message.match(/<(.+?)>\s(.+)/);
      if (match) {
        const [, player, text] = match;
        if (player !== username) {
          log('CHAT', `<${player}> ${text}`, botId);
          
          // Запись поведения для обучения
          recordPlayerBehavior(bot, player, 'chat');
          
          // Чат-команды
          if (processChatCommands(bot, player, text)) return;
          
          // AI-ассистент (для дипломата)
          if (botStates.get(botId)?.mode === 'diplomat' || text.includes('бот') || text.includes('!ai')) {
            const aiResponse = await getAIResponse(text, username, player);
            setTimeout(() => bot.chat(aiResponse), 1000);
            log('AI', `🤖 ${username} отвечает ${player}: ${aiResponse}`, botId);
          }
        }
      } else {
        log('SYSTEM', message, botId);
      }
    } catch (err) {}
  });
  
  bot.on('health', () => {
    const state = botStates.get(botId);
    if (state) {
      state.health = bot.health;
      state.food = bot.food;
    }
    io.emit('bot_status', { bots: Array.from(botStates.values()) });
  });
  
  bot.on('move', () => {
    const state = botStates.get(botId);
    if (state && bot.entity) {
      state.x = Math.round(bot.entity.position.x * 100) / 100;
      state.y = Math.round(bot.entity.position.y * 100) / 100;
      state.z = Math.round(bot.entity.position.z * 100) / 100;
      
      // Запись исследованной территории
      const chunkKey = `${Math.floor(state.x / 16)},${Math.floor(state.z / 16)}`;
      if (!exploredTerritory.has(chunkKey)) {
        exploredTerritory.add(chunkKey);
        saveExplored();
      }
    }
  });
  
  bot.on('spawn', () => {
    log('SYSTEM', `🎮 Бот ${username} появился в мире`, botId);
    
    // Запуск режимов
    if (botStates.get(botId)?.mode === 'stalker') {
      startStalkerMode(bot, botId, botStates.get(botId)?.stalkerTarget);
    }
    if (botStates.get(botId)?.mode === 'bodyguard') {
      startBodyguardMode(bot, botId, botStates.get(botId)?.protectedPlayer);
    }
    if (botStates.get(botId)?.mode === 'diplomat') {
      startDiplomatMode(bot, botId);
    }
    if (botStates.get(botId)?.mode === 'trader') {
      startTraderMode(bot, botId);
    }
  });
  
  bot.on('end', () => {
    const state = botStates.get(botId);
    if (state) state.online = false;
    botsMap.delete(botId);
    log('SYSTEM', `⚠️ Бот ${username} отключился`, botId);
    io.emit('bot_status', { bots: Array.from(botStates.values()) });
    
    // Ротация аккаунтов при отключении
    if (accountPool.length > 0) {
      setTimeout(() => rotateAccount(botId), 3000);
    }
  });
  
  bot.on('error', (err) => {
    log('ERROR', `${err.message || err}`, botId);
  });
  
  bot.loadPlugin(pathfinder);
}

// ============= ГЕНЕРАЦИЯ ДАННЫХ =============
function generateRandomUsername() {
  const prefixes = ['Pro', 'Xx', 'i', 'Noob', 'God', 'Killer', 'Hunter', 'Solo', 'Elite', 'Master'];
  const suffixes = ['xX', 'Pro', 'MC', 'Bot', '1337', '2024'];
  const names = ['Steve', 'Alex', 'Herobrine', 'Notch', 'Jeb', 'Dinnerbone'];
  
  const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
  const name = names[Math.floor(Math.random() * names.length)];
  const suffix = suffixes[Math.floor(Math.random() * suffixes.length)];
  const num = Math.floor(Math.random() * 9999);
  
  return `${prefix}${name}${suffix}${num}`;
}

function generateRandomPassword() {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let password = '';
  for (let i = 0; i < 12; i++) {
    password += chars[Math.floor(Math.random() * chars.length)];
  }
  return password;
}

// ============= EXPRESS + SOCKET.IO =============
const app = express();
const server = http.createServer(app);
const io = socketIO(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'web')));
app.use(express.json());

// API ENDPOINTS
app.get('/api/status', (req, res) => {
  res.json({ bots: Array.from(botStates.values()), total: botsMap.size });
});

app.get('/api/bots', (req, res) => {
  const bots = Array.from(botsMap.values()).map(bot => ({
    id: bot.uuid,
    username: bot.username,
    health: bot.health || 20,
    food: bot.food || 20,
    online: botStates.get(bot.uuid)?.online || false,
    inCombat: botStates.get(bot.uuid)?.inCombat || false,
    x: bot.entity?.position?.x || 0,
    y: bot.entity?.position?.y || 0,
    z: bot.entity?.position?.z || 0,
    mode: botStates.get(bot.uuid)?.mode || 'idle'
  }));
  res.json({ bots });
});

app.post('/api/bot/:botId/set-mode', (req, res) => {
  const bot = botsMap.get(req.params.botId);
  if (!bot) return res.status(404).json({ error: 'Bot not found' });
  const { mode, target } = req.body;
  
  const state = botStates.get(bot.uuid);
  if (state) {
    state.mode = mode;
    if (mode === 'stalker') state.stalkerTarget = target;
    if (mode === 'bodyguard') state.protectedPlayer = target;
  }
  
  if (mode === 'stalker') startStalkerMode(bot, bot.uuid, target);
  if (mode === 'bodyguard') startBodyguardMode(bot, bot.uuid, target);
  if (mode === 'diplomat') startDiplomatMode(bot, bot.uuid);
  if (mode === 'trader') startTraderMode(bot, bot.uuid);
  
  res.json({ success: true });
});

app.get('/api/stats', (req, res) => {
  res.json({ combat: combatStats, explored: exploredTerritory.size, learning: learningData.size });
});

app.post('/api/telegram/init', (req, res) => {
  const { token } = req.body;
  initTelegramBot(token);
  res.json({ success: true });
});

// ============= SOCKET =============
io.on('connection', (socket) => {
  log('SYSTEM', '🌐 Веб-клиент подключился');
  socket.emit('bot_status', { bots: Array.from(botStates.values()) });
  socket.emit('chat', chatLog);
  socket.emit('stats', { combat: combatStats, explored: exploredTerritory.size });
});

// ============= ЗАПУСК =============
loadData();

function startServer() {
  server.listen(webPort, () => {
    console.log(`
╔══════════════════════════════════════════════════════════════════════════╗
║  🤖 ImInvisible Bot Controller  v6.0 - FULL ULTIMATE EDITION            ║
╠══════════════════════════════════════════════════════════════════════════╣
║  📊 ПАРАМЕТРЫ:                                                          ║
║     🖥️  Сервер: ${serverIp}:${serverPort}                                                  ║
║     🤖 Ботов: ${botCount}                                                                  ║
║     🌐 Портал: http://localhost:${webPort}                                                    ║
╠══════════════════════════════════════════════════════════════════════════╣
║  ✨ ВСЕ ФУНКЦИИ АКТИВИРОВАНЫ:                                           ║
║     🔥 1.1 Сталкер | 1.2 Телохранитель | 1.4 Дипломат | 1.5 Торговец   ║
║     🎮 2.1 Чат-команды | 2.2 Голосовые команды                          ║
║     🗺️ 3.1 3D Карта                                                     ║
║     💬 4.1 AI-ассистент (Groq)                                          ║
║     ⚔️ 5.1 Тактика боя | 5.2 Командные бои                              ║
║     🔌 7.1 Discord | 7.2 Telegram                                       ║
║     📊 8.1 Детальная статистика                                         ║
║     🔐 10.1 Капча-детект | 10.3 Ротация аккаунтов                       ║
║     🤖 11.1 Машинное обучение                                           ║
╚══════════════════════════════════════════════════════════════════════════╝
`);
    log('SYSTEM', `🎯 Запуск ${botCount} ботов с интервалом 5 секунд...`);
  });
}

startServer();

for (let i = 0; i < botCount; i++) {
  setTimeout(() => createBot(i), i * 5000);
}

process.on('SIGINT', () => {
  console.log('\n🛑 Завершение работы...');
  for (const bot of botsMap.values()) { try { bot.quit(); } catch (err) {} }
  server.close();
  process.exit(0);
});

module.exports = { botsMap, botStates, log };
