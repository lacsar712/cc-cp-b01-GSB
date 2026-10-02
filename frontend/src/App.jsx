import { useCallback, useEffect, useState } from "preact/hooks";

const TOKEN_KEY = "coldchain_token";
const USER_KEY = "coldchain_user";

function verdictClass(v, status) {
  if (v === "合格") return "tag pass";
  if (v === "超温") return "tag fail";
  if (status === "pending" || status === "processing") return "tag wait";
  return "tag wait";
}

function displayVerdict(row) {
  if (row.verdict) return row.verdict;
  if (row.status === "pending") return "待处理";
  if (row.status === "processing") return "处理中";
  return "—";
}

const ACTION_TEXT = { add: "新增", rename: "改名", remove: "删除" };

export function App() {
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY));
  const [user, setUser] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(USER_KEY) || "null");
    } catch {
      return null;
    }
  });
  const [view, setView] = useState("wall");
  const [loginForm, setLoginForm] = useState({ username: "logger", password: "log123456" });
  const [submitForm, setSubmitForm] = useState({ probe_id: "", temp_c: "" });
  const [aliasForm, setAliasForm] = useState({ probe_id: "", alias: "" });
  const [rows, setRows] = useState([]);
  const [wall, setWall] = useState([]);
  const [logs, setLogs] = useState([]);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(false);

  const authHeaders = useCallback(() => {
    const h = { "Content-Type": "application/json" };
    if (token) h.Authorization = `Bearer ${token}`;
    return h;
  }, [token]);

  const loadReadings = useCallback(async () => {
    if (!token) return;
    const res = await fetch("/api/readings", { headers: authHeaders() });
    if (!res.ok) {
      setError("加载列表失败，请重新登录");
      return;
    }
    setRows(await res.json());
  }, [token, authHeaders]);

  const loadWall = useCallback(async () => {
    if (!token) return;
    const res = await fetch("/api/probes/wall", { headers: authHeaders() });
    if (!res.ok) return;
    setWall(await res.json());
  }, [token, authHeaders]);

  const loadLogs = useCallback(async () => {
    if (!token) return;
    const res = await fetch("/api/probes/alias-logs", { headers: authHeaders() });
    if (!res.ok) return;
    setLogs(await res.json());
  }, [token, authHeaders]);

  const loadWallData = useCallback(() => {
    loadWall();
    loadLogs();
  }, [loadWall, loadLogs]);

  useEffect(() => {
    if (!token) return undefined;
    loadReadings();
    const t = setInterval(loadReadings, 3000);
    return () => clearInterval(t);
  }, [loadReadings, token]);

  useEffect(() => {
    if (!token || view !== "wall") return undefined;
    loadWallData();
    const t = setInterval(loadWallData, 3000);
    return () => clearInterval(t);
  }, [loadWallData, token, view]);

  async function onLogin(e) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(loginForm),
      });
      if (!res.ok) {
        setError("用户名或密码错误");
        return;
      }
      const data = await res.json();
      localStorage.setItem(TOKEN_KEY, data.access_token);
      localStorage.setItem(
        USER_KEY,
        JSON.stringify({ username: data.username, role: data.role })
      );
      setToken(data.access_token);
      setUser({ username: data.username, role: data.role });
      setView("wall");
    } finally {
      setLoading(false);
    }
  }

  function logout() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    setToken(null);
    setUser(null);
    setRows([]);
    setWall([]);
    setLogs([]);
  }

  async function onSubmit(e) {
    e.preventDefault();
    setError("");
    setMsg("");
    setLoading(true);
    try {
      const res = await fetch("/api/readings", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          probe_id: submitForm.probe_id,
          temp_c: parseFloat(submitForm.temp_c),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.detail || "提交失败");
        return;
      }
      setMsg(data.message || "已提交");
      setSubmitForm({ probe_id: "", temp_c: "" });
      await loadReadings();
    } finally {
      setLoading(false);
    }
  }

  async function onSaveAlias(e) {
    e.preventDefault();
    setError("");
    setMsg("");
    setLoading(true);
    try {
      const res = await fetch("/api/probes/aliases", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(aliasForm),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.detail || "保存别名失败");
        return;
      }
      setMsg(data.message || "别名已保存");
      setAliasForm({ probe_id: "", alias: "" });
      loadWallData();
      loadReadings();
    } finally {
      setLoading(false);
    }
  }

  async function onDeleteAlias(probeId) {
    setError("");
    setMsg("");
    const res = await fetch(
      `/api/probes/${encodeURIComponent(probeId)}/alias`,
      { method: "DELETE", headers: authHeaders() }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data.detail || "删除别名失败");
      return;
    }
    setMsg(data.message || "别名已删除");
    if (aliasForm.probe_id === probeId) {
      setAliasForm({ probe_id: "", alias: "" });
    }
    loadWallData();
    loadReadings();
  }

  if (!token) {
    return (
      <div class="wrap">
        <h1>冷链探头超温台</h1>
        <p class="sub">记录员提交探头编号与摄氏温度，后台工人认领后判定合格或超温。</p>
        <div class="card">
          <form onSubmit={onLogin}>
            <div class="row">
              <label>
                用户名
                <input
                  value={loginForm.username}
                  onInput={(e) =>
                    setLoginForm({ ...loginForm, username: e.target.value })
                  }
                />
              </label>
              <label>
                密码
                <input
                  type="password"
                  value={loginForm.password}
                  onInput={(e) =>
                    setLoginForm({ ...loginForm, password: e.target.value })
                  }
                />
              </label>
              <button type="submit" disabled={loading}>
                登录
              </button>
            </div>
            {error && <p class="err">{error}</p>}
          </form>
          <p class="sub" style={{ marginBottom: 0 }}>
            记录员 logger / log123456 · 值班员 watcher / watch123456
          </p>
        </div>
      </div>
    );
  }

  const isWriter = user?.role === "writer";

  return (
    <div class="wrap">
      <div class="topbar">
        <div>
          <h1>冷链探头超温台</h1>
          <nav class="nav">
            <button
              type="button"
              class={view === "wall" ? "navbtn active" : "navbtn"}
              onClick={() => setView("wall")}
            >
              别名墙
            </button>
            <button
              type="button"
              class={view === "wall" ? "navbtn" : "navbtn active"}
              onClick={() => setView("readings")}
            >
              读数列表
            </button>
          </nav>
        </div>
        <div class="user">
          {user?.username}（{isWriter ? "记录员" : "值班员"}）
          <button type="button" class="secondary" style={{ marginLeft: "0.5rem" }} onClick={logout}>
            退出
          </button>
        </div>
      </div>

      {error && <p class="err">{error}</p>}
      {msg && <p class="ok">{msg}</p>}

      {view === "wall" && (
        <div class="wallgrid">
          <div class="col">
            <div class="card">
              <h2 style={{ marginTop: 0, fontSize: "1.1rem" }}>
                维护代号与别名
              </h2>
              {isWriter ? (
                <form onSubmit={onSaveAlias}>
                  <div class="stack">
                    <label>
                      探头代号
                      <input
                        required
                        value={aliasForm.probe_id}
                        onInput={(e) =>
                          setAliasForm({ ...aliasForm, probe_id: e.target.value })
                        }
                        placeholder="例如 探头A01"
                      />
                    </label>
                    <label>
                      对外别名
                      <input
                        required
                        value={aliasForm.alias}
                        onInput={(e) =>
                          setAliasForm({ ...aliasForm, alias: e.target.value })
                        }
                        placeholder="例如 冷柜甲"
                      />
                    </label>
                    <button type="submit" disabled={loading}>
                      保存别名
                    </button>
                  </div>
                  <p class="sub" style={{ marginBottom: 0, fontSize: "0.8rem" }}>
                    同一代号重复保存即改名，所有操作自动记入下方流水。
                  </p>
                </form>
              ) : (
                <p class="sub" style={{ marginBottom: 0 }}>
                  值班员仅可查看卡片墙与改名流水，别名维护请联系记录员。
                </p>
              )}
            </div>

            <div class="card">
              <h2 style={{ marginTop: 0, fontSize: "1.1rem" }}>现有别名</h2>
              <table>
                <thead>
                  <tr>
                    <th>代号</th>
                    <th>别名</th>
                    {isWriter && <th>操作</th>}
                  </tr>
                </thead>
                <tbody>
                  {wall.map((c) => (
                    <tr key={c.probe_id}>
                      <td>{c.probe_id}</td>
                      <td>{c.alias || "—"}</td>
                      {isWriter && (
                        <td>
                          <button
                            type="button"
                            class="mini"
                            onClick={() =>
                              setAliasForm({ probe_id: c.probe_id, alias: c.alias || "" })
                            }
                          >
                            改
                          </button>
                          {c.alias && (
                            <button
                              type="button"
                              class="mini danger"
                              onClick={() => onDeleteAlias(c.probe_id)}
                            >
                              删
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                  {wall.length === 0 && (
                    <tr>
                      <td colspan={isWriter ? "3" : "2"}>暂无探头</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div class="col">
            <div class="card">
              <h2 style={{ marginTop: 0, fontSize: "1.1rem" }}>卡片墙</h2>
              <div class="cards">
                {wall.map((c) => (
                  <div class="probe-card" key={c.probe_id}>
                    <div class="probe-name">{c.display_name}</div>
                    <div class="probe-code">代号：{c.probe_id}</div>
                    {c.latest && (
                      <div class="probe-latest">
                        <span class={verdictClass(c.latest.verdict, c.latest.status)}>
                          {displayVerdict(c.latest)}
                        </span>
                        <span>
                          最近 {c.latest.temp_c}℃
                        </span>
                      </div>
                    )}
                    {!c.latest && <div class="probe-code">暂无读数</div>}
                  </div>
                ))}
                {wall.length === 0 && <p class="sub" style={{ marginBottom: 0 }}>暂无卡片</p>}
              </div>
            </div>

            <div class="card">
              <h2 style={{ marginTop: 0, fontSize: "1.1rem" }}>改名流水</h2>
              <table>
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>代号</th>
                    <th>动作</th>
                    <th>旧别名</th>
                    <th>新别名</th>
                    <th>操作人</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map((l) => (
                    <tr key={l.id}>
                      <td>{l.created_at ? l.created_at.replace("T", " ").slice(0, 19) : "—"}</td>
                      <td>{l.probe_id}</td>
                      <td>{ACTION_TEXT[l.action] || l.action}</td>
                      <td>{l.old_alias || "—"}</td>
                      <td>{l.new_alias || "—"}</td>
                      <td>{l.operator}</td>
                    </tr>
                  ))}
                  {logs.length === 0 && (
                    <tr>
                      <td colspan="6">暂无流水</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {view === "readings" && (
        <>
          {isWriter && (
            <div class="card">
              <h2 style={{ marginTop: 0, fontSize: "1.1rem" }}>提交读数</h2>
              <form onSubmit={onSubmit}>
                <div class="row">
                  <label>
                    探头编号
                    <input
                      required
                      value={submitForm.probe_id}
                      onInput={(e) =>
                        setSubmitForm({ ...submitForm, probe_id: e.target.value })
                      }
                      placeholder="例如 探头C03"
                    />
                  </label>
                  <label>
                    温度（℃）
                    <input
                      required
                      type="number"
                      step="0.1"
                      value={submitForm.temp_c}
                      onInput={(e) =>
                        setSubmitForm({ ...submitForm, temp_c: e.target.value })
                      }
                    />
                  </label>
                  <button type="submit" disabled={loading}>
                    提交
                  </button>
                </div>
              </form>
            </div>
          )}

          <div class="card">
            <h2 style={{ marginTop: 0, fontSize: "1.1rem" }}>读数列表</h2>
            <table>
              <thead>
                <tr>
                  <th>编号</th>
                  <th>探头</th>
                  <th>温度℃</th>
                  <th>结论</th>
                  <th>说明</th>
                  <th>状态</th>
                  <th>提交人</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>{r.id}</td>
                    <td>{r.display_name}</td>
                    <td>{r.temp_c}</td>
                    <td>
                      <span class={verdictClass(r.verdict, r.status)}>
                        {displayVerdict(r)}
                      </span>
                    </td>
                    <td>{r.reason || "—"}</td>
                    <td>{r.status}</td>
                    <td>{r.created_by}</td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colspan="7">暂无数据</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
