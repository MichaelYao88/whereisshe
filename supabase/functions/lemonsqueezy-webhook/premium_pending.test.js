// Runs the premium_pending migration against an in-memory Postgres (PGlite), including the
// auth.users trigger. Skips when @electric-sql/pglite is not installed.
//   npm install --no-save @electric-sql/pglite
//   node --test supabase/functions/lemonsqueezy-webhook/premium_pending.test.js
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const migration = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../migrations/20261027120000_premium_pending.sql"), "utf8");
const WIS = "11111111-1111-4111-8111-111111111111";
const RANKI = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";

let PGlite;
try { ({ PGlite } = await import("@electric-sql/pglite")); }
catch { PGlite = null; }

async function dbWithMigration() {
  const db = new PGlite();
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create schema if not exists auth;
    create table auth.users (
      id uuid primary key,
      email text,
      email_confirmed_at timestamptz,
      last_sign_in_at timestamptz
    );
    create table public.profiles (
      id uuid primary key references auth.users(id) on delete cascade,
      email text,
      premium boolean not null default false,
      premium_until timestamptz,
      ls_customer_id text,
      ls_order_id text,
      ls_subscription_id text,
      ls_status text,
      banned boolean not null default false,
      banned_reason text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);
  await db.exec(migration);
  return db;
}

const patch = (extra) => ({ premium: true, premium_until: null, ls_order_id: "99", ls_status: "paid", ls_customer_id: "55", ...extra });

async function apply(db, userId, email, body) {
  const { rows } = await db.query("select public.wis_apply_premium($1::uuid, $2::text, $3::jsonb) as out", [userId, email, JSON.stringify(body)]);
  return rows[0].out;
}

async function profile(db, id) {
  const { rows } = await db.query("select id, email, premium, premium_until, ls_customer_id, ls_order_id, ls_subscription_id, ls_status from public.profiles where id = $1", [id]);
  return rows[0] || null;
}

async function pending(db, email) {
  const { rows } = await db.query("select * from public.premium_pending where email = $1", [email]);
  return rows[0] || null;
}

test("email grant, pending grant, confirm, sign-in, and later subscription events", { skip: !PGlite }, async () => {
  const db = await dbWithMigration();
  try {
    // WhereIsShe checkout: the custom user id wins, even before we look at email.
    await db.query("insert into auth.users (id, email, email_confirmed_at) values ($1, 'owner@where.test', now())", [WIS]);
    assert.equal((await profile(db, WIS)).email, "owner@where.test");
    let out = await apply(db, WIS, "someone-else@ranki.test", patch());
    assert.equal(out.ok, true);
    assert.equal(out.user_id, WIS);
    assert.equal(out.premium, true);
    assert.equal((await profile(db, WIS)).ls_customer_id, "55");
    assert.equal(await pending(db, "someone-else@ranki.test"), null);

    // Ranki uid + email with no WhereIsShe account yet: store a pending grant, lower-cased.
    out = await apply(db, RANKI, "Buyer@Ranki.test", patch({ ls_order_id: "100", ls_customer_id: "56" }));
    assert.equal(out.pending, true);
    assert.equal(out.email, "buyer@ranki.test");
    let row = await pending(db, "buyer@ranki.test");
    assert.equal(row.premium, true);
    assert.equal(row.ls_order_id, "100");
    assert.equal(row.ls_customer_id, "56");

    // A later subscription event for that email keeps the order id and adds the subscription.
    out = await apply(db, RANKI, "buyer@ranki.test", {
      premium: true, premium_until: "2026-11-27T00:00:00.000Z", ls_subscription_id: "77", ls_status: "active", ls_customer_id: "56",
    });
    assert.equal(out.pending, true);
    row = await pending(db, "buyer@ranki.test");
    assert.equal(row.ls_order_id, "100");
    assert.equal(row.ls_subscription_id, "77");
    assert.equal(row.ls_status, "active");
    assert.ok(row.premium_until);

    // Signing up does not claim until the email is confirmed.
    await db.query("insert into auth.users (id, email) values ($1, 'buyer@ranki.test')", [OTHER]);
    assert.equal((await profile(db, OTHER)).premium, false);
    assert.ok(await pending(db, "buyer@ranki.test"));
    assert.equal((await db.query("select public.wis_claim_premium_pending($1::uuid) as ok", [OTHER])).rows[0].ok, false);

    // Confirming the email claims the grant and clears the pending row.
    await db.query("update auth.users set email_confirmed_at = now() where id = $1", [OTHER]);
    const claimed = await profile(db, OTHER);
    assert.equal(claimed.premium, true);
    assert.equal(claimed.ls_subscription_id, "77");
    assert.equal(claimed.ls_order_id, "100");
    assert.equal(claimed.ls_status, "active");
    assert.equal(await pending(db, "buyer@ranki.test"), null);

    // The next subscription update finds them by subscription id, not by the Ranki uid.
    out = await apply(db, RANKI, "buyer@ranki.test", {
      premium: true, premium_until: "2026-12-27T00:00:00.000Z", ls_subscription_id: "77", ls_status: "active", ls_customer_id: "56",
    });
    assert.equal(out.user_id, OTHER);
    assert.ok(!out.pending);
    assert.equal((await profile(db, OTHER)).ls_status, "active");

    // A refund finds them by customer id even if the email on the event changed.
    out = await apply(db, null, null, { premium: false, premium_until: "2026-10-27T00:00:00.000Z", ls_status: "refunded", ls_customer_id: "56" });
    assert.equal(out.user_id, OTHER);
    assert.equal((await profile(db, OTHER)).premium, false);
    assert.equal((await profile(db, OTHER)).ls_status, "refunded");

    // A confirmed account is granted immediately; nothing is left pending.
    await db.query("insert into auth.users (id, email, email_confirmed_at, last_sign_in_at) values ($1, 'later@ranki.test', now(), now())", ["44444444-4444-4444-8444-444444444444"]);
    out = await apply(db, RANKI, "Later@Ranki.test", patch({ ls_customer_id: "90", ls_order_id: "200", ls_subscription_id: "88" }));
    assert.equal(out.user_id, "44444444-4444-4444-8444-444444444444");
    assert.equal(await pending(db, "later@ranki.test"), null);

    // No matching profile and no email: same ignore reasons as the old webhook.
    out = await apply(db, RANKI, null, { premium: false, ls_status: "refunded" });
    assert.equal(out.ignored, "no profile for that user id");
    out = await apply(db, null, null, { ls_status: "paid" });
    assert.equal(out.ignored, "no user_id in custom data");

    // Unconfirmed profile.email must not receive a different person's purchase.
    await db.query("insert into auth.users (id, email) values ($1, 'wait@ranki.test')", ["55555555-5555-4555-8555-555555555555"]);
    out = await apply(db, RANKI, "wait@ranki.test", patch({ ls_customer_id: "91", ls_order_id: "201" }));
    assert.equal(out.pending, true);
    assert.equal((await profile(db, "55555555-5555-4555-8555-555555555555")).premium, false);

    // profiles.email match when auth email differs, but only if that account is confirmed.
    await db.query("update public.profiles set email = 'old@ranki.test' where id = $1", [WIS]);
    out = await apply(db, RANKI, "old@ranki.test", { premium: true, premium_until: null, ls_status: "active", ls_subscription_id: "66", ls_customer_id: "70" });
    assert.equal(out.user_id, WIS);
    assert.equal((await profile(db, WIS)).ls_subscription_id, "66");

    // A renewal with no email still updates a pending row by subscription id.
    out = await apply(db, null, "fresh@ranki.test", { premium: true, premium_until: null, ls_status: "active", ls_subscription_id: "42", ls_customer_id: "42" });
    assert.equal(out.pending, true);
    out = await apply(db, null, null, { premium: false, premium_until: "2026-10-01T00:00:00.000Z", ls_status: "expired", ls_subscription_id: "42" });
    assert.equal(out.pending, true);
    row = await pending(db, "fresh@ranki.test");
    assert.equal(row.premium, false);
    assert.equal(row.ls_status, "expired");
    assert.equal(row.ls_customer_id, "42");

    // Google-style insert: already confirmed, so the pending grant is claimed in the same insert.
    out = await apply(db, null, "google@ranki.test", patch({ ls_customer_id: "8", ls_order_id: "8", ls_subscription_id: "8" }));
    assert.equal(out.pending, true);
    await db.query("insert into auth.users (id, email, email_confirmed_at) values ($1, 'Google@Ranki.test', now())", ["66666666-6666-4666-8666-666666666666"]);
    const google = await profile(db, "66666666-6666-4666-8666-666666666666");
    assert.equal(google.premium, true);
    assert.equal(google.ls_subscription_id, "8");
    assert.equal(await pending(db, "google@ranki.test"), null);

    // Sign-in claims a grant that landed after the account was already confirmed.
    await db.query("insert into auth.users (id, email, email_confirmed_at, last_sign_in_at) values ($1, 'signin@ranki.test', now(), now())", ["77777777-7777-4777-8777-777777777777"]);
    await db.query(`insert into public.premium_pending (email, premium, premium_until, ls_status, ls_subscription_id)
      values ('signin@ranki.test', true, null, 'active', '9')`);
    assert.equal((await profile(db, "77777777-7777-4777-8777-777777777777")).premium, false);
    await db.query("update auth.users set last_sign_in_at = now() + interval '1 minute' where id = $1", ["77777777-7777-4777-8777-777777777777"]);
    assert.equal((await profile(db, "77777777-7777-4777-8777-777777777777")).premium, true);
    assert.equal((await profile(db, "77777777-7777-4777-8777-777777777777")).ls_subscription_id, "9");
    assert.equal(await pending(db, "signin@ranki.test"), null);
  } finally {
    await db.close();
  }
});
