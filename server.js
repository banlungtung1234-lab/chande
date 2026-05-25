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
const io = new Server(server, { maxHttpBufferSize: 5e7 }); // V16: 50MB cho Voice & Media
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'database.json');

// ==========================================
// 1. DATABASE V16 (SUPER APP & ESPORTS SCHEMA)
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
                gender: "secret", dob: "", bio: "Quản trị viên hệ thống tối cao", 
                gameScore: 0, avatar: "🌸", invisible: false, customStatus: "Sẵn sàng hỗ trợ!",
                elo: 1000, rank: "Đồng", playerClass: "none", stamina: 100 // V16 Game Stats
            }],
            messages: [], friendRequests: [], leaderboard: [], dailyWinner: null,
            pinnedMessages: {}, 
            groups: [], polls: [], scheduledMessages: [] // V16 Social
        };
        writeDB(initialDB);
    } else {
        const db = readDB();
        let needsUpdate = false;
        
        db.users.forEach(u => { 
            // Kế thừa V15
            if(u.gameScore === undefined) { u.gameScore = 0; needsUpdate = true; }
            if(u.blocks === undefined) { u.blocks = []; needsUpdate = true; }
            if(u.archives === undefined) { u.archives = []; needsUpdate = true; }
            if(u.avatar === undefined) { u.avatar = "🌸"; needsUpdate = true; }
            if(u.invisible === undefined) { u.invisible = false; needsUpdate = true; }
            if(u.customStatus === undefined) { u.customStatus = ""; needsUpdate = true; }
            // Cập nhật V16
            if(u.elo === undefined) { u.elo = 1000; needsUpdate = true; }
            if(u.rank === undefined) { u.rank = "Đồng"; needsUpdate = true; }
            if(u.playerClass === undefined) { u.playerClass = "none"; needsUpdate = true; }
            if(u.stamina === undefined) { u.stamina = 100; needsUpdate = true; }
        });
        
        db.messages.forEach(m => {
            if(m.reactions === undefined) { m.reactions = {}; needsUpdate = true; }
            if(m.isRecalled === undefined) { m.isRecalled = false; needsUpdate = true; }
            if(m.readBy === undefined) { m.readBy = []; needsUpdate = true; }
            if(m.isEdited === undefined) { m.isEdited = false; needsUpdate = true; } // V16 Edit
        });

        if(!db.pinnedMessages) { db.pinnedMessages = {}; needsUpdate = true; }
        if(!db.groups) { db.groups = []; needsUpdate = true; }
        if(!db.polls) { db.polls = []; needsUpdate = true; }
        if(!db.scheduledMessages) { db.scheduledMessages = []; needsUpdate = true; }
        
        if(needsUpdate) writeDB(db);
    }
}

function readDB() { try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) { return { users: [], messages: [], friendRequests: [], leaderboard: [] }; } }
function writeDB(data) { try { fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 4)); } catch (e) { console.error("Lỗi ghi DB:", e); } }
initDatabase();

// ==========================================
// 2. CONFIG MIDDLEWARE
// ==========================================
app.use(express.json({ limit: '50mb' })); 
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const sessionMiddleware = session({ secret: 'cherry-v16-god-tier', resave: false, saveUninitialized: true, store: new MemoryStore({ checkPeriod: 86400000 }), cookie: { maxAge: 24 * 60 * 60 * 1000 } });
app.use(sessionMiddleware);
app.use(express.static(path.join(__dirname, 'public')));
io.use((socket, next) => { sessionMiddleware(socket.request, socket.request.res || {}, next); });

let onlineUsers = {}; 
let dayNightCycle = { isNight: false, nextChangeTime: Date.now() + 60000 };

// V16: Hệ thống gửi tin nhắn hẹn giờ (Background Job)
setInterval(() => {
    const db = readDB();
    let updated = false;
    const now = Date.now();
    db.scheduledMessages = db.scheduledMessages.filter(msg => {
        if(now >= msg.scheduleTime) {
            db.messages.push(msg); // Move to real messages
            io.emit('receiveMessage', msg);
            updated = true;
            return false; // Xóa khỏi hàng đợi
        }
        return true;
    });
    if(updated) writeDB(db);
}, 10000);

// ==========================================
// 3. API ROUTES (AUTH)
// ==========================================
app.post('/api/register', (req, res) => {
    const { username, phone, email, password, confirmPassword } = req.body;
    if (!username || username.trim().length < 4) return res.status(400).json({ msg: "Tên đăng nhập trên 4 ký tự!" });
    if (!phone || !/^[0-9]{10,11}$/.test(phone)) return res.status(400).json({ msg: "SĐT không hợp lệ!" });
    if (!password || password.length < 6 || !/(?=.*[a-zA-Z])(?=.*[0-9])/.test(password)) return res.status(400).json({ msg: "Mật khẩu yếu!" });
    if (password !== confirmPassword) return res.status(400).json({ msg: "Xác nhận mật khẩu sai!" });

    const db = readDB();
    if (db.users.find(u => u.username === username.trim())) return res.status(400).json({ msg: "Tài khoản đã tồn tại!" });
    if (db.users.find(u => u.phone === phone)) return res.status(400).json({ msg: "SĐT đã được đăng ký!" });

    const newUser = { id: 'user_' + Date.now(), username: username.trim(), phone: phone, email: email || "", password: bcrypt.hashSync(password, 10), displayName: "", role: "user", isBanned: false, banUntil: null, isMuted: false, muteUntil: null, friends: [], blocks: [], archives: [], gender: "secret", dob: "", bio: "", gameScore: 0, avatar: "🌸", invisible: false, customStatus: "", elo: 1000, rank: "Đồng", playerClass: "none", stamina: 100 };
    db.users.push(newUser); writeDB(db); req.session.userId = newUser.id; res.json({ msg: "Đăng ký thành công!", step: "setupProfile" });
});

app.post('/api/setup-profile', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ msg: "Chưa đăng nhập!" });
    const { displayName } = req.body;
    if (!displayName || displayName.trim().length < 2) return res.status(400).json({ msg: "Tên quá ngắn!" });
    const db = readDB(); const user = db.users.find(u => u.id === req.session.userId);
    if(user) { user.displayName = displayName.trim(); writeDB(db); } res.json({ msg: "Thành công!", role: user ? user.role : 'user' });
});

app.post('/api/login', (req, res) => {
    const { loginKey, password } = req.body; const db = readDB();
    const user = db.users.find(u => u.username === loginKey || u.phone === loginKey);
    if (!user || !bcrypt.compareSync(password, user.password)) return res.status(400).json({ msg: "Sai tài khoản / mật khẩu!" });
    if (user.isBanned) { if (user.banUntil && new Date() > new Date(user.banUntil)) { user.isBanned = false; user.banUntil = null; writeDB(db); } else { return res.json({ step: "banned", banUntil: user.banUntil, msg: "Tài khoản bị khóa!" }); } }
    req.session.userId = user.id; res.json({ msg: "Đăng nhập thành công!", role: user.role, needProfile: (!user.displayName || user.displayName.trim() === "") });
});

app.get('/api/me', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ msg: "Chưa đăng nhập" });
    const db = readDB(); const user = db.users.find(u => u.id === req.session.userId);
    if(!user) return res.status(404).json({ msg: "Lỗi dữ liệu" });
    if (user.isBanned) { if (user.banUntil && new Date() > new Date(user.banUntil)) { user.isBanned = false; user.banUntil = null; writeDB(db); } else { return res.status(403).json({ isBanned: true, banUntil: user.banUntil }); } }
    
    // V15+V16 Level & Rank Engine
    const level = Math.floor(Math.sqrt((user.gameScore || 0) / 100)) + 1;
    res.json({ id: user.id, username: user.username, displayName: user.displayName, phone: user.phone, email: user.email, role: user.role, gender: user.gender, dob: user.dob, bio: user.bio, gameScore: user.gameScore, avatar: user.avatar, invisible: user.invisible, customStatus: user.customStatus, level: level, elo: user.elo, rank: user.rank, playerClass: user.playerClass });
});

app.post('/api/logout', (req, res) => { req.session.destroy(); res.json({ msg: "Đã đăng xuất!" }); });

// ==========================================
// 4. WEBSOCKET - SOCIAL, CHAT & ADMIN (V16)
// ==========================================
io.on('connection', (socket) => {
    const session = socket.request.session; if (!session || !session.userId) return;
    const currentUserId = session.userId; onlineUsers[currentUserId] = socket.id; 
    
    const dbForStatus = readDB();
    const currUserObj = dbForStatus.users.find(u => u.id === currentUserId);
    if(currUserObj && !currUserObj.invisible) { io.emit('userStatusChange', { userId: currentUserId, status: 'online' }); }

    const checkBanStatus = () => {
        const db = readDB(); const user = db.users.find(u => u.id === currentUserId);
        if(!user) return true;
        if (user.isBanned) { if (user.banUntil && new Date() > new Date(user.banUntil)) { user.isBanned = false; user.banUntil = null; writeDB(db); return false; } socket.emit('forceBannedUI', { banUntil: user.banUntil }); return true; } return false;
    };

    socket.on('initData', () => { if(!checkBanStatus()) { sendUserDataUpdate(currentUserId, socket); socket.emit('leaderboardUpdate', readDB().leaderboard); } });
    socket.on('typing', (to) => { if(!checkBanStatus() && onlineUsers[to]) io.to(onlineUsers[to]).emit('userTyping', currentUserId); });
    socket.on('stopTyping', (to) => { if (onlineUsers[to]) io.to(onlineUsers[to]).emit('userStoppedTyping', currentUserId); });

    // V16: NÂNG CẤP GỬI TIN NHẮN (VOICE, LOCATION, POLLS)
    socket.on('sendMessage', ({ toUserId, toGroupId, text, type = 'text', imgData = null, location = null, replyTo = null, scheduleTime = null }) => {
        if(checkBanStatus()) return; 
        const db = readDB(); const sender = db.users.find(u => u.id === currentUserId); 
        if (sender.isMuted && sender.muteUntil && new Date() > new Date(sender.muteUntil)) { sender.isMuted = false; sender.muteUntil = null; writeDB(db); }
        if (sender.isMuted && sender.role !== 'admin') return socket.emit('actionError', "Bạn bị cấm nhắn tin.");
        
        // 1-1 Chat Validation
        if(toUserId) {
            const receiver = db.users.find(u => u.id === toUserId); if(!receiver) return;
            if (sender.role !== 'admin' && receiver.role !== 'admin') {
                if (receiver.blocks && receiver.blocks.includes(currentUserId)) return socket.emit('actionError', "Bị chặn!");
                if (sender.blocks && sender.blocks.includes(toUserId)) return socket.emit('actionError', "Bạn đang chặn!");
            }
        }
        
        const msgObj = { id: 'msg_' + Date.now(), from: currentUserId, to: toUserId || null, groupId: toGroupId || null, type, text, imgData, location, timestamp: new Date().toISOString(), isEdited: false, isRecalled: false, replyTo, reactions: {}, readBy: [] };
        
        // V16 Scheduled Message (Hẹn giờ)
        if(scheduleTime && scheduleTime > Date.now()) {
            msgObj.scheduleTime = scheduleTime;
            db.scheduledMessages.push(msgObj); writeDB(db);
            return socket.emit('actionSuccess', "Đã đặt lịch gửi tin nhắn!");
        }

        db.messages.push(msgObj); writeDB(db);
        
        // Broadcast
        if(toGroupId) {
            io.to(toGroupId).emit('receiveMessage', msgObj);
        } else {
            socket.emit('receiveMessage', msgObj); 
            if (onlineUsers[toUserId]) { 
                io.to(onlineUsers[toUserId]).emit('receiveMessage', msgObj); 
                let notifText = text; if(type === 'image') notifText = '📸 Đã gửi ảnh'; if(type === 'audio') notifText = '🎤 Đã gửi tin nhắn thoại'; if(type === 'location') notifText = '📍 Đã chia sẻ vị trí';
                io.to(onlineUsers[toUserId]).emit('msgPopupNotification', { fromName: sender.displayName, text: notifText }); 
            }
        }
    });

    // V16: EDIT (Chỉnh sửa tin nhắn)
    socket.on('editMessage', ({msgId, newText}) => {
        if(checkBanStatus()) return; const db = readDB();
        const msg = db.messages.find(m => m.id === msgId && m.from === currentUserId);
        if(msg && !msg.isRecalled) { msg.text = newText; msg.isEdited = true; writeDB(db); io.emit('messageUpdated', msg); }
    });

    // Các tính năng xã hội V15 giữ nguyên (Pin, Recall, React, MarkRead, Friends)
    socket.on('pinMessage', ({ targetId, msgId }) => { if(checkBanStatus()) return; const db = readDB(); const chatKey = [currentUserId, targetId].sort().join('_'); if(!msgId) { delete db.pinnedMessages[chatKey]; } else { db.pinnedMessages[chatKey] = msgId; } writeDB(db); socket.emit('pinnedUpdate', { chatKey, msgId }); if(onlineUsers[targetId]) { io.to(onlineUsers[targetId]).emit('pinnedUpdate', { chatKey, msgId }); } });
    socket.on('recallMessage', (msgId) => { if(checkBanStatus()) return; const db = readDB(); const msg = db.messages.find(m => m.id === msgId && m.from === currentUserId); if(msg && !msg.isRecalled) { msg.isRecalled = true; msg.text = "Tin nhắn đã bị thu hồi"; msg.imgData = null; writeDB(db); io.emit('messageUpdated', msg); } });
    socket.on('reactMessage', ({ msgId, emoji }) => { if(checkBanStatus()) return; const db = readDB(); const msg = db.messages.find(m => m.id === msgId); if(msg && !msg.isRecalled) { if(!msg.reactions) msg.reactions = {}; if(msg.reactions[currentUserId] === emoji) delete msg.reactions[currentUserId]; else msg.reactions[currentUserId] = emoji; writeDB(db); io.emit('messageUpdated', msg); } });
    socket.on('markAsRead', (targetId) => { const db = readDB(); let updated = false; db.messages.forEach(m => { if (m.from === targetId && m.to === currentUserId && (!m.readBy || !m.readBy.includes(currentUserId))) { if(!m.readBy) m.readBy = []; m.readBy.push(currentUserId); updated = true; } }); if(updated) { writeDB(db); if(onlineUsers[targetId]) io.to(onlineUsers[targetId]).emit('messagesRead', { byUserId: currentUserId }); } });

    // V16 NÂNG CẤP PROFILE
    socket.on('updateMyProfile', (data, cb) => {
        if(checkBanStatus()) return; const db = readDB(); const user = db.users.find(u => u.id === currentUserId);
        if(data.phone && !/^[0-9]{10,11}$/.test(data.phone)) return cb({ success: false, msg: "SĐT không hợp lệ!" });
        user.displayName = data.displayName; user.phone = data.phone; user.email = data.email; user.gender = data.gender; user.dob = data.dob; user.bio = data.bio; user.avatar = data.avatar; user.invisible = data.invisible; user.customStatus = data.customStatus; 
        if(data.playerClass) user.playerClass = data.playerClass; // Cập nhật Class
        writeDB(db); cb({ success: true, msg: "Lưu hồ sơ thành công!" }); 
        if(user.invisible) io.emit('userStatusChange', { userId: currentUserId, status: 'offline' }); else io.emit('userStatusChange', { userId: currentUserId, status: 'online' });
        sendUserDataUpdate(currentUserId, socket);
    });

    // Search & Social Friends API
    socket.on('searchUser', (q) => { if(!checkBanStatus()){ const db = readDB(); socket.emit('searchResults', db.users.filter(u => u.id !== currentUserId && u.role !== 'admin' && (u.username.includes(q) || u.phone.includes(q) || (u.displayName && u.displayName.includes(q)))).map(u => ({ id: u.id, displayName: u.displayName || u.username, username: u.username, avatar: u.avatar }))); }});
    socket.on('sendFriendRequest', (tId) => { if(checkBanStatus()) return; const db = readDB(); if (db.friendRequests.find(r => (r.from === currentUserId && r.to === tId) || (r.from === tId && r.to === currentUserId))) return; const sender = db.users.find(u => u.id === currentUserId); const request = { id: 'req_' + Date.now(), from: currentUserId, to: tId, fromName: sender.displayName || sender.username }; db.friendRequests.push(request); writeDB(db); if (onlineUsers[tId]) { io.to(onlineUsers[tId]).emit('newFriendRequest', request); sendUserDataUpdate(tId, io.to(onlineUsers[tId])); } sendUserDataUpdate(currentUserId, socket); });
    socket.on('respondFriendRequest', ({ requestId, action }) => { let db = readDB(); const reqIdx = db.friendRequests.findIndex(r => r.id === requestId); if (reqIdx === -1) return; const request = db.friendRequests[reqIdx]; if (action === 'accept') { const uA = db.users.find(u => u.id === request.from), uB = db.users.find(u => u.id === request.to); if (uA && uB) { if (!uA.friends.includes(uB.id)) uA.friends.push(uB.id); if (!uB.friends.includes(uA.id)) uB.friends.push(uA.id); } } db.friendRequests.splice(reqIdx, 1); writeDB(db); if (onlineUsers[request.from]) sendUserDataUpdate(request.from, io.to(onlineUsers[request.from])); if (onlineUsers[request.to]) sendUserDataUpdate(request.to, io.to(onlineUsers[request.to])); });
    socket.on('toggleBlock', (tId) => { if(checkBanStatus()) return; const db = readDB(); const u = db.users.find(x => x.id === currentUserId); const idx = u.blocks.indexOf(tId); if (idx > -1) u.blocks.splice(idx, 1); else u.blocks.push(tId); writeDB(db); sendUserDataUpdate(currentUserId, socket); if(onlineUsers[tId]) sendUserDataUpdate(tId, io.to(onlineUsers[tId])); });
    socket.on('toggleArchive', (tId) => { if(checkBanStatus()) return; const db = readDB(); const u = db.users.find(x => x.id === currentUserId); const idx = u.archives.indexOf(tId); if (idx > -1) u.archives.splice(idx, 1); else u.archives.push(tId); writeDB(db); sendUserDataUpdate(currentUserId, socket); });

    // Admin Tools
    socket.on('verifyAdminAuth', (pass, cb) => { const db = readDB(); const a = db.users.find(u => u.id === currentUserId && u.role === 'admin'); if (a && bcrypt.compareSync(pass, a.password)) cb({ success: true }); else cb({ success: false, msg: "Sai mã PIN!" }); });
    socket.on('adminGetUsers', () => { const db = readDB(); if (db.users.find(u => u.id === currentUserId && u.role === 'admin')) { const list = db.users.map(u => ({ id: u.id, username: u.username, displayName: u.displayName, phone: u.phone, email: u.email, role: u.role, isBanned: u.isBanned, banUntil: u.banUntil, isMuted: u.isMuted, muteUntil: u.muteUntil, isOnline: !!onlineUsers[u.id] && !u.invisible, avatar: u.avatar, level: Math.floor(Math.sqrt((u.gameScore||0)/100))+1, elo: u.elo })); const stats = { totalUsers: db.users.length, totalMessages: db.messages.length, onlineNow: Object.keys(onlineUsers).length }; socket.emit('adminUsersList', { list, stats }); } });
    socket.on('adminPunishUser', ({ targetId, action, durationMinutes }, cb) => { const db = readDB(); if (db.users.find(u => u.id === currentUserId && u.role === 'admin')) { const t = db.users.find(u => u.id === targetId && u.role !== 'admin'); if(t) { let ex = null; if (durationMinutes !== 'infinite') ex = new Date(Date.now() + parseInt(durationMinutes) * 60000).toISOString(); if (action === 'mute') { t.isMuted = true; t.muteUntil = ex; t.isBanned = false; t.banUntil = null; } else if (action === 'ban') { t.isBanned = true; t.banUntil = ex; t.isMuted = false; t.muteUntil = null; } else if (action === 'unpunish') { t.isBanned = false; t.banUntil = null; t.isMuted = false; t.muteUntil = null; } writeDB(db); if(cb) cb(); if(onlineUsers[targetId]) { if(action === 'ban') io.to(onlineUsers[targetId]).emit('forceBannedUI', { banUntil: t.banUntil }); else if (action === 'mute') io.to(onlineUsers[targetId]).emit('actionError', "Bạn đã bị Admin cấm nhắn tin."); else if (action === 'unpunish') { io.to(onlineUsers[targetId]).emit('actionSuccess', "Đã gỡ án phạt!"); io.to(onlineUsers[targetId]).emit('unbanned'); } } } } });
    socket.on('adminClearUserChat', (targetId) => { const db = readDB(); if (db.users.find(u => u.id === currentUserId && u.role === 'admin')) { db.messages = db.messages.filter(m => m.from !== targetId && m.to !== targetId); writeDB(db); socket.emit('actionSuccess', "Đã xóa toàn bộ dữ liệu chat của User!"); socket.emit('adminGetUsers'); } });
    socket.on('adminDeleteMessage', (msgId) => { const db = readDB(); if (db.users.find(u => u.id === currentUserId && u.role === 'admin')) { const msg = db.messages.find(m => m.id === msgId); if(msg) { msg.isRecalled = true; msg.text = "Admin đã xóa tin nhắn này!"; msg.imgData = null; writeDB(db); io.emit('messageUpdated', msg); } } });
    // =====================================
    // 5. GAME ENGINE V16 (CLASSES, STAMINA, BATTLE ROYALE, DUNGEONS, ELO)
    // =====================================
    const MAP_WIDTH = 3000; 
    const MAP_HEIGHT = 3000;

    socket.on('gameInput', ({ mode, roomId, keys, aimAngle, isShooting, isTyping }) => {
        try {
            let room = null; 
            if(mode === 'ffa') room = ffaGameState; 
            else if(mode === 'zombie') room = zombieGameState; 
            else if(mode === 'dungeon') room = dungeonGameState; // V16 Phụ bản
            else if(mode === 'pk') room = pkRooms[roomId];
            else if(mode === 'safezone') room = safezoneState; // V16 Khu an toàn
            
            if(room && (mode !== 'pk' || room.status === 'playing')) {
                const p = room.players[socket.id];
                if(p && p.hp > 0) {
                    p.keys = keys;
                    p.lastActive = Date.now();
                    p.isTyping = isTyping || false;
                    
                    // V16: HỆ THỐNG THỂ LỰC (STAMINA) KHI LƯỚT
                    if(keys.dash && p.stamina >= 30 && Date.now() > p.nextDashTime) { 
                        p.stamina -= 30; // Tiêu hao 30 thể lực
                        p.dashEndTime = Date.now() + 250; 
                        p.nextDashTime = Date.now() + 1000; // Hồi chiêu lướt 1s
                    }
                    
                    // V16: SAFE ZONE KHÔNG CHO BẮN
                    if(mode !== 'safezone') {
                        if(isShooting && (!p.lastShot || Date.now() - p.lastShot > p.fireRate)) { 
                            p.lastShot = Date.now();
                            
                            // Vũ khí đạn chùm (giữ từ V15)
                            if(p.weaponEndTime > Date.now()) {
                                room.bullets.push({ x: p.x, y: p.y, vx: Math.cos(aimAngle)*18, vy: Math.sin(aimAngle)*18, ownerId: socket.id, life: 70, damage: p.damage });
                                room.bullets.push({ x: p.x, y: p.y, vx: Math.cos(aimAngle-0.3)*18, vy: Math.sin(aimAngle-0.3)*18, ownerId: socket.id, life: 70, damage: p.damage });
                                room.bullets.push({ x: p.x, y: p.y, vx: Math.cos(aimAngle+0.3)*18, vy: Math.sin(aimAngle+0.3)*18, ownerId: socket.id, life: 70, damage: p.damage });
                            } else {
                                room.bullets.push({ x: p.x, y: p.y, vx: Math.cos(aimAngle)*18, vy: Math.sin(aimAngle)*18, ownerId: socket.id, life: 70, damage: p.damage });
                            }
                        }
                    }
                }
            }
        } catch(e) {}
    });

    socket.on('sendInGameChat', ({ roomMode, roomId, text }) => {
        if(checkBanStatus()) return; 
        const db = readDB(); const u = db.users.find(x => x.id === currentUserId); if(!u) return;
        const msg = { sender: u.displayName || u.username, text: text, color: u.role === 'admin' ? '#ef4444' : '#60a5fa' };
        
        if(roomMode === 'ffa') io.to('ffaGameRoom').emit('inGameChatBroadcast', msg);
        else if(roomMode === 'zombie') io.to('zombieGameRoom').emit('inGameChatBroadcast', msg);
        else if(roomMode === 'dungeon') io.to('dungeonGameRoom').emit('inGameChatBroadcast', msg);
        else if(roomMode === 'safezone') io.to('safezoneRoom').emit('inGameChatBroadcast', msg);
        else if(roomMode === 'pk' && roomId) io.to(roomId).emit('inGameChatBroadcast', msg);
    });

    socket.on('minimapPing', ({ roomMode, roomId, x, y }) => {
        if(checkBanStatus()) return;
        if(roomMode === 'ffa') io.to('ffaGameRoom').emit('showPing', { x, y });
        else if(roomMode === 'zombie') io.to('zombieGameRoom').emit('showPing', { x, y });
        else if(roomMode === 'dungeon') io.to('dungeonGameRoom').emit('showPing', { x, y });
        else if(roomMode === 'pk' && roomId) io.to(roomId).emit('showPing', { x, y });
    });

    // V16: KHỞI TẠO CHỈ SỐ THEO CLASS
    function spawnPlayer(mode) {
        const db = readDB(); const user = db.users.find(u => u.id === currentUserId); if(!user) return null;
        
        let maxHp = 100, baseSpeed = 6.5, damage = 20, fireRate = 150, maxStamina = 100;
        
        if(user.playerClass === 'tanker') { maxHp = 200; baseSpeed = 5.0; damage = 15; maxStamina = 150; }
        else if(user.playerClass === 'sniper') { maxHp = 80; baseSpeed = 7.5; damage = 40; fireRate = 500; }
        else if(user.playerClass === 'medic') { maxHp = 120; baseSpeed = 6.0; damage = 15; }

        return { 
            id: socket.id, userId: currentUserId, name: user.displayName || user.username, 
            playerClass: user.playerClass, level: Math.floor(Math.sqrt((user.gameScore||0)/100))+1,
            elo: user.elo || 1000, rank: user.rank || "Đồng",
            x: Math.random() * (MAP_WIDTH - 400) + 200, y: Math.random() * (MAP_HEIGHT - 400) + 200, 
            color: mode==='zombie' ? '#3b82f6' : `hsl(${Math.random() * 360}, 100%, 70%)`, 
            hp: maxHp, maxHp: maxHp, score: 0, 
            stamina: maxStamina, maxStamina: maxStamina, // V16 Thể lực
            keys: { w: false, a: false, s: false, d: false, dash: false },
            baseSpeed: baseSpeed, damage: damage, fireRate: fireRate,
            nextDashTime: 0, dashEndTime: 0, lastActive: Date.now(), isTyping: false, shield: false, weaponEndTime: 0 
        };
    }

    socket.on('joinGame', (mode) => { 
        if(checkBanStatus()) return; 
        if(mode === 'ffa') { socket.join('ffaGameRoom'); ffaGameState.players[socket.id] = spawnPlayer('ffa'); } 
        else if(mode === 'zombie') { socket.join('zombieGameRoom'); zombieGameState.players[socket.id] = spawnPlayer('zombie'); }
        else if(mode === 'dungeon') { socket.join('dungeonGameRoom'); dungeonGameState.players[socket.id] = spawnPlayer('dungeon'); } // V16
        else if(mode === 'safezone') { socket.join('safezoneRoom'); safezoneState.players[socket.id] = spawnPlayer('safezone'); } // V16
    });
    
    socket.on('leaveGame', (mode) => { 
        try { 
            if(mode === 'ffa') { socket.leave('ffaGameRoom'); delete ffaGameState.players[socket.id]; } 
            else if(mode === 'zombie') { socket.leave('zombieGameRoom'); delete zombieGameState.players[socket.id]; }
            else if(mode === 'dungeon') { socket.leave('dungeonGameRoom'); delete dungeonGameState.players[socket.id]; }
            else if(mode === 'safezone') { socket.leave('safezoneRoom'); delete safezoneState.players[socket.id]; }
        } catch(e){} 
    });
    
    socket.on('respawnGame', (mode) => { 
        if(checkBanStatus()) return; 
        if(mode === 'ffa' && ffaGameState.players[socket.id]) ffaGameState.players[socket.id] = spawnPlayer('ffa');
        else if(mode === 'zombie' && zombieGameState.players[socket.id]) zombieGameState.players[socket.id] = spawnPlayer('zombie');
        else if(mode === 'dungeon' && dungeonGameState.players[socket.id]) dungeonGameState.players[socket.id] = spawnPlayer('dungeon');
    });

    // PK V16 (Giữ Spectate)
    socket.on('invitePK', (targetId) => { if(checkBanStatus()) return; if(onlineUsers[targetId]) { const db = readDB(); const sender = db.users.find(u => u.id === currentUserId); io.to(onlineUsers[targetId]).emit('pkInviteReceived', { fromId: currentUserId, fromName: sender.displayName || sender.username }); } else socket.emit('actionError', "Đối thủ offline!"); });
    socket.on('acceptPK', (inviterId) => { 
        if(checkBanStatus()) return; const invS = onlineUsers[inviterId]; if(!invS) return socket.emit('actionError', "Người mời mất mạng!"); 
        const roomId = 'pk_' + Date.now(); socket.join(roomId); io.sockets.sockets.get(invS)?.join(roomId); 
        const db = readDB(); const p1 = db.users.find(u => u.id === inviterId); const p2 = db.users.find(u => u.id === currentUserId); 
        
        let baseSpeed1 = 6.5, maxHp1 = 100, dmg1 = 20; if(p1.playerClass==='tanker'){maxHp1=200; baseSpeed1=5;} else if(p1.playerClass==='sniper'){maxHp1=80; baseSpeed1=7.5; dmg1=40;}
        let baseSpeed2 = 6.5, maxHp2 = 100, dmg2 = 20; if(p2.playerClass==='tanker'){maxHp2=200; baseSpeed2=5;} else if(p2.playerClass==='sniper'){maxHp2=80; baseSpeed2=7.5; dmg2=40;}

        pkRooms[roomId] = { 
            id: roomId, status: 'waiting', 
            players: { 
                [invS]: { id: invS, userId: p1.id, name: p1.displayName || p1.username, playerClass: p1.playerClass, level: Math.floor(Math.sqrt((p1.gameScore||0)/100))+1, elo: p1.elo||1000, x: MAP_WIDTH/2 - 200, y: MAP_HEIGHT/2, color: '#f87171', hp: maxHp1, maxHp: maxHp1, stamina: 100, maxStamina: 100, damage: dmg1, score: 0, keys:{}, baseSpeed: baseSpeed1, nextDashTime:0, dashEndTime:0, shield:false, weaponEndTime:0, lastActive: Date.now() }, 
                [socket.id]: { id: socket.id, userId: p2.id, name: p2.displayName || p2.username, playerClass: p2.playerClass, level: Math.floor(Math.sqrt((p2.gameScore||0)/100))+1, elo: p2.elo||1000, x: MAP_WIDTH/2 + 200, y: MAP_HEIGHT/2, color: '#60a5fa', hp: maxHp2, maxHp: maxHp2, stamina: 100, maxStamina: 100, damage: dmg2, score: 0, keys:{}, baseSpeed: baseSpeed2, nextDashTime:0, dashEndTime:0, shield:false, weaponEndTime:0, lastActive: Date.now() } 
            }, bullets: [], items: [] 
        }; 
        io.to(roomId).emit('pkRoomJoined', pkRooms[roomId]); 
    });
    
    socket.on('startPK', (roomId) => { if(pkRooms[roomId] && pkRooms[roomId].status === 'waiting' && Object.keys(pkRooms[roomId].players).length >= 2) { pkRooms[roomId].status = 'playing'; let i = 0; for(let sid in pkRooms[roomId].players) { let p = pkRooms[roomId].players[sid]; p.hp = p.maxHp; p.stamina = p.maxStamina; p.score = 0; p.shield = false; p.weaponEndTime = 0; p.x = i === 0 ? MAP_WIDTH/2 - 200 : MAP_WIDTH/2 + 200; p.y = MAP_HEIGHT/2; i++; if(i==2) break; } pkRooms[roomId].bullets = []; io.to(roomId).emit('pkGameStarted', pkRooms[roomId]); } });
    socket.on('leavePK', (roomId) => { socket.leave(roomId); if(pkRooms[roomId]) { delete pkRooms[roomId].players[socket.id]; if(Object.keys(pkRooms[roomId].players).length < 2) { io.to(roomId).emit('actionError', "Trận đấu bị hủy bỏ."); io.to(roomId).emit('pkRoomClosed'); delete pkRooms[roomId]; } } });
    socket.on('spectatePK', (roomId) => { if(pkRooms[roomId]) { socket.join(roomId); socket.emit('pkRoomJoined', pkRooms[roomId]); socket.emit('actionSuccess', "Đã vào chế độ Khán giả"); } else { socket.emit('actionError', "Phòng không tồn tại."); } });

    socket.on('disconnect', () => { 
        delete onlineUsers[currentUserId]; 
        const dbForStatus = readDB(); const currUserObj = dbForStatus.users.find(u => u.id === currentUserId);
        if(currUserObj && !currUserObj.invisible) { io.emit('userStatusChange', { userId: currentUserId, status: 'offline' }); }
        delete ffaGameState.players[socket.id]; delete zombieGameState.players[socket.id]; delete dungeonGameState.players[socket.id]; delete safezoneState.players[socket.id];
        for(let roomId in pkRooms) { if(pkRooms[roomId].players[socket.id]) { delete pkRooms[roomId].players[socket.id]; if(Object.keys(pkRooms[roomId].players).length < 2) { io.to(roomId).emit('actionError', "Trận đấu kết thúc do đối thủ thoát."); io.to(roomId).emit('pkRoomClosed'); delete pkRooms[roomId]; } } } 
    });
});

// =======================================================
// 6. GAME LOOP V16 (ZONE, ELO, DUNGEONS, STAMINA)
// =======================================================
let ffaGameState = { players: {}, bullets: [], items: [], zone: { x: MAP_WIDTH/2, y: MAP_HEIGHT/2, radius: 2500 } }; // V16 Zone
let dungeonGameState = { players: {}, bullets: [], bosses: [], items: [], wave: 1 }; // V16 Phụ bản
let safezoneState = { players: {} }; // V16 Safezone Lobby
let zombieGameState = { players: {}, bullets: [], zombies: [], items: [], wave: 1, bossSpawned: false };
let pkRooms = {};

function saveScore(userId, score, mode) {
    if(score < 10) return; const db = readDB(); const user = db.users.find(u => u.id === userId); if(!user) return;
    user.gameScore = (user.gameScore || 0) + score;
    db.leaderboard.push({ name: user.displayName || user.username, score: score, mode: mode, date: new Date().toISOString() });
    db.leaderboard.sort((a,b) => b.score - a.score); db.leaderboard = db.leaderboard.slice(0, 50); writeDB(db);
}

// V16 ELO RANKING SYSTEM (Đấu hạng)
function updateElo(winnerId, loserId) {
    const db = readDB(); 
    const w = db.users.find(u => u.id === winnerId);
    const l = db.users.find(u => u.id === loserId);
    if(w && l) {
        if(!w.elo) w.elo = 1000; if(!l.elo) l.elo = 1000;
        
        // Công thức Elo rút gọn (K=32)
        const expectedW = 1 / (1 + Math.pow(10, (l.elo - w.elo) / 400));
        const expectedL = 1 / (1 + Math.pow(10, (w.elo - l.elo) / 400));
        
        w.elo = Math.round(w.elo + 32 * (1 - expectedW));
        l.elo = Math.max(0, Math.round(l.elo + 32 * (0 - expectedL)));

        // Xếp hạng (Rank)
        const getRank = (elo) => {
            if(elo < 1200) return "Đồng"; if(elo < 1500) return "Bạc"; 
            if(elo < 1800) return "Vàng"; if(elo < 2200) return "Kim Cương"; return "Thách Đấu";
        };
        w.rank = getRank(w.elo); l.rank = getRank(l.elo);
        writeDB(db);
    }
}

function spawnItem(gameState) {
    if(gameState.items.length < 10 && Math.random() < 0.02) {
        let type = 'health'; let r = Math.random();
        if(r > 0.6 && r <= 0.8) type = 'speed'; else if (r > 0.8 && r <= 0.9) type = 'shield'; else if (r > 0.9) type = 'weapon'; 
        gameState.items.push({ id: Math.random(), type: type, x: Math.random() * (MAP_WIDTH - 200) + 100, y: Math.random() * (MAP_HEIGHT - 200) + 100 });
    }
}

function handleItemCollision(player, gameState) {
    gameState.items = gameState.items.filter(item => {
        if(Math.hypot(player.x - item.x, player.y - item.y) < 30) {
            if(item.type === 'health') { player.hp = Math.min(player.maxHp, player.hp + 40); }
            else if (item.type === 'speed') { player.baseSpeed = Math.min(player.baseSpeed + 1, 10.5); }
            else if (item.type === 'shield') { player.shield = true; }
            else if (item.type === 'weapon') { player.weaponEndTime = Date.now() + 15000; }
            return false;
        } return true;
    });
}

setInterval(() => { dayNightCycle.isNight = !dayNightCycle.isNight; io.emit('dayNightUpdate', dayNightCycle.isNight); }, 60000);

setInterval(() => {
    try {
        const handleMovementAndAFK = (players, roomName) => {
            for(let sid in players) {
                let p = players[sid];
                if(p && p.hp > 0) {
                    if(Date.now() - p.lastActive > 120000) { p.hp = 0; if(roomName) io.to(roomName).emit('inGameChatBroadcast', { sender: 'HỆ THỐNG', text: `${p.name} bị kick do AFK`, color: '#ef4444' }); continue; }

                    // V16 Hồi Thể Lực (Stamina Regen)
                    if(p.stamina < p.maxStamina) p.stamina = Math.min(p.maxStamina, p.stamina + 0.5);
                    
                    // V16 Medic Nội tại hồi máu
                    if(p.playerClass === 'medic' && p.hp < p.maxHp && Math.random() < 0.05) p.hp = Math.min(p.maxHp, p.hp + 1); 

                    if(p.keys) {
                        let currentSpeed = p.baseSpeed;
                        if(Date.now() < p.dashEndTime) currentSpeed *= 2.2;
                        let moveCount = 0;
                        if(p.keys.w && p.y > 20) { p.y -= currentSpeed; moveCount++; }
                        if(p.keys.s && p.y < MAP_HEIGHT - 20) { p.y += currentSpeed; moveCount++; }
                        if(p.keys.a && p.x > 20) { p.x -= currentSpeed; moveCount++; }
                        if(p.keys.d && p.x < MAP_WIDTH - 20) { p.x += currentSpeed; moveCount++; }
                        if (moveCount === 2) { p.x += (p.keys.a ? currentSpeed*0.29 : (p.keys.d ? -currentSpeed*0.29 : 0)); p.y += (p.keys.w ? currentSpeed*0.29 : (p.keys.s ? -currentSpeed*0.29 : 0)); }
                    }
                }
            }
        };

        // ==========================
        // 1. V16 BATTLE ROYALE ENGINE (FFA Có Vòng Bo & Elo)
        // ==========================
        handleMovementAndAFK(ffaGameState.players, 'ffaGameRoom'); 
        spawnItem(ffaGameState);
        
        // Thu hẹp vòng bo
        if (ffaGameState.zone.radius > 200) ffaGameState.zone.radius -= 0.3;

        ffaGameState.bullets.forEach(b => { b.x += b.vx; b.y += b.vy; b.life--; }); 
        ffaGameState.bullets = ffaGameState.bullets.filter(b => b.life > 0);
        
        for(let id in ffaGameState.players) {
            let p = ffaGameState.players[id];
            if(p && p.hp > 0) {
                handleItemCollision(p, ffaGameState);
                
                // V16 Nhận sát thương ngoài vòng bo
                if(Math.hypot(p.x - ffaGameState.zone.x, p.y - ffaGameState.zone.y) > ffaGameState.zone.radius) {
                    p.hp -= 0.2; // Rút máu liên tục
                    if(p.hp <= 0) {
                        io.to(id).emit('playerDied', { score: p.score, mode: 'ffa' });
                        io.to('ffaGameRoom').emit('inGameChatBroadcast', { sender: 'HỆ THỐNG', text: `${p.name} đã gục ngã ngoài vòng bo!`, color: '#ef4444' });
                    }
                }

                ffaGameState.bullets.forEach(b => {
                    if(b.life > 0 && b.ownerId !== id && Math.hypot(p.x - b.x, p.y - b.y) < 22) { 
                        b.life = 0; 
                        if(p.shield) { p.shield = false; } else {
                            p.hp -= b.damage || 20; 
                            if(p.hp <= 0) {
                                saveScore(p.userId, p.score, 'Battle Royale'); 
                                io.to(id).emit('playerDied', { score: p.score, mode: 'ffa' });
                                if(ffaGameState.players[b.ownerId]) { 
                                    ffaGameState.players[b.ownerId].score += 50; 
                                    updateElo(ffaGameState.players[b.ownerId].userId, p.userId); // Cộng điểm Elo khi giết địch
                                    io.to('ffaGameRoom').emit('killFeed', { killer: ffaGameState.players[b.ownerId].name, victim: p.name }); 
                                }
                            }
                        }
                    }
                });
            }
        }
        io.to('ffaGameRoom').emit('gameStateUpdate', { mode: 'ffa', state: ffaGameState, isNight: dayNightCycle.isNight });

        // ==========================
        // 2. V16 DUNGEONS ENGINE (PvE Boss Đột Kích)
        // ==========================
        handleMovementAndAFK(dungeonGameState.players, 'dungeonGameRoom'); 
        spawnItem(dungeonGameState);
        dungeonGameState.bullets.forEach(b => { b.x += b.vx; b.y += b.vy; b.life--; }); 
        dungeonGameState.bullets = dungeonGameState.bullets.filter(b => b.life > 0);
        
        let dAliveCount = Object.values(dungeonGameState.players).filter(p => p.hp > 0).length;
        
        // Spawn Boss (Săn Boss Lớn)
        if(dAliveCount > 0 && dungeonGameState.bosses.length === 0) {
            dungeonGameState.bosses.push({ 
                x: MAP_WIDTH/2, y: MAP_HEIGHT/2, 
                hp: 1500 * dAliveCount * dungeonGameState.wave, maxHp: 1500 * dAliveCount * dungeonGameState.wave, 
                speed: 3 + (dungeonGameState.wave * 0.2), id: Math.random(), 
                attacks: 0 // Logic kỹ năng diện rộng của Boss
            });
            io.to('dungeonGameRoom').emit('inGameChatBroadcast', { sender: 'HỆ THỐNG', text: `CẢNH BÁO: BOSS TẦNG ${dungeonGameState.wave} XUẤT HIỆN!`, color: '#ff0000' });
        }

        dungeonGameState.bosses.forEach(boss => {
            let target = null, minDist = Infinity;
            for(let id in dungeonGameState.players) { 
                let p = dungeonGameState.players[id]; 
                if(p.hp > 0) { let d = Math.hypot(p.x - boss.x, p.y - boss.y); if(d < minDist) { minDist = d; target = p; } } 
            }
            if(target) { 
                let angle = Math.atan2(target.y - boss.y, target.x - boss.x); 
                boss.x += Math.cos(angle) * boss.speed; boss.y += Math.sin(angle) * boss.speed; 
                
                // Kỹ năng Boss: Đập đất (Gây dmg diện rộng)
                if(Math.random() < 0.01) {
                    io.to('dungeonGameRoom').emit('showPing', { x: boss.x, y: boss.y }); // Cảnh báo đỏ
                    for(let id in dungeonGameState.players) {
                        let p = dungeonGameState.players[id];
                        if(p.hp > 0 && Math.hypot(p.x - boss.x, p.y - boss.y) < 300) { p.hp -= 40; if(p.shield) p.shield = false; }
                    }
                }
                if(minDist < 60) { if(target.shield) target.shield = false; else target.hp -= 15; }
            }
        });

        dungeonGameState.bullets.forEach(b => { 
            dungeonGameState.bosses.forEach(boss => { 
                if(b.life > 0 && Math.hypot(boss.x - b.x, boss.y - b.y) < 60) { 
                    boss.hp -= b.damage || 20; b.life = 0; 
                    if(boss.hp <= 0 && dungeonGameState.players[b.ownerId]) { 
                        dungeonGameState.players[b.ownerId].score += 500; 
                        dungeonGameState.wave++; // Lên tầng
                        io.to('dungeonGameRoom').emit('inGameChatBroadcast', { sender: 'HỆ THỐNG', text: `${dungeonGameState.players[b.ownerId].name} ĐÃ HẠ GỤC BOSS! CHUYỂN TẦNG KẾ TIẾP!`, color: '#fbbf24' });
                    } 
                } 
            }); 
        });
        dungeonGameState.bosses = dungeonGameState.bosses.filter(b => b.hp > 0);
        
        for(let id in dungeonGameState.players) { 
            let p = dungeonGameState.players[id]; if(p.hp > 0) handleItemCollision(p, dungeonGameState); 
            if(p.hp <= 0 && !p.isDeadNotified) { p.isDeadNotified = true; io.to(id).emit('playerDied', { score: p.score, mode: 'dungeon' }); } 
        }
        io.to('dungeonGameRoom').emit('gameStateUpdate', { mode: 'dungeon', state: dungeonGameState, isNight: dayNightCycle.isNight });

        // ==========================
        // 3. V16 SAFEZONE (LOBBY HÒA BÌNH)
        // ==========================
        handleMovementAndAFK(safezoneState.players, null);
        io.to('safezoneRoom').emit('gameStateUpdate', { mode: 'safezone', state: safezoneState, isNight: dayNightCycle.isNight });

        // ==========================
        // 4. ZOMBIE ENGINE (Giữ nguyên từ V15)
        // ==========================
        handleMovementAndAFK(zombieGameState.players, 'zombieGameRoom'); spawnItem(zombieGameState);
        zombieGameState.bullets.forEach(b => { b.x += b.vx; b.y += b.vy; b.life--; }); zombieGameState.bullets = zombieGameState.bullets.filter(b => b.life > 0);
        let alivePlayersCount = Object.values(zombieGameState.players).filter(p => p.hp > 0).length;
        let totalScore = Object.values(zombieGameState.players).reduce((acc, curr) => acc + curr.score, 0);
        zombieGameState.wave = 1 + Math.floor(totalScore / 500); 
        let maxZombies = alivePlayersCount * 30 + (zombieGameState.wave * 10);
        if(alivePlayersCount > 0 && zombieGameState.zombies.length < maxZombies) {
            if(Math.random() < 0.4) { 
                let pList = Object.values(zombieGameState.players).filter(p => p.hp > 0); let randomP = pList[Math.floor(Math.random() * pList.length)];
                if(randomP) {
                    let angle = Math.random() * Math.PI * 2; let dist = 600 + Math.random() * 200; let zx = randomP.x + Math.cos(angle)*dist; let zy = randomP.y + Math.sin(angle)*dist;
                    if(zx > 20 && zx < MAP_WIDTH-20 && zy > 20 && zy < MAP_HEIGHT-20) { zombieGameState.zombies.push({ x: zx, y: zy, hp: 40 + (zombieGameState.wave * 5), speed: 3.5 + (zombieGameState.wave * 0.1), id: Math.random() }); }
                }
            }
        }
        zombieGameState.zombies.forEach(z => {
            let target = null, minDist = Infinity;
            for(let id in zombieGameState.players) { let p = zombieGameState.players[id]; if(p.hp > 0) { let d = Math.hypot(p.x - z.x, p.y - z.y); if(d < minDist) { minDist = d; target = p; } } }
            if(target && minDist < 1200) { let angle = Math.atan2(target.y - z.y, target.x - z.x); z.x += Math.cos(angle) * z.speed; z.y += Math.sin(angle) * z.speed; if(minDist < 25) { if(target.shield) target.shield = false; else target.hp -= 2; } } else { z.x += (Math.random() - 0.5) * 2; z.y += (Math.random() - 0.5) * 2; }
        });
        zombieGameState.bullets.forEach(b => { zombieGameState.zombies.forEach(z => { if(b.life > 0 && Math.hypot(z.x - b.x, z.y - b.y) < 22) { z.hp -= b.damage || 20; b.life = 0; if(z.hp <= 0 && zombieGameState.players[b.ownerId]) { zombieGameState.players[b.ownerId].score += 10; } } }); });
        zombieGameState.zombies = zombieGameState.zombies.filter(z => z.hp > 0);
        for(let id in zombieGameState.players) { let p = zombieGameState.players[id]; if(p.hp > 0) handleItemCollision(p, zombieGameState); if(p.hp <= 0 && !p.isDeadNotified) { p.isDeadNotified = true; saveScore(p.userId, p.score, 'Săn Zombie'); io.to(id).emit('playerDied', { score: p.score, mode: 'zombie' }); } }
        io.to('zombieGameRoom').emit('gameStateUpdate', { mode: 'zombie', state: zombieGameState, isNight: dayNightCycle.isNight });

        // ==========================
        // 5. PK 1VS1 ENGINE (V16 UPDATE ELO SAU TRẬN)
        // ==========================
        for(let roomId in pkRooms) {
            let room = pkRooms[roomId];
            if(room && room.status === 'playing') {
                handleMovementAndAFK(room.players, null);
                room.bullets.forEach(b => { b.x += b.vx; b.y += b.vy; b.life--; }); room.bullets = room.bullets.filter(b => b.life > 0);
                room.bullets.forEach(b => { for(let sid in room.players) { let p = room.players[sid]; if(p.hp > 0 && b.ownerId !== sid && Math.hypot(p.x - b.x, p.y - b.y) < 22) { b.life = 0; if(p.shield) { p.shield = false; } else { p.hp -= b.damage || 20; if(p.hp <= 0 && room.players[b.ownerId]) { room.players[b.ownerId].score += 10; io.to(roomId).emit('killFeed', { killer: room.players[b.ownerId].name, victim: p.name }); if(room.players[b.ownerId].score >= 100) { room.status = 'waiting'; updateElo(room.players[b.ownerId].userId, p.userId); /* V16 Update Elo */ io.to(roomId).emit('pkGameOver', { winnerName: room.players[b.ownerId].name }); } else { setTimeout(() => { if(room.players[sid]) { room.players[sid].hp = room.players[sid].maxHp; room.players[sid].stamina = room.players[sid].maxStamina; room.players[sid].x = MAP_WIDTH/2 + (Math.random()>0.5?200:-200); room.players[sid].y = MAP_HEIGHT/2; room.players[sid].shield = false; } }, 1500); } } } } } });
                io.to(roomId).emit('gameStateUpdate', { mode: 'pk', state: room, isNight: false });
            }
        }
    } catch(err) { console.error("Lỗi Game Loop:", err); } 
}, 1000 / 60);

// Đồng bộ V16 - Cập nhật truyền Elo, Rank, Class, Stamina, Scheduled Msg, Khảo sát, Nhóm...
function sendUserDataUpdate(userId, socketTarget) { 
    const db = readDB(); const user = db.users.find(u => u.id === userId); if (!user) return; 
    let friendsList = db.users.filter(u => user.friends.includes(u.id) || u.role === 'admin'); 
    if(user.role === 'admin') { const msgIds = [...new Set(db.messages.filter(m => m.to === userId || m.groupId != null).map(m => m.from))]; friendsList = db.users.filter(u => u.role !== 'admin' && (user.friends.includes(u.id) || msgIds.includes(u.id))); } 
    socketTarget.emit('userDataPackage', { 
        friends: friendsList.map(u => ({ 
            id: u.id, username: u.username, displayName: u.displayName || u.username, role: u.role, 
            phone: u.phone, email: u.email, gender: u.gender, dob: u.dob, bio: u.bio, 
            isOnline: !!onlineUsers[u.id] && !u.invisible, 
            isBlocked: user.blocks ? user.blocks.includes(u.id) : false, isBlockedBy: u.blocks ? u.blocks.includes(user.id) : false, isArchived: user.archives ? user.archives.includes(u.id) : false, 
            avatar: u.avatar, customStatus: u.customStatus, 
            level: Math.floor(Math.sqrt((u.gameScore||0)/100))+1, elo: u.elo, rank: u.rank, playerClass: u.playerClass // V16 Stats
        })), 
        messages: db.messages.filter(m => m.from === userId || m.to === userId || m.groupId != null), 
        requests: db.friendRequests.filter(r => r.to === userId), blocks: user.blocks || [], archives: user.archives || [], isMuted: user.isMuted,
        pinnedMessages: db.pinnedMessages || {}
    }); 
}

setInterval(() => { io.emit('leaderboardUpdate', readDB().leaderboard); }, 5 * 60 * 1000); 
setInterval(() => { const now = new Date(); if(now.getHours() === 0 && now.getMinutes() === 0) { const db = readDB(); if(db.leaderboard && db.leaderboard.length > 0) { db.dailyWinner = db.leaderboard[0]; writeDB(db); io.emit('dailyWinnerNotice', db.dailyWinner); } } }, 60000);

server.listen(PORT, () => console.log(`Cherry Server V16 GOD TIER running on port ${PORT}`));