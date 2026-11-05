/** Image assets used by playing cards — preload before first deal. */
export const CARD_IMAGE_URLS = ["/cards/back.svg"] as const;

/** Must match `.playing-card.deal-in` animation duration in styles.css */
export const DEAL_ANIM_MS = 350;

export function preloadCardAssets(): Promise<void> {
  if (typeof Image === "undefined") return Promise.resolve();

  return Promise.all(
    CARD_IMAGE_URLS.map(
      (url) =>
        new Promise<void>((resolve, reject) => {
          const img = new Image();
          img.decoding = "async";
          img.onload = () => resolve();
          img.onerror = () => reject(new Error(`Failed to preload ${url}`));
          img.src = url;
        })
    )
  ).then(() => undefined);
}
