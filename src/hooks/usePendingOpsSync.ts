import { useEffect, useCallback, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { getPendingOps, removePendingOp, updatePendingOpRetry, mergeServerProducts, mergeServerDebtors, mergeServerInvoices, generateOfflineId, getPendingImageUpload, removePendingImageUpload, getPermanentlyFailedOps, resetFailedOps } from "@/lib/offlineStorage";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";

// Maximum number of retries before marking an op as permanently failed
// Keep in sync with offlineStorage.MAX_RETRIES: a transient outage must not
// permanently strand a money/stock operation after only a few attempts.
const MAX_RETRIES = 20;

// Shared across hook instances so duplicate mounts (AppSyncManager + page-level
// banners) never process the same ops concurrently.
let globalOpsSyncInFlight = false;

const resolvePendingImageUrl = async (imageUrl: string | null | undefined, bId: string): Promise<string | null> => {
  if (!imageUrl || !imageUrl.startsWith('pending:')) return imageUrl ?? null;
  const uploadId = imageUrl.replace('pending:', '');
  const upload = await getPendingImageUpload(uploadId);
  if (!upload) return null;
  const ext = upload.originalName.split('.').pop() || 'jpg';
  const path = `${bId}/${crypto.randomUUID()}.${ext}`;
  const { error: upErr } = await supabase.storage
    .from('product-images')
    .upload(path, upload.blob, { cacheControl: '3600', upsert: false });
  if (upErr) throw upErr;
  // NOTE: the pending blob is intentionally kept until the DB write succeeds.
  // Removing it here would destroy the image if the following insert/update
  // threw, losing it permanently on retry.
  return path;
};

const clearResolvedPendingImage = async (imageUrl: string | null | undefined): Promise<void> => {
  if (!imageUrl || !imageUrl.startsWith('pending:')) return;
  try {
    await removePendingImageUpload(imageUrl.replace('pending:', ''));
  } catch (e) {
    console.error('Could not remove pending image upload:', e);
  }
};

const isUuid = (v: string): boolean => /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(v);

// Offline-created invoices carry an `offline_*` local id. Resolve it to the
// real DB id so table-update ops (soft delete, item re-insert) target the row
// created by the earlier `invoice_create` replay.
const resolveInvoiceId = async (id: string): Promise<string | null> => {
  if (!id) return null;
  if (isUuid(id)) return id;
  const { data } = await supabase.from('invoices').select('id').eq('offline_id', id).maybeSingle();
  return data?.id ?? null;
};

export function usePendingOpsSync(businessId: string | undefined, preventNegativeStock?: boolean) {
  const { isOnline } = useOnlineStatus();
  const [failedOps, setFailedOps] = useState<Array<{
    id: string;
    type: string;
    lastError?: string;
    retryCount?: number;
    createdAt?: string;
  }>>([]);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);

  const refreshFailedOps = useCallback(async () => {
    if (!businessId) {
      setFailedOps([]);
      return;
    }
    try {
      const failed = await getPermanentlyFailedOps(businessId);
      setFailedOps(failed.map((op) => ({
        id: op.id,
        type: op.type,
        lastError: op.lastError,
        retryCount: op.retryCount,
        createdAt: op.createdAt,
      })));
    } catch {
      // ignore
    }
  }, [businessId]);

  const runSync = useCallback(async () => {
    if (!businessId || !isOnline || globalOpsSyncInFlight) return;

    globalOpsSyncInFlight = true;
    try {
      const ops = (await getPendingOps(businessId))
        .slice()
        .sort((a, b) => {
          const ta = new Date(a.createdAt).getTime();
          const tb = new Date(b.createdAt).getTime();
          if (ta !== tb) return ta - tb;
          return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        });
      if (ops.length === 0) return;

      const processed: string[] = [];

      for (const op of ops) {
        // Skip permanently failed ops (exceeded max retries)
        if (op.permanentlyFailed) {
          continue;
        }
        
        try {
          switch (op.type) {
            case 'debtor_create': {
              const amountPaid = op.payload.amountPaid || 0;
              const { data: returnedSaleId, error: saleErr } = await (supabase.rpc as any)("sync_offline_sale", {
                p_business_id: businessId,
                p_offline_id: op.payload.offlineId || generateOfflineId(),
                p_items: op.payload.items,
                p_subtotal: op.payload.subtotal || op.payload.total || 0,
                p_total: op.payload.total || 0,
                p_discount_amount: op.payload.discountAmount || 0,
                p_discount_type: op.payload.discountType || null,
                p_payment_method: op.payload.paymentMethod || 'credit',
                p_created_at: op.payload.createdAt || new Date().toISOString(),
                p_tax_amount: op.payload.taxAmount || 0,
                p_taxable_amount: op.payload.taxableAmount || 0,
                p_zero_rated_amount: op.payload.zeroRatedAmount || 0,
                p_exempt_amount: op.payload.exemptAmount || 0,
                p_customer_name: op.payload.customerName,
                p_customer_tpin: op.payload.customerTpin || null,
                p_amount_paid: amountPaid,
                p_due_date: op.payload.dueDate || null,
                p_customer_phone: op.payload.customerPhone || null,
                p_table_id: (op.payload as any).tableId || null,
              });

              if (saleErr) throw saleErr;

              const { error: debtorErr } = await supabase.from('debtors').insert({
                business_id: businessId,
                sale_id: returnedSaleId,
                customer_name: op.payload.customerName,
                customer_phone: op.payload.customerPhone || null,
                amount_owed: op.payload.total,
                amount_paid: amountPaid,
                status: amountPaid > 0 ? 'partially_paid' : 'unpaid',
                notes: op.payload.notes || null,
                due_date: op.payload.dueDate || null,
              });

              if (debtorErr) throw debtorErr;
              processed.push(op.id);
              break;
            }

            case 'debtor_payment': {
              const { error: payError } = await supabase.from('debtor_payments').insert({
                debtor_id: op.payload.debtorId,
                amount: op.payload.amount,
                notes: op.payload.notes || null,
              });
              if (payError) throw payError;

              const { data: debtorRow } = await supabase
                .from('debtors')
                .select('amount_paid, amount_owed, sale_id')
                .eq('id', op.payload.debtorId)
                .maybeSingle();

              if (debtorRow) {
                const newAmountPaid = Number(debtorRow.amount_paid || 0) + op.payload.amount;
                const newStatus = newAmountPaid >= Number(debtorRow.amount_owed || 0) ? 'paid' : 'partially_paid';

                await supabase.from('debtors').update({ amount_paid: newAmountPaid, status: newStatus }).eq('id', op.payload.debtorId);

                if (debtorRow.sale_id) {
                  try {
                    const { data: saleRow } = await supabase
                      .from('sales')
                      .select('amount_paid, total')
                      .eq('id', debtorRow.sale_id)
                      .maybeSingle();

                    if (saleRow) {
                      const currentPaid = Number(saleRow.amount_paid || 0);
                      const newSalePaid = Math.min(currentPaid + op.payload.amount, Number(saleRow.total || 0));

                      await supabase.from('sale_payments').insert({
                        sale_id: debtorRow.sale_id,
                        business_id: businessId,
                        amount: op.payload.amount,
                        payment_method: 'cash',
                        notes: 'Payment via debtors',
                        recorded_by: op.payload.userId || '00000000-0000-0000-0000-000000000000',
                      });

                      await supabase.from('sales').update({ amount_paid: newSalePaid }).eq('id', debtorRow.sale_id);
                    }
                  } catch {
                    // ignore linked sale update failure
                  }
                }
              }

              processed.push(op.id);
              break;
            }

            case 'product_create': {
              const tempId = op.payload.tempId;
              // Cashiers have no INSERT rights on products (RLS is owner-only), so a
              // quick-add made offline must replay through the member-callable function.
              const isQuickAdd = op.payload.quickAdd === true;
              let newProductId: string | undefined;

              if (isQuickAdd) {
                const { data: quickId, error: quickErr } = await supabase.rpc('quick_add_product', {
                  p_business_id: businessId,
                  p_name: op.payload.name,
                  p_price: op.payload.price,
                });
                if (quickErr) throw quickErr;
                newProductId = quickId || undefined;
              } else {
                const imageUrl = await resolvePendingImageUrl(op.payload.image_url, businessId);
                const { data: created, error: createErr } = await supabase.from('products').insert({
                  business_id: businessId,
                  is_active: true,
                  name: op.payload.name,
                  price: op.payload.price,
                  cost_price: op.payload.cost_price ?? op.payload.costPrice,
                  stock: op.payload.stock,
                  minimum_stock: op.payload.minimum_stock ?? op.payload.minimumStock,
                  category: op.payload.category,
                  tax_category: op.payload.tax_category ?? op.payload.taxCategory ?? 'taxable',
                  barcode: op.payload.barcode || null,
                  item_type: op.payload.item_type ?? op.payload.itemType ?? 'product',
                  image_url: imageUrl,
                  track_expiry: op.payload.track_expiry ?? op.payload.trackExpiry ?? false,
                  track_stock: op.payload.track_stock ?? op.payload.trackStock ?? true,
                  expiry_date: op.payload.expiry_date ?? op.payload.expiryDate ?? null,
                }).select('id');
                if (createErr) throw createErr;
                newProductId = created?.[0]?.id;
                await clearResolvedPendingImage(op.payload.image_url);
              }

              // If this product was created offline with a temp ID, any sales that synced
              // before this product existed will have items referencing the temp ID.
              // Decrement stock for those sales now. Quick-adds are untracked (stock 0),
              // so they never get this fixup.
              if (tempId && newProductId && !isQuickAdd) {
                try {
                  const { data: affectedSales } = await supabase
                    .from('sales')
                    .select('id, items')
                    .eq('business_id', businessId)
                    .filter('items', 'cs', `[{"productId": "${tempId}"}]`);
                  if (affectedSales) {
                    let totalQty = 0;
                    for (const s of affectedSales) {
                      if (Array.isArray(s.items)) {
                        for (const item of s.items) {
                          if ((item as any).productId === tempId) {
                            totalQty += Number((item as any).quantity || 0);
                          }
                        }
                      }
                    }
                    if (totalQty > 0) {
                      await supabase.from('products').update({
                        // Fail closed: only an explicit `false` lets stock go below zero.
                        stock: preventNegativeStock === false
                          ? Number(op.payload.stock || 0) - totalQty
                          : Math.max(0, Number(op.payload.stock || 0) - totalQty),
                      }).eq('id', newProductId);
                    }
                  }
                } catch {
                  // stock fixup best-effort
                }
              }

              processed.push(op.id);
              break;
            }

            case 'product_update': {
              const imageUrl = await resolvePendingImageUrl(op.payload.image_url, businessId);
              const { error: updateErr } = await supabase.from('products').update({
                name: op.payload.name,
                price: op.payload.price,
                cost_price: op.payload.cost_price ?? op.payload.costPrice,
                stock: op.payload.stock,
                minimum_stock: op.payload.minimum_stock ?? op.payload.minimumStock,
                category: op.payload.category,
                tax_category: op.payload.tax_category ?? op.payload.taxCategory,
                barcode: op.payload.barcode || null,
                item_type: op.payload.item_type ?? op.payload.itemType,
                image_url: imageUrl,
                track_expiry: op.payload.track_expiry ?? op.payload.trackExpiry ?? false,
                track_stock: op.payload.track_stock ?? op.payload.trackStock ?? true,
                expiry_date: op.payload.expiry_date ?? op.payload.expiryDate ?? null,
              }).eq('id', op.payload.productId);
              if (updateErr) throw updateErr;
              await clearResolvedPendingImage(op.payload.image_url);
              processed.push(op.id);
              break;
            }

            case 'product_deactivate': {
              const { error: deactivateErr } = await supabase.from('products').update({ is_active: false }).eq('id', op.payload.productId);
              if (deactivateErr) throw deactivateErr;
              processed.push(op.id);
              break;
            }

            case 'expense_create': {
              const payload: Record<string, unknown> = {
                business_id: businessId,
                name: op.payload.name,
                amount: op.payload.amount,
                expense_date: op.payload.expense_date ?? op.payload.expenseDate,
                notes: op.payload.notes || null,
                category: op.payload.category || 'business',
              };
              // Client-generated id on offline creates keeps the row id stable so
              // an offline delete targets the same row after this op replays.
              if (op.payload.id) payload.id = op.payload.id;
              const { error: expInsErr } = await supabase.from('expenses').insert(payload as any);
              // Replaying an already-inserted expense is not a failure.
              if (expInsErr && !/duplicate key/i.test(expInsErr.message)) throw expInsErr;
              processed.push(op.id);
              break;
            }

            case 'expense_delete': {
              const { error: expDelErr } = await supabase.from('expenses').delete().eq('id', op.payload.id);
              if (expDelErr) throw expDelErr;
              processed.push(op.id);
              break;
            }

            case 'category_create': {
              const { data: existingCat } = await supabase
                .from('product_categories')
                .select('id')
                .eq('business_id', businessId)
                .ilike('name', op.payload.name)
                .maybeSingle();
              if (!existingCat) {
                const { error: catErr } = await supabase.from('product_categories').insert({
                  business_id: businessId,
                  name: op.payload.name,
                });
                if (catErr) throw catErr;
              }
              processed.push(op.id);
              break;
            }

            case 'category_delete': {
              const { error: catDelErr } = await supabase.from('product_categories').delete().eq('id', op.payload.id);
              if (catDelErr) throw catDelErr;
              processed.push(op.id);
              break;
            }

            case 'settings_update': {
              const { error: setErr } = await supabase.from('businesses').update(op.payload.updates).eq('id', businessId);
              if (setErr) throw setErr;
              processed.push(op.id);
              break;
            }

            case 'sale_delete': {
              // Restore stock, aggregated per product so two lines of the same
              // product aren't both applied from one stale read.
              const items: Array<{ productId: string; quantity: number }> = op.payload.items || [];
              const restoreByProduct = new Map<string, number>();
              for (const item of items) {
                if (!item?.productId) continue;
                const qty = Number(item.quantity || 0);
                if (qty === 0) continue;
                restoreByProduct.set(item.productId, (restoreByProduct.get(item.productId) ?? 0) + qty);
              }
              const productIds = [...restoreByProduct.keys()];
              if (productIds.length > 0) {
                const { data: products } = await supabase.from('products').select('id, stock').in('id', productIds);
                if (products) {
                  const stockMap = new Map(products.map((p: any) => [p.id, Number(p.stock ?? 0)]));
                  const updates = productIds
                    .filter((id) => stockMap.has(id))
                    .map((id) => supabase.from('products').update({ stock: (stockMap.get(id) ?? 0) + (restoreByProduct.get(id) ?? 0) }).eq('id', id));
                  await Promise.all(updates);
                }
              }
              const { error: saleDelErr } = await supabase.from('sales').delete().eq('id', op.payload.saleId);
              if (saleDelErr) throw saleDelErr;
              processed.push(op.id);
              break;
            }

            case 'debtor_delete': {
              // Restore stock from linked sale, delete sale, delete debtor payments, delete debtor
              const { data: debtorData } = await supabase.from('debtors').select('sale_id').eq('id', op.payload.id).maybeSingle();
              if (debtorData?.sale_id) {
                const { data: saleData } = await supabase.from('sales').select('items').eq('id', debtorData.sale_id).maybeSingle();
                if (saleData?.items && Array.isArray(saleData.items)) {
                  const saleItems: Array<{ productId: string; quantity: number }> = saleData.items;
                  const restoreByProduct = new Map<string, number>();
                  for (const item of saleItems) {
                    if (!item?.productId) continue;
                    const qty = Number(item.quantity || 0);
                    if (qty === 0) continue;
                    restoreByProduct.set(item.productId, (restoreByProduct.get(item.productId) ?? 0) + qty);
                  }
                  const pIds = [...restoreByProduct.keys()];
                  if (pIds.length > 0) {
                    const { data: prods } = await supabase.from('products').select('id, stock').in('id', pIds);
                    if (prods) {
                      const stockMap = new Map(prods.map((p: any) => [p.id, Number(p.stock ?? 0)]));
                      const updates = pIds
                        .filter((id) => stockMap.has(id))
                        .map((id) => supabase.from('products').update({ stock: (stockMap.get(id) ?? 0) + (restoreByProduct.get(id) ?? 0) }).eq('id', id));
                      await Promise.all(updates);
                    }
                  }
                }
                await supabase.from('sales').delete().eq('id', debtorData.sale_id);
              }
              await supabase.from('debtor_payments').delete().eq('debtor_id', op.payload.id);
              const { error: debtDelErr } = await supabase.from('debtors').delete().eq('id', op.payload.id);
              if (debtDelErr) throw debtDelErr;
              processed.push(op.id);
              break;
            }

            case 'quotation_create': {
              const { data: newId, error: qErr } = await (supabase.rpc as any)('create_quotation_with_items', {
                p_business_id: businessId,
                p_header: op.payload.header,
                p_items: op.payload.items,
              });
              if (qErr) throw qErr;
              processed.push(op.id);
              break;
            }

            case 'quotation_update': {
              const { error: qUpdErr } = await supabase.from('quotations').update(op.payload.header).eq('id', op.payload.id);
              if (qUpdErr) throw qUpdErr;
              await supabase.from('quotation_items').delete().eq('quotation_id', op.payload.id);
              if (op.payload.items?.length) {
                const { error: qItemsErr } = await supabase.from('quotation_items').insert(
                  op.payload.items.map((i: any) => ({ ...i, quotation_id: op.payload.id }))
                );
                if (qItemsErr) throw qItemsErr;
              }
              processed.push(op.id);
              break;
            }

            case 'quotation_delete': {
              const { error: qDelErr } = await supabase.from('quotations').update({ deleted_at: new Date().toISOString() }).eq('id', op.payload.id);
              if (qDelErr) throw qDelErr;
              processed.push(op.id);
              break;
            }

            case 'delivery_note_create': {
              const { data: dnId, error: dnErr } = await (supabase.rpc as any)('create_delivery_note_with_items', {
                p_business_id: businessId,
                p_header: op.payload.header,
                p_items: op.payload.items,
              });
              if (dnErr) throw dnErr;
              processed.push(op.id);
              break;
            }

            case 'delivery_note_status': {
              const { error: dnStErr } = await supabase.rpc('update_delivery_note_status' as any, {
                p_delivery_note_id: op.payload.id,
                p_status: op.payload.status,
              });
              if (dnStErr) throw dnStErr;
              processed.push(op.id);
              break;
            }

            case 'delivery_note_delete': {
              const { error: dnDelErr } = await supabase.from('delivery_notes').update({ deleted_at: new Date().toISOString() }).eq('id', op.payload.id);
              if (dnDelErr) throw dnDelErr;
              processed.push(op.id);
              break;
            }

            case 'invoice_create': {
              const { error: invErr } = await (supabase.rpc as any)('create_invoice_with_items', {
                p_business_id: businessId,
                p_header: op.payload.header,
                p_items: op.payload.items,
                p_offline_id: op.payload.offlineId || null,
              });
              if (invErr) throw invErr;
              processed.push(op.id);
              break;
            }

            case 'invoice_update': {
              const realId = await resolveInvoiceId(op.payload.id);
              if (!realId) throw new Error('Invoice not found');
              const { error: invUpdErr } = await supabase.from('invoices').update(op.payload.header).eq('id', realId);
              if (invUpdErr) throw invUpdErr;
              await supabase.from('invoice_items').delete().eq('invoice_id', realId);
              if (op.payload.items?.length) {
                const { error: invItemsErr } = await supabase.from('invoice_items').insert(
                  op.payload.items.map((i: any) => ({ ...i, invoice_id: realId }))
                );
                if (invItemsErr) throw invItemsErr;
              }
              processed.push(op.id);
              break;
            }

            case 'invoice_status': {
              const { error: invStErr } = await (supabase.rpc as any)('update_invoice_status', {
                p_invoice_id: op.payload.id,
                p_status: op.payload.status,
              });
              if (invStErr) throw invStErr;
              processed.push(op.id);
              break;
            }

            case 'invoice_pay': {
              const { error: invPayErr } = await (supabase.rpc as any)('pay_invoice', {
                p_invoice_id: op.payload.id,
                p_payment_method: op.payload.paymentMethod || 'cash',
              });
              if (invPayErr) throw invPayErr;
              processed.push(op.id);
              break;
            }

            case 'invoice_delete': {
              const realId = await resolveInvoiceId(op.payload.id);
              if (!realId) throw new Error('Invoice not found');
              const { error: invDelErr } = await supabase.from('invoices').update({ deleted_at: new Date().toISOString() }).eq('id', realId);
              if (invDelErr) throw invDelErr;
              processed.push(op.id);
              break;
            }
          }

          // Success: remove the op immediately so a later failure, crash or
          // tab close can never replay an operation that already applied.
          // A failed removal must not be mistaken for a failed op (that would
          // bump the retry count and could replay it later).
          try {
            await removePendingOp(op.id);
          } catch (removeErr) {
            console.error(`Could not remove synced op ${op.id}:`, removeErr);
          }
          processed.push(op.id);
        } catch (e) {
          const errorMsg = e instanceof Error ? e.message : String(e);
          const currentRetryCount = (op.retryCount || 0) + 1;
          
          if (currentRetryCount >= MAX_RETRIES) {
            console.error(`Pending op ${op.id} (${op.type}) permanently failed after ${MAX_RETRIES} retries:`, e);
          } else {
            console.error(`Failed to process pending op ${op.id} (${op.type}), retry ${currentRetryCount}/${MAX_RETRIES}:`, e);
          }
          
          // Update retry count in IndexedDB. Never let this throw out of the
          // catch — otherwise the drain aborts and already-applied ops replay.
          try {
            await updatePendingOpRetry(op.id, currentRetryCount, errorMsg);
          } catch (retryErr) {
            console.error(`Could not record retry for ${op.id}:`, retryErr);
          }
        }
      }

      if (processed.length > 0) {
        // Refresh cached products & debtors after sync
        try {
          const { data: prodData } = await supabase
            .from('products')
            .select('id, business_id, name, price, cost_price, stock, minimum_stock, category, barcode, is_active, tax_category, image_url, parent_id, variant_label, item_type, track_expiry, expiry_date')
            .eq('business_id', businessId)
            .limit(25000);
          if (prodData) {
            await mergeServerProducts(businessId, prodData.map((p: any) => ({
              id: p.id,
              businessId: p.business_id,
              name: p.name,
              price: Number(p.price),
              costPrice: p.cost_price ? Number(p.cost_price) : null,
              stock: Number(p.stock),
              minimumStock: Number(p.minimum_stock ?? 5),
              category: p.category,
              barcode: p.barcode ?? null,
              isActive: p.is_active,
              taxCategory: p.tax_category || 'taxable',
              imageUrl: p.image_url,
              imagePath: p.image_url,
              parentId: p.parent_id,
              variantLabel: p.variant_label,
              trackExpiry: p.track_expiry ?? false,
              expiryDate: p.expiry_date ?? null,
            })));
          }

          const { data: debtData } = await supabase
            .from('debtors')
            .select('id, business_id, customer_name, customer_phone, amount_owed, amount_paid, status, notes, created_at, due_date')
            .eq('business_id', businessId)
            .limit(1000);
          if (debtData) {
            await mergeServerDebtors(businessId, debtData.map((d: any) => ({
              id: d.id,
              businessId: d.business_id,
              customerName: d.customer_name,
              customerPhone: d.customer_phone,
              amountOwed: Number(d.amount_owed),
              amountPaid: Number(d.amount_paid),
              status: d.status,
              notes: d.notes,
              createdAt: d.created_at,
              dueDate: d.due_date,
            })));
          }

          const { data: invData } = await supabase
            .from('invoices')
            .select('id, business_id, invoice_number, offline_id, customer_name, customer_phone, customer_email, customer_tpin, subtotal, discount_type, discount_value, discount_amount, tax_amount, total, status, issued_date, due_date, payment_method, quotation_id, delivery_note_id, converted_sale_id, notes, created_at, updated_at, deleted_at')
            .eq('business_id', businessId)
            .limit(1000);
          if (invData) {
            await mergeServerInvoices(businessId, invData.map((i: any) => ({
              id: i.id,
              businessId: i.business_id,
              invoiceNumber: i.invoice_number,
              offlineId: i.offline_id,
              customerName: i.customer_name,
              customerPhone: i.customer_phone,
              customerEmail: i.customer_email,
              customerTpin: i.customer_tpin,
              subtotal: Number(i.subtotal),
              discountType: i.discount_type,
              discountValue: Number(i.discount_value),
              discountAmount: Number(i.discount_amount),
              taxAmount: Number(i.tax_amount ?? 0),
              total: Number(i.total),
              status: i.status,
              issuedDate: i.issued_date,
              dueDate: i.due_date,
              paymentMethod: i.payment_method,
              quotationId: i.quotation_id,
              deliveryNoteId: i.delivery_note_id,
              convertedSaleId: i.converted_sale_id,
              notes: i.notes,
              createdAt: i.created_at,
              updatedAt: i.updated_at,
              deletedAt: i.deleted_at,
            })));
          }
        } catch {
          // cache refresh failed silently
        }

        window.dispatchEvent(new CustomEvent("zampos:sync-complete"));
        supabase.from('businesses').update({ last_sync_at: new Date().toISOString() }).eq('id', businessId).then(() => {}).catch(() => {});
        setLastSyncAt(new Date().toISOString());
      }
    } catch (e) {
      console.error("Error in pending ops sync:", e);
    } finally {
      globalOpsSyncInFlight = false;
      void refreshFailedOps();
    }
  }, [businessId, isOnline, refreshFailedOps, preventNegativeStock]);

  // Cross-tab serialization: two windows on the same till must not drain the
  // shared queue at the same time (that duplicates non-idempotent ops). Use
  // the Web Locks API when available, falling back to the in-tab guard.
  const sync = useCallback(async () => {
    if (!businessId || !isOnline || globalOpsSyncInFlight) return;
    const locks = typeof navigator !== 'undefined' ? (navigator as any).locks : undefined;
    if (locks?.request) {
      try {
        await locks.request(
          `zampos-op-sync:${businessId}`,
          { ifAvailable: true },
          async (lock: any) => {
            if (lock) await runSync();
          }
        );
        return;
      } catch {
        // Web Locks unavailable/failed — fall back to the in-tab guard.
      }
    }
    await runSync();
  }, [businessId, isOnline, runSync]);

  const retryFailedOps = useCallback(async (opIds: string[]) => {
    if (!businessId || opIds.length === 0) return;
    try {
      await resetFailedOps(opIds);
      await refreshFailedOps();
      // Kick a sync pass right away so the ops are attempted immediately.
      setTimeout(() => {
        sync();
      }, 500);
    } catch {
      // ignore
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [businessId, refreshFailedOps]);

  const clearFailedOps = useCallback(async (opIds: string[]) => {
    if (opIds.length === 0) return;
    try {
      const ops = businessId ? await getPendingOps(businessId) : [];
      const toRemove = ops.filter((op) => opIds.includes(op.id));
      for (const op of toRemove) {
        await removePendingOp(op.id);
      }
      await refreshFailedOps();
    } catch {
      // ignore
    }
  }, [businessId, refreshFailedOps]);

  const refreshPending = useCallback(async () => {
    await refreshFailedOps();
  }, [refreshFailedOps]);

  useEffect(() => {
    if (!businessId || !isOnline) return;

    // Initial sync after a short delay to let other syncs settle
    const initialTimer = setTimeout(() => sync(), 5000);

    const interval = setInterval(() => {
      sync();
    }, 60000);

    return () => {
      clearTimeout(initialTimer);
      clearInterval(interval);
    };
  }, [businessId, isOnline, sync]);

  return { syncNow: sync, failedOps, retryFailedOps, clearFailedOps, refreshFailedOps, lastSyncAt };
}
