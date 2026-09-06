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
  const logsPanel = document.createElement('article'); logsPanel.className = 'panel';
  const logControls = document.createElement('div'); logControls.className = 'toolbar';
  const component = document.createElement('select'); component.setAttribute('aria-label', 'ログの処理');
  for (const [name, label] of [['bot', 'Bot・起動処理'], ['interactive', '分析・サポートworker'], ['reports', 'レポートworker']]) { const option = text('option', label); option.value = name; component.append(option); }
  const archive = document.createElement('select'); archive.setAttribute('aria-label', 'ログ世代'); const currentLog = text('option', '現在のログ'); currentLog.value = '0'; archive.append(currentLog);
  const lines = document.createElement('select'); lines.setAttribute('aria-label', '表示する末尾行数');
  for (const count of [100, 200, 500, 1000]) { const option = text('option', `末尾 ${count} 行`); option.value = String(count); option.selected = count === 200; lines.append(option); }
  const logRefresh = text('button', 'ログを更新'); logControls.append(component, archive, lines, logRefresh);
  const logStatus = text('p', 'OCIの起動後に、選択した処理の保存済みログを確認できます。'); logStatus.setAttribute('role', 'status');
  const logDetails = document.createElement('div'); const logTail = document.createElement('pre'); logTail.setAttribute('aria-label', '保存済みログの末尾');
  logsPanel.append(text('h2', '起動・取得処理の実ログ'), text('p', '選択されたOCI候補の実行ログを読み取ります。最大256KiB・1000行の末尾表示です。起動に失敗した場合も、記録された原因を確認できます。'), logControls, logStatus, logDetails, logTail);
  panel.append(heading, text('p', 'バックアップの準備状況、二重稼働を防ぐ起動許可、OCIへの切り替え条件を確認します。savedataのファイルは移行対象外です。'), status, content, logsPanel);
  document.getElementById('nav').append(navigation); app.append(panel);
  let pending = false; let snapshot = null;
  let logPending = false; let lastLogAt = null;
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
  async function refreshLogs() {
    if (logPending || app.hidden || panel.hidden) return;
    logPending = true; logRefresh.disabled = true; logStatus.textContent = '保存済みログを取得しています。';
    const selected = component.value; const selectedArchive = archive.value; const selectedLines = lines.value;
    try {
      const query = new URLSearchParams({ component: selected, archive: selectedArchive, bytes: '262144', lines: selectedLines });
      const value = await api(`v1/recovery/workload-logs?${query}`);
      if (component.value !== selected || archive.value !== selectedArchive || lines.value !== selectedLines) return;
      lastLogAt = value.fetchedAt; logDetails.replaceChildren(); logTail.textContent = value.text || '';
      const choices = new Set([0, ...(value.files || []).filter(item => item.available === true).map(item => item.archive)]);
      archive.replaceChildren(); for (const index of [...choices].sort((a, b) => a - b)) { const option = text('option', index === 0 ? '現在のログ' : `保存済みログ ${index}世代前`); option.value = String(index); archive.append(option); } archive.value = choices.has(Number(selectedArchive)) ? selectedArchive : '0';
      if (value.available !== true) {
        const absent = { not_started: 'OCI稼働グループはまだ起動していません。', runtime_absent: 'この候補の実行ディレクトリはまだ作成されていません。', logs_absent: 'ログディレクトリはまだ作成されていません。', log_absent: '選択したログは未生成、または保持されていません。', activation_metadata_absent: '起動記録が未生成のため、ログの対応を確認できません。', not_configured: 'ログ取得先が未設定です。' };
        logStatus.className = ''; logStatus.textContent = absent[value.state] || value.message || 'このログは現在取得できません。';
        if (value.logHealth) { const h = value.logHealth; raw(logDetails, h, true, 'ログファイル不在時の保存・欠落の記録'); if (h.writeError || h.readError || Number(h.droppedBytes) > 0 || Number(h.trimmedBytes) > 0) { logStatus.className = 'error'; logStatus.textContent += ' 保存エラー・欠落の記録があります。処理が出力しなかったとは判断できません。'; } }
        return;
      }
      const health = value.logHealth || {};
      const loss = Number(health.droppedBytes) > 0 || Number(health.trimmedBytes) > 0 || health.writeError || health.readError;
      logStatus.className = loss ? 'error' : '';
      logStatus.textContent = `${value.truncated ? '表示上限に合わせて末尾だけを表示しています。' : '選択したファイルの範囲を表示しています。'}${loss ? ' 保存時の欠落・エラーが記録されています。完全なログではありません。' : ''}${value.snapshotChanged ? ' 読み取り中に更新・ローテーションがありました。再取得で最新状態を確認できます。' : ''}${value.currentActivation === false ? ' 過去の起動世代のログです。' : ''}`;
      logDetails.append(rows('ログの範囲と保存状態', [['対象ログ', `${value.component}.log / 世代 ${value.archive}`], ['候補ID', value.candidateId], ['起動世代 / 現在の選択世代', `${value.activationEpoch} / ${value.pointerEpoch}`], ['起動状態', value.phase], ['ファイル更新', time(value.fileUpdatedAt)], ['取得時刻', time(value.fetchedAt)], ['表示', `${value.returnedBytes} / ${value.fileBytes} bytes・${value.returnedLines} 行`], ['表示から省略', `${value.omittedBytes} bytes`], ['先頭行', value.firstLinePartial ? '途中から表示' : '行頭から表示'], ['保存時に受信 / 書込 / 破棄', `${health.receivedBytes ?? '未取得'} / ${health.writtenBytes ?? '未取得'} / ${health.droppedBytes ?? '未取得'} bytes`], ['保持上限による切り詰め', health.trimmedBytes], ['ローテーション回数', health.rotations], ['書込 / 読取エラー', `${health.writeError || 'なし'} / ${health.readError || 'なし'}`], ['未書込キュー', health.queuedChunks], ['起動記録の更新', value.activationUpdatedAt ? time(Number(value.activationUpdatedAt) * 1000) : '未取得']]));
      raw(logDetails, { files: value.files, logHealth: value.logHealth, encoding: value.encoding, controlCredentialsRedacted: value.controlCredentialsRedacted }, false, '保持世代・欠落の詳細');
    } catch (error) {
      logStatus.className = 'error'; logStatus.textContent = `${error.message}${lastLogAt ? ` 表示中の本文は ${time(lastLogAt)} に取得した過去の内容です。` : ' ログが空とは判断できません。'}`;
    } finally { logPending = false; logRefresh.disabled = false; if (component.value !== selected || archive.value !== selectedArchive || lines.value !== selectedLines) queueMicrotask(() => void refreshLogs()); }
  }
  navigation.addEventListener('click', () => { show('recovery'); void refresh(); void refreshLogs(); });
  refreshButton.addEventListener('click', () => void refresh());
  logRefresh.addEventListener('click', () => void refreshLogs());
  component.addEventListener('change', () => { archive.replaceChildren(); const option = text('option', '現在のログ'); option.value = '0'; archive.append(option); logTail.textContent = ''; logDetails.replaceChildren(); lastLogAt = null; void refreshLogs(); });
  archive.addEventListener('change', () => void refreshLogs()); lines.addEventListener('change', () => void refreshLogs());
  const observe = new MutationObserver(() => { if (!app.hidden && !panel.hidden) { void refresh(); void refreshLogs(); } });
  observe.observe(app, { attributes: true, attributeFilter: ['hidden'] });
  observe.observe(panel, { attributes: true, attributeFilter: ['hidden'] });
  setInterval(() => { if (!document.hidden && !app.hidden && !panel.hidden) { void refresh(); void refreshLogs(); } }, 30000);
})();
