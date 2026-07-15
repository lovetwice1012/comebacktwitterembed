'use strict';

// booth.pm 商品「販売開始通知」のサブスクリプション永続化。
// データは ./data/booth_sale_notifications.json に保存。
//
// レコード形式:
//   {
//     id: string                   ランダム ID (重複防止)
//     itemId: string               booth item id
//     itemUrl: string              閲覧用 URL
//     userId: string               通知先ユーザー
//     guildId: string|null         登録元 (参考用)
//     channelId: string|null       登録元チャンネル (参考用)
//     language: 'ja'|'en'          通知文言
//     notifyAt: string             ISO datetime (販売開始時刻)
//     registeredAt: string         ISO datetime
//     notified: boolean            通知送信済みフラグ
//     attempts: number             通知送信失敗回数
//   }

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.resolve(process.cwd(), 'data');
const FILE = path.join(DATA_DIR, 'booth_sale_notifications.json');
const SAVE_DELAY_MS = 1000;
let cachedList = null;
let saveTimer = null;

function ensureFile() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, '[]', 'utf8');
}

function load() {
    if (cachedList) return cachedList;
    ensureFile();
    try {
        const raw = fs.readFileSync(FILE, 'utf8');
        const arr = JSON.parse(raw);
        cachedList = Array.isArray(arr) ? arr : [];
        return cachedList;
    } catch {
        cachedList = [];
        return cachedList;
    }
}

function save(list) {
    cachedList = list;
    ensureFile();
    fs.writeFileSync(FILE, JSON.stringify(list, null, 2), 'utf8');
}

function scheduleSave(list) {
    cachedList = list;
    if (saveTimer !== null) return;
    saveTimer = setTimeout(() => {
        saveTimer = null;
        save(cachedList || []);
    }, SAVE_DELAY_MS);
    if (typeof saveTimer.unref === 'function') saveTimer.unref();
}

function genId() {
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

/**
 * 重複登録 (同 user × 同 item × 未通知) があれば true。
 */
function hasActiveSubscription(userId, itemId) {
    return load().some(r => r.userId === userId && String(r.itemId) === String(itemId) && !r.notified);
}

function addSubscription(entry) {
    const list = load();
    const record = { id: genId(), notified: false, attempts: 0, registeredAt: new Date().toISOString(), ...entry };
    list.push(record);
    scheduleSave(list);
    return record;
}

/**
 * 通知すべきレコード (未通知 かつ notifyAt が now 以前) を返す。
 */
function findDue(now = new Date()) {
    const list = load();
    return list.filter(r => !r.notified && new Date(r.notifyAt) <= now);
}

function markNotified(id) {
    const list = load();
    const idx = list.findIndex(r => r.id === id);
    if (idx === -1) return;
    list[idx].notified = true;
    list[idx].notifiedAt = new Date().toISOString();
    scheduleSave(list);
}

function bumpAttempts(id) {
    const list = load();
    const idx = list.findIndex(r => r.id === id);
    if (idx === -1) return 0;
    list[idx].attempts = (list[idx].attempts || 0) + 1;
    scheduleSave(list);
    return list[idx].attempts;
}

function pruneOld(retentionMs = 30 * 24 * 60 * 60 * 1000, now = new Date()) {
    const list = load();
    const cutoff = now.getTime() - retentionMs;
    const next = list.filter(r => {
        if (!r.notified) return true;
        const ts = new Date(r.notifiedAt || r.registeredAt).getTime();
        return ts >= cutoff;
    });
    if (next.length !== list.length) scheduleSave(next);
}

module.exports = {
    FILE,
    load,
    save,
    addSubscription,
    hasActiveSubscription,
    findDue,
    markNotified,
    bumpAttempts,
    pruneOld,
    _internal: { scheduleSave },
};
