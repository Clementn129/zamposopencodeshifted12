import { useNavigate } from "react-router-dom";
import { useEffect, useMemo, useState, useCallback } from "react";
import { ArrowLeft, CreditCard, MessageCircle, Phone, Copy, Users, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import ConnectionStatus from "@/components/ConnectionStatus";
import LockScreen from "@/components/LockScreen";
import { useAuthContext } from "@/contexts/AuthContext";
import { useBusiness } from "@/hooks/useBusiness";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import { useToast } from "@/hooks/use-toast";
import { PAYMENT_DETAILS, resolveMonthlyPrice } from "@/lib/paymentDetails";
import { MonthSelector } from "@/components/MonthSelector";
import { supabase } from "@/integrations/supabase/client";

const buildWhatsAppRenewalLink = (paymentCode: string, months: number, amount: number, cashiers: number) => {
  const lines = [
    "Hello Sale Point Team,",
    "",
    "I want to renew my subscription for " + months + " month" + (months > 1 ? "s" : "") + " (ZMW " + amount + ").",
    "Active cashiers: " + cashiers,
    "My Payment Code is: " + paymentCode,
    "",
    "Please send me mobile money payment details.",
  ];
  return "https://wa.me/" + PAYMENT_DETAILS.whatsappNumberE164 + "?text=" + encodeURIComponent(lines.join("\n"));
};

const Subscription = () => {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { user, isLoading: authLoading } = useAuthContext();
  const { isOnline } = useOnlineStatus();
  const { business, isLoading: bizLoading, refetch, checkSubscriptionStatus } = useBusiness(user?.id);
  const { isLocked, daysRemaining } = checkSubscriptionStatus();
  const [months, setMonths] = useState(1);
  const [activeCashiers, setActiveCashiers] = useState(0);

  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (!business?.id) return;
    supabase
      .from("business_cashiers")
      .select("id", { count: "exact", head: true })
      .eq("business_id", business.id)
      .eq("is_active", true)
      .then(({ count }) => setActiveCashiers(count ?? 0))
      .catch(() => {});
  }, [business?.id]);

  const tier = useMemo(
    () =>
      resolveMonthlyPrice({
        lockedPriceZmw: business?.monthlyPriceZmw,
        adminPlanLabel: business?.planTier,
        activeCashiers,
      }),
    [activeCashiers, business?.planTier, business?.monthlyPriceZmw],
  );
  const isCustom = tier.priceZmw === 0;
  const amountZmw = isCustom ? 0 : months * tier.priceZmw;

  const handleManualPayment = useCallback(async () => {
    if (!business?.id) return;
    setSubmitting(true);
    try {
      const { error } = await supabase.from("payments").insert({
        business_id: business.id,
        amount: amountZmw,
        status: "pending",
        notes: `${months} month(s) subscription renewal (${tier.label})`,
      });
      if (error) throw error;
      setSubmitted(true);
      toast({ title: "Payment submitted", description: "Admin will review and activate your subscription." });
    } catch (e: any) {
      toast({ variant: "destructive", title: "Failed", description: e?.message || "Could not submit payment." });
    } finally {
      setSubmitting(false);
    }
  }, [business?.id, amountZmw, months, tier.label, toast]);

  if (!authLoading && !user) {
    navigate("/auth");
    return null;
  }
  if (authLoading || bizLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <p className="text-muted-foreground">Loading...</p>
      </div>
    );
  }
  if (!business) return null;

  if (isLocked) {
    return (
      <>
        <ConnectionStatus />
        <LockScreen paymentCode={business.paymentCode} businessId={business.id} onRetrySync={refetch} />
      </>
    );
  }

  const handleWhatsApp = () => {
    window.open(buildWhatsAppRenewalLink(business.paymentCode, months, amountZmw, activeCashiers), "_blank");
  };

  const copyNumber = () => {
    navigator.clipboard.writeText(PAYMENT_DETAILS.whatsappDisplay);
    toast({ title: "Copied", description: PAYMENT_DETAILS.whatsappDisplay });
  };

  return (
    <>
      <ConnectionStatus />
      <div className="min-h-screen bg-background safe-area-inset">
        <header className="bg-card border-b border-border px-4 py-4">
          <div className="max-w-4xl mx-auto flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Button variant="ghost" size="icon" onClick={() => navigate("/dashboard")} aria-label="Back">
                <ArrowLeft className="h-5 w-5" />
              </Button>
              <div>
                <h1 className="font-display font-bold text-lg">Manage Subscription</h1>
                <p className="text-xs text-muted-foreground">Reference: {business.paymentCode}</p>
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={refetch}>Refresh</Button>
          </div>
        </header>

        <main className="p-4 max-w-4xl mx-auto space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <CreditCard className="w-5 h-5" />
                Subscription Status
              </CardTitle>
            </CardHeader>
            <CardContent className="flex items-center justify-between flex-wrap gap-3">
              <div>
                <p className="text-sm text-muted-foreground">Remaining days</p>
                <p className="text-2xl font-display font-bold">{daysRemaining}</p>
              </div>
              <div className="text-right">
                <p className="text-sm text-muted-foreground">Current plan</p>
                <p className="font-medium">{tier.label}</p>
                <p className="text-xs text-muted-foreground flex items-center gap-1 justify-end mt-1">
                  <Users className="w-3 h-3" /> {activeCashiers} active cashier{activeCashiers === 1 ? "" : "s"}
                </p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Renew Subscription</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {isCustom ? (
                <div className="bg-muted/50 rounded-lg p-6 text-center space-y-3">
                  <p className="text-sm text-muted-foreground">Custom pricing — contact the admin for your renewal amount.</p>
                  <div className="bg-secondary rounded-lg p-3 space-y-2">
                    <p className="text-xs text-muted-foreground text-center">
                      Reach out via WhatsApp:
                    </p>
                    <div className="flex items-center justify-center gap-2 flex-wrap">
                      <a
                        href={"tel:" + PAYMENT_DETAILS.whatsappNumberE164}
                        className="inline-flex items-center gap-2 font-mono text-base font-semibold text-primary"
                      >
                        <Phone className="w-4 h-4" />
                        {PAYMENT_DETAILS.whatsappDisplay}
                      </a>
                      <Button variant="ghost" size="sm" onClick={copyNumber} aria-label="Copy">
                        <Copy className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                </div>
              ) : (
                <><div>
                <p className="text-sm font-medium mb-2">Months</p>
                <MonthSelector months={months} onChange={setMonths} />
              </div>

              <div className="bg-muted/50 rounded-lg p-4 text-center space-y-1">
                <p className="text-sm text-muted-foreground">Total ({months} x K{tier.priceZmw})</p>
                <p className="text-3xl font-display font-bold text-primary">ZMW {amountZmw}</p>
              </div>

              {!submitted ? (
                <>
                  <div className="bg-muted rounded-lg p-4 space-y-3">
                    <p className="text-sm font-medium">Manual Payment Details</p>
                    <div className="space-y-2 text-sm">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">MTN MoMo:</span>
                        <span className="font-mono font-semibold">{PAYMENT_DETAILS.momo.mtn.number}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Airtel Money:</span>
                        <span className="font-mono font-semibold">{PAYMENT_DETAILS.momo.airtel.number}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Name:</span>
                        <span className="font-semibold">{PAYMENT_DETAILS.momo.mtn.name}</span>
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Send exact amount above to any of these numbers. After payment, click the button below.
                    </p>
                  </div>

                  <Button
                    variant="pos"
                    className="w-full text-lg py-6"
                    onClick={handleManualPayment}
                    disabled={!isOnline || submitting}
                  >
                    {submitting ? "Submitting..." : "I've Made Payment"}
                  </Button>

                  <div className="relative">
                    <div className="absolute inset-0 flex items-center">
                      <span className="w-full border-t" />
                    </div>
                    <div className="relative flex justify-center text-xs uppercase">
                      <span className="bg-card px-2 text-muted-foreground">or</span>
                    </div>
                  </div>

                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={handleWhatsApp}
                    disabled={!isOnline}
                  >
                    <MessageCircle className="w-5 h-5 mr-2" />
                    Renew via WhatsApp
                  </Button>

                  <div className="bg-secondary rounded-lg p-3 space-y-2">
                    <p className="text-xs text-muted-foreground text-center">
                      If WhatsApp does not open, contact us directly:
                    </p>
                    <div className="flex items-center justify-center gap-2 flex-wrap">
                      <a
                        href={"tel:" + PAYMENT_DETAILS.whatsappNumberE164}
                        className="inline-flex items-center gap-2 font-mono text-base font-semibold text-primary"
                      >
                        <Phone className="w-4 h-4" />
                        {PAYMENT_DETAILS.whatsappDisplay}
                      </a>
                      <Button variant="ghost" size="sm" onClick={copyNumber} aria-label="Copy">
                        <Copy className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                </>
              ) : (
                <div className="flex flex-col items-center gap-3 py-4">
                  <CheckCircle2 className="h-12 w-12 text-green-500" />
                  <div className="text-center space-y-1">
                    <p className="font-medium text-green-600">Payment Submitted!</p>
                    <p className="text-sm text-muted-foreground">
                      Your payment request has been sent for review. The admin will activate your subscription once confirmed.
                    </p>
                  </div>
                  <Button onClick={() => navigate("/dashboard")} className="w-full">
                    Back to Dashboard
                  </Button>
                </div>
              )}
              </>
            )}
            </CardContent>
          </Card>
        </main>
      </div>
    </>
  );
};

export default Subscription;
