# CLAUDE.md

Emulated Blackmagic ATEM switchers and Videohub routers. Blackmagic's own apps (ATEM
Software Control, Videohub Control) connect to them as if they were hardware, so a show
can be programmed without the gear and saved with the apps' own File → Save As.

## Layout

- `emulator.mjs` – process entry: starts/stops the emulators, local HTTP API on 9900
  (used by the app and by `web/index.html`, the browser panel for the Terminal version)
- `lib/atem/` – ATEM protocol (UDP 9910): `server.mjs` (sessions, acks, retransmits),
  `switcher.mjs` (state, commands, transitions, macros, file transfers), `models.mjs`
  (the 31 models), `codec.mjs`/`spec.mjs` (field layouts), `profiles/*.data` (recordings)
- `lib/videohub/server.mjs` – Videohub Ethernet Protocol (TCP 9990)
- `lib/bonjour.mjs` – announcements via macOS `dns-sd`
- `app/` – the native macOS app (SwiftUI window + menu bar), runs `emulator.mjs` with a
  bundled Node; `tools/build-app.sh` builds `build/BMD Emulator.app`
- `tools/` – `capture-atem.mjs`, `sdk-check.mjs`/`sdk-connect.cpp`, `gen-atem-spec.mjs`

## Commands

```sh
node emulator.mjs                 # Terminal version + browser panel at localhost:9900
node emulator.mjs --list          # model ids
tools/build-app.sh                # universal app (default); --native for this Mac only
node tools/sdk-check.mjs [ids…]   # every model through Blackmagic's SDK (see Testing)
node tools/capture-atem.mjs <ip>  # record a real switcher's state (read-only)
node tools/gen-atem-spec.mjs <LibAtem checkout>   # regenerate lib/atem/spec.json
```

No npm dependencies. Node 18+ for the emulator; the app build needs Xcode command line
tools and a universal Node (nodejs.org installer).

## How the ATEM emulation works

- **State is raw status commands**, exactly as a real switcher sends them on connect,
  keyed by command name + id fields. A new client gets the whole store, then `InCm`.
- **Commands from clients** (`Switcher.handle`): a handler in `HANDLERS` if one exists
  (cut/auto/FTB/DSK, macros, locks, file transfers, time), otherwise the generic path
  copies masked fields from the set command into its paired status command
  (`spec.mjs` pairs `XxxSetCommand` with `XxxGetCommand`, plus `EXTRA_PAIRS`). Anything
  unpaired is reported as "not stored yet" in the UI.
- **`spec.json`** is generated from LibAtem's C# attributes: byte offsets, types, scales,
  id fields, masks, and command↔macro-op mappings. Layouts vary by protocol version;
  `Spec` picks the variant for the model's `_ver`.
- **Macros** are stored in the switcher's binary format: ops are little-endian
  (`u16 len, u16 op id, fields`); commands are big-endian. Recording converts commands
  to ops via the spec; playback converts back. ATEM Software Control reads/writes them
  with the file-transfer commands (`FTSU`/`FTSD`/`FTDa`/…) on store `0xffff`.
- **Saved state** (`data/` or `~/Library/Application Support/BMD Emulator`) is laid over a
  freshly built model on start (`Switcher.restore`), so model fixes still reach shows
  programmed earlier. Structural commands (`_…`, tally tables, `WhoI`) always come from
  the model.

## Models (`lib/atem/models.mjs`)

15 models replay recordings from real hardware (from sofie-atem-connection's tests, MIT).
16 are built from a sibling recording: renamed (`_pin`), trimmed (`shrink`), with `borrow`
/`omit` for model-specific settings, or `upgrade` to protocol 2.32. Every model then gets
`factoryNames` (recordings carried their owners' labels) and `identify` (`WhoI`: the
name ATEM Software Control shows in its title bar, plus IP and unique id).

Things the SDK rejects, learned the hard way:
- Trimming inputs must also rewrite `_TlC`, `TlIn`, `TlSr`, `TlFc` and drop input-keyed
  commands without a known layout (`InMp`, `FIEP`, `FASG`).
- Changing the model byte can require that model's settings (HD8 ISO needs `ISOi`;
  Mini Pro must not have the ISO ones).
- ATEM Software Control 10.x refuses some models below protocol 2.32 (Constellation 8K)
  and anything at 2.29 or older.

## Testing

- **Use `tools/sdk-check.mjs` after any change to models, profiles or the init state.**
  It connects through Blackmagic's Switchers SDK, which is what ATEM Software Control
  uses; a failure there is the app's "Your switcher is running a newer software
  version" dialog. Client libraries such as atem-connection accept states the SDK
  rejects, so they don't prove compatibility. Run it a few times; one recording was
  intermittently rejected. It needs UDP 9910 free (stop the ATEM in the app first).
- The SDK sample `DeviceInfo` crashes on some valid states; don't use it as a test.
- Videohub: test with a TCP client on a spare port (`new VideohubServer({ port })`);
  port 9990 is usually held by Blackmagic's Videohub Server.
- The SwiftUI window can't be screenshotted from a terminal session; render it offscreen
  by hosting `ContentView` in an `NSWindow` and calling `layer.render(in:)`.

## Safety (live production networks)

- **Never launch ATEM Software Control for testing while a real switcher may be on the
  network.** It reconnects to the last-used switcher by unique id before anything else
  (it did once, to a live Constellation 4K). Check with `dns-sd -B _switcher_ctrl._udp`.
- The emulators listen on 127.0.0.1 and announce local-only (`dns-sd -lo -P`) unless the
  user turns on network access. Keep that default.
- `tools/capture-atem.mjs` only listens; don't add anything that sends commands to real
  hardware.
- Don't change the user's Blackmagic app preferences without restoring them.

## Conventions and preferences

- The native app is the main UI; keep `web/index.html` working for the Terminal version.
- Don't mark built models in the UI (no stars, no "built from" notes); the README covers it.
- Builds are universal by default.
- Don't commit Blackmagic's PDFs or other copyrighted material; credit third-party data
  in `THIRD_PARTY.md`.
- Plain JS ES modules, no dependencies; comments explain why, not what.
