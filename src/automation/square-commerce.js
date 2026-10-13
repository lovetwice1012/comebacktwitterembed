'use strict';
const { randomUUID, createHash } = require('node:crypto');
const { createSquareClient, validateVariation } = require('./square-billing');
const CADENCES = new Set(['DAILY','WEEKLY','EVERY_TWO_WEEKS','THIRTY_DAYS','SIXTY_DAYS','NINETY_DAYS','MONTHLY','EVERY_TWO_MONTHS','QUARTERLY','EVERY_FOUR_MONTHS','EVERY_SIX_MONTHS','ANNUAL','EVERY_TWO_YEARS']);
const PLAN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/, CODE = /^[A-Z0-9][A-Z0-9_-]{0,63}$/, ID = /^[A-Za-z0-9:_-]{1,255}$/;
const TTL = 15 * 60000, LEASE = 5 * 60000;
function fail(code, message, status = 422) { return Object.assign(new Error(message), { name: 'AutomationError', code, status }); }
function admin(actor) { if (actor?.isAdmin !== true || !/^\d{1,32}$/.test(String(actor?.userId || ''))) throw fail('AUTOMATION_FORBIDDEN', '料金とクーポンの設定には管理者権限が必要です。', 403); return String(actor.userId); }
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function positive(value, max = 1000000000) { if (!Number.isSafeInteger(value) || value < 1 || value > max) throw fail('SQUARE_COMMERCE_INVALID', '金額・回数は指定範囲内の正の整数を入力してください。'); return value; }
function nullablePositive(value) { return value == null ? null : positive(value, 1000000); }
function couponCode(value) { const code = String(value || '').trim().toUpperCase(); if (!CODE.test(code)) throw fail('SQUARE_COUPON_INVALID', 'クーポンコードは1〜64文字の英数字・ハイフン・アンダースコアで入力してください。'); return code; }
function couponDto(row) { return { code: row.code, label: row.label, type: row.discount_type, value: Number(row.discount_value), currency: row.currency,
    planIds: JSON.parse(row.plan_ids_json), enabled: Number(row.enabled) === 1, expiresAtMs: row.expires_at_ms == null ? null : Number(row.expires_at_ms),
    totalLimit: row.total_limit == null ? null : Number(row.total_limit), userLimit: row.user_limit == null ? null : Number(row.user_limit),
    updatedAtMs: Number(row.updated_at_ms), used: Number(row.used || 0), reserved: Number(row.reserved || 0) }; }
function creationDto(row, clock) { return { ...JSON.parse(row.terms_json), creationId: row.id, expiresAtMs: Number(row.expires_at_ms), state: row.state,
    variationId: row.variation_id || null, retryable: row.state === 'UNKNOWN' || row.state === 'SUBMITTING' && Number(row.lease_until_at_ms) <= clock }; }
function catalogBody(identity, name, cadence, amount, currency, firstAmount) {
    const parent = '#plan-' + identity, variation = '#variation-' + identity;
    const phase = (ordinal, price, periods) => ({ ordinal, cadence, ...(periods ? { periods } : {}), pricing: { type: 'STATIC', price_money: { amount: price, currency } } });
    return { idempotency_key: identity, object: { type: 'SUBSCRIPTION_PLAN', id: parent, present_at_all_locations: true,
        subscription_plan_data: { name, subscription_plan_variations: [{ type: 'SUBSCRIPTION_PLAN_VARIATION', id: variation, present_at_all_locations: true,
            subscription_plan_variation_data: { name, subscription_plan_id: parent, can_prorate: false, phases: firstAmount == null ? [phase(0, amount)] : [phase(0, firstAmount, 1), phase(1, amount)] } }] } } };
}
function validateCouponVariation(object, locationId, terms) {
    const data = object?.subscription_plan_variation_data, phases = data?.phases;
    if (!object || object.type !== 'SUBSCRIPTION_PLAN_VARIATION' || object.is_deleted || !ID.test(object.id || '') || !/^\d+$/.test(String(object.version || ''))
        || object.present_at_all_locations === false
        || !Array.isArray(phases) || phases.length !== 2 || data.can_prorate === true || data.monthly_billing_anchor_date != null) throw fail('SQUARE_COUPON_VARIATION_MISMATCH', '初回割引のSquare料金を確認できません。', 503);
    for (let i = 0; i < 2; i++) {
        const p = phases[i], price = p.pricing?.price_money;
        if (Number(p.ordinal) !== i || p.cadence !== terms.cadence || p.pricing?.type !== 'STATIC' || Number(price?.amount) !== (i ? terms.regularAmount : terms.firstAmount)
            || price?.currency !== terms.currency || (i === 0 ? Number(p.periods) !== 1 : p.periods != null)) throw fail('SQUARE_COUPON_VARIATION_MISMATCH', '初回割引と通常料金の設定が一致していません。', 503);
    }
    return { variationId: object.id, catalogVersion: String(object.version), catalogName: data.name, cadence: terms.cadence, amount: terms.regularAmount, currency: terms.currency, firstAmount: terms.firstAmount, regularAmount: terms.regularAmount };
}
function createSquareCommerce(db, options = {}) {
    const { config: c, scope, now, request, location, requireConfigured } = createSquareClient(options);
    const catalogMismatch = () => fail('SQUARE_CATALOG_MISMATCH', '作成元のSquare料金と確認内容が一致しません。管理画面で確認してください。', 503);
    const catalogDisabled = () => fail('SQUARE_CATALOG_DISABLED', 'Squareの料金が無効です。管理画面で確認してください。', 409);
    async function ownership(originalRequest, variationId, response) {
        const reference = originalRequest.idempotency_key, digest = hash(originalRequest);
        let row = (await db.queryDatabase('SELECT * FROM automation_square_catalog_ownership WHERE environment=? AND merchant_id=? AND request_ref=?', [...scope, reference]))[0];
        if (!row || response) {
            // Old READY coupon caches lack ownership metadata. After explicit
            // enrollment consent, replay only the immutable original creation
            // request and require the very same variation before adopting it.
            response ||= await request('POST', '/v2/catalog/object', originalRequest);
            const children = originalRequest.object?.subscription_plan_data?.subscription_plan_variations;
            const mappings = response.id_mappings || [];
            const childIds = mappings.filter(item => item.client_object_id === children?.[0]?.id).map(item => item.object_id);
            const parentIds = mappings.filter(item => item.client_object_id === originalRequest.object?.id).map(item => item.object_id);
            const parentId = parentIds[0] || response.catalog_object?.id;
            if (childIds.length !== 1 || childIds[0] !== variationId || parentIds.length > 1 || !ID.test(parentId || '')
                || response.catalog_object?.id && response.catalog_object.id !== parentId) throw catalogMismatch();
            row = await db.withDatabaseTransaction(async query => {
                await query(`INSERT INTO automation_square_catalog_ownership (environment,merchant_id,request_ref,variation_id,parent_id,request_digest,updated_at_ms)
                    VALUES (?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE variation_id=variation_id`, [...scope, reference, variationId, parentId, digest, now()]);
                const saved = (await query('SELECT * FROM automation_square_catalog_ownership WHERE environment=? AND merchant_id=? AND request_ref=? FOR UPDATE', [...scope, reference]))[0];
                if (!saved || saved.variation_id !== variationId || saved.parent_id !== parentId || saved.request_digest !== digest) throw catalogMismatch();
                return saved;
            });
        }
        if (row.variation_id !== variationId || row.request_digest !== digest) throw catalogMismatch();
        return row;
    }
    async function readOwnedPair(owned, originalRequest, validate) {
        const object = (await request('GET', '/v2/catalog/object/' + encodeURIComponent(owned.variation_id))).object;
        const parent = (await request('GET', '/v2/catalog/object/' + encodeURIComponent(owned.parent_id))).object;
        const frozenParent = originalRequest.object?.subscription_plan_data, frozen = frozenParent?.subscription_plan_variations?.[0]?.subscription_plan_variation_data;
        const data = object?.subscription_plan_variation_data, phases = data?.phases;
        const variations = parent?.subscription_plan_data?.subscription_plan_variations;
        if (!object || object.id !== owned.variation_id || data?.subscription_plan_id !== owned.parent_id
            || !parent || parent.id !== owned.parent_id || parent.type !== 'SUBSCRIPTION_PLAN' || parent.is_deleted || !/^\d+$/.test(String(parent.version || ''))
            || parent.subscription_plan_data?.name !== frozenParent?.name || data?.name !== frozen?.name
            || !Array.isArray(variations) || variations.filter(item => item.id === owned.variation_id).length !== 1
            || data.can_prorate === true || data.monthly_billing_anchor_date != null
            || !Array.isArray(phases) || phases.length !== frozen?.phases?.length || !phases.every((phase, index) => {
                const expected = frozen.phases[index], price = phase.pricing?.price_money;
                return Number(phase.ordinal) === Number(expected.ordinal) && phase.cadence === expected.cadence
                    && (phase.periods == null ? expected.periods == null : expected.periods != null && Number(phase.periods) === Number(expected.periods))
                    && phase.pricing?.type === 'STATIC' && Number(price?.amount) === Number(expected.pricing.price_money.amount) && price?.currency === expected.pricing.price_money.currency;
            })) throw catalogMismatch();
        return { object, parent, checked: validate({ ...object, present_at_all_locations: true }) };
    }
    async function readCreatedCatalog(variationId, originalRequest, validate, response = null) {
        const owned = await ownership(originalRequest, variationId, response);
        let pair = await readOwnedPair(owned, originalRequest, validate);
        const repair = await db.withDatabaseTransaction(async query => {
            const current = (await query('SELECT * FROM automation_square_catalog_ownership WHERE environment=? AND merchant_id=? AND request_ref=? FOR UPDATE', [...scope, owned.request_ref]))[0];
            const active = pair.object.present_at_all_locations === true && pair.parent.present_at_all_locations === true;
            if (current.state === 'VERIFIED') { if (!active) throw catalogDisabled(); return null; }
            if (current.state === 'REPAIRING') { if (!current.repair_request_json) throw catalogMismatch(); return JSON.parse(current.repair_request_json); }
            if (current.state !== 'OWNED') throw catalogMismatch();
            if (active) {
                await query("UPDATE automation_square_catalog_ownership SET state='VERIFIED',updated_at_ms=? WHERE environment=? AND merchant_id=? AND request_ref=?", [now(), ...scope, owned.request_ref]);
                return null;
            }
            if (originalRequest.object?.present_at_all_locations !== false) throw catalogDisabled();
            const restored = structuredClone(pair.parent), variations = restored.subscription_plan_data.subscription_plan_variations;
            if (restored.present_at_all_locations !== true && variations.some(item => item.id !== variationId && !item.is_deleted && item.present_at_all_locations !== false))
                throw fail('SQUARE_CATALOG_REPAIR_COLLATERAL', '同じSquareプランの別料金も有効になるため、自動修復できません。管理画面で確認してください。', 409);
            restored.present_at_all_locations = true; delete restored.present_at_location_ids; delete restored.absent_at_location_ids;
            const index = variations.findIndex(item => item.id === variationId);
            variations[index] = { ...pair.object, present_at_all_locations: true };
            delete variations[index].present_at_location_ids; delete variations[index].absent_at_location_ids;
            const frozenRepair = { idempotency_key: hash(['activate-known-creation', scope, owned.request_ref, pair.parent.version, pair.object.version]), object: restored };
            // Commit the full payload and one repair key before the wire. ACK
            // loss always replays this request; it never invents another repair
            // capable of re-enabling a later operator-disabled catalog object.
            await query("UPDATE automation_square_catalog_ownership SET state='REPAIRING',repair_request_json=?,updated_at_ms=? WHERE environment=? AND merchant_id=? AND request_ref=?", [JSON.stringify(frozenRepair), now(), ...scope, owned.request_ref]);
            return frozenRepair;
        });
        if (!repair) return pair.checked;
        await request('POST', '/v2/catalog/object', repair);
        pair = await readOwnedPair(owned, originalRequest, validate);
        if (pair.object.present_at_all_locations !== true || pair.parent.present_at_all_locations !== true) throw catalogDisabled();
        await db.queryDatabase("UPDATE automation_square_catalog_ownership SET state='VERIFIED',updated_at_ms=? WHERE environment=? AND merchant_id=? AND request_ref=? AND state='REPAIRING' AND repair_request_json=?", [now(), ...scope, owned.request_ref, JSON.stringify(repair)]);
        return pair.checked;
    }
    async function getAdmin(actor) {
        admin(actor);
        if (!c.configured) return { configured: false, environment: c.environment, coupons: [], creations: [], locationCurrency: null, minorUnitDigits: null };
        const found = await location(), rows = await db.queryDatabase(`SELECT p.*,
            (SELECT COUNT(*) FROM automation_square_coupon_uses u WHERE u.code=p.code AND u.environment=p.environment AND u.merchant_id=p.merchant_id AND u.state='COMMITTED') AS used,
            (SELECT COUNT(*) FROM automation_square_coupon_uses u WHERE u.code=p.code AND u.environment=p.environment AND u.merchant_id=p.merchant_id AND u.state IN ('RESERVED','SUBMITTING')) AS reserved
            FROM automation_square_coupons p WHERE p.environment=? AND p.merchant_id=? ORDER BY p.code`, scope);
        const pendingCreations = await db.queryDatabase("SELECT * FROM automation_square_catalog_creations WHERE environment=? AND merchant_id=? AND state IN ('SUBMITTING','UNKNOWN','QUOTED') ORDER BY created_at_ms DESC", scope);
        const finishedCreations = await db.queryDatabase("SELECT * FROM automation_square_catalog_creations WHERE environment=? AND merchant_id=? AND state NOT IN ('SUBMITTING','UNKNOWN','QUOTED') ORDER BY created_at_ms DESC LIMIT 100", scope);
        const creations = [...pendingCreations, ...finishedCreations];
        return { configured: true, environment: c.environment, locationCurrency: found.currency || null, minorUnitDigits: found.currency ? new Intl.NumberFormat('en', { style: 'currency', currency: found.currency }).resolvedOptions().maximumFractionDigits : null, coupons: rows.map(couponDto), creations: creations.map(row => creationDto(row, now())) };
    }
    async function createCatalogQuote(actor, input) {
        admin(actor); requireConfigured();
        if (!PLAN.test(input?.planId || '') || ['free','supporter'].includes(input.planId.toLowerCase()) || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 120 || !CADENCES.has(input.cadence) || !/^[A-Z]{3}$/.test(input.currency || '')) throw fail('SQUARE_COMMERCE_INVALID', '有償プラン名・通貨・課金周期を確認してください。');
        const amount = positive(input.amount), found = await location(); if (found.currency !== input.currency) throw fail('SQUARE_COMMERCE_CURRENCY_MISMATCH', '店舗の通貨と料金の通貨を合わせてください。');
        const terms = { planId: input.planId, name: input.name.trim(), cadence: input.cadence, amount, currency: input.currency };
        return db.withDatabaseTransaction(async query => {
            const plans = await query('SELECT * FROM automation_notification_plans WHERE plan_id=? FOR UPDATE', [terms.planId]); if (!plans[0]) throw fail('AUTOMATION_PLAN_NOT_FOUND', '通知プランを先に登録してください。', 404);
            if ((await query('SELECT plan_id FROM automation_square_bindings WHERE plan_id=? AND environment=? AND merchant_id=?', [terms.planId, ...scope])).length) throw fail('SQUARE_CATALOG_ALREADY_BOUND', 'この通知プランはSquareと連携済みです。', 409);
            const existing = (await query('SELECT * FROM automation_square_catalog_creations WHERE plan_id=? AND environment=? AND merchant_id=? FOR UPDATE', [terms.planId, ...scope]))[0];
            if (existing && !['QUOTED','FAILED'].includes(existing.state)) throw fail('SQUARE_CATALOG_PENDING', '既存の料金作成の結果を確認してください。', 409);
            const id = randomUUID(), body = catalogBody(id, terms.name, terms.cadence, amount, terms.currency);
            if (existing) await query('DELETE FROM automation_square_catalog_creations WHERE id=?', [existing.id]);
            await query('INSERT INTO automation_square_catalog_creations (id,environment,merchant_id,plan_id,terms_json,request_json,expires_at_ms,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,?,?,?,?)', [id, ...scope, terms.planId, JSON.stringify(terms), JSON.stringify(body), now() + TTL, now(), now()]);
            return creationDto((await query('SELECT * FROM automation_square_catalog_creations WHERE id=?', [id]))[0], now());
        });
    }
    async function getCreation(actor, creationId) { admin(actor); const row = (await db.queryDatabase('SELECT * FROM automation_square_catalog_creations WHERE id=? AND environment=? AND merchant_id=?', [creationId, ...scope]))[0]; if (!row) throw fail('SQUARE_CATALOG_NOT_FOUND', '料金作成の申し込みが見つかりません。', 404); return creationDto(row, now()); }
    async function confirmCatalogCreation(actor, input) {
        admin(actor); requireConfigured(); if (input?.consent !== true) throw fail('SQUARE_CONSENT_REQUIRED', '表示された料金の作成に同意してください。');
        const token = randomUUID();
        /** @type {any} */
        let row = null;
        await db.withDatabaseTransaction(async query => {
            row = (await query('SELECT * FROM automation_square_catalog_creations WHERE id=? AND environment=? AND merchant_id=? FOR UPDATE', [input.creationId, ...scope]))[0];
            if (!row) throw fail('SQUARE_CATALOG_NOT_FOUND', '料金作成の申し込みが見つかりません。', 404);
            if (row.state === 'COMPLETE') return;
            if (row.state === 'FAILED') throw fail('SQUARE_CATALOG_FAILED', '料金作成を確認し直してください。', 409);
            if (row.state === 'QUOTED' && Number(row.expires_at_ms) <= now()) throw fail('SQUARE_CATALOG_QUOTE_EXPIRED', '確認内容の期限が切れました。', 409);
            if (row.lease_token && Number(row.lease_until_at_ms) > now()) throw fail('SQUARE_CATALOG_BUSY', 'Squareの料金を作成しています。', 409);
            await query("UPDATE automation_square_catalog_creations SET state='SUBMITTING',lease_token=?,lease_until_at_ms=?,updated_at_ms=? WHERE id=?", [token, now() + LEASE, now(), row.id]);
        });
        if (row.state === 'COMPLETE') return creationDto(row, now());
        let wireAccepted = false;
        try {
            await location(); const response = await request('POST', '/v2/catalog/object', JSON.parse(row.request_json)); wireAccepted = true;
            const variationId = response.id_mappings?.find(item => item.client_object_id === '#variation-' + row.id)?.object_id;
            if (!ID.test(variationId || '')) throw Object.assign(fail('SQUARE_CATALOG_RESULT_UNKNOWN', '料金の作成結果を確認できません。', 503), { uncertain: true });
            const terms = JSON.parse(row.terms_json);
            const catalog = await readCreatedCatalog(variationId, JSON.parse(row.request_json), object => {
                const found = validateVariation(object, c.locationId);
                if (found.amount !== terms.amount || found.currency !== terms.currency || found.cadence !== terms.cadence || found.catalogName !== terms.name) throw fail('SQUARE_CATALOG_MISMATCH', '作成されたSquare料金と確認内容が一致しません。', 503);
                return found;
            }, response);
            await db.withDatabaseTransaction(async query => {
                await query('SELECT plan_id FROM automation_notification_plans ORDER BY plan_id FOR UPDATE');
                const active = (await query('SELECT * FROM automation_square_catalog_creations WHERE id=? FOR UPDATE', [row.id]))[0]; if (active.lease_token !== token) throw fail('SQUARE_CATALOG_BUSY', '料金作成の結果を確認してください。', 409);
                const bound = await query('SELECT * FROM automation_square_bindings WHERE plan_id=? AND environment=? AND merchant_id=? FOR UPDATE', [row.plan_id, ...scope]);
                if (bound.length && bound[0].variation_id !== variationId) throw fail('SQUARE_CATALOG_ALREADY_BOUND', '別の料金へ連携が変更されています。', 409);
                if (!bound.length) await query('INSERT INTO automation_square_bindings (plan_id,environment,merchant_id,variation_id,enabled,catalog_name,cadence,amount,currency,catalog_version,verified_at_ms,actor_user_id) VALUES (?,?,?,?,1,?,?,?,?,?,?,?)', [row.plan_id, ...scope, variationId, catalog.catalogName, catalog.cadence, catalog.amount, catalog.currency, catalog.catalogVersion, now(), actor.userId]);
                await query("UPDATE automation_square_catalog_creations SET state='COMPLETE',variation_id=?,updated_at_ms=? WHERE id=?", [variationId, now(), row.id]);
            });
        } catch (error) {
            await db.queryDatabase('UPDATE automation_square_catalog_creations SET state=?,updated_at_ms=? WHERE id=? AND lease_token=? AND state<>\'COMPLETE\'', [row.state === 'QUOTED' && !wireAccepted && error.code === 'SQUARE_REQUEST_FAILED' && !error.uncertain ? 'FAILED' : 'UNKNOWN', now(), row.id, token]); throw error;
        } finally { await db.queryDatabase('UPDATE automation_square_catalog_creations SET lease_token=NULL,lease_until_at_ms=NULL WHERE id=? AND lease_token=?', [row.id, token]); }
        return getCreation(actor, row.id);
    }
    async function saveCoupon(actor, input) {
        const actorId = admin(actor); requireConfigured(); const code = couponCode(input?.code);
        if (!['fixed','percent'].includes(input.type) || typeof input.enabled !== 'boolean' || typeof input.label !== 'string' || !input.label.trim() || input.label.length > 120 || !Array.isArray(input.planIds) || !input.planIds.length || input.planIds.length > 100 || input.planIds.some(plan => !PLAN.test(plan) || ['free','supporter'].includes(plan.toLowerCase()))) throw fail('SQUARE_COUPON_INVALID', 'クーポン名・種類・対象有償プランを確認してください。');
        const value = positive(input.value, input.type === 'percent' ? 99 : 1000000000), currency = input.type === 'fixed' ? input.currency : null;
        if (input.type === 'fixed' && !/^[A-Z]{3}$/.test(currency || '')) throw fail('SQUARE_COUPON_INVALID', '定額割引の通貨を指定してください。');
        const found = await location(); if (currency && currency !== found.currency) throw fail('SQUARE_COMMERCE_CURRENCY_MISMATCH', '店舗の通貨と割引の通貨を合わせてください。');
        const expires = input.expiresAtMs ?? null; if (expires !== null && (!Number.isSafeInteger(expires) || expires < 1 || input.enabled && expires <= now())) throw fail('SQUARE_COUPON_INVALID', '有効なクーポンの期限は未来の日時を指定してください。');
        const total = nullablePositive(input.totalLimit), perUser = nullablePositive(input.userLimit), planIds = [...new Set(input.planIds)].sort();
        return db.withDatabaseTransaction(async query => {
            await query('SELECT plan_id FROM automation_notification_plans ORDER BY plan_id FOR UPDATE');
            for (const planId of planIds) if (!(await query('SELECT plan_id FROM automation_notification_plans WHERE plan_id=?', [planId])).length) throw fail('AUTOMATION_PLAN_NOT_FOUND', '対象の通知プランが見つかりません。', 404);
            const row = (await query('SELECT * FROM automation_square_coupons WHERE code=? AND environment=? AND merchant_id=? FOR UPDATE', [code, ...scope]))[0];
            if ((input.expectedUpdatedAtMs ?? null) !== (row ? Number(row.updated_at_ms) : null)) throw fail('SQUARE_COUPON_CONFLICT', 'クーポンが変更されています。最新の設定を読み直してください。', 409);
            const timestamp = Math.max(now(), row ? Number(row.updated_at_ms) + 1 : 0);
            const fields = [input.label.trim(), input.type, value, currency, JSON.stringify(planIds), input.enabled ? 1 : 0, expires, total, perUser, timestamp, actorId];
            if (row) await query('UPDATE automation_square_coupons SET label=?,discount_type=?,discount_value=?,currency=?,plan_ids_json=?,enabled=?,expires_at_ms=?,total_limit=?,user_limit=?,updated_at_ms=?,actor_user_id=? WHERE code=? AND environment=? AND merchant_id=?', [...fields, code, ...scope]);
            else await query('INSERT INTO automation_square_coupons (label,discount_type,discount_value,currency,plan_ids_json,enabled,expires_at_ms,total_limit,user_limit,updated_at_ms,actor_user_id,code,environment,merchant_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [...fields, code, ...scope]);
            return couponDto((await query(`SELECT p.*,
                (SELECT COUNT(*) FROM automation_square_coupon_uses u WHERE u.code=p.code AND u.environment=p.environment AND u.merchant_id=p.merchant_id AND u.state='COMMITTED') AS used,
                (SELECT COUNT(*) FROM automation_square_coupon_uses u WHERE u.code=p.code AND u.environment=p.environment AND u.merchant_id=p.merchant_id AND u.state IN ('RESERVED','SUBMITTING')) AS reserved
                FROM automation_square_coupons p WHERE p.code=? AND p.environment=? AND p.merchant_id=?`, [code, ...scope]))[0]);
        });
    }
    async function resolveCoupon(code, plan, query = db.queryDatabase, locked = false) {
        const row = (await query('SELECT * FROM automation_square_coupons WHERE code=? AND environment=? AND merchant_id=?' + (locked ? ' FOR UPDATE' : ''), [couponCode(code), ...scope]))[0];
        if (!row || Number(row.enabled) !== 1 || row.expires_at_ms != null && Number(row.expires_at_ms) <= now() || !JSON.parse(row.plan_ids_json).includes(plan.planId) || row.currency && row.currency !== plan.currency) throw fail('SQUARE_COUPON_UNAVAILABLE', 'このクーポンは選択したプランには利用できません。');
        if (plan.canProrate || plan.billingAnchorDay != null) throw fail('SQUARE_COUPON_PRORATION_UNSUPPORTED', '日割りや固定課金日のあるプランには初回クーポンを利用できません。');
        const discount = row.discount_type === 'fixed' ? Number(row.discount_value) : Math.floor(plan.amount * Number(row.discount_value) / 100), first = plan.amount - discount;
        if (discount < 1 || first < 1) throw fail('SQUARE_COUPON_AMOUNT_INVALID', '割引後の初回料金は通貨の最小単位で1以上必要です。');
        return { code: row.code, label: row.label, type: row.discount_type, value: Number(row.discount_value), discountAmount: discount, updatedAtMs: Number(row.updated_at_ms), firstAmount: first, regularAmount: plan.amount, currency: plan.currency, cadence: plan.cadence };
    }
    async function couponVariation(terms, base) {
        const identity = hash([scope, base.variationId, base.catalogVersion, terms]), body = catalogBody(identity, base.catalogName + ' [' + terms.code + ']', terms.cadence, terms.regularAmount, terms.currency, terms.firstAmount);
        const token = randomUUID();
        /** @type {any} */
        let record = null;
        await db.withDatabaseTransaction(async query => {
            await query('INSERT INTO automation_square_coupon_variations (identity_key,environment,merchant_id,request_json) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE identity_key=VALUES(identity_key)', [identity, ...scope, JSON.stringify(body)]);
            record = (await query('SELECT * FROM automation_square_coupon_variations WHERE identity_key=? FOR UPDATE', [identity]))[0];
            if (record.variation_id) return;
            if (record.lease_token && Number(record.lease_until_at_ms) > now()) throw fail('SQUARE_COUPON_PREPARING', '初回料金を準備しています。少し待って確認し直してください。', 409);
            await query('UPDATE automation_square_coupon_variations SET lease_token=?,lease_until_at_ms=? WHERE identity_key=?', [token, now() + LEASE, identity]);
        });
        let variationId = record.variation_id, response = null;
        try {
            if (!variationId) {
                response = await request('POST', '/v2/catalog/object', JSON.parse(record.request_json)); variationId = response.id_mappings?.find(item => item.client_object_id === '#variation-' + identity)?.object_id;
            }
            if (!ID.test(variationId || '')) throw fail('SQUARE_COUPON_PREPARING', '初回料金の作成結果を確認できません。', 503);
            const catalog = await readCreatedCatalog(variationId, JSON.parse(record.request_json), object => validateCouponVariation(object, c.locationId, terms), response);
            if (!record.variation_id) await db.queryDatabase("UPDATE automation_square_coupon_variations SET state='READY',variation_id=?,catalog_version=? WHERE identity_key=? AND lease_token=?", [variationId, catalog.catalogVersion, identity, token]);
            return catalog;
        } finally { await db.queryDatabase('UPDATE automation_square_coupon_variations SET lease_token=NULL,lease_until_at_ms=NULL WHERE identity_key=? AND lease_token=?', [identity, token]); }
    }
    async function reserveCoupon(query, owner, checkoutId, terms, plan, expiresAt) {
        const current = await resolveCoupon(terms.code, plan, query, true); if (current.updatedAtMs !== terms.updatedAtMs || current.firstAmount !== terms.firstAmount) throw fail('SQUARE_COUPON_CHANGED', 'クーポンが変更されています。確認し直してください。', 409);
        await query(`UPDATE automation_square_coupon_uses u LEFT JOIN automation_square_checkouts q ON q.id=u.checkout_id SET u.state='RELEASED',u.updated_at_ms=?
            WHERE u.code=? AND u.environment=? AND u.merchant_id=? AND u.subscription_id IS NULL
                AND ((u.state='RESERVED' AND u.expires_at_ms<=? AND (q.id IS NULL OR q.state='QUOTED'))
                    OR (u.state IN ('RESERVED','SUBMITTING') AND q.state='FAILED' AND q.subscription_id IS NULL
                        AND (q.lease_token IS NULL OR q.lease_until_at_ms<=?)
                        AND NOT EXISTS (SELECT 1 FROM automation_square_subscriptions s WHERE s.checkout_id=q.id)))`, [now(), terms.code, ...scope, now(), now()]);
        const coupon = (await query('SELECT * FROM automation_square_coupons WHERE code=? AND environment=? AND merchant_id=?', [terms.code, ...scope]))[0];
        const counts = (await query("SELECT COUNT(*) AS total,SUM(owner_user_id=?) AS mine FROM automation_square_coupon_uses WHERE code=? AND environment=? AND merchant_id=? AND state IN ('RESERVED','SUBMITTING','COMMITTED') FOR UPDATE", [owner, terms.code, ...scope]))[0];
        if (coupon.total_limit != null && Number(counts.total) >= Number(coupon.total_limit) || coupon.user_limit != null && Number(counts.mine) >= Number(coupon.user_limit)) throw fail('SQUARE_COUPON_LIMIT', 'クーポンの利用上限に達しています。');
        await query('INSERT INTO automation_square_coupon_uses (checkout_id,code,environment,merchant_id,owner_user_id,terms_json,expires_at_ms,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,?,?,?,?)', [checkoutId, terms.code, ...scope, owner, JSON.stringify(terms), expiresAt, now(), now()]);
    }
    async function assertCouponCurrent(quote, plan) {
        if (!plan.coupon) return;
        const current = await resolveCoupon(plan.coupon.code, { ...plan, amount: plan.regularAmount }, db.queryDatabase);
        if (current.updatedAtMs !== plan.coupon.updatedAtMs || current.firstAmount !== plan.firstAmount) throw fail('SQUARE_COUPON_CHANGED', 'クーポンが無効・期限切れ・変更されています。再確認してください。', 409);
        const row = (await db.queryDatabase('SELECT state FROM automation_square_coupon_uses WHERE checkout_id=?', [quote.id]))[0];
        if (!row || row.state === 'RELEASED') throw fail('SQUARE_COUPON_CHANGED', 'クーポンの予約が失効しています。再確認してください。', 409);
    }
    async function couponStage(query, quote, state) { await query("UPDATE automation_square_coupon_uses SET state=?,updated_at_ms=? WHERE checkout_id=? AND state IN ('RESERVED','SUBMITTING')", [state, now(), quote.id]); }
    async function confirmInvoice(query, quote, subscription, invoice) {
        const plan = JSON.parse(quote.plan_json); if (!plan.coupon) return Number(quote.amount);
        const uses = (await query('SELECT * FROM automation_square_coupon_uses WHERE checkout_id=? FOR UPDATE', [quote.id]))[0];
        if (!uses || uses.state === 'RELEASED') throw fail('SQUARE_COUPON_ACCOUNT_MISMATCH', '初回割引の利用記録を確認できません。', 503);
        const remembered = (await query('SELECT first_invoice_id FROM automation_square_subscription_invoices WHERE environment=? AND merchant_id=? AND subscription_id=?', [...scope, subscription.id]))[0];
        const firstId = uses.first_invoice_id || remembered?.first_invoice_id || subscription.invoice_ids?.[subscription.invoice_ids.length - 1];
        if (!ID.test(firstId || '')) throw fail('SQUARE_COUPON_INVOICE_PENDING', '初回の請求を確認しています。', 503);
        const expected = invoice.id === firstId ? plan.firstAmount : plan.regularAmount;
        const requests = invoice.payment_requests;
        if (Array.isArray(requests) && requests.length > 0 && requests.every(part => part.computed_amount_money?.currency === quote.currency)
            && requests.reduce((sum, part) => sum + Number(part.computed_amount_money?.amount), 0) === expected) {
            await query("UPDATE automation_square_coupon_uses SET state='COMMITTED',subscription_id=?,first_invoice_id=?,updated_at_ms=? WHERE checkout_id=? AND state IN ('RESERVED','SUBMITTING','COMMITTED')", [subscription.id, firstId, now(), quote.id]);
        }
        return expected;
    }
    return { getAdmin, createCatalogQuote, confirmCatalogCreation, getCatalogCreation: getCreation, getCreation, saveCoupon, resolveCoupon, couponVariation, reserveCoupon, assertCouponCurrent, couponStage, confirmInvoice };
}
module.exports = { createSquareCommerce, validateCouponVariation };
