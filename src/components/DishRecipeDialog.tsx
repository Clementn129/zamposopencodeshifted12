import { useMemo, useState } from "react";
import { Plus, Trash2, Check, ChefHat, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { Product } from "@/hooks/useProducts";
import { useIngredients, useRecipe } from "@/hooks/useIngredients";

interface Props {
  businessId: string;
  product: Product;
  onSaved?: () => void | Promise<void>;
}

const DishRecipeDialog = ({ businessId, product, onSaved }: Props) => {
  const { toast } = useToast();
  const { ingredients } = useIngredients(businessId);
  const { recipe, isLoading, addIngredient, updateQuantity, removeIngredient } = useRecipe(businessId, product.id);

  const [isDish, setIsDish] = useState(product.isDish);
  const [selectedIngredient, setSelectedIngredient] = useState<string>("");
  const [qty, setQty] = useState("");

  const ingredientById = useMemo(() => {
    const m = new Map(ingredients.map((i) => [i.id, i]));
    return m;
  }, [ingredients]);

  const totalCost = useMemo(
    () =>
      recipe.reduce((sum, r) => {
        const ing = ingredientById.get(r.ingredient_id);
        return sum + (ing ? Number(ing.cost_per_unit) * r.quantity : 0);
      }, 0),
    [recipe, ingredientById]
  );

  const margin = product.price - totalCost;
  const marginPct = product.price > 0 ? (margin / product.price) * 100 : 0;

  const toggleDish = async (next: boolean) => {
    setIsDish(next);
    const { error } = await supabase
      .from("products")
      .update({ is_dish: next, track_stock: !next })
      .eq("id", product.id);
    if (error) {
      setIsDish(!next);
      toast({ variant: "destructive", title: "Could not update dish setting" });
      return;
    }
    await onSaved?.();
  };

  const addLine = async () => {
    if (!selectedIngredient) {
      toast({ variant: "destructive", title: "Pick an ingredient" });
      return;
    }
    const n = parseInt(qty, 10);
    if (!Number.isFinite(n) || n <= 0) {
      toast({ variant: "destructive", title: "Enter a quantity" });
      return;
    }
    const ok = await addIngredient(selectedIngredient, n);
    if (!ok) {
      toast({ variant: "destructive", title: "Could not add to recipe" });
      return;
    }
    setSelectedIngredient("");
    setQty("");
    await onSaved?.();
  };

  const usedIngredientIds = new Set(recipe.map((r) => r.ingredient_id));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between rounded-lg border p-3">
        <div className="flex items-center gap-2">
          <ChefHat className="h-4 w-4 text-primary" />
          <div>
            <p className="text-sm font-medium">Prepare in kitchen (dish)</p>
            <p className="text-xs text-muted-foreground">
              Stock comes from the recipe below, not this item's own stock.
            </p>
          </div>
        </div>
        <Switch checked={isDish} onCheckedChange={(v) => void toggleDish(v)} />
      </div>

      {isDish && (
        <>
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-lg bg-secondary/50 p-2 text-center">
              <p className="text-xs text-muted-foreground">Cost</p>
              <p className="font-semibold text-sm">K {totalCost.toFixed(2)}</p>
            </div>
            <div className="rounded-lg bg-secondary/50 p-2 text-center">
              <p className="text-xs text-muted-foreground">Margin</p>
              <p className={`font-semibold text-sm ${margin < 0 ? "text-destructive" : ""}`}>K {margin.toFixed(2)}</p>
            </div>
            <div className="rounded-lg bg-secondary/50 p-2 text-center">
              <p className="text-xs text-muted-foreground">Margin %</p>
              <p className={`font-semibold text-sm ${marginPct < 0 ? "text-destructive" : ""}`}>{marginPct.toFixed(0)}%</p>
            </div>
          </div>

          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading recipe…</p>
          ) : recipe.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No ingredients yet. Add what goes into one plate/bowl below.
            </p>
          ) : (
            <div className="space-y-1.5">
              {recipe.map((r) => {
                const ing = ingredientById.get(r.ingredient_id);
                return (
                  <div key={r.id} className="flex items-center gap-2 bg-secondary/40 rounded-lg px-3 py-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{ing?.name ?? "Unknown ingredient"}</p>
                      <p className="text-xs text-muted-foreground">
                        {ing ? `K ${Number(ing.cost_per_unit).toFixed(2)} / ${ing.unit}` : ""}
                        {ing && ing.stock <= 0 ? <span className="text-destructive"> · out of stock</span> : null}
                      </p>
                    </div>
                    <Input
                      type="number"
                      min={0}
                      value={String(r.quantity)}
                      onChange={(e) => void updateQuantity(r.id, parseInt(e.target.value, 10) || 0)}
                      className="w-20"
                      aria-label="Quantity"
                    />
                    <span className="text-xs text-muted-foreground w-8">{ing?.unit ?? ""}</span>
                    <Button variant="ghost" size="icon" onClick={() => void removeIngredient(r.id).then(() => onSaved?.())} aria-label="Remove">
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                );
              })}
            </div>
          )}

          <div className="space-y-2 border border-border rounded-lg p-3">
            <Label className="text-xs">Add ingredient</Label>
            <div className="flex gap-2">
              <Select value={selectedIngredient} onValueChange={setSelectedIngredient}>
                <SelectTrigger className="flex-1">
                  <SelectValue placeholder={ingredients.length ? "Choose ingredient" : "No ingredients yet"} />
                </SelectTrigger>
                <SelectContent>
                  {ingredients.map((i) => (
                    <SelectItem key={i.id} value={i.id} disabled={usedIngredientIds.has(i.id)}>
                      {i.name} ({i.unit}){usedIngredientIds.has(i.id) ? " · added" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                type="number"
                min={1}
                value={qty}
                onChange={(e) => setQty(e.target.value)}
                placeholder="Qty"
                className="w-24"
                aria-label="Quantity"
              />
              <Button size="sm" onClick={addLine} disabled={!ingredients.length}>
                <Plus className="h-4 w-4" />
              </Button>
            </div>
            {ingredients.length === 0 && (
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <AlertTriangle className="h-3 w-3" /> Create ingredients from the Ingredients screen first.
              </p>
            )}
          </div>

          <p className="text-xs text-muted-foreground flex items-center gap-1">
            <Check className="h-3 w-3" /> Ingredients are deducted automatically when this dish is sold.
          </p>
        </>
      )}

      {!isDish && (
        <Badge variant="secondary" className="text-xs">
          Not a dish — sold as a normal item.
        </Badge>
      )}
    </div>
  );
};

export default DishRecipeDialog;