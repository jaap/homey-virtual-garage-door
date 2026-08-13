# Virtual Garage Door for Homey

[![Tests](https://github.com/jaap/homey-virtual-garage-door/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/jaap/homey-virtual-garage-door/actions/workflows/test.yml)

Make your garage door a **real garage door in Homey** — even though it is actually a relay and a contact sensor. The device is a proper Homey `garagedoor` device, so HomeKit bridges such as [HomeKitty](https://github.com/robertklep/name.klep.homekitty) show it in Apple Home as a genuine garage-door accessory, with Siri, CarPlay and automations included.

Works with any hardware Homey can see: Shelly or other relays, Aqara/Zigbee/Z-Wave contact sensors, wired sensors — this app never talks to specific brands.

## ⚠️ Disclaimer — use entirely at your own risk

This app operates and reports on **physical access to your home**. Read this before wiring it to anything:

* The software is provided **"as is", without warranty of any kind** (see [LICENSE](LICENSE)). The author accepts **no liability whatsoever** for anything this app does or fails to do — doors left open, doors that would not open, unexpected movement, missed or wrong states, a failed presence check, or Homey / HomeKitty / HomeKit behaving differently than this app assumes.
* **A tile is software, not a lock.** Never treat "Closed" on a screen as proof that your door is closed, and never rely on this app as a security measure. If it matters, verify physically.
* **Test your own setup thoroughly** — sensors, timings, restrictions, HomeKit behavior — before trusting it with anything you care about, and re-test after updates.
* In short: if your garage door is left open all night, that is on you, not on this project. Don't come crying — come with a pull request.

If you can't accept that, don't use this app. If you can: it's MIT-licensed, so you are free to fork it and do whatever you like with it.

## Three device types

When you add a device, the app offers three separate types — each with only its own settings and setup steps:

**Garage Door (Managed)** — recommended for most doors. You pick the relay that triggers your door, the sensor that detects "fully closed", optionally a second sensor for "fully open", and how long the door takes to travel. The app then operates the door and tracks its state by itself. **No Flows needed.**

**Auto-closing Gate** — for shared entrance gates that open on a pulse and close again by themselves, with no sensors at all: pick only the relay and three times, and the app animates the open→hold→close cycle on timers. Every trigger simply means "open / stay open".

**Garage Door (Flow controlled)** — maximum control. The device is a pure shell: when someone asks it to open or close, it only fires a Flow trigger, and its state only changes when your own Advanced Flows report it. All logic — safety checks, relay pulses, sensor interpretation — lives visibly in your Flows.

Mix types freely and add as many devices as you have doors and gates. All types share the same Flow cards.

> **Upgrading from v0.4 or earlier?** The old combined device type (with the mode setting) was removed. Delete your old Virtual Garage Door devices and add them again as the new types — then re-assign their HomeKit rooms and re-select the devices in any Flows that used them.

---

## Setting up Managed mode

### Before you start

You need, already working in Homey:

1. **A relay that triggers the door** — any device with an on/off switch (a Shelly wired to the opener's dry contact, for example).
   ⚠️ **Set the relay itself to switch off automatically** after ~0.5 s ("auto-off", "timer" or "momentary" in the relay's own settings). This app only switches it **on** — the relay must release by itself, so the pulse keeps working even if Homey is busy.
2. **A contact sensor that closes when the door is fully closed** — an Aqara/any door sensor mounted so it triggers only in the fully-closed position.
3. Optional: **a second sensor at the fully-open position**. With one sensor the app can *know* "closed" and must *infer* "open" from travel time; with two sensors both ends are known for certain.

Also time your door once with a stopwatch: how many seconds from fully closed to fully open? Add 10–20% — that is your **travel time** (door takes ~15 s → enter 18).

### Adding the door

1. Homey app → **Devices** → **+** → **Virtual Garage Door** → **Garage Door (Managed)**.
2. Pick your relay, your closed sensor, optionally your open sensor, and enter the travel time.
3. For each sensor, tell the app what "at the endpoint" looks like: *the door is fully closed when this sensor reports contact closed* (the normal case) or *contact open* (if your sensor is mounted the other way around).
4. Add the device, name it (e.g. "Garage"), done.

Tap the tile: the relay pulses, the state shows *Opening*, and then *Open* — confirmed by your sensor if you have one at the top, otherwise when the travel time has passed. In Apple Home (via HomeKitty) the door appears as a real garage door.

**Wrong way around?** If the device shows *Open* while the door is really closed, flip *"The door is fully closed when the sensor reports…"* in the device settings — no need to remount anything.

**Changing devices later:** device settings → **Maintenance → Repair** re-opens the configuration. Travel time and sensor meaning can be changed directly in the settings.

### What Managed mode does (and refuses to do)

* **Sensors are the truth.** Reaching an endpoint always wins, whoever moved the door — wall button, car remote and neighbour included. Leaving an endpoint without a command is treated as movement in the obvious direction (a closed door whose sensor releases is *Opening*).
* **Travel time is a watchdog, not a claim.** With two sensors, a door that doesn't reach its endpoint in time becomes **Stopped**, the device shows a warning, and the *"door failed to reach its position"* Flow trigger fires. The app never claims *Closed* from a timer — only the closed sensor can say that. With one sensor, *Open* after opening is the one honest inference it makes (and it is documented as such).
* **Careful with pulses.** Requests are ignored with a clear message when the door is already there, already moving (a pulse mid-travel means stop/reverse/who-knows depending on the opener), or when the sensors contradict each other (both endpoints at once = check your setup). From **Stopped**, a new request pulses and assumes the direction you asked for; the sensors then correct it at the next endpoint.
* **After a restart** the app re-reads the sensors and settles conservatively; between endpoints it reports **Stopped** rather than guessing (with a single sensor, a door last known open stays *Open*). It never pulses the relay by itself — not at startup, not ever, except when you ask it to move.

---

## Setting up an auto-closing gate

Typical example: the shared entrance gate of an apartment building. A pulse makes it open (~10 s), it stays open for a while (~30 s), then closes by itself (~10 s) — and pressing the button again *always* means "up": while closing it reverses, while open it stays open longer. There is no sensor and none is needed.

1. Devices → **+** → Virtual Garage Door → **Auto-closing Gate**.
2. Pick the relay that triggers the gate (auto-off configured on the relay itself, as always).
3. Enter the three times. Two good ways to fill them in:
   * **Honest:** the real values (e.g. 10 / 30 / 10). The tile mirrors what the gate is actually doing.
   * **Quick-reset trick:** short values like **3 / 3 / 1**. The tile plays a brief open-and-close animation and is back on *Closed* within ~7 seconds — ready to be triggered again immediately. That matters for Apple Home: the HomeKit garage tile only accepts a new *Open* once it shows *Closed*, so short times turn the accessory into a repeatable gate button with nice visual feedback.

What you get:

* **Kicks are first-class.** Gate devices have an extra **"Open / keep open" button** on the device, tappable in *any* state — while opening (gate ignores it, clock restarts), while open (gate holds longer), while closing (gate reverses up). The *Request to open* Flow card does the same, so widgets and automations can kick too.
* **Close requests are refused** with "this gate closes by itself" — the hardware has no close command, and the app never pretends otherwise.
* **The shown state is a simulation of *your* triggers.** Nobody's sensors are watching this gate: when a neighbour opens it with their fob, the tile stays on Closed. For a shared gate that's exactly the point — the tile answers "did my open work", not "what is the gate doing right now".
* After a restart the gate always shows Closed (a restart outlives the cycle), and the app never pulses on its own.

---

## Setting up Flow controlled mode

Add a **Garage Door (Flow controlled)** device. The contract is simple:

* When anything (Apple Home, the tile, a Flow) asks the door to move, the device fires **"Open was requested"** / **"Close was requested"** — and nothing else happens. In the Homey app you'll see "Open requested — waiting for a Flow to report the actual state"; that message is by design.
* The state changes **only** when a Flow runs **"Report the door state as …"** (Closed / Opening / Open / Closing / Stopped).

One Advanced Flow canvas per door covers a Shelly + one Aqara closed-sensor setup:

```text
Lane 1  [Door] Open was requested
          IF [Door] Is closed → pulse relay → Report as Opening
          ELSE                → Report as Open          (settles Apple Home)

Lane 2  [Door] Close was requested
          IF [Door] is open   → pulse relay → Report as Closing
          ELSE                → Report as Closed

Lane 3  [Sensor] contact became closed → Report as Closed

Lane 4  [Sensor] contact became open   → Report as Opening
          (delay ≈ travel time) IF contact still open → Report as Open
```

Lanes 3–4 are unconditional ground truth: they keep the door honest when someone uses the wall button, and they re-sync everything after reboots. Add your own safety conditions to lanes 1–2. If a Flow denies a request, report the current state again — that snaps Apple Home out of "Opening…".

---

## Flow cards

**Triggers (WHEN)** — both modes:

* **Open was requested** / **Close was requested** — someone or something asked for movement. In Managed mode these are informational (the app already handles the request).
* **The door state changed** — with a `State` tag (`closed`, `opening`, `open`, `closing`, `stopped`).
* **The door failed to reach its position** — Managed mode's travel-time watchdog, with a `Direction` tag. Perfect for a notification Flow.
* Built-in: *Closed* / *Opened* triggers and the *Is closed* condition come free with every garage door in Homey.

**Actions (THEN)** — both modes:

* **Request to open** / **Request to close** — ask for movement, exactly like the tile or Apple Home would. In Managed and gate modes this operates the door (for gates, *Request to open* is the kick and *Request to close* fails with "closes by itself"); in Flow mode it fires the request trigger. (The built-in *Open/Close/Toggle* cards work too but report the informational message as a card error.)
* **Report the door state as …** — in Flow mode this is *the* way state changes; in Managed mode it is an escape hatch that overrides the state machine (it also cancels a running travel timer).

---

## Apple Home / HomeKitty

Verified against HomeKitty 2.5.8 source. HomeKitty maps any device with class `garagedoor` + capability `garagedoor_closed` to a HomeKit **GarageDoorOpener**; both `CurrentDoorState` and `TargetDoorState` derive from that one boolean (`true` → Closed, `false` → Open), and a HomeKit Open/Close writes back into the same capability — which this app treats as a request.

What you will see in Apple Home:

* Tap **Open**: Home shows **"Opening…"** for the whole travel window, then "Open". Two mechanisms make this work: the app *rejects* the direct capability write after handling it as a request (HomeKitty swallows the rejection by design), and while the state is `opening` the `garagedoor_closed` value **holds at closed** until the door actually — or, with one sensor, presumably — arrives ("endpoint-hold"). An open sensor ends the window early; otherwise the travel time does.
* Tap **Close**: Home shows **"Closing…"** until the closed sensor confirms, because the value stays "not closed" during the whole closing phase. This side needs no tricks.
* Limits of the one-boolean mapping: `stopped` reads as "Open"; movements started *outside* HomeKit (wall button, remote) don't produce a transient — the tile stays on the old endpoint until the movement completes (a manually opened door reads "Closed" until it is fully open); HomeKitty never emits HomeKit's native OPENING/CLOSING/STOPPED current-states; and device warnings don't reach HomeKit.
* The custom `garagedoor_state` sensor and the gate's button are invisible to HomeKitty (extra capabilities are ignored by its mapper) and cannot break the mapping.

No HomeKit-specific code exists in this app; it simply exposes exactly the class + capability HomeKitty wants.

---

## Only open when someone is home

Every door and gate has a **Restrictions** setting — *"Opening the door is…"* — with three choices:

* **Always allowed** (default): no presence check at all.
* **Only when someone is home — refused when Homey cannot tell**: the strict choice. If nobody is marked home, *or the presence lookup fails*, opening is refused with a clear message. Pick this when the restriction is a security measure that must not have gaps.
* **Only when someone is home — allowed when Homey cannot tell**: the lenient choice. Blocks while nobody is home, but gives the benefit of the doubt when presence cannot be determined — a glitch never locks you out of your own garage.

With either home-only choice, the app checks Homey's user presence before acting on any open request — Apple Home, the device tile, the kick button, and the Flow request cards alike. The check runs *before* the request triggers fire, so in Flow controlled mode your Flows never even hear a blocked request.

Worth knowing:

* **"Home" means Homey's own user presence** (set by the Homey app's location services or by toggling yourself home/away manually in the Homey app) — not your phone's Wi-Fi. Switching off Wi-Fi or location sharing does not mark you away; it just freezes your last known presence, so Homey most likely still considers you home. Test the restriction by setting yourself to Away in the Homey app.
* **Closing is never blocked** — you always want to be able to close, especially when away. That also means the strict choice can never lock you out of *closing*; the worst case is having to open with your physical remote.
* It governs this virtual device only; physical remotes and wall buttons are outside the app's reach.
* Devices configured with the old checkbox are migrated automatically: checkbox on becomes the lenient choice (its documented behavior), checkbox off becomes *Always allowed*.
* If Apple Home shows a stuck "Opening…" after a blocked attempt, tap the tile once more to settle it back to Closed.

## Good to know

* **States** are `Closed`, `Opening`, `Open`, `Closing` and `Stopped` (didn't reach an endpoint / position uncertain). The device tile shows the full state. The standard *Closed* toggle holds its old value while opening (see the HomeKitty section), which also means Homey's built-in *Opened* trigger now fires when the door is fully open, not when it starts moving.
* **Persistence:** the state survives restarts and reboots. Flow mode restores the last *reported* state; Managed mode re-checks the sensors. Neither mode ever generates open/close commands by itself at startup.
* **Warnings** on the device (yellow banner) mean: sensors contradict each other, the door missed its travel window, or a configured device is missing — the warning text says which, and *Repair* fixes configuration issues.
* **Safety:** the only thing this app ever does to your hardware is switch the control device **on** when you ask the door to move (Managed mode). Pulse length, interlocks and anything more belong to the relay and your own setup. In Flow mode it touches nothing at all.
* **Multiple doors:** add as many devices as you like; each has its own mode and configuration.

## Installation

Install with the [Homey CLI](https://apps.developer.homey.app/the-basics/getting-started):

```sh
npm install --global homey   # the Homey CLI
npm install                  # dependencies
homey login
homey app install
```

## Development

```sh
npm install        # dependencies (homey-api) + dev dependencies (Jest)
npm test           # unit tests
npm run validate   # homey app validate --level publish (requires the Homey CLI)
npm run images     # regenerate the manifest PNGs after changing the artwork
```

The core logic lives in two pure reducers (no timers, no I/O): `lib/garage-state-machine.js` for sensor-based Managed mode — one sensor, two sensors, manual operation, timeouts, restart reconciliation, conflicting sensors and command guarding — and `lib/gate-cycle-machine.js` for the simulated auto-closing gate cycle. `test/device-managed.test.js` and `test/device-gate.test.js` exercise the Homey wiring against a mocked Homey Web API (`homey-api`), `test/device.test.js` covers Flow mode's request/report contract, and `test/manifest.test.js` guards against drift between the compose files and the code.

Cross-device access (Managed mode) uses the official [`homey-api`](https://www.npmjs.com/package/homey-api) client with the `homey:manager:api` permission: `makeCapabilityInstance` for realtime sensor updates and `setCapabilityValue` for the relay pulse — the same mechanism HomeKitty uses.

## Releasing to the Homey App Store

Publishing a GitHub release ships that build to the Homey App Store automatically (`.github/workflows/publish.yml`).

One-time setup: create a Personal Access Token at [tools.developer.homey.app/me](https://tools.developer.homey.app/me) and add it as the repository secret **`HOMEY_PAT`** (Settings → Secrets and variables → Actions).

Per release:

1. `npm run set-version 0.6.0` — updates the version everywhere it lives — then commit, push, and wait for CI to go green.
2. Create a GitHub release with tag **`v0.6.0`** (must match the version — the workflow refuses mismatches). The release notes become the App Store changelog.
3. The workflow tests, validates and publishes the build as a **draft** to the [developer dashboard](https://tools.developer.homey.app/apps), where you promote it:
   * **Test** — live immediately, installable by anyone with the link `https://homey.app/a/com.jaap.virtualgaragedoor/test/`. This is also the easiest way to update your own Homey over the air, no CLI needed.
   * **Live** — requires Athom certification; expect a longer review because of the `homey:manager:api` permission.

## License

[MIT](LICENSE) — free to use, fork, modify and redistribute, commercially or otherwise. No warranty, no liability; see the disclaimer at the top. If you build something better on top of it, enjoy.
