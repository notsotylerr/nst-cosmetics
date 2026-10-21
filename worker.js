// NotSoTylerr Design - online server (Cloudflare Worker + D1 database; the free plan is plenty for a group of friends).
// Stores each player's cosmetics so everyone with the mod can see them, shows which friends are online and where,
// and handles friend requests, pings, messages, group chats and emotes.
//
// Version 2: everything is kept in a D1 database (Cloudflare's SQL database) instead of KV. KV is slow to agree
// with itself between Cloudflare's locations (up to a minute) and only allows ~1,000 saves and ~100,000 reads a day
// on the free plan, which is why messages, requests and emotes used to go missing. D1 is always up to date and
// allows 100,000 saves and 5,000,000 reads a day for free. The mod now asks for everything in one request per
// check instead of five.
//
// Setup: see SETUP.md (create a D1 database, bind it to this worker as DB, paste this file, Deploy).
// If you still have the old KV binding (NST), leave it: your friends lists and looks are copied over automatically.
//
// How login works: the mod asks for a one-time code and signs it with the player key Mojang gives every account
// (the one Minecraft uses to sign chat). This server checks Mojang's signature on that key, then the player's
// signature on the code. No passwords or game tokens ever come here.

const VERSION = 2;
const MAX_LOOK_BYTES = 16000; // room for painted capes (with animation frames), wings, elytra and custom emotes
const TOKEN_TTL = 30 * 86400_000; // 30 days
const LOOK_TTL = 60 * 86400_000; // forget players who haven't played for 60 days
const INBOX_TTL = 7 * 86400_000; // pings, messages and requests wait up to a week for someone who's offline
const EMOTE_FRESH = 15_000; // an emote is news for 15 seconds
const PRESENCE_FRESH = 7 * 60_000;
const SEEN_EVERY = 60_000; // "online" is refreshed at most once a minute
const PING_GAP = 60_000; // between pings to the same friend
const MAX_GROUP = 10; // people in a group, you included
const MAX_GROUPS = 20; // groups you can be in
const MAX_FRIENDS = 200;
const MAX_MESSAGE = 200;

const PATTERNS = ["SOLID", "GRADIENT", "STRIPES", "CHEVRON", "SPLIT", "CHECKER", "DIAGONAL", "LIGHTNING", "CROSS", "LOGO"];
const WINGS = ["ANGEL", "DEMON", "BUTTERFLY", "DRAGON", "FAIRY", "CUSTOM"];
const HATS = ["NONE", "HALO", "CROWN", "HORNS", "CAT_EARS", "BUNNY_EARS", "TOP_HAT", "WIZARD", "HEADPHONES", "FLOWER_CROWN", "VIKING", "GEM_CROWN", "PARTY_HAT", "PIRATE", "ANTLERS"];
const AURAS = ["NONE", "FLAMES", "SPARKLES", "ORBIT", "SNOW", "VOID", "LIGHTNING", "GALAXY", "PETALS", "RUNES", "HEARTS", "BUBBLES", "STORM"];
const TRAILS = ["NONE", "SPARKLE", "FLAME", "HEARTS", "NOTES", "RAINBOW", "PIXELS", "FOOTPRINTS", "ICE", "SMOKE"];
const KILLS = ["NONE", "SOUL_BURST", "LIGHTNING", "CONFETTI", "BLACK_HOLE", "FIREWORK", "HEARTS", "GHOST", "PIXELS", "CRYSTAL", "DISINTEGRATE", "METEOR"];
const TOTEMS = ["CLASSIC", "PHOENIX", "VORTEX", "SHATTER", "HALO", "NOVA"];
const RARITIES = ["OFF", "BASIC", "RARE", "LEGENDARY", "MYTHIC", "RANDOM"];
const NAMES = ["OFF", "SOLID", "GRADIENT", "RAINBOW", "WAVE", "PULSE"];
const PETS = ["NONE", "GHOST", "DRAGON", "SLIME", "BAT", "FAIRY", "CAT", "PHOENIX", "BEE", "FOX", "PENGUIN", "AXOLOTL", "UFO"];
const EMOTES = ["WAVE", "CHEER", "SALUTE", "CLAP", "BOW", "POINT", "DANCE", "FACEPALM", "SIT", "FLOSS", "LAUGH", "CRY", "COME_HERE", "SHRUG", "THINK", "BURST", "CUSTOM_1", "CUSTOM_2", "CUSTOM_3", "CUSTOM_4", "CUSTOM_5"];
const BADGES = ["FIRST_KILL", "STREAK_5", "COMBO_10", "SOCIAL", "REGULAR", "SURVIVOR", "HUNTER", "STREAK_15", "COMBO_25", "VETERAN", "SLAYER", "LEGEND"];

const isGid = (s) => typeof s === "string" && /^[0-9a-f]{16}$/.test(s);
const isId = (s) => typeof s === "string" && /^[0-9a-f]{32}$/.test(s);
const isName = (s) => typeof s === "string" && /^[A-Za-z0-9_]{1,16}$/.test(s);
// a joinable public server address (never someone's own computer or home network)
const isPrivateHost = (h) => h === "localhost" || h.endsWith(".local") || /^(127|10|0)\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h) || /^172\.(1[6-9]|2[0-9]|3[01])\./.test(h);
const isServer = (s) => typeof s === "string" && s.length <= 260 && (/^[a-z0-9.-]{1,253}(:[0-9]{1,5})?$/.test(s) && s.includes(".") || /^[a-z0-9.-]{1,253}:[0-9]{1,5}$/.test(s)) && !isPrivateHost(s.split(":")[0]);
const cleanText = (s, max) => (typeof s === "string" ? s.replace(/§[\s\S]?/g, "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max) : "");

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
function randomHex(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return hex(b);
}

// Custom emotes: up to 5, each a name and up to 6 keyframes of 20 numbers [ms, 18 angles, lift].
function cleanEmotes(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const e of list.slice(0, 5)) {
    if (!e || typeof e !== "object" || !Array.isArray(e.f)) continue;
    const frames = [];
    for (const f of e.f.slice(0, 6)) {
      if (!Array.isArray(f) || f.length !== 20 || !f.every((v) => typeof v === "number" && isFinite(v))) { frames.length = 0; break; }
      frames.push([Math.min(3000, Math.max(80, Math.round(f[0]))), ...f.slice(1, 19).map((v) => Math.min(180, Math.max(-180, Math.round(v)))), Math.min(6, Math.max(-12, f[19]))]);
    }
    if (!frames.length) continue;
    out.push({ n: cleanText(typeof e.n === "string" ? e.n : "", 16) || "My emote", r: Number.isInteger(e.r) ? Math.min(4, Math.max(1, e.r)) : 1, f: frames });
  }
  return out;
}

// Only keep fields we know, with safe types and ranges: this data is shown on other people's screens.
function cleanLook(l) {
  if (!l || typeof l !== "object") return null;
  const int = (v, d) => (Number.isInteger(v) ? v & 0xffffff : d);
  const num = (v, d, lo, hi) => (typeof v === "number" && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  const count = (v) => (Number.isInteger(v) && v >= 0 ? Math.min(v, 1e7) : 0);
  const px = (s, n) => (typeof s === "string" && s.length === n * 6 && /^[0-9a-f-]+$/.test(s) ? s : "-".repeat(n * 6));
  return {
    cape: l.cape === true,
    capePattern: PATTERNS.includes(l.capePattern) ? l.capePattern : "GRADIENT",
    capePrimary: int(l.capePrimary, 0xff2846),
    capeSecondary: int(l.capeSecondary, 0xb026ff),
    capeRim: int(l.capeRim, 0x16121f),
    capeAnimated: l.capeAnimated === true,
    capePixels: px(l.capePixels, 160),
    capeFrameCount: Number.isInteger(l.capeFrameCount) ? Math.min(4, Math.max(1, l.capeFrameCount)) : 1,
    capeFrameMs: Number.isInteger(l.capeFrameMs) ? Math.min(1000, Math.max(80, l.capeFrameMs)) : 250,
    ...(Number.isInteger(l.capeFrameCount) && l.capeFrameCount > 1 ? { capePixels2: px(l.capePixels2, 160) } : {}),
    ...(Number.isInteger(l.capeFrameCount) && l.capeFrameCount > 2 ? { capePixels3: px(l.capePixels3, 160) } : {}),
    ...(Number.isInteger(l.capeFrameCount) && l.capeFrameCount > 3 ? { capePixels4: px(l.capePixels4, 160) } : {}),
    elytra: l.elytra === true,
    elytraPattern: PATTERNS.includes(l.elytraPattern) ? l.elytraPattern : "GRADIENT",
    elytraPrimary: int(l.elytraPrimary, 0xff2846),
    elytraSecondary: int(l.elytraSecondary, 0xb026ff),
    elytraRim: int(l.elytraRim, 0x16121f),
    elytraAnimated: l.elytraAnimated !== false,
    elytraPixels: px(l.elytraPixels, 200),
    wings: l.wings === true,
    wingStyle: WINGS.includes(l.wingStyle) ? l.wingStyle : "ANGEL",
    wingColour: int(l.wingColour, 0xffffff),
    wingColour2: int(l.wingColour2, 0xb026ff),
    wingSize: num(l.wingSize, 1, 0.5, 2),
    wingFlap: num(l.wingFlap, 1, 0, 3),
    wingGlow: l.wingGlow === true,
    wingPixels: px(l.wingPixels, 120),
    hat: HATS.includes(l.hat) ? l.hat : "NONE",
    hatColour: int(l.hatColour, 0xffd700),
    hatColour2: int(l.hatColour2, 0xff2846),
    aura: AURAS.includes(l.aura) ? l.aura : "NONE",
    auraColour: int(l.auraColour, 0xb026ff),
    auraColour2: int(l.auraColour2, 0x00f0ff),
    auraReact: Number.isInteger(l.auraReact) ? l.auraReact & 31 : 0,
    killEffect: KILLS.includes(l.killEffect) ? l.killEffect : "NONE",
    killColour: int(l.killColour, 0xff2846),
    ...(TOTEMS.includes(l.totemStyle) ? { totemStyle: l.totemStyle } : {}),
    totemRarity: RARITIES.includes(l.totemRarity) ? l.totemRarity : "OFF",
    customEmotes: cleanEmotes(l.customEmotes),
    trail: TRAILS.includes(l.trail) ? l.trail : "NONE",
    trailColour: int(l.trailColour, 0xff2bd6),
    nameStyle: NAMES.includes(l.nameStyle) ? l.nameStyle : "OFF",
    nameColour: int(l.nameColour, 0xff2846),
    nameColour2: int(l.nameColour2, 0xb026ff),
    nameBold: l.nameBold === true,
    pet: PETS.includes(l.pet) ? l.pet : "NONE",
    petColour: int(l.petColour, 0xe8e8ff),
    petColour2: int(l.petColour2, 0xb026ff),
    rainbow: l.rainbow === true,
    hatSize: num(l.hatSize, 1, 0.6, 1.6),
    hatGlow: l.hatGlow === true,
    petSize: num(l.petSize, 1, 0.6, 1.6),
    petSide: ["RIGHT", "LEFT", "ABOVE"].includes(l.petSide) ? l.petSide : "RIGHT",
    auraAmount: num(l.auraAmount, 1, 0.25, 2),
    trailAmount: num(l.trailAmount, 1, 0.25, 2),
    badges: Array.isArray(l.badges) ? [...new Set(l.badges.filter((b) => BADGES.includes(b)))].slice(0, 20) : [],
    badge: BADGES.includes(l.badge) ? l.badge : "",
    ...(l.stats && typeof l.stats === "object" ? { stats: {
      kills: count(l.stats.kills), deaths: count(l.stats.deaths), bestStreak: count(l.stats.bestStreak),
      bestCombo: count(l.stats.bestCombo), hours: count(l.stats.hours) } } : {}),
  };
}

// ------------------------------------------------------------------ database

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS tokens (token TEXT PRIMARY KEY, id TEXT NOT NULL, name TEXT, exp INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS pending (sid TEXT PRIMARY KEY, uuid TEXT, name TEXT, exp INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS looks (id TEXT PRIMARY KEY, name TEXT, look TEXT NOT NULL, seen INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS looks_seen ON looks(seen)",
  "CREATE TABLE IF NOT EXISTS emotes (id TEXT PRIMARY KEY, e TEXT NOT NULL, c INTEGER, at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS emotes_at ON emotes(at)",
  "CREATE TABLE IF NOT EXISTS presence (id TEXT PRIMARY KEY, server TEXT NOT NULL, at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS friends (a TEXT NOT NULL, b TEXT NOT NULL, name TEXT, PRIMARY KEY (a, b))",
  "CREATE TABLE IF NOT EXISTS requests (f TEXT NOT NULL, t TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (f, t))",
  "CREATE TABLE IF NOT EXISTS inbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, t TEXT NOT NULL, type TEXT NOT NULL, f TEXT, name TEXT, data TEXT, at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS inbox_t ON inbox(t, seq)",
  "CREATE INDEX IF NOT EXISTS inbox_at ON inbox(at)",
  "CREATE TABLE IF NOT EXISTS gates (k TEXT PRIMARY KEY, until INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS chats (gid TEXT PRIMARY KEY, name TEXT NOT NULL, at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS members (gid TEXT NOT NULL, id TEXT NOT NULL, name TEXT, PRIMARY KEY (gid, id))",
  "CREATE INDEX IF NOT EXISTS members_id ON members(id)",
  "CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)",
];
// Tables are created the first time each copy of the worker runs (IF NOT EXISTS makes repeats harmless).
// A plain flag, not a shared promise: Cloudflare doesn't let one request wait on another request's work.
let ready = false;

async function setup(db) {
  if (ready) return;
  await db.batch(SCHEMA.map((s) => db.prepare(s)));
  ready = true;
}

const one = (db, sql, ...a) => db.prepare(sql).bind(...a).first();
const all = async (db, sql, ...a) => (await db.prepare(sql).bind(...a).all()).results || [];
const run = (db, sql, ...a) => db.prepare(sql).bind(...a).run();

// Old jobs, at most once an hour: expired logins, stale emotes, week-old messages, players gone for 60 days.
async function cleanup(db) {
  const now = Date.now();
  const last = await one(db, "SELECT v FROM meta WHERE k = 'clean'");
  if (last && now - last.v < 3600_000) return;
  await db.batch([
    db.prepare("INSERT INTO meta (k, v) VALUES ('clean', ?1) ON CONFLICT(k) DO UPDATE SET v = ?1").bind(now),
    db.prepare("DELETE FROM tokens WHERE exp < ?").bind(now),
    db.prepare("DELETE FROM pending WHERE exp < ?").bind(now),
    db.prepare("DELETE FROM emotes WHERE at < ?").bind(now - 60_000),
    db.prepare("DELETE FROM gates WHERE until < ?").bind(now),
    db.prepare("DELETE FROM inbox WHERE at < ?").bind(now - INBOX_TTL),
    db.prepare("DELETE FROM requests WHERE at < ?").bind(now - INBOX_TTL),
    db.prepare("DELETE FROM looks WHERE seen < ?").bind(now - LOOK_TTL),
  ]);
}

// One-time copy of a player's old KV data (friends, look) the first time they show up after the update.
async function migrate(env, id) {
  if (!env.NST) return;
  const k = "mig:" + id;
  if (await one(env.DB, "SELECT v FROM meta WHERE k = ?", k)) return;
  await run(env.DB, "INSERT OR IGNORE INTO meta (k, v) VALUES (?, ?)", k, Date.now());
  try {
    const friends = (await env.NST.get("f:" + id, "json")) || [];
    const stmts = friends.filter((f) => f && isId(f.id)).slice(0, MAX_FRIENDS)
      .map((f) => env.DB.prepare("INSERT OR IGNORE INTO friends (a, b, name) VALUES (?, ?, ?)").bind(id, f.id, isName(f.name) ? f.name : ""));
    if (stmts.length) await env.DB.batch(stmts);
    if (!(await one(env.DB, "SELECT id FROM looks WHERE id = ?", id))) {
      const l = await env.NST.get("l:" + id, "json");
      const look = l && cleanLook(l);
      if (look) await run(env.DB, "INSERT OR IGNORE INTO looks (id, name, look, seen) VALUES (?, ?, ?, ?)", id, isName(l.name) ? l.name : "", JSON.stringify(look), l.seen || 0);
    }
  } catch (e) {
    // the old data is optional
  }
}

const b64 = (s) => Uint8Array.from(atob(s.replace(/\s+/g, "")), (c) => c.charCodeAt(0));
let mojangKeys = null, mojangKeysAt = 0;

// Requests to Mojang. Some of Mojang's services refuse requests with no User-Agent (a Worker sends none by
// default), and they sometimes have a hiccup, so: proper headers, a timeout and a couple of retries.
const MOJANG_HEADERS = { "User-Agent": "NotSoTylerr-Design-Cosmetics/2 (Cloudflare Worker)", Accept: "application/json" };
async function mojangFetch(url, tries = 3) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: MOJANG_HEADERS, signal: AbortSignal.timeout(6000) });
      if (r.status === 200 || r.status === 204 || r.status === 404) return r;
      last = r;
      if (r.status !== 429 && r.status < 500 && r.status !== 403) return r;
    } catch (e) {
      last = null;
    }
    if (i < tries - 1) await new Promise((res) => setTimeout(res, 300 * (i + 1)));
  }
  return last || new Response(null, { status: 599 });
}

const importMojangKeys = (list) => Promise.all(list.map((k) =>
  crypto.subtle.importKey("spki", b64(k), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-1" }, false, ["verify"])));

// Mojang's public keys for player certificates (from https://api.minecraftservices.com/publickeys, checked 2026-10-21).
// Mojang refuses every request that comes from a Cloudflare Worker (403), so the worker can't download these itself:
// they're built in here. They almost never change; if Mojang ever adds a new one, the worker also tries to fetch
// the live list now and then (in case Mojang unblocks Workers) and keeps any extra keys it gets in the database.
const PINNED_MOJANG_KEYS = [
  "MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAylB4B6m5lz7jwrcFz6Fd/fnfUhcvlxsTSn5kIK/2aGG1C3kMy4VjhwlxF6BFUSnfxhNswPjh3ZitkBxEAFY25uzkJFRwHwVA9mdwjashXILtR6OqdLXXFVyUPIURLOSWqGNBtb08EN5fMnG8iFLgEJIBMxs9BvF3s3/FhuHyPKiVTZmXY0WY4ZyYqvoKR+XjaTRPPvBsDa4WI2u1zxXMeHlodT3lnCzVvyOYBLXL6CJgByuOxccJ8hnXfF9yY4F0aeL080Jz/3+EBNG8RO4ByhtBf4Ny8NQ6stWsjfeUIvH7bU/4zCYcYOq4WrInXHqS8qruDmIl7P5XXGcabuzQstPf/h2CRAUpP/PlHXcMlvewjmGU6MfDK+lifScNYwjPxRo4nKTGFZf/0aqHCh/EAsQyLKrOIYRE0lDG3bzBh8ogIMLAugsAfBb6M3mqCqKaTMAf/VAjh5FFJnjS+7bE+bZEV0qwax1CEoPPJL1fIQjOS8zj086gjpGRCtSy9+bTPTfTR/SJ+VUB5G2IeCItkNHpJX2ygojFZ9n5Fnj7R9ZnOM+L8nyIjPu3aePvtcrXlyLhH/hvOfIOjPxOlqW+O5QwSFP4OEcyLAUgDdUgyW36Z5mB285uKW/ighzZsOTevVUG2QwDItObIV6i8RCxFbN2oDHyPaO5j1tTaBNyVt8CAwEAAQ==",
  "MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAt4t9NPuu7cktclnaH7eZj0omkLcJHeLz5MKsyJEntHZ0INtuBjSSul3Pp3pBeJN8k3ADdcdBLUN90bcAi7WsQqTx3Ft363q3W7TbM8j2iTEdp/0uVspoRt/DP1tkaWFs/w2WwUv9jbVoBUzfUc4pSTIxRwdjmqjZQfvjwKNDbOx3IhP2H0WXodbISejPi1wBZqNW4m1rnZAXp/EpUguxA8mobCa4vUCBkyFDyXdl69/wUSJHyCPmgcMJ364OlAhIqtwVPShBZObvrK/f0BYk6ShJD3N7TFDatSYsIIdcTKRknaIm91s+EsMrdB9U4Yw+ZJ/pyCB4S3vk8zfDCnb0DWIxYH3/EMzaxl77djmTmMzi/JDITup5z3jfWtRZmrAhU2/+W5IO5hEpo3/bCS9PXIY5xb41Lmp2ZO8dXKtyD66Chchy0W129n8vPl2GIruOdrxsjZAHnneyAb9jm0uaGaphwnEnuecX/qgHY6ZMtayvLLsPst8PO6R1vufMy8WqjK+j7LnC1krL7CPDg0NEhyQTmw5l+NCNjSlvB1juM9V4PARg0bYCOkGXm7ydRCjSSH8CJXZpwnd5cBB5WKAX3KPzutRgMi/LFwNSMZzFuUyXaYOZPpD259yqph1LmGqegEdDriACVU+dVEONFMm8eIuBofe7ljmsAFKW9BINwK0CAwEAAQ==",
];
let mojangTried = 0;

async function getMojangKeys(db) {
  if (mojangKeys && Date.now() - mojangKeysAt < 3600_000) return mojangKeys;
  const list = new Set(PINNED_MOJANG_KEYS);
  if (db) {
    try {
      const saved = await one(db, "SELECT v FROM meta WHERE k = 'mojangKeys'");
      if (saved && saved.v) for (const k of JSON.parse(saved.v)) if (typeof k === "string") list.add(k);
    } catch (e) {}
  }
  if (Date.now() - mojangTried > 6 * 3600_000) { // a quick, one-shot look at the live list (usually refused)
    mojangTried = Date.now();
    try {
      const r = await mojangFetch("https://api.minecraftservices.com/publickeys", 1);
      if (r.status === 200) {
        const live = ((await r.json()).playerCertificateKeys || []).map((k) => k && k.publicKey).filter((k) => typeof k === "string");
        const extra = live.filter((k) => !list.has(k));
        for (const k of live) list.add(k);
        if (db && extra.length) try { await run(db, "INSERT INTO meta (k, v) VALUES ('mojangKeys', ?1) ON CONFLICT(k) DO UPDATE SET v = ?1", JSON.stringify(live)); } catch (e) {}
      }
    } catch (e) {}
  }
  const keys = [];
  for (const k of list) {
    try { keys.push((await importMojangKeys([k]))[0]); } catch (e) {}
  }
  if (!keys.length) throw new MojangDown("couldn't load Mojang's keys");
  mojangKeys = keys;
  mojangKeysAt = Date.now();
  return mojangKeys;
}

class MojangDown extends Error {}

async function issueToken(env, id, name) {
  const token = randomHex(32);
  await run(env.DB, "INSERT INTO tokens (token, id, name, exp) VALUES (?, ?, ?, ?)", token, id, name, Date.now() + TOKEN_TTL);
  await migrate(env, id);
  return token;
}

// Mojang name -> id (for "add friend by name")
async function idForName(name) {
  const r = await mojangFetch("https://api.mojang.com/users/profiles/minecraft/" + encodeURIComponent(name), 1);
  if (r.status !== 200) return null;
  const p = await r.json();
  return p && isId(p.id) ? { id: p.id, name: p.name } : null;
}

async function readJson(req, limit) {
  const text = await req.text();
  if (text.length > limit) throw new BadRequest("too big");
  try {
    return JSON.parse(text || "{}");
  } catch (e) {
    throw new BadRequest("not JSON");
  }
}

class BadRequest extends Error {}

// Returns {id, name} for a valid login token, or null.
async function who(req, env) {
  const h = req.headers.get("authorization") || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  const v = await one(env.DB, "SELECT id, name FROM tokens WHERE token = ? AND exp > ?", token, Date.now());
  return v && isId(v.id) ? { id: v.id, name: isName(v.name) ? v.name : "" } : null;
}

// ------------------------------------------------------------------ the things players do

async function push(db, to, type, from, name, data = null, at = Date.now()) {
  return run(db, "INSERT INTO inbox (t, type, f, name, data, at) VALUES (?, ?, ?, ?, ?, ?)", to, type, from, name, data ? JSON.stringify(data) : null, at);
}

const isFriend = async (db, a, b) => !!(await one(db, "SELECT 1 AS x FROM friends WHERE a = ? AND b = ?", a, b));
const usesMod = async (db, id) => !!(await one(db, "SELECT 1 AS x FROM looks WHERE id = ?", id));

// A one-off gate ("you can do this again after ..."): returns false if it's still shut.
async function gate(db, key, ms) {
  const now = Date.now();
  const r = await run(db, "INSERT INTO gates (k, until) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET until = ?2 WHERE until < ?3", key, now + ms, now);
  return (r.meta && r.meta.changes) > 0;
}

async function saveLook(db, me, look) {
  await run(db, "INSERT INTO looks (id, name, look, seen) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(id) DO UPDATE SET name = ?2, look = ?3, seen = ?4",
    me.id, me.name, JSON.stringify(look), Date.now());
}

function lookOut(row) {
  try {
    return { ...JSON.parse(row.look), seen: row.seen, name: row.name || "" };
  } catch (e) {
    return null;
  }
}

async function looksFor(db, ids) {
  const out = {};
  ids = [...new Set(ids.filter(isId))].slice(0, 50);
  if (!ids.length) return out;
  const rows = await all(db, "SELECT id, name, look, seen FROM looks WHERE id IN (" + ids.map(() => "?").join(",") + ")", ...ids);
  for (const r of rows) {
    const l = lookOut(r);
    if (l) out[r.id] = l;
  }
  return out;
}

async function emote(db, me, e, c) {
  if (!EMOTES.includes(e)) return [400, { error: "bad emote" }];
  const now = Date.now();
  const r = await run(db, "INSERT INTO emotes (id, e, c, at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(id) DO UPDATE SET e = ?2, c = ?3, at = ?4 WHERE at < ?5",
    me.id, e, Number.isInteger(c) ? c & 0xffffff : 0xff2846, now, now - 2000);
  if (!(r.meta && r.meta.changes)) return [429, { error: "slow down" }];
  return [200, { ok: true }];
}

async function emotesNear(db, ids) {
  const out = {};
  const want = new Set(ids.filter(isId));
  if (!want.size) return out;
  for (const r of await all(db, "SELECT id, e, c, at FROM emotes WHERE at > ?", Date.now() - EMOTE_FRESH))
    if (want.has(r.id)) out[r.id] = { e: r.e, c: r.c, at: r.at };
  return out;
}

async function friendList(db, id) {
  const rows = await all(db, "SELECT f.b AS id, f.name AS name, l.name AS lname, l.seen AS seen, p.server AS server, p.at AS pat " +
    "FROM friends f LEFT JOIN looks l ON l.id = f.b LEFT JOIN presence p ON p.id = f.b WHERE f.a = ? LIMIT ?", id, MAX_FRIENDS);
  const now = Date.now();
  return rows.map((r) => {
    const f = { id: r.id, name: isName(r.lname) ? r.lname : isName(r.name) ? r.name : "" };
    if (r.seen) f.seen = r.seen;
    if (r.server && isServer(r.server) && now - r.pat < PRESENCE_FRESH) f.server = r.server;
    return f;
  });
}

async function groupList(db, id) {
  const gids = (await all(db, "SELECT gid FROM members WHERE id = ? LIMIT ?", id, MAX_GROUPS * 2)).map((r) => r.gid);
  if (!gids.length) return [];
  const q = gids.map(() => "?").join(",");
  const chats = await all(db, "SELECT gid, name FROM chats WHERE gid IN (" + q + ")", ...gids);
  const mem = await all(db, "SELECT gid, id, name FROM members WHERE gid IN (" + q + ")", ...gids);
  return chats.map((c) => ({ id: c.gid, name: c.name, members: mem.filter((m) => m.gid === c.gid).map((m) => ({ id: m.id, name: m.name || "?" })) }));
}

function event(r) {
  const e = { seq: r.seq, type: r.type, from: r.f, name: r.name || "", at: r.at };
  if (r.data) try { Object.assign(e, JSON.parse(r.data)); } catch (x) { /* ignore */ }
  return e;
}

async function setPresence(db, id, server) {
  server = typeof server === "string" ? server.toLowerCase() : "";
  if (server === "") await run(db, "DELETE FROM presence WHERE id = ?", id);
  else if (isServer(server)) await run(db, "INSERT INTO presence (id, server, at) VALUES (?1, ?2, ?3) ON CONFLICT(id) DO UPDATE SET server = ?2, at = ?3", id, server, Date.now());
  else return false;
  return true;
}

async function friendRequest(env, me, b) {
  const db = env.DB;
  let to = isId(b.to) ? b.to : null, toName = "";
  if (!to && isName(b.name)) {
    const known = await one(db, "SELECT id, name FROM looks WHERE name = ? COLLATE NOCASE ORDER BY seen DESC", b.name);
    const p = known ? { id: known.id, name: known.name } : await idForName(b.name);
    if (!p) return [404, { error: "no Minecraft player with that name", why: "noplayer" }];
    to = p.id;
    toName = p.name;
  }
  if (!to || to === me.id) return [400, { error: "bad player" }];
  if (!(await usesMod(db, to))) return [404, { error: "they don't use the mod (or haven't connected yet)", why: "nomod" }];
  if (await isFriend(db, me.id, to)) return [409, { error: "already friends" }];
  const theirs = await one(db, "SELECT name FROM looks WHERE id = ?", to);
  const name = toName || (theirs && theirs.name) || "";
  // they already asked you: that's a yes from both of you
  if (await one(db, "SELECT 1 AS x FROM requests WHERE f = ? AND t = ?", to, me.id)) {
    await db.batch([
      db.prepare("DELETE FROM requests WHERE (f = ?1 AND t = ?2) OR (f = ?2 AND t = ?1)").bind(to, me.id),
      db.prepare("INSERT OR REPLACE INTO friends (a, b, name) VALUES (?, ?, ?)").bind(me.id, to, name),
      db.prepare("INSERT OR REPLACE INTO friends (a, b, name) VALUES (?, ?, ?)").bind(to, me.id, me.name),
      db.prepare("INSERT INTO inbox (t, type, f, name, at) VALUES (?, 'accepted', ?, ?, ?)").bind(to, me.id, me.name, Date.now()),
    ]);
    return [200, { ok: true, friends: true, id: to, name }];
  }
  const r = await run(db, "INSERT OR IGNORE INTO requests (f, t, at) VALUES (?, ?, ?)", me.id, to, Date.now());
  if (!(r.meta && r.meta.changes)) return [429, { error: "already sent" }];
  await push(db, to, "request", me.id, me.name);
  return [200, { ok: true, friends: false, id: to, name }];
}

async function friendRespond(env, me, b) {
  const db = env.DB;
  if (!isId(b.from)) return [400, { error: "bad player" }];
  const r = await run(db, "DELETE FROM requests WHERE f = ? AND t = ?", b.from, me.id);
  if (!(r.meta && r.meta.changes)) return [404, { error: "no request from them" }];
  const accept = b.accept === true;
  const stmts = [db.prepare("INSERT INTO inbox (t, type, f, name, at) VALUES (?, ?, ?, ?, ?)").bind(b.from, accept ? "accepted" : "declined", me.id, me.name, Date.now())];
  if (accept) {
    const theirs = await one(db, "SELECT name FROM looks WHERE id = ?", b.from);
    stmts.push(db.prepare("INSERT OR REPLACE INTO friends (a, b, name) VALUES (?, ?, ?)").bind(me.id, b.from, (theirs && theirs.name) || ""));
    stmts.push(db.prepare("INSERT OR REPLACE INTO friends (a, b, name) VALUES (?, ?, ?)").bind(b.from, me.id, me.name));
    stmts.push(db.prepare("DELETE FROM requests WHERE f = ? AND t = ?").bind(me.id, b.from));
  }
  await db.batch(stmts);
  return [200, { ok: true }];
}

async function message(env, me, b) {
  const db = env.DB;
  if (!isId(b.to) || typeof b.text !== "string") return [400, { error: "bad message" }];
  const text = cleanText(b.text, MAX_MESSAGE);
  if (!text) return [400, { error: "empty message" }];
  if (!(await isFriend(db, me.id, b.to))) return [403, { error: "you can only message friends (send a friend request first)" }];
  const recent = await one(db, "SELECT COUNT(*) AS n FROM inbox WHERE t = ? AND f = ? AND type = 'message' AND at > ?", b.to, me.id, Date.now() - 60_000);
  if (recent && recent.n >= 20) return [429, { error: "slow down" }];
  await push(db, b.to, "message", me.id, me.name, { text });
  return [200, { ok: true, text }];
}

// An outfit for a friend: only friends, at most 10 an hour, kept small. The mod checks the outfit itself when it arrives.
async function gift(env, me, b) {
  const db = env.DB;
  if (!isId(b.to) || b.to === me.id) return [400, { error: "bad friend" }];
  if (typeof b.data !== "string" || b.data.length > 14000) return [400, { error: "outfit too big" }];
  try { if (typeof JSON.parse(b.data) !== "object") throw 0; } catch (e) { return [400, { error: "bad outfit" }]; }
  if (!(await isFriend(db, me.id, b.to))) return [403, { error: "you can only send outfits to friends" }];
  const recent = await one(db, "SELECT COUNT(*) AS n FROM inbox WHERE t = ? AND f = ? AND type = 'gift' AND at > ?", b.to, me.id, Date.now() - 3600_000);
  if (recent && recent.n >= 10) return [429, { error: "slow down" }];
  await push(db, b.to, "gift", me.id, me.name, { gname: cleanText(b.name, 20) || "Outfit", data: b.data });
  return [200, { ok: true }];
}

async function ping(env, me, b) {
  const db = env.DB;
  if (!isId(b.to) || b.to === me.id) return [400, { error: "bad friend" }];
  if (!(await usesMod(db, b.to))) return [404, { error: "not on this server" }];
  if (!(await gate(db, "ping:" + me.id + ":" + b.to, PING_GAP))) return [429, { error: "slow down" }];
  await push(db, b.to, "ping", me.id, me.name);
  return [200, { ok: true }];
}

async function groupCreate(env, me, b) {
  const db = env.DB;
  const name = cleanText(b.name, 24) || "Group";
  const ids = Array.isArray(b.members) ? [...new Set(b.members.filter((m) => isId(m) && m !== me.id))] : [];
  if (ids.length < 1 || ids.length > MAX_GROUP - 1) return [400, { error: "pick 1 to " + (MAX_GROUP - 1) + " friends" }];
  const friends = await all(db, "SELECT b, name FROM friends WHERE a = ? AND b IN (" + ids.map(() => "?").join(",") + ")", me.id, ...ids);
  if (friends.length !== ids.length) return [403, { error: "you can only add friends" }];
  const mine = await one(db, "SELECT COUNT(*) AS n FROM members WHERE id = ?", me.id);
  if (mine && mine.n >= MAX_GROUPS) return [429, { error: "too many groups" }];
  const names = { [me.id]: me.name };
  for (const f of friends) {
    const l = await one(db, "SELECT name FROM looks WHERE id = ?", f.b);
    names[f.b] = (l && l.name) || f.name || "?";
  }
  const gid = randomHex(8), now = Date.now();
  const view = { id: gid, name, members: [me.id, ...ids].map((m) => ({ id: m, name: names[m] || "?" })) };
  await db.batch([
    db.prepare("INSERT INTO chats (gid, name, at) VALUES (?, ?, ?)").bind(gid, name, now),
    ...view.members.map((m) => db.prepare("INSERT INTO members (gid, id, name) VALUES (?, ?, ?)").bind(gid, m.id, m.name)),
    ...ids.map((m) => db.prepare("INSERT INTO inbox (t, type, f, name, data, at) VALUES (?, 'group', ?, ?, ?, ?)").bind(m, me.id, me.name, JSON.stringify({ group: view }), now)),
  ]);
  return [200, { ok: true, group: view }];
}

async function groupMessage(env, me, b) {
  const db = env.DB;
  if (!isGid(b.gid)) return [400, { error: "bad group" }];
  const group = await one(db, "SELECT name FROM chats WHERE gid = ?", b.gid);
  if (!group) return [404, { error: "no such group" }];
  const members = (await all(db, "SELECT id FROM members WHERE gid = ?", b.gid)).map((r) => r.id);
  if (!members.includes(me.id)) return [403, { error: "you're not in this group" }];
  const text = cleanText(b.text, MAX_MESSAGE);
  if (!text) return [400, { error: "empty message" }];
  const others = members.filter((m) => m !== me.id);
  if (others.length) {
    const recent = await one(db, "SELECT COUNT(*) AS n FROM inbox WHERE t = ? AND f = ? AND type = 'gmsg' AND at > ?", others[0], me.id, Date.now() - 60_000);
    if (recent && recent.n >= 20) return [429, { error: "slow down" }];
  }
  const at = Date.now();
  const data = JSON.stringify({ gid: b.gid, gname: group.name, text });
  if (others.length) await db.batch(others.map((m) => db.prepare("INSERT INTO inbox (t, type, f, name, data, at) VALUES (?, 'gmsg', ?, ?, ?, ?)").bind(m, me.id, me.name, data, at)));
  return [200, { ok: true, text }];
}

async function groupLeave(env, me, b) {
  const db = env.DB;
  if (!isGid(b.gid)) return [400, { error: "bad group" }];
  const r = await run(db, "DELETE FROM members WHERE gid = ? AND id = ?", b.gid, me.id);
  if (!(r.meta && r.meta.changes)) return [200, { ok: true }];
  const left = (await all(db, "SELECT id FROM members WHERE gid = ?", b.gid)).map((x) => x.id);
  if (!left.length) await run(db, "DELETE FROM chats WHERE gid = ?", b.gid);
  else await db.batch(left.map((m) => db.prepare("INSERT INTO inbox (t, type, f, name, data, at) VALUES (?, 'gleave', ?, ?, ?, ?)").bind(m, me.id, me.name, JSON.stringify({ gid: b.gid }), Date.now())));
  return [200, { ok: true }];
}

async function unfriend(env, me, b) {
  if (!isId(b.id)) return [400, { error: "bad player" }];
  await run(env.DB, "DELETE FROM friends WHERE (a = ?1 AND b = ?2) OR (a = ?2 AND b = ?1)", me.id, b.id);
  return [200, { ok: true }];
}

// Everything the mod needs in one go (v3.9+): POST /v2/sync
// {look?, server?, emote?, want:[ids whose looks you need], near:[ids near you, for emotes], friends:bool, since:seq}
async function sync(env, me, b) {
  const db = env.DB;
  const now = Date.now();
  const out = { ok: true, version: VERSION, now, me: { id: me.id, name: me.name } };
  if (b.look !== undefined) {
    const look = cleanLook(b.look);
    if (look) await saveLook(db, me, look);
  } else {
    // keeps you "online" for your friends (at most one save a minute)
    await run(db, "UPDATE looks SET seen = ?1 WHERE id = ?2 AND seen < ?3", now, me.id, now - SEEN_EVERY);
  }
  if (typeof b.server === "string") await setPresence(db, me.id, b.server);
  if (b.emote && typeof b.emote === "object") out.emote = (await emote(db, me, b.emote.e, b.emote.c))[0];
  const want = Array.isArray(b.want) ? b.want.filter(isId).slice(0, 50) : [];
  if (want.length) out.looks = await looksFor(db, want);
  const near = Array.isArray(b.near) ? b.near.filter(isId).slice(0, 60) : [];
  if (near.length) out.emotes = await emotesNear(db, near);
  if (b.friends === true) {
    out.friends = await friendList(db, me.id);
    const ids = out.friends.map((f) => f.id);
    out.friendLooks = await looksFor(db, ids);
    out.groups = await groupList(db, me.id);
    out.requests = (await all(db, "SELECT r.f AS id, l.name AS name, r.at AS at FROM requests r LEFT JOIN looks l ON l.id = r.f WHERE r.t = ? ORDER BY r.at", me.id))
      .map((r) => ({ id: r.id, name: r.name || "", at: r.at }));
  }
  const since = Number.isFinite(b.since) ? b.since : 0;
  const rows = await all(db, "SELECT seq, type, f, name, data, at FROM inbox WHERE t = ? AND seq > ? AND at > ? ORDER BY seq LIMIT 100", me.id, since, now - INBOX_TTL);
  out.events = rows.map(event);
  out.cursor = rows.length ? rows[rows.length - 1].seq : since;
  return [200, out];
}

// ------------------------------------------------------------------ routing

async function handle(req, env, url) {
  const path = url.pathname;
  const db = env.DB;
  if (path === "/" || path === "") {
    const status = { ok: true, service: "NotSoTylerr Design cosmetics", version: VERSION, db: !!db };
    if (db) {
      try {
        await setup(db);
        await one(db, "SELECT 1 AS x");
        status.dbOk = true;
      } catch (e) {
        status.dbOk = false;
        status.error = explain(e);
      }
    } else status.error = "No database: add a D1 database binding called DB to this worker (see SETUP.md).";
    return json(status);
  }
  if (!db) return json({ error: "This worker has no database yet. Add a D1 database binding called DB (see SETUP.md), then Deploy.", why: "nodb" }, 503);
  await setup(db);
  if (Math.random() < 0.02) await cleanup(db);

  // 1) one-time code for the Mojang check
  if (path === "/v1/auth/start" && req.method === "POST") {
    const b = await readJson(req, 500);
    if (!isId(b.uuid) || !isName(b.name)) return json({ error: "bad player" }, 400);
    const serverId = randomHex(10);
    await run(db, "INSERT INTO pending (sid, uuid, name, exp) VALUES (?, ?, ?, ?)", serverId, b.uuid, b.name, Date.now() + 300_000);
    return json({ serverId });
  }

  const takePending = async (sid) => {
    const p = await one(db, "SELECT uuid, name FROM pending WHERE sid = ? AND exp > ?", sid, Date.now());
    if (p) await run(db, "DELETE FROM pending WHERE sid = ?", sid);
    return p;
  };

  // 2) ask Mojang whether that player really "joined" our code, then hand out a token
  if (path === "/v1/auth/finish" && req.method === "POST") {
    const b = await readJson(req, 500);
    if (typeof b.serverId !== "string" || !/^[0-9a-f]{20}$/.test(b.serverId)) return json({ error: "bad code" }, 400);
    const pending = await takePending(b.serverId);
    if (!pending) return json({ error: "code expired" }, 403);
    const r = await mojangFetch("https://sessionserver.mojang.com/session/minecraft/hasJoined?username=" +
      encodeURIComponent(pending.name) + "&serverId=" + encodeURIComponent(b.serverId), 1);
    if (r.status === 204 || r.status === 403 || r.status === 404) return json({ error: "Mojang couldn't confirm you" }, 403);
    if (r.status !== 200) return json({ error: "Mojang didn't answer (HTTP " + r.status + "), try again in a minute", why: "mojangdown" }, 503);
    const profile = await r.json();
    if (!profile || profile.id !== pending.uuid) return json({ error: "wrong player" }, 403);
    return json({ token: await issueToken(env, profile.id, profile.name), name: profile.name });
  }

  // 2b) the newer login: Mojang-signed player key + a signature on the one-time code
  if (path === "/v1/auth/key" && req.method === "POST") {
    const b = await readJson(req, 8000);
    if (typeof b.serverId !== "string" || !/^[0-9a-f]{20}$/.test(b.serverId)) return json({ error: "bad code" }, 400);
    if (typeof b.publicKey !== "string" || typeof b.keySignature !== "string" || typeof b.signature !== "string" || !Number.isFinite(b.expiresAt))
      return json({ error: "missing proof" }, 400);
    const pending = await takePending(b.serverId);
    if (!pending) return json({ error: "code expired" }, 403);
    if (b.expiresAt < Date.now()) return json({ error: "your game key expired, restart the game" }, 403);
    const pub = b64(b.publicKey);
    // what Mojang signed: uuid (16 bytes) + expiry (8 bytes) + the key
    const data = new Uint8Array(24 + pub.length);
    const view = new DataView(data.buffer);
    view.setBigUint64(0, BigInt("0x" + pending.uuid.slice(0, 16)));
    view.setBigUint64(8, BigInt("0x" + pending.uuid.slice(16)));
    view.setBigUint64(16, BigInt(Math.trunc(b.expiresAt)));
    data.set(pub, 24);
    const keySig = b64(b.keySignature);
    let mojangOk = false;
    let keys;
    try {
      keys = await getMojangKeys(db);
    } catch (e) {
      if (!(e instanceof MojangDown)) throw e;
      // put the code back so the game can try the other login (the "join a server" check) with it
      await run(db, "INSERT OR REPLACE INTO pending (sid, uuid, name, exp) VALUES (?, ?, ?, ?)", b.serverId, pending.uuid, pending.name, Date.now() + 120_000);
      return json({ error: e.message, why: "mojangkeys" }, 503);
    }
    for (const k of keys) {
      if (await crypto.subtle.verify("RSASSA-PKCS1-v1_5", k, keySig, data)) { mojangOk = true; break; }
    }
    if (!mojangOk) return json({ error: "Mojang didn't sign that key" }, 403);
    const playerKey = await crypto.subtle.importKey("spki", pub, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const msg = new TextEncoder().encode("nst-cosmetics login " + b.serverId + " " + pending.uuid);
    if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", playerKey, b64(b.signature), msg))) return json({ error: "bad signature" }, 403);
    // the real name for that account (so nobody can pick someone else's name)
    let name = pending.name;
    const pr = await mojangFetch("https://sessionserver.mojang.com/session/minecraft/profile/" + pending.uuid, 1);
    if (pr.status === 200) { const prof = await pr.json(); if (prof && isName(prof.name)) name = prof.name; }
    return json({ token: await issueToken(env, pending.uuid, name), name });
  }

  // everyone's looks: GET /v1/looks?u=id1,id2,... (up to 50; no login needed)
  if (path === "/v1/looks" && req.method === "GET") {
    const out = await looksFor(db, (url.searchParams.get("u") || "").split(","));
    out._now = Date.now();
    return json(out);
  }
  if (path === "/v1/emotes" && req.method === "GET") {
    const out = await emotesNear(db, (url.searchParams.get("u") || "").split(",").slice(0, 20));
    out._now = Date.now();
    return json(out);
  }

  // ---- everything below needs a login
  const me = await who(req, env);
  if (!me) return json({ error: "log in again" }, 401);
  const routes = {
    "POST /v2/sync": (b) => sync(env, me, b),
    "PUT /v1/look": async (b) => {
      const look = cleanLook(b.look);
      if (!look) return [400, { error: "bad look" }];
      await saveLook(db, me, look);
      return [200, { ok: true }];
    },
    "DELETE /v1/look": async () => {
      await run(db, "DELETE FROM looks WHERE id = ?", me.id);
      return [200, { ok: true }];
    },
    "POST /v1/emote": (b) => emote(db, me, b.e, b.c),
    "POST /v1/ping": (b) => ping(env, me, b),
    "GET /v1/inbox": async () => {
      const since = Number(url.searchParams.get("since") || 0);
      const rows = await all(db, "SELECT seq, type, f, name, data, at FROM inbox WHERE t = ? AND at > ? ORDER BY seq DESC LIMIT 60", me.id, Math.max(since, Date.now() - INBOX_TTL));
      const events = rows.reverse().map(event);
      return [200, { now: Date.now(), events, pings: events.filter((e) => e.type === "ping") }];
    },
    "POST /v1/friend/request": (b) => friendRequest(env, me, b),
    "POST /v1/friend/respond": (b) => friendRespond(env, me, b),
    "POST /v1/friend/remove": (b) => unfriend(env, me, b),
    "GET /v1/friends": async () => [200, { friends: await friendList(db, me.id) }],
    "POST /v1/presence": async (b) => (await setPresence(db, me.id, b.server)) ? [200, { ok: true }] : [400, { error: "bad server" }],
    "POST /v1/group/create": (b) => groupCreate(env, me, b),
    "POST /v1/group/message": (b) => groupMessage(env, me, b),
    "POST /v1/group/leave": (b) => groupLeave(env, me, b),
    "GET /v1/groups": async () => [200, { groups: await groupList(db, me.id) }],
    "POST /v1/message": (b) => message(env, me, b),
    "POST /v1/gift": (b) => gift(env, me, b),
  };
  const route = routes[req.method + " " + path];
  if (!route) return json({ error: "not found" }, 404);
  const body = req.method === "GET" || req.method === "DELETE" ? {} : await readJson(req, path === "/v2/sync" ? MAX_LOOK_BYTES + 4000 : path === "/v1/look" ? MAX_LOOK_BYTES : path === "/v1/gift" ? 16000 : 2000);
  const [status, data] = await route(body);
  return json(data, status);
}

// A readable reason for a database problem.
function explain(e) {
  const m = String((e && e.message) || e);
  if (/exceeded|limit/i.test(m)) return "Your Cloudflare account hit today's free database limit. It resets at midnight UTC.";
  if (/no such table|D1_ERROR/i.test(m)) return "Database error: " + m.slice(0, 160);
  return m.slice(0, 200);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    try {
      return await handle(req, env, url);
    } catch (e) {
      if (e instanceof BadRequest) return json({ error: "bad request: " + e.message }, 400);
      const why = explain(e);
      return json({ error: why, why: /free database limit/.test(why) ? "limit" : "server" }, /free database limit/.test(why) ? 503 : 500);
    }
  },
};
