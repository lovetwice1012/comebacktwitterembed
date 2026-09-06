'use strict';
/* global api */
(() => {
  const form=document.getElementById('login-form');
  const link=document.createElement('a');link.textContent='Discordでログイン';link.href='auth/discord/login';link.className='oauth-login';link.hidden=true;form.before(link);
  api('auth/methods').then(methods=>{link.hidden=methods.discord!==true}).catch(()=>{});
  const identity=document.createElement('span');identity.hidden=true;document.getElementById('logout').before(identity);
  const app=document.getElementById('app');
  async function refreshIdentity(){
    if(app.hidden){identity.hidden=true;return}
    try{const session=await api('auth/session');if(app.hidden)return;const method={discord:'Discord',passkey:'パスキー',password:'回復用パスワード'}[session.authMethod]||'管理者';identity.textContent=`${session.user?.username||'管理者'} · ${session.actor} (${method})`;identity.hidden=false}catch{identity.hidden=true}
  }
  new MutationObserver(()=>void refreshIdentity()).observe(app,{attributes:true,attributeFilter:['hidden']});
  void refreshIdentity();
})();
