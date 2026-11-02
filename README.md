# Coin flip

Coin flip is a single-port web app for a live coin toss every minute. It uses the same stack, deploy shape, and database tables as Coin flip. A toss is stored as a normal coin flip only after someone stakes 1 credit. Point this app at its own Supabase project.

Coin flip is a single-port web app for running casual prediction pools with credits. A user can create a coin flip, define the question and options, set the buy-in, manage the closing time, and settle the result. Other users can browse, search, join, and stake credits on an option. Credits are recorded through transactions so deposits, buy-ins, payouts, fees, adjustments, and withdrawals can be audited later.

This first version is intentionally simple: one Node process serves the React client, REST APIs, and Socket.IO events on the same port. That keeps local development and deployment easy while the product shape is still forming. The app can be split into separate client/API/realtime services later if the scale or release process needs it.

## Product Model

- Users sign in with Google SSO through Supabase Auth.
- Each user has a profile and a credit balance.
- A coin flip is managed by the user who created it.
- A coin flip has a title, description, optional source URL, buy-in amount, start time, close time, options, status, and optional winning option.
- Users join a coin flip by selecting an option and paying the buy-in from their credit balance.
- The manager, or an admin, settles the coin flip by choosing the winning option.
- Winners split the pot after the house fee. The current default house fee is `0%`.
- Users can request credits, and admins approve or reject those requests before credits are added.
- Admin users can view platform summaries, add credits to users, and inspect transaction history.
- Users can request to redeem credits, and admins approve or reject those requests.

## Infrastructure

The project currently uses:

- **React + Vite** for the browser app.
- **Node.js + Express** for HTTP APIs and static file serving.
- **Socket.IO** for realtime side-bet update notifications.
- **Supabase Auth** for Google SSO.
- **Supabase Postgres** for application data.
- **Docker** for containerized production-like local runs.

The default local port is:

```text
http://localhost:4123
```

## Architecture

```text
Browser
  |
  | React app
  | Supabase client auth session
  v
Node/Express server on :4123
  |
  | /api/* REST endpoints
  | Socket.IO realtime channel
  | Serves React app in production
  v
Supabase
  |
  | Auth: Google SSO users and JWTs
  | Postgres: profiles, coin flips, entries, transactions
```

### Request Flow

1. The user signs in with Google using Supabase Auth.
2. The React app receives a Supabase session and access token.
3. API requests include the token as a bearer token.
4. Express verifies the token with Supabase Auth.
5. The server upserts the user's profile if needed.
6. The server uses the Supabase service role key for trusted database operations.
7. Socket.IO connections also authenticate with the Supabase access token.
8. When a coin flip changes, the server broadcasts a `side-bet:changed` event and clients refresh their data.

### Why One Port?

Using one port means:

- Local setup is easier.
- Google Auth redirect configuration is simpler.
- Cookies, CORS, API requests, static assets, and sockets all share one origin.
- Docker deployment is straightforward.

Later, this can be split into separate deployables:

- static client hosting
- API service
- realtime service
- worker service for settlement and scheduled tasks

## Repository Layout

```text
client/
  index.html
  src/
    App.tsx          React app shell and current screens
    api.ts           Browser API client
    supabase.ts      Supabase browser client
    styles.css       App styles

server/
  index.ts           Express, Vite middleware, static serving, server startup
  routes.ts          REST API routes
  auth.ts            Supabase JWT auth middleware
  socket.ts          Socket.IO server and socket auth
  supabase.ts        Server-side Supabase clients
  config.ts          Environment configuration
  mappers.ts         Database-to-API mapping helpers

shared/
  types.ts           Shared TypeScript API/domain types

supabase/
  migrations/
    0001_initial_schema.sql
    0002_redemption_requests.sql
    0003_credit_requests.sql

Dockerfile
docker-compose.yml
.env.example
```

## Database Schema

The first migration creates:

- `profiles`
  User profile, email, avatar, display name, and credit balance.
- `admin_users`
  Users allowed to access admin views.
- `side_bets`
  Bet definition, timing, options, status, manager, fee, and result.
- `bet_entries`
  A user's selected option and stake for a coin flip.
- `credit_transactions`
  Immutable-style transaction records for admin credit adjustments, buy-ins, payouts, fees, withdrawals, and future payment deposits.
- `redemption_requests`
  User requests to exchange credits, including claim details and admin review status.
- `credit_requests`
  User requests for credits, including request reason and admin review status.

The migrations also enable Row Level Security and add initial read/update policies. The server currently performs trusted writes using the service role key after validating the user's Supabase JWT.

## Environment Variables

Create `.env` from `.env.example`:

```bash
cp .env.example .env
```

Fill in:

```bash
NODE_ENV=development
PORT=4123

SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_ANON_KEY=your-anon-public-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-secret-key

VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-public-key

ADMIN_USER_IDS=
```

Important:

- `SUPABASE_SERVICE_ROLE_KEY` is server-only. Do not expose it in browser code.
- `VITE_SUPABASE_ANON_KEY` is public and is safe to use in the browser.
- `ADMIN_USER_IDS` is optional. It is a comma-separated list of Supabase user UUIDs.

## Supabase Setup

### 1. Get Project Values

In Supabase:

```text
Project Settings -> API
```

Copy:

- Project URL
- anon public key
- service_role secret key

Put them into `.env`.

### 2. Apply the Database Migrations

In Supabase:

```text
SQL Editor -> New query
```

Copy and run the migrations in order:

```text
supabase/migrations/0001_initial_schema.sql
supabase/migrations/0002_redemption_requests.sql
supabase/migrations/0003_credit_requests.sql
```

Run the query.

### 3. Configure Google SSO

In Supabase:

```text
Authentication -> Providers -> Google
```

Enable Google. Supabase will show a callback URL like:

```text
https://your-project-ref.supabase.co/auth/v1/callback
```

In Google Cloud Console:

```text
APIs & Services -> OAuth consent screen
```

Create or configure the consent screen:

- App name: `Coin flip`
- User support email: your email
- Developer contact email: your email

Then:

```text
APIs & Services -> Credentials -> Create Credentials -> OAuth client ID
```

Use:

- Application type: `Web application`
- Authorized redirect URI: the Supabase callback URL

Google will give you:

- Client ID
- Client Secret

Paste those into Supabase's Google provider settings and save.

### 4. Configure Supabase Auth URLs

In Supabase:

```text
Authentication -> URL Configuration
```

Set:

```text
Site URL: http://localhost:4123
```

Add redirect URLs:

```text
http://localhost:4123
http://localhost:4123/auth/callback
```

## Local Development

Install dependencies:

```bash
npm install
```

Run the app:

```bash
npm run dev
```

Open:

```text
http://localhost:4123
```

The dev server runs one Node process. Express owns the HTTP server, and Vite is mounted as middleware for the React app.

## Scripts

```bash
npm run dev
```

Runs the single-port local development server.

```bash
npm run lint
```

Runs ESLint.

```bash
npm run typecheck
```

Runs TypeScript checks for the client/shared code and the server.

```bash
npm run build
```

Builds the React client and compiles the server.

```bash
npm start
```

Runs the compiled production server from `dist/server/index.js`.

## Production Build

Build:

```bash
npm run build
```

Run:

```bash
npm start
```

In production mode, Express serves the built React app from:

```text
client/dist
```

## Render Deployment

The repo includes a Render Blueprint:

```text
render.yaml
```

Use it from Render:

1. Push this repo to GitHub.
2. In Render, choose `New` -> `Blueprint`.
3. Connect the `garney/coin-flip` repository.
4. Render will read `render.yaml` and create a Docker web service.
5. Enter the environment variables when Render asks. `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are baked into the client during the image build, so a change to those two needs a new deploy.

Pushes to `main` auto-deploy. Render sets `PORT` and the process listens on `0.0.0.0`.

### Render Environment Variables

Set these in the Render service:

```bash
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_ANON_KEY=your-anon-public-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-secret-key
VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-public-key
ADMIN_USER_IDS=comma-separated-admin-user-ids
```

`VITE_*` values are needed during the Render build because the React app is compiled before the server starts.

### Supabase URLs for Render

After Render creates the service, it will give you a URL like:

```text
https://coin-flip.onrender.com
```

In Supabase, go to:

```text
Authentication -> URL Configuration
```

Set or add:

```text
Site URL: https://coin-flip.onrender.com
Redirect URL: https://coin-flip.onrender.com
Redirect URL: https://coin-flip.onrender.com/auth/callback
```

Keep the local URLs too if you still want local development:

```text
http://localhost:4123
http://localhost:4123/auth/callback
```

Your Google OAuth redirect URI stays the Supabase callback URL:

```text
https://your-project-ref.supabase.co/auth/v1/callback
```

## DigitalOcean VPS Deployment

For the planned move from Render to a Sydney DigitalOcean droplet with Mosquitto, PM2, Nginx, and Let's Encrypt, use:

```text
deploy/digitalocean/README.md
```

## Docker

Run a production-like container:

```bash
docker compose up --build
```

The container listens at:

```text
http://localhost:4123
```

The container expects the same `.env` values used locally.

## Admin Access

After logging in once, find your Supabase user UUID:

```text
Supabase -> Authentication -> Users
```

Option 1: add it to `.env`:

```bash
ADMIN_USER_IDS=your-user-uuid
```

Option 2: insert it into the database:

```sql
insert into public.admin_users (user_id)
values ('your-user-uuid');
```

Restart the app after changing `.env`.

## Current Limitations

This is an early scaffold. The following pieces are intentionally basic:

- Users can request credits, but credits are only added after admin approval.
- Redemption requests reserve credits immediately and require admin review.
- Real payment deposits are not implemented yet.
- Withdrawals and admin adjustments need dedicated UI and stronger audit controls.
- Settlement trusts the manager or admin to enter the correct result.
- There is no dispute workflow yet.
- There are no automated scheduled jobs to lock bets after close time.
- RLS policies are initial policies; they should be tightened as the product hardens.
- The admin center is a first pass, not a complete operations console.

## Suggested Next Steps

1. Finish Supabase + Google SSO setup.
2. Log in locally and verify profile creation.
3. Add yourself as an admin.
4. Request credits as a user, approve the request from the admin centre, then create and join a coin flip.
5. Add withdrawal and richer admin adjustment flows.
6. Add tests around wallet balance changes and settlement payout math.
7. Add production payment integration when credits become real money.
8. Add dispute handling or manager trust controls.
