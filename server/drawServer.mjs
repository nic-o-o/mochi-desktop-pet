/* The draw server ("proxy") for Customize Mochi.
 *
 * POST /v1/draw  Authorization: Bearer <Clerk session token>  {"description": "..."}
 *   → 200 {"images": ["<base64 png>", ...]}
 * POST /v1/moods  Authorization: Bearer <Clerk session token>  {"image": "<base64 png>"}
 *   → 200 {"moods": {"happy": "<base64 png>", ...}}: the kept pet redrawn in each mood
 *
 * It holds the Model API key so the app never ships one, checks who is asking
 * (a verified Clerk token, a member of Mochi's organization), applies a
 * per-person and an overall daily limit, and sends the image model only the
 * pet description (or, for moods, the kept pet's picture with Mochi's fixed
 * mood instructions) plus an opaque per-user ID: the SHA-256 of the Clerk user ID
 * (64 hex characters, Model API's limit; the same hash of a Clerk user ID finds
 * the person if Model API ever flags one). No FBIDs, unixnames or Codimango data.
 *
 * Logs carry the user hash, never the description or the user ID.
 */
import crypto from 'node:crypto';
import { isPng } from '../electron/looks.mjs';
import { PROMPT_MAX, cleanPrompt, petPrompt } from '../electron/petGenerator.mjs';

/* The app's own limit on what a person can type. */
export const MAX_DESCRIPTION = PROMPT_MAX;

/** Model API's per-user safety ID for a Clerk user. */
export function safetyId(clerkUserId) {
  return crypto.createHash('sha256').update(String(clerkUserId)).digest('hex');
}

/** In-memory daily limits (UTC day). Enough for one instance and ~10 people; a shared store comes with scale. */
export function createDailyLimits({ perUser, total, now = () => Date.now() }) {
  let day = '';
  let counts = new Map();
  let all = 0;
  const today = () => new Date(now()).toISOString().slice(0, 10);
  const roll = () => {
    const d = today();
    if (d !== day) {
      day = d;
      counts = new Map();
      all = 0;
    }
  };
  return {
    /** Reserve one drawing: { ok } or { ok: false, scope: 'user' | 'total' }. */
    take(user) {
      roll();
      if (all >= total) return { ok: false, scope: 'total' };
      const used = counts.get(user) ?? 0;
      if (used >= perUser) return { ok: false, scope: 'user' };
      counts.set(user, used + 1);
      all += 1;
      return { ok: true, left: perUser - used - 1 };
    },
    /** Give back a reservation when the drawing failed on our side. */
    refund(user) {
      roll();
      const used = counts.get(user) ?? 0;
      if (used > 0) counts.set(user, used - 1);
      if (all > 0) all -= 1;
    },
  };
}

const ERROR_STATUS = { refused: 422, limit: 429, busy: 503, offline: 502, cancelled: 499, error: 502 };

function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

async function readJson(req, maxBytes) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('too_large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

/**
 * The request handler. `verify(token)` is createClerkVerifier's; `draw({prompt,
 * user})` resolves like petGenerator's generate() ({ok, images} or {ok:false,
 * error:{kind}}); `drawMoods({image, user})` like its drawMoods() ({ok, moods});
 * `log(line)` records one line per request. A set of moods counts as one drawing.
 */
export function createDrawHandler({ verify, limits, draw, drawMoods, log = () => {}, maxDescription = MAX_DESCRIPTION }) {
  /* Reserve a drawing, run it, and give it back when it failed on our side. */
  async function limited(res, user, what, run, reply) {
    const slot = limits.take(user);
    if (!slot.ok) {
      log(`${what} limited user=${user.slice(0, 12)} scope=${slot.scope}`);
      return send(res, 429, { error: slot.scope === 'user' ? 'daily_limit' : 'service_limit' });
    }
    const started = Date.now();
    const result = await run();
    if (!result.ok) {
      const kind = result.error?.kind ?? 'error';
      if (kind !== 'refused') limits.refund(user); // a refusal still counts; our failures don't
      log(`${what} failed user=${user.slice(0, 12)} kind=${kind} ms=${Date.now() - started}`);
      return send(res, ERROR_STATUS[kind] ?? 502, { error: kind });
    }
    const body = reply(result);
    log(`${what} ok user=${user.slice(0, 12)} images=${Object.keys(body.images ?? body.moods).length} ms=${Date.now() - started} left=${slot.left}`);
    return send(res, 200, { ...body, left: slot.left });
  }

  return async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, { ok: true });
    const route = url.pathname === '/v1/draw' ? 'draw' : url.pathname === '/v1/moods' && drawMoods ? 'moods' : null;
    if (!route) return send(res, 404, { error: 'not_found' });
    if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });

    const auth = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''));
    const who = auth ? await verify(auth[1].trim()) : { ok: false, reason: 'missing_token' };
    if (!who.ok) {
      log(`${route} denied reason=${who.reason}`);
      return send(res, who.reason === 'not_member' ? 403 : who.reason === 'jwks_unavailable' ? 503 : 401, { error: who.reason });
    }
    const user = safetyId(who.userId);

    let body;
    try {
      // A kept pet's picture is at most 2 MB, about 2.7 MB as base64.
      body = await readJson(req, route === 'moods' ? 3 * 1024 * 1024 : 16 * 1024);
    } catch {
      return send(res, 400, { error: 'bad_request' });
    }

    if (route === 'moods') {
      const image = typeof body?.image === 'string' ? Buffer.from(body.image, 'base64') : null;
      if (!isPng(image)) return send(res, 400, { error: 'bad_image' });
      return limited(
        res,
        user,
        'moods',
        () => drawMoods({ image, user }),
        (r) => ({ moods: Object.fromEntries(Object.entries(r.moods).map(([mood, png]) => [mood, png.toString('base64')])) }),
      );
    }

    const raw = typeof body?.description === 'string' ? body.description : '';
    const description = cleanPrompt(raw);
    if (!description || raw.trim().length > maxDescription) return send(res, 400, { error: 'bad_description', max: maxDescription });
    // Mochi's style instructions are added here, so the app sends only what the person typed.
    return limited(
      res,
      user,
      'draw',
      () => draw({ prompt: petPrompt(description), user }),
      (r) => ({ images: r.images.map((png) => png.toString('base64')) }),
    );
  };
}
