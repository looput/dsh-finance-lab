import json
import os
import subprocess
import html
from pathlib import Path

# 本仓库内路径：skills/wealth-report/ 为根
_wealth_report = Path(__file__).resolve().parent.parent
_skills_root = _wealth_report.parent
report_script = _wealth_report / "scripts" / "run.py"
input_path = _wealth_report / "report-input.json"
out_json_path = _wealth_report / "report-output.json"
out_html_path = _wealth_report / "report-output.html"

env = os.environ.copy()
env["PYTHONPATH"] = os.pathsep.join(
    [
        str(_skills_root / "wealth-healthcheck" / "scripts"),
        str(_skills_root / "wealth-goalcalc" / "scripts"),
    ]
)
env["PYTHONIOENCODING"] = "utf-8"

data = Path(input_path).read_text(encoding="utf-8")
p = subprocess.run(
    ["python", str(report_script)],
    input=data,
    capture_output=True,
    env=env,
    encoding="utf-8",
    errors="replace",
)
if p.returncode != 0:
    raise RuntimeError(p.stderr)

result = p.stdout
Path(out_json_path).write_text(result, encoding="utf-8")
obj = json.loads(result)

parts = []
meta = obj.get("report_meta", {})
parts.append(f"<h1>{html.escape(str(meta.get('title', '财务规划报告')))}</h1>")
parts.append(f"<p><strong>家庭：</strong>{html.escape(str(meta.get('family_summary', '-')))}</p>")
parts.append("<h2>模块明细</h2><ol>")

for s in obj.get("sections", []):
    title = html.escape(str(s.get("title", "")))
    sid = html.escape(str(s.get("id", "")))
    data_block = html.escape(json.dumps(s.get("data", None), ensure_ascii=False, indent=2))
    parts.append(f"<li><h3>{title} <small style='color:#6b7280'>({sid})</small></h3><pre>{data_block}</pre></li>")

parts.append("</ol>")
parts.append(f"<h2>免责声明</h2><p>{html.escape(str(obj.get('disclaimer', '')))}</p>")

page = """<!doctype html>
<html lang=\"zh-CN\">
<head>
  <meta charset=\"utf-8\" />
  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />
  <title>财务规划报告</title>
  <style>
    body { font-family: Segoe UI, Microsoft YaHei, sans-serif; background:#f6f8fb; color:#111827; margin:0; }
    main { max-width:1000px; margin:24px auto; padding:24px; background:#fff; border-radius:14px; box-shadow:0 8px 30px rgba(0,0,0,.06); }
    h1 { margin-top:0; }
    h2 { margin-top:24px; border-left:4px solid #1b88ee; padding-left:8px; }
    pre { white-space:pre-wrap; word-break:break-word; background:#f3f4f6; padding:12px; border-radius:8px; border:1px solid #e5e7eb; }
  </style>
</head>
<body>
  <main>
""" + "".join(parts) + """
  </main>
</body>
</html>"""

Path(out_html_path).write_text(page, encoding="utf-8")
print("OK")
