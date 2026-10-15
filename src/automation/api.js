'use strict';

// The web boundary derives actor from the authenticated session. This dispatcher
// is also used by loopback-only fixture tests; it contains no auth bypass.
const { requireActor, AutomationError, publicDestination, validateAssignmentGuards } = require('./service');
/** @param {{method:string,path:string[],search?:URLSearchParams,body?:Record<string,any>}} request */
async function dispatch(request, actor, services) {
    requireActor(actor);
    const { method, path, body = {} } = request;
    if (!Array.isArray(path) || path.length < 1 || path.length > 3 || !['GET','POST','PUT','PATCH','DELETE'].includes(method)) throw new AutomationError('NOT_FOUND', '操作が見つかりません。', 404);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AutomationError('INVALID_BODY', 'オブジェクト形式の入力が必要です。');
    if (path[0] === 'donors' && actor.isAdmin !== true) throw new AutomationError('AUTOMATION_FORBIDDEN', '支援者の管理には管理者権限が必要です。', 403);
    if (path[0] === 'push-capacity') require('./push-capacity').requireAdmin(actor);
    let group;
    if (method !== 'GET' && method !== 'DELETE') {
        group = path[0] === 'validate' || path[0] === 'dictionary-preview' ? 'validate' : path[0] === 'simulate' || path.at(-1) === 'test' ? 'simulate' : path[0] === 'monitors' ? 'monitor' : path[0] === 'marketplace' && (!path[2] || path[2] === 'status') ? 'publication' : 'write';
        if (path[0] === 'billing' && (['subscribe', 'resume'].includes(path[1]) || path[1] === 'donations' && path[2] === 'donate' || path[1] === 'catalog' && path[2] === 'create')) group = 'publication';
        if (path[0] === 'billing' && ['cancel', 'abort'].includes(path[1])) group = undefined;
        if (path[0] === 'monitors' && body.action === 'cadence' && body.slotCost === 1) group = undefined;
        if (path[0] === 'workflows' && path[2] === 'state' && body.enabled === false || path[0] === 'monitors' && (body.action === 'detach' || body.enabled === false && Object.keys(body).every(key => ['enabled', 'expectedRevision'].includes(key))) || path[0] === 'marketplace' && path[2] === 'status' && body.status === 'withdrawn') group = undefined;
    }
    if (!group) return dispatchCore(request, actor, services);
    if (typeof services.service?.withOperation !== 'function') throw new AutomationError('AUTOMATION_RATE_LIMIT_UNAVAILABLE', '利用制限を確認できませんでした。少し待ってから再度お試しください。', 503);
    return services.service.withOperation(actor, group, () => dispatchCore(request, actor, services));
}
/** @param {{method:string,path:string[],search?:URLSearchParams,body?:Record<string,any>}} request */
async function dispatchCore({ method, path, search = new URLSearchParams(), body = {} }, actor, services) {
    requireActor(actor);
    if (!Array.isArray(path) || path.length < 1 || path.length > 3 || !['GET','POST','PUT','PATCH','DELETE'].includes(method)) throw new AutomationError('NOT_FOUND', '操作が見つかりません。', 404);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AutomationError('INVALID_BODY', 'オブジェクト形式の入力が必要です。');
    const [kind, id, action] = path;
    const { service, market, evaluator, schema, format, bundle, catalog, destinations, monitors, history, dictionaryService, moderation, starter } = services;
    let result;
    const xQuota = () => services.xQuota || require('./x-monitor-quota').createXMonitorQuota(services.db, {
      registrationEnabled: process.env.ANGELIC_X_REGISTRATION_ENABLED === '1',
      useLegacyUserInterval: process.env.ANGELIC_X_USE_LEGACY_USER_INTERVAL === '1',
    });
    if (kind === 'x-processing-settings' && !id && !action) {
      const processing = services.xProcessingSettings || require('./x-processing-settings').createXProcessingSettings(services.db, { useLegacyUserInterval: process.env.ANGELIC_X_USE_LEGACY_USER_INTERVAL === '1' });
      if (method === 'GET') result = await processing.get(actor);
      else if (method === 'PUT') result = await processing.save(actor, body);
      else throw new AutomationError('NOT_FOUND', '操作が見つかりません。', 404);
    }
    else if (kind === "catalog" && method === "GET") result = { ...catalog.catalog(), rateLimits: service.rateLimiter?.getPolicy(), deliverySafety: require('./safety').createSafety().status() };
    else if (kind === "entitlements" && !id && method === "GET") {
      const info = await require('./entitlements').getEntitlementSummary(services.db, actor.userId);
      const plan = { id: info.planId, tier: info.tier, name: info.label, priority: info.priority, slotLimit: info.slotLimit, minuteLimit: info.minuteLimit, dayLimit: info.dayLimit, baseSlotLimit: info.baseSlotLimit, manualExtraSlots: info.manualExtraSlots, addonGrantUnits: info.addonGrantUnits, addonExtraSlots: info.addonExtraSlots, donationPaymentCount: info.donationPaymentCount, addonValidUntilAtMs: info.addonValidUntilAtMs };
      const entries = await Promise.all(info.slots.map(async slot => ({ slotId: slot.slotId, slotCost: slot.slotCost, targetKind: slot.targetKind, targetId: slot.targetId, dayLimit: slot.dayLimit, minuteLimit: slot.minuteLimit, allowed: slot.allowed, ...await service.rateLimiter.getSlotUsage(slot.slotId, slot) })));
      result = { plan, slots: { used: info.usedSlots, max: info.slotLimit, available: info.remainingSlots }, usage: { entries } };
    }
    else if (kind === "donors") {
      if (actor.isAdmin !== true) throw new AutomationError('AUTOMATION_FORBIDDEN', '支援者の管理には管理者権限が必要です。', 403);
      const donors = services.donors;
      if (!donors) throw new AutomationError('DONOR_ADMIN_UNAVAILABLE', '支援者の管理機能は準備中です。', 503);
      const page = { cursor: search.get('cursor'), pageSize: search.get('pageSize') };
      if (!id && !action && method === "GET") result = await donors.list(actor, { ...page, search: search.get('search') });
      else if (id && !action && method === "GET") result = await donors.get(actor, id);
      else if (id && !action && method === "PATCH") result = await donors.save(actor, id, body);
      else if (id && action === "history" && method === "GET") result = await donors.history(actor, id, page);
      else if (id && action === "audit" && method === "GET") result = await donors.audit(actor, id, page);
    }
    else if (kind === 'push-capacity') {
      const capacity = require('./push-capacity');
      capacity.requireAdmin(actor);
      if (!id && !action && method === 'GET') result = await capacity.getPoolPolicy(services.db.queryDatabase, actor);
      else if (!id && !action && method === 'PATCH') {
        result = await services.db.withDatabaseTransaction(query => capacity.savePoolPolicy(query, actor, body));
        await xQuota().recheckAll(actor);
      }
      else if (id === 'admin' && !action && method === 'GET') result = await xQuota().adminSummary(actor,{afterUserId:search.get('afterUserId'),afterMonitorId:search.get('afterMonitorId'),afterAuditId:search.get('afterAuditId')});
      else if (id === 'history' && !action && method === 'GET') {
        const owner = search.get('userId');
        const grants = require('./push-support-grants');
        if (!/^\d{1,32}$/.test(owner || '')) throw new AutomationError('INVALID_INPUT','利用者を指定してください。');
        const history = await grants.getSupporterGrantHistory(services.db.queryDatabase, owner, { cursor: search.get('cursor') || undefined });
        const afterPaymentId=search.get('afterPaymentId');
        const match=afterPaymentId?.match(/^(\d{1,16}):([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})$/);
        if(afterPaymentId&&(!match||!Number.isSafeInteger(Number(match[1])))) throw new AutomationError('INVALID_CURSOR','決済履歴の位置を確認してください。');
        const payments = await services.db.queryDatabase(`SELECT id,state,amount,currency,refunded_amount,verified,completed_at_ms,created_at_ms FROM automation_square_donation_attempts WHERE owner_user_id=?${match?' AND (created_at_ms<? OR (created_at_ms=? AND id<?))':''} ORDER BY created_at_ms DESC,id DESC LIMIT 101`, match?[owner,match[1],match[1],match[2]]:[owner]);
        result = { grants: history.items, nextCursor: history.nextCursor || null, paymentNextCursor:payments.length>100?`${payments[99].created_at_ms}:${payments[99].id}`:null,
          payments: payments.slice(0,100).map(row=>({attemptId:row.id,state:row.state,amount:Number(row.amount),currency:row.currency,refundedAmount:Number(row.refunded_amount),verified:Number(row.verified)===1,createdAtMs:Number(row.created_at_ms),completedAtMs:row.completed_at_ms==null?null:Number(row.completed_at_ms)})) };
      }
      else if (id === 'grants' && !action && method === 'POST') {
        if (Object.keys(body).some(key=>!['userId','slots','idempotencyKey','reason','purchasedAtMs','alreadyIncludedInLegacy'].includes(key)) || typeof body.reason!=='string' || !body.reason.trim() || body.reason.length>240) throw new AutomationError('AUTOMATION_SUPPORT_GRANT_INVALID','確認した購入回数と付与の根拠を指定してください。',422);
        result = await services.db.withDatabaseTransaction(async query=>{
          const value=await require('./push-support-grants').recordHistoricalSupportGrant(query,actor,{userId:body.userId,slots:body.slots,idempotencyKey:body.idempotencyKey,purchasedAtMs:body.purchasedAtMs,alreadyIncludedInLegacy:body.alreadyIncludedInLegacy,reason:body.reason});
          await require('./entitlements').inspectPlan(query,body.userId);return value;
        });
        await xQuota().recheckAll(actor);
      }
      else if (id === 'plans' && action && method === 'GET') result = await capacity.getPlanCapacity(services.db.queryDatabase, actor, action);
      else if (id === 'plans' && action && method === 'PATCH') result = await xQuota().mutatePolicy(actor,query => capacity.savePlanCapacity(query, actor, action, body));
    }
    else if (kind === 'x-setup') {
      if (actor.guildId) throw new AutomationError('X_SETUP_PRIVATE_ONLY', '受信設定は自分専用の画面で操作してください。', 403);
      const setup = services.xSetup || require('./x-setup').createXSetup(services.db);
      if (!id && !action && method === 'GET') result = await setup.status(actor, { afterId: search.get('afterId') || undefined });
      else if (id === 'sessions' && !action && method === 'POST') result = await setup.startSession(actor, body);
      else if (id === 'validate' && !action && method === 'POST') result = await setup.validate(actor, body);
      else if (id === 'import' && !action && method === 'POST') result = await setup.importFile(actor, body);
      else if (id === 'subscriptions' && action && method === 'DELETE') result = await setup.remove(actor, action, body);
    }
    else if (kind === 'x-monitor-quota' && !id && method === 'GET') { await xQuota().reconcile(actor); result=await xQuota().summary(actor); }
    else if (kind === 'x-monitors') {
      if (!id && method === 'GET') { await xQuota().reconcile(actor); result=await xQuota().list(actor); }
      else if (!id && method === 'POST') result=await xQuota().register(actor,body);
      else if (id && !action && method === 'PATCH') result=await xQuota().update(actor,id,body);
      else if (id && !action && method === 'DELETE') result=await xQuota().release(actor,id,body);
      else if (id && action==='move' && method==='POST') result=await xQuota().move(actor,id,body);
    }
    else if (kind === "plans") {
      const plans = require('./entitlements');
      if (!id && method === "GET") result = { items: await plans.listPlanPolicies(services.db.queryDatabase, actor) };
      else if (method === "POST" || method === "PATCH") result = await xQuota().mutatePolicy(actor,query => plans.savePlanPolicy(query, actor, { planId: id || body.planId, label: body.label, slotLimit: body.slotLimit, minuteLimit: body.minuteLimit, dayLimit: body.dayLimit, priority: body.priority, enabled: body.enabled, expectedUpdatedAtMs: body.expectedUpdatedAtMs, intervalMinutes: body.intervalMinutes }));
    }
    else if (kind === "entitlements" && id && method === "POST") result = await xQuota().mutatePolicy(actor,query => require('./entitlements').setUserPlan(query, actor, id, body.planId, { expiresAtMs: body.expiresAtMs }));
    else if (kind === "billing" && ["commerce", "catalog", "coupons"].includes(id)) {
      const commerce = services.commerce;
      if (!commerce) throw new AutomationError('SQUARE_NOT_CONFIGURED', '決済機能は準備中です。', 503);
      if (id === "commerce" && action === "admin" && method === "GET") result = await commerce.getAdmin(actor);
      else if (id === "catalog" && action === "quote" && method === "POST") result = await commerce.createCatalogQuote(actor, body);
      else if (id === "catalog" && action === "create" && method === "POST") result = await commerce.confirmCatalogCreation(actor, body);
      else if (id === "catalog" && action && method === "GET") result = await commerce.getCatalogCreation(actor, action);
      else if (id === "coupons" && (method === "POST" && !action || method === "PATCH" && action)) result = await commerce.saveCoupon(actor, { ...body, code: action || body.code });
    }
    else if (kind === "billing" && id === "donations") {
      const donations = services.donations;
      if (!donations) throw new AutomationError('SQUARE_NOT_CONFIGURED', '決済機能は準備中です。', 503);
      if (action === "options" && method === "GET") result = await donations.getOptions(actor);
      else if (action === "status" && method === "GET") result = await donations.getStatus(actor);
      else if (action === "policy" && method === "GET") result = await donations.getAdmin(actor);
      else if (action === "policy" && method === "PATCH") result = await donations.savePolicy(actor, body);
      else if (action === "quote" && method === "POST") result = await donations.createQuote(actor, body);
      else if (action === "donate" && method === "POST") result = await donations.donate(actor, body);
    }
    else if (kind === "billing") {
      const billing = services.billing;
      if (!billing) throw new AutomationError('SQUARE_NOT_CONFIGURED', '決済機能は準備中です。', 503);
      if (id === "options" && method === "GET" && !action) result = await billing.getOptions(actor);
      else if (id === "status" && method === "GET" && !action) result = await billing.getStatus(actor);
      else if (id === "admin" && method === "GET" && !action) result = await billing.getAdmin(actor);
      else if (id === "bindings" && action && method === "PATCH") result = await billing.saveBinding(actor, action, body);
      else if (id === "quote" && method === "POST" && !action) result = await billing.createQuote(actor, body);
      else if (id === "subscribe" && method === "POST" && !action) result = await billing.subscribe(actor, body);
      else if (id === "resume" && method === "POST" && !action) result = await billing.resume(actor, body);
      else if (id === "abort" && method === "POST" && !action) result = await billing.abort(actor, body);
      else if (id === "cancel" && method === "POST" && !action) result = await billing.cancel(actor);
    }
    else if (kind === "providers" && method === "GET") result = await monitors.providers(actor);
    else if (kind === "channels" && method === "GET") result = await destinations.channels(actor);
    else if (kind === "starter" && method === "GET") result = starter.starterInfo();
    else if (kind === "starter" && method === "POST") result = await service.saveDictionary(actor, { dictionary: starter.starterDictionary(body.language || "all"), scope: body.scope || "private" });
    else if (kind === "moderation" && method === "GET") result = await moderation.get(actor);
    else if (kind === "moderation" && method === "POST") result = await moderation.save(actor, body);
    else if (kind === "installations" && method === "GET") result = await market.installations(actor, { kind: search.get("kind"), afterId: search.get("afterId") });
    else if (kind === "reports" && id && method === "POST") result = await market.resolveReport(actor, id, body);
    else if (kind === "jobs") {
      if (!id && method === "GET") result = await history.list(actor, { state: search.get("state"), cursor: search.get("cursor"), targetKind: search.get("targetKind") ?? undefined, targetId: search.get("targetId") ?? undefined });
      else if (id && method === "GET") result = await history.detail(actor, id);
      else if (id && method === "PATCH") result = await history.change(actor, id, body);
    }
    else if (kind === "excluded" && method === "GET") result = await history.excluded(actor, search.get("afterId") || "");
    else if (kind === "monitors" && ["auto", "price"].includes(id)) {
      if (action === "preview" && method === "POST") result = await monitors.preview(actor, id, body);
      else if (!action && method === "GET") result = await monitors.list(actor, id, search.get("afterId") || "0", { query: search.get("query") || '', state: search.get("state") || 'all' });
      else if (!action && method === "POST") result = await monitors.save(actor, id, body);
      else if (action && method === "PATCH") result = await monitors.save(actor, id, body, action);
      else if (action && method === "DELETE") result = await monitors.remove(actor, id, action, body.expectedRevision);
      else if (action && method === "POST" && body.action === "detach") result = await monitors.detach(actor, id, action, body.expectedRevision,
        Object.hasOwn(body, 'expectedWorkflowId') ? { expectedWorkflowId: validateAssignmentGuards({ expectedRevision: body.expectedRevision, expectedWorkflowId: body.expectedWorkflowId }).expectedWorkflowId } : undefined);
      else if (action && method === "POST" && body.action === "cadence") result = await monitors.setCadence(actor, id, action, body);
    }
    else if (kind === "template" && method === "GET") result = catalog.template(search.get("goal") || "all", search.get("time") || "now", search.get("format") || "normal");
    else if (kind === "validate" && method === "POST") {
      const definition = body.text !== undefined ? format.parseWorkflow(body.text, body.format) : body.definition;
      const validation = schema.validateWorkflow(definition);
      result = { ...validation, text: format.stringifyDraft(definition, body.format || "yaml"), ...(validation.valid ? { definition } : {}) };
    } else if (kind === "simulate" && method === "POST") {
      schema.assertWorkflow(body.definition);
      const refs = await service.validateBindings(actor, body.definition, body.bindings || {}, undefined, false);
      result = await evaluator.evaluate(body.definition, body.event, refs, body.now ?? Date.now());
    } else if (kind === "workflows") {
      if (!id && method === "GET") result = await service.list("workflow", actor, search.get("afterId") || "");
      else if (!id && method === "POST") result = await service.createWorkflow(actor, body);
      else if (id && !action && method === "GET") result = await service.getWorkflow(actor, id);
      else if (id && !action && method === "PATCH") result = await service.updateWorkflow(actor, id, body);
      else if (id && !action && method === "DELETE") result = await service.remove("workflow", actor, id, body.expectedRevision);
      else if (action === "activate" && method === "POST") result = await service.activateWorkflow(actor, id, body);
      else if (action === "state" && method === "POST") result = await service.setWorkflowState(actor, id, body);
      else if (action === "history" && method === "GET") result = await service.history(actor, id);
      else if (action === "restore" && method === "POST") result = await service.restoreRevision(actor, id, body.revision, body.expectedRevision);
      else if (action === "attach" && method === "POST") result = await service.attach(actor, id, body.targetKind, body.targetId,
        Object.hasOwn(body, 'expectedRevision') || Object.hasOwn(body, 'expectedWorkflowId') ? validateAssignmentGuards({ expectedRevision: body.expectedRevision, expectedWorkflowId: body.expectedWorkflowId }) : undefined);
      else if (action === "export" && method === "GET") {
        const data = await market.exportWorkflow(actor, id);
        result = search.get("format") === "zip" ? { base64: Buffer.from(bundle.encodeBundle(data)).toString("base64") } : data;
      }
    } else if (kind === "dictionary-preview" && method === "POST") result = await dictionaryService.preview(body);
    else if (kind === "dictionaries") {
      if (!id && method === "GET") result = await service.list("dictionary", actor, search.get("afterId") || "");
      else if (!id && method === "POST") result = await dictionaryService.save(actor, body);
      else if (id && !action && method === "PATCH") result = await dictionaryService.save(actor, body, id);
      else if (id && !action && method === "GET") result = await dictionaryService.page(actor, id, { revision: search.get("revision"), offset: search.get("offset"), search: search.get("search") });
      else if (id && !action && method === "DELETE") result = await service.remove("dictionary", actor, id, body.expectedRevision);
      else if (action === "patch" && method === "POST") result = await dictionaryService.patch(actor, id, body);
      else if (action === "versions" && method === "GET") result = await dictionaryService.versions(actor, id, Number(search.get("before")) || undefined);
      else if (action === "diff" && method === "POST") result = await dictionaryService.diff(actor, id, body.from, body.to);
      else if (action === "restore" && method === "POST") result = await dictionaryService.restore(actor, id, body);
      else if (action === "export" && method === "GET") result = await dictionaryService.exportData(actor, id, Number(search.get("revision")) || undefined, search.get("format") || "json");
      else if (action === "test" && method === "POST") {
        const row = await service.getRow("dictionary", actor, id);
        result = await evaluator.match({ id, revision: Number(body.revision || row.revision) }, body.text);
      }
    } else if (kind === "destinations" && method === "GET" && !id) result = await service.list("destination", actor, search.get("afterId") || '');
    else if (kind === "destinations" && method === "GET" && id && !action) result = publicDestination(await service.getRow("destination", actor, id));
    else if (kind === "destinations" && method === "POST" && !id) result = await destinations.save(actor, body);
    else if (kind === "destinations" && method === "PATCH" && id) result = await destinations.save(actor, body, id);
    else if (kind === "destinations" && method === "DELETE" && id) result = await service.remove("destination", actor, id, body.expectedRevision);
    else if (kind === "marketplace") {
      if (!id && method === "GET") result = await market.list(actor, { search: search.get("search"), mine: search.get("mine") === "1", favorites: search.get("favorites") === "1", following: search.get("following") === "1", afterId: search.get("afterId") });
      else if (!id && method === "POST") result = await market.save(actor, body);
      else if (id && !action && method === "GET") result = await market.get(actor, id, Number(search.get("version")) || undefined, search.get("shareKey"));
      else if (id && !action && method === "PATCH") result = await market.save(actor, body, id);
      else if (action === "install" && method === "POST") result = await market.install(actor, id, body);
      else if (action === "status" && method === "POST") result = await market.setStatus(actor, id, body);
      else if (action === "feedback" && method === "POST") result = await market.feedback(actor, id, body);
      else if (action === "versions" && method === "GET") result = await market.versions(actor, id, { shareKey: search.get("shareKey"), before: search.get("before") });
      else if (action === "versions" && method === "POST") result = await market.versions(actor, id, body);
      else if (action === "open" && method === "POST") result = await market.get(actor, id, body.version, body.shareKey);
      else if (action === "fork" && method === "POST") result = await market.fork(actor, id, body);
      else if (action === "update-preview" && method === "POST") result = await market.previewUpdate(actor, id, body);
      else if (action === "update" && method === "POST") result = await market.updateInstall(actor, id, body);
    } else if (kind === "review" && method === "GET") result = await market.reviewQueue(actor);
    else if (kind === "import" && method === "POST") {
      const data = body.base64 ? bundle.decodeBundle(Buffer.from(body.base64, "base64")) : bundle.validateBundle(body.bundle);
      result = body.preview ? data : await market.importBundle(actor, data, body);
    }
    if (result === undefined) throw new AutomationError("NOT_FOUND", "この操作は見つかりません。", 404);
    return result;
}
module.exports = { dispatch };
