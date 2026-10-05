'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createTestDatabase } = require('./automation-test-db');
const load = require('../test/helpers/load-dashboard.cjs');
const root = path.resolve(__dirname, '../..');
async function createFixture(port) {
    const db = await createTestDatabase(port);
    try {
        const schema = require('../../src/db_schema');
        for (const sql of schema.SCHEMA_STATEMENTS.filter(sql => /^CREATE TABLE IF NOT EXISTS (providers|guilds|guild_provider_\w+|bot_shared_posts|bot_media_galleries|bot_personal_link_users|bot_link_cards|bot_saved_links|bot_link_notifications|bot_restock_sources)\s*\(/.test(sql))) await db.queryDatabase(sql);
        for (const file of ['20260701_add_dashboard_audit_logs.sql', '20260715_add_provider_settings_cache_invalidations.sql']) {
            for (const sql of schema._internal.splitSqlStatements(fs.readFileSync(path.join(root, 'migrations', file), 'utf8'))) await db.queryDatabase(sql);
        }
        const store = require('../../src/personalLinks/store').createStore(db);
        const model = require('../../src/personalLinks/model');
        const services = { store, model, stockOptions: async url => ({ item: model.boothItem(url), options: [
            { id: '7', name: '赤 / Red', state: 'sold_out' }, { id: '8', name: '青 / Blue', state: 'sold_out' },
        ] }) };
        const unsafe = (sql, ...params) => db.queryDatabase(sql, params);
        const tagged = (strings, ...values) => db.queryDatabase(strings.join('?'), values);
        const prisma = { $executeRawUnsafe: unsafe, $queryRawUnsafe: unsafe, $executeRaw: tagged, $queryRaw: tagged,
            $transaction: work => db.withDatabaseTransaction(() => work(prisma)) };
        const mocks = { '@/lib/prisma': { prisma }, '@/lib/bot-require': { requireBotModule: file => require(path.join(root, file)) } };
        const settings = load('lib/settings-db.ts', mocks);
        const api = load('lib/personal-links-server.ts', mocks);
        const { compileSettings, SETTINGS_PATH } = require('../benchmark_main_settings');
        const botSettings = compileSettings(fs.readFileSync(SETTINGS_PATH, 'utf8'), db.queryDatabase);
        return { db, store, services, settings, api, botSettings, close: db.close };
    } catch (error) { await db.close(); throw error; }
}
module.exports = { createFixture };
