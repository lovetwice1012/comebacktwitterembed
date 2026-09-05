'use strict';
/* global text, raw, table, time, download, durationLabel */
globalThis.CBTEEvidences = (() => {
  function http(target,attempt,label='HTTP応答'){
    const model=globalThis.CBTEView.http(attempt);const box=document.createElement('details');box.open=true;box.append(text('summary',`${label} · ${model.statusLabel}`));
    table(box,[['要求',`${attempt.method||'メソッド未記録'} ${attempt.url||'URL未記録'}`],['最終応答URL',attempt.responseUrl||'未記録'],['処理時間',durationLabel(model.durationMs)],['応答本文の取得状態',attempt.bodyState||'未記録'],['応答の元サイズ',attempt.bytes==null?'未記録':`${attempt.bytes} bytes`]],[['確認項目',r=>r[0]],['記録',r=>r[1]]]);
    if(model.truncated)box.append(text('p','応答本文は保存上限で切り詰められています。完全な本文として再解析できません。','error'));
    if(model.credentialsRedacted)box.append(text('p','認証情報に該当するフィールドは保存前に除去されています。','muted'));
    if(attempt.error)raw(box,attempt.error,true,'通信・読み取りのエラー原文');
    raw(box,attempt.requestHeaders||{},false,'要求ヘッダー');raw(box,attempt.headers||{},false,'応答ヘッダー');
    const body=document.createElement('details');body.open=true;body.append(text('summary',attempt.bodyEncoding==='base64'?'応答本文 (Base64で保存)':'応答本文'));
    if(model.bodyState==='not_saved')body.append(text('p','応答本文は保存されていません。空の本文が返ったという意味ではありません。','error'));
    else{if(model.bodyState==='saved_empty')body.append(text('p','空の本文を記録しています（0文字）。'));body.append(text('pre',typeof attempt.body==='string'?attempt.body:JSON.stringify(attempt.body,null,2)));const copy=text('button','本文をコピー');copy.type='button';copy.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(typeof attempt.body==='string'?attempt.body:JSON.stringify(attempt.body));copy.textContent='コピーしました'}catch{copy.textContent='コピーできませんでした。原文を選択してください'}});body.append(copy)}
    box.append(body);raw(box,attempt,false,'このHTTP試行の全フィールド');target.append(box);
  }
  function events(target,items,{label='処理の経過'}={}){
    const entries=(items||[]).map(globalThis.CBTEView.event);target.append(text('h3',label));if(!entries.length){target.append(text('p','関連イベントは記録されていません。処理成功の根拠にはできません。','muted'));return}
    const input=document.createElement('input');input.placeholder='段階・URL・エラーを絞り込み';input.type='search';input.setAttribute('aria-label','処理の経過を絞り込み');const result=document.createElement('div');target.append(input,result);
    const render=()=>{result.replaceChildren();const needle=input.value.toLowerCase();const selected=entries.filter(entry=>entry.search.toLowerCase().includes(needle));result.append(text('p',`${selected.length} / ${entries.length} 件`,'muted'));for(const entry of selected){const detail=document.createElement('details');detail.open=Boolean(entry.errorMessage)||entry.kind.includes('failed')||entry.kind.includes('unknown')||['E','P','X'].includes(entry.payload.outcome||entry.details.outcome);detail.append(text('summary',`${time(entry.occurredAt)} · ${entry.kind}${entry.outcome?' · '+entry.outcome:''}`));if(entry.timestampInferred)detail.append(text('p','発生時刻が未記録のため、取込時刻が使用されています。','muted'));if(entry.url)detail.append(text('p',entry.url));if(entry.errorMessage)detail.append(text('p',entry.errorMessage,'error'));if(entry.isHTTP)http(detail,entry.details,'この段階で保存されたHTTP資料');raw(detail,entry.payload,true,'イベントの全フィールド');result.append(detail)}};
    input.addEventListener('input',render);render();
  }
  function run(target,value){
    if(Array.isArray(value.events)){target.append(text('p',`処理ID: ${value.id||value.runId||'未記録'}`));const save=text('button','この処理の証拠を保存');save.type='button';save.addEventListener('click',()=>download(value,`cbte-evidence-${value.id||'run'}.json`));target.append(save);events(target,value.events);raw(target,value,false,'処理全体の保存データ')}
    else events(target,[value]);
  }
  return {http,events,run};
})();
