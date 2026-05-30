#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""MT5 login market forecast — stdin JSON, stdout JSON."""

from __future__ import annotations

import json
import math
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

BANGKOK = timezone(timedelta(hours=7))


def read_input() -> dict:
    raw = sys.stdin.read()
    if not raw.strip():
        raise ValueError("empty stdin")
    return json.loads(raw)


def is_weekend(dt: datetime) -> bool:
    return dt.weekday() >= 5


def trading_day_keys(history: list) -> list:
    out = []
    for row in history or []:
        key = str(row.get("day_key") or "")[:10]
        if not key:
            continue
        try:
            dt = datetime.strptime(key, "%Y-%m-%d").replace(tzinfo=BANGKOK)
        except ValueError:
            continue
        if is_weekend(dt):
            continue
        out.append({**row, "day_key": key})
    return out


def compute_stats(rows: list) -> dict:
    pnls = [float(r.get("pnl") or 0) for r in rows]
    if not pnls:
        return {
            "days": 0,
            "avg_daily_pnl": 0.0,
            "std_daily_pnl": 0.0,
            "win_rate": 0.0,
            "total_pnl": 0.0,
            "best_day": 0.0,
            "worst_day": 0.0,
            "trend": "neutral",
        }
    wins = sum(1 for p in pnls if p > 0)
    avg = sum(pnls) / len(pnls)
    var = sum((p - avg) ** 2 for p in pnls) / max(len(pnls), 1)
    std = math.sqrt(var)
    recent = pnls[-5:] if len(pnls) >= 5 else pnls
    recent_avg = sum(recent) / len(recent)
    trend = "bullish" if recent_avg > avg * 1.05 else "bearish" if recent_avg < avg * 0.95 else "neutral"
    return {
        "days": len(pnls),
        "avg_daily_pnl": round(avg, 2),
        "std_daily_pnl": round(std, 2),
        "win_rate": round(wins / len(pnls) * 100, 1),
        "total_pnl": round(sum(pnls), 2),
        "best_day": round(max(pnls), 2),
        "worst_day": round(min(pnls), 2),
        "trend": trend,
    }


def call_openai(payload: dict, stats: dict) -> dict:
    api_key = str(payload.get("openai_api_key") or "").strip()
    model = str(payload.get("model") or "gpt-4.1-mini").strip()
    login = str(payload.get("mt5_login") or "-")
    symbol = str(payload.get("symbol") or "XAUUSD")
    equity = float(payload.get("current_equity") or 0)

    if not api_key:
        return {
            "summary_th": f"ยังไม่ได้ตั้งค่า OpenAI API Key — ใช้การคาดการณ์จากสถิติย้อนหลังของ Login {login}",
            "outlook": stats.get("trend") or "neutral",
            "confidence": 45,
            "market_view_th": "วิเคราะห์จากค่าเฉลี่ยกำไร/ขาดทุนรายวันเท่านั้น",
            "risks": ["ข้อมูล AI ไม่ครบ — ควรตั้งค่า OPENAI_API_KEY บนเซิร์ฟเวอร์"],
            "recommendations": ["ติดตามผลจริงในปฏิทินและปรับ Lot ตามความเสี่ยง"],
            "disclaimer": "เป็นการคาดการณ์เชิงสถิติ ไม่ใช่คำแนะนำการลงทุน",
        }

    prompt = f"""คุณเป็นนักวิเคราะห์ตลาดทอง (XAUUSD) สำหรับบัญชี MT5
Login: {login}
Symbol: {symbol}
Equity ปัจจุบัน: {equity}
สถิติย้อนหลัง (เฉพาะวันจันทร์–ศุกร์):
- จำนวนวัน: {stats.get('days')}
- กำไร/ขาดทุนเฉลี่ยต่อวัน: {stats.get('avg_daily_pnl')}
- Win rate: {stats.get('win_rate')}%
- รวม PnL: {stats.get('total_pnl')}
- แนวโน้ม: {stats.get('trend')}

ตอบ JSON เท่านั้น (ภาษาไทยใน summary/market_view/risks/recommendations):
{{
  "summary_th": "สรุปภาพรวม 2-3 ประโยค",
  "outlook": "bullish|bearish|neutral",
  "confidence": 0-100,
  "market_view_th": "มุมมองตลาดทอง 30 วันข้างหน้า",
  "risks": ["..."],
  "recommendations": ["..."],
  "disclaimer": "คำเตือนความเสี่ยง"
}}"""

    body = json.dumps(
        {
            "model": model,
            "messages": [
                {"role": "system", "content": "ตอบ JSON เท่านั้น ไม่มี markdown"},
                {"role": "user", "content": prompt},
            ],
            "temperature": 0.35,
        }
    ).encode("utf-8")

    req = urllib.request.Request(
        "https://api.openai.com/v1/chat/completions",
        data=body,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=55) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        text = (
            data.get("choices", [{}])[0]
            .get("message", {})
            .get("content", "")
            .strip()
        )
        if text.startswith("```"):
            text = text.split("\n", 1)[-1]
            if text.endswith("```"):
                text = text[:-3]
        parsed = json.loads(text)
        parsed["confidence"] = max(0, min(100, int(parsed.get("confidence") or 50)))
        outlook = str(parsed.get("outlook") or "neutral").lower()
        if outlook not in ("bullish", "bearish", "neutral"):
            outlook = "neutral"
        parsed["outlook"] = outlook
        return parsed
    except (urllib.error.URLError, json.JSONDecodeError, KeyError, ValueError) as err:
        return {
            "summary_th": f"AI ไม่พร้อม ({err}) — ใช้สถิติย้อนหลังแทน",
            "outlook": stats.get("trend") or "neutral",
            "confidence": 40,
            "market_view_th": "ไม่สามารถเรียก OpenAI ได้",
            "risks": ["ตรวจสอบ OPENAI_API_KEY และการเชื่อมต่อ"],
            "recommendations": ["ลองกดวิเคราะห์ใหม่ภายหลัง"],
            "disclaimer": "เป็นการคาดการณ์ ไม่ใช่คำแนะนำการลงทุน",
        }


def outlook_factor(outlook: str) -> float:
    if outlook == "bullish":
        return 1.12
    if outlook == "bearish":
        return 0.88
    return 1.0


def project_days(stats: dict, ai: dict, horizon: int, start: datetime) -> list:
    avg = float(stats.get("avg_daily_pnl") or 0)
    std = float(stats.get("std_daily_pnl") or abs(avg) * 0.35 or 1.0)
    factor = outlook_factor(str(ai.get("outlook") or "neutral"))
    rows = []
    cursor = start
    offset = 0
    cumulative = 0.0
    while len(rows) < horizon:
        cursor += timedelta(days=1)
        if is_weekend(cursor):
            continue
        offset += 1
        decay = 0.985 ** (offset - 1)
        expected = round(avg * factor * decay, 2)
        optimistic = round(expected + std, 2)
        pessimistic = round(expected - std, 2)
        cumulative = round(cumulative + expected, 2)
        rows.append(
            {
                "day_offset": offset,
                "day_key": cursor.strftime("%Y-%m-%d"),
                "weekday": cursor.strftime("%a"),
                "market_open": True,
                "expected_pnl": expected,
                "optimistic_pnl": optimistic,
                "pessimistic_pnl": pessimistic,
                "cumulative_pnl": cumulative,
            }
        )
    return rows


def main() -> int:
    try:
        payload = read_input()
        horizon = int(payload.get("horizon_days") or 30)
        history = trading_day_keys(payload.get("daily_history") or [])
        stats = compute_stats(history)
        ai = call_openai(payload, stats)
        start = datetime.now(BANGKOK).replace(hour=0, minute=0, second=0, microsecond=0)
        daily = project_days(stats, ai, horizon, start)
        base_total = daily[-1]["cumulative_pnl"] if daily else 0.0
        std_total = float(stats.get("std_daily_pnl") or 0) * math.sqrt(max(len(daily), 1))

        result = {
            "ok": True,
            "mt5_login": payload.get("mt5_login"),
            "horizon_days": horizon,
            "generated_at": datetime.now(BANGKOK).isoformat(),
            "stats": stats,
            "analysis": ai,
            "projected_pnl_30d": {
                "optimistic": round(base_total + std_total, 2),
                "base": round(base_total, 2),
                "pessimistic": round(base_total - std_total, 2),
            },
            "daily_forecast": daily,
        }
        sys.stdout.write(json.dumps(result, ensure_ascii=False))
        return 0
    except Exception as err:
        sys.stdout.write(json.dumps({"ok": False, "message": str(err)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
