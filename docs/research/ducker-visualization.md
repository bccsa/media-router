# How the industry draws a ducker

Research note — how professional mixers, broadcast consoles, installed-audio DSP and
DAW plugins visualise auto-ducking (voice-over ducking), and what that implies for the
SVG envelope graph we are considering for the audio-processing plugin's ducker mode.

Scope: the *time-domain gain envelope* question — gain (dB) vs time showing attack ramp,
hold plateau at the duck floor, release ramp. Every claim below is sourced to a
first-party manual, help system or plugin documentation. Investigated 2026-08-26.

---

## TL;DR — the headline finding

**Almost nobody ships a schematic attack/hold/release envelope diagram.** Across every
primary source checked, professional ducker UIs converge on two things, and only two:

1. **A static response graph whose X axis is a *level*, not time** — key/detector level in,
   gain out. Q-SYS states it explicitly: *"The x-axis represents the RMS Level Detector
   level. The y-axis represents the gain of the main inputs."*
   ([Q-SYS Priority Ducker](http://help.qsys.com/Content/Schematic_Library/priority_ducker.htm))
   Yamaha's is the same idea: the dynamics graph *"Displays the input/output characteristics
   of the dynamics processors"*
   ([Yamaha DM7 DYNAMICS Screen](https://manual.yamaha.com/pa/mixers/dm7/rm/en-US/11049224331.html)).
2. **Live behaviour on a separate gain-reduction meter**, never as a moving point on the
   envelope: Yamaha's `GR (gain reduction) meter`, Q-SYS's `Gain Meter` + `Applied Gain LED`,
   Calrec's integrated dynamics meters, Drawmer's fading amber LED.

The attack/hold/release *timings* are, in every console and DSP source checked, delivered
as **prose plus a number** — no picture at all. Where a time axis does appear in a real
product it is **true, linear, real time carrying real audio** (a scrolling level display, or
an automation envelope over a timeline), never a normalised phase-by-phase schematic.

So we have no convention to copy verbatim. What follows is the recommendation that stays
closest to what the sources actually justify.

### Recommendation for our SVG envelope graph

- **Orientation: gain on Y, attenuation drawn DOWNWARD from a 0 dB idle line at the top.**
  This is the one thing every source agrees on. Depth/Range/Duck Level is universally
  defined as *attenuation applied* — Calrec "Depth: Controls the maximum amount of
  attenuation", Q-SYS "Depth … sets the amount of attenuation", Biamp "Ducking Level …
  how much attenuation is applied", Yamaha "Range … the amount by which the signal will be
  lowered". Depth is never phrased as a positive quantity growing upward. Y range
  `0 dB → duckDepth − ~3 dB` of headroom, 0 dB at the top, labelled `0 dB (unity)`.
- **Shape: idle → attack ramp → hold plateau → release ramp → idle.** Start and end on the
  0 dB idle line so the diagram is a closed story; give a short idle stub at each end
  (~6–8% of width) so the ramps have something to leave from and return to.
- **Time axis: piecewise / per-segment, explicitly not-to-scale.** With our defaults
  (attack 5 ms, hold 250 ms, release 200 ms) true linear time makes the attack ramp one
  pixel wide, and attack is the parameter operators most often get wrong. Allocate each
  phase's width by a compressed mapping — width ∝ `sqrt(duration)` (or `log(1+t)`), clamped
  to a minimum of ~12% of the plot — so the *ordering* stays honest (release visibly longer
  than attack) while nothing collapses. Then carry the truth in the numbers, not the
  geometry: label each segment with its real value. Mark the axis as non-linear (a tick-break
  glyph between segments, or a `time — not to scale` caption). Do **not** claim a linear
  ms scale we are not drawing.
- **Segment labels: yes, one per phase** — `Attack 5 ms`, `Hold 250 ms`, `Release 200 ms`.
  This is the only mechanism that survives the non-linear axis, and it mirrors how every
  console manual delivers these parameters (as named times).
- **Depth/floor: label it on the plateau** — dashed horizontal rule at `duckDepth` with
  `Duck −12 dB`. Sourced convention: it is the single most-named quantity in every ducker's
  control list.
- **Threshold: do NOT put it on this graph.** Threshold is a *key-level* quantity; on a
  gain-vs-time plot there is no axis it belongs to. Every source that draws threshold draws
  it on a level axis (Q-SYS: *"The Threshold level is on the X axis of the graph"*; our own
  `dynamicsGraph.ts` already places it as an `axis: 'x'` marker on the transfer curve).
  Keep threshold where it is, on the transfer curve.
- **Key-signal overlay: yes, but as a trigger *window*, not a waveform.** Shade the region
  where the key is over threshold (a low background band spanning attack + the over-threshold
  part of hold). Hold is defined relative to the key falling below threshold in every source
  — Yamaha: *"the waiting time until the gate starts to open after the input signal falls
  below the threshold level"*; Q-SYS: *"how long the main channel stays at Depth once the
  Detector level drops below the Threshold"* — so hold is unreadable without showing where
  the key ended. A fake speech waveform would be decoration; the trigger window is the
  actual mechanism.
- **Live dot: yes, but Y-honest only.** Precedent for live indication is universal (see
  the GR meters above; Drawmer's amber LED literally *"will fade over the duration of the
  release time"*; FabFilter's *"real-time moving level display"*). But our X axis is
  schematic, so a dot cannot be honestly positioned in X by interpolating time. Our engine
  already knows the answer: `DuckerEnvelope` holds `db` and the active/hold state, so publish
  `{ gainDb, phase }` and place the dot **on the segment for `phase`, at height `gainDb`**
  (per ADR-0007 — plugin computes, UI renders). If phase is unavailable, degrade to a
  horizontal "current gain" rule across the plot plus the numeric dB, and draw no dot —
  the same discipline `livePoint()` already applies ("Without a key level there is no honest
  x, so the dot is omitted rather than parked somewhere").
- **Keep the numeric GR readout regardless.** That is what every shipping product actually
  relies on; the envelope is an explainer, the meter is the instrument.

Strongest sources behind this: Q-SYS Priority Ducker help, Yamaha DM3/DM7 reference manuals,
Calrec Brio 36 user manual, Drawmer DS201 operator's manual, Ableton Live audio effect
reference.

---

## Per-source findings

### Q-SYS (QSC) — Priority Ducker component

- Doc: *Priority Ducker*, Q-SYS Help.
  <http://help.qsys.com/Content/Schematic_Library/priority_ducker.htm>
  (canonical URL `https://q-syshelp.qsc.com/Content/Schematic_Library/priority_ducker.htm`
  301-redirects here)
- **Axes are level→gain, not time.** *"The x-axis represents the RMS Level Detector level.
  The y-axis represents the gain of the main inputs."*
- Control panel elements: a **Response Graph**, a **Detector Meter**, an **Applied Gain LED**
  (*"lights when the RMS level of the Priority channel exceeds the Threshold Level"*) and a
  **Gain Meter** (*"represents the amount of gain applied to the main channels"*).
- **No time-domain envelope diagram anywhere in the component's documentation.**
- Parameter wording: Threshold Level (dBFS) = *"The RMS level of the Priority channel at
  which the Priority Ducker activates"*; Depth (dB) *"sets the amount of attenuation applied
  to the main input channels when the Priority Ducker is activated"*; Attack Time (ms) =
  *"time it takes the main channel output to fall to 63% of the Depth level"*; Hold Time =
  *"how long the main channel stays at Depth once the Detector level drops below the
  Threshold"*; Release Time = *"time it takes the main channel output to return to 63% of its
  normal level when the Priority Ducker is deactivated"*.
- **Note the 63% semantics** — Q-SYS attack/release are single time constants, not
  full-traverse durations. Ours are full-traverse (see Open questions).

Companion page — *Gate*, Q-SYS Help
<http://help.qsys.com/Content/Schematic_Library/gate.htm>: *"The Threshold level is on the
X axis of the graph"* and *"The Depth is on the Y axis of the graph."* Attack is *"The time
it takes for the output amplitude to rise to equal 63% of the input amplitude once the
Threshold Level is exceeded"*; Hold is *"The minimum time the Gate stays open once it is
opened, or the length of time the Gate stays open after the RMS input level drops below the
Threshold Level"*. **No timeline illustration of the stages.**

### Yamaha — DM3 / DM7 digital mixing consoles

- Doc: *DM3 Reference Manual*, "DYN1 (GATE/DUCKING) screen".
  <https://data.yamaha.com/files/download/other_assets/6/1626436/DM3_RM_En_C0.pdf>
  (HTML edition: <https://manual.yamaha.com/pa/mixers/dm3/rm/en-US/>)
- The DUCKING screen's on-screen furniture, itemised by the manual: `DYN1 Key In level
  meter`, `DYN1 input level meter`, `Threshold slider`, **`GATE/DUCKING graph` —
  *"Displays a visual representation of the GATE/DUCKING level."*** — then `Range`,
  `Attack`, `Decay`, `Hold` sliders, a **`GR (gain reduction) meter`** (*"Displays the amount
  by which the signal's gain is reduced"*) and an `OUT (output) meter`.
- So: **one static level graph, four numeric sliders, and a live GR meter.** The timing
  parameters have no picture.
- Ducking timing wording (note it is the *inverse* of the gate): Attack = *"the time from
  when the input signal exceeds the threshold level until the gate closes"*; Hold = *"the
  waiting time until the gate starts to open after the input signal falls below the threshold
  level"*; Decay = *"the time until the gate opens after the input signal has passed the HOLD
  waiting time"*, and crucially *"The setting value expresses the time required for the level
  to change by 6 dB."* — a **rate**, not a duration.
- Range = *"the amount by which the signal will be lowered when GATE/DUCKING is applied."*
- The channel overview strip carries a separate `GATE gain reduction indicator` —
  *"Displays the amount of gain reduction when the channel GATE/DUCKING is ON."*

- Doc: *DM7 Series Reference Manual*, "DYNAMICS Screen".
  <https://manual.yamaha.com/pa/mixers/dm7/rm/en-US/11049224331.html>
- The dynamics graph *"Displays the input/output characteristics of the dynamics
  processors."* Screen also carries *"Dynamics IN/OUT level meters, GR meter"*.
- DUCKING type: *"reduces the output by a fixed value (Range) when a signal greater than the
  Threshold level is input. This is effective if you want to lower the volume level of
  background music using the Key In Source signal."*

The CL/QL family uses the same DUCKING parameter set (Threshold / Range / Attack / Hold /
Decay) — *CL5/CL3/CL1 Reference Manual*, "Dynamics Parameters"
(<https://data.yamaha.com/files/download/other_assets/1/392941/cl5_3_1_en_rm_d1.pdf>);
not fetched in full here (>10 MB), so treated as corroborating rather than load-bearing.

### Calrec — Brio 36 (broadcast console)

- Doc: *BRIO 36 User Manual*, 926-219 Iss4, "Expander/Gate/Ducker" (pp. 109–113).
  <https://calrec.com/wp-content/uploads/2019/10/Brio-36-User-Manual-926-219-Iss4-Lo.pdf>
- Purpose statement is exactly our use case: *"A ducker is used to reduce the level of a
  signal by the presence of another signal or side chain source. A typical use of this effect
  in a daily radio production routine is for creating a voice-over…"*
- **FIGURE 7 — DUCKER CONTROLS is a control page, not a graph.** Controls listed: Threshold,
  **Depth** (*"Controls the maximum amount of attenuation which can be applied"*), Attack,
  Release, and **Delay** — *"(Gate/Ducker Only): The minimum time the gate or ducker will be
  held open before closing once the threshold is reached"* (i.e. Calrec's name for hold).
  Plus a sidechain Source selector, shown **in red until a source is chosen** — a nice
  precedent for making "this needs a key" visually loud.
- Ranges (Gate/Ducker section of the spec table): Threshold −60 dBFS…−6 dBFS,
  **Depth 40 dB…0 dB**, Attack 50 µs…0.2 s, Release 0 ms…4 s, Delay 0 ms…1 s.
- Live indication is a meter, not a moving graph: *"Input channel, group and main meters all
  include integrated dynamics meters for Exp/ Gate/ Ducker, Comp/Lim 1 and Comp/Lim 2"*.
- Behavioural detail worth knowing: *"Calrec's expander/gate/ducker processing has 6dB of
  built-in hysteresis to avoid unwanted 'chatter'"* — we have no hysteresis; hold is our only
  chatter defence.

### Drawmer DS201 — the ancestor hardware ducker

- Doc: *Drawmer DS201 Operator's Manual* (drawmer.com/op201.htm, archived copy).
  <https://umlsrt.com/StudioDocuments/drawmer%20ds201%20manual.pdf>
- Text-only manual — **no envelope figure at all**, despite the front panel being literally
  Attack/Hold/Decay/Range. This is worth stating plainly: the canonical envelope diagram is
  *not* a Drawmer invention.
- Parameters: Attack *"determines how quickly the gate opens"* (10 µs–1 s); Hold
  *"Determines the amount of time the gate is held open after the signal falls below the
  Threshold"* (2 ms–2 s); Decay *"the rate at which the gate closes, once the signal has
  fallen below the Threshold and the Hold time has expired"* (2 ms–4 s); Range *"the amount of
  attenuation applied to the input signal when the gate is closed"* (0 dB…−80 dB).
- **Envelope-completion rule**, directly relevant to how our diagram should be read:
  *"Since the Hold cycle starts as soon as the Threshold is crossed, the envelope cycle will
  complete even if the Key source falls below the Threshold level before the Attack phase is
  completed."* (And separately: *"Once the gate envelope has been triggered, the attack cycle
  will continue to completion, even if the incoming trigger source is very short."*)
- Ducking guidance that our defaults already follow: *"It is usual to select a fairly fast
  Attack time … with a slow Release time of a second or so - this will bring the music level
  back up slowly and smoothly, and is hence less disconcerting to the listener."*
- **Live indication = LEDs, with a fade**: *"when the input signal falls below the threshold,
  the green LED will extinguish and the amber LED will fade over the duration of the release
  time."* That is the earliest precedent found for animating the release.

### Biamp Tesira — Ducker block

- Doc: *Ducker*, Tesira Help.
  <https://tesira-help.biamp.com/Component_Objects/Audio/Dynamics/Ducker.htm>
- Control dialog parameters: Input Level, Sense Level, Threshold, Ducking Level, Attack Time,
  Release Time, Logic In, Logic Out, Mix Sense, Bypass. **No graph, no envelope diagram, and
  no Hold parameter at all.**
- Wording: Threshold *"determines what sense input signal level will trigger ducking to
  occur"*; Ducking Level *"determines how much attenuation is applied to the input signal when
  ducking is active"*; Attack Time *"determines how quickly the ducker attenuates the input
  signal when ducking is activated"*; Release Time *"determines how quickly attenuation is
  released when ducking is deactivated"*.
- Naming note: the sidechain input is labelled **`S` for "sense"** on the block; the signal
  being ducked is the unlabelled input.

### DSP Concepts Audio Weaver — Ducker module (the DSP under several install-audio platforms)

- Doc: *Ducker*, Audio Weaver Designer 8.D.2.5 documentation.
  <https://documentation.dspconcepts.com/awe-designer/8.D.2.5/ducker>
- Purely textual, **no plot**: *"when the trigger signal or manualTrigger is nonzero, the
  level of the input audio will be changed from 1.0 to duckLevelLinear smoothly, with the time
  constant determined by the attackTime parameter"*, and after *"3\*attackTime + holdTime"* the
  gain returns to 1.0 with the release time constant.
- Two things to note: attack/release are **time constants** (so the audible transition is
  ~3 τ), and **hold is measured from the end of the attack settle**, not from the trigger.

### Ableton Live — Compressor (sidechain ducking) and Gate

- Doc: *Live Audio Effect Reference*, Ableton Reference Manual v12.
  <https://www.ableton.com/en/manual/live-audio-effect-reference/>
- Compressor offers **three displays**, and this is the closest a mainstream DAW gets to
  answering our question:
  - **Transfer Curve** — *"input level horizontally and output level vertically"*, with the
    knee drawn as dotted lines around the threshold. (Level→level, like the consoles.)
  - **Activity** — a **true-time** view: *"The level of the input signal in light gray. In
    this mode, the GR and Output switches toggle between showing the amount of gain reduction
    in orange or the output level in a darker gray."* So gain reduction *is* plotted against
    time — but against **real scrolling time with real audio in it**, not a schematic.
  - Collapsed.
- The manual's ducking example is explicitly voice-over: *"By inserting a Compressor on the
  music track, but select the narration track's output as the external sidechain source"*.
- Gate device parameters (same manual): Lookahead, Attack (*"how long it will take for the
  gate to open after the threshold is reached"*), Hold (*"the minimum time that the gate will
  remain open after the signal exceeds the threshold"*), Release, Flip, and **Return** — a
  hysteresis control that *"moves the gate-on threshold below the gate-off threshold"*.
  **No envelope diagram.**

### FabFilter Pro-G — a gate/expander with the most display of any plugin checked

- Docs: *Overview* <https://www.fabfilter.com/help/pro-g/using/overview>,
  *Time controls, Style and Knee* <https://www.fabfilter.com/help/pro-g/using/timecontrols>
- The centrepiece is a **real-time moving level display**: it shows *"the output level (light
  blue) on top of the input (dark blue), with a 60 dB scale"* and the docs describe it as a
  *"real-time moving level display and the level meter"* that *"show you at a glance what's
  happening to your audio."* Again: real time, real audio.
- Attack: *"sets the speed with which the expander/gate will open when the signal level
  exceeds the threshold."* Hold: *"the minimum time that the gate/expander will remain fully
  opened after the sound level has exceeded the threshold."* Release: *"the time that the
  expander/gate takes to close and reach maximum gain reduction."* Lookahead: *"(often also
  called pre-open) … up to 10 ms before the audio level actually exceeds the threshold."*
- **No envelope diagram accompanies any of these**; the only curve in the plugin is the knee
  transfer curve.

### Devious Machines Duck — the one product that literally draws a ducking envelope

- Doc: *The Duckmentation* (Duck manual).
  <https://deviousmachines.com/manuals/Duck%20Manual.pdf>
- Duck's whole UI *is* a drawn gain envelope: an **Envelope Editor** described as *"The area
  where the you can edit the shape of which the dynamic changes will occur"*, with
  **Breakpoints** (*"A point in the envelope used to control its shape"*), a **Curve Shaper**
  (Smooth / S-Shape / Exponential), a **Grid** (*"Guide for mapping positions as to where
  beats are falling"*), Input and Output level meters flanking it, and a **Playhead** —
  *"Indicates position though the cycle during playback."*
- Toolbar option **"Show sidechain/output on graph"**: *"Duck will default with the output
  enabled. This will show the waveform of the ducked sound"*, and the sidechain button *"will
  show any audio that is routed to the plugin. So, if you route a kick to Duck via sidechain,
  the waveform will appear on the plugin."*
- **Precedents this establishes, and their limits.** It confirms (a) a drawn gain envelope
  with attenuation downward, (b) a moving live marker on that envelope, and (c) a key-signal
  overlay on the same axes. But its time axis is **musical bars, set by a `Speed` control
  (1/4, 1/2, 1 bar, …)** — genuinely linear, repeating time. It has no attack/hold/release
  knobs at all; there is nothing to normalise. So it supports our *elements*, not a
  segmented axis.

### OBS Studio — Compressor filter (its sidechain/ducking path)

- Doc: *Compressor Filter*, OBS Knowledge Base. <https://obsproject.com/kb/compressor-filter>
- Controls only — Ratio, Threshold, Attack, Release, Output Gain, **Sidechain/Ducking
  Source**. **No graph, no envelope diagram, no gain-reduction meter documented.**
- *"Sidechain compression, also known as Ducking, can be used to make room for your voice when
  speaking over-top of music and games by lowering your desktop audio when you speak."*
  Recommended ducking preset: Ratio 32:1, Threshold −36 dB, Attack 100 ms, Release 600 ms.
- Useful as the floor of the design space: the most-used ducking UI on the internet has no
  visualisation at all.

### Apple Logic Pro — Noise Gate

- Doc: *Noise Gate*, Logic Pro effects reference.
  <https://help.apple.com/logicpro/mac/9.1.6/en/logicpro/effects/chapter_4_section_10.html>
  (current edition: <https://support.apple.com/guide/logicpro/use-noise-gate-lgcef1bec259/mac>)
- Threshold, **Reduction** (*"Sets the amount of signal reduction"*), Attack (*"the amount of
  time it takes to fully open the gate after the signal exceeds the threshold"*), Hold
  (*"the amount of time the gate is kept open after the signal falls below the threshold"*),
  Release (*"the amount of time it takes to reach maximum attenuation after the signal falls
  below the threshold"*), Hysteresis (*"the difference (in decibels) between the threshold
  values that open and close the gate"*), Lookahead.
- **No graphical envelope display described.** Note Logic's Attack/Release are
  *full-traverse* durations ("fully open", "maximum attenuation") — the same semantics as our
  `DuckerEnvelope`, and the opposite of Q-SYS's 63%.

### Rane — RaneNote 155, *Dynamics Processors — Technology & Applications*

- Doc: <https://www.ranecommercial.com/legacy/note155.html>
- The nearest thing found to a canonical time-domain gate figure in a manufacturer document:
  **Figure 18, "Conventional Gate Performance"** — amplitude on Y, **time on X**, with the
  gated output traced over the input signal. Figure 19, *"Same Waveform Processed with
  Look-Ahead and Pre-Ramping"*, is the same axes for comparison.
- Text: *"Attack time determines how quickly the gate opens once the control signal exceeds
  the threshold setting"*; *"In gate mode, the release time determines how quickly the gate
  closes as the control signal drops below the threshold setting."*
- **But the figure plots a real waveform in real linear time to make an argument about
  clicks** — it is not a labelled Attack/Hold/Release schematic. Even the closest ancestor
  does not do what we were considering.

---

## What this means for us, concretely

Our plugin already publishes the console/Q-SYS convention and should keep it:
`plugins/audio-processing/engine/dynamicsGraph.ts` gives the ducker `x: 'Key level'`,
`y: 'Program gain'` with a threshold marker on X and a live dot at
`{ x: keyDb, y: gainDb }` — that is structurally identical to the Q-SYS Priority Ducker
Response Graph and to Yamaha's GATE/DUCKING graph. **The envelope graph is an addition, not
a replacement.** The transfer curve answers *how deep and from what level*; the envelope
answers *how fast, and how long after the talker stops* — which is precisely the half no
console draws, and precisely the half our operators tune most.

Two of our semantics differ from some sources and must be said out loud in the labels:

- `duckerEnvelope.ts` ramps by `|floor| / attack` dB per ms — attack and release are
  **full-traverse durations** (Logic/Ableton semantics), not 63% time constants (Q-SYS) and
  not per-6 dB rates (Yamaha DM3). Label them as durations to the floor and back.
- Our hold is measured from the last over-threshold reading (`now - activeMs < hold`), i.e.
  from the key falling below threshold — matching Yamaha/Q-SYS/Drawmer, and *not* matching
  DSP Concepts (hold starts after the attack settles).

---

## Open questions

1. **Is the compressed (`sqrt`) segment width better than equal widths?** No product does
   either, so this is unsourced judgement. Worth a quick side-by-side at our real defaults
   (5 / 250 / 200 ms) and at the extremes (100 / 0 / 5000 ms) before committing. The
   `hold = 0` case in particular needs a decision: collapse the plateau to a vertex, or hold
   a minimum stub and label it `Hold 0 ms`?
2. **Phase reporting for the live dot.** `DuckerEnvelope` currently exposes `gainDb` and
   `key` but not an explicit phase. Adding `phase: 'idle' | 'attack' | 'hold' | 'release'`
   is a small change and is what makes an honest dot possible — but it is a new field on the
   status payload and should go through the same ADR-0007 lens (plugin computes it, UI only
   places it).
3. **Hysteresis.** Calrec ships 6 dB of it, Logic exposes it as a slider, Ableton exposes it
   as `Return`. We have none — hold is our only anti-chatter mechanism. If we ever add it,
   the envelope diagram is where it would be visible (two threshold levels on the key band).
   Out of scope for the graph work, but it is the reason our hold default matters more than
   theirs.
4. **Could the transfer curve simply grow a time dimension instead?** Ableton's Compressor
   solves the same problem by offering *two* displays behind a toggle (Transfer Curve vs
   Activity) rather than merging them. If the settings panel's `graph` widget can host a
   toggle, that is a sourced pattern and may beat inventing a third hybrid.
5. **Unverified in full:** the Yamaha CL/QL "Dynamics Parameters" appendix (PDF exceeded the
   fetch limit; the CL/QL DUCKING parameter set was corroborated only via search snippets and
   by the DM3/DM7 manuals read in full). Also unread: Lawo mc² and Wheatstone console manuals
   — neither surfaced a ducker screen description in first-party documentation during this
   pass, so nothing is claimed about them.
