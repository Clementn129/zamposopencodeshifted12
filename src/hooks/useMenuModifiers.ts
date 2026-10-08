import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";

type ModifierGroupRow = Database["public"]["Tables"]["menu_modifier_groups"]["Row"];
type ModifierRow = Database["public"]["Tables"]["menu_modifiers"]["Row"];
type ItemLinkRow = Database["public"]["Tables"]["menu_item_modifiers"]["Row"];

export type ModifierGroup = ModifierGroupRow;
export type MenuModifier = ModifierRow;

export interface UseMenuModifiers {
  groups: ModifierGroup[];
  modifiersByGroup: Record<string, MenuModifier[]>;
  groupIdsByProduct: Record<string, string[]>;
  isLoading: boolean;
  refetch: () => Promise<void>;
  createGroup: (name: string, opts?: { min?: number; max?: number }) => Promise<ModifierGroup | null>;
  updateGroup: (id: string, patch: Partial<Pick<ModifierGroupRow, "name" | "min_selections" | "max_selections" | "is_active" | "sort_order">>) => Promise<boolean>;
  deleteGroup: (id: string) => Promise<boolean>;
  createModifier: (group: ModifierGroup, name: string, priceAdjustment: number) => Promise<MenuModifier | null>;
  updateModifier: (id: string, patch: Partial<Pick<ModifierRow, "name" | "price_adjustment" | "is_active" | "sort_order">>) => Promise<boolean>;
  deleteModifier: (id: string) => Promise<boolean>;
  setProductGroups: (productId: string, groupIds: string[]) => Promise<boolean>;
}

export const useMenuModifiers = (businessId?: string, enabled = true): UseMenuModifiers => {
  const [groups, setGroups] = useState<ModifierGroup[]>([]);
  const [modifiersByGroup, setModifiersByGroup] = useState<Record<string, MenuModifier[]>>({});
  const [groupIdsByProduct, setGroupIdsByProduct] = useState<Record<string, string[]>>({});
  const [isLoading, setIsLoading] = useState(false);
  const loadedBusinessId = useRef<string | undefined>(undefined);

  const load = useCallback(async () => {
    if (!businessId || !enabled) return;
    setIsLoading(true);
    try {
      const [{ data: g, error: ge }, { data: m, error: me }, { data: l, error: le }] = await Promise.all([
        supabase.from("menu_modifier_groups").select("*").eq("business_id", businessId).order("sort_order", { ascending: true }).order("name", { ascending: true }),
        supabase.from("menu_modifiers").select("*").eq("business_id", businessId).order("sort_order", { ascending: true }).order("name", { ascending: true }),
        supabase.from("menu_item_modifiers").select("*").eq("business_id", businessId),
      ]);
      if (ge || me || le) {
        console.warn("menu modifiers load error", ge?.message ?? me?.message ?? le?.message);
        return;
      }
      setGroups((g ?? []).sort((a, b) => a.sort_order - b.sort_order));

      const modMap: Record<string, MenuModifier[]> = {};
      for (const mod of m ?? []) {
        (modMap[mod.group_id] ??= []).push(mod);
      }
      for (const key of Object.keys(modMap)) modMap[key].sort((a, b) => a.sort_order - b.sort_order);
      setModifiersByGroup(modMap);

      const linkMap: Record<string, string[]> = {};
      for (const link of l ?? []) {
        (linkMap[link.product_id] ??= []).push(link.modifier_group_id);
      }
      setGroupIdsByProduct(linkMap);
    } finally {
      setIsLoading(false);
    }
  }, [businessId, enabled]);

  useEffect(() => {
    if (!businessId || !enabled) return;
    void load();
    loadedBusinessId.current = businessId;
  }, [businessId, enabled, load]);

  const createGroup = useCallback(
    async (name: string, opts?: { min?: number; max?: number }) => {
      if (!businessId) return null;
      const { data, error } = await supabase
        .from("menu_modifier_groups")
        .insert({
          business_id: businessId,
          name: name.trim(),
          min_selections: opts?.min ?? 0,
          max_selections: opts?.max ?? 1,
        })
        .select()
        .single();
      if (error) {
        console.warn("createGroup error", error.message);
        return null;
      }
      setGroups((prev) => [...prev, data].sort((a, b) => a.sort_order - b.sort_order));
      return data;
    },
    [businessId]
  );

  const updateGroup = useCallback(
    async (id: string, patch: Partial<Pick<ModifierGroupRow, "name" | "min_selections" | "max_selections" | "is_active" | "sort_order">>) => {
      const { error } = await supabase.from("menu_modifier_groups").update(patch).eq("id", id);
      if (error) {
        console.warn("updateGroup error", error.message);
        return false;
      }
      setGroups((prev) => prev.map((g) => (g.id === id ? { ...g, ...patch } : g)));
      return true;
    },
    []
  );

  const deleteGroup = useCallback(
    async (id: string) => {
      const { error } = await supabase.from("menu_modifier_groups").delete().eq("id", id);
      if (error) {
        console.warn("deleteGroup error", error.message);
        return false;
      }
      setGroups((prev) => prev.filter((g) => g.id !== id));
      setModifiersByGroup((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      return true;
    },
    []
  );

  const createModifier = useCallback(
    async (group: ModifierGroup, name: string, priceAdjustment: number) => {
      if (!businessId) return null;
      const { data, error } = await supabase
        .from("menu_modifiers")
        .insert({
          business_id: businessId,
          group_id: group.id,
          name: name.trim(),
          price_adjustment: priceAdjustment,
        })
        .select()
        .single();
      if (error) {
        console.warn("createModifier error", error.message);
        return null;
      }
      setModifiersByGroup((prev) => ({
        ...prev,
        [group.id]: [...(prev[group.id] ?? []), data].sort((a, b) => a.sort_order - b.sort_order),
      }));
      return data;
    },
    [businessId]
  );

  const updateModifier = useCallback(
    async (id: string, patch: Partial<Pick<ModifierRow, "name" | "price_adjustment" | "is_active" | "sort_order">>) => {
      const { error } = await supabase.from("menu_modifiers").update(patch).eq("id", id);
      if (error) {
        console.warn("updateModifier error", error.message);
        return false;
      }
      setModifiersByGroup((prev) => {
        const next: Record<string, MenuModifier[]> = {};
        for (const [gid, list] of Object.entries(prev)) {
          next[gid] = list.map((m) => (m.id === id ? { ...m, ...patch } : m));
        }
        return next;
      });
      return true;
    },
    []
  );

  const deleteModifier = useCallback(
    async (id: string) => {
      const { error } = await supabase.from("menu_modifiers").delete().eq("id", id);
      if (error) {
        console.warn("deleteModifier error", error.message);
        return false;
      }
      setModifiersByGroup((prev) => {
        const next: Record<string, MenuModifier[]> = {};
        for (const [gid, list] of Object.entries(prev)) {
          next[gid] = list.filter((m) => m.id !== id);
        }
        return next;
      });
      return true;
    },
    []
  );

  const setProductGroups = useCallback(
    async (productId: string, groupIds: string[]) => {
      if (!businessId) return false;
      const { data: existing, error: le } = await supabase
        .from("menu_item_modifiers")
        .select("modifier_group_id")
        .eq("product_id", productId);
      if (le) {
        console.warn("setProductGroups load error", le.message);
        return false;
      }
      const current = new Set((existing ?? []).map((l: ItemLinkRow) => l.modifier_group_id));
      const desired = new Set(groupIds);

      const toAdd = [...desired].filter((gid) => !current.has(gid));
      const toRemove = [...current].filter((gid) => !desired.has(gid));

      const ops: Promise<unknown>[] = [];
      if (toAdd.length > 0) {
        ops.push(
          supabase.from("menu_item_modifiers").insert(toAdd.map((gid) => ({ product_id: productId, modifier_group_id: gid, business_id: businessId })))
        );
      }
      if (toRemove.length > 0) {
        ops.push(
          supabase
            .from("menu_item_modifiers")
            .delete()
            .eq("product_id", productId)
            .in("modifier_group_id", toRemove)
        );
      }
      const results = await Promise.all(ops);
      if (results.some((r) => (r as { error?: { message?: string } }).error)) {
        console.warn("setProductGroups write error");
        return false;
      }
      setGroupIdsByProduct((prev) => ({ ...prev, [productId]: groupIds }));
      return true;
    },
    [businessId]
  );

  return useMemo(
    () => ({ groups, modifiersByGroup, groupIdsByProduct, isLoading, refetch: load, createGroup, updateGroup, deleteGroup, createModifier, updateModifier, deleteModifier, setProductGroups }),
    [
      groups,
      modifiersByGroup,
      groupIdsByProduct,
      isLoading,
      load,
      createGroup,
      updateGroup,
      deleteGroup,
      createModifier,
      updateModifier,
      deleteModifier,
      setProductGroups,
    ]
  );
};