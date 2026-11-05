import { isRedSuit, rankLabel, suitSymbol } from "../cardUtils";

type Props = {
  suit: string;
  rank: number;
  faceDown?: boolean;
  dealDelayMs?: number;
  small?: boolean;
};

export function PlayingCard({ suit, rank, faceDown = false, dealDelayMs = 0, small = false }: Props) {
  const hidden = faceDown || suit === "hidden" || rank === 0;
  const red = isRedSuit(suit);

  return (
    <div
      className={`playing-card ${hidden ? "is-facedown" : "is-faceup"} ${small ? "small" : ""} deal-in`}
      style={{ animationDelay: `${dealDelayMs}ms` }}
    >
      <div className="playing-card-inner">
        <div className="playing-card-back">
          <img src="/cards/back.svg" alt="" draggable={false} />
        </div>
        <div className={`playing-card-front ${red ? "red" : "black"}`}>
          <span className="corner top">{rankLabel(rank)}</span>
          <span className="corner top suit">{suitSymbol(suit)}</span>
          <span className="pip">{suitSymbol(suit)}</span>
          <span className="corner bottom">{rankLabel(rank)}</span>
          <span className="corner bottom suit">{suitSymbol(suit)}</span>
        </div>
      </div>
    </div>
  );
}
