/**
 * ShuffleFix — Cloudflare Worker backend (native ES module, zero dependencies, zero storage)
 *
 * ENV (wrangler secrets / vars)
 *   SPOTIFY_CLIENT_ID       (required)  wrangler secret put SPOTIFY_CLIENT_ID
 *   SPOTIFY_REDIRECT_URI    (recommended) must exactly match the URI in the Spotify dashboard
 *   SPOTIFY_CLIENT_SECRET   (optional)  if set, classic code flow is used; if absent, PKCE is used
 *   ALLOWED_ORIGINS         (optional)  comma-separated extra origins, e.g. "https://shufflefix.app"
 *   SUBREQUEST_LIMIT        (optional)  default 50 (Free plan). Raise on a paid plan (up to 1000).
 *   REQUIRE_DELETE_CONFIRM  (optional)  "true" => delete action needs { confirm: true } in the body
 *
 * ROUTES
 *   OPTIONS *               CORS preflight
 *   GET  /api/health        liveness probe
 *   GET  /api/login         -> { ok, url }  (add ?redirect=1 for a 302). Optional query:
 *                              state, code_challenge (PKCE S256), redirect_uri
 *   POST /api/callback      { code, code_verifier?, redirect_uri? } -> tokens
 *   POST /api/refresh       { refresh_token } -> new access token
 *   POST /api/action        Authorization: Bearer <access_token>
 *       { action, playlistId, vibe?, mode?, queueLimit?, titleMatch?, dryRun?, playlistName?, confirm? }
 *       action: "true-shuffle" | "anti-sawa" (alias "unloop") | "dedupe" | "clone" | "delete"
 *       vibe:   "all" | "upbeat" | "chill" | "focus"
 *       mode:   "queue" (default) | "play" (starts playback with the first 100 shuffled tracks, 1 call)
 *       playlistId: Spotify playlist ID, or "liked" for Liked Songs
 *
 * RESPONSE CONTRACT (always JSON)
 *   success: { ok: true,  action, message, stats: {...}, preview?: [...] }
 *   failure: { ok: false, error: "<CODE>", message, ...extra }   (HTTP status reflects the error)
 *   Codes: RATE_LIMITED (+retryAfter), TOKEN_EXPIRED, NO_ACTIVE_DEVICE, PREMIUM_REQUIRED,
 *          EMPTY_POOL, SUBREQUEST_BUDGET_EXHAUSTED, BAD_REQUEST, NOT_FOUND, FORBIDDEN, SPOTIFY_ERROR, INTERNAL
 *
 * FREE-TIER NOTES
 *   - Free Workers allow 50 subrequests (outbound fetches) per invocation. A SubrequestBudget
 *     tracks every Spotify call and degrades gracefully (reports `truncated`) instead of crashing.
 *   - Playlist pages are 100 tracks (Liked Songs: 50), so ~2,000 tracks fit in one invocation for
 *     normal playlists; larger Liked Songs libraries may be reported as truncated.
 */

const SPOTIFY_API = "https://api.spotify.com/v1";
const SPOTIFY_AUTH = "https://accounts.spotify.com/authorize";
const SPOTIFY_TOKEN = "https://accounts.spotify.com/api/token";

// The five requested scopes + the extras the requested features cannot work without:
//  - user-read-recently-played : required by the "Unloop songs" action
//  - user-library-read         : required to read "Liked Songs"
//  - playlist-read-collaborative: collaborative playlists
const SCOPES = [
  "user-read-playback-state",
  "user-modify-playback-state",
  "playlist-read-private",
  "playlist-modify-public",
  "playlist-modify-private",
  "user-read-recently-played",
  "user-library-read",
  "playlist-read-collaborative",
].join(" ");

const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const CONCURRENCY = 4;

// Spotify has been migrating /playlists/{id}/tracks -> /playlists/{id}/items. Try "items" first,
// fall back to "tracks" on 404, and remember the winner for this isolate.
let playlistItemsPath = "items";

/* ----------------------------------------------------------------------------------------- */
/* Errors & budget                                                                           */
/* ----------------------------------------------------------------------------------------- */

class ApiError extends Error {
  constructor(status, code, message, extra = {}, upstream = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
    this.upstream = upstream;
  }
}

class SubrequestBudget {
  constructor(limit) {
    this.limit = Math.max(1, limit - 2); // keep 2 spare for safety
    this.used = 0;
  }
  remaining() { return this.limit - this.used; }
  take() {
    if (this.used >= this.limit) {
      throw new ApiError(422, "SUBREQUEST_BUDGET_EXHAUSTED",
        "Too many Spotify calls needed for one request on the current Worker plan.",
        { used: this.used, limit: this.limit });
    }
    this.used++;
  }
}

/* ----------------------------------------------------------------------------------------- */
/* CORS / response helpers                                                                   */
/* ----------------------------------------------------------------------------------------- */

function isAllowedOrigin(origin, env) {
  if (!origin) return true; // non-browser clients (curl, server-to-server)
  let u;
  try { u = new URL(origin); } catch { return false; }
  if (u.protocol === "https:" && u.hostname.endsWith(".github.io")) return true;
  if (u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) return true;
  const extra = (env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  return extra.includes(origin);
}

function corsHeaders(origin) {
  const h = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Expose-Headers": "Retry-After",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
  if (origin) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

function json(body, status, cors, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...cors,
      ...extraHeaders,
    },
  });
}

function errorResponse(err, cors) {
  if (err instanceof ApiError) {
    const headers = {};
    if (err.code === "RATE_LIMITED" && err.extra.retryAfter != null) {
      headers["Retry-After"] = String(err.extra.retryAfter);
    }
    return json({ ok: false, error: err.code, message: err.message, ...err.extra }, err.status, cors, headers);
  }
  console.error("Unhandled error:", err && err.stack ? err.stack : err);
  return json({ ok: false, error: "INTERNAL", message: "Unexpected server error." }, 500, cors);
}

/* ----------------------------------------------------------------------------------------- */
/* Entry point                                                                               */
/* ----------------------------------------------------------------------------------------- */

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");
    const allowed = isAllowedOrigin(origin, env);
    const cors = allowed ? corsHeaders(origin) : { "Vary": "Origin" };

    if (request.method === "OPTIONS") {
      if (!allowed) return new Response(null, { status: 403, headers: cors });
      return new Response(null, { status: 204, headers: cors });
    }
    if (!allowed) {
      return json({ ok: false, error: "FORBIDDEN", message: "Origin not allowed." }, 403, cors);
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    try {
      if (path === "/api/health" && request.method === "GET") {
        return json({ ok: true, service: "shufflefix", time: new Date().toISOString() }, 200, cors);
      }
      if (path === "/api/login" && request.method === "GET") return handleLogin(url, env, cors);
      if (path === "/api/callback" && request.method === "POST") return await handleCallback(request, env, cors);
      if (path === "/api/refresh" && request.method === "POST") return await handleRefresh(request, env, cors);
      if (path === "/api/action" && request.method === "POST") return await handleAction(request, env, cors);

      if (path.startsWith("/api/")) {
        return json({ ok: false, error: "NOT_FOUND", message: "Unknown route or method." }, 404, cors);
      }
      return json({ ok: false, error: "NOT_FOUND", message: "Not found." }, 404, cors);
    } catch (err) {
      return errorResponse(err, cors);
    }
  },
};

/* ----------------------------------------------------------------------------------------- */
/* Auth                                                                                      */
/* ----------------------------------------------------------------------------------------- */

function requireClientId(env) {
  if (!env.SPOTIFY_CLIENT_ID) {
    throw new ApiError(500, "INTERNAL", "Server is missing SPOTIFY_CLIENT_ID.");
  }
  return env.SPOTIFY_CLIENT_ID;
}

function handleLogin(url, env, cors) {
  const clientId = requireClientId(env);
  const redirectUri = url.searchParams.get("redirect_uri") || env.SPOTIFY_REDIRECT_URI;
  if (!redirectUri) throw new ApiError(400, "BAD_REQUEST", "No redirect_uri configured or supplied.");

  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    scope: SCOPES,
    redirect_uri: redirectUri,
    show_dialog: "false",
  });
  const state = url.searchParams.get("state");
  if (state) params.set("state", state);

  const challenge = url.searchParams.get("code_challenge");
  if (challenge) {
    params.set("code_challenge_method", "S256");
    params.set("code_challenge", challenge);
  }

  const authUrl = `${SPOTIFY_AUTH}?${params.toString()}`;
  if (url.searchParams.get("redirect") === "1") {
    return new Response(null, { status: 302, headers: { Location: authUrl, ...cors, "Cache-Control": "no-store" } });
  }
  return json({ ok: true, url: authUrl, scopes: SCOPES.split(" ") }, 200, cors);
}

async function tokenRequest(env, form) {
  const clientId = requireClientId(env);
  const headers = { "Content-Type": "application/x-www-form-urlencoded" };
  if (env.SPOTIFY_CLIENT_SECRET) {
    headers.Authorization = "Basic " + btoa(`${clientId}:${env.SPOTIFY_CLIENT_SECRET}`);
  } else {
    form.set("client_id", clientId); // PKCE flow
  }

  let res;
  try {
    res = await fetch(SPOTIFY_TOKEN, { method: "POST", headers, body: form.toString() });
  } catch {
    throw new ApiError(502, "SPOTIFY_ERROR", "Could not reach Spotify's token service.");
  }

  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get("Retry-After") || "1", 10) || 1;
    throw new ApiError(429, "RATE_LIMITED", "Spotify is rate limiting us. Please retry shortly.", { retryAfter });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(res.status === 400 ? 400 : 502, "SPOTIFY_ERROR",
      data.error_description || data.error || "Token exchange failed.", { upstreamStatus: res.status });
  }
  return data;
}

async function readJson(request) {
  try { return await request.json(); }
  catch { throw new ApiError(400, "BAD_REQUEST", "Request body must be valid JSON."); }
}

async function handleCallback(request, env, cors) {
  const body = await readJson(request);
  const { code, code_verifier } = body;
  const redirectUri = body.redirect_uri || env.SPOTIFY_REDIRECT_URI;
  if (!code || typeof code !== "string") throw new ApiError(400, "BAD_REQUEST", "Missing authorization code.");
  if (!redirectUri) throw new ApiError(400, "BAD_REQUEST", "Missing redirect_uri.");
  if (!env.SPOTIFY_CLIENT_SECRET && !code_verifier) {
    throw new ApiError(400, "BAD_REQUEST", "Missing code_verifier (PKCE).");
  }

  const form = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
  if (code_verifier) form.set("code_verifier", code_verifier);

  const t = await tokenRequest(env, form);
  return json({
    ok: true,
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expires_in: t.expires_in,
    token_type: t.token_type,
    scope: t.scope,
  }, 200, cors);
}

async function handleRefresh(request, env, cors) {
  const body = await readJson(request);
  if (!body.refresh_token) throw new ApiError(400, "BAD_REQUEST", "Missing refresh_token.");
  const form = new URLSearchParams({ grant_type: "refresh_token", refresh_token: body.refresh_token });
  const t = await tokenRequest(env, form);
  return json({
    ok: true,
    access_token: t.access_token,
    refresh_token: t.refresh_token || body.refresh_token,
    expires_in: t.expires_in,
    scope: t.scope,
  }, 200, cors);
}

/* ----------------------------------------------------------------------------------------- */
/* Spotify HTTP client (budget-aware, 429-aware)                                             */
/* ----------------------------------------------------------------------------------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function spotify(ctx, path, { method = "GET", query, body } = {}) {
  let url = path.startsWith("http") ? path : SPOTIFY_API + path;
  if (query) url += (url.includes("?") ? "&" : "?") + new URLSearchParams(query).toString();

  for (let attempt = 0; attempt < 2; attempt++) {
    ctx.budget.take();
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${ctx.token}`,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new ApiError(502, "SPOTIFY_ERROR", "Could not reach the Spotify API.");
    }

    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get("Retry-After") || "1", 10) || 1;
      // Retry once only for short waits; otherwise surface a clean tag to the frontend.
      if (attempt === 0 && retryAfter <= 2) { await sleep(retryAfter * 1000 + 100); continue; }
      throw new ApiError(429, "RATE_LIMITED",
        `Spotify is rate limiting requests. Try again in ${retryAfter}s.`, { retryAfter });
    }

    const text = await res.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch { data = { raw: text }; } }

    if (res.ok) return data;

    const reason = data?.error?.reason;
    const msg = data?.error?.message || `Spotify returned HTTP ${res.status}.`;

    if (res.status === 401) throw new ApiError(401, "TOKEN_EXPIRED", "Spotify session expired. Please reconnect.", {}, 401);
    if (reason === "NO_ACTIVE_DEVICE" || (res.status === 404 && path.includes("/me/player"))) {
      throw new ApiError(409, "NO_ACTIVE_DEVICE",
        "No active Spotify device. Open Spotify and start playing something, then retry.", {}, res.status);
    }
    if (reason === "PREMIUM_REQUIRED" || /premium/i.test(msg)) {
      throw new ApiError(403, "PREMIUM_REQUIRED", "Spotify Premium is required for playback control.", {}, res.status);
    }
    if (res.status === 404) throw new ApiError(404, "NOT_FOUND", msg, {}, 404);
    if (res.status === 403) throw new ApiError(403, "FORBIDDEN", msg, {}, 403);
    throw new ApiError(res.status >= 500 ? 502 : 400, "SPOTIFY_ERROR", msg, { upstreamStatus: res.status }, res.status);
  }
  throw new ApiError(429, "RATE_LIMITED", "Spotify is rate limiting requests.", { retryAfter: 1 });
}

/* ----------------------------------------------------------------------------------------- */
/* Randomness: Fisher–Yates with an unbiased CSPRNG (rejection sampling)                     */
/* ----------------------------------------------------------------------------------------- */

function makeRng() {
  const pool = new Uint32Array(1024);
  let idx = pool.length;
  const next32 = () => {
    if (idx >= pool.length) { crypto.getRandomValues(pool); idx = 0; }
    return pool[idx++];
  };
  // Uniform integer in [0, n)
  return (n) => {
    const limit = Math.floor(0x100000000 / n) * n;
    let x;
    do { x = next32(); } while (x >= limit);
    return x % n;
  };
}

function fisherYates(array) {
  const a = array.slice();
  const rand = makeRng();
  for (let i = a.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

/* ----------------------------------------------------------------------------------------- */
/* Track loading (full pagination)                                                           */
/* ----------------------------------------------------------------------------------------- */

const PLAYLIST_ID_RE = /^[A-Za-z0-9]{10,40}$/;

function validatePlaylistId(id) {
  if (id === "liked") return id;
  if (typeof id !== "string" || !PLAYLIST_ID_RE.test(id)) {
    throw new ApiError(400, "BAD_REQUEST", "Invalid playlistId.");
  }
  return id;
}

function normalizeItems(items, startOffset) {
  const out = [];
  items.forEach((it, i) => {
    const t = it && (it.track || it.item);
    if (!t || !t.uri) return;
    if (t.type && t.type !== "track") return; // skip podcast episodes
    out.push({
      id: t.id || null,
      uri: t.uri,
      title: t.name || "",
      artist: (t.artists && t.artists[0] && t.artists[0].name) || "",
      artistIds: (t.artists || []).map((a) => a.id).filter(Boolean),
      isLocal: !!t.is_local || t.uri.startsWith("spotify:local:"),
      position: startOffset + i, // original index in the playlist (needed for precise deletes)
    });
  });
  return out;
}

const ITEM_FIELDS =
  "total,items(track(id,uri,name,type,is_local,artists(id,name)),item(id,uri,name,type,is_local,artists(id,name)))";

async function fetchPage(ctx, playlistId, offset) {
  if (playlistId === "liked") {
    const d = await spotify(ctx, "/me/tracks", { query: { limit: "50", offset: String(offset) } });
    return { total: d.total, items: d.items || [], limit: 50 };
  }
  const q = { limit: "100", offset: String(offset), fields: ITEM_FIELDS, additional_types: "track" };
  try {
    const d = await spotify(ctx, `/playlists/${playlistId}/${playlistItemsPath}`, { query: q });
    return { total: d.total, items: d.items || [], limit: 100 };
  } catch (e) {
    if (e instanceof ApiError && e.upstream === 404 && offset === 0) {
      const alt = playlistItemsPath === "items" ? "tracks" : "items";
      const d = await spotify(ctx, `/playlists/${playlistId}/${alt}`, { query: q });
      playlistItemsPath = alt;
      return { total: d.total, items: d.items || [], limit: 100 };
    }
    throw e;
  }
}

/**
 * Pulls the ENTIRE playlist into memory using limit/offset pagination.
 * `reserveFor(total)` tells the loader how many subrequests to leave for later steps; if the
 * budget can't cover every page, it loads as many as it safely can and flags `truncated`.
 */
async function loadAllTracks(ctx, playlistId, reserveFor = () => 0) {
  const first = await fetchPage(ctx, playlistId, 0);
  const total = first.total || 0;
  const limit = first.limit;
  const tracks = normalizeItems(first.items, 0);

  const allOffsets = [];
  for (let o = limit; o < total; o += limit) allOffsets.push(o);

  const room = Math.max(0, ctx.budget.remaining() - reserveFor(total));
  const offsets = allOffsets.slice(0, room);

  for (let i = 0; i < offsets.length; i += CONCURRENCY) {
    const batch = offsets.slice(i, i + CONCURRENCY);
    const pages = await Promise.all(batch.map((o) => fetchPage(ctx, playlistId, o)));
    pages.forEach((p, k) => tracks.push(...normalizeItems(p.items, batch[k])));
  }

  tracks.sort((a, b) => a.position - b.position);
  const scanned = Math.min(total, limit * (1 + offsets.length));
  return { tracks, total, scanned, truncated: scanned < total };
}

/* ----------------------------------------------------------------------------------------- */
/* Vibe filters                                                                              */
/* ----------------------------------------------------------------------------------------- */

const VIBES = new Set(["all", "upbeat", "chill", "focus"]);

// Same thresholds as the frontend's filterByVibe()
function matchesVibeFeatures(f, vibe) {
  if (!f) return false;
  if (vibe === "upbeat") return f.tempo >= 120 && f.energy >= 0.7;
  if (vibe === "chill") return f.tempo <= 100 && f.acousticness >= 0.6;
  if (vibe === "focus") return f.energy <= 0.4 && f.instrumentalness >= 0.7;
  return true;
}

const GENRE_HINTS = {
  upbeat: ["dance", "edm", "house", "techno", "trance", "workout", "hip hop", "rap", "trap", "drill",
    "pop punk", "metal", "hardstyle", "drum and bass", "dubstep", "electro", "party", "k-pop", "reggaeton"],
  chill: ["acoustic", "folk", "singer-songwriter", "lo-fi", "lofi", "chill", "bossa", "soft", "mellow",
    "bedroom pop", "indie folk", "easy listening", "coffeehouse", "sleep"],
  focus: ["ambient", "instrumental", "classical", "piano", "study", "focus", "drone", "post-rock",
    "minimal", "soundtrack", "new age", "neoclassical", "downtempo"],
};

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/**
 * Preferred path: /audio-features (energy, tempo, acousticness, instrumentalness).
 * NOTE: Spotify restricted this endpoint for apps created after 27 Nov 2024 (HTTP 403). When that
 * happens we transparently fall back to an artist-genre heuristic and say so in the response.
 */
async function applyVibeFilter(ctx, tracks, vibe) {
  if (!vibe || vibe === "all") return { tracks, source: null };

  const candidates = tracks.filter((t) => t.id && !t.isLocal);
  const idChunks = chunk([...new Set(candidates.map((t) => t.id))], 100);

  // Probe the first chunk to detect whether audio-features is available to this app.
  let featuresMap = null;
  try {
    featuresMap = new Map();
    for (const ids of idChunks) {
      const d = await spotify(ctx, "/audio-features", { query: { ids: ids.join(",") } });
      (d.audio_features || []).forEach((f) => { if (f && f.id) featuresMap.set(f.id, f); });
    }
  } catch (e) {
    if (e instanceof ApiError && (e.upstream === 403 || e.upstream === 404 || e.code === "FORBIDDEN" || e.code === "NOT_FOUND")) {
      featuresMap = null;
    } else {
      throw e;
    }
  }

  if (featuresMap) {
    return { tracks: candidates.filter((t) => matchesVibeFeatures(featuresMap.get(t.id), vibe)), source: "audio-features" };
  }

  // Genre-heuristic fallback
  const artistIds = [...new Set(candidates.flatMap((t) => t.artistIds.slice(0, 1)))];
  const genres = new Map();
  for (const ids of chunk(artistIds, 50)) {
    const d = await spotify(ctx, "/artists", { query: { ids: ids.join(",") } });
    (d.artists || []).forEach((a) => { if (a) genres.set(a.id, (a.genres || []).join("|").toLowerCase()); });
  }
  const hints = GENRE_HINTS[vibe];
  const kept = candidates.filter((t) => {
    const g = genres.get(t.artistIds[0]) || "";
    return hints.some((h) => g.includes(h));
  });
  return { tracks: kept, source: "genre-heuristic" };
}

/* ----------------------------------------------------------------------------------------- */
/* Recently played (Unloop)                                                                  */
/* ----------------------------------------------------------------------------------------- */

/** Spotify only exposes ~the last 50 plays, so this strips whatever of those fall in the last 7 days. */
async function getRecentTrackIds(ctx) {
  const cutoff = Date.now() - RECENT_WINDOW_MS;
  const d = await spotify(ctx, "/me/player/recently-played", { query: { limit: "50", after: String(cutoff) } });
  const ids = new Set();
  const uris = new Set();
  (d.items || []).forEach((it) => {
    if (!it.track) return;
    if (it.played_at && Date.parse(it.played_at) < cutoff) return;
    if (it.track.id) ids.add(it.track.id);
    if (it.track.uri) uris.add(it.track.uri);
  });
  return { ids, uris };
}

/* ----------------------------------------------------------------------------------------- */
/* Dedupe                                                                                    */
/* ----------------------------------------------------------------------------------------- */

function normalizeTitle(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[\(\[]\s*(feat|ft|with)\b[^\)\]]*[\)\]]/g, " ")
    .replace(/\s[-–]\s*(\d{4}\s*)?(remaster(ed)?|mono|stereo)\b.*$/g, " ")
    .replace(/[\(\[]\s*(\d{4}\s*)?(remaster(ed)?)[^\)\]]*[\)\]]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Keeps the first occurrence, flags the rest.
 * titleMatch: "title-artist" (default; same normalized title + primary artist)
 *             "title"        (aggressive: any identical normalized title)
 *             "off"          (Track-ID / URI duplicates only)
 */
function findDuplicates(tracks, titleMatch) {
  const seenIds = new Set();
  const seenTitles = new Set();
  const dupes = [];
  for (const t of tracks) {
    const idKey = t.id || t.uri;
    const nt = normalizeTitle(t.title);
    const tKey = titleMatch === "title" ? nt : `${nt}::${(t.artist || "").toLowerCase()}`;
    const isDup = seenIds.has(idKey) || (titleMatch !== "off" && nt && seenTitles.has(tKey));
    if (isDup) { dupes.push(t); continue; }
    seenIds.add(idKey);
    if (nt) seenTitles.add(tKey);
  }
  return dupes;
}

/* ----------------------------------------------------------------------------------------- */
/* Playlist writes                                                                           */
/* ----------------------------------------------------------------------------------------- */

async function createPlaylist(ctx, name, description) {
  const body = { name, description, public: false };
  try {
    return await spotify(ctx, "/me/playlists", { method: "POST", body });
  } catch (e) {
    if (e instanceof ApiError && (e.upstream === 404 || e.upstream === 405)) {
      const me = await spotify(ctx, "/me");
      return await spotify(ctx, `/users/${encodeURIComponent(me.id)}/playlists`, { method: "POST", body });
    }
    throw e;
  }
}

async function addTracks(ctx, playlistId, uris) {
  for (const part of chunk(uris, 100)) {
    await spotify(ctx, `/playlists/${playlistId}/${playlistItemsPath}`, { method: "POST", body: { uris: part } });
  }
}

/* ----------------------------------------------------------------------------------------- */
/* Action router                                                                             */
/* ----------------------------------------------------------------------------------------- */

const ACTION_ALIASES = {
  "true-shuffle": "shuffle", shuffle: "shuffle",
  "anti-sawa": "unloop", unloop: "unloop",
  dedupe: "dedupe", declutter: "dedupe",
  clone: "clone",
  delete: "delete",
};

async function handleAction(request, env, cors) {
  const body = await readJson(request);

  const authHeader = request.headers.get("Authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : body.accessToken;
  if (!token) throw new ApiError(401, "TOKEN_EXPIRED", "Missing access token. Please connect Spotify.");

  const action = ACTION_ALIASES[String(body.action || "").toLowerCase()];
  if (!action) throw new ApiError(400, "BAD_REQUEST", "Unknown action.");

  const playlistId = validatePlaylistId(body.playlistId);
  const vibe = body.vibe == null ? null : String(body.vibe).toLowerCase();
  if (vibe && !VIBES.has(vibe)) throw new ApiError(400, "BAD_REQUEST", "Unknown vibe.");

  const limit = parseInt(env.SUBREQUEST_LIMIT || "50", 10) || 50;
  const ctx = { token, budget: new SubrequestBudget(limit) };

  let result;
  switch (action) {
    case "shuffle":
    case "unloop":
      result = await runShuffle(ctx, { playlistId, vibe, unloop: action === "unloop", body });
      break;
    case "clone":
      result = await runClone(ctx, { playlistId, vibe, body });
      break;
    case "dedupe":
      result = await runDedupe(ctx, { playlistId, body });
      break;
    case "delete":
      result = await runDelete(ctx, { playlistId, body, env });
      break;
  }

  result.stats = { ...result.stats, subrequestsUsed: ctx.budget.used };
  return json({ ok: true, action, ...result }, 200, cors);
}

/* ---- A/B/C/D: True Shuffle, full-library fetch, vibe filters, unloop ---- */

async function runShuffle(ctx, { playlistId, vibe, unloop, body }) {
  const mode = body.mode === "play" ? "play" : "queue";
  const queueLimit = Math.min(Math.max(parseInt(body.queueLimit, 10) || 20, 1), 100);
  const hasVibe = vibe && vibe !== "all";

  const reserveFor = (total) =>
    (unloop ? 1 : 0) +
    (hasVibe ? Math.ceil(total / 100) + Math.ceil(total / 100 / 2) + 1 : 0) + // features (+ possible genre fallback)
    (mode === "play" ? 1 : Math.min(queueLimit, 10));

  const loaded = await loadAllTracks(ctx, playlistId, reserveFor);
  let pool = loaded.tracks.filter((t) => !t.isLocal); // local files can't be queued
  const startSize = pool.length;

  let removedRecent = 0;
  if (unloop) {
    const recent = await getRecentTrackIds(ctx);
    const before = pool.length;
    pool = pool.filter((t) => !(t.id && recent.ids.has(t.id)) && !recent.uris.has(t.uri));
    removedRecent = before - pool.length;
  }

  let vibeSource = null;
  if (hasVibe) {
    const f = await applyVibeFilter(ctx, pool, vibe);
    pool = f.tracks;
    vibeSource = f.source;
  }

  if (pool.length === 0) {
    throw new ApiError(422, "EMPTY_POOL",
      hasVibe ? "No tracks matched that vibe (or all were recently played)."
        : "No playable tracks left after filtering.",
      { vibe, removedRecent });
  }

  const shuffled = fisherYates(pool);

  let delivered = 0;
  let partial = null;

  if (mode === "play") {
    const uris = shuffled.slice(0, 100).map((t) => t.uri);
    await spotify(ctx, "/me/player/play", { method: "PUT", body: { uris } });
    delivered = uris.length;
  } else {
    const cap = Math.min(shuffled.length, queueLimit, ctx.budget.remaining());
    for (let i = 0; i < cap; i++) {
      try {
        await spotify(ctx, "/me/player/queue", { method: "POST", query: { uri: shuffled[i].uri } });
        delivered++;
      } catch (e) {
        // First failure is fatal (no device / premium / expired token); later rate limits yield a partial result.
        if (i === 0 || !(e instanceof ApiError) || !["RATE_LIMITED", "SUBREQUEST_BUDGET_EXHAUSTED"].includes(e.code)) throw e;
        partial = { reason: e.code, retryAfter: e.extra.retryAfter };
        break;
      }
    }
  }

  const bits = [`Shuffled ${pool.length} tracks`];
  if (loaded.truncated) bits.push(`(loaded ${loaded.scanned} of ${loaded.total})`);
  bits.push(mode === "play" ? `and started playback with ${delivered}.` : `and queued ${delivered}.`);
  if (partial) bits.push(partial.reason === "RATE_LIMITED" ? "Spotify rate-limited us, so the queue is partial." : "Stopped early to stay within the Worker's call budget.");

  return {
    message: bits.join(" "),
    stats: {
      playlistTotal: loaded.total,
      scanned: loaded.scanned,
      truncated: loaded.truncated,
      eligible: startSize,
      removedRecentlyPlayed: removedRecent,
      vibe: vibe || "all",
      vibeSource,
      poolSize: pool.length,
      delivered,
      mode,
      partial,
    },
    preview: shuffled.slice(0, 10).map((t) => ({ title: t.title, artist: t.artist })),
  };
}

/* ---- F: Clone & Shuffle ---- */

async function runClone(ctx, { playlistId, vibe, body }) {
  const hasVibe = vibe && vibe !== "all";
  const reserveFor = (total) => 2 + Math.ceil(total / 100) + (hasVibe ? Math.ceil(total / 100) * 2 : 0);

  const loaded = await loadAllTracks(ctx, playlistId, reserveFor);
  let pool = loaded.tracks.filter((t) => !t.isLocal);

  let vibeSource = null;
  if (hasVibe) {
    const f = await applyVibeFilter(ctx, pool, vibe);
    pool = f.tracks;
    vibeSource = f.source;
  }
  if (pool.length === 0) throw new ApiError(422, "EMPTY_POOL", "Nothing to clone after filtering.");

  const needed = Math.ceil(pool.length / 100) + 1;
  if (needed > ctx.budget.remaining()) {
    throw new ApiError(422, "SUBREQUEST_BUDGET_EXHAUSTED",
      "This playlist is too large to clone within the Worker's call budget.", { needed, remaining: ctx.budget.remaining() });
  }

  let name = typeof body.playlistName === "string" && body.playlistName.trim() ? body.playlistName.trim() : null;
  if (!name) {
    if (playlistId === "liked") name = "Liked Songs";
    else {
      const meta = await spotify(ctx, `/playlists/${playlistId}`, { query: { fields: "name" } });
      name = meta.name || "Playlist";
    }
  }

  const shuffled = fisherYates(pool);
  const created = await createPlaylist(
    ctx,
    `${name} (ShuffleFix)`.slice(0, 100),
    "Randomized with ShuffleFix (Fisher-Yates). Order is permanent."
  );
  await addTracks(ctx, created.id, shuffled.map((t) => t.uri));

  return {
    message: `Cloned & shuffled: ${name} (${shuffled.length} tracks).`,
    stats: {
      playlistTotal: loaded.total,
      scanned: loaded.scanned,
      truncated: loaded.truncated,
      cloned: shuffled.length,
      vibe: vibe || "all",
      vibeSource,
    },
    playlist: { id: created.id, name: created.name, url: created.external_urls && created.external_urls.spotify },
  };
}

/* ---- E: De-clutter sweeper ---- */

async function runDedupe(ctx, { playlistId, body }) {
  if (playlistId === "liked") {
    throw new ApiError(400, "BAD_REQUEST", "Duplicates can't be removed from Liked Songs (Spotify prevents them already).");
  }
  const titleMatch = ["title", "off", "title-artist"].includes(body.titleMatch) ? body.titleMatch : "title-artist";
  const dryRun = body.dryRun === true;

  const meta = await spotify(ctx, `/playlists/${playlistId}`, { query: { fields: "name,snapshot_id,owner(id)" } });
  const loaded = await loadAllTracks(ctx, playlistId, (total) => dryRun ? 0 : Math.ceil(total / 100));

  if (loaded.truncated) {
    // Never delete based on a partial view: we could remove the wrong occurrence.
    throw new ApiError(422, "SUBREQUEST_BUDGET_EXHAUSTED",
      "Playlist is too large to safely scan in one request on the current Worker plan.",
      { scanned: loaded.scanned, total: loaded.total });
  }

  const dupes = findDuplicates(loaded.tracks.filter((t) => !t.isLocal), titleMatch);

  if (dupes.length === 0 || dryRun) {
    return {
      message: dupes.length === 0 ? `No duplicates found in ${meta.name}.` : `Found ${dupes.length} duplicates in ${meta.name} (dry run).`,
      stats: { playlistTotal: loaded.total, duplicatesFound: dupes.length, removed: 0, titleMatch, dryRun },
      preview: dupes.slice(0, 10).map((t) => ({ title: t.title, artist: t.artist, position: t.position })),
    };
  }

  // Group positions by URI so exactly the later copies are removed, against one snapshot.
  const byUri = new Map();
  for (const t of dupes) {
    if (!byUri.has(t.uri)) byUri.set(t.uri, []);
    byUri.get(t.uri).push(t.position);
  }
  const entries = [...byUri].map(([uri, positions]) => ({ uri, positions }));
  const batches = chunk(entries, 100);
  if (batches.length > ctx.budget.remaining()) {
    throw new ApiError(422, "SUBREQUEST_BUDGET_EXHAUSTED", "Too many duplicates to remove in one request; run it again.",
      { remainingBatches: batches.length });
  }

  let removedEntries = 0;
  for (const part of batches) {
    await spotify(ctx, `/playlists/${playlistId}/${playlistItemsPath}`, {
      method: "DELETE",
      body: { tracks: part, snapshot_id: meta.snapshot_id },
    });
    removedEntries += part.length;
  }

  return {
    message: `Removed ${dupes.length} duplicated songs from ${meta.name}.`,
    stats: { playlistTotal: loaded.total, duplicatesFound: dupes.length, removed: dupes.length, titleMatch, dryRun: false },
    preview: dupes.slice(0, 10).map((t) => ({ title: t.title, artist: t.artist, position: t.position })),
  };
}

/* ---- G: Delete (unfollow) playlist ---- */

async function runDelete(ctx, { playlistId, body, env }) {
  if (playlistId === "liked") {
    throw new ApiError(400, "BAD_REQUEST", "Liked Songs can't be deleted.");
  }
  if (env.REQUIRE_DELETE_CONFIRM === "true" && body.confirm !== true) {
    throw new ApiError(400, "BAD_REQUEST", "Deletion requires confirm: true.");
  }
  // Spotify "deletes" a playlist by unfollowing it (it remains recoverable from the account page for a while).
  await spotify(ctx, `/playlists/${playlistId}/followers`, { method: "DELETE" });
  return { message: "Playlist deleted.", stats: { deleted: true } };
}
