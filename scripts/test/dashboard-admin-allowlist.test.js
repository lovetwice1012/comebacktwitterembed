'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = require('./helpers/load-dashboard.cjs');
const owner = '796972193287503913';
const additionalAdmin = '933314562487386122';
const outsider = '123456789012345678';

test('both explicitly authorized Discord users are admins while an outsider and missing identity are rejected', () => {
  const before = process.env.DASHBOARD_ADMIN_USER_IDS;
  delete process.env.DASHBOARD_ADMIN_USER_IDS;
  try {
    const admin = load('lib/admin.ts', { '@/lib/env': { readRootConfig: () => ({}) } });
    assert.equal(admin.isDashboardAdminUserId(owner), true);
    assert.equal(admin.isDashboardAdminUserId(additionalAdmin), true);
    assert.equal(admin.isDashboardAdminUserId(outsider), false);
    assert.equal(admin.isDashboardAdminUserId(null), false);
    assert.equal(admin.isDashboardAdminSession({ user: { id: outsider, isAdmin: true } }), false);
    assert.equal(admin.isDashboardAdminSession({ user: { id: additionalAdmin } }), true);
  } finally { if (before === undefined) delete process.env.DASHBOARD_ADMIN_USER_IDS; else process.env.DASHBOARD_ADMIN_USER_IDS = before; }
});

test('environment and configuration additions cannot accidentally replace or duplicate the two default admins', () => {
  const before = process.env.DASHBOARD_ADMIN_USER_IDS;
  process.env.DASHBOARD_ADMIN_USER_IDS = `${additionalAdmin}, ${outsider}, invalid, *`;
  try {
    const admin = load('lib/admin.ts', { '@/lib/env': { readRootConfig: () => ({ dashboard: { adminUserIds: [owner, additionalAdmin] } }) } });
    const ids = admin.getDashboardAdminUserIds();
    assert.equal(ids.includes(owner), true);
    assert.equal(ids.includes(additionalAdmin), true);
    assert.equal(ids.includes(outsider), true);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(ids.includes('*'), false);
    assert.equal(admin.isDashboardAdminUserId('999999999999999999'), false);
  } finally { if (before === undefined) delete process.env.DASHBOARD_ADMIN_USER_IDS; else process.env.DASHBOARD_ADMIN_USER_IDS = before; }
});
