import { useState } from "react";
import { BookOpen, Zap, MessageCircle, Activity, Shield, Database, Clock, Wrench, Users, Settings, Server, HelpCircle } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type TabKey = "overview" | "modules" | "architecture" | "faq";

const TABS: { key: TabKey; label: string; icon: typeof BookOpen }[] = [
  { key: "overview", label: "平台概述", icon: BookOpen },
  { key: "modules", label: "功能模块", icon: Zap },
  { key: "architecture", label: "系统架构", icon: Server },
  { key: "faq", label: "常见问题", icon: HelpCircle },
];

export default function HelpPage() {
  const [tab, setTab] = useState<TabKey>("overview");

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto">
      <div className="mb-6">
        <h2 className="text-lg font-semibold">帮助中心</h2>
        <p className="text-sm text-muted-foreground mt-0.5">六脉智能运维数智平台使用指南</p>
      </div>

      {/* Tab nav */}
      <div className="flex gap-1 mb-6 overflow-x-auto">
        {TABS.map((t) => (
          <button key={t.key} type="button" onClick={() => setTab(t.key)} className={cn(
            "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm whitespace-nowrap transition-colors",
            tab === t.key ? "bg-interactive-primary/10 text-interactive-primary font-medium" : "text-text-secondary hover:bg-surface-secondary",
          )}>
            <t.icon className="h-4 w-4" />{t.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="prose prose-sm max-w-none text-text-primary space-y-6">
        {tab === "overview" && <OverviewTab />}
        {tab === "modules" && <ModulesTab />}
        {tab === "architecture" && <ArchitectureTab />}
        {tab === "faq" && <FaqTab />}
      </div>
    </div>
  );
}

function OverviewTab() {
  return (
    <div className="space-y-6">
      <Card><CardContent className="p-6 space-y-3">
        <h3 className="text-base font-semibold">关于六脉</h3>
        <p className="text-sm text-text-secondary leading-relaxed">
          六脉（Liumai）是一个面向企业运维场景的 AI 驱动智能运维平台。平台对接 Hermes Agent 引擎和大语言模型，提供智能对话、故障根因分析（RCA）、知识库问答、定时任务调度、多源数据接入等核心 AIOps 能力。
        </p>
        <p className="text-sm text-text-secondary leading-relaxed">
          平台名称源自中医"六脉"概念——六条经脉贯通全身，象征平台通过多维度数据采集和 AI 分析，
          全面感知系统健康状态，精准定位故障根因。
        </p>
      </CardContent></Card>

      <Card><CardContent className="p-6 space-y-3">
        <h3 className="text-base font-semibold">核心能力</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {[
            { icon: MessageCircle, title: "智能对话", desc: "多模式 AI 对话，支持通用问答、RCA 分析和知识库问答" },
            { icon: Activity, title: "故障定界", desc: "自动/手动 RCA，时间窗口灵活，并发队列管理" },
            { icon: Clock, title: "定时任务", desc: "Cron/间隔/一次性调度，暂停恢复即时控制" },
            { icon: Database, title: "多源接入", desc: "Prometheus、Zabbix、ClickHouse、Kafka、HTTP API" },
            { icon: Wrench, title: "技能中心", desc: "浏览 146+ Hermes 技能和 25 个工具集" },
            { icon: Users, title: "用户管理", desc: "本地+LDAP 双认证，角色权限控制" },
          ].map((item) => (
            <div key={item.title} className="flex gap-3 p-3 rounded-lg bg-surface-secondary/50">
              <item.icon className="h-5 w-5 text-interactive-primary shrink-0 mt-0.5" />
              <div><p className="text-sm font-medium">{item.title}</p><p className="text-xs text-muted-foreground">{item.desc}</p></div>
            </div>
          ))}
        </div>
      </CardContent></Card>

      <Card><CardContent className="p-6 space-y-3">
        <h3 className="text-base font-semibold">快速入门</h3>
        <ol className="text-sm text-text-secondary space-y-2 list-decimal pl-5">
          <li><strong>配置 AI 引擎</strong>：进入系统设置 → 智能引擎，配置 Hermes 连接地址和 API Key，点击测试连接确认。</li>
          <li><strong>配置通用模型</strong>：在智能引擎 → 通用模型，配置 LLM 的 Base URL、API Key 和模型名称，用于平台内部智能功能。</li>
          <li><strong>添加数据源</strong>：进入数据源管理，添加 Prometheus、Zabbix 等监控数据源，平台将从中采集指标。</li>
          <li><strong>创建告警规则</strong>：在告警规则中创建匹配条件，当监控数据满足条件时自动触发 RCA 分析。</li>
          <li><strong>开始对话</strong>：进入智能对话，选择对话模式，输入你的运维问题。</li>
        </ol>
      </CardContent></Card>
    </div>
  );
}

function ModulesTab() {
  const modules = [
    {
      title: "概览仪表盘",
      icon: Zap,
      desc: "系统首页展示 RCA 队列状态、Hermes 健康、快速入口和最近分析会话。帮助您快速掌握平台运行概况。",
      tips: ["点击快速入口卡片可跳转到对应功能模块", "Hermes 健康状态每 30 秒自动刷新"],
    },
    {
      title: "智能对话",
      icon: MessageCircle,
      desc: "提供三种对话模式：通用问答适合日常运维咨询；故障定界模式集成 RCA 分析引擎；知识问答模式支持上传文档（PDF/Word/Excel 等 30+ 格式），AI 基于文档内容回答。",
      tips: ["Enter 发送消息，Shift+Enter 换行", "RCA 模式下可选择分析时间窗口", "文件上传支持 PDF、Word、Excel、PPT、图片等格式"],
    },
    {
      title: "RCA 分析",
      icon: Activity,
      desc: "故障根因分析模块。支持自动触发（告警规则匹配时）和手动触发。分析结果包含根因摘要、影响范围、建议操作和详细时间线。",
      tips: ["并发上限可在系统设置中调整环境变量", "点击会话可查看完整时间线"],
    },
    {
      title: "告警规则",
      icon: Shield,
      desc: "管理自动触发 RCA 的匹配规则。支持多严重级别和灵活的条件表达式。规则可随时启用/禁用。",
      tips: ["条件表达式支持 and/or 逻辑组合", "严重级别为 critical 的规则会优先处理"],
    },
    {
      title: "定时任务",
      icon: Clock,
      desc: "管理 Hermes 后台定时作业。支持 Cron 表达式、间隔调度和一次性任务。可随时暂停/恢复/立即执行。",
      tips: ["Cron 示例: 0 9 * * 1-5 表示工作日早9点", "间隔示例: every 2h 表示每2小时执行一次"],
    },
    {
      title: "数据源",
      icon: Database,
      desc: "管理外部监控系统连接。支持 Prometheus、Zabbix、ClickHouse、Kafka、HTTP API 五种类型。每种类型有专门的配置表单。",
      tips: ["API 类型支持自定义 Headers 和 Body", "可使用测试连接按钮验证配置"],
    },
    {
      title: "技能中心",
      icon: Wrench,
      desc: "浏览 Hermes Agent 的全部技能和工具集。技能按分类分组展示，支持搜索和筛选。",
      tips: ["缓存自动刷新，可在系统设置调整周期", "使用搜索框快速定位特定技能"],
    },
    {
      title: "系统设置",
      icon: Settings,
      desc: "平台配置中心。分为智能引擎（Hermes + LLM）、认证安全（LDAP + 密码）和通用三个分类。",
      tips: ["修改 Hermes 配置后建议测试连接", "欢迎语提示词支持 {username} 占位符"],
    },
  ];

  return (
    <div className="space-y-6">
      {modules.map((m) => (
        <Card key={m.title}>
          <CardContent className="p-6 space-y-3">
            <div className="flex items-center gap-2">
              <m.icon className="h-5 w-5 text-interactive-primary" />
              <h3 className="text-base font-semibold">{m.title}</h3>
            </div>
            <p className="text-sm text-text-secondary leading-relaxed">{m.desc}</p>
            <ul className="text-xs text-muted-foreground space-y-1 list-disc pl-5">
              {m.tips.map((t) => <li key={t}>{t}</li>)}
            </ul>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function ArchitectureTab() {
  return (
    <div className="space-y-6">
      <Card><CardContent className="p-6 space-y-3">
        <h3 className="text-base font-semibold">系统拓扑</h3>
        <pre className="text-xs font-mono bg-surface-secondary rounded-lg p-4 overflow-x-auto text-text-secondary leading-relaxed">
{`Browser (:3000)
    │
    ▼
Nginx (反向代理 + 静态资源)
    │
    ├─ /api/* ────────── FastAPI Backend (:8000)
    │                        │
    │    ┌───────────────────┼───────────────────┐
    │    │                   │                   │
    │    ▼                   ▼                   ▼
    │  Auth (JWT)        Chat (SSE)          RCA (Analysis)
    │  Users CRUD        Jobs Proxy          Rules Engine
    │  DataSources       History             Skills Cache
    │
    ├─ /api/* ────────── Hermes Agent (AI Engine)
    │                        │
    │    ┌───────────────────┼───────────────────┐
    │    ▼                   ▼                   ▼
    │  Chat Completions   Skills API        Jobs API
    │  (stream/non)       Toolsets API      Cron Scheduler
    │
    ├─ PostgreSQL 16 ──── Primary Data Store
    └─ Redis 7 ────────── Cache / Session Store`}
        </pre>
      </CardContent></Card>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card><CardContent className="p-4 space-y-2">
          <h4 className="text-sm font-semibold">前端技术栈</h4>
          <p className="text-xs text-muted-foreground">React 19 · TypeScript · Tailwind CSS 4 · shadcn/ui (base-nova) · Vite 8 · Lucide Icons · next-themes · Sonner</p>
        </CardContent></Card>
        <Card><CardContent className="p-4 space-y-2">
          <h4 className="text-sm font-semibold">后端技术栈</h4>
          <p className="text-xs text-muted-foreground">Python 3.12 · FastAPI · SQLAlchemy 2.0 (async) · Alembic · Pydantic v2 · httpx · MarkItDown · python-jose (JWT) · bcrypt · LDAP3</p>
        </CardContent></Card>
        <Card><CardContent className="p-4 space-y-2">
          <h4 className="text-sm font-semibold">数据存储</h4>
          <p className="text-xs text-muted-foreground">PostgreSQL 16 (主库) · Redis 7 (缓存/Session)</p>
        </CardContent></Card>
        <Card><CardContent className="p-4 space-y-2">
          <h4 className="text-sm font-semibold">部署方式</h4>
          <p className="text-xs text-muted-foreground">Docker Compose 多服务编排 · Nginx 反向代理 · 支持 China-region 镜像源</p>
        </CardContent></Card>
      </div>
    </div>
  );
}

function FaqTab() {
  const faqs = [
    { q: "Hermes 连接失败怎么办？", a: "检查系统设置中的 Hermes 地址是否正确（应包含端口如 :8642）。确认 Hermes 服务正在运行。如有防火墙，确保端口可达。点击「测试连接」按钮诊断。" },
    { q: "LDAP 用户如何登录？", a: "LDAP 用户使用域账号和密码直接登录。首次登录时如果启用了「自动创建」选项，系统会自动创建本地账号。管理员需先在系统设置中配置 LDAP 服务器信息。" },
    { q: "如何添加新的对话模式？", a: "目前对话模式通过数据库直接管理。管理员可在 chat_modes 表中 INSERT 新记录，包含 slug、name、system_prompt 等字段。后续版本将提供 UI 管理界面。" },
    { q: "定时任务的 Cron 表达式怎么写？", a: "支持标准 5 字段 Cron（分 时 日 月 星期）。例如：0 9 * * 1-5（工作日9点）、*/30 * * * *（每30分钟）。也支持相对格式：every 2h、30m、1d。" },
    { q: "上传的文件大小有限制吗？", a: "目前文件上传限制为 2MB。支持 PDF、Word (.docx)、Excel (.xlsx/.xls)、PowerPoint (.pptx)、图片、代码文件等 30+ 格式。文件通过 MarkItDown 转换为文本后送入 AI 分析。" },
    { q: "如何备份数据？", a: "所有数据存储在 PostgreSQL 中。可使用 docker compose exec postgres pg_dump 导出。注意：不要使用 docker compose down -v 命令，这会永久删除所有数据。" },
    { q: "RCA 分析支持哪些数据源？", a: "目前支持 Prometheus、Zabbix、ClickHouse、Kafka 和 HTTP API 五种数据源。每种数据源需要先在「数据源」页面配置连接信息。" },
    { q: "如何更新 Hermes Agent？", a: "Hermes Agent 是独立服务，更新方式参考其官方文档。Liumai 平台本身通过 git pull + docker compose up -d --build 更新。" },
  ];

  return (
    <div className="space-y-4">
      {faqs.map((faq, i) => (
        <Card key={i}>
          <CardContent className="p-5 space-y-2">
            <h4 className="text-sm font-semibold text-text-primary">Q: {faq.q}</h4>
            <p className="text-sm text-text-secondary leading-relaxed">{faq.a}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
