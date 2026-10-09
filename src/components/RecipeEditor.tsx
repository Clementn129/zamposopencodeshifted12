import { useMemo } from "react";
import { ChefHat, Plus, Trash2, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatZMW } from "@/lib/currency";
import { useIngredients } from "@/hooks/useIngredients";

/** A recipe row while it is being edited (not yet persisted). */
export interface DraftRecipeLine {
  ingredientId: string;
  quantity: number;
}

interface RecipeEditorProps {
  businessId: string;
  isDish: boolean;
  onDishChange: (value: boolean) => void;
  lines: DraftRecipeLine[];
  onLinesChange: (lines: DraftRecipeLine[]) => void;
  disabled?: boolean;
  loading?: boolean;
}

/**
 * Dish / recipe section for the product create & edit dialog.
 *
 * Controlled: the parent owns the dish flag and the ingredient lines, and is
 * responsible for saving them once the product exists. Ingredient options are
 * loaded here so the section stays self-contained.
 */
const RecipeEditor = ({
  businessId,
  isDish,
  onDishChange,
  lines,
  onLinesChange,
  disabled = false,
  loading = false,
}: RecipeEditorProps) => {
  const { ingredients, loadError } = useIngredients(businessId, isDish);

  const costById = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of ingredients) m.set(i.id, Number(i.cost_per_unit) || 0);
    return m;
  }, [ingredients]);

  const totalCost = useMemo(
    () => lines.reduce((sum, l) => sum + (costById.get(l.ingredientId) ?? 0) * (Number(l.quantity) || 0), 0),
    [lines, costById],
  );

  const updateLine = (index: number, patch: Partial<DraftRecipeLine>) => {
    onLinesChange(lines.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  };

  return (
    <div className="space-y-3 border rounded-lg p-3 bg-muted/20">
      <div className="flex items-center justify-between gap-3">
        <div>
          <Label className="flex items-center gap-1">
            <ChefHat className="h-4 w-4" /> Dish / Recipe
          </Label>
          <p className="text-xs text-muted-foreground">
            Track this as a dish made from ingredients. Stock is deducted from the ingredients, not this item.
          </p>
        </div>
        <Switch checked={isDish} onCheckedChange={onDishChange} disabled={disabled} />
      </div>

      {isDish && (
        <>
          {loadError && (
            <p className="text-xs text-destructive flex items-center gap-1">
              <AlertTriangle className="h-3.5 w-3.5" /> Could not load ingredients.
            </p>
          )}

          {loading ? (
            <p className="text-xs text-muted-foreground">Loading recipe…</p>
          ) : (
            <>
              {lines.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  No ingredients yet. Add at least one so stock can be deducted on sale.
                </p>
              )}

              {lines.map((line, index) => (
                <div key={index} className="flex items-center gap-2">
                  <Select
                    value={line.ingredientId || undefined}
                    onValueChange={(v) => updateLine(index, { ingredientId: v })}
                    disabled={disabled}
                  >
                    <SelectTrigger className="flex-1">
                      <SelectValue placeholder="Choose ingredient" />
                    </SelectTrigger>
                    <SelectContent>
                      {ingredients.map((ing) => (
                        <SelectItem key={ing.id} value={ing.id}>
                          {ing.name} ({ing.unit})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <div className="flex items-center gap-1 shrink-0">
                    <Input
                      type="number"
                      min={0}
                      className="w-20"
                      value={String(line.quantity)}
                      onChange={(e) => updateLine(index, { quantity: Math.max(0, parseInt(e.target.value || "0", 10) || 0) })}
                      disabled={disabled}
                    />
                    <span className="text-xs text-muted-foreground w-8">
                      {line.ingredientId ? ingredients.find((i) => i.id === line.ingredientId)?.unit : ""}
                    </span>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => onLinesChange(lines.filter((_, i) => i !== index))}
                    disabled={disabled}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}

              <div className="flex items-center justify-between gap-3">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => onLinesChange([...lines, { ingredientId: "", quantity: 1 }])}
                  disabled={disabled || ingredients.length === 0}
                >
                  <Plus className="h-4 w-4 mr-1" /> Add ingredient
                </Button>
                {totalCost > 0 && (
                  <span className="text-xs text-muted-foreground">
                    Ingredient cost: <strong>{formatZMW(totalCost)}</strong>
                  </span>
                )}
              </div>

              {ingredients.length === 0 && !loadError && (
                <p className="text-xs text-muted-foreground">
                  No ingredients yet. Add them under Products → Ingredients first.
                </p>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
};

export default RecipeEditor;
