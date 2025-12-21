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
    // Permission checking middleware
    const requireRole = (allowedRoles) => {
        return async (req, res, next) => {
            try {
                let token = req.cookies?.[TOKEN_COOKIE_NAME];
                if (!token) {
                    const authHeader = req.headers.authorization;
                    if (authHeader && authHeader.startsWith("Bearer ")) {
                        token = authHeader.substring(7);
                    }
                }
                if (!token) {
                    return res.status(401).json({ message: "Authentication required" });
                }
                const decoded = jsonwebtoken_1.default.verify(token, JWT_SECRET);
                console.log("[AUTH] Token decoded:", { userId: decoded.userId, role: decoded.role });
                const { data: user, error } = await supabaseClient_1.supabase
                    .from("users")
                    .select("id, username, role")
                    .eq("id", decoded.userId)
                    .maybeSingle();
                if (error || !user) {
                    console.error("[AUTH] User not found in database:", { userId: decoded.userId, error });
                    return res.status(401).json({ message: "Invalid user" });
                }
                console.log("[AUTH] User from database:", { id: user.id, username: user.username, role: user.role });
                console.log("[AUTH] Allowed roles:", allowedRoles);
                console.log("[AUTH] User role in allowed roles?", allowedRoles.includes(user.role));
                if (!allowedRoles.includes(user.role)) {
                    console.error("[AUTH] Permission denied:", { userRole: user.role, allowedRoles });
                    return res.status(403).json({ message: "Insufficient permissions" });
                }
                req.user = user;
                next();
            }
            catch (err) {
                console.error("[AUTH] Token verification error:", err.message);
                return res.status(401).json({ message: "Invalid token" });
            }
        };
    };
    // Helper to check if user can perform assignment actions
    const canAssign = (req) => {
        const user = req.user;
        return user && (user.role === 'admin' || user.role === 'assigning_user');
    };
    // adding a comment to check the git is working fine or not
    // Helper to check if user is admin
    const isAdmin = (req) => {
        const user = req.user;
        return user && user.role === 'admin';
    };
    // Middleware to require admin permissions only
    const requireAdminPermission = requireRole(['admin']);
    // Middleware to require assignment permissions (admin or assigning_user)
    const requireAssignPermission = requireRole(['admin', 'assigning_user']);
    // Middleware to require any authenticated user (for viewing)
    const requireAuth = requireRole(['admin', 'viewing_user', 'assigning_user']);
    const sanitizeAssignments = (input) => {
        if (!Array.isArray(input))
            return [];
        // Each assignment should have pump_id and items array
        // Each item has batch_id, serial_number (optional), barcode (optional)
        const result = [];
        input.forEach((assignment) => {
            const pumpId = Number(assignment?.pump_id);
            if (!Number.isFinite(pumpId) || pumpId <= 0)
                return;
            const items = [];
            if (Array.isArray(assignment.items)) {
                assignment.items.forEach((item) => {
                    const batchId = Number(item?.batch_id);
                    if (!Number.isFinite(batchId) || batchId <= 0)
                        return;
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
    const sumAssignmentQuantity = (assignments) => assignments.reduce((total, assignment) => total + assignment.items.length, 0);
    const hydrateAssets = async (assets) => {
        if (!assets || assets.length === 0)
            return { data: [], error: null };
        const assetIds = assets.map((a) => a.id);
        const [{ data: cats, error: catError }, { data: pumps, error: pumpError }, { data: assignmentRows, error: assignmentError }, { data: batchRows, error: batchError },] = await Promise.all([
            supabaseClient_1.supabase.from("categories").select("id, name"),
            supabaseClient_1.supabase.from("pumps").select("id, name"),
            assetIds.length > 0
                ? supabaseClient_1.supabase
                    .from("asset_assignments")
                    .select("id, asset_id, pump_id, quantity, created_at, pumps(name)")
                    .in("asset_id", assetIds)
                : Promise.resolve({ data: [], error: null }),
            assetIds.length > 0
                ? supabaseClient_1.supabase
                    .from("asset_purchase_batches")
                    .select("*")
                    .in("asset_id", assetIds)
                : Promise.resolve({ data: [], error: null }),
        ]);
        // Fetch employee assignments separately after we have batches
        // Note: employee_asset_assignments doesn't have asset_id directly, need to join through batches
        let employeeAssignmentRows = [];
        let employeeAssignmentError = null;
        if (assetIds.length > 0 && batchRows && batchRows.length > 0) {
            try {
                // Get all batch IDs for these assets
                const batchIdsForAssets = batchRows.map((b) => b.id);
                if (batchIdsForAssets.length > 0) {
                    // Then fetch employee assignments for those batches (only active)
                    const { data, error } = await supabaseClient_1.supabase
                        .from("employee_asset_assignments")
                        .select("id, batch_id, employee_id, is_active")
                        .in("batch_id", batchIdsForAssets)
                        .eq("is_active", true);
                    if (error) {
                        employeeAssignmentError = error;
                        console.warn("Warning: Failed to fetch employee assignments:", error);
                    }
                    else {
                        employeeAssignmentRows = data || [];
                    }
                }
            }
            catch (err) {
                employeeAssignmentError = err;
                console.warn("Warning: Failed to fetch employee assignments:", err);
            }
        }
        // Fetch batch allocations separately after we have assignment IDs
        // Each allocation is now one item (no quantity field)
        const assignmentIds = (assignmentRows || []).map((r) => r.id);
        let allocationRows = [];
        let allocationError = null;
        if (assignmentIds.length > 0) {
            // First fetch allocations
            const { data: allocs, error: allocErr } = await supabaseClient_1.supabase
                .from("assignment_batch_allocations")
                .select("id, assignment_id, batch_id, serial_number, barcode")
                .in("assignment_id", assignmentIds);
            if (allocErr) {
                allocationError = allocErr;
            }
            else if (allocs && allocs.length > 0) {
                // Then fetch batches for these allocations
                const batchIds = Array.from(new Set(allocs.map((a) => a.batch_id).filter((id) => id != null)));
                if (batchIds.length > 0) {
                    const { data: batchData, error: batchErr } = await supabaseClient_1.supabase
                        .from("asset_purchase_batches")
                        .select("id, batch_name, purchase_date, purchase_price")
                        .in("id", batchIds);
                    if (batchErr) {
                        allocationError = batchErr;
                    }
                    else {
                        // Join allocations with batches
                        const batchMap = new Map((batchData || []).map((b) => [b.id, b]));
                        allocationRows = (allocs || []).map((alloc) => ({
                            ...alloc,
                            asset_purchase_batches: batchMap.get(alloc.batch_id) || null,
                        }));
                    }
                }
                else {
                    allocationRows = allocs || [];
                }
            }
        }
        // Employee assignment errors are non-critical - if they fail, just treat as no employee assignments
        if (employeeAssignmentError) {
            console.warn("Warning: Failed to fetch employee assignments (non-critical):", employeeAssignmentError);
        }
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
        // Store each allocation as a separate item to preserve individual assignment dates
        // Each allocation row is now one item (no quantity field)
        (allocationRows || []).forEach((alloc) => {
            if (!alloc || !alloc.assignment_id)
                return; // Skip invalid allocations
            const collection = allocationsByAssignment.get(alloc.assignment_id) || [];
            const batch = alloc.asset_purchase_batches;
            // Only add allocation if batch exists (batch is required)
            if (batch && batch.id) {
                collection.push({
                    id: alloc.id || `${alloc.assignment_id}_${alloc.batch_id}_${collection.length}`, // Fallback ID if missing
                    batch_id: alloc.batch_id,
                    quantity: 1, // Each allocation = 1 item
                    unit_price: Number(batch?.purchase_price || 0),
                    serial_number: alloc.serial_number || null,
                    barcode: alloc.barcode || null,
                    batch: {
                        id: batch.id,
                        batch_name: batch.batch_name || null,
                        purchase_date: batch.purchase_date || null,
                        purchase_price: Number(batch.purchase_price || 0),
                    },
                });
                allocationsByAssignment.set(alloc.assignment_id, collection);
            }
        });
        const assignmentsByAsset = new Map();
        (assignmentRows || []).forEach((row) => {
            const collection = assignmentsByAsset.get(row.asset_id) || [];
            const batchAllocations = allocationsByAssignment.get(row.id) || [];
            // Add assignment_date to each batch allocation (use created_at as assignment date for station assignments)
            const batchAllocationsWithDate = batchAllocations.map((alloc) => ({
                ...alloc,
                assignment_date: row.created_at || null, // Use created_at since assignment_date doesn't exist in asset_assignments
            }));
            // Calculate quantity from batch allocations (count of items)
            const calculatedQuantity = batchAllocationsWithDate.reduce((sum, alloc) => sum + (alloc.quantity || 0), 0);
            const assignmentQuantity = calculatedQuantity > 0 ? calculatedQuantity : (row.quantity || 0);
            // Calculate assignment value from batch allocations
            // Each allocation in batchAllocations has quantity (count of items) and unit_price
            const assignmentValue = batchAllocationsWithDate.length > 0
                ? batchAllocationsWithDate.reduce((sum, alloc) => sum + (alloc.quantity || 0) * (alloc.unit_price || 0), 0)
                : assignmentQuantity * (Number(assets.find((a) => a.id === row.asset_id)?.asset_value) || 0);
            collection.push({
                id: row.id,
                asset_id: row.asset_id,
                pump_id: row.pump_id,
                quantity: assignmentQuantity, // Use calculated quantity from allocations
                pump_name: row.pumps?.name ?? pumpMap.get(row.pump_id) ?? null,
                assignment_value: assignmentValue,
                assignment_date: row.created_at || null, // Use created_at since assignment_date doesn't exist in asset_assignments
                batch_allocations: batchAllocationsWithDate,
            });
            assignmentsByAsset.set(row.asset_id, collection);
        });
        const hydrated = assets.map((asset) => {
            const assignmentList = assignmentsByAsset.get(asset.id) || [];
            const batches = batchesByAsset.get(asset.id) || [];
            // Calculate total value from batches
            const totalBatchValue = batches.reduce((sum, batch) => sum + Number(batch.purchase_price) * Number(batch.quantity), 0);
            const remainingBatchValue = batches.reduce((sum, batch) => sum + Number(batch.purchase_price) * Number(batch.remaining_quantity), 0);
            // Calculate total assigned to stations by counting items in batch_allocations
            const totalAssignedToStations = assignmentList.reduce((total, assignment) => {
                if (assignment.batch_allocations && assignment.batch_allocations.length > 0) {
                    // Sum up quantities from batch allocations
                    return total + assignment.batch_allocations.reduce((sum, alloc) => sum + (alloc.quantity || 0), 0);
                }
                return total + (assignment.quantity || 0);
            }, 0);
            // Calculate total assigned to employees
            // Employee assignments are linked to assets through batches
            // Create a map of batch_id -> asset_id from the batches
            const batchToAssetMap = new Map();
            batches.forEach((batch) => {
                batchToAssetMap.set(batch.id, asset.id);
            });
            // Filter employee assignments where the batch belongs to this asset
            const employeeAssignmentsForAsset = (employeeAssignmentRows || []).filter((ea) => {
                if (!ea || !ea.batch_id)
                    return false;
                return batchToAssetMap.get(ea.batch_id) === asset.id;
            });
            const totalAssignedToEmployees = employeeAssignmentsForAsset.length;
            // Total assigned (stations + employees) for backward compatibility
            const totalAssigned = totalAssignedToStations + totalAssignedToEmployees;
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
                totalAssigned, // Total (stations + employees) for backward compatibility
                totalAssignedToStations, // New: Only station assignments
                totalAssignedToEmployees, // New: Only employee assignments
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
        // Group assignments by pump_id and collect all items
        const groupedByPump = new Map();
        for (const assignment of assignments) {
            const existing = groupedByPump.get(assignment.pump_id) || [];
            groupedByPump.set(assignment.pump_id, [...existing, ...assignment.items]);
        }
        // Verify batch availability for all items
        const allItems = [];
        for (const items of groupedByPump.values()) {
            allItems.push(...items);
        }
        // Check batch availability
        const batchCounts = new Map();
        for (const item of allItems) {
            batchCounts.set(item.batch_id, (batchCounts.get(item.batch_id) || 0) + 1);
        }
        for (const [batchId, requestedCount] of batchCounts.entries()) {
            const { data: batch, error: batchError } = await supabaseClient_1.supabase
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
        // Note: asset_assignments table doesn't have assignment_date column, so we don't set it
        const assignmentRows = Array.from(groupedByPump.entries()).map(([pump_id, items]) => ({
            asset_id: assetId,
            pump_id,
            quantity: items.length, // Store total count for compatibility
        }));
        const { data: insertedAssignments, error: insertError } = await supabaseClient_1.supabase
            .from("asset_assignments")
            .insert(assignmentRows)
            .select("id, pump_id");
        if (insertError)
            return { error: insertError };
        const deleteInsertedAssignments = async () => {
            if (insertedAssignments && insertedAssignments.length > 0) {
                await supabaseClient_1.supabase
                    .from("asset_assignments")
                    .delete()
                    .in("id", insertedAssignments.map((a) => a.id));
            }
        };
        // Create allocation records (one per item)
        for (const assignment of assignments) {
            const assignmentRow = insertedAssignments?.find((a) => a.pump_id === assignment.pump_id);
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
    const createPurchaseBatch = async (assetId, purchasePrice, quantity, purchaseDate, remarks, batchName) => {
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
                batch_name: batchName || null,
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
    const createBatchAllocations = async (assignmentId, items) => {
        if (items.length === 0)
            return { error: null };
        // Create one allocation record per item
        const rows = items.map((item) => ({
            assignment_id: assignmentId,
            batch_id: item.batch_id,
            serial_number: item.serial_number?.trim() || null,
            barcode: item.barcode?.trim() || null,
        }));
        const { error } = await supabaseClient_1.supabase
            .from("assignment_batch_allocations")
            .insert(rows);
        if (error) {
            // Provide more detailed error message
            let errorMessage = error.message || "Failed to create batch allocations";
            if (error.code === '23505') { // Unique constraint violation
                if (error.message.includes('serial_number')) {
                    errorMessage = "A serial number you entered already exists. Please use a unique serial number.";
                }
                else if (error.message.includes('barcode')) {
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
    const calculateAssignmentValue = async (assignmentId) => {
        // Get all allocations for this assignment and calculate total value
        const { data: allocations, error } = await supabaseClient_1.supabase
            .from("assignment_batch_allocations")
            .select("batch_id")
            .eq("assignment_id", assignmentId);
        if (error || !allocations)
            return 0;
        // Get batch prices
        const batchIds = allocations.map((a) => a.batch_id);
        const { data: batches } = await supabaseClient_1.supabase
            .from("asset_purchase_batches")
            .select("purchase_price")
            .in("id", batchIds);
        if (!batches)
            return 0;
        // Each allocation is one item, so sum up the prices
        return batches.reduce((sum, batch) => sum + Number(batch.purchase_price), 0);
    };
    // ---------------- AUTH ----------------
    app.post("/api/login", async (req, res) => {
        const { username, password } = req.body;
        if (!username || !password)
            return res.status(400).json({ message: "Missing credentials" });
        console.log("[LOGIN] Attempting login for username:", username);
        const { data: user, error } = await supabaseClient_1.supabase
            .from("users")
            .select("id, username, password_hash, role")
            .eq("username", username)
            .maybeSingle();
        if (error || !user) {
            console.error("[LOGIN] User not found or error:", error);
            return res.status(401).json({ message: "Invalid credentials" });
        }
        console.log("[LOGIN] User found:", { id: user.id, username: user.username, role: user.role });
        const passwordOk = password === user.password_hash;
        if (!passwordOk) {
            console.error("[LOGIN] Password mismatch for user:", username);
            return res.status(401).json({ message: "Invalid credentials" });
        }
        console.log("[LOGIN] Creating JWT token with role:", user.role);
        const token = jsonwebtoken_1.default.sign({ userId: user.id, role: user.role }, JWT_SECRET, {
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
    app.post("/api/logout", (req, res) => {
        // Determine cookie options to match login (must match exactly to clear properly)
        const origin = req.headers.origin || "";
        const isProduction = origin.includes("azharalibuttar.com") || process.env.NODE_ENV === "production";
        const clearCookieOptions = {
            path: "/",
            httpOnly: true,
        };
        if (isProduction) {
            clearCookieOptions.secure = true;
            clearCookieOptions.sameSite = "none";
            if (origin.includes("azharalibuttar.com")) {
                clearCookieOptions.domain = ".azharalibuttar.com";
            }
        }
        else {
            clearCookieOptions.secure = false;
            clearCookieOptions.sameSite = "lax";
        }
        // Clear cookie with matching options
        res.clearCookie(TOKEN_COOKIE_NAME, clearCookieOptions);
        // Also try clearing without domain (in case domain was set differently)
        if (clearCookieOptions.domain) {
            res.clearCookie(TOKEN_COOKIE_NAME, {
                ...clearCookieOptions,
                domain: undefined,
            });
        }
        console.log("[LOGOUT] Cleared authentication cookie");
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
            console.log("[API/ME] Token decoded:", { userId: decoded.userId, roleInToken: decoded.role });
            const { data, error } = await supabaseClient_1.supabase
                .from("users")
                .select("id, username, role")
                .eq("id", decoded.userId)
                .maybeSingle();
            if (error || !data) {
                console.error("[API/ME] User not found:", { userId: decoded.userId, error });
                return res.status(200).json({ authenticated: false });
            }
            console.log("[API/ME] Returning user data:", { id: data.id, username: data.username, role: data.role });
            return res.json({ authenticated: true, user: data });
        }
        catch (err) {
            console.error("[API/ME] Token verification error:", err.message);
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
                .select("id, asset_id, pump_id");
            if (assignmentErr)
                return res.status(500).json({ message: assignmentErr.message });
            // Get all batch allocations for these assignments
            const assignmentIds = (assignmentRows || []).map((a) => a.id);
            let allocationRows = [];
            if (assignmentIds.length > 0) {
                const { data: allocations, error: allocationErr } = await supabaseClient_1.supabase
                    .from("assignment_batch_allocations")
                    .select("assignment_id, batch_id")
                    .in("assignment_id", assignmentIds);
                if (allocationErr)
                    return res.status(500).json({ message: allocationErr.message });
                allocationRows = allocations || [];
                // Get batch prices
                const batchIds = Array.from(new Set(allocationRows.map((a) => a.batch_id)));
                if (batchIds.length > 0) {
                    const { data: batches, error: batchErr } = await supabaseClient_1.supabase
                        .from("asset_purchase_batches")
                        .select("id, purchase_price")
                        .in("id", batchIds);
                    if (batchErr)
                        return res.status(500).json({ message: batchErr.message });
                    // Create a map of batch_id to purchase_price
                    const batchPriceMap = new Map();
                    (batches || []).forEach((b) => {
                        batchPriceMap.set(b.id, Number(b.purchase_price || 0));
                    });
                    // Add purchase_price to each allocation
                    allocationRows = allocationRows.map((alloc) => ({
                        ...alloc,
                        purchase_price: batchPriceMap.get(alloc.batch_id) || 0,
                    }));
                }
            }
            const seen = new Set();
            const assetCountMap = new Map();
            const assetValueMap = new Map();
            // Create a map of assignment_id to pump_id
            const assignmentToPump = new Map();
            (assignmentRows || []).forEach((row) => {
                if (!row.pump_id)
                    return;
                assignmentToPump.set(row.id, row.pump_id);
                const key = `${row.pump_id}-${row.asset_id}`;
                if (seen.has(key))
                    return;
                seen.add(key);
                assetCountMap.set(row.pump_id, (assetCountMap.get(row.pump_id) || 0) + 1);
            });
            // Calculate total asset value per pump
            (allocationRows || []).forEach((alloc) => {
                const pumpId = assignmentToPump.get(alloc.assignment_id);
                if (!pumpId)
                    return;
                const price = alloc.purchase_price || 0;
                assetValueMap.set(pumpId, (assetValueMap.get(pumpId) || 0) + price);
            });
            const result = pumps.map((p) => ({
                ...p,
                assetCount: assetCountMap.get(p.id) || 0,
                totalAssetValue: assetValueMap.get(p.id) || 0,
            }));
            return res.json(result);
        }
        catch (e) {
            console.error("Error fetching pumps:", e);
            res.status(500).json({ message: e?.message || "Internal error" });
        }
    });
    app.post("/api/pumps", requireAdminPermission, async (req, res) => {
        const name = req.body?.name;
        const location = req.body?.location;
        const manager = req.body?.manager;
        const contact_number = req.body?.contact_number ?? req.body?.contactNumber ?? null;
        const remarks = req.body?.remarks ?? req.body?.details ?? null;
        if (!name || !location || !manager)
            return res.status(400).json({ message: "Missing fields" });
        const { data, error } = await supabaseClient_1.supabase
            .from("pumps")
            .insert([{ name, location, manager, contact_number, remarks }])
            .select("*")
            .maybeSingle();
        if (error)
            return res.status(500).json({ message: error.message });
        return res.status(201).json(data);
    });
    app.put("/api/pumps/:id", requireAdminPermission, async (req, res) => {
        const id = Number(req.params.id);
        const body = req.body || {};
        const payload = {};
        if ("name" in body)
            payload.name = body.name;
        if ("location" in body)
            payload.location = body.location;
        if ("manager" in body)
            payload.manager = body.manager;
        if ("contact_number" in body || "contactNumber" in body)
            payload.contact_number = body.contact_number ?? body.contactNumber ?? null;
        if ("remarks" in body || "details" in body)
            payload.remarks = body.remarks ?? body.details ?? null;
        if (Object.keys(payload).length === 0)
            return res.status(400).json({ message: "No fields to update" });
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
    app.delete("/api/pumps/:id", requireAdminPermission, async (req, res) => {
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
    app.post("/api/categories", requireAdminPermission, async (req, res) => {
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
    app.delete("/api/categories/:id", requireAdminPermission, async (req, res) => {
        const { id } = req.params;
        const { error } = await supabaseClient_1.supabase.from("categories").delete().eq("id", id);
        if (error)
            return res.status(500).json({ message: error.message });
        res.status(204).send();
    });
    // ---------------- EMPLOYEES ----------------
    app.get("/api/employees", async (_req, res) => {
        try {
            const { data, error } = await supabaseClient_1.supabase
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
            is_active,
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
            if (error)
                return res.status(500).json({ message: error.message });
            // Transform data to include department name and asset assignments
            const transformed = (data || []).map((emp) => {
                const departmentAssignment = emp.department_assignments?.[0];
                // Filter to only active assignments (is_active = true or NULL for pre-migration records)
                const activeAssignments = (emp.asset_assignments || []).filter((assignment) => assignment.is_active === true || assignment.is_active === null);
                // Group asset assignments by asset and batch
                const assetAssignments = activeAssignments.map((assignment) => ({
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
                const assetSummary = new Map();
                assetAssignments.forEach((assignment) => {
                    if (!assignment.asset)
                        return;
                    const assetKey = `${assignment.asset.id}`;
                    if (!assetSummary.has(assetKey)) {
                        assetSummary.set(assetKey, {
                            asset_id: assignment.asset.id,
                            asset_name: assignment.asset.asset_name,
                            asset_number: assignment.asset.asset_number,
                            batches: new Map(),
                        });
                    }
                    const asset = assetSummary.get(assetKey);
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
                    const batch = asset.batches.get(batchKey);
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
        }
        catch (e) {
            res.status(500).json({ message: e?.message || "Internal error" });
        }
    });
    app.post("/api/employees", requireAdminPermission, async (req, res) => {
        try {
            const { name, employee_id, department_id } = req.body;
            if (!name || typeof name !== "string" || !name.trim())
                return res.status(400).json({ message: "Employee name is required" });
            const { data: employee, error: empError } = await supabaseClient_1.supabase
                .from("employees")
                .insert([{ name: name.trim(), employee_id: employee_id?.trim() || null }])
                .select("*")
                .maybeSingle();
            if (empError)
                return res.status(500).json({ message: empError.message });
            if (!employee)
                return res.status(500).json({ message: "Failed to create employee" });
            // If department_id is provided, assign employee to department
            if (department_id) {
                const { error: assignError } = await supabaseClient_1.supabase
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
        }
        catch (e) {
            res.status(500).json({ message: e?.message || "Internal error" });
        }
    });
    app.put("/api/employees/:id", requireAdminPermission, async (req, res) => {
        try {
            const id = Number(req.params.id);
            if (Number.isNaN(id))
                return res.status(400).json({ message: "Invalid employee ID" });
            const { name, employee_id } = req.body;
            const updateData = {};
            if (name !== undefined)
                updateData.name = name?.trim() || null;
            if (employee_id !== undefined)
                updateData.employee_id = employee_id?.trim() || null;
            const { data, error } = await supabaseClient_1.supabase
                .from("employees")
                .update(updateData)
                .eq("id", id)
                .select("*")
                .maybeSingle();
            if (error)
                return res.status(500).json({ message: error.message });
            if (!data)
                return res.status(404).json({ message: "Employee not found" });
            res.json(data);
        }
        catch (e) {
            res.status(500).json({ message: e?.message || "Internal error" });
        }
    });
    app.delete("/api/employees/:id", requireAdminPermission, async (req, res) => {
        try {
            const id = Number(req.params.id);
            if (Number.isNaN(id))
                return res.status(400).json({ message: "Invalid employee ID" });
            const { error } = await supabaseClient_1.supabase.from("employees").delete().eq("id", id);
            if (error)
                return res.status(500).json({ message: error.message });
            res.json({ ok: true });
        }
        catch (e) {
            res.status(500).json({ message: e?.message || "Internal error" });
        }
    });
    // Employee Asset Assignments
    app.get("/api/employees/:id/assignments", async (req, res) => {
        try {
            const employeeId = Number(req.params.id);
            if (Number.isNaN(employeeId))
                return res.status(400).json({ message: "Invalid employee ID" });
            const { data, error } = await supabaseClient_1.supabase
                .from("employee_asset_assignments")
                .select(`
          *,
          batch:asset_purchase_batches(
            id,
            batch_name,
            purchase_date,
            purchase_price,
            asset:assets(id, asset_name, asset_number)
          )
        `)
                .eq("employee_id", employeeId)
                .eq("is_active", true) // Only get active assignments
                .order("assignment_date", { ascending: false });
            if (error)
                return res.status(500).json({ message: error.message });
            res.json(data || []);
        }
        catch (e) {
            res.status(500).json({ message: e?.message || "Internal error" });
        }
    });
    // Employee Asset Assignments - now requires serial_number and barcode per item
    app.post("/api/employees/:id/assignments", requireAssignPermission, async (req, res) => {
        try {
            const employeeId = Number(req.params.id);
            if (Number.isNaN(employeeId))
                return res.status(400).json({ message: "Invalid employee ID" });
            const { items, assignment_date } = req.body;
            if (!Array.isArray(items) || items.length === 0)
                return res.status(400).json({ message: "items array with at least one item is required" });
            // Validate items and check employee-specific availability
            // Employee assignments are tracked separately from station assignments
            const batchCounts = new Map();
            for (const item of items) {
                const batchId = Number(item?.batch_id);
                if (!Number.isFinite(batchId) || batchId <= 0)
                    return res.status(400).json({ message: "Each item must have a valid batch_id" });
                batchCounts.set(batchId, (batchCounts.get(batchId) || 0) + 1);
            }
            // Check employee-specific availability for each batch
            for (const [batchId, requestedCount] of batchCounts.entries()) {
                // Get batch info
                const { data: batch, error: batchError } = await supabaseClient_1.supabase
                    .from("asset_purchase_batches")
                    .select("id, quantity")
                    .eq("id", batchId)
                    .maybeSingle();
                if (batchError || !batch)
                    return res.status(404).json({ message: `Batch ${batchId} not found` });
                // Count how many items from this batch are already assigned to employees (only active)
                const { count: employeeAssignedCount, error: countError } = await supabaseClient_1.supabase
                    .from("employee_asset_assignments")
                    .select("*", { count: "exact", head: true })
                    .eq("batch_id", batchId)
                    .eq("is_active", true);
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
            const assignmentRows = items.map((item) => ({
                employee_id: employeeId,
                batch_id: Number(item.batch_id),
                serial_number: item.serial_number?.trim() || null,
                barcode: item.barcode?.trim() || null,
                assignment_date: assignmentDate,
                is_active: true, // Ensure new assignments are active
            }));
            const { data, error } = await supabaseClient_1.supabase
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
                }
                else if (error.code === '23505') { // Unique constraint violation
                    if (error.message && error.message.includes('serial_number')) {
                        errorMessage = "A serial number you entered already exists. Please use a unique serial number.";
                    }
                    else if (error.message && error.message.includes('barcode')) {
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
        }
        catch (e) {
            res.status(500).json({ message: e?.message || "Internal error" });
        }
    });
    app.delete("/api/employees/:employeeId/assignments/:assignmentId", requireAssignPermission, async (req, res) => {
        try {
            const assignmentId = Number(req.params.assignmentId);
            if (Number.isNaN(assignmentId))
                return res.status(400).json({ message: "Invalid assignment ID" });
            // Instead of deleting, mark as inactive to preserve history
            const { error } = await supabaseClient_1.supabase
                .from("employee_asset_assignments")
                .update({ is_active: false })
                .eq("id", assignmentId);
            if (error)
                return res.status(500).json({ message: error.message });
            res.json({ ok: true });
        }
        catch (e) {
            res.status(500).json({ message: e?.message || "Internal error" });
        }
    });
    // Get assignment history for a specific batch/asset
    app.get("/api/assignments/history", requireAuth, async (req, res) => {
        try {
            const { batch_id, asset_id } = req.query;
            let query = supabaseClient_1.supabase
                .from("employee_asset_assignments")
                .select(`
          id,
          employee_id,
          batch_id,
          serial_number,
          barcode,
          assignment_date,
          is_active,
          created_at,
          employee:employees(id, name, employee_id),
          batch:asset_purchase_batches(
            id,
            asset_id,
            purchase_price,
            asset:assets(id, asset_name, asset_number)
          )
        `)
                .order("assignment_date", { ascending: false });
            // Filter by batch_id if provided
            if (batch_id) {
                const batchId = Number(batch_id);
                if (!Number.isNaN(batchId)) {
                    query = query.eq("batch_id", batchId);
                }
            }
            // Filter by asset_id if provided (through batch)
            if (asset_id) {
                const assetId = Number(asset_id);
                if (!Number.isNaN(assetId)) {
                    // First get batch IDs for this asset
                    const { data: batches, error: batchError } = await supabaseClient_1.supabase
                        .from("asset_purchase_batches")
                        .select("id")
                        .eq("asset_id", assetId);
                    if (batchError)
                        return res.status(500).json({ message: batchError.message });
                    if (batches && batches.length > 0) {
                        const batchIds = batches.map((b) => b.id);
                        query = query.in("batch_id", batchIds);
                    }
                    else {
                        // No batches found, return empty
                        return res.json([]);
                    }
                }
            }
            const { data, error } = await query;
            if (error)
                return res.status(500).json({ message: error.message });
            res.json(data || []);
        }
        catch (e) {
            res.status(500).json({ message: e?.message || "Internal error" });
        }
    });
    // Transfer assets from one employee to another
    app.put("/api/employees/:fromId/transfer-assets/:toId", requireAssignPermission, async (req, res) => {
        try {
            const fromId = Number(req.params.fromId);
            const toId = Number(req.params.toId);
            if (Number.isNaN(fromId) || Number.isNaN(toId))
                return res.status(400).json({ message: "Invalid employee ID" });
            if (fromId === toId)
                return res.status(400).json({ message: "Cannot transfer assets to the same employee" });
            const { assignment_ids, transfer_date } = req.body;
            const transferDate = transfer_date ? new Date(transfer_date).toISOString() : new Date().toISOString();
            // If assignment_ids is provided, transfer only those specific assignments
            // Otherwise, transfer all assets from the source employee
            if (assignment_ids && Array.isArray(assignment_ids) && assignment_ids.length > 0) {
                // Transfer specific assignments
                const assignmentIds = assignment_ids.map((id) => Number(id)).filter((id) => !Number.isNaN(id));
                if (assignmentIds.length === 0)
                    return res.status(400).json({ message: "No valid assignment IDs provided" });
                // Get current active assignments to transfer
                // First check if assignments exist and belong to the source employee
                // Handle both is_active = true and is_active IS NULL (for records created before migration)
                const { data: currentAssignments, error: fetchError } = await supabaseClient_1.supabase
                    .from("employee_asset_assignments")
                    .select("id, batch_id, serial_number, barcode")
                    .in("id", assignmentIds)
                    .eq("employee_id", fromId)
                    .or("is_active.eq.true,is_active.is.null");
                if (fetchError)
                    return res.status(500).json({ message: fetchError.message });
                if (!currentAssignments || currentAssignments.length === 0)
                    return res.status(404).json({ message: "No active assignments found to transfer" });
                // Mark old assignments as inactive and clear serial_number/barcode to avoid unique constraint violations
                // Update both active and null is_active records
                const { error: deactivateError } = await supabaseClient_1.supabase
                    .from("employee_asset_assignments")
                    .update({
                    is_active: false,
                    serial_number: null,
                    barcode: null
                })
                    .eq("employee_id", fromId)
                    .in("id", assignmentIds)
                    .or("is_active.eq.true,is_active.is.null");
                if (deactivateError)
                    return res.status(500).json({ message: deactivateError.message });
                // Create new active assignments for the target employee
                const newAssignments = currentAssignments.map((assignment) => ({
                    employee_id: toId,
                    batch_id: assignment.batch_id,
                    serial_number: assignment.serial_number,
                    barcode: assignment.barcode,
                    assignment_date: transferDate,
                    is_active: true
                }));
                const { error: insertError } = await supabaseClient_1.supabase
                    .from("employee_asset_assignments")
                    .insert(newAssignments);
                if (insertError)
                    return res.status(500).json({ message: insertError.message });
            }
            else {
                // Transfer all assets
                // Get current active assignments (handle both is_active = true and is_active IS NULL)
                const { data: currentAssignments, error: fetchError } = await supabaseClient_1.supabase
                    .from("employee_asset_assignments")
                    .select("id, batch_id, serial_number, barcode")
                    .eq("employee_id", fromId)
                    .or("is_active.eq.true,is_active.is.null");
                if (fetchError)
                    return res.status(500).json({ message: fetchError.message });
                if (!currentAssignments || currentAssignments.length === 0)
                    return res.status(404).json({ message: "No active assignments found to transfer" });
                // Mark old assignments as inactive and clear serial_number/barcode to avoid unique constraint violations
                // Update both active and null is_active records
                const { error: deactivateError } = await supabaseClient_1.supabase
                    .from("employee_asset_assignments")
                    .update({
                    is_active: false,
                    serial_number: null,
                    barcode: null
                })
                    .eq("employee_id", fromId)
                    .or("is_active.eq.true,is_active.is.null");
                if (deactivateError)
                    return res.status(500).json({ message: deactivateError.message });
                // Create new active assignments for the target employee
                const newAssignments = currentAssignments.map((assignment) => ({
                    employee_id: toId,
                    batch_id: assignment.batch_id,
                    serial_number: assignment.serial_number,
                    barcode: assignment.barcode,
                    assignment_date: transferDate,
                    is_active: true
                }));
                const { error: insertError } = await supabaseClient_1.supabase
                    .from("employee_asset_assignments")
                    .insert(newAssignments);
                if (insertError)
                    return res.status(500).json({ message: insertError.message });
            }
            res.json({ ok: true, message: "Assets transferred successfully" });
        }
        catch (e) {
            res.status(500).json({ message: e?.message || "Internal error" });
        }
    });
    // Transfer employee from one department to another
    app.put("/api/employees/:id/transfer-department", requireAssignPermission, async (req, res) => {
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
            const { data: currentAssignment, error: fetchError } = await supabaseClient_1.supabase
                .from("employee_department_assignments")
                .select("id, department_id")
                .eq("employee_id", employeeId)
                .maybeSingle();
            if (fetchError && fetchError.code !== "PGRST116") // PGRST116 = not found
                return res.status(500).json({ message: fetchError.message });
            // If target is null, remove department assignment
            if (targetDepartmentId === null) {
                if (currentAssignment) {
                    const { error: deleteError } = await supabaseClient_1.supabase
                        .from("employee_department_assignments")
                        .delete()
                        .eq("id", currentAssignment.id);
                    if (deleteError)
                        return res.status(500).json({ message: deleteError.message });
                }
                return res.json({ ok: true, message: "Employee removed from department" });
            }
            // Check if target department exists
            const { data: dept, error: deptError } = await supabaseClient_1.supabase
                .from("departments")
                .select("id")
                .eq("id", targetDepartmentId)
                .maybeSingle();
            if (deptError)
                return res.status(500).json({ message: deptError.message });
            if (!dept)
                return res.status(404).json({ message: "Target department not found" });
            // If employee is already in this department, do nothing
            if (currentAssignment && currentAssignment.department_id === targetDepartmentId) {
                return res.json({ ok: true, message: "Employee is already in this department" });
            }
            // Remove old assignment if exists
            if (currentAssignment) {
                const { error: deleteError } = await supabaseClient_1.supabase
                    .from("employee_department_assignments")
                    .delete()
                    .eq("id", currentAssignment.id);
                if (deleteError)
                    return res.status(500).json({ message: deleteError.message });
            }
            // Create new assignment
            const { error: insertError } = await supabaseClient_1.supabase
                .from("employee_department_assignments")
                .insert([{
                    employee_id: employeeId,
                    department_id: targetDepartmentId,
                    assigned_at: new Date().toISOString(),
                }]);
            if (insertError)
                return res.status(500).json({ message: insertError.message });
            res.json({ ok: true, message: "Employee transferred successfully" });
        }
        catch (e) {
            res.status(500).json({ message: e?.message || "Internal error" });
        }
    });
    // ---------------- DEPARTMENTS ----------------
    app.get("/api/departments", async (_req, res) => {
        try {
            const { data: departments, error } = await supabaseClient_1.supabase
                .from("departments")
                .select("*")
                .order("name", { ascending: true });
            if (error)
                return res.status(500).json({ message: error.message });
            // Get employee counts and total asset value for each department
            const departmentsWithCounts = await Promise.all((departments || []).map(async (dept) => {
                // Get employee count
                const { count, error: countError } = await supabaseClient_1.supabase
                    .from("employee_department_assignments")
                    .select("*", { count: "exact", head: true })
                    .eq("department_id", dept.id);
                const employeeCount = countError ? 0 : (count || 0);
                // Calculate total asset value from employee asset assignments
                let totalAssetValue = 0;
                if (employeeCount > 0) {
                    // Get all employees in this department
                    const { data: departmentEmployees, error: empError } = await supabaseClient_1.supabase
                        .from("employee_department_assignments")
                        .select("employee_id")
                        .eq("department_id", dept.id);
                    if (!empError && departmentEmployees && departmentEmployees.length > 0) {
                        const employeeIds = departmentEmployees.map((de) => de.employee_id);
                        // Get all employee asset assignments for these employees
                        const { data: employeeAssignments, error: assignError } = await supabaseClient_1.supabase
                            .from("employee_asset_assignments")
                            .select("batch_id")
                            .in("employee_id", employeeIds);
                        if (!assignError && employeeAssignments && employeeAssignments.length > 0) {
                            // Get unique batch IDs
                            const batchIds = Array.from(new Set(employeeAssignments.map((ea) => ea.batch_id).filter((id) => id != null)));
                            if (batchIds.length > 0) {
                                // Get purchase prices for these batches
                                const { data: batches, error: batchError } = await supabaseClient_1.supabase
                                    .from("asset_purchase_batches")
                                    .select("id, purchase_price")
                                    .in("id", batchIds);
                                if (!batchError && batches) {
                                    // Create a map of batch_id to purchase_price
                                    const batchPriceMap = new Map();
                                    batches.forEach((b) => {
                                        batchPriceMap.set(b.id, Number(b.purchase_price || 0));
                                    });
                                    // Sum up the purchase prices for all employee assignments
                                    employeeAssignments.forEach((ea) => {
                                        const price = batchPriceMap.get(ea.batch_id) || 0;
                                        totalAssetValue += price;
                                    });
                                }
                            }
                        }
                    }
                }
                return {
                    ...dept,
                    employeeCount,
                    totalAssetValue,
                };
            }));
            res.json(departmentsWithCounts);
        }
        catch (e) {
            res.status(500).json({ message: e?.message || "Internal error" });
        }
    });
    app.get("/api/departments/:id", async (req, res) => {
        try {
            const id = Number(req.params.id);
            if (Number.isNaN(id))
                return res.status(400).json({ message: "Invalid department ID" });
            const { data, error } = await supabaseClient_1.supabase
                .from("departments")
                .select(`
          *,
          employees:employee_department_assignments(
            employee:employees(id, name, employee_id)
          )
        `)
                .eq("id", id)
                .maybeSingle();
            if (error)
                return res.status(500).json({ message: error.message });
            if (!data)
                return res.status(404).json({ message: "Department not found" });
            res.json(data);
        }
        catch (e) {
            res.status(500).json({ message: e?.message || "Internal error" });
        }
    });
    app.post("/api/departments", requireAdminPermission, async (req, res) => {
        try {
            const { name, manager } = req.body;
            if (!name || typeof name !== "string" || !name.trim())
                return res.status(400).json({ message: "Department name is required" });
            if (!manager || typeof manager !== "string" || !manager.trim())
                return res.status(400).json({ message: "Manager name is required" });
            const { data, error } = await supabaseClient_1.supabase
                .from("departments")
                .insert([{ name: name.trim(), manager: manager.trim() }])
                .select("*")
                .maybeSingle();
            if (error)
                return res.status(500).json({ message: error.message });
            res.json(data);
        }
        catch (e) {
            res.status(500).json({ message: e?.message || "Internal error" });
        }
    });
    app.put("/api/departments/:id", requireAdminPermission, async (req, res) => {
        try {
            const id = Number(req.params.id);
            if (Number.isNaN(id))
                return res.status(400).json({ message: "Invalid department ID" });
            const { name, manager } = req.body;
            const updateData = {};
            if (name !== undefined)
                updateData.name = name?.trim() || null;
            if (manager !== undefined)
                updateData.manager = manager?.trim() || null;
            if (Object.keys(updateData).length === 0)
                return res.status(400).json({ message: "No fields to update" });
            const { data, error } = await supabaseClient_1.supabase
                .from("departments")
                .update(updateData)
                .eq("id", id)
                .select("*")
                .maybeSingle();
            if (error)
                return res.status(500).json({ message: error.message });
            if (!data)
                return res.status(404).json({ message: "Department not found" });
            res.json(data);
        }
        catch (e) {
            res.status(500).json({ message: e?.message || "Internal error" });
        }
    });
    app.delete("/api/departments/:id", requireAdminPermission, async (req, res) => {
        try {
            const id = Number(req.params.id);
            if (Number.isNaN(id))
                return res.status(400).json({ message: "Invalid department ID" });
            const { error } = await supabaseClient_1.supabase.from("departments").delete().eq("id", id);
            if (error)
                return res.status(500).json({ message: error.message });
            res.json({ ok: true });
        }
        catch (e) {
            res.status(500).json({ message: e?.message || "Internal error" });
        }
    });
    // Department Employee Assignments
    app.get("/api/departments/:id/employees", async (req, res) => {
        try {
            const departmentId = Number(req.params.id);
            if (Number.isNaN(departmentId))
                return res.status(400).json({ message: "Invalid department ID" });
            const { data, error } = await supabaseClient_1.supabase
                .from("employee_department_assignments")
                .select(`
          *,
          employee:employees(id, name, employee_id)
        `)
                .eq("department_id", departmentId)
                .order("assigned_at", { ascending: false });
            if (error)
                return res.status(500).json({ message: error.message });
            res.json(data || []);
        }
        catch (e) {
            res.status(500).json({ message: e?.message || "Internal error" });
        }
    });
    app.post("/api/departments/:id/employees", requireAssignPermission, async (req, res) => {
        try {
            const departmentId = Number(req.params.id);
            if (Number.isNaN(departmentId))
                return res.status(400).json({ message: "Invalid department ID" });
            const { employee_id } = req.body;
            if (!employee_id)
                return res.status(400).json({ message: "employee_id is required" });
            const { data, error } = await supabaseClient_1.supabase
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
        }
        catch (e) {
            res.status(500).json({ message: e?.message || "Internal error" });
        }
    });
    app.delete("/api/departments/:departmentId/employees/:assignmentId", requireAssignPermission, async (req, res) => {
        try {
            const assignmentId = Number(req.params.assignmentId);
            if (Number.isNaN(assignmentId))
                return res.status(400).json({ message: "Invalid assignment ID" });
            const { error } = await supabaseClient_1.supabase
                .from("employee_department_assignments")
                .delete()
                .eq("id", assignmentId);
            if (error)
                return res.status(500).json({ message: error.message });
            res.json({ ok: true });
        }
        catch (e) {
            res.status(500).json({ message: e?.message || "Internal error" });
        }
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
            if (result.error) {
                console.error("Error hydrating assets:", result.error);
                console.error("Error details:", JSON.stringify(result.error, null, 2));
                return res.status(500).json({ message: result.error.message || "Failed to hydrate assets" });
            }
            if (!result.data) {
                console.error("hydrateAssets returned null data");
                return res.status(500).json({ message: "Failed to load assets data" });
            }
            return res.json(result.data || []);
        }
        catch (e) {
            return res
                .status(500)
                .json({ message: e?.message || "Internal error" });
        }
    });
    // ✅ CREATE ASSET — supports asset_value and purchase batches
    app.post("/api/assets", requireAdminPermission, async (req, res) => {
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
    app.put("/api/assets/:id", requireAdminPermission, async (req, res) => {
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
        }
        catch (e) {
            res
                .status(500)
                .json({ message: e?.message || "Internal error updating asset" });
        }
    });
    // DELETE ASSET
    app.delete("/api/assets/:id", requireAdminPermission, async (req, res) => {
        try {
            const id = Number(req.params.id);
            if (Number.isNaN(id))
                return res.status(400).json({ message: "Invalid ID" });
            // DB schema has ON DELETE CASCADE, so this automatically 
            // removes related assignments and batches.
            const { error } = await supabaseClient_1.supabase.from("assets").delete().eq("id", id);
            if (error)
                return res.status(500).json({ message: error.message });
            res.status(204).send();
        }
        catch (e) {
            res.status(500).json({ message: e?.message || "Internal error" });
        }
    });
    // ASSIGN
    app.put("/api/assets/:id/assign", requireAssignPermission, async (req, res) => {
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
                // Get existing assignments to understand current state
                const { data: existingAssignments, error: existingError } = await supabaseClient_1.supabase
                    .from("asset_assignments")
                    .select("id, pump_id")
                    .eq("asset_id", id);
                if (existingError)
                    return res.status(500).json({ message: existingError.message });
                // Get existing allocations to count current items per pump
                const existingAssignmentIds = (existingAssignments || []).map((a) => a.id);
                const { data: existingAllocations } = existingAssignmentIds.length > 0
                    ? await supabaseClient_1.supabase
                        .from("assignment_batch_allocations")
                        .select("assignment_id, batch_id")
                        .in("assignment_id", existingAssignmentIds)
                    : { data: [] };
                // Count current items per pump
                const merged = new Map();
                (existingAssignments || []).forEach((row) => {
                    const itemCount = (existingAllocations || []).filter((alloc) => alloc.assignment_id === row.id).length;
                    merged.set(row.pump_id, itemCount);
                });
                if (quantity == null || quantity <= 0) {
                    merged.delete(pumpId);
                }
                else {
                    merged.set(pumpId, quantity);
                }
                // Convert to new format: for each pump, we need to auto-allocate items from batches
                // Since we don't have batch info in legacy format, we'll need to fetch available batches
                // and auto-allocate (FIFO) for the requested quantities
                const { data: availableBatches } = await supabaseClient_1.supabase
                    .from("asset_purchase_batches")
                    .select("id, remaining_quantity")
                    .eq("asset_id", id)
                    .gt("remaining_quantity", 0)
                    .order("purchase_date", { ascending: true });
                nextAssignments = await Promise.all(Array.from(merged.entries()).map(async ([pump_id, requestedQty]) => {
                    const items = [];
                    let remaining = requestedQty;
                    // Auto-allocate from batches (FIFO)
                    if (availableBatches) {
                        for (const batch of availableBatches) {
                            if (remaining <= 0)
                                break;
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
            const { pump_id, category_id, employee_id } = req.query;
            const pumpIdParam = pump_id ?? "";
            const parsedPumpId = pumpIdParam &&
                pumpIdParam !== "all" &&
                pumpIdParam !== "null" &&
                pumpIdParam !== "undefined"
                ? Number(pumpIdParam)
                : null;
            const pumpFilter = parsedPumpId != null && !Number.isNaN(parsedPumpId) ? parsedPumpId : null;
            const hasPumpFilter = pumpFilter != null;
            // Parse employee filter
            const employeeIdParam = employee_id ?? "";
            const parsedEmployeeId = employeeIdParam &&
                employeeIdParam !== "all" &&
                employeeIdParam !== "null" &&
                employeeIdParam !== "undefined"
                ? Number(employeeIdParam)
                : null;
            const employeeFilter = parsedEmployeeId != null && !Number.isNaN(parsedEmployeeId) ? parsedEmployeeId : null;
            const hasEmployeeFilter = employeeFilter != null;
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
            // 1b. Pre-filter assets IDs if an employee is selected
            if (hasEmployeeFilter) {
                // Get batch IDs assigned to this employee (only active)
                const { data: employeeAssignments, error: empError } = await supabaseClient_1.supabase
                    .from("employee_asset_assignments")
                    .select("batch_id")
                    .eq("employee_id", employeeFilter)
                    .eq("is_active", true);
                if (empError)
                    return res.status(500).json({ message: empError.message });
                if (!employeeAssignments || employeeAssignments.length === 0)
                    return res.json([]);
                const batchIds = Array.from(new Set(employeeAssignments.map((a) => a.batch_id)));
                // Get asset IDs from these batches
                const { data: batchRows, error: batchError } = await supabaseClient_1.supabase
                    .from("asset_purchase_batches")
                    .select("asset_id")
                    .in("id", batchIds);
                if (batchError)
                    return res.status(500).json({ message: batchError.message });
                const employeeAssetIds = Array.from(new Set((batchRows || []).map((row) => row.asset_id)));
                // Combine with existing filter if any
                if (filteredAssetIds) {
                    filteredAssetIds = filteredAssetIds.filter((id) => employeeAssetIds.includes(id));
                }
                else {
                    filteredAssetIds = employeeAssetIds;
                }
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
            if (hydrated.error) {
                console.error("Error hydrating assets in assets-by-category report:", hydrated.error);
                return res.status(500).json({ message: hydrated.error.message || "Failed to hydrate assets" });
            }
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
            if (hydrated.error) {
                console.error("Error hydrating assets in reports:", hydrated.error);
                return res.status(500).json({ message: hydrated.error.message || "Failed to hydrate assets" });
            }
            return res.json(hydrated.data || []);
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
            // Get employee assignment counts per batch
            const batchIds = (data || []).map((b) => b.id);
            let employeeAssignmentCounts = new Map();
            if (batchIds.length > 0) {
                const { data: employeeAssignments } = await supabaseClient_1.supabase
                    .from("employee_asset_assignments")
                    .select("batch_id, is_active")
                    .in("batch_id", batchIds)
                    .eq("is_active", true); // Only count active assignments
                if (employeeAssignments) {
                    employeeAssignments.forEach((assignment) => {
                        // Only count active assignments
                        if (assignment.is_active !== false) {
                            const count = employeeAssignmentCounts.get(assignment.batch_id) || 0;
                            employeeAssignmentCounts.set(assignment.batch_id, count + 1);
                        }
                    });
                }
            }
            // Enrich batches with employee assignment counts
            const enrichedBatches = (data || []).map((batch) => {
                const employeeAssignedCount = employeeAssignmentCounts.get(batch.id) || 0;
                const employeeRemainingQuantity = Number(batch.quantity) - employeeAssignedCount;
                return {
                    ...batch,
                    employee_assigned_count: employeeAssignedCount,
                    employee_remaining_quantity: employeeRemainingQuantity,
                };
            });
            return res.json(enrichedBatches);
        }
        catch (e) {
            return res.status(500).json({ message: e?.message || "Internal error" });
        }
    });
    // Add new batch (inventory) to existing asset
    app.post("/api/assets/:id/batches", requireAdminPermission, async (req, res) => {
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
            // Create batch (serial_number and barcode are now tracked at assignment level)
            const { data: batch, error: batchError } = await createPurchaseBatch(id, Number(purchase_price), Number(quantity), purchase_date ? new Date(purchase_date) : undefined, remarks || null, normalizedBatchName);
            if (batchError)
                return res.status(500).json({ message: batchError.message });
            return res.status(201).json(batch);
        }
        catch (e) {
            return res.status(500).json({ message: e?.message || "Internal error" });
        }
    });
    // Update batch
    app.put("/api/assets/:assetId/batches/:batchId", requireAdminPermission, async (req, res) => {
        try {
            const assetId = Number(req.params.assetId);
            const batchId = Number(req.params.batchId);
            if (Number.isNaN(assetId) || Number.isNaN(batchId))
                return res.status(400).json({ message: "Invalid IDs" });
            const { purchase_price, purchase_date, batch_name } = req.body;
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
            if (batch_name != null) {
                updateData.batch_name = batch_name?.trim() || null;
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
            return res.json(updated);
        }
        catch (e) {
            return res.status(500).json({ message: e?.message || "Internal error" });
        }
    });
    // Delete batch (only if not used)
    app.delete("/api/assets/:assetId/batches/:batchId", requireAdminPermission, async (req, res) => {
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
    // ---------------- ACCOUNTS MANAGEMENT (Admin Only) ----------------
    // Get all users (admin only)
    app.get("/api/accounts", requireRole(['admin']), async (_req, res) => {
        try {
            const { data, error } = await supabaseClient_1.supabase
                .from("users")
                .select("id, username, role, created_at")
                .order("created_at", { ascending: false });
            if (error)
                return res.status(500).json({ message: error.message });
            res.json(data || []);
        }
        catch (e) {
            res.status(500).json({ message: e?.message || "Internal error" });
        }
    });
    // Create new user account (admin only)
    app.post("/api/accounts", requireRole(['admin']), async (req, res) => {
        try {
            const { username, password, role } = req.body;
            console.log("[ACCOUNT CREATION] Request body:", { username, role, passwordLength: password?.length });
            if (!username || !password) {
                return res.status(400).json({ message: "Username and password are required" });
            }
            if (!role || !['admin', 'viewing_user', 'assigning_user'].includes(role)) {
                console.error("[ACCOUNT CREATION] Invalid role provided:", role);
                return res.status(400).json({ message: "Valid role is required (admin, viewing_user, assigning_user)" });
            }
            // Check if username already exists
            const { data: existingUser } = await supabaseClient_1.supabase
                .from("users")
                .select("id, username, role")
                .eq("username", username)
                .maybeSingle();
            if (existingUser) {
                console.error("[ACCOUNT CREATION] Username already exists:", username);
                return res.status(400).json({ message: "Username already exists" });
            }
            // Create user with plain password (stored as hash in DB, but we're storing plain for simplicity)
            // In production, you should hash passwords properly
            const insertData = {
                username: username.trim(),
                password_hash: password, // In production, hash this with bcrypt
                role: role.trim(), // Ensure role is trimmed
            };
            console.log("[ACCOUNT CREATION] Inserting user with data:", { username: insertData.username, role: insertData.role });
            const { data, error } = await supabaseClient_1.supabase
                .from("users")
                .insert([insertData])
                .select("id, username, role, created_at")
                .maybeSingle();
            if (error) {
                console.error("[ACCOUNT CREATION] Database error:", error);
                return res.status(500).json({ message: error.message });
            }
            if (!data) {
                console.error("[ACCOUNT CREATION] No data returned from insert");
                return res.status(500).json({ message: "Failed to create account" });
            }
            console.log("[ACCOUNT CREATION] Successfully created user:", { id: data.id, username: data.username, role: data.role });
            res.status(201).json(data);
        }
        catch (e) {
            console.error("[ACCOUNT CREATION] Exception:", e);
            res.status(500).json({ message: e?.message || "Internal error" });
        }
    });
    // Verify user account role (for debugging - admin only)
    app.get("/api/accounts/verify/:username", requireRole(['admin']), async (req, res) => {
        try {
            const { username } = req.params;
            const { data, error } = await supabaseClient_1.supabase
                .from("users")
                .select("id, username, role, created_at")
                .eq("username", username)
                .maybeSingle();
            if (error) {
                return res.status(500).json({ message: error.message });
            }
            if (!data) {
                return res.status(404).json({ message: "User not found" });
            }
            res.json({
                user: data,
                roleCheck: {
                    isAdmin: data.role === 'admin',
                    isViewingUser: data.role === 'viewing_user',
                    isAssigningUser: data.role === 'assigning_user',
                    isValidRole: ['admin', 'viewing_user', 'assigning_user'].includes(data.role)
                }
            });
        }
        catch (e) {
            res.status(500).json({ message: e?.message || "Internal error" });
        }
    });
    // Delete user account (admin only)
    app.delete("/api/accounts/:id", requireRole(['admin']), async (req, res) => {
        try {
            const id = Number(req.params.id);
            if (Number.isNaN(id)) {
                return res.status(400).json({ message: "Invalid user ID" });
            }
            // Prevent deleting yourself
            const currentUser = req.user;
            if (currentUser && currentUser.id === id) {
                return res.status(400).json({ message: "Cannot delete your own account" });
            }
            const { error } = await supabaseClient_1.supabase
                .from("users")
                .delete()
                .eq("id", id);
            if (error)
                return res.status(500).json({ message: error.message });
            res.status(204).send();
        }
        catch (e) {
            res.status(500).json({ message: e?.message || "Internal error" });
        }
    });
}
