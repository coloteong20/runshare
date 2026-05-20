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

---

## Live App

**[realtime-route-location.web.app](https://realtime-route-location.web.app)**
