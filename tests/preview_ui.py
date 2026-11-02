"""Isolated UI regression harness; no API keys, user records, or provider calls."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

SETUP = r"""<script>
const fixture = {
  nvidia_chat_workspaces: [{id:'ws_test',name:'我的工作空间',systemPrompt:'',updatedAt:1}],
  nvidia_chat_conversations: [],
  nvidia_chat_active: {workspaceId:'ws_test'},
  nvidia_chat_settings: {contextWindows:{'nvidia:test-model':131072}}
};
localStorage.clear();
window.fetch = async (path, options={}) => {
  let data = {};
  if(path==='/api/status') data={has_api_key:true,provider:'nvidia',providers:[{id:'nvidia',name:'NVIDIA',has_api_key:true}]};
  if(path.startsWith('/api/models')) data={models:['test-model']};
  if(path==='/api/config') data={default_model:'test-model'};
  if(path==='/api/user-data') data=fixture;
  if(path==='/api/chat') {
    const bytes = new TextEncoder().encode('data: {"content":"中文回答\\n\\n```html\\n<div>示例</div>\\n```"}\n\ndata: {"done":true,"finish_reason":"stop"}\n\ndata: {"usage":{"prompt_tokens":100,"completion_tokens":30,"total_tokens":130,"cached_tokens":80}}');
    return new Response(new ReadableStream({start(c){
      for(let i=0;i<bytes.length;i+=7)c.enqueue(bytes.slice(i,i+7)); c.close();
    }}));
  }
  return new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}});
};
</script>"""

TESTS = r"""<script>
window.addEventListener('load', async () => {
  const results=[];
  const check=(value,label)=>{if(!value)throw Error(label);results.push(label);};
  try {
    // Deterministic bootstrap after the app's own async initialization.
    await onLoggedIn();
    const clean = safeMarkdown('<img src=x onerror="alert(1)"><scr'+'ipt>alert(1)</scr'+'ipt>');
    check(!clean.includes('onerror') && !clean.includes('<script'), '模型 Markdown 清理脚本和事件处理器');
    const input=document.querySelector('#user-input');
    input.value='请给我一个中文 HTML 示例。';
    input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
    const enter=new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true});
    input.dispatchEvent(enter);
    check(!enter.defaultPrevented && !state.isStreaming,'中文组词回车不触发发送');
    const model=document.querySelector('#model-search-input');
    model.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
    const down=new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true});
    model.dispatchEvent(down);
    check(!down.defaultPrevented,'模型搜索组词方向键不被拦截');
    model.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));
    input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));
    const originalModels = state.models;
    state.models = ['test-model', ...Array.from({length:150},(_,i)=>`model-${String(i).padStart(3,'0')}`)];
    updateModelDisplay();
    model.focus();
    const dropdown = document.querySelector('#model-dropdown');
    check(dropdown.querySelectorAll('.select-dropdown-item').length===151,'打开模型菜单显示完整列表，不使用当前名称过滤');
    model.value='model-149';model.dispatchEvent(new Event('input',{bubbles:true}));
    check(dropdown.querySelectorAll('.select-dropdown-item').length===1,'主动输入才筛选模型');
    model.click();
    check(dropdown.querySelectorAll('.select-dropdown-item').length===1,'点击搜索输入框保留已输入的筛选条件');
    model.blur();model.focus();
    check(dropdown.querySelectorAll('.select-dropdown-item').length===151,'再次打开恢复全部模型');
    if(dropdown.clientHeight) {
      check(dropdown.scrollHeight>dropdown.clientHeight,'模型菜单内容超出时出现滚动区域');
      dropdown.scrollTop=dropdown.scrollHeight;
      check(dropdown.scrollTop>0,'模型列表可以滚动到底部');
    }
    dropdown.querySelector('[data-model="model-149"]').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}));
    check(state.currentModel==='model-149','能够选择第 100 项以后的模型');
    state.models=originalModels;state.currentModel='test-model';model.blur();updateModelDisplay();
    // A hidden window never delivers animation frames. Stream must still finish.
    window.requestAnimationFrame=()=>0;
    await sendMessage();
    const msg=getActiveConversation().messages.at(-1);
    check(msg.content.startsWith('中文回答') && msg.finishReason==='stop','UTF-8 分片及后台窗口完整读流');
    check(msg.usage.total_tokens===130,'无末尾换行的 usage 已读取');
    check(document.querySelector('#cache-stat').textContent.includes('80.0%'),'缓存命中率计算');
    check(document.querySelector('#total-stat').textContent.includes('130'),'累计 token 用量');
    check(document.querySelector('#context-stat').textContent.includes('131,072'),'上下文容量与估算');
    check(document.querySelector('.message-content code').textContent==='<div>示例</div>','Markdown 代码块渲染');
    await retryMessage(msg.id);
    check(document.querySelector('#total-stat').textContent.includes('260'),'重新生成计入累计用量');
    const notice=document.createElement('div');showFinishReason(notice,'length');
    check(!!notice.querySelector('button'),'达到上限显示继续生成按钮');
    check(document.querySelector('.input-params #model-select-wrapper'), '模型选择位于输入框右下角');
    check(document.querySelector('.sidebar-navigation #new-chat-btn'), '新聊天固定在左侧顶部');
    check(Number(document.querySelector('#context-ring-value').getAttribute('stroke-dasharray').split(' ')[0]) > 90,'圆环表示剩余上下文');
    document.querySelector('#context-ring').click();
    check(document.querySelector('#usage-bar').classList.contains('expanded'),'点击圆环展开详情');
    await openKeySettings();
    check(!document.querySelector('#keys-modal').classList.contains('hidden'),'API 密钥独立管理入口');
    document.querySelector('#keys-modal .modal-close').click();
    if (window.location.search.includes('preview')) { document.body.dataset.qa='passed'; return; }
    newChat();
    check(getActiveConversation().messages.length===0,'顶部按钮在当前项目创建新聊天');
    showConfirm=async()=>true;
    const lastConv=getActiveConversation().id;
    await handleSidebarAction('delete-conv',{dataset:{convId:lastConv}});
    check(!getConversation(lastConv),'删除会话');
    await handleSidebarAction('delete-ws',{dataset:{wsId:'ws_test'}});
    check(!getWorkspace('ws_test') && state.conversations.length===0,'删除最后一个项目及其会话');
    newChat();
    check(!!getActiveWorkspace() && !!getActiveConversation(),'项目清空后仍可新建聊天');
    document.body.dataset.qa='passed';
  } catch(e) {results.push('FAILED: '+e.stack);document.body.dataset.qa='failed';}
  const report=document.createElement('pre'); report.id='qa-results';report.hidden=true;
  report.textContent=results.join('\n');document.body.appendChild(report);
  if(navigator.sendBeacon) navigator.sendBeacon('/qa-result',JSON.stringify({status:document.body.dataset.qa,results}));
});
</script>"""

class Handler(SimpleHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        if self.path == '/' or self.path.startswith('/?'):
            html = (ROOT / 'static/index.html').read_text(encoding='utf-8')
            html = html.replace('<script src="/static/app.js">', SETUP + '<script src="/static/app.js">')
            html = html.replace('</body>', TESTS + '</body>')
            body = html.encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            super().do_GET()

    def do_POST(self):
        if self.path != '/qa-result':
            self.send_error(404)
            return
        body = self.rfile.read(min(int(self.headers.get('Content-Length', 0)), 100000))
        target = ROOT / '.qa/browser-results.json'
        target.parent.mkdir(exist_ok=True)
        target.write_bytes(body)
        self.send_response(204)
        self.end_headers()

if __name__ == '__main__':
    ThreadingHTTPServer.request_queue_size = 64
    ThreadingHTTPServer(('127.0.0.1', 18765), Handler).serve_forever()
