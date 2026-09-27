// Echo renderer. UI only: no backend calls are made from this file.
// The app drives it through window.echoUI (see the bottom of this file).
const body = document.body;
const toggleBtn = document.getElementById('toggleBtn');
const collapseBtn = document.getElementById('collapseBtn');
const toggleHandlers = [];

function setListening(listening) {
  if (body.classList.contains('listening') === listening) return;
  body.classList.toggle('listening', listening);
  toggleBtn.textContent = listening ? 'STOP' : 'START';
  listening ? echoField.start() : echoField.stop();
}

toggleBtn.addEventListener('click', () => {
  const next = !body.classList.contains('listening');
  setListening(next);
  toggleHandlers.forEach((fn) => fn(next));
});

// ── Echo field ────────────────────────────────────────────────────────
// A fixed grid of tiny square dots. Sonar waves expand from the bat and
// light up a random subset of the dots they pass, so each ring reads as
// scattered sparkle rather than a solid line.
const echoField = (() => {
  const canvas = document.getElementById('echoField');
  const ctx = canvas.getContext('2d');
  const main = document.querySelector('.main');
  const bat = document.querySelector('.bat');
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const SPACING = 14;       // grid pitch, px
  const DOT = 2;            // dot size, px
  const SPEED = 120;        // wave speed, px/s
  const INTERVAL = 1.4;     // seconds between waves
  const BAND = 16;          // wave thickness, px
  const DENSITY = 0.45;     // share of dots a wave lights up

  let dots = [];
  let origin = { x: 0, y: 0 };
  let maxR = 1;
  let startedAt = 0;
  let frame = 0;
  let running = false;

  const hash = (a, b) => {
    const x = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
    return x - Math.floor(x);
  };

  function layout() {
    const dpr = window.devicePixelRatio || 1;
    const { width, height } = main.getBoundingClientRect();
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const m = main.getBoundingClientRect();
    const b = bat.getBoundingClientRect();
    origin = { x: b.left - m.left + b.width / 2, y: b.top - m.top + b.height / 2 };

    dots = [];
    const offX = origin.x % SPACING;
    const offY = origin.y % SPACING;
    for (let y = offY; y < height; y += SPACING) {
      for (let x = offX; x < width; x += SPACING) {
        dots.push({ x, y, d: Math.hypot(x - origin.x, y - origin.y), id: dots.length });
      }
    }
    maxR = Math.max(...dots.map((d) => d.d));
    if (!running) draw(reduceMotion ? 2.2 : 0);
  }

  function draw(t) {
    const { width, height } = canvas;
    ctx.clearRect(0, 0, width, height);
    const newest = Math.floor(t / INTERVAL);
    const lifetime = maxR / SPEED;

    for (const dot of dots) {
      // Faint resting grid, dimming away from the bat.
      const fade = 1 - dot.d / maxR;
      let a = 0.05 + 0.05 * fade;

      for (let w = newest; w >= 0 && (t - w * INTERVAL) < lifetime; w--) {
        const r = (t - w * INTERVAL) * SPEED;
        const off = (dot.d - r) / BAND;
        if (off > 1.5 || off < -3) continue;
        const seed = hash(dot.id, w);
        if (seed > DENSITY) continue;
        // Sharp leading edge, softer trail behind it.
        const band = off > 0 ? Math.exp(-off * off * 2) : Math.exp(off);
        const strength = (1 - r / maxR) ** 1.4;
        a += band * strength * (0.6 + 0.4 * (seed / DENSITY));
      }

      if (a < 0.02) continue;
      ctx.fillStyle = `rgba(204, 197, 185, ${Math.min(a, 0.9)})`;
      // The brightest dots render a touch larger, like a glint.
      const size = a > 0.6 ? DOT + 1 : DOT;
      ctx.fillRect(dot.x - size / 2, dot.y - size / 2, size, size);
    }
  }

  function tick(now) {
    draw((now - startedAt) / 1000);
    frame = requestAnimationFrame(tick);
  }

  new ResizeObserver(layout).observe(main);
  // The bat moves when the sidebar collapses; re-measure once it settles.
  main.parentElement.querySelector('.sidebar').addEventListener('transitionend', layout);

  return {
    start() {
      running = true;
      if (reduceMotion) return draw(2.2);
      startedAt = performance.now();
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(tick);
    },
    stop() {
      running = false;
      // Let the canvas fade out before the loop stops.
      setTimeout(() => { if (!running) cancelAnimationFrame(frame); }, 500);
    },
  };
})();

collapseBtn.addEventListener('click', () => {
  const collapsed = body.classList.toggle('collapsed');
  collapseBtn.setAttribute('aria-expanded', String(!collapsed));
  collapseBtn.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
});

// ── Navigation ───────────────────────────────────────────────────────
let sessions = [];
let currentSessionId = null;
const homeBtn = document.getElementById('homeBtn');
const activityBtn = document.getElementById('activityBtn');
const sessionList = document.getElementById('sessionList');
const sessionView = document.getElementById('view-session');
const commandBtn = document.getElementById('command');

const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
};
const svg = (markup) => {
  const t = document.createElement('template');
  t.innerHTML = markup.trim();
  return t.content.firstChild;
};
const ICONS = {
  terminal: '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="2" width="12" height="10" rx="2"/><path d="m4 5.5 2 1.5-2 1.5M7.5 9H10"/></svg>',
  failed: '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="7" cy="7" r="5.5"/><path d="m5 5 4 4M9 5 5 9"/></svg>',
};
const STATUS_LABEL = { running: 'Running', done: 'Completed', failed: 'Failed' };
const formatMs = (ms) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);

function setView(view) {
  body.dataset.view = view;
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  document.getElementById(`view-${view}`).classList.add('active');
  if (view === 'home') homeBtn.setAttribute('aria-current', 'page');
  else homeBtn.removeAttribute('aria-current');
  activityBtn.classList.toggle('has-current', view === 'session');
  if (view !== 'session') markCurrentSession(null);
}

function setActivityOpen(open) {
  activityBtn.setAttribute('aria-expanded', String(open));
}

function markCurrentSession(id) {
  currentSessionId = id;
  sessionList.querySelectorAll('.session-item').forEach((item) => {
    if (item.dataset.id === id) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  });
}

function renderSessionList() {
  sessionList.replaceChildren();
  if (!sessions.length) {
    sessionList.append(el('p', 'sessions-empty', 'No sessions yet'));
    return;
  }
  let group = null;
  for (const s of sessions) {
    if (s.group !== group) {
      group = s.group;
      sessionList.append(el('div', 'session-group', group));
    }
    const item = el('button', 'session-item');
    item.dataset.id = s.id;
    item.title = s.title;
    item.append(el('span', `dot ${s.status}`), el('span', 'session-title', s.title), el('span', 'session-age', s.age));
    item.addEventListener('click', () => openSession(s.id));
    sessionList.append(item);
  }
  markCurrentSession(currentSessionId);
}

function renderLogEntry(entry) {
  if (entry.note) return el('p', 'log-note', entry.note);
  if (entry.summary) return el('div', `log-summary${entry.failed ? ' failed' : ''}`, entry.summary);

  const wrap = el('div', `log-cmd ${entry.status}`);
  const row = el('button', 'log-cmd-row');
  if (entry.status === 'running') row.append(el('span', 'spinner'));
  else row.append(svg(entry.status === 'failed' ? ICONS.failed : ICONS.terminal));
  row.append(el('span', null, entry.status === 'running' ? 'Running' : 'Ran'), el('code', null, entry.cmd));
  if (entry.ms) row.append(el('span', 'duration', `· ${formatMs(entry.ms)}`));
  wrap.append(row);

  if (entry.output) {
    const out = el('pre', 'log-output', entry.output);
    wrap.append(out);
    row.setAttribute('aria-expanded', 'false');
    row.addEventListener('click', () => {
      const open = wrap.classList.toggle('open');
      row.setAttribute('aria-expanded', String(open));
    });
    // Failures open by default so the error is visible straight away.
    if (entry.status === 'failed') {
      wrap.classList.add('open');
      row.setAttribute('aria-expanded', 'true');
    }
  } else {
    row.disabled = true;
  }
  return wrap;
}

function renderSession(s) {
  const head = el('header', 'session-head');
  head.append(el('h2', null, s.title));
  const meta = el('div', 'session-meta');
  const pill = el('span', `pill ${s.status}`);
  pill.append(el('span', `dot ${s.status}`), document.createTextNode(STATUS_LABEL[s.status]));
  const repo = el('span');
  repo.append(el('code', null, s.repo), document.createTextNode(' on '), el('code', null, s.branch));
  meta.append(pill, repo, el('span', null, s.started), el('span', null, `Approved by ${s.approvedBy}`));
  head.append(meta);

  const log = el('div', 'log');
  s.log.forEach((entry) => log.append(renderLogEntry(entry)));

  sessionView.replaceChildren(head, log);
}

function openSession(id) {
  const s = sessions.find((x) => x.id === id);
  if (!s) return;

  renderSession(s);
  sessionView.scrollTop = 0;

  if (body.classList.contains('collapsed')) collapseBtn.click();
  setActivityOpen(true);
  setView('session');
  markCurrentSession(id);
}

homeBtn.addEventListener('click', () => setView('home'));

activityBtn.addEventListener('click', () => {
  // In the collapsed rail, expand the sidebar so the list has room.
  if (body.classList.contains('collapsed')) {
    collapseBtn.click();
    return setActivityOpen(true);
  }
  setActivityOpen(activityBtn.getAttribute('aria-expanded') !== 'true');
});

// The Home "Running" pill shows the command in progress and jumps to its session.
function renderRunningCommand() {
  const running = sessions.find((s) => s.status === 'running');
  const cmd = running?.log.find((e) => e.status === 'running');
  document.getElementById('commandText').textContent = cmd?.cmd ?? '';
  commandBtn.hidden = !cmd;
  commandBtn.dataset.sessionId = running?.id ?? '';
}
commandBtn.addEventListener('click', () => openSession(commandBtn.dataset.sessionId));

function setSessions(list) {
  sessions = Array.isArray(list) ? list : [];
  renderSessionList();
  renderRunningCommand();

  // Keep the open session live; fall back to Home if it disappeared.
  if (body.dataset.view === 'session') {
    const open = sessions.find((s) => s.id === currentSessionId);
    if (!open) return setView('home');
    const scroll = sessionView.scrollTop;
    renderSession(open);
    sessionView.scrollTop = scroll;
  }
}

// ── Public interface for the app ─────────────────────────────────────
// window.echoUI.setSessions(list)   Replace all sessions (newest first). Safe to call often.
// window.echoUI.setListening(bool)  Reflect the real listener state, e.g. after a failed connect.
// window.echoUI.onToggle(fn)        fn(listening) runs when the user presses START / STOP.
window.echoUI = {
  setSessions,
  setListening,
  onToggle: (fn) => toggleHandlers.push(fn),
};

setSessions(window.MOCK_SESSIONS ?? []);
