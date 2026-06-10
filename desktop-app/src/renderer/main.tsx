import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Bell,
  Download,
  Eye,
  FileSpreadsheet,
  FolderOpen,
  Pause,
  Play,
  Radio,
  Search,
  Square,
  Trash2,
  Volume2,
  Zap
} from "lucide-react";
import type { ExtensionClientInfo, RadarPost, RadarSettings, RadarStats } from "@foradar/shared";
import { defaultSettings } from "@foradar/shared";
import "./styles.css";

// ==================== 类型声明 ====================
declare global {
  interface Window {
    radarApi?: {
      onAlertSound: (callback: () => void) => void;
      command: (name: string, payload?: unknown) => void;
    };
  }
}

type CollectionState = "collecting" | "paused" | "stopped";

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

// ==================== 辅助函数 ====================
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
  } catch (e) {
    console.warn("AudioContext failed", e);
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

// ==================== 主组件 ====================
function App() {
  const [state, setState] = useState<AppState>({
    posts: [],
    settings: defaultSettings,
    collectionState: "stopped",
    stats: emptyStats,
    clients: []
  });
  const [socketReady, setSocketReady] = useState(false);
  const [scrollCount, setScrollCount] = useState(5);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "new" | "alerted" | "unknown">("all");
  const [selectedPost, setSelectedPost] = useState<RadarPost | null>(null);

  // WebSocket 连接（带自动重连）
  useEffect(() => {
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      socket = new WebSocket("ws://127.0.0.1:8765?role=renderer");

      socket.addEventListener("open", () => {
        setSocketReady(true);
        console.log("WebSocket connected");
      });

      socket.addEventListener("message", (event) => {
        try {
          const message = JSON.parse(event.data);
          if (message.type === "state") {
            setState((prev) => ({ ...prev, ...message.payload }));
          }
        } catch (err) {
          console.error("Failed to parse WebSocket message", err);
        }
      });

      socket.addEventListener("close", () => {
        setSocketReady(false);
        console.log("WebSocket disconnected, reconnecting in 1s...");
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connect, 1000);
      });

      socket.addEventListener("error", (err) => {
        console.error("WebSocket error", err);
        socket?.close();
      });
    };

    connect();

    return () => {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (socket) {
        socket.close();
        socket = null;
      }
    };
  }, []); // 只在挂载时执行一次

  // 注册声音提醒回调（如果 Electron API 可用）
  useEffect(() => {
    if (window.radarApi && typeof window.radarApi.onAlertSound === "function") {
      window.radarApi.onAlertSound(playBeep);
    } else {
      console.warn("radarApi not available, sound alerts disabled");
    }
  }, []);

  // 发送命令的包装函数（防御性）
  const command = (name: string, payload?: unknown) => {
    if (window.radarApi?.command) {
      window.radarApi.command(name, payload);
    } else {
      console.warn(`radarApi.command("${name}") 不可用`);
    }
  };

  // 过滤帖子
  const posts = useMemo(() => {
    return state.posts.filter((post) => {
      if (filter === "new" && !post.isNewPost) return false;
      if (filter === "alerted" && !post.alertTriggered) return false;
      if (filter === "unknown" && post.timeConfidence !== "unknown") return false;
      const text = `${post.groupName} ${post.postText} ${post.matchedKeywords.join(" ")}`.toLowerCase();
      return text.includes(query.toLowerCase());
    });
  }, [filter, query, state.posts]);

  return (
    <main>
      <header className="topbar">
        <div>
          <h1>Facebook Opportunity Radar</h1>
          <p>采集当前可见帖子，筛选采购需求，提醒后由你人工打开 Facebook 处理。</p>
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
          <span>当前连接窗口数：{state.stats.connectedClients}</span>
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
                {count === 999 ? "长时间模式" : count}
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
            <span>{state.settings.alerts.minimumScore} 分起提醒</span>
          </div>
          <div className="rule-grid">
            <span>新帖范围</span><strong>{state.settings.alerts.newPostMinutes} 分钟内</strong>
            <span>声音提醒</span><strong>{state.settings.alerts.soundEnabled ? "开启" : "关闭"}</strong>
            <span>窗口闪动</span><strong>{state.settings.alerts.flashWindowEnabled ? "开启" : "关闭"}</strong>
            <span>桌面通知</span><strong>{state.settings.alerts.desktopNotificationEnabled ? "开启" : "关闭"}</strong>
          </div>
        </div>
      </section>

      <section className="panel posts-panel">
        <div className="panel-head">
          <h2>实时帖子列表</h2>
          <div className="filters">
            <div className="search">
              <Search size={16} />
              <input placeholder="搜索内容、群组、关键词" value={query} onChange={(event) => setQuery(event.target.value)} />
            </div>
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
            <thead>
              <tr>
                <th>状态</th>
                <th>评分</th>
                <th>新帖</th>
                <th>群组</th>
                <th>内容摘要</th>
                <th>原始时间</th>
                <th>解析时间</th>
                <th>关键词</th>
                <th>提醒</th>
                <th>采集时间</th>
                <th>来源</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {posts.map((post) => (
                <tr key={post.postId} className={post.alertTriggered ? "alert-row" : ""}>
                  <td>{post.statusNote}</td>
                  <td><strong>{post.score}</strong></td>
                  <td>{post.isNewPost ? "是" : "否"}</td>
                  <td>{post.groupName}</td>
                  <td>{post.postTextPreview}</td>
                  <td>{post.rawTimeText || "时间未识别"}</td>
                  <td>{post.parsedPostTime}</td>
                  <td>{post.matchedKeywords.join(", ")}</td>
                  <td>{post.alertTriggered ? "是" : "否"}</td>
                  <td>{post.collectedAt}</td>
                  <td>{post.sourceWindowId}</td>
                  <td className="row-actions">
                    <button title="打开帖子" onClick={() => command("open-url", post.postUrl)}><Eye size={15} /></button>
                    <button title="查看详情" onClick={() => setSelectedPost(post)}>详情</button>
                  </td>
                </tr>
              ))}
              {posts.length === 0 && (
                <tr>
                  <td colSpan={12} className="empty">等待插件发送测试帖子或 Facebook 当前可见帖子。</td>
                </tr>
              )}
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
            <dt>原始时间</dt><dd>{selectedPost.rawTimeText || "时间未识别"}</dd>
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