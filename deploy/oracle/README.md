# Havyn on Oracle Cloud Always Free

This deploys only the Havyn Socket.IO signaling server. Supabase remains the database/auth layer, and the desktop app points to the Oracle VM with `VITE_SOCKET_SERVER_URL`.

## Recommended VM

- Image: Ubuntu 22.04 or 24.04
- Shape: Always Free eligible Ampere A1 or AMD Micro
- Public IPv4: enabled
- Ingress rules:
  - TCP 22 from your IP for SSH
  - TCP 4000 from `0.0.0.0/0` for the Havyn Socket.IO server

## Install On The VM

SSH into the VM, then run:

```bash
curl -fsSL https://raw.githubusercontent.com/Treasure299/Havyn/main/deploy/oracle/setup-havyn-oracle-ubuntu.sh -o setup-havyn.sh
sudo bash setup-havyn.sh
```

Check the server:

```bash
curl http://YOUR_ORACLE_PUBLIC_IP:4000/health
```

## Service Commands

```bash
sudo systemctl status havyn-socket
sudo journalctl -u havyn-socket -f
sudo systemctl restart havyn-socket
```

## Update Havyn Later

```bash
cd /opt/havyn
sudo git fetch origin main
sudo git reset --hard origin/main
sudo chown -R havyn:havyn /opt/havyn
sudo -u havyn npm --prefix /opt/havyn ci --workspaces --include-workspace-root
sudo systemctl restart havyn-socket
```

## Desktop App

After the Oracle server is healthy, set this in `apps/desktop/.env` before packaging:

```env
VITE_SOCKET_SERVER_URL=http://YOUR_ORACLE_PUBLIC_IP:4000
```

Then rebuild the Windows installer.
