# APC40 mkII bridge for Sequins Patches

A small Node program that turns an Akai APC40 mkII into a clip launcher and mixer for
[Sequins Patches](https://sequins.music). It talks to the Patches daemon over its socket
(line-delimited JSON-RPC, `patches/1`) and to the controller over CoreMIDI.

The button layout and the LED handling follow the APC40 session mode of
[DrivenByMoss](https://github.com/git-moss/DrivenByMoss) by Jürgen Moßgraber (LGPLv3). This
bridge is a port of that behaviour, so it is offered under the same licence.

## What it does

| Control | Action |
|---|---|
| 5x8 grid | Launch the clip (notes 0..39 on channel 0, row 0 at the bottom). Amber = stopped, green = playing, blinking green = queued |
| Scene buttons | Launch the scene |
| Clip stop (per track), Stop all clips | Stop |
| Play, Stop | Transport |
| Arrow keys | Scroll the grid by 8 tracks / 5 scenes |
| Record, Session | Toggle recording |
| Metronome | Toggle the click |
| Dev. Lock | Cycle the global launch quantise |
| Nudge | Undo / redo |
| Tempo knob, Tap tempo | Tempo (0.5 BPM per click), tap average of the last 5 taps |
| Cue level knob | Move the playhead a bar per click |
| Select (per track), Master | Select the track / the Master in the Patches window |
| Rec, Solo, Mute (per track) | Native `map note` on the virtual port, LEDs follow the mixer |
| Device left / right | Select the previous / next module of the selected track |
| Dev. On/Off | Toggle `<module>.on` of the selected module |
| Pan, Sends, User | Mode of the 8 track knobs: pan, send 1/2 (press Sends again to cycle), or free (CC 102..109) |
| Bank left / right | Page of the 8 device knobs (CC 16..23, 24..31, 110..117, 118..125). Rings remember each page |
| Bank (big button) | Sample browser on a sample / loop / kit module, else cycle the window view |
| Faders, master, crossfader, foot pedals | Forwarded as CCs |

Knobs, faders and buttons that are not launcher actions leave through a virtual MIDI port
named **APC40 Knobs**. Open it in Patches (`midi in "APC40 Knobs"`) and map with ⌘M or
`map cc 102 port "APC40 Knobs" -> lead.brilho`. Every mapping is bound to that port, so
nothing collides with another controller.

Not implemented: the crossfader and the per-track A/B assign (Patches has no crossfader),
Shift.

## Run

```sh
npm install
node bridge.js
```

It keeps trying until the APC40 mkII is there and waits for the Patches daemon.

### Lifetime

The bridge quits by itself 10 seconds after Patches goes away (30 seconds are allowed to find
Patches when it starts), and puts the controller back in generic mode. Start it with
`./start.sh` (or `npm start`) once Patches is open.

To start it automatically with Patches, `com.example.apc40-patches-bridge.plist` is a launchd
agent template: it starts the bridge whenever the Patches socket exists and keeps it alive until
the socket goes away. Fill in the three placeholders, then:

```sh
NODE=$(command -v node)   # the real binary, not a version-manager shim
SOCKET="$HOME/Library/Application Support/Sequins Patches/run/patchesd.sock"
sed -e "s#__NODE__#$NODE#" -e "s#__DIR__#$PWD#g" -e "s#__SOCKET__#$SOCKET#" \
  com.example.apc40-patches-bridge.plist > ~/Library/LaunchAgents/com.example.apc40-patches-bridge.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.apc40-patches-bridge.plist
```

## How it works

- The controller is switched to Ableton mode with the SysEx `F0 47 7F 29 60 00 04 41 08 02 01 F7`
  (sent twice: the device can miss it right after the port opens).
- LEDs are note-ons: the pad `n` (0..39) on channel 0, the colour in the velocity (the mkII
  palette of DrivenByMoss' `APCColorManager`).
- The bridge connects as a plain `cli` client, not as an agent, so Patches does not pace its
  changes at the "watch" speed.
- Pan / Send / Track buttons are re-pointed by reading `patch.export`, unmapping what is
  there and mapping what is wanted. A new `map` moves its target off the old control, so
  every unmap goes before the maps.
- Arm, solo and mute changes are polled every 300 ms (they do not always produce an event);
  a press updates the LED at once and the poll corrects it.

## Ideas for Patches itself

See the feedback sent to Sequins with this code: `map` targets for launcher actions, a way
to send MIDI/SysEx and controller feedback, a lightweight "set param live" call for external
controllers, controller profiles, and a crossfader.
