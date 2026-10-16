'use strict';

const { createHash, createHmac, timingSafeEqual, randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { lockOwner } = require('./entitlements');
const API_VERSION = '2026-09-16';
const ENV_KEYS = ['SQUARE_ENVIRONMENT', 'SQUARE_ACCESS_TOKEN', 'SQUARE_APPLICATION_ID', 'SQUARE_LOCATION_ID', 'SQUARE_MERCHANT_ID', 'SQUARE_WEBHOOK_SIGNATURE_KEY', 'SQUARE_WEBHOOK_NOTIFICATION_URL'];
const SQUARE_ID = /^[A-Za-z0-9:_-]{1,255}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CADENCES = new Set(['DAILY', 'WEEKLY', 'EVERY_TWO_WEEKS', 'THIRTY_DAYS', 'SIXTY_DAYS', 'NINETY_DAYS', 'MONTHLY', 'EVERY_TWO_MONTHS', 'QUARTERLY', 'EVERY_FOUR_MONTHS', 'EVERY_SIX_MONTHS', 'ANNUAL', 'EVERY_TWO_YEARS']);
const QUOTE_MS = 15 * 60 * 1000;
const LEASE_MS = 5 * 60 * 1000;
const REFRESH_MS = 30000;
const REFRESH_READ_LIMIT = 16;
const TERMINAL = new Set(['CANCELED', 'DEACTIVATED', 'COMPLETED']);
const RETRYABLE = new Set(['CUSTOMER_SUBMITTING', 'CUSTOMER_READY', 'CARD_SUBMITTING', 'CARD_STORED', 'SUBSCRIPTION_SUBMITTING']);
function fail(code, message, status = 400) { return Object.assign(new Error(message), { name: 'AutomationError', code, status }); }
function user(actor) {
    if (!/^\d{1,32}$/.test(String(actor?.userId || ''))) throw fail('AUTOMATION_AUTH_REQUIRED', 'ログインしてください。', 401);
    return String(actor.userId);
}
function administrator(actor) { const id = user(actor); if (actor.isAdmin !== true) throw fail('AUTOMATION_FORBIDDEN', '決済の設定には管理者権限が必要です。', 403); return id; }
function id(value) { if (!SQUARE_ID.test(String(value || ''))) throw fail('SQUARE_INVALID_INPUT', 'SquareのIDを確認してください。', 422); return String(value); }
function digest(value) { return createHash('sha256').update(value).digest('hex'); }
function key(value) { return digest(value).slice(0, 40); }
function isValidReceiptEmail(email) {
    if (typeof email !== 'string' || email.length > 254 || email.length === 0) return false;
    const at = email.indexOf('@');
    if (at <= 0 || at !== email.lastIndexOf('@') || /\s/.test(email)) return false;
    const domain = email.slice(at + 1), dot = domain.lastIndexOf('.');
    return dot > 0 && dot < domain.length - 1;
}
function readServerEnvironment() {
    let local;
    try { local = process.env.NODE_ENV === 'test' || process.env.NODE_TEST_CONTEXT ? {} : JSON.parse(readFileSync(resolve(__dirname, '../../config.json'), 'utf8')).square || {}; } catch { local = {}; }
    const fields = ['environment', 'accessToken', 'applicationId', 'locationId', 'merchantId', 'webhookSignatureKey', 'webhookNotificationUrl'];
    return Object.fromEntries(ENV_KEYS.map((name, index) => [name, process.env[name] !== undefined ? process.env[name] : local[fields[index]]]));
}
function config(env = readServerEnvironment()) {
    const missing = ENV_KEYS.filter(name => !env[name]);
    const environment = env.SQUARE_ENVIRONMENT;
    if (environment && !['sandbox', 'production'].includes(environment)) missing.push('SQUARE_ENVIRONMENT');
    for (const name of ['SQUARE_APPLICATION_ID', 'SQUARE_LOCATION_ID', 'SQUARE_MERCHANT_ID']) if (env[name] && !SQUARE_ID.test(env[name])) missing.push(name);
    try {
        const url = new URL(env.SQUARE_WEBHOOK_NOTIFICATION_URL);
        if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) missing.push('SQUARE_WEBHOOK_NOTIFICATION_URL');
    } catch { if (!missing.includes('SQUARE_WEBHOOK_NOTIFICATION_URL')) missing.push('SQUARE_WEBHOOK_NOTIFICATION_URL'); }
    return { configured: missing.length === 0, missing: [...new Set(missing)], environment: ['sandbox', 'production'].includes(environment) ? environment : null,
        accessToken: env.SQUARE_ACCESS_TOKEN, applicationId: env.SQUARE_APPLICATION_ID, locationId: env.SQUARE_LOCATION_ID,
        merchantId: env.SQUARE_MERCHANT_ID, signatureKey: env.SQUARE_WEBHOOK_SIGNATURE_KEY, notificationUrl: env.SQUARE_WEBHOOK_NOTIFICATION_URL,
        baseUrl: environment === 'sandbox' ? 'https://connect.squareupsandbox.com' : 'https://connect.squareup.com' };
}
function getSquareScope(env) { const c = config(env); return { configured: c.configured, environment: c.environment, merchantId: c.merchantId || null }; }
function bindingDto(row) { return { planId: row.plan_id, variationId: row.variation_id, enabled: Number(row.enabled) === 1,
    catalogName: row.catalog_name, cadence: row.cadence, amount: Number(row.amount), currency: row.currency, verifiedAtMs: Number(row.verified_at_ms) }; }
function planDto(row, binding) { return { planId: row.plan_id, label: row.label, slotLimit: Number(row.slot_limit), minuteLimit: Number(row.minute_limit), dayLimit: Number(row.day_limit), priority: Number(row.priority), ...bindingDto(binding) }; }
function dateEnd(date, timezone) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return null;
    const base = Date.parse(`${date}T00:00:00Z`);
    if (!Number.isFinite(base) || new Date(base).toISOString().slice(0, 10) !== date) return null;
    try {
        const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
        const wall = base + 86400000;
        let instant = wall;
        for (let i = 0; i < 4; i++) {
            const parts = Object.fromEntries(formatter.formatToParts(instant).map(part => [part.type, part.value]));
            const displayed = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
            const adjustment = wall - displayed; instant += adjustment;
            if (!adjustment) return instant;
        }
        return null;
    } catch { return null; }
}
function validateVariation(object, locationId) {
    const data = object?.subscription_plan_variation_data, phases = data?.phases;
    if (object?.type !== 'SUBSCRIPTION_PLAN_VARIATION' || object.is_deleted || !SQUARE_ID.test(object.id || '')
        || object.present_at_all_locations === false
        || !Array.isArray(phases) || phases.length !== 1 || (phases[0].periods !== undefined && phases[0].periods !== null)
        || !CADENCES.has(phases[0].cadence)) throw fail('SQUARE_PLAN_UNSUPPORTED', '固定料金の継続課金が1段階だけ設定されたSquareプランを選択してください。', 422);
    const pricing = phases[0].pricing;
    const money = pricing?.type === 'STATIC' ? pricing.price_money : !pricing ? phases[0].recurring_price_money : null;
    const amount = Number(money?.amount);
    if (!Number.isSafeInteger(amount) || amount <= 0 || !/^[A-Z]{3}$/.test(money?.currency || '') || !/^\d+$/.test(String(object.version || '')))
        throw fail('SQUARE_PLAN_UNSUPPORTED', 'Squareに固定の継続料金と通貨を設定してください。', 422);
    const billingAnchorDay = data.monthly_billing_anchor_date === undefined || data.monthly_billing_anchor_date === null ? null : Number(data.monthly_billing_anchor_date);
    if (billingAnchorDay !== null && (!Number.isSafeInteger(billingAnchorDay) || billingAnchorDay < 1 || billingAnchorDay > 31)) throw fail('SQUARE_PLAN_UNSUPPORTED', 'Squareの課金日を確認してください。', 422);
    return { variationId: object.id, catalogName: String(data.name || object.id).slice(0, 255), cadence: phases[0].cadence, amount, currency: money.currency, catalogVersion: String(object.version), billingAnchorDay, canProrate: data.can_prorate === true };
}
function verifyWebhookSignature(rawBody, signature, signatureKey, notificationUrl) {
    if ((!Buffer.isBuffer(rawBody) && typeof rawBody !== 'string') || typeof signature !== 'string' || !signatureKey || !notificationUrl || !/^[A-Za-z0-9+/]{43}=$/.test(signature)) return false;
    const expected = createHmac('sha256', signatureKey).update(notificationUrl).update(rawBody).digest();
    const received = Buffer.from(signature, 'base64');
    return received.length === expected.length && timingSafeEqual(expected, received);
}

/** Shared scoped REST client. Options are trusted server or fixture inputs. */
function createSquareClient(options = {}) {
    const c = config(options.env), fetchSquare = options.fetch || globalThis.fetch, now = options.clock || Date.now;
    const scope = [c.environment, c.merchantId];
    const requireConfigured = () => { if (!c.configured) throw fail('SQUARE_NOT_CONFIGURED', 'Squareとの連携がまだ設定されていません。管理者にお問い合わせください。', 503); };
    async function request(method, path, body) {
        requireConfigured();
        let response, data;
        try {
            response = await fetchSquare(c.baseUrl + path, { method, headers: { Authorization: `Bearer ${c.accessToken}`, 'Square-Version': API_VERSION, 'Content-Type': 'application/json' },
                ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000), redirect: 'error' });
            data = await response.json();
        } catch { throw Object.assign(fail('SQUARE_RESULT_UNKNOWN', 'Squareの処理結果を確認できません。契約状況を再確認してください。', 503), { uncertain: method !== 'GET', retryAfterMs: 30000 }); }
        if (!response.ok || data?.errors?.length) {
            const uncertain = response.status >= 500 || response.status === 408;
            throw Object.assign(fail(uncertain ? 'SQUARE_RESULT_UNKNOWN' : 'SQUARE_REQUEST_FAILED', uncertain ? 'Squareの処理結果を確認できません。契約状況を再確認してください。' : 'Squareで処理できませんでした。決済情報とプラン設定を確認してください。', uncertain || response.status === 429 ? 503 : 422), { uncertain, retryAfterMs: 30000 });
        }
        return data;
    }
    async function location(read = request) {
        const { location: found } = await read('GET', `/v2/locations/${encodeURIComponent(c.locationId)}`);
        if (!found || found.id !== c.locationId || found.merchant_id !== c.merchantId || found.status !== 'ACTIVE' || !found.timezone)
            throw fail('SQUARE_ACCOUNT_MISMATCH', 'Squareの店舗と事業者の設定が一致していません。', 503);
        try { new Intl.DateTimeFormat('en', { timeZone: found.timezone }); } catch { throw fail('SQUARE_ACCOUNT_MISMATCH', 'Squareの店舗のタイムゾーンを確認してください。', 503); }
        return found;
    }
    return { config: c, now, scope, requireConfigured, request, location };
}

/** Single-merchant integration. The injected fetch/env/clock options are trusted server or fixture inputs. */
function createSquareBilling(db, options = {}) {
    const { config: c, now, scope, requireConfigured, request, location } = createSquareClient(options);
    const commerce = require('./square-commerce').createSquareCommerce(db, options);
    async function variation(variationId) {
        const object = (await request('GET', `/v2/catalog/object/${encodeURIComponent(id(variationId))}`)).object;
        const catalog = validateVariation(object, c.locationId), parentId = object.subscription_plan_variation_data.subscription_plan_id;
        if (parentId) {
            const parent = (await request('GET', `/v2/catalog/object/${encodeURIComponent(id(parentId))}`)).object;
            if (!parent || parent.id !== parentId || parent.type !== 'SUBSCRIPTION_PLAN' || parent.is_deleted || parent.present_at_all_locations === false)
                throw fail('SQUARE_PLAN_UNSUPPORTED', 'Squareの親プランが停止されています。管理者にお問い合わせください。', 422);
        }
        return catalog;
    }
    async function getBindings() { return db.queryDatabase('SELECT * FROM automation_square_bindings WHERE environment=? AND merchant_id=? ORDER BY plan_id,cadence', scope); }
    async function getAdmin(actor) {
        administrator(actor);
        if (!c.configured) return { configured: false, environment: c.environment, missing: c.missing, bindings: [], availableVariations: [] };
        await location();
        const bindings = (await getBindings()).map(bindingDto), availableVariations = [];
        let cursor;
        for (let page = 0; page < 5; page++) {
            const data = await request('GET', `/v2/catalog/list?types=SUBSCRIPTION_PLAN_VARIATION${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
            for (const object of data.objects || []) {
                try { const { catalogVersion: _catalogVersion, ...item } = validateVariation(object, c.locationId); availableVariations.push(item); } catch {}
            }
            cursor = data.cursor; if (!cursor) break;
        }
        return { configured: true, environment: c.environment, missing: [], bindings, availableVariations };
    }
    async function saveBinding(actor, planId, input) {
        const actorId = administrator(actor); requireConfigured();
        if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(planId || '') || ['free', 'supporter'].includes(planId) || typeof input?.enabled !== 'boolean') throw fail('SQUARE_INVALID_INPUT', '有償プランと連携の有効状態を確認してください。', 422);
        const plans = await db.queryDatabase('SELECT * FROM automation_notification_plans WHERE plan_id=?', [planId]);
        if (!plans[0]) throw fail('AUTOMATION_PLAN_NOT_FOUND', '通知プランを先に登録してください。', 404);
        await location(); const catalog = await variation(input.variationId);
        if (input.cadence !== undefined && input.cadence !== catalog.cadence) throw fail('SQUARE_PAYMENT_INTERVAL_MISMATCH', '選択したSquare料金と支払い間隔が一致しません。', 422);
        let verifiedAtMs;
        try { await db.withDatabaseTransaction(async query => {
            // Lock policies in one order before checking the merchant-wide
            // unique variation mapping. Different plans/admins cannot race the
            // empty mapping or update another plan through a duplicate key.
            await query('SELECT plan_id FROM automation_notification_plans ORDER BY plan_id FOR UPDATE');
            const used = await query('SELECT plan_id FROM automation_square_bindings WHERE environment=? AND merchant_id=? AND variation_id=? AND (plan_id<>? OR cadence<>?) LIMIT 1', [...scope, catalog.variationId, planId, catalog.cadence]);
            if (used.length) throw fail('SQUARE_VARIATION_IN_USE', 'このSquareプランは別の通知プランに紐付いています。', 409);
            const existing = await query('SELECT * FROM automation_square_bindings WHERE plan_id=? AND environment=? AND merchant_id=? AND cadence=? FOR UPDATE', [planId, ...scope, catalog.cadence]);
            const previous = existing[0] ? Number(existing[0].verified_at_ms) : null;
            if ((input.expectedVerifiedAtMs ?? null) !== previous) throw fail('SQUARE_BINDING_CONFLICT', 'Squareの連携設定が変更されています。最新の設定を読み直してください。', 409);
            verifiedAtMs = Math.max(now(), previous === null ? 0 : previous + 1);
            const fields = [catalog.variationId, input.enabled ? 1 : 0, catalog.catalogName, catalog.cadence, catalog.amount, catalog.currency, catalog.catalogVersion, verifiedAtMs, actorId];
            if (existing.length) await query(`UPDATE automation_square_bindings SET variation_id=?,enabled=?,catalog_name=?,cadence=?,amount=?,currency=?,catalog_version=?,verified_at_ms=?,actor_user_id=? WHERE plan_id=? AND environment=? AND merchant_id=? AND cadence=?`, [...fields, planId, ...scope, catalog.cadence]);
            else await query(`INSERT INTO automation_square_bindings (plan_id,environment,merchant_id,variation_id,enabled,catalog_name,cadence,amount,currency,catalog_version,verified_at_ms,actor_user_id)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [planId, ...scope, ...fields]);
        }); } catch (error) {
            if (error.code === 'ER_DUP_ENTRY') throw fail('SQUARE_VARIATION_IN_USE', 'このSquareプランは別の通知プランに紐付いています。', 409);
            throw error;
        }
        return { planId, ...catalog, enabled: input.enabled, verifiedAtMs };
    }
    async function getOptions(actor) {
        user(actor);
        if (!c.configured) return { configured: false, environment: c.environment, plans: [] };
        const rows = await db.queryDatabase(`SELECT p.*,b.variation_id,b.catalog_name,b.cadence,b.amount,b.currency,b.verified_at_ms,b.enabled AS binding_enabled
            FROM automation_notification_plans p JOIN automation_square_bindings b ON b.plan_id=p.plan_id
            WHERE p.enabled=1 AND p.plan_id NOT IN ('free','supporter') AND b.enabled=1 AND b.environment=? AND b.merchant_id=? ORDER BY p.plan_id,b.cadence`, scope);
        return { configured: true, environment: c.environment, applicationId: c.applicationId, locationId: c.locationId, plans: rows.map(row => planDto(row, { ...row, enabled: row.binding_enabled })) };
    }
    async function createQuote(actor, input) {
        const owner = user(actor); requireConfigured();
        const planId = String(input?.planId || ''), email = String(input?.email || '').trim(), name = String(input?.name || '').trim();
        if (!isValidReceiptEmail(email)) throw fail('SQUARE_EMAIL_REQUIRED', '領収書を受け取るメールアドレスを入力してください。', 422);
        if (!name || name.length > 120 || [...name].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw fail('SQUARE_NAME_REQUIRED', '請求名を1〜120文字で入力してください。', 422);
        const intervals = (await getOptions(actor)).plans.filter(plan => plan.planId === planId);
        if (input.variationId !== undefined) id(input.variationId);
        if (input.variationId === undefined && intervals.length > 1) throw fail('SQUARE_PAYMENT_INTERVAL_REQUIRED', '支払い間隔を選択してください。', 422);
        const available = intervals.find(plan => input.variationId === undefined || plan.variationId === input.variationId);
        if (!available) throw fail('SQUARE_PLAN_UNAVAILABLE', 'この有償プランは現在申し込めません。', 422);
        await location(); const catalog = await variation(available.variationId);
        if (catalog.cadence !== available.cadence) throw fail('SQUARE_QUOTE_CHANGED', '支払い間隔の設定が変更されました。申し込み内容を再確認してください。', 409);
        const checkoutId = randomUUID(), expiresAtMs = now() + QUOTE_MS, plan = { ...available, ...catalog };
        if (input.couponCode) {
            plan.coupon = await commerce.resolveCoupon(input.couponCode, plan);
            plan.firstAmount = plan.coupon.firstAmount; plan.regularAmount = catalog.amount;
            plan.baseVariationId = catalog.variationId; plan.baseCatalogVersion = catalog.catalogVersion;
        }
        await db.withDatabaseTransaction(async query => {
            await lockOwner(query, owner);
            const current = await query('SELECT * FROM automation_square_accounts WHERE owner_user_id=? AND environment=? AND merchant_id=? FOR UPDATE', [owner, ...scope]);
            if (current[0]?.current_checkout_id) throw fail('SQUARE_CHECKOUT_PENDING', '前回の申し込み結果を確認してから、次の申し込みを行ってください。', 409);
            const subscriptions = await query('SELECT * FROM automation_square_subscriptions WHERE owner_user_id=? AND environment=? AND merchant_id=?', [owner, ...scope]);
            if (subscriptions[0] && (!TERMINAL.has(subscriptions[0].state) || Number(subscriptions[0].valid_until_at_ms) > now())) throw fail('SQUARE_ALREADY_SUBSCRIBED', '契約済みのプランがあります。契約状況をご確認ください。', 409);
            const receiptEmail = current[0]?.customer_email || email;
            const receiptName = current[0]?.customer_name || name;
            if (plan.coupon) await commerce.reserveCoupon(query, owner, checkoutId, plan.coupon, plan, expiresAtMs);
            await query(`INSERT INTO automation_square_checkouts (id,owner_user_id,environment,merchant_id,plan_id,variation_id,catalog_version,amount,currency,cadence,plan_json,email,name,expires_at_ms,created_at_ms,updated_at_ms)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [checkoutId, owner, ...scope, planId, catalog.variationId, catalog.catalogVersion, catalog.amount, catalog.currency, catalog.cadence, JSON.stringify(plan), receiptEmail, receiptName, expiresAtMs, now(), now()]);
            plan.email = receiptEmail; plan.name = receiptName;
        });
        const { email: receiptEmail, name: receiptName, ...quotePlan } = plan;
        return { checkoutId, expiresAtMs, plan: quotePlan, email: receiptEmail, name: receiptName };
    }
    async function loadCheckout(checkoutId, owner) {
        const rows = await db.queryDatabase('SELECT * FROM automation_square_checkouts WHERE id=? AND owner_user_id=? AND environment=? AND merchant_id=?', [checkoutId, owner, ...scope]);
        if (!rows[0]) throw fail('SQUARE_CHECKOUT_NOT_FOUND', '申し込み内容が見つかりません。', 404);
        return rows[0];
    }
    async function quoteCurrent(quote) {
        const snapshot = JSON.parse(quote.plan_json), baseVariationId = snapshot.baseVariationId || quote.variation_id;
        const rows = await db.queryDatabase(`SELECT p.*,b.variation_id,b.enabled AS binding_enabled FROM automation_notification_plans p
            JOIN automation_square_bindings b ON b.plan_id=p.plan_id WHERE p.plan_id=? AND b.environment=? AND b.merchant_id=? AND b.cadence=? AND b.variation_id=?`, [quote.plan_id, ...scope, quote.cadence, baseVariationId]);
        const row = rows[0];
        if (!row || Number(row.enabled) !== 1 || Number(row.binding_enabled) !== 1 || row.variation_id !== (snapshot.baseVariationId || quote.variation_id)
            || ['slotLimit', 'minuteLimit', 'dayLimit', 'priority'].some((name, index) => Number(row[['slot_limit', 'minute_limit', 'day_limit', 'priority'][index]]) !== snapshot[name]) || row.label !== snapshot.label)
            throw fail('SQUARE_QUOTE_CHANGED', 'プランの設定が変更されました。申し込み内容を再確認してください。', 409);
        const current = await variation(snapshot.baseVariationId || quote.variation_id);
        if (current.catalogVersion !== (snapshot.baseCatalogVersion || quote.catalog_version) || current.amount !== Number(quote.amount) || current.currency !== quote.currency || current.cadence !== quote.cadence)
            throw fail('SQUARE_QUOTE_CHANGED', 'Squareの料金が変更されました。申し込み内容を再確認してください。', 409);
        if (snapshot.coupon) {
            await commerce.assertCouponCurrent(quote, snapshot);
            if (quote.variation_id !== snapshot.baseVariationId) require('./square-commerce').validateCouponVariation((await request('GET', '/v2/catalog/object/' + encodeURIComponent(quote.variation_id))).object, c.locationId, snapshot.coupon);
        }
    }
    async function leaseCheckout(quote, sourceId, nonceFree = false) {
        const token = randomUUID(), sourceDigest = nonceFree ? quote.source_digest : digest(sourceId);
        await db.withDatabaseTransaction(async query => {
            await lockOwner(query, quote.owner_user_id);
            const rows = await query('SELECT * FROM automation_square_checkouts WHERE id=? FOR UPDATE', [quote.id]);
            const current = rows[0];
            if (current.state === 'COMPLETE') return;
            if (nonceFree && (!['CARD_STORED','SUBSCRIPTION_SUBMITTING'].includes(current.state) || !SQUARE_ID.test(current.card_id || '') || !SQUARE_ID.test(current.customer_id || '')))
                throw fail('SQUARE_RESUME_UNAVAILABLE', '保存済みのカードで再開できる申し込みではありません。受付状態を確認してください。', 409);
            if (['FAILED','KNOWN_REJECTED'].includes(current.state)) throw fail('SQUARE_CHECKOUT_FAILED', '前回の申し込みは完了していません。新しく申し込みをやり直してください。', 409);
            if (current.lease_token && Number(current.lease_until_at_ms) > now()) throw Object.assign(fail('SQUARE_CHECKOUT_BUSY', '申し込みを処理しています。契約状況を再確認してください。', 409), { retryAfterMs: 30000 });
            if (current.source_digest && current.source_digest !== sourceDigest && !current.card_id) throw fail('SQUARE_CHECKOUT_PENDING', '前回の決済結果を先に確認してください。重複して申し込むことはできません。', 409);
            if (current.state === 'QUOTED' && Number(current.expires_at_ms) <= now()) throw fail('SQUARE_QUOTE_EXPIRED', '申し込み内容の有効期限が切れました。内容を再確認してください。', 409);
            await query(`INSERT INTO automation_square_accounts (owner_user_id,environment,merchant_id,customer_email,customer_name,updated_at_ms) VALUES (?,?,?,?,?,?)
                ON DUPLICATE KEY UPDATE owner_user_id=VALUES(owner_user_id)`, [quote.owner_user_id, ...scope, quote.email, quote.name, now()]);
            const accounts = await query('SELECT * FROM automation_square_accounts WHERE owner_user_id=? AND environment=? AND merchant_id=? FOR UPDATE', [quote.owner_user_id, ...scope]);
            if (accounts[0].current_checkout_id && accounts[0].current_checkout_id !== quote.id) throw fail('SQUARE_CHECKOUT_PENDING', '別の申し込み結果を先に確認してください。', 409);
            const subscriptions = await query('SELECT * FROM automation_square_subscriptions WHERE owner_user_id=? AND environment=? AND merchant_id=?', [quote.owner_user_id, ...scope]);
            if (subscriptions[0] && subscriptions[0].checkout_id !== quote.id && (!TERMINAL.has(subscriptions[0].state) || Number(subscriptions[0].valid_until_at_ms) > now())) throw fail('SQUARE_ALREADY_SUBSCRIBED', '契約済みのプランがあります。', 409);
            await query('UPDATE automation_square_accounts SET current_checkout_id=?,updated_at_ms=? WHERE owner_user_id=? AND environment=? AND merchant_id=?', [quote.id, now(), quote.owner_user_id, ...scope]);
            await query('UPDATE automation_square_checkouts SET source_digest=?,lease_token=?,lease_until_at_ms=?,updated_at_ms=? WHERE id=?', [sourceDigest, token, now() + LEASE_MS, now(), quote.id]);
            await commerce.couponStage(query, quote, 'SUBMITTING');
        });
        return token;
    }
    async function stage(quote, token, state, fields = {}) {
        const allowed = ['customer_id', 'card_id', 'subscription_id'];
        const entries = Object.entries(fields).filter(([name]) => allowed.includes(name));
        const result = await db.queryDatabase(`UPDATE automation_square_checkouts SET state=?,updated_at_ms=?${entries.map(([name]) => `,${name}=?`).join('')} WHERE id=? AND lease_token=? AND state<>'COMPLETE'`, [state, now(), ...entries.map(([, value]) => value), quote.id, token]);
        if (result.affectedRows !== 1) throw fail('SQUARE_CHECKOUT_BUSY', '申し込み結果を再確認してください。', 409);
        Object.assign(quote, fields, { state });
    }
    async function finishKnownRejected(query, quote, token) {
        await lockOwner(query, quote.owner_user_id);
        const snapshot = JSON.parse(quote.plan_json);
        if (snapshot.coupon) await query('SELECT code FROM automation_square_coupons WHERE code=? AND environment=? AND merchant_id=? FOR UPDATE', [snapshot.coupon.code, ...scope]);
        const current = (await query('SELECT * FROM automation_square_checkouts WHERE id=? AND owner_user_id=? AND environment=? AND merchant_id=? FOR UPDATE', [quote.id, quote.owner_user_id, ...scope]))[0];
        if (!current || !['FAILED','KNOWN_REJECTED'].includes(current.state) || current.subscription_id
            || (token ? current.lease_token !== token : current.lease_token && Number(current.lease_until_at_ms) > now())) return false;
        if ((await query('SELECT subscription_id FROM automation_square_subscriptions WHERE checkout_id=? LIMIT 1', [current.id])).length) return false;
        await query("UPDATE automation_square_checkouts SET state='FAILED',updated_at_ms=? WHERE id=? AND state IN ('FAILED','KNOWN_REJECTED')", [now(), current.id]);
        await commerce.couponStage(query, current, 'RELEASED');
        await query('UPDATE automation_square_accounts SET current_checkout_id=NULL,updated_at_ms=? WHERE owner_user_id=? AND environment=? AND merchant_id=? AND current_checkout_id=?', [now(), current.owner_user_id, ...scope, current.id]);
        return true;
    }
    async function abandonCheckout(query, quote) {
        await lockOwner(query, quote.owner_user_id);
        const current = (await query('SELECT * FROM automation_square_checkouts WHERE id=? AND owner_user_id=? AND environment=? AND merchant_id=? FOR UPDATE', [quote.id, quote.owner_user_id, ...scope]))[0];
        if (!current || !['QUOTED','CUSTOMER_SUBMITTING','CUSTOMER_READY','CARD_SUBMITTING','CARD_STORED'].includes(current.state) || current.subscription_id
            || current.lease_token && Number(current.lease_until_at_ms) > now()
            || (await query('SELECT subscription_id FROM automation_square_subscriptions WHERE checkout_id=? LIMIT 1', [quote.id])).length) return false;
        // Every enrollment POST is preceded by the fenced transition to
        // SUBSCRIPTION_SUBMITTING. Clearing this lease stops a delayed worker
        // before it can cross that boundary, including unknown card storage.
        await query("UPDATE automation_square_checkouts SET state='FAILED',lease_token=NULL,lease_until_at_ms=NULL,updated_at_ms=? WHERE id=?", [now(), quote.id]);
        await commerce.couponStage(query, current, 'RELEASED');
        await query('UPDATE automation_square_accounts SET current_checkout_id=NULL,updated_at_ms=? WHERE owner_user_id=? AND environment=? AND merchant_id=? AND current_checkout_id=?', [now(), quote.owner_user_id, ...scope, quote.id]);
        return true;
    }
    async function abort(actor, input) {
        const owner = user(actor); requireConfigured();
        if (!UUID.test(input?.checkoutId || '')) throw fail('SQUARE_INVALID_INPUT', '申し込みIDを確認してください。', 422);
        const quote = await loadCheckout(input.checkoutId, owner);
        await db.withDatabaseTransaction(async query => {
            if (!await abandonCheckout(query, quote)) throw fail('SQUARE_ABORT_UNAVAILABLE', '契約作成の結果を確認する必要があるため、この申し込みは取り消せません。', 409);
        });
        return statusDto(owner, { state: 'checked', retryAtMs: now() });
    }
    async function validateCustomer(customerId, owner, read = request) {
        const { customer } = await read('GET', `/v2/customers/${encodeURIComponent(id(customerId))}`);
        if (!customer || customer.id !== customerId || customer.reference_id !== `cbte:${owner}`) throw fail('SQUARE_ACCOUNT_MISMATCH', 'Squareの顧客情報と利用者が一致していません。', 503);
        return customer;
    }
    async function validateStoredCard(quote) {
        const { card } = await request('GET', `/v2/cards/${encodeURIComponent(id(quote.card_id))}`);
        if (!card || card.id !== quote.card_id || card.customer_id !== quote.customer_id || card.reference_id !== quote.id || card.enabled === false)
            throw fail('SQUARE_ACCOUNT_MISMATCH', '保存済みのカードと申し込みが一致していません。管理者にお問い合わせください。', 503);
    }
    async function recoverCard(quote, read = request) {
        if (!quote.customer_id) return null;
        let cursor;
        for (let page = 0; page < 10; page++) {
            const data = await read('GET', `/v2/cards?customer_id=${encodeURIComponent(quote.customer_id)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
            const found = (data.cards || []).filter(card => card.reference_id === quote.id && card.customer_id === quote.customer_id && card.enabled !== false);
            if (found.length > 1) throw fail('SQUARE_ACCOUNT_MISMATCH', 'Squareの決済情報を管理者が確認する必要があります。', 503);
            if (found[0]) return found[0];
            cursor = data.cursor; if (!cursor) return null;
        }
        throw fail('SQUARE_CHECKOUT_PENDING', '決済情報の確認が終わるまで、再度の申し込みをお待ちください。', 503);
    }
    async function recoverCustomer(quote, read = request) {
        const data = await read('POST', '/v2/customers/search', { query: { filter: { reference_id: { exact: `cbte:${quote.owner_user_id}` } } }, limit: 10 });
        const found = (data.customers || []).filter(customer => customer.reference_id === `cbte:${quote.owner_user_id}` && customer.email_address === quote.email);
        if (data.cursor || found.length > 1) throw fail('SQUARE_ACCOUNT_MISMATCH', '顧客情報を管理者が確認する必要があります。', 503);
        return found[0] || null;
    }
    function matchesSubscription(subscription, quote) {
        const coupon = JSON.parse(quote.plan_json).coupon;
        return subscription && subscription.customer_id === quote.customer_id && subscription.location_id === c.locationId && subscription.plan_variation_id === quote.variation_id
            && subscription.source?.name === `cbte:${quote.id}` && (!quote.card_id || subscription.card_id === quote.card_id)
            && (coupon ? !subscription.price_override_money : !subscription.price_override_money || (Number(subscription.price_override_money.amount) === Number(quote.amount) && subscription.price_override_money.currency === quote.currency));
    }
    async function recoverSubscription(quote, read = request) {
        if (!quote.customer_id) return null;
        let cursor;
        for (let page = 0; page < 10; page++) {
            const data = await read('POST', '/v2/subscriptions/search', { query: { filter: { customer_ids: [quote.customer_id], location_ids: [c.locationId] } }, ...(cursor ? { cursor } : {}) });
            const found = (data.subscriptions || []).filter(subscription => matchesSubscription(subscription, quote));
            if (found.length > 1) throw fail('SQUARE_ACCOUNT_MISMATCH', 'Squareに複数の契約が見つかりました。管理者にお問い合わせください。', 503);
            if (found[0]) return found[0];
            cursor = data.cursor; if (!cursor) return null;
        }
        throw fail('SQUARE_CHECKOUT_PENDING', '契約の確認が終わるまで、再度の申し込みをお待ちください。', 503);
    }
    async function rememberSubscription(quote, subscription, query = db.queryDatabase, leaseToken) {
        if (!matchesSubscription(subscription, quote) || !SQUARE_ID.test(subscription.id || '')) throw fail('SQUARE_ACCOUNT_MISMATCH', 'Squareの契約内容が申し込みと一致していません。', 503);
        const accounts = await query('SELECT current_checkout_id FROM automation_square_accounts WHERE owner_user_id=? AND environment=? AND merchant_id=? FOR UPDATE', [quote.owner_user_id, ...scope]);
        const checkouts = await query('SELECT state,lease_token,lease_until_at_ms FROM automation_square_checkouts WHERE id=? FOR UPDATE', [quote.id]);
        const existing = await subscriptionRow(quote.owner_user_id, query);
        if (existing?.subscription_id === subscription.id && existing.checkout_id === quote.id && checkouts[0]?.state === 'COMPLETE') return true;
        // A delayed recovery cannot replace a contract installed by a newer
        // checkout after the previous status read started.
        if (accounts[0]?.current_checkout_id !== quote.id || !checkouts[0] || ['FAILED', 'KNOWN_REJECTED', 'COMPLETE'].includes(checkouts[0].state)) return false;
        if (leaseToken ? checkouts[0].lease_token !== leaseToken : checkouts[0].lease_token && Number(checkouts[0].lease_until_at_ms) > now()) return false;
        if (existing && existing.checkout_id !== quote.id && (!TERMINAL.has(existing.state) || Number(existing.valid_until_at_ms) > now())) return false;
        await query(`INSERT INTO automation_square_subscriptions (owner_user_id,environment,merchant_id,plan_id,variation_id,customer_id,subscription_id,checkout_id,state,updated_at_ms)
            VALUES (?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE plan_id=VALUES(plan_id),variation_id=VALUES(variation_id),customer_id=VALUES(customer_id),subscription_id=VALUES(subscription_id),checkout_id=VALUES(checkout_id),state=VALUES(state),paid_through_at_ms=NULL,valid_until_at_ms=NULL,canceled_date=NULL,current_invoice_id=NULL,square_version=NULL,verified=0,updated_at_ms=VALUES(updated_at_ms)`,
        [quote.owner_user_id, ...scope, quote.plan_id, quote.variation_id, quote.customer_id, subscription.id, quote.id, subscription.status || 'PENDING', now()]);
        await query('UPDATE automation_square_checkouts SET state=\'COMPLETE\',subscription_id=?,updated_at_ms=? WHERE id=?', [subscription.id, now(), quote.id]);
        await query('UPDATE automation_square_accounts SET current_checkout_id=NULL,updated_at_ms=? WHERE owner_user_id=? AND environment=? AND merchant_id=? AND current_checkout_id=?', [now(), quote.owner_user_id, ...scope, quote.id]);
        const firstInvoiceId = subscription.invoice_ids?.at(-1);
        if (SQUARE_ID.test(firstInvoiceId || '')) await query(`INSERT INTO automation_square_subscription_invoices (environment,merchant_id,subscription_id,first_invoice_id) VALUES (?,?,?,?)
            ON DUPLICATE KEY UPDATE subscription_id=VALUES(subscription_id)`, [...scope, subscription.id, firstInvoiceId]);
        return true;
    }
    function invoiceAmounts(quote, subscription, invoice, periodEnd, timezone, firstInvoiceId) {
        const plan = JSON.parse(quote.plan_json);
        if (plan.coupon) return null; // The coupon ledger determines its immutable first invoice.
        const regular = Number(quote.amount);
        if (!plan.canProrate || plan.billingAnchorDay == null || invoice.id !== firstInvoiceId) return [regular];
        // Proration is a different, explicitly reviewed billing condition. Never
        // apply it to renewals, coupons, or a remotely changed billing anchor.
        if (Number(subscription.monthly_billing_anchor_date) !== plan.billingAnchorDay || !/^\d{4}-\d{2}-\d{2}$/.test(subscription.start_date || ''))
            throw fail('SQUARE_PRORATION_UNVERIFIED', '初回の日割り請求の期間を確認できません。管理者にお問い合わせください。', 503);
        const months = { MONTHLY: 1, EVERY_TWO_MONTHS: 2, QUARTERLY: 3, EVERY_FOUR_MONTHS: 4, EVERY_SIX_MONTHS: 6, ANNUAL: 12, EVERY_TWO_YEARS: 24 }[quote.cadence];
        if (!months) throw fail('SQUARE_PRORATION_UNVERIFIED', 'この周期の日割り請求を確認できません。管理者にお問い合わせください。', 503);
        const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(periodEnd - 1).map(part => [part.type, part.value]));
        const next = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + 1));
        const nextAnchor = Math.min(plan.billingAnchorDay, new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate());
        if (next.getUTCDate() !== nextAnchor) throw fail('SQUARE_PRORATION_UNVERIFIED', '初回の日割り請求と課金日が一致していません。管理者にお問い合わせください。', 503);
        const priorMonth = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() - months, 1));
        const priorDay = Math.min(plan.billingAnchorDay, new Date(Date.UTC(priorMonth.getUTCFullYear(), priorMonth.getUTCMonth() + 1, 0)).getUTCDate());
        const prior = Date.UTC(priorMonth.getUTCFullYear(), priorMonth.getUTCMonth(), priorDay);
        const start = Date.parse(subscription.start_date + 'T00:00:00Z'), fullDays = (next.getTime() - prior) / 86400000, remainingDays = (next.getTime() - start) / 86400000;
        if (!Number.isSafeInteger(fullDays) || !Number.isSafeInteger(remainingDays) || remainingDays < 1 || remainingDays > fullDays || new Date(start).toISOString().slice(0, 10) !== subscription.start_date)
            throw fail('SQUARE_PRORATION_UNVERIFIED', '初回の日割り請求の期間を確認できません。管理者にお問い合わせください。', 503);
        // Square describes day-based proration without specifying minor-unit
        // rounding. Only the adjacent integer bounds of that exact rational are
        // permitted; renewals always require the full reviewed amount.
        const numerator = BigInt(regular) * BigInt(remainingDays), denominator = BigInt(fullDays);
        return [Number(numerator / denominator), Number((numerator + denominator - 1n) / denominator)];
    }
    function refreshReader() {
        let reads = 0;
        const deadline = Date.now() + 20000;
        return async (method, path, body) => {
            if (++reads > REFRESH_READ_LIMIT || Date.now() >= deadline) throw fail('SQUARE_BILLING_REFRESH_BUDGET', '契約状態の確認が集中しています。少し待ってから再確認してください。', 503);
            return request(method, path, body);
        };
    }
    async function collectReconciliation(row, read = request) {
        const { subscription } = await read('GET', `/v2/subscriptions/${encodeURIComponent(id(row.subscription_id))}`);
        const quote = await loadCheckout(row.checkout_id, row.owner_user_id);
        await validateCustomer(row.customer_id, row.owner_user_id, read);
        const foundLocation = await location(read);
        if (!matchesSubscription(subscription, quote) || subscription.id !== row.subscription_id || (subscription.timezone && subscription.timezone !== foundLocation.timezone))
            throw fail('SQUARE_ACCOUNT_MISMATCH', 'Squareの契約と利用者・店舗・プランが一致していません。', 503);
        const version = Number(subscription.version);
        if (!Number.isSafeInteger(version) || version < 0) throw fail('SQUARE_ACCOUNT_MISMATCH', 'Squareの契約バージョンを確認できません。', 503);
        const candidate = subscription.invoice_ids?.[0], end = dateEnd(subscription.charged_through_date, foundLocation.timezone);
        const periods = await db.queryDatabase(`SELECT invoice_id,period_end_at_ms FROM automation_square_invoice_periods WHERE environment=? AND merchant_id=? AND subscription_id=?
            AND period_end_at_ms>? ORDER BY period_end_at_ms DESC LIMIT 12`, [...scope, row.subscription_id, now()]);
        if (candidate && end && !periods.some(period => period.invoice_id === candidate)) periods.push({ invoice_id: id(candidate), period_end_at_ms: end });
        periods.sort((a, b) => Number(b.period_end_at_ms) - Number(a.period_end_at_ms));
        const invoices = [];
        for (const period of periods.slice(0, 12)) {
            if (Number(period.period_end_at_ms) <= now()) continue;
            const { invoice } = await read('GET', `/v2/invoices/${encodeURIComponent(id(period.invoice_id))}`);
            if (!invoice || invoice.id !== period.invoice_id || invoice.subscription_id !== row.subscription_id || invoice.location_id !== c.locationId || invoice.primary_recipient?.customer_id !== row.customer_id)
                throw fail('SQUARE_ACCOUNT_MISMATCH', 'Squareの請求と契約が一致していません。', 503);
            invoices.push({ invoice, periodEnd: Number(period.period_end_at_ms) });
        }
        const identity = (await db.queryDatabase('SELECT first_invoice_id FROM automation_square_subscription_invoices WHERE environment=? AND merchant_id=? AND subscription_id=?', [...scope, row.subscription_id]))[0];
        const firstInvoiceId = identity?.first_invoice_id || subscription.invoice_ids?.at(-1);
        return { quote, subscription, version, candidate, end, firstInvoiceId, timezone: foundLocation.timezone, invoices };
    }
    async function applyReconciliation(query, row, snapshot) {
        const current = await subscriptionRow(row.owner_user_id, query);
        if (!current || current.subscription_id !== row.subscription_id || current.checkout_id !== row.checkout_id || Number(current.square_version) > snapshot.version) return;
        const { quote, subscription, version, candidate, end, firstInvoiceId, timezone, invoices } = snapshot;
        if (SQUARE_ID.test(firstInvoiceId || '')) await query(`INSERT INTO automation_square_subscription_invoices (environment,merchant_id,subscription_id,first_invoice_id) VALUES (?,?,?,?)
            ON DUPLICATE KEY UPDATE subscription_id=VALUES(subscription_id)`, [...scope, row.subscription_id, firstInvoiceId]);
        if (candidate && end) await query(`INSERT INTO automation_square_invoice_periods (environment,merchant_id,subscription_id,invoice_id,period_end_at_ms,observed_at_ms) VALUES (?,?,?,?,?,?)
            ON DUPLICATE KEY UPDATE invoice_id=VALUES(invoice_id)`, [...scope, row.subscription_id, candidate, end, now()]);
        let paidThrough = null, validUntil = null, invoiceId = null;
        for (const { invoice, periodEnd } of invoices) {
            const requests = invoice.payment_requests;
            const paid = invoice.status === 'PAID' && Array.isArray(requests) && requests.length > 0 && requests.every(item => {
                const amount = Number(item.computed_amount_money?.amount), completed = Number(item.total_completed_amount_money?.amount);
                return Number.isSafeInteger(amount) && amount > 0 && Number.isSafeInteger(completed) && completed >= amount && item.computed_amount_money.currency === quote.currency && item.total_completed_amount_money.currency === quote.currency;
            });
            const expected = JSON.parse(quote.plan_json).coupon ? [await commerce.confirmInvoice(query, quote, subscription, invoice)] : paid ? invoiceAmounts(quote, subscription, invoice, periodEnd, timezone, firstInvoiceId) : [];
            const exactPrice = expected.includes(requests?.reduce((sum, item) => sum + Number(item.computed_amount_money?.amount), 0));
            if (paid && exactPrice && ['ACTIVE', 'CANCELED'].includes(subscription.status)) {
                paidThrough = periodEnd; invoiceId = invoice.id; validUntil = paidThrough;
                for (const endDate of [subscription.canceled_date, subscription.completed_date]) if (endDate) {
                    const stop = dateEnd(endDate, timezone); validUntil = stop && validUntil ? Math.min(stop, validUntil) : null;
                }
                break;
            }
        }
        invoiceId ||= candidate || null;
        await query(`UPDATE automation_square_subscriptions SET state=?,paid_through_at_ms=?,valid_until_at_ms=?,canceled_date=?,current_invoice_id=?,square_version=?,verified=1,updated_at_ms=?
            WHERE owner_user_id=? AND environment=? AND merchant_id=? AND subscription_id=? AND (square_version IS NULL OR square_version<=?)`,
        [subscription.status || 'UNKNOWN', paidThrough, validUntil, subscription.canceled_date || null, invoiceId, version, now(), row.owner_user_id, ...scope, row.subscription_id, version]);
        await query('UPDATE automation_square_billing_reconciliation SET warning_subscription_id=NULL,warning_checkout_id=NULL,warning_code=NULL,warning_message=NULL WHERE owner_user_id=? AND environment=? AND merchant_id=?', [row.owner_user_id, ...scope]);
    }
    async function recordProrationFailure(query, row, snapshot, error) {
        const { subscription, version, candidate } = snapshot;
        const result = await query(`UPDATE automation_square_subscriptions SET state=?,paid_through_at_ms=NULL,valid_until_at_ms=NULL,canceled_date=?,current_invoice_id=?,square_version=?,verified=0,updated_at_ms=?
            WHERE owner_user_id=? AND environment=? AND merchant_id=? AND subscription_id=? AND checkout_id=? AND (square_version IS NULL OR square_version<=?)`,
        [subscription.status || 'UNKNOWN', subscription.canceled_date || null, candidate || null, version, now(), row.owner_user_id, ...scope, row.subscription_id, row.checkout_id, version]);
        if (result.affectedRows) await query('UPDATE automation_square_billing_reconciliation SET warning_subscription_id=?,warning_checkout_id=?,warning_code=?,warning_message=? WHERE owner_user_id=? AND environment=? AND merchant_id=?', [row.subscription_id, row.checkout_id, error.code, error.message, row.owner_user_id, ...scope]);
    }
    async function currentRefreshState(owner) {
        const row = (await db.queryDatabase('SELECT * FROM automation_square_billing_reconciliation WHERE owner_user_id=? AND environment=? AND merchant_id=?', [owner, ...scope]))[0];
        if (row?.lease_token && Number(row.lease_until_at_ms) > now()) return { state: 'busy', retryAtMs: Number(row.lease_until_at_ms) };
        if (Number(row?.next_allowed_at_ms) > now()) return { state: 'cooldown', retryAtMs: Number(row.next_allowed_at_ms) };
        return { state: 'failed', retryAtMs: now() + REFRESH_MS };
    }
    async function claimRefresh(owner, force = false, query) {
        const claim = async run => {
            await run('INSERT INTO automation_square_billing_reconciliation (owner_user_id,environment,merchant_id) VALUES (?,?,?) ON DUPLICATE KEY UPDATE owner_user_id=VALUES(owner_user_id)', [owner, ...scope]);
            const row = (await run('SELECT * FROM automation_square_billing_reconciliation WHERE owner_user_id=? AND environment=? AND merchant_id=? FOR UPDATE', [owner, ...scope]))[0];
            if (!force && row.lease_token && Number(row.lease_until_at_ms) > now()) return { state: 'busy', retryAtMs: Number(row.lease_until_at_ms) };
            if (!force && Number(row.next_allowed_at_ms) > now()) return { state: 'cooldown', retryAtMs: Number(row.next_allowed_at_ms) };
            const token = randomUUID();
            // A forced webhook/cancellation observation replaces the token. An
            // earlier same-version PAID snapshot cannot undo a newer refund.
            await run('UPDATE automation_square_billing_reconciliation SET lease_token=?,lease_until_at_ms=? WHERE owner_user_id=? AND environment=? AND merchant_id=?', [token, now() + LEASE_MS, owner, ...scope]);
            return { state: 'claimed', token };
        };
        return query ? claim(query) : db.withDatabaseTransaction(claim);
    }
    async function withRefreshOwner(owner, token, work) {
        return db.withDatabaseTransaction(async query => {
            const row = (await query('SELECT * FROM automation_square_billing_reconciliation WHERE owner_user_id=? AND environment=? AND merchant_id=? FOR UPDATE', [owner, ...scope]))[0];
            if (row?.lease_token !== token || Number(row.lease_until_at_ms) <= now()) return false;
            await lockOwner(query, owner); await work(query); return true;
        });
    }
    async function refreshOwner(owner, force = false) {
        const claim = await claimRefresh(owner, force);
        if (claim.state !== 'claimed') return claim;
        const read = refreshReader();
        let failed = false, reconciliation;
        try {
            const account = (await db.queryDatabase('SELECT current_checkout_id FROM automation_square_accounts WHERE owner_user_id=? AND environment=? AND merchant_id=?', [owner, ...scope]))[0];
            if (account?.current_checkout_id) {
                const quote = await loadCheckout(account.current_checkout_id, owner);
                if (!quote.lease_token || Number(quote.lease_until_at_ms) <= now()) {
                    if (quote.state === 'QUOTED') { if (!await withRefreshOwner(owner, claim.token, query => abandonCheckout(query, quote))) return currentRefreshState(owner); }
                    else if (['FAILED','KNOWN_REJECTED'].includes(quote.state)) { if (!await withRefreshOwner(owner, claim.token, query => finishKnownRejected(query, quote))) return currentRefreshState(owner); }
                    else if (quote.state === 'CUSTOMER_SUBMITTING' && !quote.customer_id) {
                        const customer = await recoverCustomer(quote, read);
                        if (customer && !await withRefreshOwner(owner, claim.token, async query => {
                            const account = (await query('SELECT current_checkout_id FROM automation_square_accounts WHERE owner_user_id=? AND environment=? AND merchant_id=? FOR UPDATE', [owner, ...scope]))[0];
                            if (account?.current_checkout_id !== quote.id) return;
                            const result = await query(`UPDATE automation_square_checkouts SET customer_id=?,state='CUSTOMER_READY',source_digest=NULL,updated_at_ms=? WHERE id=? AND state='CUSTOMER_SUBMITTING' AND (lease_token IS NULL OR lease_until_at_ms<=?)`, [customer.id, now(), quote.id, now()]);
                            if (result.affectedRows) await query('UPDATE automation_square_accounts SET customer_id=? WHERE owner_user_id=? AND environment=? AND merchant_id=?', [customer.id, owner, ...scope]);
                        })) return currentRefreshState(owner);
                    } else if (quote.state === 'CARD_SUBMITTING' && quote.customer_id) {
                        const card = await recoverCard(quote, read);
                        if (card && !await withRefreshOwner(owner, claim.token, query => query(`UPDATE automation_square_checkouts SET card_id=?,state='CARD_STORED',updated_at_ms=? WHERE id=? AND state='CARD_SUBMITTING' AND (lease_token IS NULL OR lease_until_at_ms<=?)`, [card.id, now(), quote.id, now()]))) return currentRefreshState(owner);
                    } else if (quote.state === 'SUBSCRIPTION_SUBMITTING') {
                        const found = await recoverSubscription(quote, read);
                        if (found && !await withRefreshOwner(owner, claim.token, query => rememberSubscription(quote, found, query))) return currentRefreshState(owner);
                    }
                }
            }
            const row = await subscriptionRow(owner);
            if (row) {
                const snapshot = await collectReconciliation(row, read);
                reconciliation = { row, snapshot };
                if (!await withRefreshOwner(owner, claim.token, query => applyReconciliation(query, row, snapshot))) return currentRefreshState(owner);
            }
            if (!await withRefreshOwner(owner, claim.token, async () => {})) return currentRefreshState(owner);
        } catch (error) {
            failed = true;
            if (error.code === 'SQUARE_ACCOUNT_MISMATCH') throw error;
            if (error.code === 'SQUARE_PRORATION_UNVERIFIED' && reconciliation) {
                // Identity is already verified. Preserve cancellation access on
                // reload, but persist no paid grant from unverifiable dates.
                if (!await withRefreshOwner(owner, claim.token, query => recordProrationFailure(query, reconciliation.row, reconciliation.snapshot, error))) return currentRefreshState(owner);
            }
        } finally {
            await db.queryDatabase('UPDATE automation_square_billing_reconciliation SET lease_token=NULL,lease_until_at_ms=NULL,next_allowed_at_ms=? WHERE owner_user_id=? AND environment=? AND merchant_id=? AND lease_token=?', [now() + REFRESH_MS, owner, ...scope, claim.token]);
        }
        return { state: failed ? 'failed' : 'checked', retryAtMs: now() + REFRESH_MS };
    }
    async function subscriptionRow(owner, query = db.queryDatabase) { return (await query('SELECT * FROM automation_square_subscriptions WHERE owner_user_id=? AND environment=? AND merchant_id=?', [owner, ...scope]))[0]; }
    async function statusDto(owner, refresh) {
        const row = await subscriptionRow(owner);
        const account = (await db.queryDatabase('SELECT current_checkout_id FROM automation_square_accounts WHERE owner_user_id=? AND environment=? AND merchant_id=?', [owner, ...scope]))[0];
        const pending = account?.current_checkout_id ? await loadCheckout(account.current_checkout_id, owner) : null;
        const labels = row ? await db.queryDatabase('SELECT label FROM automation_notification_plans WHERE plan_id=?', [row.plan_id]) : [];
        const recurring = row ? (await db.queryDatabase('SELECT cadence,amount,currency FROM automation_square_checkouts WHERE id=? AND owner_user_id=? AND environment=? AND merchant_id=? AND plan_id=? AND variation_id=?', [row.checkout_id, owner, ...scope, row.plan_id, row.variation_id]))[0] : null;
        const recurringTerms = recurring && CADENCES.has(recurring.cadence) && Number.isSafeInteger(Number(recurring.amount)) && Number(recurring.amount) > 0 && /^[A-Z]{3}$/.test(recurring.currency)
            ? { cadence: recurring.cadence, amount: Number(recurring.amount), currency: recurring.currency } : {};
        const observation = row ? (await db.queryDatabase('SELECT warning_subscription_id,warning_checkout_id,warning_code,warning_message FROM automation_square_billing_reconciliation WHERE owner_user_id=? AND environment=? AND merchant_id=?', [owner, ...scope]))[0] : null;
        const verificationWarning = observation?.warning_subscription_id === row?.subscription_id && observation?.warning_checkout_id === row?.checkout_id && observation?.warning_code === 'SQUARE_PRORATION_UNVERIFIED'
            ? { code: observation.warning_code, message: observation.warning_message } : null;
        const idle = pending && (!pending.lease_token || Number(pending.lease_until_at_ms) <= now());
        return { configured: true, environment: c.environment, refresh, ...(verificationWarning ? { verificationWarning } : {}), subscription: row ? { subscriptionId: row.subscription_id, checkoutId: row.checkout_id, planId: row.plan_id, label: labels[0]?.label || row.plan_id, state: row.state, ...recurringTerms,
            paidThroughAtMs: row.paid_through_at_ms === null ? null : Number(row.paid_through_at_ms), validUntilAtMs: row.valid_until_at_ms === null ? null : Number(row.valid_until_at_ms), canceledDate: row.canceled_date,
            active: Number(row.verified) === 1 && ['ACTIVE', 'CANCELED'].includes(row.state) && Number(row.valid_until_at_ms) > now(), cancelScheduled: !!row.canceled_date } : null,
        pending: pending ? { checkoutId: pending.id, state: pending.state, retryable: Boolean(idle && RETRYABLE.has(pending.state)),
            resumeAllowed: Boolean(idle && ['CARD_STORED','SUBSCRIPTION_SUBMITTING'].includes(pending.state) && SQUARE_ID.test(pending.card_id || '') && SQUARE_ID.test(pending.customer_id || '')),
            abortAllowed: Boolean(idle && ['QUOTED','CUSTOMER_SUBMITTING','CUSTOMER_READY','CARD_SUBMITTING','CARD_STORED'].includes(pending.state) && !pending.subscription_id),
            quote: { checkoutId: pending.id, expiresAtMs: Number(pending.expires_at_ms), plan: JSON.parse(pending.plan_json), email: pending.email, name: pending.name } } : null };
    }
    async function getStatus(actor) {
        const owner = user(actor);
        if (!c.configured) return { configured: false, environment: c.environment, subscription: null, pending: null, refresh: { state: 'checked', retryAtMs: now() } };
        return statusDto(owner, await refreshOwner(owner));
    }
    async function statusAfterMutation(actor) { const owner = user(actor); return statusDto(owner, await refreshOwner(owner, true)); }
    async function subscribe(actor, input) { return enroll(actor, input, false); }
    async function resume(actor, input) { return enroll(actor, input, true); }
    async function enroll(actor, input, nonceFree) {
        const owner = user(actor); requireConfigured();
        if (!UUID.test(input?.checkoutId || '') || input.consent !== true || !nonceFree && (typeof input.sourceId !== 'string' || !input.sourceId.startsWith('cnon:') || input.sourceId.length > 512))
            throw fail('SQUARE_CONSENT_REQUIRED', 'カードの保存と継続課金に同意し、Squareのカード入力を完了してください。', 422);
        let quote = await loadCheckout(input.checkoutId, owner);
        if (quote.state === 'COMPLETE') return getStatus(actor);
        await location();
        if (quote.state === 'QUOTED') {
            try {
                if (Number(quote.expires_at_ms) <= now()) throw fail('SQUARE_QUOTE_EXPIRED', '申し込み内容の有効期限が切れました。内容を再確認してください。', 409);
                await quoteCurrent(quote);
                const snapshot = JSON.parse(quote.plan_json);
                if (snapshot.coupon && quote.variation_id === snapshot.baseVariationId) {
                    const catalog = await commerce.couponVariation(snapshot.coupon, snapshot);
                    await db.withDatabaseTransaction(async query => {
                        await lockOwner(query, owner); const current = await loadCheckout(quote.id, owner);
                        if (current.state !== 'QUOTED') throw fail('SQUARE_CHECKOUT_BUSY', '申し込み状況を再確認してください。', 409);
                        await query('UPDATE automation_square_checkouts SET variation_id=?,catalog_version=?,plan_json=? WHERE id=? AND state=\'QUOTED\'', [catalog.variationId, catalog.catalogVersion, JSON.stringify({ ...snapshot, ...catalog }), quote.id]);
                    });
                    quote = await loadCheckout(quote.id, owner);
                }
            } catch (error) {
                if (['SQUARE_COUPON_CHANGED','SQUARE_COUPON_UNAVAILABLE','SQUARE_COUPON_LIMIT','SQUARE_QUOTE_CHANGED','SQUARE_QUOTE_EXPIRED'].includes(error.code)) await db.withDatabaseTransaction(async query => {
                    await lockOwner(query, owner); const current = await loadCheckout(quote.id, owner);
                    if (current.state === 'QUOTED') { await query("UPDATE automation_square_checkouts SET state='FAILED' WHERE id=? AND state='QUOTED'", [quote.id]); await commerce.couponStage(query, quote, 'RELEASED'); }
                });
                throw error;
            }
        }
        const token = await leaseCheckout(quote, input.sourceId, nonceFree);
        quote = await loadCheckout(quote.id, owner);
        const recoveringUnknownSubscription = quote.state === 'SUBSCRIPTION_SUBMITTING';
        let wireStage = RETRYABLE.has(quote.state) ? quote.state : null;
        try {
            // Search an uncertain enrollment before changing its durable state
            // or requiring the old card to remain enabled. Never downgrade an
            // unknown charge to an abortable pre-enrollment stage.
            let subscription = recoveringUnknownSubscription ? await recoverSubscription(quote) : null;
            if (!subscription) {
                if (nonceFree) { await validateCustomer(quote.customer_id, owner); await validateStoredCard(quote); }
                let account = (await db.queryDatabase('SELECT * FROM automation_square_accounts WHERE owner_user_id=? AND environment=? AND merchant_id=?', [owner, ...scope]))[0];
                if (!account.customer_id) {
                    await stage(quote, token, 'CUSTOMER_SUBMITTING'); wireStage = 'CUSTOMER_SUBMITTING';
                    const { customer } = await request('POST', '/v2/customers', { idempotency_key: key(`customer:${scope}:${owner}`), reference_id: `cbte:${owner}`, email_address: account.customer_email, given_name: account.customer_name });
                    if (!customer || !SQUARE_ID.test(customer.id || '') || customer.reference_id !== `cbte:${owner}`) throw Object.assign(fail('SQUARE_RESULT_UNKNOWN', '顧客情報の作成結果を再確認してください。', 503), { uncertain: true });
                    await db.queryDatabase('UPDATE automation_square_accounts SET customer_id=?,updated_at_ms=? WHERE owner_user_id=? AND environment=? AND merchant_id=?', [customer.id, now(), owner, ...scope]);
                    account = { ...account, customer_id: customer.id };
                }
                await validateCustomer(account.customer_id, owner);
                if (!recoveringUnknownSubscription) await stage(quote, token, quote.card_id ? 'CARD_STORED' : 'CUSTOMER_READY', { customer_id: account.customer_id });
                else if (account.customer_id !== quote.customer_id || !quote.card_id) throw fail('SQUARE_ACCOUNT_MISMATCH', '未確認の契約と決済情報が一致していません。', 503);
                if (!quote.card_id) {
                    let card = await recoverCard(quote);
                    if (!card) {
                        await quoteCurrent(quote);
                        await stage(quote, token, 'CARD_SUBMITTING'); wireStage = 'CARD_SUBMITTING';
                        ({ card } = await request('POST', '/v2/cards', { idempotency_key: key(`card:${quote.id}`), source_id: input.sourceId, card: { customer_id: quote.customer_id, reference_id: quote.id, cardholder_name: quote.name } }));
                    }
                    if (!card || !SQUARE_ID.test(card.id || '') || card.customer_id !== quote.customer_id || card.reference_id !== quote.id || card.enabled === false) throw Object.assign(fail('SQUARE_RESULT_UNKNOWN', 'カードの保存結果を再確認してください。', 503), { uncertain: true });
                    await stage(quote, token, 'CARD_STORED', { card_id: card.id });
                }
                if (!recoveringUnknownSubscription) subscription = await recoverSubscription(quote);
                if (!subscription) {
                    await quoteCurrent(quote);
                    await stage(quote, token, 'SUBSCRIPTION_SUBMITTING'); wireStage = 'SUBSCRIPTION_SUBMITTING';
                    ({ subscription } = await request('POST', '/v2/subscriptions', { idempotency_key: key(`subscription:${quote.id}`), location_id: c.locationId, plan_variation_id: quote.variation_id,
                        customer_id: quote.customer_id, card_id: quote.card_id, source: { name: `cbte:${quote.id}` }, ...(JSON.parse(quote.plan_json).coupon ? {} : { price_override_money: { amount: Number(quote.amount), currency: quote.currency } }) }));
                }
            }
            if (!matchesSubscription(subscription, quote)) throw Object.assign(fail('SQUARE_RESULT_UNKNOWN', '契約の作成結果を再確認してください。', 503), { uncertain: true });
            await db.withDatabaseTransaction(async query => { await lockOwner(query, owner); if (!await rememberSubscription(quote, subscription, query, token)) throw fail('SQUARE_CHECKOUT_PENDING', '申し込み結果を再確認してください。', 409); });
        } catch (error) {
            // A known rejection cannot have created a subscription. An unknown
            // result keeps its durable stage and account claim across restarts.
            if (!recoveringUnknownSubscription && !error.uncertain && ['SQUARE_REQUEST_FAILED', 'SQUARE_QUOTE_CHANGED','SQUARE_COUPON_CHANGED','SQUARE_COUPON_UNAVAILABLE'].includes(error.code)) {
                // Preserve the definite remote rejection before finalizing the
                // local cleanup. SQL failure cannot turn this into an orphan
                // FAILED checkout with a permanently held coupon reservation.
                await stage(quote, token, 'KNOWN_REJECTED');
                await db.withDatabaseTransaction(query => finishKnownRejected(query, quote, token));
                quote.state = 'FAILED';
            } else if (wireStage) await stage(quote, token, wireStage);
            if (error.name !== 'AutomationError') throw Object.assign(fail('SQUARE_RESULT_UNKNOWN', '申し込み結果を保存できませんでした。契約状況を再確認してください。', 503), { uncertain: true, retryAfterMs: 30000 });
            throw error;
        } finally {
            await db.queryDatabase('UPDATE automation_square_checkouts SET lease_token=NULL,lease_until_at_ms=NULL WHERE id=? AND lease_token=?', [quote.id, token]);
        }
        return statusAfterMutation(actor);
    }
    async function claimCancellation(owner, expected) {
        const initial = await subscriptionRow(owner);
        if (!initial) throw fail('SQUARE_SUBSCRIPTION_NOT_FOUND', '契約が見つかりません。', 404);
        const matches = row => row?.subscription_id === expected.subscriptionId && row.checkout_id === expected.checkoutId;
        if (!matches(initial)) throw fail('SQUARE_CANCEL_CONTRACT_CHANGED', '現在の契約を再確認して、解約を申し込んでください。', 409);
        return db.withDatabaseTransaction(async query => {
            await query(`INSERT INTO automation_square_billing_cancellations (owner_user_id,environment,merchant_id,subscription_id) VALUES (?,?,?,?)
                ON DUPLICATE KEY UPDATE owner_user_id=VALUES(owner_user_id)`, [owner, ...scope, initial.subscription_id]);
            const previous = (await query('SELECT * FROM automation_square_billing_cancellations WHERE owner_user_id=? AND environment=? AND merchant_id=? FOR UPDATE', [owner, ...scope]))[0];
            await lockOwner(query, owner);
            const current = await subscriptionRow(owner, query);
            if (!current) throw fail('SQUARE_SUBSCRIPTION_NOT_FOUND', '契約が見つかりません。', 404);
            if (!matches(current)) throw fail('SQUARE_CANCEL_CONTRACT_CHANGED', '現在の契約を再確認して、解約を申し込んでください。', 409);
            const same = previous.subscription_id === current.subscription_id;
            if (same && previous.lease_token && Number(previous.lease_until_at_ms) > now()) return { state: 'busy', retryAtMs: Number(previous.lease_until_at_ms) };
            if (current.canceled_date || TERMINAL.has(current.state)) return { state: 'complete' };
            if (same && Number(previous.next_allowed_at_ms) > now()) return { state: 'cooldown', retryAtMs: Number(previous.next_allowed_at_ms) };
            const token = randomUUID();
            // Cancellation remains available independently of publication quotas
            // and ordinary GET cooldowns. Only a prior cancellation attempt for
            // this exact contract may defer another attempt across processes.
            await query('UPDATE automation_square_billing_cancellations SET subscription_id=?,lease_token=?,lease_until_at_ms=?,next_allowed_at_ms=0 WHERE owner_user_id=? AND environment=? AND merchant_id=?', [current.subscription_id, token, now() + LEASE_MS, owner, ...scope]);
            return { state: 'claimed', token, subscriptionId: current.subscription_id, checkoutId: current.checkout_id };
        });
    }
    async function currentCancellation(owner, claim) {
        return db.withDatabaseTransaction(async query => {
            const row = (await query('SELECT * FROM automation_square_billing_cancellations WHERE owner_user_id=? AND environment=? AND merchant_id=? FOR UPDATE', [owner, ...scope]))[0];
            if (row?.lease_token !== claim.token || row.subscription_id !== claim.subscriptionId || Number(row.lease_until_at_ms) <= now())
                throw Object.assign(fail('SQUARE_CANCEL_BUSY', '解約の受付状態が更新されました。契約状態を再確認してください。', 409), { retryAfterMs: REFRESH_MS });
            await lockOwner(query, owner);
            const current = await subscriptionRow(owner, query);
            // A delayed cancellation must never select a replacement contract.
            return current?.subscription_id === claim.subscriptionId && current.checkout_id === claim.checkoutId ? current : null;
        });
    }
    async function cancel(actor, input) {
        const owner = user(actor); requireConfigured();
        if (typeof input?.subscriptionId !== 'string' || !SQUARE_ID.test(input.subscriptionId)
            || typeof input?.checkoutId !== 'string' || !UUID.test(input.checkoutId))
            throw fail('SQUARE_CANCEL_CONFIRMATION_REQUIRED', '契約状態を再確認してから、解約する契約を選んでください。', 409);
        const claim = await claimCancellation(owner, input);
        if (claim.state === 'complete') return getStatus(actor);
        if (claim.state !== 'claimed') return statusDto(owner, { state: claim.state, retryAtMs: claim.retryAtMs });
        try {
            // Preserve an observed refund before a rejected or unknown cancel
            // result. Forced observations still fence older same-version polls.
            if (!await currentCancellation(owner, claim)) return getStatus(actor);
            await refreshOwner(owner, true);
            const current = await currentCancellation(owner, claim);
            if (!current) return getStatus(actor);
            if (!current.canceled_date && !TERMINAL.has(current.state)) await request('POST', `/v2/subscriptions/${encodeURIComponent(id(claim.subscriptionId))}/cancel`, {});
            if (!await currentCancellation(owner, claim)) return getStatus(actor);
            return statusAfterMutation(actor);
        } finally {
            await db.queryDatabase('UPDATE automation_square_billing_cancellations SET lease_token=NULL,lease_until_at_ms=NULL,next_allowed_at_ms=? WHERE owner_user_id=? AND environment=? AND merchant_id=? AND subscription_id=? AND lease_token=?', [now() + REFRESH_MS, owner, ...scope, claim.subscriptionId, claim.token]);
        }
    }
    async function handleWebhook(rawBody, signature) {
        requireConfigured();
        if ((!Buffer.isBuffer(rawBody) && typeof rawBody !== 'string') || Buffer.byteLength(rawBody) > 1024 * 1024) throw fail('SQUARE_WEBHOOK_INVALID', 'Webhookの形式が正しくありません。', 400);
        if (!verifyWebhookSignature(rawBody, signature, c.signatureKey, c.notificationUrl)) throw fail('SQUARE_WEBHOOK_SIGNATURE_INVALID', 'Webhookの署名を確認できません。', 403);
        let event; try { event = JSON.parse(rawBody.toString()); } catch { throw fail('SQUARE_WEBHOOK_INVALID', 'Webhookの形式が正しくありません。', 400); }
        if (!SQUARE_ID.test(event.event_id || '') || event.merchant_id !== c.merchantId || typeof event.type !== 'string' || event.type.length > 80) throw fail('SQUARE_WEBHOOK_ACCOUNT_MISMATCH', 'Webhookの送信元を確認できません。', 403);
        const bodyDigest = digest(rawBody);
        return db.withDatabaseTransaction(async query => {
            await query(`INSERT INTO automation_square_webhook_events (environment,merchant_id,event_id,body_digest,event_type,received_at_ms) VALUES (?,?,?,?,?,?)
                ON DUPLICATE KEY UPDATE event_id=VALUES(event_id)`, [...scope, event.event_id, bodyDigest, event.type, now()]);
            const records = await query('SELECT * FROM automation_square_webhook_events WHERE environment=? AND merchant_id=? AND event_id=? FOR UPDATE', [...scope, event.event_id]);
            if (records[0].body_digest !== bodyDigest) throw fail('SQUARE_WEBHOOK_CONFLICT', '同じWebhook IDで異なる通知を受信しました。', 409);
            if (records[0].processed_at_ms !== null) return { accepted: true, duplicate: true };
            if (['payment.created', 'payment.updated', 'refund.created', 'refund.updated'].includes(event.type)) {
                await require('./square-donations').createSquareDonations(db, options).handleVerifiedWebhook(event, query);
            }
            let subscriptionId = null;
            if (['subscription.created', 'subscription.updated'].includes(event.type)) subscriptionId = event.data?.object?.subscription?.id || event.data?.id;
            else if (event.type.startsWith('invoice.')) {
                const invoiceId = event.data?.object?.invoice?.id || event.data?.id;
                if (SQUARE_ID.test(invoiceId || '')) {
                    const { invoice } = await request('GET', `/v2/invoices/${encodeURIComponent(invoiceId)}`);
                    if (invoice?.location_id !== c.locationId) throw fail('SQUARE_WEBHOOK_ACCOUNT_MISMATCH', '請求の店舗を確認できません。', 403);
                    subscriptionId = invoice.subscription_id;
                }
            }
            if (SQUARE_ID.test(subscriptionId || '')) {
                const rows = await query('SELECT * FROM automation_square_subscriptions WHERE subscription_id=? AND environment=? AND merchant_id=?', [subscriptionId, ...scope]);
                if (rows[0]) {
                    const owner = rows[0].owner_user_id, claim = await claimRefresh(owner, true, query);
                    // Read before taking the owner lock. The refresh token is
                    // held by this event transaction and fences older polls.
                    const snapshot = await collectReconciliation(rows[0], refreshReader());
                    await lockOwner(query, owner);
                    try { await applyReconciliation(query, rows[0], snapshot); }
                    catch (error) { if (error.code !== 'SQUARE_PRORATION_UNVERIFIED') throw error; await recordProrationFailure(query, rows[0], snapshot, error); }
                    await query('UPDATE automation_square_billing_reconciliation SET lease_token=NULL,lease_until_at_ms=NULL,next_allowed_at_ms=? WHERE owner_user_id=? AND environment=? AND merchant_id=? AND lease_token=?', [now() + REFRESH_MS, owner, ...scope, claim.token]);
                }
                // An unbound Square contract is never trusted as a local paid
                // grant. A durable pending checkout can recover through status.
            }
            await query('UPDATE automation_square_webhook_events SET processed_at_ms=? WHERE environment=? AND merchant_id=? AND event_id=?', [now(), ...scope, event.event_id]);
            return { accepted: true, duplicate: false };
        });
    }
    return { getOptions, getStatus, getAdmin, saveBinding, createQuote, subscribe, resume, abort, cancel, handleWebhook };
}

module.exports = { API_VERSION, getSquareScope, createSquareClient, createSquareBilling, verifyWebhookSignature, dateEnd, isValidReceiptEmail, validateVariation };
