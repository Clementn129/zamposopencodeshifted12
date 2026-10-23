import { useState, useEffect } from "react";
import { useToast } from "@/hooks/use-toast";
import { useInvoices, Invoice, InvoiceItem } from "@/hooks/useInvoices";
import { Product } from "@/hooks/useProducts";
import InvoiceList from "./InvoiceList";
import InvoiceForm, { InvoicePrefill } from "./InvoiceForm";
import InvoiceView from "./InvoiceView";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type View = 'list' | 'new' | 'edit' | 'view';

interface BusinessDetailsExt {
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
  taxMode?: 'none' | 'vat' | 'custom';
  vatRate?: number;
  customTaxName?: string | null;
  customTaxRate?: number | null;
}

interface InvoiceTabProps {
  businessId: string;
  businessName: string;
  businessDetails: BusinessDetailsExt;
  products: Product[];
  isService?: boolean;
  prefill?: InvoicePrefill | null;
  onClearPrefill?: () => void;
  onInvoicePaid?: () => void;
}

const InvoiceTab = ({ businessId, businessName, businessDetails, products, isService, prefill, onClearPrefill, onInvoicePaid }: InvoiceTabProps) => {
  const { toast } = useToast();
  const { invoices, isLoading, createInvoice, updateInvoice, updateStatus, payInvoice, softDeleteInvoice, getInvoiceWithItems } = useInvoices(businessId);
  const [view, setView] = useState<View>('list');
  const [activeInvoice, setActiveInvoice] = useState<Invoice | null>(null);
  const [payTargetId, setPayTargetId] = useState<string | null>(null);
  const [listPaymentMethod, setListPaymentMethod] = useState("cash");

  // When a source document (quotation / delivery note) is selected in POS,
  // jump straight into the new-invoice form with it prefilled.
  useEffect(() => {
    if (prefill) {
      setActiveInvoice(null);
      setView('new');
    }
  }, [prefill]);

  const handleNew = () => { setActiveInvoice(null); setView('new'); };

  const handleView = async (id: string) => {
    const inv = await getInvoiceWithItems(id);
    if (inv) { setActiveInvoice(inv); setView('view'); }
  };

  const handleEdit = async (id: string) => {
    const inv = await getInvoiceWithItems(id);
    if (inv) { setActiveInvoice(inv); setView('edit'); }
  };

  const handleDelete = async (id: string) => {
    try {
      await softDeleteInvoice(id);
      toast({ title: 'Invoice deleted', description: 'No stock or records affected.' });
    } catch (e: any) {
      toast({ variant: 'destructive', title: 'Error', description: e.message });
    }
  };

  const handleSaveNew = async (
    inv: Omit<Invoice, 'id' | 'invoiceNumber' | 'businessId' | 'createdAt' | 'updatedAt' | 'deletedAt' | 'convertedSaleId'>,
    items: InvoiceItem[]
  ) => {
    await createInvoice(inv, items);
    setView('list');
    onClearPrefill?.();
  };

  const handleSaveEdit = async (
    inv: Omit<Invoice, 'id' | 'invoiceNumber' | 'businessId' | 'createdAt' | 'updatedAt' | 'deletedAt' | 'convertedSaleId'>,
    items: InvoiceItem[]
  ) => {
    if (!activeInvoice) return;
    await updateInvoice(activeInvoice.id, inv, items);
    setView('list');
  };

  const doPay = async (id: string, method: string) => {
    try {
      await payInvoice(id, method);
      toast({ title: 'Invoice paid', description: 'Sale created and stock updated.' });
      if (activeInvoice?.id === id) {
        setActiveInvoice(prev => prev ? { ...prev, status: 'paid', paymentMethod: method, convertedSaleId: 'pending' } : prev);
      }
      onInvoicePaid?.();
    } catch (e: any) {
      toast({ variant: 'destructive', title: 'Error', description: e.message });
    }
  };

  const handlePayConfirm = async () => {
    if (!payTargetId) return;
    const id = payTargetId;
    setPayTargetId(null);
    await doPay(id, listPaymentMethod);
  };

  const handleVoid = async (id: string) => {
    try {
      await updateStatus(id, 'void');
      toast({ title: 'Invoice voided' });
      if (activeInvoice?.id === id) {
        setActiveInvoice(prev => prev ? { ...prev, status: 'void' } : prev);
      }
    } catch (e: any) {
      toast({ variant: 'destructive', title: 'Error', description: e.message });
    }
  };

  const handlePrint = async (id: string) => {
    const inv = await getInvoiceWithItems(id);
    if (inv) { setActiveInvoice(inv); setView('view'); }
  };

  return (
    <>
      {view === 'list' && (
        <InvoiceList
          invoices={invoices}
          isLoading={isLoading}
          onNew={handleNew}
          onView={handleView}
          onEdit={handleEdit}
          onDelete={handleDelete}
          onPay={(id) => setPayTargetId(id)}
          onPrint={handlePrint}
        />
      )}

      {view === 'new' && (
        <InvoiceForm
          products={products}
          businessDetails={businessDetails}
          prefill={prefill}
          onSave={handleSaveNew}
          onCancel={() => { setView('list'); onClearPrefill?.(); }}
          isService={isService}
        />
      )}

      {view === 'edit' && activeInvoice && (
        <InvoiceForm
          products={products}
          businessDetails={businessDetails}
          existingInvoice={activeInvoice}
          onSave={handleSaveEdit}
          onCancel={() => setView('list')}
          isService={isService}
        />
      )}

      {view === 'view' && activeInvoice && (
        <InvoiceView
          invoice={activeInvoice}
          businessName={businessName}
          businessDetails={businessDetails}
          onBack={() => setView('list')}
          onEdit={() => setView('edit')}
          onPay={(method) => doPay(activeInvoice.id, method)}
          onVoid={() => handleVoid(activeInvoice.id)}
        />
      )}

      <AlertDialog open={!!payTargetId} onOpenChange={(open) => !open && setPayTargetId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Mark Invoice as Paid?</AlertDialogTitle>
            <AlertDialogDescription>
              This creates the sale (stock deducted, revenue added) and marks the source document as converted.
            </AlertDialogDescription>
            <div className="pt-2">
              <Select value={listPaymentMethod} onValueChange={setListPaymentMethod}>
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
            <AlertDialogAction className="bg-success text-success-foreground hover:bg-success/90" onClick={handlePayConfirm}>
              Confirm Payment
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};

export default InvoiceTab;