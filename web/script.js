// ============= ГЛОБАЛЬНЫЕ ПЕРЕМЕННЫЕ =============
const socket = io();
let bots = [];
let triggers = [];
let groups = [];
let waypoints = [];
let templates = [];
let schedules = [];
let killList = [];
let chatLog = [];
let currentPage = 'dashboard';
let selectedBots = new Set();
let selectedBotId = null;
let combatStats = { kills: 0, deaths: 0, hits: 0, crits: 0, dps: 0 };
let autoPVPEnabled = false;
let activityChart = null;
let heatmapChart = null;

// ============= 3D КАРТА =============
let scene, camera, renderer, controls, botMarkers = [];

function init3DMap() {
    const container = document.getElementById('map3d');
    if (!container) return;
    
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0a2a);
    scene.fog = new THREE.FogExp2(0x0a0a2a, 0.002);
    
    camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.1, 1000);
    camera.position.set(50, 50, 50);
    camera.lookAt(0, 0, 0);
    
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(container.clientWidth, container.clientHeight);
    container.innerHTML = '';
    container.appendChild(renderer.domElement);
    
    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    
    // Сетка земли
    const gridHelper = new THREE.GridHelper(200, 20, 0x00d4ff, 0x3366aa);
    gridHelper.position.y = -2;
    scene.add(gridHelper);
    
    // Освещение
    const ambientLight = new THREE.AmbientLight(0x404040);
    scene.add(ambientLight);
    const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
    directionalLight.position.set(10, 20, 5);
    scene.add(directionalLight);
    
    // Звезды
    const starGeometry = new THREE.BufferGeometry();
    const starCount = 1000;
    const starPositions = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
        starPositions[i*3] = (Math.random() - 0.5) * 500;
        starPositions[i*3+1] = (Math.random() - 0.5) * 100 + 50;
        starPositions[i*3+2] = (Math.random() - 0.5) * 500 - 100;
    }
    starGeometry.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
    const starMaterial = new THREE.PointsMaterial({ color: 0xffffff, size: 0.2 });
    const stars = new THREE.Points(starGeometry, starMaterial);
    scene.add(stars);
    
    animate3D();
}

function animate3D() {
    if (!renderer) return;
    requestAnimationFrame(animate3D);
    controls.update();
    renderer.render(scene, camera);
}

function update3DMap() {
    if (!scene) init3DMap();
    
    // Удаляем старые маркеры
    botMarkers.forEach(marker => scene.remove(marker));
    botMarkers = [];
    
    // Добавляем ботов
    bots.forEach(bot => {
        if (!bot.online) return;
        const geometry = new THREE.SphereGeometry(1, 32, 32);
        const material = new THREE.MeshStandardMaterial({ 
            color: bot.inCombat ? 0xff4444 : 0x00d4ff, 
            emissive: 0x004444 
        });
        const sphere = new THREE.Mesh(geometry, material);
        sphere.position.set(bot.x || 0, (bot.y || 64) + 1, bot.z || 0);
        scene.add(sphere);
        botMarkers.push(sphere);
        
        // Добавляем имя
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        canvas.width = 256;
        canvas.height = 64;
        ctx.fillStyle = '#00d4ff';
        ctx.font = 'Bold 20px Arial';
        ctx.fillText(bot.username, 10, 30);
        const texture = new THREE.CanvasTexture(canvas);
        const nameMaterial = new THREE.SpriteMaterial({ map: texture });
        const sprite = new THREE.Sprite(nameMaterial);
        sprite.scale.set(3, 0.75, 1);
        sprite.position.set(bot.x || 0, (bot.y || 64) + 2, bot.z || 0);
        scene.add(sprite);
        botMarkers.push(sprite);
    });
}

// ============= ГОЛОСОВЫЕ КОМАНДЫ =============
let recognition = null;

function startVoiceRecognition() {
    if (!('webkitSpeechRecognition' in window)) {
        alert('Голосовое распознавание не поддерживается в этом браузере');
        return;
    }
    
    const voiceBtn = document.getElementById('voiceBtn');
    voiceBtn.classList.add('listening');
    
    recognition = new webkitSpeechRecognition();
    recognition.lang = 'ru-RU';
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    
    recognition.onresult = (event) => {
        const command = event.results[0][0].transcript.toLowerCase();
        voiceBtn.classList.remove('listening');
        processVoiceCommand(command);
    };
    
    recognition.onerror = () => {
        voiceBtn.classList.remove('listening');
        addChatMessage('SYSTEM', '❌ Ошибка распознавания голоса');
    };
    
    recognition.start();
}

function processVoiceCommand(command) {
    addChatMessage('SYSTEM', `🎤 Голосовая команда: "${command}"`);
    
    if (command.includes('помощь') || command.includes('help')) {
        addChatMessage('BOT', 'Доступные команды: создай бота, останови всех, покажи ботов, включи пвп, выключи пвп, перемести бота [имя]');
    }
    else if (command.includes('создай бота')) {
        createBot();
    }
    else if (command.includes('останови всех')) {
        stopAllBots();
    }
    else if (command.includes('покажи ботов')) {
        refreshBots();
    }
    else if (command.includes('включи пвп')) {
        if (!autoPVPEnabled) toggleAutoPVP();
    }
    else if (command.includes('выключи пвп')) {
        if (autoPVPEnabled) toggleAutoPVP();
    }
    else if (command.includes('перемести бота')) {
        const match = command.match(/перемести бота (\w+)/);
        if (match && bots.find(b => b.username === match[1])) {
            const bot = bots.find(b => b.username === match[1]);
            moveBot(bot.id);
        } else {
            addChatMessage('BOT', 'Не понял какого бота перемещать');
        }
    }
    else {
        addChatMessage('BOT', 'Команда не распознана. Скажите "помощь" для списка команд');
    }
}

// ============= ТЕМЫ =============
function setTheme(theme) {
    document.body.className = `theme-${theme}`;
    localStorage.setItem('theme', theme);
    document.querySelectorAll('.theme-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelector(`.theme-btn.${theme}`).classList.add('active');
}

// ============= СТРАНИЦЫ =============
function switchPage(page) {
    currentPage = page;
    document.querySelectorAll('.page').forEach(p => p.style.display = 'none');
    const targetPage = document.getElementById(`page-${page}`);
    if (targetPage) targetPage.style.display = 'block';
    
    document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
    const activeNav = document.querySelector(`[data-page="${page}"]`);
    if (activeNav) activeNav.classList.add('active');
    
    const titles = {
        dashboard: 'Дашборд',
        bots: 'Боты',
        triggers: 'Триггеры',
        groups: 'Группы',
        waypoints: 'Маршруты',
        combat: 'Боевая',
        templates: 'Шаблоны',
        schedules: 'Расписание',
        scripts: 'Скрипты',
        analytics: 'Аналитика',
        settings: 'Настройки'
    };
    document.getElementById('pageTitle').innerText = titles[page] || page;
    
    if (page === 'dashboard') { updateDashboard(); update3DMap(); }
    if (page === 'bots') updateBotsList();
    if (page === 'triggers') updateTriggersList();
    if (page === 'groups') loadGroups();
    if (page === 'waypoints') loadWaypoints();
    if (page === 'combat') updateCombatPage();
    if (page === 'templates') loadTemplates();
    if (page === 'schedules') loadSchedules();
    if (page === 'scripts') loadScriptsLibrary();
    if (page === 'analytics') updateAnalytics();
    if (page === 'settings') loadSettings();
}

// ============= DASHBOARD =============
function updateDashboard() {
    document.getElementById('statTotal').innerText = bots.length;
    document.getElementById('statOnline').innerText = bots.filter(b => b.online).length;
    document.getElementById('statTriggers').innerText = triggers.length;
    document.getElementById('statKills').innerText = combatStats.kills;
    document.getElementById('statGroups').innerText = groups.length;
    document.getElementById('statExplored').innerText = Math.floor(Math.random() * 1000);
    document.getElementById('botsCount').innerText = bots.length;
    document.getElementById('triggersCount').innerText = triggers.length;
    document.getElementById('botCountTop').innerText = bots.length;
    document.getElementById('killsCount').innerText = combatStats.kills;
    updateActivityChart();
    updateEventsLog();
}

function updateActivityChart() {
    const ctx = document.getElementById('activityChart')?.getContext('2d');
    if (!ctx) return;
    if (activityChart) activityChart.destroy();
    
    activityChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: Array.from({ length: 60 }, (_, i) => `${i}мин`),
            datasets: [{
                label: 'Активность',
                data: Array.from({ length: 60 }, () => Math.floor(Math.random() * 50)),
                borderColor: '#00d4ff',
                backgroundColor: 'rgba(0, 212, 255, 0.1)',
                fill: true,
                tension: 0.4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            plugins: {
                legend: { labels: { color: '#fff' } }
            },
            scales: {
                y: { grid: { color: '#2a2a2a' }, ticks: { color: '#fff' } },
                x: { grid: { color: '#2a2a2a' }, ticks: { color: '#fff' } }
            }
        }
    });
}

function updateEventsLog() {
    const container = document.getElementById('eventsLog');
    if (!container) return;
    
    const recentEvents = chatLog.slice(-15).reverse();
    if (recentEvents.length === 0) {
        container.innerHTML = '<div class="empty-state">Нет событий</div>';
        return;
    }
    
    container.innerHTML = recentEvents.map(e => `
        <div style="padding:8px; border-bottom:1px solid var(--border); font-size:12px;">
            <span style="color:var(--accent);">[${e.type || 'INFO'}]</span> 
            <span>${e.message || ''}</span>
            <span style="float:right; color:var(--text-muted);">${e.timestamp || ''}</span>
        </div>
    `).join('');
}

function clearEvents() {
    chatLog = [];
    updateEventsLog();
    addChatMessage('SYSTEM', 'Лог событий очищен');
}

// ============= BOTS =============
function updateBotsList() {
    let filtered = [...bots];
    const search = document.getElementById('searchInput')?.value.toLowerCase();
    if (search) filtered = filtered.filter(b => b.username.toLowerCase().includes(search));
    
    const container = document.getElementById('botsList');
    if (!container) return;
    
    if (!filtered.length) {
        container.innerHTML = '<div class="empty-state">📭 Нет ботов</div>';
        return;
    }
    
    container.innerHTML = filtered.map(bot => `
        <div class="bot-card ${selectedBotId === bot.id ? 'selected' : ''}">
            <div class="bot-main" onclick="selectBot('${bot.id}')">
                <div class="bot-status ${bot.online ? 'online' : 'offline'}">
                    ${bot.online ? '🟢' : '🔴'}
                </div>
                <div class="bot-info">
                    <div class="bot-name">
                        ${bot.username}
                        ${bot.online ? '<span class="bot-badge online">● Онлайн</span>' : ''}
                        ${bot.mode ? `<span class="bot-badge">${bot.mode}</span>` : ''}
                    </div>
                    <div class="bot-meta">
                        📍 X:${bot.x || 0} Y:${bot.y || 64} Z:${bot.z || 0} | 
                        ❤️ ${bot.health || 20} HP | 
                        🍗 ${bot.food || 20}
                    </div>
                </div>
                <input type="checkbox" class="bot-checkbox" value="${bot.id}" 
                    onclick="event.stopPropagation(); toggleBotSelect('${bot.id}')" 
                    ${selectedBots.has(bot.id) ? 'checked' : ''}>
            </div>
            <div class="bot-actions">
                <button class="btn" onclick="event.stopPropagation(); moveBot('${bot.id}')">📍 Переместить</button>
                <button class="btn" onclick="event.stopPropagation(); attackBot('${bot.id}')">⚔️ Атаковать</button>
                <button class="btn" onclick="event.stopPropagation(); setBotMode('${bot.id}', 'stalker', '${bot.username}')">🕵️ Сталкер</button>
                <button class="btn" onclick="event.stopPropagation(); setBotMode('${bot.id}', 'bodyguard', '${bot.username}')">🛡️ Телохранитель</button>
                <button class="btn" onclick="event.stopPropagation(); setBotMode('${bot.id}', 'diplomat')">🤝 Дипломат</button>
                <button class="btn" onclick="event.stopPropagation(); setBotMode('${bot.id}', 'trader')">💰 Торговец</button>
                <button class="btn btn-danger" onclick="event.stopPropagation(); stopBot('${bot.id}')">⏹️ Стоп</button>
            </div>
        </div>
    `).join('');
}

function selectBot(id) {
    selectedBotId = id;
    updateBotsList();
    addChatMessage('SYSTEM', `🤖 Выбран бот: ${bots.find(b => b.id === id)?.username || id}`);
}

function toggleBotSelect(id) {
    if (selectedBots.has(id)) {
        selectedBots.delete(id);
        addChatMessage('SYSTEM', `❌ Бот ${bots.find(b => b.id === id)?.username} удален из выбранных`);
    } else {
        selectedBots.add(id);
        addChatMessage('SYSTEM', `✅ Бот ${bots.find(b => b.id === id)?.username} добавлен в выбранные`);
    }
}

function refreshBots() {
    fetch('/api/bots')
        .then(r => r.json())
        .then(data => {
            bots = data.bots || [];
            updateDashboard();
            updateBotsList();
            update3DMap();
        })
        .catch(err => console.error('Refresh bots error:', err));
}

function createBot() {
    const name = prompt('Введите имя бота:', `Bot_${Math.floor(Math.random() * 1000)}`);
    if (name && name.trim()) {
        fetch('/api/bots/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: name.trim() })
        })
        .then(r => r.json())
        .then(() => {
            addChatMessage('SYSTEM', `🤖 Создан новый бот: ${name}`);
            refreshBots();
        })
        .catch(err => addChatMessage('ERROR', `Ошибка создания бота: ${err.message}`));
    }
}

function stopAllBots() {
    if (confirm('Остановить всех ботов?')) {
        fetch('/api/bots/stop', { method: 'POST' })
            .then(() => addChatMessage('SYSTEM', '⏹️ Все боты остановлены'));
    }
}

function stopBot(id) {
    const bot = bots.find(b => b.id === id);
    fetch(`/api/bot/${id}/stop`, { method: 'POST' })
        .then(() => addChatMessage('SYSTEM', `⏹️ Бот ${bot?.username} остановлен`));
}

function moveBot(id) {
    const x = prompt('X координата:') || 0;
    const y = prompt('Y координата:') || 64;
    const z = prompt('Z координата:') || 0;
    const bot = bots.find(b => b.id === id);
    
    fetch(`/api/bot/${id}/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ x: parseFloat(x), y: parseFloat(y), z: parseFloat(z) })
    }).then(() => addChatMessage('SYSTEM', `📍 Бот ${bot?.username} перемещается к ${x}, ${y}, ${z}`));
}

function attackBot(id) {
    const target = prompt('Кого атаковать?');
    const bot = bots.find(b => b.id === id);
    
    if (target) {
        fetch('/api/kill', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ target, damage: 5, botId: id })
        }).then(() => addChatMessage('COMBAT', `⚔️ Бот ${bot?.username} атакует ${target}`));
    }
}

function setBotMode(id, mode, target) {
    const bot = bots.find(b => b.id === id);
    fetch(`/api/bot/${id}/set-mode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, target: target || null })
    }).then(() => {
        addChatMessage('SYSTEM', `🔄 Бот ${bot?.username} переключен в режим: ${mode}`);
        refreshBots();
    });
}

// ============= TRIGGERS =============
function updateTriggersList() {
    const container = document.getElementById('triggersList');
    if (!container) return;
    
    if (!triggers.length) {
        container.innerHTML = '<div class="empty-state">Нет триггеров. Нажмите + чтобы добавить</div>';
        return;
    }
    
    container.innerHTML = triggers.map(t => `
        <div class="trigger-item">
            <div>
                <div class="trigger-keyword">${t.keyword}</div>
                <div class="trigger-response">${t.response}</div>
                <div style="font-size:10px; color:var(--text-muted);">
                    ${t.botId === 'all' ? 'все боты' : 'конкретный бот'} | 
                    срабатываний: ${t.hits || 0}
                </div>
            </div>
            <div>
                <button class="btn" onclick="toggleTrigger(${t.id})" 
                    style="background:${t.enabled ? 'var(--success)' : 'var(--danger)'}">
                    ${t.enabled ? '✅' : '❌'}
                </button>
                <button class="btn btn-danger" onclick="deleteTrigger(${t.id})">🗑️</button>
            </div>
        </div>
    `).join('');
}

function openTriggerModal() {
    fetch('/api/bots')
        .then(r => r.json())
        .then(data => {
            const select = document.getElementById('triggerBot');
            if (select) {
                select.innerHTML = '<option value="all">Все боты</option>';
                data.bots.forEach(b => {
                    select.innerHTML += `<option value="${b.id}">${b.username}</option>`;
                });
            }
        });
    document.getElementById('triggerModal').style.display = 'flex';
}

function addTrigger() {
    const keyword = document.getElementById('triggerKeyword')?.value.trim();
    const response = document.getElementById('triggerResponse')?.value.trim();
    const botId = document.getElementById('triggerBot')?.value;
    
    if (!keyword || !response) {
        alert('Заполните ключевое слово и ответ');
        return;
    }
    
    fetch('/api/triggers/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyword, response, botId })
    })
    .then(() => {
        closeModal('triggerModal');
        loadTriggers();
        addChatMessage('SYSTEM', `🎯 Добавлен триггер: "${keyword}" -> "${response}"`);
    });
}

function toggleTrigger(id) {
    fetch(`/api/triggers/${id}/toggle`, { method: 'POST' })
        .then(() => loadTriggers());
}

function deleteTrigger(id) {
    if (confirm('Удалить триггер?')) {
        fetch(`/api/triggers/${id}`, { method: 'DELETE' })
            .then(() => loadTriggers());
    }
}

function loadTriggers() {
    fetch('/api/triggers')
        .then(r => r.json())
        .then(data => {
            triggers = data.triggers || [];
            updateTriggersList();
            updateDashboard();
        });
}

// ============= GROUPS =============
function openGroupModal() {
    fetch('/api/bots')
        .then(r => r.json())
        .then(data => {
            const container = document.getElementById('groupBotsSelect');
            if (container) {
                container.innerHTML = '<div style="margin-bottom:8px;">Выберите ботов:</div>';
                data.bots.forEach(bot => {
                    container.innerHTML += `
                        <label style="display:block; margin:5px 0;">
                            <input type="checkbox" value="${bot.id}"> ${bot.username}
                        </label>
                    `;
                });
            }
        });
    document.getElementById('groupModal').style.display = 'flex';
}

function createGroup() {
    const name = document.getElementById('groupName')?.value.trim();
    const botIds = Array.from(document.querySelectorAll('#groupBotsSelect input:checked')).map(cb => cb.value);
    
    if (!name) {
        alert('Введите название группы');
        return;
    }
    
    fetch('/api/groups/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, botIds })
    })
    .then(() => {
        closeModal('groupModal');
        loadGroups();
        addChatMessage('SYSTEM', `👥 Создана группа: ${name} (${botIds.length} ботов)`);
    });
}

function loadGroups() {
    fetch('/api/groups')
        .then(r => r.json())
        .then(data => {
            groups = data.groups || [];
            const container = document.getElementById('groupsList');
            if (!container) return;
            
            if (!groups.length) {
                container.innerHTML = '<div class="empty-state">Нет групп</div>';
                return;
            }
            
            container.innerHTML = groups.map(g => `
                <div class="group-item">
                    <div>
                        <strong>${g.name}</strong>
                        <div style="font-size:12px;">Ботов: ${g.bots?.length || 0}</div>
                    </div>
                    <div>
                        <button class="btn" onclick="groupCommand('${g.name}', 'say')">💬 Сказать</button>
                        <button class="btn" onclick="groupCommand('${g.name}', 'move')">📍 Переместить</button>
                        <button class="btn" onclick="groupCommand('${g.name}', 'attack')">⚔️ Атаковать</button>
                    </div>
                </div>
            `).join('');
        });
}

function groupCommand(name, cmd) {
    if (cmd === 'say') {
        const msg = prompt('Сообщение для группы:');
        if (msg) {
            fetch(`/api/groups/${name}/command`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ command: 'say', message: msg })
            }).then(() => addChatMessage('SYSTEM', `💬 Группе ${name} отправлено сообщение: ${msg}`));
        }
    } else if (cmd === 'move') {
        const coords = prompt('Координаты X,Y,Z:');
        if (coords) {
            const [x, y, z] = coords.split(',').map(Number);
            fetch(`/api/groups/${name}/command`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ command: 'move', coords: { x, y, z } })
            }).then(() => addChatMessage('SYSTEM', `📍 Группа ${name} перемещается к ${coords}`));
        }
    } else if (cmd === 'attack') {
        const target = prompt('Кого атаковать?');
        if (target) {
            fetch(`/api/groups/${name}/command`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ command: 'attack', message: target })
            }).then(() => addChatMessage('COMBAT', `⚔️ Группа ${name} атакует ${target}`));
        }
    }
}

// ============= WAYPOINTS =============
function openWaypointModal() {
    document.getElementById('waypointModal').style.display = 'flex';
}

function createWaypoint() {
    const name = document.getElementById('waypointName')?.value.trim();
    const pointsText = document.getElementById('waypointPoints')?.value.trim();
    
    if (!name || !pointsText) {
        alert('Заполните название и точки маршрута');
        return;
    }
    
    const points = pointsText.split('\n')
        .filter(l => l.trim())
        .map(l => {
            const [x, y, z] = l.split(',').map(Number);
            return { x, y: y || 64, z };
        });
    
    fetch('/api/waypoints/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, points })
    })
    .then(() => {
        closeModal('waypointModal');
        loadWaypoints();
        addChatMessage('SYSTEM', `📍 Создан маршрут: ${name} (${points.length} точек)`);
    });
}

function loadWaypoints() {
    fetch('/api/waypoints')
        .then(r => r.json())
        .then(data => {
            waypoints = data.waypoints || [];
            const container = document.getElementById('waypointsList');
            if (!container) return;
            
            if (!waypoints.length) {
                container.innerHTML = '<div class="empty-state">Нет маршрутов</div>';
                return;
            }
            
            container.innerHTML = waypoints.map(w => `
                <div class="waypoint-item">
                    <div>
                        <strong>${w.name}</strong>
                        <div style="font-size:12px;">Точек: ${w.points?.length || 0}</div>
                    </div>
                    <div>
                        <button class="btn" onclick="startPatrol('${w.name}')">🚶 Патруль</button>
                    </div>
                </div>
            `).join('');
        });
}

function startPatrol(name) {
    const botId = prompt('ID бота (или имя):');
    if (botId) {
        fetch(`/api/bot/${botId}/start-patrol`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ waypointName: name })
        }).then(() => addChatMessage('SYSTEM', `🚶 Бот начинает патрулирование по маршруту ${name}`));
    }
}

// ============= COMBAT =============
function updateCombatPage() {
    document.getElementById('combatKills').innerText = combatStats.kills;
    document.getElementById('combatDeaths').innerText = combatStats.deaths;
    document.getElementById('combatHits').innerText = combatStats.hits;
    document.getElementById('combatCrits').innerText = combatStats.crits;
    document.getElementById('combatDPS').innerText = combatStats.dps;
    
    fetch('/api/targets')
        .then(r => r.json())
        .then(data => {
            const container = document.getElementById('targetsList');
            if (!container) return;
            
            if (!data.targets?.length) {
                container.innerHTML = '<div class="empty-state">Нет целей поблизости</div>';
                return;
            }
            
            container.innerHTML = data.targets.map(t => `
                <div class="trigger-item">
                    <div>
                        <strong>${t.name}</strong>
                        <div>❤️ ${t.health} HP | 📍 ${t.distance}м</div>
                    </div>
                    <div>
                        <button class="btn" onclick="attackTarget('${t.name}')">⚔️ Атаковать</button>
                    </div>
                </div>
            `).join('');
        });
    
    // Загрузка киллиста
    const killListContainer = document.getElementById('killlistList');
    if (killListContainer) {
        if (!killList.length) {
            killListContainer.innerHTML = '<div class="empty-state">Нет запрещенных целей</div>';
        } else {
            killListContainer.innerHTML = killList.map(k => `
                <div class="trigger-item">
                    <span>🚫 ${k}</span>
                    <button class="btn btn-danger" onclick="removeFromKillList('${k}')">Удалить</button>
                </div>
            `).join('');
        }
    }
}

function attackTarget(name) {
    fetch('/api/kill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: name, damage: 5 })
    }).then(() => addChatMessage('COMBAT', `⚔️ Атакуем ${name}`));
}

function addToKillList() {
    const input = document.getElementById('killlistInput');
    const name = input?.value.trim();
    if (name) {
        if (!killList.includes(name)) killList.push(name);
        localStorage.setItem('killList', JSON.stringify(killList));
        input.value = '';
        updateCombatPage();
        addChatMessage('SYSTEM', `🚫 ${name} добавлен в киллист`);
    }
}

function removeFromKillList(name) {
    const index = killList.indexOf(name);
    if (index > -1) killList.splice(index, 1);
    localStorage.setItem('killList', JSON.stringify(killList));
    updateCombatPage();
    addChatMessage('SYSTEM', `✅ ${name} удален из киллиста`);
}

function toggleAutoPVP() {
    autoPVPEnabled = !autoPVPEnabled;
    fetch('/api/auto-pvp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: autoPVPEnabled, radius: 10 })
    });
    addChatMessage('SYSTEM', autoPVPEnabled ? '🤖 Авто-ПВП включен' : '🤖 Авто-ПВП выключен');
}

// ============= TEMPLATES =============
function openTemplateModal() {
    document.getElementById('templateModal').style.display = 'flex';
}

function addTemplate() {
    const name = document.getElementById('templateName')?.value.trim();
    const text = document.getElementById('templateText')?.value.trim();
    
    if (!name || !text) {
        alert('Заполните название и текст шаблона');
        return;
    }
    
    templates.push({ id: Date.now(), name, text });
    localStorage.setItem('templates', JSON.stringify(templates));
    closeModal('templateModal');
    loadTemplates();
    addChatMessage('SYSTEM', `📝 Добавлен шаблон: ${name}`);
}

function loadTemplates() {
    const saved = localStorage.getItem('templates');
    if (saved) templates = JSON.parse(saved);
    
    const container = document.getElementById('templatesList');
    if (!container) return;
    
    if (!templates.length) {
        container.innerHTML = '<div class="empty-state">Нет шаблонов</div>';
        return;
    }
    
    container.innerHTML = templates.map(t => `
        <div class="template-item">
            <div>
                <strong>${t.name}</strong>
                <div style="font-size:12px;">${t.text.substring(0, 50)}${t.text.length > 50 ? '...' : ''}</div>
            </div>
            <div>
                <button class="btn" onclick="useTemplate('${t.text.replace(/'/g, "\\'")}')">📋 Использовать</button>
                <button class="btn btn-danger" onclick="deleteTemplate(${t.id})">🗑️</button>
            </div>
        </div>
    `).join('');
}

function useTemplate(text) {
    const messageInput = document.getElementById('messageText');
    if (messageInput) messageInput.value = text;
    closeModal('templateModal');
    openMessageModal();
}

function deleteTemplate(id) {
    templates = templates.filter(t => t.id !== id);
    localStorage.setItem('templates', JSON.stringify(templates));
    loadTemplates();
    addChatMessage('SYSTEM', '🗑️ Шаблон удален');
}

// ============= SCHEDULES =============
function openScheduleModal() {
    document.getElementById('scheduleModal').style.display = 'flex';
}

function addSchedule() {
    const name = document.getElementById('scheduleName')?.value.trim();
    const cron = document.getElementById('scheduleCron')?.value.trim();
    const action = document.getElementById('scheduleAction')?.value;
    const message = document.getElementById('scheduleMessage')?.value.trim();
    
    if (!name || !cron) {
        alert('Заполните название и cron выражение');
        return;
    }
    
    schedules.push({ id: Date.now(), name, cron, action, message, enabled: true });
    localStorage.setItem('schedules', JSON.stringify(schedules));
    closeModal('scheduleModal');
    loadSchedules();
    addChatMessage('SYSTEM', `⏰ Добавлено задание: ${name} (${cron})`);
}

function loadSchedules() {
    const saved = localStorage.getItem('schedules');
    if (saved) schedules = JSON.parse(saved);
    
    const container = document.getElementById('schedulesList');
    if (!container) return;
    
    if (!schedules.length) {
        container.innerHTML = '<div class="empty-state">Нет заданий</div>';
        return;
    }
    
    container.innerHTML = schedules.map(s => `
        <div class="schedule-item">
            <div>
                <strong>${s.name}</strong>
                <div style="font-size:12px;">${s.cron} | ${s.action}${s.message ? `: ${s.message}` : ''}</div>
            </div>
            <div>
                <button class="btn" onclick="toggleSchedule(${s.id})" 
                    style="background:${s.enabled ? 'var(--success)' : 'var(--danger)'}">
                    ${s.enabled ? '✅' : '❌'}
                </button>
                <button class="btn btn-danger" onclick="deleteSchedule(${s.id})">🗑️</button>
            </div>
        </div>
    `).join('');
}

function toggleSchedule(id) {
    const schedule = schedules.find(s => s.id === id);
    if (schedule) {
        schedule.enabled = !schedule.enabled;
        localStorage.setItem('schedules', JSON.stringify(schedules));
        loadSchedules();
        addChatMessage('SYSTEM', `⏰ Задание ${schedule.name} ${schedule.enabled ? 'включено' : 'выключено'}`);
    }
}

function deleteSchedule(id) {
    if (confirm('Удалить задание?')) {
        schedules = schedules.filter(s => s.id !== id);
        localStorage.setItem('schedules', JSON.stringify(schedules));
        loadSchedules();
        addChatMessage('SYSTEM', '🗑️ Задание удалено');
    }
}

// ============= SCRIPTS =============
function runScript() {
    const code = document.getElementById('scriptEditor')?.value;
    if (!code) return;
    
    try {
        eval(`(async()=>{
            const bot = {
                say: (msg) => fetch('/api/chat/send', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ message: msg })
                }),
                move: (x, y, z) => fetch('/api/bot/${selectedBotId || ''}/move', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ x, y, z })
                }),
                attack: (target) => fetch('/api/kill', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ target, damage: 5 })
                }),
                gather: (x, z) => fetch('/api/bots/gather', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ x, y: 64, z })
                }),
                follow: (player) => fetch('/api/bot/${selectedBotId || ''}/follow-player', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ playerName: player })
                }),
                setMode: (mode, target) => fetch('/api/bot/${selectedBotId || ''}/set-mode', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ mode, target })
                })
            };
            ${code}
        })()`);
        addChatMessage('SYSTEM', '✅ Скрипт выполнен успешно');
    } catch (e) {
        addChatMessage('ERROR', `❌ Ошибка выполнения скрипта: ${e.message}`);
    }
}

function saveScript() {
    const code = document.getElementById('scriptEditor')?.value;
    if (code) {
        localStorage.setItem('savedScript', code);
        addChatMessage('SYSTEM', '💾 Скрипт сохранен');
    }
}

function loadScriptsLibrary() {
    const scripts = {
        'stalker': `// Режим сталкер
const target = prompt("За кем следить?");
if (target) bot.setMode("stalker", target);
bot.say("🔍 Начинаю слежку за " + target);`,
        
        'bodyguard': `// Режим телохранитель
const target = prompt("Кого охранять?");
if (target) bot.setMode("bodyguard", target);
bot.say("🛡️ Я защищаю " + target);`,
        
        'diplomat': `// Режим дипломат
bot.setMode("diplomat");
bot.say("🤝 Я дипломат, могу помочь с вопросами!");`,
        
        'trader': `// Режим торговец
bot.setMode("trader");
bot.say("💰 Я торговец, готов к обмену!");`,
        
        'autoFarm': `// Авто-ферма
setInterval(() => {
    bot.say("🌾 Фермер работает!");
}, 60000);`,
        
        'autoMiner': `// Авто-шахтер
setInterval(() => {
    const x = Math.floor(Math.random() * 100);
    const z = Math.floor(Math.random() * 100);
    bot.move(x, 64, z);
    bot.say("⛏️ Копаю в " + x + ", " + z);
}, 120000);`
    };
    
    const container = document.getElementById('scriptsLibrary');
    if (!container) return;
    
    container.innerHTML = Object.entries(scripts).map(([name, code]) => `
        <div class="trigger-item">
            <div>
                <strong>${name}</strong>
                <div style="font-size:10px;">${code.substring(0, 50)}...</div>
            </div>
            <div>
                <button class="btn" onclick="loadScriptToEditor(\`${code.replace(/`/g, '\\`')}\`)">📂 Загрузить</button>
            </div>
        </div>
    `).join('');
}

function loadScriptToEditor(code) {
    const editor = document.getElementById('scriptEditor');
    if (editor) editor.value = code;
    addChatMessage('SYSTEM', '📜 Скрипт загружен в редактор');
}

// ============= ANALYTICS =============
function updateAnalytics() {
    document.getElementById('analyticsTotal').innerText = chatLog.length;
    const today = new Date().toLocaleDateString();
    const todayCount = chatLog.filter(l => l.timestamp?.includes(today) || new Date().toLocaleDateString() === today).length;
    document.getElementById('analyticsToday').innerText = todayCount;
    document.getElementById('analyticsAvg').innerText = Math.floor(chatLog.length / 24) || 0;
    
    const ctx = document.getElementById('heatmapChart')?.getContext('2d');
    if (ctx) {
        if (heatmapChart) heatmapChart.destroy();
        heatmapChart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: Array.from({ length: 24 }, (_, i) => `${i}:00`),
                datasets: [{
                    label: 'Активность',
                    data: Array.from({ length: 24 }, () => Math.floor(Math.random() * 50)),
                    backgroundColor: '#00d4ff',
                    borderRadius: 4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: true,
                plugins: {
                    legend: { labels: { color: '#fff' } }
                },
                scales: {
                    y: { grid: { color: '#2a2a2a' }, ticks: { color: '#fff' } },
                    x: { grid: { color: '#2a2a2a' }, ticks: { color: '#fff' } }
                }
            }
        });
    }
    
    const container = document.getElementById('botStatsList');
    if (container) {
        container.innerHTML = bots.map(b => `
            <div class="trigger-item">
                <div>
                    <strong>${b.username}</strong>
                    <div style="font-size:12px;">
                        Онлайн: ${b.online ? '🟢' : '🔴'} | 
                        Здоровье: ${b.health || 20} | 
                        Позиция: ${b.x || 0}, ${b.z || 0}
                    </div>
                </div>
            </div>
        `).join('');
    }
}

// ============= SETTINGS =============
function loadSettings() {
    document.getElementById('autoReconnect').checked = localStorage.getItem('autoReconnect') !== 'false';
    document.getElementById('antiKick').checked = localStorage.getItem('antiKick') !== 'false';
    document.getElementById('notifications').checked = localStorage.getItem('notifications') !== 'false';
    document.getElementById('sound').checked = localStorage.getItem('sound') !== 'false';
    document.getElementById('refreshInterval').value = localStorage.getItem('refreshInterval') || 5;
    document.getElementById('telegramToken').value = localStorage.getItem('telegramToken') || '';
    document.getElementById('discordWebhook').value = localStorage.getItem('discordWebhook') || '';
    
    fetch('/api/system/info')
        .then(r => r.json())
        .then(d => {
            const container = document.getElementById('systemInfo');
            if (container) {
                container.innerHTML = `
                    <div>📌 Версия: v6.0 Ultimate</div>
                    <div>🤖 Ботов: ${d.bots || 0}</div>
                    <div>🟢 Онлайн: ${d.online || 0}</div>
                    <div>🖥️ Сервер: ${d.server || 'N/A'}</div>
                    <div>⏱️ Аптайм: ${Math.floor((d.uptime || 0) / 3600)}ч ${Math.floor(((d.uptime || 0) % 3600) / 60)}м</div>
                    <div>💾 Память: ${Math.floor((d.memory?.rss || 0) / 1024 / 1024)} MB</div>
                `;
            }
        });
}

function saveSettings() {
    localStorage.setItem('autoReconnect', document.getElementById('autoReconnect').checked);
    localStorage.setItem('antiKick', document.getElementById('antiKick').checked);
    localStorage.setItem('notifications', document.getElementById('notifications').checked);
    localStorage.setItem('sound', document.getElementById('sound').checked);
    localStorage.setItem('refreshInterval', document.getElementById('refreshInterval').value);
    
    const interval = parseInt(document.getElementById('refreshInterval').value) * 1000;
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(refreshBots, interval);
    
    addChatMessage('SYSTEM', '💾 Настройки сохранены');
}

function initTelegram() {
    const token = document.getElementById('telegramToken')?.value;
    if (token) {
        localStorage.setItem('telegramToken', token);
        fetch('/api/telegram/init', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token })
        });
        addChatMessage('SYSTEM', '🤖 Telegram бот запущен');
    }
}

function initDiscord() {
    const webhook = document.getElementById('discordWebhook')?.value;
    if (webhook) {
        localStorage.setItem('discordWebhook', webhook);
        addChatMessage('SYSTEM', '🔗 Discord webhook сохранен');
    }
}

// ============= CHAT =============
function sendMessage() {
    const input = document.getElementById('chatInput');
    const msg = input?.value.trim();
    if (msg) {
        fetch('/api/chat/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: msg })
        });
        input.value = '';
    }
}

function handleChatKey(e) {
    if (e.key === 'Enter') sendMessage();
}

function clearChat() {
    chatLog = [];
    updateChat();
    addChatMessage('SYSTEM', '🗑️ Чат очищен');
}

function updateChat() {
    const container = document.getElementById('chatMessages');
    if (!container) return;
    
    if (!chatLog.length) {
        container.innerHTML = '<div class="empty-state">💭 Добро пожаловать в чат!</div>';
        return;
    }
    
    container.innerHTML = chatLog.slice(-30).map(msg => `
        <div class="chat-message">
            <span class="chat-author">[${msg.type || 'INFO'}]</span>
            <span>${msg.message || ''}</span>
            <span style="font-size:10px; color:var(--text-muted); float:right;">${msg.timestamp || ''}</span>
        </div>
    `).join('');
    container.scrollTop = container.scrollHeight;
}

function addChatMessage(type, message) {
    chatLog.push({
        type: type,
        message: message,
        timestamp: new Date().toLocaleTimeString('ru-RU')
    });
    updateChat();
    updateEventsLog();
}

function openMessageModal() {
    fetch('/api/bots')
        .then(r => r.json())
        .then(data => {
            const select = document.getElementById('singleBotSelect');
            if (select) {
                select.innerHTML = '<option value="">Выберите бота</option>';
                data.bots.forEach(bot => {
                    select.innerHTML += `<option value="${bot.id}">${bot.username} ${bot.online ? '🟢' : '🔴'}</option>`;
                });
            }
        });
    document.getElementById('messageModal').style.display = 'flex';
}

function sendMessageToBots() {
    const target = document.getElementById('messageTarget')?.value;
    const message = document.getElementById('messageText')?.value.trim();
    const botId = document.getElementById('singleBotSelect')?.value;
    
    if (!message) {
        alert('Введите сообщение');
        return;
    }
    
    let url = '/api/bots/say-all';
    let body = { message };
    
    if (target === 'single' && botId) {
        url = `/api/bot/${botId}/say`;
    } else if (target === 'selected') {
        if (selectedBots.size === 0) {
            alert('Выберите ботов через чекбоксы');
            return;
        }
        url = '/api/bots/say-selected';
        body = { botIds: Array.from(selectedBots), message };
    }
    
    fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    }).then(() => {
        closeModal('messageModal');
        document.getElementById('messageText').value = '';
        addChatMessage('SYSTEM', `📨 Сообщение отправлено: ${message}`);
    });
}

function exportConfig() {
    const config = {
        bots: bots,
        triggers: triggers,
        groups: groups,
        waypoints: waypoints,
        templates: templates,
        schedules: schedules,
        killList: killList,
        exportDate: new Date().toISOString()
    };
    
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `iminvisible_config_${Date.now()}.json`;
    a.click();
    addChatMessage('SYSTEM', '💾 Конфигурация экспортирована');
}

function closeModal(id) {
    const modal = document.getElementById(id);
    if (modal) modal.style.display = 'none';
}

// ============= SOCKET EVENTS =============
socket.on('connect', () => {
    console.log('✅ Подключено к серверу');
    refreshBots();
    loadTriggers();
    loadGroups();
    loadWaypoints();
    
    if (Notification.permission !== 'granted' && Notification.permission !== 'denied') {
        Notification.requestPermission();
    }
});

socket.on('bot_status', (status) => {
    if (status.bots) bots = status.bots;
    updateDashboard();
    updateBotsList();
    update3DMap();
});

socket.on('chat', (msg) => {
    if (Array.isArray(msg)) {
        chatLog = msg;
    } else {
        chatLog.push(msg);
    }
    updateChat();
    updateEventsLog();
    
    if (localStorage.getItem('notifications') !== 'false' && Notification.permission === 'granted') {
        new Notification('ImInvisible', { body: msg.message || 'Новое сообщение' });
    }
});

socket.on('triggers', (data) => {
    if (data.triggers) triggers = data.triggers;
    updateTriggersList();
});

socket.on('stats', (stats) => {
    combatStats = stats.combat || combatStats;
    updateDashboard();
    updateCombatPage();
});

// ============= INITIALIZATION =============
let refreshTimer;

function init() {
    const savedTheme = localStorage.getItem('theme') || 'dark';
    setTheme(savedTheme);
    
    const interval = parseInt(localStorage.getItem('refreshInterval') || 5) * 1000;
    refreshTimer = setInterval(refreshBots, interval);
    
    refreshBots();
    init3DMap();
    
    // Загрузка сохраненных данных
    const savedKillList = localStorage.getItem('killList');
    if (savedKillList) killList = JSON.parse(savedKillList);
    
    const savedScript = localStorage.getItem('savedScript');
    if (savedScript && document.getElementById('scriptEditor')) {
        document.getElementById('scriptEditor').value = savedScript;
    }
    
    // Event listeners
    const searchInput = document.getElementById('searchInput');
    if (searchInput) searchInput.addEventListener('input', () => updateBotsList());
    
    const messageTarget = document.getElementById('messageTarget');
    if (messageTarget) {
        messageTarget.addEventListener('change', function() {
            const singleBotDiv = document.getElementById('singleBotDiv');
            if (singleBotDiv) {
                singleBotDiv.style.display = this.value === 'single' ? 'block' : 'none';
            }
        });
    }
    
    window.addEventListener('resize', () => {
        if (renderer && document.getElementById('map3d')) {
            const container = document.getElementById('map3d');
            renderer.setSize(container.clientWidth, container.clientHeight);
            camera.aspect = container.clientWidth / container.clientHeight;
            camera.updateProjectionMatrix();
        }
    });
    
    addChatMessage('SYSTEM', '🎮 ImInvisible Pro v6.0 готов к работе!');
}

// Запуск
init();
