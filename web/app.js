/* ReportWriter · 前端 */
const $ = (id) => document.getElementById(id);

const state = {
  taskId: null,
  materials: [],
  running: false,
  logSeq: 0,
  timer: null,
  lastFiles: [],
  auth: null,
  template: null,
};

function updatePermWarn() {
  const danger = $('fPermission').value === 'danger-full-access';
  const el = $('permWarn');
  el.hidden = !danger;
  if (danger) {
    el.textContent = '⚠ 完全访问会关闭 DSH 的命令沙箱和审批，模型可以执行任意本机命令（包括 MATLAB）。仅在你信任当前任务时使用。';
  }
}

function refreshAuthLine() {
  const el = $('authLine');
  const key = $('fApiKey').value.trim();
  if (key) {
    el.hidden = false;
    el.className = 'auth-line ok';
    el.textContent = '将使用本次填写的 DEEPSEEK_API_KEY（只传给本次 DSH 进程，不保存）';
    return;
  }
  const auth = state.auth;
  if (!auth) { el.hidden = true; return; }
  el.hidden = false;
  if (auth.mode === 'missing' || auth.mode === 'account_stale') {
    el.className = 'auth-line bad';
    el.textContent = `⚠ ${auth.note || 'DSH 未完成鉴权'}。请打开 DeepSeek Harness 重新登录，或在上方填写 API Key。`;
  } else {
    el.className = 'auth-line ok';
    el.textContent = `DSH 鉴权：${auth.note || '已就绪'}`;
  }
}

/* ---------------- 基础工具 ---------------- */
function toast(msg, ms = 2600) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(() => (el.hidden = true), ms);
}

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    const data = await res.json();
    if (data.ok === false) throw new Error(data.error || '请求失败');
    return data;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

function setState(pill, text) {
  const p = $('statePill');
  p.dataset.state = pill;
  p.textContent = text;
}

/* ---------------- 表单 ---------------- */
const FIELDS = [
  ['course', 'fCourse'], ['title', 'fTitle'], ['name', 'fName'],
  ['cls', 'fCls'], ['sid', 'fSid'], ['teacher', 'fTeacher'], ['date', 'fDate'],
  ['school', 'fSchool'], ['school_font', 'fSchoolFont'], ['school_color', 'fSchoolColor'],
];

function readInfo() {
  const info = {};
  for (const [k, id] of FIELDS) info[k] = $(id).value.trim();
  return info;
}

function writeInfo(info = {}) {
  for (const [k, id] of FIELDS) {
    const el = $(id);
    if (info[k] === undefined || info[k] === null) continue;
    // 历史任务里可能是空串（当年没这两项）：select / 颜色控件不认空值，跳过交给默认值
    if (!info[k] && (el.tagName === 'SELECT' || el.type === 'color')) continue;
    // select 只认得已存在的 option，旧字体名对不上就别动
    if (el.tagName === 'SELECT' && ![...el.options].some((o) => o.value === info[k])) continue;
    el.value = info[k];
  }
}

const REQUIRED = [
  ['course', 'fCourse', '实验课名称'],
  ['title', 'fTitle', '实验名称'],
  ['name', 'fName', '姓名'],
  ['cls', 'fCls', '班级'],
  ['sid', 'fSid', '学号'],
  ['teacher', 'fTeacher', '任课教师'],
];

function validate(info) {
  for (const [k, id, label] of REQUIRED) {
    if (!info[k]) {
      toast(`请先填写「${label}」`);
      $(id).focus();
      return false;
    }
  }
  return true;
}

/* ---------------- 封面预览 ---------------- */
let previewTimer = null;

function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(refreshPreview, 260);
}

let previewBlobUrl = null;
let previewSeq = 0;

/* 预览走 POST：个人信息不进 URL（否则会留在浏览器历史里） */
async function refreshPreview() {
  const info = readInfo();
  const seq = ++previewSeq;
  try {
    const r = await fetch('/api/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(info),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const blob = await r.blob();
    if (seq !== previewSeq) return;
    if (previewBlobUrl) URL.revokeObjectURL(previewBlobUrl);
    previewBlobUrl = URL.createObjectURL(blob);
    $('previewImg').src = previewBlobUrl;
  } catch (e) {
    if (seq === previewSeq) console.warn('预览生成失败：', e.message);
  }
}

/* ---------------- 生成封面 ---------------- */
async function makeCover(silent = false) {
  const info = readInfo();
  if (!validate(info)) return null;
  if (!info.date) {
    info.date = $('fDate').value || todayStr();
    $('fDate').value = info.date;
  }
  try {
    const data = await api('/api/cover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ info, taskId: state.taskId }),
    });
    state.taskId = data.task.id;
    $('coverState').textContent = `已生成 · ${data.task.info.course}`;
    $('card2').classList.remove('disabled');
    $('card3').classList.remove('disabled');
    if (!silent) toast('封面已生成，可以拖入实验材料了');
    return state.taskId;
  } catch (e) {
    toast(`生成封面失败：${e.message}`);
    return null;
  }
}

/* ---------------- 材料 ---------------- */
function icoOf(kind) {
  return { 图片: '🖼', PDF: '📄', Word: '📝', 文本: '📃' }[kind] || '📦';
}

function renderTemplate() {
  const tpl = state.template;
  $('templateEmpty').hidden = !!tpl;
  $('templateFile').hidden = !tpl;
  if (!tpl) return;
  $('templateName').textContent = tpl.name || '实验报告模板';
  $('templateSub').textContent =
    [tpl.kind, tpl.size, tpl.note].filter(Boolean).join(' · ');
}

function renderMats() {
  const ul = $('matList');
  ul.innerHTML = '';
  state.materials.forEach((m) => {
    const li = document.createElement('li');
    li.className = 'mat';
    const imgCount = (m.images || []).length;
    li.innerHTML = `
      <div class="ico">${icoOf(m.kind)}</div>
      <div class="meta">
        <div class="nm"></div>
        <div class="sub"></div>
      </div>
      <button class="del" title="移除">×</button>`;
    li.querySelector('.nm').textContent = m.name;
    li.querySelector('.sub').textContent =
      [m.kind, m.size, m.note, imgCount ? `内嵌图 ${imgCount}` : '']
        .filter(Boolean).join(' · ');
    li.querySelector('.del').onclick = () => removeMat(m.path);
    ul.appendChild(li);
  });
}

async function removeMat(path) {
  if (!state.taskId) return;
  try {
    const data = await api(`/api/task/${state.taskId}/materials/remove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    applyTask(data.task);
  } catch (e) { toast(e.message); }
}

function applyTask(task) {
  state.taskId = task.id;
  state.materials = task.materials || [];
  state.template = task.template || null;
  renderMats();
  renderTemplate();
  setUsage((task.run && task.run.usage) || null);
  const o = task.opts || {};
  $('fOutName').value = o.outname || '';
  $('fPdf').checked = o.export_pdf !== false;
  if (o.course_key) $('fCourseKey').value = o.course_key;
  if (o.permission_mode) $('fPermission').value = o.permission_mode;
  updatePermWarn();
  if (o.extra) $('fExtra').value = o.extra;
  if (task.cover) {
    $('coverState').textContent = `已生成 · ${task.info.course || ''}`;
    $('card2').classList.remove('disabled');
    $('card3').classList.remove('disabled');
  }
  replayLog(task);
}

/* 载入历史任务时把日志和产物也恢复出来 */
async function replayLog(task) {
  let lines = [];
  try {
    const d = await api(`/api/task/${task.id}/log?from=0`);
    lines = d.lines || [];
    state.logSeq = d.total || 0;
    if (d.usage) setUsage(d.usage);
    if (d.progress && (d.state === 'running' || d.progress.pct > 0)) setProgress(d.progress);
    if (lines.length) {
      $('logbox').hidden = false;
      $('log').textContent = '';
      appendLog(lines.slice(-800));
    }
  } catch (e) { /* 忽略 */ }

  if (!lines.length) {
    try {
      const r = await fetch(`/api/file/${task.id}/${encodeURIComponent('运行记录.log')}`);
      if (r.ok) {
        const txt = await r.text();
        $('logbox').hidden = false;
        $('log').textContent = txt.split('\n').slice(-600).join('\n');
      }
    } catch (e) { /* 忽略 */ }
  }

  const files = task.files || [];
  if (files.length) {
    showResult(files);
    resetRunUI('done', '已完成');
  }
}

async function uploadFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  if (!state.taskId) {
    const tid = await makeCover(true);
    if (!tid) return;
  }
  const fd = new FormData();
  files.forEach((f) => fd.append('files', f, f.name));
  toast(`正在解析 ${files.length} 个文件…`, 8000);
  try {
    const data = await api(`/api/task/${state.taskId}/upload`, { method: 'POST', body: fd });
    applyTask(data.task);
    toast(`已加入 ${data.added.length} 个材料`);
    if ((data.warnings || []).length) {
      const w = $('matWarn');
      w.hidden = false;
      w.textContent = '⚠ ' + data.warnings.join('；');
    }
  } catch (e) {
    toast(`上传失败：${e.message}`);
  }
}

/* ---------------- 教师模板 ---------------- */
const TEMPLATE_EXTS = ['.docx', '.doc', '.dotx', '.pdf'];

async function uploadTemplate(fileList) {
  const file = Array.from(fileList || [])[0];
  if (!file) return;
  const ext = (file.name.match(/\.[^.]+$/) || [''])[0].toLowerCase();
  if (!TEMPLATE_EXTS.includes(ext)) {
    toast('模板只支持 DOCX / DOC / DOTX / PDF');
    return;
  }
  if (!state.taskId) {
    const tid = await makeCover(true);
    if (!tid) return;
  }
  const fd = new FormData();
  fd.append('file', file, file.name);
  toast('正在解析模板…', 8000);
  try {
    const data = await api(`/api/task/${state.taskId}/template`, { method: 'POST', body: fd });
    applyTask(data.task);
    toast('模板已加入，写报告时会优先按它排版');
    if ((data.warnings || []).length) {
      const w = $('matWarn');
      w.hidden = false;
      w.textContent = '⚠ ' + data.warnings.join('；');
    }
  } catch (e) {
    toast(`上传模板失败：${e.message}`);
  }
}

async function removeTemplate() {
  if (!state.taskId) return;
  if (!confirm('移除当前实验报告模板？')) return;
  try {
    const data = await api(`/api/task/${state.taskId}/template/remove`, { method: 'POST' });
    applyTask(data.task);
    toast('模板已移除');
  } catch (e) { toast(e.message); }
}

/* ---------------- 运行 ---------------- */
async function runTask() {
  if (state.running) return;
  const info = readInfo();
  if (!validate(info)) return;
  if (!state.taskId) {
    const tid = await makeCover(true);
    if (!tid) return;
  }
  const paste = $('pasteText').value.trim();
  if (!state.materials.length && !paste) {
    toast('还没有实验内容：拖入材料，或把文字粘到文本框里');
    return;
  }
  const permission = $('fPermission').value;
  if (permission === 'danger-full-access' &&
      !confirm('完全访问会关闭 DSH 的命令沙箱和审批，模型可以执行任意本机命令（包括 MATLAB）。\n\n确定要使用完全访问吗？')) {
    return;
  }

  $('logbox').hidden = false;
  $('log').textContent = '';
  $('result').hidden = true;
  resetProgress();
  const wantPdf = $('fPdf').checked;
  setProgress({
    pct: 2,
    stage: '启动 DSH',
    state: 'running',
    elapsed: 0,
    complete: false,
    steps: [
      { key: 'start', label: '启动 DSH', state: 'active' },
      { key: 'write', label: '读取材料 · 撰写正文', state: 'pending' },
      { key: 'docx', label: '生成 DOCX', state: 'pending' },
      { key: 'pdf', label: wantPdf ? '导出 PDF' : 'PDF（未勾选）', state: wantPdf ? 'pending' : 'skipped' },
      { key: 'finish', label: '报告完成', state: 'pending' },
    ],
  });
  state.logSeq = 0;
  setState('running', '写作中…');
  $('logState').textContent = '启动中…';
  $('btnRun').disabled = true;
  $('btnCancel').hidden = false;
  $('runHint').textContent = 'DSH 正在读材料、写正文，可能要几分钟到十几分钟';

  try {
    await api(`/api/task/${state.taskId}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        course_key: $('fCourseKey').value,
        export_pdf: $('fPdf').checked,
        outname: $('fOutName').value.trim(),
        permission_mode: permission,
        api_key: $('fApiKey').value.trim(),
        paste_text: paste,
        extra: $('fExtra').value.trim(),
      }),
    });
    state.running = true;
    pollLog();
  } catch (e) {
    toast(e.message);
    resetRunUI('failed', '启动失败');
  }
}

function appendLog(lines) {
  const box = $('log');
  const frag = document.createDocumentFragment();
  for (const [, stream, text] of lines) {
    const span = document.createElement('span');
    span.className = `s-${stream}`;
    span.textContent = text + '\n';
    frag.appendChild(span);
  }
  box.appendChild(frag);
  box.scrollTop = box.scrollHeight;
}

async function pollLog() {
  clearInterval(state.timer);
  state.timer = setInterval(async () => {
    try {
      const data = await api(`/api/task/${state.taskId}/log?from=${state.logSeq}`);
      if (data.lines.length) {
        appendLog(data.lines);
        state.logSeq = data.total;
      }
      state.lastFiles = data.files || [];
      if (data.progress) setProgress(data.progress);
      setUsage(data.usage);
      if (data.state !== 'running') {
        clearInterval(state.timer);
        state.running = false;
        if (data.state === 'done') {
          resetRunUI('done', '已完成');
          showResult(data.files || []);
        } else if (data.state === 'canceled') {
          resetRunUI('idle', '已中止');
        } else {
          resetRunUI('failed', '失败');
          $('logState').textContent = '失败，看日志最后几行';
        }
      }
    } catch (e) {
      clearInterval(state.timer);
      state.running = false;
      resetRunUI('failed', '连接中断');
    }
  }, 1200);
}

function formatDuration(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  if (sec < 60) return `${sec} 秒`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s ? `${m} 分 ${s} 秒` : `${m} 分钟`;
}

function renderSteps(steps) {
  const ol = $('psteps');
  ol.innerHTML = '';
  if (!Array.isArray(steps) || !steps.length) return;
  for (const s of steps) {
    const li = document.createElement('li');
    const state = s.state || 'pending';
    li.className = `pstep ${state}`;
    li.title = s.label || '';
    const dot = document.createElement('i');
    const label = document.createElement('span');
    label.textContent = s.label || '';
    li.append(dot, label);
    ol.appendChild(li);
  }
}

function updateTopProgress(pct, complete, bad) {
  const top = $('topProgress');
  top.hidden = false;
  top.classList.toggle('full', !!complete);
  top.classList.toggle('bad', !!bad);
  $('topFill').style.width = pct + '%';
}

function fmtNum(n) {
  return Number(n || 0).toLocaleString('zh-CN');
}

function setUsage(usage) {
  const el = $('tokenLine');
  if (!usage || !usage.steps) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  const parts = [
    `输入 ${fmtNum(usage.inputTokens)}`,
    `输出 ${fmtNum(usage.outputTokens)}`,
  ];
  if (usage.cacheReadTokens) parts.push(`缓存读 ${fmtNum(usage.cacheReadTokens)}`);
  if (usage.cacheWriteTokens) parts.push(`缓存写 ${fmtNum(usage.cacheWriteTokens)}`);
  parts.push(`总计 ${fmtNum(usage.totalTokens)}`);
  el.hidden = false;
  el.textContent = `Token 用量（${usage.steps} 步）：` + parts.join(' · ');
}

function setProgress(p) {
  if (!p) return;
  const box = $('progress');
  const pct = Math.max(0, Math.min(100, Math.round(p.pct || 0)));
  // 兼容旧版后端：没有 complete 字段时，只有任务成功结束且到 100% 才算完成
  const complete = !!p.complete || (pct >= 100 && p.state === 'done');
  const bad = p.state === 'failed' || p.state === 'canceled';
  box.hidden = false;
  box.classList.toggle('full', complete);
  box.classList.toggle('bad', bad);
  box.setAttribute('aria-valuenow', String(pct));
  $('pfill').style.width = pct + '%';
  $('ppct').textContent = pct + '%';
  $('pstage').textContent = complete ? '✅ 报告已完成' : (p.stage || '');

  const meta = [];
  if (p.elapsed) meta.push(`已用时 ${formatDuration(p.elapsed)}`);
  if (p.state === 'running' && !complete && pct < 90) {
    // 写作阶段没有真实百分比，按预计总时长 9 分钟给出剩余时间
    const left = Math.max(0, 540 - (p.elapsed || 0));
    meta.push(left > 60 ? `预计还要约 ${Math.ceil(left / 60)} 分钟` : '快好了');
  }
  if (complete) meta.push('报告文件已生成');
  $('pmeta').textContent = meta.join(' · ');

  updateTopProgress(pct, complete, bad);
  renderSteps(p.steps || []);
}

function resetProgress() {
  const box = $('progress');
  box.hidden = true;
  box.classList.remove('full', 'bad');
  box.setAttribute('aria-valuenow', '0');
  $('pfill').style.width = '0%';
  $('ppct').textContent = '0%';
  $('pstage').textContent = '准备中…';
  $('pmeta').textContent = '';
  $('psteps').innerHTML = '';
  const top = $('topProgress');
  top.hidden = true;
  top.classList.remove('full', 'bad');
  $('topFill').style.width = '0%';
  setUsage(null);
}

function resetRunUI(pill, text) {
  setState(pill, text);
  $('btnRun').disabled = false;
  $('btnCancel').hidden = true;
  $('logState').textContent = text;
  $('runHint').textContent = pill === 'done'
    ? '报告已生成，见下方结果'
    : '会先打开 DSH 会话，把封面 + 材料清单丢进去';
}

function showResult(files) {
  const box = $('result');
  const actions = $('resultActions');
  actions.innerHTML = '';
  const docx = files.find((f) => f.name.endsWith('.docx'));
  const pdf = files.find((f) => f.name.endsWith('.pdf'));
  $('resultTitle').textContent = docx
    ? `✅ 报告已完成：${docx.name}（${docx.size}）`
    : '⚠ 运行结束，但没在输出目录找到 DOCX';

  const mk = (label, cls, fn) => {
    const b = document.createElement('button');
    b.className = `btn ${cls}`;
    b.textContent = label;
    b.onclick = fn;
    actions.appendChild(b);
  };
  if (docx) mk('📖 打开报告', 'primary', () => openTarget('docx'));
  if (pdf) mk('📕 打开 PDF', 'ghost', () => openTarget('pdf'));
  if (docx && !pdf) mk('导出 PDF', 'ghost', exportPdf);
  mk('📂 输出目录', 'ghost', () => openTarget('out'));
  box.hidden = false;
}

async function openTarget(target) {
  try {
    await api(`/api/task/${state.taskId}/open`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target }),
    });
  } catch (e) { toast(e.message); }
}

async function exportPdf() {
  toast('正在用本机 Word 转 PDF…', 6000);
  try {
    const r = await api(`/api/task/${state.taskId}/pdf`, { method: 'POST' });
    toast('PDF 已导出');
    const data = await api(`/api/task/${state.taskId}`);
    showResult(data.task.files || []);
  } catch (e) { toast(`导出失败：${e.message}`); }
}

/* ---------------- 历史任务 ---------------- */
async function openHistory() {
  try {
    const data = await api('/api/tasks');
    const body = $('modalBody');
    body.innerHTML = '';
    if (!data.tasks.length) body.textContent = '还没有历史任务';
    for (const t of data.tasks) {
      const row = document.createElement('div');
      row.className = 'task-item';
      row.innerHTML = `<div><div class="ti-main"></div><div class="ti-sub"></div></div>
        <div class="ti-side"><div class="muted"></div><button class="ti-del" title="删除这个任务及其文件夹">删除</button></div>`;
      row.querySelector('.ti-main').textContent =
        `${t.info.course || '未命名'} · ${t.info.title || ''}`;
      row.querySelector('.ti-sub').textContent =
        `${t.info.name || ''} ${t.info.cls || ''} ${t.info.sid || ''}`;
      row.querySelector('.ti-side .muted').textContent = t.created.replace('T', ' ');
      row.querySelector('.ti-del').onclick = async (ev) => {
        ev.stopPropagation();
        await removeTask(t, row);
      };
      row.onclick = async () => {
        const full = await api(`/api/task/${t.id}`);
        writeInfo(full.task.info);
        state.taskId = null;
        applyTask(full.task);
        refreshPreview();
        $('modal').hidden = true;
        toast('已载入历史任务');
      };
      body.appendChild(row);
    }
    $('modal').hidden = false;
  } catch (e) { toast(e.message); }
}

/* ---------------- 删除任务 ---------------- */
async function removeTask(t, row) {
  const label = `${t.info.course || '未命名'} · ${t.info.title || ''}`;
  if (!confirm(`删除任务「${label}」？\n连同它的整个文件夹（材料、封面、输出）一起删掉，不能恢复。`)) return;
  try {
    await api(`/api/task/${t.id}/delete`, { method: 'POST' });
    row.remove();
    if (!document.querySelector('#modalBody .task-item')) {
      $('modalBody').innerHTML = '<div class="task-empty">还没有历史任务</div>';
    }
    if (state.taskId === t.id) blankTask();
    toast('任务和它的文件夹已删除');
  } catch (e) {
    toast(`删除失败：${e.message}`);
  }
}

/* 当前任务被删掉后，把界面恢复成刚打开的样子 */
function blankTask() {
  state.taskId = null;
  state.materials = [];
  state.template = null;
  renderMats();
  renderTemplate();
  $('coverState').textContent = '尚未生成';
  $('card2').classList.add('disabled');
  $('card3').classList.add('disabled');
  $('logbox').hidden = true;
  $('log').textContent = '';
  $('result').hidden = true;
  resetProgress();
  state.logSeq = 0;
  setState('idle', '未开始');
  resetRunUI('idle', '未开始');
}

/* ---------------- 启动 ---------------- */
function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function boot() {
  try {
    const data = await api('/api/bootstrap');
    state.auth = data.auth || null;
    refreshAuthLine();
    const perm = data.dsh_permission_mode;
    if (perm && [...$('fPermission').options].some((o) => o.value === perm)) {
      $('fPermission').value = perm;
    }
    updatePermWarn();
    $('fDate').value = data.today || todayStr();
    // 校名的默认值来自 config.json，可在界面上临时改
    if (data.school_text) $('fSchool').placeholder = `例：${data.school_text}`;
    if (data.school_font) {
      const ok = [...$('fSchoolFont').options].some((o) => o.value === data.school_font);
      if (ok) $('fSchoolFont').value = data.school_font;
    }
    if (data.school_color) $('fSchoolColor').value = data.school_color;
    const sel = $('fCourseKey');
    for (const c of data.courses) {
      const o = document.createElement('option');
      o.value = c.key;
      o.textContent = c.name;
      sel.appendChild(o);
    }
    $('footInfo').textContent =
      `DSH · nuist-stem-lab-report · ${data.python.split('\\').pop()}`;
  } catch (e) {
    toast(`后端未就绪：${e.message}`);
  }
  refreshPreview();
}

/* ---------------- 事件绑定 ---------------- */
FIELDS.forEach(([, id]) => {
  $(id).addEventListener('input', schedulePreview);
  $(id).addEventListener('change', schedulePreview);
});

$('fApiKey').addEventListener('input', refreshAuthLine);
$('fPermission').addEventListener('change', updatePermWarn);

$('btnCover').onclick = () => makeCover(false);

$('dropzone').onclick = () => $('fileInput').click();
$('fileInput').onchange = (e) => {
  uploadFiles(e.target.files);
  e.target.value = '';
};

$('btnTemplate').onclick = () => $('templateInput').click();
$('btnTemplateReplace').onclick = () => $('templateInput').click();
$('btnTemplateRemove').onclick = removeTemplate;
$('templateInput').onchange = (e) => {
  uploadTemplate(e.target.files);
  e.target.value = '';
};

['dragenter', 'dragover'].forEach((ev) =>
  $('templateBox').addEventListener(ev, (e) => {
    e.preventDefault();
    $('templateBox').classList.add('over');
  }));
['dragleave', 'drop'].forEach((ev) =>
  $('templateBox').addEventListener(ev, (e) => {
    e.preventDefault();
    $('templateBox').classList.remove('over');
  }));
$('templateBox').addEventListener('drop', (e) => uploadTemplate(e.dataTransfer.files));

['dragenter', 'dragover'].forEach((ev) =>
  $('dropzone').addEventListener(ev, (e) => {
    e.preventDefault();
    $('dropzone').classList.add('over');
  }));
['dragleave', 'drop'].forEach((ev) =>
  $('dropzone').addEventListener(ev, (e) => {
    e.preventDefault();
    $('dropzone').classList.remove('over');
  }));
$('dropzone').addEventListener('drop', (e) => uploadFiles(e.dataTransfer.files));

document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  if (e.target.closest('#dropzone') || e.target.closest('#templateBox')) return;
  if (e.dataTransfer && e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
});

$('btnRun').onclick = runTask;

$('btnCancel').onclick = async () => {
  if (!confirm('确定要中止本次写作吗？')) return;
  try {
    await api(`/api/task/${state.taskId}/cancel`, { method: 'POST' });
    toast('已发送中止信号');
  } catch (e) { toast(e.message); }
};

$('btnHistory').onclick = openHistory;
$('modalClose').onclick = () => ($('modal').hidden = true);
$('modal').onclick = (e) => { if (e.target.id === 'modal') $('modal').hidden = true; };

$('btnOpenWork').onclick = () => {
  if (!state.taskId) return toast('还没有任务');
  openTarget('dir');
};

$('btnQuit').onclick = async () => {
  if (state.running && !confirm('报告还在写，确定退出吗？')) return;
  await api('/api/shutdown', { method: 'POST' }).catch(() => {});
  document.body.innerHTML =
    '<div style="display:grid;place-items:center;height:100vh;color:#8493ad;font-family:sans-serif">' +
    '软件已退出，可以关闭这个窗口了</div>';
};

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') runTask();
  if (e.key === 'Escape') $('modal').hidden = true;
});

window.addEventListener('beforeunload', (e) => {
  if (state.running) { e.preventDefault(); e.returnValue = ''; }
});

boot();
