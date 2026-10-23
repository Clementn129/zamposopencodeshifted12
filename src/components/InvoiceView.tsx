import { useState } from "react";
import { ArrowLeft, Download, Printer, Edit, Calendar, User, Hash, FileText, BadgeCheck, Ban } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Invoice } from "@/hooks/useInvoices";
import jsPDF from "jspdf";

interface InvoiceViewProps {
  invoice: Invoice;
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
  onPay: (paymentMethod: string) => void;
  onVoid?: () => void;
}

const statusConfig: Record<string, { label: string; className: string }> = {
  draft: { label: 'Draft', className: 'bg-muted text-muted-foreground' },
  sent: { label: 'Sent', className: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' },
  paid: { label: 'Paid', className: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400' },
  void: { label: 'Void', className: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' },
};

const InvoiceView = ({ invoice, businessName, businessDetails, onBack, onEdit, onPay, onVoid }: InvoiceViewProps) => {
  const items = invoice.items || [];
  const status = statusConfig[invoice.status] || statusConfig.draft;
  const payable = invoice.status !== 'paid' && invoice.status !== 'void';
  const bankRows = [
    { label: 'Bank', value: businessDetails.bankName },
    { label: 'Account Name', value: businessDetails.bankAccountName },
    { label: 'Account Number', value: businessDetails.bankAccountNumber },
    { label: 'Branch', value: businessDetails.bankBranch },
    { label: 'SWIFT / Sort Code', value: businessDetails.bankSwift },
  ].filter((row) => !!row.value);
  const [payOpen, setPayOpen] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState("cash");
  const [voidOpen, setVoidOpen] = useState(false);

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
      doc.setFillColor(37, 99, 235);
      doc.rect(0, 0, w, 4, 'F');
    };

    const ensureSpace = (needed: number) => {
      if (y + needed > bottom) {
        doc.addPage();
        y = 20;
        drawAccentBar();
      }
    };

    drawAccentBar();

    if (businessDetails.logoUrl) {
      const base64 = await loadImageAsBase64(businessDetails.logoUrl);
      if (base64) {
        try {
          doc.addImage(base64, 'PNG', 14, y, 28, 28);
        } catch { /* ignore */ }
      }
    }

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

    // === INVOICE TITLE BAR ===
    doc.setFillColor(243, 244, 246);
    doc.roundedRect(14, y, w - 28, 14, 2, 2, 'F');
    doc.setFontSize(12);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(37, 99, 235);
    doc.text("INVOICE", 20, y + 9);
    doc.setFontSize(10);
    doc.setTextColor(60, 60, 60);
    if (invoice.status === 'void') {
      doc.setTextColor(220, 38, 38);
      doc.text("VOID", w - 20, y + 9, { align: "right" });
    } else {
      doc.text(invoice.invoiceNumber, w - 20, y + 9, { align: "right" });
    }
    y += 20;

    // === INFO COLUMNS ===
    doc.setFontSize(8);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(100, 100, 100);
    doc.text("ISSUED", 14, y);
    doc.text("DUE", 70, y);
    doc.text("STATUS", 126, y);
    y += 5;
    doc.setFont("helvetica", "normal");
    doc.setTextColor(30, 30, 30);
    doc.setFontSize(9);
    doc.text(invoice.issuedDate ? new Date(invoice.issuedDate + 'T00:00:00').toLocaleDateString() : 'N/A', 14, y);
    doc.text(invoice.dueDate ? new Date(invoice.dueDate + 'T00:00:00').toLocaleDateString() : 'N/A', 70, y);
    doc.text(invoice.status.charAt(0).toUpperCase() + invoice.status.slice(1), 126, y);
    y += 10;

    // === BILL TO ===
    if (invoice.customerName) {
      doc.setFillColor(249, 250, 251);
      doc.roundedRect(14, y, w - 28, invoice.customerPhone || invoice.customerEmail ? 22 : 16, 2, 2, 'F');
      doc.setFontSize(7);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(100, 100, 100);
      doc.text("BILL TO", 20, y + 5);
      doc.setFontSize(9);
      doc.setFont("helvetica", "normal");
      doc.setTextColor(30, 30, 30);
      doc.text(invoice.customerName, 20, y + 11);
      let cy = y + 15;
      if (invoice.customerPhone) { doc.setFontSize(8); doc.setTextColor(100); doc.text(invoice.customerPhone, 20, cy); cy += 4; }
      if (invoice.customerEmail) { doc.setFontSize(8); doc.setTextColor(100); doc.text(invoice.customerEmail, 20, cy); cy += 4; }
      if (invoice.customerTpin) { doc.setFontSize(8); doc.setTextColor(100); doc.text(`TPIN: ${invoice.customerTpin}`, 20, cy); cy += 4; }
      y = cy + 4;
    }

    // === ITEMS TABLE ===
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
    doc.text("Subtotal", 120, y);
    doc.text(`K${invoice.subtotal.toFixed(2)}`, w - 18, y, { align: "right" });
    y += 6;
    if (invoice.discountAmount > 0) {
      doc.setTextColor(220, 38, 38);
      doc.text("Discount", 120, y);
      doc.text(`-K${invoice.discountAmount.toFixed(2)}`, w - 18, y, { align: "right" });
      y += 6;
    }
    if (invoice.taxAmount > 0) {
      doc.setTextColor(80, 80, 80);
      doc.text("Tax (incl.)", 120, y);
      doc.text(`K${invoice.taxAmount.toFixed(2)}`, w - 18, y, { align: "right" });
      y += 6;
    }
    // Total highlight
    doc.setFillColor(37, 99, 235);
    doc.roundedRect(110, y - 1, w - 124, 12, 2, 2, 'F');
    doc.setFontSize(11);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(255, 255, 255);
    doc.text("TOTAL", 116, y + 7);
    doc.text(`K${invoice.total.toFixed(2)}`, w - 18, y + 7, { align: "right" });
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

    if (invoice.paymentMethod && invoice.status === 'paid') {
      doc.setFontSize(8);
      doc.setFont("helvetica", "normal");
      doc.setTextColor(100, 100, 100);
      doc.text(`Paid via ${invoice.paymentMethod.replace('_', ' ')}`, margin, y);
      if (invoice.convertedSaleId) {
        doc.setFont("helvetica", "bold");
        doc.text("RECORDED AS A SALE", margin, y + 5);
      }
      y += 12;
    }

    if (invoice.notes) {
      doc.setFontSize(8);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(80, 80, 80);
      const noteLines = doc.splitTextToSize(invoice.notes, w - 28);
      ensureSpace(noteLines.length * 3 + 12);
      doc.text("NOTES / TERMS", margin, y);
      y += 5;
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8);
      doc.setTextColor(100, 100, 100);
      doc.text(noteLines, margin, y);
    }

    doc.setFontSize(7);
    doc.setTextColor(180, 180, 180);
    doc.text("Generated by Sale Point", w / 2, pageH - 8, { align: "center" });

    return doc;
  };

  const handleDownload = async () => {
    const doc = await generatePDF();
    doc.save(`${invoice.invoiceNumber}.pdf`);
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
          <h2 className="font-display font-bold text-lg">{invoice.invoiceNumber}</h2>
          <Badge className={status.className}>{status.label}</Badge>
        </div>
        <div className="flex gap-1 flex-wrap">
          {payable && (
            <>
              <Button variant="outline" size="sm" onClick={onEdit}><Edit className="h-4 w-4 mr-1" /> Edit</Button>
              <Button size="sm" className="bg-success text-success-foreground hover:bg-success/90" onClick={() => setPayOpen(true)}>
                <BadgeCheck className="h-4 w-4 mr-1" /> Mark Paid
              </Button>
            </>
          )}
          {payable && onVoid && (
            <Button variant="outline" size="sm" onClick={() => setVoidOpen(true)}>
              <Ban className="h-4 w-4 mr-1" /> Void
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={handleDownload}><Download className="h-4 w-4 mr-1" /> PDF</Button>
          <Button variant="outline" size="sm" onClick={handlePrint}><Printer className="h-4 w-4 mr-1" /> Print</Button>
        </div>
      </div>

      {/* Invoice Preview Card */}
      <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
        <div className="h-1.5 bg-primary" />

        <div className="p-6 space-y-6">
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
              <span className="text-2xl font-bold text-primary tracking-tight">INVOICE</span>
              <p className="text-sm text-muted-foreground font-mono mt-1">{invoice.invoiceNumber}</p>
            </div>
          </div>

          <Separator />

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
            <div>
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1"><Calendar className="h-3 w-3" /> Issued</p>
              <p className="font-medium">{invoice.issuedDate ? new Date(invoice.issuedDate + 'T00:00:00').toLocaleDateString() : 'N/A'}</p>
            </div>
            <div>
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1"><Calendar className="h-3 w-3" /> Due</p>
              <p className="font-medium">{invoice.dueDate ? new Date(invoice.dueDate + 'T00:00:00').toLocaleDateString() : 'N/A'}</p>
            </div>
            <div>
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1"><Hash className="h-3 w-3" /> Status</p>
              <Badge className={`${status.className} text-xs mt-0.5`}>{status.label}</Badge>
            </div>
            <div>
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1"><FileText className="h-3 w-3" /> Payment</p>
              <p className="font-medium">{invoice.paymentMethod ? invoice.paymentMethod.replace('_', ' ') : 'Pending'}</p>
            </div>
          </div>

          {(invoice.customerName || invoice.customerTpin) && (
            <div className="bg-muted/50 rounded-lg p-4">
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1 mb-1"><User className="h-3 w-3" /> Bill To</p>
              {invoice.customerName && <p className="font-semibold">{invoice.customerName}</p>}
              <div className="text-xs text-muted-foreground flex gap-3 mt-0.5 flex-wrap">
                {invoice.customerPhone && <span>{invoice.customerPhone}</span>}
                {invoice.customerEmail && <span>{invoice.customerEmail}</span>}
                {invoice.customerTpin && <span>TPIN: {invoice.customerTpin}</span>}
              </div>
            </div>
          )}

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

          <div className="flex justify-end">
            <div className="w-full max-w-xs space-y-1.5 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Subtotal</span>
                <span>K{invoice.subtotal.toFixed(2)}</span>
              </div>
              {invoice.discountAmount > 0 && (
                <div className="flex justify-between text-destructive">
                  <span>Discount</span>
                  <span>-K{invoice.discountAmount.toFixed(2)}</span>
                </div>
              )}
              {invoice.taxAmount > 0 && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Tax (incl.)</span>
                  <span>K{invoice.taxAmount.toFixed(2)}</span>
                </div>
              )}
              {invoice.status === 'paid' && (
                <div className="flex justify-between text-success">
                  <span>Paid</span>
                  <span>K{invoice.total.toFixed(2)}</span>
                </div>
              )}
              <Separator />
              <div className="flex justify-between items-center bg-primary text-primary-foreground rounded-lg px-4 py-2.5">
                <span className="font-bold text-base">TOTAL</span>
                <span className="font-bold text-lg">K{invoice.total.toFixed(2)}</span>
              </div>
            </div>
          </div>

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

          {invoice.notes && (
            <div className="border-t border-border pt-4">
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1">Notes / Terms</p>
              <p className="text-sm text-muted-foreground whitespace-pre-wrap">{invoice.notes}</p>
            </div>
          )}
        </div>

        <div className="text-center text-[10px] text-muted-foreground py-2 border-t border-border bg-muted/30">
          Generated by Sale Point
        </div>
      </div>

      {/* Mark Paid dialog */}
      <AlertDialog open={payOpen} onOpenChange={setPayOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Mark {invoice.invoiceNumber} as Paid?</AlertDialogTitle>
            <AlertDialogDescription>
              This records the invoice as paid and creates the sale (stock deducted, revenue added). The source document, if any, will be marked as converted.
            </AlertDialogDescription>
            <div className="pt-2">
              <Select value={paymentMethod} onValueChange={setPaymentMethod}>
                <SelectTrigger className="w-full"><SelectValue placeholder="Payment method" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="cash">Cash</SelectItem>
                  <SelectItem value="mobile_money">Mobile Money</SelectItem>
                  <SelectItem value="card">Card</SelectItem>
                  <SelectItem value="bank">Bank Transfer</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-success text-success-foreground hover:bg-success/90"
              onClick={() => { setPayOpen(false); onPay(paymentMethod); }}
            >
              Confirm Payment
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Void dialog */}
      <AlertDialog open={voidOpen} onOpenChange={setVoidOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Void {invoice.invoiceNumber}?</AlertDialogTitle>
            <AlertDialogDescription>
              The invoice will be voided. No sale is created and no stock is affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => { setVoidOpen(false); onVoid?.(); }}
            >
              Void Invoice
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default InvoiceView;