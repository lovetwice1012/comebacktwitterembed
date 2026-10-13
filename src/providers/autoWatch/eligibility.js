'use strict';

const { AutomationError } = require('../../automation/service');
const { TABLES } = require('../../db_schema');

async function registrationStatus(query, userId, lock = false) {
    if (!/^\d{1,32}$/.test(String(userId || ''))) {
        throw new AutomationError('AUTO_WATCH_INVALID_USER', '利用者を確認できません。', 400);
    }
    await query(`SELECT is_donor FROM ${TABLES.users} WHERE user_id=?${lock ? ' FOR UPDATE' : ''}`, [String(userId)]);
    // Free registrations are now supported. Actual capacity and verified
    // supporter/paid priority belong to server-managed notification slots.
    return { donorOnly: false, eligible: true };
}

async function assertRegistrationAllowed(query, userId, lock = false) {
    return registrationStatus(query, userId, lock);
}

module.exports = { registrationStatus, assertRegistrationAllowed };
