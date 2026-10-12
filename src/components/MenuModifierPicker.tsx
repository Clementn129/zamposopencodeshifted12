import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { useMenuModifiers, ModifierGroup } from "@/hooks/useMenuModifiers";

export interface ModifierPick {
  id: string;
  groupId: string;
  name: string;
  priceAdjustment: number;
}

interface Props {
  open: boolean;
  product: { id: string; name: string; basePrice: number } | null;
  groups: ModifierGroup[];
  modifiersByGroup: Record<string, Array<{ id: string; name: string; price_adjustment: number }>>;
  groupIdsByProduct: Record<string, string[]>;
  onClose: () => void;
  onConfirm: (modifiers: ModifierPick[], unitPrice: number) => void;
}

const MenuModifierPicker = ({ open, product, groups, modifiersByGroup, groupIdsByProduct, onClose, onConfirm }: Props) => {
  const [selections, setSelections] = useState<Record<string, string[]>>({});

  useEffect(() => {
    if (open) setSelections({});
  }, [open, product?.id]);

  if (!product || !open) return null;

  const productGroupIds = groupIdsByProduct[product.id] ?? [];
  const productGroups = groups.filter((g) => productGroupIds.includes(g.id));
  const activeGroups = productGroups.filter((g) => (modifiersByGroup[g.id] ?? []).length > 0);

  const unitPrice = product.basePrice + activeGroups.reduce((sum, g) => {
    const sel = selections[g.id] ?? [];
    return sum + sel.reduce((s, modId) => {
      const mod = (modifiersByGroup[g.id] ?? []).find((m) => m.id === modId);
      return s + (mod?.price_adjustment ?? 0);
    }, 0);
  }, 0);

  const buildPicks = (): ModifierPick[] =>
    activeGroups.flatMap((g) =>
      (selections[g.id] ?? []).map((modId) => {
        const mod = (modifiersByGroup[g.id] ?? []).find((m) => m.id === modId);
        return { id: modId, groupId: g.id, name: mod?.name ?? modId, priceAdjustment: mod?.price_adjustment ?? 0 };
      })
    );

  const canConfirm = activeGroups.every((g) => {
    const count = (selections[g.id] ?? []).length;
    return count >= g.min_selections && count <= g.max_selections;
  });

  const toggle = (groupId: string, modId: string, max: number) => {
    setSelections((prev) => {
      const current = prev[groupId] ?? [];
      if (current.includes(modId)) return { ...prev, [groupId]: current.filter((x) => x !== modId) };
      if (max <= 1) return { ...prev, [groupId]: [modId] };
      if (current.length >= max) return prev;
      return { ...prev, [groupId]: [...current, modId] };
    });
  };

  if (activeGroups.length === 0) {
    // No modifier groups — just add the item at its base price.
    return (
      <Dialog open={open} onOpenChange={() => onClose()}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{product.name}</DialogTitle>
            <DialogDescription>No options required.</DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2">
            <span className="font-semibold">K{product.basePrice.toFixed(2)}</span>
            <Button className="ml-auto" onClick={() => { onConfirm([], product.basePrice); onClose(); }}>
              <Plus className="h-4 w-4 mr-1" /> Add
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={() => onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto max-w-md">
        <DialogHeader>
          <DialogTitle>{product.name}</DialogTitle>
          <DialogDescription>Choose your options.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {activeGroups.map((g) => (
            <div key={g.id} className="space-y-1">
              <p className="text-sm font-medium">
                {g.name}
                <span className="text-xs text-muted-foreground ml-1">
                  {g.min_selections > 0 && g.min_selections === g.max_selections
                    ? `(choose ${g.min_selections})`
                    : `(${g.min_selections}–${g.max_selections})`}
                </span>
              </p>
              <div className="space-y-1">
                {(modifiersByGroup[g.id] ?? []).map((m) => {
                  const selected = (selections[g.id] ?? []).includes(m.id);
                  return (
                    <button
                      key={m.id}
                      onClick={() => toggle(g.id, m.id, g.max_selections)}
                      className={`w-full flex items-center justify-between text-left rounded-lg border px-3 py-2 transition ${
                        selected ? "border-primary bg-primary/10" : "border-border bg-secondary/40 hover:bg-secondary"
                      }`}
                    >
                      <span className="text-sm">{m.name}</span>
                      <span className="text-sm">
                        {m.price_adjustment > 0 ? `+K${m.price_adjustment.toFixed(2)}` : m.price_adjustment < 0 ? `-K${Math.abs(m.price_adjustment).toFixed(2)}` : ""}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between border-t border-border pt-3 mt-2">
          <span className="font-semibold">K{unitPrice.toFixed(2)}</span>
          <Button onClick={() => { onConfirm(buildPicks(), unitPrice); onClose(); }} disabled={!canConfirm}>
            <Plus className="h-4 w-4 mr-1" /> Add to order
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default MenuModifierPicker;
export type { ModifierGroup };