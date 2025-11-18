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
        const merged = new Map();
        input.forEach((item) => {
            const pumpId = Number(item?.pump_id);
            const qty = Number(item?.quantity);
            if (!Number.isFinite(pumpId) || pumpId <= 0)
                return;
            if (!Number.isFinite(qty) || qty <= 0)
                return;
            merged.set(pumpId, (merged.get(pumpId) || 0) + qty);
        });
        return Array.from(merged.entries()).map(([pump_id, quantity]) => ({
            pump_id,
            quantity,
        }));
    };
    const sumAssignmentQuantity = (assignments) => assignments.reduce((total, assignment) => total + assignment.quantity, 0);
    const hydrateAssets = async (assets) => {
        if (!assets || assets.length === 0)
            return { data: [], error: null };
        const assetIds = assets.map((a) => a.id);
        const [{ data: cats, error: catError }, { data: pumps, error: pumpError }, { data: assignmentRows, error: assignmentError },] = await Promise.all([
            supabaseClient_1.supabase.from("categories").select("id, name"),
            supabaseClient_1.supabase.from("pumps").select("id, name"),
            supabaseClient_1.supabase
                .from("asset_assignments")
                .select("id, asset_id, pump_id, quantity, pumps(name)")
                .in("asset_id", assetIds),
        ]);
        if (catError || pumpError || assignmentError) {
            return { data: null, error: catError || pumpError || assignmentError };
        }
        const catMap = new Map((cats || []).map((c) => [c.id, c.name]));
        const pumpMap = new Map((pumps || []).map((p) => [p.id, p.name]));
        const assignmentsByAsset = new Map();
        (assignmentRows || []).forEach((row) => {
            const collection = assignmentsByAsset.get(row.asset_id) || [];
            collection.push({
                id: row.id,
                asset_id: row.asset_id,
                pump_id: row.pump_id,
                quantity: row.quantity,
                pump_name: row.pumps?.name ?? pumpMap.get(row.pump_id) ?? null,
            });
            assignmentsByAsset.set(row.asset_id, collection);
        });
        const hydrated = assets.map((asset) => {
            const assignmentList = assignmentsByAsset.get(asset.id) || [];
            const unitValue = Number(asset.asset_value) || 0;
            const totalAssigned = assignmentList.reduce((total, assignment) => total + (assignment.quantity || 0), 0);
            const totalAssignedValue = totalAssigned * unitValue;
            const totalValue = asset.quantity == null ? null : (asset.quantity || 0) * unitValue;
            const remainingQuantity = asset.quantity == null
                ? null
                : Math.max((asset.quantity || 0) - totalAssigned, 0);
            const remainingValue = remainingQuantity == null ? null : remainingQuantity * unitValue;
            const enrichedAssignments = assignmentList.map((assignment) => ({
                ...assignment,
                assignment_value: assignment.assignment_value ??
                    (Number(assignment.quantity || 0) * unitValue),
            }));
            return {
                ...asset,
                asset_value: unitValue,
                assignments: enrichedAssignments,
                totalAssigned,
                totalAssignedValue,
                totalValue,
                remainingQuantity,
                remainingValue,
                categoryName: asset.category_id
                    ? catMap.get(asset.category_id) ?? null
                    : null,
                pumpName: enrichedAssignments[0]?.pump_name ?? null,
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
        const { error: deleteError } = await supabaseClient_1.supabase
            .from("asset_assignments")
            .delete()
            .eq("asset_id", assetId);
        if (deleteError)
            return { error: deleteError };
        if (assignments.length === 0)
            return { error: null };
        const rows = assignments.map((assignment) => ({
            asset_id: assetId,
            pump_id: assignment.pump_id,
            quantity: assignment.quantity,
        }));
        const { error } = await supabaseClient_1.supabase.from("asset_assignments").insert(rows);
        return { error };
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
        res.cookie(TOKEN_COOKIE_NAME, token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production", // must be https in prod
            sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
            domain: ".azharalibuttar.com", // ✅ share across apex + www
            maxAge: TOKEN_MAX_AGE,
            path: "/",
        });
        return res.json({ ok: true });
    });
    app.post("/api/logout", (_req, res) => {
        res.clearCookie(TOKEN_COOKIE_NAME, { path: "/" });
        res.json({ ok: true });
    });
    app.get("/api/me", async (req, res) => {
        const token = req.cookies?.[TOKEN_COOKIE_NAME];
        if (!token)
            return res.status(401).json({ authenticated: false });
        try {
            const decoded = jsonwebtoken_1.default.verify(token, JWT_SECRET);
            const { data, error } = await supabaseClient_1.supabase
                .from("users")
                .select("id, username")
                .eq("id", decoded.userId)
                .maybeSingle();
            if (error || !data)
                return res.status(401).json({ authenticated: false });
            return res.json({ authenticated: true, user: data });
        }
        catch {
            return res.status(401).json({ authenticated: false });
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
            const pumpFilter = pump_id != null && pump_id !== "" ? Number(pump_id) : null;
            let filteredAssetIds = null;
            if (pumpFilter) {
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
    // ✅ CREATE ASSET — supports asset_value
    app.post("/api/assets", async (req, res) => {
        try {
            const b = req.body || {};
            const asset_name = b.asset_name ?? b.assetName ?? null;
            const asset_number = b.asset_number ?? b.assetNumber ?? null;
            const serial_number = b.serial_number ?? b.serialNumber ?? null;
            const barcode = b.barcode ?? null;
            const quantity = b.quantity == null ? null : Number.isNaN(Number(b.quantity)) ? null : Number(b.quantity);
            const units = b.units ?? null;
            const remarks = b.remarks ?? null;
            const category_id = b.category_id ?? b.categoryId ?? null;
            const asset_value = b.asset_value ? Number(b.asset_value) : 0;
            const assignments = sanitizeAssignments(b.assignments);
            const { data, error } = await supabaseClient_1.supabase
                .from("assets")
                .insert([
                {
                    asset_name,
                    asset_number,
                    serial_number,
                    barcode,
                    quantity,
                    units,
                    remarks,
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
            if (assignments.length > 0) {
                const capacityCheck = await ensureCapacity(data.id, quantity ?? 0, assignments);
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
            const pumpFilter = pump_id != null && pump_id !== "" ? Number(pump_id) : null;
            let filteredAssetIds = null;
            if (pumpFilter) {
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
            let assetQuery = supabaseClient_1.supabase
                .from("assets")
                .select("*")
                .order("category_id", { ascending: true });
            if (category_id)
                assetQuery = assetQuery.eq("category_id", category_id);
            if (filteredAssetIds)
                assetQuery = assetQuery.in("id", filteredAssetIds);
            const { data, error } = await assetQuery;
            if (error)
                return res.status(500).json({ message: error.message });
            const hydrated = await hydrateAssets(data || []);
            if (hydrated.error)
                return res.status(500).json({ message: hydrated.error.message });
            const filteredAssets = (hydrated.data || []).filter((asset) => {
                if (category_id)
                    return asset.category_id === category_id;
                if (filteredAssetIds)
                    return filteredAssetIds.includes(asset.id);
                return true;
            });
            const flattened = filteredAssets.flatMap((asset) => {
                const assignments = pumpFilter != null
                    ? (asset.assignments || []).filter((assignment) => Number(assignment.pump_id) === Number(pumpFilter))
                    : asset.assignments || [];
                const limitedAsset = pumpFilter != null ? { ...asset, assignments } : asset;
                if (!assignments.length) {
                    if (pumpFilter != null)
                        return [];
                    return [
                        {
                            ...limitedAsset,
                            assignmentQuantity: 0,
                            pump_id: null,
                            pumpName: null,
                            assignmentValue: 0,
                        },
                    ];
                }
                return assignments.map((assignment) => ({
                    ...limitedAsset,
                    assignmentQuantity: assignment.quantity,
                    pump_id: assignment.pump_id,
                    pumpName: assignment.pump_name,
                    assignmentValue: assignment.assignment_value ??
                        Number(assignment.quantity || 0) *
                            (Number(limitedAsset.asset_value) || 0),
                }));
            });
            const responsePayload = pumpFilter != null
                ? flattened.filter((row) => Number(row.pump_id) === Number(pumpFilter))
                : flattened;
            return res.json(responsePayload);
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
}
