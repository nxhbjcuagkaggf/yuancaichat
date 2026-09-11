# 袁氏世范 · 处己篇 —— 运行与部署指南

宋韵古籍对话作品：左栏通览 68 则《袁氏世范·处己篇》原文/白话/要旨，右栏与"袁采先生"扣子智能体对谈。
采用**后端代理**架构，你的扣子 Token 只存放在服务端，访客打开即可直接对话，无需注册、无需填写任何设置。

---

## 项目文件

| 文件 | 作用 |
| --- | --- |
| `index.html` | 前端页面（不含任何敏感信息） |
| `server.py` | 后端代理，持有扣子 Token，转发 `/api/chat`（仅用 Python 标准库） |
| `.env.example` | 凭据填写模板（复制为 `.env` 后填入你的值） |
| `run.sh` | 一键启动脚本（自动读取 `.env` 并启动服务） |
| `render.yaml` | Render 一键部署清单 |
| `.gitignore` | 禁止把 `.env` 等传到 GitHub |

---

## 一、第一次使用：获取扣子凭据（只需一次）

1. 到 [coze.cn](https://www.coze.cn) 注册并登录。
2. 新建一个 Bot，把它装扮成"南宋袁采·《袁氏世范》"，配好语料和提示词，点击**发布**。
3. 获取两样信息：
   - **COZE_API_TOKEN**：扣子开放平台 →「个人访问令牌」→ 创建（`pat_` 开头）。
   - **COZE_BOT_ID**：智能体详情/发布页里的一串数字。
4. 复制配置模板并填入：
   ```bash
   cp .env.example .env
   ```
   用编辑器打开 `.env`，把 `COZE_API_TOKEN` 和 `COZE_BOT_ID` 改成你自己的值。`.env` 已被 `.gitignore` 忽略，不会上传。

---

## 二、本地运行（先验证再上线）

```bash
./run.sh          # 等价于 Python 读取 .env 后 python3 server.py
```
打开 `http://localhost:8080` 即可对话。输出里出现"已启动"说明成功；若提示未配置，检查 `.env`。

---

## 三、部署到 Render 免费版

### 方式 A：render.yaml 一键部署（最省事）
1. 把除 `.env` 外的所有文件推送到 GitHub 仓库（见下方"推送步骤"）。
2. 到 [render.com](https://render.com) 用 GitHub 登录 → **New → Blueprint** → 选择该仓库。
3. Render 自动读取 `render.yaml`，弹出两个环境变量（`COZE_API_TOKEN`、`COZE_BOT_ID`），把 **sync: false** 对应的值填上，点 **Apply**。
4. 等它构建完成，访问 `https://<你的项目>.onrender.com`。

### 方式 B：手动创建 Web Service
1. Render → **New → Web Service**，连接仓库。
2. **Runtime**：Python 3；**Build Command** 留空；**Start Command**：`python3 server.py`。
3. 在 **Environment** 添加 `COZE_API_TOKEN`、`COZE_BOT_ID`。
4. **Deploy**，完成后打开生成链接。

> 为什么 Token 放 Render 的 Environment 很安全：它在服务端，浏览器/访客永远拿不到。

---

## 四、推送代码到 GitHub（还没有仓库时）

1. 到 [github.com](https://github.com) 登录 → **New repository** 建一个仓库（公开/私有均可）。
2. 在本项目目录执行（把 `<你的仓库地址>` 换成实际地址）：
   ```bash
   cd 本项目目录
   git init
   git add index.html server.py run.sh render.yaml .env.example .gitignore README-运行与部署.md
   git commit -m "袁氏世范处己篇：古籍阅读+袁采对谈，后端代理部署"
   git branch -M main
   git remote add origin <你的仓库地址>
   git push -u origin main
   ```
   （`.env` 不会出现在列表里，因为它已被 `.gitignore` 排除。）
3. 推送后按上面第三节部署到 Render。

---

## 五、常见问题

- **页面能打开但对话提示失败**：检查 `.env` / Render 环境变量里的 `COZE_API_TOKEN`、`COZE_BOT_ID` 是否填对。
- **报"扣子接口错误 401 / 403"**：Token 失效或权限不足，去扣子后台重新生成 PAT。
- **报"生成超时/失败"**：扣子临时繁忙或免费配额用完，稍后重试。
- **想在页面旁单独打开静态版**：只有 `index.html` 单独双击打开时无法对话（缺后端），请始终通过 `run.sh` 或部署链接访问。