import { sb } from './supabase.js';
import { config } from './env.js';

// Server errors are raised as 'DSP:<code>' (see supabase/migrations/*_api_functions.sql).
const MESSAGES = {
  network: 'Cannot reach the server. Check the internet connection.',
  auth: 'Your session has ended. Please sign in again.',
  inactive: 'Your account is not active. Please contact the administrator.',
  forbidden: 'You do not have permission to do this.',
  not_found: 'This summary does not exist, or you no longer have access to it.',
  not_editable: 'This summary cannot be edited in its current status.',
  lease_lost: 'Another session is now editing this summary.',
  conflict: 'This summary was changed in another session since you opened it.',
  too_large: 'The summary is too large to save.',
  rate_limited: 'Too many requests in a short time. Please wait a minute and try again.',
  validation: 'The summary failed a required check.',
  reviewer_required: 'Choose an active consultant (other than yourself) as the reviewer.',
  reviewer_assigned: "The assigned reviewer's access cannot be removed while the summary is under review.",
  already_amended: 'An amendment has already been started for this summary.',
  self_action: 'You cannot change your own role or deactivate your own account.',
  last_admin: 'At least one active administrator is required.',
  invalid: 'The request was not valid.',
  unknown: 'Something went wrong. Please try again.',
};

const VALIDATION = {
  patient_name: 'Patient name is required.',
  date_format: 'Admission or discharge date is not a valid date.',
  discharge_before_admission: 'Date of discharge is before the date of admission.',
};

export class ApiError extends Error {
  constructor(code, message, detail = null, cause = null) {
    super(message);
    this.name = 'ApiError'; this.code = code; this.detail = detail; this.cause = cause;
  }
}

export function toApiError(error) {
  if (!error) return null;
  if (error instanceof ApiError) return error;
  const msg = String(error.message || error);
  let detail = null;
  try { detail = error.details ? JSON.parse(error.details) : null; } catch { detail = null; }
  const m = msg.match(/DSP:([a-z_]+)/);
  if (m) {
    const code = m[1];
    let text = MESSAGES[code] || MESSAGES.unknown;
    if (code === 'validation' && detail?.rule && VALIDATION[detail.rule]) text = VALIDATION[detail.rule];
    return new ApiError(code, text, detail, error);
  }
  if (error.code === 'PGRST301' || error.code === 'PGRST303' || error.status === 401 || /jwt expired|invalid jwt|refresh token/i.test(msg)) {
    return new ApiError('auth', MESSAGES.auth, null, error);
  }
  if (/failed to fetch|networkerror|load failed|fetch failed|network request failed|err_internet|timeout/i.test(msg) || (typeof navigator !== 'undefined' && navigator.onLine === false)) {
    return new ApiError('network', MESSAGES.network, null, error);
  }
  if (error.code === '42501') return new ApiError('forbidden', MESSAGES.forbidden, null, error);
  return new ApiError('unknown', MESSAGES.unknown, null, error);
}

export async function rpc(name, args = {}) {
  let res;
  try { res = await sb().rpc(name, args); } catch (e) { throw toApiError(e); }
  if (res.error) throw toApiError(res.error);
  return res.data;
}

// Best-effort request that survives page unload (lease release). Never throws.
export function rpcKeepalive(name, args, token) {
  try {
    if (!token) return;
    fetch(`${config.supabaseUrl}/rest/v1/rpc/${name}`, {
      method: 'POST', keepalive: true,
      headers: { apikey: config.supabaseKey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    }).catch(() => {});
  } catch { /* ignore */ }
}

// Admin edge function (invitations, auth bans). Requires an active admin session.
export async function adminFunction(body) {
  const { data } = await sb().auth.getSession();
  const token = data.session?.access_token;
  let r;
  try {
    r = await fetch(`${config.functionsUrl}/admin-users`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, apikey: config.supabaseKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) { throw toApiError(e); }
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(out.code || 'unknown', out.error || MESSAGES[out.code] || MESSAGES.unknown, out);
  return out;
}

export const messages = MESSAGES;
