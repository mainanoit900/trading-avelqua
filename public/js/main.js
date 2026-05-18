
function toggleAiChat(){
  const box=document.getElementById('aiChatBox');
  if(box) box.classList.toggle('open');
}
async function sendAiMessage(){
  const input=document.getElementById('aiChatInput');
  const messages=document.getElementById('aiChatMessages');
  if(!input || !messages) return;
  const text=(input.value||'').trim();
  if(!text) return;
  messages.insertAdjacentHTML('beforeend', `<div class="ai-msg user">${text}</div>`);
  input.value='';
  const res=await fetch('/api/ai-chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:text})});
  const data=await res.json();
  messages.insertAdjacentHTML('beforeend', `<div class="ai-msg">${data.reply||'เกิดข้อผิดพลาด'}</div>`);
  messages.scrollTop=messages.scrollHeight;
}
