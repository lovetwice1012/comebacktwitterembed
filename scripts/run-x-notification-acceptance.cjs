'use strict';
// Explicitly scoped regression matrix; disposable SQL port required.
const {spawnSync}=require('node:child_process');
const {resolveProjectNode}=require('./run-project-node.cjs');
const path=require('node:path');
const files=[
  "scripts/test/windows-node-bootstrap.test.js",
  "scripts/test/project-node-runtime.test.js",
  "scripts/test/runtime.test.js",
  "scripts/test/angelic-setup-export-consent.test.js",
  "scripts/test/angelic-setup-package.test.js",
  "scripts/test/autoextract.additionalautoextractslot.test.js",
  "scripts/test/automation-core.test.js",
  "scripts/test/automation-delivery-gate.test.js",
  "scripts/test/automation-donation-ui.test.js",
  "scripts/test/automation-entitlements-sql.test.js",
  "scripts/test/automation-graph-driver-sql.test.js",
  "scripts/test/automation-http-boundary.test.js",
  "scripts/test/automation-monitor-cadence-lifecycle-sql.test.js",
  "scripts/test/automation-monitor-cadence-sql.test.js",
  "scripts/test/automation-monitor-cadence-ui.test.js",
  "scripts/test/automation-notification-quota-ui.test.js",
  "scripts/test/automation-payment-navigation.test.js",
  "scripts/test/automation-plan-admin-sql.test.js",
  "scripts/test/automation-plan-admin-ui.test.js",
  "scripts/test/automation-push-capacity-sql.test.js",
  "scripts/test/automation-push-capacity-ui.test.js",
  "scripts/test/automation-push-support-grants-sql.test.js",
  "scripts/test/automation-runtime.test.js",
  "scripts/test/automation-square-billing-sql.test.js",
  "scripts/test/automation-square-commerce-ui.test.js",
  "scripts/test/automation-square-donations-sql.test.js",
  "scripts/test/automation-x-binding-sql.test.js",
  "scripts/test/automation-x-delivery-sql.test.js",
  "scripts/test/automation-x-delivery.test.js",
  "scripts/test/automation-x-monitor-ui.test.js",
  "scripts/test/automation-x-push-gateway.test.js",
  "scripts/test/automation-x-push-processing-sql.test.js",
  "scripts/test/automation-x-push-runtime-retry.test.js",
  "scripts/test/automation-x-push-runtime.test.js",
  "scripts/test/automation-x-push-store.test.js",
  "scripts/test/automation-x-quota-migration.test.js",
  "scripts/test/automation-x-quota-sql.test.js",
  "scripts/test/automation-x-rollout-policy.test.js",
  "scripts/test/automation-x-setup-download.test.js",
  "scripts/test/automation-x-setup-sql.test.js",
  "scripts/test/automation-x-setup-transfer.test.js",
  "scripts/test/automation-x-setup-ui.test.js",
  "scripts/test/automation-x-worker-config.test.js",
  "scripts/test/automation-x-webpush-adapter.test.js",
  "scripts/test/automation-x-integration-contracts.test.js",
  "scripts/test/automation-donor-admin-sql.test.js",
  "scripts/test/automation-donor-admin-boundary.test.js",
  "scripts/test/automation-donor-admin-ui.test.js",
  "scripts/test/automation-square-payment-interval-migration-sql.test.js",
  "scripts/test/automation-subscription-ui.test.js",
  "scripts/test/automation-aggregate-rendering.test.js",
  "scripts/test/automation-outbound-guard.test.js",
  "scripts/test/automation-text-transform.test.js",
  "scripts/test/automation-boundaries.test.js",
  "scripts/test/automation-graph-join.test.js",
  "scripts/test/automation-normal-handoff.test.js",
  "scripts/test/automation-studio-ui.test.js",
  "scripts/test/x-notification-reader.test.js"
];
const port=Number(process.env.AUTOMATION_TEST_DB_PORT);
if(!Number.isInteger(port)||port<1024||port>65535||port===3306)throw new Error('Set an explicit disposable AUTOMATION_TEST_DB_PORT');
const root=path.resolve(__dirname,'..');
const result=spawnSync(resolveProjectNode(),['--test','--test-concurrency=1','--test-reporter=junit','--test-reporter-destination=docs/angelic-angel/mixed-notification-acceptance-tests.xml',...files],{cwd:root,env:process.env,stdio:'inherit',windowsHide:true});
if(result.error)throw result.error;
process.exitCode=result.status===null?1:result.status;
