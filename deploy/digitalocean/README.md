# DigitalOcean Deployment

This handoff moves Side Bets from Render to a single always-on DigitalOcean droplet that hosts:

- Mosquitto MQTT broker on port `1883`
- Node.js Side Bets API and Socket.IO server on port `4123`
- React frontend served by the same Node process
- Nginx reverse proxy on ports `80` and `443`
- PM2 process manager

Target droplet:

```text
sidebet-mqtt-syd
Ubuntu 24.04 LTS
Sydney SYD1
1 vCPU / 1 GB RAM / 25 GB SSD
```

## 1. DNS

Create an `A` record for:

```text
sidebet.amongfriends.net
```

Point it to the droplet public IPv4 address.

If using Cloudflare, keep the record proxied for the web app once HTTPS is working. MQTT on `1883` cannot use the Cloudflare orange-cloud HTTP proxy, so AWTRIX devices should connect directly to the droplet hostname or a separate DNS-only hostname if needed.

## 2. Secure Ubuntu

SSH into the droplet as root first:

```bash
ssh root@DROPLET_IP
```

Update packages:

```bash
apt update && apt upgrade -y
```

Create a deploy user:

```bash
adduser deploy
usermod -aG sudo deploy
```

Copy your SSH key to the deploy user:

```bash
rsync --archive --chown=deploy:deploy ~/.ssh /home/deploy
```

Enable the firewall:

```bash
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 1883/tcp
ufw enable
ufw status
```

Optional hardening after confirming `deploy` SSH works:

```bash
nano /etc/ssh/sshd_config
```

Set:

```text
PermitRootLogin no
PasswordAuthentication no
```

Restart SSH:

```bash
systemctl restart ssh
```

## 3. Install Runtime Packages

Log in as `deploy`, then install Node.js, Nginx, Mosquitto, and Certbot:

```bash
sudo apt install -y ca-certificates curl gnupg nginx mosquitto mosquitto-clients certbot python3-certbot-nginx
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2
```

Check versions:

```bash
node --version
npm --version
pm2 --version
mosquitto -h
```

## 4. Configure Mosquitto

For detailed Mosquitto operations, channel permissions, ACL updates, and test commands, see:

```text
deploy/digitalocean/MOSQUITTO.md
```

Copy the sample files from this repo:

```bash
sudo cp deploy/digitalocean/mosquitto-sidebets.conf /etc/mosquitto/conf.d/sidebets.conf
sudo cp deploy/digitalocean/sidebets.acl /etc/mosquitto/acl
```

Create MQTT users:

```bash
sudo mosquitto_passwd -c /etc/mosquitto/passwd sidebets_awtrix
sudo mosquitto_passwd /etc/mosquitto/passwd sidebets_app
sudo mosquitto_passwd /etc/mosquitto/passwd astro_app
```

Secure files and restart:

```bash
sudo chown root:mosquitto /etc/mosquitto/passwd /etc/mosquitto/acl
sudo chmod 640 /etc/mosquitto/passwd /etc/mosquitto/acl
sudo /usr/sbin/mosquitto -c /etc/mosquitto/mosquitto.conf -v
```

If the foreground config test starts cleanly, press `Ctrl+C`, then restart the service:

```bash
sudo systemctl reset-failed mosquitto
sudo systemctl restart mosquitto
sudo systemctl enable mosquitto
sudo systemctl status mosquitto
```

Test from the droplet:

```bash
mosquitto_sub -h localhost -p 1883 -u sidebets_awtrix -P 'AWTRIX_PASSWORD' -t 'sidebets/#'
```

In another SSH session:

```bash
mosquitto_pub -h localhost -p 1883 -u sidebets_app -P 'APP_PASSWORD' -t 'sidebets/test' -m 'hello from Side Bets'
```

Test from your local machine:

```bash
mosquitto_sub -h sidebet.amongfriends.net -p 1883 -u sidebets_awtrix -P 'AWTRIX_PASSWORD' -t 'sidebets/#'
mosquitto_pub -h sidebet.amongfriends.net -p 1883 -u sidebets_app -P 'APP_PASSWORD' -t 'sidebets/test' -m 'hello from local'
```

## 5. Deploy Side Bets App

Create the app folder:

```bash
sudo mkdir -p /var/www/side-bets/current
sudo chown -R deploy:deploy /var/www/side-bets
```

Clone the repo:

```bash
git clone https://github.com/garney/side-bets.git /var/www/side-bets/current
cd /var/www/side-bets/current
```

Create the production environment file:

```bash
nano .env
```

Use:

```bash
NODE_ENV=production
PORT=4123
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_ANON_KEY=your-anon-public-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-secret-key
VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-public-key
ADMIN_USER_IDS=comma-separated-admin-user-ids
```

Install and build:

```bash
npm ci
npm run build
```

Start with PM2:

```bash
pm2 start deploy/digitalocean/ecosystem.config.cjs
pm2 save
pm2 startup systemd
```

Run the command that `pm2 startup` prints.

Check the app:

```bash
curl -I http://127.0.0.1:4123
pm2 logs side-bets
```

## 5a. GitHub Actions Deployment

The repo includes a GitHub Actions workflow:

```text
.github/workflows/deploy-digitalocean.yml
```

It runs on pushes to `main` and can also be started manually from GitHub Actions.

The workflow:

1. installs dependencies
2. runs typecheck
3. runs lint
4. builds the React app and Node server
5. packages the production bundle
6. uploads it to the droplet over SSH
7. installs production dependencies on the droplet
8. switches `/var/www/side-bets/current` to the new release
9. restarts the app with PM2

When run manually, the workflow has optional server-config sync switches.

Use `sync_mosquitto_config` when you want GitHub to copy the repo's Mosquitto config samples into `/etc` on the droplet:

- `deploy/digitalocean/mosquitto-sidebets.conf` -> `/etc/mosquitto/conf.d/sidebets.conf`
- `deploy/digitalocean/sidebets.acl` -> `/etc/mosquitto/acl`

Use `sync_nginx_config` only when you intentionally want to replace the Nginx site config with the repo's plain HTTP sample:

- `deploy/digitalocean/nginx-sidebets.conf` -> `/etc/nginx/sites-available/side-bets`

Leave both options off for ordinary app deployments.

Important: after Certbot has installed SSL, avoid `sync_nginx_config` unless you plan to re-run Certbot afterwards. The live Nginx file may include SSL directives that are not present in the plain repo sample.

These options require the deploy user to have passwordless `sudo` for the relevant service/config commands.

### Required GitHub Secrets

In GitHub, go to:

```text
Repository -> Settings -> Secrets and variables -> Actions
```

Create these repository secrets:

```text
DO_HOST
DO_USER
DO_SSH_PRIVATE_KEY
DO_SSH_PORT
SUPABASE_URL
SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
VITE_SUPABASE_URL
VITE_SUPABASE_ANON_KEY
ADMIN_USER_IDS
```

`DO_SSH_PORT` can be omitted if SSH uses port `22`.

`DO_SSH_PRIVATE_KEY` should be the private key for an SSH key whose public key is in:

```text
/home/deploy/.ssh/authorized_keys
```

### One-Time Server Prep For The Pipeline

The workflow assumes this folder exists and is owned by the deploy user:

```bash
sudo mkdir -p /var/www/side-bets/releases
sudo chown -R deploy:deploy /var/www/side-bets
```

On first pipeline deploy, if `/var/www/side-bets/current` is still a real Git checkout directory, the workflow moves it aside to a timestamped `current.backup.*` directory and replaces it with a symlink to the latest release.

It also assumes Node.js and PM2 are already installed.

You do not need to keep a Git checkout on the server for pipeline deployments. GitHub ships a built release bundle directly to the droplet.

The workflow uses an app-local npm cache at:

```text
/var/www/side-bets/.npm-cache
```

It also uses an app-local PM2 home at:

```text
/var/www/side-bets/.pm2
```

If a previous manual command created root-owned npm cache files for the deploy user, fix the home cache once:

```bash
sudo chown -R deploy:deploy /home/deploy/.npm /home/deploy/.pm2
```

Also make sure the app directory is owned by the deploy user:

```bash
sudo chown -R deploy:deploy /var/www/side-bets
```

If you want GitHub Actions to sync Mosquitto and Nginx config, configure passwordless sudo for the deploy user. A narrowly scoped sudoers file is better than full passwordless sudo:

```bash
sudo visudo -f /etc/sudoers.d/side-bets-deploy
```

Example:

```text
deploy ALL=(root) NOPASSWD: /usr/bin/install, /usr/bin/systemctl restart mosquitto, /usr/bin/systemctl is-active --quiet mosquitto, /usr/sbin/nginx -t, /usr/bin/systemctl reload nginx, /usr/bin/ln -s /etc/nginx/sites-available/side-bets /etc/nginx/sites-enabled/side-bets
```

## 6. Configure Nginx

Copy the Nginx sample:

```bash
sudo cp deploy/digitalocean/nginx-sidebets.conf /etc/nginx/sites-available/side-bets
sudo ln -s /etc/nginx/sites-available/side-bets /etc/nginx/sites-enabled/side-bets
sudo nginx -t
sudo systemctl reload nginx
```

Visit:

```text
http://sidebet.amongfriends.net
```

## 7. Add HTTPS

After DNS points to the droplet:

```bash
sudo certbot --nginx -d sidebet.amongfriends.net
```

Check renewal:

```bash
sudo certbot renew --dry-run
```

## 8. Supabase Auth URLs

In Supabase:

```text
Authentication -> URL Configuration
```

Add:

```text
Site URL: https://sidebet.amongfriends.net
Redirect URL: https://sidebet.amongfriends.net
Redirect URL: https://sidebet.amongfriends.net/auth/callback
```

Keep local URLs if you still develop locally:

```text
http://localhost:4123
http://localhost:4123/auth/callback
```

The Google OAuth redirect URI remains the Supabase callback:

```text
https://your-project-ref.supabase.co/auth/v1/callback
```

## 9. AWTRIX MQTT Settings

Use these values on each AWTRIX clock:

```text
MQTT host: sidebet.amongfriends.net
MQTT port: 1883
MQTT username: sidebets_awtrix
MQTT password: the password from mosquitto_passwd
Prefix/topic root: sidebets
TLS: off
```

Every clock subscribed to `sidebets/#` receives the same published messages.

## 10. Updating The App

SSH into the droplet:

```bash
cd /var/www/side-bets/current
git pull
npm ci
npm run build
pm2 restart side-bets
pm2 logs side-bets
```

## 11. Useful Operations

Check services:

```bash
systemctl status nginx
systemctl status mosquitto
pm2 status
```

View logs:

```bash
journalctl -u nginx -n 100 --no-pager
journalctl -u mosquitto -n 100 --no-pager
pm2 logs side-bets
```

Restart services:

```bash
sudo systemctl restart nginx
sudo systemctl restart mosquitto
pm2 restart side-bets
```

## Notes

- MQTT is intentionally not using TLS because AWTRIX currently needs plain MQTT.
- Do not commit `.env`, MQTT passwords, Supabase service role keys, or admin user IDs.
- If using Cloudflare, DNS proxying applies to HTTP/HTTPS only. Plain MQTT on `1883` needs a direct DNS path to the droplet.
