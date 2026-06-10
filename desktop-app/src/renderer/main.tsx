import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Bell, ChevronDown, ChevronRight, Copy, Download, Eye, FileSpreadsheet, FolderOpen, Pause, Play, Plus, Radio, Save, Search, Square, Trash2, Upload, Volume2, Zap } from "lucide-react";
import type { CollectionState, ExtensionClientInfo, GroupMonitorItem, KeywordItem, RadarPost, RadarSettings, RadarStats } from "@foradar/shared";
import { defaultSettings } from "@foradar/shared";
import "./styles.css";

type KeywordCategory = KeywordItem["category"];
type OperationLog = { at: string; message: string; level: "info" | "success" | "error" };

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
  error: "异常"
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

function playBeep(): void {
  try {
    const context = new (window.AudioContext || (window as any).webkitAudioContext)();
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
  } catch (error) {
    console.warn("AudioContext failed", error);
  }
}

function StatCard({ label, value }: { label: string; value: number | string }) {
  return <div className="stat-card"><span>{label}</span><strong>{value}</strong></div>;
}

function App() {
  const [state, setState] = useState<AppState>({
    posts: [],
    settings: defaultSettings,
    collectionState: "stopped",
    operationLog: [],
    stats: emptyStats,
    clients: []
  });
  const [draftSettings, setDraftSettings] = useState<RadarSettings>(defaultSettings);
  const [socketReady, setSocketReady] = useState(false);
  const [scrollCount, setScrollCount] = useState(defaultSettings.autoScroll.defaultScrollCount);
  const [monitorInterval, setMonitorInterval] = useState(60);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "new" | "alerted" | "unknown">("all");
  const [keywordOpen, setKeywordOpen] = useState(false);
  const [keywordCategory, setKeywordCategory] = useState<KeywordCategory>("highValue");
  const [newKeyword, setNewKeyword] = useState("");
  const [importText, setImportText] = useState("");
  const [groupUrl, setGroupUrl] = useState("");
  const [toast, setToast] = useState("");
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
    window.radarApi?.onAlertSound(playBeep);
  }, []);

  const notify = (message: string) => {
    setToast(message);
    setTimeout(() => setToast(""), 3200);
  };

  const command = async (name: string, payload?: unknown, feedback?: string) => {
    if (feedback) notify(feedback);
    const result = await window.radarApi?.command(name, payload);
    return result;
  };

  const updateSettings = (updater: (settings: RadarSettings) => RadarSettings) => {
    setDraftSettings((settings) => updater(structuredClone(settings)));
  };

  const saveSettings = async () => {
    const nextSettings = { ...draftSettings, autoScroll: { ...draftSettings.autoScroll, defaultScrollCount: scrollCount }, groupMonitor: { ...draftSettings.groupMonitor, defaultIntervalSeconds: monitorInterval as 30 | 60 | 180 | 300 } };
    setDraftSettings(nextSettings);
    await command("update-settings", nextSettings, "设置已保存到本地配置文件");
  };

  const posts = useMemo(() => {
    return state.posts
      .filter((post) => !post.ignored)
      .filter((post) => {
        if (filter === "new" && !post.isNewPost) return false;
        if (filter === "alerted" && !post.alertTriggered) return false;
        if (filter === "unknown" && post.timeConfidence !== "unknown") return false;
        const text = `${post.groupName} ${post.postText} ${post.matchedKeywords.join(" ")}`.toLowerCase();
        return text.includes(query.toLowerCase());
      })
      .sort((a, b) => b.collectedAt.localeCompare(a.collectedAt));
  }, [filter, query, state.posts]);

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
  };

  const loadKeywordFile = async (file?: File) => {
    if (!file) return;
    const parsed = JSON.parse(await file.text()) as KeywordItem[];
    updateSettings((settings) => ({ ...settings, keywords: parsed }));
  };

  const addGroup = () => {
    if (!groupUrl.trim()) return;
    updateSettings((settings) => ({ ...settings, groupMonitor: { ...settings.groupMonitor, groups: [...settings.groupMonitor.groups, createGroup(groupUrl.trim())] } }));
    setGroupUrl("");
  };

  const connectionHint = state.stats.connectedClients === 0 ? "插件未连接，请确认浏览器插件已安装并打开 Facebook 页面" : "插件已连接，等待 Facebook 页面命令确认";

  return (
    <main>
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
        <button onClick={() => command("stop", undefined, "停止采集命令已发送")}><Square size={16} />停止采集</button>
        <button onClick={() => command("diagnose", undefined, "连接诊断命令已发送")}><Radio size={16} />测试连接</button>
        <button onClick={() => command("test-scroll", undefined, "测试滚动一次命令已发送")}><Zap size={16} />测试滚动一次</button>
        <button onClick={() => command("clear")}><Trash2 size={16} />清空数据</button>
        <button onClick={() => command("export-xlsx")}><FileSpreadsheet size={16} />导出 Excel</button>
        <button onClick={() => command("export-csv")}><Download size={16} />导出 CSV</button>
        <button onClick={() => command("open-data-dir")}><FolderOpen size={16} />数据目录</button>
        <button onClick={() => command("test-sound")}><Volume2 size={16} />测试声音</button>
        <button onClick={() => command("test-flash")}><Bell size={16} />测试闪动</button>
      </section>

      <section className="split">
        <div className="panel">
          <div className="panel-head"><h2>自动滚动</h2><span>{scrollCount} 次</span></div>
          <div className="segmented">{[3, 5, 8, 10, 999].map((count) => <button className={scrollCount === count ? "active" : ""} key={count} onClick={() => setScrollCount(count)}>{count === 999 ? "长时间" : count}</button>)}</div>
          <label className="field"><span>滚动次数</span><input min="1" max="999" type="number" value={scrollCount} onChange={(event) => setScrollCount(Number(event.target.value))} /></label>
          <div className="inline-actions">
            <button onClick={() => command("start-auto-scroll", { count: scrollCount }, `自动滚动已启动，当前滑动次数：0 / ${scrollCount}`)}><Zap size={16} />开始自动滚动</button>
            <button onClick={() => command("stop-auto-scroll", undefined, "自动滚动停止命令已发送")}><Pause size={16} />停止自动滚动</button>
          </div>
        </div>
        <div className="panel">
          <div className="panel-head"><h2>最后一次操作结果</h2><span>{state.operationLog[0]?.at || "等待操作"}</span></div>
          <div className="operation-log">
            {(state.operationLog.length ? state.operationLog : [{ at: "--", message: "还没有操作记录", level: "info" as const }]).slice(0, 8).map((item, index) => (
              <div className={`log-line ${item.level}`} key={`${item.at}-${index}`}><span>{item.at}</span>{item.message}</div>
            ))}
          </div>
        </div>
      </section>

      <section className="panel monitor-panel">
        <div className="panel-head"><h2>群组监控</h2><span>只监控已打开、当前账号可访问的 Facebook 群组页面</span></div>
        <div className="monitor-tools">
          <input value={groupUrl} placeholder="添加已加入群组链接" onChange={(event) => setGroupUrl(event.target.value)} />
          <button onClick={addGroup}><Plus size={16} />添加群组</button>
          <select value={monitorInterval} onChange={(event) => setMonitorInterval(Number(event.target.value))}><option value={30}>30 秒</option><option value={60}>1 分钟</option><option value={180}>3 分钟</option><option value={300}>5 分钟</option></select>
          <button onClick={() => command("start-group-monitor", { intervalSeconds: monitorInterval }, "群组监控启动命令已发送")}><Play size={16} />开始监控已打开页面</button>
          <button onClick={() => command("stop-group-monitor", undefined, "群组监控停止命令已发送")}><Square size={16} />停止监控</button>
          <button onClick={saveSettings}><Save size={16} />保存群组</button>
        </div>
        <div className="monitor-list">
          {draftSettings.groupMonitor.groups.length === 0 && <div className="empty slim">还没有添加群组链接。第一阶段可直接打开群组页面后启动监控。</div>}
          {draftSettings.groupMonitor.groups.map((group) => (
            <div className="monitor-row" key={group.id}>
              <input type="checkbox" checked={group.enabled} onChange={(event) => updateSettings((settings) => ({ ...settings, groupMonitor: { ...settings.groupMonitor, groups: settings.groupMonitor.groups.map((item) => item.id === group.id ? { ...item, enabled: event.target.checked } : item) } }))} />
              <input value={group.name} onChange={(event) => updateSettings((settings) => ({ ...settings, groupMonitor: { ...settings.groupMonitor, groups: settings.groupMonitor.groups.map((item) => item.id === group.id ? { ...item, name: event.target.value } : item) } }))} />
              <span>{group.status === "not_open" ? "未打开" : group.status}</span>
              <span>{group.lastCheckedAt || "尚未检查"}</span>
              <button onClick={() => updateSettings((settings) => ({ ...settings, groupMonitor: { ...settings.groupMonitor, groups: settings.groupMonitor.groups.filter((item) => item.id !== group.id) } }))}><Trash2 size={16} /></button>
            </div>
          ))}
        </div>
      </section>

      <section className="panel posts-panel">
        <div className="panel-head"><h2>实时帖子列表</h2><div className="filters"><div className="search"><Search size={16} /><input placeholder="搜索内容、群组、关键词" value={query} onChange={(event) => setQuery(event.target.value)} /></div><select value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)}><option value="all">全部</option><option value="new">只看新帖</option><option value="alerted">只看已提醒</option><option value="unknown">时间未识别</option></select></div></div>
        <div className="table-wrap"><table><thead><tr><th>提醒状态</th><th>评分</th><th>新帖</th><th>群组名称</th><th>发布时间</th><th>内容摘要</th><th>匹配关键词</th><th>来源窗口</th><th>操作</th></tr></thead><tbody>
          {posts.map((post) => <tr key={post.postId} className={post.alertTriggered || post.isNewPost ? "alert-row" : ""}><td>{post.alertTriggered ? "已提醒" : post.statusNote}</td><td><strong>{post.score}</strong></td><td>{post.isNewPost ? "是" : "否"}</td><td>{post.groupName}</td><td>{post.rawTimeText || post.parsedPostTime || "未识别"}</td><td>{post.postTextPreview}</td><td>{post.matchedKeywords.join(", ")}</td><td>{post.sourceWindowId}</td><td className="row-actions"><button title="打开帖子" onClick={() => command("open-url", post.postUrl)}><Eye size={15} /></button><button title="复制链接" onClick={() => navigator.clipboard.writeText(post.postUrl)}><Copy size={15} /></button><button onClick={() => command("mark-handled", post.postId)}>已处理</button><button onClick={() => command("ignore-post", post.postId)}>忽略</button><button onClick={() => setSelectedPost(post)}>详情</button></td></tr>)}
          {posts.length === 0 && <tr><td colSpan={9} className="empty">等待插件发送帖子。请打开 Facebook 群组页面后点击“测试连接”或“开始采集”。</td></tr>}
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

      {selectedPost && <aside className="drawer"><button className="close" onClick={() => setSelectedPost(null)}>关闭</button><h2>帖子详情</h2><dl><dt>完整内容</dt><dd>{selectedPost.postText}</dd><dt>链接</dt><dd>{selectedPost.postUrl}</dd><dt>发帖人</dt><dd>{selectedPost.authorName || "未识别"}</dd><dt>群组</dt><dd>{selectedPost.groupName}</dd><dt>原始时间</dt><dd>{selectedPost.rawTimeText || "未识别"}</dd><dt>评分原因</dt><dd>{selectedPost.scoreReasons.join("；") || "无"}</dd><dt>状态备注</dt><dd>{selectedPost.statusNote}</dd></dl></aside>}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
