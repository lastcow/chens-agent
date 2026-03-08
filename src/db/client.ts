import { PrismaClient } from "@prisma/client";
import { PrismaNeon } from "@prisma/adapter-neon";

const adapter = new PrismaNeon({ connectionString: process.env.DATABASE_URL! });
export const db = new PrismaClient({ adapter } as ConstructorParameters<typeof PrismaClient>[0]);
