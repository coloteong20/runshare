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
