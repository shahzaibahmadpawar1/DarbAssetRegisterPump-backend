// server/routes.ts
import type { Express, Request, Response } from "express";
import bcrypt from "bcryptjs";
import { supabase } from "./supabaseClient";
import jwt from "jsonwebtoken";

export function registerRoutes(app: Express) {
  const JWT_SECRET = process.env.JWT_SECRET || "replace-with-secure-secret";
  const TOKEN_COOKIE_NAME = "token";
  const TOKEN_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days

  // Each item represents one individual asset with its serial number and barcode
  type AssignmentItem = { batch_id: number; serial_number?: string; barcode?: string };
  type AssignmentInput = { pump_id: number; items: AssignmentItem[] };
  type GroupedAssignment = {
    pump_id: number;
    totalQuantity: number;
    manualByBatch: Map<number, number>;
    autoQuantity: number;
  };

  const sanitizeAssignments = (input: any): AssignmentInput[] => {
    if (!Array.isArray(input)) return [];
    // Each assignment should have pump_id and items array
    // Each item has batch_id, serial_number (optional), barcode (optional)
    const result: AssignmentInput[] = [];
    input.forEach((assignment) => {
      const pumpId = Number(assignment?.pump_id);
      if (!Number.isFinite(pumpId) || pumpId <= 0) return;
      
      const items: AssignmentItem[] = [];
      if (Array.isArray(assignment.items)) {
        assignment.items.forEach((item: any) => {
          const batchId = Number(item?.batch_id);
          if (!Number.isFinite(batchId) || batchId <= 0) return;
          items.push({
            batch_id: batchId,
            serial_number: item?.serial_number?.trim() || undefined,
            barcode: item?.barcode?.trim() || undefined,
          });
        });
      }
      
      if (items.length > 0) {
        result.push({ pump_id: pumpId, items });
      }
    });
    return result;
  };

  const sumAssignmentQuantity = (assignments: AssignmentInput[]) =>
    assignments.reduce((total, assignment) => total + assignment.items.length, 0);

  const hydrateAssets = async (assets: any[]) => {
    if (!assets || assets.length === 0) return { data: [], error: null as any };

    const assetIds = assets.map((a: any) => a.id);
    const [
      { data: cats, error: catError },
      { data: pumps, error: pumpError },
      { data: assignmentRows, error: assignmentError },
      { data: batchRows, error: batchError },
    ] = await Promise.all([
      supabase.from("categories").select("id, name"),
      supabase.from("pumps").select("id, name"),
      supabase
        .from("asset_assignments")
        .select("id, asset_id, pump_id, quantity, pumps(name)")
        .in("asset_id", assetIds),
      supabase
        .from("asset_purchase_batches")
        .select("*")
        .in("asset_id", assetIds),
    ]);

    // Fetch batch allocations separately after we have assignment IDs
    // Each allocation is now one item (no quantity field)
    const assignmentIds = (assignmentRows || []).map((r: any) => r.id);
    const { data: allocationRows, error: allocationError } =
      assignmentIds.length > 0
        ? await supabase
            .from("assignment_batch_allocations")
            .select("assignment_id, batch_id, serial_number, barcode, asset_purchase_batches(purchase_price)")
            .in("assignment_id", assignmentIds)
        : { data: [], error: null };

    if (catError || pumpError || assignmentError || batchError || allocationError) {
      return {
        data: null,
        error: catError || pumpError || assignmentError || batchError || allocationError,
      };
    }

    const catMap = new Map((cats || []).map((c: any) => [c.id, c.name]));
    const pumpMap = new Map((pumps || []).map((p: any) => [p.id, p.name]));
    const batchesByAsset = new Map<number, any[]>();
    const allocationsByAssignment = new Map<number, any[]>();

    (batchRows || []).forEach((batch: any) => {
      const collection = batchesByAsset.get(batch.asset_id) || [];
      collection.push(batch);
      batchesByAsset.set(batch.asset_id, collection);
    });

    // Group allocations by assignment_id and batch_id, counting items
    // Each allocation row is now one item (no quantity field)
    (allocationRows || []).forEach((alloc: any) => {
      const collection = allocationsByAssignment.get(alloc.assignment_id) || [];
      // Check if we already have an entry for this batch_id
      const existing = collection.find((item: any) => item.batch_id === alloc.batch_id);
      if (existing) {
        existing.quantity = (existing.quantity || 0) + 1;
      } else {
        collection.push({
          batch_id: alloc.batch_id,
          quantity: 1, // Each allocation = 1 item
          unit_price: Number(alloc.asset_purchase_batches?.purchase_price || 0),
          serial_number: alloc.serial_number,
          barcode: alloc.barcode,
        });
      }
      allocationsByAssignment.set(alloc.assignment_id, collection);
    });

    const assignmentsByAsset = new Map<number, any[]>();

    (assignmentRows || []).forEach((row: any) => {
      const collection = assignmentsByAsset.get(row.asset_id) || [];
      const batchAllocations = allocationsByAssignment.get(row.id) || [];
      
      // Calculate quantity from batch allocations (count of items)
      const calculatedQuantity = batchAllocations.reduce((sum: number, alloc: any) => sum + (alloc.quantity || 0), 0);
      const assignmentQuantity = calculatedQuantity > 0 ? calculatedQuantity : (row.quantity || 0);
      
      // Calculate assignment value from batch allocations
      // Each allocation in batchAllocations has quantity (count of items) and unit_price
      const assignmentValue = batchAllocations.length > 0
        ? batchAllocations.reduce((sum: number, alloc: any) => sum + (alloc.quantity || 0) * (alloc.unit_price || 0), 0)
        : assignmentQuantity * (Number(assets.find((a: any) => a.id === row.asset_id)?.asset_value) || 0);

      collection.push({
        id: row.id,
        asset_id: row.asset_id,
        pump_id: row.pump_id,
        quantity: assignmentQuantity, // Use calculated quantity from allocations
        pump_name: row.pumps?.name ?? pumpMap.get(row.pump_id) ?? null,
        assignment_value: assignmentValue,
        batch_allocations: batchAllocations,
      });
      assignmentsByAsset.set(row.asset_id, collection);
    });

    const hydrated = assets.map((asset: any) => {
      const assignmentList = assignmentsByAsset.get(asset.id) || [];
      const batches = batchesByAsset.get(asset.id) || [];

      // Calculate total value from batches
      const totalBatchValue = batches.reduce(
        (sum: number, batch: any) =>
          sum + Number(batch.purchase_price) * Number(batch.quantity),
        0
      );
      const remainingBatchValue = batches.reduce(
        (sum: number, batch: any) =>
          sum + Number(batch.purchase_price) * Number(batch.remaining_quantity),
        0
      );

      // Calculate total assigned by counting items in batch_allocations
      const totalAssigned = assignmentList.reduce(
        (total: number, assignment: any) => {
          if (assignment.batch_allocations && assignment.batch_allocations.length > 0) {
            // Sum up quantities from batch allocations
            return total + assignment.batch_allocations.reduce((sum: number, alloc: any) => sum + (alloc.quantity || 0), 0);
          }
          return total + (assignment.quantity || 0);
        },
        0
      );
      const totalAssignedValue = assignmentList.reduce(
        (total: number, assignment: any) =>
          total + (assignment.assignment_value || 0),
        0
      );

      const totalQuantity = batches.reduce(
        (sum: number, batch: any) => sum + Number(batch.quantity),
        0
      );
      const remainingQuantity = batches.reduce(
        (sum: number, batch: any) => sum + Number(batch.remaining_quantity),
        0
      );

      // Calculate weighted average unit value from batches, or fallback to asset_value
      // This represents the average purchase price per unit across all batches
      // Formula: (Sum of all batch values) / (Sum of all batch quantities)
      let unitValue = Number(asset.asset_value) || 0;
      if (batches.length > 0 && totalQuantity > 0) {
        unitValue = totalBatchValue / totalQuantity;
      }

      return {
        ...asset,
        asset_value: unitValue,
        assignments: assignmentList,
        batches: batches.map((b: any) => ({
          id: b.id,
          purchase_date: b.purchase_date,
          purchase_price: Number(b.purchase_price),
          quantity: Number(b.quantity),
          remaining_quantity: Number(b.remaining_quantity),
        })),
        totalAssigned,
        totalAssignedValue,
        totalValue: totalBatchValue || (asset.quantity ? asset.quantity * unitValue : null),
        remainingQuantity: remainingQuantity || (asset.quantity ? Math.max((asset.quantity || 0) - totalAssigned, 0) : null),
        remainingValue: remainingBatchValue || (asset.quantity ? Math.max((asset.quantity || 0) - totalAssigned, 0) * unitValue : null),
        categoryName: asset.category_id
          ? catMap.get(asset.category_id) ?? null
          : null,
        pumpName: assignmentList[0]?.pump_name ?? null,
      };
    });

    return { data: hydrated, error: null };
  };

  const fetchAssetById = async (id: number) => {
    const { data, error } = await supabase
      .from("assets")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) return { data: null, error };
    if (!data) return { data: null, error: null };
    return hydrateAssets([data]).then((result) => ({
      data: result.data?.[0] ?? null,
      error: result.error,
    }));
  };

  const replaceAssetAssignments = async (
    assetId: number,
    assignments: AssignmentInput[]
  ) => {
    // Get existing assignments to delete their batch allocations
    const { data: existingAssignments } = await supabase
      .from("asset_assignments")
      .select("id")
      .eq("asset_id", assetId);

    if (existingAssignments && existingAssignments.length > 0) {
      const assignmentIds = existingAssignments.map((a: any) => a.id);
      await supabase
        .from("assignment_batch_allocations")
        .delete()
        .in("assignment_id", assignmentIds);
    }

    const { error: deleteError } = await supabase
      .from("asset_assignments")
      .delete()
      .eq("asset_id", assetId);
    if (deleteError) return { error: deleteError };
    if (assignments.length === 0) return { error: null };

    // Group assignments by pump_id and collect all items
    const groupedByPump = new Map<number, AssignmentItem[]>();
    for (const assignment of assignments) {
      const existing = groupedByPump.get(assignment.pump_id) || [];
      groupedByPump.set(assignment.pump_id, [...existing, ...assignment.items]);
    }

    // Verify batch availability for all items
    const allItems: AssignmentItem[] = [];
    for (const items of groupedByPump.values()) {
      allItems.push(...items);
    }

    // Check batch availability
    const batchCounts = new Map<number, number>();
    for (const item of allItems) {
      batchCounts.set(item.batch_id, (batchCounts.get(item.batch_id) || 0) + 1);
    }

    for (const [batchId, requestedCount] of batchCounts.entries()) {
      const { data: batch, error: batchError } = await supabase
        .from("asset_purchase_batches")
        .select("remaining_quantity")
        .eq("id", batchId)
        .eq("asset_id", assetId)
        .maybeSingle();

      if (batchError || !batch) {
        return {
          error: {
            message: `Batch ${batchId} not found or invalid.`,
          },
        };
      }

      if (batch.remaining_quantity < requestedCount) {
        return {
          error: {
            message: `Insufficient stock in batch ${batchId}. Only ${batch.remaining_quantity} items available, but ${requestedCount} requested.`,
          },
        };
      }
    }

    // Create assignment records (one per pump)
    const assignmentRows = Array.from(groupedByPump.entries()).map(([pump_id, items]) => ({
      asset_id: assetId,
      pump_id,
      quantity: items.length, // Store total count for compatibility
    }));

    const { data: insertedAssignments, error: insertError } = await supabase
      .from("asset_assignments")
      .insert(assignmentRows)
      .select("id, pump_id");
    if (insertError) return { error: insertError };

    const deleteInsertedAssignments = async () => {
      if (insertedAssignments && insertedAssignments.length > 0) {
        await supabase
          .from("asset_assignments")
          .delete()
          .in("id", insertedAssignments.map((a: any) => a.id));
      }
    };

    // Create allocation records (one per item)
    for (const assignment of assignments) {
      const assignmentRow = insertedAssignments?.find((a: any) => a.pump_id === assignment.pump_id);
      if (!assignmentRow) {
        await deleteInsertedAssignments();
        return {
          error: {
            message: `Failed to find assignment for pump ${assignment.pump_id}`,
          },
        };
      }

      const result = await createBatchAllocations(assignmentRow.id, assignment.items);
      if (result.error) {
        await deleteInsertedAssignments();
        return {
          error: {
            message: result.error.message || "Failed to create batch allocations",
            details: result.error.details || null
          }
        };
      }
    }

    return { error: null };
  };

  const fetchAssignmentsTotal = async (assetId: number) => {
    const { data, error } = await supabase
      .from("asset_assignments")
      .select("quantity")
      .eq("asset_id", assetId);
    if (error) return { total: 0, error };
    const total =
      data?.reduce((sum: number, row: any) => sum + (row.quantity || 0), 0) ?? 0;
    return { total, error: null };
  };

  const ensureCapacity = async (
    assetId: number,
    targetQuantity: number | null | undefined,
    assignments: AssignmentInput[]
  ) => {
    const totalAssigned = sumAssignmentQuantity(assignments);
    let capacity = targetQuantity;

    if (capacity == null) {
      const { data, error } = await supabase
        .from("assets")
        .select("quantity")
        .eq("id", assetId)
        .maybeSingle();
      if (error) return { ok: false, error };
      capacity = data?.quantity ?? 0;
    }

    if (capacity != null && capacity >= 0 && totalAssigned > capacity) {
      return {
        ok: false,
        error: {
          message: `Assigned quantity ${totalAssigned} exceeds available quantity ${capacity}.`,
        },
      };
    }

    return { ok: true, error: null as any };
  };

  // ========== BATCH FUNCTIONS ==========
  const createPurchaseBatch = async (
    assetId: number,
    purchasePrice: number,
    quantity: number,
    purchaseDate?: Date,
    remarks?: string | null,
    batchName?: string | null
  ) => {
    const { data, error } = await supabase
      .from("asset_purchase_batches")
      .insert([
        {
          asset_id: assetId,
          purchase_price: purchasePrice,
          quantity: quantity,
          remaining_quantity: quantity,
          purchase_date: purchaseDate || new Date().toISOString(),
          remarks: remarks || null,
          batch_name: batchName || null,
        },
      ])
      .select("*")
      .maybeSingle();
    return { data, error };
  };

  const allocateFromBatches = async (
    assetId: number,
    requiredQuantity: number
  ): Promise<
    { batch_id: number; quantity: number; unit_price: number }[] | null
  > => {
    const { data: batches, error } = await supabase
      .from("asset_purchase_batches")
      .select("*")
      .eq("asset_id", assetId)
      .gt("remaining_quantity", 0)
      .order("purchase_date", { ascending: true });

    if (error || !batches || batches.length === 0) return null;

    const allocations: { batch_id: number; quantity: number; unit_price: number }[] = [];
    let remaining = requiredQuantity;

    for (const batch of batches) {
      if (remaining <= 0) break;

      const available = batch.remaining_quantity;
      const toAllocate = Math.min(remaining, available);

      allocations.push({
        batch_id: batch.id,
        quantity: toAllocate,
        unit_price: Number(batch.purchase_price),
      });

      remaining -= toAllocate;
    }

    if (remaining > 0) {
      return null; // Insufficient stock
    }

    return allocations;
  };

  const createBatchAllocations = async (
    assignmentId: number,
    items: AssignmentItem[]
  ) => {
    if (items.length === 0) return { error: null };

    // Create one allocation record per item
    const rows = items.map((item) => ({
      assignment_id: assignmentId,
      batch_id: item.batch_id,
      serial_number: item.serial_number?.trim() || null,
      barcode: item.barcode?.trim() || null,
    }));

    const { error } = await supabase
      .from("assignment_batch_allocations")
      .insert(rows);
    
    if (error) {
      // Provide more detailed error message
      let errorMessage = error.message || "Failed to create batch allocations";
      if (error.code === '23505') { // Unique constraint violation
        if (error.message.includes('serial_number')) {
          errorMessage = "A serial number you entered already exists. Please use a unique serial number.";
        } else if (error.message.includes('barcode')) {
          errorMessage = "A barcode you entered already exists. Please use a unique barcode.";
        }
      }
      return { 
        error: {
          message: errorMessage,
          details: error.details || null,
          code: error.code
        }
      };
    }
    return { error: null };
  };

  const calculateAssignmentValue = async (
    assignmentId: number
  ): Promise<number> => {
    // Get all allocations for this assignment and calculate total value
    const { data: allocations, error } = await supabase
      .from("assignment_batch_allocations")
      .select("batch_id")
      .eq("assignment_id", assignmentId);
    
    if (error || !allocations) return 0;
    
    // Get batch prices
    const batchIds = allocations.map((a: any) => a.batch_id);
    const { data: batches } = await supabase
      .from("asset_purchase_batches")
      .select("purchase_price")
      .in("id", batchIds);
    
    if (!batches) return 0;
    
    // Each allocation is one item, so sum up the prices
    return batches.reduce((sum, batch) => sum + Number(batch.purchase_price), 0);
  };
  // ---------------- AUTH ----------------
  app.post("/api/login", async (req: Request, res: Response) => {
    const { username, password } = req.body;
    if (!username || !password)
      return res.status(400).json({ message: "Missing credentials" });

    const { data: user, error } = await supabase
      .from("users")
      .select("id, password_hash")
      .eq("username", username)
      .maybeSingle();

    if (error || !user)
      return res.status(401).json({ message: "Invalid credentials" });

    const passwordOk = password === user.password_hash;
    if (!passwordOk)
      return res.status(401).json({ message: "Invalid credentials" });

    const token = jwt.sign({ userId: user.id }, JWT_SECRET, {
      expiresIn: "7d",
    });

    // Set cookie with proper settings
    const cookieOptions: any = {
      httpOnly: true,
      maxAge: TOKEN_MAX_AGE,
      path: "/",
    };

    // Determine if we're in production based on origin
    const origin = req.headers.origin || "";
    const isProduction = origin.includes("azharalibuttar.com") || process.env.NODE_ENV === "production";
    
    if (isProduction) {
      cookieOptions.secure = true;
      cookieOptions.sameSite = "none";
      // Set domain for production
      if (origin.includes("azharalibuttar.com")) {
        cookieOptions.domain = ".azharalibuttar.com";
      }
    } else {
      cookieOptions.secure = false;
      cookieOptions.sameSite = "lax";
      // Don't set domain in development - let browser handle it
    }

    res.cookie(TOKEN_COOKIE_NAME, token, cookieOptions);

    // Also return token in response body for localStorage fallback
    return res.json({ ok: true, token });
  });

  app.post("/api/logout", (_req, res) => {
    res.clearCookie(TOKEN_COOKIE_NAME, { 
      path: "/",
      domain: process.env.NODE_ENV === "production" ? ".azharalibuttar.com" : undefined,
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    });
    res.json({ ok: true });
  });

  app.get("/api/me", async (req: Request, res: Response) => {
    // Try to get token from cookie first
    let token = (req as any).cookies?.[TOKEN_COOKIE_NAME];
    
    // If no cookie token, try Authorization header (for localStorage fallback)
    if (!token) {
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith("Bearer ")) {
        token = authHeader.substring(7);
      }
    }

    if (!token) {
      return res.status(200).json({ authenticated: false });
    }

    try {
      const decoded = jwt.verify(token, JWT_SECRET) as any;
      const { data, error } = await supabase
        .from("users")
        .select("id, username")
        .eq("id", decoded.userId)
        .maybeSingle();

      if (error || !data) {
        return res.status(200).json({ authenticated: false });
      }
      return res.json({ authenticated: true, user: data });
    } catch (err) {
      // Token expired or invalid - return unauthenticated but with 200 status
      // This prevents the frontend from treating it as an error
      return res.status(200).json({ authenticated: false });
    }
  });

  // ---------------- PUMPS ----------------
  app.get("/api/pumps", async (_req, res) => {
    try {
      const { data: pumps, error } = await supabase
        .from("pumps")
        .select("*")
        .order("id", { ascending: false });
      if (error) return res.status(500).json({ message: error.message });

      const { data: assignmentRows, error: assignmentErr } = await supabase
        .from("asset_assignments")
        .select("id, asset_id, pump_id");
      if (assignmentErr)
        return res.status(500).json({ message: assignmentErr.message });

      // Get all batch allocations for these assignments
      const assignmentIds = (assignmentRows || []).map((a: any) => a.id);
      let allocationRows: any[] = [];
      if (assignmentIds.length > 0) {
        const { data: allocations, error: allocationErr } = await supabase
          .from("assignment_batch_allocations")
          .select("assignment_id, batch_id")
          .in("assignment_id", assignmentIds);
        
        if (allocationErr)
          return res.status(500).json({ message: allocationErr.message });
        
        allocationRows = allocations || [];
        
        // Get batch prices
        const batchIds = Array.from(new Set(allocationRows.map((a: any) => a.batch_id)));
        if (batchIds.length > 0) {
          const { data: batches, error: batchErr } = await supabase
            .from("asset_purchase_batches")
            .select("id, purchase_price")
            .in("id", batchIds);
          
          if (batchErr)
            return res.status(500).json({ message: batchErr.message });
          
          // Create a map of batch_id to purchase_price
          const batchPriceMap = new Map<number, number>();
          (batches || []).forEach((b: any) => {
            batchPriceMap.set(b.id, Number(b.purchase_price || 0));
          });
          
          // Add purchase_price to each allocation
          allocationRows = allocationRows.map((alloc: any) => ({
            ...alloc,
            purchase_price: batchPriceMap.get(alloc.batch_id) || 0,
          }));
        }
      }

      const seen = new Set<string>();
      const assetCountMap = new Map<number, number>();
      const assetValueMap = new Map<number, number>();
      
      // Create a map of assignment_id to pump_id
      const assignmentToPump = new Map<number, number>();
      (assignmentRows || []).forEach((row: any) => {
        if (!row.pump_id) return;
        assignmentToPump.set(row.id, row.pump_id);
        const key = `${row.pump_id}-${row.asset_id}`;
        if (seen.has(key)) return;
        seen.add(key);
        assetCountMap.set(row.pump_id, (assetCountMap.get(row.pump_id) || 0) + 1);
      });

      // Calculate total asset value per pump
      (allocationRows || []).forEach((alloc: any) => {
        const pumpId = assignmentToPump.get(alloc.assignment_id);
        if (!pumpId) return;
        const price = alloc.purchase_price || 0;
        assetValueMap.set(pumpId, (assetValueMap.get(pumpId) || 0) + price);
      });

      const result = pumps.map((p: any) => ({
        ...p,
        assetCount: assetCountMap.get(p.id) || 0,
        totalAssetValue: assetValueMap.get(p.id) || 0,
      }));

      return res.json(result);
    } catch (e: any) {
      console.error("Error fetching pumps:", e);
      res.status(500).json({ message: e?.message || "Internal error" });
    }
  });

  app.post("/api/pumps", async (req, res) => {
    const name = req.body?.name;
    const location = req.body?.location;
    const manager = req.body?.manager;
    const contact_number =
      req.body?.contact_number ?? req.body?.contactNumber ?? null;
    const remarks = req.body?.remarks ?? req.body?.details ?? null;

    if (!name || !location || !manager)
      return res.status(400).json({ message: "Missing fields" });

    const { data, error } = await supabase
      .from("pumps")
      .insert([{ name, location, manager, contact_number, remarks }])
      .select("*")
      .maybeSingle();
    if (error) return res.status(500).json({ message: error.message });
    return res.status(201).json(data);
  });

  app.put("/api/pumps/:id", async (req, res) => {
    const id = Number(req.params.id);
    const body = req.body || {};
    const payload: Record<string, any> = {};

    if ("name" in body) payload.name = body.name;
    if ("location" in body) payload.location = body.location;
    if ("manager" in body) payload.manager = body.manager;
    if ("contact_number" in body || "contactNumber" in body)
      payload.contact_number = body.contact_number ?? body.contactNumber ?? null;
    if ("remarks" in body || "details" in body)
      payload.remarks = body.remarks ?? body.details ?? null;

    if (Object.keys(payload).length === 0)
      return res.status(400).json({ message: "No fields to update" });

    const { data, error } = await supabase
      .from("pumps")
      .update(payload)
      .eq("id", id)
      .select("*")
      .maybeSingle();

    if (error) return res.status(500).json({ message: error.message });
    if (!data) return res.status(404).json({ message: "Pump not found" });
    res.json(data);
  });

  // Prevent deletion if assets exist
  app.delete("/api/pumps/:id", async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (Number.isNaN(id))
        return res.status(400).json({ message: "Invalid pump ID" });

      const { data: assignments, error: assignmentError } = await supabase
        .from("asset_assignments")
        .select("id")
        .eq("pump_id", id);

      if (assignmentError)
        return res.status(500).json({ message: assignmentError.message });

      if (assignments && assignments.length > 0) {
        return res
          .status(400)
          .json({
            message:
              "Cannot delete this pump because assets are currently allocated to it.",
          });
      }

      const { error } = await supabase.from("pumps").delete().eq("id", id);
      if (error) return res.status(500).json({ message: error.message });

      res.status(204).send();
    } catch (e: any) {
      res
        .status(500)
        .json({ message: e?.message || "Internal server error" });
    }
  });

  // --------------- CATEGORIES ---------------
  app.get("/api/categories", async (_req, res) => {
    const { data, error } = await supabase
      .from("categories")
      .select("*")
      .order("name", { ascending: true });
    if (error) return res.status(500).json({ message: error.message });
    return res.json(data);
  });

  app.post("/api/categories", async (req, res) => {
    const { name } = req.body;
    if (!name)
      return res.status(400).json({ message: "Category name required" });

    const { data, error } = await supabase
      .from("categories")
      .insert([{ name }])
      .select("*")
      .maybeSingle();
    if (error) return res.status(500).json({ message: error.message });
    return res.status(201).json(data);
  });

  app.delete("/api/categories/:id", async (req, res) => {
    const { id } = req.params;
    const { error } = await supabase.from("categories").delete().eq("id", id);
    if (error) return res.status(500).json({ message: error.message });
    res.status(204).send();
  });

  // ---------------- EMPLOYEES ----------------
  app.get("/api/employees", async (_req, res) => {
    try {
      const { data, error } = await supabase
        .from("employees")
        .select(`
          *,
          department_assignments:employee_department_assignments(
            department:departments(id, name)
          ),
          asset_assignments:employee_asset_assignments(
            id,
            batch_id,
            serial_number,
            barcode,
            assignment_date,
            batch:asset_purchase_batches(
              id,
              batch_name,
              purchase_date,
              purchase_price,
              asset:assets(id, asset_name, asset_number)
            )
          )
        `)
        .order("name", { ascending: true });
      if (error) return res.status(500).json({ message: error.message });
      
      // Transform data to include department name and asset assignments
      const transformed = (data || []).map((emp: any) => {
        const departmentAssignment = emp.department_assignments?.[0];
        
        // Group asset assignments by asset and batch
        const assetAssignments = (emp.asset_assignments || []).map((assignment: any) => ({
          id: assignment.id,
          batch_id: assignment.batch_id,
          batch_name: assignment.batch?.batch_name || null,
          purchase_date: assignment.batch?.purchase_date || null,
          purchase_price: assignment.batch?.purchase_price || null,
          serial_number: assignment.serial_number,
          barcode: assignment.barcode,
          assignment_date: assignment.assignment_date,
          asset: assignment.batch?.asset ? {
            id: assignment.batch.asset.id,
            asset_name: assignment.batch.asset.asset_name,
            asset_number: assignment.batch.asset.asset_number,
          } : null,
        }));
        
        // Group by asset and batch to show quantities
        const assetSummary = new Map<string, {
          asset_id: number;
          asset_name: string;
          asset_number: string;
          batches: Map<number, {
            batch_id: number;
            batch_name: string | null;
            purchase_date: string | null;
            quantity: number;
            items: any[];
          }>;
        }>();
        
        assetAssignments.forEach((assignment: any) => {
          if (!assignment.asset) return;
          
          const assetKey = `${assignment.asset.id}`;
          if (!assetSummary.has(assetKey)) {
            assetSummary.set(assetKey, {
              asset_id: assignment.asset.id,
              asset_name: assignment.asset.asset_name,
              asset_number: assignment.asset.asset_number,
              batches: new Map(),
            });
          }
          
          const asset = assetSummary.get(assetKey)!;
          const batchKey = assignment.batch_id;
          if (!asset.batches.has(batchKey)) {
            asset.batches.set(batchKey, {
              batch_id: assignment.batch_id,
              batch_name: assignment.batch_name,
              purchase_date: assignment.purchase_date,
              quantity: 0,
              items: [],
            });
          }
          
          const batch = asset.batches.get(batchKey)!;
          batch.quantity += 1;
          batch.items.push(assignment);
        });
        
        // Convert to array format
        const assetAssignmentsSummary = Array.from(assetSummary.values()).map(asset => ({
          asset_id: asset.asset_id,
          asset_name: asset.asset_name,
          asset_number: asset.asset_number,
          batches: Array.from(asset.batches.values()),
        }));
        
        return {
          id: emp.id,
          name: emp.name,
          employee_id: emp.employee_id,
          department_name: departmentAssignment?.department?.name || null,
          asset_assignments: assetAssignmentsSummary,
        };
      });
      
      res.json(transformed);
    } catch (e: any) {
      res.status(500).json({ message: e?.message || "Internal error" });
    }
  });

  app.post("/api/employees", async (req, res) => {
    try {
      const { name, employee_id, department_id } = req.body;
      if (!name || typeof name !== "string" || !name.trim())
        return res.status(400).json({ message: "Employee name is required" });

      const { data: employee, error: empError } = await supabase
        .from("employees")
        .insert([{ name: name.trim(), employee_id: employee_id?.trim() || null }])
        .select("*")
        .maybeSingle();

      if (empError) return res.status(500).json({ message: empError.message });
      if (!employee) return res.status(500).json({ message: "Failed to create employee" });

      // If department_id is provided, assign employee to department
      if (department_id) {
        const { error: assignError } = await supabase
          .from("employee_department_assignments")
          .insert([{
            employee_id: employee.id,
            department_id: department_id,
            assigned_at: new Date().toISOString(),
          }]);

        if (assignError) {
          // If assignment fails, still return the employee but log the error
          console.error("Failed to assign employee to department:", assignError);
        }
      }

      res.json(employee);
    } catch (e: any) {
      res.status(500).json({ message: e?.message || "Internal error" });
    }
  });

  app.put("/api/employees/:id", async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (Number.isNaN(id))
        return res.status(400).json({ message: "Invalid employee ID" });

      const { name, employee_id } = req.body;
      const updateData: any = {};
      if (name !== undefined) updateData.name = name?.trim() || null;
      if (employee_id !== undefined) updateData.employee_id = employee_id?.trim() || null;

      const { data, error } = await supabase
        .from("employees")
        .update(updateData)
        .eq("id", id)
        .select("*")
        .maybeSingle();

      if (error) return res.status(500).json({ message: error.message });
      if (!data) return res.status(404).json({ message: "Employee not found" });
      res.json(data);
    } catch (e: any) {
      res.status(500).json({ message: e?.message || "Internal error" });
    }
  });

  app.delete("/api/employees/:id", async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (Number.isNaN(id))
        return res.status(400).json({ message: "Invalid employee ID" });

      const { error } = await supabase.from("employees").delete().eq("id", id);
      if (error) return res.status(500).json({ message: error.message });
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ message: e?.message || "Internal error" });
    }
  });

  // Employee Asset Assignments
  app.get("/api/employees/:id/assignments", async (req, res) => {
    try {
      const employeeId = Number(req.params.id);
      if (Number.isNaN(employeeId))
        return res.status(400).json({ message: "Invalid employee ID" });

      const { data, error } = await supabase
        .from("employee_asset_assignments")
        .select(`
          *,
          batch:asset_purchase_batches(
            id,
            purchase_date,
            purchase_price,
            asset:assets(id, asset_name, asset_number)
          )
        `)
        .eq("employee_id", employeeId)
        .order("assignment_date", { ascending: false });

      if (error) return res.status(500).json({ message: error.message });
      res.json(data || []);
    } catch (e: any) {
      res.status(500).json({ message: e?.message || "Internal error" });
    }
  });

  // Employee Asset Assignments - now requires serial_number and barcode per item
  app.post("/api/employees/:id/assignments", async (req, res) => {
    try {
      const employeeId = Number(req.params.id);
      if (Number.isNaN(employeeId))
        return res.status(400).json({ message: "Invalid employee ID" });

      const { items, assignment_date } = req.body;
      if (!Array.isArray(items) || items.length === 0)
        return res.status(400).json({ message: "items array with at least one item is required" });

      // Validate items and check employee-specific availability
      // Employee assignments are tracked separately from station assignments
      const batchCounts = new Map<number, number>();
      for (const item of items) {
        const batchId = Number(item?.batch_id);
        if (!Number.isFinite(batchId) || batchId <= 0)
          return res.status(400).json({ message: "Each item must have a valid batch_id" });
        batchCounts.set(batchId, (batchCounts.get(batchId) || 0) + 1);
      }

      // Check employee-specific availability for each batch
      for (const [batchId, requestedCount] of batchCounts.entries()) {
        // Get batch info
        const { data: batch, error: batchError } = await supabase
          .from("asset_purchase_batches")
          .select("id, quantity")
          .eq("id", batchId)
          .maybeSingle();

        if (batchError || !batch)
          return res.status(404).json({ message: `Batch ${batchId} not found` });
        
        // Count how many items from this batch are already assigned to employees
        const { count: employeeAssignedCount, error: countError } = await supabase
          .from("employee_asset_assignments")
          .select("*", { count: "exact", head: true })
          .eq("batch_id", batchId);
        
        if (countError) {
          console.error("Error counting employee assignments:", countError);
          return res.status(500).json({ message: "Failed to check batch availability" });
        }
        
        const alreadyAssignedToEmployees = employeeAssignedCount || 0;
        const employeeRemaining = Number(batch.quantity) - alreadyAssignedToEmployees;
        
        if (requestedCount > employeeRemaining) {
          return res.status(400).json({ 
            message: `Insufficient quantity in batch ${batchId} for employee assignment. Only ${employeeRemaining} available for employees (${alreadyAssignedToEmployees} already assigned to employees, ${batch.quantity} total in batch), but ${requestedCount} requested.` 
          });
        }
      }

      // Create assignment records (one per item)
      const assignmentDate = assignment_date ? new Date(assignment_date).toISOString() : new Date().toISOString();
      const assignmentRows = items.map((item: any) => ({
        employee_id: employeeId,
        batch_id: Number(item.batch_id),
        serial_number: item.serial_number?.trim() || null,
        barcode: item.barcode?.trim() || null,
        assignment_date: assignmentDate,
      }));

      const { data, error } = await supabase
        .from("employee_asset_assignments")
        .insert(assignmentRows)
        .select(`
          *,
          batch:asset_purchase_batches(
            id,
            purchase_date,
            purchase_price,
            asset:assets(id, asset_name, asset_number)
          )
        `);

      if (error) {
        // Provide more detailed error message
        let errorMessage = error.message || "Failed to create employee assignment";
        if (error.message && error.message.includes('quantity')) {
          errorMessage = "Database schema mismatch: The 'quantity' field no longer exists. Please run the database migration script to update your schema.";
        } else if (error.code === '23505') { // Unique constraint violation
          if (error.message && error.message.includes('serial_number')) {
            errorMessage = "A serial number you entered already exists. Please use a unique serial number.";
          } else if (error.message && error.message.includes('barcode')) {
            errorMessage = "A barcode you entered already exists. Please use a unique barcode.";
          }
        }
        console.error("Employee assignment error:", error);
        return res.status(500).json({ 
          message: errorMessage,
          details: error.details || error.hint || null,
          code: error.code
        });
      }
      res.json(data);
    } catch (e: any) {
      res.status(500).json({ message: e?.message || "Internal error" });
    }
  });

  app.delete("/api/employees/:employeeId/assignments/:assignmentId", async (req, res) => {
    try {
      const assignmentId = Number(req.params.assignmentId);
      if (Number.isNaN(assignmentId))
        return res.status(400).json({ message: "Invalid assignment ID" });

      const { error } = await supabase
        .from("employee_asset_assignments")
        .delete()
        .eq("id", assignmentId);

      if (error) return res.status(500).json({ message: error.message });
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ message: e?.message || "Internal error" });
    }
  });

  // Transfer assets from one employee to another
  app.put("/api/employees/:fromId/transfer-assets/:toId", async (req, res) => {
    try {
      const fromId = Number(req.params.fromId);
      const toId = Number(req.params.toId);
      
      if (Number.isNaN(fromId) || Number.isNaN(toId))
        return res.status(400).json({ message: "Invalid employee ID" });
      
      if (fromId === toId)
        return res.status(400).json({ message: "Cannot transfer assets to the same employee" });

      const { assignment_ids } = req.body;
      
      // If assignment_ids is provided, transfer only those specific assignments
      // Otherwise, transfer all assets from the source employee
      if (assignment_ids && Array.isArray(assignment_ids) && assignment_ids.length > 0) {
        // Transfer specific assignments
        const assignmentIds = assignment_ids.map((id: any) => Number(id)).filter((id: number) => !Number.isNaN(id));
        
        if (assignmentIds.length === 0)
          return res.status(400).json({ message: "No valid assignment IDs provided" });

        const { error } = await supabase
          .from("employee_asset_assignments")
          .update({ employee_id: toId })
          .eq("employee_id", fromId)
          .in("id", assignmentIds);

        if (error) return res.status(500).json({ message: error.message });
      } else {
        // Transfer all assets
        const { error } = await supabase
          .from("employee_asset_assignments")
          .update({ employee_id: toId })
          .eq("employee_id", fromId);

        if (error) return res.status(500).json({ message: error.message });
      }

      res.json({ ok: true, message: "Assets transferred successfully" });
    } catch (e: any) {
      res.status(500).json({ message: e?.message || "Internal error" });
    }
  });

  // Transfer employee from one department to another
  app.put("/api/employees/:id/transfer-department", async (req, res) => {
    try {
      const employeeId = Number(req.params.id);
      if (Number.isNaN(employeeId))
        return res.status(400).json({ message: "Invalid employee ID" });

      const { department_id } = req.body;
      if (department_id === undefined)
        return res.status(400).json({ message: "department_id is required" });

      const targetDepartmentId = department_id === null || department_id === "null" ? null : Number(department_id);
      if (targetDepartmentId !== null && Number.isNaN(targetDepartmentId))
        return res.status(400).json({ message: "Invalid department ID" });

      // Get current department assignment
      const { data: currentAssignment, error: fetchError } = await supabase
        .from("employee_department_assignments")
        .select("id, department_id")
        .eq("employee_id", employeeId)
        .maybeSingle();

      if (fetchError && fetchError.code !== "PGRST116") // PGRST116 = not found
        return res.status(500).json({ message: fetchError.message });

      // If target is null, remove department assignment
      if (targetDepartmentId === null) {
        if (currentAssignment) {
          const { error: deleteError } = await supabase
            .from("employee_department_assignments")
            .delete()
            .eq("id", currentAssignment.id);

          if (deleteError) return res.status(500).json({ message: deleteError.message });
        }
        return res.json({ ok: true, message: "Employee removed from department" });
      }

      // Check if target department exists
      const { data: dept, error: deptError } = await supabase
        .from("departments")
        .select("id")
        .eq("id", targetDepartmentId)
        .maybeSingle();

      if (deptError) return res.status(500).json({ message: deptError.message });
      if (!dept) return res.status(404).json({ message: "Target department not found" });

      // If employee is already in this department, do nothing
      if (currentAssignment && currentAssignment.department_id === targetDepartmentId) {
        return res.json({ ok: true, message: "Employee is already in this department" });
      }

      // Remove old assignment if exists
      if (currentAssignment) {
        const { error: deleteError } = await supabase
          .from("employee_department_assignments")
          .delete()
          .eq("id", currentAssignment.id);

        if (deleteError) return res.status(500).json({ message: deleteError.message });
      }

      // Create new assignment
      const { error: insertError } = await supabase
        .from("employee_department_assignments")
        .insert([{
          employee_id: employeeId,
          department_id: targetDepartmentId,
          assigned_at: new Date().toISOString(),
        }]);

      if (insertError) return res.status(500).json({ message: insertError.message });

      res.json({ ok: true, message: "Employee transferred successfully" });
    } catch (e: any) {
      res.status(500).json({ message: e?.message || "Internal error" });
    }
  });

  // ---------------- DEPARTMENTS ----------------
  app.get("/api/departments", async (_req, res) => {
    try {
      const { data: departments, error } = await supabase
        .from("departments")
        .select("*")
        .order("name", { ascending: true });
      if (error) return res.status(500).json({ message: error.message });
      
      // Get employee counts for each department
      const departmentsWithCounts = await Promise.all(
        (departments || []).map(async (dept: any) => {
          const { count, error: countError } = await supabase
            .from("employee_department_assignments")
            .select("*", { count: "exact", head: true })
            .eq("department_id", dept.id);
          
          return {
            ...dept,
            employeeCount: countError ? 0 : (count || 0),
          };
        })
      );
      
      res.json(departmentsWithCounts);
    } catch (e: any) {
      res.status(500).json({ message: e?.message || "Internal error" });
    }
  });

  app.get("/api/departments/:id", async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (Number.isNaN(id))
        return res.status(400).json({ message: "Invalid department ID" });

      const { data, error } = await supabase
        .from("departments")
        .select(`
          *,
          employees:employee_department_assignments(
            employee:employees(id, name, employee_id)
          )
        `)
        .eq("id", id)
        .maybeSingle();

      if (error) return res.status(500).json({ message: error.message });
      if (!data) return res.status(404).json({ message: "Department not found" });
      res.json(data);
    } catch (e: any) {
      res.status(500).json({ message: e?.message || "Internal error" });
    }
  });

  app.post("/api/departments", async (req, res) => {
    try {
      const { name, manager } = req.body;
      if (!name || typeof name !== "string" || !name.trim())
        return res.status(400).json({ message: "Department name is required" });
      if (!manager || typeof manager !== "string" || !manager.trim())
        return res.status(400).json({ message: "Manager name is required" });

      const { data, error } = await supabase
        .from("departments")
        .insert([{ name: name.trim(), manager: manager.trim() }])
        .select("*")
        .maybeSingle();

      if (error) return res.status(500).json({ message: error.message });
      res.json(data);
    } catch (e: any) {
      res.status(500).json({ message: e?.message || "Internal error" });
    }
  });

  app.put("/api/departments/:id", async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (Number.isNaN(id))
        return res.status(400).json({ message: "Invalid department ID" });

      const { name, manager } = req.body;
      const updateData: any = {};
      if (name !== undefined) updateData.name = name?.trim() || null;
      if (manager !== undefined) updateData.manager = manager?.trim() || null;

      if (Object.keys(updateData).length === 0)
        return res.status(400).json({ message: "No fields to update" });

      const { data, error } = await supabase
        .from("departments")
        .update(updateData)
        .eq("id", id)
        .select("*")
        .maybeSingle();

      if (error) return res.status(500).json({ message: error.message });
      if (!data) return res.status(404).json({ message: "Department not found" });
      res.json(data);
    } catch (e: any) {
      res.status(500).json({ message: e?.message || "Internal error" });
    }
  });

  app.delete("/api/departments/:id", async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (Number.isNaN(id))
        return res.status(400).json({ message: "Invalid department ID" });

      const { error } = await supabase.from("departments").delete().eq("id", id);
      if (error) return res.status(500).json({ message: error.message });
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ message: e?.message || "Internal error" });
    }
  });

  // Department Employee Assignments
  app.get("/api/departments/:id/employees", async (req, res) => {
    try {
      const departmentId = Number(req.params.id);
      if (Number.isNaN(departmentId))
        return res.status(400).json({ message: "Invalid department ID" });

      const { data, error } = await supabase
        .from("employee_department_assignments")
        .select(`
          *,
          employee:employees(id, name, employee_id)
        `)
        .eq("department_id", departmentId)
        .order("assigned_at", { ascending: false });

      if (error) return res.status(500).json({ message: error.message });
      res.json(data || []);
    } catch (e: any) {
      res.status(500).json({ message: e?.message || "Internal error" });
    }
  });

  app.post("/api/departments/:id/employees", async (req, res) => {
    try {
      const departmentId = Number(req.params.id);
      if (Number.isNaN(departmentId))
        return res.status(400).json({ message: "Invalid department ID" });

      const { employee_id } = req.body;
      if (!employee_id)
        return res.status(400).json({ message: "employee_id is required" });

      const { data, error } = await supabase
        .from("employee_department_assignments")
        .insert([{
          department_id: departmentId,
          employee_id: employee_id,
          assigned_at: new Date().toISOString(),
        }])
        .select(`
          *,
          employee:employees(id, name, employee_id)
        `)
        .maybeSingle();

      if (error) {
        if (error.code === '23505') { // Unique constraint violation
          return res.status(400).json({ message: "Employee is already assigned to this department" });
        }
        return res.status(500).json({ message: error.message });
      }
      res.json(data);
    } catch (e: any) {
      res.status(500).json({ message: e?.message || "Internal error" });
    }
  });

  app.delete("/api/departments/:departmentId/employees/:assignmentId", async (req, res) => {
    try {
      const assignmentId = Number(req.params.assignmentId);
      if (Number.isNaN(assignmentId))
        return res.status(400).json({ message: "Invalid assignment ID" });

      const { error } = await supabase
        .from("employee_department_assignments")
        .delete()
        .eq("id", assignmentId);

      if (error) return res.status(500).json({ message: error.message });
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ message: e?.message || "Internal error" });
    }
  });


  // ---------------- ASSETS ----------------
  app.get("/api/assets", async (req, res) => {
    try {
      const { pump_id, category_id } = req.query as Record<string, string>;
      const pumpIdParam = pump_id ?? "";
      const parsedPumpId =
        pumpIdParam &&
        pumpIdParam !== "all" &&
        pumpIdParam !== "null" &&
        pumpIdParam !== "undefined"
          ? Number(pumpIdParam)
          : null;
      const pumpFilter =
        parsedPumpId != null && !Number.isNaN(parsedPumpId) ? parsedPumpId : null;
      const hasPumpFilter = pumpFilter != null;
      let filteredAssetIds: number[] | null = null;

      if (hasPumpFilter) {
        const { data: assignmentRows, error: filterError } = await supabase
          .from("asset_assignments")
          .select("asset_id")
          .eq("pump_id", pumpFilter);
        if (filterError)
          return res.status(500).json({ message: filterError.message });

        filteredAssetIds = Array.from(
          new Set((assignmentRows || []).map((row: any) => row.asset_id))
        );

        if (filteredAssetIds.length === 0) return res.json([]);
      }

      let query = supabase
        .from("assets")
        .select("*")
        .order("id", { ascending: false });

      if (category_id) query = query.eq("category_id", category_id);
      if (filteredAssetIds) query = query.in("id", filteredAssetIds);

      const { data, error } = await query;
      if (error) return res.status(500).json({ message: error.message });

      const result = await hydrateAssets(data || []);
      if (result.error)
        return res.status(500).json({ message: result.error.message });

      return res.json(result.data);
    } catch (e: any) {
      return res
        .status(500)
        .json({ message: e?.message || "Internal error" });
    }
  });

  // ✅ CREATE ASSET — supports asset_value and purchase batches
  app.post("/api/assets", async (req, res) => {
    try {
      const b = req.body || {};
      const asset_name = b.asset_name ?? b.assetName ?? null;
      const asset_number = b.asset_number ?? b.assetNumber ?? null;
      const serial_number = b.serial_number ?? b.serialNumber ?? null;
      const barcode = b.barcode ?? null;
      const units = b.units ?? null;
      const category_id = b.category_id ?? b.categoryId ?? null;
      const asset_value = 0; // Default value, not used anymore
      const assignments = sanitizeAssignments(b.assignments);

      const { data, error } = await supabase
        .from("assets")
        .insert([
          {
            asset_name,
            asset_number,
            serial_number,
            barcode,
            quantity: null, // Quantity is now managed through batches
            units,
            remarks: null, // Remarks are now in batches
            category_id,
            asset_value,
          },
        ])
        .select("*")
        .maybeSingle();

      if (error)
        return res.status(400).json({ message: "DB insert error", error });
      if (!data) return res.status(500).json({ message: "Asset insert failed" });

      // Note: Purchase batches are now created separately through the batches endpoint
      // This endpoint no longer creates batches automatically

      if (assignments.length > 0) {
        const capacityCheck = await ensureCapacity(
          data.id,
          null, // Quantity is now managed through batches
          assignments
        );
        if (!capacityCheck.ok) {
          await supabase.from("assets").delete().eq("id", data.id);
          return res
            .status(400)
            .json({ message: capacityCheck.error?.message || "Invalid assignments" });
        }

        const { error: assignmentError } = await replaceAssetAssignments(
          data.id,
          assignments
        );
        if (assignmentError) {
          await supabase.from("assets").delete().eq("id", data.id);
          return res.status(500).json({ message: assignmentError.message });
        }
      }

      const enriched = await fetchAssetById(data.id);
      if (enriched.error)
        return res.status(500).json({ message: enriched.error.message });
      return res.status(201).json(enriched.data ?? data);
    } catch (e: any) {
      return res
        .status(500)
        .json({ message: e?.message || "Internal server error" });
    }
  });

  // ✅ UPDATE ASSET — supports asset_value
  app.put("/api/assets/:id", async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (Number.isNaN(id))
        return res.status(400).json({ message: "Invalid id" });

      const existing = await supabase
        .from("assets")
        .select("id, quantity")
        .eq("id", id)
        .maybeSingle();

      if (existing.error)
        return res.status(500).json({ message: existing.error.message });
      if (!existing.data)
        return res.status(404).json({ message: "Asset not found" });

      const b = req.body || {};
      const payload: any = {};

      if ("assetName" in b || "asset_name" in b)
        payload.asset_name = b.asset_name ?? b.assetName;
      if ("assetNumber" in b || "asset_number" in b)
        payload.asset_number = b.asset_number ?? b.assetNumber;
      if ("serialNumber" in b || "serial_number" in b)
        payload.serial_number = b.serial_number ?? b.serialNumber;
      if ("barcode" in b) payload.barcode = b.barcode ?? null;
      if ("quantity" in b)
        payload.quantity =
          b.quantity == null ? null : Number.isNaN(Number(b.quantity)) ? null : Number(b.quantity);
      if ("units" in b) payload.units = b.units ?? null;
      if ("remarks" in b) payload.remarks = b.remarks ?? null;
      if ("categoryId" in b || "category_id" in b)
        payload.category_id = b.category_id ?? b.categoryId ?? null;
      if ("asset_value" in b) payload.asset_value = Number(b.asset_value) || 0;

      const shouldReplaceAssignments = Array.isArray(b.assignments);
      const assignments = sanitizeAssignments(b.assignments);

      if (shouldReplaceAssignments) {
        const capacityCheck = await ensureCapacity(
          id,
          payload.quantity ?? existing.data.quantity ?? 0,
          assignments
        );
        if (!capacityCheck.ok) {
          return res
            .status(400)
            .json({ message: capacityCheck.error?.message || "Invalid assignments" });
        }
      } else if ("quantity" in payload && payload.quantity != null) {
        const { total, error } = await fetchAssignmentsTotal(id);
        if (error)
          return res.status(500).json({ message: error.message });
        if (total > payload.quantity) {
          return res.status(400).json({
            message: `Existing assignments (${total}) exceed the new quantity (${payload.quantity}).`,
          });
        }
      }

      let updatedRow = existing.data;
      if (Object.keys(payload).length > 0) {
        const { data, error } = await supabase
          .from("assets")
          .update(payload)
          .eq("id", id)
          .select("*")
          .maybeSingle();
        if (error) return res.status(500).json({ message: error.message });
        if (!data) return res.status(404).json({ message: "Asset not found" });
        updatedRow = data;
      }

      if (shouldReplaceAssignments) {
        const { error } = await replaceAssetAssignments(id, assignments);
        if (error) {
          const errorMessage = error.message || "Failed to update assignments";
          console.error("Assignment update error:", error);
          return res.status(500).json({ 
            message: errorMessage,
            details: error.details || null
          });
        }
      }

      const enriched = await fetchAssetById(id);
      if (enriched.error)
        return res.status(500).json({ message: enriched.error.message });
      res.json(enriched.data ?? updatedRow);
    } catch (e: any) {
      res
        .status(500)
        .json({ message: e?.message || "Internal error updating asset" });
    }
  });

  // DELETE ASSET
  app.delete("/api/assets/:id", async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (Number.isNaN(id))
        return res.status(400).json({ message: "Invalid ID" });

      // DB schema has ON DELETE CASCADE, so this automatically 
      // removes related assignments and batches.
      const { error } = await supabase.from("assets").delete().eq("id", id);

      if (error) return res.status(500).json({ message: error.message });

      res.status(204).send();
    } catch (e: any) {
      res.status(500).json({ message: e?.message || "Internal error" });
    }
  });

  // ASSIGN
  app.put("/api/assets/:id/assign", async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (Number.isNaN(id))
        return res.status(400).json({ message: "Invalid id" });

      const body = req.body || {};
      const hasAssignmentsArray = Array.isArray(body.assignments);
      let nextAssignments = hasAssignmentsArray
        ? sanitizeAssignments(body.assignments)
        : null;

      if (!hasAssignmentsArray && body.pump_id != null) {
        const pumpId = Number(body.pump_id);
        const quantity =
          body.quantity == null || Number.isNaN(Number(body.quantity))
            ? null
            : Number(body.quantity);

        // Get existing assignments to understand current state
        const { data: existingAssignments, error: existingError } = await supabase
          .from("asset_assignments")
          .select("id, pump_id")
          .eq("asset_id", id);
        if (existingError)
          return res.status(500).json({ message: existingError.message });

        // Get existing allocations to count current items per pump
        const existingAssignmentIds = (existingAssignments || []).map((a: any) => a.id);
        const { data: existingAllocations } = existingAssignmentIds.length > 0
          ? await supabase
              .from("assignment_batch_allocations")
              .select("assignment_id, batch_id")
              .in("assignment_id", existingAssignmentIds)
          : { data: [] };

        // Count current items per pump
        const merged = new Map<number, number>();
        (existingAssignments || []).forEach((row: any) => {
          const itemCount = (existingAllocations || []).filter(
            (alloc: any) => alloc.assignment_id === row.id
          ).length;
          merged.set(row.pump_id, itemCount);
        });

        if (quantity == null || quantity <= 0) {
          merged.delete(pumpId);
        } else {
          merged.set(pumpId, quantity);
        }

        // Convert to new format: for each pump, we need to auto-allocate items from batches
        // Since we don't have batch info in legacy format, we'll need to fetch available batches
        // and auto-allocate (FIFO) for the requested quantities
        const { data: availableBatches } = await supabase
          .from("asset_purchase_batches")
          .select("id, remaining_quantity")
          .eq("asset_id", id)
          .gt("remaining_quantity", 0)
          .order("purchase_date", { ascending: true });

        nextAssignments = await Promise.all(
          Array.from(merged.entries()).map(async ([pump_id, requestedQty]) => {
            const items: AssignmentItem[] = [];
            let remaining = requestedQty;

            // Auto-allocate from batches (FIFO)
            if (availableBatches) {
              for (const batch of availableBatches) {
                if (remaining <= 0) break;
                const toAllocate = Math.min(remaining, batch.remaining_quantity);
                for (let i = 0; i < toAllocate; i++) {
                  items.push({
                    batch_id: batch.id,
                    serial_number: undefined,
                    barcode: undefined,
                  });
                }
                remaining -= toAllocate;
              }
            }

            // If we couldn't allocate all items, return error will be handled by capacity check
            return {
              pump_id,
              items,
            };
          })
        );
      }

      if (nextAssignments) {
        const capacityCheck = await ensureCapacity(id, null, nextAssignments);
        if (!capacityCheck.ok) {
          return res
            .status(400)
            .json({ message: capacityCheck.error?.message || "Invalid assignments" });
        }

        const { error } = await replaceAssetAssignments(id, nextAssignments);
        if (error) return res.status(500).json({ message: error.message });
      }

      if ("category_id" in body || "categoryId" in body) {
        const categoryPayload = {
          category_id: body.category_id ?? body.categoryId ?? null,
        };
        const { error } = await supabase
          .from("assets")
          .update(categoryPayload)
          .eq("id", id);
        if (error) return res.status(500).json({ message: error.message });
      }

      const enriched = await fetchAssetById(id);
      if (enriched.error)
        return res.status(500).json({ message: enriched.error.message });
      res.json(enriched.data);
    } catch (e: any) {
      res
        .status(500)
        .json({ message: e?.message || "Internal error assigning asset" });
    }
  });

  // REPORTS
  app.get("/api/reports/assets-by-category", async (req, res) => {
    try {
      const { pump_id, category_id, employee_id } = req.query as Record<string, string>;
      const pumpIdParam = pump_id ?? "";
      const parsedPumpId =
        pumpIdParam &&
        pumpIdParam !== "all" &&
        pumpIdParam !== "null" &&
        pumpIdParam !== "undefined"
          ? Number(pumpIdParam)
          : null;
      const pumpFilter =
        parsedPumpId != null && !Number.isNaN(parsedPumpId) ? parsedPumpId : null;
      const hasPumpFilter = pumpFilter != null;
      
      // Parse employee filter
      const employeeIdParam = employee_id ?? "";
      const parsedEmployeeId =
        employeeIdParam &&
        employeeIdParam !== "all" &&
        employeeIdParam !== "null" &&
        employeeIdParam !== "undefined"
          ? Number(employeeIdParam)
          : null;
      const employeeFilter =
        parsedEmployeeId != null && !Number.isNaN(parsedEmployeeId) ? parsedEmployeeId : null;
      const hasEmployeeFilter = employeeFilter != null;
      
      let filteredAssetIds: number[] | null = null;

      // 1. Pre-filter assets IDs if a station is selected
      if (hasPumpFilter) {
        const { data: assignmentRows, error: filterError } = await supabase
          .from("asset_assignments")
          .select("asset_id")
          .eq("pump_id", pumpFilter);
        if (filterError)
          return res.status(500).json({ message: filterError.message });

        filteredAssetIds = Array.from(
          new Set((assignmentRows || []).map((row: any) => row.asset_id))
        );

        if (filteredAssetIds.length === 0) return res.json([]);
      }

      // 1b. Pre-filter assets IDs if an employee is selected
      if (hasEmployeeFilter) {
        // Get batch IDs assigned to this employee
        const { data: employeeAssignments, error: empError } = await supabase
          .from("employee_asset_assignments")
          .select("batch_id")
          .eq("employee_id", employeeFilter);
        if (empError)
          return res.status(500).json({ message: empError.message });

        if (!employeeAssignments || employeeAssignments.length === 0) return res.json([]);

        const batchIds = Array.from(new Set(employeeAssignments.map((a: any) => a.batch_id)));

        // Get asset IDs from these batches
        const { data: batchRows, error: batchError } = await supabase
          .from("asset_purchase_batches")
          .select("asset_id")
          .in("id", batchIds);
        if (batchError)
          return res.status(500).json({ message: batchError.message });

        const employeeAssetIds = Array.from(
          new Set((batchRows || []).map((row: any) => row.asset_id))
        );

        // Combine with existing filter if any
        if (filteredAssetIds) {
          filteredAssetIds = filteredAssetIds.filter((id) => employeeAssetIds.includes(id));
        } else {
          filteredAssetIds = employeeAssetIds;
        }

        if (filteredAssetIds.length === 0) return res.json([]);
      }

      // 2. Fetch Assets
      let assetQuery = supabase
        .from("assets")
        .select("*")
        .order("category_id", { ascending: true });
      if (category_id && category_id !== "all")
        assetQuery = assetQuery.eq("category_id", category_id);
      if (filteredAssetIds) assetQuery = assetQuery.in("id", filteredAssetIds);

      const { data, error } = await assetQuery;
      if (error) return res.status(500).json({ message: error.message });

      // 3. Hydrate with assignments and details
      const hydrated = await hydrateAssets(data || []);
      if (hydrated.error)
        return res.status(500).json({ message: hydrated.error.message });

      // 4. Filter top-level assets (Category/ID check)
      const filteredAssets = (hydrated.data || []).filter((asset: any) => {
        if (category_id && category_id !== "all")
          return asset.category_id === category_id;
        if (filteredAssetIds) return filteredAssetIds.includes(asset.id);
        return true;
      });

      // 5. Flatten and STRICTLY filter assignments
      const flattened = filteredAssets.flatMap((asset: any) => {
        const allAssignments = asset.assignments || [];

        // A. Strict Filter: Isolate assignments for the selected station
        let relevantAssignments = allAssignments;
        if (hasPumpFilter) {
          relevantAssignments = allAssignments.filter(
            (assignment: any) => Number(assignment.pump_id) === Number(pumpFilter)
          );
        }

        // B. If station selected but this asset has NO assignments there, hide it entirely.
        if (hasPumpFilter && relevantAssignments.length === 0) {
          return [];
        }

        // C. If no station selected (View All) and asset is unassigned, show ghost row.
        if (!hasPumpFilter && relevantAssignments.length === 0) {
          return [
            {
              ...asset,
              assignmentQuantity: 0,
              pump_id: null,
              pumpName: null,
              assignmentValue: 0,
            },
          ];
        }

        // D. Map valid assignments to rows
        return relevantAssignments.map((assignment: any) => ({
          ...asset, // Keeps parent asset info
          assignmentQuantity: assignment.quantity,
          pump_id: assignment.pump_id,
          pumpName: assignment.pump_name,
          assignmentValue:
            assignment.assignment_value ??
            Number(assignment.quantity || 0) *
            (Number(asset.asset_value) || 0),
        }));
      });

      return res.json(flattened);
    } catch (e: any) {
      return res.status(500).json({ message: e?.message || "Internal error" });
    }
  });

  app.get("/api/reports/all-assets", async (_req, res) => {
    try {
      const { data, error } = await supabase
        .from("assets")
        .select("*")
        .order("id", { ascending: false });
      if (error) return res.status(500).json({ message: error.message });

      const hydrated = await hydrateAssets(data || []);
      if (hydrated.error)
        return res.status(500).json({ message: hydrated.error.message });
      return res.json(hydrated.data);
    } catch (e: any) {
      return res.status(500).json({ message: e?.message || "Internal error" });
    }
  });

  app.get("/api/reports/all-stations", async (_req, res) => {
    const { data, error } = await supabase
      .from("pumps")
      .select("*")
      .order("id", { ascending: false });
    if (error) return res.status(500).json({ message: error.message });
    return res.json(data);
  });

  // ========== BATCH ENDPOINTS ==========
  // Get batches for an asset
  app.get("/api/assets/:id/batches", async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (Number.isNaN(id))
        return res.status(400).json({ message: "Invalid asset ID" });

      const { data, error } = await supabase
        .from("asset_purchase_batches")
        .select("*")
        .eq("asset_id", id)
        .order("purchase_date", { ascending: true });

      if (error) return res.status(500).json({ message: error.message });
      
      // Get employee assignment counts per batch
      const batchIds = (data || []).map((b: any) => b.id);
      let employeeAssignmentCounts = new Map<number, number>();
      
      if (batchIds.length > 0) {
        const { data: employeeAssignments } = await supabase
          .from("employee_asset_assignments")
          .select("batch_id")
          .in("batch_id", batchIds);
        
        if (employeeAssignments) {
          employeeAssignments.forEach((assignment: any) => {
            const count = employeeAssignmentCounts.get(assignment.batch_id) || 0;
            employeeAssignmentCounts.set(assignment.batch_id, count + 1);
          });
        }
      }
      
      // Enrich batches with employee assignment counts
      const enrichedBatches = (data || []).map((batch: any) => {
        const employeeAssignedCount = employeeAssignmentCounts.get(batch.id) || 0;
        const employeeRemainingQuantity = Number(batch.quantity) - employeeAssignedCount;
        
        return {
          ...batch,
          employee_assigned_count: employeeAssignedCount,
          employee_remaining_quantity: employeeRemainingQuantity,
        };
      });
      
      return res.json(enrichedBatches);
    } catch (e: any) {
      return res.status(500).json({ message: e?.message || "Internal error" });
    }
  });

  // Add new batch (inventory) to existing asset
  app.post("/api/assets/:id/batches", async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (Number.isNaN(id))
        return res.status(400).json({ message: "Invalid asset ID" });

      const { purchase_price, quantity, purchase_date, remarks, batch_name } = req.body;
      if (!purchase_price || purchase_price <= 0)
        return res.status(400).json({ message: "Purchase price required" });
      if (!quantity || quantity <= 0)
        return res.status(400).json({ message: "Quantity required" });
      const normalizedBatchName = batch_name?.trim() || null;

      // Verify asset exists
      const { data: asset, error: assetError } = await supabase
        .from("assets")
        .select("id, quantity")
        .eq("id", id)
        .maybeSingle();

      if (assetError || !asset)
        return res.status(404).json({ message: "Asset not found" });

      // Update asset quantity
      const newQuantity = (asset.quantity || 0) + quantity;
      await supabase
        .from("assets")
        .update({ quantity: newQuantity })
        .eq("id", id);

      // Create batch (serial_number and barcode are now tracked at assignment level)
      const { data: batch, error: batchError } = await createPurchaseBatch(
        id,
        Number(purchase_price),
        Number(quantity),
        purchase_date ? new Date(purchase_date) : undefined,
        remarks || null,
        normalizedBatchName
      );

      if (batchError) return res.status(500).json({ message: batchError.message });
      return res.status(201).json(batch);
    } catch (e: any) {
      return res.status(500).json({ message: e?.message || "Internal error" });
    }
  });

  // Update batch
  app.put("/api/assets/:assetId/batches/:batchId", async (req, res) => {
    try {
      const assetId = Number(req.params.assetId);
      const batchId = Number(req.params.batchId);
      if (Number.isNaN(assetId) || Number.isNaN(batchId))
        return res.status(400).json({ message: "Invalid IDs" });

      const { purchase_price, purchase_date, batch_name } = req.body;
      if (purchase_price != null && purchase_price <= 0)
        return res.status(400).json({ message: "Purchase price must be greater than 0" });

      // Verify batch exists and belongs to asset
      const { data: batch, error: batchError } = await supabase
        .from("asset_purchase_batches")
        .select("*")
        .eq("id", batchId)
        .eq("asset_id", assetId)
        .maybeSingle();

      if (batchError || !batch)
        return res.status(404).json({ message: "Batch not found" });

      const updateData: any = {};
      if (purchase_price != null) updateData.purchase_price = Number(purchase_price);
      if (purchase_date) updateData.purchase_date = new Date(purchase_date).toISOString();
      if (batch_name != null) {
        updateData.batch_name = batch_name?.trim() || null;
      }

      if (Object.keys(updateData).length === 0)
        return res.status(400).json({ message: "No fields to update" });

      const { data: updated, error: updateError } = await supabase
        .from("asset_purchase_batches")
        .update(updateData)
        .eq("id", batchId)
        .select("*")
        .maybeSingle();

      if (updateError) return res.status(500).json({ message: updateError.message });
      return res.json(updated);
    } catch (e: any) {
      return res.status(500).json({ message: e?.message || "Internal error" });
    }
  });

  // Delete batch (only if not used)
  app.delete("/api/assets/:assetId/batches/:batchId", async (req, res) => {
    try {
      const assetId = Number(req.params.assetId);
      const batchId = Number(req.params.batchId);
      if (Number.isNaN(assetId) || Number.isNaN(batchId))
        return res.status(400).json({ message: "Invalid IDs" });

      // Verify batch exists and belongs to asset
      const { data: batch, error: batchError } = await supabase
        .from("asset_purchase_batches")
        .select("quantity, remaining_quantity")
        .eq("id", batchId)
        .eq("asset_id", assetId)
        .maybeSingle();

      if (batchError || !batch)
        return res.status(404).json({ message: "Batch not found" });

      // Only allow deletion if batch hasn't been used
      if (batch.remaining_quantity !== batch.quantity) {
        return res.status(400).json({
          message: "Cannot delete batch that has been partially or fully assigned. Remaining quantity must equal total quantity.",
        });
      }

      // Update asset quantity
      const { data: asset } = await supabase
        .from("assets")
        .select("quantity")
        .eq("id", assetId)
        .maybeSingle();

      if (asset) {
        const newQuantity = Math.max(0, (asset.quantity || 0) - batch.quantity);
        await supabase
          .from("assets")
          .update({ quantity: newQuantity })
          .eq("id", assetId);
      }

      // Delete batch
      const { error: deleteError } = await supabase
        .from("asset_purchase_batches")
        .delete()
        .eq("id", batchId);

      if (deleteError) return res.status(500).json({ message: deleteError.message });
      return res.status(204).send();
    } catch (e: any) {
      return res.status(500).json({ message: e?.message || "Internal error" });
    }
  });
}
