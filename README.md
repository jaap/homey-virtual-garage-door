# Virtual Garage Door for Homey

Make your garage door a **real garage door in Homey** — even though it is actually a relay and a contact sensor. The device is a proper Homey `garagedoor` device, so HomeKit bridges such as [HomeKitty](https://github.com/robertklep/name.klep.homekitty) show it in Apple Home as a genuine garage-door accessory, with Siri, CarPlay and automations included.

Works with any hardware Homey can see: Shelly or other relays, Aqara/Zigbee/Z-Wave contact sensors, wired sensors — this app never talks to specific brands.

## Three ways to use it

**Managed mode (recommended for most doors).** You pick the relay that triggers your door, the sensor that detects "fully closed", optionally a second sensor for "fully open", and how long the door takes to travel. The app then operates the door and tracks its state by itself. **No Flows needed.**

**Auto-closing gate mode (for shared entrance gates).** For gates that open on a pulse and close again by themselves, with no sensors at all: pick only the relay and three times, and the app animates the open→hold→close cycle on timers. Every trigger simply means "open / stay open".

**Flow controlled mode (maximum control).** The device is a pure shell: when someone asks it to open or close, it only fires a Flow trigger, and its state only changes when your own Advanced Flows report it. All logic — safety checks, relay pulses, sensor interpretation — lives visibly in your Flows.

Modes can be mixed freely across devices, and you can have as many virtual garage doors as you have doors and gates.

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

1. Homey app → **Devices** → **+** → **Virtual Garage Door**.
2. Choose **Managed — no Flows needed**.
3. Pick your relay, your closed sensor, optionally your open sensor, and enter the travel time.
4. For each sensor, tell the app what "at the endpoint" looks like: *the door is fully closed when this sensor reports contact closed* (the normal case) or *contact open* (if your sensor is mounted the other way around).
5. Add the device, name it (e.g. "Garage"), done.

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

1. Devices → **+** → Virtual Garage Door → **Auto-closing gate — timer only**.
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

Choose **Flow controlled** when adding the device. The contract is simple:

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

* Tap **Open** in Apple Home: Home shows **"Opening…"** (its own rendering of target ≠ current) until the door's state actually changes to Open. This works because the app deliberately *rejects* the direct capability write after handling it as a request — HomeKitty swallows the rejection by design, keeping the transient alive. When the app later reports/confirms the state, both HomeKit characteristics update together.
* Transitional honesty has limits inherited from the one-boolean mapping: `opening`, `closing` and `stopped` all read as "not closed", so Apple Home shows **Open** for anything that isn't fully closed, and movements initiated *outside* HomeKit jump straight between Closed and Open. HomeKitty never emits HomeKit's OPENING/CLOSING/STOPPED current-states, and device warnings don't reach HomeKit.
* The custom `garagedoor_state` sensor is invisible to HomeKitty (extra capabilities are ignored by its mapper) and cannot break the mapping.

No HomeKit-specific code exists in this app; it simply exposes exactly the class + capability HomeKitty wants.

---

## Good to know

* **States** are `Closed`, `Opening`, `Open`, `Closing` and `Stopped` (didn't reach an endpoint / position uncertain). The device tile shows the full state; the standard *Closed* toggle reflects only fully-closed.
* **Persistence:** the state survives restarts and reboots. Flow mode restores the last *reported* state; Managed mode re-checks the sensors. Neither mode ever generates open/close commands by itself at startup.
* **Warnings** on the device (yellow banner) mean: sensors contradict each other, the door missed its travel window, or a configured device is missing — the warning text says which, and *Repair* fixes configuration issues.
* **Safety:** the only thing this app ever does to your hardware is switch the control device **on** when you ask the door to move (Managed mode). Pulse length, interlocks and anything more belong to the relay and your own setup. In Flow mode it touches nothing at all.
* **Multiple doors:** add as many devices as you like; each has its own mode and configuration.

## Installation

Install with the [Homey CLI](https://apps.developer.homey.app/the-basics/getting-started):

```sh
npm install --global homey   # the Homey CLI
npm install                  # dependencies; also generates the PNG images
homey login
homey app install
```

> The PNG images referenced by the app manifest are generated deterministically
> by `scripts/generate-images.js` (Node built-ins only) during `npm install`,
> so the repository stays text-only.

## Development

```sh
npm install        # dependencies (homey-api) + dev dependencies (Jest)
npm test           # unit tests
npm run validate   # homey app validate --level publish (requires the Homey CLI)
```

The core logic lives in two pure reducers (no timers, no I/O): `lib/garage-state-machine.js` for sensor-based Managed mode — one sensor, two sensors, manual operation, timeouts, restart reconciliation, conflicting sensors and command guarding — and `lib/gate-cycle-machine.js` for the simulated auto-closing gate cycle. `test/device-managed.test.js` and `test/device-gate.test.js` exercise the Homey wiring against a mocked Homey Web API (`homey-api`), `test/device.test.js` covers Flow mode's request/report contract, and `test/manifest.test.js` guards against drift between the compose files and the code.

Cross-device access (Managed mode) uses the official [`homey-api`](https://www.npmjs.com/package/homey-api) client with the `homey:manager:api` permission: `makeCapabilityInstance` for realtime sensor updates and `setCapabilityValue` for the relay pulse — the same mechanism HomeKitty uses.
