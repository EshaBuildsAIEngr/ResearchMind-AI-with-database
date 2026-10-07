# UAT server — ResearchMind backend (ops cheat sheet)

Environment-specific notes for the box where the backend actually runs.
Everything below was observed on 2026-10-07.

## Where it lives

```bash
# project (this repo) on the server
cd /opt/.cache-worker/proxy/ResearchMind-AI-with-database/backend

# python env used by the service
source venv/bin/activate
```

## systemd service

```bash
sudo systemctl restart proxy.service     # restart after code/dep changes
sudo systemctl status  proxy.service     # is it up?
sudo systemctl stop    proxy.service
sudo systemctl start   proxy.service
```

> The unit name is `proxy.service` even though the app is ResearchMind —
> don't go looking for a `researchmind.service`.

## Live logs

```bash
sudo tail -f /var/log/proxy.log
```

Healthy startup looks like:

```
INFO:     Started server process [1349149]
INFO:     Waiting for application startup.
INFO:     Application startup complete.
INFO:     Uvicorn running on http://172.17.0.1:39127 (Press CTRL+C to quit)
```

## How it runs

```
venv/bin/uvicorn app.main:app --host 172.17.0.1 --port 39127
```

- Binds the **docker bridge gateway** (`172.17.0.1:39127`), not `0.0.0.0` —
  a proxy in front forwards to it, which is also why client IPs in the log
  show as docker-network addresses (e.g. `172.19.0.3`).
- Installed packages live in `./venv` — `pip install ...` without
  `source venv/bin/activate` goes to the wrong interpreter.

## Installing / upgrading dependencies

```bash
source venv/bin/activate
pip install -r requirements.txt
sudo systemctl restart proxy.service
```

## Quick health + WebSocket handshake check

```bash
# REST health
curl -s http://172.17.0.1:39127/health

# WebSocket handshake straight to uvicorn (bypasses whatever proxy sits in
# front). No valid token needed — a real run_id/token gives 101; garbage
# still proves the route is reached:
#   403 Forbidden  -> upgrade honored, /ws/agents route matched   ✅
#   404 Not Found  -> request arrived as a plain HTTP GET         ❌ (proxy
#                     stripping Upgrade/Connection, or no WS protocol)
curl -i -N --max-time 5 \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  "http://172.17.0.1:39127/ws/agents/test-run-id?token=garbage"
```

If direct gives 403 but the same URL through the public hostname gives 404,
the proxy in front is stripping the WebSocket upgrade headers (nginx needs
`proxy_http_version 1.1;` + `proxy_set_header Upgrade $http_upgrade;` +
`proxy_set_header Connection "upgrade";` on the `/ws/` location).
