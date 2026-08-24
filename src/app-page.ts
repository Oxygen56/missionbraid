export const APP_HTML = String.raw`<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <meta name="theme-color" content="#EEF3F8" />
    <title>MissionBraid · 任务编织控制台</title>
    <link rel="stylesheet" href="/app.css" />
  </head>
  <body>
    <a class="skip-link" href="#mission-stage">跳到 Mission 详情</a>
    <div class="app-shell">
      <header class="masthead">
        <div class="brand-lockup">
          <div class="brand-mark" aria-hidden="true">MB</div>
          <div>
            <p class="eyebrow">Mission runtime workbench</p>
            <h1>MissionBraid</h1>
            <p class="brand-subtitle">任务属于 Mission，不属于某个 CLI。</p>
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
          <span class="braid-caption">MISSION CONTINUITY</span>
        </div>

        <div class="connection-state" aria-live="polite">
          <span class="connection-dot" aria-hidden="true"></span>
          <span id="connection-label">正在连接本地控制面</span>
        </div>
      </header>

      <div id="page-alert" class="page-alert" role="alert" hidden></div>

      <section class="runtime-belt" aria-labelledby="runtime-heading">
        <div class="section-heading runtime-heading-row">
          <div>
            <p class="eyebrow">Runtime inventory</p>
            <h2 id="runtime-heading">本机运行环境</h2>
          </div>
          <button id="refresh-runtimes" class="quiet-button" type="button">
            刷新清单
          </button>
        </div>
        <div id="runtime-list" class="runtime-list" aria-live="polite" aria-busy="true">
          <p class="loading-note">正在识别 Codex、Qoder 与其他本机 Harness…</p>
        </div>
      </section>

      <main class="control-grid">
        <aside class="panel mission-index" aria-labelledby="mission-index-heading">
          <div class="panel-heading">
            <div>
              <p class="eyebrow">Mission index</p>
              <h2 id="mission-index-heading">Mission</h2>
            </div>
            <button id="refresh-missions" class="icon-button" type="button" aria-label="刷新 Mission 列表">
              ↻
            </button>
          </div>
          <div id="mission-list" class="mission-list" aria-live="polite" aria-busy="true">
            <p class="empty-note">正在读取 Mission…</p>
          </div>
        </aside>

        <section id="mission-stage" class="panel mission-stage" aria-labelledby="mission-detail-heading">
          <div id="mission-detail" class="mission-detail" aria-live="polite">
            <div class="detail-empty">
              <span class="empty-knot" aria-hidden="true"></span>
              <p class="eyebrow">No mission selected</p>
              <h2 id="mission-detail-heading">让一条任务穿过多个 Runtime</h2>
              <p>
                选择左侧已有 Mission，或在右侧创建一条新 Mission。这里会按真实顺序展示
                Attempt、Capsule、Effect 与 Receipt。
              </p>
            </div>
          </div>
        </section>

        <aside class="panel composer" aria-labelledby="composer-heading">
          <div class="panel-heading composer-heading">
            <div>
              <p class="eyebrow">Compose</p>
              <h2 id="composer-heading">编织新 Mission</h2>
            </div>
            <span class="step-chip">一次提交</span>
          </div>

          <form id="mission-form" novalidate>
            <label class="field">
              <span>标题</span>
              <input
                id="mission-title"
                name="title"
                type="text"
                autocomplete="off"
                placeholder="修复浏览器任务持久化"
                required
              />
            </label>

            <label class="field">
              <span>想得到什么结果</span>
              <textarea
                id="mission-objective"
                name="objective"
                rows="4"
                placeholder="描述最终可验证的代码结果，不必替 Runtime 拆步骤。"
                required
              ></textarea>
            </label>

            <label class="field">
              <span>Git 工作区绝对路径</span>
              <input
                id="mission-workspace"
                name="workspace"
                type="text"
                inputmode="url"
                autocomplete="off"
                spellcheck="false"
                placeholder="/Users/me/project-worktree"
                required
              />
            </label>

            <div class="verifier-block">
              <div class="field-intro">
                <span>完成判据</span>
                <small>控制面会直接执行程序，不经过 Shell。</small>
              </div>
              <label class="field compact-field">
                <span>Executable</span>
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
                <span>Arguments · 一行一个</span>
                <textarea
                  id="verifier-args"
                  name="verifierArgs"
                  rows="3"
                  autocomplete="off"
                  spellcheck="false">test</textarea>
              </label>
            </div>

            <fieldset class="route-fieldset">
              <legend>Runtime 路线</legend>
              <div class="route-options">
                <input id="route-codex" name="route" type="radio" value="codex" />
                <label for="route-codex" class="route-option">
                  <strong>Codex</strong>
                  <small>单一 Attempt</small>
                </label>

                <input id="route-qoder" name="route" type="radio" value="qoder" />
                <label for="route-qoder" class="route-option">
                  <strong>Qoder</strong>
                  <small>单一 Attempt</small>
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
                  <small>计划内 Capsule 接力</small>
                </label>
              </div>
            </fieldset>

            <details class="profile-editor" open>
              <summary>Runtime Profile</summary>
              <p class="profile-editor-note">
                Harness 只是运行器；模型、推理强度和权限共同构成实际执行环境。
              </p>
              <div class="profile-editor-grid">
                <section class="profile-editor-card" data-profile-editor="codex">
                  <div class="profile-editor-heading">
                    <strong>Codex</strong>
                    <span>workspace-write</span>
                  </div>
                  <label class="field compact-field">
                    <span>Model</span>
                    <input id="codex-model" type="text" value="gpt-5.6-sol" />
                  </label>
                  <label class="field compact-field">
                    <span>Reasoning</span>
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
                    <span>Model</span>
                    <input id="qoder-model" type="text" value="Qwen3.8-Max" />
                  </label>
                  <label class="field compact-field">
                    <span>Reasoning</span>
                    <select id="qoder-reasoning">
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
              <span>创建并运行 Mission</span>
              <span aria-hidden="true">↗</span>
            </button>
          </form>
        </aside>
      </main>

      <footer class="page-footer">
        <span>LOCAL CONTROL PLANE</span>
        <span>Mission Kernel 是任务状态的唯一事实源</span>
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
  grid-auto-columns: minmax(190px, 1fr);
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
  grid-template-columns: repeat(3, minmax(0, 1fr));
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

export const APP_JAVASCRIPT = String.raw`const state = {
  runtimes: [],
  missions: [],
  selectedMissionId: null,
  detail: null,
  missionsLoading: false,
  detailLoading: false,
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
};

const STATUS_LABELS = {
  pending: '待运行',
  running: '运行中',
  waiting: '等待继续',
  verifying: '验收中',
  succeeded: '已验证',
  failed: '未通过',
  cancelled: '已取消',
  interrupted: '已中断 · 可继续',
};

const RUNTIME_STATUS_LABELS = {
  'ready-supported': '已就绪 · 可执行 Mission',
  'installed-unavailable': '已安装 · 当前不可用',
  'installed-unsupported': '已发现 · 尚未接入 Mission',
  'needs-bootstrap': '已发现外壳 · 需要启动命令',
  missing: '本机未发现',
};

const MISSION_ACTION_PATHS = {
  resume: function (missionId) {
    return '/api/v1/missions/' + encodeURIComponent(missionId) + '/resume';
  },
  verify: function (missionId) {
    return '/api/v1/missions/' + encodeURIComponent(missionId) + '/verify';
  },
};

const KIND_LABELS = {
  'mission.created': 'Mission 已创建',
  'mission.status_changed': 'Mission 状态更新',
  'profile.selected': 'Runtime Profile 已选择',
  'attempt.started': 'Attempt 已开始',
  'attempt.finished': 'Attempt 已结束',
  'checkpoint.created': 'Checkpoint 已冻结',
  'handoff.prepared': 'Capsule 已准备',
  'handoff.acknowledged': 'Capsule 已确认',
  'handoff.rejected': 'Capsule 被拒绝',
  'effect.recorded': 'Effect 已登记',
  'effect.status_changed': 'Effect 状态更新',
  'runtime.process_started': 'Runtime 进程已启动',
  'runtime.process_finished': 'Runtime 进程已结束',
  'verification.completed': '完成判据已执行',
  'receipt.issued': 'Outcome Receipt 已签发',
  'failure.observed': '已观察到故障',
};

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

function showPageAlert(message) {
  if (!message) {
    elements.pageAlert.hidden = true;
    elements.pageAlert.textContent = '';
    return;
  }
  elements.pageAlert.textContent = message;
  elements.pageAlert.hidden = false;
}

function setConnection(online, message) {
  elements.connection.classList.toggle('is-online', online);
  elements.connectionLabel.textContent = message;
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
    setConnection(false, '本地控制面未连接');
    throw new Error('无法连接本地 MissionBraid 服务。确认 app 服务仍在运行。');
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
    const message =
      payload && typeof payload.message === 'string'
        ? payload.message
        : '请求未完成，服务返回 ' + String(response.status) + '。';
    throw new Error(message);
  }
  setConnection(true, '本地控制面已连接');
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
  const label = STATUS_LABELS[status] || status || '未知';
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

function renderRuntimes() {
  elements.runtimeList.setAttribute('aria-busy', 'false');
  if (state.runtimes.length === 0) {
    replaceWithMessage(
      elements.runtimeList,
      'empty-note',
      '没有发现 Runtime。安装并登录 Codex 或 Qoder 后刷新清单。',
    );
    return;
  }
  const fragment = document.createDocumentFragment();
  state.runtimes.forEach(function (entry) {
    const card = createElement('article', runtimeCardClass(entry));
    const head = createElement('div', 'runtime-card-head');
    const name = createElement('span', 'runtime-name', entry.displayName || entry.id || 'Runtime');
    const version = createElement('span', 'runtime-version', entry.version || 'version —');
    head.append(name, version);
    const stateLabel = createElement(
      'span',
      'runtime-state',
      RUNTIME_STATUS_LABELS[entry.status] || entry.reason || '状态未知',
    );
    card.append(head, stateLabel);
    if (entry.path) {
      const path = createElement('p', 'runtime-path', entry.path);
      path.title = String(entry.path);
      card.append(path);
    }
    fragment.append(card);
  });
  elements.runtimeList.replaceChildren(fragment);
}

async function loadRuntimes() {
  elements.runtimeList.setAttribute('aria-busy', 'true');
  elements.refreshRuntimes.disabled = true;
  try {
    const payload = await requestJson('/api/v1/runtimes');
    state.runtimes = arrayFromPayload(payload, 'runtimes');
    renderRuntimes();
  } catch (error) {
    replaceWithMessage(elements.runtimeList, 'empty-note', error.message);
  } finally {
    elements.runtimeList.setAttribute('aria-busy', 'false');
    elements.refreshRuntimes.disabled = false;
  }
}

function renderMissionList() {
  elements.missionList.setAttribute('aria-busy', 'false');
  if (state.missions.length === 0) {
    replaceWithMessage(
      elements.missionList,
      'empty-note',
      '还没有 Mission。填写创建表单，让第一条任务开始跨 Runtime 流动。',
    );
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
    const title = createElement('span', 'mission-list-title', mission.title || '未命名 Mission');
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
    renderMissionList();
  } catch (error) {
    if (!quiet) replaceWithMessage(elements.missionList, 'empty-note', error.message);
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
  if (typeof value !== 'string') return '时间未知';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
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
  return KIND_LABELS[entry.kind] || entry.label || entry.kind || '运行记录';
}

function timelineDescription(entry) {
  const data = entry && entry.data && typeof entry.data === 'object' ? entry.data : {};
  if (entry.kind === 'attempt.started') {
    return (entry.harness || 'Runtime') + ' 开始执行当前阶段。';
  }
  if (entry.kind === 'attempt.finished') {
    return typeof data.summary === 'string' ? data.summary : '当前 Attempt 已留下可追溯结果。';
  }
  if (entry.kind === 'profile.selected') {
    const model = typeof data.model === 'string' ? data.model : '默认模型';
    return (entry.harness || 'Runtime') + ' 使用 ' + model + ' Profile。';
  }
  if (entry.kind === 'checkpoint.created') {
    return '工作区状态已冻结，后续 Runtime 将从这条可验证边界继续。';
  }
  if (entry.kind === 'handoff.prepared') {
    return '控制面已把目标、约束、工作区摘要和剩余工作投影为 Capsule。';
  }
  if (entry.kind === 'handoff.acknowledged') {
    return data.beforeMutation === false
      ? '目标 Runtime 在修改工作区后才确认 Capsule，连续性条件未满足。'
      : '目标 Runtime 已在修改工作区前确认同一 Capsule。';
  }
  if (entry.kind === 'effect.recorded') {
    return '可变工作区动作已先登记身份，再交给 Runtime 执行。';
  }
  if (entry.kind === 'effect.status_changed') {
    return 'Effect 当前状态：' + String(data.status || '未知') + '。';
  }
  if (entry.kind === 'verification.completed') {
    return data.passed === true ? '原始完成判据已通过。' : '原始完成判据未通过。';
  }
  if (entry.kind === 'receipt.issued') {
    return data.outcome === 'verified'
      ? '所有必要判据和 Effect 状态已闭合。'
      : 'Receipt 保留了未通过或未确定的结果。';
  }
  if (entry.kind === 'failure.observed') {
    return '这里只记录已经观察到的故障，不把推测冒充根因。';
  }
  if (entry.kind === 'runtime.process_started') return '真实 Runtime 进程已经启动。';
  if (entry.kind === 'runtime.process_finished') return '真实 Runtime 进程已经结束。';
  return '这条记录来自 Mission Kernel 的追加事件链。';
}

function safeJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch (_error) {
    return '记录无法序列化';
  }
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
    if (entry.data !== undefined) {
      const details = createElement('details', 'timeline-details');
      const summary = createElement('summary', '', '查看 Kernel 记录');
      const pre = createElement('pre', '', safeJson(entry.data));
      details.append(summary, pre);
      card.append(details);
    }
    item.append(marker, card);
    list.append(item);
  });
  return list;
}

function receiptFromDetail(detail, mission) {
  if (detail && detail.receipt && typeof detail.receipt === 'object') return detail.receipt;
  if (mission && mission.receipt && typeof mission.receipt === 'object') return mission.receipt;
  return null;
}

function renderReceipt(receipt) {
  const rejected = receipt.outcome !== 'verified';
  const card = createElement('section', 'receipt-card' + (rejected ? ' is-rejected' : ''));
  card.setAttribute('aria-label', 'Outcome Receipt');
  const heading = createElement('div', 'receipt-heading');
  const headingText = createElement('div');
  const eyebrow = createElement('p', 'eyebrow', 'Outcome receipt');
  const outcome = createElement(
    'div',
    'receipt-outcome',
    rejected ? '结果未被验证' : '结果已经验证',
  );
  const receiptId = createElement('p', 'receipt-id', receipt.receiptId || 'receipt id —');
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
        verification.criterionId || '未命名完成判据',
      );
      const result = createElement(
        'span',
        'criterion-status',
        verification.status === 'passed' ? 'PASSED' : String(verification.status || 'UNKNOWN'),
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
    replaceWithMessage(elements.missionDetail, 'empty-note', '正在读取 Mission 详情…');
    return;
  }
  const detail = state.detail;
  const mission = missionProjection(detail);
  if (!mission) {
    replaceWithMessage(elements.missionDetail, 'empty-note', 'Mission 详情格式无法识别。');
    return;
  }
  const missionId = missionIdOf(mission) || state.selectedMissionId || 'mission —';
  const status = missionStatusOf(mission);
  const operationRunning =
    detail.operation &&
    typeof detail.operation === 'object' &&
    detail.operation.phase === 'running';
  const operationInterrupted =
    detail.operation &&
    typeof detail.operation === 'object' &&
    (detail.operation.phase === 'failed' || detail.operation.phase === 'interrupted');
  const visibleStatus = operationRunning ? 'running' : operationInterrupted ? 'interrupted' : status;
  const contract = mission.contract && typeof mission.contract === 'object' ? mission.contract : {};
  const objective =
    typeof contract.objective === 'string'
      ? contract.objective
      : typeof mission.objective === 'string'
        ? mission.objective
        : '这条 Mission 没有可显示的目标摘要。';
  const content = createElement('div', 'detail-content');
  const hero = createElement('header', 'detail-hero');
  const titleRow = createElement('div', 'detail-title-row');
  const titleBlock = createElement('div');
  const eyebrow = createElement('p', 'eyebrow', 'Authoritative mission');
  const title = createElement('h2', '', mission.title || '未命名 Mission');
  title.id = 'mission-detail-heading';
  const id = createElement('p', 'mission-id', missionId);
  titleBlock.append(eyebrow, title, id);
  titleRow.append(titleBlock, statusBadge(visibleStatus));
  const objectiveNode = createElement('p', 'mission-objective', objective);
  const actions = createElement('div', 'detail-actions');
  const resume = createElement('button', 'action-button', status === 'pending' ? '开始执行' : '继续 Mission');
  resume.type = 'button';
  resume.disabled =
    operationRunning ||
    (!operationInterrupted && status !== 'pending' && status !== 'waiting');
  resume.addEventListener('click', function () {
    runMissionAction('resume', resume);
  });
  const verify = createElement('button', 'action-button', '重新验收');
  verify.type = 'button';
  verify.disabled =
    operationRunning || status === 'pending' || status === 'running' || status === 'verifying';
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
          ? '上一次执行未完成：' + String(detail.operation.error || '未返回错误摘要')
          : '控制台在 Mission 完成前中断。可从最后一个持久化事件继续。',
      ),
    );
  }
  hero.append(actions);

  const timelineSection = createElement('section', 'timeline-section');
  const timelineHeading = createElement('div', 'timeline-section-heading');
  const timelineHeadingText = createElement('div');
  const timelineEyebrow = createElement('p', 'eyebrow', 'Evidence timeline');
  const timelineTitle = createElement('h3', '', 'Attempt · Capsule · Effect · Receipt');
  timelineHeadingText.append(timelineEyebrow, timelineTitle);
  const timeline = timelineFromDetail(detail);
  const count = createElement('span', 'timeline-count', String(timeline.length) + ' EVENTS');
  timelineHeading.append(timelineHeadingText, count);
  timelineSection.append(timelineHeading);
  if (timeline.length === 0) {
    timelineSection.append(
      createElement(
        'p',
        'empty-note',
        status === 'pending'
          ? 'Mission 已创建，开始执行后这里会出现真实事件。'
          : '当前 API 没有返回可显示的时间线。',
      ),
    );
  } else {
    timelineSection.append(renderTimeline(timeline));
  }
  const receipt = receiptFromDetail(detail, mission);
  if (receipt) timelineSection.append(renderReceipt(receipt));
  content.append(hero, timelineSection);
  elements.missionDetail.replaceChildren(content);
}

async function loadDetail(missionId, options) {
  if (!missionId || state.detailLoading) return;
  state.detailLoading = true;
  const quiet = options && options.quiet;
  if (!quiet) replaceWithMessage(elements.missionDetail, 'empty-note', '正在读取 Mission 详情…');
  try {
    state.detail = await requestJson('/api/v1/missions/' + encodeURIComponent(missionId));
    if (state.selectedMissionId === missionId) renderDetail();
  } catch (error) {
    if (!quiet && state.selectedMissionId === missionId) {
      replaceWithMessage(elements.missionDetail, 'empty-note', error.message);
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
  const usesCodex = route === 'codex' || route === 'codex-qoder';
  const usesQoder = route === 'qoder' || route === 'codex-qoder';
  const codexModel = usesCodex ? requiredValue('#codex-model', 'Codex model') : '';
  const codexReasoning = usesCodex ? requiredValue('#codex-reasoning', 'Codex reasoning') : '';
  const qoderModel = usesQoder ? requiredValue('#qoder-model', 'Qoder model') : '';
  const qoderReasoning = usesQoder ? requiredValue('#qoder-reasoning', 'Qoder reasoning') : '';
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
  return [codex, qoder];
}

function selectedRoute() {
  const checked = elements.form.querySelector('input[name="route"]:checked');
  return checked ? checked.value : 'codex-qoder';
}

function renderRouteSummary() {
  const route = selectedRoute();
  const codexModel = fieldValue('#codex-model') || 'model 未设置';
  const codexReasoning = fieldValue('#codex-reasoning') || 'reasoning 未设置';
  const qoderModel = fieldValue('#qoder-model') || 'model 未设置';
  const qoderReasoning = fieldValue('#qoder-reasoning') || 'reasoning 未设置';
  document.querySelectorAll('[data-profile-editor]').forEach(function (editor) {
    const profile = editor.getAttribute('data-profile-editor');
    editor.hidden =
      profile === 'codex'
        ? route !== 'codex' && route !== 'codex-qoder'
        : route !== 'qoder' && route !== 'codex-qoder';
  });
  const parts = [];
  if (route === 'codex' || route === 'codex-qoder') {
    parts.push({
      className: 'route-thread route-thread-codex',
      text: 'Codex · ' + codexModel + ' · ' + codexReasoning,
    });
  }
  if (route === 'codex-qoder') parts.push({ className: 'route-arrow', text: '→' });
  if (route === 'qoder' || route === 'codex-qoder') {
    parts.push({
      className: 'route-thread route-thread-qoder',
      text: 'Qoder · ' + qoderModel + ' · ' + qoderReasoning,
    });
  }
  const fragment = document.createDocumentFragment();
  parts.forEach(function (part) {
    fragment.append(createElement('span', part.className, part.text));
  });
  elements.routeSummary.replaceChildren(fragment);
}

function setFormStatus(message, kind) {
  elements.formStatus.textContent = message || '';
  elements.formStatus.className = 'form-status' + (kind ? ' is-' + kind : '');
}

function requiredValue(selector, label) {
  const value = fieldValue(selector);
  if (!value) throw new Error(label + '不能为空。');
  return value;
}

function fieldValue(selector) {
  const field = elements.form.querySelector(selector);
  return field && typeof field.value === 'string' ? field.value.trim() : '';
}

async function submitMission(event) {
  event.preventDefault();
  setFormStatus('', '');
  elements.createButton.disabled = true;
  try {
    const title = requiredValue('#mission-title', '标题');
    const objective = requiredValue('#mission-objective', '目标');
    const workspace = requiredValue('#mission-workspace', '工作区路径');
    const executable = requiredValue('#verifier-executable', '验收程序');
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
    setFormStatus('正在创建 Mission，并固定原始完成判据…', '');
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
    setFormStatus('Mission 已创建并开始执行。进度会出现在中间时间线。', 'success');
    await loadMissions();
    if (missionId) selectMission(missionId);
  } catch (error) {
    setFormStatus(error.message || 'Mission 未创建。检查输入后重试。', 'error');
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
  showPageAlert('');
  try {
    await requestJson(actionPath(missionId), {
      method: 'POST',
      body: JSON.stringify({}),
    });
    await loadMissions({ quiet: true });
    await loadDetail(missionId, { quiet: true });
  } catch (error) {
    showPageAlert(error.message);
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
  .querySelectorAll('#codex-model, #codex-reasoning, #qoder-model, #qoder-reasoning')
  .forEach(function (input) {
    input.addEventListener('input', renderRouteSummary);
    input.addEventListener('change', renderRouteSummary);
  });

renderRouteSummary();
Promise.allSettled([loadRuntimes(), loadMissions()]).then(function () {
  if (!state.selectedMissionId && state.missions.length > 0) {
    const firstMissionId = missionIdOf(state.missions[0]);
    if (firstMissionId) selectMission(firstMissionId);
  }
});
window.setInterval(refreshSelectedMission, 2500);`;
