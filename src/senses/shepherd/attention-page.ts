/** No model content or target metadata is interpolated into executable HTML. */
export function attentionPage(nonce: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ouro</title>
<style nonce="${nonce}">
:root{color-scheme:dark;font:15px -apple-system,BlinkMacSystemFont,sans-serif;color:#eee;background:#17191d}
*{box-sizing:border-box}body{margin:0}main{max-width:680px;height:100dvh;min-height:340px;margin:auto;display:flex;flex-direction:column;padding:20px;gap:16px}
header{display:flex;align-items:center;gap:10px}h1{font-size:21px;margin:0;letter-spacing:-.5px}.badge{font-size:12px;color:#9da4ae}
label{display:flex;align-items:center;gap:10px;color:#aab1bb;font-size:13px}select{min-width:0;flex:1}
select,textarea,button{font:inherit;color:inherit;border:1px solid #3b4049;background:#22262c;border-radius:10px;padding:10px}
textarea{width:100%;resize:none;min-height:82px;outline:none}textarea:focus{border-color:#9bafff}
#conversation{flex:1;overflow:auto;display:flex;flex-direction:column;gap:14px;min-height:70px}
.message{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.55;margin:0}.you{align-self:flex-end;background:#2c354a;padding:10px 14px;border-radius:14px;max-width:90%}.notice{font-size:13px;color:#e0b275}
#empty{color:#9da4ae;line-height:1.6;margin:auto 0}footer{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px}.actions{display:flex;gap:8px;margin-left:auto}
button{cursor:pointer}button:disabled{opacity:.45;cursor:default}#send{background:#a8b8ff;color:#141823;border-color:transparent;font-weight:600}
#status{font-size:12px;color:#9da4ae}#error{color:#e0b275;font-size:13px;margin:0}form{display:flex;flex-direction:column;gap:8px}
</style></head><body><main>
<header><h1>Ouro</h1><span class="badge">Your session companion</span></header>
<label for="target">About<select id="target" aria-label="Session to discuss"></select></label>
<section id="conversation" aria-live="polite"><p id="empty">Ask Ouro about this session, steer the work, or correct a handback.<br>Your coding agent's input stays untouched.</p></section>
<p id="error" role="alert"></p><form id="compose"><textarea id="draft" aria-label="Message Ouro" placeholder="Message Ouro..." maxlength="12000"></textarea>
<footer><span id="status">Independent of the coding agent</span><div class="actions"><button id="recover" type="button" hidden>Reconnect</button><button id="cancel" type="button" hidden>Cancel Ouro</button><button id="send" type="submit" disabled>Send</button></div></footer></form>
</main><script nonce="${nonce}">
const fragment=new URLSearchParams(location.hash.slice(1));const initialTarget=fragment.get('session');const token=fragment.get('token')||location.hash.slice(1).split('&')[0]||sessionStorage.getItem('ouroAttentionToken');
if(token){sessionStorage.setItem('ouroAttentionToken',token);history.replaceState(null,'',location.pathname);}
const view=sessionStorage.getItem('ouroAttentionView')||crypto.randomUUID();sessionStorage.setItem('ouroAttentionView',view);
const el=id=>document.getElementById(id);let state=null,pending=null,sending=false,targetsSignature='',messagesSignature='';
try{pending=JSON.parse(sessionStorage.getItem('ouroAttentionPending')||'null');}catch{sessionStorage.removeItem('ouroAttentionPending');}
el('draft').value=sessionStorage.getItem('ouroAttentionDraft')||'';el('draft').oninput=()=>sessionStorage.setItem('ouroAttentionDraft',el('draft').value);
async function api(route,body){const response=await fetch(route,{method:body?'POST':'GET',headers:{'X-Ouro-Attention':token||'','X-Ouro-View':view,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});const data=await response.json();if(!response.ok){const error=Error(data.error||'Ouro could not accept this action.');error.status=response.status;throw error;}return data;}
function render(next){state=next;const picker=el('target');const signature=JSON.stringify(next.targets);if(signature!==targetsSignature){targetsSignature=signature;picker.replaceChildren();const prompt=document.createElement('option');prompt.value='';prompt.textContent='Choose a session';picker.append(prompt);for(const target of next.targets){const option=document.createElement('option');option.value=target.id;option.textContent=target.label;picker.append(option);}}picker.value=next.target||'';picker.disabled=next.active||sending;
const conversation=el('conversation');const nextMessages=JSON.stringify(next.messages);if(next.messages.length&&nextMessages!==messagesSignature){const atBottom=conversation.scrollHeight-conversation.scrollTop-conversation.clientHeight<60;conversation.replaceChildren();for(const message of next.messages){const p=document.createElement('p');p.className='message '+message.role;p.textContent=message.text;conversation.append(p);}if(atBottom)conversation.scrollTop=conversation.scrollHeight;}
else if(!next.messages.length&&!el('empty')){conversation.replaceChildren();const p=document.createElement('p');p.id='empty';p.textContent="Ask Ouro about this session. Your coding agent's input stays untouched.";conversation.append(p);}
messagesSignature=nextMessages;
el('send').disabled=next.active||sending||!next.target;el('cancel').hidden=!next.active;el('recover').hidden=!next.active;el('status').textContent=next.active?'Ouro is replying...':'Independent of the coding agent';}
async function refresh(){try{render(await api('/state'));}catch(error){el('error').textContent=error.message;el('send').disabled=true;}}
el('target').onchange=async()=>{try{render(await api('/select',{target:el('target').value}));pending=null;sessionStorage.removeItem('ouroAttentionPending');el('error').textContent='';}catch(error){el('error').textContent=error.message;await refresh();}};
el('compose').onsubmit=async event=>{event.preventDefault();if(sending||!state?.target)return;const message=el('draft').value;if(!message.trim())return;
if(pending&&pending.message!==message){el('error').textContent='Reconnect before changing a message whose acknowledgement was lost.';return;}
pending=pending||{id:crypto.randomUUID(),message};sessionStorage.setItem('ouroAttentionPending',JSON.stringify(pending));sending=true;render(state);try{render(await api('/send',pending));pending=null;sessionStorage.removeItem('ouroAttentionPending');sessionStorage.removeItem('ouroAttentionDraft');el('draft').value='';el('error').textContent='';}catch(error){if(error.status){pending=null;sessionStorage.removeItem('ouroAttentionPending');}el('error').textContent=error.message+' Your draft is preserved; retrying the same message will not submit it twice.';}finally{sending=false;if(state)render(state);}};
el('cancel').onclick=async()=>{try{await api('/cancel',{});await refresh();}catch(error){el('error').textContent=error.message;}};
el('recover').onclick=async()=>{try{await api('/recover',{});await refresh();}catch(error){el('error').textContent=error.message;}};
el('draft').onkeydown=event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();if(!el('send').disabled)el('compose').requestSubmit();}};
async function initialize(){if(initialTarget||!sessionStorage.getItem('ouroAttentionInitialized')){try{render(await api('/select',{target:initialTarget||'current'}));sessionStorage.setItem('ouroAttentionInitialized','true');}catch(error){el('error').textContent=error.message;await refresh();el('send').disabled=true;return;}}else await refresh();setInterval(refresh,1000);}initialize();
</script></body></html>`
}
