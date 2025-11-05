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
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "https://azharalibuttar.com";
const JWT_SECRET = process.env.JWT_SECRET || "super-secret-key";
const SESSION_SECRET = process.env.SESSION_SECRET || "replace-me";
// ===============================
// ✅ CORS
// ===============================
app.use((0, cors_1.default)({
    origin: (origin, cb) => {
        const allowed = [
            "https://azharalibuttar.com",
            "https://www.azharalibuttar.com",
        ];
        if (!origin || allowed.includes(origin))
            cb(null, true);
        else
            cb(new Error("CORS blocked: " + origin));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
}));
app.options("*", (0, cors_1.default)());
// ===============================
// ✅ Middleware
// ===============================
app.use(express_1.default.json());
app.use((0, cookie_parser_1.default)());
// Attach user from JWT cookie
app.use((req, _res, next) => {
    const token = req.cookies?.token;
    if (token) {
        try {
            req.user = jsonwebtoken_1.default.verify(token, JWT_SECRET);
        }
        catch {
            // ignore bad token
        }
    }
    next();
});
// ✅ Session
app.use((0, express_session_1.default)({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        secure: true,
        sameSite: "none",
        maxAge: 7 * 24 * 60 * 60 * 1000,
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
