const MODEL_ALLOWLIST = new Set([
  "gpt-6.1-sol",
  "gpt-6-luna",
  "gpt-6-astra"
]);
const API_URL = "https://api.teamorouter.com/v1/chat/completions";
const MAX_INPUT_LENGTH = 10000;

function allowedOrigins(env) {
  return (env.ALLOWED_ORIGINS || "").split(",").map((value) => value.trim()).filter(Boolean);
}

function corsHeaders(origin, env) {
  const headers = new Headers({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Vary": "Origin" });
  if (origin && allowedOrigins(env).includes(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
    headers.set("Access-Control-Max-Age", "86400");
  }
  return headers;
}

function jsonResponse(data, status, origin, env) {
  return new Response(JSON.stringify(data), { status, headers: corsHeaders(origin, env) });
}

function parseResult(content) {
  const raw = String(content || "").trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const data = JSON.parse(raw.slice(start, end + 1));
      return {
        needs_clarification: Boolean(data.needs_clarification),
        polished_chinese: String(data.polished_chinese || ""),
        spanish: String(data.spanish || ""),
        note: String(data.note || ""),
        question: String(data.question || "")
      };
    } catch (_) {}
  }
  return { needs_clarification: false, polished_chinese: "", spanish: raw, note: "", question: "" };
}

function buildMessages(text) {
  const system = [
    "你是一位耐心、准确的西班牙语老师，帮助中文母语者把日常中文表达成自然、清楚、当地人会说的西班牙语。",
    "学习者水平约 A2-B1。优先使用常见词、简单语法和容易掌握的句式；不要逐字硬译，不使用不必要的生僻词、复杂从句或过度正式表达。",
    "忠实保留事实、语气、数字、专有名词和说话人的立场，不擅自添加内容。默认使用通用现代西班牙语；只有确有必要时才指出地区差异。",
    "先判断中文原意是否清楚。如果清楚，不重复改写中文。如果中文有歧义但可根据上下文整理，填入 polished_chinese 并给出对应西语。如果关键原意确实无法判断，needs_clarification 设为 true，question 用一句简短中文提出必要问题，不要猜测；此时 spanish 留空。",
    "只在有助于学习时，在 note 中用简短中文说明一处关键表达。不要逐词讲解。",
    "必须只输出一个有效 JSON 对象，不要 Markdown 代码围栏或额外文本。字段固定为：needs_clarification (boolean), polished_chinese (string), spanish (string), note (string), question (string)。"
  ].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: "请按规则处理这段中文：\n\n" + text }
  ];
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    if (url.pathname === "/health" && request.method === "GET") return jsonResponse({ ok: true }, 200, origin, env);
    if (url.pathname !== "/translate") return jsonResponse({ error: "Not found" }, 404, origin, env);
    if (!env.ALLOWED_ORIGINS) return jsonResponse({ error: "服务尚未配置允许访问的网站地址" }, 503, origin, env);
    if (!origin || !allowedOrigins(env).includes(origin)) return jsonResponse({ error: "此网站未获准使用翻译服务" }, 403, origin, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin, env) });
    if (request.method !== "POST") return jsonResponse({ error: "只接受翻译请求" }, 405, origin, env);
    if (!env.TEAMOROUTER_API_KEY) return jsonResponse({ error: "服务器尚未设置模型 API Key" }, 503, origin, env);
    if (!env.APP_ACCESS_CODE) return jsonResponse({ error: "服务器尚未设置访问口令" }, 503, origin, env);

    const authorization = request.headers.get("Authorization") || "";
    const suppliedCode = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (suppliedCode !== env.APP_ACCESS_CODE) return jsonResponse({ error: "访问口令不正确" }, 401, origin, env);

    let body;
    try { body = await request.json(); }
    catch (_) { return jsonResponse({ error: "请求内容不是有效数据" }, 400, origin, env); }
    const text = typeof body.text === "string" ? body.text.trim() : "";
    const model = typeof body.model === "string" ? body.model : "gpt-6.1-sol";
    if (!text) return jsonResponse({ error: "请输入中文内容" }, 400, origin, env);
    if (text.length > MAX_INPUT_LENGTH) return jsonResponse({ error: "单次最多翻译 10000 个字符" }, 413, origin, env);
    if (!MODEL_ALLOWLIST.has(model)) return jsonResponse({ error: "当前模型不在允许列表中" }, 400, origin, env);

    try {
      const upstream = await fetch(API_URL, {
        method: "POST",
        headers: { "Authorization": "Bearer " + env.TEAMOROUTER_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages: buildMessages(text), max_tokens: 1800, stream: false }),
        signal: AbortSignal.timeout(60000)
      });
      if (!upstream.ok) return jsonResponse({ error: "模型服务暂时不可用（" + upstream.status + "），请检查模型和账户额度" }, 502, origin, env);
      const data = await upstream.json();
      const content = data && data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : "";
      if (typeof content !== "string" || !content.trim()) return jsonResponse({ error: "模型没有返回译文，请稍后重试" }, 502, origin, env);
      return jsonResponse({ result: parseResult(content) }, 200, origin, env);
    } catch (_) {
      return jsonResponse({ error: "连接模型服务失败，请检查服务状态后重试" }, 502, origin, env);
    }
  }
};

