// Supabase Edge Function: admin-users
// Privileged account operations that need the service-role key, which must never
// reach the browser:  invite (send an invitation e-mail + create an active profile)
//                     set_access (block / unblock sign-in at the Auth layer)
// The caller must be an ACTIVE user whose role has the 'manage_users' capability;
// that is checked with the caller's own JWT against the database before anything runs.
//
// Deploy:  supabase functions deploy admin-users
// Secrets: supabase secrets set ALLOWED_ORIGINS="https://your-app.vercel.app,https://preview-domain"
// (SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are provided by the platform.)
import { createClient } from 'npm:@supabase/supabase-js@2';

const ALLOWED = (Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const ROLES = new Set(['doctor', 'consultant', 'admin']);

function cors(origin: string | null) {
  const ok = origin && ALLOWED.includes(origin);
  return {
    'Access-Control-Allow-Origin': ok ? origin! : 'null',
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}
const reply = (origin: string | null, status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors(origin), 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  const origin = req.headers.get('Origin');
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
  if (req.method !== 'POST') return reply(origin, 405, { code: 'invalid', error: 'Method not allowed' });
  if (ALLOWED.length && origin && !ALLOWED.includes(origin)) return reply(origin, 403, { code: 'forbidden', error: 'Origin not allowed' });

  const auth = req.headers.get('Authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return reply(origin, 401, { code: 'auth', error: 'Sign in required' });

  const url = Deno.env.get('SUPABASE_URL')!;
  const asCaller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const { data: who, error: whoErr } = await asCaller.auth.getUser();
  if (whoErr || !who.user) return reply(origin, 401, { code: 'auth', error: 'Session expired' });
  const { data: allowed, error: capErr } = await asCaller.rpc('has_capability', { cap: 'manage_users' });
  if (capErr || allowed !== true) return reply(origin, 403, { code: 'forbidden', error: 'Not permitted' });

  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const log = (action: string, metadata: Record<string, unknown>) =>
    admin.from('document_activity').insert({ document_id: null, actor_id: who.user!.id, action, metadata });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return reply(origin, 400, { code: 'invalid', error: 'Invalid JSON' }); }

  try {
    if (body.action === 'invite') {
      const email = String(body.email ?? '').trim().toLowerCase();
      const full_name = String(body.full_name ?? '').trim().slice(0, 120);
      const designation = String(body.designation ?? '').trim().slice(0, 120);
      const role = String(body.role ?? 'doctor');
      let redirectTo = String(body.redirect_to ?? '');
      if (!/^\S+@\S+\.\S+$/.test(email) || full_name.length < 2 || !ROLES.has(role)) return reply(origin, 400, { code: 'invalid', error: 'Email, name and role are required' });
      try { const u = new URL(redirectTo); if (ALLOWED.length && !ALLOWED.includes(u.origin)) redirectTo = ''; } catch { redirectTo = ''; }

      const { data, error } = await admin.auth.admin.inviteUserByEmail(email, { data: { full_name, designation }, ...(redirectTo ? { redirectTo } : {}) });
      if (error) return reply(origin, 400, { code: 'invalid', error: /already/i.test(error.message) ? 'An account with this email already exists.' : error.message });
      const { error: pErr } = await admin.from('profiles').update({ full_name, designation, role, is_active: true }).eq('id', data.user.id);
      if (pErr) return reply(origin, 500, { code: 'unknown', error: 'Invitation sent, but the profile could not be activated. Activate it in the account list.' });
      await log('user_invited', { user: data.user.id, role });
      return reply(origin, 200, { ok: true, user_id: data.user.id });
    }

    if (body.action === 'set_access') {
      const userId = String(body.user_id ?? '');
      const active = body.active === true;
      if (!/^[0-9a-f-]{36}$/.test(userId)) return reply(origin, 400, { code: 'invalid', error: 'Invalid user' });
      if (userId === who.user.id) return reply(origin, 400, { code: 'self_action', error: 'You cannot change your own access' });
      // The database flag (profiles.is_active, set via admin_update_user) is authoritative; keep the Auth ban in step with it.
      const { data: prof } = await admin.from('profiles').select('is_active').eq('id', userId).single();
      if (!prof || prof.is_active !== active) return reply(origin, 409, { code: 'invalid', error: 'Update the account status first' });
      const { error } = await admin.auth.admin.updateUserById(userId, { ban_duration: active ? 'none' : '876000h' });
      if (error) return reply(origin, 400, { code: 'unknown', error: error.message });
      await log('access_synced', { user: userId, active });
      return reply(origin, 200, { ok: true });
    }

    return reply(origin, 400, { code: 'invalid', error: 'Unknown action' });
  } catch (_e) {
    return reply(origin, 500, { code: 'unknown', error: 'Unexpected error' });   // never echo internals
  }
});
