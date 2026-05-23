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
const io = new Server(server);
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'database.json');

// --- HÀM KHỞI TẠO DỮ LIỆU ---
function initDatabase() {
    if (!fs.existsSync(DB_FILE)) {
        const adminPasswordHash = bcrypt.hashSync('admin123@', 10);
        const initialData = {
            users: [{
                id: "admin-id",
                username: "admin",
                phone: "0123456789",
                email: "admin@gmail.com",
                password: adminPasswordHash,
                displayName: "Hệ Thống Admin",
                role: "admin",
                isBanned: false,
                banUntil: null,
                friends: [],
                blocks: [],
                archives: []
            }],
            messages: [],
            friendRequests: []
        };
        fs.writeFileSync(DB_FILE, JSON.stringify(initialData, null, 2));
    }
}
initDatabase();

function readDB() { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
function writeDB(data) { fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2)); }

// --- CẤU HÌNH MIDDLEWARE ---
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const sessionMiddleware = session({
    secret: 'cherry-blossom-secret-key-pro',
    resave: false,
    saveUninitialized: true,
    store: new MemoryStore({ checkPeriod: 86400000 }), // Ghi nhớ phiên và chống tràn RAM
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
});
app.use(sessionMiddleware);
app.use(express.static(path.join(__dirname, 'public')));

io.use((socket, next) => {
    sessionMiddleware(socket.request, socket.request.res || {}, next);
});

let onlineUsers = {}; // Bản đồ lưu trữ danh sách đang Online realtime

// --- CÁC ROUTE API AUTHENTICATION ---
app.post('/api/register', (req, res) => {
    const { username, phone, email, password, confirmPassword } = req.body;
    
    if (username.length < 4) return res.status(400).json({ msg: "Tên đăng nhập phải >= 4 ký tự!" });
    if (!/^(0|\+84)[0-9]{8,9}$/.test(phone)) return res.status(400).json({ msg: "Số điện thoại không hợp lệ!" });
    if (!/[!@#$%^&*(),.?":{}|<>]/.test(password)) return res.status(400).json({ msg: "Mật khẩu cần ít nhất 1 ký tự đặc biệt!" });
    if (password !== confirmPassword) return res.status(400).json({ msg: "Mật khẩu xác nhận không khớp!" });

    const db = readDB();
    if (db.users.find(u => u.username === username)) return res.status(400).json({ msg: "Tên đăng nhập đã tồn tại!" });
    if (db.users.find(u => u.phone === phone)) return res.status(400).json({ msg: "Số điện thoại đã được đăng ký!" });

    const newUser = {
        id: 'user_' + Date.now(),
        username, phone, email: email || "",
        password: bcrypt.hashSync(password, 10),
        displayName: "",
        role: "user",
        isBanned: false, banUntil: null,
        friends: [], blocks: [], archives: []
    };
    db.users.push(newUser);
    writeDB(db);
    req.session.userId = newUser.id;
    res.json({ msg: "Đăng ký thành công!", step: "setup-profile" });
});

app.post('/api/setup-profile', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ msg: "Chưa đăng nhập!" });
    const { displayName } = req.body;
    const db = readDB(); 
    const user = db.users.find(u => u.id === req.session.userId);
    if (!user || user.username === displayName) return res.status(400).json({ msg: "Lỗi thiết lập tên hiển thị!" });
    user.displayName = displayName; 
    writeDB(db);
    res.json({ msg: "Cập nhật thành công!", role: user.role });
});

app.post('/api/login', (req, res) => {
    const { loginKey, password } = req.body;
    const db = readDB();
    const user = db.users.find(u => u.username === loginKey || u.phone === loginKey);
    
    if (!user || !bcrypt.compareSync(password, user.password)) 
        return res.status(400).json({ msg: "Tài khoản hoặc mật khẩu không đúng!" });
    
    if (user.isBanned) return res.status(403).json({ msg: "Tài khoản của bạn hiện đang bị khóa!" });
    
    req.session.userId = user.id;
    res.json({ msg: "Đăng nhập thành công!", role: user.role, needProfile: !user.displayName });
});

app.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ msg: "Đã đăng xuất!" });
});

app.get('/api/me', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ msg: "Chưa đăng nhập" });
    const db = readDB();
    const user = db.users.find(u => u.id === req.session.userId);
    if(!user) return res.status(404).json({ msg: "Lỗi" });
    res.json({ id: user.id, username: user.username, displayName: user.displayName, phone: user.phone, email: user.email, role: user.role });
});

// --- LOGIC REALTIME SOCKET.IO ---
io.on('connection', (socket) => {
    const session = socket.request.session;
    if (!session || !session.userId) return;
    
    const currentUserId = session.userId;
    onlineUsers[currentUserId] = socket.id; // Đăng ký socket ID khi online

    // Phát tín hiệu Online ngay lập tức cho toàn hệ thống biết
    io.emit('userStatusChange', { userId: currentUserId, status: 'online' });

    socket.on('initData', () => sendUserDataUpdate(currentUserId, socket));

    // Trạng thái đang gõ phím
    socket.on('typing', (toUserId) => { if (onlineUsers[toUserId]) io.to(onlineUsers[toUserId]).emit('userTyping', currentUserId); });
    socket.on('stopTyping', (toUserId) => { if (onlineUsers[toUserId]) io.to(onlineUsers[toUserId]).emit('userStoppedTyping', currentUserId); });

    // Gửi tin nhắn đồng bộ tức thì
    socket.on('sendMessage', ({ toUserId, text }) => {
        const db = readDB();
        const sender = db.users.find(u => u.id === currentUserId);
        const receiver = db.users.find(u => u.id === toUserId);
        if (!sender || !receiver) return;
        if (!sender.friends.includes(toUserId) && sender.role !== 'admin') return;

        const msgObj = { 
            id: 'msg_' + Date.now(), 
            from: currentUserId, 
            to: toUserId, 
            text, 
            timestamp: new Date().toISOString(),
            isEdited: false,
            isRecalled: false
        };
        db.messages.push(msgObj);
        writeDB(db);
        
        socket.emit('receiveMessage', msgObj); // Phản hồi ngay lập tức cho người gửi
        if (onlineUsers[toUserId]) {
            io.to(onlineUsers[toUserId]).emit('receiveMessage', msgObj);
            io.to(onlineUsers[toUserId]).emit('msgPopupNotification', { fromName: sender.displayName, text });
        }
    });

    // Chỉnh sửa tin nhắn
    socket.on('editMessage', ({ msgId, newText }) => {
        const db = readDB();
        const msg = db.messages.find(m => m.id === msgId && m.from === currentUserId);
        if(msg && !msg.isRecalled) { 
            msg.text = newText; msg.isEdited = true; writeDB(db); 
            io.to(onlineUsers[currentUserId]).emit('messageUpdated', msg);
            if(onlineUsers[msg.to]) io.to(onlineUsers[msg.to]).emit('messageUpdated', msg);
        }
    });

    // Thu hồi tin nhắn
    socket.on('recallMessage', (msgId) => {
        const db = readDB();
        const msg = db.messages.find(m => m.id === msgId && m.from === currentUserId);
        if(msg && !msg.isRecalled) { 
            msg.isRecalled = true; msg.text = "Tin nhắn đã được thu hồi"; writeDB(db); 
            io.to(onlineUsers[currentUserId]).emit('messageUpdated', msg);
            if(onlineUsers[msg.to]) io.to(onlineUsers[msg.to]).emit('messageUpdated', msg);
        }
    });

    // Cập nhật Profile cá nhân công khai
    socket.on('updateMyProfile', (data, callback) => {
        const db = readDB(); const user = db.users.find(u => u.id === currentUserId);
        if (!user) return;
        if (!/^(0|\+84)[0-9]{8,9}$/.test(data.phone)) return callback({ success: false, msg: "Số điện thoại sai!" });
        user.displayName = data.displayName; user.phone = data.phone; user.email = data.email;
        writeDB(db); callback({ success: true, msg: "Cập nhật hồ sơ thành công!" });
        sendUserDataUpdate(currentUserId, socket);
    });

    // Đổi mật khẩu nội bộ
    socket.on('changePasswordInternal', ({ oldPass, newPass }, callback) => {
        if (!/[!@#$%^&*(),.?":{}|<>]/.test(newPass)) return callback({ success: false, msg: "Mật khẩu mới phải mạnh hơn mật khẩu cũ!" });
        const db = readDB(); const user = db.users.find(u => u.id === currentUserId);
        if (user && bcrypt.compareSync(oldPass, user.password)) {
            user.password = bcrypt.hashSync(newPass, 10); writeDB(db); callback({ success: true, msg: "Thay đổi mật khẩu thành công!" });
        } else callback({ success: false, msg: "Mật khẩu cũ không chính xác!" });
    });

    // Tìm kiếm kết bạn
    socket.on('searchUser', (query) => {
        const db = readDB();
        const results = db.users.filter(u => u.id !== currentUserId && u.role !== 'admin' && (u.username.includes(query) || u.phone.includes(query))).map(u => ({ id: u.id, displayName: u.displayName || u.username, username: u.username }));
        socket.emit('searchResults', results);
    });

    socket.on('sendFriendRequest', (targetId) => {
        const db = readDB();
        if (db.friendRequests.find(r => (r.from === currentUserId && r.to === targetId) || (r.from === targetId && r.to === currentUserId))) return;
        const sender = db.users.find(u => u.id === currentUserId);
        const request = { id: 'req_' + Date.now(), from: currentUserId, to: targetId, fromName: sender.displayName || sender.username };
        db.friendRequests.push(request); writeDB(db);
        if (onlineUsers[targetId]) {
            io.to(onlineUsers[targetId]).emit('newFriendRequest', request);
            sendUserDataUpdate(targetId, io.to(onlineUsers[targetId]));
        }
        sendUserDataUpdate(currentUserId, socket);
    });

    socket.on('respondFriendRequest', ({ requestId, action }) => {
        let db = readDB(); const reqIdx = db.friendRequests.findIndex(r => r.id === requestId);
        if (reqIdx === -1) return;
        const request = db.friendRequests[reqIdx];
        if (action === 'accept') {
            const userA = db.users.find(u => u.id === request.from); const userB = db.users.find(u => u.id === request.to);
            if (userA && userB) {
                if (!userA.friends.includes(userB.id)) userA.friends.push(userB.id);
                if (!userB.friends.includes(userA.id)) userB.friends.push(userA.id);
            }
        }
        db.friendRequests.splice(reqIdx, 1); writeDB(db);
        if (onlineUsers[request.from]) sendUserDataUpdate(request.from, io.to(onlineUsers[request.from]));
        if (onlineUsers[request.to]) sendUserDataUpdate(request.to, io.to(onlineUsers[request.to]));
    });

    socket.on('toggleBlock', (targetId) => {
        const db = readDB(); const user = db.users.find(u => u.id === currentUserId);
        if (!user) return; const idx = user.blocks.indexOf(targetId);
        if (idx > -1) user.blocks.splice(idx, 1); else user.blocks.push(targetId); writeDB(db); sendUserDataUpdate(currentUserId, socket);
    });

    socket.on('toggleArchive', (targetId) => {
        const db = readDB(); const user = db.users.find(u => u.id === currentUserId);
        if (!user) return; const idx = user.archives.indexOf(targetId);
        if (idx > -1) user.archives.splice(idx, 1); else user.archives.push(targetId); writeDB(db); sendUserDataUpdate(currentUserId, socket);
    });

    // --- CỔNG QUẢN TRỊ ADMIN (ĐÃ ĐỒNG BỘ 100%) ---
    socket.on('verifyAdminAuth', (pass, callback) => {
        const db = readDB();
        const admin = db.users.find(u => u.id === currentUserId && u.role === 'admin');
        if (admin && bcrypt.compareSync(pass, admin.password)) callback({ success: true });
        else callback({ success: false, msg: "Mật khẩu quản trị cấp 2 sai!" });
    });

    // VÁ LỖI CHÍNH: Đồng bộ cột ON/OFF trên giao diện Dashboard Admin
    socket.on('adminGetUsers', () => {
        const db = readDB();
        if (db.users.find(u => u.id === currentUserId && u.role === 'admin')) {
            const syncAdminListData = db.users.map(u => ({
                id: u.id,
                username: u.username,
                phone: u.phone,
                email: u.email,
                displayName: u.displayName,
                role: u.role,
                isBanned: u.isBanned,
                banUntil: u.banUntil,
                isOnline: !!onlineUsers[u.id] // <--- ĐỒNG BỘ TRẠNG THÁI CHO KHUNG ADMIN
            }));
            socket.emit('adminUsersList', syncAdminListData);
        }
    });

    socket.on('adminGetChat', (targetId) => {
        const db = readDB(); const admin = db.users.find(u => u.id === currentUserId);
        if (!admin || admin.role !== 'admin') return;
        const chatHistory = db.messages.filter(m => (m.from === currentUserId && m.to === targetId) || (m.from === targetId && m.to === currentUserId));
        socket.emit('adminChatData', chatHistory);
    });

    socket.on('adminUpdateUser', (updatedInfo) => {
        const db = readDB(); const admin = db.users.find(u => u.id === currentUserId);
        if (!admin || admin.role !== 'admin') return;
        const target = db.users.find(u => u.id === updatedInfo.id);
        if (target) { target.displayName = updatedInfo.displayName || target.displayName; target.phone = updatedInfo.phone || target.phone; target.email = updatedInfo.email || target.email; writeDB(db); io.emit('adminActionDone'); }
    });

    socket.on('adminResetUserPassword', ({ targetId, newPassword }) => {
        const db = readDB(); if (db.users.find(u => u.id === currentUserId && u.role === 'admin')) {
            const target = db.users.find(u => u.id === targetId);
            if(target) { target.password = bcrypt.hashSync(newPassword, 10); writeDB(db); io.emit('adminActionDone'); }
        }
    });

    socket.on('adminBanUser', ({ targetId, durationMinutes }) => {
        const db = readDB(); if (db.users.find(u => u.id === currentUserId && u.role === 'admin')) {
            const target = db.users.find(u => u.id === targetId && u.role !== 'admin');
            if(target) { 
                target.isBanned = true; 
                target.banUntil = durationMinutes === 'infinite' ? null : new Date(Date.now() + parseInt(durationMinutes) * 60 * 1000).toISOString();
                writeDB(db); io.emit('adminActionDone'); 
                if(onlineUsers[targetId]) io.to(onlineUsers[targetId]).emit('forceLogout', "Tài khoản của bạn đã bị Admin tạm khóa.");
            }
        }
    });

    socket.on('adminUnbanUser', (targetId) => {
        const db = readDB(); if (db.users.find(u => u.id === currentUserId && u.role === 'admin')) {
            const target = db.users.find(u => u.id === targetId);
            if(target) { target.isBanned = false; target.banUntil = null; writeDB(db); io.emit('adminActionDone'); }
        }
    });

    socket.on('adminDeleteUser', (targetId) => {
        const db = readDB(); if (db.users.find(u => u.id === currentUserId && u.role === 'admin')) {
            db.users = db.users.filter(u => u.id !== targetId || u.role === 'admin'); writeDB(db); io.emit('adminActionDone');
            if(onlineUsers[targetId]) io.to(onlineUsers[targetId]).emit('forceLogout', "Tài khoản này đã bị xóa bỏ hoàn toàn.");
        }
    });

    socket.on('disconnect', () => {
        // Gỡ bỏ ID khỏi bản đồ trực tuyến khi thoát mạng
        delete onlineUsers[currentUserId];
        io.emit('userStatusChange', { userId: currentUserId, status: 'offline' });
    });
});

// VÁ LỖI PHỤ: Đồng bộ dấu chấm Xanh hoạt động cho danh sách Bạn bè khi vừa tải trang
function sendUserDataUpdate(userId, socketTarget) {
    const db = readDB();
    const user = db.users.find(u => u.id === userId);
    if (!user) return;
    
    // Gắn thêm thuộc tính isOnline tức thời vào mảng bạn bè trước khi gửi cho Client
    const syncedFriendsList = db.users
        .filter(u => user.friends.includes(u.id) || u.role === 'admin')
        .map(u => ({
            id: u.id,
            username: u.username,
            displayName: u.displayName || u.username,
            phone: u.phone,
            email: u.email,
            role: u.role,
            isOnline: !!onlineUsers[u.id], // <--- KIỂM TRA ĐANG TRỰC TUYẾN
            isBlocked: user.blocks ? user.blocks.includes(u.id) : false,
            isArchived: user.archives ? user.archives.includes(u.id) : false
        }));
    
    socketTarget.emit('userDataPackage', {
        friends: syncedFriendsList, // Gửi mảng bạn bè đã được đồng bộ trạng thái mạng
        messages: db.messages.filter(m => m.from === userId || m.to === userId),
        requests: db.friendRequests.filter(r => r.to === userId),
        blocks: user.blocks || [],
        archives: user.archives || []
    });
}

server.listen(PORT, () => console.log(`Server Pro (Synced) running on port ${PORT}`));