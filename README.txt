Virtual Garage Door turns the parts you already have, a relay, a contact sensor, your Flows, into a proper garage door device in Homey, with honest states: the door only counts as closed when a sensor says so, never just because someone pressed a button.

The Flow-controlled door lets you wire up the behaviour yourself with Advanced Flows. The device fires "open requested" and "close requested" triggers and only changes state when your Flows report it, which makes it work with any hardware combination. The Managed door does the work for you: select the on/off device that pulses your opener and the contact sensor that detects when the door is closed, optionally add a second sensor for fully open, set the travel time, done. The app runs the full state machine, from opening, open, closing and closed to stopped, including travel timeouts, manual operation and contradicting sensors. The Auto-closing gate is made for gates and barriers that always open on a pulse, hold briefly and then close on their own. Press again while it is open to keep it open, and all timings are configurable.

Works nicely with Apple Home through the HomeKitty app, including a sensible "Opening" display while the door travels. An optional restriction only allows opening when someone is home according to Homey, either strictly or leniently, while closing is always allowed.

The app never operates your hardware on its own. It only switches your control device at the moment you ask the door to move, and in Flow mode it touches nothing at all.

Use at your own risk: this is free, open-source software without any warranty. You remain responsible for your own door, gate and safety.
