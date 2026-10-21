import { PrismaClient } from '@prisma/client';

let client: PrismaClient | null = null;

/** Created lazily so DATABASE_URL can be set by the built-in database first. */
export function db(): PrismaClient {
  if (!client) client = new PrismaClient({ log: ['warn', 'error'] });
  return client;
}

export async function disconnect() {
  if (client) await client.$disconnect();
  client = null;
}

export type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];
