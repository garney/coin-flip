---
artifact_contract: "ce-handoff/v1"
created_at: "2026-11-02T06:15:00Z"
title: "Coin flip handover"
summary: "Live one-minute coin flip on coinflip.amongfriends.net, with socket stake and uncommitted query batching."
keywords: ["coin-flip", "supabase", "render", "cloudflare", "socket"]
cwd: "/Users/garney/Projects/coin-flip"
resume_focus: "Commit the socket stake and faster stake writes, then confirm a pick on the running server."
repository: "coin-flip"
repo_root_sha: "76451f860a10becaf4be0c8e1dc6bf1384aa1e25"
branch: "main"
head: "d9f81dd107b580c5872a4dfeef8b9528c7101686"
worktree_path: "/Users/garney/Projects/coin-flip"
---

# Coin flip handover

This is the current state of the coin-flip app for someone joining without the original chat. Setup steps for a new copy live in `TEMPLATE.md`. This file is what changed in this product and what is not committed yet.

## What the product is

One Node process serves the React app, the API, and Socket.IO on port `4123`. Sign-in is Google through Supabase Auth. The database is the Supabase project `https://aiqutwujrnbmqwpelhuu.supabase.co`. Production is a Docker web service on Render at `https://coin-flip-6uhv.onrender.com`, with the public hostname `https://coinflip.amongfriends.net`.

The user asked for a copy of the Side Bets stack focused on a live coin flip. The Side Bets repo at `/Users/garney/Documents/SideBets` was reverted and should stay free of this feature. A local Docker experiment there is still in `stash@{0}` and was not part of this product.

## How a flip works

Windows are 1 minute, aligned to the clock. `WINDOW_MS` is in `server/coinFlip.ts`. Bets lock for the last 10 seconds. The stake is 1 credit. A `side_bets` row is created only after someone stakes. If nobody stakes, nothing is stored. If the result is a side nobody picked, every stake is returned. Otherwise winners split the pot. The house fee is 0%.

The outcome is sampled on the server at settle time. Edge is drawn first at about 1 in 6,000. Of the rest, the starting face lands about 51% of the time. The starting face is deterministic from the window start. The user accepted this model.

The signed-in home screen is Coin flips: live toss in the middle, the last 30 settled flips on the left, wallet request and redeem on the right. There is no separate Flip nav item and no Create coin flip button. On a phone the coin sits under the header, the header is logo plus balance plus a menu, and the odds notes sit under the choice buttons in smaller type.

## Live updates and staking

The browser does not poll `GET /api/coin-flip`. The server emits `coin-flip:state` on the existing Socket.IO connection when the window, counts, or result change. A pick is `coin-flip:stake` on that same socket, with an acknowledgement. The balance and the new ledger row arrive as `wallet:changed` with `creditsBalance` and `transaction`, so a stake does not refetch profile, transactions, redemptions, and credit requests. The settled list reloads only when a flip settles.

The user saw a stake take about 6.7 seconds against localhost. That was sequential Supabase round trips from this machine to the remote project, not Render sleeping. The uncommitted stake function now loads the flip and the balance together, writes the balance and ledger together, and builds the reply without a second full read. The first stake in a window still inserts the flip row before the entry. Restart the local server before judging the new timing. The socket change does not remove the database wait.

## What is committed

`main` matches `origin/main` at `d9f81dd` ("Put the live flip first on a phone and document the public hostname."). That commit includes the phone layout, the header menu, and the `coinflip.amongfriends.net` notes in `TEMPLATE.md` and `README.md`.

## What is not committed

These files are modified in the working tree and are not on GitHub or Render:

- `server/coinFlip.ts` — refunds were already committed; the uncommitted part is the shorter stake query path.
- `server/socket.ts` and `server/index.ts` — `coin-flip:state` broadcast and `coin-flip:stake`.
- `server/routes.ts` — realtime notifier type includes `coinFlipChanged`.
- `client/src/App.tsx` and `client/src/CoinFlipModal.tsx` — socket state and socket stake.

`supabase/.temp/` is local CLI link data. Do not commit it. Do not commit `.env`.

## Accounts and DNS

The user owns the Cloudflare zone `amongfriends.net` and the Render service. DNS for the public site is a grey-cloud CNAME:

`coinflip` → `coin-flip-6uhv.onrender.com`

Render must list `coinflip.amongfriends.net` as a custom domain. Supabase Authentication URL configuration should use that hostname as the site URL, plus `https://coinflip.amongfriends.net/auth/callback`, and keep `http://localhost:4123`. The Google OAuth redirect stays `https://aiqutwujrnbmqwpelhuu.supabase.co/auth/v1/callback`. Google client id and secret are in the Supabase Google provider, not in the repo.

`VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are baked into the Docker image at build time. Changing them needs a new Render deploy. `ADMIN_USER_IDS` must be a user id from this Supabase project. An id copied from the old Side Bets project will not match.

Schema migrations `0001` through `0006` are already pushed to this Supabase project. Table names stay `side_bets` and `bet_entries`.

## Decisions the user made

- Drop a unique index that would have treated a flip as a special row. A flip is a normal side bet that is opened and settled automatically.
- Remove the animation test buttons.
- No countdown animation above 30 seconds. The later request was to remove the throb entirely. The countdown is static.
- Play the toss when the timer reaches 0. The animation is held after landing and should not rewind or pass through the table.
- Coin flip is its own repo, not a Side Bets feature.
- Public hostname is `coinflip.amongfriends.net`, not `.com`.
- If nobody wins, refund every stake.

## Left unfinished

The socket stake and the shorter stake writes are local only. Render is still on `d9f81dd` until those files are committed and pushed. The user has not asked for that commit yet.

Google sign-in and the custom domain were explained as dashboard steps. This session did not verify that `https://coinflip.amongfriends.net` completes login. The free Render service sleeps when idle, and the one-minute timer runs only while the process is awake.

Local verification of the phone layout stopped at the Google sign-in screen in the tool browser.
