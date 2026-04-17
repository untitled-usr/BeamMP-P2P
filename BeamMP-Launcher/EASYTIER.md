# EasyTier integration (BeamMP LAN rooms)

## Files to place next to `BeamMP-Launcher.exe`

- `easytier-core.exe`
- `easytier-cli.exe`
- `wintun.dll` (and `Packet.dll` if your EasyTier build requires it)

Copy them from your `easytier-windows-x86_64` (or build) folder into the **same directory** as the launcher (`GetBP()`).

## Behaviour

- In the game, **Rooms → Create/Edit room → Remote (EasyTier)**: enable remote multiplayer and set a **room password**.
- **Save** stores `remoteMultiplayerEnabled` and `remoteRoomPassword` in `rooms/<id>.json`.
- **Start server** (when remote is enabled):
  1. Launcher starts `easytier-core` with:
     - Network name: `beammp-p2p-room-<sha256(displayName) first 16 hex chars>`
     - Secret: first **32 hex characters** of `sha256(password)`
     - Hostname: `host-<sanitized launcher username>-<6 random hex>`
     - Port forward: virtual `tcp://0.0.0.0:<remoteVirtualListenPort>` → `127.0.0.1:<room port>` (defaults from room form)
     - RPC portal: `remoteEasyTierRpcPortal` (default `127.0.0.1:15888`, shared by core and `easytier-cli`)
     - Optional `remoteEasyTierPeers`: comma-separated `--peers` for public nodes / manual discovery
  2. Polls peer list (via `easytier-cli -o json peer`) for up to **two rounds** of ~3s each.
  3. If another peer’s hostname starts with `host-` and is not this node → error **「房间名或密码与其他用户重复」**, EasyTier and server are not started.
  4. Otherwise starts `BeamMP-Server` as before.
- **Stop room** or **launcher exit**: EasyTier core is stopped together with the server (Windows Job Object also ties child lifetimes to the launcher where configured).

## Manual checks

1. Remote **disabled**: starting a room behaves as before (no EasyTier).
2. Remote **enabled**, binaries missing: expect an error about missing `easytier-core`.
3. Two PCs, same display name + password: second host should get the duplicate-room error.
4. After successful start, another machine on the virtual network can try connecting to `virtual_ip:30814` (out of scope for this doc).

## Notes

- Default RPC port **15888** must be free for `easytier-cli` to talk to `easytier-core`.
- TUN / drivers may require running the launcher **as Administrator** on Windows.
