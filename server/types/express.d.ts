import type { Station } from '@prisma/client';
import type { SessionUser } from '../../shared/types.js';

declare global {
  namespace Express {
    interface Request {
      user?: SessionUser;
      sessionId?: string;
      station?: Station;
    }
  }
}

export {};
