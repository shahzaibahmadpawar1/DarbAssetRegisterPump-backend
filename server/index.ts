// server.ts
import express from "express";
import session from "express-session";
import cors from "cors";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";
import { registerRoutes } from "./routes";
import "dotenv/config";

const app = express();

// ✅ Your live frontend URL (⚠️ without trailing slash)
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "https://azharalibuttar.com";

// ✅ JWT Secret
const JWT_SECRET = process.env.JWT_SECRET || "super-secret-key";

// ✅ Middleware setup
app.use(
  cors({
    origin: FRONTEND_ORIGIN, // exact domain only (no slash)
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true, // allow cookies
  })
);

app.use(express.json());
app.use(cookieParser());

// ✅ Attach decoded JWT if token present
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

// ✅ Express session setup
app.use(
  session({
    secret: process.env.SESSION_SECRET || "replace-me",
    resave: false,
    saveUninitialized: false,
    cookie: {
      sameSite: "none", // important for cross-site
      secure: true,     // must be true for HTTPS
    },
  })
);

// ✅ Register routes
registerRoutes(app);

// ✅ Start server
const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`✅ Server listening on port ${PORT}`);
  console.log(`🌐 CORS Origin: ${FRONTEND_ORIGIN}`);
});
