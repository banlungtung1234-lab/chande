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
const io = new Server(server, { maxHttpBufferSize: 1e7 }); // Hỗ trợ gửi ảnh lên tới 10MB
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'database.json');

// ====================================================================================
// --- 1. HỆ THỐNG CƠ SỞ DỮ LIỆU ---
// ====================================================================================
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
            messages: [], friendRequests: []
        });
    } else {
        const db = readDB();
        let needsUpdate = false;
        db.users.forEach(u => { 
            if(u.gameScore === undefined) { u.gameScore = 0; needsUpdate = true; }
            if(u.blocks === undefined) { u.blocks = []; needsUpdate = true; }
            if(u.archives === undefined) { u.archives = []; needsUpdate = true; }
        });
        if(needsUpdate) writeDB(db);
    }
}

function readDB() { 
    try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } 
    catch (e) { console.error("Lỗi đọc DB:", e); return { users: [], messages: [], friendRequests: [] }; }
}

function writeDB(data) { 
    try { fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2)); } 
    catch (e) { console.error("Lỗi ghi Database:", e); }
}

initDatabase();

// ====================================================================================
// --- 2. CẤU HÌNH SERVER & SESSION ---
// ====================================================================================
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

const sessionMiddleware = session({
    secret: 'cherry-blossom-secret-key-pro-v7',
    resave: false, saveUninitialized: true,
    store: new MemoryStore({ checkPeriod: 86400000 }), 
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
});
app.use(sessionMiddleware);
app.use(express.static(path.join(__dirname, 'public')));
io.use((socket, next) => { sessionMiddleware(socket.request, socket.request.res || {}, next); });

let onlineUsers = {}; 

// ====================================================================================
// --- 3. API XÁC THỰC VÀ QUẢN LÝ TÀI KHOẢN ---
// ====================================================================================
app.post('/api/register', (req, res) => {
    const { username, phone, email, password, confirmPassword } = req.body;
    if (username.length < 4) return res.status(400).json({ msg: "Tên đăng nhập trên 4 ký tự!" });
    if (password !== confirmPassword) return res.status(400).json({ msg: "Mật khẩu không khớp!" });

    const db = readDB();
    if (db.users.find(u => u.username === username)) return res.status(400).json({ msg: "Tài khoản đã tồn tại!" });

    const newUser = {
        id: 'user_' + Date.now(), username, phone, email: email || "",
        password: bcrypt.hashSync(password, 10), displayName: "", role: "user",
        isBanned: false, banUntil: null, isMuted: false, muteUntil: null,
        friends: [], blocks: [], archives: [], gender: "secret", dob: "", bio: "", gameScore: 0
    };
    db.users.push(newUser); writeDB(db);
    req.session.userId = newUser.id;
    res.json({ msg: "Đăng ký thành công!", step: "setupProfile" });
});

app.post('/api/forgot-password', (req, res) => {
    const { username, phone, newPassword } = req.body;
    const db = readDB();
    const user = db.users.find(u => u.username === username && u.phone === phone);
    if (!user) return res.status(400).json({ msg: "Thông tin tài khoản hoặc SĐT không chính xác!" });
    
    user.password = bcrypt.hashSync(newPassword, 10);
    writeDB(db);
    res.json({ msg: "Khôi phục mật khẩu thành công! Vui lòng đăng nhập lại." });
});

app.post('/api/setup-profile', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ msg: "Chưa đăng nhập!" });
    const { displayName } = req.body; 
    const db = readDB(); 
    const user = db.users.find(u => u.id === req.session.userId);
    user.displayName = displayName; 
    writeDB(db); 
    res.json({ msg: "Thành công!", role: user.role });
});

app.post('/api/login', (req, res) => {
    const { loginKey, password } = req.body; 
    const db = readDB();
    const user = db.users.find(u => u.username === loginKey || u.phone === loginKey);
    if (!user || !bcrypt.compareSync(password, user.password)) return res.status(400).json({ msg: "Sai tài khoản hoặc mật khẩu!" });
    
    if (user.isBanned) {
        if (user.banUntil && new Date() > new Date(user.banUntil)) {
            user.isBanned = false; user.banUntil = null; writeDB(db); 
        } else return res.json({ step: "banned", banUntil: user.banUntil, msg: "Tài khoản bị khóa!" });
    }
    req.session.userId = user.id;
    res.json({ msg: "Đăng nhập thành công!", role: user.role, needProfile: (!user.displayName || user.displayName.trim() === "") });
});

app.post('/api/logout', (req, res) => { 
    req.session.destroy(); 
    res.json({ msg: "Đã đăng xuất!" }); 
});

app.get('/api/me', (req, res) => {
    try {
        if (!req.session.userId) return res.status(401).json({ msg: "Chưa đăng nhập" });
        const db = readDB(); const user = db.users.find(u => u.id === req.session.userId);
        if(!user) return res.status(404).json({ msg: "Lỗi dữ liệu" });
        
        if (user.isBanned) {
            if (user.banUntil && new Date() > new Date(user.banUntil)) {
                user.isBanned = false; user.banUntil = null; writeDB(db);
            } else return res.status(403).json({ isBanned: true, banUntil: user.banUntil });
        }
        res.json({ id: user.id, username: user.username, displayName: user.displayName, phone: user.phone, email: user.email, role: user.role, gender: user.gender, dob: user.dob, bio: user.bio, gameScore: user.gameScore });
    } catch(e) { res.status(500).json({ msg: "Lỗi máy chủ" }); }
});

// ====================================================================================
// --- 4. HỆ THỐNG SOCKET THỜI GIAN THỰC (CHAT + ADMIN) ---
// ====================================================================================
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
            if (user.banUntil && new Date() > new Date(user.banUntil)) {
                user.isBanned = false; user.banUntil = null; writeDB(db); return false;
            }
            socket.emit('forceBannedUI', { banUntil: user.banUntil }); return true;
        }
        return false;
    };

    socket.on('initData', () => { if(!checkBanStatus()) sendUserDataUpdate(currentUserId, socket); });
    socket.on('typing', (to) => { if(!checkBanStatus() && onlineUsers[to]) io.to(onlineUsers[to]).emit('userTyping', currentUserId); });
    socket.on('stopTyping', (to) => { if (onlineUsers[to]) io.to(onlineUsers[to]).emit('userStoppedTyping', currentUserId); });

    // Gửi tin nhắn
    socket.on('sendMessage', ({ toUserId, text, type = 'text', imgData = null }) => {
        if(checkBanStatus()) return; 
        const db = readDB(); const sender = db.users.find(u => u.id === currentUserId);
        const receiver = db.users.find(u => u.id === toUserId);
        if (!sender || !receiver) return;

        if (sender.isMuted && sender.muteUntil && new Date() > new Date(sender.muteUntil)) {
            sender.isMuted = false; sender.muteUntil = null; writeDB(db);
        }
        if (sender.isMuted && sender.role !== 'admin') {
            const t = sender.muteUntil ? `đến ${new Date(sender.muteUntil).toLocaleString()}` : "vĩnh viễn";
            return socket.emit('actionError', `Bạn bị cấm nhắn tin ${t}.`);
        }
        if (sender.role !== 'admin' && receiver.role !== 'admin') {
            if (receiver.blocks && receiver.blocks.includes(currentUserId)) return socket.emit('actionError', "Không thể gửi. Bị chặn!");
            if (sender.blocks && sender.blocks.includes(toUserId)) return socket.emit('actionError', "Bạn đang chặn người này!");
            if (!sender.friends.includes(toUserId)) return socket.emit('actionError', "Hai người chưa là bạn bè!");
        }

        const msgObj = { id: 'msg_' + Date.now(), from: currentUserId, to: toUserId, type, text, imgData, timestamp: new Date().toISOString(), isEdited: false, isRecalled: false };
        db.messages.push(msgObj); writeDB(db);
        
        socket.emit('receiveMessage', msgObj);
        if (onlineUsers[toUserId]) {
            io.to(onlineUsers[toUserId]).emit('receiveMessage', msgObj);
            io.to(onlineUsers[toUserId]).emit('msgPopupNotification', { fromName: sender.displayName, text: type === 'image' ? '📸 Đã gửi một ảnh' : text });
        }
    });

    // Cập nhật profile & Password
    socket.on('updateMyProfile', (data, callback) => {
        if(checkBanStatus()) return; const db = readDB(); const user = db.users.find(u => u.id === currentUserId);
        user.displayName = data.displayName; user.phone = data.phone; user.email = data.email;
        user.gender = data.gender; user.dob = data.dob; user.bio = data.bio; writeDB(db); 
        callback({ success: true, msg: "Lưu hồ sơ thành công!" }); sendUserDataUpdate(currentUserId, socket);
    });

    socket.on('changePasswordInternal', ({ oldPass, newPass }, cb) => {
        if(checkBanStatus()) return; const db = readDB(); const user = db.users.find(u => u.id === currentUserId);
        if (user && bcrypt.compareSync(oldPass, user.password)) { user.password = bcrypt.hashSync(newPass, 10); writeDB(db); cb({ success: true, msg: "Đổi pass thành công!" }); } else cb({ success: false, msg: "Pass cũ sai!" });
    });

    // Bạn bè
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

    // Admin
    socket.on('verifyAdminAuth', (pass, cb) => { const db = readDB(); const a = db.users.find(u => u.id === currentUserId && u.role === 'admin'); if (a && bcrypt.compareSync(pass, a.password)) cb({ success: true }); else cb({ success: false, msg: "Sai mật mã!" }); });
    socket.on('adminGetUsers', () => { const db = readDB(); if (db.users.find(u => u.id === currentUserId && u.role === 'admin')) socket.emit('adminUsersList', db.users.map(u => ({ id: u.id, username: u.username, displayName: u.displayName, role: u.role, isBanned: u.isBanned, banUntil: u.banUntil, isMuted: u.isMuted, muteUntil: u.muteUntil, isOnline: !!onlineUsers[u.id] }))); });
    socket.on('adminUpdateUser', (data) => {
        const db = readDB();
        if (db.users.find(u => u.id === currentUserId && u.role === 'admin')) {
            const targetUser = db.users.find(u => u.id === data.id);
            if (targetUser) {
                targetUser.displayName = data.displayName; writeDB(db);
                socket.emit('actionSuccess', "Đổi tên thành công!");
                socket.emit('adminUsersList', db.users.map(u => ({ id: u.id, username: u.username, displayName: u.displayName, role: u.role, isBanned: u.isBanned, banUntil: u.banUntil, isMuted: u.isMuted, muteUntil: u.muteUntil, isOnline: !!onlineUsers[u.id] })));
                if(onlineUsers[data.id]) sendUserDataUpdate(data.id, io.to(onlineUsers[data.id]));
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
                    else if (action === 'mute') io.to(onlineUsers[targetId]).emit('actionError', "Bạn vừa bị Admin cấm nhắn tin.");
                    else if (action === 'unpunish') { io.to(onlineUsers[targetId]).emit('actionSuccess', "Đã gỡ án phạt!"); io.to(onlineUsers[targetId]).emit('unbanned'); }
                }
            }
        }
    });
    socket.on('adminGetChat', (targetId) => {
        const db = readDB();
        if (db.users.find(u => u.id === currentUserId && u.role === 'admin')) socket.emit('adminChatData', db.messages.filter(m => (m.from === currentUserId && m.to === targetId) || (m.from === targetId && m.to === currentUserId)));
    });


    // ====================================================================================
    // --- 5A. CHẾ ĐỘ CHƠI TỰ DO (FREE-FOR-ALL ARENA) - GIỮ LẠI THEO YÊU CẦU ---
    // ====================================================================================
    socket.on('joinFFAGame', () => { 
        if(checkBanStatus()) return; 
        const db = readDB(); const user = db.users.find(u => u.id === currentUserId); if(!user) return; 
        socket.join('ffaGameRoom'); 
        ffaGameState.players[socket.id] = { 
            id: socket.id, userId: currentUserId, name: user.displayName || user.username, 
            x: Math.random() * 600 + 100, y: Math.random() * 400 + 50, 
            color: `hsl(${Math.random() * 360}, 100%, 70%)`, hp: 100, score: user.gameScore || 0,
            keys: { w: false, a: false, s: false, d: false }
        }; 
    });

    socket.on('leaveFFAGame', () => { socket.leave('ffaGameRoom'); delete ffaGameState.players[socket.id]; });
    
    // Gộp input cho cả FFA
    socket.on('ffaInput', ({ keys, aimAngle, isShooting }) => {
        const p = ffaGameState.players[socket.id];
        if(p && p.hp > 0) {
            p.keys = keys;
            if(isShooting && (!p.lastShot || Date.now() - p.lastShot > 200)) { 
                p.lastShot = Date.now();
                ffaGameState.bullets.push({ 
                    x: p.x, y: p.y, vx: Math.cos(aimAngle)*15, vy: Math.sin(aimAngle)*15, 
                    ownerId: socket.id, life: 60 
                });
            }
        }
    });


    // ====================================================================================
    // --- 5B. CHẾ ĐỘ THÁCH ĐẤU (PK 1VS1) - TÍNH NĂNG MỚI NÂNG CẤP ---
    // ====================================================================================
    socket.on('invitePK', (targetId) => {
        if(checkBanStatus()) return;
        if(onlineUsers[targetId]) {
            const db = readDB(); const sender = db.users.find(u => u.id === currentUserId);
            io.to(onlineUsers[targetId]).emit('pkInviteReceived', { fromId: currentUserId, fromName: sender.displayName || sender.username });
        } else socket.emit('actionError', "Đối thủ không online!");
    });

    socket.on('declinePK', (inviterId) => { if(onlineUsers[inviterId]) io.to(onlineUsers[inviterId]).emit('actionError', "Đối thủ đã từ chối lời mời PK."); });

    socket.on('acceptPK', (inviterId) => {
        if(checkBanStatus()) return;
        const inviterSocketId = onlineUsers[inviterId];
        if(!inviterSocketId) return socket.emit('actionError', "Người mời đã thoát!");

        const roomId = 'pk_' + Date.now();
        socket.join(roomId); io.sockets.sockets.get(inviterSocketId)?.join(roomId);
        const db = readDB(); const p1 = db.users.find(u => u.id === inviterId); const p2 = db.users.find(u => u.id === currentUserId);

        pkRooms[roomId] = {
            id: roomId, status: 'waiting', 
            players: {
                [inviterSocketId]: { id: inviterSocketId, userId: p1.id, name: p1.displayName || p1.username, x: 200, y: 250, color: '#f87171', hp: 100, score: 0 },
                [socket.id]: { id: socket.id, userId: p2.id, name: p2.displayName || p2.username, x: 600, y: 250, color: '#60a5fa', hp: 100, score: 0 }
            }, bullets: []
        };
        io.to(roomId).emit('pkRoomJoined', pkRooms[roomId]);
    });

    socket.on('startPK', (roomId) => {
        if(pkRooms[roomId] && pkRooms[roomId].status === 'waiting') {
            if(Object.keys(pkRooms[roomId].players).length === 2) {
                pkRooms[roomId].status = 'playing';
                let i = 0;
                for(let sid in pkRooms[roomId].players) {
                    let p = pkRooms[roomId].players[sid];
                    p.hp = 100; p.score = 0; p.x = i === 0 ? 200 : 600; p.y = 250; i++;
                }
                pkRooms[roomId].bullets = []; io.to(roomId).emit('pkGameStarted', pkRooms[roomId]);
            } else socket.emit('actionError', "Chưa đủ 2 người chơi!");
        }
    });

    socket.on('leavePK', (roomId) => {
        socket.leave(roomId);
        if(pkRooms[roomId]) {
            delete pkRooms[roomId].players[socket.id];
            io.to(roomId).emit('actionError', "Đối thủ đã bỏ chạy khỏi phòng PK.");
            io.to(roomId).emit('pkRoomClosed'); delete pkRooms[roomId];
        }
    });

    socket.on('pkInput', ({ roomId, keys, aimAngle, isShooting }) => {
        const room = pkRooms[roomId];
        if(room && room.status === 'playing') {
            const p = room.players[socket.id];
            if(p && p.hp > 0) {
                p.keys = keys;
                if(isShooting && (!p.lastShot || Date.now() - p.lastShot > 200)) { 
                    p.lastShot = Date.now();
                    room.bullets.push({ x: p.x, y: p.y, vx: Math.cos(aimAngle)*18, vy: Math.sin(aimAngle)*18, ownerId: socket.id, life: 60 });
                }
            }
        }
    });

    // Ngắt kết nối
    socket.on('disconnect', () => { 
        delete onlineUsers[currentUserId]; 
        io.emit('userStatusChange', { userId: currentUserId, status: 'offline' }); 
        
        // Thoát FFA
        delete ffaGameState.players[socket.id];
        
        // Thoát PK
        for(let roomId in pkRooms) {
            if(pkRooms[roomId].players[socket.id]) {
                delete pkRooms[roomId].players[socket.id];
                io.to(roomId).emit('actionError', "Đối thủ đã mất kết nối!");
                io.to(roomId).emit('pkRoomClosed'); delete pkRooms[roomId];
            }
        }
    });
});

// ====================================================================================
// --- ĐỘNG CƠ XỬ LÝ GAME 60 FPS (VÒNG LẶP CHO CẢ 2 CHẾ ĐỘ) ---
// ====================================================================================
let ffaGameState = { players: {}, bullets: [] };
let pkRooms = {};

setInterval(() => {
    // ---- XỬ LÝ FFA GAME ----
    for(let sid in ffaGameState.players) {
        let p = ffaGameState.players[sid];
        if(p.hp > 0 && p.keys) {
            if(p.keys.w && p.y > 20) p.y -= 5;
            if(p.keys.s && p.y < 480) p.y += 5;
            if(p.keys.a && p.x > 20) p.x -= 5;
            if(p.keys.d && p.x < 780) p.x += 5;
        }
    }
    ffaGameState.bullets.forEach(b => { b.x += b.vx; b.y += b.vy; b.life--; });
    ffaGameState.bullets = ffaGameState.bullets.filter(b => b.life > 0);
    ffaGameState.bullets.forEach((b) => {
        for(let id in ffaGameState.players) {
            let p = ffaGameState.players[id];
            if(p && p.hp > 0 && b.ownerId !== id) {
                let dist = Math.hypot(p.x - b.x, p.y - b.y);
                if(dist < 20) { 
                    p.hp -= 20; b.life = 0; 
                    if(p.hp <= 0 && ffaGameState.players[b.ownerId]) {
                        ffaGameState.players[b.ownerId].score += 10;
                        const db = readDB(); const shooter = db.users.find(u => u.id === ffaGameState.players[b.ownerId].userId);
                        if(shooter) { shooter.gameScore = ffaGameState.players[b.ownerId].score; writeDB(db); }
                        setTimeout(() => { if(ffaGameState.players[id]) { ffaGameState.players[id].hp = 100; ffaGameState.players[id].x = Math.random() * 600 + 100; ffaGameState.players[id].y = Math.random() * 400 + 50; } }, 3000);
                    }
                }
            }
        }
    });
    io.to('ffaGameRoom').emit('ffaStateUpdate', ffaGameState);

    // ---- XỬ LÝ PK GAME ----
    for(let roomId in pkRooms) {
        let room = pkRooms[roomId];
        if(room.status === 'playing') {
            for(let sid in room.players) {
                let p = room.players[sid];
                if(p.hp > 0 && p.keys) {
                    const speed = 7;
                    if(p.keys.w && p.y > 20) p.y -= speed;
                    if(p.keys.s && p.y < 480) p.y += speed;
                    if(p.keys.a && p.x > 20) p.x -= speed;
                    if(p.keys.d && p.x < 780) p.x += speed;
                }
            }
            room.bullets.forEach(b => { b.x += b.vx; b.y += b.vy; b.life--; });
            room.bullets = room.bullets.filter(b => b.life > 0);
            room.bullets.forEach(b => {
                for(let sid in room.players) {
                    let p = room.players[sid];
                    if(p.hp > 0 && b.ownerId !== sid) {
                        let dist = Math.hypot(p.x - b.x, p.y - b.y);
                        if(dist < 22) {
                            p.hp -= 20; b.life = 0; 
                            if(p.hp <= 0 && room.players[b.ownerId]) {
                                room.players[b.ownerId].score += 10; 
                                if(room.players[b.ownerId].score >= 100) {
                                    room.status = 'waiting'; 
                                    io.to(roomId).emit('pkGameOver', { winnerName: room.players[b.ownerId].name });
                                } else {
                                    setTimeout(() => { if(room.players[sid]) { room.players[sid].hp = 100; room.players[sid].x = Math.random() * 600 + 100; room.players[sid].y = Math.random() * 400 + 50; } }, 1500);
                                }
                            }
                        }
                    }
                }
            });
            io.to(roomId).emit('pkStateUpdate', room);
        }
    }
}, 1000 / 60);

// Đồng bộ dữ liệu gói tin cho Client
function sendUserDataUpdate(userId, socketTarget) {
    const db = readDB(); const user = db.users.find(u => u.id === userId); if (!user) return;
    let friendsList = db.users.filter(u => user.friends.includes(u.id) || u.role === 'admin');
    if(user.role === 'admin') {
        const msgIds = [...new Set(db.messages.filter(m => m.to === userId).map(m => m.from))];
        friendsList = db.users.filter(u => u.role !== 'admin' && (user.friends.includes(u.id) || msgIds.includes(u.id)));
    }
    socketTarget.emit('userDataPackage', {
        friends: friendsList.map(u => ({ 
            id: u.id, username: u.username, displayName: u.displayName || u.username, role: u.role, 
            phone: u.phone, email: u.email, gender: u.gender, dob: u.dob, bio: u.bio,
            isOnline: !!onlineUsers[u.id], 
            isBlocked: user.blocks ? user.blocks.includes(u.id) : false, 
            isBlockedBy: u.blocks ? u.blocks.includes(user.id) : false, 
            isArchived: user.archives ? user.archives.includes(u.id) : false 
        })),
        messages: db.messages.filter(m => m.from === userId || m.to === userId), 
        requests: db.friendRequests.filter(r => r.to === userId), 
        blocks: user.blocks || [], archives: user.archives || [], isMuted: user.isMuted
    });
}

server.listen(PORT, () => console.log(`mtun dzai:> running on port ${PORT}`));