# VDP plan: 6502-EMULATOR

> **Part 1 of the VDP rollout:** BIOS 1.6, release 2.7.0, and the frozen legacy web build.
> Part 2 (the `v3-vdp` merge with the video card as an option) will be added to this file
> later. The decisions and the order across the workspace are in
> [VDP-ASSESSMENT.md](VDP-ASSESSMENT.md). Written 2026-09-16 from `main` at `a75d548`
> (v2.6.9) and `v3-vdp` at `5ebd962`. Line numbers drift; file and routine names are the
> durable references.

---

## 1. Goal

2.7.0 is the last 2.x release. It is 2.6.9 plus the BIOS 1.6 ROM, and nothing else. Its
web build is published permanently at `https://acwright.github.io/6502-EMULATOR/v2/`, for
6502-DOCS's frozen `v1` docs.

### Definition of done

- `main` bundles 6502-BIOS `v1.6` in both places, `npm test`, `npm run typecheck` and
  `bash examples/run-all.sh` pass, and the docs name BIOS v1.6.
- Tag `v2.7.0` is pushed, and GitHub release `v2.7.0` has the four desktop artifacts.
- `deploy.yml` on `main` publishes one Pages artifact: `main` at `/6502-EMULATOR/` and tag
  `v2.7.0` at `/6502-EMULATOR/v2/`. `/v2/embed.html` boots to a v1.6 splash, and every
  request it makes stays under `/6502-EMULATOR/v2/`.
- `main` is merged into `v3-vdp`, its goldens and traces are re-captured in commits of their
  own, and the branch is pushed with a clean tree.
- 6502-PICOVDP, 6502-DOCS and 6502-BIOS have been told what moved (§8).

---

## 2. Facts that shape this plan

Checked against the repository, not assumed.

- **`main` has no goldens.** `scripts/capture-goldens.mjs`, `src/tests/goldens/` and the
  `capture:goldens` / `record:traces` scripts exist only on `v3-vdp`. The assessment's
  "re-capture the `bios/` goldens on `main`" therefore happens only after the merge (§7).
  On `main`, the tests that boot the bundled ROM are the whole check.
- **The tests that boot the bundled ROM on `main` pin no exact cycle counts:**
  - `src/tests/BIOS.test.ts` reads `src/renderer/public/roms/BIOS.bin`, polls with a
    20,000,000-cycle ceiling (`MAX_WAIT_CYCLES`), and hard-codes only `HW_PRESENT = $030D`
    and `BAS_TXTTAB..BAS_STREND = $035D..$0363`. BIOS 1.6 adds only `NV_ID = $0390` in the
    free `$0390-$03FF` range (6502-BIOS `PLAN.md` §2), so these should hold. Verify in §4.
  - `src/tests/host/HeadlessHost.test.ts` reads `assets/roms/BIOS.bin` and asserts
    `cycles < BOOT_BUDGET` (3,000,000) and `>= 100_000`, which are bounds, not values.
  - `src/tests/debug/Snapshot.test.ts` boots the ROM and compares snapshots with
    themselves. Its ROM-mismatch tests patch the ROM they loaded, so they do not care
    which ROM it is.
  - `src/tests/BundledROM.test.ts` checks that the two copies match, are 32,768 bytes, and
    contain `/6502 BIOS v\d+\.\d+/`.
- **Documented cycle counts that may move** (prose, not asserted):
  - `docs/AGENTS.md:79`: `"cycles":449280`
  - `docs/AGENTS.md:151`, `README.md:361` and `examples/03-snapshot-per-test.sh:6`: 5,359,120
  - `examples/06-test-suite.sh:49`: "5.36 million"
  - `README.md:358` and `HeadlessHost.test.ts:23`: "450,000" and "about 450k"
  - `docs/AGENTS.md:230`: `441480`, for a `tests.bin` that is not in the repository, so it
    cannot be re-measured. Leave it.

  BIOS 1.6 moves Kernal code that follows `RtcWriteNVRAMImpl`, and adds instructions to
  `ProbeRTC` (the BME fix), which runs on every boot. Expect a small change.
- **BIOS version strings on `main`:** `README.md:29` (the splash) and the
  `BIOS.test.ts:382` comment. `docs/` has none.
- **Release mechanics** (from `git log main` and `gh release view v2.6.9`):
  - The release commit is titled `Release vX.Y.Z` and touches only `package.json` and
    `package-lock.json`. Its body is the release summary.
  - Tags are lightweight, on the release commit. There is no CHANGELOG.
  - The artifacts are built locally with `npm run dist` (mac via electron-builder with
    notarization, win via `scripts/dist-win.sh`, linux via Docker in
    `scripts/dist-linux.sh`). They are uploaded to a GitHub release titled `vX.Y.Z`.
    Its notes are a summary, `---`-separated sections, a `### Downloads` list, and a line
    saying whether the change is live on the web build.
  - `ci.yml` runs on pushes to `main` and on PRs. `deploy.yml` runs on pushes to `main` and
    on `workflow_dispatch`. Pages is `build_type: workflow`.
- **The web build honours Vite's base.** Verified by building an export of `main` with
  `vite build --config vite.web.config.ts --base /6502-EMULATOR/v2/`:
  - `index.html` and `embed.html` reference only `/6502-EMULATOR/v2/assets/...`.
  - The ROM fetch (`useDefaultBIOS.ts:15`) and the audio worklet (`useAudio.ts:394`) use
    `import.meta.env.BASE_URL` and compile to `/6502-EMULATOR/v2/roms/BIOS.bin` and
    `/6502-EMULATOR/v2/audio-worklet-processor.js`.
  - `public/embed.js` derives its base from `document.currentScript.src`
    (`embed.js:32`), so `/v2/embed.js` makes `/v2/embed.html` frames. Its only literal
    `/6502-EMULATOR/` is in a comment.
  - There are no web fonts, `url()`s, workers, service workers, router or manifest in
    `src/renderer`.
  - `vite.web.config.ts` sets `outDir` with `resolve('dist/web')`, which is relative to the
    working directory, so a build run in another checkout writes into that checkout.
- **6502-PICOVDP's oracle pin:**
  - `tools/lib/emulator.mjs` fixes `EMULATOR_BRANCH = 'v3-vdp'` and the path
    `../../NodeJS/6502-EMULATOR`, which `PICOVDP_EMULATOR` overrides.
  - `tools/sync-oracle.mjs` refuses a dirty tree using `git status --porcelain`, which
    lists untracked files too. **Any uncommitted file, this plan included, blocks the sync.**
  - `tests/oracle/manifest.json` pins `v3-vdp` at `8e40c0cb636b96db675a664687478218314bbe63`.
- **Every golden fixture boots the bundled BIOS** (`src/tests/goldens/fixtures.js`: `rom:
  'src/renderer/public/roms/BIOS.bin'` for `bios`, `wizardslab`, `vdp-modes` and
  `vdp-layers`). The three cartridges call `KernalInit` (`$A078`), which runs `ProbeRTC`.
  So the non-`bios` fixtures could move as well, not only `bios`.
- **Local state:** `v3-vdp` is 3 commits ahead of `origin/v3-vdp` (the assessment
  commits). 6502-BIOS has no `v1.6` tag yet, and its `BIOS.inc` still says 1.5.

---

## 3. Preconditions

1. 6502-BIOS tag `v1.6` exists and is pushed, its CI is green, and `v1.x` is cut from it.
2. `git -C ~/Developer/Assembly/6502-BIOS show v1.6:BIOS.inc` has `BIOS_VERSION_MINOR = 6`,
   and `HW_PRESENT` / `BAS_TXTTAB`..`BAS_STREND` still at `$030D` / `$035D`..`$0363`.
3. Take exactly one file from the tag: `BIOS.bin` (tracked in 6502-BIOS). Record its SHA-256
   for the release notes and §8.
4. The emulator's working tree is clean. This `VDP-PLAN.md` is committed on `v3-vdp`, so
   `git switch main` takes it out of the working tree. Read it there with
   `git show v3-vdp:VDP-PLAN.md`, or keep a second worktree on `v3-vdp`.

---

## 4. Bundle BIOS 1.6 on `main`

1. `git switch main && git pull --ff-only`.
2. Copy the ROM into both paths:

   ```sh
   BIOS=~/Developer/Assembly/6502-BIOS
   git -C "$BIOS" show v1.6:BIOS.bin > assets/roms/BIOS.bin
   cp assets/roms/BIOS.bin src/renderer/public/roms/BIOS.bin
   ```

3. Check the image before running anything:

   ```sh
   cmp assets/roms/BIOS.bin src/renderer/public/roms/BIOS.bin
   grep -a -o '6502 BIOS v1\.6' assets/roms/BIOS.bin       # exactly one hit
   xxd -s 0x209F -l 18 assets/roms/BIOS.bin                  # six 4C xx xx JMPs ($A09F-$A0B0)
   # $A000-$A09E (the 1.5 jump table) must be byte-identical to the ROM being replaced
   diff <(git show HEAD:assets/roms/BIOS.bin | xxd -s 0x2000 -l 159) <(xxd -s 0x2000 -l 159 assets/roms/BIOS.bin)
   ```

4. Edit the version text:
   - `README.md:29`: `v1.5` → `v1.6`.
   - `src/tests/BIOS.test.ts:382` comment: `bundled BIOS v1.5` → `bundled BIOS v1.6`.
5. Run `npm run typecheck`, `npm test` and `bash examples/run-all.sh`.
   - **Should pass unchanged:** `BundledROM`, `BIOS`, `HeadlessHost`, `Snapshot`, and
     `cli/dbg/Commands` (its snapshot test rewrites the CRC itself).
   - **If `BIOS.test.ts` fails on an address**, 1.6 moved a variable, contrary to its
     PLAN.md. Stop and take it to 6502-BIOS. Do not re-pin the test.
   - Conformance is not implicated, because no CPU change is involved.
6. Re-measure the documented cycle counts (§2) with `npm run build:cli` and then:

   ```sh
   printf '\rPRINT 6*7\r' | ./bin/6502 run --headless --exit-on 'OK[\s\S]*OK' --timeout 20s --json
   ./bin/6502 run --headless --exit-on 'OK' --timeout 30s --json   # countdown boot
   ```

   The first gives `AGENTS.md:79`, and the approximate "450,000" / "about 450k". The
   second gives 5,359,120 and "5.36 million". If a number changed, update every place it
   appears. If a command no longer reproduces the documented number *on 1.5* (check with
   `git stash` first), say so in the commit instead of guessing.
7. Commit on its own: **"Bundle BIOS v1.6"**. In the body, say what 1.6 adds (six NVRAM
   save-slot entries at `$A09F`–`$A0AE`, and the `ProbeRTC` BME fix), give the ROM's
   SHA-256 and the 6502-BIOS tag, and name any doc numbers that moved.
8. Push `main`. CI (`ci.yml`) must be green before §5. The deploy that follows publishes
   1.6 at `/6502-EMULATOR/` ahead of the release. That matches past practice (ROM bumps
   were not release commits).

---

## 5. Release 2.7.0

### Checklist

1. `npm version 2.7.0 --no-git-tag-version`. Only `package.json` and `package-lock.json`
   change.
2. Commit **"Release v2.7.0"**. The body is the release summary, in the style of `a75d548`:
   - BIOS 1.6: NVRAM save slots, with six Kernal entries appended; no existing address
     moved.
   - The `ProbeRTC` fix: a clock card left with BME set is found again.
   - This is the last 2.x release. Its web build is kept at `/6502-EMULATOR/v2/` for good.
   - **Snapshots taken against the 1.5 ROM are refused** ("different ROM",
     `src/debug/Snapshot.ts`). Load them with `6502 dbg state load --force`, or re-take
     them.
3. `git tag v2.7.0` (lightweight, like `v2.6.9`), then `git push origin main v2.7.0`.
4. Record `git rev-parse v2.7.0`. It goes into `deploy.yml` as `LEGACY_SHA` (§6).
5. `npm run dist`: `dist:mac` (needs the notarization credentials), `dist:win`, and
   `dist:linux` (needs Docker running). The expected artifacts, from `electron-builder.yml`
   and the v2.6.9 release, are:
   - `6502-emulator-2.7.0-mac-arm64.dmg`
   - `6502-emulator-2.7.0-win-x64.exe`
   - `6502-emulator-2.7.0-linux-x86_64.AppImage`
   - `6502-emulator_2.7.0_amd64.deb`
6. Smoke-test the mac build: launch it, see the splash read `-- 6502 BIOS v1.6 --`, reach
   `OK`, and run `6502 --version` from the bundled CLI shim.
7. `gh release create v2.7.0 --title v2.7.0 --notes-file <notes.md> dist/<the four files>`.
   The notes follow v2.6.9's shape: summary, `---` sections (what 1.6 adds, the snapshot
   note, the frozen web build), `### Downloads`, and "live at
   https://acwright.github.io/6502-EMULATOR/ as well".
8. Optional: add a repository ruleset that blocks updating or deleting tag `v2.7.0`. It is a
   URL contract (§6), and `LEGACY_SHA` only detects a moved tag after the fact.

**2.7.0 carries nothing else.** That answers assessment question 5. Storage stays as it is
(§9), and the deploy change lands after the tag (§6), so the tag stays the plain 2.x line.

---

## 6. The frozen legacy web build

### Why it lands after the tag, in its own commit

- The workflow checks out `v2.7.0`, so the tag must exist first.
- The tag's own `deploy.yml` never runs again (it triggers on pushes to `main`), so
  nothing is lost by keeping the change out of it.

### `.github/workflows/deploy.yml` changes (on `main`)

```yaml
env:
  # The legacy docs (6502-DOCS `v1`) embed this build at /6502-EMULATOR/v2/. The URL
  # is a contract: never change LEGACY_REF, LEGACY_SHA or LEGACY_BASE.
  LEGACY_REF: v2.7.0
  LEGACY_SHA: <git rev-parse v2.7.0>
  LEGACY_BASE: /6502-EMULATOR/v2/

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Check out the frozen 2.x release
        uses: actions/checkout@v4
        with:
          ref: ${{ env.LEGACY_REF }}
          path: legacy

      - name: Check the frozen tag has not moved
        run: |
          actual=$(git -C legacy rev-parse HEAD)
          if [ "$actual" != "$LEGACY_SHA" ]; then
            echo "::error::$LEGACY_REF is $actual, expected $LEGACY_SHA"; exit 1
          fi

      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: npm
          cache-dependency-path: |
            package-lock.json
            legacy/package-lock.json

      - name: Install dependencies
        run: npm ci
        env:
          ELECTRON_SKIP_BINARY_DOWNLOAD: '1'

      - name: Build web
        run: npm run build:web

      - name: Install dependencies (frozen 2.x)
        working-directory: legacy
        run: npm ci
        env:
          ELECTRON_SKIP_BINARY_DOWNLOAD: '1'

      # vite.web.config.ts hard-codes base '/6502-EMULATOR/' and the tag cannot be
      # edited; the CLI flag overrides it. Output goes to legacy/dist/web.
      - name: Build web (frozen 2.x)
        working-directory: legacy
        run: npm run build:web -- --base "$LEGACY_BASE"

      - name: Assemble the site
        run: |
          test ! -e dist/web/v2
          cp -R legacy/dist/web dist/web/v2

      - name: Check the frozen build
        run: |
          grep -q '/6502-EMULATOR/v2/assets/' dist/web/v2/index.html
          grep -q '/6502-EMULATOR/v2/assets/' dist/web/v2/embed.html
          grep -a -q '6502 BIOS v1\.6' dist/web/v2/roms/BIOS.bin
          leaks=$(grep -rl --include='*.html' --include='*.js' '/6502-EMULATOR/[^v]' dist/web/v2 \
                  | grep -v '^dist/web/v2/embed\.js$' || true)
          if [ -n "$leaks" ]; then
            echo "::error::paths outside $LEGACY_BASE in: $leaks"; exit 1
          fi

      - name: Upload Pages artifact
        uses: actions/upload-pages-artifact@v3
        with:
          path: dist/web
  # deploy job unchanged
```

Notes on the sketch:

- **Build `main` before copying in `v2/`.** `emptyOutDir: true` empties `dist/web`.
- The `leaks` check deliberately skips `embed.js`, whose only `/6502-EMULATOR/` is in its
  header comment.
- Do not use `! grep ...` as a check. Bash's `-e` ignores a negated command that is not the
  last one in the step.
- Node stays at 22 for the legacy build even if `main` moves on. If the two ever differ,
  give the legacy build its own `setup-node`.

### Verify locally before pushing

1. Export the tag and build it the way CI will:

   ```sh
   W=$(mktemp -d) && mkdir "$W/legacy"
   git archive v2.7.0 | tar -x -C "$W/legacy"
   (cd "$W/legacy" && ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci && npm run build:web -- --base /6502-EMULATOR/v2/)
   npm run build:web
   mkdir -p "$W/site" && cp -R dist/web "$W/site/6502-EMULATOR" && cp -R "$W/legacy/dist/web" "$W/site/6502-EMULATOR/v2"
   python3 -m http.server 8080 -d "$W/site"
   ```

2. In a browser, open each page with the network panel on:
   - `http://localhost:8080/6502-EMULATOR/`
   - `http://localhost:8080/6502-EMULATOR/v2/`
   - `http://localhost:8080/6502-EMULATOR/v2/embed.html?autostart=1`

   Every request should be a 200 under its own base. Both pages should show the splash
   `v1.6` and sound after a click.
3. `examples/embed.html?base=http://localhost:8080/6502-EMULATOR/v2/` exercises
   `embed.js` and the postMessage API against the `/v2/` build.

### Land it

1. Commit **"Publish the frozen 2.7.0 web build at /v2/"**. In the same commit, add a short
   "Pinned legacy build" paragraph to `docs/EMBEDDING.md` (the URL, that it is 2.7.0 with
   BIOS 1.6 and never changes, and that new embeds should use `/6502-EMULATOR/`), and one
   line to `README.md`'s Embedding section.
2. Push `main`, then check:

   ```sh
   curl -sI https://acwright.github.io/6502-EMULATOR/v2/embed.html | head -1          # 200
   curl -s  https://acwright.github.io/6502-EMULATOR/v2/roms/BIOS.bin | grep -a -c 'BIOS v1.6'
   curl -sI https://acwright.github.io/6502-EMULATOR/embed.html | head -1             # still 200
   ```

3. Until `v3-vdp` merges, `/` and `/v2/` both serve 2.x with BIOS 1.6. That is expected:
   - `/` follows `main`, so any later commit on `main` changes `/` and never `/v2/`.
   - 6502-DOCS can cut `v1` against `/v2/` immediately. Nothing about `/v2/` changes when
     the merge lands.
   - The merge must keep this `deploy.yml` (§7 step 2).

**No legacy fixes go to `/v2/`** (assessment question 7). A TMS9918A bug is fixed on the
card in 3.x. Changing `LEGACY_REF` would break the contract.

---

## 7. Merge `main` into `v3-vdp` and re-capture

1. `git switch v3-vdp`, then `git merge main`. Expect conflicts in:
   - `package.json` / `package-lock.json` `version`: keep `3.0.0`.
   - `README.md`: `v3-vdp`'s splash line reads "on the video card". Keep that wording
     with `v1.6`. Take the rest of `main`'s edits (cycle numbers, the Embedding line).
   - `docs/AGENTS.md`: only if §4.6 changed a number. `v3-vdp` changed this file too.

   Both ROMs, `BIOS.test.ts`, the examples and `deploy.yml` are untouched on `v3-vdp` and
   should merge cleanly. Check `git diff main v3-vdp -- .github` is still empty before
   merging.
2. After the merge, confirm `.github/workflows/deploy.yml` is `main`'s (with `LEGACY_*`).
3. Run `npm test`. Expect `src/tests/goldens/Goldens.test.ts` and `Traces.test.ts` to fail
   on `bios/`. Everything else should pass. A failure outside the goldens is a merge
   problem, not a re-capture.
4. Run `npm run capture:goldens -- --check` and read what moved:
   - **`bios/ok`, `screenful`, `scroll`: expected to move.** The splash on rows 1–2 says
     v1.6, so the name-table text, VRAM and index frame all change.
   - **`wizardslab/`, `vdp-modes/`, `vdp-layers/`: unverified.** Each calls `KernalInit`,
     and 1.6's `ProbeRTC` adds instructions to it. The checkpoints are fixed cycle counts,
     so a small shift can move a frame. If one moves, the difference must be explained by
     timing (the same picture a frame early or late, or a sprite one step on). A pixel
     that changes for any other reason is a bug to find before re-capturing.
5. Re-capture deliberately, in two commits:
   - `npm run capture:goldens`, then commit only `src/tests/goldens/**` (not `*.vdpt.gz`):
     **"Re-capture the goldens for BIOS v1.6"**. The body names which checkpoints moved and
     why.
   - `npm run record:traces`, then commit only the `*.vdpt.gz` files: **"Re-record the
     traces for BIOS v1.6"**. The body says 6502-PICOVDP must re-sync `tests/oracle/`.
   - Run `npm run replay:traces`, `npm test` and `bash examples/run-all.sh`. All should pass.
6. One small `v3-vdp` edit: `src/tests/fixtures/README.md` says the BIOS fixture is
   "byte-identical with the `BIOS.bin` in `Developer/Assembly/6502-BIOS`". Make it
   `6502-BIOS` tag `v1.6`, because 6502-BIOS `main` becomes 2.x. Commit any progress notes
   made to this `VDP-PLAN.md` with it.
7. `git status --porcelain` must print nothing. Push `v3-vdp`, which also publishes the
   three local assessment commits.

---

## 8. Handoffs

### 6502-PICOVDP: re-sync the oracle

- **Precondition:**
  - The emulator is at `~/Developer/NodeJS/6502-EMULATOR` (or `PICOVDP_EMULATOR`).
  - It is on branch `v3-vdp`, at the §7.7 push.
  - `git status --porcelain` is empty, untracked files included.
- **In the emulator:** run `npm run build:cli`. `sync-oracle.mjs` itself reads only
  `fixtures.js` and the goldens, but the replay tools load `out/core/IO/Video.js`.
- **In 6502-PICOVDP:** run `node tools/sync-oracle.mjs`, then commit `tests/oracle/` on its
  own. `node tools/sync-oracle.mjs --check` must pass.
- **What they should see:** the manifest's `emulator.commit` moves from `8e40c0cb…` to the
  traces commit, and `bios/*` changes. Name any other fixture that §7.4 found moved.

### 6502-DOCS

- **`main`:**
  - `data/emulator.json` `version` `2.6.9` → `2.7.0`.
  - `.github/workflows/verify.yml` `EMULATOR_REF: v2.6.9` → `v2.7.0`.
  - Re-run the samples and screenshots, because the splash reads v1.6.
- **`v1` branch**, cut only after `/v2/` answers 200 (§6):
  - `data/emulator.json` `web.app` → `https://acwright.github.io/6502-EMULATOR/v2/`.
  - `web.frame` → `https://acwright.github.io/6502-EMULATOR/v2/embed.html`.
  - `web.contract` → `https://github.com/acwright/6502-EMULATOR/blob/v2.7.0/docs/EMBEDDING.md`.
  - `EMULATOR_REF` stays `v2.7.0` forever.
- **Unchanged:** the `banned.persist` rationale ("one IndexedDB record per origin") still
  holds (§9).

### 6502-BIOS

- `v1.x`: `.github/workflows/ci.yml` `EMULATOR_REF: v2.6.0` → `v2.7.0`.
- `main` may move to `v2.7.0` too, until a 3.x tag with a selectable PICOVDP card exists.

### Everyone else

- Assembly and C projects run `6502 run` from the installed app, and get 1.6 by updating
  it. Nothing is required of them.
- 6502-KIMULATOR is not affected.

---

## 9. Browser storage on the shared origin

### What is shared

- Every `acwright.github.io` project site has one origin.
- The web build stores:
  - IndexedDB `6502-emulator`, version 1, store `storage`, key `cf`: the whole CF image as
    a `Uint8Array` (`services/persistence.ts:10-26`).
  - localStorage `6502-emulator-nvram`: 256 bytes, base64.
  - localStorage `6502-emulator-muted` (`useAudio.ts:120`).
- The full app always persists (`App.vue`). An embed persists only with `persist=1`
  (`EmbedApp.vue:189`), and 6502-DOCS bans that parameter. So the frozen docs' embeds
  never read or write storage. Only someone who opens `/v2/` directly, or an outside
  embed with `persist=1`, shares records with `/`.

### Recommendation: 2.7.0 changes nothing. The constraints go to Part 2.

Sharing is harmless today, and namespacing in 2.7.0 would cost more than it buys:

- **Same data, same meaning.** NVRAM is the DS1511Y's 256 bytes. BIOS 2.0 is 1.6 plus other
  work, keeps the save-slot format, and appends to the jump table. The CF image uses the
  same file system on both. Sharing them is moving the clock card or the CF card between
  two machines, which is what the hardware does. A BASIC 2.x program with new tokens
  LISTs as garbage on 1.6, exactly as it would on a real board.
- **Only 3.x can break it, and 3.x is still editable.** The frozen build opens
  `indexedDB.open('6502-emulator', 1)`. If 3.x ever opens that database at version 2, the
  frozen build gets a `VersionError` on every load and save. `usePersistence` swallows it
  as a warning, so `/v2/` would lose CF persistence silently and for good. The fix belongs
  in 3.x, and it can always be made there.
- **Namespacing inside 2.7.0 costs a migration.** New names would orphan every 2.6.x user's
  saved card and NVRAM on upgrade unless 2.7.0 also carried migration code. That breaks
  "2.7.0 is only BIOS 1.6", for a separation nothing needs yet.
- **The loaders already tolerate foreign records:**
  - `RTC.loadNVRAM` rejects any length but 256.
  - `Storage.loadData` resizes to what it is handed.
  - A missing or corrupt record reads as null.

### Constraints Part 2 must honour (copy into Part 2's storage section)

1. Never bump `DB_VERSION` on `6502-emulator`, and never change the encoding under `cf` or
   `6502-emulator-nvram`. New stores go in a new database name.
2. If 3.x namespaces by card or version, it moves to new names and may copy once from the
   old ones. It must not delete or rewrite the old records, which the frozen build still
   reads.
3. Web settings are not persisted today (`window.api` only). A persisted 3.x card choice
   needs a new key, which is namespaced by construction.

**Pre-existing and not new:** two tabs, of either build, each autosave the whole CF record
every 30 s, and the last writer wins. Electron is unaffected: 3.x replaces 2.7.0 in place
under the same `appId`, and `storage.img` / `nvram.bin` carry over with the same reasoning.

---

## 10. Risks and open questions

1. **The frozen build is rebuilt on every deploy.**
   - It depends on the npm registry serving `v2.7.0`'s lockfile and on Node 22 staying
     installable. Node 22's maintenance ends April 2027, though `setup-node` still serves
     old versions.
   - A failure blocks the whole Pages deploy, `/` included. That is the right failure for
     a contract, but it will be noticed only on the next push to `main`.
   - **Fallback, if it ever bites:** attach the built `/v2/` tree to release `v2.7.0` as a
     tarball, and have the workflow download it instead of building it. Not proposed now,
     because the assessment chose building from the tag.
2. **Unverified until the ROM exists:** that `BIOS.test.ts`'s pinned addresses hold, how far
   the boot cycle counts move, and whether the three cartridge fixtures' goldens move. Each
   has a check in §4 or §7.
3. **A moved `v2.7.0` tag** would change `/v2/` silently. `LEGACY_SHA` catches it, and the
   ruleset in §5.8 prevents it.
4. **The `/v2/` banner question.** Anything that marks `/v2/` as legacy (a banner, a link to
   `/`) must be built into 2.7.0, because the tag is frozen. It would have to key off
   `import.meta.env.BASE_URL`, since `/` serves the same build until the merge.
   Recommendation: no banner. 6502-DOCS `v1` gives the context, and `/v2/` is meant to be
   embedded rather than visited. Decide before tagging.
5. **Merge conflicts in §7.1** are small but touch `README.md`, which `v3-vdp` rewrote
   heavily. Read the merged Default Boot Experience section, not just the conflict hunk.

---

## Part 2: the VDP

*To be written.*
