// Thin, typed wrapper around the desktop preload bridge. Every call degrades
// to null/false in the browser (PWA), so shared UI stays safe to mount there.

export interface LicenceStatus {
  valid: boolean;
  expired?: boolean;
  businessId?: string;
  businessCode?: string | null;
  plan?: string | null;
  issuedAt?: string | null;
  expiresAt?: string;
  daysRemaining?: number;
  rollbackDetected?: boolean;
  error?: string;
}

export interface ActivationBusiness {
  id: string;
  name: string;
  code?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  taxMode?: 'none' | 'vat' | 'custom' | null;
  vatRate?: number | null;
  customTaxName?: string | null;
  customTaxRate?: number | null;
  tpin?: string | null;
  logoUrl?: string | null;
  vatNumber?: string | null;
  businessType?: string | null;
  subscriptionStatus?: string | null;
  subscriptionExpiresAt?: string | null;
}

export interface ActivationProduct {
  id: string;
  name: string;
  price: number;
  stock: number;
  category?: string | null;
  barcode?: string | null;
  sku?: string | null;
  imageUrl?: string | null;
  costPrice?: number | null;
  reorderLevel?: number | null;
  isActive?: boolean | null;
  branchId?: string | null;
  expiryDate?: string | null;
}

export interface ActivationPayload {
  kind: 'activation';
  v: number;
  issuedAt: string;
  business: ActivationBusiness;
  subscription?: {
    status?: string;
    expiresAt?: string | null;
    plan?: string | null;
  };
  products: ActivationProduct[];
  owner: {
    userId: string;
    email: string;
    passwordHash: string;
    role: 'owner';
    lastOnlineLogin: string;
  };
}

export interface ActivationUnsealResult {
  ok: boolean;
  error?: string;
  payload?: ActivationPayload;
  secretSaved?: boolean;
  licenceStatus?: {
    status: LicenceStatus;
    payload?: unknown;
  } | null;
  licenceError?: string | null;
}

interface ElectronBridge {
  checkForUpdates?: () => Promise<{ ok: boolean; version?: string | null; error?: string }>;
  dataDir?: {
    get: () => Promise<string>;
    open: () => Promise<{ ok: boolean; error?: string | null }>;
  };
  activation?: {
    unseal: (buffer: ArrayBuffer, pin: string) => Promise<ActivationUnsealResult>;
    commit: (buffer: ArrayBuffer, pin: string, password: string) => Promise<ActivationUnsealResult>;
  };
  licence?: {
    status: () => Promise<LicenceStatus>;
    current: () => Promise<string | null>;
    import: (token: string) => Promise<{ ok: boolean; status?: LicenceStatus; error?: string }>;
  };
  secrets?: {
    get: () => Promise<{ email: string; password: string } | null>;
    clear: () => Promise<{ ok: boolean }>;
  };
}

export const electronBridge = (): ElectronBridge | undefined => {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { electronAPI?: ElectronBridge }).electronAPI;
};

export const isElectron = (): boolean => !!electronBridge();

export async function getLicenceStatus(): Promise<LicenceStatus | null> {
  try {
    return (await electronBridge()?.licence?.status()) ?? null;
  } catch {
    return null;
  }
}

export async function getLicenceToken(): Promise<string | null> {
  try {
    return (await electronBridge()?.licence?.current()) ?? null;
  } catch {
    return null;
  }
}

export async function importLicenceToken(
  token: string,
): Promise<{ ok: boolean; status?: LicenceStatus; error?: string }> {
  const bridge = electronBridge();
  if (!bridge?.licence) return { ok: false, error: 'Licensing is only available in the desktop app.' };
  try {
    const result = await bridge.licence.import(token);
    if (result.ok) notifyLicenceChanged();
    return result;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Licence import failed.' };
  }
}

export async function getDataDir(): Promise<string | null> {
  try {
    return (await electronBridge()?.dataDir?.get()) ?? null;
  } catch {
    return null;
  }
}

export async function openDataDir(): Promise<boolean> {
  try {
    const result = await electronBridge()?.dataDir?.open();
    return !!result?.ok;
  } catch {
    return false;
  }
}

export async function getActivationSecret(): Promise<{ email: string; password: string } | null> {
  try {
    return (await electronBridge()?.secrets?.get()) ?? null;
  } catch {
    return null;
  }
}

export async function clearActivationSecret(): Promise<void> {
  try {
    await electronBridge()?.secrets?.clear();
  } catch {
    // noop
  }
}

export const LICENCE_CHANGED_EVENT = 'zampos:licence-changed';

export function notifyLicenceChanged(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(LICENCE_CHANGED_EVENT));
  }
}
