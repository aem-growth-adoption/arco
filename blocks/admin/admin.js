/**
 * Admin Block — session & page browser for the Arco recommender demo.
 *
 * Authenticates against the recommender worker's /api/admin/* endpoints
 * using HTTP Basic Auth (username: admin, password: ADMIN_TOKEN). The token
 * is prompted once and cached in localStorage.
 *
 * Views (hash routing within the block):
 *   #/                    Sessions list
 *   #/sessions/:id        Session detail + pages list
 *   #/pages/:id           Page detail (overview / preview / blocks / debug tabs)
 */

import {
  decorateBlock, decorateButtons, decorateIcons, loadBlock,
} from '../../scripts/aem.js';
import { ARCO_RECOMMENDER_URL } from '../../scripts/api-config.js';

const TOKEN_STORAGE_KEY = 'arco-admin-token';
const BLOCK_ALIASES = {
  'use-case-cards': 'cards',
  'feature-highlights': 'cards',
  text: false,
  'how-to-steps': 'recipe-steps',
};

// ── Helpers ─────────────────────────────────────────────────────────────────

function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function ts(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
}

function dur(ms) {
  if (!ms) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function badge(label, tone = 'neutral') {
  if (!label) return '<span class="admin-badge admin-badge-muted">—</span>';
  return `<span class="admin-badge admin-badge-${tone}">${esc(label)}</span>`;
}

function kv(label, value) {
  const v = value === null || value === undefined || value === '' ? '—' : esc(value);
  return `<div class="admin-kv"><dt>${esc(label)}</dt><dd>${v}</dd></div>`;
}

function intentTone(intent) {
  const map = {
    espresso: 'accent',
    'milk-drinks': 'purple',
    comparison: 'warn',
    grinder: 'ok',
    gift: 'warn',
    beginner: 'ok',
    support: 'muted',
  };
  return map[intent] || 'accent';
}

// ── Auth ────────────────────────────────────────────────────────────────────

function getAdminToken() {
  let token = localStorage.getItem(TOKEN_STORAGE_KEY);
  if (!token) {
    // eslint-disable-next-line no-alert
    token = window.prompt('Admin token (ADMIN_TOKEN secret):');
    if (token) localStorage.setItem(TOKEN_STORAGE_KEY, token);
  }
  return token;
}

function clearAdminToken() {
  localStorage.removeItem(TOKEN_STORAGE_KEY);
}

async function api(path) {
  const token = getAdminToken();
  if (!token) throw new Error('Admin token required');
  const res = await fetch(`${ARCO_RECOMMENDER_URL}${path}`, {
    headers: { Authorization: `Basic ${btoa(`admin:${token}`)}` },
  });
  if (res.status === 401) {
    clearAdminToken();
    throw new Error('Unauthorized — token cleared. Reload to retry.');
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

// ── Routing ─────────────────────────────────────────────────────────────────

function parseRoute() {
  const hash = window.location.hash.replace(/^#/, '') || '/';
  if (hash === '/') return { view: 'sessions' };
  const sessionMatch = hash.match(/^\/sessions\/([^/]+)$/);
  if (sessionMatch) return { view: 'session', id: sessionMatch[1] };
  const pageMatch = hash.match(/^\/pages\/([^/]+)(?:\/(\w+))?$/);
  if (pageMatch) return { view: 'page', id: pageMatch[1], tab: pageMatch[2] || 'overview' };
  return { view: 'sessions' };
}

function navigate(hash) {
  window.location.hash = hash;
}

// ── Sessions list ───────────────────────────────────────────────────────────

async function renderSessions(root) {
  root.innerHTML = '<p class="admin-loading">Loading sessions…</p>';
  let data;
  try {
    data = await api('/api/admin/sessions?limit=100&offset=0');
  } catch (err) {
    root.innerHTML = `<p class="admin-error">${esc(err.message)}</p>`;
    return;
  }

  const sessions = data.sessions || [];
  const total = data.total || 0;

  root.innerHTML = `
    <div class="admin-toolbar">
      <h2>Sessions</h2>
      <div class="admin-stats">
        <span class="admin-stat"><span class="admin-stat-value">${total}</span><span class="admin-stat-label">total</span></span>
      </div>
    </div>
    ${sessions.length === 0
    ? '<p class="admin-empty">No sessions yet. Generate a recommender page first.</p>'
    : `<div class="admin-table-wrap"><table class="admin-table">
        <thead><tr>
          <th>Session</th><th>First seen</th><th>Last active</th>
          <th>Pages</th><th>User agent</th>
        </tr></thead>
        <tbody>${sessions.map((s) => `
          <tr data-href="#/sessions/${esc(s.id)}">
            <td class="admin-mono">${esc(s.id.substring(0, 8))}…</td>
            <td>${ts(s.first_seen)}</td>
            <td>${ts(s.last_seen)}</td>
            <td>${badge(s.page_count, s.page_count > 0 ? 'accent' : 'muted')}</td>
            <td class="admin-ua">${esc((s.user_agent || '').substring(0, 80))}</td>
          </tr>`).join('')}
        </tbody>
      </table></div>`}
  `;

  root.querySelectorAll('tr[data-href]').forEach((tr) => {
    tr.addEventListener('click', () => { navigate(tr.dataset.href); });
  });
}

// ── Session detail ──────────────────────────────────────────────────────────

async function renderSession(root, sessionId) {
  root.innerHTML = '<p class="admin-loading">Loading session…</p>';
  let data;
  try {
    data = await api(`/api/admin/sessions/${sessionId}`);
  } catch (err) {
    root.innerHTML = `<p class="admin-error">${esc(err.message)}</p>`;
    return;
  }

  const s = data.session;
  const pages = data.pages || [];

  root.innerHTML = `
    <nav class="admin-crumbs"><a href="#/">← Sessions</a></nav>
    <div class="admin-toolbar">
      <h2>Session ${esc(s.id.substring(0, 8))}…</h2>
      <div class="admin-stats">
        <span class="admin-stat"><span class="admin-stat-value">${pages.length}</span><span class="admin-stat-label">pages</span></span>
        <span class="admin-stat"><span class="admin-stat-value">${ts(s.first_seen)}</span><span class="admin-stat-label">first seen</span></span>
        <span class="admin-stat"><span class="admin-stat-value">${ts(s.last_seen)}</span><span class="admin-stat-label">last active</span></span>
      </div>
    </div>

    <section class="admin-card">
      <h3>Session info</h3>
      <dl class="admin-kvs">
        ${kv('Session ID', s.id)}
        ${kv('IP hash', s.ip_hash)}
        ${kv('User agent', s.user_agent)}
      </dl>
    </section>

    <section class="admin-card">
      <h3>Generated pages</h3>
      ${pages.length === 0
    ? '<p class="admin-empty">No pages recorded for this session.</p>'
    : `<div class="admin-table-wrap"><table class="admin-table">
          <thead><tr>
            <th>#</th><th>Query</th><th>Intent</th><th>Follow-up</th>
            <th>Blocks</th><th>Duration</th><th>Tokens</th><th>Time</th>
          </tr></thead>
          <tbody>${pages.map((p, i) => `
            <tr data-href="#/pages/${esc(p.id)}">
              <td class="admin-muted">${i + 1}</td>
              <td class="admin-query">${esc(p.query)}</td>
              <td>${badge(p.intent_type, intentTone(p.intent_type))}</td>
              <td>${p.follow_up_type ? badge(p.follow_up_type, 'purple') : '<span class="admin-muted">—</span>'}</td>
              <td>${p.block_count || '—'}</td>
              <td>${dur(p.duration_ms)}</td>
              <td class="admin-muted">${p.input_tokens ? `${p.input_tokens}↑ ${p.output_tokens}↓` : '—'}</td>
              <td class="admin-muted">${ts(p.created_at)}</td>
            </tr>`).join('')}
          </tbody>
        </table></div>`}
    </section>
  `;

  root.querySelectorAll('tr[data-href]').forEach((tr) => {
    tr.addEventListener('click', () => { navigate(tr.dataset.href); });
  });
}

// ── Page reconstruction (live preview) ──────────────────────────────────────

/**
 * Render a stored block payload into a container, mimicking scripts.js's
 * renderStreamedSection so the preview matches the live page.
 */
async function renderStoredSection(blockData, container) {
  const section = document.createElement('div');
  section.className = 'section';
  if (blockData.sectionStyle && blockData.sectionStyle !== 'default') {
    section.classList.add(blockData.sectionStyle);
  }
  section.dataset.sectionStatus = 'initialized';
  section.innerHTML = blockData.html;

  const sectionMeta = section.querySelector('div.section-metadata');
  if (sectionMeta) {
    [...sectionMeta.querySelectorAll(':scope > div')].forEach((row) => {
      const cols = [...row.children];
      if (cols.length >= 2) {
        const key = cols[0].textContent.trim().toLowerCase();
        const val = cols[1].textContent.trim();
        if (key === 'style') {
          val.split(',').filter(Boolean).forEach((style) => {
            section.classList.add(style.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-'));
          });
        } else {
          const camel = key.replace(/[^a-z0-9]+/g, '-').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
          section.dataset[camel] = val;
        }
      }
    });
    sectionMeta.remove();
  }

  const blockEl = section.querySelector('[class]');
  if (blockEl) {
    const origName = blockEl.classList[0];
    const alias = origName in BLOCK_ALIASES ? BLOCK_ALIASES[origName] : origName;
    if (alias === false) {
      blockEl.replaceWith(...blockEl.children);
    } else {
      const blockName = alias;
      if (blockName !== origName) blockEl.classList.replace(origName, blockName);
      const wrapper = document.createElement('div');
      wrapper.className = `${blockName}-wrapper`;
      blockEl.parentNode.insertBefore(wrapper, blockEl);
      wrapper.appendChild(blockEl);
      decorateBlock(blockEl);
      section.classList.add(`${blockName}-container`);
    }
  }

  decorateButtons(section);
  decorateIcons(section);
  container.appendChild(section);

  const block = section.querySelector('.block');
  if (block) {
    try {
      await loadBlock(block);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('Failed to load block:', err);
    }
  }
  section.dataset.sectionStatus = 'loaded';
}

async function renderLivePreview(container, payload) {
  container.innerHTML = '<p class="admin-loading">Reconstructing page…</p>';
  const stage = document.createElement('div');
  stage.className = 'admin-preview-stage';
  const main = document.createElement('main');
  main.className = 'admin-preview-main';
  stage.appendChild(main);
  container.innerHTML = '';
  container.appendChild(stage);

  const blocks = payload?.blocks || [];
  if (blocks.length === 0) {
    main.innerHTML = '<p class="admin-empty">No blocks stored for this page.</p>';
    return;
  }

  // eslint-disable-next-line no-restricted-syntax
  for (const blockData of blocks) {
    // eslint-disable-next-line no-await-in-loop
    await renderStoredSection(blockData, main);
  }
}

// ── Page detail ─────────────────────────────────────────────────────────────

function renderOverviewTab(container, page, payload) {
  const req = payload?.request || {};
  const followUp = req.followUp ? JSON.stringify(req.followUp) : null;
  container.innerHTML = `
    <div class="admin-stats admin-stats-strip">
      <span class="admin-stat"><span class="admin-stat-value">${dur(page.duration_ms)}</span><span class="admin-stat-label">duration</span></span>
      <span class="admin-stat"><span class="admin-stat-value">${page.block_count || 0}</span><span class="admin-stat-label">blocks</span></span>
      <span class="admin-stat"><span class="admin-stat-value">${page.input_tokens || '—'}</span><span class="admin-stat-label">in tokens</span></span>
      <span class="admin-stat"><span class="admin-stat-value">${page.output_tokens || '—'}</span><span class="admin-stat-label">out tokens</span></span>
    </div>

    <section class="admin-card">
      <h3>Metadata</h3>
      <dl class="admin-kvs admin-kvs-two">
        ${kv('Page ID', page.id)}
        ${kv('Session', page.session_id)}
        ${kv('Query', page.query)}
        ${kv('Title', page.title)}
        ${kv('Intent', page.intent_type)}
        ${kv('Journey stage', page.journey_stage)}
        ${kv('Flow', page.flow_id)}
        ${kv('Follow-up type', page.follow_up_type)}
        ${kv('Generated', ts(page.created_at))}
        ${kv('DA path', page.da_path)}
      </dl>
      ${page.live_url ? `<p class="admin-links">
          <a href="${esc(page.live_url)}" target="_blank" rel="noopener">Live →</a>
          ${page.preview_url ? `<a href="${esc(page.preview_url)}" target="_blank" rel="noopener">Preview →</a>` : ''}
        </p>` : ''}
    </section>

    <section class="admin-card">
      <h3>Request context</h3>
      <dl class="admin-kvs admin-kvs-two">
        ${kv('Query', req.query)}
        ${kv('Previous queries', (req.previousQueries || []).join(' → '))}
        ${kv('Quiz persona', req.quizPersona)}
        ${kv('Follow-up clicked', followUp)}
        ${kv('Browsing history', (req.browsingHistory || []).slice(0, 8).join(', '))}
        ${kv('Journey stage', req.inferredProfile?.journeyStage)}
        ${kv('Inferred intent', req.inferredProfile?.inferredIntent)}
        ${kv('Products viewed', (req.inferredProfile?.productsViewed || []).join(', '))}
      </dl>
    </section>
  `;
}

function renderBlocksTab(container, payload) {
  const blocks = payload?.blocks || [];
  if (blocks.length === 0) {
    container.innerHTML = '<p class="admin-empty">No blocks stored for this page.</p>';
    return;
  }
  container.innerHTML = `
    <div class="admin-blocks">
      ${blocks.map((b) => `
        <details class="admin-block" open>
          <summary>
            <span class="admin-block-num">#${b.index}</span>
            ${badge(b.blockType, 'accent')}
          </summary>
          <div class="admin-block-tabs">
            <button class="admin-tab-btn is-active" data-mode="render">Rendered</button>
            <button class="admin-tab-btn" data-mode="source">HTML source</button>
          </div>
          <div class="admin-block-render">${b.html}</div>
          <pre class="admin-block-source" hidden>${esc(b.html)}</pre>
        </details>`).join('')}
    </div>
  `;
  container.querySelectorAll('.admin-block').forEach((blockEl) => {
    blockEl.querySelectorAll('.admin-tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        blockEl.querySelectorAll('.admin-tab-btn').forEach((b) => b.classList.toggle('is-active', b === btn));
        const rendered = blockEl.querySelector('.admin-block-render');
        const source = blockEl.querySelector('.admin-block-source');
        const { mode } = btn.dataset;
        rendered.hidden = mode !== 'render';
        source.hidden = mode !== 'source';
      });
    });
  });
}

function renderDebugTab(container, payload) {
  const dbg = payload?.debug;
  if (!dbg) {
    container.innerHTML = '<p class="admin-empty">No debug information stored.</p>';
    return;
  }
  const intent = dbg.intent
    ? `${dbg.intent.type}${dbg.intent.confidence ? ` (${(dbg.intent.confidence * 100).toFixed(0)}%)` : ''}`
    : null;
  const priceRange = dbg.behaviorAnalysis?.catalogPriceRange;
  const priceRangeStr = priceRange ? `$${priceRange.min} – $${priceRange.max}` : null;
  const timingSteps = dbg.timings?.steps
    ? dbg.timings.steps.map((s) => `${s.step}:${s.ms}ms${s.gate ? '[gate]' : ''}`).join(' | ')
    : null;

  container.innerHTML = `
    <section class="admin-card">
      <h3>RAG context</h3>
      <dl class="admin-kvs admin-kvs-two">
        ${kv('Intent', intent)}
        ${kv('Persona', dbg.rag?.persona?.name)}
        ${kv('Use case', dbg.rag?.useCase?.name)}
        ${kv('Products', (dbg.rag?.products || []).map((p) => `${p.name} ($${p.price})`).join(', '))}
        ${kv('Features', (dbg.rag?.features || []).map((f) => f.name).join(', '))}
        ${kv('FAQs', dbg.rag?.faqs?.length ? `${dbg.rag.faqs.length} matched` : null)}
        ${kv('Reviews', dbg.rag?.reviews?.map((r) => `${r.author}/${r.productId}`).join(', '))}
        ${kv('Recipes', (dbg.rag?.recipes || []).map((r) => r.name).join(', '))}
        ${kv('Hero images', (dbg.rag?.heroImages || []).map((h) => `${h.id}(${(h.score || 0).toFixed(2)})`).join(', '))}
      </dl>
    </section>

    ${dbg.behaviorAnalysis ? `<section class="admin-card">
      <h3>Behavior analysis</h3>
      <dl class="admin-kvs admin-kvs-two">
        ${kv('Cold start', dbg.behaviorAnalysis.coldStart)}
        ${kv('Price tier', dbg.behaviorAnalysis.priceTier)}
        ${kv('Price range', priceRangeStr)}
        ${kv('Use case priorities', (dbg.behaviorAnalysis.useCasePriorities || []).join(', '))}
        ${kv('Product shortlist', (dbg.behaviorAnalysis.productShortlist || []).join(', '))}
        ${kv('Purchase readiness', dbg.behaviorAnalysis.purchaseReadiness)}
      </dl>
    </section>` : ''}

    ${dbg.timings ? `<section class="admin-card">
      <h3>Timings</h3>
      <dl class="admin-kvs admin-kvs-two">
        ${kv('Total', dur(dbg.timings.total))}
        ${kv('LLM', dur(dbg.timings.llm))}
        ${kv('First token', dur(dbg.timings.llmFirstToken))}
        ${kv('Streaming', dur(dbg.timings.llmStreaming))}
        ${kv('Context', dur(dbg.timings.context))}
        ${kv('Prompt build', dur(dbg.timings.prompt))}
        ${kv('Parse', dur(dbg.timings.parse))}
      </dl>
      ${timingSteps ? `<p class="admin-timing-steps">${esc(timingSteps)}</p>` : ''}
    </section>` : ''}

    ${dbg.prompt ? `<details class="admin-card admin-collapsible">
      <summary>Prompt (${dbg.prompt.systemLength || 0} + ${dbg.prompt.userLength || 0} chars)</summary>
      <h4>System prompt</h4>
      <pre class="admin-pre">${esc(dbg.prompt.systemPrompt || '')}</pre>
      <h4>User message</h4>
      <pre class="admin-pre">${esc(dbg.prompt.userMessage || '')}</pre>
    </details>` : ''}

    ${dbg.llm?.rawOutput ? `<details class="admin-card admin-collapsible">
      <summary>Raw LLM output (${dbg.llm.rawOutput.length} chars)</summary>
      <pre class="admin-pre">${esc(dbg.llm.rawOutput)}</pre>
    </details>` : ''}
  `;
}

async function renderPage(root, pageId, tab) {
  root.innerHTML = '<p class="admin-loading">Loading page…</p>';
  let data;
  try {
    data = await api(`/api/admin/pages/${pageId}`);
  } catch (err) {
    root.innerHTML = `<p class="admin-error">${esc(err.message)}</p>`;
    return;
  }

  const { page, payload } = data;
  const sessionCrumb = `<a href="#/sessions/${esc(page.session_id)}">← Session ${esc(page.session_id.substring(0, 8))}…</a>`;

  root.innerHTML = `
    <nav class="admin-crumbs">${sessionCrumb}</nav>
    <div class="admin-toolbar">
      <h2 class="admin-page-title">${esc(page.query || 'Untitled query')}</h2>
      <div class="admin-badges">
        ${badge(page.intent_type, intentTone(page.intent_type))}
        ${page.follow_up_type ? badge(page.follow_up_type, 'purple') : ''}
      </div>
    </div>
    <nav class="admin-tabs">
      <a data-tab="overview" href="#/pages/${esc(page.id)}">Overview</a>
      <a data-tab="preview" href="#/pages/${esc(page.id)}/preview">Live preview</a>
      <a data-tab="blocks" href="#/pages/${esc(page.id)}/blocks">Blocks</a>
      <a data-tab="debug" href="#/pages/${esc(page.id)}/debug">Debug</a>
    </nav>
    <div class="admin-tabpanel" id="admin-tabpanel"></div>
  `;

  root.querySelectorAll('.admin-tabs a').forEach((a) => {
    a.classList.toggle('is-active', a.dataset.tab === tab);
  });

  const panel = root.querySelector('#admin-tabpanel');
  if (tab === 'preview') {
    await renderLivePreview(panel, payload);
  } else if (tab === 'blocks') {
    renderBlocksTab(panel, payload);
  } else if (tab === 'debug') {
    renderDebugTab(panel, payload);
  } else {
    renderOverviewTab(panel, page, payload);
  }
}

// ── Entry ───────────────────────────────────────────────────────────────────

async function render(root) {
  const route = parseRoute();
  if (route.view === 'session') {
    await renderSession(root, route.id);
  } else if (route.view === 'page') {
    await renderPage(root, route.id, route.tab);
  } else {
    await renderSessions(root);
  }
}

export default async function decorate(block) {
  block.innerHTML = '';
  const shell = document.createElement('div');
  shell.className = 'admin-shell';

  const header = document.createElement('header');
  header.className = 'admin-header';
  header.innerHTML = `
    <div class="admin-brand">⬡ <strong>Arco Admin</strong></div>
    <div class="admin-header-actions">
      <button type="button" class="admin-btn admin-btn-ghost" data-action="reload">Reload</button>
      <button type="button" class="admin-btn admin-btn-ghost" data-action="logout">Reset token</button>
    </div>
  `;
  shell.appendChild(header);

  const view = document.createElement('div');
  view.className = 'admin-view';
  shell.appendChild(view);
  block.appendChild(shell);

  header.querySelector('[data-action="reload"]').addEventListener('click', () => {
    render(view);
  });
  header.querySelector('[data-action="logout"]').addEventListener('click', () => {
    clearAdminToken();
    render(view);
  });

  window.addEventListener('hashchange', () => { render(view); });
  await render(view);
}
