'use strict';
// The ordinary migration runner executes the same SQL file after the additive
// tables have been created. This narrow entry point supports controlled rollout
// and repeatable verification without touching unrelated provider migrations.
async function ensurePlanIntervalColumn(query) {
    const existing=await query('SHOW COLUMNS FROM automation_notification_plans LIKE ?', ['confirmation_interval_minutes']);
    if (existing.length) return { added:false };
    try { await query('ALTER TABLE automation_notification_plans ADD COLUMN confirmation_interval_minutes INT UNSIGNED NULL'); }
    catch(error) { if(error.code!=='ER_DUP_FIELDNAME') throw error; }
    return { added:true };
}
module.exports={ensurePlanIntervalColumn};
