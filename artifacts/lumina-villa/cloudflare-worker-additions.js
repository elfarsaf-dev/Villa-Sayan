// ================================================================
// TAMBAHAN CLOUDFLARE WORKER — Global Contacts
// Salin kode di bawah dan tambahkan ke dalam router utama worker
// yang sudah ada (di bagian switch/if-else penanganan route).
//
// Endpoint yang ditambahkan:
//   GET    /contacts/global          — list semua kontak global
//   POST   /contacts/global          — tambah kontak global
//   PATCH  /contacts/global/:id      — edit kontak global
//   DELETE /contacts/global/:id      — hapus kontak global
//
// Semua endpoint ini membutuhkan Bearer token (login dulu di admin).
// Write ke Supabase menggunakan SERVICE_ROLE key — aman.
// ================================================================

// ── Tambahkan di dalam handler utama, setelah cek auth ───────────

// GET /contacts/global — list kontak global (villa_id = null)
if (method === 'GET' && path === '/contacts/global') {
  requireAuth(request); // pastikan sudah login
  const { data, error } = await supabaseAdmin
    .from('contacts')
    .select('*')
    .is('villa_id', null)
    .order('created_at', { ascending: true });
  if (error) return errorRes(error.message);
  return jsonRes(data);
}

// POST /contacts/global — buat kontak global baru
if (method === 'POST' && path === '/contacts/global') {
  requireAuth(request);
  const body = await request.json();
  const { data, error } = await supabaseAdmin
    .from('contacts')
    .insert({
      villa_id:   null,
      type:       body.type,
      label:      body.label || null,
      value:      body.value,
      is_primary: body.is_primary ?? false,
    })
    .select()
    .single();
  if (error) return errorRes(error.message);
  return jsonRes(data, 201);
}

// PATCH /contacts/global/:id — edit kontak global
const patchGlobalMatch = path.match(/^\/contacts\/global\/([^/]+)$/);
if (method === 'PATCH' && patchGlobalMatch) {
  requireAuth(request);
  const id   = patchGlobalMatch[1];
  const body = await request.json();
  const { data, error } = await supabaseAdmin
    .from('contacts')
    .update({
      type:       body.type,
      label:      body.label ?? null,
      value:      body.value,
      is_primary: body.is_primary ?? false,
    })
    .eq('id', id)
    .is('villa_id', null)
    .select()
    .single();
  if (error) return errorRes(error.message);
  return jsonRes(data);
}

// DELETE /contacts/global/:id — hapus kontak global
const deleteGlobalMatch = path.match(/^\/contacts\/global\/([^/]+)$/);
if (method === 'DELETE' && deleteGlobalMatch) {
  requireAuth(request);
  const id = deleteGlobalMatch[1];
  const { error } = await supabaseAdmin
    .from('contacts')
    .delete()
    .eq('id', id)
    .is('villa_id', null);
  if (error) return errorRes(error.message);
  return jsonRes({ ok: true });
}

// ================================================================
// CATATAN KEAMANAN:
// - supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
// - requireAuth(request) = validasi JWT Bearer token dari login admin
// - Anon key di frontend HANYA bisa baca (SELECT), tidak bisa tulis
// - Tidak perlu menambah RLS write policy di Supabase
// ================================================================
