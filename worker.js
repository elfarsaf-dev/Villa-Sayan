/**
 * ================================================================
 * Villa Management — Cloudflare Worker (single file)
 * ================================================================
 *
 * Environment Variables (set in Cloudflare Dashboard > Workers > Settings > Variables):
 *   SUPABASE_URL       - e.g. https://xxxx.supabase.co
 *   SUPABASE_KEY       - Supabase service_role key
 *   JWT_SECRET         - Random string ≥ 32 chars for signing tokens
 *   GITHUB_TOKEN       - GitHub PAT with repo write scope
 *   GITHUB_REPO        - Format: owner/repo  (e.g. myname/villa-images)
 *   GITHUB_BRANCH      - Branch to upload to (default: main)
 *   GITHUB_IMG_PATH    - Folder inside repo  (default: images/villas)
 *   ALLOWED_ORIGIN     - Allowed CORS origin (e.g. https://yourdomain.com or *)
 *
 * Deploy:
 *   npx wrangler deploy worker.js --name villa-admin
 *
 * First-time setup:
 *   POST /setup  {"username":"superadmin","password":"yourpassword"}
 *   (Only works when no users exist yet)
 * ================================================================
 */

// ── CORS ─────────────────────────────────────────────────────────
function corsHeaders(env) {
  const origin = (env && env.ALLOWED_ORIGIN) ? env.ALLOWED_ORIGIN : '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

function cors(response, env) {
  const r = new Response(response.body, response);
  const h = corsHeaders(env);
  for (const [k, v] of Object.entries(h)) r.headers.set(k, v);
  return r;
}

function json(data, status = 200, env = null) {
  return cors(
    new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
    env,
  );
}

function err(msg, status = 400, env = null) {
  return json({ error: msg }, status, env);
}

// ── JWT ──────────────────────────────────────────────────────────
function b64url(input) {
  const str = typeof input === 'string'
    ? input
    : String.fromCharCode(...new Uint8Array(input));
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function b64decode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Uint8Array.from(atob(str), c => c.charCodeAt(0));
}

async function signJWT(payload, secret) {
  const enc = new TextEncoder();
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body   = b64url(JSON.stringify({ ...payload, iat: Math.floor(Date.now() / 1000) }));
  const data   = `${header}.${body}`;
  const key    = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return `${data}.${b64url(sig)}`;
}

async function verifyJWT(token, secret) {
  try {
    const [header, body, sig] = token.split('.');
    if (!header || !body || !sig) return null;
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'],
    );
    const valid = await crypto.subtle.verify('HMAC', key, b64decode(sig), enc.encode(`${header}.${body}`));
    if (!valid) return null;
    const payload = JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/')));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

// ── Password (PBKDF2 + SHA-256) ───────────────────────────────────
async function hashPassword(password) {
  const enc  = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const saltHex = [...salt].map(b => b.toString(16).padStart(2, '0')).join('');
  const km   = await crypto.subtle.importKey('raw', enc.encode(password), { name: 'PBKDF2' }, false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, km, 256);
  const hash = [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, '0')).join('');
  return `${saltHex}:${hash}`;
}

async function verifyPassword(password, stored) {
  const [saltHex, storedHash] = stored.split(':');
  const salt = new Uint8Array(saltHex.match(/.{2}/g).map(h => parseInt(h, 16)));
  const enc  = new TextEncoder();
  const km   = await crypto.subtle.importKey('raw', enc.encode(password), { name: 'PBKDF2' }, false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, km, 256);
  const hash = [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, '0')).join('');
  return hash === storedHash;
}

// ── Supabase REST helper ──────────────────────────────────────────
async function sb(env, table, method = 'GET', query = '', body = null) {
  const url  = `${env.SUPABASE_URL}/rest/v1/${table}${query ? '?' + query : ''}`;
  const headers = {
    apikey:          env.SUPABASE_KEY,
    Authorization:   `Bearer ${env.SUPABASE_KEY}`,
    'Content-Type':  'application/json',
  };
  if (method !== 'DELETE') headers['Prefer'] = 'return=representation';
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const res  = await fetch(url, opts);
  if (method === 'DELETE' && res.status < 300) return [];
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${method} ${table} ${res.status}: ${text}`);
  return text ? JSON.parse(text) : [];
}

// ── Auth helpers ──────────────────────────────────────────────────
async function getUser(request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  return verifyJWT(auth.slice(7), env.JWT_SECRET);
}

async function requireAuth(request, env) {
  const u = await getUser(request, env);
  if (!u) throw { status: 401, message: 'Unauthorized' };
  return u;
}

async function requireSA(request, env) {
  const u = await requireAuth(request, env);
  if (u.role !== 'superadmin') throw { status: 403, message: 'Superadmin only' };
  return u;
}

function canAccessVilla(user, villaId) {
  return user.role === 'superadmin' || user.villa_id === villaId;
}

// ── Route handlers ────────────────────────────────────────────────

// POST /setup  — creates first superadmin (only if no users exist)
async function setup(request, env) {
  const count = await sb(env, 'v_users', 'GET', 'select=id&limit=1');
  if (count.length > 0) return err('Setup already done. Use /auth/register.', 403, env);
  const { username, password } = await request.json();
  if (!username || !password) return err('username and password required', 400, env);
  const password_hash = await hashPassword(password);
  const user = await sb(env, 'v_users', 'POST', '', {
    username, password_hash, role: 'superadmin', status: 'active',
  });
  return json({ message: 'Superadmin created', user: { id: user[0]?.id, username } }, 201, env);
}

// POST /auth/login
async function login(request, env) {
  const { username, password } = await request.json();
  if (!username || !password) return err('username and password required', 400, env);
  const rows = await sb(env, 'v_users', 'GET', `username=eq.${encodeURIComponent(username)}&select=*&limit=1`);
  const user = rows[0];
  if (!user) return err('Invalid credentials', 401, env);
  if (user.status === 'pending')   return err('Account pending superadmin approval', 403, env);
  if (user.status === 'suspended') return err('Account suspended', 403, env);
  if (!await verifyPassword(password, user.password_hash)) return err('Invalid credentials', 401, env);
  const exp   = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7; // 7 days
  const token = await signJWT({ sub: user.id, username: user.username, role: user.role, villa_id: user.villa_id, exp }, env.JWT_SECRET);
  return json({ token, user: { id: user.id, username: user.username, role: user.role, villa_id: user.villa_id } }, 200, env);
}

// POST /auth/register
async function register(request, env) {
  const { username, password, email, villa_id } = await request.json();
  if (!username || !password) return err('username and password required', 400, env);
  if (password.length < 6) return err('Password must be ≥ 6 characters', 400, env);
  const existing = await sb(env, 'v_users', 'GET', `username=eq.${encodeURIComponent(username)}&limit=1`);
  if (existing.length) return err('Username already taken', 409, env);
  const password_hash = await hashPassword(password);
  await sb(env, 'v_users', 'POST', '', {
    username, password_hash,
    email:    email    || null,
    villa_id: villa_id || null,
    role: 'admin', status: 'pending',
  });
  return json({ message: 'Registered. Waiting for superadmin approval before you can log in.' }, 201, env);
}

// GET /auth/me
async function me(request, env) {
  const u    = await requireAuth(request, env);
  const rows = await sb(env, 'v_users', 'GET', `id=eq.${u.sub}&select=id,username,email,role,villa_id,status,created_at&limit=1`);
  return json(rows[0] || null, 200, env);
}

// ── Villas ────────────────────────────────────────────────────────
async function getVillas(request, env) {
  const u = await requireAuth(request, env);
  let q = 'select=*&order=created_at.asc';
  if (u.role !== 'superadmin' && u.villa_id) q += `&id=eq.${u.villa_id}`;
  return json(await sb(env, 'villa_info', 'GET', q), 200, env);
}

async function createVilla(request, env) {
  await requireSA(request, env);
  const b = await request.json();
  if (!b.name || !b.slug) return err('name and slug required', 400, env);
  const ex = await sb(env, 'villa_info', 'GET', `slug=eq.${encodeURIComponent(b.slug)}&limit=1`);
  if (ex.length) return err('Slug already in use', 409, env);
  const r = await sb(env, 'villa_info', 'POST', '', {
    name: b.name, slug: b.slug, tagline: b.tagline || null,
    description: b.description || null, address: b.address || null,
    city: b.city || null, province: b.province || null,
    max_guests: b.max_guests || null, max_guests_note: b.max_guests_note || null,
    extra_bed_price: b.extra_bed_price || null, extra_bed_note: b.extra_bed_note || null,
    checkin_time: b.checkin_time || '14.00 WIB', checkout_time: b.checkout_time || '12.00 WIB',
  });
  return json(r[0] || r, 201, env);
}

async function getVilla(request, env, id) {
  const u = await requireAuth(request, env);
  if (!canAccessVilla(u, id)) return err('Forbidden', 403, env);
  const r = await sb(env, 'villa_info', 'GET', `id=eq.${id}&select=*&limit=1`);
  if (!r.length) return err('Villa not found', 404, env);
  return json(r[0], 200, env);
}

async function updateVilla(request, env, id) {
  const u = await requireAuth(request, env);
  if (!canAccessVilla(u, id)) return err('Forbidden', 403, env);
  const b = await request.json();
  const allowed = ['name','slug','tagline','description','address','city','province',
    'max_guests','max_guests_note','extra_bed_price','extra_bed_note','checkin_time','checkout_time'];
  const upd = { updated_at: new Date().toISOString() };
  for (const k of allowed) if (k in b) upd[k] = b[k];
  const r = await sb(env, 'villa_info', 'PATCH', `id=eq.${id}`, upd);
  return json(r[0] || r, 200, env);
}

// ── Facilities ────────────────────────────────────────────────────
async function getFacilities(request, env, villaId) {
  await requireAuth(request, env);
  return json(await sb(env, 'facilities', 'GET', `villa_id=eq.${villaId}&order=sort_order.asc`), 200, env);
}

async function createFacility(request, env, villaId) {
  const u = await requireAuth(request, env);
  if (!canAccessVilla(u, villaId)) return err('Forbidden', 403, env);
  const b = await request.json();
  if (!b.name) return err('name required', 400, env);
  const r = await sb(env, 'facilities', 'POST', '', {
    villa_id: villaId, icon: b.icon || 'star', name: b.name,
    description: b.description || null, sort_order: b.sort_order ?? 0, is_active: true,
  });
  return json(r[0] || r, 201, env);
}

async function updateFacility(request, env, id) {
  const u   = await requireAuth(request, env);
  const fac = await sb(env, 'facilities', 'GET', `id=eq.${id}&limit=1`);
  if (!fac.length) return err('Not found', 404, env);
  if (!canAccessVilla(u, fac[0].villa_id)) return err('Forbidden', 403, env);
  const b = await request.json();
  const r = await sb(env, 'facilities', 'PATCH', `id=eq.${id}`, b);
  return json(r[0] || r, 200, env);
}

async function deleteFacility(request, env, id) {
  const u   = await requireAuth(request, env);
  const fac = await sb(env, 'facilities', 'GET', `id=eq.${id}&limit=1`);
  if (!fac.length) return err('Not found', 404, env);
  if (!canAccessVilla(u, fac[0].villa_id)) return err('Forbidden', 403, env);
  await sb(env, 'facilities', 'DELETE', `id=eq.${id}`);
  return json({ success: true }, 200, env);
}

// ── Policies ──────────────────────────────────────────────────────
async function getPolicies(request, env, villaId) {
  await requireAuth(request, env);
  return json(await sb(env, 'policies', 'GET', `villa_id=eq.${villaId}&order=sort_order.asc`), 200, env);
}

async function createPolicy(request, env, villaId) {
  const u = await requireAuth(request, env);
  if (!canAccessVilla(u, villaId)) return err('Forbidden', 403, env);
  const b = await request.json();
  if (!b.content || !b.type) return err('content and type required', 400, env);
  const r = await sb(env, 'policies', 'POST', '', {
    villa_id: villaId, type: b.type, content: b.content, sort_order: b.sort_order ?? 0,
  });
  return json(r[0] || r, 201, env);
}

async function updatePolicy(request, env, id) {
  const u    = await requireAuth(request, env);
  const item = await sb(env, 'policies', 'GET', `id=eq.${id}&limit=1`);
  if (!item.length) return err('Not found', 404, env);
  if (!canAccessVilla(u, item[0].villa_id)) return err('Forbidden', 403, env);
  const b = await request.json();
  const r = await sb(env, 'policies', 'PATCH', `id=eq.${id}`, b);
  return json(r[0] || r, 200, env);
}

async function deletePolicy(request, env, id) {
  const u    = await requireAuth(request, env);
  const item = await sb(env, 'policies', 'GET', `id=eq.${id}&limit=1`);
  if (!item.length) return err('Not found', 404, env);
  if (!canAccessVilla(u, item[0].villa_id)) return err('Forbidden', 403, env);
  await sb(env, 'policies', 'DELETE', `id=eq.${id}`);
  return json({ success: true }, 200, env);
}

// ── Contacts ──────────────────────────────────────────────────────
async function getContacts(request, env, villaId) {
  await requireAuth(request, env);
  return json(await sb(env, 'contacts', 'GET', `villa_id=eq.${villaId}`), 200, env);
}

async function createContact(request, env, villaId) {
  const u = await requireAuth(request, env);
  if (!canAccessVilla(u, villaId)) return err('Forbidden', 403, env);
  const b = await request.json();
  if (!b.value || !b.type) return err('type and value required', 400, env);
  const r = await sb(env, 'contacts', 'POST', '', {
    villa_id: villaId, type: b.type, label: b.label || null,
    value: b.value, is_primary: b.is_primary ?? false,
  });
  return json(r[0] || r, 201, env);
}

async function deleteContact(request, env, id) {
  const u    = await requireAuth(request, env);
  const item = await sb(env, 'contacts', 'GET', `id=eq.${id}&limit=1`);
  if (!item.length) return err('Not found', 404, env);
  if (!canAccessVilla(u, item[0].villa_id)) return err('Forbidden', 403, env);
  await sb(env, 'contacts', 'DELETE', `id=eq.${id}`);
  return json({ success: true }, 200, env);
}

// ── Gallery ───────────────────────────────────────────────────────
async function getGallery(request, env, villaId) {
  await requireAuth(request, env);
  return json(await sb(env, 'gallery', 'GET', `villa_id=eq.${villaId}&is_active=eq.true&order=sort_order.asc`), 200, env);
}

async function deleteGallery(request, env, id) {
  const u    = await requireAuth(request, env);
  const item = await sb(env, 'gallery', 'GET', `id=eq.${id}&limit=1`);
  if (!item.length) return err('Not found', 404, env);
  if (!canAccessVilla(u, item[0].villa_id)) return err('Forbidden', 403, env);
  await sb(env, 'gallery', 'PATCH', `id=eq.${id}`, { is_active: false });
  return json({ success: true }, 200, env);
}

// POST /upload/github  (multipart/form-data: file, villa_id, alt)
async function uploadGithub(request, env) {
  const u = await requireAuth(request, env);
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) return err('GitHub not configured on worker', 500, env);

  const form     = await request.formData();
  const file     = form.get('file');
  const villaId  = form.get('villa_id');
  const alt      = form.get('alt') || '';

  if (!file)    return err('No file provided', 400, env);
  if (!villaId) return err('villa_id required', 400, env);
  if (!canAccessVilla(u, villaId)) return err('Forbidden', 403, env);

  const ext    = (file.name.split('.').pop() || 'jpg').toLowerCase();
  const branch = env.GITHUB_BRANCH   || 'main';
  const folder = env.GITHUB_IMG_PATH || 'images/villas';
  const path   = `${folder}/${villaId}/${Date.now()}.${ext}`;

  const ab     = await file.arrayBuffer();
  const base64 = btoa(String.fromCharCode(...new Uint8Array(ab)));

  const ghRes = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}`, {
    method: 'PUT',
    headers: {
      Authorization:  `Bearer ${env.GITHUB_TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent':   'VillaWorker/1.0',
    },
    body: JSON.stringify({ message: `Upload image ${path}`, content: base64, branch }),
  });

  if (!ghRes.ok) {
    const t = await ghRes.text();
    return err(`GitHub upload failed: ${t}`, 500, env);
  }

  const ghData  = await ghRes.json();
  const rawUrl  = ghData.content.download_url;
  const gallery = await sb(env, 'gallery', 'POST', '', {
    villa_id: villaId, url: rawUrl, alt, sort_order: 0, is_active: true,
  });

  return json({ url: rawUrl, gallery: gallery[0] || gallery }, 201, env);
}

// ── Inquiries ─────────────────────────────────────────────────────
async function getInquiries(request, env) {
  const u   = await requireAuth(request, env);
  const url = new URL(request.url);
  let q = 'select=*&order=created_at.desc';
  if (u.role !== 'superadmin' && u.villa_id) q += `&villa_id=eq.${u.villa_id}`;
  const status = url.searchParams.get('status');
  if (status) q += `&status=eq.${status}`;
  return json(await sb(env, 'inquiries', 'GET', q), 200, env);
}

async function updateInquiry(request, env, id) {
  const u     = await requireAuth(request, env);
  const items = await sb(env, 'inquiries', 'GET', `id=eq.${id}&limit=1`);
  if (!items.length) return err('Not found', 404, env);
  if (!canAccessVilla(u, items[0].villa_id)) return err('Forbidden', 403, env);
  const b   = await request.json();
  const upd = {};
  if ('status' in b) upd.status = b.status;
  if ('message' in b) upd.message = b.message;
  const r = await sb(env, 'inquiries', 'PATCH', `id=eq.${id}`, upd);
  return json(r[0] || r, 200, env);
}

// ── Users (superadmin) ────────────────────────────────────────────
async function getUsers(request, env) {
  await requireSA(request, env);
  const rows = await sb(env, 'v_users', 'GET',
    'select=id,username,email,role,villa_id,status,created_at,approved_at&order=created_at.desc');
  return json(rows, 200, env);
}

async function approveUser(request, env, id) {
  const admin = await requireSA(request, env);
  const r = await sb(env, 'v_users', 'PATCH', `id=eq.${id}`, {
    status: 'active', approved_at: new Date().toISOString(), approved_by: admin.sub,
  });
  return json(r[0] || r, 200, env);
}

async function suspendUser(request, env, id) {
  await requireSA(request, env);
  const r = await sb(env, 'v_users', 'PATCH', `id=eq.${id}`, { status: 'suspended' });
  return json(r[0] || r, 200, env);
}

async function updateUserRole(request, env, id) {
  await requireSA(request, env);
  const b = await request.json();
  if (!['admin', 'superadmin'].includes(b.role)) return err('Invalid role', 400, env);
  const r = await sb(env, 'v_users', 'PATCH', `id=eq.${id}`, {
    role: b.role, villa_id: b.villa_id || null,
  });
  return json(r[0] || r, 200, env);
}

async function deleteUser(request, env, id) {
  await requireSA(request, env);
  await sb(env, 'v_users', 'DELETE', `id=eq.${id}`);
  return json({ success: true }, 200, env);
}

// ── Router ────────────────────────────────────────────────────────
const ROUTES = [
  ['POST',   /^\/setup$/,                                    (r, e, _m) => setup(r, e)],
  ['POST',   /^\/auth\/login$/,                              (r, e, _m) => login(r, e)],
  ['POST',   /^\/auth\/register$/,                           (r, e, _m) => register(r, e)],
  ['GET',    /^\/auth\/me$/,                                 (r, e, _m) => me(r, e)],

  ['GET',    /^\/villas$/,                                   (r, e, _m) => getVillas(r, e)],
  ['POST',   /^\/villas$/,                                   (r, e, _m) => createVilla(r, e)],
  ['GET',    /^\/villas\/([^/]+)$/,                          (r, e, m)  => getVilla(r, e, m[1])],
  ['PATCH',  /^\/villas\/([^/]+)$/,                          (r, e, m)  => updateVilla(r, e, m[1])],

  ['GET',    /^\/villas\/([^/]+)\/facilities$/,              (r, e, m)  => getFacilities(r, e, m[1])],
  ['POST',   /^\/villas\/([^/]+)\/facilities$/,              (r, e, m)  => createFacility(r, e, m[1])],
  ['PATCH',  /^\/facilities\/([^/]+)$/,                      (r, e, m)  => updateFacility(r, e, m[1])],
  ['DELETE', /^\/facilities\/([^/]+)$/,                      (r, e, m)  => deleteFacility(r, e, m[1])],

  ['GET',    /^\/villas\/([^/]+)\/policies$/,                (r, e, m)  => getPolicies(r, e, m[1])],
  ['POST',   /^\/villas\/([^/]+)\/policies$/,                (r, e, m)  => createPolicy(r, e, m[1])],
  ['PATCH',  /^\/policies\/([^/]+)$/,                        (r, e, m)  => updatePolicy(r, e, m[1])],
  ['DELETE', /^\/policies\/([^/]+)$/,                        (r, e, m)  => deletePolicy(r, e, m[1])],

  ['GET',    /^\/villas\/([^/]+)\/contacts$/,                (r, e, m)  => getContacts(r, e, m[1])],
  ['POST',   /^\/villas\/([^/]+)\/contacts$/,                (r, e, m)  => createContact(r, e, m[1])],
  ['DELETE', /^\/contacts\/([^/]+)$/,                        (r, e, m)  => deleteContact(r, e, m[1])],

  ['GET',    /^\/villas\/([^/]+)\/gallery$/,                 (r, e, m)  => getGallery(r, e, m[1])],
  ['DELETE', /^\/gallery\/([^/]+)$/,                         (r, e, m)  => deleteGallery(r, e, m[1])],

  ['POST',   /^\/upload\/github$/,                           (r, e, _m) => uploadGithub(r, e)],

  ['GET',    /^\/inquiries$/,                                (r, e, _m) => getInquiries(r, e)],
  ['PATCH',  /^\/inquiries\/([^/]+)$/,                       (r, e, m)  => updateInquiry(r, e, m[1])],

  ['GET',    /^\/users$/,                                    (r, e, _m) => getUsers(r, e)],
  ['PATCH',  /^\/users\/([^/]+)\/approve$/,                  (r, e, m)  => approveUser(r, e, m[1])],
  ['PATCH',  /^\/users\/([^/]+)\/suspend$/,                  (r, e, m)  => suspendUser(r, e, m[1])],
  ['PATCH',  /^\/users\/([^/]+)\/role$/,                     (r, e, m)  => updateUserRole(r, e, m[1])],
  ['DELETE', /^\/users\/([^/]+)$/,                           (r, e, m)  => deleteUser(r, e, m[1])],
];

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    const path   = new URL(request.url).pathname.replace(/\/$/, '') || '/';
    const method = request.method;

    try {
      for (const [rm, rp, handler] of ROUTES) {
        if (rm !== method) continue;
        const m = path.match(rp);
        if (m) return await handler(request, env, m);
      }
      return json({ error: 'Not found', path }, 404, env);
    } catch (e) {
      if (e.status) return json({ error: e.message }, e.status, env);
      console.error(e);
      return json({ error: 'Internal server error' }, 500, env);
    }
  },
};
