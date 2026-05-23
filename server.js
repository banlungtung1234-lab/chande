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

// FIX LỖI ẢNH: Tăng giới hạn gói tin lên 10MB để ảnh Base64 không bị rớt mạng
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
                gender: "secret", dob: "", bio: "Quản trị viên tối cao"
            }],
            messages: [], friendRequests: []
        };
        fs.writeFileSync(DB_FILE, JSON.stringify(initialData, null, 2));
    } else {
        // Cập nhật cấu trúc DB cũ
        const db = readDB();
        let needsUpdate = false;
        db.users.forEach(u => { 
            if(u.isMuted === undefined) { u.isMuted = false; needsUpdate = true; }
            if(u.muteUntil === undefined) { u.muteUntil = null; needsUpdate = true; }
            if(u.gender === undefined) { u.gender = "secret"; u.dob = ""; u.bio = ""; needsUpdate = true; }
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
    secret: 'cherry-blossom-secret-key-pro-v5',
    resave: false, saveUninitialized: true,
    store: new MemoryStore({ checkPeriod: 86400000 }), 
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
});
app.use(sessionMiddleware);
app.use(express.static(path.join(__dirname, 'public')));

io.use((socket, next) => { sessionMiddleware(socket.request, socket.request.res || {}, next); });

let onlineUsers = {}; 

// --- 3. ĐƯỜNG DẪN API (AUTH) ---
app.post('/api/register', (req, res) => {
    const { username, phone, email, password, confirmPassword } = req.body;
    if (username.length < 4) return res.status(400).json({ msg: "Tên đăng nhập phải trên 4 ký tự!" });
    if (!/^(0|\+84)[0-9]{8,9}$/.test(phone)) return res.status(400).json({ msg: "Số điện thoại không hợp lệ!" });
    if (!/[!@#$%^&*(),.?":{}|<>]/.test(password)) return res.status(400).json({ msg: "Mật khẩu quá yếu!" });
    if (password !== confirmPassword) return res.status(400).json({ msg: "Mật khẩu xác nhận không khớp!" });

    const db = readDB();
    if (db.users.find(u => u.username === username)) return res.status(400).json({ msg: "Tên đăng nhập đã tồn tại!" });
    if (db.users.find(u => u.phone === phone)) return res.status(400).json({ msg: "Số điện thoại đã được đăng ký!" });

    const newUser = {
        id: 'user_' + Date.now(), username, phone, email: email || "",
        password: bcrypt.hashSync(password, 10), displayName: "", role: "user",
        isBanned: false, banUntil: null, isMuted: false, muteUntil: null,
        friends: [], blocks: [], archives: [], gender: "secret", dob: "", bio: ""
    };
    db.users.push(newUser); writeDB(db);
    req.session.userId = newUser.id;
    res.json({ msg: "Đăng ký thành công!", step: "setupProfile" });
});

app.post('/api/setup-profile', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ msg: "Chưa đăng nhập!" });
    const { displayName } = req.body; const db = readDB(); 
    const user = db.users.find(u => u.id === req.session.userId);
    if (!user || user.username === displayName) return res.status(400).json({ msg: "Tên hiển thị không được trùng tên đăng nhập!" });
    user.displayName = displayName; writeDB(db); res.json({ msg: "Cập nhật thành công!", role: user.role });
});

app.post('/api/login', (req, res) => {
    const { loginKey, password } = req.body; const db = readDB();
    const user = db.users.find(u => u.username === loginKey || u.phone === loginKey);
    
    if (!user || !bcrypt.compareSync(password, user.password)) return res.status(400).json({ msg: "Tài khoản hoặc mật khẩu không đúng!" });
    
    // KIỂM TRA KHÓA (BAN) NGAY TỪ LÚC ĐĂNG NHẬP
    if (user.isBanned) {
        if (user.banUntil && new Date() > new Date(user.banUntil)) {
            user.isBanned = false; user.banUntil = null; writeDB(db); // Hết hạn phạt
        } else {
            const timeMsg = user.banUntil ? `đến ${new Date(user.banUntil).toLocaleString()}` : "vĩnh viễn";
            return res.status(403).json({ msg: `Tài khoản bị khóa ${timeMsg}. Liên hệ Admin!` });
        }
    }
    
    req.session.userId = user.id;
    res.json({ msg: "Đăng nhập thành công!", role: user.role, needProfile: (!user.displayName || user.displayName.trim() === "") });
});

app.post('/api/logout', (req, res) => { req.session.destroy(); res.json({ msg: "Đã đăng xuất!" }); });

app.get('/api/me', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ msg: "Chưa đăng nhập" });
    const db = readDB(); const user = db.users.find(u => u.id === req.session.userId);
    if(!user) return res.status(404).json({ msg: "Lỗi dữ liệu tài khoản" });
    res.json({ id: user.id, username: user.username, displayName: user.displayName, phone: user.phone, email: user.email, role: user.role, gender: user.gender, dob: user.dob, bio: user.bio });
});

// --- 4. HỆ THỐNG GIAO TIẾP REALTIME (SOCKET.IO) ---
io.on('connection', (socket) => {
    const session = socket.request.session;
    if (!session || !session.userId) return;
    
    const currentUserId = session.userId;
    onlineUsers[currentUserId] = socket.id;
    io.emit('userStatusChange', { userId: currentUserId, status: 'online' });
    socket.on('initData', () => sendUserDataUpdate(currentUserId, socket));

    socket.on('typing', (toUserId) => { if (onlineUsers[toUserId]) io.to(onlineUsers[toUserId]).emit('userTyping', currentUserId); });
    socket.on('stopTyping', (toUserId) => { if (onlineUsers[toUserId]) io.to(onlineUsers[toUserId]).emit('userStoppedTyping', currentUserId); });

    // FIX LỖI: CHẶN/MUTE VẪN NHẮN ĐƯỢC
    socket.on('sendMessage', ({ toUserId, text, type = 'text', imgData = null }) => {
        const db = readDB();
        const sender = db.users.find(u => u.id === currentUserId);
        const receiver = db.users.find(u => u.id === toUserId);
        if (!sender || !receiver) return;

        // Xử lý tự động gỡ Mute nếu hết hạn
        if (sender.isMuted && sender.muteUntil && new Date() > new Date(sender.muteUntil)) {
            sender.isMuted = false; sender.muteUntil = null; writeDB(db);
        }

        // 1. Kiểm tra Mute (Cấm nhắn tin)
        if (sender.isMuted && sender.role !== 'admin') {
            const timeMsg = sender.muteUntil ? `đến ${new Date(sender.muteUntil).toLocaleString()}` : "vĩnh viễn";
            return socket.emit('actionError', `Bạn đã bị cấm nhắn tin ${timeMsg}.`);
        }

        // 2. Kiểm tra Block 2 chiều
        if (sender.role !== 'admin' && receiver.role !== 'admin') {
            if (receiver.blocks && receiver.blocks.includes(currentUserId)) {
                return socket.emit('actionError', "Không thể gửi. Đối phương đã chặn bạn!");
            }
            if (sender.blocks && sender.blocks.includes(toUserId)) {
                return socket.emit('actionError', "Bạn đang chặn người này. Hãy gỡ chặn để nhắn tin!");
            }
        }

        // 3. Phải là bạn bè hoặc Admin
        if (!sender.friends.includes(toUserId) && sender.role !== 'admin' && receiver.role !== 'admin') {
            return socket.emit('actionError', "Hai người chưa là bạn bè!");
        }

        const msgObj = { 
            id: 'msg_' + Date.now(), from: currentUserId, to: toUserId, type, text, imgData,
            timestamp: new Date().toISOString(), isEdited: false, isRecalled: false
        };
        db.messages.push(msgObj); writeDB(db);
        
        socket.emit('receiveMessage', msgObj);
        if (onlineUsers[toUserId]) {
            io.to(onlineUsers[toUserId]).emit('receiveMessage', msgObj);
            io.to(onlineUsers[toUserId]).emit('msgPopupNotification', { fromName: sender.displayName, text: type === 'image' ? '📸 Đã gửi một hình ảnh' : text });
        }
    });

    socket.on('editMessage', ({ msgId, newText }) => {
        const db = readDB(); const msg = db.messages.find(m => m.id === msgId && m.from === currentUserId);
        if(msg && !msg.isRecalled && msg.type === 'text') { 
            msg.text = newText; msg.isEdited = true; writeDB(db); 
            io.to(onlineUsers[currentUserId]).emit('messageUpdated', msg);
            if(onlineUsers[msg.to]) io.to(onlineUsers[msg.to]).emit('messageUpdated', msg);
        }
    });

    socket.on('recallMessage', (msgId) => {
        const db = readDB(); const msg = db.messages.find(m => m.id === msgId && m.from === currentUserId);
        if(msg && !msg.isRecalled) { 
            msg.isRecalled = true; msg.text = "🚫 Tin nhắn đã được thu hồi"; msg.imgData = null; writeDB(db); 
            io.to(onlineUsers[currentUserId]).emit('messageUpdated', msg);
            if(onlineUsers[msg.to]) io.to(onlineUsers[msg.to]).emit('messageUpdated', msg);
        }
    });

    // Cập nhật Full Profile
    socket.on('updateMyProfile', (data, callback) => {
        const db = readDB(); const user = db.users.find(u => u.id === currentUserId); if (!user) return;
        if (!/^(0|\+84)[0-9]{8,9}$/.test(data.phone)) return callback({ success: false, msg: "SĐT không đúng định dạng!" });
        user.displayName = data.displayName; user.phone = data.phone; user.email = data.email;
        user.gender = data.gender; user.dob = data.dob; user.bio = data.bio;
        writeDB(db); callback({ success: true, msg: "Lưu hồ sơ thành công!" }); sendUserDataUpdate(currentUserId, socket);
    });

    socket.on('changePasswordInternal', ({ oldPass, newPass }, callback) => {
        if (!/[!@#$%^&*(),.?":{}|<>]/.test(newPass)) return callback({ success: false, msg: "Mật khẩu mới phải mạnh!" });
        const db = readDB(); const user = db.users.find(u => u.id === currentUserId);
        if (user && bcrypt.compareSync(oldPass, user.password)) { user.password = bcrypt.hashSync(newPass, 10); writeDB(db); callback({ success: true, msg: "Thay đổi mật khẩu thành công!" }); } else callback({ success: false, msg: "Mật khẩu cũ sai!" });
    });

    // Mạng xã hội
    socket.on('searchUser', (query) => {
        const db = readDB(); const results = db.users.filter(u => u.id !== currentUserId && u.role !== 'admin' && (u.username.includes(query) || u.phone.includes(query))).map(u => ({ id: u.id, displayName: u.displayName || u.username, username: u.username }));
        socket.emit('searchResults', results);
    });
    socket.on('sendFriendRequest', (targetId) => {
        const db = readDB(); if (db.friendRequests.find(r => (r.from === currentUserId && r.to === targetId) || (r.from === targetId && r.to === currentUserId))) return;
        const sender = db.users.find(u => u.id === currentUserId); const request = { id: 'req_' + Date.now(), from: currentUserId, to: targetId, fromName: sender.displayName || sender.username };
        db.friendRequests.push(request); writeDB(db);
        if (onlineUsers[targetId]) { io.to(onlineUsers[targetId]).emit('newFriendRequest', request); sendUserDataUpdate(targetId, io.to(onlineUsers[targetId])); }
        sendUserDataUpdate(currentUserId, socket);
    });
    socket.on('respondFriendRequest', ({ requestId, action }) => {
        let db = readDB(); const reqIdx = db.friendRequests.findIndex(r => r.id === requestId); if (reqIdx === -1) return;
        const request = db.friendRequests[reqIdx];
        if (action === 'accept') { const userA = db.users.find(u => u.id === request.from); const userB = db.users.find(u => u.id === request.to); if (userA && userB) { if (!userA.friends.includes(userB.id)) userA.friends.push(userB.id); if (!userB.friends.includes(userA.id)) userB.friends.push(userA.id); } }
        db.friendRequests.splice(reqIdx, 1); writeDB(db);
        if (onlineUsers[request.from]) sendUserDataUpdate(request.from, io.to(onlineUsers[request.from])); if (onlineUsers[request.to]) sendUserDataUpdate(request.to, io.to(onlineUsers[request.to]));
    });
    socket.on('toggleBlock', (targetId) => {
        const db = readDB(); const user = db.users.find(u => u.id === currentUserId); if (!user) return;
        const idx = user.blocks.indexOf(targetId); if (idx > -1) user.blocks.splice(idx, 1); else user.blocks.push(targetId); writeDB(db); sendUserDataUpdate(currentUserId, socket);
        // Update both immediately to reflect Blocked UI
        if(onlineUsers[targetId]) sendUserDataUpdate(targetId, io.to(onlineUsers[targetId]));
    });
    socket.on('toggleArchive', (targetId) => {
        const db = readDB(); const user = db.users.find(u => u.id === currentUserId); if (!user) return;
        const idx = user.archives.indexOf(targetId); if (idx > -1) user.archives.splice(idx, 1); else user.archives.push(targetId); writeDB(db); sendUserDataUpdate(currentUserId, socket);
    });

    // --- 5. CỔNG QUẢN TRỊ ADMIN ---
    socket.on('verifyAdminAuth', (pass, callback) => {
        const db = readDB(); const admin = db.users.find(u => u.id === currentUserId && u.role === 'admin');
        if (admin && bcrypt.compareSync(pass, admin.password)) callback({ success: true }); else callback({ success: false, msg: "Mật khẩu quản trị sai!" });
    });

    socket.on('adminGetUsers', () => {
        const db = readDB();
        if (db.users.find(u => u.id === currentUserId && u.role === 'admin')) {
            const syncAdminListData = db.users.map(u => ({
                id: u.id, username: u.username, phone: u.phone, email: u.email, displayName: u.displayName, role: u.role, 
                isBanned: u.isBanned, banUntil: u.banUntil, isMuted: u.isMuted, muteUntil: u.muteUntil, isOnline: !!onlineUsers[u.id]
            }));
            socket.emit('adminUsersList', syncAdminListData);
        }
    });

    // FIX LỖI ADMIN: THÔNG BÁO KHÔNG BỊ SPAM TOÀN BỘ SERVER MÀ CHỈ BÁO RIÊNG CHO NGƯỜI BỊ KHÓA
    socket.on('adminPunishUser', ({ targetId, action, durationMinutes }, callback) => {
        const db = readDB(); 
        if (db.users.find(u => u.id === currentUserId && u.role === 'admin')) {
            const target = db.users.find(u => u.id === targetId && u.role !== 'admin');
            if(target) {
                let expireTime = null;
                if (durationMinutes !== 'infinite') {
                    expireTime = new Date(Date.now() + parseInt(durationMinutes) * 60000).toISOString();
                }

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
                
                // Trả về hàm callback để chỉ Admin thấy popup thành công
                if(callback) callback(); 

                // Chỉ gửi sự kiện cảnh báo RIÊNG tới máy của người dùng bị phạt
                if(onlineUsers[targetId]) {
                    if(action === 'ban') io.to(onlineUsers[targetId]).emit('forceLogout', "Tài khoản của bạn đã bị Admin khóa.");
                    else if (action === 'mute') io.to(onlineUsers[targetId]).emit('actionError', "Tài khoản của bạn vừa bị Admin cấm nhắn tin.");
                    else if (action === 'unpunish') io.to(onlineUsers[targetId]).emit('actionSuccess', "Tài khoản của bạn đã được xóa bỏ hình phạt.");
                }
            }
        }
    });

    socket.on('adminGetChat', (targetId) => {
        const db = readDB(); const admin = db.users.find(u => u.id === currentUserId); if (!admin || admin.role !== 'admin') return;
        const chatHistory = db.messages.filter(m => (m.from === currentUserId && m.to === targetId) || (m.from === targetId && m.to === currentUserId));
        socket.emit('adminChatData', chatHistory);
    });
    
    socket.on('adminDeleteUser', (targetId) => {
        const db = readDB(); if (db.users.find(u => u.id === currentUserId && u.role === 'admin')) {
            db.users = db.users.filter(u => u.id !== targetId || u.role === 'admin'); writeDB(db);
            if(onlineUsers[targetId]) io.to(onlineUsers[targetId]).emit('forceLogout', "Tài khoản này đã bị xóa bỏ.");
        }
    });

    socket.on('disconnect', () => { delete onlineUsers[currentUserId]; io.emit('userStatusChange', { userId: currentUserId, status: 'offline' }); });
});

// Hàm gộp dữ liệu Client (TRUYỀN TRẠNG THÁI BỊ CHẶN LÊN UI)
function sendUserDataUpdate(userId, socketTarget) {
    const db = readDB(); const user = db.users.find(u => u.id === userId); if (!user) return;
    
    const adminUser = db.users.find(u => u.role === 'admin');
    let friendsList = db.users.filter(u => user.friends.includes(u.id) || u.role === 'admin');
    
    if(user.role === 'admin') {
        const messagedAdminIds = [...new Set(db.messages.filter(m => m.to === userId).map(m => m.from))];
        friendsList = db.users.filter(u => u.role !== 'admin' && (user.friends.includes(u.id) || messagedAdminIds.includes(u.id)));
    }

    const syncedFriendsList = friendsList.map(u => ({
        id: u.id, username: u.username, displayName: u.displayName || u.username, role: u.role, bio: u.bio || '', gender: u.gender || '', dob: u.dob || '',
        isOnline: !!onlineUsers[u.id], 
        isBlocked: user.blocks ? user.blocks.includes(u.id) : false, // Mình chặn họ
        isBlockedBy: u.blocks ? u.blocks.includes(user.id) : false, // BỊ HỌ CHẶN
        isArchived: user.archives ? user.archives.includes(u.id) : false
    }));
    
    socketTarget.emit('userDataPackage', {
        friends: syncedFriendsList,
        messages: db.messages.filter(m => m.from === userId || m.to === userId),
        requests: db.friendRequests.filter(r => r.to === userId),
        blocks: user.blocks || [], archives: user.archives || [], isMuted: user.isMuted
    });
}

server.listen(PORT, () => console.log(`Cherry Server V5 - Pro Edition running on port ${PORT}`));