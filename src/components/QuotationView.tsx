import { ArrowLeft, Download, Printer, ShoppingCart, Edit, Calendar, User, Hash, FileText, Truck, ReceiptText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Quotation, QuotationItem } from "@/hooks/useQuotations";
import jsPDF from "jspdf";

interface QuotationViewProps {
  quotation: Quotation;
  businessName: string;
  businessDetails: {
    phone?: string | null;
    email?: string | null;
    address?: string | null;
    logoUrl?: string | null;
    tpin?: string | null;
    bankName?: string | null;
    bankAccountName?: string | null;
    bankAccountNumber?: string | null;
    bankBranch?: string | null;
    bankSwift?: string | null;
  };
  onBack: () => void;
  onEdit: () => void;
  onConvert: () => void;
  onCreateDeliveryNote?: () => void;
  onCreateInvoice?: () => void;
}

const statusConfig: Record<string, { label: string; className: string }> = {
  draft: { label: 'Draft', className: 'bg-muted text-muted-foreground' },
  sent: { label: 'Sent', className: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' },
  approved: { label: 'Approved', className: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400' },
  rejected: { label: 'Rejected', className: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' },
  expired: { label: 'Expired', className: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' },
  converted: { label: 'Converted', className: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400' },
};

const QuotationView = ({ quotation, businessName, businessDetails, onBack, onEdit, onConvert, onCreateDeliveryNote, onCreateInvoice }: QuotationViewProps) => {
  const items = quotation.items || [];
  const status = statusConfig[quotation.status] || statusConfig.draft;
  const bankRows = [
    { label: 'Bank', value: businessDetails.bankName },
    { label: 'Account Name', value: businessDetails.bankAccountName },
    { label: 'Account Number', value: businessDetails.bankAccountNumber },
    { label: 'Branch', value: businessDetails.bankBranch },
    { label: 'SWIFT / Sort Code', value: businessDetails.bankSwift },
  ].filter((row) => !!row.value);

  const loadImageAsBase64 = (url: string): Promise<string | null> => {
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        ctx?.drawImage(img, 0, 0);
        resolve(canvas.toDataURL('image/png'));
      };
      img.onerror = () => resolve(null);
      img.src = url;
    });
  };

  const generatePDF = async () => {
    const doc = new jsPDF();
    const w = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    const margin = 14;
    const footH = 16;
    const bottom = pageH - footH;
    let y = 15;

    const drawAccentBar = () => {
      doc.setFillColor(37, 99, 235); // blue-600
      doc.rect(0, 0, w, 4, 'F');
    };

    // Move to a fresh page (used when the current one would overflow).
    const ensureSpace = (needed: number) => {
      if (y + needed > bottom) {
        doc.addPage();
        y = 20;
        drawAccentBar();
      }
    };

    // === HEADER WITH ACCENT BAR ===
    drawAccentBar();

    // Logo
    if (businessDetails.logoUrl) {
      const base64 = await loadImageAsBase64(businessDetails.logoUrl);
      if (base64) {
        try {
          doc.addImage(base64, 'PNG', 14, y, 28, 28);
        } catch { /* ignore */ }
      }
    }

    // Business name & details (right-aligned or left if no logo)
    const textX = businessDetails.logoUrl ? 48 : 14;
    doc.setFontSize(16);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(30, 30, 30);
    doc.text(businessName, textX, y + 8);

    doc.setFontSize(8);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(100, 100, 100);
    let detailY = y + 14;
    if (businessDetails.address) { doc.text(businessDetails.address, textX, detailY); detailY += 4; }
    if (businessDetails.phone) { doc.text(businessDetails.phone, textX, detailY); detailY += 4; }
    if (businessDetails.email) { doc.text(businessDetails.email, textX, detailY); detailY += 4; }
    if (businessDetails.tpin) { doc.text(`TPIN: ${businessDetails.tpin}`, textX, detailY); detailY += 4; }

    y = Math.max(detailY, y + 32) + 4;

    // === QUOTATION TITLE BAR ===
    doc.setFillColor(243, 244, 246); // gray-100
    doc.roundedRect(14, y, w - 28, 14, 2, 2, 'F');
    doc.setFontSize(12);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(37, 99, 235);
    doc.text("QUOTATION", 20, y + 9);
    doc.setFontSize(10);
    doc.setTextColor(60, 60, 60);
    doc.text(quotation.quotationNumber, w - 20, y + 9, { align: "right" });
    y += 20;

    // === INFO COLUMNS ===
    doc.setFontSize(8);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(100, 100, 100);
    doc.text("DATE", 14, y);
    doc.text("EXPIRES", 70, y);
    doc.text("STATUS", 126, y);
    y += 5;
    doc.setFont("helvetica", "normal");
    doc.setTextColor(30, 30, 30);
    doc.setFontSize(9);
    doc.text(new Date(quotation.createdAt).toLocaleDateString(), 14, y);
    doc.text(quotation.expiryDate ? new Date(quotation.expiryDate).toLocaleDateString() : 'N/A', 70, y);
    doc.text(quotation.status.charAt(0).toUpperCase() + quotation.status.slice(1), 126, y);
    y += 10;

    // === BILL TO ===
    if (quotation.customerName) {
      doc.setFillColor(249, 250, 251);
      doc.roundedRect(14, y, w - 28, quotation.customerPhone || quotation.customerEmail ? 22 : 16, 2, 2, 'F');
      doc.setFontSize(7);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(100, 100, 100);
      doc.text("BILL TO", 20, y + 5);
      doc.setFontSize(9);
      doc.setFont("helvetica", "normal");
      doc.setTextColor(30, 30, 30);
      doc.text(quotation.customerName, 20, y + 11);
      let cy = y + 15;
      if (quotation.customerPhone) { doc.setFontSize(8); doc.setTextColor(100); doc.text(quotation.customerPhone, 20, cy); cy += 4; }
      if (quotation.customerEmail) { doc.setFontSize(8); doc.setTextColor(100); doc.text(quotation.customerEmail, 20, cy); cy += 4; }
      if (quotation.customerTpin) { doc.setFontSize(8); doc.setTextColor(100); doc.text(`TPIN: ${quotation.customerTpin}`, 20, cy); cy += 4; }
      y = cy + 4;
    }

    // === ITEMS TABLE ===
    // Header
    doc.setFillColor(37, 99, 235);
    doc.roundedRect(14, y, w - 28, 9, 1, 1, 'F');
    doc.setFontSize(7.5);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(255, 255, 255);
    doc.text("ITEM", 18, y + 6);
    doc.text("QTY", 105, y + 6);
    doc.text("PRICE", 122, y + 6);
    doc.text("DISC.", 147, y + 6);
    doc.text("TOTAL", w - 18, y + 6, { align: "right" });
    y += 12;

    // Rows
    doc.setTextColor(30, 30, 30);
    items.forEach((item, idx) => {
      ensureSpace(10);
      if (idx % 2 === 0) {
        doc.setFillColor(249, 250, 251);
        doc.rect(margin, y - 4, w - (margin * 2), 8, 'F');
      }
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8.5);
      doc.text(item.productName.substring(0, 40), 18, y);
      doc.text(item.quantity.toString(), 108, y);
      doc.text(`K${item.unitPrice.toFixed(2)}`, 122, y);
      const disc = item.discountType === 'percentage' ? (item.discountValue > 0 ? `${item.discountValue}%` : '-') : (item.discountValue > 0 ? `K${item.discountValue.toFixed(2)}` : '-');
      doc.text(disc, 147, y);
      doc.setFont("helvetica", "bold");
      doc.text(`K${item.lineTotal.toFixed(2)}`, w - 18, y, { align: "right" });
      y += 8;
    });

    ensureSpace(30);
    y += 4;

    // === TOTALS BOX ===
    doc.setDrawColor(230, 230, 230);
    doc.line(110, y, w - 14, y);
    y += 6;
    doc.setFontSize(9);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(80, 80, 80);
    if (quotation.taxAmount > 0) {
      const net = Math.max(0, quotation.total - quotation.taxAmount);
      doc.text("Subtotal (excl.)", 120, y);
      doc.text(`K${net.toFixed(2)}`, w - 18, y, { align: "right" });
      y += 6;
      doc.text("Tax", 120, y);
      doc.text(`K${quotation.taxAmount.toFixed(2)}`, w - 18, y, { align: "right" });
      y += 6;
    } else {
      doc.text("Subtotal", 120, y);
      doc.text(`K${quotation.subtotal.toFixed(2)}`, w - 18, y, { align: "right" });
      y += 6;
    }
    if (quotation.discountAmount > 0) {
      doc.setTextColor(220, 38, 38);
      doc.text("Discount", 120, y);
      doc.text(`-K${quotation.discountAmount.toFixed(2)}`, w - 18, y, { align: "right" });
      y += 6;
    }
    // Total highlight
    doc.setFillColor(37, 99, 235);
    doc.roundedRect(110, y - 1, w - 124, 12, 2, 2, 'F');
    doc.setFontSize(11);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(255, 255, 255);
    doc.text("TOTAL", 116, y + 7);
    doc.text(`K${quotation.total.toFixed(2)}`, w - 18, y + 7, { align: "right" });
    y += 18;

    // === PAYMENT DETAILS ===
    if (bankRows.length > 0) {
      ensureSpace(bankRows.length * 4 + 14);
      doc.setFontSize(8);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(80, 80, 80);
      doc.text("PAYMENT DETAILS", margin, y);
      y += 5;
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8);
      doc.setTextColor(100, 100, 100);
      bankRows.forEach((row) => {
        doc.text(`${row.label}: ${row.value}`, margin, y);
        y += 4;
      });
      y += 4;
    }

    // === NOTES ===
    if (quotation.notes) {
      doc.setFontSize(8);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(80, 80, 80);
      const noteLines = doc.splitTextToSize(quotation.notes, w - 28);
      ensureSpace(noteLines.length * 3 + 12);
      doc.text("NOTES / TERMS", margin, y);
      y += 5;
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8);
      doc.setTextColor(100, 100, 100);
      doc.text(noteLines, margin, y);
    }

    // Footer
    doc.setFontSize(7);
    doc.setTextColor(180, 180, 180);
    doc.text("Generated by Sale Point", w / 2, pageH - 8, { align: "center" });

    return doc;
  };

  const handleDownload = async () => {
    const doc = await generatePDF();
    doc.save(`${quotation.quotationNumber}.pdf`);
  };

  const handlePrint = async () => {
    const doc = await generatePDF();
    const blob = doc.output('blob');
    const url = URL.createObjectURL(blob);
    const printWindow = window.open(url);
    if (printWindow) {
      printWindow.addEventListener('load', () => { printWindow.print(); });
    }
  };

  return (
    <div className="space-y-4">
      {/* Action bar */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" onClick={onBack}><ArrowLeft className="h-5 w-5" /></Button>
          <h2 className="font-display font-bold text-lg">{quotation.quotationNumber}</h2>
          <Badge className={status.className}>{status.label}</Badge>
        </div>
        <div className="flex gap-1 flex-wrap">
          {quotation.status !== 'converted' && (
            <>
              <Button variant="outline" size="sm" onClick={onEdit}><Edit className="h-4 w-4 mr-1" /> Edit</Button>
              <Button size="sm" className="bg-primary text-primary-foreground hover:bg-primary/90" onClick={onConvert}><ShoppingCart className="h-4 w-4 mr-1" /> Convert to Sale</Button>
            </>
          )}
          {onCreateDeliveryNote && (
            <Button variant="outline" size="sm" onClick={onCreateDeliveryNote}><Truck className="h-4 w-4 mr-1" /> Delivery Note</Button>
          )}
          {onCreateInvoice && (
            <Button variant="outline" size="sm" onClick={onCreateInvoice}><ReceiptText className="h-4 w-4 mr-1" /> Invoice</Button>
          )}
          <Button variant="outline" size="sm" onClick={handleDownload}><Download className="h-4 w-4 mr-1" /> PDF</Button>
          <Button variant="outline" size="sm" onClick={handlePrint}><Printer className="h-4 w-4 mr-1" /> Print</Button>
        </div>
      </div>

      {/* Quotation Preview Card – mirrors PDF design */}
      <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
        {/* Blue accent bar */}
        <div className="h-1.5 bg-primary" />

        <div className="p-6 space-y-6">
          {/* Header: Logo + Business Info */}
          <div className="flex items-start gap-4">
            {businessDetails.logoUrl && (
              <img src={businessDetails.logoUrl} alt="Logo" className="w-16 h-16 object-contain rounded-lg border border-border" />
            )}
            <div className="flex-1">
              <h3 className="font-bold text-lg">{businessName}</h3>
              <div className="text-xs text-muted-foreground space-y-0.5">
                {businessDetails.address && <p>{businessDetails.address}</p>}
                <div className="flex gap-3 flex-wrap">
                  {businessDetails.phone && <span>{businessDetails.phone}</span>}
                  {businessDetails.email && <span>{businessDetails.email}</span>}
                </div>
                {businessDetails.tpin && <p>TPIN: {businessDetails.tpin}</p>}
              </div>
            </div>
            <div className="text-right">
              <span className="text-2xl font-bold text-primary tracking-tight">QUOTATION</span>
              <p className="text-sm text-muted-foreground font-mono mt-1">{quotation.quotationNumber}</p>
            </div>
          </div>

          <Separator />

          {/* Meta info row */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
            <div>
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1"><Calendar className="h-3 w-3" /> Date</p>
              <p className="font-medium">{new Date(quotation.createdAt).toLocaleDateString()}</p>
            </div>
            <div>
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1"><Calendar className="h-3 w-3" /> Expires</p>
              <p className="font-medium">{quotation.expiryDate ? new Date(quotation.expiryDate).toLocaleDateString() : 'N/A'}</p>
            </div>
            <div>
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1"><Hash className="h-3 w-3" /> Status</p>
              <Badge className={`${status.className} text-xs mt-0.5`}>{status.label}</Badge>
            </div>
            <div>
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1"><FileText className="h-3 w-3" /> Modified</p>
              <p className="font-medium">{new Date(quotation.updatedAt).toLocaleDateString()}</p>
            </div>
          </div>

          {/* Customer info */}
          {(quotation.customerName || quotation.customerTpin) && (
            <div className="bg-muted/50 rounded-lg p-4">
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1 mb-1"><User className="h-3 w-3" /> Bill To</p>
              {quotation.customerName && <p className="font-semibold">{quotation.customerName}</p>}
              <div className="text-xs text-muted-foreground flex gap-3 mt-0.5 flex-wrap">
                {quotation.customerPhone && <span>{quotation.customerPhone}</span>}
                {quotation.customerEmail && <span>{quotation.customerEmail}</span>}
                {quotation.customerTpin && <span>TPIN: {quotation.customerTpin}</span>}
              </div>
            </div>
          )}

          {/* Items table */}
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-primary text-primary-foreground">
                  <th className="text-left py-2.5 px-3 font-semibold text-xs uppercase tracking-wider">Item</th>
                  <th className="text-center py-2.5 px-3 font-semibold text-xs uppercase tracking-wider">Qty</th>
                  <th className="text-right py-2.5 px-3 font-semibold text-xs uppercase tracking-wider">Price</th>
                  <th className="text-right py-2.5 px-3 font-semibold text-xs uppercase tracking-wider">Discount</th>
                  <th className="text-right py-2.5 px-3 font-semibold text-xs uppercase tracking-wider">Total</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item, idx) => (
                  <tr key={idx} className={idx % 2 === 0 ? 'bg-muted/30' : ''}>
                    <td className="py-2.5 px-3 font-medium">{item.productName}</td>
                    <td className="py-2.5 px-3 text-center">{item.quantity}</td>
                    <td className="py-2.5 px-3 text-right">K{item.unitPrice.toFixed(2)}</td>
                    <td className="py-2.5 px-3 text-right text-muted-foreground">
                      {item.discountType === 'percentage' ? (item.discountValue > 0 ? `${item.discountValue}%` : '-') : (item.discountValue > 0 ? `K${item.discountValue.toFixed(2)}` : '-')}
                    </td>
                    <td className="py-2.5 px-3 text-right font-bold">K{item.lineTotal.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Totals */}
          <div className="flex justify-end">
            <div className="w-full max-w-xs space-y-1.5 text-sm">
              {quotation.taxAmount > 0 ? (
                <>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Subtotal (excl.)</span>
                    <span>K{Math.max(0, quotation.total - quotation.taxAmount).toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Tax</span>
                    <span>K{quotation.taxAmount.toFixed(2)}</span>
                  </div>
                </>
              ) : (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Subtotal</span>
                  <span>K{quotation.subtotal.toFixed(2)}</span>
                </div>
              )}
              {quotation.discountAmount > 0 && (
                <div className="flex justify-between text-destructive">
                  <span>Discount</span>
                  <span>-K{quotation.discountAmount.toFixed(2)}</span>
                </div>
              )}
              <Separator />
              <div className="flex justify-between items-center bg-primary text-primary-foreground rounded-lg px-4 py-2.5">
                <span className="font-bold text-base">TOTAL</span>
                <span className="font-bold text-lg">K{quotation.total.toFixed(2)}</span>
              </div>
            </div>
          </div>

          {/* Payment details */}
          {bankRows.length > 0 && (
            <div className="rounded-lg border border-border bg-muted/30 p-4">
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1">Payment Details</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-xs">
                {bankRows.map((row) => (
                  <p key={row.label}>
                    <span className="text-muted-foreground">{row.label}:</span> {row.value}
                  </p>
                ))}
              </div>
            </div>
          )}

          {/* Notes */}
          {quotation.notes && (
            <div className="border-t border-border pt-4">
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1">Notes / Terms</p>
              <p className="text-sm text-muted-foreground whitespace-pre-wrap">{quotation.notes}</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="text-center text-[10px] text-muted-foreground py-2 border-t border-border bg-muted/30">
          Generated by Sale Point
        </div>
      </div>
    </div>
  );
};

export default QuotationView;
