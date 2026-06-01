"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const prisma_1 = __importDefault(require("../prisma"));
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
router.get("/", async (req, res) => {
    const creators = await prisma_1.default.creator.findMany({
        orderBy: { createdAt: "desc" },
        include: { donations: true }
    });
    return res.json(creators);
});
router.get("/:username", async (req, res) => {
    const { username } = req.params;
    const creator = await prisma_1.default.creator.findUnique({
        where: { username },
        include: { donations: true }
    });
    if (!creator) {
        return res.status(404).json({ error: "Creator not found" });
    }
    return res.json(creator);
});
router.post("/:username/create", auth_1.authMiddleware, async (req, res) => {
    const { username } = req.params;
    const { walletAddress, displayName, bio, avatarUrl } = req.body;
    if (!username) {
        return res.status(400).json({ error: "username is required" });
    }
    if (!req.user) {
        return res.status(401).json({ error: "User not authenticated" });
    }
    try {
        const existing = await prisma_1.default.creator.findUnique({ where: { username } });
        if (existing) {
            return res.status(409).json({ error: "Username already exists" });
        }
        const userCreator = await prisma_1.default.creator.findUnique({
            where: { userId: req.user.id }
        });
        if (userCreator) {
            return res.status(409).json({ error: "User already has a creator profile" });
        }
        const creator = await prisma_1.default.creator.create({
            data: {
                userId: req.user.id,
                username,
                walletAddress: walletAddress || "",
                displayName,
                bio,
                avatarUrl
            }
        });
        return res.status(201).json(creator);
    }
    catch (error) {
        console.error("Create username error:", error);
        return res.status(500).json({ error: "Failed to create username" });
    }
});
router.put("/:username", async (req, res) => {
    const { username } = req.params;
    const updates = req.body;
    try {
        const creator = await prisma_1.default.creator.update({
            where: { username },
            data: updates
        });
        return res.json(creator);
    }
    catch (error) {
        return res.status(404).json({ error: "Creator not found or update failed" });
    }
});
exports.default = router;
