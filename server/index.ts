// server/index.ts
import express from "express";
import session from "express-session";
import cors from "cors";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";
import { registerRoutes } from "./routes";
import "dotenv/config";

const app = express();

// ===============================
// ✅ Config
// ===============================
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "http://ams.darbstations.com.sa/";
const JWT_SECRET = process.env.JWT_SECRET || "super-secret-key";
const SESSION_SECRET = process.env.SESSION_SECRET || "replace-me";

// ===============================
// ✅ CORS CONFIGURATION (single use)
// ===============================
const allowedOrigins = [
  "https://azharalibuttar.com",
  "https://www.azharalibuttar.com",
  "http://ams.darbstations.com.sa/",
  "https://www.ams.darbstations.com.sa/"
   // dev
];

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // allow no-origin (mobile apps, curl)
      if (allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new Error("CORS blocked from origin: " + origin));
    },
    credentials: true,
  })
);

// Optional: preflight helper
app.options("*", cors({ origin: allowedOrigins, credentials: true }));

// ===============================
// ✅ Middleware
// ===============================
app.use(express.json());
app.use(cookieParser());

// Attach user from JWT cookie or Authorization header (optional convenience)
app.use((req: any, _res, next) => {
  // Try cookie first
  let token = req.cookies?.token;
  
  // If no cookie, try Authorization header
  if (!token) {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      token = authHeader.substring(7);
    }
  }
  
  if (token) {
    try { req.user = jwt.verify(token, JWT_SECRET); } catch { /* ignore */ }
  }
  next();
});

// ❌ Not needed when using JWT cookies; remove it to avoid extra cookie noise
// app.use(session({ ... }))

// ✅ Session (optional - using JWT cookies instead, but keeping for compatibility)
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000,
      domain: process.env.NODE_ENV === "production" ? ".azharalibuttar.com" : undefined,
    },
  })
);


// ✅ Routes
registerRoutes(app);

// ✅ Root check
app.get("/", (_req, res) => {
  res.status(200).send("✅ Backend running on Vercel and connected to frontend.");
});

// ⚠️ DO NOT CALL app.listen() ON VERCEL
export default app;
