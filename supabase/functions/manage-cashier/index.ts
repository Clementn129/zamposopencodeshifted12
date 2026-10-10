// Owner-facing edge function to create/manage cashier accounts for a business.
// Auth: requires a signed-in owner JWT. Uses service-role to provision the
// cashier's internal auth user and apply the "cashier" role.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function internalEmail(businessId: string, username: string) {
  const short = businessId.replace(/-/g, "").slice(0, 12);
  const u = username.toLowerCase().replace(/[^a-z0-9]/g, "");
  return `c-${short}-${u}@zampos.local`;
}

function pinPassword(pin: string) {
  return `zampos-${pin}`;
}

function validatePin(pin: unknown): string | null {
  if (typeof pin !== "string") return null;
  if (!/^\d{4,6}$/.test(pin)) return null;
  return pin;
}

function validateUsername(u: unknown): string | null {
  if (typeof u !== "string") return null;
  const v = u.trim().toLowerCase();
  if (!/^[a-z0-9_]{2,20}$/.test(v)) return null;
  return v;
}

function validateRole(r: unknown): string {
  if (r === "cashier" || r === "manager") return r;
  return "cashier";
}

// Best-effort in-memory throttle for the public cashier_login action. This is a
// per-isolate guard (Supabase may run several isolates), so it is a speed bump
// against business-code/username enumeration, not a hard guarantee. It must
// never block legitimately different callers: the key is scoped per IP+code.
const LOGIN_WINDOW_MS = 60_000;
const LOGIN_MAX_ATTEMPTS = 10;
const loginAttempts = new Map<string, { count: number; resetAt: number }>();

function loginRateLimited(key: string): boolean {
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || entry.resetAt <= now) {
    if (loginAttempts.size > 5000) {
      for (const [k, v] of loginAttempts) {
        if (v.resetAt <= now) loginAttempts.delete(k);
      }
    }
    loginAttempts.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > LOGIN_MAX_ATTEMPTS;
}

// Postgres 42703 / PostgREST PGRST204 both mean the column is absent, i.e. the
// CAPEX + cashier-stock-access migration has not been applied.
const MISSING_COLUMN_RE = /column .* does not exist|PGRST204|42703/i;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  const action = String(body.action ?? "");

  // Public action: cashier login (no auth required)
  if (action === "cashier_login") {
    const code = typeof body.code === "string" ? body.code.trim().toUpperCase() : "";
    const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
    const pin = validatePin(body.pin);
    if (!code || !username || !pin) return json({ error: "Missing code, username or PIN" }, 400);

    const clientIp = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
    if (loginRateLimited(`${clientIp}|${code}`)) {
      return json({ error: "Too many login attempts. Please try again in a minute." }, 429);
    }

    const { data: bizRow } = await admin
      .from("businesses")
      .select("id")
      .eq("payment_code", code)
      .maybeSingle();
    if (!bizRow) return json({ error: "Invalid business code" }, 404);

    const { data: cashier } = await admin
      .from("business_cashiers")
      .select("id, is_active")
      .eq("business_id", bizRow.id)
      .eq("username", username)
      .maybeSingle();
    if (!cashier) return json({ error: "Cashier account not found" }, 404);
    if (!cashier.is_active) return json({ error: "Account is disabled. Please contact your owner." }, 403);

    // Stamp last_login_at so the owner's Cashier Activity view stays accurate.
    await admin
      .from("business_cashiers")
      .update({ last_login_at: new Date().toISOString() })
      .eq("id", cashier.id);

    const email = internalEmail(bizRow.id, username);
    return json({ ok: true, email, password: pinPassword(pin) });

  }

  // Owner-only actions below
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "Missing authorization" }, 401);

  const caller = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userErr } = await caller.auth.getUser();
  if (userErr || !userData.user) return json({ error: "Not authenticated" }, 401);
  const owner = userData.user;

  // Resolve the target business (the active branch/shop). Legacy fallback for
  // single-business owners that don't pass a business_id keeps old clients working.
  const targetBusinessId = typeof body.business_id === "string" ? body.business_id : null;

  let biz: { id: string } | null = null;
  if (targetBusinessId) {
    const { data, error } = await admin
      .from("businesses")
      .select("id")
      .eq("id", targetBusinessId)
      .eq("user_id", owner.id)
      .maybeSingle();
    if (error) return json({ error: error.message }, 403);
    biz = data;
  } else {
    const { data, error } = await admin
      .from("businesses")
      .select("id")
      .eq("user_id", owner.id)
      .order("created_at", { ascending: true })
      .limit(2);
    if (error) return json({ error: error.message }, 403);
    if (data.length === 1) biz = data[0];
  }
  if (!biz) return json({ error: "No business found for this owner" }, 403);

  try {
    if (action === "create") {
      const username = validateUsername(body.username);
      const pin = validatePin(body.pin);
      const displayName = typeof body.display_name === "string" ? body.display_name.trim() : null;
      const role = validateRole(body.role);
      // Per-cashier stock access. Defaults to false so a caller that predates
      // this flag can never accidentally grant it.
      const canAdjustStock = body.can_adjust_stock === true;
      if (!username) return json({ error: "Username must be 2-20 letters/numbers/underscore" }, 400);
      if (!pin) return json({ error: "PIN must be 4-6 digits" }, 400);

      // Check existing username
      const { data: existing } = await admin
        .from("business_cashiers")
        .select("id")
        .eq("business_id", biz.id)
        .eq("username", username)
        .maybeSingle();
      if (existing) return json({ error: "That username is already in use" }, 409);

      // Cashier count is unlimited; subscription price scales with active cashiers.


      const email = internalEmail(biz.id, username);
      const password = pinPassword(pin);

      const { data: created, error: createErr } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { cashier: true, business_id: biz.id, username, display_name: displayName },
      });
      if (createErr || !created.user) {
        return json({ error: createErr?.message || "Failed to create cashier auth user" }, 500);
      }

      // Cleanup helper if subsequent inserts fail
      const cleanup = async () => {
        try { await admin.auth.admin.deleteUser(created.user!.id); } catch { /* ignore */ }
      };

      // Insert business_cashiers row (cap trigger enforces hard limit too)
      const rowInsert: Record<string, unknown> = {
        business_id: biz.id,
        auth_user_id: created.user.id,
        username,
        display_name: displayName,
        is_active: true,
        role,
      };
      // Only send the column when granted. Writing it against an un-migrated
      // table would fail the insert and orphan the auth user we just created.
      if (canAdjustStock) rowInsert.can_adjust_stock = true;

      let createdRow = null;
      const { data: insertedRow, error: insErr } = await admin
        .from("business_cashiers")
        .insert(rowInsert)
        .select()
        .single();

      if (insErr) {
        // The migration has not been applied yet. Create the cashier without
        // the stock flag rather than failing the whole operation.
        if (canAdjustStock && MISSING_COLUMN_RE.test(insErr.message)) {
          // Must omit the column entirely, not set it false: the error was
          // caused by the column not existing, so spreading it back in
          // (even as false) would fail the same way.
          const { can_adjust_stock: _omitted, ...legacyInsert } = rowInsert;
          const retry = await admin
            .from("business_cashiers")
            .insert(legacyInsert)
            .select()
            .single();
          if (retry.error) {
            await cleanup();
            return json({ error: retry.error.message }, 500);
          }
          createdRow = retry.data;
        } else {
          await cleanup();
          return json({ error: insErr.message }, 500);
        }
      } else {
        createdRow = insertedRow;
      }
      const row = createdRow;

      // Assign cashier role (handle_new_user trigger created a business_owner role
      // by default — remove it and assign cashier instead).
      await admin.from("user_roles").delete().eq("user_id", created.user.id);
      const { error: roleErr } = await admin
        .from("user_roles")
        .insert({ user_id: created.user.id, role: "cashier" });
      if (roleErr) {
        await admin.from("business_cashiers").delete().eq("id", row.id);
        await cleanup();
        return json({ error: roleErr.message }, 500);
      }

      // The handle_new_user trigger also auto-created a 'businesses' row for this
      // internal user — delete it so the cashier doesn't have a phantom business.
      // If this fails, the cashier would OWN an empty business: get_my_role()
      // returns 'owner' (owner is checked first) and get_my_business_id()/group
      // resolve the phantom, silently pulling them onto the wrong tenant. Fail
      // the whole provisioning instead of leaving a half-created cashier.
      const { error: bizDelErr } = await admin
        .from("businesses")
        .delete()
        .eq("user_id", created.user.id);
      if (bizDelErr) {
        await admin.from("user_roles").delete().eq("user_id", created.user.id);
        await admin.from("business_cashiers").delete().eq("id", row.id);
        await cleanup();
        return json({ error: "Failed to finalize cashier account" }, 500);
      }

      return json({ ok: true, cashier: row });
    }

    if (action === "reset_pin") {
      const cashierId = String(body.cashier_id ?? "");
      const pin = validatePin(body.pin);
      if (!cashierId) return json({ error: "Missing cashier_id" }, 400);
      if (!pin) return json({ error: "PIN must be 4-6 digits" }, 400);

      const { data: cashier, error: cErr } = await admin
        .from("business_cashiers")
        .select("id, auth_user_id, business_id")
        .eq("id", cashierId)
        .maybeSingle();
      if (cErr || !cashier || cashier.business_id !== biz.id) {
        return json({ error: "Cashier not found" }, 404);
      }

      const { error: updErr } = await admin.auth.admin.updateUserById(cashier.auth_user_id, {
        password: pinPassword(pin),
      });
      if (updErr) return json({ error: updErr.message }, 500);

      return json({ ok: true });
    }

    if (action === "set_active") {
      const cashierId = String(body.cashier_id ?? "");
      const isActive = Boolean(body.is_active);
      if (!cashierId) return json({ error: "Missing cashier_id" }, 400);

      const { data: cashier } = await admin
        .from("business_cashiers")
        .select("id, business_id")
        .eq("id", cashierId)
        .maybeSingle();
      if (!cashier || cashier.business_id !== biz.id) return json({ error: "Cashier not found" }, 404);

      const { error: uErr } = await admin
        .from("business_cashiers")
        .update({ is_active: isActive })
        .eq("id", cashierId);
      if (uErr) {
        return json({ error: uErr.message }, 409);
      }
      return json({ ok: true });
    }


    if (action === "set_stock_access") {
      const cashierId = String(body.cashier_id ?? "");
      const canAdjust = body.can_adjust_stock === true;
      if (!cashierId) return json({ error: "Missing cashier_id" }, 400);

      const { data: cashier } = await admin
        .from("business_cashiers")
        .select("id, business_id")
        .eq("id", cashierId)
        .maybeSingle();
      if (!cashier || cashier.business_id !== biz.id) return json({ error: "Cashier not found" }, 404);

      const { error: uErr } = await admin
        .from("business_cashiers")
        .update({ can_adjust_stock: canAdjust })
        .eq("id", cashierId);
      if (uErr) {
        // Migration not applied — say so plainly instead of a generic failure.
        if (MISSING_COLUMN_RE.test(uErr.message)) {
          return json({ error: "Stock access needs its database migration first." }, 409);
        }
        return json({ error: uErr.message }, 409);
      }
      return json({ ok: true });
    }


    if (action === "delete") {
      const cashierId = String(body.cashier_id ?? "");
      if (!cashierId) return json({ error: "Missing cashier_id" }, 400);

      const { data: cashier } = await admin
        .from("business_cashiers")
        .select("id, auth_user_id, business_id")
        .eq("id", cashierId)
        .maybeSingle();
      if (!cashier || cashier.business_id !== biz.id) return json({ error: "Cashier not found" }, 404);

      await admin.from("business_cashiers").delete().eq("id", cashierId);
      try { await admin.auth.admin.deleteUser(cashier.auth_user_id); } catch { /* ignore */ }
      return json({ ok: true });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    console.error("manage-cashier error:", e);
    const msg = e instanceof Error ? e.message : "Internal error";
    return json({ error: msg }, 500);
  }
});
