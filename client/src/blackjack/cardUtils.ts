const RANK_LABELS: Record<number, string> = {
  11: "A",
  12: "Q",
  13: "K"
};

const SUIT_SYMBOL: Record<string, string> = {
  clubs: "♣",
  diamonds: "♦",
  hearts: "♥",
  spades: "♠"
};

export function rankLabel(rank: number): string {
  if (rank === 0) return "?";
  return RANK_LABELS[rank] ?? String(rank);
}

export function suitSymbol(suit: string): string {
  if (suit === "hidden") return "?";
  return SUIT_SYMBOL[suit] ?? "•";
}

export function isRedSuit(suit: string): boolean {
  return suit === "hearts" || suit === "diamonds";
}

export type CardView = { suit: string; rank: number; label: string };

export function cardKey(card: CardView, index: number, owner: string): string {
  return `${owner}-${index}-${card.suit}-${card.rank}`;
}
