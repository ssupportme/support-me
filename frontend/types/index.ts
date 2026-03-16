export type TxStatus = "idle" | "pending" | "success" | "error";

export interface Donation {
  from: string;
  amount: string;
  createdAt: string;
  hash: string;
}

