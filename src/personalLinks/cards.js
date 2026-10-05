'use strict';
const model = require('./model');
const { getStore } = require('./store');
const ui = require('./ui');
const { isResponseButtonHidden } = require('../utils');
async function prepare(step, message, context, store = getStore()) {
    if (!context.personalActions || step.outputRole === 'failure_notice' || !(message.guildId || message.guild?.id)
        || !step.embeds?.length && !step.files?.length) return { step };
    const settings = context.presentationSettings || {};
    if (settings.button_invisible?.all || settings.button_invisible?.personal) return { step };
    let entry;
    try { entry = model.link(step.analytics?.content?.contentUrl || context.url, step.analytics?.content?.title || step.embeds?.[0]?.title); }
    catch { return { step }; }
    const card = { id: model.id(), entry, restockOptions: context.providerId === 'booth' ? step.restockOptions || [] : [],
        providerId: context.providerId };
    const locale = settings.defaultLanguage;
    const candidates = [ui.button(ui.text(locale, 'あとで見る', 'Save for later'), `personal:save:${card.id}`),
        ui.button(ui.text(locale, 'あとで通知', 'Remind me'), `personal:remind:${card.id}`)];
    if (card.restockOptions.length) candidates.push(ui.button(ui.text(locale, '再入荷を待つ', 'Watch restock'), `personal:restock:${card.id}`));
    const actions = candidates.filter(button => !isResponseButtonHidden(settings.button_invisible, button.custom_id));
    if (!actions.length) return { step };
    const rows = JSON.parse(JSON.stringify(step.components || []));
    const last = rows.at(-1);
    const reuse = last?.type === 1 && last.components.every(c => c.type === 2) && last.components.length + actions.length <= 5;
    if (!reuse && rows.length >= 5) return { step };
    try {
        await store.saveCard(card, message);
        if (reuse) last.components.push(...actions);
        else rows.push(ui.row(...actions));
        return { step: { ...step, components: rows }, cardId: card.id };
    } catch (error) {
        report(error);
        return { step };
    }
}
function report(error) { require('../errorTracking').recordError(error, { source: 'personalLinks.cards', fallbackType: 'personal_link_card_failed' }); }
module.exports = { prepare, report };
