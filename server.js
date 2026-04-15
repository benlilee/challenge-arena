const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || '/tmp';
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin888';
const RESET_DAY = 2; // 每周二清空排行榜（0=周日，1=周一，2=周二...）

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname + '/public'));

const defaultData = {
    champion: { name: '等待挑战', def: 0, since: null },
    questions: [
        { t: '1+1=?', o: { a: '1', b: '2', c: '3', d: '4' }, a: 'b' },
        { t: '太阳从哪边升起?', o: { a: '西', b: '东', c: '南', d: '北' }, a: 'b' },
        { t: '一年有几个季节?', o: { a: '2', b: '3', c: '4', d: '5' }, a: 'c' }
    ],
    records: [],
    hallOfFame: [],
    leaderboard: [],
    challenged: false,
    questionsPerRound: 3,
    questionBankSize: 50,   // 题库总题数（随机抽题用）
    // ===== 新增：限访客 + 每周清空 =====
    visitorLog: {},         // { ip: { count: N, weekStart: timestamp } }
    lastResetDate: null     // 上次清空日期（YYYY-MM-DD）
};

function readData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
            if (!d.hallOfFame) d.hallOfFame = [];
            if (!d.leaderboard) d.leaderboard = [];
            if (!d.champion.since) d.champion.since = null;
            if (!d.visitorLog) d.visitorLog = {};
            if (!d.lastResetDate) d.lastResetDate = null;
            return d;
        }
    } catch (e) {}
    return JSON.parse(JSON.stringify(defaultData));
}

function saveData(data) {
    try {
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    } catch (e) { console.error('Save error:', e); }
}

// ===== 每周固定日期自动清空排行榜 =====
function checkWeeklyReset(data) {
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10); // YYYY-MM-DD
    const dayOfWeek = now.getDay(); // 0=周日,2=周二...

    // 每次服务启动时检查
    if (data.lastResetDate !== todayStr && dayOfWeek === RESET_DAY) {
        console.log('📅 每周清空日（周' + (RESET_DAY + 1) + '），清空排行榜...');
        data.leaderboard = []; // 只清空排行榜，保留挑战记录
        data.lastResetDate = todayStr;
        saveData(data);
        console.log('✅ 排行榜已清空');
    }
}

// ===== 限访客：同一名字一周内不超过3次 =====
function checkVisitorLimit(data, name) {
    const now = Date.now();
    // 周起始（周一 00:00）
    const weekStart = now - ((now / 86400000 | 0) % 7) * 86400000 - (new Date().getHours() * 3600 + new Date().getMinutes() * 60 + new Date().getSeconds()) * 1000;

    if (!data.visitorLog[name] || data.visitorLog[name].weekStart < weekStart) {
        // 新的一周，重置计数
        data.visitorLog[name] = { count: 0, weekStart: weekStart };
    }

    if (data.visitorLog[name].count >= 3) {
        return false; // 已被限制
    }

    data.visitorLog[name].count++;
    return true; // 可以访问
}

// 更新排行榜
function updateLeaderboard(data, challenger, success, correct, total, timeCost) {
    let entry = data.leaderboard.find(e => e.name === challenger);
    if (!entry) {
        entry = { name: challenger, score: 0, wins: 0, attempts: 0, bestCorrect: 0, lastTimes: [] };
        data.leaderboard.push(entry);
    }
    entry.attempts++;
    entry.bestCorrect = Math.max(entry.bestCorrect, correct);
    if (timeCost && timeCost > 0) {
        if (!entry.lastTimes) entry.lastTimes = [];
        entry.lastTimes.unshift({ time: timeCost, date: new Date().toLocaleDateString('zh-CN'), success });
        if (entry.lastTimes.length > 2) entry.lastTimes = entry.lastTimes.slice(0, 2);
    }
    if (success) {
        entry.wins++;
        entry.score += 100;
    } else {
        entry.score += correct * 10;
    }
    data.leaderboard.sort((a, b) => b.score - a.score);
}

// 将擂主加入名人堂
function addToHallOfFame(data, champion) {
    if (champion.name === '等待挑战') return;
    const existing = data.hallOfFame.find(e => e.name === champion.name);
    if (existing) {
        existing.totalDef += champion.def;
        existing.reigns++;
        existing.lastReign = new Date().toLocaleDateString('zh-CN');
    } else {
        data.hallOfFame.push({
            name: champion.name,
            totalDef: champion.def,
            reigns: 1,
            since: champion.since || new Date().toLocaleDateString('zh-CN'),
            lastReign: new Date().toLocaleDateString('zh-CN')
        });
    }
    data.hallOfFame.sort((a, b) => b.totalDef - a.totalDef);
}

// 验证管理员token
const adminTokens = new Set();
function generateToken() {
    const token = crypto.randomBytes(32).toString('hex');
    adminTokens.add(token);
    setTimeout(() => adminTokens.delete(token), 24 * 60 * 60 * 1000);
    return token;
}
function verifyToken(req) {
    const token = req.headers['x-admin-token'] || req.query.token;
    return adminTokens.has(token);
}

// 获取客户端 IP（兼容代理）
function getClientIp(req) {
    return req.headers['x-forwarded-for']?.split(',')[0].trim()
        || req.headers['x-real-ip']
        || req.connection?.remoteAddress
        || req.socket?.remoteAddress
        || '';
}

// Fisher-Yates 打乱数组
function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

// ===== API =====

app.get('/api/game', (req, res) => {
    const data = readData();
    const perRound = data.questionsPerRound || 3;

    // 从题库随机抽题（每人题目顺序不同）
    const shuffled = shuffle(data.questions);
    const selected = shuffled.slice(0, Math.min(perRound, shuffled.length));

    res.json({
        champion: data.champion,
        questions: selected,
        questionCount: perRound,
        totalChallenges: data.records.length
    });
});

app.get('/api/leaderboard', (req, res) => {
    res.json(readData().leaderboard.slice(0, 20));
});

app.get('/api/hall-of-fame', (req, res) => {
    res.json(readData().hallOfFame);
});

app.post('/api/challenge', (req, res) => {
    const { challenger, success, correct, timeCost } = req.body;
    const data = readData();

    // 限访客检查（按名字）
    if (!checkVisitorLimit(data, challenger)) {
        return res.status(403).json({
            success: false,
            message: '⛔ 本周挑战次数已达上限（3次），请下周再来！'
        });
    }

    const isFirst = !data.challenged;
    data.challenged = true;

    data.records.unshift({
        challenger,
        champion: data.champion.name,
        success,
        correct,
        total: data.questionsPerRound || 3,
        submitTime: new Date().toLocaleString('zh-CN')
    });

    updateLeaderboard(data, challenger, success, correct, data.questionsPerRound || 3, timeCost);

    if (success && isFirst) {
        addToHallOfFame(data, data.champion);
        data.champion = { name: challenger, def: 0, since: new Date().toLocaleDateString('zh-CN') };
        data.challenged = false;
        saveData(data);
        res.json({ success: true, champion: data.champion, message: '🏆 恭喜 ' + challenger + ' 成为新擂主！', isNewChampion: true });
    } else if (success) {
        data.champion.def++;
        data.challenged = false;
        saveData(data);
        res.json({ success: false, champion: data.champion, message: '🎉 ' + challenger + ' 答对了！但已被抢先一步！', isNewChampion: false });
    } else {
        data.champion.def++;
        data.challenged = false;
        saveData(data);
        res.json({ success: false, champion: data.champion, message: '💀 ' + data.champion.name + ' 守擂成功！' });
    }
});

app.get('/api/records', (req, res) => {
    res.json(readData().records);
});

// 管理员登录
app.post('/api/admin/login', (req, res) => {
    const { password } = req.body;
    if (password === ADMIN_PASSWORD) {
        const token = generateToken();
        res.json({ success: true, token });
    } else {
        res.status(401).json({ success: false, message: '密码错误' });
    }
});

app.get('/api/admin/data', (req, res) => {
    if (!verifyToken(req)) return res.status(401).json({ error: '未授权' });
    res.json(readData());
});

app.get('/api/admin/questions/full', (req, res) => {
    if (!verifyToken(req)) return res.status(401).json({ error: '未授权' });
    const data = readData();
    res.json({ questions: data.questions, questionCount: data.questionsPerRound });
});

app.post('/api/admin/champion', (req, res) => {
    if (!verifyToken(req)) return res.status(401).json({ error: '未授权' });
    const data = readData();
    data.champion = { name: req.body.name, def: 0, since: new Date().toLocaleDateString('zh-CN') };
    saveData(data);
    res.json({ success: true, champion: data.champion });
});

app.post('/api/admin/questions', (req, res) => {
    if (!verifyToken(req)) return res.status(401).json({ error: '未授权' });
    const data = readData();
    data.questions = req.body.questions;
    if (req.body.questionsPerRound) data.questionsPerRound = req.body.questionsPerRound;
    saveData(data);
    res.json({ success: true, questions: data.questions, questionsPerRound: data.questionsPerRound });
});

app.post('/api/admin/leaderboard/clear', (req, res) => {
    if (!verifyToken(req)) return res.status(401).json({ error: '未授权' });
    const data = readData();
    data.leaderboard = [];
    saveData(data);
    res.json({ success: true });
});

app.post('/api/admin/hall-of-fame/clear', (req, res) => {
    if (!verifyToken(req)) return res.status(401).json({ error: '未授权' });
    const data = readData();
    data.hallOfFame = [];
    saveData(data);
    res.json({ success: true });
});

// 手动清空记录（不受周限制，管理员用）
app.post('/api/admin/records/clear', (req, res) => {
    if (!verifyToken(req)) return res.status(401).json({ error: '未授权' });
    const data = readData();
    data.records = [];
    saveData(data);
    res.json({ success: true });
});

// ===== 启动 =====
const data = readData();
checkWeeklyReset(data); // 启动时检查每周清空
saveData(data); // 确保新字段写入磁盘

app.get('*', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

app.listen(PORT, () => {
    console.log('Server running on port ' + PORT);
    console.log('Admin password: ' + ADMIN_PASSWORD);
    console.log('Reset day: 每周周' + (RESET_DAY + 1) + '自动清空记录');
});
