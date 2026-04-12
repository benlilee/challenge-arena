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
    hallOfFame: [],      // 历届擂主名人堂
    leaderboard: [],     // 挑战者积分排行榜
    challenged: false,
    questionsPerRound: 3
};

function readData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
            if (!d.hallOfFame) d.hallOfFame = [];
            if (!d.leaderboard) d.leaderboard = [];
            if (!d.champion.since) d.champion.since = null;
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

// 更新排行榜
function updateLeaderboard(data, challenger, success, correct, total, timeCost) {
    let entry = data.leaderboard.find(e => e.name === challenger);
    if (!entry) {
        entry = { name: challenger, score: 0, wins: 0, attempts: 0, bestCorrect: 0, lastTimes: [] };
        data.leaderboard.push(entry);
    }
    entry.attempts++;
    entry.bestCorrect = Math.max(entry.bestCorrect, correct);

    // 记录最近两次答题时间
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
    // 按守擂次数排序
    data.hallOfFame.sort((a, b) => b.totalDef - a.totalDef);
}

// 验证管理员token
const adminTokens = new Set();
function generateToken() {
    const token = crypto.randomBytes(32).toString('hex');
    adminTokens.add(token);
    setTimeout(() => adminTokens.delete(token), 24 * 60 * 60 * 1000); // 24小时过期
    return token;
}
function verifyToken(req) {
    const token = req.headers['x-admin-token'] || req.query.token;
    return adminTokens.has(token);
}

// ===== API =====

app.get('/api/game', (req, res) => {
    const data = readData();
    const perRound = data.questionsPerRound || 3;
    res.json({
        champion: data.champion,
        questions: data.questions.slice(0, perRound),
        questionCount: perRound,
        totalChallenges: data.records.length
    });
});

app.get('/api/leaderboard', (req, res) => {
    const data = readData();
    res.json(data.leaderboard.slice(0, 20));
});

app.get('/api/hall-of-fame', (req, res) => {
    const data = readData();
    res.json(data.hallOfFame);
});

app.post('/api/challenge', (req, res) => {
    const { challenger, success, correct, timeCost } = req.body;
    const data = readData();
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
        const oldChampion = data.champion.name;
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

// 管理员接口（需要token）
app.get('/api/admin/data', (req, res) => {
    if (!verifyToken(req)) return res.status(401).json({ error: '未授权' });
    res.json(readData());
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

app.post('/api/admin/password', (req, res) => {
    if (!verifyToken(req)) return res.status(401).json({ error: '未授权' });
    // 密码修改需要重启服务并设置环境变量，这里只提示
    res.json({ success: false, message: '请在Railway环境变量中修改 ADMIN_PASSWORD' });
});

app.get('*', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

app.listen(PORT, () => {
    console.log('Server running on port ' + PORT);
    console.log('Admin password: ' + ADMIN_PASSWORD);
});
