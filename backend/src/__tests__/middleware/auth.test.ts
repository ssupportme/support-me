import { Request, Response, NextFunction } from 'express';
import { AuthRequest, authMiddleware, generateToken } from '../../middleware/auth';

function mockReqResNext(overrides: Partial<Request> = {}) {
  const req = { 
    headers: {}, 
    ...overrides 
  } as Request;
  // Add user property as undefined, but we need to cast to AuthRequest to access it later
  const authReq = { ...req, user: undefined } as AuthRequest;
  const res = {} as Response;
  const next = jest.fn();
  return { req: authReq, res, next };
}

describe('authMiddleware', () => {
  const originalEnv = process.env;
  beforeEach(() => {
    process.env = { ...originalEnv }; // Make a copy
    process.env.JWT_SECRET = 'test-secret';
    process.env.NODE_ENV = 'test';
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('when JWT_SECRET is set', () => {
    it('should verify a valid token and attach user', () => {
      // This test requires jsonwebtoken to sign a token
      const jwt = require('jsonwebtoken');
      const token = jwt.sign({ id: 1, walletAddress: null }, process.env.JWT_SECRET!, { expiresIn: '7d' });
      const { req, res, next } = mockReqResNext({ headers: { authorization: `Bearer ${token}` } });
      authMiddleware(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(req.user).toMatchObject({ id: 1, walletAddress: null });
    });

    it('should return UnauthorizedError for invalid token', () => {
      const { req, res, next } = mockReqResNext({ headers: { authorization: 'Bearer invalid-token' } });
      authMiddleware(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  describe('when JWT_SECRET is missing in non-test environment', () => {
    it('should throw on module load', () => {
      // Reset the module cache and try to import with missing JWT_SECRET and NODE_ENV !== test
      const originalEnv = process.env;
      process.env = { ...originalEnv };
      delete process.env.JWT_SECRET;
      process.env.NODE_ENV = 'development';

      // Ensure we don't have the module cached
      jest.resetModules();
      expect(() => {
        // Require the module relative to this file
        require('../../middleware/auth');
      }).toThrow(/JWT_SECRET must be set in non-test environments/);

      // Restore
      process.env = originalEnv;
    });
  });

  describe('generateToken', () => {
    const originalEnv = process.env;
    beforeEach(() => {
      process.env = { ...originalEnv };
      process.env.JWT_SECRET = 'test-secret';
      process.env.NODE_ENV = 'test';
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('should generate a token', () => {
      const token = generateToken(1, null);
      expect(typeof token).toBe('string');
      expect(token.length).toBeGreaterThan(0);
    });
  });
});
