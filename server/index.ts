// server.ts
import express from "express";
import session from "express-session";
import cors from "cors";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";
import { registerRoutes } from "./routes";
import "dotenv/config";

const app = express();

// 🔹 Frontend hosted on CPanel domain
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "https://azharalibuttar.com";

// 🔹 Secret for JWT
const JWT_SECRET = process.env.JWT_SECRET || "replace-with-secure-secret";

// ✅ Enable CORS (cross-domain requests)
app.use(
  cors({
    origin: FRONTEND_ORIGIN, // Only allow your frontend
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true, // Allow cookies and sessions
  })
);

// ✅ Parse JSON requests
app.use(express.json());

// ✅ Parse cookies so JWT can be read
app.use(cookieParser());

// ✅ Minimal JWT middleware: read token cookie and attach decoded user to req.user
app.use((req: any, _res, next) => {
  try {
    const token = req.cookies?.token;
    if (token) {
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded; // attach decoded user
      } catch {
        // ignore invalid token
      }
    }
  } catch (err) {
    console.error("Error reading token cookie:", err);
  }
  next();
});

// ✅ Express session setup for optional session management
app.use(
  session({
    secret: process.env.SESSION_SECRET || "replace-me",
    resave: false,
    saveUninitialized: false,
    cookie: {
      sameSite: "none", // ✅ required for cross-domain cookies
      secure: true,     // ✅ required for HTTPS (Vercel + CPanel)
    },
  })
);

// ✅ Register all app routes
registerRoutes(app);

// ✅ Default port setup
const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`✅ Server listening on ${PORT}`);
  console.log(`🔸 CORS origin: ${FRONTEND_ORIGIN}`);
});
