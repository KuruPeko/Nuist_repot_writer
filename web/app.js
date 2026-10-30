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
  pasteAtRun: '',
  coverHistory: [],
  coverTemplate: null,
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

// 封面字段全部可选：留空的字段不会出现在封面上（单独整行省略）。
function validate(info) {
  return true;
}

/* ---------------- 封面填写历史 ---------------- */
function coverHistoryLabel(r) {
  const bits = [r.course, r.title, r.name].filter(Boolean);
  if (r.sid) bits.push(`学号 …${r.sid.slice(-4)}`);
  if (r.date) bits.push(r.date);
  return bits.join(' · ') || '未命名记录';
}

function renderCoverHistory(records) {
  state.coverHistory = Array.isArray(records) ? records : [];
  const sel = $('fCoverHistory');
  sel.innerHTML = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = '选择之前的填写记录…';
  sel.appendChild(placeholder);
  state.coverHistory.forEach((r, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = coverHistoryLabel(r);
    opt.title = [r.cls, r.sid, r.teacher].filter(Boolean).join(' · ');
    sel.appendChild(opt);
  });
  $('btnClearCoverHistory').hidden = state.coverHistory.length === 0;
}

function fillCoverFromHistory(index) {
  const r = state.coverHistory[Number(index)];
  if (!r) return;
  const map = {
    course: 'fCourse', title: 'fTitle', name: 'fName', cls: 'fCls',
    sid: 'fSid', teacher: 'fTeacher', date: 'fDate', school: 'fSchool',
  };
  for (const [k, id] of Object.entries(map)) {
    if (r[k] !== undefined) $(id).value = r[k] || '';
  }
  if (r.school_font && [...$('fSchoolFont').options].some((o) => o.value === r.school_font)) {
    $('fSchoolFont').value = r.school_font;
  }
  if (/^#[0-9a-fA-F]{6}$/.test(r.school_color || '')) {
    $('fSchoolColor').value = r.school_color;
  }
  refreshPreview();
  toast('已填入历史填写记录');
}

async function clearCoverHistory() {
  if (!state.coverHistory.length) return;
  if (!confirm('清除所有本地封面填写记录？此操作不可恢复。')) return;
  try {
    await api('/api/cover/history/clear', { method: 'POST' });
    renderCoverHistory([]);
    toast('已清除历史填写记录');
  } catch (e) {
    toast(`清除失败：${e.message}`);
  }
}

/* ---------------- 课程封面模板 ---------------- */
const tpl = { id: null, name: '', data: null };

function tplMode() {
  const el = document.querySelector('input[name="tplMode"]:checked');
  return el ? el.value : 'builtin';
}

function locValue(loc) {
  if (!loc) return '';
  if (loc.kind === 'para') return `para:${loc.index}`;
  return `cell:${loc.table}:${loc.row}:${loc.cell}`;
}

function parseLoc(v) {
  if (!v) return null;
  if (v.startsWith('para:')) return { kind: 'para', index: Number(v.slice(5)) };
  const n = v.split(':').map(Number);
  return { kind: 'cell', table: n[1], row: n[2], cell: n[3] };
}

function tplFieldDefs() {
  return [
    ['course', '实验课名称'], ['title', '实验名称'], ['name', '姓名'],
    ['cls', '班级'], ['sid', '学号'], ['teacher', '任课教师'], ['date', '实验日期'],
  ];
}

function renderTplMap() {
  const box = $('tplMapList');
  box.innerHTML = '';
  const d = tpl.data;
  if (!d) return;
  const opts = [];
  (d.paragraphs || []).forEach((p) => opts.push({
    v: `para:${p.index}`, t: `第 ${p.index + 1} 段：${p.text.slice(0, 34)}`,
  }));
  (d.cells || []).forEach((c) => opts.push({
    v: `cell:${c.table}:${c.row}:${c.cell}`,
    t: `表 ${c.table + 1} · 第${c.row + 1}行第${c.cell + 1}列：${c.text.slice(0, 24)}`,
  }));
  for (const [key, label] of tplFieldDefs()) {
    const row = document.createElement('div');
    row.className = 'tpl-row-item';
    const lab = document.createElement('span');
    lab.className = 'tpl-field-label';
    lab.textContent = label;
    const sel = document.createElement('select');
    sel.dataset.field = key;
    const o0 = document.createElement('option');
    o0.value = '';
    o0.textContent = '（不填）';
    sel.appendChild(o0);
    for (const o of opts) {
      const op = document.createElement('option');
      op.value = o.v;
      op.textContent = o.t;
      sel.appendChild(op);
    }
    const val = locValue((d.suggestions || {})[key]);
    if (val && [...sel.options].some((o) => o.value === val)) sel.value = val;
    row.append(lab, sel);
    box.appendChild(row);
  }
}

function collectTplMapping() {
  const map = {};
  $('tplMapList').querySelectorAll('select[data-field]').forEach((sel) => {
    const loc = parseLoc(sel.value);
    if (loc) map[sel.dataset.field] = loc;
  });
  return map;
}

async function uploadCoverTemplate(file) {
  const fd = new FormData();
  fd.append('file', file);
  const r = await fetch('/api/template/upload', { method: 'POST', body: fd });
  let d = null;
  try { d = await r.json(); } catch (_) { /* 非 JSON */ }
  if (!r.ok || !d || d.ok === false) {
    throw new Error((d && d.error) || `HTTP ${r.status}`);
  }
  tpl.id = d.id;
  tpl.name = d.name;
  tpl.data = d;
  state.coverTemplate = null;
  $('tplName').textContent = d.name;
  $('tplMap').hidden = false;
  renderTplMap();
  const n = Object.keys(d.suggestions || {}).length;
  $('tplWarn').hidden = n > 0;
  if (n === 0) {
    $('tplWarn').textContent = '没自动识别到字段：请在下面手动选择每个字段要填的位置（常见原因：模板是图片/扫描件，或字段用了文本框）';
  }
  toast(`模板已导入：自动识别 ${n}/7 个字段`);
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
  const payload = { info, taskId: state.taskId, template_mode: tplMode() };
  if (tplMode() === 'custom') {
    if (tpl.id) {
      const mapping = collectTplMapping();
      if (!Object.keys(mapping).length) {
        toast('字段映射是空的：请在下方至少给一个字段选择位置');
        return null;
      }
      payload.template = { id: tpl.id, mapping };
    } else if (!state.coverTemplate) {
      toast('请先点「选择模板…」导入课程发的封面模板');
      return null;
    }
  }
  try {
    const data = await api('/api/cover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    state.taskId = data.task.id;
    state.coverTemplate = data.task.cover_template || null;
    if (Array.isArray(data.cover_history)) renderCoverHistory(data.cover_history);
    const kind = state.coverTemplate ? '课程模板' : '内置模板';
    const course = data.task.info.course || '';
    $('coverState').textContent = `已生成 · ${kind}${course ? ' · ' + course : ''}`;
    $('card2').classList.remove('disabled');
    $('card3').classList.remove('disabled');
    enableReplayCard(true);
    loadReplayEnv();
    if (!silent) toast('封面已生成，可以拖入实验材料了');
    return state.taskId;
  } catch (e) {
    toast(`生成封面失败：${e.message}`);
    return null;
  }
}

/* ---------------- 材料 ---------------- */
function icoOf(kind) {
  return {
    图片: '🖼', PDF: '📄', Word: '📝', 文本: '📃',
    MATLAB: '🧮', LabVIEW: '🧪', CAD: '📐', EDA: '🔌',
    Keil工程: '🛠', HDL: '🧩', 固件: '💾', Arduino: '🤖',
    压缩包: '🗜', 复现: '📸',
  }[kind] || '📦';
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
  state.coverTemplate = task.cover_template || null;
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
    const kind = state.coverTemplate ? '课程模板' : '内置模板';
    $('coverState').textContent = `已生成 · ${kind}${task.info.course ? ' · ' + task.info.course : ''}`;
    $('card2').classList.remove('disabled');
    $('card3').classList.remove('disabled');
    enableReplayCard(true);
  }
  if (state.coverTemplate) {
    const custom = document.querySelector('input[name="tplMode"][value="custom"]');
    if (custom) custom.checked = true;
    $('btnTplPick').hidden = false;
    $('tplName').textContent = '已保存的课程模板';
    $('tplMap').hidden = true;
    $('previewFoot').textContent = '上方预览是内置版式示意；实际封面按已保存的课程模板生成';
  } else {
    const builtin = document.querySelector('input[name="tplMode"][value="builtin"]');
    if (builtin) builtin.checked = true;
    $('btnTplPick').hidden = true;
    $('tplName').textContent = '';
    $('tplMap').hidden = true;
    $('previewFoot').textContent = '预览按本机字体渲染，最终以生成的 DOCX 为准';
  }
  if (task.replay) replayRestore(task.replay);
  loadReplayEnv();
  replayLog(task);
}

/* 载入历史任务时把日志和产物也恢复出来 */
async function replayLog(task) {
  let lines = [];
  let runState = (task.run && task.run.state) || '';
  let pauseReason = (task.run && task.run.pause_reason) || '';
  try {
    const d = await api(`/api/task/${task.id}/log?from=0`);
    lines = d.lines || [];
    runState = d.state || runState;
    pauseReason = d.pause_reason || pauseReason;
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
  if (runState === 'paused') {
    resetRunUI('paused', '已暂停');
    showPaused(pauseReason);
  } else if (files.length) {
    showResult(files);
    resetRunUI('done', '已完成');
  }
}

function showWarnings(warnings) {
  const w = $('matWarn');
  if (!warnings || !warnings.length) {
    w.hidden = true;
    w.textContent = '';
    return;
  }
  w.hidden = false;
  w.textContent = '⚠ ' + warnings.join('；');
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
    showWarnings(data.warnings);
  } catch (e) {
    toast(`上传失败：${e.message}`);
  }
}

async function readFolder() {
  const path = $('folderPath').value.trim();
  if (!path) {
    toast('请先填写或粘贴实验内容文件夹路径');
    $('folderPath').focus();
    return;
  }
  if (!state.taskId) {
    const tid = await makeCover(true);
    if (!tid) return;
  }
  toast('正在读取文件夹…', 12000);
  try {
    const data = await api(`/api/task/${state.taskId}/materials/paths`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: [path] }),
    });
    applyTask(data.task);
    toast(`已从文件夹加入 ${data.added.length} 个材料`);
    showWarnings(data.warnings);
    $('folderPath').value = '';
  } catch (e) {
    toast(`读取文件夹失败：${e.message}`);
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
    showWarnings(data.warnings);
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
  if (rstate.running) return toast('自动复现进行中，等复现结束再开始写报告');
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
  state.pasteAtRun = paste;
  const permission = $('fPermission').value;
  if (permission === 'danger-full-access' &&
      !confirm('完全访问会关闭 DSH 的命令沙箱和审批，模型可以执行任意本机命令（包括 MATLAB）。\n\n确定要使用完全访问吗？')) {
    return;
  }

  $('logbox').hidden = false;
  $('log').textContent = '';
  $('result').hidden = true;
  $('pauseBox').hidden = true;
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
  $('btnPause').hidden = false;
  $('btnPause').disabled = false;
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

async function pauseRun() {
  if (!state.taskId || !state.running) return;
  if (!confirm('暂停后可以补充材料或完成需要手动操作的步骤，再继续。\n\n当前正在执行的步骤可能会被中断，确定暂停吗？')) return;
  try {
    await api(`/api/task/${state.taskId}/pause`, { method: 'POST' });
    toast('正在暂停，等待当前步骤收尾…', 5000);
    $('btnPause').disabled = true;
  } catch (e) {
    toast(`暂停失败：${e.message}`);
    $('btnPause').disabled = false;
  }
}

async function resumeTask() {
  if (!state.taskId) return;
  const permission = $('fPermission').value;
  if (permission === 'danger-full-access' &&
      !confirm('完全访问会关闭 DSH 的命令沙箱和审批，模型可以执行任意本机命令。\n\n继续使用完全访问吗？')) {
    return;
  }
  $('pauseBox').hidden = true;
  $('result').hidden = true;
  $('btnRun').disabled = true;
  $('btnCancel').hidden = false;
  $('btnPause').hidden = false;
  $('btnPause').disabled = false;
  $('logState').textContent = '继续中…';
  setState('running', '继续中…');
  state.running = true;
  state.logSeq = 0;
  appendLog([[0, 'app', '===== 继续上一次 DSH 会话 =====']]);
  setProgress({
    pct: 2,
    stage: '继续 DSH 会话',
    state: 'running',
    elapsed: 0,
    complete: false,
    steps: [
      { key: 'start', label: '继续 DSH 会话', state: 'active' },
      { key: 'write', label: '继续撰写正文', state: 'pending' },
      { key: 'docx', label: '生成 DOCX', state: 'pending' },
      { key: 'pdf', label: '导出 PDF', state: 'pending' },
      { key: 'finish', label: '报告完成', state: 'pending' },
    ],
  });
  const currentPaste = $('pasteText').value.trim();
  const newPaste = currentPaste === state.pasteAtRun ? '' : currentPaste;
  try {
    await api(`/api/task/${state.taskId}/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        course_key: $('fCourseKey').value,
        export_pdf: $('fPdf').checked,
        outname: $('fOutName').value.trim(),
        permission_mode: permission,
        api_key: $('fApiKey').value.trim(),
        paste_text: newPaste,
        extra: $('fExtra').value.trim(),
      }),
    });
    state.pasteAtRun = currentPaste;
    pollLog();
  } catch (e) {
    state.running = false;
    toast(`继续失败：${e.message}`);
    resetRunUI('paused', '已暂停');
    showPaused($('pauseReason').textContent);
  }
}

async function endPaused() {
  if (!state.taskId) return;
  if (!confirm('结束本次任务？已经生成的文件会保留，但之后不能再从当前会话继续。')) return;
  try {
    await api(`/api/task/${state.taskId}/cancel`, { method: 'POST' });
    $('pauseBox').hidden = true;
    $('result').hidden = true;
    resetRunUI('idle', '已结束');
    toast('已结束本次任务');
  } catch (e) {
    toast(`结束失败：${e.message}`);
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
        } else if (data.state === 'paused') {
          resetRunUI('paused', '已暂停');
          showPaused(data.pause_reason || '');
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

function updateTopProgress(pct, complete, bad, paused) {
  const top = $('topProgress');
  top.hidden = false;
  top.classList.toggle('full', !!complete);
  top.classList.toggle('bad', !!bad);
  top.classList.toggle('paused', !!paused);
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
  const paused = p.state === 'paused';
  box.hidden = false;
  box.classList.toggle('full', complete);
  box.classList.toggle('bad', bad);
  box.classList.toggle('paused', paused);
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

  updateTopProgress(pct, complete, bad, paused);
  renderSteps(p.steps || []);
}

function resetProgress() {
  const box = $('progress');
  box.hidden = true;
  box.classList.remove('full', 'bad', 'paused');
  box.setAttribute('aria-valuenow', '0');
  $('pfill').style.width = '0%';
  $('ppct').textContent = '0%';
  $('pstage').textContent = '准备中…';
  $('pmeta').textContent = '';
  $('psteps').innerHTML = '';
  const top = $('topProgress');
  top.hidden = true;
  top.classList.remove('full', 'bad', 'paused');
  $('topFill').style.width = '0%';
  setUsage(null);
}

function resetRunUI(pill, text) {
  setState(pill, text);
  $('btnRun').disabled = pill === 'paused';
  $('btnCancel').hidden = true;
  $('btnPause').hidden = true;
  $('btnPause').disabled = false;
  $('pauseBox').hidden = pill !== 'paused';
  $('logState').textContent = text;
  if (pill === 'done') {
    $('runHint').textContent = '报告已生成，见下方结果';
  } else if (pill === 'paused') {
    $('runHint').textContent = '已暂停；补充材料或完成操作后，点「继续写报告」';
  } else {
    $('runHint').textContent = '会先打开 DSH 会话，把封面 + 材料清单丢进去';
  }
}

function showPaused(reason) {
  $('pauseReason').textContent = reason || '等待你完成操作或补充材料。';
  $('pauseBox').hidden = false;
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

/* ---------------- 自动复现 ---------------- */
const rstate = {
  running: false, timer: null, logSeq: 0,
  stepsDirty: false, env: null, testUrl: null,
};

const EXT_RUNNER = {
  '.m': 'matlab', '.mlx': 'matlab', '.mlapp': 'matlab',
  '.vi': 'labview', '.lvproj': 'labview', '.lvlb': 'labview', '.ctl': 'labview',
  '.dwg': 'cad', '.dxf': 'cad', '.step': 'cad', '.stp': 'cad', '.iges': 'cad',
  '.igs': 'cad', '.stl': 'cad', '.sldprt': 'cad', '.sldasm': 'cad', '.slddrw': 'cad',
};

const REPLAY_DEFAULTS = {
  matlab: '# MATLAB 批处理：运行目标 .m，自动把所有图窗导出为截图\nmatlab_batch',
  labview: 'launch\nwait 15\nactivate\nshot 打开VI\nkey ^r\nwait 6\nshot 运行前面板\nwait 5\nshot 运行结果\nkill',
  cad: 'launch\nwait 25\nshot 打开图纸\nwait 10\nshot 图纸视图\nkill',
  serial: 'serial_open\nwait 2\nserial_read 10',
  generic: 'launch\nwait 8\nshot 启动界面\nwait 5\nshot 运行结果\nkill',
};

function enableReplayCard(on) {
  $('card2b').classList.toggle('disabled', !on);
}

function runnerSel() { return $('rRunner').value; }

function guessRunner() {
  if (runnerSel() !== 'auto') return runnerSel();
  const rel = $('rFile').value;
  const mat = state.materials.find((m) => m.path === rel);
  const name = ((mat && mat.name) || '').toLowerCase();
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot) : '';
  return EXT_RUNNER[ext] || 'generic';
}

function fillDefaultSteps(force = false) {
  if (!force && rstate.stepsDirty) return;
  const r = runnerSel() === 'auto' ? guessRunner() : runnerSel();
  $('rSteps').value = REPLAY_DEFAULTS[r] || '';
  rstate.stepsDirty = false;
}

async function loadReplayEnv() {
  if (!state.taskId) return;
  try {
    const d = await api(`/api/task/${state.taskId}/replay/env`);
    rstate.env = d;
    const sel = $('rFile');
    const prev = sel.value;
    sel.innerHTML = '<option value="">（无）</option>';
    for (const c of d.candidates || []) {
      const o = document.createElement('option');
      o.value = c.path;
      o.textContent = `${c.name}（${c.kind}）`;
      sel.appendChild(o);
    }
    if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
    const ps = $('rPort');
    const prevPort = ps.value;
    ps.innerHTML = '<option value="">（不使用）</option>';
    for (const p of (d.env && d.env.serial_ports) || []) {
      const o = document.createElement('option');
      o.value = p;
      o.textContent = p;
      ps.appendChild(o);
    }
    if ([...ps.options].some((o) => o.value === prevPort)) ps.value = prevPort;
    const tools = (d.env && d.env.tools) || {};
    if (!$('rExe').value.trim()) {
      const r = runnerSel() === 'auto' ? guessRunner() : runnerSel();
      const hit = { matlab: tools.matlab, labview: tools.labview, cad: tools.cad }[r];
      if (hit) $('rExe').placeholder = `自动探测到：${hit}`;
    }
  } catch (e) { /* 环境探测失败不阻塞其它功能 */ }
}

function setReplayProgress(p) {
  const box = $('rProgress');
  if (!p) { box.hidden = true; return; }
  const pct = Math.max(0, Math.min(100, Math.round(p.pct || 0)));
  const bad = p.state === 'failed' || p.state === 'canceled';
  const done = p.state === 'done';
  box.hidden = false;
  box.classList.toggle('full', done);
  box.classList.toggle('bad', bad);
  box.setAttribute('aria-valuenow', String(pct));
  $('rFill').style.width = pct + '%';
  $('rPct').textContent = pct + '%';
  $('rStage').textContent = done ? '✅ 复现完成' : (p.stage || '');
  $('rMeta').textContent = p.summary || '';
}

function appendReplayLog(lines) {
  const box = $('rLog');
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

function artUrl(a) {
  return `/api/file/${state.taskId}/${a.path.split('/').map(encodeURIComponent).join('/')}`;
}

function renderReplayArtifacts(arts) {
  const wrap = $('rArt');
  wrap.innerHTML = '';
  if (!arts || !arts.length) { wrap.hidden = true; return; }
  wrap.hidden = false;
  for (const a of arts) {
    const isImg = /\.(png|jpe?g|gif|webp)$/i.test(a.name);
    const item = document.createElement('div');
    item.className = isImg ? 'shot' : 'filechip';
    if (isImg) {
      const img = document.createElement('img');
      img.src = artUrl(a);
      img.title = a.name;
      img.onclick = () => window.open(img.src, '_blank');
      const cap = document.createElement('div');
      cap.className = 'cap';
      cap.textContent = a.name;
      item.append(img, cap);
    } else {
      item.textContent = `${a.kind === '复现截图' ? '🖼' : '📃'} ${a.name}`;
      item.title = '点击查看';
      item.onclick = () => window.open(artUrl(a), '_blank');
    }
    wrap.appendChild(item);
  }
}

function setReplayRunning(on) {
  rstate.running = on;
  $('btnReplay').disabled = on;
  $('btnReplayStop').hidden = !on;
  $('rLogState').textContent = on ? '运行中…' : $('rLogState').textContent;
  if (on) setState('running', '复现中…');
}

function resetReplayUI() {
  clearInterval(rstate.timer);
  rstate.running = false;
  rstate.logSeq = 0;
  $('btnReplay').disabled = false;
  $('btnReplayStop').hidden = true;
  $('rLogbox').hidden = true;
  $('rLog').textContent = '';
  $('rLogState').textContent = '';
  $('rProgress').hidden = true;
  $('rArt').hidden = true;
  $('rArt').innerHTML = '';
  $('rTestWrap').hidden = true;
  if (rstate.testUrl) { URL.revokeObjectURL(rstate.testUrl); rstate.testUrl = null; }
  setState('idle', '未开始');
}

function replayRestore(replay) {
  if (!replay) return;
  renderReplayArtifacts(replay.artifacts || []);
  if (replay.state && replay.state !== 'idle') setReplayProgress(replay);
  if (replay.state === 'running' && !rstate.running) {
    $('rLogbox').hidden = false;
    setReplayRunning(true);
    pollReplay();
  } else if (replay.state && replay.state !== 'idle') {
    $('rLogState').textContent = {
      done: '已完成', failed: '失败', canceled: '已停止',
    }[replay.state] || '';
    if (replay.summary) {
      $('rLogbox').hidden = false;
      $('rLogState').textContent += ` · ${replay.summary}`;
    }
  }
}

async function startReplay() {
  if (rstate.running) return toast('复现已经在进行中了');
  if (state.running) return toast('报告正在生成中，不能同时复现');
  if (!state.taskId) {
    const tid = await makeCover(true);
    if (!tid) return;
  }
  const plan = {
    runner: runnerSel(),
    file: $('rFile').value,
    exe: $('rExe').value.trim(),
    args: $('rArgs').value.trim(),
    window: $('rWindow').value.trim(),
    shots: parseInt($('rShots').value, 10) || 2,
    interval: parseFloat($('rInterval').value) || 5,
    steps: $('rSteps').value,
    keep_open: false,
    serial: { port: $('rPort').value, baud: parseInt($('rBaud').value, 10) || 9600 },
  };
  if (plan.runner === 'serial' && !plan.serial.port) return toast('串口复现需要先选择 COM 口');
  if (plan.runner === 'matlab' && !plan.file && !plan.exe) return toast('MATLAB 批处理需要先选择一个 .m/.mlx 文件');
  try {
    const d = await api(`/api/task/${state.taskId}/replay/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(plan),
    });
    $('rLogbox').hidden = false;
    $('rLog').textContent = '';
    rstate.logSeq = 0;
    setReplayRunning(true);
    toast(`开始复现（${d.steps} 步）· 期间别动鼠标键盘`);
    pollReplay();
  } catch (e) { toast(e.message); }
}

async function pollReplay() {
  clearInterval(rstate.timer);
  rstate.timer = setInterval(async () => {
    try {
      const d = await api(`/api/task/${state.taskId}/replay/state?from=${rstate.logSeq}`);
      if (d.lines && d.lines.length) {
        appendReplayLog(d.lines);
        rstate.logSeq = d.total;
      }
      setReplayProgress(d);
      renderReplayArtifacts(d.artifacts || []);
      if (d.state !== 'running') {
        clearInterval(rstate.timer);
        rstate.running = false;
        $('btnReplay').disabled = false;
        $('btnReplayStop').hidden = true;
        $('rLogState').textContent =
          d.state === 'done' ? '已完成' : d.state === 'canceled' ? '已停止' : '失败';
        setState('idle', d.state === 'done' ? '已完成' : '未开始');
        if (d.state === 'done') toast(`✅ 复现完成：${d.summary || ''}`, 4200);
        else if (d.state === 'canceled') toast('复现已停止');
        else toast(`复现未完成：${d.summary || '看日志最后几行'}`, 5200);
        const full = await api(`/api/task/${state.taskId}`);
        state.materials = full.task.materials || [];
        renderMats();
        loadReplayEnv();
      }
    } catch (e) {
      clearInterval(rstate.timer);
      rstate.running = false;
      $('btnReplay').disabled = false;
      $('btnReplayStop').hidden = true;
      toast(`复现状态获取失败：${e.message}`);
    }
  }, 1000);
}

async function stopReplay() {
  if (!confirm('确定要停止复现吗？已抓到的截图会保留。')) return;
  try {
    await api(`/api/task/${state.taskId}/replay/stop`, { method: 'POST' });
    toast('已请求停止…');
  } catch (e) { toast(e.message); }
}

async function testShot() {
  toast('正在抓取屏幕…');
  try {
    const r = await fetch('/api/replay/testshot');
    if (!r.ok) {
      let msg = `HTTP ${r.status}`;
      try { msg = (await r.json()).error || msg; } catch (_) { /* keep */ }
      throw new Error(msg);
    }
    const blob = await r.blob();
    if (rstate.testUrl) URL.revokeObjectURL(rstate.testUrl);
    rstate.testUrl = URL.createObjectURL(blob);
    $('rTestImg').src = rstate.testUrl;
    $('rTestWrap').hidden = false;
    toast('已抓屏：在图上量好坐标，填进步骤里的 click X Y');
  } catch (e) { toast(`抓屏失败：${e.message}`); }
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
  state.coverTemplate = null;
  renderMats();
  renderTemplate();
  $('coverState').textContent = '尚未生成';
  $('card2').classList.add('disabled');
  $('card3').classList.add('disabled');
  enableReplayCard(false);
  resetReplayUI();
  tpl.id = null;
  tpl.name = '';
  tpl.data = null;
  $('tplName').textContent = '';
  $('tplMap').hidden = true;
  $('tplMapList').innerHTML = '';
  $('btnTplPick').hidden = true;
  const builtin = document.querySelector('input[name="tplMode"][value="builtin"]');
  if (builtin) builtin.checked = true;
  $('previewFoot').textContent = '预览按本机字体渲染，最终以生成的 DOCX 为准';
  $('logbox').hidden = true;
  $('log').textContent = '';
  $('result').hidden = true;
  resetProgress();
  state.logSeq = 0;
  setState('idle', '未开始');
  resetRunUI('idle', '未开始');
}

/* ---------------- skill 更新检查 ---------------- */
async function checkSkillUpdate(attempt = 0) {
  try {
    const data = await api('/api/skill/update');
    if (data.checking && attempt < 20) {
      setTimeout(() => checkSkillUpdate(attempt + 1), 1200);
      return;
    }
    $('skillUpdate').hidden = !data.available;
  } catch (e) { /* 网络检查失败不打扰用户 */ }
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
    renderCoverHistory(data.cover_history || []);
    checkSkillUpdate();
    fillDefaultSteps(true);
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
$('fCoverHistory').addEventListener('change', (e) => {
  if (e.target.value !== '') fillCoverFromHistory(e.target.value);
});
$('btnClearCoverHistory').onclick = clearCoverHistory;
$('btnSkillUpdateAck').onclick = async () => {
  try {
    await api('/api/skill/update/ack', { method: 'POST' });
    $('skillUpdate').hidden = true;
    toast('已记录 skill 更新状态');
  } catch (e) { toast(e.message); }
};

$('dropzone').onclick = () => $('fileInput').click();
$('fileInput').onchange = (e) => {
  uploadFiles(e.target.files);
  e.target.value = '';
};

$('btnFolder').onclick = readFolder;
$('folderPath').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    readFolder();
  }
});

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

function clipboardFiles(e) {
  const dt = e.clipboardData;
  if (!dt) return [];
  const files = [];
  const seen = new Set();
  const add = (f) => {
    if (!f) return;
    const key = `${f.name}|${f.size}|${f.type}`;
    if (seen.has(key)) return;
    seen.add(key);
    files.push(f);
  };
  if (dt.files) for (const f of dt.files) add(f);
  if (dt.items) {
    for (const item of dt.items) {
      if (item.kind === 'file') add(item.getAsFile());
    }
  }
  return files;
}

document.addEventListener('paste', (e) => {
  const files = clipboardFiles(e);
  if (!files.length) return;
  const text = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
  if (!text) e.preventDefault();
  uploadFiles(files);
});

document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  if (e.target.closest('#dropzone') || e.target.closest('#templateBox')) return;
  if (e.dataTransfer && e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
});

/* ---------------- 课程封面模板事件 ---------------- */
document.querySelectorAll('input[name="tplMode"]').forEach((el) => {
  el.addEventListener('change', () => {
    const custom = tplMode() === 'custom';
    $('btnTplPick').hidden = !custom;
    $('tplMap').hidden = !custom || !tpl.data;
    $('previewFoot').textContent = custom
      ? '上方预览是内置版式示意；实际封面按你导入的课程模板生成'
      : '预览按本机字体渲染，最终以生成的 DOCX 为准';
  });
});
$('btnTplPick').onclick = () => $('tplInput').click();
$('tplInput').onchange = async () => {
  const f = $('tplInput').files[0];
  if (!f) return;
  try {
    await uploadCoverTemplate(f);
    const custom = document.querySelector('input[name="tplMode"][value="custom"]');
    if (custom) custom.checked = true;
    $('btnTplPick').hidden = false;
  } catch (e) {
    toast(`模板导入失败：${e.message}`, 4200);
  }
  $('tplInput').value = '';
};

/* ---------------- 自动复现事件 ---------------- */
$('rRunner').addEventListener('change', () => { fillDefaultSteps(); loadReplayEnv(); });
$('rFile').addEventListener('change', () => { rstate.stepsDirty = false; fillDefaultSteps(); });
$('rSteps').addEventListener('input', () => { rstate.stepsDirty = true; });
$('btnReplay').onclick = startReplay;
$('btnReplayStop').onclick = stopReplay;
$('btnTestShot').onclick = testShot;
$('btnReplayEnv').onclick = () => { loadReplayEnv(); toast('已刷新串口与软件探测结果'); };

$('btnRun').onclick = runTask;
$('btnPause').onclick = pauseRun;
$('btnResume').onclick = resumeTask;
$('btnEndPaused').onclick = endPaused;

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
  if ((state.running || rstate.running) && !confirm('还有任务在运行，确定退出吗？')) return;
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
  if (state.running || rstate.running) { e.preventDefault(); e.returnValue = ''; }
});

boot();
