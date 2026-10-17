import "dotenv/config";

import {
    PrismaClient,
} from "@prisma/client";

import {
    PrismaPg,
} from "@prisma/adapter-pg";


const connectionString =
  process.env.DATABASE_URL;


if (!connectionString) {
  throw new Error(
    "DATABASE_URL is not configured.",
  );
}


/**
 * Prisma 7 requires a database driver adapter
 * when connecting directly to PostgreSQL.
 *
 * PrismaPg uses the standard PostgreSQL driver
 * underneath Prisma.
 */
const adapter =
  new PrismaPg({
    connectionString,
  });


/**
 * Keep one shared PrismaClient for the API.
 *
 * Creating PrismaClient repeatedly can create
 * unnecessary database connections.
 */
export const prisma =
  new PrismaClient({
    adapter,
  });