import { useEffect, useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { AlertTriangle, RefreshCw, MessageCircle, Phone, Copy, CheckCircle2 } from 'lucide-react';
import { useOnlineStatus } from '@/hooks/useOnlineStatus';
import { useToast } from '@/hooks/use-toast';
import { useAuthContext } from '@/contexts/AuthContext';
import { PAYMENT_DETAILS, resolveMonthlyPrice } from '@/lib/paymentDetails';
import { MonthSelector } from '@/components/MonthSelector';
import { supabase } from '@/integrations/supabase/client';

interface LockScreenProps {
  paymentCode: string;
  businessId?: string;
  daysExpired?: number;
  onRetrySync: () => Promise<void> | void;
  isSyncing?: boolean;
}

const buildWhatsAppRenewalLink = (paymentCode: string, months: number, amount: number) => {
  const message = [
    'Hello Sale Point Team,',
    '',
    `I want to renew my subscription for ${months} month${months > 1 ? 's' : ''} (ZMW ${amount}).`,
    `My Payment Code is: ${paymentCode}`,
    '',
    'Please send me mobile money payment details.',
  ].join('\n');
  return `https://wa.me/${PAYMENT_DETAILS.whatsappNumberE164}?text=${encodeURIComponent(message)}`;
};

const LockScreen = ({ paymentCode, businessId, daysExpired = 0, onRetrySync, isSyncing }: LockScreenProps) => {
  const { isOnline } = useOnlineStatus();
  const { toast } = useToast();
  const [months, setMonths] = useState(1);
  const [activeCashiers, setActiveCashiers] = useState(0);
  const [planTier, setPlanTier] = useState<string | null>(null);
  const [lockedPriceZmw, setLockedPriceZmw] = useState<number | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [checking, setChecking] = useState(false);
  const { role } = useAuthContext();
  const isCashier = role === "cashier";

  useEffect(() => {
    if (!businessId) return;
    void (async () => {
      const { count } = await supabase
        .from('business_cashiers')
        .select('id', { count: 'exact', head: true })
        .eq('business_id', businessId)
        .eq('is_active', true);
      setActiveCashiers(count ?? 0);
      const { data: biz } = await supabase
        .from('businesses')
        .select('plan_tier, monthly_price_zmw')
        .eq('id', businessId)
        .maybeSingle();
      setPlanTier(((biz as any)?.plan_tier as string | null) ?? null);
      const locked = (biz as any)?.monthly_price_zmw;
      setLockedPriceZmw(locked !== null && locked !== undefined ? Number(locked) : null);
    })();
  }, [businessId]);

  const tier = resolveMonthlyPrice({
    lockedPriceZmw,
    adminPlanLabel: planTier,
    activeCashiers,
  });
  const isCustom = tier.priceZmw === 0;
  const amountZmw = isCustom ? 0 : months * tier.priceZmw;

  const handleWhatsApp = () => {
    window.open(buildWhatsAppRenewalLink(paymentCode, months, amountZmw), '_blank');
  };

  const copyNumber = () => {
    navigator.clipboard.writeText(PAYMENT_DETAILS.whatsappDisplay);
    toast({ title: 'Copied', description: PAYMENT_DETAILS.whatsappDisplay });
  };

  const handleManualPayment = useCallback(async () => {
    if (!businessId) return;
    setSubmitting(true);
    try {
      const { error } = await supabase.from("payments").insert({
        business_id: businessId,
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
  }, [businessId, amountZmw, months, tier.label, toast]);

  return (
    <div className="lock-overlay">
      <div className="w-full max-w-md p-4 animate-fade-in max-h-[90vh] overflow-y-auto">
        <Card className="border-destructive/30 shadow-xl">
          <CardHeader className="text-center pb-2">
            <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-destructive/10 mx-auto mb-3">
              <AlertTriangle className="w-7 h-7 text-destructive" />
            </div>
            <CardTitle className="text-lg text-destructive">Subscription Expired</CardTitle>
            <CardDescription className="text-sm">
              Your subscription has expired. Renew to continue using Sale Point.
            </CardDescription>
          </CardHeader>

          <CardContent className="space-y-4">
            <div className="text-center text-xs text-muted-foreground">
              Reference: <span className="font-mono font-semibold">{paymentCode}</span>
            </div>

            {isCashier ? (
              <div className="bg-muted/50 rounded-lg p-6 text-center space-y-3">
                <p className="text-sm text-muted-foreground">Your subscription has expired. Please contact the business owner to renew.</p>
                <Button variant="outline" className="w-full" onClick={async () => { setChecking(true); try { await onRetrySync(); } finally { setChecking(false); } }} disabled={isSyncing || checking}>
                  <RefreshCw className={`mr-2 h-4 w-4 ${(isSyncing || checking) ? 'animate-spin' : ''}`} />
                  {(isSyncing || checking) ? 'Checking...' : 'Check Status'}
                </Button>
              </div>
            ) : isCustom ? (
              <div className="bg-muted/50 rounded-lg p-4 text-center space-y-2">
                <p className="text-sm text-muted-foreground">Custom pricing — contact admin for your renewal amount.</p>
              </div>
            ) : (
              <><div>
              <p className="text-sm font-medium mb-2">Months</p>
              <MonthSelector months={months} onChange={setMonths} size="sm" />
            </div>

            <div className="bg-muted/50 rounded-lg p-3 text-center space-y-1">
              <p className="text-xs text-muted-foreground">Total</p>
              <p className="text-2xl font-display font-bold text-primary">ZMW {amountZmw}</p>
            </div></>
            )}
            {isCashier ? null : isCustom ? (
              <div className="flex flex-col items-center gap-3 py-4">
                <p className="text-sm text-muted-foreground text-center">Contact admin to set up your custom plan.</p>
                <div className="bg-secondary rounded-lg p-3 space-y-2">
                  <p className="text-xs text-muted-foreground text-center">Reach out via WhatsApp:</p>
                  <div className="flex items-center justify-center gap-2 flex-wrap">
                    <a href={`tel:${PAYMENT_DETAILS.whatsappNumberE164}`} className="inline-flex items-center gap-2 font-mono text-sm font-semibold text-primary">
                      <Phone className="w-4 h-4" />
                      {PAYMENT_DETAILS.whatsappDisplay}
                    </a>
                    <Button variant="ghost" size="sm" onClick={copyNumber} aria-label="Copy">
                      <Copy className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
                <Button variant="outline" className="w-full" onClick={async () => { setChecking(true); try { await onRetrySync(); } finally { setChecking(false); } }} disabled={isSyncing || checking}>
                  <RefreshCw className={`mr-2 h-4 w-4 ${(isSyncing || checking) ? 'animate-spin' : ''}`} />
                  {(isSyncing || checking) ? 'Checking...' : 'I Have Paid — Check Status'}
                </Button>
              </div>
            ) : !submitted ? (
              <>
                <div className="bg-muted rounded-lg p-3 space-y-2">
                  <p className="text-sm font-medium">Manual Payment Details</p>
                  <div className="space-y-1 text-sm">
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
                    Send exact amount to any number above, then click "I've Made Payment".
                  </p>
                </div>

                <Button
                  variant="pos"
                  className="w-full py-5"
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
                    If WhatsApp doesn't open, call or text us:
                  </p>
                  <div className="flex items-center justify-center gap-2 flex-wrap">
                    <a
                      href={`tel:${PAYMENT_DETAILS.whatsappNumberE164}`}
                      className="inline-flex items-center gap-2 font-mono text-sm font-semibold text-primary"
                    >
                      <Phone className="w-4 h-4" />
                      {PAYMENT_DETAILS.whatsappDisplay}
                    </a>
                    <Button variant="ghost" size="sm" onClick={copyNumber} aria-label="Copy">
                      <Copy className="w-4 h-4" />
                    </Button>
                  </div>
                </div>

                <Button variant="outline" className="w-full" onClick={async () => { setChecking(true); try { await onRetrySync(); } finally { setChecking(false); } }} disabled={isSyncing || checking}>
                  <RefreshCw className={`mr-2 h-4 w-4 ${(isSyncing || checking) ? 'animate-spin' : ''}`} />
                  {(isSyncing || checking) ? 'Checking...' : 'I Have Paid — Check Status'}
                </Button>
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
                <Button variant="outline" onClick={() => { window.location.href = isCashier ? '/pos' : '/dashboard'; }} className="w-full">
                  Back to {isCashier ? 'POS' : 'Dashboard'}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default LockScreen;
