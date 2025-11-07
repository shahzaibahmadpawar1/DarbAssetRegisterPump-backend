// server/routes.ts
import type { Express, Request, Response } from "express";
import bcrypt from "bcryptjs";
import { supabase } from "./supabaseClient";
import jwt from "jsonwebtoken";

export function registerRoutes(app: Express) {
  const JWT_SECRET = process.env.JWT_SECRET || "replace-with-secure-secret";
  const TOKEN_COOKIE_NAME = "token";
  const TOKEN_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days

  // ----------------------------
  // AUTH ROUTES
  // ----------------------------
  app.post("/api/login", async (req: Request, res: Response) => {
    const { username, password } = req.body;
    if (!username || !password)
      return res.status(400).json({ message: "Missing credentials" });

    const { data: user, error } = await supabase
      .from("users")
      .select("id, password_hash")
      .eq("username", username)
      .maybeSingle();

    if (error || !user) return res.status(401).json({ message: "Invalid credentials" });

    const passwordOk = password === user.password_hash;

    if (!passwordOk) return res.status(401).json({ message: "Invalid credentials" });

    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: "7d" });
    res.cookie(TOKEN_COOKIE_NAME, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "none",
      maxAge: TOKEN_MAX_AGE,
      path: "/",
    });

    return res.json({ ok: true });
  });

  app.post("/api/logout", (_req, res) => {
    res.clearCookie(TOKEN_COOKIE_NAME, { path: "/" });
    res.json({ ok: true });
  });

  app.get("/api/me", async (req: Request, res: Response) => {
    const token = (req as any).cookies?.[TOKEN_COOKIE_NAME];
    if (!token) return res.status(401).json({ authenticated: false });

    try {
      const decoded = jwt.verify(token, JWT_SECRET) as any;
      const { data, error } = await supabase
        .from("users")
        .select("id, username")
        .eq("id", decoded.userId)
        .maybeSingle();

      if (error || !data) return res.status(401).json({ authenticated: false });
      return res.json({ authenticated: true, user: data });
    } catch {
      return res.status(401).json({ authenticated: false });
    }
  });

  // ----------------------------
  // PUMPS
  // ----------------------------
  app.get("/api/pumps", async (_req, res) => {
    const { data, error } = await supabase.from("pumps").select("*").order("id", { ascending: false });
    if (error) return res.status(500).json({ message: error.message });
    return res.json(data);
  });

  app.post("/api/pumps", async (req, res) => {
    const { name, location, manager } = req.body;
    if (!name || !location || !manager)
      return res.status(400).json({ message: "Missing fields" });

    const { data, error } = await supabase
      .from("pumps")
      .insert([{ name, location, manager }])
      .select("*")
      .maybeSingle();
    if (error) return res.status(500).json({ message: error.message });
    return res.status(201).json(data);
  });

  app.put("/api/pumps/:id", async (req, res) => {
    const id = Number(req.params.id);
    const payload = req.body;
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

  app.delete("/api/pumps/:id", async (req, res) => {
    const id = Number(req.params.id);
    const { error } = await supabase.from("pumps").delete().eq("id", id);
    if (error) return res.status(500).json({ message: error.message });
    res.status(204).send();
  });

  // ----------------------------
  // CATEGORIES
  // ----------------------------
  app.get("/api/categories", async (_req, res) => {
    const { data, error } = await supabase.from("categories").select("*").order("name", { ascending: true });
    if (error) return res.status(500).json({ message: error.message });
    return res.json(data);
  });

  app.post("/api/categories", async (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ message: "Category name required" });

    const { data, error } = await supabase
      .from("categories")
      .insert([{ name }])
      .select("*")
      .maybeSingle();
    if (error) return res.status(500).json({ message: error.message });
    return res.status(201).json(data);
  });

  // ----------------------------
  // ASSETS
  // ----------------------------

  // ✅ Assets by pump (correct field: pumpId)
  app.get("/api/assets/pump/:pumpId", async (req: Request, res: Response) => {
    try {
      const pumpId = Number(req.params.pumpId);
      if (Number.isNaN(pumpId))
        return res.status(400).json({ message: "Invalid pumpId" });

      const { data, error } = await supabase
        .from("assets")
        .select("*")
        .eq("pumpId", pumpId);

      if (error) return res.status(500).json({ message: error.message });
      return res.json(data);
    } catch (e: any) {
      return res.status(500).json({ message: e?.message || "Internal error" });
    }
  });

  // ✅ List assets (optional category filter)
  app.get("/api/assets", async (req, res) => {
    try {
      const { categoryId } = req.query;
      const query = supabase.from("assets").select("*").order("id", { ascending: false });
      const { data: assets, error } = await query;
      if (error) return res.status(500).json({ message: error.message });

      let list = assets || [];
      if (categoryId != null) {
        list = list.filter((a: any) => String(a.category_id) === String(categoryId));
      }

      const { data: cats } = await supabase.from("categories").select("id, name");
      const cmap = new Map((cats || []).map((c: any) => [c.id, c.name]));
      const withNames = list.map((a: any) => ({
        ...a,
        categoryName: a.category_id ? cmap.get(a.category_id) : null,
      }));

      return res.json(withNames);
    } catch (e: any) {
      return res.status(500).json({ message: e?.message || "Internal error" });
    }
  });

  // ✅ Create asset (fix: pumpId field)
  app.post("/api/assets", async (req, res) => {
    try {
      const b = req.body || {};
      const asset_name = b.asset_name ?? b.assetName ?? null;
      const assetNumber = b.assetNumber ?? b.asset_number ?? null;
      const serialNumber = b.serialNumber ?? b.serial_number ?? null;
      const barcode = b.barcode ?? null;
      const quantity = b.quantity ? Number(b.quantity) : null;
      const units = b.units ?? null;
      const remarks = b.remarks ?? null;
      const category_id =
        b.category_id === "" || b.categoryId === "" || b.category_id == null
          ? null
          : b.category_id ?? b.categoryId;
      const pumpId = b.pumpId ?? b.pump_id ?? null;
      console.log("BODY RECEIVED:", req.body);

      if (!asset_name || !assetNumber) {
        return res.status(400).json({ message: "Missing required fields" });
      }

      const insertRow: any = {
        asset_name,
        assetNumber,
        serialNumber,
        barcode,
        quantity,
        units,
        remarks,
        category_id: category_id || null,
        pumpId: pumpId ? Number(pumpId) : null,
      };
      console.log("INSERT ROW:", JSON.stringify(insertRow));

const { data, error } = await supabase
  .from("assets")
  .insert([insertRow])
  .select("*")
  .maybeSingle();

if (error) {
  console.error("SUPABASE INSERT ERROR:", JSON.stringify(error, null, 2));
  return res.status(400).json({ message: "DB insert error", error });
}

return res.status(201).json(data);
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || "Internal error creating asset" });
  }
});


  // ✅ Update asset (fix: pumpId field)
  app.put("/api/assets/:id", async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (Number.isNaN(id)) return res.status(400).json({ message: "Invalid id" });

      const b = req.body || {};
      const payload: any = {};

      if ("assetName" in b || "asset_name" in b)
        payload.asset_name = b.asset_name ?? b.assetName;

      if ("assetNumber" in b || "asset_number" in b)
        payload.assetNumber = b.assetNumber ?? b.asset_number;

      if ("serialNumber" in b || "serial_number" in b)
        payload.serialNumber = b.serialNumber ?? b.serial_number;

      if ("barcode" in b) payload.barcode = b.barcode ?? null;

      if ("quantity" in b)
        payload.quantity = b.quantity == null ? null : Number(b.quantity);

      if ("units" in b) payload.units = b.units ?? null;

      if ("remarks" in b) payload.remarks = b.remarks ?? null;

      if ("categoryId" in b || "category_id" in b) {
        const cat = b.category_id ?? b.categoryId;
        payload.category_id = cat || null;
      }

      if ("pumpId" in b || "pump_id" in b) {
        const pid = b.pumpId ?? b.pump_id;
        payload.pumpId = pid ? Number(pid) : null;
      }

      const { data, error } = await supabase
        .from("assets")
        .update(payload)
        .eq("id", id)
        .select("*")
        .maybeSingle();

      if (error) return res.status(500).json({ message: error.message });
      if (!data) return res.status(404).json({ message: "Asset not found" });
      res.json(data);
    } catch (e: any) {
      res.status(500).json({ message: e?.message || "Internal error updating asset" });
    }
  });

  // DELETE
  app.delete("/api/assets/:id", async (req, res) => {
    const id = Number(req.params.id);
    const { error } = await supabase.from("assets").delete().eq("id", id);
    if (error) return res.status(500).json({ message: error.message });
    res.status(204).send();
  });

  // ----------------------------
  // REPORT ROUTES
  // ----------------------------
  app.get("/api/reports/assets-by-category", async (_req, res) => {
    const { data, error } = await supabase
      .from("assets")
      .select("id, asset_name, category_id, pumps(name)")
      .order("category_id", { ascending: true });
    if (error) return res.status(500).json({ message: error.message });
    return res.json(data);
  });

  app.get("/api/reports/all-assets", async (_req, res) => {
    const { data, error } = await supabase.from("assets").select("*").order("id", { ascending: false });
    if (error) return res.status(500).json({ message: error.message });
    return res.json(data);
  });

  app.get("/api/reports/all-stations", async (_req, res) => {
    const { data, error } = await supabase.from("pumps").select("*").order("id", { ascending: false });
    if (error) return res.status(500).json({ message: error.message });
    return res.json(data);
  });
}
