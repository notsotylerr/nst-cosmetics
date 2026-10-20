// NotSoTylerr Design - cosmetics server (Cloudflare Worker, free plan is plenty).
// Stores each player's cosmetics (cape, wings, hat, aura, trail, name colour, pet) so everyone with the mod can
// see them, shows which friends are online, and passes on friend pings.
//
// Setup (once, ~10 minutes, all in the Cloudflare dashboard):
//  1. Workers & Pages -> Create -> Create Worker -> name it "nst-cosmetics" -> Deploy.
//  2. Edit code -> replace everything with this file -> Deploy.
//  3. Storage & Databases -> KV -> Create namespace "nst-cosmetics".
//  4. Your worker -> Settings -> Bindings -> Add -> KV namespace: variable name NST, namespace nst-cosmetics -> Deploy.
//  5. Copy the worker's link (https://nst-cosmetics.<you>.workers.dev) and paste it in the mod:
//     Friends tab -> Online sync -> Paste link.
//
// How login works: the mod asks for a one-time code, tells Mojang "I'm joining <code>" (exactly what the game does
// when you join a server), and this server asks Mojang to confirm. No passwords or game tokens ever come here.

const MAX_LOOK_BYTES = 8000;
const TOKEN_TTL = 60 * 60 * 24 * 30; // 30 days
const LOOK_TTL = 60 * 60 * 24 * 60; // forget players who haven't played for 60 days

const PATTERNS = ["SOLID", "GRADIENT", "STRIPES", "CHEVRON", "SPLIT", "CHECKER", "DIAGONAL", "LIGHTNING", "CROSS", "LOGO"];
const WINGS = ["ANGEL", "DEMON", "BUTTERFLY", "DRAGON", "FAIRY", "CUSTOM"];
const HATS = ["NONE", "HALO", "CROWN", "HORNS", "CAT_EARS", "BUNNY_EARS", "TOP_HAT", "WIZARD"];
const AURAS = ["NONE", "FLAMES", "SPARKLES", "ORBIT", "SNOW", "VOID"];
const TRAILS = ["NONE", "SPARKLE", "FLAME", "HEARTS", "NOTES", "RAINBOW", "PIXELS"];
const NAMES = ["OFF", "SOLID", "GRADIENT", "RAINBOW", "WAVE", "PULSE"];
const PETS = ["NONE", "GHOST", "DRAGON", "SLIME", "BAT", "FAIRY"];
const PING_GAP = 60; // seconds between pings to the same friend
// Mojang turns away requests that don't say who they are, and Workers don't send a User-Agent on their own.
const MOJANG_HEADERS = { "user-agent": "NotSoTylerr-Design-Cosmetics/1.0 (+https://github.com/notsotylerr/nst-cosmetics)", accept: "application/json" };

function hasJoined(name, serverId) {
  return fetch("https://sessionserver.mojang.com/session/minecraft/hasJoined?username=" +
    encodeURIComponent(name) + "&serverId=" + encodeURIComponent(serverId), { headers: MOJANG_HEADERS });
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...extra } });
}

function hex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomHex(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return hex(b);
}

const isId = (s) => typeof s === "string" && /^[0-9a-f]{32}$/.test(s);
const isName = (s) => typeof s === "string" && /^[A-Za-z0-9_]{1,16}$/.test(s);

// Only keep fields we know, with safe types and ranges: this data is shown on other people's screens.
function cleanLook(l) {
  if (!l || typeof l !== "object") return null;
  const int = (v, d) => (Number.isInteger(v) ? v & 0xffffff : d);
  const num = (v, d, lo, hi) => (typeof v === "number" && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  const px = (s, n) => (typeof s === "string" && s.length === n * 6 && /^[0-9a-f-]+$/.test(s) ? s : "-".repeat(n * 6));
  return {
    cape: l.cape === true,
    capePattern: PATTERNS.includes(l.capePattern) ? l.capePattern : "GRADIENT",
    capePrimary: int(l.capePrimary, 0xff2846),
    capeSecondary: int(l.capeSecondary, 0xb026ff),
    capeRim: int(l.capeRim, 0x16121f),
    capeAnimated: l.capeAnimated === true,
    capePixels: px(l.capePixels, 160),
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
    trail: TRAILS.includes(l.trail) ? l.trail : "NONE",
    trailColour: int(l.trailColour, 0xff2bd6),
    nameStyle: NAMES.includes(l.nameStyle) ? l.nameStyle : "OFF",
    nameColour: int(l.nameColour, 0xff2846),
    nameColour2: int(l.nameColour2, 0xb026ff),
    nameBold: l.nameBold === true,
    pet: PETS.includes(l.pet) ? l.pet : "NONE",
    petColour: int(l.petColour, 0xe8e8ff),
    petColour2: int(l.petColour2, 0xb026ff),
  };
}

async function readJson(req, limit) {
  const text = await req.text();
  if (text.length > limit) throw new Error("too big");
  return JSON.parse(text);
}

// Returns {id, name} for a valid token, or null.
async function who(req, env) {
  const h = req.headers.get("authorization") || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  const v = await env.NST.get("t:" + token);
  if (!v) return null;
  const [id, name] = v.split(":");
  return isId(id) ? { id, name: isName(name) ? name : "" } : null;
}

async function authed(req, env) {
  const w = await who(req, env);
  return w ? w.id : null;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;
    try {
      if (path === "/" || path === "") return json({ ok: true, service: "NotSoTylerr Design cosmetics" });

      // Can this server talk to Mojang? 204 means yes (that made-up code was never joined).
      if (path === "/v1/check/mojang") {
        const r = await hasJoined("Notch", "0".repeat(20));
        return json({ mojangStatus: r.status, ok: r.status === 204 || r.status === 200 });
      }

      // 1) one-time code for the Mojang check
      if (path === "/v1/auth/start" && req.method === "POST") {
        const b = await readJson(req, 500);
        if (!isId(b.uuid) || !isName(b.name)) return json({ error: "bad player" }, 400);
        const serverId = randomHex(10);
        await env.NST.put("n:" + serverId, JSON.stringify({ uuid: b.uuid, name: b.name }), { expirationTtl: 300 });
        return json({ serverId });
      }

      // 2) ask Mojang whether that player really "joined" our code, then hand out a token
      if (path === "/v1/auth/finish" && req.method === "POST") {
        const b = await readJson(req, 500);
        if (typeof b.serverId !== "string" || !/^[0-9a-f]{20}$/.test(b.serverId)) return json({ error: "bad code" }, 400);
        const pending = await env.NST.get("n:" + b.serverId, "json");
        if (!pending) return json({ error: "code expired" }, 403);
        await env.NST.delete("n:" + b.serverId);
        const r = await hasJoined(pending.name, b.serverId);
        if (r.status !== 200) {
          console.log("hasJoined failed", pending.name, r.status, (await r.text()).slice(0, 300));
          return json({ error: "Mojang couldn't confirm you", mojangStatus: r.status }, 403);
        }
        const profile = await r.json();
        if (!profile || profile.id !== pending.uuid) return json({ error: "wrong player" }, 403);
        const token = randomHex(32);
        await env.NST.put("t:" + token, profile.id + ":" + profile.name, { expirationTtl: TOKEN_TTL });
        return json({ token, name: profile.name });
      }

      // 3) save your look
      if (path === "/v1/look" && req.method === "PUT") {
        const me = await who(req, env);
        if (!me) return json({ error: "log in again" }, 401);
        const b = await readJson(req, MAX_LOOK_BYTES);
        const look = cleanLook(b.look);
        if (!look) return json({ error: "bad look" }, 400);
        // "seen" doubles as online status for the friends list (the mod re-uploads every few minutes while playing)
        await env.NST.put("l:" + me.id, JSON.stringify({ ...look, seen: Date.now(), name: me.name }), { expirationTtl: LOOK_TTL });
        return json({ ok: true });
      }

      if (path === "/v1/look" && req.method === "DELETE") {
        const id = await authed(req, env);
        if (!id) return json({ error: "log in again" }, 401);
        await env.NST.delete("l:" + id);
        return json({ ok: true });
      }

      // 4) everyone's looks: GET /v1/looks?u=id1,id2,... (up to 50)
      if (path === "/v1/looks" && req.method === "GET") {
        const ids = (url.searchParams.get("u") || "").split(",").filter(isId).slice(0, 50);
        const out = { _now: Date.now() };
        await Promise.all(ids.map(async (id) => {
          const v = await env.NST.get("l:" + id, "json");
          if (v) out[id] = v;
        }));
        return json(out, 200, { "cache-control": "public, max-age=30" });
      }

      // 5) ping a friend: POST /v1/ping {to}
      if (path === "/v1/ping" && req.method === "POST") {
        const me = await who(req, env);
        if (!me) return json({ error: "log in again" }, 401);
        const b = await readJson(req, 200);
        if (!isId(b.to) || b.to === me.id) return json({ error: "bad friend" }, 400);
        if (!(await env.NST.get("l:" + b.to))) return json({ error: "not on this server" }, 404);
        const gate = "r:" + me.id + ":" + b.to;
        if (await env.NST.get(gate)) return json({ error: "slow down" }, 429);
        await env.NST.put(gate, "1", { expirationTtl: PING_GAP });
        const box = (await env.NST.get("p:" + b.to, "json")) || [];
        box.push({ from: me.id, name: me.name, at: Date.now() });
        await env.NST.put("p:" + b.to, JSON.stringify(box.slice(-10)), { expirationTtl: 600 });
        return json({ ok: true });
      }

      // 6) your pings: GET /v1/inbox (the mod shows the ones it hasn't shown yet; they expire after 10 minutes)
      if (path === "/v1/inbox" && req.method === "GET") {
        const id = await authed(req, env);
        if (!id) return json({ error: "log in again" }, 401);
        const box = (await env.NST.get("p:" + id, "json")) || [];
        return json({ now: Date.now(), pings: box });
      }

      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: "bad request" }, 400);
    }
  },
};
