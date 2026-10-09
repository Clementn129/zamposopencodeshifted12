import { useState } from "react";
import { Plus, Pencil, Trash2, Check, X, Package, AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { useIngredients, Ingredient, RecipeLine } from "@/hooks/useIngredients";

interface Props {
  businessId: string;
  /** Optional: show which dishes use each ingredient. */
  recipes?: RecipeLine[];
}

const IngredientsManager = ({ businessId, recipes = [] }: Props) => {
  const { toast } = useToast();
  const { ingredients, isLoading, loadError, createIngredient, updateIngredient, deleteIngredient, restock } = useIngredients(businessId);

  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [unit, setUnit] = useState("g");
  const [stock, setStock] = useState("0");
  const [cost, setCost] = useState("");
  const [low, setLow] = useState("0");

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editUnit, setEditUnit] = useState("");
  const [editCost, setEditCost] = useState("");
  const [editLow, setEditLow] = useState("");

  const [restockId, setRestockId] = useState<string | null>(null);
  const [restockQty, setRestockQty] = useState("");
  const [restockCost, setRestockCost] = useState("");

  const countUsers = (ingredientId: string) =>
    recipes.filter((r) => r.ingredient_id === ingredientId).length;

  const resetAdd = () => {
    setName("");
    setUnit("g");
    setStock("0");
    setCost("");
    setLow("0");
    setAdding(false);
  };

  const startEdit = (i: Ingredient) => {
    setEditingId(i.id);
    setEditName(i.name);
    setEditUnit(i.unit);
    setEditCost(String(i.cost_per_unit ?? ""));
    setEditLow(String(i.low_stock_warning ?? 0));
  };

  const add = async () => {
    if (!name.trim()) {
      toast({ variant: "destructive", title: "Enter an ingredient name" });
      return;
    }
    const ok = await createIngredient({
      name,
      unit,
      stock: Number.isFinite(parseInt(stock, 10)) ? parseInt(stock, 10) : 0,
      cost_per_unit: cost.trim() ? Number(cost) : 0,
      low_stock_warning: Number.isFinite(parseInt(low, 10)) ? parseInt(low, 10) : 0,
    });
    if (!ok) {
      toast({ variant: "destructive", title: "Could not add ingredient" });
      return;
    }
    toast({ title: "Ingredient added" });
    resetAdd();
  };

  const saveEdit = async () => {
    if (!editingId) return;
    const ok = await updateIngredient(editingId, {
      name: editName.trim(),
      unit: editUnit.trim() || "g",
      cost_per_unit: editCost.trim() ? Number(editCost) : 0,
      low_stock_warning: Number.isFinite(parseInt(editLow, 10)) ? parseInt(editLow, 10) : 0,
    });
    if (!ok) {
      toast({ variant: "destructive", title: "Could not save" });
      return;
    }
    setEditingId(null);
  };

  const doRestock = async () => {
    if (!restockId) return;
    const qty = parseInt(restockQty, 10);
    if (!Number.isFinite(qty) || qty === 0) {
      toast({ variant: "destructive", title: "Enter a quantity" });
      return;
    }
    const ok = await restock(restockId, qty, restockCost.trim() ? Number(restockCost) : null);
    if (!ok) {
      toast({ variant: "destructive", title: "Could not restock" });
      return;
    }
    toast({ title: "Stock updated" });
    setRestockId(null);
    setRestockQty("");
    setRestockCost("");
  };

  const del = async (i: Ingredient) => {
    if (!confirm(`Delete "${i.name}"? This also removes it from any recipes.`)) return;
    const ok = await deleteIngredient(i.id);
    toast({ title: ok ? "Ingredient deleted" : "Could not delete" });
  };

  return (
    <Card className="border-0 shadow-none">
      <CardHeader className="px-0">
        <CardTitle className="text-base flex items-center gap-2">
          <Package className="h-5 w-5" /> Ingredients
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Kept in the smallest unit you count (e.g. grams, ml or pieces). Dish sales deduct these automatically.
        </p>
      </CardHeader>
      <CardContent className="px-0 space-y-3">
        {loadError && (
          <p className="text-xs text-destructive">Could not load ingredients: {loadError}</p>
        )}

        {!adding ? (
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            <Plus className="h-4 w-4 mr-1" /> Add ingredient
          </Button>
        ) : (
          <div className="rounded-lg border p-3 space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <div className="col-span-2">
                <Label className="text-xs">Name</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Chicken breast" />
              </div>
              <div>
                <Label className="text-xs">Unit</Label>
                <Input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="g / ml / pcs" />
              </div>
              <div>
                <Label className="text-xs">Opening stock</Label>
                <Input type="number" value={stock} onChange={(e) => setStock(e.target.value)} />
              </div>
              <div>
                <Label className="text-xs">Cost per unit (K)</Label>
                <Input type="number" step="0.0001" value={cost} onChange={(e) => setCost(e.target.value)} placeholder="0" />
              </div>
              <div>
                <Label className="text-xs">Low warning at</Label>
                <Input type="number" value={low} onChange={(e) => setLow(e.target.value)} />
              </div>
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={add}><Check className="h-4 w-4 mr-1" /> Save</Button>
              <Button size="sm" variant="ghost" onClick={resetAdd}><X className="h-4 w-4 mr-1" /> Cancel</Button>
            </div>
          </div>
        )}

        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : ingredients.length === 0 ? (
          <p className="text-sm text-muted-foreground">No ingredients yet.</p>
        ) : (
          <div className="space-y-2">
            {ingredients.map((i) => {
              const isLow = i.low_stock_warning > 0 && i.stock <= i.low_stock_warning;
              const users = countUsers(i.id);
              return (
                <div key={i.id} className="rounded-lg border p-3 space-y-2">
                  {editingId === i.id ? (
                    <>
                      <div className="grid grid-cols-2 gap-2">
                        <div className="col-span-2">
                          <Label className="text-xs">Name</Label>
                          <Input value={editName} onChange={(e) => setEditName(e.target.value)} />
                        </div>
                        <div>
                          <Label className="text-xs">Unit</Label>
                          <Input value={editUnit} onChange={(e) => setEditUnit(e.target.value)} />
                        </div>
                        <div>
                          <Label className="text-xs">Cost / unit (K)</Label>
                          <Input type="number" step="0.0001" value={editCost} onChange={(e) => setEditCost(e.target.value)} />
                        </div>
                        <div>
                          <Label className="text-xs">Low warning at</Label>
                          <Input type="number" value={editLow} onChange={(e) => setEditLow(e.target.value)} />
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <Button size="sm" onClick={saveEdit}><Check className="h-4 w-4 mr-1" /> Save</Button>
                        <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}><X className="h-4 w-4 mr-1" /> Cancel</Button>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-medium truncate">{i.name}</span>
                            {isLow && (
                              <Badge variant="destructive" className="text-[10px] px-1.5 py-0">
                                <AlertTriangle className="h-3 w-3 mr-0.5" /> Low
                              </Badge>
                            )}
                          </div>
                          <p className="text-xs text-muted-foreground">
                            {i.stock} {i.unit} on hand · K {Number(i.cost_per_unit).toFixed(4)}/{i.unit}
                            {users > 0 ? ` · used in ${users} dish${users === 1 ? "" : "es"}` : ""}
                          </p>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <Button size="sm" variant="outline" onClick={() => { setRestockId(i.id); setRestockQty(""); setRestockCost(""); }}>
                            <RefreshCw className="h-3.5 w-3.5 mr-1" /> Restock
                          </Button>
                          <Button size="icon" variant="ghost" onClick={() => startEdit(i)} aria-label="Edit"><Pencil className="h-4 w-4" /></Button>
                          <Button size="icon" variant="ghost" onClick={() => del(i)} aria-label="Delete"><Trash2 className="h-4 w-4" /></Button>
                        </div>
                      </div>

                      {restockId === i.id && (
                        <div className="flex items-end gap-2 rounded-md bg-muted/50 p-2">
                          <div className="w-24">
                            <Label className="text-xs">Qty to add</Label>
                            <Input type="number" value={restockQty} onChange={(e) => setRestockQty(e.target.value)} placeholder="e.g. 5000" />
                          </div>
                          <div className="w-28">
                            <Label className="text-xs">New cost/unit (K)</Label>
                            <Input type="number" step="0.0001" value={restockCost} onChange={(e) => setRestockCost(e.target.value)} placeholder="optional" />
                          </div>
                          <Button size="sm" onClick={doRestock}><Check className="h-4 w-4" /></Button>
                          <Button size="sm" variant="ghost" onClick={() => setRestockId(null)}><X className="h-4 w-4" /></Button>
                        </div>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
};

export default IngredientsManager;