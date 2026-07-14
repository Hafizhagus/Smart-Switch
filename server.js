import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import cookieParser from "cookie-parser";
import mqtt from "mqtt";                    // ← BARU
import "dotenv/config";

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static("public"));

const JWT_SECRET = process.env.JWT_SECRET;
const USERS = { [process.env.ADMIN_USER]: process.env.ADMIN_HASH };

// ============ MQTT ============
const T_SET   = "smartswitch/relay1/set";
const T_STATE = "smartswitch/relay1/state";
const T_STAT  = "smartswitch/status";

let deviceState  = "UNKNOWN";     // ON / OFF
let deviceOnline = "offline";     // online / offline

const client = mqtt.connect(`mqtts://${process.env.MQTT_HOST}:8883`, {
  username: process.env.MQTT_USER,
  password: process.env.MQTT_PASS,
  clientId: "backend-" + Math.random().toString(16).slice(2, 8)
});

client.on("connect", () => {
  console.log("✅ MQTT tersambung ke HiveMQ");
  client.subscribe([T_STATE, T_STAT]);
});

client.on("message", (topic, buf) => {
  const isi = buf.toString();
  console.log(`📩 ${topic} = ${isi}`);
  if (topic === T_STATE) deviceState  = isi;
  if (topic === T_STAT)  deviceOnline = isi;
});

client.on("error", (e) => console.log("❌ MQTT error:", e.message));

// ============ AUTH ============
function auth(req, res, next) {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: "belum login" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "token tidak valid" });
  }
}

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;
  const hash = USERS[username];
  if (!hash) return res.status(401).json({ error: "user/password salah" });
  if (!(await bcrypt.compare(password, hash)))
    return res.status(401).json({ error: "user/password salah" });

  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: "7d" });
  res.cookie("token", token, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",   // ← ini yang berubah
    maxAge: 7 * 24 * 3600 * 1000
  });
  res.json({ ok: true });
});

app.post("/api/logout", (req, res) => {
  res.clearCookie("token");
  res.json({ ok: true });
});

app.get("/api/me", auth, (req, res) => {
  res.json({ username: req.user.username });
});

// ============ RELAY (dijaga auth) ============
app.get("/api/state", auth, (req, res) => {
  res.json({ state: deviceState, online: deviceOnline });
});

app.post("/api/relay", auth, (req, res) => {
  const cmd = String(req.body.cmd || "").toUpperCase();

  if (!["ON", "OFF", "TOGGLE"].includes(cmd))
    return res.status(400).json({ error: "perintah tidak valid" });

  client.publish(T_SET, cmd, { qos: 1 });
  console.log(`🔀 ${req.user.username} -> ${cmd}`);
  res.json({ ok: true, sent: cmd });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server jalan di http://localhost:${PORT}`));