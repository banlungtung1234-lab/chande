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

// Giới hạn ảnh 10MB
const io = new Server(server, { maxHttpBufferSize: 1e7 }); 
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'database.json');

// --- 1. KHỞI TẠO CƠ SỞ DỮ LIỆU ---
function initDatabase() {
    if (!fs.existsSync(DB_FILE)) {
        const adminPasswordHash = bcrypt.hashSync('admin123@', 10);
        const initialData = {
            users: [{
                id: "admin-id", username: "admin", phone: "0123456789", email: "admin@gmail.com",
                password: adminPasswordHash, displayName: "Hệ Thống Admin", role: "admin",
                isBanned: false, banUntil: null, isMuted: false, muteUntil: null, 
                friends: [], blocks: [], archives: [],
                gender: "secret", dob: "", bio: "Quản trị viên tối cao", gameScore: 0
            }],
            messages: [], friendRequests: []
        };
        fs.writeFileSync(DB_FILE, JSON.stringify(initialData, null, 2));
    } else {
        const db = readDB();
        let needsUpdate = false;
        db.users.forEach(u => { 
            if(u.gameScore === undefined) { u.gameScore = 0; needsUpdate = true; }
        });
        if(needsUpdate) writeDB(db);
    }
}
initDatabase();

function readDB() { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
function writeDB(data) { fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2)); }

// --- 2. CẤU HÌNH MIDDLEWARE ---
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

// --- 3. ĐƯỜNG DẪN API (AUTH & KIỂM TRA KHÓA) ---
app.post('/api/register', (req, res) => {
    const { username, phone, email, password, confirmPassword } = req.body;
    if (username.length < 4) return res.status(400).json({ msg: "Tên đăng nhập phải trên 4 ký tự!" });
    if (password !== confirmPassword) return res.status(400).json({ msg: "Mật khẩu xác nhận không khớp!" });

    const db = readDB();
    if (db.users.find(u => u.username === username)) return res.status(400).json({ msg: "Tên đăng nhập đã tồn tại!" });

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

app.post('/api/setup-profile', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ msg: "Chưa đăng nhập!" });
    const { displayName } = req.body; const db = readDB(); 
    const user = db.users.find(u => u.id === req.session.userId);
    user.displayName = displayName; writeDB(db); res.json({ msg: "Cập nhật thành công!", role: user.role });
});

app.post('/api/login', (req, res) => {
    const { loginKey, password } = req.body; const db = readDB();
    const user = db.users.find(u => u.username === loginKey || u.phone === loginKey);
    
    if (!user || !bcrypt.compareSync(password, user.password)) return res.status(400).json({ msg: "Tài khoản hoặc mật khẩu không đúng!" });
    
    // KIỂM TRA KHÓA (BAN) KHI ĐĂNG NHẬP
    if (user.isBanned) {
        if (user.banUntil && new Date() > new Date(user.banUntil)) {
            user.isBanned = false; user.banUntil = null; writeDB(db); // Hết hạn
        } else {
            return res.json({ step: "banned", banUntil: user.banUntil, msg: "Tài khoản của bạn đang bị khóa!" });
        }
    }
    
    req.session.userId = user.id;
    res.json({ msg: "Đăng nhập thành công!", role: user.role, needProfile: (!user.displayName || user.displayName.trim() === "") });
});

app.post('/api/logout', (req, res) => { req.session.destroy(); res.json({ msg: "Đã đăng xuất!" }); });

app.get('/api/me', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ msg: "Chưa đăng nhập" });
    const db = readDB(); const user = db.users.find(u => u.id === req.session.userId);
    if(!user) return res.status(404).json({ msg: "Lỗi dữ liệu" });
    
    // KIỂM TRA LẠI KHÓA Ở ROUTE ME (Đề phòng tải lại trang)
    if (user.isBanned) {
        if (user.banUntil && new Date() > new Date(user.banUntil)) {
            user.isBanned = false; user.banUntil = null; writeDB(db);
        } else {
            return res.status(403).json({ isBanned: true, banUntil: user.banUntil });
        }
    }

    res.json({ id: user.id, username: user.username, displayName: user.displayName, phone: user.phone, email: user.email, role: user.role, gender: user.gender, dob: user.dob, bio: user.bio, gameScore: user.gameScore });
});


// ====================================================================================
// --- 4. HỆ THỐNG GIAO TIẾP REALTIME (SOCKET.IO) & BẢO MẬT ĐA TẦNG ---
// ====================================================================================
io.on('connection', (socket) => {
    const session = socket.request.session;
    if (!session || !session.userId) return;
    
    const currentUserId = session.userId;
    onlineUsers[currentUserId] = socket.id;
    io.emit('userStatusChange', { userId: currentUserId, status: 'online' });

    // HÀM KIỂM TRA BẢO MẬT TỐI CAO (Chặn đứng mọi hành động nếu bị khóa)
    const checkBanStatus = () => {
        const db = readDB();
        const user = db.users.find(u => u.id === currentUserId);
        if(!user) return true;
        if (user.isBanned) {
            if (user.banUntil && new Date() > new Date(user.banUntil)) {
                user.isBanned = false; user.banUntil = null; writeDB(db); return false;
            }
            socket.emit('forceBannedUI', { banUntil: user.banUntil });
            return true; // Đang bị khóa
        }
        return false;
    };

    socket.on('initData', () => {
        if(checkBanStatus()) return;
        sendUserDataUpdate(currentUserId, socket);
    });

    socket.on('typing', (toUserId) => { 
        if(checkBanStatus()) return;
        if (onlineUsers[toUserId]) io.to(onlineUsers[toUserId]).emit('userTyping', currentUserId); 
    });
    
    socket.on('stopTyping', (toUserId) => { 
        if (onlineUsers[toUserId]) io.to(onlineUsers[toUserId]).emit('userStoppedTyping', currentUserId); 
    });

    // BẢO VỆ TUYỆT ĐỐI HÀM GỬI TIN NHẮN
    socket.on('sendMessage', ({ toUserId, text, type = 'text', imgData = null }) => {
        if(checkBanStatus()) return; // VỪA NHẤN GỬI MÀ BỊ KHÓA LÀ CHẶN NGAY

        const db = readDB();
        const sender = db.users.find(u => u.id === currentUserId);
        const receiver = db.users.find(u => u.id === toUserId);
        if (!sender || !receiver) return;

        // Xử lý tự động gỡ Mute
        if (sender.isMuted && sender.muteUntil && new Date() > new Date(sender.muteUntil)) {
            sender.isMuted = false; sender.muteUntil = null; writeDB(db);
        }

        if (sender.isMuted && sender.role !== 'admin') {
            const timeMsg = sender.muteUntil ? `đến ${new Date(sender.muteUntil).toLocaleString()}` : "vĩnh viễn";
            return socket.emit('actionError', `Bạn đã bị cấm nhắn tin ${timeMsg}.`);
        }

        if (sender.role !== 'admin' && receiver.role !== 'admin') {
            if (receiver.blocks && receiver.blocks.includes(currentUserId)) return socket.emit('actionError', "Không thể gửi. Đối phương đã chặn bạn!");
            if (sender.blocks && sender.blocks.includes(toUserId)) return socket.emit('actionError', "Bạn đang chặn người này. Hãy gỡ chặn để nhắn tin!");
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

    // Profile và Đổi Pass...
    socket.on('updateMyProfile', (data, callback) => {
        if(checkBanStatus()) return;
        const db = readDB(); const user = db.users.find(u => u.id === currentUserId);
        user.displayName = data.displayName; user.phone = data.phone; user.email = data.email;
        user.gender = data.gender; user.dob = data.dob; user.bio = data.bio;
        writeDB(db); callback({ success: true, msg: "Lưu hồ sơ thành công!" }); sendUserDataUpdate(currentUserId, socket);
    });

    socket.on('changePasswordInternal', ({ oldPass, newPass }, callback) => {
        if(checkBanStatus()) return;
        const db = readDB(); const user = db.users.find(u => u.id === currentUserId);
        if (user && bcrypt.compareSync(oldPass, user.password)) { user.password = bcrypt.hashSync(newPass, 10); writeDB(db); callback({ success: true, msg: "Thay đổi mật khẩu thành công!" }); } else callback({ success: false, msg: "Mật khẩu cũ sai!" });
    });

    socket.on('searchUser', (query) => {
        if(checkBanStatus()) return;
        const db = readDB(); const results = db.users.filter(u => u.id !== currentUserId && u.role !== 'admin' && (u.username.includes(query) || u.phone.includes(query))).map(u => ({ id: u.id, displayName: u.displayName || u.username, username: u.username }));
        socket.emit('searchResults', results);
    });

    // Các hàm tương tác bạn bè (Đã bọc kiểm tra khóa)
    socket.on('sendFriendRequest', (targetId) => {
        if(checkBanStatus()) return;
        const db = readDB(); if (db.friendRequests.find(r => (r.from === currentUserId && r.to === targetId) || (r.from === targetId && r.to === currentUserId))) return;
        const sender = db.users.find(u => u.id === currentUserId); const request = { id: 'req_' + Date.now(), from: currentUserId, to: targetId, fromName: sender.displayName || sender.username };
        db.friendRequests.push(request); writeDB(db);
        if (onlineUsers[targetId]) { io.to(onlineUsers[targetId]).emit('newFriendRequest', request); sendUserDataUpdate(targetId, io.to(onlineUsers[targetId])); }
        sendUserDataUpdate(currentUserId, socket);
    });

    socket.on('toggleBlock', (targetId) => {
        if(checkBanStatus()) return;
        const db = readDB(); const user = db.users.find(u => u.id === currentUserId); if (!user) return;
        const idx = user.blocks.indexOf(targetId); if (idx > -1) user.blocks.splice(idx, 1); else user.blocks.push(targetId); writeDB(db); sendUserDataUpdate(currentUserId, socket);
        if(onlineUsers[targetId]) sendUserDataUpdate(targetId, io.to(onlineUsers[targetId]));
    });


    // --- CỔNG QUẢN TRỊ ADMIN ---
    socket.on('verifyAdminAuth', (pass, callback) => {
        const db = readDB(); const admin = db.users.find(u => u.id === currentUserId && u.role === 'admin');
        if (admin && bcrypt.compareSync(pass, admin.password)) callback({ success: true }); else callback({ success: false, msg: "Mật khẩu quản trị sai!" });
    });

    socket.on('adminGetUsers', () => {
        const db = readDB();
        if (db.users.find(u => u.id === currentUserId && u.role === 'admin')) {
            const syncAdminListData = db.users.map(u => ({
                id: u.id, username: u.username, displayName: u.displayName, role: u.role, 
                isBanned: u.isBanned, banUntil: u.banUntil, isMuted: u.isMuted, muteUntil: u.muteUntil, isOnline: !!onlineUsers[u.id]
            }));
            socket.emit('adminUsersList', syncAdminListData);
        }
    });

    // ADMIN TRỪNG PHẠT - ĐẨY LỆNH ĐẾN TRỰC TIẾP UI NGƯỜI DÙNG BỊ KHÓA
    socket.on('adminPunishUser', ({ targetId, action, durationMinutes }, callback) => {
        const db = readDB(); 
        if (db.users.find(u => u.id === currentUserId && u.role === 'admin')) {
            const target = db.users.find(u => u.id === targetId && u.role !== 'admin');
            if(target) {
                let expireTime = null;
                if (durationMinutes !== 'infinite') expireTime = new Date(Date.now() + parseInt(durationMinutes) * 60000).toISOString();

                if (action === 'mute') {
                    target.isMuted = true; target.muteUntil = expireTime;
                    target.isBanned = false; target.banUntil = null;
                } else if (action === 'ban') {
                    target.isBanned = true; target.banUntil = expireTime;
                    target.isMuted = false; target.muteUntil = null;
                } else if (action === 'unpunish') {
                    target.isBanned = false; target.banUntil = null;
                    target.isMuted = false; target.muteUntil = null;
                }
                writeDB(db); 
                if(callback) callback(); 

                // Đẩy thông báo/cắt luồng trực tiếp đến thiết bị người bị phạt
                if(onlineUsers[targetId]) {
                    if(action === 'ban') io.to(onlineUsers[targetId]).emit('forceBannedUI', { banUntil: target.banUntil });
                    else if (action === 'mute') io.to(onlineUsers[targetId]).emit('actionError', "Tài khoản của bạn vừa bị Admin cấm nhắn tin.");
                    else if (action === 'unpunish') {
                        io.to(onlineUsers[targetId]).emit('actionSuccess', "Bạn đã được gỡ bỏ án phạt!");
                        io.to(onlineUsers[targetId]).emit('unbanned'); // Load lại UI chat
                    }
                }
            }
        }
    });

    // ====================================================================================
    // --- 5. LOGIC MINI GAME BẮN SÚNG 2D (CHERRY ARENA) ---
    // ====================================================================================
    socket.on('joinGame', () => {
        if(checkBanStatus()) return;
        const db = readDB(); const user = db.users.find(u => u.id === currentUserId);
        socket.join('gameRoom');
        gameState.players[socket.id] = {
            id: socket.id, userId: currentUserId, name: user.displayName || user.username,
            x: Math.random() * 600 + 100, y: Math.random() * 400 + 100,
            color: `hsl(${Math.random() * 360}, 100%, 70%)`, hp: 100, score: user.gameScore || 0
        };
    });

    socket.on('leaveGame', () => {
        socket.leave('gameRoom');
        delete gameState.players[socket.id];
    });

    socket.on('playerMove', (data) => {
        const player = gameState.players[socket.id];
        if(player && player.hp > 0) {
            player.x = data.x; player.y = data.y;
        }
    });

    socket.on('playerShoot', (data) => {
        const player = gameState.players[socket.id];
        if(player && player.hp > 0) {
            gameState.bullets.push({
                id: Math.random(), ownerId: socket.id,
                x: player.x, y: player.y,
                vx: data.vx, vy: data.vy, life: 60
            });
        }
    });

    socket.on('disconnect', () => { 
        delete onlineUsers[currentUserId]; 
        delete gameState.players[socket.id];
        io.emit('userStatusChange', { userId: currentUserId, status: 'offline' }); 
    });
});

// --- VÒNG LẶP XỬ LÝ GAME ENGINE (Cập nhật 30 khung hình / giây) ---
let gameState = { players: {}, bullets: [] };

setInterval(() => {
    // Di chuyển đạn & giảm thời gian sống
    gameState.bullets.forEach(b => {
        b.x += b.vx; b.y += b.vy; b.life--;
    });
    // Xóa đạn hết hạn
    gameState.bullets = gameState.bullets.filter(b => b.life > 0);

    // Kiểm tra va chạm (Đạn trúng người chơi)
    gameState.bullets.forEach((b, index) => {
        for(let id in gameState.players) {
            let p = gameState.players[id];
            if(p.hp > 0 && b.ownerId !== id) {
                let dx = p.x - b.x; let dy = p.y - b.y;
                let dist = Math.sqrt(dx*dx + dy*dy);
                if(dist < 20) { // Bán kính trúng đạn
                    p.hp -= 20;
                    b.life = 0; // Xóa đạn
                    if(p.hp <= 0) {
                        // Người bắn được cộng điểm
                        if(gameState.players[b.ownerId]) {
                            gameState.players[b.ownerId].score += 10;
                            // Lưu điểm vào DB thực
                            const db = readDB();
                            const shooterUser = db.users.find(u => u.id === gameState.players[b.ownerId].userId);
                            if(shooterUser) { shooterUser.gameScore = gameState.players[b.ownerId].score; writeDB(db); }
                        }
                        // Hồi sinh sau 3s
                        setTimeout(() => {
                            if(gameState.players[id]) {
                                gameState.players[id].hp = 100;
                                gameState.players[id].x = Math.random() * 600 + 100;
                                gameState.players[id].y = Math.random() * 400 + 100;
                            }
                        }, 3000);
                    }
                }
            }
        }
    });
    gameState.bullets = gameState.bullets.filter(b => b.life > 0);
    
    // Gửi dữ liệu cho tất cả người trong phòng Game
    io.to('gameRoom').emit('gameStateUpdate', gameState);
}, 1000 / 30);


// Hàm gộp dữ liệu Client
function sendUserDataUpdate(userId, socketTarget) {
    const db = readDB(); const user = db.users.find(u => u.id === userId); if (!user) return;
    let friendsList = db.users.filter(u => user.friends.includes(u.id) || u.role === 'admin');
    
    if(user.role === 'admin') {
        const messagedAdminIds = [...new Set(db.messages.filter(m => m.to === userId).map(m => m.from))];
        friendsList = db.users.filter(u => u.role !== 'admin' && (user.friends.includes(u.id) || messagedAdminIds.includes(u.id)));
    }

    const syncedFriendsList = friendsList.map(u => ({
        id: u.id, username: u.username, displayName: u.displayName || u.username, role: u.role,
        isOnline: !!onlineUsers[u.id], 
        isBlocked: user.blocks ? user.blocks.includes(u.id) : false,
        isBlockedBy: u.blocks ? u.blocks.includes(user.id) : false,
        isArchived: user.archives ? user.archives.includes(u.id) : false
    }));
    
    socketTarget.emit('userDataPackage', {
        friends: syncedFriendsList,
        messages: db.messages.filter(m => m.from === userId || m.to === userId),
        requests: db.friendRequests.filter(r => r.to === userId),
        blocks: user.blocks || [], archives: user.archives || [], isMuted: user.isMuted
    });
}

server.listen(PORT, () => console.log(`Cherry Server V6 (Game & Strict Ban) running on port ${PORT}`));