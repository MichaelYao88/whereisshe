// Recompute community_snapshots. Supabase injects SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY into the function environment. Call it on a
// 12-hour schedule with Authorization: Bearer <service role key>.
// Optional extra: set CRON_SECRET and send that bearer token instead.
import { createClient } from "npm:@supabase/supabase-js@2";

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method", { status: 405 });
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const cron = Deno.env.get("CRON_SECRET") ?? "";
  if (!service || !token || (token !== service && token !== cron)) {
    return new Response("unauthorized", { status: 401 });
  }
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  if (!url) return new Response("misconfigured", { status: 500 });
  const sb = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await sb.rpc("refresh_community_snapshots");
  if (error) return new Response(error.message, { status: 500 });
  return new Response(JSON.stringify({ ok: true, rows: data }), {
    headers: { "content-type": "application/json" },
  });
});
