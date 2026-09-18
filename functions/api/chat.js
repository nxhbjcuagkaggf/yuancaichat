/**
 * 袁采「处己篇」—— Cloudflare Pages Function 后端代理（真流式版）
 *
 * 把扣子(Coze)的 API Token 与 Bot ID 藏在这里(环境变量)，
 * 前端只需 POST /api/chat { message }，访客看不到任何密钥。
 *
 * 2026-09-18 改造：上游请求 stream=true，扣子每生成几个字就下发 delta，
 * 本函数原样转成 {type:'delta',text} 转发给浏览器——首字几秒内到达，
 * 连接上持续有真实数据，被国内运营商链路重置的概率大幅下降。
 *
 * Cloudflare Pages 环境变量需设置：
 *   COZE_API_TOKEN  扣子「个人访问令牌」
 *   COZE_BOT_ID     可选，仅作最后兜底 Bot ID
 *   COZE_BASE       可选，默认 https://api.coze.cn
 */

function getBase(env) {
  return (env.COZE_BASE || 'https://api.coze.cn').replace(/\/+$/, '');
}

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

/* 从扣子消息 content 中提取纯文本：可能是普通字符串，也可能是部件数组的 JSON */
function extractTexts(content) {
  if (typeof content === 'string') {
    const t = content.trim();
    if (!t) return '';
    if (t[0] === '[') {
      try {
        const arr = JSON.parse(t);
        if (Array.isArray(arr)) {
          return arr
            .filter((x) => x && (x.type === 'text' || x.type === 'answer') && x.text)
            .map((x) => x.text)
            .join('\n')
            .trim();
        }
      } catch (_) {}
    }
    return t;
  }
  if (Array.isArray(content)) {
    return content
      .filter((x) => x && (x.type === 'text' || x.type === 'answer') && x.text)
      .map((x) => x.text)
      .join('\n')
      .trim();
  }
  return '';
}

/* 收集引用知识库文档名（document 部件），写入 out 数组去重 */
function collectSources(content, out) {
  let parts = null;
  if (Array.isArray(content)) {
    parts = content;
  } else if (typeof content === 'string' && content.trim()[0] === '[') {
    try {
      const p = JSON.parse(content);
      parts = Array.isArray(p) ? p : null;
    } catch (_) {}
  }
  if (!parts) return;
  for (const x of parts) {
    if (x && x.type === 'document' && x.document && x.document.name) {
      if (!out.includes(x.document.name)) out.push(x.document.name);
    }
  }
}

// 智能体选择（2026-09-12 用线上 Token 实测，均已发布 API 渠道、同属一个空间）：
//   PRIMARY_BOT_ID   —— 7684145093359452202，回答切题凝练，作为主力
//   SECONDARY_BOT_ID —— 7683854178863087650，扮演感强，主力异常时兜底
// 面板环境变量 COZE_BOT_ID 仅作最后兜底，填错也不影响网站。
const PRIMARY_BOT_ID = '7684145093359452202';
const SECONDARY_BOT_ID = '7683854178863087650';
// 单个智能体的最长等待（含全部 delta 收完）。实测最慢长回复约 56 秒，给到 90 秒。
const PER_BOT_DEADLINE_MS = 90000;

/**
 * 用指定智能体发起【流式】对话，把 answer 的增量通过 emit 实时转发。
 * 返回 { reply, src, firstDeltaMs }。任何失败都抛错，由上层切换下一个候选。
 */
async function attemptBotStream(env, botId, userMessage, userId, emit) {
  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PER_BOT_DEADLINE_MS);

  let firstDeltaMs = 0;
  let answer = '';
  const sources = [];

  try {
    const res = await fetch(getBase(env) + '/v3/chat', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + env.COZE_API_TOKEN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        bot_id: botId,
        user_id: userId,
        stream: true,
        auto_save_history: true,
        additional_messages: [
          { role: 'user', content: userMessage, content_type: 'text' },
        ],
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let msg = '扣子接口错误 HTTP ' + res.status;
      try {
        const j = JSON.parse(text);
        if (j.msg || j.message) msg = j.msg || j.message;
      } catch (_) {}
      throw new Error(msg);
    }
    if (!res.body || typeof res.body.getReader !== 'function') {
      throw new Error('扣子未返回流式响应体');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let evName = '';
    let dataLines = [];

    // 处理一个完整 SSE 帧（event + data）。抛错会直接中断整个 attempt。
    function dispatch() {
      if (!evName && dataLines.length === 0) return;
      const raw = dataLines.join('\n');
      let data = null;
      if (raw) {
        try {
          data = JSON.parse(raw);
        } catch (_) {
          data = { raw };
        }
      }

      if (evName === 'error') {
        throw new Error((data && (data.msg || data.message)) || '扣子流式请求错误');
      }
      if (evName === 'conversation.chat.failed') {
        const le = data && data.last_error;
        throw new Error((le && le.msg) || '对话生成失败，请重试');
      }
      if (evName === 'conversation.message.delta') {
        if (data && data.role === 'assistant' && data.type === 'answer' && data.content) {
          if (!firstDeltaMs) firstDeltaMs = Date.now() - t0;
          answer += data.content;
          emit({ type: 'delta', text: data.content });
        }
      } else if (evName === 'conversation.message.completed') {
        if (data && data.type === 'answer') {
          // 兜底：个别场景收不到 delta，completed 事件里带完整拼接文本
          if (!answer) {
            const full = extractTexts(data.content);
            if (full) {
              if (!firstDeltaMs) firstDeltaMs = Date.now() - t0;
              answer = full;
              emit({ type: 'delta', text: full });
            }
          }
        }
        // 顺带收集引用文档名
        if (data && data.content) collectSources(data.content, sources);
      }
      // conversation.chat.created / in_progress / completed / done 等无需处理
      evName = '';
      dataLines = [];
    }

    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (line === '') {
          dispatch();
          continue;
        }
        if (line[0] === ':') continue; // SSE 注释
        const ci = line.indexOf(':');
        if (ci === -1) continue;
        const field = line.slice(0, ci);
        let val = line.slice(ci + 1);
        if (val[0] === ' ') val = val.slice(1);
        if (field === 'event') evName = val;
        else if (field === 'data') dataLines.push(val);
      }
    }
    dispatch(); // 收尾帧（防止上游最后没有空行）

    answer = answer.trim();
    if (!answer) throw new Error('模型未返回文字内容，请改一种问法再试');

    const totalMs = Date.now() - t0;
    const src = sources.join('；');
    // 耗时日志：Cloudflare 控制台 Pages → Functions 实时日志可见（首字/总耗时/字数）
    console.log(
      JSON.stringify({
        evt: 'coze_ok',
        bot: botId,
        firstMs: firstDeltaMs,
        totalMs: totalMs,
        len: answer.length,
      })
    );
    return { reply: answer, src: src, firstDeltaMs: firstDeltaMs };
  } catch (e) {
    const aborted = e && e.name === 'AbortError';
    const msg = aborted
      ? '对话生成超时，请重试'
      : String((e && e.message) || '扣子请求失败');
    console.log(
      JSON.stringify({
        evt: 'coze_fail',
        bot: botId,
        ms: Date.now() - t0,
        err: msg.slice(0, 200),
      })
    );
    throw new Error(msg);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 依次尝试候选智能体：主力 → 内置备用 → 面板 COZE_BOT_ID。
 * 主力在吐出任何正文之前失败（不存在/未发布/排队超时）时静默切换；
 * 若已经向浏览器转发过部分正文，则不能换 Bot 重答（会重复），直接报错。
 */
async function streamChat(env, userMessage, emit) {
  const userId = 'guest_' + Math.floor(100000 + Math.random() * 900000);
  const botCandidates = [PRIMARY_BOT_ID, SECONDARY_BOT_ID];
  if (env.COZE_BOT_ID && !botCandidates.includes(env.COZE_BOT_ID)) {
    botCandidates.push(env.COZE_BOT_ID);
  }

  let emittedDelta = false;
  const forwardingEmit = (obj) => {
    if (obj.type === 'delta') emittedDelta = true;
    emit(obj);
  };

  let lastErr = null;
  for (const botId of botCandidates) {
    try {
      return await attemptBotStream(env, botId, userMessage, userId, forwardingEmit);
    } catch (e) {
      lastErr = e;
      if (emittedDelta) break;
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
    return json(500, {
      error: '服务端未配置 COZE_API_TOKEN，请先在 Cloudflare Pages 环境变量中补充',
    });
  }

  // SSE 下行：delta 真实正文 + 每 3 秒空闲心跳（仅在近期无数据时发，避免与正文抢流）
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
      let lastEmit = Date.now();
      const emit = (obj) => {
        lastEmit = Date.now();
        try {
          controller.enqueue(encoder.encode('data: ' + JSON.stringify(obj) + '\n\n'));
        } catch (_) {}
      };

      emit({ type: 'ping' }); // 首包立即下发，让浏览器尽快收到响应头
      const beat = setInterval(() => {
        if (Date.now() - lastEmit >= 2500) emit({ type: 'ping' });
      }, 3000);

      try {
        const { src } = await streamChat(env, message, emit);
        emit({ type: 'done', src: src || '' });
      } catch (e) {
        emit({
          type: 'error',
          error: String(e && e.message ? e.message : e),
        });
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
