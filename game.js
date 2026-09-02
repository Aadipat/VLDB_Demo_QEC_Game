/* ============================================================
   QEC TILES — Stabilizer Rush
   A piano-tiles-style game where you play the decoder: watch
   markers fall onto the ancillas that fired, then click every
   data qubit you think caused it before they land.
   Pure vanilla JS, no build step, no server needed.
   ============================================================ */

// ---------------------- CONFIG: LEVELS ----------------------
// startMs is each round's starting fall duration; every level only ramps to
// 1/RAMP_TARGET of that by its last round, however many rounds that is — a
// gentle dino-style speedup, not a runaway one.
const RAMP_TARGET = 1.5; // final round is this many times faster than the first

// speedMul scales the player's chosen starting speed (the slider on the
// menu) for this level — slightly under 1 for harder levels, so the level
// order still ramps up a bit even at a fixed slider setting.
// errorMul scales the player's chosen error rate (also a slider) — a
// little bit higher for the second level in each code family, so rep5 is
// modestly noisier than rep3 and surf5 modestly noisier than surf3, no
// matter what the slider is set to.
// difficulty weights a level's best score in the GLOBAL leaderboard —
// bigger codes and the boss level count for proportionally more.
const LEVELS = [
  { id: 'rep3',  name: 'Repetition Code d=3', tag: 'Tutorial', type: 'rep', distance: 3,
    desc: '3 data qubits, 2 ancillas between them. The friendliest matching problem there is.',
    errorMul: 1.0, pDouble: 0.10, rounds: 14, speedMul: 1, difficulty: 1.0, requires: null },
  { id: 'rep5',  name: 'Repetition Code d=5', tag: 'Warm-up', type: 'rep', distance: 5,
    desc: '5 qubits in a line. More room for an error to hide between two lit ancillas.',
    errorMul: 1.1, pDouble: 0.14, rounds: 16, speedMul: 0.93, difficulty: 1.3, requires: 'rep3' },
  { id: 'surf3', name: 'Surface Code d=3', tag: '2D', type: 'surface', distance: 3,
    desc: '9 data qubits on a 3×3 grid, ancillas on every edge. Welcome to 2D matching.',
    errorMul: 1.0, pDouble: 0.18, rounds: 18, speedMul: 0.88, difficulty: 1.8, requires: 'rep5' },
  { id: 'surf5', name: 'Surface Code d=5', tag: 'BOSS', type: 'surface', distance: 5, boss: true,
    desc: '25 data qubits. Good luck beating MWPM on this one by hand.',
    errorMul: 1.1, pDouble: 0.2, rounds: 20, speedMul: 0.82, difficulty: 2.5, requires: 'surf3' },
];

const START_LIVES = 3;
const PROGRESS_KEY = 'qec_tiles_progress_v1';
const LEADERBOARD_KEY = 'qec_tiles_leaderboard_v1';
const PLAYERNAME_KEY = 'qec_tiles_playername_v1';
const TUTORIAL_SEEN_KEY = 'qec_tiles_seen_tutorial_v1';
const SPEED_KEY = 'qec_tiles_start_ms_v1';
const DEFAULT_START_MS = 2200;
const ERROR_KEY = 'qec_tiles_error_pct_v1';
const DEFAULT_ERROR_PCT = 55;

function getUserPError() {
  const v = parseInt(localStorage.getItem(ERROR_KEY), 10);
  return (Number.isFinite(v) ? v : DEFAULT_ERROR_PCT) / 100;
}

function getUserStartMs() {
  const v = parseInt(localStorage.getItem(SPEED_KEY), 10);
  return Number.isFinite(v) ? v : DEFAULT_START_MS;
}

// ---------------------- STATE ----------------------
let progress = loadProgress();
let leaderboard = loadLeaderboard();
let session = null; // active game session, built in startGame()
let tutorialTimers = [];
let returnToMenuAfterTutorial = true;

// ---------------------- STORAGE HELPERS ----------------------
function loadProgress() {
  try { return JSON.parse(localStorage.getItem(PROGRESS_KEY)) || {}; }
  catch (e) { return {}; }
}
function saveProgress() { localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress)); }

function loadLeaderboard() {
  try { return JSON.parse(localStorage.getItem(LEADERBOARD_KEY)) || {}; }
  catch (e) { return {}; }
}
function saveLeaderboard() { localStorage.setItem(LEADERBOARD_KEY, JSON.stringify(leaderboard)); }

function isUnlocked(level) {
  if (!level.requires) return true;
  return !!progress[level.requires];
}

// ---------------------- SCREEN NAV ----------------------
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

// ---------------------- MENU RENDERING ----------------------
function renderLevelGrid() {
  const grid = document.getElementById('level-grid');
  grid.innerHTML = '';
  LEVELS.forEach(level => {
    const unlocked = isUnlocked(level);
    const card = document.createElement('div');
    card.className = 'level-card' + (level.boss ? ' boss' : '') + (unlocked ? '' : ' locked');
    const nQubits = level.type === 'rep' ? level.distance : level.distance * level.distance;
    const best = getBestScore(level.id);
    card.innerHTML = `
      <div class="lvl-tag">${level.tag}</div>
      <h3>${level.name}</h3>
      <p>${level.desc}</p>
      <div class="lvl-meta"><span>${nQubits} data qubits</span><span>${level.rounds} rounds</span></div>
      ${best ? `<div class="lvl-best">Best: ${best.score} pts — ${best.survived ? 'Survived' : 'Failed'}</div>` : ''}
    `;
    if (unlocked) {
      card.addEventListener('click', () => {
        if (!requirePlayerName()) return;
        beginCountdown(level);
      });
    }
    grid.appendChild(card);
  });
}

function getBestScore(levelId) {
  const list = leaderboard[levelId];
  if (!list || !list.length) return null;
  return list.slice().sort((a, b) => b.score - a.score)[0];
}

// ---------------------- COUNTDOWN ----------------------
function beginCountdown(level) {
  showScreen('screen-countdown');
  const numEl = document.getElementById('countdown-num');
  const labelEl = document.getElementById('countdown-label');
  const labels = ['3', '2', '1', 'GO'];
  let i = 0;
  labelEl.textContent = level.boss ? 'Boss stabilizer stream incoming…' : 'Stabilizer round incoming…';
  numEl.textContent = labels[i];
  const iv = setInterval(() => {
    i++;
    if (i >= labels.length) {
      clearInterval(iv);
      startGame(level);
      return;
    }
    numEl.textContent = labels[i];
  }, 550);
}

// ---------------------- CODE GEOMETRY ----------------------
// Every qubit (data or ancilla) gets an integer (row, col) on a shared
// lattice, expanded 2x so ancillas can sit exactly between the data
// qubits they check — the same convention a real surface-code diagram
// uses. A rep code is just the 1-row special case of this.
function buildGeometry(level) {
  const dataCoords = [];
  const ancillas = []; // { row, col, qubits: [i] or [i, j] }
  let nRows, nCols, nQubits;

  if (level.type === 'rep') {
    nQubits = level.distance;
    nRows = 1;
    nCols = 2 * nQubits - 1;
    for (let i = 0; i < nQubits; i++) dataCoords.push({ row: 0, col: 2 * i });
    for (let i = 0; i < nQubits - 1; i++) {
      ancillas.push({ row: 0, col: 2 * i + 1, qubits: [i, i + 1] });
    }
  } else {
    const d = level.distance;
    nQubits = d * d;
    nRows = nCols = 2 * d - 1;
    const idx = (r, c) => r * d + c;
    for (let r = 0; r < d; r++) {
      for (let c = 0; c < d; c++) dataCoords.push({ row: 2 * r, col: 2 * c });
    }
    for (let r = 0; r < d; r++) {
      for (let c = 0; c < d; c++) {
        if (c < d - 1) ancillas.push({ row: 2 * r, col: 2 * c + 1, qubits: [idx(r, c), idx(r, c + 1)] });
        if (r < d - 1) ancillas.push({ row: 2 * r + 1, col: 2 * c, qubits: [idx(r, c), idx(r + 1, c)] });
      }
    }
  }

  const qubitAncillas = Array.from({ length: nQubits }, () => []);
  ancillas.forEach((a, aIdx) => a.qubits.forEach(q => qubitAncillas[q].push(aIdx)));

  return { nQubits, nRows, nCols, dataCoords, ancillas, qubitAncillas };
}

// ---------------------- GAME SESSION ----------------------
function startGame(level) {
  const geo = buildGeometry(level);
  const startMs = getUserStartMs() * level.speedMul;
  const minMs = startMs / RAMP_TARGET;
  const accel = Math.pow(1 / RAMP_TARGET, 1 / level.rounds);

  session = {
    level, geo,
    round: 0,
    score: 0,
    streak: 0,
    bestStreak: 0,
    correctCount: 0,
    wrongCount: 0,
    lives: START_LIVES,
    durationMs: startMs,
    baseStartMs: startMs,
    minMs, accel,
    physicalFault: new Array(geo.nQubits).fill(false),
    selectedSet: new Set(),
    currentTruth: new Set(),
    activeMarkers: [],
    resolved: true,
    ended: false,
    roundStartTime: 0,
  };

  document.getElementById('screen-game').classList.toggle('boss-mode', !!level.boss);
  document.getElementById('hud-level').textContent = level.name;
  document.getElementById('hud-score').textContent = '0';
  document.getElementById('hud-streak').textContent = '0';
  document.getElementById('hud-round').textContent = `0 / ${level.rounds}`;
  updateLivesHud();

  // The board reads wrap.clientWidth/clientHeight to size itself, so the
  // screen has to actually be visible (display != none) first — measuring
  // before this returns 0 and silently falls back to tiny minimums.
  showScreen('screen-game');
  buildBoardDom();

  nextRound();
}

// ---------------------- BOARD DOM ----------------------
function buildBoardDom() {
  const { geo } = session;
  const board = document.getElementById('board');
  const qubitLayer = document.getElementById('qubit-layer');
  qubitLayer.innerHTML = '';
  document.getElementById('tile-layer').innerHTML = '';

  const wrap = document.getElementById('board-wrap');
  const availW = Math.max(280, wrap.clientWidth - 40);
  const wrapH = Math.max(260, wrap.clientHeight - 24);
  // Boards cap at a comfortable cell size so a 1-row rep code doesn't eat
  // the whole vertical budget — the leftover becomes the markers' fall zone.
  const availH = Math.min(wrapH, 640);
  const cellSize = Math.max(34, Math.min(132, Math.floor(availW / geo.nCols), Math.floor(availH / geo.nRows)));

  session.cellSize = cellSize;
  session.dataR = cellSize * 0.36;
  session.ancR = cellSize * 0.19;

  const boardH = geo.nRows * cellSize;
  board.style.width = (geo.nCols * cellSize) + 'px';
  board.style.height = boardH + 'px';

  // The tile layer spans the whole (wider) wrap, but the board itself is
  // horizontally centered inside it — so a marker aimed at "qubit column
  // X" has to account for the board's offset within the wrap, not just
  // the qubit's position within the board, or it lands nowhere near its
  // target ancilla.
  const wrapRect = wrap.getBoundingClientRect();
  const boardRect = board.getBoundingClientRect();
  session.boardOffsetX = boardRect.left - wrapRect.left;
  session.boardOffsetY = boardRect.top - wrapRect.top;

  session.dataEls = geo.dataCoords.map((pos, i) => {
    const el = document.createElement('div');
    el.className = 'qnode data';
    const d = session.dataR * 2;
    el.style.width = d + 'px';
    el.style.height = d + 'px';
    el.style.left = (pos.col * cellSize + cellSize / 2 - session.dataR) + 'px';
    el.style.top = (pos.row * cellSize + cellSize / 2 - session.dataR) + 'px';
    el.style.fontSize = Math.max(9, cellSize * 0.19) + 'px';
    el.textContent = geo.nQubits <= 9 ? ('q' + i) : '';
    el.dataset.qubit = String(i);
    el.addEventListener('click', () => onDataClick(i));
    qubitLayer.appendChild(el);
    return el;
  });

  session.ancEls = geo.ancillas.map(pos => {
    const el = document.createElement('div');
    el.className = 'qnode anc';
    const d = session.ancR * 2;
    el.style.width = d + 'px';
    el.style.height = d + 'px';
    el.style.left = (pos.col * cellSize + cellSize / 2 - session.ancR) + 'px';
    el.style.top = (pos.row * cellSize + cellSize / 2 - session.ancR) + 'px';
    qubitLayer.appendChild(el);
    return el;
  });
}

function updateLivesHud() {
  const el = document.getElementById('hud-lives');
  el.textContent = '♥'.repeat(Math.max(session.lives, 0)) + '♡'.repeat(Math.max(START_LIVES - session.lives, 0));
}

// ---------------------- ROUND LOGIC ----------------------
function nextRound() {
  if (session.ended) return;

  if (session.round >= session.level.rounds || session.lives <= 0) {
    return endGame();
  }

  session.round++;
  document.getElementById('hud-round').textContent = `${session.round} / ${session.level.rounds}`;

  const { geo, level } = session;
  const truth = new Set();
  const pError = Math.min(0.9, getUserPError() * level.errorMul);
  if (Math.random() < pError) {
    const q1 = Math.floor(Math.random() * geo.nQubits);
    truth.add(q1);
    if (Math.random() < level.pDouble) {
      // Bias toward a neighboring qubit sometimes, so players see the
      // "shared ancilla cancels" pattern from the tutorial in real play.
      let q2;
      if (Math.random() < 0.5 && geo.qubitAncillas[q1].length) {
        const aIdx = geo.qubitAncillas[q1][Math.floor(Math.random() * geo.qubitAncillas[q1].length)];
        const others = geo.ancillas[aIdx].qubits.filter(q => q !== q1);
        q2 = others.length ? others[0] : null;
      }
      if (q2 === undefined || q2 === null) {
        do { q2 = Math.floor(Math.random() * geo.nQubits); } while (q2 === q1);
      }
      truth.add(q2);
    }
  }

  session.currentTruth = truth;
  session.selectedSet = new Set();
  session.resolved = false;
  session.roundStartTime = performance.now();
  clearSelectionVisuals();

  // The syndrome (which ancillas fired) is real measurement data — it's
  // known the instant the round starts. Only the *cause* (which data
  // qubit(s) flipped) is hidden; that's what the player has to guess.
  const firedAncillas = computeFiredAncillas(truth);
  firedAncillas.forEach(aIdx => session.ancEls[aIdx].classList.add('lit'));
  spawnMarkers(firedAncillas);

  session.durationMs = Math.max(session.minMs, session.durationMs * session.accel);
}

function computeFiredAncillas(truthSet) {
  const fired = [];
  session.geo.ancillas.forEach((a, aIdx) => {
    let count = 0;
    a.qubits.forEach(q => { if (truthSet.has(q)) count++; });
    if (count % 2 === 1) fired.push(aIdx);
  });
  return fired;
}

function spawnMarkers(firedAncillaIdxs) {
  const layer = document.getElementById('tile-layer');
  const { cellSize, ancR, boardOffsetX, boardOffsetY } = session;
  const markers = [];

  const spawnTop = -60; // just above the wrap's visible top edge (overflow:hidden clips it)

  // No fired ancillas = no error this round. Nothing falls, nothing lights
  // up — that absence is the signal. (The round's timeout below fires
  // regardless of whether anything is on screen, so timing isn't affected.)
  if (firedAncillaIdxs.length === 0) {
    // no markers
  } else {
    firedAncillaIdxs.forEach(aIdx => {
      const pos = session.geo.ancillas[aIdx];
      const targetLeft = boardOffsetX + pos.col * cellSize + cellSize / 2;
      const targetTop = boardOffsetY + pos.row * cellSize + cellSize / 2;
      const m = document.createElement('div');
      m.className = 'fall-marker';
      const d = ancR * 2.1;
      m.style.width = d + 'px';
      m.style.height = d + 'px';
      m.style.left = (targetLeft - d / 2) + 'px';
      m.style.top = spawnTop + 'px';
      layer.appendChild(m);
      void m.getBoundingClientRect();
      m.style.transitionDuration = session.durationMs + 'ms';
      m.style.top = (targetTop - d / 2) + 'px';
      markers.push(m);
    });
  }

  session.activeMarkers = markers;
  session.roundTimer = setTimeout(() => {
    if (!session.resolved) resolveRound(true);
  }, session.durationMs + 40);
}

// ---------------------- INPUT ----------------------
function onDataClick(qubitIdx) {
  if (session.resolved || session.ended) return;
  const el = session.dataEls[qubitIdx];
  el.classList.remove('smack');
  void el.offsetWidth; // restart the smack animation even on repeated clicks
  el.classList.add('smack');
  if (session.selectedSet.has(qubitIdx)) {
    session.selectedSet.delete(qubitIdx);
    el.classList.remove('selected');
  } else {
    session.selectedSet.add(qubitIdx);
    el.classList.add('selected');
  }
}

function lockIn() {
  if (!session || session.resolved || session.ended) return;
  resolveRound(false);
}

document.addEventListener('keydown', (e) => {
  if (document.getElementById('screen-tutorial').classList.contains('active')) {
    if (e.code === 'Enter' || e.code === 'Space' || e.code === 'ArrowRight') {
      e.preventDefault();
      tutorialNext();
    } else if (e.code === 'ArrowLeft') {
      e.preventDefault();
      tutorialBack();
    }
    return;
  }
  if (e.code === 'Enter' || e.code === 'Space') {
    e.preventDefault();
    lockIn();
  }
});

function clearSelectionVisuals() {
  if (!session.dataEls) return;
  session.dataEls.forEach(el => el.classList.remove('selected', 'flash-correct', 'flash-wrong', 'flash-missed'));
  if (session.ancEls) session.ancEls.forEach(el => el.classList.remove('lit'));
}

// ---------------------- RESOLUTION ----------------------
function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

function resolveRound(timedOut) {
  session.resolved = true;
  clearTimeout(session.roundTimer);

  const truth = session.currentTruth;
  const selected = session.selectedSet;
  const correct = setsEqual(truth, selected);

  // symmetric difference => net new physical faults from this round
  const symDiff = new Set();
  truth.forEach(q => { if (!selected.has(q)) symDiff.add(q); });
  selected.forEach(q => { if (!truth.has(q)) symDiff.add(q); });
  symDiff.forEach(q => { session.physicalFault[q] = !session.physicalFault[q]; });

  selected.forEach(q => {
    session.dataEls[q].classList.add(truth.has(q) ? 'flash-correct' : 'flash-wrong');
  });
  truth.forEach(q => {
    if (!selected.has(q)) session.dataEls[q].classList.add('flash-missed');
  });

  if (correct) {
    session.correctCount++;
    session.streak++;
    session.bestStreak = Math.max(session.bestStreak, session.streak);
    const speedRatio = session.baseStartMs / session.durationMs;
    const difficultyBonus = 1 + 0.2 * Math.max(0, truth.size - 1);
    const gained = Math.round((80 * speedRatio + session.streak * 8) * difficultyBonus);
    session.score += gained;
  } else {
    session.wrongCount++;
    session.streak = 0;
    session.lives--;
    updateLivesHud();
  }

  document.getElementById('hud-score').textContent = String(session.score);
  document.getElementById('hud-streak').textContent = String(session.streak);

  session.activeMarkers.forEach(el => el.classList.add('landed'));

  setTimeout(() => {
    session.activeMarkers.forEach(el => el.remove());
    session.activeMarkers = [];
    nextRound();
  }, 260);
}

// ---------------------- END OF GAME ----------------------
function endGame() {
  session.ended = true;

  const netFaults = session.physicalFault.filter(Boolean).length;
  const survived = (netFaults % 2 === 0);

  if (survived) progress[session.level.id] = true;
  saveProgress();

  const totalCalls = session.correctCount + session.wrongCount;
  const accuracy = totalCalls ? session.correctCount / totalCalls : 0;

  const playerName = localStorage.getItem(PLAYERNAME_KEY) || 'Player';
  const entry = {
    name: playerName,
    score: session.score,
    accuracy: Math.round(accuracy * 100),
    survived,
    date: new Date().toISOString(),
  };
  const list = leaderboard[session.level.id] || [];
  list.push(entry);
  list.sort((a, b) => b.score - a.score);
  leaderboard[session.level.id] = list.slice(0, 10);
  saveLeaderboard();

  renderResults(session, accuracy, survived, entry);
  showScreen('screen-results');
}

function renderResults(sess, accuracy, survived, myEntry) {
  document.getElementById('results-title').textContent = sess.level.name;
  const banner = document.getElementById('survive-banner');
  banner.textContent = survived ? 'LOGICAL QUBIT SURVIVED' : 'LOGICAL QUBIT LOST';
  banner.className = 'survive-banner ' + (survived ? 'ok' : 'fail');
  document.getElementById('survive-explain').textContent =
    'Every qubit you left mis-corrected counts once. Add them all up: an even total means the errors '
    + 'cancelled each other out and the logical value is unchanged — survived. An odd total means it flipped for good.';

  document.getElementById('stat-score').textContent = String(sess.score);
  document.getElementById('stat-acc').textContent = Math.round(accuracy * 100) + '%';
  document.getElementById('stat-best-streak').textContent = String(sess.bestStreak);
  document.getElementById('stat-rounds').textContent = `${sess.round}/${sess.level.rounds}`;

  document.getElementById('leaderboard-level-name').textContent = sess.level.name;
  const lbList = document.getElementById('leaderboard-list');
  lbList.innerHTML = '';
  (leaderboard[sess.level.id] || []).forEach(e => {
    const li = document.createElement('li');
    const isMe = e === myEntry;
    if (isMe) li.className = 'me';
    li.textContent = `${e.name} — ${e.score} pts (${e.accuracy}% acc, ${e.survived ? 'survived' : 'failed'})`;
    lbList.appendChild(li);
  });

  const nextLevel = LEVELS[LEVELS.findIndex(l => l.id === sess.level.id) + 1];
  const nextBtn = document.getElementById('btn-next-level');
  nextBtn.disabled = !survived || !nextLevel;
  nextBtn.onclick = () => {
    if (nextLevel) beginCountdown(nextLevel);
  };

  document.getElementById('btn-retry').onclick = () => beginCountdown(sess.level);
  document.getElementById('btn-to-menu').onclick = () => {
    renderLevelGrid();
    showScreen('screen-menu');
  };
}

// ---------------------- TUTORIAL ----------------------
function clearTutorialTimers() {
  tutorialTimers.forEach(t => clearTimeout(t));
  tutorialTimers = [];
}

let tutorialEls = null;
function getTutorialEls() {
  if (tutorialEls) return tutorialEls;
  tutorialEls = {
    d: [document.getElementById('demo-d0'), document.getElementById('demo-d1'), document.getElementById('demo-d2')],
    dn: [document.getElementById('demo-d0-num'), document.getElementById('demo-d1-num'), document.getElementById('demo-d2-num')],
    a: [document.getElementById('demo-a0'), document.getElementById('demo-a1')],
    an: [document.getElementById('demo-a0-num'), document.getElementById('demo-a1-num')],
    caption: document.getElementById('demo-caption'),
  };
  return tutorialEls;
}

// Every bit is 0 or 1. Each check just adds up its two neighbor data bits
// mod 2 — that's all "parity" means. hideData simulates what the real game
// actually shows you: the checks, never the data.
function setDemoBits(v0, v1, v2, hideData) {
  const els = getTutorialEls();
  const vals = [v0, v1, v2];
  els.d.forEach((el, i) => {
    el.classList.toggle('demo-hidden', !!hideData);
    el.classList.toggle('flip-demo', !!vals[i] && !hideData);
  });
  els.dn.forEach((el, i) => { el.textContent = hideData ? '?' : (vals[i] ? '1' : '0'); });
  const p = [v0 ^ v1, v1 ^ v2];
  els.a.forEach((el, i) => el.classList.toggle('lit-demo', !!p[i]));
  els.an.forEach((el, i) => { el.textContent = p[i] ? '1' : '0'; });
}

function triggerNoiseFlicker() {
  const els = getTutorialEls();
  const el = els.a[Math.floor(Math.random() * els.a.length)];
  el.classList.remove('noise-flicker');
  void el.offsetWidth;
  el.classList.add('noise-flicker');
}

// Short, one-idea-per-step captions the player advances by hand — no
// guessing at a timer that's too fast for some people and too slow for
// others.
const TUTORIAL_STEPS = [
  { caption: 'Big = DATA qubit. Small = CHECK.', apply: () => setDemoBits(0, 0, 0) },
  { caption: 'A check just adds up its two neighbor data bits.', apply: () => setDemoBits(0, 0, 0) },
  { caption: 'D1 flips to 1 → both checks touching it turn on.', apply: () => setDemoBits(0, 1, 0) },
  { caption: 'Two neighbors flip together → their shared check cancels out.', apply: () => setDemoBits(1, 1, 0) },
  { caption: 'D2 flipping ALONE lights the exact same pattern.', apply: () => setDemoBits(0, 0, 1) },
  { caption: 'One reading, two different causes — that’s the whole puzzle.', apply: () => setDemoBits(0, 0, 1) },
  { caption: 'In the real game you never see the data — only the checks.', apply: () => setDemoBits(0, 1, 0, true) },
  { caption: 'Checks aren’t perfect either — sometimes one misfires on its own.', apply: () => { setDemoBits(0, 0, 0); triggerNoiseFlicker(); } },
  { caption: 'So it’s a guessing game: watch the checks, guess the data. Ready?', apply: () => setDemoBits(0, 0, 0) },
];

let tutorialStepIndex = 0;

function renderTutorialStep() {
  clearTutorialTimers();
  const step = TUTORIAL_STEPS[tutorialStepIndex];
  step.apply();
  getTutorialEls().caption.textContent = step.caption;

  const dotsEl = document.getElementById('tutorial-dots');
  dotsEl.innerHTML = '';
  TUTORIAL_STEPS.forEach((_, i) => {
    const dot = document.createElement('span');
    dot.className = 'dot' + (i === tutorialStepIndex ? ' active' : '');
    dotsEl.appendChild(dot);
  });

  document.getElementById('btn-tutorial-back').disabled = tutorialStepIndex === 0;
  document.getElementById('btn-tutorial-next').textContent =
    tutorialStepIndex === TUTORIAL_STEPS.length - 1 ? "Let's play!" : 'Next →';
}

function tutorialNext() {
  if (tutorialStepIndex < TUTORIAL_STEPS.length - 1) {
    tutorialStepIndex++;
    renderTutorialStep();
  } else {
    finishTutorial();
  }
}

function tutorialBack() {
  if (tutorialStepIndex > 0) {
    tutorialStepIndex--;
    renderTutorialStep();
  }
}

function finishTutorial() {
  clearTutorialTimers();
  localStorage.setItem(TUTORIAL_SEEN_KEY, '1');
  renderLevelGrid();
  showScreen('screen-menu');
}

function openTutorial(returnToMenu) {
  returnToMenuAfterTutorial = returnToMenu;
  tutorialStepIndex = 0;
  showScreen('screen-tutorial');
  renderTutorialStep();
}

document.getElementById('btn-tutorial-next').addEventListener('click', tutorialNext);
document.getElementById('btn-tutorial-back').addEventListener('click', tutorialBack);
document.getElementById('btn-tutorial-skip').addEventListener('click', finishTutorial);
document.getElementById('btn-how-to-play').addEventListener('click', () => openTutorial(true));

// ---------------------- STANDALONE LEADERBOARD ----------------------
const GLOBAL_TAB_ID = 'GLOBAL';
let lbSelectedLevelId = GLOBAL_TAB_ID;

// Each player's GLOBAL score = sum over every level of (their best score on
// that level × that level's difficulty weight). Read straight off the
// existing per-level leaderboards — no separate storage needed — so a
// player only counts once per level even if they show up multiple times
// in that level's top-10 list.
function computeGlobalLeaderboard() {
  const totals = {}; // name -> { name, total, breakdown: [{levelName, score, weighted}] }
  LEVELS.forEach(level => {
    const list = leaderboard[level.id] || [];
    const bestPerPlayer = {};
    list.forEach(e => {
      if (!bestPerPlayer[e.name] || e.score > bestPerPlayer[e.name].score) bestPerPlayer[e.name] = e;
    });
    Object.values(bestPerPlayer).forEach(e => {
      if (!totals[e.name]) totals[e.name] = { name: e.name, total: 0, breakdown: [] };
      const weighted = Math.round(e.score * level.difficulty);
      totals[e.name].total += weighted;
      const shortLabel = (level.type === 'rep' ? 'Rep' : 'Surf') + ' d=' + level.distance;
      totals[e.name].breakdown.push(`${shortLabel}: ${e.score}×${level.difficulty}`);
    });
  });
  return Object.values(totals).sort((a, b) => b.total - a.total);
}

function renderLeaderboardTabs() {
  const tabs = document.getElementById('lb-tabs');
  tabs.innerHTML = '';

  const globalTab = document.createElement('button');
  globalTab.className = 'lb-tab global' + (lbSelectedLevelId === GLOBAL_TAB_ID ? ' active' : '');
  globalTab.textContent = '🌍 Global';
  globalTab.addEventListener('click', () => {
    lbSelectedLevelId = GLOBAL_TAB_ID;
    renderLeaderboardTabs();
    renderStandaloneLeaderboardList();
  });
  tabs.appendChild(globalTab);

  LEVELS.forEach(level => {
    const tab = document.createElement('button');
    tab.className = 'lb-tab' + (level.boss ? ' boss' : '') + (level.id === lbSelectedLevelId ? ' active' : '');
    tab.textContent = level.name;
    tab.addEventListener('click', () => {
      lbSelectedLevelId = level.id;
      renderLeaderboardTabs();
      renderStandaloneLeaderboardList();
    });
    tabs.appendChild(tab);
  });
}

function renderStandaloneLeaderboardList() {
  const list = document.getElementById('lb-standalone-list');
  const empty = document.getElementById('lb-empty');

  if (lbSelectedLevelId === GLOBAL_TAB_ID) {
    const rows = computeGlobalLeaderboard();
    list.innerHTML = '';
    empty.hidden = rows.length > 0;
    empty.textContent = 'No runs yet — play any level to get on the board!';
    rows.forEach(r => {
      const li = document.createElement('li');
      li.innerHTML = `<b>${r.name}</b> — ${r.total} pts <span class="lb-breakdown">(${r.breakdown.join(' · ')})</span>`;
      list.appendChild(li);
    });
    return;
  }

  const entries = leaderboard[lbSelectedLevelId] || [];
  list.innerHTML = '';
  empty.hidden = entries.length > 0;
  empty.textContent = 'No runs yet on this level — be the first!';
  entries.forEach(e => {
    const li = document.createElement('li');
    li.textContent = `${e.name} — ${e.score} pts (${e.accuracy}% acc, ${e.survived ? 'survived' : 'failed'})`;
    list.appendChild(li);
  });
}

function openLeaderboardScreen() {
  renderLeaderboardTabs();
  renderStandaloneLeaderboardList();
  showScreen('screen-leaderboard');
}

document.getElementById('btn-view-leaderboard').addEventListener('click', openLeaderboardScreen);
document.getElementById('btn-leaderboard-back').addEventListener('click', () => {
  renderLevelGrid();
  showScreen('screen-menu');
});

// ---------------------- STATIC UI WIRING ----------------------
document.getElementById('btn-lockin').addEventListener('click', lockIn);

document.getElementById('btn-clear-scores').addEventListener('click', () => {
  if (confirm('Reset all leaderboard scores and level progress?')) {
    leaderboard = {};
    progress = {};
    saveLeaderboard();
    saveProgress();
    renderLevelGrid();
  }
});

const nameInput = document.getElementById('player-name-input');
nameInput.value = localStorage.getItem(PLAYERNAME_KEY) || '';
nameInput.addEventListener('input', () => {
  localStorage.setItem(PLAYERNAME_KEY, nameInput.value.trim());
  nameInput.classList.remove('error');
});

function requirePlayerName() {
  const name = (localStorage.getItem(PLAYERNAME_KEY) || '').trim();
  if (name) return true;
  nameInput.classList.remove('error');
  void nameInput.offsetWidth;
  nameInput.classList.add('error');
  nameInput.focus();
  return false;
}

const speedSlider = document.getElementById('speed-slider');
const speedValueEl = document.getElementById('speed-value');
function formatSpeed(ms) { return (ms / 1000).toFixed(1) + 's / round'; }
speedSlider.value = String(getUserStartMs());
speedValueEl.textContent = formatSpeed(getUserStartMs());
speedSlider.addEventListener('input', () => {
  localStorage.setItem(SPEED_KEY, speedSlider.value);
  speedValueEl.textContent = formatSpeed(Number(speedSlider.value));
});

const errorSlider = document.getElementById('error-slider');
const errorValueEl = document.getElementById('error-value');
function formatErrorPct(pct) { return pct + '%'; }
errorSlider.value = String(Math.round(getUserPError() * 100));
errorValueEl.textContent = formatErrorPct(Math.round(getUserPError() * 100));
errorSlider.addEventListener('input', () => {
  localStorage.setItem(ERROR_KEY, errorSlider.value);
  errorValueEl.textContent = formatErrorPct(Number(errorSlider.value));
});

// ---------------------- INIT ----------------------
renderLevelGrid();
if (!localStorage.getItem(TUTORIAL_SEEN_KEY)) {
  openTutorial(true);
} else {
  showScreen('screen-menu');
}
