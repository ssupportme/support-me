"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const prisma_1 = __importDefault(require("../prisma"));
const router = (0, express_1.Router)();
router.get("/", async (req, res) => {
    const { creatorUsername } = req.query;
    const donations = await prisma_1.default.donation.findMany({
        orderBy: { createdAt: "desc" },
        ...(creatorUsername
            ? { where: { creator: { username: String(creatorUsername) } } }
            : {})
    });
    return res.json(donations);
});
router.post("/", async (req, res) => {
    const { creatorUsername, senderAddress, amount, currency = "XLM", message, transactionHash } = req.body;
    if (!creatorUsername || !senderAddress || !amount) {
        return res.status(400).json({ error: "creatorUsername, senderAddress and amount are required" });
    }
    const creator = await prisma_1.default.creator.findUnique({ where: { username: creatorUsername } });
    if (!creator) {
        return res.status(404).json({ error: "Creator not found" });
    }
    const donation = await prisma_1.default.donation.create({
        data: {
            creatorId: creator.id,
            senderAddress,
            amount: Number(amount),
            currency,
            message,
            transactionHash
        }
    });
    return res.status(201).json(donation);
});
exports.default = router;
