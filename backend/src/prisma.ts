import { PrismaClient } from "@prisma/client";
import { installDecimalJsonSerialization } from "./lib/money";

installDecimalJsonSerialization();

const prisma = new PrismaClient();
export default prisma;
