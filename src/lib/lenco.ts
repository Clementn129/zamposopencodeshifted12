// Lenco popup widget integration (see "Accept Payments" in Lenco's API docs).
// The browser only ever uses the PUBLIC key — the secret key stays on the
// server, where extend-subscription verifies the payment.
//
// Going live: set VITE_LENCO_WIDGET_URL=https://pay.lenco.co/js/v1/inline.js
// and swap the server's LENCO_BASE_URL / LENCO_SECRET_KEY (supabase secrets set).

const WIDGET_SRC =
  import.meta.env.VITE_LENCO_WIDGET_URL || "https://pay.sandbox.lenco.co/js/v1/inline.js";
const PUBLIC_KEY = import.meta.env.VITE_LENCO_PUBLIC_KEY;

type LencoWindow = Window & {
  LencoPay?: {
    getPaid: (opts: Record<string, unknown>) => void;
  };
};

let widgetLoading: Promise<void> | null = null;

const loadWidget = (): Promise<void> => {
  if (widgetLoading) return widgetLoading;
  widgetLoading = new Promise((resolve, reject) => {
    const w = window as LencoWindow;
    if (w.LencoPay) return resolve();
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${WIDGET_SRC}"]`);
    const script = existing ?? document.createElement("script");
    script.src = WIDGET_SRC;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      widgetLoading = null;
      reject(new Error("Could not load the Lenco payment window"));
    };
    if (!existing) document.head.appendChild(script);
  });
  return widgetLoading;
};

export type CheckoutOptions = {
  reference: string;
  amount: number;
  email: string;
  currency?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
};

export type CheckoutResult = {
  reference: string;
  pending?: boolean;
};

export const lenco = {
  /** Opens the Lenco payment popup. Resolves with the reference on success
   * (or when confirmation is pending — the server then verifies the status). */
  async openCheckout(opts: CheckoutOptions): Promise<CheckoutResult> {
    await loadWidget();
    const w = window as LencoWindow;
    if (!w.LencoPay) throw new Error("Lenco payment window is unavailable");

    return new Promise<CheckoutResult>((resolve, reject) => {
      w.LencoPay!.getPaid({
        key: PUBLIC_KEY,
        reference: opts.reference,
        email: opts.email,
        amount: opts.amount,
        currency: opts.currency ?? "ZMW",
        channels: ["card", "mobile-money"],
        label: "Sale Point subscription renewal",
        ...(opts.firstName ? { customer: { firstName: opts.firstName, lastName: opts.lastName ?? "", phone: opts.phone } } : {}),
        onSuccess: (res: { reference?: string }) =>
          resolve({ reference: res?.reference || opts.reference }),
        onConfirmationPending: () => resolve({ reference: opts.reference, pending: true }),
        onClose: () => reject(new Error("Payment window was closed before completion")),
      });
    });
  },
};
