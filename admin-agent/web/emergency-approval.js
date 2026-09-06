'use strict';
/* global api, runAction, text, raw, time */
(() => {
  const recovery = document.getElementById('recovery');
  if (!recovery) return;
  const panel = document.createElement('article'); panel.className = 'panel';
  const load = text('button', '緊急起動の対象候補を確認'); load.type = 'button';
  const target = document.createElement('div'); const status = text('p', '先に現在の復旧候補と運転指示を取得してください。'); status.setAttribute('role', 'status');
  const form = document.createElement('form');
  const reasonLabel = text('label', '通常の本体指示を一度だけ免除する理由'); const reason = document.createElement('textarea'); reason.rows = 3; reason.maxLength = 1000; reasonLabel.append(reason);
  const confirmations = {};
  for (const [key, label] of [['acceptBackupRollback', '表示されたバックアップ以後の変更が失われる可能性を確認した'], ['acceptMissingSavedata', 'savedataのファイルは移行されないことを確認した'], ['acceptPrimaryIntentOverride', '本体の停止・保守指示を変更せず、この候補について運転指示条件だけを一回限り免除することを確認した']]) {
    const element = document.createElement('input'); element.type = 'checkbox'; element.dataset.confirmation = key; confirmations[key] = element;
    const wrapper = text('label', ''); wrapper.append(element, text('span', label)); form.append(wrapper);
  }
  const approve = text('button', '確認した候補の緊急起動を一度承認'); approve.disabled = true;
  form.prepend(reasonLabel); form.append(approve);
  const result = document.createElement('div'); result.id = 'emergency-approval-result';
  panel.append(text('h2', '本体が戻らない場合の候補限定・緊急起動承認'), text('p', '有効期間は10分、対象は確認した世代・候補・バックアップだけです。本体の運転指示を書き換えません。自動切り替えの有効化、旧leaseの失効と停止待機、登録証明、バックアップ鮮度、OCI側の運転指示など、他の条件はすべて必要です。'), load, target, status, form, result);
  recovery.append(panel);
  let snapshot = null; let busy = false;
  function enabled() { approve.disabled = busy || !snapshot || reason.value.trim().length < 5 || Object.values(confirmations).some(element => !element.checked); }
  reason.addEventListener('input', enabled); Object.values(confirmations).forEach(element => element.addEventListener('change', enabled));
  load.addEventListener('click', async () => {
    snapshot = null; enabled(); load.disabled = true; target.replaceChildren();
    try {
      const value = await api('v1/recovery');
      if (value.available !== true || value.manualApprovalAvailable !== true) throw new Error('この操作は更新済みのOCI独立管理画面から行ってください。');
      if (value.activeNode !== 'primary' || value.candidate?.phase !== 'VALIDATED' || !value.backup?.sourceSha256) throw new Error('現在、承認できる検証済み待機候補を確認できません。');
      const old = value.manualEmergencyApproval;
      if (old && ['approved', 'reserved'].includes(old.state) && Number(old.expiresAt) * 1000 > Date.now()) throw new Error(`有効な承認 ${old.approvalId} が既にあります。有効期限 ${time(Number(old.expiresAt) * 1000)} を確認してください。`);
      snapshot = value;
      const fields = [['復旧世代', value.epoch], ['候補ID', value.candidate.id], ['バックアップID', value.backup.backupId], ['バックアップ時刻', time(value.backup.sourceTimestamp)], ['バックアップSHA-256', value.backup.sourceSha256], ['最後に記録された本体指示', `${value.primaryIntent?.desiredState || 'unknown'} / revision ${value.primaryIntent?.revision ?? '未取得'}`], ['OCI指示', `${value.ociIntent?.desiredState || 'unknown'} / revision ${value.ociIntent?.revision ?? '未取得'}`]];
      const list = document.createElement('dl'); for (const [label, value] of fields) list.append(text('dt', label), text('dd', String(value))); target.append(list);
      status.className = ''; status.textContent = 'この対象と3項目の影響を確認し、理由を入力してください。取得後に対象や指示が変わると承認は拒否されます。';
    } catch (error) { status.className = 'error'; status.textContent = error.message; }
    finally { load.disabled = false; enabled(); }
  });
  form.addEventListener('submit', async event => {
    event.preventDefault(); enabled(); if (approve.disabled || !snapshot) return;
    const value = snapshot;
    const input = { expectedEpoch: value.epoch, candidateId: value.candidate.id, backupId: value.backup.backupId, backupSha256: value.backup.sourceSha256, sourceTimestamp: value.backup.sourceTimestamp,
      expectedPrimaryIntentRevision: value.primaryIntent?.revision ?? null, expectedPrimaryIntentState: value.primaryIntent?.desiredState || 'unknown', expectedOciPolicyRevision: value.ociIntent?.revision,
      reason: reason.value.trim(), ...Object.fromEntries(Object.entries(confirmations).map(([key, element]) => [key, element.checked])) };
    busy = true; enabled(); load.disabled = true;
    try {
      const action = await runAction('recovery.emergency.approve', input, result.id);
      status.className = action.status === 'succeeded' ? '' : 'error';
      status.textContent = action.status === 'succeeded' ? '承認を記録しました。起動を保証する応答ではありません。上の切り替え条件・承認履歴・稼働状態で結果を確認してください。' : '承認の有効性を確認できません。操作結果と保存済み承認IDを確認してください。';
      if (action.result) raw(result, action.result, true, '承認の対象・期限・一回限りの適用範囲');
    } catch (error) { status.className = 'error'; status.textContent = error.message; }
    finally { snapshot = null; busy = false; load.disabled = false; enabled(); }
  });
})();
