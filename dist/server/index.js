"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// server/index.ts
const express_1 = __importDefault(require("express"));
const express_session_1 = __importDefault(require("express-session"));
const cors_1 = __importDefault(require("cors"));
const cookie_parser_1 = __importDefault(require("cookie-parser"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const routes_1 = require("./routes");
require("dotenv/config");
const app = (0, express_1.default)();
// ===============================
// ✅ Config
// ===============================
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "https://stg.ams.darbstations.com.sa/";
const JWT_SECRET = process.env.JWT_SECRET || "super-secret-key";
const SESSION_SECRET = process.env.SESSION_SECRET || "replace-me";
// ===============================
// ✅ CORS CONFIGURATION (single use)
// ===============================
const allowedOrigins = [
    "https://ams.darbstations.com.sa",
    "http://ams.darbstations.com.sa",
    "https://www.ams.darbstations.com.sa",
    "http://stg.ams.darbstations.com.sa",
    "https://stg.ams.darbstations.com.sa"
    // dev
];
app.use((0, cors_1.default)({
    origin: (origin, cb) => {
        if (!origin)
            return cb(null, true); // allow no-origin (mobile apps, curl)
        if (allowedOrigins.includes(origin))
            return cb(null, true);
        return cb(new Error("CORS blocked from origin: " + origin));
    },
    credentials: true,
}));
// Optional: preflight helper
app.options("*", (0, cors_1.default)({ origin: allowedOrigins, credentials: true }));
// ===============================
// ✅ Middleware
// ===============================
app.use(express_1.default.json());
app.use((0, cookie_parser_1.default)());
// Attach user from JWT cookie or Authorization header (optional convenience)
app.use((req, _res, next) => {
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
        try {
            req.user = jsonwebtoken_1.default.verify(token, JWT_SECRET);
        }
        catch { /* ignore */ }
    }
    next();
});
// ❌ Not needed when using JWT cookies; remove it to avoid extra cookie noise
// app.use(session({ ... }))
// ✅ Session (optional - using JWT cookies instead, but keeping for compatibility)
app.use((0, express_session_1.default)({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
        maxAge: 7 * 24 * 60 * 60 * 1000,
        domain: process.env.NODE_ENV === "production" ? ".stg.ams.darbstations.com.sa" : undefined,
    },
}));
// ✅ Routes
(0, routes_1.registerRoutes)(app);
// ✅ Root check
app.get("/", (_req, res) => {
    res.status(200).send("✅ Backend running on Vercel and connected to frontend.");
});
// ⚠️ DO NOT CALL app.listen() ON VERCEL
exports.default = app;
