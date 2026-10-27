import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { verifyAndExtendSubscription } from "../_shared/subscription.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

serve(async (req) => {
  // Security check: Only allow requests with a secret token or from internal Supabase Cron
  const authHeader = req.headers.get("Authorization");
  if (authHeader !== `Bearer ${SERVICE_KEY}`) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  try {
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    // 1. Get all pending payments that haven't been verified yet
    const { data: pendingPayments, error: fetchError } = await admin
      .from("pending_payments")
      .select("*")
      .eq("status", "pending")
      .lt("created_at", new Date().toISOString());

    if (fetchError) throw fetchError;
    if (!pendingPayments || pendingPayments.length === 0) {
      return new Response(JSON.stringify({ message: "No pending payments to process" }), { status: 200 });
    }

    console.log(`Processing ${pendingPayments.length} pending payments...`);
    let completedCount = 0;
    let failedCount = 0;

    for (const payment of pendingPayments) {
      try {
        // Manual verification of Lenco status
        const LENCO_BASE_URL = Deno.env.get("LENCO_BASE_URL") ?? "https://sandbox.lenco.co/access/v2";
        const LENCO_SECRET_KEY = Deno.env.get("LENCO_SECRET_KEY")!;
        
        const res = await fetch(
          `${LENCO_BASE_URL}/collections/status/${encodeURIComponent(payment.lenco_reference)}`,
          { headers: { Authorization: `Bearer ${LENCO_SECRET_KEY}` } },
        );
        const body = await res.json().catch(() => null);
 
        if (res.ok && body?.status === "successful") {
          // Payment is successful! We now extend the subscription.
          const { data: biz } = await admin
            .from("businesses")
            .select("id, subscription_expires_at")
            .eq("id", payment.business_id)
            .single();
 
          if (biz) {
            const now = new Date();
            const currentExpiry = biz.subscription_expires_at ? new Date(biz.subscription_expires_at) : null;
            const startPoint = currentExpiry && currentExpiry > now ? currentExpiry : now;
            const newExpiry = new Date(startPoint);
            newExpiry.setMonth(newExpiry.getMonth() + payment.months);
 
            const { error: updateErr } = await admin.from("businesses").update({
              subscription_status: "active",
              subscription_expires_at: newExpiry.toISOString(),
              is_locked: false,
              updated_at: now.toISOString(),
            }).eq("id", payment.business_id);

            if (updateErr) throw updateErr;
 
            // Record in the payments table
            await admin.from("payments").insert({
              business_id: payment.business_id,
              amount: payment.amount,
              status: "approved",
              approved_at: now.toISOString(),
              lenco_reference: payment.lenco_reference,
              notes: `Automated cron renewal: ${payment.months} month(s)`,
            });
 
            await admin.from("pending_payments").update({ status: "completed", verified_at: now.toISOString() }).eq("id", payment.id);
            completedCount++;
          }
        } else if (res.status === 404 || !body?.status) {
          // Still pending or not found yet
          continue;
        } else {
          // Definitive failure in Lenco
          await admin.from("pending_payments").update({ status: "failed" }).eq("id", payment.id);
          failedCount++;
        }
      } catch (e) {
        console.error(`Error processing payment ${payment.lenco_reference}:`, e);
        // Explicitly mark as failed if a database/runtime error occurred during extension
        await admin.from("pending_payments").update({ status: "failed" }).eq("id", payment.id).catch(console.error);
        failedCount++;
      }
    }


    return new Response(
      JSON.stringify({ 
        processed: pendingPayments.length, 
        completed: completedCount, 
        failed: failedCount 
      }), 
      { status: 200 }
    );

  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
});
