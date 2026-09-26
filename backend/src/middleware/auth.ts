import { Request, Response, NextFunction } from 'express';
import * as jwt from 'jsonwebtoken';
import { UnauthorizedError } from '../errors/AppError';

// Fail fast if JWT_SECRET is missing in non-test environments
if (process.env.NODE_ENV !== 'test' && !process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET must be set in non-test environments');
}

export interface AuthRequest extends Request {
  user?: {
    id: number;
    // Null for a magic-link (#15) or OAuth (#14) account that hasn't
    // connected a wallet. Existing wallet-authenticated call sites that
    // compare this against a Stellar address (e.g. authorizing a
    // subscription action) still behave correctly when it's null: a
    // non-wallet user can never equal a real wallet address, so they're
    // correctly denied rather than needing every call site updated.
    walletAddress: string | null;
  };
}

export const authMiddleware = (req: AuthRequest, res: Response, next: NextFunction) => {
  const token = req.headers.authorization?.split(' ')[1];

  if (!token) {
    return next(new UnauthorizedError('No token provided'));
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as {
      id: number;
      walletAddress: string | null;
    };
    req.user = decoded;
    next();
  } catch (error) {
    return next(new UnauthorizedError('Invalid token'));
  }
};

export const generateToken = (userId: number, walletAddress: string | null): string => {
  return jwt.sign(
    { id: userId, walletAddress },
    process.env.JWT_SECRET!,
    { expiresIn: '7d' }
  );
};

