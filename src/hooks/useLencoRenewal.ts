import { useCallback, useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { lenco } from "@/lib/lenco";
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
 */
export function useLencoRenewal({ businessId, paymentCode, email, months, amountZmw, onRenewed }: LencoRenewalArgs) {
  const { toast } = useToast();
  const [paying, setPaying] = useState(false);

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
      await lenco.openCheckout({ reference, amount: amountZmw, email });

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
        throw new Error(msg);
      }
      if (data?.error) throw new Error(data.error);
      if (!data?.success) throw new Error("Payment could not be confirmed");

      toast({
        title: "Payment successful",
        description: `Subscription extended to ${new Date(data.newExpiry).toLocaleDateString()}.`,
      });
      await onRenewed?.(data.newExpiry);
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
