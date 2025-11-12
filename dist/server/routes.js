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
        // ✅ FIXED COOKIE SETTINGS (persistent across refreshes)
        res.cookie(TOKEN_COOKIE_NAME, token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production" ? true : false, // ✅ allow in dev
            sameSite: process.env.NODE_ENV === "production" ? "none" : "lax", // ✅ proper cookie behavior
            maxAge: TOKEN_MAX_AGE, // 7 days
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
            const { data: assets } = await supabaseClient_1.supabase.from("assets").select("pump_id");
            const assetCountMap = new Map();
            (assets || []).forEach((a) => {
                if (a.pump_id)
                    assetCountMap.set(a.pump_id, (assetCountMap.get(a.pump_id) || 0) + 1);
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
            const { data: assets, error: assetError } = await supabaseClient_1.supabase
                .from("assets")
                .select("id")
                .eq("pump_id", id);
            if (assetError)
                return res.status(500).json({ message: assetError.message });
            if (assets && assets.length > 0) {
                return res
                    .status(400)
                    .json({
                    message: "Cannot delete this pump because assets are assigned to it.",
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
            let query = supabaseClient_1.supabase
                .from("assets")
                .select("*")
                .order("id", { ascending: false });
            if (pump_id != null && pump_id !== "")
                query = query.eq("pump_id", Number(pump_id));
            if (category_id != null && category_id !== "")
                query = query.eq("category_id", category_id);
            const { data, error } = await query;
            if (error)
                return res.status(500).json({ message: error.message });
            const [{ data: cats }, { data: pumps }] = await Promise.all([
                supabaseClient_1.supabase.from("categories").select("id, name"),
                supabaseClient_1.supabase.from("pumps").select("id, name"),
            ]);
            const cmap = new Map((cats || []).map((c) => [c.id, c.name]));
            const pmap = new Map((pumps || []).map((p) => [p.id, p.name]));
            const withNames = (data || []).map((a) => ({
                ...a,
                categoryName: a.category_id ? cmap.get(a.category_id) : null,
                pumpName: a.pump_id ? pmap.get(a.pump_id) : null,
            }));
            return res.json(withNames);
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
            const quantity = b.quantity ? Number(b.quantity) : null;
            const units = b.units ?? null;
            const remarks = b.remarks ?? null;
            const category_id = b.category_id ?? b.categoryId ?? null;
            const pump_id = b.pump_id ?? b.pumpId ?? null;
            const asset_value = b.asset_value ? Number(b.asset_value) : 0;
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
                    pump_id,
                    asset_value,
                },
            ])
                .select("*")
                .maybeSingle();
            if (error)
                return res.status(400).json({ message: "DB insert error", error });
            return res.status(201).json(data);
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
                payload.quantity = b.quantity == null ? null : Number(b.quantity);
            if ("units" in b)
                payload.units = b.units ?? null;
            if ("remarks" in b)
                payload.remarks = b.remarks ?? null;
            if ("categoryId" in b || "category_id" in b)
                payload.category_id = b.category_id ?? b.categoryId ?? null;
            if ("pumpId" in b || "pump_id" in b)
                payload.pump_id = b.pump_id == null ? null : Number(b.pump_id);
            if ("asset_value" in b)
                payload.asset_value = Number(b.asset_value) || 0;
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
            res.json(data);
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
            const { pump_id = null, category_id = null } = req.body || {};
            const { data, error } = await supabaseClient_1.supabase
                .from("assets")
                .update({
                pump_id: pump_id == null ? null : Number(pump_id),
                category_id: category_id || null,
            })
                .eq("id", id)
                .select("*")
                .maybeSingle();
            if (error)
                return res.status(500).json({ message: error.message });
            res.json(data);
        }
        catch (e) {
            res
                .status(500)
                .json({ message: e?.message || "Internal error assigning asset" });
        }
    });
    // REPORTS
    app.get("/api/reports/assets-by-category", async (_req, res) => {
        const { data, error } = await supabaseClient_1.supabase
            .from("assets")
            .select("id, asset_name, category_id, pump_id")
            .order("category_id", { ascending: true });
        if (error)
            return res.status(500).json({ message: error.message });
        return res.json(data);
    });
    app.get("/api/reports/all-assets", async (_req, res) => {
        const { data, error } = await supabaseClient_1.supabase
            .from("assets")
            .select("*")
            .order("id", { ascending: false });
        if (error)
            return res.status(500).json({ message: error.message });
        const [{ data: cats }, { data: pumps }] = await Promise.all([
            supabaseClient_1.supabase.from("categories").select("id, name"),
            supabaseClient_1.supabase.from("pumps").select("id, name"),
        ]);
        const cmap = new Map((cats || []).map((c) => [c.id, c.name]));
        const pmap = new Map((pumps || []).map((p) => [p.id, p.name]));
        const withNames = (data || []).map((a) => ({
            ...a,
            categoryName: a.category_id ? cmap.get(a.category_id) : null,
            pumpName: a.pump_id ? pmap.get(a.pump_id) : null,
        }));
        return res.json(withNames);
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
