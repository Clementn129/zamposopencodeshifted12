import { useState, useEffect } from "react";
import { useToast } from "@/hooks/use-toast";
import { useDeliveryNotes, DeliveryNote, DeliveryNoteItem } from "@/hooks/useDeliveryNotes";
import { Product } from "@/hooks/useProducts";
import DeliveryNoteList from "./DeliveryNoteList";
import DeliveryNoteForm from "./DeliveryNoteForm";
import DeliveryNoteView from "./DeliveryNoteView";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";

type View = 'list' | 'new' | 'view';

interface BusinessDetailsExt {
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  logoUrl?: string | null;
  bankName?: string | null;
  bankAccountName?: string | null;
  bankAccountNumber?: string | null;
  bankBranch?: string | null;
  bankSwift?: string | null;
}

interface DeliveryNoteTabProps {
  businessId: string;
  businessName: string;
  businessDetails: BusinessDetailsExt;
  products: Product[];
  quotationId?: string | null;
  quotationItems?: Array<{ productId: string; productName: string; quantity: number; unitPrice: number; lineTotal: number }> | null;
  quotationCustomer?: { name?: string | null; phone?: string | null } | null;
  onClearQuotation?: () => void;
  onCreateInvoice?: (deliveryNoteId: string) => void;
}

const DeliveryNoteTab = ({ businessId, businessName, businessDetails, products, quotationId, quotationItems, quotationCustomer, onClearQuotation, onCreateInvoice }: DeliveryNoteTabProps) => {
  const { toast } = useToast();
  const { deliveryNotes, isLoading, createDeliveryNote, updateDeliveryNoteStatus, softDeleteDeliveryNote, getDeliveryNoteWithItems } = useDeliveryNotes(businessId);
  const [view, setView] = useState<View>('list');
  const [activeNote, setActiveNote] = useState<DeliveryNote | null>(null);
  const [hidePrices, setHidePrices] = useState(false);

  // When a quotation is selected in POS, jump straight to the new delivery-note
  // form with the quotation items prefilled.
  useEffect(() => {
    if (quotationId) {
      setActiveNote(null);
      setView('new');
    }
  }, [quotationId]);

  const handleNew = () => {
    setActiveNote(null);
    setView('new');
  };

  const handleView = async (id: string) => {
    const dn = await getDeliveryNoteWithItems(id);
    if (dn) { setActiveNote(dn); setView('view'); }
  };

  const handleDelete = async (id: string) => {
    try {
      await softDeleteDeliveryNote(id);
      toast({ title: 'Delivery note deleted' });
    } catch (e: any) {
      toast({ variant: 'destructive', title: 'Error', description: e.message });
    }
  };

  const handleMarkDelivered = async (id: string) => {
    try {
      await updateDeliveryNoteStatus(id, 'delivered');
      toast({ title: 'Marked as delivered' });
      if (activeNote?.id === id) {
        setActiveNote(prev => prev ? { ...prev, status: 'delivered' } : null);
      }
    } catch (e: any) {
      toast({ variant: 'destructive', title: 'Error', description: e.message });
    }
  };

  const handleSaveNew = async (
    dn: Omit<DeliveryNote, 'id' | 'deliveryNoteNumber' | 'businessId' | 'createdAt' | 'updatedAt' | 'deletedAt'>,
    items: DeliveryNoteItem[]
  ) => {
    await createDeliveryNote(dn, items);
    setView('list');
    onClearQuotation?.();
  };

  return (
    <>
      {view === 'list' && (
        <DeliveryNoteList
          deliveryNotes={deliveryNotes}
          isLoading={isLoading}
          onNew={handleNew}
          onView={handleView}
          onMarkDelivered={handleMarkDelivered}
          onDelete={handleDelete}
        />
      )}

      {view === 'new' && (
        <DeliveryNoteForm
          products={products}
          quotationId={quotationId}
          quotationItems={quotationItems}
          quotationCustomer={quotationCustomer}
          onSave={handleSaveNew}
          onCancel={() => { setView('list'); onClearQuotation?.(); }}
        />
      )}

      {view === 'view' && activeNote && (
        <div className="space-y-4">
          <div className="flex items-center justify-between bg-muted/50 p-2 rounded-lg border border-border">
            <div className="flex items-center gap-2">
              <Switch 
                id="hide-prices" 
                checked={hidePrices} 
                onCheckedChange={setHidePrices} 
              />
              <Label htmlFor="hide-prices" className="text-xs font-medium">Hide Prices on PDF/Print</Label>
            </div>
            <p className="text-[10px] text-muted-foreground">Toggles prices in the preview and exported document</p>
          </div>
          <DeliveryNoteView
            deliveryNote={activeNote}
            businessName={businessName}
            businessDetails={businessDetails}
            onBack={() => setView('list')}
            onMarkDelivered={handleMarkDelivered}
            onCreateInvoice={onCreateInvoice ? () => onCreateInvoice(activeNote.id) : undefined}
            hidePrices={hidePrices}
          />
        </div>
      )}
    </>
  );
};

export default DeliveryNoteTab;
