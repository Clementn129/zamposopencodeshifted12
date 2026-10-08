import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";

type DiningTableRow = Database["public"]["Tables"]["dining_tables"]["Row"];

export type DiningTable = DiningTableRow;

export interface UseDiningTables {
  tables: DiningTable[];
  loadError: string | null;
  isLoading: boolean;
  refetch: () => Promise<void>;
  createTable: (data: { name: string; floor?: string | null; capacity?: number; sort_order?: number }) => Promise<DiningTable | null>;
  updateTable: (id: string, patch: Partial<Pick<DiningTableRow, "name" | "floor" | "capacity" | "is_active" | "sort_order">>) => Promise<boolean>;
  deleteTable: (id: string) => Promise<boolean>;
}

export const useDiningTables = (businessId?: string, enabled = true): UseDiningTables => {
  const [tables, setTables] = useState<DiningTableRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const load = useCallback(async () => {
    if (!businessId || !enabled) return;
    setIsLoading(true);
    setLoadError(null);
    try {
      const { data, error } = await supabase
        .from("dining_tables")
        .select("*")
        .eq("business_id", businessId)
        .order("floor", { ascending: true, nullsFirst: true })
        .order("sort_order", { ascending: true })
        .order("name", { ascending: true });
      if (error) {
        console.warn("dining tables load error", error.message);
        setLoadError(error.message);
        return;
      }
      setTables(data ?? []);
    } finally {
      setIsLoading(false);
    }
  }, [businessId, enabled]);

  useEffect(() => {
    if (!businessId || !enabled) return;
    void load();
  }, [businessId, enabled, load]);

  const createTable = useCallback(
    async (data: { name: string; floor?: string | null; capacity?: number; sort_order?: number }) => {
      if (!businessId) return null;
      const { data: created, error } = await supabase
        .from("dining_tables")
        .insert({
          business_id: businessId,
          name: data.name.trim(),
          floor: data.floor?.trim() ? data.floor.trim() : null,
          capacity: Math.max(1, data.capacity ?? 2),
          sort_order: data.sort_order ?? 0,
        })
        .select()
        .single();
      if (error) {
        console.warn("createTable error", error.message);
        return null;
      }
      setTables((prev) => [...prev, created]);
      return created;
    },
    [businessId]
  );

  const updateTable = useCallback(
    async (id: string, patch: Partial<Pick<DiningTableRow, "name" | "floor" | "capacity" | "is_active" | "sort_order">>) => {
      const { error } = await supabase.from("dining_tables").update(patch).eq("id", id);
      if (error) {
        console.warn("updateTable error", error.message);
        return false;
      }
      setTables((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
      return true;
    },
    []
  );

  const deleteTable = useCallback(async (id: string) => {
    const { error } = await supabase.from("dining_tables").delete().eq("id", id);
    if (error) {
      console.warn("deleteTable error", error.message);
      return false;
    }
    setTables((prev) => prev.filter((t) => t.id !== id));
    return true;
  }, []);

  return useMemo(
    () => ({ tables, loadError, isLoading, refetch: load, createTable, updateTable, deleteTable }),
    [tables, loadError, isLoading, load, createTable, updateTable, deleteTable]
  );
};