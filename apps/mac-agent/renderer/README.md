# Echo renderer (Home + Activity)

The UI for the Echo window that opens from the menu bar icon. It's UI only:
nothing here talks to the backend. `src/main.ts` loads `home.html` in a
840×560 window with `titleBarStyle: 'hiddenInset'`.

| File | What it is |
|---|---|
| `home.html` | Markup, plus the two bat drawings as an inline SVG sprite |
| `home.css` | All styles; colour and font tokens are at the top in `:root` |
| `home.js` | Behaviour, echo animation, and the `window.echoUI` interface |
| `mock-sessions.js` | Placeholder sessions for design review. **Delete when wiring real data** |
| `fonts/` | Bundled Jost + Lexend Zetta (SIL OFL 1.1), so it works offline |

The Content-Security-Policy only allows local files, and there are no inline
scripts or styles.

## Wiring it up

`home.js` exposes three functions on `window.echoUI`:

```js
echoUI.onToggle((listening) => {
  // User pressed START (true) or STOP (false). The UI has already switched.
  listening ? echoAPI.connect() : echoAPI.disconnect();
});

echoUI.setListening(false);   // push the real state back, e.g. if connect failed
echoUI.setSessions(list);     // replace every session; re-renders in place
```

Call `setSessions` whenever anything changes (a new session, a command
finishing, new output). It redraws the sidebar list, the Home "Running" pill,
and the open session without losing the user's place.

## Session shape

Newest first. Consecutive sessions with the same `group` sit under one heading.

```js
{
  id: 's1',
  group: 'Today',                 // 'Today' | 'Yesterday' | 'Last week' | …
  title: 'Sync echo/backend after PR #142',
  age: 'now',                     // short label shown in the sidebar: 'now', '2h', '1d'
  status: 'running',              // 'running' | 'done' | 'failed'
  repo: 'echo/backend',
  branch: 'main',
  started: '2:41 PM',
  approvedBy: '@janelle in #dev-sync',
  log: [
    { note: 'Plain-language line explaining what is happening.' },
    { cmd: 'git fetch origin', status: 'done', ms: 1240, output: '…' },  // output optional
    { cmd: 'git pull --rebase origin main', status: 'running' },
    { summary: 'Done in 12s. …' },                // add failed: true for the red variant
  ],
}
```

The Home "Running" pill shows the first `status: 'running'` command of the
first `status: 'running'` session, and clicking it opens that session.

## Previewing without the app

Open `home.html` in Chrome or Safari. Some embedded previews (e.g. editor
panes) show a single-file snapshot and won't load the sibling CSS/JS; serve the
folder instead: `python3 -m http.server` from `apps/mac-agent`, then open
`/renderer/home.html`.
