# House-Clock Timing — Implementation Plan

| Field | Value |
|---|---|
| Document | DES-MR-TIMING implementation plan |
| Status | Draft for the design owner's review. Nothing is built. |
| Date | 2026-10-12 |
| Source | `docs/house-clock-timing-design.md`: DES-MR-TIMING, "Version 0.6 — for implementation planning", dated 2026-10-12, verified by its author against the code at `2bbd57e7` (v2.0); revised to 0.7 the same day with the follow-ups this plan's decisions created (§5.1, §5.2, §8, §9.4, §9.5, §10.4, §11.5, §13.1, §13.2, §14), section numbers unchanged |
| Branch | `docs/house-clock-timing-design`; this plan was written against the app submodule at `fc17468` |
| Organisation | BCC South Africa |
| Review | The plan is reviewed before anything is built. The questions it could not settle from the design are collected in chapter 15 with proposed defaults; they do not block planning, and no work item stops on them. On 2026-10-12 the owner answered OQ-1 to OQ-10 and overruled C-1, then answered OQ-13 (Phases 1–4 ship as one release) and delegated the remaining questions to the orchestrator, which decided them the same day; the text follows the decisions and no question is open. |

Contents: 1 How to read this plan · 2 Cross-cutting rules · 3 The shared
native TS module (S0) · 4 Phase 0 · 5 Phase 1 · 6 Phase 2 · 7 Phase 3 ·
8 Phase 4 · 9 Phase 5 · 10 Fixture and test strategy · 11 Release checklist
· 12 Effort and critical path · 13 Verification notes · 14 File index ·
15 Open-question register.

## 1. How to read this plan

This plan turns the house-clock timing design (`docs/house-clock-timing-
design.md`, v0.6) into work an engineer can start without re-deriving the
design. Nothing in it is built. The design owner reviews it first; the
questions it could not settle from the design are collected in chapter 15
and do not block the rest of the plan.

**Phases and releases.** The design's §14 lists six phases, 0 to 5,
developed in that order. They ship as three releases of the engine image
(the owner's decision of 2026-10-12, OQ-13): Phase 0 alone first; Phases
1, 2, 3 and 4 together as one release; Phase 5 after. Each phase is a
cut-over (§13.1): the mechanism it replaces is deleted with the phase,
inside the release that carries it; there is no engine flag, no legacy arm
and no in-app rollback; rolling back means installing the previous release
from the Device Manager. Because Phases 1–4 ship together, there is no
field period in which outputs present at `stamp + D` on source-natural
stamps; statements that a phase keeps the consumers of the day working are
development-sequencing facts, not release claims. The shared native TS
module (chapter 3) is not a phase: it ships with Phase 1, inside the
Phases 1–4 release, and is the foundation of Phases 1, 2, 3 and 5.

**Chapters 3 to 9** are the module and the six phases, one chapter each, in
development order. Every one of them keeps the same fourteen parts:

| Part | Content |
|---|---|
| 1 Goal | What the phase delivers, with the §14 row it implements. |
| 2 Design references | The design sections and decisions it implements. |
| 3 Current state | The code as it is: modules, files, functions, line counts, the mechanisms that go. Every path was checked against the submodule at `fc17468`. |
| 4 Target state | The code after the cut-over. |
| 5 Work items | Numbered `WI-<prefix>-n`, in dependency order. |
| 6 Deletions | Every file, function, setting, test and doc line that goes with the phase, in the release that carries it. |
| 7 Tests and fixtures | Unit tests, element and protocol tests in both runners, conformance fixtures from field captures. |
| 8 Manager and UI | Settings added, removed or disabled; what each module shows; Device Manager pages. |
| 9 Image and Yocto | Recipes, services, config. |
| 10 Telemetry and alarms | Signals, where they land, levels. |
| 11 Verification on the test fleet | What is measured on the gate boxes before release, with the tool and the pass criterion. |
| 12 Risks | With the design's R-numbers where they apply. |
| 13 Open questions | The chapter's questions, each written under a proposed default. |
| 14 Estimate | Lines added and deleted, engineer-days, the critical path. |

**A work item** names what is built; where, as file paths (relative to the
app submodule `meta-layers/meta-custom/recipes-apps/media-router/files/
media-router`, or marked "Yocto:" and relative to `/home/mrstation/
media-router-yocto`); how, naming the key functions, data structures,
element names, properties, messages and config keys; an acceptance test
that can fail; and an estimate in lines and engineer-days. Where a work
item makes an engineering choice the design leaves open (§13.3), it says
so, and the choice is recorded in ADR-0029, the timing ADR that Phase 0
creates and every later phase extends.

**Notation.**

- `§n` always refers to the design document; `Q<n>`, `P<n>`, `R<n>` and
  `S<n>` are its decisions, principles, risks and shortcomings; `A.n` its
  appendix.
- `chapter n` refers to this plan. `part n` refers to a numbered heading
  inside the current chapter; `S0 part 4.2` or `P1 part 4.4` to a part of
  another chapter (S0 is chapter 3, P0 to P5 are chapters 4 to 9).
- `WI-<prefix>-n` is a work item, `V-<prefix>-n` (or `V<n>` inside a
  chapter) a gate check, `R-<prefix>-n` a phase risk. The prefixes are S0
  and P0 to P5; they are kept across the document because the chapters
  cite each other's items.
- `OQ-n` is an open question in the register of chapter 15. `C-n` is a
  question a draft chapter asked that was closed during assembly because
  the design document already answers it; chapter 15 lists them with the
  citation (C-1 was later overruled by the owner; its row says so).

**Open questions.** Each chapter's part 13 lists the questions its author
could not answer from the design, with why the design does not answer it,
what it blocks and the default it was written under. Chapter 15 renumbers
them into one register, merges the three that two chapters asked, and
records the eleven that were closed. On 2026-10-12 the owner answered OQ-1
to OQ-10 and overruled C-1, then answered OQ-13 and delegated the rest to
the orchestrator, which decided them the same day (chapter 15.1, Status
column; 15.2). Every question is decided; the text follows the decisions
and no item waits on an answer. Where a decision departs from the default
(OQ-13, OQ-30, OQ-34, OQ-35, the C-1 demux gap, the ptp4l step change),
the affected items say so.

**Verification.** Every draft chapter was cold-checked by a verifier
against the design document and the code: paths, line numbers, GStreamer
1.28.2 sources, Yocto recipes, arithmetic. Chapter 13 gives each verdict.
Where a finding had a clear fix, the chapter's text was corrected during
assembly and the correction is recorded there; where it did not, the
finding stands in chapter 13 as a note for the owner. Claims the verifier
could not check (device facts, external behaviour, effort judgement) are
listed as such.

**Estimates** are planning-grade (±40 %): lines at this repository's
comment density, engineer-days including review. Chapter 12 sums them.

## 2. Cross-cutting rules

These hold in every chapter. Each comes from the design's §13.1 decisions
or from this project's deployment facts.

- **Every phase is a cut-over.** No engine flag, no legacy arm, no in-app
  rollback, no "keep the old path for one release". Rollback is installing
  a previous release from the Device Manager (§13.1, §14).
- **Deletions ship in the same release.** Each phase deletes the mechanism
  it replaces, with its tests, settings, runner glue and documentation
  lines, in the release that stops using it (part 6 of each chapter).
  ADRs are marked superseded, not erased; the design document is kept as
  the design record and ADR-0029 is the living record.
- **Three releases** (OQ-13, the owner, 2026-10-12): Phase 0 alone; then
  Phases 1, 2, 3 and 4 as one release, developed in that order, each phase
  on the previous phase's branch and each still deleting what it replaces;
  then Phase 5. The Phases 1–4 release carries nothing of Phase 5. Each
  phase's part 11 checks run on its development build on the test boxes as
  the work lands; the release gate (chapter 11) runs the union on the
  release image.
- **The current timing model is frozen** during the migration (Q2). No
  fix is made to a mechanism this design removes; open PRs against those
  mechanisms are triaged after the migration (R16). The only edits to
  frozen files are behaviour-preserving moves pinned by the existing tests
  (chapter 3 part 4.5 rule 5).
- **One shared native TS module, no Python twin at runtime.** Everything
  that reads or writes timing in a transport stream — packet walk, PSI,
  PES reassembly for every PID, PCR read and write, PES header rewrite,
  the 33-bit unwrap, the 1 h formula — is implemented once, in C++17 under
  `plugins/mpegts-core/native/mrts`, and used by the ingest restamp, the
  splitter pass-through, the native demux and the egress writer (§11.5,
  §13.1). "No Python twin" means no second live implementation at
  runtime: no runner loads a Python version of any of it and no native
  element has a Python fallback. Python test harnesses that drive a
  native element over appsrc/appsink are allowed. The runtime users of
  today's twins (the Python stamper probe, `unixfd-fanout.py`, the runner
  fallback branches) are deleted per phase (chapter 3 part 6.2); the
  Python modules under `plugins/mpegts-core/py` stay (next rule).
  Pre-existing runner glue that is twinned today (the Python runner and
  `mr-gst-runner`) stays twinned; the rule is scoped to the shared module
  and the new native elements.
- **Prototype in Python, port to C++, keep the Python as the reference.**
  The owner's rule (OQ-1, 2026-10-12): new timing code is prototyped and
  tested in Python first, because that is quicker, and ported to C++ once
  it is right. The Python version stays in the repository as the
  reference and is never loaded by a runner. Nothing under
  `plugins/mpegts-core/py` is deleted for being a twin; it leaves every
  runtime path instead, and its own tests keep running in `test:py`.
- **Both runners.** Every new native element lives in one plugin,
  `libgstmrtshouse.so`, which both pipeline runners load by path before
  parsing any pipeline, with an ABI check; a runner that cannot load it
  starts the module without the timing elements and raises a loud alarm
  where an `identity` can stand in (the restamp, the egress writer, the
  alignment watch), and fails the module with the same alarm text where
  none can (a consumer's `mrtsdemux`) (chapter 3 part 4.5 rule 6; the
  owner's decision on C-1 and the orchestrator's on the demux gap,
  2026-10-12).
  Every element data-flow case and every protocol case runs under
  `MR_GST_RUNNER_NATIVE=1` and `=0`.
- **Dist versus Yocto.** The TypeScript app ships as a dist tarball to
  `/opt/media-router` on the devices and carries no native code. Native
  sidecars, GStreamer plugins and image services ship in the Yocto image
  (`/usr/libexec/media-router/<plugin>/`). Every release of this plan
  carries native changes, so every release is a RAUC image; a dist-only
  deploy must never outrun the native set. That is the rule learned from
  the 2026-08-05 unixfd protocol skew on 10.9.1.42 (hot-deployed JS
  against image-era `mr-tssplit`/`mr-bus-fanout`), recorded in the
  project's deploy notes, not in the repository. Hot-deploying a `.so`
  into `/opt/media-router/plugins/<plugin>/native/<tool>/` is for
  verification on a test box only, together with the dist that expects its
  ABI.
- **Fixtures come from field captures.** Conformance fixtures are recorded
  on the gate boxes 10.9.16.103 and 10.9.16.108 by the assistant session
  that has rig access, at the start of each phase's fixture work, after a
  check of what captures already exist on .103; the owner supplies a vMix
  feed or recording only if no rig can subscribe to one (OQ-3). They are
  trimmed to ≤ 2 MB, committed in the repository under `tests/fixtures`
  with a reviewed expectation file, kept off the device (OQ-2: WI-S0-13
  excludes every `tests/` directory from the image and the dist tarball),
  and replayed at several chunkings and through both runners (chapter
  10). Synthetic fixtures come from one deterministic generator,
  `fixture_gen.cpp`, so they need no Python to regenerate.
- **The gate boxes** are 10.9.16.103 (Pi 5) and 10.9.16.108 (Pi 4). Every
  release is installed on both as a RAUC bundle and passes its part 11
  checks in both runners before it ships. Nothing in this plan touches them
  before Phase 0's verification window.
- **Timing settings are removed, not migrated** (Q9, R13):
  `playoutOffsetMs`, `lipSyncMs`, `syncOffsetMs`, `mixLatencyMs` and
  `subtitleDelayMs` go with the mechanisms that used them (Phases 2 to 4);
  stored values are left in place and ignored (OQ-33). The settings that
  replace them are ingest-side only: the ingest offset O and the per-PID
  trim (Phase 1), Timing Mode and Trust Tolerance (Phase 5). There is no
  output-side trim of any kind (§8, Q18).
- **Nothing after ingest is dropped for being late** (P11). Aligners wait
  for data or a gap; W is a silence limit, not a lateness limit; D_e
  follows lateness at the egress; a full queue is an alarmed resource
  fault; no catch-up and no paced egress in this version (§15).
- **Lateness is shown everywhere** (§9.5): from Phase 0 every module shows
  its output lateness and added latency, labelled. The lateness alarm and
  the output capacity alarm are deferred (OQ-8, OQ-34, 2026-10-12); when
  they come they warn and never drop.

## 3. The shared native TS module (S0, mpegts-core)

| Field | Value |
|---|---|
| Chapter | 3, work-item prefix S0 |
| Implements | §11.5 lead paragraph, §13.1 "One shared native TS module", §6 item 2 |
| Ships in | With Phase 1, inside the Phases 1–4 release (§14; OQ-13); foundation of Phases 1, 2, 3 and 5 |
| Code baseline | submodule `fc17468` (branch docs/house-clock-timing-design); every path below was checked with `ls`/`grep` on 2026-10-12 |
| Paths | relative to the submodule unless marked "Yocto:" |

### 1. Goal

One native implementation of everything that reads or writes timing in an
MPEG-TS byte stream: the packet walk, PSI, PES reassembly for every PID, PCR
read and write, PES header rewrite, the 33-bit unwrap and the 1 h formula.
It lives in the library plugin `plugins/mpegts-core` as a C++17 core
(`native/mrts`, no GStreamer dependency) plus one GStreamer plugin
(`native/mrtshouse/libgstmrtshouse.so`) that both pipeline runners load by
path. Four users call it: the ingest restamp (Phase 1), the splitter
pass-through (Phase 2), the native formula demux (Phase 3) and the egress
writer (Phase 5). It has no Python twin at runtime, so the twin-parity
burden (#819) ends with it; the Python under `py/` stays as the reference
(chapter 2). This section plans the module itself: its API, how the pieces
that exist today fold into it, the build, the loading, the tests and the Pi 4
budget. The four user elements are planned in their own phase sections and
only their entry points are fixed here. It implements the §14 Phase 1 row's
precondition ("Every bus edge carries house time in-band" needs a writer, and
the writer needs this module) and is built first.

### 2. Design references

| Reference | What it decides for this section |
|---|---|
| §13.1 "One shared native TS module" (2026-10-12) | One mpegts-core module; the four users are thin; both runners load it; no Python twin. |
| §11.5 lead paragraph | The function list (packet walk, PSI, PES reassembly for every PID, PCR read/write, PES header rewrite, unwrap, 1 h formula) and the pieces that fold in: `ts_psi`, `ts_timeline`'s `house_from_mux_pts`, `ts_split`, `mrpeshouse`'s PES walker. |
| §6 item 2 (P9) | Running time = `unwrap(PES PTS) − 1 h`, DTS likewise; the demux parses PES headers itself; the bus stamp is never read for time; the conformance fixture list (B-frames, several PIDs in one buffer, 33-bit wrap, gaps, PMT change, PES without PTS, sparse private streams). |
| §4.3, §4.4 | Bus representation `(MONO + 1 h) mod 2^33`; network `H mod 2^33`; the constant `E − 1 h` applied at the boundary only; receivers unwrap nearest their own clock (valid while lateness < 13 h). |
| §5.1 | The ingest rewrites PES PTS/DTS and the PCR in place: the byte machinery is this module's rewrite primitives. |
| §7 | The egress writes `PCR = H(emission) − D_e` at most 40 ms apart, inserts PCR-only packets on a sparse PCR PID, flags D_e changes with `discontinuity_indicator`, and adds a registration descriptor to the PMT. |
| §6 item 6, §11.1 ts-splitter row | The splitter passes PES bytes untouched and copies the program PCR, which `mr-tssplit` already re-injects. |
| §11.4 | Fate table: the anchored stamper and conditioner (Phase 2), branch align/retime (Phase 3), subtitle K recovery (Phase 3). This section only moves pure functions out of those files; the mechanisms go in their phases. |
| §13.1 "The current model is frozen" (Q2) | Nothing in today's timing behaviour changes in this section: the moves are behaviour-preserving and pinned by the existing C++ tests and parity suites until those are deleted. |
| §13.3 "Shared TS module" | Engineer's choice within the design; recorded in the timing ADR. The choices this section makes are listed in parts 4 and 5. |
| R1, R3, R9, R11, R18, R19, R20 | Coverage fixtures, scope, PES memory caps, egress cost, monotonic guard, wrap fixtures and a wrap test mode, version safety across a mixed fleet. |

### 3. Current state

#### 3.1 The pieces that exist today

All under `plugins/mpegts-core/native/`. Line counts from `wc -l` on
2026-10-12.

| Piece | Files | Lines | What it does today | Users |
|---|---|---|---|---|
| mrts PSI core | `mrts/ts_psi.{h,cpp}` | 144 + 317 | Packet header helpers (`ts_pid`, `ts_pusi`, `payload_offset`), CRC-32/MPEG, `read_pcr`, `read_pes_pts` (PTS only), `build_pcr_packet`, `null_packet`, single-packet PAT/PMT builders, `first_section` (section 0 only), `parse_pat`, `parse_pmt`, `section_signature`, `PsiDiscovery` (incremental PAT→PMT, first program only) | `ts_split`, `ts_timeline`, `mrpeshouse/pes_walk.cpp`, `mr-gst-runner` (`branch_align.cpp:15`, `branch_retime.cpp:15`, `gates.cpp:17`), `mr-tssplit`, `mr-bus-fanout` |
| mrts timeline | `mrts/ts_timeline.{h,cpp}` | 370 + 1,085 | `house_from_mux_pts` (:277–281, the formula), `unwrap_near` (:219), `pts90k_to_ns` (:210), `TimelineLatch`, `TimelineStamper` (anchored stamper, latch repair, watch, staleness net, drift servo, conditioner with PCR regeneration, identity `stamp_house` :902–942). The DTS reader (`read_pes_dts` :609–617), the 5-byte field writer (`write_ts_field` :621–628) and `write_pcr` (:629–637) are in an anonymous namespace: not exported | `mrtsstamp`, `mr-tssplit`, `mr-bus-fanout`, `mr-gst-runner` (`branch_align`, `branch_retime`) |
| mrts splitter | `mrts/ts_split.{h,cpp}` | 125 + 224 | `SplitterCore`: packet-level per-PID SPTS router; remainder carry across feeds (`rem_`), resync, PSI carousel every 40 packets, master-PCR re-injection ≥ 10 ms apart (`SplitOutput::batch` :15–41); no PES assembly | `mr-tssplit` (`plugins/ts-splitter/native/mr-tssplit/app.h`) |
| mrts video info | `mrts/ts_video_info.{h,cpp}`, `mrts/sps_parse.{h,cpp}` | 53 + 112, 29 + 302 | H.264/H.265 SPS probe for the video-player `tsprobe` | `gates.cpp:18`, `mr-tssplit`, `mrts_cli` |
| mrts harness | `mrts/mrts_cli.cpp` | 137 | Parity CLI: feeds a TS file through `SplitterCore`, emits JSON events | `tests/nativeSplitParity.test.ts` |
| mrts tests | `mrts/tests/{check.h, ts_psi_test, ts_split_test, ts_timeline_test, ts_video_info_test}.cpp` | 21 + 288 + 504 + 1,664 + 184 | C++ unit tests, ported from the `_test.py` scripts; `ts_timeline_test.cpp:1614–1617` pins `house_from_mux_pts` | `make -C mrts test`, `build-host.sh test`, root `make native-test` |
| mrtsstamp element | `mrtsstamp/gstmrtsstamp.cpp`, `mrtsstamp/Makefile` | 862 + 53 | `GstBaseTransform` egress stamper wrapping `TimelineStamper`; chain_list coalescing (ADR-0011); `active` arm; `bytes-total`; compiles `ts_timeline.cpp` and `ts_psi.cpp` INTO the .so because `libmrts.a` is built without `-fPIC` (Makefile :4–8) | Both runners, spliced at every `busout_*` tee |
| mrpeshouse element | `mrpeshouse/gstmrpeshouse.cpp`, `pes_walk.{h,cpp}`, `stamp_model.{h,cpp}`, `Makefile`, `tests/stamp_model_test.cpp`, `tests/stamp_model_vectors.txt` | 215, 66 + 101, 59 + 60, 57, 89, 3,667 | Subtitle bridge's PES walk for ONE stream_id (0xBD): `parse_pes_header` (its own, PTS only), `PesWalker` (64 KB cap, no DTS, no CC, unbounded closed at next PUSI), `StampModel` (K learning). Python spec: `plugins/subtitle-core/py/subtitle_ts.py`, `subtitle_stamp_model.py` | `plugins/subtitle-core/py/subtitle_native.py` (python runner only) |
| build glue | `build-host.sh`, `mrts/Makefile` | 17, 34 | Host build of the portable core and its tests; the archive `libmrts.a` is non-PIC | `nativeSplitParity.test.ts`, Yocto |

#### 3.2 The Python twins

`plugins/mpegts-core/py/`, 4,710 lines, parity-locked to the C++ by the
golden suite `plugins/mpegts-core/tests/nativeSplitParity.test.ts` and by
`package.json` `test:py` (`ts_psi_test`, `ts_split_test`, `ts_video_info_test`,
`ts_timeline_test`). ADR-0001's consequence names the Python as "the
executable specification".

| File | Lines | Production importers today (tests excluded) |
|---|---|---|
| `ts_timeline.py` + `ts_timeline_test.py` | 1,394 + 1,275 | `packages/engine/src/child-process/gst_stamp_probe.py:109` (python fallback stamper), `gst-pipeline-runner.py:1158` (`preserveSourceTimeline`), `:1531` (`alignBranchesToStamps`), `branch_retime.py:66,260`, `plugins/unixfdbus-core/py/unixfd-fanout.py:116` (`--stamp-timeline`) |
| `ts_psi.py` + `ts_psi_test.py` | 441 + 203 | `ts_timeline.py`, `gst-pipeline-runner.py:1530` (align), `:3565` (`tsProbe`), `branch_retime.py:259` |
| `ts_split.py` + `ts_split_test.py` | 266 + 388 | none: `ts-splitter` has no Python fallback (recipe comment, `media-router.bb:148`); only `native_parity_ref.py` |
| `ts_video_info.py`, `sps_parse.py` + `ts_video_info_test.py` | 126, 266 + 149 | `gst-pipeline-runner.py:3566` (`tsProbe`, not timing) |
| `native_parity_fixture.py`, `native_parity_ref.py` | 128 + 74 | the parity vitest only |

#### 3.3 How the runners load a native element today

- Native runner: `packages/engine/native/mr-gst-runner/stamper.cpp:47–75`
  resolves `paths::asset_candidates("mpegts-core", "mrtsstamp",
  "libgstmrtsstamp.so")` (`paths.cpp:35–39`: the plugins tree
  `plugins/<plugin>/native/<tool>/<file>` first, then
  `/usr/libexec/media-router/<plugin>/<file>`) and calls
  `gst_plugin_load_file`. A miss is a warning, not an error (`:74–75`). The
  RIST elements use the same resolver (`gates.cpp:549`) and are loaded at
  `runner.cpp:296`, three lines before `gst_parse_launch` (`:299`).
- Python runner: `packages/engine/src/child-process/gst_stamp_native.py:40–86`
  (`so_paths`, `load_plugin`: `MR_PLUGINS_DIR`/`MR_LIBEXEC_DIR` overrides,
  same two candidates, `Gst.Plugin.load_file`), cached once per process by
  `gst_bus_stamper.py:98` (`load_native`); the pipeline is parsed at
  `gst-pipeline-runner.py:2082`. A miss falls back to the Python probe.
  `plugins/subtitle-core/py/subtitle_native.py:19–45` repeats the pattern for
  `mrpeshouse`.
- Never `GST_PLUGIN_PATH` (the comment in `gst_stamp_native.py:44–47` says
  why: a plugin on the global path would be scanned into every GStreamer
  process on the box).

#### 3.4 Build and packaging today

- Root `Makefile:19` auto-discovers `plugins/*/native/*/Makefile` and
  `packages/engine/native/*/Makefile`; `make native`, `native-test`,
  `native-install` (to `$(DESTDIR)$(PREFIX)/libexec/media-router/<plugin>/`),
  `native-clean`.
- Yocto: `meta-layers/meta-custom/recipes-apps/media-router/media-router.bb`
  `do_compile` runs `oe_runmake native-clean` then `native` (`:156–157`);
  `do_install` runs `native-install` with `LIBEXECDIR=${libexecdir}`
  (`:166`), then `native-clean` and copies the tree to `/opt/media-router`
  (`:177–180`). `DEPENDS` already carries `gstreamer1.0`, `-plugins-base`
  and `-plugins-bad` (`:33–36`), which provide `gstreamer-1.0`,
  `gstreamer-base-1.0` and `gstreamer-mpegts-1.0`.
- The TS dist tarball that hot-deploys to `/opt/media-router` carries no
  native binaries; the image's `/usr/libexec/media-router/<plugin>/` does.
  A `.so` dropped into `/opt/media-router/plugins/mpegts-core/native/<tool>/`
  wins over libexec by the resolution order above (that is the hot-deploy
  path for a test box, and the 2026-08-05 protocol-skew incident on
  10.9.1.42 — hot-deployed JS against image-era `mr-tssplit` and
  `mr-bus-fanout`, recorded in the project's deploy notes, not in the
  repository — is why the two must be shipped together).
- `build-native-dev.sh` builds static binaries in Docker (`gcc:14`), which
  has no GStreamer headers: the GStreamer elements are skipped there
  (`mrtsstamp/Makefile:48–50`). The dev box is itself aarch64 with
  GStreamer 1.28.2 dev packages (`pkg-config --modversion gstreamer-1.0
  gstreamer-base-1.0 gstreamer-mpegts-1.0` → 1.28.2, `c++` 12.2), so it
  builds the elements for the Pi fleet directly.
- `mr-gst-runner/Makefile:27–31` compiles `ts_psi.cpp`, `ts_timeline.cpp`,
  `ts_video_info.cpp` and `sps_parse.cpp` into the runner binary rather than
  linking `libmrts.a`.

#### 3.5 Three PES header parsers and two writers

The same bytes are parsed in `ts_psi.cpp:79–90` (`read_pes_pts`),
`ts_timeline.cpp:609–617` (`read_pes_dts`, unexported) and
`mrpeshouse/pes_walk.cpp:30–42` (`parse_pes_header`, PTS only, with Python
slice-clamp semantics), and written by `ts_timeline.cpp:621–637`
(`write_ts_field`, `write_pcr`, unexported) and `ts_psi.cpp:92` (PCR-only
packet). The hls-pipe TypeScript demuxer (`packages/hls-pipe/src/demux/`,
727 lines: `ts-packet.ts`, `pat-pmt.ts`, `pes.ts`, `demuxer.ts`) is a fourth,
TypeScript, parser that this module uses as a reference only.

### 4. Target state

#### 4.1 Layout

```
plugins/mpegts-core/native/
  mrts/                      portable C++17 core, no GStreamer, -fPIC
    ts_house.{h,cpp}         NEW  unwrap, 1 h formula, bus<->network, units
    ts_packet.{h,cpp}        NEW  PacketView, PacketWalker, CcTracker
    ts_pes.{h,cpp}           NEW  PesHeader parse/rewrite, PesAssembler,
                                  PesHeaderSpan
    ts_pcr.{h,cpp}           NEW  read/write/build PCR, discontinuity flag,
                                  PcrScheduler
    ts_psi.{h,cpp}           KEPT, generalised (program selection, version,
                                  descriptors, multi-packet sections)
    ts_split.{h,cpp}         KEPT, generalised in Phase 2 (pass-through)
    ts_timeline.{h,cpp}      KEPT until Phase 2 (stamper) / Phase 3 (rest);
                                  pure functions moved out in Phase 1
    ts_video_info, sps_parse UNCHANGED (not timing)
    mrts_cli.cpp             KEPT; gains `dump` (PES index as JSON lines)
    tests/                   + ts_house_test, ts_packet_test, ts_pes_test,
                               ts_pcr_test, ts_conformance_test, mrts_bench
  mrtshouse/                 NEW  the one GStreamer plugin both runners load
    gstmrtshouse.cpp         plugin_init: factory table, version, ABI
    mrtshouse_abi.h          MRTSHOUSE_ABI and the version string
    gstmrtsrestamp.cpp       Phase 1 (planned in chapter 5)
    gstmrtsdemux.cpp         Phase 3 (planned in chapter 7)
    gstmrtsegress.cpp        Phase 5 (planned in chapter 9)
    Makefile                 links ../mrts/libmrts.a (PIC)
  mrtsstamp/                 KEPT until Phase 2 (anchored stamper deleted);
                             what remains of it (coalesce, bytes-total,
                             identity stamp) is Phase 2's decision
  mrpeshouse/                KEPT, untouched except its Makefile's link
                             form (WI-S0-6); deleted in Phase 3
plugins/mpegts-core/tests/fixtures/   NEW  field captures + .expect.jsonl
```

Namespace: everything in `mrts` (the existing one). `mrpeshouse` disappears
with its element in Phase 3.

#### 4.2 Public API

Signatures are the contract; bodies are the engineer's. Every header is
self-contained C++17, `#include <cstdint>` level, no GLib.

**`ts_house.h` — the timescales (§4.3, §4.4)**

```cpp
namespace mrts {
constexpr int64_t PTS_WRAP            = 1LL << 33;
constexpr int64_t MUX_CLOCK_BASE_90K  = 3600LL * 90000;   // 1 h, mpegtsmux
constexpr int64_t PCR_HZ              = 27000000;
constexpr int64_t PCR_MODULO          = 300LL << 33;
constexpr int64_t PCR_MAX_INTERVAL_NS = 40 * 1000000LL;   // §7

int64_t pts90k_to_ns(int64_t ticks);      // floor division, as today
int64_t ns_to_pts90k(int64_t ns);         // floor; inverse within 11.1 us
int64_t ns_to_pcr27(int64_t ns);          // mod PCR_MODULO
int64_t pcr27_to_ns(int64_t pcr27);
int64_t fold33(int64_t d);                // signed, wrap-folded delta
int64_t unwrap_near(int64_t pts33, int64_t ref);          // as today
int64_t house_from_mux_pts(int64_t pts33, int64_t house_now_ns); // bus formula
int64_t mux_pts_from_house(int64_t house_ns);             // inverse, 33-bit

// Continuous per-stream unwrap. The first value is placed nearest `seed`
// (90 kHz, unwrapped: a consumer seeds with ns_to_pts90k(clock − base_time)
// + MUX_CLOCK_BASE_90K, never mux_pts_from_house of it, which folds to 33
// bits; an ingest with the source STC); every later value nearest the
// previous one. DTS is unwrapped nearest the PTS of the same PES, never on
// its own (the a1 wrap fault, §6). Corrected 2026-10-14, chapter 15.4 B-14.
class Unwrapper {
  public:
    int64_t feed(int64_t pts33, int64_t seed);
    int64_t feed_dts(int64_t dts33, int64_t pts_unwrapped);
    void reset();
    bool primed() const;
};

// E and the network boundary (§4.2, §4.3). Used by Phase 5 and by a
// Trust-selected ingest; defined here so both apply one constant.
struct NetEpoch { int64_t e_ns; int64_t e_90k() const; };
int64_t bus_to_net(int64_t pts33, const NetEpoch& e); // + E − 1 h mod 2^33
int64_t net_to_bus(int64_t pts33, const NetEpoch& e); // − E + 1 h mod 2^33
int64_t net_pcr27(int64_t h_emission_ns, int64_t d_e_ns); // H(emission) − D_e
}
```

**`ts_packet.h` — the packet walk**

```cpp
namespace mrts {
constexpr int PKT = 188;                  // moves here from ts_psi.h
struct PacketView {
    uint8_t* p;                           // mutable: rewriters write in place
    int pid; uint8_t cc;
    bool tei, pusi, scrambled, has_af, has_payload;
    int af_len, payload_off;              // payload_off == PKT: no payload
    bool af_discontinuity, af_rai, af_pcr;
};
bool parse_packet(uint8_t* p, PacketView* out);   // false: not 0x47

// Walks whole packets across chunk boundaries: carries an unaligned tail
// into the next feed (ts_split's rem_ logic, generalised), resyncs on a lost
// sync byte, counts dropped bytes. `on_packet(PacketView&)` is called in
// order. Chunks are usually whole packets (ADR-0011), so the carry is
// normally empty and the walk is one pass over the buffer, no copy.
class PacketWalker {
  public:
    template <class F> void feed(uint8_t* data, size_t len, F&& on_packet);
    size_t carried() const;               // bytes held for the next feed
    uint64_t desync_bytes() const;
    void reset();
};

// Per-PID continuity counter. Adaptation-only packets never advance CC;
// a duplicate (same CC, same payload flag) is reported, not an error;
// `af_discontinuity` resets expectation.
class CcTracker {
  public:
    enum class Result { Ok, Duplicate, Lost, Reset };
    Result feed(const PacketView& v);
    uint64_t lost() const;
};
}
```

**`ts_pes.h` — PES headers, reassembly, rewrite**

```cpp
namespace mrts {
struct PesHeader {
    uint8_t sid;
    int64_t pts = -1, dts = -1;           // raw 33-bit, −1 = absent
    int     header_len;                   // 9 + PES_header_data_length
    int64_t payload_len = -1;             // −1 = unbounded (length 0)
    bool    data_alignment;
    int     pts_off = -1, dts_off = -1;   // byte offsets of the 5-byte
                                          // fields from the PES start
    bool    complete;                     // the whole header was present
};
// Parses from a PES start (00 00 01). `n` = bytes available. Stream ids
// with no optional header (0xBC, 0xBE, 0xBF, 0xF0–0xF2, 0xF8, 0xFF) give
// pts = dts = −1 and header_len = 6. Replaces ts_psi::read_pes_pts,
// ts_timeline's read_pes_dts and mrpeshouse::parse_pes_header.
bool parse_pes_header(const uint8_t* pes, size_t n, PesHeader* out);

// The 5-byte field writer (was write_ts_field): keeps the 4-bit prefix and
// marker bits, writes the 33-bit value.
void write_pes_ts_field(uint8_t* field, int64_t v33);
// Rewrites PTS and, when present, DTS in place. False when the header is
// not complete in this packet (see PesHeaderSpan).
bool rewrite_pes_timestamps(PacketView& v, const PesHeader& h,
                            int64_t pts33, int64_t dts33);

// For rewriters: a PUSI packet whose PES header spills into the next packet
// of the same PID (an adaptation field can leave < 19 payload bytes). The
// span holds that packet, joins the header view across the two, rewrites
// both, then releases both in order. At most one packet per PID is held;
// other PIDs are never delayed. Counted (`spans`).
class PesHeaderSpan { /* hold(v) / complete(v, out_pair) / counters */ };

struct PesUnit {
    int pid; PesHeader hdr;
    std::vector<uint8_t> payload;         // empty when keep_payload=false
    bool discont;                         // CC loss or PUSI-less start
    uint64_t seq;                         // per PID
};
// PES reassembly for every selected PID (not one stream_id): bounded PES
// complete at their length, unbounded at the next PUSI or at flush(); a
// CC loss drops the open unit and flags the next; units larger than
// `max_bytes` are dropped and counted (R9). keep_payload=false gives the
// ingest and egress rewriters the header index without a copy.
class PesAssembler {
  public:
    struct Config { size_t max_bytes = 32u << 20; bool keep_payload = true; };
    void select(int pid, bool on);
    void feed(const PacketView& v, CcTracker::Result cc,
              std::vector<PesUnit>& out);
    void flush(std::vector<PesUnit>& out);  // EOS / PMT change
    void reset();
    uint64_t oversize() const; uint64_t dropped_cc() const;
};
}
```

**`ts_pcr.h` — the PCR**

```cpp
namespace mrts {
int64_t read_pcr(const uint8_t* pkt);                 // moved from ts_psi
bool    write_pcr(PacketView& v, int64_t pcr27);      // only if af_pcr
bool    set_discontinuity_indicator(PacketView& v);   // needs an AF
void    build_pcr_packet(int pid, int64_t pcr27, int cc, bool discontinuity,
                         uint8_t out[PKT]);           // AF-only, no payload

// Egress-side cadence (§7): when the PCR PID has carried no PCR for
// PCR_MAX_INTERVAL_NS a PCR-only packet is due; tracks the PID's last
// payload CC (AF-only packets reuse it, as build_pcr_packet requires).
class PcrScheduler {
  public:
    void saw_pcr(int64_t house_now_ns);
    void saw_payload(uint8_t cc);
    bool due(int64_t house_now_ns) const;
    uint8_t cc() const;
};
}
```

**`ts_psi.h` — kept, generalised**

Kept as is: `crc32_mpeg`, `ts_pid`/`ts_pusi`/`ts_has_payload`/
`payload_offset` (now thin wrappers over `parse_packet`), `PmtStream`,
`Pmt`, `build_pat`, `build_pmt`, `first_section`, `parse_pat`, `parse_pmt`,
`section_signature`, `PsiDiscovery`. Added:

```cpp
namespace mrts {
struct Descriptor { uint8_t tag; const uint8_t* data; int len; };
template <class F> void for_each_descriptor(const uint8_t* loop, int n, F&&);
// 'BSSD', 'KLVA', 'Opus', 'HEVC', 'AV1G', 'ID3 ' ... or 0 (R1 caps table)
uint32_t registration_format(const std::vector<uint8_t>& es_info);
bool     has_descriptor(const std::vector<uint8_t>& es_info, uint8_t tag);

struct Pmt { /* + */ int version; std::vector<uint8_t> program_info; };

class PsiDiscovery {
  public:
    /* + */ void select_program(int program_number);   // −1 = first (today)
    /* + */ int  generation() const;    // bumps on every PMT change
    /* + */ uint64_t unsupported_sections() const;     // section_number != 0
};

// Sections larger than one packet (a PMT with the Phase 5 descriptor, an
// MPTS PAT): build the section bytes, then packetise with CC continuation.
std::vector<uint8_t> build_pmt_section(int program_number, int pcr_pid,
    const std::vector<uint8_t>& program_info,
    const std::vector<PmtStream>& streams, int version);
void packetise_section(int pid, const std::vector<uint8_t>& section,
    uint8_t& cc, std::vector<uint8_t>& out);
}
```

`ts_psi.h` keeps `read_pes_pts` and `read_pcr` as inline forwarders to
`ts_pes.h`/`ts_pcr.h` until their last caller moves (Phase 3), so no
frozen-model file needs editing for the move.

#### 4.3 How each user calls it

| User (phase, owner section) | Where it runs | Entry points, in call order per bus buffer |
|---|---|---|
| **Ingest restamp** (Phase 1, chapter 5): element `mrtsrestamp` in `libgstmrtshouse.so`, spliced at the egress head of rist/srt/udp inputs | both runners | `PacketWalker::feed` (mutable) → PSI packets to `PsiDiscovery::feed` (PCR PID, ES list for the per-PID trim) → on `af_pcr`: `read_pcr` → virtual STC (Phase 1's code) → `write_pcr` → on `pusi`: `parse_pes_header` (or `PesHeaderSpan` when `!complete`) → `Unwrapper::feed` (seeded from the source PCR) → house PTS/DTS from the STC, `+ O`, `+ trim[pid]`, per-ES monotonic guard (Phase 1's) → `mux_pts_from_house` → `rewrite_pes_timestamps`. No `PesAssembler`: the restamp never copies payload. |
| **Splitter pass-through** (Phase 2, chapter 6): `mr-tssplit`, links `libmrts.a` | sidecar | `SplitterCore::feed` unchanged in shape; `SplitOutput::batch` keeps the PSI carousel and re-injects the program PCR through `ts_pcr::build_pcr_packet` (the input PCR is house-locked after Phase 1, so copying it is P5 for free); the bus stamp of each batch becomes identity: `house_from_mux_pts(first PES PTS in the batch, mono_now)` via `parse_pes_header`, replacing `TimelineStamper` (`app.cpp` `stamp_for`). PES bytes untouched. |
| **Native formula demux** (Phase 3, chapter 7): element `mrtsdemux` | both runners | `PacketWalker::feed` (const: an overload Phase 3 adds, chapter 15.4 B-15) → `CcTracker::feed` → `PsiDiscovery::feed` (`select_program`, `generation` → pad generation digit) → `for_each_descriptor` + `registration_format` for the caps table (R1) → `PesAssembler::feed` per selected PID (keep_payload) → per `PesUnit`: `Unwrapper::feed(pts, ns_to_pts90k(clock − base_time) + MUX_CLOCK_BASE_90K)` (unwrapped, chapter 15.4 B-14), `feed_dts(dts, pts_u)` → buffer PTS = `pts90k_to_ns(pts_u − MUX_CLOCK_BASE_90K)`, DTS likewise; a unit with `pts = −1` gets `GST_CLOCK_TIME_NONE`; sparse PIDs get GAP events from the program's latest formula time (Phase 3's). The bus stamp is never read. |
| **Egress writer** (Phase 5, chapter 9): element `mrtsegress` | both runners | `PacketWalker::feed` (mutable) → `PsiDiscovery::feed` → on `pusi`: `parse_pes_header`/`PesHeaderSpan` → `bus_to_net` on PTS and DTS → `rewrite_pes_timestamps` → on the PCR PID: `write_pcr(net_pcr27(H_now, D_e))` where a PCR is carried, `PcrScheduler::due` → `build_pcr_packet` inserted when the PID is sparse, `set_discontinuity_indicator` on the first PCR after a D_e change → the source PMT packets replaced by `build_pmt_section` with the house-time registration descriptor appended to `program_info`, `packetise_section` continuing the PMT PID's CC. |

Trust-selected ingest (Phase 5) uses `net_to_bus` in place of the STC path.

#### 4.4 Fold-in: kept, generalised, deleted, and when

| Existing piece | Fate | When |
|---|---|---|
| `ts_psi` packet helpers, CRC, PAT/PMT parse, `section_signature`, `PsiDiscovery` | Kept; generalised per part 4.2 (program selection, generation, descriptors, multi-packet sections, unsupported-section counter) | Phase 1 |
| `ts_psi::read_pes_pts`, `read_pcr`, `build_pcr_packet` | Moved to `ts_pes`/`ts_pcr`; inline forwarders stay in `ts_psi.h` | Moved Phase 1; forwarders deleted Phase 3 with `branch_align`/`branch_retime` |
| `ts_timeline::house_from_mux_pts`, `unwrap_near`, `pts90k_to_ns`, `PTS_WRAP`, `MUX_CLOCK_BASE_90K` | Moved to `ts_house.h`; `ts_timeline.h` includes it, names unchanged | Phase 1 |
| `ts_timeline.cpp` anonymous `read_pes_dts`, `write_ts_field`, `write_pcr`, `fold` | Replaced by `parse_pes_header`, `write_pes_ts_field`, `ts_pcr::write_pcr`, `fold33`; the conditioner calls the exported ones | Phase 1 (pure move; `ts_timeline_test.cpp` and the python parity pin behaviour) |
| `TimelineLatch`, `TimelineStamper` (anchored, latch repair, watch, net, servo, conditioner), `*_event_json`, `drift_stats_json` | Deleted with the anchored stamper (§11.4 row 1–2) | Phase 2 |
| `TimelineStamper::stamp_house` (identity) | Becomes a 10-line free function `identity_stamp(data, len, now)` in `ts_house` (first PES PTS through `house_from_mux_pts`); mrtsstamp/mr-tssplit/mr-bus-fanout call it | Phase 2 |
| `ts_split::SplitterCore`, `SplitOutput` | Kept. The remainder/resync logic (`rem_`, `joined_`) moves into `PacketWalker` and `SplitterCore` uses it (WI-S0-6); later `batch` takes its PCR from `ts_pcr` and the pass-through generalisation follows | Walker: Phase 1 (WI-S0-6); PCR source and pass-through: Phase 2 |
| `mrts_cli` | Kept; `dump` verb added; the `--outputs` splitter mode is deleted with the parity suite | `dump` Phase 1; splitter mode deleted Phase 2 |
| `mrpeshouse` (element, `PesWalker`, `parse_pes_header`, `StampModel`, vectors) | Untouched except its Makefile's link form (WI-S0-6) (frozen, Q2); `PesWalker`'s rules (unbounded closed at next PUSI, bounded by length) are re-implemented in `PesAssembler` for every PID without the 64 KB cap; the element is deleted with subtitle K recovery | Phase 3 |
| `mrtsstamp` | Untouched in Phase 1; Phase 2 strips it to coalesce + `bytes-total` + identity stamp (chapter 6's call) | Phase 2 |
| `ts_video_info`, `sps_parse` | Unchanged; not timing | — |
| hls-pipe demux (`packages/hls-pipe/src/demux/`) | Unchanged; reference for the conformance comparison only (part 7) | — |

#### 4.5 Rules fixed by this section

1. **No Python twin at runtime.** No runner loads a Python implementation
   of TS parsing, PES reassembly, PCR handling, unwrap or the formula, and
   the four user elements have no Python probe fallback: a runner that
   cannot load `libgstmrtshouse.so` starts the module without the element
   and alarms, or fails the module where no stand-in exists (rule 6). New
   timing code is prototyped and tested in Python
   first and ported to C++ once right; the Python stays under
   `plugins/mpegts-core/py` as the reference and is never loaded (the
   owner's rule, chapter 2, OQ-1). Python test *harnesses* that drive a
   native element over appsrc/appsink (the `gst_mrtsstamp_element_test.py`
   pattern) are allowed. ADR-0001's consequence "the python is the
   executable specification" is amended in the timing ADR to "the python
   is the reference; only the C++ runs".
2. **One source, two link forms.** `libmrts.a` is built `-fPIC` and linked
   by the plugin, the sidecars and the native runner. No tool compiles
   `mrts/*.cpp` into itself any more.
3. **One plugin, many elements.** `libgstmrtshouse.so` registers every
   house-clock element; a phase adds its factory to the table in
   `gstmrtshouse.cpp`. Both runners load exactly this one file for the
   timing path (plus `mrtsstamp` and `mrrist` as today).
4. **Version-checked load.** The plugin exports `MRTSHOUSE_ABI` (integer)
   and a version string; each runner compares the loaded ABI with the one
   the engine was built against and refuses an older plugin, naming both
   numbers. This is the guard against the 2026-08-05 dist-vs-native skew
   (part 3.4).
5. **Behaviour-preserving moves only** in Phase 1 for anything the frozen
   model still runs (Q2). Each move is pinned by the existing C++ tests and
   by the Python parity suites, which stay green until deleted.
6. **A missing or stale plugin starts the module and alarms.** A runner
   that cannot load `libgstmrtshouse.so`, or finds its ABI older than the
   one it was built against, does not fail: it emits a `warning` event
   naming the tried paths (or both ABI numbers), builds the module's
   pipeline without the timing elements and runs it. The engine turns the
   event into a loud alarm on the module: "Native TS module not loaded:
   this stream carries no house time on the bus; consumers will mis-time
   it until the deploy is fixed." The alarm stays until a start loads the
   plugin. Decided by the owner on 2026-10-12 (chapter 15, C-1),
   overruling the assembly's reading of §13.1 ("fail the module"): a
   stream on source time is better than no stream, and the alarm is the
   guard. The runner substitutes `identity` with the same `name=` for
   each element the plugin would have provided, drops its other
   properties, and answers later `set_property` calls on it with a
   warning. That works for the pass-through elements (the restamp, the
   egress writer, the alignment watch), where the bytes keep flowing on
   source time. A demux has no pass-through stand-in: a module whose
   pipeline names `mrtsdemux` (the 302M fan-ins from Phase 2, every
   consumer from Phase 3) fails to start, with the same alarm text, when
   the plugin cannot be loaded. Start-but-warn applies only where a
   stand-in exists. Decided 2026-10-12 by the orchestrator, owner
   delegated (chapter 13.8, chapter 15 C-1).

### 5. Work items

Ordered by dependency. Estimates are lines of source at this repo's comment
density (±40 %) and engineer-days including review.

#### WI-S0-1 `ts_house`: units, unwrap, formula, network boundary

- **What.** New `mrts/ts_house.{h,cpp}` with the API in part 4.2; move
  `house_from_mux_pts`, `unwrap_near`, `pts90k_to_ns`, `PTS_WRAP`,
  `MUX_CLOCK_BASE_90K` out of `ts_timeline.{h,cpp}` and `PCR_HZ`,
  `PCR_MODULO` out of `ts_psi.h`; add `ns_to_pts90k`, `ns_to_pcr27`,
  `pcr27_to_ns`, `fold33`, `mux_pts_from_house`, `Unwrapper`, `NetEpoch`,
  `bus_to_net`, `net_to_bus`, `net_pcr27`.
- **Where.** `plugins/mpegts-core/native/mrts/ts_house.{h,cpp}`;
  `ts_timeline.h` gains `#include "ts_house.h"`; `ts_timeline.cpp:210–222`
  (`pts90k_to_ns`, `unwrap_near`), `:277–281` (`house_from_mux_pts`), the
  anonymous `mod_wrap` (:138–143, replaced by `fold33`) and the anonymous
  `fold` (:603–608) are deleted there. Lines :224–275 (`TimelineLatch`,
  `TimelineStamper::reset_drift`) are anchored-stamper code the frozen
  model still runs (Q2); they stay until Phase 2 (part 4.4).
- **How.** Pure integer arithmetic, Python floor semantics kept where the
  parity tests pin them (`pts90k_to_ns`). `Unwrapper::feed` = `unwrap_near`
  against the last unwrapped value, seeded nearest `seed` on first use;
  `feed_dts` = `unwrap_near(dts, pts_unwrapped)` with a sanity check
  `|pts − dts| ≤ 5 s` (else DTS is discarded, counted). `bus_to_net(pts) =
  (pts + e_90k − MUX_CLOCK_BASE_90K) mod 2^33` with `e_90k = e_ns × 9 /
  100000` (floor). `net_pcr27 = ns_to_pcr27(h − d_e)`.
- **Acceptance.** `mrts/tests/ts_house_test.cpp`: formula inverts the 1 h
  offset exactly (today's :1614–1617 cases moved), wrap at 2^33 in both
  directions, `Unwrapper` across a wrap with DTS < PTS (the a1 fault of §6),
  `bus_to_net`/`net_to_bus` round-trip for E = 0, E = boot + 37 s and E
  across a wrap; `ts_timeline_test` and `py/ts_timeline_test.py` still pass.
- **Estimate.** 150 lines + 200 test; 1 day.

#### WI-S0-2 `ts_packet`: walker and continuity

- **What.** `PacketView`, `parse_packet`, `PacketWalker` (remainder carry,
  resync, desync count), `CcTracker`.
- **Where.** `mrts/ts_packet.{h,cpp}`; `ts_psi.h`'s `PKT`, `SYNC_BYTE`,
  `ts_pid`, `ts_pusi`, `ts_has_payload`, `payload_offset` become wrappers.
- **How.** The walk is a loop over 188-byte steps with no copy when the
  chunk is aligned; on a sync loss it scans forward for `0x47` at i and
  i + 188 (hls-pipe `ts-packet.ts` rule), counts the skipped bytes, and
  carries any tail < 188 into a small buffer joined at the next feed
  (`ts_split.cpp` `rem_`). `CcTracker` follows ISO 13818-1 2.4.3.3: AF-only
  packets do not advance CC; one duplicate is legal; `af_discontinuity`
  resets.
- **Acceptance.** `ts_packet_test.cpp`: chunk boundaries at every offset of
  a 10-packet fixture produce the same packet sequence; garbage between
  packets is dropped and counted; CC cases (ok, duplicate, lost, AF-only,
  discontinuity flag). Byte-for-byte equality of `SplitterCore` output when
  it is switched to the walker (WI-S0-6), pinned by `ts_split_test.cpp` and
  the parity suite.
- **Estimate.** 180 + 150 test; 1 day.

#### WI-S0-3 `ts_pes`: header parse, rewrite, reassembly, header span

- **What.** `PesHeader`, `parse_pes_header`, `write_pes_ts_field`,
  `rewrite_pes_timestamps`, `PesHeaderSpan`, `PesUnit`, `PesAssembler`.
- **Where.** `mrts/ts_pes.{h,cpp}`; `ts_psi.cpp:79–90` and
  `ts_timeline.cpp:609–628` are replaced by calls (forwarders kept in
  `ts_psi.h`; the conditioner at `ts_timeline.cpp:833–841` calls the
  exported writer).
- **How.** Header parse per ISO 13818-1 2.4.3.6/2.4.3.7: no-header stream
  ids; `'10'` marker; PTS_DTS_flags `10`/`11`; `PES_header_data_length`;
  `data_alignment_indicator`; `PES_packet_length` 0 = unbounded (what
  `mpegtsmux` writes for video over 64 KB, `tsmuxstream.c:543–556`); field
  offsets recorded for the rewriter. `PesAssembler`: per PID an open unit
  (header, declared length, bytes so far); PUSI closes an open unbounded
  unit and starts a new one; a bounded unit completes at its length; CC loss
  drops the open unit and sets `discont` on the next; `max_bytes` drops and
  counts (R9); `keep_payload=false` skips the copy. `PesHeaderSpan`: holds
  the PUSI packet of a PID when `header_len > PKT − payload_off`, completes
  on the next packet of that PID, rewrites across both, releases both. Depends
  on WI-S0-1, WI-S0-2.
- **Acceptance.** `ts_pes_test.cpp`: PTS-only, PTS+DTS, no-PTS, no-header
  stream ids, header spanning two packets, bounded and unbounded PES across
  chunk boundaries, 64 KB + 1 payload, CC loss mid-PES, oversize drop,
  rewrite round-trip (`parse` → `rewrite` → `parse` gives the new values and
  every other byte unchanged); the conditioner's existing cases in
  `ts_timeline_test.cpp` unchanged.
- **Estimate.** 350 + 350 test; 3 days.

#### WI-S0-4 `ts_pcr`: read, write, build, discontinuity, scheduler

- **What.** Move `read_pcr`, `build_pcr_packet` (+ `discontinuity`
  argument), export `write_pcr`, add `set_discontinuity_indicator` and
  `PcrScheduler`.
- **Where.** `mrts/ts_pcr.{h,cpp}`; `ts_psi.cpp:57–65, 92–…` and
  `ts_timeline.cpp:629–637` deleted there.
- **How.** As today for the three existing functions (AF-only packet,
  `0xFF` stuffing, CC reuse). `set_discontinuity_indicator` sets AF bit 7
  and returns false without an AF (the caller then builds a PCR-only packet
  with the flag instead). `PcrScheduler::due` = `now − last_pcr ≥
  PCR_MAX_INTERVAL_NS`.
- **Acceptance.** `ts_pcr_test.cpp`: PCR round-trip at 0, at 2^33 × 300 − 1,
  with extension 299; PCR-only packet bytes identical to today's
  (`ts_psi_test.cpp` cases moved); discontinuity flag set/absent; scheduler
  cadence at 40 ms with a sparse PCR PID.
- **Estimate.** 150 + 150 test; 1 day.

#### WI-S0-5 `ts_psi` generalisation

- **What.** `select_program`, `generation`, `unsupported_sections`,
  `for_each_descriptor`, `registration_format`, `has_descriptor`,
  `Pmt::version`/`program_info`, `build_pmt_section`, `packetise_section`.
- **Where.** `mrts/ts_psi.{h,cpp}`.
- **How.** `parse_pmt` already walks the ES loop; add the program_info loop
  and version. `select_program` filters `parse_pat`'s list; `generation`
  increments on every `feed` that returns true. `build_pmt_section` reuses
  `build_pmt`'s body without the one-packet limit; `packetise_section`
  writes pointer_field, fills to 184, continues without PUSI, stuffs the
  tail with 0xFF. Section numbers > 0 are counted, not parsed (same limit as
  today, now visible; R1).
- **Acceptance.** `ts_psi_test.cpp` extended: MPTS with two programs and
  `select_program`; PMT version bump → `generation`; descriptor iteration
  over the Opus (`05 04 4f 70 75 73 7f 02 80 02`), BSSD, KLVA, teletext
  0x56 loops from the existing fixtures; a 300-byte PMT round-trips through
  `build_pmt_section` → `packetise_section` → `first_section` → `parse_pmt`.
- **Estimate.** 250 + 200 test; 2 days.

#### WI-S0-6 Build: PIC archive, one link form, `dump`, bench

- **What.** `libmrts.a` built `-fPIC`; `mrtsstamp/Makefile` and
  `mrpeshouse/Makefile` link the archive instead of compiling
  `ts_timeline.cpp`/`ts_psi.cpp` in; `mr-gst-runner/Makefile` links the
  archive instead of its four `$(MRTS)/*.cpp`; `SplitterCore` switched to
  `PacketWalker`; `mrts_cli dump` (PES index as JSON lines: pid, sid, pts,
  dts, len, crc32, discont, plus PSI events and final counters);
  `mrts/tests/mrts_bench.cpp`.
- **Where.** `mrts/Makefile`, `mrtsstamp/Makefile:4–8, 24, 34–35`,
  `mrpeshouse/Makefile:5–6,20`, `packages/engine/native/mr-gst-runner/
  Makefile:21–33`, `plugins/ts-splitter/native/mr-tssplit/Makefile`,
  `plugins/unixfdbus-core/native/mr-bus-fanout/Makefile` (no change needed
  beyond the archive now being PIC), `mrts/mrts_cli.cpp`, `mrts/ts_split.cpp`.
- **How.** `CXXFLAGS += -fPIC` in `mrts/Makefile` (static executables link a
  PIC archive without cost that matters here); `build-native-dev.sh` keeps
  working: it passes `CXXFLAGS` on the make command line, which overrides
  the `+=`, so its archive is non-PIC there, which is harmless because no
  `.so` is built in Docker. `dump` reads a file
  in `--chunk` steps through `PacketWalker` + `PsiDiscovery` +
  `PesAssembler` and prints one line per unit. `mrts_bench` runs three
  passes over a fixture — walk only; walk + header index + rewrite in place;
  full reassembly with copy — and prints ns per packet and MB/s; `--wrap-at
  <s>` rewrites the fixture's timestamps so a 33-bit wrap lands N seconds in
  (R19 test mode).
- **Acceptance.** `make native` and `make native-test` pass on the dev box
  (aarch64) and in `./build-native-dev.sh arm64 test` for the non-GStreamer
  parts; `nativeSplitParity.test.ts` still byte-identical; `mrts_cli dump`
  on `v1/output.ts` (514 KB, the only in-repo real TS) lists every PES with
  PTS/DTS matching `ffprobe -show_packets` where ffprobe is available.
- **Estimate.** 220 lines; 1 day.

#### WI-S0-7 The plugin `libgstmrtshouse.so`

- **What.** Plugin skeleton: `gstmrtshouse.cpp` (`GST_PLUGIN_DEFINE`,
  `plugin_init` registering a factory table that Phases 1/3/5 extend),
  `mrtshouse_abi.h` (`MRTSHOUSE_ABI = 1`, `MRTSHOUSE_VERSION "1.0.0"`), the
  Makefile (pkg-config `gstreamer-1.0 gstreamer-base-1.0`; Phase 3 adds
  `gstreamer-mpegts-1.0` for section messages), install to
  `$(DESTDIR)$(LIBEXECDIR)/media-router/mpegts-core/libgstmrtshouse.so`.
  Every registered element gets a read-only `abi` integer property and the
  shared counters of part 10 as properties.
- **Where.** `plugins/mpegts-core/native/mrtshouse/{gstmrtshouse.cpp,
  mrtshouse_abi.h, Makefile}`; auto-discovered by root `Makefile:19`.
- **How.** Copy the registration pattern of `mrtsstamp/gstmrtsstamp.cpp`
  (`#define PACKAGE "media-router"`, `GST_DEBUG_CATEGORY`, the filename rule
  `libgst<name>.so` → `gst_plugin_mrtshouse_get_desc`). Until Phase 1's
  element lands the table registers one trivial `mrtshouse-probe` identity
  element so the loaders and protocol tests (WI-S0-8) have something to
  instantiate; Phase 1 replaces it with `mrtsrestamp`. As built (chapter
  15.4 B-17): replaced, and the probe deleted.
- **Acceptance.** `gst-inspect-1.0 plugins/mpegts-core/native/mrtshouse/
  libgstmrtshouse.so` lists the plugin, version and element(s);
  `make native-install DESTDIR=/tmp/x` places the file under
  `/tmp/x/usr/local/libexec/media-router/mpegts-core/`.
- **Estimate.** 150 lines; 1 day.

#### WI-S0-8 Loading in both runners, before `gst_parse`

- **What.** One loader per runner for the timing plugin, called once at
  start-up before any pipeline is parsed; ABI check; on a miss or an old
  ABI a loud warning, and the pipeline built without the timing elements
  where `identity` can stand in, or the module failed where it cannot
  (`mrtsdemux`; part 4.5 rule 6).
- **Where.** Native: new `packages/engine/native/mr-gst-runner/
  native_plugins.{h,cpp}`, generalising `stamper.cpp:47–75` and
  `gates.cpp:549` into a table `{plugin, tool, file, required, min_abi}`;
  called from `runner.cpp` beside `:296` (`rist::load_plugin()`), before
  `gst_parse_launch` at `:299`. Python: new `packages/engine/src/
  child-process/gst_native_plugins.py` (loader only; mirrors
  `gst_stamp_native.py:40–86`), called from `gst-pipeline-runner.py`
  before `Gst.parse_launch` at `:2082`. The existing `mrtsstamp` and
  `mrpeshouse` loaders are left as they are (frozen) and folded into the
  table when their phases delete the fallbacks.
- **How.** Candidates = `paths::asset_candidates("mpegts-core",
  "mrtshouse", "libgstmrtshouse.so")` / the Python equivalent (plugins tree
  first, `/usr/libexec/media-router/mpegts-core/` second, `MR_PLUGINS_DIR`
  and `MR_LIBEXEC_DIR` honoured). On success: one `log` line `native plugin
  mrtshouse <version> abi <n> from <path>`. ABI below `MRTSHOUSE_MIN_ABI`
  (a constant in both runners, bumped with the element protocol):
  `warning` event naming both numbers and the path; the stale plugin is
  not used. Missing file: `warning` event listing the tried paths. In
  both cases the runner records `timing_plugin = none` and, before
  `gst_parse_launch`, rewrites the description: each element whose
  factory is in the loader's table becomes `identity` with the same
  `name=`, its other properties dropped; later `set_property` calls on it
  are answered with a warning (part 4.5 rule 6). The table marks
  `mrtsdemux` as having no stand-in: a description naming it is refused
  with an `error` event carrying the same text, and the module does not
  start. The engine turns the `warning` event into the module alarm of
  rule 6 (`ownWarning('timing-plugin', …)` with the text fixed there) and
  keeps it until a start logs the load line; the `error` event is the
  module's start failure with that text.
- **Acceptance.** `native_runner_protocol_test.py` gains case
  `mrtshouse-load` (plugin present → the log line; `MR_LIBEXEC_DIR` and
  `MR_PLUGINS_DIR` pointed at empty dirs → `warning` with the tried paths,
  then a pipeline naming `mrtshouse-probe` (as built, `mrtsrestamp`;
  chapter 15.4 B-17) parses with `identity` in its place and runs, and a pipeline naming `mrtsdemux` is refused with the
  `error` event; a stub plugin built with `MRTSHOUSE_ABI = 0` → the ABI
  warning and the same substitution and refusal). The same four cases for
  the Python runner in a new `gst_native_plugins_test.py`, added to
  `packages/engine/package.json` `test:py`. Engine side: a
  `GstPluginBase` test that the `warning` raises the rule-6 alarm text
  and that a later start with the load line clears it, and that the
  `error` fails the module with that text.
- **Estimate.** 160 C++ + 80 Python + 120 test; 1.5 days.

#### WI-S0-9 Conformance fixtures and runner

- **What.** The field-capture fixture set of part 7 with expectation files, and
  `mrts/tests/ts_conformance_test.cpp`, which replays every fixture through
  `PacketWalker` + `CcTracker` + `PsiDiscovery` + `PesAssembler` +
  `Unwrapper` at three chunkings (188, 1316, 24 576 bytes) and compares the
  PES index with `<name>.expect.jsonl` line by line.
- **Where.** `plugins/mpegts-core/tests/fixtures/<name>.ts` and
  `<name>.expect.jsonl`; `mrts/tests/ts_conformance_test.cpp`;
  `mrts/tests/fixture_gen.cpp` for the synthetic ones (a port of the
  deterministic generator in `py/native_parity_fixture.py`, LCG and all, so
  the synthetic fixtures need no Python to regenerate).
- **How.** Expectation files are produced once by `mrts_cli dump`, reviewed
  by hand against `ffprobe -show_packets -show_streams` on the same file,
  and committed; a test failure is a diff of the two JSONL files. Chunking
  independence is the property that matters most on the bus (ADR-0011:
  24 KB native ingest chunks, 1316-byte relay chunks, alignment=7 mux
  lists). The captures are committed in the repository and kept off the
  device (OQ-2; WI-S0-13 excludes `tests/` from the image and the
  tarball). They are recorded on the .103 and .108 rigs by the assistant
  session that has rig access, at the start of this fixture work, after a
  check of what already exists on .103; the owner supplies a vMix feed or
  recording only if no rig can subscribe to one (OQ-3).
- **Acceptance.** Every fixture passes at all three chunkings; the synthetic
  set passes on a clean checkout with no Python installed.
- **Estimate.** 300 lines + 120 generator + fixtures; 3 days including the
  capture session.

#### WI-S0-10 hls-pipe reference comparison

- **What.** A vitest that runs `mrts_cli dump` and the hls-pipe demuxer
  (`packages/hls-pipe/src/demux/demuxer.ts`) over the fixtures hls-pipe can
  read (H.264, AAC ADTS, MPEG audio, AC-3, ID3) and compares (pid, pts,
  dts, payload length) per PES, with an allowlist of known differences.
- **Where.** `plugins/mpegts-core/tests/hlsPipeReference.test.ts`
  (follows `nativeSplitParity.test.ts`'s build-and-run pattern via
  `native/build-host.sh`).
- **How.** Reference only: hls-pipe clamps PTS−DTS > 60 s, ignores CC,
  parses single-section PSI and handles one video + one audio PID; each
  such difference is an allowlist entry with the reason. Any other
  difference fails the test, because an unexplained disagreement between
  two independent parsers is a finding either way. It reads WI-S0-9's
  fixtures and hls-pipe's own `packages/hls-pipe/tests/fixtures` from the
  repository; neither ships to the device (WI-S0-13).
- **Acceptance.** Passes on the fixture set; the allowlist carries a reason
  per entry.
- **Estimate.** 120 lines; 0.5 day.

#### WI-S0-11 Performance budget on a Pi 4

- **What.** The numbers the module must meet, and the measurement.
- **Where.** `mrts/tests/mrts_bench.cpp` (WI-S0-6) run on the gate boxes;
  `tools/runner-cpu-profile.sh` (exists; BusyBox-only per-thread profile)
  for the in-pipeline check in Phase 1.
- **How.** Today's measurements, from `mrtsstamp/gstmrtsstamp.cpp`'s header
  and field notes: the Python probe's fixed per-buffer overhead cost a
  routed producer +323 cgroup ticks/min on a Pi 400 while the same
  arithmetic inside `mr-tssplit` cost ~18 (2026-08-12, `:17–19`); a Python
  pad probe at ~1,170 buffers/s at 12 Mbit/s cost 0.5–0.7 of a core per
  producer on a Pi 4, and removing it took a box from 60 % to 26 %
  (2026-09-02, `:196–200`); the bus hop itself cost 25 producer + 45
  consumer ticks/10 s at 1316-byte buffers and 11 + 9 at 24 KB on a Pi 5 at
  8.6 Mbit/s, and on the Pi 4 mpegts-muxer (two hops) the transport was
  ~45 % of 0.54 core (`:36–39`). The native arithmetic is therefore
  already cheap; what this module adds is per-packet work on every ingest
  and every egress (R11). Budget, on a Pi 4 (10.9.16.108), single core,
  `-O2`: walk + header index + in-place rewrite ≤ 1.0 µs/packet; full
  reassembly with copy ≤ 2.0 µs/packet. At 10 Mbit/s (6,650 packets/s)
  that is ≤ 0.7 % and ≤ 1.3 % of one core per stream, and at the 30 Mbit/s
  the tsprobe comment assumes, ≤ 2 % and ≤ 4 %. In-pipeline (Phase 1): the
  restamp element's runner CPU on a given input ≤ today's armed
  `mrtsstamp` + conditioner on the same wiring, measured with
  `runner-cpu-profile.sh` before and after.
- **Acceptance.** `mrts_bench` output on .108 inside the budget for
  every fixture; the figures recorded in the ADR.
- **Estimate.** 100 lines; 0.5 day on the box (Phase 1 verification slot).

#### WI-S0-12 Documentation and ADR entries

- **What.** `plugins/mpegts-core/README.md` contents table (new files, the
  runtime-exit schedule of part 6.2, the reference-and-runtime rule of
  chapter 2); `package.json` description and `test:py` (unchanged: the
  reference suites keep running, OQ-1); the timing ADR's "shared TS
  module" section recording the
  choices in part 4.5, the API, the budget figures and the fixture list;
  `plugins/README.md` "Native & Python code in plugins" gains one paragraph
  on the rule; ADR-0001's consequence bullet is amended by reference.
- **Where.** As named; the ADR number is the next free one (`docs/adr/`
  ends at 0028 today).
- **Acceptance.** The README table lists every file under `native/mrts`
  and `native/mrtshouse`; `grep -n "executable specification"` in
  `plugins/mpegts-core` finds only the amended sentence.
- **Estimate.** 60 lines; 0.5 day.

#### WI-S0-13 Keep `tests/` off the device

- **What.** No `tests/` directory ships. Today the recipe copies the whole
  source tree into `/opt` (`cp -r ${S}/* ${D}/opt/media-router/`, Yocto:
  `meta-layers/meta-custom/recipes-apps/media-router/media-router.bb:180`),
  so `packages/hls-pipe/tests/fixtures` (364 KB) is on every box now, and
  the fixtures of WI-S0-9 (≈ 60 files over all phases, ≤ 2 MB each) would
  follow. The owner's answer to OQ-2 (2026-10-12): fixtures are committed
  in the repository under `tests/fixtures` *and* excluded from the device.
- **Where.** Yocto: `media-router.bb` `do_install`, the copy at `:180`; the
  dist tarball's packing step, wherever it is made (no packing script
  exists in the submodule, chapter 13.1; the project's deploy notes name
  it).
- **How.** Replace the glob copy with one that prunes every `tests/`
  directory at any depth (a `tar --exclude` pipe or `rsync --exclude`),
  keeping the pnpm symlinks the comment at `:179` relies on; the same
  exclude goes into the tarball's packing command. Before the change,
  confirm that nothing at runtime imports from a `tests/` directory
  (`grep -rn "/tests/" packages/*/src plugins/*/engine` should name test
  files only); vitest, `test:py` and the C++ tests run from the
  repository, never from `/opt`.
- **Acceptance.** After an image install and after a dist deploy,
  `find /opt/media-router -path '*/tests/*'` returns nothing; the engine
  starts and every plugin loads; `pnpm -r test` on the repository is
  unchanged.
- **Estimate.** 20 lines; 0.5 day. Ships with Phase 1 (in the Phases 1–4
  release, this module's release), before the first fixture lands.

### 6. Deletions

#### 6.1 With Phase 1 (this module's first release)

| What | Where | Replaced by |
|---|---|---|
| `house_from_mux_pts`, `unwrap_near`, `pts90k_to_ns`, `PTS_WRAP`, `MUX_CLOCK_BASE_90K` definitions | `mrts/ts_timeline.{h,cpp}` (:210–222, :277–281, the anonymous `mod_wrap` :138–143; h :18 and :25) | `ts_house.h` (names unchanged, included) |
| anonymous `fold`, `read_pes_dts`, `write_ts_field`, `write_pcr` | `mrts/ts_timeline.cpp:602–638` | `fold33`, `parse_pes_header`, `write_pes_ts_field`, `ts_pcr::write_pcr` |
| `read_pes_pts`, `read_pcr`, `build_pcr_packet`, `pes_no_header_id` bodies | `mrts/ts_psi.cpp:57–108` | `ts_pes.cpp`, `ts_pcr.cpp` (inline forwarders stay in `ts_psi.h`) |
| `PCR_HZ`, `PCR_MODULO`, `PKT`, `SYNC_BYTE` definitions | `mrts/ts_psi.h:14–15, 28–29` | `ts_house.h`, `ts_packet.h` (re-exported) |
| remainder/resync logic `rem_`, `joined_` | `mrts/ts_split.{h,cpp}` | `PacketWalker` |
| "compiled INTO the .so" source lists | `mrtsstamp/Makefile:4–8, 24, 34–35`; `mrpeshouse/Makefile:5–6, 20`; `mr-gst-runner/Makefile:21–33` | link `libmrts.a` (PIC) |
| The parity-rule sentence "the python is the executable specification" | `docs/adr/0001-…md` (amended by the timing ADR), `plugins/mpegts-core/README.md`, `package.json` description | the reference-and-runtime rule (chapter 2) |
| Nothing under `plugins/mpegts-core/py`, in this or any later phase (OQ-1) | — | the files stay as reference; their runtime users go per part 6.2 |

#### 6.2 Exit of the Python twins from the runtime, and the pieces they pin

Each row goes with the phase named (Phases 2 and 3 are in the Phases 1–4
release), because that phase deletes the last mechanism using it. The Python modules under `py/` are never
deleted (OQ-1, the owner's rule of 2026-10-12): they stay as the reference,
their runtime importers go, and their own tests keep running in `test:py`.

| Phase | What goes | Lines | Why then |
|---|---|---|---|
| 2 | `tests/nativeSplitParity.test.ts` and the `mrts_cli` splitter mode. `py/ts_split.py`, `py/ts_split_test.py`, `py/native_parity_ref.py` and `py/native_parity_fixture.py` stay as reference (OQ-1); they are in no runtime path today (`ts-splitter` has no Python fallback) | 130 deleted; 856 Python kept | The splitter pass-through generalises `ts_split`, so the byte parity the vitest pins ends. The synthetic fixture lives on in `fixture_gen.cpp`. |
| 2 | `TimelineLatch`, `TimelineStamper`, the conditioner, `*_event_json`, `drift_stats_json` in `mrts/ts_timeline.{h,cpp}` and their cases in `mrts/tests/ts_timeline_test.cpp`; `gst_stamp_probe.py`'s stamper path; `unixfd-fanout.py --stamp-timeline`. The same classes in `py/ts_timeline.py` and `py/ts_timeline_test.py` stay as reference (OQ-1); after this phase their only runtime importers are `branch_retime.py` and the align block, which Phase 3 deletes | ~1,300 C++ + ~1,500 test; the ~2,400 Python lines stay | §11.4 rows 1–2 (anchored stamping and the wire conditioner) are deleted in Phase 2. |
| 3 | The last runtime importers of `py/ts_timeline.py` (`branch_retime.py`, the align block; the file and its test stay as reference, OQ-1); the `ts_psi.h` forwarders; `mrpeshouse/` entirely (`gstmrpeshouse.cpp` 215, `pes_walk` 167, `stamp_model` 119, `Makefile` 57, `tests/stamp_model_test.cpp` 89, `stamp_model_vectors.txt` 3,667) with `plugins/subtitle-core/py/subtitle_native.py`, `subtitle_stamp_model.py`, `subtitle_ts.py`'s `PesStamper`, `subtitle_peshouse_gst_test.py`, `subtitle_stamp_dump.py` (`mpegts-core/tests/tsFixtures.ts` stays: `plugins/ts-splitter/tests/mrTssplit.test.ts` and `plugins/unixfdbus-core/tests/unixfdFanout.test.ts` import it) | 4,314 mrpeshouse; subtitle-core per chapters 6 and 7; the ~255 Python helper lines stay | Branch align/retime and subtitle K recovery go in Phase 3 (§11.4 rows 3–4), and they are the last importers. |
| — | `py/ts_psi.py`, `py/ts_psi_test.py`, `py/ts_video_info.py`, `py/sps_parse.py`, `py/ts_video_info_test.py` | 1,185 kept | Not timing; the Python runner's `tsProbe` (`gst-pipeline-runner.py:3565`) still imports them, and `ts_video_info.py:13` imports `ts_psi`, so `ts_psi.py` cannot go while they stay. Kept (OQ-1, answered 2026-10-12). |

`plugins/mpegts-core/package.json` `test:py` keeps every reference suite;
nothing under `py/` goes (OQ-1).

### 7. Tests and fixtures

#### 7.1 C++ unit tests (no GStreamer, run anywhere)

`plugins/mpegts-core/native/mrts/tests/`, built and run by `make -C mrts
test`, `native/build-host.sh test` and root `make native-test`; natively on
the dev box (aarch64) and in `./build-native-dev.sh arm64 test`.

| Test | Pins |
|---|---|
| `ts_house_test.cpp` | Formula and inverse, wrap both ways, `Unwrapper` across a wrap with DTS < PTS, network round-trips, `net_pcr27`. |
| `ts_packet_test.cpp` | Chunking independence, resync and desync count, CC results. |
| `ts_pes_test.cpp` | Every header shape, span across packets, bounded/unbounded, CC loss, oversize, rewrite round-trip with every other byte unchanged. |
| `ts_pcr_test.cpp` | PCR round-trips at the limits, PCR-only packet bytes, discontinuity flag, scheduler cadence. |
| `ts_psi_test.cpp` (extended) | MPTS program selection, generation, descriptor walk, multi-packet PMT round-trip. |
| `ts_conformance_test.cpp` | Every fixture of part 7.2 at three chunkings against its `.expect.jsonl`. |
| `ts_timeline_test.cpp`, `ts_split_test.cpp` (existing) | Unchanged cases prove the moves are behaviour-preserving (until their Phase 2/3 deletion). |
| `mrts_bench` | Not a test; prints ns/packet (WI-S0-11). |

#### 7.2 Conformance fixtures

`plugins/mpegts-core/tests/fixtures/<name>.ts` with `<name>.expect.jsonl`.
Field captures are trimmed to ≤ 2 MB (OQ-2), about 1.5 s at
10 Mbit/s, which is enough for every property below except the wrap, which
is synthetic. Each fixture names what it pins; the phase column says which
element's section reuses it beyond this module.

| Fixture | Source | Pins | Reused by |
|---|---|---|---|
| `syn-mpts-two-programs.ts` | `fixture_gen.cpp` (port of `native_parity_fixture.py`: sparse PSI, PCR jitter, Opus, KLV, CC gaps, desync garbage, AVC→HEVC switch) | PSI discovery, program selection, CC, resync, PMT change → generation | 2, 3 |
| `syn-wrap-33bit.ts` | `fixture_gen.cpp --wrap-at 5` | Unwrap across 2^33 on PTS, DTS and PCR, B-frame DTS behind PTS at the wrap (§6, R19) | 1, 3, 5 |
| `syn-pes-header-split.ts` | `fixture_gen.cpp` | Header spilling into the next packet; `PesHeaderSpan` holds one packet, other PIDs unheld | 1, 5 |
| `syn-pes-no-pts.ts` | `fixture_gen.cpp` | PES without PTS, no-header stream ids (0xBE padding, 0xBF private_2) | 3 |
| `cap-mux-align7-aac-opus.ts` | our `mpegtsmux alignment=7` egress (audio-encoder or audio-transcoder on .108) | PSI between held-back PES, several PES headers per 1316-byte chunk (§6 "several PIDs in one buffer"), bounded audio PES | 1, 2, 3 |
| `cap-mux-unbounded-video.ts` | our transcoder rendition on .108 (H.264 1080p) | Unbounded video PES (> 64 KB, length 0) closed at the next PUSI, DTS present | 3, 5 |
| `cap-occ-1080i-h264-aac-ttx.ts` | the OCC feed (the July 2026 multicast capture the .103 rig replays) | 1080i B-frames (DTS ≠ PTS), AAC ADTS (the feed carries no MPEG-1 audio; the draft named it mp2), teletext 0x56 sparse PID, program PCR cadence | 1, 3 |
| `cap-vmix-h264-aac.ts` | the owner's vMix, SRT listener, looping a recording, pulled by .103 on 2026-10-21 (libavformat's VBR mux; the drafted `cap-vmix-cbr-h264-aac` named #820's CBR mode, which is still to be recorded; chapter 15.4 B-85) | PCR only in each IDR's first packet, one GOP (2 s) apart, PTS = PCR there; PAT+PMT before each IDR and every 40 packets; AAC ADTS; H.264 without DTS | 1 (STC degraded fallback) |
| `cap-302m-bssd.ts` | audio-input-302m on .108 | 302M `BSSD` registration, one PES per buffer, PTS = DTS | 2, 3 |
| `cap-klv-sparse.ts` | a subtitle route on .103 (KLVA PES, stream_id 0xBD) | Sparse private stream, PTS = cue start + 1 h, gaps between cues | 3 |
| `cap-srt-ingest-1316.ts` | srt-input on .108 from a third-party encoder | 1316-byte datagrams with PES headers and PSI anywhere, ≤ 1 PCR per chunk | 1 |
| `cap-cc-loss.ts` | `cap-mux-align7-aac-opus.ts` with packets removed by `fixture_gen.cpp --drop` | CC loss mid-PES: drop the partial, flag the next | 3 |
| `syn-source-restart.ts` | `fixture_gen.cpp --restart <at_s>`: `discontinuity_indicator` on the PCR PID, a multi-hour PTS/DTS jump, B-frame DTS behind PTS | A source restart (PCR discontinuity) through `Unwrapper` (reseed via `reset()`) and `PesAssembler` (open units flushed): the module-level face of "gaps (§5.2)" in §6's fixture list | 1, 3 |

Expectation lines: `{"pid","sid","pts","dts","len","crc32","discont","seq"}`
per PES unit, `{"psi":"pmt","gen","pcrPid","streams":[...]}` per PMT change,
and a final `{"counters":{...}}`.

#### 7.3 Reference comparison

`plugins/mpegts-core/tests/hlsPipeReference.test.ts` (WI-S0-10): the
hls-pipe TypeScript demuxer as a second opinion over the fixtures it can
read, with an allowlist of its known limits. Reference only: it never
replaces the `.expect.jsonl` files.

#### 7.4 Protocol tests in both runners

`packages/engine/src/child-process/native_runner_protocol_test.py` (native
runner, black-box over stdin/stderr JSON) and the new
`gst_native_plugins_test.py` (Python runner): the `mrtshouse-load` cases of
WI-S0-8 (present, missing, ABI too old). Element data-flow cases belong to
Phases 1, 3 and 5 and follow the `gst_mrtsstamp_element_test.py` pattern
(a Python harness driving the element over appsrc/appsink is test tooling,
not a twin).

#### 7.5 No Python twin at runtime

No test in this section runs a Python implementation of any function in
part 4.2 as the thing under test. The Python reference suites (`test:py`)
keep running, untouched (OQ-1); the splitter parity vitest runs until Phase 2
(part 6.2).

### 8. Manager and UI

None. `mpegts-core` is a library plugin with no `mediaRouter` manifest. The
only operator-visible effect is the module alarm of part 4.5 rule 6 when a
runner cannot load `libgstmrtshouse.so` or finds its ABI too old (WI-S0-8):
a module with a pass-through stand-in runs on source time and its card
carries the warning until the deploy is fixed and it is restarted; a module
whose pipeline names `mrtsdemux` fails to start with the same text. No
settings are added,
removed or disabled by this section; the users' settings are in sections
01, 02, 03 and 05.

### 9. Image and Yocto

- No new recipe, service or config. The plugin is discovered by the root
  `Makefile` and built and installed by the existing
  `media-router.bb:156–157, 166` steps into
  `/usr/libexec/media-router/mpegts-core/libgstmrtshouse.so` (Yocto:
  `meta-layers/meta-custom/recipes-apps/media-router/media-router.bb`).
- Build dependencies are already in `DEPENDS` (`gstreamer1.0`,
  `gstreamer1.0-plugins-base`, `gstreamer1.0-plugins-bad` for
  `gstreamer-mpegts-1.0` in Phase 3).
- The recipe comment at `:143–150` naming the GStreamer elements
  (`mrtsstamp, mrrist`) gains `mrtshouse` and loses the "no Python fallback"
  remark's special-casing, since no native element has one after Phase 3.
- x86 machines (`genericx86-64`, `intel-corei7-64`) get the plugin through
  the same recipe; nothing architecture-specific is in the module.
- Hot deploy to a test box, for Phase 1 verification: build on the dev box
  (aarch64, GStreamer 1.28.2) and `mrscp` the `.so` to
  `/opt/media-router/plugins/mpegts-core/native/mrtshouse/`, which the
  resolver checks first; ship it together with the engine dist that expects
  its ABI (rule 4 in part 4.5 catches a mismatch). The release path is the
  image.
- `tests/` directories are excluded from the recipe's copy into
  `/opt/media-router` and from the dist tarball (WI-S0-13), so the fixtures
  of part 7.2 never reach a box.

### 10. Telemetry and alarms

- Runner log line at start: `native plugin mrtshouse <version> abi <n>
  from <path>` (both runners); `warning` event on a miss or an old ABI
  (WI-S0-8) → the module alarm of part 4.5 rule 6 ("Native TS module not
  loaded …"), level warning, kept until a start loads the plugin; for a
  module whose pipeline names `mrtsdemux` the same text is its start
  failure (`error` event).
- Element properties, read-only, polled into each user element's periodic
  stats line the way `mrtsstamp`'s `drift` is today (`stamper.cpp:434`):
  `desync-bytes`, `cc-lost`, `pes-oversize`, `pes-dropped-cc`,
  `header-spans`, `psi-unsupported-sections`, `pes-no-pts`, `dts-discarded`
  (the 5 s sanity of `Unwrapper::feed_dts`). Each user section says which
  of these it raises an alarm on; the module itself raises none.
- `mrts_bench` figures recorded in the ADR (WI-S0-11); no runtime
  telemetry for the budget beyond the runner CPU the engine already reports.

### 11. Verification on the test fleet

All of this runs in Phase 1's verification window; nothing touches the
boxes before then.

| Check | Where | Tool or command class | Pass criterion |
|---|---|---|---|
| Plugin present and loaded by both runners | 10.9.16.103 (Pi 5), 10.9.16.108 (Pi 4) | `ls -l /usr/libexec/media-router/mpegts-core/libgstmrtshouse.so`; `gst-inspect-1.0 <path>`; runner stderr for the load line with `MR_GST_RUNNER_NATIVE=1` and `=0` | Both runners log `native plugin mrtshouse <ver> abi 1`; the Python runner shows no fallback line |
| Bench inside budget | .108 | `mrts_bench` over every fixture of part 7.2 (binaries built on the dev box, copied with `mrscp`) | ≤ 1.0 µs/packet walk+index+rewrite; ≤ 2.0 µs/packet reassembly |
| C++ suites on target | .103 | `make -C mrts test` binaries copied and run | All pass (same results as the dev box) |
| Fixture captures taken | .103 (OCC, KLV), .108 (mux, 302M, SRT) | `mrssh` + a bus tap or `udpsink`/`filesink` tee of ≤ 2 MB per capture, by the assistant session with rig access after checking what is already on .103 (OQ-3) | Every `cap-*` fixture of part 7.2 exists and its `.expect.jsonl` is reviewed |
| Field-capture replay | dev box | `ts_conformance_test` | Every fixture passes at 188/1316/24 576-byte chunking |
| ABI guard | .108 | Deploy a dist built with `MRTSHOUSE_MIN_ABI = 2` against the ABI-1 plugin | The module alarm names `abi 1 < 2`; the pipeline runs with `identity` in the timing elements' place; the alarm clears after the matching plugin is deployed and the module restarted |
| No regression in today's timing | .103, .108 | The existing gate checks of the current model (A/V skew tool, `runner-cpu-profile.sh`) before and after installing the Phase 1 development image with the module but with the element not yet wired | Identical within noise: the moves of part 6.1 change nothing the frozen model does |

### 12. Risks specific to this phase

| Risk | Design doc | Mitigation here |
|---|---|---|
| A stream shape the parser does not handle is a silent loss on that route | R1 | The part 7.2 fixture set from real captures at three chunkings; `psi-unsupported-sections`, `pes-no-pts`, `dts-discarded` counters so a gap is visible, not silent; the demux's unknown-type alarm (Phase 3) sits on `registration_format`. |
| Scope: the module is on the critical path of four phases | R3 | Planned first, built first, API frozen at the end of WI-S0-5; later phases add elements, not core functions. |
| 32 MB PES cap × PIDs on a Pi with many consumers | R9 | `keep_payload=false` for the rewriters (no copy at all); the cap is per open unit and counted; Phase 3 sizes it per stream type. |
| Per-packet CPU on every ingest and egress | R11 | The µs/packet budget of WI-S0-11, measured on the Pi 4 before Phase 1 ships; `PacketWalker` is zero-copy on aligned chunks. |
| A rewrite that emits a backward PTS | R18 | The rewrite primitives are value-neutral; the monotonic guard is Phase 1's, with `syn-wrap-33bit.ts` and the overlap fixtures. |
| Wrap bugs in our own unwrap | R19 | `Unwrapper` is seeded and continuous, DTS tied to PTS; the wrap fixture and `mrts_bench --wrap-at`. |
| Mixed-version fleet and dist-vs-native skew (the 2026-08-05 incident, part 3.4) | R20 | ABI check at load (rule 4); the release ships image + dist together. |
| Moving code out of frozen files changes behaviour by accident | Q2 (§13.1) | Pure moves only; `ts_timeline_test.cpp` (1,664 lines) and the Python parity suites stay green; the field check of part 11 last row. |
| A PES header spanning two packets is mishandled by a rewriter | — | `PesHeaderSpan` with its fixture; the span counter shows how often it happens in the field. |
| `-fPIC` archive breaks a sidecar or the Docker static build | — | `build-native-dev.sh arm64 test` and `make native` on the dev box in WI-S0-6's acceptance; the runtime cost of PIC on aarch64 is negligible. |
| A `.so` built on the dev box (Debian 12, glibc 2.36) against the image's glibc | — | Hot deploy is for verification only; releases come from the image build. The existing `mrtsstamp` hot deploys have worked on the same pair. |
| Capture material unavailable (vMix, OCC) when needed | — | OQ-3: the owner supplies a vMix feed or recording if no rig can subscribe to one; the synthetic fixtures cover every property except the real sources' quirks, which Phase 1's STC fallback needs. |

### 13. Open questions

| # | Question | Why the design doc does not answer it | Blocks | Proposed default |
|---|---|---|---|---|
| OQ-1 | Do `py/ts_psi.py`, `py/ts_video_info.py` and `py/sps_parse.py` stay for the Python runner's `tsProbe` (`gst-pipeline-runner.py:3565`), or does the probe move to a small native element in `libgstmrtshouse.so` so the whole `py/` directory can go in Phase 3? | §11.5 says the module has no Python twin and the twins fold in, but `tsProbe` is not timing code and the design never mentions it. | The Phase 3 row of part 6.2 (whether `ts_psi.py` is deleted) and the final shape of `test:py`. | **Keep** the three files; they are not timing code and the no-twin rule covers new code. Revisit when the Python runner itself is retired. |
| OQ-2 | Are the field-capture fixtures committed in the repo (trimmed to ≤ 2 MB each, ~12 files) or kept in an out-of-repo store the tests fetch? | §6 asks for fixtures from field captures but not where they live; the repo holds one real TS today (`v1/output.ts`, 514 KB). | WI-S0-9, WI-S0-10, and every later phase's conformance runs. | **In-repo**, trimmed to ≤ 2 MB, under `plugins/mpegts-core/tests/fixtures/`. |
| OQ-3 | Who records the field captures and when: the engineer on the .103/.108 rigs at the start of Phase 1, or the design owner supplies vMix (#820) and GATE01/OCC captures from the field? | The design names the sources (#816, #820, #825, #836 captures in R4) but not their custody. | WI-S0-9's `cap-*` rows and Phase 1's STC tuning (R4). | **Engineer records** on .103/.108 at Phase 1 start; the owner supplies a vMix capture only if the rig cannot reproduce #820. |

All three were answered by the owner on 2026-10-12 (chapter 15.1): OQ-1
keep, with the wider rule of chapter 2 (prototype in Python, port to C++,
the Python stays as reference and is never loaded); OQ-2 in the
repository and off the device (WI-S0-13); OQ-3 the assistant session with
rig access records on .103/.108 at the start of each phase's fixture work,
after checking what exists on .103, the owner supplying a vMix feed or
recording only if no rig can subscribe to one. The text above follows the
answers; no item waits. The draft's question of what a runner does when it
cannot load the plugin was closed during assembly as "fail the module";
the owner decided the opposite on 2026-10-12 — start but warn — and part
4.5 rule 6 now says so (chapter 15, C-1). The gap that left for a consumer
demux, which has no pass-through stand-in, was decided the same day by the
orchestrator (owner delegated): such a module fails with the same alarm
text, and start-but-warn applies only where a stand-in exists.

### 14. Estimate

| | Lines |
|---|---|
| Added, production (`ts_house` 150, `ts_packet` 180, `ts_pes` 350, `ts_pcr` 150, `ts_psi` +250, build/cli/bench 220, plugin 150, loaders 240, docs 60, packaging 20) | ≈ 1,770 |
| Added, tests (unit 1,050, conformance runner + generator 420, hls-pipe reference 120, protocol cases 120) | ≈ 1,710 |
| Added, fixtures | 12 binary files ≤ 2 MB each + 12 `.expect.jsonl` |
| Deleted with Phase 1 (moved bodies, Makefile duplication, doc sentences) | ≈ 150 |
| Scheduled for deletion in Phases 2–3 from this module's inventory (part 6.2: `mrpeshouse` 4,314 incl. vectors, stamper C++ ≈ 2,800 incl. tests, parity vitest 130; the ≈ 4,710 Python lines under `py/` stay as reference, OQ-1) | ≈ 7,250 |

Engineer-days: 18 (WI-S0-1 1, -2 1, -3 3, -4 1, -5 2, -6 1, -7 1, -8 1.5,
-9 3, -10 0.5, -11 0.5, -12 0.5, -13 0.5, review and rework 1.5).

Critical path: capture session (OQ-3) → WI-S0-3 `ts_pes` → WI-S0-9
conformance → WI-S0-7 plugin → WI-S0-8 loaders → Phase 1's `mrtsrestamp`
element (chapter 5). WI-S0-1, -2, -4, -5 can run in parallel with the
capture session; -6, -10, -11, -12, -13 trail.

## 4. Phase 0 — Time sync, epoch E and lateness on every module

Paths starting `packages/`, `plugins/` or `docs/` are relative to the app
submodule
(`meta-layers/meta-custom/recipes-apps/media-router/files/media-router`).
Paths starting `build/` or `meta-layers/` are relative to the Yocto root
(`/home/mrstation/media-router-yocto`). Every cited path was checked with `ls`
or `grep` against the tree on 2026-10-12 (submodule HEAD `fc17468`).
"§n" refers to `docs/house-clock-timing-design.md` v0.6.

### 1. Goal

Phase 0 builds the measuring instrument for everything after it (§14, row 0).
It covers four things:

- chrony becomes the image's only NTP daemon, replacing htpdate and
  systemd-timesyncd. Whichever daemon owns the clock sets the kernel TAI
  offset: chrony from the leap-second list; under PTP the setup seeds it
  from the same list and a slave then takes a traceable grandmaster's
  announced value (§10.2). A box that may become PTP grandmaster is kept on
  NTP time by chrony while it is the grandmaster (WI-P0-2b, added
  2026-10-14).
- The engine latches one epoch `E = CLOCK_TAI − CLOCK_MONOTONIC`. It waits
  up to 30 s for sync, then warns and starts untraceable. It watches for
  clock steps and re-latches E by itself (§10.3).
- The engine reports its time-sync state.
- Every module shows its output lateness and added latency in ms (§9.5).

Nothing in the stream timing changes. Bus PTS, stamps, conditioners and
presentation delay stay frozen (§13.1, Q2). The only consumer of E in this
phase is `aes67-output`, which today measures the offset itself.

### 2. Design references

| Ref | What Phase 0 implements |
|---|---|
| §4.1 | The house clock is `CLOCK_MONOTONIC` with `base_time = 0` in every process. Lateness is meaningful only under that rule (see OQ-4). |
| §4.2, §4.6 (E, H) | `E = TAI − MONOTONIC`, latched once, re-latched only after a step. |
| §4.3 | Bus GstBuffer PTS is house time, "used only for lateness". This is what the bus-edge taps read. |
| §4.5 | E is applied only at the network boundary, so it is kept in one place and never in pipeline clocks. |
| §9.5 | Output lateness, added latency per input, the slowest input, the decode and device latency of outputs, PipeWire-graph modules showing PipeWire's latency. Its "alarms at thresholds the operator sets" is deferred by the owner's decision on OQ-8 (2026-10-12); the design document should record that deferral (a doc follow-up, not a work item; the deferred option is in the note after part 13). |
| §10.1 | The fleet baseline being replaced: htpdate `-t -s` oneshot, systemd-timesyncd, kernel TAI offset 0 everywhere, no sync visibility in the engine. |
| §10.2 | chrony stepping above 1 s at any time (`makestep 1.0 -1`, 2026-10-14), a bounded slew rate, the kernel TAI offset from `leapsectz`/`leapseclist`, PTP writing the TAI−UTC constant, a grandmaster disciplined by chrony and announcing traceable time only while synchronised (WI-P0-2b), the engine reading the daemon's state. |
| §10.3 | 30 s start wait, warning, untraceable start, `TFD_TIMER_CANCEL_ON_SET` step detection, divergence check, automatic re-epoch with an event. |
| §11.4 last row | `aes67_clock.py` (TAI − MONOTONIC) is generalised to the engine-wide E. |
| §11.5 items 5, 6 | Engine clock state; lateness on every module. |
| §11.6 last row | The stale claim that `aes67-output` re-measures after a step stops being stale: the engine's E does. |
| §13.1 | The decisions on chrony (was Q3), the 30 s wait and automatic re-epoch (was Q15), every phase a cut-over, the frozen current model (Q2), and no Python twin for new native code. |
| R2, R6, R7, R9, R14 | The risks this phase mitigates or touches (§12.2). |

### 3. Current state

#### 3.1 Time daemons in the image

| Item | Where | Today |
|---|---|---|
| htpdate | `build/conf/local.conf:171-172` (`IMAGE_INSTALL:append = " htpdate"`); comment at 179-180 | Installed on every machine. |
| htpdate unit | `meta-layers/meta-custom/recipes-support/htpdate/htpdate_%.bbappend` (15 lines), `.../files/htpdate.service` (26 lines) | `Type=oneshot`, `htpdate -t -s` against google, cloudflare and microsoft, `TimeoutStartSec=30`. `Wants=`/`Before=time-sync.target`. |
| systemd-timesyncd | systemd's default `PACKAGECONFIG` (no removal anywhere in `meta-layers/meta-custom` or `build/conf/local.conf`) | Enabled and runs SNTP (§10.1). `meta-layers/meta-custom/recipes-core/base-files/base-files_%.bbappend:11-12` creates `/var/lib/private` "required by systemd-timesyncd and other services". |
| chrony | `meta-layers/meta-openembedded/meta-networking/recipes-support/chrony/chrony_4.8.bb` | Available, not installed. Stock `chrony.conf`: `pool 0.openembedded.pool.ntp.org iburst`, `makestep 1.0 3`, `driftfile /var/lib/chrony/drift`, `rtcsync`. The recipe installs `chronyd.service` only, with no wait unit, and packages `chronyc` separately. |
| tzdata | `openembedded-core/meta/recipes-extended/timezone/tzdata.bb` | `leap-seconds.list` and `leapseconds` ship in `tzdata-core` (lines 141-145). `right/` zones ship in `tzdata-right`. Whether `tzdata-core` is in today's image could not be checked: no image manifest exists locally. |
| `time-sync.target` consumers | `meta-layers/meta-custom/recipes-apps/media-router-audio-app/files/systemd/media-router-audio-proxy.service:9-14` | `After=time-sync.target`, so the TLS certificate fetch waits for the first clock step. Today htpdate orders itself before the target; on hardware-timestamping PTP boxes, phc2sys does. |
| Engine unit | `meta-layers/meta-custom/recipes-apps/media-router/media-router.bb:201-235` | A *user* unit (`media-router.service`, mrstation). It cannot order on the system `time-sync.target`, so the engine has to wait for sync itself. |
| Root filesystem | read-only (`/dev/root / ext4 ro`, project memory); `/data` is writable (`meta-layers/meta-custom/recipes-core/base-files/files/fstab`) | chrony's drift file cannot live in `/var/lib/chrony`. |
| Firewall | `meta-layers/meta-custom/recipes-apps/device-manager/files/nftables-fallback.conf:18-21` | Drop policy on the input chain only. `ct state established,related accept` and `iif "lo" accept`. Outbound NTP and its replies are unaffected; `chronyc` on 127.0.0.1:323 is allowed. |

#### 3.2 PTP

`meta-layers/meta-custom/recipes-support/media-router-ptp/` (recipe 80 lines,
files 930 lines):

- `files/media-router-ptp-setup.sh` (350 lines), the ExecStartPre of ptp4l.
  - Lines 305-348 "displace the other time sources". The block stops
    `htpdate.service` and `systemd-timesyncd.service` when active
    (`systemctl stop --no-block`) and records what it stopped in
    `/data/ptp/displaced-time-services`.
  - Lines 244, 259 and 283 refer to htpdate in comments and a log line.
  - Nothing writes the kernel TAI offset.
- `files/media-router-ptp4l.service` (54 lines). Line 33 has
  `After=htpdate.service systemd-timesyncd.service`, and lines 16-31 hold a
  comment about why `Conflicts=` was rejected. The unit is gated on
  `ConditionPathExists=/data/ptp/ptp.env`.
- `files/media-router-phc2sys.service` (35 lines). `Before=time-sync.target`;
  it runs only in hardware-timestamping mode.
- `files/aes67.conf`, `files/smpte-2059-2.conf` (presets with
  `max_frequency 100000` and `step_threshold 1.0` at `aes67.conf:123`,
  `smpte-2059-2.conf:65`), `mr-ptp-tsinfo.py`, `mr-ptp-tickcheck.py` and
  the tick-check units. None of these changes in Phase 0 apart from the
  tick check's alarm rule (WI-P0-2b, 2026-10-14); the two presets' step
  threshold changes in Phase 5 (chapter 9 WI-P5-19, deferred on
  2026-10-12).

#### 3.3 Device Manager (Yocto layer, `meta-layers/meta-custom/recipes-apps/device-manager/files/`)

| File | Lines | Today |
|---|---|---|
| `api/src/config/PtpConfig.ts` | 413 | Lines 40-96: `FALLBACK_TIME_SERVICES = ["htpdate", "systemd-timesyncd"]`, `DISPLACED_RECORD_NAME`, `DEFAULT_FALLBACK_TIME_SERVICE = "htpdate"`, `readDisplacedTimeServices()`. Lines 315-365: `disablePtp()` stops the units, deletes `ptp.env`, then starts what the record lists (or htpdate) and deletes the record. |
| `api/src/config/PtpConfig.spec.ts` | 584 | Lines 397-483: `describe("disabling PTP restores exactly the time source it displaced")`, 8 tests. |
| `api/src/config/PtpStatus.ts` | 321 | `getPtpStatus()`: `pmc` port state and grandmaster, ptp4l journal offset and rms, `/run/media-router-ptp/status.env`. |
| `api/src/config/PtpExec.ts` | 79 | `run()` (execFile) and `parseEnvFile()`. |
| `api/src/socket/index.ts` | 343 | Lines 226-234: `requestPtpStatus` → `ptpStatus`. |
| `app/src/pages/PtpConfigPage.vue` | 407 | "PTP Clock Sync" page with Status and Settings. |
| `app/src/socketClient.ts` | 380 | `PtpStatus` type, `ptpStatus` ref, `requestPtpStatus()`. |
| `app/src/pages/BasePage.vue` | — | Line 69: menu item `{ name: 'PTP', icon: ClockIcon, route: '/ptp' }`. |
| `app/src/router/index.ts` | — | Lines 45-47: the `/ptp` route. |

Nothing in the Device Manager shows NTP state.

#### 3.4 Engine: the TAI offset today

- `plugins/aes67-core/py/aes67_clock.py` (123 lines) reads `CLOCK_TAI`,
  `CLOCK_MONOTONIC` and `CLOCK_REALTIME` once. It counts the box as
  "disciplined" when TAI − REALTIME ≥ 10 s and returns
  `rtpTimestampOffset = (TAI−MONO)·48000/1e9 mod 2^32`. Its test,
  `aes67_clock_test.py`, is 97 lines.
- `plugins/aes67-output/engine/Aes67OutputModule.ts:94-127`. `measureEpoch()`
  runs that script once per module start, and only with `ptpSync` and
  `services.timeSyncContract`. Its pipeline string pins
  `timestamp-offset=` on the payloader (lines 257-261). It has no step
  detection, which is the stale claim in §11.6.
- `plugins/aes67-output/engine/Aes67OutputModule.test.ts:183-197` runs the
  script for real.
- Node has no access to `CLOCK_TAI`, `adjtimex(2)` or `timerfd`. Nothing in
  the engine reads sync state.

#### 3.5 Engine: the legacy clock arm (see OQ-4)

- `packages/engine/src/Engine.ts:44-56,150-151`.
  `timeSyncContract = config ?? MR_TIME_SYNC_CONTRACT !== '0'` is the kill
  switch.
- `packages/engine/src/child-process/ClockAuthority.ts` (93 lines, test 19)
  and `packages/engine/src/child-process/gst-net-clock.py` (99 lines) are the
  shared net clock for the legacy `clockSync` arm.
- `packages/engine/src/plugins/GstPluginBase.ts:143-250` holds
  `applyTimeSync()`; its legacy branch is from line 247.
- `packages/engine/src/plugins/PluginModule.ts:56-67,307-330,724`:
  `clockAuthority`, `clockSync`, `clock` and `ClockConfig`.
- `packages/engine/src/child-process/gst-pipeline-runner.py:1876-1944`
  (`_apply_net_clock`, its comment from 1868) and lines 2097-2100
  (contract or net-clock branch).
- `packages/engine/native/mr-gst-runner/runner.cpp:59` (`"clock"`
  ineligibility) and `packages/engine/src/child-process/nativeRunner.ts:111`.
- `plugins/audio-decoder/engine/AudioDecoderModule.ts:303-417` reads the
  `clockSync` setting; `plugins/audio-decoder/package.json:110` declares it.
- `plugins/README.md:2045-2052` documents `--stamp-timeline` gated on the
  flag.

With the switch off, pipelines run on per-start base times, so `now − PTS`
does not measure house lateness.

#### 3.6 Engine: how module state reaches the UI

- **Modules.** `GstPluginBase.setStatusData()` (line 583),
  `setDynamicSections()` (line 637), `setBadge()` (line 617) and
  `ownWarning()` (private, line 430) emit `stateChange`.
- **Fan-out.** `ModuleManager` forwards `stateChange` to
  `packages/engine/src/EngineEventWiring.ts:58-65`. `ManagerStateSync` sends
  batched patches to the manager and to the router tree (ADR-0024/0025,
  `packages/engine/src/tree/RouterView.ts`). `LcpServer` broadcasts to the
  local panel.
- **Manager UI.** `ModuleNode.vue` renders the module face and badges,
  `ModuleNodeStatsModal.vue` the status sections, and
  `packages/manager-ui/src/dashboard/entries.ts:62-65` exposes status data
  to dashboards.
- **Engine-level state.** `packages/engine/src/system/SystemStatsCollector.ts`
  (297 lines) builds `SystemStats`, with `ENGINE_FEATURES` at line 43.
  `Engine.ts:320-326` sends it to the tree (`/system`) and to the manager
  (`'system'`). It ends at `packages/manager-ui/src/stores/engines.ts:154`,
  `components/common/EngineListItem.vue:53` and `AppHeader.vue:64`, which is
  where `undervoltage` is shown today.
- **Runner → module data.** Both runners forward ELEMENT messages
  subscribed through `PipelineDescription.busReports` as
  `<structure>:<element>` plugin events:
  - `gst-pipeline-runner.py:506-528`;
  - `native/mr-gst-runner/runner.cpp:517-531`;
  - received in `GstPluginBase.dispatchPluginEvent()` (line 739).

#### 3.7 Where lateness can be measured today

| Point | Element / code | Both runners? | Notes |
|---|---|---|---|
| Bus ingress | `unixfdsrc` from `buildBusSrc()` (`packages/engine/src/plugins/busHelpers.ts:183-196`); dynamic inputs via `bus_input_add` (`gst-pipeline-runner.py:3224`, `native/mr-gst-runner/bus_inputs.cpp:133`) parse a description string | Yes. The string is shared. | Buffer PTS is the producer's bus stamp, i.e. house time (§4.3). |
| Bus egress | native `mrtsstamp` spliced before the `busout_*` tee in both runners (`plugins/mpegts-core/native/mrtsstamp/gstmrtsstamp.cpp`, 862 lines; `stamper.cpp`, `gst_bus_stamper.py`) | Yes | After the splice, buffer PTS is the stamp. In `liveCaptureClock` pipelines (video-encoder), running time is not house time, so the comparison must be against raw `CLOCK_MONOTONIC`. |
| Output sink | sinks with `sync=true`, `ts-offset` = D (e.g. `AudioDecoderModule.ts:349`, `audio302mTiming.ts:49`) | Yes | After branch alignment, running time = stamp. The sink renders at `rt + ts-offset + latency`. |
| Sidecar producers | `plugins/unixfdbus-core/native/mr-bus-fanout/main.cpp` (153 lines, stats every 2 s at line 133); `plugins/ts-splitter/native/mr-tssplit/app.cpp:257` (`emit_stats`) | n/a (no runner) | Both already stamp natively and emit JSON stats lines. |
| Throughput (pattern only) | `track_throughput`/`get_throughput` (`commands.cpp:177-245`, `gst-pipeline-runner.py:2402-2475`) | Yes | A per-buffer *python* probe cost 0.5-0.7 core per producer on a Pi 4 (`gstmrtsstamp.cpp` header), so lateness must be native. |
| Render keep-up | `render_lag.py`, `plugins/video-player/engine/helpers/renderLag.ts` | — | A frame-rate monitor, not lateness. Kept (§11.4). |

### 4. Target state

#### 4.1 Image

- chrony is the only NTP daemon. htpdate is not installed, and
  systemd-timesyncd is not built.
- chronyd runs on every box *without* `/data/ptp/ptp.env`, and on a
  master-capable PTP box while it holds the grant token (WI-P0-2b). Its
  drop-in conditions keep it off everywhere else, so chrony and linuxptp
  never steer one clock together.
- The chrony configuration:
  - takes its servers from the Device Manager's list on `/data` (default
    the public pool) and from the DHCP lease (OQ-6);
  - steps whenever the offset exceeds 1 s and slews below that
    (`makestep 1.0 -1`);
  - bounds the slew rate (`maxslewrate 100`, OQ-5);
  - sets the kernel TAI offset from `leapseclist`;
  - keeps its drift file and its server list on `/data`.
- A small wait unit orders chrony's first sync before `time-sync.target`,
  bounded at 30 s; on timeout it logs one warning and succeeds.
- The PTP setup script:
  - stops chronyd on a slave-only box (no record, nothing else to stop); on
    a master-capable box it starts chronyd, waits up to 30 s for its sync
    and steps once before ptp4l serves (WI-P0-2b);
  - writes the kernel TAI offset (TAI−UTC from the image's
    `leap-seconds.list`, falling back to 37) before ptp4l starts.
- A master-capable box is disciplined by chrony while its port is neither
  UNCALIBRATED nor SLAVE, and announces traceable NTP time only while
  chrony is synchronised (WI-P0-2b).
- The displaced-services record and its restore logic are gone from the
  script and the Device Manager.

#### 4.2 Where E lives and how modules read it

**E lives in the engine process (Node), as one latched value.** A small
native sidecar, `mr-clockstate`, measures it. The sidecar is spawned and
supervised by the engine's `ProcessManager`, like `mr-tssplit` and
`mr-bus-fanout`.

The engine holds E because §4.5 needs every network egress to apply an
*identical* E. If each runner process latched its own E, a step between two
module starts would split one engine across two epochs. One latch in one
process cannot split. The pipelines never see E, because the scheduling
clock is unchanged (§4.1).

The measurement is native because Node cannot read `CLOCK_TAI`, call
`adjtimex(2)` or arm a `timerfd`. A Node native addon would tie the build to
the image's Node ABI; a supervised sidecar is the pattern the engine already
uses. The sidecar reports and the engine decides, so a sidecar restart never
re-epochs on its own.

**How modules read it:**

- TypeScript modules read `services.houseClock` (new on `EngineServices`):
  - `epoch()` returns the current `HouseEpoch`;
  - `ready()` is a promise that resolves after the start wait;
  - `on('epoch', fn)` fires on a re-latch;
  - `on('state', fn)` fires on any sync-state change.
- `aes67-output` is the only reader in Phase 0.
- From Phase 5, the egress writer element gets E and the epoch sequence
  through the existing `set_property` RPC, which both runners implement.
  `GstPluginBase` re-pushes them on `epoch` events. No runner command is
  added now.

`HouseEpoch` (in `packages/shared-types`):

```ts
interface HouseEpoch {
  eNs: bigint;            // TAI − MONOTONIC in ns, ~1.8e18: beyond 2^53, so bigint
  seq: number;            // 1 at first latch, +1 per re-latch
  latchedAtMonoNs: bigint;
  traceable: boolean;     // synced and TAI offset set when latched (or since)
  reason: 'start' | 'timeout' | 'sync' | 'step' | 'divergence';
  source: 'chrony' | 'ptp' | 'none';
  taiOffsetS: number;     // kernel's TAI−UTC (adjtimex .tai)
}
```

#### 4.3 Engine time-sync state

`Engine.start()` starts `HouseClock` first. The module run controller
(`ModuleRunController.start()`) awaits `houseClock.ready()`, which resolves
in either of two ways:

- once the kernel reports sync and a set TAI offset (OQ-7);
- 30 s after engine start, with a logged warning, latching E anyway as
  untraceable.

The manager link, the local API, the LCP and the router tree come up at once,
so the UI shows "waiting for time sync (n s)".

After that:

- A `timerfd` cancel, a TAI-offset change or |measured E − latched E| above
  1 ms re-latches E with an event (`seq+1`).
- Sync arriving after an untraceable start re-latches if E moved, or only
  flips `traceable` if it did not.

`SystemStats` gains `timeSync`, carried to `/system/timeSync` in the router
tree and to the manager's engine card.

#### 4.4 Lateness on every module

- **The tap element.** A native pass-through element, `mrlateness`, built in
  `plugins/mpegts-core/native/mrlateness`, is placed at three kinds of point:
  - every bus ingress, through the `buildBusSrc()` string, so static and
    dynamic inputs in both runners are covered with no runner logic;
  - every bus egress, after the `mrtsstamp` splice, through the
    `buildBusSink()` string;
  - immediately before the final sink of every output module.
- **What it reports.** It posts an `mrlateness` element message per window
  (min, mean, max, count, untimed). Both runners forward it as a plugin
  event without a subscription, so dynamically added inputs report too.
- **Sidecar producers.** `mr-tssplit` and `mr-bus-fanout` report the same
  window in their stats lines. The accumulator is one C++ class,
  `mrts::LatenessWindow`, used by all three; there is no Python twin.
- **Reporting.** `GstPluginBase` turns the windows into:
  - a `timing` status section: output lateness; per input, its lateness and
    the added latency; the slowest input; for outputs, decode latency,
    presentation delay and device latency;
  - a lateness badge on the module face;
  - no alarm in Phase 0 (OQ-8): every value is shown with a label; the
    alarm is deferred (note after part 13).
- **PipeWire-graph modules** show the latency PipeWire reports for their
  node.
- **UI.** Nothing new is needed for modules. Status sections, badges,
  dashboards and the LCP already render `statusData` (ADR-0007, "plugins
  compute, UI renders").

#### 4.5 Device Manager

- The PTP page becomes a "Time" page (OQ-9).
  - A **Clock** card on top shows:
    - which daemon owns the clock;
    - synchronised or not;
    - estimated and maximum error;
    - the kernel TAI−UTC offset, in red when 0;
    - frequency;
    - chrony's reference, stratum and sources table;
    - an NTP **Servers** list, default the public pool, with the servers
      the DHCP lease offered shown read-only beneath it (OQ-6).
  - The existing PTP status and settings sit below; the status gains a
    Time source row (WI-P0-2b).
- Enabling PTP stops chronyd on a slave-only box; a master-capable box
  keeps it while it is the grandmaster (WI-P0-2b). Disabling starts
  chronyd.
- No record file, no whitelist and no htpdate fallback remain.

### 5. Work items

Ordered by dependency. Line counts include tests. Engineer-days (d) assume
one engineer who knows the codebase.

#### WI-P0-1 — chrony replaces htpdate and systemd-timesyncd in the image

- **What.** Install and configure chrony, remove htpdate and timesyncd, and
  provide the `time-sync.target` wait.
- **Where.**
  - `build/conf/local.conf`: replace lines 171-172 and the comment at
    179-180.
  - Delete `meta-layers/meta-custom/recipes-support/htpdate/`.
  - New `meta-layers/meta-custom/recipes-support/chrony/chrony_%.bbappend`
    with `files/media-router-chrony.conf`, `files/10-media-router.conf`
    (chronyd drop-in), `files/media-router-chrony-wait.service`,
    `files/default.sources` (the public pool) and
    `files/20-media-router-chrony-dhcp` (NetworkManager dispatcher), with
    the test harness `files/media-router-chrony_test.py` beside them (not
    in `SRC_URI`).
  - `meta-layers/meta-custom/conf/distro/media-router-distro.conf`:
    `VIRTUAL-RUNTIME_base-utils-syslog = ""` (added 2026-10-14: BusyBox
    syslogd took `/dev/log` from journald, so chronyd's and phc2sys's
    syslog lines never reached the journal; ADR-0029).
  - Comment fixes in
    `meta-layers/meta-custom/recipes-core/base-files/base-files_%.bbappend:12`
    and `.../media-router-audio-proxy.service:9-13`.
- **How.**
  - `local.conf`: `IMAGE_INSTALL:append = " chrony chronyc tzdata-core"`
    and `PACKAGECONFIG:remove:pn-systemd = "timesyncd"`.
  - The bbappend installs `media-router-chrony.conf` as `/etc/chrony.conf`
    (`CONFFILES` unchanged). It carries no server line: the servers come
    from two `sourcedir` fragments (OQ-6, answered 2026-10-12):

    ```
    sourcedir /data/chrony/sources.d           # the Time page's list (WI-P0-12)
    sourcedir /run/chrony-dhcp                 # servers the DHCP lease offered
    makestep 1.0 -1                            # step whenever > 1 s off, at any time
    maxslewrate 100                            # ppm (R7; OQ-5: 100)
    leapseclist /usr/share/zoneinfo/leap-seconds.list   # sets kernel TAI offset
    leapsecmode system                         # kernel inserts; TAI does not step
    driftfile /data/chrony/drift
    rtcsync                                    # also clears STA_UNSYNC (Linux)
    bindcmdaddress 127.0.0.1
    bindcmdaddress ::1
    cmdallow 127.0.0.1
    ```

  - `/data/chrony/sources.d/media-router.sources` is generated by the
    Device Manager from the Time page's server list (WI-P0-12): one `pool
    <name> iburst maxsources 4` line per host name, `server <addr> iburst`
    per address, then `chronyc reload sources`. The bbappend installs the
    default as `/usr/share/media-router/chrony/default.sources` (`pool
    pool.ntp.org iburst maxsources 4`), and the drop-in copies it into
    `sources.d/` when that directory is empty, so a box with no setting
    yet uses the public pool. The recipe's own `chrony.conf` already uses
    `sourcedir` (meta-networking `chrony/chrony.conf:25`), so the
    directive is in the 4.8 build.
  - DHCP-provided servers: the NetworkManager dispatcher script
    `20-media-router-chrony-dhcp` (installed to
    `/etc/NetworkManager/dispatcher.d/`) writes
    `/run/chrony-dhcp/<iface>.sources` from `DHCP4_NTP_SERVERS` on `up`
    and `dhcp4-change`, removes it on `down`, and runs `chronyc reload
    sources`; it also runs `chronyc onoffline` on `up`, `down`,
    `connectivity-change`, `dhcp4-change` and `dhcp6-change`, before its
    interface check (NetworkManager passes no interface for
    `connectivity-change`), so a name that failed to resolve before the
    uplink came up is retried at once rather than after chrony's backoff
    (review F1; upstream `examples/chrony.nm-dispatcher.onoffline`).
    NetworkManager is the box's only network manager
    (`recipes-core/systemd/systemd_%.bbappend:45`), and its dispatcher
    passes DHCP options as `DHCP4_<OPTION>` (`NetworkManager-dispatcher(8)`);
    the name `DHCP4_NTP_SERVERS` was verified on the fleet on 2026-10-14
    (V14 on .50, .108 and .211).
  - The drop-in
    `/etc/systemd/system/chronyd.service.d/10-media-router.conf`:
    - `ConditionPathExists=|!/data/ptp/ptp.env` and
      `ConditionPathExists=|/run/media-router-ptp/chrony.grant`, two
      triggering conditions: no PTP, or the grant token of a master-capable
      PTP box (WI-P0-2b);
    - `RequiresMountsFor=/data`;
    - `ExecStartPre=/bin/mkdir -p /data/chrony/sources.d /run/chrony-dhcp`;
    - `ExecStartPre=/bin/sh -c '[ -n "$(ls -A /data/chrony/sources.d)" ] ||
      cp /usr/share/media-router/chrony/default.sources
      /data/chrony/sources.d/media-router.sources'`.

    Conditions, not `Conflicts=`. The PTP unit's comment records why
    `Conflicts=` killed the clock on PTP-off boxes
    (`media-router-ptp4l.service:16-31`).
  - `media-router-chrony-wait.service`:
    - `Type=oneshot`, `RemainAfterExit=yes`;
    - `After=chronyd.service`, `Wants=time-sync.target`,
      `Before=time-sync.target`;
    - `ConditionPathExists=!/data/ptp/ptp.env`;
    - `ExecStart=/bin/sh -c '/usr/bin/chronyc -h 127.0.0.1 waitsync 30 0 0 1 >/dev/null 2>&1 || echo "<4>no NTP sync after 30 s - continuing unsynchronised; the clock will step when NTP is reachable"'`:
      it never fails, so an offline boot is not degraded (the owner,
      2026-10-14);
    - `TimeoutStartSec=90`, `SYSTEMD_AUTO_ENABLE = "enable"`.

    It is our own unit: the stock recipe installs no wait unit, and the
    4.8 tarball was not available locally to confirm its example.
- **Acceptance.**
  - `media-router-chrony_test.py` passes: 19 cases on the dispatcher, the
    wait unit and two `chrony.conf` guards (`makestep 1.0 -1`, `rtcsync`),
    each under dash, BusyBox sh and bash `--posix`.
  - `bitbake core-image-weston` succeeds.
  - On the image:
    - `systemctl list-unit-files | grep -E 'htpdate|timesyncd'` is empty;
    - `systemctl is-active chronyd` reports `active`;
    - `chronyc tracking` shows `Leap status: Normal` and a reference;
    - `mr-clockstate --once` (WI-P0-3) reports `taiOffsetS: 37` within
      5 min of boot;
    - `ls -l /dev/log` points at journald's socket and a `logger` line
      appears in `journalctl`.
  - `/data/chrony/drift` exists after 1 h.
  - `media-router-audio-proxy` starts after the wait unit
    (`systemd-analyze critical-chain`).
  - On a cold online boot the wait unit succeeds (`systemctl status
    media-router-chrony-wait`).
  - With the uplink unplugged, boot completes; after ~30 s the wait unit
    logs `no NTP sync after 30 s - continuing unsynchronised; the clock
    will step when NTP is reachable` at warning priority and succeeds, so
    the system is not degraded on its account; when the uplink returns,
    chrony syncs within ~10 s and steps the clock if it is more than 1 s
    off.
  - On a fresh `/data`, `chronyc sources` lists the public pool from the
    default fragment; on a box whose DHCP lease offers NTP servers, they
    appear in `chronyc sources` within 10 s of the interface coming up.
- **Estimate.** +150 / −45 lines, 2 d (one image build cycle included).

#### WI-P0-2 — PTP setup: chrony is the only displaced daemon; write the TAI offset

- **What.** Remove the displacement record. Stop chronyd when PTP takes the
  clock on a slave-only box (a master-capable box keeps it while it is the
  grandmaster: WI-P0-2b). Set the kernel TAI offset.
- **Where.** In `meta-layers/meta-custom/recipes-support/media-router-ptp/`:
  `files/media-router-ptp-setup.sh`, `files/media-router-ptp4l.service`,
  new `files/mr-ptp-settai.py`, `media-router-ptp.bb` (SRC_URI, install,
  FILES).
- **How.**
  1. Delete lines 305-348 of the setup script, the loop and
     `DISPLACED_RECORD`. Replace them with:

     ```sh
     if systemctl is-active --quiet chronyd.service; then
         log "stopping chronyd — PTP is taking over the clock"
         systemctl stop --no-block chronyd.service || true
     fi
     ```

     Nothing is recorded: chronyd's own condition keeps it off at boot,
     and the Device Manager starts it on disable. Since 2026-10-14 this is
     the slave-only branch; a master-capable box writes the grant token and
     starts chronyd instead (WI-P0-2b).
  2. Before the stop, call
     `/usr/libexec/media-router-ptp/mr-ptp-settai.py`. The script (Python
     3, ctypes `adjtimex` with `ADJ_TAI`, about 50 lines) does three things:
     - reads `PTP_TAI_UTC_OFFSET` from `ptp.env` if present (hand-edited,
       not in the UI; OQ-10, answered: no UI); since 2026-10-14 only on a
       slave-only box, while a master-capable box runs it with
       `--no-override` (WI-P0-2b);
     - otherwise takes the last data line of
       `/usr/share/zoneinfo/leap-seconds.list` (`<ntp-seconds> <offset>`),
       falling back to 37;
     - writes the value, re-reads `adjtimex().tai`, logs both, and always
       exits 0 (same policy as `mr-ptp-tickcheck.py`).

     This is not TS code, so the no-Python-twin rule does not apply.
     `python3-core` is already an RDEPENDS.
  3. Change "htpdate" to "chrony" in the comments at lines 244 and 259 and
     the log at line 283.
  4. In `media-router-ptp4l.service`, change line 33 to
     `After=chronyd.service` and rewrite the comment at lines 16-31 for
     one daemon.
  5. Added 2026-10-14: the runtime `[global]` block emits
     `summary_interval 4` (both presets) and phc2sys runs with `-u 16`, one
     servo summary per 16 s instead of per second or per update. On .108
     ptp4l's 1 s summary was 600 of 1,570 journal lines per 10 min, in a
     volatile 32 MB journal that lost boot logs within ~2 h; the Time page
     reads only the newest summary.

  The ptp4l presets are not touched in Phase 0. §10.2's "a step on first
  lock only" (`step_threshold 0.0` with `first_step_threshold 1.0` in
  `files/aes67.conf:123` and `files/smpte-2059-2.conf:65`) is deferred to
  Phase 5, chapter 9 WI-P5-19 (decided 2026-10-12 by the orchestrator,
  owner delegated); until then a step under PTP is caught by WI-P0-3/4's
  step detection and re-epoch like any other step. phc2sys's `-S 1.0`
  (WI-P0-2b) matches the presets' `step_threshold 1.0`, so WI-P5-19 has to
  move it with them.
- **Acceptance.**
  - On a gate box: write `ptp.env` and `systemctl restart
    media-router-ptp4l`. Then:
    - on a slave-only box (`PTP_SLAVE_ONLY=1`) `systemctl is-active
      chronyd` reports `inactive`; on a master-capable box it stays active
      while the box is grandmaster (WI-P0-2b);
    - the journal shows `TAI offset set to 37 (was 0)`;
    - `mr-clockstate --once` reports `taiOffsetS: 37` and is still 37
      after 1 h of ptp4l lock (ptp4l/phc2sys must not reset it; R-P0-3).
  - Reboot with `ptp.env` present on a slave-only box: chronyd is skipped
    ("unmet condition": no grant token, and `ptp.env` exists) and ptp4l
    runs.
  - ptp4l and, on hardware-timestamping boxes, phc2sys log one summary per
    16 s.
  - `/data/ptp/displaced-time-services` is never created.
  - `shellcheck` is clean.
- **Estimate.** +75 / −70 lines, 0.75 d.

#### WI-P0-2b — Grandmaster on chrony: port-state handover

Added on 2026-10-14 after the fleet test found the grandmaster
undisciplined (10.9.16.46: kernel `TIME_ERROR`, 0 ppm, 0.2–0.3 s off UTC
after 9.7 days; design §10.1). The decision, its reasons and the rejected
designs are in ADR-0029, "PTP: a grandmaster on chrony".

- **What.** On a master-capable box (`PTP_SLAVE_ONLY=0`) chronyd owns
  `CLOCK_REALTIME` whenever the ptp4l port is neither UNCALIBRATED nor
  SLAVE, and the box announces traceable NTP time only while chrony is
  synchronised; linuxptp steers it while a better grandmaster wins.
  Slave-only boxes keep WI-P0-2's path, and `ptp.env` gains no key.
- **Where.**
  - `meta-layers/meta-custom/recipes-support/media-router-ptp/`: new
    `files/mr-ptp-owner.py` (the watcher) and
    `files/media-router-ptp-owner.service`; new test harnesses
    `files/mr-ptp-owner_test.py` and `files/mr-ptp-tickcheck_test.py`, not
    installed, like `mr-ptp-settai_test.py`; `files/media-router-ptp-setup.sh`
    (+ `media-router-ptp-setup_test.py`), `files/media-router-ptp4l.service`,
    `files/media-router-phc2sys.service` (comment), `files/mr-ptp-settai.py`
    (+ test), `files/mr-ptp-tickcheck.py` and `media-router-ptp.bb`.
  - `meta-layers/meta-custom/recipes-support/chrony/files/10-media-router.conf`;
    `media-router-chrony-wait.service` (comment only).
  - Device Manager (`recipes-apps/device-manager/files/`):
    `api/src/config/PtpConfig.ts` (chronyd stopped only on a slave-only
    save; ptp4l restart with a 60 s timeout), `PtpStatus.ts` (`pmc -d` from
    `status.env`; `GET TIME_PROPERTIES_DATA_SET` → `timeProperties`),
    `TimeStatus.ts` (`timeOwner`: chronyd active wins; `synced` = the
    engine's `isSynced`, constant mirrored), `TimeConfig.ts` (comment); app
    `socketClient.ts` (mirrors), `pages/PtpConfigPage.vue` (Time source row;
    the intro says chrony keeps a grandmaster's time) and
    `components/TimeStatusCard.vue` (owner "chrony (NTP), served over PTP"
    while ptp4l runs; servers hint "Used when PTP is off, or while this
    device is the PTP grandmaster."; badge from `synced`). Tests:
    `PtpConfig.spec.ts`, `PtpStatus.spec.ts`, `TimeStatus.spec.ts`,
    `TimeStatusCard.spec.ts`, new `PtpConfigPage.spec.ts`,
    `socketClient.spec.ts`.
  - Engine: `packages/engine/src/clock/clockSource.ts` and `HouseClock.ts`
    (+ tests; WI-P0-4), `packages/shared-types/src/timeSync.ts` (the
    `TimeSyncSource` doc comment).
- **How.**
  - Who writes `CLOCK_REALTIME`, per port state, from the linuxptp 4.4 and
    chrony 4.8 sources. This is what lets chronyd own the clock in every
    state but two:

    | Port state | Software timestamping: ptp4l steers REALTIME | Hardware timestamping: ptp4l steers the PHC, phc2sys REALTIME | chronyd |
    |---|---|---|---|
    | UNCALIBRATED | ptp4l starts to steer: `clock_synchronize` runs only in UNCALIBRATED and SLAVE (`port.c` `process_sync`, `process_follow_up`). Its first write is the servo's second sample (`pi.c` `pi_sample`); each sample needs a filtered delay (`tsproc_update_offset`), and the first DELAY_REQ leaves at random within (0, 2 s] for AES67, (0, 0.25 s] for ST 2059-2 (`port.c` `port_set_delay_tmo`), so the earliest write is ≥ ~130 ms after the state change. | No REALTIME write: `phc2sys.c` `reconfigure_domain` returns −1 ("source clock not ready"), the rt domain keeps REALTIME as its own source and `update_domain_clocks` skips it. ptp4l steers only the PHC. | Revoked at once: the pushed PORT_DATA_SET (`port.c:3797` `port_notify_event`), the token removed, `systemctl stop --no-block chronyd.service`; chronyd exits within tens of ms. |
    | SLAVE | ptp4l steers REALTIME. | phc2sys steers REALTIME from the PHC within its ≤ 1 s loop (`servo_add` calls `sysclk_set_leap(0)`; the first update after a phc2sys start steps above 20 µs). | Stopped. |
    | MASTER, LISTENING, PRE_MASTER, PASSIVE, FAULTY, DISABLED, INITIALIZING | ptp4l only timestamps. Its one kernel write is `sysclk_set_leap(0)` at its own start (`clock.c:1327`): a no-op while chrony is synced; with `maxerror` at the 16 s cap it clears `STA_UNSYNC` for under 1 s (`kernel/time/ntp.c` `second_overflow` sets it again). | REALTIME is phc2sys's source and the PHC its sink, by reversed sysoff (`reconfigure_domain`; `update_needed` excludes UNCALIBRATED and SLAVE PHCs). | Owns REALTIME: adopted if it runs, else granted after the hold. |

    linuxptp clears `STA_UNSYNC` (`sysclk_set_sync`) only on lock
    (`update_clock`, `clock_synchronize_locked`), and sets the kernel TAI
    offset (`sysclk_set_tai_offset`) only on a REALTIME sink that follows a
    traceable grandmaster, with that grandmaster kernel's own value
    (`clock.c` `clock_utc_correct:933`, `phc2sys.c` `clock_handle_leap:1073`).
    chrony cannot release the clock at runtime (`-x` is a start-up option;
    `chronyc offline` only stops polling), so yielding is stopping chronyd
    and taking is starting it. Its exit writes its base frequency once
    (`sys_generic.c` `SYS_Generic_Finalise`) and never zeroes TAI
    (`sys_timex.c` `set_leap` sets `MOD_TAI` only for a non-zero offset;
    `REF_Finalise` calls `update_leap_status(LEAP_Unsynchronised, 0, 0)`).
  - The watcher, `mr-ptp-owner.py` (Python 3, root; it never exits on an
    error, it logs and retries at the next 0.5 s tick):
    - reads `/run/media-router-ptp/status.env` (`PTP_SLAVE_ONLY`,
      `PTP_DOMAIN`, `PTP_TIMESTAMPING`, `PTP_PHC`);
    - runs one interactive `pmc -u -b 0 -d $PTP_DOMAIN`.
      `SET SUBSCRIBE_EVENTS_NP duration 180 NOTIFY_PORT_STATE on` is re-sent
      every 5 s until ptp4l confirms it, then every 60 s; `GET PORT_DATA_SET`
      (and, on a master-capable box, `GET GRANDMASTER_SETTINGS_NP`) every
      5 s. One command is in flight at a time, because pmc reads stdin with
      `fgets`;
    - decides on each pushed PORT_DATA_SET and at every tick:

      | Box and port state | Decision |
      |---|---|
      | slave-only, any state | revoke if chronyd is active or the token exists, else keep |
      | master-capable, UNCALIBRATED or SLAVE | revoke if chronyd is active or the token exists, else keep |
      | master-capable, no PORT_DATA_SET for 12 s, or none yet | keep, with one warning: ptp4l is single-threaded, so one that answers nothing steers nothing |
      | master-capable, INITIALIZING, FAULTY, DISABLED, LISTENING, PRE_MASTER, MASTER or PASSIVE | adopt if chronyd is active; grant once the port has been in such a state for the hold; else keep |

    - acts: revoke unlinks the token, then runs
      `systemctl stop --no-block chronyd.service`; grant writes the token,
      then runs `systemctl start --no-block chronyd.service`; adopt only
      writes a missing token and never starts chronyd. Every subprocess
      call has a 10 s timeout, and every `systemctl` call is `--no-block`,
      so no job deadlocks;
    - polls `systemctl is-active chronyd.service media-router-phc2sys.service`
      every 2 s, and every 0.5 s for 5 s after a grant or revoke: one call
      costs ~4 ms of CPU on a Pi 5, so a poll at every tick would take
      ~0.8 % of a core on every PTP box. A revoke never waits for the poll;
      it fires on the push and the token;
    - logs every grant, revoke and adopt, every change of the announced
      flags, and `chronyd exited N ms after the revoke`, read from systemd's
      `ExecMainExitTimestampMonotonic` (the watcher's own `CLOCK_MONOTONIC`);
    - writes `/run/media-router-ptp/owner.env` atomically on change:
      `PTP_PORT_STATE`, `CHRONY_GRANTED`, `GM_TIME_TRACEABLE`,
      `GM_TIME_SOURCE`, `OWNER_UPDATED`;
    - on a slave-only box sends no `GET GRANDMASTER_SETTINGS_NP`, runs no
      `phc_ctl` and sends no SET.
  - Hold and backoff: the hold is max(2 s, (announceReceiptTimeout + 1) ·
    2^logAnnounceInterval), from PORT_DATA_SET: 8 s for AES67 (1 and 3),
    2 s for ST 2059-2 (−2 and 3). It is multiplied by 2^k, where k counts
    the grants of the last 10 min that ended within 60 s, revoked or not
    held by chronyd (a new grant follows within 60 s), capped at 4: an
    AES67 box retries at 8, 16, 32, 64 and 128 s. Adopting a running
    chronyd is not a grant.
  - Traceability, recomputed at each tick on a master-capable box:
    traceable = the token exists ∧ chronyd is active ∧ `STA_UNSYNC` is
    clear ∧ `maxerror` < `MAX_SYNCED_ERROR_US` (1 s, mirroring
    `houseClockPolicy.ts`; a test checks they match) ∧ 10 ≤ `tai` ≤ 999 ∧
    (software timestamping ∨ (phc2sys is active ∧ |`phc_ctl -q <phc> cmp` +
    `tai` · 10⁹| ≤ 1 ms, read every 10 s; `phc_ctl` prints REALTIME − PHC,
    ≈ −37 s)). `timeTraceable`, `frequencyTraceable` and
    `currentUtcOffsetValid` follow it; `timeSource` is 0x50 (NTP) or 0xa0
    (internal oscillator); `currentUtcOffset` is the kernel's `tai` when
    traceable, else as ptp4l has it; clockClass, clockAccuracy,
    offsetScaledLogVariance and ptpTimescale are echoed from the GET.
    `render_set` gives the 11 values in `pmc_common.c`'s sscanf order:
    `SET GRANDMASTER_SETTINGS_NP clockClass 248 clockAccuracy 0xfe offsetScaledLogVariance 0xffff currentUtcOffset 37 leap61 0 leap59 0 currentUtcOffsetValid 1 ptpTimescale 1 timeTraceable 1 frequencyTraceable 1 timeSource 0x50`,
    sent only when it differs from the last GET and never while the port
    is UNCALIBRATED or SLAVE. One Announce right after a regain can still
    carry the flags from before the revoke (ptp4l's first Announce leaves
    ~1 ms after the regain); the next tick corrects them.
  - Leap gate: leap61 = `STA_INS` set ∧ the UTC time of day ≥ 12:00 ∧
    `adjtimex` returns neither `TIME_OOP` nor `TIME_WAIT`; leap59 likewise
    with `STA_DEL`. chrony raises `STA_INS` from 00:00 UTC of the leap day
    (`reference.c` `update_leap_status`), and `util.c`
    `leap_second_status` takes a flag first seen before 06:00 as past.
    After midnight the grandmaster's own `clock_update_leap_status` clears
    LEAP_61 and sets `utc_offset` 38; the watcher then reads `tai` 38 with
    the flag gated off, so its settings equal ptp4l's and no SET goes: no
    double increment.
  - The setup script's role block, after settai:
    - slave-only: `rm -f $RUN_DIR/chrony.grant`, and if chronyd is active
      `systemctl stop --no-block chronyd.service`, as before;
    - master-capable: `: > $RUN_DIR/chrony.grant`. If chronyd is active it
      logs `chronyd already running — mr-ptp-owner adopts it`. Otherwise it
      runs `systemctl start --no-block chronyd.service` and
      `chronyc waitsync 30 0 0 1`; on success it logs `chrony synchronised`,
      runs `chronyc makestep` (root, Unix command socket) and logs `stepped
      the boot offset before ptp4l serves`, or `WARNING: chronyc makestep
      failed — the boot offset is slewed out instead`; on timeout it logs
      `WARNING: no NTP sync after 30 s — ptp4l starts anyway; the
      grandmaster announces not traceable until chrony syncs`. It exits 0
      either way;
    - `PHC2SYS_ARGS=-a -r -r -n $PTP_DOMAIN -S 1.0 --max_frequency=100000 -u 16`
      (each flag's reason is in ADR-0029);
    - settai gets `--no-override` unless `PTP_SLAVE_ONLY=1`;
    - the paths can be overridden from the environment (`MR_PTP_ENV`,
      `MR_PTP_PRESET_DIR`, `MR_PTP_RUN_DIR`, `MR_PTP_TSINFO`,
      `MR_PTP_SETTAI`) for the test harness; systemd sets none.
  - Units and recipe: `media-router-ptp-owner.service` is
    `BindsTo=`/`After=media-router-ptp4l.service`,
    `ConditionPathExists=/data/ptp/ptp.env`, `Restart=always`,
    `RestartSec=1`, `ExecStopPost=-/bin/rm -f` the token and `owner.env`,
    `WantedBy=media-router-ptp4l.service`, and has no `RuntimeDirectory=`
    (that would delete ptp4l's `/run/media-router-ptp` with it).
    `media-router-ptp4l.service` gets `TimeoutStartSec=120`; its chronyd
    comment states the role rule, and `After=chronyd.service` stays.
    chronyd's drop-in carries the two triggering conditions (WI-P0-1).
    `media-router-ptp.bb` ships the watcher and its unit (in
    `SYSTEMD_SERVICE`, auto-enabled; the unit starts only with ptp4l) and
    adds `python3-json chronyc` to `RDEPENDS`.
  - The tick check: `reasons_for(state)` alarms only when |tick + freq|
    exceeds 100 ppm; the tick is reported in the summary.
  - Device Manager: a slave-only save stops chronyd before the ptp4l
    restart, a master-capable save never names chronyd, and the restart
    has a 60 s timeout; the PTP card's pmc carries `-d` and reads
    `TIME_PROPERTIES_DATA_SET` (WI-P0-12).
  - Engine: chronyd active wins the owner poll, which also re-runs on a
    `step` line (WI-P0-4).
- **Acceptance.**
  - Unit tests (done 2026-10-14):
    - `mr-ptp-owner_test.py`, 46 cases: pmc parsing on real pmc 4.4 output
      (a field capture from 10.9.1.42, and captures from linuxptp 4.4 built
      from the release tarball and run in user and network namespaces on
      the development Pi 5: LISTENING, MASTER, UNCALIBRATED and FAULTY
      pushes, GRANDMASTER_SETTINGS_NP, TIME_PROPERTIES_DATA_SET,
      SUBSCRIBE_EVENTS_NP, MANAGEMENT_ERROR_STATUS, a SET reply, ST 2059-2
      on domain 127); the decide table, hold and backoff; the `gm_settings`
      truth table, including noon, after midnight, the inserted second and
      `STA_DEL`; `render_set` against `pmc_common.c`'s sscanf; the handover
      sequencing with a fake `systemctl` and `phc_ctl` (the token goes
      before the stop and before the start; adopt never starts chronyd);
      the pmc coprocess against a stand-in that logs each read(2), one line
      per read; the owner unit, and chronyd's drop-in conditions under the
      real `systemd-analyze condition`;
    - `media-router-ptp-setup_test.py`, 10 cases, each under dash, BusyBox
      sh and bash `--posix`: the 16 s summary for both presets and modes,
      the phc2sys arguments, no phc2sys in software mode, slave-only with
      chronyd on and off, master-capable with chronyd stopped (start, wait,
      step) and running (no wait), the no-NTP warning, a refused
      `makestep`, and the `status.env` the watcher reads;
    - `mr-ptp-settai_test.py`, 21 cases; `mr-ptp-tickcheck_test.py`, 9;
    - all pass under Python 3.11 and the image's 3.14.4, and 38 of 38
      mutations fail a test;
    - end to end on the namespace rig, the real watcher against a real
      ptp4l and pmc: it adopted at boot and announced traceable flags; with
      a better master, chronyd's stop ran with the token already gone,
      19 ms after ptp4l's MASTER to UNCALIBRATED; on regain the flags were
      corrected at once and the grant came 8.1 s later, token first; domain
      127 behaved the same;
    - Device Manager vitest: `PtpConfig.spec.ts` (42), `PtpStatus.spec.ts`
      (36), `TimeStatus.spec.ts` (23), `TimeStatusCard.spec.ts` (12), new
      `PtpConfigPage.spec.ts` (3) and `socketClient.spec.ts`; each of 26
      mutations fails a spec. The two TIME_PROPERTIES_DATA_SET fixtures in
      `PtpStatus.spec.ts` are printed from pmc 4.4's format string
      (`pmc.c:317-336`) and linuxptp's defaults, not captured; T0/T1 below
      replaces them with `pmc -u -b 0 -d 10 'GET TIME_PROPERTIES_DATA_SET'`
      captures from a slave and from the grandmaster;
    - engine vitest: WI-P0-4's `clockSource.test.ts` and `HouseClock.test.ts`
      cases; 8 of 8 mutants fail.
  - On a rig isolated on PTP domain 10, so .46 and domain 0 are untouched:
    hardware grandmaster .103 (Pi 5 with hardware timestamping; 10.9.1.76
    if the Pi 5 DELAY_REQ fault appears), software grandmaster .108 (Pi 4),
    slaves .22 and .111 (`PTP_SLAVE_ONLY=1`), all on the new image. None of
    this has run yet: the namespace rig had no hardware timestamping, no
    real chronyd and no real systemd.

    | # | Test | Pass |
    |---|---|---|
    | — | Pre-flight, read-only on every PTP box: `mrssh <ip> 'cat /data/ptp/ptp.env; cat /run/media-router-ptp/status.env'` | Only .46 is master-capable today (the slaves have `PTP_SLAVE_ONLY=1`). Any other master-capable box would start chronyd at boot and wait up to 30 s before ptp4l on the new image. |
    | T0 | The rig's wiring | phc2sys's journal shows `selecting … as domain source clock` (`-n` works); the Device Manager shows the port state and the Time source row (`-d` works); `/run/media-router-ptp/owner.env` on the grandmaster shows `CHRONY_GRANTED=1`. |
    | T1, T2 | Steady grandmaster for 1 h, hardware, then software | chronyd active, `chronyc tracking` Normal. On a slave `pmc -u -b 0 -d 10 'GET TIME_PROPERTIES_DATA_SET'` shows timeTraceable 1, currentUtcOffsetValid 1, currentUtcOffset 37, timeSource 0x50 and ptpTimescale 1 (hardware) or 0 (software); the slave's kernel `tai` is 37 (`mr-clockstate --once`). On the hardware grandmaster `phc_ctl /dev/ptp0 cmp` reads −37 s ± µs and its engine reports source chrony, synced, traceable. No `System clock interference detected` in chronyd's journal; the tick check is quiet; slave rms within 2× the Phase 0 baseline. |
    | T3 | Loses the election: start a priority1 5 box on the rig; 10 trials in each mode | chronyd exits tens of ms after ptp4l's `UNCALIBRATED` line: read the watcher's `chronyd exited N ms after the revoke` (systemd's `ExecMainExitTimestampMonotonic` minus the revoke) next to ptp4l's `MASTER to UNCALIBRATED`. The namespace rig's 19 ms includes a fake `systemctl`, so the number has to come from here. Hardware: no interference lines; software: their count reported, expected ≤ 1 in 10. Each grandmaster engine shows source ptp and at most one re-epoch; `chronyc` answers 506 (no daemon) while slaved. |
    | T4 | Regains: stop the better box; 10 trials | chronyd active within the hold + 1 s of MASTER (8 s for AES67); first NTP update within 15 s; flags traceable within 20 s; the grandmaster engine logs `sync lost`, then `sync arrived, E unchanged`, with no re-epoch; the slaves see no step. |
    | T5 | Flapping: toggle the better grandmaster every 10 s for 5 min | Sampled at 5 Hz, "chronyd active while the port is UNCALIBRATED or SLAVE" holds in 0 samples in hardware mode and ≤ 1 per flip in software; chronyd starts stay within the backoff (≤ 6 in 5 min). |
    | T6 | Slave-only for 24 h on .22 and .111, with ptp4l restarts and a 10 min grandmaster outage | chronyd is never active and never started; phc2sys never passes 100 ppm; the tick check is quiet. |
    | T7 | Boot | (a) Grandmaster reboot with NTP reachable: the setup journal shows `chrony synchronised`, then `stepped the boot offset before ptp4l serves`, and ptp4l starts after; the slaves' offsets stay sub-ms through the grandmaster's return. (b) The same with UDP 123 dropped by nft: `no NTP sync after 30 s`, ptp4l serves, the flags read 0xa0, the grandmaster engine latches untraceable; on unblocking chrony steps if more than 1 s off (one step per slave, one re-epoch per engine) or slews, and the flags flip. (c) A master-capable Pi without an RTC booted offline, then connected: one domain-wide step, logged everywhere. |
    | T8 | NTP outage of 3 h at the grandmaster (nft drops udp/123) | The flags drop after ~30 min (`maxerror` ≥ 1 s), together with the grandmaster engine's `traceable`; the slaves stay locked; flags and engine are back within one poll after unblocking. chrony's root dispersion growth is logged for the record. |
    | T9 | Rogue | A default-configured Pi (`PTP_SLAVE_ONLY=0`, priority1 3) joins: the rig follows it, it runs chronyd as grandmaster and announces honest flags, and the old grandmaster revokes; when it leaves, the old grandmaster regains. Then a wrong-clock rogue in the style of a third-party master (an old image, a hand-set date): the slaves follow it, and every Device Manager shows "not traceable". |
    | T10 | Leap second, on an offline rig: a local chrony server with a test `leap-seconds.list` that schedules the coming midnight | Rig clocks at 11:58 UTC on June 30: leap61 stays 0 until 12:00, then is announced. Then at 23:50 UTC: the slaves' kernels have `STA_INS`; at midnight `tai` goes 37 → 38 everywhere, the grandmaster's phc2sys shows no PHC step and the engines log `realtime step, E unchanged`; after midnight currentUtcOffset is 38 and leap61 0, with no double increment. |
    | T11, T12 | Device Manager on the grandmaster | Disable leaves chronyd running and the owner chrony; a master-capable settings change adopts chronyd without restarting it and the save returns in < 5 s; a switch to slave-only stops chronyd. The grandmaster shows "chrony (NTP), served over PTP", the slaves "PTP (ptp4l)", each the Time source row; the grandmaster engine's `/system/timeSync` reads source chrony. |

  - In production, after T0–T12 pass and in the owner's window: image
    10.9.16.46 (intel-corei7-64), keeping `PTP_SLAVE_ONLY=0` and priority1
    10. Its boot steps its clock before it serves, which moves the domain
    by the 0.2–0.3 s it is off today. Within 1 min of .46 serving, run
    `systemctl restart media-router-ptp4l` (and phc2sys on the hardware
    boxes) on .103, .108, .111 and .22, so each steps once on first lock
    rather than slewing ~0.3 s for up to an hour with up to ~0.1 s between
    boxes. The owner accepted the one re-epoch per engine this costs
    (2026-10-14); the window is still to be set. Then check each Time page
    (owner; grandmaster traceable) and that .46's engine reports source
    chrony, traceable, and watch the tick-check flag for 24 h.
  - Follow-up, not in this item: if the fleet shows the two-lost-polls flap
    (ADR-0029), raise `MAX_SYNCED_ERROR_US` in `houseClockPolicy.ts` and the
    watcher's mirror to 8 s together; engine hysteresis for the `sync lost`
    blip at each takeover.
- **Estimate.** Not in the original estimate. Landed on 2026-10-14 as about
  +2,600 / −180 lines across the Yocto layer, the Device Manager and the
  engine, two thirds of them tests.

#### WI-P0-3 — `mr-clockstate`: the native clock sidecar

- **What.** Measure TAI − MONOTONIC tightly, read the kernel's sync state,
  detect steps at once, and stream JSON lines. A `--once` mode serves the
  Device Manager and tests.
- **Where.** New `packages/engine/native/mr-clockstate/`: `main.cpp`,
  `clock_sample.h`, `clock_sample.cpp`, `Makefile`,
  `tests/clock_sample_test.cpp`. The root `Makefile` auto-discovers
  `packages/engine/native/*/Makefile` (line 19), so it installs to
  `/usr/libexec/media-router/engine/mr-clockstate`. No root-Makefile or
  recipe change is needed beyond the existing `oe_runmake`.
- **How.**
  - `sample_epoch()`:
    1. Take 5 sandwiches of
       `clock_gettime(MONO) → clock_gettime(TAI) → clock_gettime(MONO)`.
    2. Keep the one with the smallest MONO bracket.
    3. Return `E = TAI − (m1+m2)/2` (`int64` ns) with the bracket as
       uncertainty.
  - `read_kernel()`: `adjtimex(&tx)` with `modes = 0`. It yields:
    - `synced = !(tx.status & STA_UNSYNC)`;
    - `taiOffsetS = tx.tai`;
    - `estErrorUs = tx.esterror`, `maxErrorUs = tx.maxerror`;
    - `freqPpm = tx.freq / 65536.0`;
    - the raw `status` bits and the return value (`TIME_OK`, `TIME_INS`
      etc. — the leap state).
  - Step watch:
    - `timerfd_create(CLOCK_REALTIME, TFD_CLOEXEC)`, armed with
      `TFD_TIMER_ABSTIME | TFD_TIMER_CANCEL_ON_SET` at a far-future
      expiry;
    - `poll()` on it with a 1 s timeout;
    - `read()` returning `ECANCELED` means the kernel called
      `clock_was_set`. The sidecar emits
      `{"type":"step","monoNs":"…"}`, re-arms, and emits a fresh sample at
      once.
  - Every 1 s it emits
    `{"type":"sample","monoNs":"…","eNs":"…","bracketNs":…,"synced":…,"taiOffsetS":…,"estErrorUs":…,"maxErrorUs":…,"freqPpm":…,"status":…,"leap":…}`.
    Nanosecond values are decimal strings (bigint-safe).
  - `--once` prints one sample and exits 0.
  - The sidecar is stateless: no latch, no policy.
- **Acceptance.**
  - `make -C packages/engine/native/mr-clockstate test` passes. Unit tests
    cover sandwich selection, status-bit decoding and JSON formatting with
    injected readers.
  - On a dev box:
    - `mr-clockstate --once` returns `eNs` within 1 ms of
      `aes67_clock.py`'s `taiMinusMonotonicNs`, read back-to-back;
    - `sudo date -s "+2 sec"` with chrony stopped yields a `step` line
      within 100 ms and an `eNs` that moved by 2 s ± 1 ms;
    - setting the TAI offset with `mr-ptp-settai.py` yields no `step` line
      (`ADJ_TAI` leaves REALTIME − MONOTONIC alone, so
      `timerfd_clock_was_set` does not cancel the timer): E moves by the
      TAI step on the next 1 Hz sample and is taken as a divergence, held
      by WI-P0-4's settle rule on an untraceable engine (captured on .50,
      `clockstate-tai-late.jsonl`; R-P0-5, settled 2026-10-14).
- **Estimate.** +560 lines, 2.5 d.

#### WI-P0-4 — Engine `HouseClock`: latch, start wait, re-epoch, state

- **What.** The engine's single owner of E and of time-sync state.
- **Where.**
  - New `packages/engine/src/clock/HouseClock.ts` (process and events),
    `packages/engine/src/clock/houseClockPolicy.ts` (pure decisions),
    `packages/engine/src/clock/clockSource.ts` (the owner poll) and tests.
  - `packages/shared-types/src/` gains `HouseEpoch` and `TimeSyncState`.
  - Edits to `packages/engine/src/Engine.ts`,
    `packages/engine/src/modules/ModuleRunController.ts`,
    `packages/engine/src/plugins/PluginModule.ts` (`EngineServices`),
    `packages/engine/src/system/SystemStatsCollector.ts` (`SystemStats`,
    `ENGINE_FEATURES`).
- **How.**
  - `HouseClock`:
    - `start()` spawns `mr-clockstate` via
      `processManager.spawn('__house_clock__', { autoRestart: true, logStdout: false, onStdout })`,
      with no log line per sample (fleet FF8: at debug the samples were 600
      of the engine's ~900 journal lines per 10 min on .108 and .22 and
      pushed boot logs out of the 32 MB volatile journal within ~2 h; the
      decisions are logged per the part 10 table), resolved with
      `resolveNativeBinary('mr-clockstate', 'engine')`. A stdout line that
      does not parse is logged at warn, at most once a minute on the
      monotonic clock, with its first 120 characters;
    - `ready(): Promise<HouseEpoch>`, `epoch(): HouseEpoch | null`,
      `state(): TimeSyncState`, and the events `epoch` and `state`;
    - a source poll every 10 s: `systemctl is-active chronyd.service` and
      `media-router-ptp4l.service` (unprivileged, read-only), mapped to
      `'chrony' | 'ptp' | 'none'`, chronyd first (on a PTP box chronyd runs
      only while it owns the clock: a grandmaster, or the setup's boot
      wait), and run once more on each `step` line; an older answer never
      overwrites a newer one. When the source is chrony the same
      poll reads `chronyc -c tracking` (reference, stratum, estimated
      error) into `SystemStats.timeSync`, so the engine shows the daemon's
      estimated error as §10.2 asks; the gate stays the kernel state
      (OQ-7).
  - `houseClockPolicy.ts`:
    - `qualifies(sample)` = `isSynced(sample) && taiOffsetS >= 10` (10 s is
      `aes67_clock.py`'s `MIN_TAI_UTC_OFFSET_S`, kept so a future leap
      second does not fail the check). `isSynced` is `STA_UNSYNC` clear and
      `maxerror` under 1 s (`MAX_SYNCED_ERROR_US`): linuxptp's start clears
      the flag for under a second with `maxerror` at 16 s (fleet fix,
      ADR-0029). OQ-7, answered yes: the daemon's error estimate is shown,
      not gated.
    - `decide(latched, sample, now)` returns one of `latch(start)`,
      `latch(timeout)`, `relatch(sync)`, `relatch(step)`,
      `relatch(divergence)`, `traceable(true/false)`, `settle` or `none`.
      `settle`: while the epoch is untraceable, a move of E whose sample
      does not qualify is held until the state qualifies or for 10 s
      (`SETTLE_MAX_MS`), then latched once, as `step` if a step line came
      since the move, else as `sync` or, at the cap, `divergence`; a boot
      step, its TAI write and the sync it brings are one re-epoch.
    - The divergence tolerance is `1 ms`, an engineer's choice: E is
      constant under slew, sandwich noise is a few µs, and 1 ms is far
      below a frame.
    - On a `step` line, the next sample is compared at once. If |ΔE| is
      below tolerance (e.g. a kernel leap insert, where REALTIME repeats
      and TAI does not), the clock logs "realtime step, E unchanged" and
      does not re-epoch.
  - Start wait:
    - `Engine.start()` calls `houseClock.start()` before plugin load;
    - the 30 s timer runs from that call;
    - `ModuleRunController.start()` does `await this.houseClock.ready()`
      before `lifecycle.startAll()`, so a start requested later than 30 s
      after boot is not delayed;
    - on timeout it logs
      `warn: no time sync after 30 s (source=…, synced=…, tai=…) — starting untraceable`.
  - **Missing sidecar** (a dev host without `make native`): log an error
    once. E stays `null`, `traceable = false`, and `ready()` resolves at
    once with `null`, so modules are never blocked by a missing binary.
  - `SystemStats.timeSync`:
    - `source`, `synced`, `traceable`, `taiOffsetS`, `estErrorUs`,
      `maxErrorUs`, `freqPpm`;
    - `waitingForSync` with `waitRemainingS`;
    - `epochSeq`, `epochLatchedAt` (ISO wall time), `epochReason`;
    - `eNs` as a string, for diagnostics.

    Add `'house-clock'` to `ENGINE_FEATURES` (line 43) so a manager can
    tell new engines from old.
  - Logs at `info` for every latch and re-latch, with seq, reason, ΔE,
    source and error, and at `warn` for the timeout and loss of sync.
- **Acceptance.**
  - Vitest `houseClockPolicy.test.ts` covers the decision table:
    - start synced;
    - start never synced (timeout at 30 s with fake timers);
    - sync after timeout with E moved 37 s (TAI set late) → `relatch(sync)`;
    - sync after timeout with E unchanged → `traceable(true)`, no seq bump;
    - step +2 s → `relatch(step)`;
    - REALTIME step with E unchanged (leap) → `none`;
    - divergence 1.5 ms → `relatch(divergence)`;
    - divergence 0.2 ms → `none`;
    - loss of sync after latch → `traceable(false)`, E kept;
    - `STA_UNSYNC` clear at `maxerror` 16 s → not synced;
    - a move while untraceable and unsynced → `settle`; at the 10 s cap →
      `relatch(step)` or `relatch(divergence)`;
    - a step while untraceable, then sync → `relatch(step)`;
    - a move while traceable → re-latches at once, never settles.
  - `HouseClock.test.ts` drives a fake sidecar through stdout lines,
    checks a sidecar crash and restart does not change E, and checks
    through a real `ProcessManager` that samples reach the clock but not
    the log while the sidecar's stderr does. It replays the four field
    captures of part 7, and covers linuxptp's start-up false window. A
    `step` line re-polls the owner at once (state and `state` event before
    the 10 s poll); an older poll's late answer never overwrites a step's
    newer one; an unreadable sidecar line warns at most once a minute,
    timed monotonically, with a 120-character excerpt.
  - `clockSource.test.ts`: both units active → `chrony`, and
    `chronyc -c tracking` is read; chronyd `deactivating` with ptp4l active
    → `ptp`.
  - `Engine.test.ts` checks module start waits for `ready()` and that the
    API is reachable during the wait.
- **Estimate.** +850 lines (≈ 450 code, 400 tests), 3 d.

#### WI-P0-5 — Remove the `MR_TIME_SYNC_CONTRACT` kill switch and the legacy `clockSync` arm (OQ-4: Phase 0)

- **What.** Make `base_time = 0` on a monotonic clock unconditional (§4.1),
  so `now − PTS` is house lateness everywhere. This is a cut-over: the flag
  and the arm go in this release.
- **Where.** The files listed in part 3.5, plus tests:
  - `packages/engine/src/plugins/GstPluginBase.timeSync.test.ts` (312
    lines, the legacy cases);
  - `packages/engine/src/Engine.test.ts`;
  - `packages/engine/src/child-process/native_runner_protocol_test.py` (the
    `clock` cases);
  - `packages/engine/src/child-process/gst_time_sync_contract_test.py` (the
    contract-off cases);
  - `plugins/audio-decoder/engine/AudioDecoderModule.test.ts`.
  - The other readers of `timeSyncContract`:
    `packages/engine/src/child-process/GstChildProcess.ts`,
    `packages/engine/src/child-process/PythonProcess.ts`,
    `packages/engine/src/modules/ModuleManager.ts` and
    `plugins/ts-splitter/engine/nativeRunner.ts`.
- **How.**
  - Delete `EngineConfig.timeSyncContract`, `Engine.timeSyncContract` and
    the env read.
  - Delete `ClockAuthority`, `gst-net-clock.py` and
    `EngineServices.clockAuthority`.
  - Delete `PipelineDescription.clockSync` and `clock`, and
    `ClockConfig`.
  - `GstPluginBase.applyTimeSync()` always sets the contract clock, and
    the runners no longer read a flag:
    - python: `_apply_contract_clock` is unconditional and
      `_apply_net_clock` is deleted;
    - native: `runner.cpp:59` and `:313` drop the branch, and
      `nativeRunner.ts:111` drops `'clock'`.
  - `services.timeSyncContract` reads in modules become unconditional
    (`AudioDecoderModule.ts`, `AudioOutput302mModule.ts`,
    `Aes67OutputModule.ts`, `backlogShed.ts`, `playoutOffset.ts`,
    `HlsPlayerModule.ts`, `TsSplitterModule.ts`). The mechanisms behind
    them stay until their own phase.
  - Remove the audio-decoder `clockSync` setting from
    `plugins/audio-decoder/package.json:110` and its reads. Its stored
    value is ignored (Q9's no-migration rule).
  - Update `plugins/README.md:2045-2052`.
- **Acceptance.**
  - `pnpm -r test`, `make native-test` and both runners' python suites
    pass.
  - `grep -rn 'MR_TIME_SYNC_CONTRACT\|timeSyncContract\|clockSync\|ClockAuthority\|gst-net-clock'`
    outside `docs/adr` returns nothing: `PipelineDescription.timeSyncContract`
    goes too, since the contract is unconditional.
  - On the gate, a unit drop-in setting `MR_TIME_SYNC_CONTRACT=0` has no
    effect: the runner logs "contract clock" for every pipeline.
- **Estimate.** +60 / −800 lines, 2 d.

#### WI-P0-6 — `aes67-output` reads the engine's E; `aes67_clock.py` goes

- **What.** One E for the engine. The module stops measuring its own.
- **Where.**
  - `plugins/aes67-output/engine/Aes67OutputModule.ts` and its test.
  - Delete `plugins/aes67-core/py/aes67_clock.py` and
    `plugins/aes67-core/py/aes67_clock_test.py`.
  - Comment fix in `plugins/aes67-core/py/aes67_sap.py:24,149`.
  - `rtpTimestampOffset()` added to
    `packages/engine/src/plugins/aes67Helpers.ts`, next to the SDP code
    that already claims `direct=0` (`plugins/aes67-core` has no `engine/`
    folder), tested in `aes67Helpers.test.ts`.
- **How.**
  - `rtpTimestampOffset(eNs: bigint, rate = 48000n): number` returns
    `Number((eNs * rate / 1_000_000_000n) % 2n ** 32n)`. It is the same
    integer arithmetic as the deleted Python.
  - `measureEpoch()` becomes
    `const ep = await this.services.houseClock.ready()`. The module uses
    E when `ptpSync && ep?.traceable`; otherwise it free-runs with
    `epochError` set to the reason (untraceable, source none, or TAI
    offset unset).
  - It subscribes to `houseClock.on('epoch')` and calls the existing
    restart path, so the new `timestamp-offset` lands. A re-epoch is one
    discontinuity (§10.3).
  - The `clock` status section shows seq and source.
- **Acceptance.**
  - Unit tests:
    - offset arithmetic against the deleted Python's vectors (copied into
      the TS test);
    - free-run when untraceable;
    - restart on an `epoch` event.
  - On the gate pair under PTP: the module's `timestamp-offset` matches
    `mr-clockstate --once` E × 48000 mod 2^32 within ±1 sample.
- **Estimate.** +60 / −260 lines, 1 d.

#### WI-P0-7 — `mrts::LatenessWindow` and the `mrlateness` element

- **What.** One native accumulator and one GStreamer element, used by both
  runners and the sidecars.
- **Where.**
  - New `plugins/mpegts-core/native/mrts/lateness.h` and `lateness.cpp`,
    with `plugins/mpegts-core/native/mrts/tests/lateness_test.cpp` (same
    `check.h` harness as `ts_timeline_test.cpp`).
  - New `plugins/mpegts-core/native/mrlateness/gstmrlateness.cpp` and
    `Makefile`, which compiles `lateness.cpp` in with `-fPIC`, as the
    `mrtsstamp` Makefile does.
- **How.**
  - `mrts::LatenessWindow`:
    - `add(int64_t lateness_ns)`;
    - `add_untimed()`;
    - `bool due(int64_t now_ns)`;
    - `Summary take(int64_t now_ns)` returning count, untimed, min, max,
      mean and last in ns;
    - window length set at construction (default 2 s, aligned with the
      2 s module stats cadence).
  - `mrlateness`:
    - A plain `GstElement` with always sink and src pads,
      `GST_PAD_SET_PROXY_CAPS | PROXY_ALLOCATION | PROXY_SCHEDULING`.
    - Events and queries pass through.
    - It has a `chain` *and* a `chain_list` function. Lists are passed on
      intact, which matters behind `mpegtsmux alignment=7`; a
      `GstBaseTransform` would dismantle them (see the `gstmrtsstamp.cpp`
      COALESCE note).
    - Each buffer (for a list, its first buffer) gives
      `λ = now − t(PTS or DTS)`.
  - Properties:
    - `reference` enum, `house` (default) or `running-time`:
      - `house`: now = `clock_gettime(CLOCK_MONOTONIC)` and t = raw buffer
        PTS. This is the bus convention (§4.3) and is correct even in
        `liveCaptureClock` pipelines;
      - `running-time`: now = element clock − base time and
        t = `gst_segment_to_running_time()`. This is used before sinks;
    - `interval-ms` (default 2000);
    - `post-messages` (default true);
    - read-only `stats` (`GstStructure`).
  - At each window it posts an element message named `mrlateness` with
    `count`, `untimed`, `min-ns`, `mean-ns`, `max-ns`, `last-ns`,
    `interval-ns` and `reference`. It is posted from the streaming thread,
    and only when the window had buffers or untimed buffers.
  - Cost: one `clock_gettime` and a few adds per buffer at bus taps; the
    running-time taps before sinks add one element-clock read
    (`gst_element_get_current_running_time`). No allocation on the hot
    path either way.
- **Acceptance.**
  - `lateness_test` covers window boundaries, negative lateness, untimed
    counting and empty windows.
  - A new `packages/engine/src/child-process/gst_mrlateness_element_test.py`
    (dataflow, the `gst_mrtsstamp_element_test.py` pattern) checks:
    - `appsrc` with PTS = mono − 300 ms reports `mean ≈ 300 ms ± 5 ms`;
    - a list of 7 buffers stays one list downstream (`chain_list`
      counted);
    - `running-time` and `house` agree when `base_time = 0`;
    - in a pipeline with `base_time ≠ 0`, `house` stays correct.
- **Estimate.** +600 lines, 3 d.

#### WI-P0-8 — Lateness taps in both runners, on outputs and in the sidecars

- **What.** Put the instrument at every measuring point.
- **Where.**
  - `packages/engine/src/plugins/busHelpers.ts`: `buildBusSrc()` (line 183)
    and `buildBusSink()` (line 228).
  - `packages/engine/src/child-process/nativeBinaries.ts`: a new
    `resolveNativeAsset(pluginId, tool, file)` and its test.
  - Runner element handlers: `gst-pipeline-runner.py:506-528` and
    `native/mr-gst-runner/runner.cpp:517-531`.
  - The plugin loaders `packages/engine/src/child-process/gst_stamp_native.py`
    (`so_paths`, `load_plugin` pattern) and
    `packages/engine/native/mr-gst-runner/stamper.cpp:47-61`
    (`gst_plugin_load_file` by path, never `GST_PLUGIN_PATH`). A new
    `gst_lateness_native.py` follows `gst_rist_native.py`.
  - Output modules:
    - `plugins/video-player/engine/helpers/pipelinePlan.ts`;
    - `plugins/audio-decoder/engine/AudioDecoderModule.ts`;
    - `plugins/audio-output-302m/engine/AudioOutput302mModule.ts`;
    - `plugins/aes67-output/engine/Aes67OutputModule.ts`;
    - the network egress builders in `plugins/srt-output`,
      `plugins/rist-output` and `plugins/mpegts-ip-output` (engine
      folders).
  - Sidecars: `plugins/unixfdbus-core/native/mr-bus-fanout/main.cpp` (stats
    at line 133) and `plugins/ts-splitter/native/mr-tssplit/app.cpp`
    (`emit_stats`, line 257).
- **How.**
  - Bus edges:
    - `buildBusSrc()` emits
      `unixfdsrc … ! mrlateness name=lat_<busin name> reference=house ! queue …`.
      The tap sits *before* the ingress queue, so it reads arrival, and
      dynamic `bus_input_add` descriptions get it for free.
    - `buildBusSink()` emits
      `capssetter ! capsfilter ! mrlateness name=lat_<busout> reference=house ! tee busout_<port>`,
      after the runners' `mrtsstamp` splice point (the splice goes before
      `capssetter`).
    - Name helpers `latInName(busin)` and `latOutName(port)` are exported
      next to `busTeeName`, and pinned in `busRunnerContract.test.ts`.
  - Before sinks: a helper `buildLatenessTap(name: 'lat_render' | 'lat_egress')`
    returns `mrlateness name=… reference=running-time`. Each output module
    inserts it directly before its sink element (`udpsink`, `srtsink`,
    `mrristsink`, audio and video sinks).
  - Runners:
    - both load `libgstmrlateness.so` by path at runner start (an
      unconditional `gst_plugin_load_file` / `Gst.Plugin.load_file`;
      negligible cost) and log one line if it is missing;
    - each ELEMENT handler gains one branch:
      `elif name == "mrlateness": emit_plugin_event(f"mrlateness:{src_name}", gst_structure_to_dict(structure))`
      (python), and the C++ equivalent. No `busReports` subscription is
      needed, so inputs added at runtime report.
  - Engine guard: `GstPluginBase` checks
    `resolveNativeAsset('mpegts-core', 'mrlateness', 'libgstmrlateness.so')`
    once. The helper is new: `nativeBinaries.ts` exports only
    `resolveNativeBinary` and `resolvePythonScript` today (:83, :110),
    which try `plugins/<plugin>/native/<name>/<name>` and
    `/usr/libexec/media-router/<plugin>/<name>` and cannot find a `.so`
    under `native/mrlateness/`. It mirrors C++
    `paths::asset_candidates("mpegts-core", "mrtsstamp",
    "libgstmrtsstamp.so")` (`mr-gst-runner/stamper.cpp:47–50`) and Python
    `gst_stamp_native.so_paths()` (:40). If the
    file is missing, the bus helpers omit the taps, so a pipeline never
    fails to parse, and the module shows "lateness instrument missing" in
    its `timing` section.
  - Sidecars:
    - `mr-bus-fanout` keeps a `mrts::LatenessWindow` on the stamped
      buffers it writes and adds `"lateness":{count,min,mean,max}` (ms) to
      its stats JSON;
    - `mr-tssplit` does the same at its stamping point, one window per
      output;
    - `HlsPlayerModule.ts` and `TsSplitterModule.ts` parse it into the
      same `timing` section.
- **Acceptance.**
  - `busRunnerContract.test.ts` pins the tap names in both runner sources.
  - `native_runner_protocol_test.py` and a new python-runner protocol case
    each run `unixfdsink → [runner: buildBusSrc string ! fakesink]` with a
    producer stamping PTS = mono − 200 ms. Both must emit
    `mrlateness:lat_busin` with `mean-ns` 200 ms ± 10 ms.
  - Same check for a dynamic `bus_input_add` branch.
  - `unixfdFanout.test.ts` and the `mr-tssplit` tests assert the
    `lateness` key.
- **Estimate.** +350 lines, 3 d.

#### WI-P0-9 — `LatenessReporter`: what every module shows

- **What.** Turn windows into the §9.5 display, centrally. Display only:
  no alarm threshold ships in Phase 0 (OQ-8, decided 2026-10-12; the
  owner wants a feel for the numbers first). The deferred alarm is the
  note after part 13.
- **Where.**
  - New `packages/engine/src/plugins/latenessReporter.ts` and test.
  - Hooks in `GstPluginBase.ts`: `dispatchPluginEvent()` (line 739), start
    and stop, `getState()`.
  - `packages/shared-types/src/` gains the `ModuleTimingSummary` type.
- **How.**
  - `LatenessReporter` collects per tap name:
    - `lat_busin*` → inputs;
    - `lat_bus_out*` → output;
    - `lat_render` / `lat_egress` → output for output modules;
    - sidecar windows.

    Every 2 s it computes:
    - `outputMs` (mean, min, max);
    - per input: `inMs` and `addedMs = outMean − inMean`;
    - `slowest` = the input with the highest mean. This is the Phase 0
      stand-in for "which input it is waiting for"; it becomes exact when
      aligners wait in Phase 2.
  - For outputs:
    - `decodeMs = λ(lat_render) − λ(lat_busin)`;
    - `presentationDelayMs` = the module's current `ts-offset` (D), which
      it already resolves;
    - `deviceLatencyMs` = the sink's configured latency read once at
      PLAYING through the existing `get_property` RPC (`buffer-time` on
      audio base sinks; one refresh interval on video sinks);
    - `renderMs = max(λ(lat_render), D) + device` — the Phase 0
      approximation while sinks still wait for D. In Phase 4, D is 0 and
      this becomes `λ + device`.
  - Publication:
    - `setDynamicSections()` adds `timing` (Output lateness, Added latency,
      Slowest input, and for outputs Decode, Presentation delay, Device
      latency, Render lateness) and `timing-in-<n>` per input (Lateness,
      Added). Every row carries its label and unit ("Output lateness
      312 ms", "Added latency 48 ms"): the operator reads a number, not a
      colour.
    - `setBadge('lateness', { icon: 'timer', text: '<n> ms' })`, grey: the
      render lateness on outputs that render (`lat_render`: video-player,
      audio-decoder, audio-output-302m), PipeWire latency on PipeWire-graph
      modules, the mean output lateness otherwise (review F9).
      ADR-0007: plugins compute, UI renders.
    - Ingests show a negative lateness once Phase 1 lands; in Phase 0
      their stamps are arrival-anchored, so they read near 0.
  - No alarm (OQ-8): no setting is injected into any schema and
    `OwnedWarning` is not extended. The deferred option is recorded after
    part 13.
  - Throttle: state is emitted only when a displayed value changes by
    ≥ 1 ms. This bounds manager traffic with 30 modules (R-P0-6).
- **Acceptance.**
  - `latenessReporter.test.ts`, `timingSections.test.ts` and `moduleTiming.test.ts` cover:
    - single-input transform: added latency = out − in;
    - a 3-input muxer: slowest input named;
    - an output with D = 60 ms and λ = 20 ms gives render 60 + device;
    - λ = 150 ms gives render 150 + device;
    - every row labelled with its unit;
    - throttling.
  - No module settings schema changes; the engine and manager schema
    snapshots are untouched.
- **Estimate.** +340 lines, 2 d.

#### WI-P0-10 — PipeWire-graph modules show PipeWire's latency

- **What.** §9.5's last line for `audio-input`, `audio-output`, `n1-mixer`
  and `audio-dynamics`.
- **Where.** New `packages/engine/src/audio/pipeWireLatency.ts` and test,
  reusing the `pw-dump` call in `packages/engine/src/audio/streamPortLinks.ts:110`.
  Each of those four plugins' engine modules calls it.
- **How.**
  - `readNodeLatency(nodeIds)` parses `pw-dump` for each node:
    - `info.params.Latency` (min/max quantum, rate, ns), or
    - `node.latency` from props, together with `clock.quantum` and
      `clock.rate` of the driver.

    It returns `{ quantum, rate, latencyMs }`.
  - Polled every 10 s and published in the same `timing` section as
    "PipeWire latency" (no PTS, so no lateness).
- **Acceptance.** Unit test on `pw-dump-fleet.json`, a `pw-dump` captured
  on fleet box 10.9.16.22 (Pi 5, PipeWire 1.6.3, running audio-decoder,
  audio-encoder and n1-mixer; provenance in `fixtures/fixture-reduce.py`)
  rather than a gate box. On .103 or .108 the value matches `pw-top`'s
  QUANT/RATE for one audio-input or audio-output node (WI-P0-14, still
  open).
- **Estimate.** +200 lines, 1 d.

#### WI-P0-11 — Manager UI: the engine's time-sync state

- **What.** Make sync state and epoch visible per engine.
- **Where.**
  - `packages/manager-ui/src/stores/engines.ts` (`SystemStats` type near
    line 154);
  - `packages/manager-ui/src/components/common/EngineListItem.vue`
    (pattern at line 53);
  - `packages/manager-ui/src/components/common/AppHeader.vue` (pattern at
    line 64);
  - tests next to them (`EngineListItem.test.ts`).
- **How.**
  - Engines that announce the `house-clock` feature get a clock indicator
    (heroicon `ClockIcon`, no emoji):
    - green when `traceable`;
    - amber when `waitingForSync`, or when untraceable but synced (TAI
      unset);
    - red when `!synced` after start.
  - The tooltip shows source, error, TAI−UTC, epoch seq and when and why
    it was latched.
  - The header shows the active engine's indicator.
  - Older engines show nothing (R20).
- **Acceptance.**
  - Component tests for the 4 states and for an old engine.
  - On the gate: the indicator reads amber for ~30 s after an offline boot,
    then green after the uplink returns.
- **Estimate.** +200 lines, 1.5 d.

#### WI-P0-12 — Device Manager: Time page, chrony status, displacement removed

- **What.** Show chrony, let a site set its NTP servers (OQ-6), and make
  PTP on/off hand the clock between chrony and PTP (a grandmaster keeps
  chrony: WI-P0-2b).
- **Where** (all under
  `meta-layers/meta-custom/recipes-apps/device-manager/files/`):
  - `api/src/config/PtpConfig.ts`, `api/src/config/PtpConfig.spec.ts`;
  - new `api/src/config/TimeStatus.ts` and `TimeStatus.spec.ts`;
  - new `api/src/config/TimeConfig.ts` and `TimeConfig.spec.ts`; new
    `api/src/dto/TimeConfigDto.ts` and `app/src/dto/TimeConfigDto.ts`;
    `api/src/dto/ConfigDto.ts`, `app/src/dto/ConfigDto.ts` (`time?:
    TimeConfigDto`); `api/src/config/Config.ts` (apply on save, strip
    from `config.json`, as `ptp` is);
  - `api/src/config/index.ts`, `api/src/socket/index.ts`;
  - `app/src/socketClient.ts`;
  - new `app/src/components/TimeStatusCard.vue`;
  - `app/src/pages/PtpConfigPage.vue`;
  - `app/src/pages/BasePage.vue:69`, `app/src/router/index.ts:45-47`.
- **How.**
  - `PtpConfig.ts`:
    - delete lines 40-96 (`FALLBACK_TIME_SERVICES`,
      `DISPLACED_RECORD_NAME`, `DEFAULT_FALLBACK_TIME_SERVICE`,
      `readDisplacedTimeServices`) and the restore loop at lines 322-364;
    - enable path: on a slave-only save, `run("systemctl", ["stop",
      "chronyd"])` before the ptp4l restart; a master-capable save leaves
      chronyd to the setup script and `mr-ptp-owner`; the restart is
      `run("systemctl", ["restart", "media-router-ptp4l"], 60_000)` (the
      setup script may wait 30 s for NTP);
    - disable path: stop the units (`mr-ptp-owner` stops with ptp4l),
      remove `ptp.env`, then `systemctl start chronyd` (its condition now
      passes; a no-op where it already runs);
    - `fs.rmSync('/data/ptp/displaced-time-services', { force: true })`
      once on load, to clean a stale record left by older builds;
    - rewrite the header comment (lines 12-33).
  - `TimeStatus.ts`: `getTimeStatus(): Promise<TimeStatus>` combines three
    sources:
    - `/usr/libexec/media-router/engine/mr-clockstate --once` for the
      kernel view (synced, TAI offset, errors, frequency, leap state). This
      is the same binary the engine uses, so there is one implementation;
    - when chronyd is active, `chronyc -c tracking` (reference ID, stratum,
      system time offset, RMS offset, frequency, skew, root delay and
      dispersion, leap status) and `chronyc -c sources` (mode, state,
      name, stratum, reach, last sample);
    - `owner`: `chrony` if chronyd is active (on a PTP box it runs only
      while it owns the clock: as grandmaster, or during the setup script's
      boot wait), else `ptp` if `ptp.env` exists and ptp4l is active, else
      `none`; `synced`: `isSynced(kernel)`, the engine's predicate
      (`STA_UNSYNC` clear and `maxerror` < 1 s, `MAX_SYNCED_ERROR_US`
      mirrored from `houseClockPolicy.ts`).

    `run()` from `PtpExec.ts`; CSV parsing is pure and unit-tested. The
    system-time offset is worded as chronyc 4.8 words it, "x slow/fast of
    NTP time" (slow only for a positive `current_correction`; an
    engineering choice, ADR-0029).
  - `PtpStatus.ts`: `pmc -u -b 0 -d <status.env PTP_DOMAIN, else 0>` plus
    `GET TIME_PROPERTIES_DATA_SET`, parsed into `timeProperties`; the
    page's Time source row shows its timeSource and timeTraceable
    (WI-P0-2b).
  - `TimeConfig.ts` (OQ-6): `TimeConfigDto { ntpServers: string[] }`, 1 to
    8 entries, each a host name or an IP literal, validated by
    `class-validator` decorators on the DTO and by `normalizeTimeConfig()`
    (trim, dedupe, reject an empty list); default `['pool.ntp.org']`.
    `setTimeConfig()` renders `/data/chrony/sources.d/media-router.sources`
    (`pool <name> iburst maxsources 4` for a name, `server <addr> iburst`
    for an address), writes it atomically and runs `chronyc reload
    sources`; a no-change save touches nothing (the `setPtpConfig`
    pattern). `loadTimeConfig()` reads the file back at start, so the file
    on `/data` is authoritative and `config.json` does not carry the
    section, as with `ptp`. DHCP-offered servers (WI-P0-1) are not part
    of the setting; the page lists them read-only from the NetworkManager
    dispatcher's `/run/chrony-dhcp/*.sources` fragments (`chronyc -c
    sources` has no provenance column and answers nothing under PTP;
    review F20).
  - Socket: `requestTimeStatus` → `timeStatus`, the same failure policy as
    `emitPtpStatusTo` (log, never drop the socket).
  - App:
    - `TimeStatusCard.vue` sits at the top of the page (heroicons only);
    - the page title becomes "Time";
    - the menu item `{ name: 'Time', icon: ClockIcon, route: '/time' }`,
      with `/ptp` redirecting to `/time` (OQ-9, answered: one Time page);
    - a **Servers** field on the Clock card: a list editor with per-entry
      validation and the default as placeholder, the DHCP-offered servers
      listed read-only beneath it (OQ-6);
    - the TAI−UTC row is red with "kernel TAI offset not set — CLOCK_TAI
      equals UTC" when 0;
    - the page polls `requestTimeStatus` every 5 s while open, as the PTP
      status does.
- **Acceptance.**
  - `PtpConfig.spec.ts` replaces the 8 displacement tests with these:
    - a slave-only enable stops chronyd before restarting ptp4l, also on a
      switch from master-capable; a master-capable enable never names
      chronyd; the ptp4l restart uses the 60 s timeout;
    - disable starts chronyd and nothing else;
    - htpdate and timesyncd are never named;
    - a no-change save touches no unit.
  - `TimeStatus.spec.ts` parses captured `chronyc -c -n` output and the
    `mr-clockstate --once` JSON, including an unsynced sample and a
    TAI-offset-0 sample, and reads the .108 false-window sample (flag
    clear, TAI 37, `maxerror` 16 s) as not synced. The captures are from
    10.9.16.50, not a gate box (WI-P0-14 record).
  - `TimeConfig.spec.ts`: rendering of names and addresses; validation
    rejects an empty list, a ninth entry and a malformed name; a no-change
    save runs nothing; `chronyc reload sources` runs once per change.
  - On the gate: toggling PTP on and off flips `owner`; a slave-only box
    keeps exactly one daemon active (`systemctl is-active chronyd
    media-router-ptp4l`), while a master-capable box runs both while it is
    grandmaster and shows "chrony (NTP), served over PTP"; setting the
    server list to the manager host changes `chronyc sources` within 10 s,
    and restoring the default brings the pool back.
- **Estimate.** +750 / −230 lines, 3.5 d.

#### WI-P0-13 — Documents

- **What.** Record the engineer's choices and point the old text at the new.
- **Where.**
  - New `docs/adr/0029-house-clock-timing.md`, the ADR the design status
    line calls for (Phase 0 section first).
  - `docs/adr/0005-time-sync-backend.md` (decision 6, the 2026-08-18 note
    at lines 227-232 and the 2026-08-19 note at lines 263-265).
  - `docs/adr/README.md` (index).
  - `plugins/README.md` (WI-P0-5).
  - Release notes.
- **How.**
  - The ADR records the Phase 0 choices:
    - E in the engine process with a native sidecar, and why;
    - the divergence tolerance of 1 ms;
    - `qualifies()`;
    - `mrlateness` placement and `reference` rule;
    - the 2 s window;
    - chrony config values and the server-list mechanism (`sourcedir`
      fragments, OQ-6);
    - the TAI source under PTP;
    - the grandmaster on chrony (WI-P0-2b), with the rejected designs.
  - ADR-0005 gets one line per affected note, "superseded by ADR-0029
    (Phase 0)". Nothing else in ADR-0005 changes; the current model is
    frozen and §11.6 is left alone (§13.1).
  - Release notes list:
    - htpdate and timesyncd removed and chrony added;
    - chrony being off where PTP is on, except on a grandmaster, which
      chrony keeps on NTP time (WI-P0-2b);
    - the start wait;
    - the new lateness display, labelled, with no alarm yet (OQ-8);
    - NTP servers set on the Device Manager's Time page (OQ-6);
    - removal of `MR_TIME_SYNC_CONTRACT` and the audio-decoder
      `clockSync` setting (OQ-4).
- **Acceptance.** `docs/adr/README.md` lists 0029. The ADR is reviewed by
  the design owner.
- **Estimate.** +250 / −20 lines, 1 d.

#### WI-P0-14 — Gate verification and release

See part 11. 2 d, including one full image build and RAUC install on both gate
boxes.

Record, 2026-10-14 (what is still to confirm on a box is ADR-0029's "Open
until the fleet check"):

- The engine clock fixtures are raw `mr-clockstate` captures from 10.9.16.50
  (Pi 5, image v2.0.0.97, engine 1a4c87c), a chrony box, not the gate boxes
  (`packages/engine/src/clock/fixtures/PROVENANCE.md`).
- The Device Manager Time-page fixtures are real captures from 10.9.16.50
  (Raspberry Pi 5, image v2.0.0.97, engine 1a4c87c, chrony 4.8), taken
  2026-10-14 05:19–05:21 UTC by `fixture-capture.sh`, not on a gate box as
  WI-P0-12's acceptance says. `clockstate-once-tai0.jsonl` is from the
  development Pi 5 `mr-test` (2026-10-13 07:24 UTC). No capture had a
  falseticker (`x`) or too-variable (`~`) source, so `TimeStatus.spec.ts`
  keeps a two-row synthetic case for those states.
- The PipeWire fixture `pw-dump-fleet.json` is from fleet box 10.9.16.22;
  comparing the PipeWire latency row of one audio-input or audio-output
  with `pw-top` QUANT/RATE on .103 or .108 is still to do.
- The grandmaster on chrony (WI-P0-2b) passes its rig, T0–T12, before
  10.9.16.46 is imaged.

### 6. Deletions

All of these go in the Phase 0 release.

| What | Path | Lines | WI |
|---|---|---|---|
| htpdate in the image | `build/conf/local.conf:171-172` (and comment 179-180) | 4 | 1 |
| htpdate unit recipe | `meta-layers/meta-custom/recipes-support/htpdate/htpdate_%.bbappend`, `.../files/htpdate.service` | 41 | 1 |
| systemd-timesyncd | systemd `PACKAGECONFIG` (removed via `local.conf`) | — | 1 |
| Displacement block | `meta-layers/meta-custom/recipes-support/media-router-ptp/files/media-router-ptp-setup.sh:305-348` | 44 | 2 |
| htpdate ordering | `.../media-router-ptp/files/media-router-ptp4l.service:33` (and comment 16-31 rewritten) | 1 | 2 |
| Displacement record file | `/data/ptp/displaced-time-services` on devices (deleted once by the Device Manager) | — | 12 |
| Restore logic | `.../device-manager/files/api/src/config/PtpConfig.ts:40-96, 322-364` | ~100 | 12 |
| Restore tests | `.../device-manager/files/api/src/config/PtpConfig.spec.ts:397-483` | 87 | 12 |
| Per-module TAI measurement | `plugins/aes67-core/py/aes67_clock.py`, `plugins/aes67-core/py/aes67_clock_test.py` | 220 | 6 |
| Real-run epoch test and the contract-off case | `plugins/aes67-output/engine/Aes67OutputModule.test.ts:173-197` | ~28 | 6 |
| Kill switch (OQ-4) | `packages/engine/src/Engine.ts:44-56,150-151` and `MR_TIME_SYNC_CONTRACT` | ~25 | 5 |
| Net clock (OQ-4) | `packages/engine/src/child-process/ClockAuthority.ts`, `ClockAuthority.test.ts`, `gst-net-clock.py` | 211 | 5 |
| Legacy clock in runners (OQ-4) | `gst-pipeline-runner.py:1876-1944` (`_apply_net_clock`, comment from 1868), the branch at 2097-2100; `native/mr-gst-runner/runner.cpp:59`; `nativeRunner.ts:111` | ~80 | 5 |
| Legacy description fields (OQ-4) | `PluginModule.ts` `clockAuthority`, `clockSync`, `clock`, `ClockConfig`, `timeSyncContract`; `GstPluginBase.ts` legacy branch of `applyTimeSync()` | ~90 | 5 |
| audio-decoder `clockSync` setting (OQ-4) | `plugins/audio-decoder/package.json:110`, `AudioDecoderModule.ts:303-417` reads | ~25 | 5 |
| Legacy-arm tests (OQ-4) | `GstPluginBase.timeSync.test.ts`, `Engine.test.ts`, `native_runner_protocol_test.py`, `gst_time_sync_contract_test.py`, `AudioDecoderModule.test.ts` (contract-off cases) | ~350 | 5 |
| Docs | `plugins/README.md:2045-2052` flag text; ADR-0005 decision 6 notes marked superseded | ~10 | 13 |

Nothing for presentation delay, stamping, conditioning or shedding is
deleted here. Those mechanisms go in Phases 2-4.

### 7. Tests and fixtures

| Test | Kind | Pins | Lives in |
|---|---|---|---|
| `clock_sample_test` | C++ unit | Sandwich selection, `adjtimex` status decoding, JSON | `packages/engine/native/mr-clockstate/tests/` |
| `lateness_test` | C++ unit | `LatenessWindow` boundaries, negatives, untimed, empty windows | `plugins/mpegts-core/native/mrts/tests/` |
| `gst_mrlateness_element_test.py` | GStreamer dataflow | 300 ms injected lateness read back ± 5 ms; lists kept intact; `house` vs `running-time` with `base_time` 0 and ≠ 0 | `packages/engine/src/child-process/` |
| `houseClockPolicy.test.ts`, `HouseClock.test.ts`, `clockSource.test.ts` | Vitest | The decision table in WI-P0-4 with the settle rule; sidecar restart keeps E; 30 s timeout with fake timers; the four field captures replayed; samples reach the clock, not the log; the owner poll (chronyd first, re-polled on a step) | `packages/engine/src/clock/` |
| `Engine.test.ts` (extended) | Vitest | Module start awaits `ready()`; API up during the wait | `packages/engine/src/` |
| `latenessReporter.test.ts`, `timingSections.test.ts`, `moduleTiming.test.ts` | Vitest | Added latency, slowest input, render formula (reporter); labels, badge, change test (sections); publication tick, sink reads, PipeWire latency (ModuleTiming) | `packages/engine/src/plugins/` |
| `busRunnerContract.test.ts` (extended) | Vitest | `lat_*` names and the `mrlateness` branch present in both runner sources | `packages/engine/src/plugins/` |
| Protocol, native runner | Black-box | `mrlateness:<tap>` events from static and dynamic inputs; plugin loaded by path | `packages/engine/src/child-process/native_runner_protocol_test.py` |
| Protocol, python runner | Black-box | The same cases through `gst-pipeline-runner.py` (new `gst_lateness_protocol_test.py`) | `packages/engine/src/child-process/` |
| `unixfdFanout.test.ts`, `mr-tssplit` tests (extended) | Conformance | `lateness` key in stats lines | existing locations under `plugins/unixfdbus-core`, `plugins/ts-splitter` |
| `pipeWireLatency.test.ts` | Vitest | Parse a fleet `pw-dump` (MR_PW null sinks, runner streams; `fixtures/fixture-reduce.py`) | `packages/engine/src/audio/` |
| `aes67Helpers.test.ts` (extended) | Vitest | `rtpTimestampOffset()` against the deleted Python's vectors | `packages/engine/src/plugins/` (WI-P0-6) |
| `PtpConfig.spec.ts`, `TimeStatus.spec.ts`, `TimeConfig.spec.ts` | Vitest (DM) | A slave-only save stops chronyd, a master-capable one never names it; `chronyc -c -n` and `--once` parsing, synced by the engine's `isSynced`; server-list rendering and validation | device-manager `api/src/config/` |
| `PtpStatus.spec.ts`, `TimeStatusCard.spec.ts`, `PtpConfigPage.spec.ts` (new) | Vitest (DM) | `pmc -d` from `status.env` and `TIME_PROPERTIES_DATA_SET` parsing; the owner text and the `synced` badge; the Time source row (WI-P0-2b) | device-manager `api/src/config/`, `app/src/` |
| `media-router-chrony_test.py` | Shell harness under dash, BusyBox sh, bash `--posix` | The dispatcher (`onoffline`, fragments), the wait unit's warn-and-succeed, `makestep 1.0 -1` and `rtcsync` | `meta-layers/meta-custom/recipes-support/chrony/files/` |
| `mr-ptp-owner_test.py`, `media-router-ptp-setup_test.py`, `mr-ptp-settai_test.py`, `mr-ptp-tickcheck_test.py` | Python unit tests; the setup script under dash, BusyBox sh, bash `--posix` | The handover decisions, hold and backoff, what a grandmaster announces, the setup script's role block, `--no-override`, the tick check's total (WI-P0-2b) | `meta-layers/meta-custom/recipes-support/media-router-ptp/files/` |
| `EngineListItem.test.ts` (extended) | Vitest | 4 clock states, old engine | `packages/manager-ui/src/components/common/` |

**Fixtures captured on the fleet** (stored under
`packages/engine/src/clock/fixtures/`, `packages/engine/src/audio/fixtures/`
and the Device Manager's `api/src/config/fixtures/`, each set with its
provenance; the clock and Device Manager sets come from 10.9.16.50, a chrony
box, not the gate boxes):

| Fixture | What it pins |
|---|---|
| `clockstate-synced.jsonl` | 60 s of `mr-clockstate` on .50 with chrony synced: E constant within 10 µs, `tai = 37`. |
| `clockstate-offline-boot.jsonl` | The boot state of an RTC-less box (clock 18,521,000 s behind, TAI 0, NTP blocked), then the uplink: the `timeout` latch, then one `relatch(step)` for chrony's step, its TAI write and the sync, which came within 3 s. |
| `clockstate-tai-late.jsonl` | chronyd stopped, `tai = 0`, then `tai = 37` (the PTP setup path): no `step` line; E moves 37 s, is held for sync, and re-latches as `relatch(divergence)` at the 10 s cap. |
| `clockstate-date-step.jsonl` | The clock set 2 s ahead with chronyd stopped: a `step` line, giving `relatch(step)`, ΔE 2 s ± 1 ms. |
| `chronyc-{tracking,sources}-{synced,unsynced}.csv`, `clockstate-once-{synced,unsynced,tai0}.jsonl` | Device Manager: real `chronyc -c -n` output and `mr-clockstate --once` samples, synced and unsynced, plus a synced sample with the kernel TAI offset 0; where each was taken is in `api/src/config/fixtures/PROVENANCE.md`. |
| `pw-dump-fleet.json` | Node latency params for the PipeWire-graph modules, from fleet box 10.9.16.22 (provenance in `fixture-reduce.py`). |
| pmc 4.4 output in `mr-ptp-owner_test.py` | A field capture from 10.9.1.42 and captures from linuxptp 4.4 run in namespaces on the development Pi 5 (WI-P0-2b). |
| `TIME_PROPERTIES_DATA_SET` in `PtpStatus.spec.ts` | Printed from pmc 4.4's format string and linuxptp's defaults, not captured; replaced by the rig's T0/T1 captures (WI-P0-2b). |

No TS stream fixtures are needed. Phase 0 does not change stream timing.

### 8. Manager and UI

| Item | Change |
|---|---|
| Settings added | None on modules. The lateness alarm is deferred (OQ-8; note after part 13). |
| Settings removed | audio-decoder `clockSync` (OQ-4). No Q9 setting goes in Phase 0. |
| Settings disabled | None. |
| Module face | Lateness badge in ms, labelled: render lateness on outputs that render (`lat_render`), PipeWire latency on PipeWire-graph modules, the mean output lateness otherwise. |
| Module stats | A `timing` section with output lateness (mean, min–max), added latency, slowest input. For outputs, also decode, presentation delay (D, still in force), device latency and render lateness. One `timing-in-<n>` section per input. PipeWire-graph modules show PipeWire latency. |
| Dashboards and LCP | Get the same values with no change (status data and badges already flow). |
| Engine card and header | Clock indicator: traceable, waiting, untraceable or unsynced, with source, error, TAI−UTC and epoch. |
| Router tree | `/system/timeSync` (ADR-0024); module `statusData.timing`. |
| Device Manager | "PTP" page becomes "Time" (OQ-9). A Clock card (owner, synced, errors, TAI−UTC, frequency, chrony reference and sources) with an NTP **Servers** list, default the public pool, DHCP-offered servers shown beneath (OQ-6); on a grandmaster the owner reads "chrony (NTP), served over PTP". The PTP status and settings stay; the status gains a **Time source** row with the grandmaster's traceability (WI-P0-2b). The displaced-services logic is gone. |

### 9. Image and Yocto

| Recipe / file | Change |
|---|---|
| `build/conf/local.conf` | Remove `htpdate`; add `chrony chronyc tzdata-core`; `PACKAGECONFIG:remove:pn-systemd = "timesyncd"`. |
| `meta-layers/meta-custom/recipes-support/htpdate/` | Deleted. |
| `meta-layers/meta-custom/recipes-support/chrony/chrony_%.bbappend` (new) | Installs `/etc/chrony.conf` (WI-P0-1 text, `sourcedir` fragments), the default `sources` fragment, the NetworkManager dispatcher script for DHCP servers (with `chronyc onoffline`), the chronyd drop-in (`ConditionPathExists=\|!/data/ptp/ptp.env` or `\|/run/media-router-ptp/chrony.grant`, `RequiresMountsFor=/data`, `mkdir /data/chrony/sources.d`, default fragment copied when empty), and `media-router-chrony-wait.service` (enabled; warns and succeeds on timeout). |
| `meta-layers/meta-custom/conf/distro/media-router-distro.conf` | `VIRTUAL-RUNTIME_base-utils-syslog = ""`: no BusyBox syslogd, so journald keeps `/dev/log` (2026-10-14). |
| `meta-layers/meta-custom/recipes-support/media-router-ptp/` | Setup script stops chronyd on a slave-only box, starts it, waits and steps once on a master-capable one, and writes the TAI offset; new `mr-ptp-settai.py`; the ptp4l unit orders after chronyd. New `mr-ptp-owner.py` and `media-router-ptp-owner.service`; phc2sys `-n <domain> -S 1.0 --max_frequency=100000 -u 16`; `summary_interval 4`; the tick check alarms on the total (WI-P0-2b). |
| `meta-layers/meta-custom/recipes-core/base-files/base-files_%.bbappend` | Comment only (timesyncd no longer the reason for `/var/lib/private`; the directory stays). |
| `meta-layers/meta-custom/recipes-apps/media-router/media-router.bb` | No change. `mr-clockstate` and `libgstmrlateness.so` come through the existing `oe_runmake` native build and `native-install`. Check that `FILES` covers `/usr/libexec/media-router/engine/mr-clockstate` and `/usr/libexec/media-router/mpegts-core/libgstmrlateness.so`. |
| `meta-layers/meta-custom/recipes-apps/device-manager/` | App and API changes from WI-P0-12 (Time page, chrony status, the NTP server list); no recipe change. |
| Release | One RAUC bundle carrying the image and the app. The engine's start wait, the Device Manager's chrony status and the TAI offset all depend on the image, so the app must not ship to a box on an older image (see R-P0-7). |

### 10. Telemetry and alarms

| Signal | Where | Level |
|---|---|---|
| `clock: epoch latched seq=1 reason=start source=chrony tai=37 est=±… ms` | engine log → manager logs, router tree `/logs` | info |
| `clock: no time sync after 30 s (…) — starting untraceable` | engine log; `timeSync.traceable=false`; engine indicator amber or red | warn |
| `clock: re-epoch seq=n reason=sync\|step\|divergence ΔE=… ms` | engine log; `timeSync.epochSeq/Reason`; `aes67-output` restarts | info (`step`/`divergence` warn) |
| `clock: realtime step, E unchanged (ΔE=… µs)` | engine log | info |
| `clock: sync lost (source=…)` | engine log; `traceable=false`, E kept | warn |
| `clock: mr-clockstate missing — no epoch, modules start at once` | engine log; indicator red | error |
| Module lateness alarm | deferred by the owner (OQ-8); Phase 0 shows the numbers, labelled | — |
| `lateness instrument missing` | module `timing` section | info |
| `clock: ignored an unreadable mr-clockstate line: <first 120 characters>…` | engine log → manager logs, router tree `/logs` | warn, at most once a minute |
| mr-clockstate `sample`/`step` lines | not logged (data channel, `logStdout: false`); its stderr goes to the engine log | warn (stderr only) |
| `TAI offset set to N (was M)` | PTP setup journal | info |
| `chrony's leapseclist owns the TAI offset on a master-capable box; ignoring PTP_TAI_UTC_OFFSET=N` | PTP setup journal | info |
| `chrony synchronised`, `stepped the boot offset before ptp4l serves` | PTP setup journal, master-capable box | info |
| `WARNING: no NTP sync after 30 s — ptp4l starts anyway; the grandmaster announces not traceable until chrony syncs` | PTP setup journal, master-capable box | warn |
| `revoke: …`, `grant: …`, `adopt: …`, `chronyd exited N ms after the revoke`, `announce: timeTraceable …, timeSource 0x…` | journal, `media-router-ptp-owner`; `/run/media-router-ptp/owner.env` | info |
| `no PORT_DATA_SET from ptp4l for N s - keeping the last decision` | journal, `media-router-ptp-owner` | warn |
| `no NTP sync after 30 s - continuing unsynchronised; the clock will step when NTP is reachable` | journal, `media-router-chrony-wait` (priority warning) | warn |
| Kernel TAI offset 0 | Device Manager Clock card, red row; engine `taiOffsetS: 0`, `traceable=false` | warn |
| Grandmaster not traceable | Device Manager PTP card, Time source row ("Internal oscillator · not traceable") | info |

### 11. Verification on the test fleet

Run on 10.9.16.103 (Pi 5) and 10.9.16.108 (Pi 4) after the RAUC install,
before release. Tools: `mrssh`, `chronyc`, `mr-clockstate --once`,
`systemctl`, `journalctl`, the manager UI, `top`/cgroup CPU ticks (the
method in `gstmrtsstamp.cpp`'s header), and the existing gate profile.

| # | Measured | How | Pass |
|---|---|---|---|
| V1 | Daemons | `systemctl list-unit-files`, `is-active chronyd`, `chronyc tracking`, `systemctl status media-router-chrony-wait`, `ls -l /dev/log`, `logger` | No htpdate or timesyncd units. chronyd active and synced within 2 min of boot. `Leap status: Normal`. The wait unit succeeded (not failed) on a cold online boot; `/dev/log` points at journald's socket and a `logger` line appears in `journalctl`. |
| V2 | Kernel TAI offset under chrony | `mr-clockstate --once` after sync | `taiOffsetS == 37` on both boxes (an expired list is still applied: part 12 R-P0-2, answered from source). |
| V3 | E agreement between boxes | `mr-clockstate --once` on both, read from the manager host at the same moment; compare `TAI` readings (E + MONO) | Within 10 ms under chrony (NTP-class ε, §9.3). |
| V4 | Start wait, synced | Restart the engine unit | Modules start in < 2 s; log shows `reason=start`. |
| V5 | Start wait, offline | Boot .108 with its uplink disconnected (local console or an isolated switch port) | Engine indicator amber ~30 s, then `starting untraceable` at 30 s ± 1 s; modules run. The wait unit succeeded with its warning line. Uplink back: chrony syncs within ~10 s (`onoffline`); `re-epoch reason=sync` (or `step`) within 5 s of chrony sync; indicator green. |
| V6 | Step detection | `chronyc makestep` after `chronyc settime`, or with chronyd stopped `date -s "+2 sec"` | `re-epoch reason=step` logged within 1 s; ΔE = 2 s ± 1 ms; `aes67-output` (if configured) restarts once. |
| V7 | No false re-epochs | 24 h soak on both boxes | `epochSeq` unchanged after the start latch (or after V5's sync), no divergence events. |
| V8 | PTP owner | Enable PTP on .103 and .108 from the Device Manager as slave-only, then disable; the grandmaster cases are WI-P0-2b's rig, T0–T12 | Enable: chronyd inactive, ptp4l active, `tai == 37` before ptp4l lock and still 37 after 1 h; engine `source=ptp`, `traceable=true` (linuxptp clears `STA_UNSYNC`: R-P0-3, settled 2026-10-14). ptp4l (and phc2sys on hardware-timestamping boxes) logs one summary per 16 s; the Time page shows rms and path delay. Disable: chronyd active, one daemon only, no `displaced-time-services` file. Grandmaster: T0–T12 pass (T3 reads chronyd's exit time from the watcher's log, not from the namespace rig). |
| V9 | Lateness accuracy | Gate rig: a test producer whose stamps are mono − 500 ms (fixed, via the dataflow test's appsrc pattern run in a runner), feeding a pass-through consumer | Consumer input lateness 500 ms ± 5 ms in both runners (`MR_GST_RUNNER_NATIVE=0` and `=1`). |
| V10 | Added latency adds up | Gate profile route: ingest → transcoder → muxer → srt-output | Sum of added latencies along the route equals egress lateness − ingest output lateness within 5 ms (recomputed by hand from the stats modals). |
| V11 | Output lateness meaning | video-player and audio-decoder on the gate | Render lateness ≈ max(λ, D) + device; λ at sink rises by the injected delay when a 300 ms `queue min-threshold-time` is added upstream in a dev build. |
| V12 | CPU cost | cgroup CPU ticks per module, 10 min, before and after the release, gate profile on .108 (Pi 4) | ≤ 1 % of one core added per module, engine sidecar ≤ 0.2 % of a core. |
| V13 | Manager traffic | Manager socket bytes per second with the gate profile | ≤ 10 % increase over the previous release. |
| V14 | Device Manager | Time page on both boxes | Owner, sync, errors, TAI−UTC and the chrony sources match `chronyc` and `mr-clockstate --once`; a server-list edit shows in `chronyc sources` within 10 s. |
| V15 | Kill switch gone (OQ-4) | Drop-in `Environment=MR_TIME_SYNC_CONTRACT=0`, restart | No behaviour change; every runner logs the contract clock. |

### 12. Risks specific to this phase

| # | Level | Risk | Mitigation |
|---|---|---|---|
| R-P0-1 | M | **The engine is a user unit and cannot order on `time-sync.target`.** A box that boots offline starts every module 30 s late, at each engine start while unsynced. This is per the decision (§13.1, Q15). | The wait timer runs from engine start, not module start. The API and UI are up during the wait and show it. The release notes say so. |
| R-P0-2 | M | **`leapseclist` with an expired list.** The image's `tzdata` (2026b, `openembedded-core/meta/recipes-extended/timezone/timezone.inc:9`) ships a `leap-seconds.list` that expires no earlier than late 2026; a box not rebuilt by then runs with an expired list. If chrony ignored an expired list, the kernel TAI offset would stay 0 and the box would never become traceable (R2, §10.2). | Answered from chrony 4.8's source (2026-10-14): `leapdb.c:172` logs `Leap second list … needs update` and still applies the list, so the offset stays set; the `leapsectz right/UTC` fallback is not needed. V2 checks the value. |
| R-P0-3 | M | **linuxptp and kernel state.** That ptp4l and phc2sys clear `STA_UNSYNC` (`sysclk_set_sync`) and leave a hand-set TAI offset alone when the GM's UTC offset is not traceable is from training memory. If either is wrong, PTP boxes start untraceable or lose TAI. Role changes add cases (WI-P0-2b): a master-capable box hands REALTIME between chronyd and linuxptp by port state, and a slave takes the TAI offset from a traceable grandmaster's announcement. | Settled for slaves on 2026-10-14: V8 on .103 and .108 (1.4 h and 4.4 h of lock) read synced and TAI 37, so neither fallback is needed. For role changes, from the linuxptp source: outside SLAVE linuxptp's only kernel-status write is `sysclk_set_leap(0)` at a software ptp4l's start; it sets the TAI offset only from a traceable grandmaster, with that grandmaster kernel's own value; and chronyd's exit never zeroes TAI. Rig T3, T4 and T7 confirm it on boxes. |
| R-P0-4 | M | **chrony state on a read-only rootfs.** The drift file, the dump directory and the server-list fragment must be on `/data`. A missing `/data` mount starts chrony without its drift file (slower first lock) or without servers, or fails it. | `RequiresMountsFor=/data`; `mkdir` and the default-fragment copy in `ExecStartPre`; V1 after a cold boot. |
| R-P0-5 | L | **`TFD_TIMER_CANCEL_ON_SET` on a TAI-offset change.** It is not confirmed that `ADJ_TAI` fires `clock_was_set` on this kernel. | Settled 2026-10-14 on .50: no step line; the divergence path (`clockstate-tai-late.jsonl`, WI-P0-3's acceptance). |
| R-P0-6 | M | **Telemetry volume.** 30+ modules with per-input sections at 0.5 Hz add state patches on the WAN link to the manager (R14). | Change-only emission (≥ 1 ms), 2 s windows, the existing `StatePatchBatcher`; V13. |
| R-P0-7 | M | **Image and app skew.** The app's dist tarball is deployed to `/opt` independently of the image (project practice). An app with `HouseClock` on an old image finds no `mr-clockstate` and no chrony. | `HouseClock` degrades to "no epoch" and never blocks modules; the release is one RAUC bundle; deploy notes forbid hot-deploying the Phase 0 app onto an older image. |
| R-P0-8 | L | **The lateness tap changes pipelines.** One extra element per bus edge and output. A buffer-list mishandling would regress the ADR-0011 coalescing. | `chain_list` passthrough with a test (WI-P0-7); V12 measures CPU. The tap is omitted when the plugin is missing. |
| R-P0-9 | L | **Phase 0 lateness reads near 0 at ingests and is D-dominated at outputs.** Stamps are still arrival-anchored and sinks still wait for D. Operators may read it as "no latency". | The `timing` section labels presentation delay separately and shows render lateness as `max(λ, D) + device`. The release notes say the numbers become source-natural in Phase 1 and D-free in Phase 4. |
| R-P0-10 | L | **Slew bound.** `maxslewrate 100` makes a 50 ms correction take 500 s (R7). Outputs ride it; no stream mechanism changes in Phase 0. | OQ-5 answered 100 ppm; the value is a single config line. |
| R-P0-11 | L | **Removing the kill switch removes a field escape hatch** while the frozen current model still runs (R16). | Rollback is a previous release from the Device Manager (§13.1). |
| R-P0-12 | L | **A grandmaster handover has two short windows** (WI-P0-2b). In software mode ptp4l's first REALTIME write comes at least ~130 ms after UNCALIBRATED, and chronyd's exit can overlap it by one frequency write; each regain restarts chronyd, whose start sets `STA_UNSYNC`, so the grandmaster's engine reads `sync lost` for 2–8 s. | Accepted as bounded (ADR-0029); rig T3 counts the `System clock interference detected` lines, T4 times the blip. Engine hysteresis for the blip is a follow-up. |
| R-P0-13 | L | **A ptp4l restart on a master-capable box that follows a better master** (a settings save, or ptp4l's `Restart=`) starts chronyd, waits for NTP and steps to NTP time before ptp4l runs; the port then goes UNCALIBRATED, chronyd is revoked, and linuxptp steers the box back, stepping if more than 1 s off. If NTP and the domain differ by more than 1 ms, that box's engine re-epochs once, or twice if linuxptp steps back. | Inherent to the boot rule (chronyd first, then `makestep`); recorded for the owner, not changed. |
| R-P0-14 | L | **The tick check can alarm on a chrony grandmaster while chrony slews a large offset**: `maxslewrate 100` plus the crystal's own error passes the 100 ppm guard, e.g. when NTP comes back 0.5 s off after an offline boot (~1.4 h of slew). | The alarm is literally true then: MONOTONIC really runs that far off. Recorded, not changed. |
| R-P0-15 | L | **The setup script's `phc_ctl <phc> get`/`set` calls also go to syslog**, which now reaches the journal: 2 lines per ptp4l start. | Left as is; the watcher's 10 s `phc_ctl cmp` uses `-q` so it adds nothing. |

### 13. Open questions

| # | Question | Why the design doc does not answer it | Blocks | Proposed default |
|---|---|---|---|---|
| OQ-4 | In which phase are the `MR_TIME_SYNC_CONTRACT` kill switch and the legacy `clockSync` net-clock arm (with audio-decoder's `clockSync` setting) deleted? | *That* they go is decided: §4.1 makes `CLOCK_MONOTONIC` with `base_time = 0` unconditional ("the house clock stays what ADR-0005 decisions 3 and 5 made it") and §13.1 says "no engine-wide flag, no legacy arm". Only the phase is open: §14 row 0 does not list them, the doc never names `MR_TIME_SYNC_CONTRACT`, and they predate the design. Phase 0's lateness and E assume `base_time = 0` everywhere; with the switch off, `now − PTS` is meaningless. | WI-P0-5; the meaning of lateness on any box running with the switch off; V15 | **Phase 0.** |
| OQ-5 | chrony `maxslewrate`, in ppm? | §10.2 and R7 require a bound and name the directive, not the value. | WI-P0-1 config line | **100 ppm**, matching the PTP presets' `max_frequency 100000`. |
| OQ-6 | Which NTP servers, and does the Device Manager let a site set its own in Phase 0? | §10.2 requires a common traceable reference; it names no servers and no UI. | WI-P0-1 `pool` line; WI-P0-12 scope | **Fixed `pool pool.ntp.org iburst`**, no server field in Phase 0. |
| OQ-7 | May the kernel's `adjtimex` state stand in for "the daemon reports sync" (§10.2, §10.3)? | §10.2 names the daemon's state as the source ("synchronised or not, and the estimated error"). The plan reads the kernel instead (`STA_UNSYNC`, `tai`) as a daemon-neutral proxy that works under chrony and PTP alike, and reads `chronyc -c tracking` for display only. That is a deviation to confirm; no error bound is given either way. | WI-P0-4 `qualifies()`; V4, V5, V8; ADR-0029 | **Yes**: kernel `STA_UNSYNC` clear and TAI offset ≥ 10 s; the daemon's estimated error is shown, not gated; the proxy and why are recorded in ADR-0029. |
| OQ-8 | What is the default of the per-module lateness alarm setting (drafted as a threshold in ms)? | That Phase 0 ships the alarm is decided: §14 row 0 cites §9.5 in full, and §9.5 says "Alarms at thresholds the operator sets. They warn; they never drop content." No default value is given. | WI-P0-9 alarm; part 8 settings | **0 (off)**, one integer setting per module. |
| OQ-9 | Device Manager: rename the "PTP" page to "Time" (chrony and PTP on one page), or add a separate "Time" page? | §10 and §11.5 require sync state to be visible, but not where. | WI-P0-12 app layout | **Rename to "Time"**, `/ptp` redirects. |
| OQ-10 | Under PTP, is the TAI−UTC constant an operator setting? | §10.2 says the PTP setup writes "the configured TAI−UTC constant (37 s)" but not who configures it. | WI-P0-2 source of the value; WI-P0-12 settings | **No UI.** Read from the image's `leap-seconds.list`, fall back to 37; a hand-edited `PTP_TAI_UTC_OFFSET` in `ptp.env` overrides. Since 2026-10-14 the override is honoured on slave-only boxes only: on a master-capable box chrony's leapseclist owns the offset (WI-P0-2b). |

All seven were answered by the owner on 2026-10-12 (chapter 15.1): OQ-4
Phase 0; OQ-5 100 ppm; OQ-6 a server-list setting on the Time page,
default the public pool, DHCP-provided servers accepted as well; OQ-7 yes,
the error estimate shown, not gated; OQ-8 display only, no alarm; OQ-9 one
Time page with `/ptp` redirecting; OQ-10 no UI. The text above follows the
answers; no item waits.

The owner decided two more on 2026-10-14, for WI-P0-2b: the PTP election
stays on Priority alone, so sync state never changes the announced
clockClass ("Keep ptp priority only"); and the one re-epoch per engine on the
PTP boxes when 10.9.16.46 is imaged is accepted, in a window still to be
set. Recorded for the owner's veto, as engineering decisions of the same
day: `makestep 1.0 -1`, the removal of BusyBox syslogd, the grandmaster's
boot wait and `makestep`, the Time page's "x fast/slow of NTP time"
wording, and the WI-P0-2b choices ADR-0029 marks.

**Deferred by the owner (OQ-8, 2026-10-12).** Phase 0 shows lateness and
added latency on every module, with a label, and ships no alarm threshold:
the owner wants a feel for the numbers first. The option recorded for
later is a relative alarm — a warning when output lateness sits more than
500 ms above the module's settled lateness for 10 s — plus an optional
absolute cap per module; it would warn and never drop (§9.5). The setting
this plan had drafted, `latenessAlarmMs`, is not built in Phase 0.

### 14. Estimate

| WI | Added | Deleted | Days |
|---|---|---|---|
| P0-1 chrony in the image | 150 | 45 | 2 |
| P0-2 PTP setup | 75 | 70 | 0.75 |
| P0-3 `mr-clockstate` | 560 | 0 | 2.5 |
| P0-4 `HouseClock` | 850 | 0 | 3 |
| P0-5 Kill switch and legacy arm (OQ-4) | 60 | 800 | 2 |
| P0-6 aes67-output on E | 60 | 260 | 1 |
| P0-7 `LatenessWindow`, `mrlateness` | 600 | 0 | 3 |
| P0-8 Taps in runners, outputs, sidecars | 350 | 0 | 3 |
| P0-9 `LatenessReporter` (display only) | 340 | 0 | 2 |
| P0-10 PipeWire latency | 200 | 0 | 1 |
| P0-11 Manager UI clock state | 200 | 0 | 1.5 |
| P0-12 Device Manager | 750 | 230 | 3.5 |
| P0-13 Documents | 250 | 20 | 1 |
| P0-14 Gate verification | 0 | 0 | 2 |
| **Total** | **≈ 4,450** | **≈ 1,430** | **≈ 28.25** |

About 45 % of the added lines are tests. WI-P0-2b, added on 2026-10-14, is
outside these totals: it landed as about +2,600 / −180 lines, two thirds of
them tests.

**Critical path** (two engineers, ≈ 11.5 working days):

1. Lateness track: WI-P0-7 (3 d) → WI-P0-8 (3 d) → WI-P0-9 (2 d) →
   WI-P0-14 (2 d) = 10 d.
2. Clock track, in parallel: WI-P0-3 (2.5 d) → WI-P0-4 (3 d) → WI-P0-6
   (1 d), joining at WI-P0-14.
3. Image track, in parallel and needed by WI-P0-14: WI-P0-1 → WI-P0-2 →
   one image build (≈ 0.5 d wall time) → WI-P0-12.

WI-P0-5, P0-10, P0-11 and P0-13 fill the gaps. The single serialising step
is the RAUC image with chrony, `mr-clockstate` and `libgstmrlateness.so`,
installed on both gate boxes before V1-V15 run.

## 5. Phase 1 — Ingest restamp, captures on house time, ASRC at captures

| Field | Value |
|---|---|
| Chapter | 5, work-item prefix P1 |
| Implements | §14 row 1; §5.1–§5.5; P2, P4, P7; §11.3 item 6; §11.5 items 1, 4 (captures), 8 (ingest settings), 10 (ingest gaps) |
| Builds on | Chapter 3 (shared TS module, `libgstmrtshouse.so`, loaders) and chapter 4 (Phase 0: epoch E, `mrlateness` taps, `LatenessReporter`) |
| Code baseline | submodule `fc17468`; every path below was checked with `ls`/`grep` on 2026-10-12 |
| Paths | relative to the submodule unless marked "Yocto:" (relative to `/home/mrstation/media-router-yocto`) |
| References | "§n" is a section of the design doc (`docs/house-clock-timing-design.md` v0.6); "part n" is a part of this plan section |
| External sources read | gst-plugins-bad 1.28.2 `ext/srt/gstsrtsrc.c`, `gst/unixfd/gstunixfd.h`, `gst/unixfd/gstunixfdsink.c`; gst-plugins-base 1.28.2 `gst-libs/gst/audio/audio-resampler.{c,h}` (local copies under `/home/mrstation/mr-hevc/`) |

### 1. Goal

Phase 1 puts house time into the bytes at every place a stream enters the
engine (§14 row 1: "Ingest restamp (virtual STC) writing house time into the
bytes; ingests signal gaps; capture producers on identity egress;
video-encoder on house time; ASRC at captures"). The three TS network ingests
(rist-input, srt-input, mpegts-ip-input) gain a native element,
`mrtsrestamp`, that locks one virtual STC per program to the source PCR
(§5.1), rewrites every PES PTS/DTS and every PCR in place to house time with
source-natural landing (Q5), applies the ingest offset O and a per-PID trim
of ±2 s with the gap/drop live-edit rule (§5.5), re-locks on source
discontinuities without stepping the timeline (§5.2), falls back to a
degraded PTS lock with an alarm when the PCR is unusable (§5.3), and signals
gaps. The four capture producers (audio-input-302m, aes67-input,
audio-encoder, video-encoder) move to identity egress with PES carrying
capture time on the house timescale; the three PCM captures resample once to
the house rate through a new `mrasrc` element (P7). After this release every
producer that brings content into the engine emits `PES = house + 1 h`, its
bus stamp is the identity `PES − 1 h`, and the consumers' learned K becomes a
constant, so they keep working unchanged until Phase 3 removes the learning.

### 2. Design references

| Reference | What this phase implements |
|---|---|
| §5.1 | Virtual STC `S(h) = a·h + b` per program, b from the lower envelope of PCR arrivals, a from a slow loop; arrival as stamped on receipt; PES PTS/DTS and PCR rewritten in place; one mapping per program; source-natural landing. |
| §5.2 | Re-lock on restart, PCR discontinuity or rewind; house time never jumps; gap signalled; overlap dropped so PTS stays monotonic per ES; straddling PES mapped by "STC range" (tie-break undefined: OQ-11); no step leaves an ingest. |
| §5.3 | PCR validation (rate bound, freeze/leap, lead range, a steady PCR cadence, 2 s accepted: chapter 15.4 B-86); degraded mode locked to the reference PID's PTS; "degraded clock" warning; lead clamp. |
| §5.4 rows 1–5 | TS with and without usable PCR; PCM capture (device timing, ASRC); V4L2 capture (kernel timestamp, cadence follows source); AES67 (`ptpSync` opt-in, else Restamp on RTP time; ASRC). |
| §5.5 | O per ingest (default 0); per-PID trim ±2 s on top; positive edit inserts a gap, negative edit drops the overlap; measured lead min/median/max and trim per PID shown; talent loops set O by hand (Q11). |
| §6 item 4 ("absence is signalled") | Ingests signal gaps. |
| §9.5 | Ingest shows a negative output lateness (early by the lead). Phase 0's taps measure it; this phase adds the ingest-specific clock and lead display. |
| §11.1 rows rist/srt/mpegts-ip, aes67-input, audio-input-302m, audio-encoder, video-encoder | The target column, per module. |
| §11.3 item 6 | video-encoder's PES are running time since PLAYING, not house time (`liveCaptureClock`). |
| §11.5 items 1, 4, 8, 10 | Ingest restamp (virtual STC, PCR validation, degraded fallback, per-ES monotonic guard, offset); ASRC at PCM capture; ingest settings; ingest gaps. |
| §13.1 (2026-10-12) | Every phase a cut-over; current model frozen (Q2); one shared native TS module, no Python twin; source-natural landing (Q5); per-PID trim ±2 s (Q6); resample once where audio first becomes PCM (R5); talent loops operator-set (Q11); timing settings removed not migrated (Q9; none goes in this phase). |
| §13.3 | Virtual STC loop constants and PCR validation bounds (set from replayed captures); ASRC implementation (`GstAudioResampler` with scaled rates, or speexdsp/libsamplerate; measure on Pi 4). Both chosen in part 4.3 and part 4.5 and recorded in the timing ADR. |
| R4, R5, R12, R18, R19, R20 | PCR lock quality; ASRC cost; behaviour change; monotonicity at ingest; wrap; mixed fleet. |

### 3. Current state

#### 3.1 Network ingests

| Module | Pipeline string (where) | Source element timestamps | Egress today |
|---|---|---|---|
| srt-input | `plugins/srt-input/engine/SrtInputModule.ts:118–122`: `srtsrc name=src uri=… auto-reconnect=false[ keep-listening=true] ! queue leaky=2 max-size-time=100000000 flush-on-eos=true ! buildBusSink(port)` (142 lines; test 137) | **Not receipt.** gst-plugins-bad 1.28.2 `ext/srt/gstsrtsrc.c:183–258`: PTS = `clock − base_time − (srt_time_now − srctime)`, i.e. the sender's send time mapped to our clock; `do-timestamp` is FALSE (:283). | anchored + conditioner |
| rist-input | `plugins/rist-input/engine/RistInputModule.ts:127–130`: `mrristsrc name=ristsrc … ! queue leaky=downstream max-size-bytes=4194304 … ! buildBusSink(port)` (288 lines; test 498) | Receipt after librist's buffer: `plugins/rist-core/native/mrrist/gstmrristsrc.cpp:120,167` (`do-timestamp` TRUE). | anchored + conditioner |
| mpegts-ip-input | `plugins/mpegts-ip-input/engine/MpegTsIpInputModule.ts:198–203`: `buildNetUdpSrc(netsrc) [! rtpjitterbuffer ! rtpmp2tdepay] ! buildBackpressureQueue(jitterMs) ! buildBusSink(port)` plus a `tsprobe` appsink tap off the tee (:208–210) (290 lines; test 308) | udpsrc: receipt. RTP: the jitterbuffer's (slave-mode) PTS. | anchored + conditioner |

All three declare `liveUpdatableParams = ['playoutOffsetMs']` (route-head D,
ADR-0005 decision 4) at `SrtInputModule.ts:22`, `RistInputModule.ts:60`,
`MpegTsIpInputModule.ts:36`, with the setting in each `package.json`
(`srt-input:80`, `rist-input:130`, `mpegts-ip-input:68`). D stays until
Phase 4 (§11.4 "Route-head D"). No ingest has an offset or trim today (§5.5).

#### 3.2 Capture producers

| Module | Pipeline (where) | Time in the PES today | Egress today |
|---|---|---|---|
| audio-input-302m | `plugins/audio-input-302m/engine/AudioInput302mModule.ts:190–194`: `pipewiresrc target-object=<dev> … node.autoconnect=false ! audio/x-raw,channels=N … ! volume ! level ! build302mEncodeBranch ! buildBusSink` (capture clause :264–276; node latency clamped 40–85 ms at :261) (325 lines; test 430) | capture running time + 1 h (house, base 0) | anchored + conditioner |
| aes67-input | `plugins/aes67-input/engine/Aes67InputModule.ts:247–254`: `buildNetUdpSrc ! rtpjitterbuffer name=jbuf latency=… [rfc7273-sync=true …] ! <depay> ! audio/x-raw,rate=48000 ! build302mEncodeBranch ! buildBusSink` (319 lines; test 244) | jitterbuffer PTS + 1 h (with `ptpSync`: the sender's media clock mapped by RFC 7273) | anchored + conditioner |
| audio-encoder | `plugins/audio-encoder/engine/AudioEncoderModule.ts:164`: `pulsesrc device=MR_PW_<id>.monitor buffer-time=…`; `:190`/`:210`: `… ! avenc_aac\|opusenc ! mpegtsmux latency=0 alignment=7 ! buildBusSink`; `:225`: `conditionStepMs: 100` (228 lines; test 244) | pulsesrc running time + 1 h, re-stamped by whole rings (+190 ms steps, §11.1) | anchored + conditioner at a 100 ms threshold |
| video-encoder | `plugins/video-encoder/engine/videoEncoderPipeline.ts:70`: `v4l2src … do-timestamp=true`; `plugins/video-encoder/engine/VideoEncoderModule.ts:214–243`: `buildEncodeLeaf` (`packages/engine/src/plugins/encoderLeaf.ts:130`: `mpegtsmux … latency=0 alignment=0`) with `liveCaptureClock: true` (:242) (288 lines; test 602) | running time since PLAYING + 1 h (§11.3 item 6): base_time is natural, so PES ≠ house + 1 h | anchored + conditioner |

`build302mEncodeBranch` is
`plugins/audio-302m-core/engine/audio302mHelpers.ts:426–438`:
`audioconvert ! audioresample ! audio/x-raw,format=…,rate=48000,channels=N !
avenc_s302m strict=experimental ! mpegtsmux latency=0 alignment=7`. The
`audioresample` there is a fixed-rate converter; nothing in the tree measures
a device clock against the house clock (`grep -i "asrc\|speexdsp\|
libsamplerate\|GstAudioResampler"` finds no user).

`liveCaptureClock` is documented at
`packages/engine/src/plugins/PluginModule.ts:364–403`,
forwarded by `packages/engine/src/child-process/GstChildProcess.ts` (start
payload), and applied by
`packages/engine/native/mr-gst-runner/runner.cpp:201–207,314`
and `packages/engine/src/child-process/gst-pipeline-runner.py:1945–1994,2098`.

#### 3.3 Where the stamper and the conditioner are spliced

- `buildBusSink(port)` (`packages/engine/src/plugins/busHelpers.ts:228–234`) is
  `capssetter ! capsfilter ! tee name=busout_<port>`.
- Both runners splice one `mrtsstamp` per `busout_*` tee at the head of the
  egress chain, walking up from the tee through `capssetter`/`capsfilter`
  and stopping at the first other element: native
  `packages/engine/native/mr-gst-runner/stamper.cpp:82–176` (`egress_head`,
  `insert_elements`), Python
  `packages/engine/src/child-process/gst_stamp_native.py:89–175`.
  For the ingests the splice therefore lands between the leaky queue and
  `capssetter`, i.e. after the queue.
- The stamper arms lazily on a tee's first consumer edge
  (`stamper.cpp:270–288`, `gst_bus_stamper.py:237–265`). Arming passes
  `repair-latch`, `condition-step-ms` (only when > 0) and `house-timeline`.
- `mrtsstamp` (`plugins/mpegts-core/native/mrtsstamp/gstmrtsstamp.cpp`, 862
  lines) runs the conditioner when `repair-latch` is on and `house-timeline`
  is off (:427), then stamps (:453–470). `house_now = clock − base_time`
  (:253–261); the stamp is mapped back through the segment (:322–340).
- The arithmetic is `mrts::TimelineStamper`
  (`plugins/mpegts-core/native/mrts/ts_timeline.{h,cpp}`, 370 + 1,085 lines)
  and its Python twin `plugins/mpegts-core/py/ts_timeline.py` (1,394; test
  1,275). Identity mode is `TimelineStamper::stamp_house`
  (`ts_timeline.cpp:902–942`): first PES of the timing PID through
  `house_from_mux_pts`, a monotone staircase for PES-less buffers.
- Python fallback probe: `packages/engine/src/child-process/gst_stamp_probe.py`
  (225), lifecycle `gst_bus_stamper.py` (286), loader `gst_stamp_native.py`
  (234). Native glue: `stamper.{h,cpp}` (53 + 438).
- Description fields: `conditionStepMs` (`PluginModule.ts:350`, only user
  `AudioEncoderModule.ts:225`), `houseTimelineEgress` (`:355`, users
  transcoder, audio-transcoder, mpegts-muxer, teletext-subtitles),
  `latchRepair` (resolved by
  `packages/engine/src/plugins/latchRepair.ts:42–50`).
  Runner plumbing for `conditionStepMs`: `runner.cpp:329`,
  `gst-pipeline-runner.py:2123–2124`, `GstChildProcess.ts:255`.

#### 3.4 What happens to time at an ingest today

The anchored stamper anchors the egress on the arrival of the timing PID's
first PES at the tee (after the module's queues), then
`anchor + (PES − firstPES)`, defended by latch repair, the watch, the
staleness net, the late and early tiers and the drift servo; the conditioner
rewrites PES steps and regenerates every PCR as `PTS − 250 ms`
(`COND_PCR_LEAD_NS`, `ts_timeline.cpp:75`). The source PCR is never used for
clock or rate (§2 root cause 2). The bytes keep the source's timeline; the
bus stamp carries house time beside them.

#### 3.5 Gaps on the bus today

Nothing signals a gap. A GStreamer GAP event cannot cross the bus:
`unixfdsink` sends NEW_BUFFER, RELEASE_BUFFER, CAPS and EOS only
(gst-plugins-bad 1.28.2 `gst/unixfd/gstunixfd.h:32–35`; events handled at
`gstunixfdsink.c:742–770` are CAPS and EOS). A buffer's `pts`, `duration`
and `flags` do cross (`NewBufferPayload`, `gstunixfd.h`; set at
`gstunixfdsink.c:613`, restored at `gstunixfdsrc.c:386`). The native
sidecars write `flags = 0`
(`plugins/unixfdbus-core/native/libmrbus/fanout_server.cpp:235`).

#### 3.6 Consumers that must keep working in this phase

From the inventory (`02-inventory.json`) and the code: presentation legs and
transform producers demux with `tsdemux` in PCR mode and correct against the
bus stamp by branch alignment (`branch_align.cpp`, 440 lines; Python runner
`gst-pipeline-runner.py:1325–1832`) or by per-AU retime with K learned per
stamp epoch (`branch_retime.cpp`, 627; `branch_retime.py`, 439; log lines
"epoch #n K moved" at `branch_retime.cpp:217`); the 302M mixer branches latch
`tsdemux ignore-pcr=true` on their first PES; subtitle consumers learn K from
stamp rises (`plugins/subtitle-core/py/subtitle_stamp_model.py`,
`StampModel.observe`, and `mrpeshouse`). Presentation is at `stamp + D`
(`DEFAULT_PLAYOUT_OFFSET_MS = 60`,
`packages/engine/src/plugins/playoutOffset.ts:31`);
the video player's post-demux ES queue is `leaky=2` with a 1 s floor
(`plugins/video-player/engine/helpers/pipelines.ts:426–427`); the bus ingress
queue is leaky 5 s (`busHelpers.ts:180,193`). All of it is frozen (Q2).

### 4. Target state

#### 4.1 Pipelines after the cut-over

| Module | Pipeline (changes in bold) | Egress |
|---|---|---|
| srt-input | `srtsrc … ! **mrtsrestamp name=restamp clock-mode=stc arrival=clock offset-ns=… pid-trims=…** ! queue leaky=2 … ! buildBusSink` | identity |
| rist-input | `mrristsrc … ! **mrtsrestamp name=restamp …** ! queue leaky=downstream … ! buildBusSink` | identity |
| mpegts-ip-input | `netsrc [! rtpjitterbuffer ! rtpmp2tdepay] ! **mrtsrestamp name=restamp …** ! backpressure queue ! buildBusSink` (+ tsprobe tap unchanged) | identity |
| audio-input-302m | `pipewiresrc … **node.loop.class=data.rt** … ! volume ! level ! audioconvert ! **mrasrc name=asrc** ! audio/x-raw,format=S32LE,rate=48000,channels=N ! avenc_s302m ! mpegtsmux ! **mrtsrestamp name=restamp clock-mode=fixed offset-ns=…** ! buildBusSink` (the node on the runner's RT data loop, chapter 15.4 B-88) | identity |
| aes67-input | `netsrc ! rtpjitterbuffer … ! depay ! audioconvert ! **mrasrc name=asrc** ! audio/x-raw,format=…,rate=48000 ! avenc_s302m ! mpegtsmux ! **mrtsrestamp clock-mode=fixed** ! buildBusSink` | identity |
| audio-encoder | `**pipewiresrc target-object=MR_PW_<id> node.loop.class=data.rt stream.capture.sink=true …** ! audioconvert ! **mrasrc name=asrc** ! audio/x-raw,rate=<sampleRate>,channels=N ! volume ! level ! queue … ! avenc_aac\|opusenc ! mpegtsmux ! **mrtsrestamp clock-mode=fixed** ! buildBusSink` (OQ-16; the node on the runner's RT data loop, B-88) | identity |
| video-encoder | `v4l2src … ! … ! mpegtsmux name=mux latency=0 alignment=0 ! **mrtsrestamp clock-mode=fixed add-base-time=true** ! buildBusSink`, `liveCaptureClock` kept | identity |

Every one of the seven sets `houseTimelineEgress: true` on its description,
so `mrtsstamp` at the tee stamps by identity and never conditions. The
anchored stamper, the conditioner and their twins still exist, because
mixers, audio-processing, the splitter and the HLS fan-out use them until
Phase 2 deletes them (§14 row 2).

`mrtsrestamp` sits directly after the transport element (after the
depayloader for RTP) and before any queue, because it reads arrival itself:
`arrival=clock` reads `gst_clock_get_time − base_time` at chain entry, on
the source's streaming thread. That is the instant the transport hands the
packet over, after its recovery buffer (librist buffer, SRT TSBPD, RTP
jitterbuffer), which is what §10.4's transit check later assumes ("arrival −
emission ≤ L + τ"). It is not srtsrc's buffer PTS, which is the send time
(part 3.1). OQ-19 (decided 2026-10-12) records the wording correction, and
the design doc's §5.1 now reads this way. The output
buffers keep their input PTS (so the time-bounded leaky queue after it still
measures arrival spacing); the bus stamp is written later by `mrtsstamp` at
the tee.

#### 4.2 The restamp, as a data path

Built on chapter 3's API (`ts_house.h`, `ts_packet.h`, `ts_pes.h`,
`ts_pcr.h`, `ts_psi.h`); nothing below redefines it. Per input buffer:

1. `PacketWalker::feed` (mutable view) → per packet `CcTracker::feed`.
2. PAT/PMT packets → one `PsiDiscovery` per program (`select_program(n)` for
   every program in the PAT); a `generation()` bump rebuilds that program's
   PID table (stream type, `registration_format`, PCR PID).
3. Packet on a program's PCR PID with `af_pcr` → `read_pcr` →
   `VirtualStc::feed_pcr(pcr27, af_discontinuity, arrival)` → rewritten with
   `write_pcr(ns_to_pcr27(house_pcr))`.
4. Packet with `pusi` on an ES PID → `parse_pes_header` (or `PesHeaderSpan`
   when `!complete`) → `Unwrapper::feed(pts, seed = current source STC in
   90 kHz)`, `feed_dts` → `VirtualStc::map(pid, pts_unwrapped, arrival)`
   returns house ns and the mapping epoch → `+ shift(pid)` → per-ES
   monotonic guard → `mux_pts_from_house` → `rewrite_pes_timestamps`.
5. Packets of a PES the guard rejected are removed (PCR-carrying packets are
   kept as adaptation-only packets, which never advance CC), and the CC of
   that PID's later packets is renumbered so the output stays continuous.
6. Gap markers (part 4.4) are pushed before the buffer that follows the gap.

`clock-mode=fixed` skips steps 3's STC and 4's mapping: house = `PES − 1 h`
as received (`house_from_mux_pts`), plus `base_time` when `add-base-time`
is set, plus the shift; PCRs move by the same constant. It is how the four
capture producers get O, the gap/drop live edits and gap markers without a
second implementation.

#### 4.3 The virtual STC estimator (§13.3 choice, R4)

Notation. A PCR sample k gives source time σ_k (ns, from the unwrapped 27 MHz
PCR via `pcr27_to_ns`) and arrival h_k (house ns). The model of the earliest
possible arrival is `h = (1 + ε)·σ + β`. This is §5.1's `S(h) = a·h + b`
inverted: `a = 1/(1 + ε)`, `b = −β/(1 + ε)`. The mapping of any source
timestamp is `house(σ) = (1 + ε)·σ + β`, so a PES lands where the PCR equal
to its PTS arrived (or would have) at minimum delay: arrival plus the
source's lead, i.e. source-natural.

Two stages, in a portable class `mrts::ClockLock` (no TS knowledge; reused by
`mrasrc`), wrapped per program by `mrts::VirtualStc`:

| Stage | Rule | Constant (initial) | Why |
|---|---|---|---|
| Bucket minima | Per bucket of house time, keep the sample with the smallest `d = h − σ` | `bucket_ns` = 1 s (10+ PCRs) | Delay is one-sided; the minimum per second is the cleanest point. |
| Rate ε (slow loop) | Least-squares line through the bucket minima of the last N buckets of one floor level, refit once with points more than 2 MAD above the line removed; ε_applied follows the fit by a first-order loop. A bucket more than `step_ns` off the fit's level opens a candidate level; a candidate that holds for `step_hold_ns` replaces the fit's level, and the fit restarts on it (`has_fit()` is false until `rate_buckets_min` buckets of the new level, ≈ 30 s); a candidate that ends sooner (a burst or a dip) stays out of the fit (2026-10-14, chapter 15.4 B-2) | N from `rate_buckets_min` = 30 growing to `rate_buckets_max` = 300 (5 min); `rate_tau_ns` = 120 s (WI-P1-6; draft 60 s, chapter 15.4 B-36); `rate_warn_ppm` = 100; `rate_max_ppm` = 1,000; the level rule reuses `step_ns` and `step_hold_ns` and has no constant of its own | MPEG allows ±30 ppm; an NTP-slewed source moves up to 500 ppm (R4); minutes of fit average away jitter while still following a slew within a minute. Without the level rule a delay step inside the window bent ε: a −100 ms fall degraded the program on the rate row with no recovery, and a +150 ms rise left ε near 1,000 ppm. |
| Offset β (lower envelope) | β* = min over the last M buckets of `d_j − ε_applied·σ_j`; β_applied slews toward β*. In the lock's first epoch, when its first two buckets agree within `step_ns` on a floor more than `step_ns` below the line, the line moves onto it at their close and the overlap already sent is dropped once (WI-P1-6, chapter 15.4 B-37); while the bucket minima keep falling (a backlog draining) the first epoch tests again at every close until a pair agrees, or rises (a dip passed: nothing moves), and in any epoch two buckets agreeing on a floor more than `backlog_ns` below the line move it (chapter 15.4 B-45) | M = `offset_buckets` = 10; `slew_acquire_ppm` = 2,000 for `acquire_ns` = 5 s, then `slew_track_ppm` = 20; `backlog_ns` = 490 ms, `leap_ns` less the acquire slew's 10 ms after a relock (`mrasrc`: off; chapter 15.4 B-47, B-48) | Fast enough to settle in seconds at start; afterwards the PTS spacing is distorted by ≤ 20 ppm, far inside any decoder's tolerance, and no PTS ever steps. A transport's start burst (an SRT or RTP backlog, up to 0.5 s measured) is beyond what the acquire slew removes before the lock (70 ms), hence the first-epoch move. A reconnect's backlog relocks once it passes `leap_ns`, and `backlog_ns` lies the acquire slew's 10 ms under it, so no such backlog stays on its seed (at 500 ms, as `leap_ns`, one within those 10 ms stayed about 0.5 s early); the bursty encoder's dips (its line moves at 420 ms, not at 430) and a gate PES envelope's (485–490 ms) stay under it, 490 ms clearing both by 0–5 ms on today's traces (B-47; the owner's choice, B-48). |
| Envelope step | The bucket minima stay more than `step_ns` above the mapping for `step_hold_ns`: the minimum delay rose (a re-route), so re-lock (part 4.4) instead of slewing. One-sided at a TS ingest: a fall is slewed. `ClockLockConfig::step_falls` makes it two-sided, which only `mrasrc` sets (part 4.5). Either way the step's size is the run's minimum, since delay is one-sided (2026-10-13, P1-1; chapter 15.4 B-3) | `step_ns` = 20 ms, `step_hold_ns` = 10 s, `step_falls` = false (`mrasrc`: 50 ms and true, `asrc_lock_config()`) | A re-route is a discrete event; slewing 20 ms at 20 ppm would take 17 min. A rise makes content late. A fall at an ingest only leaves content earlier than needed, and stepping onto it would drop the overlap with what was already emitted. |

Telemetry (per program, every `stats-interval-ms` = 2 s): state
(`acquiring|locked|degraded|lost`), `ppb` (ε × 10⁹), `offset-drift-ns`
(β_applied − β at lock: how far the minimum delay has wandered), residual
`r_k = h_k − house(σ_k)` min/p50/p99/max over the window (min ≈ 0 when
healthy; a negative r means the mapping lies later than the arrival, i.e.
added latency, not lateness: a PES arrives after its house PTS only when r
exceeds its source lead, PTS − PCR; corrected 2026-10-13, chapter 15.4
B-6), max PCR interval, the PCR's own cadence and the longest late interval
of the last minute (chapter 15.4 B-86), relock count; and per PID the lead
`house(PTS) − arrival(PES header)` min/median/max over 10 s, with the trim
and total shift in force (§5.5).

**PCR validation (§5.3).** `mrts::PcrValidator`, per program, initial bounds:

| Check | Fails when | Constant |
|---|---|---|
| Cadence | The PCR judged against its own cadence (chapter 15.4 B-86, the owner's decision of 2026-10-22): the cadence is the longest of the last 8 intervals the source timed itself (PCR time; no flag, leap or outage; within the cap); an interval is late past twice it, never under 500 ms nor over 4 s (the threshold while the cadence is unknown); three late crossings in 60 s while packets keep arriving fail, one fails a program that has had no PCR (or none since its PCR PID changed); one or two raise the warning. A steady sparse PCR (vMix: every 2 s) locks and shows healthy; a PCR that stops degrades within 1.5 s (dense) to 12 s (a 2 s PCR; the lock reads lost at 5 s) | `pcr_interval_fail_ns` = 500 ms (the floor), `cadence_factor` = 2, `pcr_interval_cap_ns` = 4 s, `cadence_intervals` = 8, `cadence_fail_count` = 3 in `cadence_fail_window_ns` = 60 s |
| Rate | \|ε_fit\| > `rate_max_ppm` for 30 s | 1,000 ppm |
| Freeze | three consecutive PCRs with `Δσ < Δh / 2` and `Δh ≥ 30 ms` | — |
| Leap | `\|Δσ − Δh\| > 500 ms` between consecutive PCRs without `discontinuity_indicator`: one leap re-locks; three in 60 s fail | `leap_ns` = 500 ms (WI-P1-6; draft 250 ms, which read the gate egress's delivery stalls as leaps, chapter 15.4 B-38) |
| Lead | a PID's 1 s median stream lead (its PTS, DTS for video, less the program's last PCR) below −200 ms, or its 1 s median lead against arrival above +4 s, for 5 s. The lower bound reads the stream's own lead, which no delivery moves: on arrival it read a bursty path as a PCR fault (chapter 15.4 B-90) | `lead_min_ns`, `lead_max_ns` |

A failure moves the program to **degraded**: the same `ClockLock` is fed
`(σ = reference PID PTS, h = arrival of its PES header)`, where the reference
PID is the PCR PID if it carries PES, else the first video PID, else the
first audio PID. Its lower envelope lands the reference PID at its earliest
arrival (lead 0), which is the clamp §5.3 asks for (#820's 12.6 s lead
disappears). Any other PID whose lead under this mapping exceeds
`lead_clamp_ns` (4 s, under the 5 s bus ingress queue) gets its own
envelope (lead 0) and a `lead-clamp` event (as built, chapter 15.4 B-45: the
event names the PID and its lead, comes again every 30 s while the clamp
holds, and the clamp holds until the program recovers). In degraded mode the output PCR
is regenerated as the lowest recent written PTS of the program minus 250 ms
(today's conditioner rule, known to suit every consumer), written into the
packets that carry the source PCR. Return to PCR lock needs 30 s of PCR that
passes every check, read as 30 s in which no check failed: an observation restarts
that clock only where its row fails (its count or its hold reached), so a jittery
delivery's single frozen pair or short excursion does not hold the program degraded
(chapter 15.4 B-90); then a re-lock with a `recovered` event, and the windowed counts
(late crossings, leaps) start afresh (chapter 15.4 B-86).

**A caller's backlog is stale (chapter 15.4 B-39, B-45).** A caller that
queues while its listener is away sends the queue at once when it returns,
and the lock seeds the epoch on its oldest sample: the floor then falls by
the backlog. While the live line lies more than `lead_max_ns` above the
floor its open and last closed bucket show, or more than `backlog_ns` above
it (a backlog's, which the floor rule moves at the next agreeing pair) and
would put the PES more than `lead_max_ns` ahead by its doing (the lead less
that floor gap within `lead_max_ns`), what it maps is stale (B-47, B-48).
Nearer the floor the gap is jitter, or a fall the slew has not caught up
with, so a PID past `lead_max_ns` there, as one further ahead anywhere, is
the source's: the lead row's and the clamp's. A stale PES is dropped and
counted as overlap (its run's event says `backlog`), its lead stays out of
the lead row, so a drain, however slow, does not degrade the program, and
the written PCR follows arrival less 250 ms, never back, flagged at both
switches. The line moves onto the floor once two buckets agree on it (the
first epoch's rule, or `backlog_ns` in any epoch); the first PES of a PID
that shows a hole after the stale run carries a gap marker, reason
`backlog`. A reconnect then plays at most `lead_max_ns` of the backlog (on
the decode key: a video PTS lies up to its reorder delay later) and loses
2–3 s of the live content, the two buckets the line waits for after the
drain. A backlog under `lead_max_ns` is not stale, but for what the seed
would put past it: the line moves once two buckets agree (after a relock,
past `backlog_ns`), and up to about twice its length of live content goes,
the guard's drop of what left on the seed, as at a start burst, and before
it, after a relock, the drain's tail, which the straddle rule maps onto the
old epoch under what the new one already sent (its hole is signalled, part
4.4); the written PCR's step back there, or onto a straddler's epoch,
carries `discontinuity_indicator` (B-47, B-48).

**How the constants are set from replays (§13.3).** The tuning is an offline
sweep (WI-P1-6) of `mrts_cli restamp-replay --sweep` over the field traces and
synthetic traces of part 7.2, on a grid of `bucket_ns` ∈ {0.5, 1, 2} s,
`offset_buckets` ∈ {5, 10, 30}, `rate_tau_ns` ∈ {30, 60, 120} s,
`slew_track_ppm` ∈ {10, 20, 50}, `step_ns` ∈ {10, 20, 50} ms. A set passes when,
on every trace: relocks equal the trace's expectation (zero on the clean ones);
residual min ≥ −1 ms after acquisition; on the synthetic drift traces (±50,
±500 ppm) the rate error reaches ±0.5 ppm by 300 s on the median trace and
by 600 s on the worst (revised 2026-10-13: the draft's "within 60 s" cannot
be met under WI-P1-1's delay model; chapter 15.4 B-5); and the mapping
never moves faster than 20 ppm after acquisition. The most conservative
passing set (longest windows) ships; the table and the sweep output go in
the timing ADR. As run (2026-10-16, chapter 15.4 B-36): 36 of the 243 points
pass, all at 1 s buckets; the set shipped is the draft's but for `rate_tau_ns`
120 s, with M at 10 rather than the longest 30, which degrades or widens gaps
on the jittery field sources; the lock time of WI-P1-1 (40 s) is applied as
a criterion too.

#### 4.4 Discontinuities, gaps, overlap, live edits

- **Re-lock triggers:** `discontinuity_indicator` on a PCR; a leap; a PCR
  PID change in the PMT; an envelope step. An outage (no packets for ≥ 1 s)
  followed by data is **not** a trigger by itself: the first post-outage
  PCR is run through the leap check against the existing mapping; if it
  passes, the epoch is kept and only the gap is emitted (§5.2: a sending
  engine on this design causes no re-lock when it restarts, because its
  PCR is house time and continues); if it fails, re-lock. A re-lock starts
  a new mapping epoch: ε is kept as the
  starting guess (same source crystal in the common case), β is re-acquired
  from the first bucket with the acquisition slew. House time never jumps.
- **Gap.** For each PID, if its first PES under the new epoch lands after
  the end of what it last emitted, the difference is a gap; a gap marker is
  pushed (OQ-12). The same holds for its first PES after a live edit, an
  outage or a backlog's stale run (part 4.3; reasons `edit`, `outage`,
  `backlog`), and for its first PES on another epoch than its previous
  PES's, kept or dropped, that leaves a hole of a PES or more: a straddler
  back from a run dropped on the old epoch, a clamped PID back on the
  program's at recovery (reason `epoch`; chapter 15.4 B-48). Each gap event
  is timed by that PES's arrival, as an overlap is. A gap of ≥ 1 s also
  sets `discontinuity_indicator` on the first rewritten PCR after it
  (`set_discontinuity_indicator`), because Phase 1–2 consumers still run
  `tsdemux` in PCR mode and would otherwise read a PCR jump as an error
  (engineering choice, recorded in the ADR). So do every other break of
  the written PCR's timeline: an outage, a re-lock, the PCR written on
  another epoch's line or with another shift, its switch between mapped
  and regenerated, a step back. A source's own PCR spacing is none: a PCR
  every 2 s is no gap (2026-10-22, chapter 15.4 B-84).
- **Overlap.** A PES whose house DTS-or-PTS is not after its PID's last
  emitted value is dropped (R18). Video compares DTS (decode order); a PES
  without DTS compares PTS. A dropped run is counted (`dropped-ns`) at the
  PID's learned PES spacing; before the PID has learned it, at each dropped
  PES's own source spacing from the PID's previous PES (DTS for video, else
  PTS; a spacing ≤ 0 or over 1 s counts 0). Measured: an O edit of −300 ms
  60 ms into a stream counts 280, 288, 300 and 280 ms on video, audio 1,
  audio 2 and teletext. A duplicate of a held split-header PUSI packet
  (part 4.2 step 4) is dropped alone; the original still joins its
  continuation and the PES is kept (2026-10-14, chapter 15.4 B-9).
- **Straddle (§5.2).** Each epoch keeps its source range
  `R = [first PCR − 1 s, last PCR + 4 s]`. A PES in exactly one range
  uses that epoch; in neither, the newest; in both, the epoch whose lead
  for this PES is closest to the PID's median lead before the re-lock
  (OQ-11, decided 2026-10-12; the design doc's §5.2 now carries the
  tie-break). Ranges older than 10 s are discarded. Refined 2026-10-14
  (chapter 15.4 B-1): the lead tie-break is for real timeline jumps only.
  An epoch closed by an envelope step leaves the straddle, because the
  floor moved, not the timeline; and a range that maps the PES within
  `step_ns` of a newer range holding it gives way to the newer one (one
  timeline, such as a same-clock PCR PID change). Left to the tie-break,
  delay jitter flipped PIDs between such epochs: a +100 ms delay ramp over
  30 s dropped 1.3 s of audio, +500 ms over 60 s dropped 5–6 s.
- **Live edits of O or a trim** (property change, no restart): per PID the
  new shift applies from that PID's next PUSI. A positive change leaves a
  gap (marker pushed); a negative change makes the guard drop the overlap.
  The PCR follows `min(0, smallest shift in the program)`, so `PTS − PCR`
  never shrinks below the source's own lead; a change of that value is a
  PCR discontinuity, flagged.
- **Wrap (R19).** σ and PTS are unwrapped continuously (`Unwrapper`, seeded
  from the program's STC); output is `mux_pts_from_house` modulo 2³³; the
  bus side wraps with local uptime, as `house_from_mux_pts` expects (§4.4).

#### 4.5 ASRC at PCM captures (P7, R5, §13.3 choice)

`mrasrc` is a `GstBaseTransform` (not in place, like `audioresample`) in
`libgstmrtshouse.so`. Per input buffer it feeds `mrts::ClockLock` with
`(σ = input frame index / nominal rate, h = buffer PTS)`; the PTS under the
contract is the capture time on `CLOCK_MONOTONIC` (pipewiresrc, the
jitterbuffer). The lock gives the device-vs-house rate ε and the capture
instant of frame 0. The output is a continuous house-rate sample counter,
`PTS_out(m) = T0 + m / out_rate`, so sample count and PTS agree exactly on
the bus (P7). A phase servo (`mrts::AsrcServo`) compares the input frames
actually consumed with the frames the lock predicts and commands the ratio
`ε_cmd = ε + phase_err / 10 s`, clamped to ±1,000 ppm.

**Resampler: `GstAudioResampler` with scaled rates.** gst-plugins-base
1.28.2 `gst_audio_resampler_update` (`audio-resampler.c:1473–1530`) takes
new integer rates without a reset and carries the filter phase across.
With `in_rate = round(fs_in·1000 / (1 + ε_cmd))` and `out_rate =
fs_out·1000`, the ratio resolution is 1/48,000,000 (0.02 ppm). Kaiser
method, interpolated filter (the resampler selects it for such rates,
`audio-resampler.c:1125–1137`; as built `mrasrc` forces it, chapter 15.4
B-22), cubic interpolation,
`GST_AUDIO_RESAMPLER_OPT_MAX_PHASE_ERROR` = 0.05. It is in
`gstreamer-audio-1.0`, already a build and runtime dependency, so no recipe
changes. speexdsp (`speex_resampler_set_rate_frac`; recipe
`openembedded-core/meta/recipes-multimedia/speex/speexdsp_1.2.1.bb`) is the
measured alternative if the Pi 4 bench (WI-P1-8) misses the budget. One
resampler per path: `mrasrc` replaces the fixed-rate `audioresample` in the
capture branches and converts the nominal rate too (e.g. 44.1 kHz device to
48 kHz bus), so nothing resamples twice (§13.1).

Re-lock: an input DISCONT, or an envelope step past 50 ms either way (a
PipeWire quantum or latency change, an xrun, a restart). The ASRC's lock is
two-sided (`step_falls`, part 4.3): a capture labelled on its floor is late
by any fall. On an envelope step the lock moves at once onto the floor of
the step's own buckets (`ClockLock::step_to_floor`) and stays locked; it is
not re-acquired from one jittered PTS. The new T0 is never before the end
of the last output. A rise leaves a forward PTS jump (a gap), which the
downstream `mrtsrestamp clock-mode=fixed` turns into a gap marker (forward
PTS jump > 2 frame durations on an audio PID; on a video PID, a hole of 1 s
or more, chapter 15.4 B-89). A fall, or a DISCONT whose PTS steps back,
drops the input captured before that end
(`AsrcServo::Command::skip`, at most `DROP_MAX_NS` = 1 s; the rest is
slewed by the ratio), so labels stay the capture time. Steering still only
moves the ratio; the drop is a relock action, like the ingest's overlap
rule (R18). The TS-ingest STC keeps the one-sided step: a fall there only
adds headroom. Why the drop (2026-10-14, chapter 15.4 B-4): T0 never goes
before the end of the last output, and inside the ±1,000 ppm clamp a
slew takes about 2 min for 60 ms and 5 min for 200 ms, all of it with
late labels. Measured: a −60 ms and a −200 ms fall each give one relock
9–10 s after the step, no PTS jump, 59.935 and 199.928 ms dropped, and
labels within one frame of capture time from the relock.

#### 4.6 video-encoder

`liveCaptureClock` stays: its base time is natural to avoid the measured
aggregator mis-schedule (`PluginModule.ts:364–403`). `mrtsrestamp
clock-mode=fixed add-base-time=true` after the mux adds the pipeline's base
time to every PES PTS/DTS and PCR, so PES = capture time on the house
timescale + 1 h (§11.3 item 6, the "constant base-time correction" option of
§11.1). The identity stamp must then be base-aware: `mrtsstamp` and the
Python probe compute `house = house_from_mux_pts(pts, clock_now)` and write
the position for running time `house − base_time` (today they unwrap against
`clock − base_time`, which is off by the base time and, past 13 h of uptime,
by a 2³³ period). For every base-0 pipeline the result is unchanged. Fixing
the aggregator schedule instead, which would let `liveCaptureClock` go, is
recorded as the alternative in the ADR and not attempted here.

#### 4.7 Identity stamper changes (kept code, minimal edits)

- Buffers flagged GAP pass through `mrtsstamp` (and the Python probe)
  untouched: their PTS (the gap's end) and the adaptation-field private
  data of their packets (the gap's length) are the gap marker (OQ-12).
- Base-aware identity (part 4.6).
- `condition-step-ms` and its plumbing are deleted (part 6).

#### 4.8 What the operator gets

- Network ingests: Ingest Offset (O) and Per-PID Trim (±2 s) settings, both
  live; a Clock status section and badge; per-PID lead and trim rows; a
  degraded-clock warning.
- Capture producers: Ingest Offset (O), live (§5.5, §11.1); a Clock section with
  the ASRC ratio for PCM captures.
- Every producer's lateness (Phase 0 taps) is now meaningful: network
  ingests read negative (early by the lead), captures read their capture
  latency.

### 5. Work items

Ordered by dependency. Estimates are lines at this repo's comment density
(±40 %) and engineer-days including review.

#### WI-P1-1 `mrts::ClockLock`, `PcrValidator`, `VirtualStc`

- **What.** The estimator of part 4.3 and the validation of §5.3, portable
  C++17.
- **Where.** New `plugins/mpegts-core/native/mrts/ts_stc.{h,cpp}`; tests
  `plugins/mpegts-core/native/mrts/tests/ts_stc_test.cpp` (the `check.h`
  harness).
- **How.** `struct ClockLockConfig` with every constant of part 4.3 as a field
  and the initial values as defaults. `class ClockLock { void feed(int64_t
  remote_ns, int64_t arrival_ns); Phase phase() const; int64_t house_of(int64_t
  remote_ns) const; int64_t ppb() const; Residual residual() const; bool
  envelope_step() const; void relock(bool keep_rate); }` with integer
  arithmetic (ε in ppb, β in ns) so a replay is bit-exact across machines.
  As built: `ClockLockConfig::step_falls` (the per-lock envelope-step
  direction, part 4.3), `ClockLock::step_to_floor()` (for `mrasrc`, part
  4.5), and `has_fit()`, false from a level adoption until the new level
  has `rate_buckets_min` buckets (measured: false from 129.1 s to 158.1 s
  after a −100 ms fall at 120 s), so the validator's rate row and
  `mrasrc`'s out-of-bounds check never read a fit of the old level.
  `class PcrValidator { Verdict feed_pcr(int64_t pcr27, bool di, int64_t
  arrival); void feed_lead(int pid, int64_t lead_ns); Reason reason() const; }`.
  `class VirtualStc { void feed_pcr(...); void feed_ref_pes(int pid, int64_t
  pts90k_unwrapped, int64_t arrival); Mapping map(int pid, int64_t
  pts90k_unwrapped, int64_t arrival); State state() const; Stats stats();
  std::vector<Event> take_events(); }` keeps the epoch list for the straddle
  rule (OQ-11, with its refinement of part 4.4) and switches to degraded on
  a validator failure. PCR unwrap uses `fold33` on the 33-bit base and
  `PCR_MODULO` from `ts_house.h`.
- **Acceptance.** `ts_stc_test`: synthetic PCR at 10/s with one-sided
  exponential delay (mean 5 ms, tail 50 ms) and ε ∈ {0, ±50, ±500} ppm
  locks within 40 s, keeps residual min ≥ −1 ms, and its rate error reaches
  ±0.5 ppm by 300 s at the median of 9 seeds and by 600 s on the worst
  (the test pins bounds at 60, 120, 300 and 600 s, with and without 25 %
  PCR loss); a +30 ms minimum-delay step re-locks after 10 s and a −30 ms
  one slews without a relock; a delay step or a burst inside the fit window
  leaves ε unbent (part 4.3's level rule); 25 % PCR loss still locks; each
  validator row of part 4.3 fires on its synthetic case and only on it; degraded
  entry and the 30 s recovery; identical output on the dev box (aarch64) and
  in `./build-native-dev.sh arm64 test`. Revised 2026-10-13 (chapter 15.4
  B-5): the draft asked for ±0.5 ppm within 60 s, which no estimator meets
  under this delay model (measured, a maximum-likelihood envelope estimator
  included); the built least-squares fit with the 2-MAD refit has a median
  error of 1.8 ppm at 60 s.
- **Estimate.** 520 + 480 test; 5 days. Independent of chapter 3 (no TS
  parsing), so it starts at once.

#### WI-P1-2 Arrival traces: format, recorder, replay CLI, generator

- **What.** The fixture form the STC needs: TS headers with their arrival
  times. Chapter 3's `.ts` fixtures have no arrival times and are capped at
  ~1.5 s, too short to see drift or #816's lead wander.
- **Where.** New `plugins/mpegts-core/native/mrts/ts_trace.{h,cpp}`;
  `plugins/mpegts-core/native/mrts/mrts_cli.cpp` gains `trace2jsonl` and
  `restamp-replay` verbs;
  `plugins/mpegts-core/native/mrts/tests/fixture_gen.cpp` (new in section
  00) gains `--trace` output;
  tests `plugins/mpegts-core/native/mrts/tests/ts_trace_test.cpp`.
- **How.** Binary `.stct`: a 16-byte file header (`"STCT"`, version 1,
  record count) then 24-byte records `{u64 arrival_ns; u64 value; u16 pid;
  u8 kind; u8 flags; i32 dts_minus_pts_90k}` with `kind` ∈ {PCR, PES, PSI,
  OUTAGE}; `value` = PCR (27 MHz) or PTS (90 kHz); `flags` carries the
  discontinuity indicator and the stream type class. A PCR at 10/s plus
  every audio and video PES header is ≈ 2 KB/s, so a 15 min trace is
  ≈ 2 MB (inside OQ-2's cap). `restamp-replay <trace> [--config k=v…]
  [--sweep grid.json] [--expect file]` runs `VirtualStc` + the mapping part
  of `RestampCore` and prints the stats lines and events as JSONL.
- **Acceptance.** Round-trip `.stct` → JSONL → `.stct` is byte-identical;
  `fixture_gen --trace` reproduces the same trace from the same seed;
  `restamp-replay` on a synthetic trace prints the expected epochs.
- **Estimate.** 280 + 160 test; 2 days. Depends on WI-P1-1.

#### WI-P1-3 `mrts::RestampCore`

- **What.** Everything in part 4.2 and part 4.4 that is not GStreamer: program
  and PID tables, the STC per program, shifts, the monotonic guard, packet
  removal with CC renumbering, PCR rewrite and shift, gap records, the `fixed`
  mode, trace recording.
- **Where.** New `plugins/mpegts-core/native/mrts/ts_restamp.{h,cpp}`; tests
  `plugins/mpegts-core/native/mrts/tests/ts_restamp_test.cpp` and
  `plugins/mpegts-core/native/mrts/tests/restamp_replay_test.cpp`
  (replays every `.stct` of part 7.2 against its `.expect.json`).
- **How.** `struct RestampConfig { Mode mode; bool add_base_time; int64_t
  base_time_ns; int64_t offset_ns; std::map<int,int64_t> trims_ns;
  ClockLockConfig clock; PcrValidatorConfig pcr; }`. `class RestampCore {
  // rewrites in place; returns the byte ranges to keep and gap records
  Result process(uint8_t* data, size_t len, int64_t arrival_ns);
  void set_offset(int64_t ns); void set_trims(const std::map<int,int64_t>&);
  Stats stats() const; std::vector<Event> take_events();
  void set_trace(TraceWriter*); }`. Uses chapter 3's `PacketWalker`,
  `CcTracker`, `PsiDiscovery` (+ `select_program`, `generation`),
  `read_pcr`, `write_pcr`, `set_discontinuity_indicator`, `parse_pes_header`,
  `PesHeaderSpan`, `rewrite_pes_timestamps`, `Unwrapper`,
  `mux_pts_from_house`, `house_from_mux_pts`, `ns_to_pcr27`. Trims are
  clamped to ±2,000,000,000 ns (§5.5). Per PID state: shift in force,
  pending shift, last emitted house DTS-or-PTS, PES end estimate, CC delta,
  dropping flag, lead window. `Result` lists kept ranges so the element copies
  only when something was removed (the common case is the input buffer,
  rewritten in place). Straddle rule per OQ-11 (decided), with its
  refinement (part 4.4). Overlap accounting and held-header duplicates as
  part 4.4 (2026-10-14, chapter 15.4 B-9).
- **Open as built (2026-10-14, chapter 15.4 B-8); the clamp built
  2026-10-16 (B-45).** The degraded-mode lead clamp of part 4.3 (a PID past
  `lead_clamp_ns` gets its own envelope) is in `VirtualStc`, and
  `Event::Kind` has `lead_clamp`, which WI-P1-4 posts as `lead-clamp` with
  its `pid` (`value-ns`: its lead under the reference mapping), so part 10's
  "Lead clamped" alarm can fire; a reconnect backlog's stale rule (part 4.3)
  came with it. Two mutants
  of the second fix round survive its tests: N4 (a PES length learned
  across an epoch change) and P3 (`map_pcr` always on the newest epoch);
  tests that catch them are still to be written.
- **Acceptance.** `ts_restamp_test`: house PTS equals the STC mapping +
  shift for every PES of `cap-occ-1080i-h264-aac-ttx.ts` replayed with
  synthetic arrivals; B-frame DTS mapped with PTS; header split across two
  packets (`syn-pes-header-split.ts`) rewritten with no other PID delayed;
  `syn-wrap-33bit.ts` crosses the wrap without a backward PTS; O +500 ms →
  one gap of 500 ms per PID, O −500 ms → 500 ms of PES dropped per PID and
  output CC continuous (checked by a second `CcTracker` on the output);
  trim +200 ms on one PID moves only that PID; PCR moves by `min(0, shift)`
  with the discontinuity flag set; `fixed` mode with `add_base_time` adds
  exactly the base time; output byte-identical except PTS/DTS/PCR fields
  and removed packets. `restamp_replay_test`: every trace meets its
  expectation file.
- **Estimate.** 950 + 850 test; 8 days. Depends on WI-P1-1 and chapter 3
  WI-S0-1…5.

#### WI-P1-4 The `mrtsrestamp` element

- **What.** The GStreamer face of `RestampCore`, in two drops: **4a**, an early
  pass-through that records `.stct` traces (needed on the gate boxes for
  WI-P1-5 before the core is finished); **4b**, the full element.
- **Where.** New `plugins/mpegts-core/native/mrtshouse/gstmrtsrestamp.cpp`,
  registered in `gstmrtshouse.cpp`'s factory table (chapter 3 WI-S0-7);
  Python harness test
  `packages/engine/src/child-process/gst_mrtsrestamp_element_test.py`.
- **How.** A plain `GstElement` with always pads, `chain` and `chain_list`
  (a list is processed buffer by buffer and pushed as a list). Properties:
  `clock-mode` (enum `stc` | `fixed`, default `stc`); `arrival` (enum `clock`
  | `buffer-pts`, default `clock`; `buffer-pts` is for appsrc-driven tests
  and replays); `add-base-time` (bool, `fixed` only); `offset-ns` (int64,
  live); `pid-trims` (string `"<pid>=<ns>;…"`, live, clamped ±2 s);
  `stats-interval-ms` (uint, 2000); `trace-location` (string, empty = off);
  read-only `stats` (`GstStructure`) and chapter 3's shared counters
  (`desync-bytes`, `cc-lost`, `header-spans`, …). Live property changes are
  taken under the object lock and applied at the next buffer. Gap markers
  (OQ-12) are pushed on the streaming thread before the buffer that
  revealed the gap, and from the element's own `GstTask` during an outage
  (cadence per OQ-17: at detection and every 250 ms). As built (chapter
  15.4 B-18): before the PES that shows the gap, in one buffer list with
  the rest of that buffer. Element messages,
  posted from the streaming thread:
  `mrtsrestamp-stats` (one per program per interval), `mrtsrestamp-pid` (one
  per PID per interval), `mrtsrestamp-event` (`kind` = `relock`, `degraded`,
  `recovered`, `gap`, `overlap`, `lead-clamp`, `envelope-step`,
  `psi-change`; fields of part 10). The reporter (WI-P1-9) matches these
  exactly (2026-10-14, chapter 15.4 B-11): every `mrtsrestamp-stats` message
  carries `cadence-warning` (bool: a PCR interval late against the PCR's own
  cadence in the last 60 s, chapter 15.4 B-86), `pcr-cadence-ns` and
  `pcr-gap-max-ns`, and the element-wide `cc-lost` and `desync-bytes`, the same in every
  program's message, or the PCR-cadence and transport-error alarms never
  fire; `cc-lost`, `desync-bytes` and `dropped-pes` are running totals since
  the element started, never per-interval deltas. `state` is `acquiring`,
  `locked`, `degraded` or `lost`; the stats `reason` is `none`, `cadence`,
  `rate`, `freeze`, `leap` or `lead` (`reason_name`); a relock's `reason` is
  `discontinuity`, `leap`, `envelope-step`, `external` or `ref-change`;
  `kind` is one of the list above (`event_name`). A `degraded` event puts the
  program's reference PID in `pid` (`RestampCore`'s STC events carry −1
  today; without it the warning reads "timing from the reference PID's
  PTS"), and a PAT-level `psi-change` names program −1. In `fixed` mode a
  forward PTS jump also produces a gap marker: on an audio or other PID one
  of more than two frame durations, on a video PID a hole of 1 s or more, so
  a dropped frame makes none (chapter 15.4 B-21, B-89). No Python fallback
  exists or is added (§13.1); without the plugin the ingest starts with
  `identity` in the restamp's place and carries the rule-6 alarm — its
  bytes are on source time (S0 part 4.5 rule 6, C-1).
- **Acceptance.** `gst_mrtsrestamp_element_test.py` (appsrc with
  `arrival=buffer-pts` → element → appsink, in the Python runner's
  interpreter): bytes equal `RestampCore`'s for the same input; a list of 7
  buffers leaves as one list; live `offset-ns` change yields a gap marker
  with the right PTS and encoded length; the same marker is delivered
  every time through `appsrc ! mrtsrestamp arrival=buffer-pts ! queue
  leaky=2 max-size-time=100000000 ! appsink` (srt-input's queue, the case
  the verifier found), after a live edit and after a simulated 3 s
  outage; `trace-location` writes a valid `.stct`.
  `native_runner_protocol_test.py` case `ingest-restamp` (part 7.3) for the
  native runner. `gst-inspect-1.0` lists every property.
- **Estimate.** 4a: 200 lines, 1.5 days (after WI-S0-7/8); 4b: 500 + 350
  test, 4 days (after WI-P1-3).

#### WI-P1-5 Capture session: field traces and expectations

- **What.** Record the `.stct` traces and `.ts` captures of part 7.2 on the gate
  boxes with WI-P1-4a's `trace-location`, review them, and write each
  `.expect.json`.
- **Where.** `plugins/mpegts-core/tests/fixtures/restamp/`.
- **How.** A hot-deployed 4a element (chapter 3 part 9: `.so` into
  `/opt/media-router/plugins/mpegts-core/native/mrtshouse/`) and a
  pipeline-string override on the ingest under test. Sources: the OCC rig on
  .103, the SRT and RIST rigs on .103/.108, a CBR encoder for #816, the vMix
  source for #820, and the scenarios of #812, #825, #836 where the rigs
  reproduce them; each trace ≤ 2 MB (15 min), committed in the repository
  and kept off the device (OQ-2, WI-S0-13). The assistant session with rig
  access records them, after checking what already exists on .103; the
  owner supplies a vMix feed or recording only if no rig can subscribe to
  one (OQ-3).
- **Acceptance.** Every trace of part 7.2 exists, its `trace2jsonl` dump has
  been read against the source's known behaviour, and its expectation file names
  relocks, degraded intervals, gaps and the ppm range.
- **Estimate.** Fixture files + ~200 lines of expectations; 3 days.

#### WI-P1-6 Constant tuning by replay; ADR record

- **What.** The sweep of part 4.3 and the chosen constants.
- **Where.** `mrts_cli restamp-replay --sweep`; grid
  `plugins/mpegts-core/tests/fixtures/restamp/sweep-grid.json`; result table
  in the timing ADR (chapter 3 WI-S0-12 creates it).
- **How.** As part 4.3, with its revised convergence criterion (chapter 15.4
  B-5). The defaults in `ClockLockConfig` and `PcrValidatorConfig` are
  updated to the chosen set in the same change.
- **Open observations for the sweep (2026-10-14, chapter 15.4 B-16).** A
  capture-latency change below the ASRC's 50 ms step is not a step: a
  +30 ms rise is absorbed by the bent rate fit and leaves labels about
  2.2 ms off 300 s later (as before the fix round); a fall below 50 ms
  behaves alike. If 20–50 ms latency changes occur in the field, the
  ASRC's `step_ns` is the knob. `mrasrc`'s lock time (35–36 s, WI-P1-8)
  follows `rate_buckets_min`, and its ±500 ppm frame count the jitter of
  the bucket minima, so this sweep sets both.
- **As built (2026-10-16, chapter 15.4 B-36 to B-38).** The grid ran on 57
  traces (the eight field traces of WI-P1-5, thirteen synthetic, 36 drift
  seeds); 36 of 243 points pass, all at 1 s buckets. Shipped:
  `rate_tau_ns` 120 s and `leap_ns` 500 ms, every other constant the
  draft's (M stays 10, not the longest 30: B-36); the first epoch moves onto
  the floor its first two buckets agree on (B-37); `syn-start-burst` joins
  part 7.2. Each sweep line carries the program's summary and ε at 60, 120,
  300 and 600 s. `trace-816-clean-cbr` and the two gate traces have new
  expectations. mrasrc keeps its constants: neither its lock time nor its
  ±500 ppm frame count moves with these constants (B-36).
- **Acceptance.** `restamp_replay_test` passes with the shipped defaults; the
  ADR lists the grid, the pass criteria and the per-trace results.
- **Estimate.** 80 lines; 2 days. Depends on WI-P1-3, WI-P1-5.

#### WI-P1-7 Identity stamper: GAP pass-through and base-aware identity

- **What.** Parts 4.6 and 4.7 in the kept stamper.
- **Where.** `plugins/mpegts-core/native/mrtsstamp/gstmrtsstamp.cpp`
  (`transform_ip` :413–470, `house_now` :253–261);
  `packages/engine/src/child-process/gst_stamp_probe.py` (`install`,
  `house_now`, `on_buffer`); `plugins/mpegts-core/native/mrts/ts_timeline.cpp`
  is not changed (`stamp_house` already takes `house_now`).
- **How.** In identity mode pass `clock_now` (not minus base) as `house_now`
  and map `stamp − base_time` through the segment; return early, buffer
  untouched, when `GST_BUFFER_FLAG_IS_SET(buf, GST_BUFFER_FLAG_GAP)`. Same two
  edits in the Python probe. Anchored mode is untouched (frozen, Q2).
- **As built (2026-10-14, chapter 15.4 B-10).** The stamp maps to running
  time `max(stamp − base_time, 0)`. The GAP early return is taken at
  identity egresses only: anchored mode stays frozen, and in Phase 1 every
  gap marker comes from a restamp followed by an identity egress. A buffer
  list holding a GAP member is chained member by member at an identity
  egress instead of coalesced into one buffer (ADR-0011): merging would
  hand the marker's flags and PTS to the whole access unit, or bury the
  marker in a data buffer. `MRTSSTAMP_VERSION` is 2.6.0. Later (chapter
  15.4 B-19, B-27): the marker leaves an identity egress without its DTS,
  and the version is 2.7.0.
- **Acceptance.** `gst_mrtsstamp_element_test.py` gains: identity in a
  pipeline with base time 10 h and 14 h gives `wire = PES − 1 h` exactly; a
  GAP buffer leaves with its PTS and duration. `gst_bus_stamper_test.py`
  gains the same two cases for the probe.
  `native_runner_protocol_test.py` case `identity-base-time`.
- **Estimate.** 60 + 140 test; 1.5 days.

#### WI-P1-8 `mrts::AsrcServo` and the `mrasrc` element; Pi 4 bench

- **What.** Part 4.5.
- **Where.** New `plugins/mpegts-core/native/mrts/asrc_servo.{h,cpp}` (portable:
  `ClockLock` + phase servo, outputs the commanded ratio and T0);
  new `plugins/mpegts-core/native/mrtshouse/gstmrasrc.cpp` (registered in the
  factory table; the plugin Makefile adds `gstreamer-audio-1.0` to its
  pkg-config list); tests
  `plugins/mpegts-core/native/mrts/tests/asrc_servo_test.cpp`,
  `packages/engine/src/child-process/gst_mrasrc_element_test.py`; bench
  `plugins/mpegts-core/native/mrtshouse/tests/asrc_bench.c` (links
  `gstreamer-audio-1.0`, runs `GstAudioResampler` at the element's settings).
- **How.** `GstBaseTransform` with `transform_caps` (rate free on input,
  `out-rate` fixed or negotiated), `transform_size` from the commanded ratio,
  `transform` calling `gst_audio_resampler_resample` after
  `gst_audio_resampler_update` when the commanded `in_rate` changed by ≥ 1.
  Formats: S16LE, S32LE, F32LE interleaved (what the capture branches
  produce). Properties: `out-rate` (0 = same as input; as built, the
  input's rate or the rate downstream asks for, chapter 15.4 B-22), `quality` (0–10,
  default 4), read-only `stats`. Messages: `mrasrc-stats` (`state`,
  `ratio-ppb`, `phase-err-ns`, `relocks`, `in-frames`, `out-frames`,
  `discont-in`, `dropped-frames`), `mrasrc-event` (`relock` with
  `dropped-ns`, `ratio-out-of-bounds`). Before `gst_audio_resampler_resample`
  the element drops `Command::skip` frames from the head of the input
  buffer: a relock's overlap (part 4.5; 2026-10-14, chapter 15.4 B-4). The
  element never drops or inserts samples to steer; only the ratio moves,
  and that relock overlap is the one drop.
- **Acceptance.** `asrc_servo_test`: synthetic capture at ±50 and ±500 ppm
  with 1 ms timestamp jitter locks within 37 s; over 1 h simulated, output
  frames = house seconds × 48,000 ± 1 frame at 0 and ±50 ppm and ± 1.5
  frames at ±500 ppm; an xrun (DISCONT + 20 ms PTS jump) gives one relock
  and one forward PTS jump of 20 ms ± 1 frame; a −60 ms and a −200 ms
  capture-latency fall each give one relock 9–10 s after the step, no PTS
  jump, the overlap dropped (59.935 and 199.928 ms measured), labels within
  one frame of capture time from the relock, and frames out = house
  seconds × 48,000 ± 1; a +60 ms rise gives one relock and a 60 ± 1 ms
  forward jump (59.988 ms). Measured against the draft (2026-10-14,
  chapter 15.4 B-7): lock in 35.01–36.01 s over 100 seeds, where the draft
  said 30 s, because the STC's constants give a 30-bucket first fit plus
  the 5 s acquire (`rate_buckets_min` = 20 would give about 25 s; a WI-P1-6
  choice); the 1 h count error is ≤ 0.70 frames at 0 and ±50 ppm and
  ≤ 1.19 frames at ±500 ppm (median 0.50), where the draft said ± 1: the
  excess is ClockLock's bucket-minimum jitter, which WI-P1-6 tunes. A
  device past the ±1,000 ppm clamp now relocks on falls too: at
  +1,500 ppm 2 relocks instead of 0 and an end error of +19.4 ms instead
  of +155.1 ms; at −1,500 ppm still 2, ending at −35.7 ms instead of
  −25.7 ms.
  `gst_mrasrc_element_test.py`: a 1 kHz sine through the element at
  1.0002 ratio has THD+N below −90 dBFS; PTS contiguous to the nanosecond
  formula. Bench on .108 (Pi 4): ≤ 3 % of one core per stereo 48 kHz stream
  and ≤ 10 % per 8 channels; otherwise drop `quality` to 2 and re-measure,
  and if still over, implement the speexdsp backend behind the same element
  (+150 lines, +1 recipe DEPENDS) and record the switch in the ADR.
- **Estimate.** 650 + 380 test; 7 days including the bench.

#### WI-P1-9 Engine glue: builder, reporter, settings injection

- **What.** One TypeScript home for ingest timing, used by the seven modules.
- **Where.** New `packages/engine/src/plugins/ingestTiming.ts` and
  `ingestTiming.test.ts`, exported from `@media-router/engine`;
  `packages/shared-types/src/` gains `withIngestTimingSettings(schema,
  { pidTrims })` (the first injected timing settings: Phase 0 injects
  none, OQ-8); injection in
  `packages/engine/src/plugins/PluginLoader.ts` (manifest load, near :86)
  and `packages/manager/src/plugins/PluginRegistry.ts`, keyed by a manifest
  field `"timing": { "role": "ingest", "pidTrims": true|false }` (typed as
  `PluginManifest.timing?: ManifestTiming` in shared-types);
  `packages/engine/src/plugins/PluginModule.ts` doc of `houseTimelineEgress`
  (now "every producer except the Phase 2 set").
- **How.**
  - `INGEST_OFFSET_KEY = 'ingestOffsetMs'`, `PID_TRIMS_KEY = 'pidTrimsMs'`.
  - `buildRestamp({ mode, addBaseTime, offsetMs, pidTrimsMs, name =
    'restamp' }): string` → `mrtsrestamp name=… clock-mode=… offset-ns=…
    pid-trims="…"`; `buildAsrc({ name = 'asrc', outRate })`.
  - `restampBusReports(name)` → the three `{element, structure}` entries
    (`mrtsrestamp-stats`, `mrtsrestamp-pid`, `mrtsrestamp-event`), plus
    `asrcBusReports`.
  - `class IngestTimingReporter` (host `IngestTimingHost`:
    `setDynamicSections`, `setStatusData`, `setBadge`, `clearBadge`,
    `setFieldOptions`, `warn`, `clearWarning`, `log`): turns the messages
    into the `clock` section, one `pid-<n>` section per PID, the `clock`
    badge, the `pids` field options
    (`{ value: '<pid>', label: '0x0100 H.264 video' }`) and the warnings of
    part 10; it throttles to changes ≥ 1 ms or a state flip, like Phase 0's
    `LatenessReporter`. As built (2026-10-14, chapter 15.4 B-11):
    `clearBadge` withdraws the `clock` badge once no program reports, and
    WI-P1-10 to WI-P1-13 bind it to `GstPluginBase.clearBadge`; the
    reporter reads `cc-lost`, `desync-bytes` and `dropped-pes` as running
    totals and takes a fall as an element restart from 0, so a window that
    spans a restart keeps the counts from before it; a program that has
    only events (no stats) expires by its last event under the same stale
    rule as the rest. What it needs from WI-P1-4 is listed there.
  - `applyIngestTimingLiveUpdate(module, changes)` →
    `setElementProperty('restamp', 'offset-ns' | 'pid-trims', …)`
    (`GstPluginBase.ts:872`). The keys join each module's
    `liveUpdatableParams`.
  - Schema: `ingestOffsetMs` `{ type: number, default: 0, minimum: −10000,
    maximum: 10000, x-unit: ms, x-live: true, title: "Ingest Offset" }`
    (bounds per OQ-14); `pidTrimsMs` `{ type: object,
    additionalProperties: { type: number, minimum: −2000, maximum: 2000 },
    default: {}, x-widget: pidTrim, x-optionsFrom: pids, x-live: true,
    x-unit: ms, title: "Per-PID Trim" }` (only where `pidTrims` is true).
- **Acceptance.** `ingestTiming.test.ts`: builder strings; reporter maps a
  recorded message sequence (locked → degraded → recovered) to sections,
  badges and warnings, with throttling; live update calls the right
  property with clamping; schema snapshot tests in engine and manager show
  the two settings only on the declaring manifests.
- **Estimate.** 480 + 420 test; 4 days.

#### WI-P1-10 Network ingests wired

- **What.** srt-input, rist-input, mpegts-ip-input on the restamp (arrival
  rule per OQ-19, decided).
- **Where.** `plugins/srt-input/engine/SrtInputModule.ts:118–128`,
  `plugins/rist-input/engine/RistInputModule.ts:127–142`,
  `plugins/mpegts-ip-input/engine/MpegTsIpInputModule.ts:187–218`, their
  `package.json` (`"timing": { "role": "ingest", "pidTrims": true }`) and
  tests.
- **How.** Insert `buildRestamp({ mode: 'stc', … })` right after the
  transport element (after `rtpmp2tdepay` for RTP); return
  `houseTimelineEgress: true` and `busReports: [...existing,
  ...restampBusReports()]`; route `mrtsrestamp-*` plugin events to an
  `IngestTimingReporter`; add the two keys to `liveUpdatableParams` beside
  `playoutOffsetMs` and call `applyIngestTimingLiveUpdate` from
  `onLiveConfigUpdate`. `playoutOffsetMs` stays until Phase 4.
- **Acceptance.** Module tests assert the pipeline order (source → restamp →
  queue → bus sink), `houseTimelineEgress`, the bus reports, and that a live
  edit of `ingestOffsetMs` calls `setElementProperty('restamp',
  'offset-ns', …)` without a restart.
- **Estimate.** 120 + 260 test; 2 days. Depends on WI-P1-4b, WI-P1-9.

#### WI-P1-11 PCM capture producers: audio-input-302m, aes67-input

- **What.** ASRC, identity egress, O.
- **Where.** `plugins/audio-302m-core/engine/audio302mHelpers.ts:426–438`
  (`Audio302mEncodeOpts` gains `asrc?: boolean` and `restamp?: string`);
  `plugins/audio-input-302m/engine/AudioInput302mModule.ts:190–212`;
  `plugins/aes67-input/engine/Aes67InputModule.ts:247–274`; their
  `package.json` (`"timing": { "role": "ingest", "pidTrims": false }`,
  per OQ-15) and tests.
- **How.** With `asrc: true` the branch is `audioconvert ! mrasrc name=asrc !
  audio/x-raw,format=…,rate=48000,channels=N ! avenc_s302m … ! mpegtsmux
  latency=0 alignment=7 ! <restamp>`; without it (the mixers, until Phase 2)
  it stays byte-identical to today. Descriptions return
  `houseTimelineEgress: true` and the bus reports; the reporter shows the
  ASRC ratio. aes67-input's `rtpjitterbuffer` (slave mode, or RFC 7273 with
  `ptpSync`) is unchanged: its PTS is the capture-time evidence `mrasrc`
  locks to (§5.4: with `ptpSync`, RTP time → TAI → bus; otherwise a lock on
  RTP time).
- **Acceptance.** Module tests: pipeline strings with `mrasrc` and the
  restamp, identity egress, live O; `audio302mHelpers` test pins the
  unchanged mixer branch.
- **Estimate.** 90 + 200 test; 2 days. Depends on WI-P1-4b, WI-P1-8,
  WI-P1-9.

#### WI-P1-12 audio-encoder: device timing, ASRC, identity egress

- **What.** Capture from PipeWire with device timing, one resample, identity
  egress; `conditionStepMs` goes (OQ-16).
- **Where.** `plugins/audio-encoder/engine/AudioEncoderModule.ts:147–227`,
  `plugins/audio-encoder/package.json` (`srcBufferMs` at :122–130),
  `AudioEncoderModule.test.ts` (:52 asserts `conditionStepMs`).
- **How.** Source `pipewiresrc target-object=MR_PW_<id>
  ${pipewireStreamProps({ 'stream.capture.sink': 'true', 'node.latency':
  '<q>/48000' })}` (drafted with `pulsePinnedStreamProps`; the PipeWire
  helper adds the node on the runner's RT data loop, chapter 15.4 B-88)
  with the quantum from `srcBufferMs` clamped to 40–85 ms as
  in `AudioInput302mModule.ts:261`; then `audioconvert ! mrasrc
  out-rate=<sampleRate> ! audio/x-raw,rate=<sampleRate>,channels=N` replaces
  `audioconvert ! audioresample ! …`; `mrtsrestamp clock-mode=fixed` after
  the mux; `houseTimelineEgress: true`; `conditionStepMs` removed; the
  module gets `ingestOffsetMs` (§5.5; no trim, `pidTrims: false`, per
  OQ-15). A first
  0.5-day spike on .108 checks that `pipewiresrc` PTS track the PipeWire
  driver (no ring-sized steps): log `PTS − clock` per buffer for 10 min; if
  they step, `mrasrc` reads the stream's `pw_time` via the buffer's
  reference-timestamp meta instead (+60 lines, noted in the ADR).
- **Acceptance.** Module test pins the new source and the absence of
  `conditionStepMs`; gate check V-P1-9.
- **Estimate.** 60 + 120 test (−40 removed); 2 days. Depends on WI-P1-4b,
  WI-P1-8, WI-P1-9.

#### WI-P1-13 video-encoder on house time

- **What.** Part 4.6.
- **Where.** `plugins/video-encoder/engine/VideoEncoderModule.ts:199–243`;
  `packages/engine/src/plugins/encoderLeaf.ts` (`sink` fragment gets the
  restamp in front: `opts.sink` stays the bus sink, the module passes
  `${buildRestamp({ mode: 'fixed', addBaseTime: true })} ! ${sink}`);
  `VideoEncoderModule.test.ts`.
- **How.** Keep `liveCaptureClock: true`; add the restamp; set
  `houseTimelineEgress: true`; the module gets `ingestOffsetMs` (§5.5; no
  trim, `pidTrims: false`, per OQ-15).
- **Acceptance.** Module test: pipeline order and flags. Gate check
  V-P1-8: PES − 1 h equals the v4l2 capture time within one frame
  duration, and the egress rate stays flat.
- **Estimate.** 30 + 80 test; 1 day. Depends on WI-P1-4b, WI-P1-7,
  WI-P1-9.

#### WI-P1-14 Manager UI: per-PID trim widget, offset, status

- **What.** The settings and displays of part 8.
- **Where.** New
  `packages/manager-ui/src/components/routing/widgets/PidTrimField.vue`
  and `PidTrimField.test.ts`;
  `packages/manager-ui/src/components/routing/ModuleSettingsForm.vue`
  (a `v-else-if="field.widget === 'pidTrim'"` branch before the generic
  ones, near :244);
  `packages/manager-ui/src/composables/useModuleSettingsForm.ts`
  (`x-widget` union, keep the object value out of the generic array path).
- **How.** The widget reads the detected PIDs from the module's
  `fieldOptions.pids` (the `x-optionsFrom` path,
  `ModuleSettingsForm.vue:55–61`) and renders one row per PID: PID (hex),
  type, a numeric trim input (−2000…2000 ms, step 1), and the effective
  shift `O + trim` read-only. Trims stored for PIDs that are not detected
  stay in the value and show greyed as "not in stream". Empty `fieldOptions`
  shows "Waiting for the stream's PMT". A `disabledReason` prop is accepted
  (rendered beside the controls, controls disabled) so Phase 5 can show the
  Trust reason without a second widget (§10.4). `ingestOffsetMs` renders
  as a number box with `x-unit`. Status sections and badges need nothing
  new (ADR-0007).
- **Commit on change (2026-10-14, chapter 15.4 B-12).** The Ingest Offset
  box and every trim box write on change only (Enter, blur, a spinner
  step), never per keystroke: each live write of O or a trim is a gap or
  a drop on the stream (§5.5). Each binds a draft of the uncommitted text
  (`useNumberBoxDrafts`, `useModuleSettingsForm.ts`, beside
  `commitNumberBox`): typing updates only the draft; a commit writes once
  and closes it; a blur that moves focus elsewhere in the page closes it;
  a switch to another window or tab keeps it (Blink and WebKit fire no
  change event then, and the box stays `document.activeElement`); the form
  closes the offset draft when the panel opens another module. Why: Vue
  re-sets a bound input's value whenever its owner re-renders; the
  settings form re-renders on any engine's store patch and `PidTrimField`
  on a new O, a trim echo or a PMT update, so a bare `:value` silently
  reset half-typed text and the Enter that followed wrote nothing. The
  rule for any later change-only input: bind a draft, or live in a child
  whose props cannot change while someone types. Known gap: if a PID with
  trim 0 leaves the stream while its box is being typed in, its draft stays
  and shows again should the PID return before a commit or blur on it;
  nothing is written without a change event.
- **Acceptance.** `PidTrimField.test.ts`: rows from options; clamping;
  stale PIDs greyed and preserved; emits the whole map on edit; disabled
  state with reason. `ModuleSettingsPanel.test.ts` renders a
  srt-input schema with both settings. Added with the drafts: half-typed
  Ingest Offset text survives an info patch on its engine, a structural
  patch on another engine and an echo of another setting of the module;
  half-typed trim text survives a new O, an echo of another PID's trim
  and a PMT update; in each case one change then writes exactly once; a
  box typed back to its focus-time text and left follows later echoes;
  typed text outlasts a window or tab switch; a draft never shows in the
  next module the panel opens.
- **Estimate.** 380 + 220 test; 3 days. Depends on WI-P1-9.

#### WI-P1-15 Deletions: the per-egress conditioner threshold

- **What.** Everything in part 6 that this phase deletes.
- **Where/How.** As listed in part 6, in one change after WI-P1-12.
- **Acceptance.** `grep -rn "conditionStepMs\|condition-step-ms\|
  condition_step\|set_condition_step_ns\|cond_threshold_ns_"` over
  `packages/`, `plugins/` finds nothing; `make native-test`, `pnpm -r test`
  and `pnpm --filter @media-router/engine test:py` pass;
  `plugins/mpegts-core/package.json` `test:py` passes.
- **Estimate.** −230 lines; 1.5 days.

#### WI-P1-16 — removed (OQ-13, the owner, 2026-10-12)

The draft raised the video-player's leaky ES queue floor from 1 s to 3 s
so that presentation legs would hold the source lead during an interim in
which outputs still presented at `stamp + D`. Phases 1–4 ship as one
release, so there is no such interim in the field; the item and its gate
check V-P1-17 are removed, and no Q2 exception is needed. Phase 4 replaces
the queue (chapter 8 WI-P4-6). During development, a direct ingest →
player route on a test box carries the lead until Phase 4 lands on that
box (part 12, R-P1-1).

#### WI-P1-17 Documentation, release notes, gate verification

- **What.** ADR entries (estimator, validation, ASRC choice, arrival rule,
  gap representation and its queue interaction, straddle rule, base-aware
  identity); the `avskew` A/V skew tool checked in under `tools/avskew/`
  (not in the submodule today); `plugins/README.md`
  sections on ingest timing and the restamp/ASRC elements,
  `plugins/mpegts-core/README.md` contents table, this phase's items for
  the Phases 1–4 release notes (new settings; how to read the lead and set
  a negative O; chapter 11), and the gate run of part 11.
- **Where.** As named; the timing ADR from chapter 3.
- **Acceptance.** Every V-P1 row of part 11 passes on .103 and .108 with both
  runners (part 11.1 on the release image, part 11.2 on the Phase 1
  development build); the release-note items reviewed by the owner.
- **Estimate.** 150 lines; 6 days (5 on the boxes).

### 6. Deletions

The anchored stamper, the conditioner and their twins are **not** deleted in
this release: mixers, audio-processing, the splitter and the HLS fan-out
still run them, and Phase 2 deletes them with those users (§14 row 2). What
Phase 1 replaces outright goes now:

| What | Where | Lines |
|---|---|---|
| `conditionStepMs` field and doc | `packages/engine/src/plugins/PluginModule.ts:339–350` | 12 |
| its forwarding | `packages/engine/src/child-process/GstChildProcess.ts:255` | 2 |
| its test | `packages/engine/src/child-process/GstChildProcess.test.ts:237–243` | 7 |
| audio-encoder's `conditionStepMs: 100` and comment | `plugins/audio-encoder/engine/AudioEncoderModule.ts:222–225`; test `AudioEncoderModule.test.ts:52` | 5 |
| audio-encoder's `pulsesrc` source and fixed-rate `audioresample` | `AudioEncoderModule.ts:162–165` and the `format` clause | 6 |
| native runner plumbing | `packages/engine/native/mr-gst-runner/runner.cpp:329` (argument), `stamper.h:23–29` (parameter), `stamper.cpp:25,256–268,276–277` | 8 |
| Python runner plumbing | `gst-pipeline-runner.py:2123–2124` (argument), `gst_bus_stamper.py:78,181,224,251–255`, `gst_stamp_native.py:176–184`, `gst_stamp_probe.py` (`condition_step_ms` parameter and `condition_step_ns` argument) | 20 |
| element property | `plugins/mpegts-core/native/mrtsstamp/gstmrtsstamp.cpp` `PROP_CONDITION_STEP_MS` (:161, :181–184, :245, :615–618, :648–651, default :714, `g_param_spec_int("condition-step-ms"…)` :767) | 25 |
| core setter | `plugins/mpegts-core/native/mrts/ts_timeline.h:140–145` (`set_condition_step_ns`, `cond_threshold`), `:292` (`cond_threshold_ns_`); the threshold lookup in `ts_timeline.cpp` reduced to `COND_STEP_NS` | 15 |
| Python twin | `plugins/mpegts-core/py/ts_timeline.py` `condition_step_ns` keyword and its use | 12 |
| tests pinning the override | `plugins/mpegts-core/native/mrts/tests/ts_timeline_test.cpp`, `plugins/mpegts-core/py/ts_timeline_test.py`, `packages/engine/src/child-process/native_runner_protocol_test.py:207` (the `conditionStepMs` key), `packages/engine/src/plugins/busRunnerContract.test.ts:216` (expected call text) | ~90 |
| docs | `plugins/README.md:2109–2119` ("Conditioner step threshold"); `PluginModule.ts` comment above | 13 |
| Settings | None of the Q9 settings goes in Phase 1 (`playoutOffsetMs` goes in Phase 4; the rest with their mechanisms in Phases 2–4). `srcBufferMs` on audio-encoder changes range (OQ-16), not removed. | — |

ADR-0005's text on `conditionStepMs`
(`docs/adr/0005-time-sync-backend.md:639–640`)
and on `liveCaptureClock` (:1020–1036) is left as is; the timing ADR records
that the per-egress threshold is gone and that `liveCaptureClock` remains
with the base-time correction (§11.6 rule: superseded documents are not
edited during the migration). `docs/TodoNotes.md:89` is history and stays.

### 7. Tests and fixtures

#### 7.1 Unit tests (C++, no GStreamer)

Run by `make -C plugins/mpegts-core/native/mrts test`.

| Test | Pins |
|---|---|
| `ts_stc_test.cpp` | Convergence (part 4.3's revised bounds), residual floor, envelope step one-sided and two-sided, the rate fit on one floor level (steps, bursts, drains), PCR loss, every validation check, degraded entry/recovery, the straddle rule and its refinement, integer determinism. |
| `ts_restamp_test.cpp` | Mapping per PES, B-frame DTS, header span (a held header's duplicate dropped alone), wrap, O and trim live edits (gap/drop, overlap accounting), CC renumbering, PCR shift and flag, straddle rule, `fixed` mode and base time, bytes unchanged outside the timestamp fields. |
| `restamp_replay_test.cpp` | Every `.stct` of part 7.2 against its `.expect.json`, with the shipped constants. |
| `ts_trace_test.cpp` | Trace format round-trip, generator determinism. |
| `asrc_servo_test.cpp` | Lock at ±50/±500 ppm, frame count over 1 h simulated, xrun relock, capture-latency rises and falls (the overlap drop), devices near and past the ratio clamp. |

#### 7.2 Conformance fixtures

`plugins/mpegts-core/tests/fixtures/restamp/<name>.stct` with
`<name>.expect.json`; field traces ≤ 2 MB (OQ-2). Chapter 3's `.ts`
fixtures are reused where named.

| Fixture | Source | Pins |
|---|---|---|
| `trace-816-clean-cbr.stct` | CBR encoder into srt-input on .108, 15 min (#816) | Zero relocks; ppm steady to ±0.1 ppm after 2 min; the lead wanders but the mapping does not follow it. As recorded (chapter 15.4 B-35, B-37): a start burst, so one drop of its overlap at 2.5 s, then the residual floor within 1 ms; ε follows the floor's own slope, which wanders 2 ppm between two chrony-disciplined boxes. |
| `trace-820-vmix-pcr.stct` | vMix source (#820, #737) in CBR mode, 15 min; still to be recorded, with the owner's vMix SRT output switched to CBR (B-85) | PCR stop/lag fails validation; degraded with the lead clamped (no 12.6 s lead on the output); `recovered` only after 30 s of good PCR. |
| `trace-vmix-sparse-pcr.stct` | The owner's vMix looping a recording, SRT listener, pulled by .103 (a standalone srtsrc caller into `mrtsrestamp`), 2026-10-21; the first 856 s (2 MB) of 15.5 min; added 2026-10-22, chapter 15.4 B-85 | A PCR only in each IDR, every 2 s (vMix's libavformat VBR mux), steady: the PCR lock acquires in 74 s, never degraded, no warning, cadence 2.0 s, 0 relocks, residual min −1 ms, ε 6–24 ppm; no PES more than 50 ms ahead of its arrival (3.4 ms as replayed); no PCR flagged (B-84). Before B-86: degraded (cadence) at 1.6 s for good. #820's CBR-mode stop/lag and its 12.6 s lead do not reproduce. |
| `trace-836-program-split.stct` | the #836 source where the rig reproduces it | One mapping for every PID: the inter-PID offset at the output equals the source's. |
| `trace-825-audio-swing.stct` | the #825 source where reproducible | No audio swing on the output; lead telemetry shows the source's swing. |
| `trace-812-slow-source.stct` | a source with a slow clock (#812), or `fixture_gen --ppm −300` if no field source | ε locks within 60 s and holds; no relock. |
| `trace-occ-1080i.stct` | OCC feed on .103 (the feed the conditioner misread, ±0.32 s storm) | Zero relocks; B-frame DTS behind PTS mapped consistently. |
| `trace-srt-restart.stct` | SRT caller stopped 5 s and restarted on .108 | One relock, one gap of ≈ outage per PID, no overlap drop beyond the source's own rewind. |
| `trace-rist-reconnect.stct` | RIST link dropped and restored on .103 | As above, for RIST's reconnect pattern (the .103 reconnect case with early stamps). |
| `trace-gate01-rist-20010.stct`, `trace-gate01-rist-20046.stct` | The OCC gate's real RIST outputs (frozen model), pulled by .103 and .108; added 2026-10-16 | Today's sender: never locked, a relock per leap, degraded without recovery, today's overlap drop as the ceiling (chapter 15.4 B-34). With `leap_ns` 500 ms (B-38) its delivery stalls are no leaps: 0–2 relocks, never degraded, at most 1 s dropped. |
| `trace-srt-bursty-encoder.stct` | The encoder of `trace-816-clean-cbr` writing straight to SRT (deliveries in bursts of up to 400 ms); added 2026-10-16 | A late lock, at most one envelope-step relock, nothing dropped. |
| `trace-tech01-relay.stct` | The production gate's renditions as TECH01 relays them over SRT, pulled by a standalone srtsrc caller (latency 600 ms) into the restamp on .108, 2026-10-22; the first 734 s (2 MB) of 15.5 min; added 2026-10-22, chapter 15.4 B-90 | A 125 ms mux lead on a path that repeats every 150 s (a 12 s rise 400–600 ms above its floor, then 10 s on it): never degraded, locked at 188 s; the PCR lock's envelope steps in those 150 s pairs, each pair one move onto the floor (560–620 ms dropped per PID), at most 10 relocks and 5 s dropped as the ceiling. Before B-90 (the lower bound on the lead against arrival): degraded (lead) at 91.4 s, never recovered. |
| `syn-drift-ppm.stct` | `fixture_gen --trace --ppm ±50,±500` | Rate convergence and tracking. |
| `syn-pcr-discont.stct` | generator: PCR jump with `discontinuity_indicator` | Flagged discontinuity re-locks; house time continuous. |
| `syn-rewind-1s.stct` | generator: PCR and PTS rewind 1 s, unflagged | Leap detection, relock, straddle tie-break (OQ-11), overlap drop. |
| `syn-straddle-audio.stct` | generator: audio PES of the old epoch arriving after the new epoch's first PCR | Old-epoch PES stay on the old mapping. |
| `syn-reroute-30ms.stct` | generator: minimum delay +30 ms at 5 min | Envelope step → relock after 10 s; −30 ms → slew without relock. |
| `syn-pcr-sparse.stct` | generator: PCR every 150 ms, then 600 ms | One late interval at the change (the warning for 60 s), the 600 ms cadence learned, locked throughout, never degraded (B-86; before: degraded for good). |
| `syn-pcr-dense-to-sparse.stct` | generator: PCR every 40 ms, then every 2 s from 60 s; added 2026-10-22, chapter 15.4 B-86 | Degraded (cadence) at 61.5 s (three 500 ms crossings in the first 2 s interval), which teaches the 2 s cadence; recovered once at 92 s (the windowed counts cleared), the switches' 0.6 s per PID. |
| `syn-pcr-stop-sparse.stct` | generator: a 2 s PCR missing 100–140 s while every PES flows on (`--pcr-ms 2000,0@100,2000@140`); added 2026-10-22, chapter 15.4 B-86 | The warning from 102 s, the lock lost at 103 s, degraded (cadence) at 110 s (three 4 s crossings), recovered once at 170 s (30 s after the last crossing); the cadence 2 s throughout. |
| `syn-pcr-irregular-sparse.stct` | generator: a 2 s PCR with one 5 s interval at 100 s; added 2026-10-22, chapter 15.4 B-86 | One late crossing: the warning for 60 s, never degraded, the lock never lost; the 5 s interval teaches nothing (over the cap). |
| `syn-outage-continuous-pcr.stct` | generator: 3 s outage, PCR continuous across it (a sending engine restarting its link) | Zero relocks; one gap of 3 s per PID; the epoch is kept (§5.2). |
| `syn-start-burst.stct` | generator: the first 0.5 s of sends 500 ms late and the next 0.5 s queued behind them (a transport's start burst); added 2026-10-16, WI-P1-6 | The first epoch on the floor of its first two buckets from 2 s; one drop of the overlap per PID; residual floor within 1 ms; no relock (chapter 15.4 B-37). |
| `syn-reconnect-backlog-30s.stct` | generator: the pipeline starts on 30 s of a queuing caller's backlog drained in 1 s, then live (`--backlog 0:30000:1000`); added 2026-10-16, chapter 15.4 B-39, B-45 | Never degraded; no PES more than 4 s ahead of its arrival; one overlap run (reason `backlog`) per PID at 3.5–3.7 s: the backlog's oldest 3.5–3.7 s play, 2.5–2.7 s of live content go; residual floor within 1 ms once locked. |
| `syn-reconnect-backlog-90s.stct` | as above, 90 s drained in 5 s (`--backlog 0:90000:5000`: the .111 case) | As above; the line moves at 7 s; one gap marker (reason `backlog`) of 3.2–3.4 s per PID, then the live content (2.0 s of it lost). |
| `syn-reconnect-backlog-relock.stct` | 60 s live, the link away 30 s while the caller queues, drained in 1 s (`--backlog 60:30000:1000`): a reconnect into a running keep-listening listener | One relock (leap) and one gap of the outage per PID (reason `epoch`); then as the 30 s case, by the `backlog_ns` rule. |
| `syn-reconnect-backlog-3s.stct` | 3 s queued, drained in 2 s (`--backlog 0:3000:2000`): under `lead_max_ns` | The first epoch waits while the floor falls and moves onto it at 4 s; one overlap of about 3 s per PID (B-37's drop); nothing left ahead. |
| `syn-reconnect-backlog-relock-2s.stct` | 60 s live, 2 s queued, drained in 1 s (`--backlog 60:2000:1000`): a keep-listening reconnect with a backlog under `lead_max_ns`; added 2026-10-17, chapter 15.4 B-47 | One relock (leap) and one gap of the outage per PID; the line on the floor by `backlog_ns` at 65 s; two overlap runs per PID, the straddle rule's (63.3–63.5 s, the drain's tail on the old epoch) and the guard's once (67 s, about 2 s); the hole the first leaves, where each PID comes back to the new epoch, behind a gap marker (epoch, 1.8–2 s; B-48, before none); residual floor within 1 ms; never degraded (before B-47: the line 2 s above the floor for the whole trace). |
| `syn-reconnect-backlog-relock-3700ms.stct` | as above, 3.7 s queued (`--backlog 60:3700:1000`): a 7–10 s network loss behind a queuing caller | As above (the straddle run's hole 1–1.2 s per PID, behind a gap marker since B-48); the PES the seed would put past 4 s stale (reason `backlog`), the guard's run at 68 s; never degraded (before: degraded 6.5 s after the reconnect, 30 s dropped). |
| `trace-srt-reconnect-backlog.stct` | a real SRT reconnect backlog on .111: a standalone listener into `mrtsrestamp`, the paced caller queuing 90 s, its 85.5 s backlog in 0.59 s; added 2026-10-16, chapter 15.4 B-45 | Never degraded, no relock; one overlap (backlog) at 3.3 s; no PES more than 4 s ahead; locked at 38 s; the SRT floor's +2.85 ms step at 35 s bends ε to 43–71 ppm (B-46), held as the ceiling. |
| `syn-lead-clamp.stct` | generator: the AAC PID stamped 12.6 s ahead of the rest (`--ahead a2:12600`, #820's lead on one PID); the vMix recording has no lead to clamp (`trace-vmix-sparse-pcr`, B-85), so this stays the clamp's fixture until `trace-820-vmix-pcr` is recorded | Degraded (lead) at 5 s, timing from the video PID; `lead-clamp` on 0x102 at once and every 30 s; 0x102 at its earliest arrival from then on, after one overlap run of what it had left 13 s ahead; never recovered. |
| `syn-lead-clamp-floor-fall.stct` | as `syn-lead-clamp`, the path's floor 80 ms lower from 3 s (`--delay-ms 100,20@3`): the lines visibly above the floor for tens of seconds; added 2026-10-17, chapter 15.4 B-47 | As `syn-lead-clamp`: the clamp at degraded entry; no gap marker and no `backlog` reason (before: 0x102 stale as a backlog's, the clamp 28 s late with a 16.9 s gap and 30 s dropped). |
| `syn-lead-window.stct` | as `syn-lead-clamp-floor-fall`, the AAC PID 3.5 s ahead (`--ahead a2:3500`): 3.95 s on the floor, just under `lead_max_ns`, read up to 4.03 s under the line while it slews down; added 2026-10-17, chapter 15.4 B-48 (D1's window) | Never stale, no `backlog` reason; the lead row's: degraded (lead) at 8.6 s, recovered at 44.7 s, the switches' 0.6 s per PID (before: 5.8 s of 0x102 dropped as overlap (backlog) in 21 runs with gap markers). |
| `trace-gate01-rist-20010-ahead-3900ms`, `-3950ms` (derived) | `trace-gate01-rist-20010` with PID 200 stamped 3.9 and 3.95 s later (`fixture_gen --shift 200:3900 -i trace-gate01-rist-20010.stct`): `lead_max_ns` + 70 and + 120 ms on the gate's real delivery; added 2026-10-17, B-48 | Never stale, no `backlog` reason; degraded (lead) at 195 and 191.7 s, B-8's clamp on PID 200 2.8 s after it and at it, told every 30 s (before: 34.5 and 76.5 s of PID 200 dropped as overlap (backlog), no clamp); since B-90's exit rule recovered at 345.8 and 245.6 s and degraded again at 380.3 and 270.2 s, each switch moving PID 200 by its 4 s lead (11.4 and 12.4 s dropped in all, against 5.6 and 7.1 s latched). |
| `syn-wrap-33bit.ts` (chapter 3) + generated arrivals | `fixture_gen --wrap-at 5 --trace` | No backward PTS/DTS across the wrap, PCR unwrapped. |
| `syn-pes-header-split.ts` (chapter 3) | — | Header span rewrite; no other PID delayed. |
| `cap-srt-ingest-1316.ts`, `cap-occ-1080i-h264-aac-ttx.ts` (chapter 3) | — | Byte-level rewrite on real chunking (1316-byte datagrams, PSI anywhere). |

#### 7.3 Element and protocol tests, both runners

- Python runner process: `gst_mrtsrestamp_element_test.py`,
  `gst_mrasrc_element_test.py` (appsrc/appsink harnesses, allowed under
  chapter 3 part 4.5 rule 1), and the WI-P1-7 cases in
  `gst_mrtsstamp_element_test.py` and `gst_bus_stamper_test.py`; all added
  to `packages/engine/package.json` `test:py`.
- `native_runner_protocol_test.py` (native runner, black-box) and a new
  `gst_ingest_restamp_test.py` (Python runner): case `ingest-restamp`
  runs `appsrc (cap-srt-ingest-1316.ts, arrival in PTS) ! mrtsrestamp
  arrival=buffer-pts ! buildBusSink` with one consumer edge attached over
  `unixfdsink`→`unixfdsrc`, and asserts: (a) every PES-bearing bus buffer's
  stamp equals `house_from_mux_pts` of its first timing PES's PTS exactly
  (the identity rule, `ts_timeline.cpp:193–200`, `:902–942`); (b) a gap
  marker produced by a live `offset-ns` edit arrives at the consumer with
  GAP|DISCONT flags, its PTS and its encoded length intact (the bus
  carries `flags` and the bytes, part 3.5), and the same through
  srt-input's real module string (`SrtInputModule.ts:120` queue) in a
  module-level case; (c) `mrtsrestamp-stats` reaches the engine as
  plugin event `mrtsrestamp-stats:restamp`. Case `identity-base-time`
  (WI-P1-7). Both runners must produce the same events (§13.1: no twin;
  the check is that both runners host the one element identically).
- Module tests (vitest) for the seven modules as in WI-P1-10…13, and
  `busRunnerContract.test.ts` updated for the `enable(...)` signatures.

#### 7.4 What "existing consumers keep working" is tested with

Nothing new in the consumers (frozen, Q2). The proof is the gate run of
part 11.2 plus one dev-box protocol case per consumer class in
`native_runner_protocol_test.py`: a restamped ingest feeding (a) a
presentation leg with `alignBranchesToStamps`, (b) a transform producer with
per-AU retime, (c) a 302M mixer branch with `ignore-pcr`; each run through a
5 s source outage. Pass: retime logs one "epoch #2 on its stamps" line, off
the prediction by the gap the restamp signalled for that restart (to 1 ms,
chapter 15.4 B-42), and no "K moved" line; branch alignment completes;
the mixer branch keeps running; no runner restart.

### 8. Manager and UI

| Item | Change |
|---|---|
| Settings added | `ingestOffsetMs` (Ingest Offset, ms, default 0, live; range ±10,000 ms, OQ-14) on rist-input, srt-input, mpegts-ip-input, audio-input-302m, aes67-input, audio-encoder, video-encoder (O on captures per §5.5 and §11.1; no trim there, OQ-15). `pidTrimsMs` (Per-PID Trim, ±2,000 ms per PID, default empty, live, `pidTrim` widget) on rist-input, srt-input, mpegts-ip-input. |
| Settings removed | None (the Q9 settings go in Phases 2–4). |
| Settings changed | audio-encoder `srcBufferMs`: range 40–85 ms (quantum of the PipeWire stream) instead of 40–1000 (pulsesrc ring), OQ-16. |
| Settings disabled | None in Phase 1 (Trust arrives in Phase 5; the widget already supports a disabled-with-reason state). |
| Network ingest card | Badge `clock`: "Locked" (green), "Acquiring" (grey), "Degraded" (amber), "No PCR" (amber). Section **Clock**: State (with the PCR's cadence when it is over the 100 ms spec: "Locked (PCR every 2.0 s)", chapter 15.4 B-86), Source rate (ppm, 2 decimals), Residual p99 (ms), Re-locks, Last event (reason, age). One section per PID (`pid-<n>`, label "PID 0x0100 · H.264 video"): Lead min/median/max (ms), Trim (ms), Shift O+trim (ms), Dropped (PES, last 10 min). Phase 0's `timing` section shows output lateness, negative by the lead. |
| PCM capture card | Section **Clock**: ASRC ratio (ppm), Phase error (ms), Re-locks, Ingest offset (ms). |
| video-encoder card | Ingest offset (ms) in the Phase 0 `timing` section; lateness shows encode latency. As built (chapter 15.4 B-26): the offset is in WI-P1-9's capture card, a Clock section; the output lateness is the encode latency, read on running time (exact under the encoder's natural base time, fixed 2026-10-22), and shows once a consumer is connected. |
| Health | Warnings of part 10 via the module's own-warning path. |
| Device Manager | None. |
| Local control panel | None beyond what status sections already render. |

### 9. Image and Yocto

None. `mrtsrestamp` and `mrasrc` live in `libgstmrtshouse.so`, built and
installed by the existing recipe steps (Yocto:
`meta-layers/meta-custom/recipes-apps/media-router/media-router.bb`,
lines 156–157 and 166). `mrasrc` uses `gstreamer-audio-1.0` from
`gstreamer1.0-plugins-base`, already in `DEPENDS` and `RDEPENDS`
(`media-router.bb:33–36`, `:41–47`). If the Pi 4 bench forces the speexdsp
fallback (WI-P1-8), `speexdsp` is added to `DEPENDS` and `RDEPENDS` (recipe
in `openembedded-core/meta/recipes-multimedia/speex/speexdsp_1.2.1.bb`);
that is the only conditional change. No service or config changes.

### 10. Telemetry and alarms

| Signal | Source | Fields | Engine use |
|---|---|---|---|
| `mrtsrestamp-stats` | element, per program, every 2 s | `program`, `state`, `reason`, `ppb`, `offset-drift-ns`, `residual-min-ns`, `residual-p50-ns`, `residual-p99-ns`, `residual-max-ns`, `pcr-interval-max-ns`, `cadence-warning`, `pcr-cadence-ns` (the PCR's own cadence, 0 while unknown) and `pcr-gap-max-ns` (the longest late interval of the last minute; chapter 15.4 B-86), `relocks`, `gaps`, `gap-ns-total`, `dropped-pes`, `dropped-ns-total`, and the element-wide `cc-lost` and `desync-bytes` (the same in every program's message) | Clock section, badge, alarms |
| `mrtsrestamp-pid` | element, per PID, every 2 s | `program`, `pid`, `stream-type`, `lead-min-ns`, `lead-median-ns`, `lead-max-ns`, `trim-ns`, `shift-ns`, `dropped-pes` | Per-PID sections, `pids` field options |
| `mrtsrestamp-event` | element, on occurrence | `kind`, `program` (−1 = the PAT), `pid` (−1 = all; a `degraded` event names the reference PID), `reason`, `gap-ns`, `dropped-ns`, `house-ns`, `epoch` | Log line (JSON) and the alarms below |
| `mrasrc-stats` / `mrasrc-event` | element | as WI-P1-8 (`dropped-frames`; a relock's `dropped-ns`) | Clock section, alarms |
| Chapter 3 counters | element properties | `desync-bytes`, `cc-lost`, `header-spans`, `psi-unsupported-sections`, `pes-no-pts`, `dts-discarded` | Alarm on `desync-bytes` or `cc-lost` rising (input corruption) |
| Phase 0 `mrlateness` | tap at the bus egress | lateness window | Output lateness: negative on network ingests |

Alarms (module health warnings; none drops content):

| Alarm | Condition | Text |
|---|---|---|
| Degraded clock (§5.3) | `state = degraded` | "Degraded clock: <reason> — timing from PID 0x… PTS against arrival" (the PID from the `degraded` event; without one, "timing from the reference PID's PTS") |
| Lead clamped | `lead-clamp` event in the last 60 s (posted at the clamp and every 30 s while it holds, chapter 15.4 B-45) | "Source lead above 4 s on PID 0x… — clamped" |
| Unstable source clock | > 3 relocks in 10 min | "Source clock unstable: n re-locks in 10 min (last: <reason>)"; degraded, the reference lock's: "Timing from PID 0x… PTS unstable: …" (chapter 15.4 B-90) |
| Source rate | \|ppm\| > 100 for 60 s, the 60 s from the last change of lock | "Source clock off by n ppm"; degraded: "Timing from PID 0x… PTS off by n ppm" (B-90) |
| PCR irregular | `cadence-warning` (a PCR interval late against the PCR's own cadence — twice it, at least 500 ms, at most 4 s — in the last 60 s; three degrade; chapter 15.4 B-86) | "PCR comes irregularly: gaps up to n, normally every n" (not shown while degraded on the cadence row) |
| ASRC ratio | \|ratio\| > 200 ppm for 60 s | "Device clock off by n ppm — check the device's sample rate" |
| Input corruption | `cc-lost` or `desync-bytes` increasing for 10 s | "Transport errors: n continuity errors in 10 s" |

Events without an alarm: `relock` (single), `gap`, `overlap` after a live
edit or a reconnect backlog (reason `backlog`), `recovered`, `psi-change`. Phase 0's lateness display applies
unchanged; its alarm is deferred (OQ-8).

The strings the reporter matches (WI-P1-9; 2026-10-14, chapter 15.4 B-11),
which WI-P1-4 posts: `state` is `acquiring`, `locked`, `degraded` or `lost`
(anything else reads Acquiring); the stats `reason` is `none`, `cadence`
(the card's "PCR missing", chapter 15.4 B-86), `rate`, `freeze`, `leap` or
`lead`; a relock's `reason` is `discontinuity`,
`leap`, `envelope-step`, `external` or `ref-change`; `kind` is `relock`,
`degraded`, `recovered`, `envelope-step`, `gap`, `overlap`, `psi-change` or
`lead-clamp`; a gap's `reason` is `epoch`, `edit`, `outage`, `jump` or
`backlog`, an overlap's empty or `backlog` (chapter 15.4 B-45). `cc-lost`,
`desync-bytes` and `dropped-pes` are running totals since the element started.

### 11. Verification on the test fleet

Run on 10.9.16.103 (Pi 5) and 10.9.16.108 (Pi 4), each case with
`MR_GST_RUNNER_NATIVE=1` and `=0`, after the Phase 0 release is installed
(the baseline numbers in rows marked "vs baseline" are measured on Phase 0
first). Part 11.1 runs on the Phase 1 development build as the work lands
and again on the Phases 1–4 release image at the release gate (chapter
11); part 11.2 runs on the Phase 1 development build only, because Phases
2 and 3 replace the consumers it checks (OQ-13). Tools: Phase 0's lateness display; the content-based A/V skew tool
(`avskew`; it is not in the submodule today, so WI-P1-17 checks it in
under `tools/avskew/` or cites its box path, so that V-P1-6 and V-P1-15
are reproducible); a bus tap (a `unixfdsrc` client on the producer's socket
writing buffer PTS + bytes, then `mrts_cli dump`); `mrts_cli
restamp-replay`; `tools/runner-cpu-profile.sh`; journal greps.

#### 11.1 Producers

| # | What | How | Pass |
|---|---|---|---|
| V-P1-1 | Lock on a clean feed | srt-input from a CBR encoder (#816 rig), 24 h | 0 relocks; ppm steady ±0.1 after 2 min; residual p99 ≤ network jitter p99 + 1 ms; Clock badge "Locked" throughout |
| V-P1-2 | Identity on the bus | bus tap on each of the 7 producers, 10 min | For every PES-bearing buffer, stamp = `house_from_mux_pts` of the first timing PES's PTS exactly (the `stamp_house` rule); a PES-less buffer repeats the last stamp; no backward PTS/DTS per PID |
| V-P1-3 | Source restart | stop the SRT caller 5 s, restart; same for RIST and UDP; and an SRT caller that queues (added 2026-10-16, chapter 15.4 B-39): its listener disabled 30 s and 90 s, and network losses of 30 s and of 8–9.5 s under the keep-listening listener (the short ones leave backlogs of 2.6–4.6 s, added 2026-10-17, B-47) | One `relock` and one gap per PID ≈ outage ± 50 ms; output PTS monotonic per PID; no consumer restart. With the queuing caller: never degraded, no PES decoded more than 4 s ahead of its arrival (video by its DTS: its PTS lies up to its reorder delay later; corrected 2026-10-17, B-48), the egress back at its source lead within 10 s of the reconnect, every hole in a PID's output behind a gap marker; with more than 4 s of backlog what the seed would put past 4 s dropped as overlap (`backlog`) |
| V-P1-4 | Discontinuity and rewind | replay `syn-pcr-discont` and `syn-rewind-1s` into mpegts-ip-input over UDP | Events and output as the fixture's expectation |
| V-P1-5 | Degraded fallback | vMix feed (#820) | Degraded warning within 10 s; output lead ≤ 4 s on every PID; no runner restart; output decodes (the owner's vMix in VBR mode locks since B-86 and is V-P1-20's; this row is #820's CBR mode: a dense PCR that stops, degraded at 1.5 s; recovery is pinned by `syn-lead-window` and `syn-pcr-stop-sparse`; B-85, B-86) |
| V-P1-6 | Live O and trim | O +500, then −500; trim +200 ms on the audio PID | Gap of 500 ms ± 1 frame; 500 ms dropped; after an mpegts-muxer, `avskew` A/V moves by 200 ± 2 ms and back |
| V-P1-7 | ASRC | audio-input-302m on .108 from the USB interface, 1 h | ASRC locked within 37 s (WI-P1-8 measured 35–36 s against the draft's 30 s); on the bus, 302M PES PTS deltas equal sample count / 48 kHz to ±1 tick over 1 h; no audiomixer discont downstream (wf11's hour on .108 under the profile's load, busy 90–94 %, failed this: 28 and 105 relocks and as many PES pairs off, while the capture's PipeWire node ran SCHED_OTHER on the runner's main loop; it now runs on the runner's RT data loop, and B-88's device check repeats that hour; chapter 15.4 B-88) |
| V-P1-8 | video-encoder | ATEM/USB capture on .108, 1 h | PES − 1 h − v4l2 capture time within one frame; egress rate flat (no 2.3 s bursts, ADR-0005 Stage 3e check); lateness = encode latency, stable |
| V-P1-9 | audio-encoder | null-sink capture, 12 h | No ring-sized PTS steps on the bus; lateness stable ±5 ms; Opus/AAC decodes at a consumer with no discont |
| V-P1-10 | CPU | `runner-cpu-profile.sh` on each ingest at 10 and 30 Mbit/s, and on 302M 2 ch / 8 ch captures | Restamp runner CPU on a Pi 4 ≤ +0.05 core per 30 Mbit/s ingest, ≤ +0.035 core per 302M capture, against today's armed `mrtsstamp` + conditioner on the same wiring (the owner's budget, 2026-10-16/17; measured +0.040–0.044 and +0.033 core, ADR-0029's S0 Budget: pass) |
| V-P1-11 | Runner parity | every row above with both runners | Same events, same bus bytes (tap diff) |
| V-P1-20 | Steady sparse PCR locks (chapter 15.4 B-86) | srt-input on .103 calling the owner's vMix (`srt://10.9.2.53:10000`, VBR mux, a PCR every 2 s), 30 min, one engine restart | Clock badge Acquiring for at most 90 s, then Locked (green) with State "Locked (PCR every 2.0 s)" for the rest; no `degraded` event, no cadence warning, 0 re-locks, Source rate 5–30 ppm, Residual p99 under 100 ms; the video-player behind it plays without steps across the clip's 180 s loop; the engine log shows no `mrtsrestamp-event` but the PSI pair per start |

#### 11.2 Consumers keep working (K becomes constant)

Development checks, not release claims: Phases 1–4 ship together (OQ-13,
the owner, 2026-10-12), so these consumers never meet Phase 1 stamps in
the field. They prove Phase 1 against the consumers of the day on the test
boxes before Phases 2 and 3 replace them.

| # | What | How | Pass |
|---|---|---|---|
| V-P1-12 | K constant at per-AU retime | transcoder and audio-transcoder fed by srt-input, 24 h with 5 forced source restarts | Retime logs show each new epoch off the prediction by the gap the restamp signalled for that restart (to 1 ms, chapter 15.4 B-42) and no "K moved" line (`branch_retime.cpp:215–217`, Python equivalent); no egress re-anchor events from the 7 producers (`timeline_reanchor`, `timeline_conditioned`, `timeline_settled` count = 0) |
| V-P1-13 | Subtitle K | teletext-subtitles and a KLV route fed by the OCC ingest on .103 | `StampModel` never resets K except at a restart; cue timing vs video unchanged vs baseline (±1 frame) |
| V-P1-14 | Branch alignment | video-player + audio-decoder from one ingest | "branchAlign … offsetNs" logged once per incarnation; no "joined only" failure |
| V-P1-15 | A/V through a muxer | ingest → mpegts-muxer → player, and ingest → transcoder → srt-output → second box | `avskew` within ±5 ms of baseline, and within ±5 ms of its own pre-restart value after each source restart |
| V-P1-16 | 302M mixer branches | audio-input-302m and srt-input audio → audio-mixer → audio-output-302m | Mixer runs 24 h with no branch restart; output continuous |
| V-P1-17 | *Removed* with WI-P1-16 (OQ-13, 2026-10-12): no release presents at `stamp + D` on source-natural stamps | — | — |
| V-P1-18 | D raises from capture latency | capture producers → presentation legs | At most one D raise per leg per start (`PlayoutRaises`), no backlog-shed events |
| V-P1-19 | Mixed fleet (R20) | a Phase 1 box's ingest relayed by srt-output to a box on the previous release | The old box plays it; its stamper re-anchors once and holds |

### 12. Risks specific to this phase

| # | Risk | Design ref | Mitigation |
|---|---|---|---|
| R-P1-1 | **Latency and queue load on direct routes during development.** Until Phase 4 lands on a box, outputs present at `stamp + D` while stamps are source-natural, so a route from a network ingest to an output is later by the timing PID's lead (typically 0.3–1 s) and holds that lead in its queues; the video player's 1 s leaky ES queue overflows for leads near 1 s. No field exposure: Phases 1–4 ship as one release (OQ-13, 2026-10-12). | R12, §9.4 (holds only once outputs play on arrival) | Development and test boxes only: set O = −(min lead) on a direct route under test, or route through a muxer; WI-P1-16 and V-P1-17 removed. |
| R-P1-2 | **Capture latency becomes visible.** Captures stamped at capture time arrive at the bus late by their capture/encode latency (PipeWire quantum, encoder delay), so presentation legs may raise D once. | R12 | V-P1-18; expected and correct per §9.5; noted in release notes. |
| R-P1-3 | **PCR lock quality** on real sources. | R4 | Two-stage estimator with integer replay; tuning from field traces (WI-P1-6); degraded fallback; telemetry on every card. |
| R-P1-4 | **Arrival is not what the design text names for SRT.** srtsrc stamps send time, not receipt (part 3.1). Using it would land SRT content earlier by the SRT latency and break Phase 5's transit check. | §5.1, §10.4 | Arrival read by the restamp at chain entry (part 4.1); OQ-19 decided, the design doc's §5.1 corrected. |
| R-P1-5 | **Gaps are invisible past a sidecar.** `mr-tssplit` and `mr-bus-fanout` write `flags = 0`, so a gap marker does not cross a splitter until Phase 2's pass-through forwards it. | §5.2, §6 item 4 | Phase 1 has no gap consumer yet (aligners wait in Phase 2); Phase 2 section must forward flags and duration. |
| R-P1-6 | **Monotonicity at ingest.** A relock, edit or straddle could emit a backward PTS. | R18 | Per-ES guard on DTS-or-PTS; fixtures `syn-rewind-1s`, `syn-straddle-audio`; V-P1-2. |
| R-P1-7 | **Wrap** in the STC or PTS unwrap. | R19, S9 | Continuous unwrap seeded from the STC; `syn-wrap-33bit` with arrivals; `mrts_bench --wrap-at` (chapter 3). |
| R-P1-8 | **ASRC cost and quality on a Pi 4.** | R5 | Bench in WI-P1-8 with a quality fallback and a speexdsp backend; one resampler per path. |
| R-P1-9 | **pipewiresrc timestamps** may not be device-timed, or may step like pulsesrc. | R5, §5.4 | WI-P1-12 spike; the lock tolerates one-sided noise; fallback to `pw_time` via reference-timestamp meta. |
| R-P1-10 | **audio-encoder source change** (pulsesrc → pipewiresrc on a sink monitor) regresses capture, routing or memory. | — | OQ-16; same pattern as audio-input-302m, already in the field; V-P1-9 12 h soak. Found 2026-10-22 (chapter 15.4 B-88): the change moved the stream's node from pipewire-pulse's RR 20 loop (as `pulsesrc`) onto the runner's SCHED_OTHER main loop (as `pipewiresrc`), where a busy box costs a capture whole cycles, as audio-input-302m's showed on .108. Both captures' nodes now run on the runner's RT data loop (`node.loop.class=data.rt`), with the image's rtkit limits raised for the Master boxes' 12 encoders; the 302M captures of B-88's device check run the same path. |
| R-P1-11 | **tsdemux consumers read a long gap as a PCR error.** | §6 item 2 (a2 failure modes) | `discontinuity_indicator` on the first PCR after a gap ≥ 1 s; V-P1-3, V-P1-12. |
| R-P1-12 | **PSI or PES edge cases** in the restamp parse are a silent loss on an ingest. | R1 | The restamp only reads headers and never reassembles payload; chapter 3 fixtures at three chunkings; counters alarmed (part 10). |
| R-P1-13 | **Base-aware identity** changes a frozen file's behaviour. | Q2 | Identical result for every base-0 pipeline (pinned by existing tests); only video-encoder has a non-zero base. |
| R-P1-14 | **Mixed-version fleet.** | R20 | A new box's stream carries the source lead in its PCR instead of `PTS − 250 ms`; old boxes re-anchor it as foreign (V-P1-19). |
| R-P1-15 | **Two timing settings on one ingest** (D and O) coexist only on development builds: the release that adds O removes D with Phase 4 (OQ-13). | R14 | Distinct titles and help text on the development builds; the release notes describe O and the per-PID trim only. |

### 13. Open questions

| # | Question | Why the design doc does not answer it | Blocks | Proposed default |
|---|---|---|---|---|
| OQ-11 | §5.2 maps a straddling PES "by whichever mapping's STC range contains it". When both epochs' ranges contain it (a rewind shorter than the lead window), which wins? | The text defines no range and no tie-break. | WI-P1-1 (`VirtualStc::map`), WI-P1-3, fixtures `syn-rewind-1s`, `syn-straddle-audio` | **Plausible lead**: range = [first PCR − 1 s, last PCR + 4 s] per epoch; in one range → that epoch; in neither → newest; in both → the epoch whose lead for this PES is closest to the PID's median lead before the re-lock. |
| OQ-12 | How is a gap carried on the bus, given that GStreamer events do not cross `unixfdsink` (part 3.5) and that the marker must survive the time-bounded leaky module queue after the restamp (srt-input's `queue leaky=2 max-size-time=100000000`, part 4.1)? | §5.2 says "a GStreamer gap event", which cannot reach another process. The draft's form (PTS = gap start, `duration` = gap length) was dropped during assembly: `GstQueue` adds a buffer's duration to its time level (`gstqueue.c` `apply_buffer` :681–688), and `leaky=2` discards from the head while the queue reads as full (`gst_queue_leak_downstream`, :1314), so in srt-input the marker alone would read as lead + SRT latency + gap of fill against 100 ms and be leaked before the src task popped it. | WI-P1-3, WI-P1-4, WI-P1-7; Phase 2's aligners (WI-P2-6), Phase 3's demux (WI-P3-1, -2) and Phase 5's writer (WI-P5-2) read it | **A GAP\|DISCONT-flagged buffer** of adaptation-only TS packets, one per affected PID, with PTS = the gap's **end** (bus stamp convention) and **no duration**; the gap length is carried in the adaptation field's `transport_private_data` of those packets. Survives unixfd; sidecars forward it from Phase 2; adds nothing to a time-level queue. Alternatives: a serialisable `GstMeta` (unixfd forwards `n_meta`), or a marker in input-PTS convention mapped by `mrtsstamp`. |
| OQ-13 | Outputs present at `stamp + D` until Phase 4, so source-natural landing adds the source's lead to every direct ingest → output route in Phases 1–3 and can overflow the player's 1 s leaky ES queue. Accept, and raise the queue floor? | §9.4 says source-natural landing "costs nothing at an output" because outputs play on arrival, which holds only from Phase 4. The proposed default edits a mechanism this design removes in Phase 4 (the leaky player ES queue) inside the frozen model, so it needs an explicit Q2 exception (§13.1: "no field fix is made to a mechanism this design removes"). The Q2-conforming alternative is no change: document the interim latency and recommend a negative O. | WI-P1-16; release notes; V-P1-17 | **Accept** the interim latency, **raise the video-player ES queue floor to 3 s** in Phase 1, and recommend a negative O in the release notes where latency matters. *Decided 2026-10-12 by the owner, not the default: Phases 1–4 ship as one release, so there is no interim; WI-P1-16 and V-P1-17 are removed.* |
| OQ-14 | Range of the ingest offset O. | §5.5 bounds the trim (±2 s) but not O. | WI-P1-9 schema | **±10,000 ms**, step 1 ms. |
| OQ-15 | Do the capture producers (audio-input-302m, aes67-input, audio-encoder, video-encoder) get the per-PID trim as well as O? | That they get O is answered: §5.5 ("one offset O per ingest"), A.3 (an ingest is "a network input, a capture, a file or an HLS player"), §11.1 (the four under the Ingest role) and Q11 (O on the microphone ingest, a PCM capture). For the trim, §13.1 (Q6) says each detected PID can carry a signed trim and does not exempt single-PID ingests, so omitting it on captures is an operator-visible simplification (§13.3). | The `pidTrims: false` manifest field of WI-P1-11…13; part 8 | **No trim on captures** (one PID, where O is the same thing); O on all seven. |
| OQ-16 | audio-encoder: capture with `pipewiresrc` on the null-sink (device timing) instead of `pulsesrc`, with `srcBufferMs` limited to 40–85 ms? | §11.1 asks for "capture time from device timing" but names no element; the change alters an operator setting's range. | WI-P1-12, part 8 | **Yes**, same pattern and clamp as audio-input-302m. |
| OQ-17 | At what cadence does an ingest send gap markers during an outage? | §5.2 says the ingest signals a gap "as soon as it knows of it", §6 item 4 that an ingest that has lost its source sends a gap, and R21 relies on ingests signalling gaps so they are never mistaken for silent, which only works if a marker arrives before an aligner's W fires; the cadence itself is unspecified. (An element can push from its own `GstTask` under the stream lock, as `queue` and `rtpjitterbuffer` do, so there is no thread obstacle.) | WI-P1-4 | **At detection (≥ 1 s without packets) and every 250 ms thereafter**, each marker with PTS = now and the length so far, plus one on resume and on live edits; the alternative is markers only on resume, with Phase 2's W as the fallback either way. |
| OQ-18 | hls-player's egress (`mr-bus-fanout` with the anchored stamper) is not in §14's Phase 1 row, but Phase 2 deletes that stamper. Which phase moves HLS to "house time at playout start plus media offset" (§5.4), and are the splitter, the three 302M aligner modules and the HLS fan-out then the only anchored-stamper users left? | §14 lists no phase for the hls-player row of §11.1. (Shared with chapter 6: the Phase 2 draft assumed Phase 1 had done it.) | WI-P2-2, -3, -5; Phase 2's deletion | **Phase 2**, in WI-P2-5, the same release that deletes the stamper; Phase 2 does not ship until `grep` finds no other anchored user. |
| OQ-19 | §5.1 names "the timestamp the network source element assigns on receipt (`udpsrc`, `srtsrc`, `mrristsrc`…)". srtsrc's timestamp is the send time (part 3.1). Is arrival "when the transport hands the packet over, after its recovery buffer", read by the restamp itself? | The design text assumed srtsrc stamps receipt; the 1.28.2 source shows otherwise. | WI-P1-4 (`arrival=clock`), WI-P1-10; Phase 5 transit check | **Yes**: arrival = clock at the restamp, placed directly after the transport element; the ADR records the correction. |

All nine were decided on 2026-10-12 (chapter 15.1): OQ-13 by the owner,
against the default — Phases 1–4 ship as one release, so WI-P1-16 and
V-P1-17 are removed; OQ-11, OQ-12, OQ-14, OQ-15, OQ-16, OQ-17, OQ-18 and
OQ-19 by the orchestrator (owner delegated), each at its default. The
items follow the decisions: WI-P1-1 and WI-P1-3 (OQ-11); WI-P1-3, -4, -7
(OQ-12); WI-P1-9 (OQ-14); WI-P1-11, -12, -13 and part 8 (OQ-15); WI-P1-12
(OQ-16); WI-P1-4 (OQ-17); WI-P1-4, -10 (OQ-19). OQ-18 blocks nothing
here. OQ-11 was refined during the build on 2026-10-14 (part 4.4; chapter
15.4 B-1), and the build's other decisions are recorded in chapter 15.4.

### 14. Estimate

| Work item | Added | Tests added | Deleted | Days |
|---|---|---|---|---|
| WI-P1-1 ClockLock / PcrValidator / VirtualStc | 520 | 480 | — | 5 |
| WI-P1-2 Traces, CLI, generator | 280 | 160 | — | 2 |
| WI-P1-3 RestampCore | 950 | 850 | — | 8 |
| WI-P1-4 `mrtsrestamp` (4a + 4b) | 700 | 350 | — | 5.5 |
| WI-P1-5 Capture session, expectations | — | 200 (+ fixtures) | — | 3 |
| WI-P1-6 Tuning by replay, ADR | 80 | — | — | 2 |
| WI-P1-7 Identity stamper edits | 60 | 140 | — | 1.5 |
| WI-P1-8 AsrcServo, `mrasrc`, bench | 650 | 380 | — | 7 |
| WI-P1-9 Engine glue, settings injection | 480 | 420 | — | 4 |
| WI-P1-10 Network ingests | 120 | 260 | — | 2 |
| WI-P1-11 302M input, AES67 | 90 | 200 | — | 2 |
| WI-P1-12 audio-encoder | 60 | 120 | 40 | 2 |
| WI-P1-13 video-encoder | 30 | 80 | — | 1 |
| WI-P1-14 Manager UI | 380 | 220 | — | 3 |
| WI-P1-15 Deletions | — | — | 230 | 1.5 |
| WI-P1-17 Docs, release, gate | 150 | — | — | 6 |
| Review and rework (10 %) | | | | 6 |
| **Total** | **≈ 4,550** | **≈ 3,860** | **≈ 270** | **≈ 61.5** |

Lines added ≈ 8,410 including tests, plus ~15 binary trace fixtures
(≤ 2 MB each). Lines deleted ≈ 270. Chapter 3's module (≈ 16 days) is a
prerequisite and is not counted here.

**Critical path** (one engineer on it, ≈ 30 working days elapsed after
chapter 3's core): chapter 3 WI-S0-1…5 → WI-P1-3 (8) → WI-P1-4b (4) →
WI-P1-6 (2, also needs WI-P1-5's traces) → WI-P1-10 (2) → WI-P1-17 (6).
WI-P1-1 runs in parallel with chapter 3 (no TS dependency) and must finish
before WI-P1-3's mapping work; WI-P1-4a (after WI-S0-7/8) and WI-P1-5 run
while WI-P1-3 is built. A second engineer takes the ASRC chain (WI-P1-8 →
WI-P1-11, WI-P1-12), the identity edits and video-encoder (WI-P1-7 →
WI-P1-13), and the UI (WI-P1-9 → WI-P1-14); WI-P1-8's Pi 4 bench is the
item most likely to slip (R5).

## 6. Phase 2 — Splitter pass-through, aligners, the anchored stamper deleted

| Field | Value |
|---|---|
| Chapter | 6, work-item prefix P2 |
| Implements | §14 row 2 |
| Ships in | The Phases 1–4 release, developed after Phase 1 (§13.1: phases in order; OQ-13: one release) |
| Code baseline | submodule `fc17468` (branch docs/house-clock-timing-design); every path below was checked with `ls`/`grep` on 2026-10-12 |
| Paths | relative to the submodule unless marked "Yocto:" (relative to `/home/mrstation/media-router-yocto`) |
| Builds on | S0 (chapter 3, the shared TS module: `libgstmrtshouse.so`, `mrts::PesAssembler`, `Unwrapper`, `PsiDiscovery`, the loaders `native_plugins.{h,cpp}` / `gst_native_plugins.py`, `fixture_gen.cpp`, `mrts_cli dump`); P0 (chapter 4: `mrlateness`, `LatenessReporter`, the `timing` status section); the Phase 1 section (ingest restamp `mrtsrestamp`), whose preconditions are listed in part 3.1 |

"§n" refers to `docs/house-clock-timing-design.md` v0.6. "#837" is commit
`d984cf1` (PR #837), reverted by `2bbd57e`.

### 1. Goal

Phase 2 makes P3 true on every internal hop (§14 row 2: "Splitter
pass-through; mixers and audio processing on identity egress (as #837);
aligners wait for data or a gap and never drop; muxer keeps sparse-PID
PTS; ducking in the pipeline; the anchored stamper, the conditioner and
their twins deleted"). After this release:

- The ts-splitter passes PES bytes untouched and copies the program PCR.
  Nothing in it estimates or conditions time.
- The 302M mixers (audio-mixer, n1-mixer-302m) and audio-processing take
  their inputs on content time and leave on identity egress, which is the
  result #837 verified on a Pi 4, without #837's mechanisms.
- Every aligner (each `audiomixer`, the processing interleave, the
  mpegts-muxer's `mpegtsmux`) waits for data or a gap on every input and
  never drops a late input. A per-input silence watchdog declares an input
  absent after W, fills it with gaps at the aligner's pace, and lets it
  rejoin at the current position.
- The muxer keeps the PTS of sparse PIDs (KLV, subtitles) instead of
  restamping them to the mux position.
- Ducking runs in the pipeline on a PTS-aligned key, through a PTS-aligned
  interleave.
- Identity is the only bus stamp mode. The anchored stamper, the wire
  conditioner, latch repair, the drift servo and the runner glue are
  deleted in the same release; their Python twins stay as reference and
  leave every runtime path (OQ-1). ADR-0005 decisions 2 and 4 and ADR-0018
  are superseded.

### 2. Design references

| Reference | What it decides for this phase |
|---|---|
| §14 row 2; §13.1 "Every phase is a cut-over" | Scope; the mechanisms go in this release; no flag, no legacy arm; rollback is the previous release from the Device Manager. |
| P3, §6 item 1 | PTS in = PTS out on every node; an aggregator's output grid is the only derived timestamp. |
| §6 item 4 (decided, Q8) | Aligners hold every input until the slowest has delivered data or a gap; a late input is waited for, never dropped; W is a silence limit (a few hundred ms, about 3× the usual gap between arrivals, ≥ 100 ms); the pace rules (up when a slower input joins or an input slows; holds while an input is absent; down only when an operator removes the slow input; starts at what the configured inputs need); a returning input rejoins at the current position and its stale frames are discarded; in GStreamer the watchdog sits beside the aggregator and fills an absent input with gaps. |
| §6 item 5 | `mpegtsmux` writes `PES PTS = running time + 1 h` and a house-locked PCR; a mux output needs no stamp beyond identity. |
| §6 item 6, §11.1 ts-splitter row, §11.2 | Splitter: PES untouched, each output carries the program PCR that `mr-tssplit` already re-injects, no stamper. |
| §6 item 7 | No conditioner, re-anchor, latch repair, drift servo or branch alignment between ingest and egress. |
| §11.1 audio-mixer / n1-mixer-302m, audio-processing, mpegts-muxer rows | Formula demux, identity egress, the key aligned by PTS, ducking in the pipeline, sparse PIDs kept. |
| §11.3 items 1, 2, 4, 5 | What stands in the way: the splitter is a second ingest; mixers bake transit into the timeline; `interleave`, the `Date.now()` ducker and the sparse restamp align by arrival; fixed budgets (mux 2.4 s, 302M mixers 20 ms or 200 ms). |
| §11.4 rows 1, 2, 9 | Anchored stamping and the wire conditioner are removed from every hop (≈ 5,300 lines shared with identity mode); identity egress is kept and becomes the only mode. |
| §11.5 lead, items 7, 10 | Splitter pass-through on the shared TS module; ducking on a PTS-aligned key and a PTS-aligned interleave; a silence watchdog on every aligner input. |
| §13.1 "Phase 2 takes what was good from #837" (Q7); R15 | Keep identity egress, inputs on content time, the mixer waiting for its slowest input; drop the per-demux retime, the pacer slack and the `max(mixLatencyMs, D)` budget; #837's verification scenario becomes a conformance fixture. |
| §13.1 "Today's timing settings fall away" (Q9), R13 | `mixLatencyMs` goes with the fixed mixer budgets; nothing migrated. |
| §13.1 "The current model is frozen" (Q2), R16 | Nothing in the mechanisms this phase deletes is fixed beforehand. |
| §13.1 "One shared native TS module"; §13.3 rows "Silence watchdog", "Shared TS module" | Native only, both runners, no Python twin; the watchdog's design is the engineer's, recorded in the ADR. |
| R9, R10, R15, R18, R21 | Queue memory, hidden arrival/sample-count behaviour, the #837 repeat, monotonicity, W misfire. |

### 3. Current state

#### 3.1 Preconditions from Phase 1 (who still stamps by anchoring)

Today every bus egress is stamped by `mrts::TimelineStamper` (C++) or its
Python twin. Four producers use identity mode (`houseTimelineEgress: true`):
`plugins/transcoder/engine/TranscoderModule.ts:300`,
`plugins/audio-transcoder/engine/AudioTranscoderModule.ts:246`,
`plugins/mpegts-muxer/engine/MpegTsMuxerModule.ts:254`,
`plugins/teletext-subtitles/engine/TeletextSubtitlesModule.ts:129`.
Everything else is anchored. Phase 1 (§14 row 1) moves the ingests and
captures off it. This section assumes that, after Phase 1, the anchored
stamper has exactly these users left, and is written under that assumption
(OQ-18):

| Producer | Stamper today | After Phase 1 (assumed) | Phase 2 |
|---|---|---|---|
| rist-input, srt-input, mpegts-ip-input | anchored + conditioner, latch repair | `mrtsrestamp` (virtual STC) | — |
| audio-input-302m, aes67-input, audio-encoder (`conditionStepMs: 100`) | anchored + conditioner | identity | — |
| video-encoder (`liveCaptureClock`) | anchored | house time, identity | — |
| hls-player via `mr-bus-fanout` / `unixfd-fanout.py` | anchored, no repair | PES on house time (§5.4) | fan-out on identity (WI-P2-5) |
| ts-splitter (`mr-tssplit`) | anchored + conditioner, latch repair | unchanged | pass-through (WI-P2-4) |
| audio-mixer, n1-mixer-302m, audio-processing | anchored (runner splice) | unchanged | identity (WI-P2-3, -8, -9, -10) |

#### 3.2 The anchored stamper, the conditioner and their twins

§11.4 counts ≈ 5,300 production lines, shared with identity mode. The split
below is what this phase keeps for identity egress and what it deletes.

| File | Lines | What it holds | Kept for identity | Deleted |
|---|---|---|---|---|
| `plugins/mpegts-core/native/mrts/ts_timeline.h` / `.cpp` | 370 / 1,085 | `timing_pes` (:172), `TimelineLatch` (:224–255), `TimelineStamper` anchored path, latch repair, watch, staleness net, late/early tiers, drift servo (:257–601), conditioner (:602–846), `stamp_house` identity (:902–942), event JSON builders and `drift_stats_json` (:1040–1085). S0 moves `house_from_mux_pts`, `unwrap_near`, `pts90k_to_ns` and the field writers out in Phase 1. | `timing_pes` (branch retime needs it until Phase 3); `stamp_house` logic, moved to `mrts::IdentityStamp` | everything else |
| `plugins/mpegts-core/native/mrts/tests/ts_timeline_test.cpp` | 1,664 | C++ port of the Python suite | `timing_pes` cases; identity cases move to `ts_house_test.cpp` | the rest |
| `plugins/mpegts-core/py/ts_timeline.py` / `ts_timeline_test.py` | 1,394 / 1,275 | Python twin; :1–154 are helpers (`pts90k_to_ns`, `house_from_mux_pts`, `iter_pes`, `timing_stream_id`, `timing_pes`, `unwrap_near`); `TimelineLatch` from :155, `TimelineStamper` from :210 | the whole file, as reference (OQ-1); :1–154 are still imported by `branch_retime.py` until Phase 3 | nothing; `gst_stamp_probe.py` and `unixfd-fanout.py`, its runtime importers here, go |
| `plugins/mpegts-core/native/mrtsstamp/gstmrtsstamp.cpp` | 862 | `GstBaseTransform`: `active` arm, `coalesce` chain_list (ADR-0011), `bytes-total`, `copy-count`, properties `repair-latch`, `condition-step-ms`, `house-timeline`, `drift`; messages `mrtsstamp-anchor/-reanchor/-settled/-conditioned/-drift/-segment-warning/-map-failed` | arm, coalesce, counters, segment warning, identity stamp | anchored/conditioner properties and messages (≈ 410 lines) |
| `packages/engine/native/mr-gst-runner/stamper.cpp` / `.h` | 438 / 53 | Splice before every `busout_*` tee, arm/release, drift report timer (`DRIFT_REPORT_MS` 30 s), message translation; `enable(pipe, on, repair, condition_step_ms, house_timeline)` called at `runner.cpp:328–330` | splice, arm/release, `bytes_total`, `element_for` | drift timer, repair/condition/house arguments, anchored messages |
| `packages/engine/src/child-process/gst_bus_stamper.py`, `gst_stamp_probe.py`, `gst_stamp_native.py`, `gst_stamp_events.py` | 286, 225, 234, 217 | Python runner lifecycle; the Python probe backend (fallback); native splice; event builders (`timeline_restamped`, `timeline_settled`, `timeline_reanchor`, `timeline_conditioned`, `timeline_drift`) | lifecycle, native splice, identity log | `gst_stamp_probe.py` (the twin), drift, anchored events |
| `plugins/ts-splitter/native/mr-tssplit/app.{h,cpp}`, `main.cpp` | 119 / 322, 147 | One `TimelineStamper` for all outputs (`app.cpp:85–114`), the conditioner on a private copy (`:132–139`), `stamp_for` (`:159–162`), `--stamp-timeline` / `--no-latch-repair` (`main.cpp:53–56`), `timeline` stats (`:271–278`) | — | all of it (WI-P2-4) |
| `plugins/unixfdbus-core/native/mr-bus-fanout/main.cpp` | 153 | Anchored stamper behind `--stamp-timeline` (:59–84) | identity | anchored path |
| `plugins/unixfdbus-core/py/unixfd-fanout.py` | 521 | Python fan-out fallback with the Python stamper (:116–125) | — | the file (C-4) |

Runner and engine glue for the same mechanisms:

| Where | What |
|---|---|
| `packages/engine/src/plugins/PluginModule.ts:207–213, :331–355` | `isDeliveryLeadProducer()`; description fields `latchRepair`, `conditionStepMs`, `houseTimelineEgress` |
| `packages/engine/src/plugins/GstPluginBase.ts:145–252` | `applyTimeSync()`: latch-repair resolution, the `preserveSourceTimeline` deletion and its comment |
| `packages/engine/src/plugins/latchRepair.ts` (+ test) | `effectiveLatchRepair`, 50 + 42 lines |
| `packages/engine/src/routing/MediaRouter.ts:620–648` (+ `MediaRouter.latchRepair.test.ts`, 84) | `getUpstreamBusProducers`, used only by latch repair |
| `packages/engine/src/modules/ModuleInstance.ts:365`; `plugins/hls-player/engine/HlsPlayerModule.ts:104–107` | `isDeliveryLeadProducer` |
| `packages/engine/src/child-process/GstChildProcess.ts:249–259`; `PythonProcess.ts:62`; `nativeRunner.ts:35` | Pass-through of `preserveSourceTimeline`, `latchRepair`, `conditionStepMs`, `houseTimelineEgress`, `inputStallWatch` |
| `packages/engine/src/child-process/GstRunner.ts:565` | `timeline_settled` log |
| `packages/engine/src/child-process/gst-pipeline-runner.py:1124–1324` (+ `gst_preserve_timeline_test.py`, 173) | `preserveSourceTimeline`, built on `TimelineLatch`/`TimelineStamper`. Dead since the contract became unconditional (Phase 0, OQ-4), but it imports the classes this phase deletes. |

#### 3.3 ts-splitter

`mr-tssplit` routes per PID into single-PID transport streams
(`mrts::SplitterCore`, `ts_split.{h,cpp}`, 125 + 224). `SplitOutput::batch`
(`ts_split.cpp:15–41`) already writes a PSI carousel every 40 packets and
injects the master PCR into every non-PCR output at least 10 ms apart, by
copying the value (`build_pcr_packet(pid, master_pcr, last_cc, …)`). What
makes it "a second ingest" (§11.3 item 1) is in `app.cpp`: the conditioner
rewrites PES and PCR steps before the split, and `stamp_for` stamps each
output buffer from one anchor taken on the splitter's own arrival.
`TsSplitterModule.ts:222–228` passes `stampTimeline` and
`effectiveLatchRepair`. The splitter also declares `playoutOffsetMs`
(`plugins/ts-splitter/package.json:30`), a route-head D that Phase 4
removes.

#### 3.4 The 302M aligners

All 302M fan-ins are built by
`plugins/audio-302m-core/engine/audio302mHelpers.ts` (438 lines):

- `build302mMixBranch` (:209–228): `<busSrc> ! tsdemux latency=0
  ignore-pcr=true ! audio/x-smpte-302m ! avdec_s302m ! audioconvert !
  audioresample ! caps ! queue leaky=0 max-size-time=<branchQueueMs, 100>`.
  With `ignore-pcr` the demux latches on the side-band stamp of the buffer
  that carries the first PES (§6, a1).
- `pacedMixer` (:107–117): `audiomixer force-live=true latency=<ns>
  start-time-selection=first ! caps ! identity sync=true`. The aggregator
  times out on its latency and silence-fills a late pad; that late data is
  then dropped. The `identity` pacer exists because a force-live mixer
  free-runs after every input is EOS (ADR-0008).
- `buildAudioMixInput` (:304–406): single-source arm without aggregator;
  mixer arm; live-input arm (named bins per connection); returns
  `mixerLatencyNs` and the demux names.

Users and their fixed budgets (§11.3 item 5):

| Module | Budget today | Where |
|---|---|---|
| audio-mixer | `mixLatencyMs` default 20 (20–2000) | `AudioMixerModule.ts:122`, `package.json:78` |
| n1-mixer-302m input fan-ins | `mixLatencyMs` default 20 | `N1Mixer302mModule.ts:138`, `package.json:54` |
| n1-mixer-302m output mixers | `OUTPUT_MIX_LATENCY_NS` 20 ms, matrix queues 500 ms | `n1Mixer302mPipeline.ts:128, :193` |
| audio-processing fan-ins | `mixLatencyMs` default 200 | `AudioProcessingModule.ts:213`, `package.json:913` |
| audio-output-302m fan-in (a presentation leg) | `mixLatencyMs` default 20, subtracted from its `ts-offset` | `AudioOutput302mModule.ts:175–183`, `package.json:66` |
| every branch | 100 ms post-decode queue | `audio302mHelpers.ts:211` |

audio-processing (`audioProcessingPipeline.ts`, 172 lines) joins programme
and key for the keyed gate with `interleave` (:137), which collects by
arrival (§11.3 item 4). The ducker is not in the pipeline: a `level
name=sclevel interval=15 ms` branch on the key (:161–164) posts levels, and
the engine runs `DuckerEnvelope.advance()` on `Date.now()`
(`duckerEnvelope.ts`, 116 lines) and writes `duckvol`'s `volume` by IPC
(`AudioProcessingModule.ts:172–178`).

#### 3.5 mpegts-muxer

`plugins/mpegts-muxer/engine/mpegtsMuxerPipeline.ts` (348 lines):

- `mpegtsmux latency=1200000000 min-upstream-latency=1200000000` (:271): the
  aggregator waits up to 2.4 s for a pad without data, then emits without it.
- Per-pad queue (:81, `MUX_INPUT_QUEUE_MS` 500, operator `queueDepthMs`),
  blocking or leaky (`queueLeaky`; leaky drops the oldest frames).
- `inputStallWatch` (:69, 5 s; :344–345): a dark input fails the pipeline so
  it restarts. Runner side: `source_gate.cpp:406–543` (namespace `stall`),
  `gst_input_stall_watch.py` (154 + 197 test), `busHelpers.ts:123`.
- Sparse routes (`route.sparse`, :312): the runner hook restamps every KLV
  or subtitle buffer to the mux position and sends a GAP every 500 ms, 1 s
  ahead (`mux_routing.py:119–120, :502–560`; `mux_routing.cpp:24–25,
  :246–315`).
- Inputs are `tsdemux` branches retimed per access unit by the runner
  (`alignBranchesToStamps.transformProducer`; `branch_retime.cpp`, 627, and
  `branch_retime.py`, 439). The retime only takes `audio_`/`video_` pads
  (`branch_retime.cpp:579`, `branch_retime.py:430`), so private (sparse)
  pads keep tsdemux's own times. Phase 3 deletes the retime.

#### 3.6 #837: what is reused and what is not

`git show --stat d984cf1`: 18 files, +781/−36.

| #837 change | Files | Phase 2 |
|---|---|---|
| audio-mixer and audio-processing declare `houseTimelineEgress` (identity egress) | `AudioMixerModule.ts`, `AudioProcessingModule.ts` | **Reused as design.** Identity becomes the only stamp mode (WI-P2-3), so no flag is needed; n1-mixer-302m, which #837 left out, gets it too. |
| Every input demux (programme, sidechain, each mixer input) on content time | `audio302mHelpers.ts`, `audioMixerPipeline.ts`, `audioProcessingPipeline.ts` | **Reused as requirement.** The mechanism is the formula demux (WI-P2-7), not the retime. |
| `alignBranchesToStamps.transformProducer` on the mixer demuxes; `branchIgnorePcr` | same | **Not reused.** Replaced by `mrtsdemux`. |
| Live input adds retimed: `install_live` / `forget_live` (native), `_retime_live_branch` / `_forget_live_retime` (Python) | `branch_align.{h,cpp}`, `branch_retime.{h,cpp}`, `bus_inputs.cpp`, `gst-pipeline-runner.py` | **Requirement reused, mechanism not.** A live branch carries its own `mrtsdemux` in its string, so no runner hook is needed. |
| Protocol test R (live add, both runners, control) | `native_runner_protocol_test.py` | **Shape reused** for the live-add case of WI-P2-14. |
| `RETIMED_PACER_SLACK_MS` (10 s `identity ts-offset`) | `audio302mHelpers.ts` | **Not reused.** The pacer goes; inputs are paced by the watchdog (part 4.3). |
| `retimedMixLatencyMs` = `max(mixLatencyMs, D)`, `clampMixLatencyMs`, `onRoutePlayoutOffsetChanged` pushes | `audio302mHelpers.ts`, both modules | **Not reused.** Replaced by waiting for data or a gap, and W. |
| The ADR-0005 amendment of 2026-10-10 | `docs/adr/0005-time-sync-backend.md` | **Not restored.** Its diagnosis (an 8 s lead put in by the ingest conditioner) is gone with Phase 1. |
| Verification: Pi 4, RIST input, ducker feeding a mixer beside its own sidechain source; 90 s, no silence-fill, programme sample-exact, ducker egress on its input's timeline to 0.011 ms | commit message | **Reused** as fixture `scn-837-ducker-mixer` (WI-P2-14) and gate check V1 (part 11), per R15. |

### 4. Target state

#### 4.1 Identity is the only stamp mode

- `mrts::IdentityStamp` (in S0's `ts_house.{h,cpp}`) holds the identity
  rule that `stamp_house` holds today: the stamp of a bus buffer is
  `house_from_mux_pts(first timing PES PTS)`; a private-only buffer is
  stamped at arrival; a PES-less buffer repeats the stream's last stamp;
  stamps are monotone per stream. S0 part 4.4 named this a free function; it
  needs per-stream state, so it is a small class.
- `mrtsstamp` keeps `active`, `coalesce`, `coalesced-lists`, `bytes-total`,
  `copy-count` and the segment warning, and always stamps by identity. Both
  runners splice it as today. There is no Python probe fallback; without
  the plugin the runner splices nothing and raises the rule-6 alarm — the
  buffers leave with the pipeline's own PTS, no house time on the bus (S0
  part 4.5 rule 6, C-1).
- `mr-tssplit` and `mr-bus-fanout` stamp each output buffer with
  `IdentityStamp`, unconditionally.
- The description fields `latchRepair`, `conditionStepMs`,
  `houseTimelineEgress` and `preserveSourceTimeline` no longer exist.
- Bus stamps stay readable for Phase 3's consumers (retime, K learning) and
  for P0's lateness taps: under identity, K is −1 h on every edge.

#### 4.2 Splitter pass-through

```
BusClient ─► PacketWalker ─► SplitterCore ─► per-PID output batches
                (S0)          (PSI carousel, program PCR copied)
                                      └─► IdentityStamp (stream = pid) ─► FanoutServer
```

PES bytes are never written. The PCR on each output is the input
program's, copied (P5 holds because the input PCR is house-locked after
Phase 1). No events other than discovery, videoinfo, desync, stalls and
stats. The stats line drops `timeline`; P0's `lateness` key stays.

#### 4.3 The aligner model

Every aggregator input passes through one new native element,
`mralignwatch`, registered in `libgstmrtshouse.so`. It replaces the input's
queue and does four jobs:

1. **Capacity.** A bounded FIFO (`max-size-time` default 5 s,
   `max-size-bytes` per ADR-0015). Full blocks upstream, never drops, and is
   alarmed (R9).
2. **Arrival meter.** On its sink pad, before the FIFO, it records each
   arrival: `λ = now − running_time(PTS)` (data or gap), and the gap between
   arrivals. W = clamp(3 × p95 of the gaps over the last 200 arrivals,
   100 ms, 2 s).
3. **Pace hold.** All watchdogs of one aggregator share a pace group
   (keyed by pipeline and `aligner` name). The group's pace is the largest
   recent lateness among its members (mean over the last second), seeded
   from the inputs' known upstream lateness at start. It rises when any
   member's lateness rises and only falls when a member leaves the group (an
   operator removes the input: pad released). The FIFO releases a buffer
   when `now ≥ PTS + pace`, so every input reaches the aggregator at the same
   lateness, and the aggregator's output runs at the pace.
4. **Silence.** No arrival for W while not blocked downstream: the input is
   absent (alarm). Every tick (20 ms) it pushes a GAP from its emitted
   horizon to `now − pace`, so the aggregator moves on at the same pace.
   When data returns, buffers ending before the horizon are stale: they are
   discarded and counted, and the input is present again.

The aggregators run with `force-live=false` and `latency=0`, and each
`mralignwatch` answers the LATENCY query on its src pad as non-live. The
aggregator then never times out by lateness: it emits a stretch as soon as
every pad has data or a gap for it. Without a timeout no late data is
dropped, and without force-live there is no post-EOS free-run, so the
`identity sync=true` pacer goes. WI-P2-1 pins these GStreamer behaviours
before anything is built on them; they were checked in the 1.28.2 source
(unixfdsrc is live, `gstunixfdsrc.c:132`; `identity sync=true` adds the
upstream latency, `gstidentity.c:391`; the aggregator turns a GAP event into
a gap buffer, `gstaggregator.c:1915–1962`).

| Pace rule (§6 item 4) | How it falls out |
|---|---|
| Up when a slower input joins or an input slows | The joiner's lateness enters the group max; the others' FIFOs hold the difference; downstream sees one gap. |
| Holds while an input is absent | Gaps for the absent input are paced at `now − pace`; the others are still released at the pace. |
| Down only when an operator removes the slow input | Removing the pad removes the member; the group recomputes. |
| Starts at what the configured inputs need | `seed-lateness` per input from the producer's output lateness (P0's `LatenessReporter`), passed by the engine. |
| A returning input rejoins at the current position | Stale buffers before the horizon are discarded and counted (the only discard, R21). |

#### 4.4 302M fan-ins and mixers

```
<busSrc> ! mrtsdemux select="audio/x-smpte-302m" ! avdec_s302m ! audioconvert[ mix-matrix] ! audioresample
        ! audio/x-raw,rate=48000,channels=N
        ! mralignwatch aligner=<mixer> input=<connectionId> hold-on-eos=true seed-lateness=<ns>
        ! <mixer>.sink_<i>
audiomixer name=<mixer> latency=0 start-time-selection=first ! capsfilter name=<mixer>_out caps=…
```

- `mrtsdemux` in select mode is the formula demux (§6 item 2) for one
  stream type: running time = `unwrap(PES PTS) − 1 h`. It is the element
  Phase 3 generalises (OQ-20).
- `hold-on-eos=true` turns an input's EOS into absence, which keeps the
  silence-fill the force-live mixer gave.
- The single-source arm (no aggregator) is unchanged apart from the demux.
- n1-mixer-302m's output mixers take their matrix links through
  `mralignwatch` instead of 500 ms queues; their 20 ms budget goes.
- Egress is identity: the encode tail's `mpegtsmux` writes the mixer's
  output running time, which is content time, + 1 h.

#### 4.5 Audio processing

```
progmix_out. ! audioconvert ! [hpf] ! [agc] ! [eq] ! [limiter*] ! F32 stereo ! deinterleave name=dp
scmix_out.   ! audioconvert ! F32 stereo ! deinterleave name=ds
dp.src_0 ! mralignwatch aligner=il … ! il.sink_0     (same for dp.src_1, ds.src_0, ds.src_1)
audiointerleave name=il latency=0 start-time-selection=first ! audioconvert ! 4-ch caps
   ! { sc-gate-stereo (keyed gate) | mrducker name=ducker (ducker) } ! … ! level ! 302M encode ! bus
```

`*` In ducker mode the limiter sits before the interleave, so the duck stays
after the limiter as today; in keyed-gate mode it stays after the gate.

- `audiointerleave` (gst-plugins-base `audiomixer` plugin, already in the
  image) is an aggregator: it joins programme and key by running time.
- `mrducker` is a native port of `DuckerEnvelope`: 4 channels in (0/1
  programme, 2/3 key), 2 out. It advances the envelope per 15 ms window of
  content time and ramps the gain per sample. Threshold, depth, attack,
  release and hold are live properties. It posts `mrducker` messages (gain,
  key level, phase) every 100 ms, which feed the existing `DuckLiveThrottle`.

#### 4.6 Muxer

- `mpegtsmux name=mux latency=0` with `prog-map` as today; no
  `min-upstream-latency`.
- Every route branch is `[parser] ! mralignwatch aligner=mux input=<route>
  [! taginject …]`; the per-pad queue is gone.
- Sparse routes: the runner's retime admits `private_` and `subpicture_`
  pads (both runners), so a KLV or teletext buffer leaves the demux at
  `PES − 1 h` (K is −1 h exactly under identity). Its `mralignwatch` has
  `sparse=true`: it never declares absence, drops tsdemux's own GAP events
  (not on content time), and fills between cues with gaps at the pace. A
  cue that arrives after its time was gapped raises the pace by its
  lateness and is **forwarded at its own PTS** with an alarm: `mpegtsmux`
  writes it and it is played late (§8). Nothing after ingest is discarded
  for being late (P11, §13.1); the only sanctioned discard is a returning
  input's stale data (§6 item 4, R21). This consumer-side fill at
  `now − pace` is the interim: producer-side gap signalling for sparse
  producers (§11.5 item 10) is deferred to Phase 3, because `tsdemux`
  would not forward it (chapter 15, C-3).
- `inputStallWatch` and the restart on a dark input go: an absent input is
  left out and rejoins (§6 item 4). `queueLeaky` and `queueDepthMs` go
  (C-2: §14 row 2, "aligners wait for data or a gap and never drop", and
  §11.5 item 9 remove them with their mechanism).

#### 4.7 What replaces the fixed budgets

| Budget today | What replaces it |
|---|---|
| Mux window 2.4 s (`latency` + `min-upstream-latency`) | Waiting for data or a gap (no timeout); W from each input's arrival rhythm for absence; the pace from measured lateness. |
| 302M mixers 20 ms / 200 ms (`mixLatencyMs`), n1 output mixers 20 ms | Same. |
| Branch queue 100 ms, n1 matrix queues 500 ms, mux pad queue 500 ms | `mralignwatch` FIFO, 5 s, alarmed when full. |
| Mux input stall watch 5 s → restart | Absence after W, alarm, rejoin at the current position. |

The design doc's §11.1 rows say "W sized from measured lateness" and "W from
lateness", while §4.6, §6 and Q8 define W from the arrival rhythm. This plan
follows §6: W measures silence; the pace measures lateness (C-5, a
design-doc edit for the owner).

### 5. Work items

Ordered by dependency. Estimates are lines at this repo's comment density
(±40 %) and engineer-days including review.

#### WI-P2-1 Aggregator behaviour, pinned before anything is built on it

- **What.** A dataflow test that pins, on GStreamer 1.28.2, the behaviours
  part 4.3 relies on.
- **Where.** New `packages/engine/src/child-process/gst_aligner_behaviour_test.py`,
  added to `packages/engine/package.json` `test:py`.
- **How.** Live `appsrc` inputs, each behind a harness element that answers
  LATENCY as non-live (a pad query probe), into `audiomixer`,
  `audiointerleave` and `mpegtsmux`, all `force-live=false latency=0`.
  Assert:
  1. An input delayed 3 s is waited for; buffers in = buffers out, samples
     in = samples out.
  2. A GAP event lets the aggregator advance: silence in `audiomixer` and
     `audiointerleave`, nothing written by `mpegtsmux`.
  3. A request pad added while PLAYING is waited for.
  4. A buffer that ends before the output position is clipped by the
     aggregator; the test measures it, so the watchdog can discard first
     and count.
  5. `start-time-selection=first` starts at the first buffer's running time
     on uptime-sized timestamps (ADR-0005 Stage 3g).
  6. With every input EOS the aggregator sends EOS (no free-run).
- **Acceptance.** Passes on the dev box (aarch64, 1.28.2). If assertion 1
  fails, the fallback is recorded instead and WI-P2-6 is built on it: a live
  aggregator with `latency` = 5 s (a fault cap, alarmed when hit), the pace
  hold unchanged. The outcome goes in the ADR (WI-P2-15).
- **Estimate.** 350 lines (test); 1.5 days.

#### WI-P2-2 `mrts::IdentityStamp`; the anchored stamper leaves `mrts` (OQ-18)

- **What.** The identity rule as a class; delete `TimelineLatch`,
  `TimelineStamper`, the event JSON builders and `drift_stats_json`.
- **Where.** `plugins/mpegts-core/native/mrts/ts_house.{h,cpp}` (S0);
  `ts_timeline.{h,cpp}` cut to `timing_pes` and its helpers;
  `tests/ts_timeline_test.cpp` cut to the `timing_pes` cases;
  identity cases into `tests/ts_house_test.cpp`.
- **How.**
  ```cpp
  namespace mrts {
  class IdentityStamp {
    public:
      // Stamp (ns, house) of one outgoing bus buffer of `stream`.
      int64_t stamp(const uint8_t* data, size_t len, int64_t house_now, int stream = 0);
      // First timing PES seen: pid, stamp, PTS (for the one-time log line).
      bool first(int* pid, int64_t* stamp_ns, int64_t* pts) const;
      void reset();
  };
  }
  ```
  Body: today's `stamp_house` (`ts_timeline.cpp:902–942`) on S0's
  `parse_pes_header` and `read_pcr`; the timing PID is the first PCR
  carrier seen. Before deleting, record the stamps of every house-timeline
  case of `ts_timeline_test.cpp` as vectors, and assert them on the new
  class.
- **Acceptance.** `make native-test` passes; the vectors match;
  `grep -rn "TimelineStamper\|TimelineLatch" plugins packages` returns
  nothing outside `docs/`, after three comment edits:
  `plugins/unixfdbus-core/native/libmrbus/fanout_server.h:52`,
  `packages/engine/src/plugins/PacedTsSink.ts:193` and
  `packages/engine/src/child-process/transform_input_fixture.py:23` (the
  fixture otherwise uses only the kept `house_from_mux_pts`).
- **Estimate.** +140 / −2,900; 1.5 days.

#### WI-P2-3 Identity-only egress in both runners and the engine (OQ-18)

- **What.** `mrtsstamp` on `IdentityStamp`; runner glue without the
  anchored path; description fields and latch-repair resolution deleted;
  `preserveSourceTimeline` deleted; the Python twin classes leave the
  runtime (kept as reference, OQ-1).
- **Where.**
  - `plugins/mpegts-core/native/mrtsstamp/gstmrtsstamp.cpp`;
    `packages/engine/src/child-process/gst_mrtsstamp_element_test.py`.
  - Native runner: `stamper.{h,cpp}`, `runner.cpp:328–330`.
  - Python runner: `gst_bus_stamper.py`, `gst_stamp_native.py`,
    `gst_stamp_events.py`, `gst_bus_stamper_test.py`; delete
    `gst_stamp_probe.py`; `gst-pipeline-runner.py:1124–1324`
    (`_install_preserve_timeline`), `:2123–2124`.
  - Engine: `PluginModule.ts`, `GstPluginBase.ts:145–252`,
    `GstChildProcess.ts:249–256`, `PythonProcess.ts:62`,
    `nativeRunner.ts:35`, `GstRunner.ts:565`, `index.ts:199`,
    `latchRepair.ts` (+ test), `MediaRouter.ts:620–648` (+
    `MediaRouter.latchRepair.test.ts`), `ModuleInstance.ts:365`.
  - Modules: drop `houseTimelineEgress` from the four declaring modules
    (part 3.1) and `preserveSourceTimeline` from transcoder and
    audio-transcoder.
  - `plugins/mpegts-core/py/ts_timeline.py` and `ts_timeline_test.py`:
    untouched, kept as reference (OQ-1); `gst_stamp_probe.py`, deleted
    above, was their last runtime importer in this phase.
  - subtitle-core's users of the Python `TimelineStamper`, which the
    draft missed: `plugins/subtitle-core/py/subtitle_stamp_dump.py` is
    retired (its output,
    `plugins/mpegts-core/native/mrpeshouse/tests/stamp_model_vectors.txt`,
    stays checked in per `mrpeshouse/Makefile:32`, so `make native-test`
    keeps passing); `subtitle_pack_test.py:56`,
    `subtitle_ts_engine_test.py:86, :107–108, :138` and
    `subtitle_peshouse_gst_test.py:40, :123` are ported from
    `TimelineStamper(house_timeline=True)` to a local identity stamp
    (`house_from_mux_pts(first timing PES PTS)`). The whole K-recovery
    suite goes in Phase 3 (§11.4 row 4, WI-P3-17).
  - `plugins/transcoder/package.json:283–289` and
    `plugins/audio-transcoder/package.json:149–155`: the operator-visible
    `preserveSourceTimeline` setting (`x-advanced`, "Preserve Source
    Timeline"), read at `TranscoderModule.ts:295–297` and
    `AudioTranscoderModule.ts:241–243`; `manifestHelpText.test.ts`.
- **How.**
  - `mrtsstamp`: remove `PROP_REPAIR_LATCH`, `PROP_CONDITION_STEP_MS`,
    `PROP_HOUSE_TIMELINE`, `PROP_DRIFT` and the pending anchored/reanchor/
    settled/conditioned messages; on the first stamp after `active` goes
    TRUE post `mrtsstamp-identity` (pid, stamp, pts) once.
  - `stamper::enable(GstElement* pipe, bool on)`; no drift timer;
    `handle_message` knows `mrtsstamp-identity` and `-segment-warning`. The
    Python side mirrors it: `enable(pipe, on)`, `native.activate(el,
    name)`, events `timeline_identity` (log only) and the segment warning.
    A missing plugin is a `warning` event and the rule-6 alarm, not a
    fallback (S0 part 4.5 rule 6).
  - `applyTimeSync()` keeps only "contract clock, base_time 0" and the
    `liveCaptureClock` log. `GstPluginBase` no longer reads
    `effectiveLatchRepair`.
- **Acceptance.**
  - `pnpm -r test`, `make native-test`, both runner `test:py` suites and
    `plugins/subtitle-core` `test:py` (`package.json:22`, run by the root
    `pnpm test` chain) pass.
  - This grep over `packages plugins` returns nothing outside `docs/` and
    `dist/`:
    ```
    grep -rnE "latchRepair|conditionStepMs|houseTimelineEgress|\
    preserveSourceTimeline|repair-latch|condition-step-ms|house-timeline|\
    isDeliveryLeadProducer|timeline_(settled|reanchor|conditioned|drift)"
    ```
  - `gst_mrtsstamp_element_test.py` (kept cases): stamps equal PES − 1 h
    on mux lists (alignment 0 and 7), coalescing unchanged, `bytes-total`
    unchanged.
  - Protocol test B2 (house-timeline egress) passes as the only egress
    case; case B is folded into it.
- **Estimate.** +200 / −5,800; 4 days.

#### WI-P2-4 Splitter pass-through

- **What.** `mr-tssplit` without stamper and conditioner; identity per
  output; argv and module options cleaned.
- **Where.** `plugins/ts-splitter/native/mr-tssplit/{app.h, app.cpp,
  main.cpp}`; `plugins/ts-splitter/engine/{nativeRunner.ts,
  TsSplitterModule.ts}` and tests;
  `plugins/ts-splitter/tests/mrTssplit.test.ts`;
  `plugins/mpegts-core/native/mrts/ts_split.{h,cpp}` (on S0's
  `PacketWalker`, S0 part 4.4, if Phase 1 has not already done it).
- **How.**
  - Delete `stamper_`, `cond_buf_` and the `condition()` call
    (`app.cpp:85–114, :132–139`); `stamp_for` returns
    `identity_.stamp(data, len, mono_ns(), o.pid)`.
  - `Options::stamp_timeline` and `repair_latch` go, with `--stamp-timeline`
    and `--no-latch-repair` (`main.cpp:53–56`); an unknown flag is an
    argv error, as for any other.
  - The `timeline` stats object goes (`app.cpp:271–278`).
  - `buildSpawnArgs` loses `stampTimeline` and `latchRepair`;
    `TsSplitterModule.ts:222–228` loses both lines and the
    `effectiveLatchRepair` import. `playoutOffsetMs` stays until Phase 4.
  - Delete the parity vitest S0 part 6.2 schedules for this phase
    (`tests/nativeSplitParity.test.ts`, the `mrts_cli` splitter mode).
    `py/ts_split.py`, `py/ts_split_test.py`, `py/native_parity_ref.py` and
    `py/native_parity_fixture.py` stay as reference (OQ-1).
- **Acceptance.** New cases in `mrTssplit.test.ts` over
  `cap-srt-ingest-1316.ts`, `cap-occ-1080i-h264-aac-ttx.ts` and
  `cap-836-program-step.ts` (part 7.4):
  1. Each output's PES are byte-identical to the input PID's (`mrts_cli
     dump` crc32 per PES, both sides).
  2. Every injected PCR on a non-PCR output equals an input program PCR
     value, injected ≥ 10 ms apart.
  3. Each output buffer's wire stamp is `PES − 1 h` of its first PES, a
     KLV output included (its own PID carries the injected PCR).
  4. No `timeline_*` events and no `timeline` key in the stats line.
- **Estimate.** +120 / −400 (with the parity vitest and splitter mode); 2 days.

#### WI-P2-5 HLS fan-out on identity, hls-player on house time (OQ-18)

- **What.** `mr-bus-fanout` stamps by identity, unconditionally; the Python
  fan-out fallback goes.
- **Where.** `plugins/unixfdbus-core/native/mr-bus-fanout/main.cpp`;
  `plugins/unixfdbus-core/py/unixfd-fanout.py` (deleted);
  `plugins/unixfdbus-core/tests/unixfdFanout.test.ts`;
  `plugins/hls-player/engine/HlsPlayerModule.ts:33–43, :104–107, :248`.
- **How.** `IdentityStamp` in place of `TimelineStamper` (:59–84);
  `--stamp-timeline` removed; `resolveFanout()` resolves the native binary
  only and reports the module error it reports today when nothing is found.
  Scope added during assembly: no Phase 1 work item moves hls-player's
  egress to "house time at playout start plus media offset" (§5.4), so
  this item does it in the same release that deletes the anchored stamper
  (OQ-18, merged with the Phase 1 draft's question): the hls-player's
  TS writer (`packages/hls-pipe`) and `HlsPlayerModule.ts` stamp PES at
  house time at playout start plus the media offset, and the fan-out
  stamps them by identity. The estimate below was not revised for this
  (planning-grade).
- **Acceptance.** `unixfdFanout.test.ts` native block: stamps are `PES −
  1 h` on the ladder; the Python block is removed.
- **Estimate.** +40 / −800; 0.5 day.

#### WI-P2-6 `mralignwatch`, the aligner input element

- **What.** The element of part 4.3, native, in `libgstmrtshouse.so`.
- **Where.**
  - Portable core: `plugins/mpegts-core/native/mrts/align_watch.{h,cpp}`
    (`ArrivalRhythm`, `PaceGroup`, `GapPlanner`; no GStreamer).
  - Element: `plugins/mpegts-core/native/mrtshouse/gstmralignwatch.cpp`,
    registered in `gstmrtshouse.cpp`'s factory table (S0 WI-S0-7).
  - Tests: `mrts/tests/align_watch_test.cpp`;
    `packages/engine/src/child-process/gst_mralignwatch_element_test.py`.
- **How.**
  - Properties: `aligner` (string, group key), `input` (string, label),
    `sparse` (bool), `hold-on-eos` (bool), `seed-lateness` (int64 ns, −1 =
    none), `silence-factor` (3.0), `silence-floor` (100 ms),
    `silence-ceiling` (2 s), `max-size-time` (5 s), `max-size-bytes`
    (0 = none; muxer routes set ADR-0015's cap), `tick` (20 ms).
    Read-only: `state` (`waiting`, `present`, `absent`), `lateness`, `pace`,
    `silence-limit`, `absences`, `stale-buffers`, `stale-time`, `gaps`,
    `level-time`, `level-bytes`, `full-count`.
  - Sink chain: meter arrival (λ, inter-arrival into `ArrivalRhythm`),
    discard if it ends before the emitted horizon (count), else enqueue;
    block when full (count once per episode). Sink GAP: an arrival
    (non-sparse) enqueued as a gap; dropped when `sparse`.
  - Src task: wait on the pipeline clock until `PTS + pace`, push, advance
    the horizon. Silence is counted only while the task is not blocked in a
    push. Absent: push GAP `[horizon, now − pace)` every tick, under the
    stream lock.
  - `sparse=true`: never absent; upstream GAPs dropped; gaps between cues
    at the pace; a cue ending before the horizon raises the group pace by
    its lateness and is forwarded at its own PTS with a message (C-3: no
    discard, P11).
  - `PaceGroup`: process-global registry keyed by (pipeline, `aligner`);
    members register at READY and leave at pad release or NULL; pace =
    max(current, member recent λ, member seed); recomputed from the
    remaining members when one leaves.
  - LATENCY query on src: answered `live=FALSE, min=0, max=NONE`, not
    forwarded (per WI-P2-1).
  - EOS: forwarded, unless `hold-on-eos`, which turns it into absence until
    FLUSH or NULL.
  - Messages: `mralignwatch` element message on every state change and
    every 1 s (all read-only properties, plus `aligner`, `input`).
- **Acceptance.**
  - Unit: W on synthetic rhythms (20 ms CBR → 100 ms floor; 150 ms bursts →
    ≈ 450 ms); pace monotone while members stay, recomputed on leave; seeds.
  - Element, in a pipeline with `audiomixer` and `mpegtsmux`:
    1. a 1.5 s late but delivering input: nothing dropped, no absence;
    2. a silent input: absent within W + tick, gaps at `now − pace`, the
       aggregator continues;
    3. rejoin: stale buffers discarded and counted, state `present`;
    4. an input whose lateness falls is still released at the pace;
    5. releasing a pad lowers the pace;
    6. `hold-on-eos`;
    7. full FIFO blocks, `full-count` 1, no drop.
  - Loaded and used by both runners (protocol case in WI-P2-14).
- **Estimate.** +900 production, +600 test; 6 days.

#### WI-P2-7 `mrtsdemux` select mode for 302M (OQ-20)

- **What.** The formula demux of §6 item 2, limited to one selected stream,
  so the 302M aligners get content time without the retime.
- **Where.** `plugins/mpegts-core/native/mrtshouse/gstmrtsdemux.cpp` (the
  file S0 part 4.1 reserves for Phase 3); tests
  `packages/engine/src/child-process/gst_mrtsdemux_element_test.py`.
- **How.**
  - Properties: `select` (caps string), `program-number` (−1 = first).
    One ALWAYS src pad; caps set when the PMT shows a matching stream
    (302M: stream type 0x06 with registration `BSSD`, via S0
    `registration_format`).
  - Per buffer: `PacketWalker` → `CcTracker` → `PsiDiscovery` →
    `PesAssembler` on the selected PID → `Unwrapper::feed(pts,
    ns_to_pts90k(clock − base_time) + MUX_CLOCK_BASE_90K)`, the seed
    unwrapped, never folded to 33 bits (chapter 15.4 B-14) → PTS = DTS =
    `pts90k_to_ns(u − MUX_CLOCK_BASE_90K)`. One TIME segment
    {start 0, base 0}, so running time is the formula. The
    upstream SEGMENT and the bus stamps are ignored.
  - A PTS jump past the expected next PTS by more than two frame durations
    pushes a GAP for the hole (§5.2 gaps reach the aligners); a CC loss
    sets DISCONT on the next buffer.
  - No match within 2 s: `mrtsdemux-no-stream` warning message; the pad
    stays silent and the aligner's watchdog reports the input absent. This
    keeps today's "wrong content fails soft" (`audio302mHelpers.ts:299–302`).
  - Counters (`pes`, `gaps`, `cc-lost`) in a `mrtsdemux` message every 1 s.
  - No stand-in: a runner that cannot load `libgstmrtshouse.so` fails a
    module whose pipeline names `mrtsdemux`, with the rule-6 alarm text
    (S0 part 4.5 rule 6, WI-S0-8; decided 2026-10-12). The 302M fan-ins
    are the first such modules.
  - Phase 3 adds the SOMETIMES-pad mode, the caps table and sparse GAPs to
    the same element; producer-side gap signalling for sparse producers
    (§11.5 item 10) is deferred with it, because `tsdemux` would not
    forward it (the interim is part 4.6's consumer-side fill).
- **Acceptance.** On `cap-302m-bssd.ts` (S0 part 7.2) and the 302M output of
  audio-mixer: every buffer PTS equals `PES − 1 h` exactly; one buffer per
  PES; GAP on a synthetic 500 ms hole; DISCONT on `cap-cc-loss`-style
  drops; `syn-wrap-33bit.ts` crosses the wrap with no step.
- **Estimate.** +450 production, +350 test; 4 days.

#### WI-P2-8 The 302M fan-in helper on content time (OQ-20)

- **What.** One builder change carries every 302M aligner (part 4.4).
- **Where.** `plugins/audio-302m-core/engine/audio302mHelpers.ts`, `.test.ts`,
  `index.ts`, `README.md`.
- **How.**
  - `build302mMixBranch`: `tsdemux … ignore-pcr=true ! audio/x-smpte-302m`
    → `mrtsdemux name=<demuxName> select="audio/x-smpte-302m"`. In the
    mixer and live arms the trailing queue becomes `mralignwatch
    name=<mixer>_aw_<hash> aligner=<mixer> input=<connectionId>
    hold-on-eos=true[ seed-lateness=<ns>]`.
  - `pacedMixer` → `alignedMixer({ name, caps, outName })`: `audiomixer
    name=<n> latency=0 start-time-selection=first ! capsfilter
    name=<n>_out caps=…`. `continuationName` keeps naming `<n>_out`.
  - Removed from the API: `AudioMixInputOpts.latencyMs`, `ignorePcr`;
    `MixInputBranchOpts.ignorePcr`; `ignorePcrClause`; the results
    `mixerLatencyNs` and `demuxes`; `PacedMixerOpts`.
  - `AudioMixSource` gains `seedLatenessMs?: number` (WI-P2-13).
- **Acceptance.** Snapshot tests of all three arms; a test that no string
  the helper builds contains `tsdemux`, `ignore-pcr`, `force-live` or
  `sync=true`; protocol case L (live input branches) passes in both runners
  with the new branch string (the ghosting in `bus_inputs.cpp:130–153`
  still finds the unlinked src pad).
- **Estimate.** +200 / −260; 2 days.

#### WI-P2-9 audio-mixer and n1-mixer-302m

- **Where.** `plugins/audio-mixer/engine/{AudioMixerModule.ts,
  audioMixerPipeline.ts}` and tests, `package.json`;
  `plugins/n1-mixer-302m/engine/{N1Mixer302mModule.ts,
  n1Mixer302mPipeline.ts}` and tests, `package.json`.
- **How.** Drop `latencyMs` (`AudioMixerModule.ts:122`,
  `N1Mixer302mModule.ts:138`) and the `mixLatencyMs` schema entries. n1:
  `OUTPUT_MIX_LATENCY_NS` (:128) goes; output mixers via `alignedMixer`;
  each matrix link `in<i>t. ! mralignwatch name=omix<o>_aw<i>
  aligner=omix<o> input=in<i> ! omix<o>.` replaces the 500 ms queue.
  Egress is identity by WI-P2-3.
- **Acceptance.** Pipeline and module tests updated; a live second source
  on a connected n1 input is added and removed with no restart in both
  runners.
- **Estimate.** +150 / −120; 1.5 days.

#### WI-P2-10 audio-processing: aligned interleave and the ducker in the pipeline

- **What.** part 4.5.
- **Where.**
  - `plugins/audio-processing/engine/{audioProcessingPipeline.ts,
    AudioProcessingModule.ts, chainSetup.ts, chainTelemetry.ts,
    liveWrites.ts}` and tests; `package.json` (`mixLatencyMs` removed).
  - New `plugins/audio-processing/native/mrducker/{gstmrducker.cpp,
    ducker_envelope.h, ducker_envelope.cpp, Makefile,
    tests/ducker_envelope_test.cpp}`; installed to
    `/usr/libexec/media-router/audio-processing/libgstmrducker.so`; loaded
    by S0's loader table (`native_plugins.cpp`, `gst_native_plugins.py`).
  - Delete `duckerEnvelope.ts` and its test; keep `DUCK_DEFAULTS` in
    `chainSetup.ts`.
- **How.**
  - Keyed gate: `interleave name=il` (:137) → `audiointerleave name=il
    latency=0 start-time-selection=first`; the four `queue` links become
    `mralignwatch aligner=il input=<prog0|prog1|key0|key1>`.
  - Ducker: the same interleave feeds `mrducker name=ducker
    threshold=… depth=… attack=… release=… hold=…`; `volume name=duckvol`
    and the `sclevel` branch (:120, :161–164) go.
  - `ducker_envelope.{h,cpp}`: `DuckerEnvelope::advance(key_rms_db, dt_ms)`
    ported from `duckerEnvelope.ts:85–115`, with `dt` = the window in content
    time instead of `Date.now()` deltas. The TS test cases are turned into
    vectors and asserted on the port before the TS file is deleted.
  - Module: `onPluginEvent` takes channel `mrducker:ducker` into
    `ChainTelemetry.duckLevel()`; slider edits are live writes on the
    `ducker` element through `resolveLiveWrites`; the `duckvol` reseed on
    PLAYING (`AudioProcessingModule.ts:146`) goes.
  - Fan-ins via WI-P2-8; `mixLatencyMs` dropped (:213).
  - The limiter's lookahead is reported as added latency, not corrected
    (OQ-22).
- **Acceptance.**
  - `ducker_envelope_test.cpp` reproduces the TS vectors to 0.01 dB.
  - Element test: a key burst at content time T ducks the programme from T
    (± one 15 ms window), independent of when the key buffers arrive (key
    delayed 300 ms in the harness).
  - Keyed gate: the gate opens on the key at its content time with the key
    branch delayed 300 ms.
  - Duck live graph: `mrducker` messages drive the throttle at ≤ 4 Hz.
- **Estimate.** +900 (450 C++, 250 test, 200 TS) / −350; 4 days.

#### WI-P2-11 audio-output-302m's fan-in follows the helper (OQ-20)

- **Where.** `plugins/audio-output-302m/engine/AudioOutput302mModule.ts`
  (:175–183, :187, :250), its test, `package.json:66`.
- **How.** No `ignorePcr`, `latencyMs` or `mixerLatencyNs`;
  `audio302mTsOffsetNs` loses the mixer-latency term;
  `alignBranchesToStamps` is dropped (the formula demux gives content time).
  `lipSyncMs`, D, `ts-offset` and the backlog shedder stay until Phase 4.
- **Acceptance.** Module tests; on the gate, the output plays at the same
  `stamp + D` as before within 1 ms (V7).
- **Estimate.** +30 / −80; 0.5 day.

#### WI-P2-12 The muxer as an aligner

- **Where.** `plugins/mpegts-muxer/engine/{mpegtsMuxerPipeline.ts,
  MpegTsMuxerModule.ts, muxerInputs.ts}` and tests, `package.json:63, :77`;
  `plugins/mpegts-muxer/py/mux_routing.py` (+ test) and
  `native/mux-routing/mux_routing.cpp`; `packages/engine/native/mr-gst-runner/
  branch_retime.cpp:579`, `packages/engine/src/child-process/branch_retime.py:430`;
  stall-watch removal in `source_gate.cpp:406–543`, `runner.cpp:324`,
  `gst-pipeline-runner.py:2115, :3816–3839`, `gst_input_stall_watch.py`
  (+ test), `busHelpers.ts:123`, `PluginModule.ts:574–577, :607`,
  `GstChildProcess.ts:259`, `index.ts:112`.
- **How.**
  - `mpegtsmux name=mux latency=0 ` + `muxProps` (:271).
  - Route branch: `mralignwatch name=aw_<tag> aligner=mux input=<tag>
    max-size-bytes=<tsQueueByteCap(5000)>[ sparse=true][ seed-lateness=…]`
    plus the existing `taginject` when set. `buildLeakyQueue` /
    `buildBackpressureQueue` are no longer used here.
  - Sparse: delete `_sparse_position`, `_arm_sparse_pad`, the timers and
    `SPARSE_GAP_*` in both hook twins (these hooks are existing twin code;
    both change in the same release). The retime pad filter admits
    `private_` and `subpicture_` in both runners.
  - Delete `inputStallWatch` end to end and `INPUT_STALL_TIMEOUT_MS`.
  - Remove `queueLeaky` and `queueDepthMs` (C-2).
- **Acceptance.**
  - `MpegTsMuxerModule.test.ts`: no `latency=1200000000`, no
    `min-upstream-latency`, one `mralignwatch` per route.
  - `mux_routing_test.py` and the native hook test: no restamp, no GAP
    timer.
  - Fixture `scn-mux-klv` (part 7.4): output KLV PES PTS = input PES PTS (0
    ticks); video never stalls between cues.
  - Protocol case P (mux inputs retimed) passes with a KLV input added.
- **Estimate.** +250 / −950; 3.5 days.

#### WI-P2-13 Engine: start pace seeds and the aligner display

- **Where.** `packages/engine/src/routing/MediaRouter.ts`
  (`getModuleBusSources`, :707), `plugins/mpegts-muxer/engine/muxerInputs.ts`,
  `packages/engine/src/plugins/latenessReporter.ts` (P0), `GstPluginBase.ts:32`
  (`OwnedWarning`), shared types.
- **How.**
  - `getModuleBusSources` adds `seedLatenessMs` from the producer's
    `ModuleTimingSummary.outputMs.mean` (P0 WI-P0-9) when the producer is
    running; the muxer's input sources get the same field. Builders pass it
    as `seed-lateness`.
  - `LatenessReporter` consumes `mralignwatch:<name>` events: per input
    lateness, state, W, absences, stale time; the aligner's pace; "Waiting
    for" = the absent input, else the input with the highest lateness (P0's
    stand-in becomes exact).
  - Warnings: `'input-absent'` ("Input <label> silent for <W> ms —
    continuing without it"), cleared on return; `'aligner-full'` ("Input
    <label> queue full — upstream held"). A rejoin with stale discard
    raises an engine event naming the input and the discarded ms.
- **Acceptance.** `latenessReporter.test.ts` cases: absent → warning →
  present; waiting-for naming; pace shown as the aligner's added latency
  over its fastest input; seeds reach the pipeline string
  (`audioMixerPipeline.test.ts`).
- **Estimate.** +400 / −20; 2 days.

#### WI-P2-14 Conformance fixtures and the scenario harness

- **What.** The fixtures of part 7.4 and one harness that replays them through
  both runners.
- **Where.** Captures in `plugins/mpegts-core/tests/fixtures/` (OQ-2:
  in-repo, off the device per WI-S0-13); harness
  `packages/engine/src/child-process/aligner_conformance_test.py`
  (RunnerProc driver as in `native_runner_protocol_test.py`); synthetic
  scenarios generated by S0's `fixture_gen.cpp`, extended with `--silence
  <pid>:<from>:<len>`, `--delay <pid>:<ms>` and `--burst <pid>:<ms>`.
- **How.** Each scenario starts a pipeline built by the real TypeScript
  builders (emitted to JSON by a small vitest helper) in the native runner,
  then the Python runner (`MR_GST_RUNNER_NATIVE=0`), feeds the fixtures over
  unixfd edges at real time, and compares the output against
  `<scenario>.expect.json`.
- **Acceptance.** Every scenario passes in both runners on the dev box.
- **Estimate.** +900; 4 days, with the capture session on the gate (the
  assistant session with rig access records, OQ-3).

#### WI-P2-15 ADR and documents

- **Where.** The timing ADR created by S0/Phase 1 (`docs/adr/`, next free
  number after 0028); `docs/adr/0005-time-sync-backend.md`,
  `0018-conditioner-program-wide-steps.md`, `0008-302m-fan-in-contract.md`,
  `docs/adr/README.md` index; `plugins/README.md` (302M helpers at :1124–1171,
  stamping at :2043–2135, n1 row at :2553); `plugins/audio-302m-core/README.md`.
- **How.**
  - Timing ADR sections: identity-only stamping; splitter pass-through; the
    aligner model (part 4.3) with the WI-P2-1 outcome, W and pace constants;
    `mrtsdemux` select mode; the ducker; the sparse rule.
  - ADR-0005: decision 2 and its 2026-09-05 latch-repair note and the
    2026-10-08 house-timeline note marked "superseded by ADR-00NN";
    decision 4 marked superseded (D's mechanism is removed in Phase 4).
  - ADR-0018: status "superseded by ADR-00NN".
  - ADR-0008: force-live, the pacer, `ignore-pcr` and the 20 ms floor
    superseded; the single-source bypass and `continuationName` rule kept
    (OQ-21).
  - `plugins/README.md`: the stamping section rewritten to "identity only";
    the latch-repair, conditioner and `houseTimelineEgress` paragraphs
    deleted; `pacedMixer` → `alignedMixer` and `mralignwatch`.
  - §11.1 rows of the design doc reworded by the owner (C-5).
- **Acceptance.** `grep -n "latch repair\|conditionStepMs\|pacedMixer"
  plugins/README.md` returns nothing; the ADR index rows carry the status.
- **Estimate.** +400 / −300; 1.5 days.

#### WI-P2-16 Gate verification and release

- **What.** The checks of part 11 on 10.9.16.103 and 10.9.16.108, with a small
  tool set.
- **Where.** New `tools/align-check/`: `bus-capture.sh` (a consumer
  `unixfdsrc socket-path=<edge> ! filesink` started with
  `systemd-run --user` on the box), `pcm_align.py` (decodes two 302M
  captures and cross-correlates; reports offset in samples and
  silence-fill percentage), `pes_diff.sh` (`mrts_cli dump` on two captures,
  joined by crc32).
- **How.** Build the RAUC image with the Phase 2 native set; install on
  both boxes; run V1–V12.
- **Acceptance.** All of part 11 pass.
- **Estimate.** +250; 3 days.

### 6. Deletions

All go with Phase 2, in the Phases 1–4 release.

#### 6.1 Anchored stamper, conditioner, twins

| What | Path | Lines (approx.) | WI |
|---|---|---|---|
| `TimelineLatch`, `TimelineStamper` (anchor, latch repair, watch, staleness net, late/early tiers, drift servo, conditioner), `*_event_json`, `drift_stats_json` | `plugins/mpegts-core/native/mrts/ts_timeline.{h,cpp}` | 1,350 | 2 |
| Their C++ tests | `plugins/mpegts-core/native/mrts/tests/ts_timeline_test.cpp` | 1,550 | 2 |
| Python twin classes and tests — **kept** as reference (OQ-1); no runtime importer after this phase but `branch_retime.py` (Phase 3) | `plugins/mpegts-core/py/ts_timeline.py:155–1394`, `ts_timeline_test.py` (matching cases) | 0 (1,240 + 1,175 stay) | 3 |
| subtitle-core's `TimelineStamper` users | `plugins/subtitle-core/py/subtitle_stamp_dump.py` (retired); `subtitle_pack_test.py`, `subtitle_ts_engine_test.py`, `subtitle_peshouse_gst_test.py` (ported to a local identity stamp) | 63 + ~30 edited | 3 |
| Anchored properties and messages | `plugins/mpegts-core/native/mrtsstamp/gstmrtsstamp.cpp` | 410 | 3 |
| Anchored element tests | `packages/engine/src/child-process/gst_mrtsstamp_element_test.py` | 640 | 3 |
| Drift timer, repair/condition/house plumbing, anchored messages | `packages/engine/native/mr-gst-runner/stamper.{h,cpp}`, `runner.cpp:328–330` | 200 | 3 |
| Python probe backend (the twin) | `packages/engine/src/child-process/gst_stamp_probe.py` | 225 | 3 |
| Drift, backend choice, anchored events | `gst_bus_stamper.py`, `gst_stamp_native.py`, `gst_stamp_events.py`, `gst_bus_stamper_test.py` | 395 + 520 test | 3 |
| Splitter stamper, conditioner, flags, `timeline` stats | `plugins/ts-splitter/native/mr-tssplit/{app.h,app.cpp,main.cpp}`; `engine/nativeRunner.ts`, `TsSplitterModule.ts:222–228`; anchored cases in `tests/mrTssplit.test.ts` | 200 | 4 |
| Splitter parity vitest (S0 part 6.2) | `plugins/mpegts-core/tests/nativeSplitParity.test.ts`, `mrts_cli` splitter mode; the `py/{ts_split.py, ts_split_test.py, native_parity_ref.py, native_parity_fixture.py}` they drove stay as reference (OQ-1) | ≈ 195 (856 Python stay) | 4 |
| Fan-out anchored stamper and `--stamp-timeline` | `plugins/unixfdbus-core/native/mr-bus-fanout/main.cpp` | 30 | 5 |
| Python fan-out (C-4) | `plugins/unixfdbus-core/py/unixfd-fanout.py`, its blocks in `tests/unixfdFanout.test.ts` | 521 + 210 | 5 |

#### 6.2 Engine fields, settings, glue

| What | Path | WI |
|---|---|---|
| `latchRepair`, `conditionStepMs`, `houseTimelineEgress`, `preserveSourceTimeline` (+ `PreserveSourceTimelineConfig`), `isDeliveryLeadProducer` | `packages/engine/src/plugins/PluginModule.ts`; `GstPluginBase.ts:145–252`; `GstChildProcess.ts:249–256`; `PythonProcess.ts:62`; `nativeRunner.ts:35`; `ModuleInstance.ts:365`; `HlsPlayerModule.ts:104–107` | 3, 5 |
| Latch-repair resolution | `packages/engine/src/plugins/latchRepair.ts` (+ test), `index.ts:199`, `MediaRouter.ts:620–648` (+ `MediaRouter.latchRepair.test.ts`) | 3 |
| `preserveSourceTimeline` runner code | `gst-pipeline-runner.py:1124–1324`, `gst_preserve_timeline_test.py` | 3 |
| Declarations | `houseTimelineEgress` in transcoder, audio-transcoder, mpegts-muxer, teletext-subtitles; `preserveSourceTimeline` in transcoder, audio-transcoder | 3 |
| `timeline_settled` log | `packages/engine/src/child-process/GstRunner.ts:565` | 3 |
| Input stall watch | `source_gate.cpp:406–543`, `runner.cpp:324`, `gst-pipeline-runner.py:2115, :3816–3839`, `gst_input_stall_watch.py` (+ test), `busHelpers.ts:123`, `PluginModule.ts:574–577, :607`, `GstChildProcess.ts:259`, `index.ts:112`, `mpegtsMuxerPipeline.ts:69, :344–345` | 12 |
| Settings | `mixLatencyMs` in `plugins/{audio-mixer,n1-mixer-302m,audio-processing,audio-output-302m}/package.json`; `queueLeaky`, `queueDepthMs` in `plugins/mpegts-muxer/package.json` (C-2) | 9, 10, 11, 12 |
| Fixed budgets | `OUTPUT_MIX_LATENCY_NS` (`n1Mixer302mPipeline.ts:128`); `MUX_INPUT_QUEUE_MS` and the mux `latency`/`min-upstream-latency` (`mpegtsMuxerPipeline.ts:81, :271`); branch queue in the mixer arm | 8, 9, 12 |
| 302M helper API | `pacedMixer`, `PacedMixerOpts`, `ignorePcrClause`, `ignorePcr`, `latencyMs`, `mixerLatencyNs`, `demuxes` (`audio302mHelpers.ts`) | 8 |
| Sparse restamp and GAP timer | `mux_routing.py:119–120, :502–560`; `mux_routing.cpp:24–25, :246–315` and their state | 12 |
| Engine-side ducker | `plugins/audio-processing/engine/duckerEnvelope.ts` (+ test), the `sclevel` branch and `duckvol`, the envelope loop in `AudioProcessingModule.ts:146, :166–178` | 10 |
| audio-output-302m one-offset alignment and mixer-latency subtraction | `AudioOutput302mModule.ts:175–187, :250` | 11 |

#### 6.3 Documents

ADR-0005 decision 2 (with the 2026-09-05 and 2026-10-08 notes) and decision
4 marked superseded; ADR-0018 superseded; ADR-0008 partly superseded
(OQ-21); `plugins/README.md` latch repair, conditioner, `--stamp-timeline`,
`houseTimelineEgress` and `pacedMixer` text (WI-P2-15).

### 7. Tests and fixtures

#### 7.1 Unit tests (C++, no GStreamer)

| Test | Pins | Where |
|---|---|---|
| `ts_house_test.cpp` (extended) | `IdentityStamp` against vectors recorded from today's house-timeline cases | `plugins/mpegts-core/native/mrts/tests/` |
| `ts_timeline_test.cpp` (cut) | `timing_pes` only, until Phase 3 | same |
| `align_watch_test.cpp` | W learning, pace group rules, gap planning, stale horizon | same |
| `ducker_envelope_test.cpp` | Envelope port against vectors from `duckerEnvelope.test.ts` | `plugins/audio-processing/native/mrducker/tests/` |

#### 7.2 Element dataflow tests (Python harness, native elements)

| Test | Pins |
|---|---|
| `gst_aligner_behaviour_test.py` | WI-P2-1's six aggregator behaviours on 1.28.2 |
| `gst_mralignwatch_element_test.py` | WI-P2-6 cases 1–7 |
| `gst_mrtsdemux_element_test.py` | Formula PTS, one buffer per PES, GAP, DISCONT, wrap, no-stream warning |
| `gst_mrtsstamp_element_test.py` (cut) | Identity stamps, coalescing, counters |

All in `packages/engine/src/child-process/`, run by `test:py`.

#### 7.3 Protocol tests in both runners

`native_runner_protocol_test.py` (native) and the same cases through
`gst-pipeline-runner.py`:

| Case | Change |
|---|---|
| B / B2 | B2 (identity egress) is the only egress case. |
| L (live input branches) | New branch string with `mrtsdemux` and `mralignwatch`; add and remove a source on a running mixer; the live branch's PTS equal `PES − 1 h` from its first buffer (the shape of #837's case R, with no runner retime). |
| P (mux inputs retimed) | A KLV input added; its output PES PTS unchanged. |
| New: `aligner-absent` | One of three mixer inputs stops for 2 s: mixer output continuous, `mralignwatch` absent then present, stale count > 0, no `error`. |
| New: `native-plugins` | `libgstmrtshouse.so` with `mralignwatch` and `mrtsdemux`, and `libgstmrducker.so`, load in both runners (S0's `mrtshouse-load` extended). |

#### 7.4 Conformance fixtures from field captures

S0's fixtures (`plugins/mpegts-core/tests/fixtures/`) are reused:
`cap-302m-bssd.ts`, `cap-klv-sparse.ts`, `cap-occ-1080i-h264-aac-ttx.ts`,
`cap-srt-ingest-1316.ts`, `cap-mux-align7-aac-opus.ts`, `syn-wrap-33bit.ts`.
New captures are taken on the gate after Phase 1 is installed, so they carry
house time from the ingest restamp:

| Fixture | Source | Pins | Used by |
|---|---|---|---|
| `cap-837-programme-302m.ts`, `cap-837-key-302m.ts` | .108: a RIST input's 302M programme after `mrtsrestamp`, and the key source of #837's set-up, 90 s each (≤ 2 MB each at 302M stereo 16-bit is ≈ 10 s; the 90 s run uses the same capture looped by `fixture_gen.cpp --loop`) | #837's inputs | `scn-837-ducker-mixer` |
| `cap-836-program-step.ts` | the #836 source through Phase 1's restamp on .103 | A source restart: one program, one gap, no split | WI-P2-4 |
| `cap-transcoder-burst.ts` | the transcoder rendition egress on .108 | Bursty arrival rhythm (W learning) | `scn-align-bursty` |
| `cap-opus-32k.ts` | audio-encoder Opus 32 kbit/s on .108 | Low-rate arrival rhythm | `scn-align-bursty` |
| `cap-ttx-gate01.ts` | NO-OCC-Gate01 teletext PID | Sparse teletext into the muxer | `scn-mux-klv` |

Scenarios (`aligner_conformance_test.py`, expectations
`<scenario>.expect.json` beside the fixtures):

| Scenario | Graph | Pass condition |
|---|---|---|
| `scn-837-ducker-mixer` (R15) | programme → audio-processing (ducker, key = the key source) → audio-mixer beside the key source | 90 s: zero silence-fill not present in the inputs; programme in the mix sample-exact (0 samples) at its content time; key source within 1 sample of its own; ducker egress PES PTS = its input PES PTS (0 ticks) |
| `scn-split-passthrough` | `cap-occ-1080i-h264-21aac-ttx.ts` (the OCC recording's first 2 MB, every PID; B-54, B-85) → mr-tssplit (3 outputs) | WI-P2-4 acceptance 1–4 |
| `scn-mux-klv` | video + KLV (`cap-klv-sparse.ts`) + teletext → mpegts-muxer | Output KLV/teletext PES PTS = input (0 ticks); video PES cadence constant between cues |
| `scn-align-absent-rejoin` | 3 × 302M → audio-mixer; one input silenced 2 s | Absent within W + 20 ms; output continuous; output lateness unchanged ± 5 ms while absent; on return, stale count and ms reported; no restart |
| `scn-align-slow-joiner` | 2 inputs, a third added live with +500 ms lateness | One output gap of 500 ± 25 ms; then all three aligned at content time; pace +500 ms |
| `scn-align-late-delivering` | one input delayed 1.5 s, still delivering | Nothing dropped (sample count in = out); no absence |
| `scn-align-bursty` | transcoder-burst + Opus 32k into the muxer | No absence in 10 min; W reported ≥ 3× p95 gap |
| `scn-align-wrap` | `syn-wrap-33bit.ts`-derived 302M through mrtsdemux → audio-mixer | No step across the wrap |

#### 7.5 Tests deleted or rewritten

Deleted with their code (part 6): the anchored cases of
`ts_timeline_test.{cpp,py}`, `gst_mrtsstamp_element_test.py`,
`gst_bus_stamper_test.py`;
`gst_preserve_timeline_test.py`; `latchRepair.test.ts`,
`MediaRouter.latchRepair.test.ts`; `gst_input_stall_watch_test.py`;
`nativeSplitParity.test.ts` and `ts_split_test.py`; `duckerEnvelope.test.ts`;
the anchored and repair cases of `mrTssplit.test.ts`, `nativeRunner.test.ts`
(ts-splitter), `unixfdFanout.test.ts`, `GstPluginBase.timeSync.test.ts`,
`busRunnerContract.test.ts`, `GstChildProcess.test.ts`. Rewritten: the 302M
helper, mixer, processing, output-302m and muxer builder tests.

### 8. Manager and UI

| Item | Change |
|---|---|
| Settings removed | `mixLatencyMs` on audio-mixer, n1-mixer-302m, audio-processing, audio-output-302m; `preserveSourceTimeline` on transcoder and audio-transcoder; `queueLeaky` and `queueDepthMs` on mpegts-muxer (C-2). Stored values are ignored, nothing migrated (Q9). `packages/manager/src/plugins/manifestHelpText.test.ts` updated. |
| Settings kept | Ducker threshold, depth, attack, release, hold: now live properties of `mrducker`, same ranges and help text. ts-splitter `playoutOffsetMs`, audio-output-302m `lipSyncMs`: unchanged until Phase 4. |
| Aligner modules (audio-mixer, n1-mixer-302m, audio-processing, mpegts-muxer, audio-output-302m's fan-in) | P0's `timing` section gains "Pace" and "Waiting for"; each `timing-in-<n>` gains State (present/absent), Silence limit (ms), Absences, Discarded on rejoin (ms). Warnings `input-absent` and `aligner-full`. |
| ts-splitter | Stats lose the drift/timeline object; lateness per output stays (P0). |
| Duck graph | Fed by `mrducker` messages instead of the engine envelope; same widget. |
| Device Manager | None. |
| Release notes | Removed settings; the muxer no longer restarts on a dark input (it continues and alarms); mixers add the latency of their slowest input instead of dropping it; the ducker now follows content time, so a late key no longer ducks late. |

### 9. Image and Yocto

- No recipe change. The new files land under
  `${libexecdir}/media-router/` through the existing `native-install`
  (Yocto: `meta-layers/meta-custom/recipes-apps/media-router/media-router.bb:156–166`,
  `FILES:${PN}` at :282–283 covers `${libexecdir}/media-router`):
  `mpegts-core/libgstmrtshouse.so` (with `mralignwatch`, `mrtsdemux`),
  `audio-processing/libgstmrducker.so`, and the rebuilt `mrtsstamp`,
  `mr-tssplit`, `mr-bus-fanout`.
- `audiointerleave` ships in `libgstaudiomixer.so` (gst-plugins-base), which
  the image already carries for `audiomixer`.
- The release is a RAUC image, not a dist tarball: the native set and the
  TypeScript builders ship in one image and a dist-only deploy must not
  outrun the sidecars (the rule learned from the 2026-08-05 unixfd
  protocol skew on 10.9.1.42, recorded in the project's deploy notes, not
  in the repository).

### 10. Telemetry and alarms

| Signal | Source | Shown as | Level |
|---|---|---|---|
| Input absent / present | `mralignwatch` state change | `input-absent` warning naming the input; cleared on return; event with the absence duration | warning; never drops |
| Stale discard on rejoin | `mralignwatch` `stale-buffers`, `stale-time` | Engine event; `timing-in-<n>` "Discarded on rejoin" | info |
| FIFO full | `mralignwatch` `full-count` | `aligner-full` warning (resource fault, R9) | warning |
| Pace, waiting-for | `mralignwatch` group | `timing` section | info |
| W per input | `mralignwatch` `silence-limit` | `timing-in-<n>` | info |
| Late sparse cue | `mralignwatch` (sparse) | Event "cue after its time, forwarded late, pace raised by <ms>" (C-3) | warning |
| No matching stream | `mrtsdemux-no-stream` | Module health warning "no 302M stream on input <n>" | warning |
| Demux gaps, CC loss | `mrtsdemux` counters | `timing-in-<n>` | info |
| Duck gain, key, phase | `mrducker` | Duck graph | info |
| First identity stamp | `mrtsstamp-identity`, sidecar log | Runner log line | log |
| Removed | `timeline_restamped` (as anchored anchor), `timeline_reanchor`, `timeline_settled`, `timeline_conditioned`, `timeline_drift`, the sidecars' `timeline` stats, busStamp drift logs | — | — |

### 11. Verification on the test fleet

Run on 10.9.16.103 (Pi 5) and 10.9.16.108 (Pi 4) with the Phase 2
development image (the release image is the Phases 1–4 one, OQ-13),
in both runners where marked (`MR_GST_RUNNER_NATIVE=0` and `=1`).

| # | What | Rig and tool | Pass |
|---|---|---|---|
| V1 | #837's scenario (R15) | .108: RIST input → audio-processing (ducker, second source as key) → audio-mixer beside the key source; `bus-capture.sh` on the mixer egress and the inputs; `pcm_align.py`; `pes_diff.sh` on the ducker egress vs its input. Both runners. | 10 min: silence-fill 0 % beyond what the inputs carry; programme offset 0 samples; key source ≤ 1 sample; ducker egress PES PTS = input PES PTS (0 ticks). |
| V2 | Splitter pass-through | .103: srt-input (third-party encoder) → ts-splitter → three consumers; `pes_diff.sh` input vs each output; `tools/runner-cpu-profile.sh` | 10 min: PES crc32 identical; injected PCR values ⊂ input PCR values; wire stamps = PES − 1 h; splitter CPU ≤ the Phase 1 build on the same feed. |
| V3 | Muxer keeps sparse PTS | .103 OCC rig: transcoder video + KLV subtitles + teletext → mpegts-muxer → video-player | Output KLV PES PTS = input (0 ticks); player frame rate steady through cues; no restamp log lines. |
| V4 | Absent and rejoin | .108: 3 inputs into audio-mixer; stop one producer 30 s, restart it | Warning within W + 20 ms; mixer output continuous; output lateness unchanged ± 5 ms while absent; on rejoin, stale ms reported; no module restart. |
| V5 | Slow joiner | .103: live-add a transcoded input (≈ 400–600 ms later) to a running muxer | One output gap ≈ the difference ± 25 ms; then aligned; no restart. |
| V6 | Late but delivering | .108: an input delayed 1.5 s by a dev-build `queue min-threshold-time` upstream | No absence; sample count in = out over 5 min. |
| V7 | audio-output-302m fan-in | .108: 2 sources into audio-output-302m | Plays at the same `stamp + D` as on the Phase 1 build within 1 ms (P0's render lateness). |
| V8 | Ducker on content time | .103: audio-processing ducker with the key route delayed by a transcode hop | Duck onset at the key's content time ± 15 ms (from `pcm_align.py` on the egress vs the key). |
| V9 | CPU | .108: audio-mixer 4 inputs; n1-mixer-302m 4 pairs; muxer 3 inputs; `runner-cpu-profile.sh` | Runner CPU ≤ the Phase 1 build + 10 %. |
| V10 | Soak | Both boxes, 24 h, the V1–V3 routes; the soak covers a bus-PTS wrap on one box (uptime chosen so `uptime mod 26.5 h` falls inside) | No error, restart or step; no absence except the injected ones. |
| V11 | Nothing anchored left | Both boxes: journal grep for `busStamp .* drift`, `latch settled`, `re-anchored egress`, `conditioned` | Zero matches over the soak. |
| V12 | Rollback (development check) | Install the Phase 1 development build on .108, then the Phase 2 build again; the release rollback, to the Phase 0 release, is chapter 8 V-P4-11 (OQ-13) | Both start and run V1's route. |

### 12. Risks specific to this phase

| # | Level | Risk | Mitigation |
|---|---|---|---|
| R-P2-1 | M | **The non-live aggregator trick fails** on 1.28.2 (an aggregator times out or misbehaves when upstream answers non-live). | WI-P2-1 first; recorded fallback (live, `latency` = 5 s fault cap, pace hold unchanged). |
| R-P2-2 (R15) | M | **#837's unrecorded revert reason returns.** | Its scenario is fixture `scn-837-ducker-mixer` and gate check V1 in both runners; none of #837's mechanisms is reused (part 3.6). |
| R-P2-3 (R21) | M | **W misfires** on bursty inputs; stale discards on false absences. | W from the measured rhythm with floor and ceiling; silence counted only while not blocked downstream; counters and alarms; `scn-align-bursty`. |
| R-P2-4 (R9) | M | **Backlogs exceed capacity.** The FIFO holds 5 s, and the leaky 5 s bus ingress queue (`busHelpers.ts:180`) sheds behind it. | `aligner-full` alarm; pace shown; the ingress queue stays `leaky=2` as an alarmed resource-fault backstop (OQ-30, chapter 8 WI-P4-5). |
| R-P2-5 | M | **The pace never falls by itself** (§6 item 4): after a transient slowdown, latency stays until an operator removes the input or the module restarts. | Decided behaviour; the pace and "Waiting for" are shown; release notes. |
| R-P2-6 | M | **A wedged-but-connected muxer input no longer restarts the module.** | Absence alarm names it; the operator restarts it. |
| R-P2-7 (R10) | M | **Hidden sample-count behaviour.** `audiomixer`'s 40 ms alignment threshold and 1 s discont-wait stay at their defaults; a foreign-clocked 302M input still drifts against its PTS until ASRC at decode (Phase 3, S1). | Pinned by fixtures at today's values; the R10 checklist carries both to Phase 3. |
| R-P2-8 | L | **Sparse retime ambiguity.** Two identical cue payloads in a row are joined by tail; the runner's retime orders them FIFO. | `scn-mux-klv` includes repeated cues; Phase 3's demux removes the join. |
| R-P2-9 | L | **Limiter lookahead** (5 ms default, ≤ 20 ms) shifts processed audio later than its PTS (§11.3 item 4). | OQ-22; fixture measures it. |
| R-P2-10 (R3) | M | **Scope.** One release touches every stamper user and every aligner, in both runners. | Order of WIs; fixtures per class; rollback via the Device Manager (V12). |
| R-P2-11 (R16) | L | **Frozen-model fixes queued against deleted code.** | Q2: triage after the migration. |

### 13. Open questions

| # | Question | Why the design doc does not answer it | Blocks | Proposed default |
|---|---|---|---|---|
| OQ-20 | Phase 2 needs the 302M aligners' inputs on content time, and Q7 forbids #837's retime, but the formula demux is §14's Phase 3. Is `mrtsdemux` built in Phase 2 in a one-stream select mode for the 302M fan-ins (audio-output-302m's included, as it shares the helper), with Phase 3 generalising it? | §13.1 Q7 says the retime is replaced by the formula demux, and §14 puts the demux in Phase 3; the two are not reconciled. §13.1 Q7 ("replaced with formula demux and W") and §11.1's audio-mixer row lean to yes; the residual is sequencing. (Shared with chapter 7.) | WI-P2-7, -8, -11; WI-P3-15 | **Yes**, select mode in Phase 2. |
| OQ-18 | After Phase 1, are the splitter, the three 302M aligner modules and the HLS fan-out the only anchored-stamper users, and which phase moves hls-player's PES to house time (§5.4)? | §14 row 1 lists ingests and captures but does not name hls-player or the fan-out. (Shared with chapter 5, whose draft asked the hls-player half and answered Phase 2; this draft assumed Phase 1.) | WI-P2-2, -3, -5; the deletion | **Yes**, with hls-player moved in **Phase 2** by WI-P2-5; Phase 2 does not ship until `grep` finds no other user. |
| OQ-21 | Is ADR-0008 (force-live, the pacer, `ignore-pcr`, the 20 ms floor) superseded in Phase 2 too? | §14 names only ADR-0005 decisions 2 and 4 and ADR-0018. | WI-P2-15 | **Yes**, those parts; the single-source bypass and the `continuationName` rule stay. |
| OQ-22 | Is the limiter's lookahead (5–20 ms) corrected, or only reported? | §11.3 item 4 lists it as unreported latency; no decision on correcting it. | WI-P2-10 | **Report** as added latency; no PTS correction in this version. |

All four were decided on 2026-10-12 by the orchestrator (owner delegated),
each at its default (chapter 15.1); the items follow them. Four questions
of the draft were closed during assembly because the design answers them
(chapter 15, C-2 to C-5): the muxer's `queueLeaky`/`queueDepthMs` go in
Phase 2; a late sparse cue is forwarded, never discarded;
`unixfd-fanout.py` is deleted; the §11.1 wording on W is a design-doc
edit.

### 14. Estimate

| WI | Added | Deleted | Days |
|---|---|---|---|
| P2-1 Aggregator behaviour test | 350 | 0 | 1.5 |
| P2-2 `IdentityStamp`, `mrts` deletions | 140 | 2,900 | 1.5 |
| P2-3 Identity-only egress, runners, engine | 200 | 3,400 | 4 |
| P2-4 Splitter pass-through | 120 | 400 | 2 |
| P2-5 HLS fan-out | 40 | 800 | 0.5 |
| P2-6 `mralignwatch` | 1,500 | 0 | 6 |
| P2-7 `mrtsdemux` select mode | 800 | 0 | 4 |
| P2-8 302M helper | 200 | 260 | 2 |
| P2-9 audio-mixer, n1-mixer-302m | 150 | 120 | 1.5 |
| P2-10 audio-processing, `mrducker` | 900 | 350 | 4 |
| P2-11 audio-output-302m fan-in | 30 | 80 | 0.5 |
| P2-12 Muxer | 250 | 950 | 3.5 |
| P2-13 Engine seeds and display | 400 | 20 | 2 |
| P2-14 Fixtures and harness | 900 | 0 | 4 |
| P2-15 ADR and documents | 400 | 300 | 1.5 |
| P2-16 Gate verification | 250 | 0 | 3 |
| **Total** | **≈ 6,630** | **≈ 9,580** | **≈ 41.5** |

About 40 % of the added lines and 45 % of the deleted lines are tests. Of the
≈ 5,300 production lines §11.4 counts for stamping, ≈ 1,300 stay for
identity egress (`IdentityStamp`, the trimmed `mrtsstamp`, the runner splice
and lifecycle, `ts_timeline` helpers until Phase 3) and ≈ 4,000 go.

**Critical path** (three engineers, ≈ 19 working days):

1. Aligner track: WI-P2-1 (1.5 d) → WI-P2-6 (6 d) → WI-P2-8 (2 d) →
   WI-P2-10 (4 d) → WI-P2-14 scenarios (2 d of its 4) → WI-P2-16 (3 d)
   = 18.5 d.
2. Demux track, in parallel, needed by WI-P2-8: WI-P2-7 (4 d).
3. Deletion track, in parallel: WI-P2-2 → WI-P2-3 → WI-P2-4, WI-P2-5
   (8 d), then WI-P2-12 after WI-P2-6 (3.5 d).

WI-P2-9, -11, -13 and -15 fill the gaps. The serialising step is the image
with the whole native set, installed on both gate boxes before V1–V12 (a
development image; the release image is the Phases 1–4 one, OQ-13).

## 7. Phase 3 — Formula demux on every consumer; retime and K learning deleted

| Field | Value |
|---|---|
| Chapter | 7, work-item prefix P3 |
| Implements | §14 row 3 |
| Ships in | The Phases 1–4 release, developed after Phase 2 (§13.1: phases in order, each a cut-over; OQ-13: one release) |
| Code baseline | submodule `fc17468` (branch docs/house-clock-timing-design); every path below was checked with `ls`/`grep`/`wc -l` on 2026-10-12 |
| Paths | relative to the submodule unless marked "Yocto:" (relative to `/home/mrstation/media-router-yocto`) |
| External sources read | gst-plugins-bad 1.28.2 `gst/mpegtsdemux/tsdemux.c` (pad templates :272–292, pad names :2111–2134, teletext/DVB-sub/302M/KLV/ID3 mapping :1478–1510 and :1696–1709, DTS = PTS default :3802–3806, ADTS refine :3446–3516); gst-plugins-base 1.28.2 `gst-libs/gst/audio/gstaudiobasesink.c` (custom slaving :735–776 and :1259–1300) — local copies under `/home/mrstation/mr-hevc/` |
| Builds on | S0 (chapter 3: `mrts` core, `libgstmrtshouse.so`, loaders, fixtures, `mrts_cli dump`); P0 (chapter 4: `mrlateness`, `LatenessReporter`, `timing` sections); P1 (chapter 5: `mrtsrestamp`, the bus gap marker of OQ-12, `mrasrc` and `mrts::ClockLock`/`AsrcServo`); P2 (chapter 6: `mrtsdemux` select mode, `mralignwatch`, identity-only egress, the 302M helper on content time) |

"§n" refers to `docs/house-clock-timing-design.md` v0.6.

### 1. Goal

Phase 3 makes P9 true on every consumer (§14 row 3: "Native formula demux on
every consumer, and `tsdemux` leaves the bus path; ASRC at decode and at
outputs; retime, branch alignment and K learning deleted"). The native
element `mrtsdemux`, which Phase 2 built in a one-stream select mode for the
302M fan-ins, is generalised into a full replacement for `tsdemux` on the
bus: SOMETIMES pads named and capped as `tsdemux` names and caps them today,
PES reassembly for every PID, and running time = `unwrap(PES PTS) − 1 h`
(DTS likewise) for every buffer. Every consumer pipeline string moves to it
in one release. The bus stamp is never read for time again, so the three
estimators of a producer's mapping go: branch alignment, per-access-unit
retime (both runners) and the subtitle K learning (`mrpeshouse`,
`StampModel`, the Python chunk joins). Audio is rate-matched where it first
becomes PCM (P7): a decode ASRC engages only on a foreign-clocked stream,
and every physical audio output gains an ASRC to its device clock, which
replaces skew slaving. After this release nothing downstream of an ingest
re-estimates time.

### 2. Design references

| Reference | What it decides for this phase |
|---|---|
| §14 row 3; §13.1 "Every phase is a cut-over" | Scope; the retime, branch alignment and K learning go in this release; no flag, no legacy arm; rollback is the previous release from the Device Manager. |
| P9, §6 item 2 | Running time = `unwrap(PES PTS) − 1 h`, DTS likewise; no PCR skew, no payload join, no learned K; the bus stamp is not read for time; stock `tsdemux` rejected in both configurations (a1, a2); the conformance fixture list (B-frames, several PIDs per buffer, 33-bit wrap, gaps, PMT change, PES without PTS, sparse private streams), each replayed through both runners. |
| §13.1 "The consumer demux is a native element that writes the formula" | No bridge: consumers switch from `tsdemux` in Phase 3. |
| §13.1 "One shared native TS module"; §11.5 lead and item 2 | The demux is a user of the shared mpegts-core module; loaded by both runners; no Python twin. |
| §13.3 "Native demux caps table and fixture set" | Cover every stream type the consumers decode today; fixtures as §6 lists (R1). Engineer's choice, recorded in the ADR. |
| P7; §5.4 rate-handling column; §11.5 item 4; §13.1 "Audio is resampled once" (R5) | ASRC once per audio path where it first becomes PCM (first decode of a foreign-clocked compressed or 302M stream), never again on the bus; outputs resample to the device clock. |
| §8 "Leaving the house clock" | The output ASRC follows the measured ratio between device clock and house clock, not its buffer fill; it replaces skew slaving. |
| §13.3 "ASRC implementation" | `GstAudioResampler` with scaled rates (chosen in P1, `mrasrc`). |
| §11.1 rows transcoder, audio-transcoder, mpegts-muxer, teletext-subtitles, aes67-output, video-player, audio-decoder, audio-output-302m | "Formula demux" on each; "ASRC where foreign-clocked audio is decoded"; "The video player renders video only; any audio PID is dropped at its demux". |
| §11.3 item 3; §11.4 rows 3–4 | Per-AU time is not in the bytes today; branch alignment and per-AU retime (≈ 2,100 lines) and subtitle K recovery (≈ 700) are replaced by the formula demux. |
| §13.1 Q18 "The video player renders video only" | Audio PIDs dropped at the player's demux. |
| §13.1 Q9 "Today's timing settings fall away" | `subtitleDelayMs` is removed with its mechanism (OQ-24 for the phase). |
| §15 | Catch-up later needs "ASRC at the outputs (Phase 3)". |
| R1, R3, R5, R9, R10, R12, R19, R20, R22 | Coverage, scope, ASRC cost, unbounded PES memory, hidden element behaviour, behaviour change, wrap, mixed fleet, A/V between outputs. |

### 3. Current state

#### 3.1 The `tsdemux` strings on the bus path

Ten pipeline strings in nine builder files feed eleven modules (inventory
`02-inventory.json`, re-checked with `grep -rn tsdemux` at `fc17468`).

| # | Builder (file:line) | Module(s) | Runner | Demux today | Time correction today |
|---|---|---|---|---|---|
| 1 | `plugins/audio-302m-core/engine/audio302mHelpers.ts:222` (`build302mMixBranch`) | audio-mixer, n1-mixer-302m, audio-processing, audio-output-302m (mixer arm) | native | `tsdemux latency=0 ignore-pcr=true ! audio/x-smpte-302m` | a1 latch on the first PES; audio-output-302m one-offset align. **Replaced by `mrtsdemux select=` in Phase 2 (WI-P2-8, OQ-20).** |
| 2 | `plugins/audio-302m-core/engine/audio302mHelpers.ts:359` (`buildAudioMixInput`, single source) | same | native | same | same; **Phase 2** |
| 3 | `plugins/aes67-output/engine/Aes67OutputModule.ts:266` | aes67-output | native | `tsdemux latency=0` (PCR mode) | none: tsdemux PCR skew drives `udpsink sync=true` |
| 4 | `plugins/audio-decoder/engine/AudioDecoderModule.ts:393` | audio-decoder | native | `tsdemux name=addemux latency=0`, first pad wins (no caps filter) | one-offset `alignBranchesToStamps` (`:449`) |
| 5 | `plugins/audio-transcoder/engine/audioTranscoderPipeline.ts:145` | audio-transcoder | native | `tsdemux name=demux latency=0` | per-AU retime, `transformProducer` (`AudioTranscoderModule.ts:250`) |
| 6 | `plugins/mpegts-muxer/engine/mpegtsMuxerPipeline.ts:146` | mpegts-muxer (one per input) | native | `tsdemux latency=0 name=demux_<i>` | per-AU retime ×N (`MpegTsMuxerModule.ts:249`); Phase 2 admits `private_`/`subpicture_` pads to it |
| 7 | `plugins/subtitle-core/engine/subtitleOverlay.ts:199–204` (`buildSubtitleInput`) | transcoder burn-in, video-player overlay | python (the `subtitle_bridge` hook pins it) | `buildTsUdpInput(…) ! tsdemux name=subdemux latency=0` | KLV payload joined to its bus-chunk stamp (`StampIndex`) |
| 8 | `plugins/teletext-subtitles/engine/teletextPipeline.ts:95–97` | teletext-subtitles | python (hook pins it) | `tee name=in_t ! queue ! tsdemux name=demux latency=0 ! capsfilter caps="application/x-teletext"` | teletext pad retimed by chunk-stamp join and K (`subtitle_pay.install_retime`, `mrpeshouse`) |
| 9 | `plugins/transcoder/engine/transcoderPipeline.ts:241` | transcoder | native (python with subtitles) | `tsdemux name=demux latency=0 ! capsfilter caps="video/x-h264"` | per-AU retime, `transformProducer` (`TranscoderModule.ts:304`) |
| 10 | `plugins/video-player/engine/helpers/pipelines.ts:522` | video-player | native (python with subtitles) | `tee name=vp_ts ! tsdemux name=vpdemux latency=0 ! [video caps !]` | one-offset `alignBranchesToStamps` (`pipelinePlan.ts:290`) |
| — | `packages/engine/src/routing/MpegTsProbe.ts:83–92` | codec probe for audio-decoder, audio-transcoder | separate `gst-launch-1.0` | `tsdemux latency=0 ! parsebin ! fakesink` | none (no timing role; OQ-25) |

Strings 7, 8, 9 and 10 (the paced variant) are fed by `buildTsUdpInput`
(`packages/engine/src/plugins/tsHelpers.ts:184–193`), which ends in
`tsparse set-timestamps=false` only to re-frame packets for `tsdemux`
(OQ-26).

#### 3.2 What consumers rely on in `tsdemux`

From the inventory, each item re-checked in the code:

- **Pad names** `<media>_<generation %01x>_<pid %04x>` (`tsdemux.c:2111–2134`),
  templates `video_%01x_%05x`, `audio_…`, `private_…`, `subpicture_…`
  (`:272–292`). The PID is parsed from the last `_` field in
  `packages/engine/native/mr-gst-runner/pad_link.cpp:102–111`,
  `packages/engine/src/child-process/gst-pipeline-runner.py:574–590`,
  `branch_align.cpp`, `plugins/mpegts-muxer/py/mux_routing.py:158–166`,
  `plugins/mpegts-muxer/native/mux-routing/mux_routing.cpp` and
  `plugins/subtitle-core/py/subtitle_pay.py:36–42`.
- **Per-codec caps** from stream type and descriptors (302M `BSSD`, KLV
  `KLVA`, teletext 0x56, DVB subtitling 0x59, Opus registration plus
  extension descriptor, AV1 `AV1G`, ID3); AAC `mpegversion` refined from the
  first ADTS header (`tsdemux.c:3446–3516`).
- **SOMETIMES pads** so `gst_parse` sets up delayed links to the capsfilter
  or queue after the demux (`pipelines.ts:484–495`,
  `transcoderPipeline.ts:181–185`).
- **PSI sections as element messages**, posted synchronously on the
  streaming thread before `pad-added`; `mux_routing` reads the PMT from them
  to plan output PIDs (`mux_routing.py:294–337`, `mux_routing.cpp:406–436`,
  both via `GstMpegts`).
- **`GstFlowCombiner`**: NOT_LINKED upstream only when every pad is
  not-linked; `mux_routing` sinks unrouted pads to a fakesink.
- **One whole PES payload per buffer** (parser-bypass mode in the muxer,
  `avdec_s302m`, `teletextdec`, the KLV reader).
- **`pad-removed` and re-add with generation + 1 on a PMT change**
  (`plugins/subtitle-core/py/subtitle_overlay.py:77–90`).
- **Sparse stream flag** on teletext, DVB subtitles, KLV and ID3, and
  `tsdemux`'s periodic sparse GAPs (`check_and_sync_streams`).
- **ISO 639 language tags** reaching `mpegtsmux` (source-language
  passthrough, `plugins/mpegts-muxer/engine/muxerInputs.ts:82`).
- **DTS = PTS** when a PES has no DTS (`tsdemux.c:3802–3806`).

#### 3.3 The runner alignment machinery

| Piece | Path | Lines | What it does |
|---|---|---|---|
| Native one-offset align | `packages/engine/native/mr-gst-runner/branch_align.{cpp,h}` | 440 + 38 | Sink-pad probe learns `K = min(stamp − ns(first PES))`, tail index, `GstPad.set_offset` on `audio_`/`video_` pads |
| Native per-AU retime | `packages/engine/native/mr-gst-runner/branch_retime.{cpp,h}` | 627 + 19 | `transformProducer`: PTS/DTS = K + PES per AU, K per stamp epoch, 64-byte tail join; uses `mrts::read_pes_pts`, `mrts::timing_pes` (`:390`, `:410`) |
| Native glue | `runner.cpp:13, :323, :398`; `runner.h:12`; `Makefile:29, :33` | ≈ 10 | `align::install`, `align::clear` |
| Python align block | `packages/engine/src/child-process/gst-pipeline-runner.py:1325–1832` | 508 | `_install_branch_stamp_align`, `_branch_align_join`, verdicts; called at `:2114`, cleared at `:2244` |
| Python retime | `packages/engine/src/child-process/branch_retime.py` | 439 | Python twin of the retime; copied by `packages/engine/package.json` `build` |
| Description field | `packages/engine/src/plugins/PluginModule.ts:544–567, :620–633` | ≈ 40 | `alignBranchesToStamps`, `AlignBranchesToStampsConfig` |
| Engine pass-through | `packages/engine/src/child-process/GstChildProcess.ts:250`; `packages/engine/src/plugins/GstPluginBase.ts:192, :242` | 3 | Forwarding and the contract-off drop |
| Module call sites | `AudioDecoderModule.ts:440–450`, `AudioTranscoderModule.ts:247–250`, `MpegTsMuxerModule.ts:246–249`, `TranscoderModule.ts:301–304`, `plugins/video-player/engine/helpers/pipelinePlan.ts:283–290`; `mpegtsMuxerPipeline.ts:184` (`demuxes` result) | ≈ 60 | Declarations |

Total ≈ 2,180 production lines, matching §11.4's 2,100.

#### 3.4 The subtitle K recovery

The subtitle bridge is Python-only by decision (`subtitle_bridge.py:1–8`,
ADR-0016 amendment 2026-10-09); descriptions carrying it pin
`runner: 'python'`.

| Piece | Path | Lines | What it does |
|---|---|---|---|
| `mrpeshouse` element | `plugins/mpegts-core/native/mrpeshouse/` (`gstmrpeshouse.cpp` 215, `pes_walk.{cpp,h}` 101 + 66, `stamp_model.{cpp,h}` 60 + 59, `Makefile` 57, `tests/stamp_model_test.cpp` 89, `tests/stamp_model_vectors.txt` 3,667, `tests/README.md` 9) | 4,323 | Native PES walk of 0xBD and K learning from stamp rises; `pes-house` signal |
| K model | `plugins/subtitle-core/py/subtitle_stamp_model.py` | 86 | `StampModel.observe`, `chunk_reference` (spec of `stamp_model.cpp`) |
| Native splice | `plugins/subtitle-core/py/subtitle_native.py` (+ `subtitle_native_test.py` 150) | 99 | Loads `libgstmrpeshouse.so`, splices it before the demux |
| Chunk walk and join | `plugins/subtitle-core/py/subtitle_ts.py` | 172 | `iter_packets`, `parse_pes_header`, `PesStamper`, `StampIndex`; plus `klv_span`, `payload_key` (kept: resend dedupe key) |
| Probe | `plugins/subtitle-core/py/subtitle_runtime.py:58–76` | 19 | `chunk_probe` |
| Producer retime | `plugins/subtitle-core/py/subtitle_pay.py:50–119` | ≈ 70 | `install_retime`, `_on_source_pad`, `_on_source_buffer` |
| Consumer join | `plugins/subtitle-core/py/subtitle_overlay.py:18–33, :93–108`; `subtitle_cues.py:73–82` (`cue_t0` with `chunk_ms`) | ≈ 30 | KLV cue `t0` from the chunk stamp, else PTS, else arrival |
| Tools and tests | `subtitle_stamp_dump.py` 63, `subtitle_peshouse_gst_test.py` 139, `subtitle_ts_test.py` 136, `subtitle_ts_engine_test.py` 170, the `PesStamper` checks in `subtitle_pack_test.py:36–50`, the retime cases in `subtitle_bridge_test.py:151–167` | ≈ 560 | |

`subtitle_ts_engine_test.py:23, :86, :138` imports
`ts_timeline.TimelineStamper`, which Phase 2 deletes: WI-P2-3 ports that
test (and `subtitle_pack_test.py`, `subtitle_peshouse_gst_test.py`) to a
local identity stamp, and this phase deletes the files (C-8).

#### 3.5 What Phase 2 leaves for this phase

- `mrtsdemux` in `libgstmrtshouse.so`, select mode only: properties
  `select`, `program-number`; one ALWAYS src pad; formula timestamps; GAP on
  a PTS jump of more than two frames; DISCONT after CC loss;
  `mrtsdemux-no-stream`; `mrtsdemux` counters message (WI-P2-7). Used by the
  302M helper (rows 1–2 above) under OQ-20's default.
- The muxer's per-AU retime still runs, now also on `private_` and
  `subpicture_` pads (WI-P2-12).
- `plugins/mpegts-core/native/mrts/ts_timeline.{h,cpp}` cut to `timing_pes`
  and its helpers; `mrts/tests/ts_timeline_test.cpp` cut to its cases;
  `plugins/mpegts-core/py/ts_timeline.py:1–154` and their tests (P2 part 3.2).
- `ts_psi.h` inline forwarders `read_pes_pts`, `read_pcr` (S0 part 4.2).
- Presentation legs still at `stamp + D` with `sync=true` (Phase 4 removes).

#### 3.6 Audio rate handling today

- Decode chains have no ASRC. `audioresample` sits after the decoder as a
  fixed-rate converter (`audio302mHelpers.ts:224, :361`;
  `Aes67OutputModule.ts:270`; `AudioOutput302mModule.ts:208`); the
  audio-transcoder trunk has none (`audioTranscoderPipeline.ts:144–158`),
  and its encoders run `perfect-timestamp=true` (`:95–105`), which is
  correct only on house-rate PCM (§6 item 3).
- Outputs run `pulsesink sync=true provide-clock=false slave-method=skew`
  (ADR-0005 decision 5): `SLAVE_METHOD_SKEW = 1` in
  `plugins/audio-output-302m/engine/audio302mTiming.ts:21` and
  `AudioDecoderModule.ts:83`. Skew slaving drops or inserts at the drift
  tolerance (§8, R5). The audio-decoder still declares a `slaveMethod`
  setting (`plugins/audio-decoder/package.json:78`) that the contract path
  ignores (`AudioDecoderModule.ts:275–282`).
- `mrasrc` exists from Phase 1 at PCM captures only (P1 WI-P1-8): it locks
  input frame index against buffer PTS (`mrts::ClockLock`) and outputs a
  house-rate counter `PTS_out(m) = T0 + m / out_rate`.

#### 3.7 Tests that pin the machinery

| Test | Path | Lines |
|---|---|---|
| Branch align and retime dataflow | `packages/engine/src/child-process/gst_branch_align_test.py` | 956 |
| tsdemux re-slaving | `packages/engine/src/child-process/gst_tsdemux_slave_test.py` | 285 |
| Anchored-producer input fixture | `packages/engine/src/child-process/transform_input_fixture.py` | 352 |
| Protocol cases E (presentation leg, `:432–500`), M (`:1170–1338`), P (`:1339–1513`) | `packages/engine/src/child-process/native_runner_protocol_test.py` | ≈ 410 |
| Vitest pins | `GstChildProcess.test.ts:205–221`, `nativeRunner.test.ts:88`, `GstPluginBase.timeSync.test.ts:119–131` | ≈ 35 |

`packages/engine/package.json` `test:py` runs `gst_tsdemux_slave_test.py`
and `gst_branch_align_test.py`; `plugins/subtitle-core/package.json`
`test:py` runs `subtitle_ts_test.py`, `subtitle_native_test.py`,
`subtitle_peshouse_gst_test.py`.

### 4. Target state

#### 4.1 The element

`mrtsdemux` (`plugins/mpegts-core/native/mrtshouse/gstmrtsdemux.cpp`,
registered in `gstmrtshouse.cpp`'s factory table) over a GStreamer-free
core `mrts::DemuxCore` (`plugins/mpegts-core/native/mrts/demux_core.{h,cpp}`).
Two modes in one element:

- **Select mode** (Phase 2): `select` non-empty → one ALWAYS pad `src`.
  Unchanged, except that it shares the core.
- **Demux mode** (Phase 3, default): SOMETIMES pads per elementary stream,
  `tsdemux`-compatible names, templates, caps and event order.

| Property | Type, default | Meaning |
|---|---|---|
| `program-number` | int, −1 | −1 = first program in the PAT (`PsiDiscovery::select_program`) |
| `select` | string, "" | Phase 2's select mode |
| `media` | string, `video,audio,private,subpicture` | Pad classes exposed. PIDs of other classes are never reassembled (`PesAssembler::select(pid, false)`). |
| `sparse-gap-lag` | uint64 ns, 500 ms | Sparse pads get a GAP up to `program time − lag`; 0 = none |
| `gap-threshold` | uint, 2 | A DTS-or-PTS jump of more than this many frame intervals on a non-sparse pad pushes a GAP for the hole |
| `max-pes-bytes` | uint, 32 MiB | `PesAssembler::Config::max_bytes` (R9) |
| `unwrap-reference` | int64 ns, −1 | Test harnesses only: unwrap nearest this house time instead of `clock − base_time` |
| read-only | | `pes`, `gaps`, `cc-lost`, `pes-oversize`, `pes-no-pts`, `dts-discarded`, `unknown-streams`, `desync-bytes`, `generation`, `abi` |

No `latency` and no `ignore-pcr`: the strings drop them. The PCR is read
only to give sparse pads a program time.

**Data path per bus buffer**, all S0 API:

```
PacketWalker::feed (const) ─► CcTracker::feed
   ├─ PSI PIDs ─► PsiDiscovery::feed (select_program, generation)
   │              └─ new PAT/PMT section ─► element message, then pad plan
   ├─ PCR PID  ─► ts_pcr read_pcr ─► program time = pcr27_to_ns − 1 h (unwrapped)
   └─ ES PIDs  ─► PesAssembler::feed (keep_payload) ─► PesUnit
                    └─ Unwrapper::feed(pts, seed) / feed_dts(dts, pts_u)
                       PTS = pts90k_to_ns(pts_u − MUX_CLOCK_BASE_90K), DTS likewise
```

The seed is the unwrapped `ns_to_pts90k(clock − base_time) +
MUX_CLOCK_BASE_90K` for the first PES of a PID (valid while |lateness| <
13 h, §4.4); every later value unwraps nearest the previous one; DTS
unwraps nearest the PTS of the same PES, so the a1 wrap fault (§6) cannot
happen. The buffer's bus PTS/DTS are not read. Corrected 2026-10-14
(chapter 15.4 B-14): the draft seeded with `mux_pts_from_house(clock −
base_time)`, a 33-bit value, which on a box up more than 25.5 h puts
every buffer one 2³³ period (26.5 h) behind. `PacketWalker::feed (const)`
above is an overload this phase adds if the demux keeps its input
read-only; S0 built only the mutable form (chapter 15.4 B-15).

```cpp
namespace mrts {
enum class EsClass { Video, Audio, Private, Subpicture, None };
enum class AuPost { None, AdtsVersion, OpusAccessUnit, KlvMetadataCells };
struct CapsField { std::string key; std::variant<int, bool, std::string,
                                                 std::vector<uint8_t>> v; };
struct CapsSpec { std::string name; std::vector<CapsField> fields; };
struct EsPlan {
    int pid; uint8_t stream_type; EsClass cls; CapsSpec caps;
    bool sparse; AuPost post; std::string lang;      // ISO 639, may be ""
    std::vector<uint8_t> opus_ext, av1_desc;         // raw descriptor bodies
};
EsPlan classify(const PmtStream& s);                 // the caps table, 4.2
std::string pad_name(EsClass c, int generation, int pid);  // "audio_0_0141"

struct DemuxEvent {
    enum Kind { Section, ProgramPlan, ProgramGone, Unit, Gap, Unknown,
                NotHouseTime } kind;
    int pid; int64_t pts_ns, dts_ns, dur_ns;          // −1 = none
    bool discont; std::vector<uint8_t> bytes;         // payload or section
    const EsPlan* plan;
};
class DemuxCore {
  public:
    struct Config { int program = -1; uint32_t media_mask = 0xF;
        int64_t sparse_gap_lag_ns = 500'000'000; int gap_threshold = 2;
        size_t max_pes_bytes = 32u << 20; };
    void feed(const uint8_t* d, size_t n, bool bus_discont, bool bus_gap,
              int64_t house_now_ns, std::vector<DemuxEvent>& out);
    void drain(std::vector<DemuxEvent>& out);         // EOS
    void flush();                                     // FLUSH_STOP
    const DemuxCounters& counters() const;
};
}
```

**Pads and events, in `tsdemux`'s order.**

1. A new or changed PMT of the selected program: post the section as a
   `GstMpegtsSection` element message (`gst_mpegts_section_new`,
   `gst_message_new_mpegts_section`) synchronously on the streaming thread,
   then the PAT section the same way when it changed.
2. For each ES in `media`: create the pad from the template
   (`video_%01x_%05x` …), name it `pad_name(cls, generation, pid)`, push
   sticky STREAM_START (`gst_pad_create_stream_id_printf(pad, elem, "%08x",
   pid)`, one group-id per program, `GST_STREAM_FLAG_SPARSE` when sparse)
   and CAPS, then `gst_element_add_pad` and `gst_flow_combiner_add_pad`.
3. After the program's pads: post a `GstStreamCollection` message, then
   `gst_element_no_more_pads`.
4. Before a pad's first buffer: SEGMENT (TIME, start 0, base 0, time 0, so
   running time = the formula) and a TAG event with
   `GST_TAG_LANGUAGE_CODE` when the ES has an ISO 639 descriptor (0x0A).
5. On a PMT version change or a PCR PID change: `generation + 1`; new pads
   are added first (steps 1–3), then old pads flush their open PES, push
   EOS, `gst_flow_combiner_remove_pad` and `gst_element_remove_pad`.

**Buffers.** One PES payload per buffer (bounded PES at their length;
unbounded, `PES_packet_length` 0, at the next PUSI of the PID, EOS or
flush). PTS and DTS by the formula; DTS = PTS when the PES has none; a PES
without PTS leaves both NONE and counts `pes-no-pts`. DISCONT on a pad's
first buffer, after a CC loss (the open PES is dropped, `cc-lost` counts),
after a GAP and after a bus buffer flagged DISCONT. Flow results combined
with `GstFlowCombiner`.

**Gaps.** No side-band time is read (§6: the bus stamp is not read for
time). On a non-sparse pad a DTS-or-PTS jump of more than `gap-threshold`
frame intervals (interval = the median of the last 8 deltas) pushes
`GAP(last PTS end, new PTS − last PTS end)` before the buffer; the ingest's
per-ES guard (R18) keeps DTS-or-PTS monotonic, so a jump forward is a hole.
To settle before this is built (chapter 15.4 B-89): on a video pad two
intervals sit on one dropped frame under capture jitter, the boundary the
restamp's fixed mode had; give video pads the restamp's bound, a hole of
1 s or more.
A bus buffer with `GST_BUFFER_FLAG_GAP` (P1's marker, OQ-12) carries no
PES; it sets DISCONT on the next buffer of each PID it lists and lowers the
threshold for that PID's next jump to one frame. Sparse pads get
`GAP(last end, program time − sparse-gap-lag)` whenever that span exceeds
`sparse-gap-lag`, where program time is the formula applied to the
program's PCR (else to the newest non-sparse PTS).

**Upstream events and queries.** Upstream SEGMENT is swallowed (own
segment). FLUSH_START/STOP forwarded to every pad; `DemuxCore::flush`
resets the assembler, CC and unwrap state. EOS: `DemuxCore::drain` then EOS
on every pad. CAPS (`video/mpegts`) accepted. LATENCY answered as upstream
plus 0 (as `latency=0` today). SEEKING answered not seekable; POSITION and
DURATION go to the default handler.

**Guards.**
- `mrtsdemux-unknown-stream` (pid, stream type, registration) once per PID
  per generation for an ES whose class is in `media` but which the caps
  table does not cover; no pad, as `tsdemux` (R1, OQ-27).
- `mrtsdemux-not-house-time` (pid, offset ms) once per PID when its first
  formula PTS is more than 60 s from `clock − base_time`: the producer is
  not writing house time. There is no estimator left to absorb that, so it
  must be visible.

#### 4.2 Caps table

Every stream type the consumers decode or pass today (inventory "codecs",
`tsdemux.c` 1.28.2 as reference). Caps are identical strings to `tsdemux`'s.

| Stream type in PMT | Pad class | Caps | Sparse | AU post-processing | Consumers |
|---|---|---|---|---|---|
| 0x01, 0x02 | video | `video/mpeg, mpegversion=(int){1,2}, systemstream=(boolean)false` | no | — | video-player (decodebin3), muxer pass-through |
| 0x1B | video | `video/x-h264, stream-format=(string)byte-stream` | no | — | transcoder, video-player, muxer |
| 0x24; 0x06 + reg. `HEVC` | video | `video/x-h265, stream-format=(string)byte-stream` | no | — | video-player, muxer |
| 0x06 + reg. `AV1G` (+ descriptor 0x80) | video | `video/x-av1, stream-format=(string)obu-stream, alignment=(string)frame[, codec_data=(buffer)…]` | no | — | muxer, video-player (decodebin3) |
| 0x03, 0x04 | audio | `audio/mpeg, mpegversion=(int)1` | no | — | audio-decoder, audio-transcoder, muxer |
| 0x0F | audio | `audio/mpeg, mpegversion=(int)4, stream-format=(string)adts`; `mpegversion` set to 2 from the first ADTS header before the first buffer | no | `AdtsVersion` | audio-decoder, audio-transcoder, muxer |
| 0x11 | audio | `audio/mpeg, mpegversion=(int)4, stream-format=(string)loas` | no | — | audio-decoder/-transcoder (decodebin), muxer |
| 0x81; 0x06 + DVB AC-3 0x6A | audio | `audio/x-ac3` | no | — | audio-decoder, audio-transcoder, muxer |
| 0x87; 0x06 + DVB E-AC-3 0x7A | audio | `audio/x-eac3` | no | — | same |
| 0x06 + reg. `Opus` + DVB extension 0x7F/0x80 | audio | `gst_codec_utils_opus_create_caps(48000, channels, mapping family, stream count, coupled count, mapping)` (pbutils), as `tsdemux.c:1529–1690` | no | `OpusAccessUnit`: control header stripped, trim to clipping meta, one buffer list per PES (port of `parse_opus_access_unit`) | audio-decoder, audio-transcoder, muxer |
| 0x06 + reg. `BSSD` | audio | `audio/x-smpte-302m` | no | — | 302M fan-ins, aes67-output, audio-transcoder, muxer |
| 0x06 + DVB teletext 0x56 | private | `application/x-teletext` | yes | — | teletext-subtitles, muxer |
| 0x06 + DVB subtitling 0x59 | subpicture | `subpicture/x-dvb` | yes | — | muxer |
| 0x06 + reg. `KLVA`; 0x15 + metadata descriptor `KLVA` | private | `meta/x-klv, parsed=(boolean)true` | yes | 0x15 only: metadata AU cells split (`KlvMetadataCells`, port of `tsdemux.c:3518–3589`) | subtitle overlay, muxer |
| 0x06 + reg. `ID3 `; 0x15 + `ID3 ` | private | `meta/x-id3, parsed=(boolean)false` | yes | — | muxer (`data` class → fakesink) |
| 0x05, 0x0B, 0x86 (section-only) | — | no pad | — | — | none |
| 0x06 with no known descriptor; any other type (DTS, AC-4, LPCM …) | — | no pad, `mrtsdemux-unknown-stream` (OQ-27) | — | — | none today |

#### 4.3 Consumer strings after the cut-over

```
aes67-output:     <busSrc> ! <queue 200 ms> ! mrtsdemux select="audio/x-smpte-302m"
                  ! avdec_s302m ! mrasrc name=asrc bypass-below-ppm=0.5 out-rate=<rate>
                  ! audioconvert ! <aes67 caps> ! <payloader> ! udpsink … (unchanged)
audio-decoder:    <busSrc> ! mrtsdemux name=addemux media=audio ! queue … ! <decoder>
                  ! mrasrc name=asrc bypass-below-ppm=0.5 device-sink=sink
                  ! audioconvert ! volume ! level ! mrlateness … ! pulsesink name=sink … slave-method=custom
audio-transcoder: <busSrc> ! mrtsdemux name=demux media=audio ! queue … ! <decoder>
                  ! mrasrc name=asrc bypass-below-ppm=0.5 ! audioconvert … ! tee …
mpegts-muxer:     <busSrc> ! mrtsdemux name=demux_<i>   (pads → mux_routing, unchanged)
subtitle input:   <busSrc> ! <queue> ! mrtsdemux name=subdemux media=private
teletext:         <busSrc> ! <queue> ! tee name=in_t ! queue ! mrtsdemux name=demux media=private
                  ! capsfilter caps="application/x-teletext" ! tee name=t …
transcoder:       <busSrc> ! <queue> ! mrtsdemux name=demux media=video
                  ! capsfilter caps="video/x-h264" ! h264parse ! avdec_h264 …
video-player:     <busSrc> ! … ! tee name=vp_ts ! mrtsdemux name=vpdemux media=video ! [caps !] queue …
302M fan-in:      <busSrc> ! mrtsdemux select="audio/x-smpte-302m" ! avdec_s302m
                  ! mrasrc name=<b>_asrc bypass-below-ppm=0.5 out-rate=48000
                  ! audioconvert[ mix-matrix] ! audio/x-raw,rate=48000,channels=N ! mralignwatch …
audio-output-302m:… <mixer>_out. ! audioconvert ! mrasrc name=outasrc device-sink=sink
                  ! volume ! level ! [placement] ! pulsesink name=sink … slave-method=custom
```

`<queue>` is `buildTsUdpInput` without `tsparse` (OQ-26). No description
carries `alignBranchesToStamps`; the field does not exist.

#### 4.4 ASRC at decode and at outputs

`mrasrc` (P1) gains two behaviours; both are one resampler, never two in
series in one element.

- **Decode mode, `bypass-below-ppm` > 0.** The lock runs as at capture
  (input frame index against buffer PTS, which is content time from the
  formula demux). While the measured ratio stays within
  `bypass-below-ppm` of 1 and the accumulated phase error below 1 ms, the
  element is a zero-copy pass-through: a stream from a house-rate producer
  (every capture after Phase 1, every mixer, every encoder fed by them, HLS
  at nominal rate) is never resampled. When either bound is crossed it
  engages, from that buffer on, with the house-rate output counter of P1
  (`PTS_out(m) = T0 + m / out_rate`, T0 the PTS where it engaged), and stays
  engaged until a DISCONT. A stream from a network ingest carries its
  source's clock in its PTS deltas (§5.4: "the first PCM decode
  rate-matches it"), so it engages within seconds. Foreign-clocked is
  therefore measured, not flagged (C-7); the engage thresholds (0.5 ppm,
  1 ms, 10 s) are the engineer's and go in ADR-0029. Sample count and PTS
  then agree on every bus egress after it (P7).
- **Device mode, `device-sink=<name>`.** The element finds the named
  downstream `GstAudioBaseSink` at READY→PAUSED, requires its
  `slave-method=custom` (3), and installs
  `gst_audio_base_sink_set_custom_slaving_callback`. Each callback gives
  `(etime, itime)`: the house clock and the device (ring-buffer) clock. A
  second `mrts::ClockLock` on those pairs gives the device-vs-house ratio;
  the callback always returns `requested_skew = 0`, so the sink never drops
  or inserts. The commanded resampler ratio is the decode ratio (when
  engaged) times the device ratio: one resampler per path where decode and
  device are adjacent (audio-decoder, audio-output-302m single-source arm,
  OQ-23). Output timestamps are the contiguous counter from the first
  input PTS, re-anchored at DISCONT and GAP; they are device-time labels,
  which is what a `sync=true` sink needs while Phase 4 has not yet made it
  unsynchronised (C-6: §14 row 3 delivers "ASRC at decode and at
  outputs", §8 defines the output ASRC as following the measured
  device/house ratio, and §15 says catch-up needs "ASRC at the outputs
  (Phase 3)"; Phase 4 only switches the sink to `sync=false`, chapter 8
  WI-P4-4). P0's `lat_render` tap therefore moves before
  `mrasrc`, where PTS is still content time.
- `out-rate=0` negotiates the rate downstream asks for, so `mrasrc`
  replaces `audioresample` where one stood (part 3.6); one element converts
  nominal rate and clock together.

#### 4.5 What is gone

- `tsdemux` on the bus path (rows 1–10 of part 3.1). `MpegTsProbe` keeps it
  (OQ-25).
- `branch_align`, `branch_retime` (both runners), the
  `alignBranchesToStamps` field and every declaration of it.
- `mrpeshouse`, `StampModel`, the chunk walk and join, the producer retime,
  `subtitle_native`.
- What remains of `ts_timeline` in C++ and Python, and the `ts_psi.h`
  forwarders.
- Skew slaving on audio outputs, and the audio-decoder `slaveMethod`
  setting.
- `subtitleDelayMs` and the subtitle hold queue (OQ-24).
- `tsparse` in `buildTsUdpInput` (OQ-26).

### 5. Work items

Ordered by dependency, except that WI-P3-3 (fixtures) runs first in time,
as the critical path in part 14 shows; WI-P3-1 and WI-P3-2 use its
fixtures. Estimates are lines at this repo's comment density (±40 %) and
engineer-days including review.

#### WI-P3-1 `mrts::DemuxCore`: classification, pad plan, formula, gaps (OQ-27; fixtures from WI-P3-3)

- **What.** The GStreamer-free core of part 4.1 and the caps table of part 4.2.
- **Where.** `plugins/mpegts-core/native/mrts/demux_core.{h,cpp}`;
  `plugins/mpegts-core/native/mrts/tests/demux_core_test.cpp`; Phase 2's
  select-mode logic in `gstmrtsdemux.cpp` moves into the core.
- **How.**
  - `classify(const PmtStream&)`: switch on `stream_type`, then
    `registration_format` (S0) and `has_descriptor` for 0x56, 0x59, 0x6A,
    0x7A, 0x7F, 0x80; ISO 639 from 0x0A. Rows of part 4.2 in table order;
    anything else returns `EsClass::None`.
  - `pad_name`: `"%s_%01x_%04x"` with `video|audio|private|subpicture`.
  - `DemuxCore::feed`: the data path of part 4.1 over `PacketWalker`,
    `CcTracker`, `PsiDiscovery` (`select_program`, `generation`),
    `PesAssembler` (`select` from `media_mask`), `Unwrapper`. One
    `Unwrapper` per PID plus one for the program PCR. Emits `Section` for
    every new PAT/PMT section, `ProgramPlan` with the `EsPlan` list when the
    generation changes (then `ProgramGone` for the old one), `Unit` per
    complete PES, `Gap` per part 4.1, `Unknown` and `NotHouseTime` once.
  - AU post-processing as pure functions: `adts_mpegversion(payload)`,
    `opus_access_units(payload) → {packets, trim_start, trim_end}`,
    `klv_metadata_cells(payload)`.
  - Counters struct mirrored by the element's read-only properties.
- **Acceptance.** `demux_core_test.cpp`, no GStreamer:
  1. `classify` for every row of part 4.2 from descriptor loops taken out of
     the S0 fixtures, and `None` for 0x06 with no descriptor and for 0x86.
  2. `pad_name(Audio, 0, 0x141) == "audio_0_0141"`;
     `pad_name(Private, 1, 0x1FFF) == "private_1_1fff"`.
  3. On `syn-wrap-33bit.ts`: buffer PTS and DTS continuous across 2^33, a
     B-frame DTS behind its PTS at the wrap never offset by 2^33 ticks.
  4. On `cap-mux-align7-aac-opus.ts` at 188, 1316 and 24,576-byte chunking:
     identical `Unit` sequences (pid, pts, dts, crc32).
  5. `syn-pes-no-pts.ts`: units with pts −1 and `pes-no-pts` counted.
  6. `syn-gap-500ms.ts` (WI-P3-3): one `Gap` of 500 ms ± one frame per
     non-sparse PID; none on the sparse PID.
  7. PMT version bump in `syn-mpts-two-programs.ts`: `ProgramPlan` with
     generation 1 before the first unit of the new PMT, `ProgramGone` after.
  8. `PTS = pts90k_to_ns(unwrapped − MUX_CLOCK_BASE_90K)` exactly for every
     unit of every fixture (house PES, rebased to the test reference).
- **Estimate.** 650 + 600 test; 5 days.

#### WI-P3-2 `mrtsdemux` demux mode (OQ-27; fixtures from WI-P3-3)

- **What.** The SOMETIMES-pad mode of part 4.1 in the Phase 2 element.
- **Where.** `plugins/mpegts-core/native/mrtshouse/gstmrtsdemux.cpp`;
  `plugins/mpegts-core/native/mrtshouse/Makefile` (pkg-config adds
  `gstreamer-mpegts-1.0` and `gstreamer-pbutils-1.0`);
  `packages/engine/src/child-process/gst_mrtsdemux_element_test.py`
  (Phase 2's, extended).
- **How.**
  - Four static SOMETIMES templates with `tsdemux`'s names and caps sets,
    plus Phase 2's ALWAYS `src` template used only when `select` is set.
  - `chain`: map buffer → `DemuxCore::feed(…, GST_BUFFER_FLAG_DISCONT,
    GST_BUFFER_FLAG_GAP, clock − base_time)` → translate events in order:
    `Section` → `gst_mpegts_section_new(pid, g_memdup2(bytes), n)` +
    `gst_element_post_message(gst_message_new_mpegts_section(…))`;
    `ProgramPlan` → steps 2–3 of part 4.1; `ProgramGone` → step 5; `Unit` →
    buffer (SEGMENT and TAG first if pending), `AuPost` applied (ADTS caps
    update; Opus buffer list with `GstAudioClippingMeta`; KLV cells as a
    buffer list); `Gap` → `gst_event_new_gap`; `Unknown`, `NotHouseTime` →
    element messages. Push results into `GstFlowCombiner`.
  - Event, query and flow handling exactly as part 4.1.
  - `media` parsed once at READY; changing it while PLAYING is refused.
  - Stats: the Phase 2 `mrtsdemux` message every 1 s gains the new
    counters and `generation`.
  - No Python fallback and no `identity` stand-in: a runner that cannot
    load `libgstmrtshouse.so`, or finds its ABI too old, fails any module
    whose pipeline names `mrtsdemux` with the rule-6 alarm text (S0 part
    4.5 rule 6, WI-S0-8; decided 2026-10-12). Every consumer of part 4.3
    is such a module from this phase on. Start-but-warn applies only
    where a pass-through stand-in exists (the restamp, the egress writer,
    the alignment watch).
- **Acceptance.** `gst_mrtsdemux_element_test.py` (appsrc → element →
  appsinks, `unwrap-reference` set to the fixture's recording time):
  1. pad names, templates and caps per part 4.2 on every S0 and WI-P3-3
     fixture;
  2. a `sync-message::element` handler sees the PMT `GstMpegtsSection`
     before the first `pad-added` of that program;
  3. `gst_parse_launch("… ! mrtsdemux ! capsfilter caps=video/x-h264 ! …")`
     links by delayed link on an A/V fixture, and the AAC pad stays
     unlinked without stalling (flow combiner);
  4. PMT change: new pads `*_1_*` added, then EOS and `pad-removed` on
     `*_0_*`;
  5. Opus caps equal `tsdemux`'s on `cap-mux-align7-aac-opus.ts`, decoded
     sample count equal through `opusdec` from both demuxers;
  6. `media=video` on an A/V fixture adds exactly one pad;
  7. a bus buffer flagged GAP followed by a 300 ms jump gives one GAP event
     of 300 ms and DISCONT on the next buffer;
  8. a fixture whose PES are 2 h from the reference posts
     `mrtsdemux-not-house-time` once.
- **Estimate.** 900 + 350 test; 7 days.

#### WI-P3-3 Fixtures and replay rebase

- **What.** The Phase 3 fixtures of part 7.2 and a way to replay recorded
  house time on another clock.
- **Where.** `plugins/mpegts-core/tests/fixtures/` (OQ-2: in-repo, off the
  device per WI-S0-13); `plugins/mpegts-core/native/mrts/mrts_cli.cpp` (new
  verbs);
  `plugins/mpegts-core/native/mrts/tests/fixture_gen.cpp` (S0; options
  added); `tools/fixtures/record-bus.sh` (new).
- **How.**
  - Bus recordings keep per-buffer PTS, duration and flags (the gap
    marker), so they are GDP streams: `record-bus.sh <ip> <edge socket>
    <seconds> <name>` starts `unixfdsrc socket-path=<edge> ! gdppay !
    filesink` on the box with `systemd-run --user` and copies the file back
    with `mrscp`. ≤ 2 MB each (S0 rule).
  - `mrts_cli rebase <in> <out> --to-ns <t>`: adds one constant 33-bit
    offset to every PES PTS/DTS and PCR (S0 `rewrite_pes_timestamps`,
    `write_pcr`) so the first PES lands at house time t; GDP and raw TS.
    Timing relationships stay exact; the formula output on the rebased file
    is `rebased PES − 1 h`.
  - `fixture_gen.cpp`: `--gap <pid>:<at_s>:<len_ms>` (with or without the
    P1 marker buffer), `--private-novdesc <pid>` (0x06, no descriptor),
    `--mpts-pmt-bump <at_s>`.
  - Third-party codecs that no gate source carries (MPEG-1/2 video, AC-3,
    E-AC-3, LATM, DVB subtitles, ID3) are generated once on the dev box by
    `tools/fixtures/gen-thirdparty.sh` (`gst-launch-1.0` with `avenc_ac3`,
    `avenc_eac3`, `avenc_mpeg2video`, `lamemp3enc`, `mpegtsmux`), then
    passed through `mrts_cli rebase`; committed with the script.
  - Expectation files: `<name>.demux.jsonl` from `mrts_cli dump`
    (S0 format) plus the pad plan, reviewed by hand once.
- **Acceptance.** Every fixture of part 7.2 exists with its expectation;
  `mrts_cli rebase` round-trips (rebase by +x then −x is byte-identical).
- **Estimate.** 250 (CLI 120, generator options 60, scripts 70) + fixtures;
  3 days, including a capture session on the gate with the Phase 2 development image
  (the assistant session with rig access records, OQ-3).

#### WI-P3-4 Parity harness against stock `tsdemux`

- **What.** Proof that consumers see the same pads, caps, event order and
  payloads from `mrtsdemux` as from `tsdemux` 1.28.2, timestamps excepted.
- **Where.** `packages/engine/src/child-process/gst_mrtsdemux_parity_test.py`;
  allowlist `plugins/mpegts-core/tests/fixtures/demux_parity_allow.json`.
- **How.** Python harness (test tooling, not a twin): for each recorded
  fixture build `appsrc ! tsdemux latency=0` and `appsrc ! mrtsdemux`, link
  every pad to an appsink with `sync=false`, and record per pad: name,
  template, caps string at `pad-added`, sticky events in order
  (STREAM_START flags and stream-id suffix, CAPS, SEGMENT, TAG), buffer
  count, crc32 of each payload, DISCONT positions, GAP count; per element:
  element-message section types in order relative to `pad-added`,
  `no-more-pads`, `pad-removed`. Compare. Allowed differences, each with its
  reason in the allowlist: PTS/DTS values (the point), SEGMENT start/base,
  GAP cadence and positions on sparse pads, `tsdemux`'s non-PAT/PMT section
  messages (SDT, EIT, TDT: no consumer reads them), buffers `tsdemux`
  drops before its first PCR, pads `tsdemux` makes for types outside part 4.2.
- **Acceptance.** Every recorded fixture passes; the allowlist has a reason
  per entry; the run is in `packages/engine/package.json` `test:py`.
- **Estimate.** 500 test; 3 days.

#### WI-P3-5 `mrasrc`: decode bypass, device mode, negotiated output rate (OQ-23)

- **What.** part 4.4.
- **Where.** `plugins/mpegts-core/native/mrtshouse/gstmrasrc.cpp` (P1);
  `plugins/mpegts-core/native/mrts/asrc_servo.{h,cpp}` (P1) gains the
  bypass rule and the composite ratio; tests
  `plugins/mpegts-core/native/mrts/tests/asrc_servo_test.cpp`,
  `packages/engine/src/child-process/gst_mrasrc_element_test.py`.
- **How.**
  - Properties: `bypass-below-ppm` (double, 0 = never bypass; P1's
    captures keep 0), `device-sink` (string, "" = none), `out-rate` 0 =
    negotiate (transform_caps leaves rate free on src when 0).
  - Bypass: `ClockLock` runs on every buffer; while bypassed `transform_ip`
    passes the buffer through; engage on `|ε| > bypass-below-ppm` over ≥ 10
    s of lock, or `|phase| > 1 ms`; output counter starts at the engaging
    buffer's PTS. Message `mrasrc-event` `engaged` (ε ppm) once.
  - Device: at READY→PAUSED walk downstream peers to the element named
    `device-sink`; if it is not a `GstAudioBaseSink` with `slave-method=3`,
    post an error naming it (a builder bug). Callback: feed
    `(itime, etime)` into a second `ClockLock`; `*requested_skew = 0`;
    store the device ratio atomically; the transform thread multiplies.
    Callback on `discont_reason` ≠ NO_DISCONT: re-lock the device lock.
  - `mrasrc-stats` (P1) gains `mode` (`capture`, `bypass`, `decode`,
    `device`, `decode+device`), `source-ppb`, `device-ppb`.
- **Acceptance.**
  - Unit: a house-rate stream with ±5.5 µs PTS quantisation never engages
    in 1 h simulated; +3 ppm engages within 30 s; +0.3 ppm engages when
    phase reaches 1 ms (≈ 55 min); composite ratio = product within 0.01
    ppm.
  - Element: `audiotestsrc` at a 48,000.48 Hz clock through a formula-PTS
    harness engages; samples out per house second = 48,000 ± 1 over 10 min.
    Device mode with `pulsesink` replaced by a test `GstAudioBaseSink`
    subclass whose ring runs 40 ppm fast: no skew requested, no resync, the
    ring fill stays within ± 2 ms over 10 min.
  - Bench on .108 (P1's `asrc_bench.c`): 8 engaged stereo paths ≤ 25 % of
    one core.
- **Estimate.** 350 + 300 test; 5 days.

#### WI-P3-6 Runner and engine plumbing for the new messages

- **What.** Both runners forward `mrtsdemux*` element messages as plugin
  events (Phase 2 added the stats message; this adds the rest), and the
  engine shows them.
- **Where.** Native: `packages/engine/native/mr-gst-runner/runner.cpp`
  (ELEMENT handler, beside P0's `mrlateness` branch). Python:
  `packages/engine/src/child-process/gst-pipeline-runner.py` (same
  handler). Engine: `packages/engine/src/plugins/latenessReporter.ts` (P0),
  `packages/engine/src/plugins/GstPluginBase.ts` (`OwnedWarning`).
- **How.** Channel `mrtsdemux:<element>`; payload =
  `gst_structure_to_dict`. `LatenessReporter` adds to the input's
  `timing-in-<n>`: PES/s, gaps, CC errors, unknown streams; and to the
  module `timing` section from `mrasrc:<element>`: "Clock correction" (mode,
  ppm). Warnings `'demux-unknown-stream'` ("PID 0x0123: stream type 0x06
  with no known descriptor is not demuxed"), `'input-not-house-time'`
  ("Input <n> is <x> s off house time — its producer does not stamp house
  time"), `'asrc-out-of-bounds'` (P1 event), each cleared on the next
  generation or restart.
- **Acceptance.** `latenessReporter.test.ts` cases for each warning and
  each section field; protocol case `mrtsdemux-messages` (part 7.3).
- **Estimate.** 250 + 120 test; 2 days.

#### WI-P3-7 Subtitle consumers: input on the formula, overlay on PTS

- **What.** Consumer string 7 and the overlay half of the bridge.
- **Where.** `plugins/subtitle-core/engine/subtitleOverlay.ts:193–204`
  (`buildSubtitleInput`), `subtitleOverlay.test.ts`;
  `plugins/subtitle-core/py/subtitle_overlay.py`, `subtitle_cues.py`,
  `subtitle_runtime.py`, `subtitle_bridge_test.py`, `subtitle_cues_test.py`.
- **How.**
  - `buildSubtitleInput`: `… ! mrtsdemux name=${demuxName} media=private`.
  - `install_overlay`: no `index`, no sink-pad `chunk_probe`; pad-added and
    pad-removed handling unchanged (names and generation as `tsdemux`).
  - `_on_cue_sample`: `t0 = cue_t0(pts, now)`; `cue_t0` loses `chunk_ms`
    and returns `(pts, 'pts')` within `FRAME_TIME_TOLERANCE_MS`, else
    `(now, 'now')`.
  - `klv_key` imports `klv_span`/`payload_key` from `subtitle_klv.py`
    (moved there from `subtitle_ts.py`; dedupe of re-sends stays).
  - `subtitle_runtime.chunk_probe` deleted.
- **Acceptance.** `subtitle_cues_test.py`: `cue_t0` cases;
  `subtitle_bridge_test.py`: overlay installs without a sink probe, and a
  KLV buffer with PTS T gives a cue starting at T + rel.start; protocol
  case `subtitle-overlay-formula` (part 7.3) on the python runner.
- **Estimate.** +80 / −250; 1.5 days.

#### WI-P3-8 teletext-subtitles: producer retime deleted

- **What.** Consumer string 8 and the pay half's source retime.
- **Where.** `plugins/teletext-subtitles/engine/teletextPipeline.ts:95–97`,
  `TeletextSubtitlesModule.ts:121–132` and tests;
  `plugins/subtitle-core/py/subtitle_pay.py:36–42, :50–119`,
  `subtitle_bridge.py` (`sourceDemux`),
  `plugins/subtitle-core/engine/subtitleOverlay.ts:233–244`
  (`subtitleRunnerHook` loses `sourceDemux`).
- **How.** `tsdemux name=demux latency=0` → `mrtsdemux name=demux
  media=private`. Delete `install_retime`, `_on_source_pad`,
  `_on_source_buffer`, `pid_from_pad_name`, the `subtitle_native` import;
  the bridge no longer reads `sourceDemux`. `teletextdec` carries the
  teletext PES PTS (content time from the formula) to its text buffers;
  `PayState.new_cue` already takes that PTS.
- **Acceptance.** Module test: description has no `sourceDemux`;
  `subtitle_bridge_test.py` retime cases replaced by one that pins cue PES
  PTS = teletext PES PTS + offset 0 through a fake bridge pipeline;
  gate check V4.
- **Estimate.** +30 / −160; 1 day.

#### WI-P3-9 aes67-output

- **Where.** `plugins/aes67-output/engine/Aes67OutputModule.ts:263–272`,
  `Aes67OutputModule.test.ts`.
- **How.** `tsdemux latency=0 ! audio/x-smpte-302m` →
  `mrtsdemux select="audio/x-smpte-302m"`; `audioresample` →
  `mrasrc name=asrc bypass-below-ppm=0.5 out-rate=<aes67 rate>` before
  `audioconvert`. The `udpsink` and the RTP `timestamp-offset` are
  unchanged (Phase 0's E, Phase 4's sink policy).
- **Acceptance.** Snapshot test of the string; gate check V6 (RTP
  timestamps of a 302M programme equal `(formula running time + E) ×
  rate`, within one packet).
- **Estimate.** +15 / −10; 0.5 day.

#### WI-P3-10 audio-decoder (OQ-23, OQ-28)

- **Where.** `plugins/audio-decoder/engine/AudioDecoderModule.ts:83,
  :262–283, :393–450`, `AudioDecoderModule.test.ts`,
  `plugins/audio-decoder/package.json:78` (`slaveMethod`).
- **How.** String per part 4.3: `mrtsdemux name=addemux media=audio`
  (OQ-28); `mrasrc name=asrc bypass-below-ppm=0.5 device-sink=sink`
  after the decoder; `slave-method=custom`
  (`SLAVE_METHOD_CUSTOM = 3` replaces `SLAVE_METHOD_SKEW`); P0's
  `lat_render` tap placed before `mrasrc`. Delete `alignBranchesToStamps`
  (`:449`), the `slaveMethod` setting and its reads. `backlogShed`,
  `sync=true`, `ts-offset` stay until Phase 4.
- **Acceptance.** Module tests: string, no `alignBranchesToStamps`, no
  `slaveMethod` in the schema; protocol case `presentation-formula`
  (rewrite of E); gate V3, V7.
- **Estimate.** +60 / −45; 1.5 days.

#### WI-P3-11 video-player

- **Where.** `plugins/video-player/engine/helpers/pipelines.ts:484–524`,
  `pipelinePlan.ts:283–290`, `decoderSelection.ts:139–151, :197–199`
  (comments), tests.
- **How.** `tsdemux name=vpdemux latency=0` → `mrtsdemux name=vpdemux
  media=video` (Q18: audio PIDs never get a pad, which also removes the
  decodebin3 rung's audio-pad trap described at `pipelines.ts:484–495`).
  The caps steering stays. Delete `alignBranchesToStamps`.
- **Acceptance.** `pipelinePlan.test.ts`, `pipelines` snapshot; protocol
  case `video-leg-formula`; gate V3.
- **Estimate.** +30 / −35; 1 day.

#### WI-P3-12 audio-transcoder (OQ-28)

- **Where.** `plugins/audio-transcoder/engine/audioTranscoderPipeline.ts:21,
  :95–105, :144–147`, `AudioTranscoderModule.ts:236–250`, tests.
- **How.** `mrtsdemux name=demux media=audio`; `${decoder} ! mrasrc
  name=asrc bypass-below-ppm=0.5` before the trunk; delete
  `alignBranchesToStamps` (and `preserveSourceTimeline` if any declaration
  survived Phase 2's WI-P2-3). The `perfect-timestamp` comment at `:95–105`
  is rewritten: the encoders now see house-rate PCM.
- **Acceptance.** Module tests; protocol case `transform-formula`
  (rewrite of M, part 7.3); gate V1, V5.
- **Estimate.** +25 / −25; 1 day.

#### WI-P3-13 transcoder (subtitle hold per OQ-24)

- **Where.** `plugins/transcoder/engine/transcoderPipeline.ts:30, :181–185,
  :236–243`, `transcoderSubtitles.ts`, `transcoderPipelineTypes.ts:57`,
  `TranscoderModule.ts:229–256, :288–304`,
  `plugins/transcoder/package.json:290–300`, tests
  (`transcoderPipeline.test.ts:538–556`, `TranscoderModule.test.ts:150–165`,
  `transcoderPipeline.golden.test.ts:90`, `transcoderSubtitles.test.ts`).
- **How.**
  - `mrtsdemux name=demux media=video ! capsfilter caps="video/x-h264"`.
  - Delete `alignBranchesToStamps` (`:304`).
  - Per OQ-24 (decided): delete `subtitleDelayMs`, `buildSubtitleHold`,
    `SUBTITLE_HOLD_*`; the burn-in waits instead through Phase 2's
    `mralignwatch`: `… ! mralignwatch name=aw_burnv aligner=burnin
    input=video ! <decoder> …` on the compressed video, and the subtitle
    bridge's cue reader gets `mralignwatch aligner=burnin input=cues
    sparse=true` before its appsink. The pace group holds video by the cue
    input's measured lateness, which is the subtitle path's real delay
    instead of a fixed slider.
- **Acceptance.** Module and golden tests; with subtitles, the string has
  two `mralignwatch aligner=burnin`; gate V4 (`cueLate` ≤ one frame).
- **Estimate.** +90 / −90; 2 days.

#### WI-P3-14 mpegts-muxer

- **Where.** `plugins/mpegts-muxer/engine/mpegtsMuxerPipeline.ts:100–146,
  :184`, `MpegTsMuxerModule.ts:240–256`, tests;
  `plugins/mpegts-muxer/py/mux_routing.py` and
  `native/mux-routing/mux_routing.cpp` (comments only).
- **How.** `${src} ! mrtsdemux name=demux_${branchId}`; the `demuxes`
  result field and `alignBranchesToStamps` go. The hooks are unchanged:
  pad names, caps classes, PSI sync messages and flow-combiner semantics are
  what WI-P3-2 and WI-P3-4 pin. Sparse pads now leave the demux on content
  time, so Phase 2's `mralignwatch sparse=true` gets correct PTS without a
  retime.
- **Acceptance.** Module tests; `mux_routing_test.py` and the native hook
  test pass unchanged against a fixture-driven `mrtsdemux`; protocol case
  `mux-formula` (rewrite of P, a KLV input included); gate V2.
- **Estimate.** +40 / −60; 2 days.

#### WI-P3-15 302M decode ASRC and the audio-output-302m device ASRC (OQ-20, OQ-23)

- **Where.** `plugins/audio-302m-core/engine/audio302mHelpers.ts` (the
  branch strings after Phase 2), `.test.ts`;
  `plugins/audio-output-302m/engine/AudioOutput302mModule.ts:195–211`,
  `audio302mTiming.ts:21`, tests.
- **How.** Helper branch: `avdec_s302m ! mrasrc name=<b>_asrc
  bypass-below-ppm=0.5 out-rate=48000 ! audioconvert[ matrix] ! caps`
  (replaces `audioresample`). audio-output-302m: `audioconvert ! audioresample`
  → `audioconvert ! mrasrc name=outasrc device-sink=sink out-rate=0`;
  `SLAVE_METHOD_CUSTOM = 3`; in the single-source arm the branch `mrasrc`
  is omitted and `outasrc` carries the decode term too (OQ-23). The two
  302M `tsdemux` strings went in Phase 2 (OQ-20, decided yes).
- **Acceptance.** Snapshot tests; no string the helper builds contains
  `audioresample`; protocol case L (P2) still passes; gate V6, V7.
- **Estimate.** +70 / −30; 1.5 days.

#### WI-P3-16 Delete branch alignment and retime (OQ-25)

- **Where.** part 3.3 and part 3.7 paths.
- **How.**
  - Delete `branch_align.{cpp,h}`, `branch_retime.{cpp,h}`; `runner.cpp`
    `#include`, `align::install` (`:323`), `align::clear` (`:398`);
    `runner.h:12` comment; `Makefile:29, :33` entries.
  - Delete `gst-pipeline-runner.py:1325–1832` and the calls at `:2114`,
    `:2244`; `branch_retime.py`; its entry in `packages/engine/package.json`
    `build`. `_pid_from_tsdemux_pad_name` (`:574`) stays for the pad-link
    rules and is renamed `_pid_from_demux_pad_name`.
  - Delete `alignBranchesToStamps` and `AlignBranchesToStampsConfig` from
    `PluginModule.ts`, the pass-through in `GstChildProcess.ts:250`, the
    drop in `GstPluginBase.ts`, and the module declarations of WI-P3-10 to
    -14.
  - Delete `gst_branch_align_test.py`, `gst_tsdemux_slave_test.py`,
    `transform_input_fixture.py` and their `test:py` entries; the vitest
    pins of part 3.7. The muxer spike rig
    `plugins/mpegts-muxer/spike/muxer_rig.py:45, :94` drops its
    `alignBranchesToStamps` key and its `noalign` variant.
  - Rewrite protocol cases E, M, P as part 7.3's `presentation-formula`,
    `transform-formula`, `mux-formula`.
- **Acceptance.** `make native-test`, `pnpm -r test`, both `test:py`
  suites; this grep returns nothing outside `docs/` and `dist/`:
  ```
  grep -rnE "alignBranchesToStamps|branch_retime|branch_align|\
  transformProducer" packages plugins
  ```
- **Estimate.** +450 test / −2,200 production, −2,000 test; 3.5 days.

#### WI-P3-17 Delete K recovery; the last timeline twins leave the runtime

- **Where.** part 3.4 paths; `plugins/mpegts-core/native/mrts/ts_timeline.{h,cpp}`,
  `tests/ts_timeline_test.cpp` (`plugins/mpegts-core/py/ts_timeline.py` and
  `ts_timeline_test.py` stay as reference, OQ-1); `ts_psi.h` forwarders;
  any remaining
  `#include "mrts/ts_timeline.h"`
  (`plugins/mpegts-core/native/mrtsstamp/gstmrtsstamp.cpp:75`,
  `plugins/unixfdbus-core/native/mr-bus-fanout/main.cpp:22` after Phase 2)
  switched to `ts_house.h`.
- **How.**
  - Delete `plugins/mpegts-core/native/mrpeshouse/` entirely (root
    `Makefile` auto-discovery then stops building and installing
    `libgstmrpeshouse.so`).
  - Delete `subtitle_native.py`, `subtitle_native_test.py`,
    `subtitle_stamp_model.py`, `subtitle_stamp_dump.py`,
    `subtitle_peshouse_gst_test.py`, `subtitle_ts.py` (after the
    `klv_span`/`payload_key` move), `subtitle_ts_test.py`,
    `subtitle_ts_engine_test.py` (whatever Phase 2 left of it).
  - `subtitle_pack_test.py:36–50`: the `PesStamper` checks become checks
    on S0's `mrts_cli dump` output of the packed chunk (pid, sid 0xBD, PTS,
    payload crc), run as a subprocess.
  - `plugins/subtitle-core/package.json` `test:py` loses the deleted tests
    (its description has no K-recovery sentence; that prose lives in
    `plugins/README.md:2354–2380` and ADR-0016 :120–135, which WI-P3-19
    edits).
  - `ts_timeline`: `timing_pes` and the helpers (C++). `py/ts_timeline.py`
    and its test stay as reference, with `py/ts_psi.py` (OQ-1); after
    WI-P3-16 no runtime path imports them.
- **Acceptance.** Both `test:py` suites and `make native-test` pass, and,
  with WI-P3-19's README edits, this grep returns nothing outside `docs/`
  and `dist/`:
  ```
  grep -rnE "mrpeshouse|StampModel|PesStamper|StampIndex|chunk_probe|\
  timing_pes|ts_timeline" packages plugins
  ```
- **Estimate.** +60 / −5,850; 1.5 days.

#### WI-P3-18 `tsparse` out of the consumer input (OQ-26)

- **Where.** `packages/engine/src/plugins/tsHelpers.ts:150–193`
  (`buildTsUdpInput` and its comment), its tests, the comments at
  `transcoderPipeline.ts:84, :115`, `pipelines.ts:353–399, :499–501`.
- **How.** `return \`${src} ! ${queue}\``; the doc comment says the demux
  re-frames (`PacketWalker` carries partial packets). `buildTsRechunk`
  (egress re-chunk) is untouched.
- **Acceptance.** Tests; demux parity fixtures at 1,000-byte chunking (not
  a multiple of 188) pass; gate V8 shows the player's CPU drop.
- **Estimate.** +10 / −15; 0.5 day.

#### WI-P3-19 ADR and documents

- **Where.** The timing ADR (S0/P1, next free number after 0028);
  `docs/adr/0005-time-sync-backend.md` (Stage 3c, the transform-producer
  notes at `:957`, `:1125–1132`, `:1348–1390`, decision 5);
  `docs/adr/0016-subtitle-carrier-klv-webvtt.md:120–135`;
  `docs/adr/0019-native-pipeline-runner.md:42`;
  `plugins/README.md:1143, :1157, :2129–2135, :2354–2380`;
  `plugins/audio-302m-core/README.md`; `plugins/mpegts-core/README.md`;
  `docs/adr/README.md` index.
- **How.** Timing ADR sections: the formula demux (modes, properties, the
  caps table, event order, gap rule, allowlist of `tsdemux` differences);
  ASRC at decode (bypass rule, constants) and at outputs (custom slaving,
  composite ratio). ADR-0005 Stage 3c, the `transformProducer` amendments
  and decision 5 marked "superseded by ADR-00NN"; ADR-0016's 2026-10-09
  amendment marked superseded for timing (the KLV carrier stays); ADR-0019
  loses `alignBranchesToStamps` from its feature list. README sections
  rewritten to "the demux writes content time".
- **Acceptance.** `grep -n "alignBranchesToStamps\|mrpeshouse\|StampModel"
  plugins/README.md` returns nothing; the ADR index rows carry the status.
- **Estimate.** +350 / −300; 1.5 days.

#### WI-P3-20 Gate verification and release

- **What.** Part 11 on 10.9.16.103 and 10.9.16.108 with the Phase 3 RAUC
  image.
- **Where.** Phase 2's `tools/align-check/` (`bus-capture.sh`,
  `pcm_align.py`, `pes_diff.sh`) plus `tools/align-check/pes_formula.sh`
  (new: captures a consumer's demux output through a debug `mrtsdemux`
  appsink tap and compares buffer PTS with `mrts_cli dump` of the same bus
  bytes).
- **Acceptance.** All of part 11 pass.
- **Estimate.** +150; 4 days.

### 6. Deletions

All go with Phase 3, in the Phases 1–4 release.

#### 6.1 Branch alignment and retime

| What | Path | Lines | WI |
|---|---|---|---|
| Native align | `packages/engine/native/mr-gst-runner/branch_align.{cpp,h}` | 478 | 16 |
| Native retime | `packages/engine/native/mr-gst-runner/branch_retime.{cpp,h}` | 646 | 16 |
| Native glue | `runner.cpp:13, :323, :398`; `runner.h:12`; `Makefile:29, :33` | ≈ 10 | 16 |
| Python align block | `packages/engine/src/child-process/gst-pipeline-runner.py:1325–1832`, `:2114`, `:2244` | 510 | 16 |
| Python retime | `packages/engine/src/child-process/branch_retime.py`; `packages/engine/package.json` `build` entry | 439 | 16 |
| Description field and pass-through | `PluginModule.ts:544–567, :620–633`; `GstChildProcess.ts:250`; `GstPluginBase.ts:192, :242` | ≈ 45 | 16 |
| Declarations | `AudioDecoderModule.ts:440–450`; `AudioTranscoderModule.ts:247–250`; `MpegTsMuxerModule.ts:246–249`; `TranscoderModule.ts:301–304`; `pipelinePlan.ts:283–290`; `mpegtsMuxerPipeline.ts:184` | ≈ 60 | 10–14 |
| Tests | `gst_branch_align_test.py` (956), `gst_tsdemux_slave_test.py` (285), `transform_input_fixture.py` (352), protocol cases E/M/P (≈ 410, rewritten), `GstChildProcess.test.ts:205–221`, `nativeRunner.test.ts:88`, `GstPluginBase.timeSync.test.ts:119–131`; `test:py` entries | ≈ 2,040 | 16 |

#### 6.2 Subtitle K recovery

| What | Path | Lines | WI |
|---|---|---|---|
| `mrpeshouse` element, walker, model, vectors | `plugins/mpegts-core/native/mrpeshouse/` | 4,323 | 17 |
| K model, dump tool | `plugins/subtitle-core/py/subtitle_stamp_model.py`, `subtitle_stamp_dump.py` | 149 | 17 |
| Native splice | `plugins/subtitle-core/py/subtitle_native.py`, `subtitle_native_test.py` | 249 | 17 |
| Chunk walk and join | `plugins/subtitle-core/py/subtitle_ts.py` (after moving `klv_span`, `payload_key`), `subtitle_ts_test.py`, `subtitle_ts_engine_test.py`, `subtitle_peshouse_gst_test.py` | 617 | 17 |
| Probe | `plugins/subtitle-core/py/subtitle_runtime.py:58–76` | 19 | 7 |
| Producer retime | `plugins/subtitle-core/py/subtitle_pay.py:36–42, :50–119`; `subtitle_bridge.py` `sourceDemux`; `subtitleOverlay.ts` `sourceDemux` | ≈ 90 | 8 |
| Consumer join | `subtitle_overlay.py` `index`/probe; `subtitle_cues.py` `cue_t0` chunk branch | ≈ 25 | 7 |
| Retime tests | `subtitle_bridge_test.py:151–167`; `subtitle_pack_test.py:36–50` (rewritten) | ≈ 35 | 7, 17 |

#### 6.3 Timeline twins and helpers

| What | Path | Lines | WI |
|---|---|---|---|
| `timing_pes` and helpers | `plugins/mpegts-core/native/mrts/ts_timeline.{h,cpp}` (what Phase 2 left) | ≈ 100 | 17 |
| Their tests | `plugins/mpegts-core/native/mrts/tests/ts_timeline_test.cpp` (what Phase 2 left) | ≈ 115 | 17 |
| Python helpers and tests — **kept** as reference (OQ-1); `branch_retime.py`, their last runtime importer, goes in WI-P3-16 | `plugins/mpegts-core/py/ts_timeline.py`, `ts_timeline_test.py` | 0 | 17 |
| Forwarders | `read_pes_pts`, `read_pcr` in `plugins/mpegts-core/native/mrts/ts_psi.h` | ≈ 10 | 17 |

#### 6.4 Elements, settings, strings

| What | Path | WI |
|---|---|---|
| `tsdemux` in consumer strings 3–10 (1–2 went in Phase 2, OQ-20) | part 3.1 | 7–15 |
| `audioresample` after 302M decode and in audio-output-302m | `audio302mHelpers.ts`, `Aes67OutputModule.ts:270`, `AudioOutput302mModule.ts:208` | 9, 15 |
| Skew slaving | `SLAVE_METHOD_SKEW` in `audio302mTiming.ts:21`, `AudioDecoderModule.ts:83` | 10, 15 |
| audio-decoder `slaveMethod` setting | `plugins/audio-decoder/package.json:78`, `AudioDecoderModule.ts:262–283` | 10 |
| transcoder `subtitleDelayMs` and the hold (OQ-24) | `plugins/transcoder/package.json:290–300`; `transcoderSubtitles.ts` `buildSubtitleHold`, `SUBTITLE_HOLD_*`; `TranscoderModule.ts:229–233, :255`; `transcoderPipelineTypes.ts:57`; tests | 13 |
| `tsparse` in `buildTsUdpInput` (OQ-26) | `packages/engine/src/plugins/tsHelpers.ts:192` | 18 |

#### 6.5 Documents

ADR-0005 Stage 3c, its `transformProducer` amendments and decision 5;
ADR-0016's 2026-10-09 timing amendment; `alignBranchesToStamps` in ADR-0019;
`plugins/README.md` branch-alignment and native-retime paragraphs (WI-P3-19).

### 7. Tests and fixtures

#### 7.1 Unit tests (C++, no GStreamer)

| Test | Pins | Where |
|---|---|---|
| `demux_core_test.cpp` | Caps table rows, pad names, formula exactness, wrap with B-frames, chunking independence, gaps, PMT change, PES without PTS, unknown streams, not-house-time | `plugins/mpegts-core/native/mrts/tests/` |
| `asrc_servo_test.cpp` (extended) | Bypass never engages on house rate; engage on ppm and on phase; composite ratio | same |

#### 7.2 Conformance fixtures

All in `plugins/mpegts-core/tests/fixtures/`, each with
`<name>.demux.jsonl`. S0's set is reused: `syn-mpts-two-programs.ts` (PMT
change, program selection), `syn-wrap-33bit.ts` (33-bit wrap, B-frame DTS
at the wrap), `syn-pes-no-pts.ts` (PES without PTS),
`cap-mux-align7-aac-opus.ts` (several PIDs per buffer, PSI between PES,
Opus caps), `cap-mux-unbounded-video.ts` (unbounded PES),
`cap-occ-1080i-h264-aac-ttx.ts` (B-frames, AAC, teletext),
`cap-302m-bssd.ts`, `cap-klv-sparse.ts` (sparse private), `cap-cc-loss.ts`.
New, recorded on the gate with the Phase 2 development image so every
producer writes house PES:

| Fixture | Source | Pins (§6 list item) |
|---|---|---|
| `bus-occ-ingest.gdp` | .103 OCC rig: srt-input after `mrtsrestamp` | B-frames (DTS ≠ PTS); teletext sparse; AAC; formula on a restamped ingest |
| `bus-mux-av-klv.gdp` | .103: mpegts-muxer output (transcoder video + AAC + KLV) | several PIDs per buffer; PSI between PES; KLV sparse; language tags |
| `bus-transcoder-h264.gdp` | .108: transcoder rendition | unbounded video PES (length 0) at 1080p; DTS present |
| `bus-audio-encoder-opus.gdp`, `bus-audio-encoder-aac.gdp` | .108: audio-encoder Opus stereo and 5.1, AAC | Opus caps and access units; ADTS `mpegversion` |
| `bus-mixer-302m.gdp` | .108: audio-mixer egress | 302M; one PES per buffer |
| `bus-ingest-relock-gap.gdp` | .108: srt-input with the source restarted twice | gaps (§5.2): P1's GAP marker buffer, then a PTS jump |
| `bus-pmt-change.gdp` | .103: a transcoder whose rendition codec is switched AVC → HEVC upstream of the recorder | PMT change: generation + 1, pads re-added |
| `bus-hls-player.gdp` | .103: hls-player egress | bursty arrival; ID3 private stream; nominal-rate audio (decode ASRC stays bypassed) |
| `bus-third-party-audio.ts` | dev box, `tools/fixtures/gen-thirdparty.sh` | AC-3, E-AC-3, LATM, MPEG-2 video, DVB subtitles, ID3 coverage (R1) |
| `syn-gap-500ms.ts`, `syn-gap-marker.ts` | `fixture_gen.cpp --gap` with and without the marker | gaps, synthetic and exact |
| `syn-private-novdesc.ts` | `fixture_gen.cpp --private-novdesc` | unknown stream: no pad, one warning |
| `syn-foreign-clock-aac.ts` | `fixture_gen.cpp` from a real AAC encode, PTS spaced at +40 ppm | decode ASRC engages; house-rate copy stays bypassed |

Every fixture is replayed through both runners (part 7.3) after
`mrts_cli rebase --to-ns <now + 200 ms>`.

#### 7.3 Element and protocol tests, both runners

| Test | Kind | Pins |
|---|---|---|
| `gst_mrtsdemux_element_test.py` (extended) | dataflow | WI-P3-2 cases 1–8 |
| `gst_mrtsdemux_parity_test.py` | dataflow | WI-P3-4 against stock `tsdemux` on every recorded fixture |
| `gst_mrasrc_element_test.py` (extended) | dataflow | WI-P3-5 cases |
| `presentation-formula` (rewrite of E) | protocol, both runners | A 302M producer → `mrtsdemux select` → `fakesink sync=true`: running time = PES − 1 h for every buffer; the shedder part of E kept until Phase 4 |
| `transform-formula` (rewrite of M) | protocol, both runners | `bus-occ-ingest.gdp` rebased into a transcoder-shaped consumer (`mrtsdemux ! … ! mpegtsmux`): egress PES PTS = input PES PTS (0 ticks) for every AU, B-frame DTS intact, nothing dropped |
| `mux-formula` (rewrite of P) | protocol, both runners | Two inputs (AV + KLV) into the muxer string with the `mux_routing` hook: output PES PTS per PID = input (0 ticks); PMT planned before pads |
| `mrtsdemux-pmt-change` | protocol, both runners | `bus-pmt-change.gdp`: `pad-removed`/`pad-added` with generation 1; `mux_routing` re-plans; no error |
| `mrtsdemux-messages` | protocol, both runners | `mrtsdemux:<name>` plugin events: stats, unknown stream, not-house-time |
| `subtitle-overlay-formula` | protocol, python runner (the bridge is python-only) | KLV cue at PTS T is drawn on the frame at T ± one frame; no chunk probe installed |
| `mrasrc-device` | protocol, both runners | `audiotestsrc ! mrasrc device-sink=sink ! pulsesink slave-method=custom` on a null sink: no skew events, `mrasrc-stats` mode `device` |
| L (live input branches, P2) | protocol, both runners | Unchanged; must still pass with the branch `mrasrc` |

#### 7.4 Tests deleted or rewritten

Deleted with their code (§6): `gst_branch_align_test.py`,
`gst_tsdemux_slave_test.py`, `transform_input_fixture.py`,
`subtitle_ts_test.py`, `subtitle_ts_engine_test.py`,
`subtitle_native_test.py`, `subtitle_peshouse_gst_test.py`,
`mrpeshouse/tests/*`, the `ts_timeline` remnants, the vitest pins of part 3.7.
Rewritten: protocol E, M, P; the builder and module tests of every consumer
in part 3.1; `subtitle_bridge_test.py`, `subtitle_cues_test.py`,
`subtitle_pack_test.py`.

### 8. Manager and UI

| Item | Change |
|---|---|
| Settings removed | transcoder `subtitleDelayMs` (OQ-24); audio-decoder `slaveMethod`. Stored values ignored, nothing migrated (Q9). `packages/manager/src/plugins/manifestHelpText.test.ts` updated. |
| Settings added or disabled | None. |
| Every consumer's `timing-in-<n>` (P0) | Adds Demux: PES/s, gaps, CC errors, unknown streams. |
| Modules with a decode ASRC (audio-decoder, audio-transcoder, aes67-output, 302M aligners) | `timing` section adds "Clock correction": `none (house rate)` or `+23.4 ppm (source)`. |
| Audio outputs (audio-decoder, audio-output-302m) | `timing` section adds "Device clock: −12.1 ppm". |
| Warnings | `demux-unknown-stream`, `input-not-house-time`, `asrc-out-of-bounds` (part 10). |
| Device Manager | None. |
| Release notes | `subtitleDelayMs` removed: burn-in waits for its subtitles by measured lateness; audio outputs no longer drop or insert samples for clock drift; an audio decoder fed an A/V stream now plays its audio PID instead of failing on the video one; third-party codecs covered by the demux, and any stream type it does not cover is named on the module instead of disappearing. |

### 9. Image and Yocto

- No recipe, service or config change. `libgstmrtshouse.so` now links
  `gstreamer-mpegts-1.0` (gst-plugins-bad) and `gstreamer-pbutils-1.0`
  (gst-plugins-base); both are already in `DEPENDS` (Yocto:
  `meta-layers/meta-custom/recipes-apps/media-router/media-router.bb:33–36`)
  and in the image through `RDEPENDS` (`:40–43`); shlib dependencies are
  added automatically.
- `libgstmrpeshouse.so` disappears from
  `/usr/libexec/media-router/mpegts-core/` because its directory is deleted
  and the root `Makefile` builds what it finds (`media-router.bb:156–157`).
- The comment at `media-router.bb:143–150` listing the GStreamer elements
  is updated (`mrtshouse` with `mrtsdemux`, `mrasrc`, `mralignwatch`).
- The release is a RAUC image: the native set and the TypeScript builders
  ship in one image and a dist-only deploy must not outrun the sidecars
  (the rule learned from the 2026-08-05 unixfd protocol skew on
  10.9.1.42, recorded in the project's deploy notes; S0's ABI check
  guards it).

### 10. Telemetry and alarms

| Signal | Source | Shown as | Level |
|---|---|---|---|
| Unknown stream type | `mrtsdemux-unknown-stream` | `demux-unknown-stream` warning naming PID and type (R1) | warning |
| Producer not on house time | `mrtsdemux-not-house-time` | `input-not-house-time` warning | warning |
| Native TS module not loaded or ABI too old (S0 WI-S0-8) | runner `error` event | The module fails to start with the rule-6 alarm text; a demux has no pass-through stand-in (S0 part 4.5 rule 6; decided 2026-10-12) | error |
| CC loss, gaps, oversize PES, PES without PTS, DTS discarded | `mrtsdemux` stats, 1 s | `timing-in-<n>` counters | info |
| PMT change | `mrtsdemux` stats `generation` | Engine log line and event "input <n>: program changed (generation g)" | info |
| Decode ASRC engaged | `mrasrc-event` `engaged` | Event "source clock +x ppm: resampling" | info |
| ASRC ratio out of bounds | `mrasrc-event` `ratio-out-of-bounds` (P1) | `asrc-out-of-bounds` warning | warning |
| Device ratio | `mrasrc-stats` `device-ppb` | `timing` "Device clock" | info |
| Removed | `branchAlign: …` verdict lines, `epoch #n K moved`, `retime …` logs, `[subtitle_bridge] retime source: …`, `t0src=chunk` | — | — |

### 11. Verification on the test fleet

Run on 10.9.16.103 (Pi 5) and 10.9.16.108 (Pi 4) with the Phase 3
development image (the release image is the Phases 1–4 one, OQ-13), in
both runners where marked (`MR_GST_RUNNER_NATIVE=0` and `=1`).

| # | What | Rig and tool | Pass |
|---|---|---|---|
| V1 | Formula exactness, transform producers | .103 OCC rig: srt-input → transcoder and audio-transcoder; `pes_diff.sh` on input and egress bus captures. Both runners. | 30 min: egress PES PTS = input PES PTS, 0 ticks, every AU; no "K moved"/"epoch" line. |
| V2 | Muxer | .103: transcoder video + audio-transcoder audio + KLV → mpegts-muxer; `pes_diff.sh` per PID | Output PES PTS = input PES PTS, 0 ticks, all PIDs; KLV included. |
| V3 | Presentation legs unchanged | .108: muxer → video-player and audio-decoder; P0 render lateness and `pcm_align.py`-style A/V measurement against the Phase 2 build on the same route | Each leg's render lateness within ±1 ms of the Phase 2 build; A/V within ±1 ms of it. |
| V4 | Subtitles | .103 OCC rig: teletext-subtitles → KLV → transcoder burn-in and video-player overlay (python runner) | Bridge trace `t0src=pts` on every cue; `cueLate` ≤ 40 ms (one frame) on 95 % of cues over 30 min; no `subtitleDelayMs` in the description. |
| V5 | Decode ASRC engages only on foreign clocks | .108: srt-input from a third-party encoder → audio-transcoder; audio-encoder → audio-transcoder | Foreign: engages within 30 s, egress sample count vs PES PTS ≤ 1 ms apart over 1 h. House: bypassed for 1 h. |
| V6 | aes67-output and 302M fan-ins | .108: srt-input 302M from the other gate box (foreign) and audio-input-302m (house) into audio-mixer → aes67-output | Foreign branch engaged, house branch bypassed; mixer output sample-exact vs PES PTS over 1 h; RTP timestamps = (running time + E) × rate within one packet. |
| V7 | Output ASRC replaces skew slaving | .108: audio-decoder and audio-output-302m, 2 h | Zero skew corrections (GST debug `audiobasesink:5` grep for "skew"), render lateness range ≤ 5 ms over 2 h (today's sawtooth absent), device ppm reported. |
| V8 | CPU | .108 (Pi 4): video-player 1080p50, muxer 3 inputs, audio-mixer 4 inputs; `tools/runner-cpu-profile.sh` | Runner CPU ≤ the Phase 2 build on each; video-player lower by `tsparse`'s ≈ 0.11 core if OQ-26 = yes. |
| V9 | PMT change | .103: codec switch on a transcoder rendition feeding a video-player and a muxer | Player rebuilds as today; muxer re-plans; no error, no stall. |
| V10 | Wrap | Soak: one box's uptime chosen so the bus PTS wrap (MONO + 1 h ≡ 0 mod 2^33) falls inside, as P2 V10 | No step, no `mrtsdemux-not-house-time`, no gap at the wrap on V1–V2 routes. |
| V11 | Nothing re-estimated | Both boxes, journal over the soak | Zero matches for `branchAlign`, `K moved`, `retime source`, `mrpeshouse`, `t0src=chunk`, `tsdemux`-named demuxers in pipeline logs. |
| V12 | Soak | Both boxes, 24 h on V1–V7 routes | No error, restart, unknown-stream or not-house-time warning. |
| V13 | Rollback (development check) | Install the Phase 2 development build on .108, then the Phase 3 build again; the release rollback, to the Phase 0 release, is chapter 8 V-P4-11 (OQ-13) | Both start and run V1's route. |

### 12. Risks specific to this phase

| # | Level | Risk | Mitigation |
|---|---|---|---|
| R-P3-1 (R1) | M | **Coverage.** A stream type, descriptor or PES shape the demux does not handle is a loss on that route. | Caps table of part 4.2 from the inventory; third-party fixture; parity against `tsdemux`; the unknown-stream warning instead of silence. |
| R-P3-2 | M | **An undocumented `tsdemux` behaviour a consumer depends on** (pad lifecycle, delayed linking, flow combiner, section timing) differs, and a pipeline stalls without an error. | WI-P3-4 parity on event order and payloads; protocol cases with the real hooks (`mux_routing`, the subtitle bridge, live branches); the inventory list of part 3.2 as a checklist. |
| R-P3-3 | H | **A producer that does not write house PES** is now wrong at once: no estimator absorbs it any more. | Phases 1–2 put every producer on house time; `mrtsdemux-not-house-time`; V11–V12. |
| R-P3-4 (R19, S9) | L | **Wrap**, fleet-wide at the same instant from Phase 5. | `Unwrapper` with DTS tied to PTS; `syn-wrap-33bit.ts` with B-frames; V10. |
| R-P3-5 (R9) | L | **Unbounded video PES** hold one frame and up to 32 MB per open unit. | Same hold as `tsdemux`; `max-pes-bytes` counted; `media` stops reassembly of unused PIDs. |
| R-P3-6 (R5) | M | **ASRC cost** on a Pi 4. | Decode ASRC bypassed on house-rate streams (most paths); one resampler where decode meets the device; bench in WI-P3-5. |
| R-P3-7 (R10) | M | **Bypass misfires**: a house-rate stream engages (needless resampling) or a slow foreign one engages late. | Phase bound of 1 ms guarantees the drift bound; fixtures for both directions; V5, V6. |
| R-P3-8 | M | **Custom slaving with `sync=true`** is new to this codebase; a wrong callback contract could resync the ring. | Element test with a drifting test sink (WI-P3-5); V7 over 2 h; Phase 4 removes `sync=true` (C-6). |
| R-P3-9 (R12) | L | **Burn-in subtitle timing changes** with `subtitleDelayMs` gone. | OQ-24; V4 measures `cueLate`; release notes. |
| R-P3-10 (R3) | M | **Scope**: eight strings, eleven modules, both runners, three deletion sets in one release. | WI order: element and fixtures first, simplest consumer first, muxer last, deletions after; per-class protocol cases. |
| R-P3-11 | L | **Python-only subtitle bridge** must load the native demux. | S0's Python loader; `subtitle-overlay-formula` on the python runner. |
| R-P3-12 | L | **`tsparse` removal** exposes unaligned buffers to the demux. | `PacketWalker` carry; parity at 1,000-byte chunking (WI-P3-18). |
| R-P3-13 (R20) | L | **Mixed fleet.** | Unaffected: the demux reads the bus only, never the wire. |

### 13. Open questions

| # | Question | Why the design doc does not answer it | Blocks | Proposed default |
|---|---|---|---|---|
| OQ-20 | Does Phase 3 start from Phase 2's `mrtsdemux select=` on the 302M fan-ins (the same question as chapter 6's OQ-20)? | §14 puts the demux in Phase 3, Phase 2's plan builds its select mode early; §13.1 Q7 ("replaced with formula demux and W") and §11.1's audio-mixer row lean to yes; the residual is sequencing. | WI-P3-15 scope | **Yes.** If no, WI-P3-15 also replaces `audio302mHelpers.ts:222, :359` (+30 / −20 lines, +1.5 days). |
| OQ-23 | Where decode and device output are adjacent (audio-decoder; audio-output-302m single source), one resampler with the product ratio, or two in series? | P7 allows one at first PCM and one at the device; §13.1 calls one per path the cost bound. | WI-P3-5, -10, -15 | **One**, with the product ratio. |
| OQ-24 | `subtitleDelayMs` (Q9's list) goes in which phase, and what makes burn-in wait for late cues? | Q9 removes it "with the mechanism that used it" but names no phase; the hold is a fixed budget, not K learning. (Shared with chapter 8, whose draft proposed Phase 4; one entry, default Phase 3, and WI-P4-9 then only verifies.) | WI-P3-13, WI-P4-9, part 8 | **Phase 3**; the burn-in waits through a two-member `mralignwatch` pace group (video, cues `sparse=true`). |
| OQ-25 | Does `MpegTsProbe` (codec identification, a separate `gst-launch-1.0` on a bus edge) keep stock `tsdemux`? | §6 says `tsdemux` leaves the bus path; the probe has no timing role and cannot load a plugin by path from `gst-launch`. | WI-P3-16 scope | **Keep** `tsdemux` there; the timing ADR records the exception. |
| OQ-26 | Is `tsparse set-timestamps=false` removed from `buildTsUdpInput` (its only job was re-framing for `tsdemux`)? | Not a timing mechanism; the design does not mention it. | WI-P3-18 | **Remove** (≈ 0.11 core on a 1080p50 player). |
| OQ-27 | An ES type the caps table does not cover (`0x06` with no descriptor, DTS, AC-4…): no pad as `tsdemux` does, or a generic private pad? | R1 asks for "an alarm instead of silent loss" but not for a pad. | WI-P3-1, -2 | **No pad** (parity), one warning per PID per generation. |
| OQ-28 | audio-decoder and audio-transcoder get `media=audio`, so an A/V input plays its first audio PID instead of linking whichever pad came first. Accept the behaviour change? | §11.1 only fixes the player's side (Q18). | WI-P3-10, -12 | **Yes.** |

All seven were decided on 2026-10-12 by the orchestrator (owner
delegated), each at its default (chapter 15.1); the items follow them:
WI-P3-15 (OQ-20, OQ-23); WI-P3-5, -10 (OQ-23); WI-P3-13 (OQ-24); WI-P3-16
(OQ-25); WI-P3-18 (OQ-26); WI-P3-1, -2 (OQ-27); WI-P3-10, -12 (OQ-28).
Three questions
of the draft were closed during assembly because the design answers them
(chapter 15: C-6 the output ASRC ships in Phase 3, C-7 foreign clocks are
detected by measurement, C-8 the subtitle engine test is ported in Phase 2
and deleted here).

### 14. Estimate

| WI | Added | Deleted | Days |
|---|---|---|---|
| P3-1 `DemuxCore` | 1,250 | 0 | 5 |
| P3-2 `mrtsdemux` demux mode | 1,250 | 0 | 7 |
| P3-3 Fixtures, rebase | 250 | 0 | 3 |
| P3-4 Parity harness | 500 | 0 | 3 |
| P3-5 `mrasrc` decode and device | 650 | 0 | 5 |
| P3-6 Runner and engine plumbing | 370 | 0 | 2 |
| P3-7 Subtitle consumers | 80 | 250 | 1.5 |
| P3-8 teletext-subtitles | 30 | 160 | 1 |
| P3-9 aes67-output | 15 | 10 | 0.5 |
| P3-10 audio-decoder | 60 | 45 | 1.5 |
| P3-11 video-player | 30 | 35 | 1 |
| P3-12 audio-transcoder | 25 | 25 | 1 |
| P3-13 transcoder | 90 | 90 | 2 |
| P3-14 mpegts-muxer | 40 | 60 | 2 |
| P3-15 302M and output ASRC | 70 | 30 | 1.5 |
| P3-16 Align and retime deleted | 450 | 4,200 | 3.5 |
| P3-17 K recovery deleted, twins out of the runtime | 60 | 5,600 | 1.5 |
| P3-18 `tsparse` out | 10 | 15 | 0.5 |
| P3-19 ADR and documents | 350 | 300 | 1.5 |
| P3-20 Gate verification | 150 | 0 | 4 |
| Review and rework | — | — | 2 |
| **Total** | **≈ 5,730** | **≈ 10,800** | **≈ 50** |

About 40 % of the added lines are tests. Of the deleted lines, 3,667 are
the `mrpeshouse` test vectors; production code deleted is ≈ 3,500 (§11.4
rows 3–4 count 2,800; the rest is glue, the K-recovery Python and the
`ts_timeline` remnants).

**Critical path** (three engineers, ≈ 28 working days when the capture
session overlaps WI-P3-1 on synthetic fixtures, 31 when it does not):

1. Demux track: WI-P3-3 capture session (needs the Phase 2 development
   build on the gate boxes, 3 d) → WI-P3-1 (5 d) → WI-P3-2 (7 d) → WI-P3-4 (3 d) →
   consumer cut-overs WI-P3-9, -7, -8, -10, -11, -12, -13, -14 in that
   order (≈ 5 d with two engineers) → WI-P3-16, -17 (4 d, can overlap) →
   WI-P3-20 (4 d) ≈ 31 d, or 28 d with the overlap.
2. ASRC track, in parallel from day 1: WI-P3-5 (5 d), needed by WI-P3-9,
   -10, -12, -15.
3. WI-P3-6, -18, -19 fill the gaps.

The serialising steps are the capture session, which needs the Phase 2
build on both gate boxes, and the single image carrying the whole native
set before V1–V13 (a development image; the release image is the Phases
1–4 one, OQ-13).

## 8. Phase 4 — Outputs play as soon as they can; D and the shedder deleted

| Field | Value |
|---|---|
| Chapter | 8, work-item prefix P4 |
| Implements | §14 row 4 |
| Ships in | The Phases 1–4 release, developed after Phase 3 and last in it (§13.1: phases in order; OQ-13: one release); its gate (WI-P4-16, chapter 11) is the release gate for Phases 1–4 |
| Code baseline | submodule `fc17468` (branch docs/house-clock-timing-design); every path below was checked with `ls`/`grep` on 2026-10-12 |
| Paths | relative to the submodule unless marked "Yocto:" (relative to `/home/mrstation/media-router-yocto`) or "GStreamer 1.28.2:" (the local 1.28.2 source trees under `/home/mrstation/mr-hevc/` and `/home/mrstation/gstreamer-src/`, tag 1.28.2) |
| Builds on | S0 (chapter 3: `libgstmrtshouse.so`, fixtures under `plugins/mpegts-core/tests/fixtures/`, `fixture_gen.cpp`); P0 (chapter 4: `mrlateness`, `lat_render`, `LatenessReporter`, ADR-0029, the `MR_TIME_SYNC_CONTRACT` removal); P1 (chapter 5: `mrasrc`, `mrts::AsrcServo`, ingest O and per-PID trim); P2 (chapter 6: `mralignwatch`, `mrtsdemux` select mode, `mixLatencyMs` removed, `latchRepair.ts` removed); P3 (chapter 7, not available when this was written: `mrtsdemux` on every consumer, `alignBranchesToStamps` and retime deleted, ASRC at decode and at outputs) |

"§n" refers to `docs/house-clock-timing-design.md` v0.6. Files that earlier
phases create (`mrtshouse/`, `mrlateness/`, `latenessReporter.ts`,
`docs/adr/0029-house-clock-timing.md`) do not exist at `fc17468`; they are
cited by the path those sections give them.

### 1. Goal

Phase 4 makes P11 true at the edge of the engine (§14 row 4: "Outputs that
play as soon as they can: unsynchronised sinks, ASRC at the measured clock
ratio, video paced to the display without dropping; late-drop settings off
in sinks, decoders and queues; the route-head walk, shedder and rebase
deleted"). After this release:

- Every physical output (video-player, audio-decoder, audio-output-302m)
  decodes and plays content on arrival. No sink waits for `stamp + D`,
  and there is no D anywhere in the engine.
- Audio leaves through one ASRC per path to the device clock. The ASRC
  follows the measured ratio between the device clock and the house clock,
  never its buffer fill.
- Video is paced to the display. Each frame is released on the content's
  own cadence and shown at the display's next refresh. No frame is dropped
  for lateness; frames are dropped or repeated only to match the display's
  rate.
- No sink, decoder, transform or queue between ingest and output discards
  content for being late. A full queue is a resource fault and is alarmed.
- The video player renders video only. Its demux never exposes or
  reassembles an audio PID (Q18).
- Outputs show their lateness at render, measured, in ms. They show no A/V
  offset and offer no output-side trim of any kind.
- The route-head walk, the runtime raise, the rebase and the backlog
  shedder are deleted in both runners and in the engine, with their tests.
- Today's timing settings (`playoutOffsetMs`, `lipSyncMs`,
  `syncOffsetMs`, `subtitleDelayMs`; `mixLatencyMs` already went in Phase
  2) are gone from the engine, the manifests, the manager and the tests.
  Nothing is migrated (Q9, R13).

### 2. Design references

| Reference | What it decides for this phase |
|---|---|
| §14 row 4; §13.1 "Every phase is a cut-over" | Scope; the mechanisms go in this release; no flag, no legacy arm; rollback is the previous release from the Device Manager. |
| P8, P11 | Latency is measured, never enforced; a physical output plays as soon as it can; nothing after ingest is discarded for being late. |
| §8 (decided Q10, 2026-10-12) | Render on arrival, no presentation delay, no scheduling by PTS, no presentation groups; lateness at render (`now − PTS`) measured and shown. |
| §8 "Nothing is dropped for lateness" | `max-lateness`, decoder QoS, audio-sink late-sample skipping, the Wayland sink's redraw-pending drop and leaky queues are switched off or replaced (§11.3, R10). Latency comes back down only at a gap or a restart (S10). |
| §8 "Leaving the house clock" | Audio: ASRC to the device clock after a small prefill; the ratio follows the measured device/house clock ratio, not the buffer fill. Video: each frame waits for the display's next refresh; repeats or drops only to match the display's rate. |
| §8, §13.1 "No output-side A/V trim" | The decode difference between a video player and an audio output fed by one muxer is accepted; no per-leg or per-output trim; outputs show lateness, not an A/V offset. |
| §8, §13.1 Q18 | The video player renders video only and drops any audio PID at its demux; lipsync is made upstream by a muxer (R22). |
| §9.4, §9.5 | Physical outputs set no delay. Every output shows output lateness, added latency, decode and device latency; alarms warn, never drop. |
| §11.1 rows video-player, audio-decoder, audio-output-302m, aes67-output | Presentation: play as soon as they can, formula demux for lateness, ASRC at the measured ratio, video paced to the display, video player video-only. aes67-output is an egress. |
| §11.3 item 7, §11.5 items 10, 11 | Late data discarded today (shedder and rebase, leaky queues, sink and decoder defaults, aggregator timeouts); what replaces it. |
| §11.4 rows "Lateness handling", "Route-head D, latch-repair resolution", "Render keep-up" | Shedder, raise and rebase removed (≈ 2,600 lines); route-head D removed (≈ 300 lines); render keep-up kept as a diagnostic. |
| §13.1 "Today's timing settings fall away" (Q9); R13 | `playoutOffsetMs`, `lipSyncMs`, `syncOffsetMs`, `mixLatencyMs`, `subtitleDelayMs` removed with their mechanisms; nothing migrated. |
| §13.1 "Talent loops are operator-set" (Q11) | The monitor output's displayed lateness is what an operator reads to set O on a microphone ingest; Phase 4 changes that number (no D). |
| §13.1 "No catch-up" (Q17); §15 | No slew, skip or pause shortening. The output ASRC follows only the clock ratio. |
| §13.1 "Audio is resampled once" (R5) | Outputs keep exactly one resampler to the device clock. |
| §13.1 "One shared native TS module" | New native elements are loaded by both runners; no Python twin. |
| R5, R9, R10, R12, R13, R22 | ASRC cost; queue memory; hidden late-drop behaviour; behaviour change at cut-over; settings removed; A/V offset between outputs. |

### 3. Current state

#### 3.1 Presentation legs today

Each leg presents at `stamp + D` with a `sync=true` sink, except where
noted. After Phase 0 the contract branch is unconditional (WI-P0-5); the
line numbers below are at `fc17468`.

| Module | Sink and timing | Where |
|---|---|---|
| video-player | `waylandsink name=sink sync=true max-lateness=1000000000 ts-offset=<D + lipSyncMs> fullscreen=true qos=false` under Weston; `kmssink … connector-id=N` without a compositor; `autovideosink` on dev boxes. `sync=false qos=true` when the `sync` setting is off. | `plugins/video-player/engine/helpers/pipelines.ts:115–170` (`buildSink`), `:144` (`max-lateness`), `:148` (`ts-offset`) |
| video-player | Inbound chain: `buildTsUdpInput` (tsparse, jitter queue of `bufferMs`) when paced, else `buildBusSrc ! buildBackpressureQueue(bufferMs)`; `tsdemux name=vpdemux latency=0 ! <caps> ! queue leaky=2 max-size-time=max(bufferMs, 1 s)` | `pipelines.ts:390–403`, `:426–427`, `:521–524` |
| video-player | `videoTsOffsetNs` = `effectivePlayoutOffsetNs(services, { trimMs: lipSyncMs })`; shedder armed on `vpdec`'s sink pad, keyframe-aligned; `alignBranchesToStamps` (Phase 3 deletes) | `pipelinePlan.ts:41–63` (`planSink`), `:77–84`, `:216–226`, `:264`, `:290` |
| video-player | Live `lipSyncMs` push, `onRoutePlayoutOffsetChanged`, `pushSinkTsOffset` | `engine/VideoPlayerModule.ts:112`, `:1091–1098`, `:1117–1127`, `:1151`, `:1232–1236` (1,261 lines; test 2,973) |
| audio-decoder | `pulsesink name=sink device=<null-sink> sync=true provide-clock=false slave-method=1 processing-deadline=100000000 buffer-time=100000 ts-offset=<D + syncOffsetMs − 100 ms> max-lateness=-1`; post-demux `queue leaky=0 max-size-time=<bufferMs, 300>`; `tsdemux name=addemux`; shedder on the sink's own pad | `plugins/audio-decoder/engine/AudioDecoderModule.ts:37–38` (`CONTRACT_SINK_BUFFER_US`, `SINK_DECLARED_LATENCY_MS`), `:64–75` (`audioTsOffsetNs`), `:83` (`SLAVE_METHOD_SKEW`), `:109`, `:173–204`, `:210–452` (454 lines; test 443) |
| audio-output-302m | `pulsesink name=sink device=<dev> sync=true provide-clock=false slave-method=1 max-lateness=-1 buffer-time=100000 ts-offset=<D + lipSyncMs − mixer latency − 100 ms>`; `audioconvert ! audioresample` before volume; shedder on the sink pad | `plugins/audio-output-302m/engine/AudioOutput302mModule.ts:53`, `:111–141`, `:143–255` (255 lines; test 338); `audio302mTiming.ts` (89; test 64): `SLAVE_METHOD_SKEW`, `SINK_BUFFER_US`, `SINK_DECLARED_LATENCY_MS`, `audio302mTsOffsetNs` |
| aes67-output | Egress, not presentation: `udpsink … sync=true max-lateness=-1 ts-offset=<senderLatencyMs>`; the margin is explicitly not D | `plugins/aes67-output/engine/Aes67OutputModule.ts:236–249`, `:262–276` (352 lines) |

The video player never rendered audio: on explicit decoder rungs the caps
filter on the `tsdemux` pad steers only the video ES into the chain
(`pipelines.ts:484–496`); on the `decodebin3` bootstrap rung there is no
filter, so the first pad `tsdemux` adds is linked, whatever its media.

Decoder rungs (`plugins/video-player/engine/helpers/decoderSelection.ts:28–
110`): `v4l2h264dec` (Pi 4 hardware H.264), `avdec_h264` (Pi 5, which has
no H.264 hardware, `decoderSelection.ts:225`; threaded `thread-type=frame
max-threads=3`, ≈ 60 ms), `v4l2slh265dec` (stateless HEVC on both),
`avdec_h265`, and the `decodebin3` bootstrap. Every explicit rung is named
`vpdec` (`:55`).

#### 3.2 Route-head D

| Piece | Where | Lines |
|---|---|---|
| D's definition, parse, engine default (60 ms), cap (10 s), `effectivePlayoutOffsetMs/Ns`, `PLAYOUT_OFFSET_KEY` | `packages/engine/src/plugins/playoutOffset.ts` | 151 (test 284) |
| Head walk: `getRoutePlayoutHead`, `getRoutePlayoutOffsetMs`, the raise surface (`setPlayoutReanchor`, `getRoutePlayoutRaiseMs`, `requestPlayoutRaise`, `clearPlayoutRaise`, `notePlayoutRebase`), `notifyPlayoutOffsetChanged` fan-out, `declaredPlayoutOffsetMs`, `playoutRaises` field | `packages/engine/src/routing/MediaRouter.ts:16–19, 23–25, 72–77, 527–617, 650–688` (758 lines) | ≈ 140 (tests `MediaRouter.playoutOffset.test.ts` 279, `MediaRouter.playoutReanchor.test.ts` 335) |
| Route-head key special case and fan-out; `notifyRoutePlayoutOffsetChanged/Raised/Rebased` | `packages/engine/src/modules/ModuleInstance.ts:12–13, 245–251, 270–308` | ≈ 50 |
| Engine default D and the re-anchor switch (`MR_PLAYOUT_OFFSET_MS`, `MR_PLAYOUT_REANCHOR`) | `packages/engine/src/Engine.ts:31, 58–75, 104–107, 152–176, 386–387`; `modules/ModuleManager.ts:35–38, 48–49, 59–60, 123–126` | ≈ 50 |
| Services and hooks: `playoutOffsetMs`, `playoutReanchor`, `onRoutePlayoutOffsetChanged`, `onRoutePlayoutRaised`, `onRoutePlayoutRebased` | `packages/engine/src/plugins/PluginModule.ts:9, 68–78, 132–147` | ≈ 35 |
| Exports | `packages/engine/src/index.ts:186–209` | ≈ 25 |
| Declarations of `playoutOffsetMs` | `plugins/{srt-input,rist-input,mpegts-ip-input,aes67-input,ts-splitter}/package.json` (e.g. `srt-input/package.json:80–88`); `liveUpdatableParams` in `SrtInputModule.ts:22`, `RistInputModule.ts:60`, `MpegTsIpInputModule.ts:36`, `Aes67InputModule.ts:53`, `TsSplitterModule.ts:76` | ≈ 60 |

`latchRepair.ts` (50 lines) and `getUpstreamBusProducers`
(`MediaRouter.ts:620–648`) are grouped with D in §11.4 but are deleted by
Phase 2 (WI-P2-3). Phase 4 only checks that they are gone (WI-P4-11).

#### 3.3 Runtime raise and rebase (ADR-0005 amendment 2026-10-08)

| Piece | Where | Lines |
|---|---|---|
| Event, constants, `RouteReanchor`, request/report types | `packages/engine/src/plugins/playoutReanchor.ts` | 188 (test 279) |
| Per-module display state (status section `playout`, badge `reanchor`, warnings) | `playoutReanchorState.ts`, `playoutReanchorText.ts` | 174 + 162 |
| Raise bookkeeping per route head | `packages/engine/src/routing/PlayoutRaises.ts` | 153 |
| Base-class wiring: `PLAYOUT_REANCHOR_EVENT` dispatch, `PlayoutReanchorState`, `onRoutePlayoutRaised/Rebased`, `ownReanchorWarning`, `playout.reassert()` on PLAYING, `OwnedWarning` members `reanchor`/`rebase` | `packages/engine/src/plugins/GstPluginBase.ts:22–26, 32, 304, 741–745, 790–833` | ≈ 70 (test `GstPluginBase.playoutReanchor.test.ts` 336) |

#### 3.4 The backlog shedder

| Piece | Where | Lines |
|---|---|---|
| Config factory and constants (tolerance 250 ms, hold 5 s, cooldown 60 s, sanity 10 s), `BACKLOG_SHED_EVENT` | `packages/engine/src/plugins/backlogShed.ts` | 168 (tests `backlogShed.test.ts` 147, `GstPluginBase.backlogShed.test.ts` 103) |
| `BacklogShedConfig`, `PipelineDescription.backlogShed` | `PluginModule.ts:505–529, 653–680` | ≈ 55 |
| Journal lines | `GstPluginBase.ts:14, 732–788` | ≈ 55 |
| Pass-through to runners | `child-process/PythonProcess.ts:9, 61`; `GstChildProcess.ts:248` | 3 |
| Python policy and stall watch | `packages/engine/src/child-process/backlog_shed.py` | 421 (tests `backlog_shed_test.py` 497, `gst_backlog_shed_test.py` 774) |
| Python runner glue | `gst-pipeline-runner.py:2188–2196` (arm), `:2262` (stop), `:3785–3793` (render-watch reading), `:4067–4619` (`_start_backlog_shedder`, `_backlog_shed_window`, `_stop_backlog_shedder`) | ≈ 575 of 4,741 |
| Native runner | `packages/engine/native/mr-gst-runner/backlog_shed.cpp` 725, `backlog_shed.h` 35; `runner.cpp:12, 359, 418`; `gates.cpp:14, 302`; `runner.h:12`; `Makefile:29, 33` | ≈ 770 |
| Build and test lists | `packages/engine/package.json:23` (copies `backlog_shed.py`), `:26` (`backlog_shed_test.py`, `gst_backlog_shed_test.py`, `gst_latency_ratchet_test.py`) | — |
| Ratchet fixture | `gst_latency_ratchet_test.py` (arms A–F) | 388 |
| Protocol cases | `native_runner_protocol_test.py:432–502` (`test_presentation_leg`, shed part), `:503–676` (`test_shed_refusals`, `test_reanchor_parity`, `test_reanchor_gap_and_undo_parity`) | ≈ 220 |
| Contract pins | `packages/engine/src/plugins/busRunnerContract.test.ts` (13 references), `packages/engine/src/child-process/nativeRunner.test.ts` (2), `GstChildProcess.test.ts` (6) | — |
| Render-lag attribution of the ratchet | `plugins/video-player/engine/helpers/renderLag.ts:49–62` (`retainedMs`, `budgetMs`, `latenessMs`, `shedding`, `shedCount`), `:74–80`, `:131–160` (323 lines; test 435) | ≈ 60 |

#### 3.5 Today's timing settings

| Key | Module(s) | Declared | Mechanism | Fate |
|---|---|---|---|---|
| `playoutOffsetMs` | srt-input, rist-input, mpegts-ip-input, aes67-input, ts-splitter (route heads) | `package.json` of each, no default | Route-head D (part 3.2) | Removed here |
| `lipSyncMs` | video-player (±2 s, live) | `plugins/video-player/package.json:74–85` | Per-sink trim on D | Removed here |
| `lipSyncMs` | audio-output-302m (live) | `plugins/audio-output-302m/package.json:77` | Per-sink trim on D | Removed here |
| `syncOffsetMs` | audio-decoder (live) | `plugins/audio-decoder/package.json:122` | Per-sink trim on D | Removed here |
| `subtitleDelayMs` | transcoder (0–1800 ms) | `plugins/transcoder/package.json:290–300` | Video hold `subhold` (`plugins/transcoder/engine/transcoderSubtitles.ts:11–25`, `TranscoderModule.ts:228–233, 255`) | Removed here (OQ-24) |
| `mixLatencyMs` | audio-mixer, n1-mixer-302m, audio-processing, audio-output-302m | each `package.json` | Fixed mixer budget | Removed in Phase 2 (WI-P2-9, -10, -11); checked here |

Settings bound to the same mechanisms that §13.1 does not name (OQ-29):
video-player `sync` and `bufferMs`; audio-decoder `slaveMethod`,
`lowLatencySync`, `bufferMs` and `sinkBufferMs` (`clockSync` goes in Phase
0, OQ-4). Under the contract `sinkBufferMs` is already ignored
(`AudioDecoderModule.ts:365–367` pins the ring at `CONTRACT_SINK_BUFFER_US`).

The engine validates stored configs with Ajv against each manifest
(`packages/engine/src/modules/ModuleManager.ts:85–110`). No manifest sets
`additionalProperties: false`, so a stored key that leaves the schema
passes validation and stays in the stored config, unread.

#### 3.6 Late-drop behaviour today (R10 checklist, outputs and hops)

| Item | Where | Today |
|---|---|---|
| Video sink `max-lateness=1 s` | `pipelines.ts:144` | Drops frames ≥ 1 s late |
| Video sink QoS | `pipelines.ts:130` | Off when paced; on when `sync=false` |
| Decoder QoS | GstVideoDecoder default `qos=true` on `v4l2h264dec`, `v4l2slh265dec`, `avdec_*` | Inert only because the paced sink sends no QoS |
| `videoconvert`/`videoscale` QoS | GstBaseTransform default | Same |
| waylandsink staged-slot replace | GStreamer 1.28.2 with the layer's 0007 applied: `gst-libs/gst/wayland/gstwlwindow.c:936–939` ("dropped (replaced)") | A frame arriving while one is pending replaces the staged one; 0007 also commits immediately, so the compositor latches only the newest commit per repaint |
| Audio sink late-sample skipping | `sync=true` path of GstAudioBaseSink (alignment, drift tolerance) | Disarmed by `max-lateness=-1`, still present |
| Backlog shedder | part 3.4 | Drops the oldest queued data down to D (video: to the next keyframe) |
| Video ES queue | `pipelines.ts:426–427` | `leaky=2`, 1 s |
| Bus ingress queue, every consumer | `packages/engine/src/plugins/busHelpers.ts:180–198` | `leaky=2`, 5 s / 40 MB; documented as a capacity backstop against the gate01 deadlock (`:157–172`) |
| Producer fan-out branch, every edge | `packages/engine/native/mr-gst-runner/bus_edges.cpp:425`; `gst-pipeline-runner.py:2598–2605` | `leaky=2`, 5 s, byte cap |
| Transcoder decoder-pool queue | `packages/engine/src/plugins/encoderLeaf.ts:36` | `leaky=2 max-size-buffers=4` |
| Keyframe gate | `pipelinePlan.ts:282`; runners | Drops delta units until a keyframe after start or loss — a decode-safety rule, not lateness; kept |
| Ingest-side queues | `SrtInputModule.ts:120`, `RistInputModule.ts:129`, `MpegTsIpInputModule.ts:209`; capture queues in `AudioEncoderModule.ts:172`, `videoEncoderPipeline.ts:71, 103` | Inside the ingest, before the bus tee (which never blocks); Phase 1 territory |
| Diagnostic taps | `pipelines.ts:263` (resume tap), `:519` (probe tap), `teletextPipeline.ts:77` | Carry no content to an output; exempt |

Verified behaviours of the elements Phase 4 relies on (GStreamer 1.28.2):

- `gst-plugins-base-1.28.2/gst-libs/gst/audio/gstaudiobasesink.c:1990–
  2005`: with `sync=false` the render path goes straight to
  `gst_audio_base_sink_get_offset` and never runs alignment or drift
  checks. `:1199–1228`: after an underrun the next sample goes to the next
  playable segment; nothing is dropped.
- `gstaudiobasesink.c:294`: every audio base sink creates its
  `provided_clock`, whatever `provide-clock` says. pulsesink replaces it
  with a clock read from `pa_stream_get_time`
  (`gstreamer-src/subprojects/gst-plugins-good/ext/pulse/pulsesink.c:1997–
  2021, 2371–2376`).
- `gst-plugins-bad-1.28.2/sys/kms/gstkmssink.c:1823–1884, 2234–2235`:
  kmssink waits for the vblank or page-flip event in `show_frame` before it
  returns, so it is paced to the display and never drops in `show_frame`
  (unless `skip-vsync`).
- waylandsink 1.28.2 binds no `wp_presentation`
  (`gst-libs/gst/wayland/*.c`: no match), and its protocol list
  (`gst-libs/gst/wayland/meson.build:40–48`) does not include
  `presentation-time`, which `wayland-protocols` ships under `stable/`.

#### 3.7 Preconditions from Phases 0–3

| From | What Phase 4 needs | Checked by |
|---|---|---|
| P0 | `mrlateness` with `lat_render` before every output sink; `LatenessReporter` with the `timing` section (no alarm; OQ-8); the contract branch unconditional | `grep -rn "lat_render" plugins/*/engine` |
| P1 | `mrasrc` (`GstAudioResampler`, `mrts::AsrcServo`); ingest O and trims (the replacement for every removed setting) | WI-P1-8 acceptance |
| P2 | `mralignwatch`; `mrtsdemux` select mode; `mixLatencyMs` and `latchRepair.ts` gone | `grep -rn "mixLatencyMs\|effectiveLatchRepair" plugins packages` empty |
| P3 | `mrtsdemux` in every consumer (video-player, audio-decoder, transcoder subtitle input); `alignBranchesToStamps` gone; ASRC at decode and at outputs on custom slaving (C-6) | `grep -rn "tsdemux\|alignBranchesToStamps" plugins/*/engine packages/engine/src` returns only `packages/engine/src/routing/MpegTsProbe.ts` |

### 4. Target state

#### 4.1 Output chains

Bus ingress, `lat_busin` and the formula demux are as Phases 0–3 left
them. `<S>` is `tsQueueByteCap(5000)` (`packages/engine/src/plugins/
queueBounds.ts:49`, 40 MB).

```
video-player (live)
  unixfdsrc ! watchdog ! mrlateness lat_busin ! queue leaky=2 (5 s, alarmed resource-fault backstop; OQ-30)
  ! tee name=vp_ts
  ! mrtsdemux name=vpdemux select="<every video caps of CODEC_CAPS>"
  ! <caps> ! queue name=vp_esq leaky=0 max-size-time=5000000000 max-size-buffers=0 max-size-bytes=<S>
  ! <decoder rung> ! videoconvert[ ! videoscale][ ! <subtitle overlay>]
  ! mrvideopace name=vp_pace[ refresh-mhz=<mode>]
  ! mrlateness name=lat_render reference=running-time
  ! waylandsink name=sink sync=false qos=false present-every-frame=true fullscreen=true
    | kmssink name=sink connector-id=<n> sync=false qos=false
    | autovideosink sync=false

audio-decoder
  <busSrc> ! mrtsdemux name=addemux select="<audio caps>"
  ! queue name=ad_esq leaky=0 max-size-time=5000000000 max-size-buffers=0 max-size-bytes=<S>
  ! <parser ! decoder> ! audioconvert
  ! mrasrc name=asrc device-clock=sink
  ! volume name=vol ! level …
  ! queue name=prefill leaky=0 min-threshold-time=40000000 max-size-time=1000000000 max-size-buffers=0 max-size-bytes=0
  ! mrlateness name=lat_render reference=running-time
  ! pulsesink name=sink device=<null-sink> sync=false provide-clock=false
      processing-deadline=100000000 buffer-time=100000 <pinned stream props>

audio-output-302m
  <302M fan-in fragment (Phase 2)> <continuation>. ! audioconvert
  ! mrasrc name=asrc device-clock=sink
  ! volume ! level …[ ! <placement>]
  ! queue name=prefill … ! mrlateness name=lat_render reference=running-time
  ! pulsesink name=sink device=<dev> sync=false provide-clock=false buffer-time=100000 <props>
```

Nothing in these strings is `sync=true`, `ts-offset`, `max-lateness` other
than −1, `slave-method`, `qos=true`, `tsparse`, or a `leaky` queue other
than the diagnostic taps and the bus ingress backstop, which stays
`leaky=2` as an alarmed resource-fault backstop (OQ-30, decided
2026-10-12: an overflow there is a resource fault, §8's and R9's framing,
not a lateness policy; the non-leaky variant reopens the gate01 deadlock
that `busHelpers.ts:157–172` records). The runners'
no-late-drop hook (WI-P4-5) enforces the same on elements a bin plugs.

aes67-output is an egress and keeps its paced `udpsink sync=true
max-lateness=-1 ts-offset=<senderLatencyMs>` (§11.1 lists it as an
egress, so §8 does not apply; C-9): its margin is the
packet pacing RTP receivers need, never D, and it drops nothing.

#### 4.2 Video paced to the display, Pi 4 and Pi 5

"Paced to the display" is two mechanisms in series.

1. **`mrvideopace` releases each frame on the content's cadence.** For
   frame k arriving at house time `a_k` with PTS `p_k`:

   ```
   Δ_k = p_k − p_(k−1)                  if 0 < Δ_k ≤ gap-threshold and no DISCONT/GAP
       = nominal frame duration         otherwise (a content gap or discontinuity)
   r_k = max(a_k, r_(k−1) + Δ_k)        release time; the element waits on the house clock
   ```

   - A frame is never released before it arrives, and never faster than
     the content's own rate. After a stall the backlog plays at content
     rate, so video stays in step with audio that suffered the same stall
     (§8), and lateness stays raised (S10).
   - At a content gap the gap's duration is not reproduced: the backlog
     drains into it, and output lateness falls by up to the gap's length
     (§8, "comes back down only at a gap"; OQ-32).
   - **Rate match, not lateness.** When the content frame rate exceeds
     the display refresh (60p on a 50 Hz output, or 60.000 on a 59.94 Hz
     mode), frames are decimated deterministically by the ratio
     (Bresenham accumulator on `refresh / content rate`), counted as
     `rate-drops`. When the content is slower than the display, the
     display repeats the last frame by itself. The ratio uses the measured
     refresh when the sink reports it, else the mode's nominal refresh.
2. **The sink shows each released frame at the next refresh and never
   supersedes one.**
   - **Weston (the fleet's normal case):** `waylandsink sync=false
     present-every-frame=true` (Yocto patch 0008, WI-P4-2). When a frame
     arrives while the previous commit has not yet been shown, the
     streaming thread waits for that commit's frame callback instead of
     replacing the staged buffer. With 0007 kept, a frame is committed as
     soon as the previous one is shown, so a commit that slips past a
     repaint deadline costs one refresh of latency (counted), never a
     frame. 0008 also binds `wp_presentation` and exposes the presented
     time, the measured refresh and the commit-to-present time as
     `display-stats`. A 1 s wait timeout (an output switched off stops
     frame callbacks) commits anyway and counts `present-timeouts`; that
     is a display fault, not a lateness policy.
   - **No compositor:** `kmssink sync=false`. Its `show_frame` already
     blocks on the vblank (part 3.6), so it is paced and never drops.
     `mrvideopace` takes the refresh from `refresh-mhz`, which WI-P4-6
     resolves from the active CRTC mode (nothing in the player resolves a
     refresh rate today).
   - **Dev boxes:** `autovideosink sync=false`, unpaced; not a target.

Nothing in the chain has `max-lateness`, and QoS is off at every element,
so nothing upstream is asked to skip.

| Box | Codec | Decoder rung | Sink | Notes |
|---|---|---|---|---|
| Pi 4 (10.9.16.108) | H.264 | `v4l2h264dec` (hardware, stateful) | `waylandsink` + 0007 + 0008 | dmabuf to the compositor |
| Pi 4 | HEVC | `v4l2slh265dec` (stateless, SAND NC12 per Yocto patch 0006) | same | DMA_DRM only (`pipelines.ts:436–442`) |
| Pi 5 (10.9.16.103) | H.264 | `avdec_h264 thread-type=frame max-threads=3` (no H.264 hardware) | same | ≈ 60 ms decode; real-time capacity at 1080p50 must be measured (V-P4-3, R-P4-5) |
| Pi 5 | HEVC | `v4l2slh265dec` | same | |
| Either, no Weston | any | as above | `kmssink sync=false` | Refresh from the mode |

Weston's frame-callback timing and its `wp_presentation` support are
training knowledge here; WI-P4-1 and WI-P4-2 pin both on the gate before
`mrvideopace` depends on them.

#### 4.3 Audio to the device clock

One `mrasrc` per output path, in device mode (WI-P4-4):

- **Evidence.** Every 100 ms the element reads the downstream sink's
  `provided_clock` (for pulsesink, `pa_stream_get_time`: the position of
  the sample being played) against `CLOCK_MONOTONIC`. A second
  `mrts::ClockLock` (min-filter on the offset, slow rate loop, τ ≈ 60 s)
  gives the device's rate ε_dev against the house clock and its phase.
- **Ratio.** `(1 + ε_in) / (1 + ε_dev)`, where ε_in is Phase 1's input
  lock (frames against PTS; ≈ 0 on house-rate 302M, the source's clock on
  a decoded foreign-clocked stream). One resampler handles both, so the
  path still resamples once (§13.1).
- **Not the fill.** The servo locks the device clock's phase against house
  time. It never reads the ring, the prefill or any queue level. A stall
  that leaves a backlog changes nothing in the ratio; the backlog stays
  until a gap (S10, Q17). Bounded phase error gives bounded fill drift.
- **Prefill.** A `queue min-threshold-time=40 ms` before the sink holds the
  first 40 ms and re-fills after an underrun (OQ-31). With the 100 ms
  ring (`buffer-time=100000`, the field xrun floor,
  `audio302mTiming.ts:22–28`), audio is heard ≈ 140 ms plus the PipeWire
  quantum after it reaches the prefill.
- **Underrun.** `sync=false` writes the next sample at the next playable
  position (part 3.6): the device plays silence for the missing time and the
  output is later by that much. Nothing is dropped.
- **Render lateness.** The element knows which input PTS fed each output
  sample and where the device is, so it reports `now − PTS(sample being
  heard)` directly (`render-lateness-ns`).

#### 4.4 Queue sizing

D sized nothing directly, but every presentation queue was dimensioned
against it: the ES floor against IDR bursts that the shedder trimmed back
to D, the audio ring cancelled out of `ts-offset`, the mixer latency
clamped against D. After Phase 4 a queue has one of three jobs, and its
size follows from the job:

| Job | Queue | Size | When full |
|---|---|---|---|
| **Capacity:** hold a backlog from a stall or a pace step until a gap (S10, R9) | `vp_esq`, `ad_esq` (compressed, after the demux); `mralignwatch` FIFOs (Phase 2) | `max-size-time` 5 s, `max-size-bytes` `tsQueueByteCap(5000)` (ADR-0015), `leaky=0` | Blocks upstream; the bus ingress backstop then fills; `queue_overrun` → `queue-full` alarm |
| **Capacity backstop:** keep a stuck consumer from wedging its producer (gate01) | Bus ingress (`busHelpers.ts:180–198`), producer fan-out branch (`packages/engine/native/mr-gst-runner/bus_edges.cpp:425`, `gst-pipeline-runner.py:2603`) | 5 s, byte cap, `leaky=2` (OQ-30, decided 2026-10-12: kept leaky) | Leaks from the head; the overrun is counted and alarmed as a resource fault (`queue-full`, WI-P4-5), not treated as a lateness policy; the non-leaky variant would reopen the gate01 deadlock (`busHelpers.ts:157–172`) |
| **Jitter prefill** | `prefill` (audio outputs) | `min-threshold-time` 40 ms, `max-size-time` 1 s | Never fills in practice; the backlog sits upstream in `ad_esq` or the FIFOs |
| **Device ring** | pulsesink `buffer-time` | 100 ms | Back-pressure into the prefill |

Removed: the video player's `bufferMs` jitter queue and `tsparse` variant
(`pipelines.ts:390–403`), the leaky 1 s ES queue (`:426–427`), the
audio-decoder's `bufferMs` queue sizing and `sinkBufferMs`, and every
ring-latency cancellation (`SINK_DECLARED_LATENCY_MS`). A backlog lives in
compressed form after the demux (≈ 12.5 MB for 5 s at 20 Mbit/s), never
as decoded frames: `mrvideopace` holds at most one frame and back-pressures
through the decoder's own pool.

The worst case before content is lost on an output is ≈ 10 s of stall
(5 s ES capacity plus 5 s bus ingress), alarmed from the first overrun.

#### 4.5 Lateness at outputs

| Output | Render lateness (`Render` row) | Source |
|---|---|---|
| video-player, Weston | presented time − PTS | `waylandsink display-stats` via `mrvideopace` |
| video-player, kmssink | release time + one refresh − PTS | `mrvideopace` |
| audio-decoder, audio-output-302m | now − PTS of the sample being played | `mrasrc` |
| aes67-output | `lat_egress` (Phase 0) | `mrlateness` |

The Phase 0 rows "Presentation delay" and `renderMs = max(λ, D) + device`
go: there is no D. Outputs show no A/V offset; two outputs fed by one
muxer can be compared by their render lateness, which is what an operator
reads for a talent loop (Q11).

#### 4.6 What the engine no longer has

No D, no route head, no raise, no rebase, no shedder, no `ts-offset`
anywhere on a presentation sink, no `onRoutePlayout*` hooks, no
`playoutOffsetMs`/`playoutReanchor` services, no `MR_PLAYOUT_OFFSET_MS` or
`MR_PLAYOUT_REANCHOR`, no `backlogShed` description field, no
`backlog_shed` or `playout_reanchor` events, no `playout` status section
and no `reanchor` badge.

### 5. Work items

Ordered by dependency. "Days" are engineer-days.

#### WI-P4-1 Pin the sink, decoder and queue behaviours

- **What.** Prove the GStreamer facts Phase 4 is built on, before
  building on them (R10).
- **Where.** New `packages/engine/src/child-process/gst_no_late_drop_test.py`
  (registered in `packages/engine/package.json:26`); gate-only cases in the
  same file behind `MR_GATE=1`.
- **How.** Cases:
  1. A `sync=false` basesink (`fakesink`) fed buffers stamped 5 s late
     renders all of them, and an upstream pad probe sees zero QoS events.
  2. `avdec_h264 qos=false` given a synthetic QoS event (earliest time far
     ahead) outputs every frame it is given.
  3. `videoconvert qos=false`: same.
  4. Gate: `pulsesink sync=false` to the audio-decoder's null-sink, with a
     300 ms hole between pushes: the sink clock keeps running, the samples
     after the hole all play (count from the sink clock advance), no
     "dropped" debug line (`GST_DEBUG=audiobasesink:6`).
  5. Gate, Weston: `waylandsink sync=false` with 0007 only, fed 10 frames
     inside one refresh: `dropped (replaced)` ≥ 8 (pins the fault). With
     0008 `present-every-frame=true`: 0 replaced, and the frame callback
     arrives within one refresh of each commit (pins Weston's timing).
  6. Gate, Weston stopped: `kmssink sync=false` blocks one refresh per
     frame.
- **Acceptance.** Cases 1–3 pass in CI under both runners' GStreamer;
  cases 4–6 are run once per box and their numbers recorded in ADR-0029.
- **Estimate.** +300 lines; 1.5 days.

#### WI-P4-2 waylandsink: present every frame, presentation feedback (Yocto patch 0008)

- **What.** The sink half of part 4.2 for the compositor path.
- **Where.** Yocto: new
  `meta-layers/meta-custom/recipes-multimedia/gstreamer/gstreamer1.0-plugins-bad/0008-waylandsink-present-every-frame-and-presentation-feedback.patch`;
  `gstreamer1.0-plugins-bad_%.bbappend` (one `SRC_URI +=` line after
  0007, with a comment in the file's style). Files patched (GStreamer
  1.28.2 with 0005 and 0007 applied):
  `gst-libs/gst/wayland/meson.build:40–48` (add `['presentation-time',
  'stable', ]`), `gst-libs/gst/wayland/gstwldisplay.c` (registry bind),
  `gst-libs/gst/wayland/gstwlwindow.c` (render `:925–960`, frame callback
  `:705–735`, commit `:790–830`), `ext/wayland/gstwaylandsink.c`
  (properties, `show_frame`, `unlock`/`unlock_stop`).
- **How.**
  - Property `present-every-frame` (boolean, default `FALSE`; `FALSE` is
    0007's behaviour unchanged).
  - With it set, `gst_wl_window_render` never replaces a staged buffer.
    `gst_wayland_sink_show_frame` waits on a new `GCond present_cond`
    while the window has a committed buffer whose frame callback has not
    fired (`priv->frame_pending`). The wait holds neither `window_lock`
    nor the display's `sync_mutex` (the AB-BA deadlock 0007 records); the
    frame callback clears `frame_pending` and signals after releasing
    `window_lock`. `unlock()` breaks the wait with `GST_FLOW_FLUSHING`;
    `unlock_stop()` re-arms it. A 1 s timeout commits anyway and counts
    `present-timeouts`.
  - Presentation feedback: bind `wp_presentation` v1, record `clock_id`;
    request `wp_presentation_feedback` per commit; on `presented` record
    the presented time (only if `clock_id` is `CLOCK_MONOTONIC`), the
    reported refresh, `seq` and the buffer's running time; on `discarded`
    count.
  - Read-only property `display-stats` (`GstStructure`
    `wayland-display-stats`): `presented`, `discarded`, `replaced`,
    `present-timeouts`, `refresh-ns` (mean of presented-time deltas over
    the last 120 presentations, else the reported refresh),
    `last-presented-ns`, `last-running-time`, `commit-to-present-ns`
    (EWMA), `clock-monotonic` (boolean).
- **Acceptance.** On .108 and .103, 1080p50 hardware-decoded through
  `mrvideopace` (after WI-P4-3) for 30 min: `replaced` = 0, `discarded`
  = 0, `refresh-ns` within 0.1 % of the mode; 50 flush/state cycles
  without a hang; Weston output off for 30 s: timeouts counted, no wedge,
  playback resumes; a restart-while-committing stress for 1 h with no
  deadlock (0007's history). WI-P4-1 case 5 passes.
- **Estimate.** +350 (patch) +100 (bench notes and commands in ADR-0029);
  5 days including one image build per box.

#### WI-P4-3 `mrvideopace` (OQ-32)

- **What.** The release half of part 4.2.
- **Where.** New `plugins/mpegts-core/native/mrts/video_pace.{h,cpp}`
  (portable, no GStreamer) and `mrts/tests/video_pace_test.cpp`; element
  `plugins/mpegts-core/native/mrtshouse/gstmrvideopace.cpp`, registered in
  `libgstmrtshouse.so`'s factory table beside `mrasrc` and `mralignwatch`;
  dataflow test `packages/engine/src/child-process/gst_mrvideopace_element_test.py`.
- **How.**
  - `mrts::VideoPace`: `Decision on_frame(int64_t pts_ns, int64_t
    dur_ns, int64_t arrival_ns, bool discont)` → `{release_ns, rate_drop}`;
    `void on_gap()`; `void set_display_period(int64_t ns, bool measured)`;
    `Summary take()` (released, late, rate-drops, gaps-collapsed,
    content-period, display-period, mean-hold). The rules are part 4.2's.
    The cadence hold `r_k = max(a_k, r_(k−1) + Δ_k)` is a PTS-delta hold
    that §8 does not describe (§8: each frame waits only for the display's
    next refresh, "no scheduling by PTS"); it is what keeps video in step
    with audio after a stall on a mismatched refresh, and in steady state
    it ratchets the release phase to the latest arrival until a gap. An
    engineering choice under §13.3, recorded in ADR-0029 and listed for
    the owner (chapter 13) because it changes what an operator sees.
    `gap-threshold` = min(250 ms, 4 × nominal frame duration). Decimation
    only when the content period is shorter than the display period by
    more than 0.05 %.
  - Element: plain `GstElement`, always pads, `GST_PAD_SET_PROXY_CAPS |
    PROXY_ALLOCATION | PROXY_SCHEDULING` (dmabuf and DMA_DRM pass
    untouched). The chain function waits with `gst_clock_id_wait` on the
    element clock (the house clock, `base_time = 0`); FLUSH_START and
    PAUSED→READY unschedule it. Serialized events stay in order; GAP
    events are forwarded and call `on_gap()`.
  - Display period: at PAUSED→PLAYING, walk downstream to the first
    `GstBaseSink`. If it has `display-stats`, read `refresh-ns` once a
    second (measured); else use `refresh-mhz`; else no decimation.
  - Properties: `refresh-mhz` (uint, 0 = unknown), `gap-threshold-ms`
    (default 250), read-only `stats`.
  - Message `mrvideopace` every 2 s: `released`, `late`, `rate-drops`,
    `gaps-collapsed`, `content-fps-x100`, `refresh-ns`, `mean-hold-ns`,
    `present-lateness-ns` (from the sink's `last-presented-ns −
    last-running-time` when available, else release lateness plus one
    refresh).
- **Acceptance.**
  - `video_pace_test`: 50p on 60 Hz: zero drops, releases at the content
    cadence to 1 µs; 60p on 50 Hz: exactly 1 in 6 dropped; 60.000 fps on
    a measured 59.940 Hz: 1 drop per 1,001 ± 1; a 2 s arrival stall: the
    next frames leave at the content cadence (not faster), lateness +2 s,
    zero drops; then a 3 s content gap: lateness after the gap equals the
    input lateness; DISCONT collapses like a gap; the 33-bit wrap
    (`syn-wrap-33bit.ts` timing) gives no step.
  - Element test, both runners (`MR_GST_RUNNER_NATIVE=0` and `=1`):
    `appsrc` → `mrvideopace` → `fakesink sync=false`, releases within 2 ms
    of schedule on the CI host; a flush during a wait returns at once.
- **Estimate.** +700 production, +450 test; 5 days.

#### WI-P4-4 `mrasrc` device mode (C-6; OQ-32)

- **What.** The ASRC of part 4.3.
- **Where.** `plugins/mpegts-core/native/mrts/asrc_servo.{h,cpp}` (Phase 1)
  gains a device term; `plugins/mpegts-core/native/mrtshouse/gstmrasrc.cpp`;
  tests `mrts/tests/asrc_servo_test.cpp`,
  `packages/engine/src/child-process/gst_mrasrc_element_test.py`; a
  test-only sink `plugins/mpegts-core/native/mrtshouse/tests/mrtestaudiosink.c`
  (a `GstAudioSink` whose ring consumes at a set ratio against the system
  clock, built only into the test library).
- **How.**
  - Phase 3 shipped the device mode on `GstAudioBaseSink`'s custom-slaving
    callback with `sync=true` (chapter 7 WI-P3-5, C-6). A `sync=false`
    sink runs no slaving callback, so this item moves the evidence to a
    timer on the sink's `provided_clock` and keeps the one `mrasrc`
    instance.
  - Property `device-clock` (enum `none` | `sink`, default `none`, which
    is Phase 1's capture behaviour). With `sink`, at PAUSED→PLAYING the
    element walks downstream to the first `GstAudioBaseSink` and refs its
    `provided_clock` (part 3.6).
  - A periodic clock id on the system clock (100 ms) samples
    `(gst_clock_get_time(device), CLOCK_MONOTONIC)` into
    `mrts::ClockLock dev_lock` (min-filter, then a rate loop with τ
    60 s). `AsrcServo` commands `in_rate = round(fs_in·1000·(1 +
    ε_dev)/(1 + ε_in))`, `out_rate = fs_out·1000`, through Phase 1's
    `gst_audio_resampler_update` path, clamped to ±1,000 ppm.
  - It never reads a queue level, the ring fill or the prefill.
  - A device-clock step > 50 ms (sink restart, PipeWire recovery)
    relocks `dev_lock` and posts `mrasrc-event relock-device`.
  - `out-rate` follows the sink's negotiated rate (this replaces
    `audioresample` on the output paths).
  - Render lateness: the element keeps (output sample index → input PTS)
    at buffer granularity; the played index is `out_pushed − fill`, with
    `fill = out_pushed − rate·(device − device_at_start)`; it reports
    `now − PTS(played index)`.
  - `mrasrc-stats` gains `device-ppb`, `device-relocks`,
    `render-lateness-ns`.
- **Acceptance.**
  - Servo test: device at +80 ppm with 5 ms reading jitter: ratio within
    1 ppm of truth in 120 s; fill excursion < 5 ms over 1 h simulated; a
    2 s input stall leaves the commanded ratio within 0.5 ppm (the backlog
    is not drained); a 100 ms device step gives one relock.
  - Element test with `mrtestaudiosink` at ratio 1.0001: render lateness
    drift < 2 ms over 30 min of stream time (compressed), THD+N as Phase
    1's bound.
  - Gate: V-P4-4.
- **Estimate.** +400 production, +300 test (including the test sink);
  4 days.

#### WI-P4-5 Runner glue: no-late-drop hook and queue-overrun watch (OQ-30)

- **What.** Make P11 hold for elements no pipeline string names (a
  `decodebin3` rung, an overlay bin), and report a full queue. Existing
  runner glue is twinned in both runners already (the decoder-thread hook);
  these hooks follow it. No new native module is twinned. The no-twin rule
  (§11.5, §13.1) is scoped to the shared TS module and the new native
  elements; pre-existing runner glue in the Python runner and
  `mr-gst-runner` is twinned by construction and stays so, which is why
  case R exists as a parity case (the #819 burden §11.5 cites is accepted
  here for ≈ 250 lines).
- **Where.** `packages/engine/src/child-process/gst-pipeline-runner.py`
  (beside the decoder-thread hook, `:749–845`); new
  `packages/engine/native/mr-gst-runner/no_late_drop.{h,cpp}`, called from
  `runner.cpp` beside `:213–276`, listed in `Makefile:29, 33`;
  `packages/engine/src/plugins/busRunnerContract.test.ts`;
  `native_runner_protocol_test.py` (new case R).
- **How.**
  - Always on; no description field (cut-over rule). At start, for every
    element in the pipeline, and on `deep-element-added`:
    - `GstBaseSink`: `qos=false`; `max-lateness=-1`.
    - `GstVideoDecoder`, `GstAudioDecoder` and `GstBaseTransform` with a
      `qos` property: `qos=false`.
  - One log line per pipeline listing what was changed (`no-late-drop:
    vpdec qos→false, …`).
  - Queue watch: every `GstQueue`/`GstQueue2` whose `leaky` is not 0, or
    whose name starts with `busin`, `vp_esq`, `ad_esq`, `prefill` or
    `aw_`: connect `overrun` and emit plugin event `queue_overrun`
    `{element, levelTimeMs, levelBytes, leaky}`, at most once a second per
    element.
  - The bus ingress queue (`busHelpers.ts:180–198`) and the producer
    fan-out branch (`bus_edges.cpp:425`, `gst-pipeline-runner.py:2603`)
    keep `leaky=2` at their 5 s / byte-cap capacity (OQ-30, decided
    2026-10-12 by the orchestrator, owner delegated): their `overrun` is
    the alarmed resource fault (`queue-full`), not a lateness drop, and
    the non-leaky variant is not built because it reopens the gate01
    deadlock that `busHelpers.ts:157–172` records. The comment there is
    extended to say so.
- **Acceptance.** Case R in both runners: a `decodebin3` that plugs
  `avdec_h264` has `qos=false` (read back over the `get_property` RPC); a
  `queue leaky=2 max-size-buffers=2` fed faster than drained emits
  `queue_overrun`; `busRunnerContract.test.ts` pins `queue_overrun` and
  `no-late-drop` in both runner sources.
- **Estimate.** +250 production, +200 test; 3 days.

#### WI-P4-6 video-player

- **What.** part 4.1 and part 4.2 for the player; Q18; the player's settings.
- **Where.** `plugins/video-player/engine/helpers/{pipelines.ts,
  pipelinePlan.ts, decoderSelection.ts, renderLag.ts}`,
  `engine/VideoPlayerModule.ts`, `package.json`; tests `pipelinePlan.test.ts`,
  `VideoPlayerModule.test.ts`, `renderLag.test.ts`, `decoderSelection.test.ts`.
- **How.**
  - `buildSink(display, env)` (`pipelines.ts:115–170`): one form per sink,
    `waylandsink name=sink sync=false qos=false present-every-frame=true
    fullscreen=true`, `kmssink name=sink connector-id=N sync=false
    qos=false`, `autovideosink sync=false`. `SinkOpts` (`:92–113`) is
    deleted.
  - `planSink` (`pipelinePlan.ts:41–63`) returns `{ sinkElement }`;
    `SinkPlan.sinkPaced` and `videoTsOffsetNs` (`:77–84`) are deleted.
  - `buildLivePipeline` (`pipelines.ts:312–525`) takes `(sinkElement,
    udpSource, compositorScales, decoder, overlay, refreshMhz)`. The
    `bufferMs` and `sinkPaced` parameters, the `buildTsUdpInput`/tsparse
    variant and `buildBackpressureQueue(bufferMs)` (`:390–403`) go; the
    inbound chain is `buildBusSrc({…, stallTimeoutMs})`. The ES queue
    (`:426–427`) becomes `queue name=vp_esq leaky=0 max-size-time=5 s
    max-size-buffers=0 max-size-bytes=<tsQueueByteCap(5000)>`.
    `mrvideopace name=vp_pace` and Phase 0's `lat_render` sit after the
    convert/overlay stage.
  - Q18: the demux is `mrtsdemux name=vpdemux select="<VIDEO_SELECT_CAPS>"`
    on every rung, `decodebin3` included. `VIDEO_SELECT_CAPS` is exported
    from `decoderSelection.ts` and built from `CODEC_CAPS` (`:148`). An
    audio PID gets no pad and is never reassembled. The per-rung caps
    filter stays as the decoder's guard.
  - `refreshMhz`, a sub-item found during verification (≈ 1 day): the
    player resolves no refresh rate today. `westonOutput.ts:113–122`
    `parseModeSize` matches `/^(\d+)x(\d+)(?:@[\d.]+)?$/` and discards
    the `@rr` group; `renderTarget.ts:190–194` returns width × height
    from the connector's sysfs `modes`. So the kmssink path, the only
    user of `refresh-mhz` (waylandsink reports `display-stats`), has no
    refresh source. For the KMS path read the active CRTC mode's
    `vrefresh` through libdrm (`drmModeGetCrtc` on the connector the
    module already selects) in a small native helper, or let
    `mrvideopace` measure kmssink's blocking `show_frame` period and
    treat it as measured; capture `@rr` in `parseModeSize` for the Weston
    fallback. V-P4-6 gains a KMS case.
  - `planLivePipeline` (`pipelinePlan.ts:205–293`): `backlogShed`
    (`:209–226, :263–264`), `bufferMs`, `sinkPaced` and `services` go.
    `keyframeGate` and `renderWatch` stay; the gate's comment
    (`:265–281`) says DISCONT now comes only from real loss.
  - `VideoPlayerModule.ts`: `liveUpdatableParams` (`:112`) loses
    `lipSyncMs`; the `lipSyncMs` branch (`:1091–1098`),
    `onRoutePlayoutOffsetChanged` (`:1117–1119`) and `pushSinkTsOffset`
    (`:1122–1127`) are deleted; `buildPipeline` stops reading `sync`,
    `bufferMs` and `lipSyncMs` (`:1151`, `:1232–1236`); `onPluginEvent`
    passes `mrvideopace` stats to the reporter (WI-P4-12).
  - `renderLag.ts`: the ratchet fields and their attribution (`:49–62`,
    `:74–80`, `:131–160`) go; the fps-shortfall attribution stays (§11.4
    "Render keep-up: kept").
  - `package.json`: `lipSyncMs` removed; `sync` and `bufferMs` removed
    (OQ-29).
- **Acceptance.** Snapshot tests for every rung (`v4l2h264dec`,
  `avdec_h264`, `v4l2slh265dec`, `avdec_h265`, `decodebin3`) on each sink
  (wayland, kms, auto): contain `sync=false`, `qos=false`,
  `present-every-frame=true` (wayland), `mrvideopace`, `vp_esq …
  leaky=0`, `select=`; contain none of `ts-offset`, `max-lateness`,
  `tsparse`, `leaky=2` (except the probe tap and the bus ingress backstop,
  OQ-30). A module test with stored
  `lipSyncMs`, `sync=false` and `bufferMs` builds the same string as
  without them. Conformance `scn-out-video-only`, `scn-out-stall`,
  `scn-out-rate-*` (part 7.4). Gate V-P4-1 to V-P4-3.
- **Estimate.** +300 / −450 production; +320 / −400 test; 5 days (the
  refresh source included).

#### WI-P4-7 audio-decoder (OQ-29, OQ-31)

- **What.** part 4.1 and part 4.3 for the decoder output.
- **Where.** `plugins/audio-decoder/engine/AudioDecoderModule.ts`, its
  test, `package.json`.
- **How.**
  - Delete `CONTRACT_SINK_BUFFER_US`, `SINK_DECLARED_LATENCY_MS` (`:14–38`),
    `audioTsOffsetNs` (`:40–75`), `SLAVE_METHOD_SKEW` (`:77–83`), the
    `syncOffsetMs` live branch (`:177–180`), `onRoutePlayoutOffsetChanged`
    (`:181–188`), `pushSinkTsOffset` (`:190–204`), and the `clockSync`,
    `lowLatencySync`, `slaveMethod`, `sinkBufferMs` and `bufferMs`
    resolution with its comments (`:262–367`).
  - `buildPipeline` builds part 4.1's audio-decoder string. Phase 3 placed
    `mrasrc … device-sink=sink` after the decoder (WI-P3-10); this WI
    switches that instance to the timer evidence (`device-clock=sink`)
    and the sink to `sync=false`; there is never a second resampler.
  - `liveUpdatableParams` (`:109`) = `['volume', 'audioEnabled']`.
  - `package.json`: `syncOffsetMs` removed; `slaveMethod`,
    `lowLatencySync`, `bufferMs`, `sinkBufferMs` removed (waits on
    OQ-29).
- **Acceptance.** A snapshot per codec branch (opus, aac, mp2, ac3,
  decodebin) contains `sync=false`, `mrasrc … device-clock=sink`,
  `prefill`, `ad_esq … leaky=0`; none of `ts-offset`, `slave-method`,
  `max-lateness`, `sync=true`. Stored legacy keys are ignored. Gate V-P4-4.
- **Estimate.** +120 / −260 production; +150 / −250 test; 2.5 days.

#### WI-P4-8 audio-output-302m (OQ-31)

- **What.** part 4.1 and part 4.3 for the device output.
- **Where.** `plugins/audio-output-302m/engine/AudioOutput302mModule.ts`,
  its test, `package.json`; delete `audio302mTiming.ts` and
  `audio302mTiming.test.ts`.
- **How.**
  - `audioconvert ! audioresample` (`:208`) becomes `audioconvert ! mrasrc
    name=asrc device-clock=sink`; the sink becomes part 4.1's.
  - `liveUpdatableParams` (`:53`) loses `lipSyncMs`; `onLiveConfigUpdate`
    keeps only volume (`:111–118`); `onRoutePlayoutOffsetChanged` and
    `pushSinkTsOffset` (`:120–141`) go; `mixerLatencyNs` and
    `tsOffsetNs` go if Phase 2 left them (`:55–62`); the `backlogShed`
    block (`:228–251`) goes.
  - Status: `timing: 'house clock, playout offset'` and `tsOffsetMs`
    (`:221–222`) are dropped; the `timing` section (WI-P4-12) carries the
    numbers.
  - `package.json`: `lipSyncMs` removed (`mixLatencyMs` is checked gone).
- **Acceptance.** Snapshots for the single-source and mixer arms, with and
  without placement. Gate V-P4-4.
- **Estimate.** +80 / −200 production; +100 / −180 test; 1.5 days.

#### WI-P4-9 Transcoder burn-in: `subtitleDelayMs` replaced by a content-time wait (OQ-24)

- **What.** The setting goes with its mechanism, the `subhold` queue. The
  burn-in overlay is an aligner of video and a sparse cue track (§6 item
  4), so video waits for the cue track by content time instead of a fixed
  hold.
- **Where.** `plugins/transcoder/engine/{transcoderSubtitles.ts,
  transcoderPipeline.ts, transcoderPipelineTypes.ts, TranscoderModule.ts}`
  and tests (`transcoderSubtitles.test.ts`, `transcoderPipeline.test.ts`,
  `transcoderPipeline.golden.test.ts`, `TranscoderModule.test.ts`),
  `package.json:290–300`; `plugins/subtitle-core/engine/subtitleOverlay.ts`
  (cue input fragment, `:201`).
- **How.**
  - Delete `SUBTITLE_HOLD_NAME`, `SUBTITLE_HOLD_MAX_BYTES`,
    `buildSubtitleHold` (`transcoderSubtitles.ts:11–25`), the `delayMs`
    parameter (`:40–48`), `subtitleDelayMs` in
    `transcoderPipelineTypes.ts:55–57`, `TranscoderModule.ts:228–233,
    255` and the manifest.
  - With a subtitle source wired, the video branch before the decoder gets
    `mralignwatch name=sub_aw_v aligner=subs input=video
    max-size-bytes=<tsQueueByteCap(5000)>`, and the cue input fragment gets
    `mralignwatch name=sub_aw_c aligner=subs input=cues sparse=true` before
    the bridge's appsink (Phase 2's element, WI-P2-6). Both share the pace
    group `subs`, so video is released at `PTS + pace`, where the pace is
    the cue track's lateness. The wait shows as the transcoder's added
    latency.
  - If Phase 3 already made the overlay wait by content time, only the
    deletions remain.
- **Acceptance.** Golden pipelines contain no `subhold` and no
  `min-threshold-time`. Conformance `scn-burnin-late-cues` (part 7.4).
- **Estimate.** +80 / −60 production; +120 / −60 test; 2 days.

#### WI-P4-10 aes67-output audit

- **What.** Confirm the AES67 egress drops nothing and holds no D.
- **Where.** `plugins/aes67-output/engine/Aes67OutputModule.ts`, its test.
- **How.** No pipeline change: `udpsink … sync=true max-lateness=-1
  ts-offset=<senderLatencyMs>` stays; the comment at `:236–242` already
  says the margin is not D. The 200 ms `buildBackpressureQueue` (`:265`) is
  non-leaky. A test pins `max-lateness=-1`, no `leaky=`, and that the
  string does not change with any D-shaped input.
- **Acceptance.** The test passes; the no-late-drop lint (WI-P4-13)
  whitelists this sink's `sync=true` as egress pacing.
- **Estimate.** +20 production, +40 test; 0.5 day.

#### WI-P4-11 Engine core and runners: delete D, the head walk, raises, rebase and the shedder

- **What.** §11.4 rows "Lateness handling" and "Route-head D", end to end,
  in the release that stops using them. Done after WI-P4-6 to -9, when no
  plugin imports them.
- **Where and how.**
  - Delete files: `packages/engine/src/plugins/{playoutOffset.ts,
    playoutReanchor.ts, playoutReanchorState.ts, playoutReanchorText.ts,
    backlogShed.ts}`, `packages/engine/src/routing/PlayoutRaises.ts`,
    `packages/engine/src/child-process/backlog_shed.py`,
    `packages/engine/native/mr-gst-runner/backlog_shed.{cpp,h}`, and their
    tests (part 6.1).
  - `MediaRouter.ts`: delete `:16–19`, `:23–25`, `:72–77`, `:527–617`,
    `:650–688`.
  - `ModuleInstance.ts`: delete `:12–13`, the `PLAYOUT_OFFSET_KEY` branch
    (`:245–251`), the fan-out (`:270–289`) and the three `notifyRoute*`
    methods (`:292–308`).
  - `Engine.ts`: delete `:31`, `:58–75`, `:104–107`, `:152–176`,
    `:386–387` (`playoutOffsetMs`, `playoutReanchor`,
    `MR_PLAYOUT_OFFSET_MS`, `MR_PLAYOUT_REANCHOR`).
    `ModuleManager.ts`: delete `:35–38`, `:48–49`, `:59–60`, `:123–126`.
  - `PluginModule.ts`: delete `:9`, `:68–78`, `:132–147`, `:505–529`,
    `:653–680`. `index.ts`: delete `:186–209`. `PythonProcess.ts:9, 61`,
    `GstChildProcess.ts:248`: drop `backlogShed`.
  - `GstPluginBase.ts`: delete `:14`, `:17–26`, `reanchor`/`rebase` from
    `OwnedWarning` (`:32`), `this.playout.reassert()` (`:304`), the two
    dispatch branches and `logBacklogShed` (`:740–788`), the
    `PlayoutReanchorState` block and its hooks (`:790–833`).
  - Python runner: delete `:2188–2196`, `:2262`, `:3785–3793`,
    `:4067–4619`; `package.json:23` stops copying `backlog_shed.py`;
    `:26` drops `backlog_shed_test.py` and `gst_backlog_shed_test.py`, and
    replaces `gst_latency_ratchet_test.py` with
    `gst_output_backlog_test.py` (WI-P4-14).
  - Native runner: `runner.cpp:12, 359, 418`; `gates.cpp:14, 302`;
    `runner.h:12` (comment); `Makefile:29, 33`.
  - Ingests and splitter: `playoutOffsetMs` out of the five manifests and
    the five `liveUpdatableParams` (part 3.2); `Aes67InputModule.ts:35` and
    the comments that name D.
  - Manager: `packages/manager/src/plugins/manifestHelpText.test.ts:15`
    (`SHARED_KEYS` loses `playoutOffsetMs` and `mixLatencyMs`);
    `packages/manager-ui/src/utils/fieldLabel.ts:5` and its test take
    another key as the example.
  - Guard test: new `packages/engine/src/plugins/removedTimingSettings.test.ts`
    reads every `plugins/*/package.json` and fails if a manifest declares
    `playoutOffsetMs`, `lipSyncMs`, `syncOffsetMs`, `mixLatencyMs`,
    `subtitleDelayMs` (and OQ-29's keys).
  - Phase 2 leftovers checked: `latchRepair.ts`, `getUpstreamBusProducers`
    and `MediaRouter.latchRepair.test.ts` absent; if not, deleted here.
- **Acceptance.**
  `grep -rnE "playoutOffset|PLAYOUT_OFFSET|PlayoutRaise|playoutReanchor|reanchor|backlogShed|backlog_shed|BacklogShed|MR_PLAYOUT|onRoutePlayout|lipSyncMs|syncOffsetMs|mixLatencyMs|subtitleDelayMs|effectiveLatchRepair" packages plugins --include=*.ts --include=*.py --include=*.cpp --include=*.h --include=*.json`
  (excluding `dist`, `node_modules`) finds only the guard test.
  Engine `vitest`, `test:py`, the native runner build and
  `native_runner_protocol_test.py` pass; the Python runner shrinks by
  ≈ 600 lines.
- **Estimate.** +60 production, +100 test; −≈ 7,100 (part 6); 3 days.

#### WI-P4-12 Lateness at outputs: display, lateness trend, the queue-full alarm

- **What.** part 4.5, the lateness-trend row and the queue-full alarm
  (§8, R9); the capacity alarm is deferred (OQ-34).
- **Where.** `packages/engine/src/plugins/latenessReporter.ts` (Phase 0)
  and test; `GstPluginBase.ts` (`OwnedWarning`, `:32`);
  `packages/shared-types/src/` (`ModuleTimingSummary`).
- **How.**
  - Output rows: `Render lateness` from `mrvideopace.present-lateness-ns`
    (video) or `mrasrc.render-lateness-ns` (audio), else Phase 0's
    `λ(lat_render) + device`; `Decode` = `λ(lat_render) − λ(lat_busin)`
    (unchanged); `Device latency` = render − `λ(lat_render)`. Delete
    `presentationDelayMs` and the "Presentation delay" row. New rows:
    `Clock ratio` (audio outputs, ppm), `Rate match` (video:
    "50.00 fps → 60.00 Hz, 0 drops/min"), `Late releases` (video, per
    minute).
  - Lateness trend (OQ-34, decided 2026-10-12 by the orchestrator, owner
    delegated: deferred like the lateness alarm, OQ-8): the least-squares
    slope of output lateness over a 3 min window with no gap is shown as
    a labelled row, `Lateness trend` ("+12 ms/min — decode or device
    slower than real time" when positive), with no alarm and no setting.
    The threshold idea (warn above 20 ms/min over 3 min, clear below a
    quarter of it) joins the deferred-alarm note of chapter 4 part 13.
  - Queue full: `queue_overrun` → `ownWarning('queue-full', 'Queue <name>
    full at <ms> ms — content lost at capacity')`; clears after 30 s
    without an overrun.
  - `OwnedWarning` gains `queue-full` (it lost `reanchor` and `rebase` in
    WI-P4-11). It only warns; nothing drops content.
- **Acceptance.** Reporter tests with synthetic windows: the trend row and
  its label, overrun mapping, no `capacity` warning and no alarm setting
  in any manifest, no "Presentation delay" row on any output; module
  tests show the new rows for each output type.
- **Estimate.** +250 / −60 production; +250 test; 2.5 days.

#### WI-P4-13 R10 checklist and the no-late-drop lint (OQ-30)

- **What.** Turn §11.3 item 7 and R10 into a checklist with a fate per
  item, and a test that keeps it true.
- **Where.** ADR-0029 (the table); new
  `packages/engine/src/plugins/noLateDrop.test.ts`;
  `packages/engine/src/plugins/encoderLeaf.ts:36`; comments in
  `busHelpers.ts:150–178`, `tsHelpers.ts:68–130`,
  `gst-pipeline-runner.py:2536–2605`.
- **How.**
  - The checklist is part 3.6's table with a "Phase 4" column: each item
    removed, switched off, kept as a capacity backstop (alarmed) or exempt
    (diagnostic tap, ingest-side, decode safety).
  - `encoderLeaf.ts:36` `DECODER_POOL_QUEUE` becomes `leaky=0` (same 4
    buffers): a slow rendition then shows as transcoder lateness instead
    of lost frames.
  - The `buildBackpressureQueue` doc (`tsHelpers.ts:100–114`, above the
    function at :115) loses "Do
    NOT use this to feed a real decoder/render sink"; `buildLeakyQueue`
    keeps only its ingest and diagnostic callers.
  - Lint: builds every output and processing module's pipeline through
    the existing module test harnesses and fails on `leaky=1|2|upstream|
    downstream` outside a whitelist (`vp_ts` probe tap, `resume_sink` tap,
    teletext probe tap, ingest queues, the bus ingress backstop and the
    fan-out branch, which OQ-30 keeps `leaky=2`), `max-lateness=`
    other than `-1`, `qos=true`, `sync=true` on
    a presentation sink, `ts-offset=` on any sink except aes67-output's,
    and `drop=true` on an appsink carrying content.
- **Acceptance.** The lint passes on the Phase 4 tree and fails on a
  planted `leaky=2` in a test copy of the video-player string.
- **Estimate.** +250 / −30 production and comments; +250 test; 2 days.

#### WI-P4-14 Fixtures and the output conformance harness

- **What.** part 7.4's captures and scenarios, run through both runners.
- **Where.** `plugins/mpegts-core/tests/fixtures/` (captures and
  `.expect.json`; in-repo, off the device per OQ-2 and WI-S0-13); new
  `packages/engine/src/child-process/output_conformance_test.py`;
  `gst_latency_ratchet_test.py` rewritten as `gst_output_backlog_test.py`.
- **How.** Captures are taken on the gate by the assistant session with rig
  access after Phase 3 is installed (OQ-3), so they carry house time from
  the ingest and formula-demux timing. The
  harness feeds them over a unixfd socket into each output pipeline with
  `fakesink`/`mrtestaudiosink` in place of the device sinks (CI), or the
  real sinks (gate, `MR_GATE=1`), and asserts the `.expect.json`
  conditions from `mrvideopace`, `mrasrc`, `mrlateness` and
  `queue_overrun` events. Every scenario runs with
  `MR_GST_RUNNER_NATIVE=0` and `=1`.
- **Acceptance.** All scenarios pass in CI; the gate scenarios pass in
  V-P4-1 to V-P4-6.
- **Estimate.** +900 (harness, expectations, generator flags); 4 days.

#### WI-P4-15 ADR, documents, release notes

- **Where.** `docs/adr/0029-house-clock-timing.md` (Phase 0);
  `docs/adr/0005-time-sync-backend.md`
  (decision 4 with its amendments, the 2026-10-08 re-anchor amendment at
  `:897–`, the 302M output notes of 2026-09-03, the `:141–148` re-anchor
  numbers); `docs/adr/0008-302m-fan-in-contract.md:80`;
  `docs/adr/0016-subtitle-carrier-klv-webvtt.md:140`;
  `docs/adr/0022-settings-help-text-contract.md:29–30`;
  `docs/adr/README.md`; `plugins/README.md:1549–1585` ("Playout Offset D"),
  `:1040` (the re-anchor paragraph), `:2012`, `:2055–2063`, `:2136–2145`
  ("Never drop on lateness"), `:2575–2577`; the Phases 1–4 release notes (where
  Phases 0–3 put theirs).
- **How.**
  - ADR-0029 gains "Presentation": play on arrival, `mrvideopace`, 0008,
    `mrasrc` device mode, the queue table (part 4.4), the R10 checklist, the
    gap rule (OQ-32) and the WI-P4-1/-2 bench numbers.
  - ADR-0005: the re-anchor amendment and the 302M output notes marked
    "superseded by ADR-0029 (Phase 4)"; decision 4 is already marked by
    Phase 2. ADR-0008 `:80` (shedder, live D push, `lipSyncMs`) and
    ADR-0016 `:140` marked superseded; ADR-0022 `:29–30` names
    `pcmBitDepth` alone.
  - `plugins/README.md`: "Playout Offset D" replaced by a short "Outputs
    play on arrival" section (no D, no trims, lateness shown); the producer
    paragraph at `:2055–2063` and the aes67-input bullet at `:2575–2577`
    deleted; `:2012` reworded.
  - Release notes, operator text (R12, R13):

    > **Outputs now play as soon as content arrives.** Video players,
    > audio decoders and 302M audio outputs no longer wait for a playout
    > offset. Most outputs will be earlier than before: by the engine's
    > 60 ms default, by any Playout Offset set on an input or splitter
    > (up to 10 s), and by any automatic raise the engine had added.
    > Every output shows its lateness in ms in its Timing section; that
    > number is now when the content is actually seen or heard.
    >
    > **Lipsync is made by a muxer.** A video player and an audio output
    > stay together only when both take their streams from one MPEG-TS
    > Muxer. A route from an input or a splitter straight to a video player
    > and an audio decoder is no longer aligned: video can lead its audio
    > by up to about a second, by the encoder's own lead. Route both
    > through a muxer. The video player shows video only; it ignores any
    > audio in its stream.
    >
    > **Nothing is dropped for being late.** After a network or processing
    > stall an output plays the delayed content late instead of skipping
    > it, and stays that much later until the next gap in the content or
    > a restart of the output. A "Falling behind" warning means the box
    > cannot decode or play in real time; a "Queue full" warning means
    > content was lost because a queue reached its capacity.
    >
    > **Removed settings, not migrated.** Playout Offset (SRT, RIST,
    > MPEG-TS IP and AES67 inputs; TS Splitter), Lip-Sync Trim (Video
    > Player; Audio Output 302M), Sync Trim (Audio Decoder), Subtitle Sync
    > Delay (Transcoder), Mix Latency, Sync and Buffer (Video Player),
    > and Sync Method, Low-Latency Sync, Buffer and Sink Buffer (Audio
    > Decoder). The engine environment variables
    > `MR_PLAYOUT_OFFSET_MS` and `MR_PLAYOUT_REANCHOR` are ignored. To
    > shift a source in time, set the Ingest Offset or a per-PID Trim on
    > its input (new in this release). There is no output-side trim.
    >
    > **Interpreter and commentator microphones.** If you set an Ingest
    > Offset on a microphone input from a monitor's lateness, read the
    > monitor output's lateness again after installing and re-set the
    > offset at a pause: the monitor is now earlier.
    >
    > **Rollback.** Install the previous release from the Device Manager.
    > Stored values of the removed settings are kept and apply again after
    > a rollback.
- **Acceptance.** `grep -n "playoutOffsetMs\|lipSyncMs\|backlog\|reanchor\|re-anchor\|Playout Offset" plugins/README.md`
  finds only the removed-settings note; the ADR index carries the
  statuses.
- **Estimate.** +450 / −400; 2 days.

#### WI-P4-16 Gate verification and release

- **What.** part 11 on 10.9.16.103 and 10.9.16.108 with the RAUC image (the
  release carries a plugins-bad patch and native libraries, so it is an
  image, not a dist tarball). This is the gate of the Phases 1–4 release
  (OQ-13): the image carries S0 and Phases 1, 2, 3 and 4, and the
  release-level checks of chapters 3, 5, 6 and 7 run on it again
  (chapter 11).
- **How.** Install; run V-P4-1 to V-P4-11 under both runners, then the
  chapter 11 union; roll back to the Phase 0 release from the Device
  Manager and forward again (V-P4-11).
- **Estimate.** +200 (scripts and checklists); 3 days.

### 6. Deletions

Everything below goes with Phase 4, in the Phases 1–4 release.

#### 6.1 Files

| File | Lines | WI |
|---|---|---|
| `packages/engine/src/plugins/playoutOffset.ts`, `playoutOffset.test.ts` | 151 + 284 | 11 |
| `packages/engine/src/plugins/playoutReanchor.ts`, `playoutReanchor.test.ts` | 188 + 279 | 11 |
| `packages/engine/src/plugins/playoutReanchorState.ts`, `playoutReanchorText.ts` | 174 + 162 | 11 |
| `packages/engine/src/plugins/GstPluginBase.playoutReanchor.test.ts` | 336 | 11 |
| `packages/engine/src/plugins/backlogShed.ts`, `backlogShed.test.ts`, `GstPluginBase.backlogShed.test.ts` | 168 + 147 + 103 | 11 |
| `packages/engine/src/routing/PlayoutRaises.ts` | 153 | 11 |
| `packages/engine/src/routing/MediaRouter.playoutOffset.test.ts`, `MediaRouter.playoutReanchor.test.ts` | 279 + 335 | 11 |
| `packages/engine/src/child-process/backlog_shed.py`, `backlog_shed_test.py`, `gst_backlog_shed_test.py` | 421 + 497 + 774 | 11 |
| `packages/engine/src/child-process/gst_latency_ratchet_test.py` (replaced by `gst_output_backlog_test.py`) | 388 | 11, 14 |
| `packages/engine/native/mr-gst-runner/backlog_shed.cpp`, `backlog_shed.h` | 725 + 35 | 11 |
| `plugins/audio-output-302m/engine/audio302mTiming.ts`, `audio302mTiming.test.ts` | 89 + 64 | 8 |
| Checked gone (Phase 2): `packages/engine/src/plugins/latchRepair.ts` (+ test), `routing/MediaRouter.latchRepair.test.ts` | 50 + 42 + 84 | 11 |

#### 6.2 Functions, fields and code ranges

| What | Where | WI |
|---|---|---|
| Head walk, raise surface, `notifyPlayoutOffsetChanged`, `declaredPlayoutOffsetMs`, `playoutRaises` | `MediaRouter.ts:16–19, 23–25, 72–77, 527–617, 650–688` | 11 |
| Route-head key special case, fan-out, `notifyRoutePlayout{OffsetChanged,Raised,Rebased}` | `ModuleInstance.ts:12–13, 245–251, 270–308` | 11 |
| `EngineConfig.playoutOffsetMs`, `.playoutReanchor`, `MR_PLAYOUT_OFFSET_MS`, `MR_PLAYOUT_REANCHOR` | `Engine.ts:31, 58–75, 104–107, 152–176, 386–387`; `ModuleManager.ts:35–38, 48–49, 59–60, 123–126` | 11 |
| `ModuleServices.playoutOffsetMs`, `.playoutReanchor`; `onRoutePlayout*` hooks; `PipelineDescription.backlogShed`; `BacklogShedConfig` | `PluginModule.ts:9, 68–78, 132–147, 505–529, 653–680` | 11 |
| Exports of D and the shedder | `index.ts:186–209` | 11 |
| Shed and re-anchor dispatch, `logBacklogShed`, `PlayoutReanchorState`, `ownReanchorWarning`, `playout.reassert()`, `OwnedWarning` `reanchor`/`rebase` | `GstPluginBase.ts:14, 17–26, 32, 304, 740–833` | 11 |
| `backlogShed` pass-through | `PythonProcess.ts:9, 61`; `GstChildProcess.ts:248` | 11 |
| Python shedder glue | `gst-pipeline-runner.py:2188–2196, 2262, 3785–3793, 4067–4619` | 11 |
| Native shedder glue | `runner.cpp:12, 359, 418`; `gates.cpp:14, 302`; `runner.h:12`; `Makefile:29, 33` | 11 |
| `buildSink` `sync`/`ts-offset`/`max-lateness`/`qos` clauses, `SinkOpts`; `tsInput` paced variant; leaky ES queue | `pipelines.ts:92–170, 390–403, 426–427` | 6 |
| `planSink` `sinkPaced`, `videoTsOffsetNs`, `backlogShed` in `planLivePipeline`, `LivePlanInput.bufferMs/sinkPaced/services` | `pipelinePlan.ts:33–84, 186–187, 190–196, 209–226, 263–264` | 6 |
| `lipSyncMs` live push, `onRoutePlayoutOffsetChanged`, `pushSinkTsOffset` | `VideoPlayerModule.ts:112, 1091–1098, 1117–1127` | 6 |
| Ratchet fields in render lag | `renderLag.ts:49–62, 74–80, 131–160` | 6 |
| `CONTRACT_SINK_BUFFER_US`, `SINK_DECLARED_LATENCY_MS`, `audioTsOffsetNs`, `SLAVE_METHOD_SKEW`, D push, sync-mode resolution | `AudioDecoderModule.ts:14–91, 173–204, 262–367` | 7 |
| `lipSyncMs` live push, D push, `mixerLatencyNs`, `backlogShed`, `tsOffsetMs` status | `AudioOutput302mModule.ts:53, 55–62, 111–141, 194–208, 221–251` | 8 |
| `SUBTITLE_HOLD_NAME`, `SUBTITLE_HOLD_MAX_BYTES`, `buildSubtitleHold`, `delayMs`, `subtitleDelayMs` | `transcoderSubtitles.ts:11–25, 40–48`; `transcoderPipelineTypes.ts:55–57`; `TranscoderModule.ts:228–233, 255` | 9 |
| `playoutOffsetMs` in `liveUpdatableParams` and comments | `SrtInputModule.ts:22`, `RistInputModule.ts:60`, `MpegTsIpInputModule.ts:36`, `Aes67InputModule.ts:35, 53`, `TsSplitterModule.ts:76` | 11 |

#### 6.3 Settings

| Key | Manifest | Mechanism gone |
|---|---|---|
| `playoutOffsetMs` | `plugins/{srt-input,rist-input,mpegts-ip-input,aes67-input,ts-splitter}/package.json` | Route-head D |
| `lipSyncMs` | `plugins/video-player/package.json:74–85`; `plugins/audio-output-302m/package.json:77` | Sink `ts-offset` trim |
| `syncOffsetMs` | `plugins/audio-decoder/package.json:122` | Sink `ts-offset` trim |
| `subtitleDelayMs` | `plugins/transcoder/package.json:290–300` | `subhold` (OQ-24) |
| `mixLatencyMs` | checked gone (Phase 2) | Fixed mixer budget |
| `sync`, `bufferMs` (video-player); `slaveMethod`, `lowLatencySync`, `bufferMs`, `sinkBufferMs` (audio-decoder) | each `package.json` | Paced sink, skew slaving, jitter sizing (OQ-29) |
| Env `MR_PLAYOUT_OFFSET_MS`, `MR_PLAYOUT_REANCHOR` | `Engine.ts` | D, raise |

Stored values are left in stored configs and ignored (OQ-33).

#### 6.4 Tests changed

`native_runner_protocol_test.py:432–502` (`test_presentation_leg`:
rewritten for a `sync=false` sink with the no-late-drop hook) and
`:503–676` (three shed/re-anchor cases deleted); `busRunnerContract.test.ts`
(shedder pins replaced by `queue_overrun`/`no-late-drop` pins);
`nativeRunner.test.ts`, `GstChildProcess.test.ts`, `Engine.test.ts`,
`ModuleInstance.test.ts` (D cases deleted);
`pipelinePlan.test.ts`, `VideoPlayerModule.test.ts`, `renderLag.test.ts`,
`AudioDecoderModule.test.ts`, `AudioOutput302mModule.test.ts`,
`TranscoderModule.test.ts`, `transcoderPipeline*.test.ts`,
`transcoderSubtitles.test.ts` (D, trim and hold cases deleted, new
snapshots); `packages/manager/src/plugins/manifestHelpText.test.ts:15`;
`packages/manager-ui/src/utils/fieldLabel.test.ts:6, 11`.

#### 6.5 Documents

ADR-0005 re-anchor amendment and 302M output notes (superseded);
ADR-0008 `:80`; ADR-0016 `:140`; ADR-0022 `:29–30`;
`plugins/README.md:1040, 1549–1585, 2012, 2055–2063, 2136–2145,
2575–2577`. ADRs are marked
superseded, not erased; the README text is rewritten.

### 7. Tests and fixtures

#### 7.1 Unit tests (C++, no GStreamer)

| Test | Pins |
|---|---|
| `plugins/mpegts-core/native/mrts/tests/video_pace_test.cpp` | Release rule, gap collapse, DISCONT, rate-match ratios (50→60, 60→50, 60.000→59.940), stall without catch-up, wrap |
| `mrts/tests/asrc_servo_test.cpp` (extended) | Device term: lock at +80 ppm, fill bound over 1 h, stall does not move the ratio, device-step relock |

#### 7.2 Element dataflow tests (Python harness, native elements, both runners' GStreamer)

| Test | Pins |
|---|---|
| `gst_no_late_drop_test.py` | WI-P4-1 cases 1–3 (CI), 4–6 (gate) |
| `gst_mrvideopace_element_test.py` | Release timing to 2 ms, flush during wait, GAP pass-through, proxy caps with dmabuf caps |
| `gst_mrasrc_element_test.py` (extended) | Device mode with `mrtestaudiosink`: render-lateness drift, relock, one resampler |
| `gst_output_backlog_test.py` (replaces `gst_latency_ratchet_test.py`) | Arm A: unpaced sink, spare rate — a stall leaves a backlog that plays out at content rate behind `mrvideopace`, zero drops. Arm B: media-rate sink — same. Arm C: then a gap — lateness returns to the input's. No arm sheds. |

#### 7.3 Protocol tests in both runners

`native_runner_protocol_test.py` runs each case against the native runner
and the Python runner (case N's idiom):

| Case | Pins |
|---|---|
| R (new) | No-late-drop hook on named and bin-plugged elements; `queue_overrun` event shape and rate limit |
| Presentation leg (rewritten, was `:432–502`) | A `sync=false` pulsesink-free audio leg (`fakesink`) with `mrasrc` and `prefill`: no `backlog_shed`, no `playout_reanchor`, `mrlateness:lat_render` reported |
| Deleted | `test_shed_refusals`, `test_reanchor_parity`, `test_reanchor_gap_and_undo_parity` |

#### 7.4 Conformance fixtures from field captures

Location: `plugins/mpegts-core/tests/fixtures/`, with `<name>.expect.json`
beside each scenario (S0's convention). New captures are taken on the gate
after Phase 3 is installed. Reused from S0 and Phase 2:
`cap-occ-1080i-h264-aac-ttx.ts`, `cap-mux-align7-aac-opus.ts`,
`cap-302m-bssd.ts`, `syn-wrap-33bit.ts`.

| Fixture | Source | Pins |
|---|---|---|
| `cap-av-h264-aac-muxed.ts` | mpegts-muxer egress on .108, H.264 1080p50 + AAC, 60 s | A/V program after a muxer |
| `cap-h264-1080p50-hi.ts` | the fleet's highest-bitrate H.264 1080p50 feed, through Phase 1's restamp | Pi 5 software-decode capacity |
| `cap-hevc-1080p50.ts` | transcoder HEVC rendition egress on .103 | Pi 4/5 stateless HEVC path |
| `cap-302m-mixer-out.ts` | audio-mixer egress on .108 (Phase 2 graph) | 302M output with a mixer arm |
| `cap-burnin-late-cues.ts` | OCC video plus its cue track on the gate, cue lateness ≈ 1.4 s (the burn-in lateness measured on the OCC gate) | Subtitle wait by content time |

Synthetic variants come from S0's `fixture_gen.cpp` with flags this phase
adds: `--stall-ms`, `--gap-ms`, `--fps`, `--drop-pid`.

Scenarios (`output_conformance_test.py`, both runners):

| Scenario | Graph | Pass condition |
|---|---|---|
| `scn-out-stall` | `cap-av-h264-aac-muxed.ts` with a 2 s stall → video-player and audio-decoder | Zero frames and zero samples lost (PTS sequence complete at `lat_render`; sample count in = out); render lateness +2 s ± 40 ms on both; raised until a gap |
| `scn-out-gap-recovers` | as above, then a 3 s content gap | After the gap, render lateness = pre-stall ± 40 ms on both |
| `scn-out-av-after-mux` | `cap-av-h264-aac-muxed.ts` → video-player + audio-decoder | `|λ_render(video) − λ_render(audio)|` ≤ 45 ms (BT.1359) in steady state and after `scn-out-stall` |
| `scn-out-video-only` | the same muxed file → video-player | `mrtsdemux` exposes one pad; its counters show zero audio PES assembled (Q18) |
| `scn-out-rate-50p-60hz` | 50p → `mrvideopace refresh-mhz=60000` | Zero drops of any kind |
| `scn-out-rate-60p-50hz` | 60p (generator) → `refresh-mhz=50000` | `rate-drops` exactly 1 in 6; zero other drops |
| `scn-out-wrap` | `syn-wrap-33bit.ts`-derived video → video-player | No release step across the wrap |
| `scn-asrc-out-drift` | `cap-302m-mixer-out.ts` → audio-output-302m with `mrtestaudiosink` at +100 ppm | Render-lateness drift < 2 ms over 30 min of stream time; no underrun after the prefill |
| `scn-out-capacity` | `cap-h264-1080p50-hi.ts` into a decoder throttled to 90 % of real time | `Lateness trend` row positive within 4 min and no `capacity` warning (deferred, OQ-34); no drop until `vp_esq` is full; then `queue_overrun` and `queue-full` |
| `scn-burnin-late-cues` | `cap-burnin-late-cues.ts` → transcoder burn-in | Every cue overlaid on its frame (±1 frame); transcoder added latency ≈ cue lateness ± 50 ms; zero video frames dropped |

#### 7.5 Tests deleted or rewritten

As parts 6.1 and 6.4 list, ≈ 3,800 lines of TypeScript and Python tests
for D, the raise, the rebase and the shedder are deleted; the ratchet fixture
and the
presentation-leg protocol case are rewritten for the new behaviour.

### 8. Manager and UI

Settings render from the manifests (`ModuleSettingsPanel.vue`, ADR-0007),
so the manager needs no UI code for the removals.

| Module | Settings removed | Settings added | Shows (Timing section, §9.5) |
|---|---|---|---|
| video-player | Lip-Sync Trim; Sync, Buffer (OQ-29) | none | Render lateness, Decode, Device latency, Rate match ("50.00 fps → 60.00 Hz, 0 drops/min"), Late releases/min, Lateness trend (ms/min, labelled, no alarm: OQ-34); warning `queue-full` |
| audio-decoder | Sync Trim; Sync Method, Low-Latency Sync, Buffer, Sink Buffer (OQ-29) | none | Render lateness (when heard), Decode, Device latency, Clock ratio (ppm), device relocks |
| audio-output-302m | Lip-Sync Trim | none | As audio-decoder, plus the aligner rows Phase 2 added for its mixer arm |
| aes67-output | none | none | Egress lateness (Phase 0), unchanged |
| srt-input, rist-input, mpegts-ip-input, aes67-input, ts-splitter | Playout Offset | none (O and trims arrived in Phase 1) | Unchanged from Phase 1 |
| transcoder | Subtitle Sync Delay | none | Added latency now includes the cue wait when burn-in is on |
| every module | — | — | The `playout` status section and the `reanchor` badge are gone |

No output has an A/V offset display or a trim control (§13.1). No module
has a lateness alarm setting: Phase 0 deferred it (OQ-8), and the capacity
alarm is deferred with it (OQ-34, 2026-10-12); this phase adds no alarm
setting. The lateness trend is shown with a label (WI-P4-12).

Device Manager pages: none change. The Device Manager's release install is
the rollback path. The local control panel shows only what status sections
render; nothing to change.

### 9. Image and Yocto

- Yocto: `meta-layers/meta-custom/recipes-multimedia/gstreamer/gstreamer1.0-plugins-bad_%.bbappend`
  gains `SRC_URI += "file://0008-waylandsink-present-every-frame-and-presentation-feedback.patch"`
  after 0007, with a comment in the file's style. The patch adds the
  `presentation-time` protocol to the wayland library's protocol list;
  the XML is in `wayland-protocols`' `stable/` directory (present in
  1.45), which the build already uses for `xdg-shell` and `viewporter`.
- No new recipe. `mrvideopace` and the `mrasrc` device mode live in
  `libgstmrtshouse.so`, built and installed by the existing native steps
  (Yocto: `meta-layers/meta-custom/recipes-apps/media-router/media-router.bb:156–157, 166`).
  `mrtestaudiosink` is test-only and not installed.
- No service or config change. Weston's configuration (`/data/weston.ini`,
  read by `westonOutput.ts`) is untouched.
- The release is a RAUC image: the plugins-bad patch, the native set and
  the TypeScript builders must change together.

### 10. Telemetry and alarms

#### 10.1 New

| Name | Kind | Payload | Shown in |
|---|---|---|---|
| `mrvideopace` | element message, 2 s | `released`, `late`, `rate-drops`, `gaps-collapsed`, `content-fps-x100`, `refresh-ns`, `mean-hold-ns`, `present-lateness-ns` | video-player Timing |
| `waylandsink.display-stats` | property, read by `mrvideopace` | `presented`, `discarded`, `replaced`, `present-timeouts`, `refresh-ns`, `last-presented-ns`, `commit-to-present-ns` | via `mrvideopace` |
| `mrasrc-stats` (extended) | element message | `device-ppb`, `device-relocks`, `render-lateness-ns` | audio output Timing |
| `mrasrc-event relock-device` | element message | reason | journal |
| `queue_overrun` | plugin event, ≤ 1/s per queue | `element`, `levelTimeMs`, `levelBytes`, `leaky` | `queue-full` warning |
| `no-late-drop` | runner log line per pipeline | elements changed | journal |

#### 10.2 Alarms

| Alarm | Condition | Text | Never |
|---|---|---|---|
| Lateness (Phase 0) | deferred by the owner (OQ-8): Phase 0 shows the numbers, no alarm | — | — |
| `capacity` | deferred (OQ-34, 2026-10-12): the slope is shown as the `Lateness trend` row; the threshold idea (20 ms/min over 3 min, clearing below a quarter) is in the deferred-alarm note of chapter 4 part 13 | — | — |
| `queue-full` | any `queue_overrun` | "Queue name full at n ms — content lost at capacity" | — (the loss already happened at capacity) |
| ASRC ratio (Phase 1, now also outputs) | \|ratio\| > 200 ppm for 60 s | "Device clock off by n ppm" | drops |
| Display timeouts | `present-timeouts` rising | "Display not presenting (output off?)" | drops |

#### 10.3 Removed

Events `backlog_shed`, `playout_reanchor` (and the `rebase` kind);
`renderwatch` fields `retainedMs`, `budgetMs`, `latenessMs`, `shedding`,
`shedCount`; warnings `reanchor`, `rebase`; the `playout` status section
and the `reanchor` badge; the journal lines of `logBacklogShed`.

### 11. Verification on the test fleet

On 10.9.16.103 (Pi 5) and 10.9.16.108 (Pi 4), with the Phases 1–4 release
image (OQ-13),
each check under `MR_GST_RUNNER_NATIVE=1` and `=0` unless marked.

| # | What | How (tool or command class) | Pass |
|---|---|---|---|
| V-P4-1 | No video frame lost | Live 1080p50 H.264 (.108 hardware) and HEVC (both) for 1 h through a muxer to video-player; `mrvideopace` and `display-stats` counters from the journal | `replaced` = `discarded` = `rate-drops` = 0 at 50p on a 50 Hz mode; 0 other drops on a 60 Hz mode; achieved fps = content fps (render watch) |
| V-P4-2 | Stall and gap behaviour | Stop the producer's runner for 2 s (`systemctl --user kill -s STOP/CONT` on its unit), then cut the source for 3 s | Lateness +2 s ± 40 ms on video and audio outputs, zero frames/samples lost; after the cut, back to the pre-stall lateness ± 40 ms |
| V-P4-3 | Pi 5 software H.264 capacity | `cap-h264-1080p50-hi.ts` played from a file-backed producer into video-player on .103 for 1 h; `tools/runner-cpu-profile.sh` | Lateness slope < 2 ms/min (the `Lateness trend` row; no alarm, OQ-34). If it fails, the release notes name the limit (R-P4-5) |
| V-P4-4 | ASRC at the device | audio-output-302m to the .103 USB DAC and audio-decoder to .108's HDMI audio, 1 h each; `mrasrc-stats`; `pw-top` for xruns | Render-lateness drift < 5 ms over 1 h; ratio stable to ±2 ppm after 2 min; zero xruns after the prefill |
| V-P4-5 | A/V after a muxer | `cap-av-h264-aac-muxed.ts` route to video-player + audio-decoder; render lateness of both from the Timing sections; one listening/viewing check with a flash-and-beep test source | \|Δλ_render\| ≤ 45 ms, before and after V-P4-2's stall |
| V-P4-6 | Rate match | Video-player on a 60 Hz mode with 50p content, and a 50 Hz mode with 60p content (Weston output mode changed through the Device Manager); repeated with Weston stopped (kmssink, `refresh-mhz` from the CRTC mode) | 50p→60 Hz: 0 drops; 60p→50 Hz: rate-drops = 1/6 of frames ± 0.1 %; no other drops |
| V-P4-7 | Video-only player | Muxed A/V into video-player | `mrtsdemux` stats: one pad, zero audio PES |
| V-P4-8 | No late-drop settings anywhere | Runner `no-late-drop` log lines and `get_property` RPC on every sink and decoder of every running pipeline | No `qos=true`, no `max-lateness` ≠ −1, no `sync=true` on a presentation sink |
| V-P4-9 | Queue capacity fault | Throttle a video-player's decoder (CPU quota on the runner unit) until `vp_esq` fills | `Lateness trend` positive within 4 min (no `capacity` alarm, OQ-34); `queue-full` at overrun; pipeline never wedges |
| V-P4-10 | CPU and memory | `tools/runner-cpu-profile.sh` on video-player and both audio outputs; RSS with a 5 s backlog held | `mrvideopace` < 0.5 % of a core; `mrasrc` within Phase 1's budget (≤ 3 % per stereo stream on .108); RSS growth ≤ the byte caps |
| V-P4-11 | Settings and rollback | Manager: settings panels of every changed module; then Device Manager install of the Phase 0 release, and back | No removed control visible; after rollback the stored Lip-Sync Trim and Playout Offset values are in force again; after roll-forward they are ignored |

### 12. Risks specific to this phase

| # | Level | Risk | Design ref | Mitigation |
|---|---|---|---|---|
| R-P4-1 | M | **Outputs earlier at cut-over; talent loops shift.** Every output loses D (60 ms default, up to 10 s with overrides and raises). A microphone ingest whose O was set from a monitor's lateness now lags by the monitor's old D. | R12, S7, Q11 | Release notes (WI-P4-15) with the re-set instruction; each output shows its render lateness. |
| R-P4-2 | M | **Direct ingest → player routes lose A/V alignment.** Video can lead audio by up to ≈ 1 s. | R22 | Release notes list the route shape that needs a muxer; `scn-out-av-after-mux`. |
| R-P4-3 | M | **The waylandsink patch.** A wait in the streaming thread interacts with 0007's commit path, which already had two field-verified deadlocks. | R10 | Wait outside both locks; unlock on flush; 1 s timeout; 1 h restart stress on both boxes (WI-P4-2). |
| R-P4-4 | M | **Output ASRC quality.** pulsesink's clock is interpolated by pipewire-pulse; reading jitter or a wrong ratio drifts the ring by ε·t (50 ppm = 180 ms/h). | R5, S1 | Min-filter plus a 60 s loop; phase lock against the device clock; the drift bound in V-P4-4; a PipeWire-native sink (`pipewiresink` with `pw_time`) is the recorded alternative in ADR-0029 if pulsesink's clock is too noisy. |
| R-P4-5 | M | **Pi 5 software H.264 slower than real time.** Today the shedder and `max-lateness=1 s` hid a shortfall by dropping; now lateness rises without bound until `vp_esq` and the bus ingress fill. | R9, §8 "cannot keep up" | V-P4-3 before release; the `Lateness trend` row and the `queue-full` alarm; the decoder ladder prefers hardware; if V-P4-3 fails the release notes state the limit (1080p50 H.264 on a Pi 5) instead of hiding it. |
| R-P4-6 | M | **Backlogs persist.** A stall on a busy route keeps outputs late until a gap, which on a continuous feed may never come; operators may restart outputs to recover. | S10, R9, Q17 | The Timing section shows it; restart is the documented recovery; a catch-up is the §15 follow-up. |
| R-P4-7 | L | **Per-output gap rule changes A/V by up to min(backlog, gap)** when only one stream of a muxed program has a gap. | S10 | OQ-32; only with a backlog; recorded in ADR-0029. |
| R-P4-8 | M | **A late-drop default survives somewhere.** An element a bin plugs, or a future builder, reintroduces `qos` or a leaky queue. | R10 | Runner hook on every element; the lint (WI-P4-13); V-P4-8. |
| R-P4-9 | M | **Removed settings, nothing migrated.** Sites that trimmed lipsync per sink lose it with no output-side replacement. | R13 | Accepted (§13.1); release notes point to Ingest Offset and per-PID trim; stored values kept for rollback (OQ-33). |
| R-P4-10 | L | **Display off or DPMS** stops frame callbacks; without the timeout the player would back up. | — | 1 s timeout, counted, alarmed. |
| R-P4-11 | L | **Phase 3 boundary.** If Phase 3 shipped a different output ASRC shape, WI-P4-4 and WI-P4-7/-8 change. | R3 | C-6 fixes the boundary (custom slaving in Phase 3, timer evidence and `sync=false` here); the WIs reuse one `mrasrc` instance either way. |

### 13. Open questions

| # | Question | Why the design doc does not answer it | Blocks | Proposed default |
|---|---|---|---|---|
| OQ-29 | Are the video-player's `sync` and `bufferMs`, and the audio-decoder's `slaveMethod`, `lowLatencySync`, `bufferMs` and `sinkBufferMs`, removed in Phase 4? | Q9 names five settings; these six lose their mechanism (paced sink, skew slaving, jitter-queue sizing; `sinkBufferMs` is already ignored under the contract) but are not named. R13 and §13.1 answer it in principle ("each setting goes with the mechanism that used it"); this stays only as the §13.3 notice for operator-visible removals. | WI-P4-6, -7; part 8; release notes | **Remove** all six, nothing migrated. |
| OQ-30 | Do the bus ingress queue and the producer fan-out branch become non-leaky (`leaky=0`) at their 5 s capacity, as §8 and §11.3 item 7 say, or stay `leaky=2` as an alarmed resource-fault backstop? | §8 says leaky queues are "switched off or replaced" and §11.3 item 7 names "the 5 s edge queues"; R9 calls a full queue a resource fault. `busHelpers.ts:157–172` records that a non-leaky ingress wedged gate01, and with the patched `unixfdsink` (patch 0001: never blocks; skips and kicks a slow consumer) a non-leaky ingress only moves the loss to the producer, where it is reported. Keeping `leaky=2` is a deviation that changes where content loss is reported. | WI-P4-5, -13; part 4.4 | **Replace**: same 5 s / 40 MB capacity, `leaky=0`, `overrun` → `queue-full` resource alarm, loss at capacity reported at the producer's skip-and-kick. *Decided 2026-10-12 by the orchestrator (owner delegated), not the default: both queues stay `leaky=2` at their 5 s / byte-cap capacity as an alarmed resource-fault backstop, because the non-leaky variant reopens the gate01 deadlock of `busHelpers.ts:157–172`.* |
| OQ-24 | Who replaces the transcoder's `subhold` when `subtitleDelayMs` goes: Phase 3 (with the cue demux) or Phase 4 (an `mralignwatch` pace group between the overlay's video and cue inputs)? | Q9 removes the setting "with its mechanism", but the doc assigns neither the setting nor the overlay wait to a phase. (Shared with chapter 7's OQ-24, which plans it in Phase 3; one entry, default Phase 3.) | WI-P3-13, WI-P4-9 | **Phase 3** (WI-P3-13, `mralignwatch` pace group); WI-P4-9 then only verifies and deletes anything left. |
| OQ-31 | Is the audio prefill a fixed engine constant of 40 ms (plus the unchanged 100 ms ring), with no operator setting? | §8 says "a small prefill that rides out arrival jitter" without a value or an owner. | WI-P4-7, -8 | **Yes**, 40 ms, revisited from V-P4-4 data before release and recorded in ADR-0029. |
| OQ-32 | At a content gap, does each output independently let its lateness fall by up to the gap length, even when only one stream of a muxed program has the gap (shifting A/V by up to min(backlog, gap))? | §8 says latency comes down "at a gap in the content"; it does not say whose gap. | WI-P4-3, -4; R-P4-7 | **Yes**, per output. |
| OQ-33 | Are stored values of removed settings stripped from stored configs, or left and ignored? | §13.1 says "nothing is migrated" but not whether old keys are cleaned. | WI-P4-11; V-P4-11 | **Leave** them; a rollback then restores them. |
| OQ-34 | Is the `capacity` alarm "lateness slope > 20 ms/min for 3 min without a gap, clear below 5 ms/min", and is the threshold a module setting? | §8 asks for an alarm when an output falls behind steadily but gives no threshold; §9.5 says alarms are "at thresholds the operator sets", so a hard-coded value is at odds with it; §13.3 asks that operator-visible choices go to the owner. | WI-P4-12 | **Yes, as a module setting** `capacityAlarmMsPerMin` (default 20, 0 = off), the first alarm setting on a module since Phase 0's lateness alarm is deferred (OQ-8), clearing below a quarter of it. *Decided 2026-10-12 by the orchestrator (owner delegated), not the default: deferred like OQ-8; the slope is shown with a label, no alarm, no setting.* |

All seven were decided on 2026-10-12 by the orchestrator (owner delegated;
chapter 15.1): OQ-24, OQ-29, OQ-31, OQ-32 and OQ-33 at their defaults,
OQ-30 and OQ-34 against them (their rows say how); the items follow the
decisions. Two questions of the draft were closed during assembly because
the design answers them (chapter 15: C-6 the output ASRC boundary with
Phase 3, C-9 aes67-output's sink); the `subtitleDelayMs` question (OQ-24)
is one entry with chapter 7's.

### 14. Estimate

| WI | Added | Deleted | Days |
|---|---|---|---|
| P4-1 Behaviours pinned | 300 | 0 | 1.5 |
| P4-2 waylandsink 0008 | 450 | 0 | 5 |
| P4-3 `mrvideopace` | 1,150 | 0 | 5 |
| P4-4 `mrasrc` device mode | 700 | 0 | 4 |
| P4-5 Runner hooks | 450 | 0 | 3 |
| P4-6 video-player | 620 | 850 | 5 |
| P4-7 audio-decoder | 270 | 510 | 2.5 |
| P4-8 audio-output-302m | 180 | 380 | 1.5 |
| P4-9 Transcoder burn-in wait | 200 | 120 | 2 |
| P4-10 aes67-output audit | 60 | 0 | 0.5 |
| P4-11 Engine core and runner deletions | 160 | 7,100 | 3 |
| P4-12 Output lateness display, queue-full alarm | 500 | 60 | 2.5 |
| P4-13 R10 checklist and lint | 500 | 30 | 2 |
| P4-14 Fixtures and harness | 900 | 0 | 4 |
| P4-15 ADR, documents, release notes | 450 | 400 | 2 |
| P4-16 Gate verification | 200 | 0 | 3 |
| **Total** | **≈ 7,090** | **≈ 9,450** | **≈ 46.5** |

About 45 % of the added lines and 45 % of the deleted lines are tests. Of
the deletions, ≈ 3,250 production lines are §11.4's "Lateness handling" and
"Route-head D" rows (TypeScript ≈ 1,460, Python ≈ 1,020, C++ ≈ 770; the doc
estimates ≈ 2,900), ≈ 1,000 are plugin-side D, trim and hold code, and the
rest are their tests.

**Critical path** (two engineers, ≈ 26.5 working days):

1. Video track: WI-P4-1 (1.5 d) → WI-P4-2 (5 d, image build on both boxes)
   → WI-P4-3 (5 d) → WI-P4-6 (5 d) → WI-P4-11 (3 d) → WI-P4-14 video
   scenarios (4 d) → WI-P4-16 (3 d) = 26.5 d.
2. Audio track, in parallel: WI-P4-4 (4 d) → WI-P4-7 (2.5 d) → WI-P4-8
   (1.5 d) → WI-P4-12 (2.5 d) = 10.5 d.
3. Glue and settings, in parallel: WI-P4-5 (3 d), WI-P4-9 (2 d), WI-P4-10
   (0.5 d), WI-P4-13 (2 d), WI-P4-15 (2 d).

WI-P4-11 cannot start until WI-P4-6 to -9 no longer import D or the
shedder; WI-P4-2 needs one Yocto image build per box before WI-P4-3's gate
acceptance can run.

## 9. Phase 5 — Egress writer and Trust at network ingests

| Field | Value |
|---|---|
| Chapter | 9, work-item prefix P5 |
| Implements | §14 row 5: "Egress writer (TAI translation, PCR, descriptor); operator-selected Trust at network ingests, verified by the descriptor and the transit check" |
| Ships | Last, as its own release after the Phase 0 and Phases 1–4 releases (§13.1 Q1; OQ-13), once a route needs origin alignment and Phase 0's chrony is deployed in the field |
| Builds on | S0 (chapter 3: `ts_house`, `ts_packet`, `ts_pes`, `ts_pcr`, `ts_psi`, `libgstmrtshouse.so`, loaders, fixtures, `mrts_cli`); P0 (chapter 4: `HouseClock`, `HouseEpoch`, `TimeSyncState`, `mrlateness` `lat_egress`); P1 (chapter 5: `RestampCore`, `mrtsrestamp`, `ingestTiming.ts`, the bus gap marker of OQ-12, `.stct` traces, `PidTrimField` with `disabledReason`); P3 (chapter 7: `mrtsdemux`, formula demux in `aes67-output`); P4 (chapter 8: no late drops, `aes67-output` sink kept) |
| Code baseline | submodule `fc17468`; every path below was checked with `ls`/`grep` on 2026-10-12 |
| Paths | relative to the submodule (`meta-layers/meta-custom/recipes-apps/media-router/files/media-router`) unless marked "Yocto:" (relative to `/home/mrstation/media-router-yocto`) |

"§n" refers to `docs/house-clock-timing-design.md` v0.6. "S0 §n" and
"P1 §n" refer to the sibling plan sections.

### 1. Goal

Phase 5 puts house time on the wire and lets an operator keep it on the far
side. Every TS network egress (srt-output, rist-output, mpegts-ip-output)
gains one native element, `mrtsegress`, a user of the shared TS module. It
translates every PES PTS/DTS by the constant `+ E − 1 h` onto the TAI
timescale, writes a new PCR `H(emission) − D_e` on the program's PCR PID at
most 40 ms apart (inserting PCR-only packets where the PID is sparse), lets
D_e follow the lateness at the egress with every change flagged as a PCR
discontinuity, and declares all of this in a registration descriptor in the
PMT. On the receiving side, each network ingest (srt-input, rist-input,
mpegts-ip-input) gets an operator setting, Restamp (default) or Trust. A
Trust-selected ingest keeps the received PTS (`− E + 1 h` into the bus
representation) while the stream carries the descriptor, both ends declare
continuous discipline, and the transit check `0 ≤ arrival − (PCR + D_e) ≤
L + τ` holds; otherwise it restamps with an alarm and returns by itself. The
ingest offset and per-PID trim are disabled, with the reason shown, while
Trust is selected. This is the §14 row 5 deliverable: inter-engine lipsync
by construction, where Trust is selected (§9.3). aes67-output needs no TS
writer: it does no TS remux, and its RTP time is already the network
timescale after Phases 0 and 3 (part 3.2). Paced egress is deferred (§15);
this phase defines only its hook point.

### 2. Design references

| Ref | What Phase 5 implements |
|---|---|
| §4.2, §4.3 | `H = MONO + E`; network PTS `H mod 2^33`; the constant `E − 1 h` applied at network egress and at a trusted network ingest, nowhere else. |
| §4.4 | The network wrap at the same TAI instant on every synchronised device; receivers unwrap to the 2^33 period nearest their own clock (valid while lateness < 13 h). |
| §7 | PTS/DTS `+ E − 1 h`; `PCR = H(emission) − D_e` on the PCR PID, ≤ 40 ms apart, PCR-only packets where sparse; D_e = lateness at the egress plus the receiver's minimum buffer, from a starting margin; changes flagged with `discontinuity_indicator`; D_e lowered only at a gap; the PMT registration descriptor and its fields; unpaced egress (R17); TEMI not used. |
| §9.3, §9.4 | Trust buys origin alignment and costs every local aligner the link's transit; clock error ε enters D_e and lateness readings. |
| §10.2 | Trust needs continuous discipline on both ends and a set kernel TAI offset; the engine reads the daemon's state. |
| §10.3 | Untraceable start declared on the egress; automatic re-epoch is one flagged discontinuity on every network egress. |
| §10.4 | Restamp default; Trust per network ingest; three qualifying conditions; transit check with `L` = the input's transport latency and `τ` = 0.2 s default per input; fallback with an alarm naming the condition; automatic return; switches at gaps; no offset or trim on a trusted stream, controls disabled with the reason. |
| §13.1 (2026-10-12) | Per-egress PCR from the emission clock (the upstream-PCR alternative rejected); TAI at the boundary; Trust gated by the transit check, any continuous discipline (Q12); no offset on a trusted stream (Q13); automatic return (Q14); paced egress deferred (Q16); one shared TS module, no Python twin; every phase a cut-over. |
| §13.3 | Descriptor format: the engineer's choice, recorded in the ADR (part 4.3 fixes it). |
| §11.1 egress rows, §11.5 items 3 and 8 | The egress writer; the Trust and tolerance settings with transit and sync state shown beside them. |
| §15 last paragraph | Paced egress: not built; hook point only (part 4.7). |
| R2, R8, R11, R17, R19, R20, S2, S6, S9 | Part 12. |

### 3. Current state

#### 3.1 Network egress modules

All three forward the bus bytes unchanged and unpaced (§2, last bullet;
§11.1 egress row). No element touches PTS, DTS, PCR or PSI between
`unixfdsrc` and the network sink.

| Module | File (lines) | Pipeline today |
|---|---|---|
| srt-output | `plugins/srt-output/engine/SrtOutputModule.ts` (154; test 165) | `buildBusSrc ! buildBackpressureQueue(200, tsQueueByteCap(200)) [! buildTsRechunk(n)] ! srtsink name=sink uri=… sync=false wait-for-connection=false auto-reconnect=false` (`:124–134`). `latency` (`:76`) and `unpaced` → `maxbw=0` (`:103`) go into the URI. |
| rist-output | `plugins/rist-output/engine/RistOutputModule.ts` (253; test 409) | `buildBusSrc ! mrristsink name=ristsink urls=… profile=… buffer=… npd=…` (`:93–99`), no queue of its own; stats via `busReports` `mrrist-stats` (`:107`). |
| mpegts-ip-output | `plugins/mpegts-ip-output/engine/MpegTsIpOutputModule.ts` (204; test 196) | `buildBusSrc(name=busin) ! buildBackpressureQueue(200) [! tsparse alignment=7 set-timestamps=false] [! rtpmp2tpay] ! udpsink` or `tee` → one queued `udpsink` per destination (`:92–134`). Raw mode always re-chunks to 7 packets (`:108–111`). |

Helpers (all `packages/engine/src/plugins/`): `buildBusSrc`
(`busHelpers.ts:183`, `unixfdsrc ! queue leaky=2` 5 s / 40 MB);
`buildBackpressureQueue` (`tsHelpers.ts:115`); `buildTsRechunk`
(`tsHelpers.ts:131`, `tsparse alignment=N set-timestamps=false`);
`tsQueueByteCap` (`queueBounds.ts:49`); `buildNetUdpSink`
(`netUdpHelpers.ts:78`).

Facts that shape the writer, verified in source:

- **Bus memory is read-only.** `unixfdsrc` marks every received memory
  `GST_MEMORY_FLAG_READONLY` (gst-plugins-bad 1.28.2
  `gst/unixfd/gstunixfdsrc.c:408–412`). Mapping a whole buffer for write
  at the egress would copy it. The writer copies only the packets it changes
  (part 4.2 step 9); what it does copy is part of R11's cost.
- **Our producers' PSI and PCR cadence.** `mpegtsmux` writes PAT/PMT every
  100 ms and the PCR every 40 ms by default (`tsmux/tsmuxcommon.h:103–109`);
  `mr-tssplit` re-injects the PCR ≥ 10 ms apart and carousels PSI every 40
  packets (S0 part 3.1). A relayed foreign stream (ingest → egress) carries the
  source's cadence, mapped by Phase 1.
- **The wire PMT is a snapshot problem already solved.** `buildBusSink`
  strips `streamheader` caps (`busHelpers.ts:198–227`), so the PMT a
  receiver sees is the live in-band one, which the writer can rewrite.
- **Phase 0 placed `mrlateness name=lat_egress reference=running-time`
  before each sink** (P0 WI-P0-8); it reads GstBuffer PTS, which the writer
  does not change.

Comments and docs that state the pass-through, and go in this release
(part 6): `SrtOutputModule.ts:16`, `:113–122`; `MpegTsIpOutputModule.ts:24`,
`:100–104`; `tsHelpers.ts:125–130`; design doc `:138–140`, `:273–275`,
`:912`.

#### 3.2 aes67-output

`plugins/aes67-output/engine/Aes67OutputModule.ts` (352) sends RTP, not TS:
`buildBusSrc ! queue ! tsdemux latency=0 ! audio/x-smpte-302m ! avdec_s302m !
audioconvert ! audioresample ! <raw caps> ! rtpL24pay|rtpL16pay
[timestamp-offset=<TAI>] ! udpsink … sync=true max-lateness=-1
ts-offset=<senderLatencyMs>` (`:263–276`). There is no TS remux, so the TS
egress writer does not apply. Its RTP time is `timestamp-offset + running
time × 48000` (class comment `:33–51`):

- Phase 0 (P0 WI-P0-6) replaces the module's own epoch probe with the
  engine's E and restarts the module on a re-epoch;
- Phase 3 (P3 WI-P3-9) replaces `tsdemux` with `mrtsdemux`, so running time
  is content time;
- Phase 4 (P4 WI-P4-10, C-9) keeps its paced `udpsink`.

After those, RTP time = (content time + E) × rate, which is the network
timescale for RTP (§7 "AES67"). Phase 5 adds a gate check only (V-P5-11).

#### 3.3 Network ingests and their transport latency L

Phase 1 placed `mrtsrestamp name=restamp` directly after the transport
element and reads arrival at its chain entry (P1 part 4.1, OQ-19): the instant
the transport hands the packet over, after its recovery buffer. The transit
check (§10.4) needs `L`, the input's configured transport latency. Where it
lives today:

| Module | Setting (manifest) | Where it goes | Effective L | Source |
|---|---|---|---|---|
| srt-input | `latency` (`plugins/srt-input/package.json:51–53`, default 125 ms) | URI `latency=` (`SrtInputModule.ts:85,92`) | The **negotiated** TSBPD delay, `max(sender, receiver)`, which can exceed the setting | `srtsrc` stats `negotiated-latency-ms` = `msRcvTsbPdDelay` (gst-plugins-bad 1.28.2 `ext/srt/gstsrtobject.c:2075`; the sender value at `:2061` is overwritten by the receiver one in the same structure). Read today by `SrtStatPoller` (`packages/engine/src/plugins/srtHelpers.ts:139`, `'receive'` at `SrtInputModule.ts:39`), but not used. |
| rist-input | `buffer` (`plugins/rist-input/package.json:93–95`, "Retransmission Buffer", default 1000 ms) | `mrristsrc buffer=` (`RistInputModule.ts:117`) → folded into each URL as `buffer=` (`plugins/rist-core/native/mrrist/mrrist_common.cpp:58`, property `:241–242`) | The configured `buffer` | Config |
| mpegts-ip-input | `jitterMs` (`plugins/mpegts-ip-input/package.json:57–61`, default 200) | **Not the transport.** It sizes `buildBackpressureQueue(jitterMs)` *after* the Phase 1 restamp. RTP mode inserts a bare `rtpjitterbuffer` (`MpegTsIpInputModule.ts:187`) with GStreamer's default `latency` 200 ms (`gstrtpjitterbuffer.c:134`) | RTP: the `rtpjitterbuffer` `latency` (200 ms); raw UDP: 0 | Element default |

aes67-input's `ptpSync`
(`plugins/aes67-input/engine/Aes67InputModule.ts:199–238`) uses
`rtpjitterbuffer rfc7273-sync=true`: content lands on the sender's PTP
media clock. §5.4 calls that Trust. Phase 1 gave aes67-input the ingest
offset O (§5.5); nothing disables it under `ptpSync` (C-11).

#### 3.4 Time-sync state the engine has after Phase 0

`services.houseClock` (P0 part 4.2) gives `HouseEpoch { eNs, seq,
latchedAtMonoNs, traceable, reason, source: 'chrony'|'ptp'|'none',
taiOffsetS }` and `TimeSyncState` (`source`, `synced`, `traceable`,
`taiOffsetS`, `estErrorUs`, `maxErrorUs`, `freqPpm`, …). It has **no PTP
domain or grandmaster identity**, which the descriptor carries (§7). Where
they can be read without privilege:

- Yocto: `meta-layers/meta-custom/recipes-support/media-router-ptp/files/media-router-ptp-setup.sh:32,294`
  writes `PTP_DOMAIN=` to `/run/media-router-ptp/status.env`;
- linuxptp 4.4 (Yocto: `meta-layers/meta-openembedded/meta-oe/recipes-connectivity/linuxptp/linuxptp_4.4.bb`)
  opens a read-only management socket `/var/run/ptp4lro` with mode 0666 by
  default (`config.c:38–39,391–392` of the 4.4 source); our presets do not
  override it. The Device Manager already parses `pmc` output for
  `grandmasterIdentity` (Yocto:
  `meta-layers/meta-custom/recipes-apps/device-manager/files/api/src/config/PtpStatus.ts:283–299`,
  which queries the default read-write socket).

Live element properties are set through `GstPluginBase.setElementProperty`
(`packages/engine/src/plugins/GstPluginBase.ts:872`), which the child replays
after every restart. The native runner converts a JSON string with
`gst_value_deserialize` when the direct conversion fails
(`packages/engine/native/mr-gst-runner/commands.cpp:69–97`); the Python
runner sets a `str` property as is
(`packages/engine/src/child-process/gst-pipeline-runner.py:2266–2294`). E
(~1.8 × 10^18 ns) does not fit a JSON number exactly, so it travels as text.

#### 3.5 Manager UI support for disabled-with-reason

`packages/manager-ui/src/composables/useModuleSettingsForm.ts` (253) knows
`x-readOnly` and `x-showWhen` (`:30–31`, `:118–119`, `:143–145`, matcher
`packages/manager-ui/src/utils/showWhen.ts:7`), but no conditional disable.
Phase 1's `PidTrimField.vue` accepts a `disabledReason` prop (P1 WI-P1-14).
`packages/manager/src/plugins/manifestHelpText.test.ts` pins identical
wording for settings shared across plugins (ADR-0022).

#### 3.6 Mechanisms that go

None is a mechanism in code. The thing Phase 5 replaces, "egress forwards
the bus bytes unchanged", is an absence of code; what goes is the text that
asserts it (part 6). The existing module tests stay valid.

### 4. Target state

#### 4.1 Pipelines after the cut-over

| Module | Pipeline (changes in bold) |
|---|---|
| srt-output | `buildBusSrc ! buildBackpressureQueue(200, cap) ! **mrtsegress name=egress house-clock="…"** [! tsparse alignment=N set-timestamps=false] ! mrlateness name=lat_egress … ! srtsink …` |
| rist-output | `buildBusSrc ! **mrtsegress name=egress house-clock="…"** ! mrlateness name=lat_egress … ! mrristsink …` |
| mpegts-ip-output | `buildBusSrc(busin) ! buildBackpressureQueue(200) ! **mrtsegress name=egress house-clock="…"** [! tsparse alignment=7 set-timestamps=false] [! rtpmp2tpay] ! (lat_egress) ! udpsink`, or `… ! **mrtsegress** … ! tee` with one queued sink per destination |
| srt-input, rist-input, mpegts-ip-input | Phase 1's `… ! mrtsrestamp name=restamp clock-mode=stc **timing-mode=restamp\|trust transport-latency-ms=<L> trust-tolerance-ms=<τ> house-clock="…"** ! …` |

The writer sits after the queue and before any re-chunk, payloader or tee,
so it runs once per egress module and the re-chunk still slices whole
packets. It is the last element that reads time, so `H(emission)` is the
writer's clock reading; what follows (re-chunk, payloader, sink, the SRT
sender buffer) adds sub-ms to a few ms on a LAN, which the receiver's
transit bound absorbs.

#### 4.2 The writer, as a data path

`mrts::EgressCore` (new, `plugins/mpegts-core/native/mrts/ts_egress.{h,cpp}`)
holds everything that is not GStreamer. It uses only chapter 3's API; part
4.3 defines the one new codec it needs. Per input buffer, with `now =
clock_gettime(CLOCK_MONOTONIC)` read once per buffer and again per PCR
written:

1. `PacketWalker::feed` over the read-only input; `CcTracker::feed` per
   packet (counted, never repaired). Every rewrite below happens on a
   188-byte copy of the packet (step 9).
2. PAT → `PsiDiscovery::select_program` for every program; PMT packets →
   `PsiDiscovery::feed`. On a new PMT content (input version or bytes
   changed), the program's output PMT is rebuilt once with
   `build_pmt_section(program, pcr_pid_out, program_info_out, streams,
   version_out)`: `program_info_out` = the input `program_info` with any
   `MRHT` registration descriptor removed (`for_each_descriptor`,
   `registration_format`) and ours appended (part 4.3). Every input PMT
   packet is replaced by the cached output section, packetised with
   `packetise_section` on the writer's own CC counter for that PID. A PMT
   that grows by a packet inserts one; one that shrinks pads with stuffing
   in the last packet (the section is padded with 0xFF, CRC over the
   section only).
3. **PCR PID.** `pcr_pid_out` = the PMT's PCR_PID. When it is 0x1FFF (no
   PCR, e.g. a relayed source without one), the writer picks the first video
   ES PID, else the first audio ES PID, else the first ES, writes that into
   the output PMT and posts `pcr-pid-assigned` once.
4. On a packet with `pusi` on an ES PID: `parse_pes_header` (or
   `PesHeaderSpan` when `!complete`, holding at most one packet of that PID)
   → `pts' = bus_to_net(pts, epoch)`, `dts' = bus_to_net(dts, epoch)` →
   `rewrite_pes_timestamps`. A PES without PTS is untouched. For video and
   audio PIDs (stream-type class from the PMT), lateness
   `λ = now − house_from_mux_pts(dts ≥ 0 ? dts : pts, now)` feeds the D_e
   controller (part 4.4). Private PIDs (KLV, teletext, subtitles) are
   rewritten but do not drive D_e: their PTS is cue time, not decode time.
5. On a packet of `pcr_pid_out` with `af_pcr`: `write_pcr(v,
   net_pcr27(H, D_e))` with `H = now_pcr + E` (clock re-read for each PCR so
   PCRs in one buffer increase); `PcrScheduler::saw_pcr(now)`. PCR fields
   on other PIDs are rewritten the same way (never removed).
6. `PcrScheduler::due(now)` is checked at the buffer head and before each
   packet; when due, a PCR-only packet `build_pcr_packet(pcr_pid_out,
   net_pcr27(H, D_e), sched.cc(), disc, out)` is inserted before the next
   packet. `pcr-interval-ms` default 35 (≤ 40, §7). The CC of an AF-only
   packet repeats the PID's last payload CC (S0 `PcrScheduler::cc`).
7. **Discontinuities.** On a D_e change or a re-epoch (part 4.5), the
   writer: (a) bumps the output PMT version and emits the new PMT at once,
   before anything else of that program in this buffer; (b) inserts a
   PCR-only packet with `discontinuity_indicator` = 1 carrying the new
   `H − D_e`; (c) applies the new E to every PES header from the next
   `pusi` on. Ordered transports (SRT, RIST) deliver the new PMT before the
   flagged PCR, so a receiver pairs every PCR with the D_e that produced it.
8. **Bus gap markers** (P1 OQ-12: a GAP|DISCONT-flagged buffer of
   adaptation-only packets, PTS = the gap's end, the gap length in the
   adaptation field's private data) are
   consumed as gap signals for the D_e controller and **not sent**: they
   carry no payload and no PCR, and a third-party receiver has no use for
   them. A bus silence of ≥ `gap-lower-min-ms` (500) between buffers also
   counts as a gap.
9. Output: the input is never written. Each packet that changes (a PES
   header, a PCR, a PMT, a header span) is copied into a new 188-byte
   memory and rewritten there; inserted packets are new memories too. The
   output buffer is spliced from read-only regions of the input
   (`gst_buffer_copy_region`, which shares memory) and the new memories
   (`gst_buffer_insert_memory`), so payload bytes are never copied (part
   3.1). A buffer that would pass GStreamer's 16-memory limit is merged,
   one copy, counted as `merged-buffers` (expected only on chunks holding
   many PES headers). GstBuffer PTS, DTS, duration and flags are kept; the
   bus gap marker buffers are dropped.

`EgressCore` handles every program in the PAT (bus streams are SPTS, but a
relayed MPTS ingest is not). D_e is per program.

#### 4.3 The house-time descriptor (§7, §13.3 engineer's choice)

A `registration_descriptor` (ISO/IEC 13818-1 clause 2.6.8, tag 0x05) in
the PMT's `program_info` loop, so it applies to the whole program. New
`plugins/mpegts-core/native/mrts/ts_hcdesc.{h,cpp}`: `struct
HouseTimeDecl`, `encode(const HouseTimeDecl&, uint8_t out[26])`,
`bool decode(const uint8_t*, int len, HouseTimeDecl*)`, `find_in(const
std::vector<uint8_t>& program_info)`.

| Byte | Field | Bits | Value |
|---|---|---|---|
| 0 | `descriptor_tag` | 8 | 0x05 |
| 1 | `descriptor_length` | 8 | 24 (version 1) |
| 2–5 | `format_identifier` | 32 | `'MRHT'` = 0x4D524854 (OQ-37) |
| 6 | `hc_version` | 8 | 1 |
| 7 | `flags` | 8 | b7 `house_time_tai`: PTS/DTS are `H mod 2^33` and PCR is `H(emission) − D_e` (0 when the engine has no E). b6 `disciplined`: the sender's daemon is synchronised and runs continuous discipline (chrony or PTP). b5 `traceable`: E was latched while synchronised with the kernel TAI offset set (`HouseEpoch.traceable`). b4 `ptp_valid`: bytes 10–18 are meaningful. b3–b0 reserved, `1111`. |
| 8 | `sync_source` | 8 | 0 none, 1 NTP (chrony), 2 SNTP, 3 PTP; others reserved |
| 9 | `tai_utc_offset_s` | 8 | The sender's kernel TAI−UTC (37 in 2026); 0 = unset |
| 10 | `ptp_domain` | 8 | 0–127; 0xFF when `ptp_valid` = 0 |
| 11–18 | `grandmaster_identity` | 64 | EUI-64 `clockIdentity` from `PARENT_DATA_SET`; all ones when `ptp_valid` = 0 |
| 19 | `clock_error_class` | 8 | `ceil(log2(max(1, err_us)))`, i.e. the estimated clock error is ≤ 2^class µs; 0xFF unknown. `err_us` = `estErrorUs` (chrony), or `max(estErrorUs, |offsetFromMaster| / 1000)` under PTP |
| 20–21 | `epoch_seq` | 16 | `HouseEpoch.seq mod 65536`: a receiver sees a re-epoch |
| 22–25 | `d_e` | 32 | D_e in 90 kHz ticks (max 13.2 h) |

Rules:

- A decoder reads the fields it knows and ignores trailing bytes, so a later
  `hc_version` can append fields without breaking version 1 receivers.
- The writer bumps the output PMT `version_number` (mod 32) when any field
  changes. Fields that move continuously are quantised so the PMT changes
  rarely: the error is a power-of-two class with a 10 s hold before a class
  change is published; D_e changes only by raises (≥ 130 ms apart in
  value, part 4.4) and at gaps.
- GStreamer's `tsdemux` treats a PMT whose ES set and PCR PID are unchanged
  as the same program (`mpegtsbase.c:837–880`, `:1227–1229`, `:1285–1288`
  in 1.28.2), so third-party GStreamer receivers do not re-pad on our
  version bumps. Our own `mrtsdemux` must do the same (WI-P5-4).
- TEMI (§7) is not used: the 33-bit PTS is unambiguous within ±13 h.

#### 4.4 D_e: the egress delay controller

`mrts::EgressDelay` (in `ts_egress.h`), one per program. All values ns.
Constants are element properties with these defaults; they are the
engineer's choice, recorded in ADR-0029 (the timing ADR created in S0/P1,
`docs/adr/0029-house-clock-timing.md`):

| Property | Default | Meaning |
|---|---|---|
| `d-e-margin-ms` | 150 | The receiver's minimum buffer above the lateness (§7). |
| `d-e-headroom-ms` | 20 | Raise when `λ > D_e − headroom`. |
| `d-e-floor-ms` | 100 | D_e never goes below this. |
| `d-e-max-ms` | 0 (none) | The R17 bound; OQ-36: hook only, no setting. |
| `gap-lower-min-ms` | 500 | A bus silence this long counts as a gap. |

- **Start:** `D_e = max(floor, λ_first + margin + |ε|)` rounded up to 10 ms,
  where `λ_first` is the lateness of the program's first timed audio/video
  PES and `|ε|` the local clock error (`err_us`, capped at 50 ms; §9.3 "D_e
  must include |ε|"). Until that PES, PCRs are written with `D_e = floor +
  margin` and the start value is applied with the first PES, flagged. No
  receiver has locked by then.
- **Raise (P11):** on any PES with `λ > D_e − headroom`, `D_e = λ + margin +
  |ε|`, rounded up to 10 ms. Each raise is ≥ `margin − headroom` = 130 ms,
  so a lateness that creeps up cannot cause a raise per frame. Event
  `d-e-raise`, flagged PCR discontinuity (part 4.2 step 7). Nothing is
  dropped.
- **Lower:** only at a gap of length `g` (marker or silence): `target =
  max(floor, λ_next + margin + |ε|)` from the first PES after the gap; if
  `target < D_e`, `D_e = max(target, D_e − g)`. Lowering by no more than the
  gap keeps a receiver's buffer from running dry, because it held no content
  for `g` anyway. Event `d-e-lower`, flagged.
- **Max:** when `d-e-max-ms` > 0 and a raise would pass it, D_e stays at the
  max, event `d-e-max` once per episode, and content reaches receivers with
  `PTS − PCR` below the margin. Still nothing is dropped.
- **Not a catch-up.** D_e comes down only at gaps (§7, §15 "Network
  egress").

#### 4.5 Epoch on the wire

- `epoch` = (E, seq) from the `house-clock` property (part 4.6). `bus_to_net`
  = `(pts + e_90k − MUX_CLOCK_BASE_90K) mod 2^33` (S0 WI-S0-1), so the wire
  PTS is `(MONO + E) mod 2^33 = TAI × 90 kHz mod 2^33`. The PCR is
  `ns_to_pcr27(H − D_e)` mod `300 × 2^33`. **Both wrap at the same TAI
  instant on every synchronised device**, every 95,443.718 s. For example,
  with TAI−UTC = 37 s, the next wraps after 2026-10-12 are at
  2026-10-13T02:58:38.9Z, 2026-10-14T05:29:22.6Z and
  2026-10-15T08:00:06.3Z (computed as `ceil(TAI_s × 90000 / 2^33) × 2^33 /
  90000 − 37`). A box whose kernel TAI offset is unset wraps 37 s later;
  that is what the transit check catches (part 4.8).
- **Unknown E** (no `mr-clockstate`, a dev host; P0 WI-P0-4 "missing
  sidecar"): the writer uses E = 0 and declares `house_time_tai = 0`,
  `traceable = 0`. No receiver can trust it; third-party receivers play it.
- **Untraceable start** (P0's 30 s timeout): E is used, `traceable = 0`.
- **Re-epoch** (seq changes): part 4.2 step 7. The wire PTS steps by ΔE
  once, flagged; `epoch_seq` changes in the descriptor.
- **Receiver unwrap** (§4.4): a Trust ingest computes every comparison in
  signed, wrap-folded 33-bit space against its own network time,
  `fold33(a − b)` (S0 `fold33`), valid while |lateness| < 13 h. The bus
  side needs no unwrap: `net_to_bus` is a constant mod 2^33 and the bus
  consumers unwrap near local uptime as before.

#### 4.6 How E and the sync state reach the elements

One string property, `house-clock`, on `mrtsegress` and `mrtsrestamp`: a
serialised `GstStructure`, parsed with `gst_structure_from_string` under the
object lock and applied at the next buffer:

```
house-clock, e-ns=(gint64)1760283215123456789, seq=(uint)3,
  traceable=(boolean)true, disciplined=(boolean)true, source=(string)ntp,
  error-us=(uint)1200, tai-offset-s=(int)37, ptp-domain=(int)-1,
  gm=(string)""
```

- Engine: `houseClockGstString(epoch: HouseEpoch | null, state:
  TimeSyncState): string` in new
  `packages/engine/src/clock/houseClockProperty.ts`; the value is put in the
  pipeline string at build (quoted with `quoteGstString`) and pushed live by
  `GstPluginBase.bindHouseClock(elementNames)` on `houseClock.on('epoch')`
  and on `on('state')` when a field the descriptor carries changes
  (error compared by class). The runner replays it after restarts
  (`GstPluginBase.ts:865–871`).
- PTP fields: `TimeSyncState` gains `ptp?: { domain: number; gmIdentity:
  string; offsetNs: number }`, read every 10 s while `source = 'ptp'` by new
  `packages/engine/src/clock/ptpStatus.ts`: `PTP_DOMAIN` from
  `/run/media-router-ptp/status.env`, then `pmc -u -b 0 -s /var/run/ptp4lro
  -d <domain> 'GET PARENT_DATA_SET' 'GET CURRENT_DATA_SET'` (absolute path
  of `pmc` resolved once), parsed for `grandmasterIdentity` and
  `offsetFromMaster`. A failure leaves `ptp` undefined and `ptp_valid = 0`.

#### 4.7 Paced egress: the hook point only (§15)

Not built. The writer is the one place that knows, per output packet, the
send time its PCR implies (`PCR + D_e`). It sets no GstBuffer timestamps
today. A paced mode would set each output buffer's PTS to that implied time
in running time and switch the sink to `sync=true`; nothing upstream would
change. ADR-0029 records the hook; no property, no code path.

#### 4.8 Trust at a network ingest

`mrts::TrustGate` (new `plugins/mpegts-core/native/mrts/ts_trust.{h,cpp}`),
one per program inside `RestampCore` (P1 WI-P1-3), which gains a second
mapping kind. Inputs per program: the decoded `HouseTimeDecl` from the
current PMT (`find_in` on `program_info`); every PCR on the PCR PID with its
arrival; the local `house-clock`; `L` and `τ`.

**Transit**, per PCR (§10.4), all in 90 kHz with wrap folding:

```
a      = ns_to_pts90k(arrival_mono + E_rx)        receiver's network time
p      = PCR / 300                                 sender's H(emission) − D_e
transit = fold33(a − (p + decl.d_e))      nearest the receiver's clock
lo     = −(20 ms + 2^decl.clock_error_class µs + local error)
hi     = L + τ
```

**Qualifies** while all hold: (1) a `MRHT` descriptor with
`house_time_tai = 1` is in the current PMT and the PMT was seen within the
last 1 s; (2) `decl.disciplined = 1` and the local `disciplined = true` with
a known E; (3) `lo ≤ transit ≤ hi`. Condition (3) fails after 3 consecutive
PCRs out of bounds (≈ 105 ms at the writer's 35 ms cadence), so one late PCR on
a retransmission does not flap the mode. `failed` names the first failing
condition: `no-descriptor`, `not-house-time`, `sender-undisciplined`,
`local-undisciplined`, `transit-high`, `transit-negative`.

**Mapping in Trust:** every PES PTS/DTS and every PCR of the program is
`net_to_bus(value, E_rx)`, a constant mod 2^33. `PTS − PCR` on the bus is
the sender's `D_e − λ_egress`, positive. O and the per-PID trim are not
applied in any state while Trust is selected (Q13: "while an ingest is
Trust-selected: trust means untouched", so a fallback under a Trust
selection has no O or trim either; C-10). Phase 1's per-ES monotonic guard,
gap markers and CC renumbering stay in force, so no switch ever moves a
PID's PTS backwards on the bus (R18).

**States**, per program (constants in ADR-0029; OQ-35 and OQ-39 decided
2026-10-12, OQ-35 as a blend):

| State | Entered | Mapping | Leaves |
|---|---|---|---|
| `restamp` | `timing-mode=restamp` | STC (Phase 1) + O + trims | operator selects Trust → `qualifying` |
| `deciding` | Trust selected at stream (re)start | none yet: output held, ≤ 1 s or 4 MB (OQ-39) | PMT with descriptor + 5 PCRs judged: qualified → `trust`; not, or 1 s → `fallback` |
| `qualifying` | operator selects Trust mid-stream | STC (no O, no trims) | 2 s continuously qualified → switch at the next natural gap, or at once after 30 s without one → `trust` + event (OQ-35) |
| `trust` | — | `net_to_bus` | disqualified → switch at once, the switch being the gap → `fallback` + alarm (OQ-35); operator selects Restamp → switch at the next natural gap, or at once after 30 s → `restamp` + event |
| `fallback` | — | STC (no O, no trims; Q13) | 10 s continuously qualified → `returning` |
| `returning` | — | STC | switch at the next natural gap (re-lock, outage, sender re-epoch), or at once after 30 s without one → `trust` + event (OQ-35) |

**A switch** is a mapping change applied per PID at its next `pusi`,
through the same code path as Phase 1's live O edits (P1 part 4.4): new PTS
after the PID's last emitted → a gap marker; new PTS not after it → the
guard drops the overlap. Going to Restamp leaves a gap of about the
transit; going to Trust drops about the transit (§10.4). Each switch posts
`trust-switch` with `gap-ns` or `overlap-ns`. When a switch is taken
(OQ-35, decided 2026-10-12 as a blend; §10.4): a fallback to Restamp at
once, the switch being itself the gap; a return to Trust and an operator's
mode change wait up to 30 s for a natural gap (`return_gap_wait_ns`), then
switch at once; every switch raises an event.

**Sender re-epoch** (a flagged PCR discontinuity and a new `epoch_seq`): the
`net_to_bus` constant does not depend on the sender's E, so the received PTS
step passes onto the bus as a gap or a dropped overlap, and the transit check
judges the new PCRs. **Receiver re-epoch** (`house-clock` seq changes): the
constant changes by ΔE_rx, applied as a switch at each PID's next `pusi`.

**In Restamp mode** the gate still runs when a descriptor is present, for
display only (S6: "show the link's measured transit and whether the stream
qualifies, so the choice is informed").

**L per module** (part 3.3), pushed live as `transport-latency-ms` by the
module: srt-input → `negotiated-latency-ms` from `srtsrc` stats (max over
callers in listener mode), the `latency` setting until the first stats
poll; rist-input → `buffer`; mpegts-ip-input → 200 in RTP mode (the
`rtpjitterbuffer` default, read from the element's `latency` property at
start), 0 in raw mode (OQ-38). `τ` = `trustToleranceMs` (default
200, §13.1 Q12). With SRT latency 2,000 ms the bound is 2.2 s, as §10.4
states.

#### 4.9 What the operator gets

- Network ingests: **Timing Mode** (Restamp | Trust) and **Trust Tolerance**
  (ms, shown in Trust only). In Trust, Ingest Offset and Per-PID Trim are
  greyed with the reason beside them. A **Trust** section shows the mode in
  effect, the failed condition, transit min/median/max against the bound
  `L + τ` with `L`'s source, and the sender's declaration. In Restamp, the
  same section shows whether the stream would qualify.
- Network egress: the `timing` section (Phase 0) gains D_e, its changes,
  the PCR interval actually achieved and the network-time declaration.

### 5. Work items

Ordered by dependency. Estimates are lines of source at this repo's comment
density (±40 %) and engineer-days including review. Two chains run in
parallel after WI-P5-1: the writer (WI-P5-2, -3, -10) and Trust (WI-P5-6,
-7, -8, -11).

#### WI-P5-1 `ts_hcdesc`: the house-time descriptor codec

- **What.** Encode and decode the descriptor of part 4.3.
- **Where.** New `plugins/mpegts-core/native/mrts/ts_hcdesc.{h,cpp}`; test
  `plugins/mpegts-core/native/mrts/tests/ts_hcdesc_test.cpp`; `mrts/Makefile`
  (add to `libmrts.a`).
- **How.** `struct HouseTimeDecl { uint8_t version; bool house_time_tai,
  disciplined, traceable, ptp_valid; uint8_t sync_source, tai_utc_offset_s,
  ptp_domain, clock_error_class; uint64_t gm_identity; uint16_t epoch_seq;
  uint32_t d_e_90k; }`. `encode(decl, out[26])`; `decode(data, len, &decl)`
  accepts `descriptor_length ≥ 24` and ignores trailing bytes, rejects
  < 24; `find_in(program_info)` walks with S0's `for_each_descriptor` and
  `registration_format == 'MRHT'`; `strip_from(program_info)` returns the
  loop without any `MRHT`. `error_class(err_us)` = `ceil(log2(max(1,
  err_us)))`, saturating at 31; 0xFF unknown. `parse_gm("2ccf67.fffe.76e669")`
  accepts the `pmc` spelling and colon/dash forms.
- **Acceptance.** Round trip of every field at its limits; a version-2
  descriptor (length 30) decodes as version 1's fields; length 23 rejected;
  `strip_from` removes two `MRHT` and keeps a `KLVA` registration and an
  ISO 639 descriptor byte-identical; `error_class(1200) == 11`.
- **Estimate.** 180 + 200 test; 1.5 days. Depends on S0 WI-S0-5.

#### WI-P5-2 `mrts::EgressCore` and `EgressDelay`

- **What.** The writer's data path (part 4.2), the D_e controller (part 4.4)
  and the epoch handling (part 4.5), with no GStreamer.
- **Where.** New `plugins/mpegts-core/native/mrts/ts_egress.{h,cpp}`; tests
  `plugins/mpegts-core/native/mrts/tests/ts_egress_test.cpp` and
  `ts_egress_replay_test.cpp` (replays the fixtures of part 7.2 against
  their `.expect.jsonl`).
- **How.**
  - `struct EgressConfig { int64_t pcr_interval_ns; int64_t margin_ns,
    headroom_ns, floor_ns, max_ns, gap_lower_min_ns; }`.
  - `struct ClockDecl { NetEpoch epoch; uint32_t seq; bool known,
    traceable, disciplined; uint8_t source, tai_offset_s, ptp_domain;
    uint64_t gm; uint32_t error_us; }` (filled from `house-clock`).
  - `class EgressCore { Result process(const uint8_t* data, size_t len,
    int64_t now_mono_ns, const ClockReader& clk); void
    set_clock(const ClockDecl&); void on_gap(int64_t pts_ns, int64_t
    dur_ns); Stats stats(int program) const; std::vector<Event>
    take_events(); }`. The input is `const`; `Result` is an edit list,
    `{packet index, replace | insert-before, bytes[188]}`, so the element can
    splice memories without moving payload (part 4.2 step 9). S0's
    `rewrite_pes_timestamps` and `write_pcr` run on the 188-byte copy.
    `ClockReader` is injected so tests control `now` per PCR.
  - Per program: `PsiDiscovery`, `PesHeaderSpan`, `PcrScheduler`,
    `EgressDelay`, output PMT cache (`build_pmt_section` +
    `packetise_section`), writer PMT CC, `version_out`, PCR PID map,
    the last published `HouseTimeDecl`, a `CcTracker` for counters.
  - `EgressDelay { void on_pes(int64_t lateness_ns); void on_gap(int64_t
    g_ns); int64_t d_e() const; bool changed(); }` per part 4.4.
  - Re-epoch and D_e change sequence per part 4.2 step 7.
  - Events: `d-e-start`, `d-e-raise`, `d-e-lower`, `d-e-max`,
    `re-epoch`, `pcr-pid-assigned`, `pmt-grew`, `cc-lost-in`.
- **Acceptance (`ts_egress_test`).**
  - Every PES PTS/DTS out equals `bus_to_net(in)` for E = boot + 37 s and
    for E placing the wire wrap inside the fixture (`syn-wrap-33bit.ts`);
    B-frame DTS stays behind PTS across the wrap.
  - Header split (`syn-pes-header-split.ts`) rewritten, other PIDs not
    delayed.
  - PCR interval on the PCR PID ≤ `pcr-interval-ms` for every buffer
    gap ≤ that interval, on `syn-egress-sparse-pcr.ts` (audio-only, PCR
    PID = audio PID, PES 64 ms apart); inserted packets are AF-only with
    the PID's last CC; an output `CcTracker` reports no loss.
  - PCR PID 0x1FFF (`syn-egress-no-pcr-pid.ts`): video PID chosen, PMT
    rewritten, CRC valid, one `pcr-pid-assigned`.
  - D_e: start from the first PES; a lateness ramp 100 → 900 ms gives raises
    ≥ 130 ms apart, each with a new PMT version before a flagged PCR;
    `DTS − PCR` (PTS where no DTS) ≥ `headroom` for every PES after the
    first, against the PCR in force when it was sent; a 2 s
    gap marker lowers D_e by at most 2 s; `d-e-max-ms` holds and posts one
    `d-e-max`.
  - Descriptor: present once in `program_info` even when the input carried
    an `MRHT` (relay); `epoch_seq` and the PMT version change on re-epoch;
    the error class change is held 10 s.
  - Output bytes identical to input outside PTS/DTS/PCR fields, PMT packets,
    inserted packets and dropped gap-marker packets; the input array is
    unchanged after `process` (it is `const`).
- **Estimate.** 900 + 800 test; 8 days. Depends on WI-P5-1, S0 WI-S0-1…5.

#### WI-P5-3 The `mrtsegress` element

- **What.** The GStreamer face of `EgressCore`.
- **Where.** New `plugins/mpegts-core/native/mrtshouse/gstmrtsegress.cpp`,
  registered in `gstmrtshouse.cpp`'s factory table (S0 WI-S0-7; the file
  name is S0 part 4.1's); harness test
  `packages/engine/src/child-process/gst_mrtsegress_element_test.py`
  (appsrc → element → appsink, the `gst_mrtsstamp_element_test.py`
  pattern; a test harness, not a twin, S0 part 4.5 rule 1).
- **How.** Plain `GstElement`, always pads, `chain` and `chain_list` (a
  list is processed buffer by buffer and pushed as a list, as `mrlateness`
  does). Properties: `house-clock` (string, live, part 4.6);
  `pcr-interval-ms` (uint 10–40, default 35); `d-e-margin-ms` (150),
  `d-e-headroom-ms` (20), `d-e-floor-ms` (100), `d-e-max-ms` (0),
  `gap-lower-min-ms` (500); `stats-interval-ms` (2000); read-only `stats`
  (`GstStructure`), `d-e-ns` (int64), `epoch-seq` (uint). Output per part
  4.2 step 9. A buffer flagged GAP is consumed (`on_gap(pts, duration)`) and
  dropped. Element messages from the streaming thread:
  `mrtsegress-stats` (one per program per interval: `program`, `pcr-pid`,
  `d-e-ns`, `lateness-min-ns`, `lateness-mean-ns`, `lateness-max-ns`,
  `pcr-written`, `pcr-inserted`, `pcr-interval-max-ns`, `pmt-rewritten`,
  `packets`, `bytes-in`, `bytes-out`, `epoch-seq`, `traceable`,
  `merged-buffers`, `proc-ns-per-packet` sampled on one buffer in 64),
  and
  `mrtsegress-event` (`kind` and the fields of part 10). No Python fallback;
  without the plugin the egress starts with `identity` in the writer's
  place and carries the rule-6 alarm — the wire then carries bus time with
  no descriptor, which a Trust receiver treats as an old engine (S0 part
  4.5 rule 6, C-1).
- **Acceptance.** `gst_mrtsegress_element_test.py`: bytes equal
  `EgressCore`'s for the same input and injected clock; a list of 7 stays a
  list; a GAP buffer is not output and lowers D_e; a live `house-clock`
  with seq + 1 produces a new PMT and a flagged PCR before the next PES;
  changed and inserted packets are separate memories and the untouched
  regions share the input's memory (`gst_buffer_n_memory`,
  `gst_memory_is_span`); a read-only input buffer is never mapped for
  write.
  `gst-inspect-1.0 mrtsegress` lists every property.
- **Estimate.** 450 + 300 test; 4 days. Depends on WI-P5-2, S0 WI-S0-7/8.

#### WI-P5-4 Same-program rule for PMT version bumps

- **What.** A PMT whose ES set (PID, stream_type) and PCR PID are unchanged
  is the same program, whatever its version or `program_info`. The writer
  bumps the version on every D_e change and re-epoch (part 4.3), and the
  bumps reach every consumer through a receiving engine's ingest.
- **Where.** `plugins/mpegts-core/native/mrts/ts_psi.{h,cpp}`
  (`PsiDiscovery` gains `es_generation()`, bumped only on an ES-set or PCR
  PID change, beside S0's `generation()`); `mrtsdemux`
  (`plugins/mpegts-core/native/mrtshouse/gstmrtsdemux.cpp`, chapter 7
  §4.1 step 5) and `RestampCore` (`ts_restamp.cpp`, P1 part 4.2 step 2) switch
  to it.
- **How.** Same comparison as `mpegts_base_is_same_program` (1.28.2
  `mpegtsbase.c:837–880`). The demux keeps pad names and posts no
  `pad-removed`; the restamp keeps its PID table and does not re-lock.
- **Acceptance.** `ts_psi_test.cpp` case: three PMT versions differing only
  in an `MRHT` descriptor → `generation()` 3, `es_generation()` 1. Section
  04's `mrtsdemux-pmt-change` protocol case still re-pads on the real codec
  change (`bus-pmt-change.gdp`); a new case `mrtsdemux-pmt-version-only`
  (both runners) sees no pad change over `wire-mrht-de-raise.ts`.
- **Estimate.** 60 + 120 test; 1 day. Depends on S0 WI-S0-5; touches
  Phase 3's element (see caveat in part 12).

#### WI-P5-5 `mrts_cli` verbs: `pcrcheck`, `hcdesc`, `dump --net`

- **What.** The measuring tools for parts 7 and 11.
- **Where.** `plugins/mpegts-core/native/mrts/mrts_cli.cpp`.
- **How.** `pcrcheck <file.ts> [--arrival file.stct]` prints JSON lines per
  program: PCR interval histogram and max (TR 101 290 PCR_repetition, 40
  ms), PCR jumps with and without `discontinuity_indicator`
  (PCR_discontinuity), per-PES `DTS−PCR` and `PTS−PCR` minimum (must stay
  > 0), CC errors, PMT CRC errors, and, with arrival times, PCR jitter
  against arrival. `hcdesc <file.ts>` decodes every `MRHT` it sees with
  the PMT version. `dump --net E_ns` prints S0's PES index with PTS also
  mapped `net_to_bus`, for comparing a wire capture with a bus capture.
- **Acceptance.** On the writer's golden outputs, `pcrcheck` reports zero
  violations; on a fixture with a hand-made unflagged PCR jump it reports
  one.
- **Estimate.** 250 + 80 test; 1.5 days. Depends on WI-P5-1, S0 WI-S0-6.

#### WI-P5-6 `mrts::TrustGate`

- **What.** The three conditions, the transit check and the per-program
  state machine of part 4.8, with no GStreamer.
- **Where.** New `plugins/mpegts-core/native/mrts/ts_trust.{h,cpp}`; test
  `plugins/mpegts-core/native/mrts/tests/ts_trust_test.cpp`.
- **How.** `struct TrustConfig { int64_t l_ns, tau_ns, neg_base_ns = 20 ms;
  int bad_pcrs = 3; int64_t decide_max_ns = 1 s, decide_max_bytes = 4 MB,
  qualify_ns = 2 s, return_qualified_ns = 10 s, return_gap_wait_ns = 30 s,
  pmt_stale_ns = 1 s; }`. `class TrustGate { void on_pmt(const
  HouseTimeDecl*, int64_t arrival); void on_pcr(int64_t pcr27, bool disc,
  int64_t arrival_mono); void on_natural_gap(); void set_mode(Mode);
  void set_clock(const ClockDecl&); void set_l(int64_t); void
  set_tau(int64_t); Decision step(int64_t now); Stats stats() const; }`.
  `Decision` ∈ {`hold`, `release-restamp`, `release-trust`,
  `switch-to-trust`, `switch-to-restamp`, `none`}. Transit and bounds per
  part 4.8, in `fold33` space; median by a 64-sample ring.
- **Acceptance.** Synthetic sequences: ok at transit 1.9 s with L = 2 s;
  fallback at 2.3 s after exactly 3 PCRs, `failed = transit-high`; TAI
  offset unset on the sender (its H 37 s behind, transit ≈ +37 s) →
  `transit-high`; unset on the receiver (transit ≈ −37 s) →
  `transit-negative`; descriptor absent →
  `no-descriptor` after 1 s; sender `disciplined = 0` →
  `sender-undisciplined`; local E unknown → `local-undisciplined`;
  fallback at once on the third bad PCR; after 10 s qualified, return at
  a natural gap at 12 s, or at once at 40 s without one
  (`return_gap_wait_ns` = 30 s, OQ-35); an operator's mode change taken
  at a natural gap within 30 s, else at once; `deciding` releases on the fifth good PCR and at 1 s
  without; transit across a network wrap computed correctly on both sides of
  it.
- **Estimate.** 400 + 450 test; 4 days. Depends on WI-P5-1. Follows
  OQ-35 (the blend) and OQ-39 (the default), decided 2026-10-12.

#### WI-P5-7 `RestampCore`: the Trust mapping and switches

- **What.** Trust as a second mapping kind inside Phase 1's restamp.
- **Where.** `plugins/mpegts-core/native/mrts/ts_restamp.{h,cpp}` (P1
  WI-P1-3); tests in `ts_restamp_test.cpp`, `restamp_replay_test.cpp`.
- **How.** `RestampConfig` gains `TimingMode timing_mode`, `TrustConfig
  trust`, `ClockDecl clock`. One `TrustGate` per program. Mapping per PES:
  `trust` → `net_to_bus(pts, epoch_rx)` (and DTS); `restamp` → Phase 1's
  STC path, with O and trims applied only when `timing_mode = restamp`
  (Q13). PCRs in `trust` → `net_to_bus` on the base, extension kept. A
  switch reuses the live-edit path of P1 part 4.4 (new mapping from each PID's
  next `pusi`, gap marker or guard drop); `hold` buffers whole input
  buffers up to the gate's limits and releases them through the chosen
  mapping. Receiver re-epoch → a switch to the same mode with the new
  constant. `on_natural_gap` is called from the existing re-lock and
  outage paths; a return and an operator's mode change wait for it up to
  30 s, a fallback does not (OQ-35).
- **Acceptance.** Replays (part 7.2): `trust-ok-srt2000.stct` maps every PES
  to `net_to_bus` exactly; `trust-tai-unset.stct` (the sender loses its
  TAI offset at 30 s) drops the ≤ 3 PCRs' worth of content that stepped
  back 37 s, falls back with `transit-high`, and continues about L later
  than before the step, with no backward PTS; `trust-sender-reepoch.stct`
  passes the sender's ΔE onto the bus as one gap; `trust-return.stct`
  returns at the natural gap; O = +500 ms and a trim are ignored in all
  Trust states (Q13); output CC continuous.
- **Estimate.** 450 + 500 test; 5 days. Depends on WI-P5-6, P1 WI-P1-3.
  Follows OQ-35 and OQ-39 as decided 2026-10-12.

#### WI-P5-8 `mrtsrestamp`: Trust properties and messages

- **What.** The element face of WI-P5-7.
- **Where.** `plugins/mpegts-core/native/mrtshouse/gstmrtsrestamp.cpp` (P1
  WI-P1-4); `packages/engine/src/child-process/gst_mrtsrestamp_element_test.py`.
- **How.** New properties: `timing-mode` (enum `restamp` | `trust`, default
  `restamp`, live); `transport-latency-ms` (uint, live); `trust-tolerance-ms`
  (uint, default 200, live); `house-clock` (string, live, part 4.6). New
  message `mrtsrestamp-trust` per program per interval: `program`,
  `selected`, `effective` (`restamp` | `deciding` | `qualifying` | `trust` |
  `fallback` | `returning`), `qualifies`, `failed`, `transit-min-ns`,
  `transit-median-ns`, `transit-max-ns`, `bound-ns`, `l-ns`, `tau-ns`, and
  the sender declaration (`decl-present`, `decl-tai`, `decl-disciplined`,
  `decl-traceable`, `decl-source`, `decl-tai-offset-s`, `decl-ptp-domain`,
  `decl-gm`, `decl-error-class`, `decl-epoch-seq`, `decl-d-e-ns`).
  `mrtsrestamp-event` gains `trust-qualified`, `trust-fallback` (with
  `failed`), `trust-return`, `trust-switch` (`gap-ns` | `overlap-ns`),
  `sender-reepoch`.
- **Acceptance.** Harness: a live `timing-mode` change mid-stream produces
  `qualifying` then, at the harness's injected gap (or after 30 s without
  one, OQ-35), one `trust-switch` with `overlap-ns` ≈ the replayed
  transit; `house-clock` with an unknown E yields `failed =
  local-undisciplined`; `gst-inspect-1.0` lists the properties.
- **Estimate.** 200 + 200 test; 2 days. Depends on WI-P5-7.

#### WI-P5-9 Engine clock: the `house-clock` value, PTP identity, binding

- **What.** One serialiser and one binding so every writer and restamp sees
  the same E and declaration.
- **Where.** New `packages/engine/src/clock/houseClockProperty.ts` and
  `packages/engine/src/clock/ptpStatus.ts` with tests; `TimeSyncState` in
  `packages/shared-types/src/` (P0 WI-P0-4) gains `ptp?`;
  `packages/engine/src/clock/HouseClock.ts` (P0) polls `ptpStatus` while
  `source = 'ptp'`; `packages/engine/src/plugins/GstPluginBase.ts` gains
  `protected bindHouseClock(elements: string[])`;
  `packages/engine/src/system/SystemStatsCollector.ts:43` `ENGINE_FEATURES`
  gains `'egress-writer'` and `'trust-ingest'`.
- **How.** `houseClockGstString(epoch, state)` per part 4.6 (bigint E as
  decimal; `error-us` from `estErrorUs`, under PTP `max(estErrorUs,
  |offsetNs|/1000)`; `disciplined = synced && source !== 'none'`).
  `readPtpStatus()` reads `/run/media-router-ptp/status.env`, runs `pmc`
  on `/var/run/ptp4lro` with `-d <domain>`, parses
  `grandmasterIdentity` and `offsetFromMaster`; 2 s timeout; failures are
  logged once per state change. `bindHouseClock` subscribes to
  `houseClock.on('epoch')` and `on('state')`, compares the descriptor-
  relevant fields (error by class), and calls `setElementProperty(el,
  'house-clock', value)` for each element; it unsubscribes in `onStop`.
  A test-only override, `MR_HOUSE_CLOCK_E_OVERRIDE_NS` (engine
  environment; honoured by `houseClockGstString` only when set, and
  logged as a warning at every use), lets a test place the wire wrap
  minutes after start — R19's "test mode that places a wrap minutes after
  start". V-P5-8 runs against it on both boxes and in both runners; the
  real-wrap soak becomes optional.
- **Acceptance.** Vitest: serialiser output parses with a fixture of
  `gst_structure_from_string` expectations (string pinned); E above 2^53
  round-trips exactly; a state change that keeps the error class pushes
  nothing; a re-epoch pushes once per element; `ptpStatus` parses the
  `pmc` transcript already pinned in the Device Manager's
  `PtpStatus.spec.ts` (copied, not imported) and a missing socket.
- **Estimate.** 300 + 300 test; 3 days. Depends on P0 WI-P0-4.

#### WI-P5-10 Egress modules wired

- **What.** srt-output, rist-output and mpegts-ip-output on the writer.
- **Where.** New `packages/engine/src/plugins/egressTiming.ts` and
  `egressTiming.test.ts` (exported from `@media-router/engine`);
  `plugins/srt-output/engine/SrtOutputModule.ts:124–134`,
  `plugins/rist-output/engine/RistOutputModule.ts:93–108`,
  `plugins/mpegts-ip-output/engine/MpegTsIpOutputModule.ts:92–134` and
  their tests; manifests gain `"timing": { "role": "egress" }`.
- **How.**
  - `buildEgressWriter({ name = 'egress', houseClock }): string` →
    `mrtsegress name=egress house-clock=<quoted>`; `egressBusReports(name)`
    → `[{ element, structure: 'mrtsegress-stats' }, { element, structure:
    'mrtsegress-event' }]`.
  - `class EgressTimingReporter` (host: `setStatusData`, `setBadge`,
    `clearBadge`, health warning callbacks) adds the rows of part 8 to
    Phase 0's `timing` section, the `net-time` badge, and the warnings of
    part 10; throttled like P0's `LatenessReporter`.
  - Each module inserts the writer after its queue and before
    re-chunk/payloader/tee (part 4.1), adds the reports to `busReports`,
    routes `mrtsegress-*` plugin events to the reporter, and calls
    `bindHouseClock(['egress'])` in `onStart`.
  - Comments that state the pass-through are rewritten (part 6).
- **Acceptance.** Module tests assert the order `busSrc → queue →
  mrtsegress → [tsparse] → [rtpmp2tpay] → sink|tee` (one writer before a
  multi-destination tee), the bus reports, and that a `houseClock` `epoch`
  event calls `setElementProperty('egress', 'house-clock', …)` once.
  `busRunnerContract.test.ts` pins the element name `egress`.
- **Estimate.** 350 + 400 test; 3.5 days. Depends on WI-P5-3, WI-P5-9.

#### WI-P5-11 Ingest modules: Timing Mode, tolerance, L, reporting

- **What.** The operator choice and its display on the three network
  ingests.
- **Where.** `packages/engine/src/plugins/ingestTiming.ts` (P1 WI-P1-9) and
  its test; `packages/shared-types/src/` `withIngestTimingSettings(schema,
  { pidTrims, trust })`; the manifest field `"timing": { "role": "ingest",
  "pidTrims": true, "trust": true }` in `plugins/srt-input/package.json`,
  `plugins/rist-input/package.json`, `plugins/mpegts-ip-input/package.json`;
  `plugins/srt-input/engine/SrtInputModule.ts`,
  `plugins/rist-input/engine/RistInputModule.ts`,
  `plugins/mpegts-ip-input/engine/MpegTsIpInputModule.ts` and tests;
  `packages/manager/src/plugins/manifestHelpText.test.ts` (shared wording).
- **How.**
  - Keys `TIMING_MODE_KEY = 'timingMode'`, `TRUST_TOLERANCE_KEY =
    'trustToleranceMs'`. Schema per part 8. `ingestOffsetMs` and
    `pidTrimsMs` gain `x-disabledWhen: "timingMode=trust"` and
    `x-disabledReason` (part 8).
  - `buildRestamp({...})` (P1) gains `timingMode`, `transportLatencyMs`,
    `trustToleranceMs`, `houseClock`.
  - `transportLatencyMs(kind, config)` per part 4.8. srt-input: the
    module reads `negotiated-latency-ms` from the stats `SrtStatPoller`
    already fetches (`srtHelpers.ts:173–175`; a getter is added to the
    poller), and pushes `transport-latency-ms` when it changes by ≥ 1 ms.
    mpegts-ip-input names its jitterbuffer `rtpjitterbuffer name=jbuf`
    and reads `latency` at start (`getElementProperty`,
    `GstPluginBase.ts:905`, or the 200 default).
  - `applyIngestTimingLiveUpdate` handles `timingMode` →
    `setElementProperty('restamp', 'timing-mode', …)` and
    `trustToleranceMs` → `trust-tolerance-ms`. Keys join
    `liveUpdatableParams`.
  - `IngestTimingReporter` gains the `trust` section and badge of part 8 and
    the warnings of part 10 from `mrtsrestamp-trust` and the new events.
  - Each module calls `bindHouseClock(['restamp'])`.
- **Acceptance.** `ingestTiming.test.ts`: a recorded message sequence
  (deciding → trust → fallback(transit-high) → returning → trust) maps to
  sections, badges, one warning raised and cleared, and the events in the
  log; the schema snapshot shows the two settings only where `trust` is
  declared; a live `timingMode` edit calls the property without a restart;
  srt-input pushes the negotiated latency from a stats fixture with two
  callers (max taken). `manifestHelpText.test.ts` pins `timingMode` and
  `trustToleranceMs` wording across the three manifests.
- **Estimate.** 450 + 450 test; 4 days. Depends on WI-P5-8, WI-P5-9, P1
  WI-P1-9/10. mpegts-ip-input's L per OQ-38 (decided: no change).

#### WI-P5-12 Manager UI: disabled-with-reason

- **What.** Grey the offset and trim controls in Trust, with the reason.
- **Where.** `packages/manager-ui/src/composables/useModuleSettingsForm.ts`
  (`FormField` gains `disabledWhen`, `disabledReason`, near `:30–31` and
  `:118–119`); `packages/manager-ui/src/components/routing/ModuleSettingsForm.vue`
  (`:disabled="field.readOnly || isFieldDisabled(field)"` on every control,
  and the reason rendered under the heading); `PidTrimField.vue` (P1) gets
  `:disabled-reason`; tests in the existing
  `packages/manager-ui/src/composables/useModuleSettingsForm.test.ts` and
  `packages/manager-ui/src/components/routing/ModuleSettingsPanel.test.ts`.
- **How.** `isFieldDisabled(field)` = `matchShowWhen(field.disabledWhen,
  key => localSettings[key])` (reuses
  `packages/manager-ui/src/utils/showWhen.ts:7`).
  The stored values are kept and shown greyed; edits are blocked. The
  reason is plain text from the manifest, ≤ 120 characters (ADR-0022).
- **Acceptance.** With `timingMode = trust`, both controls are disabled and
  the reason is visible; switching to Restamp enables them with the stored
  values; `x-showWhen` behaviour unchanged.
- **Estimate.** 150 + 150 test; 1.5 days. Depends on WI-P5-11 (schema).

#### WI-P5-13 aes67-input: `ptpSync` is Trust for the offset rule

- **What.** Apply Q13 to the one ingest whose Trust already exists (§5.4).
- **Where.** `plugins/aes67-input/package.json` (`ingestOffsetMs` gains
  `x-disabledWhen: "ptpSync=true"` and its reason);
  `plugins/aes67-input/engine/Aes67InputModule.ts` (O forced to 0 in the
  restamp while `ptpSync`); its test.
- **How.** The restamp in `clock-mode=fixed` (P1 part 4.1) gets `offset-ns=0`
  whenever `ptpSync` is on; no transit check (RTP carries no D_e).
- **Acceptance.** Module test: with `ptpSync` the pipeline carries
  `offset-ns=0` whatever `ingestOffsetMs` holds; schema snapshot.
- **Estimate.** 20 + 40 test; 0.5 day.

#### WI-P5-14 Fixtures, replays and protocol cases

- **What.** The fixtures of part 7.2 and the protocol cases of part 7.3.
- **Where.** `plugins/mpegts-core/tests/fixtures/` (OQ-2: in-repo, ≤ 2 MB
  each, off the device per WI-S0-13);
  `plugins/mpegts-core/native/mrts/tests/fixture_gen.cpp` (S0) gains
  `--egress-sparse-pcr`, `--no-pcr-pid` and a `--trust` trace
  mode (`--transit-ms`, `--epoch-offset-s`, `--reepoch-at`);
  `packages/engine/src/child-process/native_runner_protocol_test.py` and
  P1's `gst_ingest_restamp_test.py` (Python runner).
- **How.** Synthetic fixtures from the generator; wire fixtures recorded
  from the writer itself on the gate (a `gst-launch-1.0 srtsrc ! filesink`
  or `udpsrc ! filesink` capture on the receiving box, trimmed), with
  `.expect.jsonl` reviewed by hand once and then pinned.
- **Acceptance.** Every fixture in part 7.2 exists with its expectation
  and passes in `make -C plugins/mpegts-core/native/mrts test`; the
  protocol cases pass in both runners.
- **Estimate.** 300 test/generator + fixtures; 4 days (1.5 of them on the
  gate). Depends on WI-P5-3, WI-P5-8.

#### WI-P5-15 Third-party receiver compatibility run

- **What.** Prove third-party receivers play the writer's output (R17).
- **Where.** New `tools/egress-compat.sh` (dev box; `ffprobe`, `ffmpeg`,
  `vlc` and stock `gst-launch-1.0 … tsdemux` are present on the dev box).
- **How.** For each egress kind (srt caller/listener, udp raw, udp RTP;
  rist via `mrristsrc` in a stock `gst-launch-1.0` pipeline), receive 30 min,
  decode with each player to `fakesink`/`-f null`, and run `mrts_cli
  pcrcheck` on a parallel capture; inject one D_e raise and one re-epoch
  during the run.
- **Acceptance.** No decoder error; at most one visible glitch per injected
  discontinuity; `pcrcheck` clean (part 11, V-P5-6).
- **Estimate.** 120 lines; 1.5 days.

#### WI-P5-16 R11: egress CPU on a Pi 4

- **What.** The measurement plan of part 11 (V-P5-7), run before release.
- **Where.** `tools/runner-cpu-profile.sh` (exists, BusyBox-only) on
  10.9.16.108; `mrts_bench` (S0 WI-S0-6) gains an `egress` mode in
  `plugins/mpegts-core/native/mrts/tests/mrts_bench.cpp`.
- **How.** `mrts_bench egress` runs `EgressCore` over every fixture and
  prints ns/packet including the write-map copy; on the box, the same
  wiring is profiled on the Phases 1–4 release and on Phase 5, 60 s windows,
  `MR_GST_RUNNER_NATIVE=1` and `=0`.
- **Acceptance.** Part 11 V-P5-7 criteria; figures recorded in ADR-0029.
- **Estimate.** 60 lines; 1.5 days on the box.

#### WI-P5-17 Documents

- **What.** ADR, design doc status, release notes.
- **Where.** `docs/adr/0029-house-clock-timing.md` (section "Egress and
  Trust"); `docs/house-clock-timing-design.md` (`:138–140`, `:273–275`,
  `:912` marked as superseded "before Phase 5"; §13.3 descriptor row points
  to the ADR); release notes.
- **How.** The ADR records: the descriptor table of part 4.3 and its
  versioning rule; the D_e constants and rules (part 4.4); the PCR PID
  choice for 0x1FFF; gap markers not sent; the TrustGate constants (part
  4.8); L per module; the same-program rule (WI-P5-4); the paced-egress
  hook (part 4.7); R11 figures. Release notes: what Trust is and when to
  use it (§9.3 "Choosing Trust or Restamp"); that wire PTS are now TAI and
  receivers see one flagged discontinuity per D_e change; that Phase 0's
  time sync must be deployed on both ends for Trust.
- **Acceptance.** The ADR-0029 "Egress and Trust" section is reviewed by
  the design owner; the release notes list Timing Mode and Trust
  Tolerance.
- **Estimate.** 250 lines; 2 days.

#### WI-P5-18 Gate verification and release

- **What.** Part 11 on 10.9.16.103 and 10.9.16.108; release from the
  Device Manager.
- **Where/How.** The RAUC image of the release on both boxes; every row of
  part 11 in both runners; the Phases 1–4 release first as the baseline.
- **Acceptance.** Every V-P5 row passes in both runners; the R11 figures
  are in ADR-0029.
- **Estimate.** 6 days (two of them the optional real-wrap soak, V-P5-8).

#### WI-P5-19 ptp4l presets: a step on first lock only

- **What.** §10.2's "ptp4l / phc2sys: a step on first lock only", deferred
  from Phase 0 (chapter 4 WI-P0-2) on 2026-10-12 by the orchestrator,
  owner delegated.
- **Where.** Yocto: `meta-layers/meta-custom/recipes-support/media-router-ptp/files/aes67.conf:123`,
  `files/smpte-2059-2.conf:65`.
- **How.** `step_threshold 1.0` → `step_threshold 0.0`, with
  `first_step_threshold 1.0` set explicitly, in both presets: only the
  first lock steps; a later large offset is slewed at `max_frequency`.
- **Acceptance.** On a PTP box after lock, an induced 2 s offset on the
  grandmaster side is slewed, not stepped (no step line in the ptp4l
  journal); `taiOffsetS` stays 37 through it (P0 V8's other checks hold).
- **Estimate.** 10 lines; 0.25 day.

### 6. Deletions

Phase 5 replaces an absence of code ("egress forwards the bus bytes
unchanged"), so no mechanism is deleted. What goes in this release is the
text that asserts the old behaviour. No setting is removed: every timing
setting of today went in Phases 1–4 (Q9).

| What goes | Where | Lines | Replaced by |
|---|---|---|---|
| Class doc "Pure MPEG-TS passthrough — no encoding or processing." | `plugins/srt-output/engine/SrtOutputModule.ts:13–16` | 1 | "MPEG-TS over SRT; PTS translated to TAI and a new PCR written (ADR-0029)." |
| Comment "keeps even that a pure re-slice, never a PCR re-timing" | `SrtOutputModule.ts:113–122` | 2 of 10 | The re-chunk is still a pure re-slice; the PCR is the writer's, before it. |
| Class doc "Pure passthrough — no encoding." | `plugins/mpegts-ip-output/engine/MpegTsIpOutputModule.ts:21–24` | 1 | As srt-output. |
| Comment "the producer's house stamps ride through untouched" | `MpegTsIpOutputModule.ts:100–104` | 2 of 5 | "PTS/PCR are the writer's; tsparse only re-slices." |
| Doc "the producer's house stamps ride through, no PCR re-timing (… under ADR-0005)" | `packages/engine/src/plugins/tsHelpers.ts:125–130` | 3 | "A pure re-slice: tsparse never re-times (ADR-0029); the egress writer owns the wire PCR." |
| Tests | `plugins/srt-output/engine/SrtOutputModule.test.ts:54–67`, `plugins/mpegts-ip-output/engine/MpegTsIpOutputModule.test.ts:40–58`, `plugins/rist-output/engine/RistOutputModule.test.ts:36–45` | 0 | None deleted: they assert with `toContain`/`toMatch`, which stay true with the writer inserted. WI-P5-10 adds the order assertions. |
| Design text describing the pre-Phase 5 wire | `docs/house-clock-timing-design.md:138–140` (§2 "Network egress"), `:273–275` (§4.3 last bullet), `:912` (§11.1 egress row "Today") | 3 places | Marked "until Phase 5" (the design doc is kept as the design record; ADR-0029 is the living one). |

### 7. Tests and fixtures

#### 7.1 Unit tests (C++, no GStreamer)

All under `plugins/mpegts-core/native/mrts/tests/`, run by `make -C
plugins/mpegts-core/native/mrts test` (S0 WI-S0-6) on the dev box and in the
Yocto `do_compile` test target.

| Test | Pins |
|---|---|
| `ts_hcdesc_test.cpp` | Descriptor encode/decode, forward compatibility, strip, error class (WI-P5-1). |
| `ts_egress_test.cpp` | Part 4.2 steps 1–9, D_e rules of part 4.4, epoch rules of part 4.5 (WI-P5-2). |
| `ts_egress_replay_test.cpp` | Every egress fixture of part 7.2 against its `.expect.jsonl`. |
| `ts_trust_test.cpp` | TrustGate conditions, transit at the wrap, the state table (WI-P5-6). |
| `ts_restamp_test.cpp`, `restamp_replay_test.cpp` (extended) | Trust mapping, switches, holds, re-epochs on both ends (WI-P5-7). |
| `ts_psi_test.cpp` (extended) | `es_generation()` ignores version-only and `program_info`-only changes (WI-P5-4). |

#### 7.2 Conformance fixtures

`plugins/mpegts-core/tests/fixtures/` (OQ-2: in-repo, ≤ 2 MB each, off the
device per WI-S0-13). Expectation lines are S0's per-PES format plus
`{"pcr":…,"disc":…}`, `{"desc":{…},"pmtVersion":n}` and
`{"trust":{"state","failed","transit"}}` lines.

| Fixture | Source | Pins |
|---|---|---|
| `syn-egress-sparse-pcr.ts` | `fixture_gen --egress-sparse-pcr` | Audio-only, PCR PID = audio PID, PES 64 ms apart: PCR-only insertion, AF-only CC rule, ≤ 35 ms interval |
| `syn-egress-no-pcr-pid.ts` | `fixture_gen --no-pcr-pid` | PCR_PID 0x1FFF: PID assignment, PMT rewrite, CRC |
| `syn-wrap-33bit.ts` (S0) | reused, with E chosen to put the wire wrap mid-file | PTS/DTS/PCR across the network wrap, B-frame DTS behind PTS (R19, S9) |
| `syn-pes-header-split.ts` (S0) | reused | Header spanning two packets rewritten via `PesHeaderSpan` |
| `cap-mux-unbounded-video.ts` (S0) | reused | PCR on the video PID rewritten in place; unbounded PES; DTS |
| `cap-302m-bssd.ts` (S0) | reused | 302M egress (audio-only program, PCR at mux cadence) |
| `cap-occ-1080i-h264-aac-ttx.ts` (S0), after the Phase 1 restamp | reused through `restamp-replay` | Relay of a foreign program: its PMT descriptors kept, ours appended; teletext rewritten but not driving D_e |
| `bus-egress-gap.gdp` | .108 bus tap: srt-input source stopped 3 s | P1 gap marker consumed and not sent; D_e lowered by ≤ the gap |
| `wire-mrht-v1.ts` | .108 srt-output, captured on .103 | Golden wire: descriptor bytes, PCR cadence, PTS = `H mod 2^33` |
| `wire-mrht-de-raise.ts` | .108, a 1.5 s stall injected upstream of the egress | New PMT version before a flagged PCR; same-program rule (WI-P5-4) |
| `wire-mrht-reepoch.ts` | .108, `chronyc makestep` after `date -s +2s` with chronyd stopped (P0 V6) | `epoch_seq` + 1, ΔE = 2 s step flagged |
| `wire-old-engine.ts` | srt-output of the Phases 1–4 release | No descriptor: Trust falls back with `no-descriptor` (R20) |
| `trust-ok-srt2000.stct` | `fixture_gen --trust --transit-ms 1950..2050` | Trust holds at L = 2 s, τ = 0.2 s |
| `trust-tai-unset.stct` | `fixture_gen --trust --epoch-offset-s -37 --reepoch-at 30` | Sender loses its TAI offset mid-trace: `transit-high` (+37 s), fallback within 3 PCRs, overlap dropped, no backward PTS |
| `trust-rx-tai-unset.stct` | same, offset applied to the receiver's E | `transit-negative` (−37 s): never enters Trust from `deciding` |
| `trust-sender-reepoch.stct` | `fixture_gen --trust --reepoch-at 30` | Sender ΔE passes onto the bus as one gap; no fallback if transit stays in bounds |
| `trust-return.stct` | `fixture_gen --trust` with 5 s out of bounds, then a source outage at +12 s | Fallback, `returning`, return at the natural gap |
| `trust-jitter-rist.stct` | .103 rist-input from .108, `buffer=1000`, 15 min recorded with P1's trace recorder | Real transit spread through librist; no false fallback (R-P5-5) |

#### 7.3 Protocol tests, both runners

- `packages/engine/src/child-process/native_runner_protocol_test.py`
  (native runner) and a new `gst_egress_writer_test.py` (Python runner),
  case `egress-writer`: a producer `appsrc` of `cap-mux-unbounded-video.ts`
  → `buildBusSink`, one consumer edge over `unixfdsink`→`unixfdsrc`, the
  consumer string `buildBusSrc ! mrtsegress name=egress house-clock=… !
  filesink`. Asserts: every PES PTS on the file equals `bus_to_net` of the
  bus PTS; `mrts_cli pcrcheck` clean; plugin events
  `mrtsegress-stats:egress` reach the engine; a live `house-clock` with
  seq + 1 yields one flagged PCR.
- Case `ingest-trust` in `native_runner_protocol_test.py` and P1's
  `gst_ingest_restamp_test.py`: `appsrc` of `wire-mrht-v1.ts` with arrivals
  from `trust-ok-srt2000.stct` (`arrival=buffer-pts`) → `mrtsrestamp
  timing-mode=trust` → `buildBusSink`; asserts the bus PTS =
  `net_to_bus(wire)` exactly and `mrtsrestamp-trust:restamp` events with
  `effective = trust`.
- Case `mrtsdemux-pmt-version-only` (WI-P5-4), both runners.
- Both runners host the one element; there is no Python implementation
  (S0 part 4.5 rule 1).

#### 7.4 Engine and UI tests (vitest)

`egressTiming.test.ts`, `ingestTiming.test.ts` (extended),
`houseClockProperty.test.ts`, `ptpStatus.test.ts`, the six module tests,
`busRunnerContract.test.ts`, `manifestHelpText.test.ts`,
`useModuleSettingsForm.test.ts`, `ModuleSettingsPanel.test.ts`,
`PidTrimField.test.ts` (P1), `Aes67InputModule.test.ts` (C-11).

### 8. Manager and UI

| Change | Modules | Detail |
|---|---|---|
| Setting added: **Timing Mode** `timingMode` | srt-input, rist-input, mpegts-ip-input | `{ type: string, enum: [restamp, trust], x-enumLabels: [Restamp, Trust], default: restamp, x-live: true, title: "Timing Mode", description: "Restamp lands the stream on arrival; Trust keeps the sender's timeline after checking it." }` |
| Setting added: **Trust Tolerance** `trustToleranceMs` | same | `{ type: number, minimum: 0, maximum: 10000, default: 200, x-unit: ms, x-live: true, x-showWhen: "timingMode=trust", title: "Trust Tolerance", description: "How far transit may exceed the link latency before Trust falls back to Restamp." }` |
| Settings disabled with a reason | `ingestOffsetMs`, `pidTrimsMs` on the three ingests, when `timingMode = trust` | `x-disabledWhen: "timingMode=trust"`, `x-disabledReason: "Trust keeps the sender's timeline. Switch Timing Mode to Restamp to set an offset."` Values kept and shown greyed (Q13). |
| Setting disabled (§5.4, §11.1 and §10.4 name `ptpSync` as Trust; Q13 forbids an offset while Trust is selected; C-11) | `ingestOffsetMs` on aes67-input when `ptpSync` | Reason: "PTP sync keeps the sender's timeline. Turn PTP sync off to set an offset." |
| Settings removed | — | None. |
| Egress settings | srt-output, rist-output, mpegts-ip-output | None (the D_e bound is an element property only; OQ-36). |

What each module shows (ADR-0007: plugins compute, the UI renders; no new
components besides WI-P5-12):

| Module | Section / badge | Rows |
|---|---|---|
| Network ingest | Section **Trust** (`trust`) | Timing mode (selected); In effect (Restamp, Deciding, Qualifying, Trust, Restamp — fallback, Returning); Failed condition (plain words, e.g. "Transit 37.0 s above the 2.2 s bound"); Transit min/median/max (ms); Bound L + τ (ms) with L's source ("SRT negotiated 2000 ms", "RIST buffer 1000 ms", "RTP jitter buffer 200 ms", "UDP 0 ms"); Sender: house time yes/no, sync source, traceable, TAI−UTC, PTP domain and grandmaster, clock error ≤ n ms, D_e (ms), epoch; Last switch (direction, gap or overlap ms, age). In Restamp, "Would qualify for Trust: yes / no (reason)" when a descriptor is present. |
| Network ingest | Badge `timing` | "Trust" (green), "Fallback" (amber), "Deciding" (grey); none in Restamp. |
| Network egress | Phase 0's `timing` section gains | Egress delay D_e (ms); D_e changes (last 10 min); PCR interval max (ms, last window); PCR packets inserted (/s); Network time: "TAI, epoch n, chrony, ≤ 2 ms" or "Not traceable (reason)"; PMT descriptor: "MRHT v1". |
| Network egress | Badge `net-time` | Hidden when traceable; "Untraceable" (amber) otherwise. |
| aes67-output | — | Unchanged (P0 shows epoch seq and source). |

Device Manager: no change (the Phase 0 Time page shows chrony and the TAI
offset; the PTP page already shows the grandmaster). Engine card:
`ENGINE_FEATURES` gains `egress-writer` and `trust-ingest`, so a manager can
tell a Phase 5 engine. The manager injects the two ingest settings from the
manifest's `"timing"` field (P1 WI-P1-9 mechanism), so old engines' modules
never show them.

### 9. Image and Yocto

One image change: WI-P5-19 edits the two ptp4l presets so the clock steps
on first lock only (deferred from Phase 0). Otherwise Phase 5 builds
nothing in the image. It relies on what Phase 0 put there (chrony, the
kernel TAI offset, `mr-clockstate`) and on what is already there:

- linuxptp 4.4 (Yocto: `meta-layers/meta-openembedded/meta-oe/recipes-connectivity/linuxptp/linuxptp_4.4.bb`,
  pulled in by `media-router-ptp`, Yocto:
  `meta-layers/meta-custom/recipes-support/media-router-ptp/media-router-ptp.bb:52–54`)
  installs `pmc`; ptp4l opens `/var/run/ptp4lro` at mode 0666 by default,
  and neither preset (`aes67.conf`, `smpte-2059-2.conf`) overrides it.
  To verify on a PTP box before WI-P5-9 closes: the engine user can run
  `pmc -u -b 0 -s /var/run/ptp4lro -d <domain> 'GET PARENT_DATA_SET'`,
  and `/run/media-router-ptp/status.env` is world-readable.
- The native elements ship in the image's
  `/usr/libexec/media-router/mpegts-core/` with `libgstmrtshouse.so` (S0
  WI-S0-7); the TS dist tarball and the native package must be released
  together (S0 part 3.4, the ABI check of S0 part 4.5 rule 4).

### 10. Telemetry and alarms

| Signal | Source, cadence | Where it lands | Level |
|---|---|---|---|
| `mrtsegress-stats` | writer, per program, 2 s | egress `timing` rows; engine log at debug | — |
| `d-e-raise` / `d-e-lower` (from, to, lateness, gap) | `mrtsegress-event` | engine log `egress <id>: D_e 300 → 950 ms (lateness 812 ms)`; counter in `timing` | info |
| D_e changed more than 3 times in 10 min | reporter | module warning "Egress delay unstable: n changes in 10 min"; cleared after 10 min quiet | warning |
| `d-e-max` (OQ-36) | event | module warning "Egress delay held at max; receivers get late content" | warning |
| Egress lateness | Phase 0 `lat_egress`; the lateness alarm is deferred (OQ-8) | unchanged | — |
| PCR interval max > 40 ms while data flows | stats | counter row; log once per hour | info (R17) |
| `re-epoch` on the wire (seq, ΔE) | event | engine log; egress `timing` row | info (P0 logs the cause) |
| Egress untraceable / E unknown | `house-clock` | badge `net-time`; module warning only when E is unknown | info / warning |
| `pcr-pid-assigned`, `pmt-grew`, `merged-buffers` | event / stats | engine log once | info |
| `mrtsrestamp-trust` | restamp, per program, 2 s | ingest `trust` section | — |
| `trust-fallback` (failed condition) | event | module warning "Trust fallback: transit 37.0 s above 2.2 s; restamping"; badge amber; engine log | warning |
| `trust-return`, `trust-qualified`, `trust-switch` (gap/overlap ms) | event | engine log; `trust` section "Last switch" | info |
| Trust selected but the stream has never qualified for 60 s | reporter | module warning "Trust selected but stream does not qualify: <reason>" (persists) | warning |
| `sender-reepoch` | event | engine log | info |

No alarm drops content (P11). Every warning clears by itself when the
condition ends.

### 11. Verification on the test fleet

Run on 10.9.16.108 (Pi 4) and 10.9.16.103 (Pi 5), each case with
`MR_GST_RUNNER_NATIVE=1` and `=0`, after the Phases 1–4 release is
installed as the baseline. Preconditions, checked first with `mr-clockstate --once`
(P0) and `chronyc tracking` over `mrssh`: both boxes synchronised, TAI
offset 37 s, epoch traceable. Cases V-P5-2 and V-P5-3 are run twice, under
chrony and under PTP (the two-box PTP bench, §11.2). Tools: `mrts_cli
pcrcheck` / `hcdesc` / `dump --net` on captures (`gst-launch-1.0 srtsrc|udpsrc
! filesink` on the receiving box, copied with `mrscp`); the content-based
A/V skew tool (`avskew`, as in Phase 1); the module status sections;
`tools/runner-cpu-profile.sh`; `tools/egress-compat.sh` (WI-P5-15) on the
dev box; journal greps.

| # | What | Setup | Pass criterion |
|---|---|---|---|
| V-P5-1 | Wire format | .108 ingest → mpegts-muxer → srt-output → capture on .103 | `hcdesc`: one `MRHT` v1, flags `tai, disciplined, traceable`, `tai_utc_offset_s` 37; every PES: `wire PTS = bus_to_net(bus PTS)` (bus tap on .108 vs wire capture, `dump --net`); `pcrcheck`: PCR interval ≤ 40 ms at the 99.9th percentile while data flows, every PCR jump flagged, `DTS − PCR` > 0 on 100 % of PES. |
| V-P5-2 | Origin alignment by construction (§9.3 worked example, two boxes) | .108 ingests a programme with A/V markers and sends video over srt-output (latency 2,000 ms) and audio over rist-output (buffer 500 ms) to .103; .103 ingests both with Trust and muxes them | A/V at the .103 mux output within ±2 ms of the source's (`avskew`), stable over 1 h; control run with both ingests on Restamp shows the ~1.5 s transit difference. |
| V-P5-3 | Transit check, fallback and return | V-P5-2 wiring; on .108 the kernel TAI offset is set to 0 with P0's `mr-ptp-settai.py` (P0 WI-P0-2), which re-epochs it | .103 falls back within 1 s with "transit-high" (≈ +37 s above the bound): per PID, ≤ 3 PCRs' worth of stepped-back content dropped, then a gap of about L at the switch; no backward PTS on the bus (bus tap). Restoring 37 s re-epochs .108; .103 returns to Trust at the next natural gap, or at once after 30 s without one (OQ-35), with one dropped overlap; each step logged. Repeated with the offset removed on .103 instead: "transit-negative". |
| V-P5-4 | Bound from SRT latency | srt-input Trust, `latency` 2,000 on both ends; then sender 3,000 / receiver 2,000 | Bound shown 2,200 ms, then 3,200 ms (negotiated); transit median ≈ L; no fallback over 1 h. |
| V-P5-5 | D_e follows lateness | .108 route ingest → transcoder → srt-output; the transcoder runner stopped for 1.5 s (`kill -STOP`/`-CONT` via `mrssh`), then a 3 s source outage | One flagged raise ≈ +1.5 s, no CC error and no lost packet on the wire (`pcrcheck`); D_e lowered at the outage by ≤ 3 s; a Trust receiver on .103 stays in Trust. |
| V-P5-6 | Third-party receivers (R17) | `tools/egress-compat.sh` on the dev box against srt, udp raw, udp RTP and rist outputs of .108 | 30 min each with one D_e raise and one re-epoch injected: no decoder error, ≤ 1 visible glitch per injected event, `pcrcheck` as V-P5-1. |
| V-P5-7 | R11: egress CPU on a Pi 4 | .108; one 10 Mbit/s programme fanned to N = 1, 4 and 8 srt-output callers (to .103 listeners), plus one 30 Mbit/s mpegts-ip-output raw multicast relay; Phase 4 vs Phase 5, same wiring; `runner-cpu-profile.sh -t 60` per runner; `mrts_bench egress` on the fixtures (sizing per OQ-40) | Bench: ≤ 1.0 µs/packet walk + edits (S0 WI-S0-11 budget). In pipeline: added CPU per egress ≤ 2 % of one core at 10 Mbit/s and ≤ 5 % at 30 Mbit/s; the 8-egress case adds ≤ 16 % of one core in total; egress lateness p99 unchanged within 1 ms; `merged-buffers` < 1 % of buffers. |
| V-P5-8 | Network wrap (R19, S9) | V-P5-2 wiring with `MR_HOUSE_CLOCK_E_OVERRIDE_NS` placing the wire wrap 5 min after start, in both runners (WI-P5-9); optionally a 26.5 h soak straddling a real wrap instant (part 4.5); plus VLC on the dev box receiving .108's udp output | No fallback, no backward bus PTS, no re-pad, no `mrtsdemux` warning, VLC plays through the wrap; A/V of V-P5-2 unchanged across it. |
| V-P5-9 | Mixed versions (R20) | .103 temporarily on the Phases 1–4 release, then back | Phase 5 .108 receiving from a Phases 1–4 .103 with Trust selected: fallback `no-descriptor`, plays restamped; the Phases 1–4 .103 receiving from Phase 5 .108: plays as today. |
| V-P5-10 | PMT version bumps | V-P5-5's raise with a transcoder and a video-player on .103 fed by a Restamp ingest | No pad removed or added on any `mrtsdemux` (`es_generation` unchanged), no muxer re-plan. |
| V-P5-11 | aes67-output on the network timescale | .108 302M programme → aes67-output, PTP on both boxes; capture RTP on .103 | RTP timestamp = (content time + E) × 48,000 mod 2^32 within one packet (P3 V6 repeated with the Phase 5 build). |
| V-P5-12 | UI | Manager against .103 | Timing Mode and Trust Tolerance present on the three ingests only; in Trust, offset and trim greyed with the reason, values kept; Trust section and badges as part 8. |

Release gate: every V passes in both runners; R11 figures in ADR-0029;
Phase 0's time sync confirmed in the field (§13.1 Q1).

### 12. Risks specific to this phase

| # | Level | Risk | Design ref | Mitigation |
|---|---|---|---|---|
| R-P5-1 | M | **Egress CPU on a Pi 4** (R11): a TS walk and header edits per packet on every egress, where today bytes pass through; the read-only bus memory (part 3.1) would force a copy of every buffer if mapped for write. | R11 | Only changed packets are copied (part 4.2 step 9); S0's per-packet budget; V-P5-7 before release; `proc-ns-per-packet` in the field. |
| R-P5-2 | M | **Trusting a wrong upstream** (R8): a buggy sender's PTS propagates. | R8, §10.4 | Trust is opt-in; three conditions checked continuously; fallback after 3 PCRs; alarms name the condition; switches never move PTS backwards (guard). |
| R-P5-3 | M | **Time-sync baseline** (R2): NTP over asymmetric WAN puts ε at tens of ms; a box without the TAI offset is 37 s off. | R2, S2, §10.2 | Phase 0 first; Phase 5 ships only once Phase 0 is in the field; the transit bound catches any disagreement larger than τ; the descriptor carries the clock error class; D_e includes |ε|. |
| R-P5-4 | L | **Third-party receivers** (R17): D_e raises are backward PCR steps; unpaced egress shows write jitter to TR 101 290 probes; a large D_e can overflow a hardware decoder. | R17, §7 | Raises flagged and ≥ 130 ms apart; a starting margin; V-P5-6; the D_e bound hook (OQ-36); paced egress deferred (§15). |
| R-P5-5 | M | **False Trust fallbacks from the wrong L.** SRT negotiates the larger of both ends' latency; librist's delivery delay against `buffer` is not verified; RTP uses the jitterbuffer default, not `jitterMs`. | §10.4 | L read from `negotiated-latency-ms`; the `trust-jitter-rist.stct` capture and V-P5-4; L's source shown in the UI; τ per input. OQ-38. |
| R-P5-6 | M | **PMT version churn** from D_e in the descriptor makes consumers re-pad. | §7 | Fields quantised; WI-P5-4 same-program rule; `tsdemux` already does this (part 4.3); V-P5-10. This touches Phase 3's `mrtsdemux` after its release (see caveat). |
| R-P5-7 | L | **Wrap fleet-wide** (S9, R19): every box wraps at the same instant, so a wrap bug fails everywhere at once. | S9, R19 | Wrap fixtures through writer and gate; the E override of WI-P5-9 places a wrap minutes after start (R19's test mode); V-P5-8 runs against it, the real-wrap soak is optional. |
| R-P5-8 | L | **Mixed fleet** (R20). | R20 | Old streams carry no descriptor → fallback with a clear reason; V-P5-9. |
| R-P5-9 | L | **PCR gaps during silence and at low bitrates.** The writer runs only when data arrives, so no PCR is sent while a route is silent, and `tsparse alignment=7` on mpegts-ip-output holds packets up to 7 × 188 B (82 ms at 128 kbit/s). | R17, §7 | Accepted for IP receivers (unpaced, §13.1 Q16); `pcrcheck` counts it; the paced-egress hook (part 4.7) is where a fix would go. |
| R-P5-10 | L | **Trust start hold** delays a Trust-selected ingest's first output by up to 1 s. | §10.4 | Only Trust-selected ingests; OQ-39. |
| R-P5-11 | L | **Engine reads PTP identity without privilege**; if `/var/run/ptp4lro` is not reachable, `ptp_valid = 0`. | §7 | The field is informational for Trust (the transit check is the gate, Q12); verified in part 9. |
| R-P5-12 | L | **Receivers pair a PCR with a stale D_e** on an unordered transport (raw UDP reordering). | §7 | The new PMT is emitted before the flagged PCR; 3-PCR hysteresis absorbs one mispaired sample. |

### 13. Open questions

| # | Question | Why the design doc does not answer it | Blocks | Proposed default |
|---|---|---|---|---|
| OQ-35 | Is every Trust/Restamp switch taken at once, the switch being itself the gap or dropped overlap, or does a switch wait for a natural gap? | §10.4 says an automatic switch "is taken only at a gap or a stream (re)start" and that "an operator's mode change is applied the same way" (design :884–885); it also says the stream falls back and returns "one gap or dropped overlap each way", which reads as the switch making its own gap; R8 says "mode switches happen only at gaps". On a clean link a natural gap may never come. | WI-P5-6, WI-P5-7 state machine | **At once, in every direction** (automatic fallback, automatic return after 10 s qualified, operator change): the switch is the gap or overlap. The alternative is to wait up to 30 s for a natural gap on return and on operator changes, then switch at once. *Decided 2026-10-12 by the orchestrator (owner delegated), a blend: fallback at once, the switch being itself the gap; a return and an operator's change wait up to 30 s for a natural gap, then switch at once.* |
| OQ-36 | Does this version ship a per-egress upper bound on D_e (R17 "bound D_e per egress")? | R17 names the bound but §13.1 defers hardware receivers (Q16), the reason for it. | WI-P5-3 `d-e-max-ms`, part 8 | **No setting**; the element property exists (default 0 = none) as the hook; the lateness display (Phase 0) shows a runaway D_e, and the deferred lateness alarm (OQ-8) would warn once built. |
| OQ-37 | The registration `format_identifier`: use `'MRHT'` unregistered, or register a code with the SMPTE Registration Authority? | §13.3 leaves the format to the engineer; registration is a procedural choice with an external body. | WI-P5-1 | **`'MRHT'` unregistered**, checked against the SMPTE-RA public list for a collision before release. |
| OQ-38 | mpegts-ip-input in RTP mode: L is the `rtpjitterbuffer` default 200 ms, while the operator's "Jitter Buffer" (`jitterMs`) sizes a queue after the restamp. Wire `jitterMs` into `rtpjitterbuffer latency=`? | §10.4 names "the SRT latency, the RIST buffer" only. | WI-P5-11 | **No change**: L = the jitterbuffer's `latency` (200 ms), raw UDP L = 0; the UI shows L's source. |
| OQ-39 | Does a Trust-selected ingest hold its first output up to 1 s at stream (re)start to decide the mode, so no switch happens at start? | §10.4 allows switches at a stream (re)start but does not say whether the start itself is decided before output. | WI-P5-6, WI-P5-7 | **Yes, hold ≤ 1 s** (or 4 MB); without a decision by then, start in Restamp with the fallback alarm. |
| OQ-40 | What egress count and bitrate on a Pi 4 should R11 be sized against? | R11 says "the largest egress count and bitrate expected" without numbers. | V-P5-7 | **8 egresses at 10 Mbit/s plus one at 30 Mbit/s** on .108. |

All six were decided on 2026-10-12 by the orchestrator (owner delegated;
chapter 15.1): OQ-36 to OQ-40 at their defaults, OQ-35 as the blend its
row records; the items follow them: WI-P5-6 and WI-P5-7 (OQ-35, OQ-39);
WI-P5-3 (OQ-36); WI-P5-1 (OQ-37); WI-P5-11 (OQ-38); WI-P5-16 and V-P5-7
(OQ-40). Two questions of the draft were closed
during assembly because §13.1 Q13 answers them (chapter 15: C-10 no O or
trim in any state while Trust is selected, C-11 aes67-input's `ptpSync`
is Trust for the offset rule).

### 14. Estimate

| Work item | Added | Tests added | Deleted | Days |
|---|---|---|---|---|
| WI-P5-1 `ts_hcdesc` | 180 | 200 | — | 1.5 |
| WI-P5-2 `EgressCore`, `EgressDelay` | 900 | 800 | — | 8 |
| WI-P5-3 `mrtsegress` | 450 | 300 | — | 4 |
| WI-P5-4 Same-program rule | 60 | 120 | 10 | 1 |
| WI-P5-5 `mrts_cli` verbs | 250 | 80 | — | 1.5 |
| WI-P5-6 `TrustGate` | 400 | 450 | — | 4 |
| WI-P5-7 `RestampCore` Trust | 450 | 500 | — | 5 |
| WI-P5-8 `mrtsrestamp` Trust | 200 | 200 | — | 2 |
| WI-P5-9 Engine clock, PTP identity, binding | 300 | 300 | — | 3 |
| WI-P5-10 Egress modules | 350 | 400 | 10 | 3.5 |
| WI-P5-11 Ingest modules | 450 | 450 | — | 4 |
| WI-P5-12 Manager UI | 150 | 150 | — | 1.5 |
| WI-P5-13 aes67-input (C-11) | 20 | 40 | — | 0.5 |
| WI-P5-14 Fixtures, protocol cases | — | 300 (+ ~17 fixtures) | — | 4 |
| WI-P5-15 Compatibility run | 120 | — | — | 1.5 |
| WI-P5-16 R11 measurement | 60 | — | — | 1.5 |
| WI-P5-17 Documents | 250 | — | 20 | 2 |
| WI-P5-18 Gate, release | — | — | — | 6 |
| WI-P5-19 ptp4l presets (from P0) | 10 | — | — | 0.25 |
| Review and rework (10 %) | | | | 5.5 |
| **Total** | **≈ 4,600** | **≈ 4,290** | **≈ 40** | **≈ 60.25** |

Lines added ≈ 8,890 including tests, plus ~17 fixtures (≤ 2 MB each).
Lines deleted ≈ 40 (text, part 6; WI-P5-4 replaces ~10 lines of
generation checks). Chapters 3 (S0), 4 (Phase 0),
5 (Phase 1) and 7 (Phase 3) are prerequisites and are not counted.

**Critical path** (two engineers, ≈ 29 working days elapsed):
WI-P5-1 (1.5) → WI-P5-2 (8) → WI-P5-3 (4) → WI-P5-10 (3.5, needs WI-P5-9)
→ WI-P5-14 (4) → WI-P5-18 (6, including the 26.5 h wrap soak), plus review
slack. The second engineer runs the Trust chain in parallel: WI-P5-6 (4) →
WI-P5-7 (5) → WI-P5-8 (2) → WI-P5-11 (4) → WI-P5-12 (1.5), which is ≈ 17
days and joins at WI-P5-14; WI-P5-9, WI-P5-4, WI-P5-5 and WI-P5-13 fit in
its slack. The item most likely to slip is V-P5-7 (R11): if the Pi 4 misses
the budget, the writer's edit path is reworked before release.

## 10. Fixture and test strategy

### 10.1 Rules

- Fixtures live in the repository under `plugins/mpegts-core/tests/
  fixtures/` (arrival traces under `fixtures/restamp/`), each ≤ 2 MB,
  with a reviewed expectation file beside it (`.expect.jsonl`,
  `.demux.jsonl` or `.expect.json`); OQ-2. No `tests/` directory ships
  to a device: WI-S0-13 excludes them from the image's `/opt` copy and
  from the dist tarball. Phase 0's clock fixtures live with their tests
  (`packages/engine/src/clock/fixtures/`, the Device Manager's
  `api/src/config/fixtures/`).
- Field captures are recorded on the gate boxes (.103, .108) by the
  assistant session that has rig access, at the start of each phase's
  fixture work, after a check of what captures already exist on .103,
  with the previous phase's image installed so the capture carries that
  phase's timing; the owner supplies a vMix feed or recording only if no
  rig can subscribe to one (OQ-3). Synthetic fixtures come from
  `plugins/mpegts-core/native/mrts/tests/fixture_gen.cpp`, deterministic,
  with the flags each phase adds.
- Four fixture forms: raw TS (`.ts`) for byte-level parsing; arrival
  traces (`.stct`, TS headers with arrival times) for the virtual STC and
  Trust; bus recordings (`.gdp`, GStreamer data protocol, which keeps
  buffer flags and the gap marker) for consumers; wire captures (`.ts`
  recorded on the receiving box) for the egress writer.
- Every TS fixture is replayed at three chunkings (188, 1316 and
  24 576 bytes) and, where a consumer reads it, through both runners after
  `mrts_cli rebase` moves its house time to the test's clock.
- Expectation files are produced once by `mrts_cli dump` (or the
  element's own output), reviewed by hand against `ffprobe` or the
  source's known behaviour, and committed; a test failure is a diff.
- The test layers, from the bottom: C++ unit tests with no GStreamer
  (`make -C plugins/mpegts-core/native/mrts test`, root `make
  native-test`); element data-flow tests (Python harnesses over
  appsrc/appsink, `packages/engine/package.json` `test:py`); protocol
  tests in both runners (`native_runner_protocol_test.py` and its Python
  runner twins); vitest module and builder tests; conformance scenarios
  that drive the real TypeScript builders in both runners; the gate checks
  of each chapter's part 11.

### 10.2 Fixtures

| Fixture | Source capture | What it pins | Phases |
|---|---|---|---|
| `syn-mpts-two-programs.ts` | `fixture_gen.cpp` (port of `native_parity_fixture.py`) | PSI discovery, program selection, CC, resync, PMT change → generation | S0, P2, P3 |
| `syn-wrap-33bit.ts` | `fixture_gen.cpp --wrap-at 5` | The 33-bit wrap on PTS, DTS and PCR; B-frame DTS behind PTS at the wrap (R19) | S0, P1 (with arrivals), P2 (`scn-align-wrap`), P3, P4 (`scn-out-wrap`), P5 (wire wrap) |
| `syn-pes-header-split.ts` | `fixture_gen.cpp` | A PES header spilling into the next packet; `PesHeaderSpan` holds one packet | S0, P1, P5 |
| `syn-pes-no-pts.ts` | `fixture_gen.cpp` | PES without PTS; no-header stream ids | S0, P3 |
| `syn-source-restart.ts` | `fixture_gen.cpp --restart` | PCR discontinuity and a multi-hour PTS/DTS jump: `Unwrapper` reseed, `PesAssembler` flush (§5.2) | S0, P1, P3 |
| `cap-mux-align7-aac-opus.ts` | audio-encoder or audio-transcoder `mpegtsmux alignment=7` on .108 | PSI between held-back PES; several PES headers per 1316-byte chunk; bounded audio PES; Opus caps | S0, P1, P2, P3, P4 |
| `cap-mux-unbounded-video.ts` | transcoder rendition on .108 | Unbounded video PES (> 64 KB) closed at the next PUSI; DTS present | S0, P3, P5 |
| `cap-occ-1080i-h264-aac-ttx.ts` | the OCC feed (the July 2026 multicast capture the .103 rig replays) | 1080i B-frames, AAC, teletext sparse PID, PCR cadence | S0, P1, P2, P3, P4, P5 (relay) |
| `cap-vmix-h264-aac.ts` | the owner's vMix, VBR mux (B-85) | A PCR only on each IDR, 2 s apart, PTS = PCR there; AAC ADTS; H.264 without DTS | S0, P1 |
| `cap-302m-bssd.ts` | audio-input-302m on .108 | 302M `BSSD` registration, one PES per buffer | S0, P2, P3, P4, P5 |
| `cap-klv-sparse.ts` | a subtitle route on .103 | Sparse private stream, gaps between cues | S0, P2, P3 |
| `cap-srt-ingest-1316.ts` | srt-input on .108 from a third-party encoder | 1316-byte datagrams, PSI anywhere, ≤ 1 PCR per chunk | S0, P1, P2 |
| `cap-cc-loss.ts` | `cap-mux-align7-aac-opus.ts` with packets removed by `fixture_gen.cpp --drop` | CC loss mid-PES | S0, P3 |
| `clockstate-synced.jsonl`, `clockstate-offline-boot.jsonl`, `clockstate-tai-late.jsonl`, `clockstate-date-step.jsonl` | `mr-clockstate` on 10.9.16.50 (Pi 5, v2.0.0.97), 2026-10-14 (`PROVENANCE.md`) | E constant under sync; one relatch(step) after an offline boot; TAI set late, a divergence at the settle cap; a manual step | P0 |
| `chronyc-{tracking,sources}-{synced,unsynced}.csv`, `clockstate-once-{synced,unsynced}.jsonl`, `clockstate-once-tai0.jsonl` | 10.9.16.50 (Pi 5, v2.0.0.97, chrony 4.8), 2026-10-14; the tai0 sample from the development Pi 5 mr-test, 2026-10-13 | `chronyc -c -n` and `mr-clockstate --once` parsing: synced, unsynced, TAI offset 0 | P0 |
| `pw-dump-fleet.json` | fleet box 10.9.16.22 (Pi 5, PipeWire 1.6.3), 2026-10-13 | PipeWire node latency | P0 |
| `trace-816-clean-cbr.stct` | CBR encoder into srt-input on .108, 15 min (#816) | Zero relocks; ppm steady; the lead wanders but the mapping does not | P1 |
| `trace-820-vmix-pcr.stct` | vMix (#820, #737) in CBR mode, 15 min; to be recorded (B-85) | PCR validation fails; degraded with the lead clamped; recovery after 30 s of good PCR | P1 |
| `trace-vmix-sparse-pcr.stct` | the owner's vMix, VBR mux, .103 (B-85) | PCR on each IDR every 2 s, steady: locks in 74 s, never degraded, cadence 2.0 s, no clamp (B-86) | P1 |
| `trace-tech01-relay.stct` | TECH01's relay of the production gate, SRT caller on .108 (B-90) | A 125 ms mux lead on a bursty path: never degraded (the lower bound reads PTS less the PCR); the PCR lock's 150 s relock pairs as the ceiling | P1 |
| `trace-836-program-split.stct` | the #836 source | One mapping for every PID | P1 |
| `trace-825-audio-swing.stct` | the #825 source | No audio swing on the output | P1 |
| `trace-812-slow-source.stct` | a slow-clock source (#812) or `fixture_gen --ppm −300` | ε locks within 60 s and holds | P1 |
| `trace-occ-1080i.stct` | OCC feed on .103 | Zero relocks; B-frame DTS mapped consistently | P1 |
| `trace-srt-restart.stct`, `trace-rist-reconnect.stct` | SRT caller stopped 5 s on .108; RIST link dropped on .103 | One relock, one gap per PID, no overlap beyond the source's rewind | P1 |
| `syn-drift-ppm.stct`, `syn-pcr-discont.stct`, `syn-rewind-1s.stct`, `syn-straddle-audio.stct`, `syn-reroute-30ms.stct`, `syn-pcr-sparse.stct`, `syn-pcr-dense-to-sparse.stct`, `syn-pcr-stop-sparse.stct`, `syn-pcr-irregular-sparse.stct`, `syn-outage-continuous-pcr.stct`, `syn-start-burst.stct` | `fixture_gen --trace` | Rate convergence; flagged discontinuity; unflagged rewind and the straddle rule (OQ-11); old-epoch PES; envelope step; a cadence change → one warning, the new cadence learned; a dense PCR turning sparse degrades once and recovers; a sparse PCR that stops degrades at 12 s and recovers; one 5 s interval warns (B-86); an outage with a continuous PCR keeps the epoch; a start burst moves the first epoch onto its floor (WI-P1-6) | P1 |
| `cap-837-programme-302m.ts`, `cap-837-key-302m.ts` | .108 after Phase 1: a RIST input's 302M programme and the key source of #837 | #837's inputs (`scn-837-ducker-mixer`, R15) | P2 |
| `cap-836-program-step.ts` | the #836 source through Phase 1's restamp on .103 | A source restart: one program, one gap, no split | P2 |
| `cap-transcoder-burst.ts`, `cap-opus-32k.ts` | transcoder rendition and audio-encoder Opus 32 kbit/s on .108 | Bursty and low-rate arrival rhythms (W learning) | P2 |
| `cap-ttx-gate01.ts` | NO-OCC-Gate01 teletext PID | Sparse teletext into the muxer | P2 |
| `bus-occ-ingest.gdp` | .103 OCC rig, srt-input after `mrtsrestamp` (Phase 2 image) | B-frames, teletext sparse, AAC on a restamped ingest | P3 |
| `bus-mux-av-klv.gdp` | .103 mpegts-muxer output | Several PIDs per buffer, PSI between PES, KLV sparse, language tags | P3 |
| `bus-transcoder-h264.gdp` | .108 transcoder rendition | Unbounded video PES at 1080p, DTS | P3 |
| `bus-audio-encoder-opus.gdp`, `bus-audio-encoder-aac.gdp` | .108 audio-encoder | Opus caps and access units; ADTS `mpegversion` | P3 |
| `bus-mixer-302m.gdp` | .108 audio-mixer egress | 302M, one PES per buffer | P3 |
| `bus-ingest-relock-gap.gdp` | .108 srt-input, source restarted twice | Gaps: the Phase 1 marker buffer, then a PTS jump | P3 |
| `bus-pmt-change.gdp` | .103 transcoder rendition switched AVC → HEVC | PMT change: generation + 1, pads re-added | P3, P5 |
| `bus-hls-player.gdp` | .103 hls-player egress | Bursty arrival; ID3 private stream; nominal-rate audio stays bypassed | P3 |
| `bus-third-party-audio.ts` | dev box, `tools/fixtures/gen-thirdparty.sh` | AC-3, E-AC-3, LATM, MPEG-2 video, DVB subtitles, ID3 (R1) | P3 |
| `syn-gap-500ms.ts`, `syn-gap-marker.ts`, `syn-private-novdesc.ts`, `syn-foreign-clock-aac.ts` | `fixture_gen.cpp --gap`, `--private-novdesc`, a +40 ppm AAC encode | Gaps with and without the marker; unknown stream; the decode ASRC engages only on a foreign clock | P3 |
| `cap-av-h264-aac-muxed.ts` | mpegts-muxer egress on .108, 1080p50 + AAC | An A/V program after a muxer | P4 |
| `cap-h264-1080p50-hi.ts` | the fleet's highest-bitrate 1080p50 feed through the restamp | Pi 5 software-decode capacity | P4 |
| `cap-hevc-1080p50.ts` | transcoder HEVC rendition on .103 | The stateless HEVC path on Pi 4 and Pi 5 | P4 |
| `cap-302m-mixer-out.ts` | audio-mixer egress on .108 (Phase 2 graph) | 302M output with a mixer arm | P4 |
| `cap-burnin-late-cues.ts` | OCC video plus its cue track on the gate | The burn-in wait by content time | P4 |
| `syn-egress-sparse-pcr.ts`, `syn-egress-no-pcr-pid.ts` | `fixture_gen --egress-sparse-pcr`, `--no-pcr-pid` | PCR-only insertion and the AF-only CC rule; PCR PID 0x1FFF assignment and PMT rewrite | P5 |
| `bus-egress-gap.gdp` | .108 bus tap, srt-input source stopped 3 s | The gap marker consumed and not sent; D_e lowered by ≤ the gap | P5 |
| `wire-mrht-v1.ts`, `wire-mrht-de-raise.ts`, `wire-mrht-reepoch.ts`, `wire-old-engine.ts` | .108 srt-output captured on .103; a 1.5 s stall; a `chronyc makestep`; the Phases 1–4 release | Golden wire format; new PMT version before a flagged PCR; `epoch_seq` + 1; no descriptor → `no-descriptor` fallback | P5 |
| `trust-ok-srt2000.stct`, `trust-tai-unset.stct`, `trust-rx-tai-unset.stct`, `trust-sender-reepoch.stct`, `trust-return.stct` | `fixture_gen --trust` | Trust holds at L = 2 s; sender and receiver TAI unset (±37 s); sender re-epoch; fallback and return | P5 |
| `trust-jitter-rist.stct` | .103 rist-input from .108, `buffer=1000`, 15 min | Real transit spread through librist; no false fallback | P5 |

### 10.3 Scenarios (conformance harnesses, both runners)

| Scenario | Harness | Pins | Phase |
|---|---|---|---|
| `scn-837-ducker-mixer` | `aligner_conformance_test.py` | #837's verification (R15): no silence-fill, programme sample-exact, ducker egress on its input's timeline | P2 |
| `scn-split-passthrough`, `scn-mux-klv`, `scn-align-absent-rejoin`, `scn-align-slow-joiner`, `scn-align-late-delivering`, `scn-align-bursty`, `scn-align-wrap` | `aligner_conformance_test.py` | Splitter bytes untouched; sparse PTS kept; absence, rejoin, slow joiner, late-but-delivering, bursty rhythm, wrap | P2 |
| `scn-out-stall`, `scn-out-gap-recovers`, `scn-out-av-after-mux`, `scn-out-video-only`, `scn-out-rate-50p-60hz`, `scn-out-rate-60p-50hz`, `scn-out-wrap`, `scn-asrc-out-drift`, `scn-out-capacity`, `scn-burnin-late-cues` | `output_conformance_test.py` | Nothing lost at a stall; lateness falls at a gap; A/V after a muxer ≤ 45 ms; video-only player; rate match; wrap; device ASRC drift; capacity alarm; burn-in waits for cues | P4 |

The `mrtsdemux` parity harness (`gst_mrtsdemux_parity_test.py`, P3)
compares the native demux with stock `tsdemux` on every recorded fixture,
with an allowlist of explained differences.

## 11. Release checklist

Three releases (OQ-13, the owner, 2026-10-12): Phase 0; Phases 1–4 with
S0, as one release; Phase 5. Each release is a RAUC image installed on
10.9.16.103 and 10.9.16.108, with every check run under both runners. The
full check tables are in each chapter's part 11. Inside the Phases 1–4
release each phase's checks also run on its development build as the work
lands (chapter 2), and the release gate (chapter 8 WI-P4-16) runs the
union below on the release image.

| Release | Measured on the gate boxes | Pass criteria (summary) | Deleted in the release | Release-note items (R12 behaviour changes marked) |
|---|---|---|---|---|
| 0 (chapter 4) | V1–V15: daemons, kernel TAI offset, E agreement between boxes, start wait synced and offline, step detection, 24 h soak, PTP on/off, lateness accuracy, added latency sums, output lateness meaning, CPU, manager traffic, Device Manager Time page, kill switch gone | No htpdate/timesyncd; chronyd synced in 2 min; `taiOffsetS == 37` on both; E within 10 ms between boxes; untraceable start at 30 s ± 1 s; re-epoch on a 2 s step within 1 s; no false re-epoch in 24 h; one daemon at a time under PTP; lateness 500 ms ± 5 ms in both runners; ≤ 1 % of a core per module; ≤ 10 % more manager traffic | htpdate recipe and package; timesyncd; the PTP displacement record and restore logic; `aes67_clock.py`; `MR_TIME_SYNC_CONTRACT`, `ClockAuthority`, `gst-net-clock.py`, the audio-decoder `clockSync` setting (OQ-4) | chrony replaces htpdate and timesyncd; chrony off where PTP is on; NTP servers are set on the Device Manager's Time page (default the public pool, DHCP servers accepted; OQ-6); modules wait up to 30 s for time sync after boot; every module shows lateness and added latency, labelled, with no alarm yet (OQ-8); the kill switch and `clockSync` are gone. R12: lateness reads near 0 at ingests and D-dominated at outputs until Phases 1 and 4 |
| 1–4 with S0, one release (chapters 3, 5, 6, 7, 8; OQ-13) | S0: plugin loaded by both runners, `mrts_bench` ≤ 1.0 / 2.0 µs per packet on .108, ABI guard (start-but-warn with a stand-in, fail without one), no regression in the frozen model. Phase 1, V-P1-1…11 on the release image: lock on a clean feed, identity on the bus, restart, discontinuity and rewind, degraded fallback, live O and trim, ASRC, video-encoder, audio-encoder, CPU, runner parity (V-P1-12…19, the consumers of the day keeping K constant, are development checks on the Phase 1 build and are not re-run on the release). Phase 2, V1–V12: #837's scenario, splitter pass-through, muxer keeps sparse PTS, absent and rejoin, slow joiner, late-but-delivering, audio-output-302m fan-in, ducker on content time, CPU, 24 h soak across a bus-PTS wrap, nothing anchored left. Phase 3, V1–V13: formula exactness at transform producers and the muxer, presentation legs unchanged, subtitles, decode ASRC engages only on foreign clocks, aes67-output and 302M fan-ins, output ASRC replaces skew slaving, CPU, PMT change, wrap, nothing re-estimated, 24 h soak. Phase 4, V-P4-1…11: no video frame lost, stall and gap behaviour, Pi 5 software H.264 capacity, ASRC at the device, A/V after a muxer, rate match, video-only player, no late-drop settings anywhere, queue capacity fault, CPU and memory, settings and rollback to the Phase 0 release | S0 and Phase 1: 0 relocks in 24 h on a clean feed; stamp = `PES − 1 h` on every producer; one relock and one gap per restart; degraded warning within 10 s and lead ≤ 4 s on vMix; `avskew` moves by the trim ± 2 ms; 302M PTS deltas = sample count / 48 kHz ± 1 tick over 1 h; restamp CPU ≤ today's stamper + conditioner. Phase 2: silence-fill 0 %; programme offset 0 samples; PES crc32 identical through the splitter; KLV PTS unchanged (0 ticks); absence warning within W + 20 ms with continuous output; one gap ≈ the joiner's lateness; runner CPU ≤ the Phase 1 build + 10 %; zero anchored log lines in the soak. Phase 3: egress PES PTS = input PES PTS, 0 ticks, every AU; render lateness within ± 1 ms of the Phase 2 build; `cueLate` ≤ one frame on 95 % of cues; foreign stream engaged within 30 s, house stream bypassed for 1 h; zero skew corrections in 2 h; runner CPU ≤ the Phase 2 build; zero `tsdemux` demuxers in pipeline logs. Phase 4: `replaced = discarded = rate-drops = 0` at 50p on 50 Hz for 1 h; lateness + 2 s ± 40 ms after a 2 s stall with zero loss, back to baseline after a gap; render-lateness drift < 5 ms over 1 h; A/V after a muxer ≤ 45 ms; 60p → 50 Hz drops exactly 1 in 6; no `qos=true`, `max-lateness ≠ −1` or `sync=true` on any presentation sink; `Lateness trend` positive within 4 min of a throttled decoder with no `capacity` alarm (OQ-34), `queue-full` at overrun | Phase 1: `conditionStepMs` end to end; the moved bodies of chapter 3 part 6.1; every `tests/` directory from `/opt/media-router` (WI-S0-13). Phase 2: the anchored stamper, conditioner, latch repair and drift servo (their Python twins stay as reference, OQ-1); `gst_stamp_probe.py`; the splitter's stamper and parity vitest; `unixfd-fanout.py`; `latchRepair.ts`; `preserveSourceTimeline`; the input stall watch; the engine-side ducker; `mixLatencyMs`, `queueLeaky`, `queueDepthMs`, `preserveSourceTimeline` settings. Phase 3: branch alignment and per-AU retime in both runners; `alignBranchesToStamps`; `mrpeshouse` and the subtitle K recovery; the last runtime importers of the `ts_timeline` twin; skew slaving and the audio-decoder `slaveMethod` setting; `subtitleDelayMs` (OQ-24); `tsparse` in `buildTsUdpInput` (OQ-26). Phase 4: route-head D, the head walk, raises, rebase, the backlog shedder (engine and both runners); `playoutOffsetMs`, `lipSyncMs`, `syncOffsetMs`, the six OQ-29 settings; `MR_PLAYOUT_OFFSET_MS`, `MR_PLAYOUT_REANCHOR`; the leaky ES queue and `bufferMs` sizing; `audio302mTiming.ts` | One note for the release, drafted in chapter 8 WI-P4-15 with the Phase 1–3 items folded in. New settings: Ingest Offset and Per-PID Trim; audio-encoder `srcBufferMs` range 40–85 ms (OQ-16). Removed settings, nothing migrated and no output-side replacement: Playout Offset, Lip-Sync Trim, Sync Trim, Subtitle Sync Delay, Mix Latency, Sync, Buffer, Sync Method, Low-Latency Sync, Sink Buffer, `queueLeaky`, `queueDepthMs`, `preserveSourceTimeline`; a rollback to the Phase 0 release restores the stored values. R12: outputs are earlier than before (D was 60 ms by default, up to 10 s) and talent-loop offsets must be re-set; a direct ingest → player + decoder route is no longer aligned, route through a muxer; nothing is dropped for lateness and a backlog persists until a gap; the muxer no longer restarts on a dark input (it continues and alarms); mixers add the latency of their slowest input instead of dropping it, and the pace never falls by itself; the ducker follows content time; hls-player's stream is on house time (OQ-18); a late sparse cue is played late, not dropped; burn-in waits by measured lateness; audio outputs no longer drop or insert samples for clock drift; an audio decoder fed an A/V stream plays its first audio PID (OQ-28); a stream type the demux does not cover is named on the module instead of disappearing; capture latency becomes visible; a Phase 0 box re-anchors a new box's stream once. No interim-latency item: no release presents at `stamp + D` on source-natural stamps (OQ-13) |
| 5 (chapter 9) | V-P5-1…12: wire format, origin alignment by construction on two boxes, transit check with fallback and return, bound from the SRT latency, D_e follows lateness, third-party receivers, R11 egress CPU, network wrap, mixed versions, PMT version bumps, aes67-output on the network timescale, UI | One `MRHT` v1 per program, wire PTS = `bus_to_net(bus PTS)`, PCR interval ≤ 40 ms, every jump flagged; A/V at the far mux within ± 2 ms of the source over 1 h; fallback within 1 s on a 37 s TAI error with no backward PTS; ≤ 2 % of a core per egress at 10 Mbit/s, ≤ 16 % for eight; no fallback across the wrap; no pad change on a version-only PMT bump | No code mechanism; the pass-through text in srt-output, mpegts-ip-output, `tsHelpers.ts` and the design doc's three "today" statements | Timing Mode and Trust Tolerance on the three network ingests; offset and trim greyed in Trust with the reason. R12: wire PTS are now TAI and every D_e change is a flagged PCR discontinuity that third-party receivers see; Phase 0's time sync must be deployed on both ends for Trust; a Trust fallback switches at once, a return and an operator's mode change wait up to 30 s for a natural gap (OQ-35); the ptp4l presets now step on first lock only (WI-P5-19, deferred from Phase 0) |

## 12. Effort and critical path

All figures are planning-grade (±40 %). Lines are source at this
repository's comment density, tests included; days are engineer-days
including review. The per-item tables are in each chapter's part 14.

| Chapter | Lines added | Lines deleted | Engineer-days | Elapsed on the critical path |
|---|---|---|---|---|
| 3 S0 shared TS module | ≈ 3,480 (1,770 production, 1,710 test) | ≈ 150 now; ≈ 7,250 scheduled for Phases 2–3 | 18 | ≈ 10 working days: capture session → `ts_pes` → conformance → plugin → loaders; WI-S0-1, -2, -4, -5 in parallel |
| 4 Phase 0 | ≈ 4,450 | ≈ 1,430 | 28.25 | ≈ 11.5 working days with two engineers (lateness track 10 d; clock and image tracks in parallel) |
| 5 Phase 1 | ≈ 8,410 (4,550 production, 3,860 test) | ≈ 270 | 61.5 | ≈ 30 working days after S0's core: `RestampCore` 8 d → element 4 d → tuning 2 d → ingests 2 d → gate 6 d; the ASRC chain and the UI on a second engineer |
| 6 Phase 2 | ≈ 6,630 | ≈ 9,580 | 41.5 | ≈ 19 working days with three engineers (aligner track 18.5 d; demux and deletion tracks in parallel) |
| 7 Phase 3 | ≈ 5,730 | ≈ 10,800 | 50 | 28–31 working days with three engineers (capture session → `DemuxCore` 5 d → `mrtsdemux` 7 d → parity 3 d → consumer cut-overs ≈ 5 d → deletions 4 d → gate 4 d) |
| 8 Phase 4 | ≈ 7,090 | ≈ 9,450 | 46.5 | ≈ 26.5 working days with two engineers (video track: behaviours → 0008 patch → `mrvideopace` → video-player → deletions → scenarios → gate) |
| 9 Phase 5 | ≈ 8,890 (4,600 production, 4,290 test) | ≈ 40 | 60.25 | ≈ 29 working days with two engineers (writer chain; the Trust chain ≈ 17 d in parallel) |
| **Total** | **≈ 44,700** | **≈ 31,700** | **≈ 306** | see below |

About 45 % of the added lines are tests. The deleted lines are the
mechanisms §11.4 names (anchored stamping and the conditioner, branch
alignment and retime, subtitle K recovery, lateness handling, route-head
D) with their tests; the Python reference modules under
`plugins/mpegts-core/py` stay (OQ-1), and chapter 3 part 6.2 schedules
their exit from the runtime paths.

**Critical path across releases.** Three releases (OQ-13, the owner,
2026-10-12). Phase 0 ships alone: ≈ 11.5 working days, 28.25
engineer-days. Then one release carries S0 and Phases 1, 2, 3 and 4,
developed in that order: 18 + 61.5 + 41.5 + 50 + 46.5 = 217.5
engineer-days after Phase 0, on a critical path of S0 core (10) →
Phase 1 (30) → Phase 2 (19) → Phase 3 (28–31) → Phase 4 (26.5) ≈ 113–117
working days. Phase 5 (60.25 engineer-days, 29 working days) ships after
it. Serial, that is ≈ 155–160 working days of elapsed time, about 32
weeks, with two to three engineers at any time. Development overlaps
where the dependencies allow: Phase 0 and S0 share no code and run
together from day one (S0's core needs only the capture session, OQ-3);
inside the Phases 1–4 release each phase's development starts on the
previous phase's branch while that phase's part 11 checks run on its
development build. With that overlap the elapsed time is ≈ 125–135
working days. The consequence of the grouping: the Phases 1–4 release
carries all four phases behind a single gate verification (chapter 8
WI-P4-16, chapter 11), so nothing of Phases 1–4 reaches the field until
Phase 4's checks pass, and a fault found at that gate in any of the four
holds the whole release; in exchange no release ever presents at
`stamp + D` on source-natural stamps, and the release image installs fall
from six to three. Four steps serialise everything and cannot be
overlapped: the capture sessions that need the previous phase's build on
the gate boxes (the Phase 0 release for Phase 1; development builds for
Phases 2, 3 and 4), the one RAUC image per release installed on both
boxes before its checks run, Phase 2's deletion of the anchored stamper
(Phases 3 to 5 build on identity egress), and Phase 5's dependency on
Phase 0's chrony being in the field (§13.1 Q1).

**Items most likely to slip:** the Pi 4 ASRC bench (chapter 5 WI-P1-8,
R5); the non-live aggregator behaviour pinned first in Phase 2 (WI-P2-1,
R-P2-1); the waylandsink patch 0008 and its deadlock history (chapter 8
WI-P4-2); the Pi 5 software H.264 capacity (V-P4-3); the R11 egress budget
on a Pi 4 (chapter 9 V-P5-7).

## 13. Verification notes

Each draft chapter was cold-checked by a verifier against the design
document and the trees (submodule `fc17468`, the Yocto layer, the local
GStreamer 1.28.2 sources). This chapter records the verdicts, how every
blocker and major finding was resolved, which minor findings were fixed in
the text, and what could not be verified. "Fixed" means the chapter's text
was corrected during assembly. The draft question ids are given as
`S0-n`, `P0-n` … for cross-reference with the register's "draft" column.

### 13.1 Chapter 3, S0 — verdict: issues (one major, nine minor)

- **Major, fixed.** WI-S0-1 and part 6.1 scheduled `ts_timeline.cpp:210–281`
  for deletion in Phase 1; only :210–222 and :277–281 are the pure
  functions, :224–275 are `TimelineLatch`/`TimelineStamper` code the
  frozen model runs (Phase 2's deletion), and `unwrap_near` depends on the
  anonymous `mod_wrap` (:138–143). Both places now cite :210–222,
  :277–281 and `mod_wrap`.
- Fixed: part 6.2 and part 14 now keep `ts_psi.py` with the tsProbe files
  (kept row 1,185 lines, twins deleted in Phases 2–3 ≈ 3,525, total
  ≈ 10,800 — superseded 2026-10-12: the owner keeps every `py/` module as
  reference, OQ-1, and the total now reads ≈ 7,250), as the default of
  OQ-1 said (`ts_video_info.py:13` imports
  `ts_psi`); the `ts_split` fold-in row is split between Phase 1 (walker,
  WI-S0-6) and Phase 2; part 4.1 and part 4.4 say `mrpeshouse` is
  untouched except its Makefile's link form; part 9 says "after Phase 3";
  the engineer-day sum reads 17 (18 after the owner's answers of
  2026-10-12: WI-S0-8 start-but-warn, WI-S0-13); the parity vitest is 130
  lines and
  `tsFixtures.ts` stays (two other suites import it); the `mrtsstamp`
  Makefile lines are :4–8, 24, 34–35; part 7.2 gains
  `syn-source-restart.ts` for the §6 "gaps" item; the draft's S0-3 is
  part 4.5 rule 6 (C-1), decided by §13.1 at assembly and overruled by the
  owner on 2026-10-12 (start but warn).
- Also corrected from the verifier's unverifiable notes: WI-S0-6's reason
  why `build-native-dev.sh` keeps working (its command-line `CXXFLAGS`
  override the `+=`, so the Docker archive is non-PIC and no `.so` is built
  there); the 2026-08-05 incident is now cited to the project's deploy
  notes (it is not recorded in the repository).
- Unverifiable: that the dist tarball carries no native binaries (no
  packaging script in the submodule; consistent with the deploy notes);
  the Pi 4 µs-per-packet budget and the identity of .108 as a Pi 4 (device
  facts; the historical measurements quoted from `gstmrtsstamp.cpp` are
  present in the file); whether `oe_runmake` preserves `CXXFLAGS += -fPIC`
  under Yocto (not built here); the four user elements' behaviour, planned
  in their own chapters.

### 13.2 Chapter 4, Phase 0 — verdict: pass (nine minor)

- Fixed: WI-P0-8's engine guard now names the new
  `resolveNativeAsset(pluginId, tool, file)` in `nativeBinaries.ts`
  (today's `resolveNativeBinary` cannot find a `.so` under
  `native/mrlateness/`); WI-P0-5 lists the four other `timeSyncContract`
  readers (`GstChildProcess.ts`, `PythonProcess.ts`, `ModuleManager.ts`,
  `ts-splitter/engine/nativeRunner.ts`) and its acceptance grep includes
  `timeSyncContract`; WI-P0-2 gained step 5, the ptp4l preset change to
  `step_threshold 0.0` with `first_step_threshold 1.0` so the clock steps
  on first lock only (§10.2), checked by V8 (since deferred to Phase 5,
  WI-P5-19; the note below); R-P0-2 cites tzdata 2026b;
  OQ-4 asks only in which phase the kill switch goes (§4.1 and §13.1
  decide that it goes); OQ-8 asks only the alarm's default (§14 row 0 →
  §9.5 ships it; the owner deferred the alarm on 2026-10-12); OQ-7 is
  reworded as "may the kernel state stand in for
  the daemon's state" and WI-P0-4 reads `chronyc -c tracking` for display;
  four line slips corrected (`OwnedWarning` at :32, the htpdate bbappend
  15 lines / 41 deleted, the PTP recipe 80 lines, `_apply_net_clock`
  :1876–1944); two "waits on" tags added.
- The ptp4l preset change (the draft's WI-P0-2 step 5) is a behaviour
  change on PTP boxes that the verifier offered as one of two options; the
  other was to defer it to Phase 5 and rely on WI-P0-3/4's step detection
  meanwhile. Decided 2026-10-12 by the orchestrator (owner delegated):
  deferred. It is now chapter 9 WI-P5-19 (10 lines, 0.25 day); WI-P0-2
  and V8 no longer carry it, and WI-P0-2's estimate reads 0.75 day.
- Unverifiable: chrony 4.8 accepting `leapseclist` (no tarball locally;
  added in 4.5 by recollection); linuxptp clearing `STA_UNSYNC` and
  leaving a hand-set TAI offset alone (R-P0-3, V8); whether an `ADJ_TAI`
  change cancels a `TFD_TIMER_CANCEL_ON_SET` timerfd (R-P0-5; the 1 s
  divergence poll catches it either way); whether `tzdata-core` is in
  today's image (no manifest locally; the plan adds it explicitly);
  upstream `chronyd.service` sandboxing against `/data/chrony`; the
  effort estimates; every on-device claim and V1–V15.

### 13.3 Chapter 5, Phase 1 — verdict: issues (one major, six minor)

- **Major, fixed.** The gap marker (draft P1-2: PTS = gap start,
  `duration` = gap length) would be leaked by srt-input's `queue leaky=2
  max-size-time=100000000` directly after the restamp, because `GstQueue`
  accounts a buffer's duration into its time level and `leaky=2` discards
  from the head while the queue reads as full — a scheduler race on the
  most common ingest, which the draft's tests (no module queue) would not
  catch. OQ-12's default is now a marker with PTS = the gap's end and no
  duration, the length carried in the adaptation field's private data;
  WI-P1-4's acceptance and part 7.3 gain the leaky-queue case and a
  module-level srt-input case; chapters 7 and 9 read the revised form.
- Fixed: an outage is no longer an unconditional re-lock trigger (the
  first post-outage PCR goes through the leap check; §5.2's "a sending
  engine causes no re-lock when it restarts"), with the fixture
  `syn-outage-continuous-pcr.stct`; OQ-15 asks only about the per-PID trim
  on captures (§5.5, A.3, §11.1 and Q11 answer O), and the "waits on"
  marks on the O parts of WI-P1-11…13 and part 8 are dropped; OQ-17's
  reason is corrected (an element can push from its own task) and its
  default is markers at detection and every 250 ms; OQ-13 stated that its
  default needed a Q2 exception and named the conforming alternative (the
  owner then decided, 2026-10-12, that Phases 1–4 ship as one release, so
  neither applies: WI-P1-16 and V-P1-17 are removed and no Q2 exception
  remains); the dependency lists of WI-P1-11, -12, -13 and the OQ-17 mark
  on WI-P1-4 are complete; `avskew` is not in the submodule, so WI-P1-17
  checks it in under `tools/avskew/`.
- Unverifiable: everything inherited from chapter 3 (names, fixtures,
  loaders, the hot-deploy path); whether `mrts_cli` gains `dump` (it does,
  chapter 3 WI-S0-6); the Phase 0 names relied on; the inventory JSON (not
  read by that verifier); all device-side claims and V-P1-1…19; the
  per-item sizing; pipewiresrc PTS behaviour (R-P1-9, a spike is planned);
  `audio-resampler.c`'s filter selection at the scaled rates.

### 13.4 Chapter 6, Phase 2 — verdict: issues (two major, four minor)

- **Major, fixed.** subtitle-core's Python tests and the `mrpeshouse`
  vector generator instantiate the Python `TimelineStamper` that WI-P2-3
  deletes (`subtitle_pack_test.py:56`, `subtitle_ts_engine_test.py:138`,
  `subtitle_peshouse_gst_test.py:40, :123`, `subtitle_stamp_dump.py:42`);
  two of them run in subtitle-core's `test:py`, which the root `pnpm test`
  chain invokes. WI-P2-3 and part 6.1 now retire `subtitle_stamp_dump.py`
  (its vectors file stays checked in) and port the three tests to a local
  identity stamp; the acceptance list includes subtitle-core's `test:py`.
  This also closes chapter 7's draft P3-10 (C-8).
- **Major, fixed.** The draft's P2-4 default discarded a late sparse
  cue, which §13.1 ("nothing after ingest is discarded for being late",
  P11) forbids, and §6 item 4 with R21 answers the question: part 4.6,
  WI-P2-6 and part 10 now forward the cue at its own PTS with the alarm
  and the pace raise, and say explicitly that producer-side sparse gaps
  (§11.5 item 10) are deferred to Phase 3 because `tsdemux` would not
  forward them (C-3).
- Fixed: WI-P2-2's acceptance grep names the three comment edits it
  needs; `preserveSourceTimeline` is listed as an operator-visible setting
  in part 8 and WI-P2-3 (the two manifests, `manifestHelpText.test.ts`);
  "waits on" marks added to WI-P2-2 and WI-P2-3; the draft's P2-3,
  P2-6 and P2-8 are closed as answered by the design (C-2, C-4,
  C-5), keeping their defaults; WI-P2-5 gains the hls-player move that no
  Phase 1 item does (OQ-18, merged with chapter 5's question), unestimated.
- Unverifiable: everything inherited from chapters 3, 4 and 5; OQ-18's
  premise about the remaining anchored users; the "2026-08-05 skew rule"
  (now cited to the deploy notes); `audiointerleave` in
  `libgstaudiomixer.so` on the built image (verified on the dev box's
  1.28.2 only); all field fixtures and V1–V12; WI-P2-1's premise that a
  non-live aggregator never times out (the plan makes it a test); whether
  `preserveSourceTimeline` runner code is dead after Phase 0 (OQ-4, now
  answered: Phase 0); the effort figures.

### 13.5 Chapter 7, Phase 3 — verdict: pass (seven minor)

- Fixed: WI-P3-17 no longer claims a K-recovery sentence in
  `subtitle-core/package.json` (there is none) and cites the full paths of
  the two `ts_timeline.h` includes; the "2026-08-05 skew rule" is stated
  inline; WI-P3-1 and WI-P3-2 say they wait on WI-P3-3's fixtures, so the
  list order and the critical path agree; the draft's P3-2 (output ASRC
  in Phase 3: §14 row 3, §8, §15), P3-3 (foreign clock measured from
  PTS deltas: §5.4) and P3-10 are closed (C-6, C-7, C-8) with the
  defaults kept as recorded engineering choices; OQ-20 cites §13.1 Q7 and
  §11.1 as leaning to yes.
- Unverifiable: artefacts of chapters 3–6; what Phase 2 leaves of
  `ts_timeline` (≈ 100 / 115 / 255 lines); the capture session, the Pi 4
  bench and V1–V13; GStreamer behaviours read but not executed
  (`GstFlowCombiner` NOT_LINKED semantics, the custom-slaving contract
  under `sync=true`, tsdemux's sparse GAP cadence); the inventory JSON
  (re-derived by grep: the ten `tsdemux` strings are complete).

### 13.6 Chapter 8, Phase 4 — verdict: issues (one major, eleven minor)

- **Major, fixed.** WI-P4-6 and part 4.2 claimed the player passes a
  refresh rate as `refresh-mhz`; nothing in the player resolves one
  (`westonOutput.ts:113–122` discards the `@rr` group,
  `renderTarget.ts:190–194` returns width × height only), so the kmssink
  path had no refresh source. WI-P4-6 gains the sub-item (libdrm
  `vrefresh` or a measured `show_frame` period; `@rr` captured for the
  Weston fallback), +1 day, and V-P4-6 gains a KMS case; part 14 and the
  critical path read 46.5 days / 26.5 days.
- Fixed: three citations prefixed `packages/engine/`; the part 3.7 grep
  scoped so `MpegTsProbe.ts` can appear; `plugins/README.md:1040` and
  `:2136–2145` added to WI-P4-15 and part 6.5 with a wider acceptance
  grep; `MediaRouter.ts:651–686`; `tsHelpers.ts:100–114` for the doc
  edit; 13 contract pins and the child-process path of
  `nativeRunner.test.ts`; the cadence hold of `mrvideopace` recorded as a
  §13.3 engineering choice and listed for the owner; WI-P4-5 states why
  runner glue is exempt from the no-twin rule; OQ-30's default became
  "replace" (`leaky=0`), as §8, §11.3 item 7 and R9 say, with the
  `leaky=2` backstop as the recorded deviation (the decision of
  2026-10-12 took the deviation; the note below); the draft's P4-8 is
  closed (C-9, §11.1 egress), P4-1 merged into C-6, P4-4 merged with
  OQ-24 (default Phase 3), OQ-29 kept as the §13.3 owner notice, OQ-34
  made a module setting (§9.5; since deferred, 2026-10-12); dependency
  marks were added to WI-P4-3, -5, -7, -8 and -13.
- Notes for the owner: the cadence hold (`r_k = max(a_k, r_(k−1) +
  Δ_k)`) is not in §8's text and changes what an operator sees after a
  stall; the twin exemption for runner glue is an interpretation of
  §11.5's scope. The third note, that flipping OQ-30 to `leaky=0` reopens
  the gate01 deadlock concern that `busHelpers.ts:157–172` records (which
  patch 0001's skip-and-kick was expected to cover), was decided on
  2026-10-12 by the orchestrator, owner delegated: the bus ingress queue
  and the producer fan-out branch stay `leaky=2` at their 5 s / byte-cap
  capacity, reclassified as an alarmed resource-fault backstop (an
  overflow there is a resource fault, §8 and R9, not a lateness policy);
  WI-P4-5, WI-P4-13 and chapter 8 part 4 say so. OQ-34 was decided the
  same way the same day: the capacity alarm is deferred like the lateness
  alarm (OQ-8); Phase 4 shows the lateness trend with a label, no alarm,
  no setting (WI-P4-12, chapter 11).
- Unverifiable: artefacts of Phases 0–3; the device numbers WI-P4-1/-2
  will pin (Weston frame-callback timing, `wp_presentation` support, Pi 5
  `avdec_h264` capacity, pulsesink clock noise); exact sub-ranges inside
  the patched `gstwlwindow.c`; the effort estimates (arithmetic checked);
  the `wayland-protocols` version claim (1.45 is a lower bound; the tree
  ships 1.47).

### 13.7 Chapter 9, Phase 5 — verdict: pass (seven minor)

- Fixed: the draft's P5-2 and P5-5 are closed by §13.1 Q13 ("while
  an ingest is Trust-selected") with §5.4, §11.1 and §10.4 for `ptpSync`
  (C-10, C-11), and their qualifiers and "waits on" marks are removed;
  OQ-35 is one self-consistent question (every switch at once, or wait for
  a natural gap) with §10.4:884–885 cited, and the state table and WI-P5-6
  follow it (decided 2026-10-12 as a blend: fallback at once, return and
  operator change wait up to 30 s for a natural gap; the design doc's
  §10.4 now says so); R19's "test mode that places a wrap minutes after start" is
  carried in: WI-P5-9 adds the `MR_HOUSE_CLOCK_E_OVERRIDE_NS` override,
  V-P5-8 runs against it and the 26.5 h real-wrap soak is optional; the
  added total is 4,590 / 8,880; WI-P5-17 and WI-P5-18 have acceptance
  bullets and WI-P5-7 its dependency line; `media-router-ptp-setup.sh:32`
  and `tsmuxcommon.h:103–109`; the ISO clause reference no longer reads
  as a design-doc section.
- Unverifiable: artefacts of chapters 3, 4, 5, 7 and 8 (none exists at
  `fc17468`; `PsiDiscovery` and `house_from_mux_pts` do, and ADR
  numbering ends at 0028); everything that needs a device (the two-box
  PTP bench, `pmc` on `/var/run/ptp4lro` as the engine user, V-P5-1…12);
  that `'MRHT'` collides with no registered SMPTE-RA identifier; GStreamer
  memory-sharing behaviour the WI-P5-3 acceptance relies on (the 16-memory
  limit was confirmed); the cross-phase placement claims (`lat_egress`
  before each sink, `mrtsrestamp` directly after the transport element).

### 13.8 Cross-chapter inconsistencies found during assembly

- The S0 draft numbered its sibling sections by phase ("section 01" for
  Phase 1) while every other draft numbered them by file; all cross-
  references now name chapters.
- Chapter 5's draft put hls-player's move to house time in Phase 2 while
  chapter 6's draft assumed Phase 1 had done it; one question (OQ-18) and
  one work item (WI-P2-5) now carry it.
- Chapters 7 and 8 answered "which phase removes `subtitleDelayMs`"
  differently (Phase 3 and Phase 4); one question (OQ-24), default
  Phase 3, with WI-P4-9 reduced to a check.
- Chapters 7 and 8 drew the output-ASRC boundary differently (device mode
  on custom slaving in Phase 3; a fixed-ratio converter in Phase 3 and the
  servo in Phase 4); the design decides it (C-6), and WI-P4-4, WI-P4-7 and
  R-P4-11 now describe Phase 4 as the switch of evidence source and
  `sync=false` on the one `mrasrc` instance.
- Chapters 5, 6 and 9 cited the draft's S0-3; all now cite chapter 3
  part 4.5 rule 6.
- The gap marker's form (OQ-12) is read by chapters 6, 7 and 9; their
  text follows the revised default.
- Chapters 3, 6 and 7 cited "the 2026-08-05 skew rule" as if recorded in
  the repository; it is in the project's deploy notes only, and the rule
  is now stated inline (chapter 2).
- The inventory file `02-inventory.json` was read by the chapter 3, 5 and
  6 authors and re-derived by grep by the chapter 7 verifier; no chapter
  depends on it beyond the `tsdemux` string list and the codec list, both
  re-checked in code.
- Added 2026-10-12, after the owner's decision on C-1 (start but warn):
  chapter 3 part 4.5 rule 6 has an `identity` stand-in for every
  pass-through element, but `mrtsdemux` (Phase 2's select mode, Phase 3's
  demux mode) has none. Decided the same day by the orchestrator, owner
  delegated: a module whose native demux cannot load fails with the
  rule-6 alarm text; start-but-warn applies only where a pass-through
  stand-in exists (the restamp, the egress writer, the alignment watch).
  Rule 6, WI-S0-8, chapter 6 WI-P2-7, chapter 7 WI-P3-2 and part 10, and
  the C-1 row of chapter 15 say so.

## 14. File index

Every path this plan touches, grouped by area, with the phase (S0 ships
with Phase 1, in the Phases 1–4 release) and whether the path is added (A), changed (C) or
deleted (D). Existing paths were checked against the submodule at
`fc17468` and the Yocto layer; added paths are the names the chapters
give them. Tests sit beside the file they test unless named.

### 14.1 Submodule: `plugins/mpegts-core`

| Path | Phase | Fate |
|---|---|---|
| `native/mrts/ts_house.{h,cpp}`, `tests/ts_house_test.cpp` | S0; C in P2 (`IdentityStamp`) | A |
| `native/mrts/ts_packet.{h,cpp}`, `ts_pes.{h,cpp}`, `ts_pcr.{h,cpp}` and their tests | S0 | A |
| `native/mrts/ts_psi.{h,cpp}`, `tests/ts_psi_test.cpp` | S0 (generalised), P3 (forwarders deleted), P5 (`es_generation`) | C |
| `native/mrts/ts_split.{h,cpp}`, `tests/ts_split_test.cpp` | S0 (walker), P2 (pass-through) | C |
| `native/mrts/ts_timeline.{h,cpp}`, `tests/ts_timeline_test.cpp` | S0, P1 (moves, `conditionStepMs`); P2 (cut to `timing_pes`); P3 | C, then D (P3) |
| `native/mrts/mrts_cli.cpp` | S0 (`dump`), P1 (`trace2jsonl`, `restamp-replay`), P2 (splitter mode deleted), P3 (`rebase`), P5 (`pcrcheck`, `hcdesc`, `dump --net`) | C |
| `native/mrts/Makefile`, `native/build-host.sh` | S0 (`-fPIC`), P5 | C |
| `native/mrts/tests/ts_conformance_test.cpp`, `fixture_gen.cpp`, `mrts_bench.cpp` | S0; the generator and bench gain flags in P1–P5 | A |
| `native/mrts/lateness.{h,cpp}`, `tests/lateness_test.cpp` | P0 | A |
| `native/mrts/ts_stc.{h,cpp}`, `ts_trace.{h,cpp}`, `ts_restamp.{h,cpp}`, `asrc_servo.{h,cpp}` and their tests, `tests/restamp_replay_test.cpp` | P1; `ts_restamp` and `asrc_servo` C in P3/P4/P5 | A |
| `native/mrts/align_watch.{h,cpp}`, `tests/align_watch_test.cpp` | P2 | A |
| `native/mrts/demux_core.{h,cpp}`, `tests/demux_core_test.cpp` | P3 | A |
| `native/mrts/video_pace.{h,cpp}`, `tests/video_pace_test.cpp` | P4 | A |
| `native/mrts/ts_egress.{h,cpp}`, `ts_hcdesc.{h,cpp}`, `ts_trust.{h,cpp}` and their tests, `tests/ts_egress_replay_test.cpp` | P5 | A |
| `native/mrtshouse/gstmrtshouse.cpp`, `mrtshouse_abi.h`, `Makefile` | S0; the factory table grows in P1–P5 | A |
| `native/mrtshouse/gstmrtsrestamp.cpp` | P1; C in P5 (Trust properties) | A |
| `native/mrtshouse/gstmrasrc.cpp`, `tests/asrc_bench.c` | P1; C in P3 (bypass, device mode), P4 (timer evidence) | A |
| `native/mrtshouse/gstmralignwatch.cpp` | P2 | A |
| `native/mrtshouse/gstmrtsdemux.cpp` | P2 (select mode); C in P3 (demux mode), P5 (same-program rule) | A |
| `native/mrtshouse/gstmrvideopace.cpp`, `tests/mrtestaudiosink.c` | P4 | A |
| `native/mrtshouse/gstmrtsegress.cpp` | P5 | A |
| `native/mrlateness/gstmrlateness.cpp`, `Makefile` | P0 | A |
| `native/mrtsstamp/gstmrtsstamp.cpp` | P1 (GAP pass-through, base-aware identity, `condition-step-ms` deleted), P2 (anchored path deleted) | C |
| `native/mrtsstamp/Makefile` | S0 (links `libmrts.a`) | C |
| `native/mrpeshouse/Makefile` | S0 (links `libmrts.a`) | C |
| `native/mrpeshouse/` (element, `pes_walk`, `stamp_model`, tests, vectors) | P3 | D |
| `py/ts_timeline.py`, `py/ts_timeline_test.py` | P1 (`condition_step_ns`); kept as reference from P2 (OQ-1), out of every runtime path after P3 | C |
| `py/ts_split.py`, `py/ts_split_test.py`, `py/native_parity_ref.py`, `py/native_parity_fixture.py` | kept as reference (OQ-1); in no runtime path | — |
| `py/ts_psi.py`, `py/ts_psi_test.py`, `py/ts_video_info.py`, `py/sps_parse.py`, `py/ts_video_info_test.py` | kept (OQ-1) | — |
| `tests/nativeSplitParity.test.ts` | P2 | D |
| `tests/hlsPipeReference.test.ts` | S0 | A |
| `tests/fixtures/` (and `fixtures/restamp/`, `fixtures/demux_parity_allow.json`) | S0, P1–P5 | A |
| `README.md`, `package.json` | S0, P2, P3 | C |

### 14.2 Submodule: `packages/engine` native and runners

| Path | Phase | Fate |
|---|---|---|
| `native/mr-clockstate/{main.cpp, clock_sample.h, clock_sample.cpp, Makefile, tests/clock_sample_test.cpp}` | P0 | A |
| `native/mr-gst-runner/native_plugins.{h,cpp}` | S0 | A |
| `native/mr-gst-runner/no_late_drop.{h,cpp}` | P4 | A |
| `native/mr-gst-runner/Makefile` | S0 (links `libmrts.a`), P3, P4 | C |
| `native/mr-gst-runner/runner.cpp`, `runner.h` | P0 (`mrlateness` branch, clock arm), S0 (loader call), P2 (stamper arguments, stall watch), P3 (align glue, `mrtsdemux` messages), P4 (shedder glue, hooks) | C |
| `native/mr-gst-runner/stamper.{h,cpp}` | P1 (`condition_step`), P2 (anchored path, drift timer) | C |
| `native/mr-gst-runner/source_gate.cpp`, `gates.cpp`, `bus_edges.cpp` | P2 (stall watch), P4 (shedder glue, fan-out branch queue per OQ-30) | C |
| `native/mr-gst-runner/branch_align.{cpp,h}`, `branch_retime.{cpp,h}` | P3 | D |
| `native/mr-gst-runner/backlog_shed.{cpp,h}` | P4 | D |
| `src/child-process/gst-pipeline-runner.py` | every phase (clock arm P0; loader S0; `conditionStepMs` P1; preserve-timeline, stall watch, stamper lifecycle P2; align block P3; shedder P4) | C |
| `src/child-process/gst_native_plugins.py`, `gst_native_plugins_test.py` | S0 | A |
| `src/child-process/nativeBinaries.ts` (`resolveNativeAsset`) | P0 | C |
| `src/child-process/gst_stamp_native.py`, `gst_bus_stamper.py`, `gst_stamp_events.py`, `gst_bus_stamper_test.py` | P1, P2 | C |
| `src/child-process/gst_stamp_probe.py` | P2 | D |
| `src/child-process/gst-net-clock.py`, `ClockAuthority.ts`, `ClockAuthority.test.ts` | P0 (OQ-4) | D |
| `src/child-process/gst_preserve_timeline_test.py`, `gst_input_stall_watch.py` (+ test) | P2 | D |
| `src/child-process/branch_retime.py`, `gst_branch_align_test.py`, `gst_tsdemux_slave_test.py`, `transform_input_fixture.py` | P3 | D |
| `src/child-process/backlog_shed.py`, `backlog_shed_test.py`, `gst_backlog_shed_test.py`, `gst_latency_ratchet_test.py` | P4 | D |
| `src/child-process/GstChildProcess.ts`, `PythonProcess.ts`, `nativeRunner.ts`, `GstRunner.ts` and tests | P0, P1, P2, P3, P4 (description fields pass-through) | C |
| `src/child-process/native_runner_protocol_test.py` | every phase (new and rewritten cases) | C |
| New element and protocol tests in `src/child-process/`: `gst_mrlateness_element_test.py`, `gst_lateness_protocol_test.py` (P0); `gst_mrtsrestamp_element_test.py`, `gst_mrasrc_element_test.py`, `gst_ingest_restamp_test.py` (P1); `gst_aligner_behaviour_test.py`, `gst_mralignwatch_element_test.py`, `gst_mrtsdemux_element_test.py`, `aligner_conformance_test.py` (P2); `gst_mrtsdemux_parity_test.py` (P3); `gst_no_late_drop_test.py`, `gst_mrvideopace_element_test.py`, `output_conformance_test.py`, `gst_output_backlog_test.py` (P4); `gst_egress_writer_test.py` (P5) | as listed | A |
| `package.json` (`test:py`, `build` copies) | every phase | C |

### 14.3 Submodule: `packages/engine/src` core, `packages/shared-types`, manager packages

| Path | Phase | Fate |
|---|---|---|
| `src/clock/HouseClock.ts`, `houseClockPolicy.ts` and tests, `src/clock/fixtures/` | P0; C in P5 (PTP poll) | A |
| `src/clock/houseClockProperty.ts`, `ptpStatus.ts` and tests | P5 | A |
| `src/audio/pipeWireLatency.ts` (+ test) | P0 | A |
| `src/Engine.ts`, `src/modules/ModuleRunController.ts`, `src/modules/ModuleManager.ts`, `src/system/SystemStatsCollector.ts` | P0 (house clock, kill switch), P4 (D), P5 (features) | C |
| `src/plugins/GstPluginBase.ts` and its tests | P0, P2, P3, P4, P5 | C |
| `src/plugins/PluginModule.ts` | P0, P1, P2, P3, P4 (description fields) | C |
| `src/plugins/busHelpers.ts`, `busRunnerContract.test.ts` | P0 (taps), P2, P4 (ingress queue per OQ-30) | C |
| `src/plugins/latenessReporter.ts` (+ test) | P0; C in P2, P3, P4 | A |
| `src/plugins/ingestTiming.ts` (+ test) | P1; C in P5 | A |
| `src/plugins/egressTiming.ts` (+ test) | P5 | A |
| `src/plugins/aes67Helpers.ts` (+ test) | P0 | C |
| `src/plugins/tsHelpers.ts`, `encoderLeaf.ts`, `PacedTsSink.ts` (comment) | P1, P2, P3, P4, P5 | C |
| `src/plugins/latchRepair.ts` (+ test), `src/routing/MediaRouter.latchRepair.test.ts` | P2 | D |
| `src/plugins/playoutOffset.ts`, `playoutReanchor.ts`, `playoutReanchorState.ts`, `playoutReanchorText.ts`, `backlogShed.ts` and their tests, `GstPluginBase.playoutReanchor.test.ts`, `GstPluginBase.backlogShed.test.ts` | P4 | D |
| `src/plugins/removedTimingSettings.test.ts`, `noLateDrop.test.ts` | P4 | A |
| `src/routing/MediaRouter.ts` and its D tests | P2 (`getUpstreamBusProducers`), P4 (head walk) | C; tests D |
| `src/routing/PlayoutRaises.ts` | P4 | D |
| `src/routing/MpegTsProbe.ts` | kept (OQ-25) | — |
| `src/modules/ModuleInstance.ts`, `src/index.ts`, `src/EngineEventWiring.ts` | P0, P2, P4 | C |
| `packages/shared-types/src/` (`HouseEpoch`, `TimeSyncState`, `ModuleTimingSummary`, `withIngestTimingSettings`) | P0, P1, P5 | C |
| `packages/manager/src/plugins/PluginRegistry.ts`, `manifestHelpText.test.ts` | P1, P2, P3, P4, P5 | C |
| `packages/manager-ui/src/stores/engines.ts`, `components/common/EngineListItem.vue` (+ test), `AppHeader.vue` | P0 | C |
| `packages/manager-ui/src/components/routing/widgets/PidTrimField.vue` (+ test) | P1; C in P5 | A |
| `packages/manager-ui/src/components/routing/ModuleSettingsForm.vue`, `composables/useModuleSettingsForm.ts` (+ tests), `ModuleSettingsPanel.test.ts` | P1, P5 | C |
| `packages/manager-ui/src/utils/fieldLabel.ts` (+ test) | P4 | C |
| `packages/hls-pipe` (TS writer stamps house time at playout start) | P2 (OQ-18) | C |

### 14.4 Submodule: plugins (engine code, manifests, tests)

| Path | Phase | Fate |
|---|---|---|
| `plugins/srt-input`, `plugins/rist-input`, `plugins/mpegts-ip-input` (engine modules, `package.json`, tests) | P1 (restamp, O, trim), P4 (`playoutOffsetMs`), P5 (Timing Mode, tolerance, L) | C |
| `plugins/audio-input-302m`, `plugins/aes67-input` | P1 (ASRC, identity, O), P4 (`playoutOffsetMs` on aes67-input), P5 (aes67-input `ptpSync` rule) | C |
| `plugins/audio-encoder` | P1 (pipewiresrc, ASRC, identity, `conditionStepMs` out, `srcBufferMs` range) | C |
| `plugins/video-encoder` | P1 (fixed-mode restamp) | C |
| `plugins/audio-302m-core/engine/audio302mHelpers.ts` (+ test, `index.ts`, `README.md`) | P1 (ASRC option), P2 (`mrtsdemux select`, `mralignwatch`, `alignedMixer`), P3 (branch ASRC) | C |
| `plugins/audio-mixer`, `plugins/n1-mixer-302m` | P2 | C |
| `plugins/audio-processing/engine/*` | P2 | C |
| `plugins/audio-processing/native/mrducker/` | P2 | A |
| `plugins/audio-processing/engine/duckerEnvelope.ts` (+ test) | P2 | D |
| `plugins/audio-output-302m/engine/AudioOutput302mModule.ts` (+ test, `package.json`) | P2, P3, P4 | C |
| `plugins/audio-output-302m/engine/audio302mTiming.ts` (+ test) | P4 | D |
| `plugins/mpegts-muxer/engine/*`, `py/mux_routing.py` (+ test), `native/mux-routing/mux_routing.cpp`, `package.json`, `spike/muxer_rig.py` | P2 (aligner, sparse rule, stall watch, settings), P3 (`mrtsdemux`) | C |
| `plugins/ts-splitter/native/mr-tssplit/{app.h, app.cpp, main.cpp}`, `engine/{nativeRunner.ts, TsSplitterModule.ts}`, `tests/mrTssplit.test.ts`, `package.json` | P0 (lateness stats), P2 (pass-through), P4 (`playoutOffsetMs`) | C |
| `plugins/unixfdbus-core/native/mr-bus-fanout/main.cpp`, `native/libmrbus/fanout_server.h` (comment), `tests/unixfdFanout.test.ts` | P0, P2, P3 | C |
| `plugins/unixfdbus-core/py/unixfd-fanout.py` | P2 (C-4) | D |
| `plugins/hls-player/engine/HlsPlayerModule.ts` | P0, P2 | C |
| `plugins/subtitle-core/engine/subtitleOverlay.ts` (+ test), `py/subtitle_overlay.py`, `subtitle_cues.py`, `subtitle_runtime.py`, `subtitle_pay.py`, `subtitle_bridge.py`, `subtitle_klv.py`, their tests, `package.json` | P2 (test ports), P3 | C |
| `plugins/subtitle-core/py/subtitle_native.py`, `subtitle_native_test.py`, `subtitle_stamp_model.py`, `subtitle_stamp_dump.py`, `subtitle_ts.py`, `subtitle_ts_test.py`, `subtitle_ts_engine_test.py`, `subtitle_peshouse_gst_test.py` | P2 (`subtitle_stamp_dump.py` retired), P3 | D |
| `plugins/teletext-subtitles/engine/*` | P2 (declaration), P3 | C |
| `plugins/transcoder/engine/*`, `package.json`, tests | P2 (`houseTimelineEgress`, `preserveSourceTimeline`), P3 (`mrtsdemux`, burn-in wait, `subtitleDelayMs`), P4 (check, OQ-24) | C |
| `plugins/audio-transcoder/engine/*`, `package.json`, tests | P2, P3 | C |
| `plugins/video-player/engine/helpers/{pipelines.ts, pipelinePlan.ts, decoderSelection.ts, renderLag.ts, westonOutput.ts, renderTarget.ts}`, `engine/VideoPlayerModule.ts`, `package.json`, tests | P3 (`mrtsdemux media=video`), P4 | C |
| `plugins/audio-decoder/engine/AudioDecoderModule.ts` (+ test, `package.json`) | P0 (`clockSync`), P3 (`mrtsdemux`, ASRC, `slaveMethod`), P4 | C |
| `plugins/aes67-output/engine/Aes67OutputModule.ts` (+ test) | P0 (engine E), P3 (`mrtsdemux`, ASRC), P4 (audit), P5 (gate check only) | C |
| `plugins/aes67-core/py/aes67_clock.py`, `aes67_clock_test.py`; `aes67_sap.py` (comment) | P0 | D; C |
| `plugins/srt-output`, `plugins/rist-output`, `plugins/mpegts-ip-output` (engine modules, `package.json`, tests) | P0 (`lat_egress`), P5 (writer) | C |
| `plugins/README.md` | S0, P0, P1, P2, P3, P4 | C |
| `tools/avskew/` (P1), `tools/align-check/` (P2; P3 adds `pes_formula.sh`), `tools/fixtures/record-bus.sh`, `tools/fixtures/gen-thirdparty.sh` (P3), `tools/egress-compat.sh` (P5) | as listed | A |
| `tools/runner-cpu-profile.sh` | used by every phase's part 11 | — |

### 14.5 Submodule: documents

| Path | Phase | Fate |
|---|---|---|
| `docs/adr/0029-house-clock-timing.md` | P0 creates it; S0, P1, P2, P3, P4, P5 add sections | A |
| `docs/adr/README.md` | P0 and every later phase (index rows and statuses) | C |
| `docs/adr/0005-time-sync-backend.md` | P0, P2, P3, P4 (notes marked superseded) | C |
| `docs/adr/0001-…` (consequence amended by reference), `0008-302m-fan-in-contract.md`, `0016-subtitle-carrier-klv-webvtt.md`, `0018-conditioner-program-wide-steps.md`, `0019-native-pipeline-runner.md`, `0022-settings-help-text-contract.md` | S0, P2, P3, P4 | C |
| `docs/house-clock-timing-design.md` | P2 (§11.1 W wording, C-5, by the owner), P5 (three "today" statements marked "until Phase 5") | C |
| Release notes (where the project keeps them) | every phase | C |

### 14.6 Yocto layer (`/home/mrstation/media-router-yocto`)

| Path | Phase | Fate |
|---|---|---|
| `build/conf/local.conf` | P0 (chrony in, htpdate out, timesyncd off) | C |
| `meta-layers/meta-custom/recipes-support/htpdate/` (bbappend, `files/htpdate.service`) | P0 | D |
| `meta-layers/meta-custom/recipes-support/chrony/chrony_%.bbappend`, `files/media-router-chrony.conf`, `files/10-media-router.conf`, `files/media-router-chrony-wait.service`, `files/default.sources`, `files/20-media-router-chrony-dhcp` | P0 | A |
| `meta-layers/meta-custom/recipes-support/media-router-ptp/files/media-router-ptp-setup.sh`, `files/media-router-ptp4l.service`, `files/aes67.conf`, `files/smpte-2059-2.conf`, `media-router-ptp.bb` | P0 (setup script, unit, `mr-ptp-settai.py`, recipe), P5 (the two presets, WI-P5-19) | C |
| `meta-layers/meta-custom/recipes-support/media-router-ptp/files/mr-ptp-settai.py` | P0 | A |
| `meta-layers/meta-custom/recipes-core/base-files/base-files_%.bbappend` | P0 (comment) | C |
| `meta-layers/meta-custom/recipes-apps/media-router/media-router.bb` | P0 (`FILES` check), S0 (`tests/` excluded from the `/opt` copy, WI-S0-13; element list comment), P3 (element list comment) | C |
| `meta-layers/meta-custom/recipes-apps/device-manager/files/api/src/config/PtpConfig.ts`, `PtpConfig.spec.ts`, `Config.ts`, `index.ts`; `api/src/dto/ConfigDto.ts`; `api/src/socket/index.ts`; `app/src/dto/ConfigDto.ts`, `app/src/socketClient.ts`, `app/src/pages/PtpConfigPage.vue`, `app/src/pages/BasePage.vue`, `app/src/router/index.ts` | P0 | C |
| `meta-layers/meta-custom/recipes-apps/device-manager/files/api/src/config/TimeStatus.ts`, `TimeStatus.spec.ts`, `TimeConfig.ts`, `TimeConfig.spec.ts`, `api/src/dto/TimeConfigDto.ts`, `api/src/config/fixtures/`, `app/src/dto/TimeConfigDto.ts`, `app/src/components/TimeStatusCard.vue` | P0 | A |
| `meta-layers/meta-custom/recipes-multimedia/gstreamer/gstreamer1.0-plugins-bad_%.bbappend` | P4 | C |
| `meta-layers/meta-custom/recipes-multimedia/gstreamer/gstreamer1.0-plugins-bad/0008-waylandsink-present-every-frame-and-presentation-feedback.patch` | P4 | A |
| `meta-layers/meta-openembedded/meta-networking/recipes-support/chrony/chrony_4.8.bb`, `meta-layers/meta-openembedded/meta-oe/recipes-connectivity/linuxptp/linuxptp_4.4.bb` | read only (P0, P5) | — |

## 15. Open-question register

All questions the draft chapters put to the owner, renumbered `OQ-1` to
`OQ-40`. Three questions that two chapters asked are one entry each
(OQ-18, OQ-20, OQ-24); eleven questions the design document already
answers are closed in part 15.2 with the citation. Every question has a
proposed default and every dependent work item was written under it, so
nothing here blocks the rest of the plan. On 2026-10-12 the owner answered
OQ-1 to OQ-10 (the Status column says how; the chapters follow the
answers) and overruled C-1 in part 15.2; later that day the owner answered
OQ-13 and delegated the remaining 29 questions to the orchestrator, which
decided them the same day (Status column: the default unless the row says
otherwise — OQ-30, OQ-34 and OQ-35 depart from it). No question is open.
Part 15.4 records the decisions and plan corrections made while the
phases are built, each with why and consequence; the chapters follow
them.

### 15.1 Open questions

| # | Draft | Question | Why the design document does not answer it | What it blocks | Proposed default | Status |
|---|---|---|---|---|---|---|
| OQ-1 | S0-1 | Do `py/ts_psi.py`, `py/ts_video_info.py` and `py/sps_parse.py` stay for the Python runner's `tsProbe` (`gst-pipeline-runner.py:3565`), or does the probe move to a small native element so the whole `plugins/mpegts-core/py` directory can go in Phase 3? | §11.5 says the module has no Python twin and the twins fold in, but `tsProbe` is not timing code and the design never mentions it. | Chapter 3 part 6.2 Phase 3 row; WI-P3-17; the final shape of mpegts-core's `test:py`. | **Keep** the three files (with `ts_psi_test.py` and `ts_video_info_test.py`); they are not timing code and the no-twin rule covers new code. Revisit when the Python runner is retired. | Answered 2026-10-12: keep. Wider rule (chapter 2): new timing code is prototyped and tested in Python first and ported to C++ once right; the Python stays in the repository as the reference and is never loaded by a runner; "no Python twin" means no second live implementation at runtime, not no prototypes. Nothing under `py/` is deleted; the runtime fallbacks and loaders still go. |
| OQ-2 | S0-2 | Are the field-capture fixtures committed in the repository (trimmed to ≤ 2 MB each, ≈ 60 files over all phases) or kept in an out-of-repo store the tests fetch? | §6 asks for fixtures from field captures but not where they live; the repository holds one real TS today (`v1/output.ts`, 514 KB). | WI-S0-9, WI-S0-10; WI-P1-5; WI-P2-14; WI-P3-3; WI-P4-14; WI-P5-14; every conformance run. | **In-repo**, ≤ 2 MB each, under `plugins/mpegts-core/tests/fixtures/`. | Answered 2026-10-12: in the repository under `tests/fixtures` and excluded from the device; WI-S0-13 keeps every `tests/` directory out of the image copy and the dist tarball (today `cp -r ${S}/*` ships `packages/hls-pipe/tests/fixtures`, 364 KB). |
| OQ-3 | S0-4 | Who records the field captures and when: the engineer on the .103/.108 rigs at the start of each phase, or the design owner supplies vMix (#820) and GATE01/OCC captures from the field? | The design names the sources (#816, #820, #825, #836 in R4) but not their custody. | WI-S0-9; WI-P1-5, WI-P1-6 (STC tuning, R4); the capture sessions of WI-P2-14, WI-P3-3, WI-P4-14. | **Engineer records** on .103/.108 at Phase 1 start (and at each later phase's start with the previous image); the owner supplies a vMix capture only if the rig cannot reproduce #820. | Answered 2026-10-12: recorded on the .103 and .108 rigs by the assistant session that has rig access, at the start of each phase's fixture work, after checking what captures already exist on .103; the owner supplies a vMix feed or recording only if no rig can subscribe to one. |
| OQ-4 | P0-1 | In which phase are the `MR_TIME_SYNC_CONTRACT` kill switch and the legacy `clockSync` net-clock arm (with audio-decoder's `clockSync` setting) deleted? | That they go is decided (§4.1: `CLOCK_MONOTONIC` with `base_time = 0` unconditional; §13.1: no engine-wide flag, no legacy arm). Only the phase is open: §14 row 0 does not list them and the doc never names the switch. Phase 0's lateness and E assume `base_time = 0` everywhere. | WI-P0-5; the meaning of lateness on a box running with the switch off; V15 of chapter 4. | **Phase 0.** | Answered 2026-10-12: Phase 0 (the default). |
| OQ-5 | P0-2 | chrony `maxslewrate`, in ppm? | §10.2 and R7 require a bounded slew rate and name the directive, not the value. | WI-P0-1's config line; R-P0-10. | **100 ppm**, matching the PTP presets' `max_frequency 100000`. | Answered 2026-10-12: 100 ppm (the default). |
| OQ-6 | P0-3 | Which NTP servers, and does the Device Manager let a site set its own in Phase 0? | §10.2 requires a common traceable reference; it names no servers and no UI. | WI-P0-1's `pool` line; the scope of WI-P0-12. | **Fixed `pool pool.ntp.org iburst`**, no server field in Phase 0. | Answered 2026-10-12: a server-list setting on the Device Manager's Time page in Phase 0, default the public pool, DHCP-provided servers accepted as well (WI-P0-1 generates the server fragments; WI-P0-12 adds the field, its validation and the DTO). |
| OQ-7 | P0-4 | May the kernel's `adjtimex` state (`STA_UNSYNC`, `tai`) stand in for "the daemon reports sync" (§10.2, §10.3) as the daemon-neutral gate for the start wait and for `traceable`? | §10.2 names the daemon's state as the source; the plan reads the kernel as a proxy that works under chrony and PTP alike and reads `chronyc -c tracking` for display only. No error bound is given either way. | WI-P0-4 `qualifies()`; V4, V5, V8 of chapter 4; ADR-0029. | **Yes**: kernel `STA_UNSYNC` clear and TAI offset ≥ 10 s; the daemon's estimated error is shown, not gated; the proxy is recorded in ADR-0029. | Answered 2026-10-12: yes (the default); the error estimate is shown, not gated. |
| OQ-8 | P0-5 | What is the default of the per-module lateness alarm setting (drafted as a threshold in ms)? | That Phase 0 ships the alarm is decided (§14 row 0 cites §9.5: "alarms at thresholds the operator sets; they warn, never drop"); no default value is given. | WI-P0-9; chapter 4 part 8. | **0 (off)**. | Answered 2026-10-12: display only in Phase 0 — every module shows its lateness and added latency with a label; no alarm setting ships, the owner wants a feel for the numbers first. Deferred option: a relative alarm (+500 ms above the module's settled lateness for 10 s) plus an optional absolute cap per module (chapter 4, note after part 13). |
| OQ-9 | P0-6 | Device Manager: rename the "PTP" page to "Time" (chrony and PTP on one page), or add a separate "Time" page? | §10 and §11.5 require sync state to be visible, not where. | WI-P0-12's app layout and route. | **Rename to "Time"**; `/ptp` redirects to `/time`. | Answered 2026-10-12: one Time page holding chrony and PTP, `/ptp` redirects (the default). |
| OQ-10 | P0-7 | Under PTP, is the TAI−UTC constant an operator setting? | §10.2 says the PTP setup writes "the configured TAI−UTC constant (37 s)" but not who configures it. | Where WI-P0-2 gets the value; whether WI-P0-12 needs a setting. | **No UI**: read from the image's `leap-seconds.list`, fall back to 37, overridable by a hand-edited `PTP_TAI_UTC_OFFSET` in `ptp.env`. | Answered 2026-10-12: no UI (the default): the image's leap-seconds list, 37 if missing, `PTP_TAI_UTC_OFFSET` in `ptp.env` overrides. |
| OQ-11 | P1-1 | §5.2 maps a straddling PES "by whichever mapping's STC range contains it". When both epochs' ranges contain it (a rewind shorter than the lead window), which wins? | The text defines no range and no tie-break. | WI-P1-1 (`VirtualStc::map`), WI-P1-3; fixtures `syn-rewind-1s`, `syn-straddle-audio`. | **Plausible lead**: range = [first PCR − 1 s, last PCR + 4 s] per epoch; in one range → that epoch; in neither → the newest; in both → the epoch whose lead for this PES is closest to the PID's median lead before the re-lock. | Decided 2026-10-12 by the orchestrator, owner delegated: the default (plausible lead: an epoch's range is first PCR − 1 s to last PCR + 4 s; a PES in one range uses that epoch, in neither the newest, in both the epoch whose lead for that PES is closest to the PID's median lead before the re-lock). The design doc's §5.2 now carries the tie-break. Refined 2026-10-14 by the orchestrator during the build (part 15.4 B-1): the tie-break is for real timeline jumps only; an epoch closed by an envelope step leaves the straddle, and a range that maps the PES within `step_ns` of a newer range gives way to it. |
| OQ-12 | P1-2 | How is a gap carried on the bus, given that GStreamer events do not cross `unixfdsink` and that the marker must survive the time-bounded leaky module queue after the restamp (srt-input's `queue leaky=2 max-size-time=100000000`)? | §5.2 says "a GStreamer gap event", which cannot reach another process. The draft's form (PTS = start, `duration` = length) was dropped: `GstQueue` accounts duration into its time level and would leak the marker (chapter 5 OQ row). | WI-P1-3, -4, -7; WI-P2-6; WI-P3-1, -2; WI-P5-2. | **A GAP\|DISCONT-flagged buffer** of adaptation-only TS packets, one per affected PID, PTS = the gap's end, no duration, the gap length in the adaptation field's `transport_private_data`. Alternatives: a serialisable `GstMeta`; a marker in input-PTS convention mapped by `mrtsstamp`. | Decided 2026-10-12 by the orchestrator, owner delegated: the default (a GAP\|DISCONT-flagged buffer of adaptation-only packets per PID, PTS = the gap's end, no duration, the length in `transport_private_data`). As built: no DTS on the bus (chapter 15.4 B-19); DISCONT against `tsdemux` is open (B-20). |
| OQ-13 | P1-3 | Outputs present at `stamp + D` until Phase 4, so source-natural landing adds the source's lead to every direct ingest → output route in Phases 1–3 and can overflow the video player's 1 s leaky ES queue. Accept the interim latency and raise the queue floor to 3 s in Phase 1? | §9.4 says source-natural landing "costs nothing at an output" because outputs play on arrival, which holds only from Phase 4. The default edits a mechanism this design removes (Q2) and needs an explicit exception; the conforming alternative is no change, documented, with a negative O recommended. | WI-P1-16; release notes; V-P1-17. | **Accept** the interim latency and **raise the floor to 3 s** as a Q2 exception; recommend a negative O where latency matters. | Decided 2026-10-12 by the owner: Phases 1–4 ship as one release. Phase 0 ships alone first, Phase 5 after; the development order stays 1, 2, 3, 4 and each phase still deletes what it replaces inside that release. There is no interim period, so WI-P1-16 and V-P1-17 are removed and no Q2 exception is needed (chapters 1, 2, 11, 12). |
| OQ-14 | P1-4 | What is the range of the ingest offset O? | §5.5 bounds the trim (±2 s) but not O. | WI-P1-9's settings schema. | **±10,000 ms**, step 1 ms. | Decided 2026-10-12 by the orchestrator, owner delegated: the default (±10,000 ms, step 1 ms). |
| OQ-15 | P1-5 | Do the capture producers (audio-input-302m, aes67-input, audio-encoder, video-encoder) get the per-PID trim as well as O? | O is answered (§5.5, A.3, §11.1, Q11). For the trim, §13.1 Q6 says each detected PID can carry a signed trim and does not exempt single-PID ingests, so omitting it on captures is an operator-visible simplification (§13.3). | The `pidTrims: false` manifest field of WI-P1-11, -12, -13; chapter 5 part 8. | **No trim on captures** (one PID, where O is the same thing); O on all seven ingests. | Decided 2026-10-12 by the orchestrator, owner delegated: the default (no trim on captures; O on all seven ingests). |
| OQ-16 | P1-6 | Should audio-encoder capture with `pipewiresrc` on its null-sink (device timing) instead of `pulsesrc`, limiting `srcBufferMs` to 40–85 ms? | §11.1 asks for "capture time from device timing" but names no element; the change alters an operator setting's range. | WI-P1-12; chapter 5 part 8. | **Yes**, the same pattern and clamp as audio-input-302m. | Decided 2026-10-12 by the orchestrator, owner delegated: the default (`pipewiresrc` on the null-sink, `srcBufferMs` 40–85 ms). |
| OQ-17 | P1-7 | At what cadence does an ingest send gap markers during an outage? | §5.2 ("as soon as it knows of it"), §6 item 4 and R21 want the gap signalled before an aligner's W fires; the cadence is unspecified. | WI-P1-4. | **At detection (≥ 1 s without packets) and every 250 ms thereafter** (PTS = now, length so far), plus one on resume and on live edits; the alternative is markers on resume only, with Phase 2's W as the fallback. | Decided 2026-10-12 by the orchestrator, owner delegated: the default (markers at detection and every 250 ms, plus on resume and on live edits). |
| OQ-18 | P1-8, P2-2 | After Phase 1, are the splitter, the three 302M aligner modules and the HLS fan-out the only anchored-stamper users, and which phase moves hls-player's egress to "house time at playout start plus media offset" (§5.4)? | §14 lists no phase for the hls-player row of §11.1 and row 1 does not name the fan-out; the two drafts assumed different phases. | WI-P2-2, WI-P2-3, WI-P2-5; Phase 2's deletion of the anchored stamper. | **Phase 2**, in WI-P2-5 (unestimated scope); Phase 2 does not ship until `grep` finds no other anchored user. | Decided 2026-10-12 by the orchestrator, owner delegated: the default (Phase 2, WI-P2-5; Phase 2 is not complete until `grep` finds no other anchored user). As built: the rebase onto house time is in `mr-bus-fanout`, not in hls-pipe's writer (chapter 15.4 B-55); nothing at runtime stamps anchored any more (B-51, B-52). |
| OQ-19 | P1-9 | §5.1 names "the timestamp the network source element assigns on receipt (`udpsrc`, `srtsrc`, `mrristsrc` …)"; in 1.28.2 `srtsrc`'s timestamp is the send time. Is arrival "when the transport hands the packet over, after its recovery buffer", read by the restamp itself? | The design text assumed `srtsrc` stamps receipt; the source shows otherwise (`gstsrtsrc.c:183–258`). | WI-P1-4 (`arrival=clock`), WI-P1-10; Phase 5's transit check (WI-P5-6). | **Yes**: arrival = the clock at the restamp, placed directly after the transport element; ADR-0029 records the wording correction. | Decided 2026-10-12 by the orchestrator, owner delegated: the default (arrival is the house clock read by the restamp itself, placed directly after the transport element; a source element's own timestamp is not used). The design doc's §5.1 now says so. |
| OQ-20 | P2-1, P3-1 | Phase 2 needs the 302M aligners' inputs on content time and Q7 forbids #837's retime, but the formula demux is §14's Phase 3. Is `mrtsdemux` built in Phase 2 in a one-stream select mode for the 302M fan-ins (audio-output-302m's included), with Phase 3 generalising it? | §13.1 Q7 says the retime is replaced by the formula demux, §14 puts the demux in Phase 3; Q7 and §11.1's audio-mixer row lean to yes; the residual is sequencing. | WI-P2-7, -8, -11; WI-P3-15 (if no: +30 / −20 lines, +1.5 days). | **Yes**, select mode in Phase 2. | Decided 2026-10-12 by the orchestrator, owner delegated: the default (select mode in Phase 2). As built: `mrtsdemux` turns gap markers into GAP events, and its no-stream warning is the `mrtsdemux` message with `reason=no-stream` (B-60). |
| OQ-21 | P2-5 | Is ADR-0008 (force-live, the identity pacer, `ignore-pcr`, the 20 ms floor) also superseded in Phase 2? | §14 names only ADR-0005 decisions 2 and 4 and ADR-0018. | WI-P2-15. | **Yes** for those parts; the single-source bypass and the `continuationName` rule stay. | Decided 2026-10-12 by the orchestrator, owner delegated: the default (ADR-0008's force-live, pacer, `ignore-pcr` and 20 ms floor superseded; the bypass and the `continuationName` rule stay). ADR-0008 is marked so (WI-P2-15, B-78). |
| OQ-22 | P2-7 | Is the audio-processing limiter's lookahead (5 ms default, up to 20 ms), which shifts audio later than its PTS, corrected or only reported? | §11.3 item 4 lists it as unreported latency; there is no decision on correcting it. | WI-P2-10. | **Report** as added latency; no PTS correction in this version. | Decided 2026-10-12 by the orchestrator, owner delegated: the default (reported as added latency, not corrected). As built: the timing section's "Processing latency" row; in ducker mode it also makes the duck land that much early (B-63). |
| OQ-23 | P3-4 | Where decode feeds the device directly (audio-decoder; audio-output-302m single source), one resampler with the product ratio, or two in series? | P7 allows one at first PCM and one at the device; §13.1 calls one per path the cost bound. | WI-P3-5, -10, -15; WI-P4-4, -7. | **One**, with the product ratio. | Decided 2026-10-12 by the orchestrator, owner delegated: the default (one resampler with the product ratio). |
| OQ-24 | P3-5, P4-4 | In which phase does `subtitleDelayMs` (Q9's list) go, and what makes burn-in wait for late cues instead of the fixed `subhold`? | Q9 removes it "with the mechanism that used it" but names no phase; the hold is a fixed budget, not K learning; the two drafts chose Phase 3 and Phase 4. | WI-P3-13; WI-P4-9; chapter 7 part 8. | **Phase 3**: the burn-in waits through a two-member `mralignwatch` pace group (video, cues `sparse=true`); WI-P4-9 then only verifies. | Decided 2026-10-12 by the orchestrator, owner delegated: the default (Phase 3, the `mralignwatch` pace group; WI-P4-9 only verifies). |
| OQ-25 | P3-6 | Does `MpegTsProbe` (codec identification in a separate `gst-launch-1.0` on a bus edge) keep stock `tsdemux`? | §6 says `tsdemux` leaves the bus path; the probe has no timing role and cannot load a plugin by path from `gst-launch`. | WI-P3-16's scope; the "tsdemux leaves the bus path" claim. | **Keep** `tsdemux` there; ADR-0029 records the exception. | Decided 2026-10-12 by the orchestrator, owner delegated: the default (`MpegTsProbe` keeps `tsdemux`; ADR-0029 records the exception). |
| OQ-26 | P3-7 | Is `tsparse set-timestamps=false` removed from `buildTsUdpInput`, given its only job was re-framing packets for `tsdemux`? | Not a timing mechanism; the design does not mention it. | WI-P3-18. | **Remove** (≈ 0.11 core on a 1080p50 player). | Decided 2026-10-12 by the orchestrator, owner delegated: the default (`tsparse` removed from `buildTsUdpInput`). |
| OQ-27 | P3-8 | For an elementary stream type the caps table does not cover (0x06 with no descriptor, DTS, AC-4 …): no pad, as `tsdemux` does, or a generic private pad? | R1 asks for an alarm instead of silent loss, not for a pad. | WI-P3-1, WI-P3-2. | **No pad** (parity with `tsdemux`), one warning per PID per generation. | Decided 2026-10-12 by the orchestrator, owner delegated: the default (no pad, one warning per PID per generation). |
| OQ-28 | P3-9 | audio-decoder and audio-transcoder get `media=audio`, so an A/V input plays its first audio PID instead of linking whichever pad appeared first. Accept the behaviour change? | §11.1 only fixes the player's side (Q18). | WI-P3-10, WI-P3-12. | **Yes.** | Decided 2026-10-12 by the orchestrator, owner delegated: the default (accepted: the first audio PID plays). |
| OQ-29 | P4-2 | Are the video-player's `sync` and `bufferMs`, and the audio-decoder's `slaveMethod`, `lowLatencySync`, `bufferMs` and `sinkBufferMs`, removed in Phase 4? | Q9 names five settings; these six lose their mechanism but are not named. R13 and §13.1 answer it in principle; this stays as the §13.3 notice for operator-visible removals. | WI-P4-6, WI-P4-7; chapter 8 part 8; release notes. | **Remove** all six, nothing migrated. | Decided 2026-10-12 by the orchestrator, owner delegated: the default (all six removed, nothing migrated). |
| OQ-30 | P4-3 | Do the bus ingress queue and the producer fan-out branch become non-leaky at their 5 s capacity, as §8 and §11.3 item 7 say, or stay `leaky=2` as an alarmed resource-fault backstop? | §8 says leaky queues are "switched off or replaced", §11.3 item 7 names the 5 s edge queues, R9 calls a full queue a resource fault. `busHelpers.ts:157–172` records that a non-leaky ingress wedged gate01; with patched `unixfdsink` (skip-and-kick) the loss moves to the producer, where it is reported. Keeping `leaky=2` is a deviation that changes where loss is reported. | WI-P4-5, WI-P4-13; chapter 8 part 4.4. | **Replace**: same capacity, `leaky=0`, `overrun` → `queue-full` alarm, loss reported at the producer's skip-and-kick. | Decided 2026-10-12 by the orchestrator, owner delegated: not the default. The bus ingress queue and the producer fan-out branch stay `leaky=2` at their 5 s / byte-cap capacity, reclassified as an alarmed resource-fault backstop: an overflow there is a resource fault (§8, R9), not a lateness policy, and the non-leaky variant reopens the gate01 deadlock that `busHelpers.ts:157–172` records. WI-P4-5, WI-P4-13 and chapter 13.6 say so. |
| OQ-31 | P4-5 | Is the audio output prefill a fixed engine constant of 40 ms (plus the unchanged 100 ms sink ring), with no operator setting? | §8 says "a small prefill that rides out arrival jitter" without a value or an owner. | WI-P4-7, WI-P4-8. | **Yes**, 40 ms, revisited from V-P4-4 data before release and recorded in ADR-0029. | Decided 2026-10-12 by the orchestrator, owner delegated: the default (40 ms, no setting; revisited from V-P4-4 data before release). |
| OQ-32 | P4-6 | At a content gap, does each output independently let its lateness fall by up to the gap length, even when only one stream of a muxed program has the gap (shifting A/V by up to min(backlog, gap))? | §8 says latency comes down "at a gap in the content"; it does not say whose gap. | WI-P4-3, WI-P4-4; R-P4-7. | **Yes**, per output. | Decided 2026-10-12 by the orchestrator, owner delegated: the default (per output). Consequence, accepted under "outputs play as soon as they can": two outputs fed by one muxer can drift apart after a one-sided gap until the other stream also gaps. |
| OQ-33 | P4-7 | Are stored values of the removed settings stripped from stored configs, or left in place and ignored? | §13.1 says "nothing is migrated" but not whether old keys are cleaned. | WI-P4-11; V-P4-11. | **Leave** them, ignored; a rollback via the Device Manager then restores them. | Decided 2026-10-12 by the orchestrator, owner delegated: the default (left in place and ignored; a rollback restores them). |
| OQ-34 | P4-9 | Is the `capacity` alarm "output-lateness slope above 20 ms/min over 3 min without a gap, clearing below 5 ms/min", and is the threshold a module setting? | §8 asks for an alarm when an output falls behind steadily but gives no threshold; §9.5 says alarms are at thresholds the operator sets. | WI-P4-12. | **Yes, as a module setting** `capacityAlarmMsPerMin` (default 20, 0 = off), the first alarm setting on a module since Phase 0's lateness alarm is deferred (OQ-8), clearing below a quarter of it. | Decided 2026-10-12 by the orchestrator, owner delegated: not the default. The capacity alarm is deferred like the lateness alarm (OQ-8): Phase 4 shows the lateness trend with a label, no alarm, no setting; the threshold idea (20 ms/min over 3 min, clearing below a quarter) joins the deferred-alarm note of chapter 4 part 13. WI-P4-12 and chapter 11 say so. |
| OQ-35 | P5-1 | Is every Trust/Restamp switch taken at once, the switch being itself the gap or dropped overlap, or does a switch wait for a natural gap? | §10.4 says an automatic switch "is taken only at a gap or a stream (re)start" and an operator's change "is applied the same way" (:884–885), yet also that the stream falls back and returns "one gap or dropped overlap each way"; on a clean link a natural gap may never come. | WI-P5-6, WI-P5-7 (the `TrustGate` state machine). | **At once, in every direction** (fallback, return after 10 s qualified, operator change). Alternative: wait up to 30 s for a natural gap on return and on operator changes, then switch. | Decided 2026-10-12 by the orchestrator, owner delegated: a blend. A fallback to Restamp is taken at once when the transit check fails, the switch being itself the gap; a return to Trust and an operator's mode change wait up to 30 s for a natural gap, then switch at once; every switch raises an event. WI-P5-6, WI-P5-7 and the design doc's §10.4 say so. |
| OQ-36 | P5-3 | Does this version ship a per-egress upper bound on D_e (R17's "bound D_e per egress")? | R17 names the bound, but §13.1 Q16 defers hardware receivers, the reason for it. | WI-P5-3 (`d-e-max-ms`); chapter 9 part 8. | **No setting**; the element property exists (default 0 = none) as the hook; the lateness display (Phase 0) shows a runaway D_e, and the deferred lateness alarm (OQ-8) would warn once built. | Decided 2026-10-12 by the orchestrator, owner delegated: the default (no setting; the element property is the hook). |
| OQ-37 | P5-4 | The registration `format_identifier`: `'MRHT'` unregistered, or a code registered with the SMPTE Registration Authority? | §13.3 leaves the descriptor format to the engineer; registration is a procedural choice with an external body. | WI-P5-1. | **`'MRHT'` unregistered**, checked against the SMPTE-RA public list for a collision before release. | Decided 2026-10-12 by the orchestrator, owner delegated: the default (`'MRHT'` unregistered, checked for a collision before release). |
| OQ-38 | P5-6 | mpegts-ip-input in RTP mode: L is the `rtpjitterbuffer` default of 200 ms, while the operator's "Jitter Buffer" (`jitterMs`) sizes a queue after the restamp. Wire `jitterMs` into `rtpjitterbuffer latency=`? | §10.4 names "the SRT latency, the RIST buffer" only. | WI-P5-11. | **No change**: L = the jitterbuffer's `latency` (200 ms) in RTP mode, 0 for raw UDP; the UI shows L's source. | Decided 2026-10-12 by the orchestrator, owner delegated: the default (no change: L = the jitterbuffer's 200 ms in RTP mode, 0 for raw UDP). |
| OQ-39 | P5-7 | Does a Trust-selected ingest hold its first output for up to 1 s at stream (re)start, so the mode is decided before output and no switch happens at start? | §10.4 allows switches at a stream (re)start but does not say whether the start itself is decided before output. | WI-P5-6, WI-P5-7. | **Yes**, hold ≤ 1 s or 4 MB; without a decision by then, start in Restamp with the fallback alarm. | Decided 2026-10-12 by the orchestrator, owner delegated: the default (hold ≤ 1 s or 4 MB; otherwise start in Restamp with the fallback alarm). |
| OQ-40 | P5-8 | What egress count and bitrate on a Pi 4 should the R11 measurement be sized against? | R11 says "the largest egress count and bitrate expected" without numbers. | WI-P5-16; V-P5-7. | **8 egresses at 10 Mbit/s plus one at 30 Mbit/s** on 10.9.16.108. | Decided 2026-10-12 by the orchestrator, owner delegated: the default (8 egresses at 10 Mbit/s plus one at 30 Mbit/s on 10.9.16.108). |

### 15.2 Questions closed during assembly

These were asked by the draft chapters; the design document answers them,
so they are recorded here with the citation and were not put to the owner.
The chapters' text follows the answer. C-1 was put to the owner after all
and overruled on 2026-10-12; its row carries the decision and the demux
gap that followed from it, decided the same day.

| # | Draft | Question | Answered by | Recorded as |
|---|---|---|---|---|
| C-1 | S0-3 | Does a runner that cannot load `libgstmrtshouse.so` fail the module, or start without the timing element and alarm? | Closed at assembly from §13.1 "no legacy arm, no in-app rollback" and §11.5 (no Python fallback) as "fail the module". **Decided by the owner 2026-10-12: start but warn.** | Chapter 3 part 4.5 rule 6: the runner builds the pipeline without the timing elements and the module carries a loud alarm — native TS module not loaded; this stream carries no house time on the bus; consumers will mis-time it until the deploy is fixed. Consequence: WI-S0-8's miss and old-ABI paths warn instead of exiting where an `identity` can stand in (the restamp, the egress writer, the alignment watch), and Phases 1, 2 and 5 follow. A demux has no stand-in: decided 2026-10-12 by the orchestrator, owner delegated, a module whose `mrtsdemux` cannot load fails with the same alarm text (chapter 13.8; chapter 3 rule 6, WI-S0-8, chapter 6 WI-P2-7, chapter 7 WI-P3-2). |
| C-2 | P2-3 | Are the muxer's `queueLeaky` and `queueDepthMs` removed in Phase 2? | §14 row 2 ("aligners wait for data or a gap and never drop"; a leaky pad queue at an aligner input is a drop) and §11.5 item 9 (settings go with their mechanism). | Removed in Phase 2 (WI-P2-12). |
| C-3 | P2-4 | A sparse cue that arrives after the muxer has gapped its time: discard it, or forward it? | §13.1 and P11 forbid discarding after ingest; §6 item 4 and R21 sanction only a returning input's stale data. | Forwarded at its own PTS, played late (§8), with the alarm and the pace raise (chapter 6 part 4.6, WI-P2-6). Producer-side sparse gaps deferred to Phase 3. |
| C-4 | P2-6 | Is the Python fan-out fallback `unixfd-fanout.py` deleted? | §13.1 no Python twin; §14 row 2 "their twins deleted". | Deleted in Phase 2 (WI-P2-5). |
| C-5 | P2-8 | May §11.1's "W sized from measured lateness" be reworded to "W from arrival rhythm; pace from measured lateness"? | §4.6 (W "measures silence, not lateness") and §13.1 Q8 are the authoritative text; §11.1's wording is stale. | A design-doc edit for the owner; the plan follows §4.6. |
| C-6 | P3-2, P4-1 | Does Phase 3 ship the output ASRC at the measured device/house ratio (custom slaving, zero skew) with sinks still `sync=true`, Phase 4 only switching to unsynchronised sinks? | §14 row 3 "ASRC at decode and at outputs"; §8 defines the output ASRC as following the measured ratio, not its buffer fill; §15 "ASRC at the outputs (Phase 3)". | Phase 3 WI-P3-5 (custom-slaving callback); Phase 4 WI-P4-4 moves the evidence to a timer and sets `sync=false` on the one `mrasrc` instance. |
| C-7 | P3-3 | How does a decode ASRC know a stream is foreign-clocked? | §5.4: "compressed audio carries the source rate in its PTS deltas; the first PCM decode rate-matches it". | Measured from the PTS deltas; the engage thresholds (0.5 ppm, 1 ms, 10 s) are an engineer's choice in ADR-0029 (§13.3). |
| C-8 | P3-10 | `subtitle_ts_engine_test.py` imports the Python `TimelineStamper` that Phase 2 deletes; which phase cuts it? | Not a design question: a sequencing gap between two drafts. | WI-P2-3 ports it to a local identity stamp in Phase 2; WI-P3-17 deletes the file in Phase 3. |
| C-9 | P4-8 | Does aes67-output keep its paced `udpsink sync=true ts-offset=<senderLatencyMs> max-lateness=-1` in Phase 4? | §11.1: aes67-output is an egress, so §8's presentation rules do not apply; §7 changes only its demux. | Kept unchanged (WI-P4-10 audits it). |
| C-10 | P5-2 | While Trust is selected but the ingest has fallen back to Restamp, do O and the per-PID trim apply? | §13.1 Q13: neither applies "while an ingest is Trust-selected: trust means untouched"; the condition is the selection, not the effective mapping. | No O or trim in any state while Trust is selected (WI-P5-7, chapter 9 part 4.8). |
| C-11 | P5-5 | aes67-input with `ptpSync` is Trust (§5.4); does Q13 disable its Ingest Offset? | §5.4 (RTP time → TAI → bus, Trust), §11.1 (aes67-input "(Trust)"), §10.4 (`ptpSync` "is already this kind of opt-in"), Q13. | O disabled and forced to 0 while `ptpSync` is on, reason shown (WI-P5-13); no transit check (RTP carries no D_e). |

### 15.3 Sections that wait on an answer

None. Every question was decided on 2026-10-12 (part 15.1, Status column:
OQ-1 to OQ-10 and OQ-13 by the owner; OQ-11, OQ-12 and OQ-14 to OQ-40 by
the orchestrator with the owner's delegation), and every work item and
gate check follows its decision. Where a decision departed from the
default, the item changed with it: WI-P1-16 and V-P1-17 removed (OQ-13);
WI-P4-5 and WI-P4-13 keep the two backstop queues `leaky=2` (OQ-30);
WI-P4-12 shows the lateness trend without an alarm (OQ-34); WI-P5-6 and
WI-P5-7 take a fallback at once and wait up to 30 s for a natural gap on
a return or an operator's change (OQ-35).

### 15.4 Decisions and corrections during the build

What the build decided or found that the chapters did not say, each with
why and what follows. Engineering choices are the orchestrator's under the
owner's delegation of 2026-10-12, recorded for the owner's veto; "as
built" rows are a work item's choice that its review accepted. The chapter
texts named in the last column carry each row, and ADR-0029's Phase 1 and
Phase 2 sections repeat the timing choices. Rows B-1 to B-16 are Phase 1's
third wave (2026-10-13 and 2026-10-14) and the S0 notes it carried; rows
B-17 to B-31 are waves 4 and 5 (2026-10-14 and 2026-10-15) and the
documentation pass (2026-10-16); rows B-32 to B-35 are the capture session
(2026-10-16); rows B-36 to B-38 are the tuning by replay (WI-P1-6,
2026-10-16); rows B-39 to B-44 are the Phase 1 verification round (chapter 5
part 11, 2026-10-16); rows B-45 and B-46 are the fix round after the Phase 1
review (2026-10-16), row B-47 the second fix round (2026-10-17), row B-48
the third (2026-10-17); rows B-49 to B-78 are Phase 2's build (2026-10-16 to
2026-10-18) and its documentation pass; row B-79 is the aligner round's
first item (2026-10-22); rows B-84 and B-85 are the vMix recording's
findings (2026-10-21 and 2026-10-22) and row B-86 the owner's decision on
it, a steady sparse PCR that locks (2026-10-22); row B-87 is the engine's
crash at its own stop, row B-88 the captures' relocks under load, their
PipeWire node off the real-time loop, row B-89 a gap marker at each
dropped video frame, row B-90 a lead row that read a bursty delivery as a
PCR fault and row B-91 the file descriptors a lagging consumer holds, all
found on .108 (2026-10-22), and row B-92 the edge sockets each stop of a
native fan-out left behind, a read of freed memory at its exit (found on
the dev Pi, seen on .108, 2026-10-22). A
Phase 2 row's "Consequence" saying a chapter text "reads as" something is the
correction; chapter 6's own text is the plan as drafted.

| # | Item | Decision or finding | Why | Consequence |
|---|---|---|---|---|
| B-1 | OQ-11, the straddle tie-break (WI-P1-1, WI-P1-3) | Orchestrator, 2026-10-14: the lead tie-break is for real timeline jumps only. An epoch closed by an envelope step is no straddle candidate, and a range that maps the PES within `step_ns` of a newer range holding it gives way to the newer one. | Such epochs are one timeline (the floor moved, or a same-clock PCR PID changed), and left to the tie-break, delay jitter flipped PIDs between them: a +100 ms delay ramp over 30 s dropped 1.3 s of audio, +500 ms over 60 s dropped 5–6 s. | Chapter 5 part 4.4; register OQ-11; ADR-0029 Phase 1. After WI-P1-3's second fix round, which brought B-1, B-2 and a PCR mapped outside the validator's lead row, the replays put 3,551 of 3,551 PES on the new floor after a +150 ms re-route (none before) and drop no PES on a +200 ms queue build-up over 20 s (137 before). The design doc's §5.2 keeps the general tie-break; this narrows when it applies. |
| B-2 | The rate fit (part 4.3; WI-P1-1) | Orchestrator, 2026-10-14: the fit runs on one floor level. A bucket more than `step_ns` off it opens a candidate level, which replaces the fit's after `step_hold_ns`; a burst or dip that ends sooner stays out. No new constants. A level adoption clears the fit until `rate_buckets_min` buckets of the new level. | A delay step inside the fit window bent ε: a −100 ms fall degraded the program on the rate row with no recovery, and a +150 ms rise left ε near 1,000 ppm. A cleared fit keeps the validator's rate row and `mrasrc`'s out-of-bounds check off the old level (measured: no fit from 129.1 s to 158.1 s after a −100 ms fall at 120 s). | Part 4.3's rate row; WI-P1-1; ADR-0029 Phase 1. |
| B-3 | Envelope-step direction (parts 4.3, 4.5) | P1-1, 2026-10-13: one-sided at a TS ingest, so a rise re-locks and a fall is slewed. Orchestrator, 2026-10-14 (P1-1 and P1-8 delegated): the ASRC lock is two-sided. `ClockLockConfig::step_falls` is the per-lock constant: false for the STC, true for `mrasrc` through `asrc_lock_config()`, whose `step_ns` stays 50 ms. Either way the step's size is the run's minimum. | At an ingest a fall only leaves content earlier than needed, and stepping onto it would drop the overlap with what was already emitted. A capture labelled on its floor is late by any fall: under the one-sided rule a −60 ms capture-latency fall left labels 54 ms late for about 50 min. | Part 4.3's envelope-step row (the draft's two-sided `\|β* − β_applied\|` replaced); part 4.5; WI-P1-1, WI-P1-8; ADR-0029 Phase 1. A device past the ±1,000 ppm ratio clamp now relocks on falls too (WI-P1-8). |
| B-4 | The ASRC relock (part 4.5; WI-P1-8) | As built (fix round), 2026-10-14: on an envelope step the lock moves onto the floor of the step's own buckets (`ClockLock::step_to_floor`) and stays locked. T0 is never before the end of the last output, and input captured before that end is dropped (`AsrcServo::Command::skip`, at most `DROP_MAX_NS` = 1 s; the rest is slewed). The drop applies at every relock, a DISCONT whose PTS steps back included. | Inside the ±1,000 ppm clamp a slew takes about 2 min for 60 ms and 5 min for 200 ms, with late labels throughout: before the change a −60 ms fall took 287 s to come within a frame, and a −200 ms fall did not within 300 s. A relock from one jittered PTS misses the one-frame target under 1 ms of jitter. | Part 4.5; WI-P1-8: `mrasrc` drops `skip` frames before resampling and reports `dropped-frames` and a relock's `dropped-ns`. Measured: a −60 or −200 ms fall gives one relock 9–10 s after the step, no PTS jump, 59.935 or 199.928 ms dropped, labels within one frame from the relock. The DISCONT case replaced one `asrc_servo_test` row (a catch-up slew at −1,000 ppm); limiting the drop to envelope steps is a one-line change if vetoed. A +60 ms rise now jumps 59.988 ms (was 60.026). |
| B-5 | WI-P1-1's convergence and WI-P1-6's criterion | Measured in P1-1 (2026-10-13), adopted by the orchestrator: ±0.5 ppm by 300 s at the median and by 600 s at worst replaces "±0.5 ppm within 60 s". | Under WI-P1-1's delay model no estimator meets the draft's figure (measured, a maximum-likelihood envelope estimator included); the built least-squares fit with the 2-MAD refit has a median error of 1.8 ppm at 60 s. | WI-P1-1's acceptance; part 4.3's sweep criterion, which WI-P1-6 applies. |
| B-6 | Part 4.3 telemetry, the residual's sign | Correction, 2026-10-13: a negative residual means the mapping lies later than the arrival, i.e. added latency. The draft said content would arrive late. | r = arrival − house(σ); a PES arrives after its house PTS only when r exceeds its source lead (PTS − PCR). | Part 4.3's telemetry paragraph. |
| B-7 | WI-P1-8 against the draft | Measured, 2026-10-14: the ASRC locks in 35.01–36.01 s over 100 seeds (draft 30 s); the 1 h frame count is off by ≤ 0.70 frames at 0 and ±50 ppm and ≤ 1.19 frames at ±500 ppm, median 0.50 (draft ±1). The constants stay at the plan's values until WI-P1-6. | The lock follows the STC constants: a 30-bucket first fit plus the 5 s acquire (`rate_buckets_min` = 20 would give about 25 s). The ±500 ppm excess is ClockLock's bucket-minimum jitter. | WI-P1-8's acceptance (37 s; ±1.5 frames at ±500 ppm); V-P1-7; WI-P1-6. |
| B-8 | WI-P1-3, open | Found 2026-10-14: the degraded-mode lead clamp of part 4.3 is not in `RestampCore`, and `Event::Kind` has no `lead_clamp`. Two mutants of WI-P1-3's second fix round survive its tests: N4 (a PES length learned across an epoch change) and P3 (`map_pcr` always on the newest epoch). | Part 10's "Lead clamped" alarm needs the event with its `pid`; the mutants mark behaviour no test pins. | Open on WI-P1-3 and WI-P1-4 (WI-P1-3, part 10). The clamp and its event built 2026-10-16 (B-45); the two mutants still open. |
| B-9 | Overlap accounting and held headers (part 4.4; WI-P1-3) | As built (fix round), 2026-10-14: a duplicate of a held split-header PUSI packet is dropped alone, and the original still joins its continuation. A dropped run before the PID has learned its PES spacing is counted at each dropped PES's own source spacing (DTS for video, else PTS; a spacing ≤ 0 or over 1 s counts 0). | A legal duplicate (ISO 13818-1 2.4.3.3) of the held packet made the header unjoinable and lost its PES. An early run counted at a spacing of 0 reported no dropped time. | Part 4.4's overlap bullet; WI-P1-3. Measured: an O edit of −300 ms 60 ms into a stream counts 280, 288, 300 and 280 ms on video, audio 1, audio 2 and teletext. |
| B-10 | WI-P1-7, the identity stamper | As built, 2026-10-14: a buffer list holding a GAP member is chained member by member at an identity egress instead of coalesced (ADR-0011); the GAP early return is taken at identity egresses only; a stamp maps to running time `max(stamp − base_time, 0)`; `MRTSSTAMP_VERSION` 2.6.0. | Coalescing would hand the marker's flags and PTS to the whole access unit, or bury the marker in a data buffer. Anchored mode is frozen (Q2), and in Phase 1 every marker comes from a restamp that an identity egress follows. | WI-P1-7; ADR-0029 Phase 1, which records the exception to ADR-0011's coalescing. |
| B-11 | WI-P1-9's reporter and WI-P1-4's element | As built (ingest glue), 2026-10-14: the reporter reads `cadence-warning` and the element-wide `cc-lost` and `desync-bytes` in every `mrtsrestamp-stats` message; matches fixed strings for `state`, `reason` and `kind`; takes the degraded PID from the `degraded` event; reads the counters as running totals, a fall being a restart from 0; and withdraws the `clock` badge through the new `IngestTimingHost.clearBadge`. | Part 10 listed neither these fields nor the values. Without them the PCR-cadence and transport-error alarms never fire, and the degraded warning cannot name its PID. | WI-P1-4 posts them (its How; part 10); WI-P1-10 to WI-P1-13 bind `clearBadge` to `GstPluginBase.clearBadge`; shared-types types `PluginManifest.timing?: ManifestTiming`. The "Lead clamped" alarm waits on B-8. |
| B-12 | WI-P1-14, the offset and trim boxes | Orchestrator, 2026-10-14: the Ingest Offset and the trims apply on Enter, blur or a spinner step, never per keystroke. As built: each box binds a draft (`useNumberBoxDrafts`), so a re-render never resets typed text. | Each live write is a gap or a drop on the stream (§5.5). Vue re-sets a bound input's value whenever its owner re-renders, and the settings form re-renders on any engine's store patch, so half-typed text was reset and the Enter after it wrote nothing. | WI-P1-14's How and acceptance; ADR-0029 Phase 1. Rule for later change-only inputs: bind a draft, or live in a child whose props cannot change while someone types. |
| B-13 | WI-S0-6 (chapter 3) | As built, 2026-10-14: `mrts_cli dump` feeds only the PAT PID and the current PMT PID to discovery, so it has no PMT-before-PAT recovery: a PMT seen before the first PAT is skipped until it repeats. The PSI fix L1 (a PMT counts only with its own `program_number`) applies only when the PAT maps the PMT PID to several programs. | `dump` is a diagnostic tool, and the PMT repeats. L1 is for MPTS sources that share a PMT PID; on a PMT PID of its own the PMT is accepted whatever number it carries, as before, so no single-program source starts to fail. | Chapter 3's WI-S0-6 as built (`ts_psi.cpp`, `pmt_shared_`). |
| B-14 | The formula demux's unwrap seed (chapter 7 part 4.1; chapter 3 parts 4.2 and 4.3; chapter 6 WI-P2-7) | Plan bug found in S0's first wave (2026-10-13), corrected 2026-10-14: the seed is the unwrapped `ns_to_pts90k(clock − base_time) + MUX_CLOCK_BASE_90K`. | The draft seeded with `mux_pts_from_house(clock − base_time)`, a 33-bit value: on a box up more than 25.5 h the first PES unwraps near the folded seed and every buffer lands one 2³³ period (26.5 h) behind. Chapters 3 and 6 passed `clock − base_time` itself, in ns, where the seed is 90 kHz. | The four places corrected; WI-P2-7 (Phase 2) is the first demux built on it. |
| B-15 | The const `PacketWalker::feed` | S0 note, 2026-10-13: chapter 3 part 4.2 defines, and S0 built, only the mutable `feed(uint8_t*, …)`; part 4.3's demux row and chapter 7 part 4.1 call a const form. | The demux, and Phase 5's writer (chapter 9 part 4.2), walk a read-only input. | Phase 3 adds a const overload if the demux needs it (WI-P3-1). |
| B-16 | Open observations for WI-P1-6 | Recorded, 2026-10-14: a capture-latency change below the ASRC's 50 ms step is no step and is absorbed by the bent rate fit; +30 ms leaves labels about 2.2 ms off 300 s later (as before the fix round), and a fall below 50 ms behaves alike. Determinism checksums moved deliberately: `asrc_servo` 4e07f327c3e06bba → 49bf78feaffccea6 (second fix round) → 65ba266b108a634c, `ts_stc` 0b7dd1036d33616e → 85f5a95a7a801a1f. | If 20–50 ms latency changes occur in the field, the ASRC's `step_ns` is the knob. The checksums pin bit-exact replays, so a change to them must be deliberate. | WI-P1-6 (open observations). |
| B-17 | WI-S0-7, WI-S0-8: the plugin and its loaders | As built, 2026-10-14: `mrtsrestamp` replaced the placeholder `mrtshouse-probe`, which is deleted (`kFactories` lists `mrtsrestamp` and `mrasrc`); the `mrtshouse-load` and loader cases name `mrtsrestamp`, the "present" case with `fakesink async=false` because the restamp passes no non-TS bytes. Every element carries `abi` (property id 0x4000) and the eight counters (0x4001–0x4008). The plugin links with `-Wl,-z,defs`. The loaders run once per process at the top of the start handler; a stale plugin is removed from the registry and no later candidate is tried; only the start description is rewritten, by a gst-launch tokenizer; `started` reports `timingPlugin`; a `set_property` on a stand-in is answered by a `warning` carrying the request id. | A missing symbol fails the link instead of the runner's load, which rule 6 would turn into a warning. A second candidate's types would collide in the process, so a stale `/opt` copy masks a good libexec one and the alarm names its path. The engine cannot read runner log lines, so the load reaches it in `started`. | WI-S0-7 and WI-S0-8 read `mrtsrestamp` where they name the probe. Owner note: the alarm shows on every GStreamer module whose runner cannot use the plugin, also on modules naming no timing element; narrowing it to descriptions that name a table element is a small change. Phase 2 decides what a refused `bus_input_add` does. ADR-0029 S0. |
| B-18 | WI-P1-4: the element as built (4a and 4b) | As built, 2026-10-14: 4a was built as the full element on `RestampCore`, WI-P1-3 being done. A marker goes right before the PES that shows its gap (`Gap::at`), so its input buffer is split around it, and the pieces and markers of one input buffer leave as one buffer list; outage markers come from the element's `GstTask` as one buffer with a packet per PID. A marker's DTS is the input's DTS-or-PTS. The task runs only under `arrival=clock` in PLAYING and never waits on the streaming thread. Messages carry more than part 10: `residual-count`, `rate-warning`, `epoch` (stats), `lead-count`, with the lead fields left out until the PID has one (pid), `value-ns` (event). Counter properties and the `stats` snapshot refresh at each stats post and at EOS. `pid-trims` takes decimal or `0x` PIDs; malformed entries are skipped with one warning. `MRTSHOUSE_ABI` stays 1. | Pushed one by one behind srt-input's `queue leaky=2 max-size-time=100 ms`, a 3 s outage lost a marker or data in 10 of 10 runs (the input's own PTS jump reads as a full queue); as one list, 0 of 10. A marker ahead of the whole buffer would precede that PID's earlier PES in it. `GstQueue` reads DTS before PTS, so the input's DTS keeps the queue after the restamp still. No plugin of ABI 1 has shipped. | WI-P1-4's "before the buffer that revealed the gap" reads "before the PES that shows it, in one list with the rest of that buffer"; part 10 gains the extra fields. Measured: the first outage marker 1,000.5 ms after the last arrival, then 250.2–250.6 ms apart. ADR-0029 Phase 1. |
| B-19 | OQ-12: no DTS on the bus (WI-P1-7) | Fix round of WI-P1-11, 2026-10-15: at an identity egress `mrtsstamp` and the Python probe clear a marker's DTS; its PTS, duration, flags and bytes pass unchanged. The restamp still gives its marker the input's DTS, for the queue between them (B-18). | Behind an identity egress that DTS sat on the input's timeline next to house-time data, so the 5 s bus edge queue and the 5 s consumer ingress queue read their level as house minus arrival and leaked the buffer behind the marker (a deterministic case lost it before the fix, in both backends). | OQ-12's decided form adds "no DTS on the bus"; WI-P1-7's "return early, buffer untouched" reads "leaves with its PTS, duration, flags and bytes, and no DTS". `MRTSSTAMP_VERSION` stayed 2.6.0 (unshipped), then 2.7.0 with WI-P1-15 (B-27). |
| B-20 | OQ-12: DISCONT on the marker | Finding, 2026-10-14, open for the owner: DISCONT makes every Phase 1–2 `tsdemux` consumer drain and flush at each marker (gst-plugins-bad 1.28.2 `mpegtsbase.c:1539–1557`, `tsdemux.c:2314–2356` and `:3989–4007`). Measured, an 8 s stream with three markers through `tsdemux`: video 199 and audio 330 PES out and three DISCONT outputs per stream, against 199, 331 and one each with markers that carry no DISCONT. | One audio PES lost, and two extra DISCONTs per stream reach the decoders. | Development and gate checks only (V-P1-3, V-P1-6, V-P1-12…16): Phase 3 replaces `tsdemux`, and no release runs Phase 1 with today's consumers. If vetoed: GAP alone, one line in `restamp_marker`; Phase 2's readers key on GAP. |
| B-21 | The fixed-mode jump rule (WI-P1-3, WI-P1-4) | Fix round of WI-P1-11, 2026-10-15: in fixed mode a PES is a gap (`jump`) when its spacing from the PID's last PES exceeds twice the PID's PES length, the length being the upper median of its last three clean spacings (the longer of two while only two are known, no test before two), a jump's own spacing joining them and an edit's or an outage's not. Chosen over the specified "twice the longer of the last two non-jump spacings". | `mrasrc`'s first output (16 of 48 samples on 1 ms AES67 packets) and a relock's remainder (4 of 2,880 samples) had set the reference and made every later PES a jump. Under the specified rule a lasting cadence rise past 2× marks every later PES: a PipeWire quantum rising from 512 to 2,048 samples gave 299 markers; the built rule gives two, then none. | WI-P1-4's "more than two frame durations" and part 4.5's "> 2 frame durations" mean this rule on audio and other PIDs; a video PID is exempt below 1 s (B-89): its jump is a hole of 1 s or more. The two markers of a cadence rise are false (their hole lies inside the last PES): Phase 2's aligners must not lower on a marker shorter than the PID's PES length (WI-P2-6), which on a video PID no longer arises. A video-encoder frame-rate drop past 2× is learned the same way, without a marker. |
| B-22 | WI-P1-8: the `mrasrc` element | As built, 2026-10-14 and 2026-10-15: the interpolated cubic filter table is forced; `out-rate` 0 means the input's rate or the rate the caps downstream ask for; the resampler is updated in `prepare_output_buffer`, before `transform_size` sizes the output; stats every 2 s of output labels, no `stats-interval-ms`; events carry `kind`, `reason` and `house-ns`, plus `jump-ns` and `dropped-ns` (relock) or `fit-ppb` (ratio-out-of-bounds); a buffer that makes no output is not pushed; at EOS the lookahead drains on the same counter. `MRTSHOUSE_ABI` is not bumped. | AUTO picks the full table when the scaled rates reduce small: 44.1 → 48 kHz (147/160) asked for 15.7 GB. WI-P1-9's `buildAsrc` and WI-P1-11's strings rely on the negotiated rate (a 44.1 kHz device onto a 48 kHz bus). The base class sizes the output before `transform` runs. | Part 4.5's "the resampler selects it" and WI-P1-8's "0 = same as input" and "`transform` … after `gst_audio_resampler_update`" read as built. Measured at a 1.0002 ratio with 1 ms jitter: THD+N −110.4 dBFS (F32LE, S32LE) and −94.4 dBFS (S16LE); the element reproduces `asrc_servo_test`'s model to about 1 µs. Pi 5 CPU at quality 4: 1.04–1.24 % of a core stereo, 4.18–5.21 % for 8 channels; the Pi 4 bench is a gate step. Servo findings, minor: whole-frame phase steps (about ±1 ppm per buffer, FM 87 dB below the tone); labels up to 1⅛ frames late for about 2.5 s after a DISCONT whose PTS steps back. |
| B-23 | Rule 6 for `mrasrc` | Found 2026-10-15: neither runner's stand-in table (`native_plugins.cpp`, `gst_native_plugins.py`) had an `mrasrc` row, so without the plugin audio-input-302m, aes67-input and audio-encoder failed to parse ("no element mrasrc") instead of starting with the rule-6 alarm. Fixed 2026-10-17 (B-47): both tables stand `audioresample` in for it. | WI-S0-8 left a row for each phase to add; the element came later. `audioresample` keeps the nominal-rate conversion, unlocked. | The twin test pins the two tables equal, every element the plugin registers to a row of them, and starts each stand-in to PLAYING through both runners (`gst_native_plugins_test.py`, `native_runner_protocol_test.py`). Owners WI-S0-8 and WI-P1-8. ADR-0029 Phase 1. |
| B-24 | RTP start-up latency at mpegts-ip-input (WI-P1-1, WI-P1-10) | Finding, 2026-10-15, open: `rtpjitterbuffer` releases its first ~160 ms of packets in one burst; `ClockLock` seeds β from the first sample and slews it out at 2,000 ppm, so content lands ~161 ms later than source-natural for ~80 s after each start (residual p50 −161 → −137 ms over 14 s on the dev box). | Added latency only: nothing is late or dropped. SRT, RIST and raw UDP show no such burst. | Options for WI-P1-1 and WI-P1-6: seed β from the first bucket's minimum, step down once before the first fit, a faster acquire slew, or `rtpjitterbuffer faststart-min-packets`. Gate check: residual p99 right after an RTP start. |
| B-25 | WI-P1-12: audio-encoder | As built, 2026-10-15: the capture caps are pinned to F32LE, the channel count and, from two channels up, GStreamer's fallback channel mask; `srcBufferMs` defaults to 60 (was 200; range 40–85, OQ-16) and a stored value outside the range is reset to the default; the restamp also precedes the no-channel `fakesink`. The `pipewiresrc` spike ran on the dev Pi 5 (PipeWire 1.2.7, 600 s, 14,064 buffers): PTS on the driver cycle, no ring-sized steps, so the `pw_time` fallback was not taken. | The WI's open chain hung in PAUSED under `opusenc`; an open count comes back downmixed; GStreamer reads more than two channels only with a mask. | Startup artifact for WI-P1-8 and WI-P1-6: the first `pipewiresrc` buffer is labelled one quantum late, so `mrasrc` sits at the −1,000 ppm clamp for about 28 s to slew it out, labels up to ~40 ms after capture time for ~40 s; the ASRC warning does not fire (about 12 s to spare). Gate: the spike on the fleet's PipeWire 1.6.3 (V-P1-9). Pre-existing: Opus at 44.1 kHz never negotiated. |
| B-26 | WI-P1-13 and the bus-egress lateness tap | As built, 2026-10-15: video-encoder's Ingest Offset shows in WI-P1-9's capture card (a Clock section), not in Phase 0's `timing` section. Found: in a `liveCaptureClock` pipeline the bus-egress tap `lat_busout_<port>`, then `reference=house`, read the base time plus the encode latency, because the stamper writes running time there (stamp − base time); it did under the anchored egress too, so it predates Phase 1. **2026-10-22 (.108, wf11):** the encoder card read 533,786–533,963 ms (B ≈ 533.7 s, its PLAYING on CLOCK_MONOTONIC) against 40–200 ms at its consumer, and nothing after a restart past 1 h. A **second instance with another cause:** an egress with no consumer leaves `mrtsstamp` inactive (the lazy arm, 83% of the contract's CPU, by design), so the tap reads the mux's own buffer PTS. These are no house time at all: on the audio mixer (base 0, identity segment) they ran a constant 532.7 s (≈ its launch on CLOCK_MONOTONIC) behind its PES, giving 532,763–533,262 ms with no consumer, then 538–605 ms from the arm at 22:52:43Z. `reference=running-time` corrects the first and not the second. Both reached the routing: a consumer's `mralignwatch` seeds its pace from the producer's output lateness (`seed-lateness`, a floor of the pace that only rises), so an aligner consumer of an encoder, or the first aligner consumer of an unconsumed producer, on a box up less than 1 h would have held its output by that many seconds. Not seen on .108: no seed was applied. **Fixed 2026-10-22 (engineering choice, for the owner's veto):** the egress tap is `reference=running-time` (`busEgressLatenessTap`, in `buildBusSink`), exact under any base time; the ingress taps stay `house` (`busLatenessTap`), since no pipeline with a bus ingress has a natural base. Both runners forward a `lat_busout_<port>` window only while `busout_<port>` is armed, and drop the first after each arm, which holds samples from before it (`take_egress_window` in `stamper.cpp` and `gst_bus_stamper.py`, at the forwarding point: only the runner knows the exact arm, since a `bus_attach` can wait behind the socket gate). A missing stamper plugin arms nothing, so it forwards none. `LatenessReporter` keeps its 1 h guard and warns once per tap and run that it hides ("Lateness tap <tap> read <n> ms, off the house timeline: not shown"), which after the fix only a fault produces. The seed path is unchanged: a seed is now a true lateness or absent (`MediaRouter.test.ts`'s quiet producer). Not on `origin/v2.0` (the taps came with Phase 0, the identity stamper and the seeds with Phase 2). | Measured on the dev box under a 620.8 h base: 2,234,996,888 ms (native) and 2,235,027,240 ms (Python), against 18.6 and 29.9 ms at the consumer. On .108 under a 533.7 s base: 533.8 s against 40–200 ms. `LatenessReporter` hides a window of 1 h or more, so a long-running box showed no output lateness at all, and a box booted within the hour showed minutes. The unconsumed egress read the producer's launch time whatever the reference, and both wrong numbers could seed an aligner. Now a producer shows no output lateness, and seeds none, until 2–4 s after its first consumer's arm. | Part 8's video-encoder row reads as built. ADR-0029 Phase 0's tap paragraph and its "Two guards": egress taps on running time, no egress window without a consumer; its Phase 1 open item is closed. **Tests:** `latenessTap.test.ts` (ingress `house`, egress `running-time`, both empty without the instrument); the egress expectations of the `buildBusSink` producers and of the Python rigs that copy it, the two `pipelines.json` fixtures regenerated; `gst_mrlateness_element_test.py`: an armed `mrtsstamp` under a natural base, the egress tap as the modules build it (read from `fixtures/aligner/pipelines.json`) reading λ within 5 ms and a `house` tap base + λ, and a base-0 control (the two within 1 ms); `gst_lateness_protocol_test.py` on both runners: no egress window for 5 s before `bus_attach`, every forwarded window after it within 1 s on running time, none for 5 s after `bus_detach`, none without the stamper plugin; `gst_bus_stamper_test.py`, through the runner's handler: none unarmed, the first after each arm dropped, none dropped for a second consumer, none after the release or without the plugin; `latenessReporter.test.ts` and `moduleTiming.test.ts`: one warning per tap and run. Each fails on the code before, and each mutant (the forwarding rule or the skip removed in either runner, the egress tap back on `house`) fails one of them. **Device check** on .108: the encoder's output lateness within ±20 ms of its consumer's `timing-in-1`, on a fresh boot and after an engine restart past 1 h; a mixer with no consumer shows no output lateness, its first window after a consumer attaches is under 1 s, and it is gone within 6 s of the detach; an aligner consumer wired to a producer that ran unconsumed shows `seed-lateness` absent or under 1 s. |
| B-27 | WI-P1-15: the deletions | As built, 2026-10-15: the override halves of the conditioner-threshold tests are deleted and the default half kept as one case each in C++ and Python (the fixed 300 ms leaves a +190 ms single-audio-PID step on the wire); audio-encoder's absence check became an exact key-set assertion; `MRTSSTAMP_VERSION` is 2.7.0 for the removed `condition-step-ms`. | The kept case is the only test that catches a 100 ms threshold mutation, in both languages. The element version moves with every interface change. | Part 6's "tests pinning the override" reads "their override halves". A Phase 0 runner looks the property up before setting it, so a mixed fleet logs nothing. |
| B-28 | WI-P1-2: replay and the synthetic traces | As built, 2026-10-14: `restamp-replay` plays a trace back as the TS its recorder read (`TracePlayer`) and runs the whole `RestampCore`, so the mapping exists once; `jsonl2trace` completes the round trip; WI-P1-3's `restamp_replay_test.cpp` is the fixture loop of `tests/trace_cli_test.sh`. The `.expect.json` schema is defined by `mrts_cli`; the eleven synthetic traces are regenerated from the `fixture_gen` line in each expectation, not committed (about 5.2 MB), and `syn-drift-ppm` is four traces (±50, ±500 ppm). | §13.1: no second implementation, not even in a test tool; the expectation rules then exist once. | WI-P1-2 and WI-P1-3 read as built. A trace does not carry payload, CC loss, duplicates, PES without PTS or live edits, so those do not replay. The generator checksum 832e8bd4d56c5e57 pins cross-machine determinism (the `build-native-dev.sh` runs are still to do). |
| B-29 | WI-S0-10: the hls-pipe reference | As built, 2026-10-14: six allowlist entries (`clamps-pts-dts`, `ignores-cc`, `single-section-psi`, `one-pid-per-kind`, `ignores-pes-length`, `no-resync`), each with its reason and an evidence check, and the payload CRC-32 compared too. Found: hls-pipe throws `PmtParseError` on a PMT spanning packets (the OCC feed's 514-byte, 23-stream PMT). | `ignores-pes-length` and `no-resync` were needed by real captures and by the parity fixture's garbage. | Worth an hls-pipe issue (reassemble sections, parse on PUSI with a CRC check): it would stop hls-player on an origin whose PMT spans packets. |
| B-30 | WI-S0-13: tests off the device | As built, 2026-10-16: the recipe's `do_install` prunes every `tests/` directory from `/opt/media-router` after its copy (`find … -type d -name tests -prune -exec rm -rf {} +`), and the dist tarball's packer excludes them and refuses a payload that carries one. Nothing at runtime reads a `tests/` directory; in `node_modules` the only ones (zod's `src/*/tests`, sonic-boom's `types/tests`) are no entry points. | OQ-2: fixtures in the repository, off the device. Copy, then prune keeps the copy's exact semantics (pnpm symlinks, owners, the top-level dotfile rule); a dry run of the two lines left the tree equal to the source minus its `tests/` subtrees. | The recipe change is in the Yocto layer, uncommitted for the owner; the packer is deploy tooling outside the submodule. Gate: `find /opt/media-router -path '*/tests/*'` empty after an image install and after a dist deploy. |
| B-31 | The ingest-timing host binding | Recorded, 2026-10-15: the `IngestTimingHost` binding (section merge, the own-warning rule, `clearBadge`, the re-assert at PLAYING and on a return to ok) is repeated in all seven modules. | `GstPluginBase`'s own-warning latch is private, and the lanes could not touch it. | Refactor candidate: a protected helper on `GstPluginBase` with an owned-warning kind of its own. |
| B-32 | WI-S0-9: the conformance set as built | As built, 2026-10-16: `PesIndex` (`ts_dump`) is the dump's PES index as a class, so `mrts_cli dump` and `ts_conformance_test` print one format; `fixture_gen --ts` carries the byte-for-byte port of `py/native_parity_fixture.py` (6,698,476 bytes, CRC-32 `8fedaffa`, pinned in the test) and the five synthetic shapes; `--drop` derives `cap-cc-loss`. Twelve fixtures and thirteen expectations (`syn-mpts-two-programs` also as `.p2` for program 2) pass at 188, 1316 and 24 576 bytes; every PES the dump emits agrees with ffprobe and, where it reads, with hls-pipe. Renamed: `cap-occ-1080i-h264-mp2-ttx.ts` is `cap-occ-1080i-h264-aac-ttx.ts`, since the OCC feed carries AAC. Substituted: `cap-mux-unbounded-video` is our mpegts-muxer's remux of the OCC 1080i H.264 on .103 (no transcoder here writes B-frames, so none writes a DTS); `cap-mux-align7-aac-opus` is a mpegts-muxer of AAC and Opus on .103 (an audio-encoder or audio-transcoder egress carries one PID). Missing: `cap-vmix-cbr-h264-aac` (OQ-3: no rig reaches a vMix source). | The part 7.2 pins hold on these sources; a name must say what the file is. | The ts_restamp_test spots that name WI-S0-9 fixtures (`test_mapping`, `test_split_header`, `test_wrap`) still run their own generators. The ffprobe review notes ffprobe's own behaviours: teletext PTS taken from the PCR, the padding stream not output, PES before the first PMT and cut by a discontinuity or EOF kept. |
| B-33 | WI-P1-5: the traces as recorded | As built, 2026-10-16, on the Phase 1 build: the plan's pipeline-string override is a temporary hook in the boxes' engine (a marker file arms `trace-location`, or a tee before the restamp, at a module's next start), reverted after. `trace-occ-1080i` is the July OCC multicast capture fed at its recorded arrivals into the element on the dev box (the .103 rig replays it with a Python pacer and loop seams). `trace-816-clean-cbr` is a pre-encoded libx264 CBR stream sent at its mux rate (GStreamer `tsparse` + `srtsink sync`) into srt-input on .108; the same encoder writing straight to SRT delivers in bursts of up to 400 ms and is kept as `trace-srt-bursty-encoder`. `trace-srt-restart` stops that paced caller 5 s and restarts it from the file's start: one relock (leap), one gap per PID of the outage less the source's lead change (5.92 s for 6.11 s), so V-P1-3's ±50 ms holds only for a restart that keeps its lead. `trace-rist-reconnect` drops a .108 → .103 RIST loop for 5 s with nft; `trace-836-program-split` restarts its sending module. New: `trace-gate01-rist-20010` and `-20046`, the gate's real RIST outputs (owner, 2026-10-16: test boxes may pull them as a site does). `trace-812-slow-source` is the generator at −300 ppm. Missing: `trace-820-vmix-pcr` (OQ-3). #825's swing does not reproduce on 20010 today. | Each source is the closest the rigs reach to the row's case, and the notes in each `.expect.json` say what its dump shows. | Fixtures and expectations in `tests/fixtures/restamp/`; captures beyond them in /home/mrstation/mr-captures/wf7/capture/ on the dev box. |
| B-34 | Finding: today's gate egress through the restamp | Measured, 2026-10-16: the gate's RIST outputs (frozen model) carry a PCR and PTS that move together against arrival by up to ±200 ms from one second to the next, with 13 unflagged leaps of −250…−324 ms in 520 s, PCR p99 271 ms. With the shipped constants the restamp never locks (the rate fit restarts on every floor move), relocks on each leap (17), degrades at the third leap in 60 s with no recovery, and the monotonic guard drops 3.4–5.1 % of the content (17.6 s of 520 s on 20010, 20.3 s of 396 s on 20046). | Phases 1–4 ship together, but a receiver on that release meets senders still on the frozen model until they move too (R-P1-14, V-P1-19). | For WI-P1-6's sweep and the mixed-fleet plan: the drop is the design's overlap rule on a rewinding timeline; whether a degraded program should drop or slew sub-leap rewinds is open. The two traces hold today's counts as their ceiling. |
| B-35 | Finding: the offset acquired on an SRT start burst | Measured, 2026-10-16 (`trace-816-clean-cbr`): one of three paced SRT starts into srt-input delivered its first ~0.5 s of content in one burst (13 PCRs within 6 ms, the first 513 ms above the floor that follows; the caller connected as the listener's module started). β is acquired on that burst, the 2,000 ppm acquisition slew removes 2 ms a second until the lock at 36 s, and the 20 ppm track slew then needs about 6 h for the remaining 445 ms: the mapping runs about 0.43 s late of source-natural for hours (residual −446 ms at the lock, −429 ms after 15 min, the mapping moving at the 20 ppm limit throughout, ε still moving by 1.7 ppm). One hop on, the RIST loop that relayed that ingest to .103 read the slew as the source's rate (ε +17.5…+30 ppm in `trace-rist-reconnect` and `trace-836-program-split`). The other starts, the multicast and the loop's own start show a residual within 3 ms. | Part 4.3 assumed the acquisition settles in seconds; a start transient of the SRT latency is larger than 5 s × 2,000 ppm. | For WI-P1-6 (or WI-P1-1): β taken from the lower envelope at the lock rather than slewed to it, or the acquisition slew kept until the residual floor is within `step_ns`; the trace holds today's residual as its floor. |
| B-36 | WI-P1-6: the sweep and the constants shipped | WI-P1-6, 2026-10-16 (engineering choice, for the owner's veto): part 4.3's grid, 243 points, on 57 traces (the eight field traces, thirteen synthetic, 36 drift seeds), judged by part 4.3's criteria plus WI-P1-1's 40 s lock; 36 points pass, all at 1 s buckets. Shipped: the draft's constants but `rate_tau_ns` 120 s (was 60 s) and `leap_ns` 500 ms (B-38). M stays 10 rather than the longest 30; `rate_buckets_min` stays 30; mrasrc's constants stay. | 2 s buckets lock at 65–68 s; 0.5 s buckets miss the drift row (0.81–1.32 ppm at 600 s); a 50 ppm track slew breaks the 20 ppm mapping row; a 50 ms step misses the +30 ms re-route. τ 120 s halves the worst seed at 600 s (0.16–0.25 ppm against 0.27–0.34 at 60 s) and moves nothing else measured. M 30 widens the bursty encoder's relock gap (407 against 206 ms) and degrades gate 20010 on the lead row; no clean trace separates M. A 2 s bucket with a 15-bucket first fit passes too but widens the bursty gap to 315 ms; `rate_buckets_min` 20 adds a relock per gate trace and is asked for by no criterion (B-7). mrasrc over 100 seeds × 1 h: lock 35.0–36.0 s and frame counts (≤ 1.19 at ±500 ppm) unchanged to 0.01 frames, not better with 2 s buckets, so the ±500 ppm excess is not the bucket minima's (B-7); no 20–50 ms latency change was captured, so its 50 ms step stays (B-16). | `ClockLockConfig` and `PcrValidatorConfig` defaults; part 4.3; WI-P1-6 as built; ADR-0029 Phase 1 "The constants, tuned by replay" (grid, criteria, per-trace table). Checksums moved (B-16's chain): `ts_stc` 85f5a95a7a801a1f → d0ec660233eef7cd, `asrc_servo` 65ba266b108a634c → 432e8439f253974f. V-P1-1's ±0.1 ppm needs a source with a stable clock: between two chrony-disciplined boxes the floor's slope wanders 2 ppm (`trace-816-clean-cbr`). |
| B-37 | The first epoch's floor (B-35, B-24) | WI-P1-6, 2026-10-16 (engineering choice, accepted by the owner (2026-10-16/17)): in a lock's first epoch, until its first relock, the line moves onto the floor its first two buckets agree on (within `step_ns`, and more than `step_ns` below the line) at their close; the overlap already sent is the ingest guard's to drop, once. Relocks keep the acquire slew. | No constant of the grid removes a start burst: on `trace-816-clean-cbr` every point left the residual at −386…−476 ms at the lock and the mapping at the slew cap for 905 s; with the rule −0.07 ms, and one drop of 990 ms at 2.5 s. At every relock the rule raised the gate's drops from 17.6 to 24.2 s, and a relock runs on a live transport, whose backlog is no start burst. One bucket alone steps onto dips (the bursty encoder: 741 ms dropped, a 366 ms gap). Keeping the acquire slew until the floor instead left 2,000 ppm on the PTS for 4 min and three more relocks on the bursty trace. | `ClockLock::seed_floor` (`ts_stc.cpp`); `ts_stc_test`'s start-burst cases; `syn-start-burst` (part 7.2); `trace-816-clean-cbr` re-expected; ADR-0029 Phase 1 (B-24's paragraph). Every pipeline start whose transport delivers a backlog drops that backlog's overlap once (1 of 3 SRT starts on the rig; rtpjitterbuffer's start, not yet on a trace). mrasrc's lock takes the rule at its 50 ms step, and its servo slews the phase change out at the ratio clamp (a first buffer 85 ms late: labels within 1 ms by about 100 s, against 12 ms late after 3 min with the slewed lock; B-25's one-quantum start, under 50 ms, is unchanged). |
| B-38 | `leap_ns` 500 ms (B-34) | WI-P1-6, 2026-10-16 (engineering choice, accepted by the owner (2026-10-16/17)), from the field traces: the leap row's bound is 500 ms (draft 250 ms). | On the gate's RIST outputs the PCR advances 60 ms per PCR while arrivals come 0–384 ms apart: delivery stalls, not timeline jumps. Under 250 ms each stall over 310 ms relocked (17 in 520 s), three in 60 s degraded the program for good, and 3.4–5.1 % of the content was dropped. At 500 ms: 0–1 relocks, never degraded, 0.63 s (the start rule) and nothing dropped. 350 ms measures the same but sits at the largest miss seen on the three ports (353 ms). | `PcrValidatorConfig::leap_ns`; part 4.3's leap row and 7.2's gate rows; `ts_restamp_test`'s re-routes (+300 ms is now an envelope-step case, the leap case +600 ms); the gate traces' expectations; ADR-0029 Phase 1. Cost: a 250–500 ms jump or rise waits the envelope step's 10 s hold, and a fall is slewed. A leap confirmed by the PCRs after it would remove the trade; not built. A receiver of today's gate egress lands its PES up to 554 ms after their house PTS (the lower envelope of a ±300 ms delivery), which its consumers' latency must cover (R-P1-14, V-P1-19). |
| B-39 | Finding: a reconnect backlog in the first epoch (B-37, B-8) | Measured, 2026-10-16, open (both runners; the element is native in both): a paced SRT caller (`srtsink sync=true`) that keeps running while its listener is gone sends what it queued at once when the listener returns, and the new lock seeds its first epoch on the oldest of it. On .103, with the srt-input disabled for 30 s, the egress stamps ran 25.9 s ahead of arrival; B-37's rule then moved the line onto the floor and the guard dropped the overlap, so the next 26 s of live content left as no PES (the PES-less buffers repeating the last stamp) until `overlap`, 32 s after the re-enable. On .111 (Pi 4), after a 90 s engine restart, the backlog drained over more than one bucket, the first two buckets disagreed by more than `step_ns`, and `seed_floor`, which runs once at the second close, left the line where it was: lead 86.4 s for 3.5 min (Python runner) and 95.97–96.01 s (native: "Degraded clock: lead out of range", residual p99 −95,978 ms). `degraded (lead)` did not bring it down (the reference lock was fed the same burst, and the clamp is B-8's), the acquire slew would take about 13 h, and the next relock, a forced source restart, dropped 86.4 s of live audio as overlap. | A listener outage while the caller queues is ordinary in the field (an engine or module restart, a network loss). B-37 was sized on a start burst of about 0.5 s that closes within two buckets; the drop it accepts once grows with the backlog, which bears on its veto. | For WI-P1-6 with B-8, not built: a backlog is stale and should go as late, with the live content after it kept. Candidates: re-test the floor at every bucket close while the first epoch acquires, and hold the output while content runs ahead of arrival by more than `step_ns`, so that the held backlog is what the guard drops; B-8's clamp for a degraded reference. A `syn-reconnect-backlog` trace (30 s and 90 s backlogs drained over 1 s and 5 s) belongs in part 4.3's sweep. Until then an outage of length T behind a queuing caller costs up to T of live content again after the reconnect (.103), or plays up to T early until the next relock, which then drops up to T (.111). Fixed 2026-10-16 (B-45). |
| B-40 | Finding: the frozen splitter's conditioner on interlaced H.264 (wave-6 findings (a) and (c)) | Measured, 2026-10-16, on the .103 OCC rig: `TimelineStamper::condition` (anchored mode, mr-tssplit) reads the OCC 1080i H.264 PID's B-pyramid reorder jumps (decode-order PTS +360 ms arriving 14–25 ms after the previous PES; 10 of 2,258 PES pairs pass its test, \|ΔPTS\| > 300 ms and \|ΔPTS − Δarrival\| > 300 ms, even on the recorder's wire timing) as clock steps on the PCR PID, its reference, and absorbs about 320 ms each time, never released: −511,200 ticks after 2.5 min, −19.3 s after 9 min. The audio PIDs never adopt them, and the PCR is regenerated from the falling reference (−6,000…−61,000 ppm at the decoder's input, PTS − PCR 1.0 → 15.3 s in 7 min). So (c): a PCR-mode `tsdemux` consumer of a splitter audio PID (the deprecated audio-decoder) presents ever earlier, about −10 ms/s from the first minute and not at the loop seams; and (a): wiring a video consumer re-bases the splitter's shared anchor onto the video's written timeline, and the audio leg's stamps jump by the divergence (decoder input +54 → −18,441 ms). The same absorption shows in Phase 0 at the ingest's conditioner, on .103's gate 20010 chain under the old `leap_ns` (−7.7 s on the video PID, the audio leg stamped 7.4 s early), and after a source restart, where the restamp's gap is absorbed on the PCR PID only (−6,499 ms A/V at a muxer behind the splitter until the splitter restarted; V-P1-15). | Anchored-mode code frozen by Q2; Phase 1 took the conditioner out of the ingests only. | No Phase 1 change: WI-P2-4 (splitter pass-through, PES never written, PCR copied) removes its last user. Until then a splitter on an interlaced H.264 programme drifts its PCR and its A/V, and a source restart behind a splitter offsets A/V until the splitter restarts. With `leap_ns` 500 ms (B-38) the gate feeds no longer feed it: 0 relocks and 0 `conditioned` PTS steps on .103's two gate splitters in 10 min. |
| B-41 | Finding: teletext cue lateness on the TTX rig (wave-6 finding (b), V-P1-13) | Measured, 2026-10-16: not a defect. The −996 ms is `ttx_gen`'s own 1 s teletext lead (PES PTS = PCR + 1 s), which the restamp keeps; Phase 0's ingest anchored the teletext-only TS on its first PES and hid it. On the OCC replay (page 888, 42 cues in 4 min) every cue start equals house(teletext PES PTS) within ±0.5 ms, the KLV stamp is the PES PTS − 1 h exactly, cues reach the consumer 26–33 ms before their start, and the bridge logs one retime line and no K reset in 8 min. | The restamp keeps each PID's source relationship (part 4.4), where the anchored ingest re-based a sparse TS on its first PES. | No code change. The OCC video still leads its teletext by about 1 s, so a burn-in transcoder keeps `subtitleDelayMs` near 1,400 (unchanged by Phase 1); the burn-in itself was not run in this round. |
| B-42 | V-P1-12's criterion | Finding, 2026-10-16; the texts reworded 2026-10-17 (B-47): "+0.000 ms off the prediction" (V-P1-12, part 7.4) holds only for an outage of zero length. `branch_retime` predicts that the stamps continue across a PTS discontinuity (the anchored model), while the restamp inserts the outage as a gap (part 4.4), so each new epoch is off the prediction by exactly that gap: +6,146.000, +6,108.967, +6,086.244, +6,129.722 and +6,092.144 ms (native), +6,147.533, +6,111.222 and +6,082.889 ms (Python), against the restamp's gaps of the same restarts (+6,109, +6,086, +6,130 and +6,092 ms on the tap); K −3,600,000,000,000 ns throughout, no "K moved" line, no consumer restart. | Both texts predate part 4.4's gaps. | V-P1-12 and part 7.4 now read: each new epoch off the prediction by the gap the restamp signalled for that restart (to 1 ms), and no "K moved" line. |
| B-43 | Finding: capture-latency steps on .111's SSL 2 (V-P1-7, B-16) | Measured, 2026-10-16, open: both 302M captures of the SSL 2 (USB, duplex) stepped +83.5…+85.2 ms at the same instant at 10:19:42, 12:12:42 and 13:01:42Z, with PipeWire's ERR counters at 0; `mrasrc` relocked (`envelope-step`) and the restamp signalled `gap (jump)` with one GAP marker; no backward PTS, identity to 1 ns, nothing logged by the mixer. Over the hour 84,381 of 84,382 PES pairs were within ±1 tick of sample count / 48 kHz (Python runner, 15 min: 21,095 of 21,096); .50's KT-USB 302M capture had none in 10 min. | Most likely the duplex device's capture latency moving when its graph is reconfigured: .111's `Chat IN` srt-input retries every ~11 s and its chain ends in the SSL 2's output. Whether samples were lost is not established. | V-P1-7's bus criterion fails as written on this interface: each step is a relock and an 85 ms gap (the 50 ms step, B-16). For the owner: a capture-latency step as a gap (as built) or slewed. V-P1-7 and V-P1-8 name .108, which the owner took out of testing on 2026-10-16; this round ran V-P1-7 on .111 and .50, and V-P1-8 not at all. |
| B-44 | Findings: the rest of the round | Measured, 2026-10-16. (1) A frozen muxer's egress into a Phase 1 ingest (.103 transcoder video and splitter audio → mpegts-muxer → srt-output → .22 srt-input): "Degraded clock: PCR jump", 26 relocks in 10 min, PCR every 414 ms, 44 s of content in a 60 s capture, no avskew match: B-34's gate pattern off the gate (V-P1-15's second path). (2) A Phase 0 box ingesting a Phase 1 relay (V-P1-19): its latch settled once (143.7 and 75.6 ms at two starts), but its conditioner absorbed ±0.30…0.62 s PCR steps about 20 times in 8 min, none on its direct Phase 0 feed; the relay ingest's egress decodes clean. (3) The audio round: every ingest, muxer and transcoder egress decodes without a timeline gap; the frozen splitter → deprecated audio-decoder sinks drop on both builds (per 60 s: .103 Phase 1 68 gaps, 4.4 s; .22 12, 2.9 s; .50 Phase 0 106–116, 7.8–8.4 s on the relay and 177, 50.9 s on its own Phase 0 feed). (4) After a live rewire the video player asks its old route head for a D raise until the next engine restart; an audio-transcoder fed a whole A/V programme fails its 50-buffer probe ("No audio caps detected", seen before Phase 1). (5) `tools/avskew/avskew.py` calls `Gst.init([])`: PyGObject 3.42, on the dev box, rejects `None`, so the tool did not run where its README says it does (WI-P1-17). | Frozen code (Q2), measured against the Phase 1 build; (5) a tool fix. | None for Phase 1's code. (1) is WI-P2-12's; (3) WI-P2-4's (with B-40) and the deprecated decoder's; (2) is R-P1-14's window, where old boxes take the Phase 1 lead as foreign; (4) is recorded only. |
| B-45 | The fix round of the Phase 1 review: B-39 and B-8 | Built 2026-10-16 (engineering choices, accepted by the owner (2026-10-16/17); whether to drop a stale backlog at all is the review's owner question, recommended and built as drop). (1) **The first epoch's floor, tested while it falls.** The first epoch tests its last two buckets at every close while it acquires, as long as their minima keep falling by more than `step_ns` (a backlog draining); the first pair that agrees decides (the line moves onto it when it lies more than `step_ns` above), and a pair that rises (a dip passed) decides that nothing moves, as B-37's first pair did. (2) **A backlog's floor, in any epoch.** Two buckets that agree on a floor more than `backlog_ns` (4 s as built, 500 ms since B-47, 490 ms since B-48; new in `ClockLockConfig`; 0 is off, `mrasrc`'s setting, whose PTS is the capture time) below the line move it in any epoch and phase. (3) **The stale rule** (part 4.3). While the live line lies more than `lead_max_ns` above the floor its open and last closed bucket show, or more than `step_ns` above it and would put the PES more than `lead_max_ns` ahead (narrowed by B-47 to a lead the floor gap explains, and by B-48 to a line more than `backlog_ns` above its floor), what it maps is stale: dropped, counted as overlap (the run's event reason `backlog`), kept out of the lead row, the written PCR at arrival less 250 ms, never back, flagged at both switches; the PES that shows a hole after the run carries a gap marker, reason `backlog`. (4) **The lead clamp (B-8).** Degraded, a PID other than the reference whose lead under the reference mapping passes `lead_clamp_ns` (4 s, new in `PcrValidatorConfig`) leaves on a `ClockLock` of its own (its earliest arrival; its leaps and steps relock it as the reference lock's do; an epoch id of its own, so the guard and the gap see the switch), `lead-clamp` names it and its lead at once and every 30 s while it holds, and it holds until the program recovers. | The review asked for (1) at every close while the first epoch acquires and for (3) as a PES lead past 4 s while the first epoch acquires. The first, measured: the bursty encoder's floor dips during its 244 s acquisition were stepped onto (5 overlaps, 10 PES, its relock gap 395 ms against 206); falling pairs only leave every field trace as it was. The second misses the reconnect into a running pipeline: srt-input listens with `keep-listening`, so a queuing caller's return is an outage then a leap, and the relock seeds the new epoch on the backlog's oldest sample (`syn-reconnect-backlog-relock`: before, degraded 5 s later and 29 s of live content dropped at the recovery). The floor gap judges the line, not the source, so a vMix-like PID far ahead under a good line still reaches the lead row and the clamp. The PCR evidence lags a fast drain by up to a PCR interval, hence the second clause (without it 3 PES of a 30x drain left 4–5.4 s ahead). Measured on the synthetic traces: a 30 s backlog drained in 1 s plays its oldest 3.5–3.7 s, then live, 2.5–2.7 s of live content lost (3.2 s in `ts_restamp_test`'s harness), never degraded (before: degraded, 30 s early, then 29 s of live content dropped); 90 s in 5 s resumes at 7 s past a signalled hole of 3.2–3.4 s, 2.0 s of live content lost (before: everything after the recovery dropped). A backlog under 4 s (3 s in 2 s) is no longer left 3 s ahead for hours; the guard drops its length of live content once, as at a start burst (B-37). After a relock it still was (B-47). | `ts_stc` (`ClockLock::seed_floor`, `floor_gap_ns`, `VirtualStc::map_sigma`, `clamp`), `ts_restamp` (the stale drop, the gap reason, the stale PCR, `Event::Kind::lead_clamp`), `asrc_servo` (`backlog_ns` 0), `mrts_cli` (knobs `backlog_ns`, `lead_clamp_ns`; summary and expectation keys `leadClamps`, `leadMaxMs`), `fixture_gen --backlog` and `--ahead`; part 4.3, 4.4, 7.2 (six fixtures, one of them the field trace `trace-srt-reconnect-backlog`), 10 and V-P1-3's queuing caller; ADR-0029 Phase 1. Checksums: `ts_stc` d0ec660233eef7cd is unchanged by the core change (every earlier scenario bit-identical) and cf41dd134b4fbac4 with the new cases; `asrc_servo` 432e8439f253974f unchanged. The device runs (V-P1-3 with a queuing caller; the s0 build's `libgstmrtshouse.so` d11cc07a swapped onto .103 and .111): .103, the listener disabled 30 s (twice): the first data at −3.69 and −3.70 s of egress lateness (leads ≤ 3.99 s), one `overlap (backlog)` of 24.6 s, the source lead (−673 ms) 4 s later, never degraded (the build before, same test: −25.9 s, back at 1 s/s over 32 s); a 30 s network loss under the keep-listening listener: one relock (leap, −24.1 s) and a 30.19 s gap (epoch), then the same drop and the source lead 6 s after the reconnect. .111 (Pi 4), the listener disabled 90 s: −3.55 s, then the source lead within 4 s, one overlap (backlog) of 84.8 s, never degraded (before: 96 s ahead, degraded, 86 s of live content dropped at the next relock); the network loss as on .103. The taps: PTS monotonic, about 3.3 s of the backlog at leads up to 3.99 s, then the live content with no hole but the outage's. `trace-srt-reconnect-backlog`, recorded on .111, holds a real drain (85.5 s in 0.59 s); B-46 is what that run showed besides. |
| B-46 | Finding: a floor step under `step_ns` bends the first rate fit (B-45's .111 run) | Measured 2026-10-16, open: about 35 s after an SRT reconnect with a 90 s backlog the receiver's delivery floor stepped +2.85 ms (the SRT receiver's time-base drift correction, by its timing; flat within 0.05 ms before and after it, `trace-srt-reconnect-backlog`). A step under `step_ns` stays in the fit's level, so the least-squares fit over a window that holds it reads a slope: 43–71 ppm on the trace, 186 ppm in the device's own run, taken at once (a fit on more buckets than the ε in force), then decaying with τ (22 ppm at 150 s). Meanwhile the mapping drifts by a few ms (the egress lead rose 13 ms over 140 s on .111) and the card shows that source rate for minutes; the 30 s backlogs on .103 showed no such step (ε 0.3–0.6 ppm). | Not the backlog rules' doing: the floor itself steps, and any start whose transport adjusts its time base inside the first fit window shows it. | For WI-P1-6: a fit that tolerates one level shift inside its window (two segments, or Theil–Sen), or a held shift under `step_ns` taken as a new level for the fit only. Until then the trace's expectation holds today's ceiling (ppm −1…80). |
| B-47 | The second fix round of the Phase 1 review: D1, D2 and its minors | Built 2026-10-17 (engineering choices, for the owner's veto). (1) **`backlog_ns` 500 ms**, as `leap_ns` (was 4 s; 490 ms since B-48, the owner's). A keep-listening reconnect whose backlog passes `leap_ns` relocks and seeds the new epoch on the backlog's oldest sample; under 4 s no rule moved that line, so a 1–3 s backlog left the egress that early for the 1.4 days the 20 ppm slew needs, and one of 3.5–3.9 s put the PES past 4 s: degraded (lead) 6.5 s after the reconnect, then 24–32 s dropped per program and a recovery relock (the review's D2). Now two agreeing buckets more than 500 ms below the line move it, 2–3 s after the reconnect, and the guard drops what left on the seed once (B-37's drop). A backlog under `leap_ns` does not relock, so it never seeds a line (B-48: one within the acquire slew's 10 ms past it could stay, which the owner's 490 ms closes). (2) **The stale rule's second clause takes only a lead the floor explains** (the lead less the floor gap within `lead_max_ns`); a PID further ahead is the source's (B-48: and only past `backlog_ns` above the floor, the window this left). Before, any PES more than 4 s ahead while its line lay more than `step_ns` above the floor was stale: in degraded mode B-8's clamp candidate (the review's probe: the reference lock's floor gap past 20 ms for 68 % and 30 % of the gate traces' other PES), so the clamp came 3–28 s late, with a gap and a drop named `backlog` (D1); in PCR mode that PID's PES went as overlap (backlog) with gap markers before the program degraded. (3) **A written PCR that steps back carries `discontinuity_indicator`**: the move onto a backlog's floor (also B-37's at a start burst) and a straddler's return to an older epoch stepped it back by up to the backlog, unflagged. (4) **`mrasrc` stands in as `audioresample`** in both runners (B-23). (5) V-P1-12 and part 7.4 reworded (B-42). | Measured offline: relock backlogs of 0.6–4.2 s drained in 0.5–3 s (`fixture_gen --backlog 60:T:D`, seeds 7, 31, 33 and 41; 192 replays): never degraded, the egress at its source lead within 5.1 s of the reconnect, no PES more than 4.12 s ahead (before: 48 degraded, 176 not back within 10 s). With `backlog_ns` 1 s, as the review probed, 40 of them stayed early (every backlog under 1 s, and the 1 s ones drained in 2–3 s); the first epoch's falling-pair test given to relocks after a silence instead missed 19 of the 48 drains of 3 s (a relock that keeps its rate locks at 5 s, which ends the test). Every field trace (the committed nine, the raw gate captures 20010, 20033 and 20046, the CBR and RIST loop captures, both OCC captures) replays unchanged down to 450 ms; at 400 ms the bursty encoder's dips move its line, at 300 ms also gate 20010's. The clamp of a 12.6 s PID comes at degraded entry on gate 20010 from 0 s and from 240 s, gate 20046, the OCC trace at nine start times and `syn-lead-clamp-floor-fall` (before: 3, 9.5, 9, 0.1 and 28 s late). Every pre-existing committed and synthetic trace replays to the same stats, event and PES lines; the 243-point sweep over 66 traces keeps the same 36 passing points, and the shipped point passes all 30 expectation files. On .103 (the s0 build's `libgstmrtshouse.so` 2e242d3b; V-P1-3's queuing caller, keep-listening srt-input, udp dropped by nft): network losses of 8, 8.5, 9 and 9.5 s left backlogs of 3.03, 2.59, 4.05 and 4.57 s (the relock's leap); each gave one relock, one gap (epoch) of the outage, one overlap run (3.04 and 2.58 s, then 4.05 and 4.57 s with reason `backlog`), PES leads at most 3.76, 3.29, 3.94 and 3.94 s, the source lead (647–699 ms) 3–5 s after the reconnect, no backward PTS, never degraded. | `ts_stc` (`backlog_ns`, `VirtualStc::stale`), `ts_restamp` (the PCR flag), `native_plugins.cpp`, `gst_native_plugins.py`; `ts_stc_test` (relock backlogs of 3, 0.6 and 0.4 s; the clamp with a floor fall, with its PID rewound 2 s, and in PCR mode; the always-true clause and the dead collector gone), `ts_restamp_test` (`test_backlog_relock` at 2, 3.7 and 0.6 s; the stale run's PCR at arrival − 250 ms, which pins the mutant that froze it; the clamp with a floor fall), `gst_native_plugins_test` (every element of the plugin has a row); fixtures `syn-reconnect-backlog-relock-2s`, `syn-reconnect-backlog-relock-3700ms` and `syn-lead-clamp-floor-fall` (part 7.2); part 4.3, 7.2, 7.4, V-P1-3, V-P1-12; ADR-0029 Phase 1; release notes. Checksum `ts_stc` 387a1e34956af01f (the new cases); `asrc_servo` 432e8439f253974f unchanged. Still open: WI-P1-3's N4 and P3 mutants. |
| B-48 | The third fix round of the Phase 1 review: D1's window and the minors | Built 2026-10-17 (engineering choices, for the owner's veto; item (4) the owner's, 2026-10-21, built 2026-10-22). (1) **The stale rule's second clause only past `backlog_ns` above the floor.** A PES more than `lead_max_ns` ahead whose lead the floor gap explains is stale only while the line lies more than `backlog_ns` (490 ms, item (4)) above its floor, which the floor rule moves at the next agreeing pair, so a stale run never outlasts a move; nearer the floor the gap is jitter or a fall the 20 ppm slew has not caught up with, and a PID past 4 s there is the source's, the lead row's and B-8's clamp's. Before, a gap past `step_ns` (20 ms) sufficed: a PID that read past 4 s only by the line's few to 100 ms above its floor (the review's window, 4.0–4.15 s ahead) went as overlap (backlog) for as long as the line lay that high, in PCR and in degraded mode, and the clamp never came (D1). (2) **What the PCR line maps stale stays out of the lead row**, by either clause, as part 4.3 says (before: only a line past `lead_max_ns` kept it out). (3) **A PID's first PES on another epoch than its previous PES's, kept or dropped, that leaves a hole of a PES or more carries a gap marker** (reason `epoch`). The straddle rule maps a relock backlog's drain tail onto the old epoch, under what the new one already sent, and the PID's return to the new epoch left a hole with no marker (the review's NEW minor); so did a clamped PID's return to the program's mapping at recovery. Under a PES the mapping only wiggled (0.4 ms seen): no marker. Gap events are timed by the PES that shows them, as overlaps are, so a header held across buffers replays alike (`ts_trace_test` pins it). (4) **`backlog_ns` 490 ms: the owner chose 490 ms, 2026-10-21.** The round had kept 500 ms, as `leap_ns`, for the owner (the review's D2 minor proposed 480 or 450 ms): both sides of the constant lie within about 15 ms on today's traces. At 500 ms a relock backlog within the acquire slew's 10 ms past `leap_ns` can keep the line about 0.5 s above the floor for the 7 h of the 20 ppm slew (30 of 160 replays at 500–512 ms, none at 490 or 480 ms); at 485 ms and under, the gate 20010 window case (PID 200 + 3.95 s, clamped) moves its clamp lock onto a dip 485–490 ms under its line 100 s after a stall relocked it, drops 0.47 s and relocks with a 0.33 s gap 10 s later (identical to 500 ms down to 490); the bursty encoder's line moves at 420 ms and not at 430 (the review's RISK: a margin of 70 ms at 500, 60 at 490, 50 at 480). 490 ms clears both on today's traces by 0–5 ms. Should a field trace land in that window, the fallback is the rule only in an epoch a leap opened (4 s elsewhere), which needs the stale rule's second clause scoped alike and kept in the first epoch, so that a stale run never outlasts a move. (5) `mrts_cli`: summary and expectation key `backlogEvents` (gaps and overlaps with reason `backlog`); `fixture_gen --shift PID:MS -i IN.stct`, a recorded trace with PIDs stamped further ahead, whose input `trace_cli_test.sh` finds beside the expectation. (6) Texts: part 4.3 (the second clause, the lead row, up to about twice a short backlog's length of live content lost), 4.4 (the gap on a move between epochs), 7.2, V-P1-3 (the 4 s on the decode key, every hole signalled), B-45 and B-47 pointers; ADR-0029 Phase 1; the release notes; both READMEs. | Measured offline (scratch wf9/p1/fix3; base = the round-2 core). D1, the review's probes: gate 20010, PID 200 + 3.85 / 3.9 / 3.95 s from 0 s: 265 / 733 / 1195 backlog events and 16.1 / 34.5 / 76.5 s of it dropped as overlap (backlog), no clamp → 0 events, 0 s, the clamp 13.3 / 2.8 / 0 s after the degraded entry (B-8's rule: its first PES past 4 s under the mapping); + 3.9 s from 60 s: 31.9 s → 0; gate 20046, PID 200 + 4.1 s: 4.3 s → 0, the clamp 0.03 s after the entry; the synthetic window (`--ahead a2:3500 --delay-ms 100,20@3`, seeds 1, 7, 33): 5.3–9.3 s → 0. From about 4.3 s ahead the clamp came at the entry before too (+4.15 s on 20010: no backlog event before or after). The lead row: relock backlogs of 3–3.9 s drained over 10–30 s with a PID 1.5–2 s further ahead degraded the program (lead), once with a clamp, once 137 s off its source lead after; now never degraded, 15.4–26.2 s dropped (17.9–26.0 s before). Holes: the review's 72-case sweep (T 0.6–6 s, drains 0.5–3 s, seeds 7 and 33): 50 with unsignalled holes of 0.3–2 s → 0; the window cases' clamp exit (3.35 s) and the degraded entry's epoch flips on the gate traces now signalled too. Every pre-existing trace (the committed nine, the raw gate captures 20010, 20033 and 20046, the CBR and RIST loop captures, both OCC captures, .111's raw 90 s drain, every synthetic fixture) replays to the same stats, event and PES lines, but the two relock fixtures, whose PES lines are the same and which gain the hole markers; the 400-case relock sweep: 0 degraded, T up to 490 ms never relocks, from 500 ms on every case at its source lead within 5.1 s (the lead 10–20 s after within 2 ms of before) but 16 at 500 and 502 ms with drains of 1–3 s (the edge of item 4), no PES decoded more than 4 s ahead (PTS up to 4.12 s: video's reorder delay); the 243-point sweep over the 69 traces (the 66 and the three new) keeps the same 36 passing points, and the shipped point passes all 33 expectation files (the derived gate fixtures take their parent's relock range, 0–2). Not changed, found: in `stc` mode a source's own PTS step under the leap row passes unsignalled (the gate's 215–220 ms step on every PID at 421 s of 20010 and 345 s of 20046; fixed mode's jump check is not applied); at a degraded entry on the gate's delivery the straddle tie-break flips PIDs between the frozen PCR epoch and the reference's, about 200 ms apart, for some 4 s (each flip a drop, each return now a marked hole of 20–206 ms: 9 and 14 markers in the two gate window fixtures); a clamped PID leaves at recovery through the frozen reference epoch (two marked jumps). For Phase 2's aligners (R-P1-5) and WI-P1-3; B-20's DISCONT question covers what each marker costs a `tsdemux`. The owner's 490 ms, measured on the merged core (2026-10-22, scratch wf11/b48): every expectation trace (the 34, `trace-vmix-sparse-pcr` and the derived gate fixtures among them), the ten raw field captures and the 36 drift seeds replay to the same stats, event and PES lines as at 500 ms, and `mrts_cli`'s `backlog_ns` knob gives each build the other's lines; the 160 leap-edge replays: 30 not back at the source lead within 5.1 s at 500 ms (T 500–504 ms, 0.5 s early), none at 490 ms, those 30 back within 4.1 s, 1.5–3 s dropped once, 17 more back sooner, none later; the 400-case relock sweep: 16 not back at 500 ms (T 500 and 502 ms), none at 490, never degraded, no PES decoded more than 4 s ahead (PTS up to 4.12 s); the 243-point sweep over the 70 traces (the 69 and `trace-vmix-sparse-pcr`) gives the same summary and expectation result at every point at 490 as at 500 ms (17,010 replays): the same 36 passing points as on 2026-10-17, and the shipped point passes all 34 expectation files. The window case is identical from 487.5 to 500 ms and moves at 487 (one more overlap and gap on PID 200, 0.47 s more dropped; its expectation passes 480–487 ms, so the unit tests below pin that side); the bursty encoder's line is identical from 430 to 500 ms and moves at 425. Found, not changed: `ts_restamp_test`'s generator leaves some relock backlogs of 0.5–1 s (10 of 16 probed, drains 1–3 s, alike at 490 and 500 ms) a hole of one PES with no marker (19.9–24 ms on the audio PIDs: the return rule takes more than two PES intervals, re-review 3's one-PES holes) or a third return marker on one PID, so that harness takes no case at the leap edge; a 505 ms queue there does not even relock (the drain compresses the PCR spacing, so the miss stays under `leap_ns`). | `ts_stc` (`VirtualStc::stale`, `map_sigma`'s lead row), `ts_restamp` (`Pid::prev_epoch`, the gap on a move, `push_gap`'s time), `mrts_cli` (`backlogEvents`), `fixture_gen --shift`, `trace_cli_test.sh`; tests: `ts_stc_test` (the window in PCR mode and with the lead row; a slow drain; a 6 s backlog under a clamped PID, and in PCR mode under a PID 13.4 s ahead; a first pair with one bucket past `step_ns`; a 490 ms burst after a relock), `ts_restamp_test` (the unsignalled-hole check in `analyze()`, every hole signalled in `test_backlog` and `test_backlog_relock`, each relock gap a PES or more, the window with a clamp exit at recovery); fixtures `syn-lead-window`, `trace-gate01-rist-20010-ahead-3900ms` and `-3950ms` (new), `syn-reconnect-backlog-relock-2s` and `-3700ms` (the hole markers), `backlogEvents` 0 on seven more. Mutants caught: each change of this round reverted (the clause at `step_ns`, the lead row by the floor gap, no return gap, a newer epoch only, any size, the buffer's time, `backlogEvents` uncounted, `--shift` a no-op), the review's survivors (the clamp lock's stale check off, the first clause off, `seed_floor` on lo, `backlog_ns` 450 ms), and the earlier rounds' (B7, C5, `backlog_ns` 4 s and 1 s, the clause without the floor test, no second clause, the PCR step back unflagged). Checksum `ts_stc` 4a4422e9974cb1ea (the new cases; the round-2 tests against this core keep 387a1e34956af01f); `asrc_servo` 432e8439f253974f unchanged. The owner's 490 ms: `ts_stc.h` (`ClockLockConfig::backlog_ns`); `ts_stc_test` (a 495 ms burst after a relock moves at its second close while the 490 ms one stays, its buckets 489.4 and 490 ms under the slewed line; a 505 ms relock backlog drained in 2 s moves, which 500 ms left 0.5 s early), so the cases pin 489.4–494.4 ms (mutants: 500 ms caught twice, 485 ms once; 494 ms passes); `ts_restamp_test` (a comment); the notes of `syn-reconnect-backlog-relock` and `-2s`; part 4.3's offset row; B-45's and B-47's pointers; ADR-0029 Phase 1 and its open items. Checksum `ts_stc` 34d1bc5cd406b9a6 (the two new cases; without them 4a4422e9974cb1ea, every scenario bit-identical at 490 ms); `asrc_servo` 432e8439f253974f unchanged. Still open: WI-P1-3's N4 and P3 mutants. |
| B-49 | The Phase 2 build plan (chapter 6) | Orchestrator, 2026-10-16: WI-P2-0 added (the worktree had no `node_modules`, dists, native build or hls-pipe checkout; its baseline is what later items diffed against); the items ran in nine waves of at most two with disjoint files, in one worktree. Chapter 6's line numbers are against submodule `fc17468` and have moved (`stamp_house` was at `ts_timeline.cpp:841`, not :902), so the briefs named symbols. | The build runs every item of a wave in parallel. | Chapter 6's line numbers are historical. |
| B-50 | WI-P2-1: the aggregator behaviours on 1.28.2 (R-P2-1) | Measured, 2026-10-16: assertion 1 passes. With every input answering LATENCY non-live, `audiomixer`, `audiointerleave` and `mpegtsmux` at `latency=0` wait for an input 3 s late and lose nothing, so WI-P2-6 is the non-live model and the live fallback is not built. Found: a GAP is consumed at its start (a [300, 700) ms gap moves the audio aggregators to 310 ms and mpegtsmux to 300 ms until the pad's next item) and a zero-length GAP at its end carries all three through (F2); the audio aggregators drop or clip stale data only after DISCONT, a segment or a jump past discont-wait (1 s), otherwise they place it by sample count (F3); one input answering live turns the aggregator live (F4); `mpegtsmux` writes only while every pad holds an item (F5) and writes a late cue at its own PTS (F6). `mpegtsmux` has no `force-live` property (plan bug). | Part 4.3 relied on all of it without a test. | Built into WI-P2-6: the GAP fence, DISCONT after a discard, a gap or a rejoin, every input through `mralignwatch`, the sparse gap fill. Part 4.3's "it emits a stretch as soon as every pad has data or a gap for it" holds while the gap is queued; WI-P2-1's "clipped by the aggregator" holds with DISCONT or past discont-wait; part 4.6's and WI-P2-1's `force-live=false` is `latency=0` alone on `mpegtsmux`. The aggregators' QoS `dropped` counts over-report in a resync cascade, so the watchdog counts its own discards. |
| B-51 | WI-P2-2: `IdentityStamp` per stream; the deletion after its users | Plan bugs (2026-10-16): deleting the anchored stamper before `mrtsstamp`, `mr-tssplit` and `mr-bus-fanout` moved off it would break `make native` for parallel items, so WI-P2-2 is 2a (the class and its vectors, wave 1) and 2b (the deletion, wave 5). The class keeps the timing PID, the first record and the floor per stream, and `first()` takes the stream: the draft API had no per-stream state, and `mr-tssplit` stamps every output through one instance with stream = PID. As built (2a): `first()` reports the stamp before the floor (the old anchor event's value); the floor starts at 0. The acceptance grep (plan bug) is scoped to C++ and TS files plus "no runtime Python import": `py/ts_timeline*.py` keep the classes as reference (OQ-1), and `gst_tsdemux_slave_test.py` builds its fixture with them. | One timing PID per instance would stamp a splitter's KLV output at arrival (WI-P2-4 acceptance 3). The vectors and the corpus (300 scenarios, 38,708 buffers, checksum `0x047423b83c74b0a7`) were recorded from the old house-timeline mode, and the Python reference gives the same stamps. | WI-P2-2's `first(int*, …)` reads `first(int stream, int*, …)`. As built (2b): `ts_timeline` keeps `timing_pes` only (30 lines; +107/−3,184 with tests, plan −2,900), and every binary that linked it is about 70 KB smaller. `IdentityStamp` calls `timing_pes`, so WI-P3-17 moves the rule into `ts_house` and its acceptance grep allows it. |
| B-52 | WI-P2-3: identity-only egress as built | As built, 2026-10-17: `MRTSSTAMP_VERSION` 3.0.0 (properties `active`, `copy-count`, `bytes-total`, `coalesce`, `coalesced-lists`; messages `mrtsstamp-identity`, `-segment-warning`, `-map-failed`); one log line per arm, the same words in both runners; no Python probe, so a missing `libgstmrtsstamp.so` is the `warning` of kind `timing_plugin` with the rule-6 sentence in both runners (plan bug: the native runner only logged, the Python one fell back) and `started.timingPlugin` is null so the alarm stands; the plugin is loaded only for a pipeline with a `busout_*` tee; both loaders' `alarm()` is public; `houseTimelineEgress` removed from eleven modules (plan bug: chapter 6 named four; Phase 1 added the seven ingests and captures); `MR_LATCH_REPAIR` gone; the playout warning's "house-timeline unwrap" reads "identity unwrap"; subtitle-core's three suites on a local identity helper equal to the reference, `subtitle_stamp_dump.py` retired, `stamp_model_vectors.txt` frozen, the engine test's −600 s jump dropped. | A consumer-only module would show an untrue alarm, and the engine clears the rule-6 alarm on a `started` that names the plugin. On an identity bus content only moves forward. | WI-P2-3's "the runner loads it" reads "for a pipeline with a bus egress". +1,315/−4,129 lines (the plan's +200/−5,800 counted `ts_timeline`, which is B-51's). ADR-0029 Phase 2. |
| B-53 | Findings at the identity egress (WI-P2-3) | Open, 2026-10-17, for the owner: (F1) an egress armed mid-stream whose first buffer carries no timing PES (a 302M or Opus PES, stream_id 0xBD, before the first PCR, or a buffer with no PES) is stamped at arrival, and the floor holds the following buffers until their content passes that arrival: +100.2, +78.9, +57.6 and +36.2 ms on the first four at 100 ms of content lag. With identity the only mode every 302M and Opus egress meets it at each arm, a mixer's by its pace, and a buffer of private PES alone mid-stream (a cue at a muxer's egress) lifts the floor the same way, for at most the egress's content lag (WI-P2-2a's note). (F2) Neither loader checks `mrtsstamp`'s version: a stale 2.x copy loads with `repair-latch=TRUE` and `house-timeline=FALSE` and stamps anchored, with no alarm. | F1 is `IdentityStamp`'s rule as WI-P2-2a pinned it (the old house mode did the same). F2: runner and plugin ship together. | Options: F1, learn the PCR PID from the PMT, or let a stream whose timing PID is unknown take its first private PES as timing (either moves WI-P2-2a's vectors); F2, refuse a major version below 3 with the rule-6 alarm. Protocol case B2's wire check starts at the first PCR-carrying buffer. |
| B-54 | WI-P2-4: gap markers through the splitter; the OCC fixture | Plan bug (2026-10-16): WI-P2-4 left out the marker forwarding that ADR-0029 deferred to Phase 2 (R-P1-5), and libmrbus dropped buffer flags on ingest. As built: additive overloads (`BusClient` with `OnBufferEx(data, len, pts_ns, flags)`, `FanoutServer::broadcast(…, flags)`, `BUFFER_FLAG_GAP`); a GAP-flagged input buffer bypasses `SplitterCore`; each packet `read_gap_length` reads as a marker on an output's PID flushes that output's pending data, then leaves alone with the input buffer's PTS and flags, unstamped and counted in its lateness window; other packets of a GAP buffer are not forwarded. The OCC recording's first 2 MB is the fixture `cap-occ-1080i-h264-mp2-ttx.ts` (with 22 AAC PIDs, despite the name) and its `.expect.jsonl` (plan bug: none of the named captures existed). (Note, 2026-10-22: renamed `cap-occ-1080i-h264-21aac-ttx.ts` for what it holds, 21 AAC PIDs; B-85.) | A marker merged into a data batch would hand its flags to the data (B-10). | WI-P2-4's acceptance 3 holds by `IdentityStamp`'s rule: a B-frame-first video buffer is held at the floor (9 of 76), and a private output is stamped at arrival until discovery injects a PCR (about 0.23 s of this capture). `cap-srt-ingest-1316.ts` and `cap-836-program-step.ts` go to WI-P2-16. Pre-existing: `SplitOutput::last_cc` starts at 0, so a PCR injected into an output's first batch shows one CC discontinuity. |
| B-55 | WI-P2-5 and OQ-18: hls-player's rebase in the fan-out | Orchestrator, 2026-10-16 (plan bug; for the owner's veto): hls-pipe passes the origin's PTS through, so identity alone would put origin time on the bus, and chapter 6's place for the fix, hls-pipe's TS writer, would be a second TS-timing writer in TypeScript in another repository. The rebase is native, in `mr-bus-fanout` (`mrfanout::HouseRebase` on mrts primitives): the first timing PES lands at house now, one mapping moves every PES and PCR, and only the reference PID (PCR PID > video > audio; one silent 2 s gives way) re-anchors, on a jump past 1 s against one spacing. As built (D3, D5, D12, after the fix round): a jumped PES lands at `max(last on the bus + one spacing, house now)`; a PID that did not jump with the reference keeps its own mapping (`kept`), one that jumped takes the re-anchoring reference's; DI on the PCR PID's first PCR on a new mapping; before the anchor only what carries no time passes; garbage is no longer forwarded. | hls-pipe's inline audio continues across EXT-X-DISCONTINUITY while its video jumps, and hls-player always muxes inline AV. A landing that only continued would leave the output late by every pause, for good (R-P2-5). | OQ-18's "the hls-player's TS writer stamps PES at house time" reads "`mr-bus-fanout` rebases its TS"; `packages/hls-pipe` is unchanged. About +1,200/−1,000 lines (plan +40/−800). Known edges and an hls-pipe issue worth filing (its inline-audio anchor resets only in `seek()`) in ADR-0029 Phase 2. |
| B-56 | WI-P2-6: `mralignwatch` as built | As built, 2026-10-16 (for the owner's veto): lateness, release, horizon and the stale test read DTS, else PTS; an upstream GAP is metered at its end; no start hold (a non-live aggregator takes the earliest first buffer of its pads); DISCONT on the first data after a discard, a gap or a rejoin (F3); silence excludes time held in a push or in the sink thread; an input that never delivers is absent at the 2 s ceiling, its gaps under primed caps (`channel-mask` 0 above two channels, after the fix round); full counts once per episode, until drained to half of every limit; pace floor 0; items pass at once when not PLAYING. B-17: a `bus_input_add` that fails to parse and names an element of a plugin the loader could not use is a `command_error` carrying the rule-6 alarm, nothing stood in. Both runners forward the `mrlateness`, `mralignwatch` and `mrtsdemux` messages unsubscribed. | Part 4.3 as WI-P2-1 found it (B-50). | Part 4.3 job 2's "λ = now − running_time(PTS) (data or gap)" reads "of the decode time, a gap at its end". The engine answers a failed live add with a module restart, whose start description gets the `identity` stand-in and the alarm. ADR-0029 Phase 2 has the properties and constants. |
| B-57 | The pace estimator (WI-P2-8+11 fix round) | Engineer's choice, 2026-10-17 (for the owner's veto): a member's lateness is the median over wall time of its last second, each stretch between two arrivals at its midpoint, stretches over which it fell left out; it counts toward the pace once the stretches span 0.5 s, a third of the window counts and it is not falling (`FALL_NS` 2 ms); stale data and gaps already passed do not feed it; a run starts afresh after waiting, an absence, a held EOS, a flush, a new stream and PLAYING → PAUSED; the 1 s report is checked on every pass of the task. It replaces WI-P2-6's mean of a second's arrivals. | An upstream aligner's start backlog (199 buffers in 59 ms) latched every pace downstream at 802–866 ms, and a downstream audio-output-302m stayed silent. After: 50–52 ms with a dark input, 32–33 ms late, 34–42 ms live, every tick heard. | Part 4.3's "mean over the last second" reads as this. The verify found the third-share rule has little margin on real 302M arrivals (median share 0.39, minimum 0.33) and the median costs a sort per arrival under the registry lock (2 µs at 10 ms buffers, 28 µs at 1 ms): re-derive the threshold from captures, a Pi 4 among them, and consider an incremental median. |
| B-58 | A live join; n1's matrix floor; a start-time remove (WI-P2-9 fix round) | Engineer's choices, 2026-10-17 (for the owner's veto): a pace group runs once a member has pushed something timed; a member that joins a running group (a live add, a relink, a replace) is gapped at now − pace from its first tick while it waits, absent at W as before, its content before the gaps' horizon stale; start-time members are waited for up to W as before. n1-mixer-302m's matrix links take `silence-floor` 500 ms. Found and fixed in both runners: a live remove of a start-time branch released no request pad (its ghost pad is `ghost<N>`, not `src`), and the non-live mixer then waited on that pad for ever. | A fresh joiner was waited for up to the 2 s ceiling, stopping a running mixer, and n1's matrix links (W 100 ms) then dropped what `inmix<i>` released. | Part 4.3's table gains "a live add joins at the current position": a joiner later than the pace by Δ loses its first Δ (a seed saves it), and an on-time one can lose its first buffer (B-59). The floor turns a single-source relink into a 0.5 s stop at every aligned consumer downstream (the verify: 47 blocks of another input lost at a downstream fan-in, 0–9 without the floor), while without it a late joiner costs more inside n1: the owner chooses. |
| B-59 | Gaps toward an audio aggregator follow the data (WI-P2-14 fix round) | Engineer's choice, 2026-10-18 (for the owner's veto): toward a `GstAudioAggregator`, found downstream through ghost pads once linked, an absent, held-EOS or joining input is gapped one input buffer length at a time, each piece at its start + pace, with no zero-length fence; a forwarded GAP goes in pieces of at most the aggregator's output block, or past 1 s as one GAP and a fence. `mpegtsmux` and sparse inputs keep the tick and fence. The element posts its messages before it sleeps. | With the tick and fence the mix ran 21 ms later while an input was absent, and part 7.4's ±5 ms failed in both runners; now 22.8 → 22.8 ms. Since B-79 data and pieces may leave up to 1 ms before the pace (the release slack), so the two match to 1 ms or less rather than the 0.1 ms measured here. | Part 4.3 job 4, WI-P2-6's How and its acceptance 2 ("a GAP to now − pace every tick") read as this toward audio aggregators. Cost: an input that rejoins or joins can lose one buffer more (case L's on-time joiner now loses its first). The piece was the last buffer's length, at least 1 ms, so a short last buffer could mean up to 1,000 GAP events a second; since B-79 the aggregator's output block is its floor (100 a second after 1 ms buffers, element case 16). Open: the audio shape needs the aggregator linked directly. |
| B-60 | WI-P2-7: `mrtsdemux` and the gap markers | Plan bug (2026-10-16): WI-P2-7 did not say what the demux does with OQ-12 markers, and untranslated the watchdog would declare false absences in every ingest outage. As built: each marker packet on the selected PID is a GAP event `[end − length, end)`, `end` its buffer's PTS through upstream's segment, trimmed to the pad's horizon and dropped when empty (so B-21's two false markers vanish), with DISCONT on the next buffer; markers on other PIDs, the PCR PID's included, are ignored (every producer marks each ES PID). A PES's end comes from its AES3 header; the jump rule measures from the horizon; the no-stream warning is the forwarded `mrtsdemux` structure with `reason=no-stream`. The loader rows were already there, and the const `PacketWalker::feed` is built now (B-15). | `mrtsdemux-no-stream` would not be forwarded by either runner. | Chapter 6's `mrtsdemux-no-stream` (WI-P2-7, parts 7.2 and 10) and chapter 7 part 3.5 read `mrtsdemux` with `reason=no-stream`; no engine code reads it yet (B-70). About 975 production and 1,490 test lines (plan +450/+350). |
| B-61 | WI-P2-8 to WI-P2-11: the order of the API removal | Plan bug (2026-10-16): removing `latencyMs`, `ignorePcr` and `pacedMixer` in one step would break four modules' typecheck until their items landed. WI-P2-8 took WI-P2-11 and the minimal call-site edits, and `pacedMixer` stayed until WI-P2-9 removed its last caller (n1's output mixers). As built: `MixInputBranchOpts.branchQueueMs` removed and `mixerName` added; `<m>_caps` is `<m>_out`; the branch caps stay `rate,channels`, no format pinned; audio-output-302m and audio-processing return `eosDrain: false` (the fix round). | With `hold-on-eos` every mixer-arm stop waited out the 6 s drain (0.01–0.03 s before). | n1-mixer-302m was not shippable between WI-P2-8 and WI-P2-9 (force-live output mixers behind non-live fan-ins); both are in the release. `PluginModule.ts`'s `eosDrain` comment still blames a force-live aggregator. |
| B-62 | WI-P2-11: audio-output-302m's sink | As built, 2026-10-17 (for the owner's veto): `identity name=live_upstream sync=true` after the continuation in both arms, so the sink sees a live upstream and adds its ring, which `audio302mTsOffsetNs` = `max(0, D + trim − 100 ms)` cancels; not ADR-0008's pacer (nothing free-runs) and it never waits. | Behind the non-live aligned mixer the sink added no latency of its own: the mixer arm played 90 ms early at D = 300 and nothing at D = 60. | The mixer arm presents about 10 ms after the single-source arm (the mixer's output block, forwarded as latency), as it did before, so V7 is unaffected. An arm-aware offset was tried and not taken: it leaves the arms apart by the device's declared ring less 100 ms (+9.8 ms measured on the dev box; −1.3 ms by .103's DAC's declared ring). |
| B-63 | WI-P2-10: the ducker as built | As built, 2026-10-17 (for the owner's veto): 15 ms windows of content time from the stream's first frame, dt = the window; the reading at a window's end sets a geometric ramp across the next (causal, no lookahead), so the duck starts 0–15 ms after the key's content time; the key level is the louder channel's mean square, silence −120 dB; `mrducker` messages at 10 Hz of content (`running-time`, `gain-db`, `key-db`, `phase`) through `busReports`. `DUCK_DEFAULTS` moved into `chainSetup.ts`, and the element test is the plugin's own `test:py` (plan bug: the plan said keep it there, and the wave shared `packages/engine/package.json`). No stand-in: without `libgstmrducker.so` a module naming `mrducker` or `mrptskeep` is refused with "Native plugin not loaded: this module needs it and cannot run until the deploy is fixed.", kind `native_plugin` (the fix round; the row is not required and raises no load alarm). The interleave's inputs are fixed F32 mono 48 kHz before each `mralignwatch`, with `silence-floor` 500 ms on a pin a mixer feeds. | A 4 → 2 gain has no stock stand-in. | OQ-22: the limiter's lookahead is the timing section's "Processing latency" row (`ModuleTimingSummary.processingLatencyMs`), not corrected; in ducker mode the programme's reported latency also makes the duck land that much early on it, inside ±15 ms at the defaults. A single programme source that ends no longer ends the module: the interleave runs on until every input has ended. |
| B-64 | The keyed gate's timestamps (WI-P2-10 fix round) | Found, 2026-10-17, pre-existing since 2026-08-25, and fixed: `sc-gate-stereo` (LADSPA, 4 → 2, not in place) allocates its output without metadata, so the keyed gate's output and its egress PES had no PTS at all. `mrptskeep target=dyn` after the gate puts each call's input PTS, DTS, duration, offsets and flags (GAP cleared) on the buffer the gate made for it; frames in ≠ frames out, a record from another thread or none is an element error. | The builder's option (a) keeps the operator's gate as it sounds. | Keyed-gate mode now needs `libgstmrducker.so` too (the brief said unaffected). After the fix: 250 of 250 PES with a PTS, the first at the first buffer's + 1 h, the gate open at the key's content time plus the limiter's 5 ms lookahead in both runs. |
| B-65 | WI-P2-12: the cue pads and the routes | Plan bug (2026-10-16): admitting `private_` and `subpicture_` to the retime in both runners would also retime the transcoder's and audio-transcoder's subtitle pads. As built: `AlignBranchesToStampsConfig.privatePads`, a `transformProducer` modifier that only the muxer sets, honoured by both twins. Each route is `mralignwatch name=aw_<tag> aligner=mux input=<tag> max-size-bytes=40000000[ sparse=true][ seed-lateness=…]` and then any `taginject`; no `hold-on-eos` (an input's EOS reaches the mux); `MuxRoute.sparse` deleted; the hooks keep no timing code. | — | Part 4.6's "the runner's retime admits `private_` and `subpicture_` pads (both runners)" reads "under `privatePads`, which the muxer sets". |
| B-66 | B-17 for the muxer | Orchestrator, 2026-10-16 (plan bug; for the owner's veto): the muxer's `mralignwatch` sits in hook-built branch strings, which the rule-6 rewrite of the start description does not reach, so a muxer on a box without `libgstmrtshouse.so` fails to start (every route's branch fails to parse, and `restartOnError` loops) with the alarm shown, instead of starting with a warning. | Release images carry the plugin, and the 302M mixers cannot run without it anyway (`mrtsdemux` has no stand-in). | C-1's start-but-warn does not hold for the muxer; fixing it needs the hooks to call the rewrite. |
| B-67 | The retime's quiet cue and dark input (WI-P2-12 fix rounds) | Engineer's choices, 2026-10-17 (for the owner's veto), both twins: a PES that is not `timing_pes` and comes more than 5 s after its PID's last is a pause, not a cut; it rejoins the newest epoch, from its own, with a timing PID within 5 s, at that epoch's K. With no timing PID near and no coherent later epoch it opens a fresh epoch on the old epoch's K, not on a cadence prediction (K is −1 h under identity). The hook's prog-map and PCR edits run under the hook lock. | A cue PID quiet over 5 s broke continuity with its own last PES: every later cue kept the error (−8 s, then −16 s), and the sparse aligner raised the mux pace for good (240 → 7,490 ms); a dark input back with a cue alone raised it to 6,530 ms. The unlocked edits raced mpegtsmux's map and aborted up to 18 of 100 eight-input starts. | The rules reach every `transformProducer` retime, AC-3 and Opus on 0xBD included; a forward jump of 5 s to 5 s + L led by such a PES stays on the old K until the next discontinuity. Residual R1: mpegtsmux reads `prog-map` under its own lock when it creates a pad's stream, so an edit after data reached the mux can still race; listing every spill PID up front would close it. |
| B-68 | Finding: the bus ingress queue drops the first buffer back after a silence | Open, 2026-10-17, for the owner: `buildBusSrc`'s `queue leaky=2 max-size-time=5 s` reads a silence of more than 5 s as its level until its thread takes the first buffer back, so a second buffer that arrives first finds it full and the first is dropped (30 of 30 runs in the probe). | The muxer's stall watch used to restart the pipeline instead; Phase 2 makes the case reachable on every rejoin whose producer resumes in a burst. | Recommended: bound the ingress by bytes only (`max-size-time=0`, the 40 MB cap kept; ADR-0015 and OQ-30 amended), then protocol case M4 sends its split back to back. |
| B-69 | Findings at the muxer's `tsdemux` (WI-P2-12) | Measured, 2026-10-17: (F1) one 90 kHz tick is lost through any tsdemux → mpegtsmux hop, since both conversions floor and a PTS with t mod 9 ≠ 0 comes out t − 1; the retime inherits it. (F2) tsdemux's own time for a cue is its PCR estimate, ±20 ms in the fixture, and none on untimed bytes. | — | `scn-mux-klv`'s 0 ticks holds on the 10 ms grid (WI-P2-14); a demux-side round-up is for Phase 3's `mrtsdemux`. Under `privatePads` a cue takes its own PES. |
| B-70 | WI-P2-13: the aligner display as built | As built, 2026-10-18 (for the owner's veto): `ModuleTimingInput.lateness` is optional, so a dark input keeps its row; Waiting for names every absent input, else the slowest present member of the aligner that adds the most; Pace is the largest added latency of any one aligner; a seed reads the producer's own output when it lists one per bus port; the rejoin and late-cue events are log lines; a watch labelled with a bus connection id joins that edge's tap row, and `GstPluginBase.alignerInputOf` is the hook for other labels. Not built: the muxer's route watches, n1's matrix links and audio-processing's interleave carry internal labels and show as rows of their own (`Input demux_1_video silent …`, one dark muxer input named once per route); part 10's "No matching stream" and "Demux gaps, CC loss" rows. | Chained aligners are later than the stages that feed them by construction, so a module-wide slowest would always name the last stage. | Follow-up before V3 and V5: an `alignerInputOf` of about 8 lines in each of the three modules (the hook's types are not exported from the engine's index yet), and an engine reader for `mrtsdemux:<name>`. |
| B-71 | Finding: a seed latches a transient (WI-P2-13) | Open, 2026-10-18, for the owner (R-P2-5): a seed is the producer's mean output lateness over its last 2 s window and a floor of the consumer's pace for its life, so a consumer built during a producer's transient keeps it; a first consumer on an unconsumed output of a multi-output producer is seeded with the other outputs' mean. | Built as briefed. | Safer readings: the window's minimum, a seed only after two windows, no seed for a port with no window of its own. |
| B-72 | WI-P2-14: conformance on streams the harness builds | Plan bug (2026-10-16): none of part 7.4's captures exist (S0-9's and P1-5's capture session is pending, and `fixture_gen` writes arrival traces, not TS), so every scenario runs on streams the harness builds (302M through `avenc_s302m ! mpegtsmux`, each input's content keyed to its sample index on the 10 ms grid; `cue_egress`; GStreamer-made H.264, AAC and Opus; the OCC trim), and the `--silence`, `--delay` and `--burst` knobs are the harness feeder's. As built: the runner commands are a vitest file snapshot of the real modules' builders (`fixtures/aligner/pipelines.json`); the module starts 0.7 s before its producers' data; `scn-align-wrap` runs in a time namespace (`unshare -T`); lengths cut for CI (16–60 s; plan 90 s and 10 min). | — | All eight scenarios and every protocol case pass in both runners (157 conformance checks); case P with the KLV input failed 0 of 200 legs (3 of 200 at the W0 baseline). The capture-based runs go to WI-P2-16, recorded on .103, .111, .22 or .50 (.108 is in production). |
| B-73 | Finding: a module that starts long before its data starts on gaps (WI-P2-14) | Open, 2026-10-18, for the owner, before V1: a module PLAYING more than W (2 s at start) before its inputs' first data goes absent and starts its aggregator at a gap's running time, off the producers' PES grid. The ducker's egress PES PTS then miss its input's (0 of 2,250 matched), lags of ±1 sample appear, and a start-time input that first delivers more than 2 s late joins late and loses its start (1 s). | — | V1's "ducker egress PES PTS = input PES PTS" holds only if the module starts on its programme's data. A PES PTS maps to the sample `ceil(ticks × 48000 / 90000)` (F3, for `pcm_align.py`). |
| B-74 | Finding: a pace rise loses content downstream (WI-P2-9) | Open, 2026-10-17, owner-level: when a slower input joins, the aligned mixer's output stops once for the rise Δ, and an aligner downstream whose W is shorter than Δ reads that as silence, goes absent, discards Δ as stale on return and raises its own pace by Δ. Measured: a joiner 300 ms late on audio-mixer stops the mix for 287–293 ms, and a downstream 302M fan-in then loses 27–28 blocks of both kept tones. | — | Options: (a) raise the pace by a slew, so the output never stops for longer than a tick (recommended, a WI-P2-6 follow-up; the slow input's first content is the cost); (b) a larger floor on fan-ins fed by aligned producers; (c) accept it and document it with R-P2-5. |
| B-75 | Finding: the aligners' CPU (WI-P2-9, WI-P2-10); fixed by B-79 | Measured, 2026-10-17, on the Pi 5: an `mralignwatch` costs 5.2–5.8 ms of CPU per second (a queue in its place about 2.0), per element whatever its group size; n1-mixer-302m at 4 pairs 0.17–0.18 cores (0.14–0.15 before), at 16 pairs 2.2–2.6 (1.1–1.3). Fixed 2026-10-22 by B-79: on the same Pi an aligner at 240 costs 1.94 ms/s (a queue 1.39), and n1-mixer-302m at 16 pairs 1.68 cores by the same probe (with queue links 1.46). | One clock wait per buffer, a wake per arrival and a registry read per pass. | V9's "Phase 1 + 10 %" is at risk for n1-mixer-302m and for audio-processing's four interleave aligners. Options: release without a timed wait when the release time is under 1 ms away or past, and skip ticks while data flows. B-79 built both and more; V9 is judged on .103 and .108 at the device round. |
| B-76 | R-P2-5 and the operator-visible changes | Recorded, 2026-10-16: the pace never falls by itself (§6 item 4, decided): once a slower input's lateness raised it, a module's added latency stays until that input is removed or the module restarts, and Pace and Waiting for show it. The orchestrator put the operator-visible items (the removed settings, the muxer that continues and warns on a dark input, the pace that never falls) to the owner with a recommendation, an automatic fall-back once the slow input has been steady for minutes, taken as one skip; not answered when Phase 2 was built. | — | The release note says so; the fall-back is not built. |
| B-77 | The gate's interim workarounds (WI-P2-9) | Recorded, 2026-10-17: the OCC gate's mixers ran `mixLatencyMs` 300 and a hot-patched `alignment-threshold=500000000` against holes from timestamps that wandered against their sample count. Phase 2 replaces both: no budget, the pace, and content time from the ingest restamp and the formula demux; the threshold stays at its default (R-P2-7). | — | Do not run `mhfix-deploy.sh --revert` after the release is installed: its backup is the v2.0.0.96 helper and would overwrite the new one. An input whose own PTS jitter by more than 40 ms against its sample count still resyncs (a translation station on the old captures: −50…+70 ms) until it runs Phase 1's captures. |
| B-78 | The documentation pass (WI-P2-15) | As built, 2026-10-18: ADR-0029 Phase 2; ADR-0005 decisions 2 and 4 (with their notes) and ADR-0018 marked superseded, ADR-0008 in part (OQ-21); a few lines each in ADR-0001, 0002, 0015, 0016, 0017, 0019 and 0022 where they described a deleted mechanism as current; the plugin READMEs; the release note's Phase 2 items. | An ADR a change diverges from is marked, not left to mislead (`docs/adr/README.md`). | Code comments that still name a deleted mechanism are left for a code change, listed in ADR-0029 Phase 2 ("Open at the end of the build"). |
| B-79 | The aligner element's CPU (the aligner round's sub-WI A1; fixes B-75) | As built, 2026-10-22 (engineering choices, for the owner's veto; the 1 ms slack is the owner's number, flag F6 of the round's design): `mralignwatch`'s src task runs once a wake. It releases every item due within `RELEASE_SLACK_NS` (1 ms) of its running time + pace, pushes the gap pieces due, posts, and sleeps to the earliest of the head's release, the next gap piece toward an audio aggregator, the W deadline while silence counts (from the last arrival, less the time held), the tick only while gapped toward `mpegtsmux` or sparse, and the next 1 s report. A mix can so leave up to 1 ms before the pace (B-59's 0.1 ms becomes 1 ms or less), and an input goes absent at W, no longer at the next 20 ms tick. Two additions to the design: an input held behind the pace (its last buffer came more than the slack before its release) arms the release of the buffer that continues it, horizon + pace − slack, and an arrival due no earlier than the armed wake does not wake the task, so a held input's task runs once a buffer too; and W is taken only once a silence reaches its least, min(floor, ceiling), or for a message or a property read, not at every arrival. As designed: the clock, the base time and one `GstClockID` per run (read at PAUSED → PLAYING and in an overridden `set_clock`, the id re-armed by `gst_clock_single_shot_id_reinit`); the pace read lock-free from a seqlock `PaceGroup::Snapshot` through the membership's group pointer, the registry's lock left to `observe`, `raise`, `start`, `leave` and the messages' view; a gap piece toward an audio aggregator at least its output block (B-59's open item); a read-only counter `passes`, the task's runs, in every message. GLib condition variables are signalled only while something waits on them. | B-75. On the dev Pi 5 (a Pi 5 like .103), medians of three, before = HEAD c4f9666b: an aligner at 240 costs 1.94 ms/s (before 4.17; a queue in its place 1.39) and at 60 1.35 (2.99; 0.78), with 30.2k context switches a second at 240 (82.5k; the queues' 27.7k); n1-mixer-302m takes 1.75 cores at 16 pairs (2.98; with queue links 1.49), 0.50 at 8 (0.54; 0.42) and 0.166 at 4 (0.189; 0.153), and with WI-P2-9's probe, which B-75's and the round's figures came from, 1.68 at 16 pairs (2.35; 1.46). The design's own set left n1's 240 matrix links at 2.3 task runs a buffer (2.1–2.7 cores at 16 pairs): held 1.5–7 ms behind their pace, less than a buffer, their queues emptied, and every arrival woke the task only to re-arm its timer before the release woke it again; armed releases bring them to 1.2. A p95 over 200 gaps at every arrival cost the 16 tee threads that run the matrix chains about a tenth of a core. Tried and left out: a per-group registry lock (contention down, CPU the same) and a condition-variable wait in place of the `GstClockID` (within the noise). | B-75 is fixed, a little short of the round's n1 targets on this Pi (16 pairs ≤ 1.65 cores, 4 pairs ≤ 0.16): the rest is the pace estimator's median at every arrival (B-57's incremental median, about a tenth of a core at 16 pairs) and the matrix tasks' timed waits. The device runs on .103 and .108 (V9) are the gate, at the device round. A task meets a lower pace at its next wake, within a buffer while data flows. Tests: `align_watch_test` (the snapshot under four readers and a writer of 10,000 raises and a start; the group pointer after leave), element cases (2), (2b)–(2d) and (11b) absent within W + 2 ms, (3) absent at W with nothing queued under a 1 s tick, (15) one task run a buffer for an on-time and a held input under a 2 ms tick, (16) 10 ms pieces after 1 ms buffers. WI-P2-9's `n1_cpu.py` read the runner's stderr only until PLAYING: with 256 aligners the pipe fills, the runner's main loop blocks in write(2), emits nothing more and never takes the stop; the round's probe sends it to a file, so the runner keeps emitting and reads higher. WI-P2-6's acceptance 2 ("absent within W + tick") and ADR-0029's "within 0.1 ms (B-59)" follow in the round's document pass. |
| B-84 | The PCR's `discontinuity_indicator` only where its timeline breaks (the vMix recording, F1 and F2) | Found 2026-10-21 on the owner's vMix recording (B-85), fixed 2026-10-22 (engineering choice, for the owner's veto). **Cause:** `RestampCore::on_pcr` flagged a written PCR that followed a shift change or a PES gap of 1 s or more (`flag_pcr`), changed between mapped and regenerated, stepped back, or stepped forward by `GAP_FLAG_NS` (1 s) or more, the last meant for the jump after an outage; on a source whose PCR comes only every 2 s (vMix's VBR mux, one PCR per IDR) that fired on every PCR: 427 of the 433 the trace's replay writes, 34 of 35 in session A's 70 s. Part 4.4 asks for the flag on the first PCR after a gap of 1 s or more. An outage reached the flag only through that step rule (`push_gap` skips an outage's gap), and a relock's PCR, house time continuing, only if it stepped back or by 1 s or more. **Consumer effect:** GStreamer 1.28.2 `tsdemux` resets its PCR observations at a flagged PCR whenever it computes skew (TIME segment; `mpegtspacketizer.c` 417–427), so a Phases 1–2 `tsdemux` consumer re-based at every PCR: on the capture's 70 s through the element at the recorded arrival (identity stamps, TIME segment) its output stepped at 23 of the 33 PCRs after the first, by 1.7–18 ms either way (video frames 4.0 or 25.3 ms apart where they are 20; 19–22 ms with the flags cleared); a per-AU retime would read K moving every 2 s (V-P1-12). **As built:** a written PCR is flagged only at a break of its own timeline: a relock (every relock event, the reference lock's while degraded too), the PCR mapped on another epoch than the PCR before it (a straddler's flip, as at a reconnect backlog's drain), an outage of 1 s or more (`process()` flags each program's next PCR), a PES gap of 1 s or more, a change of the PCR's shift, a switch between mapped and regenerated, a step back; never the source's own PCR spacing. The recorder (F2) writes a PES record's `di` as the source sent it, read before `on_pcr` may set the bit on the same packet (`on_packet` hands it to `on_es`); a PCR record always was. No other writer has the spacing rule: mr-bus-fanout's `HouseRebase` flags the PCR PID's first PCR on a new mapping, mr-tssplit injects unflagged PCR-only packets, and `SelectDemux`, `IdentityStamp`, `mralignwatch` and `mrtsdemux` set GStreamer DISCONT from their state, never the TS bit. | A flag where the timeline continues re-bases the consumer for nothing, by how far its buffer stamp less the PCR moved since its last base: on the vMix recording 1.7–18 ms every 2 s. A relock opens a new epoch and re-acquires β (part 4.4), so it keeps the flag although house time continues across it: one re-base per relock, which the build before spared a relock that stepped forward under 1 s; likewise per flip of the written PCR between epochs, which at a reconnect backlog's drain can be lines 0.4 ms apart (`ts_restamp_test`'s 0.6 s relock backlog). | **Measured** (scratch wf11/vmix-pcr): the fixed element on the vMix capture flags one PCR, the switch to the regenerated PCR at 2.0 s (a real break: the degraded PCR lies 250 ms under the PTS floor), which re-bases `tsdemux` once (+262 ms at 2.24 s, then a −10.6 ms settle of its skew window at 6.2 s), then no step for 63 s (video spacing 19.00–20.15 ms; with every flag cleared, `tsdemux` slews the 250 ms in over minutes instead, 32 steps of +2 ms); with a 3 s hole cut from the capture, the first PCR after it is flagged too, the hole is one 3.06 s gap and no step follows. The old rule back: 34 flagged, the output stepping at 23 of them. Replays: every committed and synthetic trace keeps its events, stats and PES lines; the flagged count (`pcrFlagged`, a new summary and expectation key of `mrts_cli restamp-replay`) changes only by the relocks now flagged (gate 20010 1 → 2, the bursty encoder 0 → 1, `syn-reroute-30ms` and `syn-rewind-1s` 0 → 1, the gate window fixtures 2 → 3) and on the vMix trace (427 → 1). **Tests:** `ts_restamp_test` 239 → 268 (a PCR every 2 s mapped and degraded, with and without a 3 s outage; each relock's PCR alone flagged: a source flag, a leap, the 2^32 jump, envelope steps, a queue ramp, a PCR PID change, a leap of the reference lock while degraded; the floor move's step back alone flagged; the recorder's `di` as sent); mutants killed: the step rule back, no outage flag, no relock flag, no epoch rule, no step-back rule, the recorder reading the restamp's bit; `trace-vmix-sparse-pcr` pins `pcrFlagged` 1 (the core before: 427). **Traces recorded before the fix** give a PES record whose first packet carried a PCR the restamp flagged `di` true: `trace-gate01-rist-20010` (1), `trace-gate01-rist-20046` (1), `trace-srt-reconnect-backlog` (2) and `trace-vmix-sparse-pcr` (427), none other; not re-recorded, and no replay changes (the core uses a PES's `di` only for its record). Texts: part 4.4, ADR-0029 Phase 1, the fixtures README, the release notes. |
| B-85 | The owner's vMix as recorded (OQ-3); fixture names that say what they hold | Recorded 2026-10-21 on .103 (scratch wf10/vmix), fixtures added 2026-10-22. **The source:** the owner's vMix looping a 180 s recording to an SRT listener (10.9.2.53:10000), pulled by a standalone `srtsrc` caller into `mrtsrestamp` (a 70 s session with the raw TS teed, then 930 s). The mux is libavformat's in VBR mode: H.264 Main 720p50 on 0x101 (no DTS, an IDR every 100 frames), AAC-LC ADTS on 0x100, PMT 0x1000, PAT and PMT every 40 packets and before each IDR, no null packets, 8–13.4 Mbit/s per GOP; a PCR only in each IDR's first packet, every 2.000 s, equal to that IDR's PTS; PTS − PCR −37..+28 ms; no stop, lag, leap, freeze or flag. Replayed: degraded (cadence) at 1.56 s for good; no clamp, relock, gap or drop. V-P1-5's criteria pass offline (the warning at 1.56 s, no PES more than 1.04 ms ahead, 930 s without an error, the output decodes with 0 errors); recovery is unreachable on this source. **F3, the listener's stale tail:** each new connection first receives the unsent tail of the previous one (5 PES 2,721 s old, then 4 PES 50 s old), before the first PCR, dropped unmapped; harmless as recorded, though it relocks the reference lock silently, which clears its first-epoch start rule (it would matter only if a start burst followed). **F4, decided by the owner 2026-10-22, option (b): B-86:** with this vMix setup every vMix SRT ingest shows "Degraded clock: cadence" (amber) for good, though its PCR is steady and a PCR lock on it works as well as the degraded mode (with the cadence fail row out of reach: locked at 74 s, 0 relocks, residual min −1.0 ms, leads −37..+3 ms). It is the design (part 4.3's cadence rows, §5.3's ≥ 10 PCR per second). **Names** (the merge review's minor 1): the fixtures are `trace-vmix-sparse-pcr` and `cap-vmix-h264-aac`, which claim neither #820 nor CBR; #820 is vMix in CBR mode (a PCR that stops and lags, PTS 12.6 s ahead) and stays to be recorded as `trace-820-vmix-pcr`, with the vMix SRT output switched to CBR. WI-P2-4's OCC trim is renamed `cap-occ-1080i-h264-21aac-ttx.ts` (the first 10,638 packets, every PID: 21 AAC PIDs, not the 22 that B-54 and ADR-0029 said, and no MPEG-1 audio as `-mp2-` did); both OCC trims stay, their PID sets serve different tests. | The rigs reach the owner's vMix only in its VBR mode; a name must say what the file is (B-32). | `tests/fixtures/restamp/trace-vmix-sparse-pcr.stct` (2 MB: the first 856 s) and `.expect.json` (probed: the cut, the whole 930 s and `backlog_ns` 490 ms pass; the PCR lock, the core before B-84, another trace and each key changed fail); `tests/fixtures/cap-vmix-h264-aac.ts` (two PCRs, 195 PES, ffprobe agrees on each) and `.expect.jsonl`, in `trace_cli_test` (63) and `ts_conformance` (81); `syn-lead-clamp` stays the clamp's fixture. Part 7.2 of chapters 3 and 5, V-P1-5, chapter 6 part 7.4, 10.2; ADR-0029 Phase 1's open items and Phase 2; both READMEs; `scn-split-passthrough`, `aligner_conformance_test.py`, `mrTssplit.test.ts`. F4: B-86 (a cadence row that lets a steady sparse PCR lock). |
| B-86 | A steady sparse PCR locks and shows healthy (B-85's F4; the owner's decision) | The owner, 2026-10-22, option (b): a steady sparse PCR such as vMix's (libavformat VBR mux, a PCR only in each IDR, every 2.000 s) locks on its PCR and shows a green Clock badge with the note "PCR every 2.0 s"; amber stays for a PCR that stops, jumps or comes irregularly. This replaces §5.3's "at least 10 PCR per second" as a degrade condition. **As built** (2026-10-22, engineering choices, for the owner's veto): the cadence row judges the PCR against its own cadence: `C` = the longest of the last 8 intervals the source timed itself (PCR time; no flag, leap or outage; within the cap); late = the open interval past `min(4 s, max(500 ms, 2 C))`, the cap alone while `C` is unknown (a start, a PCR PID change); three late crossings in 60 s while packets keep arriving fail (`cadence`, the card's "PCR missing"), one or two raise "PCR comes irregularly: gaps up to n, normally every n"; a program with no PCR yet, or none since its PCR PID changed, fails at its first crossing, 4 s instead of 1.5 s (a crossing counted before the change does not fail the new PID: the draft's "any crossing in the window" failed it at the first packet after the change, measured in `ts_stc_test`); under B-90's exit rule a crossing restarts the recovery clock only where the row fails (one that leaves three in 60 s, or that first one). The p99-over-10 s warning row and `pcr_interval_warn_ns`/`cadence_window_ns` go; the stats carry `pcr-cadence-ns` and `pcr-gap-max-ns`; recovery clears the windowed counts (`clear_failure`: before, a recovered program failed again at the next packet on crossings or leaps younger than their 60 s window; the prototype measured five degraded/recovered pairs 8 s apart on a dense-to-sparse change, 66 PES dropped, and B-90 six pairs 5 s apart on TECH01 with an injected 2 s PCR stop). `ClockLock`, `RestampCore` and every other row are unchanged. The State row reads "Locked (PCR every 2.0 s)" (or "Acquiring (...)") when the cadence is over the 100 ms spec; the "PCR every n ms (spec ≤ 100 ms)" warning and the "PCR too sparse" label are gone. | PCR time because the cadence is the mux's property and delivery bursts (TECH01's, the gate's 384 ms stalls) must not move it, so with the 500 ms floor every dense source is judged exactly as before; the longest of eight rather than a median because scene-cut IDRs under a VBR mux make many short intervals and regular `keyint` ones; the cap at 4 s because the lock reads lost at 5 s (`lost_ns`), 4 s is the lead and clamp bound, `tsdemux` is measured steady at 2 s (B-84's F1) and nothing beyond, and 30 fit samples take 2 min there. A new crossing, not any in the window, fails a program without PCR, so a PCR PID change shortly after one late interval is no fault of the new PID. **Measured** (scratch wf12/b86; the design's prototype in mr-captures/wf12/b86-proto, its numbers reproduced on this tree): on the vMix trace the PCR lock acquires at 74 s with 0 relocks, 0 steps, residual min −0.99 ms, ε 5.9–24.0 ppm (floor slope +16.9), no PCR flagged, cadence 2.000 s on every stats line from the second PCR, no warning, leads −37..+3 ms (the full 930 s and `backlog_ns` 500 ms alike; with the cap at the floor, the row before, degraded at 1.56 s); a 2 s PCR that stops is "No PCR" at 5 s, degraded at 12 s and back 30 s after its last late crossing (170 s; B-90's exit rule leaves this pin, as its clock restarts at each crossing that leaves three in 60 s, the last at 138 s); a 40 ms PCR that stops degrades at 1.5 s as before; 150 → 600 ms gives one warning and no degrade; 40 ms → 2 s degrades once at 61.5 s and recovers at 92 s (the recovery is tried at each PCR, every 2 s, so B-90's rule leaves this pin too); one 5 s interval on a 2 s PCR warns for 60 s; two 3 s intervals do nothing. Of 84 replayed traces (35 expectation traces, the ten raw field captures, the 36 drift seeds, TECH01's 930 s and both vMix sessions) 80 replay to the same events, PES lines and stats (the new fields aside, the cadence flag masked); the four others are the sparse ones by design; the cadence flag is gone from the gate traces and TECH01 (the arrival p99 rule raised it on 198–377 stats lines each), whose longest PCR intervals are 342–384 ms of a 60 ms cadence; the dense field traces learn 25–60 ms. | `PcrValidatorConfig` (`cadence_factor` 2, `pcr_interval_cap_ns` 4 s, `cadence_intervals` 8; the floor and the 3 in 60 s kept), `PcrValidator::{late_ns, on_packet, feed_pcr, clear_failure, restart_pcr}`, `VirtualStc::Stats`, `gstmrtsrestamp.cpp`'s stats and `restamp_ref`, `mrts_cli` (knobs, stats line, `pcrCadenceNs` summary and the `pcrCadenceMs` expectation key), `fixture_gen --pcr-ms` takes 0 (no PCR from then), the engine's `ingestTimingState`/`ingestTimingView` (`REASONS.cadence` "PCR missing", the State note, the irregular warning, not repeated while degraded on the cadence row; `pcrMaxMs` gone). Tests: `ts_stc_test` 188 → 210 (steady 600 ms, 200 ms, 500 and 520 ms PCRs pass; 500 ms on a 100 ms PCR is on time, 520 ms warns; a steady 2 s PCR; the loop step under jittered arrival, cadence exactly 2 s; scene cuts; a 2 s PCR that stops warns at 24 s and fails at 32 s, with the cap at the floor at 1.5 s; one 6 s interval warns 60 s, one PCR skipped is on time, three 6 s intervals fail; no PCR fails at 4 s; dense↔sparse; `clear_failure`; `restart_pcr`, and a crossing before it; the sparse `VirtualStc` lock at 66 s and its stop, degraded 110.0 s, recovered 170.0 s), checksum `c04aa45e23902500` → `0d1bcc5f88587fc2` (without the two new scenarios still `c04aa45e23902500`: every earlier scenario bit-identical); `ts_restamp_test` 280 → 284 (`test_sparse_pcr` mapped on the shipped constants, degraded with the cap at 500 ms; `test_sparse_pcr_stop`: the PCR missing 100–140 s, degraded 110 s, recovered 170 s, 600 ms per PID each way, the switch's and the return's PCR flagged; stopped at 60 s, before the lock's first fit, the relocked lock has no rate to keep and needs another minute of PCR, so no recovery came in 150 s); `trace_cli_test` 64 → 67 (`trace-vmix-sparse-pcr` re-pinned: locked within 80 s, never degraded, cadence 1990–2010 ms, ε 3–30 ppm from 120 s, no flag; `syn-pcr-sparse` never degraded, one warning; new `syn-pcr-dense-to-sparse`, `syn-pcr-stop-sparse`, `syn-pcr-irregular-sparse`; `cadenceWarning` false on the gate pair and `trace-tech01-relay`, whose `pcrCadenceMs` 60 is pinned; the key loop gains `pcrCadenceMs`); the element test (the two fields, 40 ms on every report); `ingestTimingReporter.test.ts` 22 → 24 and the three input-module tests. Mutants caught: the late threshold the floor always, no cap, an interval over the cap teaching, no floor, the cadence at arrival, the median of eight, a late interval not teaching, `clear_failure` clearing the reason only (5 and 4 degraded/recovered pairs on the dense-to-sparse and stop traces), no first-crossing rule, the warning on the p99 rule, the first-crossing rule on any crossing in the window, `restart_pcr` keeping the cadence; on the card `REASONS.cadence` unchanged and the irregular warning shown while degraded on the cadence row. Texts: part 4.3 (Cadence row, telemetry, recovery), part 2's design reference, WI-P1-4, parts 7.2, 8, 10, 10.2, V-P1-5, new V-P1-20; design §5.1, §5.3; ADR-0029 Phase 1 (the validation bullet, the degraded entry's example, the return, the per-trace table, the card's warnings, the open item); the fixtures README; `plugins/README.md`; the release notes. Device: V-P1-20 on .103 against the live vMix (Locked with the note within 90 s, no event or warning for 30 min). Open: B-90's stream-lead lower bound reads one cadence high on a sparse source (PTS less the last PCR runs up to one cadence above the mux lead; the safe side; noted, not built). |
| B-87 | The engine dies at its own stop: EPIPE on a sidecar's stdin (mr-tssplit, mr-bus-fanout) | Found 2026-10-22 on .108 (wf11, the `e7b4ee8e` build; the same code is in `263bdcd7` and on `origin/v2.0`), fixed 2026-10-22 (engineering choice, for the owner's veto). **Cause:** the unit sets no `KillMode` (`media-router.bb`), so `systemctl --user stop` or `restart` SIGTERMs the whole cgroup at once, and mr-tssplit leaves within one `poll()` (`main.cpp:83-104`). The engine's handler meanwhile removes every connection first (`Engine.stop` → `ModuleLifecycle._stopAll` → `MpegTsBusExecutor.teardown:293` → `BusFanoutCoordinator.detach` → `NativeSinkController.sendBusDetach` → `ManagedProcess.writeLine`), 15–20 ms after the signal, once per splitter output edge. `writeLine`'s guard (`isRunning`, `stdin.destroyed`) could not see a child that is dead but not reaped: the stop runs as one promise chain, so libuv has delivered no SIGCHLD yet. The write failed EPIPE, and the stdin stream had no `'error'` listener: Node emits the error once the chain parks (after `ProcessManager.releaseAll` logs for the splitter), and the engine exited 1. 3 of 3 stops (22:08:57Z, 22:50:31Z, 01:18:13Z); the 10-frame stack hides every frame above `sendBusDetach`. `bc027049` (`v2.0.0.68`) added the stdin pipe without the listeners `PythonProcess` keeps on every pipe. **Exposure:** the two `stdin: true` children, mr-tssplit (`bus_attach`, `bus_detach`, `reinput`, `add_output`) and hls-player's fan-out sidecar; the fork rollback's IPC channel (`MR_GST_RUNNER_FORK=1`) had the same window. Deterministic at a systemd stop, restart, reboot or update. Otherwise any control write between a sidecar's own death and its reaping was exposed: a module stop, delete, disable or restart, a profile switch and `resetEngine` all detach while the child lives and kill it afterwards. **As built:** `ManagedProcess.start` hears `'error'` on each incarnation's stdin and logs it at debug ("stdin closed by the child"), not as its own `'error'` event, which sets the module's health to error; a real death is still reported, by `'stopped'` at the child's exit. `writeLine` refuses a failed pipe (`!stdin.writable`: errored, ended or destroyed); a failed write errors the stream at once, so a second write in the same tick is refused instead of buffered into it. `ForkedRunnerBackend` hears `'error'` on its child (debug). A refused write loses nothing: the controller keeps the desired edge set and replays it at the child's next `ready`, and `reinput` and `add_output` time out after 6 s into a module restart. No other writer to a child's pipe was exposed: the runners' `PythonProcess` hears every pipe, mr-clockstate and the SAP and hls-pipe sidecars have no stdin pipe, and the `execFile` helpers never write one. `KillMode=mixed` in `media-router.bb` would give systemd stops the engine's own stop order (consumer before branch, drain before NULL); not changed, the owner's call. | A systemd-driven stop of an engine with a wired ts-splitter output or a consumed hls-player ended `failed`, exit 1, and skipped the rest of `Engine.stop` (PipeWire orphan cleanup, house clock, manager disconnect). A sidecar dying during a control write took every route on the box down until systemd restarted the engine. The field line carries the same code: `origin/v2.0` has it (hls-player from `v2.0.0.68`, ts-splitter from `v2.0.0.71`) and the same unit; a backport is a release, the owner's call. | **Tests:** `ManagedProcess.test.ts`: a child that closed its stdin (the write heard at debug, no `'error'` event, still running, the next write refused); a child SIGKILLed from outside and written before it is reaped, the loop held with `Atomics.wait` until `/proc` shows it dead; `writeLine` false once its pipe failed, in the same tick. `UnixFdFanoutController.test.ts`: `sendBusDetach` to a dead, unreaped child does not throw, and the edge leaves the replay set. `mrTssplit.test.ts`: the real binary SIGTERMed from outside, then `bus_detach` before it is reaped: exit 0, nothing uncaught. `GstChildProcess.test.ts`: the fork backend's send into a dead, unreaped shim. Each fails on the code before with an uncaught `write EPIPE`, the field's stack. **Device check** on .108: `systemctl --user stop` and three `restart`s end `Result=success`, `ExecMainStatus=0`, with no EPIPE and "All modules stopped". Texts: the release notes. |
| B-88 | 302M captures relock under CPU load: the runner's PipeWire node on an unprivileged thread (V-P1-7, wf11 run 1); audio-encoder the same | Found 2026-10-22 on .108 (wf11 run 1), fixed 2026-10-22 (engineering choice, for the owner's veto). **Observation:** with the profile's HDMI video player and the test load (busy 90–94 %, 1-min load 10.6–14.6) the two ATEM captures relocked 28 and 105 times in the hour (`envelope-step`, 50–208 ms, each a restamp `gap (jump)`), `ratio-out-of-bounds` 5 and 19; pw-top: capture a2, an async follower, waited 10.4 ms per 42.7 ms cycle (W/Q 0.24), with xruns; with the player off (busy 46–50 %) none. **Cause:** PipeWire 1.6.3 puts the node of a stream connected without `PW_STREAM_FLAG_RT_PROCESS` on its context's main loop (`stream.c` 2093–2097: `node.loop.class` main unless the client set one, `node.async` true; `context.c` 808–812), and `pipewiresrc` never sets the flag (`gstpipewiresrc.c` 1207–1211). In a GStreamer client that main loop is the plugin's `pw_thread_loop` "pipewire-main-loop", started without RT (`gstpipewirecore.c` 53–64). The runner's module-rt (stock `client.conf`; no `PIPEWIRE_*` in the runner env, `client.conf.d` holds only the quantum limit) promotes data loops only, and a capture runner starts none. rtkit is therefore never asked: this boot's journal has its grants for pipewire, pipewire-pulse and WirePlumber at boot and none since, though polkit answers yes for a runner and rtkit allows RR 20. The cycle's client half (the wake on the daemon's signal, the adapter's conversion, the queue to the element) runs SCHED_OTHER nice 0 and shares the loop's non-PI mutex with `pipewiresrc`'s streaming thread. #748 made RT possible and left runners OTHER by design; PipeWire had already moved such nodes onto the main loop, so nothing in a runner was RT-eligible. **As built:** `pipewireStreamProps`, beside the #736 pins in `packages/engine/src/plugins/pulseStreamProps.ts` and exported by the engine with `PIPEWIRE_RT_STREAM_PROPS`, writes the pins, then `node.loop.class=data.rt`, then the module's own fields. Both engine `pipewiresrc`s take it (audio-input-302m's and audio-encoder's `buildCapture`; the tree builds no `pipewiresink`); the ten `pulsesrc` and `pulsesink` clauses keep `pulsePinnedStreamProps`. The node then runs on the runner's `data-loop.0`, which module-rt gets SCHED_RR 20 through rtkit as it does the daemons'. The element's process callback (a condition signal) runs there. Its streaming thread, where `mrasrc` runs, stays OTHER with 16 buffers (≈ 0.68 s at quantum 2048) behind the cycle. Image, with the next build: the yocto repo's `57a27e4`, an rtkit-daemon drop-in (`--processes-per-user-max=64 --threads-per-user-max=128 --actions-per-burst-max=128`; stock 15, 25 and 25 per 20 s, of which the daemons hold 3 and 6: room for 12 such runners, the count on ZA-SCC-NYA-Master01 and ZA-SCC-FRA-Master01, 12 audio-encoders each), and the `pipewire-config` README's profile row and runner check. No flag. | An async follower has one quantum to run or the cycle's samples are gone. A lost cycle is a PTS step against the sample count, which `mrasrc` relocks on and the restamp marks as a gap. `node.loop.class` is PipeWire's own selector, honoured in 1.6.3 when the client sets it (and in the dev Pi's 1.2.7). The change lands with the app and acts the same in the native and the Python runner (it is in the launch string), on the RT path the image already proves for the daemons. Rejected: `client.conf.d` `stream.properties` (moves every libpipewire client's streams, tools included); runner code promoting the main-loop thread (keeps the non-PI lock shared with the streaming thread; a native and a Python copy); `LimitRTPRIO` on `user@.service` (no thread asks; module-rt's direct path leaves RLIMIT_RTTIME unlimited); CPU weight or nice (no cpu controller under #748; nice is no deadline). | V-P1-7's bus criterion fails as written under realistic load (a1 28 and a2 105 PES pairs outside ±1 tick, of 84,301 and 84,115). audio-encoder has carried the same exposure since OQ-16 moved it from `pulsesrc` (its stream on pipewire-pulse's RR 20 loop) to `pipewiresrc` (R-P1-10). Pulse elements are not exposed this way: audio-output-302m's `pulsesink` node runs on pipewire-pulse's `data-loop.0` (wait 28–33 µs on .108); its libpulse thread fills a 100 ms server buffer. B-43 (.111's SSL 2, PipeWire ERR 0) has another cause. Risks: RLIMIT_RTTIME 200 ms (set on the runner by module-rt) kills a runner whose RT thread spins; rtkit's canary demotes every RT thread, the daemons' too, and refuses requests for 5 min if a SCHED_OTHER thread starves for 10 s; RR 20 equals the daemon's data loop, with no inversion (async, separate PI-locked loops); the callback runs off the main loop's lock (a one-cycle lost-wakeup window, no sample loss); without the drop-in, rtkit refuses runners beyond 12 with a warning and they stay OTHER. **Tests:** `pulseStreamProps.test.ts` 4 → 11: the helper's exact string (the pins, the class, the module's fields after them; an extra cannot drop a pin or the class); the pulse helper never names a loop; a scan of every package's sources and every plugin's engine half finds each `pulsesrc`, `pulsesink`, `pipewiresrc` and `pipewiresink` clause with its own helper (12 found: the ten pulse ones and the two captures) and no other source naming a node loop (`node.loop.`) in code. The two modules' capture strings carry the class. Mutants caught: all 9 (either capture back on the pulse helper, the class dropped, `data` for `data.rt`, the class after the module's fields, a pulse sink on the PipeWire helper, the pins gaining the class, the class written by hand into the VU tap, one of two `pulsesrc` clauses in a statement losing its helper). **Dev Pi** (PipeWire 1.2.7, audio-encoder's capture string on the dummy sink, 12 s): before, the node on `pipewire-main-l` (class `main`); now on `data-loop.0` (class `data.rt`), `node.async` both times. With module-rt loaded (the box's `client.conf` loads it, the dev Pi's 1.2.7 one does not) that thread ran SCHED_FIFO 83 under the session's own rtprio limit; under the box's limits (RLIMIT_RTPRIO 0) module-rt set RLIMIT_RTTIME to 200 ms and asked rtkit for RR 20, which polkit refused there (an SSH session) without a journal line. **Device check** on .108 (to do): run 1's loaded hour again. Each capture runner's `data-loop.0` at RR 20 with an rtkit grant line (module-rt's own "acquired realtime priority" line is written without rtkit's reply: read the thread), its node at `node.loop.class` `data.rt`; capture streams at pw-top W/Q ≤ 0.01 with ERR flat; 0 relocks and 0 out-of-bounds; every PES pair within ±1 tick, 0 DISCONT/GAP; no runner restart. Texts: part 4.1's capture rows, WI-P1-12, V-P1-7, R-P1-10, `plugins/README.md` (linking a stream to device channels), the release notes; the `pipewire-config` README (`57a27e4`). |
| B-89 | The fixed-mode jump rule on a video PID (V-P1-8, the wf11 round) | Found 2026-10-22 on .108 (scratch wf11/device108), fixed 2026-10-22 (engineering choice, for the owner's veto). **Cause:** B-21's rule (a spacing past twice the upper median of the last three) put its threshold on the commonest capture drop, one frame: a one-frame hole is a spacing of 2.0 frame lengths ± capture jitter, so about half of single drops crossed it, and after a stall it also marked holes inside a frame. Run 1 (the ATEM's 25 fps MJPEG capture on a saturated Pi 4, 19.56 frames/s out): 7,655 `gap (jump)` markers on PID 0x41 in 66.7 min (holes p10 40.3, p50 44.2, p90 82.7, max 620 ms; 80 % ≤ 60 ms), each a GAP and DISCONT buffer on the bus and an info log line; run 2 (unloaded): 26 jumps, 14 of them 10.8–43 ms in the 1.5 s after a 1.48 s v4l2 stall, and that stall's outage. **As built:** in fixed mode a forward step on a video PID is a gap (`jump`) only when its hole, `key − (last_key + interval)`, is also `GAP_FLAG_NS` (1 s) or more; audio and other PIDs keep B-21's rule; outage, edit, epoch and backlog gaps are unchanged on every PID; one info log line per event stays. A step under the bound is a plain step: it sets the interval and joins the spacing reference, as a step under 2× always did. | A dropped video frame is no timeline gap: decoders hold the last frame, aligners see video only after `tsdemux` and gap a silent input themselves after W, and the marker comes with the frame that ends the hole, so nothing could act on it sooner. Meanwhile every Phases 1–2 `tsdemux` consumer drains and flushes at each marker (B-20), `mrtsstamp` stops coalescing that list and mr-tssplit sends the marker alone. The log: 2.4 MB/h of message text against .108's 32 MB volatile journal for every unit. 1 s is the restamp's own outage and PCR-flag bound, so a video jump always flags the next PCR (part 4.4). | **Measured** (scratch wf12/b89): the encoder's bus PES as wf11's tap logged them, replayed in fixed mode: run 1's 60 min (70,402 PES) give 7,017 jumps on the core before and 0 now; run 2's hour (89,983 PES) 26 jumps and the 1,489.9 ms outage before, the outage alone now; the 10 min with the player off 12, now 0. Every expectation trace, the ten raw field captures, the 36 drift seeds and the TECH01 recording replay to the same lines (all `stc`). **Tests:** `ts_restamp_test` 268 → 277: in `test_fixed`, video with 1, 2 and 5 frames missing 39 times under ±4 ms capture jitter gives no gap, no marker and no event, the holes left as they are, where B-21's rule alone marks 23, 39 and 39 of them; 30 frames missing (a 1.2 s hole) give one `jump` marker of the hole's length and the next PCR flagged; on exact frames a 960 ms hole whose step is 1 s gives none and a 1 s hole one; audio-2's 100 ms case is unchanged. `gst_mrtsrestamp_element_test.py` 61 → 63: no GAP buffer from a dropped-frame video stream through the element, one at a 1.2 s hole. Mutants caught: the video clause removed (the core before: 4 checks and the element's), the step for the hole, a strict bound, the bound on every class (7), video never a jump. Texts: B-21's consequence, WI-P1-4, part 4.5, ADR-0029 Phase 1's jump rule, the release notes; chapter 7's `gap-threshold` 2 has the same boundary on a video pad (a note there, for Phase 3). **Device check** on .108: run 1 (the encoder on the ATEM with the profile's video player, 30 min) and run 2 (60 min unloaded) again: no `gap (jump)` under 1 s on the encoder's PID, outages still marked (`gap (outage)` and the task's markers every 250 ms), GAP-flagged buffers at the C tap only at outages, the PES rate and distinct frames as in run 1, the encoder's restamp log lines about 0 an hour. |
| B-90 | The lead row's lower bound on the stream's own PTS − PCR (the srt-input on TECH01, degraded for good); the exit rule; the card's alarms while degraded | Found 2026-10-22 on .108 (the wf11 round and its journal), fixed 2026-10-22 (engineering choices, for the owner's veto). **Seen:** srt-input calling TECH01 (10.9.1.131:9000, a relay of the production gate's renditions) entered `degraded (lead)` at every start of the boot (22:43:29Z with only the profile, 22:53:39Z under run 1's overload, 01:18:39Z 22 s after a restart with the profile alone) and never recovered (0 `recovered` in 3 h 14 min). Under the PCR line before the trip both PIDs' leads (house(PTS) − arrival) ran 10 s medians of −150 to +215 ms with minima down to −773 ms. Degraded, the reference lock relocked 53 times in the hour, in pairs every 150 s: each relock a 170–420 ms `gap (epoch)` on both PIDs, the first of each pair followed 6.6 s later by a 550–660 ms overlap; 17.2 s of gaps and 15.7 s dropped per PID per hour. **Cause:** the lower bound judged the lead against arrival, the source's mux lead (TECH01's 125 ms) less the delivery's delay above its floor, so a burst, a CPU stall or any rise during acquisition read as a PCR fault after 5 s, before the envelope step (10 s, only once locked) could relock; recovery then needed 30 s without a single bad observation of any row, and that delivery's single frozen PCR pairs (a stall longer than two PCR intervals) come about once a second. **As built:** (1) `PcrValidator::feed_lead` takes two leads per PES: against arrival (house(σ) − h under the PCR line, as before, kept out while the line is stale, B-39), judged against `lead_max_ns` (+4 s) only, and the stream lead, σ (the PTS, DTS for video) less the program's last PCR, both in source time, judged against `lead_min_ns` (−200 ms) only; a 1 s median and the 5 s hold each. The per-PID lead telemetry, the card's lead figures and the 4 s clamp stay on arrival. (2) The exit rule, measured first: an observation restarts the recovery clock only where its row fails (a cadence crossing or a leap at the row's count, a freeze pair at the third, a rate fit or a lead median past its hold): part 4.3's "30 s of PCR that passes every check" read as 30 s in which no check failed. (3) The card: while degraded, the re-lock and rate alarms say "Timing from PID 0x… PTS", not "Source clock" (the stats carry the reference lock's relocks and rate then: TECH01's −242 ppm was that lock's estimate), and the rate alarm's minute starts over when the program changes lock. Not built: the PCR lock's phase and clean time in the stats while degraded (every replay's stats line, the element's message, the reporter, the card and part 10 would move). | Design §5.3's check is the PTS − PCR lead; §5.1 has a compliant source arrive after its house PTS only by jitter above the minimum delay. Degraded mode maps the same arrivals, so it cannot cure a delivery lag. The last PCR is at most one PCR interval old, so the stream lead reads high by at most that: the safe side for a lower bound. A mux writing its PTS behind its own PCR still degrades. Under the old exit rule a program degraded on a bursty path, for whatever reason, stayed degraded: on the TECH01 trace with the bound fixed, an entry forced by a 1 s PCR freeze (at 120, 300 or 500 s) or a 2 s PCR stop (at 300 or 600 s) never recovered (802 single frozen pairs in 930 s, the longest gap between them 18.2 s). The exit rule's cost, measured: the latch becomes flapping on a source that sits within its delivery's jitter of a bound. | **Measured** (scratch wf12/b90): TECH01 (`trace-tech01-relay`, new: the first 734 s of a 930 s standalone recording, 2026-10-22, 02:24:32Z, beside the engine's caller): stream lead 125–165 ms on video, 126–184 ms on audio, never near −200 ms; never degraded, locked at 188 s (the core before: degraded (lead) at 91.4 s for good, the expectation's negative probe). The exit rule on it: a forced freeze recovers 30.8 s after the entry (at 300 and 500 s; at 120 s, while the lock still acquires, once it locks, 177 s on); a 2 s PCR stop recovers 30.5 s on, then fails and recovers six times 5 s apart until its crossings leave their 60 s window (`clear_failure` keeps them, B-86's item); a 6 s delivery stall, with or without its outage record, is a leap's relock and the backlog's drop, no entry. A switch costs nothing (the freeze at 500 s) up to 0.8 s of gaps and 0.6 s dropped at the entry and 0.5 s and 0.9 s at the recovery (at 300 s: the straddle tie-break flips PES between the two epochs on jittery leads for up to 4 s, OQ-11). Replays: of the 81 traces (the 34 expectation traces, ten raw captures, 36 drift seeds, the TECH01 recording) the bound moves only TECH01 and the exit rule only the two gate window fixtures: PID 200, 3.9 and 3.95 s ahead on the gate's ±300 ms delivery, now recovers (345.8 and 245.6 s) and fails again (380.3 and 270.2 s), each switch moving it by its 4 s lead: 11.4 and 12.4 s dropped and 7.2 and 8.6 s of gaps, against 5.6 and 7.1 and 1.5 and 3.3 s latched (re-pinned). **The 150 s pairs** are not degraded mode's. TECH01's delivery repeats every 150.0 s: a 12 s rise 400–600 ms above its floor, 10 s on the floor (170 ms under its usual level), then that level. A lock near the floor relocks on the rise (an envelope step), its new epoch seeded on a late sample; the dip lies more than `backlog_ns` under that seed, so the line moves onto it (the 560–660 ms overlap 6.6 s on); the usual level steps again 20 s after the first. The fixed core's PCR lock does exactly that: 10 relocks in the fixture's 734 s (12 in the 930 s, about 46 an hour), 4.75 s dropped, 5.1 s of gaps. The standalone recorder's reference lock, seeded high at its one relock and never moved, absorbed the rises; the engine's lay on the floor (its residual p99 above 0 in 94 % of run 2's reports, median +145 ms; ε −113 and −242 ppm). Not changed here (the floor rules of B-45 and B-48, with a trade-off): moving, in an epoch an envelope step opened, only past `lead_max_ns` (B-48's recorded fallback, scoped to such epochs) or only once the deeper floor has held `step_hold_ns`, both prototyped: on TECH01 2 relocks and 0.08 s dropped in 930 s, the median lead 80 → 392 ms (the latency its rises need anyway), every other trace and unit test unchanged; the first keeps a later fall's latency for hours (20 ppm), the second drops it once after 10 s; seeding a step's relock on the step's floor instead adds relocks on the gate traces (1 → 3–7). **Tests:** `ts_stc_test` 175 → 188 (validator: a 100 ms stream lead delivered 400 ms late for 8 s passes, the stream lead below −200 ms fails at 15.5 s; per row, two frozen pairs, two crossings, two leaps, a 4 s excursion and a rate fit short of its hold leave the recovery clock running, the third or the hold restarts it; `VirtualStc`: a 100 ms mux delivered 400 ms late for 8 s, acquiring and locked, no event; the same rise held, one envelope-step relock 10 s on, never degraded; PTS 300 ms behind its PCR, degraded (lead) at 5 s and recovered 30 s after it is back; the same from a 90 s backlog drained in 5 s, degraded 5 s after the drain starts, the stale PES kept in the stream half; a PCR stuck 1 s, then a 250 ms stall every 2 s: recovered 30 s after the freeze row last failed; the PCR fed as a PID's lead no longer degrades); `ts_restamp_test` 277 → 280 (a 125 ms lead, the path 450 ms higher for 8 s every 20 s: never degraded, no relock, gap or drop; the core before degrades at 15.7 s); `trace_cli_test` 63 → 64; vitest `ingestTimingReporter.test.ts` 21 → 22. Mutants caught: the bound back on arrival (the core before: seven checks, the relay case, the TECH01 expectation), the bound removed, the stale exclusion on both halves, the upper bound on the stream lead, and the old exit rule row by row. Checksum `ts_stc` c04aa45e23902500 (without the new cases 34d1bc5cd406b9a6, every earlier scenario bit-identical); `asrc_servo` unchanged. Texts: part 4.3 (the Lead row, the return), part 7.2, part 10's alarm table, chapter 10.2, ADR-0029 Phase 1 (the validation bullet, degraded mode's return, the traces, two open items), the fixtures README, the release notes. **Device check** on .108 (to do): the srt-input on TECH01 for 1 h with the profile, one engine restart and a 2 min load burst (run 1's test modules): never `degraded (lead)`, the Clock badge Locked after acquisition (about 190 s on this delivery); at most 3 relocks per 10 min and no 150 s cycle hold only with the floor change above (the replay predicts about 8 relocks per 10 min in the 150 s pairs without it). |
| B-91 | Finding: one fd per bus buffer under a lagging consumer (n1x16 on .108) | Measured 2026-10-22 (the wf11 CPU round; read-only on .108), as designed. Each bus buffer crosses an edge as memfd memory of its own: `unixfdsink` keeps it until the consumer's release, and `unixfdsrc` holds its fd until the buffer is freed (the native mr-tssplit and mr-bus-fanout close theirs at once). The count per edge is bounded by the consumer's ingress queue (5 s, or 40 MB when stamps stall). n1x16's probe reached 15,466–16,223 fds = 16 inputs × 5 s × about 195 buffers/s of 1,316 bytes, with the runner shedding; the first runs died at the login shell's soft limit of 1,024. The engine and its runners run at 524,288 soft and hard; .108 then held 115 and 33 memfds in the srt-input and audio-transcoder runners. **Not right in ADR-0015:** each memfd is rounded up to whole pages: a 1,323-byte buffer pins 4 KiB on a Pi 4 and 16 KiB on a 16K-page kernel (the dev Pi 5's), so at the 40 MB cap of 1,316-byte buffers an edge pins about 125 MB, or about 500 MB, not 40 MB. | Realistic lags hold about 120 buffers per 302M edge (coalesced) and about 1,800 per 3.8 Mbit/s SRT edge (single 1,316-byte buffers); reaching 524,288 needs 17 edges at the byte cap in one runner. Stamps rarely stall under identity, so the time bound is the one that binds. | No code change. ADR-0015's consequence bullet carries the page arithmetic. If a box ever shows the memory: coalesce single TS buffers before the egress tee, as mr-tssplit does (692 → about 45 buffers/s), or add a `max-size-buffers` bound to the bus ingress queue. |
| B-92 | A native fan-out's stop leaves its edge sockets and garbles its `detached` lines: `FanoutServer::detach_all` reads a freed key (libmrbus; mr-tssplit, mr-bus-fanout) | Found 2026-10-22 on the dev Pi by B-87's work (its `mrTssplit.test.ts` case: the `detached` event at the exit began with freed-heap bytes) and seen the same day on .108 (DEV1: after B-87's stops the splitter's `/tmp/mr-bus-40001-77f39b.sock` and `/tmp/mr-bus-40002-a2c88e.sock` stayed on disk, and both `detached` lines read `"\u0000u0000u0000…"`; .103's stop of the old build, which also hit B-87, left 31 of 55 bus sockets), fixed 2026-10-22 (engineering choice, for the owner's veto). **Cause:** `detach_all()` (`fanout_server.cpp:134`) called `detach(edges_.begin()->first)`, and `detach(const std::string& path)` erased that map entry (`:120`) before it read `path` again: the `unlink`, the client loop's `edge == path`, the `detached` event. glibc's `free` writes its free-list link and key over the first 16 bytes of the freed key's buffer (every edge path is longer than the 15 characters a string holds inline), so the `unlink` named garbage and missed the file, no client of the edge compared equal (the destructor and the exit closed them instead), and the event carried the garbage or, where `json_escape`'s buffer landed in the freed chunk, its own output. Both binaries call `detach_all` at every exit (mr-bus-fanout `main.cpp:148`; mr-tssplit `App::shutdown`, `app.cpp:310`), and a systemd stop SIGTERMs them with their edges still attached; a `bus_detach` verb was never exposed (its path is the parsed command's). `origin/v2.0` has the same code (`b85e9c65`, 2026-07-26; every tag from `v2.0.0.71`). **As built:** `FanoutServer::detach` takes its path by value; `detach_all` is unchanged, its argument now copied before the entry goes. Read for the same pattern (a reference into a container used after that container's erase): libmrbus, mr-tssplit, mr-bus-fanout, mr-gst-runner, mr-clockstate and the mrts code they link; no other case (the runner's edge code already copies its keys: `retry_pending_cb`, the stall watchdog's snapshot, `teardown_branch`'s callers). | By value fixes the function for every caller: an argument that names state `detach` destroys (the entry's key, or a client's `edge`, which the loop's `drop_client` frees) is safe, for one string copy per detach, a control-plane call. A stale socket cost little at the next start (`attach` probes it and unlinks it), but each stop left the edges' files in the bus socket directory (one more set whenever the ports moved), the `detached` lines named no edge, and a read of freed memory is undefined: the exit unlinked and reported whatever the allocator had written there. | **Tests:** `unixfdFanout.test.ts`: mr-bus-fanout with two attached edges and a capture client on each, then SIGTERM: exit 0, the two `detached` events name the two edges, no `.sock` file is left in the directory, and each client ends on EOF with no buffer; `mrTssplit.test.ts`: the same with two wired outputs. On the code before both fail on the event paths, 6 runs of 6, and 80 shutdowns of builds bit-identical to the tree's garbled 160 of 160 events and left 160 of 160 edge sockets; the clients see EOF either way, the exit closes them. The test client's capture verdict now says how it ended (`end`). AddressSanitizer builds of both binaries (scratch, `-fsanitize=address -fno-omit-frame-pointer`): before, a `heap-use-after-free` READ in `FanoutServer::detach` (`:121`, freed at `:120` from `detach_all`) at every shutdown; after, no report, also with data flowing and an edge detached and attached again before the stop. **Device check** on .108 (to do): after a `systemctl --user stop` with wired splitter outputs no `mr-bus-*` edge socket is left in the bus socket directory, and mr-tssplit's `detached` lines (debug) name real paths. No release-notes line (not operator-visible). |
