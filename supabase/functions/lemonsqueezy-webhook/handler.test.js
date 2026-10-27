// Local harness for the Lemon Squeezy webhook. No Deno and no network:
//   node --test supabase/functions/lemonsqueezy-webhook/handler.test.js
import assert from "node:assert/strict";
import { test } from "node:test";
import { hmacHex } from "../_shared/util.js";
import { buyerEmail, handleLemonWebhook } from "./handler.js";

const SECRET = "test-secret";
const WIS = "11111111-1111-4111-8111-111111111111";
const RANKI = "22222222-2222-4222-8222-222222222222";
const ENV = {
  LEMONSQUEEZY_WEBHOOK_SECRET: SECRET,
  SUPABASE_URL: "https://db.test",
  SUPABASE_SERVICE_ROLE_KEY: "service-role",
  LEMONSQUEEZY_STORE_ID: "504191",
  LEMONSQUEEZY_VARIANT_IDS: "2280847",
  WIS_ALLOW_TEST_MODE: "true",
};

function order(over = {}) {
  const body = {
    meta: { event_name: "order_created", custom_data: { user_id: WIS }, test_mode: false },
    data: { type: "orders", id: "99", attributes: { store_id: 504191, customer_id: 55, user_email: "Buyer@Example.com", status: "paid", first_order_item: { variant_id: 2280847 } } },
  };
  if (over.meta) Object.assign(body.meta, over.meta);
  if ("custom_data" in over) body.meta.custom_data = over.custom_data;
  if (over.attributes) Object.assign(body.data.attributes, over.attributes);
  if (over.data) Object.assign(body.data, over.data);
  if (over.event) body.meta.event_name = over.event;
  return body;
}

async function post(body, env = ENV, { sign = true, raw } = {}) {
  const payload = raw ?? JSON.stringify(body);
  const headers = {};
  if (sign) headers["x-signature"] = await hmacHex(SECRET, payload);
  return new Request("https://example.test/hook", { method: "POST", headers, body: payload });
}

function installFetch(rpcResult = { ok: true, user_id: WIS, premium: true, premium_until: null }, rpcStatus = 200) {
  const calls = [];
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const rec = { url: String(url), method: opts.method || "GET", body: opts.body ? JSON.parse(opts.body) : null };
    calls.push(rec);
    if (String(url).includes("/premium_events")) return new Response(null, { status: 201 });
    if (String(url).includes("/rpc/wis_apply_premium")) return new Response(JSON.stringify(rpcResult), { status: rpcStatus, headers: { "Content-Type": "application/json" } });
    return new Response("unexpected", { status: 500 });
  };
  return { calls, restore: () => { globalThis.fetch = prev; } };
}

test("buyerEmail keeps a normal address and drops junk", () => {
  assert.equal(buyerEmail({ user_email: "  Buyer@Example.com " }), "buyer@example.com");
  assert.equal(buyerEmail({ user_email: "not-an-email" }), null);
  assert.equal(buyerEmail({}), null);
});

test("rejects non-POST, a bad signature, bad json, and a missing secret", async () => {
  const net = installFetch();
  try {
    assert.equal((await handleLemonWebhook(new Request("https://example.test/hook"), ENV)).status, 405);
    const unsigned = await post(order(), ENV, { sign: false });
    assert.equal((await handleLemonWebhook(unsigned, ENV)).status, 401);
    const bad = await post(order(), ENV, { raw: "{", sign: true });
    assert.equal((await handleLemonWebhook(bad, ENV)).status, 400);
    const noSecret = await post(order(), { ...ENV, LEMONSQUEEZY_WEBHOOK_SECRET: "" });
    assert.equal((await handleLemonWebhook(noSecret, { ...ENV, LEMONSQUEEZY_WEBHOOK_SECRET: "" })).status, 500);
    assert.equal(net.calls.length, 0);
  } finally { net.restore(); }
});

test("ignored events stay 200 and never grant", async () => {
  const cases = [
    { name: "test mode", env: { ...ENV, WIS_ALLOW_TEST_MODE: "false" }, body: order({ meta: { test_mode: true } }), note: "test mode ignored" },
    { name: "other store", body: order({ attributes: { store_id: 1 } }), note: "other store" },
    { name: "other variant", body: order({ attributes: { first_order_item: { variant_id: 1 } } }), note: "other variant" },
    { name: "unhandled", body: order({ event: "subscription_payment_success", data: { type: "subscription-invoices" } }), note: "event not handled" },
  ];
  for (const c of cases) {
    const net = installFetch();
    try {
      const res = await handleLemonWebhook(await post(c.body), c.env || ENV);
      assert.equal(res.status, 200, c.name);
      const json = await res.json();
      assert.ok(json.ignored, c.name);
      assert.equal(net.calls.length, 1, c.name);
      assert.match(net.calls[0].url, /premium_events$/);
      assert.equal(net.calls[0].body.payload._note, c.note);
    } finally { net.restore(); }
  }
});

test("WhereIsShe user id is granted with the same paid-order patch", async () => {
  const net = installFetch();
  const now = new Date("2026-10-27T00:00:00.000Z");
  try {
    const res = await handleLemonWebhook(await post(order()), ENV, () => now);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, event: "order_created", user_id: WIS, premium: true, premium_until: null });
    const rpc = net.calls.find(c => c.url.includes("wis_apply_premium"));
    assert.equal(rpc.body.p_user_id, WIS);
    assert.equal(rpc.body.p_email, "buyer@example.com");
    assert.deepEqual(rpc.body.p_patch, { premium: true, premium_until: null, ls_order_id: "99", ls_status: "paid", ls_customer_id: "55" });
    const log = net.calls.find(c => c.url.includes("premium_events"));
    assert.equal(log.body.user_id, WIS);
    assert.equal(log.body.payload._note, null);
  } finally { net.restore(); }
});

test("a Ranki uid is passed through and a pending grant is not logged as that uid", async () => {
  const net = installFetch({ ok: true, pending: true, email: "buyer@example.com", note: "pending email" });
  try {
    const body = order({ custom_data: { user_id: RANKI, app: "ranki" } });
    const res = await handleLemonWebhook(await post(body), ENV);
    assert.deepEqual(await res.json(), { ok: true, pending: true, event: "order_created", email: "buyer@example.com" });
    const rpc = net.calls.find(c => c.url.includes("wis_apply_premium"));
    assert.equal(rpc.body.p_user_id, RANKI);
    assert.equal(rpc.body.p_email, "buyer@example.com");
    const log = net.calls.find(c => c.url.includes("premium_events"));
    assert.equal(log.body.user_id, null);
    assert.equal(log.body.payload._note, "pending email");
    assert.equal(log.body.payload.meta.custom_data.user_id, RANKI);
  } finally { net.restore(); }
});

test("missing custom user id still grants by the order email", async () => {
  const net = installFetch({ ok: true, user_id: WIS, premium: true, premium_until: "2026-11-27T00:00:00+00:00" });
  try {
    const body = order({ custom_data: { app: "ranki" } });
    const res = await handleLemonWebhook(await post(body), ENV);
    const json = await res.json();
    assert.equal(json.ok, true);
    assert.equal(json.user_id, WIS);
    assert.equal(json.premium_until, "2026-11-27T00:00:00+00:00");
    const rpc = net.calls.find(c => c.url.includes("wis_apply_premium"));
    assert.equal(rpc.body.p_user_id, null);
    assert.equal(rpc.body.p_email, "buyer@example.com");
    const log = net.calls.find(c => c.url.includes("premium_events"));
    assert.equal(log.body.user_id, WIS);
  } finally { net.restore(); }
});

test("no user id and no email is ignored, same as before", async () => {
  const net = installFetch({ ignored: "no user_id in custom data", note: "no user_id" });
  try {
    const body = order({ custom_data: null, attributes: { user_email: "" } });
    const res = await handleLemonWebhook(await post(body), ENV);
    assert.deepEqual(await res.json(), { ignored: "no user_id in custom data" });
    const log = net.calls.find(c => c.url.includes("premium_events"));
    assert.equal(log.body.payload._note, "no user_id");
  } finally { net.restore(); }
});

test("subscription status, refunds, unpaid orders, test-mode label, and one-time length", async () => {
  const now = new Date("2026-10-27T03:04:05.000Z");
  const sub = (status, extra = {}) => order({
    event: "subscription_updated",
    data: { type: "subscriptions", id: "77" },
    attributes: { status, renews_at: "2026-11-27T00:00:00.000Z", ends_at: "2026-11-20T00:00:00.000Z", variant_id: 2280847, customer_id: 55, user_email: "a@b.co", ...extra },
  });
  const expectPatch = async (body, patch, env = ENV) => {
    const net = installFetch();
    try {
      const res = await handleLemonWebhook(await post(body), env, () => now);
      assert.equal(res.status, 200);
      const rpc = net.calls.find(c => c.url.includes("wis_apply_premium"));
      assert.deepEqual(rpc.body.p_patch, patch);
    } finally { net.restore(); }
  };
  await expectPatch(sub("active"), { premium: true, premium_until: "2026-11-27T00:00:00.000Z", ls_subscription_id: "77", ls_status: "active", ls_customer_id: "55" });
  await expectPatch(sub("cancelled"), { premium: true, premium_until: "2026-11-20T00:00:00.000Z", ls_subscription_id: "77", ls_status: "cancelled", ls_customer_id: "55" });
  await expectPatch(sub("expired"), { premium: false, premium_until: "2026-11-20T00:00:00.000Z", ls_subscription_id: "77", ls_status: "expired", ls_customer_id: "55" });
  await expectPatch(sub("paused", { ends_at: null }), { premium: false, premium_until: now.toISOString(), ls_subscription_id: "77", ls_status: "paused", ls_customer_id: "55" });
  await expectPatch(order({ event: "order_refunded" }), { premium: false, premium_until: now.toISOString(), ls_status: "refunded", ls_customer_id: "55" });
  await expectPatch(order({ attributes: { status: "pending" } }), { ls_order_id: "99", ls_status: "pending", ls_customer_id: "55" });
  await expectPatch(order({ meta: { test_mode: true } }), { premium: true, premium_until: null, ls_order_id: "99", ls_status: "paid (test)", ls_customer_id: "55" });
  await expectPatch(order(), { premium: true, premium_until: "2026-11-06T03:04:05.000Z", ls_order_id: "99", ls_status: "paid", ls_customer_id: "55" }, { ...ENV, WIS_PREMIUM_DAYS: "10" });
});

test("a failed grant is 500 so Lemon Squeezy retries", async () => {
  const net = installFetch({ message: "no" }, 500);
  try {
    const res = await handleLemonWebhook(await post(order()), ENV);
    assert.equal(res.status, 500);
    const log = net.calls.find(c => c.url.includes("premium_events"));
    assert.equal(log.body.payload._note, "profile update failed 500");
  } finally { net.restore(); }
});
