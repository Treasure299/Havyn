# Havyn on Koyeb Free

This deploys the Havyn Socket.IO signaling server from the GitHub repo.

## Create Service

In Koyeb:

1. Create App / Service.
2. Choose GitHub repository: `Treasure299/Havyn`.
3. Branch: `main`.
4. Build method: Node.js / Buildpack.
5. Use the root directory of the repo.
6. Run command:

```bash
npm --workspace apps/server start
```

7. Exposed port:

```text
4000
```

8. Environment variables:

```env
NODE_ENV=production
PORT=4000
CLIENT_ORIGIN=*
```

Koyeb also supports the root `Procfile`, which contains the same run command.

## Health Check

After deployment, open:

```text
https://YOUR-KOYEB-DOMAIN/health
```

Expected response:

```json
{ "ok": true, "service": "havyn-server" }
```

## Desktop App

Once Koyeb is healthy, package the desktop app with:

```env
VITE_SOCKET_SERVER_URL=https://YOUR-KOYEB-DOMAIN
VITE_AUTH_REDIRECT_URL=https://YOUR-KOYEB-DOMAIN/verify
```

The app must be rebuilt and repackaged after changing Vite environment variables.
