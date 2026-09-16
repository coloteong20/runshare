# RunShare 🏃

**Plan a route. Share your live location. Run together — at your own pace.**

RunShare solves a simple problem: when you run with friends at different speeds, the slower runners never know whether to push forward or turn back. RunShare puts everyone on the same map, in real time.

---

## Features

- **Route planning** — click to plot a route snapped to real roads and paths
- **Live location sharing** — see everyone's position update in real time on the same map
- **ETA for every runner** — remaining distance and estimated finish time based on each person's actual pace
- **Stale location detection** — if someone's phone locks, a ghost marker shows their estimated position and flags when they were last seen
- **Password protection** — optional password so only your crew can join
- **End run** — the organiser can end the session for everyone at once
- **Run history** — past sessions saved for easy resharing

---

## How It Works

1. Go to the app and plot your route on the map
2. Name the run, set an optional password, hit **Create Run**
3. Share the link with your running crew
4. Everyone opens the link, taps **Join Run**, enters their name
5. Run — watch each other's dots move along the route in real time

---

## Stack

- **Mapbox GL JS** — maps and road-snapped routing
- **Firebase Realtime Database** — live location sync
- **Firebase Hosting** — deployment
- Vanilla HTML / CSS / JS — no build step

---

## Setup

1. Clone the repo
2. Copy `config.example.js` → `config.js` and fill in your keys:
   - [Mapbox](https://account.mapbox.com) — free public token
   - [Firebase](https://console.firebase.google.com) — Realtime Database + Hosting
3. Serve locally: `npx serve .`
4. Deploy: `firebase deploy`

> `config.js` is gitignored — never commit your keys.
> Note that the Firebase web config is *not* a secret: it ships to every browser
> that loads the app. What actually protects your data is the database rules.

## Tests

```
node --test test/
```

No dependencies — uses the test runner built into Node 18+. The geometry tests
cover route-snapping away from the equator, which is the case the original
flat-degree maths got wrong.

## iOS background location — a platform limit, not a bug

**On iOS, location sharing pauses when the screen locks or you switch apps.**
This cannot be fixed in a web app. iOS suspends a page's JavaScript when Safari
is backgrounded; `watchPosition` keeps its registration but no callback ever
runs. It is deliberate OS behaviour — the same mechanism that suspends WebRTC
and Web Audio at lock — and no web API escapes it: not service workers, not
background sync (which Safari does not implement), and not installing to the
home screen.

What the app does instead:

| | |
|---|---|
| **Holds the screen awake** | Screen Wake Lock (iOS 16.4+) while you are sharing, so the phone never locks in the first place. Tap the indicator in the header to allow sleeping and save battery. |
| **Recovers in one step** | On returning to the foreground it re-acquires the lock, restarts the watch (iOS may never revive the old one) and pushes a fresh fix immediately, rather than waiting for the watch's first callback. |
| **Says which happened** | A device that manages to flag itself on the way out shows as *phone locked* rather than *last seen*, so the crew can tell a pocketed phone from lost signal. |
| **Estimates meanwhile** | The existing ghost marker projects the runner forward along the route at their known pace. |

The only way to get true background tracking is a native wrapper (Capacitor or
similar) using Core Location's background mode. That is a different app, not a
change to this one.

## Database rules

`database.rules.json` holds a proposed hardened ruleset. It is **not** wired into
`firebase.json`, so it does not deploy by accident — read the header comment in
that file before adopting it.

Two things to know about the current deployed setup:

- **The run password is not enforced.** `run.js` downloads the session, password
  included, and compares it in the browser. Anyone who opens the link can read it
  from the network tab. Fixing this properly is what `database.rules.json` is for.
- **The link is the real secret.** Anyone with a run URL can see everyone's live
  position, so session ids are generated with `crypto.getRandomValues`.

---

## Live App

**[realtime-route-location.web.app](https://realtime-route-location.web.app)**
