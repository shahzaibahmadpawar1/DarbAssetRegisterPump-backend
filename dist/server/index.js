"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// server.ts or index.ts
const express_1 = __importDefault(require("express"));
const express_session_1 = __importDefault(require("express-session"));
const cors_1 = __importDefault(require("cors"));
const path_1 = __importDefault(require("path"));
const routes_1 = require("./routes");
require("dotenv/config");
const app = (0, express_1.default)();

// Use environment-backed frontend origin so cookies work with credentials
app.use((0, cors_1.default)({
    origin: process.env.FRONTEND_ORIGIN || "http://localhost:5173",
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true, // if using cookies etc
}));
app.use(express_1.default.json());
app.use((0, express_session_1.default)({
    secret: process.env.SESSION_SECRET || "replace-me",
    resave: false,
    saveUninitialized: false,
    cookie: {
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production", // true in prod (HTTPS)
        maxAge: 7 * 24 * 60 * 60 * 1000,
        path: "/", // ensure cookie is valid site-wide
    },
}));
(0, routes_1.registerRoutes)(app);
const publicDir = path_1.default.join(process.cwd(), "dist", "public");
app.use(express_1.default.static(publicDir));
app.get("*", (_req, res) => {
    res.sendFile(path_1.default.join(publicDir, "index.html"));
});
const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
    console.log(`✅ Server listening on ${PORT}`);
});
