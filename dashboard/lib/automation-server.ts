import "server-only";
import { requireBotModule } from "@/lib/bot-require";

// Runtime modules are shared with the Bot; no independent Web evaluator or
// translated policy implementation can drift from the background worker.
const globals = globalThis as unknown as { automationServices?: any };
export function automationServices() {
  if (globals.automationServices) return globals.automationServices;
  const db = requireBotModule<any>("src/db.js");
  const service = requireBotModule<any>("src/automation/service.js").createService(db);
  const destinations = requireBotModule<any>("src/automation/destinations.js").createDestinations(db, service);
  const monitors = requireBotModule<any>("src/automation/monitors.js").createMonitors(db, service, destinations);
  const history = requireBotModule<any>("src/automation/history.js").createHistory(db, service);
  const evaluator = requireBotModule<any>("src/automation/evaluation.js").createEvaluator(service.dictionaryData);
  const starter = requireBotModule<any>("src/automation/moderation.js");
  const moderation = starter.createModeration(db, service, evaluator);
  const market = requireBotModule<any>("src/automation/marketplace.js").createMarketplace(db, { service, evaluator, moderationMatcher: moderation });
  const dictionaryService = requireBotModule<any>("src/automation/dictionary-service.js").createDictionaryService(db, service, evaluator);
  globals.automationServices = {
    db, service, market, evaluator, destinations, monitors, history, dictionaryService, moderation, starter,
    api: requireBotModule<any>("src/automation/api.js"),
    schema: requireBotModule<any>("src/automation/schema.js"),
    format: requireBotModule<any>("src/automation/format.js"),
    bundle: requireBotModule<any>("src/automation/bundle.js"),
    catalog: requireBotModule<any>("src/automation/catalog.js"),
  };
  return globals.automationServices;
}
