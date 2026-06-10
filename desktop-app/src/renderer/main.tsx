import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Bell,
  Download,
  Eye,
  FileSpreadsheet,
  FolderOpen,
  Pause,
  Play,
  Plus,
  Radio,
  Save,
  Search,
  Square,
  Trash2,
  Upload,
  Volume2,
  Zap
} from "lucide-react";
import type { ExtensionClientInfo, KeywordItem, RadarPost, RadarSettings, RadarStats } from "@foradar/shared";
import { defaultSettings } from "@foradar/shared";
import "./styles.css";

type CollectionState = "collecting" | "paused" | "stopped";
type KeywordCategory = KeywordItem["category"];

interface AppState {
  posts: RadarPost[];
  settings: RadarSettings;
  collectionState: CollectionState;
  stats: RadarStats;
  clients: ExtensionClientInfo[];
}

const emptyStats: RadarStats = {
  totalPosts: 0,
  newPosts: 0,
  todayPosts: 0,
  alertedPosts: 0,
  unknownTimePosts: 0,
  connectedClients: 0
};

const categoryLabels: Record<KeywordCategory, string> = {
  highValue: "高价值关键词",
  normal: "普通关键词",
  negative: "排除关键词"
};

function createKeyword(text: string, category: KeywordCategory): KeywordItem {
  return {
    id: `${category}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    text: text.trim(),
    category,
    enabled: true
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
  return (
    <div className="stat-card">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function App() {
  const [state, setState] = useState<AppState>({
    posts: [],
    settings: defaultSettings,
    collectionState: "stopped",
    stats: emptyStats,
    clients: []
  });
  const [draftSettings, setDraftSettings] = useState<RadarSettings>(defaultSettings);
  const [socketReady, setSocketReady] = useState(false);
  const [scrollCount, setScrollCount] = useState(defaultSettings.autoScroll.defaultScrollCount);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "new" | "alerted" | "unknown">("all");
  const [keywordCategory, setKeywordCategory] = useState<KeywordCategory>("highValue");
  const [newKeyword, setNewKeyword] = useState("");
  const [importText, setImportText] = useState("");
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
          setState((previous) => ({ ...previous, ...message.payload }));
          setDraftSettings(message.payload.settings);
          setScrollCount(message.payload.settings.autoScroll.defaultScrollCount);
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

  const command = async (name: string, payload?: unknown) => {
    await window.radarApi?.command(name, payload);
  };

  const posts = useMemo(() => {
    return state.posts.filter((post) => {
      if (filter === "new" && !post.isNewPost) return false;
      if (filter === "alerted" && !post.alertTriggered) return false;
      if (filter === "unknown" && post.timeConfidence !== "unknown") return false;
      const text = `${post.groupName} ${post.postText} ${post.matchedKeywords.join(" ")}`.toLowerCase();
      return text.includes(query.toLowerCase());
    });
  }, [filter, query, state.posts]);

  const keywordsByCategory = useMemo(() => {
    return draftSettings.keywords.filter((keyword) => keyword.category === keywordCategory);
  }, [draftSettings.keywords, keywordCategory]);

  const updateSettings = (updater: (settings: RadarSettings) => RadarSettings) => {
    setDraftSettings((settings) => updater(structuredClone(settings)));
  };

  const addKeyword = () => {
    const text = newKeyword.trim();
    if (!text) return;
    updateSettings((settings) => ({
      ...settings,
      keywords: [...settings.keywords, createKeyword(text, keywordCategory)]
    }));
    setNewKeyword("");
  };

  const importKeywords = () => {
    const words = importText.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean);
    if (words.length === 0) return;
    updateSettings((settings) => ({
      ...settings,
      keywords: [...settings.keywords, ...words.map((word) => createKeyword(word, keywordCategory))]
    }));
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
    const text = await file.text();
    const parsed = JSON.parse(text) as KeywordItem[];
    updateSettings((settings) => ({
      ...settings,
      keywords: parsed.map((keyword) => ({ ...keyword, id: keyword.id || createKeyword(keyword.text, keyword.category).id }))
    }));
  };

  const saveSettings = async () => {
    const nextSettings = {
      ...draftSettings,
      autoScroll: { ...draftSettings.autoScroll, defaultScrollCount: scrollCount }
    };
    setDraftSettings(nextSettings);
    await command("update-settings", nextSettings);
  };

  return (
    <main>
      <header className="topbar">
        <div>
          <h1>Facebook Opportunity Radar</h1>
          <p>采集当前可见帖子，按关键词和时间评分，筛选潜在采购需求。</p>
        </div>
        <div className={`connection ${socketReady ? "online" : "offline"}`}>
          <Radio size={18} />
          {socketReady ? "本地服务已连接" : "本地服务未连接"}
        </div>
      </header>

      <section className="status-grid">
        <div className="panel compact">
          <h2>插件连接</h2>
          <strong>{state.stats.connectedClients > 0 ? "插件已连接" : "插件未连接"}</strong>
          <span>当前连接数：{state.stats.connectedClients}</span>
        </div>
        <div className="panel compact">
          <h2>采集状态</h2>
          <strong>{state.collectionState === "collecting" ? "正在采集" : state.collectionState === "paused" ? "已暂停" : "已停止"}</strong>
          <span>服务端口：127.0.0.1:8765</span>
        </div>
        <StatCard label="已采集帖子" value={state.stats.totalPosts} />
        <StatCard label="新帖数量" value={state.stats.newPosts} />
        <StatCard label="今日采集" value={state.stats.todayPosts} />
        <StatCard label="已提醒" value={state.stats.alertedPosts} />
        <StatCard label="时间未识别" value={state.stats.unknownTimePosts} />
      </section>

      <section className="toolbar">
        <button onClick={() => command("start")}><Play size={16} />开始采集</button>
        <button onClick={() => command("pause")}><Pause size={16} />暂停采集</button>
        <button onClick={() => command("stop")}><Square size={16} />停止采集</button>
        <button onClick={() => command("clear")}><Trash2 size={16} />清空数据</button>
        <button onClick={() => command("export-xlsx")}><FileSpreadsheet size={16} />导出 Excel</button>
        <button onClick={() => command("export-csv")}><Download size={16} />导出 CSV</button>
        <button onClick={() => command("open-data-dir")}><FolderOpen size={16} />数据目录</button>
        <button onClick={() => command("test-sound")}><Volume2 size={16} />测试声音</button>
        <button onClick={() => command("test-flash")}><Bell size={16} />测试闪动</button>
      </section>

      <section className="split">
        <div className="panel">
          <div className="panel-head">
            <h2>自动滚动</h2>
            <span>{scrollCount === 999 ? "长时间模式" : `${scrollCount} 次`}</span>
          </div>
          <div className="segmented">
            {[3, 5, 8, 10, 999].map((count) => (
              <button className={scrollCount === count ? "active" : ""} key={count} onClick={() => setScrollCount(count)}>
                {count === 999 ? "长时间" : count}
              </button>
            ))}
          </div>
          <label className="field">
            <span>滚动次数</span>
            <input min="1" max="999" type="number" value={scrollCount} onChange={(event) => setScrollCount(Number(event.target.value))} />
          </label>
          <div className="inline-actions">
            <button onClick={() => command("start-auto-scroll", { count: scrollCount })}><Zap size={16} />开始自动滚动</button>
            <button onClick={() => command("stop-auto-scroll")}><Square size={16} />停止自动滚动</button>
          </div>
        </div>

        <div className="panel">
          <div className="panel-head">
            <h2>提醒规则</h2>
            <span>{draftSettings.alerts.minimumScore} 分起提醒</span>
          </div>
          <div className="settings-grid">
            <label><span>新帖范围</span><select value={draftSettings.alerts.newPostMinutes} onChange={(event) => updateSettings((settings) => ({ ...settings, alerts: { ...settings.alerts, newPostMinutes: Number(event.target.value) as 1 | 3 | 5 | 10 } }))}><option value={1}>1 分钟</option><option value={3}>3 分钟</option><option value={5}>5 分钟</option><option value={10}>10 分钟</option></select></label>
            <label><span>最低分数</span><select value={draftSettings.alerts.minimumScore} onChange={(event) => updateSettings((settings) => ({ ...settings, alerts: { ...settings.alerts, minimumScore: Number(event.target.value) as 60 | 70 | 80 } }))}><option value={60}>60</option><option value={70}>70</option><option value={80}>80</option></select></label>
            <label><input type="checkbox" checked={draftSettings.alerts.soundEnabled} onChange={(event) => updateSettings((settings) => ({ ...settings, alerts: { ...settings.alerts, soundEnabled: event.target.checked } }))} />声音提醒</label>
            <label><input type="checkbox" checked={draftSettings.alerts.flashWindowEnabled} onChange={(event) => updateSettings((settings) => ({ ...settings, alerts: { ...settings.alerts, flashWindowEnabled: event.target.checked } }))} />窗口闪动</label>
            <label><input type="checkbox" checked={draftSettings.alerts.desktopNotificationEnabled} onChange={(event) => updateSettings((settings) => ({ ...settings, alerts: { ...settings.alerts, desktopNotificationEnabled: event.target.checked } }))} />桌面通知</label>
            <label><input type="checkbox" checked={draftSettings.alerts.ignoreNegativeKeywordPosts} onChange={(event) => updateSettings((settings) => ({ ...settings, alerts: { ...settings.alerts, ignoreNegativeKeywordPosts: event.target.checked } }))} />排除负面关键词</label>
          </div>
          <button onClick={saveSettings}><Save size={16} />保存设置</button>
        </div>
      </section>

      <section className="panel keyword-panel">
        <div className="panel-head">
          <h2>关键词管理</h2>
          <div className="segmented">
            {(Object.keys(categoryLabels) as KeywordCategory[]).map((category) => (
              <button className={keywordCategory === category ? "active" : ""} key={category} onClick={() => setKeywordCategory(category)}>
                {categoryLabels[category]}
              </button>
            ))}
          </div>
        </div>
        <div className="keyword-tools">
          <input value={newKeyword} placeholder="输入英文关键词" onChange={(event) => setNewKeyword(event.target.value)} onKeyDown={(event) => event.key === "Enter" && addKeyword()} />
          <button onClick={addKeyword}><Plus size={16} />添加</button>
          <button onClick={saveSettings}><Save size={16} />保存到本地</button>
          <button onClick={() => fileInputRef.current?.click()}><Upload size={16} />导入 JSON</button>
          <button onClick={exportKeywords}><Download size={16} />导出 JSON</button>
          <input ref={fileInputRef} type="file" accept="application/json" hidden onChange={(event) => loadKeywordFile(event.target.files?.[0])} />
        </div>
        <div className="keyword-import">
          <textarea value={importText} placeholder="批量导入：一行一个关键词，或用逗号分隔" onChange={(event) => setImportText(event.target.value)} />
          <button onClick={importKeywords}><Upload size={16} />导入到当前分类</button>
        </div>
        <div className="keyword-list">
          {keywordsByCategory.map((keyword) => (
            <div className="keyword-row" key={keyword.id}>
              <input type="checkbox" checked={keyword.enabled} onChange={(event) => updateSettings((settings) => ({ ...settings, keywords: settings.keywords.map((item) => item.id === keyword.id ? { ...item, enabled: event.target.checked } : item) }))} />
              <input value={keyword.text} onChange={(event) => updateSettings((settings) => ({ ...settings, keywords: settings.keywords.map((item) => item.id === keyword.id ? { ...item, text: event.target.value } : item) }))} />
              <button onClick={() => updateSettings((settings) => ({ ...settings, keywords: settings.keywords.filter((item) => item.id !== keyword.id) }))}><Trash2 size={16} /></button>
            </div>
          ))}
        </div>
      </section>

      <section className="panel posts-panel">
        <div className="panel-head">
          <h2>实时帖子列表</h2>
          <div className="filters">
            <div className="search"><Search size={16} /><input placeholder="搜索内容、群组、关键词" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
            <select value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)}>
              <option value="all">全部</option>
              <option value="new">只看新帖</option>
              <option value="alerted">只看已提醒</option>
              <option value="unknown">时间未识别</option>
            </select>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>状态</th><th>评分</th><th>新帖</th><th>群组</th><th>内容摘要</th><th>原始时间</th><th>解析时间</th><th>关键词</th><th>提醒</th><th>采集时间</th><th>来源</th><th>操作</th></tr></thead>
            <tbody>
              {posts.map((post) => (
                <tr key={post.postId} className={post.alertTriggered ? "alert-row" : ""}>
                  <td>{post.statusNote}</td><td><strong>{post.score}</strong></td><td>{post.isNewPost ? "是" : "否"}</td><td>{post.groupName}</td><td>{post.postTextPreview}</td><td>{post.rawTimeText || "未识别"}</td><td>{post.parsedPostTime}</td><td>{post.matchedKeywords.join(", ")}</td><td>{post.alertTriggered ? "是" : "否"}</td><td>{post.collectedAt}</td><td>{post.sourceWindowId}</td>
                  <td className="row-actions"><button title="打开帖子" onClick={() => command("open-url", post.postUrl)}><Eye size={15} /></button><button onClick={() => setSelectedPost(post)}>详情</button></td>
                </tr>
              ))}
              {posts.length === 0 && <tr><td colSpan={12} className="empty">等待插件发送测试帖子，或在 Facebook 群组页面点击采集。</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      {selectedPost && (
        <aside className="drawer">
          <button className="close" onClick={() => setSelectedPost(null)}>关闭</button>
          <h2>帖子详情</h2>
          <dl>
            <dt>完整内容</dt><dd>{selectedPost.postText}</dd>
            <dt>链接</dt><dd>{selectedPost.postUrl}</dd>
            <dt>发帖人</dt><dd>{selectedPost.authorName || "未识别"}</dd>
            <dt>群组</dt><dd>{selectedPost.groupName}</dd>
            <dt>原始时间</dt><dd>{selectedPost.rawTimeText || "未识别"}</dd>
            <dt>解析时间</dt><dd>{selectedPost.parsedPostTime}</dd>
            <dt>匹配关键词</dt><dd>{selectedPost.matchedKeywords.join(", ") || "无"}</dd>
            <dt>排除关键词</dt><dd>{selectedPost.negativeKeywords.join(", ") || "无"}</dd>
            <dt>评分原因</dt><dd>{selectedPost.scoreReasons.join("；") || "无"}</dd>
            <dt>状态备注</dt><dd>{selectedPost.statusNote}</dd>
          </dl>
        </aside>
      )}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
