import { useCallback, useEffect, useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { lenco, preloadLenco } from "@/lib/lenco";
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
 * Shared "Pay Securely Now" flow used by both the Subscription page and the
 * LockScreen (expiry page): opens the Lenco popup widget, then asks the
 * extend-subscription edge function to verify the payment and extend expiry.
 *
 * Mobile-money confirmations often land as "pending" first, so verification is
 * retried with backoff on the SAME reference before giving up. The reference is
 * persisted while a verification outcome is still open, so a payment that is
 * approved late (e.g. the MoMo prompt was cancelled, then re-sent and approved
 * minutes later) is still picked up automatically on the next page load —
 * without the user having to pay again.
 */

type PendingPayment = {
  reference: string;
  businessId: string;
  months: number;
  ts: number;
};

const PENDING_KEY = "lenco_pending_payment";
const PENDING_TTL_MS = 30 * 60 * 1000;

type VerifyStatus = "success" | "pending" | "consumed" | "error";
type VerifyResult = { status: VerifyStatus; data?: Record<string, unknown>; message?: string };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const readPending = (businessId?: string): PendingPayment | null => {
  if (!businessId) return null;
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const pending = JSON.parse(raw) as PendingPayment;
    if (pending?.businessId !== businessId || !pending?.reference) return null;
    if (Date.now() - pending.ts > PENDING_TTL_MS) {
      localStorage.removeItem(PENDING_KEY);
      return null;
    }
    return pending;
  } catch {
    return null;
  }
};

const writePending = (pending: PendingPayment) => {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
  } catch {
    /* private mode etc. — background verification just won't run */
  }
};

const clearPending = () => {
  try {
    localStorage.removeItem(PENDING_KEY);
  } catch {
    /* ignore */
  }
};

const classify = (message: string): VerifyStatus => {
  if (/pending/i.test(message)) return "pending";
  if (/already been used/i.test(message)) return "consumed";
  return "error";
};

const verifyRenewal = async (
  reference: string,
  businessId: string,
  months: number,
): Promise<VerifyResult> => {
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
    return { status: classify(msg), message: msg };
  }
  if (data?.error) return { status: classify(String(data.error)), message: String(data.error) };
  if (!data?.success) return { status: "error", message: "Payment could not be confirmed" };
  return { status: "success", data };
};

/**
 * Retries "pending" outcomes with growing backoff (3s / 6s / 10s / 15s) so a
 * typical mobile-money confirmation settles without the user doing anything.
 * Non-pending outcomes are returned immediately.
 */
const verifyWithRetry = async (
  reference: string,
  businessId: string,
  months: number,
  attempts = 5,
): Promise<VerifyResult> => {
  const backoff = [3000, 6000, 10000, 15000];
  let result = await verifyRenewal(reference, businessId, months);
  for (let attempt = 1; attempt < attempts && result.status === "pending"; attempt++) {
    await sleep(backoff[attempt - 1] ?? 15000);
    result = await verifyRenewal(reference, businessId, months);
  }
  return result;
};

export function useLencoRenewal({ businessId, paymentCode, email, months, amountZmw, onRenewed }: LencoRenewalArgs) {
  const { toast } = useToast();
  const [paying, setPaying] = useState(false);

  useEffect(() => {
    preloadLenco();

    // A previous attempt may still be settling (cancelled widget, late MoMo
    // approval). Verify it quietly in the background — never blocks the UI.
    const pending = readPending(businessId);
    if (!pending) return;
    let cancelled = false;

    (async () => {
      const result = await verifyWithRetry(pending.reference, pending.businessId, pending.months, 3);
      if (cancelled) return;
      if (result.status === "success") {
        clearPending();
        toast({
          title: "Payment confirmed",
          description: `Subscription extended to ${new Date(String(result.data?.newExpiry)).toLocaleDateString()}.`,
        });
        await onRenewed?.(String(result.data?.newExpiry));
      } else if (result.status === "consumed") {
        clearPending();
      } else if (result.status === "error" && !/network|fetch|failed/i.test(result.message ?? "")) {
        // Definitive server rejection (declined, wrong amount, expired ref).
        clearPending();
      }
      // "pending" or a network error keeps the reference for the next load.
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

      // Persist before opening the widget: if the popup is closed or the MoMo
      // prompt is approved late, the background check above still finds it.
      writePending({ reference, businessId, months, ts: Date.now() });

      await lenco.openCheckout({ reference, amount: amountZmw, email });

      const result = await verifyWithRetry(reference, businessId, months);

      if (result.status === "success") {
        clearPending();
        toast({
          title: "Payment successful",
          description: `Subscription extended to ${new Date(String(result.data?.newExpiry)).toLocaleDateString()}.`,
        });
        await onRenewed?.(String(result.data?.newExpiry));
      } else if (result.status === "consumed") {
        clearPending();
        toast({
          title: "Already processed",
          description: "This payment was already applied — your subscription is up to date.",
        });
      } else if (result.status === "pending") {
        // Keep the reference: the background check will finish this later.
        toast({
          title: "Confirming payment",
          description: "Your payment is confirming — your subscription will update automatically. Please don't pay again.",
        });
      } else {
        const message = result.message ?? "Could not complete payment.";
        if (/closed before completion/i.test(message)) {
          // Widget closed, but the MoMo prompt may be re-sent and approved
          // later — keep the reference so a late payment still counts.
          toast({
            title: "Payment window closed",
            description: "If you still complete the payment on your phone, your subscription will update automatically.",
          });
        } else {
          clearPending();
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
  }, [businessId, paymentCode, email, months, amountZmw, onRenewed, paying, toast]);

  return { paying, payWithLenco };
}
