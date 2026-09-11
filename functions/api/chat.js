/**
 * 袁采「处己篇」—— Cloudflare Pages Function 后端代理
 *
 * 把扣子(Coze)的 API Token 与 Bot ID 藏在这里(环境变量)，
 * 前端只需 POST /api/chat { message }，访客无需也不可见任何密钥。
 *
 * Cloudflare Pages 环境变量需设置：
 *   COZE_API_TOKEN  扣子「个人访问令牌」
 *   COZE_BOT_ID     你的「袁采」智能体 Bot ID
 *   COZE_BASE       可选，默认 https://api.coze.cn
 */

function getBase(env) {
  return (env.COZE_BASE || 'https://api.coze.cn').replace(/\/+$/, '');
}

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
}

async function coze(env, method, path, payload, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(getBase(env) + path, {
      method,
      headers: {
        Authorization: 'Bearer ' + env.COZE_API_TOKEN,
        'Content-Type': 'application/json',
      },
      body: payload ? JSON.stringify(payload) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch (_) {
      data = { raw: text };
    }
    if (!res.ok) {
      throw new Error('扣子接口错误 HTTP ' + res.status + '：' + text.slice(0, 400));
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function collectTexts(items) {
  const texts = [];
  if (!Array.isArray(items)) return texts;
  for (const x of items) {
    if (!x || typeof x !== 'object') continue;
    if ((x.type === 'text' || x.type === 'answer') && x.text) texts.push(x.text);
  }
  return texts;
}

/**
 * 发起一次对话并取回完整答复。返回 { reply, src }
 */
async function chatWith(env, userMessage) {
  // 每次提问新建会话，避免在共享账号里积累历史；
  // 注意不能设置 auto_save_history=false，否则扣子强制流式且无法 retrieve。
  const user_id = 'guest_' + Math.floor(100000 + Math.random() * 900000);
  const created = await coze(env, 'POST', '/v3/chat', {
    bot_id: env.COZE_BOT_ID,
    user_id,
    stream: false,
    additional_messages: [
      { role: 'user', content: userMessage, content_type: 'text' },
    ],
  });

  if (!(created.code == null || created.code === 0)) {
    throw new Error(created.msg || created.detail || '创建对话失败');
  }
  const data = created.data || {};
  const chat_id = data.id;
  const conv_id = data.conversation_id;
  if (!chat_id) throw new Error('扣子未返回对话 id');

  const q = (s) => encodeURIComponent(String(s == null ? '' : s));
  const base = 'chat_id=' + q(chat_id) + '&conversation_id=' + q(conv_id);

  // 轮询直至生成完成（Cloudflare Worker 单次执行上限约 30s，这里最多等约 26s）
  let status = '';
  const deadline = Date.now() + 26000;
  while (Date.now() < deadline) {
    const st = await coze(env, 'GET', '/v3/chat/retrieve?' + base);
    status = (st.data || {}).status;
    if (status === 'completed' || status === 'local_success') break;
    if (status === 'failed') throw new Error('对话生成失败，请重试');
    await sleep(1200);
  }
  if (status !== 'completed' && status !== 'local_success') {
    throw new Error('对话生成超时，请重试');
  }

  const msgs = await coze(env, 'GET', '/v3/chat/message/list?' + base);
  const arr = msgs.data || [];
  const sources = [];
  let answer = '';

  // 取最后一条 assistant 答复
  for (let i = arr.length - 1; i >= 0; i--) {
    const m = arr[i];
    if (!m || m.role !== 'assistant') continue;
    const content = m.content;
    let texts = [];

    if (typeof content === 'string') {
      let parsed = null;
      try {
        parsed = JSON.parse(content);
      } catch (_) {
        parsed = null;
      }
      if (Array.isArray(parsed)) {
        texts = collectTexts(parsed);
      } else if (m.type === 'answer' && content.trim()) {
        texts = [content];
      }
    } else if (Array.isArray(content)) {
      texts = collectTexts(content);
    }

    // 顺带收集引用文档名
    const allParts = Array.isArray(content)
      ? content
      : (() => {
          try {
            const p = JSON.parse(typeof content === 'string' ? content : '[]');
            return Array.isArray(p) ? p : [];
          } catch (_) {
            return [];
          }
        })();
    for (const x of allParts) {
      if (x && typeof x === 'object' && x.type === 'document' && x.document && x.document.name) {
        if (!sources.includes(x.document.name)) sources.push(x.document.name);
      }
    }

    if (texts.length) {
      answer = texts.join('\n');
      break;
    }
  }

  answer = answer.trim();
  const src = sources.join('；');
  if (!answer) throw new Error('模型未返回文字内容，请改一种问法再试');
  return { reply: answer, src };
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }

  if (request.method !== 'POST') {
    return json(405, { error: '/api/chat 请用 POST 调用' });
  }

  let message = '';
  try {
    const body = await request.json();
    message = (body.message || '').trim();
  } catch (_) {
    return json(400, { error: '请求体须为合法 JSON，且包含 message 字段' });
  }
  if (!message) return json(400, { error: 'message 不能为空' });

  if (!env.COZE_API_TOKEN || !env.COZE_BOT_ID) {
    return json(500, { error: '服务端未配置 COZE_API_TOKEN 或 COZE_BOT_ID，请先在 Cloudflare Pages 环境变量中补充' });
  }

  try {
    const { reply, src } = await chatWith(env, message);
    return json(200, { reply, src });
  } catch (e) {
    return json(502, { error: String(e && e.message ? e.message : e) });
  }
}