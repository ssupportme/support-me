"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const crypto_1 = require("crypto");
const stellar_sdk_1 = require("@stellar/stellar-sdk");
const prisma_1 = __importDefault(require("../prisma"));
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
const STELLAR_SIGNED_MESSAGE_PREFIX = 'Stellar Signed Message:\n';
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const challenges = new Map();
router.post('/challenge', async (req, res) => {
    const { walletAddress } = req.body;
    if (!walletAddress || !stellar_sdk_1.StrKey.isValidEd25519PublicKey(walletAddress)) {
        return res.status(400).json({ error: 'A valid Stellar wallet address is required' });
    }
    const nonce = (0, crypto_1.randomBytes)(16).toString('hex');
    const message = `Sign in to SupportMe\n\nAddress: ${walletAddress}\nNonce: ${nonce}\nIssued At: ${new Date().toISOString()}`;
    challenges.set(walletAddress, { message, expiresAt: Date.now() + CHALLENGE_TTL_MS });
    return res.json({ message });
});
router.post('/verify', async (req, res) => {
    const { walletAddress, signedMessage } = req.body;
    if (!walletAddress || !signedMessage) {
        return res.status(400).json({ error: 'walletAddress and signedMessage are required' });
    }
    const challenge = challenges.get(walletAddress);
    if (!challenge || challenge.expiresAt < Date.now()) {
        challenges.delete(walletAddress);
        return res.status(401).json({ error: 'Challenge expired or not found, please try again' });
    }
    try {
        const payload = Buffer.concat([
            Buffer.from(STELLAR_SIGNED_MESSAGE_PREFIX, 'utf-8'),
            Buffer.from(challenge.message, 'utf-8'),
        ]);
        const hash = (0, crypto_1.createHash)('sha256').update(payload).digest();
        const signatureValid = stellar_sdk_1.Keypair.fromPublicKey(walletAddress).verify(hash, Buffer.from(signedMessage, 'base64'));
        if (!signatureValid) {
            return res.status(401).json({ error: 'Invalid signature' });
        }
        challenges.delete(walletAddress);
        const user = await prisma_1.default.user.upsert({
            where: { walletAddress },
            update: {},
            create: { walletAddress },
        });
        const creator = await prisma_1.default.creator.findUnique({ where: { userId: user.id } });
        const token = (0, auth_1.generateToken)(user.id, user.walletAddress);
        return res.json({
            user: { id: user.id, walletAddress: user.walletAddress },
            token,
            hasProfile: !!creator,
            username: creator?.username,
        });
    }
    catch (error) {
        console.error('Verify error:', error);
        return res.status(401).json({ error: 'Signature verification failed' });
    }
});
exports.default = router;
