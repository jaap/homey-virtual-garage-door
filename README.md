# Virtual Garage Door for Homey

A Homey Pro app that provides a generic **virtual garage door** device, so that arbitrary existing Homey devices and Advanced Flows can be composed into a proper `garagedoor` device — one that HomeKit bridges such as [HomeKitty](https://github.com/robertklep/name.klep.homekitty) expose to Apple Home as a real garage door accessory.

The app has **no knowledge of your hardware**. All communication between the virtual garage door and the physical world happens through Homey Flow cards:

```text
Apple Home
    ↕
HomeKitty
    ↕
Virtual Garage Door   ←  this app
    ↕
Homey Advanced Flows
    ↕
Arbitrary hardware
    ├── Shelly / relay / smart switch
    └── Aqara / Zigbee / Z-Wave / wired sensors / etc.
```

## Design principle: commands and observations are separate

A request to open the garage does **not** mean the garage is open.

* When Apple Home, the Homey app, or a Flow asks the door to open or close, the device only emits a Flow trigger (**"Open was requested"** / **"Close was requested"**). Its state does not change.
* The state of the virtual garage door only changes when your Flow explicitly reports it back with the **"Report the door state"** action card (Closed / Opening / Open / Closing).

Technically, the device *rejects* every direct write to its `garagedoor_closed` capability after emitting the request trigger, so Homey never commits a state that no sensor confirmed. In the Homey app this shows up as a short message when you tap the tile ("Open requested — waiting for a Flow to report the actual state") — that is by design, and it is exactly what makes Apple Home behave correctly (see the HomeKitty section).

All safety logic and hardware interpretation stays visible and configurable in your Advanced Flows:

```text
Apple Home requests OPEN
        ↓
Virtual Garage Door triggers "Open was requested"
        ↓
Advanced Flow checks safety/state, pulses the relay
        ↓
Advanced Flow reports OPENING
        ↓
Physical sensor eventually confirms position
        ↓
Advanced Flow reports OPEN
```

## Device model

Each Virtual Garage Door device is a standard Homey `garagedoor`-class device with:

| Capability | Type | Role |
|---|---|---|
| `garagedoor_closed` | boolean (standard Homey capability, `true` = closed) | The device's main control and the last **reported** closed-state. Any attempt to set it (device tile, Apple Home, built-in Flow cards) is converted into a *request trigger* and rejected. |
| `garagedoor_state` | enum: `closed`, `opening`, `open`, `closing` (custom, read-only sensor) | The full last **reported** state, visible on the device and usable in Flows. |

There is no standard Homey capability for garage-door travel state — `garagedoor_closed` is the only `garagedoor_*` capability among Homey's 184 standard capabilities, and nothing standard models opening/closing for doors (`windowcoverings_state`'s `up`/`idle`/`down` cannot distinguish *open* from *closed* when idle). The read-only `garagedoor_state` enum is therefore the one custom capability this app defines. `garagedoor_closed` remains the single source of truth for every integration that consumes standard capabilities (HomeKitty included); `garagedoor_state` is derived information for you and your Flows.

## Flow cards

**Triggers (WHEN):**

* **Open was requested** — someone or something asked the door to open.
* **Close was requested** — someone or something asked the door to close.
* **The door state changed** — a Flow reported a new state; the `State` tag contains `closed`, `opening`, `open` or `closing`.

**Actions (THEN):**

* **Report the door state as [Closed / Opening / Open / Closing]** — tell the device what is actually happening. This is the only way its state changes.
* **Request to open** / **Request to close** — emit the same request triggers that Apple Home or the device tile would, without an error result. Use these when another Flow wants to operate the door.

**Built-in cards you get for free** (Homey generates them for every device with `garagedoor_closed`):

* Triggers: *Closed* / *Opened* — fire when the **reported** state changes.
* Condition: *Is closed / open* — checks the **reported** state.
* Actions: *Close* / *Open* / *Toggle* — these go through the same request path; they work, but the card will report the "waiting for a Flow" message as an error, because the app refuses to change state without a report. In Flows, prefer **Request to open/close**.

## Example: single closed-sensor setup (Shelly relay + Aqara contact sensor)

With only a fully-closed sensor you know *Closed* for certain; everything else is interpretation, and that interpretation belongs in your Flow:

```text
WHEN  Virtual Garage Door: Open was requested
AND   (optional safety conditions)
THEN  Pulse the Shelly relay
      Virtual Garage Door: Report the door state as Opening
      (optionally: after ~20 s, Report the door state as Open)

WHEN  Virtual Garage Door: Close was requested
AND   Aqara sensor: contact is open        ← door is not already closed
THEN  Pulse the Shelly relay
      Virtual Garage Door: Report the door state as Closing

WHEN  Aqara sensor: contact became closed
THEN  Virtual Garage Door: Report the door state as Closed

WHEN  Aqara sensor: contact became open
THEN  (if you did not just request anything: someone used the wall button / remote)
      Virtual Garage Door: Report the door state as Opening or Open — your call
```

If a request should be **denied** (a safety condition failed), report the current state again — that snaps Apple Home out of its "Opening…"/"Closing…" display.

Later, if you add a second (fully-open) sensor, only your Flows change — the virtual device stays exactly the same.

## HomeKitty / Apple Home

Verified against HomeKitty 2.5.8 (app id `name.klep.homekitty`, actively maintained). What HomeKitty expects, from [`lib/maps/garagedoor.js`](https://github.com/robertklep/name.klep.homekitty/blob/main/lib/maps/garagedoor.js):

* A device with **class `garagedoor`** (or virtual class) and a UI-visible **`garagedoor_closed`** capability — exactly what this app provides. Extra capabilities are ignored by the mapper, so the custom `garagedoor_state` sensor is invisible to HomeKit and cannot break the mapping.
* The device is exposed as a HomeKit **GarageDoorOpener** service. Both `CurrentDoorState` and `TargetDoorState` are derived from the one boolean: `true` → Closed, `false` → Open. A HomeKit *Open/Close* command writes `TargetDoorState`, which HomeKitty translates into `setCapabilityValue('garagedoor_closed', …)` on our device — invoking our capability listener, i.e. the request path.
* HomeKitty never sets the HomeKit `OPENING`/`CLOSING`/`STOPPED` states itself, and both characteristics move together whenever the capability changes on the Homey side.

How the pieces interact, and why this app rejects direct writes:

1. You tap **Open** in Apple Home. HomeKit stores `TargetDoorState = Open` while `CurrentDoorState` is still Closed, so Apple Home shows **"Opening…"** (Apple renders this whenever target ≠ current).
2. HomeKitty calls `setCapabilityValue('garagedoor_closed', false)`. Our device fires **Open was requested** and rejects the write; HomeKitty deliberately swallows the rejection. Because the capability did not change, no update reaches HomeKit — target stays Open, current stays Closed, and "Opening…" keeps showing. (If the app committed the value instead, HomeKitty would immediately move *both* characteristics and Apple Home would claim the door is open the instant you asked.)
3. Your Flow pulses the relay and reports **Opening** → `garagedoor_closed` stays `false`… and eventually reports **Open**. The capability change reaches HomeKitty, both characteristics become Open, and Apple Home settles on "Open".
4. Closing mirrors this with "Closing…" until your Flow reports **Closed**.

Known limitations of the stock mapping (inherent to `garagedoor_closed` being one boolean):

* "Opening…"/"Closing…" only appears for **HomeKit-initiated** actions. When the door is operated from the Homey side (wall button, Flow), Apple Home jumps straight between Closed and Open at the moment your Flow reports it.
* Because `opening`/`closing` map to `false` (not closed), Apple Home shows "Open" during a report-driven transition rather than a moving state — honest, just less pretty.
* If your Flow denies a request and reports nothing, Apple Home can keep showing "Opening…" until the next actual state change. Have the Flow re-report the current state to settle it.
* HomeKitty caches a HomeKit-written target value internally, so an explicit Home-app refresh during a pending request may briefly read the target instead of the actual state; the next report corrects it.
* Keep the device's capability set stable: HomeKitty removes and re-adds the accessory when a device's capabilities change, which resets its HomeKit room/automation assignments.

ObstructionDetected: HomeKitty's mapping optionally wires it to an `alarm_generic` capability. This app does not include it in v0.1 (it would show a permanent alarm sensor on the device for a state nothing reports yet); it is a candidate for a future version — with the accessory-reset caveat above in mind.

## Persistence

The reported state survives app restarts and Homey reboots. On startup the device restores the **last reported state** — it does not verify the physical door and it never emits open/close requests by itself. Because requests are rejected rather than committed, a restart can never resurrect an unconfirmed request either. If your hardware may have moved while Homey was down, let your Flows report the state again (e.g. a Flow triggered by the sensor, or a periodic sync Flow).

## Pairing

1. Devices → Add device → Virtual Garage Door.
2. Add it, give it a name.
3. Done — add as many virtual garage doors as you like.

## Installation

Install with the [Homey CLI](https://apps.developer.homey.app/the-basics/getting-started):

```sh
npm install --global homey   # the Homey CLI
npm install                  # dev dependencies; also generates the PNG images
homey login
homey app install
```

> The PNG images referenced by the app manifest are generated deterministically
> by `scripts/generate-images.js` (Node built-ins only) when you run
> `npm install` (the `prepare` script), so the repository itself stays text-only.

## Development

```sh
npm install        # dev dependencies (Jest)
npm test           # unit tests
npm run validate   # homey app validate --level publish (requires the Homey CLI)
```

The tests mock the `homey` runtime module (`test/mocks/homey.js`) and simulate Homey Core's contract for capability listeners — commit on resolve, discard on reject — so the request/report state machine is exercised exactly as it behaves on a real Homey. `test/manifest.test.js` additionally guards against drift between the compose files and the code (for example a Flow dropdown state the device would reject).

## Safety

This app never autonomously operates physical hardware. It only:

1. represents the virtual garage door,
2. emits requested state changes as Flow triggers,
3. accepts reported state changes from Flow actions.

Whatever pulses your relay — and whatever decides it is safe to do so — is your Advanced Flow, where you can see and change it.
