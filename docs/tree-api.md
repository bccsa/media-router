# Tree API — manager and router

The manager and every router expose their data as **one tree** over
Socket.IO. A client subscribes to the parts it wants and receives a snapshot
followed by live changes. It writes values by their tree path and calls
actions on tree nodes. This is the API the manager UI uses. It is also how
dashboards and integrations talk to a manager or directly to a router.

Design decisions: [ADR-0024](adr/0024-one-subscribable-tree.md) (the tree)
and [ADR-0025](adr/0025-router-manager-state-sync.md) (router ↔ manager sync,
outages). The wire types live in
[`packages/shared-types/src/tree/protocol.ts`](../packages/shared-types/src/tree/protocol.ts).

- [1. Connecting](#1-connecting)
- [2. Paths and patterns](#2-paths-and-patterns)
- [3. Verbs](#3-verbs)
- [4. Server events](#4-server-events)
- [5. What a client must do](#5-what-a-client-must-do)
- [6. Manager tree](#6-manager-tree)
- [7. Router tree](#7-router-tree)
- [8. Descriptors (`/meta`)](#8-descriptors-meta)
- [9. Errors](#9-errors)
- [10. Examples](#10-examples)
- [11. Limits and behaviour](#11-limits-and-behaviour)

---

## 1. Connecting

| Server | URL | Socket.IO path | Serves |
|---|---|---|---|
| Manager | `http://<manager>:8080` | `/socket.io` (default) | every router it manages, under `/engines/<id>`, plus groups, settings, plugins |
| Router | `http://<router>:8081` | `/tree` | that router only, rooted at `/`; works with or without a manager |

The router's `:8081` port also serves the local control panel (LCP) on the
default `/socket.io` path. That is a different protocol and is unaffected by
this API. Its dashboards are at `/d/<name>`; `/d/dashboards.json` is the
running profile's list as JSON (ADR-0026).

**Handshake.** Send the protocol version in the Socket.IO `auth` payload:

```js
import { io } from 'socket.io-client';
const socket = io('http://10.9.16.103:8080', { auth: { proto: 1 }, transports: ['websocket'] });
// a router: io('http://10.9.16.103:8081', { path: '/tree', auth: { proto: 1 } })
```

A client on another version is refused before it connects. It receives a
`connect_error` whose message is `tree protocol 1 required, client sent <n>`.
The current version is `TREE_PROTOCOL = 1`; it changes only on a breaking
protocol change.

**Hello.** Right after connecting, the server emits `hello { proto, build }`.
`build` changes when a new UI bundle is deployed (manager) or a new engine
build is installed (router). The manager UI reloads itself when it changes.
Other clients may ignore it.

**Security.** There is no authentication yet. Anyone who can reach
`:8080` or `:8081` can read and write. Both servers accept any browser
origin. Keep these ports on a trusted network.

---

## 2. Paths and patterns

**Paths** are [JSON Pointer](https://www.rfc-editor.org/rfc/rfc6901)
strings: `/engines/studio-a/modules/mixer-1/settings/volume`. In a segment,
`~` is written `~0` and `/` is written `~1`.

- **Arrays by id.** Array elements are addressed by their `id`
  (`/connections/<connection-id>`), never by index. Arrays without ids (logs)
  use indexes.
- **Appends.** `-` appends to an array: a `tree` frame carrying
  `add /engines/e1/logs/-` is a new log line.

**Patterns** are what you subscribe to:

| Pattern | Matches |
|---|---|
| `/engines/e1` | that node **and everything below it** |
| `/engines/+/info` | `+` matches exactly one segment |
| `/engines/e1/modules/+/vu` | any module's VU on `e1` |
| `/` | everything except `/meta` |

- **Trailing `#`.** It is ignored (`/engines/e1/#` = `/engines/e1`).
- **Multi-level wildcards.** There is none in the middle of a pattern.
- **One request.** Up to 500 patterns per request.
- **Overlap.** Patterns from any number of requests add up. A change reaches
  you once however many of your patterns cover it, and one request's snapshot
  holds each value once. A later request's snapshot does include values an
  earlier subscription already delivered.
- **Pruning.** A change high in the tree (for example a whole module
  replaced) is trimmed to the parts your patterns cover.

---

## 3. Verbs

Every request is a Socket.IO emit with an acknowledgement callback. Every
reply has the same envelope:

```ts
{ ok: true, data: <result> }      // success
{ ok: false, error: string }      // failure: a readable message
```

A malformed request gets `{ ok: false, error: 'invalid request' }`. An
unexpected server fault gets `'internal error'`.

### 3.1 `sub` — read and follow

```js
socket.emit('sub', { patterns: ['/engines/e1/modules/m1/settings/volume'] }, (ack) => {
  // ack.data.ops = snapshot, as JSON Patch `add` ops with absolute paths:
  // [{ op: 'add', path: '/engines/e1/modules/m1/settings/volume', value: 80 }]
});
```

- **Snapshot.** The reply is the current value of every node the patterns
  name, as `add` ops. A pattern that matches nothing yet returns no ops; it
  is still subscribed and delivers the value once it appears.
- **Deltas.** From then on, every change arrives in `tree` frames (§4).
  Deltas queued before the snapshot are flushed first, so the snapshot is
  always the newest state.

### 3.2 `unsub` — stop following

```js
socket.emit('unsub', { patterns: ['/engines/e1/modules/m1/settings/volume'] }, (ack) => {}); // data: {}
```

Spell the pattern exactly as it was subscribed. Disconnecting drops all of a
socket's subscriptions.

### 3.3 `write` — change values and structure

```js
socket.emit('write', {
  id: 7,                    // write id: any non-negative integer; increment per write
  ops: [                    // 1–2000 JSON Patch ops at tree paths
    { op: 'replace', path: '/engines/e1/modules/m1/settings/volume', value: 90 },
  ],
}, (ack) => {
  // ack.data = { rejected: [] }
  //         or { rejected: [{ index: 0, path: '…/volume', reason: 'above maximum 150' }] }
});
```

- **Ops.** `op` is `add`, `replace` or `remove`. Use `replace` for a value,
  and `add` / `remove` for structure (modules, connections, groups…).
- **Checked per op.** Each op is validated against what the path allows
  (§6.3 and §7.2) and, for module values, against the value's descriptor
  (§8): writable, correct type, within range, an allowed option, declared in
  the schema. Nothing is clamped. A rejected op is listed in `rejected`, and
  the others in the batch still apply.
- **Order.** Ops apply in order. A setting is checked against the settings
  earlier ops in the same batch have set, so raising a `volumeMax` and then
  `volume` in one batch works.
- **Echo.** Every op of your write comes back to you in a `tree` frame
  tagged `w: <your write id>`, carrying the stored value. That's true even if
  you are not subscribed to the path. A rejected op comes back the same way
  with the stored value, which is how a control snaps back.
- **Everyone else.** All other subscribers of the path receive the change,
  untagged.
- **Offline routers.** A write to a router that is offline changes the
  manager's stored config. The router receives it when it reconnects.

### 3.4 `call` — actions

```js
socket.emit('call', { path: '/engines/e1/modules/m1', method: 'restart', args: {} }, (ack) => {
  // ack = { ok: true, data: {} }  or  { ok: false, error: 'Engine is offline' }
});
```

Actions, anything carrying a secret or binary data, and one-off lookups are
calls on a node. §6.4 and §7.3 list them. The server imposes no timeout; the
manager UI gives up after 10 s (5 min for uploads).

---

## 4. Server events

| Event | Payload | Meaning |
|---|---|---|
| `tree` | `{ ops: TreeOp[] }` | changes to what you subscribe to, in order |
| `hello` | `{ proto, build }` | sent on connect (§1) |
| `tree:renamed` | `{ from, to }` | a router was renamed; your subscriptions under `from` now live under `to`. One event per renamed prefix: `/engines/<old>` and, if you follow its descriptors, `/meta/engines/<old>` |

**`tree` frames.**
- **Ops.** `TreeOp` is a JSON Patch op with absolute path, plus `w` on the
  echo of your own write.
- **Batching.** At most one frame per socket every 50 ms.
- **Latest wins.** While your connection is busy, only the newest value per
  path is kept, so a slow client gets current values, not a backlog. Appends
  (`…/-`) are never merged.

---

## 5. What a client must do

1. **Apply ops in order** to a local copy.
   - `add` creates missing parents.
   - `replace` / `remove` under a missing parent is ignored.
   - Appending (`-`) an element whose `id` is already in the array replaces
     it.
   
   `applyTreeOp` in `@media-router/shared-types` does exactly this.
2. **Resubscribe after every reconnect.** The server keeps nothing for a
   closed socket. The new snapshots bring you back up to date.
3. **Settle your own writes** if you update controls optimistically.
   - Accept echoes carrying your latest write id.
   - Ignore other writers' values on a path whose echo you still wait for.
   - Give up waiting after a few seconds.
   
   The manager UI's `TreeClient` does this.
4. **Treat VU as stale after about 2.5 s without an update.** Routers resend
   an unchanged level once a second, so silence means the meter stopped.

---

## 6. Manager tree

```
/engines/<id>/info            router identity, link and run state
/engines/<id>/system          CPU, memory, temperature
/engines/<id>/devices/<type>  device lists
/engines/<id>/logs            the latest 1000 log lines
/engines/<id>/events          transient notices (not retained)
/engines/<id>/modules/<mid>   one module: config + manifest + runtime + VU
/engines/<id>/connections/<cid>
/engines/<id>/interlocks/<iid>
/engines/<id>/dashboards/<did>  the active profile's dashboards (ADR-0026)
/engines/<id>/profiles/<name>
/groups/<gid>                 sidebar groups
/dashboards/<did>             manager dashboards: across routers (ADR-0026)
/settings                     manager settings
/plugins/<pluginId>           plugin manifests
/meta/...                     descriptors (§8)
```

### 6.1 Nodes

**`/engines/<id>/info`**

| Field | Type | Writable | Meaning |
|---|---|---|---|
| `name` | string | yes | display name |
| `online` | boolean | — | the router is connected |
| `running` | boolean | yes | run intent: modules started (Start/Stop) |
| `activeProfile` | string \| null | yes | active profile name; writing it switches profiles |
| `groupId` | string | yes | sidebar group |
| `sortOrder` | number | yes | position in the group |
| `ip`, `ips`, `hostname`, `buildNumber` | | — | reported by the router |
| `features` | string[] | — | what the router supports; `dashboards` = it serves router dashboards (ADR-0026). Absent on older engines |
| `managerPaths` | `{ connected, total }` | — | the router's paths to the manager |
| `paths` | `[{ remote, listenerPort }]` | — | live paths as the manager sees them |
| `moduleCount`, `connectionCount` | number | — | size of the active profile |

**`/engines/<id>/system`**
- Fields: `{ cpu, mem, temp, processCount?, undervoltage? }`. `cpu` and
  `mem` are percentages; `temp` is °C or `null`; `undervoltage` is present
  (and `true`) only on a Raspberry Pi that has seen under-voltage.
- Refresh: about every 2 s.
- Offline: removed while the router is offline.

**`/engines/<id>/devices/<type>`**
- Contents: the devices of one type, as each device provider reports them.
  Types include `network-interface`, `audio-source`, `audio-sink`,
  `aes67-stream`, `drm-connector` and `video`.
- Offline: replaced by `{}`.

**`/engines/<id>/logs`**
- Contents: an array of pino entries
  `{ level, time, name, msg, moduleId?, … }`. `level` is 10 trace, 20 debug,
  30 info, 40 warn, 50 error, 60 fatal.
- Snapshot: up to the latest 1000 lines.
- New lines: arrive as `add …/logs/-`.
- Offline: replaced by `[]`.

**`/engines/<id>/events`**
- Contents: transient notices, appended as `add …/events/-`, e.g.
  `{ type: 'rebootFailed', reason, time }`.
- Snapshot: none. Subscribe to receive the next ones.

**`/engines/<id>/modules/<mid>`**

A module node merges four sources; field names are as below.

| From | Fields |
|---|---|
| Profile config | `instanceId`, `pluginId`, `displayName`, `enabled`, `settings`, `position`, `size`, `focused`, `ports` |
| Plugin manifest | `configSchema` (the router's own when it reported one), `color`, `icon`, `statusSections`, `faceWidgets`, `interlock`, `resizable`, `uploads` |
| Runtime, reported by the router | `running`, `ready`, `health` (`ok` \| `warning` \| `error` \| `stopped`), `pendingRestart`, `liveUpdatableParams`, `error`, `warnings`, `statusData` (`{ <section>: { <key>: value } }`), `dynamicStatusSections`, `badges` (`[{ id, icon?, text, color? }]`), `fieldOptions` |
| VU | `vu`: one level per channel, 0–15 blocks, `round((dBFS + 60) / 4)` (15 ≈ 0 dBFS, 0 ≤ −60 dBFS) |

When a router goes offline:
- every module gets `running: false` and `health: 'stopped'`;
- `error`, `statusData`, `badges`, `fieldOptions` and `vu` are removed.

**`/engines/<id>/connections/<cid>`**
- Fields: `{ id, sourceModuleId, sourcePortId, sinkModuleId, sinkPortId, channelMap? }`.
- `channelMap`: `[{ srcChannel, dstChannel, gain? }]`.

**`/engines/<id>/interlocks/<iid>`**
- Fields: `{ id, name, members: [moduleId…], color? }`.
- Behaviour: at most one member of an interlock is live at a time, kept by the router itself for every write (ADR-0028): unmuting a member mutes the others in the same apply, and the router reports the group's state back, so the mutes reach every viewer as ordinary changes.

**`/engines/<id>/dashboards/<did>`**
- Fields: `{ name, cols, rows, scroll, zoom, locked, theme, widgets, rev }`.
  `name` is unique in the profile; `cols`/`rows` 1–96; `theme` `dark` \| `light`;
  `rev` counts saves.
- `widgets`: `[{ id, type, x, y, w, h, bind?, binds?, action?, script?, inputDisabled?, options? }]`,
  drawn in order (later on top). `bind` is the value's path relative to the
  router (`/modules/<mid>/settings/volume`, `/system/cpu`); `binds` is 1–8 such
  paths for a widget that shows several (a trend); `action` is
  `{ kind: 'call', path, method }` or `{ kind: 'write', path, value }`.
  `script` (buttons, ADR-0027) is `{ steps, timeoutS? }`:
  steps `call` (restart/reset/reboot), `write` (value: `{ lit }`, `{ read }`,
  `{ op, a, b }`, `{ not }`), `wait`, `if`/`else`, `repeat`, `until`,
  `waitUntil`, `stop`. It replaces `action`.
- **`/runs/<scope>/<did>/<wid>`** (beside the roots, like `/meta`; subscribe by
  name): a button's last run, `{ state: running | done | failed | stopped,
  step, of, error?, at }`. Scope `_` on a router and for manager dashboards;
  the engine id for a router dashboard run by the manager.
- Not writable: change dashboards with the calls in §6.4.

**`/dashboards/<did>`**
- A manager dashboard: the same fields, but `bind` and action paths are
  absolute (`/engines/<id>/modules/<mid>/settings/volume`), so one dashboard
  can mix routers. Stored and served by the manager only; an engine rename
  moves its paths. Not writable: see the calls in §6.4.

**`/engines/<id>/profiles/<name>`**
- Fields: `{ name, active }`.

**`/groups/<gid>`**
- Fields: `{ id, name, color, collapsed, sort_order, is_default, created_at, updated_at }`.
- `collapsed` and `is_default` are 0/1.
- `ungrouped` is the default group.

**`/settings`**
- Fields: `{ dgramListeners: [{ port, bindAddress? }] }`: the UDP listeners
  routers connect to.

**`/plugins/<pluginId>`**
- Contents: the plugin manifest (`package.json` → `mediaRouter`).
- Fields include `pluginId`, `displayName`, `description`, `category`,
  `ports`, `configSchema`, `statusSections`, `color` and `icon`.

### 6.2 Subscriptions that fit common views

| View | Patterns |
|---|---|
| Fleet list | `/engines/+/info`, `/engines/+/system`, `/groups` |
| One router, full | `/engines/<id>` |
| A dashboard tile | `/engines/<id>/modules/<mid>/vu`, `…/statusData/<section>/<key>`, `…/settings/volume` |
| Every meter of a router | `/engines/<id>/modules/+/vu` |

### 6.3 Writes

| Path | Op | Value | Notes |
|---|---|---|---|
| `/engines/<id>/info/name` | replace | non-empty string | |
| `/engines/<id>/info/running` | replace | boolean | stored as the intent and sent to the router; applied when it reconnects if offline |
| `/engines/<id>/info/activeProfile` | replace | profile name | switches the profile: the router restarts, starts or stops per the profile's own intent |
| `/engines/<id>/info/groupId`, `…/sortOrder` | replace | group id / integer ≥ 0 | sidebar moves; send all moved routers in one write |
| `/engines/<id>` | remove | — | deletes the router with its profiles |
| `/engines/<id>/profiles/<name>` | add | `{ config? }` | new profile (name 1–64 chars), empty unless `config` given |
| `/engines/<id>/profiles/<name>` | remove | — | not the active one |
| `/engines/<id>/modules/<mid>` | add | module object with `pluginId` | new module; the rest of the batch may write inside it unchecked |
| `/engines/<id>/modules/<mid>` | remove | — | removes the module; its connections and interlock memberships go with it |
| `/engines/<id>/modules/<mid>/settings/<key>` | replace / add | per descriptor (§8) | only keys the schema declares; `x-readOnly` keys and display widgets are read-only |
| `/engines/<id>/modules/<mid>/enabled` | replace | boolean | |
| `…/modules/<mid>/displayName` | replace | string | |
| `…/modules/<mid>/position`, `…/size` | replace | `{ x, y }` / `{ width, height }` | graph layout |
| `…/modules/<mid>/focused` | replace | boolean | |
| `/engines/<id>/connections/-` | add | connection object | the id is yours to choose; the UI uses `<sourceModule>:<sourcePort>-<sinkModule>:<sinkPort>` |
| `/engines/<id>/connections/<cid>` | remove / replace | — / connection object | |
| `/engines/<id>/connections/<cid>/<field>` | replace / add | e.g. `channelMap` | |
| `/engines/<id>/interlocks/-` | add | interlock object | |
| `/engines/<id>/interlocks/<iid>` | remove | — | |
| `/engines/<id>/interlocks/<iid>/name`, `…/members`, `…/color` | replace | | |
| `/groups/<gid>` | add | `{ name (1–64), color? ('#rgb'…'#rrggbbaa') }` | the id is yours to choose (`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`); the UI uses `grp_<time36>_<rand6>` |
| `/groups/<gid>` | remove | — | not the default group; its routers move to `ungrouped` |
| `/groups/<gid>/name`, `…/color`, `…/collapsed` | replace | string / color or null / boolean | |
| `/groups/<gid>/sort_order` | replace | number | group order |
| `/settings/dgramListeners` | replace | `[{ port, bindAddress? }]` (1–16, unique ports) | rebinds first; stored only if every listener binds |

Anything else is rejected with `not writable` or `read-only`.

### 6.4 Calls

| Path | Method | Args | Result | Needs the router online |
|---|---|---|---|---|
| `/engines` | `create` | `{ engineId, displayName, password }` | `{ id }` | — |
| `/engines/<id>` | `setPassword` | `{ password }` | `{}` | no |
| `/engines/<id>` | `rename` | `{ newEngineId }` | `{ id }` | no; subscribers get `tree:renamed` |
| `/engines/<id>` | `reset` | — | `{}` | yes: restarts PipeWire and every module |
| `/engines/<id>` | `reboot` | — | `{}` | yes: reboots the host |
| `/dashboards/<did>` | `run` | `{ widget }` | `{}` | per step: runs the button's actions or script on the manager (ADR-0027); `Already running`, `This button has no actions` |
| `/dashboards/<did>` | `stop` | `{ widget }` | `{ stopped }` | — |
| `/engines/<id>/dashboards/<did>` | `run` / `stop` | `{ widget }` | as above | a router dashboard's button, run by the manager against `/engines/<id>` |
| `/engines/<id>/modules/<mid>` | `restart` | — | `{}` | yes |
| `/engines/<id>/profiles/<name>` | `config` | — | the stored profile config | no |
| `/engines/<id>/profiles/<name>` | `history` | — | `[{ id, saved_at, config }]` (`config` is a JSON string) | no |
| `/engines/<id>/profiles/<name>` | `rollback` | `{ versionId }` | `{}` | no; see the note below |
| `/engines/<id>/dashboards` | `save` | `{ id?, dashboard, baseRev?, force? }` | `{ id, rev }` | no; see the note below |
| `/engines/<id>/dashboards/<did>` | `delete` | — | `{}` | no |
| `/engines/<id>/dashboards/<did>` | `copy` | `{ toEngine, toProfile, name, modules }` | `{ id }` | no |
| `/dashboards` | `save` | `{ id?, dashboard, baseRev?, force? }` | `{ id, rev }` | no; as for router dashboards |
| `/dashboards/<did>` | `delete` | — | `{}` | no; its history goes too |
| `/dashboards/<did>` | `duplicate` | `{ name }` | `{ id }` | no |
| `/dashboards/<did>` | `history` | — | `[{ id, saved_at, config }]` (`config` is a JSON string) | no |
| `/dashboards/<did>` | `rollback` | `{ versionId }` | `{ rev }` | no; restores that version as a new revision |
| `/plugins/<pluginId>` | `upload` | `{ moduleId, filename, bytes }` (binary) | `{ path, filename }` | no |
| `/plugins/<pluginId>` | `readUpload` | `{ filename }` | `{ bytes, contentType }` (binary) | no |

- **`engineId` format.** 1–64 characters, starting with a letter or digit,
  then letters, digits, `.`, `_` or `-`.
- **Dashboards.** `save` stores one dashboard in the router's active profile:
  a new one without `id`, else a replacement. `baseRev` is the revision the
  editor started from; when the stored one is newer the call fails with
  `conflict: …` unless `force` is set. Names are unique per profile. The
  active profile's dashboards reach the router as a patch, and subscribers
  get them as ordinary ops. `copy` puts a copy in any router's profile,
  moving every path below `/modules/<from>` to `/modules/<to>` for each pair
  in `modules`; unmapped modules show as missing there. Manager dashboards
  keep a history like profiles: a save stores a version at most once per
  10 minutes, and the last 10 are kept.
- **Rollback.** It restores the version's graph, settings and dashboards; the run intent
  (running or stopped) stays as it is. For the active profile the manager
  sends the router only the difference, as it does for any edit: live values
  take effect at once, restart-required settings wait for a module restart
  (`pendingRestart`), and modules and connections are added or removed.
  Nothing is restarted, and subscribers get the changes as ordinary ops. An
  offline router gets the change when it reconnects. Any other profile is only
  stored.

---

## 7. Router tree

A router serves its own part of the tree at `/`. The layout is exactly what
the manager holds under `/engines/<id>`, minus `profiles` and `events`:

```
/info  /system  /devices/<type>  /logs  /modules/<mid>  /connections/<cid>  /interlocks/<iid>  /dashboards/<did>  /meta/...
```

`system`, `devices`, `logs`, `modules`, `connections`, `interlocks` and
`dashboards` have the same shapes as in §6.1. These don't depend on the
manager: system stats and device lists keep updating while the manager link
is down.

The router also serves its dashboard viewer over plain HTTP on :8081
(ADR-0026): `/d/` lists the running profile's dashboards, `/d/<name>` opens
one (URL-encoded name), and `/d/dashboards.json` returns `[{ id, name }]`
(CORS open). device-manager's display picker reads it on the box, through its
own `/api/dashboards`, so the picker works over HTTPS or a tunnel too.

### 7.1 `/info`

| Field | Meaning |
|---|---|
| `name` | the manager-connection profile name (the id this router registers as) |
| `running` | modules started (writable) |
| `ips`, `hostname`, `buildNumber` | this box |
| `managerLink` | `{ connected, paths: { connected, total } }` |

### 7.2 Writes

A router takes **values only**; its structure belongs to the manager.

| Path | Op | Value |
|---|---|---|
| `/modules/<mid>/settings/<key>` | replace / add | per descriptor (§8) |
| `/modules/<mid>/enabled` | replace | boolean |
| `/info/running` | replace | boolean |

- **Where it goes.** An accepted write is applied live, the same way an LCP
  control is. It goes to the manager with guaranteed delivery.
- **While the manager link is down**, writes are kept on the router and
  merged when the link returns: the value set on site wins (ADR-0025).
- **Rejections.** Anything else is rejected with `not writable on a router`.

### 7.3 Calls

| Path | Method | Args | Notes |
|---|---|---|---|
| `/modules/<mid>` | `restart` | — | |
| `/` | `reset` | — | Restarts PipeWire and every module from the config in memory; works with the manager link down. |
| `/` | `reboot` | `{ confirm?: true }` | While the manager link is down it fails with "The manager is unreachable: after a restart this router stays stopped until it is back. Call again with confirm: true." A rebooted router waits for its manager and starts from the manager's config. |
| `/dashboards/<did>` | `run` | `{ widget, confirm?: true }` | Runs the button's actions or script on the router (ADR-0027), each step as a tree write or call. A script with a reboot needs `confirm: true` while the manager link is down (the message above). |
| `/dashboards/<did>` | `stop` | `{ widget }` | Stops that button's run: `{ stopped }`. |

---

## 8. Descriptors (`/meta`)

`/meta` + a value's path returns what the value is and whether this server
accepts writes to it:

```
/meta/engines/<id>/modules/<mid>/settings/<key>
/meta/engines/<id>/modules/<mid>/statusData/<section>/<key>
/meta/engines/<id>/modules/<mid>/enabled      (also displayName, position, size, focused)
/meta/engines/<id>/info                       running, name, activeProfile, groupId, sortOrder

on a router: /meta/modules/<mid>/…   /meta/info/running
```

The same rule works on both servers: the descriptor of path `P` is `/meta`
+ `P`. Descriptors cover module values and router info. Profiles, groups,
settings, connections and interlocks have none; §6.3 lists what they take.

| Field | Meaning |
|---|---|
| `access` | `read` \| `write` |
| `apply` | writable values only: `live` (at once) \| `restart` (on the module's next restart; the module shows `pendingRestart`) |
| `type` | `number`, `integer`, `boolean`, `string`, `array`, `object` (schema values) |
| `label`, `description`, `unit` | for display |
| `min`, `max`, `step` | range; `max` already resolved from `x-maxFrom` / `x-maxBy` |
| `enum` | allowed options (resolved from `x-enumBy` when the schema uses it) |
| `enumLabels` | display labels for options, keyed by the raw value (`x-enumLabels`) |
| `widget` | the schema's `x-widget` hint (`slider`, `graph`, …) |
| `format` | status fields: display format |
| `debounceMs` | suggested write debounce for continuous controls |

Descriptors are **live**. One is resent when its inputs change:
- another setting it depends on (`volumeMax` → `volume.max`);
- the plugin schema the router reports;
- which params the router says it can update live;
- its dynamic status sections.

A descriptor node with no previously published value, i.e. the first change
after its first subscriber arrived, is sent whole. After that, only the parts
that changed are sent.

`/meta` is **not part of `/`**. Only a subscription that starts with `/meta`
receives it, so whole-tree clients don't pull every descriptor.

Declared keys only: a setting the schema doesn't declare has no descriptor
and can't be written. Status descriptors come from the manifest's
`statusSections` plus the module's `dynamicStatusSections`.

---

## 9. Errors

**Write rejections** (`rejected[].reason`):

| Reason | Why |
|---|---|
| `read-only` | the value is not writable (runtime, `x-readOnly`, display widget) |
| `unknown value` | not declared in the schema |
| `expected <type>` / `expected boolean` / `expected a name` / `expected a profile name` | wrong type |
| `below minimum <n>` / `above maximum <n>` | out of range |
| `not an allowed option` | not in the enum |
| `not removable` | `remove` on a value |
| `unknown engine` / `unknown module` | no such router / module |
| `a module add needs a pluginId` | module add without `pluginId` |
| `not applied` | accepted but dropped by the manager's patch rules (e.g. an unknown connection) |
| `not writable` / `not writable on a router` | nothing may be written at that path |
| `invalid reorder`, `invalid profile name`, `Cannot delete the active profile`, `invalid group id`, `invalid group`, `invalid group field`, `Cannot delete this group`, `invalid listeners`, `Could not bind listeners: <reason>`, `Profile not found` | per write, §6.3 |

**Call errors** (`error`):
- **Arguments:** `invalid arguments`.
- **Router and profile lookups:** `Engine not found`, `Engine ID already
  exists`, `Engine is offline`, `Failed to rename engine`, `Profile not
  found`, `Version not found`.
- **Wrong method:** `no method <m> on <path>`, and the variants `on an
  engine`, `on a profile`, `on a plugin`.
- **Uploads:** `unsafe pluginId: …`, `empty body`,
  `body too large: <n> > <max>`, and an extension that isn't allowed.
- **Router reboot:** the confirm message in §7.3.

---

## 10. Examples

**Follow one module's volume and meter, and move the fader:**

```js
import { io } from 'socket.io-client';

const s = io('http://10.9.16.103:8080', { auth: { proto: 1 }, transports: ['websocket'] });
const base = '/engines/local/modules/audio-mixer-n1out03';
let writeId = 0;

s.on('connect', () => {
  s.emit('sub', { patterns: [`${base}/settings/volume`, `${base}/vu`, `/meta${base}/settings/volume`] }, (ack) => {
    for (const op of ack.data.ops) console.log('snapshot', op.path, op.value);
  });
});

s.on('tree', ({ ops }) => {
  for (const op of ops) console.log(op.w !== undefined ? 'my echo' : 'change', op.op, op.path, op.value);
});

function setVolume(v) {
  s.emit('write', { id: ++writeId, ops: [{ op: 'replace', path: `${base}/settings/volume`, value: v }] },
    (ack) => ack.ok && ack.data.rejected.forEach((r) => console.warn('rejected:', r.reason)));
}
```

**The same, straight from the router** (keeps working without a manager):

```js
const r = io('http://10.9.16.103:8081', { path: '/tree', auth: { proto: 1 }, transports: ['websocket'] });
// paths drop the /engines/<id> prefix: /modules/audio-mixer-n1out03/settings/volume, /meta/modules/…
```

**Restart a module:**

```js
s.emit('call', { path: '/engines/local/modules/audio-mixer-n1out03', method: 'restart' }, console.log);
```

**From a shell** (`tools/tree-cli/mr_tree.js`, runs on any box with the
repo or an installed media-router). It talks to `http://127.0.0.1:8080` unless
`--url` says otherwise; add `--path /tree` for a router:

```
node tools/tree-cli/mr_tree.js --url http://10.9.16.103:8080 get /engines/+/info
node tools/tree-cli/mr_tree.js sub /engines/local/modules/+/vu --secs 10
node tools/tree-cli/mr_tree.js write /engines/local/modules/m1/settings/volume 90
node tools/tree-cli/mr_tree.js call /engines/local/modules/m1 restart
node tools/tree-cli/mr_tree.js --url http://10.9.16.103:8081 --path /tree get /info
```

**Inside the manager UI:**
- Subscribe with `useTopics(() => patterns)`.
- Write with `useSocketStore().write(ops)` / `writeOrThrow(ops)`.
- Call actions with `useSocketStore().call(path, method, args)`.
- Values land in the Pinia stores through the tree mirror.

---

## 11. Limits and behaviour

| | |
|---|---|
| Patterns per `sub` / `unsub` | 1–500 |
| Ops per `write` | 1–2000 |
| Frames | ≤ 1 per socket per 50 ms; latest value per path while the connection is busy |
| Log ring | the latest 1000 lines per router |
| Largest message (manager) | 200 MB (uploads); the manager compresses WebSocket messages |
| Snapshot size | `/` on a large manager runs to megabytes; subscribe to what a view shows |
| Router cost | about +1.4 % of one core for 10 whole-tree clients (Pi 4 and Pi 5, measured 2026-09-28) |
