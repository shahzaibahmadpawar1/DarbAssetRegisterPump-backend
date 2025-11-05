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
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "https://azharalibuttar.com";
const JWT_SECRET = process.env.JWT_SECRET || "MNBVCXZASDFGHJKLPOIUYTREWQ";
const SESSION_SECRET = process.env.SESSION_SECRET || "QWERTYUIOPASDFGHJKLZXCVBNM";
const isProd = process.env.NODE_ENV === "production";

// ===============================
// ✅ CORS Setup (critical fix)
// ===============================
app.use(
  cors({
    origin: (origin, callback) => {
      // Allow your production frontend and localhost (for testing)
      const allowedOrigins = [
        "https://azharalibuttar.com",
        "https://www.azharalibuttar.com",
      ];
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        console.warn("❌ Blocked CORS origin:", origin);
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// Handle preflight requests explicitly (for older browsers / vercel edge)
app.options("*", cors());

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
      secure: true, // HTTPS required for cross-domain
      sameSite: "none", // Allow frontend on another domain
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
if (process.env.PORT) {
  const PORT = Number(process.env.PORT || 3000);
  app.listen(PORT, () => {
    console.log(`✅ Server listening on port ${PORT}`);
    console.log(`🌐 CORS Origin allowed: ${FRONTEND_ORIGIN}`);
  });
}

// Export for Vercel
export default app;
