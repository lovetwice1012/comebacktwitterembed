'use strict';

const { AutomationError } = require('../../automation/service');
const { TABLES } = require('../../db_schema');

async function registrationStatus(query, userId, lock = false) {
    if (!/^\d{1,32}$/.test(String(userId || ''))) {
        throw new AutomationError('AUTO_WATCH_INVALID_USER', '利用者を確認できません。', 400);
    }
    const rows = await query(`SELECT is_donor FROM ${TABLES.users} WHERE user_id=?${lock ? ' FOR UPDATE' : ''}`, [String(userId)]);
    return { donorOnly: true, eligible: Number(rows[0]?.is_donor) === 1 };
}

async function assertRegistrationAllowed(query, userId, lock = false) {
    const status = await registrationStatus(query, userId, lock);
    if (!status.eligible) {
        throw new AutomationError('AUTO_WATCH_DONOR_REQUIRED', '新着自動展開の登録・再開・対象や通知先の変更は、寄付者のみ利用できます。', 403);
    }
    return status;
}

module.exports = { registrationStatus, assertRegistrationAllowed };
