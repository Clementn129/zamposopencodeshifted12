import { useCallback, useEffect, useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { lenco, preloadLenco } from "@/lib/lenco";
import { getLencoOnlineTotal, getLencoServiceFee } from "@/lib/paymentDetails";
import { supabase } from "@/integrations/supabase/client";

type LencoRenewalArgs = {
  businessId?: string;
  paymentCode?: string;
  email?: string;
  months: number;
  amountZmw: number;
  /** Called after the server confirms the renewal (e.g. refetch business to unlock). */
  onRenewed?: (newExpiry: string) => void | Promise<void>;
};

/**
 * Updated flow: Store the pending reference in SupabaseDB instead of localStorage.
 * This ensures that even if the user closes the tab or switches devices,
 * the server-side worker can eventually find and extend the subscription.
 */

type VerifyStatus = "success" | "pending" | "consumed" | "error";
type VerifyResponse = { status: VerifyStatus; data?: Record<string, unknown>; message?: string };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const verifyRenewal = async (
  reference: string,
  businessId: string,
  months: number,
): Promise<VerifyResponse> => {
  const { data, error } = await supabase.functions.invoke("extend-subscription", {
    body: { reference, businessId, months },
  });

  if (error) {
    let msg = error.message ?? "Verification failed";
    try {
      const detail = await (error as { context?: Response }).context?.json?.();
      if (detail?.error) msg = detail.error;
    } catch {
      /* keep default message */
    }
    
    if (/pending/i.test(msg)) return { status: "pending", message: msg };
    if (/already been used/i.test(msg)) return { status: "consumed", message: msg };
    return { status: "error", message: msg };
  }
  if (data?.error) {
    const msg = String(data.error);
    if (/pending/i.test(msg)) return { status: "pending", message: msg };
    if (/already been used/i.test(msg)) return { status: "consumed", message: msg };
    return { status: "error", message: msg };
  }
  if (!data?.success) return { status: "error", message: "Payment could not be confirmed" };
  return { status: "success", data };
};

const verifyWithRetry = async (
  reference: string,
  businessId: string,
  months: number,
  attempts = 5,
  onPending?: () => void,
): Promise<VerifyResponse> => {
  const backoff = [3000, 6000, 10000, 15000];
  let result = await verifyRenewal(reference, businessId, months);
  if (result.status === "pending") onPending?.();
  for (let attempt = 1; attempt < attempts && result.status === "pending"; attempt++) {
    await sleep(backoff[attempt - 1] ?? 15000);
    result = await verifyRenewal(reference, businessId, months);
  }
  return result;
};

export function useLencoRenewal({ businessId, paymentCode, email, months, amountZmw, onRenewed }: LencoRenewalArgs) {
  const { toast } = useToast();
  const [paying, setPaying] = useState(false);

  const serviceFeeZmw = getLencoServiceFee(amountZmw);
  const onlineTotalZmw = getLencoOnlineTotal(amountZmw);

  useEffect(() => {
    preloadLenco();
    let cancelled = false;

    (async () => {
      if (!businessId) return;

      // Pick the most recent pending row (maybeSingle errors when >1 row matches,
      // which previously broke recovery entirely for businesses with several
      // abandoned checkouts).
      const { data: pending } = await (supabase as any)
        .from("pending_payments")
        .select("*")
        .eq("business_id", businessId)
        .eq("status", "pending")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (cancelled || !pending) return;

      // Don't hammer ancient abandoned checkouts — only auto-resume recent ones.
      const ageMs = Date.now() - new Date(pending.created_at).getTime();
      if (ageMs > 2 * 60 * 60 * 1000) return;

      const result = await verifyWithRetry(pending.lenco_reference, businessId, pending.months, 3);
      if (cancelled) return;

      if (result.status === "success") {
        await (supabase as any)
          .from("pending_payments")
          .update({ status: "completed", verified_at: new Date().toISOString() })
          .eq("lenco_reference", pending.lenco_reference);
        if (cancelled) return;
        toast({
          title: "Payment confirmed",
          description: `Subscription extended to ${new Date(String(result.data?.newExpiry)).toLocaleDateString()}.`,
        });
        await onRenewed?.(String(result.data?.newExpiry));
      } else if (result.status === "consumed") {
        // Already applied by another path — mark it so we stop re-checking forever.
        await (supabase as any)
          .from("pending_payments")
          .update({ status: "completed", verified_at: new Date().toISOString() })
          .eq("lenco_reference", pending.lenco_reference);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [businessId]);

  const payWithLenco = useCallback(async () => {
    if (!businessId || paying) return;
    if (!email) {
      toast({
        variant: "destructive",
        title: "Missing email",
        description: "Your account has no email address — renew via WhatsApp instead.",
      });
      return;
    }
    if (!amountZmw || amountZmw <= 0) {
      toast({
        variant: "destructive",
        title: "Custom pricing",
        description: "Contact the admin for your renewal amount.",
      });
      return;
    }
    setPaying(true);
    try {
      const reference = `sub-${paymentCode}-${Date.now()}`;

      const { error: dbErr } = await (supabase as any).from("pending_payments").insert({
        lenco_reference: reference,
        business_id: businessId,
        months,
        amount: onlineTotalZmw,
        status: "pending",
      });

      if (dbErr) {
        throw new Error(`Could not initialize payment tracking: ${dbErr.message}`);
      }

      await lenco.openCheckout({ reference, amount: onlineTotalZmw, email });

      const result = await verifyWithRetry(reference, businessId, months, 5, () => {
        toast({
          title: "Confirming payment",
          description: "Waiting for your payment to confirm — approve it on your phone if prompted. Your subscription will update automatically; please don't pay again.",
        });
      });

      if (result.status === "success") {
        await (supabase as any).from("pending_payments").update({ status: "completed" }).eq("lenco_reference", reference);
        
        toast({
          title: "Payment successful",
          description: `Subscription extended to ${new Date(String(result.data?.newExpiry)).toLocaleDateString()}.`,
        });
        await onRenewed?.(String(result.data?.newExpiry));
      } else if (result.status === "consumed") {
        toast({
          title: "Already processed",
          description: "This payment was already applied — your subscription is up to date.",
        });
      } else if (result.status === "pending") {
        toast({
          title: "Confirming payment",
          description: "Your payment is confirming — your subscription will update automatically. Please don't pay again.",
        });
      } else {
        const message = result.message ?? "Could not complete payment.";
        if (/closed before completion/i.test(message)) {
          toast({
            title: "Payment window closed",
            description: "If you still complete the payment on your phone, your subscription will update automatically.",
          });
        } else {
          throw new Error(message);
        }
      }
    } catch (e: unknown) {
      toast({
        variant: "destructive",
        title: "Payment Error",
        description: e instanceof Error && e.message ? e.message : "Could not complete payment.",
      });
    } finally {
      setPaying(false);
    }
  }, [businessId, paymentCode, email, months, amountZmw, onlineTotalZmw, onRenewed, paying, toast]);

  return { paying, payWithLenco, serviceFeeZmw, onlineTotalZmw };
}
