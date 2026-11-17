export function supabaseConnection(env) {
  const key = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
  let serverKey = key?.startsWith('sb_secret_');
  if (!serverKey) {
    try { serverKey = JSON.parse(Buffer.from(key.split('.')[1], 'base64url')).role === 'service_role'; }
    catch { serverKey = false; }
  }
  const base = new URL(env.SUPABASE_URL);
  if (base.protocol !== 'https:' || !base.hostname.endsWith('.supabase.co') || base.port ||
      base.username || base.password || base.search || base.hash || base.pathname !== '/' || !serverKey) throw new Error('Invalid Supabase configuration');
  const headers = new Headers({ apikey: key });
  if (!key.startsWith('sb_secret_')) headers.set('authorization', `Bearer ${key}`);
  return { base, headers };
}
