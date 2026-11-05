import { supabaseAdmin } from "./supabase.js";

export type CreditKind = "deposit" | "withdrawal" | "adjustment" | "buy_in" | "payout" | "fee";

export type WalletChangeDetail = {
  creditsBalance: number;
  transaction?: {
    id: string;
    amountCredits: number;
    kind: CreditKind;
    description: string;
    sideBetId: string | null;
    createdAt: string;
  };
};

export type WalletRealtime = {
  walletChanged: (userIds: string | string[], reason: string, detail?: WalletChangeDetail) => Promise<void>;
};

export async function adjustCredits(
  userId: string,
  delta: number,
  kind: CreditKind,
  description: string,
  options?: {
    sideBetId?: string | null;
    createdBy?: string;
    realtime?: WalletRealtime;
    walletReason?: string;
  }
): Promise<{ balance: number; transactionId: string }> {
  const { data, error } = await supabaseAdmin.rpc("adjust_credits", {
    p_user_id: userId,
    p_delta: delta
  });

  if (error) {
    throw new Error(error.message.includes("Not enough credits") ? "Not enough credits" : error.message);
  }

  const balance = Number(data);
  const { data: txRow, error: txError } = await supabaseAdmin
    .from("credit_transactions")
    .insert({
      user_id: userId,
      amount_credits: delta,
      kind,
      description,
      side_bet_id: options?.sideBetId ?? null,
      created_by: options?.createdBy ?? null
    })
    .select("id, amount_credits, kind, description, side_bet_id, created_at")
    .single();

  if (txError || !txRow) {
    throw new Error(txError?.message ?? "Failed to record transaction");
  }

  if (options?.realtime) {
    await options.realtime.walletChanged(userId, options.walletReason ?? kind, {
      creditsBalance: balance,
      transaction: {
        id: txRow.id,
        amountCredits: Number(txRow.amount_credits),
        kind: txRow.kind as CreditKind,
        description: txRow.description,
        sideBetId: txRow.side_bet_id,
        createdAt: txRow.created_at
      }
    });
  }

  return { balance, transactionId: txRow.id };
}

export async function getCreditsBalance(userId: string): Promise<number> {
  const { data, error } = await supabaseAdmin.from("profiles").select("credits_balance").eq("id", userId).single();
  if (error || !data) throw new Error("Profile not found");
  return Number(data.credits_balance);
}
