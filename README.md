# EchoHorror — The Echo Maze

A sound-driven horror maze that runs in the browser (desktop and mobile). You are
trapped in near-total darkness. Send out echoes to see the maze — but blind
hunters track you by noise.

**New to the game?** Read [HOW_TO_PLAY.txt](HOW_TO_PLAY.txt) — a plain-language
guide to every mechanic, item and enemy.

## Run it

Open `index.html` directly, or serve the folder (recommended):

```
npm start        # http://localhost:8080  (no dependencies needed for this)
```

Headphones recommended. On phones and tablets, play in landscape — in portrait the game shows a "turn your device sideways" screen and pauses.

## Develop

```
npm install      # only needed for linting
npm test         # headless gameplay tests (Node 18+, no browser needed)
npm run lint     # ESLint
```

Project layout:

| File | What it is |
| --- | --- |
| `index.html` | Page markup: HUD, menus, settings panel, touch controls |
| `style.css` | All styling |
| `index.js` | The whole game: audio synth, maze generator, enemy AI, rendering, UI |
| `assets/` | Sprite sheets (player, Blood Monster enemy, Kenney tilemap) |
| `test/game.test.js` | Runs the real `index.js` in a stubbed browser and checks the rules |
| `scripts/serve.js` | Zero-dependency static server for `npm start` |

Progress, settings and key bindings are stored in the browser's `localStorage`
under the key `echohorror_v1`.

## Credits and licences

- **Tilemap sprites** (`assets/tilemap/`): [Kenney — Micro Roguelike](https://kenney.nl/assets/micro-roguelike),
  CC0 1.0 (public domain).
- **Player run-cycle sheets** (`assets/Character_*`) and **Blood Monster A**
  enemy sheets (`assets/enemy/`): third-party art packs. **The original author
  and licence for these were not recorded in this repository.** Before you
  publish or distribute the game, add the artist's name, source URL and licence
  here, and confirm the licence allows your use.
- Everything else (code, procedural audio, level design, story text) is part of
  this project. No project licence has been chosen yet — add a `LICENSE` file
  when you decide.
# echo-horror
