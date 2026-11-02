import { createHmac } from "node:crypto";
import { config } from "./config.js";
import { supabaseAdmin } from "./supabase.js";

type WalletDetail = {
  creditsBalance: number;
  transaction: {
    id: string;
    userId: string;
    amountCredits: number;
    kind: "deposit" | "withdrawal" | "adjustment" | "buy_in" | "payout" | "fee";
    description: string;
    sideBetId: string | null;
    createdAt: string;
  };
};

type RealtimeNotifier = {
  sideBetChanged: (betId: string, reason: string) => Promise<void>;
  walletChanged: (userIds: string | string[], reason: string, detail?: WalletDetail) => Promise<void>;
  coinFlipChanged: () => Promise<void>;
};

/** Diaconis, Holmes, Montgomery: caught flip lands the starting face about 51% of the time. */
export const SAME_FACE_PROBABILITY = 0.51;
/** Murray and Teare (1993): a US nickel lands on edge about 1 in 6000 tosses onto a surface. */
export const EDGE_PROBABILITY = 1 / 6000;
export const COIN_FLIP_SOURCE = "sidebets:coin-flip";
export const COIN_FLIP_BUY_IN = 1;
export const WINDOW_MS = 60 * 1000;

export type CoinFace = "heads" | "tails";
export type CoinOutcome = CoinFace | "edge";

export const COIN_OPTIONS = [
  { id: "heads", label: "Heads" },
  { id: "tails", label: "Tails" },
  { id: "edge", label: "Edge" }
];

export function currentWindow(now = Date.now()) {
  const starts = Math.floor(now / WINDOW_MS) * WINDOW_MS;
  return { startsAt: new Date(starts).toISOString(), closesAt: new Date(starts + WINDOW_MS).toISOString(), startsMs: starts };
}

export function startFaceForWindow(startsMs: number): CoinFace {
  return Math.floor(startsMs / 1000) % 2 === 0 ? "heads" : "tails";
}

/**
 * Edge is drawn first (1/6000). The remaining probability is split 0.51 / 0.49
 * toward the face that was up when the toss started (Diaconis et al.).
 */
export function sampleCoinOutcome(startFace: CoinFace, random = Math.random): CoinOutcome {
  const roll = random();
  if (roll < EDGE_PROBABILITY) return "edge";
  const withinFaces = (roll - EDGE_PROBABILITY) / (1 - EDGE_PROBABILITY);
  if (withinFaces < SAME_FACE_PROBABILITY) return startFace;
  return startFace === "heads" ? "tails" : "heads";
}

/** Bets lock this long before the close. The result is revealed from then on. */
export const LOCK_MS = 10_000;

/**
 * The result for a window, fixed in advance but secret. It is a keyed hash of
 * the window start, run through the same odds as before, so it can be revealed
 * when bets lock (letting every browser flick exactly at the close) and the
 * settlement later uses the same value. Stakes are refused once bets lock, so
 * knowing the result then gives no edge.
 */
export function outcomeForWindow(startsMs: number): CoinOutcome {
  const digest = createHmac("sha256", config.coinFlipSecret).update(`coin-flip:${new Date(startsMs).toISOString()}`).digest();
  const roll = digest.readUIntBE(0, 6) / 2 ** 48;
  return sampleCoinOutcome(startFaceForWindow(startsMs), () => roll);
}

/** The window's result once bets have locked, otherwise null. */
function revealedOutcome(startsMs: number, now = Date.now()) {
  return now >= startsMs + WINDOW_MS - LOCK_MS ? outcomeForWindow(startsMs) : null;
}

type FlipRow = {
  id: string;
  status: string;
  starts_at: string;
  closes_at: string;
  winning_option_id: string | null;
  options: { id: string; label: string }[];
};

async function adjustCredits(userId: string, delta: number) {
  const { data, error } = await supabaseAdmin.rpc("adjust_credits", { p_user_id: userId, p_delta: delta });
  if (error || data === null || data === undefined) throw new Error(error?.message ?? "Not enough credits");
  return Number(data);
}

async function findWindowBet(startsAt: string) {
  const { data, error } = await supabaseAdmin
    .from("side_bets")
    .select("id, status, starts_at, closes_at, winning_option_id, options")
    .eq("source_url", COIN_FLIP_SOURCE)
    .eq("starts_at", startsAt)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data as FlipRow | null;
}

export async function getCoinFlipState(userId: string) {
  const window = currentWindow();
  const startFace = startFaceForWindow(window.startsMs);
  const previousStartsMs = window.startsMs - WINDOW_MS;
  const previousStartsAt = new Date(previousStartsMs).toISOString();
  // The window that just closed, so clients can play its result after rolling over.
  const [bet, previousBet] = await Promise.all([findWindowBet(window.startsAt), findWindowBet(previousStartsAt)]);
  let counts = { heads: 0, tails: 0, edge: 0 };
  let myOption: string | null = null;

  if (bet) {
    const { data: entries, error } = await supabaseAdmin
      .from("bet_entries")
      .select("user_id, option_id")
      .eq("side_bet_id", bet.id);
    if (error) throw new Error(error.message);
    for (const entry of entries ?? []) {
      const option = entry.option_id as CoinOutcome;
      if (option === "heads" || option === "tails" || option === "edge") {
        counts[option] += 1;
      }
      if (entry.user_id === userId) myOption = entry.option_id;
    }
  }

  return {
    buyInCredits: COIN_FLIP_BUY_IN,
    startsAt: window.startsAt,
    closesAt: window.closesAt,
    startFace,
    sideBetId: bet?.id ?? null,
    status: bet?.status ?? "awaiting-stakes",
    winningOptionId: bet?.winning_option_id ?? null,
    counts,
    myOption,
    result: revealedOutcome(window.startsMs),
    previous: {
      startsAt: previousStartsAt,
      closesAt: window.startsAt,
      startFace: startFaceForWindow(previousStartsMs),
      sideBetId: previousBet?.id ?? null,
      status: previousBet?.status ?? "no-stakes",
      winningOptionId: (previousBet?.winning_option_id as CoinOutcome | null | undefined) ?? null,
      result: outcomeForWindow(previousStartsMs)
    },
    model: {
      sameFaceProbability: SAME_FACE_PROBABILITY,
      edgeProbability: EDGE_PROBABILITY,
      note: "Same-face bias from Diaconis, Holmes, and Montgomery. Edge rate from Murray and Teare for a nickel landing on a surface."
    }
  };
}

function coinFlipPayload(input: {
  startsAt: string;
  closesAt: string;
  startFace: CoinFace;
  sideBetId: string | null;
  status: string;
  winningOptionId: string | null;
  counts: { heads: number; tails: number; edge: number };
  myOption: string | null;
}) {
  return {
    buyInCredits: COIN_FLIP_BUY_IN,
    ...input,
    model: {
      sameFaceProbability: SAME_FACE_PROBABILITY,
      edgeProbability: EDGE_PROBABILITY,
      note: "Same-face bias from Diaconis, Holmes, and Montgomery. Edge rate from Murray and Teare for a nickel landing on a surface."
    }
  };
}

function countEntries(entries: { user_id: string; option_id: string }[], userId: string) {
  const counts = { heads: 0, tails: 0, edge: 0 };
  let myOption: string | null = null;
  for (const entry of entries) {
    const option = entry.option_id as CoinOutcome;
    if (option === "heads" || option === "tails" || option === "edge") counts[option] += 1;
    if (entry.user_id === userId) myOption = entry.option_id;
  }
  return { counts, myOption };
}

export async function stakeCoinFlip(userId: string, optionId: CoinOutcome, realtime: RealtimeNotifier) {
  if (optionId !== "heads" && optionId !== "tails" && optionId !== "edge") {
    throw new Error("Pick heads, tails, or edge");
  }

  const window = currentWindow();
  const startFace = startFaceForWindow(window.startsMs);
  if (Date.now() >= new Date(window.closesAt).getTime() - LOCK_MS) {
    throw new Error("Bets are locked for the last 10 seconds");
  }

  const [betResult, profileResult] = await Promise.all([
    supabaseAdmin
      .from("side_bets")
      .select("id, status, starts_at, closes_at, winning_option_id, options, bet_entries(user_id, option_id)")
      .eq("source_url", COIN_FLIP_SOURCE)
      .eq("starts_at", window.startsAt)
      .maybeSingle(),
    supabaseAdmin.from("profiles").select("credits_balance").eq("id", userId).single()
  ]);
  if (betResult.error) throw new Error(betResult.error.message);
  if (profileResult.error || !profileResult.data) throw new Error("Profile not found");

  let bet = betResult.data;
  if (bet && bet.status !== "open") throw new Error("This flip is already settled");

  if (!bet) {
    const label = new Date(window.startsMs).toISOString().slice(11, 16);
    const created = await supabaseAdmin
      .from("side_bets")
      .insert({
        manager_id: userId,
        title: `Coin flip ${label} UTC`,
        description: `Live coin flip. Starts ${startFace}. Same face ${(SAME_FACE_PROBABILITY * 100).toFixed(0)}% of non-edge landings. Edge about 1 in ${Math.round(1 / EDGE_PROBABILITY)}.`,
        source_url: COIN_FLIP_SOURCE,
        buy_in_credits: COIN_FLIP_BUY_IN,
        house_fee_percent: 0,
        starts_at: window.startsAt,
        closes_at: window.closesAt,
        options: COIN_OPTIONS
      })
      .select("id, status, starts_at, closes_at, winning_option_id, options")
      .single();
    if (created.error || !created.data) {
      const existing = await findWindowBet(window.startsAt);
      if (!existing) throw new Error(created.error?.message ?? "Could not open the coin flip");
      bet = { ...existing, bet_entries: [] };
    } else {
      bet = { ...created.data, bet_entries: [] };
    }
  }

  const entries = (bet.bet_entries ?? []) as { user_id: string; option_id: string }[];
  const tallied = countEntries(entries, userId);
  const snapshot = (counts: typeof tallied.counts, myOption: string | null) =>
    coinFlipPayload({
      startsAt: window.startsAt,
      closesAt: window.closesAt,
      startFace,
      sideBetId: bet.id,
      status: bet.status,
      winningOptionId: bet.winning_option_id,
      counts,
      myOption
    });

  if (tallied.myOption === optionId) return snapshot(tallied.counts, optionId);

  if (tallied.myOption) {
    const previous = tallied.myOption as CoinOutcome;
    const { error } = await supabaseAdmin
      .from("bet_entries")
      .update({ option_id: optionId })
      .eq("side_bet_id", bet.id)
      .eq("user_id", userId);
    if (error) throw new Error(error.message);
    tallied.counts[previous] = Math.max(0, tallied.counts[previous] - 1);
    tallied.counts[optionId] += 1;
    void realtime.coinFlipChanged();
    return snapshot(tallied.counts, optionId);
  }

  if (Number(profileResult.data.credits_balance) < COIN_FLIP_BUY_IN) throw new Error("Not enough credits");

  const { error: entryError } = await supabaseAdmin.from("bet_entries").insert({
    side_bet_id: bet.id,
    user_id: userId,
    option_id: optionId,
    stake_credits: COIN_FLIP_BUY_IN
  });
  if (entryError) throw new Error(entryError.message);

  const [nextBalance, transactionResult] = await Promise.all([
    adjustCredits(userId, -COIN_FLIP_BUY_IN),
    supabaseAdmin
      .from("credit_transactions")
      .insert({
        user_id: userId,
        amount_credits: -COIN_FLIP_BUY_IN,
        kind: "buy_in",
        description: "Buy-in for coin flip",
        side_bet_id: bet.id,
        created_by: userId
      })
      .select("id, created_at")
      .single()
  ]);
  if (transactionResult.error || !transactionResult.data) throw new Error(transactionResult.error?.message ?? "Could not record the stake");

  const transaction = transactionResult.data;
  void realtime.walletChanged(userId, "buy-in", {
    creditsBalance: nextBalance,
    transaction: {
      id: transaction.id,
      userId,
      amountCredits: -COIN_FLIP_BUY_IN,
      kind: "buy_in",
      description: "Buy-in for coin flip",
      sideBetId: bet.id,
      createdAt: transaction.created_at
    }
  });
  void realtime.coinFlipChanged();
  tallied.counts[optionId] += 1;
  return snapshot(tallied.counts, optionId);
}

export async function settleDueCoinFlips(realtime: RealtimeNotifier) {
  const now = new Date().toISOString();
  const { data: due, error } = await supabaseAdmin
    .from("side_bets")
    .select("id, starts_at, status")
    .eq("source_url", COIN_FLIP_SOURCE)
    .eq("status", "open")
    .lte("closes_at", now);
  if (error || !due) return;

  for (const row of due) {
    const startsMs = new Date(row.starts_at).getTime();
    // The same result that was revealed when bets locked.
    const winningOptionId = outcomeForWindow(startsMs);
    const { data: entries } = await supabaseAdmin.from("bet_entries").select("*").eq("side_bet_id", row.id);
    const list = entries ?? [];
    if (list.length === 0) {
      await supabaseAdmin.from("side_bets").delete().eq("id", row.id).eq("status", "open");
      continue;
    }

    const claimed = await supabaseAdmin
      .from("side_bets")
      .update({
        status: "settled",
        winning_option_id: winningOptionId,
        settles_at: new Date().toISOString()
      })
      .eq("id", row.id)
      .eq("status", "open")
      .select("id")
      .maybeSingle();
    if (claimed.error || !claimed.data) continue;

    const winners = list.filter((entry) => entry.option_id === winningOptionId);
    const pot = list.reduce((total, entry) => total + Number(entry.stake_credits), 0);
    const everyoneWon = winners.length === list.length;
    const refunds = winners.length === 0 || everyoneWon;
    const paid = refunds ? list : winners;

    for (const entry of paid) {
      const amount = refunds ? Number(entry.stake_credits) : pot / winners.length;
      const nextBalance = await adjustCredits(entry.user_id, amount);
      const description = winners.length === 0
        ? `Coin flip refund (${winningOptionId}, no winners)`
        : everyoneWon
          ? `Coin flip stake returned (${winningOptionId})`
          : `Coin flip payout (${winningOptionId})`;
      const kind = refunds ? "adjustment" : "payout";
      const { data: transaction } = await supabaseAdmin
        .from("credit_transactions")
        .insert({
          user_id: entry.user_id,
          amount_credits: amount,
          kind,
          description,
          side_bet_id: row.id,
          created_by: entry.user_id
        })
        .select("id, created_at")
        .single();
      if (transaction) {
        await realtime.walletChanged(entry.user_id, refunds ? "refund" : "settlement", {
          creditsBalance: nextBalance,
          transaction: {
            id: transaction.id,
            userId: entry.user_id,
            amountCredits: amount,
            kind,
            description,
            sideBetId: row.id,
            createdAt: transaction.created_at
          }
        });
      }
    }

    await realtime.sideBetChanged(row.id, "settled");
    await realtime.coinFlipChanged();
  }
}
