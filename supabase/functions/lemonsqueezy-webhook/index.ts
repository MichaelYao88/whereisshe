// Supabase Edge Function: Lemon Squeezy webhook. Deploy with JWT verification OFF (Lemon Squeezy sends no Supabase JWT;
// the HMAC signature is checked instead):  supabase functions deploy lemonsqueezy-webhook --no-verify-jwt
// Secrets: LEMONSQUEEZY_WEBHOOK_SECRET (required), WIS_ALLOW_TEST_MODE ("true" while testing, then "false"),
//          LEMONSQUEEZY_VARIANT_IDS (optional, comma list; Premium = 2280847), LEMONSQUEEZY_STORE_ID (optional; mikelyaps = 504191), WIS_PREMIUM_DAYS (optional, one-time purchase length).
import { handleLemonWebhook } from "./handler.js";
Deno.serve(req => handleLemonWebhook(req, Deno.env.toObject()));
