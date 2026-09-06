'use strict';
/* global api, text, raw, show, time */
(() => {
  const app = document.getElementById('app');
  const navigation = text('button', '緊急復旧'); navigation.dataset.view = 'recovery';
  const panel = document.createElement('section'); panel.id = 'recovery'; panel.className = 'view'; panel.hidden = true;
  const heading = document.createElement('div'); heading.className = 'heading';
  const refreshButton = text('button', '状態を更新');
  heading.append(text('h1', 'NASバックアップからの緊急復旧'), refreshButton);
  const status = text('p', '復旧状態はまだ取得していません。'); status.setAttribute('role', 'status');
  const content = document.createElement('div');
  panel.append(heading, text('p', 'バックアップの準備状況、二重稼働を防ぐ起動許可、OCIへの切り替え条件を確認します。savedataのファイルは移行対象外です。'), status, content);
  document.getElementById('nav').append(navigation); app.append(panel);
  let pending = false; let snapshot = null;
  const phases = {
    UNCONFIGURED: '未設定', INITIALIZING: '初期化中', DOWNLOADING: 'バックアップ取得中',
    RESTORING_ISOLATED: '隔離したDBへ復元中', VALIDATING: '復元結果を検証中',
    STANDBY_READY: 'OCIの復旧候補を準備済み', PREPARATION_FAILED: '復旧の準備に失敗',
    PREPARATION_INTERRUPTED: '準備が中断されたため候補を隔離', RECOVERY_ACTION_FAILED: '緊急稼働の処理に失敗',
    ACTIVE: 'OCIで緊急稼働中', PROMOTING: 'OCIへ切り替え中'
  };
  function display(value) { return value == null || value === '' ? '未取得' : typeof value === 'object' ? JSON.stringify(value) : String(value); }
  function rows(title, values) {
    const article = document.createElement('article'); article.className = 'panel'; article.append(text('h2', title));
    const list = document.createElement('dl');
    for (const [label, value] of values) list.append(text('dt', label), text('dd', display(value)));
    article.append(list); return article;
  }
  function render(value) {
    content.replaceChildren();
    content.append(rows('現在の状態', [
      ['進行段階', `${phases[value.phase] || value.phase} (${value.phase})`],
      ['稼働ノード', value.activeNode], ['復旧世代', value.epoch],
      ['本体への起動許可の導入', value.primaryEnrolled === true ? '登録済み' : value.primaryEnrolled === false ? '未登録' : '未取得'],
      ['コントローラー最終更新', time(value.updatedAt)], ['画面の取得時刻', time(value.fetchedAt)]
    ]));
    const backup = value.backup || {};
    const age = Date.parse(backup.sourceTimestamp); const elapsed = Math.floor((Date.now() - age) / 60000);
    content.append(rows('バックアップ', [
      ['バックアップID', backup.backupId], ['取得元の時刻', time(backup.sourceTimestamp)],
      ['取得元からの経過', Number.isFinite(elapsed) ? elapsed < 0 ? '取得元の時刻が未来です' : `${Math.floor(elapsed / 60)}時間 ${elapsed % 60}分` : '未取得'],
      ['SHA-256', backup.sourceSha256], ['取得元のサイズ', backup.sourceBytes == null ? null : `${backup.sourceBytes} bytes`]
    ]));
    const candidate = value.candidate || {};
    const candidatePanel = rows('復旧候補', [['候補ID', candidate.id], ['DB状態', candidate.databaseState], ['検証段階', candidate.phase]]);
    raw(candidatePanel, candidate.checks || {}, false, '復元・検証の詳細'); content.append(candidatePanel);
    if (value.download || value.import) { const progress = rows('処理の進行', []); raw(progress, { download: value.download, import: value.import }, true, '取得・復元の進行'); content.append(progress); }
    const gates = document.createElement('article'); gates.className = 'panel'; gates.append(text('h2', '切り替えの条件'));
    for (const gate of Array.isArray(value.gates) ? value.gates : []) {
      gates.append(text('p', `${gate.ready === true ? '確認済み' : gate.ready === false ? '未充足' : '未確認'} · ${display(gate.code)} · ${display(gate.message)}`, gate.ready === false ? 'error' : ''));
    }
    if (!value.gates?.length) gates.append(text('p', '切り替え条件はまだ確認できていません。'));
    content.append(gates);
    if (value.lastError) { const failure = rows('最後に記録されたエラー', []); failure.setAttribute('role', 'alert'); raw(failure, value.lastError, true, '原因・詳細'); content.append(failure); }
    raw(content, value, false, 'コントローラー応答の全詳細');
  }
  async function refresh() {
    if (pending || app.hidden) return;
    pending = true; refreshButton.disabled = true; status.textContent = '復旧状態を取得しています。';
    try {
      const value = await api('v1/recovery');
      if (value.available !== true) throw new Error(value.message || '復旧状態は取得できません。');
      snapshot = value; render(value); status.className = ''; status.textContent = 'コントローラーの応答を確認しました。30秒ごとに更新します。';
    } catch (error) {
      status.className = 'error';
      status.textContent = `${error.message}${snapshot ? ` 以下は ${time(snapshot.fetchedAt)} に取得した最後の応答です。現在の状態ではありません。` : ' 復旧準備済みとは判断できません。他の管理機能は引き続き利用できます。'}`;
    } finally { pending = false; refreshButton.disabled = false; }
  }
  navigation.addEventListener('click', () => { show('recovery'); void refresh(); });
  refreshButton.addEventListener('click', () => void refresh());
  const observe = new MutationObserver(() => { if (!app.hidden && !panel.hidden) void refresh(); });
  observe.observe(app, { attributes: true, attributeFilter: ['hidden'] });
  observe.observe(panel, { attributes: true, attributeFilter: ['hidden'] });
  setInterval(() => { if (!document.hidden && !app.hidden && !panel.hidden) void refresh(); }, 30000);
})();
