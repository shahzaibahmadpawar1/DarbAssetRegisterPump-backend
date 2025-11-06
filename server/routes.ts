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

    if (!username || !password) {
      return res.status(400).json({ message: "Missing credentials" });
    }

    const { data: user, error } = await supabase
      .from("users")
      .select("id, password_hash")
      .eq("username", username)
      .maybeSingle();

    if (error || !user) return res.status(401).json({ message: "Invalid credentials" });

    const passwordOk =
      user.password_hash === password || bcrypt.compareSync(password, user.password_hash);
    if (!passwordOk) return res.status(401).json({ message: "Invalid credentials" });

    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: "7d" });
    res.cookie(TOKEN_COOKIE_NAME, token, {
      httpOnly: true,
      secure: true,
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
    const { data, error } = await supabase
      .from("pumps")
      .select("*")
      .order("id", { ascending: false });
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

  // ----------------------------
  // CATEGORIES
  // ----------------------------
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
  // ✅ NEW route added here
  app.get("/api/assets/pump/:pumpId", async (req: Request, res: Response) => {
    try {
      const { pumpId } = req.params;
      const { data, error } = await supabase
        .from("assets")
        .select("*")
        .eq("pumpId", pumpId)
        .order("id", { ascending: false });
      if (error) return res.status(500).json({ message: error.message });
      return res.json(data);
    } catch (e: any) {
      return res.status(500).json({ message: e?.message || "Internal error" });
    }
  });

// Create asset without linking to pump
app.post("/api/assets", async (req, res) => {
  const { serialNumber, asset_name, assetNumber, barcode, quantity, units, remarks, category_id } = req.body;
  if (!asset_name || !assetNumber) {
    return res.status(400).json({ message: "Missing required fields" });
  }

  const { data, error } = await supabase
    .from("assets")
    .insert([{ serialNumber, asset_name, assetNumber, barcode, quantity, units, remarks, category_id: category_id || null }])
    .select("*")
    .maybeSingle();

  if (error) return res.status(500).json({ message: error.message });
  return res.status(201).json(data);
});


  app.get("/api/assets", async (req, res) => {
    try {
      const { categoryId } = req.query;
      const query = supabase.from("assets").select("*").order("id", { ascending: false });
      const { data: assets, error } = await query;
      if (error) return res.status(500).json({ message: error.message });
      let list = assets || [];
      if (categoryId) list = list.filter((a: any) => a.category_id === categoryId);

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

  app.post("/api/assets", async (req, res) => {
    const {
      pumpId,
      serialNumber,
      asset_name,
      assetNumber,
      barcode,
      quantity,
      units,
      remarks,
      category_id,
    } = req.body;
    if (!pumpId || !asset_name || !assetNumber)
      return res.status(400).json({ message: "Missing required fields" });

    const { data, error } = await supabase
      .from("assets")
      .insert([{ pumpId, serialNumber, asset_name, assetNumber, barcode, quantity, units, remarks, category_id }])
      .select("*")
      .maybeSingle();

    if (error) return res.status(500).json({ message: error.message });
    return res.status(201).json(data);
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
    const { data, error } = await supabase
      .from("assets")
      .select("*")
      .order("id", { ascending: false });
    if (error) return res.status(500).json({ message: error.message });
    return res.json(data);
  });

  app.get("/api/reports/all-stations", async (_req, res) => {
    const { data, error } = await supabase
      .from("pumps")
      .select("*")
      .order("id", { ascending: false });
    if (error) return res.status(500).json({ message: error.message });
    return res.json(data);
  });
}
