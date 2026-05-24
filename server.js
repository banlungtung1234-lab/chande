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
const io = new Server(server, { maxHttpBufferSize: 1e7 }); // Giới hạn ảnh 10MB
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'database.json');

// --- 1. KHỞI TẠO CƠ SỞ DỮ LIỆU ---
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
    catch (e) { return { users: [], messages: [], friendRequests: [] }; }
}
function writeDB(data) { 
    try { fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2)); } 
    catch (e) { console.error("Lỗi ghi Database:", e); }
}
initDatabase();

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

const sessionMiddleware = session({
    secret: 'cherry-blossom-secret-key-pro-v6',
    resave: false, saveUninitialized: true,
    store: new MemoryStore({ checkPeriod: 86400000 }), 
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
});
app.use(sessionMiddleware);
app.use(express.static(path.join(__dirname, 'public')));
io.use((socket, next) => { sessionMiddleware(socket.request, socket.request.res || {}, next); });

let onlineUsers = {}; 

// --- 2. API XÁC THỰC VÀ QUÊN MẬT KHẨU ---
app.post('/api/register', (req, res) => {
    const { username, phone, email, password, confirmPassword } = req.body;
    if (username.length < 4) return res.status(400).json({ msg: "Tên đăng nhập >= 4 ký tự!" });
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

// KHÔI PHỤC TÍNH NĂNG: QUÊN MẬT KHẨU
app.post('/api/forgot-password', (req, res) => {
    const { username, phone, newPassword } = req.body;
    const db = readDB();
    const user = db.users.find(u => u.username === username && u.phone === phone);
    
    if (!user) return res.status(400).json({ msg: "Thông tin tài khoản hoặc số điện thoại không chính xác!" });
    
    user.password = bcrypt.hashSync(newPassword, 10);
    writeDB(db);
    res.json({ msg: "Khôi phục mật khẩu thành công! Vui lòng đăng nhập lại." });
});

app.post('/api/setup-profile', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ msg: "Chưa đăng nhập!" });
    const { displayName } = req.body; const db = readDB(); 
    const user = db.users.find(u => u.id === req.session.userId);
    user.displayName = displayName; writeDB(db); res.json({ msg: "Thành công!", role: user.role });
});

app.post('/api/login', (req, res) => {
    const { loginKey, password } = req.body; const db = readDB();
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

app.post('/api/logout', (req, res) => { req.session.destroy(); res.json({ msg: "Đã đăng xuất!" }); });

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

// --- 3. SOCKET & LỚP BẢO MẬT THÉP ---
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
            return socket.emit('actionError', `Bạn đã bị cấm nhắn tin ${t}.`);
        }
        if (sender.role !== 'admin' && receiver.role !== 'admin') {
            if (receiver.blocks && receiver.blocks.includes(currentUserId)) return socket.emit('actionError', "Không thể gửi. Đối phương đã chặn bạn!");
            if (sender.blocks && sender.blocks.includes(toUserId)) return socket.emit('actionError', "Bạn đang chặn người này!");
            if (!sender.friends.includes(toUserId)) return socket.emit('actionError', "Hai người chưa là bạn bè!");
        }

        const msgObj = { id: 'msg_' + Date.now(), from: currentUserId, to: toUserId, type, text, imgData, timestamp: new Date().toISOString(), isEdited: false, isRecalled: false };
        db.messages.push(msgObj); writeDB(db);
        
        socket.emit('receiveMessage', msgObj);
        if (onlineUsers[toUserId]) {
            io.to(onlineUsers[toUserId]).emit('receiveMessage', msgObj);
            io.to(onlineUsers[toUserId]).emit('msgPopupNotification', { fromName: sender.displayName, text: type === 'image' ? '📸 Đã gửi một hình ảnh' : text });
        }
    });

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

    // --- Mạng xã hội bạn bè ---
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

    // --- Admin Tools ---
    socket.on('verifyAdminAuth', (pass, cb) => { const db = readDB(); const a = db.users.find(u => u.id === currentUserId && u.role === 'admin'); if (a && bcrypt.compareSync(pass, a.password)) cb({ success: true }); else cb({ success: false, msg: "Sai mật mã!" }); });
    socket.on('adminGetUsers', () => { const db = readDB(); if (db.users.find(u => u.id === currentUserId && u.role === 'admin')) socket.emit('adminUsersList', db.users.map(u => ({ id: u.id, username: u.username, displayName: u.displayName, role: u.role, isBanned: u.isBanned, banUntil: u.banUntil, isMuted: u.isMuted, muteUntil: u.muteUntil, isOnline: !!onlineUsers[u.id] }))); });
    
    // KHÔI PHỤC TÍNH NĂNG: ADMIN ĐỔI TÊN NGƯỜI DÙNG
    socket.on('adminUpdateUser', (data) => {
        const db = readDB();
        if (db.users.find(u => u.id === currentUserId && u.role === 'admin')) {
            const targetUser = db.users.find(u => u.id === data.id);
            if (targetUser) {
                targetUser.displayName = data.displayName;
                writeDB(db);
                socket.emit('actionSuccess', "Đổi tên người dùng thành công!");
                // Gửi lại danh sách mới cho Admin
                socket.emit('adminUsersList', db.users.map(u => ({ id: u.id, username: u.username, displayName: u.displayName, role: u.role, isBanned: u.isBanned, banUntil: u.banUntil, isMuted: u.isMuted, muteUntil: u.muteUntil, isOnline: !!onlineUsers[u.id] })));
                // Đồng bộ cập nhật cho người dùng nếu đang online
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
        if (db.users.find(u => u.id === currentUserId && u.role === 'admin')) {
            socket.emit('adminChatData', db.messages.filter(m => (m.from === currentUserId && m.to === targetId) || (m.from === targetId && m.to === currentUserId)));
        }
    });

    // --- Game Engine ---
    socket.on('joinGame', () => { if(checkBanStatus()) return; const db = readDB(); const user = db.users.find(u => u.id === currentUserId); if(!user) return; socket.join('gameRoom'); gameState.players[socket.id] = { id: socket.id, userId: currentUserId, name: user.displayName || user.username, x: Math.random() * 600 + 100, y: Math.random() * 400 + 100, color: `hsl(${Math.random() * 360}, 100%, 70%)`, hp: 100, score: user.gameScore || 0 }; });
    socket.on('leaveGame', () => { socket.leave('gameRoom'); delete gameState.players[socket.id]; });
    socket.on('playerMove', (data) => { const p = gameState.players[socket.id]; if(p && p.hp > 0) { p.x = data.x; p.y = data.y; } });
    socket.on('playerShoot', (data) => { const p = gameState.players[socket.id]; if(p && p.hp > 0) gameState.bullets.push({ id: Math.random(), ownerId: socket.id, x: p.x, y: p.y, vx: data.vx, vy: data.vy, life: 60 }); });
    socket.on('disconnect', () => { delete onlineUsers[currentUserId]; delete gameState.players[socket.id]; io.emit('userStatusChange', { userId: currentUserId, status: 'offline' }); });
});

let gameState = { players: {}, bullets: [] };
setInterval(() => {
    gameState.bullets.forEach(b => { b.x += b.vx; b.y += b.vy; b.life--; });
    gameState.bullets = gameState.bullets.filter(b => b.life > 0);
    gameState.bullets.forEach((b) => {
        for(let id in gameState.players) {
            let p = gameState.players[id];
            if(p && p.hp > 0 && b.ownerId !== id) {
                let dist = Math.sqrt(Math.pow(p.x - b.x, 2) + Math.pow(p.y - b.y, 2));
                if(dist < 20) { 
                    p.hp -= 20; b.life = 0; 
                    if(p.hp <= 0 && gameState.players[b.ownerId]) {
                        gameState.players[b.ownerId].score += 10;
                        const db = readDB(); const shooter = db.users.find(u => u.id === gameState.players[b.ownerId].userId);
                        if(shooter) { shooter.gameScore = gameState.players[b.ownerId].score; writeDB(db); }
                        setTimeout(() => { if(gameState.players[id]) { gameState.players[id].hp = 100; gameState.players[id].x = Math.random() * 600 + 100; gameState.players[id].y = Math.random() * 400 + 100; } }, 3000);
                    }
                }
            }
        }
    });
    io.to('gameRoom').emit('gameStateUpdate', gameState);
}, 1000 / 30);

function sendUserDataUpdate(userId, socketTarget) {
    const db = readDB(); const user = db.users.find(u => u.id === userId); if (!user) return;
    let friendsList = db.users.filter(u => user.friends.includes(u.id) || u.role === 'admin');
    if(user.role === 'admin') {
        const msgIds = [...new Set(db.messages.filter(m => m.to === userId).map(m => m.from))];
        friendsList = db.users.filter(u => u.role !== 'admin' && (user.friends.includes(u.id) || msgIds.includes(u.id)));
    }
    socketTarget.emit('userDataPackage', {
        // KHÔI PHỤC TÍNH NĂNG: TRẢ LẠI TRƯỜNG PHONE / EMAIL TRONG SOCKET
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

server.listen(PORT, () => console.log(`Cherry Server V6.2 PRO running on port ${PORT}`));