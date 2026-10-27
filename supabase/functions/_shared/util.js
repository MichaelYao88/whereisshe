// Shared helpers for the WhereIsShe Edge Functions. Plain JS (no Deno/Node specifics) so the same code runs in
// Supabase Edge Functions (Deno) and in the local test harness (Node 20+): only fetch + Web Crypto are used.
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const enc = new TextEncoder();
export const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
export async function sha256hex(s) { return hex(await crypto.subtle.digest("SHA-256", enc.encode(s))); }
export async function hmacHex(secret, body) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
}
export function safeEqual(a, b) {           // constant-time compare of two strings
  a = String(a || ""); b = String(b || ""); let d = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}
// The admin key the functions use, from (in order): a WIS_SERVICE_KEY secret you set yourself, the new-style
// SUPABASE_SECRET_KEYS["default"] injected by Supabase, or the legacy SUPABASE_SERVICE_ROLE_KEY. Never in the repo.
export function serviceKey(env) {
  if (env.WIS_SERVICE_KEY) return env.WIS_SERVICE_KEY;
  try { const k = JSON.parse(env.SUPABASE_SECRET_KEYS || "{}").default; if (k) return k; } catch (_) {}
  return env.SUPABASE_SERVICE_ROLE_KEY || "";
}
// New-style keys (sb_secret_/sb_publishable_) go on the apikey header only; legacy JWT keys also on Authorization.
export const isJwt = k => /^eyJ[\w-]*\.[\w-]+\.[\w-]*$/.test(k || "");
export function adminHeaders(key, extra = {}) {
  return { apikey: key, ...(isJwt(key) ? { Authorization: `Bearer ${key}` } : {}), ...extra };
}
export function cors(req, env) {
  const allowed = String(env.ALLOWED_ORIGINS || "https://michaelyao88.github.io").split(",").map(s => s.trim()).filter(Boolean);
  const origin = req.headers.get("origin") || "";
  const ok = allowed.includes("*") || allowed.includes(origin);
  return { "Access-Control-Allow-Origin": ok ? origin || "*" : allowed[0] || "null", "Vary": "Origin",
    "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Max-Age": "600" };
}
export const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
