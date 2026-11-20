// ==========================================
// 1. INITIAL STATE & DATA MODEL
// ==========================================
const BREAK_DURATION_SEC = 20 * 60; // 20 minutes = 1200 seconds
const QR_GRACE_SEC = 5 * 60;        // 5 minutes to scan QR after reserving

let currentFloor = 1;
let selectedSeatId = null;
let timeMultiplier = 1; // 1 = real time, 60 = demo speed (20 mins in 20 secs)
let syncCountdown = 5;

// Atomic lock table to prevent race conditions / double bookings
const seatLocks = new Set();

// Audit log for Admin view
const auditLogs = [];

// Exam-week historical peak hour data (%)
const peakHoursData = [
  { hour: "8AM", pct: 35 },
  { hour: "10AM", pct: 72 },
  { hour: "12PM", pct: 88 },
  { hour: "2PM", pct: 96 },
  { hour: "4PM", pct: 94 },
  { hour: "6PM", pct: 82 },
  { hour: "8PM", pct: 68 },
  { hour: "10PM", pct: 45 },
];

// Generate 36 seats across 3 floors (12 per floor)
let seats = [];

function initSeats() {
  seats = [];
  const zones = {
    1: ["Window", "Silent Desk", "Power Outlet"],
    2: ["Group Pod", "Whiteboard", "Window"],
    3: ["Exam Desk", "Power Outlet", "Corner"],
  };

  for (let floor = 1; floor <= 3; floor++) {
    for (let i = 1; i <= 12; i++) {
      const id = `F${floor}-S${i}`;
      seats.push({
        id,
        floor,
        zone: zones[floor][(i - 1) % 3],
        status: "available", // available | reserved | occupied | break
        occupant: null,
        timeLeftSec: 0,
        hogCount: Math.floor(Math.random() * 4), // Simulated past auto-releases
      });
    }
  }

  // Seed a few realistic initial states for the demo
  seats[1].status = "occupied";
  seats[1].occupant = "Aarav (CS-21)";
  seats[2].status = "break";
  seats[2].occupant = "Priya (EE-19)";
  seats[2].timeLeftSec = 180; // 3 mins left on break
  seats[2].hogCount = 7;

  seats[14].status = "occupied";
  seats[14].occupant = "Rohan (ME-22)";
  seats[26].status = "break";
  seats[26].occupant = "Meera (BT-20)";
  seats[26].timeLeftSec = 420;
  seats[26].hogCount = 9;

  selectedSeatId = "F1-S1";
  addLog("SYSTEM", "Initialized 3 floors (36 seats) with atomic locking enabled.", "log-ok");
}

// ==========================================
// 2. ATOMIC CONCURRENCY LOCK (NO DOUBLE BOOKINGS)
// ==========================================
function tryBookSeat(seatId, studentName) {
  const seat = seats.find((s) => s.id === seatId);
  if (!seat) return { ok: false, code: 404, msg: "Seat not found" };

  // Step 1: Acquire atomic lock
  if (seatLocks.has(seatId)) {
    addLog(studentName, `409 Conflict — ${seatId} locked by another request`, "log-conflict");
    return { ok: false, code: 409, msg: "Seat is currently being booked" };
  }

  seatLocks.add(seatId);

  try {
    // Step 2: Re-verify availability inside lock
    if (seat.status !== "available") {
      addLog(studentName, `409 Conflict — ${seatId} already ${seat.status} by ${seat.occupant}`, "log-conflict");
      return { ok: false, code: 409, msg: `Already ${seat.status}` };
    }

    // Step 3: Commit reservation (pending QR scan)
    seat.status = "reserved";
    seat.occupant = studentName;
    seat.timeLeftSec = QR_GRACE_SEC;

    addLog(studentName, `200 OK — Reserved ${seatId} (awaiting QR scan)`, "log-ok");
    return { ok: true, code: 200, msg: "Reserved successfully" };
  } finally {
    // Step 4: Release lock
    seatLocks.delete(seatId);
  }
}

// ==========================================
// 3. QR CHECK-IN, 20-MIN BREAK & AUTO-RELEASE
// ==========================================
function checkInWithQR(seatId) {
  const seat = seats.find((s) => s.id === seatId);
  if (!seat) return;

  seat.status = "occupied";
  seat.timeLeftSec = 0;
  addLog(seat.occupant, `QR Verified — Checked in at ${seat.id}`, "log-ok");
  showToast(`QR verified! Checked in at ${seat.id}.`);
  renderAll();
}

function startBreakTimer(seatId) {
  const seat = seats.find((s) => s.id === seatId);
  if (!seat || seat.status !== "occupied") return;

  seat.status = "break";
  seat.timeLeftSec = BREAK_DURATION_SEC; // 20 minutes
  addLog(seat.occupant, `Started 20-min break at ${seat.id}`, "log-auto");
  showToast(`20-minute break started for ${seat.id}.`);
  renderAll();
}

function releaseSeat(seatId, isAuto = false) {
  const seat = seats.find((s) => s.id === seatId);
  if (!seat) return;

  const prevUser = seat.occupant || "Student";
  seat.status = "available";
  seat.occupant = null;
  seat.timeLeftSec = 0;

  if (isAuto) {
    seat.hogCount += 1; // Track seat hogging for Admin Analytics
    addLog("AUTO-RELEASE", `${seat.id} freed (${prevUser} exceeded timer)`, "log-auto");
    showToast(`Auto-released ${seat.id}! Now available.`);
  } else {
    addLog(prevUser, `Checked out cleanly from ${seat.id}`, "log-ok");
    showToast(`Checked out from ${seat.id}.`);
  }

  renderAll();
}

// ==========================================
// 4. CONCURRENCY RUSH SIMULATOR (5x SIMULTANEOUS)
// ==========================================
function simulateConcurrencyRush() {
  const target = seats.find((s) => s.floor === currentFloor && s.status === "available");
  if (!target) {
    showToast("No available seats on this floor to test rush!");
    return;
  }

  const students = ["Student-A", "Student-B", "Student-C", "Student-D", "Student-E"];
  let winners = 0;
  let conflicts = 0;

  // Fire 5 simultaneous booking attempts on the exact same seat
  students.forEach((student) => {
    const res = tryBookSeat(target.id, student);
    if (res.ok) winners++;
    else conflicts++;
  });

  selectedSeatId = target.id;
  showToast(`Rush on ${target.id}: ${winners} booked (200 OK), ${conflicts} blocked (409 Conflict)!`);
  renderAll();
}

// ==========================================
// 5. LIVE TIMER & 5-SECOND SYNC LOOP
// ==========================================
setInterval(() => {
  let changed = false;

  // Decrement active timers (QR grace period & 20-min breaks)
  seats.forEach((seat) => {
    if ((seat.status === "break" || seat.status === "reserved") && seat.timeLeftSec > 0) {
      seat.timeLeftSec = Math.max(0, seat.timeLeftSec - timeMultiplier);
      changed = true;

      if (seat.timeLeftSec === 0) {
        releaseSeat(seat.id, true); // Auto-release!
      }
    }
  });

  // Update 5-second live map sync indicator
  syncCountdown--;
  if (syncCountdown <= 0) {
    syncCountdown = 5;
    changed = true;
  }
  document.getElementById("syncText").textContent = `Live sync: ${syncCountdown}s`;

  if (changed) {
    renderMap();
    renderDetailPanel();
  }
}, 1000);

// ==========================================
// 6. UI RENDERING FUNCTIONS
// ==========================================
function formatTime(totalSec) {
  const m = Math.floor(totalSec / 60).toString().padStart(2, "0");
  const s = (totalSec % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

function generateQRSVG(seatId) {
  // Deterministic mini SVG QR pattern unique to each seat ID
  let rects = "";
  let seed = seatId.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  for (let y = 0; y < 7; y++) {
    for (let x = 0; x < 7; x++) {
      seed = (seed * 31 + x * 7 + y * 13) % 97;
      if (seed % 2 === 0 || (x < 2 && y < 2) || (x > 4 && y < 2) || (x < 2 && y > 4)) {
        rects += `<rect x="${x * 14 + 6}" y="${y * 14 + 6}" width="12" height="12" fill="#0f172a"/>`;
      }
    }
  }
  return `<svg width="110" height="110" viewBox="0 0 110 110" xmlns="http://www.w3.org/2000/svg">${rects}</svg>`;
}

function renderMap() {
  const floorSeats = seats.filter((s) => s.floor === currentFloor);

  // Floor Summary Counts
  const counts = { available: 0, reserved: 0, occupied: 0, break: 0 };
  floorSeats.forEach((s) => counts[s.status]++);

  document.getElementById("floorStats").innerHTML = `
    <div class="stat-box"><strong>${counts.available}</strong><span>Available</span></div>
    <div class="stat-box"><strong>${counts.reserved}</strong><span>Pending QR</span></div>
    <div class="stat-box"><strong>${counts.occupied}</strong><span>Checked In</span></div>
    <div class="stat-box"><strong>${counts.break}</strong><span>On 20m Break</span></div>
  `;

  // Seat Cards
  const grid = document.getElementById("seatGrid");
  grid.innerHTML = floorSeats
    .map((seat) => {
      const timerHtml =
        seat.status === "break" || seat.status === "reserved"
          ? `<div class="seat-timer">⏱ ${formatTime(seat.timeLeftSec)}</div>`
          : "";
      const selectedClass = seat.id === selectedSeatId ? "selected" : "";
      return `
        <div class="seat-card ${seat.status} ${selectedClass}" onclick="selectSeat('${seat.id}')">
          <div class="seat-id">${seat.id}</div>
          <div class="seat-zone">${seat.zone}</div>
          <div class="seat-status">${seat.status}</div>
          ${timerHtml}
        </div>
      `;
    })
    .join("");
}

function renderDetailPanel() {
  const panel = document.getElementById("detailPanel");
  const seat = seats.find((s) => s.id === selectedSeatId);
  if (!seat) return;

  let actionHtml = "";

  if (seat.status === "available") {
    actionHtml = `
      <button class="action-btn btn-primary" onclick="handleReserve('${seat.id}')">
        Reserve Seat Now
      </button>
    `;
  } else if (seat.status === "reserved") {
    actionHtml = `
      <div class="qr-box">
        ${generateQRSVG(seat.id)}
        <p>Scan desk QR within <strong>${formatTime(seat.timeLeftSec)}</strong> to confirm check-in.</p>
      </div>
      <button class="action-btn btn-success" onclick="checkInWithQR('${seat.id}')">
        Simulate QR Scan at Seat
      </button>
      <button class="action-btn btn-outline" onclick="releaseSeat('${seat.id}', false)">
        Cancel Reservation
      </button>
    `;
  } else if (seat.status === "occupied") {
    actionHtml = `
      <button class="action-btn btn-warning" onclick="startBreakTimer('${seat.id}')">
        Start 20-Min Break Timer
      </button>
      <button class="action-btn btn-outline" onclick="releaseSeat('${seat.id}', false)">
        Check Out & Free Seat
      </button>
    `;
  } else if (seat.status === "break") {
    actionHtml = `
      <div class="qr-box">
        ${generateQRSVG(seat.id)}
        <p>Auto-release in <strong>${formatTime(seat.timeLeftSec)}</strong>. Scan QR to resume.</p>
      </div>
      <button class="action-btn btn-success" onclick="checkInWithQR('${seat.id}')">
        Return & Scan QR
      </button>
      <button class="action-btn btn-outline" onclick="releaseSeat('${seat.id}', false)">
        Release Seat Now
      </button>
    `;
  }

  panel.innerHTML = `
    <h2>Seat ${seat.id}</h2>
    <span class="badge ${seat.status}">${seat.status}</span>
    <ul class="info-list">
      <li><span>Floor</span><strong>Floor ${seat.floor}</strong></li>
      <li><span>Zone</span><strong>${seat.zone}</strong></li>
      <li><span>Occupant</span><strong>${seat.occupant || "None"}</strong></li>
      <li><span>Past Auto-Releases</span><strong>${seat.hogCount}x</strong></li>
    </ul>
    ${actionHtml}
  `;
}

function renderAdmin() {
  // 1. Peak Hours Bar Chart
  document.getElementById("peakChart").innerHTML = peakHoursData
    .map(
      (d) => `
      <div class="bar-col">
        <span class="bar-val">${d.pct}%</span>
        <div class="bar-fill ${d.pct >= 85 ? "peak" : ""}" style="height: ${d.pct}%"></div>
        <span class="bar-lbl">${d.hour}</span>
      </div>
    `
    )
    .join("");

  // 2. Most Hogged Seats Table (sorted descending)
  const topHogged = [...seats].sort((a, b) => b.hogCount - a.hogCount).slice(0, 6);
  document.getElementById("hoggedTableBody").innerHTML = topHogged
    .map(
      (s) => `
      <tr onclick="jumpToSeat('${s.id}', ${s.floor})">
        <td><strong>${s.id}</strong></td>
        <td>Floor ${s.floor}</td>
        <td>${s.hogCount} times</td>
        <td><span class="badge ${s.status}">${s.status}</span></td>
      </tr>
    `
    )
    .join("");

  // 3. Concurrency & Event Audit Log
  document.getElementById("auditLog").innerHTML = auditLogs
    .map((l) => `<div class="${l.cls}">[${l.time}] <strong>${l.actor}:</strong> ${l.msg}</div>`)
    .join("");
}

function renderAll() {
  renderMap();
  renderDetailPanel();
  renderAdmin();
}

// ==========================================
// 7. USER INTERACTIONS & HELPERS
// ==========================================
function selectSeat(seatId) {
  selectedSeatId = seatId;
  renderMap();
  renderDetailPanel();
}

function handleReserve(seatId) {
  const res = tryBookSeat(seatId, "You (Demo Student)");
  showToast(res.ok ? `Reserved ${seatId}. Scan QR to check in.` : res.msg);
  renderAll();
}

function jumpToSeat(seatId, floor) {
  currentFloor = floor;
  selectedSeatId = seatId;
  document.querySelectorAll(".floor-btn").forEach((b) => {
    b.classList.toggle("active", Number(b.dataset.floor) === floor);
  });
  switchView("map");
  renderAll();
}

function switchView(view) {
  const isMap = view === "map";
  document.getElementById("mapView").classList.toggle("hidden", !isMap);
  document.getElementById("adminView").classList.toggle("hidden", isMap);
  document.getElementById("tabMap").classList.toggle("active", isMap);
  document.getElementById("tabAdmin").classList.toggle("active", !isMap);
  if (!isMap) renderAdmin();
}

function addLog(actor, msg, cls = "") {
  const time = new Date().toLocaleTimeString();
  auditLogs.unshift({ time, actor, msg, cls });
  if (auditLogs.length > 30) auditLogs.pop();
}

function showToast(message) {
  const el = document.getElementById("demoToast");
  el.textContent = message;
}

// Event Listeners
document.getElementById("tabMap").addEventListener("click", () => switchView("map"));
document.getElementById("tabAdmin").addEventListener("click", () => switchView("admin"));

document.querySelectorAll(".floor-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    currentFloor = Number(btn.dataset.floor);
    document.querySelectorAll(".floor-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    renderMap();
  });
});

document.getElementById("btnSpeedToggle").addEventListener("click", (e) => {
  timeMultiplier = timeMultiplier === 1 ? 60 : 1;
  e.target.textContent =
    timeMultiplier === 60 ? "Time Speed: 60x (20m = 20s)" : "Time Speed: 1x (Real)";
  e.target.classList.toggle("active-speed", timeMultiplier === 60);
});

document.getElementById("btnRushTest").addEventListener("click", simulateConcurrencyRush);
document.getElementById("btnResetDemo").addEventListener("click", () => {
  initSeats();
  showToast("All seats reset to demo defaults.");
  renderAll();
});

// Boot App
initSeats();
renderAll();
// ==========================================
// 8. STUDENT & ADMIN AUTHENTICATION
// ==========================================
let currentUser = null;

function setLoginRole(role) {
  document.getElementById("roleStudentBtn").classList.toggle("active", role === "student");
  document.getElementById("roleRegisterBtn").classList.toggle("active", role === "register");
  document.getElementById("roleAdminBtn").classList.toggle("active", role === "admin");

  document.getElementById("studentLoginForm").classList.toggle("hidden", role !== "student");
  document.getElementById("registerForm").classList.toggle("hidden", role !== "register");
  document.getElementById("adminLoginForm").classList.toggle("hidden", role !== "admin");

  document.getElementById("studentLoginError").classList.add("hidden");
  document.getElementById("regMessage").classList.add("hidden");
  document.getElementById("loginError").classList.add("hidden");
}

async function handleStudentLogin(e) {
  e.preventDefault();
  const id = document.getElementById("studentIdInput").value.trim();
  const pass = document.getElementById("studentPassInput").value.trim();
  const errEl = document.getElementById("studentLoginError");
  errEl.classList.add("hidden");

  try {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, pass }),
    });
    const data = await res.json();

    if (!res.ok) {
      errEl.textContent = data.error || "Login failed";
      errEl.classList.remove("hidden");
      return;
    }

    completeLogin(data.user);
  } catch (err) {
    errEl.textContent = "Server not reachable. Make sure you opened http://localhost:3000";
    errEl.classList.remove("hidden");
  }
}

async function handleRegister(e) {
  e.preventDefault();
  const name = document.getElementById("regNameInput").value.trim();
  const id = document.getElementById("regIdInput").value.trim();
  const pass = document.getElementById("regPassInput").value.trim();
  const msgEl = document.getElementById("regMessage");
  msgEl.classList.add("hidden");

  try {
    const res = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, id, pass }),
    });
    const data = await res.json();

    if (!res.ok) {
      msgEl.textContent = data.error || "Registration failed";
      msgEl.classList.remove("hidden");
      return;
    }

    document.getElementById("registerForm").reset();
    completeLogin(data.user);
    showToast(`Welcome ${name}! Account saved permanently.`);
  } catch (err) {
    msgEl.textContent = "Server not reachable. Make sure you opened http://localhost:3000";
    msgEl.classList.remove("hidden");
  }
}

function handleAdminLogin(e) {
  e.preventDefault();
  const user = document.getElementById("adminUserInput").value.trim();
  const pass = document.getElementById("adminPassInput").value.trim();

  if (user === "admin" && pass === "admin123") {
    completeLogin({ role: "admin", name: "Library Admin" });
  } else {
    document.getElementById("loginError").classList.remove("hidden");
  }
}

function quickDemoLogin(role) {
  if (role === "student") {
    completeLogin({ role: "student", name: "Anshu (CS-26)" });
  } else {
    completeLogin({ role: "admin", name: "Library Admin" });
  }
}

function completeLogin(user) {
  currentUser = user;
  document.getElementById("loginOverlay").classList.add("hidden");
  document.getElementById("userBadge").textContent =
    user.role === "admin" ? `Admin: ${user.name}` : `Student: ${user.name}`;
  document.getElementById("tabAdmin").classList.toggle("hidden", user.role !== "admin");
  switchView(user.role === "admin" ? "admin" : "map");
  addLog(user.name, `Logged in as ${user.role.toUpperCase()}`, "log-ok");
  renderAll();
}

function handleLogout() {
  currentUser = null;
  document.getElementById("loginOverlay").classList.remove("hidden");
  document.getElementById("studentLoginForm").reset();
  document.getElementById("registerForm").reset();
  document.getElementById("adminLoginForm").reset();
  setLoginRole("student");
}
// ==========================================
// 9. LIVE MULTI-DEVICE SYNC (EVERY 2 SECONDS)
// ==========================================
async function pushStateToServer() {
  try {
    await fetch("/api/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seats, auditLog }),
    });
  } catch (e) {}
}

async function pullStateFromServer() {
  try {
    const res = await fetch("/api/sync");
    const data = await res.json();
    if (data && Array.isArray(data.seats) && data.seats.length > 0) {
      seats = data.seats;
      if (Array.isArray(data.auditLog)) auditLog = data.auditLog;
      renderAll();
    }
  } catch (e) {}
}

document.addEventListener("click", (e) => {
  if (e.target.closest("button")) {
    setTimeout(pushStateToServer, 150);
  }
});

pullStateFromServer();
setInterval(pullStateFromServer, 2000);
