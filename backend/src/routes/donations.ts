import { Router } from "express";
import prisma from "../prisma";

const router = Router();

router.get("/", async (req, res) => {
  const { creatorUsername } = req.query;

  const filter = creatorUsername
    ? { where: { creator: { username: String(creatorUsername) } } }
    : {};

  const donations = await prisma.donation.findMany({
    ...filter,
    orderBy: { createdAt: "desc" }
  });

  return res.json(donations);
});

router.post("/", async (req, res) => {
  const { creatorUsername, senderAddress, amount, currency = "XLM", message, transactionHash } = req.body;

  if (!creatorUsername || !senderAddress || !amount) {
    return res.status(400).json({ error: "creatorUsername, senderAddress and amount are required" });
  }

  const creator = await prisma.creator.findUnique({ where: { username: creatorUsername } });
  if (!creator) {
    return res.status(404).json({ error: "Creator not found" });
  }

  const donation = await prisma.donation.create({
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

export default router;
