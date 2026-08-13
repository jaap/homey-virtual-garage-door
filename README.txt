Virtual Garage Door turns the parts you already have — a relay, a contact sensor, your Flows — into a proper garage door device in Homey, with honest states: the door only counts as closed when a sensor says so, never just because someone pressed a button.

Pick from three device types:

• Flow-controlled door — you wire up the behaviour yourself with Advanced Flows. The device fires "open requested" / "close requested" triggers and only changes state when your Flows report it. Works with any hardware combination.

• Managed door — select the on/off device that pulses your opener and the contact sensor that detects "closed" (optionally a second sensor for "open"), set the travel time, done. The app runs the full state machine: opening, open, closing, closed and stopped, including travel timeouts, manual operation and contradicting sensors.

• Auto-closing gate — for gates and barriers that always open on a pulse, hold briefly, then close on their own. Press again while it is open to keep it open. All timings are configurable.

Works nicely with Apple Home through the HomeKitty app, including a sensible "Opening…" display while the door travels. An optional restriction only allows opening when someone is home according to Homey — closing is always allowed.

The app never operates your hardware on its own. It only switches your control device at the moment you ask the door to move, and in Flow mode it touches nothing at all.

Use at your own risk: this is free, open-source software without any warranty. You remain responsible for your own door, gate and safety. Support and source code: https://github.com/jaap/homey-virtual-garage-door
