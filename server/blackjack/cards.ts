export type Suit = "clubs" | "diamonds" | "hearts" | "spades";
export type Rank = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13;

export type Card = { suit: Suit; rank: Rank };

const SUITS: Suit[] = ["clubs", "diamonds", "hearts", "spades"];

export function freshShoe(decks = 6): Card[] {
  const cards: Card[] = [];
  for (let d = 0; d < decks; d += 1) {
    for (const suit of SUITS) {
      for (let rank = 2; rank <= 13; rank += 1) {
        cards.push({ suit, rank: rank as Rank });
      }
    }
  }
  for (let i = cards.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

export function handValue(cards: Card[]): { total: number; soft: boolean } {
  let total = 0;
  let aces = 0;
  for (const card of cards) {
    if (card.rank === 11) {
      aces += 1;
      total += 11;
    } else if (card.rank >= 10) {
      total += 10;
    } else {
      total += card.rank;
    }
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
  }
  return { total, soft: aces > 0 && total <= 21 };
}

export function isBlackjack(cards: Card[]): boolean {
  return cards.length === 2 && handValue(cards).total === 21;
}

export function draw(deck: Card[]): Card {
  const card = deck.pop();
  if (!card) throw new Error("Shoe empty");
  return card;
}

export function cardLabel(card: Card): string {
  const ranks: Record<number, string> = {
    11: "A",
    12: "Q",
    13: "K"
  };
  const r = card.rank >= 10 && card.rank <= 13 ? ranks[card.rank] ?? String(card.rank) : String(card.rank);
  return `${r}${card.suit[0].toUpperCase()}`;
}
