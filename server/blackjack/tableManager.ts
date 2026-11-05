import { randomUUID } from "node:crypto";
import type { Server } from "socket.io";
import type { WalletRealtime } from "../credits.js";
import { adjustCredits, getCreditsBalance } from "../credits.js";
import { isApprovedGroupMember } from "../groupsAccess.js";
import { supabaseAdmin } from "../supabase.js";

export type BlackjackRealtime = WalletRealtime & {
  blackjackLobby: (groupId: string) => void;
};
import { type Card, draw, freshShoe, handValue, isBlackjack } from "./cards.js";

export const MAX_SEATS = 7;
export const PRACTICE_START_CHIPS = 1000;
const TURN_LIMIT_MS = 20_000;
const SEAT_IDLE_MS = 45_000;

export type TableMode = "live" | "practice";
export type TablePhase = "open" | "betting" | "playing" | "dealer" | "finished";
export type SeatStatus = "idle" | "betting" | "acting" | "stood" | "bust" | "blackjack" | "done";

type Seat = {
  userId: string;
  displayName: string;
  seatIndex: number;
  bet: number;
  hand: Card[];
  status: SeatStatus;
  practiceChips: number;
  lastActionAt: number;
};

type InternalTable = {
  id: string;
  groupId: string;
  mode: TableMode;
  title: string;
  dealerUserId: string | null;
  dealerName: string;
  dealerBankroll: number;
  dealerAway: boolean;
  minBet: number;
  maxBet: number;
  maxSeats: number;
  phase: TablePhase;
  round: number;
  seats: Seat[];
  deck: Card[];
  dealerHand: Card[];
  dealerHoleHidden: boolean;
  activeSeatIndex: number | null;
  turnStartedAt: number | null;
  dealDeadlineAt: number | null;
  createdAt: number;
  lastRoundResults: RoundResult[];
};

export type RoundResult = {
  userId: string;
  outcome: "win" | "lose" | "push" | "blackjack" | "bust";
  bet: number;
  payout: number;
  net: number;
};

export type PublicCard = { suit: string; rank: number; label: string };

export type PublicSeat = {
  userId: string;
  displayName: string;
  seatIndex: number;
  bet: number;
  hand: PublicCard[];
  handTotal: number | null;
  status: SeatStatus;
  practiceChips: number | null;
  idleEndsAt: number | null;
};

export type PublicTable = {
  id: string;
  groupId: string;
  mode: TableMode;
  title: string;
  dealerUserId: string | null;
  dealerName: string;
  dealerAway: boolean;
  dealerBankroll: number | null;
  minBet: number;
  maxBet: number;
  maxSeats: number;
  seatedCount: number;
  phase: TablePhase;
  round: number;
  seats: PublicSeat[];
  dealerHand: PublicCard[];
  dealerTotal: number | null;
  activeSeatIndex: number | null;
  turnEndsAt: number | null;
  dealStartsAt: number | null;
  lastRoundResults: RoundResult[];
};

function toPublicCard(card: Card): PublicCard {
  const ranks: Record<number, string> = { 11: "A", 12: "Q", 13: "K" };
  const label =
    card.rank >= 10 && card.rank <= 13 ? `${ranks[card.rank] ?? card.rank}${card.suit[0]}` : `${card.rank}${card.suit[0]}`;
  return { suit: card.suit, rank: card.rank, label: label.toUpperCase() };
}

function publicTable(table: InternalTable): PublicTable {
  const hideHole = table.dealerHoleHidden && table.phase !== "finished";
  const dealerHand = table.dealerHand.map((c, i) => {
    if (hideHole && i === 1) return { suit: "hidden", rank: 0, label: "?" };
    return toPublicCard(c);
  });
  const dealerTotal =
    hideHole && table.dealerHand.length > 0
      ? handValue([table.dealerHand[0]]).total
      : table.dealerHand.length
        ? handValue(table.dealerHand).total
        : null;

  return {
    id: table.id,
    groupId: table.groupId,
    mode: table.mode,
    title: table.title,
    dealerUserId: table.dealerUserId,
    dealerName: table.dealerName,
    dealerAway: table.mode === "live" ? table.dealerAway : false,
    dealerBankroll: table.mode === "live" ? table.dealerBankroll : null,
    minBet: table.minBet,
    maxBet: table.maxBet,
    maxSeats: table.maxSeats,
    seatedCount: table.seats.length,
    phase: table.phase,
    round: table.round,
    seats: table.seats.map((seat) => ({
      userId: seat.userId,
      displayName: seat.displayName,
      seatIndex: seat.seatIndex,
      bet: seat.bet,
      hand: seat.hand.map(toPublicCard),
      handTotal: seat.hand.length ? handValue(seat.hand).total : null,
      status: seat.status,
      practiceChips: table.mode === "practice" ? seat.practiceChips : null,
      idleEndsAt:
        (table.phase === "open" || table.phase === "betting") && seat.bet <= 0 ? seat.lastActionAt + SEAT_IDLE_MS : null
    })),
    dealerHand,
    dealerTotal,
    activeSeatIndex: table.activeSeatIndex,
    turnEndsAt: table.phase === "playing" && table.turnStartedAt != null ? table.turnStartedAt + TURN_LIMIT_MS : null,
    dealStartsAt: table.phase === "betting" ? table.dealDeadlineAt : null,
    lastRoundResults: table.lastRoundResults
  };
}

export class BlackjackTableManager {
  private tables = new Map<string, InternalTable>();
  /** Seated players (and host while at the table). */
  private userTable = new Map<string, string>();
  /** Live table bankroll owner — stays until table closes. */
  private hostByUser = new Map<string, string>();
  private bettingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private io: Server | null = null;
  private practiceCounter = new Map<string, number>();

  constructor(private realtime: BlackjackRealtime) {
    void this.hydrate();
    setInterval(() => this.sweepInactive(), 5_000);
  }

  private async hydrate() {
    const { data, error } = await supabaseAdmin.from("blackjack_tables").select("state");
    if (error) {
      console.error("Could not load blackjack tables:", error.message);
      return;
    }
    for (const row of data ?? []) {
      const table = row.state as InternalTable;
      if (!table?.id || table.mode !== "live") continue;
      this.tables.set(table.id, table);
      if (table.dealerUserId) this.hostByUser.set(table.dealerUserId, table.id);
      for (const seat of table.seats) this.userTable.set(seat.userId, table.id);
      this.restoreDealTimer(table);
    }
  }

  private async persist(table: InternalTable) {
    if (table.mode !== "live" || table.phase === "finished") return;
    const { error } = await supabaseAdmin.from("blackjack_tables").upsert({
      id: table.id,
      group_id: table.groupId,
      state: table,
      updated_at: new Date().toISOString()
    });
    if (error) throw new Error(error.message);
  }

  private async forgetPersisted(tableId: string) {
    const { error } = await supabaseAdmin.from("blackjack_tables").delete().eq("id", tableId);
    if (error) console.error("Could not remove blackjack table:", error.message);
  }

  private restoreDealTimer(table: InternalTable) {
    if (table.mode !== "live" || table.phase !== "betting" || table.dealDeadlineAt == null) return;
    const wait = Math.max(0, table.dealDeadlineAt - Date.now());
    const tableId = table.id;
    const timer = setTimeout(() => {
      this.bettingTimers.delete(tableId);
      const current = this.tables.get(tableId);
      if (!current || current.phase !== "betting" || current.mode !== "live") return;
      if (!current.seats.some((s) => s.bet > 0)) return;
      void this.runLiveDeal(tableId);
    }, wait);
    this.bettingTimers.set(tableId, timer);
  }

  attachIo(io: Server) {
    this.io = io;
  }

  private spawnPracticeTable(groupId: string) {
    const next = (this.practiceCounter.get(groupId) ?? 0) + 1;
    this.practiceCounter.set(groupId, next);
    const id = randomUUID();
    this.tables.set(id, {
      id,
      groupId,
      mode: "practice",
      title: `Practice table ${next}`,
      dealerUserId: null,
      dealerName: "CPU Dealer",
      dealerBankroll: 0,
      dealerAway: false,
      minBet: 5,
      maxBet: 100,
      maxSeats: MAX_SEATS,
      phase: "open",
      round: 0,
      seats: [],
      deck: [],
      dealerHand: [],
      dealerHoleHidden: true,
      activeSeatIndex: null,
      turnStartedAt: null,
      dealDeadlineAt: null,
      createdAt: Date.now(),
      lastRoundResults: []
    });
  }

  listLobby(groupId: string): PublicTable[] {
    return [...this.tables.values()]
      .filter((t) => t.groupId === groupId && t.phase !== "finished")
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((t) => publicTable(t));
  }

  getTableForUser(userId: string): PublicTable | null {
    const id = this.userTable.get(userId) ?? this.hostByUser.get(userId);
    if (!id) return null;
    const table = this.tables.get(id);
    return table ? publicTable(table) : null;
  }

  getPublicTable(tableId: string): PublicTable | null {
    const table = this.tables.get(tableId);
    return table ? publicTable(table) : null;
  }

  private emitLobby(groupId: string) {
    this.io?.to(`blackjack:lobby:${groupId}`).emit("blackjack:lobby", this.listLobby(groupId));
  }

  private emitTable(table: InternalTable) {
    void this.persist(table).catch((error: unknown) => {
      console.error("Could not save blackjack table:", error instanceof Error ? error.message : error);
    });
    this.io?.to(`blackjack:table:${table.id}`).emit("blackjack:state", publicTable(table));
    this.emitLobby(table.groupId);
  }

  private findSeat(table: InternalTable, userId: string) {
    return table.seats.find((s) => s.userId === userId);
  }

  private nextOpenSeat(table: InternalTable): number | null {
    const taken = new Set(table.seats.map((s) => s.seatIndex));
    for (let i = 0; i < table.maxSeats; i += 1) {
      if (!taken.has(i)) return i;
    }
    return null;
  }

  async createLiveTable(
    userId: string,
    displayName: string,
    input: { title: string; minBet: number; maxBet: number; bankroll: number; groupId: string },
    isPlatformAdmin: boolean
  ) {
    if (!(await isApprovedGroupMember(userId, input.groupId, isPlatformAdmin))) {
      throw new Error("You must be an approved member of this group");
    }
    if (this.userTable.has(userId)) throw new Error("Leave your current table first");
    if (input.minBet < 1 || input.maxBet < input.minBet) throw new Error("Invalid bet limits");
    if (input.bankroll < input.maxBet * 3) throw new Error("Bankroll should cover at least a few max bets");

    await adjustCredits(userId, -input.bankroll, "buy_in", `Dealer bankroll: ${input.title}`, {
      realtime: this.realtime,
      walletReason: "dealer-bankroll"
    });

    const id = randomUUID();
    const table: InternalTable = {
      id,
      groupId: input.groupId,
      mode: "live",
      title: input.title.trim().slice(0, 80) || "Blackjack table",
      dealerUserId: userId,
      dealerName: displayName,
      dealerBankroll: input.bankroll,
      dealerAway: false,
      minBet: input.minBet,
      maxBet: input.maxBet,
      maxSeats: MAX_SEATS,
      phase: "betting",
      round: 0,
      seats: [],
      deck: [],
      dealerHand: [],
      dealerHoleHidden: true,
      activeSeatIndex: null,
      turnStartedAt: null,
      dealDeadlineAt: null,
      createdAt: Date.now(),
      lastRoundResults: []
    };
    this.tables.set(id, table);
    try {
      await this.persist(table);
    } catch (error) {
      this.tables.delete(id);
      await adjustCredits(userId, input.bankroll, "payout", `Dealer bankroll returned: ${table.title}`, {
        realtime: this.realtime,
        walletReason: "dealer-bankroll-return"
      });
      throw new Error(error instanceof Error ? error.message : "Could not save the table");
    }
    this.hostByUser.set(userId, id);
    this.userTable.set(userId, id);
    this.emitTable(table);
    return publicTable(table);
  }

  async joinPractice(userId: string, displayName: string, groupId: string, isPlatformAdmin: boolean) {
    if (!(await isApprovedGroupMember(userId, groupId, isPlatformAdmin))) {
      throw new Error("You must be an approved member of this group");
    }
    if (this.userTable.has(userId)) throw new Error("Leave your current table first");
    let target = [...this.tables.values()].find(
      (t) => t.mode === "practice" && t.groupId === groupId && t.phase !== "finished" && t.seats.length < t.maxSeats
    );
    if (!target) {
      this.spawnPracticeTable(groupId);
      target = [...this.tables.values()].find(
        (t) => t.mode === "practice" && t.groupId === groupId && t.phase !== "finished" && t.seats.length < t.maxSeats
      );
    }
    if (!target) throw new Error("No practice table available");
    return this.joinTable(userId, displayName, target.id, isPlatformAdmin);
  }

  async joinTable(userId: string, displayName: string, tableId: string, isPlatformAdmin: boolean) {
    if (this.userTable.has(userId)) throw new Error("Leave your current table first");
    const table = this.tables.get(tableId);
    if (!table || table.phase === "finished") throw new Error("Table not found");
    if (!(await isApprovedGroupMember(userId, table.groupId, isPlatformAdmin))) {
      throw new Error("You must be an approved member of this group");
    }
    if (table.dealerUserId === userId) throw new Error("Dealer cannot take a seat");
    if (table.seats.length >= table.maxSeats) throw new Error("Table is full");
    const seatIndex = this.nextOpenSeat(table);
    if (seatIndex === null) throw new Error("Table is full");

    table.seats.push({
      userId,
      displayName,
      seatIndex,
      bet: 0,
      hand: [],
      status: "idle",
      practiceChips: table.mode === "practice" ? PRACTICE_START_CHIPS : 0,
      lastActionAt: Date.now()
    });
    this.userTable.set(userId, tableId);
    if (table.mode === "practice") {
      table.phase = "betting";
    } else if (table.mode === "live" && (table.phase === "open" || table.lastRoundResults.length > 0)) {
      table.phase = "betting";
      table.lastRoundResults = [];
    }
    this.emitTable(table);
    return publicTable(table);
  }

  /** Host steps away; table keeps running on their bankroll. */
  leaveHost(userId: string) {
    const tableId = this.hostByUser.get(userId);
    if (!tableId) throw new Error("You are not hosting a table");
    const table = this.tables.get(tableId);
    if (!table || table.dealerUserId !== userId) throw new Error("Not your table");
    if (table.phase === "playing" || table.phase === "dealer") {
      throw new Error("Wait for the current round to finish");
    }
    table.dealerAway = true;
    this.userTable.delete(userId);
    this.emitTable(table);
  }

  leaveTable(userId: string) {
    const tableId = this.userTable.get(userId);
    if (!tableId) return;
    const table = this.tables.get(tableId);
    if (!table) {
      this.userTable.delete(userId);
      return;
    }
    if (table.dealerUserId === userId && table.mode === "live") {
      this.leaveHost(userId);
      return;
    }
    if (table.phase !== "open" && table.phase !== "betting") throw new Error("Wait for the round to finish");
    table.seats = table.seats.filter((s) => s.userId !== userId);
    this.userTable.delete(userId);
    this.emitTable(table);
    this.maybeScheduleLiveDeal(table);
  }

  private clearBettingTimer(tableId: string) {
    const t = this.bettingTimers.get(tableId);
    if (t) clearTimeout(t);
    this.bettingTimers.delete(tableId);
    const table = this.tables.get(tableId);
    if (table) table.dealDeadlineAt = null;
  }

  private maybeScheduleLiveDeal(table: InternalTable) {
    if (table.mode !== "live" || table.phase !== "betting") return;
    const seated = table.seats.length;
    if (seated === 0) return;

    const withBet = table.seats.filter((s) => s.bet > 0);
    if (withBet.length === 0) return;

    if (withBet.length === seated) {
      this.clearBettingTimer(table.id);
      void this.runLiveDeal(table.id);
      return;
    }

    this.clearBettingTimer(table.id);
    const tableId = table.id;
    table.dealDeadlineAt = Date.now() + 8000;
    const timer = setTimeout(() => {
      this.bettingTimers.delete(tableId);
      const current = this.tables.get(tableId);
      if (!current || current.phase !== "betting" || current.mode !== "live") return;
      if (!current.seats.some((s) => s.bet > 0)) return;
      void this.runLiveDeal(tableId);
    }, 8000);
    this.bettingTimers.set(tableId, timer);
    this.emitTable(table);
  }

  private emitTableError(table: InternalTable, message: string) {
    this.io?.to(`blackjack:table:${table.id}`).emit("blackjack:error", { message });
  }

  private async runLiveDeal(tableId: string) {
    const table = this.tables.get(tableId);
    if (!table || table.mode !== "live" || table.phase !== "betting") return;
    try {
      await this.dealCards(table, false);
    } catch (err) {
      console.error("Live deal failed:", err);
      const message = err instanceof Error ? err.message : "Deal failed";
      for (const seat of table.seats) {
        if (seat.bet <= 0 || table.mode !== "live") continue;
        try {
          await adjustCredits(seat.userId, seat.bet, "adjustment", `Bet refunded — ${message}`, {
          realtime: this.realtime,
          walletReason: "blackjack-bet-refund"
        });
        } catch (refundErr) {
          console.error("Bet refund failed:", refundErr);
        }
        seat.bet = 0;
        seat.status = "idle";
      }
      table.phase = "betting";
      this.emitTable(table);
      this.emitTableError(table, message);
    }
  }

  private async closeLiveTable(table: InternalTable, reason: string) {
    this.clearBettingTimer(table.id);
    const ownerId = table.dealerUserId;
    if (ownerId && table.dealerBankroll > 0) {
      await adjustCredits(ownerId, table.dealerBankroll, "payout", `Table closed (${reason}): ${table.title}`, {
        realtime: this.realtime,
        walletReason: "dealer-bankroll-return"
      });
    }
    for (const seat of table.seats) {
      this.userTable.delete(seat.userId);
    }
    if (ownerId) {
      this.hostByUser.delete(ownerId);
      this.userTable.delete(ownerId);
    }
    table.phase = "finished";
    table.dealerBankroll = 0;
    await this.forgetPersisted(table.id);
    this.emitTable(table);
    this.tables.delete(table.id);
  }

  async endTable(dealerUserId: string) {
    const tableId = this.hostByUser.get(dealerUserId);
    if (!tableId) throw new Error("You are not hosting a table");
    const table = this.tables.get(tableId);
    if (!table || table.dealerUserId !== dealerUserId) throw new Error("Not your table");
    if (table.phase === "playing" || table.phase === "dealer") {
      throw new Error("Finish the current round first");
    }
    await this.closeLiveTable(table, "host-closed");
  }

  async placeBet(userId: string, amount: number) {
    if (!Number.isFinite(amount)) throw new Error("Invalid bet amount");
    amount = Math.floor(amount);
    const table = this.getInternal(userId);
    if (table.phase !== "betting") throw new Error("Not accepting bets");
    const seat = this.findSeat(table, userId);
    if (!seat) throw new Error("Take a seat first");
    if (seat.bet > 0) throw new Error("You already have a bet this round");
    if (amount < table.minBet || amount > table.maxBet) throw new Error(`Bet must be between ${table.minBet} and ${table.maxBet}`);
    if (table.mode === "practice") {
      if (seat.practiceChips < amount) throw new Error("Not enough practice chips");
      seat.practiceChips -= amount;
    } else {
      const balance = await getCreditsBalance(userId);
      if (balance < amount) throw new Error("Not enough credits — request chips in Wallet or ask an admin");
      if (table.dealerBankroll < table.minBet) {
        throw new Error("Table bankroll is depleted");
      }
      await adjustCredits(userId, -amount, "buy_in", `Blackjack bet at ${table.title}`, {
        realtime: this.realtime,
        walletReason: "blackjack-bet"
      });
    }
    seat.bet = amount;
    seat.status = "betting";
    seat.lastActionAt = Date.now();
    this.emitTable(table);
    if (table.mode === "practice") {
      const ready = table.seats.length > 0 && table.seats.every((s) => s.bet > 0);
      if (ready) void this.dealCards(table, false).catch((err) => console.error(err));
    } else {
      this.maybeScheduleLiveDeal(table);
    }
  }

  startBetting(dealerUserId: string) {
    const table = this.getInternalHostOrSeat(dealerUserId);
    if (table.dealerUserId !== dealerUserId) throw new Error("Only the host can control the table");
    if (table.phase !== "open" && table.phase !== "betting") throw new Error("Round in progress");
    table.phase = "betting";
    table.lastRoundResults = [];
    for (const seat of table.seats) {
      seat.bet = 0;
      seat.hand = [];
      seat.status = "idle";
    }
    table.dealerHand = [];
    this.emitTable(table);
  }

  async dealRound(dealerUserId: string) {
    const table = this.getInternalHostOrSeat(dealerUserId);
    if (table.dealerUserId !== dealerUserId) throw new Error("Only the host can deal");
    if (table.phase !== "betting") throw new Error("Open betting first");
    if (!table.seats.some((s) => s.bet > 0)) throw new Error("Need at least one bet");
    this.clearBettingTimer(table.id);
    await this.dealCards(table, false);
  }

  private async dealCards(table: InternalTable, chargeLiveBets: boolean) {
    this.clearBettingTimer(table.id);
    table.lastRoundResults = [];
    table.dealerHand = [];
    for (const seat of table.seats) {
      seat.hand = [];
    }

    const bettingSeats = table.seats.filter((s) => s.bet > 0);
    if (bettingSeats.length === 0) throw new Error("Need at least one bet");

    if (chargeLiveBets && table.mode === "live") {
      for (const seat of bettingSeats) {
        await adjustCredits(seat.userId, -seat.bet, "buy_in", `Blackjack bet at ${table.title}`, {
          realtime: this.realtime,
          walletReason: "blackjack-bet"
        });
      }
    }

    table.deck = freshShoe(6);
    table.dealerHand = [];
    table.round += 1;
    table.dealerHoleHidden = true;

    for (const seat of table.seats) {
      seat.hand = [];
      if (seat.bet <= 0) {
        seat.status = "idle";
        continue;
      }
      seat.hand.push(draw(table.deck), draw(table.deck));
      seat.status = isBlackjack(seat.hand) ? "blackjack" : "acting";
    }

    table.dealerHand.push(draw(table.deck), draw(table.deck));
    table.phase = "playing";
    table.activeSeatIndex = this.nextActingSeat(table);
    table.turnStartedAt = table.activeSeatIndex === null ? null : Date.now();

    this.emitTable(table);

    if (table.activeSeatIndex === null) {
      await this.playDealer(table);
    }
  }

  private nextActingSeat(table: InternalTable): number | null {
    const seat = table.seats
      .filter((s) => s.bet > 0 && s.status === "acting")
      .sort((a, b) => a.seatIndex - b.seatIndex)[0];
    return seat?.seatIndex ?? null;
  }

  hit(userId: string) {
    const table = this.getInternal(userId);
    const seat = this.findSeat(table, userId);
    if (!seat || seat.status !== "acting") throw new Error("Not your turn");
    if (table.activeSeatIndex !== seat.seatIndex) throw new Error("Not your turn");
    seat.lastActionAt = Date.now();
    seat.hand.push(draw(table.deck));
    if (handValue(seat.hand).total > 21) {
      seat.status = "bust";
      this.advanceTurn(table);
    }
    this.emitTable(table);
  }

  stand(userId: string) {
    const table = this.getInternal(userId);
    const seat = this.findSeat(table, userId);
    if (!seat || seat.status !== "acting") throw new Error("Not your turn");
    if (table.activeSeatIndex !== seat.seatIndex) throw new Error("Not your turn");
    seat.lastActionAt = Date.now();
    seat.status = "stood";
    this.advanceTurn(table);
    this.emitTable(table);
  }

  private advanceTurn(table: InternalTable) {
    const order = table.seats.filter((s) => s.bet > 0).sort((a, b) => a.seatIndex - b.seatIndex);
    const currentIdx = order.findIndex((s) => s.seatIndex === table.activeSeatIndex);
    for (let i = currentIdx + 1; i < order.length; i += 1) {
      const next = order[i];
      if (next.status === "blackjack") {
        next.status = "done";
        continue;
      }
      if (next.status === "acting") {
        table.activeSeatIndex = next.seatIndex;
        table.turnStartedAt = Date.now();
        return;
      }
    }
    table.activeSeatIndex = null;
    table.turnStartedAt = null;
    void this.playDealer(table).catch((err) => {
      console.error("playDealer failed:", err);
      this.emitTableError(table, err instanceof Error ? err.message : "Round failed");
    });
  }

  private async playDealer(table: InternalTable) {
    table.phase = "dealer";
    table.dealerHoleHidden = false;
    table.activeSeatIndex = null;
    table.turnStartedAt = null;
    this.emitTable(table);
    while (handValue(table.dealerHand).total < 17) {
      table.dealerHand.push(draw(table.deck));
    }

    const dealerTotal = handValue(table.dealerHand).total;
    const dealerBj = isBlackjack(table.dealerHand) && table.dealerHand.length === 2;
    const results: RoundResult[] = [];

    for (const seat of table.seats) {
      if (seat.bet <= 0) continue;

      if (seat.status === "bust") {
        results.push({
          userId: seat.userId,
          outcome: "bust",
          bet: seat.bet,
          payout: 0,
          net: -seat.bet
        });
        if (table.mode === "live") {
          table.dealerBankroll += seat.bet;
        }
        seat.status = "done";
        continue;
      }

      const playerTotal = handValue(seat.hand).total;
      const playerBj = seat.status === "blackjack" || isBlackjack(seat.hand);
      let payout = 0;
      let outcome: RoundResult["outcome"] = "lose";

      if (playerBj && !dealerBj) {
        payout = seat.bet * 2.5;
        outcome = "blackjack";
      } else if (dealerBj && !playerBj) {
        payout = 0;
        outcome = "lose";
      } else if (playerTotal > 21) {
        payout = 0;
        outcome = "lose";
      } else if (dealerTotal > 21) {
        payout = seat.bet * 2;
        outcome = "win";
      } else if (playerTotal > dealerTotal) {
        payout = seat.bet * 2;
        outcome = "win";
      } else if (playerTotal === dealerTotal) {
        payout = seat.bet;
        outcome = "push";
      } else {
        payout = 0;
        outcome = "lose";
      }

      const profit = payout - seat.bet;
      results.push({
        userId: seat.userId,
        outcome,
        bet: seat.bet,
        payout,
        net: profit
      });

      if (table.mode === "live") {
        if (payout > 0) {
          await adjustCredits(seat.userId, payout, "payout", `Blackjack result at ${table.title}`, {
            realtime: this.realtime,
            walletReason: "blackjack-payout"
          });
        }
        table.dealerBankroll -= profit;
        if (table.dealerBankroll < 0) table.dealerBankroll = 0;
      } else {
        seat.practiceChips += payout;
      }
      seat.status = "done";
    }

    table.lastRoundResults = results;

    if (table.mode === "live") {
      if (table.dealerBankroll <= 0 || table.dealerBankroll < table.minBet) {
        this.emitTable(table);
        await this.closeLiveTable(table, "bankroll-empty");
        return;
      }
      table.phase = "betting";
      for (const seat of table.seats) {
        seat.bet = 0;
        seat.status = "idle";
        seat.lastActionAt = Date.now();
      }
    } else if (table.mode === "practice" && table.seats.length > 0) {
      table.phase = "betting";
      for (const seat of table.seats) {
        seat.bet = 0;
        seat.status = "idle";
        seat.lastActionAt = Date.now();
      }
    } else {
      table.phase = "open";
    }
    this.emitTable(table);
    if (table.mode === "live" && table.seats.length > 0) {
      this.maybeScheduleLiveDeal(table);
    }
  }

  private sweepInactive() {
    const now = Date.now();
    for (const table of this.tables.values()) {
      if (table.phase === "playing" && table.turnStartedAt != null && now - table.turnStartedAt >= TURN_LIMIT_MS) {
        const seat = table.seats.find((s) => s.seatIndex === table.activeSeatIndex && s.status === "acting");
        if (seat) {
          try {
            this.stand(seat.userId);
            this.emitTableError(table, `${seat.displayName} stood — no action in time`);
          } catch (err) {
            console.error("Turn timeout failed:", err);
          }
        }
      }

      if (table.phase !== "open" && table.phase !== "betting") continue;
      const idle = table.seats.filter((seat) => seat.bet <= 0 && now - seat.lastActionAt >= SEAT_IDLE_MS);
      if (idle.length === 0) continue;
      for (const seat of idle) {
        table.seats = table.seats.filter((s) => s.userId !== seat.userId);
        this.userTable.delete(seat.userId);
        this.io?.to(`user:${seat.userId}`).emit("blackjack:kicked", {
          tableId: table.id,
          message: "You were removed from the table for inactivity"
        });
      }
      this.emitTable(table);
      this.emitTableError(table, `${idle.map((s) => s.displayName).join(", ")} left — inactive`);
      this.maybeScheduleLiveDeal(table);
    }
  }

  private getInternal(userId: string): InternalTable {
    const tableId = this.userTable.get(userId);
    if (!tableId) throw new Error("Join a table first");
    const table = this.tables.get(tableId);
    if (!table) throw new Error("Table not found");
    return table;
  }

  private getInternalHostOrSeat(userId: string): InternalTable {
    const tableId = this.userTable.get(userId) ?? this.hostByUser.get(userId);
    if (!tableId) throw new Error("Join a table first");
    const table = this.tables.get(tableId);
    if (!table) throw new Error("Table not found");
    return table;
  }

  watchTable(tableId: string, socketId: string, io: Server) {
    io.sockets.sockets.get(socketId)?.join(`blackjack:table:${tableId}`);
  }

  unwatchTable(tableId: string, socketId: string, io: Server) {
    io.sockets.sockets.get(socketId)?.leave(`blackjack:table:${tableId}`);
  }

  joinLobby(socketId: string, groupId: string, io: Server) {
    io.sockets.sockets.get(socketId)?.join(`blackjack:lobby:${groupId}`);
  }

  lobbyRoomForGroup(groupId: string) {
    return `blackjack:lobby:${groupId}`;
  }

  getLiveTableCount() {
    return [...this.tables.values()].filter((t) => t.mode === "live" && t.phase !== "finished").length;
  }
}
