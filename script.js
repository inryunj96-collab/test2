'use strict';

/* =========================================================
   지출 일기
   저장소: Supabase (Auth + Postgres, RLS로 사용자별 데이터 격리)
   ========================================================= */

// ----------------------- 상수 -----------------------
const SUPABASE_URL = 'https://masmhbaryqinyqpbobqn.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1hc21oYmFyeXFpbnlxcGJvYnFuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUwMTcyMDksImV4cCI6MjEwMDU5MzIwOX0.0xyi6lt35vLyciCWmGvUqjAvshYX2D-LDcntw-zNXdc';
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const WEEKDAY_LABELS = ['일', '월', '화', '수', '목', '금', '토'];

// ----------------------- 전역 상태 -----------------------
const state = {
  user: null,
  household: null,
  data: null,
  tab: 'dashboard',
  selectedDate: todayStr(),
  goalsSubtab: 'categories',
  dashboardView: 'calendar', // 'calendar' | 'detail'
  calendarMonth: todayStr().slice(0, 7), // 'YYYY-MM'
};

// ----------------------- 유틸 -----------------------
function uid() {
  return crypto.randomUUID();
}

function escapeHTML(str) {
  if (str == null) return '';
  return String(str).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function formatCurrency(n) {
  if (n == null || isNaN(n)) return '0원';
  return Number(n).toLocaleString('ko-KR') + '원';
}

function formatAmountInputValue(str) {
  const digits = String(str).replace(/[^\d]/g, '');
  return digits ? Number(digits).toLocaleString('ko-KR') : '';
}
function parseAmountInputValue(str) {
  const digits = String(str).replace(/[^\d]/g, '');
  return digits ? Number(digits) : NaN;
}
function bindAmountInput(input) {
  if (!input) return;
  input.addEventListener('focus', () => input.select());
  input.addEventListener('input', () => {
    const cursorFromEnd = input.value.length - input.selectionStart;
    input.value = formatAmountInputValue(input.value);
    const pos = Math.max(0, input.value.length - cursorFromEnd);
    input.setSelectionRange(pos, pos);
  });
}

function toDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function todayStr() {
  return toDateStr(new Date());
}

function addDays(dateStr, delta) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + delta);
  return toDateStr(d);
}

function weekdayOf(dateStr) {
  return new Date(dateStr + 'T00:00:00').getDay();
}

function dayOfMonthOf(dateStr) {
  return new Date(dateStr + 'T00:00:00').getDate();
}

function lastDayOfMonth(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
}

function formatDateLabel(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return `${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEKDAY_LABELS[d.getDay()]})`;
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => t.classList.add('hidden'), 2200);
}

// ----------------------- 데이터 계층 (Supabase) -----------------------
// DB row(snake_case) <-> 앱 state(camelCase) 매퍼
function categoryFromDb(row) {
  return { id: row.id, name: row.name, type: row.type, deletable: row.deletable, system: row.system };
}
function categoryToDb(c) {
  return { id: c.id, name: c.name, type: c.type, deletable: c.deletable, system: !!c.system, household_id: state.household.id };
}
function templateFromDb(row) {
  const t = {
    id: row.id, categoryId: row.category_id, memo: row.memo || '',
    expectedAmount: Number(row.expected_amount), repeatType: row.repeat_type,
    startDate: row.start_date, active: row.active,
  };
  if (row.weekdays) t.weekdays = row.weekdays;
  if (row.day_of_month != null) t.dayOfMonth = row.day_of_month;
  return t;
}
function templateToDb(t) {
  return {
    id: t.id, category_id: t.categoryId, memo: t.memo || '',
    expected_amount: t.expectedAmount, repeat_type: t.repeatType,
    start_date: t.startDate, active: t.active,
    weekdays: t.weekdays || null, day_of_month: t.dayOfMonth ?? null,
    household_id: state.household.id,
  };
}
function itemFromDb(row) {
  return {
    id: row.id, date: row.date, categoryId: row.category_id, memo: row.memo || '',
    expectedAmount: row.expected_amount != null ? Number(row.expected_amount) : null,
    actualAmount: row.actual_amount != null ? Number(row.actual_amount) : null,
    paymentMethod: row.payment_method, planned: row.planned,
    reasonText: row.reason_text || '', templateId: row.template_id,
  };
}
function itemToDb(it) {
  return {
    id: it.id, date: it.date, category_id: it.categoryId, memo: it.memo || '',
    expected_amount: it.expectedAmount, actual_amount: it.actualAmount,
    payment_method: it.paymentMethod, planned: it.planned,
    reason_text: it.reasonText || '', template_id: it.templateId,
    household_id: state.household.id,
  };
}
function assetFromDb(row) {
  return { id: row.id, name: row.name, amount: Number(row.amount), updatedAt: row.updated_at };
}
function assetToDb(a) {
  return { id: a.id, name: a.name, amount: a.amount, updated_at: a.updatedAt, household_id: state.household.id };
}

// insert/update/delete 헬퍼 — 각각 얇은 async 래퍼
function dbInsertCategory(cat) { return sb.from('categories').insert(categoryToDb(cat)); }
function dbDeleteCategory(id) { return sb.from('categories').delete().eq('id', id); }

function dbInsertTemplate(t) { return sb.from('repeat_templates').insert(templateToDb(t)); }
function dbUpdateTemplate(id, patch) {
  const dbPatch = {};
  if ('active' in patch) dbPatch.active = patch.active;
  return sb.from('repeat_templates').update(dbPatch).eq('id', id);
}
function dbDeleteTemplate(id) { return sb.from('repeat_templates').delete().eq('id', id); }

function dbInsertExpenseItem(it) { return sb.from('expense_items').insert(itemToDb(it)); }
function dbInsertExpenseItemsBatch(items) { return sb.from('expense_items').insert(items.map(itemToDb)); }
function dbUpdateExpenseItem(id, patch) {
  const dbPatch = {};
  if ('categoryId' in patch) dbPatch.category_id = patch.categoryId;
  if ('memo' in patch) dbPatch.memo = patch.memo;
  if ('expectedAmount' in patch) dbPatch.expected_amount = patch.expectedAmount;
  if ('actualAmount' in patch) dbPatch.actual_amount = patch.actualAmount;
  if ('paymentMethod' in patch) dbPatch.payment_method = patch.paymentMethod;
  if ('reasonText' in patch) dbPatch.reason_text = patch.reasonText;
  return sb.from('expense_items').update(dbPatch).eq('id', id);
}
function dbDeleteExpenseItem(id) { return sb.from('expense_items').delete().eq('id', id); }

function dbInsertAsset(a) { return sb.from('assets').insert(assetToDb(a)); }
function dbUpdateAsset(id, patch) {
  const dbPatch = {};
  if ('name' in patch) dbPatch.name = patch.name;
  if ('amount' in patch) dbPatch.amount = patch.amount;
  if ('updatedAt' in patch) dbPatch.updated_at = patch.updatedAt;
  return sb.from('assets').update(dbPatch).eq('id', id);
}
function dbDeleteAsset(id) { return sb.from('assets').delete().eq('id', id); }

// 화면은 이미 낙관적으로 갱신된 뒤 이 함수가 백그라운드로 서버에 반영한다.
// 실패하면 토스트로 알리고 서버 상태로 다시 동기화해서 어긋남을 막는다.
async function syncWrite(promiseFactory) {
  try {
    const { error } = await promiseFactory();
    if (error) throw error;
  } catch (err) {
    console.error(err);
    showToast('저장에 실패했어요. 다시 시도해주세요.');
    await resyncData();
  }
}

async function fetchAllData() {
  const [catRes, tplRes, itemRes, assetRes] = await Promise.all([
    sb.from('categories').select('*').order('created_at'),
    sb.from('repeat_templates').select('*').order('created_at'),
    sb.from('expense_items').select('*'),
    sb.from('assets').select('*').order('created_at'),
  ]);
  return {
    categories: (catRes.data || []).map(categoryFromDb),
    repeatTemplates: (tplRes.data || []).map(templateFromDb),
    expenseItems: (itemRes.data || []).map(itemFromDb),
    assets: (assetRes.data || []).map(assetFromDb),
  };
}

async function resyncData() {
  if (!state.user) return;
  state.data = await fetchAllData();
  renderTab(state.tab);
}

// ----------------------- 데이터 계층 (공유 가계부) -----------------------
async function fetchMyHousehold() {
  const { data, error } = await sb
    .from('household_members')
    .select('household_id, households(id, name)')
    .eq('user_id', state.user.id)
    .maybeSingle();
  if (error || !data) return null;
  return { id: data.households.id, name: data.households.name };
}

async function fetchHouseholdMembers(householdId) {
  const { data: members, error } = await sb
    .from('household_members')
    .select('user_id, role')
    .eq('household_id', householdId)
    .order('joined_at');
  if (error || !members) return [];
  const userIds = members.map((m) => m.user_id);
  const { data: profiles } = await sb.from('profiles').select('id, full_name, email').in('id', userIds);
  const profileById = new Map((profiles || []).map((p) => [p.id, p]));
  return members.map((m) => {
    const p = profileById.get(m.user_id);
    return {
      userId: m.user_id,
      role: m.role,
      name: p?.full_name || p?.email || '알 수 없음',
      email: p?.email || '',
    };
  });
}

async function fetchSentInvites(householdId) {
  const { data, error } = await sb
    .from('household_invites')
    .select('*')
    .eq('household_id', householdId)
    .eq('status', 'pending')
    .order('created_at');
  return error ? [] : (data || []);
}

async function fetchIncomingInvite(email) {
  const { data, error } = await sb
    .from('household_invites')
    .select('*, households(name)')
    .ilike('invited_email', email)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return error ? null : data;
}

function dbInsertInvite(householdId, email) {
  return sb.from('household_invites').insert({
    household_id: householdId, invited_email: email.toLowerCase(), invited_by: state.user.id,
  });
}
function dbUpdateInviteStatus(id, status) {
  return sb.from('household_invites').update({ status, responded_at: new Date().toISOString() }).eq('id', id);
}
function dbInsertHouseholdMember(householdId) {
  return sb.from('household_members').insert({ household_id: householdId, user_id: state.user.id, role: 'member' });
}
function dbDeleteHouseholdMember(householdId, userId) {
  return sb.from('household_members').delete().eq('household_id', householdId).eq('user_id', userId);
}

// ----------------------- 인증 (Supabase Auth) -----------------------
let currentAuthUserId = null; // enterApp 중복 실행 방지 가드

sb.auth.onAuthStateChange((_event, session) => {
  if (session && session.user) {
    if (currentAuthUserId === session.user.id && state.data) return;
    currentAuthUserId = session.user.id;
    enterApp(session.user);
  } else {
    currentAuthUserId = null;
    state.user = null;
    state.data = null;
    showAuthScreen();
  }
});

function showAuthScreen() {
  document.getElementById('boot-loading').classList.add('hidden');
  document.getElementById('auth-screen').classList.remove('hidden');
  document.getElementById('main-screen').classList.add('hidden');
}

function displayNameOf(user) {
  return user.user_metadata?.full_name || user.user_metadata?.name || user.email;
}

async function enterApp(user) {
  state.user = { id: user.id, email: user.email };
  state.household = await fetchMyHousehold();
  document.getElementById('header-username').textContent = displayNameOf(user);

  const incomingInvite = await fetchIncomingInvite(user.email);
  if (incomingInvite) openIncomingInviteModal(incomingInvite);

  state.data = await fetchAllData();
  document.getElementById('boot-loading').classList.add('hidden');
  document.getElementById('auth-screen').classList.add('hidden');
  document.getElementById('main-screen').classList.remove('hidden');
  switchTab('dashboard');
}

function mapAuthError(error) {
  const msg = error && error.message || '';
  if (msg.includes('already registered')) return '이미 가입된 이메일입니다.';
  if (msg.includes('Password should be')) return '비밀번호는 6자 이상이어야 합니다.';
  if (msg.includes('Invalid login credentials')) return '이메일 또는 비밀번호가 올바르지 않습니다.';
  return '오류가 발생했습니다. 잠시 후 다시 시도해주세요.';
}

async function handleSignup(e) {
  e.preventDefault();
  const email = document.getElementById('signup-email').value.trim().toLowerCase();
  const pw = document.getElementById('signup-password').value;
  const pw2 = document.getElementById('signup-password2').value;
  const errorEl = document.getElementById('signup-error');
  const submitBtn = e.target.querySelector('button[type="submit"]');
  errorEl.textContent = '';

  if (pw.length < 6) { errorEl.textContent = '비밀번호는 6자 이상이어야 합니다.'; return; }
  if (pw !== pw2) { errorEl.textContent = '비밀번호가 일치하지 않습니다.'; return; }

  submitBtn.disabled = true;
  const { data, error } = await sb.auth.signUp({ email, password: pw });
  submitBtn.disabled = false;

  if (error) { errorEl.textContent = mapAuthError(error); return; }
  if (!data.session) {
    errorEl.textContent = '가입 확인 메일을 보냈습니다. 메일함에서 링크를 눌러 인증을 완료해주세요.';
    return;
  }
  document.getElementById('signup-form').reset();
  showToast('회원가입이 완료되었습니다. 환영해요! 🌱');
  // 세션이 생기면 onAuthStateChange가 자동으로 enterApp을 실행함
}

async function handleLogin(e) {
  e.preventDefault();
  const email = document.getElementById('login-email').value.trim().toLowerCase();
  const pw = document.getElementById('login-password').value;
  const errorEl = document.getElementById('login-error');
  const submitBtn = e.target.querySelector('button[type="submit"]');
  errorEl.textContent = '';

  submitBtn.disabled = true;
  const { error } = await sb.auth.signInWithPassword({ email, password: pw });
  submitBtn.disabled = false;

  if (error) { errorEl.textContent = mapAuthError(error); return; }
  document.getElementById('login-form').reset();
}

async function handleLogout() {
  await sb.auth.signOut();
}

async function handleGoogleLogin() {
  await sb.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin + window.location.pathname },
  });
}

// ----------------------- 탭 전환 -----------------------
function switchTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.tab-content').forEach((el) => el.classList.add('hidden'));
  document.getElementById('tab-' + tab).classList.remove('hidden');
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  renderTab(tab);
}
function renderTab(tab) {
  if (tab === 'dashboard') renderDashboard();
  else if (tab === 'goals') renderGoals();
  else if (tab === 'assets') renderAssets();
}

// ----------------------- 날짜 네비게이터 (공통) -----------------------
function dateNavHTML() {
  return `
    <div class="date-nav">
      <button type="button" class="date-nav-arrow date-prev">‹</button>
      <input type="date" class="date-input" value="${state.selectedDate}" />
      <button type="button" class="date-nav-arrow date-next">›</button>
      <button type="button" class="btn btn-outline btn-sm today-btn">오늘</button>
    </div>`;
}
function bindDateNav(container) {
  container.querySelector('.date-prev').onclick = () => { state.selectedDate = addDays(state.selectedDate, -1); renderTab(state.tab); };
  container.querySelector('.date-next').onclick = () => { state.selectedDate = addDays(state.selectedDate, 1); renderTab(state.tab); };
  container.querySelector('.today-btn').onclick = () => { state.selectedDate = todayStr(); renderTab(state.tab); };
  container.querySelector('.date-input').onchange = (e) => { state.selectedDate = e.target.value; renderTab(state.tab); };
}

// ----------------------- 카테고리 헬퍼 -----------------------
function getCategory(id) { return state.data.categories.find((c) => c.id === id); }
function plannedExpenseCategories() { return state.data.categories.filter((c) => c.type === 'expense' && !c.system); }
function allExpenseCategories() { return state.data.categories.filter((c) => c.type === 'expense'); }
function categoryOptionsHTML(cats, selectedId) {
  return cats.map((c) => `<option value="${c.id}" ${c.id === selectedId ? 'selected' : ''}>${escapeHTML(c.name)}</option>`).join('');
}

// 지출 등록 화면 안에서 바로 카테고리를 추가/삭제할 수 있는 인라인 패널
function inlineCategoryManagerHTML(prefix) {
  return `
    <button type="button" class="btn-link inline-cat-toggle" id="${prefix}-cat-toggle">+ 카테고리 추가/관리</button>
    <div class="inline-cat-panel hidden" id="${prefix}-cat-panel">
      <div class="category-chip-list" id="${prefix}-cat-chip-list">${renderCategoryChips('expense')}</div>
      <div class="field-row" id="${prefix}-cat-add-row">
        <label class="field" style="margin-bottom:0;"><input type="text" id="${prefix}-cat-add-input" placeholder="새 카테고리 이름" /></label>
        <button type="button" class="btn btn-primary btn-sm" id="${prefix}-cat-add-btn">추가</button>
      </div>
    </div>
  `;
}
function bindInlineCategoryManager(box, prefix, selectEl, getSelectCats) {
  const toggleBtn = box.querySelector(`#${prefix}-cat-toggle`);
  const panel = box.querySelector(`#${prefix}-cat-panel`);
  const chipList = box.querySelector(`#${prefix}-cat-chip-list`);
  const addBtn = box.querySelector(`#${prefix}-cat-add-btn`);
  const input = box.querySelector(`#${prefix}-cat-add-input`);

  toggleBtn.addEventListener('click', () => {
    panel.classList.toggle('hidden');
    if (!panel.classList.contains('hidden')) input.focus();
  });

  function bindChipDeletes() {
    chipList.querySelectorAll('.delete-cat-btn').forEach((b) => {
      b.addEventListener('click', () => {
        const id = b.dataset.id;
        const usedCount = state.data.expenseItems.filter((i) => i.categoryId === id).length
          + state.data.repeatTemplates.filter((t) => t.categoryId === id).length;
        if (usedCount > 0 && !confirm(`이 카테고리를 사용하는 항목이 ${usedCount}개 있습니다. 그래도 삭제할까요?`)) return;
        state.data.categories = state.data.categories.filter((c) => c.id !== id);
        chipList.innerHTML = renderCategoryChips('expense');
        bindChipDeletes();
        selectEl.innerHTML = categoryOptionsHTML(getSelectCats());
        showToast('카테고리가 삭제되었습니다.');
        syncWrite(() => dbDeleteCategory(id));
      });
    });
  }
  bindChipDeletes();

  function handleAdd() {
    const name = input.value.trim();
    if (!name) return;
    const newCat = { id: uid(), name, type: 'expense', deletable: true };
    state.data.categories.push(newCat);
    chipList.innerHTML = renderCategoryChips('expense');
    bindChipDeletes();
    selectEl.innerHTML = categoryOptionsHTML(getSelectCats(), newCat.id);
    input.value = '';
    showToast('카테고리가 추가되었습니다.');
    syncWrite(() => dbInsertCategory(newCat));
  }
  addBtn.addEventListener('click', handleAdd);
  // this input lives inside the modal's outer <form>, so Enter must not trigger that form's submit
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); handleAdd(); }
  });
}

// ----------------------- 반복 지출 → 일 단위 항목 생성 -----------------------
function materializeDate(dateStr) {
  const data = state.data;
  const newItems = [];
  data.repeatTemplates.forEach((t) => {
    if (!t.active || dateStr < t.startDate) return;
    let matches = false;
    if (t.repeatType === 'daily') matches = true;
    else if (t.repeatType === 'weekly') matches = (t.weekdays || []).includes(weekdayOf(dateStr));
    else if (t.repeatType === 'monthly') {
      const targetDom = Math.min(t.dayOfMonth, lastDayOfMonth(dateStr));
      matches = dayOfMonthOf(dateStr) === targetDom;
    }
    if (!matches) return;
    const exists = data.expenseItems.some((it) => it.templateId === t.id && it.date === dateStr);
    if (!exists) {
      const newItem = {
        id: uid(), date: dateStr, categoryId: t.categoryId, memo: t.memo || '', expectedAmount: t.expectedAmount,
        actualAmount: null, paymentMethod: null, planned: true, reasonText: '', templateId: t.id,
      };
      data.expenseItems.push(newItem);
      newItems.push(newItem);
    }
  });
  if (newItems.length) syncWrite(() => dbInsertExpenseItemsBatch(newItems));
}
function getItemsForDate(dateStr) {
  materializeDate(dateStr);
  return state.data.expenseItems
    .filter((it) => it.date === dateStr)
    .sort((a, b) => (a.planned === b.planned ? 0 : a.planned ? -1 : 1));
}
function updateExpenseItem(id, patch) {
  const it = state.data.expenseItems.find((i) => i.id === id);
  if (!it) return;
  Object.assign(it, patch);
  syncWrite(() => dbUpdateExpenseItem(id, patch));
}
function deleteExpenseItem(id) {
  state.data.expenseItems = state.data.expenseItems.filter((i) => i.id !== id);
  syncWrite(() => dbDeleteExpenseItem(id));
}

// ----------------------- 모달 -----------------------
function openModal(title, bodyHTML) {
  const root = document.getElementById('modal-root');
  root.innerHTML = `
    <div class="modal-backdrop">
      <div class="modal-box">
        <div class="modal-head"><h3>${escapeHTML(title)}</h3><button type="button" class="modal-close">✕</button></div>
        ${bodyHTML}
      </div>
    </div>`;
  root.querySelector('.modal-close').onclick = closeModal;
  root.querySelector('.modal-backdrop').addEventListener('click', (e) => {
    if (e.target.classList.contains('modal-backdrop')) closeModal();
  });
  return root.querySelector('.modal-box');
}
function closeModal() {
  document.getElementById('modal-root').innerHTML = '';
}

// ----------------------- 함께 쓰기 (가계부 멤버/초대) -----------------------
function openIncomingInviteModal(invite) {
  const box = openModal('초대가 도착했어요', `
    <p class="household-name">'${escapeHTML(invite.households?.name || '가계부')}'에 초대되었습니다.<br/>수락하면 그 가계부의 지출 내역을 함께 조회·관리할 수 있어요.</p>
    <p class="list-item-sub">단, 수락하면 현재 보고 있는 나만의 가계부는 더 이상 화면에 표시되지 않아요.</p>
    <div class="modal-actions">
      <button type="button" class="btn btn-outline" id="invite-decline">거절</button>
      <button type="button" class="btn btn-primary" id="invite-accept">수락</button>
    </div>
  `);
  box.querySelector('#invite-decline').onclick = async () => {
    await dbUpdateInviteStatus(invite.id, 'declined');
    closeModal();
  };
  box.querySelector('#invite-accept').onclick = async () => {
    const oldHouseholdId = state.household?.id;
    const { error: joinError } = await dbInsertHouseholdMember(invite.household_id);
    if (joinError) { showToast('초대 수락에 실패했어요. 다시 시도해주세요.'); return; }
    await dbUpdateInviteStatus(invite.id, 'accepted');
    if (oldHouseholdId && oldHouseholdId !== invite.household_id) {
      await dbDeleteHouseholdMember(oldHouseholdId, state.user.id);
    }
    closeModal();
    showToast('가계부에 합류했습니다! 🎉');
    state.household = await fetchMyHousehold();
    await resyncData();
  };
}

async function openHouseholdModal() {
  if (!state.household) {
    showToast('가계부 정보를 불러오지 못했어요. 새로고침 후 다시 시도해주세요.');
    return;
  }
  const householdId = state.household.id;
  const box = openModal('함께 쓰기', `
    <p class="household-name">${escapeHTML(state.household.name)}</p>
    <div class="section-subtitle">멤버</div>
    <div id="member-list"><p class="empty-state">불러오는 중...</p></div>
    <div class="section-subtitle">친구 초대</div>
    <p class="list-item-sub" style="margin:-2px 0 8px;">별도의 메일은 발송되지 않아요. 초대 후 친구에게 이 이메일로 로그인/가입해달라고 직접 알려주세요.</p>
    <form class="field-row" id="invite-form">
      <label class="field" style="margin-bottom:0;"><input type="email" id="invite-email" placeholder="친구 이메일" required /></label>
      <button type="submit" class="btn btn-primary btn-sm" style="align-self:flex-end;">초대</button>
    </form>
    <p class="form-error" id="invite-error"></p>
    <div class="section-subtitle">보낸 초대</div>
    <div id="sent-invite-list"><p class="empty-state">불러오는 중...</p></div>
  `);

  async function refreshMembers() {
    const members = await fetchHouseholdMembers(householdId);
    box.querySelector('#member-list').innerHTML = members.map((m) => `
      <div class="member-row" data-user-id="${m.userId}">
        <div class="member-info">
          <span class="member-name">${escapeHTML(m.name)} ${m.userId === state.user.id ? '<span class="pill pill-neutral">나</span>' : ''} ${m.role === 'owner' ? '<span class="pill pill-mint">소유자</span>' : ''}</span>
          <span class="member-email">${escapeHTML(m.email)}</span>
        </div>
        ${m.userId === state.user.id
          ? (m.role !== 'owner' ? '<button type="button" class="btn-link leave-household-btn">나가기</button>' : '')
          : '<button type="button" class="btn-link remove-member-btn" data-user-id="' + m.userId + '">내보내기</button>'}
      </div>
    `).join('');

    box.querySelector('.leave-household-btn')?.addEventListener('click', async () => {
      if (!confirm('이 가계부에서 나갈까요?')) return;
      await dbDeleteHouseholdMember(householdId, state.user.id);
      closeModal();
      showToast('가계부에서 나갔습니다.');
      window.location.reload();
    });
    box.querySelectorAll('.remove-member-btn').forEach((b) => {
      b.addEventListener('click', async () => {
        if (!confirm('이 멤버를 내보낼까요?')) return;
        await dbDeleteHouseholdMember(householdId, b.dataset.userId);
        refreshMembers();
        showToast('멤버를 내보냈습니다.');
      });
    });
  }

  async function refreshSentInvites() {
    const invites = await fetchSentInvites(householdId);
    box.querySelector('#sent-invite-list').innerHTML = invites.length
      ? invites.map((inv) => `
        <div class="invite-row" data-id="${inv.id}">
          <span class="invite-email">${escapeHTML(inv.invited_email)}</span>
          <span class="invite-status">대기중 <button type="button" class="btn-link cancel-invite-btn" data-id="${inv.id}">취소</button></span>
        </div>
      `).join('')
      : '<p class="empty-state">보낸 초대가 없습니다.</p>';

    box.querySelectorAll('.cancel-invite-btn').forEach((b) => {
      b.addEventListener('click', async () => {
        await dbUpdateInviteStatus(b.dataset.id, 'declined');
        refreshSentInvites();
        showToast('초대를 취소했습니다.');
      });
    });
  }

  refreshMembers();
  refreshSentInvites();

  box.querySelector('#invite-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = box.querySelector('#invite-email');
    const errorEl = box.querySelector('#invite-error');
    const email = input.value.trim().toLowerCase();
    errorEl.textContent = '';
    if (email === state.user.email.toLowerCase()) { errorEl.textContent = '본인은 초대할 수 없어요.'; return; }
    const { error } = await dbInsertInvite(householdId, email);
    if (error) { errorEl.textContent = '초대에 실패했어요. 다시 시도해주세요.'; return; }
    input.value = '';
    showToast('초대를 보냈습니다. 친구에게 이 이메일로 로그인/가입해달라고 알려주세요.');
    refreshSentInvites();
  });
}

// =========================================================
//  대시보드 (캘린더 뷰 / 일별 상세 뷰)
// =========================================================
function renderDashboard() {
  const el = document.getElementById('tab-dashboard');
  if (state.dashboardView === 'detail') renderDayDetail(el);
  else renderCalendarView(el);
}

function formatCompact(n) {
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (!abs) return '0';
  if (abs >= 10000) {
    const man = abs / 10000;
    return sign + (Number.isInteger(man) ? man : man.toFixed(1)) + '만';
  }
  if (abs >= 1000) {
    const cheon = abs / 1000;
    return sign + (Number.isInteger(cheon) ? cheon : cheon.toFixed(1)) + '천';
  }
  return sign + abs.toLocaleString('ko-KR');
}

function shiftMonth(yearMonth, delta) {
  let [y, m] = yearMonth.split('-').map(Number);
  m += delta;
  if (m < 1) { m = 12; y -= 1; } else if (m > 12) { m = 1; y += 1; }
  return `${y}-${String(m).padStart(2, '0')}`;
}

function monthInfo(yearMonth) {
  const [y, m] = yearMonth.split('-').map(Number);
  const firstWeekday = new Date(y, m - 1, 1).getDay();
  const daysInMonth = new Date(y, m, 0).getDate();
  return { y, m, firstWeekday, daysInMonth };
}

function materializeMonth(yearMonth) {
  const { y, m, daysInMonth } = monthInfo(yearMonth);
  for (let d = 1; d <= daysInMonth; d++) {
    materializeDate(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  }
}

function getDayAggregate(dateStr) {
  const items = state.data.expenseItems.filter((it) => it.date === dateStr);
  const expected = items.reduce((s, i) => s + (i.expectedAmount || 0), 0);
  const actual = items.reduce((s, i) => s + (i.actualAmount != null ? i.actualAmount : 0), 0);
  return { expected, actual, over: actual - expected, hasItems: items.length > 0 };
}

function renderCalendarView(el) {
  materializeMonth(state.calendarMonth);
  const { y, m, firstWeekday, daysInMonth } = monthInfo(state.calendarMonth);
  const todayS = todayStr();

  let monthExpected = 0;
  let monthActual = 0;
  const cells = [];
  for (let i = 0; i < firstWeekday; i++) cells.push('<div class="cal-cell empty"></div>');
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const agg = getDayAggregate(dateStr);
    monthExpected += agg.expected;
    monthActual += agg.actual;

    let statusClass = '';
    let amtHTML = '';
    if (agg.expected > 0 && agg.actual > 0) {
      const diff = agg.actual - agg.expected;
      statusClass = diff > 0 ? 'cal-over' : diff < 0 ? 'cal-good' : 'cal-even';
      const diffClass = diff > 0 ? 'cal-diff-over' : diff < 0 ? 'cal-diff-good' : 'cal-diff-even';
      const diffLabel = diff > 0 ? `+${formatCompact(diff)}` : diff < 0 ? `-${formatCompact(-diff)}` : '±0';
      amtHTML = `
        <span class="cal-line">${formatCompact(agg.expected)}<span class="cal-arrow">→</span>${formatCompact(agg.actual)}</span>
        <span class="cal-diff ${diffClass}">${diffLabel}</span>
      `;
    } else if (agg.expected > 0) {
      statusClass = 'cal-planned';
      amtHTML = `<span class="cal-line cal-line-planned">예 ${formatCompact(agg.expected)}</span>`;
    } else if (agg.actual > 0) {
      statusClass = 'cal-actual-only';
      amtHTML = `<span class="cal-line cal-line-actual-only">실 ${formatCompact(agg.actual)}</span>`;
    }

    cells.push(`
      <button type="button" class="cal-cell ${statusClass}" data-date="${dateStr}">
        <span class="cal-daynum ${dateStr === todayS ? 'cal-daynum-today' : ''}">${d}</span>
        ${amtHTML}
      </button>
    `);
  }

  const monthDiff = monthExpected - monthActual;

  el.innerHTML = `
    <div class="card">
      <div class="month-nav">
        <button type="button" class="date-nav-arrow" id="month-prev">‹</button>
        <div class="month-nav-label">${y}년 ${m}월</div>
        <button type="button" class="date-nav-arrow" id="month-next">›</button>
        <button type="button" class="btn btn-outline btn-sm" id="month-today-btn">이번달</button>
      </div>
      <div class="month-summary">
        이달 예상 ${formatCurrency(monthExpected)} · 실제 ${formatCurrency(monthActual)}
        <span class="${monthDiff >= 0 ? 'month-good' : 'month-over'}">
          (${monthDiff >= 0 ? formatCurrency(monthDiff) + ' 절약' : formatCurrency(Math.abs(monthDiff)) + ' 초과'})
        </span>
      </div>
      <div class="cal-weekday-row">${WEEKDAY_LABELS.map((w) => `<span>${w}</span>`).join('')}</div>
      <div class="cal-grid">${cells.join('')}</div>
      <div class="cal-legend">
        <span><i class="dot dot-planned"></i>계획만 있음</span>
        <span><i class="dot dot-good"></i>예산 이내</span>
        <span><i class="dot dot-over"></i>초과</span>
      </div>
      <p class="list-item-sub" style="text-align:center; margin-top:10px;">날짜를 눌러 하루 상세 내역을 확인하세요.</p>
    </div>
  `;

  el.querySelector('#month-prev').onclick = () => { state.calendarMonth = shiftMonth(state.calendarMonth, -1); renderDashboard(); };
  el.querySelector('#month-next').onclick = () => { state.calendarMonth = shiftMonth(state.calendarMonth, 1); renderDashboard(); };
  el.querySelector('#month-today-btn').onclick = () => { state.calendarMonth = todayStr().slice(0, 7); renderDashboard(); };
  el.querySelectorAll('.cal-cell[data-date]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.selectedDate = btn.dataset.date;
      state.dashboardView = 'detail';
      renderDashboard();
    });
  });
}

function renderDayDetail(el) {
  const items = getItemsForDate(state.selectedDate);
  const expectedTotal = items.reduce((s, i) => s + (i.expectedAmount || 0), 0);
  const actualTotal = items.reduce((s, i) => s + (i.actualAmount != null ? i.actualAmount : 0), 0);
  const diff = expectedTotal - actualTotal;
  const overItems = items.filter((i) => i.actualAmount != null && i.expectedAmount != null && i.actualAmount > i.expectedAmount);
  const pct = expectedTotal > 0 ? Math.round((actualTotal / expectedTotal) * 100) : (actualTotal > 0 ? 100 : 0);

  el.innerHTML = `
    <div class="card">
      <button type="button" class="btn-link" id="back-to-calendar">← 캘린더로</button>
      ${dateNavHTML()}
      <div class="section-title" style="margin-top:0;">${formatDateLabel(state.selectedDate)} 요약</div>
      <div class="summary-grid">
        <div class="summary-tile tile-expected"><div class="tile-label">예상 지출</div><div class="tile-value">${formatCurrency(expectedTotal)}</div></div>
        <div class="summary-tile tile-actual"><div class="tile-label">실제 지출</div><div class="tile-value">${formatCurrency(actualTotal)}</div></div>
        <div class="summary-tile ${diff >= 0 ? 'diff-good' : 'diff-bad'}" style="grid-column: span 2;">
          <div class="tile-label">${diff >= 0 ? '절약 금액' : '초과 금액'}</div>
          <div class="tile-value">${formatCurrency(Math.abs(diff))}</div>
        </div>
      </div>
      <div class="progress-bar-track"><div class="progress-bar-fill ${pct > 100 ? 'over' : ''}" style="width:${Math.min(pct, 100)}%;"></div></div>
      <div class="list-item-sub" style="margin-top:6px;">예상 대비 ${pct}% 지출</div>
    </div>

    <div class="day-detail-wrap">
      <div class="card">
        <div class="card-title">${formatDateLabel(state.selectedDate)} 지출 내역 ${overItems.length ? `<span class="pill pill-danger">${overItems.length}건 초과</span>` : ''}</div>
        <div class="action-row">
          <button type="button" class="btn btn-primary btn-block" id="add-expense-btn">+ 예정 지출 등록</button>
        </div>
        <div id="expense-item-list">
          ${items.length ? items.map(renderExpenseItemCard).join('') : '<p class="empty-state">등록된 지출 내역이 없습니다.<br/>위 버튼으로 이 날의 지출을 등록해보세요.</p>'}
        </div>
      </div>
      <button type="button" class="fab-unplanned-btn" id="add-unplanned-fab" title="계획 외 지출 등록">
        <span class="fab-icon">＋</span><span>계획 외</span>
      </button>
    </div>
  `;
  el.querySelector('#back-to-calendar').onclick = () => { state.dashboardView = 'calendar'; renderDashboard(); };
  bindDateNav(el);
  el.querySelector('#add-expense-btn').onclick = () => openExpenseRegisterModal();
  el.querySelector('#add-unplanned-fab').onclick = () => openUnplannedExpenseModal();
  bindExpenseItemCards(el);
}

// =========================================================
//  지출 내역 카드 (할일 체크리스트 형태)
// =========================================================
function renderExpenseItemCard(item) {
  const cat = getCategory(item.categoryId);
  const checked = item.actualAmount != null;
  const hasExpected = item.expectedAmount != null;
  const diff = checked && hasExpected ? item.actualAmount - item.expectedAmount : null;
  const isOver = diff != null && diff > 0;
  const classes = ['expense-item-card'];
  if (checked) classes.push('checked');
  if (!item.planned) classes.push('unplanned');
  if (isOver) classes.push('over-budget');

  const catName = cat ? cat.name : '삭제된 카테고리';

  let statusHTML = '';
  if (diff != null) {
    if (diff > 0) statusHTML = `<span class="compare-status status-over">초과 +${formatCurrency(diff)}</span>`;
    else if (diff < 0) statusHTML = `<span class="compare-status status-good">절약 ${formatCurrency(-diff)}</span>`;
    else statusHTML = `<span class="compare-status status-even">예산대로</span>`;
  }

  return `
    <div class="${classes.join(' ')}" data-id="${item.id}">
      <div class="expense-item-row">
        <label class="expense-item-check">
          <input type="checkbox" class="item-check-input" data-id="${item.id}" ${checked ? 'checked' : ''} />
          <span class="expense-item-cat">
            ${item.memo ? escapeHTML(item.memo) : escapeHTML(catName)}
            ${item.memo ? `<span class="pill pill-neutral">${escapeHTML(catName)}</span>` : ''}
            ${!item.planned ? '<span class="pill pill-lavender">계획 외</span>' : ''}
            ${item.templateId ? '<span class="pill pill-neutral">🔁</span>' : ''}
          </span>
        </label>
        <div class="expense-item-actions">
          <button type="button" class="icon-btn icon-btn-sm edit-item-btn" data-id="${item.id}">✎</button>
          <button type="button" class="icon-btn icon-btn-sm delete-item-btn" data-id="${item.id}">🗑</button>
        </div>
      </div>
      <div class="expense-item-compare">
        ${hasExpected ? `
          <span class="compare-seg">
            <span class="compare-label">예상</span>
            <span class="compare-value">${formatCurrency(item.expectedAmount)}</span>
          </span>
        ` : ''}
        ${checked ? `
          ${hasExpected ? '<span class="compare-arrow">→</span>' : ''}
          <span class="compare-seg">
            <span class="compare-label">실제</span>
            <input type="text" inputmode="numeric" class="actual-amount-input" data-id="${item.id}" value="${formatAmountInputValue(String(item.actualAmount))}" />
          </span>
          ${statusHTML}
          <select class="payment-method-input" data-id="${item.id}">
            <option value="" ${!item.paymentMethod ? 'selected' : ''} disabled>결제수단</option>
            <option value="card" ${item.paymentMethod === 'card' ? 'selected' : ''}>카드</option>
            <option value="cash" ${item.paymentMethod === 'cash' ? 'selected' : ''}>현금</option>
            <option value="transfer" ${item.paymentMethod === 'transfer' ? 'selected' : ''}>이체</option>
            <option value="etc" ${item.paymentMethod === 'etc' ? 'selected' : ''}>기타</option>
          </select>
          <button type="button" class="complete-item-btn" data-id="${item.id}">완료</button>
        ` : ''}
      </div>
      ${(isOver || !item.planned) ? `
        <div class="expense-item-reason-row">
          <span class="reason-icon">${isOver ? '⚠️' : '📝'}</span>
          <input type="text" class="reason-input" data-id="${item.id}" placeholder="${isOver ? '초과 사유를 적어주세요' : '계획 외 지출 사유를 적어주세요'}" value="${escapeHTML(item.reasonText || '')}" />
        </div>` : ''}
    </div>`;
}

function bindExpenseItemCards(container) {
  container.querySelectorAll('.item-check-input').forEach((cb) => {
    cb.addEventListener('change', (e) => {
      const id = e.target.dataset.id;
      if (e.target.checked) {
        const item = state.data.expenseItems.find((i) => i.id === id);
        updateExpenseItem(id, { actualAmount: item && item.expectedAmount != null ? item.expectedAmount : 0 });
      } else {
        updateExpenseItem(id, { actualAmount: null, reasonText: '' });
      }
      renderDashboard();
    });
  });
  container.querySelectorAll('.actual-amount-input').forEach((inp) => {
    bindAmountInput(inp);
    inp.addEventListener('change', (e) => {
      const parsed = parseAmountInputValue(e.target.value);
      updateExpenseItem(e.target.dataset.id, { actualAmount: isNaN(parsed) ? null : parsed });
      renderDashboard();
    });
  });
  container.querySelectorAll('.payment-method-input').forEach((sel) => {
    sel.addEventListener('change', (e) => {
      updateExpenseItem(e.target.dataset.id, { paymentMethod: e.target.value });
      renderDashboard();
    });
  });
  container.querySelectorAll('.reason-input').forEach((ta) => {
    ta.addEventListener('change', (e) => updateExpenseItem(e.target.dataset.id, { reasonText: e.target.value }));
  });
  container.querySelectorAll('.complete-item-btn').forEach((b) => {
    // prevent the amount/payment fields from blurring (and re-rendering) before the click fires
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', (e) => {
      const id = e.currentTarget.dataset.id;
      const card = e.currentTarget.closest('.expense-item-card');
      const parsed = parseAmountInputValue(card.querySelector('.actual-amount-input').value);
      if (isNaN(parsed)) { showToast('실제 금액을 입력해주세요.'); return; }
      const patch = {
        actualAmount: parsed,
        paymentMethod: card.querySelector('.payment-method-input').value || null,
      };
      const reasonInput = card.querySelector('.reason-input');
      if (reasonInput) patch.reasonText = reasonInput.value.trim();
      updateExpenseItem(id, patch);
      renderDashboard();
      showToast('저장되었습니다.');
    });
  });
  container.querySelectorAll('.edit-item-btn').forEach((b) => {
    b.addEventListener('click', (e) => openEditItemModal(e.currentTarget.dataset.id));
  });
  container.querySelectorAll('.delete-item-btn').forEach((b) => {
    b.addEventListener('click', (e) => {
      if (confirm('이 항목을 삭제할까요?')) {
        deleteExpenseItem(e.currentTarget.dataset.id);
        renderDashboard();
      }
    });
  });
}

function repeatFieldsHTML() {
  return `
    <div class="field"><span>반복 설정</span>
      <div class="radio-group" id="pi-repeat-group">
        <label><input type="radio" name="pi-repeat" value="none" checked /><span>반복 없음</span></label>
        <label><input type="radio" name="pi-repeat" value="daily" /><span>매일</span></label>
        <label><input type="radio" name="pi-repeat" value="weekly" /><span>매주</span></label>
        <label><input type="radio" name="pi-repeat" value="monthly" /><span>매월</span></label>
      </div>
    </div>
    <div class="field hidden" id="pi-weekly-detail"><span>반복 요일</span>
      <div class="weekday-picker">
        ${WEEKDAY_LABELS.map((w, i) => `<label><input type="checkbox" class="pi-weekday" value="${i}" /><span>${w}</span></label>`).join('')}
      </div>
    </div>
    <div class="field hidden" id="pi-monthly-detail"><span>매월 반복 일자</span>
      <input type="number" id="pi-day-of-month" min="1" max="31" value="1" />
    </div>`;
}
function bindRepeatFields(box, dateInputSelector) {
  const radios = box.querySelectorAll('input[name="pi-repeat"]');
  const weeklyDetail = box.querySelector('#pi-weekly-detail');
  const monthlyDetail = box.querySelector('#pi-monthly-detail');
  radios.forEach((r) => r.addEventListener('change', () => {
    weeklyDetail.classList.toggle('hidden', r.value !== 'weekly' || !r.checked);
    if (r.checked && r.value === 'monthly') {
      monthlyDetail.classList.remove('hidden');
      const dateVal = box.querySelector(dateInputSelector)?.value;
      if (dateVal) box.querySelector('#pi-day-of-month').value = dayOfMonthOf(dateVal);
    } else if (r.checked) {
      monthlyDetail.classList.add('hidden');
    }
  }));
}

function openExpenseRegisterModal() {
  const box = openModal('예정 지출 등록', `
    <form id="expense-register-form">
      <label class="field"><span>날짜</span><input type="date" id="pi-date" value="${state.selectedDate}" required /></label>
      <label class="field"><span>카테고리</span><select id="pi-category">${categoryOptionsHTML(plannedExpenseCategories())}</select></label>
      ${inlineCategoryManagerHTML('pi')}
      <label class="field"><span>지출 내용 (선택)</span><input type="text" id="pi-memo" placeholder="예: 팀 회식" /></label>
      <label class="field"><span>예상 금액</span><input type="text" inputmode="numeric" id="pi-amount" required placeholder="예: 15,000" /></label>
      ${repeatFieldsHTML()}
      <p class="form-error" id="pi-error"></p>
      <div class="modal-actions">
        <button type="button" class="btn btn-outline" id="pi-cancel">취소</button>
        <button type="submit" class="btn btn-primary">등록</button>
      </div>
    </form>
  `);
  bindInlineCategoryManager(box, 'pi', box.querySelector('#pi-category'), plannedExpenseCategories);
  bindRepeatFields(box, '#pi-date');
  bindAmountInput(box.querySelector('#pi-amount'));
  box.querySelector('#pi-cancel').onclick = closeModal;
  box.querySelector('#expense-register-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const date = box.querySelector('#pi-date').value;
    const categoryId = box.querySelector('#pi-category').value;
    const memo = box.querySelector('#pi-memo').value.trim();
    const amount = parseAmountInputValue(box.querySelector('#pi-amount').value);
    const repeatType = box.querySelector('input[name="pi-repeat"]:checked').value;
    const errorEl = box.querySelector('#pi-error');

    if (!amount || amount <= 0) { errorEl.textContent = '예상 금액을 올바르게 입력해주세요.'; return; }

    let syncFn;
    if (repeatType === 'none') {
      const newItem = {
        id: uid(), date, categoryId, memo, expectedAmount: amount, actualAmount: null,
        paymentMethod: null, planned: true, reasonText: '', templateId: null,
      };
      state.data.expenseItems.push(newItem);
      syncFn = () => dbInsertExpenseItem(newItem);
    } else {
      const template = {
        id: uid(), categoryId, memo, expectedAmount: amount,
        repeatType, startDate: date, active: true,
      };
      if (repeatType === 'weekly') {
        const weekdays = Array.from(box.querySelectorAll('.pi-weekday:checked')).map((c) => Number(c.value));
        if (!weekdays.length) { errorEl.textContent = '반복할 요일을 하나 이상 선택해주세요.'; return; }
        template.weekdays = weekdays;
      } else if (repeatType === 'monthly') {
        template.dayOfMonth = Number(box.querySelector('#pi-day-of-month').value) || 1;
      }
      state.data.repeatTemplates.push(template);
      syncFn = () => dbInsertTemplate(template);
    }
    closeModal();
    renderTab(state.tab);
    showToast('등록되었습니다.');
    syncWrite(syncFn);
  });
}

function openUnplannedExpenseModal() {
  const box = openModal('계획 외 지출 등록', `
    <form id="unplanned-expense-form">
      <label class="field"><span>날짜</span><input type="date" id="ue-date" value="${state.selectedDate}" required /></label>
      <label class="field"><span>카테고리</span><select id="ue-category">${categoryOptionsHTML(allExpenseCategories())}</select></label>
      ${inlineCategoryManagerHTML('ue')}
      <label class="field"><span>실제 금액</span><input type="text" inputmode="numeric" id="ue-amount" required placeholder="예: 8,000" /></label>
      <label class="field"><span>결제수단</span>
        <select id="ue-payment">
          <option value="" selected disabled>선택</option>
          <option value="card">카드</option>
          <option value="cash">현금</option>
          <option value="transfer">계좌이체</option>
          <option value="etc">기타</option>
        </select>
      </label>
      <label class="field"><span>사유 (선택)</span><textarea id="ue-reason" placeholder="어떤 지출이었는지 적어주세요"></textarea></label>
      <p class="form-error" id="ue-error"></p>
      <div class="modal-actions">
        <button type="button" class="btn btn-outline" id="ue-cancel">취소</button>
        <button type="submit" class="btn btn-primary">등록</button>
      </div>
    </form>
  `);
  bindAmountInput(box.querySelector('#ue-amount'));
  bindInlineCategoryManager(box, 'ue', box.querySelector('#ue-category'), allExpenseCategories);
  box.querySelector('#ue-cancel').onclick = closeModal;
  box.querySelector('#unplanned-expense-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const amount = parseAmountInputValue(box.querySelector('#ue-amount').value);
    const errorEl = box.querySelector('#ue-error');
    if (!amount || amount <= 0) { errorEl.textContent = '금액을 올바르게 입력해주세요.'; return; }
    const payment = box.querySelector('#ue-payment').value;
    if (!payment) { errorEl.textContent = '결제수단을 선택해주세요.'; return; }
    const newItem = {
      id: uid(), date: box.querySelector('#ue-date').value, categoryId: box.querySelector('#ue-category').value,
      expectedAmount: null, actualAmount: amount, paymentMethod: payment,
      planned: false, reasonText: box.querySelector('#ue-reason').value.trim(), templateId: null,
    };
    state.data.expenseItems.push(newItem);
    closeModal();
    renderTab(state.tab);
    showToast('계획 외 지출이 등록되었습니다.');
    syncWrite(() => dbInsertExpenseItem(newItem));
  });
}

function openEditItemModal(id) {
  const item = state.data.expenseItems.find((i) => i.id === id);
  if (!item) return;
  const box = openModal('지출 예정사항 수정', `
    <form id="edit-item-form">
      ${item.templateId ? '<p class="list-item-sub" style="margin:-6px 0 12px;">🔁 반복 항목입니다. 수정 내용은 이 날짜에만 적용됩니다.</p>' : ''}
      <label class="field"><span>카테고리</span><select id="ei-category">${categoryOptionsHTML(item.planned ? plannedExpenseCategories() : allExpenseCategories(), item.categoryId)}</select></label>
      ${inlineCategoryManagerHTML('ei')}
      <label class="field"><span>지출 내용 (선택)</span><input type="text" id="ei-memo" value="${escapeHTML(item.memo || '')}" placeholder="예: 팀 회식" /></label>
      <label class="field"><span>예상 금액</span><input type="text" inputmode="numeric" id="ei-expected" value="${item.expectedAmount != null ? formatAmountInputValue(String(item.expectedAmount)) : ''}" /></label>
      <label class="field"><span>실제 금액</span><input type="text" inputmode="numeric" id="ei-actual" value="${item.actualAmount != null ? formatAmountInputValue(String(item.actualAmount)) : ''}" placeholder="아직 체크 전이면 비워두세요" /></label>
      ${item.actualAmount != null ? `
      <label class="field"><span>결제수단</span>
        <select id="ei-payment">
          <option value="" ${!item.paymentMethod ? 'selected' : ''} disabled>선택</option>
          <option value="card" ${item.paymentMethod === 'card' ? 'selected' : ''}>카드</option>
          <option value="cash" ${item.paymentMethod === 'cash' ? 'selected' : ''}>현금</option>
          <option value="transfer" ${item.paymentMethod === 'transfer' ? 'selected' : ''}>계좌이체</option>
          <option value="etc" ${item.paymentMethod === 'etc' ? 'selected' : ''}>기타</option>
        </select>
      </label>` : '<p class="list-item-sub" style="margin:-6px 0 12px;">결제수단은 실제 지출을 체크한 뒤 선택할 수 있어요.</p>'}
      <label class="field"><span>사유 (선택)</span><textarea id="ei-reason">${escapeHTML(item.reasonText || '')}</textarea></label>
      <div class="modal-actions">
        <button type="button" class="btn btn-outline" id="ei-cancel">취소</button>
        <button type="submit" class="btn btn-primary">저장</button>
      </div>
    </form>
  `);
  bindAmountInput(box.querySelector('#ei-expected'));
  bindAmountInput(box.querySelector('#ei-actual'));
  bindInlineCategoryManager(box, 'ei', box.querySelector('#ei-category'), () => (item.planned ? plannedExpenseCategories() : allExpenseCategories()));
  box.querySelector('#ei-cancel').onclick = closeModal;
  box.querySelector('#edit-item-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const expected = parseAmountInputValue(box.querySelector('#ei-expected').value);
    const actual = parseAmountInputValue(box.querySelector('#ei-actual').value);
    const paymentSelect = box.querySelector('#ei-payment');
    const patch = {
      categoryId: box.querySelector('#ei-category').value,
      memo: box.querySelector('#ei-memo').value.trim(),
      expectedAmount: isNaN(expected) ? 0 : expected,
      actualAmount: isNaN(actual) ? null : actual,
      paymentMethod: paymentSelect ? paymentSelect.value : item.paymentMethod,
      reasonText: box.querySelector('#ei-reason').value.trim(),
    };
    updateExpenseItem(id, patch);
    closeModal();
    renderTab(state.tab);
    showToast('수정되었습니다.');
  });
}

// =========================================================
//  목표설정 (카테고리 관리 / 반복 지출 관리)
// =========================================================
function renderGoals() {
  const el = document.getElementById('tab-goals');
  el.innerHTML = `
    <div class="subtab-switch">
      <button type="button" class="goals-subtab-btn ${state.goalsSubtab === 'categories' ? 'active' : ''}" data-sub="categories">카테고리 관리</button>
      <button type="button" class="goals-subtab-btn ${state.goalsSubtab === 'repeat' ? 'active' : ''}" data-sub="repeat">반복 지출 관리</button>
    </div>
    <div id="goals-subtab-content"></div>
  `;
  el.querySelectorAll('.goals-subtab-btn').forEach((b) => {
    b.onclick = () => { state.goalsSubtab = b.dataset.sub; renderGoals(); };
  });
  const content = el.querySelector('#goals-subtab-content');
  if (state.goalsSubtab === 'categories') renderCategoryManager(content);
  else renderRepeatManager(content);
}

function renderCategoryChips(type) {
  const list = state.data.categories.filter((c) => c.type === type);
  if (!list.length) return '<span class="empty-state" style="padding:4px 0;">카테고리가 없습니다.</span>';
  return list.map((c) => `
    <span class="category-chip ${c.system ? 'default-chip' : ''}" data-id="${c.id}">
      ${escapeHTML(c.name)}${c.deletable ? `<button type="button" class="delete-cat-btn" data-id="${c.id}">✕</button>` : ''}
    </span>`).join('');
}

function renderCategoryManager(el) {
  el.innerHTML = `
    <div class="card">
      <div class="card-title">지출 카테고리</div>
      <div class="category-chip-list">${renderCategoryChips('expense')}</div>
      <form class="field-row" id="add-expense-cat-form">
        <label class="field" style="margin-bottom:0;"><input type="text" id="new-expense-cat" placeholder="새 카테고리 이름" required /></label>
        <button type="submit" class="btn btn-primary btn-sm" style="align-self:flex-end;">추가</button>
      </form>
    </div>
    <div class="card">
      <div class="card-title">수익 카테고리</div>
      <div class="category-chip-list">${renderCategoryChips('income')}</div>
      <form class="field-row" id="add-income-cat-form">
        <label class="field" style="margin-bottom:0;"><input type="text" id="new-income-cat" placeholder="새 카테고리 이름" required /></label>
        <button type="submit" class="btn btn-primary btn-sm" style="align-self:flex-end;">추가</button>
      </form>
    </div>
    <p class="auth-note" style="text-align:left; padding: 0 2px;">※ 수익 입력·목표 기능은 다음 단계에서 제공될 예정이며, 지금은 카테고리만 미리 관리할 수 있어요.</p>
  `;

  el.querySelectorAll('.delete-cat-btn').forEach((b) => {
    b.onclick = () => {
      const id = b.dataset.id;
      const usedCount = state.data.expenseItems.filter((i) => i.categoryId === id).length
        + state.data.repeatTemplates.filter((t) => t.categoryId === id).length;
      if (usedCount > 0 && !confirm(`이 카테고리를 사용하는 항목이 ${usedCount}개 있습니다. 그래도 삭제할까요?`)) return;
      state.data.categories = state.data.categories.filter((c) => c.id !== id);
      renderGoals();
      showToast('카테고리가 삭제되었습니다.');
      syncWrite(() => dbDeleteCategory(id));
    };
  });

  el.querySelector('#add-expense-cat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = el.querySelector('#new-expense-cat');
    const name = input.value.trim();
    if (!name) return;
    const newCat = { id: uid(), name, type: 'expense', deletable: true };
    state.data.categories.push(newCat);
    renderGoals();
    showToast('카테고리가 추가되었습니다.');
    syncWrite(() => dbInsertCategory(newCat));
  });
  el.querySelector('#add-income-cat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = el.querySelector('#new-income-cat');
    const name = input.value.trim();
    if (!name) return;
    const newCat = { id: uid(), name, type: 'income', deletable: true };
    state.data.categories.push(newCat);
    renderGoals();
    showToast('카테고리가 추가되었습니다.');
    syncWrite(() => dbInsertCategory(newCat));
  });
}

function repeatTypeLabel(t) {
  if (t.repeatType === 'daily') return '매일';
  if (t.repeatType === 'weekly') return '매주 ' + (t.weekdays || []).map((w) => WEEKDAY_LABELS[w]).join(', ');
  if (t.repeatType === 'monthly') return `매월 ${t.dayOfMonth}일`;
  return '';
}

function renderRepeatManager(el) {
  const templates = state.data.repeatTemplates;
  el.innerHTML = `
    <div class="card">
      <div class="card-title">반복 지출 항목 <button type="button" class="btn btn-primary btn-sm" id="add-template-btn">+ 추가</button></div>
      <div id="template-list">
        ${templates.length ? templates.map((t) => `
          <div class="template-card ${t.active ? '' : 'inactive'}" data-id="${t.id}">
            <div class="template-info">
              <div class="template-title">${t.memo ? escapeHTML(t.memo) : escapeHTML(getCategory(t.categoryId)?.name || '삭제된 카테고리')} · ${formatCurrency(t.expectedAmount)}</div>
              <div class="template-sub">${t.memo ? escapeHTML(getCategory(t.categoryId)?.name || '삭제된 카테고리') + ' · ' : ''}${repeatTypeLabel(t)} · ${t.startDate}부터</div>
            </div>
            <div class="template-actions">
              <button type="button" class="btn btn-outline btn-sm toggle-template-btn" data-id="${t.id}">${t.active ? '일시중지' : '재개'}</button>
              <button type="button" class="icon-btn delete-template-btn" data-id="${t.id}">🗑</button>
            </div>
          </div>
        `).join('') : '<p class="empty-state">등록된 반복 지출이 없습니다.</p>'}
      </div>
    </div>
  `;
  el.querySelector('#add-template-btn').onclick = () => openRepeatTemplateModal();
  el.querySelectorAll('.toggle-template-btn').forEach((b) => {
    b.onclick = () => {
      const t = templates.find((x) => x.id === b.dataset.id);
      t.active = !t.active;
      renderGoals();
      syncWrite(() => dbUpdateTemplate(t.id, { active: t.active }));
    };
  });
  el.querySelectorAll('.delete-template-btn').forEach((b) => {
    b.onclick = () => {
      if (!confirm('이 반복 지출 설정을 삭제할까요? (이미 생성된 지출 항목은 유지됩니다)')) return;
      const id = b.dataset.id;
      state.data.repeatTemplates = templates.filter((x) => x.id !== id);
      renderGoals();
      showToast('삭제되었습니다.');
      syncWrite(() => dbDeleteTemplate(id));
    };
  });
}

function openRepeatTemplateModal() {
  const box = openModal('반복 지출 추가', `
    <form id="repeat-template-form">
      <label class="field"><span>카테고리</span><select id="rt-category">${categoryOptionsHTML(plannedExpenseCategories())}</select></label>
      ${inlineCategoryManagerHTML('rt')}
      <label class="field"><span>지출 내용 (선택)</span><input type="text" id="rt-memo" placeholder="예: 넷플릭스 구독료" /></label>
      <label class="field"><span>예상 금액</span><input type="text" inputmode="numeric" id="rt-amount" required placeholder="예: 4,500" /></label>
      <label class="field"><span>시작일</span><input type="date" id="rt-start" value="${state.selectedDate}" required /></label>
      <div class="field"><span>반복 주기</span>
        <div class="radio-group" id="rt-repeat-group">
          <label><input type="radio" name="rt-repeat" value="daily" checked /><span>매일</span></label>
          <label><input type="radio" name="rt-repeat" value="weekly" /><span>매주</span></label>
          <label><input type="radio" name="rt-repeat" value="monthly" /><span>매월</span></label>
        </div>
      </div>
      <div class="field hidden" id="rt-weekly-detail"><span>반복 요일</span>
        <div class="weekday-picker">
          ${WEEKDAY_LABELS.map((w, i) => `<label><input type="checkbox" class="rt-weekday" value="${i}" /><span>${w}</span></label>`).join('')}
        </div>
      </div>
      <div class="field hidden" id="rt-monthly-detail"><span>매월 반복 일자</span>
        <input type="number" id="rt-day-of-month" min="1" max="31" value="1" />
      </div>
      <p class="form-error" id="rt-error"></p>
      <div class="modal-actions">
        <button type="button" class="btn btn-outline" id="rt-cancel">취소</button>
        <button type="submit" class="btn btn-primary">저장</button>
      </div>
    </form>
  `);

  const radios = box.querySelectorAll('input[name="rt-repeat"]');
  const weeklyDetail = box.querySelector('#rt-weekly-detail');
  const monthlyDetail = box.querySelector('#rt-monthly-detail');
  radios.forEach((r) => r.addEventListener('change', () => {
    weeklyDetail.classList.toggle('hidden', !(r.checked && r.value === 'weekly'));
    if (r.checked && r.value === 'monthly') {
      monthlyDetail.classList.remove('hidden');
      const dateVal = box.querySelector('#rt-start').value;
      if (dateVal) box.querySelector('#rt-day-of-month').value = dayOfMonthOf(dateVal);
    } else if (r.checked) {
      monthlyDetail.classList.add('hidden');
    }
  }));

  bindAmountInput(box.querySelector('#rt-amount'));
  bindInlineCategoryManager(box, 'rt', box.querySelector('#rt-category'), plannedExpenseCategories);
  box.querySelector('#rt-cancel').onclick = closeModal;
  box.querySelector('#repeat-template-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const amount = parseAmountInputValue(box.querySelector('#rt-amount').value);
    const errorEl = box.querySelector('#rt-error');
    if (!amount || amount <= 0) { errorEl.textContent = '예상 금액을 올바르게 입력해주세요.'; return; }
    const repeatType = box.querySelector('input[name="rt-repeat"]:checked').value;
    const template = {
      id: uid(), categoryId: box.querySelector('#rt-category').value, memo: box.querySelector('#rt-memo').value.trim(),
      expectedAmount: amount, repeatType, startDate: box.querySelector('#rt-start').value, active: true,
    };
    if (repeatType === 'weekly') {
      const weekdays = Array.from(box.querySelectorAll('.rt-weekday:checked')).map((c) => Number(c.value));
      if (!weekdays.length) { errorEl.textContent = '반복할 요일을 하나 이상 선택해주세요.'; return; }
      template.weekdays = weekdays;
    } else if (repeatType === 'monthly') {
      template.dayOfMonth = Number(box.querySelector('#rt-day-of-month').value) || 1;
    }
    state.data.repeatTemplates.push(template);
    closeModal();
    renderGoals();
    showToast('반복 지출이 등록되었습니다.');
    syncWrite(() => dbInsertTemplate(template));
  });
}

// =========================================================
//  자산관리
// =========================================================
function renderAssets() {
  const el = document.getElementById('tab-assets');
  const assets = state.data.assets;
  const total = assets.reduce((s, a) => s + (a.amount || 0), 0);

  el.innerHTML = `
    <div class="card asset-total-card">
      <div class="tile-label">총 자산</div>
      <div class="tile-value">${formatCurrency(total)}</div>
    </div>
    <div class="card">
      <div class="card-title">자산 목록 <button type="button" class="btn btn-primary btn-sm" id="add-asset-btn">+ 추가</button></div>
      <div id="asset-list">
        ${assets.length ? assets.map((a) => `
          <div class="asset-row" data-id="${a.id}">
            <div>
              <div class="asset-row-name">${escapeHTML(a.name)}</div>
              <div class="asset-row-meta">업데이트: ${a.updatedAt}</div>
            </div>
            <div style="display:flex; align-items:center;">
              <span class="asset-row-amount">${formatCurrency(a.amount)}</span>
              <div class="asset-row-actions">
                <button type="button" class="icon-btn edit-asset-btn" data-id="${a.id}">✎</button>
                <button type="button" class="icon-btn delete-asset-btn" data-id="${a.id}">🗑</button>
              </div>
            </div>
          </div>
        `).join('') : '<p class="empty-state">등록된 자산이 없습니다.</p>'}
      </div>
    </div>
  `;
  el.querySelector('#add-asset-btn').onclick = () => openAssetModal();
  el.querySelectorAll('.edit-asset-btn').forEach((b) => {
    b.onclick = () => openAssetModal(assets.find((a) => a.id === b.dataset.id));
  });
  el.querySelectorAll('.delete-asset-btn').forEach((b) => {
    b.onclick = () => {
      if (!confirm('이 자산을 삭제할까요?')) return;
      const id = b.dataset.id;
      state.data.assets = assets.filter((a) => a.id !== id);
      renderAssets();
      showToast('삭제되었습니다.');
      syncWrite(() => dbDeleteAsset(id));
    };
  });
}

function openAssetModal(existing) {
  const box = openModal(existing ? '자산 수정' : '자산 추가', `
    <form id="asset-form">
      <label class="field"><span>자산 이름</span><input type="text" id="asset-name" required placeholder="예: 주거래 통장" value="${existing ? escapeHTML(existing.name) : ''}" /></label>
      <label class="field"><span>금액</span><input type="text" inputmode="numeric" id="asset-amount" required placeholder="예: 3,000,000" value="${existing ? formatAmountInputValue(String(existing.amount)) : ''}" /></label>
      <div class="modal-actions">
        <button type="button" class="btn btn-outline" id="asset-cancel">취소</button>
        <button type="submit" class="btn btn-primary">저장</button>
      </div>
    </form>
  `);
  bindAmountInput(box.querySelector('#asset-amount'));
  box.querySelector('#asset-cancel').onclick = closeModal;
  box.querySelector('#asset-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = box.querySelector('#asset-name').value.trim();
    const amount = parseAmountInputValue(box.querySelector('#asset-amount').value);
    if (!name || isNaN(amount)) return;
    let syncFn;
    if (existing) {
      Object.assign(existing, { name, amount, updatedAt: todayStr() });
      syncFn = () => dbUpdateAsset(existing.id, { name, amount, updatedAt: existing.updatedAt });
    } else {
      const newAsset = { id: uid(), name, amount, updatedAt: todayStr() };
      state.data.assets.push(newAsset);
      syncFn = () => dbInsertAsset(newAsset);
    }
    closeModal();
    renderAssets();
    showToast('저장되었습니다.');
    syncWrite(syncFn);
  });
}

// =========================================================
//  초기화
// =========================================================
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.auth-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.auth-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      const isLogin = tab.dataset.auth === 'login';
      document.getElementById('login-form').classList.toggle('hidden', !isLogin);
      document.getElementById('signup-form').classList.toggle('hidden', isLogin);
    });
  });

  document.getElementById('login-form').addEventListener('submit', handleLogin);
  document.getElementById('signup-form').addEventListener('submit', handleSignup);
  document.getElementById('logout-btn').addEventListener('click', handleLogout);
  document.getElementById('google-login-btn').addEventListener('click', handleGoogleLogin);
  document.getElementById('household-btn').addEventListener('click', openHouseholdModal);

  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.tab === 'dashboard' && state.tab === 'dashboard' && state.dashboardView === 'detail') {
        state.dashboardView = 'calendar';
      }
      switchTab(btn.dataset.tab);
    });
  });
});
