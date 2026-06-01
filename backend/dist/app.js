"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const auth_1 = __importDefault(require("./routes/auth"));
const creators_1 = __importDefault(require("./routes/creators"));
const donations_1 = __importDefault(require("./routes/donations"));
const app = (0, express_1.default)();
app.use((0, cors_1.default)());
app.use(express_1.default.json());
app.get("/health", (req, res) => {
    return res.json({ status: "ok", timestamp: new Date().toISOString() });
});
app.use("/api/auth", auth_1.default);
app.use("/api/creators", creators_1.default);
app.use("/api/donations", donations_1.default);
app.use((req, res) => {
    return res.status(404).json({ error: "Not Found" });
});
exports.default = app;
