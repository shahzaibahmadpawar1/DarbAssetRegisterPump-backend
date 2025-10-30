"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerRoutes = registerRoutes;
const supabaseClient_1 = require("./supabaseClient");
const jwt = require("jsonwebtoken"); // added for JWT issuance
function registerRoutes(app) {
    // AUTH
    app.post("/api/login", async (req, res) => {
        console.log("Login attempt:", req.body);
        const { username, password } = req.body;
        console.log("Received credentials:", username, password);
        if (!username || !password) {
            return res.status(400).json({ message: "Missing credentials" });
        }
        // Fetch user from Supabase
        const { data: user, error } = await supabaseClient_1.supabase
            .from("users")
            .select("id, password_hash") // 👈 make sure column name matches your Supabase schema
            .eq("username", username)
            .single();
        if (error || !user) {
            console.log("User not found or query error:", error);
            return res.status(401).json({ message: "Invalid credentials" });
        }
        console.log(user);
        // ✅ Compare plain passwords directly
        if (user.password_hash !== password) {
            console.log("Password mismatch");
            return res.status(401).json({ message: "Invalid credentials" });
        }
        // ✅ Save session
        req.session.userId = user.id;
        // ✅ Issue JWT cookie (minimal change)
        try {
            const JWT_SECRET = process.env.JWT_SECRET || "replace-with-secure-secret";
            const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: "7d" });
            // set cookie named 'token'
            res.cookie("token", token, {
                httpOnly: true,
                sameSite: "lax",
                secure: process.env.NODE_ENV === "production",
                maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
            });
        }
        catch (jwtErr) {
            console.error("JWT sign error:", jwtErr);
            // don't fail login because of cookie issue; still return login success but log error
        }
        console.log("Login successful for user:", username);
        return res.json({ ok: true });
    });

    app.post("/api/logout", (req, res) => {
        req.session.destroy(() => {
            // clear JWT cookie as well
            try {
                res.clearCookie("token");
            }
            catch (e) {
                // ignore cookie clearing errors
            }
            res.json({ ok: true });
        });
    });

    // NEW minimal endpoint: return authenticated status based on JWT or session
    app.get("/api/me", async (req, res) => {
        try {
            const userId = req.user?.userId ?? req.session?.userId;
            if (!userId) return res.status(401).json({ authenticated: false });
            const { data, error } = await supabaseClient_1.supabase.from("users").select("id, username").eq("id", userId).maybeSingle();
            if (error) {
                console.error("GET /api/me DB error:", error);
                return res.status(500).json({ message: "Database error" });
            }
            return res.json({ authenticated: true, user: data });
        }
        catch (err) {
            console.error("GET /api/me error:", err);
            return res.status(500).json({ message: "Internal server error" });
        }
    });

    // ... rest of the file unchanged ...
    // (then the pumps and assets routes exactly as you had them)
    // PUMPS
    app.get("/api/pumps", async (_req, res) => {
        const { data, error } = await supabaseClient_1.supabase
            .from("pumps")
            .select("*")
            .order("id", { ascending: false });
        if (error)
            return res.status(500).json({ message: error.message });
        return res.json(data);
    });
    app.post("/api/pumps", async (req, res) => {
        const { name, location, manager } = req.body;
        if (!name || !location || !manager) {
            return res.status(400).json({ message: "Missing fields" });
        }
        const { data, error } = await supabaseClient_1.supabase
            .from("pumps")
            .insert([{ name, location, manager }])
            .select("*")
            .single();
        if (error)
            return res.status(500).json({ message: error.message });
        return res.status(201).json(data);
    });
    app.put("/api/pumps/:id", async (req, res) => {
        const { id } = req.params;
        const { name, location, manager } = req.body;
        const { data, error } = await supabaseClient_1.supabase
            .from("pumps")
            .update({ name, location, manager })
            .eq("id", id)
            .select("*")
            .single();
        if (error)
            return res.status(500).json({ message: error.message });
        return res.json(data);
    });
    app.delete("/api/pumps/:id", async (req, res) => {
        const { id } = req.params;
        const { error } = await supabaseClient_1.supabase
            .from("pumps")
            .delete()
            .eq("id", id);
        if (error)
            return res.status(500).json({ message: error.message });
        return res.json({ ok: true });
    });
    // ASSETS
    app.get("/api/assets/pump/:pumpId", async (req, res) => {
        const { pumpId } = req.params;
        // NOTE: DB column is camelCase `pumpId` — use that
        const { data, error } = await supabaseClient_1.supabase
            .from("assets")
            .select("*")
            .eq("pumpId", pumpId)
            .order("id", { ascending: false });
        if (error)
            return res.status(500).json({ message: error.message });
        return res.json(data);
    });
    app.post("/api/assets", async (req, res) => {
        // Accept both camelCase and snake_case from request body, prefer camelCase
        const pumpId = req.body.pumpId ?? req.body.pump_id;
        const serialNumber = req.body.serialNumber ?? req.body.serial_number;
        const asset_name = req.body.asset_name ?? req.body.assetName ?? req.body.assetname;
        const assetNumber = req.body.assetNumber ?? req.body.asset_number;
        const barcode = req.body.barcode;
        const quantity = req.body.quantity;
        const units = req.body.units;
        const remarks = req.body.remarks;
        // Validate required fields (pumpId, asset_name, assetNumber)
        if (!pumpId || !asset_name || !assetNumber) {
            return res.status(400).json({ message: "Missing required fields" });
        }
        const insertObj = {
            // Use camelCase `pumpId` so queries using pumpId succeed
            pumpId: pumpId,
            // Insert other fields using likely DB column names; keep names as-is so DB mapping works
            serialNumber: serialNumber,
            asset_name: asset_name,
            assetNumber: assetNumber,
            barcode: barcode ?? null,
            quantity: quantity,
            units: units,
            remarks: remarks ?? null
        };
        const { data, error } = await supabaseClient_1.supabase
            .from("assets")
            .insert([insertObj])
            .select("*")
            .single();
        if (error)
            return res.status(500).json({ message: error.message });
        return res.status(201).json(data);
    });
    app.put("/api/assets/:id", async (req, res) => {
        const { id } = req.params;
        // Accept both camelCase and snake_case on update as well
        const serialNumber = req.body.serialNumber ?? req.body.serial_number;
        const asset_name = req.body.asset_name ?? req.body.assetName ?? req.body.assetname;
        const assetNumber = req.body.assetNumber ?? req.body.asset_number;
        const barcode = req.body.barcode;
        const quantity = req.body.quantity;
        const units = req.body.units;
        const remarks = req.body.remarks;
        const { data, error } = await supabaseClient_1.supabase
            .from("assets")
            .update({
            serialNumber: serialNumber,
            asset_name: asset_name,
            assetNumber: assetNumber,
            barcode: barcode ?? null,
            quantity: quantity,
            units: units,
            remarks: remarks ?? null
        })
            .eq("id", id)
            .select("*")
            .single();
        if (error)
            return res.status(500).json({ message: error.message });
        return res.json(data);
    });
    app.delete("/api/assets/:id", async (req, res) => {
        const { id } = req.params;
        const { error } = await supabaseClient_1.supabase
            .from("assets")
            .delete()
            .eq("id", id);
        if (error)
            return res.status(500).json({ message: error.message });
        return res.json({ ok: true });
    });
}
