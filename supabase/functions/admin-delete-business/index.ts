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

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (!email || !email.includes("@") || email.length > 320) return null;
  return email;
}

async function findAuthUserIdsByEmail(admin: any, email: string) {
  const found = new Set<string>();

  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;

    for (const user of data.users ?? []) {
      if (user.email?.trim().toLowerCase() === email) found.add(user.id);
    }

    if (!data.users || data.users.length < 1000) break;
  }

  return [...found];
}

async function deleteAuthUsers(admin: any, userIds: string[]) {
  const uniqueIds = [...new Set(userIds.filter(Boolean))];
  const results = await Promise.allSettled(
    uniqueIds.map(id => admin.auth.admin.deleteUser(id))
  );

  const errors = results
    .filter((r): r is PromiseRejectedResult => r.status === "rejected")
    .map(e => e.reason instanceof Error ? e.message : "Unknown error");

  if (errors.length > 0) {
    throw new Error(`Failed to delete some accounts: ${errors.join(", ")}`);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "Missing authorization" }, 401);

  // Verify caller is a super admin
  const caller = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: userErr } = await caller.auth.getUser();
  if (userErr || !user) return json({ error: "Not authenticated" }, 401);

  const { data: roles } = await caller
    .from("user_roles")
    .select("role")
    .eq("user_id", user.id);
  if (!roles?.some((r) => r.role === "super_admin")) {
    return json({ error: "Not authorized" }, 403);
  }

  let body;
  try { body = await req.json(); } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const businessId = String(body.business_id ?? "");
  const email = normalizeEmail(body.email);
  if (!businessId && !email) return json({ error: "Missing business_id or email" }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  if (!businessId && email) {
    try {
      const { data: profileRows, error: profileErr } = await admin
        .from("profiles")
        .select("user_id")
        .ilike("email", email);
      if (profileErr) throw profileErr;

      const { data: businessRows, error: businessErr } = await admin
        .from("businesses")
        .select("user_id")
        .ilike("email", email);
      if (businessErr) throw businessErr;

      const authIds = await findAuthUserIdsByEmail(admin, email);
      const userIds = [
        ...(profileRows ?? []).map((row) => row.user_id),
        ...(businessRows ?? []).map((row) => row.user_id),
        ...authIds,
      ];

      if (userIds.length === 0) return json({ ok: true, deletedUsers: 0 });
      await deleteAuthUsers(admin, userIds);
      return json({ ok: true, deletedUsers: new Set(userIds).size });
    } catch (e) {
      console.error("Failed to clean up account by email:", e);
      return json({ error: e instanceof Error ? e.message : "Failed to clean up account" }, 500);
    }
  }

  // Get the business to find the user_id before deleting
  const { data: biz, error: bizErr } = await admin
    .from("businesses")
    .select("id, user_id, name")
    .eq("id", businessId)
    .maybeSingle();

  if (bizErr) return json({ error: bizErr.message }, 500);
  if (!biz) return json({ error: "Business not found" }, 404);

  try {
    const { data: cashiers, error: cashierErr } = await admin
      .from("business_cashiers")
      .select("auth_user_id")
      .eq("business_id", biz.id);
    if (cashierErr) throw cashierErr;

    // Delete cashier auth accounts first. business_cashiers rows are removed
    // when the business cascades, but their auth users are separate accounts.
    await deleteAuthUsers(admin, (cashiers ?? []).map((cashier) => cashier.auth_user_id));

    // Delete the owner auth user — cascades to profiles, user_roles,
    // businesses, and all business-related data. Throw if it fails so the UI
    // never reports success while the email still exists in auth.
    await deleteAuthUsers(admin, [biz.user_id]);
  } catch (e) {
    console.error("Failed to delete business account:", e);
    return json({ error: e instanceof Error ? e.message : "Failed to delete user" }, 500);
  }

  return json({ ok: true });
});
