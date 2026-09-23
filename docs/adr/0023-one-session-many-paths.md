# ADR-0023: One engine session spans every path; the manager listens on 1 + n UDP ports

An engine's manager link is ONE dgram-comms session (one `Socket`, one
socketID) no matter how many network paths carry it. The server binds one UDP
socket per configured listener (`manager_settings.dgramListeners`, default
`:3000`, edited in the manager UI and applied by a live rebind), and a
`connect` that presents the session nonce the server already knows JOINS the
existing session as another endpoint instead of replacing it. Every message
fans out to every live endpoint in both directions with one shared sequence
number, and a receive-side dedup keyed on (sending session, seq) collapses the
copies. An endpoint silent for a full keepalive death window is pruned
(`pathDown`) while the session lives on through the rest; only the last
endpoint's silence ends the session. Replies always leave through the listener
the request arrived on. A different nonce is still a rebirth and replaces the
session; a nonce-less (older) client joins only from the endpoint already
known.

## Why

The engine side of multi-path (`ManagerConnectionProfile.paths[]`, the client
sending on all paths) had existed since v2.0 but the server kept one endpoint
per client, so a second path's `connect` destroyed the first path's socket and
the two paths fought forever (issue #692). Bonding at the session level, not
the socket level, keeps the manager's view of "engine online" stable across
single-path loss and keeps the client-first keepalive asymmetry of the gate01
fix ([[docs/TodoNotes.md]] 2026-07-18) intact per path. Storing the listener
list in `manager.db` puts the manager's own configuration where the rest of
its state already lives — in `/data`, across RAUC slot swaps — and lets the
operator change it from the UI without a Yocto build.

## Consequences

- Deploy the manager before giving any engine a second path: a new engine on
  two paths against an old manager still flaps.
- `bindInterface` on an engine path resolves to that interface's IPv4 at
  client build time (Node dgram has no `SO_BINDTODEVICE`); a DHCP change is
  picked up on the next full reconnect.
- `ReliableDelivery` tracks one retained copy per endpoint under one ackID;
  the first ACK from any path releases all copies. A multi-path Client shares
  its ackID counter across path sockets because server acks reach every path.
- Removing a listener drops engines that reach the manager only through it
  until their retry; the Settings card says so before Apply. A listener set
  that fails to bind is rolled back and never persisted.
- The engine reports `managerPaths {connected,total}` in its system stats and
  serves `GET /api/v1/manager/status` (every path with its live state) for the
  device-manager profile page.
- Each server endpoint records the listener port it arrived on; the manager
  broadcasts `engine:paths`, shown per engine in the detail view and per
  listener in the Engine Comms card.
- A rebind probe-binds the ports it does not hold yet before stopping the live
  server; a bind failure after that restores the previous set.
- Firewall allow rules for extra UDP ports are the operator's job
  (device-manager).
