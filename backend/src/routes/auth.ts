import { Router } from 'express';
import { randomBytes, createHash } from 'crypto';
import { Keypair, StrKey } from '@stellar/stellar-sdk';
import prisma from '../prisma';
import { generateToken } from '../middleware/auth';

const router = Router();

const STELLAR_SIGNED_MESSAGE_PREFIX = 'Stellar Signed Message:\n';
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

interface Challenge {
  message: string;
  expiresAt: number;
}

const challenges = new Map<string, Challenge>();

router.post('/challenge', async (req, res) => {
  const { walletAddress } = req.body;

  if (!walletAddress || !StrKey.isValidEd25519PublicKey(walletAddress)) {
    return res.status(400).json({ error: 'A valid Stellar wallet address is required' });
  }

  const nonce = randomBytes(16).toString('hex');
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
    const hash = createHash('sha256').update(payload).digest();
    const signatureValid = Keypair.fromPublicKey(walletAddress).verify(
      hash,
      Buffer.from(signedMessage, 'base64')
    );

    if (!signatureValid) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    challenges.delete(walletAddress);

    const user = await prisma.user.upsert({
      where: { walletAddress },
      update: {},
      create: { walletAddress },
    });

    const creator = await prisma.creator.findUnique({ where: { userId: user.id } });

    const token = generateToken(user.id, user.walletAddress);
    return res.json({
      user: { id: user.id, walletAddress: user.walletAddress },
      token,
      hasProfile: !!creator,
      username: creator?.username,
    });
  } catch (error) {
    console.error('Verify error:', error);
    return res.status(401).json({ error: 'Signature verification failed' });
  }
});

export default router;
