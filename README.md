# Virtual Garage Door for Homey

A Homey Pro app that provides a generic **virtual garage door** device, so that arbitrary existing Homey devices and Advanced Flows can be composed into a proper `garagedoor` device — one that HomeKit bridges such as [HomeKitty](https://homey.app/a/it.robertklep.homekitty/) expose to Apple Home as a real garage door accessory.

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

This keeps all safety logic and hardware interpretation visible and configurable in your Advanced Flows:

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

If no Flow reports anything back, the device simply returns to its last reported state a moment after the request. The app never operates hardware and never guesses.

## Device model

Each Virtual Garage Door device is a standard Homey `garagedoor`-class device with:

| Capability | Type | Role |
|---|---|---|
| `garagedoor_closed` | boolean (standard Homey capability) | The device's main control and the last **reported** closed-state. Setting it (from the Homey app, Apple Home, or the standard "Close/Open the garage door" Flow action) is treated as a *request*. |
| `garagedoor_state` | enum: `closed`, `opening`, `open`, `closing` (custom, read-only sensor) | The full last **reported** state, visible on the device and usable in Flows. |

There is no standard Homey capability for garage-door travel state (opening/closing), so the read-only `garagedoor_state` enum is the one custom capability this app defines. `garagedoor_closed` remains the single source of truth for every integration that consumes standard capabilities (HomeKitty included); `garagedoor_state` is derived information for you and your Flows.

## Flow cards

**Triggers (WHEN):**

* **Open was requested** — someone or something asked the door to open.
* **Close was requested** — someone or something asked the door to close.

**Actions (THEN):**

* **Report the door state as [Closed / Opening / Open / Closing]** — tell the device what is actually happening. This is the only way its state changes.

The standard Homey cards for the `garagedoor_closed` capability (e.g. the built-in *Close/Open the garage door* action) act as another way to *request* movement — they run through the same request path and never change the reported state directly.

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

Later, if you add a second (fully-open) sensor, only your Flows change — the virtual device stays exactly the same.

## HomeKitty / Apple Home

*(See the "HomeKitty compatibility" section below for the exact mapping details.)*

## Persistence

The reported state survives app restarts and Homey reboots. On startup the device restores the **last reported state** — it does not verify the physical door and it never emits open/close requests by itself. If your hardware may have moved while Homey was down, let your Flows report the state again (e.g. a Flow triggered by the sensor, or a periodic sync Flow).

## Pairing

1. Devices → Add device → Virtual Garage Door.
2. Add it, give it a name.
3. Done — add as many virtual garage doors as you like.

## Installation

Install with the [Homey CLI](https://apps.developer.homey.app/the-basics/getting-started):

```sh
npm install --global homey
homey login
homey app install
```

## Safety

This app never autonomously operates physical hardware. It only:

1. represents the virtual garage door,
2. emits requested state changes as Flow triggers,
3. accepts reported state changes from Flow actions.

Whatever pulses your relay — and whatever decides it is safe to do so — is your Advanced Flow, where you can see and change it.
