// Group availability API. Four routes, no auth, no sessions.
//
// Keys:
//   g:<CODE>:meta    { v, name, created }
//   g:<CODE>:p:<ID>  { n, tz, s }
//
// One key per person rather than one blob per group: KV has no compare-and-swap,
// so a read-modify-write of a shared blob would silently drop a submission when
// two people save at the same moment. Separate keys never contend.

const TTL = 60 * 60 * 24 * 60; // 60 days, refreshed on every write
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ'; // no 0/O/1/I/L/U
const CODE_RE = /^[23456789A-HJ-NP-TV-Z]{6}$/;
const ID_RE = /^[0-9a-f]{16}$/;
const SLOTS_RE = /^[A-Za-z0-9_-]{28}$/; // 168 bits -> 21 bytes -> 28 base64url chars
const MAX_NAME = 40;
const MAX_PEOPLE = 40;
const MAX_BODY = 1024;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

const err = (status, message) => json({ error: message }, status);

const metaKey = (code) => `g:${code}:meta`;
const personKey = (code, id) => `g:${code}:p:${id}`;
const personPrefix = (code) => `g:${code}:p:`;

function newCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  let out = '';
  // 256 % 30 != 0, so the modulo is very slightly biased. Irrelevant here: codes
  // are shared deliberately, not secrets, and the space is ~729M either way.
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

function validTimezone(tz) {
  if (typeof tz !== 'string' || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

async function readBody(request) {
  const text = await request.text();
  if (text.length > MAX_BODY) return { error: 'body too large' };
  if (!text) return { value: {} };
  try {
    const value = JSON.parse(text);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { error: 'body must be an object' };
    }
    return { value };
  } catch {
    return { error: 'invalid JSON' };
  }
}

async function createGroup(request, env) {
  const body = await readBody(request);
  if (body.error) return err(400, body.error);

  let name = typeof body.value.name === 'string' ? body.value.name.trim() : '';
  if (name.length > MAX_NAME) name = name.slice(0, MAX_NAME);

  // Collisions are vanishingly unlikely, but a retry is two lines.
  let code = null;
  for (let i = 0; i < 5; i++) {
    const candidate = newCode();
    if ((await env.AVAIL.get(metaKey(candidate))) === null) {
      code = candidate;
      break;
    }
  }
  if (!code) return err(503, 'could not allocate a code, try again');

  const meta = { v: 1, name, created: Math.floor(Date.now() / 1000) };
  await env.AVAIL.put(metaKey(code), JSON.stringify(meta), { expirationTtl: TTL });
  return json({ code, ...meta });
}

async function getGroup(env, code) {
  const meta = await env.AVAIL.get(metaKey(code), 'json');
  if (!meta) return err(404, 'group not found');

  const listed = await env.AVAIL.list({ prefix: personPrefix(code) });
  const entries = await Promise.all(
    listed.keys.map(async (k) => {
      const person = await env.AVAIL.get(k.name, 'json');
      if (!person) return null; // expired between list and get
      return { id: k.name.slice(personPrefix(code).length), ...person };
    }),
  );

  return json({
    code,
    name: meta.name || '',
    created: meta.created,
    people: entries.filter(Boolean),
  });
}

async function putPerson(request, env, code, id) {
  const body = await readBody(request);
  if (body.error) return err(400, body.error);
  const { n, tz, s } = body.value;

  const name = typeof n === 'string' ? n.trim() : '';
  if (name.length < 1 || name.length > MAX_NAME) return err(400, 'name must be 1-40 characters');
  if (!validTimezone(tz)) return err(400, 'invalid timezone');
  if (typeof s !== 'string' || !SLOTS_RE.test(s)) return err(400, 'invalid slots');

  const meta = await env.AVAIL.get(metaKey(code), 'json');
  if (!meta) return err(404, 'group not found');

  const key = personKey(code, id);
  if ((await env.AVAIL.get(key)) === null) {
    const listed = await env.AVAIL.list({ prefix: personPrefix(code) });
    if (listed.keys.length >= MAX_PEOPLE) return err(409, 'group is full');
  }

  await env.AVAIL.put(key, JSON.stringify({ n: name, tz, s }), { expirationTtl: TTL });
  // Keep the group alive as long as anyone is still using it.
  await env.AVAIL.put(metaKey(code), JSON.stringify(meta), { expirationTtl: TTL });
  return json({ ok: true, id, n: name, tz, s });
}

async function deletePerson(env, code, id) {
  await env.AVAIL.delete(personKey(code, id));
  return json({ ok: true });
}

async function handleApi(request, env, path) {
  if (path === '/api/group' && request.method === 'POST') {
    return createGroup(request, env);
  }

  const match = path.match(/^\/api\/group\/([^/]+)(?:\/p\/([^/]+))?$/);
  if (!match) return err(404, 'not found');

  const [, code, id] = match;
  if (!CODE_RE.test(code)) return err(400, 'invalid group code');

  if (!id) {
    if (request.method !== 'GET') return err(405, 'method not allowed');
    return getGroup(env, code);
  }

  if (!ID_RE.test(id)) return err(400, 'invalid person id');
  if (request.method === 'PUT') return putPerson(request, env, code, id);
  if (request.method === 'DELETE') return deletePerson(env, code, id);
  return err(405, 'method not allowed');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      return handleApi(request, env, url.pathname);
    }

    // #/CODE lives in the hash, so every non-API path is just the one page.
    return env.ASSETS.fetch(request);
  },
};
