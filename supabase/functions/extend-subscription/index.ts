// Verifies a Lenco payment (sandbox or live) with the secret key and extends
// the caller's subscription. Auth: the signed-in owner's JWT; the business
// must belong to them.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { verifyAndExtendSubscription } from "../_shared/subscription.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Missing authorization" }, 401);

    const caller = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await caller.auth.getUser();
    if (userErr || !userData.user) return json({ error: "Not authenticated" }, 401);

    const body = await req.json().catch(() => null);
    if (!body) return json({ error: "Invalid JSON" }, 400);

    const reference = typeof body.reference === "string" ? body.reference.trim() : "";
    const businessId = typeof body.businessId === "string" ? body.businessId.trim() : "";
    const months = Number(body.months);
    if (!reference || !businessId) return json({ error: "Missing reference or businessId" }, 400);
    if (!Number.isInteger(months) || months < 1 || months > 24) {
      return json({ error: "Invalid months" }, 400);
    }

    const result = await verifyAndExtendSubscription({
      reference,
      businessId,
      months,
      callerId: userData.user.id,
    });
    return json(result);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Payment verification failed" }, 400);
  }
});
