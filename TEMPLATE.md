# Coin flip template

Use this when standing up a new copy of this app. The product is one Node process (Express, the Vite React app, and Socket.IO) on port `4123`. Sign-in is Supabase Auth with Google. The database is Supabase Postgres. Production is a Docker web service on Render that redeploys on every push to `main`.

Do not copy secrets from an existing `.env`. Create a new Supabase project, a new Google OAuth client, and a new Render service for each copy. Do not commit `.env` or `supabase/.temp`.

The working example of this template is:

- GitHub: `https://github.com/garney/coin-flip`
- Supabase: `https://aiqutwujrnbmqwpelhuu.supabase.co`
- Local URL: `http://localhost:4123`

## What you need before starting

- A GitHub repo that is a copy of this project
- A Supabase account
- A Google account that can open Google Cloud Console
- A Render account that can connect that GitHub repo
- Node 20 or newer, and the Supabase CLI via `npx supabase`

## 1. Copy the app

Create a new repo from this one. Keep the code, `Dockerfile`, `render.yaml`, `.env.example`, and `supabase/migrations`. Leave out `.env`, `node_modules`, `dist`, and `supabase/.temp`.

Install and run it locally only after the env file exists:

```bash
npm install
npm run dev
```

The app listens on `http://localhost:4123`.

## 2. Supabase project and database

1. In Supabase, create a new project. Wait until the database is ready.
2. From **Project Settings → API**, copy:
   - Project URL
   - `anon` public key
   - `service_role` secret key
3. Write a gitignored `.env` from `.env.example`:

```bash
NODE_ENV=development
PORT=4123
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_ANON_KEY=<anon key>
SUPABASE_SERVICE_ROLE_KEY=<service role key>
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon key>
ADMIN_USER_IDS=
```

`VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` must match the server URL and anon key. The service role key stays on the server. The browser never receives it.

4. Link the CLI and push the schema. `npx supabase login` needs a real terminal. An agent cannot finish that login.

```bash
npx supabase login
npx supabase link --project-ref <project-ref>
npx supabase db push
```

Migrations `0001` through `0006` must all be applied, in order. Confirm with:

```bash
npx supabase migration list --linked
```

The tables stay named `side_bets`, `bet_entries`, `profiles`, `credit_transactions`, `credit_requests`, and `redemptions`. The live toss writes a `side_bets` row only after someone stakes 1 credit. Empty windows are not stored.

## 3. Google Cloud OAuth

Google login is not finished until these dashboard steps are done. The Cloud project can be a new one or an existing one. Each app copy needs its own OAuth client if it uses a different Supabase project, because the redirect URI is per Supabase project.

1. Open [Google Cloud Console](https://console.cloud.google.com/) and select or create a project.
2. **APIs & Services → OAuth consent screen**.
   - User type: External, unless everyone who will sign in is inside one Google Workspace.
   - App name, user support email, and developer contact email are required.
   - While the app is in testing, add each Google account under test users. Those accounts are the only ones that can sign in.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**.
   - Application type: **Web application**.
   - Authorized redirect URI, exactly:

```text
https://<project-ref>.supabase.co/auth/v1/callback
```

   Do not put `http://localhost:4123` here. Google sends the user to Supabase, and Supabase sends them back to the app.
4. Copy the client ID and client secret.
5. In Supabase, open **Authentication → Providers → Google**. Enable it and paste the client ID and secret.
6. In Supabase, open **Authentication → URL Configuration**.

For local development:

```text
Site URL: http://localhost:4123
Redirect URLs:
  http://localhost:4123
  http://localhost:4123/auth/callback
```

After the public hostname exists, add it as well. For this app that is `https://coinflip.amongfriends.net` and `https://coinflip.amongfriends.net/auth/callback`. Set the Site URL to that hostname once people sign in there. Keep the localhost URLs for local development.

7. Restart `npm run dev` and sign in with Google once. In Supabase, open **Authentication → Users**, copy that user's UUID, and set `ADMIN_USER_IDS` in `.env` to it if that person should open the admin centre. Restart the server after changing it.

## 4. Render

`render.yaml` is a Blueprint for one free Docker web service. Pushes to `main` auto-deploy. Render injects `PORT`. The process listens on `0.0.0.0`. The health check is `GET /api/health`.

1. Push the repo to GitHub.
2. In Render, choose **New → Blueprint** and connect the repo.
3. When Render asks, set the same values as `.env`:

```text
SUPABASE_URL
SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
VITE_SUPABASE_URL
VITE_SUPABASE_ANON_KEY
ADMIN_USER_IDS
```

`VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are compiled into the browser bundle while the image builds. Changing either value requires a new deploy, not only a restart.

4. Wait until the deploy is live and `https://<service>.onrender.com/api/health` returns `{"ok":true}`. This copy is `https://coin-flip-6uhv.onrender.com`.

The free service sleeps when idle. The first request after sleep is slow. The coin-flip timer runs only while the process is awake.

## 5. Custom domain

The public site is `https://coinflip.amongfriends.net`. DNS is on Cloudflare for `amongfriends.net`. The Google OAuth redirect stays the Supabase callback. Only Supabase and Render need this hostname.

1. In Render, open the service **Settings → Custom Domains** and add `coinflip.amongfriends.net`.
2. In Cloudflare, open **amongfriends.net → DNS → Records** and add:

| Type | Name | Target | Proxy |
|---|---|---|---|
| CNAME | `coinflip` | `coin-flip-6uhv.onrender.com` | DNS only (grey cloud) |

Leave the Cloudflare proxy off. Render issues the certificate, and the orange cloud blocks that. A new copy uses its own Render hostname as the CNAME target.

3. In Supabase **Authentication → URL Configuration**, set:

```text
Site URL: https://coinflip.amongfriends.net
Redirect URLs:
  https://coinflip.amongfriends.net
  https://coinflip.amongfriends.net/auth/callback
  http://localhost:4123
  http://localhost:4123/auth/callback
```

## 6. Check that the copy works

- `http://localhost:4123` opens the app and Google sign-in returns to the app.
- A signed-in user sees the live coin in the middle, settled flips on the left, and credit request and redeem on the right.
- Staking 1 credit creates a row. If nobody stakes, the window ends with no row.
- Windows are 1 minute, aligned to the clock (`WINDOW_MS` in `server/coinFlip.ts`). Bets lock for the last 10 seconds. At `0:00` the toss animation plays.
- `https://coinflip.amongfriends.net` loads the same app and Google sign-in returns there.

## Agent checklist

Copy this into a future task and fill the blanks. Stop and ask the user when a step needs their browser login.

```text
Create a new coin-flip app from the template in TEMPLATE.md.

Repo: <new github url>
Supabase project URL: <https://xxxx.supabase.co>
Render service name: <name>

1. Copy this codebase into the new repo. Do not copy .env or supabase/.temp.
2. Create or use the Supabase project. Write .env from .env.example with new keys. Never print the service role key.
3. Ask the user to run `npx supabase login` if the CLI is not logged in, then `npx supabase link --project-ref <ref>` and `npx supabase db push`. Confirm migrations 0001-0006 are on the remote.
4. Tell the user to create a Google Cloud OAuth consent screen and a Web client whose only redirect is https://<ref>.supabase.co/auth/v1/callback. They paste the client id and secret into Supabase → Authentication → Providers → Google.
5. Set Supabase Site URL and redirect URLs for http://localhost:4123 and for the public hostname.
6. Push main. In Render, create a Blueprint from render.yaml and set the six env vars. Remind them that VITE_* changes need a rebuild.
7. In Cloudflare DNS for the domain, add a grey-cloud CNAME from the hostname to the Render service. In Render, add that hostname under Custom Domains.
8. After the first Google login, put that user's UUID in ADMIN_USER_IDS locally and on Render if they should be an admin.
```
