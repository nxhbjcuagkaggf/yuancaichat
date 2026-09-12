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

async function coze(env, method, path, payload, timeoutMs = 30000) {
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

// 智能体选择（2026-09-12 用线上 Token 实测，均已发布 API 渠道、同属一个空间）：
//   PRIMARY_BOT_ID   —— 7684145093359452202，回答切题凝练，约 26 秒完成，作为主力
//   SECONDARY_BOT_ID —— 7683854178863087650，扮演感强但长回复约 56 秒，主力异常时兜底
// 面板环境变量 COZE_BOT_ID 仅作最后兜底，填错也不影响网站。
// 注：7684161474704670760 在本 Token 空间内不存在（扣子返回 4200），无法使用。
const PRIMARY_BOT_ID = '7684145093359452202';
const SECONDARY_BOT_ID = '7683854178863087650';
// 单个智能体的最长等待：实测最慢的长回复约 56 秒，给到 75 秒余量。
const PER_BOT_DEADLINE_MS = 75000;

/**
 * 用指定智能体发起一次对话并取回完整答复。返回 { reply, src }。
 * 任何失败（不存在 / 未发布 / 超时 / 生成失败）都抛错，由上层切换下一个候选。
 */
async function attemptBot(env, botId, userMessage, userId) {
  // 每次提问新建会话，避免在共享账号里积累历史；
  // 注意不能设置 auto_save_history=false，否则扣子强制流式且无法 retrieve。
  const created = await coze(env, 'POST', '/v3/chat', {
    bot_id: botId,
    user_id: userId,
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

  // 轮询直至生成完成。Cloudflare 免费版限制的是 CPU 时间而非墙钟时间，
  // 等待网络响应（fetch/sleep）不占用 CPU；期间 SSE 心跳每 3 秒下发，连接不会断。
  let status = '';
  const deadline = Date.now() + PER_BOT_DEADLINE_MS;
  while (Date.now() < deadline) {
    const st = await coze(env, 'GET', '/v3/chat/retrieve?' + base);
    status = (st.data || {}).status;
    if (status === 'completed' || status === 'local_success') break;
    if (status === 'failed') throw new Error('对话生成失败，请重试');
    await sleep(800);
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

/**
 * 依次尝试候选智能体：主力 → 内置备用 → 面板 COZE_BOT_ID。
 * 任一智能体创建失败、超时或生成失败，立即切换下一个，全部失败才把最后错误抛给前端。
 */
async function chatWith(env, userMessage) {
  const userId = 'guest_' + Math.floor(100000 + Math.random() * 900000);
  const botCandidates = [PRIMARY_BOT_ID, SECONDARY_BOT_ID];
  if (env.COZE_BOT_ID && !botCandidates.includes(env.COZE_BOT_ID)) {
    botCandidates.push(env.COZE_BOT_ID);
  }

  let lastErr = null;
  for (const botId of botCandidates) {
    try {
      return await attemptBot(env, botId, userMessage, userId);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('所有智能体暂不可用，请稍后再试');
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

  if (!env.COZE_API_TOKEN) {
    return json(500, { error: '服务端未配置 COZE_API_TOKEN，请先在 Cloudflare Pages 环境变量中补充' });
  }

  // 使用 SSE 流式响应：等待扣子生成期间每 3 秒发一个心跳，
  // 防止长连接因长时间无数据被中间网络/校园网/防火墙重置（ERR_CONNECTION_CLOSED）。
  const encoder = new TextEncoder();
  const sseHeaders = {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  const stream = new ReadableStream({
    async start(controller) {
      const emit = (obj) => {
        try {
          controller.enqueue(encoder.encode('data: ' + JSON.stringify(obj) + '\n\n'));
        } catch (_) {}
      };
      // 立即先吐一个字节，让浏览器马上收到响应头与首包
      emit({ type: 'ping' });
      const beat = setInterval(() => emit({ type: 'ping' }), 3000);
      try {
        const { reply, src } = await chatWith(env, message);
        emit({ type: 'done', reply, src });
      } catch (e) {
        emit({ type: 'error', error: String(e && e.message ? e.message : e) });
      } finally {
        clearInterval(beat);
        try {
          controller.close();
        } catch (_) {}
      }
    },
  });

  return new Response(stream, { status: 200, headers: sseHeaders });
}