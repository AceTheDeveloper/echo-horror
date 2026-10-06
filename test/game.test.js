// Headless tests: run the real index.js inside a stubbed "browser" (no DOM, no
// audio) and drive the game logic directly. Run with:  npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const SOURCE = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");
const HTML = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");

/** A value that accepts any property read / call / construction (canvas, audio nodes...). */
function makeStub() {
  const own = {};
  return new Proxy(function () {}, {
    get(_, prop) {
      if (prop === Symbol.toPrimitive) return () => 0;
      if (prop === "then") return undefined;
      if (prop in own) return own[prop];
      return makeStub();
    },
    set(_, prop, value) {
      own[prop] = value;
      return true;
    },
    apply: () => makeStub(),
    construct: () => makeStub(),
  });
}

function makeElement(id) {
  const classes = new Set(["hidden"]);
  const base = {
    id,
    style: {},
    dataset: {},
    innerText: "",
    innerHTML: "",
    value: "1",
    checked: false,
    offsetWidth: 0,
    width: 800,
    height: 800,
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      toggle: (c, force) => {
        const on = force === undefined ? !classes.has(c) : force;
        if (on) classes.add(c);
        else classes.delete(c);
        return on;
      },
      contains: (c) => classes.has(c),
    },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    getContext: () => makeStub(),
    closest: () => null,
    addEventListener() {},
  };
  return new Proxy(base, {
    get: (t, p) => (p in t ? t[p] : () => makeStub()),
    set: (t, p, v) => {
      t[p] = v;
      return true;
    },
  });
}

/** Boots a fresh copy of the game and returns helpers to poke at it. */
function boot() {
  const listeners = {};
  const elements = {};
  const storage = new Map();
  const unref = (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  };

  const sandbox = {
    console,
    performance,
    Math,
    JSON,
    Object,
    Array,
    Set,
    Map,
    Number,
    String,
    Float32Array,
    Uint8Array,
    Int32Array,
    Infinity,
    setTimeout: unref,
    clearTimeout,
    setInterval: (fn, ms) => {
      const t = setInterval(fn, ms);
      t.unref?.();
      return t;
    },
    clearInterval,
    requestAnimationFrame: () => 1,
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
    },
    AudioContext: function () {
      return makeStub();
    },
    Image: class {
      constructor() {
        this.naturalWidth = 600;
        this.naturalHeight = 100;
      }
      set src(v) {
        this._src = v;
        setTimeout(() => this.onload && this.onload(), 0).unref?.();
      }
      get src() {
        return this._src;
      }
    },
    innerWidth: 1000,
    innerHeight: 900,
    devicePixelRatio: 1,
    matchMedia: () => ({ matches: false }),
    addEventListener: (type, fn) => (listeners[type] = listeners[type] || []).push(fn),
    document: {
      hidden: false,
      body: makeElement("body"),
      getElementById: (id) => (elements[id] = elements[id] || makeElement(id)),
      querySelectorAll: () => [],
      querySelector: () => null,
      createElement: (tag) => makeElement(tag),
      addEventListener: (type, fn) => (listeners["doc:" + type] = listeners["doc:" + type] || []).push(fn),
    },
  };
  sandbox.window = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(SOURCE, ctx, { filename: "index.js" });

  const run = (code) => vm.runInContext(code, ctx);
  let now = run("lastTime");
  return {
    run,
    storage,
    elements,
    /** Advance the game loop by `frames` frames of `ms` milliseconds each. */
    step(frames, ms = 1000 / 60) {
      for (let i = 0; i < frames; i++) {
        now += ms;
        run(`gameLoop(${now})`);
      }
    },
    fire(type, event = {}) {
      const e = { preventDefault() {}, repeat: false, target: { closest: () => null }, ...event };
      (listeners[type] || []).forEach((fn) => fn(e));
    },
  };
}

/** Boot, pick a difficulty, skip the story, and land on level 1 of the maze. */
function startedGame(difficulty = "MEDIUM") {
  const g = boot();
  g.run(`startGame("${difficulty}")`);
  g.run("advanceStory()");
  g.run("advanceStory()");
  assert.equal(g.run("gameState"), "PLAYING");
  // Keep the player alive unless a test explicitly wants otherwise
  return g;
}

const makePlayerSafe = (g) => g.run("player.invulnerable = true; player.invulnerableTimer = 1e9;");

test("boots without errors and shows the title screen", () => {
  const g = boot();
  assert.equal(g.run("gameState"), "MENU");
  g.step(5);
});

test("menu flow: click -> difficulty picker -> story -> maze", () => {
  const g = boot();
  g.fire("click");
  assert.equal(g.run("gameState"), "DIFFICULTY");
  g.fire("keydown", { code: "Digit3" });
  assert.equal(g.run("gameState"), "STORY");
  assert.equal(g.run("currentDifficultyKey"), "HARD");
  g.run("advanceStory()");
  g.run("advanceStory()");
  assert.equal(g.run("gameState"), "PLAYING");
  g.step(120);
});

test("level 1 layout: key pieces, a required Echo Stone, a Memory Shrine, hunters", () => {
  const g = startedGame("MEDIUM");
  const keyItems = g.run("items.filter((i) => i.type === 'KEY').length");
  assert.equal(keyItems, g.run("keysRequired") - 1, "one key piece must be held by the Echo Stone");
  assert.equal(g.run("puzzles.filter((p) => p.type === 'SOUND_PATTERN').length"), 1);
  assert.equal(g.run("puzzles.filter((p) => p.type === 'MEMORY_MAZE').length"), 1);
  assert.equal(g.run("enemies.length"), 2);
});

test("deeper levels add hunters (capped at +2) and make them faster", () => {
  const g = startedGame("EASY");
  const base = g.run("enemies[0].speed");
  g.run("initLevel(5)");
  assert.equal(g.run("enemies.length"), 3);
  assert.ok(g.run("enemies[0].speed") > base);
});

test("movement speed does not depend on the monitor refresh rate", () => {
  const distanceAfterOneSecond = (frames, ms) => {
    const g = startedGame("EASY");
    g.run("mazeGrid.forEach((row) => row.forEach((c) => (c.walls = [false, false, false, false])))");
    g.run("items = []; puzzles = []; enemies = []; glassTiles = [];");
    g.run("player.x = 60; player.y = 60; keys.KeyD = true;");
    const x0 = g.run("player.x");
    g.step(frames, ms);
    return g.run("player.x") - x0;
  };
  const at60 = distanceAfterOneSecond(60, 1000 / 60);
  const at144 = distanceAfterOneSecond(144, 1000 / 144);
  assert.ok(Math.abs(at60 - at144) < 4, `60Hz moved ${at60}px, 144Hz moved ${at144}px`);
  assert.ok(at60 > 100 && at60 < 160);
});

test("wall collision catches wall ends (corners) of neighbouring cells", () => {
  const g = boot();
  g.run(`
    mazeCols = 2; mazeRows = 2;
    const open = () => ({ walls: [false, false, false, false] });
    mazeGrid = [[open(), open()], [open(), open()]];
    mazeGrid[0][0].walls[1] = true;   // wall segment x=60, y from 0 to 60
    mazeGrid[0][1].walls[3] = true;
  `);
  // 7.8px from the wall's free end, in a DIFFERENT cell than the wall — the old
  // current-cell-only check let the player clip through here.
  assert.equal(g.run("checkWallCollision(55, 66, 12)"), true);
  assert.equal(g.run("checkWallCollision(45, 66, 12)"), false);
});

test("maze generator always produces a fully connected maze", () => {
  const g = boot();
  const connected = g.run(`
    (function () {
      for (const size of [11, 15, 21]) {
        const grid = new MazeGenerator(size, size).generate();
        const seen = new Set(["0,0"]);
        const queue = [[0, 0]];
        while (queue.length) {
          const [r, c] = queue.pop();
          const w = grid[r][c].walls;
          const next = [];
          if (!w[0]) next.push([r - 1, c]);
          if (!w[1]) next.push([r, c + 1]);
          if (!w[2]) next.push([r + 1, c]);
          if (!w[3]) next.push([r, c - 1]);
          for (const [nr, nc] of next) {
            const k = nr + "," + nc;
            if (!seen.has(k)) { seen.add(k); queue.push([nr, nc]); }
          }
        }
        if (seen.size !== size * size) return false;
      }
      return true;
    })()
  `);
  assert.equal(connected, true);
});

test("candle flames scorch hunters: hurt, stun, then death and removal", () => {
  const g = startedGame("EASY");
  makePlayerSafe(g);
  g.run("inventory.candles = 1; player.x = 30; player.y = 30; useCandle();");
  assert.equal(g.run("placedCandles.length"), 1);
  assert.equal(g.run("inventory.candles"), 0);

  // Put the hunter in the flame
  g.run("enemies[0].x = placedCandles[0].x + 5; enemies[0].y = placedCandles[0].y;");
  g.step(2);
  assert.equal(g.run("enemies[0].hp"), 1);
  assert.ok(g.run("enemies[0].stunTimer") > 0);
  assert.equal(g.run("enemies[0].animName"), "hurt");

  // Second burn kills it
  g.run("enemies[0].stunTimer = 0; enemies[0].candleImmune = 0; enemies[0].x = placedCandles[0].x; enemies[0].y = placedCandles[0].y;");
  g.step(2);
  assert.equal(g.run("enemies[0].state"), "DEAD");
  assert.equal(g.run("enemies[0].animName"), "death");
  g.step(60 * 4);
  assert.equal(g.run("enemies.length"), 0);
});

test("a stunned hunter cannot catch the player", () => {
  const g = startedGame("EASY");
  g.run("enemies[0].x = player.x; enemies[0].y = player.y; enemies[0].stunTimer = 5; enemies[0].candleImmune = 99;");
  g.step(10);
  assert.equal(g.run("gameState"), "PLAYING");
});

test("loud noises send hunters into CHASE; they lose the trail after a while", () => {
  const g = startedGame("EASY");
  g.run("player.x = 30; player.y = 30;");
  g.run("enemies[0].x = (mazeCols - 0.5) * CELL_SIZE; enemies[0].y = (mazeRows - 0.5) * CELL_SIZE;");
  g.run("alertEnemies(enemies[0].x, enemies[0].y, 50, true);");
  assert.equal(g.run("enemies[0].state"), "CHASE");
  const x0 = g.run("enemies[0].x");
  const y0 = g.run("enemies[0].y");
  g.step(30);
  const moved = Math.hypot(g.run("enemies[0].x") - x0, g.run("enemies[0].y") - y0);
  assert.ok(moved > 10, `hunter should move while chasing (moved ${moved}px)`);

  g.run("enemies[0].chaseTimer = 0.05;");
  g.step(10);
  assert.equal(g.run("enemies[0].state"), "INVESTIGATE");
});

test("patrolling hunters follow corridors instead of getting stuck on walls", () => {
  const g = startedGame("EASY");
  makePlayerSafe(g);
  g.run("player.x = 30; player.y = 30;");
  // Total distance walked (not net displacement — it may wander back to where it started)
  let walked = 0;
  let x = g.run("enemies[0].x");
  let y = g.run("enemies[0].y");
  for (let i = 0; i < 60 * 20; i++) {
    g.step(1);
    const nx = g.run("enemies[0].x");
    const ny = g.run("enemies[0].y");
    walked += Math.hypot(nx - x, ny - y);
    x = nx;
    y = ny;
  }
  assert.ok(walked > 100, `patrolling hunter should keep moving (walked ${walked}px)`);
});

test("Heart Relic alerts hunters ~2x/second, not once per frame", () => {
  const g = startedGame("MEDIUM");
  g.run("player.x = enemies[0].x; player.y = enemies[0].y; useHeartRelic();");
  g.run("audioSys.playGrowl = function () { globalThis.__growls = (globalThis.__growls || 0) + 1; };");
  g.step(60);
  // 2 hunters x about 2 heartbeats. It used to be ~120 calls (once per frame per hunter).
  const growls = g.run("globalThis.__growls || 0");
  assert.ok(growls <= 8, `expected only a few growl requests in 1s, got ${growls}`);
});

test("growl sound itself is rate-limited", () => {
  const g = startedGame("EASY");
  g.run("audioSys.playGrowl();");
  const first = g.run("audioSys._lastGrowl");
  assert.notEqual(first, undefined);
  g.run("audioSys.playGrowl(); audioSys.playGrowl();");
  assert.equal(g.run("audioSys._lastGrowl"), first, "repeat calls within 700ms must be ignored");
});

test("starting a level wipes old pulses, dust and candles", () => {
  const g = startedGame("EASY");
  g.run("triggerSoundPulse(100, 100, 1); spawnDustBurst(50, 50); placedCandles.push({ x: 1, y: 1, timer: 5 });");
  g.run("initLevel(2)");
  // initLevel fires exactly one fresh tutorial pulse of its own
  assert.equal(g.run("soundPulses.length"), 1);
  assert.equal(g.run("dustParticles.length"), 0);
  assert.equal(g.run("placedCandles.length"), 0);
});

test("gate: too few keys gives feedback; unsealing needs you to hold the gate", () => {
  const g = startedGame("EASY");
  makePlayerSafe(g);
  g.run("player.x = exitGate.x; player.y = exitGate.y; checkInteraction();");
  assert.equal(g.run("isFinalEscapeActive"), false);
  assert.match(g.elements["toast"].innerText, /sealed/i);

  g.run("inventory.keys = keysRequired; unlockGateIfReady(); checkInteraction();");
  assert.equal(g.run("isFinalEscapeActive"), true);
  assert.equal(g.run("enemies.every((e) => e.state === 'CHASE' && e.chaseTimer === Infinity)"), true);

  // Walking away drains progress instead of completing the level
  g.step(60 * 3);
  assert.ok(g.run("gateUnseal.progress") > 2);
  g.run("player.x = 30; player.y = 30;");
  g.step(60 * 3);
  assert.ok(g.run("gateUnseal.progress") < 1);
  assert.equal(g.run("currentLevel"), 1);

  // Holding it for UNSEAL_TIME finishes the level (and autosaves the next one)
  g.run("player.x = exitGate.x; player.y = exitGate.y;");
  g.step(60 * 9);
  assert.equal(g.run("currentLevel"), 2);
  assert.equal(g.run("store.save.level"), 2);
});

test("Echo Stone: solving the melody yields a key piece", () => {
  const g = startedGame("EASY");
  makePlayerSafe(g);
  g.run("const stone = puzzles.find((p) => p.type === 'SOUND_PATTERN'); player.x = stone.x; player.y = stone.y; checkInteraction();");
  assert.equal(g.run("isSolvingPuzzle"), true);
  g.run("soundPuzzle.phase = 'INPUT';");
  const seq = g.run("soundPuzzle.puz.sequence");
  seq.forEach((tone) => g.run(`pressPuzzleTone(${tone})`));
  assert.equal(g.run("inventory.keys"), 1);
  assert.equal(g.run("puzzles.find((p) => p.type === 'SOUND_PATTERN').solved"), true);
  g.run("closeSoundPuzzle()");
});

test("Memory Shrine: reveals the route to the exit and gives a candle", () => {
  const g = startedGame("EASY");
  makePlayerSafe(g);
  g.run("const s = puzzles.find((p) => p.type === 'MEMORY_MAZE'); player.x = s.x; player.y = s.y; checkInteraction();");
  // The route runs from the shrine's cell to the exit's cell (2 cells if they are neighbours)
  assert.ok(g.run("memoryRoute && memoryRoute.cells.length") >= 2);
  assert.equal(g.run("inventory.candles"), 1);
  g.step(60 * 16);
  assert.equal(g.run("memoryRoute"), null);
});

test("pause freezes the game; unpausing resumes it", () => {
  const g = startedGame("EASY");
  g.run("mazeGrid.forEach((row) => row.forEach((c) => (c.walls = [false, false, false, false]))); items = []; enemies = []; puzzles = [];");
  g.run("player.x = 60; player.y = 60;");
  g.fire("keydown", { code: "KeyP" });
  assert.equal(g.run("isPaused"), true);
  g.run("keys.KeyD = true;");
  g.step(30);
  assert.equal(g.run("player.x"), 60);
  g.fire("keydown", { code: "Escape" });
  assert.equal(g.run("isPaused"), false);
  g.run("keys.KeyD = true;");
  g.step(30);
  assert.ok(g.run("player.x") > 60);
});

test("key rebinding works, swaps duplicates and rejects reserved keys", () => {
  const g = startedGame("EASY");
  g.run("rebindingAction = 'candle';");
  g.fire("keydown", { code: "KeyW" }); // reserved (movement)
  assert.equal(g.run("bindings.candle"), "KeyC");
  assert.equal(g.run("rebindingAction"), "candle");
  g.fire("keydown", { code: "KeyF" });
  assert.equal(g.run("bindings.candle"), "KeyF");
  assert.equal(g.run("rebindingAction"), null);

  g.run("rebindingAction = 'pulse';");
  g.fire("keydown", { code: "KeyF" }); // already used by candle -> swap
  assert.equal(g.run("bindings.pulse"), "KeyF");
  assert.equal(g.run("bindings.candle"), "Space");
  assert.match(g.storage.get("echohorror_v1"), /"bindings"/);
});

test("Continue resumes the saved level; the ending shows stats and clears the save", () => {
  const g = startedGame("HARD");
  g.run("completeLevel()"); // level 1 -> 2, autosaves
  assert.equal(g.run("hasSave()"), true);
  g.run("showMainMenu()");
  g.fire("keydown", { code: "KeyC" });
  assert.equal(g.run("gameState"), "PLAYING");
  assert.equal(g.run("currentLevel"), 2);
  assert.equal(g.run("currentDifficultyKey"), "HARD");

  g.run("initLevel(6); completeLevel();");
  assert.equal(g.run("gameState"), "STORY");
  assert.equal(g.run("hasSave()"), false);
  g.run("showCredits()");
  assert.match(g.elements["story-text"].innerText, /Times caught/);
  assert.ok(g.run("store.bestTime_HARD") >= 0);
});

test("dying counts a death and the retry restarts the level cleanly", () => {
  const g = startedGame("EASY");
  g.run("triggerGameOver()");
  assert.equal(g.run("runStats.deaths"), 1);
  g.run("restartLevel()");
  assert.equal(g.run("gameState"), "PLAYING");
  g.step(10);
});

test("settings, visual cues and captions run without errors", () => {
  const g = startedGame("EASY");
  g.run("visualCues = true;");
  g.run("openSettings()");
  assert.equal(g.run("isPaused"), true);
  g.run("closeSettings()");
  assert.equal(g.run("isPaused"), false);
  g.step(30);
  g.run("audioSys.playGrowl();");
  assert.equal(g.elements["caption"].innerText, "[Growl]");
});

test("every element id referenced from index.js exists in index.html", () => {
  const referenced = new Set();
  for (const m of SOURCE.matchAll(/getElementById\("([^"]+)"\)/g)) referenced.add(m[1]);
  for (const m of SOURCE.matchAll(/"((?:mix|touch)-[a-z-]+)"/g)) referenced.add(m[1]);
  const declared = new Set([...HTML.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const missing = [...referenced].filter((id) => !declared.has(id));
  assert.deepEqual(missing, []);
});
