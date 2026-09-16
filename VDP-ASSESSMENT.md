# VDP assessment: 6502-EMULATOR

> An outline, not a plan. The detailed plan for this repository goes in `VDP-PLAN.md`,
> written in a session of its own. Surveyed 2026-09-16 across the whole workspace.
> Line numbers drift; file and routine names are the durable references.

## The change

The ACE moves from a Pico9918 running stock TMS9918A firmware to the **6502-PICOVDP**
(`6502-PICOVDP/SPEC.md`) on PICO9918 PRO v2.0 hardware, running **BIOS 2.x**. Everything
else stays where it is: COB, DEV, KIM, VCS, PicoCalc, and any ACE whose card cannot be
reflashed (RP2040 pico9918 v1.0–1.3). Those keep the stock firmware and **BIOS 1.x (1.5)**.

- **Legacy** in these documents means TMS9918A + BIOS 1.x. **VDP** means PICOVDP + BIOS 2.x.
- **Compatibility runs one way.** The PICOVDP's legacy submode runs Text and Graphics I
  programs unchanged, so BIOS 1.5 and existing cartridges run on it. Graphics II and
  Multicolor fall back to Graphics I and draw garbage. Register writes above 7 no longer
  alias, so F18A tricks break. Sprites per line are 16 by default, not 4. Nothing written
  for the VDP runs on a TMS9918A.
- **BIOS 2.0 is assumed to be:** BIOS 1.5, plus the NVRAM save slots in
  `6502-BIOS/PLAN.md`, plus the VDP work in this repo's `docs/handoff/6502-BIOS.md`
  (branch `v3-vdp`). Existing jump-table addresses stay put. A later BIOS redesign may
  revise this.

## Decisions already made

- No new repositories.
- **This emulator** makes the video card an option (TMS9918A or PICOVDP): one app, one
  site. It also publishes a frozen 2.6.9 web build at a versioned path for the legacy docs.
- **6502-DOCS** is versioned: legacy docs are frozen at `/6502-DOCS/v1/`, and the main
  site is rewritten for the VDP.
- **6502-BIOS** gets a `v1.x` maintenance branch; `main` becomes 2.x.
- **Assembly and C projects** get a VDP include chosen by a build option, not branches.
- **EhBASIC and vc83basic** stay 1.x. **PicoCalc** stays legacy. **The YouTube series**
  teaches the legacy VDP and mentions the new features.

## Order across the workspace

1. **6502-PICOVDP:** firmware proven on the PRO (its Phases 9–11). This gates the
   hardware switch, not the software work.
2. **6502-EMULATOR:** frozen 2.6.9 web build at `/6502-EMULATOR/v2/`.
3. **6502-DOCS:** `v1` branch published at `/6502-DOCS/v1/`, embeds pinned to step 2.
4. **6502-EMULATOR:** `v3-vdp` merged, with the card as an option; tagged 3.x.
5. **6502-BIOS:** `v1.x` cut; 2.0 built on `main`. This can start any time, because the
   `v3-vdp` emulator already runs the PICOVDP.
6. **6502-ASM** sets the VDP include convention. 6502-CRT, 6502-PRG, 6502-BIN and 6502-C
   follow it.
7. The emulator bundles BIOS 2.0. 6502-DOCS `main` is rewritten. 6502-ACE, bastok,
   WIZARDSLAB, 6502-EHBASIC, vc83basic and 6502-ASSEMBLY follow.

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

### A. Frozen legacy web build (before anything merges to `main`)

- Extend `.github/workflows/deploy.yml` to also build tag `v2.6.9`'s web app into
  `dist/web/v2/`, one Pages artifact holding both. The URL becomes
  `https://acwright.github.io/6502-EMULATOR/v2/embed.html`.
- `vite.web.config.ts` hard-codes `base: '/6502-EMULATOR/'`, and a tag cannot be edited.
  Pass `--base /6502-EMULATOR/v2/` to `vite build` for that build, then confirm that
  `embed.html`, `embed.js` and the ROM fetch all honour it.
- 6502-DOCS's `v1` branch points its embeds here. This URL is a contract: never move it.

### B. Browser storage on a shared origin

- Every `acwright.github.io` Pages site shares one origin. `persistence.ts` uses IndexedDB
  `6502-emulator` and localStorage `6502-emulator-nvram`. Those names would be shared by
  the frozen build, the new build and every DOCS embed.
- The frozen build cannot change, so the new build must namespace its storage (by card
  and/or version) or ignore records it cannot use. `data/emulator.json` in 6502-DOCS
  already documents the shared-origin hazard for `persist`.

### C. The video card as an option (the `v3-vdp` merge)

- **Two cards.** Bring back the TMS9918A implementation (`Video.ts` as of v2.6.9) as a
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
- **ROM follows the card.** Bundle BIOS 1.5 and, once released, BIOS 2.x.
  - `BIOS.bin` is currently bundled twice (`assets/roms/`, `src/renderer/public/roms/`),
    and `BundledROM.test.ts` checks the copies match. That becomes two ROMs in two places.
  - Until BIOS 2.0 exists, both cards boot 1.5, which the legacy submode supports.
- **Snapshots.** Record which card a snapshot holds, and load version 1 (TMS9918A)
  snapshots into the TMS9918A card instead of refusing them.
- **Tests.**
  - Keep the 2.x goldens (captured in `bdd1a1e` before the rewrite) running against the
    TMS9918A card, and the 3.x goldens against the PICOVDP.
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

### D. After BIOS 2.0

- Bundle the 2.0 ROM for the PICOVDP card and re-capture the `bios/` goldens in a commit
  of their own.
- The hardware scroll's acceptance test: the `bios/scroll` *index frame* stays
  byte-identical (see the BIOS handoff §4).

## Contracts with other repositories

| Repository | Contract | What breaks |
|---|---|---|
| 6502-PICOVDP (`~/Developer/C/6502-PICOVDP`) | `tools/sync-oracle.mjs` requires this repo on branch `v3-vdp`. `host/node/Video.cjs` stands in for `src/core/IO/Video` via `jest.picovdp.cjs` | Merging the branch, or renaming or moving `Video.ts`. Coordinate the change and re-sync the oracle |
| 6502-DOCS (`~/Developer/NodeJS/6502-DOCS`) | `data/emulator.json` (version, frame URL, embed parameters); `verify.yml` `EMULATOR_REF`; headless `dbg` commands | Any embed parameter change; the frozen URL; the default card |
| 6502-BIOS (`~/Developer/Assembly/6502-BIOS`) | `ci.yml` `EMULATOR_REF: v2.6.0`; the bundled ROM and `bios/` goldens | 2.x CI needs a 3.x tag with the PICOVDP card selectable from the CLI. `v1.x` CI stays on the TMS9918A card |
| WIZARDSLAB (`~/Developer/Assembly/WIZARDSLAB`) | Its debug cartridge is committed here as a fixture; `make playtest` and `run-AC6502` drive the CLI | The default card, CLI flags |
| 6502-ASM, CRT, PRG, BIN, C | `make run` calls `6502 run` | VDP builds need the card flag |
| 6502-KIMULATOR | `CPU.ts` and related files are byte-identical | Nothing, if the ground rules hold |

## Questions for VDP-PLAN.md

1. The name and values of the card option, identical across the CLI, settings and embed
   parameter.
2. The default card, and when it flips.
3. The storage namespacing scheme.
4. Which copy of the VDP spec is canonical: `6502-PICOVDP/SPEC.md` or `docs/VDP-SPEC.md`.
5. The frozen build's path: `/v2/` (this repo's major version) or `/legacy/`. 6502-DOCS
   needs the answer early.
6. Whether legacy fixes ever go to the frozen build (recommendation: no; fix the
   TMS9918A card in 3.x instead).
