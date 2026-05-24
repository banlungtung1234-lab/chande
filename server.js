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
const io = new Server(server, { maxHttpBufferSize: 1e7 }); 
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'database.json');

// ==========================================
// --- 1. CƠ SỞ DỮ LIỆU & BẢNG XẾP HẠNG ---
// ==========================================
function initDatabase() {
    if (!fs.existsSync(DB_FILE)) {
        const adminPasswordHash = bcrypt.hashSync('admin123@', 10);
        writeDB({
            users: [{
                id: "admin-id", username: "admin", phone: "0123456789", email: "admin@gmail.com",
                password: adminPasswordHash, displayName: "Hệ Thống Admin", role: "admin",
                isBanned: false, banUntil: null, isMuted: false, muteUntil: null, 
                friends: [], blocks: [], archives: [],
                gender: "secret", dob: "", bio: "Quản trị viên tối cao", gameScore: 0
            }],
            messages: [], friendRequests: [], leaderboard: [], dailyWinner: null
        });
    } else {
        const db = readDB();
        let needsUpdate = false;
        db.users.forEach(u => { 
            if(u.gameScore === undefined) { u.gameScore = 0; needsUpdate = true; }
            if(u.blocks === undefined) { u.blocks = []; needsUpdate = true; }
            if(u.archives === undefined) { u.archives = []; needsUpdate = true; }
            if(u.phone === undefined) { u.phone = "Chưa có"; needsUpdate = true; }
        });
        if(!db.leaderboard) { db.leaderboard = []; needsUpdate = true; }
        if(!db.dailyWinner) { db.dailyWinner = null; needsUpdate = true; }
        if(needsUpdate) writeDB(db);
    }
}
function readDB() { try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) { return { users: [], messages: [], friendRequests: [], leaderboard: [] }; } }
function writeDB(data) { try { fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2)); } catch (e) { console.error("Lỗi ghi file:", e); } }
initDatabase();

// ==========================================
// --- 2. CẤU HÌNH SERVER ---
// ==========================================
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

const sessionMiddleware = session({
    secret: 'cherry-blossom-secret-key-pro-v10',
    resave: false, saveUninitialized: true,
    store: new MemoryStore({ checkPeriod: 86400000 }), 
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
});
app.use(sessionMiddleware);
app.use(express.static(path.join(__dirname, 'public')));
io.use((socket, next) => { sessionMiddleware(socket.request, socket.request.res || {}, next); });

let onlineUsers = {}; 

// ==========================================
// --- 3. API TÀI KHOẢN CHUẨN ---
// ==========================================
app.post('/api/register', (req, res) => {
    const { username, phone, email, password, confirmPassword } = req.body;
    if (username.length < 4) return res.status(400).json({ msg: "Tên đăng nhập >= 4 ký tự!" });
    if (password !== confirmPassword) return res.status(400).json({ msg: "Mật khẩu không khớp!" });

    const db = readDB();
    if (db.users.find(u => u.username === username)) return res.status(400).json({ msg: "Tài khoản đã tồn tại!" });

    const newUser = {
        id: 'user_' + Date.now(), username, phone: phone || "Chưa có", email: email || "",
        password: bcrypt.hashSync(password, 10), displayName: "", role: "user",
        isBanned: false, banUntil: null, isMuted: false, muteUntil: null,
        friends: [], blocks: [], archives: [], gender: "secret", dob: "", bio: "", gameScore: 0
    };
    db.users.push(newUser); writeDB(db);
    req.session.userId = newUser.id;
    res.json({ msg: "Đăng ký thành công!", step: "setupProfile" });
});

app.post('/api/forgot-password', (req, res) => {
    const { username, phone, newPassword } = req.body; const db = readDB();
    const user = db.users.find(u => u.username === username && u.phone === phone);
    if (!user) return res.status(400).json({ msg: "Thông tin không chính xác!" });
    user.password = bcrypt.hashSync(newPassword, 10); writeDB(db);
    res.json({ msg: "Khôi phục mật khẩu thành công! Vui lòng đăng nhập lại." });
});

app.post('/api/setup-profile', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ msg: "Chưa đăng nhập!" });
    const db = readDB(); const user = db.users.find(u => u.id === req.session.userId);
    if(user) { user.displayName = req.body.displayName; writeDB(db); }
    res.json({ msg: "Thành công!", role: user ? user.role : 'user' });
});

app.post('/api/login', (req, res) => {
    const { loginKey, password } = req.body; const db = readDB();
    const user = db.users.find(u => u.username === loginKey || u.phone === loginKey);
    if (!user || !bcrypt.compareSync(password, user.password)) return res.status(400).json({ msg: "Sai tài khoản hoặc mật khẩu!" });
    if (user.isBanned) {
        if (user.banUntil && new Date() > new Date(user.banUntil)) { user.isBanned = false; user.banUntil = null; writeDB(db); } 
        else return res.json({ step: "banned", banUntil: user.banUntil, msg: "Tài khoản bị khóa!" });
    }
    req.session.userId = user.id;
    res.json({ msg: "Đăng nhập thành công!", role: user.role, needProfile: (!user.displayName || user.displayName.trim() === "") });
});

app.post('/api/logout', (req, res) => { req.session.destroy(); res.json({ msg: "Đã đăng xuất!" }); });

app.get('/api/me', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ msg: "Chưa đăng nhập" });
    const db = readDB(); const user = db.users.find(u => u.id === req.session.userId);
    if(!user) return res.status(404).json({ msg: "Lỗi dữ liệu" });
    if (user.isBanned) {
        if (user.banUntil && new Date() > new Date(user.banUntil)) { user.isBanned = false; user.banUntil = null; writeDB(db); } 
        else return res.status(403).json({ isBanned: true, banUntil: user.banUntil });
    }
    res.json({ id: user.id, username: user.username, displayName: user.displayName, phone: user.phone, email: user.email, role: user.role, gender: user.gender, dob: user.dob, bio: user.bio, gameScore: user.gameScore });
});


// ==========================================
// --- 4. HỆ THỐNG CHAT & ADMIN (KHÔI PHỤC) ---
// ==========================================
io.on('connection', (socket) => {
    const session = socket.request.session;
    if (!session || !session.userId) return;
    const currentUserId = session.userId;
    onlineUsers[currentUserId] = socket.id;
    io.emit('userStatusChange', { userId: currentUserId, status: 'online' });

    const checkBanStatus = () => {
        const db = readDB(); const user = db.users.find(u => u.id === currentUserId);
        if(!user) return true;
        if (user.isBanned) {
            if (user.banUntil && new Date() > new Date(user.banUntil)) { user.isBanned = false; user.banUntil = null; writeDB(db); return false; }
            socket.emit('forceBannedUI', { banUntil: user.banUntil }); return true;
        }
        return false;
    };

    socket.on('initData', () => { if(!checkBanStatus()) sendUserDataUpdate(currentUserId, socket); socket.emit('leaderboardUpdate', readDB().leaderboard); });
    socket.on('typing', (to) => { if(!checkBanStatus() && onlineUsers[to]) io.to(onlineUsers[to]).emit('userTyping', currentUserId); });
    socket.on('stopTyping', (to) => { if (onlineUsers[to]) io.to(onlineUsers[to]).emit('userStoppedTyping', currentUserId); });

    // CHAT & TƯƠNG TÁC
    socket.on('sendMessage', ({ toUserId, text, type = 'text', imgData = null }) => {
        if(checkBanStatus()) return; const db = readDB(); const sender = db.users.find(u => u.id === currentUserId); const receiver = db.users.find(u => u.id === toUserId);
        if (!sender || !receiver) return;
        if (sender.isMuted && sender.muteUntil && new Date() > new Date(sender.muteUntil)) { sender.isMuted = false; sender.muteUntil = null; writeDB(db); }
        if (sender.isMuted && sender.role !== 'admin') return socket.emit('actionError', "Bạn bị cấm nhắn tin.");
        if (sender.role !== 'admin' && receiver.role !== 'admin') {
            if (receiver.blocks && receiver.blocks.includes(currentUserId)) return socket.emit('actionError', "Không thể gửi. Bị chặn!");
            if (sender.blocks && sender.blocks.includes(toUserId)) return socket.emit('actionError', "Bạn đang chặn người này!");
        }
        const msgObj = { id: 'msg_' + Date.now(), from: currentUserId, to: toUserId, type, text, imgData, timestamp: new Date().toISOString(), isEdited: false, isRecalled: false };
        db.messages.push(msgObj); writeDB(db);
        socket.emit('receiveMessage', msgObj);
        if (onlineUsers[toUserId]) { io.to(onlineUsers[toUserId]).emit('receiveMessage', msgObj); io.to(onlineUsers[toUserId]).emit('msgPopupNotification', { fromName: sender.displayName, text: type === 'image' ? '📸 Đã gửi ảnh' : text }); }
    });

    socket.on('updateMyProfile', (data, cb) => {
        if(checkBanStatus()) return; const db = readDB(); const user = db.users.find(u => u.id === currentUserId);
        user.displayName = data.displayName; user.phone = data.phone; user.email = data.email; user.gender = data.gender; user.dob = data.dob; user.bio = data.bio; writeDB(db); 
        cb({ success: true, msg: "Lưu hồ sơ thành công!" }); sendUserDataUpdate(currentUserId, socket);
    });

    socket.on('changePasswordInternal', ({ oldPass, newPass }, cb) => {
        if(checkBanStatus()) return; const db = readDB(); const user = db.users.find(u => u.id === currentUserId);
        if (user && bcrypt.compareSync(oldPass, user.password)) { user.password = bcrypt.hashSync(newPass, 10); writeDB(db); cb({ success: true, msg: "Đổi pass thành công!" }); } else cb({ success: false, msg: "Pass cũ sai!" });
    });

    // TÌM KIẾM & BẠN BÈ
    socket.on('searchUser', (q) => { if(!checkBanStatus()){ const db = readDB(); socket.emit('searchResults', db.users.filter(u => u.id !== currentUserId && u.role !== 'admin' && (u.username.includes(q) || u.phone.includes(q))).map(u => ({ id: u.id, displayName: u.displayName || u.username, username: u.username }))); }});
    socket.on('sendFriendRequest', (targetId) => {
        if(checkBanStatus()) return; const db = readDB(); if (db.friendRequests.find(r => (r.from === currentUserId && r.to === targetId) || (r.from === targetId && r.to === currentUserId))) return;
        const sender = db.users.find(u => u.id === currentUserId); const request = { id: 'req_' + Date.now(), from: currentUserId, to: targetId, fromName: sender.displayName || sender.username };
        db.friendRequests.push(request); writeDB(db);
        if (onlineUsers[targetId]) { io.to(onlineUsers[targetId]).emit('newFriendRequest', request); sendUserDataUpdate(targetId, io.to(onlineUsers[targetId])); }
        sendUserDataUpdate(currentUserId, socket);
    });
    socket.on('respondFriendRequest', ({ requestId, action }) => {
        let db = readDB(); const reqIdx = db.friendRequests.findIndex(r => r.id === requestId); if (reqIdx === -1) return;
        const request = db.friendRequests[reqIdx];
        if (action === 'accept') { const uA = db.users.find(u => u.id === request.from), uB = db.users.find(u => u.id === request.to); if (uA && uB) { if (!uA.friends.includes(uB.id)) uA.friends.push(uB.id); if (!uB.friends.includes(uA.id)) uB.friends.push(uA.id); } }
        db.friendRequests.splice(reqIdx, 1); writeDB(db);
        if (onlineUsers[request.from]) sendUserDataUpdate(request.from, io.to(onlineUsers[request.from])); if (onlineUsers[request.to]) sendUserDataUpdate(request.to, io.to(onlineUsers[request.to]));
    });
    socket.on('toggleBlock', (tId) => { if(checkBanStatus()) return; const db = readDB(); const u = db.users.find(x => x.id === currentUserId); const idx = u.blocks.indexOf(tId); if (idx > -1) u.blocks.splice(idx, 1); else u.blocks.push(tId); writeDB(db); sendUserDataUpdate(currentUserId, socket); if(onlineUsers[tId]) sendUserDataUpdate(tId, io.to(onlineUsers[tId])); });
    socket.on('toggleArchive', (tId) => { if(checkBanStatus()) return; const db = readDB(); const u = db.users.find(x => x.id === currentUserId); const idx = u.archives.indexOf(tId); if (idx > -1) u.archives.splice(idx, 1); else u.archives.push(tId); writeDB(db); sendUserDataUpdate(currentUserId, socket); });

    // --- ADMIN (ĐÃ KHÔI PHỤC HOÀN TOÀN TÍNH NĂNG) ---
    socket.on('verifyAdminAuth', (pass, cb) => { const db = readDB(); const a = db.users.find(u => u.id === currentUserId && u.role === 'admin'); if (a && bcrypt.compareSync(pass, a.password)) cb({ success: true }); else cb({ success: false, msg: "Sai mật mã!" }); });
    socket.on('adminGetUsers', () => { const db = readDB(); if (db.users.find(u => u.id === currentUserId && u.role === 'admin')) socket.emit('adminUsersList', db.users.map(u => ({ id: u.id, username: u.username, displayName: u.displayName, phone: u.phone, email: u.email, role: u.role, isBanned: u.isBanned, banUntil: u.banUntil, isMuted: u.isMuted, muteUntil: u.muteUntil, isOnline: !!onlineUsers[u.id] }))); });
    
    // Đổi tên + Đổi Pass cho người dùng
    socket.on('adminEditUser', (data) => {
        const db = readDB(); if (db.users.find(u => u.id === currentUserId && u.role === 'admin')) {
            const targetUser = db.users.find(u => u.id === data.id);
            if (targetUser) {
                if(data.displayName) targetUser.displayName = data.displayName;
                if(data.newPassword) targetUser.password = bcrypt.hashSync(data.newPassword, 10);
                writeDB(db); socket.emit('actionSuccess', "Cập nhật thành công!");
                socket.emit('adminUsersList', db.users.map(u => ({ id: u.id, username: u.username, displayName: u.displayName, phone: u.phone, email: u.email, role: u.role, isBanned: u.isBanned, banUntil: u.banUntil, isMuted: u.isMuted, muteUntil: u.muteUntil, isOnline: !!onlineUsers[u.id] })));
            }
        }
    });

    socket.on('adminPunishUser', ({ targetId, action, durationMinutes }, cb) => {
        const db = readDB(); if (db.users.find(u => u.id === currentUserId && u.role === 'admin')) {
            const target = db.users.find(u => u.id === targetId && u.role !== 'admin');
            if(target) {
                let expireTime = null; if (durationMinutes !== 'infinite') expireTime = new Date(Date.now() + parseInt(durationMinutes) * 60000).toISOString();
                if (action === 'mute') { target.isMuted = true; target.muteUntil = expireTime; target.isBanned = false; target.banUntil = null; } 
                else if (action === 'ban') { target.isBanned = true; target.banUntil = expireTime; target.isMuted = false; target.muteUntil = null; } 
                else if (action === 'unpunish') { target.isBanned = false; target.banUntil = null; target.isMuted = false; target.muteUntil = null; }
                writeDB(db); if(cb) cb(); 
                if(onlineUsers[targetId]) {
                    if(action === 'ban') io.to(onlineUsers[targetId]).emit('forceBannedUI', { banUntil: target.banUntil });
                    else if (action === 'mute') io.to(onlineUsers[targetId]).emit('actionError', "Bạn bị cấm nhắn tin.");
                    else if (action === 'unpunish') { io.to(onlineUsers[targetId]).emit('actionSuccess', "Đã gỡ án phạt!"); io.to(onlineUsers[targetId]).emit('unbanned'); }
                }
            }
        }
    });
    socket.on('adminGetChat', (targetId) => { const db = readDB(); if (db.users.find(u => u.id === currentUserId && u.role === 'admin')) socket.emit('adminChatData', db.messages.filter(m => (m.from === currentUserId && m.to === targetId) || (m.from === targetId && m.to === currentUserId))); });


    // =====================================
    // --- 5. GAME ENGINE SIÊU TO (V10) ---
    // =====================================
    const MAP_WIDTH = 3000;
    const MAP_HEIGHT = 3000;

    socket.on('gameInput', ({ mode, roomId, keys, aimAngle, isShooting }) => {
        try {
            let room = null;
            if(mode === 'ffa') room = ffaGameState;
            else if(mode === 'zombie') room = zombieGameState;
            else if(mode === 'pk') room = pkRooms[roomId];
            
            if(room && (mode !== 'pk' || room.status === 'playing')) {
                const p = room.players[socket.id];
                if(p && p.hp > 0) {
                    p.keys = keys;
                    if(isShooting && (!p.lastShot || Date.now() - p.lastShot > 150)) { 
                        p.lastShot = Date.now();
                        room.bullets.push({ x: p.x, y: p.y, vx: Math.cos(aimAngle)*15, vy: Math.sin(aimAngle)*15, ownerId: socket.id, life: 80 });
                    }
                }
            }
        } catch(e) {}
    });

    // Khởi tạo Player
    function spawnPlayer(mode) {
        const db = readDB(); const user = db.users.find(u => u.id === currentUserId); if(!user) return null;
        return { 
            id: socket.id, userId: currentUserId, name: user.displayName || user.username, 
            x: Math.random() * (MAP_WIDTH - 200) + 100, y: Math.random() * (MAP_HEIGHT - 200) + 100, 
            color: mode==='zombie' ? '#3b82f6' : `hsl(${Math.random() * 360}, 100%, 70%)`, 
            hp: 100, score: 0, keys: { w: false, a: false, s: false, d: false } 
        };
    }

    socket.on('joinGame', (mode) => {
        if(checkBanStatus()) return;
        if(mode === 'ffa') { socket.join('ffaGameRoom'); ffaGameState.players[socket.id] = spawnPlayer('ffa'); }
        else if(mode === 'zombie') { socket.join('zombieGameRoom'); zombieGameState.players[socket.id] = spawnPlayer('zombie'); }
    });

    socket.on('leaveGame', (mode) => {
        try {
            if(mode === 'ffa') { socket.leave('ffaGameRoom'); delete ffaGameState.players[socket.id]; }
            else if(mode === 'zombie') { socket.leave('zombieGameRoom'); delete zombieGameState.players[socket.id]; }
        } catch(e){}
    });

    socket.on('respawnGame', (mode) => {
        if(checkBanStatus()) return;
        if(mode === 'ffa' && ffaGameState.players[socket.id]) { ffaGameState.players[socket.id] = spawnPlayer('ffa'); }
        else if(mode === 'zombie' && zombieGameState.players[socket.id]) { zombieGameState.players[socket.id] = spawnPlayer('zombie'); }
    });

    // PK Mode
    socket.on('invitePK', (targetId) => { if(checkBanStatus()) return; if(onlineUsers[targetId]) { const db = readDB(); const sender = db.users.find(u => u.id === currentUserId); io.to(onlineUsers[targetId]).emit('pkInviteReceived', { fromId: currentUserId, fromName: sender.displayName || sender.username }); } else socket.emit('actionError', "Đối thủ không online!"); });
    socket.on('declinePK', (inviterId) => { if(onlineUsers[inviterId]) io.to(onlineUsers[inviterId]).emit('actionError', "Đối thủ đã từ chối."); });
    socket.on('acceptPK', (inviterId) => {
        if(checkBanStatus()) return; const inviterSocketId = onlineUsers[inviterId]; if(!inviterSocketId) return socket.emit('actionError', "Người mời đã thoát mạng!");
        const roomId = 'pk_' + Date.now(); socket.join(roomId); io.sockets.sockets.get(inviterSocketId)?.join(roomId);
        const db = readDB(); const p1 = db.users.find(u => u.id === inviterId); const p2 = db.users.find(u => u.id === currentUserId);
        pkRooms[roomId] = { id: roomId, status: 'waiting', players: { [inviterSocketId]: { id: inviterSocketId, userId: p1.id, name: p1.displayName || p1.username, x: MAP_WIDTH/2 - 200, y: MAP_HEIGHT/2, color: '#f87171', hp: 100, score: 0 }, [socket.id]: { id: socket.id, userId: p2.id, name: p2.displayName || p2.username, x: MAP_WIDTH/2 + 200, y: MAP_HEIGHT/2, color: '#60a5fa', hp: 100, score: 0 } }, bullets: [] };
        io.to(roomId).emit('pkRoomJoined', pkRooms[roomId]);
    });
    socket.on('startPK', (roomId) => {
        if(pkRooms[roomId] && pkRooms[roomId].status === 'waiting' && Object.keys(pkRooms[roomId].players).length === 2) {
            pkRooms[roomId].status = 'playing'; let i = 0;
            for(let sid in pkRooms[roomId].players) { let p = pkRooms[roomId].players[sid]; p.hp = 100; p.score = 0; p.x = i === 0 ? MAP_WIDTH/2 - 200 : MAP_WIDTH/2 + 200; p.y = MAP_HEIGHT/2; i++; }
            pkRooms[roomId].bullets = []; io.to(roomId).emit('pkGameStarted', pkRooms[roomId]);
        }
    });
    socket.on('leavePK', (roomId) => { socket.leave(roomId); if(pkRooms[roomId]) { delete pkRooms[roomId].players[socket.id]; io.to(roomId).emit('actionError', "Đối phương đã thoát phòng."); io.to(roomId).emit('pkRoomClosed'); delete pkRooms[roomId]; } });

    socket.on('disconnect', () => { 
        delete onlineUsers[currentUserId]; io.emit('userStatusChange', { userId: currentUserId, status: 'offline' }); 
        delete ffaGameState.players[socket.id]; delete zombieGameState.players[socket.id];
        for(let roomId in pkRooms) { if(pkRooms[roomId].players[socket.id]) { delete pkRooms[roomId].players[socket.id]; io.to(roomId).emit('actionError', "Đối thủ đã mất kết nối!"); io.to(roomId).emit('pkRoomClosed'); delete pkRooms[roomId]; } }
    });
});

// =====================================
// --- 6. VÒNG LẶP CHỐNG SẬP GAME ---
// =====================================
let ffaGameState = { players: {}, bullets: [] };
let zombieGameState = { players: {}, bullets: [], zombies: [] };
let pkRooms = {};
const MAP_WIDTH = 3000; const MAP_HEIGHT = 3000;

function saveScore(userId, score, mode) {
    if(score < 10) return; // Chỉ lưu nếu có chơi đàng hoàng
    const db = readDB(); const user = db.users.find(u => u.id === userId); if(!user) return;
    db.leaderboard.push({ name: user.displayName || user.username, score: score, mode: mode, date: new Date().toISOString() });
    db.leaderboard.sort((a,b) => b.score - a.score);
    db.leaderboard = db.leaderboard.slice(0, 50); // Lưu top 50
    writeDB(db);
}

setInterval(() => {
    try {
        const handleMovement = (players, speed = 6) => {
            for(let sid in players) {
                let p = players[sid];
                if(p && p.hp > 0 && p.keys) {
                    if(p.keys.w && p.y > 20) p.y -= speed;
                    if(p.keys.s && p.y < MAP_HEIGHT - 20) p.y += speed;
                    if(p.keys.a && p.x > 20) p.x -= speed;
                    if(p.keys.d && p.x < MAP_WIDTH - 20) p.x += speed;
                }
            }
        };

        // 1. FFA ENGINE
        handleMovement(ffaGameState.players, 6);
        ffaGameState.bullets.forEach(b => { b.x += b.vx; b.y += b.vy; b.life--; });
        ffaGameState.bullets = ffaGameState.bullets.filter(b => b.life > 0);
        ffaGameState.bullets.forEach(b => {
            for(let id in ffaGameState.players) {
                let p = ffaGameState.players[id];
                if(p && p.hp > 0 && b.ownerId !== id && Math.hypot(p.x - b.x, p.y - b.y) < 22) { 
                    p.hp -= 20; b.life = 0; 
                    if(p.hp <= 0) {
                        saveScore(p.userId, p.score, 'FFA Tự Do');
                        io.to(id).emit('playerDied', { score: p.score, mode: 'ffa' });
                        if(ffaGameState.players[b.ownerId]) ffaGameState.players[b.ownerId].score += 50;
                    }
                }
            }
        });
        io.to('ffaGameRoom').emit('gameStateUpdate', { mode: 'ffa', state: ffaGameState });

        // 2. ZOMBIE ENGINE (CO-OP PVE - CHẾT LÀ HẾT)
        handleMovement(zombieGameState.players, 6);
        zombieGameState.bullets.forEach(b => { b.x += b.vx; b.y += b.vy; b.life--; });
        zombieGameState.bullets = zombieGameState.bullets.filter(b => b.life > 0);
        
        let alivePlayersCount = Object.values(zombieGameState.players).filter(p => p.hp > 0).length;
        if(alivePlayersCount > 0 && zombieGameState.zombies.length < alivePlayersCount * 25 && Math.random() < 0.1) {
            // Spawn zombie quanh người chơi ngẫu nhiên (Cách xa khoảng 500-800px)
            let randomP = Object.values(zombieGameState.players).find(p => p.hp > 0);
            if(randomP) {
                let angle = Math.random() * Math.PI * 2; let dist = 600 + Math.random() * 300;
                let zx = randomP.x + Math.cos(angle)*dist; let zy = randomP.y + Math.sin(angle)*dist;
                if(zx > 0 && zx < MAP_WIDTH && zy > 0 && zy < MAP_HEIGHT) zombieGameState.zombies.push({ x: zx, y: zy, hp: 40, id: Math.random() });
            }
        }
        
        zombieGameState.zombies.forEach(z => {
            let target = null, minDist = Infinity;
            for(let id in zombieGameState.players) { let p = zombieGameState.players[id]; if(p.hp > 0) { let d = Math.hypot(p.x - z.x, p.y - z.y); if(d < minDist) { minDist = d; target = p; } } }
            if(target) { let angle = Math.atan2(target.y - z.y, target.x - z.x); z.x += Math.cos(angle) * 3; z.y += Math.sin(angle) * 3; if(minDist < 25) target.hp -= 1.5; }
        });

        zombieGameState.bullets.forEach(b => {
            zombieGameState.zombies.forEach(z => {
                if(b.life > 0 && Math.hypot(z.x - b.x, z.y - b.y) < 22) { z.hp -= 20; b.life = 0; if(z.hp <= 0 && zombieGameState.players[b.ownerId]) zombieGameState.players[b.ownerId].score += 10; }
            });
        });
        zombieGameState.zombies = zombieGameState.zombies.filter(z => z.hp > 0);
        
        for(let id in zombieGameState.players) {
            let p = zombieGameState.players[id];
            if(p.hp <= 0 && !p.isDeadNotified) {
                p.isDeadNotified = true; // Tránh gọi nhiều lần
                saveScore(p.userId, p.score, 'Săn Zombie');
                io.to(id).emit('playerDied', { score: p.score, mode: 'zombie' });
            }
        }
        io.to('zombieGameRoom').emit('gameStateUpdate', { mode: 'zombie', state: zombieGameState });

        // 3. PK 1VS1 ENGINE
        for(let roomId in pkRooms) {
            let room = pkRooms[roomId];
            if(room && room.status === 'playing') {
                handleMovement(room.players, 7);
                room.bullets.forEach(b => { b.x += b.vx; b.y += b.vy; b.life--; });
                room.bullets = room.bullets.filter(b => b.life > 0);
                room.bullets.forEach(b => {
                    for(let sid in room.players) {
                        let p = room.players[sid];
                        if(p.hp > 0 && b.ownerId !== sid && Math.hypot(p.x - b.x, p.y - b.y) < 22) {
                            p.hp -= 20; b.life = 0; 
                            if(p.hp <= 0 && room.players[b.ownerId]) {
                                room.players[b.ownerId].score += 10; 
                                if(room.players[b.ownerId].score >= 100) { room.status = 'waiting'; io.to(roomId).emit('pkGameOver', { winnerName: room.players[b.ownerId].name }); } 
                                else { setTimeout(() => { if(room.players[sid]) { room.players[sid].hp = 100; room.players[sid].x = MAP_WIDTH/2 + (Math.random()>0.5?200:-200); room.players[sid].y = MAP_HEIGHT/2; } }, 1500); }
                            }
                        }
                    }
                });
                io.to(roomId).emit('gameStateUpdate', { mode: 'pk', state: room });
            }
        }
    } catch(err) { console.error("Lỗi Game Loop V10:", err); } // Chống sập tuyệt đối
}, 1000 / 60);

// Đồng bộ User
function sendUserDataUpdate(userId, socketTarget) {
    const db = readDB(); const user = db.users.find(u => u.id === userId); if (!user) return;
    let friendsList = db.users.filter(u => user.friends.includes(u.id) || u.role === 'admin');
    if(user.role === 'admin') { const msgIds = [...new Set(db.messages.filter(m => m.to === userId).map(m => m.from))]; friendsList = db.users.filter(u => u.role !== 'admin' && (user.friends.includes(u.id) || msgIds.includes(u.id))); }
    socketTarget.emit('userDataPackage', {
        friends: friendsList.map(u => ({ id: u.id, username: u.username, displayName: u.displayName || u.username, role: u.role, phone: u.phone, email: u.email, gender: u.gender, dob: u.dob, bio: u.bio, isOnline: !!onlineUsers[u.id], isBlocked: user.blocks ? user.blocks.includes(u.id) : false, isBlockedBy: u.blocks ? u.blocks.includes(user.id) : false, isArchived: user.archives ? user.archives.includes(u.id) : false })),
        messages: db.messages.filter(m => m.from === userId || m.to === userId), requests: db.friendRequests.filter(r => r.to === userId), blocks: user.blocks || [], archives: user.archives || [], isMuted: user.isMuted
    });
}

// Bảng Xếp Hạng & Vinh Danh
setInterval(() => { io.emit('leaderboardUpdate', readDB().leaderboard); }, 5 * 60 * 1000); // Gửi 5 phút/lần
setInterval(() => {
    const now = new Date();
    if(now.getHours() === 0 && now.getMinutes() === 0) {
        const db = readDB();
        if(db.leaderboard && db.leaderboard.length > 0) { db.dailyWinner = db.leaderboard[0]; writeDB(db); io.emit('dailyWinnerNotice', db.dailyWinner); }
    }
}, 60000);

server.listen(PORT, () => console.log(`Cherry Server V10 MAX running on port ${PORT}`));