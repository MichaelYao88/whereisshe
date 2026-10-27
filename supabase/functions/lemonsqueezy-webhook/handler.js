// Lemon Squeezy webhook -> profiles.premium / premium_until.
// Lemon Squeezy signs the raw body with HMAC-SHA256 (hex) using the webhook's signing secret, in the X-Signature header.
// The checkout link carries the Supabase user id as custom data (checkout[custom][user_id]); Lemon Squeezy echoes it
// back in meta.custom_data.user_id on every order/subscription event.
// A Ranki checkout reuses this variant but sends a Ranki uid (and checkout[custom][app]=ranki). When that uid is
// missing or isn't a WhereIsShe profile, Premium is granted by attributes.user_email instead: a confirmed
// WhereIsShe account, or a row in premium_pending until that email signs up and confirms.
import { UUID_RE, hmacHex, safeEqual, serviceKey, adminHeaders, json } from "../_shared/util.js";

const ACTIVE = new Set(["active", "on_trial", "past_due"]);        // subscription statuses that keep Premium on
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function buyerEmail(attributes) {
  const e = String((attributes && attributes.user_email) || "").trim().toLowerCase();
  return EMAIL_RE.test(e) && e.length <= 320 ? e : null;
}

export async function handleLemonWebhook(req, env, now = () => new Date()) {
  if (req.method !== "POST") return json(405, { error: "POST only" });
  const secret = env.LEMONSQUEEZY_WEBHOOK_SECRET, url = env.SUPABASE_URL, key = serviceKey(env);
  if (!secret || !url || !key) return json(500, { error: "function not configured (LEMONSQUEEZY_WEBHOOK_SECRET / SUPABASE_URL / service key)" });
  const raw = await req.text();
  const sig = req.headers.get("x-signature") || "";
  if (!sig || !safeEqual(sig.toLowerCase(), await hmacHex(secret, raw))) return json(401, { error: "bad signature" });
  let body; try { body = JSON.parse(raw); } catch (_) { return json(400, { error: "bad json" }); }
  const meta = body.meta || {}, event = meta.event_name || "", data = body.data || {}, a = data.attributes || {};
  const uid = meta.custom_data && meta.custom_data.user_id;
  const testMode = !!meta.test_mode;
  const allowTest = String(env.WIS_ALLOW_TEST_MODE ?? "true").toLowerCase() !== "false";
  const log = async (extra = {}, loggedUser = uid) => { try { await fetch(`${url}/rest/v1/premium_events`, { method: "POST", headers: adminHeaders(key, { "Content-Type": "application/json", Prefer: "return=minimal" }),
    body: JSON.stringify({ event, user_id: UUID_RE.test(loggedUser || "") ? loggedUser : null, ls_id: String(data.id || ""), test_mode: testMode, payload: { ...body, _note: extra.note || null } }) }); } catch (_) {} };
  // 200 (not an error) for events we deliberately ignore, so Lemon Squeezy doesn't retry them forever
  if (testMode && !allowTest) { await log({ note: "test mode ignored" }); return json(200, { ignored: "test mode events disabled (WIS_ALLOW_TEST_MODE=false)" }); }
  // Only this store's Premium product: LEMONSQUEEZY_STORE_ID (optional, numeric) and LEMONSQUEEZY_VARIANT_IDS (optional, comma list).
  const store = String(a.store_id ?? "");
  if (env.LEMONSQUEEZY_STORE_ID && store && store !== String(env.LEMONSQUEEZY_STORE_ID).trim()) {
    await log({ note: "other store" }); return json(200, { ignored: `store ${store} is not this store` }); }
  const variant = String(a.variant_id ?? (a.first_order_item && a.first_order_item.variant_id) ?? "");
  if (env.LEMONSQUEEZY_VARIANT_IDS && variant && !env.LEMONSQUEEZY_VARIANT_IDS.split(",").map(s => s.trim()).includes(variant)) {
    await log({ note: "other variant" }); return json(200, { ignored: `variant ${variant} is not a Premium variant` }); }

  const days = parseInt(env.WIS_PREMIUM_DAYS || "0", 10);   // one-time purchase: 0 = no end date, else N days
  let patch = null;
  if (event === "order_created") {
    if (a.status === "paid") patch = { premium: true, premium_until: days > 0 ? new Date(now().getTime() + days * 864e5).toISOString() : null, ls_order_id: String(data.id), ls_status: "paid" };
    else patch = { ls_order_id: String(data.id), ls_status: a.status || "unknown" };
  } else if (event === "order_refunded") {
    patch = { premium: false, premium_until: now().toISOString(), ls_status: "refunded" };
  } else if (event.startsWith("subscription_") && data.type === "subscriptions") {
    const st = a.status || "";
    if (ACTIVE.has(st)) patch = { premium: true, premium_until: a.renews_at || null };
    else if (st === "cancelled") patch = { premium: true, premium_until: a.ends_at || now().toISOString() };   // keeps Premium until the paid period ends
    else patch = { premium: false, premium_until: a.ends_at || now().toISOString() };                         // expired, unpaid, paused
    Object.assign(patch, { ls_subscription_id: String(data.id), ls_status: st });
  } else { await log({ note: "event not handled" }); return json(200, { ignored: `event ${event}` }); }
  if (a.customer_id != null) patch.ls_customer_id = String(a.customer_id);
  if (testMode) patch.ls_status = `${patch.ls_status || ""} (test)`.trim();

  const userId = UUID_RE.test(uid || "") ? uid : null;
  const email = buyerEmail(a);
  const res = await fetch(`${url}/rest/v1/rpc/wis_apply_premium`, { method: "POST", headers: adminHeaders(key, { "Content-Type": "application/json", Accept: "application/json" }),
    body: JSON.stringify({ p_user_id: userId, p_email: email, p_patch: patch }) });
  if (!res.ok) { await log({ note: `profile update failed ${res.status}` }); return json(500, { error: `profile update failed (${res.status})` }); }   // 5xx -> Lemon Squeezy retries
  let out = await res.json();
  if (typeof out === "string") { try { out = JSON.parse(out); } catch (_) { out = null; } }
  if (!out || typeof out !== "object") { await log({ note: "profile update failed bad rpc" }); return json(500, { error: "profile update failed (bad rpc)" }); }
  if (out.ignored) { await log({ note: out.note || out.ignored }); return json(200, { ignored: out.ignored }); }
  if (out.pending) { await log({ note: out.note || "pending email" }, null); return json(200, { ok: true, pending: true, event, email: out.email || email }); }
  await log({}, out.user_id || null);
  return json(200, { ok: true, event, user_id: out.user_id, premium: out.premium, premium_until: out.premium_until });
}
