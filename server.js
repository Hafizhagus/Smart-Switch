import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import cookieParser from "cookie-parser";
import mqtt from "mqtt";
import cron from "node-cron";
import { createClient } from "@supabase/supabase-js";
import "dotenv/config";

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static("public"));

const NAMA = { 1: "Lampu Teras", 2: "Pompa Air", 3: "Kipas", 4: "Stopkontak" };

const JWT_SECRET = process.env.JWT_SECRET;
const USERS = { [process.env.ADMIN_USER]: process.env.ADMIN_HASH };
const TARIF = parseFloat(process.env.TARIF_PER_KWH || 1699.53);

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

db.from("schedules").select("count").then(({ error }) => {
  if (error) console.log("❌ Supabase:", error.message);
  else console.log("✅ Supabase tersambung");
});

// ══════════════ STATE (cache di RAM) ══════════════
const state = {
  online: "offline",
  relay: { 1: "OFF", 2: "OFF", 3: "OFF", 4: "OFF" },
  telemetry: {
    total: { v: 0, i: 0, p: 0, kwh: 0 },
    ch: [
      { p: 0, i: 0, pf: 0, kwh: 0 },
      { p: 0, i: 0, pf: 0, kwh: 0 },
      { p: 0, i: 0, pf: 0, kwh: 0 },
      { p: 0, i: 0, pf: 0, kwh: 0 }
    ]
  },
  updated: null
};

// ══════════════ MQTT ══════════════
const client = mqtt.connect(`mqtts://${process.env.MQTT_HOST}:8883`, {
  username: process.env.MQTT_USER,
  password: process.env.MQTT_PASS,
  clientId: "backend-" + Math.random().toString(16).slice(2, 8)
});

client.on("connect", () => {
  console.log("✅ MQTT tersambung");
  client.subscribe("smartswitch/+/state");     // wildcard: relay1..relay4
  client.subscribe("smartswitch/status");
  client.subscribe("smartswitch/telemetry");
});

client.on("message", (topic, buf) => {
  const isi = buf.toString();

  if (topic === "smartswitch/status") {
    state.online = isi;
    return;
  }

  if (topic === "smartswitch/telemetry") {
    try {
      state.telemetry = JSON.parse(isi);
      state.updated = new Date();
    } catch { console.log("⚠️ telemetry bukan JSON valid"); }
    return;
  }

  const m = topic.match(/^smartswitch\/relay(\d)\/state$/);
  if (m) {
    state.relay[+m[1]] = isi;
    console.log(`📩 relay${m[1]} = ${isi}`);
  }
});

client.on("error", e => console.log("❌ MQTT:", e.message));

function perintah(relay, cmd, sumber) {
  client.publish(`smartswitch/relay${relay}/set`, cmd, { qos: 1 });
  db.from("activity_log").insert({ relay, aksi: cmd, sumber }).then(() => {});
  console.log(`🔀 relay${relay} <- ${cmd} (${sumber})`);
}

// ══════════════ SIMPAN ENERGI KE DB (tiap 5 menit) ══════════════
cron.schedule("*/5 * * * *", async () => {
  if (state.online !== "online") return;

  const t = state.telemetry;
  const rows = [
    { channel: 0, daya: t.total.p, energi_kwh: t.total.kwh },
    ...t.ch.map((c, i) => ({ channel: i + 1, daya: c.p, energi_kwh: c.kwh }))
  ];

  const { error } = await db.from("energy_log").insert(rows);
  if (error) console.log("❌ simpan energi:", error.message);
  else console.log("💾 energi tersimpan");
});

// ══════════════ SCHEDULER (cek tiap menit) ══════════════
cron.schedule("* * * * *", async () => {
  const now = new Date();
  // WIB = UTC+7
  const wib = new Date(now.getTime() + 7 * 3600 * 1000);
  const jam = `${String(wib.getUTCHours()).padStart(2, "0")}:${String(wib.getUTCMinutes()).padStart(2, "0")}`;
  const hari = String(wib.getUTCDay());

  const { data } = await db.from("schedules")
    .select("*").eq("aktif", true).eq("jam", jam);

  if (!data) return;

  for (const s of data) {
    if (!s.hari.split(",").includes(hari)) continue;
    perintah(s.relay, s.aksi, "jadwal");
  }
});

// ══════════════ AUTH ══════════════
function auth(req, res, next) {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: "belum login" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "token tidak valid" });
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
    httpOnly: true, sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    maxAge: 7 * 24 * 3600 * 1000
  });
  res.json({ ok: true });
});

app.post("/api/logout", (req, res) => {
  res.clearCookie("token");
  res.json({ ok: true });
});

app.get("/api/me", auth, (req, res) => res.json({ username: req.user.username }));

// ══════════════ DASHBOARD ══════════════
app.get("/api/state", auth, (req, res) => {
  res.json({
    online: state.online,
    relay: state.relay,
    telemetry: state.telemetry,
    updated: state.updated,
    tarif: TARIF
  });
});

app.post("/api/relay/:n", auth, (req, res) => {
  const n = parseInt(req.params.n);
  const cmd = String(req.body.cmd || "").toUpperCase();

  if (![1, 2, 3, 4].includes(n))
    return res.status(400).json({ error: "relay tidak valid" });
  if (!["ON", "OFF", "TOGGLE"].includes(cmd))
    return res.status(400).json({ error: "perintah tidak valid" });

  perintah(n, cmd, "web");
  res.json({ ok: true });
});

app.post("/api/all", auth, (req, res) => {
  const cmd = String(req.body.cmd || "").toUpperCase();
  if (!["ON", "OFF"].includes(cmd))
    return res.status(400).json({ error: "perintah tidak valid" });

  [1, 2, 3, 4].forEach(n => perintah(n, cmd, "web"));
  res.json({ ok: true });
});

// ══════════════ JADWAL ══════════════
app.get("/api/schedules", auth, async (req, res) => {
  const { data } = await db.from("schedules").select("*").order("jam");
  res.json(data || []);
});

app.post("/api/schedules", auth, async (req, res) => {
  const { relay, jam, aksi, hari } = req.body;

  if (![1, 2, 3, 4].includes(+relay))
    return res.status(400).json({ error: "relay tidak valid" });
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(jam))
    return res.status(400).json({ error: "format jam harus HH:MM" });
  if (!["ON", "OFF"].includes(aksi))
    return res.status(400).json({ error: "aksi harus ON/OFF" });

  const { data, error } = await db.from("schedules")
    .insert({ relay: +relay, jam, aksi, hari: hari || "0,1,2,3,4,5,6" })
    .select();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data[0]);
});

app.delete("/api/schedules/:id", auth, async (req, res) => {
  await db.from("schedules").delete().eq("id", req.params.id);
  res.json({ ok: true });
});

app.patch("/api/schedules/:id", auth, async (req, res) => {
  await db.from("schedules")
    .update({ aktif: req.body.aktif })
    .eq("id", req.params.id);
  res.json({ ok: true });
});

// ══════════════ RIWAYAT ══════════════
app.get("/api/history", auth, async (req, res) => {
  const jam = parseInt(req.query.jam) || 24;
  const sejak = new Date(Date.now() - jam * 3600 * 1000).toISOString();

  const { data } = await db.from("energy_log")
    .select("waktu, channel, daya, energi_kwh")
    .gte("waktu", sejak)
    .order("waktu");

  res.json(data || []);
});

app.get("/api/activity", auth, async (req, res) => {
  const { data } = await db.from("activity_log")
    .select("*").order("waktu", { ascending: false }).limit(30);
  res.json(data || []);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server jalan di http://localhost:${PORT}`));