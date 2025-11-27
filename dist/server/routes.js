"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerRoutes = registerRoutes;
const supabaseClient_1 = require("./supabaseClient");
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
function registerRoutes(app) {
    const JWT_SECRET = process.env.JWT_SECRET || "replace-with-secure-secret";
    const TOKEN_COOKIE_NAME = "token";
    const TOKEN_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days
    const sanitizeAssignments = (input) => {
        if (!Array.isArray(input))
            return [];
        // Don't merge when batch_id is specified - each assignment needs its own batch
        const result = [];
        input.forEach((item) => {
            const pumpId = Number(item?.pump_id);
            const qty = Number(item?.quantity);
            const batchId = item?.batch_id ? Number(item.batch_id) : undefined;
            if (!Number.isFinite(pumpId) || pumpId <= 0)
                return;
            if (!Number.isFinite(qty) || qty <= 0)
                return;
            if (batchId !== undefined && (!Number.isFinite(batchId) || batchId <= 0))
                return;
            result.push({
                pump_id: pumpId,
                quantity: qty,
                batch_id: batchId,
            });
        });
        return result;
    };
    const sumAssignmentQuantity = (assignments) => assignments.reduce((total, assignment) => total + assignment.quantity, 0);
    const hydrateAssets = async (assets) => {
        if (!assets || assets.length === 0)
            return { data: [], error: null };
        const assetIds = assets.map((a) => a.id);
        const [{ data: cats, error: catError }, { data: pumps, error: pumpError }, { data: assignmentRows, error: assignmentError }, { data: batchRows, error: batchError },] = await Promise.all([
            supabaseClient_1.supabase.from("categories").select("id, name"),
            supabaseClient_1.supabase.from("pumps").select("id, name"),
            supabaseClient_1.supabase
                .from("asset_assignments")
                .select("id, asset_id, pump_id, quantity, pumps(name)")
                .in("asset_id", assetIds),
            supabaseClient_1.supabase
                .from("asset_purchase_batches")
                .select("*")
                .in("asset_id", assetIds),
        ]);
        // Fetch batch allocations separately after we have assignment IDs
        const assignmentIds = (assignmentRows || []).map((r) => r.id);
        const { data: allocationRows, error: allocationError } = assignmentIds.length > 0
            ? await supabaseClient_1.supabase
                .from("assignment_batch_allocations")
                .select("assignment_id, batch_id, quantity, asset_purchase_batches(purchase_price)")
                .in("assignment_id", assignmentIds)
            : { data: [], error: null };
        if (catError || pumpError || assignmentError || batchError || allocationError) {
            return {
                data: null,
                error: catError || pumpError || assignmentError || batchError || allocationError,
            };
        }
        const catMap = new Map((cats || []).map((c) => [c.id, c.name]));
        const pumpMap = new Map((pumps || []).map((p) => [p.id, p.name]));
        const batchesByAsset = new Map();
        const allocationsByAssignment = new Map();
        (batchRows || []).forEach((batch) => {
            const collection = batchesByAsset.get(batch.asset_id) || [];
            collection.push(batch);
            batchesByAsset.set(batch.asset_id, collection);
        });
        (allocationRows || []).forEach((alloc) => {
            const collection = allocationsByAssignment.get(alloc.assignment_id) || [];
            collection.push({
                batch_id: alloc.batch_id,
                quantity: alloc.quantity,
                unit_price: Number(alloc.asset_purchase_batches?.purchase_price || 0),
            });
            allocationsByAssignment.set(alloc.assignment_id, collection);
        });
        const assignmentsByAsset = new Map();
        (assignmentRows || []).forEach((row) => {
            const collection = assignmentsByAsset.get(row.asset_id) || [];
            const batchAllocations = allocationsByAssignment.get(row.id) || [];
            const assignmentValue = batchAllocations.length > 0
                ? calculateAssignmentValue(batchAllocations)
                : Number(row.quantity || 0) * (Number(assets.find((a) => a.id === row.asset_id)?.asset_value) || 0);
            collection.push({
                id: row.id,
                asset_id: row.asset_id,
                pump_id: row.pump_id,
                quantity: row.quantity,
                pump_name: row.pumps?.name ?? pumpMap.get(row.pump_id) ?? null,
                assignment_value: assignmentValue,
                batch_allocations: batchAllocations,
            });
            assignmentsByAsset.set(row.asset_id, collection);
        });
        const hydrated = assets.map((asset) => {
            const assignmentList = assignmentsByAsset.get(asset.id) || [];
            const batches = batchesByAsset.get(asset.id) || [];
            // Calculate total value from batches
            const totalBatchValue = batches.reduce((sum, batch) => sum + Number(batch.purchase_price) * Number(batch.quantity), 0);
            const remainingBatchValue = batches.reduce((sum, batch) => sum + Number(batch.purchase_price) * Number(batch.remaining_quantity), 0);
            const totalAssigned = assignmentList.reduce((total, assignment) => total + (assignment.quantity || 0), 0);
            const totalAssignedValue = assignmentList.reduce((total, assignment) => total + (assignment.assignment_value || 0), 0);
            const totalQuantity = batches.reduce((sum, batch) => sum + Number(batch.quantity), 0);
            const remainingQuantity = batches.reduce((sum, batch) => sum + Number(batch.remaining_quantity), 0);
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
                batches: batches.map((b) => ({
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
    const fetchAssetById = async (id) => {
        const { data, error } = await supabaseClient_1.supabase
            .from("assets")
            .select("*")
            .eq("id", id)
            .maybeSingle();
        if (error)
            return { data: null, error };
        if (!data)
            return { data: null, error: null };
        return hydrateAssets([data]).then((result) => ({
            data: result.data?.[0] ?? null,
            error: result.error,
        }));
    };
    const replaceAssetAssignments = async (assetId, assignments) => {
        // Get existing assignments to delete their batch allocations
        const { data: existingAssignments } = await supabaseClient_1.supabase
            .from("asset_assignments")
            .select("id")
            .eq("asset_id", assetId);
        if (existingAssignments && existingAssignments.length > 0) {
            const assignmentIds = existingAssignments.map((a) => a.id);
            await supabaseClient_1.supabase
                .from("assignment_batch_allocations")
                .delete()
                .in("assignment_id", assignmentIds);
        }
        const { error: deleteError } = await supabaseClient_1.supabase
            .from("asset_assignments")
            .delete()
            .eq("asset_id", assetId);
        if (deleteError)
            return { error: deleteError };
        if (assignments.length === 0)
            return { error: null };
        // Create assignments and allocate from specified batches
        const assignmentRows = assignments.map((assignment) => ({
            asset_id: assetId,
            pump_id: assignment.pump_id,
            quantity: assignment.quantity,
        }));
        const { data: insertedAssignments, error: insertError } = await supabaseClient_1.supabase
            .from("asset_assignments")
            .insert(assignmentRows)
            .select("id, quantity");
        if (insertError)
            return { error: insertError };
        // Allocate from specified batches for each assignment
        for (let i = 0; i < insertedAssignments.length; i++) {
            const assignment = insertedAssignments[i];
            const assignmentInput = assignments[i];
            const requiredQty = assignment.quantity;
            // If batch_id is specified, use that batch; otherwise use FIFO
            let allocations;
            if (assignmentInput.batch_id) {
                // Check if the specified batch has enough quantity
                const { data: batch, error: batchError } = await supabaseClient_1.supabase
                    .from("asset_purchase_batches")
                    .select("remaining_quantity, purchase_price")
                    .eq("id", assignmentInput.batch_id)
                    .eq("asset_id", assetId)
                    .maybeSingle();
                if (batchError || !batch) {
                    // Rollback: delete created assignments
                    await supabaseClient_1.supabase
                        .from("asset_assignments")
                        .delete()
                        .in("id", insertedAssignments.map((a) => a.id));
                    return {
                        error: {
                            message: `Batch not found or invalid.`,
                        },
                    };
                }
                if (batch.remaining_quantity < requiredQty) {
                    // Rollback: delete created assignments
                    await supabaseClient_1.supabase
                        .from("asset_assignments")
                        .delete()
                        .in("id", insertedAssignments.map((a) => a.id));
                    return {
                        error: {
                            message: `Insufficient stock in selected batch. Only ${batch.remaining_quantity} units available.`,
                        },
                    };
                }
                allocations = [{
                        batch_id: assignmentInput.batch_id,
                        quantity: requiredQty,
                    }];
            }
            else {
                // Fallback to FIFO if no batch specified
                allocations = await allocateFromBatches(assetId, requiredQty);
                if (!allocations) {
                    // Rollback: delete created assignments
                    await supabaseClient_1.supabase
                        .from("asset_assignments")
                        .delete()
                        .in("id", insertedAssignments.map((a) => a.id));
                    return {
                        error: {
                            message: `Insufficient stock. Cannot allocate ${requiredQty} units.`,
                        },
                    };
                }
            }
            await createBatchAllocations(assignment.id, allocations);
        }
        return { error: null };
    };
    const fetchAssignmentsTotal = async (assetId) => {
        const { data, error } = await supabaseClient_1.supabase
            .from("asset_assignments")
            .select("quantity")
            .eq("asset_id", assetId);
        if (error)
            return { total: 0, error };
        const total = data?.reduce((sum, row) => sum + (row.quantity || 0), 0) ?? 0;
        return { total, error: null };
    };
    const ensureCapacity = async (assetId, targetQuantity, assignments) => {
        const totalAssigned = sumAssignmentQuantity(assignments);
        let capacity = targetQuantity;
        if (capacity == null) {
            const { data, error } = await supabaseClient_1.supabase
                .from("assets")
                .select("quantity")
                .eq("id", assetId)
                .maybeSingle();
            if (error)
                return { ok: false, error };
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
        return { ok: true, error: null };
    };
    // ========== BATCH FUNCTIONS ==========
    const createPurchaseBatch = async (assetId, purchasePrice, quantity, purchaseDate, remarks, serialNumber, barcode) => {
        const { data, error } = await supabaseClient_1.supabase
            .from("asset_purchase_batches")
            .insert([
            {
                asset_id: assetId,
                purchase_price: purchasePrice,
                quantity: quantity,
                remaining_quantity: quantity,
                purchase_date: purchaseDate || new Date().toISOString(),
                remarks: remarks || null,
                serial_number: serialNumber ?? null,
                barcode: barcode ?? null,
            },
        ])
            .select("*")
            .maybeSingle();
        return { data, error };
    };
    const allocateFromBatches = async (assetId, requiredQuantity) => {
        const { data: batches, error } = await supabaseClient_1.supabase
            .from("asset_purchase_batches")
            .select("*")
            .eq("asset_id", assetId)
            .gt("remaining_quantity", 0)
            .order("purchase_date", { ascending: true });
        if (error || !batches || batches.length === 0)
            return null;
        const allocations = [];
        let remaining = requiredQuantity;
        for (const batch of batches) {
            if (remaining <= 0)
                break;
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
    const createBatchAllocations = async (assignmentId, allocations) => {
        if (allocations.length === 0)
            return { error: null };
        const rows = allocations.map((alloc) => ({
            assignment_id: assignmentId,
            batch_id: alloc.batch_id,
            quantity: alloc.quantity,
        }));
        const { error } = await supabaseClient_1.supabase
            .from("assignment_batch_allocations")
            .insert(rows);
        return { error };
    };
    const calculateAssignmentValue = (allocations) => {
        return allocations.reduce((sum, alloc) => sum + alloc.quantity * alloc.unit_price, 0);
    };
    // ---------------- AUTH ----------------
    app.post("/api/login", async (req, res) => {
        const { username, password } = req.body;
        if (!username || !password)
            return res.status(400).json({ message: "Missing credentials" });
        const { data: user, error } = await supabaseClient_1.supabase
            .from("users")
            .select("id, password_hash")
            .eq("username", username)
            .maybeSingle();
        if (error || !user)
            return res.status(401).json({ message: "Invalid credentials" });
        const passwordOk = password === user.password_hash;
        if (!passwordOk)
            return res.status(401).json({ message: "Invalid credentials" });
        const token = jsonwebtoken_1.default.sign({ userId: user.id }, JWT_SECRET, {
            expiresIn: "7d",
        });
        // Set cookie with proper settings
        const cookieOptions = {
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
        }
        else {
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
    app.get("/api/me", async (req, res) => {
        // Try to get token from cookie first
        let token = req.cookies?.[TOKEN_COOKIE_NAME];
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
            const decoded = jsonwebtoken_1.default.verify(token, JWT_SECRET);
            const { data, error } = await supabaseClient_1.supabase
                .from("users")
                .select("id, username")
                .eq("id", decoded.userId)
                .maybeSingle();
            if (error || !data) {
                return res.status(200).json({ authenticated: false });
            }
            return res.json({ authenticated: true, user: data });
        }
        catch (err) {
            // Token expired or invalid - return unauthenticated but with 200 status
            // This prevents the frontend from treating it as an error
            return res.status(200).json({ authenticated: false });
        }
    });
    // ---------------- PUMPS ----------------
    app.get("/api/pumps", async (_req, res) => {
        try {
            const { data: pumps, error } = await supabaseClient_1.supabase
                .from("pumps")
                .select("*")
                .order("id", { ascending: false });
            if (error)
                return res.status(500).json({ message: error.message });
            const { data: assignmentRows, error: assignmentErr } = await supabaseClient_1.supabase
                .from("asset_assignments")
                .select("asset_id, pump_id");
            if (assignmentErr)
                return res.status(500).json({ message: assignmentErr.message });
            const seen = new Set();
            const assetCountMap = new Map();
            (assignmentRows || []).forEach((row) => {
                if (!row.pump_id)
                    return;
                const key = `${row.pump_id}-${row.asset_id}`;
                if (seen.has(key))
                    return;
                seen.add(key);
                assetCountMap.set(row.pump_id, (assetCountMap.get(row.pump_id) || 0) + 1);
            });
            const result = pumps.map((p) => ({
                ...p,
                assetCount: assetCountMap.get(p.id) || 0,
            }));
            return res.json(result);
        }
        catch (e) {
            console.error("Error fetching pumps:", e);
            res.status(500).json({ message: e?.message || "Internal error" });
        }
    });
    app.post("/api/pumps", async (req, res) => {
        const { name, location, manager } = req.body;
        if (!name || !location || !manager)
            return res.status(400).json({ message: "Missing fields" });
        const { data, error } = await supabaseClient_1.supabase
            .from("pumps")
            .insert([{ name, location, manager }])
            .select("*")
            .maybeSingle();
        if (error)
            return res.status(500).json({ message: error.message });
        return res.status(201).json(data);
    });
    app.put("/api/pumps/:id", async (req, res) => {
        const id = Number(req.params.id);
        const payload = req.body;
        const { data, error } = await supabaseClient_1.supabase
            .from("pumps")
            .update(payload)
            .eq("id", id)
            .select("*")
            .maybeSingle();
        if (error)
            return res.status(500).json({ message: error.message });
        if (!data)
            return res.status(404).json({ message: "Pump not found" });
        res.json(data);
    });
    // Prevent deletion if assets exist
    app.delete("/api/pumps/:id", async (req, res) => {
        try {
            const id = Number(req.params.id);
            if (Number.isNaN(id))
                return res.status(400).json({ message: "Invalid pump ID" });
            const { data: assignments, error: assignmentError } = await supabaseClient_1.supabase
                .from("asset_assignments")
                .select("id")
                .eq("pump_id", id);
            if (assignmentError)
                return res.status(500).json({ message: assignmentError.message });
            if (assignments && assignments.length > 0) {
                return res
                    .status(400)
                    .json({
                    message: "Cannot delete this pump because assets are currently allocated to it.",
                });
            }
            const { error } = await supabaseClient_1.supabase.from("pumps").delete().eq("id", id);
            if (error)
                return res.status(500).json({ message: error.message });
            res.status(204).send();
        }
        catch (e) {
            res
                .status(500)
                .json({ message: e?.message || "Internal server error" });
        }
    });
    // --------------- CATEGORIES ---------------
    app.get("/api/categories", async (_req, res) => {
        const { data, error } = await supabaseClient_1.supabase
            .from("categories")
            .select("*")
            .order("name", { ascending: true });
        if (error)
            return res.status(500).json({ message: error.message });
        return res.json(data);
    });
    app.post("/api/categories", async (req, res) => {
        const { name } = req.body;
        if (!name)
            return res.status(400).json({ message: "Category name required" });
        const { data, error } = await supabaseClient_1.supabase
            .from("categories")
            .insert([{ name }])
            .select("*")
            .maybeSingle();
        if (error)
            return res.status(500).json({ message: error.message });
        return res.status(201).json(data);
    });
    app.delete("/api/categories/:id", async (req, res) => {
        const { id } = req.params;
        const { error } = await supabaseClient_1.supabase.from("categories").delete().eq("id", id);
        if (error)
            return res.status(500).json({ message: error.message });
        res.status(204).send();
    });
    // ---------------- ASSETS ----------------
    app.get("/api/assets", async (req, res) => {
        try {
            const { pump_id, category_id } = req.query;
            const pumpIdParam = pump_id ?? "";
            const parsedPumpId = pumpIdParam &&
                pumpIdParam !== "all" &&
                pumpIdParam !== "null" &&
                pumpIdParam !== "undefined"
                ? Number(pumpIdParam)
                : null;
            const pumpFilter = parsedPumpId != null && !Number.isNaN(parsedPumpId) ? parsedPumpId : null;
            const hasPumpFilter = pumpFilter != null;
            let filteredAssetIds = null;
            if (hasPumpFilter) {
                const { data: assignmentRows, error: filterError } = await supabaseClient_1.supabase
                    .from("asset_assignments")
                    .select("asset_id")
                    .eq("pump_id", pumpFilter);
                if (filterError)
                    return res.status(500).json({ message: filterError.message });
                filteredAssetIds = Array.from(new Set((assignmentRows || []).map((row) => row.asset_id)));
                if (filteredAssetIds.length === 0)
                    return res.json([]);
            }
            let query = supabaseClient_1.supabase
                .from("assets")
                .select("*")
                .order("id", { ascending: false });
            if (category_id)
                query = query.eq("category_id", category_id);
            if (filteredAssetIds)
                query = query.in("id", filteredAssetIds);
            const { data, error } = await query;
            if (error)
                return res.status(500).json({ message: error.message });
            const result = await hydrateAssets(data || []);
            if (result.error)
                return res.status(500).json({ message: result.error.message });
            return res.json(result.data);
        }
        catch (e) {
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
            const { data, error } = await supabaseClient_1.supabase
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
            if (!data)
                return res.status(500).json({ message: "Asset insert failed" });
            // Note: Purchase batches are now created separately through the batches endpoint
            // This endpoint no longer creates batches automatically
            if (assignments.length > 0) {
                const capacityCheck = await ensureCapacity(data.id, null, // Quantity is now managed through batches
                assignments);
                if (!capacityCheck.ok) {
                    await supabaseClient_1.supabase.from("assets").delete().eq("id", data.id);
                    return res
                        .status(400)
                        .json({ message: capacityCheck.error?.message || "Invalid assignments" });
                }
                const { error: assignmentError } = await replaceAssetAssignments(data.id, assignments);
                if (assignmentError) {
                    await supabaseClient_1.supabase.from("assets").delete().eq("id", data.id);
                    return res.status(500).json({ message: assignmentError.message });
                }
            }
            const enriched = await fetchAssetById(data.id);
            if (enriched.error)
                return res.status(500).json({ message: enriched.error.message });
            return res.status(201).json(enriched.data ?? data);
        }
        catch (e) {
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
            const existing = await supabaseClient_1.supabase
                .from("assets")
                .select("id, quantity")
                .eq("id", id)
                .maybeSingle();
            if (existing.error)
                return res.status(500).json({ message: existing.error.message });
            if (!existing.data)
                return res.status(404).json({ message: "Asset not found" });
            const b = req.body || {};
            const payload = {};
            if ("assetName" in b || "asset_name" in b)
                payload.asset_name = b.asset_name ?? b.assetName;
            if ("assetNumber" in b || "asset_number" in b)
                payload.asset_number = b.asset_number ?? b.assetNumber;
            if ("serialNumber" in b || "serial_number" in b)
                payload.serial_number = b.serial_number ?? b.serialNumber;
            if ("barcode" in b)
                payload.barcode = b.barcode ?? null;
            if ("quantity" in b)
                payload.quantity =
                    b.quantity == null ? null : Number.isNaN(Number(b.quantity)) ? null : Number(b.quantity);
            if ("units" in b)
                payload.units = b.units ?? null;
            if ("remarks" in b)
                payload.remarks = b.remarks ?? null;
            if ("categoryId" in b || "category_id" in b)
                payload.category_id = b.category_id ?? b.categoryId ?? null;
            if ("asset_value" in b)
                payload.asset_value = Number(b.asset_value) || 0;
            const shouldReplaceAssignments = Array.isArray(b.assignments);
            const assignments = sanitizeAssignments(b.assignments);
            if (shouldReplaceAssignments) {
                const capacityCheck = await ensureCapacity(id, payload.quantity ?? existing.data.quantity ?? 0, assignments);
                if (!capacityCheck.ok) {
                    return res
                        .status(400)
                        .json({ message: capacityCheck.error?.message || "Invalid assignments" });
                }
            }
            else if ("quantity" in payload && payload.quantity != null) {
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
                const { data, error } = await supabaseClient_1.supabase
                    .from("assets")
                    .update(payload)
                    .eq("id", id)
                    .select("*")
                    .maybeSingle();
                if (error)
                    return res.status(500).json({ message: error.message });
                if (!data)
                    return res.status(404).json({ message: "Asset not found" });
                updatedRow = data;
            }
            if (shouldReplaceAssignments) {
                const { error } = await replaceAssetAssignments(id, assignments);
                if (error)
                    return res.status(500).json({ message: error.message });
            }
            const enriched = await fetchAssetById(id);
            if (enriched.error)
                return res.status(500).json({ message: enriched.error.message });
            res.json(enriched.data ?? updatedRow);
        }
        catch (e) {
            res
                .status(500)
                .json({ message: e?.message || "Internal error updating asset" });
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
                const quantity = body.quantity == null || Number.isNaN(Number(body.quantity))
                    ? null
                    : Number(body.quantity);
                const { data: existingAssignments, error: existingError } = await supabaseClient_1.supabase
                    .from("asset_assignments")
                    .select("pump_id, quantity")
                    .eq("asset_id", id);
                if (existingError)
                    return res.status(500).json({ message: existingError.message });
                const merged = new Map();
                (existingAssignments || []).forEach((row) => {
                    merged.set(row.pump_id, row.quantity || 0);
                });
                if (quantity == null || quantity <= 0) {
                    merged.delete(pumpId);
                }
                else {
                    merged.set(pumpId, quantity);
                }
                nextAssignments = Array.from(merged.entries()).map(([pump_id, qty]) => ({
                    pump_id,
                    quantity: qty,
                }));
            }
            if (nextAssignments) {
                const capacityCheck = await ensureCapacity(id, null, nextAssignments);
                if (!capacityCheck.ok) {
                    return res
                        .status(400)
                        .json({ message: capacityCheck.error?.message || "Invalid assignments" });
                }
                const { error } = await replaceAssetAssignments(id, nextAssignments);
                if (error)
                    return res.status(500).json({ message: error.message });
            }
            if ("category_id" in body || "categoryId" in body) {
                const categoryPayload = {
                    category_id: body.category_id ?? body.categoryId ?? null,
                };
                const { error } = await supabaseClient_1.supabase
                    .from("assets")
                    .update(categoryPayload)
                    .eq("id", id);
                if (error)
                    return res.status(500).json({ message: error.message });
            }
            const enriched = await fetchAssetById(id);
            if (enriched.error)
                return res.status(500).json({ message: enriched.error.message });
            res.json(enriched.data);
        }
        catch (e) {
            res
                .status(500)
                .json({ message: e?.message || "Internal error assigning asset" });
        }
    });
    // REPORTS
    app.get("/api/reports/assets-by-category", async (req, res) => {
        try {
            const { pump_id, category_id } = req.query;
            const pumpIdParam = pump_id ?? "";
            const parsedPumpId = pumpIdParam &&
                pumpIdParam !== "all" &&
                pumpIdParam !== "null" &&
                pumpIdParam !== "undefined"
                ? Number(pumpIdParam)
                : null;
            const pumpFilter = parsedPumpId != null && !Number.isNaN(parsedPumpId) ? parsedPumpId : null;
            const hasPumpFilter = pumpFilter != null;
            let filteredAssetIds = null;
            // 1. Pre-filter assets IDs if a station is selected
            if (hasPumpFilter) {
                const { data: assignmentRows, error: filterError } = await supabaseClient_1.supabase
                    .from("asset_assignments")
                    .select("asset_id")
                    .eq("pump_id", pumpFilter);
                if (filterError)
                    return res.status(500).json({ message: filterError.message });
                filteredAssetIds = Array.from(new Set((assignmentRows || []).map((row) => row.asset_id)));
                if (filteredAssetIds.length === 0)
                    return res.json([]);
            }
            // 2. Fetch Assets
            let assetQuery = supabaseClient_1.supabase
                .from("assets")
                .select("*")
                .order("category_id", { ascending: true });
            if (category_id && category_id !== "all")
                assetQuery = assetQuery.eq("category_id", category_id);
            if (filteredAssetIds)
                assetQuery = assetQuery.in("id", filteredAssetIds);
            const { data, error } = await assetQuery;
            if (error)
                return res.status(500).json({ message: error.message });
            // 3. Hydrate with assignments and details
            const hydrated = await hydrateAssets(data || []);
            if (hydrated.error)
                return res.status(500).json({ message: hydrated.error.message });
            // 4. Filter top-level assets (Category/ID check)
            const filteredAssets = (hydrated.data || []).filter((asset) => {
                if (category_id && category_id !== "all")
                    return asset.category_id === category_id;
                if (filteredAssetIds)
                    return filteredAssetIds.includes(asset.id);
                return true;
            });
            // 5. Flatten and STRICTLY filter assignments
            const flattened = filteredAssets.flatMap((asset) => {
                const allAssignments = asset.assignments || [];
                // A. Strict Filter: Isolate assignments for the selected station
                let relevantAssignments = allAssignments;
                if (hasPumpFilter) {
                    relevantAssignments = allAssignments.filter((assignment) => Number(assignment.pump_id) === Number(pumpFilter));
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
                return relevantAssignments.map((assignment) => ({
                    ...asset, // Keeps parent asset info
                    assignmentQuantity: assignment.quantity,
                    pump_id: assignment.pump_id,
                    pumpName: assignment.pump_name,
                    assignmentValue: assignment.assignment_value ??
                        Number(assignment.quantity || 0) *
                            (Number(asset.asset_value) || 0),
                }));
            });
            return res.json(flattened);
        }
        catch (e) {
            return res.status(500).json({ message: e?.message || "Internal error" });
        }
    });
    app.get("/api/reports/all-assets", async (_req, res) => {
        try {
            const { data, error } = await supabaseClient_1.supabase
                .from("assets")
                .select("*")
                .order("id", { ascending: false });
            if (error)
                return res.status(500).json({ message: error.message });
            const hydrated = await hydrateAssets(data || []);
            if (hydrated.error)
                return res.status(500).json({ message: hydrated.error.message });
            return res.json(hydrated.data);
        }
        catch (e) {
            return res.status(500).json({ message: e?.message || "Internal error" });
        }
    });
    app.get("/api/reports/all-stations", async (_req, res) => {
        const { data, error } = await supabaseClient_1.supabase
            .from("pumps")
            .select("*")
            .order("id", { ascending: false });
        if (error)
            return res.status(500).json({ message: error.message });
        return res.json(data);
    });
    // ========== BATCH ENDPOINTS ==========
    // Get batches for an asset
    app.get("/api/assets/:id/batches", async (req, res) => {
        try {
            const id = Number(req.params.id);
            if (Number.isNaN(id))
                return res.status(400).json({ message: "Invalid asset ID" });
            const { data, error } = await supabaseClient_1.supabase
                .from("asset_purchase_batches")
                .select("*")
                .eq("asset_id", id)
                .order("purchase_date", { ascending: true });
            if (error)
                return res.status(500).json({ message: error.message });
            return res.json(data || []);
        }
        catch (e) {
            return res.status(500).json({ message: e?.message || "Internal error" });
        }
    });
    // Add new batch (inventory) to existing asset
    app.post("/api/assets/:id/batches", async (req, res) => {
        try {
            const id = Number(req.params.id);
            if (Number.isNaN(id))
                return res.status(400).json({ message: "Invalid asset ID" });
            const { purchase_price, quantity, purchase_date, remarks, serial_number, barcode } = req.body;
            if (!purchase_price || purchase_price <= 0)
                return res.status(400).json({ message: "Purchase price required" });
            if (!quantity || quantity <= 0)
                return res.status(400).json({ message: "Quantity required" });
            if (!serial_number || typeof serial_number !== "string" || !serial_number.trim())
                return res.status(400).json({ message: "Serial number required" });
            if (!barcode || typeof barcode !== "string" || !barcode.trim())
                return res.status(400).json({ message: "Barcode required" });
            const normalizedSerial = serial_number.trim();
            const normalizedBarcode = barcode.trim();
            // Verify asset exists
            const { data: asset, error: assetError } = await supabaseClient_1.supabase
                .from("assets")
                .select("id, quantity")
                .eq("id", id)
                .maybeSingle();
            if (assetError || !asset)
                return res.status(404).json({ message: "Asset not found" });
            // Update asset quantity
            const newQuantity = (asset.quantity || 0) + quantity;
            await supabaseClient_1.supabase
                .from("assets")
                .update({ quantity: newQuantity })
                .eq("id", id);
            // Create batch
            const { data: batch, error: batchError } = await createPurchaseBatch(id, Number(purchase_price), Number(quantity), purchase_date ? new Date(purchase_date) : undefined, remarks || null, normalizedSerial, normalizedBarcode);
            if (batchError)
                return res.status(500).json({ message: batchError.message });
            await supabaseClient_1.supabase
                .from("assets")
                .update({ serial_number: normalizedSerial, barcode: normalizedBarcode })
                .eq("id", id);
            return res.status(201).json(batch);
        }
        catch (e) {
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
            const { purchase_price, purchase_date, serial_number, barcode } = req.body;
            if (purchase_price != null && purchase_price <= 0)
                return res.status(400).json({ message: "Purchase price must be greater than 0" });
            // Verify batch exists and belongs to asset
            const { data: batch, error: batchError } = await supabaseClient_1.supabase
                .from("asset_purchase_batches")
                .select("*")
                .eq("id", batchId)
                .eq("asset_id", assetId)
                .maybeSingle();
            if (batchError || !batch)
                return res.status(404).json({ message: "Batch not found" });
            const updateData = {};
            if (purchase_price != null)
                updateData.purchase_price = Number(purchase_price);
            if (purchase_date)
                updateData.purchase_date = new Date(purchase_date).toISOString();
            if (serial_number != null) {
                if (typeof serial_number !== "string" || !serial_number.trim()) {
                    return res.status(400).json({ message: "Serial number cannot be empty" });
                }
                updateData.serial_number = serial_number.trim();
            }
            if (barcode != null) {
                if (typeof barcode !== "string" || !barcode.trim()) {
                    return res.status(400).json({ message: "Barcode cannot be empty" });
                }
                updateData.barcode = barcode.trim();
            }
            if (Object.keys(updateData).length === 0)
                return res.status(400).json({ message: "No fields to update" });
            const { data: updated, error: updateError } = await supabaseClient_1.supabase
                .from("asset_purchase_batches")
                .update(updateData)
                .eq("id", batchId)
                .select("*")
                .maybeSingle();
            if (updateError)
                return res.status(500).json({ message: updateError.message });
            if (updateData.serial_number || updateData.barcode) {
                await supabaseClient_1.supabase
                    .from("assets")
                    .update({
                    ...(updateData.serial_number ? { serial_number: updateData.serial_number } : {}),
                    ...(updateData.barcode ? { barcode: updateData.barcode } : {}),
                })
                    .eq("id", assetId);
            }
            return res.json(updated);
        }
        catch (e) {
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
            const { data: batch, error: batchError } = await supabaseClient_1.supabase
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
            const { data: asset } = await supabaseClient_1.supabase
                .from("assets")
                .select("quantity")
                .eq("id", assetId)
                .maybeSingle();
            if (asset) {
                const newQuantity = Math.max(0, (asset.quantity || 0) - batch.quantity);
                await supabaseClient_1.supabase
                    .from("assets")
                    .update({ quantity: newQuantity })
                    .eq("id", assetId);
            }
            // Delete batch
            const { error: deleteError } = await supabaseClient_1.supabase
                .from("asset_purchase_batches")
                .delete()
                .eq("id", batchId);
            if (deleteError)
                return res.status(500).json({ message: deleteError.message });
            return res.status(204).send();
        }
        catch (e) {
            return res.status(500).json({ message: e?.message || "Internal error" });
        }
    });
}
