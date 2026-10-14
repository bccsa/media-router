# Clock fixtures

Raw `mr-clockstate` stdout, unedited, captured on 10.9.16.50 (hostname `mr`, a chrony box,
image v2.0.0.97, engine 1a4c87c) on 2026-10-14, running as root. `../HouseClock.test.ts`
replays each file through the sidecar's stdout path.

| File                            | Captured (UTC) | What the box did                                                                                                 |
| ------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------- |
| `clockstate-synced.jsonl`       | 05:19          | 60 s with chrony synced, TAI−UTC 37                                                                              |
| `clockstate-date-step.jsonl`    | 05:19          | chronyd stopped, then `clock_settime(CLOCK_REALTIME, now + 2 s)`: one `step` line                                |
| `clockstate-tai-late.jsonl`     | 05:19          | chronyd stopped, kernel TAI offset set to 0, then to 37 3 s later (`adjtimex` `ADJ_TAI`): no `step` line         |
| `clockstate-offline-boot.jsonl` | 05:41          | the boot state of an RTC-less box (clock 18,521,000 s behind, NTP state cleared, TAI 0, no NTP), then the uplink |

Offline-boot sequence, in the capture's `CLOCK_MONOTONIC` seconds (`monoNs`):

| mono s   | Event                                                                            |
| -------- | -------------------------------------------------------------------------------- |
| 19307.35 | NTP blocked (nft drop of udp/123), chronyd stopped, TAI offset set to 0          |
| 19307.41 | clock set back 18,521,000 s; the kernel clears its NTP state on settime          |
| 19307.45 | first sample (mr-clockstate started after the setback, so no `step` line for it) |
| 19309.45 | chronyd started with NTP blocked                                                 |
| 19329.54 | NTP unblocked (the uplink arrives), `chronyc onoffline`                          |
| 19334.26 | chrony steps the clock: the `step` line, E +18,520,999.999 s                     |
| 19335.26 | chrony writes TAI−UTC 37: E +37 s, still unsynced (maxerror 16 s)                |
| 19337.26 | synced, maxerror 4.1 ms                                                          |
| 19347.26 | last sample; the capture stops                                                   |
