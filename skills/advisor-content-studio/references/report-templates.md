# 输出模板

## 模板选择规则

| 内容类型 | 使用模板 | 默认输出格式 |
|---------|---------|------------|
| 市场解读 | 模板一 | HTML（默认）/ Markdown（用户要求时） |
| 基金推荐 | 模板二 | HTML（默认）/ Markdown（用户要求时） |
| 投教科普 | 模板三 | HTML（默认）/ Markdown（用户要求时） |
| 热点评论 | 模板四 | HTML（默认）/ Markdown（用户要求时） |
| 短文案 | 模板五 | HTML 精简卡片（默认）/ 纯文本（用户要求时） |

格式规则：
- 默认输出 HTML（自包含）
- 用户明确要求纯文本/简洁版时降级为 Markdown/纯文本
- 用户要求"长图""下载""打印"时，先生成 HTML 再生成长图/PDF

---

## 通用 HTML 基座

> **⚠️ 核心规则**：生成任何 HTML 时，必须**原样复制**以下基座代码（`<!DOCTYPE html>` 到 `</html>`），仅将 `<!-- CONTENT -->` 替换为对应模板的板块 HTML，将 `// BINDCHARTS` 替换为 ECharts 初始化代码。
>
> **严禁修改 `<style>` 中的任何 CSS。严禁自行编写、添加或删减任何样式。严禁修改 `<script>` 中的公共函数。**

```html
<!DOCTYPE html>
<html lang="zh-CN" data-theme="light">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>{{标题}} - {{日期}}</title>
<script src="https://cdn.jsdelivr.net/npm/echarts@5.5.0/dist/echarts.min.js"></script>
<style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Noto+Sans+SC:wght@400;500;600;700;800&display=swap');
:root{
  --up-color:#F53F3F;--up-bg:#FFECE8;--down-color:#00B42A;--down-bg:#E8FFEA;
  --brand-color:#165DFF;--brand-bg:#E8F0FF;
  --page-bg:#F2F3F5;--card-bg:#FFFFFF;--card-hover:#FAFBFC;--inset-bg:#F7F8FA;
  --text-title:#1D2129;--text-main:#4E5969;--text-sub:#86909C;--text-muted:#C9CDD4;
  --border-color:#E5E6EB;--border-light:#F2F3F5;
  --shadow-soft:0 4px 24px rgba(29,33,41,0.04);
  --radius-lg:24px;--radius-md:16px;--radius-sm:8px;
}
[data-theme="dark"]{
  --page-bg:#000;--card-bg:#1C1C1E;--card-hover:#2C2C2E;--inset-bg:#2C2C2E;
  --text-title:#FFF;--text-main:#EBEBF5;--text-sub:#8E8E93;--text-muted:#636366;
  --border-color:#38383A;--border-light:#2C2C2E;
  --shadow-soft:0 4px 24px rgba(0,0,0,0.4);
  --up-color:#FF453A;--up-bg:rgba(255,69,58,0.15);
  --down-color:#32D74B;--down-bg:rgba(50,215,75,0.15);
  --brand-color:#0A84FF;--brand-bg:rgba(10,132,255,0.15);
}
*{box-sizing:border-box;margin:0}
body{background:var(--page-bg);color:var(--text-main);font-family:'Inter','Noto Sans SC',sans-serif;line-height:1.7}
.container{max-width:920px;margin:0 auto;padding:16px 20px 40px}
.topbar{display:flex;justify-content:flex-end;padding:12px 0;gap:10px}
.theme-btn{background:linear-gradient(180deg,#fffaf2,#fff4e8);border:1px solid #f5c08a;padding:6px 14px;min-height:34px;border-radius:999px;cursor:pointer;font-size:13px;font-weight:600;color:#8a4b12;display:flex;align-items:center;gap:6px;box-shadow:0 4px 12px rgba(245,158,11,.18);transition:all .18s}
.theme-btn:hover{transform:translateY(-1px);box-shadow:0 6px 16px rgba(245,158,11,.24)}
[data-theme="dark"] .theme-btn{background:linear-gradient(180deg,#2b3444,#263142);border-color:#7c8595;color:#e5ecf7;box-shadow:0 4px 12px rgba(16,24,40,.35)}
.card{background:var(--card-bg);border-radius:var(--radius-lg);padding:28px 32px;margin-bottom:24px;box-shadow:var(--shadow-soft)}
.hero-card{background:var(--card-bg);border-radius:var(--radius-lg);padding:36px 32px 28px;margin-bottom:24px;box-shadow:var(--shadow-soft)}
.hero-title{font-size:28px;font-weight:800;color:var(--text-title);margin-bottom:6px}
.hero-sub{font-size:15px;color:var(--text-sub);margin-bottom:4px}
.hero-author{font-size:13px;color:var(--text-muted);margin-top:14px;padding-top:14px;border-top:1px solid var(--border-light)}
.kpi-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}
.kpi{background:var(--inset-bg);border-radius:var(--radius-sm);padding:14px}
.kpi .label{font-size:12px;color:var(--text-sub);margin-bottom:2px}
.kpi .val{font-size:22px;font-weight:800;color:var(--text-title)}
.kpi .val small{font-size:13px;font-weight:600}
.card.ai-card{background:linear-gradient(180deg,#f1f7ff,#eef5ff)!important;border:1px solid #dbeafe!important}
[data-theme="dark"] .card.ai-card{background:linear-gradient(180deg,rgba(30,58,110,.36),rgba(30,58,110,.25))!important;border-color:rgba(147,197,253,.4)!important}
.ai-title{font-size:17px;font-weight:800;color:var(--brand-color);display:inline-flex;align-items:center;gap:6px;margin-bottom:10px}
.ai-conclusion{font-size:15px;font-weight:700;color:var(--text-title);margin-bottom:10px;line-height:1.8}
.ai-list{list-style:none;padding:0;margin:0 0 10px}
.ai-list li{position:relative;padding:4px 0 4px 22px;font-size:14px;color:var(--text-main);line-height:1.8}
.ai-list li::before{content:'✓';position:absolute;left:2px;color:#22c55e;font-weight:700}
.ai-risk{color:#b45309;font-weight:600;font-size:14px;padding:8px 12px;background:rgba(245,158,11,.08);border-radius:var(--radius-sm);border-left:3px solid #f59e0b;line-height:1.8}
[data-theme="dark"] .ai-risk{background:rgba(245,158,11,.12);color:#fbbf24}
.section-title{font-size:18px;font-weight:800;color:var(--text-title);margin-bottom:20px;display:flex;align-items:center;gap:8px}
.section-title::before{content:'';display:block;width:4px;height:18px;background:var(--brand-color);border-radius:4px}
.charts-grid{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:24px}
.chart-box{background:var(--inset-bg);border-radius:var(--radius-md);padding:16px;height:340px}
.chart-full{background:var(--inset-bg);border-radius:var(--radius-md);padding:16px;height:380px;margin-bottom:20px}
.chart-title{font-size:14px;font-weight:600;color:var(--text-title);text-align:center;margin-bottom:8px}
.val-up{color:var(--up-color);font-weight:600}
.val-down{color:var(--down-color);font-weight:600}
table{width:100%;border-collapse:collapse;font-size:14px}
th{text-align:left;padding:12px 10px;font-size:13px;color:var(--text-sub);border-bottom:1px solid var(--border-color);font-weight:600}
td{padding:13px 10px;border-bottom:1px solid var(--border-light);color:var(--text-title);font-weight:500}
.badge{padding:3px 8px;border-radius:6px;font-size:12px;font-weight:600}
.badge-warn{background:rgba(255,125,0,.1);color:#ff7d00}
.badge-danger{background:rgba(245,63,63,.1);color:#f53f3f}
.badge-ok{background:rgba(0,180,42,.1);color:#00b42a}
.disclaimer{background:var(--inset-bg);border-radius:var(--radius-md);padding:16px 20px;margin-bottom:24px}
.disclaimer p{font-size:12px;color:var(--text-muted);line-height:1.8}
.footer{text-align:center;color:var(--text-muted);font-size:12px;margin-bottom:20px}
.lead-text{font-size:16px;line-height:2;color:var(--text-main)}
.lead-text::first-letter{font-size:48px;font-weight:800;color:var(--brand-color);float:left;line-height:1;margin:6px 10px 0 0}
.insight-text{font-size:15px;line-height:1.9;color:var(--text-main);margin-bottom:18px}
.insight-text:last-child{margin-bottom:0}
.insight-text b{color:var(--text-title)}
.quote-card{background:var(--inset-bg);border-radius:var(--radius-md);padding:24px 28px 20px 44px;position:relative;margin-bottom:16px}
.quote-card:last-child{margin-bottom:0}
.quote-card::before{content:'\201C';position:absolute;left:14px;top:10px;font-size:52px;color:var(--brand-color);opacity:.25;font-family:Georgia,serif;line-height:1}
.quote-text{font-size:15px;font-style:italic;color:var(--text-main);line-height:1.9;margin-bottom:12px}
.quote-author{font-size:14px;font-weight:700;color:var(--text-title);display:inline}
.quote-meta{font-size:13px;color:var(--text-sub);display:inline;margin-left:6px}
.golden-quote{text-align:center;padding:36px 28px}
.golden-quote p{font-size:22px;font-weight:700;color:var(--brand-color);line-height:1.7;letter-spacing:.5px}
.golden-quote .author{font-size:13px;color:var(--text-sub);margin-top:12px;font-weight:400;letter-spacing:0}
.strategy-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.strategy-item{background:var(--inset-bg);border-radius:var(--radius-md);padding:22px 20px;border-top:3px solid var(--brand-color)}
.strategy-item .period{font-size:14px;font-weight:800;color:var(--brand-color);margin-bottom:10px;display:flex;align-items:center;gap:6px}
.strategy-item .desc{font-size:14px;color:var(--text-main);line-height:1.8}
.strategy-item ul{margin:8px 0 0;padding-left:18px;font-size:13px;color:var(--text-main);line-height:1.9}
.strategy-item .position{margin-top:12px;padding:8px 10px;background:var(--card-bg);border-radius:var(--radius-sm);font-size:12px;font-weight:600;color:var(--text-title)}
.sector-block{background:var(--inset-bg);border-radius:var(--radius-sm);padding:16px 20px;margin-bottom:12px}
.sector-block:last-child{margin-bottom:0}
.sector-block h4{font-size:15px;font-weight:700;color:var(--text-title);margin-bottom:6px;display:flex;align-items:center;gap:8px}
.sector-block p{font-size:14px;color:var(--text-main);line-height:1.8}
.summary-text{font-size:14px;color:var(--text-main);line-height:1.8;margin-top:16px;padding:12px 16px;background:var(--inset-bg);border-radius:var(--radius-sm)}
.fund-card{background:var(--inset-bg);border-radius:var(--radius-md);padding:20px;margin-bottom:16px;border-left:4px solid var(--brand-color)}
.fund-card:last-child{margin-bottom:0}
.fund-name{font-size:16px;font-weight:700;color:var(--text-title);margin-bottom:4px}
.fund-code{font-size:13px;color:var(--text-sub);margin-bottom:12px}
.fund-tags{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}
.fund-desc{font-size:14px;color:var(--text-main);line-height:1.8}
.misconception{background:var(--inset-bg);border-radius:var(--radius-md);padding:20px;margin-bottom:16px}
.misconception:last-child{margin-bottom:0}
.misconception .wrong{color:var(--up-color);font-weight:700;margin-bottom:8px;font-size:15px}
.misconception .right{color:var(--down-color);font-weight:700;font-size:15px}
.misconception p{font-size:14px;color:var(--text-main);line-height:1.8;margin-top:6px}
@media(max-width:768px){
  .kpi-grid,.charts-grid,.strategy-grid{grid-template-columns:1fr}
  .hero-title{font-size:22px}
  .golden-quote p{font-size:18px}
  .card{padding:20px 16px}
}
</style>
</head>
<body>
<div class="container">
<!-- CONTENT -->
</div>
<script>
var chartColors=['#165DFF','#F53F3F','#00B42A','#FF7D00','#722ED1','#F7BA1E'];
var charts=[];
function isDark(){return document.documentElement.getAttribute('data-theme')==='dark'}
function tc(){return isDark()?'#EBEBF5':'#4E5969'}
function ttc(){return isDark()?'#FFF':'#1D2129'}
function lc(){return isDark()?'#8E8E93':'#86909C'}
function gc(){return isDark()?'#38383A':'#E5E6EB'}

function toggleTheme(){
  var d=document.documentElement;
  d.setAttribute('data-theme',isDark()?'light':'dark');
  document.getElementById('themeIcon').textContent=isDark()?'☀️':'🌙';
  document.getElementById('themeText').textContent=isDark()?'浅色模式':'深色模式';
  renderAll();
}

function renderAll(){
  charts.forEach(function(c){c.dispose()});
  charts=[];
  // BINDCHARTS
}
window.addEventListener('resize',function(){charts.forEach(function(c){c.resize()})});
renderAll();
</script>
</body>
</html>
```

### 组装步骤

1. **原样复制**上方完整基座代码
2. 将 `<title>` 中的 `{{标题}}` 和 `{{日期}}` 替换为实际值
3. 将 `<!-- CONTENT -->` 替换为下方对应模板的**板块 HTML**
4. 将 `// BINDCHARTS` 替换为对应模板的 **ECharts 初始化代码**（无图表时删除该注释即可）
5. 替换所有 `{{占位符}}` 为 MCP 工具返回的真实数据

---

## 模板一：市场解读

### 板块 HTML

> 将以下 HTML 放入通用基座的 `<!-- CONTENT -->` 位置。

```html
<!-- Topbar -->
<div class="topbar">
  <button class="theme-btn" onclick="toggleTheme()"><span id="themeIcon">🌙</span><span id="themeText">深色模式</span></button>
</div>

<!-- 1. Hero -->
<div class="hero-card">
  <div class="hero-title">{{标题}}</div>
  <div class="hero-sub">{{日期}} · {{副标题摘要}}</div>
  <div class="hero-author">AI投顾创作 · 盈米且慢 &nbsp;|&nbsp; 数据截止：{{日期}}</div>
</div>

<!-- 2. AI 核心观点 -->
<div class="card ai-card">
  <div class="ai-title">💡 AI 核心观点</div>
  <div class="ai-conclusion">{{一句话核心结论，含方向判断}}</div>
  <ul class="ai-list">
    <li>{{要点一，含 <span class="val-up">+X.XX%</span> 或 <span class="val-down">-X.XX%</span> 数字}}</li>
    <li>{{要点二}}</li>
    <li>{{要点三}}</li>
  </ul>
  <div class="ai-risk">⚠️ 风险提示：{{具体风险描述}}。市场观点基于公开数据，不构成投资建议。</div>
</div>

<!-- 3. 市场纵览 -->
<div class="card">
  <div class="section-title">市场纵览</div>
  <p class="lead-text">{{市场纵览正文，首字母会自动下沉放大。200-400字概括全天市场，穿插关键数据。}}</p>
</div>

<!-- 4. 今日行情回顾 -->
<div class="card">
  <div class="section-title">今日行情回顾</div>
  <div class="kpi-grid" style="margin-bottom:20px">
    <div class="kpi"><div class="label">上证综指</div><div class="val val-up">{{点位}} <small>{{涨跌幅}}</small></div></div>
    <div class="kpi"><div class="label">深证成指</div><div class="val val-down">{{点位}} <small>{{涨跌幅}}</small></div></div>
    <div class="kpi"><div class="label">创业板指</div><div class="val val-up">{{点位}} <small>{{涨跌幅}}</small></div></div>
    <div class="kpi"><div class="label">两市成交</div><div class="val">{{金额}}<small>亿</small></div></div>
  </div>
  <div style="overflow-x:auto">
  <table>
    <thead><tr><th>指数</th><th>收盘价</th><th>涨跌额</th><th>涨跌幅</th><th>成交额</th></tr></thead>
    <tbody>
      <tr><td><b>上证综指</b></td><td>{{收盘价}}</td><td class="val-up">{{涨跌额}}</td><td class="val-up">{{涨跌幅}}</td><td>{{成交额}}</td></tr>
      <!-- 深证成指、创业板指、科创50、沪深300、中证500 同结构 -->
    </tbody>
  </table>
  </div>
  <div class="summary-text">{{行情总结，2-3句话}}</div>
</div>

<!-- 5. 板块热点追踪 -->
<div class="card">
  <div class="section-title">板块热点追踪</div>
  <div class="chart-full">
    <div class="chart-title">今日板块涨跌幅（%）</div>
    <div id="sectorChart" style="width:100%;height:320px"></div>
  </div>
  <div class="sector-block">
    <h4>🔥 {{板块名}} <span class="val-up" style="font-size:14px">+{{涨幅}}%</span></h4>
    <p>{{板块分析，2-3句话，含原因和相关主题基金}}</p>
  </div>
  <!-- 重复 sector-block，按涨幅从高到低排列，3-5 个 -->
</div>

<!-- 6. 资金面分析 -->
<div class="card">
  <div class="section-title">资金面分析</div>
  <div class="kpi-grid" style="margin-bottom:20px;grid-template-columns:repeat(3,1fr)">
    <div class="kpi"><div class="label">北向资金净流入</div><div class="val val-up">+{{金额}}<small>亿</small></div></div>
    <div class="kpi"><div class="label">融资余额</div><div class="val">{{金额}}<small>亿</small></div></div>
    <div class="kpi"><div class="label">两市成交额</div><div class="val">{{金额}}<small>亿</small></div></div>
  </div>
  <div class="charts-grid">
    <div class="chart-box">
      <div class="chart-title">近5日成交额走势（亿元）</div>
      <div id="volumeChart" style="width:100%;height:280px"></div>
    </div>
    <div class="chart-box">
      <div class="chart-title">近5日北向资金净流入（亿元）</div>
      <div id="northFlowChart" style="width:100%;height:280px"></div>
    </div>
  </div>
  <div class="summary-text">{{资金面总结，2-3句话}}</div>
</div>

<!-- 7. 经理观点精选 -->
<div class="card">
  <div class="section-title">经理观点精选</div>
  <div class="quote-card">
    <p class="quote-text">"{{经理观点引用原文}}"</p>
    <span class="quote-author">{{经理姓名}}</span>
    <span class="quote-meta">· {{基金公司}} · {{补充信息}}</span>
  </div>
  <!-- 重复 quote-card，2-3 位经理 -->
</div>

<!-- 8. AI 深度点评 -->
<div class="card">
  <div class="section-title">AI 深度点评</div>
  <p class="insight-text">{{深度分析段落一，200-300字，含数据引用和加粗关键词}}</p>
  <p class="insight-text">{{深度分析段落二}}</p>
  <p class="insight-text">{{深度分析段落三}}</p>
</div>

<!-- 9. 后市展望与策略建议 -->
<div class="card">
  <div class="section-title">后市展望与策略建议</div>
  <div class="strategy-grid">
    <div class="strategy-item">
      <div class="period">📅 短期（1-2周）</div>
      <ul><li>{{建议一}}</li><li>{{建议二}}</li><li>{{建议三}}</li></ul>
      <div class="position">建议仓位：{{配置建议}}</div>
    </div>
    <div class="strategy-item">
      <div class="period">📅 中期（1-3月）</div>
      <ul><li>{{建议一}}</li><li>{{建议二}}</li><li>{{建议三}}</li></ul>
      <div class="position">建议仓位：{{配置建议}}</div>
    </div>
    <div class="strategy-item">
      <div class="period">📅 长期（6-12月）</div>
      <ul><li>{{建议一}}</li><li>{{建议二}}</li><li>{{建议三}}</li></ul>
      <div class="position">建议仓位：{{配置建议}}</div>
    </div>
  </div>
  <div class="summary-text">以上策略建议基于当前市场环境与公开数据分析，仅供参考。实际操作中需根据个人风险偏好、投资期限及市场变化灵活调整。</div>
</div>

<!-- 10. 今日金句 -->
<div class="card">
  <div class="golden-quote">
    <p>{{诗句或金句}}</p>
    <div class="author">AI投顾创作 · 盈米且慢</div>
  </div>
</div>

<!-- 11. 免责声明 -->
<div class="disclaimer">
  <p><b>免责声明：</b>以上内容基于公开数据和已发布观点整理，仅供参考，不构成投资建议。基金有风险，投资需谨慎。数据来源：盈米且慢。</p>
</div>

<!-- 12. 页脚 -->
<div class="footer">Powered by 盈米MCP · {{日期}}</div>
```

### ECharts 初始化代码

> 将以下代码放入通用基座 `// BINDCHARTS` 位置，替换 `{{数据}}` 为真实数值。

```javascript
// 板块涨跌幅水平柱状图
var sectorNames=[{{板块名称数组 — 来自 GetLatestQuotations 申万一级行业}}];
var sectorData=[{{对应涨跌幅数组 — 来自 GetLatestQuotations}}];
var s1=echarts.init(document.getElementById('sectorChart'));
s1.setOption({
  tooltip:{trigger:'axis',axisPointer:{type:'shadow'},formatter:function(p){return p[0].name+': <b>'+(p[0].value>0?'+':'')+p[0].value+'%</b>'}},
  grid:{left:90,right:40,top:10,bottom:20},
  xAxis:{type:'value',axisLabel:{formatter:'{value}%',color:lc()},splitLine:{lineStyle:{color:gc()}}},
  yAxis:{type:'category',data:sectorNames,axisLabel:{color:tc(),fontSize:13,fontWeight:500}},
  series:[{type:'bar',data:sectorData.map(function(v){return{value:v,itemStyle:{color:v>=0?'#F53F3F':'#00B42A',borderRadius:v>=0?[0,4,4,0]:[4,0,0,4]}}}),barWidth:22,label:{show:true,position:'right',formatter:function(p){return(p.value>0?'+':'')+p.value+'%'},color:tc(),fontSize:12,fontWeight:600}}]
});
charts.push(s1);

// 近5日成交额折线图
var dates=[{{日期数组 — 来自 GetLatestQuotations 近 5 个交易日}}];
var volumes=[{{成交额数组 — 来自 GetLatestQuotations}}];
var s2=echarts.init(document.getElementById('volumeChart'));
s2.setOption({
  tooltip:{trigger:'axis',formatter:function(p){return p[0].name+'<br/>成交额: <b>'+p[0].value+'</b> 亿元'}},
  grid:{left:60,right:20,top:20,bottom:30},
  xAxis:{type:'category',data:dates,axisLabel:{color:lc()},axisLine:{lineStyle:{color:gc()}}},
  yAxis:{type:'value',min:Math.floor(Math.min.apply(null,volumes)*0.9),axisLabel:{color:lc()},splitLine:{lineStyle:{color:gc()}}},
  series:[{type:'line',data:volumes,smooth:true,symbol:'circle',symbolSize:8,
    lineStyle:{color:chartColors[0],width:3},
    itemStyle:{color:chartColors[0],borderWidth:2,borderColor:'#fff'},
    areaStyle:{color:new echarts.graphic.LinearGradient(0,0,0,1,[{offset:0,color:isDark()?'rgba(22,93,255,0.35)':'rgba(22,93,255,0.2)'},{offset:1,color:'rgba(22,93,255,0)'}])}}]
});
charts.push(s2);

// 近5日北向资金柱状图
var northData=[{{北向资金数组 — 来自 GetLatestQuotations}}];
var s3=echarts.init(document.getElementById('northFlowChart'));
s3.setOption({
  tooltip:{trigger:'axis',formatter:function(p){return p[0].name+'<br/>净流入: <b>'+(p[0].value>0?'+':'')+p[0].value+'</b> 亿元'}},
  grid:{left:55,right:20,top:20,bottom:30},
  xAxis:{type:'category',data:dates,axisLabel:{color:lc()},axisLine:{lineStyle:{color:gc()}}},
  yAxis:{type:'value',axisLabel:{color:lc()},splitLine:{lineStyle:{color:gc()}}},
  series:[{type:'bar',data:northData.map(function(v){return{value:v,itemStyle:{color:v>=0?'#F53F3F':'#00B42A',borderRadius:v>=0?[4,4,0,0]:[0,0,4,4]}}}),barWidth:32,
    label:{show:true,position:'top',formatter:function(p){return(p.value>0?'+':'')+p.value},color:tc(),fontSize:11,fontWeight:600}}]
});
charts.push(s3);
```

### Markdown 版

```markdown
# {{标题}}

> {{副标题/一句话摘要}} | {{日期}}

## 行情回顾

{{日期}}，A股三大指数{{涨跌描述}}。

- **上证指数**：{{点位}}，{{涨跌幅}}%
- **深证成指**：{{点位}}，{{涨跌幅}}%
- **创业板指**：{{点位}}，{{涨跌幅}}%

成交额合计{{金额}}亿元，较前一交易日{{增减描述}}。

板块方面，{{领涨板块}}领涨，{{领跌板块}}领跌。

## 原因分析

### 消息面

{{基于 SearchFinancialNews 的新闻摘要，2-3 条关键新闻}}

### 资金面

{{成交量变化、北向资金动向等}}

### 行业驱动

{{主要板块异动原因分析}}

## 机构观点

> "{{经理观点引用}}"
> —— {{经理姓名}}，{{基金公司}}（来源：盈米且慢）

## 后市关注

{{基于数据和观点的综合判断，不做方向性预测}}

**关注要点**：
1. {{关注点一}}
2. {{关注点二}}
3. {{关注点三}}

---

*免责声明：以上内容基于公开数据和已发布观点整理，仅供参考，不构成投资建议。基金有风险，投资需谨慎。数据来源：盈米且慢。*
```

---

## 模板二：基金推荐

### 板块 HTML

> 将以下 HTML 放入通用基座的 `<!-- CONTENT -->` 位置。

```html
<!-- Topbar -->
<div class="topbar">
  <button class="theme-btn" onclick="toggleTheme()"><span id="themeIcon">🌙</span><span id="themeText">深色模式</span></button>
</div>

<!-- 1. Hero -->
<div class="hero-card">
  <div class="hero-title">{{推荐主题标题}}</div>
  <div class="hero-sub">{{日期}} · {{副标题}}</div>
  <div class="hero-author">AI投顾创作 · 盈米且慢 &nbsp;|&nbsp; 数据截止：{{日期}}</div>
</div>

<!-- 2. AI 核心观点 -->
<div class="card ai-card">
  <div class="ai-title">💡 AI 核心观点</div>
  <div class="ai-conclusion">{{推荐核心结论}}</div>
  <ul class="ai-list">
    <li>{{亮点要点一}}</li>
    <li>{{亮点要点二}}</li>
    <li>{{亮点要点三}}</li>
  </ul>
  <div class="ai-risk">⚠️ 风险提示：基金过往业绩不预示未来表现。{{具体风险描述}}。</div>
</div>

<!-- 3. 推荐逻辑 -->
<div class="card">
  <div class="section-title">为什么关注{{主题}}</div>
  <p class="insight-text">{{从投资者痛点切入，说明赛道逻辑和当下关注理由，2-3段}}</p>
</div>

<!-- 4. 精选基金推荐 -->
<div class="card">
  <div class="section-title">精选基金推荐</div>
  <div class="fund-card">
    <div class="fund-name">{{基金名称}}</div>
    <div class="fund-code">{{基金代码}} · {{基金类型}}</div>
    <div class="fund-tags">
      <span class="badge badge-ok">{{标签如：近1年同类前10%}}</span>
      <span class="badge badge-warn">{{标签如：中高风险}}</span>
    </div>
    <div class="kpi-grid" style="grid-template-columns:repeat(4,1fr);margin-bottom:12px">
      <div class="kpi"><div class="label">近1年收益</div><div class="val val-up" style="font-size:18px">{{收益率}}</div></div>
      <div class="kpi"><div class="label">最大回撤</div><div class="val val-down" style="font-size:18px">{{回撤}}</div></div>
      <div class="kpi"><div class="label">基金规模</div><div class="val" style="font-size:18px">{{规模}}<small>亿</small></div></div>
      <div class="kpi"><div class="label">基金经理</div><div class="val" style="font-size:16px">{{经理姓名}}</div></div>
    </div>
    <p class="fund-desc">{{推荐理由，2-3句话}}</p>
  </div>
  <!-- 重复 fund-card，每只基金一张，推荐 2-5 只 -->
</div>

<!-- 5. 业绩对比 -->
<div class="card">
  <div class="section-title">业绩对比</div>
  <div class="chart-full">
    <div class="chart-title">各阶段收益对比（%）</div>
    <div id="perfChart" style="width:100%;height:340px"></div>
  </div>
  <div style="overflow-x:auto">
  <table>
    <thead><tr><th>基金名称</th><th>近1月</th><th>近3月</th><th>近6月</th><th>近1年</th><th>同类排名</th></tr></thead>
    <tbody>
      <tr><td><b>{{基金名}}</b></td><td class="val-up">{{收益}}</td><td class="val-up">{{收益}}</td><td class="val-up">{{收益}}</td><td class="val-up">{{收益}}</td><td>{{排名}}</td></tr>
      <!-- 每只基金一行 -->
    </tbody>
  </table>
  </div>
</div>

<!-- 6. 风险对比 -->
<div class="card">
  <div class="section-title">风险指标</div>
  <div style="overflow-x:auto">
  <table>
    <thead><tr><th>基金名称</th><th>最大回撤</th><th>年化波动率</th><th>夏普比率</th><th>风险等级</th></tr></thead>
    <tbody>
      <tr><td><b>{{基金名}}</b></td><td class="val-down">{{回撤}}</td><td>{{波动率}}</td><td>{{夏普}}</td><td><span class="badge badge-warn">{{等级}}</span></td></tr>
      <!-- 每只基金一行 -->
    </tbody>
  </table>
  </div>
</div>

<!-- 7. 基金经理点评 -->
<div class="card">
  <div class="section-title">基金经理点评</div>
  <div class="quote-card">
    <p class="quote-text">"{{经理观点或投资理念}}"</p>
    <span class="quote-author">{{经理姓名}}</span>
    <span class="quote-meta">· {{基金公司}} · 从业{{年限}}年 · 管理规模{{规模}}亿</span>
  </div>
  <!-- 每位经理一张 quote-card -->
</div>

<!-- 8. 风险提示 -->
<div class="card">
  <div class="section-title">风险提示</div>
  <div class="ai-risk">⚠️ <b>重要提示</b>：以上基金推荐基于历史数据分析，基金过往业绩不预示未来表现。{{该类基金具体风险特征}}。适合投资者类型：{{风险偏好描述}}。建议持有期限：{{持有期建议}}。</div>
</div>

<!-- 9. 免责声明 -->
<div class="disclaimer">
  <p><b>免责声明：</b>以上内容基于公开数据和已发布观点整理，仅供参考，不构成投资建议。基金有风险，投资需谨慎。数据来源：盈米且慢。</p>
</div>

<!-- 10. 页脚 -->
<div class="footer">Powered by 盈米MCP · {{日期}}</div>
```

### ECharts 初始化代码

```javascript
// 各阶段收益对比柱状图
var periods=['近1月','近3月','近6月','近1年'];
var s1=echarts.init(document.getElementById('perfChart'));
s1.setOption({
  tooltip:{trigger:'axis',axisPointer:{type:'shadow'}},
  legend:{bottom:0,textStyle:{color:tc(),fontSize:12}},
  grid:{left:50,right:20,top:20,bottom:40},
  xAxis:{type:'category',data:periods,axisLabel:{color:lc()},axisLine:{lineStyle:{color:gc()}}},
  yAxis:{type:'value',axisLabel:{formatter:'{value}%',color:lc()},splitLine:{lineStyle:{color:gc()}}},
  series:[
    {name:'{{基金名1}}',type:'bar',data:[{{各阶段收益}}],itemStyle:{color:chartColors[0],borderRadius:[4,4,0,0]},barWidth:20},
    {name:'{{基金名2}}',type:'bar',data:[{{各阶段收益}}],itemStyle:{color:chartColors[1],borderRadius:[4,4,0,0]},barWidth:20}
    // 每只基金一个 series
  ]
});
charts.push(s1);
```

### Markdown 版

```markdown
# {{标题}}

> {{副标题}} | {{日期}}

## 为什么关注{{主题}}

{{从投资者需求或市场热点切入，说明为什么现在值得关注这类基金}}

## 精选基金推荐

### {{基金名称一}}（{{基金代码}}）

**核心亮点**：
- {{亮点一}}
- {{亮点二}}

**业绩表现**（截至{{日期}}）：

| 时间段 | 收益率 | 同类排名 |
|-------|-------|---------|
| 近 1 月 | {{收益率}}% | {{排名}} |
| 近 3 月 | {{收益率}}% | {{排名}} |
| 近 6 月 | {{收益率}}% | {{排名}} |
| 近 1 年 | {{收益率}}% | {{排名}} |

**风险指标**：最大回撤 {{数值}}% · 波动率 {{数值}}% · 夏普比率 {{数值}}

**基金经理**：{{经理姓名}}，从业{{年限}}年，管理规模{{规模}}亿

---

## 风险提示

⚠️ 以上基金推荐基于历史数据分析，**基金过往业绩不预示未来表现**。{{具体风险特征}}。适合投资者：{{风险偏好}}。建议持有期：{{持有期}}。

---

*免责声明：以上内容基于公开数据和已发布观点整理，仅供参考，不构成投资建议。基金有风险，投资需谨慎。数据来源：盈米且慢。*
```

---

## 模板三：投教科普

### 板块 HTML

> 将以下 HTML 放入通用基座的 `<!-- CONTENT -->` 位置。无 ECharts，`// BINDCHARTS` 处留空即可。

```html
<!-- Topbar -->
<div class="topbar">
  <button class="theme-btn" onclick="toggleTheme()"><span id="themeIcon">🌙</span><span id="themeText">深色模式</span></button>
</div>

<!-- 1. Hero -->
<div class="hero-card">
  <div class="hero-title">{{科普主题标题}}</div>
  <div class="hero-sub">{{日期}} · 投教科普</div>
  <div class="hero-author">AI投顾创作 · 盈米且慢</div>
</div>

<!-- 2. AI 核心观点 -->
<div class="card ai-card">
  <div class="ai-title">💡 一句话读懂</div>
  <div class="ai-conclusion">{{用一句通俗的话概括核心概念}}</div>
  <ul class="ai-list">
    <li>{{知识要点一}}</li>
    <li>{{知识要点二}}</li>
    <li>{{知识要点三}}</li>
  </ul>
  <div class="ai-risk">⚠️ 以上为投资知识科普，不构成投资建议。投资有风险，入市需谨慎。</div>
</div>

<!-- 3. 生活场景引入 -->
<div class="card">
  <div class="section-title">{{生活场景标题}}</div>
  <p class="lead-text">{{用日常生活场景类比投资概念的段落，激发读者兴趣}}</p>
</div>

<!-- 4. 核心概念解释 -->
<div class="card">
  <div class="section-title">{{核心概念标题}}</div>
  <p class="insight-text">{{概念的通俗解释段落一}}</p>
  <p class="insight-text">{{概念的通俗解释段落二}}</p>
  <div class="kpi-grid" style="grid-template-columns:repeat(3,1fr);margin-top:16px">
    <div class="kpi"><div class="label">{{术语一}}</div><div class="val" style="font-size:16px">{{解释}}</div></div>
    <div class="kpi"><div class="label">{{术语二}}</div><div class="val" style="font-size:16px">{{解释}}</div></div>
    <div class="kpi"><div class="label">{{术语三}}</div><div class="val" style="font-size:16px">{{解释}}</div></div>
  </div>
</div>

<!-- 5. 举个例子 -->
<div class="card">
  <div class="section-title">举个例子</div>
  <p class="insight-text">{{用具体案例帮助理解}}</p>
  <div class="quote-card">
    <p class="quote-text">"{{可选：经理观点佐证}}"</p>
    <span class="quote-author">{{经理姓名}}</span>
    <span class="quote-meta">· {{基金公司}}</span>
  </div>
</div>

<!-- 6. 实操建议 -->
<div class="card">
  <div class="section-title">实操建议</div>
  <div class="strategy-grid" style="grid-template-columns:1fr 1fr 1fr">
    <div class="strategy-item">
      <div class="period">💡 {{建议标题一}}</div>
      <div class="desc">{{建议内容}}</div>
    </div>
    <div class="strategy-item">
      <div class="period">💡 {{建议标题二}}</div>
      <div class="desc">{{建议内容}}</div>
    </div>
    <div class="strategy-item">
      <div class="period">💡 {{建议标题三}}</div>
      <div class="desc">{{建议内容}}</div>
    </div>
  </div>
</div>

<!-- 7. 常见误区 -->
<div class="card">
  <div class="section-title">常见误区</div>
  <div class="misconception">
    <div class="wrong">❌ 误区：{{误区描述}}</div>
    <p>{{误区详细说明}}</p>
    <div class="right" style="margin-top:12px">✅ 正确理解：{{纠正}}</div>
  </div>
  <!-- 重复 misconception，2-3 个 -->
</div>

<!-- 8. 免责声明 -->
<div class="disclaimer">
  <p><b>免责声明：</b>以上内容基于公开数据和已发布观点整理，仅供参考，不构成投资建议。基金有风险，投资需谨慎。数据来源：盈米且慢。</p>
</div>

<!-- 9. 页脚 -->
<div class="footer">Powered by 盈米MCP · {{日期}}</div>
```

### Markdown 版

```markdown
# {{标题}}

> {{一句话摘要}} | {{日期}}

## {{生活场景引入标题}}

{{用日常生活场景类比投资概念，1-2 段}}

## {{核心概念标题}}

{{概念的通俗解释}}

**关键词解释**：
- **{{术语一}}**：{{解释}}
- **{{术语二}}**：{{解释}}

## 举个例子

{{用具体案例帮助理解}}

> "{{观点}}"
> —— {{来源}}

## 实操建议

1. {{建议一}}
2. {{建议二}}
3. {{建议三}}

## 常见误区

❌ **误区一**：{{误区描述}}
✅ **正确理解**：{{纠正}}

❌ **误区二**：{{误区描述}}
✅ **正确理解**：{{纠正}}

---

*免责声明：以上内容基于公开数据和已发布观点整理，仅供参考，不构成投资建议。基金有风险，投资需谨慎。数据来源：盈米且慢。*
```

---

## 模板四：热点评论

### 板块 HTML

> 将以下 HTML 放入通用基座的 `<!-- CONTENT -->` 位置。

```html
<!-- Topbar -->
<div class="topbar">
  <button class="theme-btn" onclick="toggleTheme()"><span id="themeIcon">🌙</span><span id="themeText">深色模式</span></button>
</div>

<!-- 1. Hero -->
<div class="hero-card">
  <div class="hero-title">{{热点主题标题}}</div>
  <div class="hero-sub">{{日期}} · 热点评论</div>
  <div class="hero-author">AI投顾创作 · 盈米且慢 &nbsp;|&nbsp; 数据截止：{{日期}}</div>
</div>

<!-- 2. AI 核心观点 -->
<div class="card ai-card">
  <div class="ai-title">💡 AI 核心观点</div>
  <div class="ai-conclusion">{{事件定性 + 影响判断一句话}}</div>
  <ul class="ai-list">
    <li>{{影响要点一}}</li>
    <li>{{影响要点二}}</li>
    <li>{{影响要点三}}</li>
  </ul>
  <div class="ai-risk">⚠️ 风险提示：{{事件后续不确定性描述}}。以上分析基于当前已知信息，不构成投资建议。</div>
</div>

<!-- 3. 事件概述 -->
<div class="card">
  <div class="section-title">事件概述</div>
  <p class="lead-text">{{事件的5W1H结构化描述，200-300字}}</p>
</div>

<!-- 4. 行情数据佐证 -->
<div class="card">
  <div class="section-title">行情数据佐证</div>
  <div class="kpi-grid" style="margin-bottom:20px">
    <div class="kpi"><div class="label">{{相关指数/板块}}</div><div class="val val-up">{{涨跌幅}}</div></div>
    <div class="kpi"><div class="label">{{相关指数/板块}}</div><div class="val val-down">{{涨跌幅}}</div></div>
    <div class="kpi"><div class="label">{{相关指数/板块}}</div><div class="val val-up">{{涨跌幅}}</div></div>
    <div class="kpi"><div class="label">两市成交</div><div class="val">{{金额}}<small>亿</small></div></div>
  </div>
  <div class="chart-full">
    <div class="chart-title">{{图表标题}}</div>
    <div id="hotChart" style="width:100%;height:320px"></div>
  </div>
</div>

<!-- 5. 影响分析 -->
<div class="card">
  <div class="section-title">影响分析</div>
  <div class="sector-block">
    <h4>📊 对市场的影响</h4>
    <p>{{分析事件对市场整体的影响}}</p>
  </div>
  <div class="sector-block">
    <h4>🏭 对行业的影响</h4>
    <p>{{分析事件对相关行业的影响}}</p>
  </div>
  <div class="sector-block">
    <h4>💰 对相关基金的影响</h4>
    <p>{{分析事件对相关基金的影响}}</p>
  </div>
</div>

<!-- 6. 投资启示 -->
<div class="card">
  <div class="section-title">投资启示</div>
  <p class="insight-text">{{不构成建议的客观启示，2-3段}}</p>
</div>

<!-- 7. 风险提示 -->
<div class="card">
  <div class="section-title">风险提示</div>
  <div class="ai-risk">⚠️ {{详细风险提示，事件后续不确定性、投资风险等}}</div>
</div>

<!-- 8. 免责声明 -->
<div class="disclaimer">
  <p><b>免责声明：</b>以上内容基于公开数据和已发布观点整理，仅供参考，不构成投资建议。基金有风险，投资需谨慎。数据来源：盈米且慢。</p>
</div>

<!-- 9. 页脚 -->
<div class="footer">Powered by 盈米MCP · {{日期}}</div>
```

### ECharts 初始化代码

```javascript
// 热点相关板块涨跌幅（按实际需要选择柱状图/折线图）
var s1=echarts.init(document.getElementById('hotChart'));
s1.setOption({
  tooltip:{trigger:'axis',axisPointer:{type:'shadow'}},
  grid:{left:90,right:40,top:10,bottom:20},
  xAxis:{type:'value',axisLabel:{formatter:'{value}%',color:lc()},splitLine:{lineStyle:{color:gc()}}},
  yAxis:{type:'category',data:[{{板块名称数组}}],axisLabel:{color:tc(),fontSize:13,fontWeight:500}},
  series:[{type:'bar',data:[{{涨跌幅数组}}].map(function(v){return{value:v,itemStyle:{color:v>=0?'#F53F3F':'#00B42A',borderRadius:v>=0?[0,4,4,0]:[4,0,0,4]}}}),barWidth:22,
    label:{show:true,position:'right',formatter:function(p){return(p.value>0?'+':'')+p.value+'%'},color:tc(),fontSize:12,fontWeight:600}}]
});
charts.push(s1);
```

### Markdown 版

```markdown
# {{标题}}

> {{一句话摘要}} | {{日期}}

## 事件回顾

{{热点事件的客观描述，来自 SearchHotTopic / SearchFinancialNews}}

**关键信息**：
- {{信息点一}}
- {{信息点二}}
- {{信息点三}}

## 影响分析

### 对市场的影响

{{分析事件对市场整体的影响，含行情数据佐证}}

### 对行业的影响

{{分析事件对相关行业/板块的影响}}

## 投资启示

1. {{启示一}}
2. {{启示二}}
3. {{启示三}}

> ⚠️ 以上分析基于当前已知信息，事件仍在发展中，后续影响存在不确定性。

---

*免责声明：以上内容基于公开数据和已发布观点整理，仅供参考，不构成投资建议。基金有风险，投资需谨慎。数据来源：盈米且慢。*
```

---

## 模板五：短文案

> 短文案为轻量交付，**不要求**使用通用 HTML 基座的完整结构。可使用以下精简卡片骨架，或直接输出纯文本。

### HTML 精简卡片

```html
<!DOCTYPE html>
<html lang="zh-CN" data-theme="light">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>{{标题}}</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Noto+Sans+SC:wght@400;500;600;700;800&display=swap');
:root{
  --up-color:#F53F3F;--down-color:#00B42A;
  --brand-color:#165DFF;--brand-bg:#E8F0FF;
  --page-bg:#F2F3F5;--card-bg:#FFFFFF;--inset-bg:#F7F8FA;
  --text-title:#1D2129;--text-main:#4E5969;--text-sub:#86909C;--text-muted:#C9CDD4;
  --border-light:#F2F3F5;
  --shadow-soft:0 4px 24px rgba(29,33,41,0.04);
  --radius-lg:24px;--radius-md:16px;--radius-sm:8px;
}
*{box-sizing:border-box;margin:0}
body{background:var(--page-bg);color:var(--text-main);font-family:'Inter','Noto Sans SC',sans-serif;line-height:1.7;display:flex;justify-content:center;padding:20px}
.short-card{background:var(--card-bg);border-radius:var(--radius-lg);padding:32px;max-width:480px;width:100%;box-shadow:var(--shadow-soft)}
.short-title{font-size:20px;font-weight:800;color:var(--text-title);margin-bottom:16px;line-height:1.4}
.short-body{font-size:15px;color:var(--text-main);line-height:1.9;margin-bottom:16px}
.short-data{display:flex;gap:12px;margin-bottom:16px}
.short-data .item{flex:1;background:var(--inset-bg);border-radius:var(--radius-sm);padding:12px;text-align:center}
.short-data .label{font-size:12px;color:var(--text-sub);margin-bottom:2px}
.short-data .val{font-size:18px;font-weight:800;color:var(--text-title)}
.val-up{color:var(--up-color);font-weight:600}
.val-down{color:var(--down-color);font-weight:600}
.short-cta{font-size:14px;color:var(--brand-color);font-weight:600;margin-bottom:16px}
.short-risk{font-size:12px;color:var(--text-muted);line-height:1.8;padding-top:12px;border-top:1px solid var(--border-light)}
</style>
</head>
<body>
<div class="short-card">
  <div class="short-title">{{核心观点标题}}</div>
  <div class="short-body">{{正文，2-3句话}}</div>
  <div class="short-data">
    <div class="item"><div class="label">{{数据标签一}}</div><div class="val val-up">{{数据}}</div></div>
    <div class="item"><div class="label">{{数据标签二}}</div><div class="val">{{数据}}</div></div>
  </div>
  <div class="short-cta">{{行动引导语}}</div>
  <div class="short-risk">⚠️ 基金有风险，投资需谨慎。以上不构成投资建议。数据来源：盈米且慢。</div>
</div>
</body>
</html>
```

### 纯文本版

**基金推荐类**：

```
{{核心观点，一句话抓眼球}}

📊 {{数据亮点一}}
📈 {{数据亮点二}}

{{一句话行动引导}}

⚠️ 基金有风险，投资需谨慎。以上不构成投资建议。
```

**市场点评类**：

```
【{{主题标签}}】

{{市场核心数据，一句话概括}}

{{原因简析，1-2 句}}

{{观点/展望，1 句}}

数据来源：盈米且慢
```

**投教金句类**：

```
💡 {{投教核心观点}}

{{1-2 句展开解释}}

{{可选：经理名言引用}}

#投资理财 #{{相关标签}}
```

---

## 通用规则

### 数据引用格式

- 行情数据：`数据来源：盈米且慢，截至{{YYYY-MM-DD}}`
- 基金业绩：`截至{{YYYY-MM-DD}}，数据来源：盈米且慢`
- 经理观点：`{{经理姓名}}，{{基金公司}}（来源：盈米且慢）`
- AI 分析：`来源：盈米且慢 AI 分析`

### 免责声明

所有模板的末尾必须包含以下免责声明（不可省略、不可修改核心内容）：

> 免责声明：以上内容基于公开数据和已发布观点整理，仅供参考，不构成投资建议。基金有风险，投资需谨慎。数据来源：盈米且慢。

### 占位符替换规则

- `{{xxx}}`：必须替换为 MCP 工具返回的真实数据
- 无对应数据时：标注"数据暂未获取"，不保留占位符
- 日期类占位符：替换为工具返回数据的实际截止日期

### 涨跌颜色规则

- 涨（正值）：`class="val-up"`
- 跌（负值）：`class="val-down"`
- 平或无涨跌属性：不加 class
