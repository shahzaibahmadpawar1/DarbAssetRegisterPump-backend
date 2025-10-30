// server.ts
import express from "express";
import session from "express-session";
import cors from "cors";
import path from "path";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";
import { registerRoutes } from "./routes";

import "dotenv/config";

const app = express();

// IMPORTANT: when using credentials (cookies) you cannot use origin: "*"
// set frontend origin via env or default to localhost:5173
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "https://azharalibuttar.com"; // your live frontend domain
const JWT_SECRET = process.env.JWT_SECRET || "replace-with-secure-secret";

app.use(
  cors({
    origin: FRONTEND_ORIGIN,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true, // allow cookies to be sent
  })
);

app.use(express.json());


// parse cookies so we can read JWT cookie
app.use(cookieParser());

// minimal JWT middleware: if token cookie present, verify and attach decoded to req.user
app.use((req: any, _res, next) => {
  try {
    const token = req.cookies?.token;
    if (token) {
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        // attach user info to request (you can type this properly in your project)
        req.user = decoded;
      } catch (e) {
        // invalid token — ignore (routes can check auth explicitly)
        // console.warn("Invalid JWT token in cookie:", e);
      }
    }
  } catch (err) {
    // continue without breaking requests
    console.error("Error reading token cookie:", err);
  }
  next();
});

app.use(
  session({
    secret: process.env.SESSION_SECRET || "replace-me",
    resave: false,
    saveUninitialized: false,
    cookie: {
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production", // true in prod if using https
    },
  })
);

registerRoutes(app);

// const publicDir = path.join(process.cwd(), "dist", "public");
// app.use(express.static(publicDir));
// app.get("*", (_req, res) => {
//   res.sendFile(path.join(publicDir, "index.html"));
// });

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`✅ Server listening on ${PORT}`);
  console.log(`🔸 CORS origin: ${FRONTEND_ORIGIN}`);
});
