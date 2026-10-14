export const MAX_ATTENTION_BODY_BYTES = 16_384

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
<label for="target">About<select id="target" aria-label="Session to discuss"></select><button id="refresh" type="button" aria-label="Refresh session choices">Refresh</button></label>
<section id="conversation" aria-live="polite"><p id="empty">Ask Ouro about this session, steer the work, or correct a handback.<br>Your coding agent's input stays untouched.</p></section>
<p id="error" role="alert"></p><form id="compose"><textarea id="draft" aria-label="Message Ouro" placeholder="Message Ouro..." maxlength="12000"></textarea>
<footer><span id="status">Independent of the coding agent</span><div class="actions"><button id="recover" type="button" hidden>Reconnect</button><button id="cancel" type="button" hidden>Cancel Ouro</button><button id="send" type="submit" disabled>Send</button></div></footer></form>
</main><script nonce="${nonce}">
const fragment=new URLSearchParams(location.hash.slice(1));const initialTarget=fragment.get('session');const token=fragment.get('token')||location.hash.slice(1).split('&')[0]||sessionStorage.getItem('ouroAttentionToken');
if(token){sessionStorage.setItem('ouroAttentionToken',token);history.replaceState(null,'',location.pathname);}
const view=sessionStorage.getItem('ouroAttentionView')||crypto.randomUUID();sessionStorage.setItem('ouroAttentionView',view);
const el=id=>document.getElementById(id);
let state=null,pending=null,sending=false,targetsSignature='',messagesSignature='';
let bindingReady=sessionStorage.getItem('ouroAttentionInitialized')==='true',pendingFault=false;
try {
  pending=JSON.parse(sessionStorage.getItem('ouroAttentionPending')||'null');
  if(pending&&(typeof pending.id!=='string'||typeof pending.target!=='string'||typeof pending.message!=='string'))throw Error('Stored send identity is incomplete.');
} catch(error) {
  pendingFault=true;
  el('error').textContent=error.message+' Check this conversation before resending; its request identity has not been discarded.';
}
let pendingWasUncertain=!!pending;
el('draft').value=sessionStorage.getItem('ouroAttentionDraft')||'';el('draft').oninput=()=>sessionStorage.setItem('ouroAttentionDraft',el('draft').value);
async function api(route,body) {
  const response=await fetch(route,{
    method:body?'POST':'GET',
    headers:{'X-Ouro-Attention':token||'','X-Ouro-View':view,...(pending?{'X-Ouro-Pending':pending.id}:{}),...(body?{'Content-Type':'application/json'}:{})},
    ...(body?{body:JSON.stringify(body)}:{})
  });
  const data=await response.json();
  if(!response.ok) {const error=Error(data.error||'Ouro could not accept this action.');error.status=response.status;throw error;}
  return data;
}
function acknowledge(submitted) {
  if(!pending||pending.id!==submitted.id)return;
  pending=null;
  pendingWasUncertain=false;
  sessionStorage.removeItem('ouroAttentionPending');
  if(el('draft').value===submitted.message) {
    el('draft').value='';
    sessionStorage.removeItem('ouroAttentionDraft');
  }
  el('error').textContent='';
}
function render(next) {
  state=next;
  if(pending&&next.acknowledged?.id===pending.id&&next.acknowledged.target===pending.target)acknowledge(pending);
  const picker=el('target'),signature=JSON.stringify(next.targets);
  if(signature!==targetsSignature) {
    targetsSignature=signature;picker.replaceChildren();
    const prompt=document.createElement('option');prompt.value='';prompt.textContent='Choose a session';picker.append(prompt);
    for(const target of next.targets) {
      const option=document.createElement('option');option.value=target.id;option.textContent=target.label;picker.append(option);
    }
  }
  picker.value=bindingReady?next.target||'':'';
  picker.disabled=next.active||sending||!!pending||pendingFault;
  const conversation=el('conversation'),nextMessages=JSON.stringify(next.messages);
  if(next.messages.length&&nextMessages!==messagesSignature) {
    const atBottom=conversation.scrollHeight-conversation.scrollTop-conversation.clientHeight<60;
    conversation.replaceChildren();
    for(const message of next.messages) {
      const p=document.createElement('p');p.className='message '+message.role;p.textContent=message.text;conversation.append(p);
    }
    if(atBottom)conversation.scrollTop=conversation.scrollHeight;
  } else if(!next.messages.length&&!el('empty')) {
    conversation.replaceChildren();
    const p=document.createElement('p');p.id='empty';p.textContent="Ask Ouro about this session. Your coding agent's input stays untouched.";conversation.append(p);
  }
  messagesSignature=nextMessages;
  const available=next.targets.some(target=>target.id===next.target);
  el('send').disabled=next.active||sending||!bindingReady||!available||pendingFault||!!(pending&&pending.target!==next.target);
  el('cancel').hidden=!next.active;el('recover').hidden=!next.active&&!pending;
  el('status').textContent=next.active?'Ouro is replying...':!next.targets.length?'No coding sessions available':!available?'Choose an available session':'Independent of the coding agent';
}
async function refresh() {
  try {render(await api('/state'));}
  catch(error) {el('error').textContent=error.message;el('send').disabled=true;}
}
async function select(target) {
  const next=await api('/select',{target});
  bindingReady=true;sessionStorage.setItem('ouroAttentionInitialized','true');render(next);
}
el('target').onchange=async()=>{
  if(pending||pendingFault||sending) {el('error').textContent='Resolve the original message acknowledgement before changing About.';if(state)render(state);return;}
  try {await select(el('target').value);el('error').textContent='';}
  catch(error) {el('error').textContent=error.message;await refresh();}
};
el('refresh').onclick=async()=>{
  try {render(await api('/targets',{}));}
  catch(error) {el('error').textContent=error.message;}
};
el('compose').onsubmit=async event=>{
  event.preventDefault();
  if(sending||!bindingReady||pendingFault||!state?.target||state.active)return;
  const message=el('draft').value;
  if(!message.replace(/^@ouro(?:\\s+|$)/i,'').trim())return;
  if(pending&&(pending.message!==message||pending.target!==state.target)) {
    el('error').textContent='Reconnect before changing a message whose acknowledgement was lost.';return;
  }
  const submitted=pending||{id:crypto.randomUUID(),target:state.target,message};
  if(new TextEncoder().encode(JSON.stringify(submitted)).byteLength>${MAX_ATTENTION_BODY_BYTES}) {
    el('error').textContent=pending?'The saved request is too large; check its original receipt before changing it.':'Message too large; shorten it. Nothing was sent.';
    return;
  }
  pending=submitted;
  sessionStorage.setItem('ouroAttentionPending',JSON.stringify(pending));
  sending=true;render(state);
  try {const next=await api('/send',submitted);acknowledge(submitted);render(next);}
  catch(error) {
    if(pending?.id===submitted.id) {
      if(error.status===413&&!pendingWasUncertain) {
        pending=null;sessionStorage.removeItem('ouroAttentionPending');
        el('error').textContent=error.message+' Nothing was submitted; shorten the preserved draft.';
      } else {
        pendingWasUncertain=true;
        el('error').textContent=error.message+' Your draft and original request identity are preserved.';
      }
    }
  }
  finally {sending=false;if(state)render(state);}
};
el('cancel').onclick=async()=>{
  try {await api('/cancel',{});await refresh();}catch(error) {el('error').textContent=error.message;}
};
el('recover').onclick=async()=>{
  try {await api('/recover',{});await refresh();}catch(error) {el('error').textContent=error.message;}
};
el('draft').onkeydown=event=>{
  if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing) {event.preventDefault();if(!el('send').disabled)el('compose').requestSubmit();}
};
async function initialize() {
  try {
    if(pending&&bindingReady)await refresh();
    else if(initialTarget||!bindingReady)await select(pending?.target||initialTarget||'current');
    else await refresh();
  } catch(error) {bindingReady=false;el('error').textContent=error.message;await refresh();}
}
initialize();setInterval(refresh,1000);
</script></body></html>`
}
