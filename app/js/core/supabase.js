import { config, isConfigured } from './env.js';

let client = null;

// Single shared Supabase client (vendored UMD build: /vendor/supabase.js -> window.supabase).
export function sb() {
  if (client) return client;
  if (!isConfigured()) throw new Error('Discharge Summary Pro is not configured (missing Supabase URL or publishable key).');
  client = window.supabase.createClient(config.supabaseUrl, config.supabaseKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      flowType: 'implicit',      // invitation and recovery e-mails work on any device
      storageKey: 'dsp-auth',
    },
    global: { headers: { 'x-client-info': 'discharge-summary-pro/2' } },
  });
  return client;
}

// Raw access token for keepalive requests sent while the page is closing.
export async function accessToken() {
  const { data } = await sb().auth.getSession();
  return data.session?.access_token || null;
}
