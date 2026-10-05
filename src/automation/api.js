'use strict';

// The web boundary derives actor from the authenticated session. This dispatcher
// is also used by loopback-only fixture tests; it contains no auth bypass.
const { requireActor, AutomationError } = require('./service');
/** @param {{method:string,path:string[],search?:URLSearchParams,body?:Record<string,any>}} request */
async function dispatch({ method, path, search = new URLSearchParams(), body = {} }, actor, services) {
    requireActor(actor);
    if (!Array.isArray(path) || path.length < 1 || path.length > 3 || !['GET','POST','PATCH','DELETE'].includes(method)) throw new AutomationError('NOT_FOUND', '操作が見つかりません。', 404);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AutomationError('INVALID_BODY', 'オブジェクト形式の入力が必要です。');
    const [kind, id, action] = path;
    const { service, market, evaluator, schema, format, bundle, catalog, destinations, monitors, history, dictionaryService, moderation, starter } = services;
    let result;
    if (kind === "catalog" && method === "GET") result = { ...catalog.catalog(), deliverySafety: require('./safety').createSafety().status() };
    else if (kind === "providers" && method === "GET") result = monitors.providers();
    else if (kind === "channels" && method === "GET") result = await destinations.channels(actor);
    else if (kind === "starter" && method === "GET") result = starter.starterInfo();
    else if (kind === "starter" && method === "POST") result = await service.saveDictionary(actor, { dictionary: starter.starterDictionary(body.language || "all"), scope: body.scope || "private" });
    else if (kind === "moderation" && method === "GET") result = await moderation.get(actor);
    else if (kind === "moderation" && method === "POST") result = await moderation.save(actor, body);
    else if (kind === "installations" && method === "GET") result = await market.installations(actor, { kind: search.get("kind"), afterId: search.get("afterId") });
    else if (kind === "reports" && id && method === "POST") result = await market.resolveReport(actor, id, body);
    else if (kind === "jobs") {
      if (!id && method === "GET") result = await history.list(actor, { state: search.get("state"), cursor: search.get("cursor") });
      else if (id && method === "GET") result = await history.detail(actor, id);
      else if (id && method === "PATCH") result = await history.change(actor, id, body);
    }
    else if (kind === "excluded" && method === "GET") result = await history.excluded(actor, search.get("afterId") || "");
    else if (kind === "monitors" && ["auto", "price"].includes(id)) {
      if (!action && method === "GET") result = await monitors.list(actor, id, search.get("afterId") || "0");
      else if (!action && method === "POST") result = await monitors.save(actor, id, body);
      else if (action && method === "PATCH") result = await monitors.save(actor, id, body, action);
      else if (action && method === "DELETE") result = await monitors.remove(actor, id, action, body.expectedRevision);
      else if (action && method === "POST" && body.action === "detach") result = await monitors.detach(actor, id, action, body.expectedRevision);
    }
    else if (kind === "template" && method === "GET") result = catalog.template(search.get("goal") || "all", search.get("time") || "now", search.get("format") || "expanded");
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
      else if (action === "attach" && method === "POST") result = await service.attach(actor, id, body.targetKind, body.targetId);
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
    } else if (kind === "destinations" && method === "GET" && !id) result = await service.list("destination", actor);
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
