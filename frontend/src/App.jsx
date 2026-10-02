import { useCallback, useEffect, useState } from "preact/hooks";

const TOKEN_KEY = "coldchain_token";
const USER_KEY = "coldchain_user";

function verdictClass(v, status) {
  if (v === "合格") return "tag pass";
  if (v === "超温") return "tag fail";
  return "tag wait";
}

function displayVerdict(row) {
  if (row.verdict) return row.verdict;
  if (row.status === "pending") return "待处理";
  if (row.status === "processing") return "处理中";
  return "—";
}

const ACTION_TEXT = {
  create: "新增别名",
  rename: "改名",
  delete: "删除别名",
};

function fmtTime(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("zh-CN", { hour12: false });
  } catch {
    return iso;
  }
}

export function App() {
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY));
  const [user, setUser] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(USER_KEY) || "null");
    } catch {
      return null;
    }
  });
  const [view, setView] = useState("desk");
  const [loginForm, setLoginForm] = useState({ username: "logger", password: "log123456" });
  const [submitForm, setSubmitForm] = useState({ probe_id: "", temp_c: "" });
  const [rows, setRows] = useState([]);
  const [aliases, setAliases] = useState([]);
  const [cards, setCards] = useState([]);
  const [logs, setLogs] = useState([]);
  const [aliasForm, setAliasForm] = useState({ probe_id: "", alias: "" });
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(false);

  const isWriter = user?.role === "writer";

  const authHeaders = useCallback(() => {
    const h = { "Content-Type": "application/json" };
    if (token) h.Authorization = `Bearer ${token}`;
    return h;
  }, [token]);

  const loadReadings = useCallback(async () => {
    const res = await fetch("/api/readings", { headers: authHeaders() });
    if (res.status === 401) return "expired";
    if (!res.ok) return false;
    setRows(await res.json());
    return true;
  }, [authHeaders]);

  const loadWall = useCallback(async () => {
    const opts = { headers: authHeaders() };
    const [ar, cr, lr] = await Promise.all([
      fetch("/api/aliases", opts),
      fetch("/api/probe-cards", opts),
      fetch("/api/alias-logs", opts),
    ]);
    if (ar.ok) setAliases(await ar.json());
    if (cr.ok) setCards(await cr.json());
    if (lr.ok) setLogs(await lr.json());
    return ar.ok && cr.ok && lr.ok;
  }, [authHeaders]);

  useEffect(() => {
    if (!token) return undefined;
    const load = async () => {
      if ((await loadReadings()) === "expired") {
        setError("登录已失效，请重新登录");
        logout();
        return;
      }
      loadWall();
    };
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [loadReadings, loadWall, token]);

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
    setAliases([]);
    setCards([]);
    setLogs([]);
    setView("desk");
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
      await Promise.all([loadReadings(), loadWall()]);
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
      const res = await fetch("/api/aliases", {
        method: "PUT",
        headers: authHeaders(),
        body: JSON.stringify(aliasForm),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.detail || "保存别名失败");
        return;
      }
      setMsg(
        data.action === "create"
          ? `已为 ${data.probe_id} 挂上别名「${data.alias}」`
          : `已改名为「${data.alias}」`
      );
      setAliasForm({ probe_id: "", alias: "" });
      await Promise.all([loadWall(), loadReadings()]);
    } finally {
      setLoading(false);
    }
  }

  async function onDeleteAlias(probeId, alias) {
    setError("");
    setMsg("");
    const res = await fetch(`/api/aliases/${encodeURIComponent(probeId)}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data.detail || "删除别名失败");
      return;
    }
    setMsg(`已删除 ${probeId} 的别名「${alias}」，卡片回显代号，流水留痕`);
    await Promise.all([loadWall(), loadReadings()]);
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

  return (
    <div class="wrap">
      <div class="topbar">
        <div>
          <h1>冷链探头超温台</h1>
          <p class="sub">温度不超过 8℃ 为合格，否则为超温。</p>
        </div>
        <div class="user">
          <button
            type="button"
            class={view === "desk" ? "" : "secondary"}
            onClick={() => setView("desk")}
          >
            读数台
          </button>
          <button
            type="button"
            class={view === "wall" ? "" : "secondary"}
            style={{ marginLeft: "0.5rem" }}
            onClick={() => setView("wall")}
          >
            别名墙
          </button>
          <span style={{ marginLeft: "0.75rem" }}>
            {user?.username}（{isWriter ? "记录员" : "值班员"}）
          </span>
          <button type="button" class="secondary" style={{ marginLeft: "0.5rem" }} onClick={logout}>
            退出
          </button>
        </div>
      </div>

      {view === "wall" ? (
        <AliasWall
          isWriter={isWriter}
          aliases={aliases}
          cards={cards}
          logs={logs}
          aliasForm={aliasForm}
          setAliasForm={setAliasForm}
          onSaveAlias={onSaveAlias}
          onDeleteAlias={onDeleteAlias}
          loading={loading}
          error={error}
          msg={msg}
        />
      ) : (
        <Desk
          isWriter={isWriter}
          rows={rows}
          submitForm={submitForm}
          setSubmitForm={setSubmitForm}
          onSubmit={onSubmit}
          loading={loading}
          error={error}
          msg={msg}
        />
      )}
    </div>
  );
}

function Desk({
  isWriter,
  rows,
  submitForm,
  setSubmitForm,
  onSubmit,
  loading,
  error,
  msg,
}) {
  return (
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
            {error && <p class="err">{error}</p>}
            {msg && <p class="ok">{msg}</p>}
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
                <td>
                  {/* 显示名直接取接口返回的 display_name，浏览器不私下换字 */}
                  {r.display_name || r.probe_id}
                  {r.alias && <span class="code-note">（{r.probe_id}）</span>}
                </td>
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
  );
}

function AliasWall({
  isWriter,
  aliases,
  cards,
  logs,
  aliasForm,
  setAliasForm,
  onSaveAlias,
  onDeleteAlias,
  loading,
  error,
  msg,
}) {
  return (
    <>
      <div class="wall-grid">
        <div class="card">
          <h2 style={{ marginTop: 0, fontSize: "1.1rem" }}>维护代号与别名</h2>
          {isWriter ? (
            <form onSubmit={onSaveAlias}>
              <div class="row">
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
                  挂别名 / 改名
                </button>
              </div>
            </form>
          ) : (
            <p class="sub" style={{ marginBottom: "0.5rem" }}>
              值班员只读：可查看别名墙与改名流水，不能增改删别名。
            </p>
          )}
          {error && <p class="err">{error}</p>}
          {msg && <p class="ok">{msg}</p>}

          <table style={{ marginTop: "0.75rem" }}>
            <thead>
              <tr>
                <th>代号</th>
                <th>别名</th>
                <th>维护人</th>
                {isWriter && <th>操作</th>}
              </tr>
            </thead>
            <tbody>
              {aliases.map((a) => (
                <tr key={a.probe_id}>
                  <td>{a.probe_id}</td>
                  <td>
                    <span class="alias-tag">{a.alias}</span>
                  </td>
                  <td>{a.created_by}</td>
                  {isWriter && (
                    <td>
                      <button
                        type="button"
                        class="mini"
                        onClick={() =>
                          setAliasForm({ probe_id: a.probe_id, alias: a.alias })
                        }
                      >
                        改名
                      </button>
                      <button
                        type="button"
                        class="mini danger"
                        style={{ marginLeft: "0.4rem" }}
                        onClick={() => onDeleteAlias(a.probe_id, a.alias)}
                      >
                        删除
                      </button>
                    </td>
                  )}
                </tr>
              ))}
              {aliases.length === 0 && (
                <tr>
                  <td colspan={isWriter ? 4 : 3}>尚未挂任何别名，卡片墙显示探头代号。</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div class="card">
          <h2 style={{ marginTop: 0, fontSize: "1.1rem" }}>卡片墙</h2>
          <div class="cards">
            {cards.map((c) => (
              <div class="probe-card" key={c.probe_id}>
                <div class="probe-name">{c.display_name}</div>
                <div class="probe-code">代号：{c.probe_id}</div>
                <div class="probe-temp">
                  {c.temp_c}℃
                  <span class={verdictClass(c.verdict, c.status)} style={{ marginLeft: "0.5rem" }}>
                    {displayVerdict(c)}
                  </span>
                </div>
                <div class="probe-meta">读数 {c.reading_count} 条 · {fmtTime(c.processed_at || c.created_at)}</div>
              </div>
            ))}
            {cards.length === 0 && <p class="sub" style={{ marginBottom: 0 }}>暂无探头读数。</p>}
          </div>
        </div>
      </div>

      <div class="card">
        <h2 style={{ marginTop: 0, fontSize: "1.1rem" }}>改名流水</h2>
        <table>
          <thead>
            <tr>
              <th>#</th>
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
                <td>{l.id}</td>
                <td>{fmtTime(l.created_at)}</td>
                <td>{l.probe_id}</td>
                <td>{ACTION_TEXT[l.action] || l.action}</td>
                <td>{l.old_alias || "—"}</td>
                <td>{l.new_alias || "—"}</td>
                <td>{l.operator}</td>
              </tr>
            ))}
            {logs.length === 0 && (
              <tr>
                <td colspan="7">暂无流水。</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
