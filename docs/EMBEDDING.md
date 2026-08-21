# Embedding the emulator

The web build ships two pages. `index.html` is the full emulator; `embed.html`
is the same machine sized for an `<iframe>` on somebody else's page — no
settings panel, no serial console, no debug bridge, and nothing written to disk
unless you ask for it.

```html
<iframe
  src="https://acwright.github.io/6502-EMULATOR/embed.html?prg=https://your-site.example/game.prg&autostart=1"
  width="640" height="520"
  allow="autoplay; gamepad; fullscreen"
  style="border: 0"
></iframe>
```

`prg` takes the program's full address — see
[CORS and CSP](#cors-and-csp) for why a relative one will not do — or use
[`prg64`](#inline-payloads-the-64-suffix) to carry the bytes in the URL and
fetch nothing at all.

That is the whole integration. Everything below is optional.

---

## Contents

- [URL parameters](#url-parameters)
- [Inline payloads: the `64` suffix](#inline-payloads-the-64-suffix)
- [CORS and CSP](#cors-and-csp)
- [Keyboard focus](#keyboard-focus)
- [The on-screen keyboard](#the-on-screen-keyboard)
- [Sound](#sound)
- [Sizing](#sizing)
- [Persistence](#persistence)
- [The `postMessage` API](#the-postmessage-api)
- [The `embed.js` loader](#the-embedjs-loader)
- [Caveats](#caveats)

---

## URL parameters

| Parameter | Default | Meaning |
|---|---|---|
| `rom` | bundled BIOS | URL of a ROM image |
| `cart` | — | URL of a cartridge image |
| `prg` | — | URL of a `.prg` / `.bas`, loaded at `$0800` like BASIC's `LOAD` |
| `bin` | — | `<address>=<url>`, raw bytes at an explicit address. Repeatable |
| `cf` | — | URL of a CompactFlash image |
| `autostart` | `1` | Boot the machine on load |
| `autotype` | — | Text typed into the machine once it has booted (e.g. `RUN\r`) |
| `controls` | `minimal` | `full` \| `minimal` \| `none` |
| `keyboard` | `auto` | On-screen keyboard: `1`, `0`, or `auto` — on for a touch-only device |
| `freq` | `1` | CPU clock, 1 or 2 MHz |
| `muted` | `1` | Start muted |
| `persist` | `0` | Opt in to IndexedDB CF/NVRAM persistence |
| `cfsize` | `1` (`256` with `persist=1`) | CompactFlash card size in MB, 1–256 |
| `origins` | any | Comma-separated origins allowed to drive the frame over `postMessage` |

Every parameter that names a file — `rom`, `cart`, `prg`, `bin`, `cf` — also has
a `64` form that carries the bytes in the URL itself. See the next section.

**Flags** (`autostart`, `muted`, `persist`) accept `1`/`0`, `true`/`false`,
`yes`/`no`, `on`/`off`, or bare presence: `?muted` means `muted=1`.

**Addresses** in `bin` are written the way the CLI writes them — `$C000`,
`0xC000` or plain decimal.

**`autotype`** understands `\r`, `\n`, `\t` and `\\` written literally, so
`autotype=RUN\r` does what it looks like. It waits for BASIC to finish
initialising before typing (the same signal the program loader uses), and gives
up waiting after ten seconds — so it still fires behind a cartridge, which never
brings BASIC up at all.

**Nothing here is fatal.** A malformed value falls back to its default and logs a
warning to the console (and to a dismissible banner in the frame); an
unrecognised parameter is ignored outright. That is deliberate: if you pin an
emulator version and later start passing a parameter that version has never
heard of, you get a working emulator, not a blank frame.

---

## Inline payloads: the `64` suffix

Every media parameter has a base64 twin — `rom64`, `cart64`, `prg64`, `bin64`,
`cf64` — that carries the bytes in the URL instead of naming a file to fetch:

```html
<iframe src="…/embed.html?prg64=AQgLCAoAmSJIRUxMTyIAAAA&autostart=1&autotype=RUN%5Cr"></iframe>
```

This is the form to reach for on a documentation site. It needs no CORS headers,
no `connect-src` allowance, and no second network round trip, so a code sample
is genuinely self-contained: the snippet *is* the program.

When both spellings are present the `64` one wins — it is already in hand — and
a warning records that the other was skipped.

Both alphabets are accepted, padded or not:

```bash
# URL-safe: paste the output straight into the URL.
base64 < hello.prg | tr '+/' '-_' | tr -d '=\n'

# Standard base64 works too — a query string turns "+" into a space, which is
# decoded back. "/" and "=" need no escaping in a query string.
base64 < hello.prg | tr -d '\n'
```

A `data:application/octet-stream;base64,…` prefix is stripped if you leave one
on, so `FileReader.readAsDataURL()` output pastes in directly.

`bin64` takes the same `<address>=<payload>` shape as `bin`, split on the *first*
`=` so base64 padding survives:

```
?bin64=$C000=qQFgAAA=
```

The practical limit is URL length. Browsers handle a few tens of kilobytes
comfortably; past that, host the file and use the fetching form.

---

## CORS and CSP

**A relative URL is relative to this frame, not to your page.** The fetch is
made by `embed.html`, which is served from here — so `prg=game.prg` asks for
`game.prg` next to the emulator, not next to the page doing the framing, and
comes back 404 over an otherwise working BASIC prompt. There is no way around
it from this side: the frame cannot read its parent's address. Give a fetched
file its full `https://…` address, and if you will not know that address until
after you have uploaded, build it in the host page:

```html
<script>
  const machine = new URL('https://acwright.github.io/6502-EMULATOR/embed.html')
  machine.searchParams.set('prg', new URL('game.prg', location.href).href)
  document.querySelector('iframe').src = machine
</script>
```

A fetched `prg`/`rom`/`cart`/`cf`/`bin` has two further conditions on it, and
both belong to the host serving the file:

- **CORS.** A cross-origin fetch needs `Access-Control-Allow-Origin` from
  whatever serves the file. GitHub Pages, itch.io's CDN and most object stores
  send it; a plain Apache directory often does not. Nothing the embed can do
  substitutes for it.
- **CSP.** `embed.html` sets `connect-src 'self' https:`, widened from the main
  app's `'self'` for exactly this fetch. `http:` URLs are still refused, and
  `script-src` stays `'self'` — nothing fetched can be executed as code.

If either fails, the embed reports the problem and boots anyway: a docs page with
a broken program link still shows a working BASIC prompt. Use the
[`64` forms](#inline-payloads-the-64-suffix) when you want no network at all.

`frame-ancestors` is deliberately not set, and GitHub Pages sends no
`X-Frame-Options`, so framing works as shipped from any origin.

---

## Keyboard focus

The embed captures the keyboard **only while the frame has focus**, and shows a
focus ring when it does. Before then, arrow keys and space scroll the host page
as usual — an emulator that ate the reader's page-down key because it happened
to be on screen would be a bad guest.

A prompt sits on the frame until the first click, in one of two shapes depending
on what the click will actually do:

- **`autostart=0`** — the screen is blank and clicking is what starts the
  machine, so the prompt covers the frame and reads *Click to start*.
- **`autostart=1`** (the default) — the machine is already booting, so all the
  click can offer is the keyboard and the sound. The prompt shrinks to a corner
  badge saying so, rather than covering up the boot. Clicking anywhere in the
  frame works; the badge is only the affordance.

Use `autostart=0` when you want the machine held until the reader asks for it —
several embeds on one page all emulating a CPU nobody has looked at yet is real
work for someone's battery. `autotype` waits for the machine to be running, so
`autostart=0&autotype=RUN\r` types its program on the click rather than before
it.

---

## The on-screen keyboard

The board's own 67-key keyboard, drawn on the screen and wired to the machine as
emulated keystrokes — the same component the full app has, and the same layout
the real hardware carries. Shift and Ctrl are sticky: tap to arm for one key, tap
again to lock. Fn turns the number row into F1–F10.

It is off on a desktop and **on by default on a touch-only device**, which is
what `keyboard=auto` means. That asymmetry is the whole point: a phone has no
keyboard to give the machine, so an embed of BASIC without a board on it is a
picture rather than an emulator; a laptop has one already, and opening a second
would cost a third of the frame for nothing.

| Value | Meaning |
|---|---|
| `auto` (default) | On when the browser reports `(pointer: coarse) and (hover: none)` — a touch screen and no mouse |
| `1` | Always on |
| `0` | Always off |

`auto` is read once, when the frame loads. A reader who closes the board keeps it
closed, and a tablet that has a keyboard attached to it mid-session is answered
by the toggle rather than by the layout jumping.

Under `controls=minimal` and `controls=full` the bar carries a toggle. Under
`controls=none` there is no bar and so no toggle — `keyboard=1` is how a frame
with no chrome gets a keyboard, and `keyboard=0` is how one keeps its whole
height.

Allow for it when sizing: the board takes `min(34dvh, 13rem)` under the screen.
In landscape on a phone it moves *beside* the screen instead, so the two are not
dividing a height neither of them has.

The host page can drive it: [`6502:setKeyboard`](#sending-commands), and
`6502:ready` reports `keyboard` as the resolved boolean rather than the mode it
was asked for.

---

## Sound

Embeds start muted by default (`muted=1`). Browsers block autoplay in iframes,
so an embed that started unmuted would mostly produce silence with no
explanation — and an article that starts making noise as the reader scrolls past
is worse than one that does not.

The mute button reflects whether sound is *audible right now*, not the setting:
it reads muted until the AudioContext is genuinely running, whatever `muted=`
said. Clicking it starts audio and unmutes. `muted=0` unmutes as soon as the
browser permits a context to start, which in practice means at the first click
anywhere in the frame.

The embed never writes its mute state back to storage — a docs page cannot
change the sound preference of the full app on the same origin.

---

## Sizing

The video output is 320×240. Doubling it and allowing for the control bar gives
**640×520**, which is the size the loader script uses. `controls=none` needs only
the video, so 640×480 fits exactly.

The frame scales to whatever box you give it — the canvas keeps its aspect ratio
and letterboxes, in portrait as well as landscape. For a fluid layout, wrap it:

```html
<div style="position: relative; width: 100%; max-width: 640px; aspect-ratio: 640/520">
  <iframe src="…/embed.html" style="position: absolute; inset: 0; width: 100%; height: 100%; border: 0"></iframe>
</div>
```

Add `allow="fullscreen"` if you want the fullscreen button to work; without it
the browser refuses and the embed says so.

**On a phone.** The embed lays itself out for the box it is in, not for the
window, so a frame given a phone-sized box behaves like the app does on a phone:
the control bar wraps rather than running off the edge, its buttons grow to 44pt
targets on a touch pointer, and below 480pt of height the bar becomes a single
row that scrolls sideways and the on-screen keyboard moves beside the screen
instead of under it. A frame that will be read on a phone wants **at least
320 × 380** with the keyboard up; give it the width of the column it sits in and
let the height follow the 640 × 520 ratio.

---

## Persistence

Off by default. Nothing is written to IndexedDB or localStorage, and the
CompactFlash card is allocated at 1 MB rather than the real machine's 256 MB —
two embeds on one page should not cost half a gigabyte for a card neither of them
touches.

`persist=1` turns on the same CF and NVRAM persistence the full app uses, and
raises the card to 256 MB to match. That matters: the persistence store is one
IndexedDB record per origin, shared with the full app, and an embed that saved a
1 MB card first would shrink the user's real card to fit. `cfsize=<MB>` overrides
either default.

An explicit `cf=`/`cf64=` image wins over whatever was restored — and with
`persist=1` it becomes what is saved from then on.

---

## The `postMessage` API

For driving the frame after it has loaded — a "Run this" button beside a code
block, say. Everything the URL parameters do at load time, this does at any time.

### Sending commands

```js
const frame = document.querySelector('iframe').contentWindow

frame.postMessage({ type: '6502:load', kind: 'prg', data: base64String }, '*')
frame.postMessage({ type: '6502:reset' }, '*')
frame.postMessage({ type: '6502:type', text: 'RUN\r' }, '*')
```

| Message | Fields | Effect |
|---|---|---|
| `6502:load` | `kind`, `data`, `address?`, `label?` | Load media. `kind` is `rom`, `cart`, `prg`, `bin` or `cf`; `address` applies to `bin` (default `$0800`). Loading a ROM or cart resets the CPU so it takes the new vectors |
| `6502:run` | — | Start the machine |
| `6502:pause` | — | Stop it |
| `6502:reset` | — | Warm reset — pulses RESET, keeps RAM |
| `6502:powerCycle` | — | Cold reset — zeroes RAM |
| `6502:setMuted` | `muted` | Mute or unmute |
| `6502:setKeyboard` | `open` | Show or hide the on-screen keyboard |
| `6502:type` | `text` | Type text into the machine as emulated keystrokes |

`data` may be a base64 string, an `ArrayBuffer`, a typed array, or an array of
byte values. A string is the one that survives being written into a JSON blob or
an HTML attribute, so it is usually what you want.

Unknown `6502:` verbs are ignored, for the same reason unknown URL parameters
are.

### Receiving events

```js
window.addEventListener('message', (event) => {
  if (event.source !== frame) return
  switch (event.data?.type) {
    case '6502:ready':   /* the machine is up and the ROM is in */ break
    case '6502:stopped': /* event.data.reason — a StopReason */   break
    case '6502:serial':  /* event.data.bytes / event.data.text */ break
  }
})
```

| Message | Fields |
|---|---|
| `6502:ready` | `rom`, `program`, `controls`, `keyboard`, `warnings` — sent once, after the boot sequence. `keyboard` is the resolved boolean, not the `keyboard=` mode |
| `6502:stopped` | `reason`, the debug protocol's `StopReason`. A program ending in `STP` arrives as `{ kind: 'trap', detail: 'stp' }` — see [DEBUG-PROTOCOL.md](DEBUG-PROTOCOL.md) |
| `6502:serial` | `bytes` (numbers) and `text`, from the ACIA. Coalesced over ~32 ms rather than one message per character |

### Origins

**By default the embed accepts commands from any origin.** That is what makes a
raw `<iframe>` on someone else's CDN work with no configuration, and the exposure
is bounded: the emulator holds no credentials and cannot see the host page, so
the worst a hostile framer can do is drive the emulated machine it is already
framing.

If that is not a trade you want, name the origins that may drive it:

```
?origins=https://docs.example.com,https://staging.example.com
```

Inbound messages from anywhere else are then dropped, and outbound messages are
posted only to those origins. `origins=*` is the explicit spelling of the
default.

---

## The `embed.js` loader

Convenience only — it builds the URL and sizes the frame. A raw `<iframe>` does
the same job with no script at all.

```html
<script src="https://acwright.github.io/6502-EMULATOR/embed.js"></script>

<div data-6502-prg="https://your-site.example/hello.prg" data-6502-autostart="1" data-6502-autotype="RUN\r"></div>
```

Every `data-6502-<name>` attribute becomes the `<name>` URL parameter, with no
list of known names in the loader — so it keeps working against an emulator
newer than itself. Four attributes are read locally instead of forwarded:

| Attribute | Default |
|---|---|
| `data-6502-width` | `640` |
| `data-6502-height` | `520` |
| `data-6502-title` | `6502 emulator` |
| `data-6502-allow` | `autoplay; gamepad; fullscreen` |
| `data-6502-class` | — (set on the generated `<iframe>`) |

Repeatable parameters cannot repeat as attributes, so `data-6502-bin` and
`data-6502-bin64` take `;`-separated specs:

```html
<div data-6502-bin="$C000=sprites.bin;$D000=music.bin"></div>
```

A bare `data-6502` marks a container that takes only defaults. Call
`window.mount6502Embeds()` to scan again after adding containers dynamically.

---

## Caveats

- **A cross-origin file needs CORS on the host serving it.** There is no
  workaround from this side; use `prg64=` and friends instead.
- **Browser autoplay policy means an embed starts silent regardless of
  `muted=0`.** The first click in the frame is what starts the audio graph.
- **URL length bounds the `64` forms.** A few tens of kilobytes is safe; a full
  CF image is not.
- **Fullscreen needs `allow="fullscreen"` on the `<iframe>`.**
- **The frame must not be sandboxed away from scripts** — `postMessage` control
  needs `allow-scripts`, and the keyboard needs the frame to be focusable.

---

## See also

- [README](../README.md) — the emulator itself
- [DEBUG-PROTOCOL.md](DEBUG-PROTOCOL.md) — stop reasons, and the full debug protocol
- [../examples/embed.html](../examples/embed.html) — a runnable page exercising
  both the URL API and `postMessage`
