const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const USERS_FILE = path.join(__dirname, "users.json");

function loadUsers() {
  if (!fs.existsSync(USERS_FILE)) return {};
  return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}
const { Server } = require("socket.io");

const app = express();
app.use(express.json());

// Serve your index.html, styles.css, and app.js directly from this folder
app.use(express.static(__dirname));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const QR_GRACE_MS = 5 * 60 * 1000;  // 5 minutes
const BREAK_MS = 20 * 60 * 1000;    // 20 minutes

// In-memory seat store (3 floors x 12 seats = 36 seats)
const seats = new Map();
const seatLocks = new Set();
const auditLogs = [];

function initSeats() {
  const zones = {
    1: ["Window", "Silent Desk", "Power Outlet"],
    2: ["Group Pod", "Whiteboard", "Window"],
    3: ["Exam Desk", "Power Outlet", "Corner"],
  };

  for (let floor = 1; floor <= 3; floor++) {
    for (let i = 1; i <= 12; i++) {
      const id = `F${floor}-S${i}`;
      seats.set(id, {
        id,
        floor,
        zone: zones[floor][(i - 1) % 3],
        qrSecret: `QR-${id}-SECRET`,
        status: "available", // available | reserved | occupied | break
        occupant: null,
        expiresAt: null,
        hogCount: 0,
      });
    }
  }
}

initSeats();

function logEvent(seatId, studentId, eventType) {
  auditLogs.unshift({
    time: new Date().toISOString(),
    seatId,
    studentId,
    eventType,
  });
  if (auditLogs.length > 100) auditLogs.pop();
}

function broadcast(seat) {
  io.emit("seat:updated", seat);
}

// 1. Live Floor Map API
app.get("/api/seats", (req, res) => {
  res.json(Array.from(seats.values()));
});

// 2. Atomic Reservation (Zero Double-Bookings)
app.post("/api/seats/:id/reserve", (req, res) => {
  const { id } = req.params;
  const studentId = req.body.studentId || "Demo-Student";
  const seat = seats.get(id);

  if (!seat) return res.status(404).json({ error: "Seat not found" });
  if (seatLocks.has(id) || seat.status !== "available") {
    logEvent(id, studentId, "CONFLICT_409");
    return res.status(409).json({ error: "Seat already taken" });
  }

  seatLocks.add(id);
  try {
    seat.status = "reserved";
    seat.occupant = studentId;
    seat.expiresAt = Date.now() + QR_GRACE_MS;
    logEvent(id, studentId, "RESERVED");
    broadcast(seat);
    res.status(200).json(seat);
  } finally {
    seatLocks.delete(id);
  }
});

// 3. QR Check-In API
app.post("/api/seats/:id/checkin", (req, res) => {
  const { id } = req.params;
  const seat = seats.get(id);

  if (!seat || !["reserved", "break"].includes(seat.status)) {
    return res.status(400).json({ error: "Seat not ready for QR check-in" });
  }

  seat.status = "occupied";
  seat.expiresAt = null;
  logEvent(id, seat.occupant, "CHECKED_IN");
  broadcast(seat);
  res.json(seat);
});

// 4. Start 20-Minute Break Timer API
app.post("/api/seats/:id/break", (req, res) => {
  const { id } = req.params;
  const seat = seats.get(id);

  if (!seat || seat.status !== "occupied") {
    return res.status(400).json({ error: "Seat must be occupied to start a break" });
  }

  seat.status = "break";
  seat.expiresAt = Date.now() + BREAK_MS;
  logEvent(id, seat.occupant, "BREAK_START");
  broadcast(seat);
  res.json(seat);
});

// 5. Admin Analytics API
app.get("/api/admin/analytics", (req, res) => {
  const hoggedSeats = Array.from(seats.values())
    .sort((a, b) => b.hogCount - a.hogCount)
    .slice(0, 10);
  res.json({ hoggedSeats, recentLogs: auditLogs.slice(0, 20) });
});

// 6. Background Worker: Auto-Release Expired Seats Every 5 Seconds
setInterval(() => {
  const now = Date.now();
  for (const seat of seats.values()) {
    if (
      ["reserved", "break"].includes(seat.status) &&
      seat.expiresAt &&
      seat.expiresAt <= now
    ) {
      seat.status = "available";
      seat.occupant = null;
      seat.expiresAt = null;
      seat.hogCount += 1;
      logEvent(seat.id, "SYSTEM", "AUTO_RELEASE");
      broadcast(seat);
    }
  }
}, 5000);

// 7. Student Register API (Saves to users.json)
app.post("/api/auth/register", (req, res) => {
  const { name, id, pass } = req.body;
  if (!name || !id || !pass) {
    return res.status(400).json({ error: "All fields are required" });
  }

  const users = loadUsers();
  const cleanId = id.trim().toUpperCase();

  if (users[cleanId]) {
    return res.status(409).json({ error: "Roll Number already registered. Please log in." });
  }

  users[cleanId] = { name: name.trim(), id: cleanId, pass };
  saveUsers(users);
  res.status(201).json({ user: { role: "student", name: `${name.trim()} (${cleanId})` } });
});

// 8. Student Login API (Verifies from users.json)
app.post("/api/auth/login", (req, res) => {
  const { id, pass } = req.body;
  const users = loadUsers();
  const cleanId = (id || "").trim().toUpperCase();
  const user = users[cleanId];

  if (!user || user.pass !== pass) {
    return res.status(401).json({ error: "Invalid Roll Number or Password" });
  }

  res.json({ user: { role: "student", name: `${user.name} (${user.id})` } });
});
// 9. Live Multi-Device Seat Sync
let sharedState = null;

app.get("/api/sync", (req, res) => {
  res.json(sharedState || {});
});

app.post("/api/sync", (req, res) => {
  sharedState = req.body;
  res.json({ ok: true });
});
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`SeatPulse running at http://localhost:${PORT}`);
});
