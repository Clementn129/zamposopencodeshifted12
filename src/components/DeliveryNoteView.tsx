import { ArrowLeft, Download, Printer, CheckCircle, Calendar, MapPin, User, Car, FileText, ReceiptText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { DeliveryNote } from "@/hooks/useDeliveryNotes";
import jsPDF from "jspdf";

interface DeliveryNoteViewProps {
  deliveryNote: DeliveryNote;
  businessName: string;
  businessDetails: { phone?: string | null; email?: string | null; address?: string | null; logoUrl?: string | null };
  onBack: () => void;
  onMarkDelivered: (id: string) => void;
  onCreateInvoice?: () => void;
}

const statusConfig: Record<string, { label: string; className: string }> = {
  pending: { label: 'Pending', className: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' },
  delivered: { label: 'Delivered', className: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400' },
  completed: { label: 'Completed', className: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400' },
  invoiced: { label: 'Invoiced', className: 'bg-slate-100 text-slate-700 dark:bg-slate-900/30 dark:text-slate-400' },
};

const DeliveryNoteView = ({ deliveryNote, businessName, businessDetails, onBack, onMarkDelivered, onCreateInvoice }: DeliveryNoteViewProps) => {
  const items = deliveryNote.items || [];
  const status = statusConfig[deliveryNote.status] || statusConfig.pending;
  const total = items.reduce((s, i) => s + i.lineTotal, 0);

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
    const footH = 16;
    const bottom = pageH - footH;
    let y = 15;

    const drawAccentBar = () => {
      doc.setFillColor(34, 197, 94); // green-500
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
        try { doc.addImage(base64, 'PNG', 14, y, 28, 28); } catch { /* ignore */ }
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

    y = Math.max(detailY, y + 32) + 4;

    // Title bar
    doc.setFillColor(243, 244, 246);
    doc.roundedRect(14, y, w - 28, 14, 2, 2, 'F');
    doc.setFontSize(12);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(34, 197, 94);
    doc.text("DELIVERY NOTE", 20, y + 9);
    doc.setFontSize(10);
    doc.setTextColor(60, 60, 60);
    doc.text(deliveryNote.deliveryNoteNumber, w - 20, y + 9, { align: "right" });
    y += 20;

    // Meta info
    doc.setFontSize(8);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(100, 100, 100);
    doc.text("DATE", 14, y);
    doc.text("STATUS", 80, y);
    doc.text("DRIVER", 140, y);
    y += 5;
    doc.setFont("helvetica", "normal");
    doc.setTextColor(30, 30, 30);
    doc.setFontSize(9);
    doc.text(new Date(deliveryNote.createdAt).toLocaleDateString(), 14, y);
    doc.text(deliveryNote.status === 'delivered' ? 'Delivered' : deliveryNote.status === 'completed' ? 'Completed' : deliveryNote.status === 'invoiced' ? 'Invoiced' : 'Pending', 80, y);
    doc.text(deliveryNote.driverName || 'N/A', 140, y);
    y += 8;

    if (deliveryNote.carPlate) {
      doc.setFontSize(8);
      doc.setTextColor(100);
      doc.text(`Car: ${deliveryNote.carPlate}`, 140, y);
      y += 5;
    }

    // Customer info
    if (deliveryNote.customerName || deliveryNote.deliveryAddress) {
      const boxH = (deliveryNote.customerName ? 8 : 0) + (deliveryNote.customerPhone ? 4 : 0) + (deliveryNote.deliveryAddress ? 8 : 0) + 10;
      doc.setFillColor(249, 250, 251);
      doc.roundedRect(14, y, w - 28, boxH, 2, 2, 'F');
      doc.setFontSize(7);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(100, 100, 100);
      doc.text("DELIVER TO", 20, y + 5);
      let cy = y + 11;
      doc.setFontSize(9);
      doc.setFont("helvetica", "normal");
      doc.setTextColor(30, 30, 30);
      if (deliveryNote.customerName) { doc.text(deliveryNote.customerName, 20, cy); cy += 5; }
      if (deliveryNote.customerPhone) { doc.setFontSize(8); doc.setTextColor(100); doc.text(deliveryNote.customerPhone, 20, cy); cy += 4; }
      if (deliveryNote.deliveryAddress) {
        doc.setFontSize(8);
        doc.setTextColor(80);
        const addrLines = doc.splitTextToSize(deliveryNote.deliveryAddress, w - 40);
        doc.text(addrLines, 20, cy);
        cy += addrLines.length * 3.5;
      }
      y = cy + 4;
    }

    // Items table
    doc.setFillColor(34, 197, 94);
    doc.roundedRect(14, y, w - 28, 9, 1, 1, 'F');
    doc.setFontSize(7.5);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(255, 255, 255);
    doc.text("ITEM", 18, y + 6);
    doc.text("QTY", 120, y + 6);
    doc.text("PRICE", 138, y + 6);
    doc.text("TOTAL", w - 18, y + 6, { align: "right" });
    y += 12;

    doc.setTextColor(30, 30, 30);
    items.forEach((item, idx) => {
      ensureSpace(10);
      if (idx % 2 === 0) {
        doc.setFillColor(249, 250, 251);
        doc.rect(14, y - 4, w - 28, 8, 'F');
      }
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8.5);
      doc.text(item.productName.substring(0, 40), 18, y);
      doc.text(item.quantity.toString(), 123, y);
      doc.text(`K${item.unitPrice.toFixed(2)}`, 138, y);
      doc.setFont("helvetica", "bold");
      doc.text(`K${item.lineTotal.toFixed(2)}`, w - 18, y, { align: "right" });
      y += 8;
    });

    ensureSpace(20);
    y += 4;

    // Total
    doc.setDrawColor(230, 230, 230);
    doc.line(120, y, w - 14, y);
    y += 6;
    doc.setFillColor(34, 197, 94);
    doc.roundedRect(120, y - 1, w - 134, 12, 2, 2, 'F');
    doc.setFontSize(11);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(255, 255, 255);
    doc.text("TOTAL", 126, y + 7);
    doc.text(`K${total.toFixed(2)}`, w - 18, y + 7, { align: "right" });
    y += 18;

    // Notes
    if (deliveryNote.notes) {
      doc.setFontSize(8);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(80, 80, 80);
      const noteLines = doc.splitTextToSize(deliveryNote.notes, w - 28);
      ensureSpace(noteLines.length * 3 + 12);
      doc.text("NOTES", 14, y);
      y += 5;
      doc.setFont("helvetica", "normal");
      doc.setTextColor(100, 100, 100);
      doc.text(noteLines, 14, y);
    }

    doc.setFontSize(7);
    doc.setTextColor(180, 180, 180);
    doc.text("Generated by Sale Point", w / 2, pageH - 8, { align: "center" });

    return doc;
  };

  const handleDownload = async () => {
    const doc = await generatePDF();
    doc.save(`${deliveryNote.deliveryNoteNumber}.pdf`);
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
          <h2 className="font-display font-bold text-lg">{deliveryNote.deliveryNoteNumber}</h2>
          <Badge className={status.className}>{status.label}</Badge>
        </div>
        <div className="flex gap-1 flex-wrap">
          {deliveryNote.status === 'pending' && (
            <Button size="sm" className="bg-success text-success-foreground hover:bg-success/90" onClick={() => onMarkDelivered(deliveryNote.id)}>
              <CheckCircle className="h-4 w-4 mr-1" /> Mark Delivered
            </Button>
          )}
          {onCreateInvoice && deliveryNote.status !== 'completed' && (
            <Button variant="outline" size="sm" onClick={onCreateInvoice}>
              <ReceiptText className="h-4 w-4 mr-1" /> Invoice
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={handleDownload}><Download className="h-4 w-4 mr-1" /> PDF</Button>
          <Button variant="outline" size="sm" onClick={handlePrint}><Printer className="h-4 w-4 mr-1" /> Print</Button>
        </div>
      </div>

      {/* Preview Card */}
      <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
        <div className="h-1.5 bg-success" />

        <div className="p-6 space-y-6">
          {/* Header */}
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
              </div>
            </div>
            <div className="text-right">
              <span className="text-2xl font-bold text-success tracking-tight">DELIVERY NOTE</span>
              <p className="text-sm text-muted-foreground font-mono mt-1">{deliveryNote.deliveryNoteNumber}</p>
            </div>
          </div>

          <Separator />

          {/* Meta info row */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
            <div>
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1"><Calendar className="h-3 w-3" /> Date</p>
              <p className="font-medium">{new Date(deliveryNote.createdAt).toLocaleDateString()}</p>
            </div>
            <div>
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1"><FileText className="h-3 w-3" /> Status</p>
              <Badge className={`${status.className} text-xs mt-0.5`}>{status.label}</Badge>
            </div>
            {deliveryNote.driverName && (
              <div>
                <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1"><User className="h-3 w-3" /> Driver</p>
                <p className="font-medium">{deliveryNote.driverName}</p>
              </div>
            )}
            {deliveryNote.carPlate && (
              <div>
                <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1"><Car className="h-3 w-3" /> Car Plate</p>
                <p className="font-medium">{deliveryNote.carPlate}</p>
              </div>
            )}
          </div>

          {/* Customer & delivery info */}
          {(deliveryNote.customerName || deliveryNote.deliveryAddress) && (
            <div className="bg-muted/50 rounded-lg p-4">
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1 mb-1"><MapPin className="h-3 w-3" /> Deliver To</p>
              {deliveryNote.customerName && <p className="font-semibold">{deliveryNote.customerName}</p>}
              <div className="text-xs text-muted-foreground flex gap-3 mt-0.5 flex-wrap">
                {deliveryNote.customerPhone && <span>{deliveryNote.customerPhone}</span>}
              </div>
              {deliveryNote.deliveryAddress && (
                <p className="text-xs text-muted-foreground mt-1">{deliveryNote.deliveryAddress}</p>
              )}
            </div>
          )}

          {/* Items table */}
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-success text-white">
                  <th className="text-left py-2.5 px-3 font-semibold text-xs uppercase tracking-wider">Item</th>
                  <th className="text-center py-2.5 px-3 font-semibold text-xs uppercase tracking-wider">Qty</th>
                  <th className="text-right py-2.5 px-3 font-semibold text-xs uppercase tracking-wider">Price</th>
                  <th className="text-right py-2.5 px-3 font-semibold text-xs uppercase tracking-wider">Total</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item, idx) => (
                  <tr key={idx} className={idx % 2 === 0 ? 'bg-muted/30' : ''}>
                    <td className="py-2.5 px-3 font-medium">{item.productName}</td>
                    <td className="py-2.5 px-3 text-center">{item.quantity}</td>
                    <td className="py-2.5 px-3 text-right">K{item.unitPrice.toFixed(2)}</td>
                    <td className="py-2.5 px-3 text-right font-bold">K{item.lineTotal.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Total */}
          <div className="flex justify-end">
            <div className="w-full max-w-xs space-y-1.5 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Total Items</span>
                <span>{items.length}</span>
              </div>
              <Separator />
              <div className="flex justify-between items-center bg-success text-white rounded-lg px-4 py-2.5">
                <span className="font-bold text-base">TOTAL</span>
                <span className="font-bold text-lg">K{total.toFixed(2)}</span>
              </div>
            </div>
          </div>

          {/* Notes */}
          {deliveryNote.notes && (
            <div className="border-t border-border pt-4">
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1">Notes</p>
              <p className="text-sm text-muted-foreground whitespace-pre-wrap">{deliveryNote.notes}</p>
            </div>
          )}
        </div>

        <div className="text-center text-[10px] text-muted-foreground py-2 border-t border-border bg-muted/30">
          Generated by Sale Point
        </div>
      </div>
    </div>
  );
};

export default DeliveryNoteView;
