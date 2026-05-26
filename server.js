const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const MemoryStore = require('memorystore')(session);
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 5e7 });
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'database.json');

// ==========================================
// BỘ CHỐNG CRASH SERVER CHO RENDER/HOSTING
// ==========================================
process.on('uncaughtException', (err) => {
    console.error('🔥 LỖI NGHIÊM TRỌNG (Nhưng server không bị sập):', err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('🔥 LỖI PROMISE (Nhưng server không bị sập):', reason);
});

// ==========================================
// 1. DATABASE
// ==========================================
function initDatabase() {
    if (!fs.existsSync(DB_FILE)) {
        const adminHash = bcrypt.hashSync('admin123@', 10);
        const initialDB = {
            users: [{
                id: "admin-id", username: "admin", phone: "0123456789", email: "admin@cherry.com",
                password: adminHash, displayName: "Hệ Thống Admin", role: "admin",
                isBanned: false, banUntil: null, isMuted: false, muteUntil: null, 
                friends: [], blocks: [], archives: [],
                gender: "secret", dob: "", bio: "Quản trị viên",
                avatar: "🛡️", customStatus: "Đang giám sát Server",
                playerClass: "sniper", elo: 9999, rank: "Thách Đấu", level: 100, gameScore: 999999
            }],
            messages: [],
            friendRequests: [],
            pinnedMessages: {},
            leaderboard: []
        };
        fs.writeFileSync(DB_FILE, JSON.stringify(initialDB, null, 2));
    }
}
initDatabase();
function readDB() { try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch(e) { return { users: [], messages: [] }; } }
function writeDB(data) { try { fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2)); } catch(e) {} }

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const sessionMiddleware = session({
    secret: 'cherry-esports-v19-super-secret',
    resave: false, saveUninitialized: false,
    store: new MemoryStore({ checkPeriod: 86400000 }),
    cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }
});
app.use(sessionMiddleware);
io.engine.use(sessionMiddleware);

// ==========================================
// 2. API XÁC THỰC
// ==========================================
app.post('/api/register', (req, res) => {
    const { username, phone, password, confirmPassword } = req.body;
    if (password !== confirmPassword) return res.status(400).json({ msg: "Mật khẩu không khớp!" });
    const db = readDB();
    if (db.users.find(u => u.username === username || u.phone === phone)) return res.status(400).json({ msg: "Tài khoản/SĐT đã tồn tại!" });
    
    const newUser = {
        id: 'user_' + Date.now(), username, phone, password: bcrypt.hashSync(password, 10),
        displayName: "", role: "user",
        isBanned: false, banUntil: null, isMuted: false, muteUntil: null,
        friends: [], blocks: [], archives: [],
        gender: "secret", dob: "", bio: "", avatar: "🌸", customStatus: "",
        playerClass: "none", elo: 1000, rank: "Đồng", level: 1, gameScore: 0
    };
    db.users.push(newUser); writeDB(db);
    req.session.userId = newUser.id;
    res.json({ success: true, msg: "Đăng ký thành công!" });
});

app.post('/api/login', (req, res) => {
    const { loginKey, password } = req.body;
    const db = readDB();
    const user = db.users.find(u => u.username === loginKey || u.phone === loginKey);
    if (!user || !bcrypt.compareSync(password, user.password)) return res.status(400).json({ msg: "Sai thông tin đăng nhập!" });
    if (user.isBanned) {
        if (!user.banUntil || new Date(user.banUntil) > new Date()) return res.status(403).json({ msg: "Tài khoản bị khóa!" });
        else { user.isBanned = false; writeDB(db); }
    }
    req.session.userId = user.id;
    if (!user.displayName) return res.json({ success: true, needProfile: true });
    res.json({ success: true, user: { id: user.id, username: user.username, displayName: user.displayName, role: user.role } });
});

app.post('/api/setup-profile', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ msg: "Unauthorized" });
    const db = readDB(); const user = db.users.find(u => u.id === req.session.userId);
    if (!user) return res.status(404).json({ msg: "Không tìm thấy user!" });
    user.displayName = req.body.displayName; writeDB(db);
    res.json({ success: true });
});

app.get('/api/me', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ msg: "Unauthorized" });
    const db = readDB(); const user = db.users.find(u => u.id === req.session.userId);
    if (!user) return res.status(404).json({ msg: "User not found" });
    res.json({ id: user.id, username: user.username, displayName: user.displayName, role: user.role, avatar: user.avatar, playerClass: user.playerClass, elo: user.elo, rank: user.rank, level: user.level, customStatus: user.customStatus });
});

app.post('/api/logout', (req, res) => { req.session.destroy(); res.json({ success: true }); });

// ==========================================
// 3. GAME ENGINE STATE 
// ==========================================
const MAP_W = 3000, MAP_H = 3000;
let gameRooms = {
    ffa: { mode: 'ffa', players: {}, bullets: [], items: [], zone: { x: 1500, y: 1500, radius: 2500 } },
    zombie: { mode: 'zombie', players: {}, bullets: [], items: [], zombies: [], wave: 1 },
    dungeon: { mode: 'dungeon', players: {}, bullets: [], items: [], bosses: [] },
    safezone: { mode: 'safezone', players: {}, items: [] }
};
const onlineUsers = {};

function spawnItems(room, count) {
    for(let i=0; i<count; i++) room.items.push({ id: Math.random().toString(), x: Math.random()*(MAP_W-100)+50, y: Math.random()*(MAP_H-100)+50, type: 'health' });
}
['ffa', 'zombie', 'dungeon', 'safezone'].forEach(m => spawnItems(gameRooms[m], 50));
function calculateRank(elo) { if(elo < 1200) return "Đồng"; if(elo < 1500) return "Bạc"; if(elo < 2000) return "Vàng"; if(elo < 2500) return "Kim Cương"; return "Thách Đấu"; }

// ==========================================
// 4. SOCKET.IO LOGIC
// ==========================================
io.on('connection', (socket) => {
    const userId = socket.request.session?.userId;
    if (!userId) return socket.disconnect();
    
    onlineUsers[userId] = socket.id;
    io.emit('userStatusChange', { userId, status: 'online' });

    // HÀM TẢI DỮ LIỆU
    socket.on('initData', () => {
        const db = readDB(); if(!db) return;
        const currentUser = db.users.find(u => u.id === userId);
        if(!currentUser) return;
        const friendsList = db.users.filter(u => u.id !== userId);
        socket.emit('userDataPackage', { 
            friends: friendsList.map(u => ({ 
                id: u.id, username: u.username, displayName: u.displayName || u.username, role: u.role, 
                isOnline: !!onlineUsers[u.id] && !u.invisible, 
                isBlocked: currentUser.blocks ? currentUser.blocks.includes(u.id) : false, 
                isArchived: currentUser.archives ? currentUser.archives.includes(u.id) : false, 
                avatar: u.avatar, customStatus: u.customStatus, 
                level: u.level || 1, elo: u.elo || 1000, rank: u.rank || 'Đồng', playerClass: u.playerClass
            })), 
            messages: db.messages.filter(m => m.from === userId || m.to === userId), 
            pinnedMessages: db.pinnedMessages || {}
        });
    });

    // CHAT
    socket.on('sendMessage', (data) => {
        const db = readDB(); const u = db.users.find(x => x.id === userId);
        if (u.isMuted && (!u.muteUntil || new Date(u.muteUntil) > new Date())) return socket.emit('actionError', "Bị cấm chat!");
        const msg = { id: 'msg_'+Date.now(), from: userId, to: data.toUserId, text: data.text||"", type: data.type||'text', imgData: data.imgData, location: data.location, replyTo: data.replyTo, timestamp: Date.now(), isEdited: false, isRecalled: false, readBy: [] };
        db.messages.push(msg); writeDB(db);
        socket.emit('receiveMessage', msg);
        if (onlineUsers[data.toUserId]) io.to(onlineUsers[data.toUserId]).emit('receiveMessage', msg);
    });
    
    socket.on('recallMessage', (msgId) => { const db = readDB(); const m = db.messages.find(x => x.id === msgId && x.from === userId); if(m) { m.isRecalled = true; m.text = ""; m.imgData = null; writeDB(db); io.emit('messageUpdated', m); } });
    socket.on('editMessage', ({msgId, newText}) => { const db = readDB(); const m = db.messages.find(x => x.id === msgId && x.from === userId); if(m && !m.isRecalled && m.type==='text') { m.text = newText; m.isEdited = true; writeDB(db); io.emit('messageUpdated', m); } });
    socket.on('updateMyProfile', (data, callback) => {
        const db = readDB(); const idx = db.users.findIndex(u => u.id === userId);
        if(idx !== -1) { 
            db.users[idx] = { ...db.users[idx], displayName: data.displayName, customStatus: data.customStatus, invisible: data.invisible, avatar: data.avatar, playerClass: data.playerClass };
            writeDB(db); io.emit('userStatusChange', { userId, status: data.invisible ? 'offline' : 'online' }); 
            socket.emit('initData'); if(callback) callback({success:true, msg: "Đã lưu!"}); 
        }
    });

    // GAME
    let myCurrentRoom = null;
    socket.on('joinGame', (mode) => {
        if(!gameRooms[mode]) return;
        myCurrentRoom = mode; socket.join(mode);
        const db = readDB(); const u = db.users.find(x => x.id === userId);
        let hp = 100, speed = 8, dmg = 10;
        if(u.playerClass === 'tanker') { hp = 250; speed = 5; dmg = 8; }
        else if(u.playerClass === 'sniper') { hp = 80; speed = 9; dmg = 45; }
        else if(u.playerClass === 'medic') { hp = 120; speed = 7; dmg = 15; }
        gameRooms[mode].players[socket.id] = {
            id: socket.id, userId: userId, name: u.displayName, avatar: u.avatar,
            x: Math.random() * (MAP_W - 400) + 200, y: Math.random() * (MAP_H - 400) + 200,
            hp: hp, maxHp: hp, stamina: 100, maxStamina: 100, nextDashTime: 0,
            baseSpeed: speed, damage: dmg, playerClass: u.playerClass,
            score: 0, color: (u.playerClass === 'sniper' ? '#ef4444' : (u.playerClass === 'tanker' ? '#3b82f6' : '#22c55e')),
            invulnerableUntil: Date.now() + 3000
        };
    });

    socket.on('respawnGame', (mode) => {
        if(myCurrentRoom === mode && gameRooms[mode] && gameRooms[mode].players[socket.id]) {
            const p = gameRooms[mode].players[socket.id];
            p.hp = p.maxHp; p.stamina = p.maxStamina;
            p.x = Math.random() * (MAP_W - 400) + 200; p.y = Math.random() * (MAP_H - 400) + 200;
            p.invulnerableUntil = Date.now() + 3000;
        }
    });

    socket.on('gameChat', (data) => {
        const db = readDB(); const u = db.users.find(x => x.id === userId);
        if(myCurrentRoom && u) io.to(myCurrentRoom).emit('gameChatReceive', `<b>[${u.displayName}]</b>: ${data.msg}`);
    });

    socket.on('leaveGame', (mode) => { if(gameRooms[mode] && gameRooms[mode].players[socket.id]) { delete gameRooms[mode].players[socket.id]; socket.leave(mode); myCurrentRoom = null; } });

    socket.on('gameInput', (data) => {
        if(!myCurrentRoom || !gameRooms[myCurrentRoom]) return;
        const p = gameRooms[myCurrentRoom].players[socket.id];
        if(!p || p.hp <= 0) return;

        let spd = p.baseSpeed;
        if (data.keys.dash && p.stamina >= 30 && Date.now() > p.nextDashTime) { spd *= 3; p.stamina -= 30; p.nextDashTime = Date.now() + 2000; }
        else if (p.stamina < p.maxStamina) { p.stamina += 0.5; }

        if (data.keys.w && p.y > 20) p.y -= spd;
        if (data.keys.s && p.y < MAP_H - 20) p.y += spd;
        if (data.keys.a && p.x > 20) p.x -= spd;
        if (data.keys.d && p.x < MAP_W - 20) p.x += spd;

        if (p.playerClass === 'medic' && p.hp < p.maxHp) p.hp += 0.05;

        if (data.isShooting && (!p.lastShot || Date.now() - p.lastShot > (p.playerClass==='sniper'?1000:200))) {
            gameRooms[myCurrentRoom].bullets.push({ id: Math.random(), ownerId: socket.id, ownerName: p.name, x: p.x, y: p.y, angle: data.aimAngle, speed: 20, damage: p.damage, range: (p.playerClass==='sniper'?1000:500), traveled: 0 });
            p.lastShot = Date.now();
        }
    });

    socket.on('disconnect', () => {
        if(myCurrentRoom && gameRooms[myCurrentRoom]) delete gameRooms[myCurrentRoom].players[socket.id];
        delete onlineUsers[userId]; io.emit('userStatusChange', { userId, status: 'offline' });
    });
});

// GAME LOOP ENGINE
setInterval(() => {
    const now = Date.now();
    ['ffa', 'zombie', 'dungeon', 'safezone'].forEach(mode => {
        const room = gameRooms[mode];
        if (Object.keys(room.players).length === 0) return;

        if (mode === 'ffa') {
            room.zone.radius -= 0.5;
            if (room.zone.radius < 50) room.zone.radius = 2500;
        }

        Object.values(room.players).forEach(p => {
            if (p.hp <= 0) return;

            // ĐÃ FIX LỖI CRASH: Thay socketId bằng p.id
            if (mode === 'ffa' && now > p.invulnerableUntil) {
                const distToCenter = Math.hypot(p.x - room.zone.x, p.y - room.zone.y);
                if (distToCenter > room.zone.radius) {
                    p.hp -= 2;
                    if (p.hp <= 0) io.to(p.id).emit('playerDied', { mode, score: p.score });
                }
            }

            room.items = room.items.filter(item => {
                const dist = Math.hypot(p.x - item.x, p.y - item.y);
                if (dist < 30) { p.hp = Math.min(p.maxHp, p.hp + 50); p.score += 10; return false; }
                return true;
            });
            if(room.items.length < 20) spawnItems(room, 5);
        });

        room.bullets = room.bullets.filter(b => {
            b.x += Math.cos(b.angle) * b.speed; b.y += Math.sin(b.angle) * b.speed; b.traveled += b.speed;
            if (b.traveled > b.range || b.x < 0 || b.x > MAP_W || b.y < 0 || b.y > MAP_H) return false;

            let hit = false;
            if (mode !== 'safezone') {
                Object.values(room.players).forEach(target => {
                    if (target.id !== b.ownerId && target.hp > 0 && now > target.invulnerableUntil) {
                        const dist = Math.hypot(b.x - target.x, b.y - target.y);
                        if (dist < 25) {
                            target.hp -= b.damage; hit = true;
                            if (target.hp <= 0) {
                                if (room.players[b.ownerId]) {
                                    room.players[b.ownerId].score += 100;
                                    io.to(target.id).emit('playerDied', { mode, score: target.score });
                                    
                                    const db = readDB(); 
                                    const winner = db.users.find(u => u.id === room.players[b.ownerId].userId);
                                    if(winner) { winner.elo += 5; winner.gameScore += 100; winner.rank = calculateRank(winner.elo); writeDB(db); }
                                }
                            }
                        }
                    }
                });
            }
            return !hit;
        });

        io.to(mode).emit('gameStateUpdate', { mode, state: room });
    });
}, 50);

// Lắng nghe trên mọi Interface mạng (Bắt buộc cho Render/Railway)
server.listen(PORT, '0.0.0.0', () => { 
    console.log(`🚀 V19 Server running on port ${PORT}`); 
});