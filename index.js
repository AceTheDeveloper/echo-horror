/**
 * EchoHorror — "The Echo Maze"
 * A sound-driven horror maze game. HOW_TO_PLAY.txt explains every mechanic in
 * plain language; README.md covers running and developing the project.
 */

/**
 * ============================================================================
 * SAVED DATA & SHARED CONSTANTS
 * ============================================================================
 * Progress, settings and key bindings live in the browser's localStorage so
 * they survive a refresh. Every read/write is wrapped in try/catch because
 * storage can be blocked (private windows, strict privacy settings) — the
 * game simply forgets things in that case instead of breaking.
 */
const MAX_LEVELS = 6;
const STORAGE_KEY = "echohorror_v1";

let store = (() => {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch (e) {
    return {};
  }
})();

function saveStore(patch) {
  store = { ...store, ...patch };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch (e) {
    /* storage unavailable — settings just won't persist */
  }
}

/**
 * ============================================================================
 * SPRITE ASSETS (bundled in assets/tilemap; the CDN copy is only a backup)
 * ============================================================================
 * Source: Kenney's "Micro Roguelike" pack (CC0 1.0 — public domain, free for
 * any use, no attribution required). Served from a public GitHub mirror via
 * raw.githubusercontent.com, which acts as a free CDN.
 * Pack info: https://kenney.nl/assets/micro-roguelike
 *
 * If this CDN is ever unreachable (offline dev, blocked network), the game
 * automatically falls back to the original hand-drawn vector shapes below —
 * nothing breaks.
 */
const SPRITE_SHEET_URL =
  "https://raw.githubusercontent.com/ETdoFresh/kenney.nl/master/kenney_microroguelike_1.2/Tilemap/colored_tilemap_packed.png";
const SPRITE_TILE_SIZE = 8; // each tile in the source sheet is 8x8px

// [column, row] of each tile inside the packed sheet (0-indexed)
const SPRITE_COORDS = {
  PLAYER: [4, 0], // armored adventurer
  ENEMY: [5, 1], // hunched green creature
  KEY: [10, 5], // gold key
  FAKE_KEY: [10, 5], // identical to real key on purpose (it's a trap!)
  CANDLE: [8, 5], // glowing flame
  HEART: [5, 6], // heart relic
  EYE: [9, 1], // pale spirit / totem
  NOTE: [11, 7], // chest (stand-in for cursed pages)
  DOOR_LOCKED: [7, 2], // padlock
  DOOR_UNLOCKED: [4, 2], // open doorway
};

const SPRITE_SHEET_LOCAL = "assets/tilemap/colored_tilemap_packed.png";
const spriteSheet = new Image();
let spritesLoaded = false;
let triedCdnSprites = false;
spriteSheet.onload = () => {
  spritesLoaded = true;
};
spriteSheet.onerror = () => {
  spritesLoaded = false;
  // Local copy missing? Try the public CDN once before giving up.
  if (!triedCdnSprites) {
    triedCdnSprites = true;
    spriteSheet.src = SPRITE_SHEET_URL;
    return;
  }
  console.warn("Sprite sheet unavailable — using vector fallback shapes.");
};
spriteSheet.src = SPRITE_SHEET_LOCAL;

/**
 * ============================================================================
 * PLAYER DIRECTIONAL RUN ANIMATION (4-way spritesheet strips)
 * ============================================================================
 * Each strip is a single row of `PLAYER_SHEET_FRAMES` frames (a run cycle)
 * facing one direction. Frame size is derived at load time from the image's
 * natural dimensions (width / frameCount, full height) so these drop-in
 * cleanly regardless of exact pixel dimensions.
 */
const PLAYER_SHEET_FRAMES = 6;
const PLAYER_SPRITE_PATHS = {
  down: "assets/Character_down_run-Sheet6.png",
  up: "assets/Character_up_run-Sheet6.png",
  right: "assets/Character_side_run-Sheet6.png",
  left: "assets/Character_side-left_run-Sheet6.png",
};

const playerSprites = {}; // { down: { img, loaded, frameW, frameH }, ... }

Object.entries(PLAYER_SPRITE_PATHS).forEach(([direction, path]) => {
  const img = new Image();
  const entry = { img, loaded: false, frameW: 0, frameH: 0 };
  img.onload = () => {
    entry.frameW = img.naturalWidth / PLAYER_SHEET_FRAMES;
    entry.frameH = img.naturalHeight;
    entry.loaded = true;
  };
  img.onerror = () => {
    entry.loaded = false;
    console.warn(`Player sprite strip missing/unreachable: ${path}`);
  };
  img.src = path;
  playerSprites[direction] = entry;
});

/**
 * Draws the player using the directional run-cycle spritesheets. Falls back
 * to the caller drawing a vector placeholder if the relevant strip hasn't
 * loaded (e.g. still fetching, or the asset is missing).
 */
function drawPlayerSprite(x, y, size) {
  const entry = playerSprites[player.currentDirection];
  if (!entry || !entry.loaded) return false;

  const frame = player.frameX % PLAYER_SHEET_FRAMES;
  const sx = frame * entry.frameW;
  const sy = 0;

  // Preserve the strip's native aspect ratio when scaling to `size`
  const aspect = entry.frameW / entry.frameH;
  const drawW = size * aspect;
  const drawH = size;

  ctx.save();
  ctx.imageSmoothingEnabled = false; // keep pixel art crisp
  ctx.drawImage(
    entry.img,
    sx,
    sy,
    entry.frameW,
    entry.frameH,
    x - drawW / 2,
    y - drawH / 2,
    drawW,
    drawH,
  );
  ctx.restore();
  return true;
}

/**
 * ============================================================================
 * ENEMY SPRITE ANIMATION — "Blood Monster A"
 * ============================================================================
 * Six animation strips (each a single row of same-size frames, one anim per
 * file). Frame size is derived at load time from the image's natural
 * dimensions (width / frameCount, full height), same pattern as the player
 * strips above, so these drop in cleanly regardless of exact pixel size.
 *
 * idle/walk are used for ordinary patrol/investigate/chase movement; attack1
 * & attack2 are used as a "lunge" telegraph the instant a chasing hunter
 * gets close enough to catch you; hurt/death play when a hunter is scorched by
 * a placed candle flame (two burns kill it).
 */
const ENEMY_ANIM_FRAMES = {
  idle: 6,
  walk: 8,
  attack1: 8,
  attack2: 8,
  hurt: 4,
  death: 4,
};
const ENEMY_SPRITE_PATHS = {
  idle: "assets/enemy/Blood_Monster_A_Idle.png",
  walk: "assets/enemy/Blood_Monster_A_Walk.png",
  attack1: "assets/enemy/Blood_Monster_A_Attack01.png",
  attack2: "assets/enemy/Blood_Monster_A_Attack02.png",
  hurt: "assets/enemy/Blood_Monster_A_Hurt.png",
  death: "assets/enemy/Blood_Monster_A_Death.png",
};
// Playback speed (frames per second) per animation — sluggish while
// idling/patrolling, frantic the instant it lunges.
const ENEMY_ANIM_FPS = {
  idle: 5,
  walk: 8,
  attack1: 14,
  attack2: 14,
  hurt: 10,
  death: 7,
};
// How close a CHASE-state hunter has to be to the player before it switches
// from its walk cycle to a lunging attack animation (purely visual — the
// actual catch/game-over distance is separate, in updateEnemies()).
const ENEMY_LUNGE_RANGE = 60;
// Minimum seconds an enemy's animation must play before it's allowed to
// change again. Without this, an enemy hovering right at the edge of
// ENEMY_LUNGE_RANGE (or taking a single slow/blocked step) flickers
// rapidly between walk/attack or walk/idle — this smooths that out.
const ENEMY_ANIM_MIN_HOLD = 0.15;
// Candle combat: a burn stuns the hunter, it plays "hurt" for a moment, and
// after ENEMY_MAX_HP burns it plays "death" and lingers briefly as a corpse.
const ENEMY_MAX_HP = 2;
const ENEMY_STUN_TIME = 2.5;
const ENEMY_HURT_ANIM_TIME = 0.6;
const ENEMY_DEATH_LINGER = 3;

const enemySprites = {}; // { idle: { img, loaded, frameW, frameH, frameCount }, ... }
Object.entries(ENEMY_SPRITE_PATHS).forEach(([anim, path]) => {
  const img = new Image();
  const frameCount = ENEMY_ANIM_FRAMES[anim];
  const entry = { img, loaded: false, frameW: 0, frameH: 0, frameCount };
  img.onload = () => {
    entry.frameW = img.naturalWidth / frameCount;
    entry.frameH = img.naturalHeight;
    entry.loaded = true;
  };
  img.onerror = () => {
    entry.loaded = false;
    console.warn(`Enemy sprite strip missing/unreachable: ${path}`);
  };
  img.src = path;
  enemySprites[anim] = entry;
});

/**
 * Decides which animation strip an enemy *wants* to play this frame, given
 * its AI state/movement. Called from updateEnemies() every frame (with
 * hysteresis applied there) — NOT from the renderer — so the animation
 * stays stable and continuous even though the sprite itself is only ever
 * drawn during the brief window a sound pulse reveals it.
 */
function getDesiredEnemyAnim(enemy, distToPlayer) {
  if (enemy.state === "DEAD") return "death";
  if (enemy.stunTimer > ENEMY_STUN_TIME - ENEMY_HURT_ANIM_TIME) return "hurt";
  if (enemy.state === "CHASE" && distToPlayer < ENEMY_LUNGE_RANGE) {
    // Alternate attack1/attack2 per-enemy (via its fixed jitterSeed) so a
    // pack of hunters doesn't all bare their teeth in perfect unison.
    return Math.floor(enemy.jitterSeed) % 2 === 0 ? "attack1" : "attack2";
  }
  return enemy.isMoving ? "walk" : "idle";
}

/**
 * Draws the Blood Monster spritesheet animation for one enemy, centered at
 * (x, y). Mirrors drawSprite()'s calling convention (same opts shape, same
 * offsetX/offsetY/rotation/scale handling) so it's a drop-in swap wherever
 * drawSprite("ENEMY", ...) was used. Returns false (drawing nothing) if the
 * relevant strip hasn't loaded yet, so callers can fall back further.
 */
function drawEnemySprite(enemy, x, y, size, alpha = 1.0, opts = {}) {
  const animName = enemy.animName || "idle";
  const entry = enemySprites[animName];
  if (!entry || !entry.loaded) return false;

  const fps = ENEMY_ANIM_FPS[animName] || 8;
  // Hurt and death play once from their first frame and hold on the last one;
  // every other animation loops.
  const playOnce = animName === "hurt" || animName === "death";
  const frame = playOnce
    ? Math.min(
        entry.frameCount - 1,
        Math.floor((animTime - (enemy.animStart || 0)) * fps),
      )
    : Math.floor(animTime * fps + enemy.jitterSeed) % entry.frameCount;
  const sx = frame * entry.frameW;
  const sy = 0;

  const rotation = opts.rotation || 0;
  const scaleX = opts.scaleX !== undefined ? opts.scaleX : 1;
  const scaleY = opts.scaleY !== undefined ? opts.scaleY : 1;
  const offsetX = opts.offsetX || 0;
  const offsetY = opts.offsetY || 0;
  const flipX = enemy.facingLeft ? -1 : 1;

  // Preserve the strip's native aspect ratio when scaling to `size`
  const aspect = entry.frameW / entry.frameH;
  const drawW = size * aspect;
  const drawH = size;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.imageSmoothingEnabled = false; // keep pixel art crisp
  ctx.translate(x + offsetX, y + offsetY);
  if (rotation) ctx.rotate(rotation);
  ctx.scale(scaleX * flipX, scaleY);
  ctx.drawImage(
    entry.img,
    sx,
    sy,
    entry.frameW,
    entry.frameH,
    -drawW / 2,
    -drawH / 2,
    drawW,
    drawH,
  );
  ctx.restore();
  return true;
}

/**
 * Draws a sprite tile centered at (x, y). Returns false (and draws nothing)
 * if the sheet hasn't loaded yet, so callers can fall back to vector shapes.
 */
function drawSprite(key, x, y, size, alpha = 1.0, opts = {}) {
  if (!spritesLoaded) return false;
  const coords = SPRITE_COORDS[key];
  if (!coords) return false;
  const [tc, tr] = coords;

  const rotation = opts.rotation || 0;
  const scaleX = opts.scaleX !== undefined ? opts.scaleX : 1;
  const scaleY = opts.scaleY !== undefined ? opts.scaleY : 1;
  const offsetY = opts.offsetY || 0;
  const offsetX = opts.offsetX || 0;
  const flipX = opts.flipX ? -1 : 1;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.imageSmoothingEnabled = false; // keep pixel art crisp
  ctx.translate(x + offsetX, y + offsetY);
  if (rotation) ctx.rotate(rotation);
  ctx.scale(scaleX * flipX, scaleY);
  ctx.drawImage(
    spriteSheet,
    tc * SPRITE_TILE_SIZE,
    tr * SPRITE_TILE_SIZE,
    SPRITE_TILE_SIZE,
    SPRITE_TILE_SIZE,
    -size / 2,
    -size / 2,
    size,
    size,
  );
  ctx.restore();
  return true;
}

/**
 * Central "clock" for all idle/movement animation (bobbing, flicker,
 * pulsing, twitching). Advanced every frame in gameLoop().
 */
let animTime = 0;

/**
 * ============================================================================
 * AUDIO MIX — quick volume knobs (1.0 = default). Tweak these if something is
 * too loud or too quiet on your speakers / headphones.
 * ============================================================================
 */
const AUDIO_MIX = {
  music: 1.0, // story background music
  whisper: 1.0, // creepy whispers
  footstep: 1.0, // your own footsteps
  enemyFootstep: 1.0, // hunters walking somewhere in the dark
  puzzle: 1.0, // Echo Stone tones + hum
};
Object.assign(AUDIO_MIX, store.mix || {}); // restore the player's saved sliders

/** Converts a MIDI note number to Hz (69 = A4 = 440 Hz). */
const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);

/** The 3 pitches of the sound puzzle: LOW / MID / HIGH (G3, D4, A4). */
const PUZZLE_TONES = [196.0, 293.66, 440.0];

/**
 * Story music "recipes". Each chord is a list of MIDI notes played by the
 * slow pad; a sparse music-box melody floats on top (A harmonic minor).
 * The ending version is slower, sparser, and shifts to a wrong-sounding
 * Bb chord + wilting pitch bends so it feels like the music is decaying.
 */
const STORY_MUSIC = {
  intro: {
    barLen: 8, // seconds per chord
    beat: 1.0, // seconds between possible melody notes
    density: 0.5, // chance a melody note plays on each beat
    warp: false,
    chords: [
      [45, 52, 57, 60], // Am
      [41, 48, 53, 57], // F
      [38, 45, 50, 53], // Dm
      [40, 47, 52, 56], // E
    ],
  },
  ending: {
    barLen: 10,
    beat: 1.25,
    density: 0.3,
    warp: true,
    chords: [
      [45, 52, 57, 60], // Am
      [46, 53, 58, 62], // Bb  (one semitone off — wrong on purpose)
      [45, 52, 57, 60], // Am
      [44, 51, 56, 59], // G#m
    ],
  },
};
const MINOR_SCALE_PCS = [9, 11, 0, 2, 4, 5, 8]; // A B C D E F G#

/**
 * Procedural Web Audio Synthesizer (Fallback when assets are missing)
 */
class SoundSystem {
  constructor() {
    this.ctx = null;
    this.muted = !!store.muted;
    this.ambientNodes = null;
    this.musicNodes = null; // story background music (separate from the gameplay drone)
    this.threatActive = false;
    this.dreadLevel = 1; // current level — whispers get more frequent as it rises
    this._noiseBuf = null;
    this._reverb = null;
    this._stepFoot = 0; // alternates left / right foot
    this._lastCloseWhisper = 0;
  }

  init() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (this.ctx.state === "suspended") {
      this.ctx.resume();
    }
  }

  setMuted(val) {
    this.muted = val;
    if (!this.ctx) return;
    if (this.ambientNodes) {
      this._rampTo(this.ambientNodes.masterGain.gain, val ? 0.0001 : 1, 0.2);
    }
    if (this.musicNodes) {
      this._rampTo(
        this.musicNodes.master.gain,
        val ? 0.0001 : AUDIO_MIX.music,
        0.2,
      );
    }
  }

  /** Re-applies the music slider to a song that is already playing. */
  applyMix() {
    if (this.ctx && this.musicNodes && !this.muted) {
      this._rampTo(this.musicNodes.master.gain, AUDIO_MIX.music, 0.1);
    }
  }

  /** Smoothly moves a gain/param from where it is now to `value`. */
  _rampTo(param, value, seconds) {
    const now = this.ctx.currentTime;
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.linearRampToValueAtTime(value, now + seconds);
  }

  /** One shared 2-second white-noise buffer, reused by every noise-based sound. */
  _getNoise() {
    if (!this._noiseBuf) {
      const len = this.ctx.sampleRate * 2;
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      this._noiseBuf = buf;
    }
    return this._noiseBuf;
  }

  /**
   * Fake "stone chamber" reverb: a burst of decaying noise used as an impulse
   * response. Returns the node to connect sounds INTO; the wet signal comes
   * out into `destination`.
   */
  _makeReverb(destination, seconds = 2.5, wet = 0.5) {
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * seconds);
    const impulse = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const data = impulse.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.5);
      }
    }
    const convolver = ctx.createConvolver();
    convolver.buffer = impulse;
    const wetGain = ctx.createGain();
    wetGain.gain.value = wet;
    convolver.connect(wetGain);
    wetGain.connect(destination);
    return convolver;
  }

  /** Shared reverb for sound effects (footsteps, whispers, puzzle tones). */
  _getReverb() {
    if (!this._reverb) {
      this._reverb = this._makeReverb(this.ctx.destination, 2.2, 0.6);
    }
    return this._reverb;
  }

  /**
   * Puts a left/right panner in front of `dest` (pan: -1 = left, +1 = right).
   * Returns the node to connect into. Falls back to `dest` on old browsers.
   */
  _panTo(dest, pan) {
    if (!this.ctx.createStereoPanner) return dest;
    const panner = this.ctx.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, pan));
    panner.connect(dest);
    return panner;
  }

  playPulse(volume = 1.0) {
    if (!this.ctx || this.muted) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(180, this.ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(40, this.ctx.currentTime + 0.4);
    gain.gain.setValueAtTime(0.5 * volume, this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.4);
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start();
    osc.stop(this.ctx.currentTime + 0.4);
  }

  /**
   * Your own footstep on cold stone: a low heel "thud" + a gritty scuff, with
   * a faint cave echo. Alternates slightly left/right and varies a little each
   * step so it never sounds like a copy-pasted loop.
   */
  playFootstep() {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    this._stepFoot = 1 - this._stepFoot;
    const out = this._panTo(ctx.destination, this._stepFoot ? 0.25 : -0.25);
    const v = AUDIO_MIX.footstep * (0.85 + Math.random() * 0.3);

    // 1) heel thud
    const thump = ctx.createOscillator();
    const thumpGain = ctx.createGain();
    thump.type = "sine";
    thump.frequency.setValueAtTime(95 + Math.random() * 25, now);
    thump.frequency.exponentialRampToValueAtTime(38, now + 0.12);
    thumpGain.gain.setValueAtTime(0.32 * v, now);
    thumpGain.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
    thump.connect(thumpGain);
    thumpGain.connect(out);
    thump.start(now);
    thump.stop(now + 0.16);

    // 2) gritty scuff of stone
    const scuff = ctx.createBufferSource();
    scuff.buffer = this._getNoise();
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 900 + Math.random() * 500;
    bp.Q.value = 0.8;
    const scuffGain = ctx.createGain();
    scuffGain.gain.setValueAtTime(0.0001, now);
    scuffGain.gain.linearRampToValueAtTime(0.5 * v, now + 0.01);
    scuffGain.gain.exponentialRampToValueAtTime(0.001, now + 0.11);
    scuff.connect(bp);
    bp.connect(scuffGain);
    scuffGain.connect(out);
    scuff.start(now, Math.random() * 1.5, 0.15);

    // 3) faint echo down the corridor
    const send = ctx.createGain();
    send.gain.value = 0.35 * v;
    thumpGain.connect(send);
    scuffGain.connect(send);
    send.connect(this._getReverb());
  }

  playPickup() {
    if (!this.ctx || this.muted) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(440, this.ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(880, this.ctx.currentTime + 0.2);
    gain.gain.setValueAtTime(0.3, this.ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.01, this.ctx.currentTime + 0.2);
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start();
    osc.stop(this.ctx.currentTime + 0.2);
  }

  playGrowl() {
    if (!this.ctx) return;
    caption("[Growl]");
    if (this.muted) return;
    // Rate-limit: several hunters (or one loud noise) can call this many
    // times a second, which used to stack dozens of overlapping growls.
    const nowMs = performance.now();
    if (this._lastGrowl !== undefined && nowMs - this._lastGrowl < 700) return;
    this._lastGrowl = nowMs;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(60, this.ctx.currentTime);
    osc.frequency.linearRampToValueAtTime(40, this.ctx.currentTime + 0.8);
    gain.gain.setValueAtTime(0.4, this.ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.01, this.ctx.currentTime + 0.8);
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start();
    osc.stop(this.ctx.currentTime + 0.8);
  }

  playHeartbeat() {
    if (!this.ctx || this.muted) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(60, this.ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(30, this.ctx.currentTime + 0.15);
    gain.gain.setValueAtTime(0.6, this.ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.01, this.ctx.currentTime + 0.15);
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start();
    osc.stop(this.ctx.currentTime + 0.15);
  }

  playDenied() {
    if (!this.ctx || this.muted) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = "square";
    osc.frequency.setValueAtTime(110, this.ctx.currentTime);
    gain.gain.setValueAtTime(0.12, this.ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.001, this.ctx.currentTime + 0.1);
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start();
    osc.stop(this.ctx.currentTime + 0.1);
  }

  /**
   * A breathy whisper made from filtered noise. Each "syllable" is noise shaped
   * by two vowel formants (so it sounds like speech, not wind) plus a hissy
   * "sss" on some of them. It's panned to one side and slowly drifts across
   * your head, with a stone-chamber echo behind it.
   *   opts.close    -> right in your ear (louder, drier)
   *   opts.volume   -> extra multiplier
   *   opts.syllables-> how long the "sentence" is
   *   opts.pan      -> -1 (left) .. 1 (right); random side if omitted
   */
  playWhisper(opts = {}) {
    if (!this.ctx) return;
    caption("[Whispers]");
    if (this.muted) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const close = !!opts.close;
    const volume = (opts.volume ?? 1) * AUDIO_MIX.whisper;
    const side =
      opts.pan ?? (Math.random() < 0.5 ? -1 : 1) * (0.55 + Math.random() * 0.4);
    const syllables = opts.syllables ?? 3 + Math.floor(Math.random() * 5);

    // Voice bus: gain -> panner -> speakers, plus a reverb send
    const bus = ctx.createGain();
    bus.gain.value = (close ? 0.35 : 0.2) * volume;
    const panNode = this._panTo(ctx.destination, side);
    bus.connect(panNode);
    const send = ctx.createGain();
    send.gain.value = close ? 0.35 : 0.9;
    bus.connect(send);
    send.connect(this._getReverb());

    // [F1, F2] formant pairs for the vowels a / e / i / o / u
    const VOWELS = [
      [730, 1090],
      [530, 1840],
      [270, 2290],
      [570, 840],
      [300, 870],
    ];

    let t = now + 0.02;
    for (let i = 0; i < syllables; i++) {
      const dur = 0.09 + Math.random() * 0.17;
      const [f1, f2] = VOWELS[Math.floor(Math.random() * VOWELS.length)];

      const src = ctx.createBufferSource();
      src.buffer = this._getNoise();
      const env = ctx.createGain();
      env.gain.setValueAtTime(0.0001, t);
      env.gain.linearRampToValueAtTime(1, t + dur * 0.35);
      env.gain.linearRampToValueAtTime(0.0001, t + dur);
      [
        [f1, 1.0],
        [f2, 0.6],
      ].forEach(([freq, level]) => {
        const bp = ctx.createBiquadFilter();
        bp.type = "bandpass";
        bp.frequency.value = freq * (0.95 + Math.random() * 0.1);
        bp.Q.value = 5;
        const g = ctx.createGain();
        g.gain.value = 5 * level; // narrow bands are quiet, so boost them
        src.connect(bp);
        bp.connect(g);
        g.connect(env);
      });
      env.connect(bus);
      src.start(t, Math.random() * 1.5, dur + 0.02);

      // Hissy "sss" at the start of about half of the syllables
      if (Math.random() < 0.5) {
        const hiss = ctx.createBufferSource();
        hiss.buffer = this._getNoise();
        const hp = ctx.createBiquadFilter();
        hp.type = "highpass";
        hp.frequency.value = 5000;
        const hissGain = ctx.createGain();
        hissGain.gain.setValueAtTime(0.0001, t);
        hissGain.gain.linearRampToValueAtTime(0.5, t + 0.02);
        hissGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
        hiss.connect(hp);
        hp.connect(hissGain);
        hissGain.connect(bus);
        hiss.start(t, Math.random() * 1.5, 0.12);
      }

      t += dur + 0.04 + Math.random() * 0.1;
    }

    // Drift across the stereo field so it feels like something is circling you
    if (panNode.pan) {
      panNode.pan.setValueAtTime(side, now);
      panNode.pan.linearRampToValueAtTime(-side * 0.5, t);
    }
  }

  /**
   * ------------------------------------------------------------------
   * BACKGROUND MUSIC — procedural horror drone (no audio files needed).
   * Layers:
   *   1. Two deeply detuned sub-oscillators -> constant unsettling hum
   *   2. Slow-filtered looping noise -> "cave wind" / breathing texture
   *   3. A distant random "creak" that fires every 6-14s
   *   4. A tension layer (dissonant tremolo) that fades in while an
   *      enemy is actively hunting the player, and fades out again once
   *      the player is safe. This is what makes death actually land.
   * ------------------------------------------------------------------
   */
  startAmbient() {
    if (!this.ctx || this.ambientNodes) return;

    const ctx = this.ctx;
    const masterGain = ctx.createGain();
    // Fade in over 2.5s so it crossfades smoothly out of the story music
    masterGain.gain.setValueAtTime(0.0001, ctx.currentTime);
    masterGain.gain.linearRampToValueAtTime(
      this.muted ? 0.0001 : 1,
      ctx.currentTime + 2.5,
    );
    masterGain.connect(ctx.destination);

    // --- Layer 1: droning sub-bass hum ---
    const droneGain = ctx.createGain();
    droneGain.gain.value = 0.1;
    droneGain.connect(masterGain);

    const drone1 = ctx.createOscillator();
    drone1.type = "sine";
    drone1.frequency.value = 54;
    const drone2 = ctx.createOscillator();
    drone2.type = "sine";
    drone2.frequency.value = 57; // slightly detuned -> slow beating/throb
    drone1.connect(droneGain);
    drone2.connect(droneGain);
    drone1.start();
    drone2.start();

    // Slow LFO breathing the drone's volume in and out
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.08;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.05;
    lfo.connect(lfoGain);
    lfoGain.connect(droneGain.gain);
    lfo.start();

    // --- Layer 2: filtered noise "wind" bed ---
    const noiseBufferSize = ctx.sampleRate * 4;
    const noiseBuffer = ctx.createBuffer(1, noiseBufferSize, ctx.sampleRate);
    const noiseData = noiseBuffer.getChannelData(0);
    for (let i = 0; i < noiseBufferSize; i++)
      noiseData[i] = Math.random() * 2 - 1;

    const noiseSource = ctx.createBufferSource();
    noiseSource.buffer = noiseBuffer;
    noiseSource.loop = true;

    const noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type = "lowpass";
    noiseFilter.frequency.value = 140;

    const noiseFilter2 = ctx.createBiquadFilter();
    noiseFilter2.type = "lowpass";
    noiseFilter2.frequency.value = 110;

    const noiseGain = ctx.createGain();
    noiseGain.gain.value = 0.018;

    noiseSource.connect(noiseFilter);
    noiseFilter.connect(noiseFilter2);
    noiseFilter2.connect(noiseGain);
    noiseGain.connect(masterGain);
    noiseSource.start();

    // --- Layer 4: tension riser, silent until threat is active ---
    const tensionGain = ctx.createGain();
    tensionGain.gain.value = 0.0001;
    tensionGain.connect(masterGain);

    const tension = ctx.createOscillator();
    tension.type = "sawtooth";
    tension.frequency.value = 110;
    const tensionFilter = ctx.createBiquadFilter();
    tensionFilter.type = "lowpass";
    tensionFilter.frequency.value = 220;
    tension.connect(tensionFilter);
    tensionFilter.connect(tensionGain);
    tension.start();

    // Fast tremolo on the tension layer -> "heartbeat under pressure"
    const tremolo = ctx.createOscillator();
    tremolo.frequency.value = 2.2;
    const tremoloGain = ctx.createGain();
    tremoloGain.gain.value = 0.5;
    tremolo.connect(tremoloGain);
    tremoloGain.connect(tensionGain.gain);
    tremolo.start();

    this.ambientNodes = {
      masterGain,
      droneGain,
      tensionGain,
      tension,
      tremolo,
    };

    // --- Layer 3: distant random creak/groan stingers ---
    const scheduleCreak = () => {
      if (!this.ambientNodes) return;
      if (!isPaused) this.playCreak();
      const nextIn = 6000 + Math.random() * 8000;
      this._creakTimeout = setTimeout(scheduleCreak, nextIn);
    };
    scheduleCreak();

    // --- Layer 5: whispers from the walls. Rare on level 1, near-constant by
    //     level 6, and twice as frequent while a hunter is after you. ---
    const scheduleWhisper = () => {
      if (!this.ambientNodes) return;
      const base = this.threatActive ? 4500 : 9000;
      const dread = Math.max(0.45, 1 - (this.dreadLevel - 1) * 0.11);
      const nextIn = (base + Math.random() * base) * dread;
      this._whisperTimeout = setTimeout(() => {
        if (gameState === "PLAYING" && !isPaused) this.playWhisper();
        scheduleWhisper();
      }, nextIn);
    };
    scheduleWhisper();
  }

  stopAmbient() {
    if (this._creakTimeout) clearTimeout(this._creakTimeout);
    if (this._whisperTimeout) clearTimeout(this._whisperTimeout);
    this.threatActive = false; // so the tension layer works again next run
    if (!this.ambientNodes) return;
    const { masterGain } = this.ambientNodes;
    const now = this.ctx.currentTime;
    masterGain.gain.cancelScheduledValues(now);
    masterGain.gain.setValueAtTime(masterGain.gain.value, now);
    masterGain.gain.linearRampToValueAtTime(0.0001, now + 0.4);
    setTimeout(() => {
      try {
        masterGain.disconnect();
      } catch (e) {}
    }, 500);
    this.ambientNodes = null;
  }

  /** Smoothly raises/lowers the tension layer based on hunt state. */
  setThreat(isActive) {
    if (!this.ambientNodes || isActive === this.threatActive) return;
    this.threatActive = isActive;
    const now = this.ctx.currentTime;
    const target = isActive ? 0.12 : 0.0001;
    this.ambientNodes.tensionGain.gain.cancelScheduledValues(now);
    this.ambientNodes.tensionGain.gain.setValueAtTime(
      this.ambientNodes.tensionGain.gain.value,
      now,
    );
    this.ambientNodes.tensionGain.gain.linearRampToValueAtTime(
      target,
      now + 1.2,
    );
  }

  playCreak() {
    if (!this.ctx || this.muted) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = "sawtooth";
    const base = 70 + Math.random() * 60;
    osc.frequency.setValueAtTime(base, this.ctx.currentTime);
    osc.frequency.linearRampToValueAtTime(
      base * 0.6,
      this.ctx.currentTime + 1.4,
    );
    gain.gain.setValueAtTime(0.0001, this.ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.05, this.ctx.currentTime + 0.3);
    gain.gain.linearRampToValueAtTime(0.0001, this.ctx.currentTime + 1.4);
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start();
    osc.stop(this.ctx.currentTime + 1.5);
  }

  /**
   * ------------------------------------------------------------------
   * ENEMY FOOTSTEPS — the heavy, dragging steps of a hunter somewhere in
   * the dark. Volume, muffling and echo all come from its distance, and the
   * stereo pan tells you WHICH SIDE it is on. Listening is how you survive.
   * ------------------------------------------------------------------
   */
  playEnemyFootstep(distance, pan = 0, chasing = false) {
    if (!this.ctx || this.muted) return;
    const HEAR_RANGE = 380; // px — beyond this the maze swallows the sound
    if (distance > HEAR_RANGE) return;

    const closeness = 1 - distance / HEAR_RANGE; // 0 = far away, 1 = on top of you
    const vol =
      Math.pow(closeness, 1.4) * AUDIO_MIX.enemyFootstep * (chasing ? 1.25 : 1);
    if (distance < 220) caption("[Heavy footsteps]");
    if (vol < 0.02) return;

    const ctx = this.ctx;
    const now = ctx.currentTime;
    const out = this._panTo(ctx.destination, pan);

    // Deep body thud (much lower and slower than your own step)
    const thud = ctx.createOscillator();
    const thudGain = ctx.createGain();
    thud.type = "sine";
    thud.frequency.setValueAtTime(65 + Math.random() * 10, now);
    thud.frequency.exponentialRampToValueAtTime(28, now + 0.25);
    thudGain.gain.setValueAtTime(0.0001, now);
    thudGain.gain.linearRampToValueAtTime(0.7 * vol, now + 0.012);
    thudGain.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
    thud.connect(thudGain);
    thudGain.connect(out);
    thud.start(now);
    thud.stop(now + 0.3);

    // Wet scrape as the foot drags — distant steps are muffled
    const scrape = ctx.createBufferSource();
    scrape.buffer = this._getNoise();
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 350 + closeness * 1700;
    const scrapeGain = ctx.createGain();
    scrapeGain.gain.setValueAtTime(0.0001, now);
    scrapeGain.gain.linearRampToValueAtTime(1.1 * vol, now + 0.06);
    scrapeGain.gain.exponentialRampToValueAtTime(0.001, now + 0.34);
    scrape.connect(lp);
    lp.connect(scrapeGain);
    scrapeGain.connect(out);
    scrape.start(now, Math.random() * 1.5, 0.4);

    // Far away = more echo
    const send = ctx.createGain();
    send.gain.value = 0.4 + (1 - closeness) * 0.6;
    thudGain.connect(send);
    scrapeGain.connect(send);
    send.connect(this._getReverb());
  }

  /**
   * Called every frame with the distance to the closest hunter. If one gets
   * very close, something whispers right in your ear (at most every 7s).
   */
  setProximity(dist) {
    if (!this.ctx || dist > 140) return;
    const now = performance.now();
    if (now - this._lastCloseWhisper < 7000) return;
    this._lastCloseWhisper = now;
    this.playWhisper({ close: true });
  }

  /**
   * ------------------------------------------------------------------
   * SOUND PUZZLE AUDIO — the Echo Stone
   * ------------------------------------------------------------------
   */

  /** One of the 3 puzzle tones (0 = LOW, 1 = MID, 2 = HIGH): a glassy bell, panned left/centre/right. */
  playPuzzleTone(idx, volume = 1) {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const freq = PUZZLE_TONES[idx];

    const bus = ctx.createGain();
    bus.gain.value = 0.28 * volume * AUDIO_MIX.puzzle;
    bus.connect(this._panTo(ctx.destination, (idx - 1) * 0.6));
    const send = ctx.createGain();
    send.gain.value = 0.7;
    bus.connect(send);
    send.connect(this._getReverb());

    [
      [1, "sine", 1],
      [2, "triangle", 0.3],
      [3.01, "sine", 0.12],
    ].forEach(([mult, type, level]) => {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = freq * mult;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, now);
      g.gain.linearRampToValueAtTime(level, now + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, now + 1.3);
      osc.connect(g);
      g.connect(bus);
      osc.start(now);
      osc.stop(now + 1.4);
    });
  }

  /** Faint singing hum that an unsolved Echo Stone gives off, so you can find it by ear. */
  playPuzzleHum(volume = 1, pan = 0) {
    if (!this.ctx) return;
    caption("[Humming]");
    if (this.muted) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    const bus = ctx.createGain();
    bus.gain.value = 0.16 * volume * AUDIO_MIX.puzzle;
    bus.connect(this._panTo(ctx.destination, pan));
    const send = ctx.createGain();
    send.gain.value = 0.8;
    bus.connect(send);
    send.connect(this._getReverb());

    [146.8, 220.9].forEach((freq) => {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, now);
      g.gain.linearRampToValueAtTime(1, now + 0.7);
      g.gain.linearRampToValueAtTime(0.0001, now + 2.4);
      osc.connect(g);
      g.connect(bus);
      osc.start(now);
      osc.stop(now + 2.5);
    });
  }

  /** Bright rising arpeggio when the puzzle is solved. */
  playPuzzleSolved() {
    if (!this.ctx || this.muted) return;
    [293.66, 369.99, 440, 587.33].forEach((freq, i) => {
      setTimeout(() => {
        if (!this.ctx || this.muted) return;
        const ctx = this.ctx;
        const now = ctx.currentTime;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, now);
        g.gain.linearRampToValueAtTime(0.2 * AUDIO_MIX.puzzle, now + 0.01);
        g.gain.exponentialRampToValueAtTime(0.001, now + 1.2);
        g.connect(ctx.destination);
        const send = ctx.createGain();
        send.gain.value = 0.8;
        g.connect(send);
        send.connect(this._getReverb());
        const osc = ctx.createOscillator();
        osc.type = "sine";
        osc.frequency.value = freq;
        osc.connect(g);
        osc.start(now);
        osc.stop(now + 1.3);
      }, i * 110);
    });
  }

  /** Harsh dissonant buzz for a wrong note. */
  playPuzzleFail() {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.18 * AUDIO_MIX.puzzle, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.5);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 600;
    lp.connect(g);
    g.connect(ctx.destination);
    [110, 116.5].forEach((freq) => {
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.value = freq;
      osc.connect(lp);
      osc.start(now);
      osc.stop(now + 0.55);
    });
  }

  /**
   * ------------------------------------------------------------------
   * STORY BACKGROUND MUSIC (procedural — no audio files needed)
   *   - a slow, dark string-like pad that changes chord every few seconds
   *   - a sparse music-box melody floating on top, drenched in reverb
   *   - "ending" mood: slower, sparser, and the notes wilt downward
   * The recipe lives in STORY_MUSIC at the top of this file.
   * ------------------------------------------------------------------
   */
  startStoryMusic(mood = "intro") {
    if (!this.ctx) return;
    this.stopStoryMusic(0.5); // never stack two songs

    const ctx = this.ctx;
    const cfg = STORY_MUSIC[mood] || STORY_MUSIC.intro;

    const master = ctx.createGain();
    master.gain.setValueAtTime(0.0001, ctx.currentTime);
    master.gain.linearRampToValueAtTime(
      this.muted ? 0.0001 : AUDIO_MIX.music,
      ctx.currentTime + 3,
    );
    master.connect(ctx.destination);

    const m = {
      master,
      reverb: this._makeReverb(master, 3.2, 0.8),
      cfg,
      bar: 0,
      nextTime: ctx.currentTime + 0.1,
      lastNote: null,
    };
    this.musicNodes = m;

    // Keep ~2 seconds of music scheduled ahead of the audio clock
    const tick = () => {
      if (this.musicNodes !== m) return; // replaced or stopped
      while (m.nextTime < ctx.currentTime + 2) {
        this._scheduleMusicBar(m, m.nextTime);
        m.nextTime += cfg.barLen;
      }
      this._musicTimer = setTimeout(tick, 500);
    };
    tick();
  }

  stopStoryMusic(fade = 2) {
    if (this._musicTimer) clearTimeout(this._musicTimer);
    const m = this.musicNodes;
    if (!m) return;
    this.musicNodes = null;
    const now = this.ctx.currentTime;
    m.master.gain.cancelScheduledValues(now);
    m.master.gain.setValueAtTime(m.master.gain.value, now);
    m.master.gain.linearRampToValueAtTime(0.0001, now + fade);
    setTimeout(
      () => {
        try {
          m.master.disconnect();
        } catch (e) {}
      },
      fade * 1000 + 200,
    );
  }

  /** Schedules one chord (pad + sub bass) and its melody notes, starting at time `t0`. */
  _scheduleMusicBar(m, t0) {
    const ctx = this.ctx;
    const { cfg } = m;
    const chord = cfg.chords[m.bar % cfg.chords.length];
    m.bar++;

    // --- Pad: two slightly detuned saws per note, heavily low-passed ---
    chord.forEach((midi) => {
      [-6, 6].forEach((detune) => {
        const osc = ctx.createOscillator();
        osc.type = "sawtooth";
        osc.frequency.value = midiToFreq(midi);
        osc.detune.value = detune + (cfg.warp ? Math.random() * 30 - 15 : 0);
        const lp = ctx.createBiquadFilter();
        lp.type = "lowpass";
        lp.frequency.value = 420;
        lp.Q.value = 0.5;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.linearRampToValueAtTime(0.045, t0 + cfg.barLen * 0.4);
        g.gain.linearRampToValueAtTime(0.0001, t0 + cfg.barLen + 2);
        osc.connect(lp);
        lp.connect(g);
        g.connect(m.master);
        osc.start(t0);
        osc.stop(t0 + cfg.barLen + 2.2);
      });
    });

    // --- Sub bass: the chord's root, one octave down ---
    const sub = ctx.createOscillator();
    sub.type = "sine";
    sub.frequency.value = midiToFreq(chord[0] - 12);
    const subGain = ctx.createGain();
    subGain.gain.setValueAtTime(0.0001, t0);
    subGain.gain.linearRampToValueAtTime(0.08, t0 + cfg.barLen * 0.4);
    subGain.gain.linearRampToValueAtTime(0.0001, t0 + cfg.barLen + 2);
    sub.connect(subGain);
    subGain.connect(m.master);
    sub.start(t0);
    sub.stop(t0 + cfg.barLen + 2.2);

    // --- Music-box melody: random rests make it feel hesitant and lonely ---
    const beats = Math.floor(cfg.barLen / cfg.beat);
    for (let b = 0; b < beats; b++) {
      if (Math.random() > cfg.density) continue;
      const midi = this._pickMelodyNote(chord, m.lastNote);
      m.lastNote = midi;
      this._musicBoxNote(
        m,
        midiToFreq(midi),
        t0 + b * cfg.beat + Math.random() * 0.06,
      );
    }
  }

  /** Picks a melody note: favours the current chord's notes and small steps from the last note. */
  _pickMelodyNote(chord, lastNote) {
    const chordPcs = chord.map((n) => n % 12);
    const pool = [];
    for (let midi = 69; midi <= 88; midi++) {
      const pc = midi % 12;
      if (lastNote !== null && Math.abs(midi - lastNote) > 5) continue;
      if (chordPcs.includes(pc)) pool.push(midi, midi, midi);
      else if (MINOR_SCALE_PCS.includes(pc)) pool.push(midi);
    }
    if (pool.length === 0) return 76; // safety net
    return pool[Math.floor(Math.random() * pool.length)];
  }

  /** A single music-box "ting": sine + soft overtones, fast attack, long ringing decay. */
  _musicBoxNote(m, freq, t) {
    const ctx = this.ctx;
    const bus = ctx.createGain();
    bus.gain.value = 0.7;
    bus.connect(m.master);
    const send = ctx.createGain();
    send.gain.value = 0.9;
    bus.connect(send);
    send.connect(m.reverb);

    [
      [1, 0.22],
      [2, 0.08],
      [4.02, 0.03],
    ].forEach(([mult, level]) => {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq * mult, t);
      if (m.cfg.warp) {
        // slow "wilting" pitch bend — like a music box winding down
        osc.frequency.exponentialRampToValueAtTime(
          freq * mult * 0.955,
          t + 1.8,
        );
      }
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(level, t + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0005, t + 2.4);
      osc.connect(g);
      g.connect(bus);
      osc.start(t);
      osc.stop(t + 2.5);
    });
  }

  /**
   * Jumpscare shriek — a sub-bass "hit" transient, a harsh noise burst,
   * and a distorted, vibrato-wailing scream that slowly decays. Louder
   * and longer than a simple blip so the death moment actually lands.
   */
  playScream() {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const SCREAM_LEN = 1.9;

    // Distortion curve for a harsher, more "throat-shredding" tone
    const makeDistortion = (amount) => {
      const samples = 44100;
      const curve = new Float32Array(samples);
      for (let i = 0; i < samples; i++) {
        const x = (i * 2) / samples - 1;
        curve[i] =
          ((3 + amount) * x * 20 * (Math.PI / 180)) /
          (Math.PI + amount * Math.abs(x));
      }
      return curve;
    };

    // --- Sub-bass impact thump (the "gotcha" hit) ---
    const thump = ctx.createOscillator();
    const thumpGain = ctx.createGain();
    thump.type = "sine";
    thump.frequency.setValueAtTime(120, now);
    thump.frequency.exponentialRampToValueAtTime(35, now + 0.35);
    thumpGain.gain.setValueAtTime(0.9, now);
    thumpGain.gain.exponentialRampToValueAtTime(0.001, now + 0.4);
    thump.connect(thumpGain);
    thumpGain.connect(ctx.destination);
    thump.start(now);
    thump.stop(now + 0.4);

    // --- Sharp harsh noise burst on top of the impact ---
    const burstBuffer = ctx.createBuffer(
      1,
      ctx.sampleRate * 0.35,
      ctx.sampleRate,
    );
    const burstData = burstBuffer.getChannelData(0);
    for (let i = 0; i < burstData.length; i++)
      burstData[i] = Math.random() * 2 - 1;
    const burst = ctx.createBufferSource();
    burst.buffer = burstBuffer;
    const burstGain = ctx.createGain();
    burstGain.gain.setValueAtTime(0.8, now);
    burstGain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
    burst.connect(burstGain);
    burstGain.connect(ctx.destination);
    burst.start(now);

    // --- The scream itself: 3 detuned, vibrato-wailing voices that
    //     start high/loud and slowly bleed downward and fade out ---
    const screamBus = ctx.createGain();
    screamBus.gain.value = 1.0;
    const shaper = ctx.createWaveShaper();
    shaper.curve = makeDistortion(28);
    screamBus.connect(shaper);
    shaper.connect(ctx.destination);

    const voiceConfigs = [
      { startFreq: 1500, endFreq: 480, type: "sawtooth", detune: 0 },
      { startFreq: 1580, endFreq: 520, type: "sawtooth", detune: 18 },
      { startFreq: 1420, endFreq: 440, type: "square", detune: -14 },
    ];

    voiceConfigs.forEach((cfg, i) => {
      const osc = ctx.createOscillator();
      osc.type = cfg.type;
      osc.detune.value = cfg.detune;
      osc.frequency.setValueAtTime(cfg.startFreq, now);
      osc.frequency.exponentialRampToValueAtTime(
        cfg.endFreq,
        now + SCREAM_LEN * 0.85,
      );

      // Fast vibrato -> makes it read as a "wail" instead of a clean tone
      const vibrato = ctx.createOscillator();
      vibrato.frequency.value = 13 + i * 2;
      const vibratoGain = ctx.createGain();
      vibratoGain.gain.value = 35;
      vibrato.connect(vibratoGain);
      vibratoGain.connect(osc.frequency);
      vibrato.start(now);
      vibrato.stop(now + SCREAM_LEN);

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.linearRampToValueAtTime(0.22, now + 0.06);
      gain.gain.setValueAtTime(0.22, now + 0.5);
      gain.gain.exponentialRampToValueAtTime(0.001, now + SCREAM_LEN);

      osc.connect(gain);
      gain.connect(screamBus);
      osc.start(now);
      osc.stop(now + SCREAM_LEN);
    });
  }
}

const audioSys = new SoundSystem();

/**
 * ============================================================================
 * GAME CONFIGURATION & DIFFICULTY SETTINGS
 * ============================================================================
 */
const DIFFICULTIES = {
  EASY: {
    pulseRadius: 280,
    pulseDuration: 4.0,
    enemySpeed: 1.1,
    enemyDetectMult: 0.7,
    enemyCount: 1,
    footstepNoise: 12,
    flashlightRadius: 110, // Ambient dim visibility around player, always on
    pulseEnergyCost: 20, // Energy spent per manual SPACE pulse
    energyRegenRate: 18, // Energy regained per second
    puzzleNotes: 3, // Echo Stone melody length on level 1 (grows with level)
  },
  MEDIUM: {
    pulseRadius: 210,
    pulseDuration: 2.8,
    enemySpeed: 1.6,
    enemyDetectMult: 1.0,
    enemyCount: 2,
    footstepNoise: 20,
    flashlightRadius: 85,
    pulseEnergyCost: 30,
    energyRegenRate: 13,
    puzzleNotes: 3,
  },
  HARD: {
    pulseRadius: 150,
    pulseDuration: 1.8,
    enemySpeed: 2.2,
    enemyDetectMult: 1.4,
    enemyCount: 3,
    footstepNoise: 32,
    flashlightRadius: 60,
    pulseEnergyCost: 40,
    energyRegenRate: 9,
    puzzleNotes: 4,
  },
};

let currentDifficulty = DIFFICULTIES.MEDIUM;
let currentLevel = 1;

/**
 * ============================================================================
 * PROCEDURAL MAZE GENERATOR (Recursive Backtracker)
 * ============================================================================
 */
class MazeGenerator {
  constructor(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    this.grid = [];
    for (let r = 0; r < rows; r++) {
      let row = [];
      for (let c = 0; c < cols; c++) {
        row.push({
          r,
          c,
          walls: [true, true, true, true], // Top, Right, Bottom, Left
          visited: false,
        });
      }
      this.grid.push(row);
    }
  }

  generate() {
    let stack = [];
    let current = this.grid[0][0];
    current.visited = true;

    do {
      let next = this.getUnvisitedNeighbor(current);
      if (next) {
        next.visited = true;
        stack.push(current);
        this.removeWalls(current, next);
        current = next;
      } else if (stack.length > 0) {
        current = stack.pop();
      }
    } while (stack.length > 0);

    // Carve a handful of 2x2/3x3 open rooms on top of the perfect maze so
    // the player isn't boxed into 1-tile corridors the whole level. This is
    // purely wall-removal — a perfect maze is already fully connected, so
    // this can only add shortcuts, never break reachability.
    const roomCount = Math.max(1, Math.floor((this.cols * this.rows) / 50));
    this.carveOpenRooms(roomCount);

    return this.grid;
  }

  getUnvisitedNeighbor(cell) {
    let neighbors = [];
    let { r, c } = cell;

    if (r > 0 && !this.grid[r - 1][c].visited)
      neighbors.push(this.grid[r - 1][c]);
    if (c < this.cols - 1 && !this.grid[r][c + 1].visited)
      neighbors.push(this.grid[r][c + 1]);
    if (r < this.rows - 1 && !this.grid[r + 1][c].visited)
      neighbors.push(this.grid[r + 1][c]);
    if (c > 0 && !this.grid[r][c - 1].visited)
      neighbors.push(this.grid[r][c - 1]);

    if (neighbors.length > 0) {
      let idx = Math.floor(Math.random() * neighbors.length);
      return neighbors[idx];
    }
    return null;
  }

  removeWalls(a, b) {
    let x = a.c - b.c;
    if (x === 1) {
      a.walls[3] = false;
      b.walls[1] = false;
    } else if (x === -1) {
      a.walls[1] = false;
      b.walls[3] = false;
    }

    let y = a.r - b.r;
    if (y === 1) {
      a.walls[0] = false;
      b.walls[2] = false;
    } else if (y === -1) {
      a.walls[2] = false;
      b.walls[0] = false;
    }
  }

  /**
   * Carves `roomCount` random 2x2 or 3x3 open rooms by knocking down every
   * internal wall inside each block. Kept 1 cell away from the outer border
   * (so the start/exit corners always stay normal corridor-width).
   */
  carveOpenRooms(roomCount) {
    for (let i = 0; i < roomCount; i++) {
      const size = Math.random() < 0.5 ? 2 : 3;
      const maxR = this.rows - size - 1;
      const maxC = this.cols - size - 1;
      if (maxR < 1 || maxC < 1) continue; // maze too small for this room size

      const startR = 1 + Math.floor(Math.random() * maxR);
      const startC = 1 + Math.floor(Math.random() * maxC);

      for (let r = startR; r < startR + size; r++) {
        for (let c = startC; c < startC + size; c++) {
          const cell = this.grid[r][c];
          if (c + 1 < startC + size)
            this.removeWalls(cell, this.grid[r][c + 1]);
          if (r + 1 < startR + size)
            this.removeWalls(cell, this.grid[r + 1][c]);
        }
      }
    }
  }
}

/**
 * ============================================================================
 * GAME ENGINE CORE & CANVAS RENDERING
 * ============================================================================
 */
const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");

const CELL_SIZE = 60;
let mazeGrid = [];
let mazeCols = 11;
let mazeRows = 11;

let player = {
  x: 0,
  y: 0,
  radius: 12,
  speed: 2.2,
  vx: 0,
  vy: 0,
  invulnerable: false,
  invulnerableTimer: 0,
  eyeBuffTimer: 0,
  energy: 100,
  energyMax: 100,
  isMoving: false,
  facingLeft: false,

  // Directional run-cycle animation state
  frameX: 0, // current frame index within the 6-frame strip
  maxFrames: 6,
  timer: 0, // seconds accumulated since the last frame advance
  fps: 10, // frame-advance rate while moving
  currentDirection: "down", // 'down' | 'up' | 'left' | 'right'
};

let inventory = {
  keys: 0,
  candles: 0,
  hearts: 0,
  eyes: 0,
};

let keysRequired = 3;
let soundPulses = [];
let glassTiles = []; // Broken Glass hazard tiles for the current level
let dustParticles = [];
const MAX_DUST_PARTICLES = 240; // hard cap so a big multi-wall hit can't runaway
let enemies = [];
let items = [];
let puzzles = [];
let exitGate = null;

let isReadingNote = false;
let isFinalEscapeActive = false;
let gameState = "MENU"; // MENU, DIFFICULTY, STORY, PLAYING, JUMPSCARE, GAMEOVER
let currentDifficultyKey = "MEDIUM";

let isPaused = false;
let pausedBySettings = false; // true when opening Settings is what paused the game
let settingsOpen = false;
let rebindingAction = null; // Settings: which action is waiting for a new key
let visualCues = !!store.visualCues; // captions + directional sound arrows
let placedCandles = []; // lit candles on the floor: { x, y, timer }
let memoryRoute = null; // glowing route to the exit from a Memory Shrine: { cells, timer }
let gateUnseal = { progress: 0 }; // seconds the player has held the gate during the final escape
let runStats = { time: 0, deaths: 0, pulses: 0 };
let heartbeatTimer = 0;

// Tuning knobs for the systems above (seconds unless noted)
const UNSEAL_TIME = 8; // how long you must hold the gate while it unseals
const CHASE_MEMORY = 8; // how long a hunter keeps tracking you after a loud noise
const CANDLE_LIFETIME = 18;
const CANDLE_HURT_RADIUS = 46; // px — hunters this close to a flame get scorched
const CANDLE_LIGHT_RADIUS = 95; // px — how far a flame lights up the maze
const MEMORY_ROUTE_TIME = 15;

// The title and Game-Over screens are drawn natively on <canvas> (see
// drawMenuScreen / drawGameOverScreen). The DOM "menu-overlay" is only the
// difficulty picker, so it starts hidden, and the HUD stays hidden until a
// run actually starts.
document.getElementById("menu-overlay")?.classList.add("hidden");
document.getElementById("hud")?.classList.add("hidden");

// Key Input State
const keys = {};

/**
 * Rebindable actions. Movement stays on WASD / arrow keys; everything else can
 * be changed from the Settings panel and is remembered between visits.
 */
const DEFAULT_BINDINGS = {
  pulse: "Space",
  interact: "KeyE",
  heart: "Digit1",
  eye: "Digit2",
  candle: "KeyC",
  pause: "KeyP",
};
const ACTION_LABELS = {
  pulse: "Send echo pulse",
  interact: "Interact",
  heart: "Use Heart Relic",
  eye: "Use Eye Totem",
  candle: "Place Candle",
  pause: "Pause",
};
const RESERVED_KEYS = [
  "KeyW",
  "KeyA",
  "KeyS",
  "KeyD",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Escape",
  "Enter",
];
const bindings = { ...DEFAULT_BINDINGS, ...(store.bindings || {}) };

function actionForKey(code) {
  return Object.keys(bindings).find((a) => bindings[a] === code) || null;
}

/** Human-friendly key name ("KeyE" -> "E", "Digit1" -> "1", "Space" -> "SPACE"). */
function keyLabel(code) {
  return code
    .replace(/^Key/, "")
    .replace(/^Digit/, "")
    .replace(/^Numpad/, "Num ")
    .replace("Space", "SPACE");
}

/** "Press [E]" on a keyboard, "Tap USE" on a phone — so hints match the controls on screen. */
function pressPhrase(action, touchName) {
  return isTouchDevice()
    ? `Tap ${touchName}`
    : `Press [${keyLabel(bindings[action])}]`;
}

window.addEventListener("keydown", (e) => {
  // Settings panel is waiting for a new key to bind?
  if (rebindingAction) {
    e.preventDefault();
    captureRebind(e);
    return;
  }
  keys[e.code] = true;

  if (settingsOpen) {
    if (e.code === "Escape") closeSettings();
    return;
  }

  // While the Echo Stone panel is open it owns the keyboard (1/2/3 = tones)
  if (isSolvingPuzzle) {
    handlePuzzleKey(e);
    return;
  }

  const action = actionForKey(e.code);

  if (gameState === "PLAYING") {
    if (isReadingNote) {
      if (action === "interact" || e.code === "Escape") closeNoteModal();
      return;
    }
    if (e.code === "Escape" || action === "pause") {
      e.preventDefault();
      togglePause();
      return;
    }
    if (isPaused) return;

    if (action === "pulse") {
      e.preventDefault();
      playerTriggerPulse();
    } else if (action === "interact") {
      checkInteraction();
    } else if (action === "heart") {
      useHeartRelic();
    } else if (action === "eye") {
      useEyeTotem();
    } else if (action === "candle") {
      useCandle();
    }
  } else if (
    gameState === "MENU" &&
    (e.code === "Space" || e.code === "Enter")
  ) {
    e.preventDefault();
    enterGameFromMenu();
  } else if (gameState === "MENU" && e.code === "KeyC") {
    continueGame();
  } else if (gameState === "DIFFICULTY") {
    // Difficulty select: 1 = Easy, 2 = Medium, 3 = Hard, C = continue, Esc = back
    const picks = {
      Digit1: "EASY",
      Digit2: "MEDIUM",
      Digit3: "HARD",
      Numpad1: "EASY",
      Numpad2: "MEDIUM",
      Numpad3: "HARD",
    };
    if (picks[e.code]) startGame(picks[e.code]);
    else if (e.code === "KeyC") continueGame();
    else if (e.code === "Escape") backToTitle();
  } else if (
    gameState === "GAMEOVER" &&
    (e.code === "Space" || e.code === "Enter")
  ) {
    e.preventDefault();
    restartFromGameOver();
  }
});
window.addEventListener("keyup", (e) => {
  keys[e.code] = false;
});

// Click-to-enter / click-to-restart / click-to-resume — also doubles as the
// required Web Audio unlock gesture (browsers block audio until a real user
// gesture).
window.addEventListener("click", (e) => {
  // don't hijack real UI buttons (mute, settings...) or the settings panel
  if (
    e.target.closest &&
    e.target.closest("button, #settings-panel, #rotate-overlay")
  )
    return;
  if (settingsOpen) return;
  if (gameState === "MENU") {
    enterGameFromMenu();
  } else if (gameState === "GAMEOVER") {
    restartFromGameOver();
  } else if (gameState === "PLAYING" && isPaused) {
    setPaused(false);
  }
});

/**
 * Pausing freezes the simulation AND suspends the audio clock, so nothing
 * (whispers, drones, queued sounds) keeps playing behind the pause screen.
 */
function setPaused(value) {
  if (value === isPaused) return;
  isPaused = value;
  if (audioSys.ctx) {
    if (value) audioSys.ctx.suspend();
    else audioSys.ctx.resume();
  }
  if (value) {
    // Forget held keys/joystick so nothing is "stuck" when we come back
    Object.keys(keys).forEach((k) => (keys[k] = false));
    touchMove.x = 0;
    touchMove.y = 0;
  }
}

function togglePause() {
  if (gameState !== "PLAYING" || isReadingNote || isSolvingPuzzle) return;
  setPaused(!isPaused);
}

// Auto-pause when the player tabs away or the window loses focus
function autoPause() {
  Object.keys(keys).forEach((k) => (keys[k] = false));
  if (
    gameState === "PLAYING" &&
    !isPaused &&
    !isReadingNote &&
    !isSolvingPuzzle
  ) {
    setPaused(true);
  }
}
window.addEventListener("blur", autoPause);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) autoPause();
});

/**
 * ============================================================================
 * TOUCH CONTROLS (mobile) — virtual joystick + ECHO/PULSE and Interact buttons
 * ============================================================================
 * `touchMove` is read every frame by updatePlayer(dt) exactly like the WASD
 * keys are, just as an analog -1..1 vector instead of a digital one, so
 * touch and keyboard input can even be mixed on hybrid devices for free.
 */
let touchMove = { x: 0, y: 0 };

(function setupTouchControls() {
  const zone = document.getElementById("touch-joystick-zone");
  const base = document.getElementById("touch-joystick-base");
  const knob = document.getElementById("touch-joystick-knob");
  const pulseBtn = document.getElementById("touch-pulse-btn");
  const interactBtn = document.getElementById("touch-interact-btn");
  if (!zone || !base || !knob || !pulseBtn || !interactBtn) return; // markup not present — skip silently

  const DEADZONE = 0.12; // ignore tiny accidental drags near center
  let activeTouchId = null;
  // Floating stick: the ring is re-centred wherever the thumb lands, so the
  // player never has to look down to find it. These are set on touchstart.
  let originX = 0;
  let originY = 0;
  let radius = 45; // px the knob may travel — ~36% of the ring, so it scales with screen size

  function setKnobOffset(dx, dy) {
    knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
  }

  function resetJoystick() {
    activeTouchId = null;
    touchMove.x = 0;
    touchMove.y = 0;
    zone.classList.remove("active");
    setKnobOffset(0, 0);
    // hand the ring back to its resting spot (bottom-left, set in CSS)
    base.style.left = "";
    base.style.top = "";
    base.style.bottom = "";
  }

  /** Centres the ring on the touch point, kept fully inside the touch zone. */
  function placeJoystick(touch) {
    const zoneRect = zone.getBoundingClientRect();
    const size = base.offsetWidth || 120;
    radius = size * 0.36;
    const half = size / 2;
    originX = Math.min(
      Math.max(touch.clientX, zoneRect.left + half),
      zoneRect.left + zoneRect.width - half,
    );
    originY = Math.min(
      Math.max(touch.clientY, zoneRect.top + half),
      zoneRect.top + zoneRect.height - half,
    );
    base.style.left = `${originX - zoneRect.left - half}px`;
    base.style.top = `${originY - zoneRect.top - half}px`;
    base.style.bottom = "auto";
  }

  function handleJoystickMove(touch) {
    let dx = touch.clientX - originX;
    let dy = touch.clientY - originY;
    const dist = Math.hypot(dx, dy);

    if (dist > radius) {
      dx = (dx / dist) * radius;
      dy = (dy / dist) * radius;
    }
    setKnobOffset(dx, dy);

    let nx = dx / radius;
    let ny = dy / radius;
    const mag = Math.hypot(nx, ny);
    if (mag < DEADZONE) {
      nx = 0;
      ny = 0;
    }
    touchMove.x = nx;
    touchMove.y = ny;
  }

  zone.addEventListener(
    "touchstart",
    (e) => {
      e.preventDefault();
      // The zone covers half the screen and swallows the synthetic click, so
      // tapping it while paused has to resume the game itself.
      if (gameState === "PLAYING" && isPaused && !settingsOpen) {
        setPaused(false);
        return;
      }
      if (activeTouchId !== null) return; // already steering with another finger
      const touch = e.changedTouches[0];
      activeTouchId = touch.identifier;
      zone.classList.add("active");
      placeJoystick(touch);
      handleJoystickMove(touch);
    },
    { passive: false },
  );

  zone.addEventListener(
    "touchmove",
    (e) => {
      e.preventDefault();
      for (const touch of e.changedTouches) {
        if (touch.identifier === activeTouchId) {
          handleJoystickMove(touch);
          break;
        }
      }
    },
    { passive: false },
  );

  function endJoystickTouch(e) {
    for (const touch of e.changedTouches) {
      if (touch.identifier === activeTouchId) {
        e.preventDefault();
        resetJoystick();
        break;
      }
    }
  }
  zone.addEventListener("touchend", endJoystickTouch, { passive: false });
  zone.addEventListener("touchcancel", endJoystickTouch, { passive: false });

  // ECHO / PULSE button — mirrors the Space key during gameplay, and also
  // works as the menu "enter" / game-over "restart" tap since those states
  // are handled by the window click listener already (this just prevents
  // this particular button from ALSO firing that click and double-firing).
  pulseBtn.addEventListener(
    "touchstart",
    (e) => {
      e.preventDefault();
      if (gameState === "PLAYING" && !isReadingNote && !isPaused) {
        playerTriggerPulse();
        // sonar ripple on the button itself (restart the animation on rapid taps)
        pulseBtn.classList.remove("ping");
        void pulseBtn.offsetWidth;
        pulseBtn.classList.add("ping");
      } else if (gameState === "MENU") {
        enterGameFromMenu();
      } else if (gameState === "GAMEOVER") {
        restartFromGameOver();
      }
    },
    { passive: false },
  );

  interactBtn.addEventListener(
    "touchstart",
    (e) => {
      e.preventDefault();
      if (gameState === "PLAYING" && !isReadingNote && !isPaused) {
        checkInteraction();
      } else if (isReadingNote) {
        closeNoteModal();
      }
    },
    { passive: false },
  );

  // Item buttons: Heart Relic, Eye Totem, Candle (same as keys 1 / 2 / C)
  [
    ["touch-heart-btn", () => useHeartRelic()],
    ["touch-eye-btn", () => useEyeTotem()],
    ["touch-candle-btn", () => useCandle()],
  ].forEach(([id, action]) => {
    document.getElementById(id)?.addEventListener(
      "touchstart",
      (e) => {
        e.preventDefault();
        if (
          gameState === "PLAYING" &&
          !isReadingNote &&
          !isPaused &&
          !isSolvingPuzzle
        ) {
          action();
        }
      },
      { passive: false },
    );
  });
})();

/**
 * Fired by the canvas title screen's "press space / click" prompt.
 * Unlocks the Web Audio context (must happen inside a user-gesture handler)
 * and opens the Easy / Medium / Hard picker. Picking a difficulty calls
 * startGame(), which kicks off the story.
 */
function enterGameFromMenu() {
  if (gameState !== "MENU") return;
  audioSys.init();
  tryLandscapeLock();
  gameState = "DIFFICULTY";
  refreshContinueButton();
  document.getElementById("menu-overlay").classList.remove("hidden");
}

/** Difficulty picker -> back to the canvas title screen. */
function backToTitle() {
  if (gameState !== "DIFFICULTY") return;
  gameState = "MENU";
  document.getElementById("menu-overlay").classList.add("hidden");
}

/** Restarts the current level from the canvas "YOU DIED" screen. */
function restartFromGameOver() {
  if (gameState !== "GAMEOVER") return;
  document.getElementById("hud")?.classList.remove("hidden");
  restartLevel();
}

/**
 * ============================================================================
 * RESPONSIVE CANVAS SIZING (desktop + mobile)
 * ============================================================================
 * The game world is always drawn in a fixed square logical coordinate
 * space — `viewW`/`viewH` below — regardless of the device's actual pixel
 * density. `resizeCanvas()` figures out the biggest square that fits the
 * current viewport (leaving room for on-screen touch controls on narrow
 * phones), sets the canvas's CSS size to that, and separately sizes the
 * underlying pixel buffer by devicePixelRatio so the game stays crisp on
 * retina/high-DPI phone screens. A single ctx.setTransform() then maps our
 * logical coordinates onto those physical pixels, so every draw call in
 * render()/drawMenuScreen()/drawGameOverScreen() can keep using `viewW`/
 * `viewH` exactly as if the canvas were always CSS-pixel sized.
 */
let viewW = 800;
let viewH = 800;

/** True on phones/tablets (touch is the primary input, no hover). */
function isTouchDevice() {
  return !!window.matchMedia?.("(hover: none) and (pointer: coarse)").matches;
}

/** Touch devices must be held sideways — see the #rotate-overlay in the CSS. */
function isPortraitTouch() {
  return !!window.matchMedia?.(
    "(orientation: portrait) and (hover: none) and (pointer: coarse)",
  ).matches;
}

/**
 * Best-effort: go fullscreen and lock to landscape after the first tap (only
 * allowed inside a user gesture). Unsupported browsers (iOS Safari) just
 * ignore it — the rotate screen still covers them.
 */
function tryLandscapeLock() {
  if (!isTouchDevice()) return;
  try {
    const el = document.documentElement;
    const enter = el.requestFullscreen || el.webkitRequestFullscreen;
    const entered = enter ? enter.call(el) : null;
    Promise.resolve(entered)
      .then(() => window.screen?.orientation?.lock?.("landscape"))
      .catch(() => {});
  } catch {
    /* fullscreen/orientation lock unavailable — ignore */
  }
}

/** Pixel size of the container's safe-area padding (notch, home indicator). */
function safeAreaInsets() {
  try {
    const cs = window.getComputedStyle(canvas.parentElement);
    return {
      x: parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) || 0,
      y: parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) || 0,
    };
  } catch {
    return { x: 0, y: 0 };
  }
}

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const maxSize = 800;

  let availW;
  let availH;
  if (isTouchDevice()) {
    // Landscape phone: the maze takes the full height. The joystick and
    // buttons float in the side margins (and over the maze edge on squarer
    // screens), so nothing is reserved below the canvas.
    const inset = safeAreaInsets();
    availW = window.innerWidth - inset.x - 8;
    availH = window.innerHeight - inset.y - 8;
  } else {
    availW = window.innerWidth - 32;
    availH = window.innerHeight - 32 - 40;
  }
  const size = Math.max(240, Math.min(availW, availH, maxSize));

  viewW = size;
  viewH = size;

  // CSS size = what the layout/touch-controls see; backing-store size =
  // CSS size * devicePixelRatio, for a sharp (non-blurry) canvas.
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size}px`;
  canvas.width = Math.round(size * dpr);
  canvas.height = Math.round(size * dpr);

  // Every subsequent draw call can now just use logical (CSS-pixel) coords.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // Turned upright mid-run? The CSS shows the rotate screen; freeze the game.
  if (isPortraitTouch()) autoPause();
}
window.addEventListener("resize", resizeCanvas);
// Mobile browsers fire 'resize' unreliably (or late) on rotation, and their
// address bar show/hide also resizes the visual viewport without always
// firing 'resize' on window — cover both cases explicitly.
window.addEventListener("orientationchange", () =>
  setTimeout(resizeCanvas, 60),
);
if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", resizeCanvas);
}
resizeCanvas();

/**
 * ============================================================================
 * GAME INITIALIZATION & LEVEL BUILDING
 * ============================================================================
 */
function initLevel(lvl) {
  closeSoundPuzzle(); // make sure no puzzle panel survives a level change / retry
  closeNoteModal();
  hideToast();
  audioSys.dreadLevel = lvl; // more whispers on deeper levels
  currentLevel = lvl;
  mazeCols = 9 + lvl * 2; // Scales complexity with level
  mazeRows = 9 + lvl * 2;

  const gen = new MazeGenerator(mazeCols, mazeRows);
  mazeGrid = gen.generate();

  // Spawn player at start (cell 0,0)
  player.x = CELL_SIZE * 0.5;
  player.y = CELL_SIZE * 0.5;
  player.invulnerable = false;
  player.invulnerableTimer = 0;
  player.eyeBuffTimer = 0;
  player.energy = player.energyMax;
  player.isMoving = false;
  player.frameX = 0;
  player.timer = 0;

  inventory.keys = 0;
  inventory.candles = 0;
  inventory.hearts = 1; // Start with one emergency relic
  inventory.eyes = 0;
  keysRequired = Math.min(3 + Math.floor(lvl / 2), 5);
  isFinalEscapeActive = false;
  gateUnseal.progress = 0;
  heartbeatTimer = 0;
  footstepTimer = 0;

  // Wipe everything left over from the previous level / attempt so old echoes,
  // dust and candle flames never haunt the fresh maze.
  soundPulses = [];
  dustParticles = [];
  placedCandles = [];
  memoryRoute = null;

  if (lvl > (store.bestLevel || 0)) saveStore({ bestLevel: lvl });

  updateHUD();

  // Place Exit Gate at bottom right
  exitGate = {
    x: (mazeCols - 0.5) * CELL_SIZE,
    y: (mazeRows - 0.5) * CELL_SIZE,
    unlocked: false,
  };

  // Populate Items, Puzzles & Enemies
  items = [];
  puzzles = [];
  enemies = [];

  spawnItemsAndPuzzles();
  spawnHazards();
  spawnEnemies();

  // Trigger initial tutorial sound pulse
  triggerSoundPulse(player.x, player.y, 1.2);

  if (lvl === 1) startTutorialHints();
}

function spawnItemsAndPuzzles() {
  let emptyCells = [];
  for (let r = 0; r < mazeRows; r++) {
    for (let c = 0; c < mazeCols; c++) {
      if (r === 0 && c === 0) continue;
      if (r === mazeRows - 1 && c === mazeCols - 1) continue;
      emptyCells.push({ r, c });
    }
  }
  shuffleArray(emptyCells);

  // Spawn Keys. One key piece is always locked inside the Echo Stone, so the
  // sound puzzle is required — the rest are scattered through the maze.
  for (let i = 0; i < keysRequired - 1; i++) {
    if (emptyCells.length === 0) break;
    let cell = emptyCells.pop();
    items.push({
      type: "KEY",
      x: (cell.c + 0.5) * CELL_SIZE,
      y: (cell.r + 0.5) * CELL_SIZE,
      radius: 10,
    });
  }

  // Spawn Whisper Candles
  for (let i = 0; i < 2; i++) {
    if (emptyCells.length === 0) break;
    let cell = emptyCells.pop();
    items.push({
      type: "CANDLE",
      x: (cell.c + 0.5) * CELL_SIZE,
      y: (cell.r + 0.5) * CELL_SIZE,
      radius: 10,
    });
  }

  // Spawn Heart Relics & Eye Totems
  if (emptyCells.length > 0) {
    let cell = emptyCells.pop();
    items.push({
      type: "HEART",
      x: (cell.c + 0.5) * CELL_SIZE,
      y: (cell.r + 0.5) * CELL_SIZE,
      radius: 10,
    });
  }
  if (emptyCells.length > 0) {
    let cell = emptyCells.pop();
    items.push({
      type: "EYE",
      x: (cell.c + 0.5) * CELL_SIZE,
      y: (cell.r + 0.5) * CELL_SIZE,
      radius: 10,
    });
  }

  // Spawn Cursed Note
  if (emptyCells.length > 0) {
    let cell = emptyCells.pop();
    items.push({
      type: "NOTE",
      x: (cell.c + 0.5) * CELL_SIZE,
      y: (cell.r + 0.5) * CELL_SIZE,
      radius: 10,
      text: getLoreNoteText(currentLevel),
    });
  }

  // Spawn Fake Objective Trap
  if (emptyCells.length > 0) {
    let cell = emptyCells.pop();
    items.push({
      type: "FAKE_KEY",
      x: (cell.c + 0.5) * CELL_SIZE,
      y: (cell.r + 0.5) * CELL_SIZE,
      radius: 10,
    });
  }

  // Spawn Puzzles
  if (emptyCells.length > 0) {
    let cell = emptyCells.pop();
    puzzles.push({
      type: "SOUND_PATTERN",
      x: (cell.c + 0.5) * CELL_SIZE,
      y: (cell.r + 0.5) * CELL_SIZE,
      solved: false,
      sequence: generatePuzzleSequence(), // e.g. [0, 2, 1] = LOW, HIGH, MID
      humTimer: Math.random() * 2, // countdown to the next proximity hum
    });
  }

  if (emptyCells.length > 0) {
    let cell = emptyCells.pop();
    puzzles.push({
      type: "MEMORY_MAZE",
      x: (cell.c + 0.5) * CELL_SIZE,
      y: (cell.r + 0.5) * CELL_SIZE,
      solved: false,
      activeTimer: 0,
    });
  }
}

function spawnHazards() {
  glassTiles = [];
  let candidates = [];
  for (let r = 0; r < mazeRows; r++) {
    for (let c = 0; c < mazeCols; c++) {
      if (r === 0 && c === 0) continue; // start
      if (r === mazeRows - 1 && c === mazeCols - 1) continue; // exit
      candidates.push({ r, c });
    }
  }
  shuffleArray(candidates);

  const occupied = (r, c) =>
    items.some(
      (it) =>
        Math.floor(it.y / CELL_SIZE) === r &&
        Math.floor(it.x / CELL_SIZE) === c,
    ) ||
    puzzles.some(
      (p) =>
        Math.floor(p.y / CELL_SIZE) === r && Math.floor(p.x / CELL_SIZE) === c,
    );

  const glassCount = Math.max(2, Math.floor((mazeCols * mazeRows) / 30));
  let placed = 0;
  for (const cell of candidates) {
    if (placed >= glassCount) break;
    if (occupied(cell.r, cell.c)) continue;
    glassTiles.push({
      x: (cell.c + 0.5) * CELL_SIZE,
      y: (cell.r + 0.5) * CELL_SIZE,
      radius: 16,
      broken: false, // once true, it's been stepped on and stops re-triggering
    });
    placed++;
  }
}

function spawnEnemies() {
  // Deeper levels add up to 2 extra hunters and make every hunter a bit faster.
  const numEnemies =
    currentDifficulty.enemyCount + Math.min(2, Math.floor((currentLevel - 1) / 2));
  const speed = currentDifficulty.enemySpeed * (1 + 0.04 * (currentLevel - 1));
  for (let i = 0; i < numEnemies; i++) {
    // Spawn far away from starting corner
    let rx = Math.floor(Math.random() * (mazeCols - 4)) + 4;
    let ry = Math.floor(Math.random() * (mazeRows - 4)) + 4;
    enemies.push({
      x: (rx + 0.5) * CELL_SIZE,
      y: (ry + 0.5) * CELL_SIZE,
      vx: 0,
      vy: 0,
      speed,
      state: "PATROL", // PATROL, INVESTIGATE, CHASE, DEAD
      targetX: (rx + 0.5) * CELL_SIZE,
      targetY: (ry + 0.5) * CELL_SIZE,
      patrolTimer: 0,
      jitterSeed: Math.random() * 100,
      facingLeft: false, // which way the sprite should be flipped
      isMoving: false, // drives idle vs. walk animation
      animName: "idle", // current animation strip, decided in updateEnemies()
      animHold: 0, // seconds left before animName is allowed to change again
      animStart: 0, // animTime when the current animation began (hurt/death play once)
      hp: ENEMY_MAX_HP, // candle burns left before it dies
      stunTimer: 0, // > 0 while staggering from a burn
      candleImmune: 0, // brief grace period so one flame can't chain-burn it
      chaseTimer: 0, // how long it will keep tracking the player
      deathTimer: 0, // corpse linger time once DEAD
    });
  }
}

function getLoreNoteText(lvl) {
  const notes = [
    "PAGE 1: 'The walls have ears. Literally. They absorb sound and reflect light. If you stand silent, you are blind. If you make noise, they come.'",
    "PAGE 2: 'Past victims tried marking walls, but the maze erases all traces. Trust only your memory. The blind beasts hear even your breathing.'",
    "PAGE 3: 'The Heart Relic keeps them at bay through ancient magic, but its pulse beats like a war drum in the dark. Use it wisely.'",
    "PAGE 4: 'Do not trust every key you find. Some are cursed lures crafted by the maze to trigger a hunt.'",
    "PAGE 5: 'The rituals require light, but candles draw whispers from the void. Set one on the floor and the beasts that touch it will burn. Listen to the pitch of the echo: one key piece sleeps inside a singing stone.'",
    "PAGE 6: 'The exit gate requires a violent acoustic shock to unseal. It takes time to open, and while it opens every monster in the maze will sprint toward you. Do not step away from the gate.'",
  ];
  return notes[lvl - 1] || "The text is scrawled in blood, unreadable.";
}

/**
 * ============================================================================
 * SOUND PULSE MECHANIC & VISUALIZATION (Core Spine)
 * ============================================================================
 */
function triggerSoundPulse(x, y, intensity = 1.0, loud = false) {
  let maxR = currentDifficulty.pulseRadius * intensity;
  if (player.eyeBuffTimer > 0) maxR *= 1.5;

  let duration = currentDifficulty.pulseDuration;

  soundPulses.push({
    x: x,
    y: y,
    radius: 10,
    maxRadius: maxR,
    speed: maxR / 0.3, // Expands rapidly
    alpha: 1.0,
    decay: 1.0 / duration,
    intensity: intensity,
    hitWalls: new Set(),
  });

  audioSys.playPulse(intensity);

  // Alert nearby enemies
  alertEnemies(x, y, maxR * currentDifficulty.enemyDetectMult, loud);
}

/**
 * Player-initiated pulse (SPACE key) — costs Sound Energy.
 * Scripted/event pulses (item pickups, puzzles, cutscenes) still call
 * triggerSoundPulse() directly and remain free, so the energy bar only
 * limits how often the PLAYER can spam pulses.
 */
function playerTriggerPulse() {
  const cost = currentDifficulty.pulseEnergyCost;
  if (player.energy >= cost) {
    player.energy -= cost;
    runStats.pulses++;
    triggerSoundPulse(player.x, player.y, 1.0);
  } else {
    audioSys.playDenied();
    const fill = document.getElementById("energy-fill");
    if (fill) {
      fill.classList.remove("denied");
      void fill.offsetWidth; // restart animation
      fill.classList.add("denied");
    }
  }
  updateEnergyBar();
}

/**
 * Wakes hunters within `radius` of a noise.
 *   - normal noise: calm hunters walk over to investigate the spot
 *   - loud noise (lures, the gate): hunters switch straight to CHASE and track
 *     your live position for CHASE_MEMORY seconds
 * Hunters that are already chasing just have their trail-memory refreshed.
 */
function alertEnemies(sourceX, sourceY, radius, loud = false) {
  enemies.forEach((enemy) => {
    if (enemy.state === "DEAD") return;
    const dist = Math.hypot(enemy.x - sourceX, enemy.y - sourceY);
    if (dist > radius) return;

    if (loud) {
      enemy.state = "CHASE";
      enemy.chaseTimer = Math.max(enemy.chaseTimer, CHASE_MEMORY);
    } else if (enemy.state === "CHASE") {
      enemy.chaseTimer = Math.max(enemy.chaseTimer, CHASE_MEMORY * 0.5);
    } else {
      enemy.state = "INVESTIGATE";
      enemy.targetX = sourceX;
      enemy.targetY = sourceY;
      enemy.investigateTimer = 0;
      enemy.hasArrivedAtSound = false;
    }
    audioSys.playGrowl();
  });
}

/**
 * ============================================================================
 * PLAYER CONTROLLER & INVENTORY ACTIONS
 * ============================================================================
 */
let footstepTimer = 0;

function updatePlayer(dt) {
  let moveX = 0;
  let moveY = 0;

  if (keys["KeyW"] || keys["ArrowUp"]) moveY -= 1;
  if (keys["KeyS"] || keys["ArrowDown"]) moveY += 1;
  if (keys["KeyA"] || keys["ArrowLeft"]) moveX -= 1;
  if (keys["KeyD"] || keys["ArrowRight"]) moveX += 1;

  // Merge in the on-screen touch joystick (analog -1..1 per axis)
  moveX += touchMove.x;
  moveY += touchMove.y;

  // You stand still while touching the Echo Stone (the hunters keep moving!)
  if (isSolvingPuzzle) {
    moveX = 0;
    moveY = 0;
  }

  // Normalize combined movement so diagonals (and joystick + keyboard
  // pressed together) never move faster than a single cardinal direction.
  const moveMag = Math.hypot(moveX, moveY);
  if (moveMag > 1) {
    moveX /= moveMag;
    moveY /= moveMag;
  }

  player.isMoving = moveX !== 0 || moveY !== 0;
  if (player.isMoving) {
    if (moveX < 0) player.facingLeft = true;
    else if (moveX > 0) player.facingLeft = false;

    // Pick the dominant axis of movement to drive the 4-way sprite —
    // diagonal input still resolves to a single clean facing direction.
    if (Math.abs(moveX) > Math.abs(moveY)) {
      player.currentDirection = moveX > 0 ? "right" : "left";
    } else {
      player.currentDirection = moveY > 0 ? "down" : "up";
    }

    // Advance the run-cycle frame at a fixed fps while actually moving
    player.timer += dt;
    const frameDuration = 1 / player.fps;
    if (player.timer >= frameDuration) {
      player.timer -= frameDuration;
      player.frameX = (player.frameX + 1) % player.maxFrames;
    }

    // Speed is "pixels per frame at 60fps", scaled by real elapsed time so the
    // game runs at the same pace on 60Hz, 120Hz and 144Hz screens.
    const step = dt * 60;
    let nextX = player.x + moveX * player.speed * step;
    let nextY = player.y + moveY * player.speed * step;

    // Collision detection against maze walls
    if (!checkWallCollision(nextX, player.y, player.radius)) {
      player.x = nextX;
    }
    if (!checkWallCollision(player.x, nextY, player.radius)) {
      player.y = nextY;
    }

    // Footstep audio & noise generation
    footstepTimer += dt;
    if (footstepTimer > 0.38) {
      footstepTimer = 0;
      audioSys.playFootstep();
      // Minor footstep noise pulse
      alertEnemies(
        player.x,
        player.y,
        currentDifficulty.footstepNoise * currentDifficulty.enemyDetectMult,
      );
    }
  } else {
    // Idle — reset to the strip's standing frame
    player.frameX = 0;
    player.timer = 0;
  }

  // Timers
  if (player.invulnerableTimer > 0) {
    player.invulnerableTimer -= dt;
    // One thump every ~0.6s (not once per frame). Each thump draws hunters
    // from further away, which is the price of the Heart Relic's protection.
    heartbeatTimer -= dt;
    if (heartbeatTimer <= 0) {
      heartbeatTimer = 0.6;
      audioSys.playHeartbeat();
      alertEnemies(player.x, player.y, 250);
    }
    if (player.invulnerableTimer <= 0) player.invulnerable = false;
  }

  if (player.eyeBuffTimer > 0) {
    player.eyeBuffTimer -= dt;
  }

  // Sound Energy regeneration (passive recharge over time)
  if (player.energy < player.energyMax) {
    player.energy = Math.min(
      player.energyMax,
      player.energy + currentDifficulty.energyRegenRate * dt,
    );
    updateEnergyBar();
  }

  // Check Item Pickups
  for (let i = items.length - 1; i >= 0; i--) {
    let item = items[i];
    let dist = Math.hypot(player.x - item.x, player.y - item.y);
    if (dist < player.radius + item.radius) {
      collectItem(item);
      items.splice(i, 1);
    }
  }

  // Check Broken Glass hazards — stepping on one gives away your position
  for (let i = 0; i < glassTiles.length; i++) {
    const glass = glassTiles[i];
    if (glass.broken) continue;
    const dist = Math.hypot(player.x - glass.x, player.y - glass.y);
    if (dist < player.radius + glass.radius * 0.6) {
      glass.broken = true;
      triggerSoundPulse(glass.x, glass.y, 0.6); // small pulse — alerts nearby enemies too
      showHint(
        "glass",
        "Crunch! Broken glass makes noise. Step around the faint glittering shards.",
      );
    }
  }
}

function collectItem(item) {
  audioSys.playPickup();

  // Pickups emit a noise radius
  triggerSoundPulse(item.x, item.y, 0.7);

  switch (item.type) {
    case "KEY":
      inventory.keys++;
      showToast(`Key piece found (${inventory.keys}/${keysRequired})`);
      showHint(
        "key",
        "Key pieces open the exit gate. Careful: some shiny keys are lures that summon hunters!",
      );
      unlockGateIfReady();
      break;
    case "CANDLE":
      inventory.candles++;
      // "Candles draw whispers from the void" (see Page 5)
      audioSys.playWhisper({ close: true, syllables: 6, volume: 1.2 });
      showToast("You picked up a candle.");
      showHint(
        "candle",
        `${pressPhrase("candle", "the candle button")} to place a candle. Hunters that touch the flame get scorched — two burns kill one.`,
      );
      break;
    case "HEART":
      inventory.hearts++;
      showToast("You picked up a Heart Relic.");
      showHint(
        "heart",
        `${pressPhrase("heart", "the heart button")} to become untouchable for 6 seconds. Your heartbeat is loud, though.`,
      );
      break;
    case "EYE":
      inventory.eyes++;
      showToast("You picked up an Eye Totem.");
      showHint(
        "eye",
        `${pressPhrase("eye", "the eye button")} to widen your echo range by half for 10 seconds.`,
      );
      break;
    case "NOTE":
      showNoteModal(item.text);
      break;
    case "FAKE_KEY":
      // Trap triggered! A loud lure: every hunter nearby starts hunting you.
      audioSys.playGrowl();
      triggerSoundPulse(player.x, player.y, 1.8);
      alertEnemies(player.x, player.y, 600, true);
      showToast("It was a lure! Something heard that — RUN!", 4500);
      break;
  }
  updateHUD();
}

/** Opens the gate's lock once enough key pieces are in the inventory. */
function unlockGateIfReady() {
  if (inventory.keys >= keysRequired && !exitGate.unlocked) {
    exitGate.unlocked = true;
    showToast(
      `All key pieces found! Head to the exit gate in the far bottom-right corner and press [${keyLabel(bindings.interact)}].`,
      6000,
    );
  }
}

function useHeartRelic() {
  if (inventory.hearts > 0 && !player.invulnerable) {
    inventory.hearts--;
    player.invulnerable = true;
    player.invulnerableTimer = 6.0; // 6 seconds invulnerability
    triggerSoundPulse(player.x, player.y, 1.2);
    updateHUD();
  }
}

function useEyeTotem() {
  if (inventory.eyes > 0) {
    inventory.eyes--;
    player.eyeBuffTimer = 10.0; // 10 seconds enhanced sound vision
    triggerSoundPulse(player.x, player.y, 1.5);
    updateHUD();
  }
}

/**
 * Places a lit candle on the floor. It lights up the maze around it, scorches
 * any hunter that touches it, and burns out after CANDLE_LIFETIME seconds.
 * Lighting it is noisy though — it whispers and wakes nearby hunters, which
 * makes a candle both a trap and a bait.
 */
function useCandle() {
  if (inventory.candles <= 0 || isSolvingPuzzle) return;
  inventory.candles--;
  placedCandles.push({ x: player.x, y: player.y, timer: CANDLE_LIFETIME });
  audioSys.playWhisper({ close: true, syllables: 4 });
  alertEnemies(
    player.x,
    player.y,
    150 * currentDifficulty.enemyDetectMult,
  );
  showToast("Candle lit. Anything that touches the flame will burn.");
  updateHUD();
}

/**
 * ============================================================================
 * INTERACTION & PUZZLE SYSTEMS
 * ============================================================================
 */
function checkInteraction() {
  if (isSolvingPuzzle) return; // the puzzle panel handles its own input

  // Exit Gate
  const distExit = Math.hypot(player.x - exitGate.x, player.y - exitGate.y);
  if (distExit < 40) {
    if (inventory.keys >= keysRequired) {
      if (!isFinalEscapeActive) triggerFinalEscapeSequence();
      // (already unsealing: just keep standing at the gate)
    } else {
      const need = keysRequired - inventory.keys;
      audioSys.playDenied();
      showToast(
        `The gate is sealed. You still need ${need} key piece${need > 1 ? "s" : ""}.`,
      );
    }
    return;
  }

  // Puzzles
  puzzles.forEach((puz) => {
    let dist = Math.hypot(player.x - puz.x, player.y - puz.y);
    if (dist < 35 && !puz.solved) {
      interactPuzzle(puz);
    }
  });
}

function interactPuzzle(puz) {
  if (puz.type === "SOUND_PATTERN") {
    openSoundPuzzle(puz);
  } else if (puz.type === "MEMORY_MAZE") {
    // The Memory Shrine burns the route to the exit into the floor for a
    // while, gives a candle, and (unlike other pulses) doesn't alert hunters.
    puz.solved = true;
    const from = worldToCell(player.x, player.y);
    const to = worldToCell(exitGate.x, exitGate.y);
    const path = findPathBFS(from.row, from.col, to.row, to.col);
    memoryRoute = path ? { cells: path, timer: MEMORY_ROUTE_TIME } : null;
    inventory.candles++;
    soundPulses.push({
      x: player.x,
      y: player.y,
      radius: 10,
      maxRadius: 600,
      speed: 1200,
      alpha: 1.0,
      decay: 0.25, // Quick flare
      intensity: 1.0,
      hitWalls: new Set(),
    });
    audioSys.playPuzzleSolved();
    updateHUD();
    showToast(
      "The shrine burns the way out into the floor — follow the violet trail. A candle appears in your hand.",
      6000,
    );
  }
}

function triggerFinalEscapeSequence() {
  isFinalEscapeActive = true;
  gateUnseal.progress = 0;
  audioSys.playGrowl();
  // Massive mandatory acoustic shock
  triggerSoundPulse(exitGate.x, exitGate.y, 2.5);
  // Every living hunter in the maze is alerted and never loses your trail
  enemies.forEach((e) => {
    if (e.state === "DEAD") return;
    e.state = "CHASE";
    e.chaseTimer = Infinity;
    e.speed *= 1.3; // Speed boost during final dash
  });
  showToast(
    `The gate is unsealing and every hunter heard it! STAY at the gate for ${UNSEAL_TIME} seconds!`,
    5000,
  );
}

/**
 * While the gate unseals the player must stay beside it. Stepping away makes
 * the progress drain back down; holding on for UNSEAL_TIME seconds opens it.
 */
function updateGate(dt) {
  if (!isFinalEscapeActive) return;
  const near = Math.hypot(player.x - exitGate.x, player.y - exitGate.y) < 55;
  if (near) {
    gateUnseal.progress += dt;
    if (gateUnseal.progress >= UNSEAL_TIME) {
      audioSys.playPuzzleSolved();
      completeLevel();
    }
  } else {
    gateUnseal.progress = Math.max(0, gateUnseal.progress - dt * 1.5);
  }
}

/** Timers for candles and the Memory Shrine's route, then the gate. */
function updateMisc(dt) {
  for (let i = placedCandles.length - 1; i >= 0; i--) {
    placedCandles[i].timer -= dt;
    if (placedCandles[i].timer <= 0) placedCandles.splice(i, 1);
  }
  if (memoryRoute) {
    memoryRoute.timer -= dt;
    if (memoryRoute.timer <= 0) memoryRoute = null;
  }
  updateGate(dt); // last: it can end the level and rebuild everything
}

/**
 * ============================================================================
 * SOUND PUZZLE — "THE ECHO STONE" (Simon Says, but with sound)
 * ============================================================================
 * How it works:
 *   1. Find an Echo Stone (it hums faintly — follow the sound), press [E].
 *   2. The stone plays a melody of LOW / MID / HIGH tones. Listen!
 *   3. Repeat it with keys 1 / 2 / 3 (or tap the buttons on mobile).
 *   4. Solve it -> you get a key piece. Get one wrong -> the stone screams,
 *      the maze lights up, hunters are drawn to you, and the melody replays.
 * Every tone you play is noise: hunters nearby will come to investigate, and
 * they keep moving while you solve — so you can be caught at the stone.
 */
let isSolvingPuzzle = false;
const soundPuzzle = {
  puz: null,
  phase: "IDLE", // IDLE | PLAYBACK | INPUT | DONE
  input: [], // tones the player has entered correctly so far
  timers: [], // pending setTimeouts, so we can cancel them all at once
};

/** Melody length grows with the level and the difficulty. */
function generatePuzzleSequence() {
  const len =
    currentDifficulty.puzzleNotes + Math.floor((currentLevel - 1) / 2);
  const seq = [];
  for (let i = 0; i < len; i++) {
    let tone = Math.floor(Math.random() * 3);
    // Avoid boring runs like LOW-LOW-LOW most of the time
    if (i > 0 && tone === seq[i - 1] && Math.random() < 0.7) {
      tone = (tone + 1 + Math.floor(Math.random() * 2)) % 3;
    }
    seq.push(tone);
  }
  return seq;
}

function spDelay(fn, ms) {
  soundPuzzle.timers.push(setTimeout(fn, ms));
}

function spClearTimers() {
  soundPuzzle.timers.forEach(clearTimeout);
  soundPuzzle.timers = [];
}

function setPuzzleStatus(text, isBad = false) {
  const el = document.getElementById("sp-status");
  if (!el) return;
  el.innerText = text;
  el.style.color = isBad ? "#f66" : "";
}

function renderPuzzleDots() {
  const el = document.getElementById("sp-dots");
  if (!el || !soundPuzzle.puz) return;
  el.innerHTML = soundPuzzle.puz.sequence
    .map(
      (_, i) =>
        `<span class="sp-dot${i < soundPuzzle.input.length ? " filled" : ""}"></span>`,
    )
    .join("");
}

function setToneButtonsLocked(locked) {
  document
    .querySelectorAll(".sp-tone")
    .forEach((b) => b.classList.toggle("locked", locked));
}

function flashToneButton(idx) {
  const btn = document.querySelector(`.sp-tone[data-tone="${idx}"]`);
  if (!btn) return;
  btn.classList.remove("flash");
  void btn.offsetWidth; // restart the CSS animation
  btn.classList.add("flash");
}

function openSoundPuzzle(puz) {
  if (isSolvingPuzzle || puz.solved) return;
  isSolvingPuzzle = true;
  soundPuzzle.puz = puz;
  player.isMoving = false;
  player.frameX = 0;
  document.getElementById("sound-puzzle").classList.remove("hidden");
  document.body.classList.add("puzzle-open");
  replayPuzzleSequence(600);
}

/** Plays the stone's melody (tones + button flashes), then hands control to the player. */
function replayPuzzleSequence(startDelay = 300) {
  const sp = soundPuzzle;
  if (!isSolvingPuzzle || !sp.puz || sp.phase === "DONE") return;

  spClearTimers();
  sp.phase = "PLAYBACK";
  sp.input = [];
  setPuzzleStatus("Listen closely...");
  renderPuzzleDots();
  setToneButtonsLocked(true);

  const STEP = 800; // ms between notes
  sp.puz.sequence.forEach((tone, i) => {
    spDelay(
      () => {
        audioSys.playPuzzleTone(tone);
        flashToneButton(tone);
      },
      startDelay + i * STEP,
    );
  });
  spDelay(
    () => {
      sp.phase = "INPUT";
      setToneButtonsLocked(false);
      setPuzzleStatus("Your turn - repeat the melody");
    },
    startDelay + sp.puz.sequence.length * STEP + 200,
  );
}

/** Player pressed a tone (0 = LOW, 1 = MID, 2 = HIGH). */
function pressPuzzleTone(idx) {
  const sp = soundPuzzle;
  if (!isSolvingPuzzle || sp.phase !== "INPUT") return;
  const puz = sp.puz;

  audioSys.playPuzzleTone(idx);
  flashToneButton(idx);

  if (idx === puz.sequence[sp.input.length]) {
    sp.input.push(idx);
    renderPuzzleDots();
    // Every tone is noise, but a correct one is quiet enough to survive
    alertEnemies(puz.x, puz.y, 110 * currentDifficulty.enemyDetectMult);
    if (sp.input.length === puz.sequence.length) solveSoundPuzzle();
  } else {
    // Wrong note: the stone screams, whispers, and lights up the maze.
    sp.phase = "PLAYBACK"; // lock input during the punishment
    setToneButtonsLocked(true);
    setPuzzleStatus("Wrong! The stone screams...", true);
    audioSys.playPuzzleFail();
    audioSys.playWhisper({ close: true, syllables: 5 });
    triggerSoundPulse(puz.x, puz.y, 1.0); // reveals the maze AND alerts hunters
    spClearTimers();
    spDelay(() => {
      sp.phase = "IDLE";
      replayPuzzleSequence(200);
    }, 1400);
  }
}

function solveSoundPuzzle() {
  const sp = soundPuzzle;
  const puz = sp.puz;
  sp.phase = "DONE";
  puz.solved = true;
  setToneButtonsLocked(true);
  setPuzzleStatus("The stone yields a key piece...");
  audioSys.playPuzzleSolved();

  inventory.keys++;
  unlockGateIfReady();
  updateHUD();

  spDelay(() => {
    triggerSoundPulse(puz.x, puz.y, 1.4); // the stone shatters loudly
    closeSoundPuzzle();
  }, 1200);
}

/** Safe to call any time (death, level change, menu) — does nothing if no panel is open. */
function closeSoundPuzzle() {
  spClearTimers();
  soundPuzzle.phase = "IDLE";
  soundPuzzle.input = [];
  soundPuzzle.puz = null;
  isSolvingPuzzle = false;
  document.getElementById("sound-puzzle")?.classList.add("hidden");
  document.body.classList.remove("puzzle-open");
}

function handlePuzzleKey(e) {
  const toneKeys = {
    Digit1: 0,
    Digit2: 1,
    Digit3: 2,
    Numpad1: 0,
    Numpad2: 1,
    Numpad3: 2,
  };
  // Stop Space/Enter from "clicking" whichever panel button has focus
  if (e.code === "Space" || e.code === "Enter" || e.code in toneKeys) {
    e.preventDefault();
  }
  if (e.repeat) return;

  if (e.code in toneKeys) pressPuzzleTone(toneKeys[e.code]);
  else if (e.code === "KeyR") replayPuzzleSequence();
  else if (e.code === "KeyE" || e.code === "Escape") closeSoundPuzzle();
}

// Wire up the panel buttons (script is `defer`, so the DOM is ready)
document.querySelectorAll(".sp-tone").forEach((btn) => {
  btn.addEventListener("click", () => {
    pressPuzzleTone(Number(btn.dataset.tone));
    btn.blur();
  });
});
document.getElementById("sp-replay")?.addEventListener("click", (e) => {
  replayPuzzleSequence();
  e.currentTarget.blur();
});
document
  .getElementById("sp-leave")
  ?.addEventListener("click", closeSoundPuzzle);

/**
 * Unsolved Echo Stones hum softly every few seconds. The hum is louder the
 * closer you are and panned toward the stone, so you can find it by ear.
 */
function updatePuzzles(dt) {
  if (isSolvingPuzzle) return;
  puzzles.forEach((puz) => {
    if (puz.type !== "SOUND_PATTERN" || puz.solved) return;
    puz.humTimer -= dt;
    if (puz.humTimer > 0) return;
    puz.humTimer = 2.8;

    const HUM_RANGE = 300;
    const dist = Math.hypot(puz.x - player.x, puz.y - player.y);
    if (dist > HUM_RANGE) return;
    const volume = Math.pow(1 - dist / HUM_RANGE, 1.3);
    const pan = Math.max(-1, Math.min(1, (puz.x - player.x) / 200));
    audioSys.playPuzzleHum(volume, pan);
    showHint(
      "stone",
      `You hear humming — an Echo Stone! Find it and press [${keyLabel(bindings.interact)}]. It holds a key piece.`,
    );
  });
}

/**
 * ============================================================================
 * ENEMY AI SYSTEM (Blind Hunters Driven by Sound)
 * ============================================================================
 */

// BFS
let _bfsVisited = null;
let _bfsParent = null;
let _bfsQueue = null;
let _bfsBufferedCells = 0;

function ensurePathBuffers() {
  const total = mazeCols * mazeRows;
  if (total !== _bfsBufferedCells) {
    _bfsVisited = new Uint8Array(total);
    _bfsParent = new Int32Array(total);
    _bfsQueue = new Int32Array(total);
    _bfsBufferedCells = total;
  }
}

function cellIdx(row, col) {
  return row * mazeCols + col;
}

/**
 * Shortest path from (startRow,startCol) to (endRow,endCol), inclusive of
 * both ends. Returns an array of {r, c} cells, or null if invalid/unreachable.
 */
function findPathBFS(startRow, startCol, endRow, endCol) {
  if (
    startRow < 0 ||
    startRow >= mazeRows ||
    startCol < 0 ||
    startCol >= mazeCols ||
    endRow < 0 ||
    endRow >= mazeRows ||
    endCol < 0 ||
    endCol >= mazeCols
  ) {
    return null;
  }
  if (startRow === endRow && startCol === endCol) {
    return [{ r: startRow, c: startCol }];
  }

  ensurePathBuffers();
  _bfsVisited.fill(0);

  const startIdx = cellIdx(startRow, startCol);
  const endIdx = cellIdx(endRow, endCol);

  let qHead = 0;
  let qTail = 0;
  _bfsQueue[qTail++] = startIdx;
  _bfsVisited[startIdx] = 1;
  _bfsParent[startIdx] = -1;

  let found = false;

  while (qHead < qTail) {
    const curIdx = _bfsQueue[qHead++];
    if (curIdx === endIdx) {
      found = true;
      break;
    }

    const r = (curIdx / mazeCols) | 0;
    const c = curIdx % mazeCols;
    const cell = mazeGrid[r][c];

    // walls: [0]=Top [1]=Right [2]=Bottom [3]=Left
    if (!cell.walls[0] && r > 0) {
      const n = cellIdx(r - 1, c);
      if (!_bfsVisited[n]) {
        _bfsVisited[n] = 1;
        _bfsParent[n] = curIdx;
        _bfsQueue[qTail++] = n;
      }
    }
    if (!cell.walls[1] && c < mazeCols - 1) {
      const n = cellIdx(r, c + 1);
      if (!_bfsVisited[n]) {
        _bfsVisited[n] = 1;
        _bfsParent[n] = curIdx;
        _bfsQueue[qTail++] = n;
      }
    }
    if (!cell.walls[2] && r < mazeRows - 1) {
      const n = cellIdx(r + 1, c);
      if (!_bfsVisited[n]) {
        _bfsVisited[n] = 1;
        _bfsParent[n] = curIdx;
        _bfsQueue[qTail++] = n;
      }
    }
    if (!cell.walls[3] && c > 0) {
      const n = cellIdx(r, c - 1);
      if (!_bfsVisited[n]) {
        _bfsVisited[n] = 1;
        _bfsParent[n] = curIdx;
        _bfsQueue[qTail++] = n;
      }
    }
  }

  if (!found) return null;

  const path = [];
  let idx = endIdx;
  while (idx !== -1) {
    path.push({ r: (idx / mazeCols) | 0, c: idx % mazeCols });
    idx = _bfsParent[idx];
  }
  path.reverse();
  return path;
}

function worldToCell(x, y) {
  return { row: Math.floor(y / CELL_SIZE), col: Math.floor(x / CELL_SIZE) };
}

function cellCenter(row, col) {
  return { x: (col + 0.5) * CELL_SIZE, y: (row + 0.5) * CELL_SIZE };
}

const PATH_ARRIVE_DIST = 8; // px — how close to a waypoint counts as "there"

/**
 * Paths the enemy one step closer to (targetX, targetY), following the
 * cached BFS route and re-pathing only when the destination cell changes.
 * Shared by CHASE and INVESTIGATE so both get identical smooth movement.
 * Returns true once the enemy has actually arrived at the destination.
 */
function pathTowardTarget(enemy, targetX, targetY, step = 1, speedMult = 1) {
  const targetCell = worldToCell(targetX, targetY);
  const targetCellIdx = cellIdx(targetCell.row, targetCell.col);

  if (
    targetCellIdx !== enemy.lastTargetCellIdx ||
    enemy.pathIndex >= enemy.path.length
  ) {
    const enemyCell = worldToCell(enemy.x, enemy.y);
    const newPath = findPathBFS(
      enemyCell.row,
      enemyCell.col,
      targetCell.row,
      targetCell.col,
    );
    enemy.path = newPath ? newPath.slice(1) : [];
    enemy.pathIndex = 0;
    enemy.lastTargetCellIdx = targetCellIdx;
  }

  let aimX = targetX;
  let aimY = targetY;
  if (enemy.pathIndex < enemy.path.length) {
    const node = enemy.path[enemy.pathIndex];
    const center = cellCenter(node.r, node.c);
    aimX = center.x;
    aimY = center.y;

    if (Math.hypot(aimX - enemy.x, aimY - enemy.y) < PATH_ARRIVE_DIST) {
      enemy.pathIndex++;
      if (enemy.pathIndex < enemy.path.length) {
        const next = cellCenter(
          enemy.path[enemy.pathIndex].r,
          enemy.path[enemy.pathIndex].c,
        );
        aimX = next.x;
        aimY = next.y;
      } else {
        aimX = targetX;
        aimY = targetY;
      }
    }
  }

  const dx = aimX - enemy.x;
  const dy = aimY - enemy.y;
  const dist = Math.hypot(dx, dy);

  if (dist > 2) {
    // `step` is elapsed time in 60fps-frames, so hunters keep the same pace on
    // any monitor refresh rate. Never overshoot the waypoint.
    const move = Math.min(dist, enemy.speed * speedMult * step);
    enemy.vx = (dx / dist) * move;
    enemy.vy = (dy / dist) * move;
    const nextX = enemy.x + enemy.vx;
    const nextY = enemy.y + enemy.vy;
    if (!checkWallCollision(nextX, enemy.y, 14)) enemy.x = nextX;
    if (!checkWallCollision(enemy.x, nextY, 14)) enemy.y = nextY;
  } else {
    enemy.vx = 0;
    enemy.vy = 0;
  }

  return (
    enemy.pathIndex >= enemy.path.length &&
    Math.hypot(targetX - enemy.x, targetY - enemy.y) <= 5
  );
}

const INVESTIGATE_WAIT_TIME = 3; // seconds spent "looking around" at the noise
const ENEMY_STRIDE = 34; // px an enemy walks between footstep sounds

/**
 * A candle flame scorches a hunter: it recoils and is stunned, forgets what it
 * was doing, and after ENEMY_MAX_HP burns it dies (death animation, then the
 * corpse disappears a few seconds later).
 */
function hurtEnemy(enemy) {
  enemy.hp -= 1;
  enemy.candleImmune = ENEMY_STUN_TIME + 1.5;
  enemy.animStart = animTime;
  enemy.vx = 0;
  enemy.vy = 0;
  audioSys.playGrowl();
  if (enemy.hp <= 0) {
    enemy.state = "DEAD";
    enemy.deathTimer = ENEMY_DEATH_LINGER;
    enemy.animName = "death";
    showToast("A hunter burns away into nothing...");
  } else {
    enemy.stunTimer = ENEMY_STUN_TIME;
    enemy.animName = "hurt";
    enemy.animHold = ENEMY_ANIM_MIN_HOLD;
    enemy.state = "PATROL"; // it staggers off instead of chasing
    enemy.patrolTimer = 0;
    showToast("The flame scorches a hunter! It staggers back.");
  }
}

function updateEnemies(dt) {
  let threatLevel = "NONE"; // NONE < INVESTIGATE < CHASE
  let nearestEnemyDist = Infinity;
  const step = dt * 60; // 1.0 == one frame at 60fps

  for (let i = enemies.length - 1; i >= 0; i--) {
    const enemy = enemies[i];

    // Lazy-init pathing/investigation state.
    if (enemy.path === undefined) {
      enemy.path = [];
      enemy.pathIndex = 0;
      enemy.lastTargetCellIdx = -1;
      enemy.investigateTimer = 0;
      enemy.hasArrivedAtSound = false;
      enemy.prevX = enemy.x; // for footstep spacing
      enemy.prevY = enemy.y;
      enemy.stepDist = 0;
    }

    // Corpses just wait to vanish; they never threaten anyone.
    if (enemy.state === "DEAD") {
      enemy.deathTimer -= dt;
      if (enemy.deathTimer <= 0) enemies.splice(i, 1);
      continue;
    }

    // Candle flames scorch hunters that wander into them
    if (enemy.stunTimer > 0) enemy.stunTimer -= dt;
    if (enemy.candleImmune > 0) enemy.candleImmune -= dt;
    if (enemy.stunTimer <= 0 && enemy.candleImmune <= 0) {
      const flame = placedCandles.find(
        (c) => Math.hypot(enemy.x - c.x, enemy.y - c.y) < CANDLE_HURT_RADIUS,
      );
      if (flame) {
        hurtEnemy(enemy);
        if (enemy.state === "DEAD") continue;
      }
    }
    const stunned = enemy.stunTimer > 0;
    if (stunned) {
      enemy.vx = 0;
      enemy.vy = 0;
    }

    if (enemy.state === "CHASE") {
      threatLevel = "CHASE";
      if (!stunned) {
        // A hunter that is right beside you never loses the trail
        const closeNow = Math.hypot(enemy.x - player.x, enemy.y - player.y);
        if (closeNow < 110) {
          enemy.chaseTimer = Math.max(enemy.chaseTimer, CHASE_MEMORY * 0.5);
        }
        enemy.chaseTimer -= dt;
        if (enemy.chaseTimer > 0) {
          // Tracks your LIVE position while it can still hear you...
          enemy.targetX = player.x;
          enemy.targetY = player.y;
          pathTowardTarget(enemy, player.x, player.y, step, 1);
        } else {
          // ...then loses you and goes to check the last place it heard you.
          enemy.state = "INVESTIGATE";
          enemy.hasArrivedAtSound = false;
          enemy.targetX = player.x;
          enemy.targetY = player.y;
        }
      }
    } else if (enemy.state === "INVESTIGATE") {
      if (threatLevel !== "CHASE") threatLevel = "INVESTIGATE";

      if (!stunned) {
        if (!enemy.hasArrivedAtSound) {
          // Still walking toward where the sound came from.
          const arrived = pathTowardTarget(
            enemy,
            enemy.targetX,
            enemy.targetY,
            step,
            1,
          );
          if (arrived) {
            enemy.hasArrivedAtSound = true;
            enemy.investigateTimer = INVESTIGATE_WAIT_TIME;
            enemy.vx = 0;
            enemy.vy = 0;
          }
        } else {
          // Standing at the noise's origin, looking around for 3 seconds.
          // If alertEnemies() re-triggers with a new location during this
          // window, targetX/Y changes, hasArrivedAtSound resets to false via
          // alertEnemies, and pathTowardTarget will naturally re-path there.
          enemy.investigateTimer -= dt;
          if (enemy.investigateTimer <= 0) {
            enemy.state = "PATROL";
            enemy.hasArrivedAtSound = false;
            enemy.patrolTimer = 0;
          }
        }
      }
    } else if (enemy.state === "PATROL") {
      if (!stunned) {
        // Wander between random spots, following real corridors (BFS) instead
        // of pushing into walls, at a slow prowling pace.
        enemy.patrolTimer -= dt;
        const arrived = pathTowardTarget(
          enemy,
          enemy.targetX,
          enemy.targetY,
          step,
          0.4,
        );
        if (arrived || enemy.patrolTimer <= 0) {
          enemy.patrolTimer = 6 + Math.random() * 6;
          enemy.targetX = (Math.floor(Math.random() * mazeCols) + 0.5) * CELL_SIZE;
          enemy.targetY = (Math.floor(Math.random() * mazeRows) + 0.5) * CELL_SIZE;
        }
      }
    }

    // Distance to the player after this frame's movement
    const distToPlayer = Math.hypot(enemy.x - player.x, enemy.y - player.y);
    nearestEnemyDist = Math.min(nearestEnemyDist, distToPlayer);

    // Footsteps: one step per ENEMY_STRIDE pixels actually walked, so a slow
    // patrol shuffles and a chasing hunter thunders — the pace itself is a
    // warning. Volume + stereo pan tell you how far away and on which side.
    const moveDX = enemy.x - enemy.prevX;
    const moveDY = enemy.y - enemy.prevY;
    const moveDist = Math.hypot(moveDX, moveDY);

    // Raw per-frame displacement is noisy — a corridor wall can block just
    // one axis for a single frame, pathfinding snaps a hair short of a
    // waypoint, etc. — so "moving" is held true for a short grace window
    // rather than toggling every frame. The threshold scales with `step` so it
    // behaves the same at any frame rate.
    enemy.movingHold = Math.max(0, (enemy.movingHold || 0) - dt);
    if (moveDist > 0.4 * step) {
      enemy.movingHold = 0.15;
      if (Math.abs(moveDX) > 0.4 * step) enemy.facingLeft = moveDX < 0;
    }
    enemy.isMoving = enemy.movingHold > 0;

    enemy.stepDist += moveDist;
    enemy.prevX = enemy.x;
    enemy.prevY = enemy.y;

    // Sprite animation state (idle / walk / attack1 / attack2 / hurt) —
    // decided here, every frame, with a minimum hold time so it can't flicker
    // back and forth when the enemy hovers right at the attack-lunge boundary.
    const desiredAnim = getDesiredEnemyAnim(enemy, distToPlayer);
    enemy.animHold = Math.max(0, (enemy.animHold || 0) - dt);
    if (
      desiredAnim !== enemy.animName &&
      (enemy.animHold <= 0 || desiredAnim === "hurt")
    ) {
      enemy.animName = desiredAnim;
      enemy.animHold = ENEMY_ANIM_MIN_HOLD;
      enemy.animStart = animTime;
    }

    if (enemy.stepDist >= ENEMY_STRIDE) {
      enemy.stepDist -= ENEMY_STRIDE;
      audioSys.playEnemyFootstep(
        distToPlayer,
        (enemy.x - player.x) / 250,
        enemy.state === "CHASE",
      );
    }

    // A staggering (stunned) hunter can't catch you
    if (!stunned && distToPlayer < player.radius + 12) {
      if (!player.invulnerable) {
        triggerGameOver();
      }
    }
  }

  const threatEl = document.getElementById("hud-threat");
  if (threatLevel === "CHASE") {
    threatEl.innerText = "HIGH (HUNTED)";
    threatEl.style.color = "#f33";
  } else if (threatLevel === "INVESTIGATE") {
    threatEl.innerText = "SUSPICIOUS";
    threatEl.style.color = "#dd5";
  } else {
    threatEl.innerText = "LOW";
    threatEl.style.color = "#4a4";
  }
  if (threatLevel !== "NONE") {
    showHint(
      "hunter",
      "A hunter heard you! Stay still and quiet, run, or lure it into a candle flame.",
    );
  }

  audioSys.setThreat(threatLevel !== "NONE");
  audioSys.setProximity(nearestEnemyDist);
}

/**
 * ============================================================================
 * MAZE COLLISION DETECTION ENGINE
 * ============================================================================
 */
/** Squared distance from point (px,py) to the line segment (x1,y1)-(x2,y2). */
function distSqToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * dx;
  const cy = y1 + t * dy;
  return (px - cx) * (px - cx) + (py - cy) * (py - cy);
}

/**
 * True if a circle at (px,py) with `radius` touches any maze wall. It tests the
 * circle against the real wall segments of the 3x3 block of cells around it,
 * so it also catches wall ENDS (corners) that stick out of neighbouring cells —
 * the old version only looked at the current cell and could clip through them.
 */
function checkWallCollision(px, py, radius) {
  const col = Math.floor(px / CELL_SIZE);
  const row = Math.floor(py / CELL_SIZE);

  if (col < 0 || col >= mazeCols || row < 0 || row >= mazeRows) return true;

  const r2 = radius * radius;
  const minR = Math.max(0, row - 1);
  const maxR = Math.min(mazeRows - 1, row + 1);
  const minC = Math.max(0, col - 1);
  const maxC = Math.min(mazeCols - 1, col + 1);

  for (let r = minR; r <= maxR; r++) {
    for (let c = minC; c <= maxC; c++) {
      const cell = mazeGrid[r][c];
      const x = c * CELL_SIZE;
      const y = r * CELL_SIZE;
      // walls: [0]=Top [1]=Right [2]=Bottom [3]=Left
      if (cell.walls[0] && distSqToSegment(px, py, x, y, x + CELL_SIZE, y) < r2)
        return true;
      if (
        cell.walls[1] &&
        distSqToSegment(px, py, x + CELL_SIZE, y, x + CELL_SIZE, y + CELL_SIZE) <
          r2
      )
        return true;
      if (
        cell.walls[2] &&
        distSqToSegment(px, py, x, y + CELL_SIZE, x + CELL_SIZE, y + CELL_SIZE) <
          r2
      )
        return true;
      if (cell.walls[3] && distSqToSegment(px, py, x, y, x, y + CELL_SIZE) < r2)
        return true;
    }
  }

  return false;
}

function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

/**
 * ============================================================================
 * MAIN RENDERING LOOP (Blackout Light & Sound Echo System)
 * ============================================================================
 */
let lastTime = performance.now();

function gameLoop(now) {
  let dt = (now - lastTime) / 1000;
  if (dt > 0.05) dt = 0.05; // Cap dt on tab unfocus / slow frames (keeps movement collision-safe)
  lastTime = now;

  animTime += dt;

  // Lets the CSS show the touch controls only while a run is on screen
  if (document.body.dataset.state !== gameState) {
    document.body.dataset.state = gameState;
  }

  if (gameState === "PLAYING" && !isReadingNote && !isPaused) {
    runStats.time += dt;
    updatePlayer(dt);
    updatePuzzles(dt);
    updateEnemies(dt);
    updatePulses(dt);
    updateMisc(dt);
  }

  render();

  requestAnimationFrame(gameLoop);
}

function updatePulses(dt) {
  for (let i = soundPulses.length - 1; i >= 0; i--) {
    let p = soundPulses[i];
    const oldRadius = p.radius;
    p.radius += p.speed * dt;
    p.alpha -= p.decay * dt;

    // Spawn dust wherever the expanding wavefront swept past a wall THIS
    // frame — scans only the pulse's own bounding box, not the whole maze.
    spawnWallDustForPulse(p, oldRadius, p.radius);

    if (p.radius >= p.maxRadius || p.alpha <= 0) {
      soundPulses.splice(i, 1);
    }
  }

  updateDustParticles(dt);
}

/**
 * Finds wall segments the pulse's wavefront just crossed (between
 * oldRadius and newRadius) and spawns a dust burst there. Only inspects
 * grid cells inside the pulse's current bounding circle, so cost scales
 * with pulse size — not maze size — even on large late-level mazes.
 */
function spawnWallDustForPulse(pulse, oldRadius, newRadius) {
  const minC = Math.max(0, Math.floor((pulse.x - newRadius) / CELL_SIZE));
  const maxC = Math.min(
    mazeCols - 1,
    Math.floor((pulse.x + newRadius) / CELL_SIZE),
  );
  const minR = Math.max(0, Math.floor((pulse.y - newRadius) / CELL_SIZE));
  const maxR = Math.min(
    mazeRows - 1,
    Math.floor((pulse.y + newRadius) / CELL_SIZE),
  );

  for (let r = minR; r <= maxR; r++) {
    for (let c = minC; c <= maxC; c++) {
      const cell = mazeGrid[r][c];
      const x = c * CELL_SIZE;
      const y = r * CELL_SIZE;

      if (cell.walls[0])
        tryEmitFromWall(
          pulse,
          oldRadius,
          newRadius,
          x,
          y,
          x + CELL_SIZE,
          y,
          `${r}-${c}-0`,
        );
      if (cell.walls[1])
        tryEmitFromWall(
          pulse,
          oldRadius,
          newRadius,
          x + CELL_SIZE,
          y,
          x + CELL_SIZE,
          y + CELL_SIZE,
          `${r}-${c}-1`,
        );
      if (cell.walls[2])
        tryEmitFromWall(
          pulse,
          oldRadius,
          newRadius,
          x + CELL_SIZE,
          y + CELL_SIZE,
          x,
          y + CELL_SIZE,
          `${r}-${c}-2`,
        );
      if (cell.walls[3])
        tryEmitFromWall(
          pulse,
          oldRadius,
          newRadius,
          x,
          y + CELL_SIZE,
          x,
          y,
          `${r}-${c}-3`,
        );
    }
  }
}

function tryEmitFromWall(pulse, oldRadius, newRadius, x1, y1, x2, y2, key) {
  if (pulse.hitWalls.has(key)) return; // this segment already sparked once

  const midX = (x1 + x2) / 2;
  const midY = (y1 + y2) / 2;
  const dist = Math.hypot(midX - pulse.x, midY - pulse.y);

  if (dist >= oldRadius && dist <= newRadius) {
    pulse.hitWalls.add(key);
    spawnDustBurst(midX, midY);
  }
}

function spawnDustBurst(x, y) {
  const count = 3 + Math.floor(Math.random() * 3); // 3-5 tiny motes per hit
  for (let i = 0; i < count; i++) {
    if (dustParticles.length >= MAX_DUST_PARTICLES) {
      dustParticles.shift(); // drop the oldest instead of growing forever
    }
    dustParticles.push({
      x: x + (Math.random() - 0.5) * 6,
      y: y + (Math.random() - 0.5) * 6,
      vx: (Math.random() - 0.5) * 8,
      vy: 6 + Math.random() * 10, // slow downward drift
      life: 1.0,
      maxLife: 1.0,
      size: 1 + Math.random() * 1.5,
    });
  }
}

function updateDustParticles(dt) {
  for (let i = dustParticles.length - 1; i >= 0; i--) {
    const d = dustParticles[i];
    d.life -= dt;
    if (d.life <= 0) {
      dustParticles.splice(i, 1);
      continue;
    }
    d.x += d.vx * dt;
    d.y += d.vy * dt;
    d.vy += 4 * dt; // slight gravity so the drift accelerates a touch
  }
}

/**
 * ============================================================================
 * ANIMATION HELPERS (idle bob / flicker / pulse / twitch)
 * ============================================================================
 * These return cheap per-frame transform offsets driven by animTime, so
 * every character and item feels alive instead of a static pinned icon.
 * A per-object seed (derived from its spawn position) keeps items out of
 * phase with each other so the whole maze doesn't pulse in unison.
 */
function seedFor(x, y) {
  return (x * 12.9898 + y * 78.233) % 100;
}

function drawGlassShards(x, y, alpha) {
  ctx.save();
  ctx.strokeStyle = `rgba(220, 240, 255, ${alpha})`;
  ctx.lineWidth = 1.5;
  const shardOffsets = [
    [-6, -3, 4, 2],
    [3, -5, -2, 5],
    [-4, 4, 6, -1],
  ];
  shardOffsets.forEach(([x1, y1, x2, y2]) => {
    ctx.beginPath();
    ctx.moveTo(x + x1, y + y1);
    ctx.lineTo(x + x2, y + y2);
    ctx.stroke();
  });
  ctx.restore();
}

function renderDustParticles() {
  if (dustParticles.length === 0) return;
  ctx.save();
  dustParticles.forEach((d) => {
    const t = d.life / d.maxLife; // 1 -> 0 over its ~1s lifetime
    ctx.globalAlpha = t * 0.8;
    ctx.fillStyle = "rgba(200, 225, 255, 1)";
    ctx.beginPath();
    ctx.arc(d.x, d.y, d.size, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.restore();
}

function getItemAnimOpts(item) {
  const t = animTime * 3 + seedFor(item.x, item.y);
  switch (item.type) {
    case "CANDLE":
      // Flame flicker: jittery scale + slight rotation
      return {
        scaleX: 1 + Math.sin(t * 4) * 0.08 + (Math.random() - 0.5) * 0.05,
        scaleY: 1 + Math.cos(t * 5) * 0.1 + (Math.random() - 0.5) * 0.06,
        rotation: Math.sin(t * 2) * 0.06,
        offsetY: Math.sin(t * 1.7) * 1.5,
      };
    case "KEY":
    case "FAKE_KEY":
      // Gentle bob + slow spin glint
      return {
        offsetY: Math.sin(t) * 3,
        rotation: Math.sin(t * 0.6) * 0.5,
      };
    case "HEART": {
      // Heartbeat pulse: quick double-thump
      const beat = Math.abs(Math.sin(t * 2.2));
      return {
        scaleX: 1 + beat * 0.18,
        scaleY: 1 + beat * 0.18,
      };
    }
    case "EYE": {
      // Slow rotate with an occasional fast "blink" (vertical squash)
      const blink = Math.sin(t * 0.8) > 0.96 ? 0.15 : 1;
      return {
        rotation: t * 0.3,
        scaleY: blink,
      };
    }
    case "NOTE":
      // Papery sway
      return {
        rotation: Math.sin(t * 0.9) * 0.12,
        offsetY: Math.sin(t * 1.1) * 2,
      };
    default:
      return {};
  }
}

function getEnemyAnimOpts(enemy) {
  // Wounded and dead hunters hold still — no twitching
  if (enemy.state === "DEAD" || enemy.stunTimer > 0) return {};
  const t = animTime * 6 + enemy.jitterSeed;
  const isChasing = enemy.state === "CHASE";
  // Twitchy, unnatural micro-movement — worse while actively hunting
  const jitterAmount = isChasing ? 2.2 : 0.8;
  const stretch = isChasing ? Math.abs(Math.sin(t * 1.5)) * 0.15 : 0;
  return {
    offsetX: Math.sin(t) * jitterAmount,
    offsetY: Math.cos(t * 1.3) * jitterAmount,
    scaleX: 1 - stretch,
    scaleY: 1 + stretch,
    rotation: isChasing ? Math.sin(t * 3) * 0.1 : 0,
  };
}

function getPlayerAnimOpts() {
  const t = animTime;
  if (player.isMoving) {
    // Walk-cycle bob + slight lean
    return {
      offsetY: Math.abs(Math.sin(t * 10)) * -3,
      rotation: Math.sin(t * 10) * 0.05,
      flipX: player.facingLeft,
    };
  }
  // Idle "breathing"
  return {
    scaleY: 1 + Math.sin(t * 2) * 0.02,
    flipX: player.facingLeft,
  };
}

/**
 * Draws an Echo Stone: a small standing slab with three glowing runes
 * (top = HIGH, middle = MID, bottom = LOW). Turns green once solved.
 */
function drawEchoStone(puz, alpha) {
  const glow = 0.55 + Math.sin(animTime * 3 + puz.x) * 0.35;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = puz.solved
    ? "rgba(70, 120, 85, 0.95)"
    : "rgba(55, 70, 100, 0.95)";
  ctx.strokeStyle = "rgba(200, 220, 255, 0.85)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(puz.x - 13, puz.y - 16, 26, 32, 6);
  else ctx.rect(puz.x - 13, puz.y - 16, 26, 32);
  ctx.fill();
  ctx.stroke();

  [-9, 0, 9].forEach((dy) => {
    ctx.beginPath();
    ctx.arc(puz.x, puz.y + dy, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = puz.solved
      ? "rgba(140, 255, 170, 0.9)"
      : `rgba(120, 210, 255, ${glow})`;
    ctx.shadowColor = puz.solved ? "#8fa" : "#6cf";
    ctx.shadowBlur = puz.solved ? 4 : 10 * glow;
    ctx.fill();
  });
  ctx.restore();
}

/** The Memory Shrine: a small violet diamond that pulses softly. Dull grey once used. */
function drawMemoryShrine(puz, alpha) {
  const glow = 0.5 + Math.sin(animTime * 2.5 + puz.y) * 0.3;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(puz.x, puz.y);
  ctx.beginPath();
  ctx.moveTo(0, -15);
  ctx.lineTo(11, 0);
  ctx.lineTo(0, 15);
  ctx.lineTo(-11, 0);
  ctx.closePath();
  ctx.fillStyle = puz.solved ? "rgba(60, 60, 70, 0.9)" : "rgba(90, 50, 140, 0.95)";
  ctx.strokeStyle = puz.solved
    ? "rgba(120, 120, 130, 0.6)"
    : "rgba(200, 160, 255, 0.9)";
  ctx.lineWidth = 2;
  ctx.shadowColor = "#b8f";
  ctx.shadowBlur = puz.solved ? 0 : 12 * glow;
  ctx.fill();
  ctx.stroke();
  if (!puz.solved) {
    ctx.beginPath();
    ctx.arc(0, 0, 3, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(230, 200, 255, ${glow})`;
    ctx.fill();
  }
  ctx.restore();
}

/** Exit gate — gentle glow pulse when unlocked, nervous rattle when locked. */
function drawExitGate(alpha) {
  const gateT = animTime * 4;
  const gateAnim = exitGate.unlocked
    ? {
        scaleX: 1 + Math.sin(gateT) * 0.05,
        scaleY: 1 + Math.sin(gateT) * 0.05,
      }
    : { offsetX: Math.sin(gateT * 3) * 1.2 };
  if (
    drawSprite(
      exitGate.unlocked ? "DOOR_UNLOCKED" : "DOOR_LOCKED",
      exitGate.x,
      exitGate.y,
      44,
      alpha,
      gateAnim,
    )
  ) {
    return;
  }
  ctx.fillStyle = exitGate.unlocked
    ? `rgba(50, 255, 50, ${alpha})`
    : `rgba(255, 50, 50, ${alpha})`;
  ctx.fillRect(
    exitGate.x - 20 + (gateAnim.offsetX || 0),
    exitGate.y - 20,
    40,
    40,
  );
}

/** Strokes every maze wall in the cells around (cx,cy) using the current stroke style. */
function drawMazeWallsNear(cx, cy, radius) {
  const minC = Math.max(0, Math.floor((cx - radius) / CELL_SIZE));
  const maxC = Math.min(mazeCols - 1, Math.floor((cx + radius) / CELL_SIZE));
  const minR = Math.max(0, Math.floor((cy - radius) / CELL_SIZE));
  const maxR = Math.min(mazeRows - 1, Math.floor((cy + radius) / CELL_SIZE));
  ctx.beginPath();
  for (let r = minR; r <= maxR; r++) {
    for (let c = minC; c <= maxC; c++) {
      const cell = mazeGrid[r][c];
      const x = c * CELL_SIZE;
      const y = r * CELL_SIZE;
      if (cell.walls[0]) {
        ctx.moveTo(x, y);
        ctx.lineTo(x + CELL_SIZE, y);
      }
      if (cell.walls[1]) {
        ctx.moveTo(x + CELL_SIZE, y);
        ctx.lineTo(x + CELL_SIZE, y + CELL_SIZE);
      }
      if (cell.walls[2]) {
        ctx.moveTo(x + CELL_SIZE, y + CELL_SIZE);
        ctx.lineTo(x, y + CELL_SIZE);
      }
      if (cell.walls[3]) {
        ctx.moveTo(x, y + CELL_SIZE);
        ctx.lineTo(x, y);
      }
    }
  }
  ctx.stroke();
}

/** The violet trail a Memory Shrine burns into the floor, leading to the exit. */
function renderMemoryRoute() {
  if (!memoryRoute) return;
  const fade = Math.min(1, memoryRoute.timer / 3); // fades during the last 3 seconds
  ctx.save();
  ctx.strokeStyle = `rgba(190, 140, 255, ${0.75 * fade})`;
  ctx.lineWidth = 4;
  ctx.setLineDash([10, 8]);
  ctx.lineDashOffset = -animTime * 30;
  ctx.shadowColor = "#b8f";
  ctx.shadowBlur = 10;
  ctx.beginPath();
  memoryRoute.cells.forEach((cell, i) => {
    const c = cellCenter(cell.r, cell.c);
    if (i === 0) ctx.moveTo(c.x, c.y);
    else ctx.lineTo(c.x, c.y);
  });
  ctx.stroke();
  ctx.restore();
}

/**
 * Placed candles: a warm circle of light that shows nearby walls and reveals
 * any hunter standing inside it, plus the flame itself.
 */
function renderCandles() {
  placedCandles.forEach((candle) => {
    const life = Math.min(1, candle.timer / 3); // gutters out over the last 3 seconds
    const flicker =
      0.85 + Math.sin(animTime * 17 + candle.x) * 0.08 + (Math.random() - 0.5) * 0.06;
    const R = CANDLE_LIGHT_RADIUS * flicker * (0.5 + 0.5 * life);

    ctx.save();
    ctx.beginPath();
    ctx.arc(candle.x, candle.y, R, 0, Math.PI * 2);
    ctx.clip();

    ctx.strokeStyle = `rgba(255, 190, 110, ${0.55 * life})`;
    ctx.lineWidth = 2.5;
    drawMazeWallsNear(candle.x, candle.y, R);

    // Hunters standing in the firelight are fully visible
    enemies.forEach((enemy) => {
      if (Math.hypot(enemy.x - candle.x, enemy.y - candle.y) > R) return;
      const anim = getEnemyAnimOpts(enemy);
      if (!drawEnemySprite(enemy, enemy.x, enemy.y, 42, life, anim)) {
        drawSprite("ENEMY", enemy.x, enemy.y, 30, life, anim);
      }
    });

    const g = ctx.createRadialGradient(candle.x, candle.y, 0, candle.x, candle.y, R);
    g.addColorStop(0, `rgba(255, 170, 70, ${0.32 * life})`);
    g.addColorStop(1, "rgba(255, 170, 70, 0)");
    ctx.fillStyle = g;
    ctx.fillRect(candle.x - R, candle.y - R, R * 2, R * 2);
    ctx.restore();

    // The flame itself
    const opts = getItemAnimOpts({ type: "CANDLE", x: candle.x, y: candle.y });
    if (!drawSprite("CANDLE", candle.x, candle.y, 20, life, opts)) {
      ctx.beginPath();
      ctx.arc(candle.x, candle.y, 6, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255, 160, 40, ${life})`;
      ctx.fill();
    }
  });
}

/** Progress ring + countdown drawn around the gate while it unseals. */
function renderGateUnseal() {
  if (!isFinalEscapeActive) return;
  const p = Math.min(1, gateUnseal.progress / UNSEAL_TIME);
  drawExitGate(0.9); // the gate glows through the dark while it opens
  ctx.save();
  ctx.lineWidth = 5;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.15)";
  ctx.beginPath();
  ctx.arc(exitGate.x, exitGate.y, 34, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = `rgba(255, ${140 + Math.floor(p * 100)}, 60, 0.95)`;
  ctx.beginPath();
  ctx.arc(exitGate.x, exitGate.y, 34, -Math.PI / 2, -Math.PI / 2 + p * Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = "#fff";
  ctx.font = "bold 14px 'Courier New', monospace";
  ctx.textAlign = "center";
  ctx.fillText(Math.ceil(UNSEAL_TIME - gateUnseal.progress), exitGate.x, exitGate.y - 44);
  ctx.restore();
}

/**
 * Accessibility: small arrows orbiting the player that point toward nearby
 * hunters (red) and unsolved Echo Stones (blue), brighter the closer they are.
 * It's the visual twin of "listening" for footsteps and humming.
 */
function drawSoundIndicators() {
  const arrow = (tx, ty, range, color) => {
    const d = Math.hypot(tx - player.x, ty - player.y);
    if (d > range || d < 30) return;
    const a = Math.atan2(ty - player.y, tx - player.x);
    const closeness = 1 - d / range;
    ctx.save();
    ctx.translate(player.x + Math.cos(a) * 46, player.y + Math.sin(a) * 46);
    ctx.rotate(a);
    ctx.globalAlpha = 0.25 + closeness * 0.7;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(9, 0);
    ctx.lineTo(-5, -6);
    ctx.lineTo(-5, 6);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  };
  enemies.forEach((e) => {
    if (e.state !== "DEAD") arrow(e.x, e.y, 380, "#f44");
  });
  puzzles.forEach((p) => {
    if (p.type === "SOUND_PATTERN" && !p.solved) arrow(p.x, p.y, 300, "#6cf");
  });
}

/** Dark scrim + text drawn over the frozen game while paused. */
function drawPauseScreen() {
  const cx = viewW / 2;
  const cy = viewH / 2;
  ctx.fillStyle = "rgba(0, 0, 0, 0.72)";
  ctx.fillRect(0, 0, viewW, viewH);
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "bold 52px 'Courier New', monospace";
  ctx.shadowColor = "rgba(255, 30, 30, 0.7)";
  ctx.shadowBlur = 20;
  ctx.fillStyle = "#ddd";
  ctx.fillText("PAUSED", cx, cy - 20);
  ctx.shadowBlur = 0;
  ctx.font = "16px 'Courier New', monospace";
  ctx.fillStyle = "rgba(220, 220, 220, 0.8)";
  ctx.fillText(
    `Press ${keyLabel(bindings.pause)} / Esc or click to resume`,
    cx,
    cy + 30,
  );
  ctx.restore();
}

function render() {
  // 1. Fill canvas with pitch black (Blackout State)
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, viewW, viewH);

  if (gameState === "MENU") {
    drawMenuScreen();
    return;
  }

  if (gameState !== "PLAYING" && gameState !== "GAMEOVER") return;

  // Camera Centering Setup
  ctx.save();
  let camX = viewW / 2 - player.x;
  let camY = viewH / 2 - player.y;
  ctx.translate(camX, camY);

  // 2. Ambient Flashlight — a small, dim, ALWAYS-ON visibility radius around
  //    the player. This is passive light, not sound: it does not alert
  //    enemies. It only shows walls/items faintly nearby so the player isn't
  //    staring at total black between pulses. Enemies stay hidden here —
  //    the big, bright, enemy-revealing view still only comes from a sound
  //    pulse, so the sound-vs-silence tension is preserved.
  const flashR = currentDifficulty.flashlightRadius;
  if (flashR > 0) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(player.x, player.y, flashR, 0, Math.PI * 2);
    ctx.clip();

    ctx.strokeStyle = "rgba(130, 140, 120, 0.38)";
    ctx.lineWidth = 2;
    for (let r = 0; r < mazeRows; r++) {
      for (let c = 0; c < mazeCols; c++) {
        let cell = mazeGrid[r][c];
        let x = c * CELL_SIZE;
        let y = r * CELL_SIZE;
        ctx.beginPath();
        if (cell.walls[0]) {
          ctx.moveTo(x, y);
          ctx.lineTo(x + CELL_SIZE, y);
        }
        if (cell.walls[1]) {
          ctx.moveTo(x + CELL_SIZE, y);
          ctx.lineTo(x + CELL_SIZE, y + CELL_SIZE);
        }
        if (cell.walls[2]) {
          ctx.moveTo(x + CELL_SIZE, y + CELL_SIZE);
          ctx.lineTo(x, y + CELL_SIZE);
        }
        if (cell.walls[3]) {
          ctx.moveTo(x, y + CELL_SIZE);
          ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
    }

    // Item glow within flashlight range — brighter and more readable than
    // the dim ambient wall lines, since these are what the player is
    // actually hunting for between pulses.
    items.forEach((item) => {
      // Soft bloom behind the item so it pops out of the gloom
      ctx.beginPath();
      ctx.arc(item.x, item.y, item.radius * 2.2, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255, 235, 180, 0.18)";
      ctx.fill();

      if (
        drawSprite(item.type, item.x, item.y, 22, 0.85, getItemAnimOpts(item))
      )
        return;
      ctx.beginPath();
      ctx.arc(item.x, item.y, item.radius, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(210, 195, 150, 0.65)";
      ctx.fill();
    });

    // Echo Stones are faintly visible when you're right next to them
    puzzles.forEach((puz) => {
      if (puz.type === "SOUND_PATTERN") drawEchoStone(puz, 0.6);
      else drawMemoryShrine(puz, 0.6);
    });
    drawExitGate(0.7);

    // Enemies caught in the ambient flashlight don't get fully revealed —
    // only their glowing red eyes show, hovering in the dark. Full-body
    // reveal is reserved for active sound pulses so the sound-vs-silence
    // tension stays intact even when an enemy is right on top of you.
    enemies.forEach((enemy) => {
      const dist = Math.hypot(player.x - enemy.x, player.y - enemy.y);
      if (dist > flashR || enemy.state === "DEAD") return;

      const anim = getEnemyAnimOpts(enemy);
      const ex = enemy.x + (anim.offsetX || 0);
      const ey = enemy.y + (anim.offsetY || 0);
      const eyeSpacing = 5;
      const eyeGlowT = 0.6 + Math.sin(animTime * 8 + enemy.jitterSeed) * 0.4; // subtle flicker

      [-1, 1].forEach((side) => {
        const eyeX = ex + side * eyeSpacing;
        const eyeY = ey - 2;

        // Outer glow
        ctx.beginPath();
        ctx.arc(eyeX, eyeY, 5, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 0, 0, ${0.25 * eyeGlowT})`;
        ctx.fill();

        // Core eye dot
        ctx.beginPath();
        ctx.arc(eyeX, eyeY, 1.8, 0, Math.PI * 2);
        ctx.fillStyle = "#ff0000";
        ctx.fill();
      });
    });

    glassTiles.forEach((glass) => {
      if (glass.broken) return;
      if (Math.hypot(player.x - glass.x, player.y - glass.y) > flashR) return;
      drawGlassShards(glass.x, glass.y, 0.35);
    });

    // Soft warm radial falloff so it reads as a flashlight, not a hard-edged circle
    let glow = ctx.createRadialGradient(
      player.x,
      player.y,
      0,
      player.x,
      player.y,
      flashR,
    );
    glow.addColorStop(0, "rgba(255, 235, 190, 0.12)");
    glow.addColorStop(0.7, "rgba(255, 235, 190, 0.05)");
    glow.addColorStop(1, "rgba(255, 235, 190, 0)");
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(player.x, player.y, flashR, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  // 3. Render Maze & Objects INSIDE Active Sound Pulses (Sound reveals sight)
  if (soundPulses.length > 0) {
    soundPulses.forEach((pulse) => {
      ctx.save();

      // Create circular clipping mask for echo pulse
      ctx.beginPath();
      ctx.arc(pulse.x, pulse.y, Math.max(0, pulse.radius), 0, Math.PI * 2);
      ctx.clip();

      // Draw Maze Walls within sound pulse
      ctx.strokeStyle = `rgba(180, 200, 220, ${pulse.alpha})`;
      ctx.lineWidth = 3;

      glassTiles.forEach((glass) => {
        if (glass.broken) return;
        drawGlassShards(glass.x, glass.y, pulse.alpha);
      });

      for (let r = 0; r < mazeRows; r++) {
        for (let c = 0; c < mazeCols; c++) {
          let cell = mazeGrid[r][c];
          let x = c * CELL_SIZE;
          let y = r * CELL_SIZE;

          ctx.beginPath();
          if (cell.walls[0]) {
            ctx.moveTo(x, y);
            ctx.lineTo(x + CELL_SIZE, y);
          }
          if (cell.walls[1]) {
            ctx.moveTo(x + CELL_SIZE, y);
            ctx.lineTo(x + CELL_SIZE, y + CELL_SIZE);
          }
          if (cell.walls[2]) {
            ctx.moveTo(x + CELL_SIZE, y + CELL_SIZE);
            ctx.lineTo(x, y + CELL_SIZE);
          }
          if (cell.walls[3]) {
            ctx.moveTo(x, y + CELL_SIZE);
            ctx.lineTo(x, y);
          }
          ctx.stroke();
        }
      }

      drawExitGate(pulse.alpha);

      // Draw Collectible Items
      items.forEach((item) => {
        const anim = getItemAnimOpts(item);
        if (drawSprite(item.type, item.x, item.y, 28, pulse.alpha, anim))
          return;
        const wobbleR = item.radius * (anim.scaleX || 1);
        ctx.beginPath();
        ctx.arc(item.x, item.y + (anim.offsetY || 0), wobbleR, 0, Math.PI * 2);
        if (item.type === "KEY")
          ctx.fillStyle = `rgba(240, 200, 80, ${pulse.alpha})`;
        else if (item.type === "CANDLE")
          ctx.fillStyle = `rgba(255, 140, 0, ${pulse.alpha})`;
        else if (item.type === "HEART")
          ctx.fillStyle = `rgba(220, 40, 40, ${pulse.alpha})`;
        else if (item.type === "EYE")
          ctx.fillStyle = `rgba(140, 80, 240, ${pulse.alpha})`;
        else if (item.type === "NOTE")
          ctx.fillStyle = `rgba(220, 220, 200, ${pulse.alpha})`;
        else if (item.type === "FAKE_KEY")
          ctx.fillStyle = `rgba(240, 200, 80, ${pulse.alpha})`; // Identical to real key!
        ctx.fill();
      });

      // Draw Puzzles
      puzzles.forEach((puz) => {
        if (puz.type === "SOUND_PATTERN") {
          drawEchoStone(puz, pulse.alpha);
          return;
        }
        drawMemoryShrine(puz, pulse.alpha);
      });

      // Draw Enemies (Revealed by echo pulse)
      enemies.forEach((enemy) => {
        // Enemies still inside the player's own ambient flashlight radius
        // are already being shown (eyes-only) by the flashlight pass above
        // this frame. Skip the full-body reveal for them here so the two
        // effects never visually overlap — full-body reveal is reserved for
        // enemies a pulse catches OUTSIDE the flashlight's small radius.
        const distFromPlayer = Math.hypot(
          player.x - enemy.x,
          player.y - enemy.y,
        );
        if (distFromPlayer <= currentDifficulty.flashlightRadius) return;

        const anim = getEnemyAnimOpts(enemy);
        const ex = enemy.x + (anim.offsetX || 0);
        const ey = enemy.y + (anim.offsetY || 0);
        if (
          drawEnemySprite(enemy, enemy.x, enemy.y, 42, pulse.alpha, anim) ||
          drawSprite("ENEMY", enemy.x, enemy.y, 30, pulse.alpha, anim)
        )
          return;
        ctx.beginPath();
        ctx.arc(ex, ey, 14 * (anim.scaleX || 1), 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 0, 0, ${pulse.alpha})`;
        ctx.fill();
        // Red glowing eye dot
        ctx.fillStyle = "#fff";
        ctx.fillRect(ex - 2, ey - 2, 4, 4);
      });

      // Wavefront Edge Ring
      ctx.beginPath();
      ctx.arc(pulse.x, pulse.y, Math.max(0, pulse.radius), 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255, 255, 255, ${pulse.alpha * 0.8})`;
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.restore();
    });
  }

  // Memory Shrine route, candle flames, and the unsealing-gate ring
  renderMemoryRoute();
  renderCandles();
  renderGateUnseal();

  // Lingering dust motes kicked up by sound-pulse wavefronts hitting walls
  renderDustParticles();

  // 4. Render Player Position (Always faint outline or glowing during pulse)
  const playerAnim = getPlayerAnimOpts();
  const playerDrawn =
    drawPlayerSprite(player.x, player.y, 34) ||
    drawSprite("PLAYER", player.x, player.y, 30, 1.0, playerAnim);
  if (!playerDrawn) {
    ctx.beginPath();
    ctx.arc(
      player.x,
      player.y + (playerAnim.offsetY || 0),
      player.radius * (playerAnim.scaleY || 1),
      0,
      Math.PI * 2,
    );
    if (player.invulnerable) {
      ctx.fillStyle = "#f33";
    } else {
      ctx.fillStyle = "#eee";
    }
    ctx.fill();
  } else if (player.invulnerable) {
    ctx.beginPath();
    ctx.arc(player.x, player.y, player.radius + 4, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255, 51, 51, 0.8)";
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  if (visualCues) drawSoundIndicators();

  // Interaction prompt near the gate / puzzles
  const nearExit = Math.hypot(player.x - exitGate.x, player.y - exitGate.y) < 40;
  const nearPuzzleObj = puzzles.find(
    (p) => Math.hypot(player.x - p.x, player.y - p.y) < 35 && !p.solved,
  );
  let label = null;
  if (gameState === "PLAYING" && !isSolvingPuzzle && !isPaused) {
    if (nearExit) {
      if (isFinalEscapeActive) label = "Hold the gate — it is unsealing!";
      else if (inventory.keys >= keysRequired) label = `${pressPhrase("interact", "USE")} to break the seal`;
      else label = `${pressPhrase("interact", "USE")} to inspect the gate`;
    } else if (nearPuzzleObj) {
      label =
        nearPuzzleObj.type === "SOUND_PATTERN"
          ? `${pressPhrase("interact", "USE")} to touch the Echo Stone`
          : `${pressPhrase("interact", "USE")} to touch the Memory Shrine`;
    }
  }
  const promptEl = document.getElementById("interact-prompt");
  if (label) {
    if (promptEl.innerText !== label) promptEl.innerText = label;
    promptEl.classList.remove("hidden");
  } else {
    promptEl.classList.add("hidden");
  }

  ctx.restore();

  // 5. Game-Over overlay — drawn on top of the (now-frozen) maze scene
  if (gameState === "GAMEOVER") {
    drawGameOverScreen();
  }

  // 6. Pause overlay (frozen scene stays visible underneath)
  if (isPaused) drawPauseScreen();
}

/**
 * ============================================================================
 * TITLE MENU & GAME-OVER SCREENS (canvas-drawn)
 * ============================================================================
 * Both screens are deliberately minimalist: pitch black, a single glowing
 * headline, and a slow pulsing prompt. No DOM, no CSS transitions — it's
 * all drawn every frame straight from gameState, same as the rest of the
 * game's visuals.
 */

/** Draws the pre-game title screen shown while gameState === "MENU". */
function drawMenuScreen() {
  const cx = viewW / 2;
  const cy = viewH / 2;

  // Slow-breathing vignette so total black doesn't feel like a frozen page
  const vignette = ctx.createRadialGradient(
    cx,
    cy,
    0,
    cx,
    cy,
    Math.max(viewW, viewH) * 0.7,
  );
  const breathe = 0.5 + Math.sin(animTime * 0.6) * 0.5; // 0 -> 1
  vignette.addColorStop(0, `rgba(40, 10, 10, ${0.15 + breathe * 0.1})`);
  vignette.addColorStop(1, "rgba(0, 0, 0, 1)");
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, viewW, viewH);

  // Title — subtle pulsing red glow, matches the game's horror styling
  const titlePulse = 0.7 + Math.sin(animTime * 1.5) * 0.3;
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "bold 64px 'Courier New', monospace";
  ctx.shadowColor = `rgba(255, 30, 30, ${titlePulse})`;
  ctx.shadowBlur = 25 + titlePulse * 15;
  ctx.fillStyle = "#c33";
  ctx.fillText("ECHOHORROR", cx, cy - 40);
  ctx.restore();

  // Subtitle
  ctx.save();
  ctx.textAlign = "center";
  ctx.font = "16px 'Courier New', monospace";
  ctx.fillStyle = "rgba(180, 180, 180, 0.6)";
  ctx.letterSpacing = "4px";
  ctx.fillText("THE ECHO MAZE", cx, cy + 4);
  ctx.restore();

  // Pulsing entry prompt
  const promptAlpha = 0.35 + Math.abs(Math.sin(animTime * 2.2)) * 0.65;
  ctx.save();
  ctx.textAlign = "center";
  ctx.font = "18px 'Courier New', monospace";
  ctx.fillStyle = `rgba(230, 230, 230, ${promptAlpha})`;
  ctx.fillText("PRESS SPACE OR CLICK TO LISTEN & ENTER", cx, cy + 70);
  ctx.restore();

  // Saved progress
  ctx.save();
  ctx.textAlign = "center";
  ctx.font = "14px 'Courier New', monospace";
  if (hasSave()) {
    ctx.fillStyle = "rgba(210, 180, 130, 0.85)";
    ctx.fillText(
      `PRESS C TO CONTINUE — LEVEL ${store.save.level}, ${store.save.difficulty}`,
      cx,
      cy + 105,
    );
  }
  if (store.bestLevel) {
    ctx.fillStyle = "rgba(150, 150, 150, 0.7)";
    ctx.fillText(
      `DEEPEST LEVEL REACHED: ${store.bestLevel} / ${MAX_LEVELS}`,
      cx,
      cy + 130,
    );
  }
  ctx.restore();
}

/** Draws the death screen shown while gameState === "GAMEOVER". */
function drawGameOverScreen() {
  const cx = viewW / 2;
  const cy = viewH / 2;

  // Dark, slightly red-tinted scrim over the frozen maze behind it
  ctx.fillStyle = "rgba(10, 0, 0, 0.75)";
  ctx.fillRect(0, 0, viewW, viewH);

  const titlePulse = 0.7 + Math.sin(animTime * 1.2) * 0.3;
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "bold 60px 'Courier New', monospace";
  ctx.shadowColor = `rgba(255, 0, 0, ${titlePulse})`;
  ctx.shadowBlur = 30;
  ctx.fillStyle = "#f22";
  ctx.fillText("YOU DIED", cx, cy - 20);
  ctx.restore();

  const promptAlpha = 0.35 + Math.abs(Math.sin(animTime * 2.2)) * 0.65;
  ctx.save();
  ctx.textAlign = "center";
  ctx.font = "18px 'Courier New', monospace";
  ctx.fillStyle = `rgba(220, 220, 220, ${promptAlpha})`;
  ctx.fillText("PRESS SPACE OR CLICK TO TRY AGAIN", cx, cy + 50);
  ctx.font = "14px 'Courier New', monospace";
  ctx.fillStyle = "rgba(190, 150, 150, 0.75)";
  ctx.fillText(
    `Level ${currentLevel} of ${MAX_LEVELS}  •  Times caught: ${runStats.deaths}`,
    cx,
    cy + 85,
  );
  ctx.restore();
}

/**
 * ============================================================================
 * UI & HUD MANAGEMENT
 * ============================================================================
 */
function updateHUD() {
  document.getElementById("hud-level").innerText =
    `${currentLevel} / ${MAX_LEVELS}`;
  document.getElementById("hud-keys").innerText =
    `${inventory.keys} / ${keysRequired}`;
  document.getElementById("cnt-key").innerText = inventory.keys;
  document.getElementById("cnt-candle").innerText = inventory.candles;
  document.getElementById("cnt-heart").innerText = inventory.hearts;
  document.getElementById("cnt-eye").innerText = inventory.eyes;

  // Touch item buttons carry the same counts and dim when there is nothing to use
  [
    ["heart", inventory.hearts],
    ["eye", inventory.eyes],
    ["candle", inventory.candles],
  ].forEach(([item, count]) => {
    const badge = document.getElementById(`touch-cnt-${item}`);
    if (badge) badge.innerText = count;
    document
      .getElementById(`touch-${item}-btn`)
      ?.classList.toggle("empty", count <= 0);
  });

  // Highlight slots
  document
    .getElementById("slot-candle")
    .classList.toggle("active", inventory.candles > 0);
  document
    .getElementById("slot-heart")
    .classList.toggle("active", inventory.hearts > 0);
  document
    .getElementById("slot-eye")
    .classList.toggle("active", inventory.eyes > 0);

  updateEnergyBar();
}

/** Refreshes every on-screen key hint so it matches the player's current bindings. */
function updateControlsHint() {
  const k = (action) => keyLabel(bindings[action]);
  const el = document.getElementById("controls-hint");
  if (el) {
    el.innerHTML =
      `[WASD] Move &bull; [${k("pulse")}] Echo &bull; ` +
      `[${k("heart")}/${k("eye")}] Heart/Eye &bull; [${k("candle")}] Candle &bull; ` +
      `[${k("interact")}] Interact &bull; [${k("pause")}] Pause`;
  }
  const energyTitle = document.getElementById("energy-title");
  if (energyTitle) {
    energyTitle.innerText = isTouchDevice()
      ? "Echo energy"
      : `Sound Energy [${k("pulse")}]`;
  }
  document
    .getElementById("slot-candle")
    ?.setAttribute("title", `Press ${k("candle")} to place`);
  document
    .getElementById("slot-heart")
    ?.setAttribute("title", `Press ${k("heart")} to use`);
  document
    .getElementById("slot-eye")
    ?.setAttribute("title", `Press ${k("eye")} to use`);
}

function updateEnergyBar() {
  const fill = document.getElementById("energy-fill");
  if (!fill) return;
  const pct = Math.max(
    0,
    Math.min(100, (player.energy / player.energyMax) * 100),
  );
  fill.style.width = pct + "%";
  if (pct < 25) {
    fill.style.background = "linear-gradient(90deg, #a33, #d55)";
  } else if (pct < 60) {
    fill.style.background = "linear-gradient(90deg, #aa3, #dd5)";
  } else {
    fill.style.background = "linear-gradient(90deg, #2a6, #4d8)";
  }
}

/**
 * Small on-screen messages. A "toast" is a short status line (key found, gate
 * sealed...). A "hint" is a toast that only ever shows once, ever, so new
 * players get taught the rules without veterans being nagged.
 */
let _toastTimer = null;
function showToast(text, ms = 3800) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.innerText = text;
  el.classList.remove("hidden");
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.add("hidden"), ms);
}

function hideToast() {
  clearTimeout(_toastTimer);
  document.getElementById("toast")?.classList.add("hidden");
}

function showHint(id, text) {
  const seen = store.hints || {};
  if (seen[id]) return;
  saveStore({ hints: { ...seen, [id]: 1 } });
  showToast(text, 6500);
}

function startTutorialHints() {
  showHint(
    "start",
    `${isTouchDevice() ? "Drag the left side of the screen to move." : "Move with W A S D."} ${pressPhrase("pulse", "ECHO")} to send out an echo and briefly see the maze — but noise draws hunters!`,
  );
  setTimeout(() => {
    if (gameState === "PLAYING" && !isPaused && currentLevel === 1) {
      showHint(
        "goal",
        `Find ${keysRequired} key pieces (one is locked inside a humming Echo Stone), then reach the gate in the bottom-right corner.`,
      );
    }
  }, 8000);
}

/**
 * Accessibility captions: when "Visual sound cues" is on, important sounds
 * also appear as short text near the bottom of the screen.
 */
let _captionTimer = null;
const _captionTimes = {};
function caption(text) {
  if (!visualCues) return;
  const now = performance.now();
  const last = _captionTimes[text];
  if (last !== undefined && now - last < 2500) return; // don't spam the same line
  _captionTimes[text] = now;
  const el = document.getElementById("caption");
  if (!el) return;
  el.innerText = text;
  el.classList.remove("hidden");
  clearTimeout(_captionTimer);
  _captionTimer = setTimeout(() => el.classList.add("hidden"), 2200);
}

function showNoteModal(text) {
  isReadingNote = true;
  document.getElementById("note-text").innerText = text;
  document.getElementById("note-modal").classList.remove("hidden");
}

function closeNoteModal() {
  isReadingNote = false;
  document.getElementById("note-modal").classList.add("hidden");
}

/**
 * ============================================================================
 * STORY & CUTSCENE FLOW
 * ============================================================================
 */
let storyStep = 0;

/** The ending screens re-wire the story button — put it back for a fresh run. */
function resetStoryButton() {
  const storyBtn = document.getElementById("story-btn");
  storyBtn.innerText = "Continue";
  storyBtn.onclick = advanceStory;
}

function startGame(difficultyKey) {
  audioSys.init();
  currentDifficultyKey = DIFFICULTIES[difficultyKey] ? difficultyKey : "MEDIUM";
  currentDifficulty = DIFFICULTIES[currentDifficultyKey];
  runStats = { time: 0, deaths: 0, pulses: 0 };
  document.getElementById("menu-overlay").classList.add("hidden");
  document.getElementById("hud")?.classList.remove("hidden");

  resetStoryButton();

  // Story cutscenes get their own music; the gameplay drone starts afterwards.
  audioSys.startStoryMusic("intro");

  storyStep = 0;
  showStoryOverlay();
}

/** True if there is a saved run (written automatically each time a level is cleared). */
function hasSave() {
  return !!(store.save && DIFFICULTIES[store.save.difficulty]);
}

function refreshContinueButton() {
  const btn = document.getElementById("continue-btn");
  if (!btn) return;
  btn.classList.toggle("hidden", !hasSave());
  if (hasSave()) {
    btn.innerText = `Continue: Level ${store.save.level} (${store.save.difficulty}) [C]`;
  }
}

/** Skips the story and resumes at the saved level with the saved difficulty. */
function continueGame() {
  if (!hasSave() || (gameState !== "MENU" && gameState !== "DIFFICULTY")) return;
  audioSys.init();
  const save = store.save;
  currentDifficultyKey = save.difficulty;
  currentDifficulty = DIFFICULTIES[currentDifficultyKey];
  runStats = { time: 0, deaths: 0, pulses: 0, ...(save.stats || {}) };
  document.getElementById("menu-overlay").classList.add("hidden");
  document.getElementById("hud")?.classList.remove("hidden");
  resetStoryButton();
  audioSys.startAmbient();
  gameState = "PLAYING";
  initLevel(save.level);
}

function showStoryOverlay() {
  gameState = "STORY";
  document.getElementById("story-overlay").classList.remove("hidden");

  if (storyStep === 0) {
    document.getElementById("story-title").innerText = "THE INVESTIGATION";
    document.getElementById("story-text").innerText =
      "While researching urban legends for your university thesis, you uncovered an obsolete tape recording referencing 'The Echo Ritual Site'—a subterranean labyrinth where sound was used to communicate with unseen horrors.\n\nDriven by curiosity, you tracked the coordinates deep into the woods.";
  } else if (storyStep === 1) {
    document.getElementById("story-title").innerText = "SEALED IN DARKNESS";
    document.getElementById("story-text").innerText =
      "The moment you stepped past the threshold, a heavy stone slab slammed shut behind you.\n\nPitch black. Absolute silence.\n\nYou make a soft noise—and for a fraction of a second, the sound waves bounce off stone walls, revealing the maze.\n\nYou must collect all key pieces to unseal the exit. But you are not alone.";
  }
}

function advanceStory() {
  if (storyStep === 0) {
    storyStep = 1;
    showStoryOverlay();
  } else {
    document.getElementById("story-overlay").classList.add("hidden");
    audioSys.stopStoryMusic(2.5); // fade the story music out...
    audioSys.startAmbient(); // ...while the gameplay drone fades in
    gameState = "PLAYING";
    initLevel(1);
  }
}

function completeLevel() {
  if (currentLevel < MAX_LEVELS) {
    // Autosave the moment a level is cleared so "Continue" picks up right here
    saveStore({
      save: {
        level: currentLevel + 1,
        difficulty: currentDifficultyKey,
        stats: runStats,
      },
    });
    initLevel(currentLevel + 1);
    showToast(
      `Level ${currentLevel}: you need ${keysRequired} key pieces to open the gate.`,
      4500,
    );
  } else {
    triggerEndingCutscene();
  }
}

function triggerEndingCutscene() {
  gameState = "STORY";
  saveStore({ save: null, completions: (store.completions || 0) + 1 });
  closeSoundPuzzle();
  hideToast();
  audioSys.stopAmbient();
  audioSys.startStoryMusic("ending");
  document.getElementById("story-overlay").classList.remove("hidden");
  document.getElementById("story-title").innerText = "THE ENDING TWIST";
  document.getElementById("story-text").innerText =
    "You burst through the final gate, gasping for fresh air as daylight breaks through the canopy.\n\nYou made it out. You survived the Echo Maze.\n\nThen, from the pitch blackness behind you, a voice calls out your name...\n\nIt is your own voice, pleading for help from the dark.\n\nThe maze never lets anyone leave.";

  document.getElementById("story-btn").innerText = "Continue";
  document.getElementById("story-btn").onclick = showCredits;

  // The twist lands: your own voice whispers from the dark
  setTimeout(() => {
    if (gameState === "STORY") {
      audioSys.playWhisper({ close: true, syllables: 8, volume: 1.4 });
    }
  }, 4500);
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Final screen: run statistics (with a saved best time per difficulty) and credits. */
function showCredits() {
  const bestKey = `bestTime_${currentDifficultyKey}`;
  const best = store[bestKey];
  const isBest = !best || runStats.time < best;
  if (isBest) saveStore({ [bestKey]: runStats.time });

  document.getElementById("story-title").innerText = "YOU ESCAPED... FOR NOW";
  document.getElementById("story-text").innerText =
    `Difficulty: ${currentDifficultyKey}\n` +
    `Time in the maze: ${formatTime(runStats.time)}` +
    (isBest ? "  (new best!)" : `  (best: ${formatTime(best)})`) +
    `\nTimes caught: ${runStats.deaths}\n` +
    `Echo pulses sent: ${runStats.pulses}\n\n` +
    `Thanks for playing EchoHorror.\n` +
    `Sprites: Kenney "Micro Roguelike" (CC0), plus the character and Blood Monster art packs — see README.md for credits.`;
  document.getElementById("story-btn").innerText = "Return to Menu";
  document.getElementById("story-btn").onclick = showMainMenu;
}

function triggerGameOver() {
  if (gameState === "GAMEOVER" || gameState === "JUMPSCARE") return; // don't stack deaths
  closeSoundPuzzle(); // caught while solving? close the panel
  hideToast();
  runStats.deaths++;
  gameState = "JUMPSCARE";
  audioSys.setThreat(false);
  audioSys.playScream();

  const jumpscare = document.getElementById("jumpscare");
  const jsSprite = document.getElementById("jumpscare-sprite");
  jsSprite.style.backgroundRepeat = "no-repeat";

  // Prefer the Blood Monster's attack animation, blown up huge and played
  // as a flipbook, for the jumpscare face. Falls back to the old Kenney
  // enemy tile if the new sprite hasn't loaded, then to the CSS fallback
  // face if neither is available.
  const attackEntry = enemySprites.attack1;
  if (attackEntry && attackEntry.loaded) {
    const frameCount = attackEntry.frameCount;
    jsSprite.style.backgroundImage = `url(${attackEntry.img.src})`;
    // Multi-frame background-position flipbook trick: the strip is scaled
    // so one frame exactly fills the element, then we step sideways.
    jsSprite.style.backgroundSize = `${frameCount * 100}% 100%`;
    jsSprite.classList.add("has-sprite");

    let jsFrame = 0;
    const setJsFrame = (f) => {
      jsSprite.style.backgroundPosition = `${(f / (frameCount - 1)) * 100}% 0`;
    };
    setJsFrame(0);
    const frameTimer = setInterval(() => {
      jsFrame = (jsFrame + 1) % frameCount;
      setJsFrame(jsFrame);
    }, 70);
    // Freeze on the final, widest-open frame once the hard strobe/shake
    // ends and we ease into the held red tint.
    setTimeout(() => {
      clearInterval(frameTimer);
      setJsFrame(frameCount - 1);
    }, 900);
  } else if (spritesLoaded) {
    jsSprite.style.backgroundImage = `url(${spriteSheet.src})`;
    const [tc, tr] = SPRITE_COORDS.ENEMY;
    jsSprite.style.backgroundPosition = `-${tc * SPRITE_TILE_SIZE * 40}px -${tr * SPRITE_TILE_SIZE * 40}px`;
    jsSprite.style.backgroundSize = `${SPRITE_TILE_SIZE * 40 * 16}px auto`;
    jsSprite.classList.add("has-sprite");
  }

  jumpscare.classList.remove("hidden");
  jumpscare.classList.add("jumpscare-active");
  document.body.classList.add("screen-shake");

  // Hard strobe/shake for the first burst, then ease into a held red
  // tint while the scream tail rings out, before cutting to game over.
  setTimeout(() => {
    jumpscare.classList.remove("jumpscare-active");
    jumpscare.classList.add("jumpscare-settle");
    document.body.classList.remove("screen-shake");
  }, 900);

  setTimeout(() => {
    jumpscare.classList.add("hidden");
    jumpscare.classList.remove("jumpscare-settle");
    gameState = "GAMEOVER";
    document.getElementById("hud")?.classList.add("hidden");
  }, 1900);
}

function restartLevel() {
  isPaused = false;
  gameState = "PLAYING";
  initLevel(currentLevel);
}

function showMainMenu() {
  gameState = "MENU";
  if (isPaused) setPaused(false);
  audioSys.stopAmbient();
  audioSys.stopStoryMusic(1);
  closeSoundPuzzle();
  closeNoteModal();
  hideToast();
  document.getElementById("hud")?.classList.add("hidden");
  document.getElementById("story-overlay").classList.add("hidden");
}

/** Toggle mute for both the ambient BGM and all sound effects (remembered between visits). */
function toggleMute() {
  audioSys.setMuted(!audioSys.muted);
  saveStore({ muted: audioSys.muted });
  refreshMuteButton();
}

function refreshMuteButton() {
  const btn = document.getElementById("mute-btn");
  if (btn) btn.classList.toggle("is-muted", !!audioSys.muted);
  const label = document.getElementById("mute-label");
  if (label) label.innerText = audioSys.muted ? "Muted" : "Sound on";
}

/**
 * ============================================================================
 * SETTINGS PANEL (volume sliders, visual sound cues, key rebinding)
 * ============================================================================
 * Opening it during a run pauses the game; closing it resumes.
 */
const MIX_SLIDERS = {
  "mix-music": ["music"],
  "mix-whisper": ["whisper"],
  "mix-steps": ["footstep", "enemyFootstep"],
  "mix-puzzle": ["puzzle"],
};

function openSettings() {
  if (settingsOpen || isSolvingPuzzle) return;
  settingsOpen = true;
  refreshSettingsUI();
  document.getElementById("settings-panel").classList.remove("hidden");
  if (gameState === "PLAYING" && !isPaused && !isReadingNote) {
    setPaused(true);
    pausedBySettings = true;
  }
}

function closeSettings() {
  settingsOpen = false;
  rebindingAction = null;
  document.getElementById("settings-panel").classList.add("hidden");
  if (pausedBySettings) {
    pausedBySettings = false;
    setPaused(false);
  }
}

function refreshSettingsUI() {
  Object.entries(MIX_SLIDERS).forEach(([id, [first]]) => {
    const el = document.getElementById(id);
    if (el) el.value = AUDIO_MIX[first];
  });
  const cues = document.getElementById("opt-cues");
  if (cues) cues.checked = visualCues;
  renderBindList();
}

function renderBindList() {
  const list = document.getElementById("bind-list");
  if (!list) return;
  list.innerHTML = "";
  Object.keys(ACTION_LABELS).forEach((action) => {
    const row = document.createElement("div");
    row.className = "bind-row";
    const label = document.createElement("span");
    label.textContent = ACTION_LABELS[action];
    const btn = document.createElement("button");
    btn.textContent =
      rebindingAction === action ? "press a key..." : keyLabel(bindings[action]);
    btn.addEventListener("click", () => {
      rebindingAction = action;
      renderBindList();
      btn.blur();
    });
    row.append(label, btn);
    list.appendChild(row);
  });
}

/** Called from the keydown handler while an action is waiting for its new key. */
function captureRebind(e) {
  const action = rebindingAction;
  if (e.code === "Escape") {
    rebindingAction = null;
    renderBindList();
    return;
  }
  if (RESERVED_KEYS.includes(e.code)) {
    showToast("That key is reserved for movement and menus. Pick another one.");
    return;
  }
  // If another action already uses this key, swap them so nothing is left unbound
  const other = actionForKey(e.code);
  if (other && other !== action) bindings[other] = bindings[action];
  bindings[action] = e.code;
  rebindingAction = null;
  saveStore({ bindings: { ...bindings } });
  renderBindList();
  updateControlsHint();
}

// ---- One-time wiring of every button (the HTML has no inline handlers) ----
Object.entries(MIX_SLIDERS).forEach(([id, targets]) => {
  document.getElementById(id)?.addEventListener("input", (e) => {
    targets.forEach((t) => (AUDIO_MIX[t] = Number(e.target.value)));
    saveStore({ mix: { ...AUDIO_MIX } });
    audioSys.applyMix();
  });
});
document.getElementById("opt-cues")?.addEventListener("change", (e) => {
  visualCues = e.target.checked;
  saveStore({ visualCues });
});
document.getElementById("settings-reset-keys")?.addEventListener("click", () => {
  Object.assign(bindings, DEFAULT_BINDINGS);
  saveStore({ bindings: { ...bindings } });
  renderBindList();
  updateControlsHint();
});
document.getElementById("settings-reset-hints")?.addEventListener("click", () => {
  saveStore({ hints: {} });
  showToast("Tutorial hints will show again.");
});
document.getElementById("settings-close")?.addEventListener("click", closeSettings);
document.getElementById("settings-btn")?.addEventListener("click", (e) => {
  openSettings();
  e.currentTarget.blur();
});
document.getElementById("pause-btn")?.addEventListener("click", (e) => {
  togglePause();
  e.currentTarget.blur();
});
document.getElementById("mute-btn")?.addEventListener("click", (e) => {
  toggleMute();
  e.currentTarget.blur();
});
document.getElementById("note-close")?.addEventListener("click", closeNoteModal);
document.getElementById("continue-btn")?.addEventListener("click", continueGame);
document.getElementById("menu-back")?.addEventListener("click", backToTitle);
document.querySelectorAll(".diff-btn").forEach((btn) => {
  btn.addEventListener("click", () => startGame(btn.dataset.diff));
});
document.getElementById("story-btn").onclick = advanceStory;

refreshMuteButton();
updateControlsHint();
refreshContinueButton();

// Start Game Engine Loop
requestAnimationFrame(gameLoop);
