import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Bell, ChevronDown, ChevronRight, Copy, Download, Eye, FileSpreadsheet, FolderOpen, Pause, Play, Plus, Radio, Save, Search, Square, Trash2, Upload, Volume2, Zap } from "lucide-react";
import type { CollectionState, ExtensionClientInfo, GroupMonitorItem, KeywordItem, RadarPost, RadarSettings, RadarStats } from "@foradar/shared";
import { defaultSettings } from "@foradar/shared";
import "./styles.css";

type KeywordCategory = KeywordItem["category"];
type OperationLog = { at: string; message: string; level: "info" | "success" | "warning" | "error" };
type SortMode = "recommended" | "score" | "postTime" | "collectedAt" | "alerted" | "unhandled" | "unknown";

interface AppState {
  posts: RadarPost[];
  settings: RadarSettings;
  collectionState: CollectionState;
  operationLog: OperationLog[];
  stats: RadarStats;
  clients: ExtensionClientInfo[];
}

const emptyStats: RadarStats = { totalPosts: 0, newPosts: 0, todayPosts: 0, alertedPosts: 0, unknownTimePosts: 0, connectedClients: 0 };
const categoryLabels: Record<KeywordCategory, string> = { highValue: "高价值关键词", normal: "普通关键词", negative: "排除关键词" };
const stateLabels: Record<CollectionState, string> = {
  stopped: "已停止",
  collecting: "正在采集",
  paused: "已暂停",
  auto_scrolling: "自动滚动中",
  monitoring: "群组监控中",
  error: "错误"
};

function createKeyword(text: string, category: KeywordCategory): KeywordItem {
  return { id: `${category}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, text: text.trim(), category, enabled: true };
}

function createGroup(url: string): GroupMonitorItem {
  return {
    id: `group-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: "Facebook 群组",
    url,
    enabled: true,
    status: "not_open",
    intervalSeconds: 60,
    todayNewPosts: 0
  };
}

function isFacebookGroupUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return /(^|\.)facebook\.com$/i.test(url.hostname) && (url.pathname.includes("/groups/") || url.pathname === "/groups/feed/");
  } catch {
    return false;
  }
}

async function playBeep(): Promise<void> {
  const context = new (window.AudioContext || (window as any).webkitAudioContext)();
  if (context.state === "suspended") await context.resume();
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = "sine";
  oscillator.frequency.value = 880;
  gain.gain.setValueAtTime(0.0001, context.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.25, context.currentTime + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.5);
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start();
  oscillator.stop(context.currentTime + 0.55);
}

function StatCard({ label, value }: { label: string; value: number | string }) {
  return <div className="stat-card"><span>{label}</span><strong>{value}</strong></div>;
}

function App() {
  const [state, setState] = useState<AppState>({ posts: [], settings: defaultSettings, collectionState: "stopped", operationLog: [], stats: emptyStats, clients: [] });
  const [draftSettings, setDraftSettings] = useState<RadarSettings>(defaultSettings);
  const [socketReady, setSocketReady] = useState(false);
  const [scrollCount, setScrollCount] = useState(defaultSettings.autoScroll.defaultScrollCount);
  const [scrollDelaySeconds, setScrollDelaySeconds] = useState(Math.max(1, Math.round(defaultSettings.autoScroll.waitMsAfterScroll / 1000)));
  const [monitorInterval, setMonitorInterval] = useState(60);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "new" | "alerted" | "unknown">("all");
  const [sortMode, setSortMode] = useState<SortMode>("recommended");
  const [translationOpen, setTranslationOpen] = useState(false);
  const [keywordOpen, setKeywordOpen] = useState(false);
  const [keywordCategory, setKeywordCategory] = useState<KeywordCategory>("highValue");
  const [newKeyword, setNewKeyword] = useState("");
  const [importText, setImportText] = useState("");
  const [groupUrl, setGroupUrl] = useState("");
  const [toast, setToast] = useState("");
  const [flashUi, setFlashUi] = useState(false);
  const [selectedPost, setSelectedPost] = useState<RadarPost | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    const connect = () => {
      socket = new WebSocket("ws://127.0.0.1:8765?role=renderer");
      socket.addEventListener("open", () => setSocketReady(true));
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(event.data);
        if (message.type === "state") {
          const settings = { ...defaultSettings, ...message.payload.settings, groupMonitor: { ...defaultSettings.groupMonitor, ...message.payload.settings?.groupMonitor } };
          setState((previous) => ({ ...previous, ...message.payload, settings }));
          setDraftSettings(settings);
          setScrollCount(settings.autoScroll.defaultScrollCount);
          setScrollDelaySeconds(Math.max(1, Math.round(settings.autoScroll.waitMsAfterScroll / 1000)));
          setMonitorInterval(settings.groupMonitor.defaultIntervalSeconds);
        }
      });
      socket.addEventListener("close", () => {
        setSocketReady(false);
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connect, 1000);
      });
      socket.addEventListener("error", () => socket?.close());
    };
    connect();
    return () => {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelectedPost(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    window.radarApi?.onAlertSound(async () => {
      try {
        await playBeep();
      } catch (error) {
        window.radarApi?.command("ui-log", `声音播放失败：${String(error)}`);
      }
    });
  }, []);

  useEffect(() => {
    const latest = state.operationLog[0];
    if (!latest) return;
    if (latest.message.startsWith("插件确认：") || latest.message.includes("失败") || latest.message.startsWith("本次扫描：")) {
      notify(latest.message);
    }
  }, [state.operationLog]);

  const notify = (message: string) => {
    setToast(message);
    setTimeout(() => setToast(""), 3200);
  };

  const command = async (name: string, payload?: unknown, feedback?: string) => {
    if (feedback) notify(feedback);
    const result = await window.radarApi?.command(name, payload) as { sent?: boolean; ack?: boolean; success?: boolean; message?: string; ok?: boolean } | undefined;
    if (result?.message) {
      notify(result.success === false || result.ok === false ? `操作失败：${result.message}` : result.message);
    } else if (result?.sent === false) {
      notify("命令发送失败，请查看运行日志");
    }
    return result;
  };

  const commitSettings = async (nextSettings: RadarSettings, message: string) => {
    setDraftSettings(nextSettings);
    await command("update-settings", nextSettings, message);
  };

  const updateSettings = (updater: (settings: RadarSettings) => RadarSettings) => {
    setDraftSettings((settings) => updater(structuredClone(settings)));
  };

  const saveSettings = async () => {
    await commitSettings({ ...draftSettings, autoScroll: { ...draftSettings.autoScroll, defaultScrollCount: scrollCount, waitMsAfterScroll: scrollDelaySeconds * 1000 }, groupMonitor: { ...draftSettings.groupMonitor, defaultIntervalSeconds: monitorInterval as 30 | 60 | 180 | 300 } }, "设置已保存到本地配置文件");
  };

  const posts = useMemo(() => {
    const filtered = state.posts.filter((post) => !post.ignored).filter((post) => {
      if (filter === "new" && !post.isNewPost) return false;
      if (filter === "alerted" && !post.alertTriggered) return false;
      if (filter === "unknown" && post.timeConfidence !== "unknown") return false;
      const text = `${post.groupName} ${post.postText} ${post.matchedKeywords.join(" ")}`.toLowerCase();
      return text.includes(query.toLowerCase());
    });

    return filtered.sort((a, b) => {
      if (sortMode === "score") return b.score - a.score;
      if (sortMode === "postTime") return (b.parsedPostTime || b.rawTimeText).localeCompare(a.parsedPostTime || a.rawTimeText);
      if (sortMode === "collectedAt") return b.collectedAt.localeCompare(a.collectedAt);
      if (sortMode === "alerted") return Number(b.alertTriggered) - Number(a.alertTriggered);
      if (sortMode === "unhandled") return Number(a.handled || false) - Number(b.handled || false);
      if (sortMode === "unknown") return Number(b.timeConfidence === "unknown") - Number(a.timeConfidence === "unknown");
      return (Number(b.alertTriggered) - Number(a.alertTriggered)) || (Number(b.isNewPost) - Number(a.isNewPost)) || (b.score - a.score) || b.collectedAt.localeCompare(a.collectedAt);
    });
  }, [filter, query, sortMode, state.posts]);

  const addKeyword = () => {
    const text = newKeyword.trim();
    if (!text) return;
    updateSettings((settings) => ({ ...settings, keywords: [...settings.keywords, createKeyword(text, keywordCategory)] }));
    setNewKeyword("");
  };

  const importKeywords = () => {
    const words = importText.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean);
    updateSettings((settings) => ({ ...settings, keywords: [...settings.keywords, ...words.map((word) => createKeyword(word, keywordCategory))] }));
    setImportText("");
  };

  const exportKeywords = () => {
    const blob = new Blob([JSON.stringify(draftSettings.keywords, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "opportunity-radar-keywords.json";
    link.click();
    URL.revokeObjectURL(url);
    command("ui-log", "关键词 JSON 已导出");
  };

  const loadKeywordFile = async (file?: File) => {
    if (!file) return;
    const parsed = JSON.parse(await file.text()) as KeywordItem[];
    updateSettings((settings) => ({ ...settings, keywords: parsed }));
    command("ui-log", `关键词已从 JSON 导入：${parsed.length} 条`);
  };

  const addGroup = async () => {
    const url = groupUrl.trim();
    if (!isFacebookGroupUrl(url)) {
      notify("请输入有效的 Facebook 群组链接");
      await command("ui-log", `保存群组失败：无效链接 ${url}`);
      return;
    }
    const nextSettings = { ...draftSettings, groupMonitor: { ...draftSettings.groupMonitor, groups: [...draftSettings.groupMonitor.groups, createGroup(url)] } };
    await commitSettings(nextSettings, "群组已保存");
    setGroupUrl("");
  };

  const deleteGroup = async (id: string) => {
    const nextSettings = { ...draftSettings, groupMonitor: { ...draftSettings.groupMonitor, groups: draftSettings.groupMonitor.groups.filter((group) => group.id !== id) } };
    await commitSettings(nextSettings, "群组已删除");
  };

  const updateGroup = (id: string, updater: (group: GroupMonitorItem) => GroupMonitorItem) => {
    updateSettings((settings) => ({ ...settings, groupMonitor: { ...settings.groupMonitor, groups: settings.groupMonitor.groups.map((group) => group.id === id ? updater(group) : group) } }));
  };

  const clearData = async () => {
    if (!window.confirm("是否确认清空当前采集数据？")) {
      await command("ui-log", "清空数据已取消");
      return;
    }
    setSelectedPost(null);
    await command("clear", undefined, "正在清空数据");
  };

  const testSound = async () => {
    try {
      await playBeep();
      await command("ui-log", "声音提醒测试成功");
      notify("声音提醒测试成功");
    } catch (error) {
      await command("ui-log", `声音播放失败：${String(error)}`);
      notify("声音播放失败，请查看运行日志");
    }
  };

  const testFlash = async () => {
    setFlashUi(true);
    setTimeout(() => setFlashUi(false), 3500);
    await command("test-flash", undefined, "窗口闪动测试已触发");
  };

  const toggleTranslation = async () => {
    if (!draftSettings.translation.apiKey && draftSettings.translation.apiType !== "local") {
      notify("翻译 API 未配置，请先进入翻译设置填写 API Key。");
      setTranslationOpen(true);
      await command("ui-log", "实时翻译未开启：翻译 API 未配置");
      return;
    }
    const nextSettings = { ...draftSettings, translation: { ...draftSettings.translation, enabled: !draftSettings.translation.enabled } };
    await commitSettings(nextSettings, nextSettings.translation.enabled ? "实时翻译已开启" : "实时翻译已关闭");
  };

  const connectionHint = state.stats.connectedClients === 0 ? "插件未连接，请确认浏览器插件已安装并打开 Facebook 页面" : "插件已连接，等待 Facebook 页面命令确认";

  return (
    <main className={flashUi ? "flash-ui" : ""}>
      {toast && <div className="toast">{toast}</div>}
      <header className="topbar">
        <div>
          <h1>Facebook Opportunity Radar</h1>
          <p>只读取当前浏览器已登录且可见的 Facebook 群组页面，不自动评论，不绕过权限。</p>
        </div>
        <div className={`connection ${socketReady ? "online" : "offline"}`}><Radio size={18} />{socketReady ? "本地服务已连接" : "本地服务未连接"}</div>
      </header>

      <section className="status-grid">
        <div className="panel compact"><h2>插件连接</h2><strong>{state.stats.connectedClients > 0 ? "插件已连接" : "插件未连接"}</strong><span>{connectionHint}</span></div>
        <div className={`panel compact state-${state.collectionState}`}><h2>采集状态</h2><strong>{stateLabels[state.collectionState]}</strong><span>{state.collectionState === "error" ? "采集状态未知，请刷新 Facebook 页面或重新打开插件" : "状态由插件 ACK 确认"}</span></div>
        <StatCard label="已采集帖子" value={state.stats.totalPosts} />
        <StatCard label="新帖数量" value={state.stats.newPosts} />
        <StatCard label="今日采集" value={state.stats.todayPosts} />
        <StatCard label="已提醒" value={state.stats.alertedPosts} />
        <StatCard label="时间未识别" value={state.stats.unknownTimePosts} />
      </section>

      <section className="toolbar">
        <button onClick={() => command("start", undefined, "开始采集命令已发送")}><Play size={16} />开始采集</button>
        <button onClick={() => command("pause", undefined, "暂停采集命令已发送")}><Pause size={16} />暂停采集</button>
        <button onClick={() => command("stop", undefined, "停止采集命令已发送")}><Square size={16} />停止采集</button>
        <button onClick={() => command("diagnose", undefined, "连接诊断命令已发送")}><Radio size={16} />测试连接</button>
        <button onClick={() => command("test-collect", undefined, "测试采集一次命令已发送")}><Search size={16} />测试采集一次</button>
        <button onClick={() => command("test-scroll", undefined, "测试滚动一次命令已发送")}><Zap size={16} />测试滚动一次</button>
        <button onClick={clearData}><Trash2 size={16} />清空数据</button>
        <button onClick={() => command("export-xlsx")}><FileSpreadsheet size={16} />导出 Excel</button>
        <button onClick={() => command("export-csv")}><Download size={16} />导出 CSV</button>
        <button onClick={() => command("open-data-dir")}><FolderOpen size={16} />数据目录</button>
        <button onClick={() => command("open-log-folder")}><FolderOpen size={16} />日志文件夹</button>
        <button onClick={() => command("clear-logs")}><Trash2 size={16} />清空日志</button>
        <button onClick={testSound}><Volume2 size={16} />测试声音</button>
        <button onClick={testFlash}><Bell size={16} />测试闪动</button>
        <button onClick={toggleTranslation}><Download size={16} />实时翻译：{draftSettings.translation.enabled ? "开启" : "关闭"}</button>
        <button onClick={() => setTranslationOpen(!translationOpen)}><Save size={16} />翻译设置</button>
      </section>

      {translationOpen && <section className="panel">
        <div className="panel-head"><h2>翻译设置</h2><span>{draftSettings.translation.apiKey || draftSettings.translation.apiType === "local" ? "已配置" : "未配置"}</span></div>
        <div className="settings-grid">
          <label className="field"><span>启用实时翻译</span><input type="checkbox" checked={draftSettings.translation.enabled} onChange={(event) => updateSettings((settings) => ({ ...settings, translation: { ...settings.translation, enabled: event.target.checked } }))} /></label>
          <label className="field"><span>API 类型</span><select value={draftSettings.translation.apiType} onChange={(event) => updateSettings((settings) => ({ ...settings, translation: { ...settings.translation, apiType: event.target.value as RadarSettings["translation"]["apiType"] } }))}><option value="openai">OpenAI</option><option value="openai-compatible">OpenAI Compatible</option><option value="local">Local API</option></select></label>
          <label className="field"><span>API Key</span><input type="password" value={draftSettings.translation.apiKey} onChange={(event) => updateSettings((settings) => ({ ...settings, translation: { ...settings.translation, apiKey: event.target.value } }))} placeholder="sk-..." /></label>
          <label className="field"><span>Base URL</span><input value={draftSettings.translation.baseUrl} onChange={(event) => updateSettings((settings) => ({ ...settings, translation: { ...settings.translation, baseUrl: event.target.value } }))} /></label>
          <label className="field"><span>Model</span><input value={draftSettings.translation.model} onChange={(event) => updateSettings((settings) => ({ ...settings, translation: { ...settings.translation, model: event.target.value } }))} /></label>
          <label className="field"><span>目标语言</span><input value={draftSettings.translation.targetLanguage} onChange={(event) => updateSettings((settings) => ({ ...settings, translation: { ...settings.translation, targetLanguage: event.target.value } }))} /></label>
        </div>
        <div className="inline-actions">
          <button onClick={saveSettings}><Save size={16} />保存翻译设置</button>
          <button onClick={() => command("test-translation", undefined, "测试翻译命令已发送")}><Radio size={16} />测试翻译</button>
        </div>
      </section>}

      <section className="split">
        <div className="panel">
          <div className="panel-head"><h2>自动滚动</h2><span>{scrollCount} 次</span></div>
          <div className="segmented">{[3, 5, 8, 10, 999].map((count) => <button className={scrollCount === count ? "active" : ""} key={count} onClick={() => setScrollCount(count)}>{count === 999 ? "长时间" : count}</button>)}</div>
          <label className="field"><span>滚动次数</span><input min="1" max="999" type="number" value={scrollCount} onChange={(event) => setScrollCount(Number(event.target.value))} /></label>
          <label className="field"><span>每次等待秒数</span><input min="1" max="30" type="number" value={scrollDelaySeconds} onChange={(event) => setScrollDelaySeconds(Number(event.target.value))} /></label>
          <div className="inline-actions">
            <button onClick={() => command("start-auto-scroll", { count: scrollCount, delayMs: scrollDelaySeconds * 1000 }, `自动滚动命令已发送：0 / ${scrollCount}`)}><Zap size={16} />开始自动滚动</button>
            <button onClick={() => command("stop-auto-scroll", undefined, "自动滚动停止命令已发送")}><Pause size={16} />停止自动滚动</button>
          </div>
        </div>
        <div className="panel">
          <div className="panel-head"><h2>运行日志</h2><span>{state.operationLog[0]?.at || "等待操作"}</span></div>
          <div className="operation-log">
            {(state.operationLog.length ? state.operationLog : [{ at: "--", message: "还没有操作记录", level: "info" as const }]).slice(0, 12).map((item, index) => (
              <div className={`log-line ${item.level}`} key={`${item.at}-${index}`}><span>{item.at}</span>{item.message}</div>
            ))}
          </div>
        </div>
      </section>

      <section className="panel monitor-panel">
        <div className="panel-head"><h2>群组监控</h2><span>第一阶段只监控已经打开的 Facebook 群组页面</span></div>
        <div className="monitor-tools">
          <input value={groupUrl} placeholder="添加已加入群组链接，如 https://www.facebook.com/groups/xxx" onChange={(event) => setGroupUrl(event.target.value)} />
          <button onClick={addGroup}><Plus size={16} />添加并保存群组</button>
          <select value={monitorInterval} onChange={(event) => setMonitorInterval(Number(event.target.value))}><option value={30}>30 秒</option><option value={60}>1 分钟</option><option value={180}>3 分钟</option><option value={300}>5 分钟</option></select>
          <button onClick={() => command("start-group-monitor", { intervalSeconds: monitorInterval }, "群组监控启动命令已发送")}><Play size={16} />开始监控已打开页面</button>
          <button onClick={() => command("stop-group-monitor", undefined, "群组监控停止命令已发送")}><Square size={16} />停止监控</button>
          <button onClick={saveSettings}><Save size={16} />保存群组</button>
        </div>
        <div className="monitor-list">
          {draftSettings.groupMonitor.groups.length === 0 && <div className="empty slim">还没有添加群组链接。也可以直接打开 groups/feed 或单个群组页面后启动监控。</div>}
          {draftSettings.groupMonitor.groups.map((group) => (
            <div className="monitor-row" key={group.id}>
              <input type="checkbox" checked={group.enabled} onChange={(event) => updateGroup(group.id, (item) => ({ ...item, enabled: event.target.checked }))} />
              <input value={group.name} onChange={(event) => updateGroup(group.id, (item) => ({ ...item, name: event.target.value }))} />
              <span>{group.status === "not_open" ? "未打开" : group.status}</span>
              <span>{group.lastCheckedAt || "尚未检查"}</span>
              <button onClick={() => deleteGroup(group.id)}><Trash2 size={16} /></button>
            </div>
          ))}
        </div>
      </section>

      <section className="panel posts-panel">
        <div className="panel-head">
          <h2>实时帖子列表</h2>
          <div className="filters">
            <div className="search"><Search size={16} /><input placeholder="搜索内容、群组、关键词" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
            <select value={sortMode} onChange={(event) => setSortMode(event.target.value as SortMode)}>
              <option value="recommended">综合推荐</option><option value="score">评分最高</option><option value="postTime">发布时间最新</option><option value="collectedAt">采集时间最新</option><option value="alerted">仅看已提醒</option><option value="unhandled">仅看未处理</option><option value="unknown">仅看时间未识别</option>
            </select>
            <select value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)}><option value="all">全部</option><option value="new">只看新帖</option><option value="alerted">只看已提醒</option><option value="unknown">时间未识别</option></select>
          </div>
        </div>
        <div className="table-wrap"><table><thead><tr><th>提醒状态</th><th>评分</th><th>新帖</th><th>群组名称</th><th>发布时间</th><th>内容摘要</th><th>中文翻译</th><th>匹配关键词</th><th>来源窗口</th><th>操作</th></tr></thead><tbody>
          {posts.map((post) => <tr key={post.postId} className={post.alertTriggered || post.isNewPost ? "alert-row" : ""}><td>{post.alertTriggered ? "已提醒" : post.statusNote}</td><td><strong>{post.score}</strong></td><td>{post.isNewPost ? "是" : "否"}</td><td>{post.groupName}</td><td>{post.rawTimeText || post.parsedPostTime || "未识别"}</td><td>{post.postTextPreview}</td><td>{draftSettings.translation.enabled ? "翻译待处理" : "未开启"}</td><td>{post.matchedKeywords.join(", ")}</td><td>{post.sourceWindowId}</td><td className="row-actions"><button title="打开帖子" onClick={() => command("open-url", post.postUrl)}><Eye size={15} /></button><button title="复制链接" onClick={() => { navigator.clipboard.writeText(post.postUrl); command("ui-log", `已复制帖子链接：${post.postUrl}`); notify("链接已复制"); }}><Copy size={15} /></button><button onClick={() => command("mark-handled", post.postId)}>已处理</button><button onClick={() => command("ignore-post", post.postId)}>忽略</button><button onClick={() => { setSelectedPost(post); command("ui-log", `查看帖子详情：${post.postUrl || post.postId}`); }}>详情</button></td></tr>)}
          {posts.length === 0 && <tr><td colSpan={10} className="empty">等待插件发送帖子。请打开 Facebook 群组页面后点击“测试连接”或“开始采集”。</td></tr>}
        </tbody></table></div>
      </section>

      <section className={`panel keyword-panel ${keywordOpen ? "open" : ""}`}>
        <button className="collapse-head" onClick={() => setKeywordOpen(!keywordOpen)}>{keywordOpen ? <ChevronDown size={18} /> : <ChevronRight size={18} />}关键词管理（点击{keywordOpen ? "收缩" : "展开"}）</button>
        {keywordOpen && <>
          <div className="panel-head"><h2>{categoryLabels[keywordCategory]}</h2><div className="segmented">{(Object.keys(categoryLabels) as KeywordCategory[]).map((category) => <button className={keywordCategory === category ? "active" : ""} key={category} onClick={() => setKeywordCategory(category)}>{categoryLabels[category]}</button>)}</div></div>
          <div className="keyword-tools"><input value={newKeyword} placeholder="输入英文关键词" onChange={(event) => setNewKeyword(event.target.value)} onKeyDown={(event) => event.key === "Enter" && addKeyword()} /><button onClick={addKeyword}><Plus size={16} />添加</button><button onClick={saveSettings}><Save size={16} />保存到本地</button><button onClick={() => fileInputRef.current?.click()}><Upload size={16} />导入 JSON</button><button onClick={exportKeywords}><Download size={16} />导出 JSON</button><input ref={fileInputRef} type="file" accept="application/json" hidden onChange={(event) => loadKeywordFile(event.target.files?.[0])} /></div>
          <div className="keyword-import"><textarea value={importText} placeholder="批量导入：一行一个关键词，或用逗号分隔" onChange={(event) => setImportText(event.target.value)} /><button onClick={importKeywords}><Upload size={16} />导入到当前分类</button></div>
          <div className="keyword-list">{draftSettings.keywords.filter((keyword) => keyword.category === keywordCategory).map((keyword) => <div className="keyword-row" key={keyword.id}><input type="checkbox" checked={keyword.enabled} onChange={(event) => updateSettings((settings) => ({ ...settings, keywords: settings.keywords.map((item) => item.id === keyword.id ? { ...item, enabled: event.target.checked } : item) }))} /><input value={keyword.text} onChange={(event) => updateSettings((settings) => ({ ...settings, keywords: settings.keywords.map((item) => item.id === keyword.id ? { ...item, text: event.target.value } : item) }))} /><button onClick={() => updateSettings((settings) => ({ ...settings, keywords: settings.keywords.filter((item) => item.id !== keyword.id) }))}><Trash2 size={16} /></button></div>)}</div>
        </>}
      </section>

      {selectedPost && <div className="modal-backdrop" onClick={() => setSelectedPost(null)}><aside className="modal" onClick={(event) => event.stopPropagation()}><button className="close" onClick={() => setSelectedPost(null)}>X</button><h2>帖子详情</h2><dl><dt>完整内容</dt><dd>{selectedPost.postText}</dd><dt>中文翻译</dt><dd>{draftSettings.translation.enabled ? "翻译待处理" : "实时翻译未开启"}</dd><dt>群组</dt><dd>{selectedPost.groupName}</dd><dt>发帖人</dt><dd>{selectedPost.authorName || "未识别"}</dd><dt>原始时间</dt><dd>{selectedPost.rawTimeText || "未识别"}</dd><dt>解析时间</dt><dd>{selectedPost.parsedPostTime}</dd><dt>评分</dt><dd>{selectedPost.score}</dd><dt>匹配关键词</dt><dd>{selectedPost.matchedKeywords.join(", ") || "无"}</dd><dt>排除关键词</dt><dd>{selectedPost.negativeKeywords.join(", ") || "无"}</dd><dt>评分原因</dt><dd>{selectedPost.scoreReasons.join("；") || "无"}</dd><dt>链接</dt><dd>{selectedPost.postUrl}</dd></dl><div className="inline-actions"><button onClick={() => command("open-url", selectedPost.postUrl)}>打开帖子</button><button onClick={() => { navigator.clipboard.writeText(selectedPost.postUrl); command("ui-log", `已复制帖子链接：${selectedPost.postUrl}`); }}>复制链接</button><button onClick={() => command("mark-handled", selectedPost.postId)}>标记已处理</button></div></aside></div>}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
