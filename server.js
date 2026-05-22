const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'database.json');

// Khởi tạo database file nếu chưa có
if (!fs.existsSync(DB_FILE)) {
    const adminPasswordHash = bcrypt.hashSync('admin123', 10);
    const initialData = {
        users: [
            {
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
            }
        ],
        messages: [],
        friendRequests: []
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(initialData, null, 2));
}

// Đọc/Ghi Database helper
function readDB() { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
function writeDB(data) { fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2)); }

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
const sessionMiddleware = session({
    secret: 'cherry-blossom-secret-key',
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 24 * 60 * 60 * 1000 } // 1 ngày
});
app.use(sessionMiddleware);
app.use(express.static(path.join(__dirname, 'public')));

// Chia sẻ session với Socket.io
io.use((socket, next) => {
    sessionMiddleware(socket.request, socket.request.res || {}, next);
});

// Lưu trữ các socket id đang online
let onlineUsers = {}; // userId -> socketId

// --- API ROUTES ---

// Đăng ký
app.post('/api/register', (req, res) => {
    const { username, phone, email, password, confirmPassword } = req.body;
    if (!username || !phone || !password || !confirmPassword) return res.status(400).json({ msg: "Vui lòng điền đủ thông tin bắt buộc!" });
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
        isBanned: false,
        banUntil: null,
        friends: [], blocks: [], archives: []
    };
    db.users.push(newUser);
    writeDB(db);
    req.session.userId = newUser.id;
    res.json({ msg: "Đăng ký thành công!", step: "setup-profile" });
});

// Thiết lập Display Name
app.post('/api/setup-profile', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ msg: "Chưa đăng nhập!" });
    const { displayName } = req.body;
    const db = readDB();
    const user = db.users.find(u => u.id === req.session.userId);
    if (!user) return res.status(404).json({ msg: "Không tìm thấy user!" });
    if (user.username === displayName) return res.status(400).json({ msg: "Tên hiển thị không được trùng với tên đăng nhập!" });

    user.displayName = displayName;
    writeDB(db);
    res.json({ msg: "Cập nhật tên hiển thị thành công!", role: user.role });
});

// Đăng nhập
app.post('/api/login', (req, res) => {
    const { loginKey, password } = req.body; 
    const db = readDB();
    const user = db.users.find(u => u.username === loginKey || u.phone === loginKey);
    if (!user) return res.status(400).json({ msg: "Tài khoản hoặc mật khẩu không chính xác!" });

    if (user.isBanned) {
        if (user.banUntil && new Date(user.banUntil) < new Date()) {
            user.isBanned = false;
            user.banUntil = null;
            writeDB(db);
        } else {
            const reason = user.banUntil ? `tới khi ${new Date(user.banUntil).toLocaleString()}` : "vĩnh viễn";
            return res.status(403).json({ msg: `Tài khoản của bạn đã bị khóa ${reason}!` });
        }
    }

    if (!bcrypt.compareSync(password, user.password)) return res.status(400).json({ msg: "Tài khoản hoặc mật khẩu không chính xác!" });

    req.session.userId = user.id;
    res.json({ msg: "Đăng nhập thành công!", role: user.role, needProfile: !user.displayName });
});

// Quên mật khẩu
app.post('/api/forgot-password', (req, res) => {
    const { username, phone, newPassword } = req.body;
    const db = readDB();
    const user = db.users.find(u => u.username === username && u.phone === phone);
    if (!user) return res.status(400).json({ msg: "Thông tin tài khoản hoặc số điện thoại không khớp!" });

    user.password = bcrypt.hashSync(newPassword, 10);
    writeDB(db);
    res.json({ msg: "Đặt lại mật khẩu thành công!" });
});

// Đăng xuất
app.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ msg: "Đã đăng xuất!" });
});

app.get('/api/me', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ msg: "Chưa đăng nhập" });
    const db = readDB();
    const user = db.users.find(u => u.id === req.session.userId);
    if (!user) return res.status(404).json({ msg: "User không tồn tại" });
    res.json({ id: user.id, username: user.username, displayName: user.displayName, role: user.role });
});

// --- SOCKET.IO REALTIME LOGIC ---
io.on('connection', (socket) => {
    const session = socket.request.session;
    if (!session || !session.userId) return;

    const currentUserId = session.userId;
    onlineUsers[currentUserId] = socket.id;

    io.emit('userStatusChange', { userId: currentUserId, status: 'online' });

    socket.on('initData', () => {
        sendUserDataUpdate(currentUserId, socket);
    });

    socket.on('searchUser', (query) => {
        const db = readDB();
        const results = db.users
            .filter(u => u.id !== currentUserId && u.role !== 'admin' && (u.username.includes(query) || u.phone.includes(query)))
            .map(u => ({ id: u.id, displayName: u.displayName || u.username, username: u.username }));
        socket.emit('searchResults', results);
    });

    socket.on('sendFriendRequest', (targetId) => {
        const db = readDB();
        if (db.friendRequests.find(r => (r.from === currentUserId && r.to === targetId) || (r.from === targetId && r.to === currentUserId))) return;
        
        const sender = db.users.find(u => u.id === currentUserId);
        const request = { id: 'req_' + Date.now(), from: currentUserId, to: targetId, fromName: sender.displayName || sender.username };
        db.friendRequests.push(request);
        writeDB(db);

        if (onlineUsers[targetId]) {
            io.to(onlineUsers[targetId]).emit('newFriendRequest', request);
            sendUserDataUpdate(targetId, io.to(onlineUsers[targetId]));
        }
        sendUserDataUpdate(currentUserId, socket);
    });

    socket.on('respondFriendRequest', ({ requestId, action }) => {
        let db = readDB();
        const reqIdx = db.friendRequests.findIndex(r => r.id === requestId);
        if (reqIdx === -1) return;

        const request = db.friendRequests[reqIdx];
        if (action === 'accept') {
            const userA = db.users.find(u => u.id === request.from);
            const userB = db.users.find(u => u.id === request.to);
            if (userA && userB) {
                if (!userA.friends.includes(userB.id)) userA.friends.push(userB.id);
                if (!userB.friends.includes(userA.id)) userB.friends.push(userA.id);
            }
        }
        db.friendRequests.splice(reqIdx, 1);
        writeDB(db);

        if (onlineUsers[request.from]) sendUserDataUpdate(request.from, io.to(onlineUsers[request.from]));
        if (onlineUsers[request.to]) sendUserDataUpdate(request.to, io.to(onlineUsers[request.to]));
    });

    socket.on('sendMessage', ({ toUserId, text }) => {
        const db = readDB();
        const sender = db.users.find(u => u.id === currentUserId);
        const receiver = db.users.find(u => u.id === toUserId);

        if (!sender || !receiver) return;
        
        // Admin được bypass quyền block và kết bạn
        if (!sender.friends.includes(toUserId) && sender.role !== 'admin') return;
        if (receiver.blocks.includes(currentUserId) && sender.role !== 'admin') return;

        const msgObj = {
            id: 'msg_' + Date.now(),
            from: currentUserId,
            to: toUserId,
            text,
            timestamp: new Date().toISOString()
        };
        db.messages.push(msgObj);
        writeDB(db);

        socket.emit('receiveMessage', msgObj);
        if (onlineUsers[toUserId]) {
            io.to(onlineUsers[toUserId]).emit('receiveMessage', msgObj);
            io.to(onlineUsers[toUserId]).emit('msgPopupNotification', { fromName: sender.displayName, text });
        }
    });

    socket.on('toggleBlock', (targetId) => {
        const db = readDB();
        const user = db.users.find(u => u.id === currentUserId);
        if (!user) return;
        const idx = user.blocks.indexOf(targetId);
        if (idx > -1) user.blocks.splice(idx, 1);
        else user.blocks.push(targetId);
        writeDB(db);
        sendUserDataUpdate(currentUserId, socket);
    });

    socket.on('toggleArchive', (targetId) => {
        const db = readDB();
        const user = db.users.find(u => u.id === currentUserId);
        if (!user) return;
        const idx = user.archives.indexOf(targetId);
        if (idx > -1) user.archives.splice(idx, 1);
        else user.archives.push(targetId);
        writeDB(db);
        sendUserDataUpdate(currentUserId, socket);
    });

    socket.on('changePasswordInternal', ({ oldPass, newPass }, callback) => {
        const db = readDB();
        const user = db.users.find(u => u.id === currentUserId);
        if (user && bcrypt.compareSync(oldPass, user.password)) {
            user.password = bcrypt.hashSync(newPass, 10);
            writeDB(db);
            callback({ success: true, msg: "Đổi mật khẩu thành công!" });
        } else {
            callback({ success: false, msg: "Mật khẩu cũ không chính xác!" });
        }
    });

    // --- LOGIC CHO ADMIN ---
    socket.on('adminGetUsers', () => {
        const db = readDB();
        const user = db.users.find(u => u.id === currentUserId);
        if (!user || user.role !== 'admin') return;

        const manageData = db.users.map(u => ({
            id: u.id,
            username: u.username,
            phone: u.phone,
            email: u.email,
            displayName: u.displayName,
            role: u.role,
            isBanned: u.isBanned,
            banUntil: u.banUntil,
            isOnline: !!onlineUsers[u.id]
        }));
        socket.emit('adminUsersList', manageData);
    });

    socket.on('adminGetChat', (targetId) => {
        const db = readDB();
        const admin = db.users.find(u => u.id === currentUserId);
        if (!admin || admin.role !== 'admin') return;

        const chatHistory = db.messages.filter(m => 
            (m.from === currentUserId && m.to === targetId) || 
            (m.from === targetId && m.to === currentUserId)
        );
        socket.emit('adminChatData', chatHistory);
    });

    socket.on('adminUpdateUser', (updatedInfo) => {
        const db = readDB();
        const admin = db.users.find(u => u.id === currentUserId);
        if (!admin || admin.role !== 'admin') return;

        const target = db.users.find(u => u.id === updatedInfo.id);
        if (target) {
            target.displayName = updatedInfo.displayName || target.displayName;
            target.phone = updatedInfo.phone || target.phone;
            target.email = updatedInfo.email || target.email;
            writeDB(db);
            io.emit('adminActionDone');
        }
    });

    socket.on('adminBanUser', ({ targetId, durationMinutes }) => {
        const db = readDB();
        const admin = db.users.find(u => u.id === currentUserId);
        if (!admin || admin.role !== 'admin' || targetId === currentUserId) return;

        const target = db.users.find(u => u.id === targetId);
        if (target && target.role !== 'admin') {
            target.isBanned = true;
            if (durationMinutes === 'infinite') {
                target.banUntil = null;
            } else {
                target.banUntil = new Date(Date.now() + parseInt(durationMinutes) * 60 * 1000).toISOString();
            }
            writeDB(db);

            if (onlineUsers[targetId]) {
                io.to(onlineUsers[targetId]).emit('forceLogout', `Tài khoản của bạn đã bị Admin khóa.`);
            }
            io.emit('adminActionDone');
        }
    });

    socket.on('adminUnbanUser', (targetId) => {
        const db = readDB();
        const admin = db.users.find(u => u.id === currentUserId);
        if (!admin || admin.role !== 'admin') return;

        const target = db.users.find(u => u.id === targetId);
        if (target) {
            target.isBanned = false;
            target.banUntil = null;
            writeDB(db);
            io.emit('adminActionDone');
        }
    });

    socket.on('adminDeleteUser', (targetId) => {
        const db = readDB();
        const admin = db.users.find(u => u.id === currentUserId);
        if (!admin || admin.role !== 'admin' || targetId === currentUserId) return;

        const targetUser = db.users.find(u => u.id === targetId);
        if (!targetUser || targetUser.role === 'admin') return;

        db.users = db.users.filter(u => u.id !== targetId);
        db.friendRequests = db.friendRequests.filter(r => r.from !== targetId && r.to !== targetId);
        writeDB(db);

        if (onlineUsers[targetId]) {
            io.to(onlineUsers[targetId]).emit('forceLogout', `Tài khoản của bạn đã bị xóa khỏi hệ thống.`);
        }
        io.emit('adminActionDone');
    });

    socket.on('disconnect', () => {
        delete onlineUsers[currentUserId];
        io.emit('userStatusChange', { userId: currentUserId, status: 'offline' });
    });
});

function sendUserDataUpdate(userId, socketTarget) {
    const db = readDB();
    const user = db.users.find(u => u.id === userId);
    if (!user) return;

    // Admin luôn xuất hiện trong list bạn bè của mọi người
    const friendsList = db.users
        .filter(u => user.friends.includes(u.id) || u.role === 'admin')
        .map(u => ({
            id: u.id,
            displayName: u.displayName || u.username,
            isOnline: !!onlineUsers[u.id],
            isBlocked: user.blocks.includes(u.id),
            isArchived: user.archives.includes(u.id)
        }));

    const chatHistory = db.messages.filter(m => m.from === userId || m.to === userId);
    const incomingRequests = db.friendRequests.filter(r => r.to === userId);

    socketTarget.emit('userDataPackage', {
        friends: friendsList,
        messages: chatHistory,
        requests: incomingRequests,
        blocks: user.blocks,
        archives: user.archives
    });
}

server.listen(PORT, () => {
    console.log(`Server running smoothly on port ${PORT}`);
});