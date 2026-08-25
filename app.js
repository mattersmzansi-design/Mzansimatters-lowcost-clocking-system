/* Mzansi Money Matters — Clocking System PWA
 * Low-cost clock-in for cell phones. GPS + timestamp + optional geofence.
 * Data goes to a Google Apps Script webhook (configurable), and is queued
 * locally in IndexedDB when offline so nothing is lost.
 */
'use strict';

const LS = {
    worker: 'sqclk.worker',
    settings: 'sqclk.settings',
    deviceId: 'sqclk.device'
};

const DEFAULTS = {
    siteName: '',
    endpoint: '',
    geoLat: null,
    geoLng: null,
    geoRadius: null
};

const $ = (id) => document.getElementById(id);

/* ---------- Persistence: settings + worker profile ---------- */

function loadSettings() {
    try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(LS.settings) || '{}') }; }
    catch { return { ...DEFAULTS }; }
}
function saveSettings(s) { localStorage.setItem(LS.settings, JSON.stringify(s)); }

function loadWorker() {
    try { return JSON.parse(localStorage.getItem(LS.worker) || '{}'); }
    catch { return {}; }
}
function saveWorker(w) { localStorage.setItem(LS.worker, JSON.stringify(w)); }

function deviceId() {
    let id = localStorage.getItem(LS.deviceId);
    if (!id) {
        id = 'dev_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
        localStorage.setItem(LS.deviceId, id);
    }
    return id;
}

/* ---------- Local log (IndexedDB) ---------- */

const DB_NAME = 'sqclk-db';
const DB_VERSION = 1;
const STORE = 'events';

function openDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE)) {
                const os = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
                os.createIndex('client_time', 'client_time');
                os.createIndex('synced', 'synced');
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function dbAdd(record) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const req = tx.objectStore(STORE).add(record);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}
async function dbUpdate(id, patch) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        const g = store.get(id);
        g.onsuccess = () => {
            const rec = { ...g.result, ...patch };
            const p = store.put(rec);
            p.onsuccess = () => resolve(rec);
            p.onerror = () => reject(p.error);
        };
        g.onerror = () => reject(g.error);
    });
}
async function dbAll() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}
async function dbUnsynced() {
    const all = await dbAll();
    return all.filter(r => !r.synced);
}

/* ---------- Geo helpers ---------- */

function getLocation() {
    return new Promise((resolve, reject) => {
        if (!('geolocation' in navigator)) {
            reject(new Error('Location not supported on this device.'));
            return;
        }
        navigator.geolocation.getCurrentPosition(
            (p) => resolve({
                lat: p.coords.latitude,
                lng: p.coords.longitude,
                accuracy_m: Math.round(p.coords.accuracy || 0)
            }),
            (err) => reject(err),
            { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
        );
    });
}

// Haversine metres
function distanceM(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const toRad = (d) => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat/2)**2 +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng/2)**2;
    return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)));
}

/* ---------- Network sync ---------- */

async function postToEndpoint(url, payload) {
    // Use text/plain to skip CORS preflight — Apps Script accepts it and can
    // still parse JSON from e.postData.contents.
    const res = await fetch(url, {
        method: 'POST',
        mode: 'cors',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.text();
}

async function trySyncAll() {
    const s = loadSettings();
    if (!s.endpoint) return { attempted: 0, synced: 0 };
    if (!navigator.onLine) return { attempted: 0, synced: 0 };

    const pending = await dbUnsynced();
    let synced = 0;
    for (const rec of pending) {
        try {
            await postToEndpoint(s.endpoint, rec.payload);
            await dbUpdate(rec.id, { synced: true, synced_at: new Date().toISOString() });
            synced++;
        } catch (e) {
            // Stop early on network failure to avoid hammering
            break;
        }
    }
    return { attempted: pending.length, synced };
}

/* ---------- UI: clock, log, status ---------- */

function tickClock() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    $('clockNow').textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    $('clockDate').textContent = now.toLocaleDateString(undefined, {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    });
}

function setStatus(msg, kind /* 'ok'|'warn'|'err' */) {
    const el = $('status');
    el.textContent = msg;
    el.className = 'status show ' + kind;
    if (kind === 'ok') {
        setTimeout(() => { el.className = 'status'; }, 4500);
    }
}

async function refreshLog() {
    const list = $('logList');
    const all = (await dbAll()).slice().reverse().slice(0, 12);
    if (!all.length) {
        list.innerHTML = '<li class="empty">No clocks yet on this device.</li>';
        $('queueNote').hidden = true;
        return;
    }
    list.innerHTML = '';
    for (const r of all) {
        const li = document.createElement('li');
        const when = new Date(r.client_time);
        const timeStr = when.toLocaleString(undefined, { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' });
        const badges = [];
        if (!r.synced) badges.push('<span class="badge pending" title="Waiting to sync">pending</span>');
        if (r.payload && r.payload.in_fence === false) badges.push('<span class="badge outside" title="Outside geofence">outside</span>');
        li.innerHTML = `
            <span class="tag ${r.payload.action.toLowerCase()}">${r.payload.action}</span>
            <span>${escapeHtml(r.payload.worker_name || 'Unknown')} ${badges.join(' ')}</span>
            <span class="time">${timeStr}</span>
        `;
        list.appendChild(li);
    }
    const pendingCount = (await dbUnsynced()).length;
    if (pendingCount > 0) {
        $('queueNote').hidden = false;
        $('queueNote').textContent = `${pendingCount} clock${pendingCount>1?'s':''} waiting to sync.`;
    } else {
        $('queueNote').hidden = true;
    }
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
        '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
}

function updateSiteLabel() {
    const s = loadSettings();
    $('clockSite').textContent = s.siteName ? s.siteName : 'No site configured';
}

function updateNetIndicator() {
    const el = $('netStatus');
    if (navigator.onLine) { el.textContent = '● online'; el.className = ''; }
    else { el.textContent = '● offline — clocks will queue'; el.className = 'offline'; }
}

/* ---------- Clock action handler ---------- */

async function clockAction(action /* 'IN' | 'OUT' */) {
    const worker = loadWorker();
    if (!worker.name || !worker.id) {
        setStatus('Enter your name and worker ID first.', 'err');
        $('workerName').focus();
        return;
    }
    const s = loadSettings();
    setStatus('Getting location…', 'warn');
    $('btn-in').disabled = true; $('btn-out').disabled = true;

    let loc = null, geoErr = null;
    try {
        loc = await getLocation();
    } catch (e) {
        geoErr = e && e.message ? e.message : 'Location unavailable';
    }

    let distance_m = null, in_fence = null;
    if (loc && s.geoLat != null && s.geoLng != null && s.geoRadius) {
        distance_m = distanceM(loc.lat, loc.lng, +s.geoLat, +s.geoLng);
        in_fence = distance_m <= +s.geoRadius;
    }

    const payload = {
        worker_name: worker.name,
        worker_id: worker.id,
        action,
        lat: loc ? loc.lat : null,
        lng: loc ? loc.lng : null,
        accuracy_m: loc ? loc.accuracy_m : null,
        distance_m,
        in_fence,
        site: s.siteName || null,
        device_id: deviceId(),
        client_time: new Date().toISOString(),
        geo_error: geoErr
    };

    const rec = {
        client_time: payload.client_time,
        synced: false,
        payload
    };
    const id = await dbAdd(rec);

    // Try to sync now
    let syncedNow = false;
    if (s.endpoint && navigator.onLine) {
        try {
            await postToEndpoint(s.endpoint, payload);
            await dbUpdate(id, { synced: true, synced_at: new Date().toISOString() });
            syncedNow = true;
        } catch (e) {
            // stays queued
        }
    }

    await refreshLog();
    $('btn-in').disabled = false; $('btn-out').disabled = false;

    let msg = `Clocked ${action}`;
    if (in_fence === false) msg += ` — outside geofence (${distance_m} m from site)`;
    else if (loc) msg += ` — location ±${loc.accuracy_m} m`;
    else if (geoErr) msg += ' — no location captured';

    if (!s.endpoint) msg += ' · stored on device only';
    else if (!syncedNow) msg += ' · queued (will sync when online)';
    else msg += ' · synced';

    setStatus(msg, (in_fence === false || geoErr) ? 'warn' : 'ok');
}

/* ---------- CSV export ---------- */

async function exportCsv() {
    const all = await dbAll();
    if (!all.length) { setStatus('Nothing to export yet.', 'warn'); return; }
    const cols = ['client_time','worker_name','worker_id','action','lat','lng','accuracy_m','distance_m','in_fence','site','device_id','synced'];
    const esc = (v) => {
        if (v == null) return '';
        const s = String(v);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g,'""') + '"' : s;
    };
    const rows = [cols.join(',')];
    for (const r of all) {
        const p = r.payload || {};
        rows.push([
            p.client_time, p.worker_name, p.worker_id, p.action,
            p.lat, p.lng, p.accuracy_m, p.distance_m, p.in_fence,
            p.site, p.device_id, r.synced ? 'yes' : 'no'
        ].map(esc).join(','));
    }
    const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `clocks_${new Date().toISOString().slice(0,10)}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
}

/* ---------- Settings modal ---------- */

function openSettings() {
    const s = loadSettings();
    $('siteName').value = s.siteName || '';
    $('endpoint').value = s.endpoint || '';
    $('geoLat').value = s.geoLat != null ? s.geoLat : '';
    $('geoLng').value = s.geoLng != null ? s.geoLng : '';
    $('geoRadius').value = s.geoRadius != null ? s.geoRadius : '';
    $('settings').hidden = false;
}
function closeSettings() { $('settings').hidden = true; }

async function useHereForFence() {
    try {
        const loc = await getLocation();
        $('geoLat').value = loc.lat.toFixed(6);
        $('geoLng').value = loc.lng.toFixed(6);
        if (!$('geoRadius').value) $('geoRadius').value = Math.max(50, loc.accuracy_m * 2);
    } catch (e) {
        alert('Could not read location: ' + (e.message || 'unknown'));
    }
}
function saveSettingsFromForm() {
    const s = {
        siteName: $('siteName').value.trim(),
        endpoint: $('endpoint').value.trim(),
        geoLat: $('geoLat').value === '' ? null : parseFloat($('geoLat').value),
        geoLng: $('geoLng').value === '' ? null : parseFloat($('geoLng').value),
        geoRadius: $('geoRadius').value === '' ? null : parseInt($('geoRadius').value, 10)
    };
    saveSettings(s);
    updateSiteLabel();
    closeSettings();
    setStatus('Settings saved.', 'ok');
    trySyncAll().then(refreshLog);
}

/* ---------- Worker profile inputs ---------- */

function wireWorkerInputs() {
    const w = loadWorker();
    $('workerName').value = w.name || '';
    $('workerId').value = w.id || '';
    const persist = () => saveWorker({
        name: $('workerName').value.trim(),
        id: $('workerId').value.trim()
    });
    $('workerName').addEventListener('change', persist);
    $('workerId').addEventListener('change', persist);
    $('workerName').addEventListener('blur', persist);
    $('workerId').addEventListener('blur', persist);
}

/* ---------- Service worker ---------- */

function registerSw() {
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('sw.js').catch(() => {});
    }
}

/* ---------- Boot ---------- */

document.addEventListener('DOMContentLoaded', () => {
    wireWorkerInputs();
    updateSiteLabel();
    updateNetIndicator();
    tickClock();
    setInterval(tickClock, 1000);

    $('btn-in').addEventListener('click', () => clockAction('IN'));
    $('btn-out').addEventListener('click', () => clockAction('OUT'));
    $('btn-settings').addEventListener('click', openSettings);
    $('btn-close-settings').addEventListener('click', closeSettings);
    $('btn-save').addEventListener('click', saveSettingsFromForm);
    $('btn-use-here').addEventListener('click', useHereForFence);
    $('btn-export').addEventListener('click', exportCsv);

    window.addEventListener('online', () => { updateNetIndicator(); trySyncAll().then(refreshLog); });
    window.addEventListener('offline', updateNetIndicator);

    refreshLog();
    trySyncAll().then(refreshLog);
    registerSw();
});
