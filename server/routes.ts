// routes.ts
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
    console.log("🔑 Login attempt:", req.body);
    const { username, password } = req.body as { username: string; password: string };

    if (!username || !password) {
      return res.status(400).json({ message: "Missing credentials" });
    }

    // Fetch user from Supabase
    const { data: user, error } = await supabase
      .from("users")
      .select("id, password_hash")
      .eq("username", username)
      .maybeSingle();

    if (error || !user) {
      console.log("❌ User not found or query error:", error?.message);
      return res.status(401).json({ message: "Invalid credentials" });
    }

    // Compare password (plain for now; bcrypt recommended)
    if (user.password_hash !== password) {
      console.log("❌ Password mismatch for:", username);
      return res.status(401).json({ message: "Invalid credentials" });
    }

    // Save session ID
    (req.session as any).userId = user.id;

    // Issue JWT cookie
    try {
      const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: "7d" });
      res.cookie(TOKEN_COOKIE_NAME, token, {
        httpOnly: true,
        secure: true, // ✅ for HTTPS
        sameSite: "none", // ✅ cross-domain
        maxAge: TOKEN_MAX_AGE,
        path: "/",
      });
    } catch (jwtErr) {
      console.error("JWT sign error:", jwtErr);
    }

    console.log("✅ Login successful for:", username);
    return res.json({ ok: true });
  });

  app.post("/api/logout", (req: Request, res: Response) => {
    try {
      res.clearCookie(TOKEN_COOKIE_NAME, { path: "/" });
      res.clearCookie("connect.sid", { path: "/" });
    } catch (e) {
      console.warn("Cookie clear error:", e);
    }
    req.session.destroy(() => {
      res.json({ ok: true });
    });
  });

  // ----------------------------
  // SESSION / AUTH CHECK
  // ----------------------------
  app.get("/api/me", async (req: Request, res: Response) => {
    try {
      // Check express-session first
      const sessionUserId = (req.session as any)?.userId;
      if (sessionUserId) {
        const { data, error } = await supabase
          .from("users")
          .select("id, username")
          .eq("id", sessionUserId)
          .maybeSingle();

        if (error) {
          console.error("GET /api/me DB error:", error);
          return res.status(500).json({ message: "Database error" });
        }
        return res.json({ authenticated: true, user: data ?? { id: sessionUserId } });
      }

      // Fallback to JWT cookie
      const cookies = (req as any).cookies;
      const token = cookies?.[TOKEN_COOKIE_NAME];
      if (!token) return res.status(401).json({ authenticated: false });

      try {
        const decoded = jwt.verify(token, JWT_SECRET) as any;
        const userId = decoded?.userId;
        if (!userId) return res.status(401).json({ authenticated: false });

        const { data, error } = await supabase
          .from("users")
          .select("id, username")
          .eq("id", userId)
          .maybeSingle();

        if (error) {
          console.error("GET /api/me DB error:", error);
          return res.status(500).json({ message: "Database error" });
        }

        // Sync session
        (req.session as any).userId = userId;

        return res.json({ authenticated: true, user: data ?? { id: userId } });
      } catch (e) {
        console.warn("Invalid JWT on /api/me:", e);
        return res.status(401).json({ authenticated: false });
      }
    } catch (err) {
      console.error("GET /api/me error:", err);
      return res.status(500).json({ message: "Internal server error" });
    }
  });

  // ----------------------------
  // PUMPS ROUTES
  // ----------------------------
  app.get("/api/pumps", async (_req: Request, res: Response) => {
    const { data, error } = await supabase
      .from("pumps")
      .select("*")
      .order("id", { ascending: false });

    if (error) return res.status(500).json({ message: error.message });
    return res.json(data);
  });

  app.post("/api/pumps", async (req: Request, res: Response) => {
    const { name, location, manager } = req.body;

    if (!name || !location || !manager) {
      return res.status(400).json({ message: "Missing fields" });
    }

    const { data, error } = await supabase
      .from("pumps")
      .insert([{ name, location, manager }])
      .select("*")
      .maybeSingle();

    if (error) return res.status(500).json({ message: error.message });
    return res.status(201).json(data);
  });

  app.put("/api/pumps/:id", async (req: Request, res: Response) => {
    const { id } = req.params;
    const { name, location, manager } = req.body;

    const { data, error } = await supabase
      .from("pumps")
      .update({ name, location, manager })
      .eq("id", id)
      .select("*")
      .maybeSingle();

    if (error) return res.status(500).json({ message: error.message });
    if (!data) return res.status(404).json({ message: "Pump not found" });
    return res.json(data);
  });

  app.delete("/api/pumps/:id", async (req: Request, res: Response) => {
    const { id } = req.params;
    const { error } = await supabase.from("pumps").delete().eq("id", id);
    if (error) return res.status(500).json({ message: error.message });
    return res.json({ ok: true });
  });

  // ----------------------------
  // ASSETS ROUTES
  // ----------------------------
  app.get("/api/assets", async (_req: Request, res: Response) => {
    const { data, error } = await supabase
      .from("assets")
      .select("*")
      .order("id", { ascending: false });

    if (error) return res.status(500).json({ message: error.message });
    return res.json(data);
  });

  app.get("/api/assets/pump/:pumpId", async (req: Request, res: Response) => {
    try {
      const { pumpId } = req.params;
      console.log("Fetching assets for pumpId:", pumpId);

      const pumpIdNum = Number(pumpId);
      const value = isNaN(pumpIdNum) ? pumpId : pumpIdNum;

      const { data, error } = await supabase
        .from("assets")
        .select("*")
        .eq("pumpId", value)
        .order("id", { ascending: false });

      if (error) {
        console.error("❌ Supabase error fetching assets:", error);
        return res.status(500).json({ message: error.message });
      }

      return res.json(data || []);
    } catch (err: any) {
      console.error("Unexpected error in GET /api/assets/pump/:pumpId", err);
      return res.status(500).json({ message: err?.message || "Internal server error" });
    }
  });

  app.get("/api/assets/:id", async (req: Request, res: Response) => {
    const { id } = req.params;
    const { data, error } = await supabase
      .from("assets")
      .select("*")
      .eq("id", id)
      .maybeSingle();

    if (error) {
      console.log("❌ Asset fetch error:", error.message);
      return res.status(500).json({ message: "Database error" });
    }

    if (!data) {
      console.log("❌ Asset not found");
      return res.status(404).json({ message: "Asset not found" });
    }

    return res.json(data);
  });

  app.post("/api/assets", async (req: Request, res: Response) => {
    const { pumpId, serialNumber, asset_name, assetNumber, barcode, quantity, units, remarks } = req.body;

    if (!pumpId || !asset_name || !assetNumber) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    const { data, error } = await supabase
      .from("assets")
      .insert([
        {
          pumpId,
          serialNumber,
          asset_name,
          assetNumber,
          barcode: barcode ?? null,
          quantity,
          units,
          remarks: remarks ?? null,
        },
      ])
      .select("*")
      .maybeSingle();

    if (error) {
      console.error("❌ Asset insert error:", error.message);
      return res.status(500).json({ message: error.message });
    }

    return res.status(201).json(data);
  });

  app.put("/api/assets/:id", async (req: Request, res: Response) => {
    const { id } = req.params;
    const { serialNumber, asset_name, assetNumber, barcode, quantity, units, remarks } = req.body;

    const { data, error } = await supabase
      .from("assets")
      .update({
        serialNumber,
        asset_name,
        assetNumber,
        barcode: barcode ?? null,
        quantity,
        units,
        remarks: remarks ?? null,
      })
      .eq("id", id)
      .select("*")
      .maybeSingle();

    if (error) return res.status(500).json({ message: error.message });
    if (!data) return res.status(404).json({ message: "Asset not found" });
    return res.json(data);
  });

  app.delete("/api/assets/:id", async (req: Request, res: Response) => {
    const { id } = req.params;
    const { error } = await supabase.from("assets").delete().eq("id", id);
    if (error) return res.status(500).json({ message: error.message });
    return res.json({ ok: true });
  });
}
