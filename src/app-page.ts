import { APP_COPY } from './app-copy.js';

const APP_COPY_JSON = JSON.stringify(APP_COPY).replaceAll('<', '\\u003c');

export const APP_HTML = String.raw`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <meta name="theme-color" content="#EEF3F8" />
    <title>MissionBraid · Agent Runtime Workbench</title>
    <link rel="stylesheet" href="/app.css" />
  </head>
  <body>
    <a class="skip-link" href="#mission-stage" data-i18n="nav.skipToMission">Skip to Mission details</a>
    <div class="app-shell">
      <header class="masthead">
        <div class="brand-lockup">
          <div class="brand-mark" aria-hidden="true">MB</div>
          <div>
            <p class="eyebrow" data-i18n="brand.eyebrow">Mission runtime workbench</p>
            <div class="brand-title-row">
              <h1>MissionBraid</h1>
              <div
                class="language-switch"
                role="group"
                aria-label="Language"
                data-i18n-aria-label="language.ariaLabel"
              >
                <button type="button" data-locale="en" lang="en" aria-pressed="true">EN</button>
                <button type="button" data-locale="zh-CN" lang="zh-CN" aria-pressed="false">中文</button>
              </div>
            </div>
            <p class="brand-subtitle" data-i18n="brand.subtitle">
              A Mission belongs to the Mission—not to one CLI.
            </p>
          </div>
        </div>

        <div class="braid-signature" aria-hidden="true">
          <svg viewBox="0 0 720 92" preserveAspectRatio="none" focusable="false">
            <path
              class="braid-base braid-cobalt"
              d="M0 25 C72 25 72 67 144 67 S216 25 288 25 S360 67 432 67 S504 25 576 25 S648 67 720 67"
            />
            <path
              class="braid-base braid-orange"
              d="M0 67 C72 67 72 25 144 25 S216 67 288 67 S360 25 432 25 S504 67 576 67 S648 25 720 25"
            />
            <path
              class="braid-flow braid-flow-cobalt"
              d="M0 25 C72 25 72 67 144 67 S216 25 288 25 S360 67 432 67 S504 25 576 25 S648 67 720 67"
            />
            <path
              class="braid-flow braid-flow-orange"
              d="M0 67 C72 67 72 25 144 25 S216 67 288 67 S360 25 432 25 S504 67 576 67 S648 25 720 25"
            />
          </svg>
          <span class="braid-caption" data-i18n="brand.continuity">MISSION CONTINUITY</span>
        </div>

        <div class="connection-state" aria-live="polite">
          <span class="connection-dot" aria-hidden="true"></span>
          <span id="connection-label">Connecting to the local control plane</span>
        </div>
      </header>

      <div id="page-alert" class="page-alert" role="alert" hidden></div>

      <section class="runtime-belt" aria-labelledby="runtime-heading">
        <div class="section-heading runtime-heading-row">
          <div>
            <p class="eyebrow" data-i18n="runtime.eyebrow">Runtime inventory</p>
            <h2 id="runtime-heading" data-i18n="runtime.heading">Local runtimes</h2>
          </div>
          <button id="refresh-runtimes" class="quiet-button" type="button" data-i18n="runtime.refresh">
            Refresh inventory
          </button>
        </div>
        <div id="runtime-list" class="runtime-list" aria-live="polite" aria-busy="true">
          <p class="loading-note" data-i18n="runtime.loading">
            Detecting Codex, Qoder, and other local Harnesses…
          </p>
        </div>
      </section>

      <main class="control-grid">
        <aside class="panel mission-index" aria-labelledby="mission-index-heading">
          <div class="panel-heading">
            <div>
              <p class="eyebrow" data-i18n="mission.indexEyebrow">Mission index</p>
              <h2 id="mission-index-heading" data-i18n="mission.indexHeading">Missions</h2>
            </div>
            <button
              id="refresh-missions"
              class="icon-button"
              type="button"
              aria-label="Refresh Mission list"
              data-i18n-aria-label="mission.refreshAria"
            >
              ↻
            </button>
          </div>
          <div id="mission-list" class="mission-list" aria-live="polite" aria-busy="true">
            <p class="empty-note" data-i18n="mission.loading">Loading Missions…</p>
          </div>
        </aside>

        <section id="mission-stage" class="panel mission-stage" aria-labelledby="mission-detail-heading">
          <div id="mission-detail" class="mission-detail" aria-live="polite">
            <div class="detail-empty">
              <span class="empty-knot" aria-hidden="true"></span>
              <p class="eyebrow" data-i18n="mission.noSelectionEyebrow">No Mission selected</p>
              <h2 id="mission-detail-heading" data-i18n="mission.noSelectionTitle">
                Move one task across multiple Runtimes
              </h2>
              <p data-i18n="mission.noSelectionBody">
                Select an existing Mission on the left or create one on the right. Attempts,
                Capsules, Effects, and Receipts appear here in their real order.
              </p>
            </div>
          </div>
        </section>

        <aside class="panel composer" aria-labelledby="composer-heading">
          <div class="panel-heading composer-heading">
            <div>
              <p class="eyebrow" data-i18n="composer.eyebrow">Compose</p>
              <h2 id="composer-heading" data-i18n="composer.heading">Braid a new Mission</h2>
            </div>
            <span class="step-chip" data-i18n="composer.submitOnce">One submission</span>
          </div>

          <form id="mission-form" novalidate>
            <label class="field">
              <span data-i18n="form.titleLabel">Title</span>
              <input
                id="mission-title"
                name="title"
                type="text"
                autocomplete="off"
                placeholder="Fix browser task persistence"
                data-i18n-placeholder="form.titlePlaceholder"
                required
              />
            </label>

            <label class="field">
              <span data-i18n="form.objectiveLabel">What outcome do you want?</span>
              <textarea
                id="mission-objective"
                name="objective"
                rows="4"
                placeholder="Describe the final verifiable code outcome. You do not need to break the work into Runtime steps."
                data-i18n-placeholder="form.objectivePlaceholder"
                required
              ></textarea>
            </label>

            <label class="field">
              <span data-i18n="form.workspaceLabel">Absolute path to the Git workspace</span>
              <input
                id="mission-workspace"
                name="workspace"
                type="text"
                inputmode="url"
                autocomplete="off"
                spellcheck="false"
                placeholder="/Users/me/project-worktree"
                data-i18n-placeholder="form.workspacePlaceholder"
                required
              />
            </label>

            <div class="verifier-block">
              <div class="field-intro">
                <span data-i18n="form.verifierHeading">Completion criteria</span>
                <small data-i18n="form.verifierHint">
                  The control plane runs the program directly, without a Shell.
                </small>
              </div>
              <label class="field compact-field">
                <span data-i18n="form.executableLabel">Executable</span>
                <input
                  id="verifier-executable"
                  name="verifierExecutable"
                  type="text"
                  autocomplete="off"
                  spellcheck="false"
                  value="pnpm"
                  required
                />
              </label>
              <label class="field compact-field">
                <span data-i18n="form.argumentsLabel">Arguments · one per line</span>
                <textarea
                  id="verifier-args"
                  name="verifierArgs"
                  rows="3"
                  autocomplete="off"
                  spellcheck="false">test</textarea>
              </label>
            </div>

            <fieldset class="route-fieldset">
              <legend data-i18n="form.routeLegend">Runtime route</legend>
              <div class="route-options">
                <input id="route-codex" name="route" type="radio" value="codex" />
                <label for="route-codex" class="route-option">
                  <strong>Codex</strong>
                  <small data-i18n="form.singleAttempt">Single Attempt</small>
                </label>

                <input id="route-qoder" name="route" type="radio" value="qoder" />
                <label for="route-qoder" class="route-option">
                  <strong>Qoder</strong>
                  <small data-i18n="form.singleAttempt">Single Attempt</small>
                </label>

                <input id="route-claude" name="route" type="radio" value="claude" />
                <label for="route-claude" class="route-option">
                  <strong>Claude Code</strong>
                  <small data-i18n="form.singleAttempt">Single Attempt</small>
                </label>

                <input
                  id="route-braid"
                  name="route"
                  type="radio"
                  value="codex-qoder"
                  checked
                />
                <label for="route-braid" class="route-option route-option-braid">
                  <strong>Codex <span aria-hidden="true">→</span> Qoder</strong>
                  <small data-i18n="form.plannedHandoff">Planned Capsule handoff</small>
                </label>

                <input
                  id="route-three-runtime"
                  name="route"
                  type="radio"
                  value="codex-qoder-claude"
                />
                <label
                  for="route-three-runtime"
                  class="route-option route-option-braid route-option-wide"
                >
                  <strong>
                    Codex <span aria-hidden="true">→</span> Qoder
                    <span aria-hidden="true">→</span> Claude
                  </strong>
                  <small data-i18n="form.threeRuntimeHandoff">
                    Three-stage Capsule handoff
                  </small>
                </label>
              </div>
            </fieldset>

            <details class="profile-editor" open>
              <summary data-i18n="form.profileSummary">Runtime Profile</summary>
              <p class="profile-editor-note" data-i18n="form.profileHint">
                A Harness is only the runner; the model, reasoning effort, and permissions define
                the effective execution environment.
              </p>
              <div class="profile-editor-grid">
                <section class="profile-editor-card" data-profile-editor="codex">
                  <div class="profile-editor-heading">
                    <strong>Codex</strong>
                    <span>workspace-write</span>
                  </div>
                  <label class="field compact-field">
                    <span data-i18n="form.modelLabel">Model</span>
                    <input id="codex-model" type="text" value="gpt-5.6-sol" />
                  </label>
                  <label class="field compact-field">
                    <span data-i18n="form.reasoningLabel">Reasoning</span>
                    <select id="codex-reasoning">
                      <option value="low">low</option>
                      <option value="medium" selected>medium</option>
                      <option value="high">high</option>
                      <option value="xhigh">xhigh</option>
                      <option value="ultra">ultra</option>
                    </select>
                  </label>
                </section>
                <section class="profile-editor-card" data-profile-editor="qoder">
                  <div class="profile-editor-heading">
                    <strong>Qoder</strong>
                    <span>bypass_permissions</span>
                  </div>
                  <label class="field compact-field">
                    <span data-i18n="form.modelLabel">Model</span>
                    <input id="qoder-model" type="text" value="Qwen3.8-Max" />
                  </label>
                  <label class="field compact-field">
                    <span data-i18n="form.reasoningLabel">Reasoning</span>
                    <select id="qoder-reasoning">
                      <option value="low">low</option>
                      <option value="medium" selected>medium</option>
                      <option value="high">high</option>
                      <option value="max">max</option>
                    </select>
                  </label>
                </section>
                <section class="profile-editor-card" data-profile-editor="claude">
                  <div class="profile-editor-heading">
                    <strong>Claude Code</strong>
                    <span>bypassPermissions</span>
                  </div>
                  <label class="field compact-field">
                    <span data-i18n="form.modelLabel">Model</span>
                    <input id="claude-model" type="text" value="deepseek-v4-pro" />
                  </label>
                  <label class="field compact-field">
                    <span data-i18n="form.reasoningLabel">Reasoning</span>
                    <select id="claude-reasoning">
                      <option value="low">low</option>
                      <option value="medium" selected>medium</option>
                      <option value="high">high</option>
                      <option value="max">max</option>
                    </select>
                  </label>
                </section>
              </div>
            </details>

            <div id="route-summary" class="route-summary">
              <span class="route-thread route-thread-codex">Codex · GPT-5.6 Sol · medium</span>
              <span class="route-arrow" aria-hidden="true">→</span>
              <span class="route-thread route-thread-qoder">Qoder · Qwen3.8-Max · medium</span>
            </div>

            <div id="form-status" class="form-status" role="status" aria-live="polite"></div>
            <button id="create-mission" class="primary-button" type="submit">
              <span data-i18n="form.createAndRun">Create and run Mission</span>
              <span aria-hidden="true">↗</span>
            </button>
          </form>
        </aside>
      </main>

      <footer class="page-footer">
        <span data-i18n="footer.controlPlane">LOCAL CONTROL PLANE</span>
        <span data-i18n="footer.kernelTruth">Mission Kernel is the sole source of truth for Mission state</span>
      </footer>
    </div>
    <script type="module" src="/app.js"></script>
  </body>
</html>`;

export const APP_CSS = String.raw`:root {
  --paper: #eef3f8;
  --ink: #17243b;
  --cobalt: #315bd6;
  --orange: #f36b3d;
  --teal: #168c87;
  --white: #ffffff;
  --muted: #64738a;
  --line: #ccd7e4;
  --line-strong: #aebed0;
  --wash-blue: #e6ecfb;
  --wash-orange: #fff0ea;
  --wash-teal: #e4f3f1;
  --danger: #b74132;
  --shadow: 0 16px 44px rgba(23, 36, 59, 0.08);
  --display: "Avenir Next Condensed", "Arial Narrow", "Helvetica Neue", sans-serif;
  --body: Avenir, "Avenir Next", "Segoe UI", Helvetica, Arial, sans-serif;
  --mono: "SFMono-Regular", "SF Mono", Menlo, Consolas, monospace;
}

* {
  box-sizing: border-box;
}

html {
  min-width: 320px;
  background: var(--paper);
  color: var(--ink);
  font-family: var(--body);
}

body {
  margin: 0;
  min-height: 100vh;
  background:
    linear-gradient(rgba(255, 255, 255, 0.52), rgba(238, 243, 248, 0.8)),
    repeating-linear-gradient(
      90deg,
      transparent 0,
      transparent 79px,
      rgba(49, 91, 214, 0.035) 80px
    );
}

button,
input,
textarea {
  color: inherit;
  font: inherit;
}

button {
  cursor: pointer;
}

button:disabled {
  cursor: not-allowed;
  opacity: 0.46;
}

:focus-visible {
  outline: 3px solid rgba(49, 91, 214, 0.36);
  outline-offset: 3px;
}

.skip-link {
  position: fixed;
  z-index: 100;
  top: 12px;
  left: 12px;
  padding: 10px 14px;
  transform: translateY(-160%);
  border-radius: 8px;
  background: var(--ink);
  color: var(--white);
  font-weight: 700;
  text-decoration: none;
}

.skip-link:focus {
  transform: translateY(0);
}

.app-shell {
  width: min(1720px, 100%);
  margin: 0 auto;
  padding: 22px clamp(16px, 2vw, 34px) 18px;
}

.masthead {
  display: grid;
  grid-template-columns: minmax(280px, 0.9fr) minmax(260px, 1.4fr) auto;
  gap: clamp(18px, 3vw, 46px);
  align-items: center;
  padding: 13px 0 24px;
  border-bottom: 1px solid var(--line-strong);
}

.brand-lockup {
  display: flex;
  gap: 15px;
  align-items: center;
}

.brand-title-row {
  display: flex;
  gap: 12px;
  align-items: center;
}

.language-switch {
  display: inline-flex;
  overflow: hidden;
  border: 1px solid var(--line-strong);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.76);
}

.language-switch button {
  min-width: 35px;
  padding: 4px 8px;
  border: 0;
  background: transparent;
  color: var(--muted);
  font-family: var(--mono);
  font-size: 0.58rem;
  font-weight: 700;
  letter-spacing: 0.04em;
}

.language-switch button + button {
  border-left: 1px solid var(--line);
}

.language-switch button[aria-pressed="true"] {
  background: var(--ink);
  color: var(--white);
}

.language-switch button:hover:not([aria-pressed="true"]) {
  color: var(--cobalt);
}

.brand-mark {
  display: grid;
  width: 48px;
  height: 48px;
  place-items: center;
  flex: 0 0 auto;
  border: 1px solid var(--ink);
  border-radius: 50% 50% 42% 58%;
  background: var(--white);
  color: var(--cobalt);
  font-family: var(--display);
  font-size: 1.08rem;
  font-weight: 800;
  letter-spacing: 0.04em;
  box-shadow: inset -5px -4px 0 var(--wash-blue);
}

.eyebrow {
  margin: 0 0 4px;
  color: var(--muted);
  font-family: var(--mono);
  font-size: 0.65rem;
  font-weight: 650;
  letter-spacing: 0.13em;
  line-height: 1.2;
  text-transform: uppercase;
}

h1,
h2,
h3,
p {
  margin-top: 0;
}

h1,
h2,
h3 {
  color: var(--ink);
  font-family: var(--display);
  font-stretch: condensed;
}

h1 {
  margin-bottom: 1px;
  font-size: clamp(1.8rem, 3vw, 2.55rem);
  font-weight: 750;
  letter-spacing: -0.025em;
  line-height: 0.95;
}

h2 {
  margin-bottom: 0;
  font-size: 1.42rem;
  font-weight: 700;
  letter-spacing: -0.012em;
  line-height: 1.05;
}

h3 {
  margin-bottom: 0;
  font-size: 1.05rem;
  line-height: 1.18;
}

.brand-subtitle {
  margin: 3px 0 0;
  color: var(--muted);
  font-size: 0.78rem;
}

.braid-signature {
  position: relative;
  height: 62px;
  min-width: 240px;
}

.braid-signature svg {
  display: block;
  width: 100%;
  height: 100%;
  overflow: visible;
}

.braid-base,
.braid-flow {
  fill: none;
  stroke-linecap: round;
  stroke-linejoin: round;
  vector-effect: non-scaling-stroke;
}

.braid-base {
  stroke-width: 5;
  paint-order: stroke;
}

.braid-cobalt {
  stroke: var(--cobalt);
}

.braid-orange {
  stroke: var(--orange);
}

.braid-flow {
  stroke: rgba(255, 255, 255, 0.88);
  stroke-width: 1.5;
  stroke-dasharray: 2 15;
  animation: braid-flow 5.5s linear infinite;
}

.braid-flow-orange {
  animation-direction: reverse;
  animation-duration: 6.5s;
}

.braid-caption {
  position: absolute;
  right: 0;
  bottom: -4px;
  color: var(--muted);
  font-family: var(--mono);
  font-size: 0.58rem;
  letter-spacing: 0.14em;
}

@keyframes braid-flow {
  to {
    stroke-dashoffset: -68;
  }
}

.connection-state {
  display: inline-flex;
  gap: 8px;
  align-items: center;
  justify-self: end;
  padding: 8px 11px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.76);
  color: var(--muted);
  font-size: 0.72rem;
  white-space: nowrap;
}

.connection-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--orange);
  box-shadow: 0 0 0 3px rgba(243, 107, 61, 0.12);
}

.connection-state.is-online .connection-dot {
  background: var(--teal);
  box-shadow: 0 0 0 3px rgba(22, 140, 135, 0.12);
}

.page-alert {
  margin-top: 14px;
  padding: 11px 14px;
  border: 1px solid rgba(183, 65, 50, 0.36);
  border-left: 4px solid var(--danger);
  border-radius: 8px;
  background: #fff1ef;
  color: #802d24;
  font-size: 0.86rem;
}

.runtime-belt {
  padding: 20px 0 18px;
}

.section-heading,
.panel-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.runtime-heading-row {
  margin-bottom: 11px;
}

.runtime-list {
  display: grid;
  grid-auto-columns: minmax(300px, 1fr);
  grid-auto-flow: column;
  gap: 9px;
  overflow-x: auto;
  padding: 1px 1px 7px;
  scrollbar-color: var(--line-strong) transparent;
}

.runtime-card {
  position: relative;
  min-height: 104px;
  padding: 13px 14px 12px;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 11px;
  background: rgba(255, 255, 255, 0.8);
}

.runtime-card::before {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: 3px;
  background: var(--line-strong);
  content: "";
}

.runtime-card.is-ready::before {
  background: var(--teal);
}

.runtime-card.is-unavailable::before {
  background: var(--orange);
}

.runtime-card.is-unsupported::before {
  background: var(--cobalt);
}

.runtime-card-head {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: 10px;
}

.runtime-name {
  font-family: var(--display);
  font-size: 1.05rem;
  font-weight: 750;
}

.runtime-version,
.runtime-path,
.mission-id,
.timeline-meta,
.receipt-id {
  font-family: var(--mono);
}

.runtime-version {
  color: var(--muted);
  font-size: 0.65rem;
}

.runtime-state {
  display: inline-flex;
  align-items: center;
  margin-top: 11px;
  color: var(--muted);
  font-size: 0.7rem;
}

.runtime-state::before {
  width: 6px;
  height: 6px;
  margin-right: 6px;
  border-radius: 50%;
  background: currentcolor;
  content: "";
}

.runtime-card.is-ready .runtime-state {
  color: var(--teal);
}

.runtime-card.is-unavailable .runtime-state {
  color: var(--orange);
}

.runtime-card.is-unsupported .runtime-state {
  color: var(--cobalt);
}

.runtime-path {
  margin: 7px 0 0;
  overflow: hidden;
  color: var(--muted);
  font-size: 0.58rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.runtime-capabilities {
  margin-top: 11px;
  padding-top: 10px;
  border-top: 1px solid var(--line);
}

.runtime-capabilities-heading {
  margin: 0 0 7px;
  color: var(--muted);
  font-family: var(--mono);
  font-size: 0.54rem;
  font-weight: 750;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.runtime-capability-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 5px;
}

.runtime-capability-item {
  min-width: 0;
  padding: 6px 7px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: rgba(247, 249, 252, 0.88);
}

.runtime-capability-name,
.runtime-capability-state,
.runtime-capability-control {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.runtime-capability-name {
  color: var(--ink);
  font-size: 0.6rem;
  font-weight: 750;
}

.runtime-capability-state,
.runtime-capability-control {
  margin-top: 2px;
  font-family: var(--mono);
  font-size: 0.52rem;
}

.runtime-capability-state {
  color: var(--muted);
}

.runtime-capability-state.is-supported {
  color: var(--teal);
}

.runtime-capability-state.is-unsupported {
  color: var(--cobalt);
}

.runtime-capability-state.is-unknown {
  color: var(--orange);
}

.runtime-capability-control {
  color: var(--muted);
}

.loading-note,
.empty-note {
  margin: 0;
  color: var(--muted);
  font-size: 0.8rem;
}

.control-grid {
  display: grid;
  grid-template-areas: "index stage composer";
  grid-template-columns: minmax(220px, 0.72fr) minmax(430px, 1.75fr) minmax(330px, 1fr);
  gap: 13px;
  align-items: start;
}

.panel {
  min-width: 0;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: var(--white);
  box-shadow: var(--shadow);
}

.mission-index {
  grid-area: index;
  min-height: 610px;
  padding: 17px 14px;
}

.mission-stage {
  grid-area: stage;
  min-height: 610px;
  overflow: hidden;
}

.composer {
  position: sticky;
  top: 12px;
  grid-area: composer;
  padding: 17px;
}

.panel-heading {
  margin-bottom: 16px;
}

.icon-button,
.quiet-button {
  border: 1px solid var(--line);
  background: var(--white);
  color: var(--ink);
}

.icon-button {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  font-size: 1.05rem;
}

.quiet-button {
  padding: 7px 10px;
  border-radius: 7px;
  font-size: 0.7rem;
  font-weight: 700;
}

.icon-button:hover,
.quiet-button:hover {
  border-color: var(--cobalt);
  color: var(--cobalt);
}

.mission-list {
  display: grid;
  gap: 7px;
}

.mission-list-button {
  width: 100%;
  padding: 12px 11px;
  border: 1px solid transparent;
  border-radius: 9px;
  background: #f7f9fc;
  text-align: left;
}

.mission-list-button:hover {
  border-color: var(--line-strong);
  background: var(--paper);
}

.mission-list-button.is-selected {
  border-color: rgba(49, 91, 214, 0.42);
  background: var(--wash-blue);
  box-shadow: inset 3px 0 0 var(--cobalt);
}

.mission-list-title {
  display: block;
  margin-bottom: 7px;
  font-family: var(--display);
  font-size: 0.98rem;
  font-weight: 700;
  line-height: 1.15;
}

.mission-list-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  color: var(--muted);
  font-size: 0.62rem;
}

.mission-list-id {
  overflow: hidden;
  font-family: var(--mono);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.status-badge {
  display: inline-flex;
  align-items: center;
  padding: 4px 7px;
  border-radius: 999px;
  background: var(--paper);
  color: var(--muted);
  font-family: var(--mono);
  font-size: 0.58rem;
  font-weight: 700;
  white-space: nowrap;
}

.status-badge.is-running,
.status-badge.is-queued,
.status-badge.is-pending,
.status-badge.is-verifying {
  background: var(--wash-blue);
  color: var(--cobalt);
}

.status-badge.is-succeeded {
  background: var(--wash-teal);
  color: var(--teal);
}

.status-badge.is-waiting,
.status-badge.is-interrupted {
  background: var(--wash-orange);
  color: #a04426;
}

.status-badge.is-failed,
.status-badge.is-cancelled {
  background: #fce9e6;
  color: var(--danger);
}

.detail-empty {
  display: grid;
  min-height: 608px;
  padding: 54px clamp(24px, 7vw, 82px);
  place-content: center;
  text-align: center;
}

.detail-empty h2 {
  margin-bottom: 12px;
  font-size: clamp(1.7rem, 4vw, 2.7rem);
}

.detail-empty > p:last-child {
  max-width: 600px;
  margin-bottom: 0;
  color: var(--muted);
  font-size: 0.9rem;
  line-height: 1.65;
}

.empty-knot {
  position: relative;
  display: block;
  width: 88px;
  height: 43px;
  margin: 0 auto 20px;
}

.empty-knot::before,
.empty-knot::after {
  position: absolute;
  top: 12px;
  width: 52px;
  height: 18px;
  border: 3px solid;
  border-radius: 50%;
  content: "";
}

.empty-knot::before {
  left: 0;
  border-color: var(--cobalt);
  transform: rotate(17deg);
}

.empty-knot::after {
  right: 0;
  border-color: var(--orange);
  transform: rotate(-17deg);
}

.detail-content {
  min-height: 608px;
}

.detail-hero {
  padding: 24px clamp(20px, 3vw, 34px) 21px;
  border-bottom: 1px solid var(--line);
  background:
    radial-gradient(circle at 92% 14%, rgba(49, 91, 214, 0.1), transparent 33%),
    linear-gradient(135deg, #fff 0%, #f7f9fd 100%);
}

.detail-title-row {
  display: flex;
  gap: 18px;
  align-items: start;
  justify-content: space-between;
}

.detail-hero h2 {
  max-width: 720px;
  margin: 3px 0 8px;
  font-size: clamp(1.55rem, 3vw, 2.25rem);
}

.mission-id {
  margin: 0;
  overflow-wrap: anywhere;
  color: var(--muted);
  font-size: 0.65rem;
}

.mission-objective {
  max-width: 760px;
  margin: 17px 0 0;
  color: #394962;
  font-size: 0.87rem;
  line-height: 1.58;
}

.operation-note {
  margin: 14px 0 0;
  padding: 10px 12px;
  border-left: 3px solid var(--orange);
  border-radius: 0 7px 7px 0;
  background: var(--wash-orange);
  color: #7f3d27;
  font-size: 0.75rem;
  line-height: 1.5;
}

.detail-actions {
  display: flex;
  gap: 7px;
  flex-wrap: wrap;
  margin-top: 16px;
}

.action-button {
  padding: 8px 11px;
  border: 1px solid var(--line-strong);
  border-radius: 7px;
  background: var(--white);
  color: var(--ink);
  font-size: 0.7rem;
  font-weight: 750;
}

.action-button:hover:not(:disabled) {
  border-color: var(--cobalt);
  color: var(--cobalt);
}

.timeline-section {
  padding: 22px clamp(17px, 3vw, 31px) 27px;
}

.runtime-intelligence {
  padding: 20px clamp(17px, 3vw, 31px) 22px;
  border-bottom: 1px solid var(--line);
  background: #f7f9fc;
}

.intelligence-heading {
  margin-bottom: 13px;
}

.intelligence-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 9px;
}

.intelligence-card {
  min-width: 0;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--white);
}

.intelligence-card.is-wide {
  grid-column: 1 / -1;
}

.intelligence-card-heading {
  display: flex;
  gap: 10px;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 9px;
}

.intelligence-card-heading h4 {
  margin: 0;
  font-family: var(--display);
  font-size: 0.92rem;
}

.intelligence-card-heading span {
  color: var(--muted);
  font-family: var(--mono);
  font-size: 0.55rem;
}

.intelligence-record + .intelligence-record {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--line);
}

.intelligence-record-title {
  margin: 0 0 7px;
  overflow: hidden;
  color: var(--ink);
  font-family: var(--mono);
  font-size: 0.58rem;
  font-weight: 750;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.intelligence-facts {
  display: grid;
  gap: 5px;
  margin: 0;
}

.intelligence-fact {
  display: grid;
  grid-template-columns: minmax(92px, 0.68fr) minmax(0, 1.32fr);
  gap: 8px;
  align-items: baseline;
}

.intelligence-fact dt,
.intelligence-fact dd {
  margin: 0;
}

.intelligence-fact dt {
  color: var(--muted);
  font-size: 0.58rem;
}

.intelligence-fact dd {
  overflow-wrap: anywhere;
  color: #394962;
  font-family: var(--mono);
  font-size: 0.58rem;
  line-height: 1.4;
}

.runtime-event-records {
  max-height: 430px;
  padding-right: 4px;
  overflow: auto;
  scrollbar-color: var(--line-strong) transparent;
}

.runtime-event-facts {
  display: flex;
  gap: 5px;
  flex-wrap: wrap;
  margin-top: 8px;
}

.runtime-event-fact {
  padding: 4px 6px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--white);
  color: var(--muted);
  font-family: var(--mono);
  font-size: 0.53rem;
  overflow-wrap: anywhere;
}

.native-artifact-button {
  padding: 4px 7px;
  border: 1px solid rgba(49, 91, 214, 0.3);
  border-radius: 6px;
  background: var(--wash-blue);
  color: var(--cobalt);
  font-size: 0.58rem;
  font-weight: 750;
}

.native-artifact-button:hover:not(:disabled) {
  border-color: var(--cobalt);
}

.native-artifact-viewer {
  flex: 1 0 100%;
  min-width: 0;
  margin-top: 3px;
  padding: 10px;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  background: var(--ink);
  color: #eaf0f7;
}

.native-artifact-viewer[hidden] {
  display: none;
}

.native-artifact-viewer-header {
  display: flex;
  gap: 12px;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.native-artifact-viewer-header strong {
  font-size: 0.68rem;
}

.native-artifact-close {
  padding: 3px 6px;
  border: 1px solid rgba(234, 240, 247, 0.34);
  border-radius: 5px;
  background: transparent;
  color: #eaf0f7;
  font-size: 0.55rem;
}

.native-artifact-meta {
  margin: 0 0 7px;
  color: #aebed0;
  font-family: var(--mono);
  font-size: 0.52rem;
  overflow-wrap: anywhere;
}

.native-artifact-viewer pre {
  max-height: 300px;
  margin: 0;
  overflow: auto;
  font-family: var(--mono);
  font-size: 0.58rem;
  line-height: 1.5;
  white-space: pre-wrap;
}

.native-artifact-error {
  margin: 0;
  color: #ffc7ba;
  font-size: 0.65rem;
}

.timeline-section-heading {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 14px;
  margin-bottom: 16px;
}

.timeline-count {
  color: var(--muted);
  font-family: var(--mono);
  font-size: 0.64rem;
}

.timeline {
  position: relative;
  display: grid;
  gap: 0;
  margin: 0;
  padding: 0;
  list-style: none;
}

.timeline::before {
  position: absolute;
  top: 15px;
  bottom: 17px;
  left: 16px;
  width: 1px;
  background: var(--line-strong);
  content: "";
}

.timeline-item {
  position: relative;
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr);
  gap: 12px;
  padding-bottom: 17px;
}

.timeline-marker {
  position: relative;
  z-index: 1;
  display: grid;
  width: 33px;
  height: 33px;
  place-items: center;
  border: 1px solid var(--line-strong);
  border-radius: 50%;
  background: var(--white);
  color: var(--muted);
  font-family: var(--mono);
  font-size: 0.58rem;
  font-weight: 800;
}

.timeline-item[data-category="attempt"] .timeline-marker,
.timeline-item[data-category="profile"] .timeline-marker {
  border-color: var(--cobalt);
  color: var(--cobalt);
}

.timeline-item[data-category="handoff"] .timeline-marker,
.timeline-item[data-category="checkpoint"] .timeline-marker {
  border-color: var(--orange);
  color: var(--orange);
}

.timeline-item[data-category="effect"] .timeline-marker,
.timeline-item[data-category="verification"] .timeline-marker,
.timeline-item[data-category="receipt"] .timeline-marker {
  border-color: var(--teal);
  color: var(--teal);
}

.timeline-item[data-category="failure"] .timeline-marker {
  border-color: var(--danger);
  color: var(--danger);
}

.timeline-card {
  min-width: 0;
  padding: 10px 12px 11px;
  border: 1px solid #dce4ed;
  border-radius: 9px;
  background: #fbfcfe;
}

.timeline-title-row {
  display: flex;
  gap: 10px;
  align-items: start;
  justify-content: space-between;
}

.timeline-title {
  font-size: 0.83rem;
  font-weight: 750;
}

.timeline-meta {
  color: var(--muted);
  font-size: 0.56rem;
  white-space: nowrap;
}

.timeline-description {
  margin: 5px 0 0;
  color: var(--muted);
  font-size: 0.73rem;
  line-height: 1.45;
}

.timeline-details {
  margin-top: 7px;
  color: var(--muted);
  font-size: 0.65rem;
}

.timeline-details summary {
  width: fit-content;
  cursor: pointer;
  font-weight: 700;
}

.timeline-details pre {
  max-height: 180px;
  margin: 8px 0 0;
  padding: 9px;
  overflow: auto;
  border-radius: 6px;
  background: var(--ink);
  color: #eaf0f7;
  font-family: var(--mono);
  font-size: 0.58rem;
  line-height: 1.45;
  white-space: pre-wrap;
}

.receipt-card {
  margin-top: 9px;
  padding: 17px;
  border: 1px solid rgba(22, 140, 135, 0.38);
  border-radius: 11px;
  background: var(--wash-teal);
}

.receipt-card.is-rejected {
  border-color: rgba(183, 65, 50, 0.32);
  background: #fce9e6;
}

.receipt-heading {
  display: flex;
  gap: 12px;
  align-items: start;
  justify-content: space-between;
}

.receipt-outcome {
  color: var(--teal);
  font-family: var(--display);
  font-size: 1.25rem;
  font-weight: 800;
}

.receipt-card.is-rejected .receipt-outcome {
  color: var(--danger);
}

.receipt-id {
  margin: 4px 0 0;
  color: var(--muted);
  font-size: 0.58rem;
}

.receipt-criteria {
  display: grid;
  gap: 6px;
  margin-top: 13px;
}

.criterion-row {
  display: flex;
  gap: 12px;
  align-items: center;
  justify-content: space-between;
  padding-top: 7px;
  border-top: 1px solid rgba(22, 140, 135, 0.18);
  font-size: 0.7rem;
}

.criterion-status {
  font-family: var(--mono);
  font-size: 0.6rem;
  font-weight: 750;
}

.step-chip {
  padding: 4px 7px;
  border: 1px solid rgba(49, 91, 214, 0.25);
  border-radius: 999px;
  background: var(--wash-blue);
  color: var(--cobalt);
  font-family: var(--mono);
  font-size: 0.58rem;
  font-weight: 750;
}

#mission-form {
  display: grid;
  gap: 13px;
}

.field {
  display: grid;
  gap: 6px;
}

.field > span,
.field-intro > span,
.route-fieldset legend {
  color: var(--ink);
  font-size: 0.72rem;
  font-weight: 750;
}

.field input,
.field textarea {
  width: 100%;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #fbfcfe;
  color: var(--ink);
  font-size: 0.77rem;
  line-height: 1.45;
}

.field input {
  height: 40px;
  padding: 0 11px;
}

.field textarea {
  min-height: 74px;
  padding: 9px 11px;
  resize: vertical;
}

.field input:hover,
.field textarea:hover {
  border-color: var(--line-strong);
}

.field input:focus,
.field textarea:focus {
  border-color: var(--cobalt);
  background: var(--white);
}

#mission-workspace,
#verifier-executable,
#verifier-args {
  font-family: var(--mono);
  font-size: 0.68rem;
}

.verifier-block {
  display: grid;
  grid-template-columns: 0.8fr 1.2fr;
  gap: 10px;
  padding: 11px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--paper);
}

.field-intro {
  display: flex;
  grid-column: 1 / -1;
  gap: 8px;
  align-items: baseline;
  justify-content: space-between;
}

.field-intro small {
  color: var(--muted);
  font-size: 0.58rem;
}

.compact-field > span {
  font-family: var(--mono);
  font-size: 0.59rem;
  font-weight: 650;
}

.compact-field textarea {
  min-height: 40px;
}

.route-fieldset {
  min-width: 0;
  margin: 1px 0 0;
  padding: 0;
  border: 0;
}

.route-fieldset legend {
  margin-bottom: 7px;
  padding: 0;
}

.route-options {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 5px;
}

.route-options input {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  white-space: nowrap;
}

.route-option {
  display: grid;
  min-height: 65px;
  padding: 9px 7px;
  place-content: center;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #fbfcfe;
  text-align: center;
  cursor: pointer;
}

.route-option strong {
  font-family: var(--display);
  font-size: 0.82rem;
}

.route-option small {
  margin-top: 3px;
  color: var(--muted);
  font-size: 0.53rem;
  line-height: 1.2;
}

.route-options input:focus-visible + .route-option {
  outline: 3px solid rgba(49, 91, 214, 0.36);
  outline-offset: 2px;
}

.route-options input:checked + .route-option {
  border-color: var(--cobalt);
  background: var(--wash-blue);
  color: var(--cobalt);
  box-shadow: inset 0 -3px 0 var(--cobalt);
}

.route-options input:checked + .route-option-braid {
  border-color: var(--orange);
  background: linear-gradient(120deg, var(--wash-blue), var(--wash-orange));
  color: var(--ink);
  box-shadow: inset 0 -3px 0 var(--orange);
}

.route-option-wide {
  grid-column: 1 / -1;
}

.route-summary {
  display: flex;
  gap: 7px;
  align-items: center;
  min-height: 29px;
  padding: 7px 9px;
  overflow-x: auto;
  border-radius: 7px;
  background: var(--ink);
  color: var(--white);
  font-family: var(--mono);
  font-size: 0.55rem;
  white-space: nowrap;
}

.profile-editor {
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--paper);
  padding: 0.7rem 0.8rem 0.8rem;
}

.profile-editor summary {
  cursor: pointer;
  color: var(--ink);
  font-family: var(--font-display);
  font-weight: 800;
  letter-spacing: 0.02em;
}

.profile-editor-note {
  margin: 0.5rem 0 0.65rem;
  color: var(--muted);
  font-size: 0.7rem;
  line-height: 1.5;
}

.profile-editor-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.55rem;
}

.profile-editor-card {
  display: grid;
  gap: 0.55rem;
  padding: 0.65rem;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--white);
}

.profile-editor-card[hidden] {
  display: none;
}

.profile-editor-heading {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.4rem;
}

.profile-editor-heading strong {
  font-family: var(--font-display);
  font-size: 1rem;
}

.profile-editor-heading span {
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 0.55rem;
}

.profile-editor-card .field {
  gap: 0.25rem;
}

.profile-editor-card input,
.profile-editor-card select {
  min-width: 0;
  padding: 0.55rem 0.6rem;
  font-size: 0.72rem;
}

.route-thread-codex {
  color: #9cb3ff;
}

.route-thread-qoder {
  color: #83d8d2;
}

.route-thread-claude {
  color: #ffc09f;
}

.route-arrow {
  color: var(--orange);
}

.form-status {
  min-height: 18px;
  color: var(--muted);
  font-size: 0.68rem;
  line-height: 1.4;
}

.form-status.is-error {
  color: var(--danger);
}

.form-status.is-success {
  color: var(--teal);
}

.primary-button {
  display: flex;
  min-height: 46px;
  align-items: center;
  justify-content: space-between;
  padding: 0 15px;
  border: 1px solid var(--ink);
  border-radius: 9px;
  background: var(--ink);
  color: var(--white);
  font-family: var(--display);
  font-size: 0.96rem;
  font-weight: 750;
  letter-spacing: 0.015em;
  box-shadow: 5px 5px 0 var(--cobalt);
}

.primary-button:hover:not(:disabled) {
  transform: translate(-1px, -1px);
  box-shadow: 7px 7px 0 var(--orange);
}

.page-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 17px 3px 0;
  color: var(--muted);
  font-family: var(--mono);
  font-size: 0.56rem;
  letter-spacing: 0.07em;
}

@media (max-width: 1160px) {
  .masthead {
    grid-template-columns: minmax(260px, 0.9fr) minmax(240px, 1.1fr);
  }

  .connection-state {
    display: none;
  }

  .control-grid {
    grid-template-areas:
      "composer composer"
      "index stage";
    grid-template-columns: minmax(220px, 0.68fr) minmax(0, 1.8fr);
  }

  .composer {
    position: static;
  }

  #mission-form {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  #mission-form > .field:nth-of-type(2),
  #mission-form > .verifier-block,
  #mission-form > .route-fieldset,
  #mission-form > .route-summary,
  #mission-form > .form-status,
  #mission-form > .primary-button {
    grid-column: 1 / -1;
  }
}

@media (max-width: 760px) {
  .app-shell {
    padding: 13px 11px 16px;
  }

  .masthead {
    grid-template-columns: 1fr;
    gap: 12px;
    padding-bottom: 17px;
  }

  .braid-signature {
    height: 48px;
  }

  .runtime-belt {
    padding-top: 15px;
  }

  .runtime-list {
    grid-auto-columns: minmax(170px, 76vw);
  }

  .control-grid {
    grid-template-areas:
      "composer"
      "index"
      "stage";
    grid-template-columns: minmax(0, 1fr);
  }

  #mission-form {
    grid-template-columns: 1fr;
  }

  #mission-form > * {
    grid-column: 1 !important;
  }

  .mission-index,
  .mission-stage,
  .detail-empty,
  .detail-content {
    min-height: auto;
  }

  .mission-index {
    padding-bottom: 14px;
  }

  .detail-empty {
    padding: 52px 22px;
  }

  .detail-title-row {
    display: grid;
  }

  .detail-title-row .status-badge {
    justify-self: start;
  }

  .route-options {
    grid-template-columns: 1fr;
  }

  .profile-editor-grid {
    grid-template-columns: 1fr;
  }

  .intelligence-grid {
    grid-template-columns: 1fr;
  }

  .intelligence-card.is-wide {
    grid-column: auto;
  }

  .route-option {
    min-height: 52px;
  }

  .verifier-block {
    grid-template-columns: 1fr;
  }

  .field-intro {
    display: grid;
  }

  .page-footer {
    display: grid;
  }
}

@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    scroll-behavior: auto !important;
    animation-duration: 0.001ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.001ms !important;
  }

  .braid-flow {
    animation: none;
  }
}`;

export const APP_JAVASCRIPT = String.raw`const COPY = ${APP_COPY_JSON};
const LOCALE_STORAGE_KEY = 'missionbraid.locale';
const SUPPORTED_LOCALES = ['en', 'zh-CN'];

function normalizeLocale(value) {
  if (typeof value !== 'string') return null;
  if (value.toLowerCase().startsWith('zh')) return 'zh-CN';
  if (value.toLowerCase().startsWith('en')) return 'en';
  return null;
}

function preferredLocale() {
  try {
    const stored = normalizeLocale(window.localStorage.getItem(LOCALE_STORAGE_KEY));
    if (stored) return stored;
  } catch (_error) {
    // The Workbench still functions when browser storage is unavailable.
  }
  const browserLocales = Array.isArray(navigator.languages)
    ? navigator.languages
    : [navigator.language];
  for (const browserLocale of browserLocales) {
    const locale = normalizeLocale(browserLocale);
    if (locale) return locale;
  }
  return 'en';
}

const state = {
  locale: preferredLocale(),
  runtimes: [],
  missions: [],
  selectedMissionId: null,
  detail: null,
  runtimesLoading: false,
  missionsLoading: false,
  detailLoading: false,
  connection: { online: false, message: { key: 'connection.connecting' } },
  pageAlert: null,
  formMessage: null,
  formMessageKind: '',
};

const elements = {
  connection: document.querySelector('.connection-state'),
  connectionLabel: document.querySelector('#connection-label'),
  pageAlert: document.querySelector('#page-alert'),
  runtimeList: document.querySelector('#runtime-list'),
  missionList: document.querySelector('#mission-list'),
  missionDetail: document.querySelector('#mission-detail'),
  refreshRuntimes: document.querySelector('#refresh-runtimes'),
  refreshMissions: document.querySelector('#refresh-missions'),
  form: document.querySelector('#mission-form'),
  formStatus: document.querySelector('#form-status'),
  createButton: document.querySelector('#create-mission'),
  routeSummary: document.querySelector('#route-summary'),
  languageButtons: document.querySelectorAll('[data-locale]'),
};

const STATUS_LABEL_KEYS = {
  pending: 'mission.status.pending',
  queued: 'mission.status.queued',
  running: 'mission.status.running',
  waiting: 'mission.status.waiting',
  verifying: 'mission.status.verifying',
  succeeded: 'mission.status.succeeded',
  failed: 'mission.status.failed',
  cancelled: 'mission.status.cancelled',
  interrupted: 'mission.status.interrupted',
};

const RUNTIME_STATUS_LABEL_KEYS = {
  'ready-supported': 'runtime.status.ready-supported',
  'installed-unavailable': 'runtime.status.installed-unavailable',
  'installed-unsupported': 'runtime.status.installed-unsupported',
  'needs-bootstrap': 'runtime.status.needs-bootstrap',
  missing: 'runtime.status.missing',
};

const RUNTIME_CAPABILITY_FIELDS = [
  ['observe', 'runtime.capability.observe'],
  ['interrupt', 'runtime.capability.interrupt'],
  ['steer', 'runtime.capability.steer'],
  ['pre_tool_gate', 'runtime.capability.gate'],
  ['resume', 'runtime.capability.resume'],
  ['native_fork', 'runtime.capability.fork'],
  ['workspace_restore', 'runtime.capability.restore'],
  ['external_effect_control', 'runtime.capability.effectControl'],
];

const RUNTIME_CAPABILITY_STATUS_KEYS = {
  supported: 'runtime.capability.status.supported',
  unsupported: 'runtime.capability.status.unsupported',
  unknown: 'runtime.capability.status.unknown',
};

const RUNTIME_CAPABILITY_CONTROL_KEYS = {
  native: 'runtime.capability.control.native',
  controller: 'runtime.capability.control.controller',
  cooperative: 'runtime.capability.control.cooperative',
  'observe-only': 'runtime.capability.control.observe-only',
  none: 'runtime.capability.control.none',
  unknown: 'runtime.capability.control.unknown',
};

const MISSION_ACTION_PATHS = {
  resume: function (missionId) {
    return '/api/v1/missions/' + encodeURIComponent(missionId) + '/resume';
  },
  verify: function (missionId) {
    return '/api/v1/missions/' + encodeURIComponent(missionId) + '/verify';
  },
};

const KIND_LABEL_KEYS = {
  'mission.created': 'event.mission.created',
  'mission.status_changed': 'event.mission.status_changed',
  'branch.created': 'event.branch.created',
  'runtime.catalog_observed': 'event.runtime.catalog_observed',
  'profile.definition_recorded': 'event.profile.definition_recorded',
  'profile.selected': 'event.profile.selected',
  'attempt.bound': 'event.attempt.bound',
  'attempt.started': 'event.attempt.started',
  'attempt.finished': 'event.attempt.finished',
  'attempt.baseline': 'event.attempt.baseline',
  'checkpoint.created': 'event.checkpoint.created',
  'handoff.prepared': 'event.handoff.prepared',
  'handoff.acknowledged': 'event.handoff.acknowledged',
  'handoff.rejected': 'event.handoff.rejected',
  'effect.recorded': 'event.effect.recorded',
  'effect.status_changed': 'event.effect.status_changed',
  'runtime.process_started': 'event.runtime.process_started',
  'runtime.process_finished': 'event.runtime.process_finished',
  'runtime.event': 'event.runtime.event',
  'runtime.effective_profile_reported': 'event.runtime.effective_profile_reported',
  'command.accepted': 'event.command.accepted',
  'command.status_changed': 'event.command.status_changed',
  'verification.completed': 'event.verification.completed',
  'receipt.issued': 'event.receipt.issued',
  'failure.observed': 'event.failure.observed',
};

function t(key, variables) {
  const localeCopy = COPY[state.locale] || COPY.en;
  const template = localeCopy[key] || COPY.en[key] || key;
  const values = variables || {};
  return String(template).replace(/\{([a-zA-Z0-9_]+)\}/g, function (_match, name) {
    return values[name] === undefined || values[name] === null ? '' : String(values[name]);
  });
}

function translated(key, variables) {
  return { key: key, variables: variables || {} };
}

function messageText(message) {
  if (!message) return '';
  if (typeof message.raw === 'string') return message.raw;
  return t(message.key, message.variables);
}

function localizedError(key, variables) {
  const error = new Error(t(key, variables));
  error.translation = translated(key, variables);
  return error;
}

function errorMessage(error, fallbackKey) {
  if (error && error.translation) return error.translation;
  if (error && typeof error.message === 'string' && error.message) {
    return { raw: error.message };
  }
  return translated(fallbackKey);
}

function translateStaticContent() {
  document.querySelectorAll('[data-i18n]').forEach(function (node) {
    node.textContent = t(node.getAttribute('data-i18n'));
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(function (node) {
    node.setAttribute('placeholder', t(node.getAttribute('data-i18n-placeholder')));
  });
  document.querySelectorAll('[data-i18n-aria-label]').forEach(function (node) {
    node.setAttribute('aria-label', t(node.getAttribute('data-i18n-aria-label')));
  });
}

function applyLocale(locale, options) {
  const normalized = normalizeLocale(locale) || 'en';
  state.locale = normalized;
  if (options && options.persist) {
    try {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, normalized);
    } catch (_error) {
      // A private browser context may reject storage; the current switch still applies.
    }
  }
  document.documentElement.lang = normalized;
  document.title = t('page.title');
  translateStaticContent();
  elements.languageButtons.forEach(function (button) {
    button.setAttribute('aria-pressed', button.getAttribute('data-locale') === normalized ? 'true' : 'false');
  });
  renderConnection();
  renderPageAlert();
  renderFormStatus();
  if (options && options.rerender) {
    renderRuntimes();
    renderMissionList();
    if (state.detail) {
      renderDetail();
    } else if (state.selectedMissionId && state.detailLoading) {
      replaceWithMessage(elements.missionDetail, 'empty-note', t('mission.detailLoading'));
    }
    renderRouteSummary();
  }
}

function createElement(tagName, className, text) {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function replaceWithMessage(container, className, text) {
  const paragraph = createElement('p', className, text);
  container.replaceChildren(paragraph);
}

function renderPageAlert() {
  if (!state.pageAlert) {
    elements.pageAlert.hidden = true;
    elements.pageAlert.textContent = '';
    return;
  }
  elements.pageAlert.textContent = messageText(state.pageAlert);
  elements.pageAlert.hidden = false;
}

function showPageAlert(message) {
  state.pageAlert = message;
  renderPageAlert();
}

function renderConnection() {
  elements.connection.classList.toggle('is-online', state.connection.online);
  elements.connectionLabel.textContent = messageText(state.connection.message);
}

function setConnection(online, key, variables) {
  state.connection = { online: online, message: translated(key, variables) };
  renderConnection();
}

function responseError(payload, status) {
  const code = payload && typeof payload.code === 'string' ? payload.code : '';
  const params = payload && recordValue(payload.params) ? payload.params : {};
  let message = payload && typeof payload.message === 'string' ? payload.message : '';
  let invalidMissionDraft = false;
  if (code === 'APP_STOPPING') return localizedError('error.appStopping');
  if (code === 'MISSION_ALREADY_RUNNING') {
    return localizedError('error.missionAlreadyRunning', {
      missionId: params.missionId || t('intelligence.unknown'),
    });
  }
  if (code === 'RUNTIME_NOT_READY') {
    return localizedError('error.runtimeNotReady', {
      harness: params.runtime || t('runtime.nameFallback'),
      reason: params.reason || t('intelligence.unknown'),
    });
  }
  if (code === 'ROUTE_NOT_FOUND') return localizedError('error.routeNotFound');
  if (code === 'INVALID_CONTENT_TYPE') return localizedError('error.invalidContentType');
  if (code === 'REQUEST_TOO_LARGE') return localizedError('error.requestTooLarge');
  if (code === 'INVALID_JSON') return localizedError('error.invalidJson');
  if (code === 'ARTIFACT_NOT_FOUND') {
    return localizedError('artifact.notFound', {
      artifactId: params.artifactId || t('intelligence.unknown'),
    });
  }
  if (code === 'INVALID_MISSION_DRAFT') {
    invalidMissionDraft = true;
    if (typeof params.detail === 'string') message = params.detail;
  }
  if (message === 'MissionBraid app is stopping.') return localizedError('error.appStopping');
  if (message === 'Route not found.') return localizedError('error.routeNotFound');
  if (message === 'Content-Type must be application/json.') {
    return localizedError('error.invalidContentType');
  }
  if (message === 'Request body is too large.') return localizedError('error.requestTooLarge');
  if (message === 'Request body must be valid JSON.') return localizedError('error.invalidJson');
  if (message === 'input.workspace must be an absolute path') {
    return localizedError('validation.workspaceAbsolute');
  }
  if (message === 'workspaceRoot must be a directory') {
    return localizedError('validation.workspaceDirectory');
  }
  if (message === 'workspaceRoot must be the Git worktree root') {
    return localizedError('validation.workspaceGitRoot');
  }
  if (
    message ===
    'input.verifier.executable must invoke the verifier directly, not through a shell'
  ) {
    return localizedError('validation.verifierDirect');
  }
  const credentialMatch = message.match(/^Credential-like (?:value at|field) (.+) is not accepted$/);
  if (credentialMatch) {
    return localizedError('error.credentialRejected', { path: credentialMatch[1] });
  }
  const gitMatch = message.match(/^(?:Unable to execute Git:|Git command failed with status) (.+)$/);
  if (gitMatch) return localizedError('error.gitUnavailable', { reason: gitMatch[1] });
  const runningMatch = message.match(/^Mission (.+) already has a running operation\.$/);
  if (runningMatch) {
    return localizedError('error.missionAlreadyRunning', { missionId: runningMatch[1] });
  }
  const runtimeMatch = message.match(/^(.+) is not ready for Mission execution: (.+)$/);
  if (runtimeMatch) {
    return localizedError('error.runtimeNotReady', {
      harness: runtimeMatch[1],
      reason: runtimeMatch[2],
    });
  }
  if (message) {
    return invalidMissionDraft
      ? localizedError('error.invalidMissionDraft', { detail: message })
      : new Error(message);
  }
  return localizedError('error.requestFailedStatus', { status: status });
}

async function requestJson(path, options) {
  const requestOptions = options || {};
  const headers = new Headers(requestOptions.headers || {});
  headers.set('Accept', 'application/json');
  if (requestOptions.body !== undefined) headers.set('Content-Type', 'application/json');
  let response;
  try {
    response = await fetch(path, {
      method: requestOptions.method || 'GET',
      headers: headers,
      body: requestOptions.body,
      signal: requestOptions.signal,
    });
  } catch (_error) {
    setConnection(false, 'connection.disconnected');
    throw localizedError('error.cannotConnect');
  }

  let payload = null;
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    payload = await response.json().catch(function () {
      return null;
    });
  } else {
    const text = await response.text();
    payload = text ? { message: text } : null;
  }

  if (!response.ok) {
    throw responseError(payload, response.status);
  }
  setConnection(true, 'connection.connected');
  return payload;
}

function arrayFromPayload(payload, key) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload[key])) return payload[key];
  return [];
}

function missionProjection(value) {
  if (!value || typeof value !== 'object') return null;
  let candidate = value;
  for (let depth = 0; depth < 3; depth += 1) {
    if (typeof candidate.missionId === 'string') return candidate;
    if (!candidate.mission || typeof candidate.mission !== 'object') return candidate;
    candidate = candidate.mission;
  }
  return candidate;
}

function missionIdOf(value) {
  const mission = missionProjection(value);
  return mission && typeof mission.missionId === 'string' ? mission.missionId : null;
}

function missionStatusOf(value) {
  const mission = missionProjection(value);
  return mission && typeof mission.status === 'string' ? mission.status : 'pending';
}

function statusBadge(status) {
  const key = STATUS_LABEL_KEYS[status];
  const label = key ? t(key) : status || t('mission.status.unknown');
  return createElement('span', 'status-badge is-' + String(status || 'unknown'), label);
}

function runtimeCardClass(entry) {
  if (entry.status === 'ready-supported') return 'runtime-card is-ready';
  if (entry.status === 'installed-unavailable' || entry.status === 'needs-bootstrap') {
    return 'runtime-card is-unavailable';
  }
  if (entry.status === 'installed-unsupported') return 'runtime-card is-unsupported';
  return 'runtime-card';
}

function renderRuntimeCapabilities(entry) {
  const declarations = recordValue(entry.capabilityDeclarations) || {};
  const section = createElement('section', 'runtime-capabilities');
  section.setAttribute('aria-label', t('runtime.capabilitiesHeading'));
  const heading = createElement(
    'p',
    'runtime-capabilities-heading',
    t('runtime.capabilitiesHeading'),
  );
  const grid = createElement('div', 'runtime-capability-grid');
  RUNTIME_CAPABILITY_FIELDS.forEach(function (field) {
    const declaration = recordValue(declarations[field[0]]);
    const status =
      declaration && RUNTIME_CAPABILITY_STATUS_KEYS[declaration.status]
        ? declaration.status
        : 'unknown';
    const control =
      declaration && RUNTIME_CAPABILITY_CONTROL_KEYS[declaration.control]
        ? declaration.control
        : 'unknown';
    const item = createElement('div', 'runtime-capability-item');
    if (declaration && typeof declaration.detail === 'string') {
      item.title = declaration.detail;
    }
    const name = createElement('span', 'runtime-capability-name', t(field[1]));
    const stateLabel = createElement(
      'span',
      'runtime-capability-state is-' + status,
      t(RUNTIME_CAPABILITY_STATUS_KEYS[status]),
    );
    const controlLabel = createElement(
      'span',
      'runtime-capability-control',
      t(RUNTIME_CAPABILITY_CONTROL_KEYS[control]),
    );
    item.append(name, stateLabel, controlLabel);
    grid.append(item);
  });
  section.append(heading, grid);
  return section;
}

function renderRuntimes() {
  elements.runtimeList.setAttribute('aria-busy', state.runtimesLoading ? 'true' : 'false');
  if (state.runtimesLoading) {
    replaceWithMessage(elements.runtimeList, 'loading-note', t('runtime.loading'));
    return;
  }
  if (state.runtimes.length === 0) {
    replaceWithMessage(
      elements.runtimeList,
      'empty-note',
      t('runtime.empty'),
    );
    return;
  }
  const fragment = document.createDocumentFragment();
  state.runtimes.forEach(function (entry) {
    const card = createElement('article', runtimeCardClass(entry));
    const head = createElement('div', 'runtime-card-head');
    const name = createElement(
      'span',
      'runtime-name',
      entry.displayName || entry.id || t('runtime.nameFallback'),
    );
    const version = createElement(
      'span',
      'runtime-version',
      entry.version || t('runtime.versionFallback'),
    );
    head.append(name, version);
    const stateLabel = createElement(
      'span',
      'runtime-state',
      RUNTIME_STATUS_LABEL_KEYS[entry.status]
        ? t(RUNTIME_STATUS_LABEL_KEYS[entry.status])
        : entry.reason || t('runtime.stateFallback'),
    );
    card.append(head, stateLabel);
    if (entry.path) {
      const path = createElement('p', 'runtime-path', entry.path);
      path.title = String(entry.path);
      card.append(path);
    }
    card.append(renderRuntimeCapabilities(entry));
    fragment.append(card);
  });
  elements.runtimeList.replaceChildren(fragment);
}

async function loadRuntimes() {
  state.runtimesLoading = true;
  elements.runtimeList.setAttribute('aria-busy', 'true');
  elements.refreshRuntimes.disabled = true;
  try {
    const payload = await requestJson('/api/v1/runtimes');
    state.runtimes = arrayFromPayload(payload, 'runtimes');
    state.runtimesLoading = false;
    renderRuntimes();
  } catch (error) {
    state.runtimesLoading = false;
    replaceWithMessage(
      elements.runtimeList,
      'empty-note',
      messageText(errorMessage(error, 'error.cannotConnect')),
    );
  } finally {
    state.runtimesLoading = false;
    elements.runtimeList.setAttribute('aria-busy', 'false');
    elements.refreshRuntimes.disabled = false;
  }
}

function renderMissionList() {
  elements.missionList.setAttribute('aria-busy', state.missionsLoading ? 'true' : 'false');
  if (state.missionsLoading) {
    replaceWithMessage(elements.missionList, 'empty-note', t('mission.loading'));
    return;
  }
  if (state.missions.length === 0) {
    replaceWithMessage(elements.missionList, 'empty-note', t('mission.empty'));
    return;
  }
  const fragment = document.createDocumentFragment();
  state.missions.forEach(function (entry) {
    const mission = missionProjection(entry);
    if (!mission) return;
    const missionId = missionIdOf(mission);
    if (!missionId) return;
    const button = createElement(
      'button',
      'mission-list-button' + (state.selectedMissionId === missionId ? ' is-selected' : ''),
    );
    button.type = 'button';
    button.dataset.missionId = missionId;
    button.setAttribute('aria-pressed', state.selectedMissionId === missionId ? 'true' : 'false');
    const title = createElement(
      'span',
      'mission-list-title',
      mission.title || t('mission.untitled'),
    );
    const meta = createElement('span', 'mission-list-meta');
    const shortId = createElement('span', 'mission-list-id', compactId(missionId));
    meta.append(shortId, statusBadge(mission.status));
    button.append(title, meta);
    button.addEventListener('click', function () {
      selectMission(missionId);
    });
    fragment.append(button);
  });
  elements.missionList.replaceChildren(fragment);
}

async function loadMissions(options) {
  if (state.missionsLoading) return;
  state.missionsLoading = true;
  const quiet = options && options.quiet;
  if (!quiet) elements.missionList.setAttribute('aria-busy', 'true');
  try {
    const payload = await requestJson('/api/v1/missions');
    state.missions = arrayFromPayload(payload, 'missions');
    if (
      state.selectedMissionId &&
      !state.missions.some(function (entry) {
        return missionIdOf(entry) === state.selectedMissionId;
      })
    ) {
      state.selectedMissionId = null;
      state.detail = null;
    }
    state.missionsLoading = false;
    renderMissionList();
  } catch (error) {
    state.missionsLoading = false;
    if (!quiet) {
      replaceWithMessage(
        elements.missionList,
        'empty-note',
        messageText(errorMessage(error, 'error.cannotConnect')),
      );
    }
  } finally {
    state.missionsLoading = false;
    elements.missionList.setAttribute('aria-busy', 'false');
  }
}

function compactId(value) {
  if (typeof value !== 'string') return '—';
  if (value.length <= 20) return value;
  return value.slice(0, 10) + '…' + value.slice(-7);
}

function formatTime(value) {
  if (typeof value !== 'string') return t('common.unknownTime');
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(state.locale, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}

function timelineMarker(category) {
  const markers = {
    mission: 'M',
    profile: 'P',
    attempt: 'A',
    checkpoint: 'C',
    handoff: 'H',
    effect: 'E',
    verification: 'V',
    receipt: 'R',
    failure: '!',
    runtime: '·',
  };
  return markers[category] || '·';
}

function timelineLabel(entry) {
  const key = KIND_LABEL_KEYS[entry.kind];
  return key ? t(key) : entry.label || entry.kind || t('timeline.recordFallback');
}

function timelineDescription(entry) {
  const data = entry && entry.data && typeof entry.data === 'object' ? entry.data : {};
  if (entry.kind === 'branch.created') {
    return t('timeline.description.branchCreated', {
      branchId: data.branchId || t('intelligence.unknown'),
    });
  }
  if (entry.kind === 'runtime.catalog_observed') {
    return t('timeline.description.catalogObserved', {
      harness: data.harness || entry.harness || t('runtime.nameFallback'),
      availability: data.availability || t('intelligence.unknown'),
    });
  }
  if (entry.kind === 'profile.definition_recorded') {
    return t('timeline.description.profileDefinitionRecorded', {
      harness: data.harness || entry.harness || t('runtime.nameFallback'),
    });
  }
  if (entry.kind === 'attempt.bound') {
    return t('timeline.description.attemptBound', {
      attemptId: data.attemptId || entry.attemptId || t('intelligence.unknown'),
    });
  }
  if (entry.kind === 'runtime.event') {
    return t('timeline.description.runtimeEvent', {
      harness: data.sourceHarness || entry.harness || t('runtime.nameFallback'),
      sourceSequence: data.sourceSequence ?? t('intelligence.unknown'),
      semanticKind: data.semanticKind || t('intelligence.unknown'),
      nativeEventType: data.nativeEventType || t('intelligence.unknown'),
    });
  }
  if (entry.kind === 'runtime.effective_profile_reported') {
    return t('timeline.description.effectiveProfileReported', {
      harness: entry.harness || t('runtime.nameFallback'),
      model: data.observedModel || data.requestedModel || t('intelligence.unknown'),
    });
  }
  if (entry.kind === 'command.accepted') {
    return t('timeline.description.commandAccepted', {
      action: data.action || t('intelligence.unknown'),
    });
  }
  if (entry.kind === 'command.status_changed') {
    return t('timeline.description.commandStatus', {
      status: data.status || t('intelligence.unknown'),
    });
  }
  if (entry.kind === 'attempt.started') {
    return t('timeline.description.attemptStarted', {
      harness: entry.harness || t('runtime.nameFallback'),
    });
  }
  if (entry.kind === 'attempt.finished') {
    return typeof data.summary === 'string'
      ? data.summary
      : t('timeline.description.attemptFinished');
  }
  if (entry.kind === 'profile.selected') {
    const model = typeof data.model === 'string' ? data.model : t('timeline.defaultModel');
    return t('timeline.description.profileSelected', {
      harness: entry.harness || t('runtime.nameFallback'),
      model: model,
    });
  }
  if (entry.kind === 'checkpoint.created') {
    return t('timeline.description.checkpointCreated');
  }
  if (entry.kind === 'handoff.prepared') {
    return t('timeline.description.handoffPrepared');
  }
  if (entry.kind === 'handoff.acknowledged') {
    if (data.handoffOrderingEstablished === false || data.beforeMutation === false) {
      return t('timeline.description.handoffAcknowledgedLate');
    }
    return data.orderingEvidence === 'native-source-before-tool-request'
      ? t('timeline.description.handoffAcknowledgedNativeOrder')
      : t('timeline.description.handoffAcknowledged');
  }
  if (entry.kind === 'effect.recorded') {
    return t('timeline.description.effectRecorded');
  }
  if (entry.kind === 'effect.status_changed') {
    return t('timeline.description.effectStatus', {
      status: data.status || t('common.unknown'),
    });
  }
  if (entry.kind === 'verification.completed') {
    return data.passed === true
      ? t('timeline.description.verificationPassed')
      : t('timeline.description.verificationFailed');
  }
  if (entry.kind === 'receipt.issued') {
    return data.outcome === 'verified'
      ? t('timeline.description.receiptVerified')
      : t('timeline.description.receiptOther');
  }
  if (entry.kind === 'failure.observed') {
    return t('timeline.description.failureObserved');
  }
  if (entry.kind === 'runtime.process_started') {
    return t('timeline.description.runtimeStarted');
  }
  if (entry.kind === 'runtime.process_finished') {
    return t('timeline.description.runtimeFinished');
  }
  return t('timeline.description.kernelFallback');
}

function safeJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch (_error) {
    return t('timeline.unserializable');
  }
}

function recordValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function displayValue(value) {
  if (value === undefined || value === null || value === '') return t('intelligence.unknown');
  if (Array.isArray(value)) {
    return value.length === 0 ? t('intelligence.unknown') : value.map(displayValue).join(', ');
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch (_error) {
      return t('intelligence.unknown');
    }
  }
  return String(value);
}

function runtimeFieldValue(value) {
  const field = recordValue(value);
  if (!field || typeof field.status !== 'string') return displayValue(value);
  if (field.status === 'known') {
    return t('intelligence.known', { value: displayValue(field.value) });
  }
  if (field.status === 'partial') {
    const partial = t('intelligence.partial', { value: displayValue(field.value) });
    return field.reason ? partial + ' · ' + String(field.reason) : partial;
  }
  const label = t(
    field.status === 'unsupported' ? 'intelligence.unsupported' : 'intelligence.unknown',
  );
  return field.reason ? label + ' · ' + String(field.reason) : label;
}

function effectiveProfileListValue(value) {
  if (Array.isArray(value)) {
    return value.length === 0 ? t('intelligence.none') : value.map(displayValue).join(', ');
  }
  return runtimeFieldValue(value);
}

function booleanValue(value) {
  if (value === true) return t('common.yes');
  if (value === false) return t('common.no');
  return runtimeFieldValue(value);
}

function renderNativeArtifactPayload(viewer, payload, artifactId, trigger) {
  const record = recordValue(payload) || {};
  const header = createElement('div', 'native-artifact-viewer-header');
  const title = createElement('strong', '', t('artifact.heading'));
  const close = createElement('button', 'native-artifact-close', t('artifact.close'));
  close.type = 'button';
  close.addEventListener('click', function () {
    viewer.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
  });
  header.append(title, close);
  const meta = createElement(
    'p',
    'native-artifact-meta',
    artifactId +
      ' · ' +
      t('artifact.mediaType') +
      ' ' +
      displayValue(record.mediaType) +
      ' · ' +
      t('artifact.sha256') +
      ' ' +
      displayValue(record.sha256),
  );
  const content =
    typeof record.content === 'string' ? record.content : safeJson(record.content ?? record);
  const pre = createElement('pre', '', content);
  viewer.replaceChildren(header, meta, pre);
}

function createNativeArtifactButton(artifactId, host) {
  const button = createElement('button', 'native-artifact-button', t('artifact.view'));
  button.type = 'button';
  button.setAttribute('aria-expanded', 'false');
  let viewer = null;
  let loaded = false;
  button.addEventListener('click', async function () {
    if (viewer && loaded) {
      viewer.hidden = !viewer.hidden;
      button.setAttribute('aria-expanded', viewer.hidden ? 'false' : 'true');
      return;
    }
    if (!viewer) {
      viewer = createElement('section', 'native-artifact-viewer');
      viewer.setAttribute('aria-live', 'polite');
      viewer.setAttribute('aria-label', t('artifact.heading'));
      host.append(viewer);
    }
    viewer.hidden = false;
    viewer.replaceChildren(createElement('p', 'loading-note', t('artifact.loading')));
    button.disabled = true;
    button.setAttribute('aria-expanded', 'true');
    try {
      const payload = await requestJson(
        '/api/v1/artifacts/' + encodeURIComponent(artifactId),
      );
      renderNativeArtifactPayload(viewer, payload, artifactId, button);
      loaded = true;
    } catch (error) {
      const descriptor = errorMessage(error, 'artifact.unavailable');
      viewer.replaceChildren(
        createElement('p', 'native-artifact-error', messageText(descriptor)),
      );
    } finally {
      button.disabled = false;
    }
  });
  return button;
}

function renderRuntimeEventFacts(dataValue) {
  const data = recordValue(dataValue) || {};
  const facts = createElement('div', 'runtime-event-facts');
  const artifact = recordValue(data.nativeArtifact);
  const causalParents = Array.isArray(data.causalParentIds) ? data.causalParentIds : [];
  const values = [
    t('intelligence.field.sourceSequence') + ' #' + displayValue(data.sourceSequence),
    t('intelligence.field.causalParent') +
      ' · ' +
      (causalParents.length === 0
        ? t('intelligence.rootSource')
        : displayValue(causalParents)),
    t('intelligence.field.nativeArtifact') +
      ' · ' +
      displayValue(artifact && (artifact.artifactId || artifact.relativePath)),
  ];
  values.forEach(function (value) {
    facts.append(createElement('span', 'runtime-event-fact', value));
  });
  if (artifact && typeof artifact.artifactId === 'string') {
    facts.append(createNativeArtifactButton(artifact.artifactId, facts));
  }
  return facts;
}

function renderTimeline(entries) {
  const list = createElement('ol', 'timeline');
  const sorted = entries.slice().sort(function (left, right) {
    return Number(left.seq || 0) - Number(right.seq || 0);
  });
  sorted.forEach(function (entry) {
    const category = typeof entry.category === 'string' ? entry.category : 'runtime';
    const item = createElement('li', 'timeline-item');
    item.dataset.category = category;
    const marker = createElement('span', 'timeline-marker', timelineMarker(category));
    marker.setAttribute('aria-hidden', 'true');
    const card = createElement('div', 'timeline-card');
    const heading = createElement('div', 'timeline-title-row');
    const title = createElement('span', 'timeline-title', timelineLabel(entry));
    const metaParts = [];
    if (entry.harness) metaParts.push(String(entry.harness));
    if (entry.occurredAt) metaParts.push(formatTime(entry.occurredAt));
    const meta = createElement('span', 'timeline-meta', metaParts.join(' · '));
    heading.append(title, meta);
    const description = createElement('p', 'timeline-description', timelineDescription(entry));
    card.append(heading, description);
    if (entry.kind === 'runtime.event') card.append(renderRuntimeEventFacts(entry.data));
    if (entry.data !== undefined) {
      const details = createElement('details', 'timeline-details');
      const summary = createElement('summary', '', t('timeline.viewKernelRecord'));
      const pre = createElement('pre', '', safeJson(entry.data));
      details.append(summary, pre);
      card.append(details);
    }
    item.append(marker, card);
    list.append(item);
  });
  return list;
}

function timelineRecords(entries, kind, member) {
  return entries.flatMap(function (entry) {
    if (entry.kind !== kind) return [];
    const data = recordValue(entry.data);
    if (!data) return [];
    const nested = member ? recordValue(data[member]) : null;
    const record = nested || data;
    return [
      {
        ...record,
        ...(entry.harness && record.harness === undefined
          ? { harness: entry.harness }
          : {}),
        ...(entry.attemptId && record.attemptId === undefined
          ? { attemptId: entry.attemptId }
          : {}),
      },
    ];
  });
}

function mergeEffectiveProfileReports(records) {
  const reports = new Map();
  records.forEach(function (record, index) {
    const identity =
      record.attemptId || record.profileId || record.sessionId || record.harness || String(index);
    const previous = reports.get(identity) || {};
    const merged = { ...previous };
    Object.entries(record).forEach(function (entry) {
      const key = entry[0];
      const value = entry[1];
      if (value !== undefined && value !== null && value !== '') merged[key] = value;
    });
    if (previous.modelOverride === true || record.modelOverride === true) {
      merged.modelOverride = true;
    }
    reports.set(identity, merged);
  });
  return [...reports.values()];
}

function recordIdentity(record, keys) {
  for (const key of keys) {
    if (typeof record[key] === 'string' && record[key]) return String(record[key]);
  }
  return safeJson(record);
}

function mergeUniqueRecords(records, keys) {
  const unique = new Map();
  records.forEach(function (record) {
    const identity = recordIdentity(record, keys);
    unique.set(identity, { ...(unique.get(identity) || {}), ...record });
  });
  return [...unique.values()];
}

function appendIntelligenceFact(list, labelKey, value) {
  const row = createElement('div', 'intelligence-fact');
  const term = createElement('dt', '', t(labelKey));
  const description = createElement('dd', '', value);
  row.append(term, description);
  list.append(row);
}

function renderIntelligenceCard(options) {
  const card = createElement(
    'section',
    'intelligence-card' + (options.wide ? ' is-wide' : ''),
  );
  const heading = createElement('div', 'intelligence-card-heading');
  const title = createElement('h4', '', t(options.titleKey));
  const count = createElement(
    'span',
    '',
    t(options.records.length === 1 ? 'intelligence.oneRecord' : 'intelligence.recordCount', {
      count: options.records.length,
    }),
  );
  heading.append(title, count);
  card.append(heading);
  if (options.records.length === 0) {
    card.append(createElement('p', 'empty-note', t('intelligence.notRecorded')));
    return card;
  }
  const records = createElement('div', options.eventList ? 'runtime-event-records' : '');
  options.records.forEach(function (record) {
    const item = createElement('article', 'intelligence-record');
    const recordTitle = createElement(
      'p',
      'intelligence-record-title',
      recordIdentity(record, options.identityKeys),
    );
    const facts = createElement('dl', 'intelligence-facts');
    options.facts(record).forEach(function (fact) {
      appendIntelligenceFact(facts, fact[0], fact[1]);
    });
    const details = createElement('details', 'timeline-details');
    const summary = createElement('summary', '', t('intelligence.viewRecord'));
    const pre = createElement('pre', '', safeJson(record));
    details.append(summary, pre);
    item.append(recordTitle, facts, details);
    if (options.artifactAction) {
      const artifact = recordValue(record.nativeArtifact);
      if (artifact && typeof artifact.artifactId === 'string') {
        const actions = createElement('div', 'runtime-event-facts');
        actions.append(createNativeArtifactButton(artifact.artifactId, actions));
        item.append(actions);
      }
    }
    records.append(item);
  });
  card.append(records);
  return card;
}

function artifactReference(record) {
  const artifact = recordValue(record.nativeArtifact);
  if (!artifact) return t('intelligence.unknown');
  return [artifact.artifactId, artifact.relativePath, artifact.sha256]
    .filter(function (value) {
      return typeof value === 'string' && value;
    })
    .join(' · ');
}

function renderRuntimeIntelligence(mission, timeline) {
  const activeProfile = recordValue(mission.activeProfile);
  const branchRecords = mergeUniqueRecords(
    [
      ...timelineRecords(timeline, 'branch.created', 'branch'),
      ...(mission.rootBranchId
        ? [{ branchId: mission.rootBranchId, status: 'active', parentBranchId: null }]
        : []),
    ],
    ['branchId'],
  );
  const definitions = mergeUniqueRecords(
    [
      ...timelineRecords(timeline, 'profile.definition_recorded', 'definition'),
      ...(activeProfile && recordValue(activeProfile.definition)
        ? [recordValue(activeProfile.definition)]
        : []),
    ].filter(Boolean),
    ['definitionId'],
  );
  const snapshots = mergeUniqueRecords(
    [
      ...timelineRecords(timeline, 'mission.created', 'profile'),
      ...timelineRecords(timeline, 'profile.selected', 'profile'),
      ...(activeProfile ? [activeProfile] : []),
    ],
    ['profileId'],
  );
  const observations = mergeUniqueRecords(
    [
      ...timelineRecords(timeline, 'runtime.catalog_observed', 'observation'),
      ...(activeProfile && recordValue(activeProfile.catalogObservation)
        ? [recordValue(activeProfile.catalogObservation)]
        : []),
    ].filter(Boolean),
    ['observationId'],
  );
  const bindings = mergeUniqueRecords(
    timelineRecords(timeline, 'attempt.bound', 'binding'),
    ['bindingId'],
  );
  const effectiveReports = mergeEffectiveProfileReports(
    timelineRecords(timeline, 'runtime.effective_profile_reported'),
  );
  const runtimeEvents = mergeUniqueRecords(
    timelineRecords(timeline, 'runtime.event', 'event'),
    ['runtimeEventId'],
  );

  const section = createElement('section', 'runtime-intelligence');
  const heading = createElement('div', 'intelligence-heading');
  const eyebrow = createElement('p', 'eyebrow', t('intelligence.eyebrow'));
  const title = createElement('h3', '', t('intelligence.heading'));
  heading.append(eyebrow, title);
  const grid = createElement('div', 'intelligence-grid');
  grid.append(
    renderIntelligenceCard({
      titleKey: 'intelligence.rootBranch',
      records: branchRecords,
      identityKeys: ['branchId'],
      facts: function (record) {
        return [
          ['intelligence.field.id', displayValue(record.branchId)],
          ['intelligence.field.status', displayValue(record.status)],
          ['intelligence.field.parent', displayValue(record.parentBranchId)],
        ];
      },
    }),
    renderIntelligenceCard({
      titleKey: 'intelligence.profileDefinitions',
      records: definitions,
      identityKeys: ['definitionId', 'harness'],
      facts: function (record) {
        return [
          ['intelligence.field.harness', displayValue(record.harness)],
          ['intelligence.field.requestedModel', displayValue(record.requestedModel)],
          ['intelligence.field.reasoning', displayValue(record.requestedReasoningEffort)],
          ['intelligence.field.permission', displayValue(record.permissionCeiling)],
          ['intelligence.field.budget', displayValue(record.injectionBudgetTokens)],
        ];
      },
    }),
    renderIntelligenceCard({
      titleKey: 'intelligence.profileSnapshots',
      records: snapshots,
      identityKeys: ['profileId', 'harness'],
      facts: function (record) {
        const effective = recordValue(record.effective) || {};
        return [
          ['intelligence.field.harness', displayValue(record.harness)],
          [
            'intelligence.field.effectiveModel',
            runtimeFieldValue(effective.model || record.model),
          ],
          [
            'intelligence.field.reasoning',
            runtimeFieldValue(effective.reasoningEffort || record.reasoningEffort),
          ],
          [
            'intelligence.field.effectivePermissions',
            runtimeFieldValue(effective.permissions || record.permissionMode),
          ],
          ['intelligence.field.instructions', runtimeFieldValue(effective.instructions)],
          ['intelligence.field.skills', runtimeFieldValue(effective.skills)],
          ['intelligence.field.mcpServers', runtimeFieldValue(effective.mcpServers)],
          ['intelligence.field.tools', runtimeFieldValue(effective.tools)],
          ['intelligence.field.contextWindow', runtimeFieldValue(effective.contextWindowTokens)],
          ['intelligence.field.session', runtimeFieldValue(effective.session)],
          ['intelligence.field.availability', runtimeFieldValue(effective.availability)],
          ['intelligence.field.quota', runtimeFieldValue(effective.quota)],
          ['intelligence.field.cost', runtimeFieldValue(effective.cost)],
          ['intelligence.field.version', displayValue(record.runtimeVersion)],
          ['intelligence.field.digest', displayValue(record.configurationDigest)],
        ];
      },
    }),
    renderIntelligenceCard({
      titleKey: 'intelligence.catalogObservations',
      records: observations,
      identityKeys: ['observationId', 'harness'],
      facts: function (record) {
        return [
          ['intelligence.field.harness', displayValue(record.harness)],
          ['intelligence.field.availability', displayValue(record.availability)],
          ['intelligence.field.version', displayValue(record.version)],
          ['intelligence.field.authentication', runtimeFieldValue(record.authentication)],
          ['intelligence.field.quota', runtimeFieldValue(record.quota)],
          ['intelligence.field.cost', runtimeFieldValue(record.cost)],
          ['intelligence.field.observedAt', displayValue(record.observedAt)],
        ];
      },
    }),
    renderIntelligenceCard({
      titleKey: 'intelligence.attemptBindings',
      records: bindings,
      identityKeys: ['bindingId', 'attemptId'],
      facts: function (record) {
        return [
          ['intelligence.field.attempt', displayValue(record.attemptId)],
          ['intelligence.field.branch', displayValue(record.branchId)],
          ['intelligence.field.profile', displayValue(record.profileId)],
          ['intelligence.field.contract', displayValue(record.contractId)],
          ['intelligence.field.planNode', displayValue(record.planNodeId)],
          ['intelligence.field.authority', displayValue(record.authority)],
          ['intelligence.field.budget', displayValue(record.injectionBudgetTokens)],
        ];
      },
    }),
    renderIntelligenceCard({
      titleKey: 'intelligence.effectiveProfileReports',
      records: effectiveReports,
      identityKeys: ['attemptId', 'sessionId', 'profileId', 'harness'],
      wide: true,
      facts: function (record) {
        return [
          ['intelligence.field.harness', displayValue(record.harness)],
          ['intelligence.field.attempt', displayValue(record.attemptId)],
          ['intelligence.field.requestedModel', runtimeFieldValue(record.requestedModel)],
          ['intelligence.field.effectiveModel', runtimeFieldValue(record.observedModel)],
          ['intelligence.field.modelOverride', booleanValue(record.modelOverride)],
          ['intelligence.field.reasoning', runtimeFieldValue(record.reasoningEffort)],
          ['intelligence.field.effectivePermissions', runtimeFieldValue(record.permissionMode)],
          ['intelligence.field.skills', effectiveProfileListValue(record.skills)],
          ['intelligence.field.mcpServers', effectiveProfileListValue(record.mcpServers)],
          ['intelligence.field.contextWindow', runtimeFieldValue(record.contextWindowTokens)],
          ['intelligence.field.session', runtimeFieldValue(record.sessionId)],
          ['intelligence.field.tools', effectiveProfileListValue(record.tools)],
          ['intelligence.field.cost', runtimeFieldValue(record.costUsd)],
          ['intelligence.field.version', runtimeFieldValue(record.runtimeVersion)],
        ];
      },
    }),
    renderIntelligenceCard({
      titleKey: 'intelligence.runtimeEvents',
      records: runtimeEvents,
      identityKeys: ['runtimeEventId', 'sourceId'],
      wide: true,
      eventList: true,
      artifactAction: true,
      facts: function (record) {
        const causalParents = Array.isArray(record.causalParentIds)
          ? record.causalParentIds
          : [];
        return [
          ['intelligence.field.harness', displayValue(record.sourceHarness)],
          ['intelligence.field.semanticKind', displayValue(record.semanticKind)],
          ['intelligence.field.nativeType', displayValue(record.nativeEventType)],
          ['intelligence.field.sourceSequence', displayValue(record.sourceSequence)],
          [
            'intelligence.field.causalParent',
            causalParents.length === 0
              ? t('intelligence.rootSource')
              : displayValue(causalParents),
          ],
          ['intelligence.field.nativeArtifact', artifactReference(record)],
        ];
      },
    }),
  );
  section.append(heading, grid);
  return section;
}

function receiptFromDetail(detail, mission) {
  if (detail && detail.receipt && typeof detail.receipt === 'object') return detail.receipt;
  if (mission && mission.receipt && typeof mission.receipt === 'object') return mission.receipt;
  return null;
}

function renderReceipt(receipt) {
  const rejected = receipt.outcome !== 'verified';
  const card = createElement('section', 'receipt-card' + (rejected ? ' is-rejected' : ''));
  card.setAttribute('aria-label', t('receipt.ariaLabel'));
  const heading = createElement('div', 'receipt-heading');
  const headingText = createElement('div');
  const eyebrow = createElement('p', 'eyebrow', t('receipt.eyebrow'));
  const outcome = createElement(
    'div',
    'receipt-outcome',
    rejected ? t('receipt.unverified') : t('receipt.verified'),
  );
  const receiptId = createElement(
    'p',
    'receipt-id',
    receipt.receiptId || t('receipt.idFallback'),
  );
  headingText.append(eyebrow, outcome, receiptId);
  heading.append(headingText, statusBadge(rejected ? 'failed' : 'succeeded'));
  card.append(heading);
  const verifications = Array.isArray(receipt.verifications) ? receipt.verifications : [];
  if (verifications.length > 0) {
    const criteria = createElement('div', 'receipt-criteria');
    verifications.forEach(function (verification) {
      const row = createElement('div', 'criterion-row');
      const name = createElement(
        'span',
        '',
        verification.criterionId || t('receipt.criterionFallback'),
      );
      const result = createElement(
        'span',
        'criterion-status',
        verification.status === 'passed'
          ? t('receipt.passed')
          : verification.status
            ? String(verification.status)
            : t('receipt.unknown'),
      );
      row.append(name, result);
      criteria.append(row);
    });
    card.append(criteria);
  }
  return card;
}

function timelineFromDetail(detail) {
  if (!detail || typeof detail !== 'object') return [];
  if (Array.isArray(detail.timeline)) return detail.timeline;
  if (Array.isArray(detail.events)) return detail.events;
  return [];
}

function renderDetail() {
  if (!state.detail) {
    replaceWithMessage(elements.missionDetail, 'empty-note', t('mission.detailLoading'));
    return;
  }
  const detail = state.detail;
  const mission = missionProjection(detail);
  if (!mission) {
    replaceWithMessage(elements.missionDetail, 'empty-note', t('mission.detailInvalid'));
    return;
  }
  const missionId = missionIdOf(mission) || state.selectedMissionId || 'mission —';
  const status = missionStatusOf(mission);
  const operationRunning =
    detail.operation &&
    typeof detail.operation === 'object' &&
    detail.operation.phase === 'running';
  const operationQueued =
    detail.operation &&
    typeof detail.operation === 'object' &&
    detail.operation.phase === 'queued';
  const operationInterrupted =
    detail.operation &&
    typeof detail.operation === 'object' &&
    (detail.operation.phase === 'failed' || detail.operation.phase === 'interrupted');
  const visibleStatus = operationRunning
    ? 'running'
    : operationQueued
      ? 'queued'
      : operationInterrupted
        ? 'interrupted'
        : status;
  const contract = mission.contract && typeof mission.contract === 'object' ? mission.contract : {};
  const objective =
    typeof contract.objective === 'string'
      ? contract.objective
      : typeof mission.objective === 'string'
        ? mission.objective
        : t('mission.objectiveMissing');
  const content = createElement('div', 'detail-content');
  const hero = createElement('header', 'detail-hero');
  const titleRow = createElement('div', 'detail-title-row');
  const titleBlock = createElement('div');
  const eyebrow = createElement('p', 'eyebrow', t('mission.authoritativeEyebrow'));
  const title = createElement('h2', '', mission.title || t('mission.untitled'));
  title.id = 'mission-detail-heading';
  const id = createElement('p', 'mission-id', missionId);
  titleBlock.append(eyebrow, title, id);
  titleRow.append(titleBlock, statusBadge(visibleStatus));
  const objectiveNode = createElement('p', 'mission-objective', objective);
  const actions = createElement('div', 'detail-actions');
  const resume = createElement(
    'button',
    'action-button',
    status === 'pending' ? t('mission.start') : t('mission.continue'),
  );
  resume.type = 'button';
  resume.disabled =
    operationRunning ||
    operationQueued ||
    (!operationInterrupted && status !== 'pending' && status !== 'waiting');
  resume.addEventListener('click', function () {
    runMissionAction('resume', resume);
  });
  const verify = createElement('button', 'action-button', t('mission.reverify'));
  verify.type = 'button';
  verify.disabled =
    operationRunning ||
    operationQueued ||
    status === 'pending' ||
    status === 'queued' ||
    status === 'running' ||
    status === 'verifying';
  verify.addEventListener('click', function () {
    runMissionAction('verify', verify);
  });
  actions.append(resume, verify);
  hero.append(titleRow, objectiveNode);
  if (operationInterrupted) {
    hero.append(
      createElement(
        'p',
        'operation-note',
        detail.operation.phase === 'failed'
          ? t('mission.lastRunFailed', {
              error: detail.operation.error || t('mission.lastRunErrorFallback'),
            })
          : t('mission.controllerInterrupted'),
      ),
    );
  }
  if (operationQueued || status === 'queued') {
    hero.append(createElement('p', 'operation-note', t('mission.commandQueued')));
  }
  hero.append(actions);

  const timeline = timelineFromDetail(detail);
  const timelineSection = createElement('section', 'timeline-section');
  const timelineHeading = createElement('div', 'timeline-section-heading');
  const timelineHeadingText = createElement('div');
  const timelineEyebrow = createElement('p', 'eyebrow', t('timeline.eyebrow'));
  const timelineTitle = createElement('h3', '', t('timeline.heading'));
  timelineHeadingText.append(timelineEyebrow, timelineTitle);
  const count = createElement(
    'span',
    'timeline-count',
    t(timeline.length === 1 ? 'timeline.oneEvent' : 'timeline.manyEvents', {
      count: timeline.length,
    }),
  );
  timelineHeading.append(timelineHeadingText, count);
  timelineSection.append(timelineHeading);
  if (timeline.length === 0) {
    timelineSection.append(
      createElement(
        'p',
        'empty-note',
        status === 'pending'
          ? t('timeline.pending')
          : t('timeline.empty'),
      ),
    );
  } else {
    timelineSection.append(renderTimeline(timeline));
  }
  const receipt = receiptFromDetail(detail, mission);
  if (receipt) timelineSection.append(renderReceipt(receipt));
  content.append(hero, renderRuntimeIntelligence(mission, timeline), timelineSection);
  elements.missionDetail.replaceChildren(content);
}

async function loadDetail(missionId, options) {
  if (!missionId || state.detailLoading) return;
  state.detailLoading = true;
  const quiet = options && options.quiet;
  if (!quiet) {
    replaceWithMessage(elements.missionDetail, 'empty-note', t('mission.detailLoading'));
  }
  try {
    state.detail = await requestJson('/api/v1/missions/' + encodeURIComponent(missionId));
    state.detailLoading = false;
    if (state.selectedMissionId === missionId) renderDetail();
  } catch (error) {
    state.detailLoading = false;
    if (!quiet && state.selectedMissionId === missionId) {
      replaceWithMessage(
        elements.missionDetail,
        'empty-note',
        messageText(errorMessage(error, 'error.cannotConnect')),
      );
    }
  } finally {
    state.detailLoading = false;
  }
}

function selectMission(missionId) {
  state.selectedMissionId = missionId;
  state.detail = null;
  renderMissionList();
  loadDetail(missionId);
}

function routeStages(route) {
  const usesCodex =
    route === 'codex' || route === 'codex-qoder' || route === 'codex-qoder-claude';
  const usesQoder =
    route === 'qoder' || route === 'codex-qoder' || route === 'codex-qoder-claude';
  const usesClaude = route === 'claude' || route === 'codex-qoder-claude';
  const codexModel = usesCodex
    ? requiredValue('#codex-model', 'validation.codexModelRequired')
    : '';
  const codexReasoning = usesCodex
    ? requiredValue('#codex-reasoning', 'validation.codexReasoningRequired')
    : '';
  const qoderModel = usesQoder
    ? requiredValue('#qoder-model', 'validation.qoderModelRequired')
    : '';
  const qoderReasoning = usesQoder
    ? requiredValue('#qoder-reasoning', 'validation.qoderReasoningRequired')
    : '';
  const claudeModel = usesClaude
    ? requiredValue('#claude-model', 'validation.claudeModelRequired')
    : '';
  const claudeReasoning = usesClaude
    ? requiredValue('#claude-reasoning', 'validation.claudeReasoningRequired')
    : '';
  const codex = {
    stageId: 'codex-primary',
    harness: 'codex',
    model: codexModel,
    reasoningEffort: codexReasoning,
    permissionMode: 'workspace-write',
    injectionBudgetTokens: 1600,
  };
  const qoder = {
    stageId: 'qoder-continuation',
    harness: 'qoder',
    model: qoderModel,
    reasoningEffort: qoderReasoning,
    permissionMode: 'bypass_permissions',
    injectionBudgetTokens: 1600,
  };
  const claude = {
    stageId: 'claude-continuation',
    harness: 'claude',
    model: claudeModel,
    reasoningEffort: claudeReasoning,
    permissionMode: 'bypassPermissions',
    injectionBudgetTokens: 1600,
  };
  if (route === 'codex') return [codex];
  if (route === 'qoder') {
    return [
      {
        stageId: 'qoder-primary',
        harness: qoder.harness,
        model: qoder.model,
        reasoningEffort: qoder.reasoningEffort,
        permissionMode: qoder.permissionMode,
        injectionBudgetTokens: qoder.injectionBudgetTokens,
      },
    ];
  }
  if (route === 'claude') {
    return [
      {
        stageId: 'claude-primary',
        harness: claude.harness,
        model: claude.model,
        reasoningEffort: claude.reasoningEffort,
        permissionMode: claude.permissionMode,
        injectionBudgetTokens: claude.injectionBudgetTokens,
      },
    ];
  }
  if (route === 'codex-qoder-claude') return [codex, qoder, claude];
  return [codex, qoder];
}

function selectedRoute() {
  const checked = elements.form.querySelector('input[name="route"]:checked');
  return checked ? checked.value : 'codex-qoder';
}

function renderRouteSummary() {
  const route = selectedRoute();
  const codexModel = fieldValue('#codex-model') || t('route.modelUnset');
  const codexReasoning = fieldValue('#codex-reasoning') || t('route.reasoningUnset');
  const qoderModel = fieldValue('#qoder-model') || t('route.modelUnset');
  const qoderReasoning = fieldValue('#qoder-reasoning') || t('route.reasoningUnset');
  const claudeModel = fieldValue('#claude-model') || t('route.modelUnset');
  const claudeReasoning = fieldValue('#claude-reasoning') || t('route.reasoningUnset');
  document.querySelectorAll('[data-profile-editor]').forEach(function (editor) {
    const profile = editor.getAttribute('data-profile-editor');
    const visible =
      profile === 'codex'
        ? route === 'codex' || route === 'codex-qoder' || route === 'codex-qoder-claude'
        : profile === 'qoder'
          ? route === 'qoder' || route === 'codex-qoder' || route === 'codex-qoder-claude'
          : route === 'claude' || route === 'codex-qoder-claude';
    editor.hidden = !visible;
  });
  const parts = [];
  if (route === 'codex' || route === 'codex-qoder' || route === 'codex-qoder-claude') {
    parts.push({
      className: 'route-thread route-thread-codex',
      text: 'Codex · ' + codexModel + ' · ' + codexReasoning,
    });
  }
  if (route === 'codex-qoder' || route === 'codex-qoder-claude') {
    parts.push({ className: 'route-arrow', text: '→' });
  }
  if (route === 'qoder' || route === 'codex-qoder' || route === 'codex-qoder-claude') {
    parts.push({
      className: 'route-thread route-thread-qoder',
      text: 'Qoder · ' + qoderModel + ' · ' + qoderReasoning,
    });
  }
  if (route === 'codex-qoder-claude') {
    parts.push({ className: 'route-arrow', text: '→' });
  }
  if (route === 'claude' || route === 'codex-qoder-claude') {
    parts.push({
      className: 'route-thread route-thread-claude',
      text: 'Claude · ' + claudeModel + ' · ' + claudeReasoning,
    });
  }
  const fragment = document.createDocumentFragment();
  parts.forEach(function (part) {
    fragment.append(createElement('span', part.className, part.text));
  });
  elements.routeSummary.replaceChildren(fragment);
}

function renderFormStatus() {
  elements.formStatus.textContent = messageText(state.formMessage);
  elements.formStatus.className =
    'form-status' + (state.formMessageKind ? ' is-' + state.formMessageKind : '');
}

function setFormStatus(message, kind) {
  state.formMessage = message;
  state.formMessageKind = kind || '';
  renderFormStatus();
}

function requiredValue(selector, errorKey) {
  const value = fieldValue(selector);
  if (!value) throw localizedError(errorKey);
  return value;
}

function fieldValue(selector) {
  const field = elements.form.querySelector(selector);
  return field && typeof field.value === 'string' ? field.value.trim() : '';
}

async function submitMission(event) {
  event.preventDefault();
  setFormStatus(null, '');
  elements.createButton.disabled = true;
  try {
    const title = requiredValue('#mission-title', 'validation.titleRequired');
    const objective = requiredValue('#mission-objective', 'validation.objectiveRequired');
    const workspace = requiredValue('#mission-workspace', 'validation.workspaceRequired');
    const executable = requiredValue('#verifier-executable', 'validation.verifierRequired');
    const argsField = elements.form.querySelector('#verifier-args');
    const args = String(argsField ? argsField.value : '')
      .split(/\r?\n/)
      .map(function (argument) {
        return argument.trim();
      })
      .filter(function (argument) {
        return argument.length > 0;
      });
    const route = selectedRoute();
    const payload = {
      title: title,
      objective: objective,
      workspace: workspace,
      constraints: [],
      verifier: {
        executable: executable,
        args: args,
        timeoutMs: 30000,
      },
      stages: routeStages(route),
    };
    setFormStatus(translated('form.creating'), '');
    const response = await requestJson('/api/v1/missions', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    const missionId =
      response && typeof response.missionId === 'string'
        ? response.missionId
        : response && response.mission && typeof response.mission.missionId === 'string'
          ? response.mission.missionId
          : null;
    setFormStatus(translated('form.created'), 'success');
    await loadMissions();
    if (missionId) selectMission(missionId);
  } catch (error) {
    setFormStatus(errorMessage(error, 'form.createFailed'), 'error');
  } finally {
    elements.createButton.disabled = false;
  }
}

async function runMissionAction(action, button) {
  const missionId = state.selectedMissionId;
  if (!missionId) return;
  const actionPath = MISSION_ACTION_PATHS[action];
  if (typeof actionPath !== 'function') return;
  button.disabled = true;
  showPageAlert(null);
  try {
    await requestJson(actionPath(missionId), {
      method: 'POST',
      body: JSON.stringify({}),
    });
    await loadMissions({ quiet: true });
    await loadDetail(missionId, { quiet: true });
  } catch (error) {
    showPageAlert(errorMessage(error, 'error.requestFailedStatus'));
  } finally {
    button.disabled = false;
  }
}

async function refreshSelectedMission() {
  if (document.hidden || !state.selectedMissionId) return;
  await loadMissions({ quiet: true });
  await loadDetail(state.selectedMissionId, { quiet: true });
}

elements.refreshRuntimes.addEventListener('click', loadRuntimes);
elements.refreshMissions.addEventListener('click', function () {
  loadMissions();
  if (state.selectedMissionId) loadDetail(state.selectedMissionId);
});
elements.form.addEventListener('submit', submitMission);
elements.form.querySelectorAll('input[name="route"]').forEach(function (input) {
  input.addEventListener('change', renderRouteSummary);
});
elements.form
  .querySelectorAll(
    '#codex-model, #codex-reasoning, #qoder-model, #qoder-reasoning, #claude-model, #claude-reasoning',
  )
  .forEach(function (input) {
    input.addEventListener('input', renderRouteSummary);
    input.addEventListener('change', renderRouteSummary);
  });

elements.languageButtons.forEach(function (button) {
  button.addEventListener('click', function () {
    applyLocale(button.getAttribute('data-locale'), { persist: true, rerender: true });
  });
});

applyLocale(state.locale, { persist: false, rerender: false });
renderRouteSummary();
Promise.allSettled([loadRuntimes(), loadMissions()]).then(function () {
  if (!state.selectedMissionId && state.missions.length > 0) {
    const firstMissionId = missionIdOf(state.missions[0]);
    if (firstMissionId) selectMission(firstMissionId);
  }
});
window.setInterval(refreshSelectedMission, 2500);`;
