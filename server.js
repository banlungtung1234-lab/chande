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
const io = new Server(server, { maxHttpBufferSize: 5e7 }); // 50MB cho Voice/Ảnh Meme
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'database.json');

// ==========================================
// 1. DATABASE & KHỞI TẠO
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

function readDB() { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
function writeDB(data) { fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2)); }

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
// 2. API XÁC THỰC (GIỮ NGUYÊN KHÔNG MẤT CHỨC NĂNG CŨ)
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
        if (!user.banUntil || new Date(user.banUntil) > new Date()) return res.status(403).json({ msg: "Tài khoản đang bị khóa!" });
        else { user.isBanned = false; writeDB(db); }
    }
    
    req.session.userId = user.id;
    if (!user.displayName) return res.json({ success: true, needProfile: true });
    res.json({ success: true, user: { id: user.id, username: user.username, displayName: user.displayName, role: user.role } });
});

app.post('/api/setup-profile', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ msg: "Chưa đăng nhập!" });
    const db = readDB(); const user = db.users.find(u => u.id === req.session.userId);
    if (!user) return res.status(404).json({ msg: "Không tìm thấy user!" });
    user.displayName = req.body.displayName; writeDB(db);
    res.json({ success: true });
});

app.get('/api/me', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ msg: "Unauthorized" });
    const db = readDB(); const user = db.users.find(u => u.id === req.session.userId);
    if (!user) return res.status(404).json({ msg: "User not found" });
    if (user.isBanned) return res.status(403).json({ isBanned: true, banUntil: user.banUntil });
    res.json({ id: user.id, username: user.username, displayName: user.displayName, role: user.role, avatar: user.avatar, playerClass: user.playerClass, elo: user.elo, rank: user.rank, level: user.level, customStatus: user.customStatus });
});

app.post('/api/logout', (req, res) => { req.session.destroy(); res.json({ success: true }); });
