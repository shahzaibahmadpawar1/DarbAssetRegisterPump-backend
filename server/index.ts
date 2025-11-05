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
// ✅ Configuration
// ===============================
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN ||"https://azharalibuttar.com";
const JWT_SECRET = process.env.JWT_SECRET || "super-secret-key";
const SESSION_SECRET = process.env.SESSION_SECRET || "replace-me";
const isProd = process.env.NODE_ENV === "production";

// ===============================
// ✅ CORS Setup
// ===============================
// Allow your cPanel frontend to access the backend
app.use(
  cors({
    origin: [FRONTEND_ORIGIN], // e.g. ["https://azharalibuttar.com"]
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// ===============================
// ✅ Middleware Setup
// ===============================
app.use(express.json());
app.use(cookieParser());

// Attach JWT if token present
app.use((req: any, _res, next) => {
  const token = req.cookies?.token;
  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      req.user = decoded;
    } catch {
      // ignore invalid token
    }
  }
  next();
});

// ===============================
// ✅ Session Setup
// ===============================
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: true, // must be true for HTTPS
      sameSite: "none", // required for cross-domain cookies
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    },
  })
);

// ===============================
// ✅ Register API Routes
// ===============================
registerRoutes(app);

// ===============================
// ✅ Default Root Route
// ===============================
app.get("/", (_req, res) => {
  res.status(200).send("✅ Backend running on Vercel and connected to frontend.");
});

// ===============================
// ✅ Server Start (Local use only)
// ===============================
// Vercel automatically uses this handler
if (process.env.PORT) {
  const PORT = Number(process.env.PORT || 3000);
  app.listen(PORT, () => {
    console.log(`✅ Server listening on port ${PORT}`);
    console.log(`🌐 CORS Origin: ${FRONTEND_ORIGIN}`);
  });
}

// Export for Vercel
export default app;
