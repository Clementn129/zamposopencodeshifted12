// Lenco popup widget integration (see "Accept Payments" in Lenco's API docs).
// The browser only ever uses the PUBLIC key — the secret key stays on the
// server, where extend-subscription verifies the payment.
//
// VITE_* env vars override these live defaults (Vercel does not need them).
const WIDGET_SRC =
  import.meta.env.VITE_LENCO_WIDGET_URL || "https://pay.lenco.co/js/v1/inline.js";
const PUBLIC_KEY =
  import.meta.env.VITE_LENCO_PUBLIC_KEY || "pub-272a416b7aed67d8f6555ba9abc18b00b78567b5474afd64";

// How long to wait for the widget to report an outcome before giving up. Long
// enough for a card 3-D Secure redirect and a mobile-money approval, short
// enough that the button never appears frozen.
const WIDGET_CALLBACK_TIMEOUT_MS = 120_000;

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

/** Warm the widget script on page load so the popup can open synchronously
 * inside the click's user-activation window (popup blockers reject late opens). */
export const preloadLenco = (): void => {
  if (document.readyState === "complete") {
    loadWidget().catch(() => {});
  } else {
    window.addEventListener("load", () => loadWidget().catch(() => {}), { once: true });
  }
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
    if (!PUBLIC_KEY) throw new Error("Lenco public key is not configured");
    await loadWidget();
    const w = window as LencoWindow;
    if (!w.LencoPay) throw new Error("Lenco payment window is unavailable");

    return new Promise<CheckoutResult>((resolve, reject) => {
      // Guard against a widget that never fires any callback (script
      // half-loaded, blocked popup, user leaves it open). Without this the
      // caller's `await` would hang forever and the button would spin on
      // "Processing..." with no way out. The reference is already persisted by
      // the caller, so a late/abandoned payment is still reconciled later.
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("Payment window did not respond — if you completed the payment it will be applied automatically."));
      }, WIDGET_CALLBACK_TIMEOUT_MS);
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };

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
          done(() => resolve({ reference: res?.reference || opts.reference })),
        onConfirmationPending: () =>
          done(() => resolve({ reference: opts.reference, pending: true })),
        onClose: () =>
          done(() => reject(new Error("Payment window was closed before completion"))),
      });
    });
  },
};
