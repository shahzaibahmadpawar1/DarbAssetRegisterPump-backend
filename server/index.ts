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
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "https://azharalibuttar.com";
const JWT_SECRET = process.env.JWT_SECRET || "super-secret-key";
const SESSION_SECRET = process.env.SESSION_SECRET || "replace-me";

// ===============================
// ✅ CORS
// ===============================
app.use(
  cors({
    origin: (origin, cb) => {
      const allowed = [
        "https://azharalibuttar.com",
        "https://www.azharalibuttar.com",
      ];
      if (!origin || allowed.includes(origin)) cb(null, true);
      else cb(new Error("CORS blocked: " + origin));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
app.options("*", cors());

// ===============================
// ✅ Middleware
// ===============================
app.use(express.json());
app.use(cookieParser());

// Attach user from JWT cookie
app.use((req: any, _res, next) => {
  const token = req.cookies?.token;
  if (token) {
    try {
      req.user = jwt.verify(token, JWT_SECRET);
    } catch {
      // ignore bad token
    }
  }
  next();
});

// ✅ Session
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: true,
      sameSite: "none",
      maxAge: 7 * 24 * 60 * 60 * 1000,
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
