import json,sys,statistics as st
d=json.load(open(sys.argv[1]))
tools=['simwright','appium','mcp']
def fmt_ms(ms): return f"{ms/1000:.2f} s" if ms>=1000 else f"{ms:.0f} ms"
def fmt_b(b):
    return f"{b/1024/1024:.1f} MB" if b>=1024*1024 else (f"{b/1024:.0f} KB" if b>=1024 else f"{b:.0f} B")
print("| Feature | simwright | Appium (raw HTTP) | Appium MCP |\n|---|---|---|---|")
for op,t in d.items():
    cells=[]
    for tool in tools:
        v=t.get(tool)
        if not v: cells.append("— not available"); continue
        ok=[x for x in v if not x['err']]
        fails=len(v)-len(ok)
        if not ok: cells.append(f"✗ failed {fails}/{len(v)}"); continue
        ms=st.median([x['ms'] for x in ok]); b=st.median([x['bytes'] for x in ok]); c=st.median([x['calls'] for x in ok])
        s=f"{fmt_ms(ms)} · {fmt_b(b)}"
        if 'frames' in ok[0]: s=f"{ok[0]['frames']} frames · {fmt_b(ok[0]['bytes'])}"
        if c>1 and 'frames' not in ok[0]: s+=f" · {c:g} calls"
        if fails: s+=f" · ⚠ {fails}/{len(v)} failed"
        cells.append(s)
    print(f"| {op} | "+" | ".join(cells)+" |")
