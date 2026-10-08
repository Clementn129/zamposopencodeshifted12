import { createContext, useContext, ReactNode } from "react";

// Read-only view of the app-wide sync stack. AppSyncManager is the single
// owner of these hooks; pages consume their state/actions from here instead
// of mounting second hook instances (which duplicated timers, RPCs and
// pulls on every POS load).
export interface SyncStatusValue {
  isSyncing: boolean;
  pendingCount: number;
  lastSyncError: string | null;
  syncNow: () => Promise<void>;
  failedOps: Array<{
    id: string;
    type: string;
    lastError?: string;
    retryCount?: number;
    createdAt?: string;
  }>;
  retryFailedOps: (opIds: string[]) => Promise<void>;
  clearFailedOps: (opIds: string[]) => void;
  syncOpsNow: () => Promise<void>;
  isPulling: boolean;
  pullNow: () => Promise<void>;
}

const SyncStatusContext = createContext<SyncStatusValue | null>(null);

export const SyncStatusProvider = ({
  value,
  children,
}: {
  value: SyncStatusValue;
  children: ReactNode;
}) => <SyncStatusContext.Provider value={value}>{children}</SyncStatusContext.Provider>;

export const useSyncStatus = (): SyncStatusValue => {
  const ctx = useContext(SyncStatusContext);
  if (!ctx) {
    throw new Error("useSyncStatus must be used within SyncStatusProvider");
  }
  return ctx;
};
