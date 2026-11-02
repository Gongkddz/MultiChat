/**
 * Multi-provider Chat Interface — Complete Frontend Application
 * Features: workspaces, conversation management, search, streaming, reasoning display
 */

// ── Constants ──────────────────────────────────────────────────────────────
const STORAGE_KEY = {
    WORKSPACES: 'nvidia_chat_workspaces',
    CONVERSATIONS: 'nvidia_chat_conversations',
    ACTIVE: 'nvidia_chat_active',
    SETTINGS: 'nvidia_chat_settings',
    SYNC_META: 'nvidia_chat_sync_meta',
};

// The backend emits a heartbeat every 10 seconds. If even that stops, the
// local server or network path is stuck and the UI must recover automatically.
const STREAM_INACTIVITY_TIMEOUT_MS = 45000;

// ── State ──────────────────────────────────────────────────────────────────
const state = {
    apiKey: null,
    provider: 'nvidia',
    providers: [],
    models: [],
    currentModel: '',
    workspaces: [],
    conversations: [],
    activeWorkspaceId: null,
    activeConversationId: null,
    isStreaming: false,
    editingMessageId: null,
    attachedFiles: [],
    searchQuery: '',
    abortController: null,
    settings: { temperature: 1.0, maxTokens: 16384, seed: 42, contextWindows: {} },
    syncMeta: { tombstones: {} },
};

// ── IDs & DOM ──────────────────────────────────────────────────────────────
let _idCounter = Date.now();
const uid = (prefix) => `${prefix}_${++_idCounter}`;
const $ = (sel) => document.querySelector(sel);
const now = () => Date.now();



const iconPaths = {
 'compose':'M12 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-7 M16 3l5 5 M10 14l2-6 6-6 4 4-6 6z',
 'folder':'M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11H3z',
 'folder-plus':'M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11H3z M9 12h6 M12 9v6',
 'key':'M14 11a5 5 0 1 0-3-3L3 16v5h5v-3h3v-3z',
 'settings':'M9 3h6l1 4 4 1v6l-4 2-1 4H9l-1-4-4-2V8l4-1z M15 11a3 3 0 1 0-6 0 3 3 0 0 0 6 0',
 'logout':'M10 4H4v16h6 M9 12h12 M17 8l4 4-4 4',
 'trash':'M3 6h18 M9 6V3h6v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7',
 'plus':'M12 4v16 M4 12h16', 'arrow-up':'M12 19V5 M6 11l6-6 6 6',
 'refresh':'M20 9a8 8 0 1 0 0 6 M20 3v6h-6',
 'copy':'M9 8h12v13H9z M15 8V3H3v13h6',
};
function icon(name) { return `<svg class="line-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${iconPaths[name] || iconPaths.compose}"/></svg>`; }
function mountIcons() { document.querySelectorAll('[data-icon]').forEach(el => { el.innerHTML = icon(el.dataset.icon); }); }
function newChat() {
    if (state.isStreaming) { toast('请先停止当前生成'); return; }
    const ws = ensureActiveWorkspace();
    handleSidebarAction('new-conv', {dataset:{wsId:ws.id}});
    $('#user-input').focus();
}
async function openKeySettings() {
    if (state.isStreaming) { toast('请先停止当前生成'); return; }
    $('#keys-modal').classList.remove('hidden');
    $('#key-provider').value = state.provider;
    $('#managed-key').value = ''; $('#managed-key').type = 'password'; $('#managed-key-visible').checked = false;
    $('#key-error').classList.add('hidden');
    try { const status = await apiJson('/api/status'); state.providers = status.providers || []; renderKeyConnection(); }
    catch(e) { toast(e.message, 'error'); }
}
function renderKeyConnection() {
    const provider = state.providers.find(p => p.id === $('#key-provider').value);
    $('#key-connection').textContent = provider?.has_api_key ? `已连接 · ${provider.masked_key || '密钥已保存'}` : '尚未配置密钥';
    $('#remove-key-btn').disabled = !provider?.has_api_key;
}
async function saveManagedKey() {
    const key = $('#managed-key').value.trim();
    if (!key) { $('#key-error').textContent = '请输入 API Key'; $('#key-error').classList.remove('hidden'); return; }
    $('#save-key-btn').disabled = true; $('#save-key-btn').textContent = '正在验证…';
    try {
        await apiJson('/api/auth/login', {method:'POST', body:JSON.stringify({provider:$('#key-provider').value,api_key:key,save:true})});
        const status = await apiJson('/api/status'); applyProviderStatus(status);
        $('#managed-key').value = ''; $('#keys-modal').classList.add('hidden');
        await refreshModels(); toast('密钥已保存，连接已更新');
    } catch(e) { $('#key-error').textContent = e.message; $('#key-error').classList.remove('hidden'); }
    finally { $('#save-key-btn').disabled = false; $('#save-key-btn').textContent = '验证并保存'; }
}
async function removeManagedKey() {
    const provider = $('#key-provider').value;
    if (!await showConfirm('移除密钥', '移除此供应商的本地 API 密钥？聊天记录会保留。')) return;
    try {
        await apiJson(`/api/auth/keys/${encodeURIComponent(provider)}`, {method:'DELETE'});
        const status = await apiJson('/api/status'); applyProviderStatus(status); renderKeyConnection();
        if (status.has_api_key) await refreshModels();
        else { $('#keys-modal').classList.add('hidden'); showLoginScreen(); }
        toast('密钥已移除');
    } catch(e) { toast(e.message, 'error'); }
}

function safeMarkdown(text) {
    if (typeof DOMPurify === 'undefined') return escapeHtml(text);
    return DOMPurify.sanitize(marked.parse(text), {FORBID_TAGS:['style','form','input']});
}
const composingInputs = new WeakSet();
function isComposing(event) {
    return event.isComposing || event.keyCode === 229 || composingInputs.has(event.target);
}
function modelUsageKey() { return `${state.provider}:${state.currentModel}`; }
function updateUsageBar() {
    if (!$('#usage-bar')) return;
    const conv = getActiveConversation();
    const messages = conv?.messages || [];
    const latest = [...messages].reverse().find(m => m.usage);
    const usage = latest?.usage;
    const number = n => Math.round(n).toLocaleString('zh-CN');
    $('#cache-stat').textContent = usage?.cached_tokens != null && usage.prompt_tokens > 0
        ? `缓存命中率 ${(100 * usage.cached_tokens / usage.prompt_tokens).toFixed(1)}%` : '缓存命中率 未提供';
    $('#cache-stat').title = '最近一次有用量数据的请求：缓存输入 tokens ÷ 总输入 tokens。供应商未报告时显示未提供。';
    const ledger = Object.values(conv?.usageLedger || {});
    const total = ledger.reduce((sum, u) => sum + (u.total_tokens || 0), 0);
    $('#total-stat').textContent = `本对话累计 ${number(total)} tokens`;
    $('#total-stat').title = '本次更新后供应商已报告的请求用量之和，包含重新生成；旧记录和未报告的请求无法计入。';
    const capacity = state.settings.contextWindows[modelUsageKey()];
    const hasImages = messages.some(m => Array.isArray(m.content) && m.content.some(c => c.type === 'image_url'));
    const text = (getActiveWorkspace()?.systemPrompt || '') + messages.map(m => extractTextContent(m.content)).join('\n') + $('#user-input').value;
    const cjk = (text.match(/[\u2e80-\u9fff\uf900-\ufaff]/g) || []).length;
    const estimated = Math.ceil(cjk * 1.5 + (text.length - cjk) / 3) + messages.length * 6;
    $('#context-stat').textContent = !capacity ? '剩余上下文 待设置容量' : hasImages ? '剩余上下文 含图片，无法估算' : `剩余上下文 约 ${number(Math.max(0, capacity - estimated))} / ${number(capacity)}`;
    const known = capacity > 0 && !hasImages;
    const remaining = known ? Math.max(0, (capacity - estimated) / capacity * 100) : null;
    $('#context-ring-value')?.setAttribute('stroke-dasharray', `${remaining ?? 0} 100`);
    $('#context-ring')?.classList.toggle('unknown', !known);
    $('#context-ring')?.classList.toggle('low', known && remaining < 15);
    $('#context-ring')?.setAttribute('aria-label', known ? `上下文剩余约 ${Math.round(remaining)}%，查看用量详情` : '上下文容量未知，查看用量详情');
    if ($('#context-percent')) $('#context-percent').textContent = known ? `剩余约 ${Math.round(remaining)}%` : '容量未知';
    $('#context-stat').title = '设置中填写当前供应商模型的容量。根据当前消息、系统提示及草稿估算文本占用，未预留下一次输出预算。';
}

// ── Toast ──────────────────────────────────────────────────────────────────
function toast(msg, type = '') {
    let c = $('#toast-container');
    if (!c) { c = document.createElement('div'); c.id = 'toast-container'; document.body.appendChild(c); }
    const el = document.createElement('div'); el.className = `toast ${type}`; el.textContent = msg;
    c.appendChild(el); setTimeout(() => el.remove(), 3500);
}

// ── API Helpers ────────────────────────────────────────────────────────────
async function api(path, options = {}) {
    let requestBody = options.body;
    const res = await fetch(path, {
        ...options,
        headers: { 'Content-Type': 'application/json', ...options.headers },
        body: requestBody,
    });
    if (!res.ok) {
        let detail = res.statusText;
        try { const err = await res.json(); detail = err.detail || detail; } catch (_) {}
        throw new Error(`HTTP ${res.status}: ${detail}`);
    }
    return res;
}
async function apiJson(path, options = {}) { const r = await api(path, options); return r.json(); }

// ════════════════════════════════════════════════════════════════════════════
// DATA PERSISTENCE
// ════════════════════════════════════════════════════════════════════════════

async function loadData() {
    try {
        // The old browser version stored everything in localStorage. The
        // desktop version also keeps a container-independent AppData copy.
        let persisted = {};
        try { persisted = await apiJson('/api/user-data'); } catch (_) {}
        if (!localStorage.getItem(STORAGE_KEY.WORKSPACES) && persisted[STORAGE_KEY.WORKSPACES]) {
            for (const key of Object.values(STORAGE_KEY)) {
                if (persisted[key] !== undefined) localStorage.setItem(key, JSON.stringify(persisted[key]));
            }
        }
        state.workspaces = JSON.parse(localStorage.getItem(STORAGE_KEY.WORKSPACES) || '[]');
        state.conversations = JSON.parse(localStorage.getItem(STORAGE_KEY.CONVERSATIONS) || '[]');
        const active = JSON.parse(localStorage.getItem(STORAGE_KEY.ACTIVE) || '{}');
        state.activeWorkspaceId = active.workspaceId || null;
        state.activeConversationId = active.conversationId || null;
        const sets = JSON.parse(localStorage.getItem(STORAGE_KEY.SETTINGS) || '{}');
        if (sets.temperature !== undefined) state.settings.temperature = sets.temperature;
        if (sets.maxTokens) state.settings.maxTokens = sets.maxTokens;
        if (sets.seed !== undefined) state.settings.seed = sets.seed;
        state.settings.contextWindows = sets.contextWindows || {};
        state.syncMeta = JSON.parse(localStorage.getItem(STORAGE_KEY.SYNC_META) || '{"tombstones":{}}');
    } catch (_) { state.workspaces = []; state.conversations = []; }
}

let persistUserDataTimer = null;
function persistUserData() {
    clearTimeout(persistUserDataTimer);
    persistUserDataTimer = setTimeout(() => {
        const payload = {};
        for (const key of Object.values(STORAGE_KEY)) {
            const raw = localStorage.getItem(key);
            if (raw !== null) { try { payload[key] = JSON.parse(raw); } catch (_) {} }
        }
        const json = JSON.stringify(payload);
        const body = json;
        api('/api/user-data', { method: 'POST', body }).catch(() => {});
    }, 250);
}
function utf8ToBase64(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
}
function saveWorkspaces() { localStorage.setItem(STORAGE_KEY.WORKSPACES, JSON.stringify(state.workspaces)); persistUserData(); }
function saveConversations() { updateUsageBar(); localStorage.setItem(STORAGE_KEY.CONVERSATIONS, JSON.stringify(state.conversations)); persistUserData(); }
function saveActive() {
    localStorage.setItem(STORAGE_KEY.ACTIVE, JSON.stringify({
        workspaceId: state.activeWorkspaceId, conversationId: state.activeConversationId
    }));
    persistUserData();
}
function persistSettings() {
    localStorage.setItem(STORAGE_KEY.SETTINGS, JSON.stringify(state.settings));
    persistUserData();
}
function saveSyncMeta() {
    localStorage.setItem(STORAGE_KEY.SYNC_META, JSON.stringify(state.syncMeta));
    persistUserData();
}
function markDeleted(id) {
    state.syncMeta.tombstones ||= {};
    state.syncMeta.tombstones[id] = now();
    saveSyncMeta();
}

function applySyncedData(data) {
    if (state.isStreaming || state.editingMessageId) return false;
    if (!data || !Array.isArray(data[STORAGE_KEY.WORKSPACES]) || !Array.isArray(data[STORAGE_KEY.CONVERSATIONS])) return false;
    const oldFingerprint = JSON.stringify([state.workspaces, state.conversations]);
    state.workspaces = data[STORAGE_KEY.WORKSPACES];
    state.conversations = data[STORAGE_KEY.CONVERSATIONS];
    state.syncMeta = data[STORAGE_KEY.SYNC_META] || { tombstones: {} };
    localStorage.setItem(STORAGE_KEY.WORKSPACES, JSON.stringify(state.workspaces));
    localStorage.setItem(STORAGE_KEY.CONVERSATIONS, JSON.stringify(state.conversations));
    localStorage.setItem(STORAGE_KEY.SYNC_META, JSON.stringify(state.syncMeta));
    if (!getWorkspace(state.activeWorkspaceId)) state.activeWorkspaceId = state.workspaces[0]?.id || null;
    if (!getConversation(state.activeConversationId)) state.activeConversationId = getWorkspaceConversations(state.activeWorkspaceId)[0]?.id || null;
    if (oldFingerprint !== JSON.stringify([state.workspaces, state.conversations])) {
        renderSidebar();
        if (!state.isStreaming && !state.editingMessageId) loadConversationView();
    }
    return true;
}

let syncPollBusy = false;
let lastSyncManifest = '';
async function pollSyncedData() {
    if (syncPollBusy || document.hidden) return;
    syncPollBusy = true;
    try {
        const manifest = JSON.stringify(await apiJson('/api/user-data/manifest'));
        if (lastSyncManifest && manifest !== lastSyncManifest) {
            if (!applySyncedData(await apiJson('/api/user-data'))) return;
        }
        lastSyncManifest = manifest;
    } catch (_) {}
    finally { syncPollBusy = false; }
}
window.addEventListener('multichat-sync', event => {
    if (!applySyncedData(event.detail)) setTimeout(pollSyncedData, 1000);
});

// ── Workspace helpers ──────────────────────────────────────────────────────
function getWorkspace(id) { return state.workspaces.find(w => w.id === id); }
function getConversation(id) { return state.conversations.find(c => c.id === id); }
function getActiveWorkspace() { return getWorkspace(state.activeWorkspaceId); }
function getActiveConversation() { return getConversation(state.activeConversationId); }

function getWorkspaceConversations(wsId) {
    return state.conversations
        .filter(c => c.workspaceId === wsId)
        .sort((a, b) => b.updatedAt - a.updatedAt);
}

function createWorkspace(name = '新项目', systemPrompt = '') {
    const createdAt = now();
    const ws = { id: uid('ws'), name, systemPrompt, createdAt, updatedAt: createdAt };
    state.workspaces.push(ws);
    saveWorkspaces();
    return ws;
}

function createConversation(workspaceId, title = '新对话') {
    const conv = { id: uid('conv'), workspaceId, title, messages: [], createdAt: now(), updatedAt: now() };
    state.conversations.push(conv);
    saveConversations();
    return conv;
}

function deleteWorkspace(wsId) {
    markDeleted(wsId);
    for (const conv of state.conversations.filter(c => c.workspaceId === wsId)) markDeleted(conv.id);
    state.workspaces = state.workspaces.filter(w => w.id !== wsId);
    state.conversations = state.conversations.filter(c => c.workspaceId !== wsId);
    saveWorkspaces(); saveConversations();
}

function deleteConversation(convId) {
    markDeleted(convId);
    state.conversations = state.conversations.filter(c => c.id !== convId);
    saveConversations();
}

function updateConversation(convId, updates) {
    const conv = getConversation(convId);
    if (!conv) return;
    Object.assign(conv, updates, { updatedAt: now() });
    saveConversations();
}

function touchConversation(convId) {
    const conv = getConversation(convId);
    if (conv) { conv.updatedAt = now(); saveConversations(); }
}

function ensureActiveWorkspace() {
    if (state.workspaces.length === 0) {
        const ws = createWorkspace('默认空间');
        state.activeWorkspaceId = ws.id;
        saveActive();
        return ws;
    }
    if (!state.activeWorkspaceId || !getWorkspace(state.activeWorkspaceId)) {
        state.activeWorkspaceId = state.workspaces[0].id;
        saveActive();
    }
    return getWorkspace(state.activeWorkspaceId);
}

function switchToConversation(convId) {
    state.activeConversationId = convId;
    saveActive();
    loadConversationView();
    renderSidebar();
}

// ════════════════════════════════════════════════════════════════════════════
// SIDEBAR RENDERING
// ════════════════════════════════════════════════════════════════════════════

function renderSidebar() {
    const container = $('#sidebar-content');
    const query = state.searchQuery.trim().toLowerCase();

    if (query) {
        renderSearchResults(container, query);
        return;
    }

    let html = '';
    // Keep workspaces in creation order; only hoist active to top
    const wsList = [...state.workspaces];
    const activeIdx = wsList.findIndex(w => w.id === state.activeWorkspaceId);
    if (activeIdx > 0) {
        const [active] = wsList.splice(activeIdx, 1);
        wsList.unshift(active);
    }

    for (const ws of wsList) {
        const convs = getWorkspaceConversations(ws.id);
        const isCollapsed = ws.id !== state.activeWorkspaceId && convs.length > 3;
        html += `<div class="workspace-group${isCollapsed ? ' collapsed' : ''}" data-ws-id="${ws.id}">`;
        html += `<div class="workspace-header" data-action="toggle-ws" data-ws-id="${ws.id}">`;
        html += `<span class="workspace-arrow">⌄</span><span class="folder-icon">${icon('folder')}</span>`;
        html += `<span class="workspace-name">${escapeHtml(ws.name)}</span>`;
        html += `<span class="workspace-count">${convs.length}</span>`;
        html += `<span class="workspace-actions">`;
        html += `<button class="icon-btn" data-action="rename-ws" data-ws-id="${ws.id}" title="重命名">${icon('compose')}</button>`;
        html += `<button class="icon-btn" data-action="delete-ws" data-ws-id="${ws.id}" title="删除项目及其会话">${icon('trash')}</button>`;
        html += `</span></div>`;
        html += `<div class="conversation-list">`;
        for (const conv of convs) {
            const activeClass = conv.id === state.activeConversationId ? ' active' : '';
            const preview = getLastMessagePreview(conv);
            html += `<div class="conversation-item${activeClass}" data-action="open-conv" data-conv-id="${conv.id}">`;
            html += `<span class="conversation-icon">·</span>`;
            html += `<div class="conversation-info">`;
            html += `<div class="conversation-item-title">${escapeHtml(conv.title)}</div>`;
            html += `<div class="conversation-item-time">${preview}</div>`;
            html += `</div>`;
            html += `<span class="conversation-item-actions">`;
            html += `<button class="icon-btn" data-action="rename-conv" data-conv-id="${conv.id}" title="重命名">${icon('compose')}</button>`;
            html += `<button class="icon-btn" data-action="delete-conv" data-conv-id="${conv.id}" title="删除会话">${icon('trash')}</button>`;
            html += `</span></div>`;
        }

        html += `</div></div>`;
    }


    container.innerHTML = html;
}

function getLastMessagePreview(conv) {
    if (!conv.messages || conv.messages.length === 0) return formatTime(conv.updatedAt);
    const last = conv.messages[conv.messages.length - 1];
    const text = extractTextContent(last.content);
    const preview = text.length > 30 ? text.slice(0, 30) + '...' : text;
    return `${escapeHtml(preview.replace(/\s+/g, ' '))} · ${formatTime(conv.updatedAt)}`;
}

function renderSearchResults(container, query) {
    const results = [];
    for (const conv of state.conversations) {
        const ws = getWorkspace(conv.workspaceId);
        let matched = false;
        let snippet = '';
        let msgId = null;

        // Search title
        if (conv.title.toLowerCase().includes(query)) {
            matched = true;
            snippet = conv.title;
        }
        // Search messages
        if (!matched) {
            for (const msg of conv.messages) {
                const text = extractTextContent(msg.content);
                const idx = text.toLowerCase().indexOf(query);
                if (idx >= 0) {
                    matched = true;
                    msgId = msg.id;
                    const start = Math.max(0, idx - 20);
                    const end = Math.min(text.length, idx + query.length + 30);
                    snippet = (start > 0 ? '...' : '') + text.slice(start, end) + (end < text.length ? '...' : '');
                    break;
                }
            }
        }

        if (matched) {
            results.push({ conv, ws, snippet, query, msgId });
        }
    }

    if (results.length === 0) {
        container.innerHTML = '<div class="no-results">未找到匹配的对话</div>';
        return;
    }

    let html = `<div class="search-results"><div class="search-result-header">搜索结果 (${results.length})</div>`;
    for (const r of results) {
        html += `<div class="search-result-item" data-action="open-conv" data-conv-id="${r.conv.id}" data-msg-id="${r.msgId || ''}">`;
        html += `<span class="conversation-icon">·</span>`;
        html += `<div class="search-result-info">`;
        html += `<div class="search-result-title">${escapeHtml(r.conv.title)}</div>`;
        html += `<div class="search-result-snippet">${highlightMatch(r.snippet, query)}</div>`;
        html += `<div class="search-result-workspace">${escapeHtml(r.ws ? r.ws.name : '')}</div>`;
        html += `</div></div>`;
    }
    html += '</div>';
    container.innerHTML = html;
}

function highlightMatch(text, query) {
    const idx = text.toLowerCase().indexOf(query.toLowerCase());
    if (idx < 0) return escapeHtml(text);
    return escapeHtml(text.slice(0, idx)) + '<b>' + escapeHtml(text.slice(idx, idx + query.length)) + '</b>' + escapeHtml(text.slice(idx + query.length));
}

function scrollToMessage(msgId) {
    if (!msgId) return;
    setTimeout(() => {
        const el = document.querySelector(`[data-message-id="${msgId}"]`);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 200);
}

// ════════════════════════════════════════════════════════════════════════════
// CHAT VIEW
// ════════════════════════════════════════════════════════════════════════════

function loadConversationView() {
    const conv = getActiveConversation();
    const ws = getActiveWorkspace();

    // Title
    $('#conversation-title').textContent = conv ? conv.title : '新对话';

    // System prompt from workspace
    const sp = ws ? ws.systemPrompt || '' : '';
    $('#system-prompt-input').value = sp;

    // Messages
    state.editingMessageId = null;
    $('#edit-indicator').classList.add('hidden');
    renderAllMessages();
}

function renderAllMessages() {
    updateUsageBar();
    const container = $('#chat-messages');
    container.innerHTML = '';
    const conv = getActiveConversation();
    const messages = conv ? conv.messages : [];

    if (messages.length === 0) {
        container.innerHTML = `<div class="empty-chat">
            <div class="empty-chat-icon"><img src="/static/brand/logo.svg" alt="模型对话"></div>
            <h2>今天想探索什么？</h2><p>选择模型，开始你的下一个想法。</p></div>`;
        return;
    }

    messages.forEach(msg => container.appendChild(createMessageElement(msg)));
    scrollToBottom();
}

function createMessageElement(msg) {
    const wrapper = document.createElement('div');
    wrapper.className = `message-wrapper ${msg.role}`;
    wrapper.dataset.messageId = msg.id;

    const avatar = document.createElement('div');
    avatar.className = 'message-avatar';
    avatar.textContent = msg.role === 'user' ? '你' : 'AI';

    const body = document.createElement('div');
    body.className = 'message-body';

    const header = document.createElement('div');
    header.className = 'message-header';
    const roleLabel = document.createElement('span');
    roleLabel.className = 'message-role';
    roleLabel.textContent = msg.role === 'user' ? 'You' : 'Assistant';
    const timeLabel = document.createElement('span');
    timeLabel.className = 'message-time';
    timeLabel.textContent = formatTime(msg.timestamp);
    header.appendChild(roleLabel);
    header.appendChild(timeLabel);
    body.appendChild(header);

    // Some compatible APIs occasionally finish with reasoning-only output
    // (for example when the reasoning phase consumes the output budget). Do
    // not leave the user's entire visible answer trapped in a collapsed box.
    const reasoningOnly = msg.role === 'assistant' && msg.reasoning && !extractTextContent(msg.content).trim();

    // Reasoning section
    if (msg.role === 'assistant' && msg.reasoning && !reasoningOnly) {
        const rs = document.createElement('div');
        rs.className = 'reasoning-section collapsed';
        const rt = document.createElement('div');
        rt.className = 'reasoning-toggle';
        rt.innerHTML = `💭 已深度思考 <span class="reasoning-badge">${Math.ceil(msg.reasoning.length/2)} tokens</span>`;
        rt.onclick = () => rs.classList.toggle('collapsed');
        const rc = document.createElement('div');
        rc.className = 'reasoning-content';
        rc.textContent = msg.reasoning;
        rs.appendChild(rt); rs.appendChild(rc);
        body.appendChild(rs);
    }

    // Content
    const content = document.createElement('div');
    content.className = 'message-content';
    renderMessageContent(content, reasoningOnly ? { ...msg, content: msg.reasoning } : msg);
    body.appendChild(content);

    // Finish reason
    if (msg.role === 'assistant' && msg.finishReason && msg.finishReason !== 'stop') {
        const fe = document.createElement('div');
        showFinishReason(fe, msg.finishReason);
        body.appendChild(fe);
    }

    // Actions (copy / edit / delete)
    const actions = document.createElement('div');
    actions.className = 'message-actions';
    const copyBtn = document.createElement('button');
    copyBtn.className = 'icon-btn'; copyBtn.innerHTML = icon('copy'); copyBtn.title = '复制';
    copyBtn.onclick = () => copyMessage(msg);
    const editBtn = document.createElement('button');
    editBtn.className = 'icon-btn'; editBtn.innerHTML = icon('compose'); editBtn.title = '编辑';
    editBtn.onclick = () => startEditMessage(msg.id);
    const delBtn = document.createElement('button');
    delBtn.className = 'icon-btn'; delBtn.innerHTML = icon('trash'); delBtn.title = '删除';
    delBtn.onclick = () => deleteMessage(msg.id);
    actions.appendChild(copyBtn); actions.appendChild(editBtn); actions.appendChild(delBtn);
    wrapper.appendChild(actions);

    wrapper.appendChild(avatar);
    wrapper.appendChild(body);
    return wrapper;
}

function appendMessageElement(msg) {
    const container = $('#chat-messages');
    const emptyEl = container.querySelector('.empty-chat');
    if (emptyEl) emptyEl.remove();
    const el = createMessageElement(msg);
    container.appendChild(el);
    scrollToBottom();
    return el;
}

function renderMessageContent(el, msg) {
    if (msg.attachments && msg.attachments.length > 0) {
        const ad = document.createElement('div'); ad.className = 'attached-images';
        msg.attachments.forEach(att => {
            if (att.type === 'image') {
                const img = document.createElement('img'); img.className = 'attached-image';
                img.src = att.data_url; img.title = att.filename;
                img.onclick = () => window.open(att.data_url, '_blank');
                ad.appendChild(img);
            } else {
                const tag = document.createElement('span'); tag.className = 'attached-file-tag';
                tag.textContent = `📄 ${att.filename}`; ad.appendChild(tag);
            }
        });
        el.appendChild(ad);
    }

    const text = extractTextContent(msg.content);
    if (msg.role === 'assistant' && text && typeof marked !== 'undefined' && typeof marked.parse === 'function') {
        const md = document.createElement('div');
        md.innerHTML = safeMarkdown(text);
        el.appendChild(md);
        if (typeof hljs !== 'undefined') el.querySelectorAll('pre code').forEach(b => hljs.highlightElement(b));
    } else if (text) {
        el.textContent = text;
    }
}

function scrollToBottom() {
    const c = $('#chat-messages');
    requestAnimationFrame(() => { c.scrollTop = c.scrollHeight; });
}

function formatTime(ts) {
    const d = new Date(ts), now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const t = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    if (d.toDateString() === now.toDateString()) return t;
    return `${d.getMonth()+1}/${d.getDate()} ${t}`;
}

// ════════════════════════════════════════════════════════════════════════════
// SENDING & STREAMING
// ════════════════════════════════════════════════════════════════════════════

async function sendMessage({ regenerate = false } = {}) {
    if (state.isStreaming) return;
    if (state.editingMessageId) await saveEdit(false);

    const text = $('#user-input').value.trim();
    const hasAttachments = state.attachedFiles.length > 0;
    if (!regenerate && !text && !hasAttachments) return;

    // Ensure active workspace & conversation exist
    const ws = regenerate ? getActiveWorkspace() : ensureActiveWorkspace();
    let conv = getActiveConversation();
    if (regenerate) {
        if (!ws || !conv || conv.messages.length === 0 || conv.messages.at(-1).role !== 'user') return;
    }
    if (!conv) {
        const title = text ? text.slice(0, 40) + (text.length > 40 ? '...' : '') : '新对话';
        conv = createConversation(ws.id, title);
        state.activeConversationId = conv.id;
        saveActive();
        $('#conversation-title').textContent = conv.title;
    }
    // Auto-update title on first message
    if (!regenerate && conv.messages.length === 0 && text) {
        conv.title = text.slice(0, 40) + (text.length > 40 ? '...' : '');
        $('#conversation-title').textContent = conv.title;
    }

    // Build content and append a new user message for a normal send. During
    // regeneration, the edited user message is already the final history item.
    let content;
    if (!regenerate && hasAttachments) {
        content = [];
        if (text) content.push({ type: 'text', text });
        state.attachedFiles.forEach(att => {
            if (att.type === 'image') {
                content.push({ type: 'image_url', image_url: { url: att.data_url } });
            } else if (att.type === 'text') {
                const et = content.find(c => c.type === 'text');
                const fb = `\n\n--- 📄 ${att.filename} ---\n${att.content}\n--- EOF ---\n`;
                if (et) et.text = fb + et.text; else content.push({ type: 'text', text: fb });
            }
        });
    } else if (!regenerate) {
        content = text;
    }

    if (!regenerate) {
        const userMsg = { id: uid('msg'), role: 'user', content, timestamp: now(),
            attachments: hasAttachments ? [...state.attachedFiles] : undefined };
        conv.messages.push(userMsg);
        touchConversation(conv.id);
        saveConversations();

        $('#user-input').value = '';
        clearAttachedFiles();
        resizeInput();
        appendMessageElement(userMsg);
        renderSidebar();
    }

    // ── Start streaming ──
    state.isStreaming = true;
    state.abortController = new AbortController();
    $('#send-btn').disabled = true;
    $('#stop-btn').classList.remove('hidden');
    $('#user-input').disabled = true;

    const assistantMsg = { id: uid('msg'), role: 'assistant', content: '', reasoning: '', finishReason: null, timestamp: now(), provider: state.provider, model: state.currentModel };
    conv.messages.push(assistantMsg);
    saveConversations();

    const assistantEl = appendMessageElement(assistantMsg);
    const contentEl = assistantEl.querySelector('.message-content');
    contentEl.classList.add('streaming-indicator');
    contentEl.textContent = '正在等待模型响应…';
    const bodyEl = assistantEl.querySelector('.message-body');

    // Reasoning section
    const reasoningSection = document.createElement('div');
    reasoningSection.className = 'reasoning-section hidden';
    const reasoningToggle = document.createElement('div');
    reasoningToggle.className = 'reasoning-toggle';
    reasoningToggle.textContent = '💭 思考中...';
    reasoningToggle.onclick = () => reasoningSection.classList.toggle('collapsed');
    const reasoningContent = document.createElement('div');
    reasoningContent.className = 'reasoning-content';
    reasoningSection.appendChild(reasoningToggle);
    reasoningSection.appendChild(reasoningContent);
    bodyEl.insertBefore(reasoningSection, contentEl);

    // Finish reason element
    const finishEl = document.createElement('div');
    finishEl.className = 'finish-reason hidden';
    bodyEl.appendChild(finishEl);

    let buffer = '', reasoningBuffer = '';
    let lastStreamPersistAt = 0;
    const persistStreamProgress = () => {
        const time = now();
        if (time - lastStreamPersistAt < 750) return;
        lastStreamPersistAt = time;
        conv.updatedAt = time;
        saveConversations();
    };
    let lastRenderAt = 0;
    let inactivityTimer = null;
    let inactivityTimedOut = false;

    const resetInactivityTimer = () => {
        clearTimeout(inactivityTimer);
        inactivityTimer = setTimeout(() => {
            inactivityTimedOut = true;
            if (state.abortController) state.abortController.abort();
        }, STREAM_INACTIVITY_TIMEOUT_MS);
    };

    try {
        const response = await api('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                provider: state.provider,
                model: state.currentModel,
                messages: conv.messages.filter(m => m.role !== 'assistant' || m.id !== assistantMsg.id),
                temperature: state.settings.temperature,
                top_p: 1.0, max_tokens: state.settings.maxTokens, seed: state.settings.seed,
                system_prompt: ws.systemPrompt || null,
            }),
            signal: state.abortController.signal,
        });

        if (!response.ok) {
            let detail = `HTTP ${response.status}: ${response.statusText}`;
            try { const err = await response.json(); detail = err.detail || detail; } catch (_) {}
            throw new Error(detail);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let leftover = '';
        let receivedTerminalEvent = false;
        resetInactivityTimer();

        while (true) {
            const { done, value } = await reader.read();

            if (value || done) {
                resetInactivityTimer();
                leftover += done ? decoder.decode() + '\n' : decoder.decode(value, { stream: true });
                const lines = leftover.split('\n');
                leftover = lines.pop() || '';

                for (const line of lines) {
                    const sse = parseSSELine(line);
                    if (!sse) continue;
                    if (sse.error) throw new Error(sse.error);

                    if (sse.usage) {
                        assistantMsg.usage = sse.usage;
                        conv.usageLedger ||= {};
                        conv.usageLedger[assistantMsg.id] = sse.usage;
                        updateUsageBar();
                        continue;
                    }
                    if (sse.done) {
                        receivedTerminalEvent = true;
                        assistantMsg.finishReason = sse.finish_reason || 'stop';
                        continue;
                    }
                    if (sse.status) {
                        contentEl.textContent = sse.status;
                        continue;
                    }
                    if (sse.reasoning) {
                        if (!reasoningBuffer && !buffer) contentEl.textContent = '';
                        reasoningBuffer += sse.reasoning;
                        assistantMsg.reasoning = reasoningBuffer;
                        reasoningContent.textContent = reasoningBuffer;
                        reasoningSection.classList.remove('hidden');
                        reasoningToggle.textContent = '💭 思考中...';
                        persistStreamProgress();
                        scrollToBottom();
                        continue;
                    }
                    if (sse.content) {
                        buffer += sse.content;
                        assistantMsg.content = buffer;
                        if (reasoningBuffer && !reasoningSection.classList.contains('collapsed')) {
                            reasoningSection.classList.add('collapsed');
                            reasoningToggle.innerHTML = `💭 已深度思考 <span class="reasoning-badge">${Math.ceil(reasoningBuffer.length/2)} tokens</span>`;
                        }
                        if (now() - lastRenderAt > 80) {
                            lastRenderAt = now();
                            contentEl.textContent = buffer;
                        }
                        persistStreamProgress();
                        scrollToBottom();
                    }
                }
            }

            if (done) {
                if (!receivedTerminalEvent) throw new Error('响应流意外中断，服务端未返回完成状态');
                break;
            }
        }

        contentEl.classList.remove('streaming-indicator');

        // A few reasoning models can terminate before emitting a separate
        // content field. Treat the only returned text as the visible answer
        // instead of hiding everything inside the reasoning disclosure.
        if (!buffer && reasoningBuffer && assistantMsg.finishReason === 'stop') {
            buffer = reasoningBuffer;
            reasoningBuffer = '';
            assistantMsg.content = buffer;
            assistantMsg.reasoning = '';
            reasoningSection.classList.add('hidden');
        }

        if (buffer) contentEl.textContent = buffer;
        else if (reasoningBuffer) contentEl.textContent = '模型仅返回了思考内容，尚未生成正文。';
        if (buffer && typeof marked !== 'undefined' && typeof marked.parse === 'function') {
            contentEl.innerHTML = safeMarkdown(buffer);
            if (typeof hljs !== 'undefined') contentEl.querySelectorAll('pre code').forEach(b => hljs.highlightElement(b));
        }

        if (reasoningBuffer) {
            reasoningSection.classList.add('collapsed');
            reasoningToggle.innerHTML = `💭 已深度思考 <span class="reasoning-badge">${Math.ceil(reasoningBuffer.length/2)} tokens · ${Math.round((now()-assistantMsg.timestamp)/1000)}s</span>`;
        } else {
            reasoningSection.classList.add('hidden');
        }

        if (assistantMsg.finishReason && assistantMsg.finishReason !== 'stop') {
            showFinishReason(finishEl, assistantMsg.finishReason);
        }

        assistantMsg.content = buffer;
        assistantMsg.reasoning = reasoningBuffer;
        touchConversation(conv.id);
        saveConversations();
        renderSidebar();

    } catch (e) {
        contentEl.classList.remove('streaming-indicator');
        contentEl.textContent = buffer;
        assistantMsg.finishReason = e.name === 'AbortError' ? 'cancelled' : 'interrupted';
        if (e.name === 'AbortError' && !inactivityTimedOut) {
            // User stopped — keep what we have
            if (buffer) assistantMsg.content = buffer + '\n\n*[已停止]*';
            else assistantMsg.content = '*[已停止]*';
            if (reasoningBuffer) assistantMsg.reasoning = reasoningBuffer;
            touchConversation(conv.id);
        } else {
            const displayError = inactivityTimedOut
                ? `本地服务 ${Math.round(STREAM_INACTIVITY_TIMEOUT_MS / 1000)} 秒内没有返回任何数据，已自动停止。请检查网络或重试。`
                : e.message;
            const errDiv = document.createElement('div');
            errDiv.className = 'message-error';
            errDiv.innerHTML = `<div class="error-detail"><span class="error-icon">⚠️</span><span class="error-text">${escapeHtml(displayError)}</span></div>
                <button class="retry-btn small-btn" onclick="retryMessage('${assistantMsg.id}')">🔄 重试</button>`;
            contentEl.appendChild(errDiv);
            if (!buffer && !reasoningBuffer) {
                const idx = conv.messages.findIndex(m => m.id === assistantMsg.id);
                if (idx >= 0) conv.messages.splice(idx, 1);
            } else {
                assistantMsg.content = buffer || `[Error: ${displayError}]`;
            }
            toast(`API 错误: ${displayError}`, 'error');
        }
        saveConversations();
        renderSidebar();
    }

    clearTimeout(inactivityTimer);
    state.isStreaming = false;
    state.abortController = null;
    $('#send-btn').disabled = false;
    $('#stop-btn').classList.add('hidden');
    $('#user-input').disabled = false;
    $('#user-input').focus();
    scrollToBottom();
}

function stopStreaming() {
    if (state.abortController) {
        state.abortController.abort();
        state.abortController = null;
        toast('已停止生成');
    }
}

async function retryMessage(msgId) {
    if (state.isStreaming) return;
    const conv = getActiveConversation();
    if (!conv) return;
    const idx = conv.messages.findIndex(m => m.id === msgId);
    if (idx < 0) return;
    conv.messages.splice(idx, 1);
    saveConversations();
    renderAllMessages();
    await sendMessage({ regenerate: true });
}

function parseSSELine(line) {
    if (!line.startsWith('data: ')) return null;
    const raw = line.slice(6).trim();
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (_) { return null; }
}

// ════════════════════════════════════════════════════════════════════════════
// MESSAGE EDITING & DELETION
// ════════════════════════════════════════════════════════════════════════════

function startEditMessage(msgId) {
    if (state.isStreaming) return;
    if (state.editingMessageId) saveEdit(false);

    const conv = getActiveConversation();
    if (!conv) return;
    const msg = conv.messages.find(m => m.id === msgId);
    if (!msg) return;

    state.editingMessageId = msgId;
    const wrapper = document.querySelector(`[data-message-id="${msgId}"]`);
    if (!wrapper) return;
    wrapper.classList.add('editing');

    const contentEl = wrapper.querySelector('.message-content');
    const rawText = extractTextContent(msg.content);

    contentEl.innerHTML = '';
    const textarea = document.createElement('textarea');
    textarea.className = 'message-edit-area';
    textarea.value = rawText;
    textarea.rows = Math.max(6, Math.min(18, rawText.split('\n').length + 2));

    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'message-edit-actions';
    const saveBtn = document.createElement('button');
    saveBtn.className = 'small-btn';
    saveBtn.textContent = msg.role === 'user' ? '💾 保存并重新生成' : '💾 保存';
    saveBtn.onclick = () => saveEdit();
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'small-btn'; cancelBtn.textContent = '取消';
    cancelBtn.onclick = () => cancelEdit();
    actionsDiv.appendChild(saveBtn); actionsDiv.appendChild(cancelBtn);
    contentEl.appendChild(textarea); contentEl.appendChild(actionsDiv);
    textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, 160), window.innerHeight * 0.6)}px`;
    textarea.addEventListener('keydown', e => {
        if (isComposing(e)) return;
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveEdit(); }
    });
    textarea.focus();
    $('#edit-indicator').classList.remove('hidden');
}

async function saveEdit(regenerate = true) {
    if (!state.editingMessageId) return;
    const conv = getActiveConversation();
    if (!conv) return;
    const msgId = state.editingMessageId;
    const wrapper = document.querySelector(`[data-message-id="${msgId}"]`);
    if (!wrapper) return;

    const textarea = wrapper.querySelector('.message-edit-area');
    const newText = textarea ? textarea.value.trim() : '';
    const msg = conv.messages.find(m => m.id === msgId);
    if (!msg) return;

    // Update content
    if (Array.isArray(msg.content)) {
        const tp = msg.content.find(c => c.type === 'text');
        if (tp) tp.text = newText;
        else if (newText) msg.content.unshift({ type: 'text', text: newText });
    } else {
        msg.content = newText;
    }

    // Truncate messages after this one
    const idx = conv.messages.findIndex(m => m.id === msgId);
    if (idx >= 0) conv.messages = conv.messages.slice(0, idx + 1);

    touchConversation(conv.id);
    saveConversations();
    state.editingMessageId = null;
    $('#edit-indicator').classList.add('hidden');
    renderAllMessages();
    renderSidebar();
    if (regenerate && msg.role === 'user') {
        await sendMessage({ regenerate: true });
    }
}

function cancelEdit() {
    state.editingMessageId = null;
    $('#edit-indicator').classList.add('hidden');
    renderAllMessages();
}

async function deleteMessage(msgId) {
    if (state.isStreaming) return;
    const conv = getActiveConversation();
    if (!conv) return;

    const confirmed = await showConfirm('删除消息', '删除此消息及之后的所有回复？');
    if (!confirmed) return;

    const idx = conv.messages.findIndex(m => m.id === msgId);
    if (idx >= 0) conv.messages = conv.messages.slice(0, idx);

    // Delete conversation if empty
    if (conv.messages.length === 0) {
        deleteConversation(conv.id);
        state.activeConversationId = null;
        saveActive();
        renderAllMessages();
        renderSidebar();
        $('#conversation-title').textContent = '新对话';
    } else {
        touchConversation(conv.id);
        saveConversations();
        renderAllMessages();
        renderSidebar();
    }
    toast('消息已删除');
}

// ════════════════════════════════════════════════════════════════════════════
// FILE UPLOAD
// ════════════════════════════════════════════════════════════════════════════

function handleFileSelect(e) {
    uploadFiles(Array.from(e.target.files));
    e.target.value = '';
}

async function uploadFiles(files) {
    for (const file of files) {
        if (file.size > 20*1024*1024) { toast(`${file.name} 超过20MB限制`, 'error'); continue; }
        const fd = new FormData(); fd.append('file', file);
        try {
            const res = await fetch('/api/upload', { method: 'POST', body: fd });
            if (!res.ok) { const e = await res.json(); throw new Error(e.detail); }
            state.attachedFiles.push(await res.json());
            renderAttachedFiles();
        } catch (e) { toast(`上传失败: ${e.message}`, 'error'); }
    }
}

function renderAttachedFiles() {
    const c = $('#attached-files');
    if (state.attachedFiles.length === 0) { c.classList.add('hidden'); c.innerHTML = ''; return; }
    c.classList.remove('hidden');
    c.innerHTML = state.attachedFiles.map((att, i) => att.type === 'image'
        ? `<div class="attached-file-preview"><img src="${att.data_url}"><span>${escapeHtml(att.filename)}</span><span class="remove-attach" onclick="removeAttachment(${i})">✕</span></div>`
        : `<div class="attached-file-preview"><span>📄 ${escapeHtml(att.filename)}</span><span class="remove-attach" onclick="removeAttachment(${i})">✕</span></div>`
    ).join('');
}

function removeAttachment(i) { state.attachedFiles.splice(i, 1); renderAttachedFiles(); }
function clearAttachedFiles() { state.attachedFiles = []; renderAttachedFiles(); }

// ════════════════════════════════════════════════════════════════════════════
// FINISH REASON & REASONING TOGGLE
// ════════════════════════════════════════════════════════════════════════════

function showFinishReason(el, reason) {
    el.classList.remove('hidden');
    switch (reason) {
        case 'length':
            el.textContent = '已达到输出上限（含思考 tokens）。可在设置中增大 Max Tokens，或继续生成。';
            el.className = 'finish-reason finish-reason-warn';
            const more = document.createElement('button');
            more.className = 'small-btn'; more.textContent = '继续生成';
            more.onclick = () => { if (state.isStreaming) return; $('#user-input').value = '请接着上一条回复的末尾继续，完成剩余内容。'; sendMessage(); };
            el.appendChild(more); break;
        case 'interrupted': el.textContent = '响应中断，已保留收到的内容。'; el.className = 'finish-reason finish-reason-warn'; break;
        case 'cancelled': el.textContent = '已停止生成'; el.className = 'finish-reason'; break;
        case 'content_filter': el.innerHTML = '⚠️ 内容被安全过滤器拦截'; el.className = 'finish-reason finish-reason-warn'; break;
        default: el.innerHTML = `⏹️ 结束原因: ${reason}`; el.className = 'finish-reason';
    }
}

function toggleReasoning(section) { section.classList.toggle('collapsed'); }

// ════════════════════════════════════════════════════════════════════════════
// MODEL SELECTION
// ════════════════════════════════════════════════════════════════════════════

async function refreshModels() {
    try {
        const data = await apiJson(`/api/models?refresh=true&provider=${encodeURIComponent(state.provider)}`);
        state.models = data.models;
        if ((!state.currentModel || !state.models.includes(state.currentModel)) && state.models.length > 0) {
            const pref = state.models.find(m => m.includes('glm') || m.includes('llama') || m.includes('qwen'));
            state.currentModel = pref || state.models[0];
        }
        updateModelDisplay();
        toast(`已加载 ${state.models.length} 个模型`, 'success');
    } catch (e) {
        toast(`加载模型失败: ${e.message}`, 'error');
    }
}

function updateModelDisplay() {
    updateUsageBar();
    $('#model-search-input').value = state.currentModel || '';
    $('#model-select').value = state.currentModel || '';
}

let _dropdownIndex = -1;

function filterModels(q) { return q ? state.models.filter(m => m.toLowerCase().includes(q.toLowerCase())) : state.models; }

function renderDropdown(filtered, query = '') {
    const dd = $('#model-dropdown');
    dd.innerHTML = '';
    if (filtered.length === 0) {
        dd.innerHTML = '<div class="select-dropdown-empty">未找到匹配的模型</div>';
    } else {
        filtered.forEach((m, i) => {
            const item = document.createElement('div');
            item.className = 'select-dropdown-item';
            if (m === state.currentModel) item.classList.add('selected');
            item.dataset.index = i; item.dataset.model = m;
            const q = query;
            item.title = m;
            item.setAttribute('role', 'option');
            item.setAttribute('aria-selected', String(m === state.currentModel));
            if (q) {
                const idx = m.toLowerCase().indexOf(q.toLowerCase());
                item.innerHTML = idx >= 0 ? escapeHtml(m.slice(0,idx)) + '<b>'+escapeHtml(m.slice(idx,idx+q.length))+'</b>'+escapeHtml(m.slice(idx+q.length)) : escapeHtml(m);
            } else { item.textContent = m; }
            item.addEventListener('mousedown', e => { e.preventDefault(); selectModel(m); });
            dd.appendChild(item);
        });
    }
    dd.scrollTop = 0;
    dd.classList.remove('hidden'); _dropdownIndex = -1;
    $('#model-search-input').setAttribute('aria-expanded', 'true');
}

function openDropdown(query = '') { renderDropdown(filterModels(query), query); }
function closeDropdown() { $('#model-dropdown').classList.add('hidden'); $('#model-search-input').setAttribute('aria-expanded', 'false'); _dropdownIndex = -1; updateModelDisplay(); }

function selectModel(m) {
    state.currentModel = m; updateModelDisplay(); closeDropdown();
    apiJson('/api/config', { method: 'POST', body: JSON.stringify({ default_model: m }) }).catch(()=>{});
}

function highlightDropdownItem() {
    const items = $('#model-dropdown').querySelectorAll('.select-dropdown-item');
    items.forEach((item, i) => item.classList.toggle('active', i === _dropdownIndex));
    if (_dropdownIndex >= 0 && items[_dropdownIndex]) items[_dropdownIndex].scrollIntoView({ block: 'nearest' });
}

// ════════════════════════════════════════════════════════════════════════════
// LOGIN
// ════════════════════════════════════════════════════════════════════════════

async function checkLoginStatus() {
    try {
        const status = await apiJson('/api/status');
        applyProviderStatus(status);
        if (status.has_api_key) { state.apiKey = true; await onLoggedIn(); }
        else showLoginScreen(status.provider);
    } catch (_) { showLoginScreen(); }
}

function showLoginScreen(provider = state.provider) {
    $('#login-screen').classList.remove('hidden');
    $('#app-layout').classList.add('hidden');
    state.apiKey = null;
    $('#login-provider-select').value = provider;
    updateLoginProvider();
}

function applyProviderStatus(status) {
    state.provider = status.provider || state.provider;
    state.providers = status.providers || state.providers;
    $('#provider-select').value = state.provider;
}

function updateLoginProvider() {
    const provider = $('#login-provider-select').value;
    const deepseek = provider === 'deepseek';
    $('#api-key-input').placeholder = deepseek ? '输入 DeepSeek API Key (sk-...)' : '输入 NVIDIA API Key (nvapi-...)';
    $('#login-provider-description').textContent = deepseek ? '连接到 DeepSeek 官方 API' : '连接到 NVIDIA NIM 云端模型';
}

async function handleLogin() {
    const apiKey = $('#api-key-input').value.trim();
    const provider = $('#login-provider-select').value;
    if (!apiKey) { showLoginError('请输入 API Key'); return; }
    $('#login-btn').disabled = true; $('#login-btn').textContent = '验证中...';
    $('#login-error').classList.add('hidden');
    try {
        const r = await apiJson('/api/auth/login', { method: 'POST', body: JSON.stringify({ provider, api_key: apiKey, save: $('#save-key-checkbox').checked }) });
        state.provider = r.provider;
        state.apiKey = true;
        showLoginStatus(`✅ 登录成功! 可用模型: ${r.model_count} 个`);
        setTimeout(() => onLoggedIn(), 800);
    } catch (e) {
        showLoginError(e.message); $('#login-btn').disabled = false; $('#login-btn').textContent = '登 录';
    }
}

function showLoginError(msg) { const e = $('#login-error'); e.textContent = msg; e.classList.remove('hidden'); }
function showLoginStatus(msg) { const e = $('#login-status'); e.textContent = msg; e.classList.remove('hidden'); }

async function handleLogout() {
    const ok = await showConfirm('退出登录', '确定要退出登录并清除保存的 API Key 吗？');
    if (!ok) return;
    try { await apiJson('/api/auth/logout', { method: 'POST' }); } catch (_) {}
    state.apiKey = null; state.models = []; state.workspaces = []; state.conversations = [];
    state.activeWorkspaceId = null; state.activeConversationId = null;
    localStorage.clear();
    showLoginScreen(); toast('已退出登录');
}

async function onLoggedIn() {
    $('#login-screen').classList.add('hidden');
    $('#app-layout').classList.remove('hidden');
    $('#user-input').disabled = false; $('#send-btn').disabled = false;
    if (window.matchMedia('(max-width: 768px)').matches) $('#sidebar').classList.add('collapsed');

    // Load persisted data
    await loadData();
    ensureActiveWorkspace();

    // Restore settings to UI
    $('#temperature-slider').value = state.settings.temperature;
    $('#temperature-value').textContent = state.settings.temperature.toFixed(1);
    $('#modal-max-tokens').value = state.settings.maxTokens;
    $('#modal-seed').value = state.settings.seed;
    $('#modal-context-window').value = state.settings.contextWindows[modelUsageKey()] || '';

    // Server-side config
    try {
        const cfg = await apiJson('/api/config');
        if (cfg.default_model) state.currentModel = cfg.default_model;
        if (cfg.temperature !== undefined) { state.settings.temperature = cfg.temperature; $('#temperature-slider').value = cfg.temperature; $('#temperature-value').textContent = cfg.temperature.toFixed(1); }
        if (cfg.max_tokens) { state.settings.maxTokens = cfg.max_tokens; $('#modal-max-tokens').value = cfg.max_tokens; }
        if (cfg.seed !== undefined) { state.settings.seed = cfg.seed; $('#modal-seed').value = cfg.seed; }
    } catch (_) {}

    await refreshModels();
    renderSidebar();
    loadConversationView();

    const status = await apiJson('/api/status').catch(() => ({}));
    applyProviderStatus(status);
    if (status.masked_key) $('#current-key-display').textContent = status.masked_key;
    const current = (status.providers || []).find(p => p.id === state.provider);
    $('#current-provider-display').textContent = current ? current.name : state.provider;
}

async function switchProvider() {
    const provider = $('#provider-select').value;
    if (provider === state.provider) return;
    try {
        const result = await apiJson('/api/provider', { method: 'POST', body: JSON.stringify({ provider }) });
        state.provider = result.provider;
        state.currentModel = '';
        await refreshModels();
        toast(`已切换到 ${provider === 'deepseek' ? 'DeepSeek' : 'NVIDIA'}`, 'success');
    } catch (e) {
        $('#provider-select').value = state.provider;
        if (e.message.includes('401')) {
            $('#login-provider-select').value = provider;
            showLoginScreen(provider);
            showLoginError('请先配置该供应商的 API Key');
        } else toast(`切换失败: ${e.message}`, 'error');
    }
}

// ════════════════════════════════════════════════════════════════════════════
// SIDEBAR ACTIONS
// ════════════════════════════════════════════════════════════════════════════

async function handleSidebarAction(action, el) {
    if (state.isStreaming) { toast('请先停止当前生成'); return; }
    const wsId = el.dataset.wsId;
    const convId = el.dataset.convId;
    const msgId = el.dataset.msgId;

    switch (action) {
        case 'toggle-ws': {
            const group = document.querySelector(`.workspace-group[data-ws-id="${wsId}"]`);
            if (group) group.classList.toggle('collapsed');
            state.activeWorkspaceId = wsId;
            saveActive();
            // If current conversation doesn't belong to this workspace, clear it
            const conv = getActiveConversation();
            if (conv && conv.workspaceId !== wsId) {
                const wsConvs = getWorkspaceConversations(wsId);
                state.activeConversationId = wsConvs.length > 0 ? wsConvs[0].id : null;
                saveActive();
            }
            loadConversationView();
            break;
        }
        case 'open-conv':
            state.activeWorkspaceId = getConversation(convId)?.workspaceId || state.activeWorkspaceId;
            switchToConversation(convId);
            if (msgId) { state.searchQuery = ''; $('#search-input').value = ''; scrollToMessage(msgId); }
            break;
        case 'new-conv': {
            const conv = createConversation(wsId);
            state.activeWorkspaceId = wsId;
            state.activeConversationId = conv.id;
            saveActive(); loadConversationView(); renderSidebar();
            break;
        }
        case 'new-ws': {
            const name = await showRename('新建项目', '项目名称');
            if (!name) return;
            const ws = createWorkspace(name);
            state.activeWorkspaceId = ws.id; state.activeConversationId = null;
            saveActive(); renderSidebar(); loadConversationView();
            break;
        }
        case 'rename-ws': {
            const ws = getWorkspace(wsId); if (!ws) return;
            const name = await showRename('重命名项目', '新名称', ws.name);
            if (name) { ws.name = name; ws.updatedAt = now(); saveWorkspaces(); renderSidebar(); }
            break;
        }
        case 'delete-ws': {

            const ws = getWorkspace(wsId); if (!ws) return;
            const ok = await showConfirm('删除项目', `确定要删除「${ws.name}」及其所有对话吗？此操作不可撤销。`);
            if (!ok) return;
            if (state.activeWorkspaceId === wsId) {
                const remaining = state.workspaces.filter(w => w.id !== wsId);
                state.activeWorkspaceId = remaining[0]?.id || null;
                state.activeConversationId = null;
                saveActive();
            }
            deleteWorkspace(wsId);
            renderSidebar(); loadConversationView();
            toast('项目已删除');
            break;
        }
        case 'rename-conv': {
            const conv = getConversation(convId); if (!conv) return;
            const name = await showRename('重命名对话', '新名称', conv.title);
            if (name) { updateConversation(convId, { title: name }); renderSidebar(); loadConversationView(); }
            break;
        }
        case 'delete-conv': {
            const conv = getConversation(convId); if (!conv) return;
            const ok = await showConfirm('删除对话', `确定要删除「${conv.title}」吗？`);
            if (!ok) return;
            if (state.activeConversationId === convId) {
                const wsConvs = getWorkspaceConversations(conv.workspaceId).filter(c => c.id !== convId);
                state.activeConversationId = wsConvs.length > 0 ? wsConvs[0].id : null;
                saveActive();
            }
            deleteConversation(convId);
            renderSidebar(); loadConversationView();
            toast('对话已删除');
            break;
        }
    }
}

// ════════════════════════════════════════════════════════════════════════════
// DIALOGS
// ════════════════════════════════════════════════════════════════════════════

function showConfirm(title, message) {
    return new Promise(resolve => {
        $('#confirm-title').textContent = title; $('#confirm-message').textContent = message;
        $('#confirm-dialog').classList.remove('hidden');
        function cleanup() { $('#confirm-dialog').classList.add('hidden'); $('#confirm-ok-btn').onclick = null; $('#confirm-cancel-btn').onclick = null; }
        $('#confirm-ok-btn').onclick = () => { cleanup(); resolve(true); };
        $('#confirm-cancel-btn').onclick = () => { cleanup(); resolve(false); };
    });
}

function showRename(title, placeholder, current = '') {
    return new Promise(resolve => {
        $('#rename-title').textContent = title; $('#rename-input').value = current; $('#rename-input').placeholder = placeholder;
        $('#rename-dialog').classList.remove('hidden'); $('#rename-input').focus(); $('#rename-input').select();
        function cleanup() { $('#rename-dialog').classList.add('hidden'); $('#rename-ok-btn').onclick = null; $('#rename-cancel-btn').onclick = null; }
        $('#rename-ok-btn').onclick = () => { const v = $('#rename-input').value.trim(); cleanup(); resolve(v || null); };
        $('#rename-cancel-btn').onclick = () => { cleanup(); resolve(null); };
        $('#rename-input').onkeydown = (e) => { if (isComposing(e)) return; if (e.key === 'Enter') { const v = $('#rename-input').value.trim(); cleanup(); resolve(v || null); } };
    });
}

// ════════════════════════════════════════════════════════════════════════════
// SETTINGS
// ════════════════════════════════════════════════════════════════════════════

function openSettings() {
    $('#modal-max-tokens').value = state.settings.maxTokens;
    $('#modal-seed').value = state.settings.seed;
    $('#modal-context-window').value = state.settings.contextWindows[modelUsageKey()] || '';
    $('#settings-modal').classList.remove('hidden');
}
function closeSettings() { $('#settings-modal').classList.add('hidden'); }
async function saveSettings() {
    const capacity = Number($('#modal-context-window').value);
    if (capacity > 0 && Number.isSafeInteger(capacity)) state.settings.contextWindows[modelUsageKey()] = capacity;
    else delete state.settings.contextWindows[modelUsageKey()];
    state.settings.maxTokens = parseInt($('#modal-max-tokens').value) || 16384;
    state.settings.seed = parseInt($('#modal-seed').value) || 42;
    persistSettings();
    updateUsageBar();
    try {
        await apiJson('/api/config', { method: 'POST', body: JSON.stringify({ max_tokens: state.settings.maxTokens, seed: state.settings.seed }) });
        closeSettings(); toast('设置已保存', 'success');
    } catch (e) { toast(`保存失败: ${e.message}`, 'error'); }
}

async function saveSystemPrompt() {
    const ws = getActiveWorkspace();
    if (!ws) return;
    ws.systemPrompt = $('#system-prompt-input').value.trim();
    ws.updatedAt = now();
    saveWorkspaces();
    toast('System Prompt 已保存到当前空间', 'success');
}

function exportChatData() {
    const payload = {
        format: 'optimistrans-multichat', version: 1, exportedAt: new Date().toISOString(),
        workspaces: state.workspaces, conversations: state.conversations,
        settings: state.settings,
    };
    const json = JSON.stringify(payload, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `multichat-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

async function importChatData(file) {
    if (!file) return;
    try {
        const raw = JSON.parse(await file.text());
        // Accept both portable exports and the desktop app's internal
        // %LOCALAPPDATA%/NVIDIAChat/user_data.json representation.
        const data = raw.format === 'optimistrans-multichat' ? raw : {
            format: 'optimistrans-multichat',
            version: 1,
            workspaces: raw[STORAGE_KEY.WORKSPACES],
            conversations: raw[STORAGE_KEY.CONVERSATIONS],
            settings: raw[STORAGE_KEY.SETTINGS],
        };
        if (!Array.isArray(data.workspaces) || !Array.isArray(data.conversations)) {
            throw new Error('不是有效的模型对话备份文件');
        }
        const workspaceIds = new Set(state.workspaces.map(w => w.id));
        const conversationIds = new Set(state.conversations.map(c => c.id));
        for (const ws of data.workspaces) {
            if (ws?.id && !workspaceIds.has(ws.id)) { state.workspaces.push(ws); workspaceIds.add(ws.id); }
            else if (ws?.id) repairImportedText(state.workspaces.find(w => w.id === ws.id), ws);
        }
        for (const incoming of data.conversations) {
            const existing = state.conversations.find(c => c.id === incoming?.id);
            if (existing) repairImportedText(existing, incoming);
        }
        for (const conv of data.conversations) if (conv?.id && workspaceIds.has(conv.workspaceId) && !conversationIds.has(conv.id)) {
            state.conversations.push(conv); conversationIds.add(conv.id);
        }
        saveWorkspaces(); saveConversations();
        ensureActiveWorkspace(); renderSidebar(); loadConversationView();
        toast('聊天记录导入完成', 'success'); closeSettings();
    } catch (e) { toast(`导入失败: ${e.message}`, 'error'); }
    $('#import-data-input').value = '';
}

function repairImportedText(target, source) {
    if (!target || !source) return;
    for (const key of Object.keys(source)) {
        if (typeof target[key] === 'string' && target[key].includes('\uFFFD') &&
            typeof source[key] === 'string' && !source[key].includes('\uFFFD')) target[key] = source[key];
        else if (Array.isArray(target[key]) && Array.isArray(source[key])) {
            target[key].forEach((item, index) => {
                const original = item?.id ? source[key].find(s => s?.id === item.id) : source[key][index];
                if (typeof item === 'object') repairImportedText(item, original);
            });
        } else if (target[key] && typeof target[key] === 'object') repairImportedText(target[key], source[key]);
    }
}

// ════════════════════════════════════════════════════════════════════════════
// UTILITY
// ════════════════════════════════════════════════════════════════════════════

function escapeHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

function extractTextContent(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.filter(c => c.type === 'text').map(c => c.text).join('\n');
    return String(content || '');
}

function resizeInput() { const el = $('#user-input'); el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 150) + 'px'; }

// ════════════════════════════════════════════════════════════════════════════
// EVENT BINDINGS
// ════════════════════════════════════════════════════════════════════════════

function configureMarked() {
    if (typeof marked === 'undefined') return;
    marked.setOptions({ breaks: true, gfm: true });
    const renderer = new marked.Renderer();
    renderer.code = function(code, infostring) {
        if (typeof code === 'object') { infostring = code.lang; code = code.text; }
        const lang = (infostring || '').match(/\S*/)[0];
        const h = lang && typeof hljs !== 'undefined' && hljs.getLanguage(lang) ? hljs.highlight(code, { language: lang }).value : escapeHtml(code);
        const ll = lang ? `<span class="code-lang">${escapeHtml(lang)}</span>` : '';
        return `<pre>${ll}<button class="copy-code-btn" onclick="copyCode(this)">复制</button><code class="hljs">${h}</code></pre>`;
    };
    marked.use({ renderer });
}

function copyCode(btn) {
    const code = btn.parentElement.querySelector('code').textContent;
    navigator.clipboard.writeText(code).then(() => { btn.textContent = '已复制!'; setTimeout(() => { btn.textContent = '复制'; }, 1500); });
}

async function copyMessage(msg) {
    const text = extractTextContent(msg.content);
    try {
        await navigator.clipboard.writeText(text);
        toast('消息已复制', 'success');
    } catch (_) { toast('复制失败', 'error'); }
}

function bindEvents() {
    document.addEventListener('compositionstart', e => composingInputs.add(e.target), true);
    document.addEventListener('compositionend', e => composingInputs.delete(e.target), true);
    mountIcons();
    document.addEventListener('click', e => { const button = e.target.closest('.copy-code-btn'); if (button) copyCode(button); });
    $('#new-chat-btn').addEventListener('click', newChat);
    $('#header-new-chat').addEventListener('click', newChat);
    $('#new-project-btn').addEventListener('click', () => handleSidebarAction('new-ws', {dataset:{}}));
    $('#api-keys-btn').addEventListener('click', openKeySettings);
    $('#context-settings-btn').addEventListener('click', openSettings);
    $('#context-ring').addEventListener('click', () => $('#usage-bar').classList.toggle('expanded'));
    document.addEventListener('click', e => { if (!$('#usage-bar').contains(e.target)) $('#usage-bar').classList.remove('expanded'); });
    $('#save-key-btn').addEventListener('click', saveManagedKey);
    $('#remove-key-btn').addEventListener('click', removeManagedKey);
    $('#key-provider').addEventListener('change', () => { $('#managed-key').value = ''; $('#key-error').classList.add('hidden'); renderKeyConnection(); });
    $('#managed-key-visible').addEventListener('change', e => { $('#managed-key').type = e.target.checked ? 'text' : 'password'; });
    $('#keys-modal .modal-backdrop').addEventListener('click', () => $('#keys-modal').classList.add('hidden'));
    $('#keys-modal .modal-close').addEventListener('click', () => $('#keys-modal').classList.add('hidden'));
    // Login
    $('#login-btn').addEventListener('click', handleLogin);
    $('#login-provider-select').addEventListener('change', updateLoginProvider);
    $('#api-key-input').addEventListener('keydown', e => {
        if (isComposing(e)) return; if (e.key === 'Enter') handleLogin(); });
    $('#toggle-visibility').addEventListener('click', () => {
        const inp = $('#api-key-input'); inp.type = inp.type === 'password' ? 'text' : 'password';
        $('#toggle-visibility').textContent = inp.type === 'password' ? '👁' : '🙈';
    });

    // Logout
    $('#sidebar-logout-btn').addEventListener('click', handleLogout);

    // Sidebar toggle
    $('#toggle-sidebar-btn').addEventListener('click', () => {
        const sb = $('#sidebar'); sb.classList.toggle('collapsed');
        $('#toggle-sidebar-btn').textContent = sb.classList.contains('collapsed') ? '▶' : '◀';
    });
    $('#mobile-menu-btn').addEventListener('click', () => $('#sidebar').classList.toggle('collapsed'));

    // Sidebar content - delegated click handler
    $('#sidebar-content').addEventListener('click', e => {
        const btn = e.target.closest('[data-action]');
        if (btn) { e.preventDefault(); handleSidebarAction(btn.dataset.action, btn); }
    });

    // Search
    let searchTimer;
    $('#search-input').addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
            state.searchQuery = $('#search-input').value;
            renderSidebar();
        }, 200);
    });
    $('#search-input').addEventListener('keydown', e => {
        if (isComposing(e)) return;
        if (e.key === 'Escape') { $('#search-input').value = ''; state.searchQuery = ''; renderSidebar(); }
    });

    // Model dropdown
    const mi = $('#model-search-input');
    mi.addEventListener('focus', () => { if (state.models.length > 0) { mi.select(); openDropdown(); } });
    mi.addEventListener('input', () => openDropdown(mi.value.trim()));
    mi.addEventListener('click', () => { if ($('#model-dropdown').classList.contains('hidden')) { mi.select(); openDropdown(); } });
    mi.addEventListener('blur', closeDropdown);
    mi.addEventListener('keydown', e => {
        if (isComposing(e)) return;
        if (['ArrowDown', 'ArrowUp'].includes(e.key) && $('#model-dropdown').classList.contains('hidden')) openDropdown();
        const items = $('#model-dropdown').querySelectorAll('.select-dropdown-item');
        if (e.key === 'ArrowDown') { e.preventDefault(); _dropdownIndex = Math.min(_dropdownIndex+1, items.length-1); highlightDropdownItem(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); _dropdownIndex = Math.max(_dropdownIndex-1, 0); highlightDropdownItem(); }
        else if (e.key === 'Enter') {
            e.preventDefault();
            if (_dropdownIndex >= 0 && items[_dropdownIndex]) selectModel(items[_dropdownIndex].dataset.model);
            else if (items.length === 1) selectModel(items[0].dataset.model);
            else closeDropdown();
        }
        else if (e.key === 'Escape') closeDropdown();
    });
    document.addEventListener('click', e => {
        if (!$('#model-select-wrapper').contains(e.target)) closeDropdown();
    });
    $('#refresh-models-btn').addEventListener('click', refreshModels);
    $('#provider-select').addEventListener('change', switchProvider);

    // System prompt
    $('#system-prompt-toggle').addEventListener('click', () => {
        const bar = $('#system-prompt-bar'); bar.classList.toggle('collapsed'); bar.classList.toggle('expanded');
    });
    $('#save-system-prompt-btn').addEventListener('click', saveSystemPrompt);

    // Chat input
    $('#user-input').addEventListener('keydown', e => {
        if (isComposing(e)) return;
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });
    $('#user-input').addEventListener('input', () => { resizeInput(); updateUsageBar(); });
    $('#send-btn').addEventListener('click', sendMessage);
    $('#stop-btn').addEventListener('click', stopStreaming);

    // Temperature
    $('#temperature-slider').addEventListener('input', () => {
        const v = parseFloat($('#temperature-slider').value);
        $('#temperature-value').textContent = v.toFixed(1);
        state.settings.temperature = v;
    });

    // File upload
    $('#attach-btn').addEventListener('click', () => $('#file-input').click());
    $('#file-input').addEventListener('change', handleFileSelect);
    const chatArea = $('#chat-messages');
    chatArea.addEventListener('dragover', e => e.preventDefault());
    chatArea.addEventListener('drop', e => { e.preventDefault(); if (e.dataTransfer.files.length) uploadFiles(Array.from(e.dataTransfer.files)); });

    // Cancel edit
    $('#cancel-edit-btn').addEventListener('click', cancelEdit);

    // Settings
    $('#settings-btn').addEventListener('click', openSettings);
    $('#settings-modal .modal-close').addEventListener('click', closeSettings);
    $('#settings-modal .modal-backdrop').addEventListener('click', closeSettings);
    $('#save-settings-btn').addEventListener('click', saveSettings);
    $('#export-data-btn').addEventListener('click', exportChatData);
    $('#import-data-btn').addEventListener('click', () => $('#import-data-input').click());
    $('#import-data-input').addEventListener('change', e => importChatData(e.target.files[0]));

    // Confirm
    $('#confirm-dialog .modal-backdrop').addEventListener('click', () => $('#confirm-dialog').classList.add('hidden'));
    $('#rename-dialog .modal-backdrop').addEventListener('click', () => $('#rename-dialog').classList.add('hidden'));

    // Keyboard
    document.addEventListener('keydown', e => {
        if (isComposing(e)) return;
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') { e.preventDefault(); newChat(); return; }
        if (e.key === 'Escape') {
            $('#usage-bar').classList.remove('expanded');
            $('#keys-modal').classList.add('hidden');
            if (!$('#settings-modal').classList.contains('hidden')) closeSettings();
            else if (!$('#confirm-dialog').classList.contains('hidden')) $('#confirm-dialog').classList.add('hidden');
            else if (!$('#rename-dialog').classList.contains('hidden')) $('#rename-dialog').classList.add('hidden');
            else if (state.editingMessageId) cancelEdit();
        }
    });
}

// ════════════════════════════════════════════════════════════════════════════
// GLOBAL EXPORTS
// ════════════════════════════════════════════════════════════════════════════

window.copyCode = copyCode;
window.removeAttachment = removeAttachment;
window.retryMessage = retryMessage;
window.toggleReasoning = toggleReasoning;

// ════════════════════════════════════════════════════════════════════════════
// BOOT
// ════════════════════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
    configureMarked();
    bindEvents();
    checkLoginStatus();
    pollSyncedData();
    setInterval(pollSyncedData, 3000);
});
