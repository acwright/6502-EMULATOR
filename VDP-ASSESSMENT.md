# VDP assessment: 6502-EMULATOR

> An outline, not a plan. The detailed plan for this repository goes in `VDP-PLAN.md`,
> written in a session of its own. Surveyed 2026-09-16 across the whole workspace.
> Line numbers drift; file and routine names are the durable references.

## The change

The ACE moves from a Pico9918 running stock TMS9918A firmware to the **6502-PICOVDP**
(`6502-PICOVDP/SPEC.md`) on PICO9918 PRO v2.0 hardware, running **BIOS 2.x**. Everything
else stays where it is: COB, DEV, KIM, VCS, PicoCalc, and any ACE whose card cannot be
reflashed (RP2040 pico9918 v1.0–1.3). Those keep the stock firmware and **BIOS 1.x**,
whose last release is **1.6**.

- **Legacy** in these documents means TMS9918A + BIOS 1.x. **VDP** means PICOVDP + BIOS 2.x.
- **Compatibility runs one way.** The PICOVDP's legacy submode runs Text and Graphics I
  programs unchanged, so BIOS 1.x and existing cartridges run on it. Graphics II and
  Multicolor fall back to Graphics I and draw garbage. Register writes above 7 no longer
  alias, so F18A tricks break. Sprites per line are 16 by default, not 4. Nothing written
  for the VDP runs on a TMS9918A.

## Decisions already made

- **No new repositories.**
- **BIOS 1.6 is the last 1.x release.** It is 1.5 plus the NVRAM save slots in
  `6502-BIOS/PLAN.md`, and nothing else. It ships in emulator **2.7.0**, and the frozen
  legacy docs document it.
- **BIOS 2.0 is 1.6 plus:**
  - The PICOVDP work in `6502-EMULATOR`'s `docs/handoff/6502-BIOS.md` (branch `v3-vdp`):
    card detection, hardware scroll, port B for interrupt handlers, `WaitVBlank`.
  - A console in the PICOVDP's **Text mode** (`VMODE $1`, 40×24, 6×8 cells) with a
    **per-cell colour table**. It keeps the same font and every screen layout.
  - **No Monitor.** The machine **boots straight to BASIC**, with a new header and a colour
    logo drawn from the font's CP437 block characters. Wozmon stays at `$FF00`.
  - **The font lives in the PICOVDP firmware.** The card loads it into VRAM at reset and
    on command (a new register and a capability bit, SPEC draft 0.5). ROM `$B800` holds
    no font on 2.x.
  - **ROM layout:** BASIC takes the Monitor's 4.3 KB (`$C000–$FEFF`), and the Kernal takes
    all of `$A000–$BFFF`, including the space the font used. Nothing the Kernal needs goes
    above `$C000`, because cartridges overlay `$C000–$FFFF`. The Kernal holds the
    primitives cartridges need; BASIC-only work lives in BASIC.
  - **No TMS9918A support.** BIOS 2.x runs only with a PICOVDP, with no fallback paths.
  - **New BASIC commands with matching Kernal entries.**
    - Core: `SCREEN`, `VPOKE`/`VPEEK`, `VREG`, `PALETTE`, `VSYNC`, `VLOAD`.
    - Second tier, if room is found: `SPRITE`, `SCROLL`, `LAYER`, `VSTAT`.
    - Save-slot commands, if room is found.
    - `SYS addr[,a,x,y]`, and `BLOAD`/`BSAVE` over XModem when given no filename.
    - BASIC returns to the text console when a program stops.
  - **Tokens:** every 1.x token keeps its value, and new keywords are appended after `$D4`.
    The `BRK` statement is retired and its token `$B4` goes to a new keyword.
  - **A BRK instruction** prints `BREAK $nn AT $xxxx  A= X= Y= P= S=` and warm-starts
    BASIC. `BRK_PTR` stays hookable.
  - **`COLOR fg[,bg[,border]]`** sets the pen for later output, `CLS` fills the screen with
    it, and `border` is register 7's low nibble.
  - **Existing jump-table addresses do not move.** New entries are appended.
- **6502-EMULATOR** makes the video card an option (TMS9918A or PICOVDP): one app, one
  site. It also publishes a frozen **2.7.0** web build at `/6502-EMULATOR/v2/` for the
  legacy docs.
- **6502-DOCS** is versioned: legacy docs (BIOS 1.6) are frozen at `/6502-DOCS/v1/`, and
  the main site is rewritten for the VDP and BIOS 2.x.
- **6502-BIOS** gets a `v1.x` branch cut at `v1.6`; `main` becomes 2.x.
- **Assembly and C projects** get a VDP include chosen by a build option, not branches.
  The legacy `6502.inc` gets one last update, for 1.6.
- **EhBASIC and vc83basic** stay 1.x. **PicoCalc** stays legacy. **The YouTube series**
  teaches the legacy VDP and mentions the new features.

## Order across the workspace

**Part 1: BIOS 1.6, the last legacy release**

1. **6502-BIOS:** build 1.6 on `main`, tag `v1.6`, and cut `v1.x` from it.
2. **6502-EMULATOR `main`:** bundle 1.6, re-capture the `bios/` goldens (the splash says
   v1.6), and release **2.7.0**. Then merge `main` into `v3-vdp` and re-capture there.
3. **6502-PICOVDP:** re-sync `tests/oracle/`, whose pinned `bios` goldens moved.
4. **The legacy include** gains the NVRAM entries in every copy: 6502-ASM, 6502-CRT,
   6502-PRG, 6502-BIN, 6502-EHBASIC, 6502-C (with `6502.h`) and WIZARDSLAB.
5. **6502-DOCS `main`** documents 1.6 and pins 2.7.0. Then it cuts `v1`, published at
   `/6502-DOCS/v1/`, against the emulator's frozen 2.7.0 build at `/6502-EMULATOR/v2/`.

**Part 2: the VDP**

6. **6502-PICOVDP:**
   - SPEC draft 0.5 adds the built-in font and its load command. The emulator's PICOVDP
     card implements it first, then the firmware.
   - Firmware proven on the PRO (its Phases 9–11) gates the hardware switch, not the
     software work.
7. **6502-EMULATOR:** `v3-vdp` merged, with the card as an option; tagged 3.x.
8. **6502-BIOS:** 2.0 on `main`. This can start once step 1 is done, because the `v3-vdp`
   emulator already runs the PICOVDP. Its console work needs the built-in font in the
   emulator (step 6).
9. **6502-ASM** sets the VDP include convention. 6502-CRT, 6502-PRG, 6502-BIN and 6502-C
   follow it.
10. **Everything else follows BIOS 2.0:**
    - The emulator bundles BIOS 2.0.
    - 6502-DOCS `main` is rewritten.
    - bastok gains the 2.x token table.
    - 6502-ACE, WIZARDSLAB, 6502-EHBASIC, vc83basic, cffs and 6502-ASSEMBLY follow.

---

## This repository's role

- The reference implementation of the PICOVDP. The firmware is held to its goldens.
- The machine every other repo tests against: BIOS CI, DOCS samples and screenshots,
  WIZARDSLAB playtests, and the `run` targets in the assembly projects.
- The web host for both the current emulator and the frozen legacy one.

## Where it stands

- `main` is 2.6.9 (tagged). `v3-vdp` is 35 commits ahead: `src/core/IO/Video.ts`
  rewritten as the PICOVDP, snapshot version 2, `dbg video`, `--screenshot`, samples
  `vdp-modes/` and `vdp-layers/`. `package.json` there says 3.0.0, but nothing is tagged.
- On the branch, `README.md` and `docs/MIGRATING.md` say "the TMS9918A is gone". That
  becomes untrue once the card is an option.
- The branch's `PLAN.md` Appendix A lists the 11 files that touch the card, and the
  public API that changed shape.
- `docs/handoff/6502-BIOS.md` and `docs/handoff/6502-DOCS.md` are the starting inventories
  for those repositories' plans.

## Work outline

### A. Release 2.7.0 with BIOS 1.6 (on `main`, before anything else merges)

- Bundle 6502-BIOS `v1.6` in both places (`assets/roms/`, `src/renderer/public/roms/`).
  `BundledROM.test.ts` checks that they match.
- Re-capture the `bios/` goldens in a commit of their own. The splash reads v1.6.
- Check `BIOS.test.ts`, `HeadlessHost.test.ts` and `Snapshot.test.ts` for moved cycle
  counts.
- The README and docs name BIOS 1.6. Tag and release **2.7.0**. It is the last 2.x release
  and the legacy docs' emulator.
- Merge `main` into `v3-vdp`, re-capture its goldens, and tell 6502-PICOVDP to re-sync its
  oracle.

### B. Frozen legacy web build (from the 2.7.0 tag)

- Extend `.github/workflows/deploy.yml` to also build tag `v2.7.0`'s web app into
  `dist/web/v2/`, one Pages artifact holding both. The URL becomes
  `https://acwright.github.io/6502-EMULATOR/v2/embed.html`.
- `vite.web.config.ts` hard-codes `base: '/6502-EMULATOR/'`, and a tag cannot be edited.
  Pass `--base /6502-EMULATOR/v2/` to `vite build` for that build, then confirm that
  `embed.html`, `embed.js` and the ROM fetch all honour it.
- 6502-DOCS's `v1` branch points its embeds here. This URL is a contract: never move it.

### C. Browser storage on a shared origin

- Every `acwright.github.io` Pages site shares one origin. `persistence.ts` uses IndexedDB
  `6502-emulator` and localStorage `6502-emulator-nvram`. Those names would be shared by
  the frozen build, the new build and every DOCS embed.
- The frozen build cannot change, so the new build must namespace its storage (by card
  and/or version) or ignore records it cannot use. `data/emulator.json` in 6502-DOCS
  already documents the shared-origin hazard for `persist`.

### D. The video card as an option (the `v3-vdp` merge)

- **Two cards.** Bring back the TMS9918A implementation (`Video.ts` as of v2.7.0) as a
  second card beside the PICOVDP.
  - `Machine.configure` already accepts any card in `io8` via `SlotConfig`.
  - `Machine.video()` uses `instanceof Video`, so the host, debug server and renderer need
    a common interface. Appendix A is the list of files.
- **Where the choice is made:**
  - CLI: `6502 run`, and the `--console video --screenshot` checks.
  - Electron and web: `SettingsPanel.vue`.
  - Embed query parameter: `src/renderer/src/embed/params.ts`, the contract 6502-DOCS
    validates.
  - The debug protocol: `dbg video` and `dbg screen text` for both cards.
  - `src/lib.ts` exports.
- **ROM follows the card.** Bundle BIOS 1.6 and, once released, BIOS 2.x.
  - `BIOS.bin` is currently bundled twice (`assets/roms/`, `src/renderer/public/roms/`),
    and `BundledROM.test.ts` checks the copies match. That becomes two ROMs in two places.
  - Until BIOS 2.0 exists, both cards boot 1.6, which the legacy submode supports.
  - BIOS 2.x on the TMS9918A card is unsupported (6502-BIOS decision). The settings
    should not offer that pairing by default.
- **Snapshots.** Record which card a snapshot holds, and load version 1 (TMS9918A)
  snapshots into the TMS9918A card instead of refusing them.
- **Tests.**
  - Keep the 2.x goldens (as re-captured for 1.6 in 2.7.0) running against the TMS9918A
    card, and the 3.x goldens against the PICOVDP.
  - The old `Video.test.ts` comes back for the legacy card.
  - `test:conformance` and the KIMULATOR-synced files stay untouched (`CLAUDE.md`).
- **Default card.** Recommendation: TMS9918A stays the default until the ACE switchover
  (firmware proven, BIOS 2.0 released), then flips in a release of its own. That keeps
  unpinned embeds and scripts stable in the meantime.
- **Electron.** One app. `appId`, `productName` and install location stay the same.
- **Docs in this repo.**
  - Rewrite `README.md` and `docs/MIGRATING.md` as "3.0 adds a card".
  - Update `AGENTS.md`, `DEBUG-PROTOCOL.md` and `EMBEDDING.md` for the card selector.
  - `docs/VDP-SPEC.md` duplicates `6502-PICOVDP/SPEC.md`. Settle which is the source and
    which is the copy.
- **Handoffs.** Decide whether `docs/handoff/` merges to `main` or retires once the BIOS
  and DOCS plans have absorbed it.

### E. The built-in font (SPEC draft 0.5, on `v3-vdp` before BIOS 2.0's console work)

- The PICOVDP card writes the font into VRAM at reset and implements the load command,
  the completion rule and the `STAT6` bit, exactly as 6502-PICOVDP's SPEC draft 0.5 sets
  them. This is the reference implementation, so it lands before the firmware's.
- The font's bytes come from 6502-PICOVDP's font source, synced the way the oracle is,
  never retyped. They are the same bytes as `6502-BIOS/Chars.asm`.
- Goldens: boots with BIOS 1.6 overwrite the font during `InitVideo`, so they should not
  move. Add goldens of their own for the reset state and the load command.
- `dbg video` shows the font capability; `VDP-SPEC.md` follows draft 0.5.

### F. After BIOS 2.0

- Bundle the 2.0 ROM for the PICOVDP card and re-capture the `bios/` goldens in a commit
  of their own. **All of them move:** 2.0 uses Text mode with per-cell colour, a new
  header, no boot menu and a hardware scroll.
  - The handoff's "`bios/scroll` index frame stays byte-identical" test no longer applies
    as written.
  - Instead, compare 2.0's scroll against 2.0 drawing the same text without scrolling.
- **Boot straight to BASIC.**
  - Anything that waits for or answers the splash and menu (goldens capture scripts, the
    README's power-on description, "ESC at the splash drops into the Monitor") is updated.
  - The pending-program fixup still hooks BASIC's initialisation.
- **No Monitor.** README sections and debug docs that mention it apply to the TMS9918A
  card with BIOS 1.6 only.
- **Snapshots and headless runs** that boot to `OK` get faster. Check timeouts and cycle
  counts in tests.
- 6502-PICOVDP re-syncs its oracle after this re-capture as well.

## Contracts with other repositories

| Repository | Contract | What breaks |
|---|---|---|
| 6502-PICOVDP (`~/Developer/C/6502-PICOVDP`) | SPEC draft 0.5 and the font source (E). `tools/sync-oracle.mjs` requires this repo on branch `v3-vdp`. `host/node/Video.cjs` stands in for `src/core/IO/Video` via `jest.picovdp.cjs` | Any `bios/` golden re-capture (1.6, 2.0); merging the branch; renaming or moving `Video.ts`. Coordinate and re-sync the oracle |
| 6502-DOCS (`~/Developer/NodeJS/6502-DOCS`) | `data/emulator.json` (version, frame URL, embed parameters); `verify.yml` `EMULATOR_REF`; headless `dbg` commands | Any embed parameter change; the frozen URL; the default card |
| 6502-BIOS (`~/Developer/Assembly/6502-BIOS`) | `ci.yml` `EMULATOR_REF: v2.6.0`; the bundled ROM and `bios/` goldens | 1.6 lands in 2.7.0. 2.x CI needs a 3.x tag with the PICOVDP card selectable from the CLI. `v1.x` CI stays on 2.7.0 |
| WIZARDSLAB (`~/Developer/Assembly/WIZARDSLAB`) | Its debug cartridge is committed here as a fixture; `make playtest` and `run-AC6502` drive the CLI | The default card, CLI flags |
| 6502-ASM, CRT, PRG, BIN, C | `make run` calls `6502 run` | VDP builds need the card flag |
| 6502-KIMULATOR | `CPU.ts` and related files are byte-identical | Nothing, if the ground rules hold |

## Questions for VDP-PLAN.md

1. The name and values of the card option, identical across the CLI, settings and embed
   parameter.
2. The default card, and when it flips.
3. The storage namespacing scheme.
4. Which copy of the VDP spec is canonical: `6502-PICOVDP/SPEC.md` or `docs/VDP-SPEC.md`.
5. Whether 2.7.0 also carries anything else, or only BIOS 1.6.
6. The frozen build's path: `/v2/` (this repo's major version) or `/legacy/`. 6502-DOCS
   needs the answer early.
7. Whether legacy fixes ever go to the frozen build (recommendation: no; fix the
   TMS9918A card in 3.x instead).
