import { supabase } from './supabaseClient';
import type { VocabItem, GrammarItem, ReviewLog } from '../types';
import {
  ensureFSRSVocab,
  ensureFSRSGrammar,
  getReviewLogs,
  mergeReviewLogs,
  reviewLogId,
  setReviewLogs,
  readSyncedSettings,
  writeSyncedSettings,
  SYNCED_SETTING_KEYS,
} from './storage';

// ============================================================================
// ĐỒNG BỘ CLOUD THEO TÀI KHOẢN
// ----------------------------------------------------------------------------
// Mỗi thiết bị lưu "ảnh chụp" (hash) của những gì Cloud đang có sau lần đồng bộ
// gần nhất. So dữ liệu trên máy với ảnh chụp này sẽ biết chính xác thẻ nào vừa
// thêm/sửa/xóa — kể cả khi thay đổi được tạo lúc mất mạng hoặc trước khi F5 —
// rồi chỉ gửi phần thay đổi lên /api/sync.
// ============================================================================

const SYNC_STATE_PREFIX = 'vocabbank_sync_state_v1:';
const DATA_OWNER_KEY = 'vocabbank_data_owner';
// Mỗi request giữ dưới giới hạn 6 MB của Netlify Functions (thẻ có thể chứa ảnh base64)
const MAX_PUSH_BYTES = 3_500_000;
const MAX_LOGS_PER_PUSH = 2000;

interface SyncState {
  vocab: Record<string, string>;
  grammar: Record<string, string>;
  settings: Record<string, string | null>;
  /** Mốc thời gian của lượt ôn mới nhất đã gửi lên Cloud */
  logsPushedThrough: string;
}

type ItemKind = 'vocab' | 'grammar';

export interface SyncedData {
  vocab: VocabItem[];
  grammar: GrammarItem[];
  /** Cài đặt FSRS / Rank trên máy vừa được thay bằng bản từ Cloud */
  settingsChanged: boolean;
  logsChanged: boolean;
}

// ---------------------------------------------------------------------------
// Hash helpers (cached per object: React only creates new objects for changed items)
// ---------------------------------------------------------------------------

const hashCache = new WeakMap<object, string>();

function hashString(str: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 5381;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = (Math.imul(h2, 33) + c) | 0;
  }
  return `${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}${str.length.toString(36)}`;
}

export function hashItem(item: object): string {
  let h = hashCache.get(item);
  if (!h) {
    h = hashString(JSON.stringify(item));
    hashCache.set(item, h);
  }
  return h;
}

function hashMap(items: Array<{ id: string }>): Record<string, string> {
  const out: Record<string, string> = {};
  items.forEach((item) => {
    out[item.id] = hashItem(item);
  });
  return out;
}

// ---------------------------------------------------------------------------
// Local sync state
// ---------------------------------------------------------------------------

function loadSyncState(userId: string): SyncState | null {
  try {
    const raw = localStorage.getItem(SYNC_STATE_PREFIX + userId);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return {
      vocab: parsed.vocab || {},
      grammar: parsed.grammar || {},
      settings: parsed.settings || {},
      logsPushedThrough: parsed.logsPushedThrough || '',
    };
  } catch {
    return null;
  }
}

function saveSyncState(userId: string, state: SyncState): void {
  try {
    localStorage.setItem(SYNC_STATE_PREFIX + userId, JSON.stringify(state));
  } catch (err) {
    console.warn('Không lưu được trạng thái đồng bộ:', err);
  }
}

function getDataOwner(): string | null {
  try {
    return localStorage.getItem(DATA_OWNER_KEY);
  } catch {
    return null;
  }
}

function setDataOwner(userId: string): void {
  try {
    localStorage.setItem(DATA_OWNER_KEY, userId);
  } catch {}
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function authHeader(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function getJson(query: string): Promise<any> {
  const headers = await authHeader();
  if (!headers.Authorization) throw new Error('Not signed in');
  const res = await fetch(`/api/sync?${query}`, { headers });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.success) throw new Error(json?.message || `Sync GET failed (${res.status})`);
  return json;
}

async function postChanges(body: Record<string, unknown>): Promise<void> {
  const headers = await authHeader();
  if (!headers.Authorization) throw new Error('Not signed in');
  const res = await fetch('/api/sync', {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.success) throw new Error(json?.message || `Sync POST failed (${res.status})`);
}

async function fetchAllItems(kind: ItemKind): Promise<any[]> {
  const items: any[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const json = await getJson(`kind=${kind}&offset=${offset}`);
    items.push(...(json.items || []));
    offset = typeof json.nextOffset === 'number' ? json.nextOffset : null;
  }
  return items;
}

async function fetchLogs(after: string): Promise<ReviewLog[]> {
  const logs: ReviewLog[] = [];
  let cursor: string | null = after;
  do {
    const json = await getJson(`kind=logs${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`);
    logs.push(...(json.logs || []));
    cursor = typeof json.nextAfter === 'string' ? json.nextAfter : null;
  } while (cursor);
  return logs;
}

// ---------------------------------------------------------------------------
// Diff & push
// ---------------------------------------------------------------------------

interface Changes {
  upserts: Record<ItemKind, any[]>;
  deletes: Record<ItemKind, string[]>;
  settings: Record<string, string | null>;
  logs: ReviewLog[];
}

function diffItems(items: Array<{ id: string }>, base: Record<string, string>) {
  const current = new Set<string>();
  const upserts = items.filter((item) => {
    current.add(item.id);
    return base[item.id] !== hashItem(item);
  });
  const deletes = Object.keys(base).filter((id) => !current.has(id));
  return { upserts, deletes };
}

function computeChanges(state: SyncState, vocab: VocabItem[], grammar: GrammarItem[]): Changes {
  const v = diffItems(vocab, state.vocab);
  const g = diffItems(grammar, state.grammar);
  const localSettings = readSyncedSettings();
  const settings: Record<string, string | null> = {};
  for (const key of SYNCED_SETTING_KEYS) {
    const value = localSettings[key] ?? null;
    if (value !== (state.settings[key] ?? null)) settings[key] = value;
  }
  const logs = getReviewLogs().filter((l) => l.timestamp > state.logsPushedThrough);
  return {
    upserts: { vocab: v.upserts, grammar: g.upserts },
    deletes: { vocab: v.deletes, grammar: g.deletes },
    settings,
    logs,
  };
}

function hasChanges(c: Changes): boolean {
  return (
    c.upserts.vocab.length + c.upserts.grammar.length + c.deletes.vocab.length + c.deletes.grammar.length + c.logs.length > 0 ||
    Object.keys(c.settings).length > 0
  );
}

/**
 * Gửi thay đổi lên Cloud theo từng gói nhỏ; sau mỗi gói thành công thì cập nhật
 * ảnh chụp, nên nếu mất mạng giữa chừng lần sau chỉ gửi phần còn lại.
 */
async function pushChangesInBatches(userId: string, state: SyncState, changes: Changes): Promise<void> {
  // 1) Deletes + settings (small)
  if (changes.deletes.vocab.length || changes.deletes.grammar.length || Object.keys(changes.settings).length) {
    await postChanges({ deletes: changes.deletes, settings: changes.settings });
    changes.deletes.vocab.forEach((id) => delete state.vocab[id]);
    changes.deletes.grammar.forEach((id) => delete state.grammar[id]);
    Object.entries(changes.settings).forEach(([key, value]) => {
      state.settings[key] = value;
    });
    saveSyncState(userId, state);
  }

  // 2) Upserts, split by payload size
  for (const kind of ['vocab', 'grammar'] as ItemKind[]) {
    let batch: any[] = [];
    let bytes = 0;
    const flush = async () => {
      if (batch.length === 0) return;
      await postChanges({ upserts: { [kind]: batch } });
      batch.forEach((item) => {
        state[kind][item.id] = hashItem(item);
      });
      saveSyncState(userId, state);
      batch = [];
      bytes = 0;
    };
    for (const item of changes.upserts[kind]) {
      const size = JSON.stringify(item).length;
      if (batch.length > 0 && bytes + size > MAX_PUSH_BYTES) await flush();
      batch.push(item);
      bytes += size;
    }
    await flush();
  }

  // 3) Review logs (append-only)
  const logs = [...changes.logs].sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
  for (let i = 0; i < logs.length; i += MAX_LOGS_PER_PUSH) {
    const chunk = logs.slice(i, i + MAX_LOGS_PER_PUSH);
    await postChanges({ logs: chunk });
    const last = chunk[chunk.length - 1].timestamp;
    if (last > state.logsPushedThrough) state.logsPushedThrough = last;
    saveSyncState(userId, state);
  }
}

let pushChain: Promise<unknown> = Promise.resolve();

/** Xếp hàng các lượt đồng bộ để không bao giờ chạy chồng lên nhau */
function serialize<T>(task: () => Promise<T>): Promise<T> {
  const run = pushChain.then(task, task);
  pushChain = run.catch(() => undefined);
  return run;
}

/**
 * Đẩy mọi thay đổi trên máy (từ vựng, ngữ pháp, cài đặt FSRS, lịch sử ôn) lên Cloud.
 * Trả về false nếu chưa từng đồng bộ lần đầu hoặc gặp lỗi mạng.
 */
export function pushLocalChanges(userId: string, vocab: VocabItem[], grammar: GrammarItem[]): Promise<boolean> {
  return serialize(async () => {
    const state = loadSyncState(userId);
    if (!state || getDataOwner() !== userId) return false;
    const changes = computeChanges(state, vocab, grammar);
    if (!hasChanges(changes)) return true;
    await pushChangesInBatches(userId, state, changes);
    return true;
  });
}

/**
 * Đồng bộ khi mở app / đăng nhập: tải dữ liệu từ Cloud, giữ lại các thay đổi trên máy
 * chưa kịp gửi, rồi gửi phần chênh lệch lên. Cloud là nguồn chính; dữ liệu trên máy
 * chỉ thắng khi nó đã được sửa sau lần đồng bộ trước.
 * Trả về null nếu không kết nối được Cloud (khi đó app tiếp tục dùng dữ liệu trên máy).
 */
export function pullAndMerge(userId: string, localVocab: VocabItem[], localGrammar: GrammarItem[]): Promise<SyncedData> {
  return serialize(async () => {
    const [cloudVocabRaw, cloudGrammarRaw, settingsJson] = await Promise.all([
      fetchAllItems('vocab'),
      fetchAllItems('grammar'),
      getJson('kind=settings'),
    ]);

    const owner = getDataOwner();
    const base = owner === userId ? loadSyncState(userId) : null;
    // Dữ liệu trên máy thuộc về tài khoản khác → không trộn vào tài khoản này
    const localBelongsToOtherUser = owner !== null && owner !== userId;

    const cloudVocab = cloudVocabRaw.map(ensureFSRSVocab);
    const cloudGrammar = cloudGrammarRaw.map(ensureFSRSGrammar);

    const mergeList = <T extends { id: string }>(cloud: T[], local: T[], baseHashes: Record<string, string> | null): T[] => {
      if (localBelongsToOtherUser) return cloud;
      const merged = new Map(cloud.map((item) => [item.id, item]));
      if (baseHashes) {
        // Áp các thay đổi trên máy kể từ lần đồng bộ trước lên bản Cloud
        const { upserts, deletes } = diffItems(local, baseHashes);
        deletes.forEach((id) => merged.delete(id));
        upserts.forEach((item) => merged.set(item.id, item));
        // Giữ thứ tự hiển thị của máy này, thẻ mới từ thiết bị khác lên đầu
        const localIds = new Set(local.map((item) => item.id));
        const fromOtherDevices = [...merged.values()].filter((item) => !localIds.has(item.id));
        const kept = local.filter((item) => merged.has(item.id)).map((item) => merged.get(item.id)!);
        return [...fromOtherDevices, ...kept];
      }
      // Lần đầu đồng bộ trên máy này: Cloud thắng, bổ sung thẻ chỉ có trên máy (dữ liệu cũ chưa từng đồng bộ)
      local.forEach((item) => {
        if (!merged.has(item.id)) merged.set(item.id, item);
      });
      return [...merged.values()];
    };

    const vocab = mergeList(cloudVocab, localVocab, base?.vocab ?? null);
    const grammar = mergeList(cloudGrammar, localGrammar, base?.grammar ?? null);

    // --- Cài đặt FSRS & Rank ---
    const cloudSettings: Record<string, unknown> = settingsJson.settings || {};
    const localSettings = readSyncedSettings();
    const settingsToWrite: Record<string, string | null> = {};
    for (const key of SYNCED_SETTING_KEYS) {
      const cloudValue = typeof cloudSettings[key] === 'string' ? (cloudSettings[key] as string) : null;
      const localValue = localSettings[key] ?? null;
      const localEdited = base ? localValue !== (base.settings[key] ?? null) : false;
      if (localEdited) continue; // thay đổi trên máy chưa gửi → giữ, sẽ được đẩy lên bên dưới
      if (cloudValue !== null) {
        if (cloudValue !== localValue) settingsToWrite[key] = cloudValue;
      } else if (localBelongsToOtherUser && localValue !== null) {
        settingsToWrite[key] = null;
      }
    }
    const settingsChanged = Object.keys(settingsToWrite).length > 0;
    if (settingsChanged) writeSyncedSettings(settingsToWrite);

    // --- Lịch sử ôn tập ---
    const basePushedThrough = base?.logsPushedThrough ?? '';
    const cloudLogs = await fetchLogs(basePushedThrough);
    const cloudLogIds = new Set(cloudLogs.map(reviewLogId));
    // Lượt ôn trên máy chưa có trên Cloud (lần đầu đồng bộ: toàn bộ lịch sử cũ trên máy)
    const pendingLogs = localBelongsToOtherUser
      ? []
      : getReviewLogs().filter((l) => l.timestamp > basePushedThrough && !cloudLogIds.has(reviewLogId(l)));
    let logsChanged: boolean;
    if (localBelongsToOtherUser) {
      setReviewLogs(cloudLogs);
      logsChanged = true;
    } else {
      logsChanged = mergeReviewLogs(cloudLogs) > 0;
    }

    // Ảnh chụp = những gì Cloud đang có; phần chênh lệch được gửi ngay sau đây
    const cloudSettingsRaw: Record<string, string | null> = {};
    for (const key of SYNCED_SETTING_KEYS) {
      cloudSettingsRaw[key] = typeof cloudSettings[key] === 'string' ? (cloudSettings[key] as string) : null;
    }
    const state: SyncState = {
      vocab: hashMap(cloudVocab),
      grammar: hashMap(cloudGrammar),
      settings: cloudSettingsRaw,
      logsPushedThrough: basePushedThrough,
    };
    setDataOwner(userId);
    saveSyncState(userId, state);

    try {
      const changes = { ...computeChanges(state, vocab, grammar), logs: pendingLogs };
      if (hasChanges(changes)) await pushChangesInBatches(userId, state, changes);
      // Mọi lượt ôn hiện có trên máy giờ đều đã nằm trên Cloud
      const allLogs = getReviewLogs();
      const newest = allLogs.length ? allLogs[allLogs.length - 1].timestamp : '';
      if (newest > state.logsPushedThrough) {
        state.logsPushedThrough = newest;
        saveSyncState(userId, state);
      }
    } catch (err) {
      // Dữ liệu vẫn an toàn trên máy; lần đồng bộ sau sẽ gửi tiếp phần còn thiếu
      console.warn('Chưa gửi được thay đổi lên Cloud:', err);
    }

    return { vocab, grammar, settingsChanged, logsChanged };
  });
}
