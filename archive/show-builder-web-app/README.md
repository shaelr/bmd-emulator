# BMD Show Builder

Pre-program a show offline on an emulated ATEM switcher and Videohub router, then load
it into the real hardware on show day.

- **ATEM:** build macros by "playing" the emulated switcher, set input labels, and export an
  XML file that ATEM Software Control restores with **File → Restore**.
- **Videohub:** set labels, routing and routing presets, then export Videohub-protocol
  `.txt` files, or push a saved project straight to the hub with the included script.

No install or build step. Open `index.html` in Chrome, Edge, Safari or Firefox. Your
work autosaves in the browser. Use **Save project** to keep a `.bmdshow.json` file.

---

## ATEM workflow

### 1. Start from your switcher's own file (recommended)

1. Connect ATEM Software Control to the switcher and choose **File → Save As…**.
2. In the app, click **Import ATEM XML…** and pick that file.

This sets the exact model and product string and loads the existing labels and macros.
Exports are then merged back into that file, so every other setting in it (keyers, audio,
multiview, etc.) comes back unchanged. Without a template, the app writes a minimal file
with only labels and macros. ATEM Software Control may refuse it if the product name or
version doesn't match, so test it before show day.

### 2. Program the show

- **Setup & labels…**: pick the model, adjust counts, set long (20-character) and short
  (4-character) input names, and set the frame rate used to time pauses.
- **Switcher:** Program/Preview buses, CUT, AUTO (Mix/Dip/Wipe with rate), FTB, upstream
  key on-air, downstream keys (TIE / ON AIR / AUTO), aux routing and media player stills.
  Shortcuts: `1`–`9` preview a camera, `Space` cuts, `Enter` runs AUTO.
- **Macros (100 slots):** select a slot and press **● Record**. Everything you do on the
  switcher is added as a step. Add **Pause** (frames) and **Wait for operator** steps as on
  the hardware. Click a step to edit, reorder or delete it. **▶ Run** plays the macro in the
  emulator with real timing, so you can check the pacing.

Like the real switcher, AUTO does not wait for the transition to finish before the next
step runs. Add a pause after it.

### 3. Load it into the switcher

1. **Export ATEM XML**.
2. In ATEM Software Control, choose **File → Restore**, pick the file, and tick **Macros**
   (and **Inputs** for labels).

Steps the emulator can't simulate (SuperSource, DVE, audio, etc.) are kept unchanged when
you import and export a file. They appear dimmed in the step list.

## Videohub workflow

- Set the model or size, type input/output labels, and route with the **List** or **Grid** view.
- **Routing presets:** **+ Store current routing** saves a snapshot for each part of the
  show. **Recall** applies one in the emulator. Outputs that differ from the live routing
  are highlighted.
- **Import .txt…** accepts the app's own exports or a dump captured from a real hub.

### Sending to the hub

Videohub Control has no file import, so the included script talks to the hub's Ethernet
protocol (TCP 9990) directly. It needs Node.js 18+.

```sh
# Everything: labels + the live routing from a saved project
node tools/videohub-push.mjs 192.168.1.50 "My Show.bmdshow.json"

# One routing preset by name or number (add --labels to also send labels)
node tools/videohub-push.mjs 192.168.1.50 "My Show.bmdshow.json" --preset "Walk-in"
node tools/videohub-push.mjs "My Show.bmdshow.json" --list

# Any exported .txt
node tools/videohub-push.mjs 192.168.1.50 "My Show - Videohub.txt"

# Back up the hub's current state first (importable in the app)
node tools/videohub-push.mjs 192.168.1.50 --dump backup.txt
```

Each block is reported as `✓` (acknowledged) or `✗` (rejected). Add `--dry-run` to print
what would be sent without connecting.

On a Mac you can also send a `.txt` with netcat: `nc 192.168.1.50 9990 < file.txt`. There's no
per-block confirmation that way.

### Rehearsing without hardware

`tools/videohub-sim.mjs` is a software Videohub that speaks the same protocol:

```sh
node tools/videohub-sim.mjs --inputs 40 --outputs 40
node tools/videohub-push.mjs 127.0.0.1 "My Show.bmdshow.json" --preset 2
```

Other Videohub controllers, such as Bitfocus Companion, can connect to it too.

## Files

| Path | Purpose |
| --- | --- |
| `index.html`, `css/`, `js/` | The app |
| `js/atem-xml.js` | ATEM Software Control XML import/export |
| `js/videohub-txt.js` | Videohub protocol text import/export |
| `tools/videohub-push.mjs` | Push labels/routing to a hub, or dump its state |
| `tools/videohub-sim.mjs` | Videohub simulator for testing |

## Notes

- Model input/key/aux counts are typical values. Check them in **Setup** for your hardware.
- Blackmagic doesn't publish the ATEM XML format. The macro steps written here match what
  ATEM Software Control saves, but do a test restore on the real switcher before the show.
