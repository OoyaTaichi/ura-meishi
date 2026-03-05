/**
 * app.js — Sales侍 メインアプリケーションロジック
 * 全データはIndexedDBにローカル保存。外部送信なし。
 */

/* =====================================================
   StorageManager — IndexedDB ラッパー
   ===================================================== */
const StorageManager = (() => {
    const DB_NAME = 'sales-samurai-db';
    const DB_VERSION = 1;
    let db = null;

    function open() {
        return new Promise((resolve, reject) => {
            if (db) { resolve(db); return; }
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = e => {
                const d = e.target.result;
                if (!d.objectStoreNames.contains('contacts')) {
                    const store = d.createObjectStore('contacts', { keyPath: 'id' });
                    store.createIndex('company', 'company', { unique: false });
                    store.createIndex('createdAt', 'createdAt', { unique: false });
                }
                if (!d.objectStoreNames.contains('settings')) {
                    d.createObjectStore('settings', { keyPath: 'key' });
                }
            };
            req.onsuccess = e => { db = e.target.result; resolve(db); };
            req.onerror = e => reject(e.target.error);
        });
    }

    async function tx(storeName, mode, fn) {
        const d = await open();
        return new Promise((resolve, reject) => {
            const t = d.transaction(storeName, mode);
            const store = t.objectStore(storeName);
            const req = fn(store);
            req.onsuccess = e => resolve(e.target.result);
            req.onerror = e => reject(e.target.error);
        });
    }

    const contacts = {
        getAll: () => tx('contacts', 'readonly', s => s.getAll()),
        get: id => tx('contacts', 'readonly', s => s.get(id)),
        put: obj => tx('contacts', 'readwrite', s => s.put(obj)),
        delete: id => tx('contacts', 'readwrite', s => s.delete(id)),
    };

    const settings = {
        get: key => tx('settings', 'readonly', s => s.get(key)).then(r => r?.value),
        set: (key, value) => tx('settings', 'readwrite', s => s.put({ key, value })),
    };

    return { contacts, settings };
})();

/* =====================================================
   NotificationManager — 商談アラーム管理
   ===================================================== */
const NotificationManager = (() => {
    let swReg = null;

    async function init() {
        if (!('serviceWorker' in navigator) || !('Notification' in window)) return;
        try {
            // 3秒以内にService Workerが準備できなければスキップ（HTTP環境対策）
            swReg = await Promise.race([
                navigator.serviceWorker.ready,
                new Promise((_, reject) => setTimeout(() => reject(new Error('SW timeout')), 3000))
            ]);
        } catch (e) {
            console.warn('Service Worker 未対応環境（通知機能は無効）:', e.message);
        }
    }

    async function requestPermission() {
        if (!('Notification' in window)) return false;
        const perm = await Notification.requestPermission();
        return perm === 'granted';
    }

    function getPermission() {
        return 'Notification' in window ? Notification.permission : 'denied';
    }

    /**
     * SW Cacheにアラームを登録（Service Workerが1分ごとにチェック）
     */
    async function scheduleAlarm(contactId, contactName, meetingTime) {
        const alarms = await loadAlarms();
        const id = `${contactId}-${meetingTime}`;
        // 重複チェック
        const exists = alarms.find(a => a.id === id);
        if (exists) return;

        const dt = new Date(meetingTime);
        alarms.push({
            id,
            contactId,
            time: dt.getTime(),
            body: `${contactName}との商談まで15分！攻略メモを確認してください。`,
            fired: false
        });

        await saveAlarms(alarms);

        // Service Workerにアラームチェック開始を通知
        if (swReg?.active) {
            swReg.active.postMessage({ type: 'START_ALARM_CHECK' });
        }
    }

    async function loadAlarms() {
        try {
            const cache = await caches.open('sales-samurai-v1');
            const res = await cache.match('/__alarms__');
            if (!res) return [];
            return await res.json();
        } catch { return []; }
    }

    async function saveAlarms(alarms) {
        try {
            const cache = await caches.open('sales-samurai-v1');
            await cache.put('/__alarms__', new Response(JSON.stringify(alarms)));
        } catch (e) { console.warn('アラーム保存失敗', e); }
    }

    async function cancelAlarm(contactId, meetingTime) {
        const alarms = await loadAlarms();
        const id = `${contactId}-${meetingTime}`;
        const updated = alarms.filter(a => a.id !== id);
        await saveAlarms(updated);
    }

    return { init, requestPermission, getPermission, scheduleAlarm, cancelAlarm, loadAlarms };
})();

/* =====================================================
   VoiceManager — 音声入力
   ===================================================== */
const VoiceManager = (() => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    let recognition = null;
    let _onResult = null;
    let _onEnd = null;
    let isListening = false;

    function isSupported() { return !!SpeechRecognition; }

    function start(onResult, onEnd) {
        if (!isSupported()) { alert('音声入力はこのブラウザでは使用できません。Chrome/Safariをご利用ください。'); return; }
        if (isListening) { stop(); return; }

        _onResult = onResult;
        _onEnd = onEnd;
        recognition = new SpeechRecognition();
        recognition.lang = 'ja-JP';
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.maxAlternatives = 1;

        recognition.onresult = e => {
            let interim = '', final = '';
            for (let i = e.resultIndex; i < e.results.length; i++) {
                const t = e.results[i][0].transcript;
                if (e.results[i].isFinal) final += t;
                else interim += t;
            }
            if (_onResult) _onResult({ interim, final });
        };

        recognition.onend = () => {
            isListening = false;
            if (_onEnd) _onEnd();
        };

        recognition.onerror = e => {
            isListening = false;
            console.warn('音声認識エラー:', e.error);
            if (_onEnd) _onEnd();
        };

        recognition.start();
        isListening = true;
    }

    function stop() {
        if (recognition) recognition.stop();
        isListening = false;
    }

    function isActive() { return isListening; }

    return { isSupported, start, stop, isActive };
})();

/* =====================================================
   App — メインアプリケーション
   ===================================================== */
const App = (() => {
    let contacts = [];
    let currentContactId = null;
    let currentScreen = 'home';
    let searchQuery = '';
    let filterTag = 'all';
    let voiceTargetEl = null;
    let voiceAccumulated = '';

    /* ----- 初期化 ----- */
    async function init() {
        await NotificationManager.init();

        // Service Worker登録
        if ('serviceWorker' in navigator) {
            try {
                const reg = await navigator.serviceWorker.register('./service-worker.js');
                console.log('SW registered:', reg.scope);
                // アラームチェック起動
                if (reg.active) reg.active.postMessage({ type: 'START_ALARM_CHECK' });
            } catch (e) { console.error('SW registration failed:', e); }
        }

        // インストールプロンプト
        window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); App._deferredPrompt = e; });

        // Gemini APIキー読み込み
        const apiKey = await StorageManager.settings.get('geminiApiKey');
        if (apiKey) {
            GeminiClient.setApiKey(apiKey);
            updateApiKeyStatus();
        }

        // データ読み込みとUI描画
        await loadContacts();
        renderHome();
        setupEventListeners();

        // URLパラメータ処理（通知クリックなど）
        const params = new URLSearchParams(location.search);
        if (params.get('action') === 'new') showScreen('new');
        if (params.get('contact')) {
            const id = params.get('contact');
            openContact(id);
        }

        // SW からのナビゲーションメッセージ
        navigator.serviceWorker?.addEventListener('message', e => {
            if (e.data.type === 'NAVIGATE') {
                const url = new URL(e.data.url, location.origin);
                const cId = url.searchParams.get('contact');
                if (cId) openContact(cId);
            }
        });
    }

    async function loadContacts() {
        contacts = await StorageManager.contacts.getAll();
        contacts.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    }

    /* ----- ナビゲーション ----- */
    function showScreen(name) {
        document.querySelectorAll('.screen').forEach(el => el.classList.remove('active'));
        document.getElementById(`screen-${name}`)?.classList.add('active');
        document.querySelectorAll('.nav-item').forEach(el => {
            el.classList.toggle('active', el.dataset.screen === name);
        });
        currentScreen = name;

        switch (name) {
            case 'home': renderHome(); break;
            case 'search': renderSearch(); break;
            case 'detail': renderDetail(); break;
            case 'settings': renderSettings(); break;
        }
    }

    function openContact(id) {
        currentContactId = id;
        showScreen('detail');
    }

    /* ----- ホーム画面 ----- */
    function renderHome() {
        const now = Date.now();
        // 今後の商談（直近）
        const upcomingMeetings = contacts
            .flatMap(c => (c.meetings || []).map(m => ({ ...m, contact: c })))
            .filter(m => m.time > now)
            .sort((a, b) => a.time - b.time);

        const today = upcomingMeetings.find(m => {
            const d = new Date(m.time);
            const n = new Date();
            return d.toDateString() === n.toDateString();
        });

        // バナー
        const bannerEl = document.getElementById('today-banner');
        if (today) {
            bannerEl.style.display = 'flex';
            document.getElementById('banner-name').textContent = today.contact.name;
            document.getElementById('banner-company').textContent = today.contact.company || '';
            document.getElementById('banner-time').textContent =
                new Date(today.time).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }) +
                ' 商談予定';
            bannerEl.onclick = () => openContact(today.contact.id);
        } else {
            bannerEl.style.display = 'none';
        }

        // 統計
        document.getElementById('stat-contacts').textContent = contacts.length;
        document.getElementById('stat-meetings').textContent = upcomingMeetings.length;

        // 最近のコンタクト一覧
        const list = document.getElementById('home-contact-list');
        if (contacts.length === 0) {
            list.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">⚔️</div>
          <div class="empty-state-title">人脈リストは空です</div>
          <div class="empty-state-desc">「＋」ボタンから最初のコンタクトを登録して、戦略参謀を起動しましょう。</div>
        </div>`;
            return;
        }

        list.innerHTML = contacts.map(c => contactCardHTML(c)).join('');
        list.querySelectorAll('.contact-card').forEach(el => {
            el.addEventListener('click', () => openContact(el.dataset.id));
        });
    }

    function contactCardHTML(c) {
        const initials = (c.name || '?')[0];
        const hasMeeting = (c.meetings || []).some(m => m.time > Date.now());
        const tags = [
            ...(c.jirai || []).slice(0, 1).map(t => `<span class="tag tag-jirai">💣 ${t.slice(0, 10)}</span>`),
            ...(c.hook || []).slice(0, 1).map(t => `<span class="tag tag-hook">🎣 ${t.slice(0, 10)}</span>`),
            ...(c.next || []).slice(0, 1).map(t => `<span class="tag tag-next">⚡ ${t.slice(0, 10)}</span>`),
        ].join('');

        const nextMeeting = (c.meetings || [])
            .filter(m => m.time > Date.now())
            .sort((a, b) => a.time - b.time)[0];

        const meetingBadge = nextMeeting
            ? `<span class="meeting-badge">⚔️ ${new Date(nextMeeting.time).toLocaleDateString('ja-JP', { month: 'short', day: 'numeric' })}</span>`
            : '';

        return `
      <button class="contact-card ${hasMeeting ? 'has-meeting' : ''}" data-id="${c.id}">
        <div class="contact-avatar ${c.cardImage ? 'has-card' : ''}" style="${c.avatarColor ? `background:${c.avatarColor}` : ''}">
          ${c.avatarImage ? `<img src="${c.avatarImage}" alt="">` : initials}
        </div>
        <div class="contact-info">
          <div class="contact-name">${esc(c.name)}</div>
          <div class="contact-company">${esc(c.company || '')} ${c.title ? `・${esc(c.title)}` : ''}</div>
          <div class="contact-tags">${tags}</div>
        </div>
        ${meetingBadge}
      </button>`;
    }

    /* ----- 詳細画面 ----- */
    function renderDetail() {
        const c = contacts.find(x => x.id === currentContactId);
        if (!c) { showScreen('home'); return; }

        const initials = (c.name || '?')[0];
        document.getElementById('detail-avatar').innerHTML =
            c.avatarImage ? `<img src="${c.avatarImage}" alt="">` : initials;
        document.getElementById('detail-name').textContent = c.name || '';
        document.getElementById('detail-company').textContent = c.company || '';
        document.getElementById('detail-pos').textContent = [c.department, c.title].filter(Boolean).join(' / ');

        // 名刺画像
        const cardImgEl = document.getElementById('card-image-area');
        if (c.cardImage) {
            cardImgEl.innerHTML = `<img src="${c.cardImage}" alt="名刺" style="width:100%;border-radius:12px">`;
        } else {
            cardImgEl.innerHTML = `<div class="card-image-placeholder"><div class="ph-icon">📇</div><div>名刺画像なし</div></div>`;
        }

        // 4分類レンダリング
        render4Section('jirai', c.jirai || [], '💣 地雷', '触れてはいけない話題を追加...');
        render4Section('hook', c.hook || [], '🎣 フック', '懐に入るネタを追加...');
        render4Section('map', c.map || [], '🕸️ 相関図', '組織の人間関係を追加...');
        render4Section('next', c.next || [], '⚡ 次の一手', '次回の具体的アクションを追加...');

        // 商談予定
        renderMeetings(c);

        // AI分析パネル
        renderAIPanel(c);
    }

    function render4Section(type, items, label, placeholder) {
        const body = document.getElementById(`section-body-${type}`);
        const count = document.getElementById(`section-count-${type}`);
        count.textContent = items.length;

        const itemsHTML = items.map((text, idx) => `
      <div class="section-item">
        <div class="section-item-text">${esc(text)}</div>
        <button class="section-item-del" onclick="App.deleteItem('${type}',${idx})" title="削除">✕</button>
      </div>`).join('');

        body.innerHTML = itemsHTML + `
      <button class="section-add-btn" onclick="App.startAddItem('${type}', '${esc(placeholder)}')">
        ＋ 追加
      </button>`;
    }

    function renderMeetings(c) {
        const meetings = (c.meetings || []).sort((a, b) => a.time - b.time);
        const listEl = document.getElementById('meeting-list');
        const now = Date.now();

        if (meetings.length === 0) {
            listEl.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:8px 0">商談予定なし</div>';
            return;
        }

        listEl.innerHTML = meetings.map((m, i) => {
            const past = m.time < now;
            const dt = new Date(m.time);
            return `
        <div class="meeting-item" style="${past ? 'opacity:0.4' : ''}">
          <div class="meeting-dot" style="${past ? 'background:var(--text-muted);box-shadow:none' : ''}"></div>
          <div class="meeting-item-info">
            <div class="meeting-item-label">${past ? '終了' : '予定'}</div>
            <div class="meeting-item-time">${dt.toLocaleString('ja-JP', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
          </div>
          <button class="meeting-item-del" onclick="App.deleteMeeting(${i})" title="削除">✕</button>
        </div>`;
        }).join('');
    }

    function renderAIPanel(c) {
        const panel = document.getElementById('ai-panel');
        if (!GeminiClient.isConfigured()) {
            panel.style.display = 'none';
            return;
        }
        panel.style.display = 'block';
        const content = document.getElementById('ai-panel-content');
        const btn = document.getElementById('ai-briefing-btn');
        content.innerHTML = 'ブリーフィングを生成するには「分析」をタップしてください。';
        btn.onclick = async () => {
            content.innerHTML = '<div class="ai-panel-loading"><div class="ai-dot"></div><div class="ai-dot"></div><div class="ai-dot"></div></div>';
            try {
                const result = await GeminiClient.generateBriefing(c);
                content.textContent = result;
            } catch (e) {
                content.textContent = `エラー: ${e.message}`;
            }
        };
    }

    /* ----- 検索画面 ----- */
    function renderSearch() {
        const q = searchQuery.toLowerCase();
        const category = filterTag;

        let results = contacts.filter(c => {
            if (q) {
                const target = [
                    c.name, c.company, c.title, c.department,
                    ...(c.jirai || []),
                    ...(c.hook || []),
                    ...(c.map || []),
                    ...(c.next || []),
                ].join(' ').toLowerCase();
                if (!target.includes(q)) return false;
            }
            if (category === 'jirai') return (c.jirai || []).length > 0;
            if (category === 'hook') return (c.hook || []).length > 0;
            if (category === 'map') return (c.map || []).length > 0;
            if (category === 'next') return (c.next || []).length > 0;
            if (category === 'meeting') return (c.meetings || []).some(m => m.time > Date.now());
            return true;
        });

        const list = document.getElementById('search-results');
        if (results.length === 0) {
            list.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">🔍</div>
          <div class="empty-state-title">該当なし</div>
          <div class="empty-state-desc">検索条件を変えてお試しください。</div>
        </div>`;
        } else {
            list.innerHTML = results.map(c => contactCardHTML(c)).join('');
            list.querySelectorAll('.contact-card').forEach(el => {
                el.addEventListener('click', () => openContact(el.dataset.id));
            });
        }

        document.getElementById('search-count').textContent = `${results.length}件`;
    }

    /* ----- 設定画面 ----- */
    function renderSettings() {
        updateApiKeyStatus();
        document.getElementById('sw-status').textContent =
            'serviceWorker' in navigator ? '有効' : '非対応';
        document.getElementById('notif-status').textContent = NotificationManager.getPermission() === 'granted' ? '許可済' : '未許可';
    }

    function updateApiKeyStatus() {
        const el = document.getElementById('api-key-status');
        if (!el) return;
        if (GeminiClient.isConfigured()) {
            el.textContent = '✓ 接続済';
            el.className = 'api-key-status connected';
        } else {
            el.textContent = '未設定';
            el.className = 'api-key-status disconnected';
        }
    }

    /* ----- イベントリスナー ----- */
    function setupEventListeners() {
        // ボトムナビ
        document.querySelectorAll('.nav-item[data-screen]').forEach(btn => {
            btn.addEventListener('click', () => showScreen(btn.dataset.screen));
        });

        // FAB（新規登録）
        document.getElementById('fab-new').addEventListener('click', () => {
            resetNewForm();
            showScreen('new');
        });

        // 戻るボタン
        document.getElementById('btn-back-detail').addEventListener('click', () => showScreen('home'));
        document.getElementById('btn-back-new').addEventListener('click', () => showScreen('home'));

        // 検索
        const searchInput = document.getElementById('search-input');
        searchInput.addEventListener('input', () => {
            searchQuery = searchInput.value;
            renderSearch();
        });
        document.querySelectorAll('.filter-chip').forEach(chip => {
            chip.addEventListener('click', () => {
                document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
                chip.classList.add('active');
                filterTag = chip.dataset.filter;
                renderSearch();
            });
        });

        // 新規登録: カメラ
        document.getElementById('camera-area').addEventListener('click', () => {
            document.getElementById('file-input').click();
        });
        document.getElementById('file-input').addEventListener('change', handleCardImage);

        // 新規登録: 音声メモ
        document.getElementById('voice-btn-new').addEventListener('click', () => toggleVoice(
            document.getElementById('voice-memo-new'),
            document.getElementById('voice-btn-new')
        ));

        // 詳細: 商談追加
        document.getElementById('btn-add-meeting').addEventListener('click', showAddMeetingModal);

        // 詳細: 編集ボタン
        document.getElementById('btn-edit-contact').addEventListener('click', showEditModal);

        // 詳細: 削除ボタン
        document.getElementById('btn-delete-contact').addEventListener('click', async () => {
            if (!confirm(`${contacts.find(c => c.id === currentContactId)?.name || ''}を削除しますか？`)) return;
            await StorageManager.contacts.delete(currentContactId);
            await loadContacts();
            showScreen('home');
            toast('削除しました');
        });

        // 詳細: 音声メモ
        document.getElementById('voice-btn-detail').addEventListener('click', () => toggleVoice(
            document.getElementById('voice-memo-detail'),
            document.getElementById('voice-btn-detail')
        ));

        // 詳細: AIメモ解析
        document.getElementById('btn-analyze-memo').addEventListener('click', analyzeMemo);

        // 詳細: メモ保存
        document.getElementById('btn-save-memo').addEventListener('click', saveMemo);

        // 新規保存
        document.getElementById('btn-save-new').addEventListener('click', saveNewContact);

        // 設定: APIキー変更
        document.getElementById('btn-set-apikey').addEventListener('click', showApiKeyModal);

        // 設定: 通知許可
        document.getElementById('btn-request-notif').addEventListener('click', async () => {
            const ok = await NotificationManager.requestPermission();
            toast(ok ? '通知を許可しました' : '通知が拒否されました');
            renderSettings();
        });

        // モーダル閉じる
        document.getElementById('modal-overlay').addEventListener('click', e => {
            if (e.target === document.getElementById('modal-overlay')) closeModal();
        });
    }

    /* ----- 音声入力 ----- */
    function toggleVoice(targetEl, btnEl) {
        if (VoiceManager.isActive()) {
            VoiceManager.stop();
            btnEl.classList.remove('recording');
            btnEl.innerHTML = '🎙️ 音声入力';
        } else {
            voiceTargetEl = targetEl;
            voiceAccumulated = targetEl.value || '';
            VoiceManager.start(
                ({ interim, final }) => {
                    targetEl.value = voiceAccumulated + final + interim;
                },
                () => {
                    voiceAccumulated = targetEl.value;
                    btnEl.classList.remove('recording');
                    btnEl.innerHTML = '🎙️ 音声入力';
                }
            );
            btnEl.classList.add('recording');
            btnEl.innerHTML = '⏹️ 停止';
        }
    }

    /* ----- 名刺画像 ----- */
    async function handleCardImage(e) {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async ev => {
            const dataUrl = ev.target.result;
            // プレビュー
            const area = document.getElementById('camera-area');
            area.innerHTML = `<img src="${dataUrl}" alt="名刺"><button class="camera-change" onclick="document.getElementById('file-input').click();event.stopPropagation()">変更</button>`;
            document.getElementById('new-card-image').value = dataUrl;

            // Gemini OCR（APIキー設定時のみ）
            if (GeminiClient.isConfigured()) {
                toast('🔍 名刺を解析中...');
                try {
                    const base64 = dataUrl.split(',')[1];
                    const mime = file.type;
                    const info = await GeminiClient.extractBusinessCard(base64, mime);
                    // フォームに自動入力
                    if (info.name) document.getElementById('new-name').value = info.name;
                    if (info.company) document.getElementById('new-company').value = info.company;
                    if (info.title) document.getElementById('new-title').value = info.title;
                    if (info.department) document.getElementById('new-dept').value = info.department;
                    if (info.email) document.getElementById('new-email').value = info.email;
                    if (info.phone) document.getElementById('new-phone').value = info.phone;
                    if (info.firstImpressionAdvice) {
                        const memoEl = document.getElementById('voice-memo-new');
                        memoEl.value = (memoEl.value ? memoEl.value + '\n' : '') + `[AIアドバイス] ${info.firstImpressionAdvice}`;
                    }
                    toast('✓ 名刺情報を自動入力しました');
                } catch (err) {
                    toast(`OCRエラー: ${err.message}`);
                }
            }
        };
        reader.readAsDataURL(file);
        e.target.value = '';
    }

    /* ----- メモ解析（AI） ----- */
    async function analyzeMemo() {
        const memoEl = document.getElementById('voice-memo-detail');
        const text = memoEl.value.trim();
        if (!text) { toast('メモを入力してください'); return; }

        const c = contacts.find(x => x.id === currentContactId);
        if (!GeminiClient.isConfigured()) {
            toast('Gemini APIキーが未設定です');
            return;
        }

        const btn = document.getElementById('btn-analyze-memo');
        btn.textContent = '分析中...';
        btn.disabled = true;

        try {
            const result = await GeminiClient.classifyMemo(text, c);
            // 4分類にマージ
            c.jirai = [...new Set([...(c.jirai || []), ...(result.jirai || [])])];
            c.hook = [...new Set([...(c.hook || []), ...(result.hook || [])])];
            c.map = [...new Set([...(c.map || []), ...(result.map || [])])];
            c.next = [...new Set([...(c.next || []), ...(result.next || [])])];
            c.updatedAt = Date.now();
            await StorageManager.contacts.put(c);
            await loadContacts();
            renderDetail();
            memoEl.value = '';
            toast('✓ メモをAIが分類しました');
        } catch (e) {
            toast(`エラー: ${e.message}`);
        } finally {
            btn.textContent = '🤖 AIで分類';
            btn.disabled = false;
        }
    }

    /* ----- メモ手動保存 ----- */
    async function saveMemo() {
        const text = document.getElementById('voice-memo-detail').value.trim();
        if (!text) { toast('メモを入力してください'); return; }

        const c = contacts.find(x => x.id === currentContactId);
        c.memos = [...(c.memos || []), { text, createdAt: Date.now() }];
        c.updatedAt = Date.now();
        await StorageManager.contacts.put(c);
        await loadContacts();
        document.getElementById('voice-memo-detail').value = '';
        toast('✓ メモを保存しました');
    }

    /* ----- 4分類アイテム CRUD ----- */
    async function deleteItem(type, idx) {
        const c = contacts.find(x => x.id === currentContactId);
        if (!c) return;
        c[type] = (c[type] || []).filter((_, i) => i !== idx);
        c.updatedAt = Date.now();
        await StorageManager.contacts.put(c);
        await loadContacts();
        render4Section(type, c[type], '', '');
        document.getElementById(`section-count-${type}`).textContent = c[type].length;
    }

    function startAddItem(type, placeholder) {
        const icons = { jirai: '💣', hook: '🎣', map: '🕸️', next: '⚡' };
        const labels = { jirai: '地雷を追加', hook: 'フックを追加', map: '相関図を追加', next: '次の一手を追加' };
        showInputModal(icons[type] + ' ' + labels[type], placeholder, async text => {
            const c = contacts.find(x => x.id === currentContactId);
            if (!c) return;
            c[type] = [...(c[type] || []), text];
            c.updatedAt = Date.now();
            await StorageManager.contacts.put(c);
            await loadContacts();
            render4Section(type, c[type], '', '');
            document.getElementById(`section-count-${type}`).textContent = c[type].length;
        });
    }

    /* ----- 商談追加 ----- */
    function showAddMeetingModal() {
        const now = new Date();
        const defaultVal = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 16);
        showInputModal('⚔️ 商談予定を追加', '', async dateStr => {
            const time = new Date(dateStr).getTime();
            if (isNaN(time)) { toast('日時が正しくありません'); return; }
            const c = contacts.find(x => x.id === currentContactId);
            if (!c) return;
            c.meetings = [...(c.meetings || []), { time }];
            c.updatedAt = Date.now();
            await StorageManager.contacts.put(c);
            // 通知スケジュール
            if (NotificationManager.getPermission() === 'granted') {
                await NotificationManager.scheduleAlarm(c.id, c.name, time);
            }
            await loadContacts();
            renderMeetings(contacts.find(x => x.id === currentContactId));
            toast('✓ 商談予定を追加しました');
        }, 'datetime-local', defaultVal);
    }

    async function deleteMeeting(idx) {
        const c = contacts.find(x => x.id === currentContactId);
        if (!c) return;
        const m = c.meetings[idx];
        if (m) await NotificationManager.cancelAlarm(c.id, m.time);
        c.meetings = (c.meetings || []).filter((_, i) => i !== idx);
        c.updatedAt = Date.now();
        await StorageManager.contacts.put(c);
        await loadContacts();
        renderMeetings(contacts.find(x => x.id === currentContactId));
        toast('削除しました');
    }

    /* ----- 新規コンタクト保存 ----- */
    async function saveNewContact() {
        const name = document.getElementById('new-name').value.trim();
        if (!name) { toast('氏名は必須です'); document.getElementById('new-name').focus(); return; }

        const memo = document.getElementById('voice-memo-new').value.trim();
        const cardImage = document.getElementById('new-card-image').value;
        const avatarColors = ['linear-gradient(135deg,#2c2c4a,#3a3a5c)', 'linear-gradient(135deg,#1a2c1a,#2c4a2c)', 'linear-gradient(135deg,#2c1a1a,#4a2c2c)', 'linear-gradient(135deg,#1a1a2c,#2c2c4a)', 'linear-gradient(135deg,#2c2a1a,#4a402c)'];

        const newContact = {
            id: 'c_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
            name,
            company: document.getElementById('new-company').value.trim(),
            title: document.getElementById('new-title').value.trim(),
            department: document.getElementById('new-dept').value.trim(),
            email: document.getElementById('new-email').value.trim(),
            phone: document.getElementById('new-phone').value.trim(),
            cardImage: cardImage || null,
            jirai: [], hook: [], map: [], next: [],
            memos: memo ? [{ text: memo, createdAt: Date.now() }] : [],
            meetings: [],
            avatarColor: avatarColors[Math.floor(Math.random() * avatarColors.length)],
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };

        await StorageManager.contacts.put(newContact);

        // Gemini でメモを分類（オプション）
        if (memo && GeminiClient.isConfigured()) {
            toast('🤖 メモをAIで分類中...');
            try {
                const result = await GeminiClient.classifyMemo(memo, newContact);
                newContact.jirai = result.jirai || [];
                newContact.hook = result.hook || [];
                newContact.map = result.map || [];
                newContact.next = result.next || [];
                await StorageManager.contacts.put(newContact);
            } catch (e) { console.warn('AI分類失敗:', e); }
        }

        await loadContacts();
        currentContactId = newContact.id;
        showScreen('detail');
        toast('✓ 登録しました');
    }

    function resetNewForm() {
        document.getElementById('new-name').value = '';
        document.getElementById('new-company').value = '';
        document.getElementById('new-title').value = '';
        document.getElementById('new-dept').value = '';
        document.getElementById('new-email').value = '';
        document.getElementById('new-phone').value = '';
        document.getElementById('new-card-image').value = '';
        document.getElementById('voice-memo-new').value = '';
        document.getElementById('camera-area').innerHTML = `
      <div class="camera-icon">📷</div>
      <div class="camera-label">名刺を撮影 / 選択</div>`;
    }

    /* ----- 編集モーダル ----- */
    function showEditModal() {
        const c = contacts.find(x => x.id === currentContactId);
        if (!c) return;
        const overlay = document.getElementById('modal-overlay');
        const sheet = document.getElementById('modal-sheet');
        sheet.innerHTML = `
      <div class="modal-handle"></div>
      <div class="modal-title">✏️ 基本情報を編集</div>
      <div class="form-group"><div class="form-label">氏名 *</div><input class="form-input" id="edit-name" value="${esc(c.name)}"></div>
      <div class="form-group"><div class="form-label">会社名</div><input class="form-input" id="edit-company" value="${esc(c.company || '')}"></div>
      <div class="form-row">
        <div class="form-group"><div class="form-label">役職</div><input class="form-input" id="edit-title" value="${esc(c.title || '')}"></div>
        <div class="form-group"><div class="form-label">部署</div><input class="form-input" id="edit-dept" value="${esc(c.department || '')}"></div>
      </div>
      <div class="form-group"><div class="form-label">メール</div><input class="form-input" type="email" id="edit-email" value="${esc(c.email || '')}"></div>
      <div class="form-group"><div class="form-label">電話</div><input class="form-input" type="tel" id="edit-phone" value="${esc(c.phone || '')}"></div>
      <div style="margin-top:8px">
        <button class="btn-primary" id="edit-save-btn">保存</button>
      </div>`;
        overlay.classList.remove('hidden');
        document.getElementById('edit-save-btn').addEventListener('click', async () => {
            const name = document.getElementById('edit-name').value.trim();
            if (!name) { toast('氏名は必須です'); return; }
            c.name = name;
            c.company = document.getElementById('edit-company').value.trim();
            c.title = document.getElementById('edit-title').value.trim();
            c.department = document.getElementById('edit-dept').value.trim();
            c.email = document.getElementById('edit-email').value.trim();
            c.phone = document.getElementById('edit-phone').value.trim();
            c.updatedAt = Date.now();
            await StorageManager.contacts.put(c);
            await loadContacts();
            closeModal();
            renderDetail();
            toast('✓ 保存しました');
        });
    }

    /* ----- APIキーモーダル ----- */
    function showApiKeyModal() {
        const overlay = document.getElementById('modal-overlay');
        const sheet = document.getElementById('modal-sheet');
        const current = GeminiClient.getApiKey() || '';
        sheet.innerHTML = `
      <div class="modal-handle"></div>
      <div class="modal-title">🔑 Gemini APIキー設定</div>
      <div style="font-size:13px;color:var(--text-secondary);margin-bottom:16px;line-height:1.7">
        <a href="https://aistudio.google.com/app/apikey" target="_blank" style="color:var(--gold)">Google AI Studio</a> でAPIキーを取得できます。
        キーはこのデバイスのブラウザにのみ保存されます。
      </div>
      <div class="form-group">
        <div class="form-label">APIキー</div>
        <input class="form-input" id="modal-apikey" type="password" placeholder="AIza..." value="${esc(current)}" autocomplete="off">
      </div>
      <div style="display:flex;gap:8px;margin-top:8px">
        <button class="btn-secondary" id="modal-clear-apikey" style="flex:1">クリア</button>
        <button class="btn-primary" id="modal-save-apikey" style="flex:2">保存</button>
      </div>`;
        overlay.classList.remove('hidden');

        document.getElementById('modal-save-apikey').addEventListener('click', async () => {
            const key = document.getElementById('modal-apikey').value.trim();
            GeminiClient.setApiKey(key);
            await StorageManager.settings.set('geminiApiKey', key);
            updateApiKeyStatus();
            closeModal();
            toast(key ? '✓ APIキーを設定しました' : 'APIキーをクリアしました');
        });

        document.getElementById('modal-clear-apikey').addEventListener('click', async () => {
            document.getElementById('modal-apikey').value = '';
            GeminiClient.setApiKey('');
            await StorageManager.settings.set('geminiApiKey', '');
            updateApiKeyStatus();
            closeModal();
            toast('APIキーをクリアしました');
        });
    }

    /* ----- 汎用インプットモーダル ----- */
    function showInputModal(title, placeholder, onConfirm, inputType = 'text', defaultValue = '') {
        const overlay = document.getElementById('modal-overlay');
        const sheet = document.getElementById('modal-sheet');
        sheet.innerHTML = `
      <div class="modal-handle"></div>
      <div class="modal-title">${title}</div>
      <div class="form-group">
        <input class="form-input" id="modal-input" type="${inputType}" placeholder="${placeholder}" value="${esc(defaultValue)}" autocomplete="off">
      </div>
      <div style="display:flex;gap:8px;margin-top:8px">
        <button class="btn-secondary" id="modal-cancel" style="flex:1">キャンセル</button>
        <button class="btn-primary" id="modal-confirm" style="flex:2">追加</button>
      </div>`;
        overlay.classList.remove('hidden');
        setTimeout(() => document.getElementById('modal-input').focus(), 100);
        document.getElementById('modal-confirm').addEventListener('click', () => {
            const val = document.getElementById('modal-input').value.trim();
            if (!val) return;
            closeModal();
            onConfirm(val);
        });
        document.getElementById('modal-cancel').addEventListener('click', closeModal);
    }

    function closeModal() {
        document.getElementById('modal-overlay').classList.add('hidden');
    }

    /* ----- ユーティリティ ----- */
    function esc(str) {
        return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    let toastTimer = null;
    function toast(msg, duration = 2500) {
        const el = document.getElementById('toast');
        el.textContent = msg;
        el.classList.remove('hidden');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => el.classList.add('hidden'), duration);
    }

    /* ----- 公開API ----- */
    return {
        init, showScreen, openContact,
        deleteItem, startAddItem, deleteMeeting,
        _deferredPrompt: null,
    };
})();

// 起動
document.addEventListener('DOMContentLoaded', () => App.init());
