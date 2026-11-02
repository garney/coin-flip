# Mosquitto Operations

This file is the runbook for the Side Bets MQTT broker on the DigitalOcean droplet.

The broker is plain MQTT on port `1883` because AWTRIX does not currently use MQTT over TLS in this setup.

```text
Host: 209.38.93.155
Port: 1883
Config: /etc/mosquitto/conf.d/sidebets.conf
Password file: /etc/mosquitto/passwd
ACL file: /etc/mosquitto/acl
```

## Repo Files

The source files in this repo are:

```text
deploy/digitalocean/mosquitto-sidebets.conf
deploy/digitalocean/sidebets.acl
```

Copy them to the server with:

```bash
sudo cp deploy/digitalocean/mosquitto-sidebets.conf /etc/mosquitto/conf.d/sidebets.conf
sudo cp deploy/digitalocean/sidebets.acl /etc/mosquitto/acl
sudo chown root:mosquitto /etc/mosquitto/passwd /etc/mosquitto/acl
sudo chmod 640 /etc/mosquitto/passwd /etc/mosquitto/acl
```

## Install Mosquitto

```bash
sudo apt update
sudo apt install -y mosquitto mosquitto-clients
sudo systemctl enable mosquitto
```

## Broker Config

The Side Bets config should stay minimal because Ubuntu's default `/etc/mosquitto/mosquitto.conf` already sets persistence and logging.

`/etc/mosquitto/conf.d/sidebets.conf`:

```text
listener 1883 0.0.0.0
allow_anonymous false
password_file /etc/mosquitto/passwd
acl_file /etc/mosquitto/acl
```

If Mosquitto fails after editing config, run the foreground parser:

```bash
sudo /usr/sbin/mosquitto -c /etc/mosquitto/mosquitto.conf -v
```

If it starts cleanly, press `Ctrl+C`, then restart the service:

```bash
sudo systemctl reset-failed mosquitto
sudo systemctl restart mosquitto
sudo systemctl status mosquitto --no-pager -l
```

## Users And Passwords

Create the first password file and AWTRIX subscriber user:

```bash
sudo mosquitto_passwd -c /etc/mosquitto/passwd sidebets_awtrix
```

Add publisher users:

```bash
sudo mosquitto_passwd /etc/mosquitto/passwd sidebets_app
sudo mosquitto_passwd /etc/mosquitto/passwd astro_app
```

Change an existing user's password:

```bash
sudo mosquitto_passwd /etc/mosquitto/passwd sidebets_awtrix
```

Delete a user:

```bash
sudo mosquitto_passwd -D /etc/mosquitto/passwd old_user
```

Secure the password and ACL files:

```bash
sudo chown root:mosquitto /etc/mosquitto/passwd /etc/mosquitto/acl
sudo chmod 640 /etc/mosquitto/passwd /etc/mosquitto/acl
```

Restart after user changes:

```bash
sudo systemctl restart mosquitto
```

## Channel Permissions

Mosquitto controls topic permissions through `/etc/mosquitto/acl`.

Current recommended ACL:

```text
user sidebets_awtrix
topic read sidebets/#
topic read astroPrivateFeed/#

user sidebets_app
topic readwrite sidebets/#

user astro_app
topic readwrite sidebets/#
topic readwrite astroPrivateFeed/#
```

Permission formats:

```text
topic read some/prefix/#
topic write some/prefix/#
topic readwrite some/prefix/#
```

Wildcard examples:

```text
sidebets/#              all nested topics under sidebets
sidebets/+/notify       exactly one segment between sidebets and notify
astroPrivateFeed/#      all nested topics under astroPrivateFeed
```

To add a new channel prefix for a user:

```bash
sudo nano /etc/mosquitto/acl
```

Example, grant AWTRIX read access to `newPrefix/#`:

```text
user sidebets_awtrix
topic read sidebets/#
topic read newPrefix/#
```

Example, grant an app publisher access to `newPrefix/#`:

```text
user astro_app
topic readwrite sidebets/#
topic readwrite newPrefix/#
```

Apply ACL changes:

```bash
sudo /usr/sbin/mosquitto -c /etc/mosquitto/mosquitto.conf -v
```

If config is valid, press `Ctrl+C`, then:

```bash
sudo systemctl restart mosquitto
sudo systemctl status mosquitto --no-pager -l
```

## Testing

Subscribe locally on the droplet:

```bash
mosquitto_sub -h localhost -p 1883 -u sidebets_awtrix -P 'AWTRIX_PASSWORD' -t 'sidebets/#'
```

Publish locally from another terminal:

```bash
mosquitto_pub -h localhost -p 1883 -u sidebets_app -P 'APP_PASSWORD' -t 'sidebets/test' -m 'hello from sidebets'
```

Test the temporary Astro feed:

```bash
mosquitto_sub -h localhost -p 1883 -u sidebets_awtrix -P 'AWTRIX_PASSWORD' -t 'astroPrivateFeed/#'
mosquitto_pub -h localhost -p 1883 -u astro_app -P 'ASTRO_PASSWORD' -t 'astroPrivateFeed/test' -m 'hello from astro'
```

Test from your local machine:

```bash
mosquitto_sub -h 209.38.93.155 -p 1883 -u sidebets_awtrix -P 'AWTRIX_PASSWORD' -t 'sidebets/#'
mosquitto_pub -h 209.38.93.155 -p 1883 -u sidebets_app -P 'APP_PASSWORD' -t 'sidebets/test' -m 'hello from local'
```

## Firewall

Allow MQTT:

```bash
sudo ufw allow 1883/tcp
sudo ufw status
```

## Logs And Service Commands

```bash
sudo systemctl status mosquitto --no-pager -l
sudo journalctl -u mosquitto -n 100 --no-pager
sudo systemctl restart mosquitto
sudo systemctl stop mosquitto
sudo systemctl start mosquitto
```

## GitHub Actions Mosquitto Sync

The DigitalOcean deploy workflow has a manual `sync_mosquitto_config` option.

When enabled, it copies:

```text
deploy/digitalocean/mosquitto-sidebets.conf -> /etc/mosquitto/conf.d/sidebets.conf
deploy/digitalocean/sidebets.acl -> /etc/mosquitto/acl
```

Use this only when you want GitHub Actions to update server-level config.

The deploy user needs passwordless sudo for the infra sync commands. See `deploy/digitalocean/README.md` for the sudoers example.

## Notes

- Do not commit MQTT passwords.
- Rotate any password shown in screenshots or logs.
- Keep Cloudflare proxy disabled for MQTT hostnames. Plain MQTT on `1883` needs a direct DNS path.
- Prefer one long-term topic prefix, probably `sidebets/#`, once testing is finished.
