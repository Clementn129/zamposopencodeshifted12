import { useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { useQuotations, Quotation, QuotationItem } from "@/hooks/useQuotations";
import { Product } from "@/hooks/useProducts";
import QuotationList from "./QuotationList";
import QuotationForm from "./QuotationForm";
import QuotationView from "./QuotationView";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";

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

interface QuotationTabProps {
  businessId: string;
  businessName: string;
  businessDetails: BusinessDetailsExt;
  products: Product[];
  isService?: boolean;
  onConvertToSale: (items: Array<{ productId: string; name: string; price: number; quantity: number; discountType?: string | null; discountValue?: number }>, discountType: string | null, discountValue: number) => void;
  onCreateDeliveryNote?: (quotationId: string) => void;
  onCreateInvoice?: (quotationId: string) => void;
}

const QuotationTab = ({ businessId, businessName, businessDetails, products, isService, onConvertToSale, onCreateDeliveryNote, onCreateInvoice }: QuotationTabProps) => {
  const { toast } = useToast();
  const { quotations, isLoading, createQuotation, updateQuotation, softDeleteQuotation, getQuotationWithItems } = useQuotations(businessId);
  const [view, setView] = useState<View>('list');
  const [activeQuotation, setActiveQuotation] = useState<Quotation | null>(null);
  const [convertId, setConvertId] = useState<string | null>(null);

  const handleNew = () => { setActiveQuotation(null); setView('new'); };

  const handleView = async (id: string) => {
    const q = await getQuotationWithItems(id);
    if (q) { setActiveQuotation(q); setView('view'); }
  };

  const handleEdit = async (id: string) => {
    const q = await getQuotationWithItems(id);
    if (q) { setActiveQuotation(q); setView('edit'); }
  };

  const handleDelete = async (id: string) => {
    try {
      await softDeleteQuotation(id);
      toast({ title: 'Quotation deleted', description: 'No stock or records affected.' });
    } catch (e: any) {
      toast({ variant: 'destructive', title: 'Error', description: e.message });
    }
  };

  const handleSaveNew = async (
    q: Omit<Quotation, 'id' | 'quotationNumber' | 'businessId' | 'createdAt' | 'updatedAt' | 'deletedAt' | 'convertedSaleId'>,
    items: QuotationItem[]
  ) => {
    await createQuotation(q, items);
    setView('list');
  };

  const handleSaveEdit = async (
    q: Omit<Quotation, 'id' | 'quotationNumber' | 'businessId' | 'createdAt' | 'updatedAt' | 'deletedAt' | 'convertedSaleId'>,
    items: QuotationItem[]
  ) => {
    if (!activeQuotation) return;
    await updateQuotation(activeQuotation.id, q, items);
    setView('list');
  };

  const handleConvertConfirm = async () => {
    if (!convertId) return;
    try {
      const q = await getQuotationWithItems(convertId);
      if (!q || !q.items || q.items.length === 0) {
        toast({ variant: 'destructive', title: 'Error', description: 'Quotation has no items.' });
        return;
      }
      // Pass items to POS sale flow — stock deduction happens there
      onConvertToSale(
        q.items.map(i => ({
          productId: i.productId || '',
          name: i.productName,
          price: i.unitPrice,
          quantity: i.quantity,
          discountType: i.discountType,
          discountValue: i.discountValue,
          unitPrice: i.unitPrice,
          lineTotal: i.lineTotal,
        })),
        q.discountType,
        q.discountValue
      );
      // Don't mark as converted here — the sale hasn't completed yet.
      // markConverted happens after the sale is actually saved in Pos.tsx
      toast({ title: 'Quotation loaded into cart', description: 'Complete the sale to deduct stock.' });
      setConvertId(null);
    } catch (e: any) {
      if (e.message.includes('quota') || e.message.includes('storage')) {
        toast({ variant: 'destructive', title: 'Image Upload Error', description: 'Image upload quota exceeded. Try reducing image sizes or count.' });
      } else {
        toast({ variant: 'destructive', title: 'Error', description: e.message });
      }
    }
  };

  const handlePrint = async (id: string) => {
    const q = await getQuotationWithItems(id);
    if (q) { setActiveQuotation(q); setView('view'); }
  };

  return (
    <>
      {view === 'list' && (
        <QuotationList
          quotations={quotations}
          isLoading={isLoading}
          onNew={handleNew}
          onView={handleView}
          onEdit={handleEdit}
          onDelete={handleDelete}
          onConvert={(id) => setConvertId(id)}
          onPrint={handlePrint}
        />
      )}

      {view === 'new' && (
        <QuotationForm
          products={products}
          businessDetails={businessDetails}
          onSave={handleSaveNew}
          onCancel={() => setView('list')}
          isService={isService}
        />
      )}

      {view === 'edit' && activeQuotation && (
        <QuotationForm
          products={products}
          businessDetails={businessDetails}
          existingQuotation={activeQuotation}
          onSave={handleSaveEdit}
          onCancel={() => setView('list')}
          isService={isService}
        />
      )}

      {view === 'view' && activeQuotation && (
        <QuotationView
          quotation={activeQuotation}
          businessName={businessName}
          businessDetails={businessDetails}
          onBack={() => setView('list')}
          onEdit={() => setView('edit')}
          onConvert={() => setConvertId(activeQuotation.id)}
          onCreateDeliveryNote={onCreateDeliveryNote ? () => onCreateDeliveryNote(activeQuotation.id) : undefined}
          onCreateInvoice={onCreateInvoice ? () => onCreateInvoice(activeQuotation.id) : undefined}
        />
      )}

      <AlertDialog open={!!convertId} onOpenChange={(open) => !open && setConvertId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Convert to Sale?</AlertDialogTitle>
            <AlertDialogDescription>
              This will load the quotation items into your cart. Stock will only be deducted when you complete the sale. The quotation will be marked as "Converted".
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConvertConfirm}>Convert & Load Cart</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};

export default QuotationTab;
