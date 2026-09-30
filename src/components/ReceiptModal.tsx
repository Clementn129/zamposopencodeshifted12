import { useEffect, useRef, useState } from "react";
import { Download, Printer, X, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";

interface ReceiptItem {
  name: string;
  price: number;
  quantity: number;
  discountType?: string;
  discountValue?: number;
  notes?: string;
  modifiers?: Array<{ name: string; priceAdjustment: number }>;
}

interface BusinessDetails {
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  tpin?: string | null;
}

export type ReceiptSize = "58mm" | "80mm" | "a4";

interface ReceiptModalProps {
  open: boolean;
  onClose: () => void;
  businessName: string;
  businessDetails?: BusinessDetails;
  items: ReceiptItem[];
  subtotal: number;
  total: number;
  paymentMethod: string;
  date: string;
  receiptId: string;
  discountAmount?: number;
  isService?: boolean;
  taxAmount?: number;
  taxLabel?: string;
  customerName?: string | null;
  customerTpin?: string | null;
}

const RECEIPT_SIZE_KEY = "zampos.receiptSize";

const escapeHtml = (str: string | null | undefined): string => {
  if (!str) return "";
  return str.replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m] || m));
};

// Size-specific print CSS. Thermal sizes use 58mm/80mm @page with no margins
// so receipts fit edge-to-edge on the roll. A4 uses standard portrait paper.
const sizeStyles: Record<ReceiptSize, { pageRule: string; printRule: string; previewWidth: number; bodyWidth: string; baseFont: string; headerFont: string; totalFont: string; padding: string; priceWidth: string; qtyWidth: string }> = {
  "58mm": {
    pageRule: "@page { margin: 0; }",
    printRule: "html, body { width: 58mm; } body { padding: 2mm 2.5mm; -webkit-font-smoothing: none; -webkit-text-stroke: 0.2px #000; }",
    previewWidth: 219,
    bodyWidth: "58mm",
    baseFont: "11px",
    headerFont: "14px",
    totalFont: "13px",
    padding: "8px",
    priceWidth: "22mm",
    qtyWidth: "9mm",
  },
  "80mm": {
    pageRule: "@page { margin: 0; }",
    printRule: "html, body { width: 80mm; } body { padding: 3mm 4mm; -webkit-font-smoothing: none; -webkit-text-stroke: 0.2px #000; }",
    previewWidth: 302,
    bodyWidth: "80mm",
    baseFont: "12px",
    headerFont: "16px",
    totalFont: "15px",
    padding: "12px",
    priceWidth: "26mm",
    qtyWidth: "10mm",
  },
  a4: {
    pageRule: "@page { margin: 14mm; size: A4 portrait; }",
    printRule: "html, body { width: auto; } body { padding: 0; max-width: 182mm; margin: 0 auto; }",
    previewWidth: 640,
    bodyWidth: "auto",
    baseFont: "13px",
    headerFont: "22px",
    totalFont: "17px",
    padding: "16px",
    priceWidth: "90px",
    qtyWidth: "60px",
  },
};

const ReceiptModal = ({
  open,
  onClose,
  businessName,
  businessDetails,
  items,
  subtotal,
  total,
  paymentMethod,
  date,
  receiptId,
  discountAmount = 0,
  isService = false,
  taxAmount = 0,
  taxLabel = "VAT",
  customerName,
  customerTpin,
}: ReceiptModalProps) => {
  const receiptRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<ReceiptSize>(() => {
    if (typeof window === "undefined") return "80mm";
    const saved = window.localStorage.getItem(RECEIPT_SIZE_KEY) as ReceiptSize | null;
    return saved === "58mm" || saved === "80mm" || saved === "a4" ? saved : "80mm";
  });
  const [printError, setPrintError] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(RECEIPT_SIZE_KEY, size);
    }
    if (isAndroidApp) {
      const paperWidth = size === "58mm" ? 58 : size === "80mm" ? 80 : 80;
      (window as any).Android.setPaperWidth(paperWidth);
    }
  }, [size]);

  const itemLabel = isService ? "Service" : "Item";
  const qtyPrefix = isService ? "" : "x";
  const netSubtotal = Math.max(0, total - taxAmount);
  const styles = sizeStyles[size];
  const isA4 = size === "a4";

  const getReceiptHTML = () => {
    const safeBusinessName = escapeHtml(businessName);
    const safePhone = escapeHtml(businessDetails?.phone);
    const safeEmail = escapeHtml(businessDetails?.email);
    const safeAddress = escapeHtml(businessDetails?.address);
    const safeTpin = escapeHtml(businessDetails?.tpin);
    const safeReceiptId = escapeHtml(receiptId);
    const safeCustomerName = escapeHtml(customerName);
    const safeCustomerTpin = escapeHtml(customerTpin);

    const fontFamily = isA4
      ? "Arial, Helvetica, sans-serif"
      : "'Courier New', monospace";

    // A4: table layout for crisp alignment. Thermal: stacked rows.
    const itemsHtml = isA4
      ? `<table style="width:100%;border-collapse:collapse;font-size:${styles.baseFont};margin:8px 0;">
          <thead>
            <tr style="border-bottom:1px solid #000;">
              <th style="text-align:left;padding:6px 4px;">${itemLabel}</th>
              <th style="text-align:center;padding:6px 4px;width:60px;">Qty</th>
              <th style="text-align:right;padding:6px 4px;width:90px;">Price</th>
              <th style="text-align:right;padding:6px 4px;width:110px;">Total</th>
            </tr>
          </thead>
          <tbody>
            ${items.map(i => `
              <tr style="border-bottom:1px dashed #ccc;">
                <td style="padding:6px 4px;">${escapeHtml(i.name)}${i.notes ? ` <span style="color:#000;font-size:11px">(${escapeHtml(i.notes)})</span>` : ""}</td>
                <td style="text-align:center;padding:6px 4px;">${i.quantity}</td>
                <td style="text-align:right;padding:6px 4px;">ZMW ${i.price.toFixed(2)}</td>
                <td style="text-align:right;padding:6px 4px;">ZMW ${(i.price * i.quantity).toFixed(2)}</td>
              </tr>`).join("")}
          </tbody>
        </table>`
      : `<div class="items">
          ${items.map(i => `
            <div class="item">
              <span class="item-name">${escapeHtml(i.name)}${i.notes ? ` <span style="color:#000;font-size:10px">(${escapeHtml(i.notes)})</span>` : ""}</span>
              <span class="item-qty">${qtyPrefix}${i.quantity}</span>
              <span class="item-price">ZMW ${(i.price * i.quantity).toFixed(2)}</span>
            </div>`).join("")}
        </div>`;

    return `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Receipt - ${safeReceiptId}</title>
          <style>
            ${styles.pageRule}
            * { box-sizing: border-box; }
            body { font-family: ${fontFamily}; margin: 0; background: white; color: black; font-size: ${styles.baseFont}; padding: ${styles.padding}; width: ${styles.bodyWidth}; overflow-wrap: anywhere; }
            .header { text-align: center; margin-bottom: 12px; }
            .header h1 { font-size: ${styles.headerFont}; margin: 0 0 4px 0; line-height: 1.15; overflow-wrap: anywhere; }
            .header p { margin: 2px 0; font-size: ${styles.baseFont}; color: #000; }
            .divider { border-top: 1px dashed #000; margin: 8px 0; }
            .item { display: grid; grid-template-columns: minmax(0, 1fr) ${styles.qtyWidth} ${styles.priceWidth}; align-items: start; font-size: ${styles.baseFont}; margin: 4px 0; gap: 2mm; }
            .item-name { min-width: 0; word-break: break-word; overflow-wrap: anywhere; }
            .item-qty { text-align: center; white-space: nowrap; }
            .item-price { text-align: right; white-space: nowrap; }
            .totals { margin-top: 8px; }
            .total-row { display: flex; justify-content: space-between; gap: 4px; font-size: ${styles.baseFont}; margin: 3px 0; }
            .total-row span:last-child { text-align: right; white-space: nowrap; }
            .total-row.grand { font-size: ${styles.totalFont}; font-weight: bold; border-top: 1px solid #000; padding-top: 6px; margin-top: 6px; }
            .customer { font-size: ${styles.baseFont}; margin: 3px 0; }
            .footer { text-align: center; margin-top: 16px; font-size: ${styles.baseFont}; color: #000; }
            @media print {
              html, body { margin: 0; background: white; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
              body { max-width: none; }
              ${styles.printRule}
            }
          </style>
        </head>
        <body>
          <div class="header">
            <h1>${safeBusinessName}</h1>
            ${safeTpin ? `<p>TPIN: ${safeTpin}</p>` : ""}
            ${safePhone ? `<p>Tel: ${safePhone}</p>` : ""}
            ${safeEmail ? `<p>${safeEmail}</p>` : ""}
            ${safeAddress ? `<p>${safeAddress}</p>` : ""}
            <p>${escapeHtml(new Date(date).toLocaleString())}</p>
            <p>Receipt #: ${safeReceiptId.slice(-8).toUpperCase()}</p>
          </div>
          ${safeCustomerName || safeCustomerTpin ? `
          <div class="divider"></div>
          <div>
            ${safeCustomerName ? `<div class="customer"><strong>Customer:</strong> ${safeCustomerName}</div>` : ""}
            ${safeCustomerTpin ? `<div class="customer"><strong>Customer TPIN:</strong> ${safeCustomerTpin}</div>` : ""}
          </div>` : ""}
          <div class="divider"></div>
          ${itemsHtml}
          <div class="divider"></div>
          <div class="totals">
            ${taxAmount > 0 ? `
            <div class="total-row"><span>Subtotal (excl.)</span><span>ZMW ${netSubtotal.toFixed(2)}</span></div>
            <div class="total-row"><span>${escapeHtml(taxLabel)}</span><span>ZMW ${taxAmount.toFixed(2)}</span></div>` : `
            <div class="total-row"><span>Subtotal</span><span>ZMW ${subtotal.toFixed(2)}</span></div>`}
            ${discountAmount > 0 ? `<div class="total-row"><span>Discount</span><span>-ZMW ${discountAmount.toFixed(2)}</span></div>` : ""}
            <div class="total-row grand"><span>TOTAL</span><span>ZMW ${total.toFixed(2)}</span></div>
            <div class="total-row"><span>Payment</span><span>${paymentMethod === "cash" ? "Cash" : paymentMethod === "mobile_money" ? "Mobile Money" : escapeHtml(paymentMethod)}</span></div>
          </div>
          <div class="divider"></div>
          <div class="footer">
            <p>Thank you for your ${isService ? "business" : "purchase"}!</p>
            <p>Powered by Sale Point</p>
          </div>
        </body>
      </html>
    `;
  };

  const isAndroidApp = typeof window !== "undefined" && !!(window as any).Android;

  const getEscPosText = (): string => {
    const lines: string[] = [];
    const center = "[C]";
    const left = "[L]";
    const right = "[R]";

    lines.push(`${center}<font size='big'><b>${escapeHtml(businessName)}</b></font>`);
    if (businessDetails?.tpin) lines.push(`${center}TPIN: ${escapeHtml(businessDetails.tpin)}`);
    if (businessDetails?.phone) lines.push(`${center}Tel: ${escapeHtml(businessDetails.phone)}`);
    if (businessDetails?.email) lines.push(`${center}${escapeHtml(businessDetails.email)}`);
    if (businessDetails?.address) lines.push(`${center}${escapeHtml(businessDetails.address)}`);
    lines.push(`${center}${new Date(date).toLocaleString()}`);
    lines.push(`${center}Receipt #: ${receiptId.slice(-8).toUpperCase()}`);
    lines.push(`${center}================================`);

    if (customerName || customerTpin) {
      if (customerName) lines.push(`${left}<b>Customer:</b> ${escapeHtml(customerName)}`);
      if (customerTpin) lines.push(`${left}<b>Customer TPIN:</b> ${escapeHtml(customerTpin)}`);
      lines.push(`${center}--------------------------------`);
    }

    items.forEach((item) => {
      const lineTotal = (item.price * item.quantity).toFixed(2);
      lines.push(`${left}${escapeHtml(item.name)}${item.notes ? ` (${escapeHtml(item.notes)})` : ""}`);
      lines.push(`${left}  ${qtyPrefix}${item.quantity}${right}ZMW ${lineTotal}`);
    });

    lines.push(`${center}================================`);

    if (taxAmount > 0) {
      lines.push(`${left}Subtotal (excl.)${right}ZMW ${netSubtotal.toFixed(2)}`);
      lines.push(`${left}${escapeHtml(taxLabel)}${right}ZMW ${taxAmount.toFixed(2)}`);
    } else {
      lines.push(`${left}Subtotal${right}ZMW ${subtotal.toFixed(2)}`);
    }
    if (discountAmount > 0) lines.push(`${left}Discount${right}-ZMW ${discountAmount.toFixed(2)}`);
    lines.push(`${center}<b><font size='tall'>TOTAL: ZMW ${total.toFixed(2)}</font></b>`);
    lines.push(`${left}Payment${right}${paymentMethod === "cash" ? "Cash" : paymentMethod === "mobile_money" ? "Mobile Money" : escapeHtml(paymentMethod)}`);
    lines.push(`${center}================================`);
    
    lines.push(`${center}<font size='small'>Thank you for your ${isService ? "business" : "purchase"}!</font>`);
    lines.push(`${center}<font size='small'>Powered by Sale Point</font>`);

    return lines.join("\n");
  };

  const handlePrint = () => {
    setPrintError(null);

    if (isAndroidApp) {
      const escPosText = getEscPosText();
      const paperWidth = size === "58mm" ? 58 : size === "80mm" ? 80 : 80;
      try {
        const result = (window as any).Android.print(escPosText, paperWidth);
        if (result && String(result).startsWith("ERROR")) {
          setPrintError(String(result));
        }
      } catch (err) {
        setPrintError((err as Error).message || String(err));
      }
      return;
    }

    const html = getReceiptHTML();
    const iframe = document.createElement("iframe");
    iframe.style.position = "fixed";
    iframe.style.right = "0";
    iframe.style.bottom = "0";
    iframe.style.width = "0";
    iframe.style.height = "0";
    iframe.style.border = "0";
    iframe.setAttribute("aria-hidden", "true");
    document.body.appendChild(iframe);

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      try { document.body.removeChild(iframe); } catch { /* noop */ }
    };

    const doc = iframe.contentDocument || iframe.contentWindow?.document;
    if (!doc) {
      cleanup();
      setPrintError("Could not open the print document. Check that printing is not blocked for this page.");
      return;
    }
    doc.open();
    doc.write(html);
    doc.close();

    const trigger = () => {
      try {
        const w = iframe.contentWindow;
        if (!w) {
          cleanup();
          setPrintError("The print window closed before it could open.");
          return;
        }
        w.focus();
        w.print();
        const onAfter = () => { w.removeEventListener("afterprint", onAfter); setTimeout(cleanup, 500); };
        w.addEventListener("afterprint", onAfter);
        setTimeout(cleanup, 30000);
      } catch (err) {
        cleanup();
        setPrintError((err as Error).message || String(err));
      }
    };

    if (iframe.contentWindow?.document.readyState === "complete") {
      trigger();
    } else {
      iframe.onload = trigger;
    }
  };

  const handleDownload = () => {
    const blob = new Blob([getReceiptHTML()], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `receipt-${receiptId.slice(-8).toUpperCase()}-${size}.html`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-sm w-[calc(100%-2rem)]">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between">
            <span>Receipt</span>
            <Button variant="ghost" size="icon" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-2 mb-2">
          <Label className="text-xs">Receipt size / paper</Label>
          <Select value={size} onValueChange={(v) => setSize(v as ReceiptSize)}>
            <SelectTrigger className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="58mm">58mm thermal (small POS printer)</SelectItem>
              <SelectItem value="80mm">80mm thermal (standard POS printer)</SelectItem>
              <SelectItem value="a4">A4 (office printer)</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div
          ref={receiptRef}
          className={`bg-white text-black p-4 rounded-lg ${isA4 ? "font-sans text-sm" : "font-mono text-sm"}`}
          style={{ maxWidth: styles.previewWidth, marginInline: "auto", overflowWrap: "anywhere" }}
        >
          <div className="header text-center mb-4">
            <h1 className={isA4 ? "text-xl font-bold" : "text-lg font-bold"}>{businessName}</h1>
            {businessDetails?.tpin && (
              <p className="text-xs text-gray-600">TPIN: {businessDetails.tpin}</p>
            )}
            {businessDetails?.phone && (
              <p className="text-xs text-gray-600">Tel: {businessDetails.phone}</p>
            )}
            {businessDetails?.email && (
              <p className="text-xs text-gray-600">{businessDetails.email}</p>
            )}
            {businessDetails?.address && (
              <p className="text-xs text-gray-600">{businessDetails.address}</p>
            )}
            <p className="text-xs text-gray-600 mt-2">{new Date(date).toLocaleString()}</p>
            <p className="text-xs text-gray-600">Receipt #: {receiptId.slice(-8).toUpperCase()}</p>
          </div>

          {(customerName || customerTpin) && (
            <>
              <div className="divider border-t border-dashed border-gray-400 my-2" />
              <div className="text-xs space-y-0.5">
                {customerName && <p><strong>Customer:</strong> {customerName}</p>}
                {customerTpin && <p><strong>Customer TPIN:</strong> {customerTpin}</p>}
              </div>
            </>
          )}

          <div className="divider border-t border-dashed border-gray-400 my-2" />

          {isA4 ? (
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-black">
                  <th className="text-left py-1">{itemLabel}</th>
                  <th className="text-center py-1 w-10">Qty</th>
                  <th className="text-right py-1 w-16">Price</th>
                  <th className="text-right py-1 w-16">Total</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item, idx) => (
                  <tr key={idx} className="border-b border-dashed border-gray-300">
                    <td className="py-1">
                      {item.name}
                      {item.notes && <span className="text-gray-500 ml-1">({item.notes})</span>}
                      {item.modifiers && item.modifiers.length > 0 && (
                        <div className="text-[10px] text-gray-500">
                          {item.modifiers.map((m) => (m.priceAdjustment > 0 ? `${m.name} (+K${m.priceAdjustment.toFixed(2)})` : m.priceAdjustment < 0 ? `${m.name} (-K${Math.abs(m.priceAdjustment).toFixed(2)})` : m.name)).join(" · ")}
                        </div>
                      )}
                    </td>
                    <td className="py-1 text-center">{item.quantity}</td>
                    <td className="py-1 text-right">{item.price.toFixed(2)}</td>
                    <td className="py-1 text-right">{(item.price * item.quantity).toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="items space-y-1">
              {items.map((item, idx) => (
                <div key={idx} className="flex justify-between text-xs">
                  <span className="flex-1">
                    {item.name}
                    {item.notes && <span className="text-muted-foreground text-[10px] ml-1">({item.notes})</span>}
                    {item.modifiers && item.modifiers.length > 0 && (
                      <span className="block text-[10px] text-muted-foreground">
                        {item.modifiers.map((m) => (m.priceAdjustment > 0 ? `${m.name} (+K${m.priceAdjustment.toFixed(2)})` : m.priceAdjustment < 0 ? `${m.name} (-K${Math.abs(m.priceAdjustment).toFixed(2)})` : m.name)).join(" · ")}
                      </span>
                    )}
                  </span>
                  <span className="w-8 text-center">{qtyPrefix}{item.quantity}</span>
                  <span className="w-16 text-right">ZMW {(item.price * item.quantity).toFixed(2)}</span>
                </div>
              ))}
            </div>
          )}

          <div className="divider border-t border-dashed border-gray-400 my-2" />

          <div className="totals space-y-1">
            {taxAmount > 0 ? (
              <>
                <div className="flex justify-between text-xs">
                  <span>Subtotal (excl.)</span>
                  <span>ZMW {netSubtotal.toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span>{taxLabel}</span>
                  <span>ZMW {taxAmount.toFixed(2)}</span>
                </div>
              </>
            ) : (
              <div className="flex justify-between text-xs">
                <span>Subtotal</span>
                <span>ZMW {subtotal.toFixed(2)}</span>
              </div>
            )}
            {discountAmount > 0 && (
              <div className="flex justify-between text-xs text-green-600">
                <span>Discount</span>
                <span>-ZMW {discountAmount.toFixed(2)}</span>
              </div>
            )}
            <div className="flex justify-between text-sm font-bold pt-1 border-t border-gray-400">
              <span>TOTAL</span>
              <span>ZMW {total.toFixed(2)}</span>
            </div>
            <div className="flex justify-between text-xs text-gray-600">
              <span>Payment</span>
              <span>{paymentMethod === "cash" ? "Cash" : paymentMethod === "mobile_money" ? "Mobile Money" : paymentMethod}</span>
            </div>
          </div>

          <div className="divider border-t border-dashed border-gray-400 my-2" />

          <div className="footer text-center text-xs text-gray-500 mt-4">
            <p>Thank you for your {isService ? "business" : "purchase"}!</p>
            <p>Powered by Sale Point</p>
          </div>
        </div>

        {printError && (
          <p role="alert" className="mt-3 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
            Print failed: {printError}
          </p>
        )}

        <div className="grid grid-cols-2 gap-2 mt-4">
          <Button variant="outline" size="sm" onClick={handleDownload}>
            <Download className="h-4 w-4 mr-1" /> Save
          </Button>
          <Button variant="outline" size="sm" onClick={handlePrint}>
            <Printer className="h-4 w-4 mr-1" /> {isAndroidApp ? "Print Receipt" : "Print"}
          </Button>
          <Button variant="outline" size="sm" onClick={() => {
            const text = `Receipt from ${businessName}\nTotal: ZMW ${total.toFixed(2)}\nDate: ${new Date(date).toLocaleString()}\nReceipt #: ${receiptId.slice(-8).toUpperCase()}\n\nItems:\n${items.map(i => `${i.name} x${i.quantity} - ZMW ${(i.price * i.quantity).toFixed(2)}`).join("\n")}\n\nThank you!`;
            const url = `https://wa.me/?text=${encodeURIComponent(text)}`;
            window.open(url, "_blank");
          }}>
            <Share2 className="h-4 w-4 mr-1" /> WhatsApp
          </Button>
          <Button variant="pos" size="sm" onClick={onClose}>
            Done
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default ReceiptModal;
