"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// server.ts
const express_1 = __importDefault(require("express"));
const express_session_1 = __importDefault(require("express-session"));
const cors_1 = __importDefault(require("cors"));
const cookie_parser_1 = __importDefault(require("cookie-parser"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const routes_1 = require("./routes");
require("dotenv/config");
const app = (0, express_1.default)();
// IMPORTANT: when using credentials (cookies) you cannot use origin: "*"
// set frontend origin via env or default to localhost:5173
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "http://localhost:5173";
const JWT_SECRET = process.env.JWT_SECRET || "replace-with-secure-secret";
app.use((0, cors_1.default)({
    origin: FRONTEND_ORIGIN,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true, // allow cookies to be sent
}));
app.use(express_1.default.json());
// parse cookies so we can read JWT cookie
app.use((0, cookie_parser_1.default)());
// minimal JWT middleware: if token cookie present, verify and attach decoded to req.user
app.use((req, _res, next) => {
    try {
        const token = req.cookies?.token;
        if (token) {
            try {
                const decoded = jsonwebtoken_1.default.verify(token, JWT_SECRET);
                // attach user info to request (you can type this properly in your project)
                req.user = decoded;
            }
            catch (e) {
                // invalid token — ignore (routes can check auth explicitly)
                // console.warn("Invalid JWT token in cookie:", e);
            }
        }
    }
    catch (err) {
        // continue without breaking requests
        console.error("Error reading token cookie:", err);
    }
    next();
});
app.use((0, express_session_1.default)({
    secret: process.env.SESSION_SECRET || "replace-me",
    resave: false,
    saveUninitialized: false,
    cookie: {
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production", // true in prod if using https
    },
}));
(0, routes_1.registerRoutes)(app);
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
