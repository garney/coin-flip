export type SavedTable = {
  tableId: string;
  mode: "live" | "practice";
  groupId: string;
};

const KEY = "sidebets.blackjack.active";

export function readActiveTable(): SavedTable | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SavedTable>;
    if (!parsed.tableId || !parsed.groupId || (parsed.mode !== "live" && parsed.mode !== "practice")) return null;
    return { tableId: parsed.tableId, mode: parsed.mode, groupId: parsed.groupId };
  } catch {
    return null;
  }
}

export function saveActiveTable(table: SavedTable) {
  localStorage.setItem(KEY, JSON.stringify(table));
}

export function clearActiveTable() {
  localStorage.removeItem(KEY);
}

/** Server membership wins. A saved id only confirms we should toast a rejoin. */
export function entryMode(serverHasSeat: boolean): "table" | "entry" {
  return serverHasSeat ? "table" : "entry";
}

export function rejoinNotice(saved: SavedTable | null, table: { id: string; title: string } | null): string | null {
  if (!saved || !table || saved.tableId !== table.id) return null;
  return `Rejoined ${table.title} — your seat is held.`;
}

export function betError(amount: number, minBet: number, maxBet: number): string | null {
  if (!Number.isFinite(amount) || amount <= 0) return "Enter a bet amount";
  if (amount < minBet || amount > maxBet) return `Bet must be between ${minBet} and ${maxBet}`;
  return null;
}
