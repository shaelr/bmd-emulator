# BMD Emulator

Emulated Blackmagic **ATEM switchers** and **Videohub routers** for your Mac. Start one,
pick a model, and ATEM Software Control or Videohub Control connect to it as if it were
real hardware. Program the show as usual, save it from Blackmagic's software, and load
that file onto the real hardware later.

- All 31 ATEM models in ATEM Software Control 10.x, from the ATEM Mini to the Constellation 8K
- 17 Videohub models plus any custom size up to 288×288
- The programming persists: stop and restart the emulator and it's still there

## The app

Download it from the repository's **Releases** page, or build it yourself (below).

**First launch:** the app isn't notarized by Apple, so macOS blocks it the first time.
Open it once and click **Done** on the warning, then go to **System Settings → Privacy &
Security**, scroll to *Security*, click **Open Anyway** next to "BMD Emulator was blocked",
and confirm with your password. After that it opens normally.

**build/BMD Emulator.app** is a native Mac app (Apple silicon and Intel). Its window has
everything: pick and start an ATEM or Videohub model, see what's connected, pause
Blackmagic's Videohub Server, allow network access, and watch the activity log. Close the
window and it keeps running in the menu bar (the switcher icon fills in when software is
connected); the menu has the same controls plus **Start at Login**. Quitting the app stops
the emulators. Drag it to Applications to keep it.

It's self-contained (it carries its own copy of Node.js) and keeps your programming in
`~/Library/Application Support/BMD Emulator` (**Show Saved Data in Finder** in the menu).

To rebuild it after changing the code: `tools/build-app.sh` (universal, about 240 MB), or
`tools/build-app.sh --native` for a smaller copy for this Mac's processor only. It needs the
Xcode command line tools and a universal Node.js (the nodejs.org installer's).

## Start it from Terminal instead

Double-click **Start Emulator.command** (or run `node emulator.mjs`). It needs
[Node.js](https://nodejs.org) 18 or newer and nothing else. The control panel opens at
<http://localhost:9900>. Pick a model and press **Start**. Close the terminal window to stop.

The emulators are visible to software on this Mac only. Tick **Allow other computers on
the network** in the control panel to program from another computer. Leave it off on a
network with live equipment, so the emulator doesn't appear in other operators' software.

## ATEM

1. In the control panel, choose the **same model as the show switcher** and press **Start**.
2. In ATEM Software Control, select **"<model> (Emulator)"**, or connect to `127.0.0.1`.
3. Program as normal: macros, labels, transitions, keyers, aux, SuperSource, audio,
   multiview and so on. Transitions, fade to black and macros all run in real time.
4. **File → Save As…** in ATEM Software Control saves the show as XML.
5. With the real switcher connected: **File → Restore**, pick the file, choose what to restore.

> **Check which switcher you're connected to.** ATEM Software Control reconnects to the
> last switcher you used whenever it's on the network, before anything else. On a
> network with your real switcher, pick the emulator explicitly and confirm the name in
> the app before changing anything.

**Recorded vs built models.** 15 models use startup state recorded from real hardware.
The other 16 are built from the closest recorded model (renamed, with inputs, M/Es, keyers
and outputs trimmed), so their counts are close but not guaranteed. Every model is checked against Blackmagic's own Switchers SDK, which
is what ATEM Software Control uses to connect, and all input labels start at their
factory names.

**Use your own switcher's state (most accurate).** When you have the hardware, record it once:

```sh
node tools/capture-atem.mjs 192.168.1.240   # your switcher's IP address
```

This only listens: it receives the state every client gets on connect and sends no
commands. It saves `profiles/<model>.data`, which the emulator then uses for that model
in place of the bundled recording.

**What isn't stored yet.** If you change a setting the emulator doesn't know how to keep,
the control panel lists it under "kinds of change not stored yet". Those changes won't be
in a saved file. Tell me the codes shown there and I'll add them.

## Videohub

Blackmagic's **Videohub Server**, a background service installed with the Videohub
software, holds port 9990, which the emulator needs. Use **Pause it** under
*Blackmagic Videohub Server* in the control panel (it asks for your Mac password).
It comes back by itself after a restart, or use **Resume it**.

1. Choose the model (or a custom size) and press **Start**.
2. In Videohub Control, select **"<model> (Emulator)"**.
3. Set labels and routing, then use Videohub Control's own save option (Videohub State XML).
4. With the real router connected, load that file in Videohub Control.

## Files

| Path | What it is |
| --- | --- |
| `build/BMD Emulator.app` | The app (built by `tools/build-app.sh`) |
| `app/` | The app's source (Swift) and icon |
| `Start Emulator.command` | Double-click launcher (Terminal version) |
| `emulator.mjs` | Control panel and process that runs the emulators |
| `lib/atem/` | ATEM protocol, switcher behaviour, model list and recordings |
| `lib/videohub/` | Videohub protocol server |
| `data/` | Saved state for the Terminal version (the app uses Application Support) |
| `profiles/` | Your own captured switchers |
| `tools/capture-atem.mjs` | Record a real switcher's state |
| `tools/sdk-check.mjs` | Checks every model against Blackmagic's Switchers SDK (what ATEM Software Control uses) |
| `tools/gen-atem-spec.mjs` | Developer tool that rebuilds `lib/atem/spec.json` from LibAtem |
| `archive/` | The earlier web-based show builder |

Third-party material is listed in [THIRD_PARTY.md](THIRD_PARTY.md).
