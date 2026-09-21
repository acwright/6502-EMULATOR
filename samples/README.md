Samples
=======

AC6502 programs written here, to exercise emulator features that no existing
binary reaches. One directory per program: assembly source, a `Makefile`, and the
built binary committed beside it.

The binaries are committed on purpose. Each one is booted by the golden suite
(`src/tests/goldens/`), which must run from a clean checkout without cc65
installed — and rebuilding one moves every golden captured from it, so a rebuild
is a deliberate act in a commit of its own, with the reason in the message,
exactly as a re-captured golden is.

```sh
brew install cc65
make -C samples/vdp-modes          # rebuild one
make -C samples/vdp-modes run      # and run it in this repository's emulator
```

| | |
|---|---|
| [vdp-modes/](vdp-modes/) | the four `VMODE` geometries of the 6502-PICOVDP, one per screen, at four bit depths |
| [vdp-layers/](vdp-layers/) | two layers scrolling past four sprites, resolving every one of the VDP's six priority levels |
| [vdp-font/](vdp-font/) | the built-in font of VDP-SPEC draft 0.5: as reset installs it, reloaded by `FONT`, and loaded where `L0PAT` points |
| [flash-cart/](flash-cart/) | a 128K banked cartridge: three banks read through one window, and a byte the cartridge programs into its own flash |

These are *not* the AC6502 sample programs. Those live in the `6502-DOCS`
repository, are what the documentation walks through, and are built and checked
there. What is here exists to be booted by a test.
