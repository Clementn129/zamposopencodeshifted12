import { useState } from "react";
import { FileText, Plus, Eye, Trash2, Truck, CheckCircle, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { DeliveryNote } from "@/hooks/useDeliveryNotes";

interface DeliveryNoteListProps {
  deliveryNotes: DeliveryNote[];
  isLoading: boolean;
  onNew: () => void;
  onView: (id: string) => void;
  onMarkDelivered: (id: string) => void;
  onDelete: (id: string) => void;
}

const statusColors: Record<string, string> = {
  pending: 'bg-warning/15 text-warning',
  delivered: 'bg-success/15 text-success',
  completed: 'bg-primary/15 text-primary',
  invoiced: 'bg-muted text-muted-foreground',
};

const statusLabels: Record<string, string> = {
  pending: 'Pending',
  delivered: 'Delivered',
  completed: 'Completed',
  invoiced: 'Invoiced',
};

const DeliveryNoteList = ({ deliveryNotes, isLoading, onNew, onView, onMarkDelivered, onDelete }: DeliveryNoteListProps) => {
  const [search, setSearch] = useState("");

  const filtered = deliveryNotes.filter(dn => {
    const s = search.toLowerCase();
    return !s || dn.deliveryNoteNumber.toLowerCase().includes(s) ||
      (dn.customerName && dn.customerName.toLowerCase().includes(s));
  });

  if (isLoading) {
    return <div className="flex items-center justify-center py-12"><p className="text-muted-foreground">Loading delivery notes…</p></div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Search delivery notes…" className="pl-9" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <Button variant="pos" onClick={onNew}>
          <Plus className="h-4 w-4 mr-1" /> New Delivery Note
        </Button>
      </div>

      {filtered.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Truck className="h-12 w-12 text-muted-foreground mb-3" />
            <p className="text-muted-foreground">{search ? 'No delivery notes match your search.' : 'No delivery notes yet. Create your first one!'}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {filtered.map(dn => (
            <Card key={dn.id} className="hover:shadow-md transition-shadow">
              <CardContent className="py-3 px-4">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <p className="font-display font-semibold text-sm">{dn.deliveryNoteNumber}</p>
                      <Badge variant="secondary" className={`text-[10px] px-1.5 py-0 ${statusColors[dn.status] || ''}`}>
                        {statusLabels[dn.status] || 'Pending'}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground truncate">
                      {dn.customerName || 'No customer'}
                      {dn.driverName ? ` • Driver: ${dn.driverName}` : ''}
                      {dn.carPlate ? ` • ${dn.carPlate}` : ''}
                      {' • '}{new Date(dn.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => onView(dn.id)} title="View">
                      <Eye className="h-3.5 w-3.5" />
                    </Button>
                    {dn.status === 'pending' && (
                      <Button variant="ghost" size="icon" className="h-8 w-8 text-success" onClick={() => onMarkDelivered(dn.id)} title="Mark Delivered">
                        <CheckCircle className="h-3.5 w-3.5" />
                      </Button>
                    )}
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" title="Delete">
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Delete Delivery Note?</AlertDialogTitle>
                          <AlertDialogDescription>
                            This will archive {dn.deliveryNoteNumber}. No records will be affected.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction onClick={() => onDelete(dn.id)} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                            Delete
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
};

export default DeliveryNoteList;
