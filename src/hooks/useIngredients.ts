import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";

type IngredientRow = Database["public"]["Tables"]["ingredients"]["Row"];
type RecipeIngredientRow = Database["public"]["Tables"]["recipe_ingredients"]["Row"];

export type Ingredient = IngredientRow;
export type RecipeLine = RecipeIngredientRow;

export interface UseIngredients {
  ingredients: Ingredient[];
  loadError: string | null;
  isLoading: boolean;
  refetch: () => Promise<void>;
  createIngredient: (data: {
    name: string;
    unit?: string;
    cost_per_unit?: number;
    low_stock_warning?: number;
    stock?: number;
  }) => Promise<boolean>;
  updateIngredient: (
    id: string,
    patch: Partial<Pick<Ingredient, "name" | "unit" | "cost_per_unit" | "low_stock_warning" | "stock" | "is_active">>
  ) => Promise<boolean>;
  deleteIngredient: (id: string) => Promise<boolean>;
  restock: (id: string, quantity: number, unitCost?: number | null) => Promise<boolean>;
}

export const useIngredients = (businessId?: string, enabled = true): UseIngredients => {
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    if (!businessId || !enabled) return;
    setIsLoading(true);
    setLoadError(null);
    try {
      const { data, error } = await supabase
        .from("ingredients")
        .select("*")
        .eq("business_id", businessId)
        .order("name", { ascending: true });
      if (error) {
        console.warn("ingredients load error", error.message);
        setLoadError(error.message);
        return;
      }
      setIngredients(data ?? []);
    } finally {
      setIsLoading(false);
    }
  }, [businessId, enabled]);

  useEffect(() => {
    if (!businessId || !enabled) return;
    void refetch();
  }, [businessId, enabled, refetch]);

  const createIngredient = useCallback(
    async (data: { name: string; unit?: string; cost_per_unit?: number; low_stock_warning?: number; stock?: number }) => {
      if (!businessId || !data.name.trim()) return false;
      const { error } = await supabase.from("ingredients").insert({
        business_id: businessId,
        name: data.name.trim(),
        unit: (data.unit?.trim() || "g"),
        cost_per_unit: data.cost_per_unit ?? 0,
        low_stock_warning: data.low_stock_warning ?? 0,
        stock: data.stock ?? 0,
      });
      if (error) {
        console.warn("create ingredient error", error.message);
        return false;
      }
      await refetch();
      return true;
    },
    [businessId, refetch]
  );

  const updateIngredient = useCallback(
    async (
      id: string,
      patch: Partial<Pick<Ingredient, "name" | "unit" | "cost_per_unit" | "low_stock_warning" | "stock" | "is_active">>
    ) => {
      const { error } = await supabase.from("ingredients").update(patch).eq("id", id);
      if (error) {
        console.warn("update ingredient error", error.message);
        return false;
      }
      setIngredients((prev) => prev.map((i) => (i.id === id ? { ...i, ...patch } : i)));
      return true;
    },
    []
  );

  const deleteIngredient = useCallback(async (id: string) => {
    const { error } = await supabase.from("ingredients").delete().eq("id", id);
    if (error) {
      console.warn("delete ingredient error", error.message);
      return false;
    }
    setIngredients((prev) => prev.filter((i) => i.id !== id));
    return true;
  }, []);

  const restock = useCallback(
    async (id: string, quantity: number, unitCost?: number | null) => {
      if (!Number.isFinite(quantity) || quantity === 0) return false;
      const { error } = await supabase.rpc("restock_ingredient", {
        p_ingredient_id: id,
        p_quantity: Math.trunc(quantity),
        p_unit_cost: unitCost ?? null,
      });
      if (error) {
        console.warn("restock error", error.message);
        return false;
      }
      await refetch();
      return true;
    },
    [refetch]
  );

  return { ingredients, isLoading, loadError, refetch, createIngredient, updateIngredient, deleteIngredient, restock };
};

export interface UseRecipe {
  recipe: RecipeIngredientRow[];
  isLoading: boolean;
  refetch: () => Promise<void>;
  addIngredient: (ingredientId: string, quantity: number) => Promise<boolean>;
  updateQuantity: (id: string, quantity: number) => Promise<boolean>;
  removeIngredient: (id: string) => Promise<boolean>;
}

export const useRecipe = (businessId: string | undefined, productId: string | null, enabled = true): UseRecipe => {
  const [recipe, setRecipe] = useState<RecipeIngredientRow[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const refetch = useCallback(async () => {
    if (!productId || !enabled) {
      setRecipe([]);
      return;
    }
    setIsLoading(true);
    try {
      const { data, error } = await supabase
        .from("recipe_ingredients")
        .select("*")
        .eq("product_id", productId)
        .order("created_at", { ascending: true });
      if (error) {
        console.warn("recipe load error", error.message);
        return;
      }
      setRecipe(data ?? []);
    } finally {
      setIsLoading(false);
    }
  }, [productId, enabled]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  const addIngredient = useCallback(
    async (ingredientId: string, quantity: number) => {
      if (!businessId || !productId) return false;
      const { error } = await supabase.from("recipe_ingredients").insert({
        business_id: businessId,
        product_id: productId,
        ingredient_id: ingredientId,
        quantity: Math.max(0, Math.trunc(quantity)),
      });
      if (error) {
        console.warn("add recipe line error", error.message);
        return false;
      }
      await refetch();
      return true;
    },
    [businessId, productId, refetch]
  );

  const updateQuantity = useCallback(
    async (id: string, quantity: number) => {
      const q = Math.max(0, Math.trunc(quantity));
      const { error } = await supabase.from("recipe_ingredients").update({ quantity: q }).eq("id", id);
      if (error) {
        console.warn("update recipe line error", error.message);
        return false;
      }
      setRecipe((prev) => prev.map((r) => (r.id === id ? { ...r, quantity: q } : r)));
      return true;
    },
    []
  );

  const removeIngredient = useCallback(async (id: string) => {
    const { error } = await supabase.from("recipe_ingredients").delete().eq("id", id);
    if (error) {
      console.warn("remove recipe line error", error.message);
      return false;
    }
    setRecipe((prev) => prev.filter((r) => r.id !== id));
    return true;
  }, []);

  return { recipe, isLoading, refetch, addIngredient, updateQuantity, removeIngredient };
};